// dsh-plugin-context-studio —— 浏览器端模块（DSH client 模块）。
//
// 按 DSH 模块加载器的 factory 格式手写（不需要构建），由 package.json 的 dsh.client 声明。
// React 来自 DSH 的共享模块表，用 React.createElement 写界面。
//
// 注册：左侧栏入口「拼图台」（sidebar.panellist）+ 整页（main 面板）。
// 页面三栏：项目栏 / 素材墙 / 拼盘。所有改动类操作都先弹确认框，执行后可在「操作记录」里撤销。
window.__ModuleLoader__.load({
	id: "dsh-plugin-context-studio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useMemo = React.useMemo;

		var API = "/api/dsh-plugin-context-studio";
		var PANEL_ID = "context-studio";
		var LS_BOARD = "dsh-context-studio:board";
		var LS_PREFS = "dsh-context-studio:prefs";
		var services = null;
		var observedSession = { id: null, available: false };
		var observedListeners = new Set();
		function observeCurrentSession(ctx) {
			var source, dispose, alive = true;
			function publish() { observedListeners.forEach(function (fn) { fn(Object.assign({}, observedSession)); }); }
			try { source = typeof ctx.get === "function" && ctx.get("uiSession")?.adapter?.current; } catch (_) { source = null; }
			if (source && typeof source.getSnapshot === "function" && typeof source.subscribe === "function") {
				function read() {
					if (!alive) return;
					try { var id = source.getSnapshot()?.key; if (typeof id === "string" && id) observedSession.id = id; observedSession.available = true; }
					catch (_) { observedSession.available = false; }
					publish();
				}
				read();
				try { dispose = source.subscribe(read); } catch (_) { observedSession.available = false; publish(); }
			} else { observedSession.available = false; publish(); }
			return function () { alive = false; if (typeof dispose === "function") dispose(); observedSession = { id: null, available: false }; publish(); };
		}

		// ── 和 Host 通信 ────────────────────────────────────────
		function request(path, body, signal) {
			var controller = new AbortController(), timedOut = false, timer, rejectAbort;
			var write = body !== undefined;
			var aborted = new Promise(function (_, reject) { rejectAbort = reject; });
			var cancel = function () { controller.abort(); var e = new Error("读取已取消"); e.name = "AbortError"; rejectAbort(e); };
			if (signal) { signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel(); }
			var timeout = new Promise(function (_, reject) { timer = setTimeout(function () {
				timedOut = true; controller.abort();
				reject(new Error(write && path !== "/compose" ? "请求超时，操作结果未知。请刷新操作记录核对，不要直接重复提交。" : "读取超时，请重试或选择另一个会话。"));
			}, 25000); });
			var work = fetch(API + path, { credentials: "same-origin", signal: controller.signal,
				method: write ? "POST" : "GET", headers: write ? { "content-type": "application/json", "x-context-studio": "1" } : undefined,
				body: write ? JSON.stringify(body) : undefined
			}).then(function (r) { return r.json().then(function (d) {
				if (!r.ok || (d && d.ok === false)) throw new Error((d && (d.error || d.text)) || String(r.status));
				return d;
			}); });
			return Promise.race([work, timeout, aborted]).catch(function (e) {
				if (timedOut) throw new Error(write && path !== "/compose" ? "请求超时，操作结果未知。请刷新操作记录核对，不要直接重复提交。" : "读取超时，请重试或选择另一个会话。");
				throw e;
			}).finally(function () { clearTimeout(timer); if (signal) signal.removeEventListener("abort", cancel); });
		}
		function getJSON(path, signal) { return request(path, undefined, signal); }
		function post(path, body) { return request(path, body); }

		function load(key, fallback) {
			try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
		}
		function save(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
		}

		// ── 格式化 ──────────────────────────────────────────────
		var DAY = 86400000;
		function ago(t) {
			if (!t) return "";
			var d = (Date.now() - t) / DAY;
			if (d < 1 / 24) return "刚刚";
			if (d < 1) return Math.round(d * 24) + " 小时前";
			if (d < 30) return Math.round(d) + " 天前";
			if (d < 365) return Math.round(d / 30) + " 个月前";
			return Math.round(d / 365) + " 年前";
		}
		/** 新旧程度 0（新）~ 1（旧，≥ 180 天）。 */
		function ageLevel(t) {
			if (!t) return 0.5;
			return Math.max(0, Math.min(1, (Date.now() - t) / (180 * DAY)));
		}
		function ageColor(t) {
			var a = ageLevel(t);
			return a < 0.1 ? "var(--green)" : a < 0.5 ? "var(--blue)" : a < 0.9 ? "var(--amber)" : "var(--fg3)";
		}
		function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
		function estimate(text) {
			var t = 0;
			for (var i = 0; i < text.length; i++) {
				var c = text.charCodeAt(i);
				t += c < 128 ? 0.3 : (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) ? 0.6 : 0.5;
			}
			return Math.max(1, Math.ceil(t));
		}

		var KIND_LABEL = { instruction: "指令", skill: "技能", session: "会话", snippet: "摘录", dot: "Dot 记忆", file: "文件", note: "便签" };
		var KIND_COLOR = { instruction: "var(--blue)", skill: "#8b5cf6", session: "#0ea5e9", snippet: "#14b8a6", dot: "#ec4899", file: "var(--amber)", note: "var(--fg3)" };
		var FLAG_LABEL = { "missing-path": "路径失效", duplicate: "重复", stale: "陈旧", shadowed: "被遮蔽", archived: "已归档" };

		var CSS = [
			".csx{--fg:var(--dsw-alias-label-primary,#0f1115);--fg2:var(--dsw-alias-label-secondary,#61666b);--fg3:var(--dsw-alias-label-tertiary,#81858c);",
			"--bg:var(--dsw-alias-bg-base,#fff);--card:var(--dsw-alias-bg-layer-1,#fff);--line:var(--dsw-alias-border-l2,#0000001a);--line1:var(--dsw-alias-border-l1,#0000000a);",
			"--hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--blue:var(--dsw-alias-state-business-primary,#4176e6);--blueBg:var(--dsw-alias-state-business-tertiary,#e4edfd);",
			"--green:var(--dsw-alias-state-success-primary,#22c55e);--red:var(--dsw-alias-state-error-primary,#ec1313);--redBg:var(--dsw-alias-interactive-bg-hover-danger,#ec13130d);",
			"--amber:var(--dsw-alias-state-warn-primary,#f59e0b);--amberBg:var(--dsw-alias-state-warn-tertiary,#fef5e7);--mono:var(--ds-font-family-code,monospace);",
			"color:var(--fg);font-size:13px;line-height:20px;box-sizing:border-box;height:100%;display:flex;flex-direction:column;min-height:0}",
			".csx *{box-sizing:border-box}",
			".csx-top{display:flex;align-items:center;gap:12px;padding:16px 20px 10px;border-bottom:1px solid var(--line1)}",
			".csx-h1{font-size:18px;line-height:26px;font-weight:600;margin:0}",
			".csx-muted{color:var(--fg3);font-size:12px}",
			".csx{container-type:inline-size}",
			".csx-cols{flex:1;display:grid;grid-template-columns:200px minmax(0,1fr) 340px;min-height:0}",
			".csx-cols.noboard{grid-template-columns:200px minmax(0,1fr)}.csx-cols.noboard>.csx-col:nth-child(3){display:none}",
			"@container (max-width:980px){.csx-cols{grid-template-columns:150px minmax(0,1fr) 290px}.csx-cols.noboard{grid-template-columns:150px minmax(0,1fr)}}",
			".csx-col{overflow:auto;padding:12px 14px;min-height:0}",
			".csx-col+.csx-col{border-left:1px solid var(--line1)}",
			".csx-sec{font-size:12px;font-weight:600;color:var(--fg2);margin:14px 0 6px;display:flex;align-items:center;gap:6px}",
			".csx-sec:first-child{margin-top:0}",
			".csx-proj{display:flex;align-items:center;gap:6px;width:100%;text-align:left;font:inherit;color:var(--fg);background:none;border:0;border-radius:8px;padding:6px 8px;cursor:pointer}",
			".csx-proj:hover{background:var(--hover)}.csx-proj.on{background:var(--blueBg);color:var(--blue);font-weight:600}",
			".csx-row{display:flex;align-items:center;gap:6px;min-width:0}.csx-grow{flex:1;min-width:0}",
			".csx-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".csx-btn{font:inherit;font-size:12px;line-height:18px;color:var(--fg2);background:transparent;border:1px solid var(--line);border-radius:8px;padding:3px 9px;cursor:pointer;white-space:nowrap}",
			".csx-btn:hover{background:var(--hover);color:var(--fg)}.csx-btn:disabled{opacity:.45;cursor:default}",
			".csx-btn.primary{color:#fff;background:var(--blue);border-color:var(--blue)}.csx-btn.primary:hover{opacity:.9;color:#fff}",
			".csx-btn.danger{color:var(--red)}.csx-btn.danger:hover{background:var(--redBg)}",
			".csx-btn.ghost{border-color:transparent}.csx-btn.on{background:var(--blueBg);color:var(--blue);border-color:transparent}",
			".csx-chip{display:inline-flex;align-items:center;gap:3px;font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;background:var(--hover);color:var(--fg2);white-space:nowrap}",
			".csx-chip.warn{background:var(--amberBg);color:#b45309}",
			".csx-group{margin:12px 0 4px;font-size:12px;color:var(--fg3);font-family:var(--mono)}",
			".csx-piece{position:relative;display:flex;gap:8px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:7px 10px 7px 12px;margin:4px 0;background:var(--card);overflow:hidden}",
			".csx-piece::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--k)}",
			".csx-piece.flagged{border-color:#f59e0b66}.csx-piece.inboard{background:var(--blueBg)}",
			".csx-piece[draggable=true]{cursor:grab}",
			".csx-text{white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:19px;max-height:7.2em;overflow:hidden}",
			".csx-text.open{max-height:none}",
			".csx-meta{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;margin-top:3px;font-size:11px;color:var(--fg3)}",
			".csx-age{display:inline-block;width:6px;height:6px;border-radius:50%}",
			".csx-acts{display:flex;gap:4px;flex:none;opacity:.35}.csx-piece:hover .csx-acts{opacity:1}",
			".csx-check{width:16px;height:16px;margin-top:2px;flex:none;accent-color:var(--blue);cursor:pointer}",
			".csx-input{font:inherit;font-size:12.5px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:5px 9px;width:100%;outline:none}",
			".csx-input:focus{border-color:var(--blue)}",
			"textarea.csx-input{resize:vertical;min-height:54px;font-family:inherit}",
			".csx-board{border:1.5px dashed var(--line);border-radius:12px;padding:6px;min-height:90px}",
			".csx-board.drop{border-color:var(--blue);background:var(--blueBg)}",
			".csx-bitem{display:flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:5px 8px;margin:4px 0;background:var(--card);cursor:grab;font-size:12.5px}",
			".csx-bitem.over{border-color:var(--red);background:var(--redBg)}.csx-bitem.dragover{border-top:2px solid var(--blue)}",
			".csx-k{width:8px;height:8px;border-radius:2px;flex:none}",
			".csx-bar{height:6px;border-radius:3px;background:var(--hover);overflow:hidden;margin:6px 0 2px}",
			".csx-bar>i{display:block;height:100%;background:var(--blue);transition:width .2s}",
			".csx-bar.over>i{background:var(--red)}",
			".csx-pre{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:11.5px;line-height:17px;background:var(--hover);border-radius:8px;padding:8px 10px;max-height:320px;overflow:auto;margin:0}",
			".csx-tabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:6px}",
			".csx-mask{position:fixed;inset:0;background:#0006;z-index:1000;display:flex;align-items:center;justify-content:center}",
			".csx-dialog{background:var(--bg);color:var(--fg);border-radius:14px;box-shadow:0 12px 40px #0004;width:min(560px,92vw);max-height:84vh;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:10px;font-size:13px}",
			".csx-dialog h3{margin:0;font-size:16px}",
			".csx-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1001;border-radius:10px;padding:8px 14px;font-size:13px;background:var(--fg);color:var(--bg);box-shadow:0 6px 20px #0003;display:flex;gap:10px;align-items:center}",
			".csx-toast.err{background:var(--red);color:#fff}",
			".csx-op{display:flex;gap:6px;align-items:center;font-size:12px;padding:4px 0;border-bottom:1px solid var(--line1)}",
			".csx-op.undone{opacity:.5;text-decoration:line-through}",
			".csx-empty{color:var(--fg3);font-size:12px;padding:16px 4px;text-align:center}",
			".csx-snip{border-left:2px solid var(--line);padding:2px 0 2px 8px;margin:4px 0;display:flex;gap:6px;align-items:flex-start}",
			// 脉络图
			".csx-viewtabs{border-bottom:1px solid var(--line1);padding-bottom:8px;margin-bottom:8px}",
			".csx-sumbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:4px}",
			".csx-legend{margin-bottom:8px;line-height:18px}",
			".csx-matrix{overflow-x:auto;padding-bottom:6px}",
			".csx-grow-row{display:grid;align-items:center;min-width:max-content;border-radius:6px;cursor:pointer}",
			".csx-grow-row:not(.csx-mhead):hover{background:var(--hover)}.csx-grow-row.sel{background:var(--blueBg)}",
			".csx-grow-row.dim>.csx-srow{opacity:.35}",
			".csx-mhead{cursor:default;position:sticky;top:0;z-index:2;background:var(--bg);height:112px;align-items:end;border-bottom:1px solid var(--line1)}",
			".csx-mcol{height:108px;display:flex;align-items:flex-end;justify-content:center;cursor:pointer;border-bottom:3px solid var(--c);border-radius:4px 4px 0 0}",
			".csx-mcol:hover,.csx-mcol.sel{background:var(--hover)}.csx-mcol.dim{opacity:.3}",
			".csx-mcol>span{writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px;line-height:13px;max-height:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);color:var(--fg2)}",
			".csx-cell{height:100%;display:flex;align-items:center;justify-content:center;position:relative}",
			".csx-cell.life::before{content:'';position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;background:var(--c);opacity:.25}",
			".csx-cell.dim{opacity:.2}",
			".csx-dot{position:relative;width:11px;height:11px;border-radius:50%;background:var(--c);box-shadow:0 0 0 2px var(--bg)}",
			".csx-dot.old{background:var(--bg);border:2px solid var(--amber)}",
			".csx-chain{margin:10px 0 4px;transition:opacity .15s}.csx-chain.dim{opacity:.45}",
			".csx-chainhead{display:flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 4px;border-radius:6px;cursor:pointer;min-width:0}",
			".csx-chainhead:hover{background:var(--hover)}",
			".csx-lanes{position:absolute;left:0;top:0;pointer-events:none;z-index:1;overflow:visible}",
			".csx-srow{display:flex;align-items:baseline;gap:8px;min-width:0;padding-right:10px}",
			".csx-lone{display:flex;justify-content:flex-start;padding-left:4px}.csx-lone>i{width:10px;height:10px;border-radius:50%;display:block}",
			".csx-detail{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-top:10px;background:var(--bg);position:sticky;bottom:0;z-index:3;max-height:42%;overflow:auto;box-shadow:0 -4px 16px #0000000f}",
			".csx-link{color:var(--blue);text-decoration:none}.csx-link:hover{text-decoration:underline}",
		].join("\n");

		CSS += `
/* Context debugger: quiet surfaces, readable evidence, deliberate hierarchy. */
.csx{--accent:#357a70;--accentBg:color-mix(in srgb,var(--accent) 10%,var(--bg));--blue:var(--accent);--blueBg:var(--accentBg);background:var(--bg);font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.6}
.csx-top{padding:20px 24px;gap:14px;border-bottom:1px solid var(--line);background:var(--card)}
.csx-h1{font-size:20px;letter-spacing:-.5px;font-weight:650}.csx-top .csx-muted{margin-top:3px}
.csx-cols{grid-template-columns:190px minmax(0,1fr) 320px}.csx-cols.noboard{grid-template-columns:190px minmax(0,1fr)}
.csx-col{padding:20px}.csx-col:first-child{background:color-mix(in srgb,var(--fg) 2%,var(--bg));padding:18px 12px}
.csx-col:nth-child(3){background:color-mix(in srgb,var(--accent) 3%,var(--bg))}
.csx-btn{padding:6px 11px;border-radius:7px;font-size:12px;transition:background .15s}.csx-btn.primary{background:var(--accent);border-color:var(--accent)}
.csx button:focus-visible,.csx input:focus-visible,.csx textarea:focus-visible,.csx select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.csx-input{padding:8px 10px;border-radius:7px}.csx-proj{padding:9px 10px}.csx-sec{margin:24px 0 10px;letter-spacing:.4px}.csx-muted{color:var(--fg2)}
.csx-viewtabs{gap:4px;margin-bottom:22px;padding-bottom:12px}.csx-viewtabs .csx-btn{border:0;padding:8px 14px}.csx-viewtabs .csx-btn.on{font-weight:600}
.csx-piece{padding:13px 14px;margin:9px 0}.csx-piece::before{width:2px}.csx-piece .csx-acts{opacity:1}.csx-pre{font-size:12px;line-height:1.8;padding:14px}
.csx-board{border:1px solid var(--line);padding:8px;background:var(--card)}.csx-bitem{padding:9px;margin:5px 0}.csx-chip{border-radius:5px;padding:2px 6px}
.csx-eyebrow{font-size:10px;font-weight:650;letter-spacing:1.8px;color:var(--accent);text-transform:uppercase}
.csx-nav-session{display:block;width:100%;border:0;border-left:2px solid transparent;background:none;color:var(--fg2);text-align:left;padding:10px 9px;font:inherit;cursor:pointer;border-radius:0 7px 7px 0;margin:3px 0}
.csx-nav-session:hover{background:var(--hover)}.csx-nav-session.on{background:var(--accentBg);border-left-color:var(--accent);color:var(--fg)}
.csx-nav-session b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;font-weight:550;line-height:1.65}.csx-nav-session small{display:block;font-size:10px;opacity:.7;margin-top:3px}
.csx-inspect{container-type:inline-size;container-name:inspector}.csx-inspect-head{display:flex;align-items:start;gap:12px;margin-bottom:18px}.csx-inspect h2{font-size:22px;line-height:1.4;font-weight:600;letter-spacing:-.6px;margin:4px 0 6px}
.csx-answer{border:1px solid var(--line);border-radius:12px;padding:18px 20px;background:var(--card);margin:16px 0}.csx-answer-text{font-size:14px;line-height:1.9;white-space:pre-wrap;overflow:auto;max-height:140px;overflow-wrap:anywhere;margin:10px 0 0}
.csx-flow{display:flex;align-items:center;gap:10px;margin:18px 0;color:var(--fg3);font-size:12px}.csx-flow>div{flex:1;border-top:2px solid var(--line);padding-top:8px}.csx-flow>div:last-child{border-color:var(--accent)}.csx-flow strong{display:block;font-size:16px;color:var(--fg);font-weight:550}.csx-flow small{font-size:11px}
.csx-branches{display:flex;flex-wrap:wrap;gap:4px}.csx-branches .csx-btn{font-size:10px;padding:3px 6px;border-radius:4px;background:var(--card)}
.csx-evidence{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}.csx-evidence-top{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--line)}
.csx-evidence-grid{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:340px}.csx-source-list{padding:8px;border-right:1px solid var(--line);max-height:530px;overflow:auto}.csx-source-list>.csx-input{margin-bottom:8px}
.csx-source{width:100%;display:block;text-align:left;font:inherit;border:1px solid transparent;background:none;color:var(--fg);padding:10px;border-radius:7px;cursor:pointer;margin:2px 0}.csx-source.on{background:var(--accentBg);border-color:color-mix(in srgb,var(--accent) 25%,transparent)}.csx-source:hover{background:var(--hover)}
.csx-source-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:550}.csx-source-head i{width:6px;height:6px;border-radius:50%;background:var(--accent)}.csx-source-head i.err{background:var(--red)}.csx-source small{display:block;font-size:10px;color:var(--fg3);margin-top:4px}.csx-source-preview{font-size:11px;color:var(--fg2);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-top:4px}
.csx-evidence-body{padding:20px;min-width:0}.csx-evidence-body h3{font-size:15px;margin:0 0 6px}.csx-source-text{width:100%;min-height:230px;max-height:450px;resize:vertical;border:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);background:transparent;color:var(--fg);font:12px/1.85 var(--mono);padding:16px 0;margin:12px 0;outline:none;overflow-wrap:anywhere;white-space:pre-wrap}
.csx-evidence-meta{font-size:11px;color:var(--fg2);overflow-wrap:anywhere}.csx-evidence-meta a{color:var(--accent)}.csx-status{font-size:10px;color:var(--accent);background:var(--accentBg);padding:2px 6px;border-radius:4px}.csx-status.warn{color:var(--amber);background:var(--amberBg)}
.csx-hint{font-size:11px;line-height:1.8;color:var(--fg2);margin:14px 0 0}.csx-warning{border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:8px;padding:14px 16px;margin:10px 0;text-align:left;display:block;width:100%;font:inherit;background:var(--card);color:var(--fg);cursor:pointer}.csx-warning strong{font-size:13px}.csx-warning p{font-size:12px;margin:5px 0 0;color:var(--fg2)}
.csx-welcome{padding:48px 24px;max-width:760px;margin:auto}.csx-welcome h2{font-size:28px;font-weight:550;letter-spacing:-1px}.csx-welcome p{color:var(--fg2);font-size:14px;line-height:1.9}.csx-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:36px}.csx-steps div{border-top:1px solid var(--line);padding-top:16px}.csx-steps b{display:block;font-size:14px;margin:10px 0}.csx-steps small{color:var(--fg2);font-size:12px}
@container inspector (max-width:700px){.csx-evidence-grid{grid-template-columns:1fr}.csx-source-list{max-height:210px;border-right:0;border-bottom:1px solid var(--line)}.csx-inspect-head{flex-wrap:wrap}.csx-flow{gap:8px}.csx-flow strong{font-size:14px}.csx-evidence-body{padding:16px}}
@container (max-width:960px){.csx-cols{grid-template-columns:150px minmax(0,1fr) 280px}.csx-cols.noboard{grid-template-columns:150px minmax(0,1fr)}.csx-col{padding:14px}.csx-top{padding:16px}.csx-top .csx-muted{display:none}}
@container (max-width:760px){.csx-cols{grid-template-columns:140px minmax(0,1fr)}.csx-cols>.csx-col:nth-child(3){grid-column:1/-1;border-top:1px solid var(--line);max-height:50vh}.csx-cols.noboard{grid-template-columns:140px minmax(0,1fr)}.csx-cols{overflow:auto}.csx-col{min-height:350px}.csx-steps{grid-template-columns:1fr}.csx-top{flex-wrap:wrap}}
.csx-session-picker{padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin:0 0 20px;gap:10px;background:var(--card)}.csx-session-picker label{font-size:12px;flex-shrink:0}
.csx-inspect-head h2{font-size:21px;overflow-wrap:anywhere}.csx-answer-nav{margin-bottom:12px}.csx-answer-nav .csx-row{gap:8px}.csx-answer-nav select{width:0;min-width:80px}.csx-answer-jumps{flex-wrap:wrap;margin-top:4px}.csx-answer-jumps .csx-btn{padding:4px 7px}
.csx-answer-compact{padding:14px 16px;margin:12px 0 22px;background:var(--hover)}.csx-answer-compact .csx-answer-text{font-size:13px;line-height:1.8;max-height:6em;margin:8px 0 0}.csx-read-status{font-size:12px;color:var(--fg2);padding:10px 12px;background:var(--hover);border-radius:8px;margin:10px 0}
.csx-module-heading,.csx-record-heading{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap}.csx-module-heading h3,.csx-record-heading h3,.csx-detail-panel h3{font-size:15px;line-height:1.5;margin:5px 0 10px;font-weight:600}
.csx-state-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 14px}.csx-state-tabs .csx-btn.on{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 35%,transparent)}
.csx-module-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.csx-module-card{font:inherit;text-align:left;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:11px;min-width:0;padding:16px;cursor:pointer;display:flex;flex-direction:column;gap:6px;transition:border-color .15s,background .15s}
.csx-module-card:hover{background:var(--hover)}.csx-module-card.on{border-color:var(--accent);background:var(--accentBg)}.csx-module-title{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:600;font-size:14px}.csx-module-title b{font-weight:550;font-size:20px;line-height:1.2;color:var(--accent)}
.csx-module-description{font-size:12px;color:var(--fg2);line-height:1.7}.csx-module-counts{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;margin-top:auto;padding-top:5px;font-size:10px;color:var(--fg2)}
.csx-module-card.empty{background:transparent;border-style:dashed}.csx-module-card.empty .csx-module-title,.csx-module-card.empty .csx-module-title b{color:var(--fg2)}.csx-module-action{font-size:11px;color:var(--accent);padding-top:4px}.csx-module-selection{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;margin:12px 0 18px;border:1px solid var(--line);border-radius:9px;background:var(--accentBg)}.csx-empty-modules{margin:10px 0;color:var(--fg2);font-size:12px}.csx-empty-modules summary{cursor:pointer;padding:6px}.csx-empty-modules[open]>.csx-module-grid{margin-top:8px}.csx-records:focus{outline:0}.csx-records{scroll-margin-top:20px}
.csx-background-modules{margin:12px 0 24px;border:1px solid var(--line);border-radius:10px;padding:10px 14px}.csx-background-modules summary,.csx-inspect-warnings summary{font-size:12px;cursor:pointer;color:var(--fg2);padding:4px}.csx-background-modules[open]>.csx-module-grid{margin-top:12px}
.csx-records{border-top:1px solid var(--line);padding-top:18px}.csx-record-search{margin:8px 0 14px;gap:8px}.csx-record-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.csx-record-card{min-width:0;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--card);display:flex;flex-direction:column}.csx-record-card.on{border-color:var(--accent)}.csx-record-card h4{font-weight:550;font-size:13px;margin:0;overflow-wrap:anywhere}.csx-record-card>.csx-row:last-child{margin-top:auto}
.csx-record-preview{font-size:12px;line-height:1.8;color:var(--fg2);overflow-wrap:anywhere;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:8px 0 12px}.csx-record-issue{font-size:11px;line-height:1.6;color:var(--fg2);border-left:2px solid var(--amber);padding-left:8px;margin:0 0 10px}.csx-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:14px 0;font-size:11px;color:var(--fg2)}
.csx-inspect-warnings{margin-top:20px;border-top:1px solid var(--line);padding-top:10px}.csx-warning{cursor:default}.csx-detail-panel{position:fixed;right:24px;top:8vh;bottom:24px;width:min(650px,calc(100vw - 48px));max-height:90vh;overflow:auto;overscroll-behavior:contain;border:1px solid var(--line);border-radius:14px;background:var(--bg);padding:22px;box-shadow:0 12px 60px #0003;z-index:100;outline:none}.csx-detail-panel>.csx-row:first-child{position:sticky;top:-22px;margin:-22px -22px 12px;padding:18px 22px 10px;background:var(--bg);border-bottom:1px solid var(--line);z-index:1}.csx-detail-panel .csx-source-text{min-height:230px;height:32vh;max-height:55vh;margin:4px 0 12px;padding:12px;font-family:inherit;border:1px solid var(--line);border-radius:8px;background:var(--card)}
@container inspector (max-width:520px){.csx-module-grid,.csx-record-grid{grid-template-columns:1fr}.csx-answer-nav>.csx-row:first-child{flex-wrap:wrap}.csx-answer-nav select{order:-1;flex-basis:100%;width:100%}.csx-answer-compact>.csx-row{flex-wrap:wrap}.csx-module-heading h3{font-size:14px}.csx-answer-jumps .csx-grow{display:none}}
.csx-top{padding:12px 20px}.csx-viewtabs{margin-bottom:12px;padding-bottom:8px}.csx-viewtabs .csx-btn{padding:6px 12px}.csx-session-picker{padding:6px 10px;margin-bottom:12px}.csx-inspect-head{margin-bottom:8px}.csx-inspect-head h2{font-size:18px;line-height:1.4;margin:2px 0}.csx-answer-nav{margin-bottom:8px}.csx-answer-end{display:inline-flex}.csx-answer-end .csx-btn{font-size:11px;padding:4px 6px}
.csx-answer-compact{padding:8px 14px;margin:8px 0 14px}.csx-answer-compact .csx-answer-text{font-size:12.5px;line-height:1.65;max-height:3.3em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:5px 0 0}.csx-answer-compact>.csx-row .csx-btn{padding:4px 8px}
.csx-module-heading h3{margin:3px 0 5px}.csx-state-tabs{margin:7px 0 10px}.csx-module-card{padding:11px 13px;gap:3px;min-height:100px}.csx-module-title{font-size:13px}.csx-module-title b{font-size:18px}.csx-module-description{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px}.csx-module-counts{padding-top:2px;gap:4px 6px}.csx-module-action{margin-left:auto;padding-top:0}.csx-background-modules{margin:10px 0 16px;padding:7px 12px}
@container inspector (min-width:800px){.csx-module-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
`;
		CSS += `
.csx-flow-app{--accent:#397b73;--accentBg:color-mix(in srgb,var(--accent) 8%,var(--bg));background:color-mix(in srgb,var(--fg) 1.5%,var(--bg));font-size:13px;line-height:1.6;overflow:hidden}.csx-flow-app .csx-top{background:var(--bg);padding:12px 22px;gap:12px}.csx-app-caption{font-size:11px;color:var(--fg2);margin-left:14px}.csx-flow-app .csx-h1{font-size:18px;display:inline;font-weight:650;letter-spacing:0}.csx-debug-content{padding:14px 22px 24px;overflow:auto;min-height:0;flex:1}.csx-context-picker{display:flex;align-items:center;gap:10px;margin-bottom:8px}.csx-context-picker>select:first-child{width:170px}.csx-context-picker>select:nth-child(2){max-width:520px}.csx-context-picker .csx-input{background:var(--bg);padding:6px 10px}.csx-debug-header{display:flex;justify-content:space-between;align-items:center;gap:14px;margin:6px 0}.csx-debug-header h2{font-size:14px;letter-spacing:0;margin:0}.csx-debug-header .csx-eyebrow{display:none}.csx-debug-header .csx-btn{font-size:11px;padding:3px 7px}
.csx-time-navigation{margin:8px 0 16px}.csx-time-navigation>.csx-row{max-width:820px}.csx-time-navigation select{width:0;min-width:80px;font-size:12px;padding:6px 8px}.csx-time-navigation .csx-btn{font-size:11px;padding:5px 8px}.csx-time-track{display:flex;overflow-x:auto;gap:0;padding:8px 0 3px;margin-top:3px;scrollbar-width:thin}.csx-time-node{flex:0 0 140px;min-width:0;border:0;background:none;color:var(--fg2);font:inherit;font-size:11px;text-align:left;padding:12px 12px 4px 0;position:relative;cursor:pointer}.csx-time-node::before{content:'';position:absolute;top:4px;left:0;right:0;height:1px;background:var(--line)}.csx-time-node::after{content:'';position:absolute;top:1px;left:4px;width:7px;height:7px;border:1px solid var(--fg3);border-radius:50%;background:var(--bg)}.csx-time-node.on::after{border:2px solid var(--accent);background:var(--accent);box-shadow:0 0 0 3px var(--accentBg)}.csx-time-node.on{color:var(--accent);font-weight:600}.csx-time-node span,.csx-time-node small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.csx-time-node small{font-size:10px;font-weight:400;color:var(--fg2);max-width:122px}.csx-time-window{max-width:820px;font-size:10px}.csx-time-window .csx-grow{text-align:center}
.csx-debug-layout{display:grid;grid-template-columns:minmax(0,1fr) 296px;gap:22px;align-items:start}.csx-debug-main{min-width:0;outline:none}.csx-debug-side{min-width:0;border-left:1px solid var(--line);padding-left:20px}.csx-debug-side h3{font-size:15px;font-weight:600;line-height:1.4;margin:5px 0 8px}.csx-side-intro{font-size:12px;line-height:1.75;color:var(--fg2);margin:0 0 12px}.csx-guidance{margin-bottom:24px}.csx-guidance-item{display:block;width:100%;font:inherit;text-align:left;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:11px 12px;margin:8px 0;cursor:pointer}.csx-guidance-item:hover{border-color:var(--accent);background:var(--accentBg)}.csx-guidance-item.warning{border-left:3px solid #c3a06c}.csx-guidance-item strong{display:block;font-size:12px;font-weight:600}.csx-guidance-item span{display:block;font-size:11px;color:var(--fg2);line-height:1.7;margin:5px 0}.csx-guidance-item small{font-size:10px;color:var(--accent)}
.csx-flow-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.csx-flow-heading h3{font-size:17px;font-weight:600;line-height:1.4;margin:0 0 4px}.csx-flow-heading p{font-size:11px;color:var(--fg2);margin:0;line-height:1.65;max-width:580px}.csx-flow-heading .csx-btn{font-size:11px;flex-shrink:0}.csx-flow-delta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:12px 0;font-size:12px}.csx-flow-delta b{font-size:15px;margin-left:3px;font-weight:600}.csx-flow-delta .new{color:var(--accent)}.csx-flow-delta .removed{color:#a57d42}.csx-flow-delta>.csx-muted{font-size:10px;margin-left:auto}.csx-retained{font:inherit;font-size:11px;color:var(--fg2);border:1px dashed var(--line);border-radius:6px;background:transparent;padding:4px 8px;cursor:pointer}.csx-retained:hover{background:var(--hover)}
.csx-flow-toolbar{display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin:12px 0 8px}.csx-flow-toolbar>.csx-btn{border:0;font-size:11px;padding:5px 8px}.csx-flow-toolbar>.csx-btn small{font-size:10px;opacity:.7;margin-left:4px}.csx-flow-toolbar .on{font-weight:600}.csx-flow-search{display:flex;gap:3px;margin-left:auto;width:205px}.csx-flow-search input{padding:5px 8px;font-size:11px}.csx-flow-search .csx-btn{font-size:11px;padding:5px 6px}.csx-active-filter{font-size:11px;color:var(--fg2);margin:6px 0}.csx-active-filter .csx-btn{font-size:10px;padding:2px 5px}.csx-flow-page-meta{font-size:10px;color:var(--fg2);margin:8px 0}.csx-flow-loading{border:1px dashed var(--line);border-radius:12px;padding:70px 24px;color:var(--fg2);text-align:center;font-size:13px}
.csx-flow-scroll{width:100%;max-height:62vh;min-height:360px;overflow:auto;border:1px solid var(--line);border-radius:12px;background-color:var(--bg);background-image:radial-gradient(var(--line) .7px,transparent .7px);background-size:18px 18px;scrollbar-width:thin}.csx-flow-canvas{position:relative;margin:0 auto}.csx-flow-lines{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}.csx-flow-column{position:absolute;top:19px;font-size:10px;color:var(--fg2);letter-spacing:.7px}.csx-flow-node{position:absolute;display:flex;flex-direction:column;gap:3px;padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg);text-align:left;font:inherit;font-size:12px;box-shadow:0 2px 8px #00000005;min-width:0}.csx-flow-node:is(button){cursor:pointer}.csx-flow-node:is(button):hover,.csx-flow-node.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accentBg)}.csx-flow-node.added{border-left:3px solid var(--accent)}.csx-flow-node.removed,.csx-flow-node.replaced{border-style:dashed;border-color:#bfaa89;background:color-mix(in srgb,#bfaa89 6%,var(--bg))}.csx-flow-node.unknown{border-style:dashed;color:var(--fg2)}.csx-flow-node.anchor{background:color-mix(in srgb,var(--fg) 2%,var(--bg));font-size:11px}.csx-flow-node.answer{background:var(--accentBg);border-color:color-mix(in srgb,var(--accent) 45%,var(--line));padding:12px}.csx-flow-node strong{font-size:12px;font-weight:600;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.csx-flow-node.answer strong{font-size:14px;line-height:21px}.csx-flow-node-meta{display:flex;align-items:center;gap:6px;font-size:9px;line-height:12px;color:var(--fg2);min-width:0}.csx-flow-badge{font-size:9px;color:var(--fg2)}.csx-flow-badge.added{color:var(--accent)}.csx-flow-badge.removed,.csx-flow-badge.replaced{color:#98713f}.csx-selected-mark{margin-left:auto;color:var(--accent)}.csx-flow-node-preview{font-size:11px;line-height:17px;color:var(--fg2);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.csx-flow-node.answer .csx-flow-node-preview{-webkit-line-clamp:3;font-size:12px;line-height:19px}.csx-flow-node-footer{display:flex;justify-content:space-between;gap:8px;margin-top:auto;font-size:9px;line-height:12px;color:var(--fg2)}.csx-flow-issue-dot{color:#a57d42}.csx-flow-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:var(--fg2);margin:9px 0}.csx-flow-legend .input{color:#638c83}.csx-flow-legend .replace{color:#b58c53}.csx-flow-legend .reference{color:#9a8ba9}.csx-flow-branch-link{display:flex;flex-wrap:wrap;align-items:center;gap:10px;border:1px dashed var(--accent);border-radius:9px;background:var(--accentBg);padding:12px;margin:14px 0;font-size:12px;color:var(--accent)}.csx-flow-branch-link small{font-size:10px;color:var(--fg2);margin-left:auto}
.csx-branch-panel{border-top:1px solid var(--line);padding-top:20px}.csx-branch-count{font-size:11px;color:var(--fg2);margin-bottom:7px}.csx-branch-panel .csx-board{max-height:240px;overflow:auto;border-style:dashed}.csx-branch-panel .csx-bitem{padding:7px 5px;font-size:11px}.csx-field-label{display:block;font-size:11px;color:var(--fg2);margin:13px 0}.csx-field-label>.csx-input{display:block;margin-top:5px;font-size:12px}.csx-branch-panel textarea{min-height:76px}.csx-branch-budget{font-size:11px;color:var(--fg2);margin:12px 0}.csx-branch-budget summary{cursor:pointer}.csx-branch-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}.csx-branch-actions .primary{flex:1}.csx-session-drawer,.csx-record-drawer{position:fixed;z-index:90;top:75px;bottom:24px;left:24px;width:min(370px,calc(100vw - 48px));padding:18px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 40px #0002;overflow:auto}.csx-record-drawer{left:auto;right:24px;width:min(460px,calc(100vw - 48px))}.csx-record-drawer .csx-op{padding:10px 0}.csx-flow-welcome{padding:60px 30px;max-width:760px;margin:auto}.csx-flow-welcome h2{font-size:26px}.csx-flow-welcome p{font-size:14px;color:var(--fg2);line-height:1.9}
@container (max-width:1100px){.csx-debug-layout{grid-template-columns:minmax(0,1fr) 270px;gap:16px}.csx-debug-side{padding-left:15px}.csx-debug-content{padding:12px 16px}.csx-app-caption{display:none}.csx-flow-heading p{display:none}}
@container (max-width:850px){.csx-debug-layout{grid-template-columns:1fr}.csx-debug-side{border-left:0;border-top:1px solid var(--line);padding:20px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:20px}.csx-branch-panel{border-top:0;padding-top:0}.csx-flow-scroll{max-height:60vh}.csx-flow-app .csx-top{flex-wrap:wrap}.csx-context-picker>.csx-muted{display:none}.csx-flow-search{margin-left:0}.csx-context-picker>select:first-child{width:140px}}
@container (max-width:580px){.csx-debug-side{grid-template-columns:1fr}.csx-context-picker{flex-wrap:wrap}.csx-context-picker>select:first-child{width:100%}.csx-time-navigation>.csx-row{flex-wrap:wrap}.csx-time-navigation select{order:-1;flex-basis:100%;width:100%}.csx-flow-heading .csx-btn{font-size:10px}.csx-flow-delta>.csx-muted{display:none}.csx-debug-content{padding:10px}.csx-top .csx-btn{font-size:10px;padding:5px 7px}}
.csx-flow-scroll{min-height:270px}.csx-guidance{margin-bottom:16px}.csx-guidance>.csx-side-intro{font-size:11px;line-height:1.6;margin-bottom:8px}.csx-guidance-item{padding:8px 10px;margin:6px 0}.csx-guidance-item span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:4px 0;font-size:10.5px;line-height:1.65}.csx-guidance-item small{font-size:9px}.csx-branch-panel{padding-top:14px}.csx-branch-panel>.csx-side-intro{font-size:11px;margin-bottom:8px}.csx-branch-panel>.csx-branch-actions{margin:8px 0 12px}.csx-guidance-more{font-size:11px;color:var(--fg2);margin-top:7px}.csx-guidance-more summary{cursor:pointer}
`;
		// ── 小组件 ──────────────────────────────────────────────
		function Btn(props) {
			return h("button", {
				type: "button", className: "csx-btn " + (props.kind || ""), title: props.title, disabled: props.disabled,
				onClick: function (e) { e.stopPropagation(); if (props.onClick) props.onClick(e); },
			}, props.children);
		}
		function Chip(props) { return h("span", { className: "csx-chip " + (props.kind || ""), title: props.title }, props.children); }

		function Dialog(props) {
			var d = props.dialog;
			var busy = useState(false);
			if (!d) return null;
			function confirm() {
				busy[1](true);
				Promise.resolve().then(function () { return d.onConfirm(); }).then(function () { busy[1](false); props.onClose(); }, function () { busy[1](false); });
			}
			return h("div", { className: "csx-mask", onClick: function () { if (!busy[0]) props.onClose(); } },
				h("div", { className: "csx csx-dialog", style: { height: "auto" }, role: "dialog", "aria-modal": true, onClick: function (e) { e.stopPropagation(); } },
					h("h3", null, d.title),
					d.body,
					h("div", { className: "csx-row", style: { justifyContent: "flex-end", gap: 8, marginTop: 4 } },
						h(Btn, { disabled: busy[0], onClick: props.onClose }, busy[0] ? "请等待结果" : "取消"),
						h(Btn, { kind: d.danger ? "danger" : "primary", disabled: busy[0], onClick: confirm }, busy[0] ? "处理中…" : d.confirmLabel || "确定"))));
		}

		function SidebarIcon(props) {
			var size = props.size || 16;
			// 一块拼图
			return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round", "aria-hidden": true },
				h("path", { d: "M3 3.5h3a1.5 1.5 0 1 1 3 0h3.5V7a1.5 1.5 0 1 0 0 3v3.5H9a1.5 1.5 0 1 0-3 0H3V10a1.5 1.5 0 1 1 0-3z" }));
		}

		/** 拼入块：去掉首尾的 context-studio 标记行，只看正文。 */
		function stripMarkers(text) {
			var lines = text.split(/\n/);
			return lines.slice(1, lines.length - 1).join("\n").trim();
		}
		function transplantFrom(text) {
			var first = text.split(/\n/)[0] || "";
			var m = /from="([^"]*)"/.exec(first);
			var at = /at=(\S+)/.exec(first);
			return (m ? "来自 " + m[1] : "来源未知") + (at ? " · " + at[1] : "");
		}

		// ── 一块素材 ────────────────────────────────────────────
		function PieceCard(props) {
			var p = props.piece;
			var open = useState(false);
			var flagged = p.flags.some(function (f) { return f.code !== "archived"; });
			return h("div", {
				className: "csx-piece" + (flagged ? " flagged" : "") + (props.inBoard ? " inboard" : ""),
				style: { "--k": KIND_COLOR[p.kind] },
				draggable: true,
				onDragStart: function (e) { e.dataTransfer.setData("text/x-csx-piece", p.id); e.dataTransfer.effectAllowed = "copy"; },
			},
				h("input", { type: "checkbox", className: "csx-check", checked: props.inBoard, title: props.inBoard ? "从拼盘拿掉" : "放进拼盘", onChange: function () { props.onToggle(p); } }),
				h("div", { className: "csx-grow" },
					h("div", { className: "csx-text" + (open[0] ? " open" : ""), onClick: function () { open[1](!open[0]); }, title: "点击展开 / 收起" }, p.kind === "session" ? p.title : p.subkind === "transplant" ? stripMarkers(p.text) : p.text),
					h("div", { className: "csx-meta" },
						h(Chip, null, KIND_LABEL[p.kind]),
						p.subkind === "transplant" ? h(Chip, { title: p.title }, "拼入 · " + transplantFrom(p.text)) : null,
						p.time ? h("span", { title: new Date(p.time).toLocaleString() }, h("span", { className: "csx-age", style: { background: ageColor(p.time) } }), " ", ago(p.time)) : null,
						h("span", null, "≈" + fmtTok(p.tokens) + " tok"),
						p.source.line ? h("span", { style: { fontFamily: "var(--mono)" } }, p.source.label + ":" + p.source.line) : null,
						p.flags.map(function (f) { return h(Chip, { key: f.code, kind: f.code === "archived" ? "" : "warn", title: f.text }, "⚠ " + (FLAG_LABEL[f.code] || f.code) + (f.code !== "archived" ? "：" + f.text : "")); }))),
				h("div", { className: "csx-acts" },
					p.kind === "session" ? h(Btn, { kind: "ghost", title: "查看消息、挑一段摘录", onClick: function () { props.onSnippets(p); } }, "摘录") : null,
					p.kind === "session" ? h(Btn, { kind: "ghost", title: "打开这个会话", onClick: function () { if (services) services.uiWorkspace.openSession(p.source.sessionId); } }, "打开") : null,
					p.kind !== "session" ? h(Btn, { kind: "ghost", title: "直接写进另一个项目的指令文件", onClick: function () { props.onTransplant(p); } }, "拼到…") : null,
					p.removable === "block" ? h(Btn, { kind: "ghost danger", title: "从文件里移除这一块（会备份，可撤销）", onClick: function () { props.onRemove(p); } }, "移除") : null,
					p.removable === "archive" ? h(Btn, { kind: "ghost danger", title: "归档这个会话（可撤销）", onClick: function () { props.onArchive(p); } }, "归档") : null));
		}

		// ── 拼盘 ────────────────────────────────────────────────
		function Board(props) {
			var items = props.items;
			var drag = useRef(null);
			var dropping = useState(false);
			var over = useState(-1);
			function onDrop(e, at) {
				e.preventDefault();
				dropping[1](false); over[1](-1);
				var pieceId = e.dataTransfer.getData("text/x-csx-piece");
				if (pieceId) { drag.current = null; if (props.onAddPiece) props.onAddPiece(pieceId, at); return; }
				var key = e.dataTransfer.getData("text/x-csx-board");
				var from = items.findIndex(function (it) { return it.key === key && key === drag.current; });
				drag.current = null;
				if (from < 0 || from >= items.length) return;
				var next = items.slice();
				var moved = next.splice(from, 1)[0];
				var to = at == null ? next.length : at > from ? at - 1 : at;
				next.splice(to, 0, moved);
				props.onChange(next);
			}
			return h("div", {
				className: "csx-board" + (dropping[0] ? " drop" : ""),
				onDragOver: function (e) { e.preventDefault(); dropping[1](true); },
				onDragLeave: function () { dropping[1](false); },
				onDrop: function (e) { onDrop(e, null); },
			},
				items.length ? items.map(function (it, i) {
					var isOver = props.overFrom >= 0 && i >= props.overFrom;
					return h("div", {
						key: it.key, className: "csx-bitem" + (isOver ? " over" : "") + (over[0] === i ? " dragover" : ""), draggable: true,
						title: isOver ? "从这一块开始超出预算" : it.text,
						onDragStart: function (e) { drag.current = it.key; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-csx-board", it.key); },
						onDragEnd: function () { drag.current = null; dropping[1](false); over[1](-1); },
						onDragOver: function (e) { e.preventDefault(); e.stopPropagation(); over[1](i); },
						onDrop: function (e) { e.stopPropagation(); onDrop(e, i); },
					},
						h("span", { className: "csx-muted", style: { width: 16 } }, i + 1),
						h("span", { className: "csx-k", style: { background: KIND_COLOR[it.kind] } }),
						h("span", { className: "csx-grow csx-ell" }, it.title || it.text),
						h("span", { className: "csx-muted" }, fmtTok(it.tokens)),
						h("button", { type: "button", className: "csx-btn ghost", style: { padding: "0 5px" }, title: "从拼盘拿掉", onClick: function () { props.onChange(items.filter(function (_, j) { return j !== i; })); } }, "×"));
				}) : h("div", { className: "csx-empty" }, "从流转图打开原文，选择要带入新分支的片段"));
		}

		// ── 脉络图 ──────────────────────────────────────────────
		// 从会话出发：左边是会话的分支图（像 git 图，一条链一组泳道），右边是记忆矩阵（每列一份记忆，● 表示这个会话加载过）。
		var ROW = 34;
		var LANE = 16;
		var LANE_COLORS = ["#4176e6", "#8b5cf6", "#14b8a6", "#f59e0b", "#ec4899", "#0ea5e9", "#84cc16"];
		var CLS_INFO = {
			shared: { label: "共享", color: "var(--blue)", text: "被不同的链路或独立会话共同用过，是公共底座" },
			chain: { label: "链内", color: "#8b5cf6", text: "只在一条链路里用过，和这条链绑在一起" },
			single: { label: "单次", color: "var(--fg3)", text: "只有一个会话用过" },
			unused: { label: "未用", color: "var(--amber)", text: "扫描到的会话里没有一个加载过它，可能已经过时" },
		};
		var EDGE_INFO = { fork: "分叉", reference: "引用", subagent: "子代理" };

		function laneX(l) { return 9 + l * LANE; }
		function rowY(r) { return r * ROW + ROW / 2; }
		function laneColor(l) { return LANE_COLORS[l % LANE_COLORS.length]; }

		/** DSH 会话引用：@[标题](dsh-session:<base64url(JSON(id))>)，和 Host 的 sessionMention 一致。 */
		function mentionOf(id, label) {
			var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(id)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			return "@[" + String(label).replace(/[\\[\]]/g, function (m) { return "\\" + m; }).replace(/[\r\n]+/g, " ") + "](dsh-session:" + b64 + ")";
		}

		/** 一条链的连线（一整块 SVG，叠在泳道列上）。 */
		function ChainSvg(props) {
			var c = props.chain;
			var rowOf = {};
			var laneOf = {};
			c.sessions.forEach(function (s, i) { rowOf[s.id] = i; laneOf[s.id] = s.lane; });
			var width = laneX(c.lanes - 1) + 10;
			var height = c.sessions.length * ROW;
			var lit = props.lit;
			return h("svg", { className: "csx-lanes", width: width, height: height, style: { width: width } },
				c.edges.map(function (e) {
					var rp = rowOf[e.from], rn = rowOf[e.to];
					var xp = laneX(laneOf[e.from]), xn = laneX(laneOf[e.to]);
					var yp = rowY(rp), yn = rowY(rn);
					var d;
					if (e.style === "straight" || xp === xn) d = "M" + xp + " " + yp + "L" + xn + " " + yn;
					else if (e.style === "branch") d = "M" + xp + " " + yp + "C" + xp + " " + (yp + ROW / 2) + " " + xn + " " + (yp + ROW / 2) + " " + xn + " " + (yp + ROW) + "L" + xn + " " + yn;
					else d = "M" + xp + " " + yp + "L" + xp + " " + (yn - ROW) + "C" + xp + " " + (yn - ROW / 2) + " " + xn + " " + (yn - ROW / 2) + " " + xn + " " + yn;
					var on = !lit || (lit.has(e.from) && lit.has(e.to));
					return h("path", {
						key: e.from + ">" + e.to, d: d, fill: "none", stroke: laneColor(laneOf[e.to]), strokeWidth: 2,
						strokeDasharray: e.kind === "reference" ? "5 4" : e.kind === "subagent" ? "2 3" : null,
						opacity: on ? 0.9 : 0.15,
					}, h("title", null, EDGE_INFO[e.kind] + (e.label ? "：" + e.label : "")));
				}),
				c.sessions.map(function (s, i) {
					var x = laneX(s.lane), y = rowY(i), col = s.archived ? "var(--fg3)" : laneColor(s.lane);
					var on = !lit || lit.has(s.id);
					var common = { key: s.id, opacity: on ? 1 : 0.25, stroke: col, strokeWidth: 2, fill: s.external ? "var(--bg)" : col };
					return s.studio
						? h("rect", Object.assign({ x: x - 5, y: y - 5, width: 10, height: 10, transform: "rotate(45 " + x + " " + y + ")" }, common))
						: h("circle", Object.assign({ cx: x, cy: y, r: s.id === props.selected ? 6.5 : 5 }, common));
				}));
		}

		function Lineage(props) {
			var g = props.graph;
			var sel = props.selection; // { type: 'session'|'memory'|'chain', id }
			var showUnused = useState(true);
			var kindFilter = useState("all");

			if (!g) return h("div", { className: "csx-empty" }, "读取脉络中…");
			if (g.error) return h("div", { className: "csx-empty" }, "读取脉络失败：" + g.error);

			var allSessions = [];
			g.chains.forEach(function (c) { c.sessions.forEach(function (s) { allSessions.push(s); }); });
			g.singles.forEach(function (s) { allSessions.push(s); });
			var sessionById = {};
			allSessions.forEach(function (s) { sessionById[s.id] = s; });

			var mems = g.memories.filter(function (m) {
				if (!showUnused[0] && m.cls === "unused") return false;
				if (kindFilter[0] !== "all" && m.kind !== kindFilter[0]) return false;
				return true;
			});
			// 会话 → 它用过的记忆（key → current）
			var usedBy = {};
			g.memories.forEach(function (m) { m.uses.forEach(function (u) { (usedBy[u.sessionId] = usedBy[u.sessionId] || {})[m.key] = u.current; }); });

			// 高亮集合：选中会话 → 它的上下游；选中记忆 → 用过它的会话；选中链 → 整条链
			var lit = null, litMem = null;
			if (sel && sel.type === "session" && sessionById[sel.id]) {
				lit = new Set([sel.id]);
				var chain = g.chains.find(function (c) { return c.id === sessionById[sel.id].chainId; });
				if (chain) {
					var walk = function (id, dir) {
						chain.edges.forEach(function (e) {
							var next = dir === "up" ? (e.to === id ? e.from : null) : (e.from === id ? e.to : null);
							if (next && !lit.has(next)) { lit.add(next); walk(next, dir); }
						});
					};
					walk(sel.id, "up"); walk(sel.id, "down");
				}
				litMem = new Set(Object.keys(usedBy[sel.id] || {}));
			} else if (sel && sel.type === "memory") {
				var m0 = g.memories.find(function (m) { return m.key === sel.id; });
				lit = new Set(m0 ? m0.uses.map(function (u) { return u.sessionId; }) : []);
				litMem = new Set([sel.id]);
			} else if (sel && sel.type === "chain") {
				var c0 = g.chains.find(function (c) { return c.id === sel.id; });
				lit = new Set(c0 ? c0.sessions.map(function (s) { return s.id; }) : []);
				litMem = new Set();
				if (c0) c0.sessions.forEach(function (s) { Object.keys(usedBy[s.id] || {}).forEach(function (k) { litMem.add(k); }); });
			}

			var lanesW = Math.max.apply(null, [1].concat(g.chains.map(function (c) { return c.lanes; }))) * LANE + 12;
			var cols = lanesW + "px minmax(200px,400px) " + (mems.length ? "repeat(" + mems.length + ",26px)" : "");

			function cellsFor(s, rowIdx, span) {
				return mems.map(function (m) {
					var cur = usedBy[s.id] ? usedBy[s.id][m.key] : undefined;
					var used = cur !== undefined;
					var inLife = span && span[m.key] && rowIdx > span[m.key][0] && rowIdx < span[m.key][1];
					var dim = litMem && !litMem.has(m.key);
					var color = CLS_INFO[m.cls].color;
					return h("div", {
						key: m.key, className: "csx-cell" + (inLife ? " life" : "") + (dim ? " dim" : ""), style: { "--c": color },
						title: used ? (m.label + (cur === false ? "：加载的是旧版本（文件后来改过或已删除）" : cur === null ? "：版本未知" : "：当前版本")) : "",
						onClick: function (e) { e.stopPropagation(); props.onSelect({ type: "memory", id: m.key }); },
					}, s.readError ? h("span", { title: "读取未完成，无法判断是否使用" }, "?") : used ? h("span", { className: "csx-dot" + (cur === false ? " old" : "") }) : null);
				});
			}
			function sessionRow(s, rowIdx, span, withLanes) {
				var on = !lit || lit.has(s.id);
				return h("div", {
					key: s.id, className: "csx-grow-row" + (sel && sel.type === "session" && sel.id === s.id ? " sel" : "") + (on ? "" : " dim"),
					style: { gridTemplateColumns: cols, height: ROW },
					onClick: function () { props.onSelect({ type: "session", id: s.id }); },
				},
					withLanes ? h("div", null) : h("div", { className: "csx-lone" }, h("i", { style: { background: s.studio ? "var(--blue)" : "var(--fg3)" } })),
					h("div", { className: "csx-srow" },
						h("span", { className: "csx-ell", style: { fontWeight: s.external ? 400 : 500, color: s.external ? "var(--fg2)" : "" } }, s.title),
						h("span", { className: "csx-muted csx-ell", style: { flex: "none" } },
							(s.external ? s.project + " · " : "") + ago(s.lastTime) + (s.readError ? " · 读取未完成" : s.turns ? " · " + s.turns + " 轮" : " · 空白"),
							s.studio ? " · ◆拼图台起始" : "", s.seeded ? " · 分叉" : "", s.origin === "subagent" ? " · 子代理" : "", s.archived ? " · 已归档" : "")),
					cellsFor(s, rowIdx, span));
			}

			var sum = g.summary;
			return h("div", { className: "csx-lineage" },
				(g.warnings || []).map(function (w) { return h("div", { className: "csx-warning", role: "status", key: w }, w); }),
				h("div", { className: "csx-sumbar" },
					h("span", null, h("b", null, sum.chains), " 条链路（", sum.chainSessions, " 个会话）"),
					h("span", null, h("b", null, sum.singles), g.partial ? " 个未确定关联的会话" : " 个未检出关联的会话"),
					h("span", { className: "csx-muted" }, "记忆："),
					["shared", "chain", "single", "unused"].map(function (k) {
						return h("span", { key: k, className: "csx-chip", title: CLS_INFO[k].text, style: { color: CLS_INFO[k].color } }, (k === "unused" && g.partial ? "使用情况待核实" : CLS_INFO[k].label) + " " + sum[k]);
					}),
					sum.outdated ? h("span", { className: "csx-chip warn", title: "用过它的会话加载的都是旧版本" }, "只被旧版本用过 " + sum.outdated) : null,
					h("span", { className: "csx-grow" }),
					h("select", { className: "csx-input", style: { width: "auto" }, value: kindFilter[0], onChange: function (e) { kindFilter[1](e.target.value); } },
						h("option", { value: "all" }, "全部记忆"), h("option", { value: "instruction" }, "只看指令"), h("option", { value: "skill" }, "只看技能")),
					h(Btn, { kind: showUnused[0] ? "on" : "", title: "显示没有被任何会话加载过的记忆", onClick: function () { showUnused[1](!showUnused[0]); } }, "未用的")),
				h("div", { className: "csx-legend csx-muted" },
					"● 当前版本  ○ 旧版本  │ 实线 分叉  ┄ 引用会话  ⋯ 子代理  ◆ 由拼图台开的会话  空心节点：别的项目。点会话看上下游，点列看谁用过。"),
				!g.capabilities.sessions ? h("div", { className: "csx-empty" }, "当前环境没有会话日志查询（sessionQuery.readSession），只能列出记忆。") : null,
				h("div", { className: "csx-matrix" },
					// 表头：记忆列（竖排）
					h("div", { className: "csx-grow-row csx-mhead", style: { gridTemplateColumns: cols } },
						h("div", null),
						h("div", { className: "csx-muted", style: { alignSelf: "end", paddingBottom: 4 } }, "会话（早 → 晚）"),
						mems.map(function (m) {
							var info = CLS_INFO[m.cls];
							var on = !litMem || litMem.has(m.key);
							return h("div", {
								key: m.key, className: "csx-mcol" + (sel && sel.type === "memory" && sel.id === m.key ? " sel" : "") + (on ? "" : " dim"),
								style: { "--c": info.color }, onClick: function () { props.onSelect({ type: "memory", id: m.key }); },
								title: m.label + "\n" + info.label + "：" + info.text + (m.uses.length ? "\n" + m.uses.length + " 个会话用过" : "") + (m.transplants.length ? "\n含 " + m.transplants.length + " 块拼入的内容" : "") + (m.exists === null ? "\n文件读取未完成，状态未知" : m.exists === false ? "\n文件已经不在了" : ""),
							}, h("span", null, (m.kind === "skill" ? "⚙ " : "") + m.label.split("/").slice(-2).join("/")));
						})),
					g.chains.map(function (c) {
						// 每列在这条链里的首末使用行，用来画竖向生命线
						var span = {};
						c.sessions.forEach(function (s, i) {
							Object.keys(usedBy[s.id] || {}).forEach(function (k) {
								var sp = span[k];
								if (!sp) span[k] = [i, i]; else sp[1] = i;
							});
						});
						var chainOn = !lit || c.sessions.some(function (s) { return lit.has(s.id); });
						return h("div", { key: c.id, className: "csx-chain" + (chainOn ? "" : " dim") },
							h("div", { className: "csx-chainhead", onClick: function () { props.onSelect({ type: "chain", id: c.id }); } },
								h("span", { className: "csx-k", style: { background: laneColor(0) } }),
								h("b", { className: "csx-ell" }, "链路 · " + c.title),
								h("span", { className: "csx-muted", style: { flex: "none" } }, c.sessions.length + " 个会话" + (c.projects.length > 1 ? " · 跨 " + c.projects.join(" / ") : "") + " · " + ago(c.lastTime))),
							h("div", { style: { position: "relative" } },
								h(ChainSvg, { chain: c, lit: lit, selected: sel && sel.type === "session" ? sel.id : null }),
								c.sessions.map(function (s, i) { return sessionRow(s, i, span, true); })));
					}),
					g.singles.length ? h("div", { className: "csx-chain" },
						h("div", { className: "csx-chainhead", style: { cursor: "default" } },
							h("span", { className: "csx-k", style: { background: "var(--fg3)" } }),
							h("b", null, g.partial ? "关联尚未确定" : "未检出关联的会话"),
							h("span", { className: "csx-muted" }, "仅描述本次扫描范围；未读到的记录仍可能包含关联")),
						g.singles.map(function (s) { return sessionRow(s, 0, null, false); })) : null,
					!allSessions.length && g.capabilities.sessions ? h("div", { className: "csx-empty" }, "这个项目还没有会话。") : null),
				h(LineageDetail, Object.assign({}, props, { sessionById: sessionById, usedBy: usedBy })));
		}

		function LineageDetail(props) {
			var g = props.graph;
			var sel = props.selection;
			if (!sel) return h("div", { className: "csx-detail csx-muted" }, "点一个会话，看它从哪来、加载了哪些记忆；点一列，看这份记忆被谁用过。");
			var memByKey = {};
			g.memories.forEach(function (m) { memByKey[m.key] = m; });

			if (sel.type === "memory") {
				var m = memByKey[sel.id];
				if (!m) return null;
				var info = CLS_INFO[m.cls];
				var chains = m.chains.map(function (id) { var c = g.chains.find(function (x) { return x.id === id; }); return c ? c.title : id; });
				return h("div", { className: "csx-detail" },
					h("div", { className: "csx-row" },
						h("span", { className: "csx-chip", style: { color: info.color } }, info.label),
						h("b", { className: "csx-grow csx-ell", title: m.path || m.label }, (m.kind === "skill" ? "技能 " : "") + m.label),
						h(Btn, { kind: "ghost", onClick: function () { props.onSelect(null); } }, "关闭")),
					h("div", { className: "csx-muted" }, info.text + "。",
						m.cls === "shared" ? "（" + (chains.length ? "链路：" + chains.join("、") + "；" : "") + m.uses.length + " 个会话）" : "",
						m.cls === "chain" ? "（" + chains.join("") + "）" : "",
						m.outdated ? " 用过它的会话加载的都是旧版本，文件后来改过" + (m.exists ? "" : "或已删除") + "。" : "",
						m.exists === null ? " 文件读取未完成，状态未知。" : m.exists === false ? " 文件已经不在了。" : ""),
					m.transplants.length ? h("div", { className: "csx-muted" }, "含 " + m.transplants.length + " 块拼入的内容：来自 " + Array.from(new Set(m.transplants)).join("、")) : null,
					m.uses.length ? h("div", { className: "csx-sec" }, "用过它的会话") : null,
					m.uses.map(function (u) {
						var s = props.sessionById[u.sessionId];
						if (!s) return null;
						return h("div", { key: u.sessionId, className: "csx-op", style: { cursor: "pointer" }, onClick: function () { props.onSelect({ type: "session", id: s.id }); } },
							h("span", { className: "csx-grow csx-ell" }, s.title), h("span", { className: "csx-muted" }, u.current === false ? "旧版本" : u.current === null ? "版本未知" : "当前版本"));
					}),
					h("div", { className: "csx-row", style: { marginTop: 8, gap: 6, flexWrap: "wrap" } },
						m.exists && m.kind === "instruction" ? h(Btn, { onClick: function () { props.onShowMemory(m); } }, "在素材墙里看内容 / 移除") : null,
						m.kind === "skill" ? h(Btn, { onClick: function () { props.onShowMemory(m); } }, "在素材墙里看") : null));
			}

			if (sel.type === "chain") {
				var c = g.chains.find(function (x) { return x.id === sel.id; });
				if (!c) return null;
				var latest = c.sessions.slice().sort(function (a, b) { return b.lastTime - a.lastTime; }).slice(0, 3);
				var used = {};
				c.sessions.forEach(function (s) { Object.keys(props.usedBy[s.id] || {}).forEach(function (k) { used[k] = true; }); });
				return h("div", { className: "csx-detail" },
					h("div", { className: "csx-row" }, h("b", { className: "csx-grow csx-ell" }, "链路 · " + c.title), h(Btn, { kind: "ghost", onClick: function () { props.onSelect(null); } }, "关闭")),
					h("div", { className: "csx-muted" }, c.sessions.length + " 个会话" + (c.projects.length ? "，涉及 " + c.projects.join("、") : "") + "；这条链一共用到 " + Object.keys(used).length + " 份记忆（矩阵里亮着的列）。"),
					h("div", { className: "csx-row", style: { marginTop: 8, gap: 6, flexWrap: "wrap" } },
						h(Btn, { kind: "primary", title: "把最近的 3 个会话作为引用放进拼盘（DSH 一条消息最多展开 3 个会话引用）", onClick: function () { props.onAddSessions(latest); } }, "把这条链接到新会话（引用最近 " + latest.length + " 个）")));
			}

			var s = props.sessionById[sel.id];
			if (!s) return null;
			var chain = g.chains.find(function (x) { return x.id === s.chainId; });
			var ups = chain ? chain.edges.filter(function (e) { return e.to === s.id; }) : [];
			var downs = chain ? chain.edges.filter(function (e) { return e.from === s.id; }) : [];
			var mine = Object.keys(props.usedBy[s.id] || {}).map(function (k) { return { m: memByKey[k], current: props.usedBy[s.id][k] }; }).filter(function (x) { return x.m; });
			var link = function (id, prefix) {
				var t = props.sessionById[id];
				return t ? h("a", { key: prefix + id, href: "#", className: "csx-link", onClick: function (e) { e.preventDefault(); props.onSelect({ type: "session", id: id }); } }, t.title) : null;
			};
			return h("div", { className: "csx-detail" },
				h("div", { className: "csx-row" },
					h("b", { className: "csx-grow csx-ell" }, s.title),
					s.readError ? h("span", { className: "csx-chip warn" }, "读取未完成") : null,
					h(Btn, { kind: "ghost", onClick: function () { props.onSelect(null); } }, "关闭")),
				h("div", { className: "csx-muted" }, (s.project ? s.project + " · " : "") + new Date(s.createdAt).toLocaleString() + " · " + (s.turns ? s.turns + " 轮对话" : "还没发过消息"),
					s.studio ? " · 由拼图台的起始上下文开启" : "", s.archived ? " · 已归档" : ""),
				chain ? h("div", { style: { marginTop: 4 } },
					ups.length ? h("div", null, "来自：", ups.map(function (e, i) { return h("span", { key: e.from }, i ? "、" : "", EDGE_INFO[e.kind] + " ", link(e.from, "u")); })) : h("div", { className: "csx-muted" }, "这条链的起点"),
					downs.length ? h("div", null, "延伸出：", downs.map(function (e, i) { return h("span", { key: e.to }, i ? "、" : "", EDGE_INFO[e.kind] + " ", link(e.to, "d")); })) : null)
					: h("div", { className: "csx-muted", style: { marginTop: 4 } }, "本次扫描未检出与其他会话的关联，不代表一定独立。"),
				h("div", { className: "csx-sec" }, "它加载过的记忆 " + mine.length),
				mine.length ? h("div", { className: "csx-row", style: { flexWrap: "wrap", gap: 4 } }, mine.map(function (x) {
					return h("span", { key: x.m.key, className: "csx-chip" + (x.current === false ? " warn" : ""), style: { cursor: "pointer" }, title: x.current === false ? "加载的是旧版本" : "", onClick: function () { props.onSelect({ type: "memory", id: x.m.key }); } }, (x.m.kind === "skill" ? "⚙ " : "") + x.m.label + (x.current === false ? "（旧）" : ""));
				})) : h("div", { className: "csx-muted" }, s.readError ? "日志未完成读取，无法判断加载了哪些指令。请在回答排查中单独读取。" : s.turns ? "日志里没有记录加载指令文件" : "还没开始对话，DSH 会在第一次请求时加载"),
				h("div", { className: "csx-row", style: { marginTop: 10, gap: 6, flexWrap: "wrap" } },
					h(Btn, { kind: "primary", title: "把这个会话作为引用放进拼盘，再用拼盘开新会话", onClick: function () { props.onAddSessions([s]); } }, "接着它开新会话"),
					h(Btn, { title: "挑几段消息摘进拼盘", onClick: function () { props.onSnippets(s); } }, "摘录"),
					h(Btn, { onClick: function () { if (services) services.uiWorkspace.openSession(s.id); } }, "打开"),
					services && services.uiWorkspace && typeof services.uiWorkspace.forkSession === "function" && s.turns ? h(Btn, { title: "在 DSH 里从这里分叉一个新会话（复制到目前为止的历史）", onClick: function () { props.onFork(s); } }, "分叉") : null,
					!s.archived ? h(Btn, { kind: "danger", title: "归档（可撤销）", onClick: function () { props.onArchive(s); } }, "归档") : null));
		}

		// 模块、列表和原文是三种读取层级；这里只按当前页获取原文。
		var INSPECT_MODULES = [
			["requirements", "用户要求", "用户提出的目标、补充与纠正"],
			["memory", "项目约定", "项目指令、记忆与工作约定"],
			["references", "引用会话", "从其他会话带入的信息"],
			["tools", "工具结果", "执行、搜索与文件读取的结果"],
			["history", "历史回答", "模型在这次回答前说过的话"],
			["skills", "技能", "本次流程使用的技能说明"],
			["system", "系统与环境", "运行规则、环境与系统背景"],
			["other", "其他上下文", "其余已记录的来源"]
		];
		var INSPECT_STATES = { active: "在输入中", replaced: "已被替换", unknown: "位置未知" };
		function inspectPath(route, params) {
			return route + "?" + Object.keys(params).filter(function (k) { return params[k] != null; })
				.map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
		}
		function evidenceItem(session, row, text) {
			var part = row.sourcePart === "arguments" ? "arguments" : "body";
			var local = Number.isInteger(row.selectionStart) ? row.selectionStart : Math.max(0, String(row.text || "").indexOf(text));
			var offset = (Number.isInteger(row.textOffset) ? row.textOffset : 0) + local, end = offset + text.length;
			var source = (part === "arguments" ? "调用参数" : "正文") + " · 字符 " + (offset + 1) + "–" + end;
			return {
				key: "evidence:" + JSON.stringify([session.id, row.seq, part, offset, end]),
				kind: "snippet", text: text, title: session.title + " · " + row.label + " · " + source,
				from: "会话 " + session.id + " / 事件 #" + row.seq + " / " + source +
					(row.status === "replaced" ? "（历史内容，已被替换）" : row.status === "unknown" ? "（位置未知）" : ""),
				role: row.kind === "user" || row.kind === "assistant" ? row.kind : undefined,
				time: row.time, tokens: estimate(text), origin: session.workspaceId,
				evidenceSession: session.id, evidenceSeq: row.seq, sourcePart: part, textOffset: offset,
				evidencePart: part, evidenceOffset: offset, evidenceEnd: end
			};
		}
		var FLOW_SCOPES = { changes: "这步变化", active: "全部输入", replaced: "已替换", issues: "待核对", unknown: "位置未知" };
		var CHANGE_LABEL = { added: "新进", retained: "沿用", removed: "本步替换", replaced: "已替换", unknown: "位置未知" };
		function flowLayout(flow) {
			var nodes = flow.nodes || [], anchors = (flow.anchors || []).filter(function (a) { return !nodes.some(function (n) { return n.id === a.id; }); });
			var requests = (flow.edges || []).filter(function (e) { return e.kind === "request"; });
			var requestSources = new Set(requests.map(function (e) { return e.from; }));
			var requestTargets = new Set(requests.map(function (e) { return e.to; }));
			var expanded = requests.length > 0;
			var calls = expanded ? anchors.filter(function (a) { return a.kind === "call" || requestTargets.has(a.id); }) : [];
			var left = anchors.filter(function (a) { return a.kind !== "answer" && !calls.includes(a); }).concat(expanded ? nodes.filter(function (n) { return requestSources.has(n.id); }) : []);
			var middle = expanded ? nodes.filter(function (n) { return !requestSources.has(n.id); }) : nodes;
			var right = anchors.filter(function (a) { return a.kind === "answer"; });
			var height = Math.max(270, middle.length * 112 + 62, left.length * 112 + 50, calls.length * 96 + 62);
			var positions = {};
			left.forEach(function (n, i) { var isAnchor = anchors.includes(n); positions[n.id] = { x: 16, y: 60 + i * 112, w: 186, h: isAnchor ? 72 : 96, node: n, anchor: isAnchor }; });
			calls.forEach(function (n, i) { positions[n.id] = { x: 246, y: 72 + i * 96, w: 152, h: 78, node: n, anchor: true }; });
			middle.forEach(function (n, i) { positions[n.id] = { x: expanded ? 444 : 274, y: 60 + i * 112, w: expanded ? 214 : 244, h: 96, node: n, anchor: false }; });
			right.forEach(function (n, i) { positions[n.id] = { x: expanded ? 722 : 604, y: 78 + i * 154, w: 204, h: 130, node: n, anchor: true }; });
			var pairs = {}, pairAt = {};
			(flow.edges || []).forEach(function (e) { var key = JSON.stringify([e.from, e.to]); pairs[key] = (pairs[key] || 0) + 1; });
			var edges = (flow.edges || []).filter(function (e) { return positions[e.from] && positions[e.to]; }).map(function (edge) {
				var a = positions[edge.from], b = positions[edge.to], path, pair = JSON.stringify([edge.from, edge.to]);
				var offset = ((pairAt[pair] || 0) - (pairs[pair] - 1) / 2) * 8; pairAt[pair] = (pairAt[pair] || 0) + 1;
				var ay = a.y + a.h / 2 + offset, by = b.y + b.h / 2 + offset;
				if (a.x === b.x) {
					var rightX = a.x + a.w, bend = rightX + 28;
					path = "M" + rightX + " " + ay + " C" + bend + " " + ay + "," + bend + " " + by + "," + rightX + " " + by;
				} else {
					var forward = b.x > a.x, ax = forward ? a.x + a.w : a.x, bx = forward ? b.x : b.x + b.w;
					var mid = (ax + bx) / 2;
					path = edge.kind === "input" && bx - ax > 400 ? "M" + ax + " " + ay + "H" + (ax + 12) + "V42H" + (bx - 12) + "V" + by + "H" + bx :
						"M" + ax + " " + ay + " C" + mid + " " + ay + "," + mid + " " + by + "," + bx + " " + by;
				}
				return Object.assign({}, edge, { path: path });
			});
			return { width: expanded ? 946 : 840, height: height, positions: positions, edges: edges, expanded: expanded };
		}
		function FlowGraph(props) {
			var flow = props.flow, hover = useState(null), layout = flowLayout(flow);
			var selectedId = hover[0] || (props.selectedSeq != null ? "event:" + props.selectedSeq : null);
			var marker = "csx-arrow-" + String(props.sessionId || "flow").replace(/[^a-zA-Z0-9_-]/g, "_");
			var kinds = ["input", "source", "call", "replace", "reference", "request"];
			var colors = { input: "#638c83", source: "#8893a4", call: "#5c8299", replace: "#b58c53", reference: "#9a8ba9", request: "#647eaf" };
			return h("div", { className: "csx-flow-scroll", role: "region", "aria-label": "上下文流转图", tabIndex: 0 },
				h("div", { className: "csx-flow-canvas", style: { width: layout.width, height: layout.height } },
					h("div", { className: "csx-flow-column", style: { left: 16, width: 186 } }, "来源与比较起点"),
					layout.expanded ? h("div", { className: "csx-flow-column", style: { left: 246, width: 152 } }, "请求调用") : null,
					h("div", { className: "csx-flow-column", style: { left: layout.expanded ? 444 : 274, width: 214 } }, "本页上下文"),
					h("div", { className: "csx-flow-column", style: { left: layout.expanded ? 722 : 604, width: 204 } }, "当前回答"),
					h("svg", { className: "csx-flow-lines", width: layout.width, height: layout.height, "aria-label": "日志关系连线" },
						h("defs", null, kinds.map(function (kind) { return h("marker", { id: marker + "-" + kind, key: kind, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }, h("path", { d: "M0 0L8 4L0 8", fill: colors[kind] })); })),
						layout.edges.map(function (e) {
							var lit = !selectedId || e.from === selectedId || e.to === selectedId;
							return h("path", { key: e.id, d: e.path, fill: "none", stroke: colors[e.kind] || colors.source, strokeWidth: lit && selectedId ? 2.4 : 1.5,
								strokeDasharray: e.kind === "replace" ? "6 4" : e.kind === "reference" ? "3 4" : undefined,
								opacity: lit ? 0.85 : 0.14, markerEnd: "url(#" + marker + "-" + e.kind + ")", "data-edge-id": e.id, "data-edge-kind": e.kind },
								h("title", null, e.label + " · " + e.from + " → " + e.to));
						})),
					Object.keys(layout.positions).map(function (id) {
						var box = layout.positions[id], n = box.node, isAnswer = n.kind === "answer", selected = props.selectedSeq === n.seq && n.seq != null;
						var module = INSPECT_MODULES.find(function (m) { return m[0] === n.module; });
						var badge = box.anchor ? isAnswer ? "本次输出" : n.kind === "baseline" ? "上次回答" : n.kind === "reference" ? "引用快照" : n.kind === "call" ? "工具调用" : "来源记录" : (flow.baseline && n.seq === flow.baseline.seq ? "上次输出 · " : "") + CHANGE_LABEL[n.change];
						var count = (props.evidence || []).filter(function (b) { return b.evidenceSession === props.sessionId && b.evidenceSeq === n.seq; }).length;
						return h(n.canInspect ? "button" : "div", { type: n.canInspect ? "button" : undefined, key: id,
							className: "csx-flow-node " + (box.anchor ? "anchor " : "") + (isAnswer ? "answer " : "") + (n.change || "") + (selected ? " selected" : ""),
							style: { left: box.x, top: box.y, width: box.w, height: box.h }, "data-node-id": id,
							"aria-label": n.canInspect ? "查看原文 #" + n.seq + " · " + n.label : n.label,
							"aria-pressed": n.canInspect ? selected : undefined,
							onMouseEnter: function () { hover[1](id); }, onMouseLeave: function () { hover[1](null); },
							onFocus: function () { hover[1](id); }, onBlur: function () { hover[1](null); },
							onClick: n.canInspect ? function (e) { props.onSelect(n.seq, e); } : undefined },
							h("span", { className: "csx-flow-node-meta" }, h("span", { className: "csx-flow-badge " + (n.change || "") }, badge),
								h("span", null, n.seq != null ? "#" + n.seq : isAnswer ? "尚无输出" : n.kind === "reference" ? "外部会话" : "来源锚点"), count ? h("span", { className: "csx-selected-mark" }, "已选 " + count) : null),
							h("strong", null, n.label),
							h("span", { className: "csx-flow-node-preview" }, n.preview || (isAnswer ? "尚无回答，先核对已记录的输入。" : "打开查看原文与来源")),
							!box.anchor ? h("span", { className: "csx-flow-node-footer" }, module ? module[1] : n.source || "记录",
								n.issueCount ? h("span", { className: "csx-flow-issue-dot" }, n.issueCount + " 条线索") : h("span", null, "查看原文 ↗")) : null);
					})));
		}

		function Inspector(props) {
			var session = props.session, sessionId = session && session.id;
			var options = useState(null), snapshot = useState(null), viewRetry = useState(0);
			var selected = useState(null), detail = useState(null), detailRetry = useState(0), excerpt = useState(null);
			var searchInput = useState(null), chartFocus = useRef(null);
			var refreshSeen = useRef({ external: props.refresh, local: 0 });
			var viewLive = useRef(null), detailLive = useRef(null), detailPanel = useRef(null), detailOpener = useRef(null);
			var opts = options[0] && options[0].id === sessionId ? options[0] :
				{ id: sessionId, answer: null, module: null, scope: "changes", focus: null, page: 0, q: "" };
			var viewKey = JSON.stringify([sessionId, opts.answer, opts.module, opts.scope, opts.focus, opts.page, opts.q, props.refresh, viewRetry[0]]);
			viewLive.current = viewKey;
			var current = snapshot[0] && snapshot[0].key === viewKey ? snapshot[0] : null;
			var d = current && !current.error && current.data;
			// 目录页切换期间保留同一回答的模块和导航，不把旧记录当成新结果展示。
			var prior = snapshot[0] && snapshot[0].sessionId === sessionId ? snapshot[0].data || snapshot[0].previous : null;
			var meta = d || (prior && (opts.answer == null || prior.boundary === opts.answer || (prior.answer && prior.answer.seq === opts.answer)) ? prior : null);
			var nav = d || prior, timeline = nav && nav.timeline || [], info = nav && nav.timelineInfo || {};
			var pick = selected[0] && selected[0].viewKey === viewKey ? selected[0] : null;
			var detailKey = pick ? JSON.stringify([viewKey, pick.answer, pick.seq, pick.part, pick.offset, detailRetry[0]]) : null;
			detailLive.current = detailKey;
			var detailResult = detail[0] && detail[0].key === detailKey ? detail[0] : null;
			var full = detailResult && detailResult.data;
			var chosen = excerpt[0] && excerpt[0].key === detailKey ? excerpt[0] : null;
			var pending = !current;

			useEffect(function () {
				if (!sessionId) return;
				var alive = true, controller = new AbortController();
				var refresh = refreshSeen.current.external !== props.refresh || refreshSeen.current.local !== viewRetry[0];
				refreshSeen.current = { external: props.refresh, local: viewRetry[0] };
				getJSON(inspectPath("/inspect-flow", { id: sessionId, answer: opts.answer, module: opts.module,
					scope: opts.scope, focus: opts.focus, page: opts.page, q: opts.q, refresh: refresh ? 1 : null }), controller.signal)
					.then(function (value) { if (alive && viewLive.current === viewKey && !controller.signal.aborted) snapshot[1]({ key: viewKey, sessionId: sessionId, data: value }); })
					.catch(function (e) { if (alive && viewLive.current === viewKey && !controller.signal.aborted) snapshot[1]({ key: viewKey, sessionId: sessionId, error: e.message, previous: prior }); });
				return function () { alive = false; controller.abort(); };
			}, [viewKey]);
			useEffect(function () {
				if (!pick || !detailKey) return;
				var alive = true, controller = new AbortController();
				getJSON(inspectPath("/inspect-detail", { id: sessionId, answer: pick.answer, event: pick.seq, offset: pick.offset, part: pick.part }), controller.signal)
					.then(function (value) { if (alive && detailLive.current === detailKey && !controller.signal.aborted) detail[1]({ key: detailKey, data: value }); })
					.catch(function (e) { if (alive && detailLive.current === detailKey && !controller.signal.aborted) detail[1]({ key: detailKey, error: e.message }); });
				return function () { alive = false; controller.abort(); };
			}, [detailKey]);
			useEffect(function () { if (pick && detailPanel.current) detailPanel.current.focus(); }, [pick && pick.seq, pick && pick.viewKey]);

			function change(patch) {
				// 锁定已选回答；翻页时不会悄悄漂移到刚生成的新回答。
				options[1](Object.assign({}, opts, { answer: meta ? (meta.answer ? meta.answer.seq : null) : opts.answer,
					module: opts.module, focus: null, page: 0 }, patch));
				selected[1](null); excerpt[1](null);
			}
			function chooseAnswer(seq) {
				if (seq == null) return;
				change({ answer: seq, page: 0, q: "", module: null, scope: "changes" }); searchInput[1]({ id: sessionId, value: "" });
			}
			function openDetail(seq, event) {
				if (!meta) return;
				var boundary = meta.answer ? meta.answer.seq : null;
				if (event && event.currentTarget) detailOpener.current = event.currentTarget;
				selected[1]({ viewKey: viewKey, answer: boundary, seq: seq, offset: 0, part: "body" }); excerpt[1](null);
			}
			function closeDetail() { selected[1](null); excerpt[1](null); if (detailOpener.current && detailOpener.current.isConnected) detailOpener.current.focus(); }
			function moveDetail(patch) {
				selected[1](Object.assign({}, pick, patch)); excerpt[1](null);
			}
			function addCurrent(selectionOnly) {
				if (!full || !full.row || typeof full.text !== "string" || !full.text || !props.onAdd) return;
				var start = selectionOnly && chosen ? chosen.start : 0, end = selectionOnly && chosen ? chosen.end : full.text.length;
				if (selectionOnly && (!chosen || end <= start)) return;
				props.onAdd(session, Object.assign({}, full.row, { text: full.text,
					textOffset: full.offset, sourcePart: full.part, selectionStart: start, selectionEnd: end }), full.text.slice(start, end));
			}
			function retry() { viewRetry[1](function (n) { return n + 1; }); if (props.onRetry) props.onRetry(); }
			function locateGuidance(g) {
				searchInput[1]({ id: sessionId, value: "" });
				if (meta && meta.answer && g.eventSeq === meta.answer.seq) { openDetail(g.eventSeq); return; }
				change({ scope: g.scope || "changes", module: g.module || null, focus: g.eventSeq == null ? null : g.eventSeq, q: "" });
				if (chartFocus.current) { chartFocus.current.focus({ preventScroll: true }); chartFocus.current.scrollIntoView({ block: "nearest" }); }
			}
			if (!session) return h("div", { className: "csx-flow-welcome" },
				h("span", { className: "csx-eyebrow" }, "上下文调试"),
				h("h2", null, "从出错的回答，沿着输入找回原因。"),
				h("p", null, "选择会话后，这里会画出每一步新进、沿用和被替换的上下文。点线索定位记录，核对原文，再挑选可靠片段整理新分支。"));
			var f = meta && meta.flow, c = f && f.comparison || {}, page = d && d.flow && d.flow.page;
			var unavailable = (meta && meta.summary && meta.summary.available === false) || c.available === false;
			var searchValue = searchInput[0] && searchInput[0].id === sessionId ? searchInput[0].value : opts.q;
			var row = full && full.row, total = full ? full.totalChars : 0, windowed = info.total > timeline.length;
			var selectedEvidence = (props.evidence || []).filter(function (b) { return b.evidenceSession === sessionId; });
			var scopeCounts = { changes: c.available === false ? "—" : (c.added || 0) + (c.removed || 0), active: meta && meta.summary && meta.summary.active,
				replaced: meta && meta.summary && meta.summary.replaced, issues: c.issues, unknown: c.unknown };
			return h("section", { className: "csx-inspect csx-debugger" },
				h("header", { className: "csx-debug-header" },
						h("span", { className: "csx-muted" }, "回答时间轨道", info.total != null ? " · " + info.total + " 次输出" : ""),
					h(Btn, { disabled: !(services && services.uiWorkspace), onClick: function () { if (services && services.uiWorkspace) services.uiWorkspace.openSession(session.id); } }, "回到会话 ↗")),
				timeline.length ? h("div", { className: "csx-time-navigation", "aria-label": "回答导航" },
					h("div", { className: "csx-row" },
						h(Btn, { kind: "ghost", disabled: info.firstSeq == null || (meta && meta.answer && meta.answer.seq === info.firstSeq), onClick: function () { chooseAnswer(info.firstSeq); } }, "最早"),
						h(Btn, { disabled: pending || info.previousSeq == null, onClick: function () { chooseAnswer(info.previousSeq); } }, "← 上一步"),
						h("select", { className: "csx-input csx-grow", "aria-label": "检查哪次回答", value: opts.answer ?? (nav.answer && nav.answer.seq) ?? "",
							onChange: function (e) { chooseAnswer(Number(e.target.value)); } },
							timeline.map(function (a, i) { return h("option", { key: a.seq, value: a.seq }, (a.index ?? (info.start || 0) + i + 1) + " · #" + a.seq + " · " + String(a.preview || "").slice(0, 65)); })),
						h(Btn, { disabled: pending || info.nextSeq == null, onClick: function () { chooseAnswer(info.nextSeq); } }, "下一步 →"),
						h(Btn, { kind: "ghost", disabled: info.lastSeq == null || (meta && meta.answer && meta.answer.seq === info.lastSeq), onClick: function () { chooseAnswer(info.lastSeq); } }, "最新")),
					h("div", { className: "csx-time-track", role: "group", "aria-label": "回答时间轨道" },
						timeline.map(function (a, i) { var active = a.seq === (opts.answer ?? (nav.answer && nav.answer.seq)); return h("button", { type: "button", key: a.seq, className: "csx-time-node" + (active ? " on" : ""), "aria-pressed": active,
							onClick: function () { chooseAnswer(a.seq); }, title: a.preview }, h("span", null, (a.index ?? i + 1) + " · 回答 #" + a.seq),
							h("small", null, a.interrupted ? "输出曾中断" : String(a.preview || "工具调用或无文本").slice(0, 38))); })),
					windowed ? h("div", { className: "csx-row csx-time-window" },
						h(Btn, { kind: "ghost", disabled: info.earlierWindowSeq == null, onClick: function () { chooseAnswer(info.earlierWindowSeq); } }, "更早一组"),
						h("span", { className: "csx-muted csx-grow" }, "轨道显示 " + timeline.length + " / " + info.total + " 次输出"),
						h(Btn, { kind: "ghost", disabled: info.laterWindowSeq == null, onClick: function () { chooseAnswer(info.laterWindowSeq); } }, "更晚一组")) : null) : meta ? h("p", { className: "csx-hint" }, "还没有模型回答，先核对已记录的上下文。") : null,
				h("div", { className: "csx-debug-layout" },
					h("main", { className: "csx-debug-main", ref: chartFocus, tabIndex: -1 },
						h("div", { className: "csx-flow-heading" }, h("div", null, h("h3", null, "这一步，输入发生了什么？"),
							h("p", null, f && f.baseline ? "比较回答 #" + f.baseline.seq + " 之前与当前回答之前的输入；上次输出也可能成为新增输入。" : "这是首次回答前的输入起点。按连线核对每条记录的来路。")),
							meta && meta.answer ? h(Btn, { disabled: pending, onClick: function (e) { openDetail(meta.answer.seq, e); } }, "核对当前回答") : null),
						f ? h("div", { className: "csx-flow-delta", "aria-label": "本步输入变化" },
							h("span", { className: "new" }, "新进 ", h("b", null, c.added ?? "—")),
							h("button", { type: "button", className: "csx-retained", onClick: function () { change({ scope: "active", module: null }); } }, "▸ 沿用 " + (c.retained ?? "—") + " 条 · 展开输入"),
							h("span", { className: "removed" }, "被替换 ", h("b", null, c.removed ?? "—")),
							h("span", { className: "csx-muted" }, "只说明日志位置，不判断内容正确性")) : null,
						h("div", { className: "csx-flow-toolbar", role: "group", "aria-label": "流转范围" },
							Object.keys(FLOW_SCOPES).map(function (scope) { return h("button", { type: "button", key: scope, className: "csx-btn" + (opts.scope === scope ? " on" : ""), "aria-pressed": opts.scope === scope,
								onClick: function () { change({ scope: scope, module: null }); } }, FLOW_SCOPES[scope], h("small", null, unavailable ? "—" : scopeCounts[scope] ?? "")); }),
							h("form", { className: "csx-flow-search", onSubmit: function (e) { e.preventDefault(); change({ q: searchValue.trim() }); } },
								h("input", { className: "csx-input", maxLength: 200, "aria-label": "搜索标题或预览", placeholder: "搜索标题或预览", value: searchValue, onChange: function (e) { searchInput[1]({ id: sessionId, value: e.target.value }); } }),
								h("button", { type: "submit", className: "csx-btn ghost" }, "查找"))),
						opts.module || opts.q ? h("div", { className: "csx-active-filter" }, opts.module ? "聚焦来源：" + ((INSPECT_MODULES.find(function (m) { return m[0] === opts.module; }) || [null, opts.module])[1]) : "",
							opts.q ? " · 标题/预览：" + opts.q : "", h(Btn, { kind: "ghost", onClick: function () { change({ module: null, q: "" }); searchInput[1]({ id: sessionId, value: "" }); } }, "清除筛选")) : null,
						pending ? h("div", { className: "csx-flow-loading", role: "status" }, "正在读取这一步的上下文路径…") : null,
						current && current.error ? h("div", { role: "alert", className: "csx-warning" }, h("p", null, current.error), h(Btn, { onClick: retry }, "重新读取此会话")) : null,
						unavailable ? h("div", { className: "csx-warning", role: "status" }, h("strong", null, "本步上下文暂不可比较，数量未知"),
							h("p", null, "请选择更早的回答继续核对，或先打开当前回答原文；这不表示输入为空。")) : null,
						d && d.flow ? h(React.Fragment, null,
							h("div", { className: "csx-flow-page-meta", role: "status" }, FLOW_SCOPES[d.flow.scope] + " · 本页 " + d.flow.nodes.length + " / " + d.flow.page.total + " 条上下文 · " + d.flow.anchors.length + " 个关系锚点",
								d.flow.focusFound === false ? " · 目标不在当前范围，请清除筛选或核对原文" : ""),
							h(FlowGraph, { flow: d.flow, sessionId: sessionId, selectedSeq: pick ? pick.seq : opts.focus, onSelect: openDetail, evidence: props.evidence }),
							!d.flow.nodes.length && !unavailable ? h("p", { className: "csx-hint" }, "当前范围没有记录。可展开沿用输入，或清除搜索条件。") : null,
							h("div", { className: "csx-flow-legend" }, h("span", { className: "input" }, "── 输入 / 来源"), h("span", { className: "replace" }, "┄ 替换"), h("span", { className: "reference" }, "┈ 引用快照"),
								h("span", null, "箭头仅表示日志关系，不表示模型内部因果")),
							d.flow.omittedRelations ? h("p", { className: "csx-read-status" }, "本页另有 " + d.flow.omittedRelations + " 条关联未画出；当前画布不是完整关系图。") : null,
							page && page.pages > 0 ? h("div", { className: "csx-pagination", "aria-label": "记录分页" },
								h(Btn, { disabled: page.index <= 0, onClick: function () { change({ page: page.index - 1 }); } }, "上一页记录"),
								h("span", { role: "status" }, "第 " + (page.index + 1) + " / " + page.pages + " 页 · " + page.total + " 条"),
								h(Btn, { disabled: page.index + 1 >= page.pages, onClick: function () { change({ page: page.index + 1 }); } }, "下一页记录")) : null,
							selectedEvidence.length ? h("div", { className: "csx-flow-branch-link", "data-user-action": "draft-selection" },
								h("span", null, "已选原文片段"), h("span", { "aria-hidden": true }, "┄┄→"), h("strong", null, "新分支草稿 · " + selectedEvidence.length + " 段"),
								h("small", null, "这是你的选择，不是历史分叉")) : null) : null,
						meta && meta.warnings && meta.warnings.length ? h("details", { className: "csx-inspect-warnings" }, h("summary", null, "日志提示与限制 · " + meta.warnings.length),
							meta.warnings.map(function (w, i) { return h("div", { className: "csx-warning", key: i }, h("strong", null, w.title), h("p", null, w.detail),
								w.seq != null ? h(Btn, { disabled: pending, onClick: function (e) { openDetail(w.seq, e); } }, "核对相关原文 #" + w.seq) : null); })) : null,
						h("p", { className: "csx-hint" }, meta && meta.limitation, " 搜索只匹配标题和预览。")),
					h("aside", { className: "csx-debug-side", "aria-label": "排查与新分支" },
						h("section", { className: "csx-guidance" }, h("div", { className: "csx-eyebrow" }, "01 / 排查"), h("h3", null, "从哪里开始核对"),
							h("p", { className: "csx-side-intro" }, "点线索定位图中记录，再读原文。是否构成错误，需要你核对。"),
							f && f.guidance && f.guidance.length ? f.guidance.map(function (g) { return h("button", { type: "button", key: g.id, className: "csx-guidance-item " + g.severity,
								onClick: function () { locateGuidance(g); }, "aria-label": "定位线索：" + g.title },
								h("strong", null, g.title), h("span", null, g.detail), h("small", null, g.eventSeq != null ? "定位 #" + g.eventSeq + " →" : "查看相关输入 →")); }) :
								h("p", { className: "csx-hint" }, pending ? "线索随这一步的日志一起加载。" : "没有自动线索不代表回答正确。先核对要求与实际输入。")),
						props.branch || h("section", { className: "csx-branch-panel" }, h("h3", null, "新分支草稿"), h("p", null, "从图中打开原文，挑选片段后继续。")))),
				pick ? h("section", { className: "csx-detail-panel", ref: detailPanel, tabIndex: -1, role: "dialog", "aria-modal": false,
					"aria-label": "原文详情", "aria-busy": !detailResult, onKeyDown: function (e) { if (e.key === "Escape") { e.stopPropagation(); closeDetail(); } } },
					h("div", { className: "csx-row" }, h("div", { className: "csx-grow" },
						h("div", { className: "csx-eyebrow" }, "核对原文 · 选择给新分支的片段"),
						h("h3", null, row ? row.label : "原文 #" + pick.seq)),
						h(Btn, { onClick: closeDetail }, "关闭原文")),
					!detailResult ? h("p", { role: "status", className: "csx-empty" }, "正在读取这一页原文…") :
					detailResult.error ? h("div", { role: "alert", className: "csx-warning" }, h("p", null, detailResult.error),
						h(Btn, { onClick: function () { detailRetry[1](function (n) { return n + 1; }); } }, "重试原文")) :
					full && row ? h(React.Fragment, null,
						h("div", { className: "csx-evidence-meta" }, "事件 #" + row.seq + " · " + (row.status === "source" ? "来源记录" : row.status === "replaced" ? "已被替换" : row.status === "unknown" ? "位置未知" : row.seq === pick.answer ? "本次回答" : "回答前的记录") +
							(row.time ? " · " + new Date(row.time).toLocaleString() : "")),
						(row.changes || []).map(function (c, i) { return h("p", { key: i, className: "csx-evidence-meta" }, c.action + " · " + c.path); }),
						(row.refs || []).map(function (ref, i) { return h("p", { key: i, className: "csx-evidence-meta" },
							"引用 · " + (ref.label || ref.sessionId) + (ref.capturedThroughSeq != null ? " · 截至 #" + ref.capturedThroughSeq : "") +
							(ref.truncated || ref.omittedMessages ? " · 有截断 / 省略" : "")); }),
						h("div", { className: "csx-row", style: { flexWrap: "wrap" } },
							row.replacedBy != null ? h(Btn, { onClick: function () { openDetail(row.replacedBy); } }, "查看替代记录 #" + row.replacedBy) : null,
							(row.sourceEventSeqs || []).map(function (seq) { return h(Btn, { key: seq, onClick: function () { openDetail(seq); } }, "来源记录 #" + seq); })),
						full.hasArguments ? h("div", { className: "csx-state-tabs", role: "group", "aria-label": "原文类型" },
							h(Btn, { kind: pick.part === "body" ? "on" : "", onClick: function () { moveDetail({ part: "body", offset: 0 }); } }, "结果正文"),
							h(Btn, { kind: pick.part === "arguments" ? "on" : "", onClick: function () { moveDetail({ part: "arguments", offset: 0 }); } }, "调用参数")) : null,
						full.incomplete ? h("p", { className: "csx-read-status", role: "status" }, "这条原文包含缺失或暂不支持的内容，请结合提示核对。") : null,
						(full.notices || []).map(function (notice, i) { return h("p", { key: i, className: "csx-hint" }, notice); }),
						h("div", { className: "csx-pagination", "aria-label": "原文分页" },
							h(Btn, { disabled: full.previousOffset == null, onClick: function () { moveDetail({ offset: full.previousOffset }); } }, "上一页原文"),
							h("span", { role: "status" }, (full.part === "arguments" ? "参数" : "正文") + " · 字符 " + (full.text.length ? full.offset + 1 : 0) + "–" + (full.offset + full.text.length) + " / " + total),
							h(Btn, { disabled: full.nextOffset == null, onClick: function () { moveDetail({ offset: full.nextOffset }); } }, "下一页原文")),
						h("textarea", { key: detailKey, className: "csx-source-text", "aria-label": "历史上下文原文，可选择文字", readOnly: true, value: full.text,
							placeholder: "这一部分没有可展示的文本",
							onSelect: function (e) {
								var start = Math.max(0, Math.min(full.text.length, e.target.selectionStart)), end = Math.max(start, Math.min(full.text.length, e.target.selectionEnd));
								excerpt[1]({ key: detailKey, start: start, end: end });
							} }),
						h("div", { className: "csx-row", style: { flexWrap: "wrap" } },
							h(Btn, { kind: "primary", disabled: !full.text, onClick: function () { addCurrent(false); } }, "将本页加入分支草稿"),
							h(Btn, { disabled: !chosen || chosen.end <= chosen.start, onClick: function () { addCurrent(true); } }, "只加入选中文字"),
							h("span", { className: "csx-muted" }, chosen && chosen.end > chosen.start ? "已选 " + (chosen.end - chosen.start) + " 字符" : "可在原文中拖选文字")),
						h("p", { className: "csx-hint" }, "本页约 " + fmtTok(row.tokens || estimate(full.text)) + " tokens（估算）。仅加入当前页或所选文字，不代表整条记录；来源、正文/参数及字符位置会保留。"),
						h("p", { className: "csx-hint" }, "可跨回答、跨会话继续挑选。新分支只带所选片段，目标项目指令仍由 DSH 加载；确认后填入草稿，不会自动发送。")) : null) : null);
		}

		// ── 整页 ────────────────────────────────────────────────
		function StudioPage() {
			var prefs0 = useState(function () { var p = load(LS_PREFS, {}); return p && typeof p === "object" ? p : {}; })[0];
			var hostSession = useState(function () { return Object.assign({}, observedSession); }), manualSession = useRef(false);
			var projects = useState([]), current = useState(observedSession.id ? "global" : prefs0.project || "global"), catalog = useState(null);
			var inspected = useState(null), inspectRefresh = useState(0), journal = useState([]), journalError = useState("");
			var journalOpen = useState(false), navOpen = useState(false), sessionSearch = useState("");
			var initialBoard = useState(function () { var raw; try { raw = localStorage.getItem(LS_BOARD); return raw ? JSON.parse(raw) : []; } catch (e) { return { unreadable: raw, reason: e.message }; } })[0];
			var board = useState(function () { return Array.isArray(initialBoard) ? initialBoard.filter(function (b) { return b && typeof b.key === "string" && typeof b.text === "string" && KIND_LABEL[b.kind]; }) : []; });
			var boardRecovery = useState(!Array.isArray(initialBoard) || board[0].length !== initialBoard.length);
			var storageError = useState(""), prefsError = useState(""), target = useState(prefs0.target || ""), budget = useState(prefs0.budget || 8000), task = useState(prefs0.task || "");
			var preview = useState(null), showPreview = useState(false), dialog = useState(null), toast = useState(null);
			var controllers = useRef({}), activeProject = useRef(current[0]), toastTimer = useRef(0);
			activeProject.current = current[0];
			function notify(text, err) { toast[1]({ text: text, err: !!err }); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(function () { toast[1](null); }, err ? 6000 : 3500); }
			function readFor(slot, path, setter) {
				if (controllers.current[slot]) controllers.current[slot].abort();
				var ctl = new AbortController(); controllers.current[slot] = ctl;
				return getJSON(path, ctl.signal).then(function (data) { if (!ctl.signal.aborted) setter(data); })
					.catch(function (e) { if (!ctl.signal.aborted) setter({ error: e.message }); });
			}
			function reloadProjects() { return readFor("projects", "/projects", function (d) { if (d.error) notify("项目目录读取失败：" + d.error, true); else projects[1](d.projects || []); }); }
			function reloadJournal() { return readFor("journal", "/journal", function (d) { journalError[1](d.error || ""); if (!d.error) journal[1](d.ops || []); }); }
			function reloadSessions() {
				var project = activeProject.current; catalog[1](null);
				return readFor("sessions", "/sessions?project=" + encodeURIComponent(project), function (d) { if (project === activeProject.current) catalog[1](Object.assign({ project: project }, d)); });
			}
			useEffect(function () {
				reloadProjects(); reloadJournal();
				return function () { Object.values(controllers.current).forEach(function (ctl) { ctl.abort(); }); clearTimeout(toastTimer.current); };
			}, []);
			useEffect(function () { var listener = function (value) { hostSession[1](value); }; observedListeners.add(listener); listener(Object.assign({}, observedSession)); return function () { observedListeners.delete(listener); }; }, []);
			useEffect(function () { if (hostSession[0].id && !manualSession.current) current[1]("global"); }, [hostSession[0].id]);
			useEffect(function () { inspected[1](null); reloadSessions(); return function () { if (controllers.current.sessions) controllers.current.sessions.abort(); }; }, [current[0]]);
			useEffect(function () { if (boardRecovery[0]) return; storageError[1](save(LS_BOARD, board[0]) ? "" : "草稿尚未保存到本机：存储空间不足或不可用。请复制导出后再关闭。"); }, [board[0], boardRecovery[0]]);
			useEffect(function () { prefsError[1](save(LS_PREFS, { project: current[0], target: target[0], budget: budget[0], task: task[0], debuggerVersion: 2 }) ? "" : "任务与偏好尚未保存，请先复制草稿再关闭。"); }, [current[0], target[0], budget[0], task[0]]);
			useEffect(function () { if (!target[0]) { var ws = projects[0].find(function (p) { return p.id !== "global"; }); if (ws) target[1](ws.id); } }, [projects[0]]);
			useEffect(function () {
				var alive = true, timer = setTimeout(function () {
					post("/compose", { items: board[0], budget: Number(budget[0]) || 0, task: task[0] })
						.then(function (d) { if (alive) preview[1](d); })
						.catch(function (e) { if (alive) preview[1]({ error: e.message, tokens: 0, overFrom: -1 }); });
				}, 250);
				return function () { alive = false; clearTimeout(timer); };
			}, [board[0], budget[0], task[0]]);
			var projectList = projects[0], projectTitle = function (id) { var p = projectList.find(function (x) { return x.id === id; }); return p ? p.title : id; };
			var sessions = catalog[0] && catalog[0].project === current[0] && !catalog[0].error ? catalog[0].sessions || [] : [];
			var followed = !manualSession.current && hostSession[0].id ? sessions.find(function (s) { return s.id === hostSession[0].id; }) || { id: hostSession[0].id, title: "刚才查看的会话" } : null;
			var inspectSession = sessions.find(function (s) { return s.id === inspected[0]; }) || followed || sessions.find(function (s) { return s.turns > 0; }) || sessions[0];
			var boardKeys = useMemo(function () { return new Set(board[0].map(function (b) { return b.key; })); }, [board[0]]);
			function addEvidence(session, row, text) {
				if (!text) return;
				var item = evidenceItem(session, row, text);
				if (boardKeys.has(item.key)) { notify("这个片段已经在分支草稿里"); return; }
				board[1](function (items) { return items.some(function (b) { return b.key === item.key; }) ? items : items.concat([item]); });
				if (session.workspaceId && !target[0]) target[1](session.workspaceId);
				notify("已选入新分支草稿 · 来源和字符位置已保留");
			}
			function undo(op) {
				dialog[1]({ title: "撤销这次操作？", confirmLabel: "撤销",
					body: h("div", null, h("p", null, op.label), op.backup ? h("p", { className: "csx-muted" }, "备份：", h("code", null, op.backup)) : null,
						h("p", { className: "csx-muted" }, "若文件后来被修改，会拒绝覆盖；请先核对备份和操作记录。")),
					onConfirm: function () { return post("/undo", { opId: op.id }).then(function (result) { notify(result.text || "已撤销"); reloadJournal(); }, function (e) { notify(e.message, true); throw e; }); } });
			}
			async function launch() {
				if (!board[0].length) { notify("草稿是空的", true); return; }
				var fresh;
				try { fresh = await post("/compose", { items: board[0], budget: Number(budget[0]) || 0, task: task[0] }); }
				catch (e) { notify("生成草稿失败：" + e.message, true); return; }
				var text = fresh.text;
				if (!services || !services.uiWorkspace || typeof services.uiWorkspace.startSession !== "function") {
					try { await navigator.clipboard.writeText(text); notify("这个版本的 DSH 不支持预填草稿，已复制到剪贴板"); } catch (e) { preview[1](fresh); showPreview[1](true); notify("无法自动复制，请从预览中复制", true); } return;
				}
				var mode = { value: "append" };
				function Body() {
					var st = useState("append");
					mode.value = st[0];
					return h("div", null,
						h("p", { style: { margin: 0 } }, "只携带所选片段，在「" + (target[0] ? projectTitle(target[0]) : "当前 / 最近的工作区") + "」打开空白会话，把拼好的起始上下文（≈" + fmtTok(fresh.tokens || 0) + " tokens）填进输入框。", h("b", null, "不会自动发送"), "，检查后由你按发送。"),
						h("p", { className: "csx-hint" }, "目标项目自己的指令与运行环境仍由 DSH 加载。选中的历史文本作为参考材料加入草稿。"),
						h("div", { className: "csx-muted", style: { margin: "8px 0 4px" } }, "DSH 会复用这个工作区里还没发过消息的空白会话。如果那里已经有未发送的草稿："),
						h("label", { className: "csx-row" }, h("input", { type: "radio", name: "csx-draft", checked: st[0] === "append", onChange: function () { st[1]("append"); } }), "接在后面（保留原有草稿）"),
						h("label", { className: "csx-row" }, h("input", { type: "radio", name: "csx-draft", checked: st[0] === "replace", onChange: function () { st[1]("replace"); } }), "替换掉（原有草稿会丢失）"));
				}
				dialog[1]({
					title: "用所选片段准备新分支", confirmLabel: "创建草稿",
					body: h(Body),
					onConfirm: async function () {
						try {
							await services.uiWorkspace.startSession(target[0] && target[0] !== "global" ? target[0] : undefined, { prompt: text, whenDraftExists: mode.value });
							notify("已打开会话并填好草稿，检查后按发送即可");
						} catch (e) { notify("打开新会话失败：" + e.message, true); throw e; }
					},
				});
			}
			async function copy() {
				try { var fresh = await post("/compose", { items: board[0], budget: Number(budget[0]) || 0, task: task[0] }); preview[1](fresh);
					try { await navigator.clipboard.writeText(fresh.text); notify("已复制"); } catch (e) { showPreview[1](true); notify("复制失败，请从预览里手动复制", true); }
				} catch (e) { notify("生成草稿失败：" + e.message, true); }
			}

			var pv = preview[0] || { tokens: 0, overFrom: -1 }, b = Number(budget[0]) || 0;
			var branch = h("section", { className: "csx-branch-panel", "aria-label": "所选片段的新分支草稿" },
				h("div", { className: "csx-eyebrow" }, "02 / 新分支"), h("h3", null, "带哪些片段重新开始"),
				h("p", { className: "csx-side-intro" }, "只带所选原文，整理一份新的会话草稿。目标项目自己的指令仍会加载。"),
				h("div", { className: "csx-branch-count" }, board[0].length + " 段已选 · 可拖动排序"),
				h(Board, { items: board[0], overFrom: pv.overFrom, onChange: board[1] }),
				h("label", { className: "csx-field-label" }, "新任务", h("textarea", { className: "csx-input", value: task[0], placeholder: "写清这次要解决什么、纠正什么…", onChange: function (e) { task[1](e.target.value); } })),
				h("label", { className: "csx-field-label" }, "目标项目", h("select", { className: "csx-input", value: target[0], onChange: function (e) { target[1](e.target.value); } },
					h("option", { value: "" }, "当前 / 最近的工作区"), projectList.filter(function (p) { return p.id !== "global"; }).map(function (p) { return h("option", { key: p.id, value: p.id }, p.title); }))),
				h("details", { className: "csx-branch-budget" }, h("summary", null, "预算与预览 · ≈" + fmtTok(pv.tokens || 0) + " tokens"),
					h("label", { className: "csx-field-label" }, "草稿 token 预算（估算）", h("input", { className: "csx-input", type: "number", min: 0, step: 1000, value: budget[0], onChange: function (e) { budget[1](e.target.value); } })),
					h("div", { className: "csx-bar" + (pv.over ? " over" : "") }, h("i", { style: { width: b ? Math.min(100, ((pv.tokens || 0) / b) * 100) + "%" : "0%" } })),
					pv.error ? h("p", { role: "alert", className: "csx-hint" }, "预览失败：" + pv.error) : null,
					pv.over ? h("p", { className: "csx-hint" }, "超出草稿预算，请精简所选片段或调整预算。") : null,
					h(Btn, { disabled: !board[0].length, onClick: function () { showPreview[1](!showPreview[0]); } }, showPreview[0] ? "收起预览" : "预览"),
					showPreview[0] && pv.text ? h("pre", { className: "csx-pre" }, pv.text) : null),
				h("div", { className: "csx-branch-actions" }, h(Btn, { kind: "primary", disabled: !board[0].length, onClick: launch }, "准备新分支草稿 →"),
					h(Btn, { disabled: !board[0].length, onClick: copy }, "复制")),
				h("p", { className: "csx-hint" }, "下一步会确认草稿。不会自动发送，也不会复制整段历史。"));
			return h("div", { className: "csx csx-flow-app" },
				h("header", { className: "csx-top" }, h(SidebarIcon, { size: 21 }),
					h("div", { className: "csx-grow" }, h("h1", { className: "csx-h1" }, "上下文调试"), h("span", { className: "csx-app-caption" }, "看清来路 · 核对变化 · 精选片段开新分支")),
					h(Btn, { onClick: function () { navOpen[1](!navOpen[0]); } }, "会话目录"),
					h(Btn, { onClick: function () { journalOpen[1](!journalOpen[0]); if (!journalOpen[0]) reloadJournal(); } }, "操作记录"),
					h(Btn, { kind: "primary", disabled: !board[0].length, onClick: launch }, "准备分支草稿 · " + board[0].length),
					h(Btn, { onClick: function () { reloadProjects(); reloadSessions(); inspectRefresh[1](function (n) { return n + 1; }); } }, "刷新")),
				storageError[0] || prefsError[0] ? h("div", { role: "alert", className: "csx-warning" }, storageError[0] || prefsError[0]) : null,
				boardRecovery[0] ? h("div", { role: "alert", className: "csx-warning" }, "保存的草稿含无效数据，已恢复可读条目；原始数据仍保留，尚未覆盖。",
					h(Btn, { onClick: function () { navigator.clipboard.writeText(JSON.stringify(initialBoard)).then(function () { notify("已导出原始草稿"); }, function () { notify("无法复制，请保留此页面", true); }); } }, "导出原始草稿"),
					h(Btn, { onClick: function () { boardRecovery[1](false); } }, "使用恢复后的草稿")) : null,
				h("div", { className: "csx-debug-content" },
					h("div", { className: "csx-context-picker", "aria-label": "会话目录" },
						h("select", { className: "csx-input", "aria-label": "筛选项目", value: current[0], onChange: function (e) { manualSession.current = true; current[1](e.target.value); } },
							!projectList.some(function (p) { return p.id === "global"; }) ? h("option", { value: "global" }, "全部会话") : null,
							projectList.map(function (p) { return h("option", { key: p.id, value: p.id }, p.id === "global" ? "全部会话" : p.title); })),
						h("select", { className: "csx-input csx-grow", "aria-label": "从目录选择会话", value: inspectSession ? inspectSession.id : "", disabled: !sessions.length && !followed, onChange: function (e) { manualSession.current = true; inspected[1](e.target.value); } },
							!sessions.length && !followed ? h("option", { value: "" }, !catalog[0] ? "读取会话目录…" : catalog[0].error ? "会话目录读取失败" : "没有可选会话") : null,
							followed && !sessions.some(function (s) { return s.id === followed.id; }) ? h("option", { value: followed.id }, followed.title) : null,
							sessions.map(function (s) { return h("option", { key: s.id, value: s.id }, s.title + (s.external ? " · 跨项目" : "")); })),
						h(Btn, { kind: "ghost", disabled: !hostSession[0].id, title: hostSession[0].available ? "插件本次运行期间最近观察到的会话" : "宿主当前会话服务不可用，使用会话目录选择", onClick: function () { manualSession.current = false; inspected[1](null); current[1]("global"); } }, followed ? "刚才查看的会话" : "跟随刚才查看的会话")),
					catalog[0] && catalog[0].error ? h("p", { role: "alert", className: "csx-warning" }, catalog[0].error, h(Btn, { onClick: reloadSessions }, "重试目录")) : null,
					catalog[0] && catalog[0].warnings ? catalog[0].warnings.map(function (w) { return h("p", { className: "csx-hint", key: w }, w); }) : null,
					h(Inspector, { key: inspectSession ? inspectSession.id : "empty", session: inspectSession, refresh: inspectRefresh[0],
						onRetry: function () { inspectRefresh[1](function (n) { return n + 1; }); }, onAdd: addEvidence, branch: branch, evidence: board[0],
						has: function (id, seq) { return board[0].some(function (it) { return it.evidenceSession === id && it.evidenceSeq === seq; }); } })),
				navOpen[0] ? h("section", { className: "csx-session-drawer", role: "dialog", "aria-label": "切换调试会话", "aria-modal": false },
					h("div", { className: "csx-row" }, h("h3", { className: "csx-grow" }, "会话目录"), h(Btn, { onClick: function () { navOpen[1](false); } }, "关闭")),
					h("input", { className: "csx-input", "aria-label": "筛选会话", value: sessionSearch[0], placeholder: "查找会话标题…", onChange: function (e) { sessionSearch[1](e.target.value); } }),
						sessions.filter(function (s) { return s.title.toLowerCase().includes(sessionSearch[0].toLowerCase()); }).map(function (s) { return h("button", { key: s.id, type: "button", className: "csx-nav-session" + (inspectSession && inspectSession.id === s.id ? " on" : ""), onClick: function () { manualSession.current = true; inspected[1](s.id); navOpen[1](false); } }, h("b", null, s.title), h("small", null, ago(s.createdAt))); })) : null,
				journalOpen[0] ? h("section", { className: "csx-record-drawer", role: "dialog", "aria-label": "备份与操作记录", "aria-modal": false },
					h("div", { className: "csx-row" }, h("h3", { className: "csx-grow" }, "备份与操作记录"), h(Btn, { onClick: function () { journalOpen[1](false); } }, "关闭")),
					h("p", { className: "csx-hint" }, "历史文件修改的备份由宿主保留。撤销前会再次确认；不会覆盖后来发生的文件改动。"),
					journalError[0] ? h("div", { role: "alert" }, journalError[0], h(Btn, { onClick: reloadJournal }, "重试记录")) : null,
					journal[0].length ? journal[0].slice(0, 50).map(function (op) { return h("div", { key: op.id, className: "csx-op" + (op.undone ? " undone" : "") },
						h("span", { className: "csx-grow", title: op.backup || op.label }, op.label),
						op.undone || op.canUndo === false ? null : h(Btn, { onClick: function () { undo(op); } }, "撤销")); }) : h("p", { className: "csx-hint" }, "暂无历史操作")) : null,
				h(Dialog, { dialog: dialog[0], onClose: function () { dialog[1](null); } }),
				toast[0] ? h("div", { role: "status", className: "csx-toast" + (toast[0].err ? " err" : "") }, toast[0].text) : null);
		}

		// ── 注册 ────────────────────────────────────────────────
		var inject = ["uiWorkspace", "slots", "layout"];

		function apply(ctx) {
			services = ctx;
			ctx.effect(function () { return observeCurrentSession(ctx); }, "dsh-plugin-context-studio: observed session");
			ctx.effect(function () {
				var style = document.createElement("style");
				style.setAttribute("data-dsh-plugin-context-studio", "");
				style.textContent = CSS;
				document.head.appendChild(style);
				return function () { style.remove(); };
			}, "dsh-plugin-context-studio: styles");
			ctx.effect(function () {
				return ctx.slots.inject("main", function () {
					return ctx.slots.register({ name: "main", key: PANEL_ID }, StudioPage);
				});
			}, "dsh-plugin-context-studio: page");
			ctx.effect(function () {
				return ctx.slots.inject("sidebar.panellist", function () {
					return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 25, label: function () { return "上下文调试"; } }, SidebarIcon);
				});
			}, "dsh-plugin-context-studio: entry");
			ctx.effect(function () {
				window.__dshContextStudio = { open: function () { ctx.layout.selectPanel(PANEL_ID); } };
				return function () { delete window.__dshContextStudio; };
			}, "dsh-plugin-context-studio: bridge");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
