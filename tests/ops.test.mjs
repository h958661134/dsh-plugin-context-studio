import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOps, pathExists } from '../lib/ops.js'
import { splitBlocks } from '../lib/markdown.js'
import { sha256 } from '../lib/scan.js'
import { fixture } from './helpers.mjs'

async function setup() {
  const f = await fixture()
  const ops = createOps({ dataDir: join(f.dshHome, 'context-studio'), getRegistry: () => f.registry })
  return { f, ops }
}

test('removeBlock → 备份 + 日志 → undo 恢复原样', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'AGENTS.md')
  const before = await readFile(path, 'utf8')
  const block = splitBlocks(before).find(b => b.text === '- 用 npm')
  const op = await ops.removeBlock({ path, block, expectedHash: sha256(before), label: 'x' })
  const after = await readFile(path, 'utf8')
  assert.equal(after, '# B 项目\n')
  assert.equal(await readFile(op.backup, 'utf8'), before)
  assert.equal((await ops.readJournal()).length, 1)

  await ops.undo(op.id)
  assert.equal(await readFile(path, 'utf8'), before)
  const j = await ops.readJournal()
  assert.ok(j[0].undone)
  await assert.rejects(ops.undo(op.id), /已经撤销/)
})

test('removeBlock: 哈希不一致时拒绝，文件不动', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'AGENTS.md')
  const before = await readFile(path, 'utf8')
  const block = splitBlocks(before)[1]
  await assert.rejects(ops.removeBlock({ path, block, expectedHash: 'stale', label: 'x' }), /被修改过/)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal((await ops.readJournal()).length, 0)
})

test('removeBlock: 拒绝非指令文件', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'notes.md')
  await writeFile(path, '- a\n')
  await assert.rejects(ops.removeBlock({ path, block: splitBlocks('- a\n')[0], expectedHash: sha256('- a\n'), label: 'x' }), /非指令文件/)
})

test('undo: 文件之后又被改过 → 拒绝并给出备份路径', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'AGENTS.md')
  const before = await readFile(path, 'utf8')
  const op = await ops.removeBlock({ path, block: splitBlocks(before)[1], expectedHash: sha256(before), label: 'x' })
  await writeFile(path, '# 用户后来改的\n')
  await assert.rejects(ops.undo(op.id), e => e.message.includes('又被改过') && e.message.includes(op.backup))
  assert.equal(await readFile(path, 'utf8'), '# 用户后来改的\n', '不覆盖用户的新改动')
})

test('append 到新文件 → undo 把文件挪进备份目录（不删除）', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'AGENTS.local.md')
  const op = await ops.append({ path, body: '- 来自 A 的约定', from: 'proj-a', label: 'w' })
  const text = await readFile(path, 'utf8')
  assert.match(text, /context-studio:begin id=\S+ from="proj-a"/)
  assert.match(text, /- 来自 A 的约定/)
  assert.equal(op.backup, null)
  await ops.undo(op.id)
  assert.equal(await pathExists(path), false)
  const moved = await readdir(join(ops.backupsDir, op.id))
  assert.deepEqual(moved, ['undone-AGENTS.local.md'])
})

test('append 到已有文件 → undo 恢复', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'AGENTS.md')
  const before = await readFile(path, 'utf8')
  const op = await ops.append({ path, body: '- x', from: 'a', label: 'w' })
  assert.ok((await readFile(path, 'utf8')).startsWith(before.trimEnd() + '\n\n<!-- context-studio:begin'))
  await ops.undo(op.id)
  assert.equal(await readFile(path, 'utf8'), before)
  await assert.rejects(ops.append({ path, body: '  ', from: 'a', label: 'w' }), /没有要写入/)
})

test('archive → undo = 取消归档；重复归档被拒', async () => {
  const { f, ops } = await setup()
  const op = await ops.archive({ sessionId: 's1', label: 'a' })
  assert.deepEqual(f.archived, ['s1'])
  await assert.rejects(ops.archive({ sessionId: 's1', label: 'a' }), /已经归档/)
  await ops.undo(op.id)
  assert.deepEqual(f.archived, [])
})

test('archive: 没有工作区服务时报错', async () => {
  const { f } = await setup()
  const ops = createOps({ dataDir: join(f.dshHome, 'cs2') })
  await assert.rejects(ops.archive({ sessionId: 's1', label: 'a' }), /没有工作区服务/)
})

test('并发操作串行执行，日志不丢', async () => {
  const { f, ops } = await setup()
  const path = join(f.projB, 'AGENTS.local.md')
  await Promise.all([1, 2, 3, 4, 5].map(i => ops.append({ path, body: `- ${i}`, from: 'a', label: `w${i}` })))
  assert.equal((await ops.readJournal()).length, 5)
  const text = await readFile(path, 'utf8')
  for (const i of [1, 2, 3, 4, 5]) assert.ok(text.includes(`- ${i}\n`))
})

test('日志损坏时另存并从空开始', async () => {
  const { ops } = await setup()
  await writeFile(ops.journalFile, '{bad json').catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(ops.journalFile, '..'), { recursive: true })
    await writeFile(ops.journalFile, '{bad json')
  })
  assert.deepEqual(await ops.readJournal(), [])
  const files = await readdir(join(ops.journalFile, '..'))
  assert.ok(files.some(n => n.startsWith('journal.json.corrupt-')))
})
