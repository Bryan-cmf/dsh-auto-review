# dsh-auto-review — 審查閉環插件 · 規劃

> 狀態：**v1.0 已定稿（2026-08-24 四項決定全部拍板），進入執行**。
> 工作名 `dsh-auto-review`，中文名「自動審查官」。
>
> **定稿決定**：① 審查者=子代理會話（provider `spawn` + outputSchema + 只讀 toolFilter）
> ② 注入=全自動閉環（默認 auto，最大輪數+振盪保護）③ 範圍=**每輪全量**複審
> ④ 發行=**個人工具 + profile bundle**（不開源、不推 GitHub）。
> 開發策略：先以動態插件熱迭代（零重啟），定稿後一次性裝入 profile（重啟前徵求同意）。
>
> **執行進度（2026-08-25）**：M1-M4 完成；動態插件 `glmrev-5/pkg-20`（v0.10）已定義、
> 等頁面刷新完成切換。
>
> **v0.11 輪換語義修正（用戶定義，已實證）**：模型輪換粒度＝「輪」——A 模型做 R1
> 審查（全維度），修復後 B 模型做 R2 複審，如此類推（(round-1) mod 模型數）。
> 實證：models=[kimi-k3, glm-5.3] 時 R1 兩維度審查者 label 全帶 ·kimi-k3。
> 提示詞明示「上一輪結論由另一模型發現，你獨立複核並可補充其遺漏」；
> 注入文案標注本輪模型；面板提示改為逐輪輪換說明。
>
> **v0.10 更名（用戶定名）**：`dsh-glm-reviewer` → **`dsh-auto-review`**（目錄、package.json、
> patch id、PLUGIN_TAG、注入 source、client module id 全部同步）；品牌「GLM 審查官」→
> 「自動審查官」（多模型輪換後不再 GLM 專屬）。歷史 session log 中的舊標記
> `dsh-glm-reviewer` 保留不動（那是真實發生過的記錄）。
>
> **v0.9 新功能**：審查模型多選輪換（MODEL_PRESETS 白名單：GLM5.3/5.2、Kimi K3、
> Qwen3.8/3.7、DS V4；按 (維度序+輪次-1) mod 模型數輪換——跨維度跨輪次交叉互補）；
> 同版含 v0.8 全部：角度勾選、強度三檔、輪次上限（1/3/5/8/10）。
> 配置項四組全部貫穿：審查者派生（label 帶模型名）→聚合→注入文案→報告→面板顯示。
> 構建管線已斷言化（15 項特徵斷言全過再部署）。
> 剩餘：M5 用戶驗收 + M6 profile 部署。

## 一句話

在 DSH 裡用 **GLM 5.3** 對指定項目產出做四維審查（代碼 / 安全 / 用戶流程 / 前端設計），
把優化建議**注入項目會話聊天框**驅動編碼代理修復，**複審直到完全通過驗收**。

## 已驗證的可行性（本機源碼級確認，2026-08-24）

| 能力 | 機制 | 狀態 |
|---|---|---|
| GLM 5.3 路由 | `zai` provider 已配置（`~/.dsh/settings.yaml`，1M ctx / 128K out，`ZAI_API_KEY`） | ✅ 本機在用 |
| 強制審查者模型 | `AgentOptions = {provider, model, maxTokens}`，spawn 時傳 `{provider:'zai', model:'glm-5.3'}` | ✅ dsh-agent/runtime-types.d.ts |
| 派生審查代理 | `agents.create()` / `subagents.start()`（後者支援 `outputSchema` 結構化結果） | ✅ 服務目錄 |
| 注入聊天框 | `agent.followup(UserMessage)` — 排隊一條 user 訊息並喚醒驅動，編碼代理直接消費 | ✉ Agent 介面 |
| 等待修復完成 | `agent.whenIdle()` + `agent/status` 事件 | ✅ |
| 觸發入口 | `commands.register()`（聊天框 `/review` 命令）+ conversation.view 面板按鈕 | ✅ |
| 項目定位 | `sessionQuery.listSessions()` → `header.cwd`（artifact-view 已驗證同款） | ✅ |
| 前端面板 | `conversation.view` slot（ops=60、artifacts=70 → review=**80**） | ✅ |

## 里程碑

```
M0 討論定稿   ── 本輪 ──► PRD/SPEC 簽字，4 個開放問題關閉
M1 骨架        cordis 插件骨架 + profile bundle 部署鏈 + /review 命令殼
M2 審查引擎    單維度（代碼審查）跑通：spawn GLM 5.3 審查者 → 結構化 findings
M3 閉環        四維度並行 + 聚合 + followup 注入 + whenIdle 複審迴圈 + 停止條件
M4 面板        conversation.view 審查面板（輪次/維度/發現/控制）
M5 驗收        端到端演練（真項目、注入、修復、複審通過）+ 掃描器通過
M6 部署        pnpm add + bundles 追加 + 徵求同意後重啟（唯一一次重啟）
```

每個里程碑的完成判據見 `docs/SPEC.md §9`。

## 鐵律遵從（本插件相關）

1. 不觸發任何服務重啟；插件部署需重啟時**先徵求同意**。
2. 推 GitHub 前先問；README 雙語（中英）。
3. 所有副作用可逆：路由、命令、監聽器全部 `ctx.effect()` / disposer 包裹（殭屍路由教訓）。
4. 審查者代理**只讀不改**：spawn 時 restrict 工具集，提示詞二次約束。
5. 注入聊天框 = 模仿用戶輸入，等效於你親自發消息 —— 這是高權限動作，預設開關形態待討論（PRD Q2）。

## 交付物

- `docs/PRD.md` — 產品需求（本輪）
- `docs/SPEC.md` — 技術規格（本輪）
- `lib/index.js` + `lib/client.js` — M1 起
