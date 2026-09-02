# SPEC — dsh-auto-review（自動審查官）技術規格

> 版本 v1.1 · 2026-08-26 · v1.0 四項決定（子代理審查 / 全自動注入 / 範圍可配 / 個人工具 profile bundle）+ v1.1 優化批次
> 本文所有 DSH API 均已在本機源碼/服務目錄驗證（§2），非猜測。
> 實現補充驗證（2026-08-24）：`subagents` provider 名 = **`spawn`**（dsh-subagent-spawn-in-process 默認）；
> `SubagentStartRequest.toolFilter = {allow?: string[], deny?: string[]}`；`CommandInvocation.agent` 提供觸發會話活代理；
> 消息源 `{kind:'plugin', plugin}` ✓；官方 DSW token 共 13 個 ✓。
> v1.1 增補驗證（2026-08-26，源碼級）：settings schema 用 **schemastery**（`@deepseek-ai/schemastery`，
> `z.object/z.array/z.any/z.string/z.natural().default()`）；`settings.section` 組件 props 收 `{close}`；
> `AgentStatus = 'idle' | 'running'`（僅兩值）；`llm.listProviders(): {id,name}[]`；
> fs 服務 **無 mtime**（FsInfo 僅 version/type/size）→ 變更集走 `shell.resolve({command,workdir,timeoutMs,stdoutMaxBytes})`
> + `run()`，輸出 `res.stdout.text`（CollectedOutput `{text,truncated,spillPath?}`）。

---

## 1. 架構總覽

```
┌─ HOST (lib/index.js) ──────────────────────────────┐   ┌─ CLIENT (lib/client.js) ─────────┐
│ ReviewOrchestrator（閉環狀態機，每會話一實例）        │   │ conversation.view slot (order 80) │
│  ├─ 4× ReviewerSpawner ──► agents/subagents        │   │  ├─ 輪次/狀態總覽                │
│  │    agentOptions={zai,glm-5.3} 只讀工具集          │◄──┤  ├─ 四維度卡片+findings         │
│  ├─ FindingsAggregator ──► 驗收判定                 │RPC│  ├─ 注入歷史                    │
│  ├─ ChatInjector ──► targetAgent.followup()        │   │  └─ 控制(開始/停止/確認注入)     │
│  ├─ LoopGuard(輪數/振盪/idle等待)                    │   └─ host.call ←→ harness.handle   │
│  ├─ commands: /review /review stop /review status  │
│  └─ webServer: /__review/api/*（ctx.effect 包裹！） │
└────────────────────────────────────────────────────┘
```

**注入語義**：`followup()` 把建議作為 user 消息排入目標會話 inbox 並喚醒驅動 —— 對編碼代理而言**等同你親自發的消息**，天然具備完整上下文與工具權限。這是最強大的整合點，也是需要 gate 選項的原因。

## 2. 已驗證的技術事實（實現依據）

| # | 事實 | 來源 |
|---|---|---|
| T1 | `AgentOptions = {provider?, model?, maxTokens?}`；spawn 時指定即鎖定該代理的模型路由 | `dsh-agent/lib/types/runtime-types.d.ts:21` |
| T2 | `zai` provider 已配置：`glm-5.3`，contextWindow 1,000,000 / maxTokens 131,072，`ZAI_API_KEY` | `~/.dsh/settings.yaml` |
| T3 | `agents.create(CreateAgentOptions): Promise<AgentHandle>`；`meta={cwd, parentSession?, origin:'subagent', agentPreset?}`、`seed?`、`setup?`（agentCtx 上可 `tools.restrict()` 做只讀約束） | `dsh-agent/lib/types/index.d.ts:65` |
| T4 | `subagents.start(name, SubagentStartRequest)`：`{parent: Agent, prompt, agentOptions?, outputSchema?, signal}`，支持 JSON Schema 結構化產出；`startContinuable/followup/interrupt` 可續聊 | `dsh-subagent/lib/types/types.d.ts:91` |
| T5 | `Agent` 介面：`followup(UserMessage)`（排隊新回合並喚醒）、`steer/inject`、`whenIdle(): Promise<void>`、`cancel(cause)`、`status`、`inbox` | `dsh-agent/lib/types/runtime-types.d.ts:60-140` |
| T6 | `Message = {id, role, content: ContentBlock[], source: MessageSource}`；MessageSourceMap 含 **`plugin`** kind —— 審查官消息可標註插件來源，與人類輸入區分 | `dsh-llm/lib/types/message.d.ts:94-131` |
| T7 | `commands.register(CommandDefinition)`：註冊聊天框人類命令（`/review`） | 服務目錄 `commands` |
| T8 | `sessionQuery.listSessions()/readSession(id)`；`SessionRecord.header.id/.header.cwd`（巢狀結構，勿用頂層） | 已於 artifact-view 驗證 |
| T9 | `webServer.register(route)` 必須包 `ctx.effect()`（殭屍路由教訓）；client 端 `window.__ModuleLoader__.load` 模式 | ops-view/artifact-view 教訓 |
| T10 | conversation.view slot：ops=60、artifacts=70 已佔，review 取 **80**；DSW 僅 14 官方 token，dark 需 fallback | Theme.listTokens 已驗 |
| T11 | `settings.register(ns, schema)` 提供持久化配置（profile bundle 插件適用）；schema 為 schemastery（v1.1 驗證）；返回 scope `{get, watch, update, replace}` | dsh-settings/lib/index.js |
| T12 | 事件：`agent/status`（idle↔running 監聽）、`agent/error`、`session/event` | 事件目錄 |
| T13 | `settings.section` list slot：`{id, order, label}` 註冊一個設置頁；組件 props `{close}`（v1.1） | dsh-client-ui-settings-general/lib/client.js |
| T14 | `llm.listProviders(): {id, name}[]` —— 啟動預檢 provider 路由（v1.1） | dsh-llm/lib/types/types.d.ts |
| T15 | `shell.resolve({command, workdir?, timeoutMs?, stdoutMaxBytes?}) → ShellExecSpec` + `shell.run(spec) → {exitCode, timedOut, stdout: {text}}` —— 變更集命令通道（v1.1） | dsh-shell/lib/types |
| T16 | `AgentStatus = 'idle' | 'running'`；fs 服務無 mtime（FsInfo 僅 version/type/size） | dsh-agent/dsh-fs types |

## 3. Host 設計

### 3.1 ReviewOrchestrator（狀態機）

```
idle → reviewing(R1,全量) → aggregating → [pass?] ─yes→ passed(終態,出報告)
                                   └─no→ injecting → awaiting-fix(輪詢 targetAgent.status)
                                                     └→ reviewing(R+1, smart=變更集聚焦|full=全量) → …
任意態 → stopped(用戶) / failed(錯誤) / oscillated(同一finding×3輪) / max-rounds
awaiting-fix → paused(等修復超時/代理離線) ── /review resume ──→ reviewing(R+1)
重啟 → 快照(settings 持久化) → interrupted ── /review resume ──→ reviewing(R+1)
```

- 每個目標會話同時只允許一個閉環（Map<sessionId, ReviewRun>）。
- **watchFix 輪詢（v1.1 加固）**：3s 輪詢 `agents.get(id).status`；
  ① **必須先觀察到一次 `running`** 才承認其後的 `idle`（防注入未消化即複審的賽窗），
  注入後 45s 寬限兜底「代理極快完成」路徑；② 等待期限**隨每次 running 順延**（活動型，
  默認 30 分鐘無活動才暫停）；③ idle 後延遲 5s 觸發下一輪（回合邊界緩衝）。
  不用 `agent/status` 事件（Scoped 語義對 host 插件纖維不確定，輪詢+狀態追蹤已足夠）。
- **範圍策略（v1.1）**：`scope='smart'`（默認）R1 全量建立基線，後續輪審查者提示詞附
  變更集（git diff --name-only HEAD + ls-files --others；非 git 倉庫退 `find -newermt <本地時間戳>`，
  排除 node_modules/.git/dist/build/.venv/__pycache__/.next；上限 300 檔）；收集失敗 → 該輪
  自動降級全量。`scope='full'` 保持 v1.0 每輪全量。每輪 `roundLog` 記錄實際範圍。
- **指紋與振盪（v1.1）**：初級指紋 `file|正規化title`（摺大小寫、去空白標點、保 CJK）；
  二級錨點 `file|L<floor(line/5)*5>|severity`。匹配 = 初級相等 ∪ 錨點相等 —— 跨模型輪換
  的措辭漂移不再使 streak 歸零。連續 3 輪 → oscillated 終態。
- **恢復（v1.1）**：`resumeRun` 允許 `paused`/`interrupted` → round+1 重新複審當前狀態
  （loop 模式要求目標代理在線；round+1 ≤ maxRounds）。

### 3.2 審查者派生（Q1 定稿後二選一，默認按子代理設計）

**方案 A（默認）：subagents.start**
```js
const run = await subagents.start('glm-reviewer', {
  parent: targetAgent,                    // 目標會話的活代理（GUI 中該會話通常 live）
  label: `審查·${dimension}·R${round}`,
  prompt: buildReviewPrompt(dimension, scope),   // §5 提示詞模板
  agentOptions: { provider: 'zai', model: 'glm-5.3' },
  outputSchema: FINDING_SCHEMA,           // 結構化 findings，拒絕自由文本漂移
  signal: runAbortController.signal,
})
```
- 產出經 JSON Schema 校驗，直接得 `{dimension, pass, findings[], summary}`。
- 目標會話非 live（代理不在註冊表）→ 先 `agents.resume({resumeSessionId})` 或降級方案 B。

**方案 B（降級/備選）：agents.create + followup**
```js
const handle = await agents.create(ctxOwner, {
  sessionId: mintId(),
  meta: { cwd: projectPath, parentSession: targetId, origin: 'subagent' },
  agentOptions: { provider: 'zai', model: 'glm-5.3' },
  setup: (agentCtx) => { /* tools.restrict 只讀集 */ },
})
handle.agent.followup(reviewPromptMessage)
await handle.agent.whenIdle()
const final = readLastAssistant(handle.agent.id)   // sessionQuery.readSession → 解析 JSON
```

**只讀保證（雙保險）**：setup 中 restrict 工具至 `read/grep/glob` 類 + 提示詞顯式「只讀不改」。

### 3.3 聚合與驗收判定

```js
verdict(run) = {
  passed: DIMENSIONS.every(d => d.findings
      .filter(f => SEVERITY_GATE.has(f.severity)).length === 0),
  blocking: 按維度分組的 critical/high 清單,
}
```
- `SEVERITY_GATE` 默認 `{critical, high}`，可配。
- 同一 finding 跨輪指紋比對（`file+title` 歸一化 hash）連續 3 輪 → oscillated 終態。

### 3.4 聊天框注入

```js
await targetAgent.whenIdle()               // 不打斷進行中回合
targetAgent.followup({
  content: [{ type: 'text', text: injectMessage(round, blocking) }],
  source: { kind: 'plugin', plugin: 'dsh-auto-review', /* 輪次等上下文 */ },
  /* id 由 createMessage 工廠生成（dsh-llm 導出），實現時確認簽名 */
})
```
- 注入文案模板：標題（審查官·第 N 輪）→ 按維度分組的問題清單（file:line + 修復建議）→ 明確指令「請逐項修復，完成後我會複審」。
- injectMode=manual 時：注入前面板彈「待確認」卡，`POST /api/inject` 確認後才 followup。

### 3.5 HTTP API（全部 ctx.effect 包裹）

| Route | 方法 | 說明 |
|---|---|---|
| `/__review/api/state?session=` | GET | 閉環狀態+四維+findings（面板 3s 輪詢，活躍時 1s） |
| `/__review/api/start` | POST | `{session, maxRounds?, gate?, scope?, models?, dims?, injectMode?}` 啟動（缺省項取設置頁預設） |
| `/__review/api/stop` | POST | `{session}` 終止（cancel 審查者 + 撤監聽） |
| `/__review/api/resume` | POST | `{session}` 恢復 paused/interrupted 閉環（round+1）（v1.1） |
| `/__review/api/config` | GET | 配置查詢：`{config, availableModels, persisted}`（v1.1；v1.3 改 availableModels 為動態來源） |
| `/__review/api/config` | POST | `{config}` 配置寫入（settings 持久化；動態模式內存；POST 受 Origin 校驗：hostname 精確白名單，前綴偽造 403）（v1.1） |
| `/__review/api/inject` | POST | manual 模式確認注入 `{session}` |
| `/__review/api/report?session=` | GET | Markdown 完整報告 |

RPC（動態模式 `harness.handle`，與 HTTP 同語義）：`review-state / review-report / review-start /
review-stop / review-resume / review-list / review-config-get / review-config-set / review-inject`。

### 3.5.1 配置模型（v1.1，v1.3 模型來源改為動態對齊 DSH）

settings 命名空間 `dsh-auto-review`（schemastery schema，寬鬆存儲 + `mergeConfig` 嚴格收斂）：

| 鍵 | 類型/範圍 | 默認 |
|---|---|---|
| `customModels` | `[{key, provider, model, label}]`（key 唯一 kebab、不與內建衝突） | `[]` |
| `defaultModels` | 可用模型鍵多選（≥1；含內建/自訂/動態鍵） | `['glm-5.3']` |
| `defaultGate` | loose/standard/strict | standard |
| `defaultMaxRounds` | 1–10 | 5 |
| `defaultScope` | smart/full | smart |
| `defaultInjectMode` | auto/manual | auto |
| `reviewerConcurrency` | 1–4 | 2 |
| `reviewerTimeoutMin` | 5–60 | 15 |
| `fixWaitTimeoutMin` | 5–720（活動型） | 30 |
| `interrupted` | 中斷快照數組（≤20，插件寫入；設置頁不可編輯） | `[]` |

**模型來源語義（v1.3）**：設置頁/面板的模型清單（`availableModels`）不再硬編碼，改由
`discoverModels()` 動態生成——以 `llm.listProviders()`（DSH 已配置的 provider 路由）為起點，
逐 provider 調 `llm.listModels(provider)` 彙整可用模型（`key = `${provider}:${model}``，label 取模型
`name` 或缺省 `id`）。`MODEL_PRESETS` 僅在 `llm.listModels` 不可用 / 返回空 / llm 服務缺席時作為
**兜底**（短鍵），避免把已下架模型（如 `qwen3.8-max-preview`）拉進輪換。`listModels` 對某
provider 不可用時，保留該 provider 自身作為可選項（advisory，不攔截其模型）。

動態插件模式：沙箱無 import → 無 schemastery → 配置僅內存（面板提示「僅本次運行有效」）。
啟動時 `preflightProviders` 升級為 **provider + model 雙重校驗**：先對所選模型去重 provider 後對
`llm.listProviders().id` 校驗，再對 `llm.listModels()` 的可見模型做可用性過濾（exclude 已下架/
不可用模型）；過濾後清單為空即明確 `{ok:false}` 拒啟（llm 服務不可用則跳過預檢）。
另在 `reviewDimension` 做**運行時降級**（修復 A）：`run.models[(round-1)%len]` 改為
`candidateModels(run, round)`（從輪換起點依序），spawn 失敗記 `console.error` 試下一可用模型，
全敗才 throw 給既有重試/失敗流程；C4 絕對時限與槽釋放不變。

### 3.6 命令

- `/review [path]` — 啟動（path 省略 = 當前會話項目；缺省配置取設置頁預設）
- `/review stop` / `/review status` / `/review resume`（v1.1）
- 註冊前查重（commands 服務 find），衝突則改名 `/glm-review`。

### 3.7 依賴聲明

`cordis.patch.yml`（或 package.json dsh 段）：
```yaml
inject: [webServer, sessionQuery, timer]
# agents / subagents / commands / settings / llm 用 ctx.get() 可選獲取
# （閉環核心依賴 agents/subagents，但缺它們時插件應降級為「僅報告模式」而非拒啟）
```

## 4. Client 設計

- **審查面板**：`conversation.view` slot，`{name:'conversation.view', id:'review', order:80, label:'審查'}`；
  `props.sessionId` 定位閉環。
  - 佈局：頂部輪次進度條（R n/max + 狀態膠囊）→ 四維度卡片（狀態燈、各嚴重度計數、可展開 findings 表）
    → 注入歷史時間線 → 底部控制條（開始/停止/確認注入[manual]/**恢復閉環**[paused/interrupted]）（v1.1）。
  - 發起配置：角度勾選 / 強度 / 輪次 / **範圍（智慧/全量）** / 模型多選（內建+自訂），初始值自 `review-config-get`。
- **設置頁（v1.1）**：`settings.section` slot，`{name:'settings.section', id:'auto-review', order:90, label:'自動審查'}`；
  組件 props `{close}`。分組：審查模型（內建展示 + 自訂增刪改 + 默認模型多選）/ 閉環預設
  （強度/輪次/範圍/注入模式）/ 執行參數（併發/審查者超時/等修復超時）。保存走 `review-config-set`。
- **樣式**：僅用 14 個官方 DSW token + dark fallback（同 ops-view 教訓）；零全局 DOM 操作。
- **通信**：全部 `host.call`（動態）或 `fetch /__review/api/*`（bundle）；不複製 Slot props 大對象。

## 5. 敩據模型與審查提示詞

### 5.1 結構

```ts
ReviewRun  { id, sessionId, projectPath, status, round, maxRounds,
             injectMode, startedAt, endedAt?, tokenEstimate,
             dimensions: Record<'code'|'security'|'flow'|'design', DimensionState> }
DimensionState { status:'pending'|'reviewing'|'reviewing-diff'|'passed'|'blocking',
                 findings: Finding[], summary, reviewedFiles, lastRunAt }
Finding    { id, severity:'critical'|'high'|'medium'|'low',
             file, line?, title, detail, suggestion, fingerprint }
```

outputSchema（給審查者，assertObjectJsonSchema 子集）：
```json
{ "type":"object", "required":["dimension","pass","findings","summary"],
  "properties":{
    "dimension":{"type":"string","enum":["code","security","flow","design"]},
    "pass":{"type":"boolean"},
    "summary":{"type":"string"},
    "findings":{"type":"array","items":{"type":"object",
      "required":["severity","file","title","detail","suggestion"],
      "properties":{
        "severity":{"type":"string","enum":["critical","high","medium","low"]},
        "file":{"type":"string"},"title":{"type":"string"},
        "detail":{"type":"string"},"suggestion":{"type":"string"}}}}}}
```

### 5.2 提示詞模板（每維度一份 checklist，隨插件發行 `lib/prompts/*.js`）

```
你是<{維度名}>審查專家，運行於 GLM 5.3，隸屬「自動審查官」閉環（第 {N} 輪）。
項目路徑：{cwd}；審查範圍：{full-scan 文件清單 | git-diff 變更集}。
規則：
1. 只讀審查（你只有讀取/搜索工具），絕不修改任何文件。
2. 逐項過 checklist：<每維度 8~12 條具體檢查項>。
3. 增量輪：重點複核上輪 findings 是否已修復，同時掃描變更引入的新問題。
4. 每條 finding 必須：定位到具體文件（+行）、給出可執行修復建議、嚴重度有依據。
5. 嚴禁為「通過」而放水：拿不準按較高嚴重度報。
按 outputSchema 返回 JSON。
```

四個 checklist 要點（完整版隨 M2 落地）：
- **code**：邏輯錯誤、錯誤處理缺失、資源洩漏、死碼、重複、命名、複雜度、依賴版本風險
- **security**：注入（命令/SQL/路徑）、硬編碼密鑰、不受信輸入、越權訪問、不安全依賴（CVE 意識）、日誌洩敏
- **flow**：主流程斷點、空/錯/載入三態、邊界輸入、操作可逆性、反饋缺失、可達性（死角路由/按鈕）
- **design**：token 一致性（色/字/距）、視覺層級、響應式斷點、對比度與可訪問性、組件複用 vs 重複樣式、風格漂移

## 6. 閉環時序（正常路徑）

```
用戶 /review
 → Orchestrator: 定位 session(cwd) → spawn 4×GLM5.3 審查者(並行, outputSchema)
 → 各審查者自主探索項目 → 結構化 findings 逐個返回
 → 聚合判定：有 blocking → 組裝注入消息
 → await targetAgent.whenIdle() → followup(建議清單)   [manual 模式：先面板確認]
 → 編碼代理修復（面板顯示 awaiting-fix，監聽 agent/status）
 → idle 後 +3s → R+1：git diff 為範圍重派 4 審查者（含複核上輪項）
 → 全綠 → passed：面板綠燈 + 報告連結 + 會話內通過通告（steer 一次摘要）
```

## 7. 風險與對策

| 風險 | 對策 |
|---|---|
| 模型路由不可用/key 失效 | ✅ v1.1 已實現：啟動前 `llm.listProviders()` 預檢；失敗即拒啟（fail-fast） |
| 審查者跑飛（超時/不返回 JSON） | 每審查者硬超時（默認 15 分鐘，設置頁可配 5–60）；解析失敗重試 1 次，再失敗按 failed 處理 |
| 注入未消化即複審（idle 賽窗） | ✅ v1.1 已修：必須先觀察到一次 running 才承認 idle（45s 寬限兜底極快完成） |
| 注入與用戶手動輸入互踩 | followup 天然排隊；注入消息帶 plugin 來源；面板注入歷史可審計 |
| 目標代理長時間不 idle | 活動型超時（v1.1：每次 running 順延；無活動滿 fixWaitTimeoutMin → 暫停可 resume，不打擾） |
| Token 成本失控 | ✅ v1.1 智慧範圍（R1 全量→變更集聚焦）+ maxRounds 硬頂 + 報告模式不注入 |
| 跨模型措辭漂移擊穿振盪保護 | ✅ v1.1 已修：初級指紋 ∪ 位置錨點（file+行號桶+severity）雙級匹配 |
| 修復引入新問題 | 每輪複審覆蓋變更集全量 + 上輪未過項（smart）；全量模式每輪全維度掃描 |
| 進程重啟殺掉進行中閉環 | ✅ v1.1 最小持久化：注入邊界落快照（settings 命名空間）→ 重啟後 interrupted 可 resume |
| 插件停止時閉環在跑 | dispose 鉤子：先落快照（best-effort），再 cancel 審查者、撤監聽、閉環標 stopped；設置註冊隨 fiber 撤離 |
| 併發閉環 | Map 按 sessionId 去重；start 冪等；審查者併發全局上限（設置頁可配 1–4） |
| 變更集命令失敗/被沙箱攔 | 收集失敗 → 該輪自動降級全量（roundLog 標注）；命令僅含時間戳常量，workdir 走參數通道 |

## 8. 部署與驗收

- **部署**：profile bundle 模式（`pnpm add file:` + `dsh.profile.bundles` 追加 + 徵得同意後重啟）；
  依賴 `@deepseek-ai/schemastery`（settings schema，bundle 模式）；部署前過掃描器。
- **目錄**（checklist 內聯在 index.js，v1.1 起不再規劃獨立 prompts 目錄）：
```
dsh-auto-review/
  lib/index.js  lib/client.js
  cordis.patch.yml  package.json  docs/{PRD,SPEC}.md  PLAN.md  README.md(雙語)
```
- **里程碑判據**：
  - M1 骨架：bundle 載入、/review 命令註冊、面板空 tab 出現、卸載乾淨
  - M2 單維：code 維度端到端出結構化 findings（打印到面板）
  - M3 閉環：四維並行→注入→複審→終止四路徑全演練
  - M4 面板：完整 UI + manual gate 模式
  - M4.5 v1.1：八項修復 + 設置頁（模型增減/預設/執行參數）+ resume + 智慧範圍聯調
  - M5 驗收：PRD §9 全過 + 掃描器 0 警告

## 9. 開放問題 → 定稿（2026-08-24；Q3 於 v1.1 修訂）

- Q1 ✅ **子代理會話**（方案 A：`subagents.start('spawn', …)`，outputSchema + toolFilter 只讀）
- Q2 ✅ **全自動注入**（injectMode 默認 auto；manual 保留為開關，v1.1 起可作全局預設）
- Q3 ✅ **範圍策略** — v1.0 定稿「每輪全量」；**v1.1 修訂為可配**：默認 `smart`
  （R1 全量→變更集聚焦），`full` 保留原語義。已知取捨：smart 輪對未變更文件僅快速抽查。
- Q4 ✅ **個人工具 + profile bundle**（不開源、不推 GitHub、不發 npm；v1.1 已移除 package.json repository 欄位）
