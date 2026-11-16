import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { atomicWrite, createOps } from '../lib/ops.js'
import { splitBlocks } from '../lib/markdown.js'
import { sha256 } from '../lib/scan.js'

const injected = code => Object.assign(new Error(`injected ${code}`), { code })
const readOps = async path => JSON.parse(await fs.readFile(path, 'utf8')).ops
const appendInput = path => ({ path, body: '- added', from: 'synthetic', label: 'append' })

// Per-instance hooks: tests never monkey-patch builtins or touch real user files.
function instrument(hook) {
  const io = { ...fs }
  for (const method of ['mkdir', 'readFile', 'lstat', 'rename', 'link', 'copyFile', 'rm']) {
    io[method] = (...args) => hook({ method, path: args[0], to: args[1], args }, () => fs[method](...args))
  }
  io.open = async (path, ...args) => {
    const handle = await hook({ method: 'open', path, args }, () => fs.open(path, ...args))
    return new Proxy(handle, { get(target, prop) {
      if (['writeFile', 'sync', 'close'].includes(prop)) return (...args) => hook({ method: prop, path, args }, () => target[prop](...args))
      const value = target[prop]
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  return io
}

async function setup(t, hook = (_event, next) => next()) {
  const root = await fs.mkdtemp(join(tmpdir(), 'csx-ops-'))
  // Only remove the exact fixture allocated under the system temp directory.
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'state'), project = join(root, 'project')
  await fs.mkdir(project)
  const path = join(project, 'AGENTS.md'), fresh = join(project, 'AGENTS.local.md')
  const original = '# project\n- original\n'
  await fs.writeFile(path, original)
  const archived = []
  const calls = { archive: 0, undo: 0 }
  const registry = {
    archivedSessionIds: archived,
    async archiveSession(id) { calls.archive++; if (!archived.includes(id)) archived.push(id) },
    async unarchiveSession(id) { calls.undo++; const i = archived.indexOf(id); if (i >= 0) archived.splice(i, 1) },
  }
  const options = { dataDir, getRegistry: () => registry }
  const ops = createOps({ ...options, fs: instrument(hook) })
  return { root, dataDir, project, path, fresh, original, archived, registry, calls, options, ops }
}

for (const stage of ['writeFile', 'sync', 'rename']) {
  test(`prepare journal ${stage} failure: no append/remove/archive side effects`, async t => {
    for (const kind of ['append', 'remove', 'archive']) {
      const f = await setup(t, async (e, next) => {
        if ((stage === 'rename' && e.method === stage && basename(e.to) === 'journal.json')
          || (stage !== 'rename' && e.method === stage && basename(e.path).startsWith('.journal.json.'))) {
          if (stage === 'writeFile') await fs.writeFile(e.path, 'partial')
          throw injected('ENOSPC')
        }
        return next()
      })
      const call = kind === 'append' ? f.ops.append(appendInput(f.path))
        : kind === 'remove' ? f.ops.removeBlock({ path: f.path, block: splitBlocks(f.original)[1], expectedHash: sha256(f.original), label: 'remove' })
          : f.ops.archive({ sessionId: 's1', label: 'archive' })
      await assert.rejects(call, /ENOSPC/)
      assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
      assert.equal(f.calls.archive, 0)
      assert.ok(!(await fs.readdir(f.dataDir)).some(name => name.endsWith('.tmp')))
    }
  })
}

test('backup fsync failure prevents both prepared record and mutation', async t => {
  const f = await setup(t, (e, next) => {
    if (e.method === 'sync' && e.path.includes(`${join('state', 'backups')}`)) throw injected('EIO')
    return next()
  })
  await assert.rejects(f.ops.append(appendInput(f.path)), /EIO/)
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
  await assert.rejects(fs.readFile(f.ops.journalFile), { code: 'ENOENT' })
})

for (const kind of ['append', 'remove', 'archive']) {
  test(`${kind}: final journal failure returns recorded success; restart recovers without replay`, async t => {
    let journalRenames = 0
    const f = await setup(t, async (e, next) => {
      if (e.method === 'rename' && basename(e.to) === 'journal.json' && ++journalRenames > 1) throw injected('ENOSPC')
      // At the exact business boundary, a flushed preparation must already be readable.
      if (e.method === 'rename' && e.to === f.path) assert.equal((await readOps(f.ops.journalFile))[0].state, 'prepared')
      return next()
    })
    const op = kind === 'append' ? await f.ops.append(appendInput(f.path))
      : kind === 'remove' ? await f.ops.removeBlock({ path: f.path, block: splitBlocks(f.original)[1], expectedHash: sha256(f.original), label: 'remove' })
        : await f.ops.archive({ sessionId: 's1', label: 'archive' })
    assert.equal(op.state, 'committed')
    assert.equal(op.recoveryPending, true)
    assert.equal((await readOps(f.ops.journalFile))[0].state, 'prepared')
    const after = await fs.readFile(f.path, 'utf8')
    const visible = await f.ops.readJournal()
    assert.equal(visible[0].state, 'committed')
    assert.equal(visible[0].recoveryPending, true)
    await assert.rejects(f.ops.append(appendInput(f.path)), /恢复状态无法写入/)
    assert.equal(await fs.readFile(f.path, 'utf8'), after)
    const freshOps = createOps(f.options)
    const recovered = await freshOps.readJournal()
    assert.equal(recovered[0].state, 'committed')
    assert.equal(recovered[0].id, op.id)
    assert.equal(await fs.readFile(f.path, 'utf8'), after)
    if (kind === 'archive') assert.equal(f.calls.archive, 1)
    await freshOps.undo(op.id)
    assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
    assert.deepEqual(f.archived, [])
  })
}

for (const kind of ['existing', 'new', 'archive']) {
  for (const boundary of ['prepare', 'commit']) {
    test(`undo ${kind}: ${boundary} journal failure keeps a recoverable state`, async t => {
      let enabled = false, writes = 0
      const f = await setup(t, (e, next) => {
        if (enabled && e.method === 'rename' && basename(e.to) === 'journal.json' && ++writes >= (boundary === 'prepare' ? 1 : 2)) throw injected('ENOSPC')
        return next()
      })
      const target = kind === 'new' ? f.fresh : f.path
      const op = kind === 'archive' ? await f.ops.archive({ sessionId: 's1', label: 'archive' }) : await f.ops.append(appendInput(target))
      const after = kind === 'archive' ? null : await fs.readFile(target, 'utf8')
      enabled = true
      if (boundary === 'prepare') {
        await assert.rejects(f.ops.undo(op.id), /ENOSPC/)
        if (after !== null) assert.equal(await fs.readFile(target, 'utf8'), after)
        else assert.equal(f.calls.undo, 0)
        assert.equal((await readOps(f.ops.journalFile))[0].state, 'committed')
      } else {
        const undone = await f.ops.undo(op.id)
        assert.ok(undone.undone)
        assert.equal(undone.recoveryPending, true)
        assert.equal((await readOps(f.ops.journalFile))[0].state, 'undo-prepared')
        const recovered = (await createOps(f.options).readJournal())[0]
        assert.equal(recovered.state, 'undone')
        assert.ok(recovered.undone)
        await assert.rejects(createOps(f.options).undo(op.id), /已经撤销/)
        if (kind === 'existing') assert.equal(await fs.readFile(target, 'utf8'), f.original)
        if (kind === 'new') assert.equal(await fs.readFile(recovered.undoBackup, 'utf8'), after)
        if (kind === 'archive') assert.equal(f.calls.undo, 1)
      }
    })
  }
}

test('business write failure is recorded as cancelled; restart never replays it', async t => {
  const f = await setup(t, (e, next) => {
    if (e.method === 'rename' && e.to === f.path) throw injected('EACCES')
    return next()
  })
  await assert.rejects(f.ops.append(appendInput(f.path)), /EACCES.*操作记录/)
  const op = (await createOps(f.options).readJournal())[0]
  assert.equal(op.state, 'cancelled')
  await assert.rejects(f.ops.undo(op.id), /未生效/)
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
})

test('archive mutates then rejects: reconcile records success without a second service call', async t => {
  const f = await setup(t)
  f.registry.archiveSession = async id => { f.calls.archive++; f.archived.push(id); throw injected('EIO') }
  const op = await f.ops.archive({ sessionId: 's1', label: 'archive' })
  assert.equal(op.state, 'committed')
  assert.equal(f.calls.archive, 1)
  assert.equal((await f.ops.readJournal())[0].state, 'committed')
})

for (const failure of ['copy', 'verify', 'sync', 'source-change']) {
  test(`corrupt journal ${failure} failure: original is never replaced`, async t => {
    const f = await setup(t, async (e, next) => {
      if (failure === 'copy' && e.method === 'copyFile' && e.to.includes('.corrupt-')) throw injected('EACCES')
      if (failure === 'sync' && e.method === 'sync' && e.path.includes('.corrupt-')) throw injected('EIO')
      if (failure === 'verify' && e.method === 'copyFile' && e.to.includes('.corrupt-')) { await next(); await fs.writeFile(e.to, 'wrong'); return }
      if (failure === 'source-change' && e.method === 'copyFile' && e.to.includes('.corrupt-')) await fs.writeFile(e.path, '{"version":2,"ops":[]}')
      return next()
    })
    await fs.mkdir(f.dataDir, { recursive: true })
    await fs.writeFile(f.ops.journalFile, '{bad json')
    await assert.rejects(f.ops.append(appendInput(f.path)), /保全失败/)
    assert.equal(await fs.readFile(f.ops.journalFile, 'utf8'), failure === 'source-change' ? '{"version":2,"ops":[]}' : '{bad json')
    assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
  })
}

test('parseable unknown journal schema is preserved and blocks writes', async t => {
  const f = await setup(t)
  await fs.mkdir(f.dataDir)
  const raw = JSON.stringify({ version: 999, ops: [] })
  await fs.writeFile(f.ops.journalFile, raw)
  await assert.rejects(f.ops.append(appendInput(f.path)), /结构或版本不受支持/)
  assert.equal(await fs.readFile(f.ops.journalFile, 'utf8'), raw)
  const preserved = (await fs.readdir(f.dataDir)).find(name => name.includes('.corrupt-'))
  assert.equal(await fs.readFile(join(f.dataDir, preserved), 'utf8'), raw)
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
})

test('parseable null and records missing undo metadata fail closed', async t => {
  const f = await setup(t)
  await fs.mkdir(f.dataDir)
  for (const raw of ['null', JSON.stringify({ version: 1, ops: [{ id: 'bad', kind: 'write', label: 'bad', at: '2026', path: f.path, afterHash: sha256(f.original) }] })]) {
    await fs.writeFile(f.ops.journalFile, raw)
    await assert.rejects(f.ops.append(appendInput(f.path)), /结构或版本不受支持/)
    assert.equal(await fs.readFile(f.ops.journalFile, 'utf8'), raw)
    assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
  }
})

test('version 1 operations remain visible and undoable after journal upgrade', async t => {
  const f = await setup(t)
  const op = await f.ops.append(appendInput(f.path))
  delete op.state
  await fs.writeFile(f.ops.journalFile, JSON.stringify({ version: 1, ops: [op] }))
  const old = (await f.ops.readJournal())[0]
  assert.equal(old.canUndo, true)
  await f.ops.undo(op.id)
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
  const upgraded = JSON.parse(await fs.readFile(f.ops.journalFile, 'utf8'))
  assert.equal(upgraded.version, 2)
  assert.equal(upgraded.ops[0].state, 'undone')
})

for (const stage of ['writeFile', 'sync', 'rename']) {
  test(`atomicWrite cleans temporary files on ${stage} failure`, async t => {
    const f = await setup(t)
    const io = instrument(async (e, next) => {
      if (e.method === stage && (stage === 'rename' || e.path.endsWith('.tmp'))) {
        if (stage === 'writeFile') await fs.writeFile(e.path, 'partial')
        throw injected('ENOSPC')
      }
      return next()
    })
    await assert.rejects(atomicWrite(f.path, 'replacement', { fs: io }), /ENOSPC/)
    assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
    assert.ok(!(await fs.readdir(f.project)).some(name => name.endsWith('.tmp')))
  })
}

test('atomicWrite cleanup failure retains the primary error and recovery path', async t => {
  const f = await setup(t)
  const io = instrument(async (e, next) => {
    if (e.method === 'writeFile' && e.path.endsWith('.tmp')) { await fs.writeFile(e.path, 'partial'); throw injected('ENOSPC') }
    if (e.method === 'rm' && e.path.endsWith('.tmp')) throw injected('EACCES')
    return next()
  })
  await assert.rejects(atomicWrite(f.path, 'replacement', { fs: io }), e => e.code === 'ENOSPC' && e.cleanupError.code === 'EACCES' && e.temporaryPath.endsWith('.tmp'))
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
})

for (const action of ['append', 'remove', 'undo']) {
  test(`${action}: external edit during staging is detected and retained`, async t => {
    let inject = false
    const f = await setup(t, async (e, next) => {
      if (inject && e.method === 'sync' && dirname(e.path) === f.project && e.path.endsWith('.tmp')) {
        inject = false
        await fs.writeFile(f.path, '# edited externally\n')
      }
      return next()
    })
    let op
    if (action === 'undo') op = await f.ops.append(appendInput(f.path))
    inject = true
    const work = action === 'undo' ? f.ops.undo(op.id) : action === 'append' ? f.ops.append(appendInput(f.path))
      : f.ops.removeBlock({ path: f.path, block: splitBlocks(f.original)[1], expectedHash: sha256(f.original), label: 'remove' })
    await assert.rejects(work, /又被改过/)
    assert.equal(await fs.readFile(f.path, 'utf8'), '# edited externally\n')
    assert.equal((await f.ops.readJournal())[0].state, 'conflict')
    await assert.rejects(f.ops.append(appendInput(f.path)), /人工核对的冲突/)
  })
}

test('new file publication does not overwrite a file created after the final check', async t => {
  const f = await setup(t, async (e, next) => {
    if (e.method === 'link' && e.to === f.fresh) await fs.writeFile(f.fresh, 'external creation')
    return next()
  })
  await assert.rejects(f.ops.append(appendInput(f.fresh)), /EEXIST/)
  assert.equal(await fs.readFile(f.fresh, 'utf8'), 'external creation')
  assert.equal((await f.ops.readJournal())[0].state, 'conflict')
})

test('undo new file captures a last-window external edit without losing it', async t => {
  let inject = false
  const f = await setup(t, async (e, next) => {
    if (inject && e.method === 'rename' && e.path === f.fresh) { inject = false; await fs.writeFile(f.fresh, 'late edit') }
    return next()
  })
  const op = await f.ops.append(appendInput(f.fresh))
  inject = true
  await assert.rejects(f.ops.undo(op.id), /已保留实际内容/)
  assert.equal(await fs.readFile(f.fresh, 'utf8'), 'late edit')
  const saved = (await f.ops.readJournal())[0]
  assert.equal(saved.state, 'conflict')
  assert.equal(await fs.readFile(saved.undoStash, 'utf8'), 'late edit')
})

test('undo cross-volume fallback preserves the captured source and validates the copy', async t => {
  const f = await setup(t, (e, next) => {
    if (e.method === 'rename' && e.path.endsWith('.undo')) throw injected('EXDEV')
    return next()
  })
  const op = await f.ops.append(appendInput(f.fresh))
  const text = await fs.readFile(f.fresh, 'utf8')
  const undone = await f.ops.undo(op.id)
  assert.equal(undone.state, 'undone')
  assert.equal(await fs.readFile(undone.undoBackup, 'utf8'), text)
  assert.equal(await fs.readFile(undone.undoStash, 'utf8'), text)
  await assert.rejects(fs.readFile(f.fresh), { code: 'ENOENT' })
})

test('undo destination copy failure still exposes the captured source for recovery', async t => {
  const f = await setup(t, (e, next) => {
    if (e.method === 'rename' && e.path.endsWith('.undo')) throw injected('EXDEV')
    if (e.method === 'copyFile' && e.path.endsWith('.undo')) throw injected('ENOSPC')
    return next()
  })
  const op = await f.ops.append(appendInput(f.fresh))
  const text = await fs.readFile(f.fresh, 'utf8')
  const undone = await f.ops.undo(op.id)
  assert.equal(undone.state, 'undone')
  assert.equal(await fs.readFile(undone.undoStash, 'utf8'), text)
  await assert.rejects(fs.readFile(f.fresh), { code: 'ENOENT' })
  const visible = (await createOps(f.options).readJournal())[0]
  assert.equal(visible.undone, undone.undone)
  assert.equal(visible.backup, undone.undoStash, 'legacy UI receives the actual retained path')
  assert.match(visible.recovery, /ENOSPC/)
})

test('same-content external replacement is detected by file identity', async t => {
  let changed = false
  const f = await setup(t, async (e, next) => {
    if (!changed && e.method === 'sync' && dirname(e.path) === f.project && e.path.endsWith('.tmp')) {
      changed = true
      const alternate = join(f.project, 'external.md')
      await fs.writeFile(alternate, f.original)
      await fs.rename(alternate, f.path)
    }
    return next()
  })
  await assert.rejects(f.ops.append(appendInput(f.path)), /又被改过/)
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
  assert.equal((await f.ops.readJournal())[0].state, 'cancelled')
})

test('legacy journal view exposes safe undo eligibility without misusing undone', async t => {
  const f = await setup(t)
  const op = await f.ops.append(appendInput(f.path))
  assert.equal((await f.ops.readJournal())[0].canUndo, true)
  await f.ops.undo(op.id)
  const undone = (await f.ops.readJournal())[0]
  assert.ok(undone.undone)
  assert.equal(undone.canUndo, false)
  const states = ['prepared', 'undo-prepared', 'cancelled', 'conflict']
  const archived = states.map((state, i) => ({ id: `ui-${i}`, state, kind: 'archive', at: '2026', label: state, sessionId: 's1' }))
  await fs.writeFile(f.ops.journalFile, JSON.stringify({ version: 2, ops: archived }))
  await fs.writeFile(f.ops.lockFile, 'busy')
  const view = await f.ops.readJournal()
  for (const row of view) {
    assert.equal(row.canUndo, false)
    assert.equal(row.undone, undefined, 'do not falsely mark failed or pending operations as undone')
    assert.notEqual(row.label, row.state)
  }
  await assert.rejects(f.ops.undo('ui-0'), /操作锁被占用/)
  assert.deepEqual((await readOps(f.ops.journalFile)).map(op => op.state), states, 'read-only lock fallback does not rewrite the journal')
})

test('instances sharing a journal, and different journals sharing a file, do not lose updates', async t => {
  const f = await setup(t)
  const shared = createOps(f.options)
  const other = createOps({ ...f.options, dataDir: join(f.root, 'other-state') })
  await Promise.all(Array.from({ length: 9 }, (_, i) => [f.ops, shared, other][i % 3].append({ ...appendInput(f.path), body: `unique-${i}` })))
  const text = await fs.readFile(f.path, 'utf8')
  for (let i = 0; i < 9; i++) assert.equal(text.split(`unique-${i}`).length - 1, 1)
  assert.equal((await f.ops.readJournal()).length, 6)
  assert.equal((await other.readJournal()).length, 3)
})

test('a filesystem lock blocks a second process/instance without stealing or mutating', async t => {
  const f = await setup(t)
  await fs.mkdir(f.dataDir)
  await fs.writeFile(f.ops.lockFile, JSON.stringify({ pid: 12345 }))
  await assert.rejects(f.ops.append(appendInput(f.path)), /操作锁被占用/)
  assert.equal(await fs.readFile(f.path, 'utf8'), f.original)
  assert.equal(JSON.parse(await fs.readFile(f.ops.lockFile, 'utf8')).pid, 12345)
})

test('history cap keeps unresolved preparations and conflicts beyond 200 completed entries', async t => {
  const f = await setup(t)
  const base = { kind: 'archive', at: '2026-01-01', label: 'old', sessionId: 's1' }
  const unresolved = { ...base, id: 'unresolved', state: 'prepared' }
  const conflict = { ...base, id: 'conflict', state: 'conflict' }
  const completed = Array.from({ length: 201 }, (_, i) => ({ ...base, id: `completed-${i}`, state: 'committed' }))
  const resolved = { id: 'resolved', kind: 'write', at: '2026-01-01', label: 'resolve', state: 'prepared', path: f.path, beforeHash: 'different', afterHash: sha256(f.original), backup: join(f.dataDir, 'original.md') }
  await fs.mkdir(f.dataDir)
  await fs.writeFile(f.ops.journalFile, JSON.stringify({ version: 2, ops: [unresolved, conflict, ...completed, resolved] }))
  delete f.registry.archivedSessionIds
  const view = await f.ops.readJournal()
  assert.deepEqual(new Set(view.slice(-2).map(op => op.id)), new Set(['unresolved', 'conflict']), 'host reversal surfaces recovery records first')
  const persisted = await readOps(f.ops.journalFile)
  assert.equal(persisted.filter(op => op.state === 'committed').length, 200)
  assert.equal(persisted.find(op => op.id === 'unresolved').state, 'prepared')
  assert.equal(persisted.find(op => op.id === 'conflict').state, 'conflict')
  await assert.rejects(f.ops.append(appendInput(f.path)), /无法核对的准备记录/)
})

for (const boundary of ['before', 'after']) {
  test(`real child-process exit ${boundary} file commit: durable preparation recovers without replay`, async t => {
    const f = await setup(t)
    const script = `
      import * as fs from 'node:fs/promises';
      import { createOps } from './lib/ops.js';
      const [dataDir, path, boundary] = process.argv.slice(1);
      const io = { ...fs, async rename(from, to) {
        if (to === path && boundary === 'before') process.exit(71);
        await fs.rename(from, to);
        if (to === path && boundary === 'after') process.exit(72);
      } };
      await createOps({ dataDir, fs: io }).append({ path, body: '- child', from: 'test', label: 'child' });
    `
    const run = promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.dataDir, f.path, boundary], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000, windowsHide: true,
    })
    await assert.rejects(run, e => e.code === (boundary === 'before' ? 71 : 72))
    assert.equal((await readOps(f.ops.journalFile))[0].state, 'prepared')
    const waiting = (await f.ops.readJournal())[0]
    assert.equal(waiting.state, 'prepared')
    assert.equal(waiting.canUndo, false)
    assert.equal(waiting.recoveryPending, true)
    assert.match(waiting.label, /待核对/)
    assert.match(waiting.recovery, /操作锁被占用/)
    // Child exit is confirmed; these are its two exact synthetic lock paths.
    await fs.rm(f.ops.lockFile)
    await fs.rm(join(f.project, '.AGENTS.md.context-studio.lock'))
    const op = (await createOps(f.options).readJournal())[0]
    assert.equal(op.state, boundary === 'before' ? 'cancelled' : 'committed')
    const text = await fs.readFile(f.path, 'utf8')
    assert.equal(text.split('- child').length - 1, boundary === 'before' ? 0 : 1)
  })
}

test('real child exit after undo capture: record remains visible and recovers with retained file', async t => {
  const f = await setup(t)
  const op = await f.ops.append(appendInput(f.fresh))
  const text = await fs.readFile(f.fresh, 'utf8')
  const script = `
    import * as fs from 'node:fs/promises';
    import { createOps } from './lib/ops.js';
    const [dataDir, path, id] = process.argv.slice(1);
    const io = { ...fs, async rename(from, to) {
      await fs.rename(from, to);
      if (from === path && to.endsWith('.undo')) process.exit(73);
    } };
    await createOps({ dataDir, fs: io }).undo(id);
  `
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.dataDir, f.fresh, op.id], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000, windowsHide: true,
  }), e => e.code === 73)
  const waiting = (await f.ops.readJournal())[0]
  assert.equal(waiting.state, 'undo-prepared')
  assert.equal(waiting.canUndo, false)
  assert.equal(await fs.readFile(waiting.undoStash, 'utf8'), text)
  await fs.rm(f.ops.lockFile)
  await fs.rm(join(f.project, '.AGENTS.local.md.context-studio.lock'))
  const recovered = (await createOps(f.options).readJournal())[0]
  assert.equal(recovered.state, 'undone')
  assert.ok(recovered.undone)
  assert.equal(await fs.readFile(recovered.undoStash, 'utf8'), text)
})
