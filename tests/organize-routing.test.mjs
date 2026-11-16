import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createOrganizer } from '../lib/organize-jobs.js'
import { organizeStream, safeModelFailure } from '../lib/organize.js'

const model = 'deepseek-v4.1-flash'
const log = { events: [{ seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '核对步骤' }] } },
  { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '请补充依据' }] } } }] }
const report = JSON.stringify({ title: '测试', overview: '需要证据', cards: [{ category: 'next', title: '核对', body: '先核对依据', evidence: [1] }] })
async function fixture(provider = 'opencode-go', stream) {
  const calls = [], dataDir = await mkdtemp(join(tmpdir(), 'csx-route-'))
  const llm = { listProviders: () => [{ id: provider }], listModels: async () => [{ id: model }],
    prepareCall: async config => ({ config, stream(request) {
      calls.push(request)
      return stream ? stream(request) : (async function* () {
        yield { type: 'text-delta', index: 0, text: report }; yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } }) }
  const organizer = createOrganizer({ dataDir, getLlm: () => llm, getQuery: () => ({ readSession: async () => log }) })
  return { dataDir, calls, llm, organizer, preview: sessionId => organizer.preview({ sessionId, provider, model }) }
}
async function run(f, sid) {
  const plan = await f.preview(sid)
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  for (let i = 0; i < 100; i++) {
    const { job } = await f.organizer.get({ id: plan.planId, sessionId: sid })
    if (job.status !== 'running') return { plan, job }
    await delay(5)
  }
  assert.fail('did not settle')
}

test('OpenCode Go uses a stable auxiliary routing identity, without writing to the original conversation', async () => {
  const f = await fixture()
  const one = await run(f, 'real-session-A'), two = await run(f, 'real-session-A'), other = await run(f, 'real-session-B')
  assert.equal(one.job.status, 'completed'); assert.equal(two.job.status, 'completed'); assert.equal(other.job.status, 'completed')
  assert.match(f.calls[0].sessionId, /^context-studio-organize-[a-f0-9]{32}$/)
  assert.equal(f.calls[0].sessionId, f.calls[1].sessionId)
  assert.notEqual(f.calls[0].sessionId, f.calls[2].sessionId)
  assert.equal(f.calls[0].sessionId.includes('real-session'), false)
  assert.equal(f.calls[0].purpose, 'context-studio-organize')
  assert.deepEqual(f.calls[0].tools, [])
  await f.organizer.start({ planId: one.plan.planId, confirmed: true })
  assert.equal(f.calls.length, 3)
})

test('OpenCode paid route also receives routing identity; unrelated routes remain unchanged', async () => {
  for (const provider of ['opencode', 'deepseek-official', 'custom']) {
    const f = await fixture(provider)
    assert.equal((await run(f, 's')).job.status, 'completed')
    if (provider === 'opencode') assert.match(f.calls[0].sessionId, /^context-studio-organize-/)
    else assert.equal(f.calls[0].sessionId, undefined)
  }
})

test('in-band upstream failure retains only safe classification, stage and finish metadata', async () => {
  const f = await fixture('opencode-go', () => (async function* () {
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '400 x-opencode-session header is required; Authorization: PRIVATE_SENTINEL' } } }
  })())
  const { job } = await run(f, 's')
  assert.equal(job.status, 'failed')
  assert.match(job.error, /INVALID_REQUEST/)
  assert.deepEqual(job.diagnostic, { stage: 'model-stream', code: 'INVALID_REQUEST', finishKind: 'error', textChars: 0 })
  const stored = await readFile(join(f.dataDir, 'organize', job.id.split('.')[0], `${job.id}.json`), 'utf8')
  assert.equal(stored.includes('PRIVATE_SENTINEL'), false)
  assert.equal(JSON.stringify(job).includes('PRIVATE_SENTINEL'), false)
  assert.equal(f.calls.length, 1)
})

test('thrown provider failures and bad report JSON preserve their distinct stages', async () => {
  const f = await fixture()
  f.llm.prepareCall = async () => { throw Object.assign(new Error('PRIVATE_SENTINEL'), { code: 'AUTH', status: 403 }) }
  const denied = await run(f, 's')
  assert.deepEqual(denied.job.diagnostic, { stage: 'model-prepare', code: 'AUTH', httpStatus: 403 })
  assert.equal(JSON.stringify(denied.job).includes('PRIVATE_SENTINEL'), false)
  const malformed = await fixture('custom', () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '{' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  assert.equal((await run(malformed, 's')).job.diagnostic.stage, 'report-parse')
})

test('safe diagnostic accepts only known codes/statuses and never returns arbitrary provider strings', () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER'], [400, 'INVALID_REQUEST']]) {
    const e = safeModelFailure({ message: 'PRIVATE_SENTINEL', status })
    assert.equal(e.diagnostic.code, code); assert.equal(e.message.includes('PRIVATE_SENTINEL'), false)
  }
  for (const code of ['PRIVATE_SENTINEL', '__proto__', 'constructor', { toString: () => 'AUTH' }]) {
    const e = safeModelFailure({ code, message: 'PRIVATE_SENTINEL', status: 999 })
    assert.deepEqual(e.diagnostic, { code: 'UNKNOWN_MODEL_ERROR' })
    assert.equal(e.message.includes('PRIVATE_SENTINEL'), false)
  }
})

test('unknown/missing finish and token exhaustion stay failures with bounded metadata', async () => {
  for (const kind of ['max-tokens', 'tool-calls', 'PRIVATE_SENTINEL', undefined]) {
    const stream = (async function* () { if (kind) yield { type: 'finish', reason: { kind } } })()
    await assert.rejects(organizeStream(stream, new AbortController().signal, () => {}), e => {
      assert.equal(e.message.includes('PRIVATE_SENTINEL'), false)
      assert.equal(e.diagnostic.finishKind, kind === undefined ? 'missing' : kind === 'PRIVATE_SENTINEL' ? 'unknown' : kind)
      return true
    })
  }
})

test('provider prose cannot override safe classifications or imply a more specific cause', async () => {
  const failure = { code: 'AUTH', status: 401, message: 'Missing API key. Request headers: {"x-opencode-session":"present"}' }
  const f = await fixture('opencode-go', () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure } }
  })())
  const { job } = await run(f, 's')
  assert.equal(job.diagnostic.code, 'AUTH')
  assert.equal(job.diagnostic.httpStatus, 401)
  assert.equal(job.error.includes(failure.message), false)
  assert.equal(safeModelFailure({ ...failure, code: 'INVALID_REQUEST', status: 400 }).diagnostic.code, 'INVALID_REQUEST')
  assert.equal(safeModelFailure({ code: 'AUTH', message: 'x-opencode-session header is required' }).diagnostic.code, 'AUTH')
  for (const message of ['x-opencode-session header is required', 'Missing header: x-opencode-session',
    'must provide the x-opencode-session header', 'Missing parameter: messages. Required header x-opencode-session is present.']) {
    assert.equal(safeModelFailure({ code: 'INVALID_REQUEST', message }).diagnostic.code, 'INVALID_REQUEST')
  }
  assert.equal(safeModelFailure({ message: 'Missing header: x-opencode-session' }).diagnostic.code, 'UNKNOWN_MODEL_ERROR')
})
