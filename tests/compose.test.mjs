import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compose, sanitizeItems } from '../lib/compose.js'

const items = [
  { kind: 'instruction', text: '- 用 pnpm', from: 'api / AGENTS.md › 构建' },
  { kind: 'instruction', text: '- 产物在 dist/', from: 'api / AGENTS.md › 构建' },
  { kind: 'session', text: '@[修登录](dsh-session:Ilx4Ig)', title: '修登录' },
  { kind: 'snippet', text: '原因是 cookie\n第二行', title: '修登录', role: 'assistant', time: Date.UTC(2026, 9, 2) },
  { kind: 'file', text: 'src/auth/login.ts' },
  { kind: 'file', text: 'docs/my file.md' },
  { kind: 'skill', text: '技能 `deploy`：部署' },
  { kind: 'note', text: '注意别动生产库' },
]

test('compose(prompt): 同源相邻块合并、会话用提及、文件用 @path、带任务', () => {
  const r = compose(sanitizeItems(items), { task: '给登录页加记住我' })
  assert.match(r.text, /^# 起始上下文\n/, '不带 HTML 注释头（它会原样出现在对话气泡里）')
  assert.ok(r.text.includes('## 约定 · 来自 api / AGENTS.md › 构建\n\n- 用 pnpm\n- 产物在 dist/'))
  assert.equal(r.text.match(/## 约定/g).length, 1)
  assert.ok(r.text.includes('## 参考会话\n\n- @[修登录](dsh-session:Ilx4Ig)'))
  assert.ok(r.text.includes('## 会话摘录 · 修登录（2026-10-02）\n\n**助手：**\n原因是 cookie\n第二行'))
  assert.ok(!/^>/m.test(r.text), '不用 > 引用，免得被 DSH 输入框折叠')
  assert.ok(r.text.includes('## 相关文件\n\n- @src/auth/login.ts\n- @"docs/my file.md"'))
  assert.ok(r.text.includes('## 可用技能\n\n- 技能 `deploy`：部署'))
  assert.ok(r.text.trimEnd().endsWith('---\n\n给登录页加记住我'))
  assert.equal(r.count, 8)
  assert.equal(r.perItem.length, 8)
})

test('compose(instructions): 跳过文件引用，会话写成纯文本', () => {
  const r = compose(sanitizeItems(items), { mode: 'instructions' })
  assert.ok(!r.text.includes('@src'))
  assert.ok(!r.text.includes('dsh-session:'))
  assert.ok(r.text.includes('## 相关会话\n\n- 修登录'))
  assert.equal(r.skipped, 2)
  assert.ok(!r.text.includes('起始上下文'))
})

test('compose: 预算与超出位置', () => {
  const big = [{ kind: 'note', text: 'a'.repeat(100) }, { kind: 'note', text: 'b'.repeat(100) }, { kind: 'note', text: 'c'.repeat(100) }]
  const r = compose(sanitizeItems(big), { budget: 50 })
  assert.equal(r.over, true)
  assert.equal(r.overFrom, 1)
  const ok = compose(sanitizeItems(big), { budget: 100000 })
  assert.equal(ok.over, false)
  assert.equal(ok.overFrom, -1)
  const empty = compose([], {})
  assert.equal(empty.count, 0)
})

test('sanitizeItems: 拒绝坏输入、截断超长', () => {
  assert.throws(() => sanitizeItems('x'), /数组/)
  assert.throws(() => sanitizeItems([{ kind: 'evil', text: '' }]), /类型不对/)
  assert.throws(() => sanitizeItems([{ kind: 'note' }]), /缺少内容/)
  assert.throws(() => sanitizeItems(new Array(201).fill({ kind: 'note', text: 'a' })), /最多/)
  const [it] = sanitizeItems([{ kind: 'note', text: 'x'.repeat(30000), role: 'hacker', title: 5 }])
  assert.equal(it.text.length, 20000)
  assert.equal(it.role, undefined)
  assert.equal(it.title, undefined)
})
