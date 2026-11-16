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
const warning = {
  path: '模型返回了无效或有歧义的AI整理路径，已整条忽略。',
  pathLimit: '模型AI整理路径过多，仅检查前8条。',
  titleLimit: '部分AI整理路径标题超长，已缩短显示。',
  aiPath: '路径仅为AI整理的阅读与核对顺序，不代表真实历史分支、执行顺序或因果链。',
  prefix: '部分AI整理路径的同一卡片位于不同前缀下，须分别显示路径实例，不可按卡片ID合并。',
  annotation: '部分卡片AI标注格式无效，已忽略或置为空；请核对原文。',
  textLimit: '部分卡片AI标注文字超长，已缩短显示。',
  state: '卡片状态仅为AI根据所给片段作出的标注，不表示已验证；请核对原文。',
  unresolved: 'AI标注的冲突或失效尚待核对，不应据此直接执行或丢弃材料。',
}
const card = (id, extra = {}) => ({ id, category: 'evidence', title: '核对线索', body: '根据原文核对。', evidence: [0], ...extra })
const path = (id = 'p', nodes = ['a', 'b'], extra = {}) => ({ id, title: '核对顺序', nodes, ...extra })
const relation = (extra = {}) => ({ from: 'a', to: 'b', kind: 'supports', evidence: [7], ...extra })
const report = (extra = {}) => ({ title: '测试简报', overview: '仅有合成材料。', cards: [card('a'), card('b')], branch: null, ...extra })
const parse = (extra = {}, inputSources = sources) => organizeReport(JSON.stringify(report(extra)), inputSources)

test('console: absent additions preserve the complete v1.6 shape without invented paths or annotations', () => {
  const raw = report({ cards: [card(undefined)], branch: { task: '继续核对', sources: [7] } })
  assert.deepEqual(organizeReport(JSON.stringify(raw), sources), {
    title: raw.title, overview: raw.overview, branch: raw.branch,
    cards: [{ id: 'card-1', category: 'evidence', title: '核对线索', body: '根据原文核对。', evidence: [0] }],
    relations: [], warnings: [],
  })
  assert.equal(Object.hasOwn(parse(), 'paths'), false)
  assert.deepEqual(parse({ paths: [] }).paths, [])
  assert.deepEqual(parse({ paths: [] }).warnings, [])
})

test('console: category, title, card evidence and relations never synthesize paths, summaries or states', () => {
  for (const category of ['goal', 'decision', 'evidence', 'risk', 'next']) {
    const result = parse({ cards: [card('a', { category, title: '已验证/已失效/存在冲突', body: 'summary: fabricated' }), card('b')],
      relations: [relation()] })
    assert.equal(Object.hasOwn(result, 'paths'), false)
    for (const key of ['summary', 'scope', 'caveat', 'state']) assert.equal(Object.hasOwn(result.cards[0], key), false)
  }
})

test('console: paths use normalized IDs after card filtering and retain input node order', () => {
  const result = parse({ cards: [card('discarded', { category: 'unknown' }), card('card-2'), card('card-1')], paths: [
    path('invalid', ['discarded']), path('path-9', ['card-1', 'card-2']), path('path-1', ['card-2']),
  ] })
  assert.deepEqual(result.paths, [
    { id: 'path-1', title: '核对顺序', nodes: ['card-2', 'card-1'] },
    { id: 'path-2', title: '核对顺序', nodes: ['card-1'] },
  ])
  assert.ok(result.warnings.includes(warning.path))
  assert.ok(result.warnings.includes(warning.aiPath))
  assert.ok(result.warnings.includes(warning.prefix))
})

test('console: complete common prefixes and terminal prefixes are valid without conflict warnings', () => {
  const result = parse({ cards: ['a', 'b', 'c', 'd'].map(id => card(id)), paths: [
    path('one', ['a', 'b', 'c']), path('two', ['a', 'b', 'd']), path('end', ['a', 'b']),
  ] })
  assert.deepEqual(result.paths.map(p => p.nodes), [['card-1', 'card-2', 'card-3'], ['card-1', 'card-2', 'card-4'], ['card-1', 'card-2']])
  assert.deepEqual(result.warnings, [warning.aiPath])
})

test('console: different roots form a forest and are not forced into one root', () => {
  const result = parse({ cards: ['a', 'b', 'c', 'd'].map(id => card(id)), paths: [path('one', ['a', 'b']), path('two', ['c', 'd'])] })
  assert.deepEqual(result.paths.map(p => p.nodes), [['card-1', 'card-2'], ['card-3', 'card-4']])
  assert.deepEqual(result.warnings, [warning.aiPath])
})

test('console: rejoining suffixes, repeated parents and reversed paths survive as separate prefix instances', () => {
  for (const nodes of [
    [['a', 'b', 'd'], ['a', 'c', 'd']],
    [['a', 'b', 'd', 'e'], ['a', 'c', 'd', 'e']],
    [['a', 'b'], ['b', 'a']],
    [['a', 'b'], ['c', 'b']],
  ]) {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const result = parse({ cards: ids.map(id => card(id)), paths: nodes.map((n, i) => path(`p${i}`, n)) })
    assert.deepEqual(result.paths.map(p => p.nodes), nodes.map(n => n.map(id => `card-${ids.indexOf(id) + 1}`)))
    assert.deepEqual(result.warnings, [warning.aiPath, warning.prefix])
    assert.deepEqual(result.relations, [], 'path order never implies a supported relation')
  }
})

test('console: different path IDs may describe the same sequence without losing separate membership', () => {
  const result = parse({ paths: [path('one'), path('two', ['a', 'b'], { title: '另一核对角度' })] })
  assert.equal(result.paths.length, 2)
  assert.deepEqual(result.paths[0].nodes, result.paths[1].nodes)
  assert.notEqual(result.paths[0].id, result.paths[1].id)
  assert.notEqual(result.paths[0].title, result.paths[1].title)
  assert.deepEqual(result.warnings, [warning.aiPath])
})

test('console: malformed containers and items degrade only paths with fixed deduplicated warnings', () => {
  for (const paths of [null, false, 0, 'PRIVATE_CONTAINER', {}, { nodes: ['a'] }]) {
    const result = parse({ paths })
    assert.deepEqual(result.paths, [])
    assert.equal(result.cards.length, 2)
    assert.deepEqual(result.warnings, [warning.path])
  }
  for (const bad of [null, false, 0, 'PRIVATE_ITEM', [], {}, { id: 'p' }]) {
    const result = parse({ paths: [bad, bad] })
    assert.deepEqual(result.paths, [])
    assert.deepEqual(result.warnings, [warning.path])
  }
})

test('console: path IDs must be bounded nonblank strings, never coerced or generated for malformed paths', () => {
  for (const id of [undefined, null, false, 1, [], {}, '', ' \t\n', 'x'.repeat(101)]) {
    const result = parse({ paths: [path('p', ['a', 'b'], { id })] })
    assert.deepEqual(result.paths, [])
    assert.deepEqual(result.warnings, [warning.path])
  }
  for (const id of ['__proto__', 'constructor', 'p', ' p ', 'x'.repeat(100)]) {
    assert.equal(parse({ paths: [path(id)] }).paths[0].id, 'path-1')
  }
  assert.equal(parse({ paths: [path('p'), path(' p '), path('P')] }).paths.length, 3)
})

test('console: duplicate original path IDs invalidate every occurrence including malformed or ninth entries', () => {
  const variants = [
    [path('same'), path('same')],
    [path('same'), path('same', [])],
    [path('same'), { id: 'same', title: 5 }],
    [path('same'), ...Array.from({ length: 7 }, (_, i) => path(`other-${i}`)), path('same')],
  ]
  for (const paths of variants) {
    const result = parse({ paths })
    assert.equal(result.paths.length, paths.length > 8 ? 7 : 0)
    assert.ok(result.warnings.includes(warning.path))
    assert.deepEqual(result.paths.map(p => p.id), result.paths.map((_, i) => `path-${i + 1}`))
  }
})

test('console: path titles must be text and use the existing surrogate-safe 100-unit limit', () => {
  for (const title of [undefined, null, [], {}, 1, false, '', ' \n', ' '.repeat(100) + 'hidden']) {
    const result = parse({ paths: [path('p', ['a'], { title })] })
    assert.deepEqual(result.paths, [])
    assert.deepEqual(result.warnings, [warning.path])
  }
  const title = 'x'.repeat(99) + '😀tail'
  const result = parse({ paths: [path('p', ['a'], { title })] })
  assert.equal(result.paths[0].title, 'x'.repeat(99))
  assert.deepEqual(result.warnings, [warning.titleLimit, warning.aiPath])
  assert.equal(parse({ paths: [path('p', ['a'], { title: 'x'.repeat(100) })] }).paths[0].title.length, 100)
})

test('console: a bad node rejects the entire path without manufacturing adjacency', () => {
  for (const nodes of [undefined, null, false, 1, 'a', { 0: 'a' }, [], ['a', 'a'], ['a', 'b', 'a'],
    ['a', 'missing', 'b'], ['a', 1, 'b'], ['a', null, 'b'], [['a']], [{ id: 'a' }], ['card-1']]) {
    const result = parse({ paths: [path('p', nodes, { nodes })] })
    assert.deepEqual(result.paths, [])
    assert.deepEqual(result.relations, [])
    assert.deepEqual(result.warnings, [warning.path])
  }
})

test('console: raw card IDs must be unique across invalid and capped cards for path membership', () => {
  for (const duplicate of [card('a'), card('a', { category: 'unknown' }), card('a', { body: ' ' })]) {
    const result = parse({ cards: [card('a'), card('b'), duplicate], paths: [path()] })
    assert.deepEqual(result.paths, [])
    assert.ok(result.warnings.includes(warning.path))
  }
  const result = parse({ cards: [card('a'), card('b'), ...Array.from({ length: 18 }, (_, i) => card(`f${i}`)), card('a')], paths: [path()] })
  assert.equal(result.cards.length, 20)
  assert.deepEqual(result.paths, [])
  assert.ok(result.warnings.includes(warning.path))
})

test('console: missing, invalid or filtered card IDs never fall back to normalized IDs', () => {
  for (const id of [undefined, null, false, 1, [], {}, '', ' ', 'x'.repeat(101)]) {
    const result = parse({ cards: [card(id), card('b')], paths: [path('p', [id]), path('normalized', ['card-1'])] })
    assert.deepEqual(result.paths, [])
    assert.equal(result.cards.length, 2)
    assert.deepEqual(result.warnings, [warning.path])
  }
  for (const bad of [card('a', { body: ' ' }), card('a', { category: 'unknown' })]) {
    assert.deepEqual(parse({ cards: [bad, card('b')], paths: [path()] }).paths, [])
  }
})

test('console: raw card identifiers are exact opaque strings, including prototype names and whitespace', () => {
  const ids = ['__proto__', 'constructor', ' a ', 'a', 'A', '1', 'x'.repeat(100)]
  const result = parse({ cards: ids.map(id => card(id)), paths: [path('p', ids)] })
  assert.deepEqual(result.paths[0].nodes, ids.map((_, i) => `card-${i + 1}`))
  for (const id of [1, 'a ', 'x'.repeat(101)]) {
    assert.deepEqual(parse({ cards: ids.map(x => card(x)), paths: [path('p', [id])] }).paths, [])
  }
})

test('console: at most eight input paths are checked without backfill', () => {
  const exact = parse({ paths: Array.from({ length: 8 }, (_, i) => path(`p${i}`)) })
  assert.equal(exact.paths.length, 8)
  assert.deepEqual(exact.warnings, [warning.aiPath])
  const capped = parse({ paths: Array.from({ length: 9 }, (_, i) => path(`p${i}`)) })
  assert.deepEqual(capped.paths, exact.paths)
  assert.deepEqual(capped.warnings, [warning.pathLimit, warning.aiPath])
  const late = parse({ paths: [...Array(8).fill(null), path()] })
  assert.deepEqual(late.paths, [])
  assert.deepEqual(late.warnings, [warning.pathLimit, warning.path])
})

test('console: node lists allow singleton and twenty-node paths but never truncate longer lists', () => {
  const ids = Array.from({ length: 21 }, (_, i) => `n${i}`), cards = ids.map(id => card(id))
  assert.deepEqual(parse({ paths: [path('p', ['a'])] }).paths[0].nodes, ['card-1'])
  const exact = parse({ cards: cards.slice(0, 20), paths: [path('p', ids.slice(0, 20))] })
  assert.equal(exact.paths[0].nodes.length, 20)
  assert.deepEqual(exact.warnings, [warning.aiPath])
  for (const nodes of [ids, [...ids.slice(0, 20), 'n0'], ['n20']]) {
    const result = parse({ cards, paths: [path('p', nodes)] })
    assert.equal(result.cards.length, 20)
    assert.deepEqual(result.paths, [])
    assert.ok(result.warnings.includes(warning.path))
  }
})

test('console: optional card text is retained at its exact bound without deriving other fields', () => {
  for (const [key, max] of [['summary', 180], ['scope', 120], ['caveat', 160]]) {
    const result = parse({ cards: [card('a', { [key]: 'x'.repeat(max) })] })
    assert.equal(result.cards[0][key], 'x'.repeat(max))
    assert.deepEqual(result.warnings, [])
    for (const other of ['summary', 'scope', 'caveat', 'state'].filter(k => k !== key)) assert.equal(Object.hasOwn(result.cards[0], other), false)
  }
})

test('console: optional card text is surrogate-safe, bounded and never coerces invalid types', () => {
  for (const [key, max] of [['summary', 180], ['scope', 120], ['caveat', 160]]) {
    const result = parse({ cards: [card('a', { [key]: 'x'.repeat(max - 1) + '😀tail' })] })
    assert.equal(result.cards[0][key], 'x'.repeat(max - 1))
    assert.deepEqual(result.warnings, [warning.textLimit])
    for (const value of [null, false, 1, [], {}, '', ' \n', ' '.repeat(max) + 'hidden']) {
      const invalid = parse({ cards: [card('a', { [key]: value })] })
      assert.equal(Object.hasOwn(invalid.cards[0], key), false)
      assert.equal(invalid.cards.length, 1)
      assert.deepEqual(invalid.warnings, [warning.annotation])
    }
  }
})

test('console: every non-null supported state is an AI annotation, conflict and superseded remain pending', () => {
  for (const state of ['recorded', 'hypothesis', 'conflict', 'superseded']) {
    const result = parse({ cards: [card('a', { state })] })
    assert.equal(result.cards[0].state, state)
    assert.equal(Object.hasOwn(result.cards[0], 'caveat'), false, 'do not invent a model caveat')
    assert.deepEqual(result.warnings, [warning.state, ...(['conflict', 'superseded'].includes(state) ? [warning.unresolved] : [])])
    assert.equal(Object.hasOwn(result.cards[0], 'verified'), false)
  }
  const result = parse({ cards: [card('a', { state: null })] })
  assert.equal(result.cards[0].state, null)
  assert.deepEqual(result.warnings, [])
})

test('console: unsupported state values become null and cannot claim verified status', () => {
  for (const state of ['verified', 'active', 'replaced', 'unknown', 'RECORDED', 'recorded ', '', 'constructor', '__proto__', false, 1, [], ['recorded'], {}]) {
    const result = parse({ cards: [card('a', { state, verified: true, confidence: 1 })] })
    assert.equal(result.cards[0].state, null)
    assert.equal(Object.hasOwn(result.cards[0], 'verified'), false)
    assert.equal(Object.hasOwn(result.cards[0], 'confidence'), false)
    assert.deepEqual(result.warnings, [warning.annotation])
  }
})

test('console: optional annotations do not weaken the exact evidence whitelist', () => {
  const result = parse({ cards: [card('a', { summary: '有记录', scope: '局部', caveat: '待核对', state: 'recorded',
    evidence: [0, '7', 999, 7, 0, -1, 1.5, { seq: 42 }, 42] }), card('b')], paths: [path()],
    relations: [relation({ evidence: [42, 999, '0', 42] }), relation({ evidence: [999] })],
  })
  assert.deepEqual(result.cards[0].evidence, [0, 7])
  assert.deepEqual(result.relations.map(r => r.evidence), [[42]])
  assert.deepEqual(Object.keys(result.paths[0]).sort(), ['id', 'nodes', 'title'])
  assert.ok(result.warnings.includes(warning.state))
  assert.ok(result.warnings.includes('模型提供了不在本次材料中的引用，已移除，相关说法尚未验证。'))
})

test('console: paths are not proofs and do not require or synthesize relations or evidence', () => {
  const result = parse({ cards: [card('a', { evidence: [] }), card('b', { evidence: [] })], paths: [path()] }, [])
  assert.deepEqual(result.cards.map(c => c.evidence), [[], []])
  assert.equal(result.paths.length, 1)
  assert.deepEqual(result.relations, [])
  assert.deepEqual(result.warnings, [warning.aiPath])
})

test('console: arbitrary metadata and attacker-supplied warnings are excluded from output', () => {
  const marker = 'PRIVATE_UNTRUSTED_MARKER'
  const result = parse({ warnings: [marker], private: marker,
    cards: [card('a', { summary: '摘要', private: marker }), card('b', { state: marker })],
    paths: [path(marker, ['a', 'b'], { verified: true, type: marker, evidence: [999], action: marker }),
      path('bad', [marker]), path('bad-kind', ['a'], { title: { text: marker } })],
  })
  assert.deepEqual(Object.keys(result).sort(), ['title', 'overview', 'cards', 'branch', 'relations', 'paths', 'warnings'].sort())
  assert.deepEqual(result.paths, [{ id: 'path-1', title: '核对顺序', nodes: ['card-1', 'card-2'] }])
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.deepEqual(result.warnings, [warning.annotation, warning.path, warning.aiPath])
  assert.equal(result.warnings.length, new Set(result.warnings).size)
})

test('console: model prose remains untrusted text and cannot execute HTML or acquire action fields', () => {
  const value = '<script>throw Error("never execute")</script>'
  const result = parse({ cards: [card('a', { summary: value, scope: value, caveat: value, execute: 'run' })], paths: [path('p', ['a'], { title: value })] })
  for (const field of ['summary', 'scope', 'caveat']) assert.equal(result.cards[0][field], value)
  assert.equal(result.paths[0].title, value)
  assert.equal(Object.hasOwn(result.cards[0], 'execute'), false)
})

test('console: malformed base reports still fail and all existing length limits remain in force', () => {
  for (const raw of ['{', 'null', '[]', JSON.stringify(report({ cards: [], paths: [path()] })),
    JSON.stringify(report({ overview: ' ', paths: [path()] })), 'x'.repeat(ORGANIZE_LIMITS.outputChars + 1)]) {
    assert.throws(() => organizeReport(raw, sources), e => e.status === 422)
  }
  const result = parse({ title: 'x'.repeat(101), overview: 'x'.repeat(801), cards: [card('a', { title: 'x'.repeat(101), body: 'x'.repeat(1501) })],
    branch: { task: 'x'.repeat(5001), sources: [7] }, paths: [path('p', ['a'])] })
  assert.equal(result.title.length, 100)
  assert.equal(result.overview.length, 800)
  assert.equal(result.cards[0].title.length, 100)
  assert.equal(result.cards[0].body.length, 1500)
  assert.equal(result.branch.task.length, 5000)
})

test('console: prompt describes AI paths, complete prefix identity, pending states and bounded short nodes', () => {
  for (const phrase of ['6-10个短节点', 'summary', 'scope', 'caveat', 'recorded', 'hypothesis', 'conflict', 'superseded',
    'AI整理路径', '不是真实历史分支、执行顺序或因果链', '完整共享前缀', '不强制同root', '不从category或标题自动补路径',
    '明显冲突或失效需在caveat说明待核对', '只能是AI标注，不表示已验证', '最多8条', '1-20个不重复的原始card.id']) {
    assert.ok(ORGANIZE_SYSTEM.includes(phrase), phrase)
  }
})

// Only synthetic logs and a local fake model stream are used. The temporary
// directory is scoped and verified before cleanup; no user DSH data is read.
async function testDirectory(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'csx-organize-console-'))
  t.after(async () => {
    const absolute = resolve(dataDir)
    assert.equal(dirname(absolute), resolve(tmpdir()))
    assert.ok(basename(absolute).startsWith('csx-organize-console-'))
    await rm(absolute, { recursive: true, force: true })
  })
  return dataDir
}

test('console: template v3 and new fields persist through one fake call without changes to invocation safeguards', async t => {
  const dataDir = await testDirectory(t), receipts = [], calls = { prepare: 0, stream: 0 }
  const raw = report({ cards: [card('a', { summary: '短摘要', scope: '材料范围', caveat: '需核对', state: 'recorded' }), card('b')],
    paths: [path()], relations: [relation({ evidence: [0] })] })
  const llm = {
    listProviders: () => [{ id: 'fake' }], listModels: async () => [{ id: 'fake-model' }],
    async prepareCall(config) {
      calls.prepare++
      assert.equal(receipts[0].templateVersion, 3)
      return { config, stream(request) {
        calls.stream++
        assert.deepEqual(request.tools, [])
        assert.equal(request.sessionId, undefined)
        assert.equal(request.purpose, 'context-studio-organize')
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: JSON.stringify(raw) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      } }
    },
  }
  const deps = { dataDir, getLlm: () => llm, getQuery: () => ({ readSession: async () => ({ events: [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic input.' }] } },
  ] }) }), async write(file, value, opts) {
    await atomicWrite(file, value, opts)
    if (opts?.exclusive) receipts.push(JSON.parse(value))
  } }
  const organizer = createOrganizer(deps)
  t.after(() => organizer.dispose())
  const plan = await organizer.preview({ sessionId: 'console-session', provider: 'fake', model: 'fake-model' })
  assert.deepEqual(calls, { prepare: 0, stream: 0 })
  await assert.rejects(organizer.start({ planId: plan.planId }), /确认/)
  assert.deepEqual(calls, { prepare: 0, stream: 0 })
  await organizer.start({ planId: plan.planId, confirmed: true })
  let job
  for (let i = 0; i < 200; i++) {
    job = (await organizer.get({ id: plan.planId, sessionId: 'console-session' })).job
    if (job.status !== 'running') break
    await delay(5)
  }
  assert.equal(job.status, 'completed', job.error)
  assert.equal(job.persistenceWarning, undefined)
  assert.deepEqual(job.report, organizeReport(JSON.stringify(raw), [{ seq: 0 }]))
  const saved = JSON.parse(await readFile(join(dataDir, 'organize', plan.planId.split('.')[0], `${plan.planId}.json`), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.templateVersion, 3)
  assert.deepEqual(saved.report, job.report)
  const restarted = createOrganizer(deps)
  t.after(() => restarted.dispose())
  assert.deepEqual((await restarted.get({ id: plan.planId, sessionId: 'console-session' })).job.report, job.report)
  await restarted.start({ planId: plan.planId, confirmed: true })
  assert.deepEqual(calls, { prepare: 1, stream: 1 })
})

test('console: persisted v1 and v2 reports remain byte-identical without annotation, migration or generation', async t => {
  const dataDir = await testDirectory(t)
  for (const templateVersion of [1, 2]) {
    const sessionId = `legacy-console-${templateVersion}`, key = hashText(sessionId).slice(0, 32)
    const id = `${key}.1700000000000.00000000-0000-4000-8000-000000000000`
    const directory = join(dataDir, 'organize', key), file = join(directory, `${id}.json`)
    const oldReport = { ...report({ cards: [card('card-1')] }), warnings: [], ...(templateVersion === 2 ? { relations: [] } : {}) }
    const body = JSON.stringify({ version: 1, templateVersion, id, sessionId, status: 'completed', sources, report: oldReport })
    await mkdir(directory, { recursive: true })
    await writeFile(file, body)
    const organizer = createOrganizer({ dataDir, getQuery() { assert.fail('must not read user history') }, getLlm() { assert.fail('must not call model') } })
    t.after(() => organizer.dispose())
    const { job } = await organizer.get({ id, sessionId })
    assert.deepEqual(job.report, oldReport)
    assert.equal(Object.hasOwn(job.report, 'paths'), false)
    assert.deepEqual((await organizer.start({ planId: id, confirmed: true })).job.report, oldReport)
    assert.equal(await readFile(file, 'utf8'), body)
  }
})
