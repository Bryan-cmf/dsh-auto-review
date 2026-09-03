// 煙霧測試：ESM 語法 + 模塊頂層執行 + 關鍵純函數行為 + client 樁加載
// 用法：node scripts/smoke.mjs
import { readFileSync, mkdtempSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'

// P1-13：審查歷史持久化寫 $DSH_HOME/review-history——測試一律重定向到臨時目錄，絕不寫真實 ~/.dsh
process.env.DSH_HOME = mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-smoke-home-'))

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname))
let failures = 0
const check = (name, cond) => {
	console.log(`${cond ? '✓' : '✗'} ${name}`)
	if (!cond) failures++
}

// ── 0. 導入形狀斷言：@deepseek-ai/schemastery 只有 default 導出（防幻覺具名導入復發）──
//   事故背景：上一版因幻覺 `import { z }`（該包無具名導出 z）導致重啟崩潰循環。
let SMZ_PKG = null
try {
	SMZ_PKG = await import('@deepseek-ai/schemastery')
} catch {
	// 本倉庫未必安裝該依賴：退回同層兄弟插件倉庫的 node_modules，用 createRequire 解析真實入口
	const { readdirSync } = await import('node:fs')
	const { createRequire } = await import('node:module')
	const base = path.dirname(root)
	for (const dir of readdirSync(base, { withFileTypes: true })) {
		if (!dir.isDirectory() || dir.name === path.basename(root)) continue
		try {
			const req = createRequire(path.join(base, dir.name, 'package.json'))
			const entry = req.resolve('@deepseek-ai/schemastery')
			SMZ_PKG = await import(pathToFileURL(entry).href)
			break
		} catch {}
	}
}
check('schemastery 包可解析（本倉庫或兄弟倉庫）', SMZ_PKG !== null)
if (SMZ_PKG !== null) {
	check('schemastery 僅 default 導出（default 為函數）', typeof SMZ_PKG.default === 'function')
	check('schemastery 無具名導出 z（幻覺導入防線）', SMZ_PKG.z === undefined)
}

// ── 1. host 半：剝離 bundle import 後可作為 ESM 導入（頂層執行零副作用）──
const hostSrc = readFileSync(path.join(root, 'lib/index.js'), 'utf8')
check('host 含 DYNAMIC-STRIP 標記行', hostSrc.includes('DYNAMIC-STRIP'))
// 適配 default import 形狀：`import SMZ from '@deepseek-ai/schemastery'`（容忍任意本地綁定名）
const stripRe = /^import \w+ from '@deepseek-ai\/schemastery'$/m
check('host 使用 default import（schemastery 真實形狀）', stripRe.test(hostSrc))
const stripped = hostSrc.replace(stripRe, 'const SMZ = null')
check('strip 後無殘留 schemastery import（防 ERR_MODULE_NOT_FOUND）', !stripped.includes("from '@deepseek-ai/schemastery'"))
const stubPath = path.join(os.tmpdir(), `dsh-ar-host-stub-${Date.now()}.mjs`)
const { writeFileSync } = await import('node:fs')
writeFileSync(stubPath, stripped)
const host = await import(pathToFileURL(stubPath).href)
check('host ESM 導入成功（export inject/apply）', typeof host.inject === 'object' && typeof host.apply === 'function')
check('host inject = [webServer, timer]', JSON.stringify(host.inject) === JSON.stringify(['webServer', 'timer']))

// ── 2. apply(ctx) 可在樁 ctx 上啟動並乾淨撤離（不觸發真實閉環）──
const disposed = []
const registrations = []
let routeHandler = null
const stubCtx = {
	get: (name) => {
		if (name === 'commands') return {
			register: (def) => { registrations.push('cmd:' + def.name); return () => {} },
		}
		return undefined // 其餘服務可選：sessionQuery/agents/subagents/llm/shell/settings
	},
	timer: { timeout: () => () => {}, interval: () => () => {} },
	effect: (fn) => { const d = fn(); disposed.push(d); return () => { for (const d of disposed) { try { d() } catch {} } } },
	webServer: { register: (route) => { registrations.push('route:' + route.path); routeHandler = route.handler; return () => {} } },
}
host.apply(stubCtx) // 不應拋出
check('apply(stubCtx) 註冊 /review 命令', registrations.includes('cmd:review'))
check('apply(stubCtx) 註冊 /__review 路由', registrations.includes('route:/__review'))
check('apply(stubCtx) 捕獲路由 handler', typeof routeHandler === 'function')
let CUR_TOKEN = '' // R2：bootstrap 引導後填充；fakeReq 一律攜帶（聲明先於任何調用）
// R2：per-install token 引導（bootstrap 端點回環放行）→ 後續所有請求攜帶
{
	const tokRes = fakeRes()
	routeHandler(fakeReq('GET', '/__review/api/token'), tokRes)
	CUR_TOKEN = (tokRes._json() || {}).token ?? ''
	check('R2：/api/token 引導端點返回 token', typeof CUR_TOKEN === 'string' && CUR_TOKEN.length >= 16)
}

// ── 2b. 進程內 HTTP 模擬：真實 handler + 樁 req/res（驗證 v1.1 邏輯）──
function fakeReq(method, url, body) {
	const listeners = {}
	const req = {
		method, url,
		headers: { host: '127.0.0.1:3080', 'x-review-token': CUR_TOKEN }, // F3+R2：模擬真實客戶端（Host + token）
		socket: { remoteAddress: '127.0.0.1' }, // R2：回環 socket
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
const http = async (method, url, body) => {
	const res = fakeRes()
	routeHandler(fakeReq(method, url, body), res)
	await new Promise((r) => setTimeout(r, 20))
	return res._json()
}
const cfg0 = await http('GET', '/__review/api/config')
check('config GET：默認配置（smart 範圍 + glm-5.3）', cfg0?.ok === true && cfg0.config.defaultScope === 'smart' && cfg0.config.defaultModels.includes('glm-5.3'))
check('config GET：動態模式標記未持久化', cfg0?.persisted === false)
check('config GET：內建模型 6 個（availableModels 兜底）', Array.isArray(cfg0?.availableModels) && cfg0.availableModels.length === 6)
const setRes = await http('POST', '/__review/api/config', { config: {
	customModels: [
		{ key: 'my-glm', provider: 'zai', model: 'glm-5.3-air', label: 'GLM Air' },
		{ key: 'glm-5.3', provider: 'zai', model: 'evil', label: '撞內建鍵' },          // 應被拒
		{ key: 'BAD KEY!', provider: 'zai', model: 'x', label: '非法鍵' },              // 應被拒
		{ key: 'no-model', provider: 'zai', model: '' },                                 // 應被拒
	],
	defaultModels: ['my-glm', 'kimi-k3', 'ghost'],  // ghost 不存在 → 應被濾掉
	defaultScope: 'full', defaultGate: 'strict', defaultMaxRounds: 8, defaultInjectMode: 'manual',
	reviewerConcurrency: 99,  // → clamp 4
	reviewerTimeoutMin: 1,    // → clamp 5
	fixWaitTimeoutMin: 9999,  // → clamp 720
}})
check('config POST：ok + 未持久化標記', setRes?.ok === true && setRes.persisted === false)
check('config POST：自訂模型收斂（1 個合法，3 個被拒）', setRes?.config?.customModels?.length === 1 && setRes.config.customModels[0].key === 'my-glm')
check('config POST：defaultModels 濾除幽靈鍵', setRes?.config?.defaultModels?.join(',') === 'my-glm,kimi-k3')
check('config POST：枚舉/數值鉗制生效', setRes?.config?.defaultScope === 'full' && setRes.config.defaultGate === 'strict' && setRes.config.defaultMaxRounds === 8 && setRes.config.defaultInjectMode === 'manual' && setRes.config.reviewerConcurrency === 4 && setRes.config.reviewerTimeoutMin === 5 && setRes.config.fixWaitTimeoutMin === 720)
const cfg1 = await http('GET', '/__review/api/config')
check('config 寫後讀回一致（內存態）', cfg1?.config?.customModels?.[0]?.model === 'glm-5.3-air' && cfg1.config.defaultScope === 'full')
const state0 = await http('GET', '/__review/api/state?session=nope')
check('state GET：無 run → 空閒視圖', state0?.running === false && state0.last === null)
const list0 = await http('GET', '/__review/api/list')
check('list GET：空清單', list0?.active?.length === 0 && list0?.finished?.length === 0)
const res1 = await http('POST', '/__review/api/resume', { session: 'nope' })
check('resume POST：無可恢復閉環 → 拒絕', res1?.ok === false && String(res1.error).includes('可恢復'))
const start1 = await http('POST', '/__review/api/start', { session: 'nope' })
check('start POST：subagents 缺席 → fail-fast 拒啟', start1?.ok === false && String(start1.error).includes('subagents'))
const cors = await http('POST', '/__review/api/stop', {})
check('POST 防護：樁 req 無 Origin 直放行', cors !== null)
// 安全校驗（跨源/鑑權 403/401）：直接構造請求對象（攜合法 Host + token + 回環 socket 以單獨測試各閘）
const hdr = (extra) => Object.assign({ host: '127.0.0.1:3080', 'x-review-token': CUR_TOKEN }, extra)
const rawReq = (method, url, headers, socket) => ({ method, url, headers, socket: socket ?? { remoteAddress: '127.0.0.1' }, on: () => {}, destroy() {} })
// Origin 校驗（跨源 403）
const evil = fakeRes()
routeHandler(rawReq('POST', '/__review/api/stop', hdr({ origin: 'https://evil.example' })), evil)
check('POST 防護：跨源 Origin → 403', evil.out.code === 403)
// H1 回歸：前綴偽造的 Origin（hostname 不是白名單精確值）必須 403
for (const bad of ['http://localhost.evil.example', 'http://127.0.0.1.attacker.example', 'http://harness.best-thinktank.com.evil.example', 'https://harness.best-thinktank.com:8443.evil.example']) {
	const r = fakeRes()
	routeHandler(rawReq('POST', '/__review/api/stop', hdr({ origin: bad })), r)
	check(`POST 防護：前綴偽造 Origin ${bad} → 403`, r.out.code === 403)
}
// H1 回歸：合法 Origin（本機任意埠 / 遠端 https）放行
for (const good of ['http://127.0.0.1:3080', 'http://localhost:5173', 'https://harness.best-thinktank.com']) {
	const r = fakeRes()
	routeHandler(rawReq('POST', '/__review/api/stop', hdr({ origin: good })), r)
	check(`POST 防護：合法 Origin ${good} → 非 403`, r.out.code !== 403)
}
// H1 回歸：遠端主機僅允許 https，明文 http 偽造 → 403
const rHTTP = fakeRes()
routeHandler(rawReq('POST', '/__review/api/stop', hdr({ origin: `http://harness.best-thinktank.com` })), rHTTP)
check('POST 防護：遠端主機明文 http Origin → 403', rHTTP.out.code === 403)
// F1 回歸：Origin: null（沙箱 iframe / data:/redirect）不得視為同源 → 403
const rNull = fakeRes()
routeHandler(rawReq('POST', '/__review/api/stop', hdr({ origin: 'null' })), rNull)
check('F1 防護：Origin: null → 403', rNull.out.code === 403)
// F3 回歸：Host 缺失或非白名單 → 403（含 GET——GET 端點無 Origin 可依，防 DNS rebinding/任意程序讀取）
const noHost = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list', {}), noHost)
check('F3 防護：GET 無 Host → 403', noHost.out.code === 403)
for (const badHost of ['attacker.example', '127.0.0.1.attacker.example', 'evil.com:80']) {
	const r = fakeRes()
	routeHandler(rawReq('GET', '/__review/api/list', { host: badHost, 'x-review-token': CUR_TOKEN }), r)
	check(`F3 防護：GET 惡意 Host ${badHost} → 403`, r.out.code === 403)
}
const hostOk = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list', hdr({ host: 'localhost:5173' })), hostOk)
check('F3 防護：GET 合法 Host → 非 403（進入業務分支）', hostOk.out.code !== 403)
// R2 回歸：token 鑑權 + 回環 socket
const noTok = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list', { host: '127.0.0.1:3080' }), noTok)
check('R2 防護：無 token → 401', noTok.out.code === 401)
const badTok = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list', { host: '127.0.0.1:3080', 'x-review-token': 'bad' }), badTok)
check('R2 防護：錯誤 token → 401', badTok.out.code === 401)
const lan = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list', hdr({}), { remoteAddress: '192.168.1.50' }), lan)
check('R2 防護：LAN socket → 403（防 LAN 暴露）', lan.out.code === 403)
const remoteOk = fakeRes()
routeHandler(rawReq('GET', '/__review/api/token', { host: 'harness.best-thinktank.com' }, { remoteAddress: '203.0.113.9' }), remoteOk)
check('R3 防護：遠端對端不可自領 token（bootstrap 僅限回環）', remoteOk.out.code === 403)
const qTok = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list?token=' + CUR_TOKEN, { host: '127.0.0.1:3080' }), qTok)
check('R3 防護：?token= 查詢通道已移除（僅 x-review-token 頭有效）', qTok.out.code === 401)
const noSock = fakeRes()
routeHandler(rawReq('GET', '/__review/api/list', hdr({}), {}), noSock)
check('R3 防護：socket 信息缺失 fail-closed → 403', noSock.out.code === 403)

for (const d of disposed) { try { d() } catch {} }
check('apply 撤離無異常', true)

// ── 2c. discoverModels 動態模型來源（v1.3.0 修復 C）：stubbed llm ──
//   llm.listProviders() 對齊 DSH 已配置路由；listModels(provider) 取該 provider 可用模型；
//   availableModels 只含配置 provider 下存在的模型、剔除已下架模型（如 qwen3.8-max-preview）、
//   listModels 對某 provider 拋錯時保留為 advisory（不攔截）。
const httpWith = async (handler, method, url, body) => {
	const res = fakeRes()
	handler(fakeReq(method, url, body), res)
	await new Promise((r) => setTimeout(r, 20))
	return res._json()
}
async function applyWithLlm(llmStub) {
	const dsp = []
	let routeH = null
	const ctx2 = {
		get: (n) => {
			if (n === 'commands') return { register: (def) => { return () => {} } }
			if (n === 'llm') return llmStub
			return undefined
		},
		timer: { timeout: () => () => {}, interval: () => () => {} },
		effect: (fn) => { const d = fn(); dsp.push(d); return () => { for (const d of dsp) { try { d() } catch {} } } },
		webServer: { register: (route) => { routeH = route.handler; return () => {} } },
	}
	host.apply(ctx2)
	return routeH
}
// 場景 A：正常動態來源 —— 4 providers，qwen-token-plan 僅回傳 qwen3.7-plus（qwen3.8-max-preview 已下架）
{
	const hA = await applyWithLlm({
		listProviders: () => [
			{ id: 'zai', name: 'ZAI' },
			{ id: 'moonshotai', name: 'Moonshot AI' },
			{ id: 'qwen-token-plan', name: 'Qwen Token Plan' },
			{ id: 'deepseek-official', name: 'DeepSeek Official' },
		],
		listModels: async (pid) => {
			if (pid === 'zai') return [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'glm-5.2', name: 'GLM 5.2' }]
			if (pid === 'moonshotai') return [{ id: 'kimi-k3', name: 'Kimi K3' }]
			if (pid === 'qwen-token-plan') return [{ id: 'qwen3.7-plus', name: 'Qwen3.7+' }] // 已下架模型不出現在 listModels
			if (pid === 'deepseek-official') return [{ id: 'deepseek-v4-flash-vision-exp', name: 'DS V4' }]
			return []
		},
	})
	const cA = await httpWith(hA, 'GET', '/__review/api/config')
	const amA = cA?.availableModels ?? []
	check('discover: availableModels 取代 builtinModels（動態來源）', amA.length === 5, `len=${amA.length}`)
	check('discover: 只含配置 provider 下存在的模型', amA.every((m) => ['zai', 'moonshotai', 'qwen-token-plan', 'deepseek-official'].includes(m.provider)))
	check('discover: 鍵為 provider:model 格式', amA.every((m) => m.key === `${m.provider}:${m.model}`))
	check('discover: moonshotai:kimi-k3 存在', amA.some((m) => m.key === 'moonshotai:kimi-k3'))
	check('discover: qwen 已下架模型 qwen3.8-max-preview 不出現', !amA.some((m) => m.model === 'qwen3.8-max-preview'))
	check('discover: builtinModels 鍵已不存在於 payload', cA?.builtinModels === undefined)
	// R4：defaultModels 短鍵（glm-5.3）正規化到動態鍵空間（zai:glm-5.3）——面板預選不再全落空
	check('R4: defaultModels 正規化為 provider:model 動態鍵', Array.isArray(cA?.config?.defaultModels) && cA.config.defaultModels.includes('zai:glm-5.3') && !cA.config.defaultModels.includes('glm-5.3'), JSON.stringify(cA?.config?.defaultModels))
	check('R4: 正規化後每個 defaultModels 鍵都在 availableModels 中存在', (cA?.config?.defaultModels ?? []).every((k) => amA.some((m) => m.key === k)))
}
// 場景 B：listModels 對某 provider 拋錯 → 保留該 provider 為 advisory（不攔截其模型）
{
	const hB = await applyWithLlm({
		listProviders: () => [{ id: 'zai', name: 'ZAI' }, { id: 'ghost-provider', name: 'Ghost Provider' }],
		listModels: async (pid) => {
			if (pid === 'ghost-provider') throw new Error('listModels 不可用')
			return [{ id: 'glm-5.3', name: 'GLM 5.3' }]
		},
	})
	const cB = await httpWith(hB, 'GET', '/__review/api/config')
	const amB = cB?.availableModels ?? []
	check('discover: listModels 拋錯之 provider 保留為 advisory', amB.some((m) => m.provider === 'ghost-provider' && m.model === 'ghost-provider'))
	check('discover: 其餘 provider 模型正常納入', amB.some((m) => m.key === 'zai:glm-5.3'))
}

// ── 3. client 半：樁 ModuleLoader + 樁 react，工廠執行 + apply 註冊兩個 slot ──
const noopComp = () => null
const stubReact = {
	createElement: (...a) => ({ kind: 'el', a }),
	useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
	useEffect: () => {}, useCallback: (f) => f,
}
let clientFactory = null
globalThis.window = {
	__ModuleLoader__: {
		load: (def) => { clientFactory = def.factory },
	},
}
const clientSrc = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
const clientStubPath = path.join(os.tmpdir(), `dsh-ar-client-stub-${Date.now()}.mjs`)
writeFileSync(clientStubPath, clientSrc)
await import(pathToFileURL(clientStubPath).href)
check('client module loader 捕獲工廠', typeof clientFactory === 'function')
const clientExports = clientFactory((name) => { if (name === 'react') return stubReact; throw new Error('unexpected require: ' + name) })
check('client 工廠返回 plugin（apply/inject/name）', typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject) && clientExports.name === 'auto-review-client')
const slotRegs = []
const stubClientCtx = {
	slots: {
		inject: (slotName, reg) => { slotRegs.push(slotName); reg() },
		register: (opts, comp) => { slotRegs.push(opts.name + ':' + (opts.id ?? opts.key)) ; return () => {} },
	},
}
clientExports.apply(stubClientCtx)
check('client 註冊 conversation.view:review', slotRegs.includes('conversation.view:review'))
check('client 註冊 settings.section:auto-review', slotRegs.includes('settings.section:auto-review'))

// ── 4. 特徵斷言（v1.1 十項）──
const feats = {
	'A1 必見 running 才認 idle': hostSrc.includes('sawRunning') && hostSrc.includes('PICKUP_GRACE_MS'),
	'A2 活動型超時順延': hostSrc.includes('deadline = Date.now() + run.fixWaitMs // A2：活動順延'),
	'A3 指紋+錨點雙級匹配': hostSrc.includes('normTitle') && hostSrc.includes('anchorOf') && hostSrc.includes('p.anchor === anchor'),
	'A4 resume 入口': hostSrc.includes("input === 'resume'") && hostSrc.includes('/__review/api/resume') && hostSrc.includes('review-resume'),
	'B 智慧範圍變更集': hostSrc.includes('collectChangedFiles') && hostSrc.includes('-newermt') && hostSrc.includes('ls-files --others'),
	// R8（C-1/S-1/S-3/F-6）
	'R8-C1 變更集含 commit 檔案': hostSrc.includes("git log --name-only --pretty=format: --since="),
	'R8-S1 審查提示詞清洗變更集/上輪項': hostSrc.includes('sanitizeRuleText(f, 200, false)') && hostSrc.includes('sanitizeRuleText(f.title, 120, true)'),
	'R8-S3 accepted 字段同口徑過濾': hostSrc.includes('sanitizeRuleText(String(f.title ?? \'\'), 120, true)'),
	'R8-F6 globToRe 抑制連續 .*': hostSrc.includes("if (!re.endsWith('.*')) re += '.*'") && hostSrc.includes('MAX_RULES'),
	'R8-F1 等確認通知+超時': hostSrc.includes('notifyAwaitingConfirm') && hostSrc.includes('armConfirmTimeout'),
	'R8-F2 終態通告': hostSrc.includes('async function notifyTerminal'),
	'R8-F5 快照保留時間線': hostSrc.includes('roundLog: run.roundLog.map') && hostSrc.includes('injectLog: (snap.injectLog ?? []).map'),
	'R8-C4 有界緩存': hostSrc.includes('boundedPut(lastFinished') && hostSrc.includes('function boundedPut'),
	// R9（C-1/C-3/F-7/S-2/S-3/F-4）
	'R9-C1 快照保留最新（slice(-20) 兩側對齊）': hostSrc.includes('list.slice(-20)') && hostSrc.includes('interrupted = (Array.isArray(src.interrupted)'),
	'R9-C3 恢復路徑重新武裝超時+通知': hostSrc.includes('armConfirmTimeout(last)') && hostSrc.includes('notifyAwaitingConfirm(last)'),
	'R9-S2 glob 星號護欄+輸入截斷': hostSrc.includes('glob 星號過多') && hostSrc.includes('.slice(0, 512)') && hostSrc.includes('sanitizeRuleText(fileGlob, 200, false)'),
	'R9-S3 file 字段納入清洗': hostSrc.includes("['title', 'detail', 'suggestion', 'file']"),
	'R9-F4 異常終態通告（launchRound/watchFix catch）': (hostSrc.match(/void notifyTerminal\(run\)/g) ?? []).length >= 10,
	'R8-C2 client callApi 未知方法拒發 + review-list 映射': clientSrc.includes('"review-list": "list"') && clientSrc.includes('未知方法: '),
	'R8-D3 OptPills aria-pressed + 具名品牌底色': clientSrc.includes('"aria-pressed": on') && clientSrc.includes('const cBrandBg = "rgba(88, 166, 255, 0.14)"') && clientSrc.includes('background: on ? cBrandBg'),
	'R8-D4 狀態膠囊異常終態分色': clientSrc.includes('run.status === "failed" || run.status === "stopped" ? cBad'),
	'R8-D7 role=alert（錯誤/警告播報；v1.4.1 起降級提示亦 alert）': clientSrc.includes('role: "alert"'),
	'R8-D8 mini 按鈕 24px + aria-label': clientSrc.includes('minHeight: 24') && clientSrc.includes('aria-label'),
	'R8-D6 FindingRow 共用組件': clientSrc.includes('function FindingRow'),
	'R8-F10 報告載入態+錯誤可視': clientSrc.includes('repLoading') && clientSrc.includes('報告取得失敗'),
	'R8-F13 自訂模型保存校驗': clientSrc.includes('缺 provider/model 欄位'),
	'R9-F5 動態 RPC 30s 超時': clientSrc.includes('主機無響應（超時）'),
	'R9-F3 輪詢恢復清除錯誤橫幅': clientSrc.includes('indexOf("狀態獲取失敗") === 0'),
	'R9-D2 主題探測+淺/深保底': clientSrc.includes('prefers-color-scheme') && clientSrc.includes('LIGHT_FB'),
	'R9-D7 設置頁播報 role': clientSrc.includes('msg.indexOf("失敗") >= 0 ? "alert" : "status"'),
	'C1 provider 預檢': hostSrc.includes('preflightProviders') && hostSrc.includes('listProviders'),
	'C2 settings 持久化+快照': /svc\.register\(SETTINGS_NS/.test(hostSrc) && hostSrc.includes("ctx.inject(['settings']") && hostSrc.includes('snapshotOf') && hostSrc.includes('hydrateSnapshot'),
	'C3 配置 RPC/HTTP': hostSrc.includes('review-config-get') && hostSrc.includes('review-config-set') && hostSrc.includes('/__review/api/config'),
	'D 版本註釋與 package.json 一致': (() => {
		const pkgVer = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
		const marker = 'v' + pkgVer
		return hostSrc.includes(marker) && readFileSync(path.join(root, 'lib/client.js'), 'utf8').includes(marker)
	})(),
	'C4 審查者絕對時限（槽永不卡死）': hostSrc.includes('rejectAfter') && hostSrc.includes('deadlineAt') && hostSrc.includes('fireAndForgetDispose'),
	// P1-13（v1.6）：審查歷史持久化
	'P1-13 歷史持久化（終態歸檔+LRU+截斷）': hostSrc.includes('HISTORY_ARCHIVED_STATUSES') && hostSrc.includes('HISTORY_KEEP_PER_PROJECT = 50') && hostSrc.includes('HISTORY_FILE_BUDGET_BYTES = 256 * 1024') && hostSrc.includes('archiveIfTerminal'),
	'P1-13 歷史 API（清單+明細）': hostSrc.includes("p === '/__review/api/history'") && hostSrc.includes("p.startsWith('/__review/api/history/')") && hostSrc.includes('review-history-list') && hostSrc.includes('review-history-get'),
	'P1-13 DSH_HOME 對齊宿主語義（$DSH_HOME→~/.dsh；node fs 受信通道）': hostSrc.includes('node:fs/promises') && hostSrc.includes("process.env.DSH_HOME") && hostSrc.includes('review-history'),
	'client 設置頁組件': readFileSync(path.join(root, 'lib/client.js'), 'utf8').includes('function SettingsPage'),
}
for (const [name, ok] of Object.entries(feats)) check(name, ok)

console.log(failures === 0 ? '\n全部通過 ✅' : `\n${failures} 項失敗 ❌`)
process.exit(failures === 0 ? 0 : 1)
