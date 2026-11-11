// @ts-check
/**
 * 接口只接受本机同源请求（防 DNS rebinding 和跨站请求），写操作还要求自定义头 + JSON 体，
 * 跨站页面发不出这样的请求而不触发 CORS 预检。
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
export const CLIENT_HEADER = 'x-context-studio'
export const MAX_BODY = 512 * 1024

/** @param {string | undefined} hostHeader @param {Set<string>} allowed */
export function hostAllowed(hostHeader, allowed) {
  if (!hostHeader) return false
  const host = hostHeader.toLowerCase().replace(/:\d+$/, '')
  return LOOPBACK.has(host) || allowed.has(host)
}

/**
 * @param {{ method?: string, headers: Record<string, string | string[] | undefined> }} req
 * @param {Set<string>} allowedHosts
 * @param {boolean} write
 * @returns {string | null} 拒绝原因；null 表示放行
 */
export function checkRequest(req, allowedHosts, write) {
  const host = /** @type {string | undefined} */ (req.headers.host)
  if (!hostAllowed(host, allowedHosts)) return 'host not allowed'
  const origin = /** @type {string | undefined} */ (req.headers.origin)
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(host).toLowerCase()) return 'cross-origin'
    } catch {
      return 'bad origin'
    }
  }
  if (write) {
    if (req.method !== 'POST') return 'method'
    if (req.headers[CLIENT_HEADER] !== '1') return 'missing client header'
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return 'content-type'
  } else if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    return 'method'
  }
  return null
}

/** @param {AsyncIterable<Buffer>} req */
export async function readJson(req) {
  let size = 0
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体太大')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}
