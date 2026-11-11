// @ts-check
/**
 * 把一份指令文件（AGENTS.md 一类的 Markdown）拆成可以单独移除、拼接的「块」。
 *
 * 规则：
 *   - 标题行（# ~ ######）开启新的一节，标题本身也是一块（kind 'heading'），移除它不会连带移除节内容；
 *   - 节内按顶层列表项（含缩进的续行和子列表）、段落、围栏代码块拆块；
 *   - 本插件写入的 `<!-- context-studio:begin … -->` … `<!-- context-studio:end -->` 整体算一块（kind 'transplant'）；
 *   - 空行不属于任何块。
 *
 * 每块记录 [start, end) 行号（0 起）和原文，移除时按行号删、并逐行核对原文。
 */

import { createHash } from 'node:crypto'

/**
 * @typedef {{
 *   kind: 'heading' | 'item' | 'paragraph' | 'code' | 'transplant',
 *   start: number,
 *   end: number,
 *   text: string,
 *   headings: string[],
 *   hash: string,
 *   origin?: string,
 * }} Block
 */

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^(?:[-*+]|\d+[.)])\s+/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
export const BEGIN = /^<!--\s*context-studio:begin\b(.*?)-->\s*$/
export const END = /^<!--\s*context-studio:end\s*-->\s*$/

/** @param {string} text */
export function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 10)
}

/** 统一换行后切行；保留是否 CRLF 的信息给写回时用。 @param {string} source */
export function splitLines(source) {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const normalized = source.replace(/\r\n/g, '\n')
  const trailing = normalized.endsWith('\n')
  const lines = normalized.split('\n')
  if (trailing) lines.pop()
  return { lines, eol, trailing }
}

/** @param {string[]} lines @param {string} eol @param {boolean} trailing */
export function joinLines(lines, eol, trailing) {
  return lines.join(eol) + (trailing && lines.length ? eol : '')
}

/**
 * @param {string} source
 * @returns {Block[]}
 */
export function splitBlocks(source) {
  const { lines } = splitLines(source)
  /** @type {Block[]} */
  const blocks = []
  /** @type {{ level: number, title: string }[]} */
  const stack = []
  const headings = () => stack.map(s => s.title)
  const push = (/** @type {Block['kind']} */ kind, /** @type {number} */ start, /** @type {number} */ end, /** @type {string} */ origin = '') => {
    // 去掉尾部空行
    while (end > start && lines[end - 1].trim() === '') end--
    if (end <= start) return
    const text = lines.slice(start, end).join('\n')
    blocks.push({ kind, start, end, text, headings: headings(), hash: shortHash(text), ...(origin ? { origin } : {}) })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }

    const begin = BEGIN.exec(line.trim())
    if (begin) {
      let j = i + 1
      while (j < lines.length && !END.test(lines[j].trim())) j++
      if (j < lines.length) {
        push('transplant', i, j + 1, begin[1].trim())
        i = j + 1
        continue
      }
      // 没有结束标记：当普通段落处理
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      let j = i + 1
      while (j < lines.length && !lines[j].trimStart().startsWith(marker)) j++
      push('code', i, Math.min(j + 1, lines.length))
      i = j + 1
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = heading[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      // 标题块的 headings 是它的父级路径
      push('heading', i, i + 1)
      stack.push({ level, title: heading[2] })
      i++
      continue
    }

    if (ITEM.test(line)) {
      let j = i + 1
      while (j < lines.length) {
        const next = lines[j]
        if (next.trim() === '') {
          // 空行后若是缩进续行，仍属于本项
          let k = j
          while (k < lines.length && lines[k].trim() === '') k++
          if (k < lines.length && /^\s+\S/.test(lines[k]) && !FENCE.test(lines[k])) { j = k; continue }
          break
        }
        if (/^\s+\S/.test(next)) { j++; continue } // 缩进续行 / 子列表
        if (ITEM.test(next) || HEADING.test(next) || FENCE.test(next) || BEGIN.test(next.trim())) break
        j++ // 懒续行
      }
      push('item', i, j)
      i = j
      continue
    }

    // 段落：到空行、标题、列表、围栏为止
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j]
      if (next.trim() === '' || HEADING.test(next) || ITEM.test(next) || FENCE.test(next) || BEGIN.test(next.trim())) break
      j++
    }
    push('paragraph', i, j)
    i = j
  }

  // 同一文件里内容相同的块用序号区分
  /** @type {Map<string, number>} */
  const seen = new Map()
  for (const b of blocks) {
    const n = seen.get(b.hash) ?? 0
    seen.set(b.hash, n + 1)
    if (n > 0) b.hash = `${b.hash}.${n}`
  }
  return blocks
}

/**
 * 从原文里删掉一块。逐行核对，对不上就抛错（文件已被改动）。
 * 删除后若前后都是空行，合并成一个空行。
 * @param {string} source
 * @param {Block} block
 * @returns {string}
 */
export function removeBlock(source, block) {
  const { lines, eol, trailing } = splitLines(source)
  const current = lines.slice(block.start, block.end).join('\n')
  if (current !== block.text) throw new Error('块的内容和扫描时不一致，文件可能已被修改，请刷新后再试')
  const next = [...lines.slice(0, block.start), ...lines.slice(block.end)]
  // 合并多余空行
  const at = block.start
  while (at > 0 && at < next.length && next[at - 1].trim() === '' && next[at].trim() === '') next.splice(at, 1)
  while (next.length && next[next.length - 1].trim() === '') next.pop()
  while (next.length && next[0].trim() === '') next.shift()
  return joinLines(next, eol, trailing || next.length > 0)
}

/**
 * 在文件末尾追加一段带来源标记的内容。
 * @param {string} source 原文（文件不存在时传 ''）
 * @param {string} body
 * @param {{ id: string, from: string, at: string }} meta
 */
export function appendTransplant(source, body, meta) {
  const { lines, eol } = source ? splitLines(source) : { lines: [], eol: '\n' }
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  const safe = (/** @type {string} */ s) => s.replace(/--/g, '—').replace(/[\r\n]+/g, ' ')
  const block = [
    `<!-- context-studio:begin id=${safe(meta.id)} from="${safe(meta.from)}" at=${safe(meta.at)} -->`,
    ...body.replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')),
    '<!-- context-studio:end -->',
  ]
  const out = lines.length ? [...lines, '', ...block] : block
  return joinLines(out, eol, true)
}
