// 恢復與配置持久化模擬驗證（v1.1 A4/C2/C3）：paused/interrupted 恢復 + 拒絕路徑 + settings 持久化
// 用法：node scripts/resume-sim.mjs
// 與 loop-sim.mjs 同款樁技術：虛擬時鐘假 timer + 樁 agents/subagents/sessionQuery + 樁 settings
// （register→scope.get/update/dispose），並適配 t1 的 ctx.inject(['settings'], fn) 響應式註冊。
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
let failures = 0
const check = (name, cond, extra = '') => {
	console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  【${extra}】` : ''}`)
	if (!cond) failures++
}

// ── 虛擬時鐘 + 假 timer ──
const CLOCK = { now: 1_000_000 }
Date.now = () => CLOCK.now
function makeClock() {
	let seq = 0
	const timers = new Map()
	const api = {
		timeout(cb, ms) {
			const id = ++seq
			timers.set(id, { cb, at: CLOCK.now + Number(ms || 0), recurring: false })
			return () => timers.delete(id)
		},
		interval(cb, ms) {
			const id = ++seq
			const period = Math.max(1, Number(ms || 1))
			timers.set(id, { cb, at: CLOCK.now + period, ms: period, recurring: true })
			return () => timers.delete(id)
		},
	}
	function advance(ms) {
		const target = CLOCK.now + ms
		let guard = 0
		for (;;) {
			if (++guard > 200_000) throw new Error('advance: 死循環')
			let dueId = null, dueAt = Infinity
			for (const [id, t] of timers) if (t.at <= target && t.at < dueAt) { dueAt = t.at; dueId = id }
			if (dueId === null) break
			const t = timers.get(dueId)
			CLOCK.now = Math.max(CLOCK.now, t.at)
			if (t.recurring) t.at += t.ms
			else timers.delete(dueId)
			t.cb()
		}
		CLOCK.now = target
	}
	return { api, advance }
}
async function tick(n = 200) {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

// ── host 源剝離與實例化（SMZ 換成樁對象——讓 bundle 模式 settings 註冊路徑可達）──
const hostSrc = readFileSync(path.join(root, 'lib/index.js'), 'utf8')
const stripRe = /^import \w+ from '@deepseek-ai\/schemastery'$/m
if (!stripRe.test(hostSrc)) { console.error('✗ host 源不符合預期 import 形狀'); process.exit(1) }
const STUB_SMZ = 'const __mk = () => { const s = {}; s.default = () => s; return s }; const SMZ = { object: () => __mk(), array: () => __mk(), string: () => __mk(), natural: () => __mk(), any: () => __mk() }'
const stripped = hostSrc.replace(stripRe, STUB_SMZ)
let hostSeq = 0
async function freshHost() {
	const p = path.join(os.tmpdir(), `dsh-ar-resume-host-${hostSeq}-${Date.now.toString(36)}-${++hostSeq}.mjs`)
	writeFileSync(p, stripped)
	return import(pathToFileURL(p).href)
}

// ── 樁 HTTP req/res ──
let CUR_TOKEN = '' // R2：makeScenario 引導後填充；fakeReq 一律攜帶
function fakeReq(method, url, body) {
	const listeners = {}
	const req = {
		method, url,
		headers: { host: '127.0.0.1:3080', 'x-review-token': CUR_TOKEN }, // F3+R2：模擬真實客戶端
		socket: { remoteAddress: '127.0.0.1' }, // R2：回環
		on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return req },
		destroy() {},
	}
	if (body !== undefined) {
		const raw = JSON.stringify(body)
		queueMicrotask(() => { for (const f of listeners.data ?? []) f(raw); for (const f of listeners.end ?? []) f() })
	}
	return req
}
function fakeRes() {
	const out = { code: 0, body: '' }
	return {
		writeHead(code) { out.code = code },
		end(chunk) { out.body += chunk ?? '' },
		_json() { try { return JSON.parse(out.body) } catch { return null } },
		out,
	}
}

/**
 * 場景環境。seedStorage：預置 settings 存儲（模擬重啟前持久化的中斷快照/配置）。
 * withSettings=false 時不提供 settings 服務（純內存配置路徑）。
 */
async function makeScenario(name, { seedStorage = {}, withSettings = true } = {}) {
	CLOCK.now = 1_000_000
	const clock = makeClock()
	const host = await freshHost()

	const agents = new Map()
	const followups = []
	function addAgent(id) {
		agents.set(id, { id, status: 'idle', followup(msg) { followups.push(msg) } })
		return agents.get(id)
	}
	const script = []
	const spawns = []
	const subagents = {
		list: () => ['spawn'],
		start: async (_p, opts) => {
			spawns.push(opts.label)
			const structured = script.shift()
			if (structured === undefined) throw new Error(`場景 ${name}: 腳本隊列耗盡`)
			return { result: Promise.resolve({ stopReason: 'completed', structured }), dispose: async () => {} }
		},
	}
	const sessionQuery = {
		listSessions: async () => [...agents.keys()].map((id) => ({ header: { id, cwd: `/proj/${name}/${id}` } })),
	}

	// 樁 settings 服務：register → scope{get,update,dispose}；update 為合併補丁；全程記錄
	const settingsCalls = { register: [], updates: [], disposed: 0 }
	const storage = { ...seedStorage }
	const settingsSvc = {
		register(ns, schema, opts) {
			settingsCalls.register.push({ ns, opts })
			return {
				get: () => ({ ...storage }),
				update: async (patch) => {
					settingsCalls.updates.push(patch)
					Object.assign(storage, patch)
				},
				dispose: () => { settingsCalls.disposed++ },
			}
		},
	}

	let routeHandler = null
	const registrations = []
	const effects = []
	const stubCtx = {
		get: (n) => ({
			commands: { register: (def) => { registrations.push('cmd:' + def.name); return () => {} } },
			agents: {
				get: (id) => agents.get(id),
				currentInitiator: () => [...agents.values()][0],
				roots: () => [...agents.values()],
			},
			subagents,
			sessionQuery,
			settings: withSettings ? settingsSvc : undefined,
		})[n],
		timer: clock.api,
		effect: (fn) => { const d = fn(); effects.push(d); return () => { for (const d of effects) { try { d() } catch {} } } },
		webServer: { register: (route) => { registrations.push('route:' + route.path); routeHandler = route.handler; return () => {} } },
	}
	// 適配 t1 響應式註冊：ctx.inject(names, fn) 立即以 service-context 回調
	stubCtx.inject = (names, fn) => {
		registrations.push('inject:' + names.join(','))
		fn({ get: stubCtx.get, effect: stubCtx.effect })
		return () => {}
	}
	host.apply(stubCtx)
	// R2：引導 per-install token（bootstrap 端點）→ 後續請求攜帶
	{
		const res = fakeRes()
		routeHandler(fakeReq('GET', '/__review/api/token'), res)
		CUR_TOKEN = (res._json() || {}).token ?? ''
		if (CUR_TOKEN === '') throw new Error(`場景 ${name}: token 引導失敗`)
	}
	const http = async (method, url, body) => {
		const res = fakeRes()
		routeHandler(fakeReq(method, url, body), res)
		await tick(30)
		return res._json()
	}
	return {
		host, clock, agents, followups, spawns, script, addAgent, http, registrations,
		settingsCalls, storage,
		state: (sid) => http('GET', `/__review/api/state?session=${sid}`),
		start: (sid, extra = {}) => http('POST', '/__review/api/start', { session: sid, ...extra }),
		stop: (sid) => http('POST', '/__review/api/stop', { session: sid }),
		resume: (sid) => http('POST', '/__review/api/resume', { session: sid }),
		teardown: () => { for (const d of effects) { try { d() } catch {} } },
	}
}

const finding = (over = {}) => ({
	severity: 'high', file: 'src/app.js', line: 12,
	title: '未處理的空值引用導致崩潰', detail: 'd', suggestion: 's', ...over,
})
const roundResult = (findings) => ({
	dimension: 'code', pass: findings.length === 0, summary: 's', reviewedFiles: ['src/app.js'], findings,
})

// ════════════════════════════════════════════════════════
console.log('── 場景① paused 恢復：awaiting-fix → 代理離線暫停 → resume → round+1 續審 ──')
{
	const sc = await makeScenario('paused')
	sc.addAgent('s1')
	sc.script.push(roundResult([finding()])) // R1 blocking → 注入
	sc.script.push(roundResult([finding({ line: 99 })])) // 恢復後 R2 消費用
	await sc.start('s1', { dims: ['code'] })
	await tick()
	check('① R1 注入後 awaiting-fix', (await sc.state('s1'))?.run?.status === 'awaiting-fix')
	// 觸發 watchFix 暫停路徑：目標代理離線
	sc.agents.delete('s1')
	sc.clock.advance(3_000)
	await tick()
	let st = await sc.state('s1')
	check('① 代理離線 → paused 終態', st?.running === false && st?.lastStatus === 'paused', st?.lastStatus)
	// 恢復：代理重新在線 → resume
	sc.addAgent('s1')
	const r = await sc.resume('s1')
	check('① resume 返回 ok + runId', r?.ok === true && typeof r.runId === 'string', JSON.stringify(r))
	await tick()
	st = await sc.state('s1')
	check('① 恢復後 run 回到活躍表（running: true）', st?.running === true, JSON.stringify(st?.running))
	check('① round+1（1→2）續審', st?.run?.round === 2, String(st?.run?.round))
	check('① launchRound 觸發（R2 審查者派生）', sc.spawns.length === 2 && sc.spawns[1].includes('R2'), sc.spawns.join())
	check('① R2 聚合後回到 awaiting-fix（再次注入）', st?.run?.status === 'awaiting-fix' && sc.followups.length === 2, `${st?.run?.status}/${sc.followups.length}`)
	await sc.stop('s1')
	sc.teardown()
}

console.log('\n── 場景② interrupted 恢復：存儲中斷快照 → 啟動 hydrate → 面板可見 → resume 生效；無效快照跳過 ──')
{
	const snap = (over = {}) => ({
		at: 123, sessionId: 'sx', runId: 'old-run', projectPath: '/proj/x', mode: 'loop',
		injectMode: 'auto', gate: 'standard', scope: 'smart',
		modelKeys: ['glm-5.3'], dims: ['code'], round: 2, maxRounds: 5,
		blocking: 1, injectCount: 1, startedAt: 456, ...over,
	})
	// 有效快照 + 兩條無效快照（模型鍵全失效 / 維度空）一起預置
	const sc = await makeScenario('interrupted', {
		seedStorage: {
			interrupted: [
				snap({ sessionId: 'bad-model', modelKeys: ['ghost-model'] }),
				snap({ sessionId: 'bad-dims', dims: [] }),
				snap(), // 有效：sx
			],
		},
	})
	check('② 啟動時 settings 註冊被調用（dsh-auto-review 命名空間）', sc.settingsCalls.register.length === 1 && sc.settingsCalls.register[0].ns === 'dsh-auto-review')
	let st = await sc.state('sx')
	check('② 有效快照 hydrate 到 lastFinished（面板顯示 interrupted）', st?.running === false && st?.lastStatus === 'interrupted', st?.lastStatus)
	check('② hydrate 保留 round/maxRounds（2/5）', st?.last?.round === 2 && st?.last?.maxRounds === 5, `${st?.last?.round}/${st?.last?.maxRounds}`)
	for (const bad of ['bad-model', 'bad-dims']) {
		const s = await sc.state(bad)
		check(`② 無效快照（${bad}）被安全跳過（無 last）`, s?.running === false && s?.last === null, JSON.stringify(s?.lastStatus))
	}
	sc.addAgent('sx')
	sc.script.push(roundResult([finding()])) // 恢復後 R3 消費用
	const r = await sc.resume('sx')
	check('② interrupted resume ok', r?.ok === true, JSON.stringify(r))
	await tick()
	st = await sc.state('sx')
	check('② 恢復後 round+1（2→3）且 R3 派生', st?.run?.round === 3 && sc.spawns.length === 1 && sc.spawns[0].includes('R3'), `${st?.run?.round}/${sc.spawns.join()}`)
	await sc.stop('sx')
	sc.teardown()
}

console.log('\n── 場景③ 恢復拒絕路徑：無可恢復 / 輪數上限 / loop 代理不在線 ──')
{
	// 3a. 無可恢復閉環（從未有 run）
	{
		const sc = await makeScenario('rej-none')
		sc.addAgent('n1')
		const r = await sc.resume('n1')
		check('③a 無任何 run → 明確拒絕', r?.ok === false && /可恢復/.test(r?.error ?? ''), JSON.stringify(r))
		sc.teardown()
	}
	// 3b. 終態不可恢復（passed）
	{
		const sc = await makeScenario('rej-passed')
		sc.addAgent('n2')
		sc.script.push(roundResult([])) // R1 直接全綠 → passed
		await sc.start('n2', { dims: ['code'] })
		await tick()
		check('③b 前置：R1 全綠 → passed', (await sc.state('n2'))?.lastStatus === 'passed')
		const r = await sc.resume('n2')
		check('③b passed 終態 → 拒絕恢復', r?.ok === false && /可恢復/.test(r?.error ?? ''), JSON.stringify(r))
		sc.teardown()
	}
	// 3c. 已達輪數上限（快照 round=maxRounds）
	{
		const sc = await makeScenario('rej-max', {
			seedStorage: { interrupted: [{
				at: 1, sessionId: 'n3', runId: 'r', projectPath: '/p', mode: 'loop', injectMode: 'auto',
				gate: 'standard', scope: 'smart', modelKeys: ['glm-5.3'], dims: ['code'],
				round: 5, maxRounds: 5, blocking: 2, injectCount: 4, startedAt: 2,
			}] },
		})
		sc.addAgent('n3')
		check('③c 前置：快照 hydrate 為 interrupted（5/5）', (await sc.state('n3'))?.lastStatus === 'interrupted')
		const r = await sc.resume('n3')
		check('③c 已達輪數上限 → 拒絕並提示重新發起', r?.ok === false && /上限/.test(r?.error ?? ''), JSON.stringify(r))
		sc.teardown()
	}
	// 3d. loop 模式代理不在線（離線暫停後不重新上線）
	{
		const sc = await makeScenario('rej-offline')
		sc.addAgent('n4')
		sc.script.push(roundResult([finding()]))
		await sc.start('n4', { dims: ['code'] })
		await tick()
		sc.agents.delete('n4')
		sc.clock.advance(3_000)
		await tick()
		check('③d 前置：離線 → paused', (await sc.state('n4'))?.lastStatus === 'paused')
		const r = await sc.resume('n4') // 代理仍不在線
		check('③d loop 代理不在線 → 拒絕恢復', r?.ok === false && /不在線/.test(r?.error ?? ''), JSON.stringify(r))
		sc.teardown()
	}
}

console.log('\n── 場景④ 配置持久化：註冊 / 注入邊界落快照 / 終態清快照 / 配置寫入 ──')
{
	const sc = await makeScenario('persist')
	sc.addAgent('s9')
	sc.script.push(roundResult([finding()])) // R1 blocking
	sc.script.push(roundResult([])) // R2 全綠
	check('④ ctx.inject 響應式掛接被調用（settings）', sc.registrations.includes('inject:settings'), sc.registrations.join())
	check('④ settings 註冊 1 次（命名空間 dsh-auto-review, live）', sc.settingsCalls.register.length === 1 && sc.settingsCalls.register[0]?.opts?.applies === 'live')
	let cfg = await sc.http('GET', '/__review/api/config')
	check('④ config GET：persisted=true（settings 掛接成功）', cfg?.persisted === true)
	// 配置寫入持久化
	const setRes = await sc.http('POST', '/__review/api/config', { config: { defaultGate: 'strict', defaultMaxRounds: 6 } })
	check('④ config POST：persisted=true', setRes?.ok === true && setRes?.persisted === true, JSON.stringify(setRes))
	cfg = await sc.http('GET', '/__review/api/config')
	check('④ 配置寫入經 scope.update 持久化（strict/6 讀回）', cfg?.config?.defaultGate === 'strict' && cfg?.config?.defaultMaxRounds === 6)
	check('④ scope.update 收到配置補丁', sc.settingsCalls.updates.some((u) => u.defaultGate === 'strict'))
	// 注入邊界落快照
	await sc.start('s9', { dims: ['code'] })
	await tick()
	check('④ 注入邊界 → interrupted 快照持久化', (sc.storage.interrupted ?? []).length === 1 && sc.storage.interrupted[0].sessionId === 's9', JSON.stringify(sc.storage.interrupted?.length))
	check('④ 快照含 round=1 與 runId', sc.storage.interrupted[0].round === 1 && typeof sc.storage.interrupted[0].runId === 'string')
	// 修復 → R2 全綠 → passed → 快照清除
	sc.agents.get('s9').status = 'running'
	sc.clock.advance(3_000)
	sc.agents.get('s9').status = 'idle'
	sc.clock.advance(3_000)
	sc.clock.advance(5_000)
	await tick()
	await tick()
	const st = await sc.state('s9')
	check('④ R2 全綠 → passed 終態', st?.running === false && st?.lastStatus === 'passed', st?.lastStatus)
	check('④ 終態後 interrupted 快照被清除', (sc.storage.interrupted ?? []).length === 0, JSON.stringify(sc.storage.interrupted))
	sc.teardown()
}

console.log('\n── 場景⑤ R3 manual 恢復：快照含 pendingInject → hydrate 還原 awaiting-confirm → 確認注入可達 ──')
{
	const snapWithPending = {
		at: 1, runId: 'r10', projectPath: '/p', mode: 'loop', injectMode: 'manual',
		gate: 'standard', scope: 'smart', modelKeys: ['glm-5.3'], dims: ['code'],
		blocking: 1, injectCount: 0, startedAt: 2,
		pendingInject: { round: 1, count: 1, blockingByDim: { code: [finding({ suggestion: '使用 await 修復返回值' })] } },
	}
	// 5a. 直接確認注入（R3：注入端點提升 lastFinished → runs）
	{
		const sc = await makeScenario('manual-inject', {
			seedStorage: { interrupted: [{ ...snapWithPending, sessionId: 's10', round: 1, maxRounds: 5 }] },
		})
		sc.addAgent('s10')
		const st = await sc.state('s10')
		check('⑤a 快照含 pendingInject → hydrate 為 awaiting-confirm', st?.lastStatus === 'awaiting-confirm', st?.lastStatus)
		check('⑤a pendingInject 對面板可見（count=1）', st?.last?.pendingInject?.count === 1, JSON.stringify(st?.last?.pendingInject))
		const inj = await sc.http('POST', '/__review/api/inject', { session: 's10' })
		check('⑤a 注入端點可達（lastFinished 提升後注入）', inj?.ok === true, JSON.stringify(inj))
		await tick()
		check('⑤a followup 被調用（確認注入成功，不再靜默丟棄）', sc.followups.length === 1, String(sc.followups.length))
		check('⑤a 注入消息含 <review-data> 數據塊與安全聲明', (sc.followups[0]?.content?.[0]?.text ?? '').includes('<review-data>'))
		await sc.stop('s10')
		sc.teardown()
	}
	// 5b. resume 還原確認環節（pendingConfirm 語義，round 不推進）
	{
		const sc = await makeScenario('manual-resume', {
			seedStorage: { interrupted: [{ ...snapWithPending, sessionId: 's11', round: 1, maxRounds: 5 }] },
		})
		sc.addAgent('s11')
		check('⑤b 前置：hydrate 為 awaiting-confirm', (await sc.state('s11'))?.lastStatus === 'awaiting-confirm')
		const r = await sc.resume('s11')
		check('⑤b resume 返回 pendingConfirm 語義（不推進 round）', r?.ok === true && r?.pendingConfirm === 1, JSON.stringify(r))
		const st = await sc.state('s11')
		check('⑤b 恢復後為活動 awaiting-confirm（round 仍 1）', st?.running === true && st?.run?.status === 'awaiting-confirm' && st?.run?.round === 1, JSON.stringify(st?.running) + '/' + st?.run?.status)
		const inj = await sc.http('POST', '/__review/api/inject', { session: 's11' })
		check('⑤b resume 後確認注入 ok', inj?.ok === true, JSON.stringify(inj))
		await tick()
		// R9（F-7）：resume 恢復會補發「等確認」通知——followups = 通知 1 + 注入 1
		check('⑤b followup = 等確認通知 + 確認注入（共 2 條）', sc.followups.length === 2 && (sc.followups[1]?.content?.[0]?.text ?? '').includes('<review-data>'), String(sc.followups.length))
		await sc.stop('s11')
		sc.teardown()
	}
	// 5c. 重啟恢復的待確認閉環可「放棄」（stop 走 lastFinished 路徑——快照提示「/review stop 放棄」可兌現）
	{
		const sc = await makeScenario('manual-stop', {
			seedStorage: { interrupted: [{ ...snapWithPending, sessionId: 's12', round: 1, maxRounds: 5 }] },
		})
		sc.addAgent('s12')
		check('⑤c 前置：hydrate 為 awaiting-confirm', (await sc.state('s12'))?.lastStatus === 'awaiting-confirm')
		const r = await sc.stop('s12')
		check('⑤c 放棄（stop）對恢復快照生效', r?.ok === true, JSON.stringify(r))
		await tick()
		const st = await sc.state('s12')
		check('⑤c 放棄後面板回到空閒（無 last、無 running）', st?.running === false && st?.last === null, JSON.stringify(st?.lastStatus))
		check('⑤c 中斷快照被清除（不可再恢復）', (sc.storage.interrupted ?? []).length === 0, JSON.stringify(sc.storage.interrupted))
		sc.teardown()
	}
	// 5d. R9：恢復路徑重新武裝確認超時 + 等確認通知（resume 後推進 fixWaitMs → 超時轉 paused）
	{
		const sc = await makeScenario('manual-confirm-timeout', {
			seedStorage: { interrupted: [{ ...snapWithPending, sessionId: 's13', round: 1, maxRounds: 5 }] },
		})
		sc.addAgent('s13')
		const r = await sc.resume('s13')
		check('⑤d resume ok（pendingConfirm 語義）', r?.ok === true && r?.pendingConfirm === 1, JSON.stringify(r))
		await tick()
		check('⑤d resume 後補發「等確認」通知', sc.followups.length === 1 && /等待人工確認/.test(sc.followups[0]?.content?.[0]?.text ?? ''), String(sc.followups.length) + '/' + (sc.followups[0]?.content?.[0]?.text ?? '').slice(0, 40))
		// 推進虛擬時鐘越過 fixWaitMs（默認 30min）→ 確認超時轉 paused
		sc.clock.advance(32 * 60_000)
		await tick()
		const st = await sc.state('s13')
		check('⑤d 未確認 → 超時轉 paused（可 /review resume 兜底）', st?.running === false && st?.lastStatus === 'paused', st?.lastStatus)
		check('⑤d paused 附帶待確認超時說明', /待確認注入超時/.test(st?.last?.error ?? ''), st?.last?.error)
		check('⑤d 超時也發終態通告（followups = 通知 1 + 通告 1）', sc.followups.length === 2 && /審查閉環/.test(sc.followups[1]?.content?.[0]?.text ?? ''), String(sc.followups.length))
		sc.teardown()
	}
}

console.log(failures === 0 ? '\n恢復與持久化全部場景通過 ✅' : `\n${failures} 項失敗 ❌`)
process.exit(failures === 0 ? 0 : 1)
