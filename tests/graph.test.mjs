import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { buildGraph, buildLineage, extractFacts, layoutChain, pathKey, resolveLoadPath, sha1 } from '../lib/graph.js'
import { createHandlers, resolveConfig } from '../lib/host.js'
import { fixture } from './helpers.mjs'

// 事件形状照抄真实 DSH 会话日志（session.v4.jsonl）
const um = (seq, source, text = '', time = 1000 + seq) => ({ seq, type: 'user/message', time, data: { content: text ? [{ type: 'text', text }] : [], source } })
const ins = (seq, changes) => um(seq, { kind: 'agent-instructions', form: 'instructions', baseline: true, changes })

test('extractFacts: 指令加载、技能、会话引用、继承前缀、拼图台起始', () => {
  const f = extractFacts([
    { seq: 0, type: 'session', time: 1 },
    um(1, { kind: 'user', rpcId: 'r-old' }, '旧问题'),
    { seq: 2, type: 'session/end-seed', time: 3, data: { inherited: true } },
    um(3, { kind: 'user', rpcId: 'r1' }, '# 起始上下文\n\n## 参考会话'),
    um(4, { kind: 'session-reference', form: 'recall', references: [{ sessionId: 'sA', label: '部署约定' }, { sessionId: 'sA', label: '部署约定' }] }),
    ins(5, [
      { action: 'set', scope: 'user-global\u0000AGENTS.md', path: '$DSH_HOME/AGENTS.md', digest: 'aaa' },
      { action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'bbb' },
    ]),
    ins(6, [{ action: 'replace', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: 'ccc' }, { action: 'remove', scope: 'x', path: 'gone.md' }]),
    um(7, { kind: 'skill-invocation', name: 'release', form: 'instructions' }),
    { seq: 8, type: 'tool/call', time: 9000, data: { name: 'skill', arguments: '{"name":"deploy"}' } },
    { seq: 9, type: 'tool/call', time: 9001, data: { name: 'skill', arguments: 'not json' } },
    um(10, { kind: 'runtime-context' }, 'Current runtime context'),
    um(11, { kind: 'user', rpcId: 'r2' }, '第二句'),
  ])
  assert.deepEqual(f.rpc, [{ id: 'r-old', inherited: true }, { id: 'r1', inherited: false }, { id: 'r2', inherited: false }])
  assert.equal(f.turns, 2, '继承来的用户消息不算这个会话的轮次')
  assert.equal(f.studio, true)
  assert.deepEqual(f.refs, [{ sessionId: 'sA', label: '部署约定' }])
  assert.deepEqual(f.loads.map(l => [l.path, l.digest]), [['$DSH_HOME/AGENTS.md', 'aaa'], ['AGENTS.md', 'ccc']])
  assert.deepEqual(f.skills.sort(), ['deploy', 'release'])
  assert.equal(f.lastTime, 9001)
  assert.equal(extractFacts(null).turns, 0)
  assert.equal(extractFacts([um(1, { kind: 'user', rpcId: 'x' }, '<!-- 由「上下文拼图台」拼装 -->\n# 起始上下文')]).studio, true, '兼容 v1.0 的注释头')
})

test('resolveLoadPath: 全局前缀和项目相对路径', () => {
  const homes = { dshHome: resolve('/h/dsh'), agentsHome: resolve('/h/agents') }
  assert.equal(resolveLoadPath('$DSH_HOME/AGENTS.md', homes, '/p'), resolve('/h/dsh/AGENTS.md'))
  assert.equal(resolveLoadPath('~/.dsh/AGENTS.md', homes, '/p'), resolve('/h/dsh/AGENTS.md'))
  assert.equal(resolveLoadPath('$DSH_AGENTS_HOME/AGENTS.md', homes, '/p'), resolve('/h/agents/AGENTS.md'))
  assert.equal(resolveLoadPath('~/.agents/AGENTS.md', homes, '/p'), resolve('/h/agents/AGENTS.md'))
  assert.equal(resolveLoadPath('packages\\core\\AGENTS.md', homes, '/p'), resolve('/p/packages/core/AGENTS.md'))
  assert.equal(resolveLoadPath('./.dsh/AGENTS.md', homes, '/p'), resolve('/p/.dsh/AGENTS.md'))
})

test('layoutChain: 直线、分叉开新泳道、合流', () => {
  const line = layoutChain(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
  assert.deepEqual([...line.lane.values()], [0, 0, 0])
  assert.equal(line.lanes, 1)
  assert.equal(line.style.get('a>b'), 'straight')

  // a 有两个后继：b 沿用泳道 0，c 开泳道 1；d 同时引用 b 和 c（合流）
  const tree = layoutChain(['a', 'b', 'c', 'd'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }])
  assert.equal(tree.lane.get('b'), 0)
  assert.equal(tree.lane.get('c'), 1)
  assert.equal(tree.style.get('a>c'), 'branch')
  assert.equal(tree.lane.get('d'), 0)
  assert.equal(tree.style.get('c>d'), 'merge')
  assert.equal(tree.lanes, 2)

  // 泳道用完会回收；倒着的边被忽略
  const reuse = layoutChain(['a', 'b', 'c', 'x', 'y'], [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'x', to: 'y' }, { from: 'y', to: 'x' }])
  assert.equal(reuse.lane.get('c'), 1)
  assert.equal(reuse.lane.get('x'), 0, '泳道 0 在 b 之后空出来了')
})

/** @returns {import('../lib/graph.js').GSession} */
function S(id, createdAt, extra = {}) {
  const facts = { loads: [], skills: [], refs: [], rpc: [], firstText: '', firstTime: 0, lastTime: createdAt, turns: 1, studio: false, ...extra.facts }
  return { id, title: extra.title ?? id, workspaceId: extra.ws ?? 'w1', createdAt, uses: extra.uses ?? [], seeded: extra.seeded, origin: extra.origin, parent: extra.parent ?? null, facts }
}

test('buildGraph: 链路 vs 独立、分叉识别、子代理、记忆分类', () => {
  const G = 'ins:g', P = 'ins:p', L = 'ins:l', U = 'ins:unused', K = 'skill:release'
  const sessions = [
    S('root', 100, { facts: { rpc: [{ id: 'r1', inherited: false }] }, uses: [{ key: G, digest: 'g1' }, { key: P, digest: 'p-old' }] }),
    // 从 root 分叉（普通分叉不记来源，靠 rpcId）
    S('fork', 200, { seeded: true, facts: { rpc: [{ id: 'r1', inherited: true }, { id: 'r2', inherited: false }] }, uses: [{ key: G, digest: 'g1' }, { key: L, digest: 'l1' }] }),
    // 同一处再分叉一次：来源应是 root，不是先分叉出来的 fork
    S('fork2', 250, { seeded: true, facts: { rpc: [{ id: 'r1', inherited: true }] }, uses: [{ key: G, digest: 'g1' }] }),
    // 另一个项目的会话引用了 fork（跨项目的链）
    S('ref', 300, { ws: 'w2', facts: { refs: [{ sessionId: 'fork', label: 'F' }] }, uses: [{ key: G, digest: 'g1' }, { key: K, digest: null }] }),
    S('sub', 310, { origin: 'subagent', parent: 'ref', ws: 'w2' }),
    S('alone', 400, { uses: [{ key: G, digest: 'g1' }, { key: P, digest: 'p1' }] }),
    S('other', 500, { ws: 'w3', uses: [{ key: G, digest: 'g1' }] }),
  ]
  const memories = [
    { key: G, kind: 'instruction', label: '$DSH_HOME/AGENTS.md', exists: true, digest: 'g1' },
    { key: P, kind: 'instruction', label: 'AGENTS.md', exists: true, digest: 'p1' },
    { key: L, kind: 'instruction', label: 'AGENTS.local.md', exists: false, digest: null },
    { key: U, kind: 'instruction', label: 'CLAUDE.md', exists: true, digest: 'u1' },
    { key: K, kind: 'skill', label: 'release', exists: true },
  ]
  const g = buildGraph({ sessions, memories, focus: 'w1', projectTitles: { w1: 'web', w2: 'api', w3: 'x' } })

  assert.equal(g.chains.length, 1)
  const c = g.chains[0]
  assert.deepEqual(c.sessions.map(s => s.id), ['root', 'fork', 'fork2', 'ref', 'sub'])
  assert.deepEqual(c.projects.sort(), ['api', 'web'])
  const kinds = Object.fromEntries(c.edges.map(e => [`${e.from}>${e.to}`, e.kind]))
  assert.deepEqual(kinds, { 'root>fork': 'fork', 'root>fork2': 'fork', 'fork>ref': 'reference', 'ref>sub': 'subagent' })
  const lane = Object.fromEntries(c.sessions.map(s => [s.id, s.lane]))
  assert.equal(lane.fork, 0)
  assert.equal(lane.fork2, 1, 'root 的第二个后继开新泳道')
  assert.equal(c.sessions.find(s => s.id === 'ref').external, true, '别的项目的会话标为外部')

  assert.deepEqual(g.singles.map(s => s.id), ['alone'], 'w3 的独立会话和焦点项目无关，不出现')

  const cls = Object.fromEntries(g.memories.map(m => [m.label, m.cls]))
  assert.deepEqual(cls, { '$DSH_HOME/AGENTS.md': 'shared', 'AGENTS.md': 'shared', 'AGENTS.local.md': 'single', release: 'single', 'CLAUDE.md': 'unused' })
  const p = g.memories.find(m => m.key === P)
  assert.deepEqual(p.uses.map(u => [u.sessionId, u.current]), [['root', false], ['alone', true]], '旧版本 / 当前版本')
  assert.equal(p.outdated, false)
  const l = g.memories.find(m => m.key === L)
  assert.equal(l.outdated, true, '文件已经不在了')
  assert.deepEqual(g.summary, { chains: 1, chainSessions: 5, singles: 1, shared: 2, chain: 0, single: 2, unused: 1, outdated: 1 })

  // 只在一条链里用过 → chain
  const g2 = buildGraph({ sessions: sessions.slice(0, 2), memories: [{ key: G, kind: 'instruction', label: 'g', exists: true, digest: 'g1' }], focus: 'w1' })
  assert.equal(g2.memories[0].cls, 'chain')

  // 全局视图：所有分量都在
  const all = buildGraph({ sessions, memories, focus: 'global' })
  assert.deepEqual(all.singles.map(s => s.id).sort(), ['alone', 'other'])
  assert.equal(all.chains[0].sessions.some(s => s.external), false)
})

test('buildLineage: 读真实形状的会话日志，按 sha1 判断用的是不是当前版本', async () => {
  const fx = await fixture()
  const globalSrc = await readFile(join(fx.dshHome, 'AGENTS.md'), 'utf8')
  const aSrc = await readFile(join(fx.projA, 'AGENTS.md'), 'utf8')
  const logs = {
    s1: [
      um(1, { kind: 'user', rpcId: 'q1' }, '登录后跳回首页'),
      ins(2, [
        { action: 'set', scope: 'user-global\u0000AGENTS.md', path: '$DSH_HOME/AGENTS.md', digest: sha1(globalSrc) },
        { action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1('旧内容') },
        { action: 'set', scope: 'packages/core\u0000AGENTS.md', path: 'packages/core/AGENTS.md', digest: 'x' },
      ]),
    ],
    s2: [
      um(1, { kind: 'user', rpcId: 'q2' }, '# 起始上下文', 5000),
      um(2, { kind: 'session-reference', references: [{ sessionId: 's1', label: '修登录 bug' }] }),
      ins(3, [{ action: 'set', scope: '.\u0000AGENTS.md', path: 'AGENTS.md', digest: sha1(aSrc) }]),
      { seq: 4, type: 'tool/call', time: 5, data: { name: 'skill', arguments: '{"name":"deploy"}' } },
    ],
    sub: [],
  }
  const sessionQuery = { ...fx.sessionQuery, async readSession(id) { return { events: logs[id] ?? [] } } }
  // 让 s2 晚于 s1：s1 now-1000，s2 改成 now
  const list = await fx.sessionQuery.listSessions()
  sessionQuery.listSessions = async () => list.map(r => r.header.id === 's2' ? { header: { ...r.header, createdAt: Date.now() } } : r)

  const g = await buildLineage({ homes: fx.homes, workspaceRegistry: fx.registry, sessionQuery }, 'wa')
  assert.equal(g.capabilities.sessions, true)
  assert.equal(g.chains.length, 1)
  assert.deepEqual(g.chains[0].sessions.map(s => s.id), ['s1', 's2'])
  assert.equal(g.chains[0].sessions[1].studio, true)
  assert.equal(g.chains[0].edges[0].kind, 'reference')
  const byLabel = Object.fromEntries(g.memories.map(m => [m.label, m]))
  assert.deepEqual(byLabel['AGENTS.md'].uses.map(u => [u.sessionId, u.current]), [['s1', false], ['s2', true]])
  assert.equal(byLabel['AGENTS.md'].cls, 'chain')
  assert.equal(byLabel['$DSH_HOME/AGENTS.md'].uses[0].current, true)
  assert.equal(byLabel['packages/core/AGENTS.md'].uses[0].current, false, '子目录指令改过了')
  assert.equal(byLabel.deploy.kind, 'skill')
  assert.equal(byLabel.deploy.uses.length, 1)
  assert.equal(byLabel['CLAUDE.md'].cls, 'unused', '没有会话加载过 CLAUDE.md（被 AGENTS.md 遮蔽）')
  assert.ok(g.memories.every(m => m.key !== pathKey(join(fx.projA, 'node_modules', 'x', 'AGENTS.md'))))

  // 拼入标记会出现在记忆上
  await writeFile(join(fx.projB, 'AGENTS.local.md'), '<!-- context-studio:begin id=1 from="proj-a" at=2026-11-11 -->\n- x\n<!-- context-studio:end -->\n')
  const gb = await buildLineage({ homes: fx.homes, workspaceRegistry: fx.registry, sessionQuery }, 'wb')
  assert.deepEqual(gb.memories.find(m => m.label === 'AGENTS.local.md').transplants, ['proj-a'])
  assert.equal(gb.chains.length, 0)

  // 没有 readSession：降级成只有记忆目录
  const lean = await buildLineage({ homes: fx.homes, workspaceRegistry: fx.registry, sessionQuery: fx.sessionQuery }, 'wa')
  assert.equal(lean.capabilities.sessions, false)
  assert.ok(lean.memories.every(m => m.cls === 'unused'))
  await assert.rejects(buildLineage({ homes: fx.homes, workspaceRegistry: fx.registry }, 'nope'), /未知项目/)
})

test('host: GET graph 路由', async () => {
  const fx = await fixture()
  const config = resolveConfig({ dataDir: join(fx.root, 'data') })
  config.homes = fx.homes
  const h = createHandlers({ config, getRegistry: () => fx.registry, getQuery: () => fx.sessionQuery })
  const g = await h.get.graph({ query: new URLSearchParams({ project: 'wa' }) })
  assert.ok(Array.isArray(g.memories))
  await assert.rejects(h.get.graph({ query: new URLSearchParams() }), /缺少 project/)
})

test('buildGraph: 复用的空白会话按第一条消息排序（真实 DSH 里遇到的情况）', () => {
  // web 会话先被创建（空白），但第一条消息晚于 api 会话，并引用了它
  const web = S('web', 100, { facts: { firstTime: 900, refs: [{ sessionId: 'api', label: 'A' }] } })
  const api = S('api', 500, { facts: { firstTime: 600 } })
  const g = buildGraph({ sessions: [web, api], memories: [], focus: 'w1' })
  assert.deepEqual(g.chains[0].sessions.map(s => s.id), ['api', 'web'])
  assert.equal(g.chains[0].edges[0].style, 'straight')
  assert.equal(g.chains[0].sessions[1].startTime, 900)
})

// All graph I/O regressions below use memory only, including root discovery and skills.
function memoryGraph(events = []) {
  const root = resolve('/graph-memory-test'), project = join(root, 'project')
  const homes = { dshHome: join(root, 'dsh'), agentsHome: join(root, 'agents') }
  const files = new Map(), directories = new Set(), calls = [], hooks = {}
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  function mkdir(path) {
    path = resolve(path)
    directories.add(path)
    if (dirname(path) !== path) mkdir(dirname(path))
  }
  function put(path, body) { path = resolve(path); mkdir(dirname(path)); files.set(path, body); return path }
  mkdir(project); mkdir(join(project, '.git')); mkdir(homes.dshHome); mkdir(homes.agentsHome)
  const base = {
    async stat(path) {
      if (files.has(path)) return { isFile: () => true, size: Buffer.byteLength(files.get(path)), mtimeMs: 1 }
      if (directories.has(path)) return { isFile: () => false, size: 0 }
      throw missing()
    },
    async readFile(path) { if (files.has(path)) return files.get(path); throw missing() },
    async readdir(path) {
      if (!directories.has(path)) throw missing()
      const entries = new Map()
      for (const dir of directories) if (dir !== path && dirname(dir) === path) entries.set(basename(dir), { name: basename(dir), isFile: () => false, isDirectory: () => true })
      for (const file of files.keys()) if (dirname(file) === path) entries.set(basename(file), { name: basename(file), isFile: () => true, isDirectory: () => false })
      return [...entries.values()]
    },
  }
  const io = Object.fromEntries(Object.entries(base).map(([method, fn]) => [method, async (path, options) => {
    path = resolve(path); calls.push({ method, path, options })
    return hooks[method] ? hooks[method](path, options, fn) : fn(path, options)
  }]))
  const workspace = { id: 'p', title: 'project', path: project, sessionIds: ['s1'] }
  const env = { homes, graphIO: io, graphBudgetMs: 1000, graphIOTimeoutMs: 10,
    workspaceRegistry: { list: () => [workspace], get: id => id === 'p' ? workspace : undefined },
    sessionQuery: { listSessions: async () => [{ header: { id: 's1', cwd: project, createdAt: 1 } }],
      readTitleSnapshots: async ids => ids.map(() => ({ status: 'fulfilled', value: { title: { title: 'test' } } })),
      readSession: async () => ({ events }) } }
  return { env, project, homes, calls, hooks, put, mkdir, files, directories, missing }
}
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const loaded = path => ins(1, [{ action: 'set', path, digest: sha1('old') }])

test('graph I/O: known, missing and unknown files have distinct version semantics', async () => {
  const f = memoryGraph([loaded('AGENTS.md'), loaded('gone.md'), loaded('blocked.md')])
  f.put(join(f.project, 'AGENTS.md'), 'old')
  const blocked = f.put(join(f.project, 'blocked.md'), 'old')
  f.hooks.readFile = (path, _, read) => path === blocked ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) : read(path)
  const g = await buildLineage(f.env, 'p')
  const find = path => g.memories.find(m => m.key === pathKey(join(f.project, path)))
  assert.equal(find('AGENTS.md').readState, 'read'); assert.equal(find('AGENTS.md').uses[0].current, true)
  assert.equal(find('gone.md').exists, false); assert.equal(find('gone.md').readState, 'missing'); assert.equal(find('gone.md').outdated, true)
  assert.equal(find('blocked.md').exists, null); assert.equal(find('blocked.md').readState, 'unknown')
  assert.equal(find('blocked.md').uses[0].current, null); assert.equal(find('blocked.md').outdated, false)
  assert.equal(g.partial, true)
  assert.ok(g.fileFailures.some(e => e.path === blocked && e.code === 'EACCES'))
  assert.equal(f.calls.filter(c => c.path.endsWith('AGENTS.md') && c.path.startsWith(f.project) && c.method === 'readFile').length, 1, 'candidate and historical use share one read; no pre-read')
})

test('graph I/O: absent optional candidates are not failures or invented memories', async () => {
  const f = memoryGraph()
  const g = await buildLineage(f.env, 'p')
  assert.equal(g.partial, false); assert.deepEqual(g.fileFailures, []); assert.deepEqual(g.memories, [])
  assert.equal(g.scan.pendingIO, 0)
})

test('graph I/O: zero total budget starts neither query nor filesystem work', async () => {
  const f = memoryGraph()
  let queries = 0
  f.env.graphBudgetMs = 0
  for (const key of Object.keys(f.env.sessionQuery)) f.env.sessionQuery[key] = async () => { queries++; throw Error('must not run') }
  const g = await buildLineage(f.env, 'p')
  assert.equal(queries, 0); assert.equal(f.calls.length, 0)
  assert.equal(g.scan.reason, 'GRAPH_BUDGET'); assert.equal(g.partial, true)
  assert.ok(g.singles[0].readError)
})

test('graph I/O: a hung root lookup stops the scan and late completion starts no ancestry reads', { timeout: 2000 }, async () => {
  const f = memoryGraph(), wait = pending()
  f.hooks.stat = () => wait.promise
  const g = await buildLineage(f.env, 'p')
  assert.equal(f.calls.length, 1); assert.equal(g.scan.pendingIO, 1); assert.equal(g.scan.maxPendingIO, 4)
  assert.equal(g.scan.reason, 'GRAPH_IO_TIMEOUT'); assert.equal(g.partial, true)
  assert.match(g.scan.limitation, /单次扫描.*跨请求/)
  wait.resolve({ isFile: () => false }); await new Promise(setImmediate)
  assert.equal(f.calls.length, 1)
})

test('graph I/O: hung candidate read is unknown and does not launch remaining candidates or skills', { timeout: 2000 }, async () => {
  const f = memoryGraph([loaded('AGENTS.md'), loaded('later.md')]), wait = pending()
  const file = f.put(join(f.project, 'AGENTS.md'), 'old')
  f.put(join(f.project, 'later.md'), 'old')
  f.put(join(f.project, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nbody')
  f.hooks.readFile = () => wait.promise
  const g = await buildLineage(f.env, 'p'), count = f.calls.length
  const m = g.memories.find(m => m.key === pathKey(file))
  assert.equal(m.exists, null); assert.equal(m.readState, 'unknown'); assert.equal(m.outdated, false)
  assert.equal(m.uses[0].current, null); assert.equal(g.scan.pendingIO, 1)
  assert.equal(g.memories.find(m => m.key === pathKey(join(f.project, 'later.md'))).exists, null)
  assert.equal(f.calls.filter(c => c.method === 'readFile').length, 1)
  assert.equal(f.calls.some(c => c.path.includes('skills')), false)
  assert.equal(f.calls.find(c => c.method === 'readFile').options.signal.aborted, true)
  wait.resolve('late body'); await new Promise(setImmediate)
  assert.equal(f.calls.length, count); assert.equal(m.exists, null, 'late data cannot mutate a returned partial result')
})

test('graph I/O: hanging nested directory enumeration cannot resume traversal after timeout', { timeout: 2000 }, async () => {
  const f = memoryGraph(), wait = pending()
  f.hooks.readdir = () => wait.promise
  const g = await buildLineage(f.env, 'p'), count = f.calls.length
  assert.equal(g.scan.pendingIO, 1); assert.equal(g.partial, true)
  assert.ok(g.fileFailures.some(e => e.operation === 'directory'))
  wait.resolve([{ name: 'later', isDirectory: () => true, isFile: () => false }]); await new Promise(setImmediate)
  assert.equal(f.calls.length, count)
})

test('graph I/O: skills enumeration and skill-file reads both stop on timeout', { timeout: 2000 }, async () => {
  for (const stage of ['directory', 'file']) {
    const f = memoryGraph(), wait = pending()
    const root = join(f.project, '.dsh', 'skills')
    f.put(join(root, 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nbody')
    // The nested instruction traversal ignores no special roots; only hang at the skill stage.
    if (stage === 'directory') {
      let visits = 0
      f.hooks.readdir = (path, _, read) => path === root && ++visits === 2 ? wait.promise : read(path)
    } else f.hooks.readFile = (path, _, read) => path.endsWith('SKILL.md') ? wait.promise : read(path)
    const g = await buildLineage(f.env, 'p'), count = f.calls.length
    assert.equal(g.scan.pendingIO, 1); assert.equal(g.scan.reason, 'GRAPH_IO_TIMEOUT')
    assert.equal(g.partial, true)
    if (stage === 'file') { const m = g.memories.find(m => m.kind === 'skill'); assert.equal(m.readState, 'unknown'); assert.equal(m.exists, null) }
    wait.resolve(stage === 'directory' ? [] : 'late'); await new Promise(setImmediate)
    assert.equal(f.calls.length, count)
  }
})

test('graph I/O: total budget caps file waits even when the per-I/O limit is longer', { timeout: 2000 }, async () => {
  const f = memoryGraph(), wait = pending()
  f.env.graphBudgetMs = 15; f.env.graphIOTimeoutMs = 1000
  f.hooks.stat = () => wait.promise
  const g = await buildLineage(f.env, 'p')
  assert.equal(g.scan.reason, 'GRAPH_BUDGET'); assert.equal(f.calls.length, 1)
  wait.resolve({ isFile: () => false })
})

test('graph I/O: elapsed total budget between successful operations prevents the next primitive', async () => {
  const f = memoryGraph(); let clock = 0
  f.env.graphNow = () => clock; f.env.graphBudgetMs = 10
  f.hooks.stat = async (path, _, read) => { const result = await read(path); clock = 11; return result }
  const g = await buildLineage(f.env, 'p')
  assert.equal(f.calls.length, 1); assert.equal(g.scan.reason, 'GRAPH_BUDGET'); assert.equal(g.scan.pendingIO, 0)
})

test('graph I/O: project-root failure never resolves relative history against a guessed cwd', async () => {
  const f = memoryGraph([loaded('AGENTS.md')])
  f.hooks.stat = () => Promise.reject(Object.assign(new Error('root denied'), { code: 'EACCES' }))
  const g = await buildLineage(f.env, 'p')
  const m = g.memories.find(m => m.key.startsWith('unresolved:'))
  assert.ok(m); assert.equal(m.exists, null); assert.equal(m.uses[0].current, null)
  assert.equal(g.summary.outdated, 0); assert.equal(g.partial, true)
})

test('graph I/O: nested instructions, skip rules and custom skill names remain discoverable', async () => {
  const f = memoryGraph()
  f.put(join(f.project, 'AGENTS.md'), '# rules')
  const nested = f.put(join(f.project, 'packages', 'core', 'AGENTS.md'), 'nested')
  const ignored = f.put(join(f.project, 'node_modules', 'x', 'AGENTS.md'), 'ignored')
  f.put(join(f.project, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: release\n---\nbody')
  const g = await buildLineage(f.env, 'p')
  assert.ok(g.memories.some(m => m.path === nested))
  assert.ok(!g.memories.some(m => m.path === ignored))
  assert.ok(!f.calls.some(c => c.path === ignored))
  assert.equal(g.memories.find(m => m.key === 'skill:release').readState, 'read')
  assert.equal(g.partial, false)
})

test('graph I/O: ENOTDIR and oversized files are unknown, never confirmed missing', async () => {
  for (const code of ['ENOTDIR', 'EIO']) {
    const f = memoryGraph([loaded('AGENTS.md')]), path = join(f.project, 'AGENTS.md')
    f.hooks.stat = (p, _, read) => p === path ? Promise.reject(Object.assign(new Error(code), { code })) : read(p)
    const g = await buildLineage(f.env, 'p'), m = g.memories.find(m => m.key === pathKey(path))
    assert.equal(m.exists, null); assert.equal(m.readState, 'unknown'); assert.equal(m.outdated, false)
  }
  const f = memoryGraph([loaded('AGENTS.md')]), path = f.put(join(f.project, 'AGENTS.md'), 'x'.repeat(1024 * 1024 + 1))
  const g = await buildLineage(f.env, 'p')
  assert.equal(g.memories.find(m => m.key === pathKey(path)).exists, null)
  assert.ok(!f.calls.some(c => c.method === 'readFile' && c.path === path))
})

test('graph I/O: concurrent root hangs retain at most four raw filesystem operations', { timeout: 2000 }, async () => {
  const f = memoryGraph([loaded('AGENTS.md')]), wait = pending()
  const ids = Array.from({ length: 20 }, (_, i) => `s${i}`)
  const workspace = { id: 'p', title: 'project', path: f.project, sessionIds: ids }
  f.env.workspaceRegistry = { list: () => [workspace], get: () => workspace }
  f.env.sessionQuery.listSessions = async () => ids.map((id, i) => ({ header: { id, cwd: join(f.project, `child-${i}`), createdAt: i } }))
  f.hooks.stat = () => wait.promise
  const g = await buildLineage(f.env, 'p'), count = f.calls.length
  assert.equal(count, 4); assert.equal(g.scan.pendingIO, 4); assert.equal(g.scan.maxPendingIO, 4)
  assert.equal(g.partial, true); assert.ok(g.memories.every(m => m.exists === null && !m.outdated))
  wait.resolve({ isFile: () => false }); await new Promise(setImmediate)
  assert.equal(f.calls.length, count)
})

test('graph I/O: a metadata hang consumes the total budget without starting file scanning', { timeout: 2000 }, async () => {
  const f = memoryGraph(), wait = pending(); let laterQueries = 0
  f.env.graphBudgetMs = 15
  f.env.sessionQuery.listSessions = () => wait.promise
  f.env.sessionQuery.readTitleSnapshots = async () => { laterQueries++; return [] }
  f.env.sessionQuery.readSession = async () => { laterQueries++; return { events: [] } }
  const g = await buildLineage(f.env, 'p')
  assert.equal(g.scan.reason, 'GRAPH_BUDGET'); assert.equal(f.calls.length, 0); assert.equal(laterQueries, 0)
  wait.resolve([]); await new Promise(setImmediate)
  assert.equal(f.calls.length, 0); assert.equal(laterQueries, 0)
})
