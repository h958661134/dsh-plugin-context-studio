# v1.4 Context Flow：源码核查与独立后端复核

日期：2026-11-16。范围限于 `context-flow.js`、`contextRecord()`、共享 reader 的 `compare()`、`GET /inspect-flow`，以及当前会话、fork、来源关联的宿主源码契约。

本分工只新增 `tests/context-flow-review.test.mjs`、本报告，以及经追加授权的 `.tmp/dsh-current-api.md`。未修改实现、提交、访问默认 DSH 会话或密钥、操作进程或浏览器，未触碰排除目录与 3999。主代理负责实现修复。

## 结论

**21 项 flow 测试通过**（新增独立测试 12 项、主代理测试 9 项）；最后一次相关回归合计 **61/61 通过，0 TODO**。两项有反例的 P2 已由主代理修复并通过原反例。按本次收尾要求停止追加审查，没有扩大范围或再次运行测试。

差异集以“上一次模型回答之前的输入”为基线；上次回答本身正确计入本步新增输入。已验证的图边区分位置包含、明确来源、调用返回、结构替换和引用快照，没有将连线宣称为模型内部因果。`guidance` 是核对建议，不能当作已经找到问题原因。

这不是桌面视觉验收，也不代表所有问题均已发现。尤其后来提出的 `assistant → tool/call` 精确 ID 连线，本分工完成了源码契约核查，未追加对其后续实现的测试。

## 源码契约：当前会话与 fork

核对的源码根为：

`C:/Users/Lenovo/AppData/Local/Temp/claude/418a1a8a137a94ef/cd1109a9-07cf-4d81-bb5c-d78857bbff34/scratchpad/repos/dsh/packages`

下表路径均相对此根。当前会话和工具调用的关联结论已整理在下方契约表中；临时交接文件不随包分发。本核查没有使用安装目录运行时作为替代来源。

| 结论 | 可引用源码位置 |
| --- | --- |
| `ctx.uiSession.adapter.current.getSnapshot().key` 为当前绑定的 Session ID；`subscribe(listener)` 返回取消订阅函数。无绑定时 key 为 undefined。 | `client/ui-session/src/client/index.ts:306` 公开 adapter；`:320–323` 提供 current；`:460–474` 依据 mainView 保留关系更新当前绑定；`:596` 设置 key；`:615` 无绑定；`:619–627` 实现读取和订阅。 |
| current 是公开可观察来源；不要读取私有 `uiSession.active` 或 `uiWorkspace.selection`。 | `client/ui-slots/src/renderer.ts:76–100` 定义绑定与 current 类型；`client/ui-session/src/client/index.ts:297` 的 active 是生命周期布尔值；`client/ui-workspace/src/client/navigation.ts:173–176` 的 selection/mainReference 是私有字段。 |
| `ctx.sessions.list` 可订阅，含 ids/byId/phase；按 updatedAt 可得到最近更新，但不等于最近打开。 | `api/session-controller/src/client/contract/sessions.ts:49–51`；`api/session-controller/src/client/sessions/service.ts:26–67`。只有 ids 表示宿主目录成员，byId 可能额外含保留的子代理。 |
| 未查到公开“最近打开会话”读取器。可记录订阅以来最近非空 current key，但不能称为完整浏览历史。 | `UiWorkspace` 公共接口在 `client/ui-workspace/src/client/navigation.ts:40–146`；同文件 `:577–595` 的 recentWorkspace 按 updatedAt 选择最近工作区。 |
| `uiWorkspace.forkSession()` 不接受 atSeq，options 仅开放 allowMigration。 | `client/ui-workspace/src/client/navigation.ts:68–72,324–334`。 |
| `ctx.sessions.fork({sessionId, atSeq, ...})` 支持精确包含边界；省略时取最近完成回合前缀，开放回合由宿主补结束事件。 | `api/session-controller/src/client/contract/sessions.ts:124–143`；`api/session-controller/src/commands.ts:223–264`；`core/session/src/fork.ts:10–29`。 |
| 原生聊天调用按 seq fork 后显式打开 child；fork 本身创建会话，不等同于选取证据预填草稿。标题更新失败也可能发生在 child 已创建之后。 | `client/ui-chat/src/client/apply.ts:301–307`；`api/session-controller/src/client/sessions/service.ts:476–501`。 |

## 源码契约：关系边可以表示什么

| 关系 | 可信依据及边界 | 源码位置 |
| --- | --- | --- |
| 位置包含 | 回答前 active surface 中存在某节点。仅说明日志输入包含，不证明模型实际关注了它。 | `core/session/src/types.ts:447–472`；`surfaceOp` 定义。 |
| 结构替换 | replace 的 startSeq/endSeq 是当前 surface 上的首尾节点，按位置区间替换，不是直接将数值序号范围内所有事件删掉。 | `core/session/src/surface.ts:415–434`，先查 surface 的节点位置，再取区间。 |
| 声明来源 | `sourceEventSeqs` 声明较早来源事件。宿主校验非负安全整数、非空、去重、早于当前；替换须包含所有被覆盖的 surface 节点。 | `core/session/src/surface.ts:330–364`。 |
| assistant 与来源字段 | assistant/message 禁止携带 sourceEventSeqs；它包含模型输出及 provider stream。不能为它伪造“全部输入都是显式来源”的字段。tool/call 也不是 surface 事件，不带该字段符合契约。 | `core/session/src/types.ts:349–356,447–485,520–522`。 |
| assistant → tool/call | assistant 正文内工具块的 `id` 被执行器原样写入 `tool/call.data.callId`；这是精确字段关联，不是相邻序号、工具名或 turn/step 的近似匹配。 | `llm/llm/src/types.ts:112–118`；`core/agent-loop/src/agent.ts:574–591`；`core/tools/src/batch.ts:243–249`。 |
| tool/call → tool/result | 结果写入 `sourceEventSeqs:[callSeq]`；结果消息的 toolCallId/source.callId 来自同一个 block.id。 | `core/tools/src/batch.ts:252–264`；`llm/llm/src/message.ts:299–305`。 |
| 调用不等于成功执行 | 未派发即取消的工具也可以记录 call/result。应看结果与错误标记，不能凭调用节点宣称工具已经成功运行。 | `core/tools/src/batch.ts:271–279`。 |

精确 ID 关联仍须校验实际事件。源码不保证供应商 ID 在整个会话全局唯一；若候选重复、缺失或冲突，应保留无法确认状态。turn/step 可核验精确 ID 候选的批次范围，但不能替代 ID。没有读取真实 #33/#34/#35 的值，因此没有宣称这些具体事件已实际匹配。

对提出的 `#33 → call #34 → result #35 → answer #39`：前两段分别应标明“请求调用 / ID 对应”“调用返回 / 声明来源”；最后一段只有在 #35 属于 #39 回答前 active 输入时，才能标为“本步输入”。最后一段不是因果证明。

## 差异比较及已有回归

令 B 为上次回答之前的 active 节点集，C 为当前回答之前的 active 节点集：

- added = C − B；retained = C ∩ B；removed = B − C。
- 当前回答本身不在 C 中；上次回答若仍在当前输入中，应计入 added。
- removed 只说明日志位置被替换，不说明旧内容无用或错误。`replaced` 筛选包含更早的历史替换记录，不能全部算作这一步 removed。
- reader 的前后索引来自同一次 readSession 快照；不能分别读取两个变化中的会话版本再比较。
- 首次回答没有基线；结构索引不可用时差异计数返回 null、available 为 false，不伪造零变化。

独立测试包括简单数组折叠作为参考模型的 150 条混合事件与 10 个回答边界、多个替换区间、前后输入集合差异，以及单快照读取。还验证了：

- 41 条输入跨四页无重复遗漏；focus 跨页定位、过滤后不匹配以及页码越界处理。
- 源节点、锚点与边端点均可解释；被移除与位置未知的节点没有被画成当前输入。
- 未来、自引用、未知来源不虚构有效关系；关系容量受 12 节点 / 28 锚点 / 100 边限制，省略明确计数。
- 120 万字符正文未扩张为图正文；图不携带调用参数、请求头、隐藏推理、附件载荷或不透明元数据。图需要的小预览仍会读取，并非完全不访问正文。
- Host 对非法 scope/page/focus/module/answer 明确拒绝；原文仍走独立的详情页。

## 已发现并修复的问题

### F1／P2：第 13 条引用被静默丢弃

原反例为一条输入声明 13 个不同引用。`contextRecord()` 的 refs 只保留 12 项，但通用数量告警阈值为 30，图也没有累计这项截断，因此输出仅 12 条引用边、omittedRelations 为 0，无任何省略提示。

主代理修复：`context-view.js:283` 增加 `omittedReferences`，`context-flow.js:81` 累计到 `omittedRelations`。原反例通过。此处并非要求展开所有引用，而是要求有限图明确说明来源被省略。

### F2／P2：容量降级仍承诺无法读取的基线锚点

原反例为基线回答 #1、当前回答 #250001。当前索引超限后 rows 为空，当前答案可读，但“上次回答”锚点仍为 canInspect:true；按当前回答边界读取事件 #1 返回 404。

主代理修复：`context-flow.js:78` 使用 `current.rows.has(seq)` 决定基线锚点 canInspect。原反例通过；同时仍保留基线信息和容量核对建议，不将无法比较伪装成零变化。

## 测试记录与快照

本分工最后实际运行：

```text
node --test tests/context-flow-review.test.mjs tests/context-flow.test.mjs tests/context-view.test.mjs tests/context-view-review.test.mjs tests/host.test.mjs
```

结果：**61 passed，0 failed，0 TODO**。其中 flow 共 21 项（独立 12、主代理 9）；主代理随后也反馈 21 项 flow 已通过。本次收尾未重复运行。

该次验证快照的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| lib/context-flow.js | BB399D54EF435C22DCE8A3FB7E40D8A20D88C9443A77DD1479806C0ADF2E2EED |
| lib/context-view.js | 69A488088E1FCB1F1FA578E01065F414C153B3DC051E6292A199A34DE72D565A |
| lib/host.js | A72C9174704DFD5F83A16069534615F5046238BF5C715E3DFE552B919E41F0D0 |

## 剩余限制

- 本次不是视觉、键盘、桌面兼容性或真实会话 fork 验收。源码 API 已查证，但未在运行中的宿主调用。
- 后来新增的 assistant→call 精确 ID 连线只完成了契约核查；不将尚未审查的实现计入本次通过结果。
- 图是分页、有限来源的日志位置投影；附件投影、供应商最终请求、模型内部原因不在可证明范围内。
- 比较仍在 readSession 返回完整快照之后建立前后索引；响应有界不等于底层读取和最坏计算成本已完全受控。
- 最近观察、最近更新、最近打开是不同概念。缺少公开完整浏览历史接口时，不应把回退排序描述成最近打开。
- 原生按 seq fork 继承整个前缀；选取部分上下文预填新会话是另一种操作。两者的名称、确认与结果不能混淆。
- 本报告只关闭已复现的两项问题，不宣称已发现全部 bug。后续按用户批准范围继续，不因本报告自动追加审查。
