// @ts-check
// Historical positional surface inspection. No current file substitutes, raw streams or headers.
import { estimateTokens } from './tokens.js'

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const LABELS = { user: '用户要求', 'agent-instructions': '项目指令', 'session-reference': '引用会话', 'skill-catalog': '技能目录', 'skill-invocation': '技能正文', 'runtime-context': '运行环境', 'time-context': '时间信息', 'tool-registry': '工具目录' }
const MAX_TEXT = 20_000
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const messageOf = e => e.type === 'user/message' ? e.data : e.data?.message

/** Whitelist visible blocks; exclude reasoning, streams, binary and opaque metadata. */
export function visibleText(message) {
  return (Array.isArray(message?.content) ? message.content : []).map(b => {
    if (b.type === 'text') return typeof b.text === 'string' ? b.text : ''
    if (b.type === 'tool-call') return `[调用 ${b.name ?? '工具'}]\n${typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})}`
    if (b.type === 'tool-addition' || b.type === 'tool-removal') return `[${b.type === 'tool-addition' ? '启用' : '移除'}工具 ${b.toolName}]`
    if (['image', 'image_url', 'audio', 'file'].includes(b.type)) return `[${b.type} 附件：此视图不展开]`
    return ''
  }).filter(Boolean).join('\n\n')
}

function entry(e, calls) {
  const msg = messageOf(e), source = msg?.source?.kind || ''
  const kind = e.type === 'user/message' ? (source === 'user' ? 'user' : 'context') : e.type === 'assistant/message' ? 'assistant' : e.type === 'tool/result' ? 'tool' : 'system'
  const call = e.type === 'tool/result' ? calls.get(msg?.toolCallId) : null
  const raw = visibleText(msg)
  const changes = (msg?.source?.changes ?? []).filter(c => typeof c.path === 'string').map(c => ({ path: c.path, action: c.action }))
  const refs = (msg?.source?.references ?? []).map(r => ({ sessionId: String(r.sessionId ?? ''), label: String(r.label ?? ''), truncated: Boolean(r.truncated), omittedMessages: Number(r.omittedMessages) || 0, capturedThroughSeq: r.capturedThroughSeq }))
  const label = LABELS[source] || ({ user: '用户要求', assistant: 'AI 回答', tool: '工具结果', system: e.type === 'developer/message' ? '开发者指令' : '系统提示', context: source || '注入上下文' })[kind]
  return { seq: e.seq, time: e.time, type: e.type, kind, source, label: call ? `${label} · ${call.name}` : label,
    text: raw.slice(0, MAX_TEXT), clipped: raw.length > MAX_TEXT, tokens: estimateTokens(raw), changes, refs,
    callSeq: call?.seq, callArguments: call?.arguments?.slice(0, MAX_TEXT), isError: msg?.isError === true, interrupted: e.data?.interrupted === true,
    sourceEventSeqs: Array.isArray(e.sourceEventSeqs) ? e.sourceEventSeqs : [],
    nonText: (msg?.content ?? []).some(b => !['text', 'tool-call', 'tool-addition', 'tool-removal', 'reasoning'].includes(b.type)) }
}

/** Fold positions BEFORE one assistant event; never use today's surface for an old answer. */
export function inspectLog(log, answerSeq) {
  const events = log?.events ?? []
  if (events.length > 50_000) throw fail('会话超过 50,000 条事件，请在 DSH 中选取较短的分支查看。', 413)
  const answers = events.filter(e => e.type === 'assistant/message')
  const target = answerSeq == null ? answers.at(-1) : answers.find(e => e.seq === answerSeq)
  if (answerSeq != null && !target) throw fail('找不到这次回答，请刷新会话。', 404)
  const boundary = target?.seq ?? (events.at(-1)?.seq ?? -1) + 1
  const nodes = [], removed = new Map(), calls = new Map(), rows = new Map(), warnings = []
  let header, route, valid = true, projected = false
  for (const e of events) {
    if (e.seq >= boundary) break
    if (e.type === 'request/header') header = e.data?.header
    if (e.type === 'request/context') route = e.data
    if (e.type === 'image/offload') projected = true
    if (e.type === 'tool/call') calls.set(e.data?.callId, { seq: e.seq, name: e.data?.name, arguments: e.data?.arguments })
    if (!SURFACE.has(e.type)) continue
    rows.set(e.seq, entry(e, calls))
    if (e.surfaceOp === 'append') nodes.push(e.seq)
    else if (e.surfaceOp?.op === 'replace') {
      const start = nodes.indexOf(e.surfaceOp.startSeq), end = nodes.indexOf(e.surfaceOp.endSeq)
      if (start < 0 || end < start) { valid = false; continue }
      for (const seq of nodes.splice(start, end - start + 1, e.seq)) removed.set(seq, e.seq)
    } else valid = false
  }
  const previousAnswer = answers.filter(e => e.seq < boundary).at(-1)
  const context = nodes.map(seq => ({ ...rows.get(seq), status: 'active', added: !previousAnswer || seq >= previousAnswer.seq })).filter(r => r.text || r.nonText)
  const shadowed = [...removed].map(([seq, by]) => ({ ...rows.get(seq), status: 'replaced', replacedBy: by }))
  const activeSeqs = new Set(nodes)
  const unplaced = [...rows.values()].filter(r => !activeSeqs.has(r.seq) && !removed.has(r.seq)).map(r => ({ ...r, status: 'unknown' }))
  const flag = (code, title, detail, seq) => warnings.push({ code, title, detail, seq })
  if (!valid) flag('surface-unknown', '部分消息的位置无法确认', '日志缺少可识别的 surfaceOp；这些条目放在「位置未知」中，不算作已进入上下文。')
  if (projected) flag('projection', '存在图片卸载记录', '这里只还原消息位置和原始文本，图片替换后的内容没有重放。')
  if (shadowed.length) flag('replaced', `${shadowed.length} 条早期消息已被替换`, '打开「已替换」比较原文和替代消息；摘要可能没有保留你关心的细节。', shadowed[0].replacedBy)
  for (const r of context) {
    if (r.isError) flag('tool-error', '工具返回了错误', `${r.label}，查看结果和调用参数，确认后续结论是否建立在失败的查询上。`, r.seq)
    if (r.refs.some(x => x.truncated || x.omittedMessages > 0)) flag('reference-truncated', '引用会话并非完整历史', 'DSH 记录了截断或省略消息；检查缺失部分是否影响本次问题。', r.seq)
    if (r.changes.some(x => x.action === 'replace' || x.action === 'remove')) flag('instruction-change', '指令在会话中发生变化', '检查这次注入的变更内容，以及它和之前约定是否冲突。', r.seq)
    if (r.clipped) flag('display-clipped', '长内容只展示前 20,000 字符', '这是界面的展示限制，不代表模型当时收到的内容被截断。', r.seq)
  }
  if (target?.data?.interrupted) flag('interrupted', '这次回答被中断', '日志只记录了已输出的部分，请先确认答案是否完整。', target.seq)
  const since = events.filter(e => e.seq < boundary && ['assistant/attempt', 'llm/retry'].includes(e.type)).at(-1)
  if (since) flag('retry', '此前有未完成尝试或重试', '这是会话日志线索，不代表这次回答一定受到影响。', since.seq)
  const timeline = answers.map(e => ({ seq: e.seq, time: e.time, turn: e.data?.turn, step: e.data?.step, preview: visibleText(messageOf(e)).slice(0, 140) || '工具调用或无可见文字', interrupted: !!e.data?.interrupted }))
  return { sessionId: String(log?.session?.id ?? ''), answer: target ? entry(target, calls) : null, timeline,
    boundary, context, shadowed, unplaced, warnings,
    request: { model: header?.config?.model ?? route?.model, provider: header?.config?.provider ?? route?.provider, toolCount: header?.tools?.length ?? 0, contextWindow: route?.contextWindow },
    summary: { active: context.length, added: context.filter(r => r.added).length, replaced: shadowed.length, tokens: context.reduce((n, r) => n + r.tokens, 0) },
    limitation: '依据回答前的日志重建消息位置，供核对输入来源；不是供应商最终请求包，也不能证明模型为何作出某个判断。token 为可见内容估算，不含隐藏推理和完整附件。' }
}

export async function inspectSession(query, id, seq) {
  if (typeof query?.readSession !== 'function') throw fail('当前 DSH 没有 readSession 能力，无法检查历史上下文。', 503)
  if (seq != null && (!Number.isSafeInteger(seq) || seq < 0)) throw fail('回答序号必须是非负整数')
  return inspectLog(await query.readSession(id), seq)
}
