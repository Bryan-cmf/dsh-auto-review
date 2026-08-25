# dsh-auto-review（自動審查官）

**English** · An auto-review loop plugin for the DeepSeek Harness Web GUI: multiple rotating
models (default **GLM 5.3**; Kimi / Qwen / DeepSeek selectable) review your project across four
dimensions, **auto-inject optimization suggestions into the project chat** so the coding agent
fixes them, then **re-review round by round until acceptance fully passes**.

**中文** · DSH Web GUI 的審查閉環插件：多模型輪換（默認 **GLM 5.3**，可選 Kimi/Qwen/DS）
對項目產出做四維度審查，把優化建議**自動注入項目聊天框**驅動編碼代理修復，
**複審直到完全通過驗收**。

## 四個審查維度（每輪全量、並行）

| 維度 | 審什麼 |
|---|---|
| 代碼審查 | 邏輯/邊界、錯誤處理、資源洩漏、死碼、併發、依賴健康 |
| 安全性審查 | 注入、硬編碼密鑰、不受信輸入、越權暴露面、日誌洩敏 |
| 用戶流程審查 | 主流程斷點、空/錯/載入態、邊界輸入、操作可逆、反饋缺失 |
| 前端設計審查 | token 一致性、視覺層級、響應式、可訪問性、風格統一 |

## 使用

- 聊天框輸入 `/review` —— 對當前會話項目發起閉環（默認最多 5 輪，全自動注入）
- `/review stop` / `/review status` —— 終止 / 查看進度
- `/review /path/to/project` —— 報告模式（單輪，不注入）
- 會話右側「**審查**」分頁 —— 與聊天框同一閉環（同會話同步）：輪次進度、四維狀態、findings 明細、注入歷史、Markdown 報告

## 審查配置（面板發起時可選）

**審查角度**（勾選，至少一項，默認全選）：

| 角度 | 審什麼 |
|---|---|
| 代碼 | 邏輯/邊界、錯誤處理、資源洩漏、死碼、併發、依賴健康 |
| 安全 | 注入、硬編碼密鑰、不受信輸入、越權暴露面、日誌洩密 |
| 用戶流程 | 主流程斷點、空/錯/載入態、邊界輸入、可逆性、反饋缺失 |
| 前端設計 | token 一致性、視覺層級、響應式、可訪問性、風格統一 |

**審查強度**（通過線 = 哪些嚴重度會阻斷驗收）：

| 強度 | 阻斷線 | 適用 |
|---|---|---|
| 寬鬆 | 僅 critical | 快速迭代、只攔嚴重問題 |
| 標準（默認） | critical + high | 日常交付 |
| 嚴格 | critical + high + medium | 驗收交付、開源前把關 |

**審查輪次上限**：`1 / 3 / 5（默認）/ 8 / 10` 輪——全綠即提前通過；達上限仍有未過項則停。

**審查模型**（多選；默認 GLM 5.3）：

| 模型 | 路由 |
|---|---|
| GLM 5.3 / GLM 5.2 | zai |
| Kimi K3 | moonshotai |
| Qwen3.8 Max / Qwen3.7+ | qwen-token-plan |
| DS V4 | deepseek-official |

**逐輪輪換**：`第 R 輪全維度使用第 (R−1) mod 模型數 + 1 個模型`——A 模型做 R1 審查，修復後 B 模型做 R2 複審，如此類推（例如勾選 GLM 5.3 + Kimi K3：R1 四個維度全由 GLM 5.3 審，R2 全換 Kimi K3 複核——上一輪結論由另一家模型獨立驗證，盲區交叉互補）。

配置隨閉環鎖定（進行中不可改），注入文案與報告會標注本輪維度、通過線與模型。

## 閉環機制（輪次銜接 = watchFix 狀態機）

```
/review → N×GLM5.3 只讀審查代理（併發≤2，按選定角度）→ 聚合（按選定強度定通過線）
        → 有阻斷項 → 建議清單 followup 注入本會話聊天框（來源標 plugin）
        → watchFix 每 3s 輪詢目標代理狀態：修復中（running）→ 等；
          修復完（idle）→ 再緩衝 5s → 下一輪全量複審（複核上輪項）
        → 全綠 ✅ / 達輪數上限（5）/ 同一問題連續 3 輪未消除（振盪轉人工）/ 手動停止 / 修復等待 30 分鐘超時暫停
```

## 安全邊界

- 審查者工具集**只讀且 fail-closed**：`toolFilter: {allow: ['read','grep','glob']}` 硬編碼，白名單外一律不可見
- `/__review` POST 端點校驗 Origin（跨源 403）；HTTP 不接受 path 參數（項目路徑僅經本地 `/review` 命令）
- 注入消息帶資料邊界聲明 + 字段截斷（防二階提示詞注入），`plugin: dsh-auto-review` 來源標識
- 全部異常路徑收斂（launchRound/watchFix try-catch，無 unhandled rejection）
- 每審查者 15 分鐘超時；等待修復 30 分鐘超時轉暫停；單會話同時僅一個閉環
- 插件停用時：路由、命令、審查者、定時器全部撤離

## 部署 / Install

```bash
AUTO_REV_DIR=<dsh-auto-review 倉庫絕對路徑>
rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auto-review"
pnpm add --dir "${DSH_HOME:-$HOME/.dsh}/profiles/web" "file:$AUTO_REV_DIR"
# package.json 的 dsh.profile.bundles 追加 "dsh-auto-review"，重啟生效（重啟前徵得同意）
```

## 文檔

- `docs/PRD.md` — 產品需求（v1.0 定稿）
- `docs/SPEC.md` — 技術規格（v1.0 定稿，含已驗證 API 附錄）
- `PLAN.md` — 里程碑規劃


## Quick Start (English)

1. Install into your DSH web profile:
   ```bash
   AUTO_REV_DIR=<path-to>/dsh-auto-review
   rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auto-review"
   pnpm add --dir "${DSH_HOME:-$HOME/.dsh}/profiles/web" "file:$AUTO_REV_DIR"
   # add "dsh-auto-review" to dsh.profile.bundles in the profile package.json, then restart DSH
   ```
2. Type `/review` in any project session chat, or open the **Review** tab on the right.
3. Configure review dimensions / severity gate / max rounds / rotating models in the panel,
   then press **▶ Start review loop**.

Reviewers are read-only subagents (`read`/`grep`/`glob` only). Suggestions are injected into the
same session's chat as plugin-sourced user messages; after the agent finishes fixing, the next
round re-reviews with the next model in the rotation until all dimensions pass.
