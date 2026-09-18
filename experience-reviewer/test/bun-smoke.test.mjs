/**
 * bun 环境冒烟测试 (mission 任务: "先不要 sql 相关的代码 全部用模拟 进行一次测试")
 *
 * 目的: 验证 opencode 运行时 (bun) 下, 只要 node:sqlite 被 mock 掉,
 *       插件剩余链路全部正常: import → server() → transform hook → 触发 → fireReview(全 mock)。
 * 运行: bun test test/bun-smoke.test.mjs   (不是 node --test!)
 */
import { mock, describe, test, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

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
const { createExperienceReviewer, projectIdFromCwd } = mod

/** 收集日志 (替代真实 debugLog 写 %TEMP%) */
function makeLogCollector() {
  const lines = []
  return { lines, log: (msg) => lines.push(msg) }
}

/** 临时项目目录 (每次测试独立, 不碰真实项目) */
function makeTempDir(tag) {
  return join(tmpdir(), `exp-review-bun-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
}

/** 内存 fs mock: cursor / AGENTS.md 都落在 Map 里, 零真实写盘 */
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

/** 构造 deps: sql / spawn / HTTP / fs 全部 mock */
function makeDeps({ tag, rows = [], subagentStdout = '{"simple":[{"scope":"project","text":"bun 冒烟测试经验"}],"complex":[]}' } = {}) {
  const collector = makeLogCollector()
  const dir = makeTempDir(tag)
  const mem = makeMemFs()
  const fakeDb = {
    rows,
    closeCalled: 0,
    prepare() {
      const self = this
      return {
        get: () => null,
        all: (...args) => {
          const limit = args.length ? args[args.length - 1] : 100
          return self.rows.slice(0, limit)
        },
      }
    },
    close() {
      this.closeCalled++
    },
  }
  return {
    collector,
    dir,
    mem,
    deps: {
      roundInterval: 3,
      timeIntervalMs: 10 * 60 * 1000,
      maxMdBytes: 20 * 1024,
      maxMessages: 20,
      now: () => 1_000_000,
      log: collector.log,
      directory: dir,
      globalAgentsPath: join(dir, 'g-AGENTS.md'),
      model: undefined,
      read: mem.read,
      write: mem.write,
      exists: mem.exists,
      mkdir: mem.mkdir,
      runSub: async () => ({ ok: true, code: 0, stdout: subagentStdout, stderr: '' }),
      readUnsumm: ({ db, directory, lastMessageId = null, limit }) => db.rows.slice(0, limit).map((r) => ({ ...r })),
      storeComplex: async () => ({ success: true, id: 'mock-id' }),
      queryExp: async () => ({ success: true, experiences: [] }),
      projectIdFn: projectIdFromCwd,
      openDb: () => fakeDb,
    },
  }
}

/** 构造 hook 输入: n 条模拟消息 */
function makeMessages(n) {
  const out = []
  for (let i = 1; i <= n; i++) {
    out.push({ info: { role: 'user' } })
    if (i % 2 === 0) out.push({ info: { role: 'assistant' } })
  }
  return out
}

describe('bun 环境插件全链路 (sql 全 mock)', () => {
  test('1. import 成功 (mock 掉 node:sqlite 后 bun 可加载)', () => {
    expect(mod.default).toBeDefined()
    expect(mod.default.id).toBe('opencode-experience-reviewer')
    expect(typeof mod.default.server).toBe('function')
  })

  test('2. server() 返回 transform hook (注册环节可用)', async () => {
    const hooks = await mod.default.server({ directory: makeTempDir('srv') })
    // bun toHaveProperty 把 . 当路径解析 → 用 in
    expect('experimental.chat.messages.transform' in hooks).toBe(true)
    expect(typeof hooks['experimental.chat.messages.transform']).toBe('function')
  })

  test('3. 首次 transform: 写基线 cursor, 不触发', () => {
    const { collector, deps } = makeDeps({ tag: 'baseline' })
    const r = createExperienceReviewer(deps)

    // handleTransform 首次调用
    r.handleTransform({ messages: makeMessages(4) })
    // 首次只写基线, 不触发 → 无 TRIGGER
    const logText = collector.lines.join('\n')
    expect(logText).not.toContain('TRIGGER')
    // 基线写入内存 fs cursor
    const cursorFile = join(deps.directory, '.experience-reviewer', 'experience-cursor.json')
    expect(deps.exists(cursorFile)).toBe(true)
  })

  test('4. 触发链路: 基线+n轮 → TRIGGER → fireReview 全 mock 跑通 → REVIEW_DONE', async () => {
    const { collector, deps } = makeDeps({
      tag: 'trigger',
      rows: [
        { message_id: 'm1', role: 'user', text: '第一条' },
        { message_id: 'm2', role: 'assistant', text: '回答一' },
        { message_id: 'm3', role: 'user', text: '第二条' },
        { message_id: 'm4', role: 'assistant', text: '回答二' },
      ],
    })
    const r = createExperienceReviewer(deps)
    const cursorFile = join(deps.directory, '.experience-reviewer', 'experience-cursor.json')

    // 基线: 4 条消息 → lastReviewRound = 4, 写内存 cursor
    r.handleTransform({ messages: makeMessages(4) })
    // 再 +2 条 → userCount=6 → roundsSince=2 < 3, 不触发
    r.handleTransform({ messages: makeMessages(6) })
    expect(collector.lines.join('\n')).not.toContain('TRIGGER')

    // 再 +1 条 → userCount=7 → roundsSince=3 ≥ 3 → 触发 (7-4=3)
    r.handleTransform({ messages: makeMessages(7) })
    const logText = collector.lines.join('\n')
    expect(logText).toContain('TRIGGER')
    // fireReview 是异步 fire-and-forget → 等一拍看 REVIEW_DONE
    await new Promise((res) => setTimeout(res, 50))
    const logAfter = collector.lines.join('\n')
    expect(logAfter).toContain('REVIEW_START')
    expect(logAfter).toContain('REVIEW_DONE')
  })

  test('5. fireReview 直接调用: 全 mock → REVIEW_DONE', async () => {
    const { collector, deps } = makeDeps({
      tag: 'fire',
      rows: [
        { message_id: 'm1', role: 'user', text: '第一条' },
        { message_id: 'm2', role: 'assistant', text: '回答一' },
      ],
    })
    const r = createExperienceReviewer(deps)
    // 预置 cursor → 走增量路径
    const cursorFile = join(deps.directory, '.experience-reviewer', 'experience-cursor.json')
    deps.write(cursorFile, JSON.stringify({ lastMessageId: 'm0', lastReviewRound: 1 }))
    const ok = await r.fireReview()
    expect(ok).toBe(true)
    const logText = collector.lines.join('\n')
    expect(logText).toContain('REVIEW_START')
    expect(logText).toContain('REVIEW_DONE')
    expect(logText).toContain('simple=1')
  })
})