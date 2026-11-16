// @ts-check
/** Read deadlines do not cancel DSH I/O. Keep pending work registered until it
 * settles, so retries cannot accumulate copies of the same expensive read. */
export function deadline(work, ms, label = '读取') {
  let timer
  return Promise.race([Promise.resolve(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时，请稍后重试；后台读取尚未结束时不会重复启动`), { status: 504 })), ms)
  })]).finally(() => clearTimeout(timer))
}

export function boundedReads({ timeoutMs = 8000, maxPending = 6, reserved = 0 } = {}) {
  const pending = new Map()
  return (key, run, background = false) => {
    let work = pending.get(key)
    if (!work) {
      if (pending.size >= maxPending - (background ? reserved : 0)) return Promise.reject(Object.assign(new Error('后台读取繁忙，请稍后重试'), { status: 503 }))
      work = Promise.resolve().then(run)
      pending.set(key, work)
      work.then(() => pending.delete(key), () => pending.delete(key))
    }
    return deadline(work, timeoutMs)
  }
}

export function boundedQuery(getQuery, options) {
  let run, metadata
  let owner
  let generation = 0
  return (background = false) => {
    const query = getQuery()
    if (!query) return query
    if (query !== owner) { owner = query; generation++; run = boundedReads({ reserved: 2, ...options }); metadata = boundedReads({ maxPending: 4, ...options }) }
    const version = generation
    return new Proxy(query, { get(target, prop) {
      const value = target[prop]
      if (typeof value !== 'function') return value
      return (...args) => (prop === 'listSessions' || prop === 'readTitleSnapshots' ? metadata : run)(`${version}:${String(prop)}:${JSON.stringify(args)}`, () => value.apply(target, args), background)
    } })
  }
}

/** Navigation needs headers and titles, never full session logs or project files. */
export async function sessionCatalog(env, focus) {
  const projects = env.workspaceRegistry?.list?.() ?? []
  if (focus !== 'global' && !projects.some(p => String(p.id) === focus)) throw Object.assign(new Error('未知项目'), { status: 400 })
  const rows = new Map()
  for (const p of projects) {
    if (focus !== 'global' && String(p.id) !== focus) continue
    for (const id of p.sessionIds ?? []) rows.set(String(id), { id: String(id), title: `未命名会话 · ${String(id).slice(-8)}`, workspaceId: String(p.id), project: p.title, createdAt: 0 })
  }
  const warnings = []
  try {
    const logs = await deadline(env.sessionQuery?.listSessions?.() ?? [], 4000, '会话目录')
    for (const { header: h } of logs) if (h && rows.has(String(h.id))) rows.get(String(h.id)).createdAt = Number(h.createdAt) || 0
  } catch { warnings.push('部分时间信息未读取，仍可直接选择会话。') }
  const total = rows.size
  const sessions = [...rows.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 300)
  try {
    const titles = await deadline(env.sessionQuery?.readTitleSnapshots?.(sessions.map(s => s.id)) ?? [], 4000, '会话标题')
    titles.forEach((s, i) => { const title = s?.status === 'fulfilled' ? s.value?.title?.title : null; if (sessions[i] && typeof title === 'string' && title.trim()) sessions[i].title = title.trim() })
  } catch { warnings.push('标题暂不可用，可用会话编号选择并重试。') }
  if (total > sessions.length) warnings.push(`仅展示最近 ${sessions.length} / ${total} 个会话，请选择具体项目缩小范围。`)
  return { project: focus, sessions, warnings, total }
}
