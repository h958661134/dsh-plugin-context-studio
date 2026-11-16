import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INSPECT_LIMITS, inspectLog, inspectSession, visibleText } from '../lib/inspect.js'
import { compose, sanitizeItems } from '../lib/compose.js'
import { createHandlers, resolveConfig } from '../lib/host.js'

const msg = (seq, type, text, source = { kind: 'user' }, extra = {}) => ({ seq, time: 1000 + seq, type, surfaceOp: 'append', data: type === 'user/message' ? { content: [{ type: 'text', text }], source } : { turn: 1, step: 1, message: { content: [{ type: 'text', text }], source } }, ...extra })
const log = events => ({ session: { id: 's1' }, events })

test('inspection is historical: future messages and replacement do not leak into an earlier answer', () => {
  const events = [msg(0, 'user/message', 'original'), msg(1, 'assistant/message', 'first'), msg(2, 'user/message', 'replacement', { kind: 'compaction' }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [0, 1] }), msg(3, 'user/message', 'future'), msg(4, 'assistant/message', 'second')]
  const old = inspectLog(log(events), 1), latest = inspectLog(log(events))
  assert.deepEqual(old.context.map(r => r.text), ['original'])
  assert.equal(old.shadowed.length, 0)
  assert.deepEqual(latest.context.map(r => r.text), ['replacement', 'future'])
  assert.deepEqual(latest.shadowed.map(r => [r.seq, r.replacedBy]), [[0, 2], [1, 2]])
  assert.deepEqual(latest.context[0].sourceEventSeqs, [0, 1])
  assert.equal(latest.summary.added, 2)
})

test('replacement keeps model-history position instead of sorting by event number', () => {
  const events = [msg(0, 'system/message', 'old system'), msg(1, 'user/message', 'question'), msg(2, 'system/message', 'new system', {}, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0] }), msg(3, 'assistant/message', 'answer')]
  assert.deepEqual(inspectLog(log(events)).context.map(r => r.seq), [2, 1])
})

test('unknown and invalid surface placement is visible, never silently treated as active input', () => {
  const events = [msg(0, 'user/message', 'legacy', {}, { surfaceOp: undefined }), msg(1, 'user/message', 'invalid replacement', {}, { surfaceOp: { op: 'replace', startSeq: 99, endSeq: 99 } }), msg(2, 'assistant/message', 'answer')]
  const d = inspectLog(log(events))
  assert.equal(d.context.length, 0)
  assert.equal(d.unplaced.length, 2)
  assert.ok(d.warnings.some(w => w.code === 'surface-unknown'))
})

test('tool errors preserve call parameters and pairing, without leaking internal metadata', () => {
  const result = msg(2, 'tool/result', 'ENOENT')
  result.data.message.toolCallId = 'c1'; result.data.message.isError = true
  result.data.meta = { secret: 'PRIVATE-META' }
  const d = inspectLog(log([{ seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: '{"path":"missing.md"}' } }, result, msg(3, 'assistant/message', 'answer')]))
  assert.equal(d.context[0].callSeq, 0)
  assert.equal(d.context[0].callArguments, '{"path":"missing.md"}')
  assert.match(d.context[0].label, /read/)
  assert.equal(d.warnings[0].code, 'tool-error')
  assert.ok(!JSON.stringify(d).includes('PRIVATE-META'))
})

test('truncated references and instruction changes link back to source events', () => {
  const d = inspectLog(log([msg(0, 'user/message', 'reference', { kind: 'session-reference', references: [{ sessionId: 's2', label: 'B', omittedMessages: 2, capturedThroughSeq: 30 }] }), msg(1, 'user/message', 'new rules', { kind: 'agent-instructions', changes: [{ path: 'AGENTS.md', action: 'replace' }] }), msg(2, 'assistant/message', 'answer')]))
  assert.deepEqual(d.warnings.map(w => [w.code, w.seq]), [['reference-truncated', 0], ['instruction-change', 1]])
  assert.equal(d.context[0].refs[0].capturedThroughSeq, 30)
})

test('visible text excludes reasoning, stream and unrecognized payloads', () => {
  const e = msg(0, 'assistant/message', 'shown')
  e.data.message.content.push({ type: 'reasoning', text: 'HIDDEN' }, { type: 'unknown', text: 'OPAQUE' })
  e.data.stream = [{ text: 'RAW-STREAM' }]
  const d = inspectLog(log([e]))
  assert.equal(d.answer.text, 'shown')
  assert.ok(!/HIDDEN|OPAQUE|RAW-STREAM/.test(JSON.stringify(d)))
  assert.match(visibleText({ content: [{ type: 'image', data: 'binary' }] }), /附件/)
})

test('long text clipping is explicit and token counts are based on full visible text', () => {
  const d = inspectLog(log([msg(0, 'user/message', 'a'.repeat(21_000)), msg(1, 'assistant/message', 'ok')]))
  assert.equal(d.context[0].text.length, 20_000)
  assert.equal(d.context[0].clipped, true)
  assert.ok(d.context[0].tokens >= 6300)
  assert.ok(d.warnings.some(w => w.code === 'display-clipped'))
})

test('projection and interruption are explicit; empty system nodes do not masquerade as input', () => {
  const e = msg(2, 'assistant/message', 'partial'); e.data.interrupted = true
  const d = inspectLog(log([msg(0, 'system/message', ''), { seq: 1, type: 'image/offload' }, e]))
  assert.equal(d.context.length, 0)
  assert.deepEqual(d.warnings.map(w => w.code), ['projection', 'interrupted'])
})

test('empty session and invalid answer seq fail predictably', async () => {
  assert.equal(inspectLog(log([])).answer, null)
  assert.throws(() => inspectLog(log([]), 5), e => e.status === 404)
  await assert.rejects(inspectSession({}, 's1'), e => e.status === 503)
  await assert.rejects(inspectSession({ readSession: async () => log([]) }, 's1', -1), e => e.status === 400)
})

test('request metadata is an allowlist; credential-like header fields never leave the server', () => {
  const d = inspectLog(log([{ seq: 0, type: 'request/header', data: { header: { config: { model: 'model', provider: 'provider', apiKey: 'SECRET' }, tools: [{ name: 'read', description: 'PRIVATE-SCHEMA' }] } } }, msg(1, 'assistant/message', 'ok')]))
  assert.equal(d.request.toolCount, 1)
  assert.equal(d.request.model, 'model')
  assert.ok(!/SECRET|PRIVATE-SCHEMA/.test(JSON.stringify(d)))
})

test('selected excerpt carries exact session and event provenance into the new draft', () => {
  const items = sanitizeItems([{ kind: 'snippet', title: 'Deploy · 项目指令 · #7', text: '周五不发版', from: '会话 s1 / 事件 #7（历史内容，已被替换）' }])
  const d = compose(items, { task: '重新检查发布时间' })
  assert.match(d.text, /会话 s1 \/ 事件 #7（历史内容，已被替换）/)
  assert.match(d.text, /周五不发版/)
  assert.match(d.text, /重新检查发布时间/)
  assert.ok(!d.text.includes('dsh-session:'), 'excerpt must not implicitly import the entire conversation')
})

test('host inspect route validates query and calls read-only query service', async () => {
  let reads = 0
  const handlers = createHandlers({ config: resolveConfig({}), getRegistry: () => null, getQuery: () => ({ readSession: async id => { assert.equal(id, 's1'); reads++; return log([msg(0, 'assistant/message', 'ok')]) } }) })
  const run = text => handlers.get.inspect({ query: new URLSearchParams(text) })
  assert.equal((await run('id=s1&seq=0')).answer.seq, 0)
  for (const q of ['id=s1&seq=NaN', 'id=s1&seq=-1', 'id=s1&seq=', 'id=s1&seq=1.2', 'id=s1&seq=9007199254740992', 'seq=0']) await assert.rejects(run(q), e => e.status === 400)
  assert.equal(reads, 1)
})

test('bad blocks retain readable text with explicit partial semantics and event provenance', () => {
  const e = msg(0, 'user/message', 'readable')
  e.data.content.push(null, 42, { type: 'text', text: {} })
  const d = inspectLog(log([e, msg(1, 'assistant/message', 'ok')]))
  assert.equal(d.context[0].text, 'readable')
  assert.equal(d.context[0].incomplete, true)
  assert.equal(d.partial, true)
  assert.equal(d.completeness.context, 'partial')
  assert.match(d.limitation, /部分结果.*完整上下文/)
  assert.ok(d.warnings.some(w => w.code === 'malformed-event' && w.seq === 0))
  assert.equal(visibleText({ content: [null, { type: 'text', text: 'ok' }] }), 'ok')
})

test('wrong content, changes and references shapes never throw or pretend to be complete', () => {
  for (const content of [undefined, null, {}, 'not an array', [null]]) {
    const e = msg(0, 'user/message', '')
    e.data.content = content
    e.data.source.changes = 'wrong'
    e.data.source.references = {}
    const d = inspectLog(log([e, msg(1, 'assistant/message', 'ok')]))
    assert.equal(d.context.length, 1, 'unreadable messages must not disappear')
    assert.deepEqual(d.context[0].changes, [])
    assert.deepEqual(d.context[0].refs, [])
    assert.equal(d.completeness.context, 'partial')
  }
  const e = msg(0, 'user/message', 'ok', { kind: 'agent-instructions', changes: [null, { path: 'AGENTS.md', action: 'set' }], references: [null, { sessionId: 's2', label: {} }] })
  e.sourceEventSeqs = [null, -1, '2', 3]
  const d = inspectLog(log([e, msg(1, 'assistant/message', 'ok')]))
  assert.equal(d.context[0].changes[0].path, 'AGENTS.md')
  assert.deepEqual(d.context[0].sourceEventSeqs, [3])
  assert.equal(d.context[0].refs[0].label, '')
  assert.equal(d.partial, true)
})

test('object tool arguments are safely rendered and invalid argument values are flagged', () => {
  const result = msg(1, 'tool/result', 'result')
  result.data.message.toolCallId = 'c1'
  const call = { seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'read', arguments: { path: 'safe.md', options: [true, 2] } } }
  const d = inspectLog(log([call, result, msg(2, 'assistant/message', 'ok')]))
  assert.deepEqual(JSON.parse(d.context[0].callArguments), call.data.arguments)
  assert.equal(d.completeness.context, 'complete')
  const cycle = {}; cycle.self = cycle
  for (const args of [cycle, { invalid: 1n }, { invalid: Infinity }]) {
    call.data.arguments = args
    const partial = inspectLog(log([call, result, msg(2, 'assistant/message', 'ok')]))
    assert.equal(partial.context[0].text, 'result')
    assert.equal(partial.context[0].callArguments, '')
    assert.equal(partial.completeness.context, 'partial')
    assert.ok(partial.warnings.some(w => w.code === 'malformed-event' && w.seq === 1))
  }
})

test('future malformed answers and envelopes cannot invalidate the chosen old answer', () => {
  const prefix = [msg(0, 'user/message', 'question'), msg(1, 'assistant/message', 'old')]
  const baseline = inspectLog(log(prefix), 1)
  for (const content of [[null], {}, 'wrong', [{ type: 'text', text: {} }]]) {
    const future = msg(2, 'assistant/message', '')
    future.data.message.content = content
    future.data.message.source = { changes: {}, references: 'wrong' }
    const d = inspectLog(log([...prefix, future, null, { type: 'assistant/message', seq: 'bad' }]), 1)
    assert.deepEqual(d.context, baseline.context)
    assert.deepEqual(d.answer, baseline.answer)
    assert.deepEqual(d.summary, baseline.summary)
    assert.equal(d.completeness.context, 'complete')
    assert.equal(d.completeness.timeline, 'partial')
    assert.ok(d.warnings.some(w => w.code === 'timeline-partial'))
    assert.ok(!d.warnings.some(w => w.code === 'malformed-event'))
  }
})

test('oversized future bodies use bounded previews without consuming the historical budget', () => {
  const prefix = [msg(0, 'user/message', 'question'), msg(1, 'assistant/message', 'old')]
  const future = msg(2, 'assistant/message', 'z'.repeat(INSPECT_LIMITS.sourceChars + 1))
  const d = inspectLog(log([...prefix, future]), 1)
  assert.equal(d.answer.text, 'old')
  assert.equal(d.context[0].text, 'question')
  assert.equal(d.timeline[1].preview.length, 140)
  assert.equal(d.completeness.context, 'complete')
  assert.throws(() => inspectLog(log([...prefix, future]), 2), e => e.status === 413)
})

test('timeline windows retain selected answer and explicitly disclose omitted navigation', () => {
  const events = Array.from({ length: INSPECT_LIMITS.timeline + 20 }, (_, seq) => msg(seq, 'assistant/message', `answer ${seq}`))
  for (const selected of [0, 110, events.length - 1]) {
    const d = inspectLog(log(events), selected)
    assert.equal(d.timeline.length, INSPECT_LIMITS.timeline)
    assert.ok(d.timeline.some(e => e.seq === selected))
    assert.equal(d.timelineInfo.omitted, 20)
    assert.equal(d.completeness.timeline, 'partial')
    assert.equal(d.completeness.context, 'complete')
    assert.equal(d.context.length, selected)
    assert.ok(d.warnings.some(w => w.code === 'timeline-partial'))
  }
})

test('untrustworthy event order rejects explicitly rather than returning misleading history', () => {
  for (const events of [null, {}, 'wrong']) assert.throws(() => inspectLog({ events }), e => e.status === 422)
  for (const events of [[null], [{ seq: -1, type: 'user/message' }], [msg(1, 'user/message', 'a'), msg(1, 'assistant/message', 'b')], [msg(2, 'user/message', 'a'), msg(1, 'assistant/message', 'b')]]) {
    assert.throws(() => inspectLog(log(events)), e => e.status === 422 && /未返回/.test(e.message))
  }
  assert.throws(() => inspectLog(log([]), NaN), e => e.status === 400)
})

test('total source text and oversized individual text reject instead of returning a clipped history', () => {
  const block = 'x'.repeat(20_000)
  const events = Array.from({ length: 1000 }, (_, seq) => msg(seq, 'user/message', block))
  events.push(msg(1000, 'assistant/message', 'ok'))
  assert.throws(() => inspectLog(log(events)), e => e.status === 413 && /未返回不完整快照/.test(e.message))
  assert.throws(() => inspectLog(log([msg(0, 'user/message', 'x'.repeat(INSPECT_LIMITS.sourceChars + 1))])), e => e.status === 413)
})

test('response byte accounting includes UTF-8 and JSON escaping, not just text characters', () => {
  for (const [char, accepted, rejected] of [['中', 15, 30], ['\u0000', 8, 16]]) {
    const make = count => log([...Array.from({ length: count }, (_, seq) => msg(seq, 'user/message', char.repeat(20_000))), msg(count, 'assistant/message', 'ok')])
    const d = inspectLog(make(accepted))
    assert.equal(d.context.length, accepted)
    assert.ok(Buffer.byteLength(JSON.stringify(d)) <= INSPECT_LIMITS.responseBytes)
    assert.throws(() => inspectLog(make(rejected)), e => e.status === 413)
  }
})

test('capacity includes replaced and unplaced rows, not just the active context', () => {
  for (const unplaced of [false, true]) {
    const events = Array.from({ length: 60 }, (_, seq) => msg(seq, 'user/message', 'x'.repeat(20_000), {}, unplaced ? { surfaceOp: undefined } : {}))
    events.push(msg(60, 'user/message', 'summary', {}, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 59 } }), msg(61, 'assistant/message', 'ok'))
    assert.throws(() => inspectLog(log(events)), e => e.status === 413)
  }
})

test('event and row limits have explicit boundaries including empty messages', () => {
  const events = Array.from({ length: INSPECT_LIMITS.events }, (_, seq) => ({ seq, type: 'ignored/event' }))
  assert.equal(inspectLog(log(events)).context.length, 0)
  assert.throws(() => inspectLog(log([...events, { seq: events.length, type: 'ignored/event' }])), e => e.status === 413)
  const rows = Array.from({ length: INSPECT_LIMITS.rows }, (_, seq) => msg(seq, 'user/message', ''))
  assert.equal(inspectLog(log(rows)).completeness.context, 'complete')
  assert.throws(() => inspectLog(log([...rows, msg(rows.length, 'assistant/message', '')])), e => e.status === 413)
})

test('dense replacements cannot bypass the fold work limit with small text', () => {
  const events = Array.from({ length: 1000 }, (_, seq) => msg(seq, 'user/message', ''))
  let previous = 0
  for (let seq = 1000; seq < 1900; seq++) {
    events.push(msg(seq, 'user/message', '', {}, { surfaceOp: { op: 'replace', startSeq: previous, endSeq: previous } }))
    previous = seq
  }
  assert.throws(() => inspectLog(log(events)), e => e.status === 413)
})

test('large collections and structured arguments are bounded before materializing a response', () => {
  const e = msg(0, 'user/message', 'x')
  e.data.source.references = Array.from({ length: 10_000 }, () => ({}))
  assert.throws(() => inspectLog(log([e])), error => error.status === 413)
  e.data.source = { kind: 'user' }
  e.data.content = [{ type: 'tool-call', name: 'tool', arguments: Array(25_000).fill(false) }]
  assert.throws(() => inspectLog(log([e])), error => error.status === 413)
})

test('malformed request metadata is excluded, not leaked as an object or marked complete', () => {
  const d = inspectLog(log([{ seq: 0, type: 'request/header', data: { header: { config: { model: { private: 'OPAQUE' } }, tools: {} } } }, msg(1, 'assistant/message', 'ok')]))
  assert.equal(d.request.model, '')
  assert.equal(d.request.toolCount, 0)
  assert.equal(d.completeness.context, 'partial')
  assert.ok(d.warnings.some(w => w.code === 'malformed-metadata'))
  assert.ok(!JSON.stringify(d).includes('OPAQUE'))
})

test('inspectSession preserves its query/id/seq contract and capacity/error semantics', async () => {
  const query = { async readSession(id) { assert.equal(id, 's1'); return log([msg(0, 'assistant/message', 'ok')]) } }
  const d = await inspectSession(query, 's1', 0)
  assert.equal(d.answer.seq, 0)
  assert.equal(d.partial, false)
  await assert.rejects(inspectSession({ readSession: async () => ({ events: {} }) }, 's1'), e => e.status === 422)
  await assert.rejects(inspectSession({ readSession: async () => log([msg(0, 'assistant/message', 'x'.repeat(INSPECT_LIMITS.sourceChars + 1))]) }, 's1'), e => e.status === 413)
})

test('a malformed replacement still removes old positions while disclosing unreadable content', () => {
  const replacement = msg(1, 'user/message', '', { kind: 'compaction' }, { surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } })
  replacement.data.content = [null]
  const d = inspectLog(log([msg(0, 'user/message', 'old rule'), replacement, msg(2, 'assistant/message', 'answer')]))
  assert.deepEqual(d.context.map(r => r.seq), [1])
  assert.equal(d.context[0].incomplete, true)
  assert.equal(d.shadowed[0].text, 'old rule')
  assert.equal(d.shadowed[0].replacedBy, 1)
  assert.equal(d.completeness.context, 'partial')
})

test('selected malformed answer and clipped call arguments are explicitly partial', () => {
  const call = { seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'tool', arguments: 'x'.repeat(21_000) } }
  const result = msg(1, 'tool/result', 'ok'); result.data.message.toolCallId = 'c1'
  const answer = msg(2, 'assistant/message', ''); answer.data.message.content = [null]
  const d = inspectLog(log([call, result, answer]))
  assert.equal(d.answer.incomplete, true)
  assert.equal(d.context[0].callArguments.length, 20_000)
  assert.equal(d.context[0].callArgumentsClipped, true)
  assert.equal(d.completeness.context, 'partial')
  assert.ok(d.warnings.some(w => w.code === 'display-clipped' && w.seq === 1))
  assert.ok(d.warnings.some(w => w.code === 'malformed-event' && w.seq === 2))
})

test('invalid request shapes and semantic boolean fields cannot claim completeness', () => {
  const e = msg(1, 'user/message', 'ok', { kind: 'session-reference', references: [{ sessionId: 's2', label: 'B', truncated: 'yes' }] })
  const d = inspectLog(log([{ seq: 0, type: 'request/header', data: { header: 'bad' } }, e, msg(2, 'assistant/message', 'ok')]))
  assert.equal(d.completeness.context, 'partial')
  assert.ok(d.warnings.some(w => w.code === 'malformed-metadata' && w.seq === 0))
  assert.ok(d.warnings.some(w => w.code === 'malformed-event' && w.seq === 1))
})
