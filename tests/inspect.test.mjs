import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectLog, inspectSession, visibleText } from '../lib/inspect.js'
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
