import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { compose, sanitizeItems } from '../lib/compose.js'

// All requests, storage and host services are synthetic. No browser, DSH home,
// model service or real HTTP endpoint is used. Only expose helpers in the VM copy.
const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  .replace('return module.exports;', 'exports.test = { ReportMap, reportMapData, mapSelection, reportDraftItems, Organizer, StudioPage, Board, Dialog, setServices: value => { services = value } }; return module.exports;')
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
  return nodes(root).filter(n => n.props?.['data-node-id'] && /\bpicked\b/.test(n.props.className)).map(n => n.props['data-node-id']).sort()
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

test('旧报告免费成图：仅从有效共同引用连线，不补造 AI 关系或修改报告', t => {
  const old = job(); delete old.report.relations
  const before = plain(old), s = mountMap(t, old), data = s.h.api.reportMapData(old)
  assert.equal(data.cards.length, 6)
  assert.deepEqual(plain(data.links), [{ from: 'd', to: 'r', kind: 'shared', evidence: [20], ai: false }])
  assert.match(text(s.render()), /旧报告无需重新生成/)
  assert.match(text(s.render()), /浏览、选取和复用不消耗 token/)
  assert.deepEqual(old, before); assert.deepEqual(s.requests, [])
})

test('Organizer 恢复旧报告且目录无可用模型时仍挂载地图，不重新预览或生成', async t => {
  const old = job(); delete old.report.relations
  const api = server(old), h = harness(api.fetch), prepare = () => {}, open = () => {}
  t.after(() => h.unmount())
  const props = { session: { id: 'S' }, onPrepareMap: prepare, onSource: open, projects, target: 'work' }
  const tree = await h.settle(h.api.Organizer, props), map = component(tree, h.api.ReportMap)
  assert.equal(map.props.key, old.id); assert.equal(map.props.onPrepare, prepare); assert.equal(map.props.onSource, open)
  assert.equal(map.props.job.report.title, old.report.title)
  assert.deepEqual(api.calls.map(c => c.path), ['organize-models', 'organize-history', 'organize-job'])
  const mapTree = h.render(h.api.ReportMap, map.props)
  labelled(mapTree, '任务关系图')
  assert.match(text(mapTree), /旧报告无需重新生成/)
  assert.ok(api.calls.every(c => c.method === 'GET'))
})

test('显式 AI 关系与共同引用独立；关系端点、类型、来源都使用白名单', t => {
  const value = job(), s = mountMap(t, value)
  value.report.cards.find(c => c.id === 'n').evidence.push(20)
  value.report.relations.push(
    { from: 'missing', to: 'r', kind: 'supports', evidence: [20] },
    { from: 'r', to: 'r', kind: 'supports', evidence: [20] },
    { from: 'g', to: 'r', kind: 'causes', evidence: [20] },
    { from: 'g', to: 'r', kind: 'shared', evidence: [20] },
    { from: 'g', to: 'r', kind: 'questions', evidence: [999, '20'] },
  )
  const data = s.h.api.reportMapData(value)
  assert.deepEqual(plain(data.links.filter(r => r.ai).map(r => [r.from, r.to, r.kind, r.evidence])), [
    ['n', 'r', 'addresses', [40]], ['e', 'd', 'supports', [60]], ['u', 'n', 'depends_on', [50]],
  ])
  assert.ok(data.links.some(r => !r.ai && r.kind === 'shared' && r.from === 'r' && r.to === 'n'))
  labelled(s.render(), '查看节点：待查疑点').props.onClick()
  const tree = s.render(), detail = labelled(tree, '地图节点详情')
  assert.match(text(detail), /← 回应 · AI/); assert.match(text(detail), /同引 #20/)
  const edges = nodes(tree).filter(n => n.type === 'g' && /csx-map-edge/.test(n.props.className))
  assert.ok(edges.some(n => /\bai\b/.test(n.props.className))); assert.ok(edges.some(n => /\bshared\b/.test(n.props.className)))
  assert.ok(data.links.every(r => r.evidence.every(seq => data.sources.has(seq))))
})

test('聚焦、筛选和缩放只改变浏览状态，不勾选节点、不调用模型或准备草稿', t => {
  const s = mountMap(t)
  labelled(s.render(), '查看节点：待查疑点').props.onClick()
  assert.equal(labelled(s.render(), '查看节点：待查疑点').props['aria-pressed'], true)
  click(s.render(), '找疑点'); click(s.render(), '看下一步'); click(s.render(), '看全局')
  labelled(s.render(), '放大地图').props.onClick(); labelled(s.render(), '缩小地图').props.onClick()
  click(s.render(), '适应宽度')
  assert.deepEqual(selected(s.render()), []); assert.deepEqual(s.prepared, []); assert.deepEqual(s.requests, [])
})

test('节点、附带原文和手动原文可分别选取；移除原文后不会被引用自动加回', t => {
  const s = mountMap(t)
  labelled(s.render(), '选用节点：待查疑点').props.onChange()
  assert.match(text(labelled(s.render(), '新会话起点')), /1 个 AI 整理节点 \+ 1 段原文/)
  labelled(s.render(), '查看节点：待查疑点').props.onClick()
  labelled(s.render(), '查看原文 #20').props.onClick()
  checkbox(s.render(), '带上这段原文').props.onChange()
  assert.match(text(labelled(s.render(), '新会话起点')), /1 个 AI 整理节点 \+ 0 段原文/)
  checkbox(s.render(), '附带引用原文').props.onChange(); checkbox(s.render(), '附带引用原文').props.onChange()
  assert.equal(checkbox(s.render(), '带上这段原文').props.checked, false)
  checkbox(s.render(), '带上这段原文').props.onChange()
  labelled(s.render(), '选用节点：待查疑点').props.onChange()
  assert.match(text(labelled(s.render(), '新会话起点')), /0 个 AI 整理节点 \+ 1 段原文/)
  click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.sources, [20]); assert.deepEqual(s.prepared.at(-1).selection.cards, [])
  click(s.render(), '清空选择')
  assert.match(text(labelled(s.render(), '新会话起点')), /0 个 AI 整理节点 \+ 0 段原文/)
  assert.deepEqual(s.requests, [])
})

test('本次排除可恢复；预设尊重排除并仅选目标及一跳 AI 关系，不把共同引用或二跳当因果', t => {
  const s = mountMap(t)
  labelled(s.render(), '查看节点：直接关联行动').props.onClick(); click(s.render(), '本次不带走')
  labelled(s.render(), '查看节点：待查疑点').props.onClick(); click(s.render(), '围绕这个疑点准备新会话')
  assert.deepEqual(selected(s.render()), ['g', 'r'])
  labelled(s.render(), '查看节点：直接关联行动').props.onClick(); click(s.render(), '恢复选用')
  labelled(s.render(), '查看节点：待查疑点').props.onClick(); click(s.render(), '围绕这个疑点准备新会话')
  assert.deepEqual(selected(s.render()), ['g', 'n', 'r'])
  assert.equal(labelled(s.render(), '选用节点：共享引用的结论').props.checked, false)
  assert.equal(labelled(s.render(), '选用节点：二跳行动').props.checked, false)
  assert.match(labelled(s.render(), '地图新任务').props.value, /待查疑点/)
  click(s.render(), '选好接手材料')
  assert.deepEqual(selected(s.render()), ['d', 'g', 'n', 'r', 'u'])
  assert.deepEqual(s.requests, []); assert.deepEqual(s.prepared, [])
})

test('原文在地图内预览和返回保留聚焦与选取，仅显式原始记录入口跳转', t => {
  const value = job(), s = mountMap(t, value)
  labelled(s.render(), '选用节点：待查疑点').props.onChange()
  labelled(s.render(), '查看节点：待查疑点').props.onClick()
  labelled(s.render(), '查看原文 #20').props.onClick()
  let tree = s.render()
  labelled(tree, '任务关系图')
  const pre = nodes(labelled(tree, '地图节点详情')).find(n => n.type === 'pre')
  assert.equal(text(pre), value.sources[1].text)
  assert.match(text(labelled(tree, '地图节点详情')), /字符 13–/)
  assert.deepEqual(s.opened, []); assert.deepEqual(s.requests, [])
  click(tree, '← 返回节点'); tree = s.render()
  assert.equal(labelled(tree, '查看节点：待查疑点').props['aria-pressed'], true)
  assert.deepEqual(selected(tree), ['r'])
  labelled(tree, '查看原文 #20').props.onClick(); click(s.render(), '在原始记录中查看')
  assert.equal(s.opened.length, 1); assert.equal(s.opened[0].job.answer, 100); assert.equal(s.opened[0].source.seq, 20)
})

test('mapSelection 和草稿转换只接纳本报告节点/来源，去重并保留 AI 标注与原文位置', t => {
  const value = job(), s = mountMap(t, value), data = s.h.api.reportMapData(value)
  const selection = s.h.api.mapSelection(data, { cards: ['d', 'r', 'foreign'], sources: [20, 20, 30, 999, '20'],
    excluded: ['r'], skipSources: [30], includeSources: true })
  assert.deepEqual(plain(selection.cards.map(c => c.id)), ['d'])
  assert.deepEqual(plain(selection.sources.map(x => x.seq)), [20])
  assert.ok(selection.tokens > 0)
  const items = plain(s.h.api.reportDraftItems(value, { cards: ['d', 'd', 'foreign'], sources: [20, 20, 999, '20'] }))
  assert.equal(items.length, 2)
  const note = items.find(i => i.kind === 'note'), original = items.find(i => i.kind === 'snippet')
  assert.match(note.text, /AI整理建议（待核对）\n来源报告：report-A\n来源会话：S/)
  assert.deepEqual(note.reportEvidence, [20]); assert.doesNotMatch(note.text, /#999/)
  assert.equal(original.text, value.sources[1].text); assert.equal(original.evidenceSession, 'S')
  assert.equal(original.evidenceSeq, 20); assert.equal(original.textOffset, 12); assert.equal(original.sourcePart, 'body')
  assert.equal(original.evidenceEnd, 12 + original.text.length)
  assert.match(original.from, /已被替换/)
  const draft = compose(sanitizeItems(items), { mode: 'prompt', task: '只核对选中材料' }).text
  assert.ok(draft.includes(note.text)); assert.ok(draft.includes(original.text))
  assert.doesNotMatch(draft, /合成原文 30|合成原文 50|建议任务不自动采用/)
})

test('切换报告时相同节点ID/seq不继承旧聚焦、排除、来源选取或任务目标', t => {
  const first = job(), second = job({ id: 'report-B', sessionId: 'B' })
  second.report = plain(second.report); second.sources = plain(second.sources)
  second.report.cards.forEach(c => { c.body = 'B报告正文' }); second.sources.forEach(s => { s.text = 'B原文' })
  const s = mountMap(t, first)
  labelled(s.render(), '查看节点：待查疑点').props.onClick(); click(s.render(), '本次不带走')
  labelled(s.render(), '选用节点：任务约束').props.onChange()
  labelled(s.render(), '地图新任务').props.onChange(event('A报告独有任务'))
  labelled(s.render(), '地图目标项目').props.onChange(event('target'))
  labelled(s.render(), '查看原文 #20').props.onClick()
  s.props({ job: second, target: 'work' })
  let tree = s.render()
  assert.deepEqual(selected(tree), [])
  assert.ok(nodes(tree).filter(n => n.props?.['data-node-id']).every(n => !/\bfocused\b|\bexcluded\b/.test(n.props.className)))
  assert.equal(nodes(labelled(tree, '地图节点详情')).some(n => n.type === 'pre'), false)
  labelled(tree, '选用节点：待查疑点').props.onChange(); tree = s.render()
  assert.equal(labelled(tree, '地图新任务').props.value, '')
  assert.equal(labelled(tree, '地图目标项目').props.value, 'work')
  click(tree, '预览新会话 →')
  assert.equal(s.prepared[0].job.id, 'report-B')
  assert.deepEqual(s.prepared[0].selection.cards, ['r']); assert.deepEqual(s.prepared[0].selection.sources, [20])
})

test('恶意标题、正文、来源和警告只作为文本，不能生成HTML、执行动作或伪造来源入口', t => {
  const malicious = '<img src=x onerror="globalThis.attacked=true"><script>globalThis.attacked=true</script> javascript:alert(1)'
  const value = job(); value.report.title = malicious; value.report.overview = malicious; value.report.warnings = [malicious]
  value.report.cards[3].title = malicious; value.report.cards[3].body = malicious; value.report.cards[3].evidence = [20, 999, '20']
  value.sources[1].text = malicious; value.sources[1].label = malicious
  const s = mountMap(t, value)
  labelled(s.render(), '查看节点：' + malicious).props.onClick()
  let tree = s.render()
  assert.ok(text(labelled(tree, '地图节点详情')).includes(malicious))
  assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '查看原文 #999'), false)
  labelled(tree, '查看原文 #20').props.onClick(); tree = s.render()
  assert.equal(text(nodes(tree).find(n => n.type === 'pre')), malicious)
  assert.ok(nodes(tree).every(n => !('dangerouslySetInnerHTML' in n.props)))
  assert.ok(nodes(tree).every(n => !['script', 'img', 'iframe'].includes(n.type)))
  assert.ok(nodes(tree).every(n => !String(n.props.href || '').startsWith('javascript:')))
  assert.equal(s.h.context.attacked, false); assert.deepEqual(s.requests, [])
})

test('地图任务/目标通过compose完整预览，确认前不startSession，原board与任务目标不覆盖', async t => {
  const s = await mountStudio(t), organizer = s.organizer(), value = job()
  // Follow the actual Organizer -> ReportMap callback wiring in the same VM.
  const tree = await s.h.settle(s.h.api.Organizer, organizer.props), mapElement = component(tree, s.h.api.ReportMap)
  const renderMap = () => s.h.render(s.h.api.ReportMap, mapElement.props)
  labelled(renderMap(), '选用节点：待查疑点').props.onChange()
  labelled(renderMap(), '地图新任务').props.onChange(event('只验证这个疑点'))
  labelled(renderMap(), '地图目标项目').props.onChange(event('target'))
  const before = s.api.calls.length
  await click(renderMap(), '预览新会话 →')
  await tick() // The UI click starts onPrepare without returning its promise.
  assert.deepEqual(s.api.calls.slice(before).map(c => c.path), ['compose'])
  const request = s.api.calls.at(-1).body
  assert.equal(request.task, '只验证这个疑点')
  assert.equal(request.items.length, 2); assert.equal(request.items[1].text, value.sources[1].text)
  assert.ok(request.items.every(i => i.key !== 'existing'))
  assert.equal(s.started.length, 0); unchangedBoard(s)
  const modal = component(s.render(), s.h.api.Dialog), dialog = modal.props.dialog
  assert.ok(dialog)
  const body = s.h.render(dialog.body.type, dialog.body.props)
  for (const expected of ['新目标项目', '不会自动发送', '只验证这个疑点']) assert.ok(text(body).includes(expected), expected)
  assert.ok(text(body).includes('AI整理建议（待核对）'))
  assert.doesNotMatch(text(body), /原board内容|原任务保持/)
  click(s.h.render(s.h.api.Dialog, modal.props), dialog.confirmLabel)
  await tick()
  assert.equal(s.started.length, 1); assert.equal(s.started[0][0], 'target')
  assert.equal(s.started[0][1].whenDraftExists, 'append')
  assert.equal(s.started[0][1].prompt, text(nodes(body).find(n => n.type === 'pre')))
  unchangedBoard(s)
  assert.ok(s.api.calls.filter(c => c.method === 'POST').every(c => c.path === 'compose'))
})

test('取消地图草稿确认不创建会话；legacy board入口及回调保留', async t => {
  const s = await mountStudio(t), organizer = s.organizer()
  for (const name of ['onNote', 'onSource', 'onEvidence', 'onPrepareMap']) assert.equal(typeof organizer.props[name], 'function')
  await organizer.props.onPrepareMap(job(), { cards: ['r'], sources: [], task: '地图临时任务', target: 'target' })
  const modal = component(s.render(), s.h.api.Dialog)
  click(s.h.render(s.h.api.Dialog, modal.props), '取消')
  assert.equal(component(s.render(), s.h.api.Dialog).props.dialog, null)
  assert.equal(s.started.length, 0); unchangedBoard(s)
  await click(s.render(), '准备分支草稿 · 1')
  assert.equal(s.api.calls.at(-1).body.task, '原任务保持')
  assert.deepEqual(s.api.calls.at(-1).body.items, s.original.board)
  assert.equal(s.started.length, 0)
})

test('父层拒绝其他会话的地图与空白名单选择，不compose或创建会话', async t => {
  const s = await mountStudio(t), organizer = s.organizer(), before = s.api.calls.length
  await organizer.props.onPrepareMap(job({ id: 'foreign-report', sessionId: 'B' }), { cards: ['r'], sources: [20], task: 'foreign', target: 'target' })
  await organizer.props.onPrepareMap(job(), { cards: ['missing'], sources: [999, '20'], task: 'empty', target: 'target' })
  assert.equal(s.api.calls.length, before); assert.equal(s.started.length, 0); unchangedBoard(s)
})

test('切会话后迟到的地图compose不能把旧报告确认框带入新会话', async t => {
  const s = await mountStudio(t)
  let finish
  s.api.handle = call => call.path === 'compose' ? new Promise(resolve => { finish = resolve }) : undefined
  const pending = s.organizer().props.onPrepareMap(job(), { cards: ['r'], sources: [20], task: '旧报告任务', target: 'work' })
  assert.equal(typeof finish, 'function')
  labelled(s.render(), '从目录选择会话').props.onChange(event('B'))
  assert.equal(s.organizer().props.session.id, 'B')
  finish(json({ text: 'OLD REPORT DRAFT', tokens: 10 }))
  await pending
  assert.equal(s.started.length, 0); unchangedBoard(s)
  assert.equal(component(s.render(), s.h.api.Dialog).props.dialog, null, 'stale report preview must be discarded after the source session changes')
})

test('地图输入容器非数组、空来源、非法类型和prototype类别不会成为节点或关系', t => {
  const s = mountMap(t)
  for (const value of [undefined, null, {}, 'not an array', 42]) {
    const data = s.h.api.reportMapData(job({ sources: value, report: { cards: value, relations: value } }))
    assert.equal(data.cards.length, 0); assert.equal(data.sources.size, 0); assert.equal(data.links.length, 0)
  }
  const value = job(), valid = value.sources[1]
  value.sources = [null, {}, { seq: -1, text: 'negative' }, { seq: '20', text: 'string ID' },
    { seq: 30, text: {} }, { seq: Number.MAX_SAFE_INTEGER + 1, text: 'unsafe' }, valid]
  value.report.cards = [null, {},
    ...['__proto__', 'constructor', 'toString', 'unknown'].map((category, i) => ({ id: 'bad' + i, category, title: 'bad', body: 'bad' })),
    { id: 'number-title', category: 'goal', title: 1, body: 'bad' },
    { id: 'object-body', category: 'goal', title: 'bad', body: {} },
    { id: 99, category: 'goal', title: 'bad', body: 'bad' },
    { id: 'a', category: 'goal', title: 'valid A', body: 'valid', evidence: [20, 20, '20', 999] },
    { id: 'a', category: 'goal', title: 'duplicate', body: 'duplicate', evidence: [20] },
    { id: 'b', category: 'risk', title: 'valid B', body: 'valid', evidence: { seq: 20 } },
  ]
  value.report.relations = [null,
    ...['__proto__', 'constructor', 'toString', 'shared'].map(kind => ({ from: 'a', to: 'b', kind, evidence: [20] })),
    { from: 'a', to: 'b', kind: 'supports', evidence: { seq: 20 } },
    { from: 'a', to: 'b', kind: 'supports', evidence: [20, '20', 999] },
  ]
  const data = s.h.api.reportMapData(value)
  assert.deepEqual(plain(data.cards.map(c => c.id)), ['a', 'b'])
  assert.deepEqual(Array.from(data.sources.keys()), [20])
  assert.deepEqual(plain(data.refs.get('a')), [20]); assert.deepEqual(plain(data.refs.get('b')), [])
  assert.deepEqual(plain(data.links), [{ from: 'a', to: 'b', kind: 'supports', evidence: [20], ai: true }])
  s.props({ job: value })
  assert.equal(nodes(s.render()).filter(n => n.props?.['data-node-id']).length, 2)
})

for (const scenario of ['空来源条目', '非数组卡片引用']) {
  test('地图过滤' + scenario + '后仍能将有效节点转换为草稿', t => {
    const value = job(), s = mountMap(t, value)
    if (scenario === '空来源条目') value.sources.unshift(null)
    else value.report.cards.find(c => c.id === 'r').evidence = { seq: 20 }
    const data = s.h.api.reportMapData(value)
    const chosen = s.h.api.mapSelection(data, { cards: ['r'], sources: [], excluded: [], skipSources: [], includeSources: true })
    assert.deepEqual(plain(chosen.cards.map(c => c.id)), ['r'])
    const items = s.h.api.reportDraftItems(value, { cards: ['r'], sources: chosen.sources.map(x => x.seq) })
    assert.equal(items[0].kind, 'note')
    assert.deepEqual(plain(items[0].reportEvidence), scenario === '空来源条目' ? [20] : [])
  })
}

test('risk位于结论中列；旧报告默认显示共享引用，密集图限60条且聚焦仍可看遗漏邻居', t => {
  const value = job(), s = mountMap(t, value), layout = s.h.api.reportMapData(value)
  const x = id => layout.nodes.find(n => n.id === id).x
  assert.equal(x('r'), x('d')); assert.ok(x('g') < x('r')); assert.ok(x('r') < x('n'))
  delete value.report.relations
  const edges = tree => nodes(tree).filter(n => n.type === 'g' && /\bcsx-map-edge\b/.test(n.props.className))
  assert.equal(edges(s.render()).length, 1)
  assert.match(edges(s.render())[0].props.className, /\bshared\b/)
  const dense = job({ id: 'dense-report' }); delete dense.report.relations
  dense.report.cards = Array.from({ length: 20 }, (_, i) => ({ id: 'c' + i, category: 'evidence', title: '密集节点' + i, body: '仍需核对', evidence: [20] }))
  s.props({ job: dense })
  assert.equal(s.h.api.reportMapData(dense).links.length, 190)
  assert.equal(edges(s.render()).length, 60)
  assert.ok(edges(s.render()).every(n => /\bshared\b/.test(n.props.className)))
  assert.equal(nodes(s.render()).filter(n => n.props?.['data-node-id']).length, 20)
  labelled(s.render(), '查看节点：密集节点19').props.onClick()
  assert.equal(edges(s.render()).length, 19)
  assert.equal(nodes(labelled(s.render(), '地图节点详情')).filter(n => n.type === 'li').length, 19)
  assert.deepEqual(s.requests, []); assert.deepEqual(s.prepared, [])
})

test('两份地图compose倒序返回时保留后一次预览及目标，旧响应不覆盖确认内容', async t => {
  const s = await mountStudio(t), pending = []
  s.api.handle = call => call.path === 'compose' ? new Promise(resolve => pending.push({ call, resolve })) : undefined
  const old = s.organizer().props.onPrepareMap(job(), { cards: ['r'], sources: [], task: '旧预览任务', target: 'work' })
  const latest = s.organizer().props.onPrepareMap(job({ id: 'report-new' }), { cards: ['n'], sources: [], task: '新预览任务', target: 'target' })
  assert.equal(pending.length, 2)
  pending[1].resolve(json({ text: 'LATEST DRAFT', tokens: 10 })); await latest
  const latestDialog = component(s.render(), s.h.api.Dialog).props.dialog
  assert.ok(latestDialog); assert.equal(s.started.length, 0)
  pending[0].resolve(json({ text: 'STALE DRAFT', tokens: 10 })); await old
  const modal = component(s.render(), s.h.api.Dialog)
  assert.equal(modal.props.dialog, latestDialog)
  const body = s.h.render(latestDialog.body.type, latestDialog.body.props)
  assert.ok(text(body).includes('LATEST DRAFT')); assert.ok(text(body).includes('新目标项目'))
  assert.equal(text(body).includes('STALE DRAFT'), false)
  click(s.h.render(s.h.api.Dialog, modal.props), latestDialog.confirmLabel); await tick()
  assert.deepEqual(s.started, [['target', { prompt: 'LATEST DRAFT', whenDraftExists: 'append' }]])
  unchangedBoard(s)
})

test('宿主不能预填时地图也先展示完整草稿，取消不复制，确认后才复制', async t => {
  for (const services of [null, { uiWorkspace: {} }]) {
    const s = await mountStudio(t)
    s.h.api.setServices(services)
    const selection = { cards: ['r'], sources: [20], task: '复制前必须核对', target: 'target' }
    await s.organizer().props.onPrepareMap(job(), selection)
    let modal = component(s.render(), s.h.api.Dialog)
    assert.equal(modal.props.dialog.confirmLabel, '复制草稿')
    let body = s.h.render(modal.props.dialog.body.type, modal.props.dialog.body.props)
    for (const expected of ['确认后仅复制', '复制前必须核对', '合成原文 20', '新目标项目']) assert.ok(text(body).includes(expected), expected)
    assert.deepEqual(s.h.copied, []); assert.deepEqual(s.started, [])
    click(s.h.render(s.h.api.Dialog, modal.props), '取消')
    assert.deepEqual(s.h.copied, []); unchangedBoard(s)
    await s.organizer().props.onPrepareMap(job(), selection)
    modal = component(s.render(), s.h.api.Dialog)
    body = s.h.render(modal.props.dialog.body.type, modal.props.dialog.body.props)
    const full = text(nodes(body).find(n => n.type === 'pre'))
    assert.deepEqual(s.h.copied, [])
    click(s.h.render(s.h.api.Dialog, modal.props), '复制草稿'); await tick()
    assert.deepEqual(s.h.copied, [full]); assert.deepEqual(s.started, [])
    assert.ok(s.api.calls.filter(c => c.method === 'POST').every(c => c.path === 'compose'))
    unchangedBoard(s)
  }
})

test('Organizer默认优先active或running作业，优先级高于最新失败和已有完成报告', async t => {
  for (const [status, active] of [['running', false], ['cancelled', true]]) {
    const api = server(), h = harness(api.fetch)
    t.after(() => h.unmount())
    api.reports = [job({ id: 'new-failure', status: 'failed', report: null, error: '合成失败' }), job({ id: 'completed-report' }),
      job({ id: 'active-job', status, active, report: null })]
    const tree = await h.settle(h.api.Organizer, { session: { id: 'S', title: 'S' } })
    assert.equal(labelled(tree, '已有整理记录').props.value, 'active-job')
    assert.equal(labelled(tree, '已有整理记录').props.disabled, true)
    assert.deepEqual(api.calls.filter(c => c.path === 'organize-job').map(c => c.query.get('id')), ['active-job'])
    assert.ok([...h.timers.values()].some(timer => timer.ms === 1000))
    assert.ok(api.calls.every(c => c.method === 'GET'))
  }
})

test('最近失败/取消/中断不挡旧完成地图，可从最近状态入口查询，再返回旧报告', async t => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const api = server(), h = harness(api.fetch), props = { session: { id: 'S', title: 'S' } }
    t.after(() => h.unmount())
    api.reports = [job({ id: 'latest-status', status, report: null, error: '本次未完成' }), job({ id: 'older-completed' })]
    let tree = await h.settle(h.api.Organizer, props)
    assert.equal(component(tree, h.api.ReportMap).props.job.id, 'older-completed')
    assert.match(text(tree), /最近一次整理未完成，当前显示已有报告/)
    click(tree, '查看最近状态'); tree = await h.settle(h.api.Organizer, props)
    assert.equal(labelled(tree, '已有整理记录').props.value, 'latest-status')
    assert.match(text(labelled(tree, '整理作业状态')), /本次未完成/)
    assert.equal(nodes(tree).some(n => n.type === h.api.ReportMap), false)
    labelled(tree, '已有整理记录').props.onChange(event('older-completed'))
    tree = await h.settle(h.api.Organizer, props)
    assert.equal(component(tree, h.api.ReportMap).props.job.id, 'older-completed')
    assert.deepEqual(api.calls.filter(c => c.path === 'organize-job').map(c => c.query.get('id')), ['older-completed', 'latest-status', 'older-completed'])
    assert.ok(api.calls.every(c => c.method === 'GET'))
  }
})

test('没有active/running或completed时恢复最近作业，不自动重新整理', async t => {
  const api = server(), h = harness(api.fetch)
  t.after(() => h.unmount())
  api.reports = [job({ id: 'latest-failed', status: 'failed', report: null, error: '最近一次错误' }),
    job({ id: 'old-cancelled', status: 'cancelled', report: null })]
  const tree = await h.settle(h.api.Organizer, { session: { id: 'S', title: 'S' } })
  assert.equal(labelled(tree, '已有整理记录').props.value, 'latest-failed')
  assert.match(text(labelled(tree, '整理作业状态')), /最近一次错误/)
  assert.deepEqual(api.calls.filter(c => c.path === 'organize-job').map(c => c.query.get('id')), ['latest-failed'])
  assert.equal(nodes(tree).some(n => n.type === h.api.ReportMap), false)
  assert.ok(api.calls.every(c => c.method === 'GET'))
})

test('同一报告重新挂载恢复内存选择、原文排除和任务；关闭详情保留地图，重载模块不继承缓存', t => {
  const value = job(), s = mountMap(t, value)
  labelled(s.render(), '选用节点：待查疑点').props.onChange()
  labelled(s.render(), '查看节点：待查疑点').props.onClick()
  labelled(s.render(), '查看原文 #20').props.onClick()
  checkbox(s.render(), '带上这段原文').props.onChange()
  labelled(s.render(), '查看节点：直接关联行动').props.onClick(); click(s.render(), '本次不带走')
  labelled(s.render(), '选用节点：任务约束').props.onChange()
  labelled(s.render(), '查看节点：独立证据摘要').props.onClick()
  labelled(s.render(), '查看原文 #30').props.onClick()
  checkbox(s.render(), '带上这段原文').props.onChange()
  checkbox(s.render(), '附带引用原文').props.onChange()
  labelled(s.render(), '地图新任务').props.onChange(event('返回地图后继续核对'))
  labelled(s.render(), '地图目标项目').props.onChange(event('target'))
  // Clear React hook instances, but keep the loaded module alive: equivalent to
  // leaving the map for the raw inspector and mounting this report again.
  s.h.unmount()
  let tree = s.render()
  assert.deepEqual(selected(tree), ['g', 'r'])
  assert.equal(labelled(tree, '地图新任务').props.value, '返回地图后继续核对')
  assert.equal(labelled(tree, '地图目标项目').props.value, 'target')
  assert.equal(checkbox(tree, '附带引用原文').props.checked, false)
  assert.equal(checkbox(tree, '带上这段原文').props.checked, true)
  assert.equal(text(nodes(labelled(tree, '地图节点详情')).find(n => n.type === 'pre')), value.sources[2].text)
  assert.match(nodes(tree).find(n => n.props?.['data-node-id'] === 'n').props.className, /\bexcluded\b/)
  click(tree, '关闭详情'); tree = s.render()
  labelled(tree, '任务关系图'); assert.deepEqual(selected(tree), ['g', 'r'])
  assert.equal(nodes(labelled(tree, '地图节点详情')).some(n => n.type === 'pre'), false)
  checkbox(tree, '附带引用原文').props.onChange()
  labelled(s.render(), '查看节点：待查疑点').props.onClick()
  labelled(s.render(), '查看原文 #20').props.onClick()
  assert.equal(checkbox(s.render(), '带上这段原文').props.checked, false, 'explicitly excluded source stays excluded after remount')
  click(s.render(), '预览新会话 →')
  assert.deepEqual(s.prepared.at(-1).selection.sources.sort((a, b) => a - b), [10, 30])
  assert.deepEqual(s.h.saved, {}); assert.deepEqual(s.requests, [])
  const fresh = harness(undefined, s.h.saved)
  t.after(() => fresh.unmount())
  const reloaded = fresh.render(fresh.api.ReportMap, { job: value, target: 'work', projects })
  assert.deepEqual(selected(reloaded), [])
  assert.match(text(labelled(reloaded, '新会话起点')), /0 个 AI 整理节点 \+ 0 段原文/)
})

test('重新挂载时缓存按sessionId和jobId共同隔离，回到各报告只恢复自己的选择', t => {
  const s = mountMap(t), a = job({ id: 'same-job-id', sessionId: 'S' }), b = job({ id: 'same-job-id', sessionId: 'B' })
  function remount(value) { s.h.unmount(); s.props({ job: value }); return s.render() }
  labelled(remount(a), '选用节点：待查疑点').props.onChange()
  labelled(s.render(), '地图新任务').props.onChange(event('S专属任务'))
  let tree = remount(b)
  assert.deepEqual(selected(tree), [])
  labelled(tree, '选用节点：共享引用的结论').props.onChange()
  labelled(s.render(), '地图新任务').props.onChange(event('B专属任务'))
  tree = remount(a)
  assert.deepEqual(selected(tree), ['r']); assert.equal(labelled(tree, '地图新任务').props.value, 'S专属任务')
  tree = remount(b)
  assert.deepEqual(selected(tree), ['d']); assert.equal(labelled(tree, '地图新任务').props.value, 'B专属任务')
  tree = remount(job({ id: 'other-job-id', sessionId: 'S' }))
  assert.deepEqual(selected(tree), [])
  assert.deepEqual(s.h.saved, {}); assert.deepEqual(s.requests, [])
})

test('地图内存缓存最多保留6份：第7份使最早选择失效，其余报告重新挂载仍恢复', t => {
  const s = mountMap(t)
  const reports = Array.from({ length: 7 }, (_, i) => job({ id: 'cache-' + i }))
  function remount(value) { s.h.unmount(); s.props({ job: value }); return s.render() }
  for (const value of reports) labelled(remount(value), '选用节点：待查疑点').props.onChange()
  assert.deepEqual(selected(remount(reports[0])), [])
  for (const value of reports.slice(1)) assert.deepEqual(selected(remount(value)), ['r'], value.id)
  assert.deepEqual(s.h.saved, {}); assert.deepEqual(s.requests, [])
})

test('草稿便签引用去重且仅保留安全整数及有文本的来源', t => {
  const value = job(), s = mountMap(t, value)
  value.sources = [null, value.sources[1], { seq: 30, text: {} }, { seq: -1, text: 'negative' },
    { seq: Number.MAX_SAFE_INTEGER + 1, text: 'unsafe integer' }]
  value.report.cards.find(c => c.id === 'r').evidence = [20, 20, 30, -1, 1.5, '20', 999, Number.MAX_SAFE_INTEGER + 1]
  const items = plain(s.h.api.reportDraftItems(value, { cards: ['r'], sources: [20, 30, -1, 999] }))
  assert.equal(items.length, 2)
  const note = items.find(i => i.kind === 'note')
  assert.deepEqual(note.reportEvidence, [20])
  assert.equal(note.text.match(/#20/g)?.length, 1)
  assert.doesNotMatch(note.text, /#30|#-1|#999/)
  assert.equal(items.find(i => i.kind === 'snippet').evidenceSeq, 20)
})

test('确认框打开后切会话，旧prepare回调失效且旧确认不能创建会话或复制', async t => {
  for (const copyOnly of [false, true]) {
    const s = await mountStudio(t)
    if (copyOnly) s.h.api.setServices(null)
    const prepare = s.organizer().props.onPrepareMap
    const selection = { cards: ['r'], sources: [20], task: '属于S的草稿', target: 'work' }
    await prepare(job(), selection)
    const dialog = component(s.render(), s.h.api.Dialog).props.dialog
    assert.ok(dialog)
    assert.equal(dialog.confirmLabel, copyOnly ? '复制草稿' : '创建草稿')
    labelled(s.render(), '从目录选择会话').props.onChange(event('B'))
    assert.equal(s.organizer().props.session.id, 'B')
    const before = s.api.calls.length
    await prepare(job(), selection)
    assert.equal(s.api.calls.length, before, 'captured callback must check the current session, not only its old closure')
    await assert.rejects(dialog.onConfirm(), /当前会话已改变/)
    assert.deepEqual(s.started, []); assert.deepEqual(s.h.copied, [])
    unchangedBoard(s)
  }
})
