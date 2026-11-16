import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createOrganizer } from '../lib/organize-jobs.js'

// Installed runtime + installed OpenCode adapter, but ONLY a loopback endpoint,
// synthetic history and an in-memory dummy credential service. No user config.
// Run with Electron's Node mode for ASAR imports; see docs/REVIEW-1.5.1.md.
if (!process.argv[2] || !process.env.DSH_HOME) throw Error('Supply runtime node_modules path and an isolated DSH_HOME')
const runtime = name => import(pathToFileURL(join(process.argv[2], '@deepseek-ai', name, 'lib/index.js')).href)
const [{ Context }, { default: LlmRuntime }, LlmPiAi] = await Promise.all([
  runtime('cordis'), runtime('dsh-llm'), runtime('dsh-llm-pi-ai'),
])
const report = JSON.stringify({ overview: '本地协议测试', cards: [{ category: 'next', title: '核对', body: '补充证据', evidence: [1] }] })
const requests = []
const server = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part
  const input = JSON.parse(body)
  requests.push({ path: req.url, route: req.headers['x-opencode-session'] || null, model: input.model, tools: input.tools?.length || 0 })
  if (!req.headers['x-opencode-session']) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'x-opencode-session header is required', type: 'invalid_request_error' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const frame of [
    { choices: [{ delta: { role: 'assistant', content: report }, index: 0, finish_reason: null }] },
    { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 10, total_tokens: 13 } },
  ]) res.write(`data: ${JSON.stringify(frame)}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const ctx = new Context()
let organizer
try {
  await ctx.plugin({ name: 'context-studio-offline-credentials', apply(context) {
    context.provide('credentials', { resolve: async ref => {
      assert.equal(ref, 'CONTEXT_STUDIO_OFFLINE'); return { value: 'local-test-not-a-real-key' }
    }, readRecord: async () => undefined })
  } })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { 'opencode-go': { apiKeyEnv: 'CONTEXT_STUDIO_OFFLINE', baseURL: `http://127.0.0.1:${server.address().port}/v1` } } })
  const llm = ctx.get('llm'), config = { provider: 'opencode-go', model: 'deepseek-v4.1-flash', maxTokens: 4096 }
  const old = await llm.prepareCall(config)
  let previousFinish
  for await (const chunk of old.stream({ ...old.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic only' }] }], tools: [] })) {
    if (chunk.type === 'finish') previousFinish = chunk.reason
  }
  assert.equal(previousFinish.kind, 'error'); assert.equal(previousFinish.failure.code, 'INVALID_REQUEST')
  const dataDir = await mkdtemp(join(tmpdir(), 'csx-protocol-'))
  const log = { events: [{ seq: 1, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '核对步骤' }] } },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '请补充依据' }] } } }] }
  organizer = createOrganizer({ dataDir, getLlm: () => ctx.get('llm'), getQuery: () => ({ readSession: async () => log }) })
  const plan = await organizer.preview({ sessionId: 'synthetic-session', provider: config.provider, model: config.model })
  await organizer.start({ planId: plan.planId, confirmed: true })
  let job
  for (let i = 0; i < 200; i++) {
    job = (await organizer.get({ id: plan.planId, sessionId: plan.sessionId })).job
    if (job.status !== 'running') break
    await delay(20)
  }
  assert.equal(job.status, 'completed', job.error)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].route, null)
  assert.match(requests[1].route, /^context-studio-organize-[a-f0-9]{32}$/)
  await organizer.start({ planId: plan.planId, confirmed: true })
  assert.equal(requests.length, 2)
  console.log(JSON.stringify({ installedAdapter: true, endpoint: 'loopback-only', before: previousFinish.failure.code,
    after: job.status, usage: job.usage, requests, actualUserTokenUse: false }, null, 2))
} finally {
  organizer?.dispose()
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
