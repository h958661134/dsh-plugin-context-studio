import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contextFlow, FLOW_LIMITS } from '../lib/context-flow.js'
import { indexContext, createContextReader } from '../lib/context-view.js'
import { createHandlers, resolveConfig } from '../lib/host.js'

const user = (seq, text, kind = 'user', extra = {}) => ({ seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind }, content: [{ type: 'text', text }] }, ...extra })
const answer = (seq, text) => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: seq, message: { content: [{ type: 'text', text }] } } })
const log = events => ({ session: { id: 's' }, events })
async function build(events, selected, options = {}) {
  const reader = createContextReader(() => query), query = { readSession: async () => log(events) }
  return reader.compare('s', { answer: selected, ...options }, contextFlow)
}

test('流转比较的是前后两个回答之前的真实输入，上一输出也是本步新增', async () => {
  const events = [user(0, 'requirement'), user(1, 'old rule', 'agent-instructions'), answer(2, 'first'),
    user(3, 'new rule', 'agent-instructions', { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] }),
    user(4, 'clarification'), answer(5, 'selected'), user(6, 'future')]
  const d = await build(events, 5)
  assert.deepEqual(d.flow.comparison, { available: true, first: false, added: 3, retained: 1, removed: 1, unknown: 0, issues: 0 })
  assert.equal(d.flow.baseline.seq, 2)
  assert.deepEqual(d.flow.nodes.map(n => [n.seq, n.change]), [[3, 'added'], [2, 'added'], [4, 'added'], [1, 'removed']])
  assert.ok(d.flow.edges.some(e => e.from === 'event:1' && e.to === 'event:3' && e.kind === 'replace'))
  assert.equal(d.flow.edges.some(e => e.from === 'event:1' && e.to === 'answer:5' && e.kind === 'input'), false)
  assert.ok(d.flow.edges.some(e => e.from === 'event:3' && e.to === 'answer:5' && e.kind === 'input'))
  assert.equal(d.flow.nodes.some(n => n.seq === 6), false)
})

test('首次回答与尚未回答均有明确基线，不虚构先前输出', async () => {
  for (const events of [[user(0, 'question')], [user(0, 'question'), answer(1, 'first')]]) {
    const d = await build(events)
    assert.equal(d.flow.baseline, null)
    assert.equal(d.flow.comparison.first, true)
    assert.equal(d.flow.comparison.added, 1)
    assert.equal(d.flow.comparison.retained, 0)
    assert.equal(d.flow.anchors.find(a => a.kind === 'answer').canInspect, events.length === 2)
  }
})

test('调用、引用、替换、位置包含分开连线，所有端点都可解释', async () => {
  const ref = user(1, 'captured quotation', 'session-reference')
  ref.data.source.references = [{ sessionId: 'foreign', label: '部署规范', truncated: true, omittedMessages: 3, secret: 'HIDDEN' }]
  const tool = { seq: 4, type: 'tool/result', surfaceOp: 'append', data: { message: { toolCallId: 'c', isError: true, content: [{ type: 'text', text: 'not found' }] } }, sourceEventSeqs: [3] }
  const events = [user(0, 'question'), ref, answer(2, 'call next'), { seq: 3, type: 'tool/call', data: { callId: 'c', name: 'read', arguments: 'public', message: { content: [{ type: 'text', text: 'HIDDEN' }] } } }, tool, answer(5, 'answer')]
  const d = await build(events, 5, { scope: 'active' })
  const ids = new Set([...d.flow.nodes, ...d.flow.anchors].map(n => n.id))
  for (const edge of d.flow.edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)) }
  assert.ok(d.flow.edges.some(e => e.kind === 'call' && e.from === 'event:3' && e.to === 'event:4'))
  assert.ok(d.flow.edges.some(e => e.kind === 'reference' && e.to === 'event:1'))
  assert.equal(JSON.stringify(d).includes('HIDDEN'), false)
  assert.ok(d.flow.guidance.some(g => g.eventSeq === 4 && g.severity === 'warning'))
  assert.ok(d.flow.guidance.some(g => g.eventSeq === 1 && g.detail.includes('省略')))
})

test('目录分页、搜索与focus定位覆盖尾部，未匹配不伪称已定位', async () => {
  const events = Array.from({ length: 160 }, (_, i) => user(i, `item ${i}`)); events.push(answer(160, 'selected'))
  const first = await build(events, 160)
  assert.equal(first.flow.nodes.length, FLOW_LIMITS.page)
  assert.equal(first.flow.page.total, 160)
  const tail = await build(events, 160, { scope: 'active', focus: 159 })
  assert.equal(tail.flow.focusFound, true)
  assert.equal(tail.flow.nodes.at(-1).seq, 159)
  const missing = await build(events, 160, { scope: 'active', q: 'not-present', focus: 159 })
  assert.equal(missing.flow.page.total, 0)
  assert.equal(missing.flow.focusFound, false)
  assert.equal(missing.flow.nodes.length, 0)
})

test('已替换与位置未知不会画成进入当前回答的边', async () => {
  const invalid = user(2, 'unknown'); delete invalid.surfaceOp
  const events = [user(0, 'old'), user(1, 'new', 'user', { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }), invalid, answer(3, 'selected')]
  for (const scope of ['replaced', 'unknown']) {
    const d = await build(events, 3, { scope })
    assert.equal(d.flow.nodes.length, 1)
    assert.equal(d.flow.edges.some(e => e.kind === 'input'), false)
    assert.equal(d.flow.nodes[0].status, scope)
  }
})

test('大量来源关联保持有界且告知省略，未来来源不当成真实边', async () => {
  const events = Array.from({ length: 70 }, (_, i) => user(i, 'context'))
  events[69].sourceEventSeqs = Array.from({ length: 69 }, (_, i) => i)
  events[69].sourceEventSeqs[0] = 999
  events.push(answer(70, 'selected'))
  const d = await build(events, 70, { focus: 69 })
  assert.ok(d.flow.anchors.length <= FLOW_LIMITS.anchors)
  assert.ok(d.flow.edges.length <= FLOW_LIMITS.edges)
  assert.ok(d.flow.omittedRelations > 0)
  assert.equal(d.flow.edges.some(e => e.from === 'event:999'), false)
  assert.equal(d.flow.anchors.some(a => a.seq === 999), false)
})

test('事件容量不可用仍保留回答与基线导航，不显示假零差异', async () => {
  const current = await indexContext(log([user(0, 'q'), answer(1, 'a')]))
  current.available = false
  const d = contextFlow(current, null)
  assert.equal(d.flow.comparison.available, false)
  assert.equal(d.flow.comparison.added, null)
  assert.equal(d.flow.nodes.length, 0)
  assert.equal(d.flow.anchors[0].seq, 1)
  assert.ok(d.flow.guidance.some(g => g.id === 'capacity'))
})

test('投影对旧累计正文不限量，输出只有预览和位置关系', async () => {
  const d = await build([user(0, 'text'.repeat(400000)), answer(1, 'first'), user(2, 'last'), answer(3, 'now')], 3)
  assert.equal(d.flow.comparison.retained, 1)
  assert.equal(d.flow.comparison.added, 2)
  assert.ok(JSON.stringify(d).length < 15000)
})

test('Host inspect-flow参数非法明确拒绝，refresh后数据更新', async () => {
  let events = [user(0, 'q'), answer(1, 'a')]
  const query = { readSession: async () => log(events) }
  const handlers = createHandlers({ config: resolveConfig({}), getRegistry: () => null, getQuery: () => query })
  const call = values => handlers.get['inspect-flow']({ query: new URLSearchParams({ id: 's', ...values }) })
  for (const input of [{ scope: 'fake' }, { page: '-1' }, { focus: '1.3' }, { answer: '99' }, { module: 'fake' }]) await assert.rejects(call(input), e => [400,404].includes(e.status))
  assert.equal((await call({})).answer.seq, 1)
  events = [...events, user(2, 'more'), answer(3, 'latest')]
  assert.equal((await call({ refresh: '1' })).answer.seq, 3)
})

test('历史回答通过精确工具 ID 和批次连到调用，参数不会进入图', async () => {
  const a = answer(1, 'read next')
  a.data.message.content.push({ type: 'tool-call', id: 'c', name: 'read', arguments: 'PRIVATE_ARGUMENT' })
  const call = { seq: 2, type: 'tool/call', data: { callId: 'c', turn: 1, step: 1, name: 'read' } }
  const result = { seq: 3, type: 'tool/result', surfaceOp: 'append', data: { message: { toolCallId: 'c', content: [{ type: 'text', text: 'found' }] } }, sourceEventSeqs: [2] }
  const events = [user(0, 'q'), a, call, result, answer(4, 'done')]
  const d = await build(events, 4)
  assert.ok(d.flow.edges.some(e => e.kind === 'request' && e.from === 'event:1' && e.to === 'event:2'))
  assert.equal(JSON.stringify(d).includes('PRIVATE_ARGUMENT'), false)
  for (const mutation of [() => { call.data.step = 99 }, () => { call.data.step = 1; a.data.message.content[1].id = 'different' }]) {
    mutation()
    assert.equal((await build(events, 4)).flow.edges.some(e => e.kind === 'request'), false)
  }
})

test('重复工具 ID 只连接匹配批次；无批次且多候选时不猜来源', async () => {
  const a = answer(1, 'old'), b = answer(2, 'new')
  for (const item of [a, b]) item.data.message.content.push({ type: 'tool-call', id: 'reused', name: 'read' })
  const call = { seq: 3, type: 'tool/call', data: { callId: 'reused', turn: 1, step: 2, name: 'read' } }
  const result = { seq: 4, type: 'tool/result', surfaceOp: 'append', data: { message: { toolCallId: 'reused', content: [] } } }
  const events = [user(0, 'q'), a, b, call, result, answer(5, 'done')]
  let d = await build(events, 5)
  assert.deepEqual(d.flow.edges.filter(e => e.kind === 'request').map(e => e.from), ['event:2'])
  delete call.data.turn; delete call.data.step
  d = await build(events, 5)
  assert.equal(d.flow.edges.some(e => e.kind === 'request'), false)
  assert.ok(d.flow.omittedRelations > 0)
})

test('调用来源扫描预算到达时不提交可能漏掉歧义的匹配', async () => {
  const a = answer(1, 'previous')
  a.data.message.content = [{ type: 'tool-call', id: 'c' }, ...Array(100000).fill({ type: 'text', text: '' })]
  const events = [user(0, 'q'), a, { seq: 2, type: 'tool/call', data: { callId: 'c' } },
    { seq: 3, type: 'tool/result', surfaceOp: 'append', data: { message: { toolCallId: 'c', content: [] } } }, answer(4, 'done')]
  const d = await build(events, 4)
  assert.equal(d.flow.edges.some(e => e.kind === 'request'), false)
  assert.ok(d.flow.omittedRelations > 0)
})
