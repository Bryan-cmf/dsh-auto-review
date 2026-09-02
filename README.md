# dsh-auto-review（自動審查官）

**English** · An auto-review loop plugin for the DeepSeek Harness Web GUI: multiple rotating
models (default **GLM 5.3**; Kimi / Qwen / DeepSeek selectable, custom models addable) review
your project across four dimensions, **auto-inject optimization suggestions into the project
chat** so the coding agent fixes them, then **re-review round by round until acceptance fully
passes**. Smart scope (R1 full → change-set focused) keeps token cost sane.

**中文** · DSH Web GUI 的審查閉環插件：多模型輪換（默認 **GLM 5.3**，可選 Kimi/Qwen/DS，
可在設置頁增減自訂模型）對項目產出做四維度審查，把優化建議**自動注入項目聊天框**驅動編碼
代理修復，**複審直到完全通過驗收**。

## 四個審查維度（每輪全量或聚焦、並行）

| 維度 | 審什麼 |
|---|---|
| 代碼審查 | 邏輯/邊界、錯誤處理、資源洩漏、死碼、併發、依賴健康 |
| 安全性審查 | 注入、硬編碼密鑰、不受信輸入、越權暴露面、日誌洩敏 |
| 用戶流程審查 | 主流程斷點、空/錯/載入態、邊界輸入、操作可逆、反饋缺失 |
| 前端設計審查 | token 一致性、視覺層級、響應式、可訪問性、風格統一 |

## 使用

- 聊天框輸入 `/review` —— 對當前會話項目發起閉環（默認最多 5 輪，全自動注入）
- `/review stop` / `/review status` —— 終止 / 查看進度
- `/review resume` —— **恢復**「暫停」（等修復超時/代理離線）或「重啟中斷」的閉環，
  從下一輪複審當前狀態
- `/review /path/to/project` —— 報告模式（單輪，不注入）
- 會話右側「**審查**」分頁 —— 與聊天框同一閉環（同會話同步）：輪次進度、四維狀態、
  findings 明細、**輪次時間線**（v1.4：每輪一張可摺疊卡——值班模型、範圍、發現/注入數、
  較上輪確認修復數、逐項清單與「順帶修復」分組）、Markdown 報告；暫停/中斷後有「恢復閉環」按鈕
- **設置 → 自動審查**（DSH 設置頁新分區）—— 模型增減與全部預設（見下）

## 設置頁（設置 → 自動審查）

| 分組 | 內容 |
|---|---|
| 審查模型 | **對齊 DSH 配置**（`discoverModels()` 從 `llm.listProviders()`/`listModels()` 動態彙整可用模型；已下架/路由缺失的會被剔除）＋ **自訂模型增減**（provider + model id + 顯示名）；默認審查模型**可排序多選**（v1.4：↑↓ 調次序，數組順序 = 輪換順序） |
| 閉環預設 | 審查強度、輪次上限、**審查範圍（智慧/全量）**、**修復範圍 fixScope（v1.4）**、注入模式（全自動/人工確認） |
| 執行參數 | 審查者併發（1–4）、審查者超時（5–60 分）、等待修復超時（5–720 分，活動順延） |

配置經 settings 服務**持久化**（`dsh-auto-review` 命名空間），重啟後保留；發起閉環時
對所選模型做 **provider 路由 + 模型可用性雙重預檢**（`listProviders` 校驗路由、`listModels`
過濾已下架/不可用模型），路由缺失或清單為空即拒啟（fail-fast）。另在 `reviewDimension` 內做
**運行時模型降級**：輪換到的模型 spawn 失敗會自動嘗試下一可用模型，全部失敗才終止。
動態調試模式下配置僅本次運行有效（面板會提示）。

## 審查範圍（v1.1 新增）

| 範圍 | 行為 | 適用 |
|---|---|---|
| **智慧（默認）** | R1 全量建立基線 → 後續輪聚焦**變更集**（git diff + 未跟蹤文件；非 git 倉庫退 `find -newermt`）＋複核上輪未過項 | 日常迭代，大幅省 token |
| 全量 | 每輪全項目複審（v1.0 行為） | 驗收交付、開源前把關 |

變更集收集失敗（無 shell 服務/命令失敗）自動降級為全量，報告標注每輪實際範圍。

## 審查配置（面板發起時可選，初始值來自設置頁）

**審查角度**（勾選，至少一項，默認全選）：代碼 / 安全 / 用戶流程 / 前端設計

**審查強度**（通過線 = 哪些嚴重度會阻斷驗收）：寬鬆（僅 critical）/ 標準（critical+high，
默認）/ 嚴格（critical+high+medium）

**審查輪次上限**：`1 / 3 / 5（默認）/ 8 / 10` 輪——全綠即提前通過；達上限仍有未過項則停。

**審查模型**（多選；默認 GLM 5.3；清單對齊 DSH 配置的可用模型，自訂模型來自設置頁）；
**v1.4 次序控制**：面板/設置頁的模型選擇為**有序清單**（↑↓ 調整、✕ 移除，附
「輪換次序：R1 A → R2 B（依序循環）」預覽）——提交順序即輪換順序。

**逐輪輪換**：`第 R 輪全維度使用第 (R−1) mod 模型數 + 1 個模型`——A 模型做 R1 審查，修復後
B 模型做 R2 複審，如此類推（上一輪結論由另一家模型獨立驗證，盲區交叉互補）。輪到某模型
spawn 失敗時，會自動降級到輪換序列中的下一可用模型（運行時兜底），不會因此中斷閉環。

**修復範圍 fixScope（v1.4，與通過線解耦）**：`只修阻斷（默認，現行為）/ +Medium / 全修`。
- 只修阻斷：注入清單 = 通過線攔下的阻斷項（原 v1.3 行為）
- +Medium：另把非阻斷的 medium 一併列入修復清單
- 全修：非阻斷項全部列入（= 通過線補集；寬鬆線下的 high 也會順帶修）
順帶項在注入清單中**單獨分組「非阻斷 · 順帶修復」**（可說明後跳過）；**驗收通過線與
振盪檢測不受檔位影響**——全綠判定仍只看 gate 阻斷項。

配置隨閉環鎖定（進行中不可改），注入文案與報告會標注本輪維度、通過線、範圍、修復範圍與模型。

## v1.4 新功能（P1-7 ~ P1-12）

- **聚合跨維度去重**：同一問題被多個維度各報一次時自動合併為一條，標注「⚠ 代碼+安全
  共同指出」——阻斷計數不再虛增、修復代理不重複處理同一修法（同指紋但行號相距遠的視為
  兩處問題不合併；合併後嚴重度取各來源最高）。
- **項目級「明確不修」清單 `.reviewignore`**：倉庫根放置，每行 `file glob` 或
  `src/app.js|問題標題` 指紋模式 + 可選 ` # 理由`；命中項不再注入修復、不阻擋驗收，審查者
  提示詞會附「已知且已接受，除非明顯惡化否則不再報告」清單，報告與注入文案單獨分組展示
  （含理由）。範例：

  ```gitignore
  # .reviewignore
  src/legacy/**            # 歷史遺留模組，明確不修
  src/app.js|未處理的空值引用導致崩潰  # 已評估接受，風險可控
  dist/                    # 目錄前綴（等價 dist/**）
  ```

- **審查頁「輪次時間線」**：每輪一張可摺疊卡——值班模型、範圍（全量/聚焦 n 檔）、發現數
  （跨維度合併後）、注入數＋順帶數、較上輪確認修復數（綠色 ↓）、已接受數；展開見逐項
  清單（嚴重度色標 + file:line + 標題 +「⚠ A+B 共同指出」+ resolved 狀態）與「順帶修復」分組。
- **面板美化**：維度摘要兩行截斷＋展開、findings 嚴重度豎條色標與分行留白、報告區
  Markdown 渲染（標題/粗體/表格/severity 色標）、設置頁如實的保存狀態標記。
- **審查模型次序控制**（見上「審查模型」）與 **fixScope 修復範圍檔位**（見上）。


## 閉環機制（輪次銜接 = watchFix 狀態機，v1.1 加固）

```
/review → N×審查模型 只讀審查代理（併發可配，按選定角度）→ 聚合（按選定強度定通過線）
        → 有阻斷項 → 建議清單 followup 注入本會話聊天框（來源標 plugin）
        → watchFix 每 3s 輪詢：必須先見到目標代理 running 才承認其後的 idle
          （防注入未消化即複審的賽窗；45s 寬限兜底極快完成）；每次 running 順延等待期限
          → idle + 5s 緩衝 → 下一輪複審（智慧範圍=變更集聚焦；複核上輪項）
        → 全綠 ✅ / 達輪數上限 / 同一問題連續 3 輪未消除（振盪轉人工；指紋+位置錨點
          雙級匹配，跨模型措辭漂移不擊穿）/ 手動停止 / 等修復超時→暫停（可 resume）
重啟恢復：注入邊界落快照（settings 持久化）→ 重啟後面板顯示「重啟中斷」→ /review resume 續審
```

## 安全邊界

- 審查者工具集**只讀且 fail-closed**：`toolFilter: {allow: ['read','grep','glob']}` 硬編碼，白名單外一律不可見
- `/__review` POST 端點校驗 Origin（hostname 精確白名單 `127.0.0.1`/`localhost`/`harness.best-thinktank.com`（僅 https），任意埠；跨源與前綴偽造一律 403）；HTTP 不接受 path 參數（項目路徑僅經本地 `/review` 命令）
- 注入消息帶資料邊界聲明 + 字段截斷（防二階提示詞注入），`plugin: dsh-auto-review` 來源標識
- 全部異常路徑收斂（launchRound/watchFix try-catch，無 unhandled rejection）
- 變更集命令僅含時間戳常量（無外部輸入拼接），workdir 走參數通道
- 插件停用時：路由、命令、審查者、定時器、設置註冊全部撤離；進行中閉環先落快照再停

## 部署 / Install

```bash
AUTO_REV_DIR=<dsh-auto-review 倉庫絕對路徑>
rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auto-review"
pnpm add --dir "${DSH_HOME:-$HOME/.dsh}/profiles/web" "file:$AUTO_REV_DIR"
# package.json 的 dsh.profile.bundles 追加 "dsh-auto-review"，重啟生效（重啟前徵得同意）
```

## 文檔

- `docs/PRD.md` — 產品需求
- `docs/SPEC.md` — 技術規格（含已驗證 API 附錄）
- `PLAN.md` — 里程碑規劃


## Quick Start (English)

1. Install into your DSH web profile:
   ```bash
   AUTO_REV_DIR=<path-to>/dsh-auto-review
   rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-auto-review"
   pnpm add --dir "${DSH_HOME:-$HOME/.dsh}/profiles/web" "file:$AUTO_REV_DIR"
   # add "dsh-auto-review" to dsh.profile.bundles in the profile package.json, then restart DSH
   ```
2. Open **Settings → Auto Review** to add/remove review models and set defaults
   (gate / max rounds / scope / inject mode / concurrency / timeouts).
3. Type `/review` in any project session chat, or open the **Review** tab on the right.
4. Configure review dimensions / severity gate / max rounds / rotating models in the panel,
   then press **▶ Start review loop**. Paused or restart-interrupted loops resume with
   `/review resume` or the panel button.

Reviewers are read-only subagents (`read`/`grep`/`glob` only). Suggestions are injected into the
same session's chat as plugin-sourced user messages; after the agent finishes fixing, the next
round re-reviews with the next model in the rotation until all dimensions pass.
