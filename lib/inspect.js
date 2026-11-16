// @ts-check
// Historical positional surface inspection. No current file substitutes, raw streams or headers.
import { estimateTokens } from './tokens.js'

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const LABELS = { user: '用户要求', 'agent-instructions': '项目指令', 'session-reference': '引用会话', 'skill-catalog': '技能目录', 'skill-invocation': '技能正文', 'runtime-context': '运行环境', 'time-context': '时间信息', 'tool-registry': '工具目录' }
const MAX_TEXT = 20_000
const MAX_COLLECTION = 2_000
// Applied AFTER readSession; query-service disk reads need their own limits.
// Capacity failures reject (413), never silently shorten the selected history.
export const INSPECT_LIMITS = Object.freeze({ events: 50_000, rows: 2_000, sourceChars: 1_000_000, responseBytes: 2 * 1024 * 1024, timeline: 200, work: 2_000_000 })
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const capacity = () => fail('历史上下文超过检查容量上限，未返回不完整快照；请在 DSH 中选取较短的分支或更早的回答。', 413)
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const sequence = v => Number.isSafeInteger(v) && v >= 0
const messageOf = e => e.type === 'user/message' ? e.data : e.data?.message

function budget() {
  let chars = 0, work = 0, bytes = 0, rows = 0
  return {
    text(s) { if (s.length > INSPECT_LIMITS.sourceChars - chars) throw capacity(); chars += s.length; return s },
    work(n = 1) { work += n; if (work > INSPECT_LIMITS.work) throw capacity() },
    row() { if (++rows > INSPECT_LIMITS.rows) throw capacity() },
    // Reserve room for the independently bounded timeline and final placement fields.
    reserve(value) { bytes += Buffer.byteLength(JSON.stringify(value), 'utf8') + 128; if (bytes > INSPECT_LIMITS.responseBytes - 512 * 1024) throw capacity() },
  }
}

function array(value, field, problems, b) {
  if (value === undefined) return []
  if (!Array.isArray(value)) { problems.add(`${field} 不是数组`); return [] }
  if (value.length > MAX_COLLECTION) throw capacity()
  b.work(value.length)
  return value
}

function text(value, field, problems, b, fallback = '') {
  if (value === undefined) return fallback
  if (typeof value !== 'string') { problems.add(`${field} 不是文本`); return fallback }
  return b.text(value)
}

function numeric(value, field, problems, valid = Number.isFinite) {
  if (value === undefined) return undefined
  if (!valid(value)) { problems.add(`${field} 无效`); return undefined }
  return value
}

function boolean(value, field, problems) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') { problems.add(`${field} 不是布尔值`); return false }
  return value
}

/** Bounded JSON-like arguments only; never invoke toJSON or stringify an opaque event. */
function argumentsText(value, problems, b) {
  if (typeof value === 'string') return b.text(value)
  const seen = new Set()
  let nodes = 0
  function copy(v, depth) {
    b.work()
    if (++nodes > 20_000) throw capacity()
    if (depth > 32 || typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol' || v === undefined) throw new TypeError('arguments')
    if (typeof v === 'string') return b.text(v)
    if (v === null || typeof v === 'boolean') return v
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('arguments'); return v }
    if (seen.has(v)) throw new TypeError('arguments')
    seen.add(v)
    const out = Array.isArray(v) ? [] : Object.create(null)
    if (Array.isArray(v)) {
      b.work(v.length)
      for (const item of v) out.push(copy(item, depth + 1))
    } else {
      for (const key in v) if (Object.hasOwn(v, key)) { b.text(key); out[key] = copy(v[key], depth + 1) }
    }
    seen.delete(v)
    return out
  }
  try { return b.text(JSON.stringify(copy(value ?? {}, 0))) }
  catch (e) { if (e.status === 413) throw e; problems.add('工具参数不是可展示的 JSON'); return '' }
}

function readVisible(message, problems, b) {
  if (!record(message)) { problems.add('消息结构无效'); return { raw: '', nonText: false } }
  if (!Array.isArray(message.content)) { problems.add('content 不是数组'); return { raw: '', nonText: false } }
  const parts = []
  let nonText = false
  if (message.content.length > MAX_COLLECTION) throw capacity()
  b.work(message.content.length)
  for (const block of message.content) {
    if (!record(block) || typeof block.type !== 'string') { problems.add('content 含无效块'); continue }
    let part = ''
    if (block.type === 'text') {
      if (typeof block.text !== 'string') problems.add('text 不是文本')
      else part = b.text(block.text)
    }
    else if (block.type === 'tool-call') part = b.text(`[调用 ${text(block.name, '工具名', problems, b, '工具')}]\n${argumentsText(block.arguments, problems, b)}`)
    else if (block.type === 'tool-addition' || block.type === 'tool-removal') part = b.text(`[${block.type === 'tool-addition' ? '启用' : '移除'}工具 ${text(block.toolName, '工具名', problems, b)}]`)
    else if (['image', 'image_url', 'audio', 'file'].includes(block.type)) { nonText = true; part = b.text(`[${block.type} 附件：此视图不展开]`) }
    else if (block.type !== 'reasoning') { nonText = true; problems.add('content 含不支持的块类型') }
    if (part) { if (parts.length) b.text('\n\n'); parts.push(part) }
  }
  return { raw: parts.join('\n\n'), nonText }
}

/** Whitelist visible blocks; exclude reasoning, streams, binary and opaque metadata. */
export function visibleText(message) {
  return readVisible(message, new Set(), budget()).raw
}

function entry(e, calls, b) {
  b.row()
  const problems = new Set(), msg = messageOf(e)
  const { raw, nonText } = readVisible(msg, problems, b)
  const sourceData = record(msg?.source) ? msg.source : {}
  if (msg?.source !== undefined && !record(msg.source)) problems.add('source 结构无效')
  const source = text(sourceData.kind, 'source.kind', problems, b)
  const kind = e.type === 'user/message' ? (source === 'user' ? 'user' : 'context') : e.type === 'assistant/message' ? 'assistant' : e.type === 'tool/result' ? 'tool' : 'system'
  const call = e.type === 'tool/result' ? calls.get(msg?.toolCallId) : null
  const changes = array(sourceData.changes, 'changes', problems, b).flatMap(c => {
    if (!record(c) || typeof c.path !== 'string') { problems.add('changes 含无效条目'); return [] }
    return [{ path: b.text(c.path), action: text(c.action, 'changes.action', problems, b) }]
  })
  const refs = array(sourceData.references, 'references', problems, b).flatMap(r => {
    if (!record(r)) { problems.add('references 含无效条目'); return [] }
    return [{ sessionId: text(r.sessionId, 'references.sessionId', problems, b), label: text(r.label, 'references.label', problems, b),
      truncated: boolean(r.truncated, 'references.truncated', problems), omittedMessages: numeric(r.omittedMessages, 'omittedMessages', problems, sequence) ?? 0,
      capturedThroughSeq: numeric(r.capturedThroughSeq, 'capturedThroughSeq', problems, sequence) }]
  })
  const sourceEventSeqs = array(e.sourceEventSeqs, 'sourceEventSeqs', problems, b).filter(seq => {
    if (sequence(seq)) return true
    problems.add('sourceEventSeqs 含无效序号'); return false
  })
  const label = (Object.hasOwn(LABELS, source) ? LABELS[source] : null) || ({ user: '用户要求', assistant: 'AI 回答', tool: '工具结果', system: e.type === 'developer/message' ? '开发者指令' : '系统提示', context: source || '注入上下文' })[kind]
  const args = call ? argumentsText(call.arguments, problems, b) : undefined
  const callName = call ? text(call.name, '工具名', problems, b, '工具') : ''
  const time = numeric(e.time, 'time', problems, v => Number.isFinite(v) && Math.abs(v) <= 8.64e15)
  const isError = boolean(msg?.isError, 'isError', problems), interrupted = boolean(e.data?.interrupted, 'interrupted', problems)
  const row = { seq: e.seq, time, type: e.type, kind, source, label: call ? `${label} · ${callName}` : label,
    text: raw.slice(0, MAX_TEXT), clipped: raw.length > MAX_TEXT, tokens: estimateTokens(raw), changes, refs,
    callSeq: call?.seq, callArguments: args?.slice(0, MAX_TEXT), callArgumentsClipped: (args?.length ?? 0) > MAX_TEXT,
    isError, interrupted, sourceEventSeqs, nonText,
    incomplete: problems.size > 0, issues: [...problems] }
  b.reserve(row)
  return row
}

// Navigation has a separate small budget. Never scan an entire future answer for 140 chars.
function timelineEntry(e) {
  const msg = messageOf(e), parts = []
  let length = 0, incomplete = false
  if (!Array.isArray(msg?.content)) incomplete = true
  else {
    const count = Math.min(msg.content.length, 200)
    for (let i = 0; i < count && length < 140; i++) {
      const block = msg.content[i]
      if (!record(block)) { incomplete = true; continue }
      let part = ''
      if (block.type === 'text') { if (typeof block.text === 'string') part = block.text.slice(0, 140 - length); else incomplete = true }
      else if (block.type === 'tool-call') part = '[工具调用]'
      else if (['image', 'image_url', 'audio', 'file'].includes(block.type)) part = '[附件]'
      else if (!['reasoning', 'tool-addition', 'tool-removal'].includes(block.type)) incomplete = true
      if (part) { parts.push(part); length += part.length + 2 }
    }
    if (msg.content.length > count && length < 140) incomplete = true
  }
  return { seq: e.seq, time: Number.isFinite(e.time) && Math.abs(e.time) <= 8.64e15 ? e.time : undefined,
    turn: sequence(e.data?.turn) ? e.data.turn : undefined, step: sequence(e.data?.step) ? e.data.step : undefined,
    preview: parts.join('\n\n').slice(0, 140) || (incomplete ? '记录损坏，无法生成摘要' : '工具调用或无可见文字'), interrupted: e.data?.interrupted === true, incomplete }
}

/** Fold the selected prefix. Bad content yields explicit partial results; ambiguous order rejects. */
export function inspectLog(log, answerSeq) {
  if (answerSeq != null && !sequence(answerSeq)) throw fail('回答序号必须是非负整数')
  if (!Array.isArray(log?.events)) throw fail('会话 events 不是数组，无法确认历史完整性。', 422)
  const events = log.events
  if (events.length > INSPECT_LIMITS.events) throw capacity()
  // Only inspect envelopes here: bad/oversized future bodies cannot invalidate an old answer.
  const answers = []
  events.forEach((e, index) => { if (record(e) && e.type === 'assistant/message') answers.push({ e, index }) })
  const chosen = answerSeq == null ? answers.at(-1) : answers.find(({ e }) => e.seq === answerSeq)
  if (answerSeq != null && !chosen) throw fail('找不到这次回答，请刷新会话。', 404)
  const target = chosen?.e, endIndex = chosen?.index ?? events.length
  let lastSeq = -1
  for (let i = 0; i < Math.min(endIndex + 1, events.length); i++) {
    const e = events[i]
    if (!record(e) || !sequence(e.seq) || typeof e.type !== 'string' || e.seq <= lastSeq) throw fail(`日志第 ${i + 1} 条事件无效或序号不递增，无法确认历史顺序；未返回上下文快照。`, 422)
    lastSeq = e.seq
  }
  const boundary = target?.seq ?? lastSeq + 1, b = budget()
  const nodes = [], removed = new Map(), calls = new Map(), rows = new Map(), warnings = []
  const flag = (code, title, detail, seq = undefined) => { const w = { code, title, detail, seq }; b.reserve(w); warnings.push(w) }
  let header, route, previousAnswer, since, valid = true, projected = false, malformed = false
  for (let i = 0; i < endIndex; i++) {
    const e = events[i]
    b.work()
    if (e.type === 'request/header' || e.type === 'request/context') {
      const value = e.type === 'request/header' ? e.data?.header : e.data
      if (!record(value) || (e.type === 'request/header' && value.config !== undefined && !record(value.config))) {
        malformed = true; flag('malformed-metadata', '请求元数据结构无效', '无法完整读取本次请求的白名单元数据；正文按历史位置单独检查。', e.seq)
      }
      if (e.type === 'request/header') header = value
      else route = value
    }
    if (e.type === 'image/offload') projected = true
    if (['assistant/attempt', 'llm/retry'].includes(e.type)) since = e
    if (e.type === 'assistant/message') previousAnswer = e
    if (e.type === 'tool/call') {
      if (typeof e.data?.callId === 'string') calls.set(e.data.callId, { seq: e.seq, name: e.data.name, arguments: e.data.arguments })
      else { malformed = true; flag('malformed-event', '工具调用记录不完整', '缺少有效的调用 ID，无法配对调用参数。', e.seq) }
    }
    if (!SURFACE.has(e.type)) continue
    rows.set(e.seq, entry(e, calls, b))
    if (e.surfaceOp === 'append') nodes.push(e.seq)
    else if (e.surfaceOp?.op === 'replace') {
      // Bound indexOf/splice work, not just the final row count.
      b.work(nodes.length * 3)
      const start = nodes.indexOf(e.surfaceOp.startSeq), end = nodes.indexOf(e.surfaceOp.endSeq)
      if (start < 0 || end < start) { valid = false; continue }
      for (const seq of nodes.splice(start, end - start + 1, e.seq)) removed.set(seq, e.seq)
    } else valid = false
  }
  const answer = target ? entry(target, calls, b) : null
  const context = nodes.map(seq => ({ ...rows.get(seq), status: 'active', added: !previousAnswer || seq >= previousAnswer.seq })).filter(r => r.text || r.nonText || r.incomplete)
  const shadowed = [...removed].map(([seq, by]) => ({ ...rows.get(seq), status: 'replaced', replacedBy: by }))
  const activeSeqs = new Set(nodes)
  const unplaced = [...rows.values()].filter(r => !activeSeqs.has(r.seq) && !removed.has(r.seq)).map(r => ({ ...r, status: 'unknown' }))
  if (!valid) flag('surface-unknown', '部分消息的位置无法确认', '日志缺少可识别的 surfaceOp；这些条目放在「位置未知」中，不算作已进入上下文。')
  if (projected) flag('projection', '存在图片卸载记录', '这里只还原消息位置和原始文本，图片替换后的内容没有重放。')
  if (shadowed.length) flag('replaced', `${shadowed.length} 条早期消息已被替换`, '打开「已替换」比较原文和替代消息；摘要可能没有保留你关心的细节。', shadowed[0].replacedBy)
  for (const r of context) {
    if (r.isError) flag('tool-error', '工具返回了错误', '查看结果和调用参数，确认后续结论是否建立在失败的查询上。', r.seq)
    if (r.refs.some(x => x.truncated || x.omittedMessages > 0)) flag('reference-truncated', '引用会话并非完整历史', 'DSH 记录了截断或省略消息；检查缺失部分是否影响本次问题。', r.seq)
    if (r.changes.some(x => x.action === 'replace' || x.action === 'remove')) flag('instruction-change', '指令在会话中发生变化', '检查这次注入的变更内容，以及它和之前约定是否冲突。', r.seq)
  }
  let clipped = false
  for (const r of [...rows.values(), ...(answer ? [answer] : [])]) {
    if (r.incomplete) { malformed = true; flag('malformed-event', '记录含无效或不支持的内容', r.issues.join('；') + '。仅展示可识别部分，不能视为完整上下文。', r.seq) }
    if (r.clipped || r.callArgumentsClipped) { clipped = true; flag('display-clipped', '长内容只展示前 20,000 字符', '正文或调用参数超过展示限制；这不代表模型当时收到的内容被截断。', r.seq) }
  }
  if (target?.data?.interrupted) flag('interrupted', '这次回答被中断', '日志只记录了已输出的部分，请先确认答案是否完整。', target.seq)
  if (since) flag('retry', '此前有未完成尝试或重试', '这是会话日志线索，不代表这次回答一定受到影响。', since.seq)

  const problems = new Set()
  const request = { model: text(header?.config?.model ?? route?.model, 'model', problems, b), provider: text(header?.config?.provider ?? route?.provider, 'provider', problems, b),
    toolCount: header?.tools === undefined ? 0 : array(header.tools, 'tools', problems, b).length,
    contextWindow: numeric(route?.contextWindow, 'contextWindow', problems, v => Number.isSafeInteger(v) && v > 0) }
  const sessionId = text(log?.session?.id, 'session.id', problems, b)
  b.reserve(request); b.reserve(sessionId)
  if (problems.size) { malformed = true; flag('malformed-metadata', '检查元数据不完整', [...problems].join('；') + '。无效字段未展示。') }

  const navigable = answers.filter(({ e }) => sequence(e.seq))
  const chosenAt = Math.max(0, navigable.findIndex(({ e }) => e === target))
  const start = Math.max(0, Math.min(navigable.length - INSPECT_LIMITS.timeline, chosenAt - Math.floor(INSPECT_LIMITS.timeline / 2)))
  const timeline = navigable.slice(start, start + INSPECT_LIMITS.timeline).map(({ e }) => timelineEntry(e))
  const timelineInfo = { total: answers.length, shown: timeline.length, omitted: answers.length - timeline.length, start }
  const timelinePartial = timelineInfo.omitted > 0 || timeline.some(e => e.incomplete)
  // Use the reserved navigation allowance: future damage must not exhaust the prefix budget.
  if (timelinePartial) warnings.push({ code: 'timeline-partial', title: '回答导航为部分结果', detail: `仅列出所选回答附近的 ${timeline.length}/${answers.length} 次输出；无效摘要已标记。这不改变所选回答的历史检查范围。` })
  const contextPartial = !valid || projected || malformed || clipped
  const result = { sessionId, answer, timeline, timelineInfo, boundary, context, shadowed, unplaced, warnings, request,
    partial: contextPartial || timelinePartial, completeness: { context: contextPartial ? 'partial' : 'complete', timeline: timelinePartial ? 'partial' : 'complete' },
    summary: { active: context.length, added: context.filter(r => r.added).length, replaced: shadowed.length, tokens: context.reduce((n, r) => n + r.tokens, 0) },
    limitation: (contextPartial ? '部分结果：内容、位置或投影未能完整还原，请勿将此视图视为完整上下文。' : '') + '依据回答前的日志重建消息位置，供核对输入来源；不是供应商最终请求包，也不能证明模型为何作出某个判断。token 为可见内容估算，不含隐藏推理和完整附件。' }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > INSPECT_LIMITS.responseBytes) throw capacity()
  return result
}

export async function inspectSession(query, id, seq) {
  if (typeof query?.readSession !== 'function') throw fail('当前 DSH 没有 readSession 能力，无法检查历史上下文。', 503)
  if (seq != null && (!Number.isSafeInteger(seq) || seq < 0)) throw fail('回答序号必须是非负整数')
  return inspectLog(await query.readSession(id), seq)
}
