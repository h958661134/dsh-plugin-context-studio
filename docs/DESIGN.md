# 上下文拼图台 · Context Studio —— 设计文档

> 状态：v0.1 已实现（见「v0.1 落地范围」与「实测记录」）。本文先写理想形态，再写这一版真正落地的部分。
> 所有 DSH 接口都已在源码（`fcc0ad46`，2026-11-04）和安装版运行时（desktop `0.2.2-rc.1`）里核对过，出处见第 3 节。

---

## 1. 问题

用 DSH 久了，一个项目会慢慢攒下很多「给 agent 看的东西」：`AGENTS.md` 里一条条约定、`.agents/skills` 里的技能、几十个会话的历史。问题有三个：

1. **看不见、删不掉**：哪些约定已经过时（指向早就删掉的目录、和全局指令重复、半年没人动过）？现在只能打开文件逐行看，删错了也没有后悔药。
2. **复用难**：B 项目想要 A 项目「部署那一节」或「某次排查的结论」，只能手动复制粘贴，来源也丢了。
3. **开工慢**：开一个新会话前，要把「这次需要的约定 + 相关会话 + 关键文件」拼成一段起始上下文，全靠手工，也不知道占了多少 token。

拼图台把这些都做成一块可视化的画板：**按项目看素材 → 标出可疑的 → 一键移除（可撤销）→ 跨项目挑一块拼过去 → 拼成起始上下文 → 开新会话**。

## 2. 核心理念

- **素材即拼图块**：DSH 里一切「会进入模型上下文」的东西，都拆成带来源、新旧、token 的小块。
- **看见先于动手**：插件主动标出「疑似过时」，但从不自动删。
- **一切写入可回滚**：任何改动先备份、记日志、可撤销；冲突时宁可拒绝也不覆盖用户的新改动。
- **拼好的东西交给用户发出**：新会话只预填草稿，由用户自己按发送。插件不替用户调用模型。
- **只用 DSH 原生机制**：指令文件仍由 DSH 的 `agent-instructions` 加载，会话引用仍走 DSH 的 `dsh-session:` 提及，插件不自建一套注入通道。

## 3. 素材盘点（以源码为准）

DSH 本身**没有**名为 memory 的一等存储（全仓 `memories` / `MEMORY.md` 搜不到）。和「memory」对应的、真正会进入模型上下文的东西如下：

| 素材 | 在哪 | 谁加载 / 怎么进上下文 | 源码出处 | v0.1 |
|---|---|---|---|---|
| **全局指令** | `$DSH_HOME/AGENTS.md`、`$DSH_AGENTS_HOME`（默认 `~/.agents`）`/AGENTS.md` | `dsh-agent-instructions` 首次请求时作为基线消息注入 | `packages/context/agent-instructions/README.zh.md`「agent 获得的内容」 | 看 / 移除 / 拼接 |
| **项目指令** | 项目根（最近的含 `.git` 的祖先）到会话 cwd 每一级目录下的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md` | 同上，从宽到窄 | 同上「配置」表 | 看 / 移除 / 拼接 / 写入 |
| **子目录指令** | 工作区下更深目录里的同名文件 | agent 用 read/write/edit 触达该目录后增量注入 | 同上「主要流程」 | 看 / 移除 / 拼接 |
| **技能** | `<root>/.dsh/skills`、`<root>/.agents/skills`、`$DSH_HOME/skills`、`<agentsHome>/skills`；`<name>/SKILL.md` 或 `<name>.md` | `dsh-skill-filesystem` 扫描、按需加载正文 | `packages/skill/skill-filesystem/README.zh.md`「根目录与优先级」 | 看 / 拼接（引用） |
| **会话** | 会话日志；工作区的 `sessionIds` | `ctx.sessionQuery.listSessions / readTitleSnapshots / filterEvents`；引用时用 `@[标题](dsh-session:<base64url(JSON(id))>)`，由 `dsh-session-reference` 展开为有界快照 | `packages/session-query/session-query/src/index.ts`；`packages/context/session-reference/src/uri.ts`；`packages/bundle/web-app/cordis.patch.yml` 默认挂载 session-reference | 看 / 归档（可撤销）/ 引用 |
| **会话片段** | 会话里的 `user/message`、`assistant/message` | 同上 `filterEvents(id, [{kind:'type',values:[...]}])` | `packages/core/session/src/types.ts` `SessionEventMap` | 看 / 摘入拼盘 |
| **项目文件** | 工作区内任意文件 | `@path` 提及（`dsh-file-reference`），模型需要时自己去读 | `packages/context/file-reference/README.zh.md`「mention 语法」 | 以 `@path` 拼入 |
| **Dot 记忆**（第三方） | `$DSH_HOME/dot/state.json` 的 `memories` | 由 dsh-plugin-dot 自己注入 | dsh-plugin-dot | 只读查看 / 拼入 |
| 系统提示片段（persona、time-context 等） | preset 配置 | 预设自身 | `packages/preset/persona` | 不做（见第 7 节） |

宿主侧会用到的服务（都在源码里确认过签名）：

- `ctx.workspaceRegistry.list()` → `Workspace{ id, path, title, sessionIds }`；`archiveSession(id)` / `unarchiveSession(id)` / `archivedSessionIds`（`packages/workspace/workspace/src/index.ts`）。
- `ctx.sessionQuery.listSessions()` → `SessionRecord{ header{ id, createdAt, cwd, parentSession, origin, agentPreset } }`；`readTitleSnapshots(ids)`；`filterEvents(id, filters)` → `{ seq, type, time, text }[]`。
- `ctx.webServer.register({ kind:'exact', path, handler })`、`webServer.getOrigin()`（参照 Dot 的用法）。

浏览器侧：

- `ctx.uiWorkspace.startSession(workspaceId, { prompt, whenDraftExists })`：打开工作区的空白会话并预填草稿（`packages/client/ui-workspace/src/client/navigation.ts`，`DraftInitializationOptions` 在 `ui-conversation/src/client/contract/input.ts`）。安装版 `app.asar` 里能搜到 `whenDraftExists`。
- `ctx.slots.inject/register('main' | 'sidebar.panellist')`、`ctx.layout.selectPanel`（参照 Dot 的 bridge）。

## 4. 理想形态（大胆版）

### 4.1 画板

```
┌ 项目栏 ─────┐┌ 素材墙（当前项目） ─────────────────────────┐┌ 拼盘 ──────────────────┐
│ ◉ 全局       ││ [全部][指令][技能][会话][Dot]  🔍  只看可疑 ☐ ││ 目标项目：webapp ▾     │
│ ○ webapp  12 ││ ── AGENTS.md › 构建 ───────────────── 3天前 ││ ① 构建约定   120 tok ≡ │
│ ○ api     5⚠ ││ ▢ 用 pnpm，不要用 npm         42 tok  [⋯]    ││ ② 部署一节   340 tok ≡ │
│ ○ docs       ││ ▢ 输出放 dist-old/  ⚠路径不存在 18 tok  [⋯]   ││ ③ @会话 修登录bug      │
│              ││ ── 会话 ──────────────────────────────       ││ ─────────────────────  │
│ 最近操作      ││ ▢ 修登录 bug        2 个月前  ⚠很久没动       ││ ████████░░ 1.2k / 8k   │
│ ↶ 移除 1 条   ││ ── 技能 ──────────────────────────────       ││ [预览] [复制] [写入…]  │
└─────────────┘└──────────────────────────────────────────────┘│ [▶ 用它开新会话]       │
                                                                 └────────────────────────┘
```

- **按项目分组**，项目旁显示素材数和可疑数。
- **每块拼图**带：类型色条、来源（文件 › 标题路径 / 会话标题）、新旧（文件 mtime 或会话时间，相对时间 + 颜色渐变）、token 估算、可疑标记。
- **操作**：勾选加入拼盘、拖动排序、移除（确认 + 可撤销）、复制到别的项目、展开看全文。
- **拼盘**：拖放排序、token 预算条（超预算变红并提示从哪块开始被截）、实时预览最终文本。
- **出口**：复制文本 / 写入目标项目的指令文件（带来源标记）/ 预填草稿开新会话 / 存为「配方」以后一键复用。

### 4.2 可疑度体检（只标不删）

| 信号 | 判定 |
|---|---|
| 路径失效 | 块里用反引号写的相对路径（如 `` `src/old/` ``）在项目里已不存在 |
| 重复 | 同一段文字（归一化空白后）在全局和项目、或多级目录里各出现一次 |
| 陈旧 | 所在文件 / 会话超过 90 天没变 |
| 被遮蔽 | `CLAUDE.md` 和同目录 `AGENTS.md` 内容一致——DSH 只会加载一份 |
| 超预算 | 整条指令链超过 `maxBytes`（默认 65536）会被 DSH 截断 |

### 4.3 远景（不在 v0.1）

- **配方**：保存拼盘为命名配方，按项目/任务类型推荐。
- **语义体检**：调用模型判断「这条约定和代码是否还一致」（需用户确认花 token）。
- **差异合并**：两个项目各有一版相同小节时做三方合并。
- **会话精华提炼**：选中一段会话，让模型提炼成一条约定再拼入（草稿 → 用户确认）。
- **真分词器**：接 DeepSeek tokenizer 给精确 token 数。
- **技能移植**：把技能目录整个复制到目标项目 `.agents/skills`（不覆盖同名）。

## 5. 安全边界

| 做 | 不做 |
|---|---|
| 读 DSH 已知会加载的位置（指令候选文件、技能根、会话、Dot 状态） | 不读任意路径；客户端传来的路径一律不信，服务端按「项目 + 素材 id」重新扫描定位 |
| 用户点「移除」并在确认框里再点一次，才改文件 | 不自动删、不批量静默删 |
| 改文件前把原文件完整备份到 `$DSH_HOME/context-studio/backups/<opId>/`，日志写入 `journal.json` | 不物理删除任何文件；会话只「归档」不删除 |
| 撤销时先比对文件当前哈希；被别人改过就拒绝并给出备份路径 | 不覆盖用户在这之后的改动 |
| 移除前核对文件哈希与扫描时一致，否则要求刷新 | 不在过期视图上改文件 |
| 写入只允许追加到目标项目根的 `AGENTS.local.md`（默认，通常不进版本库）或 `AGENTS.md`，用 `<!-- context-studio:begin … -->` 包起来、带来源 | 不改别处、不改 Dot 的数据、不改 preset |
| 开新会话只预填草稿 | 不自动发送、不调用模型、不碰 API key |
| 接口只接受本机同源请求，写操作要求 `X-Context-Studio: 1` 头 + JSON | 不对外暴露 |

原子写：先写同目录临时文件再 `rename`，保留原换行风格（CRLF/LF）和末尾换行。

## 6. v0.1 落地范围

| 能力 | 状态 |
|---|---|
| 项目列表（全局 + 每个工作区），素材数、可疑数 | ✅ |
| 指令文件拆块（按标题分节，节内按顶层列表项 / 段落 / 代码块拆块），带行号、token、mtime | ✅ |
| 子目录指令（深度 ≤ 3，跳过 `node_modules`、`.git` 等） | ✅ |
| 技能列表（frontmatter 的 name/description） | ✅ |
| 会话列表（标题、时间、是否归档）+ 展开看消息片段 | ✅ |
| Dot 记忆只读 | ✅ |
| 可疑体检：路径失效、重复、陈旧、被遮蔽 | ✅ |
| 移除指令块（确认 + 备份 + 撤销 + 冲突检测） | ✅ |
| 归档会话（确认 + 撤销 = 取消归档） | ✅ |
| 拼盘：勾选、拖动排序、删除、token 预算条、预览 | ✅ |
| 写入目标项目 `AGENTS.local.md` / `AGENTS.md`（确认 + 备份 + 撤销） | ✅ |
| 用拼盘预填草稿开新会话（目标工作区） | ✅ |
| 复制拼好的文本 | ✅ |
| 操作记录 + 撤销 | ✅ |
| 配方、语义体检、技能移植、真分词器 | ⏳ 路线图 |

token 估算：DeepSeek 官方给的经验值——1 个中文字符约 0.6 token，1 个英文字符约 0.3 token；其他字符按 0.5 计。界面标注「估算」。

### 拼好的起始上下文长什么样

```markdown
<!-- 由「上下文拼图台」拼装：4 块，约 1,180 tokens（估算） -->
# 起始上下文

## 约定 · 来自 api / AGENTS.md › 部署
- 部署前先跑 `pnpm build`，产物在 `dist/`。

## 参考会话
- @[修登录 bug](dsh-session:Ij...In0)

## 会话摘录 · 修登录 bug（2026-10-02）
> 原因是 cookie 的 SameSite……

## 相关文件
- @src/auth/login.ts

---
（在这里写本次任务）
```

会话引用用 DSH 原生的 `dsh-session:` 提及，发送后由 `dsh-session-reference` 展开为有界只读快照；文件用 `@path` 提及，模型需要时自己读。

## 7. 明确不做

- **改系统提示 / preset**：那是 profile 配置，改错影响所有会话；只在文档里说明去哪改。
- **删除会话日志**：只归档。
- **改 Dot 的记忆**：属于另一个插件的数据，只读。
- **fork 会话**：只对客户端 RPC 开放，插件拿不到，且 fork 会带上整段历史，和「挑局部」的目标相反。

## 8. 架构

```
浏览器（lib/client.js，手写 DSH client 模块）
  左栏入口「拼图台」+ 主区整页
  ├─ GET  /api/dsh-plugin-context-studio/projects
  ├─ GET  /api/dsh-plugin-context-studio/pieces?project=
  ├─ GET  /api/dsh-plugin-context-studio/session?id=
  ├─ POST /api/dsh-plugin-context-studio/remove     { project, pieceId, fileHash }
  ├─ POST /api/dsh-plugin-context-studio/archive    { sessionId }
  ├─ POST /api/dsh-plugin-context-studio/compose    { items, budget }
  ├─ POST /api/dsh-plugin-context-studio/write      { project, file, items }
  ├─ POST /api/dsh-plugin-context-studio/undo       { opId }
  ├─ GET  /api/dsh-plugin-context-studio/journal
  └─ ctx.uiWorkspace.startSession(workspaceId, { prompt })   ← 开新会话

Host（lib/host.js，全局 Cordis 插件，inject: webServer）
  ├─ scan.js      项目 → 素材（指令 / 技能 / 会话 / Dot）+ 体检
  ├─ markdown.js  指令文件拆块
  ├─ ops.js       移除 / 写入 / 归档 / 撤销；备份与日志
  ├─ compose.js   拼盘渲染 + 预算
  ├─ tokens.js    token 估算
  └─ guard.js     本机同源校验
数据：$DSH_HOME/context-studio/{journal.json, backups/}
```

## 9. 实测记录（v0.1，2026-11-11）

环境：桌面版 DSH `0.2.2-rc.1` 自带运行时；网页版 profile；隔离的 `DSH_HOME`（放在临时目录）；端口 4001；**没有配置 API key**。
安装：`dsh plugin --profile web add <插件目录>`，然后重启。演示用两个 git 项目：`shop-web` 和 `shop-api`。

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 左侧栏出现「拼图台」，点开整页 | ✅ 三栏都正常渲染，项目列表里有全局和 3 个工作区 |
| 2 | 看 shop-web 的素材 | ✅ 7 块指令 + 1 个技能 + 1 个会话。体检标出 3 处：「回答用中文」和 `$DSH_HOME/AGENTS.md` 重复；`legacy-dist/`、`config/webpack.old.js` 路径失效 |
| 3 | 移除 `legacy-dist/` 那条 → 确认 | ✅ 文件里正好少了这一行，备份写到 `context-studio/backups/<opId>/AGENTS.md`，操作记录多了一条 |
| 4 | 在操作记录里撤销 | ✅ 文件恢复到移除前的样子（逐字节一致），记录显示为已撤销。之后再移除一次，继续后面的步骤 |
| 5 | 切到 shop-api，勾选「部署」两条 + 「数据库」一条，加 `@src/auth/login.ts` 和一句任务，目标选 shop-web | ✅ 拼盘里有 4 块；预览把同一节的相邻块合并到一个标题下，约 115 tokens |
| 6 | 写入指令 → shop-web / `AGENTS.local.md` | ✅ 新建了文件，内容用 `context-studio:begin/end` 标记包起来并写明 `from="shop-api"`；回到 shop-web，能看到这一块带「拼入」标签 |
| 7 | ▶ 用它开新会话 | ✅ 打开 shop-web 的空白会话，输入框里填好了拼好的起始上下文，**没有发送** |
| 8 | 归档会话 → 撤销（通过接口） | ✅ `workspace.json` 的 `archivedSessionIds` 先加上这个会话，撤销后又移除 |
| 9 | 会话摘录 | ✅ 接口能用；演示会话没发过消息，返回空列表（没有 API key，所以没有对话内容） |
| 10 | 跨站请求（带 `Origin: http://evil.com`） | ✅ 返回 403 `cross-origin` |

实测中发现并修复的问题：

- **连续两次「开新会话」会让草稿叠在一起。** DSH 会复用工作区里还没发过消息的空白会话，第一版用的是 `whenDraftExists: 'append'`。现在改成先弹确认框，让用户选「接在后面（默认）」还是「替换」。复测后，选「替换」时草稿里只剩一份。
- 全局文件原来显示成很长的绝对路径，现在显示为 `$DSH_HOME/AGENTS.md`；「重复」标记也改成指向这个短名。
- 拼入的块原来直接显示 HTML 注释标记，现在只显示正文，并加上「拼入 · 来自 X · 日期」标签。
- 操作记录里的「写入」原来显示绝对路径，现在显示「项目名/文件名（来自 X）」。

已知限制：

- 网页版里点「添加工作区」会在宿主机上弹出原生文件夹选择框。实测时没有通过它添加工作区，而是在 DSH 停止时直接往隔离目录的 `storages/workspace.json` 里写入了两个工作区记录。这是实测环境的准备步骤，和插件无关。
- 会话摘录需要会话里真的有对话。本次没有 API key，只用单元测试和假的 `sessionQuery` 覆盖了这部分（会过滤掉 `<system-reminder>` 注入的消息和空消息）。

单元测试：`npm test`，41 个用例全部通过。覆盖拆块、删块、追加、token 估算、扫描与体检、会话、备份与撤销、冲突检测、并发串行、日志损坏恢复、拼盘渲染、请求校验，以及一次挂到真实 HTTP 服务上的端到端流程。
