# FINDINGS — dsh-auto-review v1.2 修復輪（定稿）

> 範圍：v1.1 → v1.2 修復輪（t1 三項已知缺陷 + t5 阻斷級修復）。
> 審查方法：read-only 四維度（代碼正確性 / 安全性 / 用戶流程 / 設計一致性）；
> 驗證證據：`scripts/smoke.mjs`（語法 + 樁啟動/撤離）、`scripts/loop-sim.mjs`（閉環狀態機 5 場景 28 斷言）、
> `scripts/resume-sim.mjs`（恢復 + 持久化 4 場景 28 斷言）。三套於定稿前重跑全部通過 ✅。
>
> 狀態標記：**已修** / **誤報** / **記待辦**（轉入 ROADMAP）。

## 0. 本輪修復的三項已知缺陷（t1）

| # | 缺陷 | 修法 | 狀態 | 驗證證據 |
|---|---|---|---|---|
| B1 | 煙霧測試壞損（幻覺具名導入 `import { z }`，schemastery 僅 default 導出 → 重啟崩潰循環） | 改 default import + smoke 保留「無具名導出 z」防線斷言 | **已修** | smoke.mjs §0：`SMZ_PKG.z === undefined` ✓ |
| B2 | settings 註冊時序競態（apply 時 `ctx.get('settings')` 一次性求值，服務晚掛 → persisted=false） | 改官方 `ctx.inject(['settings'], fn)` 響應式掛接：服務出現時註冊、撤離時 dispose 降級內存 | **已修** | resume-sim 場景④：settings 註冊 live、config persisted=true、配置補丁經 scope.update 持久化 ✓ |
| B3 | 靜默吞錯（閉環異常路徑無收斂） | `launchRound` catch 收斂到 failed 終態（stopping 路徑保留 stopped）；RPC 統一 catch → `{ok:false,error}` | **已修** | loop-sim 各異常場景收斂 ✓；smoke 樁撤離乾淨 ✓ |

閉環核心語義（注入→修復→+5s→自動 R2、round 遞增、模型輪換、A1 寬限、A2 順延、A3 指紋振盪、resume 四條拒絕路徑）：loop-sim 5 場景 + resume-sim 4 場景全過 ✅。

## 1. t4 審查 findings 與 t5 處置（按嚴重度）

### HIGH

- **H1 · lib/index.js（原 1064-1067）· Origin 前綴比對可繞過** —— `startsWith('http://localhost')` 放行 `http://localhost.evil.com`；POST 端點接受 text/plain 簡單請求（無 preflight）→ 跨站寫 CSRF 直達 start/stop/resume/config-set。→ **已修（t5）**：新增 `ALLOWED_ORIGIN_HOSTS = {127.0.0.1, localhost, harness.best-thinktank.com}`，用 `new URL(origin).hostname` 精確比對（任意埠放行；遠端主機僅 https）。殘餘細節見 §3-R1。

### MEDIUM（全部**記待辦**，t5 僅修阻斷級，轉入 ROADMAP P1/P2）

- **M1 · index.js:1081-1096 · GET 端點零校驗** —— 本機進程可直讀 state/list/report/config；瀏覽器側無 CORS 頭不可讀，但 DNS rebinding（Host 未校驗）可繞。洩露面：projectPath、sessionId、findings（安全審查者可能轉述倉庫內密鑰位置）。→ 建議 Host 白名單一行式防線（ROADMAP P1-1）。
- **M2 · index.js:886-892 · watchFix deadline 分支實質不可達** —— running 每 3s 順延 deadline，hang 死 running 的代理永不觸發暫停，閉環無界等待（t2 模擬亦證實：idle 路徑必然先命中）。→ 建議雙軌：活動順延 + 絕對總上限（如 3×fixWaitMs）（ROADMAP P1-2）。
- **M3 · index.js:861-874 / 1145-1148 · injectNow followup 未 await 且無錯誤保護** —— HTTP /api/inject 的 async IIFE 無 try/catch：followup 同步拋錯 → 響應掛起 + unhandled rejection；異步拒絕同樣無人接。→ 建議 injectNow 返回 promise，三個調用點 await + catch（ROADMAP P1-3）。
- **M4 · client.js:445 + index.js:419-429 · persisted=false 文案歧義** —— bundle 模式 settings 寫入失敗（故障）與動態調試模式（預期）同顯「僅本次運行有效」。→ commitConfig 區分降級原因（ROADMAP P2-1）。

### LOW（全部**記待辦**，均不阻斷）

- **L1** · index.js:896-901 · watchFix idle 後 5s 下一輪 timer 未入 run.watchers——有 `runs.get()===run && !stopping` 身份檢查護欄，安全但不對稱。
- **L2** · client.js:171 · `mergeModels` 死語句 `(list||[]).concat;`（無副作用）。
- **L3** · client.js:96-98 · `later()` 依賴 pluginCtx，apply 先於 UI 執行故實際不可達；可加空值兜底。
- **L4** · index.js:737 · 非 git 降級 `head -c 60000` 可截斷半行 → 殘缺文件名進提示詞；建議 `head -n 300`。
- **L5** · 文檔漂移：SPEC「14 官方 token」vs client 註釋「13」；README「等待修復超時 10–240 分」vs 實際鉗制 5–720 分。
- **L6** · index.js · cwdCache/lastFinished 無淘汰（以會話數為界，量級可控）。

### 明確不修（附理由，非待辦）

- 快照入 settings.yaml 敏感度：僅 sessionId/projectPath/輪次計數，findings 明細已剝離——無洩密面。
- 提示詞注入殘餘風險：注入文案有資料邊界聲明 + 字段截斷（title 120 / detail、suggestion 400），審查者工具 fail-closed 只讀；殘餘風險為「虛假 finding」，可人工複核。
- readBody 64KB 上限 + 超限銷毀連接：足夠。
- 審查者併發隊列無優先級；3s 輪詢 vs agent/status 事件（SPEC 已論證 Scoped 語義不確定）：維持現狀。

## 2. 修復驗證證據彙總

- `node scripts/smoke.mjs` → 全部通過 ✅（schemastery 形狀防線、host ESM 導入、樁啟動/撤離、RPC/HTTP、設置頁組件）。
- `node scripts/loop-sim.mjs` → 5 場景 28 斷言全過 ✅（主鏈路 R1→注入→R2、A1 45s 寬限、A2 順延 12min、A3 跨措辭振盪、全綠 passed）。
- `node scripts/resume-sim.mjs` → 4 場景 28 斷言全過 ✅（paused→resume、快照 hydrate、四條拒絕路徑、settings live 註冊 + 持久化）。
- H1 修復為純代碼檢視驗證（hostname 精確白名單邏輯，含惡意 Origin 樣式 `localhost.evil.com` 不再命中白名單）；三套腳本回歸未受影響。

## 3. 殘餘風險（截至定稿）

- **R1**（H1 修復細節）：動態沙箱環境無 `URL` 全局時 `new URL(origin)` 拋錯 → catch → 403——fail-closed 方向安全（僅動態調試模式下帶 Origin 的 POST 全拒，屬可接受的調試期摩擦）。
- **R2**：M1 GET 暴露面與 M3 inject 錯誤路徑未修（見 ROADMAP P1）。
- **R3**：M2 無界等待在「代理 hang 死於 running」時仍存在；正常路徑（idle 可達）不受影響。
- **R4**：全部驗證為進程內模擬 + 樁；真實端到端 M5 驗收（PRD §9）未執行——ROADMAP P0。
