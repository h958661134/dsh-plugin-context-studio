// @ts-check
/** Explicit opt-in auxiliary calls with durable, single-use dispatch receipts. */
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from './ops.js'
import { boundedReads, serviceIdentity } from './reads.js'
import { ORGANIZE_LIMITS, hashText, organizeOptions, organizeSnapshot, organizeReport, organizeStream } from './organize.js'

const fail = (message, status = 400) => Object.assign(new Error(message), { status, contextStudioSafe: true })
const idPattern = /^[a-f0-9]{32}\.\d{13}\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const sessionKey = id => {
  if (typeof id !== 'string' || !id || id.length > 200) throw fail('会话编号无效')
  return hashText(id).slice(0, 32)
}
const costNotice = '调用可能产生费用；输入量为估算，已消耗的token无法撤销。插件不自动重试。'

export function createOrganizer({ dataDir, getQuery, getLlm, now = Date.now, timeoutMs = 180000, write = atomicWrite }) {
  const root = join(dataDir, 'organize'), plans = new Map(), recent = new Map(), settling = new Set()
  const reads = boundedReads({ timeoutMs: 12000, maxPending: 3 })
  let owner, catalogCache, modelVersion = 0, active = null, startTail = Promise.resolve(), disposed = false
  const directory = sessionId => join(root, sessionKey(sessionId))
  const pathFor = id => {
    if (typeof id !== 'string' || !idPattern.test(id)) throw fail('整理编号无效')
    return join(root, id.split('.')[0], `${id}.json`)
  }
  const publicJob = job => ({ id: job.id, sessionId: job.sessionId, answer: job.answer, provider: job.provider, model: job.model,
    createdAt: job.createdAt, updatedAt: job.updatedAt, status: settling.has(job.id) ? 'running' : job.status, active: active?.id === job.id,
    inputTokens: job.inputTokens, outputTokens: job.outputTokens, coverage: job.coverage,
    usage: job.usage || null, report: job.report || null, sources: job.sources || [],
    ...(job.error ? { error: job.error } : {}), ...(job.persistenceWarning ? { persistenceWarning: job.persistenceWarning } : {}), costNotice })
  const remember = job => {
    recent.delete(job.id); recent.set(job.id, job)
    while (recent.size > 8) {
      const key = [...recent.keys()].find(k => k !== active?.id)
      if (!key) break
      recent.delete(key)
    }
  }
  async function readJob(id) {
    if (recent.has(id)) return recent.get(id)
    const path = pathFor(id)
    let raw
    try {
      if ((await fs.stat(path)).size > 1200000) throw fail('整理记录过大，未读取；请保留文件排查', 422)
      raw = await fs.readFile(path, 'utf8')
    } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    let job
    try { job = JSON.parse(raw) } catch { throw fail('整理记录格式损坏，已保留原文件，未重试模型', 422) }
    if (job?.version !== 1 || job.id !== id || sessionKey(job.sessionId) !== id.split('.')[0] || !Array.isArray(job.sources) || !['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) throw fail('整理记录格式不支持，已保留，未重试模型', 422)
    if (job.status === 'running') {
      job = { ...job, status: 'interrupted', error: '宿主重启或此调用不在当前实例中，最终结果和费用可能未知；不会自动再次调用。' }
    }
    remember(job)
    return job
  }
  async function save(job) {
    job.updatedAt = now()
    try { await write(pathFor(job.id), JSON.stringify(job)); delete job.persistenceWarning }
    catch { job.persistenceWarning = '结果尚未保存到磁盘，请先复制简报；不要通过重新生成来重试保存。'; }
  }
  async function models() {
    const llm = getLlm()
    if (serviceIdentity(llm) !== owner) { owner = serviceIdentity(llm); catalogCache = null; modelVersion++ }
    if (!llm || typeof llm.prepareCall !== 'function' || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return { available: false, providers: [], warning: '宿主未提供兼容的模型服务，请检查 DSH 模型配置和版本。' }
    if (catalogCache && catalogCache.until > now()) return catalogCache.data
    return reads(`models:${modelVersion}`, async () => {
      const providers = []
      let items
      try { items = llm.listProviders() } catch { throw fail('模型目录读取失败，请检查 DSH 模型设置', 503) }
      if (!Array.isArray(items)) throw fail('宿主模型目录格式不可用', 503)
      let incomplete = items.length > 16
      for (const item of items.slice(0, 16)) {
        if (typeof item?.id !== 'string' || !item.id || item.id.length > 200) continue
        try {
          const values = await llm.listModels(item.id)
          const models = Array.isArray(values) ? values.slice(0, 200).filter(m => typeof m?.id === 'string' && m.id && m.id.length <= 200).map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name.slice(0, 150) : m.id })) : []
          if (models.length) providers.push({ id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 100) : item.id, models })
          if (Array.isArray(values) && values.length > 200) incomplete = true
        } catch { incomplete = true }
      }
      const data = { available: providers.length > 0, providers, warning: !providers.length ? '没有可用模型，请先在 DSH 中配置模型。插件不收集 API key。' : incomplete ? '部分模型目录未读取或超出展示范围。' : '' }
      if (serviceIdentity(getLlm()) !== serviceIdentity(llm)) throw fail('模型服务已改变，请重新读取目录', 409)
      catalogCache = { until: now() + 30000, data }
      return data
    })
  }
  async function preview(raw) {
    if (disposed) throw fail('插件已停止，请刷新后重试', 503)
    const options = organizeOptions(raw), llm = getLlm(), catalog = await models()
    if (!catalog.providers.some(p => p.id === options.provider && p.models.some(m => m.id === options.model))) throw fail('请选择当前目录中的可用模型', 400)
    const query = getQuery()
    if (typeof query?.readSession !== 'function') throw fail('宿主会话读取服务不可用', 503)
    const log = await reads(`session:${options.sessionId}`, () => query.readSession(options.sessionId))
    const plan = await organizeSnapshot(log, options)
    if (disposed || serviceIdentity(getLlm()) !== serviceIdentity(llm)) throw fail('模型服务已改变，请重新预览', 409)
    const planId = `${sessionKey(options.sessionId)}.${String(now()).padStart(13, '0')}.${randomUUID()}`
    const result = { ...plan, planId, expiresAt: now() + ORGANIZE_LIMITS.planMs }
    for (const [key, value] of plans) if (value.public.expiresAt < now()) plans.delete(key)
    plans.set(planId, { public: result, owner: llm })
    while (plans.size > ORGANIZE_LIMITS.plans) plans.delete(plans.keys().next().value)
    // Do not hand the caller a mutable reference to the approved request snapshot.
    return structuredClone(result)
  }
  async function execute(plan, job, control) {
    settling.add(job.id)
    let rejectAbort
    const aborted = new Promise((_, reject) => { rejectAbort = reject })
    const stop = () => rejectAbort(fail(control.reason || '已请求取消整理；已产生的token无法撤销', 409))
    control.controller.signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => { control.reason = '整理超过等待时限，已请求停止；费用可能已经产生。'; control.controller.abort() }, timeoutMs)
    timer.unref?.()
    const work = (async () => {
      const signal = control.controller.signal
      signal.throwIfAborted()
      const prepared = await control.llm.prepareCall({ provider: plan.provider, model: plan.model, maxTokens: plan.outputTokens }, signal)
      signal.throwIfAborted()
      if (prepared.config?.maxTokens !== plan.outputTokens || prepared.config?.provider !== plan.provider || prepared.config?.model !== plan.model) throw fail('宿主调整了已确认的模型或输出上限，请重新检查配置后预览', 409)
      if (prepared.context?.contextWindow && plan.inputTokens + plan.outputTokens > prepared.context.contextWindow) throw fail('预计输入与输出超过模型上下文容量，请降低输入预算', 400)
      const output = await organizeStream(prepared.stream({ ...prepared.config, system: plan.system,
        messages: [{ role: 'user', content: [{ type: 'text', text: plan.input }] }], tools: [], purpose: 'context-studio-organize', signal }), signal, usage => { job.usage = usage })
      return organizeReport(output, plan.sources)
    })()
    // A provider ignoring abort continues to occupy the single dispatch slot.
    work.then(() => { if (active === control) active = null }, () => { if (active === control) active = null })
    try {
      job.report = await Promise.race([work, aborted])
      job.status = 'completed'
    } catch (e) {
      const cancelled = control.controller.signal.aborted
      job.status = cancelled ? 'cancelled' : 'failed'
      job.error = cancelled ? control.reason || '已请求取消整理，已消耗token无法撤销。' : e?.contextStudioSafe === true ? e.message : '模型整理失败，请检查 DSH 模型设置；为避免泄露连接信息，未展示供应商原始错误。未自动重试，可能已产生用量。'
      control.controller.abort()
    } finally {
      clearTimeout(timer); control.controller.signal.removeEventListener('abort', stop)
      await save(job)
      settling.delete(job.id)
    }
  }
  function start(body) {
    const run = startTail.then(async () => {
      if (disposed) throw fail('插件已停止，请刷新', 503)
      if (body?.confirmed !== true) throw fail('必须先确认整理范围、模型与token用量', 400)
      const id = body.planId
      pathFor(id)
      const existing = await readJob(id)
      if (existing) return { job: publicJob(existing) }
      const cached = plans.get(id), plan = cached?.public
      if (!plan || plan.expiresAt <= now()) throw fail('整理预览已过期，请重新预览并确认；尚未调用模型', 409)
      if (serviceIdentity(cached.owner) !== serviceIdentity(getLlm())) throw fail('模型服务已改变，请重新预览并确认', 409)
      if (active) throw fail('上一次整理的后台调用尚未结束，请等待，避免重复消耗token', 409)
      const job = { version: 1, id, sessionId: plan.sessionId, answer: plan.answer, provider: plan.provider, model: plan.model,
        createdAt: now(), updatedAt: now(), status: 'running', inputTokens: plan.inputTokens, outputTokens: plan.outputTokens,
        coverage: plan.coverage, sources: plan.sources, focus: plan.focus, fingerprint: plan.fingerprint, templateVersion: 1, usage: null, report: null }
      // A flushed, exclusive receipt MUST exist before any provider invocation.
      try { await write(pathFor(id), JSON.stringify(job), { exclusive: true }) }
      catch (e) {
        if (e.code === 'EEXIST') { const stored = await readJob(id); if (stored) return { job: publicJob(stored) } }
        throw fail('无法保存调用记录，尚未调用模型。请检查插件数据目录。', 503)
      }
      plans.delete(id); remember(job)
      if (disposed || serviceIdentity(cached.owner) !== serviceIdentity(getLlm())) {
        job.status = 'cancelled'
        job.error = '保存调用记录期间插件已停止或模型服务已改变；尚未调用模型，不会重放此计划。'
        settling.add(id)
        await save(job)
        settling.delete(id)
        return { job: publicJob(job) }
      }
      const control = { id, controller: new AbortController(), llm: cached.owner, reason: '' }
      active = control
      void execute(plan, job, control).catch(() => { job.persistenceWarning = '整理作业异常中止，请保留当前页面核对，勿自动重试。' })
      return { job: publicJob(job) }
    })
    startTail = run.catch(() => {})
    return run
  }
  async function get({ id, sessionId }) {
    if (!id?.startsWith(sessionKey(sessionId) + '.')) throw fail('找不到这份会话的整理', 404)
    const job = await readJob(id)
    if (!job || job.sessionId !== sessionId) throw fail('找不到这份会话的整理', 404)
    return { job: publicJob(job) }
  }
  async function history(sessionId) {
    let files
    try { files = await fs.readdir(directory(sessionId)) } catch (e) { if (e.code === 'ENOENT') return { jobs: [] }; throw e }
    const ids = files.filter(f => f.endsWith('.json') && idPattern.test(f.slice(0, -5))).sort().reverse().slice(0, 10).map(f => f.slice(0, -5))
    const jobs = []
    for (const id of ids) {
      const { job } = await get({ id, sessionId })
      const { report, sources, ...summary } = job
      jobs.push(summary)
    }
    return { jobs }
  }
  async function cancel({ id, sessionId }) {
    await get({ id, sessionId })
    if (active?.id === id) { active.reason = '已请求取消整理，已消耗token无法撤销。'; active.controller.abort() }
    return get({ id, sessionId })
  }
  function dispose() { disposed = true; plans.clear(); if (active) { active.reason = '插件停止，已请求取消整理；最终费用可能未知。'; active.controller.abort() } }
  return { models, preview, start, get, history, cancel, dispose }
}
