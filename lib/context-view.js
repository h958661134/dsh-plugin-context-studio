// @ts-check
/** A structural index plus bounded source pages. Never concatenate the entire
 * history just to show its table of contents. All body text remains read-only. */
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { estimateTokens } from './tokens.js'

export const VIEW_LIMITS = Object.freeze({ events: 250000, records: 16, text: 12000, timeline: 80, blocks: 100000 })
export const MODULES = [
  { id: 'requirements', label: '用户要求', description: '这次任务想做什么，哪些约束必须遵守' },
  { id: 'memory', label: '项目约定', description: '当时加载的 AGENTS / CLAUDE 等项目规则' },
  { id: 'references', label: '引用会话', description: '从其他会话带进来的背景与结论' },
  { id: 'tools', label: '工具结果', description: '实际查到了什么，调用有没有失败' },
  { id: 'history', label: '历史回答', description: '此前的输出和工具调用，可能延续的判断' },
  { id: 'skills', label: '技能', description: '技能目录与调用时注入的步骤' },
  { id: 'system', label: '系统与环境', description: '系统提示、运行环境、时间等自动背景' },
  { id: 'other', label: '其他上下文', description: '其他插件或来源未识别的注入内容' },
]
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const record = x => !!x && typeof x === 'object' && !Array.isArray(x)
const seqOK = n => Number.isSafeInteger(n) && n >= 0
const cut = (x, max = 300) => typeof x === 'string' ? x.slice(0, max) : ''
const arr = x => Array.isArray(x) ? x : []
const message = e => e.type === 'user/message' ? e.data : SURFACE.has(e.type) ? e.data?.message : null
const safeTime = t => Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? t : undefined
function provenanceIssues(e) {
  const source = message(e)?.source, issues = []
  const invalid = (item, fields) => Object.entries(fields).some(([key, check]) => item[key] != null && !check(item[key]))
  const string = x => typeof x === 'string', boolean = x => typeof x === 'boolean'
  for (const [label, value] of [['变更来源', source?.changes], ['引用来源', source?.references], ['来源事件', e.sourceEventSeqs]]) {
    if (value != null && (!Array.isArray(value) || value.slice(0, 50).some(x => label === '来源事件' ? !seqOK(x) : !record(x) || invalid(x, label === '变更来源' ? { path: string, action: string } : { sessionId: string, label: string, truncated: boolean, omittedMessages: seqOK, capturedThroughSeq: seqOK })))) issues.push(`${label}格式异常，关联信息可能不完整`)
  }
  return issues
}

function classify(e) {
  if (e.type === 'tool/call') return ['tools', 'tool', '工具调用']
  if (e.type === 'tool/result') return ['tools', 'tool', '工具结果']
  if (e.type === 'assistant/message') return ['history', 'assistant', '历史回答']
  if (e.type === 'system/message' || e.type === 'developer/message') return ['system', 'system', e.type === 'system/message' ? '系统提示' : '开发者指令']
  const source = message(e)?.source?.kind
  if (source === 'user') return ['requirements', 'user', '用户要求']
  if (source === 'agent-instructions') return ['memory', 'context', '项目约定']
  if (source === 'session-reference') return ['references', 'context', '引用会话']
  if (source === 'skill-catalog' || source === 'skill-invocation') return ['skills', 'context', source === 'skill-catalog' ? '技能目录' : '技能步骤']
  if (['runtime-context', 'time-context', 'tool-registry'].includes(source)) return ['system', 'context', { 'runtime-context': '运行环境', 'time-context': '时间信息', 'tool-registry': '工具目录' }[source]]
  return ['other', 'context', cut(source, 80) || '其他注入']
}

/** Cheap preview: stop as soon as enough visible text is available. */
function preview(e, limit = 220) {
  const blocks = arr(message(e)?.content)
  let out = ''
  for (let i = 0; i < Math.min(blocks.length, 100) && out.length < limit; i++) {
    const b = blocks[i]
    if (!record(b)) continue
    const value = b.type === 'text' ? cut(b.text, limit - out.length) : b.type === 'tool-call' ? `[调用 ${cut(b.name, 60) || '工具'}]` : ['image', 'image_url', 'audio', 'file'].includes(b.type) ? '[附件]' : ''
    if (value) out += (out ? '\n' : '') + value
  }
  return out.slice(0, limit)
}

function metadata(e, call, status = 'unknown', withPreview = true) {
  const msg = message(e), [module, kind, name] = classify(e), source = msg?.source, issues = provenanceIssues(e)
  if (e.type === 'assistant/message' && e.data?.interrupted === true) issues.push('回答曾中断，请核对是否完整')
  if (e.type !== 'tool/call' && (!record(msg) || !Array.isArray(msg.content))) issues.push('消息正文格式异常，打开原文核对')
  if (msg?.isError === true) issues.push('工具返回错误')
  if (arr(source?.references).slice(0, 50).some(r => r?.truncated === true || (seqOK(r?.omittedMessages) && r.omittedMessages > 0))) issues.push('引用内容有截断或省略')
  if (arr(source?.changes).slice(0, 50).some(c => c?.action === 'replace' || c?.action === 'remove')) issues.push('项目约定发生变更')
  if (arr(source?.references).length > 30 || arr(source?.changes).length > 30 || arr(e.sourceEventSeqs).length > 50) issues.push('来源关联较多，仅检查和展示有限项')
  return { seq: e.seq, time: safeTime(e.time), kind, source: cut(source?.kind, 100), module,
    label: call ? `${name} · ${cut(call.data?.name, 80) || '工具'}` : name, preview: withPreview ? preview(e) : '', status, added: false,
    callSeq: call?.seq, issueCount: issues.length, issues }
}

function navigation(answers, selected) {
  const at = Math.max(0, answers.findIndex(x => x.e === selected))
  const start = Math.max(0, Math.min(answers.length - VIEW_LIMITS.timeline, at - Math.floor(VIEW_LIMITS.timeline / 2)))
  const timeline = answers.slice(start, start + VIEW_LIMITS.timeline).map(({ e }, i) => ({ seq: e.seq, time: safeTime(e.time), turn: seqOK(e.data?.turn) ? e.data.turn : undefined, step: seqOK(e.data?.step) ? e.data.step : undefined, preview: preview(e, 140), interrupted: e.data?.interrupted === true, index: start + i + 1 }))
  return { timeline, timelineInfo: { total: answers.length, start, shown: timeline.length,
    previousSeq: answers[at - 1]?.e.seq ?? null, nextSeq: answers[at + 1]?.e.seq ?? null,
    firstSeq: answers[0]?.e.seq ?? null, lastSeq: answers.at(-1)?.e.seq ?? null,
    earlierWindowSeq: start > 0 ? answers[Math.max(0, start - VIEW_LIMITS.timeline)]?.e.seq : null,
    laterWindowSeq: start + timeline.length < answers.length ? answers[start + timeline.length]?.e.seq : null } }
}

/** Fold only positions, retaining references into the immutable query snapshot.
 * Replacements use linked positions so valid replacement work is amortized linear. */
export async function indexContext(log, answerSeq) {
  if (answerSeq != null && !seqOK(answerSeq)) throw fail('回答序号无效')
  if (!Array.isArray(log?.events)) throw fail('会话没有可读取的事件目录', 422)
  const events = log.events, answers = []
  for (let i = 0; i < events.length; i++) {
    if (i % 2048 === 0) await yieldTurn()
    const e = events[i]
    if (record(e) && e.type === 'assistant/message' && seqOK(e.seq)) answers.push({ e, index: i })
  }
  const chosen = answerSeq == null ? answers.at(-1) : answers.find(a => a.e.seq === answerSeq)
  if (answerSeq != null && !chosen) throw fail('这次回答不存在，请刷新目录', 404)
  const target = chosen?.e, end = chosen?.index ?? events.length
  const nav = navigation(answers, target)
  const result = { sessionId: cut(log.session?.id, 200), target, answer: target ? { ...metadata(target, null, 'answer'), label: '本次回答', turn: seqOK(target.data?.turn) ? target.data.turn : undefined, step: seqOK(target.data?.step) ? target.data.step : undefined, preview: preview(target, 500) } : null,
    boundary: target?.seq ?? (events.at(-1)?.seq ?? -1) + 1, ...nav, rows: new Map(), active: [], calls: new Map(), warnings: [], available: true }
  if (end > VIEW_LIMITS.events) {
    result.available = false
    result.warnings.push({ code: 'index-limit', title: '本次回答前的事件目录过大', detail: '正文没有被截断或删除。请选择上方更早的回答，仍可查看它和最近回答的原文；当前模块计数暂不可用。' })
    return result
  }
  let last = -1, head = null, tail = null, previousAnswer = -1, work = 0
  const positions = new Map()
  for (let i = 0; i <= end && i < events.length; i++) {
    if (i % 2048 === 0) await yieldTurn()
    const e = events[i]
    if (!record(e) || !seqOK(e.seq) || e.seq <= last || typeof e.type !== 'string') throw fail(`事件 ${i + 1} 的顺序无法确认，未推测上下文位置`, 422)
    last = e.seq
    if (i === end) break
    if (e.type === 'image/offload' && !result.warnings.some(w => w.code === 'projection')) result.warnings.push({ code: 'projection', title: '包含附件投影', detail: '目录只还原消息位置，附件及供应商投影没有展开。' })
    if (e.type === 'tool/call' && typeof e.data?.callId === 'string') result.calls.set(e.data.callId, e)
    if (!SURFACE.has(e.type)) continue
    const call = e.type === 'tool/result' ? result.calls.get(message(e)?.toolCallId) : null
    const row = { e, call, status: 'unknown', replacedBy: undefined, added: false }
    result.rows.set(e.seq, row)
    if (e.surfaceOp === 'append') {
      positions.set(e.seq, { prev: tail, next: null, active: true })
      if (tail !== null) positions.get(tail).next = e.seq
      else head = e.seq
      tail = e.seq; row.status = 'active'
    } else if (e.surfaceOp?.op === 'replace') {
      const a = positions.get(e.surfaceOp.startSeq), z = positions.get(e.surfaceOp.endSeq)
      if (a?.active && z?.active) {
        const replaced = []; let cur = e.surfaceOp.startSeq
        while (cur !== null && ++work < VIEW_LIMITS.events * 4) {
          replaced.push(cur)
          if (cur === e.surfaceOp.endSeq) break
          cur = positions.get(cur)?.next ?? null
        }
        if (replaced.at(-1) === e.surfaceOp.endSeq) {
          const before = a.prev, after = z.next
          positions.set(e.seq, { prev: before, next: after, active: true })
          if (before !== null) positions.get(before).next = e.seq; else head = e.seq
          if (after !== null) positions.get(after).prev = e.seq; else tail = e.seq
          for (const seq of replaced) { positions.get(seq).active = false; Object.assign(result.rows.get(seq), { status: 'replaced', replacedBy: e.seq }) }
          row.status = 'active'
        }
      }
    }
    if (e.type === 'assistant/message') previousAnswer = e.seq
  }
  for (let cur = head; cur !== null; cur = positions.get(cur).next) result.active.push(cur)
  for (const row of result.rows.values()) row.added = row.e.seq >= previousAnswer
  if ([...result.rows.values()].some(r => r.status === 'unknown')) result.warnings.push({ code: 'position', title: '部分记录的位置未知', detail: '这些记录放在“位置未知”中，不计作已进入本次输入。' })
  return result
}

const limitation = '依据日志还原本次回答前的消息位置；模块目录和原文按需加载，不是供应商最终请求，也不能证明模型的内部判断原因。'
export function contextView(index, options = {}) {
  const state = options.state ?? 'active'
  if (!['active', 'replaced', 'unknown'].includes(state)) throw fail('未知的记录状态')
  const counts = new Map(MODULES.map(m => [m.id, { ...m, active: 0, replaced: 0, unknown: 0, issues: 0 }]))
  const order = [...index.active, ...[...index.rows.keys()].filter(seq => index.rows.get(seq).status !== 'active')]
  const summary = { available: index.available, active: 0, replaced: 0, unknown: 0, added: 0 }, issues = []
  let issueTotal = 0
  for (const seq of order) {
    const r = index.rows.get(seq), m = metadata(r.e, r.call, r.status, false)
    const count = counts.get(m.module); count[m.status]++; count.issues += m.issueCount
    summary[m.status]++; if (r.status === 'active' && r.added) summary.added++
    if (m.issueCount) { issueTotal++; if (issues.length < 12) issues.push(m) }
  }
  const modules = [...counts.values()]
  const module = options.module || modules.find(m => m.id === 'requirements' && m.active)?.id || modules.find(m => m.active)?.id || 'requirements'
  if (!counts.has(module)) throw fail('未知的上下文模块')
  const q = cut(options.q, 200).toLowerCase()
  const matching = order.filter(seq => { const r = index.rows.get(seq); if (classify(r.e)[0] !== module || r.status !== state) return false; return !q || `${metadata(r.e, r.call, r.status, false).label} ${preview(r.e)}`.toLowerCase().includes(q) })
  const pages = Math.ceil(matching.length / VIEW_LIMITS.records)
  const page = Math.min(options.page ?? 0, Math.max(0, pages - 1))
  if (!seqOK(page)) throw fail('页码无效')
  const items = matching.slice(page * VIEW_LIMITS.records, (page + 1) * VIEW_LIMITS.records).map(seq => { const r = index.rows.get(seq); return { ...metadata(r.e, r.call, r.status), replacedBy: r.replacedBy, added: r.added } })
  const warnings = index.warnings.slice()
  if (index.answer?.issues.length) warnings.push({ code: 'answer-issue', title: '本次回答需要核对', detail: index.answer.issues.join('；'), seq: index.answer.seq })
  if (issues.length) warnings.push(...issues.slice(0, 12).map(r => ({ code: 'source-issue', title: r.label, detail: r.issues.join('；'), seq: r.seq })))
  if (issueTotal > 12) warnings.push({ code: 'more-issues', title: '还有其他待核对记录', detail: `${issueTotal} 条记录含线索，可按模块逐条核对；首页最多展示 12 条。` })
  return { sessionId: index.sessionId, boundary: index.boundary, observedAt: index.observedAt ?? Date.now(), answer: index.answer, timeline: index.timeline, timelineInfo: index.timelineInfo,
    modules, summary,
    page: { module, state, index: page, size: VIEW_LIMITS.records, total: matching.length, pages, items }, warnings, partial: !index.available || index.warnings.length > 0,
    limitation: `${limitation} 搜索仅匹配目录标题与预览；没有把分页当作历史被截断。` }
}

/** Structured arguments are bounded; string arguments (the usual DSH format)
 * retain their original length and are paged without stringify or truncation. */
function argumentSource(value, notices, budget = { nodes: 0, chars: 0 }) {
  if (typeof value === 'string') return value
  if (value == null) return ''
  const seen = new Set()
  function copy(v, depth) {
    if (++budget.nodes > 2000 || depth > 16) throw Error('size')
    if (typeof v === 'string') { budget.chars += v.length; if (budget.chars > 100000) throw Error('size'); return v }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v
    if (!record(v) && !Array.isArray(v)) throw Error('type')
    if (seen.has(v)) throw Error('cycle'); seen.add(v)
    const out = Array.isArray(v) ? [] : Object.create(null)
    for (const key in v) if (Object.hasOwn(v, key)) { budget.chars += key.length; if (budget.chars > 100000) throw Error('size'); out[key] = copy(v[key], depth + 1) }
    seen.delete(v); return out
  }
  try { return JSON.stringify(copy(value, 0), null, 2) } catch { notices.add('对象形式的调用参数超过累计保护预算或格式不支持，未展开；字符串原文仍可分页。'); return '[调用参数未展开]' }
}

/** Read only a slice of a virtual concatenation; text blocks are never joined whole. */
export function sourcePage(e, offset = 0, part = 'body', call = null) {
  if (!seqOK(offset)) throw fail('原文偏移无效')
  if (!['body', 'arguments'].includes(part)) throw fail('原文部分无效')
  const notices = new Set(), chunks = [], windowStart = Math.max(0, offset - 1), previousStart = Math.max(0, offset - VIEW_LIMITS.text), argumentBudget = { nodes: 0, chars: 0 }
  let previousChar = '', previousBefore = ''
  let total = 0, segmentCount = 0
  function segment(s) {
    if (!s) return
    if (segmentCount++) emit('\n\n')
    emit(s)
  }
  function emit(s) {
    const start = total; total += s.length
    const a = Math.max(0, windowStart - start), b = Math.min(s.length, offset + VIEW_LIMITS.text + 1 - start)
    if (b > a) chunks.push(s.slice(a, b))
    if (previousStart >= start && previousStart < total) previousChar = s[previousStart - start]
    if (previousStart - 1 >= start && previousStart - 1 < total) previousBefore = s[previousStart - 1 - start]
  }
  if (part === 'arguments') segment(argumentSource(call?.data?.arguments, notices, argumentBudget))
  else if (e.type === 'tool/call') { segment(`[调用 ${cut(e.data?.name, 100) || '工具'}]`); segment(argumentSource(e.data?.arguments, notices, argumentBudget)) }
  else {
    const msg = message(e)
    if (!Array.isArray(msg?.content)) notices.add('正文格式异常，未猜测内容。')
    const blocks = arr(msg?.content)
    for (let i = 0; i < Math.min(blocks.length, VIEW_LIMITS.blocks); i++) {
      const b = blocks[i]
      if (!record(b)) { notices.add('原文含无效内容块，仅展示可识别部分。'); continue }
      if (b.type === 'text') { if (typeof b.text === 'string') segment(b.text); else notices.add('文本块格式无效。') }
      else if (b.type === 'tool-call') { segment(`[调用 ${cut(b.name, 100) || '工具'}]`); segment(argumentSource(b.arguments, notices, argumentBudget)) }
      else if (b.type === 'tool-addition' || b.type === 'tool-removal') segment(`[${b.type === 'tool-addition' ? '启用' : '移除'}工具 ${cut(b.toolName, 100)}]`)
      else if (['image', 'image_url', 'audio', 'file'].includes(b.type)) { segment(`[${b.type} 附件：未展开]`); notices.add('附件不在此文本视图中展开。') }
      else if (b.type !== 'reasoning') notices.add('有不支持的内容块，未作为可见原文展示。')
    }
    if (blocks.length > VIEW_LIMITS.blocks) notices.add('单条消息内容块超过目录保护上限，后续块未展开。')
  }
  if (offset > total) throw fail('原文页已超出范围，请回到第一页', 416)
  const buffer = chunks.join(''), high = c => c >= '\ud800' && c <= '\udbff', low = c => c >= '\udc00' && c <= '\udfff'
  let a = offset - windowStart
  if (a > 0 && low(buffer[a]) && high(buffer[a - 1])) a--
  let b = Math.min(buffer.length, a + VIEW_LIMITS.text)
  if (b < buffer.length && high(buffer[b - 1]) && low(buffer[b])) b--
  const text = buffer.slice(a, b), actualOffset = windowStart + a
  return { text, offset: actualOffset, totalChars: total, nextOffset: actualOffset + text.length < total ? actualOffset + text.length : null,
    previousOffset: actualOffset > 0 ? previousStart + (low(previousChar) && high(previousBefore) ? 1 : 0) : null, part, incomplete: notices.size > 0, notices: [...notices] }
}

export function contextDetail(index, eventSeq, offset = 0, part = 'body') {
  if (!seqOK(eventSeq)) throw fail('原文事件编号无效')
  let item = index.target?.seq === eventSeq ? { e: index.target, status: 'answer', call: null } : index.rows.get(eventSeq)
  if (!item) { const call = [...index.calls.values()].find(e => e.seq === eventSeq); if (call) item = { e: call, status: 'source', call } }
  if (!item) throw fail('这条原文不在所选回答的可查看范围内', 404)
  const { e, call } = item, source = message(e)?.source
  if (part === 'arguments' && !call) throw fail('这条记录没有独立调用参数', 404)
  const page = sourcePage(e, offset, part, call)
  const row = { ...metadata(e, call, item.status), added: item.added ?? false, replacedBy: item.replacedBy,
    changes: arr(source?.changes).slice(0, 30).filter(record).map(c => ({ path: cut(c.path, 500), action: cut(c.action, 80) })),
    refs: arr(source?.references).slice(0, 30).filter(record).map(r => ({ sessionId: cut(r.sessionId, 200), label: cut(r.label, 300), truncated: r.truncated === true, omittedMessages: seqOK(r.omittedMessages) ? r.omittedMessages : 0, capturedThroughSeq: seqOK(r.capturedThroughSeq) ? r.capturedThroughSeq : undefined })),
    sourceEventSeqs: arr(e.sourceEventSeqs).slice(0, 50).filter(seqOK), text: page.text, textOffset: page.offset, sourcePart: part, tokens: estimateTokens(page.text), clipped: page.offset > 0 || page.nextOffset !== null }
  const invalidSource = provenanceIssues(e)
  if (invalidSource.length) { page.incomplete = true; page.notices.push(...invalidSource) }
  if (arr(source?.changes).length > 30 || arr(source?.references).length > 30 || arr(e.sourceEventSeqs).length > 50) { page.incomplete = true; page.notices.push('来源关联仅展示前若干项；正文分页范围不受影响。') }
  return { ...page, row, hasArguments: !!call, argumentsPreview: call ? cut(typeof call.data?.arguments === 'string' ? call.data.arguments : '[对象参数，点击查看]', 300) : '' }
}

/** Two short-lived snapshots. Never store source history in browser storage. */
export function createContextReader(getQuery, { ttlMs = 10000, maxEntries = 2, now = Date.now, identity = getQuery } = {}) {
  const cache = new Map()
  let owner
  function evict(id) { const old = cache.get(id); if (old?.timer) clearTimeout(old.timer); cache.delete(id) }
  async function load(id, refresh) {
    const current = identity()
    if (current !== owner) { for (const key of cache.keys()) evict(key); owner = current }
    let value = cache.get(id)
    if (value && value.until > now() && (!refresh || value.pending)) return value.promise
    const query = getQuery()
    if (typeof query?.readSession !== 'function') throw fail('宿主暂时没有会话读取服务', 503)
    value = { pending: true, until: now() + ttlMs, promise: null, timer: null }
    value.promise = Promise.resolve().then(() => query.readSession(id)).then(log => {
      value.pending = false; value.until = now() + ttlMs
      if (cache.get(id) === value) { value.timer = setTimeout(() => evict(id), ttlMs); value.timer.unref?.() }
      return { log, observedAt: now() }
    }, e => { if (cache.get(id) === value) evict(id); throw e })
    evict(id); cache.set(id, value)
    while (cache.size > maxEntries) evict(cache.keys().next().value)
    return value.promise
  }
  async function index(id, answer, refresh = false) { const data = await load(id, refresh); return Object.assign(await indexContext(data.log, answer), { observedAt: data.observedAt }) }
  return { async view(id, options = {}) { return contextView(await index(id, options.answer, options.refresh), options) },
    async detail(id, options) { return contextDetail(await index(id, options.answer), options.event, options.offset, options.part) } }
}
