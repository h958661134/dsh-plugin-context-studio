// @ts-check
/**
 * dsh-plugin-context-studio（包根，全局行）—— 上下文拼图台的 Host 侧。
 *
 *   GET  /api/dsh-plugin-context-studio/projects          项目列表（全局 + 工作区）
 *   GET  /api/dsh-plugin-context-studio/pieces?project=   一个项目的素材 + 体检
 *   GET  /api/dsh-plugin-context-studio/session?id=       一个会话的消息片段
 *   GET  /api/dsh-plugin-context-studio/journal           操作记录
 *   POST /api/dsh-plugin-context-studio/compose           { items, mode?, budget?, task? } 渲染拼盘（只读）
 *   POST /api/dsh-plugin-context-studio/remove            { project, pieceId, fileHash }   移除一块指令（备份 + 可撤销）
 *   POST /api/dsh-plugin-context-studio/archive           { project, sessionId }            归档会话（可撤销）
 *   POST /api/dsh-plugin-context-studio/write             { project, file, items, from }    追加到目标项目指令文件（备份 + 可撤销）
 *   POST /api/dsh-plugin-context-studio/undo              { opId }
 *
 * 宿主服务（都在 DSH 源码里核对过）：ctx.webServer、ctx.workspaceRegistry、ctx.sessionQuery。
 * 后两者用 ctx.get 可选获取：缺了的话相应功能降级，不影响其他部分。
 */

import { isAbsolute, join } from 'node:path'
import { checkRequest, readJson } from './guard.js'
import { compose, sanitizeItems } from './compose.js'
import { createOps } from './ops.js'
import { GLOBAL, listProjects, resolveHomes, scanProject, sessionSnippets, writeTarget } from './scan.js'

export const name = 'dsh-context-studio-host'
export const inject = ['webServer']

const API = '/api/dsh-plugin-context-studio'

/**
 * @param {unknown} raw
 */
export function resolveConfig(raw) {
  const c = /** @type {Record<string, any>} */ (raw && typeof raw === 'object' ? raw : {})
  const fail = (/** @type {string} */ msg) => { throw new Error(`[context-studio] 配置错误：${msg}`) }
  const homes = resolveHomes()
  const dataDir = c.dataDir === undefined ? join(homes.dshHome, 'context-studio') : c.dataDir
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir)) fail('dataDir 必须是绝对路径')
  const int = (/** @type {string} */ k, /** @type {number} */ d, /** @type {number} */ min) => {
    if (c[k] === undefined) return d
    if (!Number.isInteger(c[k]) || c[k] < min) fail(`${k} 必须是 ≥ ${min} 的整数`)
    return c[k]
  }
  return {
    homes,
    dataDir,
    staleDays: int('staleDays', 90, 1),
    sessionLimit: int('sessionLimit', 50, 1),
    trustedHosts: (Array.isArray(c.trustedHosts) ? c.trustedHosts : []).map(h => String(h).toLowerCase()),
  }
}

/**
 * @param {import('node:http').ServerResponse} res @param {number} code @param {unknown} body
 */
function send(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** @param {unknown} e */
const message = e => (e instanceof Error ? e.message : String(e))

/**
 * 路由表与处理逻辑，和 ctx 解耦，方便测试。
 * @param {{ config: ReturnType<typeof resolveConfig>, getRegistry: () => any, getQuery: () => any, ops?: ReturnType<typeof createOps> }} deps
 */
export function createHandlers({ config, getRegistry, getQuery, ops = createOps({ dataDir: config.dataDir, getRegistry }) }) {
  const env = () => ({ homes: config.homes, workspaceRegistry: getRegistry(), sessionQuery: getQuery(), staleDays: config.staleDays, sessionLimit: config.sessionLimit })
  const needString = (/** @type {any} */ v, /** @type {string} */ k) => {
    if (typeof v !== 'string' || !v) throw Object.assign(new Error(`缺少 ${k}`), { status: 400 })
    return v
  }

  return {
    ops,
    /** @type {Record<string, (input: { query: URLSearchParams, body: any }) => Promise<unknown>>} */
    get: {
      async projects() {
        const projects = listProjects(env())
        return { projects, homes: config.homes, capabilities: { sessions: Boolean(getQuery()?.listSessions), archive: Boolean(getRegistry()?.archiveSession) } }
      },
      async pieces({ query }) {
        const r = await scanProject(env(), needString(query.get('project'), 'project'))
        return { project: r.project, files: r.files, pieces: r.pieces }
      },
      async session({ query }) {
        return { snippets: await sessionSnippets(getQuery(), needString(query.get('id'), 'id')) }
      },
      async journal() {
        return { ops: (await ops.readJournal()).slice().reverse() }
      },
    },
    /** @type {Record<string, (input: { query: URLSearchParams, body: any }) => Promise<unknown>>} */
    post: {
      async compose({ body }) {
        const items = sanitizeItems(body.items)
        const budget = Number.isFinite(body.budget) ? Number(body.budget) : 0
        return compose(items, { mode: body.mode === 'instructions' ? 'instructions' : 'prompt', budget, task: typeof body.task === 'string' ? body.task.slice(0, 20_000) : undefined })
      },
      async remove({ body }) {
        const project = needString(body.project, 'project')
        const pieceId = needString(body.pieceId, 'pieceId')
        // 不信任客户端的路径和内容：重新扫描，按 id 找到块
        const scan = await scanProject(env(), project)
        const block = scan.blocks.get(pieceId)
        if (!block) throw Object.assign(new Error('找不到这一块，可能已经被改动，请刷新'), { status: 409 })
        const piece = scan.pieces.find(p => p.id === pieceId)
        if (body.fileHash && piece?.fileHash !== body.fileHash) throw Object.assign(new Error('文件在你上次刷新后被修改过，请刷新后再移除'), { status: 409 })
        const op = await ops.removeBlock({ path: block.path, block, expectedHash: /** @type {string} */ (piece?.fileHash), label: `移除「${piece?.title ?? ''}」（${piece?.source.label ?? ''}）` })
        return { ok: true, op, text: '已移除，可在操作记录里撤销' }
      },
      async archive({ body }) {
        const project = needString(body.project, 'project')
        const sessionId = needString(body.sessionId, 'sessionId')
        if (project === GLOBAL) throw Object.assign(new Error('全局里没有会话'), { status: 400 })
        const ws = getRegistry()?.get?.(project)
        if (!ws || !(ws.sessionIds ?? []).map(String).includes(sessionId)) throw Object.assign(new Error('这个会话不属于该项目'), { status: 400 })
        const title = typeof body.title === 'string' ? body.title.slice(0, 120) : sessionId
        const op = await ops.archive({ sessionId, label: `归档会话「${title}」` })
        return { ok: true, op, text: '已归档，可在操作记录里撤销' }
      },
      async write({ body }) {
        const project = needString(body.project, 'project')
        const file = needString(body.file, 'file')
        const items = sanitizeItems(body.items)
        if (!items.length) throw Object.assign(new Error('拼盘是空的'), { status: 400 })
        let path
        try { path = writeTarget(env(), project, file) } catch (e) { throw Object.assign(new Error(message(e)), { status: 400 }) }
        const { text } = compose(items, { mode: 'instructions' })
        const from = typeof body.from === 'string' && body.from ? body.from.slice(0, 200) : '上下文拼图台'
        const title = project === GLOBAL ? '全局' : (getRegistry()?.get?.(project)?.title ?? project)
        const op = await ops.append({ path, body: text, from, label: `写入 ${items.length} 块到 ${title}/${file}（来自 ${from}）` })
        return { ok: true, op, path, text: `已写入 ${path}，新会话会自动加载；可撤销` }
      },
      async undo({ body }) {
        const op = await ops.undo(needString(body.opId, 'opId'))
        return { ok: true, op, text: op.kind === 'archive' ? '已取消归档' : '已撤销，文件恢复原样' }
      },
    },
  }
}

/**
 * @param {any} ctx
 * @param {unknown} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const allowedHosts = new Set(config.trustedHosts)
  try { allowedHosts.add(new URL(ctx.webServer.getOrigin()).hostname.toLowerCase()) } catch { /* 端口未绑定时只认回环地址 */ }

  const handlers = createHandlers({
    config,
    getRegistry: () => ctx.get?.('workspaceRegistry'),
    getQuery: () => ctx.get?.('sessionQuery'),
  })

  for (const [kind, table] of /** @type {const} */ ([['get', handlers.get], ['post', handlers.post]])) {
    for (const [route, fn] of Object.entries(table)) {
      ctx.webServer.register({
        kind: 'exact',
        path: `${API}/${route}`,
        handler: async (/** @type {any} */ req, /** @type {any} */ res) => {
          const reason = checkRequest(req, allowedHosts, kind === 'post')
          if (reason) return send(res, 403, { ok: false, error: reason })
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const body = kind === 'post' ? await readJson(req) : {}
            send(res, 200, await fn({ query: url.searchParams, body }))
          } catch (e) {
            const status = /** @type {any} */ (e)?.status ?? (e instanceof SyntaxError ? 400 : 500)
            send(res, status, { ok: false, error: message(e), text: message(e) })
          }
        },
      })
    }
  }
}
