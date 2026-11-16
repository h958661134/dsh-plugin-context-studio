import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boundedReads, boundedQuery, sessionCatalog } from '../lib/reads.js'
import { buildLineage } from '../lib/graph.js'
import { fixture } from './helpers.mjs'

test('超时退出，但重试共享未结束的 I/O；同时限制底层工作数量', async () => {
  const run = boundedReads({ timeoutMs: 15, maxPending: 1 })
  let finish, calls = 0
  const read = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  await assert.rejects(run('a', read), e => e.status === 504)
  await assert.rejects(run('a', read), e => e.status === 504)
  await assert.rejects(run('b', read), e => e.status === 503)
  assert.equal(calls, 1)
  finish('ok')
  await new Promise(setImmediate)
  assert.equal(await run('b', () => 'fresh'), 'fresh')
})

test('同一 query 的并发调用合并，服务替换不复用旧结果', async () => {
  let count = 0, q = { async readSession(id) { count++; return { id, owner: this === q } } }
  const get = boundedQuery(() => q)
  const [a,b] = await Promise.all([get().readSession('s'), get().readSession('s')])
  assert.equal(count, 1); assert.equal(a.owner, true); assert.equal(a,b)
  q = { async readSession() { return 'new' } }
  assert.equal(await get().readSession('s'), 'new')
})

test('后台挂起保留交互和目录读取名额，更换服务不继承旧占位', async () => {
  let q = { readSession: id => id === 'good' ? Promise.resolve(id) : new Promise(()=>{}), listSessions: async()=>[] }
  const get=boundedQuery(()=>q,{timeoutMs:15,maxPending:3,reserved:1})
  await Promise.all([assert.rejects(get(true).readSession('a')),assert.rejects(get(true).readSession('b'))])
  await assert.rejects(get(true).readSession('c'),e=>e.status===503)
  assert.equal(await get().readSession('good'),'good')
  assert.deepEqual(await get().listSessions(),[])
  await assert.rejects(get().readSession('d'),e=>e.status===504)
  q={readSession:async()=> 'new'}
  assert.equal(await get().readSession('fresh'),'new')
})

test('会话导航只需目录与标题，不读历史或项目文件；读取失败保留可选会话', async () => {
  const registry = { list: () => [{ id: 'p', title: 'Project', sessionIds: ['s'] }] }
  let reads = 0
  const query = { listSessions: async () => { throw Error('offline') }, readTitleSnapshots: async () => { throw Error('offline') }, readSession: () => { reads++; return new Promise(()=>{}) } }
  const result = await sessionCatalog({ workspaceRegistry: registry, sessionQuery: query }, 'p')
  assert.equal(result.sessions[0].id, 's'); assert.equal(result.warnings.length, 2); assert.equal(reads,0)
  await assert.rejects(sessionCatalog({workspaceRegistry:registry},'bad'), e=>e.status===400)
})

test('脉络单会话失败与总预算用尽明确返回部分结果', async () => {
  const f = await fixture()
  const q = { ...f.sessionQuery, readSession: async () => { throw Error('bad log') } }
  const result = await buildLineage({ homes: f.homes, workspaceRegistry: f.registry, sessionQuery: q, graphBudgetMs: 0 }, 'wa')
  assert.equal(result.partial, true); assert.ok(result.failures.length)
  assert.ok(result.singles.every(s => s.readError)); assert.match(result.warnings.join(' '), /不完整/)
})
