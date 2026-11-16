import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { compose, sanitizeItems } from '../lib/compose.js'

// All requests, storage and host services are synthetic. No browser, DSH home,
// model service or real HTTP endpoint is used. Only expose helpers in the VM copy.
const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  .replace('return module.exports;', 'exports.test = { ReportMap, reportMapData, mapSelection, reportDraftItems, consoleGraph, consoleMissing, loadContextDrafts, saveContextDraft, Organizer, StudioPage, Board, Dialog, setServices: value => { services = value } }; return module.exports;')
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = root => !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(nodes) : [root, ...nodes(root.children), ...nodes(root.props?.branch)]
const text = root => root == null || typeof root === 'boolean' ? '' : Array.isArray(root) ? root.map(text).join('') : typeof root === 'object' ? text(root.children) : String(root)
const tick = () => new Promise(setImmediate)
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const json = value => ({ ok: true, json: async () => value })
function labelled(root, label) {
  const result = nodes(root).find(n => n.props?.['aria-label'] === label)
  assert.ok(result, 'label: ' + label)
  return result
}
function button(root, label) {
  const result = nodes(root).find(n => n.children?.includes(label) && typeof n.props?.onClick === 'function')
  assert.ok(result, 'button: ' + label)
  return result
}
function click(root, label) {
  const b = button(root, label)
  assert.notEqual(b.props.disabled, true, label + ' must be enabled')
  return b.props.onClick(event())
}
function checkbox(root, label) {
  const wrapper = nodes(root).find(n => n.type === 'label' && n.children?.includes(label))
  const result = nodes(wrapper).find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.ok(result, 'checkbox: ' + label)
  return result
}
function component(root, type) {
  const result = nodes(root).find(n => n.type === type)
  assert.ok(result, 'component: ' + type.name)
  return result
}
function selected(root) {
  return [...new Set(nodes(root).filter(n => n.props?.['data-node-id'] && /\bpicked\b/.test(n.props.className)).map(n => n.props['data-node-id']))].sort()
}
function review(render) {
  if (!nodes(render()).some(n => n.props?.['aria-label'] === '派生 context 配置')) click(render(), '派生新 context')
  return render()
}

// Like the existing client harness, this inspects React element trees. Separate
// hook scopes allow the parent, Organizer, ReportMap and dialog body to coexist.
function harness(fetch = async () => { throw Error('unexpected network request') }, saved = {}) {
  let api, current, cursor = 0, nextTimer = 0
  const scopes = new Map(), timers = new Map(), copied = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'fragment',
    useState(init) {
      const state = current, i = cursor++
      if (!(i in state.values)) state.values[i] = typeof init === 'function' ? init() : init
      return [state.values[i], value => { state.values[i] = typeof value === 'function' ? value(state.values[i]) : value }]
    },
    useRef(value) { const i = cursor++; if (!(i in current.values)) current.values[i] = { current: value }; return current.values[i] },
    useMemo(fn) { cursor++; return fn() },
    useEffect(fn, deps) {
      const state = current, i = cursor++
      if (!state.effects[i] || deps.some((d, j) => d !== state.effects[i].deps[j]))
        state.pending.push(() => { state.effects[i]?.cleanup?.(); state.effects[i] = { deps, cleanup: fn() } })
    },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load({ factory }) { api = factory(() => react).test } } },
    fetch, AbortController, console, attacked: false,
    navigator: { clipboard: { writeText: async value => { copied.push(value) } } },
    localStorage: { getItem: key => key in saved ? JSON.stringify(saved[key]) : null, setItem(key, value) { saved[key] = JSON.parse(value) } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
  })
  vm.runInContext(source, context)
  return {
    api, timers, saved, copied, context,
    render(fn, props = {}, scope = fn) {
      if (!scopes.has(scope)) scopes.set(scope, { values: [], effects: [], pending: [] })
      current = scopes.get(scope); cursor = 0
      const tree = fn(props), pending = current.pending
      current.pending = []; pending.forEach(run => run())
      return tree
    },
    async settle(fn, props = {}, scope = fn) {
      for (let i = 0; i < 5; i++) { this.render(fn, props, scope); await tick() }
      return this.render(fn, props, scope)
    },
    unmount() { for (const state of scopes.values()) state.effects.forEach(e => e?.cleanup?.()); scopes.clear() },
  }
}

function job(patch = {}) {
  const sources = [10, 20, 30, 40, 50, 60].map(seq => ({ seq, label: '原文' + seq, text: '合成原文 ' + seq,
    offset: 12, end: 19, totalChars: 100, truncated: true, status: seq === 20 ? 'replaced' : 'active' }))
  sources.forEach(s => { s.end = s.offset + s.text.length })
  return { id: 'report-A', sessionId: 'S', answer: 100, status: 'completed', active: false, provider: 'fake', model: 'offline',
    createdAt: 1000, updatedAt: 2000, inputTokens: 100, outputTokens: 200, usage: { inputTokens: 100, outputTokens: 50 },
    coverage: { total: 10, included: 6, omitted: 4, clipped: 6, excludedSystem: 0 }, sources,
    report: { title: '合成任务地图', overview: '关系需要核对', warnings: ['只分析所选片段'], branch: { task: '建议任务不自动采用', sources: [10] },
      cards: [
        { id: 'g', category: 'goal', title: '任务约束', body: '先核对再行动', evidence: [10] },
        { id: 'd', category: 'decision', title: '共享引用的结论', body: '没有声明因果', evidence: [20, 999, '20'] },
        { id: 'e', category: 'evidence', title: '独立证据摘要', body: '仍是 AI 文字', evidence: [30] },
        { id: 'r', category: 'risk', title: '待查疑点', body: '需要验证', evidence: [20] },
        { id: 'n', category: 'next', title: '直接关联行动', body: '检查疑点', evidence: [40] },
        { id: 'u', category: 'next', title: '二跳行动', body: '不是直接邻居', evidence: [50] },
      ], relations: [
        { id: 'relation-1', from: 'n', to: 'r', kind: 'addresses', evidence: [40] },
        { id: 'relation-2', from: 'e', to: 'd', kind: 'supports', evidence: [60] },
        { id: 'relation-3', from: 'u', to: 'n', kind: 'depends_on', evidence: [50] },
      ] }, ...patch }
}
const projects = [{ id: 'work', title: '原项目' }, { id: 'target', title: '新目标项目' }]
function mountMap(t, value = job(), extra = {}) {
  const requests = [], prepared = [], opened = []
  const h = harness(async url => { requests.push(url); throw Error('map must stay local') })
  t.after(() => h.unmount())
  let props = { job: value, projects, target: 'work', onPrepare: (j, s) => prepared.push({ job: j, selection: plain(s) }), onSource: (j, s) => opened.push({ job: j, source: s }), ...extra }
  return { h, requests, prepared, opened, render: () => h.render(h.api.ReportMap, props), props: patch => { props = { ...props, ...patch } } }
}
function server(value = job()) {
  const api = { calls: [], current: value, reports: null, handle: null }
  api.fetch = async (url, opts = {}) => {
    const parsed = new URL(url, 'http://synthetic.invalid'), path = parsed.pathname.split('/').pop()
    const call = { path, query: parsed.searchParams, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined }
    api.calls.push(call)
    if (api.handle) { const result = api.handle(call); if (result !== undefined) return await result }
    if (path === 'projects') return json({ projects })
    if (path === 'journal') return json({ ops: [] })
    if (path === 'sessions') return json({ sessions: [{ id: 'S', title: '会话S', workspaceId: 'work', turns: 3 }, { id: 'B', title: '会话B', workspaceId: 'target', turns: 2 }] })
    if (path === 'organize-models') return json({ available: false, providers: [], warning: '模拟目录不可用' })
    if (path === 'organize-history') return json({ jobs: api.reports || [api.current] })
    if (path === 'organize-job') return json({ job: api.reports ? api.reports.find(j => j.id === call.query.get('id')) : api.current })
    if (path === 'compose') return json(compose(sanitizeItems(call.body.items), { mode: 'prompt', budget: call.body.budget, task: call.body.task }))
    throw Error('unexpected route: ' + path)
  }
  return api
}
async function mountStudio(t) {
  const api = server(), started = []
  const original = { board: [{ key: 'existing', kind: 'note', text: '原board内容', title: '原便签', tokens: 4 }],
    prefs: { project: 'global', target: 'work', task: '原任务保持', budget: 8000 } }
  const h = harness(api.fetch, { 'dsh-context-studio:board': plain(original.board), 'dsh-context-studio:prefs': plain(original.prefs) })
  h.api.setServices({ uiWorkspace: { startSession: async (...args) => { started.push(plain(args)) }, forkSession() { assert.fail('must not fork') } },
    sessions: { fork() { assert.fail('must not clone') }, send() { assert.fail('must not send') } } })
  t.after(() => h.unmount())
  await h.settle(h.api.StudioPage)
  const render = () => h.render(h.api.StudioPage)
  return { h, api, original, started, render, organizer: () => component(render(), h.api.Organizer) }
}
function unchangedBoard(s) {
  assert.deepEqual(s.h.saved['dsh-context-studio:board'], s.original.board)
  const prefs = s.h.saved['dsh-context-studio:prefs']
  assert.equal(prefs.task, s.original.prefs.task); assert.equal(prefs.target, s.original.prefs.target)
  assert.deepEqual(plain(component(s.render(), s.h.api.Board).props.items), s.original.board)
}

// Reuse the established VM strategy without importing a test module (which
// would register that module's tests again). Every host boundary stays fake.
const DRAFTS = 'dsh-context-studio:context-drafts:v1'
const instanceId = trail => JSON.stringify(trail)
function pathJob() {
  const value = job()
  value.report.paths = [
    { id: 'main', title: '主路径', nodes: ['g', 'r', 'd', 'n'] },
    { id: 'side', title: '旁路', nodes: ['g', 'e'] },
    { id: 'alt', title: '另一前缀', nodes: ['u', 'd'] },
  ]
  value.report.relations = [
    { from: 'd', to: 'u', kind: 'depends_on', evidence: [20] },
    { from: 'u', to: 'e', kind: 'depends_on', evidence: [50] },
    { from: 'e', to: 'd', kind: 'supports', evidence: [30] },
  ]
  return value
}
function state(patch = {}) { return { cards: [], sources: [], excluded: [], skipSources: [], includeSources: false, ...patch } }
function graphFor(h, value) {
  const data = h.api.reportMapData(value)
  return { data, graph: h.api.consoleGraph(data, value.report) }
}
function occurrence(root, trail) {
  const result = nodes(root).find(n => n.props?.['data-instance-id'] === instanceId(trail))
  assert.ok(result, 'instance: ' + instanceId(trail)); return result
}
function pick(render, trail) { nodes(occurrence(render(), trail)).find(n => n.type === 'input').props.onChange() }
function inspect(render, trail) { nodes(occurrence(render(), trail)).find(n => n.props?.['aria-label']?.startsWith('查看节点：')).props.onClick() }
function missingText(root) { return text(nodes(root).find(n => n.props?.className === 'csx-console-alert' && text(n).includes('可能缺少前置材料'))) }
function record(patch = {}) {
  return { version: 1, id: 'trace-1', jobId: 'report-A', sessionId: 'S', title: '已确认草稿',
    cards: ['d'], sources: [20], task: '再次核对', target: 'target', path: 'main',
    instances: [instanceId(['g', 'r', 'd'])], items: [{ kind: 'note', text: '合成材料' }],
    prompt: '合成完整草稿', outcome: 'prefilled', createdAt: 1234, ...patch }
}

test('consoleGraph只按显式路径建前缀树，同卡不同前缀有独立实例，旁路不合并为继承', () => {
  const h = harness(), value = pathJob(), before = plain(value), { graph } = graphFor(h, value)
  assert.deepEqual(plain(graph.paths), value.report.paths)
  assert.deepEqual(plain(graph.nodes.map(n => n.trail)), [
    ['g'], ['g', 'r'], ['g', 'r', 'd'], ['g', 'r', 'd', 'n'], ['g', 'e'], ['u'], ['u', 'd'],
  ])
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length)
  assert.equal(graph.nodes.filter(n => n.cardId === 'd').length, 2)
  assert.equal(graph.nodes.filter(n => n.cardId === 'g').length, 1)
  assert.equal(graph.edges.length, 5)
  for (const edge of graph.edges) {
    const a = graph.nodes.find(n => n.id === edge.from), b = graph.nodes.find(n => n.id === edge.to)
    assert.equal(edge.kind, 'path'); assert.ok(a && b)
    assert.deepEqual(plain(b.trail.slice(0, -1)), plain(a.trail))
  }
  for (const n of graph.nodes) {
    assert.ok([n.x, n.y, n.w, n.h, graph.width, graph.height].every(Number.isFinite))
    assert.ok(n.x >= 0 && n.y >= 0 && n.x + n.w <= graph.width && n.y + n.h <= graph.height)
  }
  assert.deepEqual(value, before)
})

test('非法路径被忽略，旧报告保留真实shared边且不伪造路径，最多展示60条关联', t => {
  const value = pathJob(), h = harness()
  value.report.paths = [null, { id: 'bad', title: '未知卡片', nodes: ['foreign'] },
    { id: 'cycle', title: '重复节点', nodes: ['g', 'g'] },
    { id: 'main', title: '有效', nodes: ['g', 'r'] },
    { id: 'main', title: '重复路径ID', nodes: ['g', 'e'] }, { id: 'empty', title: '空', nodes: [] }]
  assert.deepEqual(plain(graphFor(h, value).graph.paths), [{ id: 'main', title: '有效', nodes: ['g', 'r'] }])
  delete value.report.paths; delete value.report.relations
  const s = mountMap(t, value), { graph } = graphFor(s.h, value)
  assert.deepEqual(plain(graph.paths), [])
  assert.ok(graph.nodes.every(n => n.trail.length === 0))
  assert.deepEqual(plain(graph.edges), [{ from: 'loose:d', to: 'loose:r', kind: 'shared' }])
  assert.equal(button(s.render(), '选用整条链').props.disabled, true)
  labelled(s.render(), '查看节点：共享引用的结论').props.onClick()
  assert.equal(nodes(s.render()).some(n => n.children?.includes('选用到这里')), false)
  assert.ok(nodes(s.render()).some(n => n.type === 'path' && n.props.className?.includes('shared')))
  value.report.cards = Array.from({ length: 20 }, (_, i) => ({ id: 'c' + i, category: 'evidence', title: '材料' + i, body: '合成', evidence: [20] }))
  assert.equal(graphFor(h, value).data.links.length, 190)
  assert.equal(graphFor(h, value).graph.edges.length, 60)
  assert.deepEqual(s.requests, [])
})

test('consoleMissing按选中实例前缀提示；切浏览path不改结果，不递归补依赖或共享引用', () => {
  const h = harness(), value = pathJob(), { data, graph } = graphFor(h, value)
  const choice = state({ cards: ['d'], instances: [instanceId(['g', 'r', 'd'])], path: 'main' }), before = plain(choice)
  for (const path of ['main', 'alt', 'side', '', 'unknown'])
    assert.deepEqual(plain(h.api.consoleMissing(data, graph, { ...choice, path })), ['g', 'r', 'u'])
  assert.deepEqual(plain(h.api.consoleMissing(data, graph, state({ cards: ['d'], instances: [instanceId(['u', 'd'])], path: 'main' }))), ['u'])
  assert.deepEqual(plain(h.api.consoleMissing(data, graph, state({ cards: ['d'], instances: [], path: 'main' }))), ['u'])
  assert.deepEqual(plain(h.api.consoleMissing(data, graph, state({ cards: ['g'], instances: [instanceId(['g', 'r', 'd'])], path: 'main' }))), [])
  assert.deepEqual(plain(h.api.consoleMissing(data, graph, state({ cards: ['d'], instances: ['unknown'], path: 'main' }))), ['u'])
  assert.deepEqual(choice, before)
})

test('consoleMissing旧调用缺instances时仅从当前path选中项前找缺项，未选或选在其他路径时不猜', () => {
  const h = harness(), value = pathJob(), { data, graph } = graphFor(h, value)
  assert.deepEqual(plain(h.api.consoleMissing(data, graph, state({ cards: ['d'], path: 'main' }))), ['g', 'r', 'u'])
  assert.deepEqual(plain(h.api.consoleMissing(data, graph, state({ cards: ['d'] }))), ['u'])
  const unrelated = [[], ['e']].map(cards => plain(h.api.consoleMissing(data, graph, state({ cards, path: 'main' }))))
  assert.deepEqual(unrelated, [[], []], 'neither an empty selection nor a selection on another path has ancestors on main')
})

test('整链和到此处只取明确前缀，保持路径顺序及实例；无关分支与依赖只提示', async t => {
  const s = mountMap(t, pathJob())
  inspect(s.render, ['g', 'r', 'd']); assert.deepEqual(selected(s.render()), [])
  click(s.render(), '选用到这里')
  assert.deepEqual(selected(s.render()), ['d', 'g', 'r'])
  await click(review(s.render), '预览新会话 →')
  let chosen = s.prepared.at(-1).selection
  assert.deepEqual(chosen.cards, ['g', 'r', 'd'])
  assert.deepEqual(chosen.instances, [['g'], ['g', 'r'], ['g', 'r', 'd']].map(instanceId))
  assert.deepEqual(chosen.missing, ['u']); assert.deepEqual(chosen.excluded, ['e', 'n', 'u'])
  click(s.render(), '选用整条链')
  await click(review(s.render), '预览新会话 →')
  chosen = s.prepared.at(-1).selection
  assert.deepEqual(chosen.cards, ['g', 'r', 'd', 'n'])
  assert.deepEqual(chosen.instances, [['g'], ['g', 'r'], ['g', 'r', 'd'], ['g', 'r', 'd', 'n']].map(instanceId))
  labelled(s.render(), '查看路径：旁路').props.onClick()
  assert.deepEqual(selected(s.render()), ['d', 'g', 'n', 'r'], 'browsing a path must not select it')
  click(s.render(), '选用整条链'); await click(review(s.render), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.cards, ['g', 'e'])
  assert.deepEqual(s.requests, [])
})

test('局部checkbox记住同卡的具体实例，查看另一实例/路径不改提示；取消再选才更换前缀', async t => {
  const value = pathJob(); value.report.relations = []
  const s = mountMap(t, value)
  pick(s.render, ['g', 'r', 'd'])
  assert.match(missingText(review(s.render)), /任务约束.*待查疑点/)
  inspect(s.render, ['u', 'd'])
  labelled(s.render(), '查看路径：旁路').props.onClick()
  assert.match(missingText(review(s.render)), /任务约束.*待查疑点/)
  assert.doesNotMatch(missingText(s.render()), /二跳行动|独立证据摘要/)
  await click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.instances, [instanceId(['g', 'r', 'd'])])
  assert.deepEqual(s.prepared.at(-1).selection.cards, ['d'])
  pick(s.render, ['u', 'd']); assert.deepEqual(selected(s.render()), [])
  pick(s.render, ['u', 'd'])
  assert.match(missingText(review(s.render)), /二跳行动/)
  assert.doesNotMatch(missingText(s.render()), /任务约束|待查疑点/)
  s.h.unmount()
  assert.match(missingText(s.render()), /二跳行动/, 'same-report cache retains selected occurrence')
  await click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.instances, [instanceId(['u', 'd'])])
})

test('补选同步保存前置实例，移除末节点再移除根后剩余中间节点仍提示缺根', async t => {
  const value = pathJob(); value.report.relations = []
  const s = mountMap(t, value)
  pick(s.render, ['g', 'r', 'd'])
  assert.deepEqual(selected(s.render()), ['d'])
  click(review(s.render), '补选这些节点')
  assert.deepEqual(selected(s.render()), ['d', 'g', 'r'])
  pick(s.render, ['g', 'r', 'd']); pick(s.render, ['g'])
  assert.deepEqual(selected(s.render()), ['r'])
  assert.match(missingText(review(s.render)), /任务约束/)
  assert.doesNotMatch(missingText(s.render()), /共享引用的结论|二跳行动/)
  await click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.cards, ['r'])
  assert.deepEqual(s.prepared.at(-1).selection.instances, [instanceId(['g', 'r'])])
  assert.deepEqual(s.prepared.at(-1).selection.missing, ['g'])
})

test('整链尊重排除，恢复不隐式选用；清空后不残留实例缺项', async t => {
  const s = mountMap(t, pathJob())
  inspect(s.render, ['g', 'r']); click(s.render(), '本次不带走')
  click(s.render(), '选用整条链')
  assert.deepEqual(selected(s.render()), ['d', 'g', 'n'])
  assert.match(missingText(review(s.render)), /待查疑点/)
  inspect(s.render, ['g', 'r']); click(s.render(), '恢复选用')
  assert.deepEqual(selected(s.render()), ['d', 'g', 'n'])
  pick(s.render, ['g', 'r']); click(s.render(), '清空选择')
  pick(s.render, ['g'])
  await click(review(s.render), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.instances, [instanceId(['g'])])
  assert.deepEqual(s.prepared.at(-1).selection.missing, [])
})

test('review原文返回选材保留任务目标和实例；原文查看不准备草稿', async t => {
  const s = mountMap(t, pathJob())
  pick(s.render, ['g', 'r', 'd'])
  labelled(review(s.render), '地图新任务').props.onChange(event('核对约束'))
  labelled(s.render(), '地图目标项目').props.onChange(event('target'))
  labelled(s.render(), '查看原文 #20').props.onClick()
  labelled(s.render(), '上下文分支画布')
  assert.equal(text(nodes(labelled(s.render(), '地图节点详情')).find(n => n.type === 'pre')), '合成原文 20')
  assert.deepEqual(s.prepared, [])
  click(s.render(), '← 返回选材')
  assert.equal(labelled(s.render(), '地图新任务').props.value, '核对约束')
  assert.equal(labelled(s.render(), '地图目标项目').props.value, 'target')
  await click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.instances, [instanceId(['g', 'r', 'd'])])
  assert.deepEqual(s.requests, []); assert.deepEqual(s.opened, [])
})

test('画布空白拖动/缩放/复位只改变视图，控件和结束后的pointermove不拖动', t => {
  const s = mountMap(t, pathJob()), captured = [], view = { scrollLeft: 50, scrollTop: 60, setPointerCapture: id => captured.push(id) }
  const canvas = labelled(s.render(), '上下文分支画布'); canvas.props.ref.current = view
  const down = { button: 0, pointerId: 7, clientX: 100, clientY: 100, target: { closest: () => null } }
  canvas.props.onPointerDown(down); canvas.props.onPointerMove({ clientX: 70, clientY: 80 })
  assert.deepEqual([view.scrollLeft, view.scrollTop], [80, 80]); assert.deepEqual(captured, [7])
  canvas.props.onPointerUp(); canvas.props.onPointerMove({ clientX: 0, clientY: 0 })
  assert.deepEqual([view.scrollLeft, view.scrollTop], [80, 80])
  canvas.props.onPointerDown({ ...down, target: { closest: () => ({}) } }); canvas.props.onPointerMove({ clientX: 0, clientY: 0 })
  assert.deepEqual([view.scrollLeft, view.scrollTop], [80, 80])
  const transform = () => nodes(s.render()).find(n => n.props?.className === 'csx-console-plane').props.style.transform
  const initial = transform(); labelled(s.render(), '放大地图').props.onClick(); assert.notEqual(transform(), initial)
  click(s.render(), '复位'); assert.equal(transform(), initial)
  assert.deepEqual([view.scrollLeft, view.scrollTop], [0, 0])
  assert.deepEqual(selected(s.render()), []); assert.deepEqual(s.prepared, []); assert.deepEqual(s.requests, [])
})

test('草稿保持选择顺序和AI适用范围/注意事项/状态标注，未知来源不能进入导出', () => {
  const h = harness(), value = pathJob()
  Object.assign(value.report.cards.find(c => c.id === 'r'), { scope: '仅适用合成版本', caveat: '先验证，不可当作已证实', state: 'hypothesis' })
  const { data } = graphFor(h, value), choice = state({ cards: ['n', 'r', 'g', 'r', 'foreign'] })
  assert.deepEqual(plain(h.api.mapSelection(data, choice).cards.map(c => c.id)), ['n', 'r', 'g'])
  const items = plain(h.api.reportDraftItems(value, { cards: choice.cards, sources: [20, 999, '20'] }))
  assert.deepEqual(items.filter(i => i.kind === 'note').map(i => i.title), ['AI建议 · 直接关联行动', 'AI建议 · 待查疑点', 'AI建议 · 任务约束'])
  const note = items.find(i => i.title === 'AI建议 · 待查疑点')
  for (const expected of ['适用范围（AI 标注）：仅适用合成版本', '注意事项（AI 标注，待核对）：先验证，不可当作已证实', '状态（AI 标注）：待验证假设']) assert.ok(note.text.includes(expected), expected)
  assert.deepEqual(items.filter(i => i.kind === 'snippet').map(i => i.evidenceSeq), [20])
  const prompt = compose(sanitizeItems(items), { mode: 'prompt', task: '合成校验' }).text
  assert.ok(prompt.includes(note.text)); assert.doesNotMatch(prompt, /#999/)
  for (const [status, annotation] of [['recorded', '材料中有记载，仍需核对原文'], ['conflict', '疑似冲突，尚未确认'], ['superseded', '可能已被替代，尚未确认']]) {
    value.report.cards[0].state = status
    assert.ok(h.api.reportDraftItems(value, { cards: ['g'] })[0].text.includes('状态（AI 标注）：' + annotation))
  }
})

test('本地派生加载只接受有效记录；损坏JSON/不可读存储安全降级，不改写存储', () => {
  const bad = [null, record({ version: 2 }), record({ jobId: null }), record({ prompt: {} }), record({ task: null }),
    record({ createdAt: Infinity }), record({ cards: [1] }), record({ sources: [-1] }), record({ sources: ['20'] }),
    record({ items: [null] }), record({ items: [{ text: 1 }] }), record({ outcome: 'sent' })]
  const good = record(), saved = { [DRAFTS]: [good, ...bad] }, h = harness(undefined, saved), before = plain(saved)
  assert.deepEqual(plain(h.api.loadContextDrafts()), [good]); assert.deepEqual(plain(saved), before)
  h.context.localStorage.getItem = () => '{bad json'
  assert.deepEqual(plain(h.api.loadContextDrafts()), [])
  h.context.localStorage.getItem = () => { throw Error('synthetic storage denied') }
  assert.deepEqual(plain(h.api.loadContextDrafts()), [])
})

test('派生保存校验必填字段，去重/最多20份/容量淘汰，单条超大或写入失败有错误且不损坏旧记录', () => {
  const h = harness()
  for (const key of ['id', 'jobId', 'sessionId', 'title', 'prompt', 'task', 'target']) {
    const result = h.api.saveContextDraft(record({ [key]: null }))
    assert.equal(result.ok, false, key); assert.equal(typeof result.error, 'string')
  }
  for (const patch of [{ version: 0 }, { createdAt: NaN }, { createdAt: Infinity }, { cards: {} }, { sources: {} }, { items: {} }, { outcome: 'sent' }])
    assert.equal(h.api.saveContextDraft(record(patch)).ok, false)
  for (let i = 0; i < 22; i++) assert.equal(h.api.saveContextDraft(record({ id: 'r' + i })).ok, true)
  assert.deepEqual(plain(h.api.loadContextDrafts().map(r => r.id)), Array.from({ length: 20 }, (_, i) => 'r' + (21 - i)))
  assert.equal(h.api.saveContextDraft(record({ id: 'r10', title: '更新' })).ok, true)
  assert.equal(h.api.loadContextDrafts()[0].title, '更新'); assert.equal(h.api.loadContextDrafts().length, 20)
  for (let i = 0; i < 4; i++) assert.equal(h.api.saveContextDraft(record({ id: 'big' + i, prompt: '文'.repeat(170000) })).ok, true)
  assert.deepEqual(plain(h.api.loadContextDrafts().map(r => r.id)), ['big3', 'big2'])
  assert.ok(Buffer.byteLength(JSON.stringify(h.saved[DRAFTS]), 'utf16le') <= 1_000_000)
  const before = plain(h.saved)
  assert.equal(h.api.saveContextDraft(record({ prompt: 'x'.repeat(1_100_000) })).ok, false)
  assert.deepEqual(h.saved, before)
  h.context.localStorage.setItem = () => { throw Error('synthetic quota') }
  const failed = h.api.saveContextDraft(record())
  assert.equal(failed.ok, false); assert.match(failed.error, /未能保存/); assert.deepEqual(h.saved, before)
})

test('派生记录按report/session隔离，回看只读；恢复仅选材且保留实例，不自动compose/预填', async t => {
  const s = mountMap(t, pathJob())
  s.h.api.saveContextDraft(record({ cards: ['d', 'foreign'], sources: [20, 999] }))
  s.h.api.saveContextDraft(record({ id: 'other-session', sessionId: 'B', title: '别的会话' }))
  s.h.api.saveContextDraft(record({ id: 'other-report', jobId: 'other', title: '别的报告' }))
  let tree = s.render()
  assert.equal(nodes(tree).filter(n => n.props?.['aria-label']?.startsWith('查看派生草稿：')).length, 1)
  labelled(tree, '查看派生草稿：已确认草稿').props.onClick()
  tree = s.render(); assert.deepEqual(selected(tree), [])
  assert.equal(text(nodes(labelled(tree, '地图节点详情')).find(n => n.type === 'pre')), '合成完整草稿')
  assert.doesNotMatch(text(labelled(tree, '地图节点详情')), /→/, 'arbitrary selected cards are not a causal chain')
  click(tree, '恢复这份选材')
  assert.deepEqual(selected(s.render()), ['d'])
  assert.equal(labelled(s.render(), '地图新任务').props.value, '再次核对')
  assert.match(missingText(s.render()), /任务约束.*待查疑点.*二跳行动/)
  assert.deepEqual(s.prepared, []); assert.deepEqual(s.requests, [])
  await click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared[0].selection.cards, ['d']); assert.deepEqual(s.prepared[0].selection.sources, [20])
  assert.deepEqual(s.prepared[0].selection.instances, [instanceId(['g', 'r', 'd'])])
})

test('派生图回连所有选中实例，任意卡片集合不显示无依据的顺序箭头', t => {
  const s = mountMap(t, pathJob())
  s.h.api.saveContextDraft(record({ cards: ['d', 'e'], instances: [instanceId(['g', 'r', 'd']), instanceId(['g', 'e'])] }))
  const tree = s.render(), lines = nodes(tree).filter(n => n.type === 'path' && n.props.strokeDasharray === '4 5')
  assert.equal(lines.length, 2)
  const { graph } = graphFor(s.h, pathJob())
  for (const trail of [['g', 'r', 'd'], ['g', 'e']]) {
    const n = graph.nodes.find(n => n.id === instanceId(trail))
    assert.ok(lines.some(line => line.props.d.startsWith('M' + (n.x + n.w) + ',' + (n.y + n.h / 2))))
  }
  labelled(tree, '图中派生草稿：已确认草稿').props.onClick()
  const detail = text(labelled(s.render(), '地图节点详情'))
  assert.match(detail, /N02、N03/); assert.doesNotMatch(detail, /N02\s*→\s*N03/)
  assert.deepEqual(s.prepared, [])
})

test('恶意派生标题与prompt保持文本，不作为HTML或可执行链接', t => {
  const s = mountMap(t, pathJob()), payload = '<img src=x onerror="attacked=true"><script>attacked=true</script> javascript:alert(1)'
  s.h.api.saveContextDraft(record({ title: payload, prompt: payload }))
  labelled(s.render(), '查看派生草稿：' + payload).props.onClick()
  const tree = s.render()
  assert.equal(text(nodes(labelled(tree, '地图节点详情')).find(n => n.type === 'pre')), payload)
  assert.ok(nodes(tree).every(n => !n.props?.dangerouslySetInnerHTML && n.type !== 'script' && n.type !== 'img'))
  assert.equal(s.h.context.attacked, false); assert.deepEqual(s.requests, [])
})

async function studioMap(t) {
  const s = await mountStudio(t), value = pathJob()
  const renderMap = () => s.h.render(s.h.api.ReportMap, { job: value, projects, target: 'work', onPrepare: s.organizer().props.onPrepareMap })
  return { ...s, value, renderMap }
}
function dialogBody(s) {
  const modal = component(s.render(), s.h.api.Dialog)
  assert.ok(modal.props.dialog)
  return { modal, body: s.h.render(modal.props.dialog.body.type, modal.props.dialog.body.props) }
}

test('preview取消零派生；确认成功只预填一次并保存来源/实例/顺序，最终Dialog显示选入/排除/缺项', async t => {
  const s = await studioMap(t)
  pick(s.renderMap, ['g', 'r', 'd']); pick(s.renderMap, ['g', 'r', 'd', 'n'])
  labelled(review(s.renderMap), '地图新任务').props.onChange(event('验证局部结论'))
  labelled(s.renderMap(), '地图目标项目').props.onChange(event('target'))
  await click(s.renderMap(), '预览新会话 →')
  let { modal, body } = dialogBody(s)
  for (const content of ['选入：共享引用的结论、直接关联行动、原文 #20、原文 #40', '未选节点', '可能缺少前置材料', '任务约束', '待查疑点', '二跳行动', '本次保持你的局部选择']) assert.ok(text(body).includes(content), content)
  assert.deepEqual(plain(s.h.api.loadContextDrafts()), []); assert.deepEqual(s.started, [])
  click(s.h.render(s.h.api.Dialog, modal.props), '取消')
  assert.deepEqual(plain(s.h.api.loadContextDrafts()), []); assert.equal(s.h.saved[DRAFTS], undefined)
  await click(s.renderMap(), '预览新会话 →')
  ;({ modal, body } = dialogBody(s))
  const prompt = text(nodes(body).find(n => n.type === 'pre'))
  click(s.h.render(s.h.api.Dialog, modal.props), '创建草稿'); await tick()
  const rows = plain(s.h.api.loadContextDrafts())
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.jobId, 'report-A'); assert.equal(r.sessionId, 'S'); assert.equal(r.outcome, 'prefilled')
  assert.equal(r.task, '验证局部结论'); assert.equal(r.target, 'target'); assert.equal(r.path, 'main')
  assert.deepEqual(r.cards, ['d', 'n']); assert.deepEqual(r.sources, [20, 40])
  assert.deepEqual(r.instances, [['g', 'r', 'd'], ['g', 'r', 'd', 'n']].map(instanceId))
  assert.equal(r.prompt, prompt); assert.ok(Number.isFinite(r.createdAt))
  assert.deepEqual(r.items, s.api.calls.filter(c => c.path === 'compose').at(-1).body.items)
  assert.deepEqual(s.started, [['target', { prompt, whenDraftExists: 'append' }]])
  assert.ok(s.api.calls.filter(c => c.method === 'POST').every(c => c.path === 'compose'))
  labelled(s.renderMap(), '查看派生草稿：验证局部结论')
  unchangedBoard(s)
})

test('无uiWorkspace时仍先确认，取消不复制不保存；确认复制后才记录copied', async t => {
  const s = await studioMap(t); s.h.api.setServices(null)
  pick(s.renderMap, ['g']); await click(review(s.renderMap), '预览新会话 →')
  let { modal } = dialogBody(s)
  assert.deepEqual(s.h.copied, []); assert.deepEqual(plain(s.h.api.loadContextDrafts()), [])
  click(s.h.render(s.h.api.Dialog, modal.props), '取消')
  assert.deepEqual(s.h.copied, []); assert.deepEqual(plain(s.h.api.loadContextDrafts()), [])
  await click(s.renderMap(), '预览新会话 →'); ({ modal } = dialogBody(s))
  click(s.h.render(s.h.api.Dialog, modal.props), '复制草稿'); await tick()
  const rows = plain(s.h.api.loadContextDrafts())
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'copied')
  assert.deepEqual(s.h.copied, [rows[0].prompt]); assert.deepEqual(s.started, [])
  unchangedBoard(s)
})

test('预填成功但存储失败需提示且不重试startSession，确认关闭并保留目标草稿', async t => {
  const s = await studioMap(t)
  const save = s.h.context.localStorage.setItem
  s.h.context.localStorage.setItem = (key, value) => { if (key === DRAFTS) throw Error('synthetic quota'); save(key, value) }
  pick(s.renderMap, ['g']); await click(review(s.renderMap), '预览新会话 →')
  const { modal } = dialogBody(s)
  click(s.h.render(s.h.api.Dialog, modal.props), '创建草稿'); await tick()
  assert.equal(s.started.length, 1); assert.deepEqual(plain(s.h.api.loadContextDrafts()), [])
  assert.match(text(s.render()), /未能保存派生记录/)
  assert.equal(component(s.render(), s.h.api.Dialog).props.dialog, null)
  s.renderMap(); await tick(); s.render()
  assert.equal(s.started.length, 1)
  assert.equal(s.api.calls.filter(c => c.path === 'compose').length, 1)
  unchangedBoard(s)
})

test('宿主预填失败或clipboard失败不保存成功trace，也不自动重试', async t => {
  for (const copyOnly of [false, true]) {
    const s = await studioMap(t); let attempts = 0
    const fail = async () => { attempts++; throw Error('synthetic destination failure') }
    if (copyOnly) { s.h.api.setServices(null); s.h.context.navigator.clipboard.writeText = fail }
    else s.h.api.setServices({ uiWorkspace: { startSession: fail } })
    pick(s.renderMap, ['g']); await click(review(s.renderMap), '预览新会话 →')
    const { modal } = dialogBody(s)
    await assert.rejects(modal.props.dialog.onConfirm(), /synthetic destination failure/)
    await tick(); s.render()
    assert.equal(attempts, 1); assert.deepEqual(plain(s.h.api.loadContextDrafts()), [])
    unchangedBoard(s)
  }
})

test('S→B→S不复活旧确认；同会话新preview也使旧Dialog过期且不预填/复制/保存', async t => {
  for (const copyOnly of [false, true]) for (const scenario of ['session-roundtrip', 'new-preview']) {
    const s = await studioMap(t)
    if (copyOnly) s.h.api.setServices(null)
    pick(s.renderMap, ['g']); await click(review(s.renderMap), '预览新会话 →')
    const old = dialogBody(s).modal.props.dialog
    if (scenario === 'session-roundtrip') {
      labelled(s.render(), '从目录选择会话').props.onChange(event('B'))
      assert.equal(s.organizer().props.session.id, 'B')
      labelled(s.render(), '从目录选择会话').props.onChange(event('S'))
      assert.equal(s.organizer().props.session.id, 'S')
    } else await click(s.renderMap(), '预览新会话 →')
    await assert.rejects(old.onConfirm())
    assert.deepEqual(s.started, []); assert.deepEqual(s.h.copied, [])
    assert.deepEqual(plain(s.h.api.loadContextDrafts()), [])
    unchangedBoard(s)
  }
})
