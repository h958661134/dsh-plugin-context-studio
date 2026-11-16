/** Independent v1.4 flow review. Only synthetic snapshots and local pure handlers. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexContext, contextDetail, createContextReader, VIEW_LIMITS } from '../lib/context-view.js'
import { contextFlow, FLOW_LIMITS } from '../lib/context-flow.js'
import { createHandlers, resolveConfig } from '../lib/host.js'

const msg = (seq, type, text, source = { kind: 'user' }, extra = {}) => ({ seq, type, surfaceOp: 'append', data: type === 'user/message' ? { content: [{ type: 'text', text }], source } : { turn: 1, step: 1, message: { content: [{ type: 'text', text }], source } }, ...extra })
const log = events => ({ session: { id: 'synthetic-flow' }, events })
const call = (seq, id = 'call', extra = {}) => ({ seq, type: 'tool/call', data: { turn: 1, step: 1, callId: id, name: 'read', arguments: 'PUBLIC_ARGUMENTS', ...extra } })
async function compare(events, answer, options = {}) {
  const query = { readSession: async () => log(events) }
  return createContextReader(() => query).compare('synthetic-flow', { answer, ...options }, contextFlow)
}
function fixture() {
  const result = msg(5, 'tool/result', 'result'); result.data.message.toolCallId = 'call'; result.sourceEventSeqs = [4]
  return [msg(0, 'system/message', 'old rule'), msg(1, 'user/message', 'question'), msg(2, 'assistant/message', 'previous answer'),
    msg(3, 'system/message', 'new rule', {}, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }),
    call(4), result, msg(6, 'user/message', 'reference excerpt', { kind: 'session-reference', references: [{ sessionId: 'other', label: 'Referenced session' }] }),
    msg(7, 'assistant/message', 'selected answer'), msg(8, 'user/message', 'future input'), msg(9, 'assistant/message', 'future answer')]
}

test('flow review: comparison is against inputs BEFORE previous answer, not its output-inclusive prefix', async () => {
  const result = await compare(fixture(), 7)
  assert.equal(result.flow.baseline.seq, 2)
  assert.deepEqual(result.flow.comparison, { available: true, first: false, added: 4, retained: 1, removed: 1, unknown: 0, issues: 0 })
  const changes = new Map(result.flow.nodes.map(n => [n.seq, n.change]))
  assert.deepEqual(changes, new Map([[3, 'added'], [2, 'added'], [5, 'added'], [6, 'added'], [0, 'removed']]))
  assert.equal(changes.has(1), false, 'unchanged input is excluded by changes scope')
  assert.equal(changes.has(7), false, 'selected answer is not part of its own input')
  assert.equal(changes.has(8), false, 'future input cannot leak into the chosen prefix')
  const first = await compare(fixture(), 2)
  assert.equal(first.flow.baseline, null)
  assert.deepEqual(first.flow.comparison, { available: true, first: true, added: 2, retained: 0, removed: 0, unknown: 0, issues: 0 })
})

test('flow review: input/source/call/replacement/reference edges are distinct and all endpoints resolve', async () => {
  const flow = (await compare(fixture(), 7)).flow
  const has = (from, to, kind) => flow.edges.some(e => e.from === from && e.to === to && e.kind === kind)
  assert.ok(has('event:3', 'answer:7', 'input'))
  assert.ok(has('event:0', 'event:3', 'replace'))
  assert.ok(has('event:0', 'event:3', 'source'))
  assert.ok(has('event:4', 'event:5', 'call'))
  assert.ok(has('event:4', 'event:5', 'source'))
  assert.ok(has('reference:other:6', 'event:6', 'reference'))
  assert.equal(has('event:0', 'answer:7', 'input'), false, 'removed inputs do not feed selected answer')
  assert.equal(has('event:4', 'answer:7', 'input'), false, 'log-only call is not a model-visible message')
  const endpoints = new Set([...flow.nodes, ...flow.anchors].map(n => n.id))
  assert.ok(flow.edges.every(e => endpoints.has(e.from) && endpoints.has(e.to)))
  assert.ok(flow.anchors.find(n => n.id === 'reference:other:6').canInspect === false)
  assert.match(flow.legend, /不表示模型内部因果/)
  assert.equal(flow.guidance.some(g => /已发现原因|确定原因|证明.*错误/.test(g.title + g.detail)), false)
})

test('flow review: two comparisons use one immutable read, despite a changing query service result', async () => {
  let reads = 0
  const q = { readSession: async () => { reads++; return log(reads === 1 ? fixture() : [msg(0, 'assistant/message', 'different snapshot')]) } }
  const reader = createContextReader(() => q)
  const result = await reader.compare('synthetic-flow', { answer: 7 }, (a, b, options) => {
    assert.equal(a.observedAt, b.observedAt)
    return contextFlow(a, b, options)
  })
  assert.equal(reads, 1)
  assert.equal(result.flow.baseline.seq, 2)
  await reader.compare('synthetic-flow', { answer: 7 }, contextFlow)
  assert.equal(reads, 1)
})

test('flow review: differential sets match an independent array fold across repeated multi-node replacements', async () => {
  const events = [], nodes = [], snapshots = new Map()
  let seed = 19
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  for (let seq = 0; seq < 150; seq++) {
    if (seq % 15 === 14) {
      snapshots.set(seq, [...nodes]); events.push(msg(seq, 'assistant/message', `answer ${seq}`)); nodes.push(seq)
    } else {
      const e = msg(seq, 'user/message', `input ${seq}`)
      if (seq % 6 === 0 && nodes.length) {
        const start = random(nodes.length), end = start + random(nodes.length - start)
        e.surfaceOp = { op: 'replace', startSeq: nodes[start], endSeq: nodes[end] }; e.sourceEventSeqs = nodes.slice(start, end + 1)
        nodes.splice(start, end - start + 1, seq)
      } else nodes.push(seq)
      events.push(e)
    }
  }
  let before = []
  for (const [seq, active] of snapshots) {
    const flow = (await compare(events, seq)).flow
    assert.equal(flow.comparison.added, active.filter(x => !before.includes(x)).length)
    assert.equal(flow.comparison.retained, active.filter(x => before.includes(x)).length)
    assert.equal(flow.comparison.removed, before.filter(x => !active.includes(x)).length)
    before = active
  }
})

test('flow review: pagination and focus cover exact filtered candidates, including unavailable focus', async () => {
  const events = Array.from({ length: 41 }, (_, seq) => msg(seq, 'user/message', seq % 2 ? 'odd' : 'even'))
  events.push(msg(41, 'assistant/message', 'answer'))
  const seqs = []
  for (let page = 0; page < 4; page++) {
    const flow = (await compare(events, 41, { scope: 'active', page })).flow
    assert.equal(flow.page.index, page); assert.ok(flow.nodes.length <= FLOW_LIMITS.page)
    seqs.push(...flow.nodes.map(n => n.seq))
  }
  assert.deepEqual(seqs, Array.from({ length: 41 }, (_, i) => i))
  const focused = (await compare(events, 41, { scope: 'active', focus: 29, page: 0 })).flow
  assert.equal(focused.page.index, 2); assert.equal(focused.focusFound, true); assert.ok(focused.nodes.some(n => n.seq === 29))
  const hidden = (await compare(events, 41, { scope: 'active', focus: 29, q: 'even' })).flow
  assert.equal(hidden.focusFound, false); assert.equal(hidden.page.total, 21)
  const last = (await compare(events, 41, { scope: 'active', page: 99999 })).flow
  assert.equal(last.page.index, 3); assert.equal(last.nodes.at(-1).seq, 40)
})

test('flow review: unknown or future provenance does not fabricate input edges or expose future nodes', async () => {
  const e = msg(1, 'user/message', 'uncertain', { kind: 'external' }, { surfaceOp: undefined, sourceEventSeqs: [0, 1, 3, 999] })
  const events = [msg(0, 'user/message', 'known'), e, msg(2, 'assistant/message', 'answer'), msg(3, 'user/message', 'FUTURE')]
  const flow = (await compare(events, 2, { scope: 'unknown' })).flow
  assert.equal(flow.nodes[0].status, 'unknown')
  assert.equal(flow.edges.some(e => e.kind === 'input'), false)
  assert.ok(flow.edges.some(e => e.from === 'event:0' && e.to === 'event:1' && e.kind === 'source'))
  assert.ok(flow.omittedRelations >= 3)
  assert.equal(flow.anchors.some(n => n.seq === 3 || n.seq === 999), false)
})

test('flow review: large body and opaque payloads never expand into graph nodes or edge metadata', async () => {
  const secret = 'SYNTHETIC_FLOW_PRIVATE'
  const e = msg(0, 'user/message', 'visible ' + 'x'.repeat(1200000) + 'BODY_TAIL')
  e.data.private = secret; e.data.content.push({ type: 'reasoning', text: secret }, { type: 'image', data: secret })
  const c = call(1, 'call', { private: secret, arguments: secret, message: { content: [{ type: 'text', text: secret }], source: { kind: secret } } })
  const r = msg(2, 'tool/result', 'public result'); r.data.message.toolCallId = 'call'; r.sourceEventSeqs = [1]
  const flow = await compare([e, c, r, { seq: 3, type: 'request/header', data: { authorization: secret } }, msg(4, 'assistant/message', 'answer')], 4)
  const serialized = JSON.stringify(flow)
  assert.ok(serialized.length < 60000)
  assert.equal(serialized.includes(secret), false)
  assert.equal(serialized.includes('BODY_TAIL'), false)
  for (const n of [...flow.flow.nodes, ...flow.flow.anchors]) assert.equal('text' in n || 'arguments' in n || 'data' in n, false)
})

test('flow review: relation/anchor capacity has no dangling edges and explicitly reports omissions', async () => {
  const events = Array.from({ length: 60 }, (_, seq) => msg(seq, 'user/message', `source ${seq}`))
  events.push(msg(60, 'assistant/message', 'baseline'))
  events.push(msg(61, 'user/message', 'many sources', { kind: 'external' }, { sourceEventSeqs: Array.from({ length: 50 }, (_, i) => i) }))
  events.push(msg(62, 'assistant/message', 'selected'))
  const flow = (await compare(events, 62)).flow
  assert.ok(flow.anchors.length <= FLOW_LIMITS.anchors)
  assert.ok(flow.edges.length <= FLOW_LIMITS.edges)
  assert.ok(flow.omittedRelations > 0)
  const ids = new Set([...flow.nodes, ...flow.anchors].map(n => n.id))
  assert.ok(flow.edges.every(e => ids.has(e.from) && ids.has(e.to)))
})

test('flow review: every displayed inspectable anchor works with the selected historical detail boundary', async () => {
  const events = fixture(), current = await indexContext(log(events), 7), previous = await indexContext(log(events), 2)
  const flow = contextFlow(current, previous).flow
  for (const a of [...flow.nodes, ...flow.anchors].filter(a => a.canInspect)) assert.doesNotThrow(() => contextDetail(current, a.seq), `cannot inspect ${a.id}`)
})

test('flow review: Host validates flow filters and focus without touching mutation services', async () => {
  const query = { readSession: async () => log(fixture()) }
  const handlers = createHandlers({ config: resolveConfig({}), getRegistry: () => null, getQuery: () => query })
  const run = params => handlers.get['inspect-flow']({ query: new URLSearchParams({ id: 'synthetic-flow', answer: '7', ...params }) })
  assert.equal((await run({})).flow.baseline.seq, 2)
  for (const params of [{ scope: 'cause' }, { page: '-1' }, { focus: '1.2' }, { module: 'missing' }, { answer: '9007199254740992' }]) await assert.rejects(run(params), e => e.status === 400)
})

test('flow review: capped event index does not fabricate a zero-change comparison', async () => {
  const events = [msg(0, 'user/message', 'question'), msg(1, 'assistant/message', 'previous')]
  while (events.length <= VIEW_LIMITS.events) events.push({ seq: events.length, type: 'runtime/event' })
  events.push(msg(events.length, 'assistant/message', 'selected'))
  const result = await compare(events, events.length - 1)
  assert.equal(result.flow.comparison.available, false)
  assert.equal(result.flow.comparison.added, null)
  assert.equal(result.flow.comparison.retained, null)
  assert.equal(result.flow.comparison.removed, null)
  assert.deepEqual(result.flow.nodes, [])
  assert.ok(result.flow.guidance.some(g => g.id === 'capacity'))
  const current = await indexContext(log(events), events.length - 1)
  for (const a of result.flow.anchors.filter(a => a.canInspect)) assert.doesNotThrow(() => contextDetail(current, a.seq), `capacity fallback advertises unreadable anchor ${a.id}`)
})

test('flow review: truncation of 13 declared reference snapshots must be disclosed', async () => {
  const references = Array.from({ length: 13 }, (_, i) => ({ sessionId: `ref-${i}`, label: `Reference ${i}` }))
  const flow = await compare([msg(0, 'user/message', 'references', { kind: 'session-reference', references }), msg(1, 'assistant/message', 'answer')], 1)
  const represented = flow.flow.edges.filter(e => e.kind === 'reference').length
  const disclosed = flow.flow.omittedRelations > 0 || flow.warnings.some(w => /来源关联|省略|有限项/.test(w.detail)) || flow.flow.nodes.some(n => n.issues.some(x => /来源关联|省略|有限项/.test(x)))
  assert.ok(represented === references.length || disclosed, '13th source reference disappears without any omission notice')
})
