// @ts-check
/**
 * 写前日志：备份及 prepared/undo-prepared 必须先落盘，之后才改变文件/会话。
 * 恢复只核对状态，不重放业务操作；不明确的状态保留记录并阻止继续写入。
 * 实例间队列 + 协作文件锁防止本插件交错写入。崩溃遗留锁须确认进程退出后人工移除。
 * 最后校验至 rename 之间仍非 CAS：无法完全保护非协作编辑器，不承诺突然断电安全。
 */
import * as nativeFs from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { appendTransplant, removeBlock } from './markdown.js'
import { INSTRUCTION_FILES, sha256 } from './scan.js'

/** @typedef {{ id: string, kind: 'remove'|'write'|'archive', at: string, label: string,
 * path?: string, beforeHash?: string|null, afterHash?: string, backup?: string|null,
 * sessionId?: string, undone?: string, state?: 'prepared'|'committed'|'undo-prepared'|'undone'|'cancelled'|'conflict',
 * undoAt?: string, undoStash?: string, undoBackup?: string, retainedPath?: string, recovery?: string, recoveryPending?: boolean }} Op */
const MAX_JOURNAL = 200
const pending = op => op.state === 'prepared' || op.state === 'undo-prepared'
const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const codeOf = e => /** @type {any} */ (e)?.code
const hashOf = source => source === null ? null : sha256(source)
const queues = new Map()
const keyOf = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)

/** Shared across instances; filesystem locks also cover cooperating processes. */
async function serial(key, fn) {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(key, tail)
  try { return await run } finally { if (queues.get(key) === tail) queues.delete(key) }
}
async function readOrNull(fs, path) {
  try { return await fs.readFile(path, 'utf8') } catch (e) {
    if (codeOf(e) === 'ENOENT') return null
    throw e
  }
}

/** Write + fsync + close, with cleanup after partial write/sync/close failures. */
async function writeExclusive(fs, path, content) {
  let handle
  try {
    handle = await fs.open(path, 'wx', 0o600)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (e) {
    if (handle) {
      await handle.close().catch(() => {})
      await fs.rm(path, { force: true }).catch(cleanup => {
        Object.assign(e, { cleanupError: cleanup, temporaryPath: path })
      })
    }
    throw e
  }
}

/**
 * Same-directory replacement. beforeCommit runs AFTER staging and flushing.
 * exclusive uses link (no overwrite), protecting a concurrently-created target.
 * @param {string} path @param {string} content
 * @param {{fs?: typeof nativeFs, beforeCommit?: () => Promise<void>, exclusive?: boolean}} [options]
 */
export async function atomicWrite(path, content, { fs = nativeFs, beforeCommit, exclusive = false } = {}) {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.context-studio-${randomBytes(12).toString('hex')}.tmp`)
  let staged = false
  try {
    await writeExclusive(fs, tmp, content)
    staged = true
    await beforeCommit?.()
    if (exclusive) await fs.link(tmp, path)
    else await fs.rename(tmp, path)
  } catch (e) {
    if (staged) await fs.rm(tmp, { force: true }).catch(cleanup => {
      Object.assign(e, { cleanupError: cleanup, temporaryPath: tmp })
    })
    throw e
  }
  // Published writes must not become retryable failures merely due to temp cleanup.
  if (exclusive) await fs.rm(tmp, { force: true }).catch(() => {})
}
function assertInstructionFile(path) {
  if (!INSTRUCTION_FILES.includes(basename(path))) throw fail(`拒绝改动非指令文件：${path}`)
}

/** @param {{ dataDir: string, getRegistry?: () => any, now?: () => Date, fs?: typeof nativeFs }} options */
export function createOps({ dataDir, getRegistry = () => undefined, now = () => new Date(), fs = nativeFs }) {
  dataDir = resolve(dataDir)
  const journalFile = join(dataDir, 'journal.json')
  const backupsDir = join(dataDir, 'backups')
  const lockFile = join(dataDir, 'ops.lock')
  const newId = () => `${now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(12).toString('hex')}`
  const write = (path, text, options = {}) => atomicWrite(path, text, { fs, ...options })

  async function locked(path, fn) {
    return serial(keyOf(path), async () => {
      await fs.mkdir(dirname(path), { recursive: true })
      try { await writeExclusive(fs, path, JSON.stringify({ pid: process.pid, at: now().toISOString() })) } catch (e) {
        if (codeOf(e) === 'EEXIST') throw Object.assign(fail(`操作锁被占用：${path}。若上次进程已退出，请确认没有操作运行后移除该锁，再读取操作记录恢复。`), { code: 'EOPSLOCKED', lockPath: path })
        throw e
      }
      let result, error
      try { result = await fn() } catch (e) { error = e }
      try { await fs.rm(path) } catch (e) {
        const recovery = `操作锁清理失败：${path}；请确认没有操作运行后移除该锁。`
        if (error) Object.assign(error, { lockError: e })
        else if (result && !Array.isArray(result)) Object.assign(result, { recoveryPending: true, recovery })
      }
      if (error) throw error
      return result
    })
  }
  const transaction = fn => locked(lockFile, fn)
  const fileTransaction = (path, fn) => locked(join(dirname(path), `.${basename(path)}.context-studio.lock`), fn)

  async function snapshot(path) {
    try {
      const st = await fs.lstat(path)
      if (!st.isFile() || st.isSymbolicLink()) throw fail(`拒绝改动非普通文件：${path}`)
      const text = await fs.readFile(path, 'utf8')
      const after = await fs.lstat(path)
      const identity = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':')
      if (identity(st) !== identity(after)) throw fail(`文件读取期间被修改过，请刷新：${path}`)
      return { text, hash: sha256(text), identity: identity(after) }
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return { text: null, hash: null, identity: null }
      throw e
    }
  }
  async function unchanged(path, expected) {
    const current = await snapshot(path)
    if (current.hash !== expected.hash || current.identity !== expected.identity) throw fail(`文件在操作期间又被改过，未覆盖新改动，请刷新：${path}`)
  }

  async function writeJournal(ops) {
    // Pending/conflicting recovery records must never be dropped by the history cap.
    const completed = ops.filter(op => !pending(op) && op.state !== 'conflict').slice(-MAX_JOURNAL)
    const keep = new Set(completed.map(op => op.id))
    const retained = ops.filter(op => keep.has(op.id) || pending(op) || op.state === 'conflict')
    await write(journalFile, JSON.stringify({ version: 2, ops: retained }, null, 2))
  }
  async function loadJournal(readOnly = false) {
    const raw = await readOrNull(fs, journalFile)
    if (raw === null) return []
    let data, parsed = false
    try { data = JSON.parse(raw); parsed = true } catch { /* Preserve before replacing anything. */ }
    const states = new Set([undefined, 'prepared', 'committed', 'undo-prepared', 'undone', 'cancelled', 'conflict'])
    const valid = data && Array.isArray(data.ops) && new Set(data.ops.map(op => op?.id)).size === data.ops.length
      && data.ops.every(op => op && typeof op.id === 'string' && /^[\w-]+$/.test(op.id) && typeof op.label === 'string' && typeof op.at === 'string'
      && ['write', 'remove', 'archive'].includes(op.kind) && states.has(op.state)
      && (op.kind === 'archive' ? typeof op.sessionId === 'string' : typeof op.path === 'string' && typeof op.afterHash === 'string'
        && (op.beforeHash === null ? op.backup === null : typeof op.beforeHash === 'string' && typeof op.backup === 'string')
        && (op.state !== 'undo-prepared' || op.beforeHash !== null || (typeof op.undoStash === 'string' && typeof op.undoBackup === 'string'))))
    if (valid && (data.version === 1 || data.version === 2)) return data.ops
    if (readOnly) throw fail(`操作日志不可解析，且操作锁被占用；未改动原日志：${journalFile}`)
    const preserved = `${journalFile}.corrupt-${newId()}`
    try {
      await fs.copyFile(journalFile, preserved, constants.COPYFILE_EXCL)
      const handle = await fs.open(preserved, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      const [original, copy] = await Promise.all([fs.readFile(journalFile), fs.readFile(preserved)])
      if (!original.equals(copy) || original.toString('utf8') !== raw) throw new Error('损坏日志备份校验失败或原日志已变化')
    } catch (e) {
      throw new Error(`操作日志损坏且保全失败，未执行业务修改。原日志：${journalFile}；保全路径：${preserved}`, { cause: e })
    }
    // Unknown schemas may contain future recovery records: preserve and fail closed.
    if (parsed) throw fail(`操作日志结构或版本不受支持，未覆盖原日志；副本：${preserved}`)
    await writeJournal([])
    return []
  }
  function archiveState(id) {
    const ids = getRegistry()?.archivedSessionIds
    return Array.isArray(ids) ? ids.map(String).includes(id) : undefined
  }
  async function reconcile(op) {
    if (!pending(op)) return false
    const undoing = op.state === 'undo-prepared'
    let before, after
    if (op.kind === 'archive') {
      const archived = archiveState(op.sessionId)
      if (archived === undefined) {
        op.recovery = `无法核对归档状态；准备记录 ${op.id} 保留在 ${journalFile}，请恢复工作区服务后重试。`
        return false
      }
      before = archived === undoing
      after = !before
    } else {
      const current = await snapshot(op.path)
      before = current.hash === (undoing ? op.afterHash : op.beforeHash)
      after = current.hash === (undoing ? op.beforeHash : op.afterHash)
      if (undoing && op.beforeHash === null && after) {
        // Absence alone does not prove undo; require retained moved content.
        after = false
        for (const path of [op.undoBackup, op.undoStash].filter(Boolean)) {
          const saved = await readOrNull(fs, path)
          if (saved !== null && sha256(saved) === op.afterHash) { after = true; op.retainedPath = path }
        }
      }
    }
    if (after) {
      op.state = undoing ? 'undone' : 'committed'
      if (undoing) op.undone = op.undoAt ?? now().toISOString()
      delete op.recovery
    } else if (before) {
      op.state = undoing ? 'committed' : 'cancelled'
      op.recovery = '准备阶段之后业务状态未改变，未自动重放操作。'
    } else {
      op.state = 'conflict'
      op.recovery = `实际状态与准备记录不符，未覆盖或重放。请人工核对 ${op.path ?? op.sessionId}；记录：${journalFile}；备份：${op.backup ?? op.undoBackup ?? '无'}；暂存：${op.undoStash ?? '无'}。`
    }
    return true
  }
  async function recover(strict) {
    const ops = await loadJournal()
    let changed = false
    for (const op of ops) if (await reconcile(op)) changed = true
    if (changed) {
      try { await writeJournal(ops) } catch (e) {
        if (strict) throw new Error(`恢复状态无法写入，未执行新的业务修改。准备记录仍在 ${journalFile}`, { cause: e })
        for (const op of ops) Object.assign(op, { recoveryPending: true, recovery: `状态已核对，日志提交待恢复：${journalFile}` })
      }
    }
    if (strict && ops.some(op => pending(op))) throw fail(`存在无法核对的准备记录，请先恢复依赖并读取 ${journalFile}`)
    return ops
  }
  async function backup(id, path, source) {
    if (source === null) return null
    const dest = join(backupsDir, id, basename(path))
    await write(dest, source, { exclusive: true })
    await write(join(backupsDir, id, 'ORIGINAL_PATH.txt'), path, { exclusive: true })
    return dest
  }
  async function complete(ops, op, state, recovery) {
    op.state = state
    if (state === 'undone') op.undone = op.undoAt
    if (recovery) op.recovery = recovery
    else delete op.recovery
    try { await writeJournal(ops) } catch {
      // Preparation is already durable. Do not report a retryable write failure.
      Object.assign(op, { recoveryPending: true, recovery: `业务已生效；准备记录已保存，日志提交待恢复：${journalFile}（${op.id}）` })
    }
    return op
  }
  async function perform(ops, op, mutate, done) {
    try { await mutate() } catch (e) {
      try {
        await reconcile(op)
        if (op.state === done) return complete(ops, op, done, `业务状态已核对，未重复执行；${e.message}。保全位置：${op.retainedPath ?? op.backup ?? journalFile}`)
        await writeJournal(ops)
      } catch { /* Original durable preparation remains available. */ }
      throw Object.assign(new Error(`${e.message}；操作记录 ${op.id} 已保留在 ${journalFile}，请先刷新操作记录核对状态。`, { cause: e }), { status: e.status ?? 500, opId: op.id, journalFile })
    }
    return complete(ops, op, done)
  }
  function assertNoConflict(ops, path, sessionId) {
    const conflict = ops.find(op => op.state === 'conflict' && (path ? op.path && keyOf(op.path) === keyOf(path) : op.sessionId === sessionId))
    if (conflict) throw fail(`存在待人工核对的冲突 ${conflict.id}，未执行新修改。${conflict.recovery}`)
  }
  async function edit(input, removing) {
    input = { ...input, path: resolve(input.path) }
    assertInstructionFile(input.path)
    return transaction(() => fileTransaction(input.path, async () => {
      const ops = await recover(true)
      assertNoConflict(ops, input.path)
      const source = await snapshot(input.path)
      if (removing && source.text === null) throw fail('文件已不存在，请刷新')
      if (removing && source.hash !== input.expectedHash) throw fail('文件在你上次刷新后被修改过，请刷新后再移除')
      if (!removing && !input.body.trim()) throw fail('没有要写入的内容')
      const id = newId()
      const next = removing ? removeBlock(source.text, input.block) : appendTransplant(source.text ?? '', input.body, { id, from: input.from, at: now().toISOString().slice(0, 10) })
      const bak = await backup(id, input.path, source.text)
      const op = { id, kind: removing ? 'remove' : 'write', at: now().toISOString(), label: input.label,
        path: input.path, beforeHash: source.hash, afterHash: sha256(next), backup: bak, state: 'prepared' }
      ops.push(op)
      await writeJournal(ops)
      return perform(ops, op, () => write(input.path, next, { exclusive: source.text === null, beforeCommit: () => unchanged(input.path, source) }), 'committed')
    }))
  }
  async function retainNewFile(op, current) {
    await unchanged(op.path, current)
    // Capture on the same volume first; never copy then delete a live source.
    await fs.rename(op.path, op.undoStash)
    op.retainedPath = op.undoStash
    const captured = await snapshot(op.undoStash)
    if (captured.hash !== op.afterHash) {
      await fs.link(op.undoStash, op.path).catch(() => {})
      throw fail(`撤销期间文件被改过，已保留实际内容：${op.undoStash}`)
    }
    await fs.mkdir(dirname(op.undoBackup), { recursive: true })
    try {
      await fs.rename(op.undoStash, op.undoBackup)
      op.retainedPath = op.undoBackup
    } catch (e) {
      if (codeOf(e) !== 'EXDEV') throw e
      await fs.copyFile(op.undoStash, op.undoBackup, constants.COPYFILE_EXCL)
      const handle = await fs.open(op.undoBackup, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      if (hashOf(await readOrNull(fs, op.undoBackup)) !== captured.hash) throw new Error(`撤销备份校验失败；原内容仍在 ${op.undoStash}`)
      // Preserve the stash on EXDEV: external open handles can still modify it.
    }
  }

  // Legacy UI only renders label/undone. Do not fake undone for cancelled/conflicting ops.
  function journalView(ops) {
    const rows = ops.map(op => {
      const prefix = op.state === 'cancelled' ? '未生效' : op.state === 'conflict' ? '待人工核对'
        : op.state === 'prepared' ? '待核对' : op.state === 'undo-prepared' ? '撤销待核对'
          : op.recoveryPending ? (op.undone ? '已撤销，记录待恢复' : '记录待恢复') : ''
      return { ...op, label: prefix ? `${prefix} · ${op.label}` : op.label, backup: op.backup ?? op.retainedPath ?? null,
        canUndo: !op.undone && (!op.state || op.state === 'committed') && !op.recoveryPending }
    })
    // Host reverses this list; keep recovery records visible ahead of ordinary history.
    const attention = op => pending(op) || op.state === 'conflict' || op.recoveryPending
    return [...rows.filter(op => !attention(op)), ...rows.filter(attention)]
  }

  async function readJournal() {
    try { return journalView(await transaction(() => recover(false))) } catch (e) {
      if (codeOf(e) !== 'EOPSLOCKED') throw e
      // A crashed/busy writer must not hide its durable preparation from the UI.
      const ops = await loadJournal(true)
      return journalView(ops.map(op => ({ ...op, recoveryPending: true, recovery: e.message })))
    }
  }

  return {
    journalFile, backupsDir, lockFile,
    readJournal,
    removeBlock: input => edit(input, true),
    append: input => edit(input, false),
    archive: input => transaction(async () => {
      const ops = await recover(true)
      assertNoConflict(ops, null, input.sessionId)
      const registry = getRegistry()
      if (!registry?.archiveSession) throw new Error('当前环境没有工作区服务，无法归档')
      if (archiveState(input.sessionId)) throw fail('这个会话已经归档了')
      const op = { id: newId(), kind: 'archive', at: now().toISOString(), label: input.label, sessionId: input.sessionId, state: 'prepared' }
      ops.push(op)
      await writeJournal(ops)
      return perform(ops, op, () => registry.archiveSession(input.sessionId), 'committed')
    }),
    undo: opId => transaction(async () => {
      const ops = await recover(true)
      const op = ops.find(o => o.id === opId)
      if (!op) throw fail('找不到这条操作记录')
      if (op.undone) throw fail('这条操作已经撤销过了')
      if (op.state === 'cancelled' || op.state === 'conflict') throw fail(`这条操作未生效或需要人工核对，不能自动撤销。${op.recovery ?? ''}`)
      if (op.kind === 'archive') {
        const registry = getRegistry()
        if (!registry?.unarchiveSession) throw new Error('当前环境没有工作区服务，无法取消归档')
        op.state = 'undo-prepared'; op.undoAt = now().toISOString()
        await writeJournal(ops)
        return perform(ops, op, () => registry.unarchiveSession(op.sessionId), 'undone')
      }
      assertInstructionFile(op.path)
      return fileTransaction(op.path, async () => {
        assertNoConflict(ops, op.path)
        const current = await snapshot(op.path)
        const hint = op.backup ? `备份在 ${op.backup}` : ''
        if (current.text === null) throw fail(`文件已不存在，无法自动撤销。${hint}`)
        if (current.hash !== op.afterHash) throw fail(`文件在这次操作之后又被改过，未覆盖新改动。${hint}`)
        const original = op.backup ? await fs.readFile(op.backup, 'utf8') : null
        if (op.backup && hashOf(original) !== op.beforeHash) throw fail('备份文件已损坏，未撤销')
        op.state = 'undo-prepared'; op.undoAt = now().toISOString()
        if (!op.backup) {
          op.undoStash = join(dirname(op.path), `.${basename(op.path)}.context-studio-${op.id}.undo`)
          op.undoBackup = join(backupsDir, op.id, `undone-${basename(op.path)}`)
        }
        await writeJournal(ops)
        return perform(ops, op, () => op.backup
          ? write(op.path, original, { beforeCommit: () => unchanged(op.path, current) })
          : retainNewFile(op, current), 'undone')
      })
    }),
  }
}

/** 测试用：确认路径存在。 @param {string} path */
export async function pathExists(path) {
  try { await nativeFs.stat(path); return true } catch { return false }
}
