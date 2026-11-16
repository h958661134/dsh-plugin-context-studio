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
				if (pieceId) { drag.current = null; props.onAddPiece(pieceId, at); return; }
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
				}) : h("div", { className: "csx-empty" }, "勾选左边的素材，或把它拖到这里"));
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
		function Inspector(props) {
			var session = props.session, sessionId = session && session.id;
			var options = useState(null), snapshot = useState(null), viewRetry = useState(0);
			var selected = useState(null), detail = useState(null), detailRetry = useState(0), excerpt = useState(null);
			var searchInput = useState(null), background = useState(false), modulesOpen = useState(true), recordJump = useState(0);
			var refreshSeen = useRef({ external: props.refresh, local: 0 });
			var viewLive = useRef(null), detailLive = useRef(null), detailPanel = useRef(null), detailOpener = useRef(null), recordSection = useRef(null);
			var opts = options[0] && options[0].id === sessionId ? options[0] :
				{ id: sessionId, answer: null, module: null, state: "active", page: 0, q: "" };
			var viewKey = JSON.stringify([sessionId, opts.answer, opts.module, opts.state, opts.page, opts.q, props.refresh, viewRetry[0]]);
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
				getJSON(inspectPath("/inspect-view", { id: sessionId, answer: opts.answer, module: opts.module,
					state: opts.state, page: opts.page, q: opts.q, refresh: refresh ? 1 : null }), controller.signal)
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
			useEffect(function () {
				if (recordJump[0] && recordSection.current) {
					recordSection.current.focus({ preventScroll: true }); recordSection.current.scrollIntoView({ block: "start", behavior: "smooth" });
				}
			}, [recordJump[0]]);

			function change(patch) {
				// 锁定已选回答；翻页时不会悄悄漂移到刚生成的新回答。
				options[1](Object.assign({}, opts, { answer: meta ? (meta.answer ? meta.answer.seq : null) : opts.answer,
					module: opts.module || (meta && meta.page && meta.page.module), page: 0 }, patch));
				selected[1](null); excerpt[1](null);
			}
			function chooseAnswer(seq) {
				if (seq == null) return;
				change({ answer: seq, page: 0, q: "" }); searchInput[1]({ id: sessionId, value: "" });
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
			function moduleCard(def) {
				var m = (meta.modules || []).find(function (item) { return item.id === def[0]; }) || {};
				var active = (opts.module || (meta.page && meta.page.module)) === def[0];
				return h("button", { type: "button", key: def[0], className: "csx-module-card" + (active ? " on" : "") + (m.active === 0 && m.replaced === 0 && m.unknown === 0 ? " empty" : ""),
					"aria-pressed": active, "aria-label": "查看" + def[1], onClick: function () { change({ module: def[0] }); modulesOpen[1](false); recordJump[1](function (n) { return n + 1; }); } },
					h("span", { className: "csx-module-title" }, def[1], h("b", null, m[opts.state] == null ? "—" : m[opts.state])),
					h("span", { className: "csx-module-description" }, m.description || def[2]),
					h("span", { className: "csx-module-counts" }, m.replaced ? "已替换 " + m.replaced : null, m.unknown ? "位置未知 " + m.unknown : null,
						m.issues ? h("span", { className: "csx-status warn" }, m.issues + " 条线索") : null,
						h("span", { className: "csx-module-action" }, "查看记录 →")));
			}
			if (!session) return h("div", { className: "csx-welcome" },
				h("div", { className: "csx-eyebrow" }, "上下文工作台"),
				h("h2", null, "找到回答的依据，再决定带什么继续。"),
				h("p", null, "先从会话目录选择会话，再定位出问题的回答。要求、项目约定、工具结果会分别展示，你可以核对原文，把有用的部分加入新会话草稿。"),
				h("div", { className: "csx-steps" },
					[["01", "定位回答", "前后浏览，找到从哪里开始偏离。"], ["02", "查看模块", "按来源核对内容和替换记录。"], ["03", "挑选再开始", "按页或选中文字，保留来源加入草稿。"]].map(function (s) {
						return h("div", { key: s[0] }, h("span", { className: "csx-eyebrow" }, s[0]), h("b", null, s[1]), h("small", null, s[2]));
					})));

			var page = d && d.page, summary = meta && meta.summary || {}, unavailable = summary.available === false;
			var moduleId = opts.module || (meta && meta.page && meta.page.module);
			var definition = INSPECT_MODULES.find(function (def) { return def[0] === moduleId; });
			var emptyModules = meta ? INSPECT_MODULES.slice(0, 6).filter(function (def) {
				var m = (meta.modules || []).find(function (entry) { return entry.id === def[0]; });
				return def[0] !== moduleId && m && m.active === 0 && m.replaced === 0 && m.unknown === 0;
			}) : [];
			var row = full && full.row, total = full ? full.totalChars : 0;
			var searchValue = searchInput[0] && searchInput[0].id === sessionId ? searchInput[0].value : opts.q;
			var windowed = info.total > timeline.length;
			return h("section", { className: "csx-inspect" },
				h("div", { className: "csx-inspect-head" },
					h("div", { className: "csx-grow" }, h("div", { className: "csx-eyebrow" }, "01 · 定位回答"), h("h2", null, session.title),
						h("div", { className: "csx-muted" }, session.project || "当前会话", info.total != null ? " · " + info.total + " 次模型输出" : "")),
					h(Btn, { disabled: !(services && services.uiWorkspace), onClick: function () { if (services && services.uiWorkspace) services.uiWorkspace.openSession(session.id); } }, "打开原会话 ↗")),
				timeline.length ? h("div", { className: "csx-answer-nav", "aria-label": "回答导航" },
					h("div", { className: "csx-row" },
						!windowed ? h("span", { className: "csx-answer-end" }, h(Btn, { kind: "ghost", disabled: info.firstSeq == null || (meta && meta.answer && meta.answer.seq === info.firstSeq), onClick: function () { chooseAnswer(info.firstSeq); } }, "最早回答")) : null,
						h(Btn, { disabled: pending || info.previousSeq == null, onClick: function () { chooseAnswer(info.previousSeq); } }, "← 上一回答"),
						h("select", { className: "csx-input csx-grow", "aria-label": "检查哪次回答", value: opts.answer ?? (nav.answer && nav.answer.seq) ?? "",
							onChange: function (e) { chooseAnswer(Number(e.target.value)); } },
							timeline.map(function (a, i) { return h("option", { key: a.seq, value: a.seq }, (a.index ?? (info.start || 0) + i + 1) + " · 第 " + (a.turn ?? "?") + " 轮 · " + String(a.preview || "").slice(0, 65)); })),
						h(Btn, { disabled: pending || info.nextSeq == null, onClick: function () { chooseAnswer(info.nextSeq); } }, "下一回答 →"),
						!windowed ? h("span", { className: "csx-answer-end" }, h(Btn, { kind: "ghost", disabled: info.lastSeq == null || (meta && meta.answer && meta.answer.seq === info.lastSeq), onClick: function () { chooseAnswer(info.lastSeq); } }, "最新回答")) : null),
					windowed ? h("div", { className: "csx-row csx-answer-jumps" },
						h(Btn, { kind: "ghost", disabled: info.firstSeq == null || (meta && meta.answer && meta.answer.seq === info.firstSeq), onClick: function () { chooseAnswer(info.firstSeq); } }, "最早回答"),
						h(Btn, { kind: "ghost", disabled: info.earlierWindowSeq == null, onClick: function () { chooseAnswer(info.earlierWindowSeq); } }, "更早一组"),
						h("span", { className: "csx-muted csx-grow" }, "目录显示 " + timeline.length + " / " + info.total + " 次输出"),
						h(Btn, { kind: "ghost", disabled: info.laterWindowSeq == null, onClick: function () { chooseAnswer(info.laterWindowSeq); } }, "更晚一组"),
						h(Btn, { kind: "ghost", disabled: info.lastSeq == null || (meta && meta.answer && meta.answer.seq === info.lastSeq), onClick: function () { chooseAnswer(info.lastSeq); } }, "最新回答")) : null) : null,
				pending ? h("div", { role: "status", className: "csx-read-status" }, "正在读取模块目录…") : null,
				current && current.error ? h("div", { role: "alert", className: "csx-warning" }, h("p", null, current.error),
					h(Btn, { onClick: retry }, "重新读取此会话")) : null,
				meta ? h(React.Fragment, null,
					meta.answer ? h("div", { className: "csx-answer csx-answer-compact" },
						h("div", { className: "csx-row" }, h("span", { className: "csx-status" }, "正在核对 · 回答 #" + meta.answer.seq),
							h("span", { className: "csx-grow" }), h(Btn, { disabled: pending, onClick: function (e) { openDetail(meta.answer.seq, e); } }, "查看回答原文")),
						h("p", { className: "csx-answer-text" }, meta.answer.preview || "这次输出没有文本预览。")) :
						h("p", { className: "csx-hint" }, "还没有模型回答，下面是已记录的上下文。"),
					unavailable ? h("div", { className: "csx-warning", role: "status" },
						h("strong", null, "这次回答的上下文目录暂不可用"),
						h("p", null, "历史记录超过本次检查范围，数量未知。可在上方选择更早的回答继续核对；这不表示上下文为空。")) : null,
					meta.partial && !unavailable ? h("div", { className: "csx-read-status", role: "status" }, "本次检查有额外限制，请展开下方排查线索核对。") : null,
					!unavailable ? h(React.Fragment, null,
						h("div", { className: "csx-module-heading" }, h("div", null,
							h("div", { className: "csx-eyebrow" }, "02 · 按来源核对"),
							h("h3", null, "这次回答带了什么上下文？")),
							h("span", { className: "csx-muted" }, (summary.active ?? "—") + " 条在输入中 · 本次新增 " + (summary.added ?? "—") + " 条")),
						h("div", { className: "csx-state-tabs", role: "group", "aria-label": "上下文状态" },
							Object.keys(INSPECT_STATES).map(function (state) {
								return h("button", { type: "button", key: state, className: "csx-btn" + (opts.state === state ? " on" : ""),
									"aria-pressed": opts.state === state, onClick: function () { change({ state: state }); } },
									INSPECT_STATES[state] + " · " + (summary[state] ?? "—"));
							})),
						modulesOpen[0] ? h(React.Fragment, null,
						h("div", { className: "csx-module-grid", "aria-label": "上下文模块" }, INSPECT_MODULES.slice(0, 6).filter(function (def) { return !emptyModules.includes(def); }).map(moduleCard)),
						emptyModules.length ? h("details", { className: "csx-empty-modules" }, h("summary", null, "无记录模块 · " + emptyModules.length),
							h("div", { className: "csx-module-grid" }, emptyModules.map(moduleCard))) : null,
						h("details", { className: "csx-background-modules", open: background[0],
							onToggle: function (e) { background[1](e.currentTarget.open); } },
							h("summary", null, "系统背景与其他来源", h("span", { className: "csx-muted" }, " · 按需展开")),
							h("div", { className: "csx-module-grid" }, INSPECT_MODULES.slice(6).map(moduleCard)))) :
							h("div", { className: "csx-module-selection" }, h("span", { role: "status", "aria-live": "polite" }, "已选择 · " + (definition ? definition[1] : "上下文") + " / " + INSPECT_STATES[opts.state]),
								h(Btn, { onClick: function () { modulesOpen[1](true); } }, "更换模块")),
						h("section", { className: "csx-records", ref: recordSection, tabIndex: -1, "aria-label": "模块内记录" },
							h("div", { className: "csx-record-heading" }, h("h3", null, (definition ? definition[1] : "上下文记录") + " · " + INSPECT_STATES[opts.state]),
								h("span", { className: "csx-muted" }, page ? page.total + " 条" : "读取中")),
							opts.state !== "active" ? h("p", { className: "csx-hint" }, opts.state === "replaced" ? "这些内容在所选回答前已被替换。核对替代记录后再决定是否复用。" : "日志未能确定这些内容的位置，不能断定它们参与了这次回答。") : null,
							h("form", { className: "csx-row csx-record-search", onSubmit: function (e) { e.preventDefault(); change({ q: searchValue.trim() }); } },
								h("input", { className: "csx-input csx-grow", "aria-label": "搜索当前模块的标题或预览", placeholder: "搜索标题或预览（非全文）…", maxLength: 200, value: searchValue,
									onChange: function (e) { searchInput[1]({ id: sessionId, value: e.target.value }); } }),
								h("button", { type: "submit", className: "csx-btn" }, "搜索"),
								opts.q ? h(Btn, { onClick: function () { searchInput[1]({ id: sessionId, value: "" }); change({ q: "" }); } }, "清除") : null),
							pending ? h("p", { className: "csx-empty", role: "status" }, "正在读取这一页记录…") :
							current && current.error ? h("p", { className: "csx-empty" }, "这一页读取失败，请重试或切换模块。") :
							page && page.items.length ? h("div", { className: "csx-record-grid" }, page.items.map(function (record) {
								return h("article", { key: record.seq, className: "csx-record-card" + (pick && pick.seq === record.seq ? " on" : "") },
									h("div", { className: "csx-row" }, h("h4", { className: "csx-grow" }, record.label),
										record.added ? h("span", { className: "csx-status" }, "本次新增") : null),
									h("p", { className: "csx-record-preview" }, record.preview || "没有文本预览，请查看原文"),
									record.issueCount ? h("div", { className: "csx-record-issue" }, record.issueCount + " 条线索 · " + (record.issues || []).slice(0, 2).join(" · ")) : null,
									h("div", { className: "csx-row" }, h("small", { className: "csx-muted csx-grow" }, "#" + record.seq + (props.has && props.has(sessionId, record.seq) ? " · 已选过片段" : "")),
										h(Btn, { onClick: function (e) { openDetail(record.seq, e); } }, "查看原文 / 挑选")));
							})) : h("div", { className: "csx-empty" }, opts.q ? "这个模块下没有匹配的记录，试试清除搜索或切换状态。" : "这个模块在所选状态下没有记录。"),
							page && page.pages > 0 ? h("div", { className: "csx-pagination", "aria-label": "记录分页" },
								h(Btn, { disabled: page.index <= 0, onClick: function () { change({ page: page.index - 1 }); } }, "上一页记录"),
								h("span", { role: "status" }, "第 " + (page.index + 1) + " / " + page.pages + " 页 · " + page.total + " 条"),
								h(Btn, { disabled: page.index + 1 >= page.pages, onClick: function () { change({ page: page.index + 1 }); } }, "下一页记录")) : null)) : null,
					meta.warnings && meta.warnings.length ? h("details", { className: "csx-inspect-warnings" },
						h("summary", null, "排查线索 · " + meta.warnings.length),
						h("p", { className: "csx-hint" }, "这些是日志中的线索，不代表已经确定错误原因。"),
						meta.warnings.map(function (w, i) { return h("div", { key: i, className: "csx-warning" },
							h("strong", null, w.title), h("p", null, w.detail),
							w.seq != null ? h(Btn, { disabled: pending, onClick: function (e) { openDetail(w.seq, e); } }, "核对相关原文 #" + w.seq) : null); })) : null,
					h("p", { className: "csx-hint" }, meta.limitation)) : null,
				pick ? h("section", { className: "csx-detail-panel", ref: detailPanel, tabIndex: -1, role: "dialog", "aria-modal": false,
					"aria-label": "原文详情", "aria-busy": !detailResult, onKeyDown: function (e) { if (e.key === "Escape") { e.stopPropagation(); closeDetail(); } } },
					h("div", { className: "csx-row" }, h("div", { className: "csx-grow" },
						h("div", { className: "csx-eyebrow" }, "03 · 挑选后加入草稿"),
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
							h(Btn, { kind: "primary", disabled: !full.text, onClick: function () { addCurrent(false); } }, "将本页加入草稿"),
							h(Btn, { disabled: !chosen || chosen.end <= chosen.start, onClick: function () { addCurrent(true); } }, "只加入选中文字"),
							h("span", { className: "csx-muted" }, chosen && chosen.end > chosen.start ? "已选 " + (chosen.end - chosen.start) + " 字符" : "可在原文中拖选文字")),
						h("p", { className: "csx-hint" }, "本页约 " + fmtTok(row.tokens || estimate(full.text)) + " tokens（估算）。仅加入当前页或所选文字，不代表整条记录；来源、正文/参数及字符位置会保留。"),
						h("p", { className: "csx-hint" }, "可跨模块、跨会话继续挑选。草稿只在你确认后填入新会话，不会自动发送。")) : null) : null);
		}

		// ── 整页 ────────────────────────────────────────────────
		function StudioPage() {
			var prefs0 = useState(function () { var p = load(LS_PREFS, {}); return p && typeof p === "object" ? p : {}; })[0];
			var projects = useState(null);
			var caps = useState({});
			var current = useState(prefs0.project || "global");
			var data = useState(null);
			var loading = useState(false);
			var kind = useState("all");
			var search = useState("");
			var onlyFlagged = useState(false);
			var initialBoard = useState(function () { var raw; try { raw = localStorage.getItem(LS_BOARD); return raw ? JSON.parse(raw) : []; } catch (e) { return { unreadable: raw, reason: e.message }; } })[0];
			var board = useState(function () { return Array.isArray(initialBoard) ? initialBoard.filter(function (b) { return b && typeof b.key === "string" && typeof b.text === "string" && KIND_LABEL[b.kind]; }) : []; });
			var storageError = useState(""); var prefsError = useState("");
			var boardRecovery = useState(!Array.isArray(initialBoard) || board[0].length !== initialBoard.length);
			var target = useState(prefs0.target || "");
			var budget = useState(prefs0.budget || 8000);
			var task = useState(prefs0.task || "");
			var preview = useState(null);
			var showPreview = useState(false);
			var journal = useState([]);
			var dialog = useState(null);
			var toast = useState(null);
			var snippets = useState(null); // { piece, list }
			var extra = useState("");
			var view = useState(prefs0.debuggerVersion === 1 ? (prefs0.view || "inspect") : "inspect");
			var inspected = useState(null);
			var inspectRefresh = useState(0);
			var sessionSearch = useState("");
			var graph = useState(null);
			var catalog = useState(null);
			var selection = useState(null);
			var boardOpen = useState(false);
			var requestVersion = useRef({ pieces: 0, graph: 0 });
			var activeProject = useRef(current[0]); activeProject.current = current[0];
			var activeView = useRef(view[0]); activeView.current = view[0];
			var controllers = useRef({});
			var snippetVersion = useRef(0);
			function readFor(slot, path, setter) {
				if (controllers.current[slot]) controllers.current[slot].abort();
				var ctl = new AbortController(), project = activeProject.current;
				controllers.current[slot] = ctl;
				return getJSON(path, ctl.signal).then(function (d) { if (!ctl.signal.aborted && project === activeProject.current) setter(d); })
					.catch(function (e) { if (!ctl.signal.aborted && project === activeProject.current) setter({ error: e.message }); });
			}
			var toastTimer = useRef(0);

			function notify(text, err) {
				toast[1]({ text: text, err: !!err });
				clearTimeout(toastTimer.current);
				toastTimer.current = setTimeout(function () { toast[1](null); }, err ? 6000 : 3500);
			}
			function reloadProjects() {
				return getJSON("/projects").then(function (d) { projects[1](d.projects); caps[1](d.capabilities || {}); }).catch(function (e) { notify("读取项目失败：" + e.message, true); });
			}
			function reloadPieces() {
				if (activeView.current !== "wall") return;
				loading[1](true); data[1](null);
				return readFor("pieces", "/pieces?project=" + encodeURIComponent(activeProject.current), function (d) { data[1](d); loading[1](false); });
			}
			function reloadJournal() { return getJSON("/journal").then(function (d) { journal[1](d.ops || []); }).catch(function (e) { notify("操作记录读取失败：" + e.message, true); }); }
			function reloadGraph() {
				if (activeView.current !== "graph") return;
				graph[1](null);
				return readFor("graph", "/graph?project=" + encodeURIComponent(activeProject.current), graph[1]);
			}
			function reloadSessions() { catalog[1](null); return readFor("sessions", "/sessions?project=" + encodeURIComponent(activeProject.current), catalog[1]); }

			useEffect(function () { reloadProjects(); reloadJournal(); }, []);
			useEffect(function () { snippetVersion.current++; snippets[1](null); data[1](null); graph[1](null); selection[1](null); inspected[1](null); reloadSessions(); return function () { Object.values(controllers.current).forEach(function (c) { c.abort(); }); }; }, [current[0]]);
			useEffect(function () { reloadPieces(); reloadGraph(); }, [current[0], view[0]]);
			useEffect(function () { if (boardRecovery[0]) return; storageError[1](save(LS_BOARD, board[0]) ? "" : "草稿尚未保存到本机：存储空间不足或不可用。请复制导出后再关闭。"); }, [board[0], boardRecovery[0]]);
			useEffect(function () { prefsError[1](save(LS_PREFS, { project: current[0], target: target[0], budget: budget[0], task: task[0], view: view[0], debuggerVersion: 1 }) ? "" : "任务与偏好尚未保存，请先复制草稿再关闭。"); }, [current[0], target[0], budget[0], task[0], view[0]]);
			// 默认目标：第一个工作区
			useEffect(function () {
				if (!target[0] && projects[0]) {
					var ws = projects[0].filter(function (p) { return p.id !== "global"; })[0];
					if (ws) target[1](ws.id);
				}
			}, [projects[0]]);

			// 拼盘变化后让 Host 渲染预览（防抖）
			useEffect(function () {
				var alive = true;
				var t = setTimeout(function () {
					post("/compose", { items: board[0], budget: Number(budget[0]) || 0, task: task[0] })
						.then(function (r) { if (alive) preview[1](r); })
						.catch(function (e) { if (alive) preview[1]({ text: "预览失败：" + e.message, tokens: 0, overFrom: -1 }); });
				}, 250);
				return function () { alive = false; clearTimeout(t); };
			}, [board[0], budget[0], task[0]]);

			var projectList = projects[0] || [];
			var projectTitle = function (id) { var p = projectList.find(function (x) { return x.id === id; }); return p ? p.title : id; };
			var pieces = (data[0] && data[0].project && data[0].project.id === current[0] && data[0].pieces) || [];
			var boardKeys = useMemo(function () { var s = new Set(); board[0].forEach(function (b) { s.add(b.key); }); return s; }, [board[0]]);
			var sessions = catalog[0] && !catalog[0].error ? catalog[0].sessions || [] : [];
			var inspectSession = sessions.find(function (s) { return s.id === inspected[0]; }) || sessions.find(function (s) { return s.turns > 0; }) || sessions[0];
			function addEvidence(s, r, text) {
				if (!text) return;
				var item = evidenceItem(s, r, text);
				if (boardKeys.has(item.key)) { boardOpen[1](true); notify("这段内容已经在草稿里"); return; }
				board[1](function (items) { return items.some(function (b) { return b.key === item.key; }) ? items : items.concat([item]); });
				boardOpen[1](true);
				if (s.workspaceId && !target[0]) target[1](s.workspaceId);
					notify("已加入草稿，来源、原文类型与字符位置已保留");
			}

			function toItem(p) {
				var from = projectTitle(current[0]) + " / " + p.group;
				return { key: p.id, kind: p.kind, text: p.text, title: p.kind === "session" ? p.title : (p.title || p.text).slice(0, 60), from: p.kind === "instruction" ? from : undefined, time: p.time, tokens: p.tokens, origin: current[0] };
			}
			function toggle(p) {
				if (boardKeys.has(p.id)) board[1](board[0].filter(function (b) { return b.key !== p.id; }));
				else board[1](board[0].concat([toItem(p)]));
			}
			function addPieceAt(id, at) {
				if (boardKeys.has(id)) return;
				var p = pieces.find(function (x) { return x.id === id; });
				if (!p) return;
				var next = board[0].slice();
				next.splice(at == null ? next.length : at, 0, toItem(p));
				board[1](next);
			}
			function addExtra() {
				var v = extra[0].trim();
				if (!v) return;
				var isFile = v.charAt(0) === "@";
				var item = isFile
					? { key: "file:" + v, kind: "file", text: v.slice(1).trim(), title: v, tokens: estimate(v) }
					: { key: "note:" + Date.now(), kind: "note", text: v, title: v.slice(0, 60), tokens: estimate(v) };
				board[1](board[0].concat([item]));
				extra[1]("");
			}

			function act(promise) {
				return promise.then(function (r) {
					notify(r.text || "完成");
					reloadPieces(); reloadJournal(); reloadProjects(); reloadGraph();
					return r;
				}, function (e) { notify(e.message, true); throw e; });
			}

			function askRemove(p) {
				dialog[1]({
					title: "移除这一块？", danger: true, confirmLabel: "移除",
					body: h("div", null,
						h("div", { className: "csx-muted" }, "文件：", h("code", null, p.source.path), "（第 " + p.source.line + " 行）"),
						h("pre", { className: "csx-pre", style: { margin: "8px 0" } }, p.text),
						p.flags.length ? h("div", { className: "csx-muted" }, "体检：", p.flags.map(function (f) { return f.text; }).join("；")) : null,
						h("div", { className: "csx-muted", style: { marginTop: 6 } }, "移除前会把整份文件备份到 $DSH_HOME/context-studio/backups，之后可在「操作记录」里一键撤销。已经开着的会话不受影响，新会话不再加载这一块。")),
					onConfirm: function () { return act(post("/remove", { project: current[0], pieceId: p.id, fileHash: p.fileHash })); },
				});
			}
			function askArchive(p) {
				dialog[1]({
					title: "归档这个会话？", danger: true, confirmLabel: "归档",
					body: h("div", null, h("p", null, "「" + p.title + "」会从侧栏的会话列表里收起，日志不会删除。"), h("div", { className: "csx-muted" }, "会话正在运行时 DSH 会拒绝归档。可在「操作记录」里取消归档。")),
					onConfirm: function () { return act(post("/archive", { project: current[0], sessionId: p.source.sessionId, title: p.title })); },
				});
			}
			function askWrite(items, defaultTarget) {
				var choice = { project: defaultTarget || target[0] || "", file: "AGENTS.local.md" };
				function Body() {
					var st = useState(choice);
					var pv = useState(null);
					choice = st[0];
					useEffect(function () {
						post("/compose", { items: items, mode: "instructions" }).then(function (r) { pv[1](r); }).catch(function () {});
					}, []);
					var isGlobal = st[0].project === "global";
					return h("div", null,
						h("div", { className: "csx-row", style: { gap: 8, marginBottom: 8 } },
							h("span", null, "目标"),
							h("select", { className: "csx-input", style: { width: "auto" }, value: st[0].project, onChange: function (e) { st[1]({ project: e.target.value, file: e.target.value === "global" ? "AGENTS.md" : st[0].file }); } },
								h("option", { value: "" }, "选择项目…"),
								projectList.map(function (p) { return h("option", { key: p.id, value: p.id }, p.title); })),
							h("select", { className: "csx-input", style: { width: "auto" }, value: isGlobal ? "AGENTS.md" : st[0].file, disabled: isGlobal, onChange: function (e) { st[1]({ project: st[0].project, file: e.target.value }); } },
								h("option", { value: "AGENTS.local.md" }, "AGENTS.local.md（仅本机，推荐）"),
								h("option", { value: "AGENTS.md" }, "AGENTS.md（会进版本库）"))),
						h("div", { className: "csx-muted" }, "将追加到文件末尾，用 context-studio 标记包起来并写明来源；先备份，可撤销。"),
						pv[0] ? h("pre", { className: "csx-pre", style: { marginTop: 8 } }, pv[0].text) : null,
						pv[0] && pv[0].skipped ? h("div", { className: "csx-muted" }, pv[0].skipped + " 个文件引用不适合写进指令文件，已跳过。") : null);
				}
				dialog[1]({
					title: "写入项目指令文件", confirmLabel: "写入",
					body: h(Body),
					onConfirm: function () {
						if (!choice.project) { notify("先选一个目标项目", true); return Promise.reject(new Error("no target")); }
						return act(post("/write", { project: choice.project, file: choice.project === "global" ? "AGENTS.md" : choice.file, items: items, from: projectTitle(current[0]) }));
					},
				});
			}
			function transplant(p) { askWrite([toItem(p)], target[0] && target[0] !== current[0] ? target[0] : ""); }

			function openSnippets(p) {
				var ticket = ++snippetVersion.current;
				snippets[1]({ piece: p, list: null });
				getJSON("/session?id=" + encodeURIComponent(p.source.sessionId))
					.then(function (d) { if (ticket === snippetVersion.current) snippets[1]({ piece: p, list: d.snippets }); })
					.catch(function (e) { if (ticket === snippetVersion.current) snippets[1]({ piece: p, list: [], error: e.message }); });
			}
			function addSnippet(p, s) {
				var key = "snip:" + p.source.sessionId + ":" + s.seq;
				if (boardKeys.has(key)) return;
				board[1](board[0].concat([{ key: key, kind: "snippet", text: s.text, title: p.title, role: s.role, time: s.time, tokens: s.tokens }]));
			}

			function undo(op) {
				dialog[1]({
					title: "撤销这次操作？", confirmLabel: "撤销",
					body: h("div", null, h("p", null, op.label), op.backup ? h("div", { className: "csx-muted" }, "备份：", h("code", null, op.backup)) : null,
						h("div", { className: "csx-muted" }, "如果文件在这之后又被改过，为了不覆盖新改动，不会自动撤销。")),
					onConfirm: function () { return act(post("/undo", { opId: op.id })); },
				});
			}

			// ── 脉络图上的操作 ──
			function addSessions(list) {
				var add = list.filter(function (s) { return !boardKeys.has("session:" + s.id); }).map(function (s) {
					var text = mentionOf(s.id, s.title);
					return { key: "session:" + s.id, kind: "session", text: text, title: s.title, time: s.createdAt, tokens: estimate(text) };
				});
				if (add.length) board[1](board[0].concat(add));
				boardOpen[1](true);
				var ws = list[0] && list[0].workspaceId;
				if (ws && !target[0]) target[1](ws);
				notify(add.length ? "已放进拼盘（" + add.length + " 个会话引用），在右边写好任务，点「用它开新会话」" : "这些会话已经在拼盘里了");
			}
			function snippetsOf(s) {
				openSnippets({ kind: "session", title: s.title, source: { sessionId: s.id, workspaceId: s.workspaceId } });
			}
			function showMemory(m) {
				if (m.projectId && m.projectId !== current[0]) current[1](m.projectId);
				kind[1](m.kind === "skill" ? "skill" : "instruction");
				var prefix = m.projectId ? projectTitle(m.projectId) + "/" : "";
				search[1](prefix && m.label.indexOf(prefix) === 0 ? m.label.slice(prefix.length) : m.label);
				onlyFlagged[1](false);
				view[1]("wall");
			}
			function askFork(s) {
				dialog[1]({
					title: "从这个会话分叉？", confirmLabel: "分叉",
					body: h("div", null,
						h("p", { style: { margin: 0 } }, "会在 DSH 里新建一个会话，复制「" + s.title + "」到目前为止的全部历史，之后两边各走各的。", h("b", null, "不会发送任何消息"), "。"),
						h("div", { className: "csx-muted", style: { marginTop: 6 } }, "新会话会出现在脉络图里，作为这条链的一个分支。不想要了可以归档。")),
					onConfirm: function () {
						return Promise.resolve(services.uiWorkspace.forkSession(s.id)).then(function (child) {
							notify("已分叉出新会话");
							setTimeout(reloadGraph, 600);
							if (child) selection[1]({ type: "session", id: String(child) });
						}, function (e) { notify("分叉失败：" + e.message, true); throw e; });
					},
				});
			}
			function askArchiveSession(s) {
				dialog[1]({
					title: "归档这个会话？", danger: true, confirmLabel: "归档",
					body: h("div", null, h("p", null, "「" + s.title + "」会从侧栏的会话列表里收起，日志不会删除，脉络图里仍会显示（灰色）。"), h("div", { className: "csx-muted" }, "会话正在运行时 DSH 会拒绝归档。可在「操作记录」里取消归档。")),
					onConfirm: function () { return act(post("/archive", { project: s.workspaceId, sessionId: s.id, title: s.title })); },
				});
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
						h("p", { style: { margin: 0 } }, "在「" + (target[0] ? projectTitle(target[0]) : "当前 / 最近的工作区") + "」打开空白会话，把拼好的起始上下文（≈" + fmtTok(fresh.tokens || 0) + " tokens）填进输入框。", h("b", null, "不会自动发送"), "，检查后由你按发送。"),
						h("p", { className: "csx-hint" }, "目标项目自己的指令与运行环境仍由 DSH 加载。选中的历史文本作为参考材料加入草稿。"),
						h("div", { className: "csx-muted", style: { margin: "8px 0 4px" } }, "DSH 会复用这个工作区里还没发过消息的空白会话。如果那里已经有未发送的草稿："),
						h("label", { className: "csx-row" }, h("input", { type: "radio", name: "csx-draft", checked: st[0] === "append", onChange: function () { st[1]("append"); } }), "接在后面（保留原有草稿）"),
						h("label", { className: "csx-row" }, h("input", { type: "radio", name: "csx-draft", checked: st[0] === "replace", onChange: function () { st[1]("replace"); } }), "替换掉（原有草稿会丢失）"));
				}
				dialog[1]({
					title: "用所选上下文开新会话", confirmLabel: "打开",
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

			// 过滤
			var q = search[0].trim().toLowerCase();
			var shown = pieces.filter(function (p) {
				if (kind[0] !== "all" && p.kind !== kind[0]) return false;
				if (onlyFlagged[0] && !p.flags.some(function (f) { return f.code !== "archived"; })) return false;
				if (q && (p.text + " " + p.title + " " + p.group).toLowerCase().indexOf(q) < 0) return false;
				return true;
			});
			var groups = [];
			shown.forEach(function (p) {
				var last = groups[groups.length - 1];
				if (last && last.name === p.group) last.items.push(p);
				else groups.push({ name: p.group, items: [p] });
			});
			var counts = { all: pieces.length };
			pieces.forEach(function (p) { counts[p.kind] = (counts[p.kind] || 0) + 1; });
			var flaggedCount = pieces.filter(function (p) { return p.flags.some(function (f) { return f.code !== "archived"; }); }).length;
			var snippetPanel = snippets[0] ? h("div", { className: "csx-piece", style: { "--k": KIND_COLOR.snippet, display: "block" } },
							h("div", { className: "csx-row" },
								h("b", { className: "csx-grow csx-ell" }, "摘录 · " + snippets[0].piece.title),
								h(Btn, { kind: "ghost", onClick: function () { snippetVersion.current++; snippets[1](null); } }, "关闭")),
							snippets[0].list == null ? h("div", { className: "csx-muted" }, "读取中…") :
								snippets[0].error ? h("div", { className: "csx-muted" }, snippets[0].error) :
									!snippets[0].list.length ? h("div", { className: "csx-muted" }, "这个会话还没有消息") :
										snippets[0].list.map(function (s) {
											var key = "snip:" + snippets[0].piece.source.sessionId + ":" + s.seq;
											return h("div", { key: s.seq, className: "csx-snip" },
												h("input", { type: "checkbox", className: "csx-check", checked: boardKeys.has(key), onChange: function () { if (boardKeys.has(key)) board[1](board[0].filter(function (x) { return x.key !== key; })); else addSnippet(snippets[0].piece, s); } }),
												h("div", { className: "csx-grow" },
													h("div", { className: "csx-muted" }, (s.role === "user" ? "用户" : "助手") + " · " + ago(s.time) + " · ≈" + fmtTok(s.tokens) + " tok"),
													h("div", { className: "csx-text" }, s.text)));
										})) : null;
			var pv = preview[0] || { tokens: 0, overFrom: -1 };
			var b = Number(budget[0]) || 0;
			var pct = b ? Math.min(100, (pv.tokens / b) * 100) : 0;

			return h("div", { className: "csx" },
				h("div", { className: "csx-top" },
					h(SidebarIcon, { size: 22 }),
					h("div", { className: "csx-grow" },
						h("h1", { className: "csx-h1" }, "Context Studio"),
						h("div", { className: "csx-muted" }, "追溯上下文 · 核对错误回答 · 带着核对后的信息重新开始")),
					h(Btn, { kind: boardOpen[0] ? "on" : "", title: "展开 / 收起右侧的上下文草稿", onClick: function () { boardOpen[1](!boardOpen[0]); } }, "新会话草稿 · " + board[0].length + (boardOpen[0] ? " ▸" : " ◂")),
					h(Btn, { onClick: function () { reloadProjects(); reloadSessions(); reloadPieces(); reloadJournal(); reloadGraph(); inspectRefresh[1](function (v) { return v + 1; }); } }, "刷新")),
				storageError[0] || prefsError[0] ? h("div", { role: "alert", className: "csx-warning" }, storageError[0] || prefsError[0]) : null,
				boardRecovery[0] ? h("div", { role: "alert", className: "csx-warning" }, "保存的草稿含无效数据，已恢复可读条目；原始数据仍保留，尚未覆盖。", h(Btn, { onClick: function () { navigator.clipboard.writeText(JSON.stringify(initialBoard)).then(function () { notify("已导出原始草稿"); }, function () { notify("无法复制，请保留此页面", true); }); } }, "导出原始草稿"), h(Btn, { onClick: function () { boardRecovery[1](false); } }, "使用恢复后的草稿")) : null,
				h("div", { className: "csx-cols" + (boardOpen[0] ? "" : " noboard") },
					// ── 项目栏
					h("div", { className: "csx-col" },
						h("div", { className: "csx-sec" }, "项目"),
						projectList.map(function (p) {
							return h("button", { key: p.id, type: "button", className: "csx-proj" + (p.id === current[0] ? " on" : ""), title: p.path || "全局指令、用户技能、Dot 记忆", onClick: function () { current[1](p.id); } },
								h("span", { className: "csx-grow csx-ell" }, p.id === "global" ? "◎ 全局" : p.title),
								p.sessionCount ? h("span", { className: "csx-muted" }, p.sessionCount) : null);
						}),
						view[0] === "inspect" ? h("div", null,
							h("div", { className: "csx-sec" }, "会话", h("span", { className: "csx-muted" }, sessions.length)),
							h("input", { className: "csx-input", "aria-label": "筛选会话", placeholder: "查找会话…", value: sessionSearch[0], onChange: function (e) { sessionSearch[1](e.target.value); } }),
							!catalog[0] ? h("p", { className: "csx-hint", role: "status" }, "读取会话目录中…") : catalog[0].error ? h("p", { className: "csx-hint", role: "alert" }, catalog[0].error, h(Btn, { onClick: reloadSessions }, "重试")) : (catalog[0].warnings || []).map(function (w) { return h("p", { className: "csx-hint", key: w }, w); }),
							sessions.filter(function (s) { return s.title.toLowerCase().includes(sessionSearch[0].toLowerCase()); }).map(function (s) { return h("button", { key: s.id, className: "csx-nav-session" + (inspectSession && inspectSession.id === s.id ? " on" : ""), onClick: function () { inspected[1](s.id); } }, h("b", null, s.title), h("small", null, (s.external ? "跨项目 · " : "") + ago(s.createdAt))); })) : null,
						h("div", { className: "csx-sec" }, "操作记录"),
						journal[0].length ? journal[0].slice(0, 30).map(function (op) {
							return h("div", { key: op.id, className: "csx-op" + (op.undone ? " undone" : ""), title: op.label + "\n" + op.at },
								h("span", { className: "csx-grow csx-ell" }, op.label),
								op.undone || op.canUndo === false ? null : h(Btn, { kind: "ghost", onClick: function () { undo(op); } }, "撤销"));
						}) : h("div", { className: "csx-muted" }, "还没有操作")),
					// ── 素材墙
					h("div", { className: "csx-col" },
						h("div", { className: "csx-tabs csx-viewtabs" },
							h(Btn, { kind: view[0] === "inspect" ? "on" : "", onClick: function () { view[1]("inspect"); } }, "回答排查"),
							h(Btn, { kind: view[0] === "graph" ? "on" : "", title: "从会话出发：哪些会话连成链、各自加载了哪些记忆", onClick: function () { view[1]("graph"); } }, "脉络"),
							h(Btn, { kind: view[0] === "wall" ? "on" : "", title: "按文件逐块看指令、技能、会话和 Dot 记忆", onClick: function () { view[1]("wall"); boardOpen[1](true); } }, "素材墙"),
							view[0] === "graph" ? h(Btn, { kind: "ghost", onClick: reloadGraph }, "重新读取") : null),
						view[0] === "inspect" ? h("div", { className: "csx-row csx-session-picker", "aria-label": "会话目录" },
							h("label", { htmlFor: "csx-inspect-session" }, "当前会话"),
							h("select", { id: "csx-inspect-session", className: "csx-input csx-grow", "aria-label": "从目录选择会话",
								value: inspectSession ? inspectSession.id : "", disabled: !sessions.length,
								onChange: function (e) { inspected[1](e.target.value); } },
								!sessions.length ? h("option", { value: "" }, !catalog[0] ? "读取目录中…" : catalog[0].error ? "目录读取失败" : "暂无会话") : null,
								sessions.map(function (s) { return h("option", { key: s.id, value: s.id }, s.title + (s.external ? " · 跨项目" : "")); })),
							h(Btn, { onClick: reloadSessions }, "刷新目录")) : null,
						snippetPanel,
						view[0] === "inspect" ? h(Inspector, { key: inspectSession ? inspectSession.id : "empty", session: inspectSession, refresh: inspectRefresh[0], onRetry: function () { inspectRefresh[1](function (v) { return v + 1; }); }, onAdd: addEvidence, has: function (id, seq) { return board[0].some(function (b) { return b.evidenceSession === id && b.evidenceSeq === seq; }); } }) :
						view[0] === "graph" ? h(Lineage, { graph: graph[0], selection: selection[0], onSelect: selection[1], onAddSessions: addSessions, onSnippets: snippetsOf, onFork: askFork, onArchive: askArchiveSession, onShowMemory: showMemory }) :
						h(React.Fragment, null,
						h("div", { className: "csx-tabs" },
							["all", "instruction", "skill", "session", "dot"].filter(function (k) { return k === "all" || counts[k]; }).map(function (k) {
								return h(Btn, { key: k, kind: kind[0] === k ? "on" : "", onClick: function () { kind[1](k); } }, (k === "all" ? "全部" : KIND_LABEL[k]) + " " + (counts[k] || 0));
							}),
							h(Btn, { kind: onlyFlagged[0] ? "on" : "", title: "只看体检标出的可疑素材", onClick: function () { onlyFlagged[1](!onlyFlagged[0]); } }, "⚠ 可疑 " + flaggedCount),
							h("input", { className: "csx-input", style: { width: 160, marginLeft: "auto" }, placeholder: "搜索…", value: search[0], onChange: function (e) { search[1](e.target.value); } })),
						data[0] && data[0].files && data[0].files.length ? h("div", { className: "csx-muted", style: { marginBottom: 4 } },
							"指令文件：", data[0].files.map(function (f) { return f.path.split(/[\\/]/).slice(-2).join("/") + "（≈" + fmtTok(f.tokens) + "）"; }).join("、")) : null,
						loading[0] && !data[0] ? h("div", { className: "csx-empty" }, "读取中…") : null,
						data[0] && data[0].error ? h("div", { className: "csx-empty" }, "读取失败：" + data[0].error) : null,
						data[0] && !shown.length && !data[0].error ? h("div", { className: "csx-empty" }, pieces.length ? "没有符合筛选的素材" : (current[0] === "global" ? "全局还没有指令、技能或记忆。" : "这个项目还没有 AGENTS.md / CLAUDE.md、技能或会话。")) : null,
						groups.map(function (g) {
							return h("div", { key: g.name },
								h("div", { className: "csx-group" }, g.name),
								g.items.map(function (p) {
									return h(PieceCard, { key: p.id, piece: p, inBoard: boardKeys.has(p.id), onToggle: toggle, onRemove: askRemove, onArchive: askArchive, onSnippets: openSnippets, onTransplant: transplant });
								}));
						}))),
					// ── 拼盘
					h("div", { className: "csx-col" },
						h("div", { className: "csx-eyebrow" }, "03 / START FRESH"),
						h("div", { className: "csx-sec" }, "新会话草稿", h("span", { className: "csx-muted", style: { fontWeight: 400 } }, board[0].length + " 块 · 拖动排序"),
							board[0].length ? h(Btn, { kind: "ghost", onClick: function () { board[1]([]); } }, "清空") : null),
						h(Board, { items: board[0], overFrom: pv.overFrom, onChange: board[1], onAddPiece: addPieceAt }),
						h("div", { className: "csx-row", style: { marginTop: 6 } },
							h("input", { className: "csx-input", placeholder: "加一张便签，或输入 @路径 引用文件", value: extra[0], onChange: function (e) { extra[1](e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") addExtra(); } }),
							h(Btn, { onClick: addExtra }, "加")),
						h("div", { className: "csx-sec" }, "token 预算"),
						h("div", { className: "csx-row" },
							h("span", { className: "csx-grow" }, "≈" + (pv.tokens || 0).toLocaleString() + " / ",
								h("input", { className: "csx-input", type: "number", min: 0, step: 1000, style: { width: 90, display: "inline-block" }, value: budget[0], onChange: function (e) { budget[1](e.target.value); } }), " tokens（估算）")),
						h("div", { className: "csx-bar" + (pv.over ? " over" : "") }, h("i", { style: { width: pct + "%" } })),
						pv.over ? h("div", { className: "csx-muted", style: { color: "var(--red)" } }, pv.overFrom < 0 ? "加上任务和标题后超出预算。可以精简任务或调大预算。" : "超出预算：从第 " + (pv.overFrom + 1) + " 块开始（标红）。可以拿掉几块，或调大预算。") : null,
						h("div", { className: "csx-sec" }, "本次任务（可选）"),
						h("textarea", { className: "csx-input", placeholder: "写在起始上下文末尾，比如：给登录页加记住我", value: task[0], onChange: function (e) { task[1](e.target.value); } }),
						h("div", { className: "csx-sec" }, "目标项目"),
						h("select", { className: "csx-input", value: target[0], onChange: function (e) { target[1](e.target.value); } },
							h("option", { value: "" }, "当前 / 最近的工作区"),
							projectList.filter(function (p) { return p.id !== "global"; }).map(function (p) { return h("option", { key: p.id, value: p.id }, p.title); })),
						h("div", { className: "csx-row", style: { flexWrap: "wrap", marginTop: 10, gap: 6 } },
							h(Btn, { kind: "primary", disabled: !board[0].length, title: "在目标项目开新会话，把拼好的上下文填进输入框（不会自动发送）", onClick: launch }, "▶ 用它开新会话"),
							h(Btn, { disabled: !board[0].length, onClick: function () { showPreview[1](!showPreview[0]); } }, showPreview[0] ? "收起预览" : "预览"),
							h(Btn, { disabled: !board[0].length, onClick: copy }, "复制"),
							h(Btn, { disabled: !board[0].length, title: "把拼盘写进目标项目的 AGENTS.local.md（以后的会话都会加载）", onClick: function () { askWrite(board[0], target[0]); } }, "写入指令…")),
						showPreview[0] && preview[0] ? h("pre", { className: "csx-pre", style: { marginTop: 8 } }, preview[0].text) : null,
						caps[0] && caps[0].sessions === false ? h("div", { className: "csx-muted", style: { marginTop: 8 } }, "当前环境没有会话查询服务，会话素材不可用。") : null)),
				h(Dialog, { dialog: dialog[0], onClose: function () { dialog[1](null); } }),
				toast[0] ? h("div", { className: "csx-toast" + (toast[0].err ? " err" : "") }, toast[0].text) : null);
		}

		// ── 注册 ────────────────────────────────────────────────
		var inject = ["uiWorkspace", "slots", "layout"];

		function apply(ctx) {
			services = ctx;
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
					return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 25, label: function () { return "拼图台"; } }, SidebarIcon);
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
