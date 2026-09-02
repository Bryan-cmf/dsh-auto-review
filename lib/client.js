// dsh-auto-review — client half (v1.3.0).
//
// 「審查」conversation view tab (order 80)：輪次進度 + 四維度卡片 + 注入歷史 + 報告。
// 「自動審查」settings.section (order 90)：模型增減 + 閉環預設 + 執行參數（設置頁）。
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

		//#region tokens（僅官方 13 token，dark fallback）
		const cText = "var(--dsw-alias-label-primary, #c9d1d9)";
		const cMuted = "var(--dsw-alias-label-secondary, #8b949e)";
		const cBad = "var(--dsw-alias-state-error-primary, #f85149)";
		const cGood = "var(--dsw-alias-state-success-primary, #3fb950)";
		const cWarn = "var(--dsw-alias-state-warn-primary, #d29922)";
		const cBrand = "var(--dsw-alias-brand-primary, #58a6ff)";
		const cBg1 = "var(--dsw-alias-bg-layer-1, #161b22)";
		const cBorder = "var(--dsw-alias-border-l1, #30363d)";
		const cBorder2 = "var(--dsw-alias-border-l2, #8b949e)";
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
			if (DYNAMIC) return host.call(method, args || {});
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
			const route = {
				"review-start": "start", "review-stop": "stop", "review-inject": "inject",
				"review-resume": "resume", "review-config-set": "config",
			}[method];
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

		/** 膠囊選擇組（設置頁/面板共用）。 */
		function OptPills(props) {
			return e("span", { style: { display: "inline-flex", gap: 6, flexWrap: "wrap" } },
				props.opts.map(function (o) {
					const on = props.value === o.id;
					return e("button", {
						key: o.id, title: o.hint || "",
						style: {
							background: on ? cBrand : "transparent", color: on ? "#fff" : cText,
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

		function DimCard(props) {
			const dim = props.dim;
			const pair = useState(false);
			const open = pair[0];
			const setOpen = pair[1];
			const tone = dim.status === "passed" ? cGood : (dim.status === "blocking" || dim.status === "failed") ? cBad
				: (dim.status === "reviewing" || dim.status === "resolving") ? cBrand : cMuted;
			const findings = (dim.findings || []).filter(function (f) { return !f.resolved; });
			return e("div", { style: { background: cBg1, border: "1px solid " + cBorder, borderRadius: 10, padding: "10px 14px", marginBottom: 8 } },
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
					findings.length ? e("span", { style: { color: cMuted, fontSize: 11 } }, open ? "▾" : "▸") : null,
				),
				dim.summary ? e("div", { style: { color: cMuted, fontSize: 12, marginTop: 6, lineHeight: 1.5 } }, dim.summary) : null,
				dim.error ? e("div", { style: { color: cBad, fontSize: 12, marginTop: 6 } }, "⚠ " + dim.error) : null,
				open && findings.length ? e("div", { style: { marginTop: 8, borderTop: "1px solid " + cBorder, paddingTop: 8 } },
					findings.map(function (f, i) { return e("div", { key: i, style: { marginBottom: 10 } },
						e("div", { style: { fontSize: 12 } },
							e("span", { style: { color: SEV_COLOR[f.severity], fontWeight: 700, marginRight: 8 } }, "[" + f.severity + "]"),
							e("span", { style: { color: cText, fontFamily: mono, fontSize: 11 } }, f.file + (f.line != null ? ":" + f.line : ""))),
						e("div", { style: { color: cText, fontSize: 12, marginTop: 2 } }, f.title),
						e("div", { style: { color: cMuted, fontSize: 12, marginTop: 2, lineHeight: 1.5 } }, f.detail),
						e("div", { style: { color: cBrand, fontSize: 12, marginTop: 2, lineHeight: 1.5 } }, "→ " + f.suggestion)); }),
				) : null,
			);
		}

		/** 合併內建 + 自訂模型清單（面板勾選用）。 */
		function mergeModels(builtin, custom) {
			const list = (builtin || []).map(function (m) { return { key: m.key, label: m.label || m.model }; });
			for (const c of custom || []) list.push({ key: c.key, label: (c.label || c.model) + "（自訂）" });
			return list;
		}

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
			const mselPair = useState(null); // null = 尚未從配置載入
			const modelSel = mselPair[0];
			const setModelSel = mselPair[1];
			const allModelsPair = useState(MODEL_META);
			const allModels = allModelsPair[0];
			const setAllModels = allModelsPair[1];
			const toggleDim = function (id) {
				setDimSel(Object.assign({}, dimSel, (function () { const n = Object.assign({}, dimSel); n[id] = !dimSel[id]; return n; })()));
			};
			const selectedDims = Object.keys(dimSel).filter(function (k) { return dimSel[k]; });
			const toggleModel = function (key) {
				const n = Object.assign({}, modelSel); n[key] = !n[key]; setModelSel(n);
			};
			const selectedModels = modelSel ? Object.keys(modelSel).filter(function (k) { return modelSel[k]; }) : [];
			const GATE_OPTS = [
				{ id: "loose", label: "寬鬆", hint: "僅 critical 阻斷" },
				{ id: "standard", label: "標準", hint: "critical+high 阻斷" },
				{ id: "strict", label: "嚴格", hint: "critical+high+medium 阻斷" },
			];
			const ROUND_OPTS = [1, 3, 5, 8, 10];

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
					setGate(["loose", "standard", "strict"].indexOf(cfg.defaultGate) >= 0 ? cfg.defaultGate : "standard");
					if ([1, 3, 5, 8, 10].indexOf(cfg.defaultMaxRounds) >= 0) setMaxRounds(cfg.defaultMaxRounds);
					if (cfg.defaultInjectMode === "manual") setManualMode(true);
					const sel = {};
					for (const m of mergeModels(r.availableModels, cfg.customModels)) sel[m.key] = false;
					for (const k of cfg.defaultModels || []) if (k in sel) sel[k] = true;
					setModelSel(sel);
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
						if (s && (s.error === "未授權" || s.error === "非本機訪問被拒")) setConnErr(true);
						else if (s && !s.error) setConnErr(false);
						setState(s);
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
				callApi("review-report", { session: sessionId })
					.then(function (r) { setReport(r.report); })
					.catch(function (ex) { setReport("報告取得失敗：" + String(ex && ex.message || ex)); });
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
						style: ctl, disabled: busy || active || !sessionId || selectedDims.length === 0 || selectedModels.length === 0,
						onClick: function () {
							post("review-start", {
								session: sessionId, injectMode: manualMode ? "manual" : "auto", dims: selectedDims,
								gate: gate, maxRounds: maxRoundsSel, models: selectedModels, scope: scopeSel,
							});
						},
					}, "▶ 開始審查閉環"),
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
						? e("button", { style: { ...ctl, borderColor: cWarn, color: cWarn }, disabled: busy,
							onClick: function () { post("review-inject", { session: sessionId }); } },
							"✎ 確認注入（" + run.pendingInject.count + " 項" + (run.pendingInject.filteredCount ? "，含已過濾" : "") + "）") : null,
					e("button", { style: ctl, disabled: !sessionId, onClick: loadReport }, "▤ 報告"),
					e("span", { style: { flex: 1 } }),
					run ? e(Pill, { tone: run.status === "paused" || run.status === "interrupted" ? cWarn : cBrand }, (RUN_LABEL[run.status] || run.status)) : e("span", { style: { color: cMuted, fontSize: 12 } }, "閒置"),
				),
				uiError !== "" ? e("div", { style: { color: cBad, fontSize: 12, marginBottom: 8 } },
					"⚠ " + uiError,
					configFailed ? e("button", {
						style: { marginLeft: 8, background: "transparent", color: cText, border: "1px solid " + cBorder2, borderRadius: 8, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
						onClick: loadConfig,
					}, "重試載入") : null) : null,
				notice !== "" ? e("div", { style: { color: cWarn, fontSize: 12, marginBottom: 8 } }, notice) : null,
				connErr ? e("div", { style: { color: cWarn, fontSize: 12, marginBottom: 8, border: "1px solid " + cWarn, borderRadius: 8, padding: "6px 10px" } },
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
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查模型："),
						allModels.map(function (m) {
							return e("label", { key: m.key, style: { color: modelSel && modelSel[m.key] ? cText : cMuted, fontSize: 12, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 } },
								e("input", { type: "checkbox", checked: modelSel ? modelSel[m.key] === true : false, onChange: function () { toggleModel(m.key); } }),
								m.label);
						}),
						e("span", { style: { color: cMuted, fontSize: 11 } }, "多選則逐輪輪換：R1 全維度用第 1 個模型，修復後 R2 換第 2 個…跨輪交叉複核"),
					),
				) : null,
				run ? e("div", { style: { color: cMuted, fontSize: 12, marginBottom: 10 } },
					e("span", { style: { fontFamily: mono } }, run.projectPath),
					"　輪次 " + run.round + "/" + run.maxRounds
					+ "　模式 " + (run.mode === "report" ? "報告（單輪）" : "閉環（" + (run.injectMode === "auto" ? "全自動注入" : "手動確認") + "）")
					+ (run.gate ? "　強度 " + run.gate : "")
					+ (run.scope ? "　範圍 " + (run.scope === "smart" ? "智慧" : "全量") : "")
					+ (run.models ? "　模型 " + run.models.join("/") : "")
				) : null,
				run ? run.dimensions.map(function (d) { return e(DimCard, { key: d.id, dim: d }); })
					: e("div", { style: { color: cMuted, fontSize: 13, lineHeight: 1.8 } },
						"自動審查官閒置中（本會話）。", e("br", null),
						previewPath ? e("span", null, "本會話項目：", e("span", { style: { fontFamily: mono, color: cText } }, previewPath), e("br", null)) : null,
						"聊天框輸入 ", e("code", { style: { fontFamily: mono, color: cBrand } }, "/review"), " 或點上方「開始」——兩者同一閉環：審查建議會自動注入本會話聊天框，修復後自動複審。",
						e("br", null), "也可 ", e("code", { style: { fontFamily: mono, color: cBrand } }, "/review <path>"), " 做單輪報告（不注入）。",
						e("br", null), "模型增減與預設請到設置 → 自動審查。"),
				run && run.injectLog && run.injectLog.length ? e("div", { style: { marginTop: 10, color: cMuted, fontSize: 12 } },
					"注入歷史：" + run.injectLog.map(function (x) { return "R" + x.round + "·" + x.count + "項"; }).join("　")) : null,
				run && run.error ? e("div", { style: { marginTop: 10, color: cBad, fontSize: 12 } }, "⚠ " + run.error) : null,
				report ? e("div", { style: { marginTop: 14, borderTop: "1px solid " + cBorder, paddingTop: 10 } },
					e("pre", { style: { whiteSpace: "pre-wrap", fontSize: 12, color: cText, fontFamily: mono } }, report)) : null,
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
			const save = function () {
				setBusy(true); setMsg("");
				callApi("review-config-set", { config: cfg })
					.then(function (r) {
						if (r && r.ok) {
							setPersisted(r.persisted !== false);
							setCfg(r.config || cfg);
							setMsg(r.persisted === false ? "已保存（僅本次運行——動態模式下不持久化）" : "已保存 ✓");
						} else setMsg("保存失敗：" + ((r && r.error) || "未知錯誤"));
					})
					.catch(function (ex) { setMsg("保存失敗：" + String(ex && ex.message || ex)); })
					.then(function () { setBusy(false); });
			};

			if (cfg === null) {
				return e("div", { style: { padding: "16px 20px", color: cMuted, fontSize: 13 } },
					msg !== "" ? e("span", { style: { color: cBad } }, "⚠ " + msg) : "載入中…",
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
					"自動審查官（dsh-auto-review）：多模型輪換四維審查閉環。此頁管理審查模型與預設；",
					persisted ? "修改即時生效並持久化。" : e("span", { style: { color: cWarn } }, "當前為動態調試模式：修改僅本次運行有效（profile bundle 部署後持久化）。"),
				),
				DYNAMIC && !persisted ? e("div", { style: { color: cWarn, fontSize: 11, marginTop: 4 } }) : null,

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

				// ── 閉環預設 ──
				e("div", { style: sectionTitle }, "閉環預設"),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "審查強度："),
					e(OptPills, {
						opts: [
							{ id: "loose", label: "寬鬆", hint: "僅 critical 阻斷" },
							{ id: "standard", label: "標準", hint: "critical+high 阻斷" },
							{ id: "strict", label: "嚴格", hint: "critical+high+medium 阻斷" },
						],
						value: cfg.defaultGate, onChange: function (v) { upd({ defaultGate: v }); },
					})),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "輪次上限："),
					e(OptPills, {
						opts: [1, 3, 5, 8, 10].map(function (n) { return { id: n, label: String(n) }; }),
						value: cfg.defaultMaxRounds, onChange: function (v) { upd({ defaultMaxRounds: v }); },
					})),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "審查範圍："),
					e(OptPills, { opts: SCOPE_OPTS, value: cfg.defaultScope, onChange: function (v) { upd({ defaultScope: v }); } })),
				e("div", { style: rowStyle },
					e("span", { style: { color: cMuted, fontSize: 12 } }, "注入模式："),
					e(OptPills, {
						opts: [
							{ id: "auto", label: "全自動", hint: "建議直接注入聊天框" },
							{ id: "manual", label: "人工確認", hint: "每輪注入前面板確認" },
						],
						value: cfg.defaultInjectMode, onChange: function (v) { upd({ defaultInjectMode: v }); },
					})),

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

				e("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 16 } },
					e("button", { style: Object.assign({}, ctl, { borderColor: cBrand, color: cBrand }), disabled: busy, onClick: save }, busy ? "保存中…" : "保存設置"),
					msg !== "" ? e("span", { style: { color: msg.indexOf("失敗") >= 0 ? cBad : cGood, fontSize: 12 } }, msg) : null),
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
