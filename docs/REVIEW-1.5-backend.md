# v1.5 会话整理后端：有界独立复核

日期：2026-11-16。状态：本轮有界复核闭环，R1–R5 对应反例均通过。

## 当前结果

最新执行 `node --test tests/organize-review.test.mjs tests/organize.test.mjs`：**30 项全部通过，0 失败，0 跳过，0 TODO**。其中独立测试 **15 项**、主测试 **15 项**。全部使用 fake llm、合成会话和测试自身创建的临时目录，没有真实模型调用。没有扩大到全仓审查、真实模型或浏览器验收。

复现历史：初轮独立 12/13、合跑 25/26，唯一失败为 R3。主代理随后指出真实 Cordis 代理身份和终态保存时序问题，增加两个独立定向反例后曾为 12/15；修复并按已核对的 Cordis original symbol 契约修正 mock 后得到上述最终结果。

### R3 / P2：写入调用凭据期间停止插件仍继续派发——已关闭

位置：`lib/organize-jobs.js:138–163`（首次复现时的行号）。入口在 140 行检查 `disposed`，154 行等待 exclusive receipt 写入；159–162 行恢复后直接建立 active control 并 execute，没有重新检查停止状态。

可复现时序：

1. preview 获得 planId，调用 `start({planId,confirmed:true})`。
2. 注入的 `write(...,{exclusive:true})` 在落盘前等待一个显式 gate。
3. 等 write 已进入后调用 `organizer.dispose()`；当时尚未创建 active controller，故 dispose 无法中止该操作。
4. 释放写入 gate。结果仍发生 **1 次 prepareCall**，预期为 0。

对应独立测试：`review R3: dispose during exclusive receipt write must prevent dispatch`。测试仅计数 fake 调用，没有真实消耗。

影响：插件停用或 HMR 的这个窗口内，已经确认、但尚未派发的作业会在停止后继续启动，破坏停止语义，也可能使旧实例工作与新实例重叠。此前确认不意味着停止之后还应继续发送。

主代理修复：`lib/organize-jobs.js:165–171` 在 receipt 写入完成后重新检查 disposed 与真实服务身份；若变化则保存 cancelled receipt，不进入 prepare/stream。独立回归验证两者调用次数均为 **0**、磁盘 receipt 为 cancelled，并验证重建 organizer 后再次 start 仍返回 cancelled、没有新增调用。sidecar 未改实现。

### R1：多 terminal finish 的状态覆盖，当前反例已通过

初读 `organizeStream` 时，finish 分支在已有终止检查之前，后续 stop 可覆盖 error；同样 usage 也可越过终止检查。当前实现 `lib/organize.js:125` 已在处理所有后续 chunk 前检查 `finish !== null`。

独立测试向流写入完整 JSON、finish(error)、finish(stop)，确认拒绝。**本次首次实际运行已包含主代理的修复**；没有把当前通过结果表述为在原始版本上实际运行过的失败。

### R2：供应商错误带 status 时原文泄露，当前反例已通过

初读 execute 的失败分支以 `e.status` 判断可公开错误。常见 SDK 错误也有 HTTP status，因而这不足以授权公开其 message。当前实现改为内部安全错误标记。

独立测试让 fake prepare 抛出带 `status:401` 的 `PROVIDER_PRIVATE_SENTINEL`，验证公开 job 和持久化 job 均不含该标记；重复 start 不新增 prepare，且 stream 从未开始。与 R1 相同，首次实际运行已包含主代理修复。

### R4 / P2：将新 Cordis 包装对象误判为服务替换——已关闭

问题由主代理在隔离 4001 观察并指出，本 sidecar 未操作浏览器或真实服务。旧逻辑将 `getLlm() !== cached.owner` 视为服务更换，导致同一底层服务每次返回新 proxy 时目录/预览失败。

已只读核对主代理提供的 `@deepseek-ai/cordis/lib/index.js` 源码副本：symbol 定义在 39 行，`getTraceable` 在 85–90 行为有 tracker 的对象调用 `createTraceable`，125–130 行每次创建新 Proxy 并让 original symbol 返回 target；1347–1348 行 `get()` 返回 traceable 服务。无 tracker 的普通值可直接返回，不能把“所有 get 一定返回新 proxy”泛化。

当前 `lib/organize-jobs.js:17–19` 仅在身份比较中使用 `value[Symbol.for('cordis.original')] ?? value`，调用继续使用 proxy。独立 fixture 准确模拟该 symbol：连续目录、预览、确认、重复 start 均正常，仅一次 prepare/stream；将底层 target 换成另一个对象后，旧计划仍以 409 拒绝，调用计数不增加。已移除仅凭外层包装对象变化就应拒绝的错误测试假设。

### R5 / P2：终态先于保存结果公布，轮询可能漏保存警告——已关闭

问题由主代理指出。独立反例使用明确的 gate 延迟最终保存，原实现的 get 已返回 completed；客户端可能停止轮询，无法收到稍后才产生的 persistenceWarning。

当前 `lib/organize-jobs.js:22,30–34,108–140` 用 settling 集合暂时对外保持 running，save 完成后再公布终态。独立回归分别覆盖保存成功和 ENOSPC：gate 未释放时 get/history 均返回 running；释放后首次可观察 completed 已包含正确的保存结果，失败时 warning 与终态一同可见、报告仍可复制。重复 start 不重新调用模型。

## 授权范围与分工

- 只审查 `lib/organize.js`、`lib/organize-jobs.js` 及其已用的历史投影/持久化契约。
- sidecar 仅写 `tests/organize-review.test.mjs`、本报告、`.tmp/organize-api-audit.md`。
- 未改实现、README、client，未提交，未操作 DSH 进程、浏览器、端口或真实数据，未访问排除目录。
- HTTP 接入、主测试和产品界面由主代理负责。本报告不将其验收计为独立验证。

## 已验证的边界

| 范围 | 独立证据 |
| --- | --- |
| 用户确认之前零生成 | models、preview、history、缺失 job 的 get/cancel、confirmed 为 false/字符串/数字/对象，prepare/stream 均为 0 |
| 目录字段白名单 | provider/model 中的额外 private 字段不进入目录响应 |
| 同一 planId 防重 | 25 个同时 start 只产生 1 次 prepare、1 次 stream；完成后 start/get/history/cancel 和重建 organizer 都不重放 |
| 已确认快照 | 修改返回的 preview 对象不改变实际发送 system/input/source；保留 prepared reasoning 默认配置和 maxTokens，工具列表为空 |
| 失效计划及代理兼容 | 达到过期边界、真实底层服务替换时拒绝；同一底层服务的新 Cordis proxy 不使预览失效 |
| receipt 失败 | 注入 ENOSPC，返回失败且 prepare/stream 为 0 |
| 落盘期间停止 | 停止后 prepare/stream 为 0；取消 receipt 持久化，重建实例也不重放 |
| 结果保存失败 | 内存报告仍可读并提示保存问题；重建 organizer 从 running receipt 得到 interrupted，重复 start 不生成 |
| 终态和保存提示 | get/history 在最终写入待决时保持 running；成功/失败结果确定后才公布 completed，保存失败警告同时可见 |
| 取消与并发槽位 | prepare 忽略 abort 时，cancelled 仍 active；另一计划被拒绝；旧 prepare 返回后不进入 stream |
| 超时和迟到结果 | 已观察 usage 保留且删去私有字段；超时后迟到的完整 JSON 不能转成 completed 或 report；重复 start 不调用 |
| 不可信模型 JSON | 损坏 JSON、错误顶层形状、空/非法卡片拒绝；数字字符串、负数、非整数、对象和不存在 seq 不成为原文链接 |
| 正文和计量 | block-end 替换 delta 不重复正文；最新 usage 快照保留；reasoning 不进入简报；缺 finish/max-tokens/aborted/工具请求/超长输出拒绝 |
| 历史范围和容量 | active/replaced/unknown/answer 状态区分；所选回答后的记录不发送；系统默认排除；reasoning/replay 元数据排除；预算、来源数、逐条字符、offset/end 和遗漏提示有界 |

## DSH 调用契约核查摘录

完整工作说明位于本地临时文件 `.tmp/organize-api-audit.md`；它不是发布包文件，本报告保留关键事实供仓库读者使用。

核查源码根：

`C:/Users/Lenovo/AppData/Local/Temp/claude/418a1a8a137a94ef/cd1109a9-07cf-4d81-bb5c-d78857bbff34/scratchpad/repos/dsh/packages`

以下路径均相对此根：

| 契约 | 证据 |
| --- | --- |
| listProviders 同步返回已注册路由 id/name | `llm/llm/src/index.ts:478–485` |
| listModels 是异步目录，委托适配器；不是生成请求，也不保证绝无目录网络 I/O | `llm/llm/src/index.ts:711–735` |
| prepareCall 捕获注册/模型配置，stream 单次入口且配置必须相等 | `llm/llm/src/index.ts:948–1017` |
| one-shot 可使用无 durable id/source 的 user 文本；system 独立传入 | `llm/llm/src/types.ts:530–539,564–605` |
| maxTokens 省略才采用 adapter default；不是输入预算或货币上限 | `llm/llm/src/index.ts:911–945`；`llm/llm-deepseek/src/serialize.ts:147–159` |
| usage 独立事件，finish 读取 reason.kind | `llm/llm/src/types.ts:488–508` |
| 输入计数分为未缓存/缓存读/缓存写，不能忽略缓存；total 可缺失 | `llm/llm/src/types.ts:175–195` |
| assembler 对 usage 覆盖而非累加 | `llm/llm/src/assembler.ts:85–90` |
| 官方自动重试执行器挂在 agent/request-error，one-shot 不走 agent loop | `llm/llm-retry/src/index.ts:240–248` |
| prepared stream 仍经过 llm/stream 中间件 | `llm/llm/src/index.ts:1174–1183` |

“不自动重试”的承诺应限定为插件同一计划只发起一次宿主生成调用，不保证未知第三方中间件、适配器或供应商内部绝不重发。原生 DeepSeek 附件路径还有失效文件 ID 恢复分支；纯文本整理请求不涉及该附件分支，见 `llm/llm-deepseek/src/adapter.ts:105–170` 与 `request-files.ts:135–143`。

## 最终验证快照

| 文件 | SHA-256 |
| --- | --- |
| lib/organize.js | EC8C8F7DD946BD5CD3C7189CA3570CEDCDC1C95F09DC25E393890FA4C674110D |
| lib/organize-jobs.js | 2AD27919C6356A81E85DCACDE362B44A8A8C7E1C23A4C6B56D0A05DC904C5439 |
| tests/organize-review.test.mjs | 305401152BA625E9B8C2A4582141373D3449FCD898708DECFEA8A90D7C48A4B4 |

## 当前限制

- 本次已复现及定向验证的问题均已关闭；不代表发现了全部 bug，也不替代主代理的整体版本验收。
- 无真实模型质量、供应商账单、浏览器确认交互、HTTP guard 或桌面运行验收。fake 调用次数不能当作真实收费保证。
- 并发测试覆盖同实例同计划和持久化后的重建，不覆盖两个独立存活宿主实例对不同计划同时生成；不能据此宣称跨进程全局限流。
- 输入文字预算是估算；底层 readSession 仍先返回整个快照，输出有界不等于全部读取成本有界。
- 引用白名单只证明引用属于本次提供的来源，不证明模型卡片事实正确，也不证明来源全文已被阅读。
- 本次不展开磁盘作业手工篡改、第三方中间件行为、供应商忽略中止后的真实计费等额外审计。不宣称发现了全部 bug。
