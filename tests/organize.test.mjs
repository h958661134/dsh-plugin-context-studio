import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createOrganizer } from '../lib/organize-jobs.js'
import { organizeOptions, organizeSnapshot, organizeReport, organizeStream, organizeUsage } from '../lib/organize.js'
import { estimateTokens } from '../lib/tokens.js'
import { atomicWrite } from '../lib/ops.js'
import { createHandlers, resolveConfig } from '../lib/host.js'

const user = (seq, body, kind = 'user') => ({ seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind }, content: [{ type: 'text', text: body }] } })
const answer = (seq, body) => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: body }] } } })
const log = { session: { id: 's' }, events: [user(0, '先核对证据，不发布'), user(1, '周五不发版', 'agent-instructions'), answer(2, '需要先核对发布时间')] }
const options = organizeOptions({ sessionId: 's', provider: 'test', model: 'demo' })
const report = JSON.stringify({ title: '发布核对', overview: '目前需要核对发布条件。', cards: [{ category: 'goal', title: '明确边界', body: '用户要求先核对，不执行发布。', evidence: [0] }], branch: { task: '列出发布前需要确认的事项，不执行发布。', sources: [0, 1] } })
function fake(stream) {
  const calls = { prepare: [], stream: [] }
  const llm = {
    listProviders: () => [{ id: 'test', name: '测试模型', opaque: 'HIDDEN' }],
    listModels: async () => [{ id: 'demo', name: '演示', private: 'HIDDEN' }],
    async prepareCall(config, signal) {
      calls.prepare.push({ config, signal })
      return { config, stream(request) { calls.stream.push(request); return stream ? stream(request) : (async function* () {
        yield { type: 'reasoning-delta', index: 99, text: 'HIDDEN' }
        yield { type: 'text-delta', index: 0, text: report.slice(0, 40) }
        yield { type: 'text-delta', index: 0, text: report.slice(40) }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: report } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, totalTokens: 350, credential: 'HIDDEN' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })() } }
    },
  }
  return { llm, calls }
}
async function fixture(extra = {}, stream) {
  const dataDir = await mkdtemp(join(tmpdir(), 'csx-organize-')), model = fake(stream)
  const deps = { dataDir, getQuery: () => ({ readSession: async () => log }), getLlm: () => model.llm, ...extra }
  return { ...model, dataDir, deps, organizer: createOrganizer(deps) }
}
async function settled(organizer, plan, status = 'completed') {
  for (let i = 0; i < 150; i++) {
    const { job } = await organizer.get({ id: plan.planId, sessionId: 's' })
    if (job.status !== 'running') { assert.equal(job.status, status, job.error); return job }
    await delay(5)
  }
  assert.fail('job did not finish')
}

test('整理快照保留原文来源和状态，排除未来、隐藏推理及默认系统消息', async () => {
  const history = structuredClone(log)
  history.events[2].data.message.content.push({ type: 'reasoning', text: 'PRIVATE_REASONING' })
  history.events.push(user(3, 'system-only', 'runtime-context'), user(4, 'FUTURE'), answer(5, 'later'))
  const plan = await organizeSnapshot(history, { ...options, answer: 2 })
  assert.deepEqual(plan.sources.map(x => x.seq), [0, 1, 2])
  assert.equal(plan.answer, 2)
  assert.equal(plan.inputTokens, estimateTokens(plan.system + plan.input))
  assert.equal(plan.input.includes('FUTURE'), false); assert.equal(plan.input.includes('PRIVATE_REASONING'), false)
  const latest = await organizeSnapshot(history, options)
  assert.equal(latest.coverage.excludedSystem, 1)
  assert.equal(latest.input.includes('system-only'), false)
  const withSystem = await organizeSnapshot(history, { ...options, includeSystem: true })
  assert.ok(withSystem.input.includes('system-only'))
})

test('超长材料的预算和省略公开，确认的是完整可预览的发送JSON', async () => {
  const events = Array.from({ length: 140 }, (_, i) => user(i, '约束'.repeat(6000)))
  events.push(answer(140, '当前结论'))
  const plan = await organizeSnapshot({ session: { id: 's' }, events }, { ...options, budget: 8000 })
  assert.ok(plan.inputTokens <= 8000)
  assert.ok(plan.coverage.omitted > 0 && plan.coverage.clipped > 0)
  assert.ok(plan.sources.some(s => s.seq === 140))
  assert.deepEqual(JSON.parse(plan.input).records, plan.sources)
  assert.deepEqual(JSON.parse(plan.input).coverage, plan.coverage)
  for (const s of plan.sources) { assert.equal(s.end - s.offset, s.text.length); assert.ok(s.end <= s.totalChars) }
})

test('确认前只有目录与预览，不准备或派发模型，也不写报告', async () => {
  const f = await fixture()
  const models = await f.organizer.models()
  const plan = await f.organizer.preview(options)
  assert.equal(JSON.stringify(models).includes('HIDDEN'), false)
  assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.stream.length, 0)
  assert.deepEqual(await f.organizer.history('s'), { jobs: [] })
  await assert.rejects(f.organizer.start({ planId: plan.planId }), /确认/)
  assert.equal(f.calls.prepare.length, 0)
})

test('Cordis 每次读取的代理不同仍可预览，真正更换实现才失效', async () => {
  const f = await fixture()
  let underlying = f.llm
  const getLlm = () => new Proxy(underlying, { get(target, key) { return key === Symbol.for('cordis.original') ? target : Reflect.get(target, key) } })
  const organizer = createOrganizer({ ...f.deps, getLlm })
  const plan = await organizer.preview(options)
  await organizer.models()
  await organizer.start({ planId: plan.planId, confirmed: true })
  await settled(organizer, plan)
  assert.equal(f.calls.prepare.length, 1)
  const old = await organizer.preview(options)
  underlying = { ...f.llm }
  await assert.rejects(organizer.start({ planId: old.planId, confirmed: true }), /服务已改变/)
  assert.equal(f.calls.prepare.length, 1)
})

test('保存结束前不公布终态，轮询能获得首次保存失败提示', async () => {
  let release, entered
  const gate = new Promise(resolve => { release = resolve })
  const saving = new Promise(resolve => { entered = resolve })
  const f = await fixture({ async write(path, body, opts) {
    if (opts?.exclusive) return atomicWrite(path, body, opts)
    entered(); await gate; throw new Error('disk full')
  } })
  const plan = await f.organizer.preview(options)
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  await saving
  assert.equal((await f.organizer.get({ id: plan.planId, sessionId: 's' })).job.status, 'running')
  release()
  const job = await settled(f.organizer, plan)
  assert.match(job.persistenceWarning, /尚未保存/)
  assert.ok(job.report)
})

test('正常流只消费一次，最终块不重复，缓存用量不丢失，报告单独持久化', async () => {
  const f = await fixture(), plan = await f.organizer.preview(options)
  await f.organizer.start({ planId: plan.planId, confirmed: true })
  const job = await settled(f.organizer, plan)
  assert.equal(f.calls.prepare.length, 1); assert.equal(f.calls.stream.length, 1)
  const request = f.calls.stream[0]
  assert.deepEqual(request.tools, [])
  assert.equal(request.sessionId, undefined)
  assert.equal(request.messages[0].content[0].text, plan.input)
  assert.equal(request.system, plan.system)
  assert.equal(request.maxTokens, plan.outputTokens)
  assert.deepEqual(job.usage, { inputTokens: 100, outputTokens: 200, cacheReadTokens: 50, totalTokens: 350 })
  assert.equal(job.report.cards[0].body, JSON.parse(report).cards[0].body)
  assert.equal(JSON.stringify(job).includes('HIDDEN'), false)
  await delay(25)
  const saved = JSON.parse(await readFile(join(f.dataDir, 'organize', plan.planId.split('.')[0], `${plan.planId}.json`), 'utf8'))
  assert.equal(saved.status, 'completed')
  const reopened = createOrganizer(f.deps)
  assert.equal((await reopened.get({ id: plan.planId, sessionId: 's' })).job.report.title, '发布核对')
  assert.equal(f.calls.stream.length, 1)
})

test('请求快照不会被预览返回值或随后历史修改改变', async () => {
  const f = await fixture(), plan = await f.organizer.preview(options), original = plan.input
  plan.input = 'tampered'; plan.sources[0].text = 'tampered'
  await f.organizer.start({ planId: plan.planId, confirmed: true }); await settled(f.organizer, plan)
  assert.equal(f.calls.stream[0].messages[0].content[0].text, original)
})

test('调用收据必须先持久化，失败时零prepare/stream', async () => {
  const f = await fixture({ write: async () => { throw Error('disk unavailable') } })
  const plan = await f.organizer.preview(options)
  await assert.rejects(f.organizer.start({ planId: plan.planId, confirmed: true }), /尚未调用模型/)
  assert.equal(f.calls.prepare.length, 0)
  const good = await fixture()
  const original = good.llm.prepareCall
  good.llm.prepareCall = async (...args) => {
    const rows = await good.organizer.history('s')
    assert.equal(rows.jobs[0].status, 'running')
    return original(...args)
  }
  const p = await good.organizer.preview(options)
  await good.organizer.start({ planId: p.planId, confirmed: true }); await settled(good.organizer, p)
})

test('供应商错误包括status也不能透传连接信息；失败保留已返回usage', async () => {
  const f = await fixture({}, () => (async function* () {
    yield { type: 'usage', usage: { inputTokens: 15, outputTokens: 1 } }
    throw Object.assign(Error('secret-api-key-header'), { status: 401 })
  })())
  const p = await f.organizer.preview(options)
  await f.organizer.start({ planId: p.planId, confirmed: true })
  const job = await settled(f.organizer, p, 'failed')
  assert.equal(job.usage.inputTokens, 15)
  assert.equal(JSON.stringify(job).includes('secret-api-key-header'), false)
  await f.organizer.start({ planId: p.planId, confirmed: true })
  assert.equal(f.calls.stream.length, 1)
})

test('宿主更改已确认配置时拒绝派发，不静默放宽输出预算', async () => {
  const f = await fixture()
  f.llm.prepareCall = async config => ({ config: { ...config, maxTokens: 99999 }, stream() { assert.fail('must not stream') } })
  const p = await f.organizer.preview(options)
  await f.organizer.start({ planId: p.planId, confirmed: true })
  assert.match((await settled(f.organizer, p, 'failed')).error, /调整了/)
})

test('终态写盘失败仍能读取内存结果且同计划绝不重发', async () => {
  let writes = 0
  const f = await fixture({ write: async (...args) => { if (++writes > 1) throw Error('disk-full'); return atomicWrite(...args) } })
  const p = await f.organizer.preview(options)
  await f.organizer.start({ planId: p.planId, confirmed: true }); await settled(f.organizer, p)
  await delay(10)
  const job = (await f.organizer.get({ id: p.planId, sessionId: 's' })).job
  assert.match(job.persistenceWarning, /尚未保存/)
  await f.organizer.start({ planId: p.planId, confirmed: true })
  assert.equal(f.calls.stream.length, 1)
  const recovered = createOrganizer(f.deps)
  assert.equal((await recovered.start({ planId: p.planId, confirmed: true })).job.status, 'interrupted')
  assert.equal(f.calls.stream.length, 1)
})

test('非stop结束和结束后额外chunk不作为成功简报，reasoning不返回', async () => {
  for (const kind of ['max-tokens', 'error', 'aborted', 'tool-calls', undefined]) {
    await assert.rejects(organizeStream((async function* () { yield { type: 'text-delta', index: 0, text: report }; if (kind) yield { type: 'finish', reason: { kind } } })(), new AbortController().signal, () => {}))
  }
  await assert.rejects(organizeStream((async function* () {
    yield { type: 'finish', reason: { kind: 'error' } }; yield { type: 'finish', reason: { kind: 'stop' } }
  })(), new AbortController().signal, () => {}), /结束后/)
})

test('异常报告格式拒绝；伪造引用移除并警告，只返回白名单', () => {
  const bad = JSON.parse(report); bad.cards[0].evidence = [0, 999, '1']; bad.secret = 'HIDDEN'; bad.branch.sources = [1, -3]
  const clean = organizeReport(JSON.stringify(bad), [{ seq: 0 }, { seq: 1 }])
  assert.deepEqual(clean.cards[0].evidence, [0]); assert.deepEqual(clean.branch.sources, [1])
  assert.ok(clean.warnings.length > 0); assert.equal(JSON.stringify(clean).includes('HIDDEN'), false)
  for (const raw of ['text', '{}', '{"cards":[],"overview":"a"}', 'null']) assert.throws(() => organizeReport(raw, []))
  assert.equal(organizeUsage({ inputTokens: '10', outputTokens: 1 }), null)
  assert.deepEqual(organizeUsage({ inputTokens: 10, outputTokens: 1, totalTokens: -1, secret: 8 }), { inputTokens: 10, outputTokens: 1 })
})

test('预算、输出、模型白名单和原文边界非法均不启动生成', async () => {
  for (const bad of [{ budget: 999999 }, { output: 100000 }, { answer: -1 }, { includeSystem: 'yes' }, { focus: 'x'.repeat(1001) }]) assert.throws(() => organizeOptions({ ...options, ...bad }))
  const f = await fixture()
  await assert.rejects(f.organizer.preview({ ...options, provider: 'fake' }), /可用模型/)
  await assert.rejects(f.organizer.preview({ ...options, answer: 999 }), /回答不存在/)
  assert.equal(f.calls.prepare.length, 0)
})

test('Host提供完整整理接口且默认缺模型时安全降级', async () => {
  const f = await fixture()
  const handlers = createHandlers({ config: resolveConfig({ dataDir: f.dataDir }), getRegistry: () => null, getQuery: f.deps.getQuery, getLlm: f.deps.getLlm })
  assert.equal((await handlers.get['organize-models']()).available, true)
  const p = await handlers.post['organize-preview']({ body: options })
  await assert.rejects(handlers.post['organize-start']({ body: { planId: p.planId } }), /确认/)
  assert.equal(f.calls.prepare.length, 0)
  const noModel = createHandlers({ config: resolveConfig({ dataDir: f.dataDir }), getRegistry: () => null, getQuery: f.deps.getQuery })
  assert.equal((await noModel.get['organize-models']()).available, false)
})
