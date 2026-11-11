import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendTransplant, removeBlock, splitBlocks, splitLines } from '../lib/markdown.js'
import { estimateTokens } from '../lib/tokens.js'

const DOC = `# 项目约定

用 pnpm 管理依赖。

## 构建
- 先跑 \`pnpm build\`
- 产物在 \`dist/\`
  续行也属于这一项
  - 子项也是

1. 有序列表
2. 第二项

\`\`\`bash
# 这不是标题
pnpm test
\`\`\`

### 更深
一段话
跨两行
`

test('splitBlocks: 标题、列表项、段落、代码块各自成块，并带标题路径', () => {
  const blocks = splitBlocks(DOC)
  const kinds = blocks.map(b => b.kind)
  assert.deepEqual(kinds, ['heading', 'paragraph', 'heading', 'item', 'item', 'item', 'item', 'code', 'heading', 'paragraph'])
  const item = blocks[4]
  assert.equal(item.text, '- 产物在 `dist/`\n  续行也属于这一项\n  - 子项也是')
  assert.deepEqual(item.headings, ['项目约定', '构建'])
  const code = blocks[7]
  assert.ok(code.text.includes('# 这不是标题'), '代码块里的 # 不当标题')
  assert.deepEqual(blocks[9].headings, ['项目约定', '构建', '更深'])
  assert.equal(blocks[9].text, '一段话\n跨两行')
})

test('splitBlocks: 行号准确，同内容块哈希不冲突', () => {
  const src = '- 同样\n- 同样\n'
  const blocks = splitBlocks(src)
  assert.equal(blocks.length, 2)
  assert.notEqual(blocks[0].hash, blocks[1].hash)
  assert.deepEqual([blocks[0].start, blocks[0].end, blocks[1].start, blocks[1].end], [0, 1, 1, 2])
})

test('splitBlocks: 列表项之间的空行 + 缩进续行仍归同一项', () => {
  const blocks = splitBlocks('- 第一项\n\n  补充说明\n- 第二项\n')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, '- 第一项\n\n  补充说明')
})

test('splitBlocks: 拼入标记整体是一块', () => {
  const src = appendTransplant('# 标题\n', '- a\n- b', { id: 'x1', from: 'api', at: '2026-11-11' })
  const blocks = splitBlocks(src)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].kind, 'transplant')
  assert.match(blocks[1].origin ?? '', /from="api"/)
})

test('removeBlock: 删掉一项后不留多余空行，保留 CRLF 与末尾换行', () => {
  const src = '# T\r\n\r\n- a\r\n- b\r\n\r\npara\r\n'
  const blocks = splitBlocks(src)
  const b = blocks.find(x => x.text === '- b')
  const out = removeBlock(src, b)
  assert.equal(out, '# T\r\n\r\n- a\r\n\r\npara\r\n')
  const p = splitBlocks(out).find(x => x.text === 'para')
  assert.equal(removeBlock(out, p), '# T\r\n\r\n- a\r\n')
})

test('removeBlock: 内容对不上时拒绝', () => {
  const src = '- a\n- b\n'
  const b = splitBlocks(src)[1]
  assert.throws(() => removeBlock('- a\n- c\n', b), /不一致/)
})

test('appendTransplant: 新文件与已有文件，注释里的 -- 被替换', () => {
  const fresh = appendTransplant('', 'hello', { id: 'i', from: 'a--b', at: 'd' })
  assert.equal(fresh, '<!-- context-studio:begin id=i from="a—b" at=d -->\nhello\n<!-- context-studio:end -->\n')
  const existing = appendTransplant('x\n\n\n', 'y', { id: 'i', from: 'f', at: 'd' })
  assert.ok(existing.startsWith('x\n\n<!-- context-studio:begin'))
  const { lines } = splitLines(existing)
  assert.equal(lines.at(-1), '<!-- context-studio:end -->')
})

test('estimateTokens: 中文约 0.6、英文约 0.3', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('a'.repeat(10)), 3)
  assert.equal(estimateTokens('中'.repeat(10)), 6)
  assert.equal(estimateTokens('中文 abc'), Math.ceil(0.6 * 2 + 0.3 * 4))
})
