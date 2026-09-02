# dsh-auto-review — 審查閉環插件 · 規劃

> 狀態：**v1.0 已定稿（2026-08-24 四項決定全部拍板），進入執行**；**v1.1.0 優化批次完成（見下）**。
> 工作名 `dsh-auto-review`，中文名「自動審查官」。
>
> **定稿決定**：① 審查者=子代理會話（provider `spawn` + outputSchema + 只讀 toolFilter）
> ② 注入=全自動閉環（默認 auto，最大輪數+振盪保護）③ 範圍=每輪全量複審（v1.1 演進為可配：智慧/全量）
> ④ 發行=**個人工具 + profile bundle**（不開源、不推 GitHub）。
> 開發策略：先以動態插件熱迭代（零重啟），定稿後一次性裝入 profile（重啟前徵求同意）。
>
> **v1.1.0 優化批次（2026-08-26，八項修復 + 設置頁）**：
> - A1 idle 賽窗：watchFix 必須先觀察到一次 running 才承認其後 idle（45s 寬限兜底「極快完成」）
> - A2 活動型超時：等待修復期限隨目標代理每次 running 順延（30 分鐘固定值不再誤殺長修復）
> - A3 指紋健壯化：`file+正規化title` 初級指紋 ∪ `file+行號桶+severity` 二級錨點——
>   跨模型輪換的措辭漂移不再擊穿振盪保護
> - A4 可恢復閉環：paused（等修復超時/代理離線）與 interrupted（重啟中斷）皆可
>   `/review resume`（round+1 續審當前狀態）＋面板「恢復閉環」按鈕
> - B 智慧範圍（scope=smart，新默認）：R1 全量 → 後續輪 git 變更集（diff+未跟蹤；
>   非 git 倉庫退 find -newermt；失敗自動降級全量），報告標注每輪實際範圍
> - C1 provider 預檢：llm.listProviders() 啟動前校驗所選模型路由，缺失即拒啟（fail-fast）
> - C2 最小持久化：配置 + 中斷閉環快照存 settings 命名空間 `dsh-auto-review`
>   （schemastery schema；動態模式內存降級）；注入邊界落快照，重啟後面板顯示可恢復
> - C3 設置頁：DSH 設置 → 自動審查（settings.section order 90）——自訂模型增減、
>   默認模型多選、強度/輪次/範圍/注入模式預設、併發與超時執行參數
> - D 發行就緒：版本註釋同步 v1.1、package.json 移除 repository（Q4 不開源）、
>   增加 @deepseek-ai/schemastery 依賴、README/SPEC/PRD 全量更新
>
> **執行進度**：M1-M4 完成；v1.1.0 代碼完成，**M5 用戶驗收 + M6 profile 部署待跑**。
>
> **v0.11 輪換語義修正（用戶定義，已實證）**：模型輪換粒度＝「輪」——A 模型做 R1
> 審查（全維度），修復後 B 模型做 R2 複審，如此類推（(round-1) mod 模型數）。
> 實證：models=[kimi-k3, glm-5.3] 時 R1 兩維度審查者 label 全帶 ·kimi-k3。
> 提示詞明示「上一輪結論由另一模型發現，你獨立複核並可補充其遺漏」（單模型時措辭自動退化）；
> 注入文案標注本輪模型；面板提示改為逐輪輪換說明。
>
> **v0.10 更名（用戶定名）**：`dsh-glm-reviewer` → **`dsh-auto-review`**（目錄、package.json、
> patch id、PLUGIN_TAG、注入 source、client module id 全部同步）；品牌「GLM 審查官」→
> 「自動審查官」（多模型輪換後不再 GLM 專屬）。歷史 session log 中的舊標記
> `dsh-glm-reviewer` 保留不動（那是真實發生過的記錄）。
>
> **v0.9 新功能**：審查模型多選輪換（MODEL_PRESETS 白名單）；同版含 v0.8 全部：
> 角度勾選、強度三檔、輪次上限（1/3/5/8/10）。配置項四組全部貫穿：
> 審查者派生（label 帶模型名）→聚合→注入文案→報告→面板顯示。

## 一句話

在 DSH 裡用多模型輪換（默認 **GLM 5.3**，可自訂增減）對指定項目產出做四維審查
（代碼 / 安全 / 用戶流程 / 前端設計），把優化建議**注入項目會話聊天框**驅動編碼代理修復，
**複審直到完全通過驗收**。

## 已驗證的可行性（本機源碼級確認，2026-08-24；v1.1 增補見 SPEC §2）

| 能力 | 機制 | 狀態 |
|---|---|---|
| GLM 5.3 路由 | `zai` provider 已配置（`~/.dsh/settings.yaml`，1M ctx / 128K out，`ZAI_API_KEY`） | ✅ 本機在用 |
| 強制審查者模型 | `AgentOptions = {provider, model, maxTokens}`，spawn 時傳 `{provider:'zai',model:'glm-5.3'}` | ✅ dsh-agent/runtime-types.d.ts |
| 派生審查代理 | `agents.create()` / `subagents.start()`（後者支援 `outputSchema` 結構化結果） | ✅ 服務目錄 |
| 注入聊天框 | `agent.followup(UserMessage)` — 排隊一條 user 訊息並喚醒驅動，編碼代理直接消費 | ✉ Agent 介面 |
| 等待修復完成 | `agent.whenIdle()` + `agent/status` 事件（v1.1 實現採輪詢+狀態追蹤，見 SPEC §3.1） | ✅ |
| 觸發入口 | `commands.register()`（聊天框 `/review` 命令）+ conversation.view 面板按鈕 | ✅ |
| 項目定位 | `sessionQuery.listSessions()` → `header.cwd`（artifact-view 已驗證同款） | ✅ |
| 前端面板 | `conversation.view` slot（ops=60、artifacts=70 → review=**80**） | ✅ |
| 設置頁 | `settings.section` slot（list 註冊 `{id, order:90, label}`；組件 props 收 `{close}`） | ✅ v1.1 |
| 配置持久化 | `settings.register(ns, schemasterySchema)` → `{get,watch,update}`；ns='dsh-auto-review' | ✅ v1.1 |
| 變更集偵測 | fs 服務無 mtime → `shell.resolve({command,workdir}) + run()`（git 優先，find -newermt 兜底） | ✅ v1.1 |
| provider 預檢 | `llm.listProviders(): {id,name}[]` | ✅ v1.1 |

## 里程碑

```
M0 討論定稿   ── ✅ ── PRD/SPEC 簽字，4 個開放問題關閉
M1 骨架        ✅ cordis 插件骨架 + profile bundle 部署鏈 + /review 命令殼
M2 審查引擎    ✅ 單維度（代碼審查）跑通：spawn 審查者 → 結構化 findings
M3 閉環        ✅ 四維度並行 + 聚合 + followup 注入 + watchFix 複審迴圈 + 停止條件
M4 面板        ✅ conversation.view 審查面板（輪次/維度/發現/控制）
M4.5 v1.1 優化 ✅ 八項修復（A1-A4/B/C1-C2）+ 設置頁（C3）+ 發行就緒（D）
M5 驗收        ✅ 三輪真實運行通過（docs/ACCEPTANCE.md，2026-09-02 定稿）
M6 部署        pnpm add + bundles 追加 + 徵求同意後重啟（唯一一次重啟）
```

每個里程碑的完成判據見 `docs/SPEC.md §9`。

## 鐵律遵從（本插件相關）

1. 不觸發任何服務重啟；插件部署需重啟時**先徵求同意**。
2. 不推 GitHub（Q4 個人工具）；README 雙語（中英）。
3. 所有副作用可逆：路由、命令、監聽器、設置註冊全部 `ctx.effect()` / disposer 包裹（殭屍路由教訓）。
4. 審查者代理**只讀不改**：spawn 時 restrict 工具集，提示詞二次約束。
5. 注入聊天框 = 模仿用戶輸入，等效於你親自發消息 —— 高權限動作，默認 auto（Q2 定稿），
   manual 模式 + 設置頁可切。

## 交付物

- `docs/PRD.md` — 產品需求
- `docs/SPEC.md` — 技術規格（含已驗證 API 附錄）
- `lib/index.js` + `lib/client.js` — host/client 半（M1 起；v1.1 含設置頁）
