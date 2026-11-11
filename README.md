<div align="center">

# 上下文拼图台 · Context Studio

**看见每个项目里会进入模型上下文的东西：清掉过时的，把别的项目里有用的拼过来，再拼成一份起始上下文去开新会话。**

[![version](https://img.shields.io/badge/version-0.1.0-4f6bed)](CHANGELOG.md)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.0--rc.0%20%3C0.3.0-1f2937)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-42%20passing-22c55e)](tests)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/images/studio.png" alt="上下文拼图台：左边是项目列表和操作记录，中间是当前项目的素材墙（每块指令都有来源、新旧、token 和体检标记），右边是拼盘、token 预算和拼好的起始上下文预览" width="100%">

</div>

## 为什么要有拼图台

用 DeepSeek Harness 久了，每个项目都会攒下一堆「给 agent 看的东西」：`AGENTS.md` 里一条条约定、`.agents/skills` 里的技能、几十个历史会话。问题随之而来：

- **看不见，也不敢删。** 哪条约定还指向早已删掉的目录？哪条和全局指令重复？要逐行翻文件，删错了也找不回来。
- **复用靠复制粘贴。** B 项目想要 A 项目「部署」那一节，只能手动粘过去，来源也丢了。
- **开工前手工拼上下文。** 新会话要带哪些约定、参考哪次会话、看哪些文件，全凭记忆拼，也不知道占了多少 token。

拼图台把这些都摊成一张画板：**看见 → 体检 → 移除（可撤销）→ 跨项目拼接 → 拼成起始上下文 → 开新会话**。

## 核心理念

| | |
|---|---|
| 🧩 **素材即拼图块** | 指令文件按小节、列表项拆成一块块，每块都标出来源文件和行号、改动时间、token 估算。 |
| 🔍 **只标不删** | 体检会标出路径失效、和别处重复、很久没改、被同名文件遮蔽的块。删不删由你决定。 |
| ↶ **改动都能撤销** | 动文件前先整份备份；撤销时如果文件之后又被改过，就拒绝撤销，不覆盖你的新改动。 |
| ✋ **你按了才算数** | 移除、归档、写入都要在确认框里再点一次。开新会话只帮你填好草稿，发送要你自己按。 |
| 🔌 **只用 DSH 原生机制** | 写进去的约定由 DSH 自己的 `agent-instructions` 加载，会话引用用 DSH 原生的 `dsh-session:` 提及。插件不另建注入通道。 |

## 快速开始

**要求**：DeepSeek Harness `0.2.x`（桌面版或网页版），Node.js ≥ 22。

```bash
# 1. 拿到插件
git clone <本仓库地址> dsh-plugin-context-studio

# 2. 装进 DSH 的 web profile（参数会转给 pnpm）
dsh plugin --profile web add ./dsh-plugin-context-studio

# 3. 重启 DSH
```

重启后，左侧栏会多出 **「拼图台」** 入口。

> 建议先用一个隔离的 `DSH_HOME` 起一个网页版试用：
> `DSH_HOME=/tmp/dsh-try dsh --profile web --no-open --port 4001`

## 界面一览

### 素材墙：看见每一块

左边选项目（「全局」或任意工作区），中间按文件和小节列出所有素材。

| 类型 | 来自哪里 | 能做什么 |
|---|---|---|
| **指令** | 项目根到工作区每一级的 `AGENTS.md` / `CLAUDE.md` / `*.local.md`，子目录里的同名文件；全局的 `$DSH_HOME/AGENTS.md`、`~/.agents/AGENTS.md` | 看、移除、拼到别的项目、放进拼盘 |
| **技能** | `.dsh/skills`、`.agents/skills`，以及全局的技能目录 | 看、放进拼盘 |
| **会话** | 工作区里的会话（跳过子代理） | 看消息、挑摘录、归档、以 `@会话` 形式放进拼盘 |
| **Dot 记忆** | 装了 [Dot 总管](https://github.com/h958661134/dsh-plugin-dot) 时，在「全局」里只读显示 | 放进拼盘 |

点 **⚠ 可疑** 只看体检标出来的块：

<img src="docs/images/flagged.png" alt="只看可疑：一条和 $DSH_HOME/AGENTS.md 重复，一条提到的 config/webpack.old.js 不存在，一块从 shop-api 拼过来的约定提到的 migrations 目录在本项目不存在" width="100%">

| 标记 | 含义 |
|---|---|
| 路径失效 | 块里用反引号写的路径（如 `` `config/webpack.old.js` ``）在项目里找不到 |
| 重复 | 同样的话在全局指令、同目录 `CLAUDE.md` 或其他层级里已经有了 |
| 陈旧 | 所在文件超过 90 天没改（可配置） |
| 被遮蔽 | `CLAUDE.md` 和同目录 `AGENTS.md` 内容一样，DSH 只会加载一份 |

从别的项目拼过来的块会带「拼入 · 来自 shop-api · 日期」标签。它在新项目里如果提到不存在的路径，同样会被标出来，提醒你核对。

### 移除：先确认，可撤销

<img src="docs/images/remove-dialog.png" alt="移除确认框：显示文件路径和行号、这一块的原文、体检结论，并说明会先备份、可撤销" width="100%">

确认后，插件会把整份文件备份到 `$DSH_HOME/context-studio/backups/<操作 id>/`，再从文件里删掉这几行。左下角的「操作记录」里随时可以 **撤销**。

### 拼盘：跨项目挑块，拼成起始上下文

勾选素材，或者直接把它拖到右边的拼盘，再拖动调整顺序。还可以：

- 输入 `@src/auth/login.ts` 引用文件，或者写一张便签；
- 在「本次任务」里写一句任务，它会放在起始上下文的末尾；
- 看 **token 预算条**：超出预算时，从超出的那一块开始标红。

<img src="docs/images/board.png" alt="拼盘里有来自 shop-web 和 shop-api 的四块，右下是拼好的起始上下文预览" width="100%">

拼好以后有三个出口：

1. **▶ 用它开新会话**：在目标项目里打开空白会话，把拼好的内容填进输入框。**不会自动发送。** 如果那个会话里已经有没发出去的草稿，你可以选择接在后面，或者替换掉。

   <img src="docs/images/launch-dialog.png" alt="开新会话确认框：说明不会自动发送，并让你选择已有草稿是接在后面还是替换" width="100%">
   <img src="docs/images/launch.png" alt="shop-web 的新会话，输入框里已经填好拼好的起始上下文和任务" width="100%">

2. **写入指令…**：把拼盘追加到目标项目的 `AGENTS.local.md`（默认，通常不进版本库）或 `AGENTS.md`。之后该项目的新会话都会自动加载。

   <img src="docs/images/write-dialog.png" alt="写入对话框：选择目标项目和文件，预览将要追加的内容" width="100%">

   写进去的内容会用标记包起来，注明来源：

   ```markdown
   <!-- context-studio:begin id=20261111144038-11c606 from="shop-api" at=2026-11-11 -->
   ## 约定 · 来自 shop-api / AGENTS.md › shop-api 约定 › 部署

   - 部署前先跑 `pnpm build`，再执行 `scripts/deploy.sh staging`
   - 生产发布必须在工作日 18 点前，周五不发版
   <!-- context-studio:end -->
   ```

3. **复制**：复制到剪贴板，你自己去用。

拼盘里的 `@会话` 是 DSH 原生的会话引用。发送后，DSH 会把它渲染成会话芯片，并把那个会话的有界快照一起交给模型。下面这个例子：在 shop-web 里问「shop-api 能在周五下午发生产版本吗」，模型根据引用的 shop-api 会话回答「不能，因为约定是周五不发版」。

<img src="docs/images/session-reference.png" alt="shop-web 的会话：用户消息里有会话引用芯片和一段助手摘录，下方注明「引用会话 · 项目部署与数据库约定」，模型回答周五不发版" width="100%">

素材卡上的 **拼到…** 按钮可以把单块素材直接写进另一个项目，不用经过拼盘。

## 安全模型

| 会做 | 不会做 |
|---|---|
| 只读 DSH 已知会加载的位置：指令候选文件、技能根目录、会话、Dot 的状态文件 | 不读任意路径。客户端传来的路径一律不用，服务端按「项目 + 素材 id」重新扫描后再定位 |
| 你在确认框里点了「移除 / 归档 / 写入」才动手 | 不自动删，不批量静默改 |
| 改文件前整份备份，记日志，可撤销 | 不物理删除任何文件。撤销「新建文件」时，是把文件挪进备份目录 |
| 移除前核对文件哈希必须和你看到的一致 | 不在过期视图上改文件，会提示你先刷新 |
| 撤销前核对文件没被别人改过 | 不覆盖你之后的改动，会告诉你备份在哪 |
| 会话只**归档**（DSH 原生，可取消归档）；会话正在运行时 DSH 会拒绝归档 | 不删除会话日志，也不会替你停掉正在运行的会话 |
| 写入只追加到目标项目的 `AGENTS.local.md` / `AGENTS.md`（全局只写 `$DSH_HOME/AGENTS.md`） | 不改系统提示、preset，也不改 Dot 的记忆 |
| 开新会话只预填草稿 | 不替你发送，不调用模型，也不碰 API key |
| 接口只接受本机同源请求；写操作还要带 `X-Context-Studio: 1` 头和 JSON 请求体 | 不对外暴露任何接口 |

文件都用原子方式写入（先写临时文件再 `rename`），并保留原来的换行风格（CRLF/LF）。

## 配置

默认什么都不用配。要调整的话，在你自己 profile 的 `cordis.patch.yml` 里按 id `context-studio` 覆盖：

```yaml
- replace:
    - id: context-studio
      name: dsh-plugin-context-studio
      config:
        staleDays: 60
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `staleDays` | `90` | 文件或会话超过多少天没动，就标记为「陈旧」 |
| `sessionLimit` | `50` | 每个项目最多列出多少个会话（新的在前） |
| `dataDir` | `$DSH_HOME/context-studio` | 操作日志和备份放在哪（绝对路径） |
| `trustedHosts` | `[]` | 除了本机和 DSH 自己的地址，还允许哪些 Host 访问接口（比如反向代理的域名） |

## 常见问题

**为什么没有「memory」类型？**
DSH 本身没有叫 memory 的存储。真正会进入模型上下文、相当于「记忆」的东西是：指令文件、技能、会话，以及第三方插件（比如 Dot）自己的记忆。拼图台把这些都列出来了。

**移除以后，正在进行的会话还会看到那条约定吗？**
会。DSH 在会话第一次请求时加载指令，之后只在 agent 读写到相关目录时增量刷新。新开的会话就不会再加载了。

**为什么默认写 `AGENTS.local.md`？**
`*.local.md` 是 DSH 支持的本地叠加文件，通常不提交到版本库。默认写这里，从别的项目拼来的约定不会悄悄进入团队仓库。想共享的话，在对话框里改选 `AGENTS.md`。

**撤销失败，提示文件被改过，怎么办？**
这是为了保护你之后的改动。提示里会写出备份文件的路径，你可以自己对比后手动恢复。

**token 数准吗？**
是估算值，按 DeepSeek 官方的经验值算：中文约 0.6 token/字，英文约 0.3 token/字符。用来比较多少、看预算够不够足够了。

**会话为什么不能直接拼「全文」？**
拼盘里的 `@会话` 用的是 DSH 原生的会话引用，发送后由 `dsh-session-reference` 展开成有界快照，不会一下子塞满上下文。要精确挑内容，点会话卡上的「摘录」，勾选具体的几条消息。摘录只列出你亲手发的消息和助手的回答，运行时注入的指令、时间、环境快照不会出现在里面。

## 工作原理

```
浏览器（lib/client.js，手写的 DSH client 模块，免构建）
  左栏入口「拼图台」+ 主区整页（slots: sidebar.panellist / main）
  │  fetch /api/dsh-plugin-context-studio/*（同源 + X-Context-Studio 头）
  │  ctx.uiWorkspace.startSession(workspaceId, { prompt, whenDraftExists })  ← 开新会话
  ▼
Host（lib/host.js，全局 Cordis 插件，inject: webServer）
  ├─ scan.js      项目 → 素材（指令 / 技能 / 会话 / Dot）+ 体检
  │                 用到 ctx.workspaceRegistry、ctx.sessionQuery（可选，缺了就降级）
  ├─ markdown.js  指令文件拆块、按行删除、带标记追加
  ├─ ops.js       移除 / 写入 / 归档 / 撤销；备份、日志、哈希校验、原子写
  ├─ compose.js   拼盘渲染 + 预算
  ├─ tokens.js    token 估算
  └─ guard.js     本机同源校验
数据：$DSH_HOME/context-studio/{journal.json, backups/}
```

用到的每个 DSH 接口都在源码里核对过，出处见 [docs/DESIGN.md](docs/DESIGN.md#3-素材盘点以源码为准)。

## 路线图

- [x] v0.1：素材墙、体检、移除 / 归档 / 撤销、拼盘、跨项目写入、预填草稿开新会话
- [ ] 配方：把拼盘存成命名配方，按项目和任务类型一键复用
- [ ] 技能移植：把技能目录复制到目标项目的 `.agents/skills`（不覆盖同名技能）
- [ ] 语义体检：请模型判断某条约定和代码是否还一致（先征得你同意再花 token）
- [ ] 会话精华提炼：选一段会话，让模型提炼成一条约定草稿，你确认后再写入
- [ ] 两个项目各有一版同名小节时，做差异合并
- [ ] 接入 DeepSeek tokenizer，给出精确 token 数

完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 参与开发

```bash
npm test          # node:test，42 个用例，不依赖 DSH
```

- 纯 JavaScript ESM，加 `// @ts-check`。运行时不依赖任何 `@deepseek-ai/*` 包。
- 改完插件代码要重启 DSH 才会生效。
- 请在隔离的 `DSH_HOME` 下试，不要动你日常用的 profile。

## License

[MIT](LICENSE)
