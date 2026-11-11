import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 搭一个假环境：两个项目 + 全局 home + 假的 workspaceRegistry / sessionQuery。 */
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'csx-'))
  const dshHome = join(root, 'dsh-home')
  const agentsHome = join(root, 'agents-home')
  const projA = join(root, 'proj-a')
  const projB = join(root, 'proj-b')
  await mkdir(join(projA, '.git'), { recursive: true })
  await mkdir(join(projA, 'src'), { recursive: true })
  await mkdir(join(projA, 'packages', 'core'), { recursive: true })
  await mkdir(join(projA, 'node_modules', 'x'), { recursive: true })
  await mkdir(join(projA, '.agents', 'skills', 'deploy'), { recursive: true })
  await mkdir(join(projB, '.git'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(join(dshHome, 'dot'), { recursive: true })

  await writeFile(join(dshHome, 'AGENTS.md'), '# 全局\n- 回答用中文，先给结论再给细节\n')
  await writeFile(join(projA, 'AGENTS.md'), [
    '# A 项目',
    '- 回答用中文，先给结论再给细节',
    '- 源码在 `src/` 目录',
    '- 旧的输出目录 `dist-old/` 不要提交',
    '',
    '## 部署',
    '- 部署前先跑 `pnpm build`，然后 `scripts/deploy.sh`',
    '',
  ].join('\n'))
  await writeFile(join(projA, 'CLAUDE.md'), (await import('node:fs')).readFileSync(join(projA, 'AGENTS.md'), 'utf8'))
  await writeFile(join(projA, 'packages', 'core', 'AGENTS.md'), '- core 包不要依赖 UI\n')
  await writeFile(join(projA, 'node_modules', 'x', 'AGENTS.md'), '- 不该被扫到\n')
  await writeFile(join(projA, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: 把 A 部署到预发\n---\n正文\n')
  await writeFile(join(projB, 'AGENTS.md'), '# B 项目\n- 用 npm\n')
  await writeFile(join(dshHome, 'dot', 'state.json'), JSON.stringify({ memories: [{ id: 'm1', text: '用户喜欢简短回答', category: 'preference', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }))
  // 让 B 的文件显得很旧
  const old = new Date('2025-01-01T00:00:00Z')
  await utimes(join(projB, 'AGENTS.md'), old, old)

  const archived = []
  const registry = {
    workspaces: [
      { id: 'wa', title: 'proj-a', path: projA, sessionIds: ['s1', 's2', 'sub'] },
      { id: 'wb', title: 'proj-b', path: projB, sessionIds: [] },
    ],
    list() { return this.workspaces },
    get(id) { return this.workspaces.find(w => w.id === id) },
    get archivedSessionIds() { return archived },
    async archiveSession(id) { if (!archived.includes(id)) archived.push(id) },
    async unarchiveSession(id) { const i = archived.indexOf(id); if (i >= 0) archived.splice(i, 1) },
  }
  const now = Date.now()
  const sessionQuery = {
    async listSessions() {
      return [
        { header: { id: 's1', createdAt: now - 1000, cwd: projA } },
        { header: { id: 's2', createdAt: now - 200 * 86_400_000, cwd: projA } },
        { header: { id: 'sub', createdAt: now, cwd: projA, origin: 'subagent' } },
        { header: { id: 'other', createdAt: now, cwd: projB } },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => id === 's1' ? { status: 'fulfilled', value: { title: { title: '修登录 bug' } } } : { status: 'fulfilled', value: {} })
    },
    async filterEvents(id, filters) {
      assert(filters[0].kind === 'type')
      return [
        { seq: 1, type: 'user/message', time: now, text: '<system-reminder>指令</system-reminder>' },
        { seq: 2, type: 'user/message', time: now, text: '登录后跳回首页了' },
        { seq: 3, type: 'assistant/message', time: now, text: '原因是 cookie 的 SameSite 设置' },
        { seq: 4, type: 'assistant/message', time: now, text: '   ' },
      ]
    },
  }
  return { root, dshHome, agentsHome, projA, projB, registry, sessionQuery, archived, homes: { dshHome, agentsHome } }
}

function assert(ok) { if (!ok) throw new Error('fixture assertion failed') }
