import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
