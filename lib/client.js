// dsh-auto-review — client half (v0.5).
//
// 「審查」conversation view tab (order 80)：輪次進度 + 四維度卡片 + 注入歷史 + 報告。
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
		const mono = "var(--dsw-font-mono, ui-monospace, monospace)";
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
			"max-rounds": "達輪數上限", reported: "報告完成", paused: "暫停",
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

		// 雙模式網層：動態（host.call RPC）vs bundle（fetch HTTP）
		const DYNAMIC = typeof host !== "undefined";
		let pluginCtx = null; // apply() 時捕獲（動態模式定時用）

		/** 統一 API 調用：method 對應 host.call 方法名 / HTTP 路由。 */
		function callApi(method, args) {
			if (DYNAMIC) return host.call(method, args || {});
			const q = encodeURIComponent(String((args || {}).session || ""));
			if (method === "review-state") {
				return fetch("/__review/api/state?session=" + q).then((r) => r.json());
			}
			if (method === "review-report") {
				return fetch("/__review/api/report?session=" + q).then((r) => r.json());
			}
			const route = { "review-start": "start", "review-stop": "stop", "review-inject": "inject" }[method];
			return fetch("/__review/api/" + route, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify(args || {}),
			}).then((r) => r.json());
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
				e("div", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }, onClick: function () { setOpen(!open); } },
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
			const mselPair = useState({ "glm-5.3": true });
			const modelSel = mselPair[0];
			const setModelSel = mselPair[1];
			const toggleDim = function (id) {
				setDimSel(Object.assign({}, dimSel, (function () { const n = Object.assign({}, dimSel); n[id] = !dimSel[id]; return n; })()));
			};
			const selectedDims = Object.keys(dimSel).filter(function (k) { return dimSel[k]; });
			const toggleModel = function (key) {
				const n = Object.assign({}, modelSel); n[key] = !n[key]; setModelSel(n);
			};
			const selectedModels = Object.keys(modelSel).filter(function (k) { return modelSel[k]; });
			const GATE_OPTS = [
				{ id: "loose", label: "寬鬆", hint: "僅 critical 阻斷" },
				{ id: "standard", label: "標準", hint: "critical+high 阻斷" },
				{ id: "strict", label: "嚴格", hint: "critical+high+medium 阻斷" },
			];
			const ROUND_OPTS = [1, 3, 5, 8, 10];

			const refresh = useCallback(function () {
				if (!sessionId) return;
				callApi("review-state", { session: sessionId })
					.then(function (s) { setState(s); })
					.catch(function () {});
			}, [sessionId]);

			useEffect(function () {
				refresh();
				let disposed = false;
				let disposeTimer = null;
				const period = function () { return state && state.running ? 1000 : 5000; };
				const tick = function () {
					if (disposed) return;
					refresh();
					disposeTimer = later(tick, period());
				};
				disposeTimer = later(tick, 5000);
				return function () { disposed = true; if (disposeTimer) disposeTimer(); };
			}, [refresh, state && state.running]);

			const post = useCallback(function (method, body) {
				setBusy(true); setUiError("");
				callApi(method, body || {})
					.then(function (r) {
						refresh();
						if (r && r.error) setUiError(r.error);
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
			const previewPath = state && !state.running && state.preview ? state.preview.projectPath : null;

			return e("div", { style: { padding: "16px 20px", overflowY: "auto", height: "100%", color: cText, fontSize: 13 } },
				e("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" } },
					e("button", { style: ctl, disabled: busy || active || !sessionId || selectedDims.length === 0 || selectedModels.length === 0, onClick: function () { post("review-start", { session: sessionId, injectMode: manualMode ? "manual" : "auto", dims: selectedDims, gate: gate, maxRounds: maxRoundsSel, models: selectedModels }); } },
						"▶ 開始審查閉環"),
					e("label", { style: { color: cMuted, fontSize: 12, cursor: "pointer", userSelect: "none" } },
						e("input", { type: "checkbox", checked: manualMode, onChange: function (ev) { setManualMode(ev.target.checked); }, style: { marginRight: 4 } }),
						"每輪人工確認注入"),
					active ? e("button", { style: ctl, disabled: busy, onClick: function () { post("review-stop", { session: sessionId }); } }, "■ 停止") : null,
					run && run.status === "awaiting-confirm" && run.pendingInject
						? e("button", { style: { ...ctl, borderColor: cWarn, color: cWarn }, disabled: busy,
							onClick: function () { post("review-inject", { session: sessionId }); } },
							"✎ 確認注入（" + run.pendingInject.count + " 項）") : null,
					e("button", { style: ctl, disabled: !sessionId, onClick: loadReport }, "▤ 報告"),
					e("span", { style: { flex: 1 } }),
					run ? e(Pill, { tone: cBrand }, (RUN_LABEL[run.status] || run.status)) : e("span", { style: { color: cMuted, fontSize: 12 } }, "閒置"),
				),
				uiError !== "" ? e("div", { style: { color: cBad, fontSize: 12, marginBottom: 8 } }, "⚠ " + uiError) : null,
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
						GATE_OPTS.map(function (g) {
							const on = gate === g.id;
							return e("button", { key: g.id,
								style: { background: on ? cBrand : "transparent", color: on ? "#fff" : cText, border: "1px solid " + (on ? cBrand : cBorder2), borderRadius: 999, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
								title: g.hint, onClick: function () { setGate(g.id); } },
								g.label);
						}),
						e("span", { style: { color: cMuted, fontSize: 11 } }, (GATE_OPTS.find(function (g) { return g.id === gate; }) || {}).hint),
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查輪次上限："),
						ROUND_OPTS.map(function (n) {
							const on = maxRoundsSel === n;
							return e("button", { key: String(n),
								style: { background: on ? cBrand : "transparent", color: on ? "#fff" : cText, border: "1px solid " + (on ? cBrand : cBorder2), borderRadius: 999, padding: "2px 10px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" },
								title: "最多複審 " + n + " 輪（全綠可提前結束）", onClick: function () { setMaxRounds(n); } },
								String(n));
						}),
						e("span", { style: { color: cMuted, fontSize: 11 } }, "全綠即提前通過；達上限仍有未過項則停"),
					),
					e("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 8 } },
						e("span", { style: { color: cMuted, fontSize: 12 } }, "審查模型："),
						MODEL_META.map(function (m) {
							return e("label", { key: m.key, style: { color: modelSel[m.key] ? cText : cMuted, fontSize: 12, cursor: "pointer", userSelect: "none", display: "inline-flex", alignItems: "center", gap: 4 } },
								e("input", { type: "checkbox", checked: modelSel[m.key] === true, onChange: function () { toggleModel(m.key); } }),
								m.label);
						}),
						e("span", { style: { color: cMuted, fontSize: 11 } }, "多選則逐輪輪換：R1 全維度用第 1 個模型，修復後 R2 換第 2 個…跨輪交叉複核"),
					),
				) : null,
				run ? e("div", { style: { color: cMuted, fontSize: 12, marginBottom: 10 } },
					e("span", { style: { fontFamily: mono } }, run.projectPath),
					"　輪次 " + run.round + "/" + run.maxRounds + "　模式 " + (run.mode === "report" ? "報告（單輪）" : "閉環（" + (run.injectMode === "auto" ? "全自動注入" : "手動確認") + "）") + (run.gate ? "　強度 " + run.gate : "") + (run.models ? "　模型 " + run.models.join("/") : "")
				) : null,
				run ? run.dimensions.map(function (d) { return e(DimCard, { key: d.id, dim: d }); })
					: e("div", { style: { color: cMuted, fontSize: 13, lineHeight: 1.8 } },
						"自動審查官閒置中（本會話）。", e("br", null),
						previewPath ? e("span", null, "本會話項目：", e("span", { style: { fontFamily: mono, color: cText } }, previewPath), e("br", null)) : null,
						"聊天框輸入 ", e("code", { style: { fontFamily: mono, color: cBrand } }, "/review"), " 或點上方「開始」——兩者同一閉環：審查建議會自動注入本會話聊天框，修復後自動複審。",
						e("br", null), "也可 ", e("code", { style: { fontFamily: mono, color: cBrand } }, "/review <path>"), " 做單輪報告（不注入）。"),
				run && run.injectLog && run.injectLog.length ? e("div", { style: { marginTop: 10, color: cMuted, fontSize: 12 } },
					"注入歷史：" + run.injectLog.map(function (x) { return "R" + x.round + "·" + x.count + "項"; }).join("　")) : null,
				run && run.error ? e("div", { style: { marginTop: 10, color: cBad, fontSize: 12 } }, "⚠ " + run.error) : null,
				report ? e("div", { style: { marginTop: 14, borderTop: "1px solid " + cBorder, paddingTop: 10 } },
					e("pre", { style: { whiteSpace: "pre-wrap", fontSize: 12, color: cText, fontFamily: mono } }, report)) : null,
			);
		}

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
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
