// dsh-auto-review — client half (v1.5.0).
//
// 「審查」conversation view tab (order 80)：輪次進度 + 四維度卡片 + 輪次時間線 + 報告。
// 「自動審查」settings.section (order 90)：模型增減 + 閉環預設 + 執行參數（設置頁）。
//
// v1.4 面板增強：P1-7 DimCard 兩行截斷+severity 色標+緊湊排版、報告 Markdown 渲染、
// 設置頁「即時生效」誤導文案如實化＋未保存標記；P1-10 模型次序編輯（↑↓ 有序 chips＋
// R1→R2 輪換預覽，數組序即輪換序）；P1-11 fixScope 三檔（發起區+設置頁）；P1-12 輪次
// 時間線（每輪可摺疊卡：模型/範圍/發現/注入/確認修復/展開逐項）。
//
// 雙模式通信（關鍵設計）：
//   動態插件沙箱：fetch/setTimeout 是 teaching trap → 必須 host.call（配對 host 半
//     harness.handle 的 review-* 方法）+ ctx.timer
//   profile bundle（module loader）：fetch 可直連 /__review/api/*（同 artifact-view 模式），
//     window.setTimeout 可用；此環境沒有 host 全局
//   判別：typeof host !== 'undefined' → 動態模式
window.__ModuleLoader__.load({
	id: "dsh-auto-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const e = react.createElement;
		const { useState, useEffect, useCallback } = react;

		//#region tokens（僅官方 13 token；R9（D-2）：未定義時按宿主系統色偏好選淺/深保底色板——
		//   不再只 fallback 暗色 hex（淺色宿主下正文不可讀）
		const DARK_FB = { text: "#c9d1d9", muted: "#8b949e", bg: "#161b22", border: "#30363d", border2: "#8b949e" };
		const LIGHT_FB = { text: "#1f2328", muted: "#59636e", bg: "#f6f8fa", border: "#d1d9e0", border2: "#818b98" };
		const isDarkTheme = (function () {
			// D-1（v1.4.1）：宿主定義 token 時按其「計算值亮度」判定深淺，而非假定暗色；
			// 解析失敗（如 light-dark() 字面量）→ 退 prefers-color-scheme，仍無則暗色。
			function bgLuminance(v) {
				let t = String(v || "").trim();
				let m = /^#([0-9a-f]{3})$/i.exec(t);
				if (m) { const h = m[1]; t = "#" + h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; }
				m = /^#([0-9a-f]{6})$/i.exec(t);
				if (m) {
					const r = parseInt(t.slice(1,3),16)/255, g = parseInt(t.slice(3,5),16)/255, b = parseInt(t.slice(5,7),16)/255;
					return 0.2126*r + 0.7152*g + 0.0722*b;
				}
				m = /^rgba?\(([^)]+)\)$/i.exec(t);
				if (m) {
					const parts = m[1].split(",").map(x => parseFloat(x));
					if (parts.length >= 3 && parts.slice(0,3).every(n => Number.isFinite(n)))
						return 0.2126*(parts[0]/255) + 0.7152*(parts[1]/255) + 0.0722*(parts[2]/255);
				}
				return null;
			}
			try {
				if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
					const v = getComputedStyle(document.documentElement).getPropertyValue("--dsw-alias-bg-layer-1");
					if (v && v.trim() !== "") {
						const lum = bgLuminance(v);
						if (lum !== null) return lum < 0.5; // 背景亮 → 淺色 fallback
					}
				}
			} catch (ex) { /* fallthrough */ }
			try { return typeof matchMedia === "function" ? !matchMedia("(prefers-color-scheme: light)").matches : true; }
			catch (ex) { return true; }
		})();
		const FB = isDarkTheme ? DARK_FB : LIGHT_FB;
		const cText = "var(--dsw-alias-label-primary, " + FB.text + ")";
		const cMuted = "var(--dsw-alias-label-secondary, " + FB.muted + ")";
		const cBad = "var(--dsw-alias-state-error-primary, #f85149)";
		const cGood = "var(--dsw-alias-state-success-primary, #3fb950)";
		const cWarn = "var(--dsw-alias-state-warn-primary, #d29922)";
		const cBrand = "var(--dsw-alias-brand-primary, #58a6ff)";
		const cBrandBg = "rgba(88, 166, 255, 0.14)"; // 品牌選中態底色（近似 cBrand 12% 不透明度；token 無 alpha 形式時的具名回退）
		const cBg1 = "var(--dsw-alias-bg-layer-1, " + FB.bg + ")";
		const cBorder = "var(--dsw-alias-border-l1, " + FB.border + ")";
		const cBorder2 = "var(--dsw-alias-border-l2, " + FB.border2 + ")";
		const mono = "var(--dsw-alias-font-mono, ui-monospace, monospace)";
		const ctl = {
			background: "transparent", color: cText, border: "1px solid " + cBorder2,
			borderRadius: 8, padding: "4px 12px", fontFamily: "inherit", fontSize: 12, cursor: "pointer",
		};
		//#endregion

		const SEV_COLOR = { critical: cBad, high: cBad, medium: cWarn, low: cMuted };
		const STATUS_LABEL = {
			pending: "待審", queued: "排隊", reviewing: "審查中", resolving: "解析路徑", passed: "通過", blocking: "未通過",
			failed: "失敗",
		};
		const RUN_LABEL = {
			resolving: "解析中", reviewing: "審查中", "awaiting-fix": "建議已注入，等待修復", "awaiting-confirm": "待確認注入",
			passed: "全部通過 ✅", stopped: "已終止", failed: "失敗", oscillated: "振盪轉人工",
			"max-rounds": "達輪數上限", reported: "報告完成", paused: "已暫停（可恢復）", interrupted: "重啟中斷（可恢復）",
		};
		const DIM_META = [
			{ id: "code", label: "代碼" },
			{ id: "security", label: "安全" },
			{ id: "flow", label: "用戶流程" },
			{ id: "design", label: "前端設計" },
		];
		const MODEL_META = [
			{ key: "glm-5.3", label: "GLM 5.3" },
			{ key: "glm-5.2", label: "GLM 5.2" },
			{ key: "kimi-k3", label: "Kimi K3" },
			{ key: "qwen3.8-max", label: "Qwen3.8 Max" },
			{ key: "qwen3.7-plus", label: "Qwen3.7+" },
			{ key: "deepseek-v4", label: "DS V4" },
		];
		const SCOPE_OPTS = [
			{ id: "smart", label: "智慧", hint: "R1 全量 → 後續輪聚焦變更集（省 token）" },
			{ id: "full", label: "全量", hint: "每輪全項目複審（最徹底，token 成本高）" },
		];
		// P1-11：修復範圍檔位（與通過線解耦——不影響驗收口徑，通過線由「審查強度」決定）
		const FIX_SCOPE_OPTS = [
			{ id: "blocking-only", label: "僅阻斷", hint: "只注入達到通過線的阻斷項" },
			{ id: "plus-medium", label: "含 Medium", hint: "阻斷項＋非阻斷 medium 順帶修復" },
			{ id: "all", label: "全修", hint: "阻斷項＋非阻斷 medium/low 全部順帶修復" },
		];
		// R8（D-5）：審查強度/輪次選項提升為模組級常量——面板與設置頁共用同一份（不再多處硬編碼）
		const GATE_OPTS = [
			{ id: "loose", label: "寬鬆", hint: "僅 critical 阻斷" },
			{ id: "standard", label: "標準", hint: "critical+high 阻斷" },
			{ id: "strict", label: "嚴格", hint: "critical+high+medium 阻斷" },
		];
		const ROUND_OPTS = [1, 3, 5, 8, 10];
		// R8（D-5）：統一 mini 按鈕樣式（面板/設置頁共用；替代多處複製粘貼）
		const miniBtn = function (warn) {
			return Object.assign({}, ctl, warn ? { borderColor: cWarn, color: cWarn } : {});
		};
		const fixScopeLabel = function (id) {
			for (const o of FIX_SCOPE_OPTS) if (o.id === id) return o.label;
			return String(id || "?");
		};

		// 雙模式網層：動態（host.call RPC）vs bundle（fetch HTTP）
		const DYNAMIC = typeof host !== "undefined";
		let pluginCtx = null; // apply() 時捕獲（動態模式定時用）

		/** fetch + 15s 超時（R2：響應懸空不再讓面板 busy 永久死鎖）。 */
		function fetchJson(url, opts) {
			return new Promise(function (resolve, reject) {
				let done = false;
				const to = pluginCtx ? later(function () {
					if (!done) { done = true; reject(new Error("請求超時（15s）")); }
				}, 15000) : null;
				fetch(url, opts || {})
					.then(function (r) { return r.json().then(function (j) { if (!done) { done = true; resolve(j); } }); })
					.catch(function (ex) { if (!done) { done = true; reject(ex); } })
					.then(function () { if (to) to(); });
			});
		}

		/** R2：/__review 鑑權——sessionStorage 快取 per-install token，缺失時經 /api/token 引導取得。 */
		let apiTokenPromise = null;
		function ensureToken() {
			if (apiTokenPromise) return apiTokenPromise;
			const cached = typeof sessionStorage !== "undefined" ? sessionStorage.getItem("__review_token") : null;
			if (cached) { apiTokenPromise = Promise.resolve(cached); return apiTokenPromise; }
			apiTokenPromise = fetchJson("/__review/api/token", {})
				.then(function (r) {
					const t = String((r && r.token) || "");
					if (!t) throw new Error("無法獲取審查 API token");
					if (typeof sessionStorage !== "undefined") sessionStorage.setItem("__review_token", t);
					return t;
				})
				.catch(function (ex) { apiTokenPromise = null; throw ex; });
			return apiTokenPromise;
		}

		/** 統一 API 調用：method 對應 host.call 方法名 / HTTP 路由。 */
		function callApi(method, args) {
			// R9（F-5）：動態模式 RPC 也加 30s 超時——host.call 掛起不再讓面板 busy 永久死鎖
			if (DYNAMIC) {
				return new Promise(function (resolve, reject) {
					let done = false;
					const to = later(function () {
						if (!done) { done = true; reject(new Error("主機無響應（超時）——可刷新頁面重試")); }
					}, 30000);
					Promise.resolve(host.call(method, args || {})).then(function (v) {
						if (!done) { done = true; resolve(v); }
					}, function (e) {
						if (!done) { done = true; reject(e); }
					}).then(function () { if (to) to(); });
				});
			}
			const q = encodeURIComponent(String((args || {}).session || ""));
			const withToken = function (url, opts) {
				return ensureToken().then(function (t) {
					const o = Object.assign({}, opts || {});
					o.headers = Object.assign({ "x-review-token": t }, o.headers || {});
					return fetchJson(url, o).then(function (r) {
						// R3：token 失效（DSH 重啟後新進程生成新 token）→ 清緩存並重新引導重試一次
						if (r && r.error === "未授權") {
							if (typeof sessionStorage !== "undefined") sessionStorage.removeItem("__review_token");
							apiTokenPromise = null;
							return ensureToken().then(function (t2) {
								const o2 = Object.assign({}, opts || {});
								o2.headers = Object.assign({ "x-review-token": t2 }, o2.headers || {});
								return fetchJson(url, o2);
							});
						}
						return r;
					});
				});
			};
			if (method === "review-state") {
				return withToken("/__review/api/state?session=" + q, {});
			}
			if (method === "review-report") {
				return withToken("/__review/api/report?session=" + q, {});
			}
			if (method === "review-config-get") {
				return withToken("/__review/api/config", {});
			}
			// R8（C-2）：GET 類與 POST 類方法映射補齊（review-list 不再落到 /__review/api/undefined）；
			//   未知方法直接 reject 而非發出畸形請求
			const GET_METHODS = { "review-list": "list" };
			const POST_METHODS = {
				"review-start": "start", "review-stop": "stop", "review-inject": "inject",
				"review-resume": "resume", "review-config-set": "config",
			};
			if (GET_METHODS[method]) {
				return withToken("/__review/api/" + GET_METHODS[method] + "?session=" + q, {});
			}
			const route = POST_METHODS[method];
			if (route === undefined) return Promise.reject(new Error("未知方法: " + method));
			return withToken("/__review/api/" + route, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify(method === "review-config-set" ? { config: (args || {}).config || {} } : (args || {})),
			});
		}

		/** 統一定時器：ctx.timeout（inject timer；返回 disposer）。 */
		function later(fn, ms) {
			return pluginCtx.timeout(fn, ms);
		}

		function Pill(props) {
			return e("span", {
				style: {
					display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11,
					color: props.tone, border: "1px solid " + props.tone, lineHeight: "18px", whiteSpace: "nowrap",
				},
			}, props.children);
		}

		/** 膠囊選擇組（設置頁/面板共用）。R8（D-3）：aria-pressed + 選中態改「品牌描邊+品牌文字」
		 *  （#58a6ff 上白字對比度僅 2.4:1 → 描邊方案對品牌色取值不敏感，AA 達標）。 */
		/** P1-4：token 千分位簡寫（1234 → 1.2K；1234567 → 1.2M）。 */
		function fmtTok(n) {
			const v = Number(n) || 0
			if (v >= 1e6) return (v / 1e6).toFixed(1) + "M"
			if (v >= 1e3) return (v / 1e3).toFixed(1) + "K"
			return String(v)
		}

		function OptPills(props) {
			return e("span", { style: { display: "inline-flex", gap: 6, flexWrap: "wrap" } },
				props.opts.map(function (o) {
					const on = props.value === o.id;
					return e("button", {
						key: o.id, title: o.hint || "",
						"aria-pressed": on,
						style: {
							background: on ? cBrandBg : "transparent", // D-2：品牌選中態底色（具名常量見 tokens 區）
							color: on ? cBrand : cText,
							border: "1px solid " + (on ? cBrand : cBorder2), borderRadius: 999,
							padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit",
						},
						onClick: function () { props.onChange(o.id); },
					}, o.label);
				}));
		}

		function SevCounts(props) {
			const counts = props.counts;
			const parts = [];
			for (const sev of ["critical", "high", "medium", "low"]) {
				if (!counts[sev]) continue;
				parts.push(e("span", { key: sev, style: { color: SEV_COLOR[sev], fontWeight: 600, fontSize: 12, marginRight: 8 } },
					counts[sev] + " " + sev));
			}
			return parts.length ? e("span", null, parts) : e("span", { style: { color: cMuted, fontSize: 12 } }, "0 發現");
		}

		/** R8（D-6）：finding 行共用組件——DimCard.findings / DimCard.ignored 統一結構與間距
		 *  （severity minWidth 46、paddingLeft 10、marginBottom 6）；InjItemRow 為橫向時間線變體。 */
		function FindingRow(props) {
			const f = props.f || {};
			const muted = props.muted === true;
			const sev = SEV_COLOR[f.severity] || cMuted;
			return e("div", { style: { borderLeft: "3px solid " + sev, paddingLeft: 10, marginBottom: 6, opacity: muted ? 0.85 : 1 } },
				e("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
					e("span", { style: { color: sev, fontWeight: 700, fontSize: 11, minWidth: 46 } }, f.severity),
					e("span", { style: { color: cMuted, fontFamily: mono, fontSize: 11 } }, (f.file || "") + (f.line != null ? ":" + f.line : ""))),
				e("div", { style: { color: muted ? cMuted : cText, fontSize: 12, marginTop: 2, lineHeight: 1.45 } }, f.title),
				!muted && f.detail ? e("div", { style: { color: cMuted, fontSize: 12, marginTop: 2, lineHeight: 1.45 } }, f.detail) : null,
				!muted && f.suggestion ? e("div", { style: { color: cBrand, fontSize: 12, marginTop: 2, lineHeight: 1.45 } }, "→ " + f.suggestion) : null,
				props.extra ? e("div", { style: { color: cMuted, fontSize: 11, marginTop: 2 } }, props.extra) : null);
		}

		function DimCard(props) {
			const dim = props.dim;
			const pair = useState(false);
			const open = pair[0];
			const setOpen = pair[1];
			// P1-7：summary 過長時兩行截斷 + 展開/收起
			const sumPair = useState(false);
			const sumOpen = sumPair[0];
			const setSumOpen = sumPair[1];
			const sumText = String(dim.summary || "");
			const sumLong = sumText.length > 60 || sumText.indexOf("\n") >= 0;
			const tone = dim.status === "passed" ? cGood : (dim.status === "blocking" || dim.status === "failed") ? cBad
				: (dim.status === "reviewing" || dim.status === "resolving") ? cBrand : cMuted;
			const findings = (dim.findings || []).filter(function (f) { return !f.resolved; });
			const ignored = dim.ignored || []; // P1-9：.reviewignore 已接受項（不阻擋驗收）
			return e("div", { style: { background: cBg1, border: "1px solid " + cBorder, borderRadius: 10, padding: "8px 12px", marginBottom: 6 } },
				e("div", {
					// F6：展開頭鍵盤可訪問——role+tabIndex+aria-expanded+Enter/Space 切換
					role: "button", tabIndex: 0, "aria-expanded": open,
					onClick: function () { setOpen(!open); },
					onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(!open); } },
					style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
				},
					e("span", { style: { width: 8, height: 8, borderRadius: 99, background: tone, flexShrink: 0 } }),
					e("span", { style: { color: cText, fontSize: 13, fontWeight: 600 } }, dim.label),
					e(Pill, { tone: tone }, STATUS_LABEL[dim.status] || dim.status),
					e("span", { style: { flex: 1 } }),
					e(SevCounts, { counts: dim.counts }),
					findings.length || ignored.length ? e("span", { style: { color: cMuted, fontSize: 11 } }, open ? "▾" : "▸") : null,
				),
				sumText !== "" ? e("div", {
					// P1-7：兩行截斷（line-clamp）——過長 summary 不再撐開卡片
					style: Object.assign({ color: cMuted, fontSize: 12, marginTop: 4, lineHeight: 1.5 },
						!sumOpen && sumLong ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : null),
				}, sumText) : null,
				sumLong ? e("button", {
					style: { background: "transparent", color: cBrand, border: "none", padding: 0, fontSize: 11, cursor: "pointer", fontFamily: "inherit", marginTop: 2 },
					onClick: function () { setSumOpen(!sumOpen); },
				}, sumOpen ? "收起 ▴" : "展開 ▾") : null,
				dim.error ? e("div", { role: "alert", style: { color: cBad, fontSize: 12, marginTop: 4 } }, "⚠ " + dim.error) : null,
				open && (findings.length || ignored.length) ? e("div", { style: { marginTop: 8, borderTop: "1px solid " + cBorder, paddingTop: 8 } },
					findings.map(function (f, i) {
						// R8（D-6）：共用 FindingRow（結構/間距統一）
						return e(FindingRow, { key: i, f: f });
					}),
					ignored.length ? e("div", { style: { marginTop: findings.length ? 6 : 0, paddingTop: 6, borderTop: "1px dashed " + cBorder } },
						e("div", { style: { color: cMuted, fontSize: 11, marginBottom: 4 } }, "已接受不修（命中 .reviewignore，不阻擋驗收）"),
						ignored.map(function (f, i) {
							return e(FindingRow, {
								key: "ig" + i, f: f, muted: true,
								extra: f.ignorePattern ? "命中：" + f.ignorePattern + (f.ignoreReason ? "（理由：" + f.ignoreReason + "）" : "") : null,
							});
						})) : null,
				) : null,
			);
		}

		/** 合併內建 + 自訂模型清單（面板勾選用）。 */
		function mergeModels(builtin, custom) {
			const list = (builtin || []).map(function (m) { return { key: m.key, label: m.label || m.model }; });
			for (const c of custom || []) list.push({ key: c.key, label: (c.label || c.model) + "（自訂）" });
			return list;
		}

		//#region P1-7/10/12：報告 Markdown 渲染 + 模型次序編輯 + 輪次時間線
		/** 行內 **粗體** 解析（其他字符原 樣輸出）。 */
		function renderInline(text, keyPrefix) {
			const out = [];
			const s = String(text ?? "");
			const re = /\*\*([^*]+)\*\*/g;
			let last = 0, m, n = 0;
			while ((m = re.exec(s)) !== null) {
				if (m.index > last) out.push(e("span", { key: keyPrefix + "-t" + (n++) }, s.slice(last, m.index)));
				out.push(e("strong", { key: keyPrefix + "-b" + (n++), style: { color: cText, fontWeight: 600 } }, m[1]));
				last = m.index + m[0].length;
			}
			if (last < s.length) out.push(e("span", { key: keyPrefix + "-t" + (n++) }, s.slice(last)));
			return out;
		}

		/** 表格行拆分：剝首尾豎線、按未轉義 | 切格、\| 還原為 |。 */
		function splitTableRow(row) {
			let s = String(row).trim();
			if (s.charAt(0) === "|") s = s.slice(1);
			if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
			const cells = [];
			let cur = "";
			for (let i = 0; i < s.length; i++) {
				const ch = s.charAt(i);
				if (ch === "\\" && s.charAt(i + 1) === "|") { cur += "|"; i++; continue; }
				if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
				cur += ch;
			}
			cells.push(cur.trim());
			return cells;
		}

		/** P1-7：輕量 Markdown 渲染（標題/粗體/引用/清單/表格/分隔線）——報告區不再裸 <pre>。 */
		function MdRender(props) {
			const src = String(props.text ?? "");
			const lines = src.split("\n");
			const blocks = [];
			let bi = 0;
			const isSpecial = function (t) {
				return t === "" || t.charAt(0) === "|" || t.charAt(0) === "#" || t.charAt(0) === ">"
					|| t.charAt(0) === "-" || t.charAt(0) === "*" || /^-{3,}$/.test(t);
			};
			let i = 0;
			while (i < lines.length) {
				const t = lines[i].trim();
				if (t === "") { i++; continue; }
				// 表格：| 開頭 + 下一行 |---| 分隔
				if (t.charAt(0) === "|" && i + 1 < lines.length
					&& /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].trim().indexOf("-") >= 0) {
					const head = splitTableRow(lines[i]);
					i += 2;
					const rows = [];
					while (i < lines.length && lines[i].trim().charAt(0) === "|") { rows.push(splitTableRow(lines[i])); i++; }
					blocks.push(e("table", { key: "md" + (bi++), style: { borderCollapse: "collapse", width: "100%", margin: "8px 0", fontSize: 12, tableLayout: "fixed" } },
						e("thead", null, e("tr", null, head.map(function (c, ci) {
							return e("th", { key: ci, style: { border: "1px solid " + cBorder, background: cBg1, color: cMuted, fontWeight: 600, textAlign: "left", padding: "4px 8px" } }, renderInline(c, "th" + ci));
						}))),
						e("tbody", null, rows.map(function (r, ri) {
							return e("tr", { key: ri }, r.map(function (c, ci) {
								const sev = SEV_COLOR[c];
								return e("td", { key: ci, style: { border: "1px solid " + cBorder, padding: "4px 8px", verticalAlign: "top", lineHeight: 1.5, wordBreak: "break-word", color: cText } },
									sev !== undefined ? e("span", { style: { color: sev, fontWeight: 700 } }, c) : renderInline(c, "td" + ri + "-" + ci));
							}));
						}))));
					continue;
				}
				// 標題 #/##/###
				const h = t.match(/^(#{1,3})\s+(.*)$/);
				if (h !== null) {
					const lv = h[1].length;
					blocks.push(e("div", {
						key: "md" + (bi++),
						style: { color: cText, fontWeight: lv === 1 ? 700 : 600, fontSize: lv === 1 ? 15 : lv === 2 ? 13.5 : 13, margin: lv === 1 ? "10px 0 6px" : "10px 0 4px" },
					}, renderInline(h[2], "h" + bi)));
					i++; continue;
				}
				// 分隔線 ---
				if (/^-{3,}$/.test(t)) {
					blocks.push(e("div", { key: "md" + (bi++), style: { borderTop: "1px solid " + cBorder, margin: "10px 0" } }));
					i++; continue;
				}
				// 引用 >
				if (t.charAt(0) === ">") {
					const qs = [];
					while (i < lines.length && lines[i].trim().charAt(0) === ">") { qs.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
					blocks.push(e("div", { key: "md" + (bi++), style: { borderLeft: "3px solid " + cBorder2, paddingLeft: 10, color: cMuted, fontSize: 12, lineHeight: 1.6, margin: "4px 0" } },
						qs.map(function (q, qi) { return e("div", { key: qi }, renderInline(q, "q" + qi)); })));
					continue;
				}
				// 清單 -/*
				if (/^[-*]\s+/.test(t)) {
					const items = [];
					while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*]\s+/, "")); i++; }
					blocks.push(e("ul", { key: "md" + (bi++), style: { margin: "4px 0", paddingLeft: 18, color: cText, fontSize: 12, lineHeight: 1.6 } },
						items.map(function (it, ii) { return e("li", { key: ii, style: { marginBottom: 2 } }, renderInline(it, "li" + ii)); })));
					continue;
				}
				// 段落（連續普通行合併）
				const para = [];
				while (i < lines.length && !isSpecial(lines[i].trim())) { para.push(lines[i].trim()); i++; }
				if (para.length === 0) { i++; continue; }
				blocks.push(e("div", { key: "md" + (bi++), style: { color: cText, fontSize: 12, lineHeight: 1.6, margin: "4px 0" } },
					renderInline(para.join(" "), "p" + bi)));
			}
			return e("div", null, blocks);
		}

		/** P1-10：已選模型有序 chips（↑↓ 調序 + ✕ 移除）＋ R1→R2 輪換預覽（面板/設置頁共用）。 */
		function ModelOrderEditor(props) {
			const order = props.order || [];
			// R8（D-8）：mini 按鈕最低 24px 可點擊高度（WCAG 2.5.8）+ ✕ 帶 aria-label
			const mini = {
				background: "transparent", color: cText, border: "1px solid " + cBorder, borderRadius: 6,
				padding: "2px 6px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", lineHeight: "20px",
				minHeight: 24,
			};
			if (order.length === 0) {
				return e("div", { style: { color: cMuted, fontSize: 11, marginTop: 6 } },
					"尚未選擇模型——勾選上方加入；次序即輪換次序（R1 用第 1 個，R2 用第 2 個…循環）");
			}
			return e("div", { style: { marginTop: 6 } },
				e("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
					order.map(function (key, idx) {
						return e("span", { key: key, style: { display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid " + cBorder2, borderRadius: 999, padding: "2px 8px", fontSize: 12, color: cText } },
							e("span", { style: { fontFamily: mono, color: cBrand, fontSize: 11, fontWeight: 700 } }, "R" + (idx + 1)),
							e("span", null, props.labelOf(key)),
							e("button", { style: mini, disabled: idx === 0, title: "上移", onClick: function () { props.onMove(key, -1); } }, "↑"),
							e("button", { style: mini, disabled: idx === order.length - 1, title: "下移", onClick: function () { props.onMove(key, 1); } }, "↓"),
							e("button", { style: Object.assign({}, mini, { color: cBad, borderColor: cBad }), title: "取消選用", "aria-label": "移除模型 " + props.labelOf(key), onClick: function () { props.onRemove(key); } }, "✕"));
					})),
				e("div", { style: { color: cMuted, fontSize: 11, marginTop: 6 } },
					"輪換次序：" + order.map(function (k, idx) { return "R" + (idx + 1) + " " + props.labelOf(k); }).join(" → ") + (order.length > 1 ? "（依序循環）" : "")));
		}

		/** P1-12：時間線注入項行（severity 色標 + file:line + title + 共同指出/順帶修復標記）。 */
		function InjItemRow(props) {
			const it = props.item || {};
			const sev = SEV_COLOR[it.severity] || cMuted;
			const dl = props.dimLabel || {};
			return e("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", borderLeft: "3px solid " + sev, paddingLeft: 10, marginBottom: 6 } },
				e("span", { style: { color: sev, fontWeight: 700, fontSize: 11, minWidth: 46 } }, it.severity),
				e("span", { style: { color: cMuted, fontFamily: mono, fontSize: 11 } }, it.file + (it.line != null ? ":" + it.line : "")),
				e("span", { style: { color: cText, fontSize: 12, flex: 1, minWidth: 160 } }, it.title),
				it.dim ? e("span", { style: { color: cMuted, fontSize: 11 } }, dl[it.dim] || it.dim) : null,
				Array.isArray(it.coDims) && it.coDims.length > 1
					? e("span", { style: { color: cWarn, fontSize: 11 } }, "⚠ " + it.coDims.map(function (d) { return dl[d] || d; }).join("+") + " 共同指出") : null,
				props.extra ? e("span", { style: { color: cBrand, fontSize: 11, border: "1px solid " + cBrand, borderRadius: 999, padding: "0 6px", lineHeight: "16px" } }, "順帶修復") : null);
		}

		/** P1-12：單輪可摺疊卡（模型/範圍/發現/注入/確認修復 + 展開逐項）。 */
		function RoundCard(props) {
			const pair = useState(props.defaultOpen === true);
			const open = pair[0];
			const setOpen = pair[1];
			const r = props.entry || {};
			const inj = props.inj || null;
			const pending = props.pending || null;
			const d = new Date(Number(r.at) || 0);
			const p2 = function (n) { return (n < 10 ? "0" : "") + n; };
			const scopeText = r.scope === "smart"
				? (r.changedCount != null ? "聚焦 " + r.changedCount + " 檔" : "聚焦變更集")
				: "全量";
			const dimParts = Object.keys(r.blockingByDim || {})
				.filter(function (id) { return (r.blockingByDim[id] || 0) > 0; })
				.map(function (id) { return (props.dimLabel[id] || id) + " " + r.blockingByDim[id]; });
			const injText = inj
				? "注入 " + inj.count + " 項" + ((inj.extraCount || 0) > 0 ? "＋順帶 " + inj.extraCount : "")
				: (pending && pending.round === r.round ? "待確認 " + pending.count + " 項" : "未注入");
			return e("div", { style: { background: cBg1, border: "1px solid " + cBorder, borderRadius: 10, padding: "8px 12px", marginBottom: 6 } },
				e("div", {
					role: "button", tabIndex: 0, "aria-expanded": open,
					onClick: function () { setOpen(!open); },
					onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(!open); } },
					style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", cursor: "pointer" },
				},
					e("span", { style: { fontFamily: mono, color: cBrand, fontSize: 12, fontWeight: 700 } }, "R" + r.round),
					e("span", { style: { color: cMuted, fontSize: 11 } }, props.model),
					e("span", { style: { color: cMuted, fontSize: 11 } }, scopeText),
					e("span", { style: { color: cText, fontSize: 12 } }, "發現 " + (r.mergedCount != null ? r.mergedCount : "?") + " 項"),
					(r.crossCount || 0) > 0 ? e("span", { style: { color: cWarn, fontSize: 11 }, title: "多維度共同指出的項合併後只列一條" }, "跨維度合併 " + r.crossCount) : null,
					e("span", { style: { color: cText, fontSize: 12 } }, injText),
					(r.resolvedVsPrev || 0) > 0 ? e("span", { style: { color: cGood, fontSize: 12 } }, "較上輪確認修復 ↓" + r.resolvedVsPrev) : null,
				(r.tokenUsage ? e("span", { style: { color: cMuted, fontSize: 11 } }, "token " + fmtTok(r.tokenUsage.input + r.tokenUsage.output)) : null),
					(r.ignoredCount || 0) > 0 ? e("span", { style: { color: cMuted, fontSize: 11 }, title: "命中 .reviewignore 已接受不修" }, "已接受 " + r.ignoredCount) : null,
					e("span", { style: { flex: 1 } }),
					e("span", { style: { color: cMuted, fontSize: 11, fontFamily: mono } }, p2(d.getHours()) + ":" + p2(d.getMinutes())),
					e("span", { style: { color: cMuted, fontSize: 11 } }, open ? "▾" : "▸")),
				open ? e("div", { style: { marginTop: 8, borderTop: "1px solid " + cBorder, paddingTop: 8 } },
					dimParts.length ? e("div", { style: { color: cMuted, fontSize: 11, marginBottom: 6 } }, "各維度發現（合併前）：" + dimParts.join(" · ")) : null,
					inj && Array.isArray(inj.items) && inj.items.length ? e("div", null,
						e("div", { style: { color: cText, fontSize: 12, fontWeight: 600, marginBottom: 4 } },
						"注入清單（" + inj.items.length + " 項" + (inj.fixScope ? " · 修復範圍 " + fixScopeLabel(inj.fixScope) : "") + "）"),
						inj.items.map(function (it, ii) { return e(InjItemRow, { key: "it" + ii, item: it, dimLabel: props.dimLabel }); })) : null,
					inj && Array.isArray(inj.extraItems) && inj.extraItems.length ? e("div", { style: { marginTop: 6 } },
						e("div", { style: { color: cBrand, fontSize: 12, fontWeight: 600, marginBottom: 4 } }, "順帶修復（非阻斷，不影響驗收）"),
						inj.extraItems.map(function (it, ii) { return e(InjItemRow, { key: "ex" + ii, item: it, dimLabel: props.dimLabel, extra: true }); })) : null,
					!inj ? e("div", { style: { color: cMuted, fontSize: 12 } },
						pending && pending.round === r.round
							? "本輪建議待確認注入（用上方「✎ 確認注入」按鈕）"
							: ((r.mergedCount || 0) === 0 ? "本輪無發現（全部通過）" : "本輪未注入（報告模式或注入前終止）")) : null,
				) : null,
			);
		}

		/** P1-12：輪次時間線（run 活躍與終態都顯示）——數據取 roundLog/injectLog（publicRun 擴展）。 */
		function RoundTimeline(props) {
			const run = props.run || {};
			const dimLabel = {};
			for (const d of run.dimensions || []) dimLabel[d.id] = d.label;
			const models = run.models || [];
			const modelOf = function (n) { return models.length > 0 ? models[(n - 1) % models.length] : "—"; };
			const rounds = (run.roundLog || []).slice().sort(function (a, b) { return (a.round || 0) - (b.round || 0); });
			const injByRound = {};
			for (const x of run.injectLog || []) injByRound[x.round] = x;
			const lastDone = rounds.length > 0 ? rounds[rounds.length - 1].round : 0;
			const pending = run.pendingInject || null;
			if (rounds.length === 0 && !(props.active && run.round > lastDone)) return null;
			return e("div", { style: { marginTop: 12 } },
				e("div", { style: { color: cMuted, fontSize: 12, marginBottom: 6 } }, "輪次時間線"),
				rounds.map(function (r, idx) {
					return e(RoundCard, {
						key: "rc" + r.round, entry: r, inj: injByRound[r.round] || null, pending: pending,
						model: modelOf(r.round), dimLabel: dimLabel, defaultOpen: idx === rounds.length - 1 && !props.active,
					});
				}),
				props.active && run.round > lastDone ? e("div", { style: { background: cBg1, border: "1px dashed " + cBorder, borderRadius: 10, padding: "8px 12px", marginBottom: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
					e("span", { style: { fontFamily: mono, color: cBrand, fontSize: 12, fontWeight: 700 } }, "R" + run.round),
					e("span", { style: { color: cMuted, fontSize: 11 } }, modelOf(run.round)),
					e("span", { style: { color: cMuted, fontSize: 12 } }, (run.dimensions || []).map(function (d) { return STATUS_LABEL[d.status] || d.status; }).join(" · ") || "審查中…")) : null,
			);
		}
		//#endregion

		function ReviewPanel(props) {
			const sessionId = props.sessionId || "";
			const statePair = useState(null);
			const state = statePair[0];
			const setState = statePair[1];
			const busyPair = useState(false);
			const busy = busyPair[0];
			const setBusy = busyPair[1];
			const reportPair = useState(null);
			const report = reportPair[0];
			const setReport = reportPair[1];
			const repLoadPair = useState(false); // R8（F-10）：報告載入態（按鈕禁用 + 「載入中」）
			const repLoading = repLoadPair[0];
			const setRepLoading = repLoadPair[1];
			const errPair = useState("");
			const uiError = errPair[0];
			const setUiError = errPair[1];
			const noticePair = useState(""); // F4：降級/模式提示（⚠ 橫幅，非錯誤）
			const notice = noticePair[0];
			const setNotice = noticePair[1];
			const connPair = useState(false); // R3：與主機通訊失敗標記（區分「連接錯誤」與「閒置」）
			const connErr = connPair[0];
			const setConnErr = connPair[1];
			const tokenPair = useState(""); // R6：手動 token 配置（遠端部署 bootstrap 僅限回環）
			const tokenText = tokenPair[0];
			const setTokenText = tokenPair[1];
			const manualPair = useState(false);
			const manualMode = manualPair[0];
			const setManualMode = manualPair[1];
			const selPair = useState({ code: true, security: true, flow: true, design: true });
			const dimSel = selPair[0];
			const setDimSel = selPair[1];
			const gatePair = useState("standard");
			const gate = gatePair[0];
			const setGate = gatePair[1];
			const roundsPair = useState(5);
			const maxRoundsSel = roundsPair[0];
			const setMaxRounds = roundsPair[1];
			const scopePair = useState("smart");
			const scopeSel = scopePair[0];
			const setScopeSel = scopePair[1];
			// P1-10：已選模型改為有序清單——數組序即輪換序（host 按 models[(round-1)%len] 輪換）
			const orderPair = useState([]);
			const modelOrder = orderPair[0];
			const setModelOrder = orderPair[1];
			const fsPair = useState("blocking-only"); // P1-11：修復範圍檔位（與通過線解耦）
			const fixScopeSel = fsPair[0];
			const setFixScopeSel = fsPair[1];
			const allModelsPair = useState(MODEL_META);
			const allModels = allModelsPair[0];
			const setAllModels = allModelsPair[1];
			const toggleDim = function (id) {
				setDimSel(Object.assign({}, dimSel, (function () { const n = Object.assign({}, dimSel); n[id] = !dimSel[id]; return n; })()));
			};
			const selectedDims = Object.keys(dimSel).filter(function (k) { return dimSel[k]; });
			const toggleModel = function (key) {
				setModelOrder(modelOrder.indexOf(key) >= 0
					? modelOrder.filter(function (k) { return k !== key; })
					: modelOrder.concat([key])); // 勾選追加到末位（保序）
			};
			const moveModel = function (key, delta) { // P1-10：↑↓ 調序
				const i = modelOrder.indexOf(key);
				const j = i + delta;
				if (i < 0 || j < 0 || j >= modelOrder.length) return;
				const next = modelOrder.slice();
				const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
				setModelOrder(next);
			};
			const modelLabelOf = function (k) {
				for (const m of allModels) if (m.key === k) return m.label;
				return k;
			};

			// R6：配置載入封裝為可重試的 loadConfig（失敗不再永久禁用開始按鈕）
			const loadConfig = useCallback(function () {
				callApi("review-config-get", {}).then(function (r) {
					if (!r || !r.ok) {
						setConfigFailed(true);
						setUiError("配置載入失敗：" + ((r && r.error) || "無響應（請檢查主機/鑑權）"));
						return;
					}
					setConfigFailed(false);
					setUiError("");
					setAllModels(mergeModels(r.availableModels, (r.config || {}).customModels));
					const cfg = r.config || {};
					setScopeSel(cfg.defaultScope === "full" ? "full" : "smart");
					setFixScopeSel(["blocking-only", "plus-medium", "all"].indexOf(cfg.defaultFixScope) >= 0 ? cfg.defaultFixScope : "blocking-only"); // P1-11
					setGate(["loose", "standard", "strict"].indexOf(cfg.defaultGate) >= 0 ? cfg.defaultGate : "standard");
					if ([1, 3, 5, 8, 10].indexOf(cfg.defaultMaxRounds) >= 0) setMaxRounds(cfg.defaultMaxRounds);
					if (cfg.defaultInjectMode === "manual") setManualMode(true);
					// P1-10：defaultModels 數組序即輪換序——保序過濾出已選清單
					const keys = mergeModels(r.availableModels, cfg.customModels).map(function (m) { return m.key; });
					setModelOrder((cfg.defaultModels || []).filter(function (k) { return keys.indexOf(k) >= 0; }));
				}).catch(function (ex) {
					setConfigFailed(true);
					setUiError("配置載入失敗：" + String(ex && ex.message || ex));
					setConnErr(true);
				});
			}, []);
			const configFailedPair = useState(false);
			const configFailed = configFailedPair[0];
			const setConfigFailed = configFailedPair[1];
			useEffect(function () { loadConfig(); }, [loadConfig]);

			const refresh = useCallback(function () {
				if (!sessionId) return;
				callApi("review-state", { session: sessionId })
					.then(function (s) {
						// R3：401/403 等鑑權失敗明確標記（不渲染為「閒置」）
						if (s && (s.error === "未授權" || s.error === "非本機訪問被拒")) { setConnErr(true); return; }
						// R8（F-11）：其他非鑑權錯誤——保留上一次 state，明確提示而非偽裝成「閒置中」
						if (s && s.error) { setUiError("狀態獲取失敗：" + s.error + "（顯示的可能是舊數據）"); return; }
						setConnErr(false);
						setState(s);
						// R9（F-3）：輪詢恢復後清除「狀態獲取失敗」橫幅（僅清輪詢前綴，不吞 post() 操作錯誤）
						setUiError(function (cur) {
							return String(cur || "").indexOf("狀態獲取失敗") === 0 ? "" : cur;
						});
					})
					.catch(function () { setConnErr(true); });
			}, [sessionId]);

			useEffect(function () {
				refresh();
				let disposed = false;
				let disposeTimer = null;
				const period = function () { return state && state.running ? 1000 : 5000; };
				const tick = function () {
					if (disposed) return;
					refresh();
					if (configFailed) loadConfig(); // R6：配置失敗時輪詢自動重試（不再永久禁用開始按鈕）
					disposeTimer = later(tick, period());
				};
				disposeTimer = later(tick, 5000);
				return function () { disposed = true; if (disposeTimer) disposeTimer(); };
			}, [refresh, state && state.running, configFailed, loadConfig]);

			const post = useCallback(function (method, body) {
				setBusy(true); setUiError(""); setNotice("");
				callApi(method, body || {})
					.then(function (r) {
						refresh();
						if (r && r.error) setUiError(r.error);
						// F4：發起回報實際模式——靜默降級（代理離線→報告模式）必須對用戶可見
						if (r && r.downgraded) setNotice("⚠ " + r.downgraded);
					})
					.catch(function (ex) { setUiError(String(ex && ex.message || ex)); })
					.then(function () { setBusy(false); });
			}, [refresh]);

			const loadReport = function () {
				setRepLoading(true); setUiError("");
				callApi("review-report", { session: sessionId })
					.then(function (r) {
						if (r && r.error) { setUiError("報告取得失敗：" + r.error); return; }
						setReport(r.report);
					})
					.catch(function (ex) { setUiError("報告取得失敗：" + String(ex && ex.message || ex)); })
					.then(function () { setRepLoading(false); });
			};

			const run = state ? (state.running ? state.run : state.last) : null;
			const active = run !== null && (run.status === "resolving" || run.status === "reviewing" || run.status === "queued" || run.status === "awaiting-fix" || run.status === "awaiting-confirm");
			const resumable = run !== null && (run.status === "paused" || run.status === "interrupted");
			const previewPath = state && !state.running && state.preview ? state.preview.projectPath : null;

			// R4：首幀加載態（state 未就緒時不渲染「閒置中」假態，開始按鈕也不可用）
			if (state === null) {
				return e("div", { style: { padding: "16px 20px", color: cMuted, fontSize: 13, height: "100%", overflowY: "auto" } },
					connErr ? e("div", { style: { color: cWarn, fontSize: 12, marginBottom: 8 } }, "⚠ 審查面板與主機通訊失敗（鑑權/連接問題）——自動重試中") : "載入中…");
			}

			return e("div", { style: { padding: "16px 20px", overflowY: "auto", height: "100%", color: cText, fontSize: 13 } },
				e("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" } },
					e("button", {
						style: ctl, disabled: busy || active || !sessionId || selectedDims.length === 0 || modelOrder.length === 0,
						onClick: function () {
							setReport(null); // R8（F-10）：發起新閉環時清除上一輪報告
							post("review-start", {
								session: sessionId, injectMode: manualMode ? "manual" : "auto", dims: selectedDims,
								gate: gate, maxRounds: maxRoundsSel, models: modelOrder, scope: scopeSel, fixScope: fixScopeSel,
							});
						},
					}, "▶ 開始審查閉環"),
					// R8（F-14）：禁用原因可見（首次使用不再對著灰按鈕發懵）
					(function () {
						if (busy || active || !(selectedDims.length === 0 || modelOrder.length === 0 || !sessionId)) return null;
						const reasons = [];
						if (!sessionId) reasons.push("未綁定會話");
						if (selectedDims.length === 0) reasons.push("至少勾選一個審查維度（見下方）");
						if (modelOrder.length === 0) reasons.push("未選擇審查模型（需先在 ~/.dsh/settings.yaml 配置 provider 路由）");
						return e("span", { style: { color: cWarn, fontSize: 11 } }, "🔒 無法開始：" + reasons.join("；"));
					})(),
					e("label", { style: { color: cMuted, fontSize: 12, cursor: "pointer", userSelect: "none" } },
						e("input", { type: "checkbox", checked: manualMode, onChange: function (ev) { setManualMode(ev.target.checked); }, style: { marginRight: 4 } }),
						"每輪人工確認注入"),
					active ? e("button", { style: ctl, disabled: busy,
						// R4：停止不可逆（終態 + 清快照）——誤觸即丟全部進度，需確認
						onClick: function () {
							if (typeof window !== "undefined" && !window.confirm("確定終止審查閉環？終止後無法恢復，進度將丟失（需從第 1 輪重跑）。")) return;
							post("review-stop", { session: sessionId });
						} }, "■ 停止") : null,
					resumable ? e("button", { style: { ...ctl, borderColor: cGood, color: cGood }, disabled: busy,
						onClick: function () { post("review-resume", { session: sessionId }); } },
						"▶ 恢復閉環（R" + (run.round + 1) + "）") : null,
					run && run.status === "awaiting-confirm" && run.pendingInject
						? e("button", { style: miniBtn(true), disabled: busy,
							onClick: function () { post("review-inject", { session: sessionId }); } },
							"✎ 確認注入（" + run.pendingInject.count + " 項" + (run.pendingInject.extraCount ? "＋順帶 " + run.pendingInject.extraCount : "") + (run.pendingInject.filteredCount ? "，含已過濾" : "") + "）") : null, // L-4：顯示順帶修復項數
					e("button", { style: ctl, disabled: !sessionId || repLoading, onClick: loadReport }, repLoading ? "載入中…" : "▤ 報告"),
					e("span", { style: { flex: 1 } }),
					// R8（D-4）：異常終態與活躍態視覺分離（不再全用品牌藍）
					run ? e(Pill, {
						tone: run.status === "paused" || run.status === "interrupted" ? cWarn
							: run.status === "failed" || run.status === "stopped" ? cBad
							: run.status === "oscillated" || run.status === "max-rounds" ? cWarn
							: run.status === "passed" || run.status === "reported" ? cGood
							: cBrand,
					}, (RUN_LABEL[run.status] || run.status)) : e("span", { style: { color: cMuted, fontSize: 12 } }, "閒置"),
				),
				uiError !== "" ? e("div", { role: "alert", style: { color: cBad, fontSize: 12, marginBottom: 8 } }, // R8（D-7）：輔助技術播報
					"⚠ " + uiError,
					configFailed ? e("button", {
						style: { marginLeft: 8, background: "transparent", color: cText, border: "1px solid " + cBorder2, borderRadius: 8, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
						onClick: loadConfig,
					}, "重試載入") : null) : null,
				notice !== "" ? e("div", { role: "alert", style: { color: cWarn, fontSize: 12, marginBottom: 8 } }, notice) : null, // D-3：降級提示屬關鍵警告 → alert
				connErr ? e("div", { role: "alert", style: { color: cWarn, fontSize: 12, marginBottom: 8, border: "1px solid " + cWarn, borderRadius: 8, padding: "6px 10px" } },
					"⚠ 審查面板與主機通訊失敗（鑑權/連接問題）——自動重試中；遠端部署請粘貼本機引導得到的 token。",
					e("div", { style: { marginTop: 6, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
						e("input", {
							style: { background: "transparent", color: cText, border: "1px solid " + cBorder2, borderRadius: 8, padding: "4px 8px", fontSize: 12, width: 240, fontFamily: mono },
							placeholder: "粘貼 token（僅遠端部署需要）", value: tokenText,
							onChange: function (ev) { setTokenText(ev.target.value); },
						}),
						e("button", {
							style: { background: "transparent", color: cWarn, border: "1px solid " + cWarn, borderRadius: 8, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
							onClick: function () {
								const t = tokenText.trim();
								if (typeof sessionStorage !== "undefined" && t !== "") sessionStorage.setItem("__review_token", t);
								apiTokenPromise = null; // R6：清緩存，以新值重新引導/使用
								setTokenText("");
								setConnErr(false);
								loadConfig();
								refresh();
							},
						}, "保存並重試"))) : null,
				!active ? e("div", { style: { background: cBg1, border: "1px solid " + cBorder, borderRadius: 10, padding: "10px 14px", marginBottom: 10 } },
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查角度："),
						DIM_META.map(function (d) {
							return e("label", { key: d.id, style: { color: dimSel[d.id] ? cText : cMuted, fontSize: 12, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 } },
								e("input", { type: "checkbox", checked: dimSel[d.id], onChange: function () { toggleDim(d.id); } }),
								d.label);
						}),
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查強度："),
						e(OptPills, { opts: GATE_OPTS, value: gate, onChange: setGate }),
						e("span", { style: { color: cMuted, fontSize: 11 } }, (GATE_OPTS.find(function (g) { return g.id === gate; }) || {}).hint),
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查輪次上限："),
						e(OptPills, {
							opts: ROUND_OPTS.map(function (n) { return { id: n, label: String(n), hint: "最多複審 " + n + " 輪（全綠可提前結束）" }; }),
							value: maxRoundsSel, onChange: setMaxRounds,
						}),
						e("span", { style: { color: cMuted, fontSize: 11 } }, "全綠即提前通過；達上限仍有未過項則停"),
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查範圍："),
						e(OptPills, { opts: SCOPE_OPTS, value: scopeSel, onChange: setScopeSel }),
						e("span", { style: { color: cMuted, fontSize: 11 } }, (SCOPE_OPTS.find(function (s) { return s.id === scopeSel; }) || {}).hint),
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "修復範圍："),
						e(OptPills, { opts: FIX_SCOPE_OPTS, value: fixScopeSel, onChange: setFixScopeSel }),
						e("span", { style: { color: cMuted, fontSize: 11 } },
							(FIX_SCOPE_OPTS.find(function (o) { return o.id === fixScopeSel; }) || {}).hint + "；不影響驗收口徑（通過線由審查強度決定）"),
						(gate === "strict" && fixScopeSel !== "blocking-only") || (gate === "loose" && fixScopeSel === "all")
							? e("span", { style: { color: cWarn, fontSize: 11 } }, " ⚠ 強度與修復檔位重疊：該嚴重度已被閘門收走，「順帶修復」組可能無料——要純順帶修復請調低強度") : null,
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查模型："),
						allModels.map(function (m) {
							const on = modelOrder.indexOf(m.key) >= 0;
							return e("label", { key: m.key, style: { color: on ? cText : cMuted, fontSize: 12, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 } },
								e("input", { type: "checkbox", checked: on, onChange: function () { toggleModel(m.key); } }),
								m.label);
						}),
					),
					// P1-10：已選模型有序 chips（↑↓ 調序）＋ R1→R2 輪換預覽——數組序即輪換序
					e(ModelOrderEditor, { order: modelOrder, labelOf: modelLabelOf, onMove: moveModel, onRemove: toggleModel }),
				) : null,
				run ? e("div", { style: { color: cMuted, fontSize: 12, marginBottom: 10, wordBreak: "break-word", lineHeight: 1.6 } }, // R8（D-9）：長路徑/模型串換行
					e("span", { style: { fontFamily: mono } }, run.projectPath),
					"　輪次 " + run.round + "/" + run.maxRounds
					+ "　模式 " + (run.mode === "report" ? "報告（單輪）" : "閉環（" + (run.injectMode === "auto" ? "全自動注入" : "手動確認") + "）")
					+ (run.gate ? "　強度 " + run.gate : "")
					+ (run.scope ? "　範圍 " + (run.scope === "smart" ? "智慧" : "全量") : "")
					+ (run.fixScope ? "　修復 " + fixScopeLabel(run.fixScope) : "")
					+ (run.models ? "　模型 " + run.models.join(" · ") : "")
				+ (run.tokenUsage ? "　token ≈ " + fmtTok(run.tokenUsage.input) + " in / " + fmtTok(run.tokenUsage.output) + " out" : "")
				) : null,
				run ? run.dimensions.map(function (d) { return e(DimCard, { key: d.id, dim: d }); })
					: e("div", { style: { color: cMuted, fontSize: 13, lineHeight: 1.8 } },
						"自動審查官閒置中（本會話）。", e("br", null),
						previewPath ? e("span", null, "本會話項目：", e("span", { style: { fontFamily: mono, color: cText } }, previewPath), e("br", null)) : null,
						"聊天框輸入 ", e("code", { style: { fontFamily: mono, color: cBrand } }, "/review"), " 或點上方「開始」——兩者同一閉環：審查建議會自動注入本會話聊天框，修復後自動複審。",
						e("br", null), "也可 ", e("code", { style: { fontFamily: mono, color: cBrand } }, "/review <path>"), " 做單輪報告（不注入）。",
						e("br", null), "模型增減與預設請到設置 → 自動審查。"),
				// P1-12：輪次時間線（活躍與終態都顯示；每輪可摺疊卡：模型/範圍/發現/注入/確認修復）
				run ? e(RoundTimeline, { run: run, active: active }) : null,
				run && run.error ? e("div", { role: "alert", style: { marginTop: 10, color: cBad, fontSize: 12 } }, "⚠ " + run.error) : null, // D-4：錯誤播報
				report ? e("div", { style: { marginTop: 14, borderTop: "1px solid " + cBorder, paddingTop: 10 } },
					// P1-7：報告由 <pre> 改輕量 Markdown 渲染（標題/粗體/引用/清單/表格/分隔線）
					e(MdRender, { text: String(report) })) : null,
			);
		}

		//#region 設置頁（settings.section order 90：模型增減 + 預設 + 執行參數）
		function SettingsPage(props) {
			const cfgPair = useState(null);
			const cfg = cfgPair[0];
			const setCfg = cfgPair[1];
			const availablePair = useState([]);
			const availableModels = availablePair[0];
			const setAvailableModels = availablePair[1];
			const persistedPair = useState(true);
			const persisted = persistedPair[0];
			const setPersisted = persistedPair[1];
			const savedJsonPair = useState(""); // P1-7：最近一次已保存/已載入配置快照——供未保存標記比對
			const savedJson = savedJsonPair[0];
			const setSavedJson = savedJsonPair[1];
			const busyPair = useState(false);
			const busy = busyPair[0];
			const setBusy = busyPair[1];
			const msgPair = useState("");
			const msg = msgPair[0];
			const setMsg = msgPair[1];
			const addPair = useState({ label: "", provider: "", model: "" });
			const addForm = addPair[0];
			const setAddForm = addPair[1];

			const load = useCallback(function () {
				callApi("review-config-get", {}).then(function (r) {
					if (!r || !r.ok) { setMsg("配置讀取失敗"); return; }
					setCfg(r.config || {});
					setAvailableModels(r.availableModels || []);
					setPersisted(r.persisted !== false);
					setSavedJson(JSON.stringify(r.config || {}));
				}).catch(function (ex) { setMsg("配置讀取失敗：" + String(ex && ex.message || ex)); });
			}, []);
			useEffect(load, [load]);

			const upd = function (patch) { setCfg(Object.assign({}, cfg, patch)); };
			const updCustom = function (i, patch) {
				const next = (cfg.customModels || []).map(function (m, j) { return j === i ? Object.assign({}, m, patch) : m; });
				upd({ customModels: next });
			};
			const removeCustom = function (i) {
				const m = (cfg.customModels || [])[i];
				// R7：刪除不可撤銷（key/slug 生成可能變化，defaultModels 引用會失效）——與面板停止按鈕一致加確認
				if (typeof window !== "undefined" && !window.confirm("確定刪除自訂模型「" + ((m && (m.label || m.model)) || "?") + "」？刪除後需重新新增。")) return;
				const key = m && m.key;
				const next = (cfg.customModels || []).filter(function (_, j) { return j !== i; });
				const dModels = (cfg.defaultModels || []).filter(function (k) { return k !== key; });
				upd({ customModels: next, defaultModels: dModels });
			};
			const slug = function (s) {
				return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
			};
			const addCustom = function () {
				const provider = addForm.provider.trim();
				const model = addForm.model.trim();
				const label = addForm.label.trim() || model;
				if (provider === "" || model === "") { setMsg("新增模型需要 provider 與 model id（例如 provider=zai、model=glm-5.3）"); return; }
				let key = slug(provider + "-" + model);
				const taken = new Set([].concat(availableModels.map(function (m) { return m.key; }), (cfg.customModels || []).map(function (m) { return m.key; })));
				if (taken.has(key)) key = key + "-" + String((cfg.customModels || []).length + 2);
				upd({
					customModels: (cfg.customModels || []).concat([{ key: key, provider: provider, model: model, label: label }]),
					defaultModels: cfg.defaultModels || [],
				});
				setAddForm({ label: "", provider: "", model: "" });
				setMsg("");
			};
			const toggleDefaultModel = function (key) {
				const cur = cfg.defaultModels || [];
				const next = cur.indexOf(key) >= 0 ? cur.filter(function (k) { return k !== key; }) : cur.concat([key]);
				upd({ defaultModels: next.length > 0 ? next : cur });
			};
			const moveDefaultModel = function (key, delta) { // P1-10：默認陣容 ↑↓ 調序（保序提交）
				const cur = cfg.defaultModels || [];
				const i = cur.indexOf(key);
				const j = i + delta;
				if (i < 0 || j < 0 || j >= cur.length) return;
				const next = cur.slice();
				const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
				upd({ defaultModels: next });
			};
			const save = function () {
				// R8（F-13）：自訂模型 provider/model 為空 → 拒絕保存並提示（防靜默丟棄該模型）
				const blanks = (cfg.customModels || []).filter(function (m) { return !String(m.provider || "").trim() || !String(m.model || "").trim(); });
				if (blanks.length > 0) {
					setMsg("保存失敗：有 " + blanks.length + " 行自訂模型缺 provider/model 欄位（請補全或刪除該行）");
					return;
				}
				setBusy(true); setMsg("");
				callApi("review-config-set", { config: cfg })
					.then(function (r) {
						if (r && r.ok) {
							setPersisted(r.persisted !== false);
							const saved = r.config || cfg;
							setCfg(saved);
							setSavedJson(JSON.stringify(saved));
							if ((r.droppedCustoms || 0) > 0) setMsg("已保存，但 " + r.droppedCustoms + " 條自訂模型因欄位缺失被服務端丟棄");
							else setMsg(r.persisted === false ? "已保存（僅本次運行——動態模式下不持久化）" : "已保存 ✓");
						} else setMsg("保存失敗：" + ((r && r.error) || "未知錯誤"));
					})
					.catch(function (ex) { setMsg("保存失敗：" + String(ex && ex.message || ex)); })
					.then(function () { setBusy(false); });
			};

			if (cfg === null) {
				return e("div", { style: { padding: "16px 20px", color: cMuted, fontSize: 13 } },
					msg !== "" ? e("span", { role: "alert", style: { color: cBad } }, "⚠ " + msg) : "載入中…",
					msg !== "" ? e("button", {
						style: { marginLeft: 8, background: "transparent", color: cText, border: "1px solid " + cBorder2, borderRadius: 8, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
						onClick: load,
					}, "重試") : null);
			}
			const allModels = mergeModels(availableModels, cfg.customModels);
			const inputStyle = {
				background: "transparent", color: cText, border: "1px solid " + cBorder2,
				borderRadius: 8, padding: "4px 10px", fontFamily: mono, fontSize: 12, width: 150,
			};
			const sectionTitle = { color: cText, fontSize: 13, fontWeight: 600, margin: "18px 0 8px" };
			const rowStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 };
			return e("div", { style: { padding: "16px 20px", overflowY: "auto", color: cText, fontSize: 13 } },
				e("div", { style: { color: cMuted, fontSize: 12, lineHeight: 1.6 } },
					"自動審查官（dsh-auto-review）：多模型輪換四維審查閉環。此頁管理審查模型與預設；修改後需按下方「保存設置」才生效。",
					persisted
						? "未保存的修改僅存在於本頁（刷新即丟失），保存後寫入配置並持久化。"
						: e("span", { style: { color: cWarn } }, "當前為動態調試模式：即使保存也僅本次運行有效（profile bundle 部署後才持久化）；未保存的修改僅在本頁。"),
				),

				// ── 模型管理 ──
				e("div", { style: sectionTitle }, "審查模型"),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "內建："),
					availableModels.map(function (m) { return e(Pill, { key: m.key, tone: cMuted }, m.label); }),
					e("span", { style: { color: cMuted, fontSize: 11 } }, "（不可刪；可用下方自訂擴充）")),
				(cfg.customModels || []).map(function (m, i) {
					return e("div", { key: m.key, style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 6 } },
						e("input", { style: Object.assign({}, inputStyle, { width: 130 }), value: m.label,
							onChange: function (ev) { updCustom(i, { label: ev.target.value }); }, placeholder: "顯示名" }),
						e("input", { style: inputStyle, value: m.provider,
							onChange: function (ev) { updCustom(i, { provider: ev.target.value }); }, placeholder: "provider（如 zai）" }),
						e("input", { style: inputStyle, value: m.model,
							onChange: function (ev) { updCustom(i, { model: ev.target.value }); }, placeholder: "model id" }),
						e("span", { style: { color: cMuted, fontSize: 11, fontFamily: mono } }, m.key),
						e("button", { style: Object.assign({}, ctl, { color: cBad, borderColor: cBad, padding: "2px 10px" }),
							onClick: function () { removeCustom(i); } }, "刪除"));
				}),
				e("div", { style: rowStyle },
					e("input", { style: inputStyle, value: addForm.label, placeholder: "顯示名（可選）",
						onChange: function (ev) { setAddForm(Object.assign({}, addForm, { label: ev.target.value })); } }),
					e("input", { style: inputStyle, value: addForm.provider, placeholder: "provider（如 zai）",
						onChange: function (ev) { setAddForm(Object.assign({}, addForm, { provider: ev.target.value })); } }),
					e("input", { style: inputStyle, value: addForm.model, placeholder: "model id（如 glm-5.3）",
						onChange: function (ev) { setAddForm(Object.assign({}, addForm, { model: ev.target.value })); } }),
					e("button", { style: ctl, onClick: addCustom }, "＋ 新增模型")),
				e("div", { style: { color: cMuted, fontSize: 11, marginBottom: 8 } },
					"provider 必須是 ~/.dsh/settings.yaml 已配置的路由 id；發起閉環時會做路由預檢，不可用即拒啟。"),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "默認審查模型（多選，逐輪輪換）："),
					allModels.map(function (m) {
						const on = (cfg.defaultModels || []).indexOf(m.key) >= 0;
						return e("label", { key: m.key, style: { color: on ? cText : cMuted, fontSize: 12, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 } },
							e("input", { type: "checkbox", checked: on, onChange: function () { toggleDefaultModel(m.key); } }),
							m.label);
					})),
				// P1-10：默認陣容同步可排序——↑↓ 調序 + R1→R2 輪換預覽（defaultModels 數組序即輪換序）
				e(ModelOrderEditor, {
					order: cfg.defaultModels || [],
					labelOf: function (k) {
						for (const m of allModels) if (m.key === k) return m.label;
						return k;
					},
					onMove: moveDefaultModel, onRemove: toggleDefaultModel,
				}),

				// ── 閉環預設 ──
				e("div", { style: sectionTitle }, "閉環預設"),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "審查強度："),
					e(OptPills, {
						opts: GATE_OPTS,
						value: cfg.defaultGate, onChange: function (v) { upd({ defaultGate: v }); },
					})),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "輪次上限："),
					e(OptPills, {
						opts: ROUND_OPTS.map(function (n) { return { id: n, label: String(n) }; }),
						value: cfg.defaultMaxRounds, onChange: function (v) { upd({ defaultMaxRounds: v }); },
					})),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "審查範圍："),
					e(OptPills, { opts: SCOPE_OPTS, value: cfg.defaultScope, onChange: function (v) { upd({ defaultScope: v }); } })),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "修復範圍："),
					e(OptPills, { opts: FIX_SCOPE_OPTS, value: cfg.defaultFixScope, onChange: function (v) { upd({ defaultFixScope: v }); } }),
					e("span", { style: { color: cMuted, fontSize: 11 } },
						(FIX_SCOPE_OPTS.find(function (o) { return o.id === cfg.defaultFixScope; }) || {}).hint + "；不影響驗收口徑（通過線由審查強度決定）")),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "注入模式："),
					e(OptPills, {
						opts: [
							{ id: "auto", label: "全自動", hint: "建議直接注入聊天框" },
							{ id: "manual", label: "人工確認", hint: "每輪注入前面板確認" },
						],
						value: cfg.defaultInjectMode, onChange: function (v) { upd({ defaultInjectMode: v }); },
					})),

				e("div", { style: rowStyle },
					e("label", { style: { color: cfg.securityHold ? cText : cMuted, fontSize: 12, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 } },
						e("input", { type: "checkbox", checked: cfg.securityHold === true,
							onChange: function (ev) { upd({ securityHold: ev.target.checked }); }, style: { marginRight: 4 } }),
						"安全發現強制人工確認（保守模式）"),
					e("span", { style: { color: cMuted, fontSize: 11 } }, "默認關=全自動注入（安全發現照常自動修復）；開啟後安全維度發現需人工放行")),

				// ── 執行參數 ──
				e("div", { style: sectionTitle }, "執行參數"),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "審查者併發："),
					e(OptPills, {
						opts: [1, 2, 3, 4].map(function (n) { return { id: n, label: String(n), hint: "同時在跑的審查者上限（跨閉環）" }; }),
						value: cfg.reviewerConcurrency, onChange: function (v) { upd({ reviewerConcurrency: v }); },
					})),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "審查者超時："),
					e(OptPills, {
						opts: [5, 10, 15, 20, 30, 45, 60].map(function (n) { return { id: n, label: n + " 分", hint: "單審查者最長運行時間" }; }),
						value: cfg.reviewerTimeoutMin, onChange: function (v) { upd({ reviewerTimeoutMin: v }); },
					})),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "等待修復超時："),
					e(OptPills, {
						opts: [10, 30, 60, 120, 240].map(function (n) { return { id: n, label: n + " 分", hint: "注入後目標代理無活動暫停閉環的期限（活動自動順延）" }; }),
						value: cfg.fixWaitTimeoutMin, onChange: function (v) { upd({ fixWaitTimeoutMin: v }); },
					}),
					e("span", { style: { color: cMuted, fontSize: 11 } }, "期限內代理每有活動即順延（上限 3×，防僵死永久掛起）；無活動或超上限轉暫停，可 /review resume 恢復")),

				e("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" } },
					e("button", { style: Object.assign({}, ctl, { borderColor: cBrand, color: cBrand }), disabled: busy, onClick: save }, busy ? "保存中…" : "保存設置"),
					// P1-7：未保存標記——修改未保存時明示（配置僅在按「保存設置」後生效）
					cfg !== null && savedJson !== "" && JSON.stringify(cfg) !== savedJson
						? e("span", { style: { color: cWarn, fontSize: 12 } }, "● 有未保存修改（未保存前不生效）") : null,
					msg !== "" ? e("span", { role: msg.indexOf("失敗") >= 0 ? "alert" : "status", style: { color: msg.indexOf("失敗") >= 0 ? cBad : cGood, fontSize: 12 } }, msg) : null),
			);
		}
		//#endregion

		//#region cordis client plugin
		const name = "auto-review-client";
		const inject = ["slots", "timer"];
		function apply(ctx) {
			pluginCtx = ctx; // later() 的定時器句柄（useEffect 前已就緒）
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "review",
				order: 80,
				label: "審查",
				// 正規範式（同 ui-trajectory）：options.inject 鉤子接收會話 id，注入組件 props
				inject: (sid) => ({ sessionId: sid }),
			}, ReviewPanel));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "auto-review",
				order: 90,
				label: "自動審查",
			}, SettingsPage));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
