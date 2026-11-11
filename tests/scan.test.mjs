import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chainDirs, findProjectRoot, listProjects, parseFrontmatter, pathMentions, scanProject, sessionMention, sessionSnippets, writeTarget } from '../lib/scan.js'
import { fixture } from './helpers.mjs'

test('pathMentions: 只挑像路径的反引号片段', () => {
  const got = pathMentions('用 `pnpm build`，看 `src/app.ts`、`dist/`、`README.md`、`1.2.3`、`ctx.get`、`foo()`、`https://x.y/z`、`*.ts`')
  assert.deepEqual(got, ['src/app.ts', 'dist', 'README.md'])
})

test('findProjectRoot / chainDirs', async () => {
  const f = await fixture()
  assert.equal(await findProjectRoot(join(f.projA, 'packages', 'core')), f.projA)
  assert.deepEqual(chainDirs(f.projA, join(f.projA, 'packages', 'core')), [f.projA, join(f.projA, 'packages'), join(f.projA, 'packages', 'core')])
})

test('parseFrontmatter', () => {
  assert.deepEqual(parseFrontmatter('---\nname: "x"\ndescription: 做事\n---\nbody'), { name: 'x', description: '做事' })
  assert.deepEqual(parseFrontmatter('no fm'), {})
})

test('listProjects: 全局 + 工作区', async () => {
  const f = await fixture()
  const ps = listProjects({ homes: f.homes, workspaceRegistry: f.registry })
  assert.deepEqual(ps.map(p => p.id), ['global', 'wa', 'wb'])
  assert.equal(ps[1].sessionCount, 3)
  assert.deepEqual(listProjects({ homes: f.homes, workspaceRegistry: { list() { throw new Error('not ready') } } }).map(p => p.id), ['global'])
})

test('scanProject(A): 指令拆块 + 体检（重复、路径失效、被遮蔽）、子目录指令、技能、会话', async () => {
  const f = await fixture()
  const env = { homes: f.homes, workspaceRegistry: f.registry, sessionQuery: f.sessionQuery }
  const r = await scanProject(env, 'wa')
  const ins = r.pieces.filter(p => p.kind === 'instruction')
  const byText = t => ins.find(p => p.text.includes(t) && p.source.path.endsWith('AGENTS.md') && !p.source.path.includes('packages'))

  const dup = byText('回答用中文')
  assert.ok(dup.flags.some(x => x.code === 'duplicate'), '和全局重复')
  assert.ok(!byText('源码在').flags.some(x => x.code === 'missing-path'), 'src/ 存在')
  const missing = byText('dist-old')
  assert.ok(missing.flags.some(x => x.code === 'missing-path' && x.text.includes('dist-old')))
  assert.ok(byText('scripts/deploy.sh').flags.some(x => x.code === 'missing-path'))
  assert.equal(dup.removable, 'block')
  assert.ok(dup.fileHash)

  const claude = ins.filter(p => p.source.path.endsWith('CLAUDE.md'))
  assert.ok(claude.length > 0 && claude.every(p => p.flags.some(x => x.code === 'shadowed')), 'CLAUDE.md 和 AGENTS.md 一样')

  assert.ok(ins.some(p => p.source.path.includes(join('packages', 'core'))), '子目录指令')
  assert.ok(!ins.some(p => p.source.path.includes('node_modules')), '跳过 node_modules')
  assert.ok(!ins.some(p => p.source.path === join(f.dshHome, 'AGENTS.md')), '项目视图不显示全局文件')

  const skill = r.pieces.find(p => p.kind === 'skill')
  assert.equal(skill.title, 'deploy')
  assert.match(skill.text, /把 A 部署到预发/)

  const sessions = r.pieces.filter(p => p.kind === 'session')
  assert.deepEqual(sessions.map(s => s.source.sessionId), ['s1', 's2'], '新的在前、跳过子代理、只算本工作区')
  assert.equal(sessions[0].title, '修登录 bug')
  assert.match(sessions[0].text, /^@\[修登录 bug\]\(dsh-session:/)
  assert.ok(sessions[1].flags.some(x => x.code === 'stale'))
  assert.equal(sessions[0].removable, 'archive')

  // 块 id 能找回原块
  assert.ok(r.blocks.get(dup.id))
  assert.equal(r.blocks.get(dup.id).path, join(f.projA, 'AGENTS.md'))
})

test('scanProject: 已归档会话不可再归档', async () => {
  const f = await fixture()
  f.archived.push('s1')
  const r = await scanProject({ homes: f.homes, workspaceRegistry: f.registry, sessionQuery: f.sessionQuery }, 'wa')
  const s1 = r.pieces.find(p => p.id === 'session:s1')
  assert.equal(s1.removable, false)
  assert.ok(s1.flags.some(x => x.code === 'archived'))
})

test('scanProject(B): 陈旧文件', async () => {
  const f = await fixture()
  const r = await scanProject({ homes: f.homes, workspaceRegistry: f.registry, sessionQuery: f.sessionQuery }, 'wb')
  const item = r.pieces.find(p => p.text === '- 用 npm')
  assert.ok(item.flags.some(x => x.code === 'stale'))
})

test('scanProject(global): 全局指令 + Dot 记忆（只读）', async () => {
  const f = await fixture()
  const r = await scanProject({ homes: f.homes, workspaceRegistry: f.registry }, 'global')
  assert.ok(r.pieces.some(p => p.kind === 'instruction' && p.text.includes('回答用中文')))
  const dot = r.pieces.find(p => p.kind === 'dot')
  assert.equal(dot.text, '用户喜欢简短回答')
  assert.equal(dot.removable, false)
})

test('scanProject: 未知项目抛错', async () => {
  const f = await fixture()
  await assert.rejects(scanProject({ homes: f.homes, workspaceRegistry: f.registry }, 'nope'), /未知项目/)
})

test('sessionMention: 与 dsh-session-reference 的编码一致，标签转义', () => {
  const m = sessionMention('abc', 'a]b')
  const payload = Buffer.from(JSON.stringify('abc')).toString('base64url')
  assert.equal(m, `@[a\\]b](dsh-session:${payload})`)
})

test('sessionSnippets: 过滤注入的 system-reminder 和空消息', async () => {
  const f = await fixture()
  const list = await sessionSnippets(f.sessionQuery, 's1')
  assert.deepEqual(list.map(s => [s.seq, s.role]), [[2, 'user'], [3, 'assistant']])
  await assert.rejects(sessionSnippets(undefined, 's1'), /没有会话查询服务/)
})

test('writeTarget: 只允许两种文件名', async () => {
  const f = await fixture()
  const env = { homes: f.homes, workspaceRegistry: f.registry }
  assert.equal(writeTarget(env, 'wb', 'AGENTS.local.md'), join(f.projB, 'AGENTS.local.md'))
  assert.equal(writeTarget(env, 'global', 'AGENTS.md'), join(f.dshHome, 'AGENTS.md'))
  assert.throws(() => writeTarget(env, 'wb', '../evil.md'))
  assert.throws(() => writeTarget(env, 'global', 'AGENTS.local.md'))
  assert.throws(() => writeTarget(env, 'nope', 'AGENTS.md'))
})

test('homeLabel: 全局文件用短名', async () => {
  const { homeLabel } = await import('../lib/scan.js')
  const homes = { dshHome: join('X', 'dsh'), agentsHome: join('X', 'agents') }
  assert.equal(homeLabel(join('X', 'dsh', 'AGENTS.md'), homes), '$DSH_HOME/AGENTS.md')
  assert.equal(homeLabel(join('X', 'agents', 'AGENTS.md'), homes), '~/.agents/AGENTS.md')
  assert.equal(homeLabel(join('Y', 'AGENTS.md'), homes), join('Y', 'AGENTS.md'))
})

test('重复标记用短名指向全局文件', async () => {
  const f = await fixture()
  const r = await scanProject({ homes: f.homes, workspaceRegistry: f.registry, sessionQuery: f.sessionQuery }, 'wa')
  const dup = r.pieces.find(p => p.text.includes('回答用中文') && p.source.path === join(f.projA, 'AGENTS.md'))
  const flag = dup.flags.find(x => x.code === 'duplicate')
  assert.ok(flag.text.includes('$DSH_HOME/AGENTS.md'), flag.text)
  assert.ok(flag.text.includes('CLAUDE.md'), '同目录的 CLAUDE.md 也算重复')
})

test('sessionSnippets: 有 readSession 时按 source.kind 只留用户亲手发的消息', async () => {
  const now = Date.now()
  const q = {
    async filterEvents() {
      return [
        { seq: 1, type: 'user/message', time: now, text: '帮我修登录' },
        { seq: 2, type: 'user/message', time: now, text: 'Current runtime context. This snapshot supersedes…' },
        { seq: 3, type: 'user/message', time: now, text: 'Time sampled while preparing turn 1' },
        { seq: 4, type: 'assistant/message', time: now, text: '好的' },
      ]
    },
    async readSession() {
      return { events: [
        { seq: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: 'r1' } } },
        { seq: 2, type: 'user/message', data: { source: { kind: 'runtime-context', form: 'snapshot' } } },
        { seq: 3, type: 'user/message', data: { source: { kind: 'time-context' } } },
      ] }
    },
  }
  const list = await sessionSnippets(q, 's')
  assert.deepEqual(list.map(s => s.seq), [1, 4])
  // readSession 失败时退回到旧规则
  q.readSession = async () => { throw new Error('boom') }
  assert.equal((await sessionSnippets(q, 's')).length, 4)
})
