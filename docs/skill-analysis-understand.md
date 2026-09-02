# 「understand」技能源碼級分析報告

> 分析對象：Understand-Anything 插件（`Egonex-AI/Understand-Anything`，MIT）
> 分析日期：2026-09-02 ｜ 本報告基於本機源碼直接審讀（/tmp/Understand-Anything 克隆，commit ba450c4）+ 本會話實測（對 dsh-auto-review 完整跑過 7 階段流水線）

---

## 一、倉庫概覽

| 項 | 值 |
|---|---|
| 倉庫 | `Understand-Anything`（單倉多技能：understand/understand-chat/diff/explain/onboard/domain/knowledge/dashboard） |
| 活躍度 | ⭐81.3K / 🍴6.8K，最後推送 2026-09-02（極活躍），MIT |
| 規模 | `packages/core` TS 30,532 行 + `skills/understand` 腳本 6,715 行（mjs/py）+ agents 提示詞 2,389 行 + dashboard（React 19 + XYFlow + dagre/elkjs + d3-force + graphology + zustand） |
| 核心依賴 | graphology / graphology-communities-louvain（Louvain 聚類）、tree-sitter 系 WASM 語法、python3（merge 腳本）、React 19 看板 |

**架構全景**：「確定性腳本 + LLM 子代理」混合流水線——

```
Phase0 預飛（git hash / 插件根解析 / 忽略檔）→ Phase1 掃描(腳本) → Phase1.5 語義批次(Louvain)
→ Phase2 文件分析(≤5 並行 LLM 子代理) → merge(腳本, 正規化/去重/懸空邊) → Phase3 合併審查(LLM)
→ Phase4 架構層(LLM) → Phase5 導覽(LLM) → Phase6 確定性校驗(腳本) → Phase7 保存+結構指紋(腳本)
```

**分層原則**：結構（檔案/函數/導入/調用圖）儘量由腳本確定性產出；LLM 只負責語義（summary/tags/層次/導覽）並產出碎片；`merge-batch-graphs.py` 是唯一正規化點（ID 修復、去重、懸空邊刪除、`tested_by` 方向規範化、imports 從 importMap 恢復）。

---

## 二、核心技術點解剖

| # | 技術點 | 機制 | 源碼位置 | 獨特價值 | 我們的對標 |
|---|---|---|---|---|---|
| 1 | 混合流水線：腳本定結構、LLM 定語義 | 7 階段階段化，每階段一個子代理/腳本，輸出落盤 JSON（intermediate/），階段間以檔案契約銜接 | `skills/understand/SKILL.md`（Phase 0–7） | 可重放、可診斷、各階段可替換；LLM 不碰 ID 語義 | dsh-auto-review 審查流水線（review→aggregate→inject）可套用同一「階段檔案契約」 |
| 2 | 確定性掃描器 | `git ls-files` 優先、ignore 過濾（內建+用戶規則+`!` 負向）、語言/分類表、行數、複雜度啟發 | `scan-project.mjs`（913 行） | 檔案清單零幻覺 | 可用於審查範圍收集（變更集已用 git）；「掃描含輸出目錄自引用」是我們實測發現的缺陷 |
| 3 | Tree-sitter 結構抽取 | WASM 語法 + 14 個非代碼解析器（markdown/yaml/json/toml/dockerfile/env/graphql/protobuf/shell/makefile/terraform…）＋按語言 extractor（python/rust/kotlin/swift/cpp/scala/ruby/csharp…） | `packages/core/src/plugins/*`（30.5K LOC） | 結構抽取跨 20+ 語言；wasm 免 nativ 編譯 | 我們只審 JS/TS/Python → 取「抽取→JSON 契約」思想，不必搬 30K LOC |
| 4 | 導入圖解析 | 13 語言 resolver（Go module 前綴剝離、Python `__init__.py`、PHP PSR-4、C/C++ include probe、Rust `use crate::`…） | `extract-import-map.mjs`（1,991 行） | 專案內 import 完全確定性、外部包剔除 | 參考其「每語言 resolver + 已解析路徑注入下游」模式（我們的模擬腳本零內部 import 即由此斷定） |
| 5 | Louvain 語義批次 | 導入圖社區發現 → 同社區檔案聚批（≤60 節點/120 邊），跨批鄰居帶導出符號（neighborMap） | `compute-batches.mjs`（670 行） | 讓 LLM 每次只看一個內聚切片；單身檔併入 misc 批 | 可用於多代理審查任務的分片（AgentTeams 任務 DAG 的提示詞分片同理） |
| 6 | 確定性合併 + 規範化 | ID 前綴剝雙/補齊、複雜度詞表歸一、按 (src,tgt,type) 去重、懸空邊刪除、`tested_by` 兩遍規範化（翻轉修復 + 路徑慣例配對）、imports 恢復 | `merge-batch-graphs.py`（1,248 行） | **唯一正規化點**：LLM 輸出髒了也能收斂 | 最值得借的單一模式 →「LLM 碎片 + 確定性 merge-lint」；我們實測 `smoke.mjs` 因其檔名不像測試被誤判 prod↔prod 丟邊（假陰性） |
| 7 | 子代理契約（prompt 即介面） | 要求：輸出寫指定檔案、節點必填欄位、imports 邊數 == importMap 數、自檢清單、multi-part 檔名正則 `batch-(\d+)(?:-part-(\d+))?`、響應只許摘要 | `agents/file-analyzer.md`（522 行） | 多代理協作下「可驗證輸出」；防截斷防越權（`module:`/`concept:` 禁造） | 立即可用於我們任何多代理流水線（含 dsh-auto-review 審查者/修復者） |
| 8 | 指紋增量更新 | `build-fingerprints.mjs` + `staleness.ts`：結構指紋基線 → 提交後按指紋分類變化 → 只重析變更檔 | `hooks/post-tool-use-auto-update.mjs`、`build-fingerprints.mjs` | 大倉庫增量成本 O(變更集) | 與 dsh-auto-review「智慧範圍」（R1 全量→變更集聚焦）同構；其 issue #152 警示：基線缺失會把每次提交誤判為全量 |
| 9 | 圖 Schema | 13 節點型 / 26 邊型 / 邊權重 0.5–1.0 / 版本 1.0.0；`languageNotes`+`languageLesson`（locales/ 多語言導覽） | `packages/core/src/types.ts`、`schema.ts` | 跨工具互通的「代碼圖」交換格式 | 可作為我們診斷數據（findings/依賴）的統一 schema |
| 10 | 互動看板 | React 19 + XYFlow（dagre/elkjs 佈局）+ d3-force + graphology + zustand；Vite 插件以 `?token=` 提供檔案 | `packages/dashboard/` | 探索式呈現（搜索/過濾/圖層） | 若需「代碼地圖」UI 可整棧借；但 token-in-URL 鑑權僅限 localhost |

---

## 三、風險分析

| # | 技術點 | 最大風險 | 致命度 | 根因 | 防禦建議 |
|---|---|---|---|---|---|
| 1 | LLM 語義邊（calls/related/documents） | calls 邊由「imports+函數名」推斷（權重 0.8）→ 對架構理解有假陽性/漏邊 | 🟠 | file-analyzer 規則本身是推斷 | 需要正確性時只用結構層（imports/contains/exports），語義邊僅供探索 |
| 2 | 安裝/版本分叉 | 本機安裝即壞：`~/.agents` 技能包缺 `agents/`、SKILL.md 與倉庫腳本 diff、core 需自建；插件根解析依賴符號連結指向不知名 `/tmp` 克隆 | 🟠 | 技能捆綁與 monorepo 修改不同步、插件根解析候選路徑脆弱 | 版本鎖定：腳本+agent+SKILL.md 同 commit 發布；運行前自檢（`test -f core/dist`） |
| 3 | 輸出目錄自引用 | 掃描器把 `.understand-anything/` 自身檔案（config/ignore/stderr）當專案檔案入圖 | 🟡 | 掃描 fallback 走目錄遍歷不排除資料目錄 | 資料目錄加入默認排除（我們已手動修） |
| 4 | 成本規模 | O(檔案數) LLM 代理調用；>100 檔僅「建議」不強制；每批 ≤60 節點但批數無上限，5 並行 | 🟠 | 無成本預算/預估 | 倉庫大小閾值改硬門檻 + 預估 token；大批量分層（先結構後語義） |
| 5 | 圖品質假陰性 | `tested_by` 路徑慣例配對對非標準測試檔名失效（實測 `smoke.mjs` 被誤判 prod↔prod 而丟邊） | 🟡 | 慣例啟發封閉集合 | 慣例表擴充（test-*.mjs / *-sim.mjs / tests 目錄）；merge 報告「Could not fix」必看 |
| 6 | 被審代碼的提示詞注入 | 分析惡意倉庫時，檔內容經 LLM 摘要/標籤進入後續階段 prompt 與看板文本，無淨化層 | 🟠 | 只依賴「ground in source」提示約束 | 結構層不變；語義輸出欄位加確定性過濾（參見 dsh-auto-review sanitizeBlocking 分級） |
| 7 | 看板鑑權 | token 走 URL 查詢參數（入日誌）、無用戶鑑權；圖含絕對路徑（我們已對非回環脫敏） | 🟡 | Vite 插件的 file-server 設計 | localhost-only；遠端需反代認證；token 改 header/一次性 |
| 8 | 維護性 | 硬編碼閾值（60/120 拆分、3–5 tags、權重表、300 檔掃描上限）；schema 1.0.0 無遷移規則；issue #152 已證明指紋基線破壞自動更新 | 🟡 | 腳本與 README 均為早期 alpha | 閾值集中常量檔；指紋基線寫入失敗時禁用自動更新（其 SKILL 已要求） |
| 9 | 部分結果靜默 | 「重試一次、再敗跳過階段、部分圖繼續」——失敗階段可能被當作完整通過 | 🟡 | SKILL.md 的 Error Handling 策略 | 報告必須列出跳過階段（我們會在報告中明示） |
| 10 | 工作樹重定向 | 在 git worktree 中運行輸出被重定向到主倉庫根（issue #133 的修復） | 🟢 | 設計選擇 | 留意「輸出不在項目內」的意外 |

## 四、系統級風險

- **誤差傳播**：鏈路 ≈ 掃描(0 LLM)→批次(0)→分析(LLM)→merge(腳本)→合併審查(LLM)→架構(LLM)→導覽(LLM)。假設單 LLM 步 95%：5 步 LLM 鏈 ≈ 77% 全對。**但**結構層（檔案/導入/ID）是確定性的，錯誤集中在語義層——把「結構正確性」與「語義豐富度」分開評判可避免被誤導。
- **成本模型**：分析一次 = N批 個分析代理 + 4~5 個階段代理（合併審查/架構/導覽/可選審閱）。3.3K LOC 項目我們跑了 7 個子代理回合；100K LOC monorepo 預計 30–60 回合。>5 次 LLM 調用/任務 → 需成本監控（已觸線）。
- **延遲模型**：全量分析分鐘級到小時級；增量更新才適合日常使用——**啟用 `--auto-update` + 指紋機制的成本/收益比遠高於全量重跑**。
- **除錯難度**：7 階段每階段都是一個獨立檔案（intermediate/*.json）→ 可觀測性好（>5 步串聯但檔案可查）✅；反之「哪一階段產出的壞資料」需要對照 merge 報告，實測可定位（我們靠 merged report 發現 tested_by 丟邊）。

## 五、對標評估（我們的系統 ↔ Understand-Anything）

| 我們已有的 | 他們的做法 | 評估 |
|---|---|---|
| dsh-auto-review：審查器分批 spawn、結構化 outputSchema、聚合、快照 | 階段化子代理 + 檔案契約 + merge 規範化 | 同構但**缺「確定性 merge-lint」這層**：他們的 ID/邊在腳本層收斂，我們的 findings 只在 schema 校驗 |
| 智慧範圍（git 變更集聚焦） | 指紋增量（結構指紋分類） | 我們是「檔名交集」，他們是「內容指紋」——**其指紋方法更準**（重構改名也能識別） |
| 自訂模型輪換審查 | 語言 locale 檔案（學習導覽按語言） | 可借：提示詞/術語多語言化 |
| sanitizeBlocking（二階注入過濾） | 無對應物（裸文本入下游） | 他們缺這層——我們已領先並應輸出 |
| 冒煙/模擬腳本驗證 | vitest 測試 | 他們的測試覆蓋（__tests__ + vitest）比我們廣，但**未覆蓋「合併腳本對非標準測試檔名的誤判」**──正是實測撞上的 |

**適用性結論**：直接可用 0 項（整個技能對我們的日常屬「工具型」而非「複製型」）；需要適配：子代理契約、merge-lint 模式、指紋增量；需要改造：schema 加注入淨化、測試慣例表擴充；不適用：30K LOC 核心 + WASM 語法棧（重供應鏈）、LLM 語義邊作為正確性依據、token-in-URL 看板鑑權。

## 六、行動建議（借什麼 / 不借什麼 / 怎麼借）

### 借什麼（按優先級）

**P0**
1. **「LLM 碎片 + 確定性 merge-lint」模式**（merge-batch-graphs.py）——把這一層加進我們的多代理流水線：所有子代理輸出先過一個規範化/去重/懸空引用清理/自檢的腳本，再進下一階段。dsh-auto-review 的 findings 聚合與 AgentTeams 任務輸出都受益。
2. **子代理輸出契約**（file-analyzer.md 的寫法）——固定輸出檔名正則、必填欄位、自檢（邊數==輸入數）、響應只許摘要。已在我們會話驗證：三個分析子代理全部嚴格遵守。
3. **結構指紋增量**（build-fingerprints + staleness）——比「檔名交集」更可靠地判定「什麼變了」；適用於智慧範圍複審與我們的診斷工具。

**P1**
4. **導入解析器語料**（extract-import-map.mjs 的 13 語言規則）——抽取 PSR-4/__init__/Go prefix/include probe 規則，用於我們需要的語言。
5. **tested_by 兩遍規範化**——但擴充慣例表（test-*/-sim/-harness/tests 目錄），並把「Could not fix」清單視為必讀輸出，抵禦我們實測撞見的假陰性。
6. **圖 schema（13 型/26 邊/權重）**作為互換格式——給我們的審查發現與依賴數據定統一結構。

**P2**
7. 看板技術棧（XYFlow + dagre/elkjs + d3-force）——如需要「代碼地圖」UI。
8. layer-detector/tour-generator 的提示詞骨架（我們有 DDD/PRD 轉換需求）。
9. embedding-search 被動檢索（接受預計算向量，無外部 API）——可作為離線語義搜索。

### 不借什麼

- **30K LOC 核心 + WASM tree-sitter**：供應鏈與維護成本遠超收益；我們只需 JS/TS/Python 結構抽取，用輕量解析器即可。
- **LLM 推斷的 calls/related 邊作為正確性依據**：探索可用，架構決策不可用。
- **7 階段固定編排**：小項目（<5K LOC）一次手動分析即可，7 階段是「重砲」——我們 3.3K 項目跑了 7 次子代理。
- **「部分結果靜默保存」策略**：我們要的是「誠實報告跳過了的階段」，不學它。
- **--review LLM 圖審閱作默認閘**：成本高；默認用確定性校驗（我們已這麼做），LLM 審閱僅在關鍵交付前手動觸發。
- **token-in-URL 的看板鑑權模型**：只限 localhost，遠端必須反代認證。
- **LLM 審閱者直接改寫 artifacts**（graph-reviewer 直接改 assembled-graph.json）：我們保持「審閱報告是獨立產物，代碼級修正由可信路徑完成」。

### 怎麼借（落地步驟）

1. 抽出 `merge-lint`：以 `merge-batch-graphs.py` 為藍本寫一個 ~300 行通用版（ID 規範化 / 去重 / 懸空邊 / 必填欄位自檢 / 報告），接到 dsh-auto-review 的 findings 聚合後與 AgentTeams 任務結果後。
2. 抽「子代理契約」模板：檔名正則 + 必填欄位 + 自檢 + 響應協議，替換我們子代理 prompt 的尾段。
3. 抽 `fingerprints`：讀 `staleness.ts` 的結構指紋實現，嫁接到智慧範圍的變更集判定（後續輪聚焦 = 指紋變更集，而非檔名 diff）。
4. 抽 schema：定義 `graph-fragment` JSON Schema（13/26/權重），讓診斷數據與 agent 輸出共用。
5. **補上他們沒有的一層**：LLM 語義輸出（summary/tags/建議）過 `sanitizeBlocking` 式分級過濾（HARD→人工確認，SOFT→佔位），並保留來源標記（plugin/analyzer）。
6. 所有輸出過 merge-lint 後才可進入下一階段；失敗階段顯式記錄，報告中明示。

### 優先級路線圖

| 優先級 | 項目 | 預期回報 | 工作量 |
|---|---|---|---|
| P0 | merge-lint 通用版 + 子代理契約模板 | 多代理流水線品質立刻提升（可驗證、可自檢） | 0.5–1 天 |
| P0 | 指紋增量嫁接到智慧範圍 | 複審成本從「全量」變「變更集」 | 0.5 天 |
| P1 | 導入解析器語料（JS/TS/Python 先行） | 我們的診斷工具獲得零幻覺依賴圖 | 0.5–1 天 |
| P1 | tested_by 慣例表擴充 + Could-not-fix 必讀 | 消滅實測假陰性 | 2 小時 |
| P2 | 看板技術棧 / 語義搜索 | 探索式體驗 | 1–2 天 |

---

**總結一句話**：understand 的價值不在 30K 行 TS，而在「**確定性腳本當裁判、LLM 只當語義選手、階段間用檔案契約**」這個模式——它把多代理協作的品質問題變成可重放、可規範化、可自檢的工程問題。我們該借的是模式和契約，不是體積；並補上它缺的兩課：注入淨化與誠實的部分結果報告。
