# v1.5.1 整理失败定位与修复校验

日期：2026-11-16。状态：本地修复，未推送或发布。

## 结论

发现并修复 OpenCode 辅助整理缺少会话路由标识的兼容问题。同时修复失败记录只有通用提示、无法区分上游原因的问题。

这不是“历史上下文超过检查容量”的故障。实际失败停在模型响应阶段，未进入简报 JSON 解析。**旧版已丢弃供应商具体错误，无法确认缺少路由标识是该次失败的唯一原因。** 本次没有重试用户作业、调用真实模型或读取用户密钥。

## 本地证据

只提取默认桌面插件目录内失败作业的状态字段，不在报告复制来源正文、提示词或凭据。

| 项目 | 读取结果 |
| --- | --- |
| 供应商 / 模型 | opencode-go / deepseek-v4.1-flash |
| 回答边界 | #67 |
| 时间 | 2026-11-16 15:00:49 至15:00:52，约3秒 |
| 输入估算 / 输出上限 | 7,995 / 4,096 token |
| 范围 | 总22条；纳入16条，其中1条截短；排除6条系统记录 |
| 结果 | failed，无报告；通用错误“模型未正常完成整理” |
| 记录用量 | 三项均0；适配器可能返回初始化的0，不能认定没有收费 |

当前能取得的桌面日志未保留该次上游失败详情。原作业文件没有修改。

## 兼容缺陷的证据链

1. v1.5 `organize-jobs.js` 的辅助调用不传 `sessionId`。
2. DSH `llm/llm-pi-ai/src/adapter.ts` 只有收到 sessionId 才将它交给 pi-ai。宿主 `tests/adapter.spec.ts` 已有对应 Go 请求头测试。
3. 安装版 pi-ai 的 `providers/opencode-headers.js` 只有该字段存在时才添加 `x-opencode-session`；`opencode-go.js` 为该供应商挂载此处理。
4. Go 明确要求稳定的会话路由标识，见 [官方会话说明](https://opencode.ai/docs/console/harnesses)。

修复仅给 `opencode-go` / `opencode` 传稳定的独立整理标识，由宿主处理协议。没有手写认证头、冒充其他客户端、修改供应商端点或向原会话写入内容。

错误记录保留固定代码与调用阶段，不保存供应商原始错误。旧失败不会自动补跑，用户必须重新预览并确认，才可能发生新一次消耗。

## 验证结果

- `node --test tests/*.test.mjs`：**291/291通过，0跳过、0TODO**。
- 新增7项回归覆盖辅助标识稳定性、不同会话/供应商隔离、失败持久化、阶段区分、敏感字段白名单、异常终态及认证错误误分类。
- 独立复核发现一个P2：从错误文本推断“缺少会话头”可能覆盖 AUTH，或误读“required header is present”。最终移除这类文字推断，仅保留宿主提供的已知分类与允许的 HTTP 状态码，补上完整作业及相关反例。
- 独立复查确认该P2已关闭，针对性7/7通过；语法、diff与 `npm pack --dry-run` 检查通过，测试脚本和临时资料不进入插件包。
- 全量回归中旧R2和并发确认用例曾在轮询磁盘结果时超时，R2单独运行通过；统一修订文件校验助手，先等待公开终态，再读取一次磁盘并断言无持久化警告，避免测试轮询与 Windows 原子替换争用。最终全量通过。
- 安装版真实适配器连接本机 HTTP 模拟端点：旧调用被400拒绝并映射为 `INVALID_REQUEST`；新调用携带 `context-studio-organize-<hash>`，完成简报。重复 start 不增加 HTTP 请求。
- 模拟用量为输入3、输出10、总13，仅为测试返回值。未调用真实供应商，未消耗用户真实 token。
- 隔离4001重新加载后项目目录正常，既有离线演示的 completed/cancelled 报告仍可读取。未修改默认桌面配置、原会话和失败作业。

## 重现安装版协议测试

脚本 `scripts/verify-opencode-runtime.mjs` 创建独立 Cordis 服务，只加载 LLM 与 pi-ai 模块，不加载用户 profile；认证服务只返回脚本内固定的假值，HTTP 只发送到脚本自己的回环端点。测试输出不包含 Authorization。

Windows PowerShell，在工程目录运行（路径按本机安装位置调整）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = Join-Path $PWD '.tmp\opencode-protocol-home'
New-Item -ItemType Directory -Force -Path '.tmp' | Out-Null
$scriptPath = Join-Path $PWD 'scripts\verify-opencode-runtime.mjs'
$runtimePath = 'D:\DeepSeek Harness\resources\app.asar\dsh\node_modules'
$qaProc = Start-Process -FilePath 'D:\DeepSeek Harness\DeepSeek Harness.exe' `
  -ArgumentList '--expose-internals', ('"' + $scriptPath + '"'), ('"' + $runtimePath + '"') `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput '.tmp\qa-protocol-out.txt' -RedirectStandardError '.tmp\qa-protocol-err.txt'
if (-not $qaProc.WaitForExit(25000)) {
  Stop-Process -Id $qaProc.Id
  throw 'Local protocol test timed out'
}
Get-Content '.tmp\qa-protocol-out.txt'
Get-Content '.tmp\qa-protocol-err.txt'
if ($qaProc.ExitCode -ne 0) { throw 'Local protocol test failed' }
```

期望退出码0；结果 `before: INVALID_REQUEST`、`after: completed`，两条请求分别无路由标识和有标识。固定假凭据不是用户 API key，也不需要用户填写任何密钥。

## 使用与未验证范围

桌面插件已链接本地工程，完全退出 DSH（包括托盘）再打开即可载入 v1.5.1。旧记录保持失败是预期行为；决定再试时重新预览并确认消耗。若仍失败，新分类和阶段可以用于继续定位，不能靠刷新或反复提交绕过一次调用凭据。

未重新调用真实 OpenCode 服务，因此未验证其当前账户权限、额度、网络、真实输出质量或计费。本机协议测试不能替代这一步。界面没有改动，README 沿用标注为模拟的 v1.5 截图。没有推送、打标签或发布。

最终分类方案改定后，再次重载4001隔离实例被自动审批以 `blocked by policy` 拒绝，未提供细分原因。保留现有实例，不换路径重试停止进程。最终分类代码已通过291项自动测试和独立复核；运行中实例仍需重新加载，不能把先前隔离验证写成最终桌面实例已生效。
