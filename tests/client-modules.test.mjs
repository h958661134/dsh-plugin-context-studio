import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  .replace('return module.exports;', 'exports.test = { request, Inspector, StudioPage, Board, evidenceItem, FlowGraph, flowLayout, observeCurrentSession, setServices: value => { services = value } }; return module.exports;')
const nodes = root => !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(nodes) : [root, ...nodes(root.children), ...nodes(root.props?.branch)]
const text = root => JSON.stringify(root)
const json = data => ({ ok: true, json: async () => data })
const tick = () => new Promise(setImmediate)
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
const button = (root, label) => {
  const found = nodes(root).find(n => n.children?.includes(label) && typeof n.props?.onClick === 'function')
  assert.ok(found, 'button: ' + label)
  return found
}
const click = (root, label) => {
  const found = button(root, label)
  assert.notEqual(found.props.disabled, true, label + ' unexpectedly disabled')
  found.props.onClick(event())
}
const labelled = (root, label) => {
  const found = nodes(root).find(n => n.props?.['aria-label'] === label)
  assert.ok(found, 'label: ' + label)
  return found
}
function harness(fetch = () => new Promise(() => {}), saved = {}) {
  let cursor = 0, values = [], effects = [], pending = [], api
  const timers = new Map(); let timerId = 0
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) {
      const i = cursor++
      if (!(i in values)) values[i] = typeof init === 'function' ? init() : init
      return [values[i], value => { values[i] = typeof value === 'function' ? value(values[i]) : value }]
    },
    useRef(value) { const i = cursor++; if (!(i in values)) values[i] = { current: value }; return values[i] },
    useMemo(fn) { cursor++; return fn() },
    useEffect(fn, deps) {
      const i = cursor++
      if (!effects[i] || deps.some((d, j) => d !== effects[i].deps[j]))
        pending.push(() => { effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() } })
    },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: { load({ factory }) { api = factory(() => React).test } } },
    fetch, AbortController, console, navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: key => key in saved ? JSON.stringify(saved[key]) : null, setItem(key, value) { saved[key] = JSON.parse(value) } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  vm.runInContext(source, context)
  return {
    api, timers, saved,
    render(component, props = {}) {
      cursor = 0
      const tree = component(props), jobs = pending
      pending = []; jobs.forEach(fn => fn())
      return tree
    },
    unmount() { effects.forEach(e => e?.cleanup?.()) },
  }
}
const ids = ['requirements', 'memory', 'references', 'tools', 'history', 'skills', 'system', 'other']
const record = (seq = 3, extra = {}) => ({ seq, time: 12345, kind: 'user', source: 'user', module: 'requirements', label: '项目交付要求',
  preview: '先核对项目需求再执行', status: 'active', added: true, issueCount: 0, issues: [], ...extra })
function view(extra = {}) {
  const v = {
    sessionId: 'S', boundary: 100, observedAt: 123456, answer: { seq: 100, turn: 3, step: 1, preview: '这是紧凑回答预览' },
    timeline: [1, 50, 100, 150, 200].map((seq, i) => ({ seq, index: i + 1, preview: '回答预览 ' + seq, turn: i + 1, step: 1 })),
    timelineInfo: { total: 500, start: 0, shown: 5, previousSeq: 50, nextSeq: 150, firstSeq: 1, lastSeq: 200, earlierWindowSeq: 10, laterWindowSeq: 190 },
    modules: ids.map(id => ({ id, label: id, active: id === 'other' ? 0 : 3, replaced: id === 'other' ? 0 : 1, unknown: 0, issues: id === 'tools' ? 1 : 0 })),
    summary: { active: 21, replaced: 7, unknown: 0, added: 2, available: true },
    page: { module: 'requirements', state: 'active', index: 0, size: 16, total: 2300, pages: 144, items: [record()] },
    warnings: [], partial: false, limitation: '这些是日志记录，不能证明模型为何给出此答案。', ...extra,
  }
  const items = v.page?.items || []
  v.flow = {
    baseline: { seq: 50, preview: '比较起点' },
    comparison: { available: v.summary.available !== false, first: !v.answer, added: 2, retained: 10, removed: 1, unknown: 0, issues: 1 },
    scope: extra.scope || 'changes', page: v.page ? { ...v.page, size: 12 } : { index: 0, total: 0, pages: 0, size: 12 },
    nodes: items.map(r => ({ ...r, id: 'event:' + r.seq, change: r.status === 'replaced' ? 'removed' : 'added', canInspect: true })),
    anchors: [{ id: 'answer:' + (v.answer?.seq ?? 'pending'), seq: v.answer?.seq, kind: 'answer', label: '正在检查的回答', preview: v.answer?.preview || '', canInspect: !!v.answer }],
    edges: items.filter(r => r.status === 'active').map(r => ({ id: 'input:' + r.seq, from: 'event:' + r.seq, to: 'answer:' + (v.answer?.seq ?? 'pending'), kind: 'input', label: '本步输入' })),
    omittedRelations: 0, focusFound: null,
    guidance: [{ id: 'check', title: '工具返回需要核对', detail: '先查看工具原文，不代表已确认原因。', scope: 'issues', eventSeq: 3, severity: 'warning' },
      { id: 'req', title: '核对用户要求', detail: '检查约束是否保留', scope: 'active', module: 'requirements', severity: 'info' }],
  }
  return v
}
function detail(extra = {}) {
  return { row: { ...record(), changes: [], refs: [], sourceEventSeqs: [], text: '甲乙甲乙', textOffset: 0, sourcePart: 'body', tokens: 3, clipped: true },
    text: '甲乙甲乙', offset: 0, nextOffset: 12000, previousOffset: null, totalChars: 24004,
    part: 'body', hasArguments: true, argumentsPreview: '{"path":', incomplete: false, notices: [], ...extra }
}

function graph(root) {
  const found = nodes(root).find(n => n.props?.flow && typeof n.props.onSelect === 'function')
  assert.ok(found, 'flow graph mounted')
  return found
}
function openNode(root, seq) {
  const g = graph(root)
  g.props.onSelect(seq ?? g.props.flow.nodes[0].seq, event())
}
function chooseScope(root, name) {
  const found = nodes(root).find(n => n.type === 'button' && n.children?.[0] === name && n.props['aria-pressed'] != null)
  assert.ok(found, 'scope: ' + name)
  found.props.onClick()
}

const baseProps = { session: { id: 'S', title: '测试会话', workspaceId: 'work' }, refresh: 0, has: () => false }
function mounted(fetch, props = {}) {
  const h = harness(fetch)
  let active = { ...baseProps, ...props }
  return { h, render: () => h.render(h.api.Inspector, active), props: patch => { active = { ...active, ...patch } } }
}
const route = url => new URL(url, 'http://localhost')

test('默认只请求流转元信息，画布节点来自真实记录，沿用折叠而非分类卡片', async () => {
  const calls = [], s = mounted(async url => { calls.push(url); return json(view()) })
  s.render(); await tick()
  const tree = s.render(), g = graph(tree)
  assert.equal(calls.length, 1); assert.match(calls[0], /\/inspect-flow\?/)
  assert.equal(calls.some(u => u.includes('/inspect-detail') || u.includes('/inspect?') || u.includes('/inspect-view')), false)
  assert.equal(g.props.flow.nodes[0].seq, 3)
  assert.equal(nodes(tree).filter(n => n.type === 'textarea').length, 0)
  assert.match(text(tree), /沿用 10 条 · 展开输入/)
  assert.doesNotMatch(text(tree), /当时有效|条有效|有效上下文|csx-module-grid/)
  labelled(tree, '流转范围')
})

test('点具体线索提交scope+focus并锁定回答，聚焦画布后可打开该节点原文', async () => {
  const calls = [], s = mounted(async url => { calls.push(route(url)); return json(url.includes('/inspect-detail') ? detail() : view()) })
  s.render(); await tick()
  let tree = s.render(), focused = 0, scrolled = 0
  nodes(tree).find(n => n.type === 'main').props.ref.current = { focus() { focused++ }, scrollIntoView() { scrolled++ } }
  labelled(tree, '定位线索：工具返回需要核对').props.onClick()
  tree = s.render()
  assert.equal(focused, 1); assert.equal(scrolled, 1)
  assert.equal(calls.at(-1).searchParams.get('scope'), 'issues')
  assert.equal(calls.at(-1).searchParams.get('focus'), '3')
  assert.equal(calls.at(-1).searchParams.get('answer'), '100')
  await tick(); tree = s.render()
  assert.equal(graph(tree).props.selectedSeq, 3)
  openNode(tree, 3); s.render(); await tick()
  labelled(s.render(), '历史上下文原文，可选择文字')
})

test('空范围仍有真实回答锚点与说明，不用零分类卡片占位', async () => {
  const v = view({ page: { index: 0, total: 0, pages: 0, items: [] } })
  const s = mounted(async () => json(v)); s.render(); await tick()
  const tree = s.render()
  assert.equal(graph(tree).props.flow.nodes.length, 0)
  assert.equal(graph(tree).props.flow.anchors[0].id, 'answer:100')
  assert.match(text(tree), /当前范围没有记录/)
  assert.doesNotMatch(text(tree), /无记录模块|csx-module-card/)
})

test('范围切换立即取消请求；晚到数据不覆盖新范围也不闪旧记录', async () => {
  const jobs = [], s = mounted((url, opts) => new Promise(resolve => jobs.push({ url: route(url), opts, resolve })))
  s.render(); jobs[0].resolve(json(view())); await tick()
  let tree = s.render()
  chooseScope(tree, '待核对'); tree = s.render()
  assert.doesNotMatch(text(tree), /先核对项目需求再执行/)
  const old = jobs.at(-1)
  const stateButton = nodes(tree).find(n => n.type === 'button' && n.children[0] === '已替换')
  stateButton.props.onClick(); s.render()
  assert.equal(old.opts.signal.aborted, true)
  const latest = jobs.at(-1)
  assert.equal(latest.url.searchParams.get('scope'), 'replaced')
  latest.resolve(json(view({ page: { module: 'tools', state: 'replaced', index: 0, total: 1, pages: 1, items: [record(8, { preview: 'NEW STATE', status: 'replaced' })] } })))
  await tick()
  old.resolve(json(view({ page: { module: 'tools', state: 'active', index: 0, total: 1, pages: 1, items: [record(9, { preview: 'OLD STATE' })] } })))
  await tick(); tree = s.render()
  assert.match(text(tree), /NEW STATE/)
  assert.doesNotMatch(text(tree), /OLD STATE/)
  s.h.unmount(); await tick()
  assert.equal(s.h.timers.size, 0)
})

test('回答支持相邻、最早最新和窗口跳转；请求按目标回答而非局部下拉序号', async () => {
  for (const [label, expected] of [['← 上一步', 50], ['下一步 →', 150], ['最早', 1], ['最新', 200], ['更早一组', 10], ['更晚一组', 190]]) {
    const calls = [], s = mounted(async url => { calls.push(route(url)); return json(view()) })
    s.render(); await tick()
    click(s.render(), label); s.render()
    assert.equal(calls.at(-1).searchParams.get('answer'), String(expected), label)
    assert.equal(calls.at(-1).searchParams.get('page'), '0')
    s.h.unmount()
  }
})

test('分页目录总量大不等于内容缺失，记录翻页与搜索使用服务器页码及编码', async () => {
  const calls = [], s = mounted(async url => {
    const u = route(url); calls.push(u)
    const index = Number(u.searchParams.get('page') || 0)
    return json(view({ page: { module: 'requirements', state: 'active', index, size: 16, total: 2300, pages: 144, items: [record(index + 3)] } }))
  })
  s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /500 次输出|2300 条上下文|2300 条/)
  assert.doesNotMatch(text(tree), /检查有额外限制|记录缺失/)
  click(tree, '下一页记录'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.get('page'), '1')
  labelled(tree, '搜索标题或预览').props.onChange(event('路径 & 纠正'))
  tree = s.render()
  nodes(tree).find(n => n.type === 'form').props.onSubmit(event())
  s.render()
  assert.equal(calls.at(-1).searchParams.get('q'), '路径 & 纠正')
  assert.equal(calls.at(-1).searchParams.get('page'), '0')
  assert.equal(calls.at(-1).searchParams.get('answer'), '100')
})

test('极端前缀目录不可用不显示0上下文，仍保留回答导航和原文入口', async () => {
  const calls = [], s = mounted(async url => {
    calls.push(route(url))
    return json(view({ summary: { available: false }, modules: [], page: null, partial: true, warnings: [{ code: 'limit', title: '容量限制', detail: '请选择更早回答' }] }))
  })
  s.render(); await tick()
  const tree = s.render()
  assert.match(text(tree), /暂不可比较|数量未知/)
  assert.equal(graph(tree).props.flow.nodes.length, 0)
  assert.doesNotMatch(text(tree), /0 条在输入中|当前范围没有记录/)
  button(tree, '核对当前回答')
  click(tree, '最早'); s.render()
  assert.equal(calls.at(-1).searchParams.get('answer'), '1')
})

test('没有assistant但已有user消息时，切范围及原文请求均省略answer', async () => {
  const calls = [], empty = view({ answer: null, boundary: 7, timeline: [], timelineInfo: { total: 0 } })
  const s = mounted(async url => { const u = route(url); calls.push(u); return json(u.pathname.endsWith('/inspect-detail') ? detail() : empty) })
  s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /还没有模型回答/)
  chooseScope(tree, '全部输入'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.has('answer'), false)
  openNode(tree); s.render(); await tick(); tree = s.render()
  assert.ok(calls.at(-1).pathname.endsWith('/inspect-detail'))
  assert.equal(calls.at(-1).searchParams.has('answer'), false)
  assert.equal(calls.at(-1).searchParams.get('event'), '3')
  assert.equal(labelled(tree, '历史上下文原文，可选择文字').props.value, '甲乙甲乙')
})

test('原文跨页及正文/参数选择保留绝对偏移；相同文字的第二次出现不会误指向第一次', async () => {
  const calls = [], added = []
  const s = mounted(async url => {
    const u = route(url); calls.push(u)
    if (u.pathname.endsWith('/inspect-flow')) return json(view())
    const offset = Number(u.searchParams.get('offset')), part = u.searchParams.get('part')
    return json(detail({ offset, part, previousOffset: offset ? 0 : null, nextOffset: offset ? null : 12000 }))
  }, { onAdd(session, row, chosen) { added.push({ session, row, text: chosen }) } })
  s.render(); await tick()
  openNode(s.render()); s.render(); await tick()
  let tree = s.render()
  labelled(tree, '历史上下文原文，可选择文字').props.onSelect({ target: { selectionStart: 2, selectionEnd: 4 } })
  tree = s.render(); click(tree, '只加入选中文字')
  assert.equal(added[0].text, '甲乙')
  assert.equal(added[0].row.selectionStart, 2)
  assert.equal(added[0].row.textOffset, 0)
  click(tree, '下一页原文'); s.render(); await tick(); tree = s.render()
  assert.equal(button(tree, '只加入选中文字').props.disabled, true)
  assert.equal(calls.at(-1).searchParams.get('offset'), '12000')
  click(tree, '将本页加入分支草稿')
  assert.equal(added[1].row.textOffset, 12000); assert.equal(added[1].row.sourcePart, 'body')
  click(tree, '调用参数'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.get('offset'), '0')
  assert.equal(calls.at(-1).searchParams.get('part'), 'arguments')
  click(tree, '将本页加入分支草稿')
  assert.equal(added[2].row.sourcePart, 'arguments')
  const items = added.map(a => s.h.api.evidenceItem(a.session, a.row, a.text))
  assert.deepEqual(items.map(i => i.evidenceOffset), [2, 12000, 0])
  assert.equal(new Set(items.map(i => i.key)).size, 3)
  assert.match(items[1].from, /正文 · 字符 12001–12004/)
  assert.match(items[2].from, /调用参数 · 字符 1–4/)
})

test('翻页后旧原文迟到不会串入当前页，切状态立即关闭原文并中止详情', async () => {
  const jobs = [], s = mounted((url, opts) => {
    const u = route(url)
    if (u.pathname.endsWith('/inspect-flow')) return Promise.resolve(json(view()))
    return new Promise(resolve => jobs.push({ u, opts, resolve }))
  })
  s.render(); await tick(); openNode(s.render()); s.render()
  jobs[0].resolve(json(detail())); await tick()
  let tree = s.render(); click(tree, '下一页原文'); s.render()
  const slow = jobs[1]
  // Switching a module/state aborts the slow next page and hides the old selection immediately.
  tree = s.render()
  nodes(tree).find(n => n.type === 'button' && n.children[0] === '位置未知').props.onClick()
  tree = s.render()
  assert.equal(slow.opts.signal.aborted, true)
  assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '原文详情'), false)
  slow.resolve(json(detail({ text: 'STALE PAGE' }))); await tick()
  assert.doesNotMatch(text(s.render()), /STALE PAGE/)
})

test('详情失败只影响抽屉，记录与回答导航保留且可单独重试；关闭中止详情', async () => {
  const calls = []; let detailFails = true, pendingPage = false
  const s = mounted(async (url, opts) => {
    const u = route(url); calls.push({ u, opts })
    if (u.pathname.endsWith('/inspect-flow')) return json(view())
    if (pendingPage) return new Promise(() => {})
    if (detailFails) throw Error('detail offline')
    return json(detail())
  })
  s.render(); await tick(); openNode(s.render()); s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /detail offline/)
  labelled(tree, '回答导航'); graph(tree)
  detailFails = false; click(tree, '重试原文'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.filter(c => c.u.pathname.endsWith('/inspect-flow')).length, 1)
  labelled(tree, '历史上下文原文，可选择文字')
  pendingPage = true; click(tree, '下一页原文'); tree = s.render()
  click(tree, '关闭原文'); tree = s.render()
  assert.equal(calls.at(-1).opts.signal.aborted, true)
  assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '原文详情'), false)
})

test('分页请求失败不抹掉回答导航，手动重试带refresh且不把它传播到下一页', async () => {
  let fails = false; const calls = []
  const s = mounted(async url => {
    const u = route(url); calls.push(u)
    if (fails) throw Error('view offline')
    const v = view(); v.flow.page.index = Number(u.searchParams.get('page') || 0)
    return json(v)
  })
  s.render(); await tick(); fails = true
  click(s.render(), '下一页记录'); s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /view offline/)
  labelled(tree, '回答导航')
  assert.doesNotMatch(text(tree), /这个模块在所选状态下没有记录/)
  fails = false; click(tree, '重新读取此会话'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.get('refresh'), '1')
  click(tree, '下一页记录'); s.render()
  assert.equal(calls.at(-1).searchParams.has('refresh'), false)
})

test('会话切换取消详情与旧目录，旧原文不能出现于新会话', async () => {
  const jobs = [], s = mounted((url, opts) => new Promise(resolve => jobs.push({ u: route(url), opts, resolve })))
  s.render(); jobs[0].resolve(json(view())); await tick()
  openNode(s.render()); s.render()
  const oldDetail = jobs[1]
  s.props({ session: { id: 'NEXT', title: '下一个会话' } })
  let tree = s.render()
  assert.equal(oldDetail.opts.signal.aborted, true)
  assert.doesNotMatch(text(tree), /这是紧凑回答预览|项目交付要求/)
  jobs.at(-1).resolve(json(view({ sessionId: 'NEXT' }))); await tick()
  oldDetail.resolve(json(detail({ text: 'FROM OLD SESSION' }))); await tick()
  tree = s.render()
  assert.doesNotMatch(text(tree), /FROM OLD SESSION/)
  labelled(tree, '回答导航')
})

test('草稿按session/event/part/绝对范围去重，快速重复加入安全且持久化来源', async () => {
  const saved = {}, h = harness(async url => {
    if (url.endsWith('/projects')) return json({ projects: [] })
    if (url.endsWith('/journal')) return json({ ops: [] })
    return json({ sessions: [baseProps.session] })
  }, saved)
  h.render(h.api.StudioPage); await tick()
  let tree = h.render(h.api.StudioPage)
  const inspector = nodes(tree).find(n => n.type === h.api.Inspector)
  const row = { ...record(), text: 'same', textOffset: 0, sourcePart: 'body', selectionStart: 0 }
  inspector.props.onAdd(baseProps.session, row, 'same')
  inspector.props.onAdd(baseProps.session, row, 'same')
  inspector.props.onAdd(baseProps.session, { ...row, textOffset: 12000 }, 'same')
  inspector.props.onAdd(baseProps.session, { ...row, sourcePart: 'arguments' }, 'same')
  inspector.props.onAdd({ ...baseProps.session, id: 'OTHER' }, row, 'same')
  tree = h.render(h.api.StudioPage)
  const items = nodes(tree).find(n => n.type === h.api.Board).props.items
  assert.equal(items.length, 4)
  assert.equal(new Set(items.map(i => i.key)).size, 4)
  assert.equal(saved['dsh-context-studio:board'][1].textOffset, 12000)
  assert.equal(saved['dsh-context-studio:board'][2].sourcePart, 'arguments')
  assert.match(saved['dsh-context-studio:board'][2].from, /调用参数/)
})

test('顶部会话目录独立于Inspector，并能直接切到另一个会话', async () => {
  const calls = [], h = harness(async url => {
    calls.push(url)
    if (url.endsWith('/projects')) return json({ projects: [] })
    if (url.endsWith('/journal')) return json({ ops: [] })
    return json({ sessions: [{ id: 'A', title: '会话A' }, { id: 'B', title: '会话B' }] })
  })
  h.render(h.api.StudioPage); await tick()
  let tree = h.render(h.api.StudioPage)
  labelled(tree, '从目录选择会话').props.onChange(event('B'))
  tree = h.render(h.api.StudioPage)
  assert.equal(nodes(tree).find(n => n.type === h.api.Inspector).props.session.id, 'B')
  assert.equal(calls.some(u => u.includes('/graph') || u.includes('/pieces') || u.includes('/inspect')), false)
})

test('取消时JSON仍挂起也能结算请求、清理计时器，不产生幽灵超时', async () => {
  const h = harness(async () => ({ ok: true, json: () => new Promise(() => {}) }))
  const controller = new AbortController(), promise = h.api.request('/inspect-flow?id=S', undefined, controller.signal)
  const rejection = assert.rejects(promise, error => error.name === 'AbortError')
  await tick(); controller.abort()
  await rejection
  assert.equal(h.timers.size, 0)
})

test('键盘Escape关闭非模态原文抽屉，保持安全确认对话框独立', async () => {
  const s = mounted(async url => json(url.includes('/inspect-detail') ? detail() : view()))
  s.render(); await tick(); openNode(s.render()); s.render(); await tick()
  let tree = s.render(), stopped = false
  const panel = labelled(tree, '原文详情')
  assert.equal(panel.props.role, 'dialog'); assert.equal(panel.props['aria-modal'], false)
  panel.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped = true } })
  tree = s.render()
  assert.equal(stopped, true)
  assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '原文详情'), false)
})

test('少量回答使用单行导航仍可跳首末，序号0不是无上一回答', async () => {
  const calls = [], v = view()
  v.timelineInfo = { ...v.timelineInfo, total: 5, previousSeq: 0, firstSeq: 0, earlierWindowSeq: null, laterWindowSeq: null }
  const s = mounted(async url => { calls.push(route(url)); return json(v) })
  s.render(); await tick()
  const tree = s.render()
  assert.equal(nodes(tree).some(n => n.props?.className === 'csx-row csx-time-window'), false)
  button(tree, '最早'); button(tree, '最新')
  click(tree, '← 上一步'); s.render()
  assert.equal(calls.at(-1).searchParams.get('answer'), '0')
})

test('真实流转契约：无回答的长user消息可切范围、翻到尾页并摘录准确来源', async () => {
  const { indexContext, contextDetail } = await import('../lib/context-view.js')
  const { contextFlow } = await import('../lib/context-flow.js')
  const log = { session: { id: 'S' }, events: [{ seq: 0, type: 'user/message', surfaceOp: 'append', data: {
    source: { kind: 'user' }, content: [{ type: 'text', text: '前'.repeat(12000) + '尾页原文' }],
  } }] }
  const added = [], calls = [], pending = []
  const s = mounted(url => {
    const work = (async () => {
    const u = route(url), p = u.searchParams; calls.push(u)
    const index = await indexContext(log, p.has('answer') ? Number(p.get('answer')) : undefined)
    return json(u.pathname.endsWith('/inspect-detail')
      ? contextDetail(index, Number(p.get('event')), Number(p.get('offset')), p.get('part'))
      : contextFlow(index, null, { module: p.get('module') || undefined, scope: p.get('scope'), page: Number(p.get('page')) }))
    })()
    pending.push(work)
    return work
  }, { onAdd(session, row, chosen) { added.push({ session, row, text: chosen }) } })
  async function settle() { await pending.at(-1); await tick() }
  s.render(); await settle()
  chooseScope(s.render(), '全部输入'); s.render(); await settle()
  openNode(s.render()); s.render(); await settle()
  click(s.render(), '下一页原文'); s.render(); await settle()
  const tree = s.render()
  assert.equal(labelled(tree, '历史上下文原文，可选择文字').props.value, '尾页原文')
  assert.doesNotMatch(text(tree), /这条原文包含缺失|容量上限/)
  click(tree, '将本页加入分支草稿')
  assert.equal(added[0].text, '尾页原文'); assert.equal(added[0].row.textOffset, 12000)
  assert.equal(added[0].row.sourcePart, 'body')
  assert.equal(calls.some(u => u.searchParams.has('answer')), false)
})

test('只读tool-call来源详情使用来源记录标签，不冒充回答输入', async () => {
  const data = detail(); data.row = { ...data.row, seq: 34, status: 'source' }
  const s = mounted(async url => json(url.includes('/inspect-detail') ? data : view()))
  s.render(); await tick(); openNode(s.render()); s.render(); await tick()
  const tree = labelled(s.render(), '原文详情')
  assert.match(text(tree), /事件 #34 · 来源记录/)
  assert.doesNotMatch(text(tree), /回答前的记录/)
})

test('图完整渲染：33→34→35→39按请求/返回/输入向右推进，同端点语义边不重叠', () => {
  const h = harness(), f = {
    baseline: { seq: 33 }, nodes: [record(33, { id: 'event:33', kind: 'assistant', change: 'added', canInspect: true }), record(35, { id: 'event:35', kind: 'tool', change: 'added', canInspect: true })],
    anchors: [{ id: 'event:34', seq: 34, kind: 'call', label: 'read', canInspect: true }, { id: 'answer:39', seq: 39, kind: 'answer', label: '本次回答', canInspect: true }],
    edges: [
      { id: 'a', from: 'event:33', to: 'event:34', kind: 'request', label: '请求调用 · ID对应' },
      { id: 'b', from: 'event:34', to: 'event:35', kind: 'call', label: '调用 → 返回' },
      { id: 'c', from: 'event:34', to: 'event:35', kind: 'source', label: '记录来源' },
      { id: 'd', from: 'event:35', to: 'answer:39', kind: 'input', label: '本步输入' },
      { id: 'e', from: 'event:33', to: 'answer:39', kind: 'input', label: '本步输入' },
    ],
  }
  const layout = h.api.flowLayout(f), pos = layout.positions
  assert.ok(pos['event:33'].x < pos['event:34'].x)
  assert.ok(pos['event:34'].x < pos['event:35'].x)
  assert.ok(pos['event:35'].x < pos['answer:39'].x)
  assert.ok(layout.width <= 950); assert.ok(layout.height < 320)
  assert.notEqual(layout.edges.find(e => e.id === 'b').path, layout.edges.find(e => e.id === 'c').path)
  let selected
  const tree = h.render(h.api.FlowGraph, { flow: f, sessionId: 'S', onSelect: seq => { selected = seq } })
  assert.deepEqual(nodes(tree).filter(n => n.props?.['data-edge-id']).map(n => n.props['data-edge-id']), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(nodes(tree).filter(n => n.props?.['data-node-id']).length, 4)
  labelled(tree, '查看原文 #34 · read').props.onClick(event())
  assert.equal(selected, 34)
  assert.match(text(tree), /请求调用 · ID对应/)
})

test('未在接口提供的关系不凭空加边；引用锚点不伪装可读源会话', () => {
  const h = harness(), f = view().flow
  f.nodes.push(record(8, { id: 'event:8', status: 'replaced', change: 'removed', canInspect: true }))
  f.anchors.push({ id: 'reference:X:3', kind: 'reference', sessionId: 'X', label: '外部引用快照', canInspect: false })
  const tree = h.render(h.api.FlowGraph, { flow: f, onSelect() {} })
  assert.equal(nodes(tree).filter(n => n.props?.['data-edge-id']).length, f.edges.length)
  const reference = nodes(tree).find(n => n.props?.['data-node-id'] === 'reference:X:3')
  assert.equal(reference.type, 'div'); assert.equal(reference.props.onClick, undefined)
  assert.equal(h.api.flowLayout(f).edges.some(e => e.from === 'event:8'), false)
})

test('空白会话的pending回答显示尚无输出，不误标成外部会话', () => {
  const h = harness(), f = view({ answer: null, page: { index: 0, total: 0, pages: 0, items: [] } }).flow
  const tree = h.render(h.api.FlowGraph, { flow: f, onSelect() {} })
  assert.match(text(tree), /尚无输出/)
  assert.doesNotMatch(text(tree), /外部会话/)
  const pending = nodes(tree).find(n => n.props?.['data-node-id'] === 'answer:pending')
  assert.equal(pending.type, 'div')
})

test('画布直说本页/总量和省略关联，要求线索以module+scope定位', async () => {
  const calls = [], v = view(); v.flow.omittedRelations = 7
  const s = mounted(async url => { calls.push(route(url)); return json(v) })
  s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /本页 1 \/ 2300 条上下文|7 条关联未画出/)
  labelled(tree, '定位线索：核对用户要求').props.onClick(); s.render()
  assert.equal(calls.at(-1).searchParams.get('scope'), 'active')
  assert.equal(calls.at(-1).searchParams.get('module'), 'requirements')
  assert.equal(calls.at(-1).searchParams.has('focus'), false)
})

test('apply期观察当前会话，进插件后无mainView仍保留刚才会话；迟到订阅不抢手选', async () => {
  let key = 'A', listener, disposed = 0
  const h = harness(async url => json(url.endsWith('/projects') ? { projects: [] } : url.endsWith('/journal') ? { ops: [] } : { sessions: [{ id: 'A', title: '会话A' }, { id: 'B', title: '会话B' }, { id: 'C', title: '会话C' }] }))
  const stop = h.api.observeCurrentSession({ get(name) { assert.equal(name, 'uiSession'); return { adapter: { current: { getSnapshot: () => ({ key }), subscribe(fn) { listener = fn; return () => { disposed++ } } } } } } })
  key = undefined; listener()
  h.render(h.api.StudioPage); await tick()
  let tree = h.render(h.api.StudioPage)
  assert.equal(nodes(tree).find(n => n.type === h.api.Inspector).props.session.id, 'A')
  assert.match(text(tree), /刚才查看的会话/)
  labelled(tree, '从目录选择会话').props.onChange(event('B'))
  key = 'C'; listener(); tree = h.render(h.api.StudioPage)
  assert.equal(nodes(tree).find(n => n.type === h.api.Inspector).props.session.id, 'B')
  click(tree, '跟随刚才查看的会话'); tree = h.render(h.api.StudioPage)
  assert.equal(nodes(tree).find(n => n.type === h.api.Inspector).props.session.id, 'C')
  h.unmount(); stop(); assert.equal(disposed, 1)
})

test('当前会话服务缺失或订阅异常时回退目录，不读取私有selection', async () => {
  for (const service of [undefined, { adapter: { current: { getSnapshot() { throw Error('unavailable') }, subscribe() { throw Error('offline') } } } }]) {
    const h = harness(async url => json(url.endsWith('/projects') ? { projects: [] } : url.endsWith('/journal') ? { ops: [] } : { sessions: [{ id: 'B', title: '目录会话' }] }))
    const stop = h.api.observeCurrentSession({ get: () => service })
    h.render(h.api.StudioPage); await tick()
    const tree = h.render(h.api.StudioPage)
    assert.equal(nodes(tree).find(n => n.type === h.api.Inspector).props.session.id, 'B')
    assert.equal(button(tree, '跟随刚才查看的会话').props.disabled, true)
    stop(); h.unmount()
  }
})

test('旧脉络/素材墙偏好不恢复入口，刷新仍然只读目录而不扫描文件', async () => {
  for (const legacy of ['graph', 'wall']) {
    const calls = [], h = harness(async url => { calls.push(url); return json(url.endsWith('/projects') ? { projects: [] } : url.endsWith('/journal') ? { ops: [] } : { sessions: [] }) }, { 'dsh-context-studio:prefs': { view: legacy, debuggerVersion: 1 } })
    h.render(h.api.StudioPage); await tick()
    const tree = h.render(h.api.StudioPage)
    click(tree, '刷新'); await tick()
    assert.equal(calls.some(url => url.includes('/graph') || url.includes('/pieces')), false)
    assert.equal(nodes(tree).some(n => n.children?.includes('脉络') || n.children?.includes('素材墙')), false)
  }
})

test('精选分支先确认，再startSession填草稿；不会调用任何历史fork或发送', async () => {
  const started = [], calls = [], h = harness(async (url, opts) => {
    calls.push(url)
    if (url.endsWith('/compose')) return json({ text: 'SELECTED CONTEXT', tokens: 20 })
    return json(url.endsWith('/projects') ? { projects: [] } : url.endsWith('/journal') ? { ops: [] } : { sessions: [] })
  }, { 'dsh-context-studio:board': [{ key: 'chosen', kind: 'snippet', text: 'selected', tokens: 2 }] })
  h.api.setServices({ uiWorkspace: { startSession: async (...args) => { started.push(args) }, forkSession() { throw Error('must not fork') } }, sessions: { fork() { throw Error('must not clone') } } })
  let tree = h.render(h.api.StudioPage)
  click(tree, '准备分支草稿 · 1'); await tick(); tree = h.render(h.api.StudioPage)
  assert.equal(started.length, 0)
  const dialog = nodes(tree).find(n => n.props?.dialog?.title)?.props.dialog
  assert.equal(dialog.title, '用所选片段准备新分支')
  await dialog.onConfirm()
  assert.equal(started.length, 1)
  assert.equal(started[0][1].prompt, 'SELECTED CONTEXT')
  assert.equal(started[0][1].whenDraftExists, 'append')
  assert.equal(calls.some(url => /\/(write|archive|remove)$/.test(url)), false)
})

test('次要记录抽屉保留备份与撤销，用户确认前不写入', async () => {
  const writes = [], h = harness(async (url, opts) => {
    if (opts.method === 'POST') { writes.push(url); return json({ ok: true, text: '已撤销' }) }
    if (url.endsWith('/journal')) return json({ ops: [{ id: 'op1', label: '移除旧约定', backup: '/backup/file', canUndo: true }] })
    return json(url.endsWith('/projects') ? { projects: [] } : { sessions: [] })
  })
  h.render(h.api.StudioPage); await tick()
  let tree = h.render(h.api.StudioPage); click(tree, '操作记录'); await tick(); tree = h.render(h.api.StudioPage)
  labelled(tree, '备份与操作记录'); click(tree, '撤销'); tree = h.render(h.api.StudioPage)
  assert.equal(writes.length, 0)
  const dialog = nodes(tree).find(n => n.props?.dialog?.title)?.props.dialog
  assert.equal(dialog.title, '撤销这次操作？'); assert.match(text(dialog.body), /backup\/file/)
  await dialog.onConfirm(); assert.deepEqual(writes, ['/api/dsh-plugin-context-studio/undo'])
})
