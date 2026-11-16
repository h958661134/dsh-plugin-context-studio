import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ORGANIZE_LIMITS, ORGANIZE_SYSTEM, hashText, organizeReport } from '../lib/organize.js'
import { createOrganizer } from '../lib/organize-jobs.js'
import { atomicWrite } from '../lib/ops.js'

const sources = [{ seq: 0 }, { seq: 7 }, { seq: 42 }]
const invalidRelation = '模型返回了无效或不受支持的关系，已忽略。'
const inference = '关系仅为模型根据所给片段提出的推测，不代表已证明的因果或依赖；请核对原文。'
const invalidRef = '模型提供了不在本次材料中的引用，已移除，相关说法尚未验证。'
const card = (id, extra = {}) => ({ id, category: 'evidence', title: '原文线索', body: '仍需核对原文。', evidence: [0], ...extra })
const edge = (extra = {}) => ({ from: 'a', to: 'b', kind: 'supports', evidence: [0], ...extra })
const report = (extra = {}) => ({ title: '整理', overview: '只根据选入片段整理。', cards: [card('a'), card('b')], branch: null, ...extra })
const parse = (extra = {}, inputSources = sources) => organizeReport(JSON.stringify(report(extra)), inputSources)

test('map: old model output preserves every existing field and gains only an empty relations array', () => {
  const raw = report({ cards: [card(undefined)], branch: { task: '核对原文', sources: [7] } })
  assert.deepEqual(organizeReport(JSON.stringify(raw), sources), {
    title: raw.title, overview: raw.overview,
    cards: [{ id: 'card-1', category: 'evidence', title: '原文线索', body: '仍需核对原文。', evidence: [0] }],
    branch: raw.branch, relations: [], warnings: [],
  })
})

test('map: absent or empty relations never infer edges from card order, category or shared evidence', () => {
  for (const extra of [{}, { relations: [] }]) {
    const result = parse(extra)
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [])
  }
})

test('map: all supported directed kinds map original IDs to sequential IDs and disclose inference', () => {
  const kinds = ['supports', 'questions', 'addresses', 'depends_on']
  const result = parse({ cards: [card('card-2'), card('card-1')],
    relations: kinds.map(kind => edge({ kind, from: 'card-1', to: 'card-2', evidence: [42, 0, 42] })) })
  assert.deepEqual(result.cards.map(c => c.id), ['card-1', 'card-2'])
  assert.deepEqual(result.relations, kinds.map((kind, i) => ({
    id: `relation-${i + 1}`, kind, from: 'card-2', to: 'card-1', evidence: [42, 0],
  })))
  assert.deepEqual(result.warnings, [inference])
})

test('map: filtered cards do not shift endpoint identity and invalid edges do not consume relation IDs', () => {
  const result = parse({ cards: [card('bad', { category: 'execute' }), card('a'), card('b')], relations: [
    edge({ from: 'bad' }), edge(), edge({ to: 'missing' }), edge({ from: 'b', to: 'a', kind: 'questions' }),
  ] })
  assert.deepEqual(result.relations, [
    { id: 'relation-1', kind: 'supports', from: 'card-1', to: 'card-2', evidence: [0] },
    { id: 'relation-2', kind: 'questions', from: 'card-2', to: 'card-1', evidence: [0] },
  ])
  assert.equal(result.warnings.filter(w => w === invalidRelation).length, 1)
})

test('map: duplicate original IDs cannot authorize either endpoint, including invalid or capped cards', () => {
  const variants = [
    [card('a'), card('b'), card('a')],
    [card('a'), card('b'), card('a', { category: 'unsupported' })],
    [card('a'), card('b'), card('a', { body: ' ' })],
    [card('a'), card('b'), ...Array.from({ length: 18 }, (_, i) => card(`filler-${i}`)), card('a')],
  ]
  for (const cards of variants) {
    const result = parse({ cards, relations: [edge(), edge({ from: 'b', to: 'a' })] })
    assert.deepEqual(result.relations, [])
    assert.ok(result.cards.length >= 2, 'ambiguous IDs must not remove otherwise valid cards')
    assert.equal(result.warnings.filter(w => w === invalidRelation).length, 1)
    assert.equal(result.warnings.includes(inference), false)
  }
})

test('map: cards without supported IDs remain readable but cannot be relation endpoints', () => {
  for (const id of [undefined, null, '', ' \t\n', 0, 1, true, [], {}, 'x'.repeat(101)]) {
    for (const endpoint of ['from', 'to']) {
      const result = parse({ cards: [card(id), card('b')], relations: [edge({
        from: endpoint === 'from' ? id : 'b', to: endpoint === 'to' ? id : 'b',
      })] })
      assert.equal(result.cards.length, 2)
      assert.deepEqual(result.relations, [])
      assert.deepEqual(result.warnings, [invalidRelation])
    }
  }
})

test('map: opaque IDs use exact string equality and Map-safe names without coercion or normalization', () => {
  for (const [from, to] of [['__proto__', 'constructor'], ['toString', 'hasOwnProperty'], ['1', ' a '], ['a', 'A'], ['x'.repeat(100), 'b']]) {
    const result = parse({ cards: [card(from), card(to)], relations: [edge({ from, to })] })
    assert.deepEqual(result.relations, [{ id: 'relation-1', kind: 'supports', from: 'card-1', to: 'card-2', evidence: [0] }])
  }
  for (const from of [1, 'a', 'CARD-1', 'card-1']) {
    const result = parse({ cards: [card('1'), card(' a '), card('b')], relations: [edge({ from })] })
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [invalidRelation])
  }
  const prefix = 'x'.repeat(100)
  assert.deepEqual(parse({ cards: [card(prefix), card('b')], relations: [edge({ from: prefix + 'x' })] }).relations, [])
})

test('map: missing IDs never fall back to generated card IDs', () => {
  const result = parse({ cards: [card(undefined), card(undefined)], relations: [edge({ from: 'card-1', to: 'card-2' })] })
  assert.deepEqual(result.relations, [])
  assert.deepEqual(result.warnings, [invalidRelation])
})

test('map: unsupported relations containers and malformed entries are dropped with a fixed warning', () => {
  for (const relations of [null, false, 42, 'PRIVATE_RELATIONS', {}, { from: 'a', to: 'b' }]) {
    const result = parse({ relations })
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [invalidRelation])
  }
  for (const relation of [null, false, 1, 'PRIVATE_RELATION', [], ['a', 'b'], {}, { from: 'a' }]) {
    const result = parse({ relations: [relation] })
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [invalidRelation])
  }
})

test('map: unknown or non-string kinds, self loops and missing endpoints never become edges', () => {
  for (const kind of [undefined, null, '', 'causes', 'SUPPORTS', 'supports ', '__proto__', 'constructor', ['supports'], 1, {}]) {
    const result = parse({ relations: [edge({ kind })] })
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [invalidRelation])
  }
  for (const change of [{ from: 'b' }, { to: 'a' }, { from: 'missing' }, { to: 'missing' },
    { from: undefined }, { to: null }, { from: ['a'] }, { to: { id: 'b' } }]) {
    const result = parse({ relations: [edge(change)] })
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [invalidRelation])
  }
})

test('map: relation evidence requires at least one safe integer in this input sources set', () => {
  const rejected = [undefined, null, false, 0, '0', { seq: 0 }, [], ['0'], [-1, 0.5, 1, 999],
    [Number.MAX_SAFE_INTEGER + 1], [null, false, {}, [0]]]
  for (const evidence of rejected) {
    const result = parse({ relations: [edge({ evidence })] })
    assert.deepEqual(result.relations, [])
    assert.ok(result.warnings.includes(invalidRelation))
    assert.equal(result.warnings.includes(inference), false)
  }
  const result = parse({ relations: [edge()] }, [])
  assert.deepEqual(result.relations, [])
  assert.ok(result.warnings.includes(invalidRelation))
})

test('map: evidence removes forged refs and duplicates, while preserving valid source order', () => {
  const result = parse({ relations: [edge({ evidence: [42, '7', 999, 42, 7, 0, -1, { seq: 0 }] })] })
  assert.deepEqual(result.relations[0].evidence, [42, 7, 0])
  assert.deepEqual(result.warnings, [invalidRef, inference])
})

test('map: a source reference is not proof and need not occur in either card evidence list', () => {
  const result = parse({ cards: [card('a', { evidence: [] }), card('b', { evidence: [] })], relations: [edge({ evidence: [7] })] })
  assert.deepEqual(result.relations[0].evidence, [7])
  assert.deepEqual(result.warnings, [inference])
})

test('map: source membership alone cannot authorize non-integer or unsafe evidence', () => {
  for (const seq of ['0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const result = parse({ relations: [edge({ evidence: [seq] })] }, [{ seq }])
    assert.deepEqual(result.relations, [])
    assert.ok(result.warnings.includes(invalidRelation))
  }
})

test('map: evidence checks only the first eight entries and never backfills a ninth valid reference', () => {
  const inputSources = Array.from({ length: 10 }, (_, seq) => ({ seq }))
  const result = parse({ relations: [edge({ evidence: inputSources.map(s => s.seq) })] }, inputSources)
  assert.deepEqual(result.relations[0].evidence, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.ok(result.warnings.includes('部分关系引用过多，仅展示前8个。'))
  const late = parse({ relations: [edge({ evidence: [...Array(8).fill(999), 0] })] })
  assert.deepEqual(late.relations, [])
  assert.ok(late.warnings.includes(invalidRelation))
})

test('map: at most the first twenty cards and forty relations are considered', () => {
  const cards = Array.from({ length: 21 }, (_, i) => card(`n-${i}`))
  const relations = Array.from({ length: 41 }, (_, i) => edge({
    from: `n-${Math.floor(i / 19)}`, to: `n-${i % 19 + 1}`,
  }))
  const result = parse({ cards, relations })
  assert.equal(result.cards.length, 20)
  assert.equal(result.relations.length, 38, 'two self loops in the first forty are dropped without backfill')
  assert.deepEqual(result.relations.map(r => r.id), Array.from({ length: 38 }, (_, i) => `relation-${i + 1}`))
  assert.ok(result.warnings.includes('模型卡片过多，仅保留前20张。'))
  assert.ok(result.warnings.includes('模型关系过多，仅检查前40条。'))
  const cappedEndpoint = parse({ cards, relations: [edge({ from: 'n-0', to: 'n-20' })] })
  assert.deepEqual(cappedEndpoint.relations, [])
  assert.ok(cappedEndpoint.warnings.includes(invalidRelation))
  const invalidPrefix = parse({ relations: [...Array(40).fill(null), edge()] })
  assert.deepEqual(invalidPrefix.relations, [])
})

test('map: forty valid edges survive without overflow warnings and additional edges are capped', () => {
  const cards = Array.from({ length: 8 }, (_, i) => card(`n-${i}`))
  const relations = cards.flatMap(a => cards.filter(b => a.id !== b.id).map(b => edge({ from: a.id, to: b.id })))
  const exact = parse({ cards, relations: relations.slice(0, 40) })
  assert.equal(exact.relations.length, 40)
  assert.deepEqual(exact.warnings, [inference])
  const capped = parse({ cards, relations })
  assert.deepEqual(capped.relations, exact.relations)
  assert.deepEqual(capped.warnings, ['模型关系过多，仅检查前40条。', inference])
})

test('map: model relation IDs, arbitrary fields, confidence and warning prose are not returned', () => {
  const marker = 'PRIVATE_UNTRUSTED_MARKER'
  const result = parse({ private: marker, warnings: [marker],
    cards: [card('a', { private: marker }), card('b')],
    relations: [edge({ id: marker, label: marker, evidence: [0], confidence: marker, proven: true, private: marker }),
      edge({ from: marker }), edge({ kind: marker }), edge({ evidence: [marker] })],
  })
  assert.deepEqual(Object.keys(result).sort(), ['title', 'overview', 'cards', 'branch', 'relations', 'warnings'].sort())
  assert.deepEqual(result.relations, [{ id: 'relation-1', kind: 'supports', from: 'card-1', to: 'card-2', evidence: [0] }])
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.deepEqual(result.warnings, [invalidRelation, invalidRef, inference])
  assert.equal(result.warnings.length, new Set(result.warnings).size)
})

test('map: existing text limits remain surrogate-safe and prose is never interpreted as an action', () => {
  const bounded = max => 'x'.repeat(max - 1) + '😀tail'
  const result = parse({ title: bounded(100), overview: bounded(800), cards: [
    card('a', { title: bounded(100), body: bounded(1500) }), card('b', { body: '<script>run()</script>' }),
  ], branch: { task: bounded(5000), sources: [7] }, relations: [edge()] })
  assert.equal(result.title, 'x'.repeat(99))
  assert.equal(result.overview, 'x'.repeat(799))
  assert.equal(result.cards[0].title, 'x'.repeat(99))
  assert.equal(result.cards[0].body, 'x'.repeat(1499))
  assert.equal(result.branch.task, 'x'.repeat(4999))
  assert.equal(result.cards[1].body, '<script>run()</script>', 'prose remains text for clients to escape')
  assert.ok(result.warnings.includes('部分卡片文字超长，已缩短显示。'))
  assert.equal(result.relations.length, 1)
})

test('map: relations cannot rescue malformed, missing-content or oversized reports', () => {
  for (const raw of ['{', 'null', '[]', JSON.stringify(report({ cards: [] })),
    JSON.stringify(report({ overview: ' ', relations: [edge()] })), 'x'.repeat(ORGANIZE_LIMITS.outputChars + 1)]) {
    assert.throws(() => organizeReport(raw, sources), e => e.status === 422)
  }
  const fenced = '```json\n' + JSON.stringify(report({ relations: [edge()] })) + '\n```'
  assert.equal(organizeReport(fenced, sources).relations.length, 1)
})

test('map: v2 prompt requests short uniquely identified nodes, source-backed relations and uncertainty', () => {
  assert.match(ORGANIZE_SYSTEM, /6-10个短节点/)
  assert.match(ORGANIZE_SYSTEM, /唯一、非空且不超过100字符的字符串id/)
  assert.match(ORGANIZE_SYSTEM, /每张body不超过400字；overview不超过180字/)
  assert.match(ORGANIZE_SYSTEM, /每条关系必须有至少一个实际records\.seq/)
  assert.match(ORGANIZE_SYSTEM, /不是已证明的因果/)
  assert.match(ORGANIZE_SYSTEM, /没有依据就省略关系/)
  for (const kind of ['supports', 'questions', 'addresses', 'depends_on']) assert.ok(ORGANIZE_SYSTEM.includes(kind))
})

// Integration uses only synthetic logs, a fake stream, and a dedicated temp
// directory. Never read DSH_HOME, construct an SDK or contact a real provider.
async function testDirectory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'csx-organize-map-'))
  t.after(async () => {
    const absolute = resolve(dataDir)
    assert.equal(dirname(absolute), resolve(tmpdir()))
    assert.ok(basename(absolute).startsWith('csx-organize-map-'))
    await rm(absolute, { recursive: true, force: true })
  })
  return dataDir
}

test('map: v3 receipt and normalized relations persist through one fake model call and restart', async t => {
  const dataDir = await testDirectory(t), receipts = [], counts = { prepare: 0, stream: 0 }
  const llm = {
    listProviders: () => [{ id: 'fake' }], listModels: async () => [{ id: 'fake-model' }],
    async prepareCall(config) {
      counts.prepare++
      assert.equal(receipts[0].templateVersion, 3, 'v3 receipt must exist before prepare')
      return { config, stream(request) {
        counts.stream++
        assert.deepEqual(request.tools, [])
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: JSON.stringify(report({ relations: [edge()] })) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      } }
    },
  }
  const deps = { dataDir, getLlm: () => llm, getQuery: () => ({ readSession: async () => ({ events: [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic source.' }] } },
  ] }) }), async write(path, value, opts) {
    await atomicWrite(path, value, opts)
    if (opts?.exclusive) receipts.push(JSON.parse(value))
  } }
  const organizer = createOrganizer(deps)
  t.after(() => organizer.dispose())
  const plan = await organizer.preview({ sessionId: 'map-session', provider: 'fake', model: 'fake-model' })
  await organizer.start({ planId: plan.planId, confirmed: true })
  let job
  for (let i = 0; i < 200; i++) {
    ;({ job } = await organizer.get({ id: plan.planId, sessionId: 'map-session' }))
    if (job.status !== 'running') break
    await delay(5)
  }
  assert.equal(job.status, 'completed', job.error)
  assert.equal(job.persistenceWarning, undefined)
  assert.deepEqual(job.report.relations, parse({ relations: [edge()] }).relations)
  const saved = JSON.parse(await readFile(join(dataDir, 'organize', plan.planId.split('.')[0], `${plan.planId}.json`), 'utf8'))
  assert.equal(saved.templateVersion, 3)
  assert.equal(saved.version, 1, 'storage schema version remains backward compatible')
  assert.deepEqual(saved.report, job.report)
  const restarted = createOrganizer(deps)
  t.after(() => restarted.dispose())
  assert.deepEqual((await restarted.get({ id: plan.planId, sessionId: 'map-session' })).job.report, job.report)
  await restarted.start({ planId: plan.planId, confirmed: true })
  assert.deepEqual(counts, { prepare: 1, stream: 1 })
})

test('map: persisted v1 reports without relations remain unchanged and never trigger a model call', async t => {
  const dataDir = await testDirectory(t), sessionId = 'legacy-map-session'
  const key = hashText(sessionId).slice(0, 32), id = `${key}.1700000000000.00000000-0000-4000-8000-000000000000`
  const directory = join(dataDir, 'organize', key), path = join(directory, `${id}.json`)
  const oldReport = { title: '旧简报', overview: '保留旧结论', cards: [card('card-1')], branch: null, warnings: [] }
  const body = JSON.stringify({ version: 1, templateVersion: 1, id, sessionId, status: 'completed', sources, report: oldReport })
  await mkdir(directory, { recursive: true })
  await writeFile(path, body)
  const organizer = createOrganizer({ dataDir, getQuery() { assert.fail('must not read history') }, getLlm() { assert.fail('must not access model') } })
  t.after(() => organizer.dispose())
  const { job } = await organizer.get({ id, sessionId })
  assert.deepEqual(job.report, oldReport)
  assert.equal(Object.hasOwn(job.report, 'relations'), false)
  assert.deepEqual((await organizer.start({ planId: id, confirmed: true })).job.report, oldReport)
  assert.equal(await readFile(path, 'utf8'), body)
})
