# SPEC — dsh-auto-review（自動審查官）技術規格

> 版本 v1.0（定稿）· 2026-08-24 · 四項決定已拍板：子代理審查 / 全自動注入 / 每輪全量 / 個人工具 profile bundle
> 本文所有 DSH API 均已在本機源碼/服務目錄驗證（§2），非猜測。
> 實現補充驗證（2026-08-24）：`subagents` provider 名 = **`spawn`**（dsh-subagent-spawn-in-process 默認）；
> `SubagentStartRequest.toolFilter = {allow?: string[], deny?: string[]}`；`CommandInvocation.agent` 提供觸發會話活代理；
> 消息源 `{kind:'plugin', plugin}` ✓；官方 DSW token 共 13 個 ✓。

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
| T11 | `settings.register(ns, schema)` 提供持久化配置（profile bundle 插件適用） | 服務目錄 `settings` |
| T12 | 事件：`agent/status`（idle↔running 監聽）、`agent/error`、`session/event` | 事件目錄 |

## 3. Host 設計

### 3.1 ReviewOrchestrator（狀態機）

```
idle → reviewing(R1) → aggregating → [pass?] ─yes→ passed(終態,出報告)
                                  └─no→ injecting → awaiting-fix(輪詢 targetAgent.status)
                                                    └→ reviewing(R+1, **每輪全量**) → …
任意態 → stopped(用戶) / failed(錯誤) / oscillated(同一finding×3輪) / max-rounds
```

- 每個目標會話同時只允許一個閉環（Map<sessionId, ReviewRun>）。
- awaiting-fix 期間 3s 輪詢 `agents.get(id).status`，目標代理轉 idle 後再延遲 5s 觸發下一輪（回合邊界緩衝）。
- **每輪全量**：每輪重新派 4 個審查者掃全項目，並在提示詞中附上輪 findings 指紋清單要求逐項複核。

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
| `/__review/api/start` | POST | `{session, path?, maxRounds?, gate?}` 啟動 |
| `/__review/api/stop` | POST | `{session}` 終止（cancel 審查者 + 撤監聽） |
| `/__review/api/inject` | POST | manual 模式確認注入 `{session}` |
| `/__review/api/report?session=` | GET | Markdown 完整報告 |

### 3.6 命令

- `/review [path]` — 啟動（path 省略 = 當前會話項目）
- `/review stop` / `/review status`
- 註冊前查重（commands 服務 find），衝突則改名 `/glm-review`。

### 3.7 依賴聲明

`cordis.patch.yml`（或 package.json dsh 段）：
```yaml
inject: [webServer, sessionQuery, timer]
# agents / subagents / commands / settings / llm 用 ctx.get() 可選獲取
# （閉環核心依賴 agents/subagents，但缺它們時插件應降級為「僅報告模式」而非拒啟）
```

## 4. Client 設計

- **掛載**：`conversation.view` slot，`{name:'conversation.view', id:'review', order:80, label:'審查'}`；`props.sessionId` 定位閉環。
- **佈局**：頂部輪次進度條（R n/max + 狀態膠囊）→ 四維度卡片（狀態燈 pending/reviewing/passed/findings、各嚴重度計數、可展開 findings 表）→ 注入歷史時間線 → 底部控制條（開始/停止/確認注入[manual]）。
- **樣式**：僅用 14 個官方 DSW token + dark fallback（同 ops-view 教訓）；零全局 DOM 操作。
- **通信**：全部 `host.call` → 上述 API；不複製 Slot props 大對象。

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
| zai 路由不可用/key 失效 | 啟動前 `llm.listProviders()` 預檢；失敗即面板紅字，閉環不開 |
| 審查者跑飛（超時/不返回 JSON） | 每審查者 10min 硬超時（timer）；解析失敗重試 1 次，再失敗按 failed 處理 |
| 注入與用戶手動輸入互踩 | followup 天然排隊；注入消息帶 plugin 來源；面板注入歷史可審計 |
| 目標代理長時間不 idle | awaiting-fix 超時（默認 30min）→ 暫停閉環等用戶恢復，不自動打擾 |
| Token 成本失控 | maxRounds 硬頂 + 增量審查 + 每輪 token 估計顯示；報告模式（指定 path）不注入 |
| 修復引入新問題 | 每輪全維度複審（增量範圍內），非只查舊項 |
| 插件停止時閉環在跑 | dispose 鉤子：cancel 所有審查者、撤監聽、閉環標 stopped（狀態丟失可接受，報告已落盤） |
| 併發閉環 | Map 按 sessionId 去重；start 冪等 |

## 8. 部署與驗收

- **部署**：profile bundle 模式（`pnpm add file:` + `dsh.profile.bundles` 追加 + 徵得同意後重啟）；**部署前過 `plugin-review.zsh`**。
- **目錄**：
```
dsh-auto-review/
  lib/index.js  lib/client.js  lib/prompts/{code,security,flow,design}.js
  cordis.patch.yml  package.json  docs/{PRD,SPEC}.md  PLAN.md  README.md(雙語)
```
- **里程碑判據**：
  - M1 骨架：bundle 載入、/review 命令註冊、面板空 tab 出現、卸載乾淨
  - M2 單維：code 維度端到端出結構化 findings（打印到面板）
  - M3 閉環：四維並行→注入→複審→終止四路徑全演練
  - M4 面板：完整 UI + manual gate 模式
  - M5 驗收：PRD §9 五條全過 + 開源就緒

## 9. 開放問題 → 定稿（2026-08-24）

- Q1 ✅ **子代理會話**（方案 A：`subagents.start('spawn', …)`，outputSchema + toolFilter 只讀）
- Q2 ✅ **全自動注入**（injectMode 默認 auto；manual 保留為開關）
- Q3 ✅ **每輪全量複審**
- Q4 ✅ **個人工具 + profile bundle**（不開源；開發期以動態插件熱迭代，僅最終部署需一次重啟並事先徵求同意）
