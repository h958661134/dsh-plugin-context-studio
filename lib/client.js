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
		function getJSON(path) {
			return fetch(API + path, { credentials: "same-origin" }).then(function (r) {
				return r.json().then(function (d) {
					if (!r.ok) throw new Error((d && d.error) || String(r.status));
					return d;
				});
			});
		}
		function post(path, body) {
			return fetch(API + path, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", "x-context-studio": "1" },
				body: JSON.stringify(body),
			}).then(function (r) {
				return r.json().then(function (d) {
					if (!r.ok || (d && d.ok === false)) throw new Error((d && (d.text || d.error)) || String(r.status));
					return d;
				});
			});
		}

		function load(key, fallback) {
			try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
		}
		function save(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 存不了就算了 */ }
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
				Promise.resolve(d.onConfirm()).then(function () { busy[1](false); props.onClose(); }, function () { busy[1](false); });
			}
			return h("div", { className: "csx-mask", onClick: props.onClose },
				h("div", { className: "csx csx-dialog", style: { height: "auto" }, role: "dialog", "aria-modal": true, onClick: function (e) { e.stopPropagation(); } },
					h("h3", null, d.title),
					d.body,
					h("div", { className: "csx-row", style: { justifyContent: "flex-end", gap: 8, marginTop: 4 } },
						h(Btn, { onClick: props.onClose }, "取消"),
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
			var drag = useRef(-1);
			var dropping = useState(false);
			var over = useState(-1);
			function onDrop(e, at) {
				e.preventDefault();
				dropping[1](false); over[1](-1);
				var pieceId = e.dataTransfer.getData("text/x-csx-piece");
				if (pieceId) { props.onAddPiece(pieceId, at); return; }
				var from = drag.current;
				drag.current = -1;
				if (from < 0) return;
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
						onDragStart: function (e) { drag.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); },
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
						title: used ? (m.label + (cur === false ? "：加载的是旧版本（文件后来改过或已删除）" : cur === null ? "" : "：当前版本")) : "",
						onClick: function (e) { e.stopPropagation(); props.onSelect({ type: "memory", id: m.key }); },
					}, used ? h("span", { className: "csx-dot" + (cur === false ? " old" : "") }) : null);
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
							(s.external ? s.project + " · " : "") + ago(s.lastTime) + (s.turns ? " · " + s.turns + " 轮" : " · 空白"),
							s.studio ? " · ◆拼图台起始" : "", s.seeded ? " · 分叉" : "", s.origin === "subagent" ? " · 子代理" : "", s.archived ? " · 已归档" : "")),
					cellsFor(s, rowIdx, span));
			}

			var sum = g.summary;
			return h("div", { className: "csx-lineage" },
				h("div", { className: "csx-sumbar" },
					h("span", null, h("b", null, sum.chains), " 条链路（", sum.chainSessions, " 个会话）"),
					h("span", null, h("b", null, sum.singles), " 个独立会话"),
					h("span", { className: "csx-muted" }, "记忆："),
					["shared", "chain", "single", "unused"].map(function (k) {
						return h("span", { key: k, className: "csx-chip", title: CLS_INFO[k].text, style: { color: CLS_INFO[k].color } }, CLS_INFO[k].label + " " + sum[k]);
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
								title: m.label + "\n" + info.label + "：" + info.text + (m.uses.length ? "\n" + m.uses.length + " 个会话用过" : "") + (m.transplants.length ? "\n含 " + m.transplants.length + " 块拼入的内容" : "") + (m.exists ? "" : "\n文件已经不在了"),
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
							h("b", null, "独立会话"),
							h("span", { className: "csx-muted" }, "没有引用别的会话，也没有被引用或分叉")),
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
						!m.exists ? " 文件已经不在了。" : ""),
					m.transplants.length ? h("div", { className: "csx-muted" }, "含 " + m.transplants.length + " 块拼入的内容：来自 " + Array.from(new Set(m.transplants)).join("、")) : null,
					m.uses.length ? h("div", { className: "csx-sec" }, "用过它的会话") : null,
					m.uses.map(function (u) {
						var s = props.sessionById[u.sessionId];
						if (!s) return null;
						return h("div", { key: u.sessionId, className: "csx-op", style: { cursor: "pointer" }, onClick: function () { props.onSelect({ type: "session", id: s.id }); } },
							h("span", { className: "csx-grow csx-ell" }, s.title), h("span", { className: "csx-muted" }, u.current === false ? "旧版本" : "当前版本"));
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
					h(Btn, { kind: "ghost", onClick: function () { props.onSelect(null); } }, "关闭")),
				h("div", { className: "csx-muted" }, (s.project ? s.project + " · " : "") + new Date(s.createdAt).toLocaleString() + " · " + (s.turns ? s.turns + " 轮对话" : "还没发过消息"),
					s.studio ? " · 由拼图台的起始上下文开启" : "", s.archived ? " · 已归档" : ""),
				chain ? h("div", { style: { marginTop: 4 } },
					ups.length ? h("div", null, "来自：", ups.map(function (e, i) { return h("span", { key: e.from }, i ? "、" : "", EDGE_INFO[e.kind] + " ", link(e.from, "u")); })) : h("div", { className: "csx-muted" }, "这条链的起点"),
					downs.length ? h("div", null, "延伸出：", downs.map(function (e, i) { return h("span", { key: e.to }, i ? "、" : "", EDGE_INFO[e.kind] + " ", link(e.to, "d")); })) : null)
					: h("div", { className: "csx-muted", style: { marginTop: 4 } }, "独立会话：没有引用别的会话，也没被引用或分叉。"),
				h("div", { className: "csx-sec" }, "它加载过的记忆 " + mine.length),
				mine.length ? h("div", { className: "csx-row", style: { flexWrap: "wrap", gap: 4 } }, mine.map(function (x) {
					return h("span", { key: x.m.key, className: "csx-chip" + (x.current === false ? " warn" : ""), style: { cursor: "pointer" }, title: x.current === false ? "加载的是旧版本" : "", onClick: function () { props.onSelect({ type: "memory", id: x.m.key }); } }, (x.m.kind === "skill" ? "⚙ " : "") + x.m.label + (x.current === false ? "（旧）" : ""));
				})) : h("div", { className: "csx-muted" }, s.turns ? "日志里没有记录加载指令文件" : "还没开始对话，DSH 会在第一次请求时加载"),
				h("div", { className: "csx-row", style: { marginTop: 10, gap: 6, flexWrap: "wrap" } },
					h(Btn, { kind: "primary", title: "把这个会话作为引用放进拼盘，再用拼盘开新会话", onClick: function () { props.onAddSessions([s]); } }, "接着它开新会话"),
					h(Btn, { title: "挑几段消息摘进拼盘", onClick: function () { props.onSnippets(s); } }, "摘录"),
					h(Btn, { onClick: function () { if (services) services.uiWorkspace.openSession(s.id); } }, "打开"),
					services && services.uiWorkspace && typeof services.uiWorkspace.forkSession === "function" && s.turns ? h(Btn, { title: "在 DSH 里从这里分叉一个新会话（复制到目前为止的历史）", onClick: function () { props.onFork(s); } }, "分叉") : null,
					!s.archived ? h(Btn, { kind: "danger", title: "归档（可撤销）", onClick: function () { props.onArchive(s); } }, "归档") : null));
		}

		// ── 整页 ────────────────────────────────────────────────
		function StudioPage() {
			var prefs0 = load(LS_PREFS, {});
			var projects = useState(null);
			var caps = useState({});
			var current = useState(prefs0.project || "global");
			var data = useState(null);
			var loading = useState(false);
			var kind = useState("all");
			var search = useState("");
			var onlyFlagged = useState(false);
			var board = useState(load(LS_BOARD, []));
			var target = useState(prefs0.target || "");
			var budget = useState(prefs0.budget || 8000);
			var task = useState("");
			var preview = useState(null);
			var showPreview = useState(false);
			var journal = useState([]);
			var dialog = useState(null);
			var toast = useState(null);
			var snippets = useState(null); // { piece, list }
			var extra = useState("");
			var view = useState(prefs0.view || "graph");
			var graph = useState(null);
			var selection = useState(null);
			var boardOpen = useState((prefs0.view || "graph") !== "graph");
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
				loading[1](true);
				return getJSON("/pieces?project=" + encodeURIComponent(current[0]))
					.then(function (d) { data[1](d); })
					.catch(function (e) { data[1]({ pieces: [], files: [], error: e.message }); })
					.then(function () { loading[1](false); });
			}
			function reloadJournal() { return getJSON("/journal").then(function (d) { journal[1](d.ops || []); }).catch(function () {}); }
			function reloadGraph() {
				var at = current[0];
				return getJSON("/graph?project=" + encodeURIComponent(at))
					.then(function (d) { if (at === current[0]) graph[1](d); })
					.catch(function (e) { graph[1]({ error: e.message }); });
			}

			useEffect(function () { reloadProjects(); reloadJournal(); }, []);
			useEffect(function () { snippets[1](null); reloadPieces(); }, [current[0]]);
			useEffect(function () { graph[1](null); selection[1](null); reloadGraph(); }, [current[0]]);
			useEffect(function () { save(LS_BOARD, board[0]); }, [board[0]]);
			useEffect(function () { save(LS_PREFS, { project: current[0], target: target[0], budget: budget[0], view: view[0] }); }, [current[0], target[0], budget[0], view[0]]);
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
			var pieces = (data[0] && data[0].pieces) || [];
			var boardKeys = useMemo(function () { var s = new Set(); board[0].forEach(function (b) { s.add(b.key); }); return s; }, [board[0]]);

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
				snippets[1]({ piece: p, list: null });
				getJSON("/session?id=" + encodeURIComponent(p.source.sessionId))
					.then(function (d) { snippets[1]({ piece: p, list: d.snippets }); })
					.catch(function (e) { snippets[1]({ piece: p, list: [], error: e.message }); });
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
				if (ws) target[1](ws);
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

			function launch() {
				var text = preview[0] && preview[0].text;
				if (!text || !board[0].length) { notify("拼盘是空的", true); return; }
				if (!services || !services.uiWorkspace || typeof services.uiWorkspace.startSession !== "function") {
					copy(); notify("这个版本的 DSH 不支持预填草稿，已复制到剪贴板", true); return;
				}
				var mode = { value: "append" };
				function Body() {
					var st = useState("append");
					mode.value = st[0];
					return h("div", null,
						h("p", { style: { margin: 0 } }, "在「" + (target[0] ? projectTitle(target[0]) : "当前 / 最近的工作区") + "」打开空白会话，把拼好的起始上下文（≈" + fmtTok(preview[0].tokens || 0) + " tokens）填进输入框。", h("b", null, "不会自动发送"), "，检查后由你按发送。"),
						h("div", { className: "csx-muted", style: { margin: "8px 0 4px" } }, "DSH 会复用这个工作区里还没发过消息的空白会话。如果那里已经有未发送的草稿："),
						h("label", { className: "csx-row" }, h("input", { type: "radio", name: "csx-draft", checked: st[0] === "append", onChange: function () { st[1]("append"); } }), "接在后面（保留原有草稿）"),
						h("label", { className: "csx-row" }, h("input", { type: "radio", name: "csx-draft", checked: st[0] === "replace", onChange: function () { st[1]("replace"); } }), "替换掉（原有草稿会丢失）"));
				}
				dialog[1]({
					title: "用拼盘开新会话", confirmLabel: "打开",
					body: h(Body),
					onConfirm: function () {
						try {
							services.uiWorkspace.startSession(target[0] && target[0] !== "global" ? target[0] : undefined, { prompt: text, whenDraftExists: mode.value });
							notify("已打开会话并填好草稿，检查后按发送即可");
						} catch (e) { notify("打开新会话失败：" + e.message, true); throw e; }
					},
				});
			}
			function copy() {
				var text = preview[0] && preview[0].text;
				if (!text) return;
				(navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard")))
					.then(function () { notify("已复制"); }, function () { notify("复制失败，请从预览里手动复制", true); });
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
								h(Btn, { kind: "ghost", onClick: function () { snippets[1](null); } }, "关闭")),
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
						h("h1", { className: "csx-h1" }, "上下文拼图台"),
						h("div", { className: "csx-muted" }, "看见每个项目里会进入模型上下文的东西 · 清理过时的 · 跨项目拼接 · 拼成起始上下文开新会话")),
					h(Btn, { kind: boardOpen[0] ? "on" : "", title: "展开 / 收起右侧的拼盘", onClick: function () { boardOpen[1](!boardOpen[0]); } }, "拼盘 " + board[0].length + (boardOpen[0] ? " ▸" : " ◂")),
					h(Btn, { onClick: function () { reloadProjects(); reloadPieces(); reloadJournal(); reloadGraph(); } }, "刷新")),
				h("div", { className: "csx-cols" + (boardOpen[0] ? "" : " noboard") },
					// ── 项目栏
					h("div", { className: "csx-col" },
						h("div", { className: "csx-sec" }, "项目"),
						projectList.map(function (p) {
							return h("button", { key: p.id, type: "button", className: "csx-proj" + (p.id === current[0] ? " on" : ""), title: p.path || "全局指令、用户技能、Dot 记忆", onClick: function () { current[1](p.id); } },
								h("span", { className: "csx-grow csx-ell" }, p.id === "global" ? "◎ 全局" : p.title),
								p.sessionCount ? h("span", { className: "csx-muted" }, p.sessionCount) : null);
						}),
						h("div", { className: "csx-sec" }, "操作记录"),
						journal[0].length ? journal[0].slice(0, 30).map(function (op) {
							return h("div", { key: op.id, className: "csx-op" + (op.undone ? " undone" : ""), title: op.label + "\n" + op.at },
								h("span", { className: "csx-grow csx-ell" }, op.label),
								op.undone ? null : h(Btn, { kind: "ghost", onClick: function () { undo(op); } }, "撤销"));
						}) : h("div", { className: "csx-muted" }, "还没有操作")),
					// ── 素材墙
					h("div", { className: "csx-col" },
						h("div", { className: "csx-tabs csx-viewtabs" },
							h(Btn, { kind: view[0] === "graph" ? "on" : "", title: "从会话出发：哪些会话连成链、各自加载了哪些记忆", onClick: function () { view[1]("graph"); } }, "脉络"),
							h(Btn, { kind: view[0] === "wall" ? "on" : "", title: "按文件逐块看指令、技能、会话和 Dot 记忆", onClick: function () { view[1]("wall"); boardOpen[1](true); } }, "素材墙"),
							view[0] === "graph" ? h(Btn, { kind: "ghost", onClick: reloadGraph }, "重新读取") : null),
						snippetPanel,
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
						h("div", { className: "csx-sec" }, "拼盘", h("span", { className: "csx-muted", style: { fontWeight: 400 } }, board[0].length + " 块 · 拖动排序"),
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
						pv.over ? h("div", { className: "csx-muted", style: { color: "var(--red)" } }, "超出预算：从第 " + (pv.overFrom + 1) + " 块开始（标红）。可以拿掉几块，或调大预算。") : null,
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
