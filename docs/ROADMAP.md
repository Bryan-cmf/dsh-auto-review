# ROADMAP — dsh-auto-review 功能完善路線圖

> 依據：PRD/SPEC/README 對照實際實現的差距 + v1.2 審查（FINDINGS-v1.2.md）發現的改進機會。
> 優先級：P0 必須 / P1 應該 / P2 可以。工作量：S（<半天）/ M（1–2 天）/ L（3 天+）。

## P0 — 必須

### P0-1 真實端到端閉環驗收（PRD M5）
- **現狀**：全部驗證為進程內模擬（smoke/loop-sim/resume-sim，共 9 場景 84 斷言）；PRD §9 的六條 M5 驗收（真實會話 /review → 注入 → 修復 → 複審 → 全綠終止 + 停止三路徑 + 卸載乾淨 + 掃描器 0 警告）未在真實 DSH 上演練。
- **方案**：部署 profile bundle 後（需用戶同意重啟），在一個真實項目會話跑完整閉環 + 三條終止路徑 + 停用撤離檢查。
- **工作量**：M。**依賴**：用戶授權重啟 DSH（本輪鐵律禁止）。

## P1 — 應該

### P1-1 GET 端點 Host 校驗（M1）
- **現狀**：`/__review/api/{state,list,report,config}` 零校驗；DNS rebinding 可繞同源讀取 projectPath / findings。
- **方案**：handler 入口校驗 `req.headers.host` 的 hostname ∈ {127.0.0.1, localhost, harness.best-thinktank.com}（與 ALLOWED_ORIGIN_HOSTS 復用），否則 403。一行式防線。
- **工作量**：S。**依賴**：無。

### P1-2 watchFix 絕對上限雙軌（M2）
- **現狀**：deadline 隨 running 無限順延；代理 hang 死於 running 時閉環無界等待、面板無提示。
- **方案**：注入時記 `hardDeadline = now + 3×fixWaitMs`（絕對、不順延）；輪詢中 `Date.now() > hardDeadline` → paused（文案註明「長期無進展，可 resume 或檢查代理」）。正常活動順延語義保留。
- **工作量**：S（loop-sim 補 1 場景：連續 running 超 hardDeadline → paused）。**依賴**：無。

### P1-3 injectNow 錯誤保護（M3）
- **現狀**：`followup()` 未 await、三個調用點（runRound / HTTP inject / RPC inject）拋錯路徑無保護 → 響應掛起 + unhandled rejection。
- **方案**：injectNow 改 async 返回 promise；三處 `await` + catch → `{ok:false,error}` / failed 終態。
- **工作量**：S。**依賴**：無。

### P1-4 token 成本可見（PRD N2，未實現）
- **現狀**：面板無任何 token 消耗信息；閉環自動多輪（每輪 4 審查者）成本黑箱。
- **方案**：從 SubagentRun 結果/usage（或 llm 服務統計）取每審查者 token 數，累計入 run；面板與報告展示每輪/累計成本。
- **工作量**：M。**依賴**：確認 spawn SubagentRun 是否暴露 usage 字段（需查 dsh-subagent types）。

### P1-5 快照粒度：每輪啟動前落盤
- **現狀**：快照僅在注入邊界落盤；reviewing 中途重啟 → 該輪丟失，resume 回退到上一注入點。
- **方案**：`launchRound` 入口 best-effort 落快照（帶 status），resume 時據此續審。
- **工作量**：S。**依賴**：無。

### P1-6 passed 終態會話內通告
- **現狀**：全綠只體現在面板；用戶不看面板不知閉環已通過（SPEC §6 曾規劃 steer 一次摘要）。
- **方案**：passed 時向目標會話 followup 一條簡短通告（帶 plugin 來源 + 報告摘要），或在面板外發系統提示。
- **工作量**：S。**依賴**：P1-3（同一注入通道加固）。

## P2 — 可以

### P2-1 設置頁持久化故障可見（M4）
- **現狀**：settings 寫入失敗與動態模式同顯「僅本次運行有效」，故障被掩蓋。
- **方案**：commitConfig 區分降級原因（`dynamic` vs `write-error`），設置頁後者顯示紅字。
- **工作量**：S。

### P2-2 非 git 變更集可靠性（L4 + 時鐘語義）
- **現狀**：`find -newermt` 依賴本地時鐘/時區；`head -c 60000` 可截半行；PRD v1.0 的掃描深度上限未實現。
- **方案**：改 `head -n 300` + 截斷丟尾行；提示詞附「清單可能不完整」聲明；可選記錄每輪文件 mtime 基線替代時間戳。
- **工作量**：S。

### P2-3 面板報告渲染
- **現狀**：報告以 `<pre>` 純文本展示 Markdown 原文。
- **方案**：輕量 MD→React 渲染（表格/標題/顏色 severity），或至少 severity 著色 + 表格等寬對齊；附「複製/導出 .md」按鈕。
- **工作量**：M。

### P2-4 跨會話閉環總覽 UI
- **現狀**：`review-list` API（active + finished 全會話）已存在，無任何 UI 入口。
- **方案**：ops 風格總覽卡片（各會話狀態/輪次/blocking 數），可作為 conversation.view 閒置態的下半區或獨立入口。
- **工作量**：M。

### P2-5 審查者提示詞/checklist 可配置化
- **現狀**：四維 checklist 硬編碼於 DIMENSIONS；用戶無法增刪維度或調整檢查項（面板僅可選維度子集）。
- **方案**：checklist 進 settings 命名空間（自訂維度 id/label/checklist），提示詞組裝讀配置；保持 outputSchema dimension enum 動態化。
- **工作量**：M–L。**依賴**：P1-4 之後一起做配置 schema 擴展更順。

### P2-6 自動觸發（PRD §7 延後項）
- **現狀**：僅手動 /review 與面板按鈕。
- **方案**：opt-in 預設（監聽會話 idle/交付事件 → 自動發起 smart 範圍審查），配冷卻窗口防風暴。
- **工作量**：M。**依賴**：P0-1 端到端驗收先完成。

### P2-7 低成本清理批次（L1/L2/L3/L5/L6）
- 5s 下一輪 timer 入 run.watchers；刪 mergeModels 死語句；later() 空值兜底；文檔漂移（token 13/14、超時 10–240 vs 5–720）修正；cache 淘汰。**工作量**：S（一個 commit）。

### P1-7 面板審查匯報美化（用戶反饋 2026-09-02）
- **現狀**：每個維度卡片下方的審查者 summary 是整段原始文字直接渲染——資訊密度低、視覺雜亂（「一堆的文字，很不美觀」）；findings 明細排版也偏擠。
- **方案**：① summary 默認截斷 2 行 + 「展開/收起」（點擊切換），展開態等寬排版；② 長文字（title/detail/suggestion）分行留白、severity 色標左移成豎條；③ 高/寬密度收緊（padding/行高/分組間距），與 DSW token 對齊；④ 報告區由純 `<pre>` 改為基本 Markdown 渲染（粗體/表格/標題）。
- **工作量**：S–M（僅 client.js DimCard/報告區）。

### P1-8 聚合跨維度去重（驗收分析 2026-09-02）
- **現狀**：同一問題被多個維度各報一次（實證：R1「無鑑權」代碼+安全各一條、R2 token 繞過同樣撞車；:1365 同端點兩角度）→ 阻斷數虛增 20–30%、修復代理重複處理同一修法。
- **方案**：聚合階段 fingerprint（file+正規化 title）跨維度合併，注入清單標注「⚠ 代碼+安全共同指出」，計數按合併後算。
- **工作量**：S。

### P1-9 項目級「明確不修」ignore 清單（驗收分析 2026-09-02）
- **現狀**：「二階注入」在 FINDINGS 已判「明確不修（有源碼級理由）」，但輪換的新模型不知道該決策，三輪反覆翻舊賬（high→四層緩解→降 medium），浪費模型調用與修復工時；本輪又以「過濾規則過寬」變體復現。
- **方案**：`.reviewignore`（或 settings 配置）記錄已知接受項（pattern+理由），組裝審查提示詞時附「以下已知且已接受，除非惡化否則不再報」，報告中單獨歸類。
- **工作量**：S–M。

### P1-10 審查模型次序控制（用戶反饋 2026-09-02）
- **現狀**：輪換順序 = 面板勾選的固定陣列順序，用戶無法指定「哪個模型先審、哪個後審」（例如想讓最強的 GLM-5.3 打頭陣建立基線、Kimi 複核、Qwen 收尾）。
- **方案**：① 面板模型選擇改為可排序（勾選後拖拽/上下移按鈕確定輪換次序），顯示「R1→R2→R3…」預覽；② 設置頁默認陣容同步可排序；③ startRun 以顯式順序構建 run.models（後端已按陣列序輪換，主要改 client 交互 + 配置存儲有序化保證）。
- **工作量**：S–M（集中 client.js；注意 defaultModels 數組順序即次序，序列化保序）。

### P1-11 修復範圍檔位（與通過線解耦）（用戶反饋 2026-09-02）
- **現狀**：注入修復清單 = 通過線（強度）攔下的 blocking 項——「寬鬆」只修 critical、「標準」修 critical+high；medium/low 即使被發現也不會自動修（除非開「嚴格」把 medium 也變阻斷項，但那會同時改變驗收口徑）。用戶想要「過程中把 medium/low 也自動修掉，但不改變驗收通過線」。
- **方案**：新增獨立配置 `fixScope`：`blocking-only（默認，現行為）/ +medium / +medium+low（全修）`。注入清單按 fixScope 組裝（全綠判定仍按強度 gate，不受影響）；low/medium 修復項在注入文案中單獨分組標注「非阻斷、順帶修復」；面板與設置頁各加一組三檔切換；roundLog/injectLog 記錄分組計數。
- **工作量**：M（host 聚合/注入/報告 + client 兩處 UI + 配置 schema/持久化 + 測試）。

### P1-12 審查頁「每輪修復報告」時間線（用戶反饋 2026-09-02）
- **現狀**：面板只顯示「當前輪」的維度狀態與 findings（每輪覆蓋上一輪），歷史只剩注入歷史一行字（R1·8項 R2·4項…）；roundLog 在 host 有數據（每輪 scope/changedCount/blockingByDim）但未暴露；用戶看不出「每一輪發現了什麼、修了什麼、確認修好什麼」。
- **方案**：① host：injectLog 擴展為攜帶該輪注入項快照（severity/file/title 分組清單）+ publicRun 暴露完整 roundLog（含每輪 vs 上輪的 resolved 差值）；② client：面板新增「輪次時間線」區塊——每輪一張可摺疊卡：值班模型、範圍（全量/聚焦 n 檔）、發現數、注入數、較上輪修復確認數（綠色 ↓）、摺疊展開逐項清單（severity 色標 + file:line + title + resolved 狀態）；③ 報告 Markdown 同步輸出每輪段落。
- **工作量**：M（host 數據保留/暴露 + client 時間線 UI）。**依賴**：與 P1-7 美化同片區域，建議同批實施。

## 建議節奏

1. **下一個修復批次**（一次 S 級 commit 群）：P1-1 / P1-2 / P1-3 / P1-5 / P2-1 / P2-7 —— 全部小改動、彼此獨立、消除全部殘餘 MEDIUM。
2. **隨後**：P0-1 端到端驗收（需重啟授權）→ P1-4 成本可見 → P2-3/P2-4 面板體驗 → P2-5/P2-6 進階能力。
