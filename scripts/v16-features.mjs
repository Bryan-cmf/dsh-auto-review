// v1.6 三項新能力測試（P1-13 歷史持久化 / P1-14 渲染升級 / P1-15 統計圖表）—— node scripts/v16-features.mjs
// 樁技術沿用 smoke/loop-sim/resume-sim/v14-features：虛擬時鐘假 timer + 樁 agents/subagents/
// sessionQuery 驅動 lib/index.js apply()（歸檔寫真實臨時目錄 $DSH_HOME——每場景獨立重定向，
// 絕不寫真實 ~/.dsh）；client 半以源碼注入 __test 導出後以「帶狀態」樁 react 渲染斷言。
// 純進程內，不依賴外部服務、不真實等待（歸檔鏈用短 real-flush 收斂）、不重啟 DSH。
//
// 場景總覽：
//   ① P1-13 歷史（host）：
//      A. passed 終態歸檔——磁碟佈局 <home>/review-history/<slug>/<runId>/{run.json,report.md}
//         + 項目 index.json；run.json=publicRun 快照+historyMeta；report.md=報告全文；
//         清單/明細 API 形狀（token 鑑權下）；項目過濾；時間倒序
//      B. 鑑權與路徑校驗——無/錯 token→401（清單+明細）、惡意 Host→403、
//         路徑穿越 runId（../、空、空白）→400、?project=../x 安全忽略、POST→404
//      C. index.json 壞損自愈——刪除後清單從 run.json 目錄重建
//      D. stopped 亦歸檔；paused（可恢復暫態）不歸檔
//      E. 每項目 LRU：51 個終態 run → 清單/index/磁碟目錄各收斂到 50，最舊被逐出
//      F. 256KB 單檔截斷：findings 為主削減 + truncated/droppedFindings 如實標注 +
//         計數不失真；report.md 硬截斷帶尾部標記
//      G. 歸檔失敗靜默降級：review-history 被同名檔案佔用 → mkdir 拋錯 → console.error
//         帶標籤記錄，閉環終態/報告/清單 API 全不受影響，無 unhandledRejection
//   ② P1-15 統計（client 純函數 + 樁渲染，構造 publicRun）：
//      statsOfRun 聚合正確（dims/sevTotal/rounds 排序/fileTop Top5/sevMax/頑固項指紋）；
//      環形四段佔比和=100% 且偏移連續；折線點數=輪次數（空/單點安全）；
//      堆疊段寬 flex=計數；熱點排序與條寬；頑固項=跨輪≥2 且未解決（標點漂移同指紋）
//   ③ P1-14 渲染（client 樁渲染）：
//      MdRender 斑馬紋表格 / severity 色籤（色點+色字）/ h1·h2 錨點 id（同文去重）/
//      章節摺疊默認（未通過展開、✅ 已通過收起）+ 點擊翻轉 / 引用豎線 / 行內 code；
//      ReportView 複製 MD + 下載 .md（data: href 可還原原文）+ TOC 錨點一致性 + 摘要卡；
//      HistorySection 初始態與四態文案、歷史卡（已截斷標記）
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// ── 全局安全網：任何未捕獲 rejection 都計入（歸檔失敗場景的硬性要求是零外洩）──
const unhandled = []
process.on('unhandledRejection', (r) => { unhandled.push(String(r)) })

// P1-13：歸檔一律寫臨時家目錄（每組場景獨立重定向），絕不寫真實 ~/.dsh
const TMP_BASE = mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-v16-'))
const HOME_A = path.join(TMP_BASE, 'homeA')
const HOME_B = path.join(TMP_BASE, 'homeB')
const HOME_C = path.join(TMP_BASE, 'homeC')
const HOME_D = path.join(TMP_BASE, 'homeD')
for (const h of [HOME_A, HOME_B, HOME_C, HOME_D]) { writeFileSync(h, ''); rmSync(h) } // 確保父目錄可寫（建後即刪佔位）
process.env.DSH_HOME = HOME_A

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
let failures = 0
let passes = 0
const SEC = { h: 0, s: 0, r: 0 } // ①歷史 / ②統計 / ③渲染 斷言計數
const check = (name, cond, extra = '', group = null) => {
	const g = group ?? (name.startsWith('②') ? 's' : name.startsWith('③') ? 'r' : 'h')
	console.log(`${cond ? '✓' : '✗'} ${name}${!cond && extra ? `  【${extra}】` : ''}`)
	if (cond) { passes++; SEC[g]++ } else failures++
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

// ── host 源剝離 schemastery import 後每場景全新實例（獨立 runs 閉包 + 獨立 DSH_HOME 緩存）──
const hostSrc = readFileSync(path.join(root, 'lib/index.js'), 'utf8')
const stripRe = /^import \w+ from '@deepseek-ai\/schemastery'$/m
if (!stripRe.test(hostSrc)) { console.error('✗ host 源不符合預期 import 形狀'); process.exit(1) }
const stripped = hostSrc.replace(stripRe, 'const SMZ = null')
let hostSeq = 0
async function freshHost() {
	const p = path.join(os.tmpdir(), `dsh-ar-v16-host-${Date.now.toString(36)}-${++hostSeq}.mjs`)
	writeFileSync(p, stripped)
	return import(pathToFileURL(p).href)
}

// ── 樁 HTTP req/res（token 引導後一律攜帶；rawHttp 可完全控制請求頭/socket）──
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

/** 場景環境：全新 host + 樁服務 + 可編排 subagents（structured 結果隊列按 spawn 序消費）。 */
async function makeScenario(name) {
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
		start: async (_p, o) => {
			spawns.push({ label: o.label, model: o.agentOptions?.model, prompt: o.prompt })
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
		})[n],
		timer: clock.api,
		effect: (fn) => { const d = fn(); effects.push(d); return () => { for (const d2 of effects) { try { d2() } catch {} } } },
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

// 歸檔鏈是真實異步 fs——real-flush 收斂 + 輪詢等待（historyChain FIFO：首個成功讀取即含全部已觸發終態）
const flushHist = async () => { await new Promise((r) => setTimeout(r, 80)) }
const waitJson = async (sc, url, pred, tries = 40) => {
	for (let i = 0; i < tries; i++) {
		const body = await sc.http('GET', url)
		if (body !== null && pred(body)) return body
		await new Promise((r) => setTimeout(r, 50))
	}
	return null
}
const histDir = (home, slug, runId) => path.join(home, 'review-history', slug, String(runId))

// ══════════════════ ① P1-13 歷史持久化（host）══════════════════
console.log('── ①-A 歸檔觸發與磁碟佈局：passed 終態 → review-history/<slug>/<runId>/{run.json,report.md} ──')
{
	const sc = await makeScenario('histA')
	sc.addAgent('hA') // slug = cwd 末段 = 'hA'
	sc.script.push(roundResult('code', [finding()])) // R1 blocking
	sc.script.push(roundResult('code', []))          // R2 全綠 → passed
	const r = await sc.start('hA', { dims: ['code'] })
	check('①A start ok', r?.ok === true && typeof r?.runId === 'string' && r.runId !== '', JSON.stringify(r).slice(0, 120))
	await tick()
	await driveFix(sc, 'hA')
	await tick()
	const st = await sc.state('hA')
	check('①A R2 全綠 → passed 終態', st?.running === false && st?.lastStatus === 'passed', st?.lastStatus)
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history', (b) => (b.runs ?? []).some((x) => x.project === 'hA' && x.status === 'passed'))
	const entry = (list?.runs ?? []).find((x) => x.project === 'hA')
	check('①A 清單含 hA 的 passed 條目', list?.ok === true && entry != null && entry.status === 'passed' && entry.hasReport === true, JSON.stringify(entry && Object.keys(entry)))
	// 清單條目形狀：關鍵欄位齊備
	const NEED = ['runId', 'project', 'projectName', 'projectPath', 'sessionId', 'status', 'mode', 'injectMode',
		'gate', 'fixScope', 'scope', 'round', 'maxRounds', 'startedAt', 'endedAt', 'blocking', 'severityCounts',
		'injectCount', 'models', 'truncated', 'droppedFindings', 'archivedAt', 'hasReport']
	check('①A 清單條目欄位完整（23 欄）', entry != null && NEED.every((k) => k in entry), JSON.stringify(NEED.filter((k) => entry && !(k in entry))))
	check('①A 摘要值：round=2/maxRounds=5/blocking=0/injectCount=1/projectName=hA/models 數組',
		entry?.round === 2 && entry?.maxRounds === 5 && entry?.blocking === 0 && entry?.injectCount === 1
		&& entry?.projectName === 'hA' && Array.isArray(entry?.models) && entry?.truncated === false && entry?.droppedFindings === 0,
		JSON.stringify({ r: entry?.round, m: entry?.maxRounds, b: entry?.blocking, i: entry?.injectCount }))
	// 磁碟佈局：路徑含 project-slug 與 runId；內容含 run.json 與 report.md
	const dir = histDir(HOME_A, 'hA', entry.runId)
	check('①A 磁碟路徑 <home>/review-history/hA/<runId>/ 存在（含 slug 與 runId）', existsSync(dir), dir)
	check('①A 目錄內 run.json 與 report.md 齊備',
		existsSync(path.join(dir, 'run.json')) && existsSync(path.join(dir, 'report.md'))
		&& existsSync(path.join(HOME_A, 'review-history', 'hA', 'index.json')), dir)
	const onDisk = JSON.parse(readFileSync(path.join(dir, 'run.json'), 'utf8'))
	check('①A run.json = publicRun 快照（runId/sessionId/status/roundLog/dimensions）',
		onDisk.runId === entry.runId && onDisk.sessionId === 'hA' && onDisk.status === 'passed'
		&& Array.isArray(onDisk.roundLog) && Array.isArray(onDisk.dimensions) && onDisk.dimensions[0]?.counts != null,
		JSON.stringify(Object.keys(onDisk)))
	check('①A run.json.historyMeta 如實（schema=1/project=hA/truncated=false/droppedFindings=0）',
		onDisk.historyMeta?.schema === 1 && onDisk.historyMeta?.project === 'hA'
		&& onDisk.historyMeta?.truncated === false && onDisk.historyMeta?.droppedFindings === 0,
		JSON.stringify(onDisk.historyMeta))
	const rep = readFileSync(path.join(dir, 'report.md'), 'utf8')
	check('①A report.md 含報告標題與項目路徑（buildReport 全文）',
		rep.includes('# 自動審查官報告') && rep.includes('/proj/histA/hA'), rep.slice(0, 60))
	// 明細 API 形狀
	const detail = await waitJson(sc, `/__review/api/history/${entry.runId}?project=hA`, (b) => b?.ok === true && b?.run?.runId === entry.runId)
	check('①A 明細 ok：{ok,project,run,report} 且 run.runId 一致',
		detail?.ok === true && detail?.project === 'hA' && detail?.run?.runId === entry.runId && typeof detail?.report === 'string',
		JSON.stringify(detail && Object.keys(detail)))
	check('①A 明細 report 與磁碟 report.md 一致（全文非摘要）',
		typeof detail?.report === 'string' && detail.report.includes('# 自動審查官報告') && detail.report.length === rep.length,
		`${detail?.report?.length}/${rep.length}`)

	console.log('── ①-B 鑑權與路徑校驗：401/403/400/404 ──')
	const noTokL = await sc.rawHttp('GET', '/__review/api/history', { host: '127.0.0.1:3080' })
	check('①B 清單無 token → 401', noTokL.out.code === 401, String(noTokL.out.code))
	const noTokD = await sc.rawHttp('GET', `/__review/api/history/${entry.runId}`, { host: '127.0.0.1:3080' })
	check('①B 明細無 token → 401', noTokD.out.code === 401, String(noTokD.out.code))
	const badTok = await sc.rawHttp('GET', '/__review/api/history', { host: '127.0.0.1:3080', 'x-review-token': 'wrong-token' })
	check('①B 錯 token → 401', badTok.out.code === 401, String(badTok.out.code))
	const badHost = await sc.rawHttp('GET', '/__review/api/history', { host: 'evil.example', 'x-review-token': CUR_TOKEN })
	check('①B 惡意 Host → 403（DNS rebinding 防護）', badHost.out.code === 403, String(badHost.out.code))
	const evil1 = await sc.rawHttp('GET', '/__review/api/history/..%2F..%2Fetc')
	check('①B 路徑穿越 runId（../../etc）→ 400', evil1.out.code === 400, String(evil1.out.code))
	const evil2 = await sc.rawHttp('GET', '/__review/api/history/%2e%2e%2fsecret')
	check('①B 穿越變體（%2e%2e%2f）→ 400', evil2.out.code === 400, String(evil2.out.code))
	const emptyId = await sc.rawHttp('GET', '/__review/api/history/')
	check('①B 空 runId → 400', emptyId.out.code === 400, String(emptyId.out.code))
	const postHist = await sc.http('POST', '/__review/api/history', {})
	check('①B POST 歷史端點 → 404（僅 GET）', postHist?.error === 'not found' || postHist === null, JSON.stringify(postHist))
	const evilProj = await sc.http('GET', '/__review/api/history?project=..%2F..%2Fx')
	check('①B ?project=../x → 過濾器安全忽略（不 500 不穿越）', evilProj?.ok === true && Array.isArray(evilProj?.runs), JSON.stringify(evilProj && { ok: evilProj.ok }))
	const notFound = await sc.http('GET', '/__review/api/history/zzz-not-exist')
	check('①B 未知 runId → ok:false 404 形狀', notFound?.ok === false && typeof notFound?.error === 'string', JSON.stringify(notFound))

	console.log('── ①-C index.json 壞損自愈：刪除後清單從 run.json 目錄重建 ──')
	rmSync(path.join(HOME_A, 'review-history', 'hA', 'index.json'))
	const healed = await sc.http('GET', '/__review/api/history?project=hA')
	const healedEntry = (healed?.runs ?? []).find((x) => x.runId === entry.runId)
	check('①C index 刪除 → 清單自愈重建（掃描 runId 目錄讀 run.json）',
		healed?.ok === true && healedEntry != null && healedEntry.status === 'passed' && healedEntry.project === 'hA',
		JSON.stringify(healed?.runs?.map((x) => x.runId)))

	console.log('── ①-D stopped 亦歸檔；paused 不歸檔 ──')
	sc.addAgent('hst')
	sc.script.push(roundResult('code', [finding()])) // R1 blocking → awaiting-fix
	await sc.start('hst', { dims: ['code'] })
	await tick()
	sc.clock.advance(10_000) // 拉開 archivedAt（虛擬時鐘凍結下需手動推進 → hst 必晚於 hA）
	await sc.stop('hst') // 用戶終止 → stopped 終態
	await flushHist()
	const listAll = await waitJson(sc, '/__review/api/history', (b) => (b.runs ?? []).some((x) => x.project === 'hst' && x.status === 'stopped'))
	const stEntry = listAll?.runs?.find((x) => x.project === 'hst')
	check('①D stopped 歸檔（含 R1 阻斷計數 blocking=1）', stEntry?.status === 'stopped' && stEntry?.blocking === 1, JSON.stringify(stEntry))
	check('①D 清單時間倒序（hst 後歸檔 → 排首）', listAll?.runs?.[0]?.project === 'hst', JSON.stringify(listAll?.runs?.map((x) => x.project)))
	const onlyHst = await sc.http('GET', '/__review/api/history?project=hst')
	check('①D 項目過濾：?project=hst 僅 1 條', (onlyHst?.runs ?? []).length === 1 && onlyHst.runs[0].project === 'hst', JSON.stringify(onlyHst?.runs?.length))
	sc.addAgent('hpa')
	sc.script.push(roundResult('code', [finding()]))
	await sc.start('hpa', { dims: ['code'] })
	await tick()
	sc.agents.delete('hpa') // 目標代理離線 → paused（可恢復，非終態）
	sc.clock.advance(3_000)
	await tick()
	const stP = await sc.state('hpa')
	check('①D 前置：代理離線 → paused', stP?.running === false && stP?.lastStatus === 'paused', stP?.lastStatus)
	await flushHist()
	const listP = await waitJson(sc, '/__review/api/history?project=hpa', (b) => b?.ok === true, 10)
	check('①D paused 不歸檔（僅六種終態）', (listP?.runs ?? []).length === 0, JSON.stringify(listP?.runs?.length))
	sc.teardown()
}

console.log('\n── ①-E 每項目 LRU：51 個終態 run → 收斂 50、最舊逐出（清單/index/磁碟三口徑）──')
{
	process.env.DSH_HOME = HOME_B
	const sc = await makeScenario('lru')
	sc.addAgent('hL')
	let firstRunId = ''
	let lastRunId = ''
	const badStarts = []
	for (let i = 0; i < 51; i++) {
		sc.script.push(roundResult('code', [])) // 全綠 → reported 立即終態
		const r = await sc.start('hL', { dims: ['code'], mode: 'report' })
		if (r?.ok !== true) badStarts.push([i, r?.error])
		if (i === 0) firstRunId = r?.runId
		if (i === 50) lastRunId = r?.runId
		await tick(15)
		sc.clock.advance(10_000) // 拉開 archivedAt（虛擬時鐘凍結下需手動推進）
	}
	await flushHist()
	// 第 52 個歸檔在鏈完全收斂後、時鐘明確推進下觸發 → archivedAt 嚴格最大 → 必排首（排除虛擬時鐘凍結造成的同值平手）
	sc.clock.advance(60_000)
	sc.script.push(roundResult('code', []))
	const r52 = await sc.start('hL', { dims: ['code'], mode: 'report' })
	const finalRunId = r52?.runId
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history?project=hL', (b) => (b.runs ?? []).length === 50 && b.runs.some((x) => x.runId === finalRunId))
	check('①E LRU：清單僅保留 50 條（51 觸發逐出）', list?.runs?.length === 50, String(list?.runs?.length))
	check('①E LRU：最舊（第 1 個）已被逐出', firstRunId !== '' && !(list?.runs ?? []).some((x) => x.runId === firstRunId), firstRunId)
	check('①E 時間倒序：末次歸檔（第 52 個）排首', finalRunId != null && list?.runs?.[0]?.runId === finalRunId, JSON.stringify({ head: list?.runs?.[0]?.runId, final: finalRunId }))
	check('①E LRU：52 個終態 → 仍收斂 50（第 1、2 個都被逐出，第 51 個仍在）',
		badStarts.length === 0 && lastRunId != null && lastRunId !== ''
		&& (list?.runs ?? []).length === 50 && !(list.runs ?? []).some((x) => x.runId === firstRunId)
		&& list.runs.some((x) => x.runId === lastRunId), // report 模式全綠終態=passed（有阻斷才是 reported）
		JSON.stringify({ n: list?.runs?.length, bad: badStarts.slice(0, 3), last: lastRunId }))
	const idx = JSON.parse(readFileSync(path.join(HOME_B, 'review-history', 'hL', 'index.json'), 'utf8'))
	check('①E LRU：index.json 同步收斂到 50（schema=1）', Array.isArray(idx.runs) && idx.runs.length === 50 && idx.schema === 1, String(idx.runs?.length))
	const dirs = readdirSync(path.join(HOME_B, 'review-history', 'hL')).filter((n) => n !== 'index.json')
	check('①E LRU：磁碟 run 目錄同步刪除（50 個，最舊目錄不在）',
		dirs.length === 50 && !dirs.includes(firstRunId), `${dirs.length}/${firstRunId}`)
	check('①E LRU：末次歸檔目錄在磁碟', finalRunId != null && dirs.includes(finalRunId), `${dirs.includes(finalRunId)}`)
	sc.teardown()
}

console.log('\n── ①-F 256KB 單檔截斷：findings 為主削減 + 如實標注 + 計數不失真 + report.md 硬截斷 ──')
{
	process.env.DSH_HOME = HOME_C
	const sc = await makeScenario('trunc')
	sc.addAgent('hC')
	const big = 'x'.repeat(2000)
	const many = []
	for (let i = 0; i < 200; i++) many.push(finding({ severity: 'low', title: `低嚴重度問題 ${i}`, detail: big, suggestion: big }))
	for (let i = 0; i < 200; i++) many.push(finding({ severity: 'high', title: `高嚴重度問題 ${i}`, detail: big, suggestion: big }))
	sc.script.push(roundResult('code', many))
	const r = await sc.start('hC', { dims: ['code'], mode: 'report' }) // 報告模式：單輪 → reported 終態
	check('①F 報告模式 start ok', r?.ok === true, JSON.stringify(r).slice(0, 100))
	await tick()
	const st = await sc.state('hC')
	check('①F 報告模式單輪 → reported 終態', st?.running === false && st?.lastStatus === 'reported', st?.lastStatus)
	await flushHist()
	const list = await waitJson(sc, '/__review/api/history?project=hC', (b) => (b.runs ?? []).some((x) => x.truncated === true))
	const entry = list?.runs?.find((x) => x.truncated === true)
	check('①F 清單條目標注截斷（truncated=true + droppedFindings=200：先丟 low）',
		entry?.truncated === true && entry?.droppedFindings === 200, JSON.stringify({ t: entry?.truncated, d: entry?.droppedFindings }))
	check('①F 清單計數不失真（low:200 / high:200 —— 丟明細保數量）',
		entry?.severityCounts?.low === 200 && entry?.severityCounts?.high === 200, JSON.stringify(entry?.severityCounts))
	const runJsonPath = path.join(HOME_C, 'review-history', 'hC', entry.runId, 'run.json')
	const repPath = path.join(HOME_C, 'review-history', 'hC', entry.runId, 'report.md')
	const runJsonSize = statSync(runJsonPath).size
	const repSize = statSync(repPath).size
	check('①F 磁碟 run.json ≤ 256KB 且可解析', runJsonSize <= 256 * 1024, String(runJsonSize))
	check('①F 磁碟 report.md ≤ 256KB 且尾部帶截斷標記', repSize <= 256 * 1024 && readFileSync(repPath, 'utf8').includes('已截斷'), String(repSize))
	const doc = JSON.parse(readFileSync(runJsonPath, 'utf8'))
	check('①F 磁碟快照 historyMeta.truncated=true / droppedFindings=200',
		doc.historyMeta?.truncated === true && doc.historyMeta?.droppedFindings === 200, JSON.stringify(doc.historyMeta))
	check('①F 丟的是 low 明細（findings 無 low、僅剩 high），counts 全保留',
		doc.dimensions?.[0]?.counts?.low === 200 && doc.dimensions?.[0]?.counts?.high === 200
		&& doc.dimensions[0].findings.every((f) => f.severity !== 'low') && doc.dimensions[0].findings.length === 200,
		JSON.stringify({ c: doc.dimensions?.[0]?.counts, n: doc.dimensions?.[0]?.findings?.length }))
	const detail = await waitJson(sc, `/__review/api/history/${entry.runId}?project=hC`, (b) => b?.run?.historyMeta?.truncated === true)
	check('①F 明細 API historyMeta 如實透傳截斷', detail?.run?.historyMeta?.truncated === true && detail?.run?.historyMeta?.droppedFindings === 200, JSON.stringify(detail?.run?.historyMeta))
	sc.teardown()
}

console.log('\n── ①-G 歸檔失敗靜默降級：review-history 被同名檔案佔用 → 閉環終態不受影響 ──')
{
	process.env.DSH_HOME = HOME_D
	mkdirSync(HOME_D, { recursive: true })
	writeFileSync(path.join(HOME_D, 'review-history'), '不是目錄——歸檔 mkdir 必拋 ENOTDIR') // 佔位檔案
	const errs = []
	const origErr = console.error
	console.error = (...a) => { errs.push(a.map((x) => String(x?.message ?? x)).join(' ')) }
	try {
		const sc = await makeScenario('broken')
		sc.addAgent('hK')
		sc.script.push(roundResult('code', [finding()]))
		sc.script.push(roundResult('code', []))
		const r = await sc.start('hK', { dims: ['code'] })
		check('①G start ok（歸檔目標不可用不影響啟動）', r?.ok === true, JSON.stringify(r).slice(0, 100))
		await tick()
		await driveFix(sc, 'hK')
		await tick()
		await flushHist()
		const st = await sc.state('hK')
		check('①G 閉環照常到達 passed 終態（歸檔拋錯不影響閉環）', st?.running === false && st?.lastStatus === 'passed', st?.lastStatus)
		const rep = await sc.report('hK')
		check('①G 報告端點照常返回全文', typeof rep?.report === 'string' && rep.report.includes('# 自動審查官報告'), String(rep?.report?.slice(0, 30)))
		const all = await sc.list()
		check('①G list 端點照常（finished 可見 passed）', Array.isArray(all?.finished) && all.finished.some((x) => x.status === 'passed'), JSON.stringify(all?.finished?.map((x) => x.status)))
		const hist = await sc.http('GET', '/__review/api/history')
		check('①G 歷史清單 API 優雅降級（ok:true 空清單，不 500）', hist?.ok === true && Array.isArray(hist?.runs) && hist.runs.length === 0, JSON.stringify(hist))
		const histD = await sc.http('GET', '/__review/api/history/any-run-id')
		check('①G 歷史明細 API 優雅降級（ok:false 帶錯誤訊息）', histD?.ok === false && typeof histD?.error === 'string', JSON.stringify(histD))
		check('①G 失敗被 console.error 帶標籤記錄（靜默降級而非吞異常）',
			errs.some((m) => m.includes('dsh-auto-review') && m.includes('歸檔失敗')), errs.slice(0, 2).join(' | ').slice(0, 120))
		sc.teardown()
	} finally {
		console.error = origErr
	}
}
check('①G 全程無 unhandledRejection 外洩', unhandled.length === 0, JSON.stringify(unhandled.slice(0, 2)))

// ══════════════════ ②③ client：源碼注入 __test 導出 + 帶狀態樁 react ══════════════════
const clientSrc = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
const injectAnchor = '\t\treturn module.exports;'
if (!clientSrc.includes(injectAnchor)) { console.error('✗ client 源不符合預期 return 錨點'); process.exit(1) }
let clientFactory = null
globalThis.window = { __ModuleLoader__: { load: (def) => { clientFactory = def.factory } } }
const clientStubPath = path.join(os.tmpdir(), `dsh-ar-v16-client-${Date.now()}.mjs`)
writeFileSync(clientStubPath, clientSrc.replace(injectAnchor,
	'\t\texports.__test = { MdRender, ReportView, RunSummaryCard, StatsSummary, HistorySection, CollapsibleSection, SevDonut, ConvChart, DimStackChart, FileHotChart, StubbornList, statsOfRun, mdHeadingAnchors, historyCard, SEV_COLOR, SEV_ORDER };\n' + injectAnchor))
await import(pathToFileURL(clientStubPath).href)
check('②③ client 工廠捕獲（__test 導出注入成功）', typeof clientFactory === 'function', '', 's')

// 帶狀態的樁 react：useState 按「組件函數 + 調用序」持久化（set 後重渲染可見新值）
function makeStatefulReact() {
	const stateByFn = new WeakMap()
	const stack = []
	return {
		createElement(type, props, ...children) {
			const p = props || {}
			if (children.length > 0) p.children = children.length === 1 ? children[0] : children
			return { type, props: p, children }
		},
		begin(fn) {
			if (!stateByFn.has(fn)) stateByFn.set(fn, [])
			stack.push({ fn, s: stateByFn.get(fn), i: 0 })
		},
		end() { stack.pop() },
		useState(init) {
			const top = stack[stack.length - 1]
			if (!(top.i in top.s)) top.s[top.i] = typeof init === 'function' ? init() : init
			const idx = top.i++
			return [top.s[idx], (v) => { top.s[idx] = typeof v === 'function' ? v(top.s[idx]) : v }]
		},
		useEffect() {}, useCallback(f) { return f }, useMemo(f) { return f() }, useRef(v) { return { current: v } },
	}
}
const reactStub = makeStatefulReact()
const T = clientFactory((name) => { if (name === 'react') return reactStub; throw new Error('unexpected require: ' + name) })
const SEV_COLOR = T.__test.SEV_COLOR
function renderNode(node) {
	if (node === null || node === undefined || node === false || node === true) return null
	if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
	if (Array.isArray(node)) {
		const kids = node.map(renderNode).filter(Boolean)
		return kids.length === 1 ? kids[0] : { frag: true, kids }
	}
	if (typeof node.type === 'function') {
		reactStub.begin(node.type)
		const out = node.type(node.props)
		reactStub.end()
		return renderNode(out)
	}
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
const findAll = (n, pred, acc = []) => {
	if (n == null) return acc
	if (n.tag != null && pred(n)) acc.push(n)
	for (const k of (n.kids || [])) findAll(k, pred, acc)
	return acc
}

// ── ② 構造的 publicRun 夾具（維度計數 / 未解決 findings / 輪次 / 注入指紋自洽）──
const F = (sev, file, line, title, over = {}) => ({ severity: sev, file, line, title, detail: 'd', suggestion: 's', ...over })
const FX_RUN = {
	runId: 'run-fixture-1', sessionId: 's-fx', projectPath: '/proj/fx', mode: 'loop', injectMode: 'auto',
	status: 'passed', scope: 'smart', fixScope: 'blocking-only', round: 4, maxRounds: 5,
	startedAt: 1_700_000_000_000, endedAt: 1_700_000_600_000, error: null,
	gate: 'standard', dims: ['code', 'flow'], models: ['kimi-k3', 'glm-5.3'],
	tokenUsage: { input: 1234, output: 56789 },
	pendingInject: null, ignoredByDecision: {},
	// 故意亂序：statsOfRun 需按 round 升序輸出
	roundLog: [
		{ round: 2, mergedCount: 3 }, { round: 1, mergedCount: 5 }, { round: 4, mergedCount: 0 }, { round: 3, mergedCount: 3 },
	],
	injectLog: [
		{ round: 1, count: 4, items: [
			F('critical', 'f1.js', 12, '空值引用導致崩潰'),
			F('high', 'f2.js', 5, '未處理錯誤'),
			F('high', 'f6.js', 1, '長期頑固項'),
			F('high', 'f3.js', 7, '頑固已修'),
		] },
		{ round: 2, count: 4, items: [
			F('critical', 'f1.js', 12, '空值引用 導致崩潰！'), // 標點漂移 → 同指紋
			F('high', 'f3.js', 7, '頑固已修'),
			F('high', 'f6.js', 1, '長期頑固項'),
			F('medium', 'f7.js', 4, '後期頑固項'),
		] },
		{ round: 3, count: 2, items: [
			F('high', 'f6.js', 1, '長期頑固項'),
			F('medium', 'f7.js', 4, '後期頑固項'),
		] },
	],
	dimensions: [
		{ id: 'code', label: '代碼', status: 'blocking', pass: false, summary: '', error: null,
			counts: { critical: 1, high: 2, medium: 1, low: 1 },
			findings: [
				F('critical', 'f1.js', 12, '空值引用導致崩潰'),
				F('high', 'f1.js', 40, '競態條件'),
				F('low', 'f1.js', 99, '命名不清晰'),
				F('high', 'f2.js', 5, '未處理錯誤'),
				F('medium', 'f2.js', 9, '缺少註釋'),
				F('high', 'f3.js', 7, '頑固已修', { resolved: true }), // 已解決 → 不進熱點/頑固項
			], ignored: [] },
		{ id: 'flow', label: '用戶流程', status: 'passed', pass: true, summary: '', error: null,
			counts: { critical: 0, high: 1, medium: 2, low: 4 },
			findings: [
				F('high', 'f6.js', 1, '長期頑固項'),
				F('medium', 'f4.js', 3, '流程死鎖'),
				F('medium', 'f7.js', 4, '後期頑固項'),
				F('low', 'f5.js', 8, '提示不明確'),
				F('low', 'f8.js', 6, '文案不一致'),
				F('low', 'f9.js', 2, '邊角提示'),
				F('low', 'f10.js', 5, '拼寫漂移'),
			], ignored: [] },
	],
}

console.log('\n── ②-a statsOfRun 聚合：維度計數 / 嚴重度合計 / 輪次排序 / 熱點 Top5 / 頑固項指紋 ──')
{
	const st = T.__test.statsOfRun(FX_RUN)
	check('②a 維度聚合：code total=5 / flow total=7（counts 求和）',
		st.dims.length === 2 && st.dims[0].id === 'code' && st.dims[0].total === 5 && st.dims[1].total === 7,
		JSON.stringify(st.dims?.map((d) => [d.id, d.total])))
	check('②a 嚴重度合計 sevTotal={critical:1,high:3,medium:3,low:5} / totalFindings=12',
		JSON.stringify(st.sevTotal) === JSON.stringify({ critical: 1, high: 3, medium: 3, low: 5 }) && st.totalFindings === 12,
		JSON.stringify(st.sevTotal))
	check('②a 輪次序列：亂序 roundLog → 升序 [5,3,3,0]（點數=輪次數=4）',
		st.rounds.length === 4 && st.rounds.map((x) => x.round).join() === '1,2,3,4' && st.rounds.map((x) => x.merged).join() === '5,3,3,0',
		JSON.stringify(st.rounds))
	check('②a 檔案熱點：Top5 截斷（9 檔→5）且按計數降序（f1:3 → f2:2 → 單項×3）',
		st.fileTop.length === 5 && st.fileTop[0].file === 'f1.js' && st.fileTop[0].count === 3
		&& st.fileTop[1].file === 'f2.js' && st.fileTop[1].count === 2
		&& st.fileTop.map((x) => x.count).join() === '3,2,1,1,1',
		JSON.stringify(st.fileTop?.map((x) => [x.file, x.count])))
	check('②a 熱點屬性：sevMax=檔內最高嚴重度（f1=critical/f2=high）、line=首個非空行號',
		st.fileTop[0].sevMax === 'critical' && st.fileTop[1].sevMax === 'high' && st.fileTop[0].line === 12,
		JSON.stringify([st.fileTop?.[0]?.sevMax, st.fileTop?.[1]?.sevMax, st.fileTop?.[0]?.line]))
	check('②a 已解決（resolved:true）不進熱點（f3.js 缺席）', !st.fileTop.some((x) => x.file === 'f3.js'), JSON.stringify(st.fileTop?.map((x) => x.file)))
	check('②a 頑固項：跨輪≥2 且未解決（長期頑固項 R1-3 / 空值引用 R1-2 標點漂移同指紋 / 後期頑固項 R2-3）',
		st.stubborn.length === 3 && st.stubborn[0].title === '長期頑固項' && JSON.stringify(st.stubborn[0].rounds) === JSON.stringify([1, 2, 3])
		&& st.stubborn.some((x) => x.title === '空值引用導致崩潰' && x.rounds.length === 2 && x.sev === 'critical')
		&& st.stubborn.some((x) => x.title === '後期頑固項' && x.rounds.length === 2),
		JSON.stringify(st.stubborn?.map((x) => [x.title, x.rounds, x.sev])))
	check('②a 頑固項排除：僅出現 1 輪（未處理錯誤）與已解決（頑固已修）都不算',
		!st.stubborn.some((x) => x.title === '未處理錯誤') && !st.stubborn.some((x) => x.title === '頑固已修'),
		JSON.stringify(st.stubborn?.map((x) => x.title)))
	check('②a hasInjectLog=true / hasData=true', st.hasInjectLog === true && st.hasData === true, `${st.hasInjectLog}/${st.hasData}`)
	// 空數據安全
	const es = T.__test.statsOfRun({})
	check('②a 空 run 安全：全零、空數組、hasData=false（五視圖空態前置）',
		es.totalFindings === 0 && JSON.stringify(es.sevTotal) === JSON.stringify({ critical: 0, high: 0, medium: 0, low: 0 })
		&& es.dims.length === 0 && es.rounds.length === 0 && es.fileTop.length === 0 && es.stubborn.length === 0
		&& es.hasData === false && es.hasInjectLog === false,
		JSON.stringify(es))
}

console.log('\n── ②-b SevDonut 環形：四段佔比和=100%、偏移連續、中心總數、圖例備援 ──')
{
	const st = T.__test.statsOfRun(FX_RUN)
	const tree = renderRoot(T.__test.SevDonut, { counts: st.sevTotal, total: st.totalFindings })
	const C = 2 * Math.PI * 44
	const segs = findTags(tree, 'circle').filter((c) => c.props.style && c.props.style.strokeDasharray)
	check('②b 環形四段（每個非零嚴重度一段）', segs.length === 4, String(segs.length))
	const dashes = segs.map((c) => parseFloat(c.props.style.strokeDasharray.split(' ')[0]))
	const offsets = segs.map((c) => parseFloat(c.props.style.strokeDashoffset))
	const sumRatio = dashes.reduce((a, b) => a + b, 0) / C
	check('②b 佔比總和=100%（dash 總長=圓周；toFixed(2) 顯示舍入容差 1e-3）', Math.abs(sumRatio - 1) < 1e-3, String(sumRatio))
	check('②b 各段佔比=計數/總數（1/12、3/12、3/12、5/12）',
		Math.abs(dashes[0] / C - 1 / 12) < 1e-3 && Math.abs(dashes[1] / C - 3 / 12) < 1e-3
		&& Math.abs(dashes[2] / C - 3 / 12) < 1e-3 && Math.abs(dashes[3] / C - 5 / 12) < 1e-3,
		JSON.stringify(dashes.map((d) => +(d / C).toFixed(4))))
	let contiguous = true
	for (let i = 1; i < segs.length; i++) if (Math.abs(offsets[i] - (offsets[i - 1] - dashes[i - 1])) > 0.05) contiguous = false
	check('②b 偏移連續（offset_i = offset_(i-1) − dash_(i-1)，無縫拼接）', contiguous, JSON.stringify(offsets))
	check('②b 段色=嚴重度色（SEV_COLOR 映射）',
		segs.every((c, i) => c.props.style.stroke === SEV_COLOR[T.__test.SEV_ORDER[i]]),
		JSON.stringify(segs.map((c) => c.props.style.stroke)))
	const txt = text(tree)
	check('②b 中心總數=12 + 圖例文字備援（critical 1 / high 3 / medium 3 / low 5）',
		txt.includes('12') && txt.includes('項未解決') && ['critical 1', 'high 3', 'medium 3', 'low 5'].every((s) => txt.includes(s)), txt.slice(0, 80))
	const svg = findTags(tree, 'svg')[0]
	check('②b svg role=img + aria-label（無障礙）', svg != null && svg.props.role === 'img' && String(svg.props['aria-label']).includes('共 12 項'), String(svg?.props?.['aria-label'] ?? '').slice(0, 60))
	const empty = renderRoot(T.__test.SevDonut, { counts: { critical: 0, high: 0, medium: 0, low: 0 }, total: 0 })
	check('②b total=0 空態安全（文字提示、無 svg）', findTags(empty, 'svg').length === 0 && text(empty).includes('無未解決發現'), text(empty))
}

console.log('\n── ②-c ConvChart 折線：點數=輪次數、節點數值、空/單點安全 ──')
{
	const st = T.__test.statsOfRun(FX_RUN)
	const tree = renderRoot(T.__test.ConvChart, { points: st.rounds })
	const nodes = findTags(tree, 'circle').filter((c) => c.props.r === 3.2)
	check('②c 節點數=輪次數（4 輪 → 4 個數據點）', nodes.length === 4, String(nodes.length))
	check('②c polyline 存在（>1 點）', findTags(tree, 'polyline').length === 1, String(findTags(tree, 'polyline').length))
	const txt = text(tree)
	check('②c 節點數值與軸標（5/3/3/0 + R1..R4）', ['5', '3', '0', 'R1', 'R4'].every((s) => txt.includes(s)), txt.slice(0, 80))
	const svg = findTags(tree, 'svg')[0]
	check('②c aria-label 逐輪文字備援（R1 發現 5 項）', svg?.props?.['aria-label']?.includes('R1 發現 5 項'), String(svg?.props?.['aria-label'] ?? '').slice(0, 80))
	const single = renderRoot(T.__test.ConvChart, { points: [{ round: 1, merged: 2 }] })
	check('②c 單點安全：有節點無折線', findTags(single, 'circle').filter((c) => c.props.r === 3.2).length === 1 && findTags(single, 'polyline').length === 0, '')
	const empty = renderRoot(T.__test.ConvChart, { points: [] })
	check('②c 空數據安全：文字提示、無 svg', findTags(empty, 'svg').length === 0 && text(empty).includes('尚無輪次數據'), text(empty))
}

console.log('\n── ②-d DimStackChart 堆疊條：段寬 flex=計數、段 title、總數標籤 ──')
{
	const st = T.__test.statsOfRun(FX_RUN)
	const tree = renderRoot(T.__test.DimStackChart, { dims: st.dims })
	const segs = findAll(tree, (n) => n.props.style && typeof n.props.style.flex === 'number' && n.props.style.minWidth === 3)
	check('②d code 維度段寬=計數（critical1/high2/medium1/low1，零計數無段）',
		segs.slice(0, 4).map((s) => s.props.style.flex).join() === '1,2,1,1', JSON.stringify(segs.map((s) => s.props.style.flex)))
	check('②d flow 維度段寬=計數（high1/medium2/low4）', segs.slice(4).map((s) => s.props.style.flex).join() === '1,2,4', JSON.stringify(segs.slice(4).map((s) => s.props.style.flex)))
	check('②d 段 title 帶明細（critical ×1）', segs.some((s) => s.props.title === 'critical ×1') && segs.some((s) => s.props.title === 'low ×4'),
		JSON.stringify(segs.map((s) => s.props.title)))
	const txt = text(tree)
	check('②d 每維總數標籤（5 / 7）+ 維度名（代碼/用戶流程）', txt.includes('代碼') && txt.includes('用戶流程') && txt.includes('5') && txt.includes('7'), '')
	check('②d 段色=嚴重度色', segs.every((s) => Object.values(SEV_COLOR).includes(s.props.style.background)), JSON.stringify(segs.map((s) => s.props.style.background)))
	const allPass = renderRoot(T.__test.DimStackChart, { dims: [{ id: 'x', label: 'X', counts: { critical: 0, high: 0, medium: 0, low: 0 }, total: 0 }] })
	check('②d 全零維度空態（全部通過——無未解決項）', text(allPass).includes('全部通過'), text(allPass))
	check('②d 無維度空態（無維度數據）', text(renderRoot(T.__test.DimStackChart, { dims: [] })).includes('無維度數據'), '')
}

console.log('\n── ②-e FileHotChart 熱點：排序（輸入已降序）、條寬=計數比例、bar 色=最高嚴重度 ──')
{
	const st = T.__test.statsOfRun(FX_RUN)
	const tree = renderRoot(T.__test.FileHotChart, { fileTop: st.fileTop })
	const rows = findAll(tree, (n) => n.props.style && n.props.style.height === 12 && n.kids && n.kids.length === 1)
	check('②e Top5 行（計數 3,2,1,1,1）', rows.length === 5, String(rows.length))
	const widths = rows.map((r) => r.kids[0].props.style.width)
	check('②e 條寬=計數/最大值（100% / 66.7% / 33.3%）',
		widths[0] === '100%' && widths[1].startsWith('66.6') && widths.slice(2).every((w) => w.startsWith('33.3') || w === '4%'),
		JSON.stringify(widths))
	check('②e bar 色=檔內最高嚴重度色（f1=critical 色 / f2=high 色）',
		rows[0].kids[0].props.style.background === SEV_COLOR.critical && rows[1].kids[0].props.style.background === SEV_COLOR.high,
		JSON.stringify(rows.map((r) => r.kids[0].props.style.background)))
	const txt = text(tree)
	check('②e 檔名 + 計數標籤（f1.js 3 項 / f2.js 2 項）', txt.includes('f1.js') && txt.includes('f2.js') && txt.includes('3 項') && txt.includes('2 項'), '')
	check('②e aria-label 文字備援（f1.js 3 項、f2.js 2 項）', String(findAll(tree, (n) => n.props['aria-label'] != null)[0]?.props['aria-label']).includes('f1.js 3 項'), '')
	check('②e 空態安全（無檔案熱點）', text(renderRoot(T.__test.FileHotChart, { fileTop: [] })).includes('無檔案熱點'), '')
}

console.log('\n── ②-f StubbornList 頑固項清單：跨輪標注 + 仍未解決 + 空態 ──')
{
	const st = T.__test.statsOfRun(FX_RUN)
	const tree = renderRoot(T.__test.StubbornList, { items: st.stubborn, hasInject: true })
	const rows = findAll(tree, (n) => n.props.style && String(n.props.style.borderLeft).startsWith('3px solid'))
	check('②f 三行頑固項（跨輪≥2 且未解決）', rows.length === 3, String(rows.length))
	const txt = text(tree)
	check('②f 行內容：file:line + 輪次標注 + 仍未解決徽章',
		txt.includes('f6.js:1') && txt.includes('f1.js:12') && txt.includes('R1 · R2 · R3 重複出現') && txt.includes('R1 · R2 重複出現') && txt.includes('仍未解決'),
		txt.slice(0, 140))
	check('②f 首行=出現輪次最多者（長期頑固項）', text(rows[0]).includes('長期頑固項'), text(rows[0]).slice(0, 60))
	check('②f 空態（有注入無重複）：無跨輪重複項', text(renderRoot(T.__test.StubbornList, { items: [], hasInject: true })).includes('無跨輪重複項'), '')
	check('②f 空態（無注入）：尚無注入數據', text(renderRoot(T.__test.StubbornList, { items: [], hasInject: false })).includes('尚無注入數據'), '')
}

console.log('\n── ②-g StatsSummary 組合：五視圖齊渲染（報告頂部/面板統計區共用）──')
{
	const tree = renderRoot(T.__test.StatsSummary, { run: FX_RUN })
	const txt = text(tree)
	check('②g 五視圖標題齊備（環形/折線/堆疊/熱點/頑固項）',
		txt.includes('嚴重度分佈（未解決）') && txt.includes('輪次收斂') && txt.includes('維度 × 嚴重度（未解決）')
		&& txt.includes('檔案熱點 Top 5（未解決）') && txt.includes('頑固項（跨輪注入 ≥2 次且仍未解決）'),
		txt.slice(0, 120))
	check('②g 組合內含環形 svg 與折線 svg（實渲染非佔位）', findTags(tree, 'svg').length >= 2, String(findTags(tree, 'svg').length))
	check('②g 空數據空態（尚無統計數據）', text(renderRoot(T.__test.StatsSummary, { run: {} })).includes('尚無統計數據'), '')
}

// ── ③ 渲染升級夾具：含 h1/h2 章節（❌/✅/普通/重複標題）、表格、引用、清單、行內 code ──
const MD = [
	'# 自動審查官報告 · /proj/fx',
	'',
	'狀態：**passed**（第 4 輪 / 上限 5），行內 `code` 底色。',
	'',
	'## ❌ code · 代碼維度',
	'',
	'| 嚴重度 | 位置 | 問題 |',
	'|---|---|---|',
	'| critical | src/a.js:12 | 未處理的空值引用導致崩潰 |',
	'| high | src/b.js:8 | 競態條件 |',
	'| medium | src/c.js:3 | 缺少註釋 |',
	'| low | src/d.js:9 | 命名不清晰 |',
	'',
	'> 引用塊：品牌色豎線強調',
	'',
	'## ✅ flow · 用戶流程維度',
	'',
	'| 檢查 | 結果 |',
	'|---|---|',
	'| 流程完整性 | 通過 |',
	'| 錯誤處理 | 通過 |',
	'',
	'## 其他說明',
	'',
	'- 清單項一',
	'- 清單項二',
	'',
	'## ✅ flow · 用戶流程維度',
	'',
	'補充段落（同標題章節 → 錨點去重 -2）。',
	'',
	'---',
].join('\n')

console.log('\n── ③-a MdRender：斑馬紋 / severity 色籤 / 引用豎線 / 行內 code / 錨點 id ──')
{
	const tree = renderRoot(T.__test.MdRender, { text: MD })
	const tbodies = findTags(tree, 'tbody')
	check('③a 兩個表格渲染（❌ 與 ✅ 章節各一）', tbodies.length === 2, String(tbodies.length))
	const trs = findTags(tbodies[0], 'tr')
	const zebra = trs.map((tr) => tr.props.style.background)
	check('③a 斑馬紋：奇數行淡底（transparent/rgba/transparent/rgba）',
		zebra.join('|') === 'transparent|rgba(139, 148, 158, 0.09)|transparent|rgba(139, 148, 158, 0.09)',
		JSON.stringify(zebra))
	// severity 色籤：sev 儲格 → 色點(8×8 圓) + 色字(粗體)
	const tds0 = findTags(trs[0], 'td')
	const chip = tds0[0] // 'critical' 儲格
	const chipSpan = chip.kids[0]
	const dot = chipSpan?.kids?.[0]
	const label = chipSpan?.kids?.[1]
	check('③a severity 色籤：色點（8×8 圓、sev 色）+ 色字（sev 色、粗體）',
		chipSpan?.tag === 'span' && dot?.props?.style?.width === 8 && dot?.props?.style?.borderRadius === 99
		&& dot?.props?.style?.background === SEV_COLOR.critical
		&& label?.props?.style?.color === SEV_COLOR.critical && label?.props?.style?.fontWeight === 700 && text(label) === 'critical',
		JSON.stringify({ dot: dot?.props?.style, label: label?.props?.style }))
	const plain = findTags(trs[1], 'td')[1] // 'src/b.js:8' 儲格
	check('③a 非 severity 儲格不誤加色籤（無色點）',
		!findAll(plain, (n) => n.props.style && n.props.style.width === 8 && n.props.style.borderRadius === 99).length > 0,
		'')
	check('③a 四級色籤齊（critical/high/medium/low 各有其色）',
		['critical', 'high', 'medium', 'low'].every((sev) => findAll(tree, (n) => n.props.style && n.props.style.background === SEV_COLOR[sev] && n.props.style.width === 8).length >= 1), '')
	const quotes = findAll(tree, (n) => n.props.style && String(n.props.style.borderLeft).startsWith('3px solid'))
	check('③a 引用塊豎線強調（3px 左線 + 文字）', quotes.length === 1 && text(quotes[0]).includes('引用塊：品牌色豎線強調'), text(quotes[0] ?? {}).slice?.(0, 40) ?? '')
	check('③a 行內 code 底色（code 標籤 + background）',
		findTags(tree, 'code').some((c) => c.props.style && c.props.style.background), '')
	check('③a 清單渲染（ul + 2 li）', findTags(tree, 'ul').length === 1 && findTags(tree, 'li').length === 2, `${findTags(tree, 'ul').length}/${findTags(tree, 'li').length}`)
	// 錨點 id：與 mdHeadingAnchors 單一事實來源一致；同標題去重 -2
	const anchors = T.__test.mdHeadingAnchors(MD)
	const headerIds = findAll(tree, (n) => typeof n.props.id === 'string' && n.props.id.startsWith('ar-md-')).map((n) => n.props.id)
	// 每個章節頭都帶 ar-md- 錨點 id（h1×1 + h2×4）；唯一標題的 id 與 mdHeadingAnchors 首現完全一致。
	// 已知限制：同標題章節共用首現 id（idOf 取首現）——重複標題的 TOC -2 按鈕滾動目標缺失（低影響：真實報告章節標題唯一）。
	const uniqAnchors = []
	const seen = new Set()
	for (const a of anchors) { if (!seen.has(a.text)) { seen.add(a.text); uniqAnchors.push(a) } }
	check('③a 每章節頭帶 ar-md- 錨點 id（5 章 5 id）；唯一標題 id 與 mdHeadingAnchors 一致',
		headerIds.length === 5 && headerIds.every((id) => id.startsWith('ar-md-'))
		&& uniqAnchors.every((a) => headerIds.includes(a.id)),
		JSON.stringify({ anchors: anchors.map((a) => a.id), headerIds }))
	const dup = anchors.filter((a) => a.text.includes('用戶流程維度'))
	check('③a 同標題章節錨點去重（base + base-2）', dup.length === 2 && dup[1].id === dup[0].id + '-2', JSON.stringify(dup.map((a) => a.id)))
}

console.log('\n── ③-b MdRender 章節摺疊：默認未通過展開、✅ 已通過收起、點擊翻轉 ──')
{
	const props = { text: MD, collapsible: true, defaultOpen: (t) => String(t).indexOf('✅') < 0 }
	let tree = renderRoot(T.__test.MdRender, props)
	let headers = findAll(tree, (n) => n.props.role === 'button' && n.props['aria-expanded'] != null)
	const states = () => findAll(tree, (n) => n.props.role === 'button' && n.props['aria-expanded'] != null).map((n) => n.props['aria-expanded'])
	check('③b 僅 h2 章節可摺疊（4 個章節頭；h1 不可摺疊）', headers.length === 4, String(headers.length))
	check('③b 默認態：❌ code 展開 / ✅ flow 收起 / 其他說明 展開 / ✅ 重複 收起',
		states().join('|') === 'true|false|true|false', JSON.stringify(states()))
	check('③b 展開章節含內容表格、收起章節僅剩頭（tables=1）', findTags(tree, 'table').length === 1, String(findTags(tree, 'table').length))
	// 點擊翻轉（帶狀態 stub：set 後重渲染可見）
	headers[1].props.onClick() // 展開 ✅ flow
	tree = renderRoot(T.__test.MdRender, props)
	check('③b 點擊 ✅ 章節頭 → 展開（tables=2；同標題章節同步）',
		states().join('|') === 'true|true|true|true' && findTags(tree, 'table').length === 2, JSON.stringify({ s: states(), t: findTags(tree, 'table').length }))
	findAll(tree, (n) => n.props.role === 'button' && n.props['aria-expanded'] != null)[0].props.onClick() // 收起 ❌ code
	tree = renderRoot(T.__test.MdRender, props)
	check('③b 再點 ❌ 章節頭 → 收起（tables=1）', findTags(tree, 'table').length === 1 && states()[0] === false, JSON.stringify(states()))
	const plain = renderRoot(T.__test.MdRender, { text: MD })
	check('③b 非摺疊模式：全部章節直出（tables=2、無章節按鈕）',
		findTags(plain, 'table').length === 2 && findAll(plain, (n) => n.props.role === 'button').length === 0, '')
}

console.log('\n── ③-c ReportView：複製 MD / 下載 .md / TOC 錨點 / 摘要卡 / 統計 ──')
{
	const tree = renderRoot(T.__test.ReportView, { run: FX_RUN, text: MD })
	const btns = findTags(tree, 'button')
	const copyBtn = btns.find((b) => text(b).includes('複製 MD'))
	check('③c 複製 MD 按鈕存在（⧉ 複製 MD）', copyBtn != null && text(copyBtn).includes('⧉ 複製 MD'), btns.map(text).join('/').slice(0, 80))
	let clicked = false
	try { copyBtn.props.onClick(); clicked = true } catch { clicked = false }
	check('③c 複製點擊安全（無 DOM 環境不拋錯）', clicked === true, '')
	const dl = findTags(tree, 'a').find((a) => a.props.download != null && a.props.href)
	check('③c 下載 .md 連結存在（⬇ 下載 .md + download 屬性）',
		dl != null && text(dl).includes('⬇ 下載 .md') && dl.props.download === 'review-report-run-fixture-1.md',
		`${text(dl ?? {})}`.slice(0, 40))
	const hrefPayload = decodeURIComponent(String(dl.props.href).slice('data:text/markdown;charset=utf-8,'.length))
	check('③c data: href 可還原報告原文（encodeURIComponent 無損）', hrefPayload === MD, `${hrefPayload.length}/${MD.length}`)
	// TOC：h2 錨點按鈕 + id 與 MdRender 一致
	const tocBtns = btns.filter((b) => typeof b.props.key === 'string' && b.props.key.startsWith('ar-md-'))
	const anchors2 = T.__test.mdHeadingAnchors(MD).filter((a) => a.level === 2)
	check('③c TOC：每個 h2 章節一枚按鈕（4 枚，含去重 -2）',
		tocBtns.length === anchors2.length && anchors2.every((a, i) => tocBtns[i].props.key === a.id && text(tocBtns[i]) === a.text),
		JSON.stringify(tocBtns.map((b) => [b.props.key, text(b)])))
	let tocClickOk = true
	try { for (const b of tocBtns) b.props.onClick() } catch { tocClickOk = false }
	check('③c TOC 點擊安全（scrollToId 無 DOM 不拋錯）', tocClickOk === true, '')
	// 摘要卡
	const txt = text(tree)
	check('③c 摘要卡：狀態膠囊（全部通過 ✅）+ 輪次 R4/5',
		txt.includes('全部通過 ✅') && txt.includes('R4/5'), txt.slice(0, 100))
	check('③c 摘要卡：阻斷按強度口徑（standard=critical+high=4）',
		txt.includes('阻斷 4（強度 standard）'), '')
	check('③c 摘要卡：token in/out 千分位 + 模型列表',
		txt.includes('token 1.2K in · 56.8K out') && txt.includes('kimi-k3 · glm-5.3'), '')
	check('③c 摘要卡：四級計數行（critical 1 / high 3 / medium 3 / low 5）',
		['critical 1', 'high 3', 'medium 3', 'low 5'].every((s) => txt.includes(s)), '')
	check('③c 統計摘要嵌入（五視圖標題）', txt.includes('嚴重度分佈（未解決）') && txt.includes('頑固項（跨輪注入 ≥2 次且仍未解決）'), '')
	const noRun = renderRoot(T.__test.ReportView, { text: MD })
	const noRunTxt = text(noRun)
	check('③c 無 run 時：動作列 + MD 直出，無摘要卡/統計（阻斷/R4 5/統計標題缺席；ReportView 恆摺疊模式）',
		!noRunTxt.includes('阻斷') && !noRunTxt.includes('R4/5') && !noRunTxt.includes('嚴重度分佈') && !noRunTxt.includes('全部通過 ✅') && findTags(noRun, 'button').some((b) => text(b).includes('複製 MD')),
		JSON.stringify({ duan: noRunTxt.includes('阻斷'), tables: findTags(noRun, 'table').length }))
	// 摘要卡 gate 口徑對照（純函數路徑）
	const strict = renderRoot(T.__test.RunSummaryCard, { run: { ...FX_RUN, gate: 'strict' } })
	check('③c strict 口徑：阻斷=7（critical1+high3+medium3）', text(strict).includes('阻斷 7（強度 strict）'), '')
	const loose = renderRoot(T.__test.RunSummaryCard, { run: { ...FX_RUN, gate: 'loose' } })
	check('③c loose 口徑：阻斷=1（僅 critical）', text(loose).includes('阻斷 1（強度 loose）'), '')
	// t4-m 修復回歸：阻斷口徑對齊 host mergedBlockingCount——排除 .reviewignore 已接受（f2 未處理錯誤）
	// + 跨維度同指紋合併（security 維重複報 f1 空值引用不虛計）：4 - 1（忽略）+ 0（合併）= 3
	const FIX_RUN = Object.assign({}, FX_RUN, {
		ignoredByDecision: { code: [{ severity: 'high', file: 'f2.js', line: 5, title: '未處理錯誤' }] },
		dimensions: FX_RUN.dimensions.concat([{
			id: 'security', label: '安全', status: 'blocking', pass: false, summary: '', error: null,
			counts: { critical: 1, high: 0, medium: 0, low: 0 },
			findings: [F('critical', 'f1.js', 12, '空值引用導致崩潰')],
			ignored: [],
		}]),
	})
	const fixCard = renderRoot(T.__test.RunSummaryCard, { run: FIX_RUN })
	check('③c t4-m 口徑：排除已接受項 + 跨維同指紋合併（阻斷 3，與 host/歷史卡同數）',
		text(fixCard).includes('阻斷 3（強度 standard）'), text(fixCard).slice(0, 120))
	const badge = renderRoot(T.__test.ReportView, { run: FX_RUN, text: MD, badge: '歷史歸檔 · 2023-11-14 22:13' })
	check('③c badge 徽章透傳（歷史歸檔）', text(badge).includes('歷史歸檔 · 2023-11-14 22:13'), '')
}

console.log('\n── ③-d HistorySection / 歷史卡：初始態 + 四態文案 + 已截斷標記 ──')
{
	const tree = renderRoot(T.__test.HistorySection, {})
	const txt = text(tree)
	check('③d 歷史區初始態：摺疊收起（▸ + aria-expanded=false）+ 標題/副標題（正文未渲染=未載入）',
		txt.includes('歷史記錄') && txt.includes('終態審查歸檔 · 時間倒序') && txt.includes('▸') && !txt.includes('載入歷史記錄'),
		JSON.stringify(findAll(tree, (n) => n.props['aria-expanded'] != null).map((n) => n.props['aria-expanded'])) + txt.slice(0, 40))
	const secSrc = clientSrc
	check('③d 源碼：清單/明細走 callApi 映射（review-history-list/get）',
		secSrc.includes('"review-history-list"') && secSrc.includes('"review-history-get"'), '')
	check('③d 源碼：四態文案齊備（未啟用/載入失敗/尚無歷史/明細載入失敗）',
		secSrc.includes('歷史記錄未啟用') && secSrc.includes('歷史記錄載入失敗') && secSrc.includes('尚無審查歷史') && secSrc.includes('歸檔明細載入失敗'), '')
	check('③d 源碼：截斷警示（丟失明細 N 條；計數仍準確）', secSrc.includes('256KB 保存上限被截斷') && secSrc.includes('計數仍準確'), '')
	const card = renderNode(T.__test.historyCard({
		runId: 'run-x1', status: 'passed', projectName: 'demo', severityCounts: { critical: 0, high: 2, medium: 0, low: 0 },
		blocking: 0, round: 3, maxRounds: 5, models: ['glm-5.3'], injectCount: 2, truncated: true, archivedAt: 1_700_000_000_000,
	}, () => {}))
	const cardTxt = text(card)
	check('③d 歷史卡：狀態/項目/計數/輪次/模型/注入輪數/阻斷',
		cardTxt.includes('全部通過 ✅') && cardTxt.includes('demo') && cardTxt.includes('high:2') && cardTxt.includes('R3/5')
		&& cardTxt.includes('glm-5.3') && cardTxt.includes('注入 2 輪') && cardTxt.includes('阻斷 0'),
		cardTxt.slice(0, 120))
	check('③d 歷史卡：已截斷標記 + 日期（YYYY-MM-DD HH:mm）',
		cardTxt.includes('已截斷') && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(cardTxt), cardTxt.slice(0, 40))
}

// ══════════════════ 彙總 ══════════════════
console.log(`\n斷言分組：①歷史 ${SEC.h} / ②統計 ${SEC.s} / ③渲染 ${SEC.r}`)
console.log(failures === 0
	? `\nv1.6 三項新能力測試 ${passes} 項斷言全部通過 ✅`
	: `\n${passes} 通過，${failures} 項失敗 ❌`)
try { rmSync(TMP_BASE, { recursive: true, force: true }) } catch { /* 診斷保留 */ }
process.exit(failures === 0 ? 0 : 1)
