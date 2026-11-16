import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { compose, sanitizeItems } from '../lib/compose.js'

const code = (await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  .replace('return module.exports;', 'exports.test = { Organizer, Inspector, StudioPage, Board, reportNoteItem, organizeUsage }; return module.exports;')
const all = root => !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(all) : [root, ...all(root.children), ...all(root.props?.branch)]
const text = root => JSON.stringify(root)
const json = value => ({ ok: true, json: async () => value })
const tick = () => new Promise(setImmediate)
const event = value => ({ target: { value }, preventDefault() {}, stopPropagation() {} })
function labelled(root, label) { const node = all(root).find(n => n.props?.['aria-label'] === label); assert.ok(node, label); return node }
function button(root, label) { const node = all(root).find(n => n.children?.includes(label) && typeof n.props?.onClick === 'function'); assert.ok(node, 'button: ' + label); return node }
function click(root, label) { const b = button(root, label); assert.notEqual(b.props.disabled, true, label + ' disabled'); return b.props.onClick(event()) }
function harness(fetch, saved = {}) {
  let i = 0, values = [], effects = [], jobs = [], api, timerId = 0
  const timers = new Map()
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) { const slot = i++; if (!(slot in values)) values[slot] = typeof init === 'function' ? init() : init; return [values[slot], v => { values[slot] = typeof v === 'function' ? v(values[slot]) : v }] },
    useRef(value) { const slot = i++; if (!(slot in values)) values[slot] = { current: value }; return values[slot] },
    useMemo(fn) { i++; return fn() },
    useEffect(fn, deps) { const slot = i++; if (!effects[slot] || deps.some((v, n) => v !== effects[slot].deps[n])) jobs.push(() => { effects[slot]?.cleanup?.(); effects[slot] = { deps, cleanup: fn() } }) },
  }
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load({ factory }) { api = factory(() => react).test } } }, fetch, AbortController, console,
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: k => k in saved ? JSON.stringify(saved[k]) : null, setItem(k, v) { saved[k] = JSON.parse(v) } },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
  })
  return {
    api, timers, saved,
    render(component, props = {}) { i = 0; const tree = component(props), pending = jobs; jobs = []; pending.forEach(fn => fn()); return tree },
    fire(ms) { const entry = [...timers].find(([, value]) => typeof ms === 'function' ? ms(value.ms) : value.ms === ms); assert.ok(entry, 'timer ' + ms); timers.delete(entry[0]); entry[1].fn() },
    unmount() { effects.forEach(e => e?.cleanup?.()) },
  }
}
const source = { seq: 3, label: '用户要求', module: 'requirements', status: 'active', text: '保留来源', offset: 0, end: 4, totalChars: 24, truncated: true }
const coverage = { total: 20, included: 7, clipped: 2, omitted: 11, excludedSystem: 2 }
const plan = (patch = {}) => ({ planId: 'p1', expiresAt: Date.now() + 60000, sessionId: 'S', answer: 100, provider: 'qa', model: 'offline',
  inputTokens: 1234, outputTokens: 4096, focus: '', includeSystem: false, coverage, sources: [source], system: 'SYSTEM SNAPSHOT', input: 'INPUT SNAPSHOT', ...patch })
const report = { title: '接下来的工作', overview: '先验证证据，再实施改动。', cards: [
  { id: 'g', category: 'goal', title: '目标', body: '保留项目规则。', evidence: [3] },
  { id: 'd', category: 'decision', title: '已有结论', body: '需要用户复核。', evidence: [3] },
  { id: 'e', category: 'evidence', title: '依据', body: '从原文核对。', evidence: [3] },
  { id: 'r', category: 'risk', title: '可能遗漏', body: '不能自动判定原因。', evidence: [3] },
  { id: 'n', category: 'next', title: '先验证再改动', body: '复查原始输入。', evidence: [3] },
], branch: { task: '核对约束并建立最小复现', sources: [3] }, warnings: ['部分历史未纳入，结论需核对。'] }
const job = (patch = {}) => ({ id: 'p1', sessionId: 'S', answer: 100, provider: 'qa', model: 'offline', createdAt: 1000, updatedAt: 2000, status: 'running',
  active: true, inputTokens: 1234, outputTokens: 4096, coverage, usage: null, report: null, sources: [source], costNotice: '已发生的用量不会返还。', ...patch })
function server(overrides = {}) {
  const api = { calls: [], current: job(), reports: [], nextPlan: plan(), ...overrides }
  api.fetch = async (url, options) => {
    const parsed = new URL(url, 'http://localhost'), path = parsed.pathname.split('/').pop()
    const call = { url, path, query: parsed.searchParams, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal }
    api.calls.push(call)
    if (api.handle) { const result = api.handle(call); if (result !== undefined) return await result }
    if (path === 'organize-models') return json({ available: true, providers: [{ id: 'qa', name: '离线QA', models: [{ id: 'offline', name: '固定结果' }] }], warning: '' })
    if (path === 'organize-history') return json({ jobs: api.reports })
    if (path === 'organize-preview') return json(api.nextPlan)
    if (path === 'organize-start' || path === 'organize-job') return json({ job: api.current })
    if (path === 'organize-cancel') { api.current = job({ status: 'cancelled', active: true, updatedAt: 3000 }); return json({ job: api.current }) }
    if (path === 'projects') return json({ projects: [] })
    if (path === 'journal') return json({ ops: [] })
    if (path === 'sessions') return json({ sessions: [{ id: 'S', title: '会话S' }, { id: 'B', title: '会话B' }] })
    throw Error('unexpected ' + path)
  }
  return api
}
function mount(api = server(), extra = {}) {
  const h = harness(api.fetch)
  let props = { session: { id: 'S', title: '会话S' }, refresh: 0, ...extra }
  return { api, h, render: () => h.render(h.api.Organizer, props), props: patch => { props = { ...props, ...patch } },
    async settle(n = 3) { let tree; for (let k = 0; k < n; k++) { tree = h.render(h.api.Organizer, props); await tick() } return h.render(h.api.Organizer, props) } }
}

test('默认会话整理只读模型/历史；切换回原始记录保持旧Inspector入口', async () => {
  const s = mount(); let tree = await s.settle()
  assert.deepEqual(s.api.calls.map(c => c.path), ['organize-models', 'organize-history'])
  assert.match(text(tree), /只读记录，不调用模型/)
  assert.equal(all(tree).some(n => n.props?.type === 'password'), false)
  const h = harness(s.api.fetch); h.render(h.api.StudioPage); await tick(); tree = h.render(h.api.StudioPage)
  assert.ok(all(tree).some(n => n.type === h.api.Organizer))
  click(tree, '原始记录'); tree = h.render(h.api.StudioPage)
  assert.ok(all(tree).some(n => n.type === h.api.Inspector))
  assert.equal(s.api.calls.some(c => c.path === 'organize-start'), false)
})

test('预览明确列出快照/省略/tokens/provider/model，确认按钮才启动且双击不重放', async () => {
  const s = mount(); let tree = await s.settle()
  await click(tree, '预览整理范围'); tree = s.render()
  const preview = s.api.calls.find(c => c.path === 'organize-preview')
  assert.deepEqual(preview.body, { sessionId: 'S', provider: 'qa', model: 'offline', budget: 16000, output: 4096, includeSystem: false, focus: '' })
  assert.equal('answer' in preview.body, false)
  assert.equal(s.api.calls.some(c => c.path === 'organize-start'), false)
  for (const word of ['qa / offline', '1234', '4096', '截短 2 条', '省略 11 条', '排除系统记录 2 条', 'SYSTEM SNAPSHOT', 'INPUT SNAPSHOT', '供应商并消耗 tokens'])
    assert.ok(text(tree).includes(word), word)
  const confirmation = button(tree, '确认消耗 tokens 并整理')
  await Promise.all([confirmation.props.onClick(), confirmation.props.onClick()])
  tree = await s.settle()
  const starts = s.api.calls.filter(c => c.path === 'organize-start')
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0].body, { planId: 'p1', confirmed: true })
  assert.match(text(tree), /正在整理/)
  s.h.unmount()
})

test('修改参数立即废弃旧预览；迟到预览不能重新启用确认', async () => {
  let resolvePreview
  const api = server({ handle: c => c.path === 'organize-preview' ? new Promise(resolve => { resolvePreview = resolve }) : undefined })
  const s = mount(api); let tree = await s.settle()
  const request = click(tree, '预览整理范围'); tree = s.render()
  labelled(tree, '整理重点').props.onChange(event('核对部署约定'))
  tree = s.render()
  assert.equal(api.calls.find(c => c.path === 'organize-preview').signal.aborted, true)
  resolvePreview(json(plan({ input: 'STALE PREVIEW' }))); await request; await tick()
  tree = s.render()
  assert.doesNotMatch(text(tree), /STALE PREVIEW|确认消耗 tokens 并整理/)
  api.handle = null
  api.nextPlan = plan({ focus: '核对部署约定', planId: 'p2' })
  await click(tree, '预览整理范围'); tree = s.render()
  assert.equal(api.calls.at(-1).body.focus, '核对部署约定')
  button(tree, '确认消耗 tokens 并整理')
})

test('调整范围或预览过期后，旧确认回调也不能启动', async () => {
  const s = mount(); let tree = await s.settle()
  await click(tree, '预览整理范围'); tree = s.render()
  const old = button(tree, '确认消耗 tokens 并整理')
  click(tree, '调整范围'); await old.props.onClick()
  assert.equal(s.api.calls.some(c => c.path === 'organize-start'), false)
  tree = s.render(); await click(tree, '预览整理范围'); tree = s.render()
  s.h.fire(ms => ms > 30000)
  tree = s.render()
  assert.equal(button(tree, '确认消耗 tokens 并整理').props.disabled, true)
  assert.match(text(tree), /预览已过期/)
})

test('切会话中止原预览；旧会话报告/预览不覆盖新会话，刷新只读恢复', async () => {
  let finish
  const api = server({ handle: c => c.path === 'organize-preview' ? new Promise(resolve => { finish = resolve }) : undefined })
  const s = mount(api); let tree = await s.settle()
  const pending = click(tree, '预览整理范围')
  s.props({ session: { id: 'B', title: '会话B' } }); tree = s.render()
  assert.equal(api.calls.find(c => c.path === 'organize-preview').signal.aborted, true)
  finish(json(plan({ input: 'OLD S CONTENT' }))); await pending
  tree = await s.settle()
  assert.doesNotMatch(text(tree), /OLD S CONTENT|确认消耗 tokens 并整理/)
  click(tree, '刷新已有状态'); await s.settle()
  assert.equal(api.calls.filter(c => c.path === 'organize-preview').length, 1)
  assert.equal(api.calls.some(c => c.path === 'organize-start'), false)
})

test('启动请求超时保持结果未知，自动查询/刷新/重试状态均不会再次start', async () => {
  const api = server({ handle: c => c.path === 'organize-start' ? new Promise(() => {}) : c.path === 'organize-job' ? Promise.reject(Error('job status offline')) : undefined })
  const s = mount(api); let tree = await s.settle()
  await click(tree, '预览整理范围'); tree = s.render()
  const pending = click(tree, '确认消耗 tokens 并整理')
  s.h.fire(25000); await pending
  tree = await s.settle()
  assert.match(text(tree), /启动结果未知|启动结果待确认/)
  assert.equal(api.calls.find(c => c.path === 'organize-job').query.get('id'), 'p1')
  click(tree, '查询作业状态'); tree = await s.settle()
  click(tree, '刷新已有状态'); await s.settle()
  assert.equal(api.calls.filter(c => c.path === 'organize-start').length, 1)
  assert.equal(api.calls.filter(c => c.path === 'organize-preview').length, 1)
  s.h.unmount()
})

test('状态轮询串行：慢请求未完成不叠加，终态停止；卸载不代替模型取消', async () => {
  let finish, count = 0
  const current = job(), api = server({ reports: [current], handle: c => {
    if (c.path !== 'organize-job') return
    count++
    if (count === 2) return new Promise(resolve => { finish = resolve })
    return json({ job: current })
  } })
  const s = mount(api); await s.settle()
  assert.equal([...s.h.timers.values()].filter(t => t.ms === 1000).length, 1)
  s.h.fire(1000); await tick()
  assert.equal([...s.h.timers.values()].filter(t => t.ms === 1000).length, 0)
  assert.equal(count, 2)
  finish(json({ job: job({ status: 'completed', active: false, updatedAt: 5000, report }) })); await tick()
  const tree = s.render()
  assert.match(text(tree), /整理完成|接下来的工作/)
  assert.equal([...s.h.timers.values()].filter(t => t.ms === 1000).length, 0)
  s.h.unmount()
  assert.equal(api.calls.some(c => c.path === 'organize-cancel' || c.path === 'organize-start'), false)
  assert.equal(s.h.timers.size, 0)
})

test('取消后active仍为true继续轮询和禁启动；已花费tokens不声称返还', async () => {
  const api = server({ reports: [job()] }), s = mount(api)
  let tree = await s.settle()
  await click(tree, '取消整理'); tree = await s.settle()
  assert.match(text(tree), /后台调用尚未释放|tokens 无法退回/)
  assert.equal(api.calls.filter(c => c.path === 'organize-cancel').length, 1)
  assert.equal(all(tree).some(n => n.children?.includes('预览整理范围')), false)
  api.current = job({ status: 'cancelled', active: false, updatedAt: 5000 })
  s.h.fire(1000); await tick(); tree = s.render()
  assert.equal(button(tree, '预览整理范围').props.disabled, false)
  assert.equal([...s.h.timers.values()].some(t => t.ms === 1000), false)
  assert.equal(api.calls.some(c => c.path === 'organize-start'), false)
})

test('取消返回之后迟到的running状态不复活作业', async () => {
  let oldResolve, reads = 0
  const api = server({ reports: [job()], handle: c => {
    if (c.path === 'organize-job' && ++reads === 2) return new Promise(resolve => { oldResolve = resolve })
  } })
  const s = mount(api); let tree = await s.settle()
  s.h.fire(1000); await tick()
  await click(tree, '取消整理'); tree = await s.settle()
  oldResolve(json({ job: job({ updatedAt: 2000 }) })); await tick(); tree = s.render()
  assert.match(text(tree), /已请求取消/)
  assert.doesNotMatch(text(tree), /\"strong\"[^}]*正在整理/)
  s.h.unmount()
})

test('刷新恢复完成报告与五类卡片，用量包含cache读写，读取不重新启动', async () => {
  const done = job({ status: 'completed', active: false, report, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 2, totalTokens: 37 } })
  const s = mount(server({ current: done, reports: [done] })); let tree = await s.settle()
  labelled(tree, '会话整理报告')
  const status = labelled(tree, '整理作业状态')
  assert.match(status.props.className, /compact/)
  const details = all(status).find(n => n.type === 'details')
  assert.ok(details); assert.notEqual(details.props.open, true)
  assert.match(text(details), /实际输入 27 tokens|已发生的用量不会返还/)
  assert.match(text(status), /输入 27 · 输出 10 tokens/)
  button(status, '重新整理（先预览）')
  for (const label of ['目标与约束', '已有结论', '关键证据', '待核对', '建议下一步', 'AI 整理 · 需核对']) assert.ok(text(tree).includes(label), label)
  assert.match(text(tree), /实际输入 27 tokens|缓存读取 3|写入 4|推理 2/)
  click(tree, '刷新已有状态'); tree = await s.settle()
  assert.equal(s.api.calls.some(c => c.path === 'organize-start' || c.path === 'organize-preview'), false)
  assert.equal([...s.h.timers.values()].some(t => t.ms === 1000), false)
  assert.match(text(tree), /接下来的工作/)
})

test('failed/cancelled/interrupted只显示结果与重新预览入口，不自动重做', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const terminal = job({ status, active: false, error: '测试终态', persistenceWarning: '报告保存警告' })
    const s = mount(server({ current: terminal, reports: [terminal] }))
    const tree = await s.settle()
    assert.doesNotMatch(labelled(tree, '整理作业状态').props.className, /compact/)
    assert.match(text(tree), /测试终态|报告保存警告|供应商未返回用量/)
    button(tree, '预览整理范围')
    assert.equal(s.api.calls.some(c => c.path === 'organize-start'), false)
    assert.equal([...s.h.timers.values()].some(t => t.ms === 1000), false)
  }
})

test('报告采用动作仅回调草稿，建议与原文分开；证据带job.answer跳原文', async () => {
  const received = [], done = job({ status: 'completed', active: false, report })
  const s = mount(server({ current: done, reports: [done] }), {
    onNote: (j, card) => received.push({ type: 'note', j, card }),
    onEvidence: (j, origin) => received.push({ type: 'source', j, origin }),
    onSource: (j, origin) => received.push({ type: 'jump', j, origin }),
  })
  const tree = await s.settle()
  click(tree, '加入分支草稿'); click(tree, '将建议加入分支草稿'); click(tree, '将这段原文加入草稿'); click(tree, '原文 #3')
  assert.deepEqual(received.map(x => x.type), ['note', 'note', 'source', 'jump'])
  assert.equal(received[1].card.body, report.branch.task)
  assert.equal(received[2].origin.offset, 0)
  assert.equal(received[3].j.answer, 100); assert.equal(received[3].origin.seq, 3)
  assert.equal(s.api.calls.some(c => c.body), false)
})

test('父界面建议标明AI/报告来源且去重，不覆盖task；原文采用保存真实offset，引用切回原始记录', async () => {
  const api = server(), saved = { 'dsh-context-studio:prefs': { task: '原有任务保持' } }, h = harness(api.fetch, saved)
  h.render(h.api.StudioPage); await tick(); let tree = h.render(h.api.StudioPage)
  const org = all(tree).find(n => n.type === h.api.Organizer)
  const done = job({ status: 'completed', active: false, report })
  org.props.onNote(done, report.cards[4]); org.props.onNote(done, report.cards[4])
  org.props.onNote(done, { id: 'branch', title: '推荐任务', body: report.branch.task, evidence: [3, 999] })
  org.props.onEvidence(done, { ...source, offset: 12, end: 16 })
  tree = h.render(h.api.StudioPage)
  const items = all(tree).find(n => n.type === h.api.Board).props.items
  assert.equal(items.length, 3)
  assert.match(items[0].text, /AI整理建议（待核对）/)
  assert.match(items[0].from, /报告 p1.*会话 S/)
  for (const note of items.filter(item => item.kind === 'note')) {
    const draft = compose(sanitizeItems([note]), { mode: 'prompt', task: '原有任务保持' }).text
    assert.match(draft, /AI整理建议（待核对）\n来源报告：p1\n来源会话：S/)
    assert.match(draft, /参考原文：#3/)
    assert.ok(draft.includes(note.text))
  }
  assert.deepEqual(Array.from(items[1].reportEvidence), [3])
  assert.equal(items[2].textOffset, 12); assert.equal(items[2].sourcePart, 'body')
  assert.equal(saved['dsh-context-studio:prefs'].task, '原有任务保持')
  org.props.onSource(done, source); tree = h.render(h.api.StudioPage)
  const raw = all(tree).find(n => n.type === h.api.Inspector)
  assert.equal(raw.props.initialAnswer, 100); assert.equal(raw.props.initialEvent, 3); assert.equal(raw.props.initialScope, 'active')
  assert.equal(api.calls.some(c => c.path === 'organize-start' || c.path === 'write'), false)
})

test('原始Inspector接受报告边界和seq，自动打开该原文且一次性跳转不夺走后续选择', async () => {
  const calls = [], organized = [], h = harness(async (url, opts) => {
    const q = new URL(url, 'http://localhost'); calls.push(q)
    if (url.includes('/inspect-detail')) return json({ row: { seq: 3, label: '原文', status: 'active', text: 'source', textOffset: 0, sourcePart: 'body', tokens: 2 }, text: 'source', offset: 0, previousOffset: null, nextOffset: null, totalChars: 6, part: 'body', notices: [], incomplete: false })
    return json({ sessionId: 'S', boundary: 100, answer: { seq: 100, preview: '答案' }, timeline: [], timelineInfo: { total: 1 }, summary: { available: true, active: 1 },
      flow: { comparison: { available: true, added: 1, retained: 0, removed: 0 }, scope: 'active', page: { index: 0, total: 1, pages: 1 }, nodes: [], anchors: [], edges: [], guidance: [] }, warnings: [] })
  })
  const props = { session: { id: 'S', title: 'S' }, initialAnswer: 100, initialEvent: 3, initialScope: 'active', onOrganize: (session, answer) => organized.push({ session, answer }) }
  h.render(h.api.Inspector, props); await tick()
  h.render(h.api.Inspector, props)
  h.render(h.api.Inspector, props); await tick()
  let tree = h.render(h.api.Inspector, props)
  labelled(tree, '原文详情')
  const read = calls.find(c => c.pathname.endsWith('/inspect-detail'))
  assert.equal(read.searchParams.get('answer'), '100'); assert.equal(read.searchParams.get('event'), '3')
  click(tree, '关闭原文'); tree = h.render(h.api.Inspector, props)
  assert.equal(all(tree).some(n => n.props?.['aria-label'] === '原文详情'), false)
  click(tree, '整理到这一步')
  assert.equal(organized.length, 1)
  assert.equal(organized[0].session.id, 'S'); assert.equal(organized[0].answer, 100)
})

test('从原始记录整理到所选回答，父界面绑定会话；改为最新后必须重新预览确认', async () => {
  const done = job({ status: 'completed', active: false, report })
  const api = server({ current: done, reports: [done], nextPlan: plan({ answer: 21 }) }), parent = harness(api.fetch)
  parent.render(parent.api.StudioPage); await tick(); let tree = parent.render(parent.api.StudioPage)
  click(tree, '原始记录'); tree = parent.render(parent.api.StudioPage)
  const raw = all(tree).find(n => n.type === parent.api.Inspector)
  raw.props.onOrganize(raw.props.session, 21); tree = parent.render(parent.api.StudioPage)
  let org = all(tree).find(n => n.type === parent.api.Organizer)
  assert.equal(org.props.session.id, 'S'); assert.equal(org.props.answer, 21)
  // Restoring a newer report must not hide the explicit request to prepare this earlier boundary.
  const s = mount(api, org.props); let organized = await s.settle()
  assert.match(text(labelled(organized, '整理回答边界')), /截至回答 #21/)
  await click(organized, '预览整理范围'); organized = s.render()
  assert.equal(api.calls.find(c => c.path === 'organize-preview').body.answer, 21)
  const oldConfirm = button(organized, '确认消耗 tokens 并整理')
  click(organized, '改为最新回答')
  await oldConfirm.props.onClick()
  tree = parent.render(parent.api.StudioPage)
  org = all(tree).find(n => n.type === parent.api.Organizer)
  assert.equal(org.props.answer, null); assert.equal(org.props.session.id, 'S')
  s.props(org.props); organized = await s.settle()
  assert.doesNotMatch(text(organized), /确认消耗 tokens 并整理/)
  assert.match(text(organized), /整理范围：最新回答/)
  api.nextPlan = plan({ planId: 'latest-plan' })
  await click(organized, '预览整理范围'); organized = s.render()
  assert.equal('answer' in api.calls.filter(c => c.path === 'organize-preview').at(-1).body, false)
  button(organized, '确认消耗 tokens 并整理')
  assert.equal(api.calls.some(c => c.path === 'organize-start'), false)
  raw.props.onOrganize(raw.props.session, 21); tree = parent.render(parent.api.StudioPage)
  labelled(tree, '从目录选择会话').props.onChange(event('B')); tree = parent.render(parent.api.StudioPage)
  org = all(tree).find(n => n.type === parent.api.Organizer)
  assert.equal(org.props.session.id, 'B'); assert.equal(org.props.answer, null)
  s.h.unmount(); parent.unmount()
})

test('回答边界变化取消在途预览并拒绝迟到或边界不符的Plan；旧确认不能启动', async () => {
  let resolvePreview
  const api = server({ handle: c => c.path === 'organize-preview' ? new Promise(resolve => { resolvePreview = resolve }) : undefined })
  const s = mount(api, { answer: 21 }); let tree = await s.settle()
  const pending = click(tree, '预览整理范围')
  s.props({ answer: 9 }); tree = s.render()
  assert.equal(api.calls.find(c => c.path === 'organize-preview').signal.aborted, true)
  resolvePreview(json(plan({ answer: 21, input: 'OLD BOUNDARY CONTENT' }))); await pending
  tree = await s.settle()
  assert.doesNotMatch(text(tree), /OLD BOUNDARY CONTENT|确认消耗 tokens 并整理/)
  api.handle = null; api.nextPlan = plan({ answer: 21 })
  await click(tree, '预览整理范围'); tree = s.render()
  assert.match(text(tree), /预览与当前选择不一致/)
  assert.doesNotMatch(text(tree), /确认消耗 tokens 并整理/)
  api.nextPlan = plan({ answer: 9, planId: 'earlier-plan' })
  await click(tree, '预览整理范围'); tree = s.render()
  const oldConfirm = button(tree, '确认消耗 tokens 并整理')
  s.props({ answer: 0 }); tree = await s.settle()
  await oldConfirm.props.onClick()
  api.nextPlan = plan({ answer: 0, planId: 'first-plan' })
  await click(tree, '预览整理范围'); tree = s.render()
  assert.equal(api.calls.filter(c => c.path === 'organize-preview').at(-1).body.answer, 0)
  button(tree, '确认消耗 tokens 并整理')
  assert.equal(api.calls.some(c => c.path === 'organize-start'), false)
  s.h.unmount()
})

test('无可用模型只引导宿主设置；错误来源的预览不得确认或启动', async () => {
  const noModel = mount(server({ handle: c => c.path === 'organize-models' ? json({ available: false, providers: [], warning: '请配置模型' }) : undefined }))
  let tree = await noModel.settle()
  assert.equal(button(tree, '预览整理范围').props.disabled, true)
  assert.match(text(tree), /DSH 的模型设置/)
  const wrong = mount(server({ nextPlan: plan({ sessionId: 'OTHER', input: 'OTHER SECRET' }) }))
  tree = await wrong.settle(); await click(tree, '预览整理范围'); tree = wrong.render()
  assert.match(text(tree), /预览与当前选择不一致/)
  assert.doesNotMatch(text(tree), /OTHER SECRET|确认消耗 tokens 并整理/)
  assert.equal(wrong.api.calls.some(c => c.path === 'organize-start'), false)
})
