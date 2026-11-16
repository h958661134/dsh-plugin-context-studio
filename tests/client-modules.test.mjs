import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  .replace('return module.exports;', 'exports.test = { request, Inspector, StudioPage, Board, evidenceItem }; return module.exports;')
const nodes = root => !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(nodes) : [root, ...nodes(root.children)]
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
  return {
    sessionId: 'S', boundary: 100, observedAt: 123456, answer: { seq: 100, turn: 3, step: 1, preview: '这是紧凑回答预览' },
    timeline: [1, 50, 100, 150, 200].map((seq, i) => ({ seq, index: i + 1, preview: '回答预览 ' + seq, turn: i + 1, step: 1 })),
    timelineInfo: { total: 500, start: 0, shown: 5, previousSeq: 50, nextSeq: 150, firstSeq: 1, lastSeq: 200, earlierWindowSeq: 10, laterWindowSeq: 190 },
    modules: ids.map(id => ({ id, label: id, active: id === 'other' ? 0 : 3, replaced: id === 'other' ? 0 : 1, unknown: 0, issues: id === 'tools' ? 1 : 0 })),
    summary: { active: 21, replaced: 7, unknown: 0, added: 2, available: true },
    page: { module: 'requirements', state: 'active', index: 0, size: 16, total: 2300, pages: 144, items: [record()] },
    warnings: [], partial: false, limitation: '这些是日志记录，不能证明模型为何给出此答案。', ...extra,
  }
}
function detail(extra = {}) {
  return { row: { ...record(), changes: [], refs: [], sourceEventSeqs: [], text: '甲乙甲乙', textOffset: 0, sourcePart: 'body', tokens: 3, clipped: true },
    text: '甲乙甲乙', offset: 0, nextOffset: 12000, previousOffset: null, totalChars: 24004,
    part: 'body', hasArguments: true, argumentsPreview: '{"path":', incomplete: false, notices: [], ...extra }
}
const baseProps = { session: { id: 'S', title: '测试会话', workspaceId: 'work' }, refresh: 0, has: () => false }
function mounted(fetch, props = {}) {
  const h = harness(fetch)
  let active = { ...baseProps, ...props }
  return { h, render: () => h.render(h.api.Inspector, active), props: patch => { active = { ...active, ...patch } } }
}
const route = url => new URL(url, 'http://localhost')

test('初始仅请求元信息，八类模块可达，回答预览紧凑且不将输入位置标成内容有效', async () => {
  const calls = [], s = mounted(async url => { calls.push(url); return json(view()) })
  s.render(); await tick()
  const tree = s.render()
  assert.equal(calls.length, 1)
  assert.match(calls[0], /\/inspect-view\?/)
  assert.equal(calls.some(u => u.includes('/inspect-detail') || u.includes('/inspect?')), false)
  for (const label of ['用户要求', '项目约定', '引用会话', '工具结果', '历史回答', '技能', '系统与环境', '其他上下文'])
    labelled(tree, '查看' + label)
  assert.equal(nodes(tree).filter(n => n.type === 'textarea').length, 0)
  assert.match(text(tree), /紧凑回答预览|搜索标题或预览（非全文）|在输入中/)
  assert.doesNotMatch(text(tree), /当时有效|条有效|有效上下文|部分记录|额外限制/)
  const background = nodes(tree).find(n => n.props?.className === 'csx-background-modules')
  assert.equal(background.type, 'details')
  assert.equal(background.props.open, false)
})

test('点击模块收拢目录，并将焦点与视口移至记录，页码和原文选择重置', async () => {
  const calls = [], s = mounted(async url => { calls.push(route(url)); return json(view()) })
  s.render(); await tick()
  let tree = s.render(), focused = 0, scrolled = 0
  labelled(tree, '模块内记录').props.ref.current = { focus() { focused++ }, scrollIntoView() { scrolled++ } }
  labelled(tree, '查看工具结果').props.onClick()
  tree = s.render()
  assert.match(text(tree), /已选择 · 工具结果/)
  assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '上下文模块'), false)
  assert.equal(focused, 1); assert.equal(scrolled, 1)
  assert.equal(calls.at(-1).searchParams.get('module'), 'tools')
  assert.equal(calls.at(-1).searchParams.get('answer'), '100')
  assert.equal(calls.at(-1).searchParams.get('page'), '0')
  click(tree, '更换模块')
  tree = s.render()
  labelled(tree, '查看项目约定')
})

test('无记录模块弱化且默认收起，不抢占有内容模块空间', async () => {
  const v = view()
  v.modules = v.modules.map(m => ({ ...m, active: m.id === 'requirements' ? 1 : 0, replaced: 0, unknown: 0 }))
  const s = mounted(async () => json(v)); s.render(); await tick()
  const tree = s.render(), empty = nodes(tree).find(n => n.props?.className === 'csx-empty-modules')
  assert.equal(empty.type, 'details')
  assert.notEqual(empty.props.open, true)
  assert.equal(nodes(empty).filter(n => n.props?.className?.includes('csx-module-card')).length, 5)
  assert.match(labelled(tree, '查看技能').props.className, /empty/)
})

test('模块和状态切换立即取消请求；晚到数据不覆盖新状态也不闪旧记录', async () => {
  const jobs = [], s = mounted((url, opts) => new Promise(resolve => jobs.push({ url: route(url), opts, resolve })))
  s.render(); jobs[0].resolve(json(view())); await tick()
  let tree = s.render()
  labelled(tree, '查看工具结果').props.onClick(); tree = s.render()
  assert.doesNotMatch(text(tree), /先核对项目需求再执行/)
  const old = jobs.at(-1)
  const stateButton = nodes(tree).find(n => n.type === 'button' && n.children[0] === '已被替换 · 7')
  stateButton.props.onClick(); s.render()
  assert.equal(old.opts.signal.aborted, true)
  const latest = jobs.at(-1)
  assert.equal(latest.url.searchParams.get('state'), 'replaced')
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
  for (const [label, expected] of [['← 上一回答', 50], ['下一回答 →', 150], ['最早回答', 1], ['最新回答', 200], ['更早一组', 10], ['更晚一组', 190]]) {
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
  assert.match(text(tree), /500 次模型输出|2300 条/)
  assert.doesNotMatch(text(tree), /检查有额外限制|记录缺失/)
  click(tree, '下一页记录'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.get('page'), '1')
  labelled(tree, '搜索当前模块的标题或预览').props.onChange(event('路径 & 纠正'))
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
  assert.match(text(tree), /上下文目录暂不可用|数量未知/)
  assert.equal(nodes(tree).some(n => n.props?.['aria-label'] === '上下文模块'), false)
  assert.doesNotMatch(text(tree), /0 条在输入中|没有记录。/)
  button(tree, '查看回答原文')
  click(tree, '最早回答'); s.render()
  assert.equal(calls.at(-1).searchParams.get('answer'), '1')
})

test('没有assistant但已有user消息时，切模块及原文请求均省略answer', async () => {
  const calls = [], empty = view({ answer: null, boundary: 7, timeline: [], timelineInfo: { total: 0 } })
  const s = mounted(async url => { const u = route(url); calls.push(u); return json(u.pathname.endsWith('/inspect-detail') ? detail() : empty) })
  s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /还没有模型回答/)
  labelled(tree, '查看项目约定').props.onClick(); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.has('answer'), false)
  click(tree, '查看原文 / 挑选'); s.render(); await tick(); tree = s.render()
  assert.ok(calls.at(-1).pathname.endsWith('/inspect-detail'))
  assert.equal(calls.at(-1).searchParams.has('answer'), false)
  assert.equal(calls.at(-1).searchParams.get('event'), '3')
  assert.equal(labelled(tree, '历史上下文原文，可选择文字').props.value, '甲乙甲乙')
})

test('原文跨页及正文/参数选择保留绝对偏移；相同文字的第二次出现不会误指向第一次', async () => {
  const calls = [], added = []
  const s = mounted(async url => {
    const u = route(url); calls.push(u)
    if (u.pathname.endsWith('/inspect-view')) return json(view())
    const offset = Number(u.searchParams.get('offset')), part = u.searchParams.get('part')
    return json(detail({ offset, part, previousOffset: offset ? 0 : null, nextOffset: offset ? null : 12000 }))
  }, { onAdd(session, row, chosen) { added.push({ session, row, text: chosen }) } })
  s.render(); await tick()
  click(s.render(), '查看原文 / 挑选'); s.render(); await tick()
  let tree = s.render()
  labelled(tree, '历史上下文原文，可选择文字').props.onSelect({ target: { selectionStart: 2, selectionEnd: 4 } })
  tree = s.render(); click(tree, '只加入选中文字')
  assert.equal(added[0].text, '甲乙')
  assert.equal(added[0].row.selectionStart, 2)
  assert.equal(added[0].row.textOffset, 0)
  click(tree, '下一页原文'); s.render(); await tick(); tree = s.render()
  assert.equal(button(tree, '只加入选中文字').props.disabled, true)
  assert.equal(calls.at(-1).searchParams.get('offset'), '12000')
  click(tree, '将本页加入草稿')
  assert.equal(added[1].row.textOffset, 12000); assert.equal(added[1].row.sourcePart, 'body')
  click(tree, '调用参数'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.at(-1).searchParams.get('offset'), '0')
  assert.equal(calls.at(-1).searchParams.get('part'), 'arguments')
  click(tree, '将本页加入草稿')
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
    if (u.pathname.endsWith('/inspect-view')) return Promise.resolve(json(view()))
    return new Promise(resolve => jobs.push({ u, opts, resolve }))
  })
  s.render(); await tick(); click(s.render(), '查看原文 / 挑选'); s.render()
  jobs[0].resolve(json(detail())); await tick()
  let tree = s.render(); click(tree, '下一页原文'); s.render()
  const slow = jobs[1]
  // Switching a module/state aborts the slow next page and hides the old selection immediately.
  tree = s.render()
  nodes(tree).find(n => n.type === 'button' && n.children[0] === '位置未知 · 0').props.onClick()
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
    if (u.pathname.endsWith('/inspect-view')) return json(view())
    if (pendingPage) return new Promise(() => {})
    if (detailFails) throw Error('detail offline')
    return json(detail())
  })
  s.render(); await tick(); click(s.render(), '查看原文 / 挑选'); s.render(); await tick()
  let tree = s.render()
  assert.match(text(tree), /detail offline/)
  labelled(tree, '回答导航'); labelled(tree, '模块内记录')
  detailFails = false; click(tree, '重试原文'); s.render(); await tick(); tree = s.render()
  assert.equal(calls.filter(c => c.u.pathname.endsWith('/inspect-view')).length, 1)
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
    const v = view(); v.page.index = Number(u.searchParams.get('page') || 0)
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
  click(s.render(), '查看原文 / 挑选'); s.render()
  const oldDetail = jobs[1]
  s.props({ session: { id: 'NEXT', title: '下一个会话' } })
  let tree = s.render()
  assert.equal(oldDetail.opts.signal.aborted, true)
  assert.doesNotMatch(text(tree), /这是紧凑回答预览|项目交付要求/)
  jobs.at(-1).resolve(json(view({ sessionId: 'NEXT' }))); await tick()
  oldDetail.resolve(json(detail({ text: 'FROM OLD SESSION' }))); await tick()
  tree = s.render()
  assert.doesNotMatch(text(tree), /FROM OLD SESSION/)
  assert.match(text(tree), /下一个会话/)
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
  const controller = new AbortController(), promise = h.api.request('/inspect-view?id=S', undefined, controller.signal)
  const rejection = assert.rejects(promise, error => error.name === 'AbortError')
  await tick(); controller.abort()
  await rejection
  assert.equal(h.timers.size, 0)
})

test('键盘Escape关闭非模态原文抽屉，保持安全确认对话框独立', async () => {
  const s = mounted(async url => json(url.includes('/inspect-detail') ? detail() : view()))
  s.render(); await tick(); click(s.render(), '查看原文 / 挑选'); s.render(); await tick()
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
  assert.equal(nodes(tree).some(n => n.props?.className === 'csx-row csx-answer-jumps'), false)
  button(tree, '最早回答'); button(tree, '最新回答')
  click(tree, '← 上一回答'); s.render()
  assert.equal(calls.at(-1).searchParams.get('answer'), '0')
})

test('真实分页模块契约：无回答的长user消息可切模块、翻到尾页并摘录准确来源', async () => {
  const { indexContext, contextView, contextDetail } = await import('../lib/context-view.js')
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
      : contextView(index, { module: p.get('module') || undefined, state: p.get('state'), page: Number(p.get('page')) }))
    })()
    pending.push(work)
    return work
  }, { onAdd(session, row, chosen) { added.push({ session, row, text: chosen }) } })
  async function settle() { await pending.at(-1); await tick() }
  s.render(); await settle()
  labelled(s.render(), '查看用户要求').props.onClick(); s.render(); await settle()
  click(s.render(), '查看原文 / 挑选'); s.render(); await settle()
  click(s.render(), '下一页原文'); s.render(); await settle()
  const tree = s.render()
  assert.equal(labelled(tree, '历史上下文原文，可选择文字').props.value, '尾页原文')
  assert.doesNotMatch(text(tree), /这条原文包含缺失|容量上限/)
  click(tree, '将本页加入草稿')
  assert.equal(added[0].text, '尾页原文'); assert.equal(added[0].row.textOffset, 12000)
  assert.equal(added[0].row.sourcePart, 'body')
  assert.equal(calls.some(u => u.searchParams.has('answer')), false)
})

test('只读tool-call来源详情使用来源记录标签，不冒充回答输入', async () => {
  const data = detail(); data.row = { ...data.row, seq: 34, status: 'source' }
  const s = mounted(async url => json(url.includes('/inspect-detail') ? data : view()))
  s.render(); await tick(); click(s.render(), '查看原文 / 挑选'); s.render(); await tick()
  const tree = labelled(s.render(), '原文详情')
  assert.match(text(tree), /事件 #34 · 来源记录/)
  assert.doesNotMatch(text(tree), /回答前的记录/)
})
