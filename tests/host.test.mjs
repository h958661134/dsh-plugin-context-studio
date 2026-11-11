import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import * as host from '../lib/host.js'
import { checkRequest, hostAllowed, readJson } from '../lib/guard.js'
import { fixture } from './helpers.mjs'

test('导出符合 Cordis 插件形状', () => {
  assert.equal(typeof host.name, 'string')
  assert.deepEqual(host.inject, ['webServer'])
  assert.equal(typeof host.apply, 'function')
})

test('guard: 本机、同源、写操作要头和 JSON', () => {
  const allowed = new Set(['my-host'])
  assert.equal(hostAllowed('127.0.0.1:4001', allowed), true)
  assert.equal(hostAllowed('evil.com', allowed), false)
  assert.equal(hostAllowed('my-host:80', allowed), true)
  assert.equal(hostAllowed(undefined, allowed), false)
  const base = { method: 'GET', headers: { host: '127.0.0.1:4001' } }
  assert.equal(checkRequest(base, allowed, false), null)
  assert.equal(checkRequest({ ...base, method: 'DELETE' }, allowed, false), 'method')
  assert.equal(checkRequest({ ...base, headers: { ...base.headers, origin: 'http://evil.com' } }, allowed, false), 'cross-origin')
  assert.equal(checkRequest({ ...base, headers: { ...base.headers, origin: 'not a url' } }, allowed, false), 'bad origin')
  const w = { method: 'POST', headers: { host: '127.0.0.1:4001', origin: 'http://127.0.0.1:4001', 'content-type': 'application/json', 'x-context-studio': '1' } }
  assert.equal(checkRequest(w, allowed, true), null)
  assert.equal(checkRequest({ ...w, headers: { ...w.headers, 'x-context-studio': undefined } }, allowed, true), 'missing client header')
  assert.equal(checkRequest({ ...w, headers: { ...w.headers, 'content-type': 'text/plain' } }, allowed, true), 'content-type')
  assert.equal(checkRequest({ ...w, method: 'GET' }, allowed, true), 'method')
})

test('readJson: 限制大小', async () => {
  assert.deepEqual(await readJson(Readable.from([Buffer.from('{"a":1}')])), { a: 1 })
  assert.deepEqual(await readJson(Readable.from([])), {})
  await assert.rejects(readJson(Readable.from([Buffer.alloc(600 * 1024)])), /太大/)
})

test('resolveConfig: 默认值与校验', () => {
  const c = host.resolveConfig({})
  assert.equal(c.staleDays, 90)
  assert.ok(c.dataDir.endsWith('context-studio'))
  assert.throws(() => host.resolveConfig({ dataDir: 'relative' }), /绝对路径/)
  assert.throws(() => host.resolveConfig({ staleDays: 0 }), /整数/)
})

/** 用假 ctx 把插件真正挂到一个 http 服务上，走一遍核心流程。 */
async function boot() {
  const f = await fixture()
  const routes = new Map()
  const ctx = {
    webServer: { register: r => routes.set(r.path, r), getOrigin: () => 'http://127.0.0.1:0' },
    get: k => (k === 'workspaceRegistry' ? f.registry : k === 'sessionQuery' ? f.sessionQuery : undefined),
  }
  const prev = process.env.DSH_HOME
  const prevAgents = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = f.dshHome
  process.env.DSH_AGENTS_HOME = f.agentsHome
  await host.apply(ctx, {})
  process.env.DSH_HOME = prev
  process.env.DSH_AGENTS_HOME = prevAgents
  const server = createServer((req, res) => {
    const r = routes.get(new URL(req.url, 'http://x').pathname)
    if (!r) { res.statusCode = 404; return res.end() }
    r.handler(req, res)
  })
  await new Promise(ok => server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${server.address().port}/api/dsh-plugin-context-studio`
  const get = p => fetch(base + p).then(async r => ({ status: r.status, body: await r.json() }))
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-context-studio': '1', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }))
  return { f, routes, server, get, post, close: () => new Promise(ok => server.close(ok)) }
}

test('端到端：看素材 → 移除可疑块 → 撤销 → 跨项目写入 → 归档会话 → 拼盘', async () => {
  const t = await boot()
  try {
    assert.ok(t.routes.has('/api/dsh-plugin-context-studio/projects'))
    const projects = await t.get('/projects')
    assert.deepEqual(projects.body.projects.map(p => p.id), ['global', 'wa', 'wb'])
    assert.equal(projects.body.capabilities.archive, true)

    // 1. 看到 A 的素材，找到路径失效的那一块
    const a = await t.get('/pieces?project=wa')
    const bad = a.body.pieces.find(p => p.text.includes('dist-old') && p.source.path.endsWith('AGENTS.md'))
    assert.ok(bad.flags.some(x => x.code === 'missing-path'))
    const agentsPath = join(t.f.projA, 'AGENTS.md')
    const before = await readFile(agentsPath, 'utf8')

    // 2. 写操作缺头 → 403
    const forbidden = await t.post('/remove', { project: 'wa', pieceId: bad.id }, { 'x-context-studio': '0' })
    assert.equal(forbidden.status, 403)

    // 3. 过期 fileHash → 409，不改文件
    const stale = await t.post('/remove', { project: 'wa', pieceId: bad.id, fileHash: 'old' })
    assert.equal(stale.status, 409)

    // 4. 移除
    const removed = await t.post('/remove', { project: 'wa', pieceId: bad.id, fileHash: bad.fileHash })
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.ok(!(await readFile(agentsPath, 'utf8')).includes('dist-old'))
    const again = await t.post('/remove', { project: 'wa', pieceId: bad.id })
    assert.equal(again.status, 409, '块已不在')

    // 5. 撤销
    const undo = await t.post('/undo', { opId: removed.body.op.id })
    assert.equal(undo.status, 200)
    assert.equal(await readFile(agentsPath, 'utf8'), before)

    // 6. 把 A 的「部署」一块拼进 B 的 AGENTS.local.md
    const deploy = a.body.pieces.find(p => p.text.includes('scripts/deploy.sh') && p.source.path === agentsPath)
    const w = await t.post('/write', { project: 'wb', file: 'AGENTS.local.md', from: 'proj-a', items: [{ kind: 'instruction', text: deploy.text, from: 'proj-a / ' + deploy.group }] })
    assert.equal(w.status, 200, JSON.stringify(w.body))
    const local = await readFile(join(t.f.projB, 'AGENTS.local.md'), 'utf8')
    assert.match(local, /from="proj-a"/)
    assert.ok(local.includes('scripts/deploy.sh'))
    // B 里能看到这块拼入的内容
    const b = await t.get('/pieces?project=wb')
    assert.ok(b.body.pieces.some(p => p.subkind === 'transplant'))
    // 写入路径不能越界
    const evil = await t.post('/write', { project: 'wb', file: '../x.md', items: [{ kind: 'note', text: 'x' }] })
    assert.equal(evil.status, 400)

    // 7. 归档旧会话 + 撤销
    const arch = await t.post('/archive', { project: 'wa', sessionId: 's2', title: '旧会话' })
    assert.equal(arch.status, 200)
    assert.deepEqual(t.f.archived, ['s2'])
    const notMine = await t.post('/archive', { project: 'wb', sessionId: 's1' })
    assert.equal(notMine.status, 400)
    await t.post('/undo', { opId: arch.body.op.id })
    assert.deepEqual(t.f.archived, [])

    // 8. 会话摘录 + 拼盘渲染
    const snip = await t.get('/session?id=s1')
    assert.equal(snip.body.snippets.length, 2)
    const c = await t.post('/compose', { items: [{ kind: 'instruction', text: deploy.text, from: 'proj-a' }, { kind: 'snippet', text: snip.body.snippets[1].text, role: 'assistant', title: '修登录 bug' }], budget: 8000, task: '在 B 上部署' })
    assert.equal(c.status, 200)
    assert.match(c.body.text, /# 起始上下文/)
    assert.match(c.body.text, /在 B 上部署/)
    assert.equal(c.body.over, false)

    // 9. 操作记录：新的在前
    const j = await t.get('/journal')
    assert.deepEqual(j.body.ops.map(o => o.kind), ['archive', 'write', 'remove'])

    // 10. 坏 JSON → 400
    const bad400 = await fetch(`http://127.0.0.1:${t.server.address().port}/api/dsh-plugin-context-studio/compose`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-context-studio': '1' }, body: '{bad' })
    assert.equal(bad400.status, 400)
    // 缺参数 → 400
    assert.equal((await t.get('/pieces')).status, 400)
  } finally {
    await t.close()
  }
})
