/**
 * bun 环境冒烟测试 (v5: compact-hook 架构)
 *
 * 目的: 验证 opencode 运行时 (bun) 下, mock 掉 node:sqlite 后,
 *       插件剩余链路全部正常: import → setup() 注册 hook+event → handler 解析 + 写盘。
 * 运行: bun test test/bun-smoke.test.mjs   (不是 node --test!)
 */
import { mock, describe, test, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 关键: 必须在 import index.js 之前 mock 掉 node:sqlite (bun 无此内置模块) ──
mock.module('node:sqlite', () => {
  return {
    DatabaseSync: class FakeDatabaseSync {
      constructor(path, opts) {
        this.path = path
        this.opts = opts
        this.rows = []
      }
      prepare() {
        return {
          get: () => null,
          all: (...args) => {
            const limit = args.length ? args[args.length - 1] : 100
            return this.rows.slice(0, limit)
          },
          run: () => ({ changes: 0 }),
        }
      }
      close() {}
    },
  }
})

// ── 动态 import: 确保 mock.module 已先行注册 ──
const mod = await import('../index.js')
const { createExperienceReviewer } = mod

/** 收集日志 */
function makeLogCollector() {
  const lines = []
  return { lines, log: (msg) => lines.push(msg) }
}

/** 临时项目目录 */
function makeTempDir(tag) {
  return join(tmpdir(), `exp-review-bun-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
}

/** 内存 fs mock */
function makeMemFs() {
  const files = new Map()
  return {
    files,
    read: (p) => (files.has(p) ? files.get(p) : ''),
    write: (p, c) => files.set(p, c),
    exists: (p) => files.has(p),
    mkdir: () => {},
  }
}

/** 构造 reviewer (v5 简化: 无 db 依赖) */
function makeReviewer({ tag = 'bun', content = '' } = {}) {
  const collector = makeLogCollector()
  const dir = makeTempDir(tag)
  const mem = makeMemFs()
  if (content) mem.write(join(dir, 'AGENTS.md'), content)
  const reviewer = createExperienceReviewer({
    directory: dir,
    log: collector.log,
    read: mem.read,
    write: mem.write,
    exists: mem.exists,
    mkdir: mem.mkdir,
    globalAgentsPath: join(dir, 'g-AGENTS.md'),
  })
  return { collector, dir, mem, reviewer }
}

/** 构造 compaction.ended 事件 */
function makeEvent({ id = 'evt_1', text = '' } = {}) {
  return { id, type: 'session.compaction.ended', data: { sessionID: 'ses_test', reason: 'auto', text } }
}

describe('bun 环境插件全链路 (v5 compact-hook)', () => {
  test('1. import 成功 (mock 掉 node:sqlite 后 bun 可加载)', () => {
    expect.default
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe('opencode-experience-reviewer')
    expect(typeof mod.default.setup).toBe('function')
  })

  test('2. buildCompactionInjection 返回 user role 注入消息', () => {
    const { reviewer } = makeReviewer({ tag: 'ci' })
    const inj = reviewer.buildCompactionInjection()
    expect(inj).not.toBeNull()
    expect(inj.role).toBe('user')
    expect(inj.content.length).toBe(1)
    expect(inj.content[0].text).toContain('simple')
    expect(inj.content[0].text).toContain('```json')
  })

  test('3. handleCompactionEnded: 解析 → 写盘 → 推进 cursor', () => {
    const { collector, reviewer, mem, dir } = makeReviewer({ tag: 'ce' })
    const text = '摘要文本\n\n```json\n{"simple":[{"scope":"project","text":"bun 冒烟测试","suggestGlobal":false}],"usedEntries":[]}\n```'
    const result = reviewer.handleCompactionEnded({ event: makeEvent({ id: 'evt_bun', text }) })
    expect(result.ok).toBe(true)
    expect(result.simple.length).toBe(1)
    const md = mem.read(join(dir, 'AGENTS.md'))
    expect(md).toContain('bun 冒烟测试')
    expect(collector.lines.join('\n')).toContain('COMPACTION_REVIEW')
    expect(collector.lines.join('\n')).toContain('MD_WRITE')
    // cursor
    const cursorPath = join(dir, '.experience-reviewer', 'experience-cursor.json')
    expect(mem.exists(cursorPath)).toBe(true)
    const cursor = JSON.parse(mem.read(cursorPath))
    expect(cursor.lastCompactionEventID).toBe('evt_bun')
  })

  test('4. handleCompactionEnded: 同 event.id 重复 → skip, 不再写盘', () => {
    const { reviewer, mem, dir } = makeReviewer({ tag: 'dup' })
    const text = '```json\n{"simple":[{"scope":"project","text":"X","suggestGlobal":false}],"usedEntries":[]}\n```'
    const evt = makeEvent({ id: 'evt_dup', text })
    const r1 = reviewer.handleCompactionEnded({ event: evt })
    const md1 = mem.read(join(dir, 'AGENTS.md'))
    expect(r1.ok).toBe(true)
    const r2 = reviewer.handleCompactionEnded({ event: evt })
    expect(r2.ok).toBe(false)
    expect(r2.reason).toBe('duplicate')
    expect(mem.read(join(dir, 'AGENTS.md'))).toBe(md1)
  })

  test('5. 项目开关 enabled=false → handleCompactionEnded SKIP disabled', () => {
    const { collector, reviewer, mem, dir } = makeReviewer({ tag: 'off' })
    mem.write(join(dir, '.experience-reviewer', 'config.json'),
      JSON.stringify({ enabled: false }))
    const result = reviewer.handleCompactionEnded({
      event: makeEvent({ text: '```json\n{"simple":[]}\n```' }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('disabled')
    expect(collector.lines.join('\n')).toContain('reason=disabled-by-config')
  })
})
