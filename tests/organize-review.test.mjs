import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createOrganizer } from '../lib/organize-jobs.js'
import { ORGANIZE_LIMITS, organizeOptions, organizeReport, organizeSnapshot, organizeStream, organizeUsage } from '../lib/organize.js'
import { atomicWrite } from '../lib/ops.js'

const user = (seq, text, kind = 'user', extra = {}) => ({ seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind }, content: [{ type: 'text', text }] }, ...extra })
const answer = (seq, text) => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: seq, message: { content: [{ type: 'text', text }] } } })
const snapshot = () => ({ session: { id: 'review-session' }, events: [user(0, 'synthetic requirement'), answer(1, 'synthetic answer')] })
const options = extra => ({ sessionId: 'review-session', provider: 'fake', model: 'fake-model', ...extra })
const report = extra => ({ title: 'synthetic', overview: 'Only a test fixture.', cards: [{ category: 'evidence', title: 'fixture', body: 'verify original', evidence: [0] }], branch: null, ...extra })
const chunks = values => (async function* () { yield* values })()
const textChunks = (body = JSON.stringify(report())) => [{ type: 'text-delta', index: 0, text: body }, { type: 'block-end', index: 0, block: { type: 'text', text: body } }]
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function until(read, predicate, message = 'condition did not settle') {
  const end = Date.now() + 2500
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(5) }
  assert.fail(message)
}

// Only synthetic logs and this test's own isolated directory are used. No DSH,
// network client, credential lookup or real model is constructed.
async function fixture(t, config = {}) {
  const dataDir = await fs.mkdtemp(join(tmpdir(), 'csx-organize-review-'))
  const counts = { prepare: 0, stream: 0, reads: 0 }, sent = [], writes = new Set(), releases = []
  const llm = {
    listProviders() { return [{ id: 'fake', name: 'Fixture', private: 'CATALOG_PRIVATE' }] },
    async listModels() { return [{ provider: 'fake', id: 'fake-model', name: 'Fixture model', private: 'MODEL_PRIVATE' }] },
    async prepareCall(callConfig, signal) {
      counts.prepare++
      if (config.prepare) return config.prepare(callConfig, signal)
      return { config: { ...callConfig, reasoningEffort: 'fixture-default' }, stream(request) {
        counts.stream++; sent.push(request)
        return config.stream ? config.stream(request) : chunks([...textChunks(), { type: 'finish', reason: { kind: 'stop' } }])
      } }
    },
  }
  const query = { async readSession() { counts.reads++; return config.log ?? snapshot() } }
  // Cordis may return a fresh contextual service proxy on every get().
  // Wrapper identity is intentionally not a stable service generation token.
  let owner = llm
  const getLlm = () => config.freshWrappers ? new Proxy(owner, {
    get(target, key, receiver) {
      if (key === Symbol.for('cordis.original')) return target
      return Reflect.get(target, key, receiver)
    },
  }) : owner
  const write = (path, value, opts) => {
    const work = Promise.resolve().then(() => (config.write ?? atomicWrite)(path, value, opts))
    writes.add(work); work.then(() => writes.delete(work), () => writes.delete(work))
    return work
  }
  const deps = { dataDir, getQuery: () => query, getLlm, write, ...(config.now ? { now: config.now } : {}), timeoutMs: config.timeoutMs ?? 3000 }
  const organizer = createOrganizer(deps), instances = [organizer]
  const fileFor = id => join(dataDir, 'organize', id.split('.')[0], `${id}.json`)
  async function saved(id, status) {
    return until(async () => { try { return JSON.parse(await fs.readFile(fileFor(id), 'utf8')) } catch { return null } }, v => v?.status === status)
  }
  t.after(async () => {
    for (const instance of instances) instance.dispose()
    for (const release of releases) release()
    await delay(10)
    while (writes.size) await Promise.allSettled([...writes])
    const absolute = resolve(dataDir)
    assert.equal(dirname(absolute), resolve(tmpdir()))
    assert.ok(basename(absolute).startsWith('csx-organize-review-'))
    await fs.rm(absolute, { recursive: true, force: true })
  })
  return { organizer, counts, sent, releases, fileFor, saved, dataDir, llm,
    replaceOwner(value) { owner = value },
    restart() { const instance = createOrganizer(deps); instances.push(instance); return instance },
  }
}

test('review R1: first terminal failure cannot be replaced by a later stop', async () => {
  await assert.rejects(organizeStream(chunks([...textChunks(),
    { type: 'finish', reason: { kind: 'error', failure: { message: 'synthetic failure' } } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), new AbortController().signal, () => {}))
})

test('review R2: provider HTTP status does not authorize raw error disclosure', async t => {
  const f = await fixture(t, { prepare() { throw Object.assign(new Error('PROVIDER_PRIVATE_SENTINEL'), { status: 401 }) } })
  const plan = await f.organizer.preview(options())
  const { job } = await f.organizer.start({ planId: plan.planId, confirmed: true })
  const stored = await f.saved(job.id, 'failed')
  const result = await f.organizer.get({ id: job.id, sessionId: plan.sessionId })
  assert.equal(JSON.stringify(result).includes('PROVIDER_PRIVATE_SENTINEL'), false)
  assert.equal(JSON.stringify(stored).includes('PROVIDER_PRIVATE_SENTINEL'), false)
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  assert.equal(f.counts.prepare, 1)
  assert.equal(f.counts.stream, 0)
})

test('review R3: dispose during exclusive receipt write must prevent dispatch', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { async write(path, value, opts) {
    if (opts?.exclusive) { entered.resolve(); await release.promise }
    return atomicWrite(path, value, opts)
  } })
  f.releases.push(release.resolve)
  const plan = await f.organizer.preview(options())
  const starting = f.organizer.start({ planId: plan.planId, confirmed: true })
  const outcome = starting.then(value => ({ value }), error => ({ error }))
  await entered.promise
  f.organizer.dispose()
  release.resolve()
  const result = await outcome
  assert.equal(f.counts.prepare, 0, 'disposed organizer must not prepare a provider call after persistence resumes')
  assert.equal(f.counts.stream, 0)
  assert.equal(result.value?.job.status, 'cancelled')
  await f.saved(plan.planId, 'cancelled')
  const restarted = f.restart()
  assert.equal((await restarted.start({ planId: plan.planId, confirmed: true })).job.status, 'cancelled')
  assert.equal(f.counts.prepare, 0)
})

test('review: catalog/preview/history/get and non-boolean confirmation never generate', async t => {
  const f = await fixture(t)
  const catalog = await f.organizer.models()
  assert.equal(catalog.available, true)
  assert.equal(JSON.stringify(catalog).includes('_PRIVATE'), false)
  const plan = await f.organizer.preview(options())
  assert.equal(plan.sources.length, 2)
  assert.deepEqual(await f.organizer.history(plan.sessionId), { jobs: [] })
  await assert.rejects(f.organizer.get({ id: plan.planId, sessionId: plan.sessionId }))
  await assert.rejects(f.organizer.cancel({ id: plan.planId, sessionId: plan.sessionId }))
  for (const confirmed of [undefined, false, 1, 'true', {}, []]) {
    await assert.rejects(f.organizer.start({ planId: plan.planId, confirmed }), e => e.status === 400)
  }
  assert.equal(f.counts.prepare, 0)
  assert.equal(f.counts.stream, 0)
})

test('review: simultaneous duplicate starts use one receipt and immutable preview snapshot', async t => {
  const f = await fixture(t)
  const plan = await f.organizer.preview(options())
  const approved = { system: plan.system, input: plan.input, sources: structuredClone(plan.sources) }
  plan.system = 'MUTATED'; plan.input = 'MUTATED'; plan.sources[0].text = 'MUTATED'
  const results = await Promise.all(Array.from({ length: 25 }, () => f.organizer.start({ planId: plan.planId, confirmed: true })))
  assert.ok(results.every(({ job }) => job.id === plan.planId))
  const stored = await f.saved(plan.planId, 'completed')
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
  assert.equal(f.sent[0].system, approved.system)
  assert.equal(f.sent[0].messages[0].content[0].text, approved.input)
  assert.equal(f.sent[0].maxTokens, 4096)
  assert.equal(f.sent[0].reasoningEffort, 'fixture-default')
  assert.deepEqual(f.sent[0].tools, [])
  assert.deepEqual(stored.sources, approved.sources)
  const restarted = f.restart()
  assert.equal((await restarted.start({ planId: plan.planId, confirmed: true })).job.status, 'completed')
  await restarted.history(plan.sessionId)
  await restarted.cancel({ id: plan.planId, sessionId: plan.sessionId })
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
})

test('review: expired plans require a fresh preview without generation', async t => {
  let clock = 1800000000000
  const f = await fixture(t, { now: () => clock })
  const expired = await f.organizer.preview(options())
  clock += ORGANIZE_LIMITS.planMs
  await assert.rejects(f.organizer.start({ planId: expired.planId, confirmed: true }), e => e.status === 409)
  assert.equal(f.counts.prepare, 0)
})

test('review R4: fresh proxies for one logical LLM service do not invalidate catalog or preview', async t => {
  const f = await fixture(t, { freshWrappers: true })
  assert.equal((await f.organizer.models()).available, true)
  assert.equal((await f.organizer.models()).available, true)
  const plan = await f.organizer.preview(options())
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.stream, 0)
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  await f.saved(plan.planId, 'completed')
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
  const oldPlan = await f.organizer.preview(options())
  // A different target is a genuine service replacement, unlike a new proxy.
  f.replaceOwner({ ...f.llm })
  await assert.rejects(f.organizer.start({ planId: oldPlan.planId, confirmed: true }), e => e.status === 409)
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
})

test('review R5: terminal status is published together with the final persistence outcome', { timeout: 5000 }, async t => {
  for (const failSave of [false, true]) {
    const entered = deferred(), release = deferred()
    const f = await fixture(t, { async write(path, value, opts) {
      if (!opts?.exclusive) {
        entered.resolve()
        await release.promise
        if (failSave) throw Object.assign(new Error('synthetic final save failure'), { code: 'ENOSPC' })
      }
      return atomicWrite(path, value, opts)
    } })
    f.releases.push(release.resolve)
    const plan = await f.organizer.preview(options())
    await f.organizer.start({ planId: plan.planId, confirmed: true })
    await entered.promise
    const before = await f.organizer.get({ id: plan.planId, sessionId: plan.sessionId })
    assert.equal(before.job.status, 'running', 'polling must not observe terminal status while persistence outcome is pending')
    const history = await f.organizer.history(plan.sessionId)
    assert.equal(history.jobs[0].status, 'running')
    release.resolve()
    const completed = await until(() => f.organizer.get({ id: plan.planId, sessionId: plan.sessionId }), x => x.job.status === 'completed')
    assert.equal(!!completed.job.persistenceWarning, failSave)
    assert.ok(completed.job.report)
    await f.organizer.start({ planId: plan.planId, confirmed: true })
    assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
  }
})

test('review: receipt persistence failure is fail-closed before prepare/stream', async t => {
  const f = await fixture(t, { write() { throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' }) } })
  const plan = await f.organizer.preview(options())
  await assert.rejects(f.organizer.start({ planId: plan.planId, confirmed: true }), e => e.status === 503)
  assert.equal(f.counts.prepare, 0); assert.equal(f.counts.stream, 0)
  assert.deepEqual(await f.organizer.history(plan.sessionId), { jobs: [] })
})

test('review: failed final save leaves durable interrupted receipt and restart never retries', async t => {
  const f = await fixture(t, { write(path, value, opts) {
    if (opts?.exclusive) return atomicWrite(path, value, opts)
    throw Object.assign(new Error('synthetic final save failure'), { code: 'ENOSPC' })
  } })
  const plan = await f.organizer.preview(options())
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  const local = await until(() => f.organizer.get({ id: plan.planId, sessionId: plan.sessionId }), x => !!x.job.persistenceWarning)
  assert.equal(local.job.status, 'completed')
  assert.ok(local.job.report)
  const restarted = f.restart()
  const old = await restarted.get({ id: plan.planId, sessionId: plan.sessionId })
  assert.equal(old.job.status, 'interrupted')
  assert.equal(old.job.report, null)
  assert.equal((await restarted.start({ planId: plan.planId, confirmed: true })).job.status, 'interrupted')
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
})

test('review: cancelled prepare still occupies slot until provider settles and cannot resume', async t => {
  const gate = deferred(); let lateStreams = 0
  const f = await fixture(t, { async prepare(config) { await gate.promise; return { config, stream() { lateStreams++; return chunks([]) } } } })
  f.releases.push(gate.resolve)
  const first = await f.organizer.preview(options()), second = await f.organizer.preview(options())
  await f.organizer.start({ planId: first.planId, confirmed: true })
  await f.organizer.cancel({ id: first.planId, sessionId: first.sessionId })
  const stopped = await until(() => f.organizer.get({ id: first.planId, sessionId: first.sessionId }), x => x.job.status === 'cancelled')
  assert.equal(stopped.job.active, true)
  await assert.rejects(f.organizer.start({ planId: second.planId, confirmed: true }), e => e.status === 409)
  await f.organizer.cancel({ id: first.planId, sessionId: first.sessionId })
  assert.equal((await f.organizer.start({ planId: first.planId, confirmed: true })).job.status, 'cancelled')
  assert.equal(f.counts.prepare, 1)
  gate.resolve()
  await until(() => f.organizer.get({ id: first.planId, sessionId: first.sessionId }), x => !x.job.active)
  assert.equal(lateStreams, 0)
  await f.saved(first.planId, 'cancelled')
})

test('review: timeout preserves observed usage and rejects late complete JSON without retry', async t => {
  const gate = deferred()
  const f = await fixture(t, { timeoutMs: 30, stream() { return (async function* () {
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 20, private: 'USAGE_PRIVATE' } }
    await gate.promise
    yield* textChunks()
    yield { type: 'finish', reason: { kind: 'stop' } }
  })() } })
  f.releases.push(gate.resolve)
  const plan = await f.organizer.preview(options())
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  const stopped = await until(() => f.organizer.get({ id: plan.planId, sessionId: plan.sessionId }), x => x.job.status === 'cancelled')
  assert.equal(stopped.job.active, true)
  assert.deepEqual(stopped.job.usage, { inputTokens: 12, outputTokens: 4, cacheReadTokens: 20 })
  gate.resolve()
  const done = await until(() => f.organizer.get({ id: plan.planId, sessionId: plan.sessionId }), x => !x.job.active)
  assert.equal(done.job.status, 'cancelled'); assert.equal(done.job.report, null)
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  assert.equal(f.counts.prepare, 1); assert.equal(f.counts.stream, 1)
  await f.saved(plan.planId, 'cancelled')
})

test('review: malformed JSON and forged evidence never become validated source links', () => {
  for (const raw of ['{', 'null', '[]', '{"cards":[],"overview":"x"}', JSON.stringify(report({ cards: [{ category: 'execute', title: 'x', body: 'run', evidence: [0] }] }))]) {
    assert.throws(() => organizeReport(raw, [{ seq: 0 }]), e => e.status === 422)
  }
  const body = report({ cards: [{ category: 'risk', title: 'check', body: 'Hypothesis only', evidence: [0, 0, '0', 1, -1, 1.5, { seq: 0 }] }], branch: { task: 'draft only', sources: [0, 999, '0'] }, opaque: 'REPORT_PRIVATE' })
  const result = organizeReport(JSON.stringify(body), [{ seq: 0 }])
  assert.deepEqual(result.cards[0].evidence, [0])
  assert.deepEqual(result.branch.sources, [0])
  assert.ok(result.warnings.length)
  assert.equal(JSON.stringify(result).includes('REPORT_PRIVATE'), false)
  assert.equal(organizeUsage({ inputTokens: '1', outputTokens: 2 }), null)
  assert.deepEqual(organizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, totalTokens: Infinity, reason: 'PRIVATE' }), { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 })
})

test('review: bounded stream uses authoritative blocks/latest usage and refuses incomplete/tool output', async () => {
  const observed = [], signal = new AbortController().signal
  const output = await organizeStream(chunks([...textChunks(),
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 } },
    { type: 'reasoning-delta', index: 1, text: 'REASONING_PRIVATE' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), signal, value => observed.push(value))
  assert.equal(output, JSON.stringify(report()))
  assert.deepEqual(observed.at(-1), { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 })
  for (const tail of [[], [{ type: 'finish', reason: { kind: 'max-tokens' } }], [{ type: 'finish', reason: { kind: 'aborted' } }], [{ type: 'tool-call-delta', index: 1, id: 'fake-tool' }, { type: 'finish', reason: { kind: 'stop' } }]]) {
    await assert.rejects(organizeStream(chunks([...textChunks(), ...tail]), signal, () => {}))
  }
  await assert.rejects(organizeStream(chunks([{ type: 'text-delta', index: 0, text: 'x'.repeat(ORGANIZE_LIMITS.outputChars + 1) }]), signal, () => {}))
})

test('review: snapshot keeps historical statuses and bounded visible text while excluding opaque/future data', async () => {
  const old = user(1, 'old project rule', 'agent-instructions')
  const revised = user(2, 'new project rule', 'agent-instructions', { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] })
  const unknown = user(3, 'uncertain position'); delete unknown.surfaceOp
  const hidden = { seq: 4, type: 'system/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: 'EXCLUDED_SYSTEM' }] } } }
  const target = answer(5, 'selected answer')
  target.data.message.content.push({ type: 'reasoning', text: 'REASONING_PRIVATE' })
  target.data.message.source = { replayState: { headers: 'REPLAY_PRIVATE' } }
  const log = { session: { id: 'review-session' }, events: [user(0, 'visible'), old, revised, unknown, hidden, target, user(6, 'FUTURE_PRIVATE')] }
  const result = await organizeSnapshot(log, organizeOptions(options({ answer: 5, budget: 8000 })))
  assert.deepEqual(result.sources.map(s => [s.seq, s.status]), [[0, 'active'], [1, 'replaced'], [2, 'active'], [3, 'unknown'], [5, 'answer']])
  assert.equal(result.coverage.excludedSystem, 1)
  for (const marker of ['EXCLUDED_SYSTEM', 'REASONING_PRIVATE', 'REPLAY_PRIVATE', 'FUTURE_PRIVATE']) assert.equal(result.input.includes(marker), false)
  const many = { session: log.session, events: Array.from({ length: 100 }, (_, seq) => user(seq, 'large😀'.repeat(3000))) }
  const bounded = await organizeSnapshot(many, organizeOptions(options({ budget: 8000 })))
  assert.ok(bounded.inputTokens <= 8000)
  assert.ok(bounded.sources.length <= ORGANIZE_LIMITS.sources)
  assert.ok(bounded.coverage.omitted > 0 && bounded.coverage.clipped > 0)
  assert.ok(bounded.sources.every(s => s.text.length <= ORGANIZE_LIMITS.sourceChars && s.end === s.offset + s.text.length && s.end <= s.totalChars))
})
