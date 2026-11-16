import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'


// All requests, storage and host services are synthetic. No browser, DSH home,
// model service or real HTTP endpoint is used. Only expose helpers in the VM copy.
const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  .replace('return module.exports;', 'exports.test = { ReportMap, reportMapData, mapSelection, reportDraftItems, consoleGraph, consoleEdgeGeometry, consoleMissing, loadContextDrafts, saveContextDraft, Organizer, StudioPage, Board, Dialog, setServices: value => { services = value } }; return module.exports;')
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

// Only synthetic ReportMap events are exercised here. Geometry is used to
// address a specific occurrence; this suite does not claim browser hit testing.
const instanceId = trail => JSON.stringify(trail)
function edgeJob(patch = {}) {
  const value = job(patch)
  value.report.paths = [
    { id: 'main', title: '主路径', nodes: ['g', 'r', 'd', 'n'] },
    { id: 'side', title: '旁路', nodes: ['g', 'r', 'e'] },
    { id: 'alt', title: '另一前缀', nodes: ['u', 'r', 'd'] },
  ]
  return value
}
function occurrence(root, trail) {
  const n = nodes(root).find(n => n.props?.['data-instance-id'] === instanceId(trail))
  assert.ok(n, 'instance ' + instanceId(trail)); return n
}
function pick(s, trail) { nodes(occurrence(s.render(), trail)).find(n => n.type === 'input').props.onChange() }
function inspect(s, trail) { nodes(occurrence(s.render(), trail)).find(n => n.props?.['aria-label']?.startsWith('查看节点：')).props.onClick() }
function model(s, value = edgeJob()) { return s.h.api.consoleEdgeGeometry(s.h.api.consoleGraph(s.h.api.reportMapData(value), value.report)) }
function routeButton(s, from, to, value) {
  const r = model(s, value).routes.find(r => r.from === instanceId(from) && r.to === instanceId(to))
  assert.ok(r, 'route ' + instanceId(to))
  const b = nodes(s.render()).find(n => n.props?.['data-edge-id'] === r.id)
  assert.ok(b, 'handle ' + r.id); return b
}
function openRoute(s, from, to, value) { routeButton(s, from, to, value).props.onClick(); return labelled(s.render(), '连接详情') }
const matching = (root, cls) => nodes(root).filter(n => n.props?.className?.split(' ').includes(cls))
const endpoints = root => matching(root, 'csx-line-endpoint').map(n => n.props['data-instance-id']).sort()
const origins = root => matching(root, 'csx-line-origin').map(n => n.props['data-instance-id']).sort()
const sourceLines = root => nodes(root).filter(n => n.type === 'path' && n.props['data-source-bus'])
function selectionView(s) {
  return { cards: selected(s.render()), dock: text(labelled(s.render(), '新会话起点')),
    checked: nodes(s.render()).filter(n => n.type === 'input' && n.props.type === 'checkbox').map(n => [n.props['aria-label'] || '', !!n.props.checked]) }
}
function untouched(s) { assert.deepEqual(s.requests, []); assert.deepEqual(s.prepared, []); assert.deepEqual(s.opened, []); assert.deepEqual(plain(s.h.api.loadContextDrafts()), []) }
async function preview(s) { await click(review(s.render), '预览新会话 →'); return s.prepared.at(-1).selection }
function bubbleKey(root, target, key) {
  function find(n, parents = []) {
    if (n === target) return parents.concat(n)
    if (!n || typeof n !== 'object') return null
    for (const child of Array.isArray(n) ? n : n.children || []) {
      const result = find(child, Array.isArray(n) ? parents : parents.concat(n)); if (result) return result
    }
    return null
  }
  const chain = find(root); assert.ok(chain)
  let stopped = false, handled = false
  const e = { key, target, preventDefault() {}, stopPropagation() { stopped = true } }
  for (const n of chain.reverse()) {
    if (typeof n.props?.onKeyDown === 'function') { handled = true; n.props.onKeyDown(e) }
    if (stopped) break
  }
  assert.ok(handled, 'keyboard event reaches an application handler')
}
function trace(patch = {}) {
  return { version: 1, id: 'trace-one', jobId: 'report-A', sessionId: 'S', title: '已确认草稿',
    cards: ['d', 'e'], sources: [20, 30], task: '核对', target: 'work', path: 'main',
    instances: [['g', 'r', 'd'], ['g', 'r', 'e']].map(instanceId),
    items: [{ kind: 'note', text: '合成材料' }], prompt: '合成完整草稿', outcome: 'prefilled', createdAt: 1234, ...patch }
}

test('路径hover/focus只高亮；离开恢复，不开详情、不选材或请求', t => {
  const s = mountMap(t, edgeJob()), before = selectionView(s)
  const handle = () => routeButton(s, ['g', 'r'], ['g', 'r', 'd'])
  for (const [enter, leave] of [['onMouseEnter', 'onMouseLeave'], ['onFocus', 'onBlur']]) {
    handle().props[enter]()
    assert.equal(matching(s.render(), 'csx-line-focused').length, 1)
    assert.deepEqual(endpoints(s.render()), [['g', 'r'], ['g', 'r', 'd']].map(instanceId).sort())
    assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '连接详情'), false)
    assert.deepEqual(selectionView(s), before)
    handle().props[leave]()
    assert.equal(matching(s.render(), 'csx-line-focused').length, 0)
    assert.deepEqual(selectionView(s), before)
  }
  untouched(s); assert.deepEqual(s.h.saved, {})
})

test('连接click锁定画布下方详情；hover其他边不压过锁定，Escape从handle冒泡清除且选材不变', t => {
  const s = mountMap(t, edgeJob()); pick(s, ['u'])
  const before = selectionView(s)
  const panel = openRoute(s, ['g', 'r'], ['g', 'r', 'd'])
  assert.match(text(panel), /路径连接.*N04 → N02/)
  assert.equal(nodes(labelled(s.render(), '上下文分支画布')).some(n => n.props?.['aria-label'] === '连接详情'), false)
  const locked = endpoints(s.render()), focused = matching(s.render(), 'csx-line-focused').map(n => n.props.d)
  routeButton(s, ['u', 'r'], ['u', 'r', 'd']).props.onMouseEnter()
  assert.deepEqual(endpoints(s.render()), locked)
  assert.deepEqual(matching(s.render(), 'csx-line-focused').map(n => n.props.d), focused)
  assert.match(text(labelled(s.render(), '连接详情')), /N04 → N02/)
  assert.deepEqual(selectionView(s), before)
  const tree = s.render(), handle = nodes(tree).find(n => n.props?.['aria-label']?.startsWith('查看路径连接：'))
  bubbleKey(tree, handle, 'Escape')
  assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '连接详情'), false)
  assert.equal(matching(s.render(), 'csx-line-focused').length, 0)
  assert.deepEqual(selectionView(s), before); untouched(s)
})

test('两端与前缀选入只追加：保留旧选材、手动原文和排除，重复操作不重复或删除', async t => {
  const s = mountMap(t, edgeJob())
  pick(s, ['u'])
  inspect(s, ['g', 'r']); click(s.render(), '本次不带走')
  labelled(s.render(), '查看原文 #20').props.onClick()
  checkbox(s.render(), '带上这段原文').props.onChange(); checkbox(s.render(), '带上这段原文').props.onChange()
  inspect(s, ['g', 'r', 'e']); labelled(s.render(), '查看原文 #30').props.onClick(); checkbox(s.render(), '带上这段原文').props.onChange()
  openRoute(s, ['g', 'r'], ['g', 'r', 'd'])
  assert.match(text(labelled(s.render(), '连接详情')), /1 项已排除，不加入/)
  click(s.render(), '选入两端（2项）'); click(s.render(), '选入两端（2项）')
  assert.deepEqual(selected(s.render()), ['d', 'u'])
  click(s.render(), '从起点选到 N02（3项）'); click(s.render(), '从起点选到 N02（3项）')
  const chosen = await preview(s)
  assert.deepEqual(chosen.cards, ['u', 'd', 'g'])
  assert.deepEqual(chosen.instances, [['u'], ['g', 'r', 'd'], ['g']].map(instanceId))
  assert.deepEqual(chosen.sources.slice().sort((a, b) => a - b), [10, 30, 50])
  assert.ok(chosen.excluded.includes('r')); assert.ok(chosen.missing.includes('r'))
  assert.deepEqual(s.requests, []); assert.deepEqual(s.opened, [])
})

test('全部端点已排除时按钮禁用；关闭附带引用后连接选择不自动附带原文', async t => {
  const s = mountMap(t, edgeJob())
  for (const trail of [['g', 'r'], ['g', 'r', 'd']]) { inspect(s, trail); click(s.render(), '本次不带走') }
  openRoute(s, ['g', 'r'], ['g', 'r', 'd'])
  assert.equal(button(s.render(), '选入两端（2项）').props.disabled, true)
  assert.deepEqual(selected(s.render()), [])
  checkbox(s.render(), '附带引用原文').props.onChange()
  click(s.render(), '从起点选到 N02（3项）')
  const chosen = await preview(s)
  assert.deepEqual(chosen.cards, ['g']); assert.deepEqual(chosen.sources, [])
  assert.deepEqual(chosen.instances, [instanceId(['g'])])
})

test('重复连接标签可区分位置，选用同卡不同前缀保留各实例且不混入根或旁路', async t => {
  const s = mountMap(t, edgeJob())
  const duplicate = nodes(s.render()).filter(n => n.props?.['aria-label']?.startsWith('查看路径连接：N04 → N02'))
  assert.equal(duplicate.length, 2)
  assert.equal(new Set(duplicate.map(n => n.props['aria-label'])).size, 2)
  openRoute(s, ['g', 'r'], ['g', 'r', 'd']); click(s.render(), '选入两端（2项）')
  openRoute(s, ['u', 'r'], ['u', 'r', 'd']); click(s.render(), '选入两端（2项）')
  const chosen = await preview(s)
  assert.deepEqual(chosen.cards, ['r', 'd'])
  assert.deepEqual(chosen.instances, [['g', 'r'], ['g', 'r', 'd'], ['u', 'r'], ['u', 'r', 'd']].map(instanceId))
  assert.deepEqual(chosen.missing.slice().sort(), ['g', 'u'])
  assert.deepEqual(s.requests, [])
})

test('公共干线只查看共享段；fork先选明确方向才出现选材动作且不默认带旁路', async t => {
  const s = mountMap(t, edgeJob()); pick(s, ['u'])
  assert.match(text(openRoute(s, ['g'], ['g', 'r'])), /共同路径段 · 2 条路径共用/)
  labelled(s.render(), '查看分叉：N04').props.onClick()
  const panel = labelled(s.render(), '连接详情')
  assert.match(text(panel), /2 个方向/)
  assert.equal(nodes(panel).some(n => n.children?.some(c => typeof c === 'string' && /选入两端|从起点选到/.test(c))), false)
  assert.deepEqual(selected(s.render()), ['u']); untouched(s)
  labelled(panel, '查看分叉方向：N03').props.onClick()
  assert.match(text(labelled(s.render(), '连接详情')), /N04 → N03/)
  assert.deepEqual(selected(s.render()), ['u'])
  click(s.render(), '从起点选到 N03（3项）')
  const chosen = await preview(s)
  assert.deepEqual(chosen.cards, ['u', 'g', 'r', 'e'])
  assert.deepEqual(chosen.instances, [['u'], ['g'], ['g', 'r'], ['g', 'r', 'e']].map(instanceId))
})

test('单后继stem直接开连接，只有真分叉有fork按钮；命中线阻止拖动画布', t => {
  const s = mountMap(t, edgeJob()), graph = model(s)
  assert.equal(nodes(s.render()).filter(n => n.props?.['aria-label']?.startsWith('查看分叉：')).length, 1)
  const stem = graph.forks.find(f => f.from === instanceId(['g']))
  assert.equal(stem.routes.length, 1)
  const hit = nodes(s.render()).find(n => n.props?.className === 'csx-line-hit' && n.props.key === 'fork:' + stem.id)
  assert.ok(hit)
  let stopped = 0
  hit.props.onPointerDown({ stopPropagation() { stopped++ } })
  hit.props.onClick({ stopPropagation() { stopped++ } })
  assert.equal(stopped, 2); assert.match(text(labelled(s.render(), '连接详情')), /N01 → N04/)
  const canvas = labelled(s.render(), '上下文分支画布'), view = { scrollLeft: 20, scrollTop: 30, setPointerCapture() { assert.fail('hit must not start dragging') } }
  canvas.props.ref.current = view
  canvas.props.onPointerDown({ button: 0, target: { closest: selector => selector.includes('.csx-line-hit') ? hit : null }, clientX: 100, clientY: 100 })
  canvas.props.onPointerMove({ clientX: 20, clientY: 10 })
  assert.deepEqual([view.scrollLeft, view.scrollTop], [20, 30]); untouched(s)
})

test('两端原文只取报告白名单，来源跳转后返回连接保留锁定和选材', t => {
  const s = mountMap(t, edgeJob()); pick(s, ['u'])
  openRoute(s, ['g', 'r'], ['g', 'r', 'd'])
  const before = selectionView(s), locked = endpoints(s.render())
  click(s.render(), '两端原文')
  const proof = labelled(s.render(), '连接两端的原文')
  assert.deepEqual(nodes(proof).filter(n => n.type === 'pre').map(text), ['合成原文 20', '合成原文 20'])
  assert.ok(nodes(proof).filter(n => n.props?.['aria-label']?.startsWith('查看原文 #')).every(n => n.props['aria-label'] === '查看原文 #20'))
  assert.doesNotMatch(text(proof), /#999/); assert.deepEqual(selectionView(s), before)
  labelled(proof, '查看原文 #20').props.onClick()
  assert.equal(text(nodes(labelled(s.render(), '地图节点详情')).find(n => n.type === 'pre')), '合成原文 20')
  assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '连接详情'), false)
  click(s.render(), '← 返回连接')
  labelled(s.render(), '连接详情'); assert.deepEqual(endpoints(s.render()), locked)
  assert.deepEqual(selectionView(s), before); untouched(s)
})

test('关系独立依据60与端点20/30分别核对，来源白名单与缺失边界不自动选材', async t => {
  const value = edgeJob()
  value.report.relations = [{ from: 'd', to: 'e', kind: 'supports', evidence: [60, 60, 999, '60'] }]
  const s = mountMap(t, value), before = selectionView(s)
  inspect(s, ['g', 'r', 'd']); click(s.render(), 'AI 支持 · N03 独立证据摘要')
  assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '关系自身依据'), false)
  click(s.render(), '对照两端原文')
  const own = labelled(s.render(), '关系自身依据'), ends = labelled(s.render(), '连接两端的原文')
  assert.deepEqual(nodes(own).filter(n => n.type === 'pre').map(text), ['合成原文 60'])
  assert.deepEqual(nodes(ends).filter(n => n.type === 'pre').map(text), ['合成原文 20', '合成原文 30'])
  assert.deepEqual(nodes(own).filter(n => n.props?.['aria-label']?.startsWith('查看原文 #')).map(n => n.props['aria-label']), ['查看原文 #60'])
  assert.doesNotMatch(text(own), /#999/)
  assert.deepEqual(selectionView(s), before)
  labelled(own, '查看原文 #60').props.onClick()
  assert.equal(text(nodes(labelled(s.render(), '地图节点详情')).find(n => n.type === 'pre')), '合成原文 60')
  assert.equal(checkbox(s.render(), '带上这段原文').props.checked, false)
  click(s.render(), '← 返回连接')
  labelled(s.render(), '关系自身依据')
  assert.deepEqual(selectionView(s), before); untouched(s)
  // Even explicitly selecting the endpoints only carries their references.
  click(s.render(), '选入两端（2项）')
  const chosen = await preview(s)
  assert.deepEqual(chosen.cards, ['d', 'e']); assert.deepEqual(chosen.sources, [20, 30])
  assert.deepEqual(s.requests, [])

  // With no valid relation source, the existing whitelist suppresses the
  // relation itself; endpoint references must not be substituted as evidence.
  for (const sources of [value.sources.filter(source => source.seq !== 60), []]) {
    const absent = mountMap(t, { ...value, sources })
    inspect(absent, ['g', 'r', 'd'])
    const tree = absent.render()
    assert.equal(absent.h.api.reportMapData({ ...value, sources }).links.some(r => r.kind === 'supports'), false)
    assert.equal(nodes(tree).some(n => n.children?.includes('AI 支持 · N03 独立证据摘要')), false)
    assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '关系自身依据' || n.props?.['aria-label'] === '查看原文 #60'), false)
    assert.deepEqual(selected(tree), []); untouched(absent)
  }
})

test('关联重复实例未定位时不画线/选材；显式定位后只画一条并按指定实例追加', async t => {
  const s = mountMap(t, edgeJob()); pick(s, ['u'])
  inspect(s, ['g', 'r', 'e']); click(s.render(), 'AI 支持 · N02 共享引用的结论')
  assert.match(text(labelled(s.render(), '连接详情')), /多个分支位置，请明确定位/)
  assert.equal(matching(s.render(), 'csx-line-relation').length, 0)
  assert.equal(button(s.render(), '选入两端（2项）').props.disabled, true)
  assert.deepEqual(selected(s.render()), ['u'])
  click(s.render(), 'N06 → N04 → N02')
  assert.equal(matching(s.render(), 'csx-line-relation').length, 1)
  assert.deepEqual(endpoints(s.render()), [['g', 'r', 'e'], ['u', 'r', 'd']].map(instanceId).sort())
  assert.equal(nodes(labelled(s.render(), '连接详情')).some(n => n.children?.some(c => typeof c === 'string' && c.startsWith('从起点选到'))), false)
  click(s.render(), '选入两端（2项）')
  const chosen = await preview(s)
  assert.deepEqual(chosen.cards, ['u', 'e', 'd'])
  assert.deepEqual(chosen.instances, [['u'], ['g', 'r', 'e'], ['u', 'r', 'd']].map(instanceId))
  assert.deepEqual(s.requests, [])
})

test('共同引用不显示因果/前缀选材；切换关联替换旧线，明确节点位置不被浏览path猜测', t => {
  const s = mountMap(t, edgeJob())
  inspect(s, ['u', 'r', 'd']); click(s.render(), '共同引用 · N04 待查疑点')
  assert.match(text(labelled(s.render(), '连接详情')), /共同引用 · 不表示依赖/)
  assert.equal(matching(s.render(), 'csx-line-relation').length, 0)
  click(s.render(), 'N01 → N04')
  assert.equal(matching(s.render(), 'csx-line-relation').length, 1)
  assert.equal(matching(s.render(), 'csx-line-relation')[0].props['data-connection-kind'], 'shared')
  assert.deepEqual(endpoints(s.render()), [['u', 'r', 'd'], ['g', 'r']].map(instanceId).sort())
  inspect(s, ['g', 'r', 'd', 'n']); click(s.render(), 'AI 回应 · N04 待查疑点')
  assert.equal(matching(s.render(), 'csx-line-relation').length, 0)
  click(s.render(), 'N06 → N04')
  assert.equal(matching(s.render(), 'csx-line-relation').length, 1)
  assert.equal(matching(s.render(), 'csx-line-relation')[0].props['data-connection-kind'], 'addresses')
  click(s.render(), '取消锁定')
  assert.equal(matching(s.render(), 'csx-line-relation').length, 0); untouched(s)
})

test('派生sourceBus只打开当前trace时显示，所有明确实例汇集；关闭清单/trace不影响选材', t => {
  const s = mountMap(t, edgeJob()); pick(s, ['u'])
  s.h.api.saveContextDraft(trace())
  const before = selectionView(s)
  assert.equal(sourceLines(s.render()).length, 0)
  labelled(s.render(), '图中派生草稿：已确认草稿').props.onClick()
  assert.ok(sourceLines(s.render()).length > 0)
  assert.deepEqual(origins(s.render()), [['g', 'r', 'd'], ['g', 'r', 'e']].map(instanceId).sort())
  assert.equal(matching(s.render(), 'csx-line-relation').length, 0)
  labelled(s.render(), '查看派生来源清单').props.onClick()
  labelled(s.render(), '派生来源清单')
  click(s.render(), '收起来源清单')
  assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '派生来源清单'), false)
  assert.ok(sourceLines(s.render()).length > 0)
  labelled(s.render(), '图中派生草稿：已确认草稿').props.onClick()
  assert.equal(sourceLines(s.render()).length, 0)
  assert.deepEqual(selectionView(s), before); assert.deepEqual(s.prepared, []); assert.deepEqual(s.requests, [])
})

test('trace原文返回保留trace和来源清单；未定位/外来来源不猜线、不生成入口', t => {
  const s = mountMap(t, edgeJob()); pick(s, ['u'])
  s.h.api.saveContextDraft(trace({ cards: ['d', 'e', 'foreign'], sources: [20, 999], instances: [instanceId(['g', 'r', 'd']), 'foreign-instance'] }))
  labelled(s.render(), '查看派生草稿：已确认草稿').props.onClick()
  assert.deepEqual(origins(s.render()), [instanceId(['g', 'r', 'd'])])
  assert.match(text(labelled(s.render(), '地图节点详情')), /未定位到分支位置/)
  click(s.render(), '查看来源清单')
  const list = labelled(s.render(), '派生来源清单'), before = selectionView(s)
  assert.equal(nodes(list).some(n => n.props?.['aria-label'] === '查看原文 #999'), false)
  labelled(list, '查看原文 #20').props.onClick()
  assert.equal(text(nodes(labelled(s.render(), '地图节点详情')).find(n => n.type === 'pre')), '合成原文 20')
  click(s.render(), '← 返回派生记录')
  labelled(s.render(), '派生来源清单')
  assert.equal(text(nodes(labelled(s.render(), '地图节点详情')).find(n => n.type === 'pre')), '合成完整草稿')
  assert.deepEqual(origins(s.render()), [instanceId(['g', 'r', 'd'])])
  assert.deepEqual(selectionView(s), before); assert.deepEqual(s.prepared, []); assert.deepEqual(s.requests, [])
})

test('连接/trace切换互斥，跨报告不带入旧锁定、来源线或材料', t => {
  const value = edgeJob(), s = mountMap(t, value)
  s.h.api.saveContextDraft(trace()); openRoute(s, ['g', 'r'], ['g', 'r', 'd'])
  labelled(s.render(), '查看派生草稿：已确认草稿').props.onClick()
  assert.ok(sourceLines(s.render()).length > 0)
  assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '连接详情'), false)
  labelled(s.render(), '查看路径：旁路').props.onClick()
  assert.equal(sourceLines(s.render()).length, 0)
  openRoute(s, ['g', 'r'], ['g', 'r', 'd'])
  s.props({ job: edgeJob({ id: 'report-B', sessionId: 'B' }) })
  assert.equal(nodes(s.render()).some(n => n.props?.['aria-label'] === '连接详情'), false)
  assert.equal(sourceLines(s.render()).length, 0)
  assert.equal(matching(s.render(), 'csx-line-focused').length, 0)
  assert.deepEqual(selected(s.render()), []); assert.deepEqual(s.prepared, []); assert.deepEqual(s.requests, [])
})

test('无paths旧报告不造路径连接或fork，关联按需查看仍保持免费只读', t => {
  const value = edgeJob(); delete value.report.paths
  const s = mountMap(t, value)
  assert.equal(nodes(s.render()).filter(n => /^查看路径连接：|^查看分叉：/.test(n.props?.['aria-label'] || '')).length, 0)
  assert.equal(matching(s.render(), 'csx-line-relation').length, 0)
  labelled(s.render(), '查看节点：共享引用的结论').props.onClick(); click(s.render(), '共同引用 · N04 待查疑点')
  assert.equal(matching(s.render(), 'csx-line-relation').length, 1)
  assert.match(text(labelled(s.render(), '连接详情')), /共同引用 · 不表示依赖/)
  untouched(s)
})

test('恶意连接端点标题和原文只作文本，预览不执行HTML或产生外部跳转', t => {
  const payload = '<img src=x onerror="attacked=true"><script>attacked=true</script> javascript:alert(1)'
  const value = edgeJob(); value.report.cards.find(c => c.id === 'd').title = payload; value.sources.find(s => s.seq === 20).text = payload
  const s = mountMap(t, value)
  openRoute(s, ['g', 'r'], ['g', 'r', 'd'], value); click(s.render(), '两端原文')
  const panel = labelled(s.render(), '连接详情')
  assert.ok(text(panel).includes(payload))
  assert.ok(nodes(panel).every(n => !n.props?.dangerouslySetInnerHTML && n.type !== 'script' && n.type !== 'img' && !n.props?.href))
  assert.equal(s.h.context.attacked, false); untouched(s)
})
