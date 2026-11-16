// @ts-check
/** Read-only input provenance. Edges express recorded relationships, never model causality. */
import { contextView, contextRecord } from './context-view.js'

export const FLOW_LIMITS = Object.freeze({ page: 12, anchors: 28, edges: 100, guidance: 8 })
const scopes = new Set(['changes', 'active', 'replaced', 'issues', 'unknown'])
const fail = text => Object.assign(new Error(text), { status: 400 })
const validSeq = n => Number.isSafeInteger(n) && n >= 0
const cut = (s, n = 200) => typeof s === 'string' ? s.slice(0, n) : ''

/** Match provider call IDs, never adjacent sequence numbers. A reused ID needs
 * matching batch metadata; ambiguous or budget-limited evidence draws no edge. */
function callOrigins(index, nodes) {
  const calls = new Map(), byId = new Map(), origins = new Map()
  for (const n of nodes) {
    const call = index.rows.get(n.seq)?.call
    if (!call || calls.has(call.seq) || typeof call.data?.callId !== 'string' || !call.data.callId) continue
    calls.set(call.seq, call)
    const list = byId.get(call.data.callId) || []
    list.push(call); byId.set(call.data.callId, list)
  }
  let work = 0
  for (const { e } of index.rows.values()) {
    if (!calls.size) break
    if (e.type !== 'assistant/message' || !Array.isArray(e.data?.message?.content)) continue
    for (const block of e.data.message.content) {
      if (++work > 100000) return { origins: new Map(), omitted: calls.size }
      if (block?.type !== 'tool-call' || typeof block.id !== 'string') continue
      for (const call of byId.get(block.id) || []) {
        if (e.seq >= call.seq || (typeof block.name === 'string' && typeof call.data.name === 'string' && block.name !== call.data.name)) continue
        if (['turn', 'step'].some(k => validSeq(e.data[k]) && validSeq(call.data[k]) && e.data[k] !== call.data[k])) continue
        origins.set(call.seq, origins.has(call.seq) ? null : e.seq)
      }
    }
  }
  return { origins, omitted: [...origins.values()].filter(x => x === null).length }
}

export function contextFlow(current, previous, options = {}) {
  const scope = options.scope || 'changes'
  if (!scopes.has(scope)) throw fail('未知的流转范围')
  if (options.page != null && !validSeq(options.page)) throw fail('页码无效')
  if (options.focus != null && !validSeq(options.focus)) throw fail('定位事件无效')
  const base = contextView(current)
  const available = current.available && (!previous || previous.available)
  const before = new Set(previous?.active || []), now = new Set(current.active)
  const added = available ? current.active.filter(seq => !before.has(seq)) : []
  const removed = available ? [...before].filter(seq => !now.has(seq)) : []
  const retained = available ? current.active.filter(seq => before.has(seq)) : []
  const addedSet = new Set(added), removedSet = new Set(removed)
  const ordered = [...current.active, ...[...current.rows.keys()].filter(seq => !now.has(seq))]
  // Metadata scans are bounded inside contextRecord; bodies stay unmaterialized.
  // Avoid reading previews for every record: records only need their full whitelist on the visible page.
  const changed = [...added, ...removed]
  const query = cut(options.q).trim().toLowerCase()
  const cached = new Map()
  const row = seq => { if (!cached.has(seq)) cached.set(seq, contextRecord(current, seq)); return cached.get(seq) }
  const issueSeqs = []
  // contextView has already inspected bounded metadata. Only ask for it here without previews.
  for (const seq of ordered) {
    const r = contextRecord(current, seq, false)
    if (r?.issueCount) issueSeqs.push(seq)
  }
  let candidates = !available ? [] : scope === 'changes' ? changed : scope === 'active' ? current.active :
    scope === 'replaced' ? ordered.filter(seq => current.rows.get(seq).status === 'replaced') :
    scope === 'unknown' ? ordered.filter(seq => current.rows.get(seq).status === 'unknown') : issueSeqs
  if (options.module && !base.modules.some(m => m.id === options.module)) throw fail('未知的上下文模块')
  if (options.module || query) candidates = candidates.filter(seq => {
    const r = row(seq)
    return (!options.module || r.module === options.module) && (!query || `${r.label} ${r.preview}`.toLowerCase().includes(query))
  })
  const pages = Math.ceil(candidates.length / FLOW_LIMITS.page)
  const found = options.focus == null ? -1 : candidates.indexOf(options.focus)
  const page = found >= 0 ? Math.floor(found / FLOW_LIMITS.page) : Math.min(options.page || 0, Math.max(0, pages - 1))
  const nodes = candidates.slice(page * FLOW_LIMITS.page, (page + 1) * FLOW_LIMITS.page).map(seq => {
    const r = row(seq), change = r.status === 'unknown' ? 'unknown' : removedSet.has(seq) ? 'removed' :
      r.status === 'replaced' ? 'replaced' : addedSet.has(seq) ? 'added' : 'retained'
    return { ...r, id: `event:${seq}`, change, canInspect: true,
      lane: change === 'removed' || change === 'replaced' ? 'removed' : change === 'unknown' ? 'unknown' : r.module === 'tools' ? 'tool' : r.module === 'history' ? 'history' : 'input' }
  })
  const anchors = [], edges = [], known = new Set(nodes.map(n => n.id)), edgeKeys = new Set()
  let omittedRelations = 0
  const answerId = current.answer ? `answer:${current.answer.seq}` : 'answer:pending'
  function anchor(a) {
    if (known.has(a.id)) return true
    if (anchors.length >= FLOW_LIMITS.anchors) { omittedRelations++; return false }
    anchors.push(a); known.add(a.id); return true
  }
  function eventAnchor(seq, kind = 'source') {
    const id = `event:${seq}`
    if (known.has(id)) return id
    const r = row(seq)
    if (!r) { omittedRelations++; return null }
    return anchor({ id, seq, label: r.label, preview: r.preview, kind, canInspect: true, status: r.status }) ? id : null
  }
  function edge(from, to, kind, label) {
    if (!from || !to || from === to) return
    const id = JSON.stringify([from, to, kind])
    if (edgeKeys.has(id)) return
    if (!known.has(from) || !known.has(to) || edges.length >= FLOW_LIMITS.edges) { omittedRelations++; return }
    edges.push({ id, from, to, kind, label }); edgeKeys.add(id)
  }
  anchor({ id: answerId, seq: current.answer?.seq, kind: 'answer', label: current.answer ? '正在检查的回答' : '尚未生成回答', preview: current.answer?.preview || '', canInspect: !!current.answer })
  if (previous?.answer) {
    const seq = previous.answer.seq
    if (!known.has(`event:${seq}`)) anchor({ id: `event:${seq}`, seq, kind: 'baseline', label: '上次回答 · 比较起点', preview: previous.answer.preview, canInspect: current.rows.has(seq) })
  }
  const requests = callOrigins(current, nodes)
  omittedRelations += requests.omitted
  for (const n of nodes) {
    omittedRelations += n.omittedReferences || 0
    if (n.status === 'active') edge(n.id, answerId, 'input', n.change === 'retained' ? '沿用到本步' : '本步输入')
    if (n.callSeq != null) {
      const callId = eventAnchor(n.callSeq, 'call')
      edge(callId, n.id, 'call', '调用 → 返回')
      const origin = requests.origins.get(n.callSeq)
      if (origin != null) edge(eventAnchor(origin), callId, 'request', '请求调用 · ID 对应')
    }
    if (n.replacedBy != null) edge(n.id, eventAnchor(n.replacedBy), 'replace', '被替换为')
    for (const seq of n.sourceEventSeqs) {
      if (seq >= n.seq) { omittedRelations++; continue }
      edge(eventAnchor(seq), n.id, 'source', '记录来源')
    }
    for (const ref of n.refs) {
      if (!ref.sessionId) { omittedRelations++; continue }
      const id = `reference:${ref.sessionId}:${n.seq}`
      if (anchor({ id, kind: 'reference', label: ref.label || '引用会话', sessionId: ref.sessionId,
        preview: ref.truncated || ref.omittedMessages ? '引用快照有省略；先核对本次实际注入的原文' : '引用的是当时快照，不代表对方会话的最新全文', canInspect: false })) edge(id, n.id, 'reference', '引用快照')
    }
  }
  const guidance = []
  function guide(g) { if (guidance.length < FLOW_LIMITS.guidance) guidance.push(g) }
  if (current.answer?.issues.length) guide({ id: 'answer', title: '先核对这条回答', detail: current.answer.issues.join('；'), severity: 'warning', scope: 'changes', eventSeq: current.answer.seq })
  for (const seq of issueSeqs.slice(-5).reverse()) {
    const r = row(seq)
    guide({ id: `issue:${seq}`, title: `${r.label} · #${seq}`, detail: r.issues.join('；'), severity: 'warning', scope: 'issues', eventSeq: seq })
  }
  if (removed.length) guide({ id: 'removed', title: `${removed.length} 条旧输入被替换`, detail: '检查原约束是否在替代内容中保留；结构替换本身不说明内容错误。', severity: 'info', scope: 'changes', eventSeq: removed[0] })
  if (base.summary.unknown) guide({ id: 'unknown', title: `${base.summary.unknown} 条记录位置未知`, detail: '日志无法确认这些记录是否位于本次输入中，应先核对来源。', severity: 'warning', scope: 'unknown' })
  if (available) {
    guide({ id: 'changes', title: previous ? `这一步新增 ${added.length} 条输入` : '从最初的要求开始核对', detail: previous ? '先比较上次回答后出现的证据，检查偏差是否从这里开始。上次回答也属于新增输入。' : '把回答与用户要求逐项对照，再检查项目约定和引用证据。', severity: 'info', scope: 'changes' })
    guide({ id: 'requirements', title: '关键要求在输入里吗？', detail: '打开实际原文，核对被忽略的约束；没有自动线索不代表回答正确。', severity: 'info', scope: 'active', module: 'requirements' })
  }
  if (!available) guide({ id: 'capacity', title: '暂不能比较本步变化', detail: '所选历史超出结构索引保护范围；选择更早的回答，或先查看答案原文。', severity: 'warning', scope: 'changes' })
  return { ...base, flow: { baseline: previous?.answer || null, comparison: { available, first: !previous,
    added: available ? added.length : null, retained: available ? retained.length : null, removed: available ? removed.length : null, unknown: base.summary.unknown, issues: issueSeqs.length },
    scope, page: { index: page, size: FLOW_LIMITS.page, total: candidates.length, pages }, focusFound: options.focus == null ? null : found >= 0,
    nodes, anchors, edges, omittedRelations, guidance,
    legend: '实线表示日志中本步输入或明确的调用来源；替换边表示原记录退出输入。连线不表示模型内部因果；图按页展示。' } }
}
