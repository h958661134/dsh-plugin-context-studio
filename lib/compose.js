// @ts-check
/**
 * 把拼盘里的块渲染成一段文字：
 *   - mode 'prompt'：开新会话用的起始上下文（会话用 dsh-session 提及，文件用 @path）；
 *   - mode 'instructions'：写进目标项目指令文件用的内容（只放文字类素材，会话写成纯文本引用）。
 * 不自动截断，只报告超预算从第几块开始。
 */

import { estimateTokens } from './tokens.js'

/**
 * @typedef {{
 *   kind: 'instruction' | 'skill' | 'session' | 'snippet' | 'dot' | 'file' | 'note',
 *   text: string,
 *   title?: string,
 *   from?: string,
 *   role?: 'user' | 'assistant',
 *   time?: number | null,
 * }} BoardItem
 */

const KINDS = new Set(['instruction', 'skill', 'session', 'snippet', 'dot', 'file', 'note'])
export const MAX_ITEMS = 200
export const MAX_ITEM_CHARS = 20_000

/**
 * 校验并清洗客户端传来的拼盘。
 * @param {unknown} raw
 * @returns {BoardItem[]}
 */
export function sanitizeItems(raw) {
  if (!Array.isArray(raw)) throw new Error('items 必须是数组')
  if (raw.length > MAX_ITEMS) throw new Error(`一次最多 ${MAX_ITEMS} 块`)
  return raw.map((x, i) => {
    if (!x || typeof x !== 'object') throw new Error(`第 ${i + 1} 块格式不对`)
    const it = /** @type {Record<string, unknown>} */ (x)
    if (typeof it.kind !== 'string' || !KINDS.has(it.kind)) throw new Error(`第 ${i + 1} 块类型不对`)
    if (typeof it.text !== 'string') throw new Error(`第 ${i + 1} 块缺少内容`)
    const str = (/** @type {unknown} */ v, n = 300) => (typeof v === 'string' ? v.slice(0, n) : undefined)
    return /** @type {BoardItem} */ ({
      kind: it.kind,
      text: it.text.slice(0, MAX_ITEM_CHARS),
      title: str(it.title),
      from: str(it.from),
      role: it.role === 'user' || it.role === 'assistant' ? it.role : undefined,
      time: typeof it.time === 'number' ? it.time : null,
    })
  })
}

/** @param {number | null | undefined} t */
const day = t => (t ? new Date(t).toISOString().slice(0, 10) : '')

/** 一块所属的小节标题；相邻同标题的块合并到一节下。 @param {BoardItem} it @param {'prompt' | 'instructions'} mode */
function headerOf(it, mode) {
  switch (it.kind) {
    case 'instruction': return `## 约定${it.from ? ` · 来自 ${it.from}` : ''}`
    case 'dot': return '## 关于用户（来自 Dot 记忆）'
    case 'skill': return '## 可用技能'
    case 'session': return mode === 'prompt' ? '## 参考会话' : '## 相关会话'
    case 'snippet': return `## 会话摘录${it.title ? ` · ${it.title}` : ''}${it.time ? `（${day(it.time)}）` : ''}`
    case 'file': return '## 相关文件'
    default: return ''
  }
}

/** @param {BoardItem} it @param {'prompt' | 'instructions'} mode */
function bodyOf(it, mode) {
  const text = it.text.replace(/\r\n/g, '\n').trimEnd()
  switch (it.kind) {
    case 'skill': return text.startsWith('- ') ? text : `- ${text}`
    case 'session':
      // 指令文件里的提及不会被展开，写成纯文本
      return mode === 'prompt' ? `- ${text}` : `- ${it.title ?? text}`
    case 'snippet': {
      const who = it.role === 'assistant' ? '助手' : it.role === 'user' ? '用户' : ''
      // 不用 `>` 引用：DSH 输入框会把引用块折叠成引用卡片，并吞掉紧跟的分隔线
      return `${who ? `**${who}：**\n` : ''}${text}`
    }
    case 'file': return `- ${/\s/.test(text) ? `@"${text.replace(/"/g, '')}"` : `@${text.replace(/^@/, '')}`}`
    default: return text
  }
}

/**
 * @param {BoardItem[]} items
 * @param {{ mode?: 'prompt' | 'instructions', budget?: number, task?: string }} [options]
 */
export function compose(items, options = {}) {
  const mode = options.mode ?? 'prompt'
  const budget = options.budget && options.budget > 0 ? options.budget : 0
  const usable = mode === 'instructions' ? items.filter(i => i.kind !== 'file') : items
  /** @type {string[]} */
  const sections = []
  let lastHeader = null
  /** @type {number[]} */
  const perItem = []
  for (const it of usable) {
    const header = headerOf(it, mode)
    const body = bodyOf(it, mode)
    let chunk = ''
    if (header && header !== lastHeader) chunk += `${header}\n\n`
    chunk += body
    perItem.push(estimateTokens(chunk))
    if (header && header === lastHeader) {
      // 同一节内：列表项紧挨着，其他内容空一行
      const tight = /^[-*]\s/.test(body) && /(^|\n)[-*]\s[^\n]*$/.test(sections[sections.length - 1] ?? '')
      sections[sections.length - 1] += (tight ? '\n' : '\n\n') + body
    } else {
      sections.push(chunk)
    }
    lastHeader = header || null
  }

  let text
  if (mode === 'prompt') {
    const body = sections.join('\n\n')
    const task = options.task?.trim() || '（在这里写本次任务）'
    const draft = `# 起始上下文\n\n${body}${body ? '\n\n' : ''}---\n\n${task}\n`
    // 不加 HTML 注释头：它会原样出现在对话气泡里。块数和 token 只在拼图台界面上显示
    text = draft
  } else {
    text = sections.join('\n\n') + (sections.length ? '\n' : '')
  }
  const tokens = estimateTokens(text)
  // 超预算从哪一块开始
  let overFrom = -1
  if (budget) {
    let acc = 0
    for (let i = 0; i < perItem.length; i++) {
      acc += perItem[i]
      if (acc > budget) { overFrom = i; break }
    }
  }
  return { text, tokens, budget, over: budget > 0 && tokens > budget, overFrom, perItem, count: usable.length, skipped: items.length - usable.length }
}
