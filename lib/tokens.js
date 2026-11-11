// @ts-check
/**
 * token 估算。DeepSeek 官方经验值：1 个中文字符约 0.6 token，1 个英文字符约 0.3 token。
 * 其他字符（emoji、符号以外的非 ASCII）按 0.5 计。结果只用于预算展示，界面标注「估算」。
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯　-〿]/u

/** @param {string} text @returns {number} */
export function estimateTokens(text) {
  if (!text) return 0
  let total = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 128) total += 0.3
    else if (CJK.test(ch)) total += 0.6
    else total += 0.5
  }
  return Math.max(1, Math.ceil(total))
}
