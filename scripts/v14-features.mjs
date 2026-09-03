// v1.4 六項新能力測試（P1-7/8/9/10/11/12）—— node scripts/v14-features.mjs
// 樁技術沿用 smoke/loop-sim/resume-sim：虛擬時鐘假 timer + 樁 agents/subagents/sessionQuery
// + 樁 shell（.reviewignore 讀取路徑）驅動 lib/index.js apply()；client 半以源碼注入
// __test 導出後以樁 react 渲染斷言。純進程內，不依賴外部服務、不真實等待、不重啟 DSH。
//
// 場景總覽（對應 ROADMAP P1-7~P1-12）：
//   ① P1-8  跨維度去重：同 file+title 兩維各報一條 → 合併一條 + coDims「共同指出」+ 計數不虛增；
//           相似但不同 title（同行不同問題）不誤合併
//   ② P1-9  .reviewignore：glob/指紋規則 + 理由 → 命中項不進注入清單、單獨分組（注入/報告/提示詞）、
//           不阻擋驗收；無文件優雅跳過
//   ③ P1-11 fixScope 三檔：plus-medium/all 順帶修復分組、blocking-only 維持現行為、
//           非法回落、配置繼承、gate 全綠判定不受影響（含 strict 反向對照）
//   ④ P1-10 模型次序：提交 models=[B,A] → R1 用 B、R2 用 A（樁記錄 spawn 調用序）
//   ⑤ P1-12 輪次數據：兩輪樁閉環 → publicRun.roundLog 完整（9 欄位、resolved 差值）、
//           injectLog items 快照含 coDims / extras 分組
//   ⑥ P1-7/10/12 client：截斷組件、次序 ↑↓、時間線卡、596 文案已改、MdRender 粗體/表格輸出
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// P1-13：終態歸檔寫 $DSH_HOME/review-history——測試一律重定向到臨時目錄，絕不寫真實 ~/.dsh
const HIST_HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-v14-home-'))
process.env.DSH_HOME = HIST_HOME

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
let failures = 0
let passes = 0
const check = (name, cond, extra = '') => {
	console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  【${extra}】` : ''}`)
	if (cond) passes++
	else failures++
}

// ── 虛擬時鐘（Date.now 全局接管）+ 假 timer（記錄回調、手動推進）──
const CLOCK = { now: 1_000_000 }
Date.now = () => CLOCK.now
function makeClock() {
	let seq = 0
	const timers = new Map()
	const api = {
		timeout(cb, ms) {
			const id = ++seq
			timers.set(id, { cb, at: CLOCK.now + Number(ms || 0), ms: Number(ms || 0), recurring: false })
			return () => timers.delete(id)
		},
		interval(cb, ms) {
			const id = ++seq
			timers.set(id, { cb, at: CLOCK.now + Math.max(1, Number(ms || 1)), ms: Math.max(1, Number(ms || 1)), recurring: true })
			return () => timers.delete(id)
		},
	}
	function advance(ms) {
		const target = CLOCK.now + ms
		let guard = 0
		while (CLOCK.now < target || timersDue(target)) {
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
	function timersDue(target) {
		for (const t of timers.values()) if (t.at <= target) return true
		return false
	}
	return { api, advance }
}
async function tick(n = 200) {
	for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

// ── host 源剝離 schemastery import 後每場景全新實例（獨立 runs 閉包）──
const hostSrc = readFileSync(path.join(root, 'lib/index.js'), 'utf8')
const stripRe = /^import \w+ from '@deepseek-ai\/schemastery'$/m
if (!stripRe.test(hostSrc)) { console.error('✗ host 源不符合預期 import 形狀'); process.exit(1) }
const stripped = hostSrc.replace(stripRe, 'const SMZ = null')
let hostSeq = 0
async function freshHost() {
	const p = path.join(os.tmpdir(), `dsh-ar-v14-host-${Date.now.toString(36)}-${++hostSeq}.mjs`)
	writeFileSync(p, stripped)
	return import(pathToFileURL(p).href)
}

// ── 樁 HTTP req/res（token 引導後一律攜帶）──
let CUR_TOKEN = ''
function fakeReq(method, url, body) {
	const listeners = {}
	const req = {
		method, url,
		headers: { host: '127.0.0.1:3080', 'x-review-token': CUR_TOKEN },
		socket: { remoteAddress: '127.0.0.1' },
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

/** 樁 shell：真實讀取 repoDir/.reviewignore（loadReviewIgnores 的 cat 命令），
 *  其餘命令（如 collectChangedFiles 的 git/find）回空成功 → 變更集為空、smart 聚焦 0 檔。 */
function makeShellStub(repoDir) {
	const ok = (text) => ({ exitCode: 0, timedOut: false, aborted: false, stdout: { text } })
	return {
		resolve: (spec) => spec,
		run: async (spec) => {
			if (String(spec.command ?? '').includes('cat "$root/.reviewignore"')) {
				try { return ok(readFileSync(path.join(repoDir, '.reviewignore'), 'utf8')) } catch { return ok('') }
			}
			return ok('')
		},
	}
}

/** 場景環境：全新 host + 樁服務 + 可編排 subagents（記錄 spawn 的 label/model/provider/prompt）。 */
async function makeScenario(name, opts = {}) {
	CLOCK.now = 1_000_000
	const clock = makeClock()
	const host = await freshHost()
	const agents = new Map()
	const followups = []
	function addAgent(id) {
		agents.set(id, { id, status: 'idle', followup(msg) { followups.push(msg) } })
		return agents.get(id)
	}
	const script = [] // structured 結果隊列（按 spawn 消費順序 = dimList 序）
	const spawns = [] // {label, provider, model, prompt}
	const subagents = {
		list: () => ['spawn'],
		start: async (_p, o) => {
			spawns.push({ label: o.label, provider: o.agentOptions?.provider, model: o.agentOptions?.model, prompt: o.prompt })
			const structured = script.shift()
			if (structured === undefined) throw new Error(`場景 ${name}: 腳本隊列耗盡`)
			return { result: Promise.resolve({ stopReason: 'completed', structured }), dispose: async () => {} }
		},
	}
	const sessionQuery = {
		listSessions: async () => [...agents.keys()].map((id) => ({ header: { id, cwd: `/proj/${name}/${id}` } })),
	}
	let routeHandler = null
	const effects = []
	const stubCtx = {
		get: (n) => ({
			commands: { register: () => () => {} },
			agents: {
				get: (id) => agents.get(id),
				currentInitiator: () => [...agents.values()][0],
				roots: () => [...agents.values()],
			},
			subagents,
			sessionQuery,
			shell: opts.shellStub, // 缺席 → P1-9 停用、smart 變更集降級全量（與生產降級路徑一致）
		})[n],
		timer: clock.api,
		effect: (fn) => { const d = fn(); effects.push(d); return () => { for (const d of effects) { try { d() } catch {} } } },
		webServer: { register: (route) => { routeHandler = route.handler; return () => {} } },
	}
	host.apply(stubCtx)
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
	// P1-13：完全控制請求頭的原始 HTTP（鑑權/路徑參數校驗用）
	const rawHttp = async (method, url, headers, socket) => {
		const res = fakeRes()
		routeHandler({
			method, url,
			headers: headers ?? { host: '127.0.0.1:3080', 'x-review-token': CUR_TOKEN },
			socket: socket ?? { remoteAddress: '127.0.0.1' },
			on: () => {}, destroy() {},
		}, res)
		await tick(10)
		return res
	}
	return {
		clock, agents, followups, spawns, script, addAgent, http, rawHttp,
		state: (sid) => http('GET', `/__review/api/state?session=${sid}`),
		start: (sid, extra = {}) => http('POST', '/__review/api/start', { session: sid, ...extra }),
		stop: (sid) => http('POST', '/__review/api/stop', { session: sid }),
		report: (sid) => http('GET', `/__review/api/report?session=${sid}`),
		list: () => http('GET', '/__review/api/list'),
		teardown: () => { for (const d of effects) { try { d() } catch {} } },
	}
}

/** 驅動一次「代理修復」：running 一拍 → idle 一拍 → +5s 緩衝。 */
async function driveFix(sc, sid) {
	sc.agents.get(sid).status = 'running'
	sc.clock.advance(3_000)
	sc.agents.get(sid).status = 'idle'
	sc.clock.advance(3_000)
	sc.clock.advance(5_000)
	await tick()
}

const finding = (over = {}) => ({
	severity: 'high', file: 'src/app.js', line: 12,
	title: '未處理的空值引用導致崩潰', detail: 'd', suggestion: 's', ...over,
})
const roundResult = (dimension, findings) => ({
	dimension, pass: findings.length === 0, summary: 's', reviewedFiles: ['src/app.js'], findings,
})
/** 從注入消息提取 <review-data> JSON 塊。 */
const parseReviewData = (text) => {
	const m = String(text ?? '').match(/<review-data>\n([\s\S]*?)\n<\/review-data>/)
	if (m === null) return null
	try { return JSON.parse(m[1]) } catch { return null }
}
const injectTextOf = (sc, i = 0) => sc.followups[i]?.content?.[0]?.text ?? ''

// ══════════════════ ① P1-8 跨維度去重 ══════════════════
console.log('── ① P1-8 去重：code+flow 同 file+title → 合併一條 +「共同指出」+ 計數不虛增 ──')
{
	const sc = await makeScenario('dedup')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [finding()]))
	sc.script.push(roundResult('flow', [finding()])) // 同 file+title → 同指紋（不涉 security，避免人工確認路徑）
	const r = await sc.start('s1', { dims: ['code', 'flow'] })
	check('① start ok（code+flow 兩維）', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	check('① 聚合後 awaiting-fix（自動注入完成）', st?.run?.status === 'awaiting-fix', st?.run?.status)
	const text = injectTextOf(sc)
	check('① 注入計數按合併後口徑（發現 1 項，非 2）', text.includes('發現 1 項未通過驗收'), text.slice(0, 160))
	check('① 注入文案含「共同指出」標注（⚠ A+B）', /⚠ [^\n]+\+[^\n]+ 共同指出/.test(text), text.slice(200, 400))
	const data = parseReviewData(text)
	check('① review-data JSON 僅 1 條且攜帶 coDims=[code,flow]',
		data !== null && data.dims.length === 1 && data.dims[0].id === 'code'
		&& data.dims[0].findings.length === 1 && JSON.stringify(data.dims[0].findings[0].coDims) === JSON.stringify(['code', 'flow']),
		JSON.stringify(data?.dims))
	const list = await sc.list()
	check('① list 端點 blocking=1（合併口徑，不虛增）', list?.active?.[0]?.blocking === 1, JSON.stringify(list?.active?.[0]?.blocking))
	const rl = st?.run?.roundLog?.[0]
	check('① roundLog 保留 per-dim 原始（code:1/flow:1）且 merged=1/cross=1',
		rl?.blockingByDim?.code === 1 && rl?.blockingByDim?.flow === 1 && rl?.mergedCount === 1 && rl?.crossCount === 1,
		JSON.stringify(rl))
	const inj = st?.run?.injectLog?.[0]
	check('① injectLog items 快照：1 條、dim=code、coDims 完整',
		inj?.items?.length === 1 && inj.items[0].dim === 'code' && JSON.stringify(inj.items[0].coDims) === JSON.stringify(['code', 'flow']),
		JSON.stringify(inj?.items))
	await sc.stop('s1')
	sc.teardown()
}
console.log('\n── ① P1-8 去重（反向）：同行不同問題（title 不同）不誤合併 ──')
{
	const sc = await makeScenario('dedup2')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [finding()]))
	sc.script.push(roundResult('flow', [finding({ title: '空值引用可被惡意輸入放大為阻斷' })])) // 同檔同行、不同問題
	const r = await sc.start('s1', { dims: ['code', 'flow'] })
	check('①′ start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	const text = injectTextOf(sc)
	check('①′ 相似不同 title 不被誤合併（發現 2 項）', text.includes('發現 2 項未通過驗收'), text.slice(0, 160))
	check('①′ 無「共同指出」標注', !text.includes('共同指出'), text.slice(200, 400))
	const data = parseReviewData(text)
	check('①′ JSON 兩維各自 1 條（未跨維丟失）',
		data !== null && data.dims.length === 2 && data.dims.every((d) => d.findings.length === 1), JSON.stringify(data?.dims?.map((d) => d.id)))
	const list = await sc.list()
	check('①′ list blocking=2 / roundLog merged=2 / cross=0',
		list?.active?.[0]?.blocking === 2 && st?.run?.roundLog?.[0]?.mergedCount === 2 && st?.run?.roundLog?.[0]?.crossCount === 0,
		`${list?.active?.[0]?.blocking}/${st?.run?.roundLog?.[0]?.mergedCount}/${st?.run?.roundLog?.[0]?.crossCount}`)
	sc.teardown()
}

// ══════════════════ ② P1-9 .reviewignore ══════════════════
console.log('\n── ② P1-9 ignore：glob+指紋規則+理由 → 剔除注入/單獨分組/提示詞已知段/不阻擋驗收 ──')
{
	const repo = mkdtempSync(path.join(os.tmpdir(), 'v14-repo-'))
	writeFileSync(path.join(repo, '.reviewignore'), [
		'# 項目級忽略清單（測試夾具）',
		'src/legacy/** # 歷史遺留模組，明確不修',
		'src/app.js|未處理的空值引用導致崩潰 # 已評估接受，風險可控',
		'',
	].join('\n'))
	const sc = await makeScenario('ignore', { shellStub: makeShellStub(repo) })
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [
		finding(), // 命中指紋規則（src/app.js|標題）
		finding({ file: 'src/legacy/old.js', line: 5, title: '歷史問題' }), // 命中 glob 規則
		finding({ file: 'src/other.js', line: 30, title: '另一個問題' }), // 不命中 → 注入
		finding({ line: 40, title: '全新問題' }), // 同檔案但標題不匹配指紋規則 → 不誤傷
	]))
	sc.script.push(roundResult('code', [
		finding({ file: 'src/other.js', line: 30, title: '另一個問題' }),
		finding({ line: 40, title: '全新問題' }),
	]))
	const r = await sc.start('s1', { dims: ['code'], maxRounds: 3 })
	check('② start ok（含 .reviewignore）', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	check('② 聚合後 awaiting-fix', st?.run?.status === 'awaiting-fix', st?.run?.status)
	const text = injectTextOf(sc)
	check('② 命中項不進注入清單（僅 2 項未命中；同檔異題不誤傷）', text.includes('發現 2 項未通過驗收'), text.slice(0, 160))
	const data = parseReviewData(text)
	const files = (data?.dims ?? []).flatMap((d) => d.findings.map((f) => f.file))
	check('② review-data 僅含未命中項（other.js + app.js 異題；無 legacy）',
		files.length === 2 && files.includes('src/other.js') && files.includes('src/app.js') && !files.includes('src/legacy/old.js'),
		JSON.stringify(files))
	check('② 注入含「已接受 · 明確不修」分組（2 項 + 理由）',
		text.includes('已接受 · 明確不修') && text.includes('以下 2 項') && text.includes('已評估接受，風險可控') && text.includes('歷史遺留模組，明確不修'),
		text.slice(300, 700))
	const prompt = JSON.stringify(sc.spawns[0]?.prompt ?? [])
	check('② 審查者提示詞含已知接受段（規則 + 理由）',
		prompt.includes('已知且已接受的風險') && prompt.includes('src/legacy/**') && prompt.includes('風險可控'), prompt.slice(0, 80))
	const ig = st?.run?.ignoredByDecision?.code ?? []
	check('② publicRun.ignoredByDecision（2 項，含 ignorePattern/ignoreReason）',
		ig.length === 2 && ig.some((f) => f.ignorePattern.startsWith('src/app.js|') && f.ignoreReason === '已評估接受，風險可控')
		&& ig.some((f) => f.ignorePattern === 'src/legacy/**' && f.ignoreReason === '歷史遺留模組，明確不修'),
		JSON.stringify(ig.map((f) => f.ignorePattern)))
	check('② dimensions[].ignored 分組可見', st?.run?.dimensions?.[0]?.ignored?.length === 2, JSON.stringify(st?.run?.dimensions?.[0]?.ignored?.length))
	check('② roundLog.ignoredCount=2', st?.run?.roundLog?.[0]?.ignoredCount === 2, JSON.stringify(st?.run?.roundLog?.[0]?.ignoredCount))
	const rep = await sc.report('s1')
	check('② 報告含「已接受不修」表格（命中規則 + 理由）',
		(rep?.report ?? '').includes('已接受不修（命中 .reviewignore，2 項') && (rep?.report ?? '').includes('src/legacy/**') && (rep?.report ?? '').includes('歷史遺留模組，明確不修'),
		(rep?.report ?? '').slice(0, 120))
	// 未命中項照常複審（R2）
	await driveFix(sc, 's1')
	const st2 = await sc.state('s1')
	check('② 未命中項照常複審（R2 round=2，smart 輪 changedCount 快照）',
		st2?.run?.round === 2 && st2?.run?.roundLog?.[1]?.scope === 'smart' && st2?.run?.roundLog?.[1]?.changedCount === 0,
		`${st2?.run?.round}/${st2?.run?.roundLog?.[1]?.scope}/${st2?.run?.roundLog?.[1]?.changedCount}`)
	await sc.stop('s1')
	sc.teardown()
}
console.log('\n── ② P1-9（全命中 + 無文件）──')
{
	// 全部阻斷命中 ignore → 不阻擋驗收，直接全綠 passed
	const repoAll = mkdtempSync(path.join(os.tmpdir(), 'v14-repo-all-'))
	writeFileSync(path.join(repoAll, '.reviewignore'), 'src/**\n')
	{
		const sc = await makeScenario('ignore-all', { shellStub: makeShellStub(repoAll) })
		sc.addAgent('s1')
		sc.script.push(roundResult('code', [finding(), finding({ file: 'src/x.js', title: '第二個問題' })]))
		const r = await sc.start('s1', { dims: ['code'] })
		check('②′ 全命中場景 start ok', r?.ok === true, JSON.stringify(r))
		await tick()
		const st = await sc.state('s1')
		check('②′ 全部命中 → 全綠 passed（不注入，僅完成通告）',
			st?.running === false && st?.lastStatus === 'passed' && sc.followups.length === 1 && injectTextOf(sc).includes('全部通過'),
			`${st?.lastStatus}/${sc.followups.length}`)
		check('②′ 維度 pass 口徑排除已接受項（pass=true）', st?.last?.dimensions?.[0]?.pass === true, JSON.stringify(st?.last?.dimensions?.[0]?.pass))
		sc.teardown()
	}
	// 無 .reviewignore 文件 → 優雅跳過（提示詞無已知段、注入無已接受分組、閉環正常）
	{
		const repoEmpty = mkdtempSync(path.join(os.tmpdir(), 'v14-repo-empty-')) // 不寫 .reviewignore
		const sc = await makeScenario('ignore-none', { shellStub: makeShellStub(repoEmpty) })
		sc.addAgent('s2')
		sc.script.push(roundResult('code', [finding()]))
		const r = await sc.start('s2', { dims: ['code'] })
		check('②″ 無文件場景 start ok', r?.ok === true, JSON.stringify(r))
		await tick()
		const st = await sc.state('s2')
		const text = injectTextOf(sc)
		const prompt = JSON.stringify(sc.spawns[0]?.prompt ?? [])
		check('②″ 無 .reviewignore → 優雅跳過（提示詞無已知段、注入無分組、照常 awaiting-fix）',
			st?.run?.status === 'awaiting-fix' && !prompt.includes('已知且已接受的風險') && !text.includes('已接受 · 明確不修') && text.includes('發現 1 項未通過驗收'),
			`${st?.run?.status}/${text.slice(0, 60)}`)
		sc.teardown()
	}
}

// ══════════════════ ③ P1-11 fixScope ══════════════════
console.log('\n── ③ P1-11 fixScope：blocking-only 現行為 / plus-medium / all / 非法回落 / 配置繼承 ──')
{
	// 默認 blocking-only + 配置校驗
	const sc = await makeScenario('fs0')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [finding({ title: '阻斷項' }), finding({ severity: 'medium', title: '中等問題' })]))
	const cfg0 = await sc.http('GET', '/__review/api/config')
	check('③ 配置默認 defaultFixScope=blocking-only', cfg0?.config?.defaultFixScope === 'blocking-only', JSON.stringify(cfg0?.config?.defaultFixScope))
	const bad = await sc.http('POST', '/__review/api/config', { config: { defaultFixScope: 'everything' } })
	check('③ 非法檔位寫入 → 回落 blocking-only', bad?.config?.defaultFixScope === 'blocking-only', JSON.stringify(bad?.config?.defaultFixScope))
	const r = await sc.start('s1', { dims: ['code'] }) // 不顯式傳 → 默認檔位
	check('③ start ok（默認檔位）', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	const text = injectTextOf(sc)
	const data = parseReviewData(text)
	check('③ blocking-only 維持現行為：extras 空、無順帶分組、JSON 無 extras',
		st?.run?.injectLog?.[0]?.fixScope === 'blocking-only' && st.run.injectLog[0].extraCount === 0 && (st.run.injectLog[0].extraItems ?? []).length === 0
		&& !text.includes('順帶修復') && !(data && 'extras' in data),
		JSON.stringify({ f: st?.run?.injectLog?.[0]?.fixScope, e: st?.run?.injectLog?.[0]?.extraCount }))
	sc.teardown()
}
{
	// plus-medium：medium 進順帶分組（low 不進）；R2 僅剩 medium → passed（gate 不受影響）
	const sc = await makeScenario('fs1')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [
		finding({ title: '阻斷項' }), // high → gate 阻斷
		finding({ severity: 'medium', title: '中等問題' }), // 順帶
		finding({ severity: 'low', title: '輕微問題' }), // plus-medium 不含 low
	]))
	sc.script.push(roundResult('code', [finding({ severity: 'medium', title: '中等問題' })])) // R2：阻斷已修，僅剩 medium
	const r = await sc.start('s1', { dims: ['code'], fixScope: 'plus-medium', maxRounds: 3 })
	check('③ start ok（fixScope=plus-medium）', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	const text = injectTextOf(sc)
	check('③ plus-medium：阻斷計數仍 1 + medium 進「順帶修復」分組（另附 1 項）',
		text.includes('發現 1 項未通過驗收') && text.includes('另附 1 項非阻斷順帶修復') && text.includes('非阻斷 · 順帶修復'),
		text.slice(0, 200))
	const data = parseReviewData(text)
	check('③ plus-medium：JSON extras 數組 1 條 severity=medium（low 不進）',
		Array.isArray(data?.extras) && data.extras.length === 1 && data.extras[0].severity === 'medium' && data.extras[0].title === '中等問題',
		JSON.stringify(data?.extras))
	const inj = st?.run?.injectLog?.[0]
	check('③ injectLog 分組計數 count=1/extraCount=1/fixScope=plus-medium + extraItems 快照',
		inj?.count === 1 && inj?.extraCount === 1 && inj?.fixScope === 'plus-medium'
		&& inj?.extraItems?.length === 1 && inj.extraItems[0].severity === 'medium',
		JSON.stringify({ c: inj?.count, e: inj?.extraCount, f: inj?.fixScope }))
	check('③ publicRun.fixScope 回顯 plus-medium', st?.run?.fixScope === 'plus-medium', JSON.stringify(st?.run?.fixScope))
	await driveFix(sc, 's1')
	const st2 = await sc.state('s1')
	check('③ R2 僅剩 medium → passed（gate 全綠不受檔位影響）', st2?.running === false && st2?.lastStatus === 'passed', st2?.lastStatus)
	sc.teardown()
}
{
	// strict gate 反向對照：medium 是阻斷（fixScope 不改變通過線）
	const sc = await makeScenario('fs2')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [finding({ severity: 'medium', title: '中等問題' })]))
	sc.script.push(roundResult('code', [finding({ severity: 'medium', title: '中等問題' })])) // 止損用
	const r = await sc.start('s1', { dims: ['code'], gate: 'strict', fixScope: 'plus-medium' })
	check('③ strict 對照 start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	check('③ strict gate 下 medium 是阻斷（fixScope 與通過線解耦的反向證據）',
		st?.run?.status === 'awaiting-fix' && st?.run?.injectLog?.[0]?.count === 1 && st?.run?.injectLog?.[0]?.extraCount === 0,
		`${st?.run?.status}/${st?.run?.injectLog?.[0]?.count}/${st?.run?.injectLog?.[0]?.extraCount}`)
	await sc.stop('s1')
	sc.teardown()
}
{
	// 配置繼承：config 寫 plus-medium，start 不顯式傳 → 生效；顯式 all 覆蓋配置
	const sc = await makeScenario('fs3')
	sc.addAgent('s1')
	const setRes = await sc.http('POST', '/__review/api/config', { config: { defaultFixScope: 'plus-medium' } })
	check('③ 配置寫入 defaultFixScope=plus-medium', setRes?.config?.defaultFixScope === 'plus-medium', JSON.stringify(setRes?.config?.defaultFixScope))
	sc.script.push(roundResult('code', [finding({ title: '阻斷項' }), finding({ severity: 'medium', title: '中等問題' })]))
	sc.script.push(roundResult('code', [finding({ title: '阻斷項' })]))
	let r = await sc.start('s1', { dims: ['code'], maxRounds: 3 })
	check('③ 配置檔位繼承 start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	let st = await sc.state('s1')
	check('③ 無顯式 → 配置檔位生效（plus-medium：extra=1）',
		st?.run?.injectLog?.[0]?.fixScope === 'plus-medium' && st?.run?.injectLog?.[0]?.extraCount === 1,
		JSON.stringify({ f: st?.run?.injectLog?.[0]?.fixScope, e: st?.run?.injectLog?.[0]?.extraCount }))
	await sc.stop('s1')
	// 顯式 all 覆蓋配置 plus-medium
	const sc2 = await makeScenario('fs4')
	sc2.addAgent('s1')
	sc2.script.push(roundResult('code', [
		finding({ title: '阻斷項' }),
		finding({ severity: 'medium', title: '中等問題' }),
		finding({ severity: 'low', title: '輕微問題' }),
	]))
	sc2.script.push(roundResult('code', [finding({ title: '阻斷項' })]))
	r = await sc2.start('s1', { dims: ['code'], fixScope: 'all', maxRounds: 3 })
	check('③ all 檔位 start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	st = await sc2.state('s1')
	const inj = st?.run?.injectLog?.[0]
	check('③ all 檔位：medium+low 均進 extras（2 條；顯式覆蓋配置）',
		inj?.fixScope === 'all' && inj?.extraCount === 2
		&& inj?.extraItems?.map((x) => x.severity).sort().join(',') === 'low,medium',
		JSON.stringify({ f: inj?.fixScope, e: inj?.extraCount }))
	sc2.teardown()
	sc.teardown()
}
{
	// manual 模式：pendingInject.extraCount 對外可見（面板 awaiting-confirm 顯示）
	const sc = await makeScenario('fs5')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [finding({ title: '阻斷項' }), finding({ severity: 'medium', title: '中等問題' })]))
	const r = await sc.start('s1', { dims: ['code'], injectMode: 'manual', fixScope: 'plus-medium' })
	check('③ manual 場景 start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('s1')
	check('③ manual 模式：pendingInject extraCount 對外可見（awaiting-confirm）',
		st?.run?.status === 'awaiting-confirm' && st?.run?.pendingInject?.count === 1 && st?.run?.pendingInject?.extraCount === 1,
		JSON.stringify(st?.run?.pendingInject))
	await sc.stop('s1')
	sc.teardown()
}

// ══════════════════ ④ P1-10 模型次序 ══════════════════
console.log('\n── ④ P1-10 次序：提交 models=[kimi-k3, glm-5.3] → R1 用 kimi-k3、R2 輪換 glm-5.3 ──')
{
	const sc = await makeScenario('order')
	sc.addAgent('s1')
	sc.script.push(roundResult('code', [finding()]))
	sc.script.push(roundResult('code', [finding({ line: 40 })]))
	const r = await sc.start('s1', { dims: ['code'], models: ['kimi-k3', 'glm-5.3'] }) // 提交順序 [B,A]
	check('④ start ok（models=[kimi-k3,glm-5.3]）', r?.ok === true, JSON.stringify(r))
	await tick()
	let st = await sc.state('s1')
	check('④ R1 審查者用第 1 個提交的 kimi-k3（樁記錄 spawn 模型 + label）',
		sc.spawns.length === 1 && sc.spawns[0].model === 'kimi-k3' && sc.spawns[0].label.includes('R1') && sc.spawns[0].label.includes('kimi-k3'),
		sc.spawns.map((s) => s.label).join())
	check('④ R1 注入文案「本輪模型：kimi-k3」', injectTextOf(sc).includes('本輪模型：kimi-k3'), injectTextOf(sc).slice(0, 120))
	await driveFix(sc, 's1')
	st = await sc.state('s1')
	check('④ R2 輪換到第 2 個 glm-5.3（spawn 調用序）',
		sc.spawns.length === 2 && sc.spawns[1].model === 'glm-5.3' && sc.spawns[1].label.includes('R2') && sc.spawns[1].label.includes('glm-5.3'),
		sc.spawns.map((s) => s.label).join())
	check('④ R2 注入文案「本輪模型：glm-5.3」', injectTextOf(sc, 1).includes('本輪模型：glm-5.3'), injectTextOf(sc, 1).slice(0, 120))
	await sc.stop('s1')
	sc.teardown()
}

// ══════════════════ ⑤ P1-12 輪次數據 ══════════════════
console.log('\n── ⑤ P1-12 輪次數據：兩輪樁閉環 → roundLog 完整（含 resolved 差值）+ injectLog 快照 ──')
{
	const sc = await makeScenario('timeline')
	sc.addAgent('s1')
	const F1 = finding() // 兩維共同指出
	const F2 = finding({ file: 'src/b.js', line: 8, title: '新引入的邊界錯誤' })
	sc.script.push(roundResult('code', [{ ...F1 }]))
	sc.script.push(roundResult('flow', [{ ...F1 }])) // 同指紋 → R1 合併 1 條
	sc.script.push(roundResult('code', [{ ...F1, resolved: true }])) // R2：確認修復
	sc.script.push(roundResult('flow', [{ ...F1, resolved: true }, { ...F2 }])) // R2：F2 仍阻斷
	const r = await sc.start('s1', { dims: ['code', 'flow'], maxRounds: 4 })
	check('⑤ start ok（兩輪閉環場景）', r?.ok === true, JSON.stringify(r))
	await tick()
	let st = await sc.state('s1')
	const KEYS = ['round', 'at', 'scope', 'changedCount', 'blockingByDim', 'mergedCount', 'crossCount', 'resolvedVsPrev', 'ignoredCount']
	const rl1 = st?.run?.roundLog?.[0]
	check('⑤ R1 roundLog 條目鍵完整（9 欄位）',
		rl1 != null && Object.keys(rl1).length === KEYS.length && KEYS.every((k) => k in rl1), JSON.stringify(rl1 && Object.keys(rl1)))
	check('⑤ R1 合併前後對比：per-dim code:1/flow:1 → merged=1/cross=1',
		rl1?.blockingByDim?.code === 1 && rl1?.blockingByDim?.flow === 1 && rl1?.mergedCount === 1 && rl1?.crossCount === 1,
		JSON.stringify(rl1))
	check('⑤ R1 injectLog items 含 coDims 快照（+count/extraCount/fixScope 欄位）',
		st?.run?.injectLog?.[0]?.items?.length === 1 && JSON.stringify(st.run.injectLog[0].items[0].coDims) === JSON.stringify(['code', 'flow'])
		&& st.run.injectLog[0].count === 1 && st.run.injectLog[0].fixScope === 'blocking-only',
		JSON.stringify(st?.run?.injectLog?.[0]))
	await driveFix(sc, 's1')
	st = await sc.state('s1')
	const rl2 = st?.run?.roundLog?.[1]
	check('⑤ R2 resolvedVsPrev=1（上輪阻斷指紋 ∩ 本輪 resolved:true）',
		st?.run?.roundLog?.length === 2 && rl2?.resolvedVsPrev === 1, JSON.stringify(rl2))
	check('⑤ R2 blockingByDim 計數 code:0/flow:1（仍有阻斷 → awaiting-fix）',
		rl2?.blockingByDim?.code === 0 && rl2?.blockingByDim?.flow === 1 && st?.run?.status === 'awaiting-fix',
		`${JSON.stringify(rl2?.blockingByDim)}/${st?.run?.status}`)
	check('⑤ R2 injectLog items 1 條（新問題 F2，無 coDims）+ 注入兩次',
		st?.run?.injectLog?.length === 2 && st.run.injectLog[1].items.length === 1
		&& st.run.injectLog[1].items[0].title === '新引入的邊界錯誤' && st.run.injectLog[1].items[0].coDims === undefined,
		JSON.stringify(st?.run?.injectLog?.[1]?.items))
	const rep = await sc.report('s1')
	check('⑤ 報告輪次行：R1 跨維度合併 + R2 確認修復1',
		(rep?.report ?? '').includes('R1·全量·發現1（跨維度合併1）') && (rep?.report ?? '').includes('R2·全量·發現1·確認修復1'),
		(rep?.report ?? '').split('\n').filter((l) => l.includes('輪次')).join('/'))
	await sc.stop('s1')
	sc.teardown()
}

// ══════════════════ ⑥ client 靜態檢查 + 樁渲染 ══════════════════
console.log('\n── ⑥ client：截斷組件 / 次序 ↑↓ / 時間線卡 / 596 文案 / MdRender 粗體與表格 ──')
const clientSrc = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
// 源碼注入 __test 導出（僅測試副本；不動原檔）
const injectAnchor = '\t\treturn module.exports;'
if (!clientSrc.includes(injectAnchor)) { console.error('✗ client 源不符合預期 return 錨點'); process.exit(1) }
let clientFactory = null
globalThis.window = { __ModuleLoader__: { load: (def) => { clientFactory = def.factory } } }
const clientStubPath = path.join(os.tmpdir(), `dsh-ar-v14-client-${Date.now()}.mjs`)
writeFileSync(clientStubPath, clientSrc.replace(injectAnchor,
	'\t\texports.__test = { MdRender, ModelOrderEditor, RoundTimeline, DimCard };\n' + injectAnchor))
await import(pathToFileURL(clientStubPath).href)
check('⑥ client 工廠捕獲（__test 導出注入成功）', typeof clientFactory === 'function')
const stubReact = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
	useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
	useEffect: () => {}, useCallback: (f) => f,
}
const T = clientFactory((name) => { if (name === 'react') return stubReact; throw new Error('unexpected require: ' + name) })
// 樹渲染器：函數組件求值 → {tag, props, kids, text}
function renderNode(node) {
	if (node === null || node === undefined || node === false || node === true) return null
	if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
	if (Array.isArray(node)) {
		const kids = node.map(renderNode).filter(Boolean)
		return kids.length === 1 ? kids[0] : { frag: true, kids }
	}
	if (typeof node.type === 'function') return renderNode(node.type(node.props))
	return { tag: node.type, props: node.props, kids: (node.children || []).map(renderNode).filter(Boolean) }
}
const renderRoot = (comp, props) => renderNode({ type: comp, props })
const textsOf = (n, acc = []) => {
	if (n == null) return acc
	if (n.text !== undefined) { acc.push(n.text); return acc }
	if (n.frag) { for (const k of n.kids) textsOf(k, acc); return acc }
	if (n.kids) for (const k of n.kids) textsOf(k, acc)
	return acc
}
const text = (n) => textsOf(n).join('')
const findTags = (n, tag, acc = []) => {
	if (n == null) return acc
	if (n.tag === tag) acc.push(n)
	if (n.kids) for (const k of n.kids) findTags(k, tag, acc)
	return acc
}
{
	// 源碼靜態斷言（P1-7/10/11/12 + 596 文案）
	check('⑥ 源碼：兩行截斷組件存在（WebkitLineClamp）', clientSrc.includes('WebkitLineClamp'))
	check('⑥ 源碼：次序編輯 ↑/↓ 按鈕 + 輪換預覽存在', clientSrc.includes('"↑"') && clientSrc.includes('"↓"') && clientSrc.includes('輪換次序：'))
	check('⑥ 源碼：review-start 提交 models: modelOrder（面板→host 次序契約）', clientSrc.includes('models: modelOrder'))
	check('⑥ 源碼：RoundTimeline/RoundCard 時間線卡存在', clientSrc.includes('function RoundTimeline') && clientSrc.includes('function RoundCard'))
	check('⑥ 源碼：FIX_SCOPE_OPTS 三檔 + 解耦提示', clientSrc.includes('FIX_SCOPE_OPTS') && clientSrc.includes('不影響驗收口徑'))
	check('⑥ 源碼：596 誤導文案已移除（如實文案 + 未保存標記）',
		!clientSrc.includes('修改即時生效並持久化') && clientSrc.includes('修改後需按下方「保存設置」才生效') && clientSrc.includes('● 有未保存修改'))
	// MdRender 行為：粗體 / 表格（含轉義豎線還原）
	const md = [
		'# 自動審查官報告 · /proj/x',
		'',
		'狀態：**passed**（第 3 輪 / 上限 5）',
		'',
		'| 嚴重度 | 位置 | 問題 |',
		'|---|---|---|',
		'| high | src/a.js\\|b:12 | 未處理的空值引用導致崩潰 |',
		'',
		'---',
	].join('\n')
	const mdTree = renderRoot(T.__test.MdRender, { text: md })
	const strongs = findTags(mdTree, 'strong')
	check('⑥ MdRender 對 **粗體** 有輸出（strong·passed）', strongs.length === 1 && text(strongs[0]) === 'passed', JSON.stringify(strongs.map(text)))
	const tds = findTags(mdTree, 'td')
	check('⑥ MdRender 對表格有輸出（table/thead/td + 轉義豎線還原）',
		findTags(mdTree, 'table').length === 1 && findTags(mdTree, 'thead').length === 1 && tds.length === 3
		&& tds.some((td) => text(td) === 'src/a.js|b:12') && tds.some((td) => text(td) === 'high'),
		JSON.stringify(tds.map(text)))
	// ModelOrderEditor 行為：次序預覽 + ↑↓ 禁用態
	const moTree = renderRoot(T.__test.ModelOrderEditor, {
		order: ['kimi-k3', 'glm-5.3'],
		labelOf: (k) => ({ 'kimi-k3': 'Kimi K3', 'glm-5.3': 'GLM 5.3' }[k] || k),
		onMove: () => {}, onRemove: () => {},
	})
	const moTxt = text(moTree)
	const moBtns = findTags(moTree, 'button').filter((b) => ['↑', '↓', '✕'].includes(text(b)))
	check('⑥ ModelOrderEditor：R1→R2 輪換預覽按數組序',
		moTxt.includes('輪換次序：R1 Kimi K3 → R2 GLM 5.3（依序循環）'), moTxt.slice(-80))
	check('⑥ ModelOrderEditor：每檔 ↑↓✕ 三鈕、首位↑禁用/末位↓禁用',
		moBtns.length === 6 && moBtns.filter((b) => text(b) === '↑')[0].props.disabled === true
		&& moBtns.filter((b) => text(b) === '↓')[0].props.disabled === false
		&& moBtns.filter((b) => text(b) === '↑')[1].props.disabled === false
		&& moBtns.filter((b) => text(b) === '↓')[1].props.disabled === true,
		JSON.stringify(moBtns.map((b) => [text(b), b.props.disabled])))
	// RoundTimeline 行為：消費 t1 publicRun 數據形狀
	const RUN = {
		runId: 'r1', sessionId: 's1', projectPath: '/proj/x', mode: 'loop', injectMode: 'auto',
		status: 'awaiting-fix', scope: 'smart', fixScope: 'plus-medium', round: 2, maxRounds: 5,
		startedAt: 1_700_000_000_000, error: null,
		injectLog: [{
			round: 1, at: 1_700_000_050_000, count: 1, extraCount: 1, fixScope: 'plus-medium',
			items: [{ severity: 'high', file: 'src/app.js', line: 12, title: '未處理的空值引用導致崩潰', dim: 'code', coDims: ['code', 'flow'] }],
			extraItems: [{ severity: 'medium', file: 'src/c.js', line: 3, title: '中等問題', dim: 'design' }],
		}],
		pendingInject: null,
		gate: 'standard', dims: ['code', 'flow'], models: ['kimi-k3', 'glm-5.3'],
		roundLog: [
			{ round: 1, at: 1_700_000_040_000, scope: 'full', changedCount: null, blockingByDim: { code: 1, flow: 1 }, mergedCount: 1, crossCount: 1, resolvedVsPrev: 0, ignoredCount: 0 },
			{ round: 2, at: 1_700_000_090_000, scope: 'smart', changedCount: 0, blockingByDim: { code: 0, flow: 1 }, mergedCount: 1, crossCount: 0, resolvedVsPrev: 1, ignoredCount: 0 },
		],
		ignoredByDecision: {},
		dimensions: [
			{ id: 'code', label: '代碼', status: 'blocking', pass: false, summary: '', error: null, counts: { critical: 0, high: 1, medium: 0, low: 0 }, findings: [], ignored: [] },
			{ id: 'flow', label: '用戶流程', status: 'passed', pass: true, summary: '', error: null, counts: { critical: 0, high: 0, medium: 0, low: 0 }, findings: [], ignored: [] },
		],
	}
	const tlTree = renderRoot(T.__test.RoundTimeline, { run: RUN, active: false })
	const tlTxt = text(tlTree)
	check('⑥ RoundTimeline：R1/R2 卡頭（模型輪換 + 跨維度合併 + 確認修復↓）',
		tlTxt.includes('輪次時間線') && tlTxt.includes('R1') && tlTxt.includes('kimi-k3')
		&& tlTxt.includes('R2') && tlTxt.includes('glm-5.3') && tlTxt.includes('跨維度合併 1') && tlTxt.includes('較上輪確認修復 ↓1'),
		tlTxt.slice(0, 160))
	const run1 = JSON.parse(JSON.stringify(RUN))
	run1.roundLog = [RUN.roundLog[0]] // 僅 R1 → 終態末輪默認展開
	const tlTree1 = renderRoot(T.__test.RoundTimeline, { run: run1, active: false })
	const tlTxt1 = text(tlTree1)
	check('⑥ RoundTimeline：展開逐項（coDims 共同指出 + 順帶修復分組 + 修復範圍檔位）',
		tlTxt1.includes('⚠ 代碼+用戶流程 共同指出') && tlTxt1.includes('順帶修復（非阻斷，不影響驗收）') && tlTxt1.includes('中等問題')
		&& tlTxt1.includes('修復範圍 含 Medium') && tlTxt1.includes('注入清單（1 項'),
		tlTxt1.slice(200, 420))
	// DimCard 行為：長摘要截斷
	const dimTree = renderRoot(T.__test.DimCard, {
		dim: { id: 'code', label: '代碼', status: 'blocking', summary: '長'.repeat(120), error: null, counts: { critical: 0, high: 1, medium: 0, low: 0 }, findings: [], ignored: [] },
	})
	check('⑥ DimCard：長摘要觸發兩行截斷（clamp 樣式 + 展開鈕）',
		findTags(dimTree, 'div').some((d) => d.props.style && d.props.style.WebkitLineClamp === 2) && text(dimTree).includes('展開 ▾'),
		text(dimTree).slice(-40))
}

// ══════════════════ ⑦ P1-13 審查歷史持久化 ══════════════════
// 歸檔觸發（六種終態）+ 磁碟佈局（$DSH_HOME/review-history/<slug>/<runId>/）+ 清單/明細 API
// + 256KB 截斷（findings 為主）+ 每項目 LRU 50 + 鑑權與路徑參數校驗。slug = 會話 cwd 末段。
console.log('\n── ⑦ P1-13 歷史：passed/stopped 歸檔 + 磁碟佈局 + 清單/明細 API ──')
const flushHist = async () => { await new Promise((r) => setTimeout(r, 60)) } // 真實時鐘等異步歸檔鏈收斂
/** 輪詢 GET 直到回應非空且述詞通過（歸檔鏈 FIFO：首個成功讀取即含全部已觸發終態；重試兜底長鏈 I/O）。 */
const waitJson = async (sc, url, pred, tries = 40) => {
	for (let i = 0; i < tries; i++) {
		const body = await sc.http('GET', url)
		if (body !== null && pred(body)) return body
		await new Promise((r) => setTimeout(r, 50))
	}
	return null
}
{
	const sc = await makeScenario('histA')
	sc.addAgent('hA') // slug = cwd 末段 = 'hA'
	sc.script.push(roundResult('code', [finding()])) // R1 blocking
	sc.script.push(roundResult('code', []))          // R2 全綠 → passed
	const r = await sc.start('hA', { dims: ['code'] })
	check('⑦ start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	await driveFix(sc, 'hA')
	await tick()
	const st = await sc.state('hA')
	check('⑦ R2 全綠 → passed 終態', st?.running === false && st?.lastStatus === 'passed', st?.lastStatus)
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history', (b) => (b.runs ?? []).some((x) => x.project === 'hA' && x.status === 'passed'))
	const entry = (list?.runs ?? []).find((x) => x.project === 'hA')
	check('⑦ 清單含 hA 的 passed 條目', list?.ok === true && entry?.status === 'passed' && entry?.hasReport === true, JSON.stringify(entry))
	check('⑦ 摘要計數：blocking=0 / severityCounts 全 0 / injectCount=1',
		entry?.blocking === 0 && JSON.stringify(entry?.severityCounts) === JSON.stringify({ critical: 0, high: 0, medium: 0, low: 0 }) && entry?.injectCount === 1,
		JSON.stringify(entry?.severityCounts))
	check('⑦ 摘要帶項目與輪次欄位', entry?.projectName === 'hA' && entry?.mode === 'loop' && entry?.round === 2 && entry?.maxRounds === 5 && Array.isArray(entry?.models),
		JSON.stringify({ pn: entry?.projectName, round: entry?.round, models: entry?.models }))
	const detail = await waitJson(sc, `/__review/api/history/${entry.runId}?project=hA`, (b) => b?.ok === true && b?.run?.runId === entry.runId)
	check('⑦ 明細 ok：run.runId 一致 + status=passed', detail?.run?.runId === entry.runId && detail?.run?.status === 'passed', JSON.stringify(detail?.run?.runId))
	check('⑦ 明細 historyMeta 如實（未截斷）', detail?.run?.historyMeta?.truncated === false && detail?.run?.historyMeta?.project === 'hA', JSON.stringify(detail?.run?.historyMeta))
	check('⑦ 明細 report 為 Markdown 全文', typeof detail?.report === 'string' && detail.report.includes('自動審查官報告'), String(detail?.report ?? '').slice(0, 40))
	// 磁碟佈局：review-history/<slug>/<runId>/{run.json,report.md} + 項目級 index.json
	const projDir = path.join(HIST_HOME, 'review-history', 'hA')
	const runDir = path.join(projDir, entry.runId)
	check('⑦ 磁碟佈局 run.json/report.md/index.json 齊備',
		exists(runDir + '/run.json') && exists(runDir + '/report.md') && exists(path.join(projDir, 'index.json')),
		projDir)
	const onDisk = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'))
	check('⑦ 磁碟 run.json = publicRun 快照 + historyMeta', onDisk.runId === entry.runId && onDumpHasRunShape(onDisk), JSON.stringify(Object.keys(onDisk).slice(0, 6)))
	sc.teardown()
}
function exists(p) { try { statSync(p); return true } catch { return false } }
function onDumpHasRunShape(doc) {
	const keys = ['runId', 'sessionId', 'status', 'round', 'roundLog', 'dimensions', 'historyMeta']
	return keys.every((k) => k in doc) && Array.isArray(doc.dimensions) && doc.dimensions[0]?.counts != null
}
console.log('\n── ⑦ P1-13 歷史：stopped 歸檔；paused 不歸檔（可恢復暫態）──')
{
	const sc = await makeScenario('histB')
	sc.addAgent('hB')
	sc.script.push(roundResult('code', [finding()])) // R1 blocking → awaiting-fix
	await sc.start('hB', { dims: ['code'] })
	await tick()
	await sc.stop('hB') // 用戶終止 → stopped 終態
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history?project=hB', (b) => (b.runs ?? []).some((x) => x.status === 'stopped'))
	check('⑦ stopped 亦歸檔（含 R1 阻斷計數）', list?.runs?.length === 1 && list.runs[0].status === 'stopped' && list.runs[0].blocking === 1,
		JSON.stringify(list?.runs?.[0]))
	sc.teardown()
}
{
	const sc = await makeScenario('histC')
	sc.addAgent('hC')
	sc.script.push(roundResult('code', [finding()]))
	await sc.start('hC', { dims: ['code'] })
	await tick()
	sc.agents.delete('hC') // 目標代理離線 → paused（可恢復，非終態）
	sc.clock.advance(3_000)
	await tick()
	const st = await sc.state('hC')
	check('⑦ 前置：代理離線 → paused', st?.running === false && st?.lastStatus === 'paused', st?.lastStatus)
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history?project=hC', (b) => b?.ok === true, 10)
	check('⑦ paused 不歸檔（歷史僅記六種終態）', (list?.runs ?? []).length === 0, JSON.stringify(list?.runs?.length))
	sc.teardown()
}
console.log('\n── ⑦ P1-13 歷史：256KB 單檔截斷（findings 為主 + truncated/droppedFindings 如實標注）──')
{
	const sc = await makeScenario('histD')
	sc.addAgent('hD')
	const big = 'x'.repeat(5000)
	const many = []
	for (let i = 0; i < 300; i++) many.push(finding({ severity: 'low', title: `低嚴重度問題 ${i}`, detail: big, suggestion: big }))
	for (let i = 0; i < 300; i++) many.push(finding({ severity: 'high', title: `高嚴重度問題 ${i}`, detail: big, suggestion: big }))
	sc.script.push(roundResult('code', many))
	const r = await sc.start('hD', { dims: ['code'], mode: 'report' }) // 報告模式：單輪 → reported 終態
	check('⑦ 報告模式 start ok', r?.ok === true, JSON.stringify(r))
	await tick()
	const st = await sc.state('hD')
	check('⑦ 報告模式單輪 → reported 終態', st?.running === false && st?.lastStatus === 'reported', st?.lastStatus)
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history?project=hD', (b) => (b.runs ?? []).some((x) => x.truncated === true))
	const entry = list?.runs?.[0]
	check('⑦ 清單條目標注截斷（truncated + droppedFindings=600）', entry?.truncated === true && entry?.droppedFindings === 600, JSON.stringify({ t: entry?.truncated, d: entry?.droppedFindings }))
	check('⑦ 清單計數不失真（low:300 / high:300 —— 丟明細保數量）',
		entry?.severityCounts?.low === 300 && entry?.severityCounts?.high === 300, JSON.stringify(entry?.severityCounts))
	const detail = await waitJson(sc, `/__review/api/history/${entry.runId}?project=hD`, (b) => b?.run?.historyMeta?.truncated === true)
	check('⑦ 明細 historyMeta.truncated=true', detail?.run?.historyMeta?.truncated === true && detail?.run?.historyMeta?.droppedFindings === 600, JSON.stringify(detail?.run?.historyMeta))
	const runJsonPath = path.join(HIST_HOME, 'review-history', 'hD', entry.runId, 'run.json')
	const size = statSync(runJsonPath).size
	check('⑦ 磁碟 run.json ≤ 256KB', size <= 256 * 1024, String(size))
	const onDisk = JSON.parse(readFileSync(runJsonPath, 'utf8'))
	check('⑦ 磁碟快照可解析且維度計數保留（findings 明細被削減）',
		onDisk.dimensions?.[0]?.counts?.low === 300 && Array.isArray(onDisk.dimensions?.[0]?.findings) && onDisk.dimensions[0].findings.length === 0,
		JSON.stringify(onDisk.dimensions?.[0]?.counts))
	sc.teardown()
}
console.log('\n── ⑦ P1-13 歷史：每項目 LRU 保留 50（超額逐出最舊並刪目錄）──')
{
	const sc = await makeScenario('histE')
	sc.addAgent('hE')
	const firstTwo = []
	for (let i = 0; i < 52; i++) {
		sc.script.push(roundResult('code', [])) // 全綠 → passed 立即終態
		const r = await sc.start('hE', { dims: ['code'], mode: 'report' })
		if (i < 2) firstTwo.push(r?.runId)
		await tick(15)
		sc.clock.advance(10_000) // 拉開 archivedAt（虛擬時鐘 凍結下需手動推進）
	}
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history?project=hE', (b) => (b.runs ?? []).length === 50)
	check('⑦ LRU：清單僅保留 50 條', list?.runs?.length === 50, String(list?.runs?.length))
	check('⑦ LRU：最舊兩條已被逐出', firstTwo.every((id) => !(list.runs ?? []).some((x) => x.runId === id)), JSON.stringify(firstTwo))
	const idx = JSON.parse(readFileSync(path.join(HIST_HOME, 'review-history', 'hE', 'index.json'), 'utf8'))
	check('⑦ LRU：index.json 同步收斂到 50', Array.isArray(idx.runs) && idx.runs.length === 50, String(idx.runs?.length))
	const dirs = readdirSync(path.join(HIST_HOME, 'review-history', 'hE')).filter((n) => n !== 'index.json')
	check('⑦ LRU：磁碟 run 目錄同步刪除（50 個）', dirs.length === 50, String(dirs.length))
	sc.teardown()
}
console.log('\n── ⑦ P1-13 歷史：鑑權（沿用 x-review-token + Host 白名單）與路徑參數校驗 ──')
{
	const sc = await makeScenario('histF')
	sc.addAgent('hF')
	sc.script.push(roundResult('code', []))
	await sc.start('hF', { dims: ['code'], mode: 'report' })
	await flushHist()
	const noTok = await sc.rawHttp('GET', '/__review/api/history', { host: '127.0.0.1:3080' })
	check('⑦ 無 token → 401（歷史端點掛既有鑑權）', noTok.out.code === 401, String(noTok.out.code))
	const badTok = await sc.rawHttp('GET', '/__review/api/history', { host: '127.0.0.1:3080', 'x-review-token': 'bad' })
	check('⑦ 錯 token → 401', badTok.out.code === 401, String(badTok.out.code))
	const badHost = await sc.rawHttp('GET', '/__review/api/history', { host: 'evil.example' })
	check('⑦ 惡意 Host → 403（DNS rebinding 防護同樣生效）', badHost.out.code === 403, String(badHost.out.code))
	const evilId = await sc.rawHttp('GET', '/__review/api/history/..%2F..%2Fetc')
	check('⑦ 路徑穿越 runId → 400（白名單校驗）', evilId.out.code === 400, String(evilId.out.code))
	const notFound = await sc.http('GET', '/__review/api/history/zzz-not-exist')
	check('⑦ 未知 runId → 404', notFound?.ok === false, JSON.stringify(notFound))
	sc.teardown()
}

console.log(failures === 0 ? `\nv1.4 六項新能力 ${passes} 項斷言全部通過 ✅` : `\n${passes} 通過，${failures} 項失敗 ❌`)
process.exit(failures === 0 ? 0 : 1)
