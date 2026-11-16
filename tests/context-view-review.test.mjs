/** Independent backend review. Synthetic data only; no DSH home or browser access. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setImmediate as turn } from 'node:timers/promises'
import { indexContext, contextView, contextDetail, sourcePage, createContextReader, MODULES, VIEW_LIMITS } from '../lib/context-view.js'
import { boundedQuery } from '../lib/reads.js'
import { createHandlers, resolveConfig } from '../lib/host.js'

const message = (seq, type, text, source = { kind: 'user' }, extra = {}) => ({ seq, type, surfaceOp: 'append', data: type === 'user/message' ? { content: [{ type: 'text', text }], source } : { message: { content: [{ type: 'text', text }], source } }, ...extra })
const log = (events, id = 's') => ({ session: { id }, events })
const simple = (text = 'answer', id = 's') => log([message(0, 'user/message', 'question'), message(1, 'assistant/message', text)], id)

test('review: independent replacement oracle, all module/status pages have no duplicates or omissions', async () => {
  const events = [], nodes = [], status = new Map()
  const sources = ['user', 'agent-instructions', 'session-reference', 'skill-catalog', 'runtime-context', 'external-plugin']
  let seed = 37
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  for (let seq = 0; seq < 650; seq++) {
    const e = message(seq, 'user/message', `visible ${seq}`, { kind: sources[seq % sources.length] })
    if (seq % 7 === 0 && nodes.length) {
      const start = random(nodes.length), end = start + random(nodes.length - start)
      e.surfaceOp = { op: 'replace', startSeq: nodes[start], endSeq: nodes[end] }
      e.sourceEventSeqs = nodes.slice(start, end + 1)
      for (const old of nodes.splice(start, end - start + 1, seq)) status.set(old, 'replaced')
    } else nodes.push(seq)
    status.set(seq, 'active'); events.push(e)
  }
  events.push(message(events.length, 'assistant/message', 'selected'))
  const index = await indexContext(log(events))
  assert.deepEqual(index.active, nodes)
  const found = new Map()
  for (const module of MODULES) for (const state of ['active', 'replaced', 'unknown']) {
    const first = contextView(index, { module: module.id, state })
    const seqs = []
    for (let page = 0; page < first.page.pages; page++) {
      const result = contextView(index, { module: module.id, state, page })
      assert.equal(result.page.index, page)
      assert.ok(result.page.items.length <= VIEW_LIMITS.records)
      for (const row of result.page.items) { assert.equal(found.has(row.seq), false); found.set(row.seq, row.status); seqs.push(row.seq) }
    }
    assert.equal(seqs.length, first.page.total)
  }
  assert.deepEqual([...found].sort((a,b) => a[0]-b[0]), [...status])
})

test('review: virtual text pages preserve separators, visible tool arguments, and the final tail', () => {
  const e = message(0, 'assistant/message', '')
  const args = 'string-arguments-'.repeat(1600)
  e.data.message.content = [{ type: 'text', text: 'a'.repeat(11999) }, { type: 'reasoning', text: 'NOT_VISIBLE' }, { type: 'text', text: '第二块😀' }, { type: 'tool-call', name: 'read', arguments: args }, { type: 'text', text: 'FINAL' }]
  const expected = ['a'.repeat(11999), '第二块😀', '[调用 read]', args, 'FINAL'].join('\n\n')
  let actual = '', offset = 0, pages = 0
  do { const page = sourcePage(e, offset); actual += page.text; assert.equal(page.incomplete, false); offset = page.nextOffset; pages++; assert.ok(pages < 20) } while (offset !== null)
  assert.equal(actual, expected)
})

test('review: synthetic secrets in opaque metadata, request headers, stream, reasoning and attachments do not escape', async () => {
  const sentinel = 'SYNTHETIC_PRIVATE_SENTINEL'
  const e = message(0, 'user/message', 'visible', { kind: 'session-reference', private: sentinel, references: [{ sessionId: 'other', label: 'public', authorization: sentinel }], changes: [{ path: 'AGENTS.md', action: 'set', credentials: sentinel }] })
  e.data.private = sentinel
  e.data.content.push({ type: 'reasoning', text: sentinel }, { type: 'image', data: sentinel, url: sentinel }, { type: 'opaque', text: sentinel })
  const data = log([e, { seq: 1, type: 'request/header', data: { header: { authorization: sentinel, config: { apiKey: sentinel }, tools: [{ token: sentinel }] } } }, { seq: 2, type: 'assistant/stream', data: { text: sentinel } }, message(3, 'assistant/message', 'answer')])
  const handlers = createHandlers({ config: resolveConfig({}), getRegistry: () => null, getQuery: () => query })
  const query = { readSession: async () => data }
  const view = await handlers.get['inspect-view']({ query: new URLSearchParams('id=s&answer=3') })
  const detail = await handlers.get['inspect-detail']({ query: new URLSearchParams('id=s&answer=3&event=0') })
  assert.equal(JSON.stringify([view, detail]).includes(sentinel), false)
  assert.ok(detail.text.includes('visible'))
  assert.equal(detail.incomplete, true)
})

test('review: older answer never gains future tool pairing or future context details', async () => {
  const result = message(0, 'tool/result', 'orphan'); result.data.message.toolCallId = 'late-call'
  const index = await indexContext(log([result, message(1, 'assistant/message', 'selected'), { seq: 2, type: 'tool/call', data: { callId: 'late-call', name: 'future', arguments: 'FUTURE' } }, message(3, 'user/message', 'FUTURE')]), 1)
  assert.equal(contextDetail(index, 0).hasArguments, false)
  assert.throws(() => contextDetail(index, 0, 0, 'arguments'), e => e.status === 404)
  assert.throws(() => contextDetail(index, 3), e => e.status === 404)
})

test('review: inflight read from an old service cannot overwrite the new service cache', async () => {
  let resolveOld, oldCalls = 0, newCalls = 0
  let query = { readSession: () => { oldCalls++; return new Promise(resolve => { resolveOld = resolve }) } }
  const reader = createContextReader(() => query)
  const old = reader.view('s')
  await turn()
  query = { readSession: async () => { newCalls++; return simple('new') } }
  assert.equal((await reader.view('s')).answer.preview, 'new')
  resolveOld(simple('old'))
  assert.equal((await old).answer.preview, 'old', 'caller started on the old service')
  assert.equal((await reader.view('s')).answer.preview, 'new')
  assert.equal(oldCalls, 1); assert.equal(newCalls, 1)
})

test('review: host-style bounded read times out without accumulating underlying I/O, then recovers', async () => {
  let finish, calls = 0
  const query = { readSession: () => { calls++; return new Promise(resolve => { finish = resolve }) } }
  const get = boundedQuery(() => query, { timeoutMs: 20, maxPending: 2 })
  const reader = createContextReader(get, { identity: () => query })
  await assert.rejects(reader.view('s'), e => e.status === 504)
  await assert.rejects(reader.view('s'), e => e.status === 504)
  assert.equal(calls, 1)
  finish(simple()); await turn()
  query.readSession = async () => { calls++; return simple('recovered') }
  assert.equal((await reader.view('s')).answer.preview, 'recovered')
  assert.equal(calls, 2)
})

test('review: source page rejects unsupported offsets/parts and discloses excessive content blocks', () => {
  const e = message(0, 'user/message', '')
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sourcePage(e, offset), x => x.status === 400)
  assert.throws(() => sourcePage(e, 0, 'request-header'), x => x.status === 400)
  e.data.content = Array.from({ length: VIEW_LIMITS.blocks + 1 }, () => ({ type: 'text', text: 'x' }))
  const page = sourcePage(e)
  assert.equal(page.incomplete, true)
  assert.ok(page.notices.some(n => n.includes('上限')))
  assert.ok(page.text.length <= VIEW_LIMITS.text)
})

test('review R1: evicted snapshot logs should not stay alive solely through expiry timers', () => {
  const code = `
    import { createContextReader } from './lib/context-view.js';
    const refs=[];
    const query={async readSession(id){const log={session:{id},events:[{seq:0,type:'assistant/message',surfaceOp:'append',data:{message:{content:[{type:'text',text:'x'.repeat(1000000)}]}}}]}; refs.push(new WeakRef(log)); return log}};
    const reader=createContextReader(()=>query,{ttlMs:1000,maxEntries:2});
    for(let i=0;i<8;i++) await reader.view('s'+i);
    await new Promise(setImmediate); global.gc(); await new Promise(setImmediate); global.gc();
    const retained=refs.filter(r=>r.deref()).length;
    await new Promise(r=>setTimeout(r,1100)); global.gc(); await new Promise(setImmediate); global.gc();
    console.log(JSON.stringify({retained,after:refs.filter(r=>r.deref()).length}));
  `
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 5000, encoding: 'utf8', maxBuffer: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout.trim())
  assert.equal(data.after, 0, 'probe sanity: logs become collectable after expiry')
  assert.ok(data.retained <= 2, `maxEntries=2 but ${data.retained} snapshot logs are retained`)
})

test('review R2: invalid provenance shapes must not silently become empty, complete metadata', async () => {
  const e = message(0, 'user/message', 'readable', { kind: 'session-reference', references: { malformed: true }, changes: 'wrong' })
  e.sourceEventSeqs = 'wrong'
  const index = await indexContext(log([e, message(1, 'assistant/message', 'answer')]))
  const detail = contextDetail(index, 0)
  assert.equal(detail.text, 'readable')
  assert.equal(detail.incomplete, true)
  assert.ok(detail.notices.length)
})

test('review R3: interrupted answer remains identifiable in the modular inspection API', async () => {
  const e = message(1, 'assistant/message', 'unfinished'); e.data.interrupted = true
  const view = contextView(await indexContext(log([message(0, 'user/message', 'question'), e])))
  assert.ok(view.answer.interrupted === true || view.answer.issues.some(x => /中断/.test(x)) || view.warnings.some(x => /中断/.test(x.title)))
})

test('review R4: independently reusable UTF-16 pages should not split a Unicode code point', () => {
  const text = 'a'.repeat(VIEW_LIMITS.text - 1) + '😀tail'
  const e = message(0, 'user/message', text)
  const a = sourcePage(e), b = sourcePage(e, a.nextOffset)
  assert.equal(a.text + b.text, text)
  assert.equal(a.text.isWellFormed(), true)
  assert.equal(b.text.isWellFormed(), true)
})

test('review R4: varied Unicode and block boundaries reconstruct forward pages without gaps or overlaps', () => {
  let seed = 41
  const atoms = ['x', '中', '😀', '𠮷', 'e\u0301', '👨‍👩‍👧‍👦', '\r\n']
  const blocks = []
  for (let block = 0; block < 8; block++) {
    let text = ''
    for (let i = 0; i < 2600; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += atoms[seed % atoms.length] }
    blocks.push({ type: 'text', text })
  }
  const e = message(0, 'user/message', ''); e.data.content = blocks
  const full = blocks.map(b => b.text).join('\n\n')
  let offset = 0, restored = '', count = 0
  do {
    const page = sourcePage(e, offset)
    assert.equal(page.offset, offset)
    assert.ok(page.text.length <= VIEW_LIMITS.text)
    assert.equal(page.text.isWellFormed(), true)
    assert.equal(page.text, full.slice(page.offset, page.offset + page.text.length))
    if (page.previousOffset !== null) assert.equal(sourcePage(e, page.previousOffset).nextOffset, page.offset)
    restored += page.text; offset = page.nextOffset
    assert.ok(++count < 100)
  } while (offset !== null)
  assert.equal(restored, full)
})

test('review R4: arbitrary offset correction is reflected in detail provenance and preserves exact original text', async () => {
  const full = 'a'.repeat(11999) + '😀' + 'b'.repeat(11998) + '😎' + 'c'.repeat(24000)
  const index = await indexContext(log([message(0, 'user/message', full), message(1, 'assistant/message', 'answer')]))
  for (const offset of [0, 11999, 12000, 23998, 23999, 24000, 24001, 35999, 36000, 36001, full.length]) {
    const detail = contextDetail(index, 0, offset)
    assert.ok(detail.offset === offset || detail.offset === offset - 1)
    assert.equal(detail.row.textOffset, detail.offset)
    assert.equal(detail.text.isWellFormed(), true)
    assert.equal(detail.text, full.slice(detail.offset, detail.offset + detail.text.length))
  }
})

test('review R2b: invalid allowlisted provenance fields are disclosed without numeric coercion', async () => {
  const invalid = { kind: 'session-reference', references: [{ sessionId: {}, label: 42, truncated: 'true', omittedMessages: '7' }], changes: [{ path: {}, action: 42 }] }
  const e = message(0, 'user/message', 'readable', invalid)
  const index = await indexContext(log([e, message(1, 'assistant/message', 'answer')]))
  const detail = contextDetail(index, 0), view = contextView(index, { module: 'references' })
  assert.equal(detail.text, 'readable')
  assert.equal(detail.incomplete, true)
  assert.ok(detail.notices.some(x => /引用来源格式异常/.test(x)))
  assert.ok(detail.notices.some(x => /变更来源格式异常/.test(x)))
  assert.equal(detail.row.issues.some(x => x === '引用内容有截断或省略'), false, 'string counts must not be treated as actual omissions')
  assert.ok(view.warnings.some(x => /格式异常/.test(x.detail)))
  assert.deepEqual(detail.row.refs, [{ sessionId: '', label: '', truncated: false, omittedMessages: 0, capturedThroughSeq: undefined }])
  for (const [field, value] of [['sessionId', {}], ['label', 42], ['truncated', 1], ['omittedMessages', '7'], ['omittedMessages', -1], ['omittedMessages', 0.5], ['capturedThroughSeq', '2'], ['capturedThroughSeq', Number.MAX_SAFE_INTEGER + 1]]) {
    const event = message(0, 'user/message', 'readable', { kind: 'session-reference', references: [{ [field]: value }] })
    const d = contextDetail(await indexContext(log([event, message(1, 'assistant/message', 'answer')])), 0)
    assert.equal(d.incomplete, true, `invalid ${field} must be disclosed`)
  }
})

test('review R2b: valid optional provenance fields preserve actual types without spurious errors', async () => {
  const source = { kind: 'session-reference', references: [{ sessionId: 'other', label: 'public', truncated: false, omittedMessages: 0, capturedThroughSeq: 2 }, {}], changes: [{ path: 'AGENTS.md', action: 'set' }, {}] }
  const e = message(3, 'user/message', 'readable', source)
  const detail = contextDetail(await indexContext(log([e, message(4, 'assistant/message', 'answer')])), 3)
  assert.equal(detail.incomplete, false)
  assert.deepEqual(detail.row.refs[0], source.references[0])
  assert.deepEqual(detail.row.changes[0], source.changes[0])
})

test('review R5: large provenance collections inspect at most 50 items and disclose limited associations', async () => {
  const visited = { references: [], changes: [], sourceEventSeqs: [] }
  const observe = (items, field) => new Proxy(items, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) visited[field].push(Number(key))
    return Reflect.get(target, key, receiver)
  } })
  const e = message(10001, 'user/message', 'readable', {
    kind: 'session-reference',
    references: observe(Array.from({ length: 10000 }, () => ({ sessionId: 'other' })), 'references'),
    changes: observe(Array.from({ length: 10000 }, () => ({ path: 'AGENTS.md', action: 'set' })), 'changes'),
  })
  e.sourceEventSeqs = observe(Array.from({ length: 10000 }, (_, i) => i), 'sourceEventSeqs')
  const index = await indexContext(log([e, message(10002, 'assistant/message', 'answer')]))
  const view = contextView(index), detail = contextDetail(index, 10001)
  assert.equal(detail.text, 'readable')
  assert.equal(detail.incomplete, true)
  assert.ok(view.warnings.some(x => /有限项/.test(x.detail)))
  assert.ok(detail.notices.some(x => /前若干项/.test(x)))
  for (const [field, indices] of Object.entries(visited)) assert.ok(Math.max(...indices) < 50, `${field} read beyond the 50-item inspection budget`)
})

test('review R5: original 1500 large object-argument counterexample has a cumulative budget and explicit notices', t => {
  const content = Array.from({ length: 1500 }, () => ({ type: 'tool-call', name: 'x', arguments: { body: 'x'.repeat(95000) } }))
  const e = message(0, 'assistant/message', ''); e.data.message.content = content
  const start = performance.now(), page = sourcePage(e)
  t.diagnostic(`1500 object arguments: virtual chars=${page.totalChars}, first-page ms=${(performance.now() - start).toFixed(2)}`)
  assert.ok(page.text.length <= VIEW_LIMITS.text)
  assert.equal(page.incomplete, true)
  assert.ok(page.notices.some(x => /累计保护预算/.test(x)))
  assert.ok(page.totalChars < 160000, 'must not re-materialize the former 142,538,998-character view')
  const tail = sourcePage(e, page.totalChars - 1000)
  assert.match(tail.text, /调用参数未展开/)
  assert.equal(tail.nextOffset, null)
  const hugeString = '中😀TAIL'.repeat(25000) + 'FINAL-STRING-END'
  e.data.message.content.push({ type: 'text', text: hugeString })
  const extended = sourcePage(e)
  const startOfString = extended.totalChars - hugeString.length
  let offset = startOfString, restored = '', count = 0
  do { const p = sourcePage(e, offset); restored += p.text; offset = p.nextOffset; assert.equal(p.totalChars, extended.totalChars); assert.ok(++count < 100) } while (offset !== null)
  assert.equal(restored, hugeString, 'exhausted object budget must not truncate subsequent string text')
})

test('review R5: cumulative node budget also limits many small objects while string arguments remain lossless', () => {
  const e = message(0, 'assistant/message', '')
  e.data.message.content = Array.from({ length: 1200 }, (_, i) => ({ type: 'tool-call', name: 'x', arguments: { n: i } }))
  const first = sourcePage(e), tail = sourcePage(e, first.totalChars - 1500)
  assert.equal(first.incomplete, true)
  assert.ok(first.notices.some(x => /累计保护预算/.test(x)))
  assert.match(tail.text, /调用参数未展开/)
  const args = 'STRING-ARGUMENT-'.repeat(9000) + 'LAST'
  e.data.message.content.push({ type: 'tool-call', name: 'last', arguments: args })
  const full = sourcePage(e)
  let offset = full.totalChars - args.length, restored = '', count = 0
  do { const p = sourcePage(e, offset); restored += p.text; offset = p.nextOffset; assert.ok(++count < 30) } while (offset !== null)
  assert.equal(restored, args)
})

test('review: tool-call source details respect answer boundary and exclude opaque call payloads', async () => {
  const secret = 'SYNTHETIC_CALL_PRIVATE_SENTINEL'
  const call = { seq: 0, type: 'tool/call', data: { callId: 'c', name: 'read', arguments: 'PUBLIC_ARGS', authorization: secret, credential: secret, message: { content: [{ type: 'reasoning', text: secret }, { type: 'text', text: secret }], source: { kind: secret, changes: [{ path: secret, action: 'set' }], references: [{ sessionId: secret, label: secret }] } } }, raw: secret }
  const result = message(1, 'tool/result', 'PUBLIC_RESULT'); result.data.message.toolCallId = 'c'; result.sourceEventSeqs = [0]
  const future = { seq: 3, type: 'tool/call', data: { callId: 'future', name: 'future', arguments: 'FUTURE_ARGS' } }
  const events = [call, result, message(2, 'assistant/message', 'selected'), future, { seq: 4, type: 'request/header', data: { header: { authorization: secret } } }]
  const index = await indexContext(log(events), 2)
  for (const part of ['body', 'arguments']) {
    const detail = contextDetail(index, 0, 0, part)
    assert.equal(detail.row.status, 'source')
    assert.match(detail.text, /PUBLIC_ARGS/)
    assert.equal(JSON.stringify(detail).includes(secret), false)
    assert.equal(JSON.stringify(detail).includes('FUTURE_ARGS'), false)
  }
  assert.equal(contextDetail(index, 1).row.callSeq, 0)
  assert.throws(() => contextDetail(index, 3), e => e.status === 404)
  assert.throws(() => contextDetail(index, 4), e => e.status === 404)
  assert.equal(contextView(index, { module: 'tools' }).page.total, 1, 'log-only call must not count as an active model input')
})
