// @ts-check
/**
 * 脉络图：从会话出发，看每段记忆 / 上下文被哪些会话用过，哪些会话连成一条链、哪些是独立的。
 *
 * 用到的都是 DSH 会话日志里真实记录的东西（不是猜的）：
 *   - `user/message` 的 `source.kind === 'agent-instructions'`：这个会话加载了哪些指令文件，
 *     `changes[] = { action, scope, path, digest }`，digest 是文件内容的 sha1
 *     （dsh-agent-instructions 的 digest.ts `instructionContentSha1`）；
 *   - `source.kind === 'skill-invocation'`（用户直接调用技能）和 `tool/call` 里 name 为 `skill` 的调用：用过哪些技能；
 *   - `source.kind === 'session-reference'`：引用了哪些会话（`references[].sessionId`）——会话之间的「链」；
 *   - 会话头 `parentSession` + `origin: 'subagent'`：子代理；
 *   - 会话头 `isSeeded`：分叉出来的会话。普通分叉不记来源，靠继承前缀里用户消息的 `rpcId` 找到来源会话。
 *
 * 这里分两层：纯函数（extractFacts / buildGraph / layoutChain，便于测试）和读 DSH 服务的 buildLineage。
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GLOBAL, INSTRUCTION_FILES, chainDirs, homeLabel, listProjects, parseFrontmatter } from './scan.js'
import { BEGIN } from './markdown.js'
import { deadline } from './reads.js'

/** @param {string} text */
export const sha1 = text => createHash('sha1').update(text).digest('hex')

/**
 * @typedef {{ path: string, scope: string, digest: string | null, removed: boolean }} Load
 * @typedef {{ id: string, inherited: boolean }} Rpc
 * @typedef {{
 *   loads: Load[], skills: string[], refs: { sessionId: string, label: string }[], rpc: Rpc[],
 *   firstText: string, firstTime: number, lastTime: number, turns: number, studio: boolean,
 * }} Facts
 */

/** @param {any} content */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n')
}

/**
 * 从一个会话的事件里抽出脉络图要用的事实。
 * @param {any[]} events
 * @returns {Facts}
 */
export function extractFacts(events) {
  const list = Array.isArray(events) ? events : []
  // 分叉子会话的继承前缀：最后一个带 inherited 的 session/end-seed 之前
  let cut = -1
  for (const e of list) if (e?.type === 'session/end-seed' && e.data?.inherited === true) cut = Number(e.seq)
  /** @type {Map<string, Load>} */
  const loads = new Map()
  const skills = new Set()
  /** @type {Map<string, string>} */
  const refs = new Map()
  /** @type {Rpc[]} */
  const rpc = []
  let firstText = ''
  let firstTime = 0
  let lastTime = 0
  let turns = 0
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.time === 'number' && e.time > lastTime) lastTime = e.time
    if (e.type === 'tool/call' && e.data?.name === 'skill') {
      try {
        const n = JSON.parse(String(e.data.arguments ?? '{}'))?.name
        if (typeof n === 'string' && n) skills.add(n)
      } catch { /* 参数坏了就跳过 */ }
      continue
    }
    if (e.type !== 'user/message') continue
    const src = e.data?.source
    const kind = src?.kind
    if (kind === 'user') {
      const inherited = cut >= 0 && Number(e.seq) < cut
      if (typeof src.rpcId === 'string') rpc.push({ id: src.rpcId, inherited })
      if (!inherited) {
        turns++
        if (!firstTime) { firstText = textOf(e.data.content).slice(0, 2000); firstTime = typeof e.time === 'number' ? e.time : 0 }
      }
    } else if (kind === 'agent-instructions' && Array.isArray(src.changes)) {
      for (const c of src.changes) {
        if (!c || typeof c.path !== 'string') continue
        const prev = loads.get(c.path)
        if (c.action === 'remove') { if (prev) prev.removed = true; continue }
        if (c.action !== 'set' && c.action !== 'replace') continue
        loads.set(c.path, { path: c.path, scope: String(c.scope ?? ''), digest: typeof c.digest === 'string' ? c.digest : (prev?.digest ?? null), removed: false })
      }
    } else if (kind === 'skill-invocation' && typeof src.name === 'string') {
      skills.add(src.name)
    } else if (kind === 'session-reference' && Array.isArray(src.references)) {
      for (const r of src.references) {
        if (r && typeof r.sessionId === 'string') refs.set(r.sessionId, typeof r.label === 'string' ? r.label : '')
      }
    }
  }
  const studio = /^\s*(?:<!--[^]*?-->\s*)?# 起始上下文/.test(firstText)
  return {
    loads: [...loads.values()], skills: [...skills], refs: [...refs].map(([sessionId, label]) => ({ sessionId, label })),
    rpc, firstText, firstTime, lastTime, turns, studio,
  }
}

/**
 * 会话日志里的指令路径 → 绝对路径。全局文件写成 `$DSH_HOME/…`、`~/.dsh/…`、`$DSH_AGENTS_HOME/…`、`~/.agents/…`，
 * 项目文件是相对项目根的路径（files.ts `relativeDisplay`，保留目录前会加 `./`）。
 * @param {string} p @param {{ dshHome: string, agentsHome: string }} homes @param {string} root
 */
export function resolveLoadPath(p, homes, root) {
  const s = p.replace(/\\/g, '/')
  const m = /^(\$DSH_HOME|~\/\.dsh|\$DSH_AGENTS_HOME|~\/\.agents)\/(.*)$/.exec(s)
  if (m) return resolve(m[1] === '$DSH_HOME' || m[1] === '~/.dsh' ? homes.dshHome : homes.agentsHome, m[2])
  return resolve(root, s.replace(/^\.\//, ''))
}

/** 路径做 key（Windows 大小写不敏感）。 @param {string} p */
export const pathKey = p => `ins:${resolve(p).toLowerCase()}`

/**
 * 一条链里的泳道：像 git 图那样，父会话的第一个后继沿用父的泳道，其余后继开新泳道。
 * @param {string[]} ids 按创建时间从早到晚
 * @param {{ from: string, to: string }[]} edges 链内的边（from 是来源）
 * @returns {{ lane: Map<string, number>, lanes: number, style: Map<string, 'straight' | 'branch' | 'merge'> }}
 */
export function layoutChain(ids, edges) {
  /** @type {Map<string, number>} */
  const row = new Map(ids.map((id, i) => [id, i]))
  /** @type {Map<string, string[]>} */
  const parents = new Map(ids.map(id => [id, /** @type {string[]} */ ([])]))
  /** @type {Map<string, number>} */
  const lastChild = new Map(ids.map((id, i) => [id, i]))
  for (const e of edges) {
    if (!row.has(e.from) || !row.has(e.to)) continue
    // 只接受从早到晚的边（防环）
    if (/** @type {number} */ (row.get(e.from)) >= /** @type {number} */ (row.get(e.to))) continue
    parents.get(e.to)?.push(e.from)
    lastChild.set(e.from, Math.max(/** @type {number} */ (lastChild.get(e.from)), /** @type {number} */ (row.get(e.to))))
  }
  /** @type {number[]} */
  const laneEnd = []
  const passed = new Set()
  /** @type {Map<string, number>} */
  const lane = new Map()
  /** @type {Map<string, 'straight' | 'branch' | 'merge'>} */
  const style = new Map()
  for (const id of ids) {
    const r = /** @type {number} */ (row.get(id))
    const ps = (parents.get(id) ?? []).slice().sort((a, b) => /** @type {number} */ (row.get(a)) - /** @type {number} */ (row.get(b)))
    const heir = ps.find(p => !passed.has(p))
    let l
    if (heir !== undefined) {
      l = /** @type {number} */ (lane.get(heir))
      passed.add(heir)
    } else {
      const start = ps.length ? /** @type {number} */ (row.get(ps[0])) : r
      l = 0
      while ((laneEnd[l] ?? -1) >= start) l++
    }
    lane.set(id, l)
    laneEnd[l] = Math.max(laneEnd[l] ?? -1, /** @type {number} */ (lastChild.get(id)))
    for (const p of ps) {
      const key = `${p}>${id}`
      if (lane.get(p) === l) style.set(key, 'straight')
      else if (heir === undefined && p === ps[0]) style.set(key, 'branch')
      else style.set(key, 'merge')
    }
  }
  return { lane, lanes: Math.max(1, laneEnd.length), style }
}

/**
 * @typedef {{
 *   id: string, title: string, workspaceId: string | null, createdAt: number, archived?: boolean,
 *   seeded?: boolean, origin?: string, parent?: string | null, facts: Facts,
 *   uses: { key: string, digest: string | null, abs?: string, rel?: string, readError?: string }[],
 * }} GSession
 * @typedef {{
 *   key: string, kind: 'instruction' | 'skill', label: string, path?: string, exists: boolean | null,
 *   readState?: 'read' | 'missing' | 'unknown', readError?: string | null,
 *   digest?: string | null, projectId?: string | null, group?: string, transplants?: string[],
 * }} GMemory
 */

/**
 * 从会话和记忆目录算出脉络图（纯函数）。
 * @param {{ sessions: GSession[], memories: GMemory[], focus: string, projectTitles?: Record<string, string> }} input
 */
export function buildGraph({ sessions, memories, focus, projectTitles = {} }) {
  /** @type {Map<string, GSession>} */
  const byId = new Map(sessions.map(s => [s.id, s]))

  // ── 边 ───────────────────────────────────────
  /** @type {Map<string, { from: string, to: string, kind: 'fork' | 'subagent' | 'reference', label?: string }>} */
  const edgeMap = new Map()
  const addEdge = (/** @type {string} */ from, /** @type {string} */ to, /** @type {'fork' | 'subagent' | 'reference'} */ kind, label = '') => {
    if (from === to || !byId.has(from) || !byId.has(to)) return
    const key = `${from}>${to}`
    if (!edgeMap.has(key)) edgeMap.set(key, { from, to, kind, ...label ? { label } : {} })
  }
  for (const s of sessions) {
    if (s.parent && s.origin === 'subagent') addEdge(s.parent, s.id, 'subagent')
    if (s.seeded) {
      const inherited = s.facts.rpc.filter(r => r.inherited).map(r => r.id)
      if (inherited.length) {
        const last = inherited[inherited.length - 1]
        const cands = sessions.filter(o => o.id !== s.id && o.createdAt <= s.createdAt
          && inherited.every(id => o.facts.rpc.some(r => r.id === id)))
        // 优先「最后一条继承消息是它自己发的」的那个（真正的来源），否则取最早的
        const own = cands.filter(o => o.facts.rpc.some(r => r.id === last && !r.inherited))
        const pick = (own.length ? own : cands).sort((a, b) => b.createdAt - a.createdAt)[0]
        if (pick) addEdge(pick.id, s.id, 'fork')
      } else if (s.parent) {
        addEdge(s.parent, s.id, 'fork')
      }
    }
    for (const r of s.facts.refs) addEdge(r.sessionId, s.id, 'reference', r.label)
  }
  const edges = [...edgeMap.values()]

  // ── 连通分量 ─────────────────────────────────
  /** @type {Map<string, string>} */
  const up = new Map(sessions.map(s => [s.id, s.id]))
  const find = (/** @type {string} */ x) => {
    let r = x
    while (up.get(r) !== r) r = /** @type {string} */ (up.get(r))
    up.set(x, r)
    return r
  }
  for (const e of edges) up.set(find(e.from), find(e.to))
  /** @type {Map<string, GSession[]>} */
  const comps = new Map()
  for (const s of sessions) {
    const r = find(s.id)
    const list = comps.get(r) ?? []
    list.push(s)
    comps.set(r, list)
  }

  // 只留和焦点项目有关的分量（全局视图留全部）
  const relevant = [...comps.values()].filter(list => focus === GLOBAL || list.some(s => s.workspaceId === focus))
  const chainsRaw = relevant.filter(l => l.length > 1)
  const singles = relevant.filter(l => l.length === 1).map(l => l[0])
  const lastOf = (/** @type {GSession} */ s) => Math.max(s.createdAt, s.facts.lastTime || 0)
  // DSH 会复用还没发过消息的空白会话，所以「什么时候开始」看第一条用户消息，不看创建时间
  const startOf = (/** @type {GSession} */ s) => s.facts.firstTime || s.createdAt
  chainsRaw.sort((a, b) => Math.max(...b.map(lastOf)) - Math.max(...a.map(lastOf)))
  singles.sort((a, b) => lastOf(b) - lastOf(a))

  const pTitle = (/** @type {string | null} */ id) => (id ? projectTitles[id] ?? id : '')
  const sessionOut = (/** @type {GSession} */ s, /** @type {string | null} */ chainId, lane = 0) => ({
    id: s.id, title: s.title, chainId, lane, workspaceId: s.workspaceId, project: pTitle(s.workspaceId),
    external: focus !== GLOBAL && s.workspaceId !== focus, createdAt: s.createdAt, startTime: s.facts.firstTime || s.createdAt, lastTime: s.facts.lastTime || s.createdAt,
    turns: s.facts.turns, archived: Boolean(s.archived), studio: s.facts.studio, origin: s.origin ?? null,
    seeded: Boolean(s.seeded), refs: s.facts.refs.length,
  })

  /** @type {Map<string, string>} 会话 → 链 id */
  const chainOf = new Map()
  const chains = chainsRaw.map((list, i) => {
    const ordered = list.slice().sort((a, b) => startOf(a) - startOf(b) || a.id.localeCompare(b.id))
    const ids = ordered.map(s => s.id)
    const inside = edges.filter(e => ids.includes(e.from) && ids.includes(e.to))
    const lay = layoutChain(ids, inside)
    const id = `chain-${i + 1}`
    for (const s of ordered) chainOf.set(s.id, id)
    return {
      id, title: ordered[0].title, lanes: lay.lanes,
      projects: [...new Set(ordered.map(s => pTitle(s.workspaceId)).filter(Boolean))],
      sessions: ordered.map(s => sessionOut(s, id, /** @type {number} */ (lay.lane.get(s.id)))),
      edges: inside.map(e => ({ ...e, style: lay.style.get(`${e.from}>${e.to}`) ?? 'merge' })),
      lastTime: Math.max(...ordered.map(lastOf)),
    }
  })

  // ── 记忆的使用情况 ───────────────────────────
  const kept = [...chainsRaw.flat(), ...singles]
  /** @type {Map<string, GMemory>} */
  const memByKey = new Map(memories.map(m => [m.key, m]))
  /** @type {Map<string, { sessionId: string, current: boolean | null }[]>} */
  const usage = new Map()
  for (const s of kept) {
    for (const u of s.uses) {
      const m = memByKey.get(u.key)
      const current = !m || m.readState === 'unknown' || m.exists == null ? null
        : m.exists === false ? false : m.kind === 'instruction' ? (u.digest && m.digest ? u.digest === m.digest : null) : true
      const list = usage.get(u.key) ?? []
      if (!list.some(x => x.sessionId === s.id)) list.push({ sessionId: s.id, current })
      usage.set(u.key, list)
    }
  }
  const memOut = [...new Set([...memories.map(m => m.key), ...usage.keys()])].map(key => {
    const m = memByKey.get(key)
    const used = (usage.get(key) ?? []).sort((a, b) => {
      const x = byId.get(a.sessionId), y = byId.get(b.sessionId)
      return (x ? startOf(x) : 0) - (y ? startOf(y) : 0)
    })
    const groups = new Set(used.map(u => chainOf.get(u.sessionId) ?? `single:${u.sessionId}`))
    const cls = used.length === 0 ? 'unused'
      : used.length === 1 ? 'single'
        : groups.size === 1 && [...groups][0].startsWith('chain-') ? 'chain' : 'shared'
    const kind = m?.kind ?? (key.startsWith('skill:') ? 'skill' : 'instruction')
    return {
      key, kind, label: m?.label ?? key.replace(/^skill:|^ins:/, ''), path: m?.path, exists: m?.exists ?? null,
      readState: m?.readState ?? (m?.exists === true ? 'read' : m?.exists === false ? 'missing' : 'unknown'), readError: m?.readError ?? null,
      projectId: m?.projectId ?? null, group: m?.group, transplants: m?.transplants ?? [],
      cls, uses: used, chains: [...groups].filter(g => g.startsWith('chain-')),
      outdated: used.length > 0 && used.every(u => u.current === false),
    }
  })
  const order = { shared: 0, chain: 1, single: 2, unused: 3 }
  memOut.sort((a, b) => order[a.cls] - order[b.cls] || b.uses.length - a.uses.length || (a.kind === b.kind ? 0 : a.kind === 'instruction' ? -1 : 1) || a.label.localeCompare(b.label))

  const count = (/** @type {string} */ c) => memOut.filter(m => m.cls === c).length
  return {
    focus,
    chains,
    singles: singles.map(s => sessionOut(s, null)),
    memories: memOut,
    summary: {
      chains: chains.length, chainSessions: chains.reduce((n, c) => n + c.sessions.length, 0), singles: singles.length,
      shared: count('shared'), chain: count('chain'), single: count('single'), unused: count('unused'),
      outdated: memOut.filter(m => m.outdated).length,
    },
  }
}

// ── 读 DSH 服务 ────────────────────────────────────────────

/** @param {string} source */
function transplantSources(source) {
  /** @type {string[]} */
  const out = []
  for (const line of source.split(/\r?\n/)) {
    if (!BEGIN.test(line.trim())) continue
    const m = /from="([^"]*)"/.exec(line)
    out.push(m ? m[1] : '?')
  }
  return out
}

/**
 * @param {number} limit
 * @param {T[]} items
 * @param {(x: T) => Promise<R>} fn
 * @template T, R
 * @returns {Promise<R[]>}
 */
async function pool(limit, items, fn) {
  /** @type {R[]} */
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

// Do not wrap scan.js's recursive helpers in a race: they could keep scheduling I/O
// after the race loses. Every primitive below checks the same scan deadline.
const GRAPH_FS = { readFile, readdir, stat }
const IGNORE_GRAPH_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage'])
const MAX_GRAPH_FILE_BYTES = 1024 * 1024
const scanError = (code, message, status = 504) => Object.assign(new Error(message), { code, status })
const independentLoadPath = path => isAbsolute(path) || /^(\$DSH_HOME|~\/\.dsh|\$DSH_AGENTS_HOME|~\/\.agents)[\\/]/.test(path)

function graphScan(env) {
  const io = { ...GRAPH_FS, ...env.graphIO }, now = env.graphNow ?? Date.now
  const budgetMs = Math.max(0, env.graphBudgetMs ?? 12000), end = now() + budgetMs
  const ioTimeoutMs = Math.max(1, env.graphIOTimeoutMs ?? 1500)
  let stopped = null, pending = 0, started = 0
  function stop(code, message) { return stopped ??= scanError(code, message) }
  function check() {
    if (stopped) throw stopped
    if (now() >= end) throw stop('GRAPH_BUDGET', '本次脉络扫描达到总时间上限，已停止启动后续读取')
    return end - now()
  }
  return {
    check,
    canStart() { try { check(); return true } catch { return false } },
    stop,
    async query(run, ms, label) {
      const remaining = check()
      try { const value = await deadline(Promise.resolve().then(() => { check(); return run() }), Math.min(ms, remaining), label); check(); return value }
      catch (e) { if (now() >= end) stop('GRAPH_BUDGET', '本次脉络扫描达到总时间上限，已停止启动后续读取'); throw e }
    },
    async io(method, path) {
      const remaining = check()
      if (pending >= 4) throw stop('GRAPH_IO_PENDING', '本次扫描已有 4 项文件 I/O 未完成，已停止启动后续读取')
      if (started >= 10000) throw stop('GRAPH_IO_LIMIT', '本次扫描达到文件 I/O 数量上限，已停止启动后续读取')
      const ctl = new AbortController()
      // Reserve immediately, before yielding; keep the slot until the raw promise settles.
      pending++; started++
      const raw = Promise.resolve().then(() => {
        check()
        return method === 'readFile' ? io.readFile(path, { encoding: 'utf8', signal: ctl.signal })
          : method === 'readdir' ? io.readdir(path, { withFileTypes: true }) : io.stat(path)
      })
      raw.then(() => pending--, () => pending--)
      let timer
      try {
        const value = await Promise.race([raw, new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = stop(remaining <= ioTimeoutMs ? 'GRAPH_BUDGET' : 'GRAPH_IO_TIMEOUT', `${method} 读取未完成，已停止本次扫描的后续 I/O；文件状态未知`)
            ctl.abort(); reject(error)
          }, Math.min(ioTimeoutMs, remaining))
        })])
        check()
        return value
      } finally { clearTimeout(timer) }
    },
    status() { return { budgetMs, stopped: Boolean(stopped), reason: stopped?.code ?? null, startedIO: started, pendingIO: pending, maxPendingIO: 4,
      limitation: 'pendingIO 为返回时本次扫描尚未结束的底层文件 I/O；超时仅停止等待和后续调度，不能保证取消 stat/readdir 或忽略 AbortSignal 的读取。限制按单次扫描计算，不是跨请求全局文件 I/O 限制。' } },
  }
}

function graphFiles(scan, homes, fileFailures) {
  const roots = new Map(), files = new Map(), reported = new Set()
  function report(path, operation, error) {
    const key = `${operation}:${path}`
    if (reported.has(key)) return
    reported.add(key)
    fileFailures.push({ path, operation, state: 'unknown', code: error?.code ?? 'READ_FAILED', error: error instanceof Error ? error.message : String(error) })
  }
  async function rootOf(cwd) {
    const key = resolve(cwd)
    if (!roots.has(key)) roots.set(key, (async () => {
      let cur = key
      for (;;) {
        try { await scan.io('stat', join(cur, '.git')); return cur }
        catch (e) { if (e.code !== 'ENOENT') { report(cur, 'project-root', e); throw e } }
        const parent = dirname(cur)
        if (parent === cur) return key
        cur = parent
      }
    })())
    return roots.get(key)
  }
  async function file(path) {
    const key = pathKey(path)
    if (!files.has(key)) files.set(key, (async () => {
      try {
        const st = await scan.io('stat', path)
        if (!st.isFile() || st.size > MAX_GRAPH_FILE_BYTES) throw scanError('GRAPH_FILE_LIMIT', '不是普通文件或超过 1 MiB 读取上限', 413)
        const source = await scan.io('readFile', path)
        if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_GRAPH_FILE_BYTES) throw scanError('GRAPH_FILE_LIMIT', '文件在读取期间超出 1 MiB 上限', 413)
        return { exists: true, readState: 'read', source, readError: null }
      } catch (e) {
        if (e.code === 'ENOENT') return { exists: false, readState: 'missing', source: null, readError: null }
        report(path, 'file', e)
        return { exists: null, readState: 'unknown', source: null, readError: e instanceof Error ? e.message : String(e) }
      }
    })())
    return files.get(key)
  }
  async function entries(path) {
    try { return await scan.io('readdir', path) }
    catch (e) { if (e.code !== 'ENOENT') report(path, 'directory', e); throw e }
  }
  async function* instructions(project, root) {
    if (!project.path) {
      for (const home of [homes.dshHome, homes.agentsHome]) { scan.check(); yield join(home, 'AGENTS.md') }
      return
    }
    const dirs = chainDirs(root, resolve(project.path)), skip = new Set(dirs)
    for (const dir of dirs) for (const name of INSTRUCTION_FILES) { scan.check(); yield join(dir, name) }
    const queue = [{ dir: resolve(project.path), depth: 0 }]
    for (let i = 0; i < queue.length; i++) {
      scan.check()
      const { dir, depth } = queue[i]
      let list
      try { list = await entries(dir) } catch { if (!scan.canStart()) return; continue }
      if (!skip.has(dir)) for (const name of INSTRUCTION_FILES) {
        scan.check()
        if (list.some(e => e.isFile() && e.name === name)) yield join(dir, name)
      }
      if (depth >= 3) continue
      for (const e of list) {
        scan.check()
        if (!e.isDirectory() || IGNORE_GRAPH_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.agents' && e.name !== '.dsh')) continue
        if (queue.length >= 2000) throw scan.stop('GRAPH_DIRECTORY_LIMIT', '目录扫描达到 2,000 项上限，后续目录未读取')
        queue.push({ dir: join(dir, e.name), depth: depth + 1 })
      }
    }
  }
  async function* skills(root) {
    let list
    try { list = await entries(root) } catch { return }
    let count = 0
    for (const e of list) {
      scan.check()
      if (e.name.startsWith('.')) continue
      const path = e.isDirectory() ? join(root, e.name, 'SKILL.md') : e.isFile() && e.name.endsWith('.md') ? join(root, e.name) : null
      if (!path) continue
      if (++count > 2000) throw scan.stop('GRAPH_SKILL_LIMIT', '技能扫描达到 2,000 项上限，后续技能未读取')
      const result = await file(path)
      if (result.exists === false) continue
      const fm = result.source === null ? {} : parseFrontmatter(result.source)
      yield { name: fm.name || e.name.replace(/\.md$/, ''), path, ...result }
    }
  }
  return { rootOf, file, instructions, skills, report }
}

/**
 * 读出整张脉络图。会话最多读 maxSessions 个（每个工作区最近 sessionLimit 个）。
 * @param {import('./scan.js').ScanEnv & { maxSessions?: number, graphBudgetMs?: number, graphIOTimeoutMs?: number, graphNow?: () => number, graphIO?: Partial<typeof GRAPH_FS> }} env
 * @param {string} focus 工作区 id 或 'global'
 */
export async function buildLineage(env, focus) {
  const warnings = []
  const scan = graphScan(env), failures = [], fileFailures = []
  const fs = graphFiles(scan, env.homes, fileFailures)
  const registry = env.workspaceRegistry
  const query = env.sessionQuery
  const projects = listProjects(env)
  const project = projects.find(p => p.id === focus)
  if (!project) throw Object.assign(new Error(`未知项目 ${focus}`), { status: 400 })
  /** @type {Record<string, string>} */
  const projectTitles = Object.fromEntries(projects.map(p => [p.id, p.title]))
  const capable = Boolean(query?.listSessions && query?.readSession)

  // ── 会话 ─────────────────────────────────────
  /** @type {GSession[]} */
  let sessions = []
  if (capable) {
    /** @type {Map<string, string>} 会话 → 工作区 */
    const wsOf = new Map()
    const archived = new Set((registry?.archivedSessionIds ?? []).map(String))
    for (const w of registry?.list?.() ?? []) for (const id of w.sessionIds ?? []) wsOf.set(String(id), String(w.id))
    /** @type {any[]} */
    let headers = []
    try { headers = (await scan.query(() => query.listSessions(), 4000, '会话目录')).map((/** @type {any} */ r) => r?.header).filter(Boolean) }
    catch {
      warnings.push('会话目录读取失败；关联信息不完整。')
      // Preserve registry identities when the budget is already exhausted; no extra reads.
      headers = [...wsOf].map(([id, workspaceId]) => ({ id, cwd: registry?.get?.(workspaceId)?.path, createdAt: 0 }))
    }
    // 子代理不在工作区的 sessionIds 里：跟着父会话走
    for (let changed = true; changed;) {
      changed = false
      for (const h of headers) {
        const id = String(h.id)
        if (!wsOf.has(id) && h.parentSession && wsOf.has(String(h.parentSession))) { wsOf.set(id, /** @type {string} */ (wsOf.get(String(h.parentSession)))); changed = true }
      }
    }
    headers = headers.filter(h => wsOf.has(String(h.id)))
    // 每个工作区最近 sessionLimit 个顶层会话 + 它们的子代理
    /** @type {Map<string, any[]>} */
    const perWs = new Map()
    for (const h of headers) {
      if (h.origin === 'subagent') continue
      const w = /** @type {string} */ (wsOf.get(String(h.id)))
      const list = perWs.get(w) ?? []
      list.push(h)
      perWs.set(w, list)
    }
    const keep = new Set()
    for (const list of perWs.values()) {
      list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      for (const h of list.slice(0, env.sessionLimit ?? 50)) keep.add(String(h.id))
    }
    for (const h of headers) if (h.origin === 'subagent' && keep.has(String(h.parentSession))) keep.add(String(h.id))
    const total = headers.length
    headers = headers.filter(h => keep.has(String(h.id)))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, env.maxSessions ?? 300)
    if (headers.length < total) warnings.push(`仅扫描 ${headers.length} / ${total} 个会话；未发现关联不代表独立或未使用。`)

    /** @type {Map<string, string>} */
    const titles = new Map()
    try {
      const snaps = await scan.query(() => query.readTitleSnapshots?.(headers.map(h => h.id)) ?? [], 4000, '标题')
      snaps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
        const t = s?.status === 'fulfilled' ? s.value?.title?.title : undefined
        if (typeof t === 'string' && t.trim()) titles.set(String(headers[i].id), t.trim())
      })
    } catch { warnings.push('部分标题未读取，使用会话编号或时间代替。') }
    sessions = (await pool(4, headers, async h => {
      const id = String(h.id)
      /** @type {Facts} */
      let facts
      try {
        facts = extractFacts((await scan.query(() => query.readSession(h.id), 2500, '历史会话'))?.events)
      } catch (e) { failures.push({ id, error: e instanceof Error ? e.message : '读取失败' }); facts = extractFacts([]) }
      const ws = registry?.get?.(wsOf.get(id))
      const cwd = String(h.cwd || ws?.path || env.homes.dshHome)
      const root = facts.loads.some(l => !independentLoadPath(l.path)) ? await fs.rootOf(cwd).catch(() => null) : cwd
      const uses = [
        ...facts.loads.map(l => {
          const independent = independentLoadPath(l.path)
          if (root === null && !independent) return { key: `unresolved:${id}:${l.path}`, digest: l.digest, rel: l.path, readError: '项目根目录未能确认，无法确定当前文件路径' }
          const abs = resolveLoadPath(l.path, env.homes, root ?? cwd)
          return { key: pathKey(abs), digest: l.digest, abs, rel: l.path }
        }),
        ...facts.skills.map(n => ({ key: `skill:${n}`, digest: null })),
      ]
      const title = titles.get(id) ?? (h.origin === 'subagent' ? '子代理' : `未命名会话 ${new Date(h.createdAt ?? 0).toLocaleString('zh-CN', { hour12: false })}`)
      return /** @type {GSession} */ ({
        id, title, workspaceId: wsOf.get(id) ?? null, createdAt: Number(h.createdAt ?? 0), archived: archived.has(id),
        seeded: Boolean(h.isSeeded), origin: h.origin, parent: h.parentSession ? String(h.parentSession) : null, facts, uses,
      })
    }))
  }

  // ── 记忆目录：焦点项目（含全局）里现有的指令文件和技能，加上会话用过但不在目录里的 ──
  /** @type {Map<string, GMemory>} */
  const memories = new Map()
  const addFile = async (/** @type {string} */ path, /** @type {string} */ label, /** @type {string | null} */ projectId, /** @type {string} */ group, referenced = false) => {
    const key = pathKey(path)
    if (memories.has(key)) return
    const result = await fs.file(path), source = result.source
    if (result.exists === false && !referenced) return
    memories.set(key, {
      key, kind: 'instruction', label, path, exists: result.exists, readState: result.readState, readError: result.readError, digest: source === null ? null : sha1(source),
      projectId, group, transplants: source ? transplantSources(source) : [],
    })
  }
  const scopes = focus === GLOBAL ? [project] : [project, projects[0]]
  for (const p of scopes) {
    if (!scan.canStart()) break
    let root
    try { root = p.path ? await fs.rootOf(p.path) : env.homes.dshHome }
    catch { continue }
    try {
      for await (const path of fs.instructions(p, root)) {
        const label = p.path ? (relative(root, path) || basename(path)).split(sep).join('/') : homeLabel(path, env.homes)
        await addFile(path, label, p.id, label)
        if (!scan.canStart()) break
      }
    } catch (e) { fs.report(p.path ?? env.homes.dshHome, 'instructions', e) }
    const skillRoots = p.path
      ? [{ dir: join(root, '.dsh', 'skills'), label: '.dsh/skills' }, { dir: join(root, '.agents', 'skills'), label: '.agents/skills' }]
      : [{ dir: join(env.homes.dshHome, 'skills'), label: '$DSH_HOME/skills' }, { dir: join(env.homes.agentsHome, 'skills'), label: '~/.agents/skills' }]
    for (const r of skillRoots) {
      if (!scan.canStart()) break
      try {
        for await (const s of fs.skills(r.dir)) {
          const key = `skill:${s.name}`
          if (!memories.has(key)) memories.set(key, { key, kind: 'skill', label: s.name, path: s.path, exists: s.exists, readState: s.readState, readError: s.readError, projectId: p.id, group: `技能 · ${r.label}` })
          if (!scan.canStart()) break
        }
      } catch (e) { fs.report(r.dir, 'skills', e) }
    }
  }
  // 会话用过、但不在目录里的指令文件（子目录指令、别的项目的文件、已删除的文件）
  for (const s of sessions) {
    for (const u of s.uses) {
      if (memories.has(u.key)) continue
      if (!u.abs) {
        if (u.readError) memories.set(u.key, { key: u.key, kind: 'instruction', label: u.rel ?? u.key, exists: null, readState: 'unknown', readError: u.readError, projectId: s.workspaceId })
        continue
      }
      const short = homeLabel(u.abs, env.homes)
      const label = short !== u.abs ? short : `${projectTitles[s.workspaceId ?? ''] ?? ''}/${String(u.rel ?? '').replace(/\\/g, '/')}`
      if (scan.canStart()) await addFile(u.abs, label, s.workspaceId, label, true)
      else memories.set(u.key, { key: u.key, kind: 'instruction', label, path: u.abs, exists: null, readState: 'unknown', readError: '扫描已停止，当前文件未核对', projectId: s.workspaceId })
    }
    for (const n of s.facts.skills) {
      const key = `skill:${n}`
      if (!memories.has(key)) memories.set(key, { key, kind: 'skill', label: n, exists: null, readState: 'unknown', readError: '日志记录过该技能，但当前技能文件未能核对', projectId: s.workspaceId })
    }
  }

  const graph = buildGraph({ sessions, memories: [...memories.values()], focus, projectTitles })
  const failedIds = new Map(failures.map(f => [f.id, f.error]))
  for (const s of [...graph.singles, ...graph.chains.flatMap(c => c.sessions)]) s.readError = failedIds.get(s.id) ?? null
  if (failures.length) warnings.push(`${failures.length} 个会话未完成读取，关联与记忆使用情况不完整；请在“回答排查”中单独查看。`)
  if (!capable) warnings.push('宿主尚未提供会话读取服务。')
  const scanStatus = scan.status()
  if (scanStatus.stopped) warnings.push('本次扫描已停止，未继续启动文件/目录读取；未返回的记忆不代表不存在或未使用。')
  if (fileFailures.length) warnings.push(`${fileFailures.length} 项文件或目录读取失败，状态为未知；不能据此判断文件已删除或加载的是旧版本。`)
  if (graph.memories.some(m => m.readState === 'unknown')) warnings.push('部分记忆的当前状态未知，版本比较不完整。')
  if (scanStatus.pendingIO) warnings.push(`${scanStatus.pendingIO} 项底层文件 I/O 在返回时仍未结束；本次扫描不会再调度新 I/O，重试是独立扫描。`)
  return { ...graph, partial: Boolean(warnings.length), warnings, failures, fileFailures, scan: scanStatus, capabilities: { sessions: capable } }
}
