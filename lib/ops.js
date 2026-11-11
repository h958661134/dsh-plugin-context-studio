// @ts-check
/**
 * 会改动用户东西的操作：移除指令块、追加拼入内容、归档会话，以及撤销。
 *
 * 保守原则：
 *   - 改文件前核对哈希（必须和扫描时一致），并把原文件完整备份到 backups/<opId>/；
 *   - 原子写（同目录临时文件 + rename），保留换行风格；
 *   - 撤销前核对文件当前哈希必须等于操作后的哈希，否则拒绝，并告诉用户备份在哪；
 *   - 从不物理删除：撤销一次「新建文件」时，把文件挪进备份目录而不是删掉；会话只归档。
 */

import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { appendTransplant, removeBlock } from './markdown.js'
import { INSTRUCTION_FILES, sha256 } from './scan.js'

/**
 * @typedef {{
 *   id: string,
 *   kind: 'remove' | 'write' | 'archive',
 *   at: string,
 *   label: string,
 *   path?: string,
 *   beforeHash?: string | null,
 *   afterHash?: string,
 *   backup?: string | null,
 *   sessionId?: string,
 *   undone?: string,
 * }} Op
 */

const MAX_JOURNAL = 200

/** @param {string} path */
async function readOrNull(path) {
  try { return await readFile(path, 'utf8') } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') return null
    throw e
  }
}

/** 原子写。 @param {string} path @param {string} content */
export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.context-studio-${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(tmp, content, 'utf8')
  try {
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

/** 跨盘也能用的「挪走」：先复制并核对，再删除源。 @param {string} from @param {string} to */
async function moveFile(from, to) {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    await copyFile(from, to)
    const [a, b] = await Promise.all([readFile(from), readFile(to)])
    if (!a.equals(b)) throw new Error('备份校验失败，未移动文件')
    await rm(from)
  }
}

/** @param {string} path */
function assertInstructionFile(path) {
  if (!INSTRUCTION_FILES.includes(basename(path))) throw new Error(`拒绝改动非指令文件：${path}`)
}

/**
 * @param {{ dataDir: string, getRegistry?: () => any, now?: () => Date }} options
 */
export function createOps({ dataDir, getRegistry = () => undefined, now = () => new Date() }) {
  const journalFile = join(dataDir, 'journal.json')
  const backupsDir = join(dataDir, 'backups')
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve()
  /** 串行执行，避免两个操作交错改同一个文件。 @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = fn => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  /** @returns {Promise<Op[]>} */
  async function readJournal() {
    const raw = await readOrNull(journalFile)
    if (!raw) return []
    try {
      const data = JSON.parse(raw)
      return Array.isArray(data?.ops) ? data.ops : []
    } catch {
      // 日志损坏：另存一份再从空开始，不丢用户的东西
      await moveFile(journalFile, `${journalFile}.corrupt-${Date.now()}`).catch(() => {})
      return []
    }
  }
  /** @param {Op[]} ops */
  async function writeJournal(ops) {
    await atomicWrite(journalFile, JSON.stringify({ version: 1, ops: ops.slice(-MAX_JOURNAL) }, null, 2))
  }
  /** @param {Op} op */
  async function record(op) {
    const ops = await readJournal()
    ops.push(op)
    await writeJournal(ops)
    return op
  }
  const newId = () => `${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`

  /**
   * 备份整份文件；文件不存在时返回 null。
   * @param {string} opId @param {string} path @param {string | null} content
   */
  async function backup(opId, path, content) {
    if (content === null) return null
    const dest = join(backupsDir, opId, basename(path))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, content, 'utf8')
    await writeFile(join(backupsDir, opId, 'ORIGINAL_PATH.txt'), path, 'utf8')
    return dest
  }

  return {
    journalFile,
    backupsDir,
    readJournal,

    /**
     * 从指令文件里移除一块。
     * @param {{ path: string, block: import('./markdown.js').Block, expectedHash: string, label: string }} input
     */
    removeBlock: input => serial(async () => {
      assertInstructionFile(input.path)
      const source = await readOrNull(input.path)
      if (source === null) throw new Error('文件已不存在，请刷新')
      if (sha256(source) !== input.expectedHash) throw new Error('文件在你上次刷新后被修改过，请刷新后再移除')
      const next = removeBlock(source, input.block)
      const id = newId()
      const bak = await backup(id, input.path, source)
      await atomicWrite(input.path, next)
      return record({ id, kind: 'remove', at: now().toISOString(), label: input.label, path: input.path, beforeHash: sha256(source), afterHash: sha256(next), backup: bak })
    }),

    /**
     * 把一段内容（带来源标记）追加到目标指令文件，文件不存在就新建。
     * @param {{ path: string, body: string, from: string, label: string }} input
     */
    append: input => serial(async () => {
      assertInstructionFile(input.path)
      if (!input.body.trim()) throw new Error('没有要写入的内容')
      const source = await readOrNull(input.path)
      const id = newId()
      const next = appendTransplant(source ?? '', input.body, { id, from: input.from, at: now().toISOString().slice(0, 10) })
      const bak = await backup(id, input.path, source)
      await atomicWrite(input.path, next)
      return record({ id, kind: 'write', at: now().toISOString(), label: input.label, path: input.path, beforeHash: source === null ? null : sha256(source), afterHash: sha256(next), backup: bak })
    }),

    /**
     * 归档会话（DSH 原生，可取消归档）。
     * @param {{ sessionId: string, label: string }} input
     */
    archive: input => serial(async () => {
      const registry = getRegistry()
      if (!registry?.archiveSession) throw new Error('当前环境没有工作区服务，无法归档')
      if ((registry.archivedSessionIds ?? []).map(String).includes(input.sessionId)) throw new Error('这个会话已经归档了')
      // 不传 stopActivity：会话正在运行时 DSH 会拒绝，而不是替用户停掉它
      await registry.archiveSession(input.sessionId)
      return record({ id: newId(), kind: 'archive', at: now().toISOString(), label: input.label, sessionId: input.sessionId })
    }),

    /** @param {string} opId */
    undo: opId => serial(async () => {
      const ops = await readJournal()
      const op = ops.find(o => o.id === opId)
      if (!op) throw new Error('找不到这条操作记录')
      if (op.undone) throw new Error('这条操作已经撤销过了')
      if (op.kind === 'archive') {
        const registry = getRegistry()
        if (!registry?.unarchiveSession) throw new Error('当前环境没有工作区服务，无法取消归档')
        await registry.unarchiveSession(op.sessionId)
      } else {
        const path = /** @type {string} */ (op.path)
        assertInstructionFile(path)
        const current = await readOrNull(path)
        const hint = op.backup ? `备份在 ${op.backup}` : ''
        if (current === null) throw new Error(`文件已不存在，无法自动撤销。${hint}`)
        if (sha256(current) !== op.afterHash) throw new Error(`文件在这次操作之后又被改过，为了不覆盖新改动，没有自动撤销。${hint}`)
        if (op.backup) {
          const original = await readFile(op.backup, 'utf8')
          if (op.beforeHash && sha256(original) !== op.beforeHash) throw new Error('备份文件已损坏，未撤销')
          await atomicWrite(path, original)
        } else {
          // 这次操作新建了文件：撤销 = 挪进备份目录（不删）
          await moveFile(path, join(backupsDir, op.id, `undone-${basename(path)}`))
        }
      }
      op.undone = now().toISOString()
      await writeJournal(ops)
      return op
    }),
  }
}

/** 测试用：确认路径存在。 @param {string} p */
export async function pathExists(p) {
  try { await stat(p); return true } catch { return false }
}
