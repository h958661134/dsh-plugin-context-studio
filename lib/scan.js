// @ts-check
/**
 * 素材盘点：把一个「项目」（全局，或 DSH 的一个工作区）里会进入模型上下文的东西拆成拼图块，
 * 并做只标不删的可疑体检。
 *
 * 来源都对照过 DSH 源码：
 *   - 指令文件：dsh-agent-instructions（$DSH_HOME/AGENTS.md、<agentsHome>/AGENTS.md；项目根到 cwd 每级的
 *     AGENTS.md / CLAUDE.md / AGENTS.local.md / CLAUDE.local.md）
 *   - 技能：dsh-skill-filesystem（<root>/.dsh/skills、<root>/.agents/skills、$DSH_HOME/skills、<agentsHome>/skills）
 *   - 会话：ctx.workspaceRegistry 的 sessionIds + ctx.sessionQuery
 *   - Dot 记忆：$DSH_HOME/dot/state.json（第三方插件数据，只读）
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shortHash, splitBlocks } from './markdown.js'
import { estimateTokens } from './tokens.js'

export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
export const GLOBAL = 'global'
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage'])
const MAX_FILE_BYTES = 1024 * 1024
const DAY = 86_400_000

/**
 * @typedef {{ code: 'missing-path' | 'duplicate' | 'stale' | 'shadowed' | 'archived', text: string }} Flag
 * @typedef {{
 *   id: string,
 *   kind: 'instruction' | 'skill' | 'session' | 'dot',
 *   subkind?: string,
 *   title: string,
 *   text: string,
 *   group: string,
 *   source: { label: string, path?: string, line?: number, sessionId?: string, workspaceId?: string },
 *   time: number | null,
 *   tokens: number,
 *   flags: Flag[],
 *   removable: 'block' | 'archive' | false,
 *   fileHash?: string,
 * }} Piece
 * @typedef {{ path: string, scope: 'global' | 'project' | 'nested', hash: string, mtime: number, bytes: number, tokens: number, shadowedBy?: string }} FileInfo
 * @typedef {{ dshHome: string, agentsHome: string }} Homes
 */

/** @param {NodeJS.ProcessEnv} [env] @returns {Homes} */
export function resolveHomes(env = process.env) {
  return {
    dshHome: env.DSH_HOME || join(homedir(), '.dsh'),
    agentsHome: env.DSH_AGENTS_HOME || join(homedir(), '.agents'),
  }
}

/** @param {string} p */
async function exists(p) {
  try { await stat(p); return true } catch { return false }
}

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 最近的含 `.git` 的祖先目录；没有就用 dir 本身（与 DSH 默认的 projectRootMarkers 一致）。
 * @param {string} dir
 */
export async function findProjectRoot(dir) {
  let cur = resolve(dir)
  for (;;) {
    if (await exists(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return resolve(dir)
    cur = parent
  }
}

/**
 * 项目根到 dir 的每一级目录（从宽到窄）。
 * @param {string} root @param {string} dir
 */
export function chainDirs(root, dir) {
  const rel = relative(root, dir)
  if (rel.startsWith('..') || isAbsolute(rel)) return [dir]
  const parts = rel ? rel.split(sep) : []
  const out = [root]
  let cur = root
  for (const p of parts) { cur = join(cur, p); out.push(cur) }
  return out
}

/**
 * 工作区内更深目录里的指令文件（深度 ≤ maxDepth，最多扫 maxDirs 个目录）。
 * @param {string} base @param {Set<string>} skip 已在链上的目录
 */
export async function findNestedInstructionFiles(base, skip, maxDepth = 3, maxDirs = 2000) {
  /** @type {string[]} */
  const found = []
  let budget = maxDirs
  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    if (budget-- <= 0) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    if (!skip.has(dir)) {
      for (const name of INSTRUCTION_FILES) {
        if (entries.some(e => e.isFile() && e.name === name)) found.push(join(dir, name))
      }
    }
    if (depth >= maxDepth) return
    for (const e of entries) {
      if (!e.isDirectory() || IGNORE_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.agents' && e.name !== '.dsh')) continue
      await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(base, 0)
  return found
}

/**
 * 一个项目会被 DSH 加载的指令文件位置（不论是否存在）。
 * @param {{ id: string, path?: string }} project
 * @param {Homes} homes
 * @returns {Promise<{ path: string, scope: FileInfo['scope'] }[]>}
 */
export async function instructionCandidates(project, homes) {
  if (project.id === GLOBAL || !project.path) {
    return [
      { path: join(homes.dshHome, 'AGENTS.md'), scope: 'global' },
      { path: join(homes.agentsHome, 'AGENTS.md'), scope: 'global' },
    ]
  }
  const root = await findProjectRoot(project.path)
  const dirs = chainDirs(root, resolve(project.path))
  /** @type {{ path: string, scope: FileInfo['scope'] }[]} */
  const out = []
  for (const d of dirs) for (const name of INSTRUCTION_FILES) out.push({ path: join(d, name), scope: 'project' })
  for (const p of await findNestedInstructionFiles(resolve(project.path), new Set(dirs))) out.push({ path: p, scope: 'nested' })
  return out
}

/** 归一化，用于判重：去掉列表符号、多余空白、大小写。 @param {string} text */
export function normalizeForDup(text) {
  return text.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 块里用反引号写的、看起来像路径的片段。
 * @param {string} text
 */
export function pathMentions(text) {
  /** @type {string[]} */
  const out = []
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim()
    if (!t || /\s/.test(t) || /[*?<>|{}$~"']/.test(t) || /^[a-z]+:\/\//i.test(t) || t.startsWith('-') || t.startsWith('@')) continue
    if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/')) { out.push(t); continue }
    // 相对路径：要么带目录分隔，要么是带扩展名的文件名
    const hasSep = /[\\/]/.test(t)
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(t)
    if (!hasSep && !hasExt) continue
    if (/^\d+(\.\d+)+$/.test(t)) continue // 版本号
    if (/\(\)$/.test(t) || /^[\w.]+\(.*\)$/.test(t)) continue // 函数调用
    if (!hasSep && /^[a-z]+\.[a-z]+$/i.test(t) && !/\.(md|json|ya?ml|toml|js|ts|mjs|cjs|tsx|jsx|py|go|rs|sh|ps1|txt|lock|env|css|html)$/i.test(t)) continue // ctx.foo 这类属性访问
    out.push(t.replace(/[\\/]+$/, ''))
  }
  return [...new Set(out)]
}

/**
 * @param {string} mention @param {string[]} bases
 */
async function pathExistsSomewhere(mention, bases) {
  if (isAbsolute(mention) || /^[A-Za-z]:[\\/]/.test(mention)) return exists(mention)
  for (const b of bases) if (await exists(join(b, mention))) return true
  return false
}

/**
 * 读一个指令文件并拆块。
 * @param {string} path @param {FileInfo['scope']} scope
 */
export async function readInstructionFile(path, scope) {
  let st
  try { st = await stat(path) } catch { return null }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  const source = await readFile(path, 'utf8')
  /** @type {FileInfo} */
  const info = { path, scope, hash: sha256(source), mtime: st.mtimeMs, bytes: Buffer.byteLength(source), tokens: estimateTokens(source) }
  return { info, source, blocks: splitBlocks(source) }
}

/**
 * 全局文件用短名展示：$DSH_HOME/AGENTS.md、~/.agents/AGENTS.md。
 * @param {string} p @param {Homes} homes
 */
export function homeLabel(p, homes) {
  for (const [base, label] of [[homes.dshHome, '$DSH_HOME'], [homes.agentsHome, '~/.agents']]) {
    const rel = relative(base, p)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return `${label}/${rel.split(sep).join('/')}`
  }
  return p
}

/** @param {string} p */
export const fileKey =p => shortHash(resolve(p).toLowerCase())

/** @param {string} path @param {string} hash */
export const instructionPieceId = (path, hash) => `ins:${fileKey(path)}:${hash}`

/** 相对时间（给标记文字用）。 @param {number} ms */
function ageText(ms) {
  const d = Math.floor(ms / DAY)
  if (d >= 365) return `${Math.floor(d / 365)} 年`
  if (d >= 30) return `${Math.floor(d / 30)} 个月`
  return `${d} 天`
}

/**
 * 读 SKILL.md / <name>.md 的 frontmatter。
 * @param {string} source
 */
export function parseFrontmatter(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  /** @type {Record<string, string>} */
  const out = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

/**
 * @param {string} root 技能根目录
 * @param {string} label
 */
export async function readSkills(root, label) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  /** @type {{ name: string, description: string, path: string, mtime: number, root: string, label: string }[]} */
  const out = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const file = e.isDirectory() ? join(root, e.name, 'SKILL.md') : (e.isFile() && e.name.endsWith('.md') ? join(root, e.name) : null)
    if (!file) continue
    try {
      const st = await stat(file)
      if (st.size > MAX_FILE_BYTES) continue
      const fm = parseFrontmatter(await readFile(file, 'utf8'))
      out.push({ name: fm.name || e.name.replace(/\.md$/, ''), description: fm.description || '', path: file, mtime: st.mtimeMs, root, label })
    } catch { /* 读不了的技能跳过 */ }
  }
  return out
}

/**
 * @typedef {{
 *   homes: Homes,
 *   workspaceRegistry?: any,
 *   sessionQuery?: any,
 *   now?: number,
 *   staleDays?: number,
 *   sessionLimit?: number,
 * }} ScanEnv
 */

/**
 * 项目列表：全局 + 每个工作区。
 * @param {ScanEnv} env
 */
export function listProjects(env) {
  /** @type {{ id: string, title: string, path?: string, sessionCount: number }[]} */
  const out = [{ id: GLOBAL, title: '全局', sessionCount: 0 }]
  try {
    for (const w of env.workspaceRegistry?.list?.() ?? []) {
      out.push({ id: String(w.id), title: String(w.title ?? basename(w.path)), path: String(w.path), sessionCount: (w.sessionIds ?? []).length })
    }
  } catch { /* 注册表还没就绪 */ }
  return out
}

/** @param {ScanEnv} env @param {string} id */
export function findProject(env, id) {
  return listProjects(env).find(p => p.id === id) ?? null
}

/**
 * 扫描一个项目的全部素材。
 * @param {ScanEnv} env
 * @param {string} projectId
 */
export async function scanProject(env, projectId) {
  const project = findProject(env, projectId)
  if (!project) throw new Error(`未知项目 ${projectId}`)
  const now = env.now ?? Date.now()
  const staleMs = (env.staleDays ?? 90) * DAY
  /** @type {Piece[]} */
  const pieces = []
  /** @type {FileInfo[]} */
  const files = []
  /** @type {Map<string, import('./markdown.js').Block & { path: string }>} 素材 id → 块（给 ops 用） */
  const blocks = new Map()

  // ── 指令文件 ─────────────────────────────────
  const candidates = await instructionCandidates(project, env.homes)
  // 判重要和全局链比较：项目视图里也读全局文件（但不展示）
  const compareWith = project.id === GLOBAL ? [] : await instructionCandidates({ id: GLOBAL }, env.homes)
  /** @type {Map<string, string[]>} 归一化文本 → 出现的文件 */
  const dupIndex = new Map()
  const loaded = []
  for (const c of [...candidates, ...compareWith]) {
    const r = await readInstructionFile(c.path, c.scope)
    if (!r) continue
    const shown = candidates.includes(c)
    loaded.push({ ...r, shown })
    for (const b of r.blocks) {
      if (b.kind === 'heading') continue
      const key = normalizeForDup(b.text)
      if (key.length < 12) continue
      const list = dupIndex.get(key) ?? []
      list.push(c.path)
      dupIndex.set(key, list)
    }
  }
  // 被遮蔽：同目录 CLAUDE.md 与 AGENTS.md（或 .local 对）去首尾空白后一致，DSH 只渲染一份
  for (const f of loaded) {
    const name = basename(f.info.path)
    const twin = name.startsWith('CLAUDE') ? join(dirname(f.info.path), name.replace('CLAUDE', 'AGENTS')) : null
    const t = twin && loaded.find(x => resolve(x.info.path) === resolve(twin))
    if (t && t.source.trim() === f.source.trim()) f.info.shadowedBy = t.info.path
  }

  const root = project.path ? await findProjectRoot(project.path) : env.homes.dshHome
  for (const f of loaded.filter(x => x.shown)) {
    files.push(f.info)
    const rel = project.path ? relative(root, f.info.path) || basename(f.info.path) : homeLabel(f.info.path, env.homes)
    const stale = now - f.info.mtime > staleMs
    for (const b of f.blocks) {
      /** @type {Flag[]} */
      const flags = []
      if (f.info.shadowedBy) flags.push({ code: 'shadowed', text: `和 ${basename(f.info.shadowedBy)} 内容相同，DSH 只加载一份` })
      if (b.kind !== 'heading') {
        const others = (dupIndex.get(normalizeForDup(b.text)) ?? []).filter(p => resolve(p) !== resolve(f.info.path))
        if (others.length) {
          const name = (/** @type {string} */ p) => {
            const short = homeLabel(p, env.homes)
            return short !== p ? short : (project.path ? relative(root, p).split(sep).join('/') : basename(p))
          }
          flags.push({ code: 'duplicate', text: `和 ${[...new Set(others.map(name))].join('、')} 重复` })
        }
        const bases = [dirname(f.info.path), root, ...(project.path ? [project.path] : [])]
        const missing = []
        for (const m of pathMentions(b.text)) if (!(await pathExistsSomewhere(m, bases))) missing.push(m)
        if (missing.length) flags.push({ code: 'missing-path', text: `提到的路径不存在：${missing.slice(0, 3).join('、')}` })
      }
      if (stale) flags.push({ code: 'stale', text: `文件 ${ageText(now - f.info.mtime)}没改过` })
      const id = instructionPieceId(f.info.path, b.hash)
      blocks.set(id, { ...b, path: f.info.path })
      const firstLine = b.text.split('\n')[0].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s*/, '')
      pieces.push({
        id, kind: 'instruction', subkind: b.kind,
        title: b.kind === 'transplant' ? `拼入的内容（${b.origin ?? ''}）` : firstLine.slice(0, 80),
        text: b.text,
        group: `${rel}${b.headings.length ? ' › ' + b.headings.join(' › ') : ''}`,
        source: { label: rel, path: f.info.path, line: b.start + 1 },
        time: f.info.mtime, tokens: estimateTokens(b.text), flags,
        removable: 'block', fileHash: f.info.hash,
      })
    }
  }

  // ── 技能 ──────────────────────────────────────
  const skillRoots = project.id === GLOBAL
    ? [{ dir: join(env.homes.dshHome, 'skills'), label: '$DSH_HOME/skills' }, { dir: join(env.homes.agentsHome, 'skills'), label: '~/.agents/skills' }]
    : [{ dir: join(root, '.dsh', 'skills'), label: '.dsh/skills' }, { dir: join(root, '.agents', 'skills'), label: '.agents/skills' }]
  for (const r of skillRoots) {
    for (const s of await readSkills(r.dir, r.label)) {
      const text = `技能 \`${s.name}\`：${s.description || '（无描述）'}`
      pieces.push({
        id: `skill:${shortHash(s.path.toLowerCase())}`, kind: 'skill', title: s.name, text,
        group: `技能 · ${r.label}`, source: { label: `${r.label}/${basename(dirname(s.path)) === basename(r.dir) ? basename(s.path) : basename(dirname(s.path))}`, path: s.path },
        time: s.mtime, tokens: estimateTokens(text),
        flags: now - s.mtime > staleMs ? [{ code: 'stale', text: `${ageText(now - s.mtime)}没改过` }] : [],
        removable: false,
      })
    }
  }

  // ── 会话 ──────────────────────────────────────
  if (project.id !== GLOBAL) pieces.push(...await scanSessions(env, project.id, now, staleMs))

  // ── Dot 记忆（只读）──────────────────────────
  if (project.id === GLOBAL) pieces.push(...await scanDotMemories(env.homes, now, staleMs))

  return { project, files, pieces, blocks }
}

/**
 * @param {ScanEnv} env @param {string} workspaceId @param {number} now @param {number} staleMs
 * @returns {Promise<Piece[]>}
 */
export async function scanSessions(env, workspaceId, now, staleMs) {
  const registry = env.workspaceRegistry
  const query = env.sessionQuery
  const ws = registry?.get?.(workspaceId)
  if (!ws || !query?.listSessions) return []
  const ids = new Set((ws.sessionIds ?? []).map(String))
  const archived = new Set((registry.archivedSessionIds ?? []).map(String))
  /** @type {any[]} */
  let headers = []
  try {
    headers = (await query.listSessions()).map((/** @type {any} */ r) => r?.header)
      .filter((/** @type {any} */ h) => h && ids.has(String(h.id)) && h.origin !== 'subagent')
  } catch { return [] }
  headers.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  headers = headers.slice(0, env.sessionLimit ?? 50)
  /** @type {Map<string, string>} */
  const titles = new Map()
  try {
    const snaps = await query.readTitleSnapshots(headers.map(h => h.id))
    snaps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      const t = s?.status === 'fulfilled' ? s.value?.title?.title : undefined
      if (typeof t === 'string' && t.trim()) titles.set(String(headers[i].id), t.trim())
    })
  } catch { /* 没有标题就用时间 */ }
  return headers.map(h => {
    const id = String(h.id)
    const title = titles.get(id) ?? `未命名会话 ${new Date(h.createdAt ?? 0).toLocaleString('zh-CN', { hour12: false })}`
    /** @type {Flag[]} */
    const flags = []
    if (archived.has(id)) flags.push({ code: 'archived', text: '已归档' })
    if (h.createdAt && now - h.createdAt > staleMs) flags.push({ code: 'stale', text: `${ageText(now - h.createdAt)}前的会话` })
    const text = sessionMention(id, title)
    return {
      id: `session:${id}`, kind: /** @type {const} */ ('session'), title, text,
      group: '会话', source: { label: title, sessionId: id, workspaceId },
      time: h.createdAt ?? null, tokens: estimateTokens(text), flags,
      removable: archived.has(id) ? false : /** @type {const} */ ('archive'),
    }
  })
}

/**
 * DSH 原生的会话引用：`@[标题](dsh-session:<base64url(JSON(id))>)`（见 dsh-session-reference 的 uri.ts）。
 * @param {string} sessionId @param {string} label
 */
export function sessionMention(sessionId, label) {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  const safe = label.replace(/[\\[\]]/g, m => `\\${m}`).replace(/[\r\n]+/g, ' ')
  return `@[${safe}](dsh-session:${payload})`
}

/**
 * 一个会话里的消息片段（用户和助手的发言），供挑选摘录。
 * @param {any} sessionQuery @param {string} sessionId @param {number} [limit]
 */
export async function sessionSnippets(sessionQuery, sessionId, limit = 80) {
  if (!sessionQuery?.filterEvents) throw new Error('当前环境没有会话查询服务')
  const docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'type', values: ['user/message', 'assistant/message'] }])
  // user/message 里除了用户亲手发的，还有运行时注入的上下文（工作区指令、时间、运行环境快照……）。
  // 每条消息都带 source.kind，用户发的是 'user'（见 dsh-llm 的 MessageSourceMap 和 session-controller 的 'user-rpc'）。
  /** @type {Map<number, string> | null} seq → source.kind */
  let kinds = null
  if (typeof sessionQuery.readSession === 'function') {
    try {
      const log = await sessionQuery.readSession(sessionId)
      kinds = new Map()
      for (const e of log?.events ?? []) {
        if (e?.type === 'user/message') kinds.set(Number(e.seq), String(e.data?.source?.kind ?? ''))
      }
    } catch { kinds = null }
  }
  return docs
    .filter((/** @type {any} */ d) => {
      if (typeof d.text !== 'string' || !d.text.trim()) return false
      if (d.type !== 'user/message') return true
      if (kinds) return kinds.get(Number(d.seq)) === 'user'
      return !d.text.trimStart().startsWith('<system-reminder>')
    })
    .slice(-limit)
    .map((/** @type {any} */ d) => {
      const text = d.text.length > 4000 ? d.text.slice(0, 4000) + '…' : d.text
      return { seq: d.seq, role: d.type === 'user/message' ? 'user' : 'assistant', time: d.time, text, tokens: estimateTokens(text) }
    })
}

/** @param {Homes} homes @param {number} now @param {number} staleMs @returns {Promise<Piece[]>} */
export async function scanDotMemories(homes, now, staleMs) {
  const file = join(homes.dshHome, 'dot', 'state.json')
  let state
  try { state = JSON.parse(await readFile(file, 'utf8')) } catch { return [] }
  const list = Array.isArray(state?.memories) ? state.memories : []
  return list.filter((/** @type {any} */ m) => m && typeof m.text === 'string').map((/** @type {any} */ m) => {
    const t = Date.parse(m.updatedAt ?? m.createdAt ?? '') || null
    return {
      id: `dot:${String(m.id ?? shortHash(m.text))}`, kind: /** @type {const} */ ('dot'), subkind: String(m.category ?? 'other'),
      title: m.text.slice(0, 80), text: m.text, group: 'Dot 记忆（只读，由 Dot 管理）',
      source: { label: 'Dot 记忆', path: file }, time: t, tokens: estimateTokens(m.text),
      flags: t && now - t > staleMs ? [{ code: /** @type {const} */ ('stale'), text: `${ageText(now - t)}没更新` }] : [],
      removable: /** @type {const} */ (false),
    }
  })
}

/**
 * 写入目标：工作区目录（或全局 $DSH_HOME）下的 AGENTS.local.md / AGENTS.md。
 * @param {ScanEnv} env @param {string} projectId @param {string} file
 */
export function writeTarget(env, projectId, file) {
  if (file !== 'AGENTS.local.md' && file !== 'AGENTS.md') throw new Error('只能写入 AGENTS.local.md 或 AGENTS.md')
  if (projectId === GLOBAL) {
    if (file !== 'AGENTS.md') throw new Error('全局只支持 $DSH_HOME/AGENTS.md')
    return join(env.homes.dshHome, 'AGENTS.md')
  }
  const p = findProject(env, projectId)
  if (!p?.path) throw new Error(`未知项目 ${projectId}`)
  return join(p.path, file)
}
