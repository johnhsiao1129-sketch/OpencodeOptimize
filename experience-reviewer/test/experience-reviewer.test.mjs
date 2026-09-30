/**
 * experience-reviewer v2.0 单元测试 (node:test, 零依赖)
 * 运行: node --test test/experience-reviewer.test.mjs
 *
 * 覆盖:
 *   1. 触发: 首次遇到会话不立即触发 (以当前轮次为基准)
 *   2. 触发: 轮次 ≥3 → TRIGGER + 双冷却重置
 *   3. 触发: 时间 ≥10min → TRIGGER (即使轮次差 <3)
 *   4. 触发: 冷却 → 不连续触发
 *   5. 触发: 子代理消息不再跳过 (状态只认项目路径, 与 session/派发标记无关)
 *   6. 触发: 不注入任何 part (v2 关键: 主会话零修改)
 *   7. fireReview: 无新消息 → REVIEW_SKIP + 不更新 cursor
 *   8. fireReview: 有新消息 → subagent 成功 → 写 AGENTS.md + 更新 cursor
 *   9. fireReview: subagent 失败 → 不更新 cursor (下次重试)
 *   10. fireReview: 复杂经验写入失败 → 不更新 cursor
 *   11. 解析: extractJsonBlock 容错 (纯 JSON/带前缀/代码块)
 *   12. 解析: parseReviewOutput → simple/complex
 *   13. 写入: project → <dir>/AGENTS.md, global → 全局 AGENTS.md
 *   14. 写入: 去重 + 大小上限
 *   15. 读消息: directory 匹配 + 排除子会话 + role/文本分区过滤 + cursor 增量 (time_created)
 *   16. projectIdFromCwd: sha256 前 16 位
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createExperienceReviewer,
  buildSubagentPrompt,
  parseReviewOutput,
  extractJsonBlock,
  readUnsummarizedMessages,
  groupIntoTurns,
  projectIdFromCwd,
  storeComplexExperience,
  queryExperiences,
  computeCacheStats,
  readLastSubagentUsage,
} from '../index.js'

const PROJ_MD = join('C:/proj', 'AGENTS.md')
const GLOBAL_MD = 'C:/global/AGENTS.md'

/** 内存 FS + 假时钟 + 假 sqlite + 假 subagent */
function makeDeps(overrides = {}) {
  const files = new Map()
  const logs = []
  let nowMs = 1000
  const deps = {
    roundInterval: 3,
    timeIntervalMs: 600000,
    maxMdBytes: 2048,
    maxMessages: 200,
    directory: 'C:/proj',
    globalAgentsPath: GLOBAL_MD,
    now: () => nowMs,
    log: (msg) => logs.push(msg),
    read: (path) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
      return files.get(path)
    },
    write: (path, content) => {
      files.set(path, content)
    },
    exists: (path) => files.has(path),
    mkdir: () => {}, // 防真实写盘 (writeCursorLocal 内 mkdir)
    ...overrides,
  }
  return { deps, files, logs, advance: (ms) => (nowMs += ms) }
}

/**
 * 内存 opencode.db 假实现: 真实 node:sqlite 内存库 (session/message/part 三表 + 数据)
 * 让 readUnsummarizedMessages 跑真实 SQL, 覆盖最强 (而非 mock SQL 片段)
 * rows: [{message_id, role, text}] → 生成主会话 + 消息 + text 分区
 */
function makeFakeDb(rows, opts = {}) {
  const directory = opts.directory ?? 'C:/proj'
  const sessionId = opts.sessionId ?? 'ses_main'
  const baseTime = opts.baseTime ?? 1_700_000_000_000
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
           CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
  db.prepare(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`).run(
    sessionId, null, directory, opts.title ?? null, baseTime, baseTime
  )
  const insMsg = db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`)
  const insPart = db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`)
  rows.forEach((row, i) => {
    const t = baseTime + i * 1000
    insMsg.run(
      row.message_id,
      row.session_id ?? sessionId,
      t,
      t,
      JSON.stringify({ role: row.role ?? 'user', time: new Date(t).toISOString() })
    )
    if (row.text !== undefined) {
      insPart.run(`prt_${i}`, row.message_id, row.session_id ?? sessionId, t, t, JSON.stringify({ type: 'text', text: row.text }))
    }
  })
  return db
}

/** 构造 transform 消息数组 */
function msgs(count, { role = 'user', subagent = false } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    info: { role, sessionID: 'ses_test' },
    parts: subagent
      ? [{ type: 'text', text: `OMO_INTERNAL_INITIATOR task ${i}` }]
      : [{ type: 'text', text: `msg ${i}` }],
  }))
}

test('首次遇到会话不触发 (基线=当前轮次)', () => {
  const { deps, logs } = makeDeps()
  const r = createExperienceReviewer(deps)
  r.handleTransform({ messages: msgs(5) }) // 5 轮 user → 基线 5
  assert.ok(logs.every((l) => !l.startsWith('TRIGGER')), '首次不应触发')
  const cursor = r.readCursor()
  assert.equal(cursor.lastReviewRound, 5)
})

test('轮次 ≥3 → TRIGGER + 双冷却重置', async () => {
  const { deps, logs } = makeDeps()
  // 注入假 fireReview (不实际 spawn)
  deps.runSub = async () => ({ ok: true, stdout: '{"simple":[],"complex":[]}' })
  deps.openDb = () => makeFakeDb([]) // 无新消息? → 我们先测触发, fireReview 会 REVIEW_SKIP
  const r = createExperienceReviewer(deps)
  r.handleTransform({ messages: msgs(3) }) // 基线 3
  r.handleTransform({ messages: msgs(4) }) // 4-3=1 不够
  r.handleTransform({ messages: msgs(6) }) // 6-3=3 → 触发
  assert.ok(logs.some((l) => l.startsWith('TRIGGER')), '应触发')
  const cursor = r.readCursor()
  assert.equal(cursor.lastReviewRound, 6) // 冷却重置到 6
  // 触发后 channel 冷却 → 再来一轮不触发 — 需等 fireReview 完成 (REVIEW_SKIP 也算)
  await new Promise((res) => setTimeout(res, 10))
  r.handleTransform({ messages: msgs(6) }) // 6-6=0 不触发
  const triggers = logs.filter((l) => l.startsWith('TRIGGER')).length
  assert.equal(triggers, 1)
})

test('时间 ≥10min → TRIGGER 即使轮次差 <3', async () => {
  const { deps, logs, advance } = makeDeps()
  deps.runSub = async () => ({ ok: true, stdout: '{"simple":[],"complex":[]}' })
  deps.openDb = () => makeFakeDb([])
  const r = createExperienceReviewer(deps)
  r.handleTransform({ messages: msgs(3) }) // 基线 3
  advance(600001) // 时间超 10min
  r.handleTransform({ messages: msgs(3) }) // 轮次差 0, 但时间触发
  assert.ok(logs.some((l) => l.startsWith('TRIGGER') && l.includes('timeHit=true')))
})

test('触发后双冷却: 轮次和时间同时重置', async () => {
  const { deps, logs, advance } = makeDeps()
  deps.runSub = async () => ({ ok: true, stdout: '{"simple":[],"complex":[]}' })
  deps.openDb = () => makeFakeDb([])
  const r = createExperienceReviewer(deps)
  r.handleTransform({ messages: msgs(1) }) // 基线 1
  advance(600001 + 1000) // 时间触发
  r.handleTransform({ messages: msgs(1) })
  assert.ok(logs.some((l) => l.startsWith('TRIGGER')))
  await new Promise((res) => setTimeout(res, 10))
  advance(1000) // 仅过 1s, 时间冷却中
  r.handleTransform({ messages: msgs(3) }) // 轮次 3-1=2 <3 不够
  const triggers = logs.filter((l) => l.startsWith('TRIGGER')).length
  assert.equal(triggers, 1, '冷却期内不应再次触发')
})

test('子代理消息不再跳过: 状态只认项目路径, 与 session/派发标记无关', () => {
  const { deps, logs } = makeDeps()
  const r = createExperienceReviewer(deps)
  r.handleTransform({ messages: msgs(10, { subagent: true }) })
  // 不再有 reason=subagent 跳过; 首次仅是基线, 不触发
  assert.ok(logs.every((l) => !l.startsWith('TRIGGER')), '首次仅基线, 不触发')
  assert.ok(logs.every((l) => !l.includes('reason=subagent')), '不再跳过子代理消息')
  const cursor = r.readCursor()
  assert.equal(cursor.lastReviewRound, 10) // 子代理消息也正常计入轮次
})

test('v2 关键: 触发不修改任何 part (主会话零注入)', () => {
  const { deps, logs } = makeDeps()
  deps.runSub = async () => ({ ok: true, stdout: '{"simple":[],"complex":[]}' })
  deps.openDb = () => makeFakeDb([])
  const r = createExperienceReviewer(deps)
  const messages = msgs(5)
  const partsBefore = messages[4].parts.length
  r.handleTransform({ messages }) // 基线 5
  r.handleTransform({ messages: msgs(5) }) // 不足触发
  r.handleTransform({ messages: msgs(8) }) // 3 轮 → 触发
  assert.ok(logs.some((l) => l.startsWith('TRIGGER')))
  assert.equal(messages[4].parts.length, partsBefore, 'parts 数量不变')
})

test('fireReview: 无新消息 → REVIEW_SKIP', async () => {
  const { deps, logs } = makeDeps()
  deps.openDb = () => makeFakeDb([]) // 空表 → 无消息
  const r = createExperienceReviewer(deps)
  const ok = await r.fireReview()
  assert.equal(ok, false)
  assert.ok(logs.some((l) => l.includes('REVIEW_SKIP')), '应跳过')
})

test('fireReview: subagent 成功 → 写 AGENTS.md + 更新 cursor', async () => {
  const { deps, files, logs } = makeDeps()
  const fakeRows = [
    { message_id: 'msg_1', role: 'user', text: '用户说: 目录区分大小写' },
    { message_id: 'msg_2', role: 'assistant', text: '好的, 记住了' },
  ]
  deps.openDb = () => makeFakeDb(fakeRows)
  deps.runSub = async () => ({
    ok: true,
    stdout: '{"simple":[{"scope":"project","text":"目录区分大小写"}],"complex":[]}',
  })
  const r = createExperienceReviewer(deps)
  const ok = await r.fireReview()
  assert.equal(ok, true)
  // cursor 更新
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.equal(cursor.lastMessageId, 'msg_2')
  // AGENTS.md 写入
  assert.ok(files.has(PROJ_MD), '项目 AGENTS.md 应存在')
  assert.ok(files.get(PROJ_MD).includes('目录区分大小写'))
  assert.ok(logs.some((l) => l.includes('REVIEW_DONE')), 'REVIEW_DONE 应出现')
})

test('fireReview: subagent 失败 → 不更新 cursor', async () => {
  const { deps } = makeDeps()
  deps.openDb = () => makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'hi' },
    { message_id: 'msg_2', role: 'assistant', text: 'ok' },
  ])
  deps.runSub = async () => ({ ok: false, reason: 'timeout', stdout: '', stderr: 'x' })
  const r = createExperienceReviewer(deps)
  const ok = await r.fireReview()
  assert.equal(ok, false)
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.equal(cursor, null, '失败不应更新 cursor')
})

test('fireReview: 复杂经验写入失败 → 不更新 cursor', async () => {
  const { deps } = makeDeps()
  deps.openDb = () => makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'hi' },
    { message_id: 'msg_2', role: 'assistant', text: 'ok' },
  ])
  deps.runSub = async () => ({
    ok: true,
    stdout: '{"simple":[],"complex":[{"title":"t","content":"c"}]}',
  })
  deps.storeComplex = async () => ({ success: false }) // stub 未就绪
  const r = createExperienceReviewer(deps)
  const ok = await r.fireReview()
  assert.equal(ok, false)
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.equal(cursor, null, '复杂经验失败不应推进 cursor')
})

test('extractJsonBlock: 纯 JSON / 带前缀 / 代码块', () => {
  // 纯
  assert.deepEqual(extractJsonBlock('{"a":1}'), { a: 1 })
  // 带前后缀
  assert.deepEqual(extractJsonBlock('思考...\n{"a":1}\n结束'), { a: 1 })
  // 代码块
  assert.deepEqual(extractJsonBlock('```json\n{"a":1}\n```'), { a: 1 })
  // 无效
  assert.equal(extractJsonBlock('no json here'), null)
  assert.equal(extractJsonBlock(''), null)
})

test('parseReviewOutput: simple/complex 解析 + suggestGlobal 判定 (v2.2 归一)', () => {
  const out = parseReviewOutput(
    '{"simple":[{"scope":"global","text":"G1"},{"scope":"project","text":"P1"},{"text":"无scope"},{"suggestGlobal":true,"text":"SG1"}],"complex":[{"title":"T1","content":"C1","description":"使用时机: x"}]}'
  )
  assert.equal(out.simple.length, 4)
  // scope 一律 project; 旧 scope=global 与 suggestGlobal=true 归一为 suggestGlobal
  assert.equal(out.simple[0].scope, 'project')
  assert.equal(out.simple[0].suggestGlobal, true, 'scope=global → suggestGlobal=true')
  assert.equal(out.simple[1].scope, 'project')
  assert.equal(out.simple[1].suggestGlobal, false)
  assert.equal(out.simple[2].scope, 'project', '无 scope 默认 project')
  assert.equal(out.simple[2].suggestGlobal, false)
  assert.equal(out.simple[3].suggestGlobal, true, 'suggestGlobal=true 透传')
  assert.equal(out.complex.length, 1)
  assert.equal(out.complex[0].title, 'T1')
})

test('parseReviewOutput: 非 JSON → 空结果', () => {
  const out = parseReviewOutput('我什么都没发现')
  assert.deepEqual(out, { simple: [], complex: [] })
})

test('写入: 全部写项目 MD (v2.2), suggestGlobal → [建议全局] 前缀, 去重', () => {
  const { deps, files } = makeDeps()
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: '本地规则' },
    { scope: 'project', suggestGlobal: true, text: '疑似全局规则' },
  ])
  assert.ok(files.get(PROJ_MD).includes('本地规则'))
  assert.ok(files.get(PROJ_MD).includes('- [建议全局] 疑似全局规则'), 'suggestGlobal 加 [建议全局] 前缀')
  assert.ok(!files.has(GLOBAL_MD), 'v2.2 不直写全局 AGENTS.md')
  // 再写同样的 → 去重, 不重复
  r.writeSimpleEntries([{ scope: 'project', suggestGlobal: false, text: '本地规则' }])
  const content = files.get(PROJ_MD)
  const count = content.split('本地规则').length - 1
  assert.equal(count, 1, '不应重复')
})

test('写入: 大小上限', () => {
  const { deps, files, logs } = makeDeps({ maxMdBytes: 100 })
  const r = createExperienceReviewer(deps)
  // 三条 ≤50 字文本 (不触 MD_TOO_LONG 护栏), 前两条写满, 第三条触发 MD_FULL
  r.writeSimpleEntries([
    { scope: 'project', text: 'a'.repeat(40) },
    { scope: 'project', text: 'b'.repeat(40) },
    { scope: 'project', text: 'c'.repeat(40) },
  ])
  const content = files.get(PROJ_MD)
  assert.ok(content, '前两条应写入')
  assert.ok(content.includes('a'.repeat(40)) && content.includes('b'.repeat(40)), '前两条应在')
  assert.ok(!content.includes('c'.repeat(40)), '第三条超上限不应写入')
  assert.ok(logs.some((l) => l.includes('MD_FULL')), '应告警 MD_FULL')
})

test('ensureOverviewReminder: 有概述标记 → 记 hasOverview, 不注入', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '> **项目概述**: 测试项目\n# 项目规则\n- 规则1\n')
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureOverviewReminder({ messages })
  assert.equal(messages[0].parts.length, 1, '有概述不应注入')
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.equal(cursor.hasOverview, true, '应记录 hasOverview=true')
})

test('ensureOverviewReminder: 缺概述标记 → 每次 user-turn 都注入 (v2.5 persistent, 不再写 overviewPrompted)', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '# 项目规则\n- 规则1\n') // 无 > **项目概述**: 标记
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureOverviewReminder({ messages })
  const lastUser = messages[messages.length - 1]
  assert.ok(
    lastUser.parts.some((p) => p.synthetic === true && p.text.includes('项目概述')),
    '缺概述应注入 synthetic 提醒 part'
  )
  // v2.5: 不再写 cursor.overviewPrompted 字段 (废弃)
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.notEqual(cursor?.overviewPrompted, true, 'v2.5 不再写 overviewPrompted')
  // v2.5: 再次调用 → 仍注入 (persistent 语义, 未写入就一直提醒)
  const messages2 = msgs(1)
  r.ensureOverviewReminder({ messages: messages2 })
  const lastUser2 = messages2[messages2.length - 1]
  assert.ok(
    lastUser2.parts.some((p) => p.synthetic === true && p.text.includes('项目概述')),
    '缺概述未补写 → 第二次仍注入 (v2.5 persistent, 「直到写入为止」)'
  )
})

test('ensureOverviewReminder: 最后一条非 user (assistant 生成/工具循环) → 不注入', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '# 项目规则\n- 规则1\n')
  const r = createExperienceReviewer(deps)
  // user 消息后紧跟 assistant 消息: 模拟助手生成/工具循环阶段的 transform
  const user = msgs(1)[0]
  const assistant = { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] }
  const messages = [user, assistant]
  r.ensureOverviewReminder({ messages })
  assert.equal(user.parts.length, 1, 'tail 非 user 不应注入')
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.notEqual(cursor?.overviewPrompted, true, '不应写 overviewPrompted')
})

test('ensureOverviewReminder: 项目开关 disabled → 跳过', () => {
  const { deps, files } = makeDeps()
  files.set(join('C:/proj', '.experience-reviewer', 'config.json'), JSON.stringify({ enabled: false }))
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureOverviewReminder({ messages })
  assert.equal(messages[0].parts.length, 1, 'disabled 不注入')
})

test('readUnsummarizedMessages: directory 匹配 + cursor 增量 (time_created > last)', () => {
  const db = makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'old' }, // t0
    { message_id: 'msg_2', role: 'assistant', text: 'mid' }, // t1
    { message_id: 'msg_3', role: 'user', text: 'new' }, // t2
  ])
  const rows = readUnsummarizedMessages({
    db,
    directory: 'C:/proj',
    lastMessageId: 'msg_1',
    limit: 200,
  })
  // cursor=msg_1(time=t0) → 只留 time>t0 的 msg_2,msg_3, 升序
  assert.equal(rows.length, 2)
  assert.equal(rows[0].message_id, 'msg_2')
  assert.equal(rows[0].role, 'assistant')
  assert.equal(rows[0].text, 'mid')
  assert.equal(rows[1].message_id, 'msg_3')
  assert.equal(rows[1].text, 'new')
})

test('readUnsummarizedMessages: directory 不匹配 → 空数组', () => {
  const db = makeFakeDb([{ message_id: 'msg_1', role: 'user', text: 'x' }])
  const rows = readUnsummarizedMessages({ db, directory: 'D:/elsewhere', limit: 10 })
  assert.deepEqual(rows, [])
})

test('readUnsummarizedMessages: 排除 subagent 子会话 (parent_id 非空)', () => {
  const db = makeFakeDb([{ message_id: 'msg_1', role: 'user', text: '主会话' }])
  // 追加子会话 + 消息 (子会话消息时间更新, 若被误纳入会污染结果)
  db.prepare(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'ses_sub', 'ses_main', 'C:/proj', null, 9_000_000_000_000, 9_000_000_000_000
  )
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_sub', 'ses_sub', 9_000_000_000_001, 9_000_000_000_001, JSON.stringify({ role: 'user' })
  )
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'prt_sub', 'msg_sub', 'ses_sub', 9_000_000_000_001, 9_000_000_000_001, JSON.stringify({ type: 'text', text: '子会话' })
  )
  const rows = readUnsummarizedMessages({ db, directory: 'C:/proj', limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'msg_1', '子会话消息不应被读取')
})

test('readUnsummarizedMessages: 排除 subagent 独立会话 (title=EXP_EXTRACTOR)', () => {
  const db = makeFakeDb([{ message_id: 'msg_1', role: 'user', text: '主会话' }])
  // 追加 --pure 独立 subagent 会话 (parent_id NULL 但 title 带标记; 消息时间更新)
  db.prepare(`INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'ses_ext', null, 'C:/proj', 'EXP_EXTRACTOR', 9_000_000_000_000, 9_000_000_000_000
  )
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_ext', 'ses_ext', 9_000_000_000_001, 9_000_000_000_001, JSON.stringify({ role: 'user' })
  )
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'prt_ext', 'msg_ext', 'ses_ext', 9_000_000_000_001, 9_000_000_000_001, JSON.stringify({ type: 'text', text: '你是经验提取器' })
  )
  const rows = readUnsummarizedMessages({ db, directory: 'C:/proj', limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'msg_1', 'title 标记的 subagent 会话不应被读取')
})

test('readUnsummarizedMessages: 只取 user/assistant 且有 text 分区的消息', () => {
  const db = makeFakeDb([{ message_id: 'msg_1', role: 'user', text: '正常消息' }])
  // tool 消息 (role 过滤) + 无 text 分区消息 → 都应被丢弃
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_tool', 'ses_main', 2_000_000_000_000, 2_000_000_000_000, JSON.stringify({ role: 'tool' })
  )
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'prt_tool', 'msg_tool', 'ses_main', 2_000_000_000_000, 2_000_000_000_000, JSON.stringify({ type: 'tool', text: '调工具' })
  )
  db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(
    'msg_notext', 'ses_main', 3_000_000_000_000, 3_000_000_000_000, JSON.stringify({ role: 'assistant' })
  )
  db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'prt_notext', 'msg_notext', 'ses_main', 3_000_000_000_000, 3_000_000_000_000, JSON.stringify({ type: 'thinking', text: '只思考无输出' })
  )
  const rows = readUnsummarizedMessages({ db, directory: 'C:/proj', limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].message_id, 'msg_1')
})

test('readUnsummarizedMessages: 无 cursor → 只取最近 limit 条 (DESC 反转升序, 不啃历史)', () => {
  const db = makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'old' }, // t0
    { message_id: 'msg_2', role: 'user', text: 'mid' }, // t1
    { message_id: 'msg_3', role: 'user', text: 'new' }, // t2
  ])
  const got = readUnsummarizedMessages({ db, directory: 'C:/proj', limit: 2 })
  // DESC 取最新 2 条 → [msg_3, msg_2] → 代码反转升序 → [msg_2, msg_3]; msg_1 被跳过
  assert.equal(got.length, 2)
  assert.equal(got[0].message_id, 'msg_2')
  assert.equal(got[1].message_id, 'msg_3')
})

test('readUnsummarizedMessages: 有 cursor → ASC 增量, 不走 DESC', () => {
  const db = makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'old' }, // t0
    { message_id: 'msg_2', role: 'user', text: 'mid' }, // t1
    { message_id: 'msg_3', role: 'user', text: 'new' }, // t2
  ])
  const got = readUnsummarizedMessages({ db, directory: 'C:/proj', lastMessageId: 'msg_1', limit: 4 })
  assert.equal(got.length, 2)
  assert.equal(got[0].message_id, 'msg_2')
  assert.equal(got[1].message_id, 'msg_3')
})

test('projectIdFromCwd: sha256 前 16 位, 与 OCM 实测一致', () => {
  const pid = projectIdFromCwd('D:\\AI\\my_programs\\OpencodeOptimize')
  assert.equal(pid, 'b86d670963d94466') // 已从 memory.db 实测验证
})

test('buildSubagentPrompt: 对话记录在前, 规则/JSON schema 在后', () => {
  const prompt = buildSubagentPrompt([
    { message_id: '1', role: 'user', text: '你好' },
    { message_id: '2', role: 'assistant', text: '世界' },
  ])
  assert.ok(prompt.includes('[用户] 你好'))
  assert.ok(prompt.includes('[助手] 世界'))
  assert.ok(prompt.includes('"simple"'))
  assert.ok(prompt.includes('"complex"'))
  // 结构: 对话记录在前 (前缀与主会话一致), 规则/JSON 在末尾
  const dialogMarker = prompt.indexOf('===== 对话记录 =====')
  const taskMarker = prompt.indexOf('===== 提取任务 =====')
  assert.ok(dialogMarker >= 0 && taskMarker > dialogMarker, '对话记录应在提取任务之前')
  assert.ok(dialogMarker < prompt.indexOf('你是经验提取器'), '对话记录应在规则之前')
  assert.ok(prompt.includes('≤50'), 'simple 应有 ≤50 字约束')
  // JSON schema 必须在 transcript 之后 (规则在末尾)
  const jsonPos = prompt.indexOf('"simple":[{')
  assert.ok(jsonPos > dialogMarker, 'JSON schema 应在对话记录之后')
})

test('groupIntoTurns: user+assistant = 完整一轮, cursor 推进到 assistant 末尾', () => {
  const { turns, lastCompleteMessageId } = groupIntoTurns([
    { message_id: 'u1', role: 'user', text: 'a' },
    { message_id: 'a1', role: 'assistant', text: 'b' },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user.length, 1)
  assert.equal(turns[0].assistant.length, 1)
  assert.equal(lastCompleteMessageId, 'a1')
})

test('groupIntoTurns: user+user+assistant 也只算一轮 (连续 user 合并)', () => {
  const { turns, lastCompleteMessageId } = groupIntoTurns([
    { message_id: 'u1', role: 'user', text: 'a' },
    { message_id: 'u2', role: 'user', text: 'b' },
    { message_id: 'a1', role: 'assistant', text: 'c' },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user.length, 2, '连续 user 合并为一次发言')
  assert.equal(turns[0].assistant.length, 1)
  assert.equal(lastCompleteMessageId, 'a1')
})

test('groupIntoTurns: user+assistant+assistant 也只算一轮 (连续 assistant 合并)', () => {
  const { turns, lastCompleteMessageId } = groupIntoTurns([
    { message_id: 'u1', role: 'user', text: 'a' },
    { message_id: 'a1', role: 'assistant', text: 'b' },
    { message_id: 'a2', role: 'assistant', text: 'c' },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user.length, 1)
  assert.equal(turns[0].assistant.length, 2, '连续 assistant 合为一次回复')
  assert.equal(lastCompleteMessageId, 'a2', '推进到回复末尾')
})

test('groupIntoTurns: 孤儿 assistant (无前置 user) 丢弃, 不构成轮次', () => {
  const { turns, lastCompleteMessageId } = groupIntoTurns([
    { message_id: 'a1', role: 'assistant', text: '回复尾巴' },
    { message_id: 'u1', role: 'user', text: 'x' },
    { message_id: 'a2', role: 'assistant', text: 'y' },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].user[0].message_id, 'u1', '孤儿 assistant 不并入轮次')
  assert.equal(lastCompleteMessageId, 'a2')
})

test('groupIntoTurns: 尾部悬挂 user (无回复) 不构成轮次, cursor 不推进过它', () => {
  const { turns, lastCompleteMessageId } = groupIntoTurns([
    { message_id: 'u1', role: 'user', text: 'a' },
    { message_id: 'a1', role: 'assistant', text: 'b' },
    { message_id: 'u2', role: 'user', text: '对话进行中' },
  ])
  assert.equal(turns.length, 1, '只有 u1+a1 构成完整轮次')
  assert.equal(lastCompleteMessageId, 'a1', 'cursor 停在最后完整轮次末尾, 不吞悬挂 user')
})

test('groupIntoTurns: 全部孤儿/悬挂 → 无完整轮次, lastCompleteMessageId=null', () => {
  const { turns, lastCompleteMessageId } = groupIntoTurns([
    { message_id: 'a1', role: 'assistant', text: '尾巴' },
    { message_id: 'u1', role: 'user', text: '待回复' },
  ])
  assert.equal(turns.length, 0)
  assert.equal(lastCompleteMessageId, null)
})

test('groupIntoTurns: buildSubagentPrompt 按轮次渲染, 多轮含轮次编号', () => {
  const prompt = buildSubagentPrompt([
    { message_id: 'u1', role: 'user', text: '第一问' },
    { message_id: 'a1', role: 'assistant', text: '第一答' },
    { message_id: 'u2', role: 'user', text: '第二问' },
    { message_id: 'a2', role: 'assistant', text: '第二答' },
  ])
  assert.ok(prompt.includes('[轮次 1]'))
  assert.ok(prompt.includes('[轮次 2]'))
  assert.ok(prompt.includes('[用户] 第一问'))
  assert.ok(prompt.includes('[助手] 第二答'))
})

// ---------------------------------------------------------------------------
// OCM HTTP API 接入层 (storeComplexExperience / queryExperiences)
// ---------------------------------------------------------------------------

/** 假 fetch: 记录请求 + 返回预设响应 */
function fakeFetch({ status = 200, body = {}, onRequest = () => {} } = {}) {
  return async (url, opts = {}) => {
    onRequest(url, opts)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
}

test('storeComplexExperience: POST /experiences 字段映射 (project+projectHash)', async () => {
  let reqUrl = ''
  let reqBody = null
  const fetchImpl = fakeFetch({
    body: { success: true, id: 'exp-1', title: '经验', scope: 'project', type: 'dev', message: 'ok' },
    onRequest: (url, opts) => {
      reqUrl = url
      reqBody = JSON.parse(opts.body)
    },
  })
  const r = await storeComplexExperience(
    { title: '经验', description: '使用时机: x', content: 'body', type: 'dev', triggers: ['tag'] },
    { projectId: 'b86d670963d94466', fetchImpl }
  )
  assert.equal(r.success, true)
  assert.equal(r.id, 'exp-1')
  assert.ok(reqUrl.endsWith('/experiences'), `url=${reqUrl}`)
  assert.equal(reqBody.title, '经验')
  assert.equal(reqBody.scope, 'project')
  assert.equal(reqBody.projectHash, 'b86d670963d94466')
  assert.equal(reqBody.triggers, '["tag"]')
})

test('storeComplexExperience: scope=global 不带 projectHash', async () => {
  let reqBody = null
  const fetchImpl = fakeFetch({
    body: { success: true, id: 'exp-2', scope: 'global', type: 'dev', message: 'ok' },
    onRequest: (_url, opts) => (reqBody = JSON.parse(opts.body)),
  })
  await storeComplexExperience(
    { title: 'G', description: '使用时机: x', content: 'c', scope: 'global' },
    { projectId: 'b86d670963d94466', fetchImpl }
  )
  assert.equal(reqBody.scope, 'global')
  assert.equal(reqBody.projectHash, undefined, 'global 不应带 projectHash')
})

test('storeComplexExperience: 网络失败 → success=false + reason', async () => {
  const fetchImpl = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:7333')
  }
  const r = await storeComplexExperience(
    { title: 'T', description: '使用时机: x', content: 'c' },
    { projectId: 'abc', fetchImpl }
  )
  assert.equal(r.success, false)
  assert.ok(r.reason.includes('ECONNREFUSED'), `reason=${r.reason}`)
})

test('storeComplexExperience: 用户态失败 (message) 透传', async () => {
  const fetchImpl = fakeFetch({
    status: 200,
    body: { success: false, message: 'Database not ready' },
  })
  const r = await storeComplexExperience(
    { title: 'T', description: '使用时机: x', content: 'c' },
    { fetchImpl }
  )
  assert.equal(r.success, false)
  assert.equal(r.reason, 'Database not ready')
})

test('queryExperiences: GET /experiences 传 scope/type/topK/projectHash', async () => {
  let reqUrl = ''
  const fetchImpl = fakeFetch({
    body: {
      success: true,
      experiences: [{ id: 'a', title: '旧经验' }],
      project_hash: 'b86d670963d94466',
      scope: 'all',
      type: 'all',
      count: 1,
    },
    onRequest: (url) => (reqUrl = url),
  })
  const r = await queryExperiences({
    scope: 'all',
    type: 'all',
    topK: 500,
    projectId: 'b86d670963d94466',
    fetchImpl,
  })
  assert.equal(r.success, true)
  assert.equal(r.experiences.length, 1)
  assert.equal(r.experiences[0].title, '旧经验')
  assert.ok(reqUrl.includes('scope=all'))
  assert.ok(reqUrl.includes('type=all'))
  assert.ok(reqUrl.includes('topK=500'))
  assert.ok(reqUrl.includes('projectHash=b86d670963d94466'))
})

test('queryExperiences: 失败 → success=false + 空数组', async () => {
  const fetchImpl = fakeFetch({ status: 200, body: { success: false, message: 'Database not ready' } })
  const r = await queryExperiences({ fetchImpl })
  assert.equal(r.success, false)
  assert.deepEqual(r.experiences, [])
  assert.equal(r.reason, 'Database not ready')
})

test('fireReview: 复杂经验已存在 → COMPLEX_DEDUP 跳过, 不重复 store', async () => {
  const { deps, logs } = makeDeps()
  deps.openDb = () => makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'hi' },
    { message_id: 'msg_2', role: 'assistant', text: 'ok' },
  ])
  deps.runSub = async () => ({
    ok: true,
    stdout: '{"simple":[],"complex":[{"title":"已存在","description":"使用时机: x","content":"c"}]}',
  })
  deps.queryExp = async () => ({
    success: true,
    experiences: [{ id: 'exp-existing', title: '已存在' }],
  })
  let storeCalled = 0
  deps.storeComplex = async () => {
    storeCalled++
    return { success: true }
  }
  const r = createExperienceReviewer(deps)
  const ok = await r.fireReview()
  assert.equal(ok, true)
  assert.equal(storeCalled, 0, '已存在 → 不应调用 storeComplex')
  assert.ok(logs.some((l) => l.includes('COMPLEX_DEDUP')), '应有 COMPLEX_DEDUP 日志')
})

test('fireReview: 复杂经验不存在 → 调 storeComplex 并传 projectId', async () => {
  const { deps } = makeDeps()
  deps.openDb = () => makeFakeDb([
    { message_id: 'msg_1', role: 'user', text: 'hi' },
    { message_id: 'msg_2', role: 'assistant', text: 'ok' },
  ])
  deps.runSub = async () => ({
    ok: true,
    stdout: '{"simple":[],"complex":[{"title":"新经验","description":"使用时机: x","content":"c"}]}',
  })
  deps.queryExp = async () => ({ success: true, experiences: [] })
  let storeCall = null
  deps.storeComplex = async (entry, opts) => {
    storeCall = { entry, projectId: opts?.projectId }
    return { success: true }
  }
  const r = createExperienceReviewer(deps)
  await r.fireReview()
  assert.ok(storeCall, '应调用 storeComplex')
  assert.equal(storeCall.entry.title, '新经验')
  assert.equal(typeof storeCall.projectId, 'string')
  assert.equal(storeCall.projectId.length, 16, 'projectId 应为 sha256[:16]')
})

test('computeCacheStats: 从 step-finish tokens 算命中率', () => {
  // opencode part.data (step-finish): {tokens: {input, output, cache: {write, read}}} — 模型返回 usage
  const s = computeCacheStats({ input: 40553, output: 5037, cache: { write: 0, read: 1792 } })
  assert.equal(s.input, 40553)
  assert.equal(s.cacheRead, 1792)
  assert.equal(s.cacheWrite, 0)
  // hitRate = cacheRead / (cacheRead + input) = 1792 / 42345 ≈ 0.0423
  assert.ok(Math.abs(s.hitRate - 0.0423) < 0.001, `hitRate=${s.hitRate}`)
})

test('computeCacheStats: 无 cache / 非法输入 → 兜底', () => {
  const noCache = computeCacheStats({ input: 100, cache: { read: 0, write: 0 } })
  assert.equal(noCache.hitRate, 0)
  const zeroInput = computeCacheStats({ input: 0, cache: { read: 0, write: 0 } })
  assert.equal(zeroInput.hitRate, 0)
  assert.equal(computeCacheStats(null), null)
  assert.equal(computeCacheStats(undefined), null)
  assert.equal(computeCacheStats({}), null, '缺 input/cache → null')
})

test('readLastSubagentUsage: 读 EXP_EXTRACTOR 会话 step-finish tokens', () => {
  const db = makeFakeDb([], {})
  // 插入 EXP_EXTRACTOR 子会话 + assistant 消息 + step-finish part
  const sesId = 'ses_extractor'
  db.prepare(
    `INSERT INTO session (id, parent_id, directory, title, time_created, time_updated)
     VALUES (?, NULL, 'C:/proj', 'EXP_EXTRACTOR', 1700000001000, 1700000001000)`
  ).run(sesId)
  const msgId = 'msg_extractor'
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, 1700000002000, 1700000002000, ?)`
  ).run(msgId, sesId, JSON.stringify({ role: 'assistant' }))
  db.prepare(
    `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, 1700000003000, 1700000003000, ?)`
  ).run('prt_step', msgId, sesId, JSON.stringify({
    type: 'step-finish',
    tokens: { input: 1000, output: 50, cache: { write: 0, read: 9000 } },
  }))
  const stats = readLastSubagentUsage(db)
  assert.ok(stats, '应读到 usage')
  assert.equal(stats.input, 1000)
  assert.equal(stats.cacheRead, 9000)
  assert.ok(Math.abs(stats.hitRate - 0.9) < 0.001, `hitRate=${stats.hitRate}`)
  db.close()
})

test('readLastSubagentUsage: 无 EXP_EXTRACTOR 会话 → null (不阻塞)', () => {
  const db = makeFakeDb([], {})
  assert.equal(readLastSubagentUsage(db), null)
  db.close()
})

test('writeSimpleEntries: 超长 simple 拒绝落盘 (MD_TOO_LONG 护栏)', async () => {
  const { deps, files, logs } = makeDeps()
  const r = createExperienceReviewer(deps)
  // 直接构造超长 simple (模拟 LLM 输出百字长句冒充)
  const longText = '这是一条超过五十个字符限制的简单经验提取文本，用于验证 writeSimpleEntries 的护栏逻辑确实生效，防止 LLM 输出超长内容污染 AGENTS.md 文件，这条经验本来应该被升级为 complex 类型而不是放在 simple 里充数'
  r.writeSimpleEntries([{ scope: 'project', text: longText }])
  assert.ok(!files.has(PROJ_MD), '超长 simple 不应写入 AGENTS.md')
  assert.ok(logs.some((l) => l.includes('MD_TOO_LONG')), '应有 MD_TOO_LONG 日志')
})

test('writeSimpleEntries: 正常长度 simple 仍写入 (护栏不误伤)', async () => {
  const { deps, files, logs } = makeDeps()
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([{ scope: 'project', text: '目录区分大小写' }])
  assert.ok(files.has(PROJ_MD), '正常长度 simple 应写入')
  assert.ok(files.get(PROJ_MD).includes('目录区分大小写'))
  assert.ok(logs.every((l) => !l.includes('MD_TOO_LONG')), '不应有 MD_TOO_LONG')
})

// ===== 按项目开关: <项目根>/.experience-reviewer/config.json {"enabled": false} =====
const CONFIG_PATH = join('C:/proj', '.experience-reviewer', 'config.json')

test('项目开关: 无 config → 默认开启 (不误伤)', () => {
  const { deps, files, logs } = makeDeps()
  const r = createExperienceReviewer(deps)
  assert.equal(r.isDisabled(), false, '无 config 应默认开启')
  // handleTransform 正常走触发逻辑 (首次写基线 cursor, 不触发)
  r.handleTransform({ messages: msgs(3) })
  assert.ok(!logs.some((l) => l.startsWith('TRIGGER')), '首次不应触发')
  const cursor = r.readCursor()
  assert.equal(cursor.lastReviewRound, 3, '应正常写基线 cursor')
})

test('项目开关: config enabled=false → handleTransform 完全跳过 (不写 cursor)', () => {
  const { deps, files, logs } = makeDeps()
  files.set(CONFIG_PATH, JSON.stringify({ enabled: false }))
  const r = createExperienceReviewer(deps)
  assert.equal(r.isDisabled(), true, 'enabled=false 应判定为关闭')
  r.handleTransform({ messages: msgs(5) })
  assert.equal(r.readCursor(), null, 'disabled 时不应写任何 cursor')
  assert.ok(logs.every((l) => !l.startsWith('TRIGGER') && !l.startsWith('TRANSFORM_WATCH')), '不应有任何触发/观察日志')
})

test('项目开关: config enabled=false → fireReview 返回 false + REVIEW_SKIP disabled-by-config', async () => {
  const { deps, files, logs } = makeDeps()
  files.set(CONFIG_PATH, JSON.stringify({ enabled: false }))
  const r = createExperienceReviewer(deps)
  const ok = await r.fireReview()
  assert.equal(ok, false, 'disabled 时 fireReview 应返回 false')
  assert.ok(logs.some((l) => l.includes('REVIEW_SKIP reason=disabled-by-config')), '应有 disabled-by-config 日志')
  // 兜底: 即使被外部直接调用 fireReview 也被拦截, 不会 spawn subagent
  assert.ok(!logs.some((l) => l.includes('REVIEW_START')), '不应走到 REVIEW_START')
})

test('项目开关: config enabled=true 或损坏 → 不误伤 (视为开启)', async () => {
  const { deps, files, logs } = makeDeps()
  files.set(CONFIG_PATH, JSON.stringify({ enabled: true }))
  const r = createExperienceReviewer(deps)
  assert.equal(r.isDisabled(), false, 'enabled=true 应开启')
  // 损坏 JSON → 视为开启 (不误伤)
  const { deps: d2, files: f2, logs: l2 } = makeDeps()
  f2.set(CONFIG_PATH, '{broken json')
  const r2 = createExperienceReviewer(d2)
  assert.equal(r2.isDisabled(), false, '损坏 config 应视为开启')
})

test('buildSubagentPrompt: 传项目概述 → 注入项目身份段, subagent 知道所处项目', () => {
  const prompt = buildSubagentPrompt(
    [
      { message_id: '1', role: 'user', text: '你好' },
      { message_id: '2', role: 'assistant', text: '世界' },
    ],
    'opencode 插件集' // 项目概述
  )
  assert.ok(prompt.includes('你正在为以下项目提取经验'), '应包含项目身份引导词')
  assert.ok(prompt.includes('opencode 插件集'), '应包含项目概述内容')
  // 身份段必须在对话记录之前 (顺序: 项目身份 → 对话记录 → 规则)
  const identityPos = prompt.indexOf('===== 项目身份 =====')
  const dialogMarker = prompt.indexOf('===== 对话记录 =====')
  assert.ok(identityPos >= 0 && identityPos < dialogMarker, '项目身份段应在对话记录之前')
})

test('buildSubagentPrompt: 不传概述 → 无项目身份段 (向后兼容)', () => {
  const prompt = buildSubagentPrompt([
    { message_id: '1', role: 'user', text: '你好' },
    { message_id: '2', role: 'assistant', text: '世界' },
  ])
  assert.ok(!prompt.includes('===== 项目身份 ====='), '无概述不应生成身份段')
  assert.ok(prompt.includes('===== 对话记录 ====='), '对话记录应保留')
})

test('buildSubagentPrompt: 容量规则只作参考, 未达上限时不限制提取', () => {
  const prompt = buildSubagentPrompt(
    [{ message_id: '1', role: 'user', text: '你好' }, { message_id: '2', role: 'assistant', text: '世界' }],
    '',
    10
  )
  assert.ok(prompt.includes('当前 10 条'), '应注入当前条数')
  assert.ok(prompt.includes('上限 100 条'), '应注入上限条数')
  assert.ok(prompt.includes('正常提取'), '未达上限应允许正常提取')
  assert.ok(!prompt.includes('禁止新增条目'), '任何条数下都不应禁止新增')
})

test('buildSubagentPrompt: 已达上限 → 仍允许提取, 不做写入拦截', () => {
  const prompt = buildSubagentPrompt(
    [{ message_id: '1', role: 'user', text: '你好' }, { message_id: '2', role: 'assistant', text: '世界' }],
    '',
    120
  )
  assert.ok(prompt.includes('当前 120 条'), '应注入当前条数')
  assert.ok(prompt.includes('不限制提取'), '达上限后不限制提取')
  assert.ok(prompt.includes('正常提取'), '达上限后仍应正常提取')
  assert.ok(!prompt.includes('禁止新增条目'), '达上限不应禁止新增')
  assert.ok(!prompt.includes('已达上限'), '不应再有达上限拦截分支')
  assert.ok(!prompt.includes('prune'), '不应再要求 subagent 输出 prune 清单')
})

test('ensureRecycleReminder: 提醒里给出 60% 动态压缩目标 (非仅"压到上限内")', () => {
  const { deps, files } = makeDeps()
  const many = '# 项目规则\n' + Array.from({ length: 110 }, (_, i) => `- 条目${i}`).join('\n') + '\n'
  files.set(PROJ_MD, many)
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureRecycleReminder({ messages })
  const lastUser = messages[messages.length - 1]
  const injected = lastUser.parts.filter((p) => p.synthetic === true).map((p) => p.text).join('\n')
  assert.ok(injected.includes('110 条'), '应含实际条数')
  assert.ok(injected.includes('压到 60 条以内'), '应含 60% 计算出的压缩目标 (100*0.6)')
  // 7 个清理方向必须齐全, 否则主 agent 无判定依据
  for (const d of [
    '不符合存储门槛',
    '已解决的问题',
    '重复/同义',
    '作用域错位',
    '同一主题拆成多条',
    '低频场景占常驻',
    '依赖环境已变化',
  ]) {
    assert.ok(injected.includes(d), `应含清理方向: ${d}`)
  }
  // 门槛白名单须正向声明 (避免 agent 反读成"这四类要删")
  assert.ok(injected.includes('门槛 = 用户偏好'), '应正向声明门槛白名单')
  assert.ok(injected.includes('不得跳过推迟'), '应含不得跳过的硬约束')
  // 项目标识来自目录名, 便于多项目时区分是哪条经验
  assert.ok(injected.includes('【'), '应含项目标识前缀')
})

test('ensureSuggestGlobalReminder: 有 [建议全局] 条目 → 注入询问提醒 + 记条数, 不重复', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '# 项目规则\n- [建议全局] 用户偏好中文\n- [建议全局] 工具链通用坑\n- 本地规则\n')
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureSuggestGlobalReminder({ messages })
  const lastUser = messages[messages.length - 1]
  assert.ok(
    lastUser.parts.some((p) => p.synthetic === true && p.text.includes('[建议全局]') && p.text.includes('用户询问')),
    '应注入询问用户提醒'
  )
  const cursor = r.readCursor(join('C:/proj', '.experience-reviewer', 'experience-cursor.json'))
  assert.equal(cursor.suggestGlobalPromptedCount, 2, '应记录提醒时条数=2')
  // 再次调用 → 不重复注入 (防每轮刷屏)
  const messages2 = msgs(1)
  r.ensureSuggestGlobalReminder({ messages: messages2 })
  assert.equal(messages2[0].parts.length, 1, '已提醒过相同条数不重复注入')
})

test('ensureSuggestGlobalReminder: 新增条目数 > 上次提醒 → 再次提醒', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '- [建议全局] 一条\n')
  const r = createExperienceReviewer(deps)
  r.ensureSuggestGlobalReminder({ messages: msgs(1) })
  // 新增一条 → 2 > 1 → 再提醒
  files.set(PROJ_MD, '- [建议全局] 一条\n- [建议全局] 新增一条\n')
  const messages = msgs(1)
  r.ensureSuggestGlobalReminder({ messages })
  assert.ok(
    messages[0].parts.some((p) => p.synthetic === true && p.text.includes('[建议全局]')),
    '新增条目应再次提醒'
  )
})

test('ensureSuggestGlobalReminder: 无 [建议全局] 条目 → 不注入; tail 非 user → 不注入', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '# 项目规则\n- 本地规则\n')
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureSuggestGlobalReminder({ messages })
  assert.equal(messages[0].parts.length, 1, '无 [建议全局] 不应注入')
  // tail 非 user → 不注入
  files.set(PROJ_MD, '- [建议全局] 一条\n')
  const user = msgs(1)[0]
  const assistant = { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'ok' }] }
  const messages2 = [user, assistant]
  r.ensureSuggestGlobalReminder({ messages: messages2 })
  assert.equal(user.parts.length, 1, 'tail 非 user 不应注入')
})

test('ensureSuggestGlobalReminder: 处理回落后基线重置 → 再涨回重新提醒 (不存历史峰值)', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '- [建议全局] 一条\n- [建议全局] 两条\n')
  const r = createExperienceReviewer(deps)
  r.ensureSuggestGlobalReminder({ messages: msgs(1) }) // 首次提醒, 基线=2
  // 用户处理掉 1 条 (回落 2→1) → 不提醒, 但基线重置为 1
  files.set(PROJ_MD, '- [建议全局] 一条\n')
  const m1 = msgs(1)
  r.ensureSuggestGlobalReminder({ messages: m1 })
  assert.equal(m1[0].parts.length, 1, '回落后不应重复提醒')
  // 又新增 1 条 (再涨回 2) → 应重新提醒 (旧逻辑 2>=2 会被吞)
  files.set(PROJ_MD, '- [建议全局] 一条\n- [建议全局] 新一条\n')
  const m2 = msgs(1)
  r.ensureSuggestGlobalReminder({ messages: m2 })
  assert.ok(
    m2[0].parts.some((p) => p.synthetic === true && p.text.includes('[建议全局]')),
    '回落基线重置后, 再涨回应重新提醒'
  )
})

test('ensureRecycleReminder: 条目数 ≥100 → 注入检查清理提醒', () => {
  const { deps, files } = makeDeps()
  // 100 条 `- ` 开头经验
  const lines = Array.from({ length: 100 }, (_, i) => `- 经验${i}`)
  files.set(PROJ_MD, '# 项目规则\n' + lines.join('\n'))
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureRecycleReminder({ messages })
  const lastUser = messages[messages.length - 1]
  assert.ok(
    lastUser.parts.some((p) => p.synthetic === true && p.text.includes('100') && p.text.includes('删除')),
    '应注入检查清理提醒'
  )
})

test('ensureRecycleReminder: 条目数 <100 → 不注入; 清理到 99 → 停止提醒', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, '# 项目规则\n- 经验1\n- 经验2\n')
  const r = createExperienceReviewer(deps)
  const messages = msgs(1)
  r.ensureRecycleReminder({ messages })
  assert.equal(messages[0].parts.length, 1, '<100 条不应注入')
  // 清理到 99 (仍 <100 上限) → 判据不满足, 不再提醒
  files.set(PROJ_MD, Array.from({ length: 99 }, (_, i) => `- 经验${i}`).join('\n'))
  const messages2 = msgs(1)
  r.ensureRecycleReminder({ messages: messages2 })
  assert.equal(messages2[0].parts.length, 1, '压回上限以下不应再提醒')
})

test('ensureRecycleReminder: 达标即提醒, 不因条数未变而静默 (回归: 基线曾锁死)', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, Array.from({ length: 110 }, (_, i) => `- 经验${i}`).join('\n'))
  const r = createExperienceReviewer(deps)
  // 同一条数连续三轮 → 三轮都该提醒 (旧基线逻辑第二轮起 110===110 会永久静默)
  for (const round of [1, 2, 3]) {
    const m = msgs(1)
    r.ensureRecycleReminder({ messages: m })
    assert.ok(
      m[0].parts.some((p) => p.synthetic === true && p.text.includes('110')),
      `第 ${round} 轮: 110 条仍在上限之上, 必须继续提醒`
    )
  }
  // 清理到 100 (仍达标) → 继续提醒
  files.set(PROJ_MD, Array.from({ length: 100 }, (_, i) => `- 经验${i}`).join('\n'))
  const m4 = msgs(1)
  r.ensureRecycleReminder({ messages: m4 })
  assert.ok(
    m4[0].parts.some((p) => p.synthetic === true && p.text.includes('100')),
    '压到恰好 100 仍达标, 应继续提醒'
  )
  // 清理到 99 → 才停
  files.set(PROJ_MD, Array.from({ length: 99 }, (_, i) => `- 经验${i}`).join('\n'))
  const m5 = msgs(1)
  r.ensureRecycleReminder({ messages: m5 })
  assert.equal(m5[0].parts.length, 1, '压到 99 低于上限应停止提醒')
})

test('ensureRecycleReminder: 只报当前状态与目标状态, 不泄露上限/完成判据', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, Array.from({ length: 110 }, (_, i) => `- 经验${i}`).join('\n'))
  const r = createExperienceReviewer(deps)
  const m = msgs(1)
  r.ensureRecycleReminder({ messages: m })
  const injected = m[0].parts.find((p) => p.synthetic === true).text
  // 只给两样: 当前状态 + 目标状态
  assert.ok(injected.includes('经验条目已达 110 条'), '必须说明当前状态')
  assert.ok(injected.includes('目标压到 60 条以内'), '必须说明目标状态 (60% × 100)')
  // 上限是插件内部的触发线, agent 不需要知道
  assert.ok(!injected.includes('上限'), '不向 agent 暴露上限数值')
  // 不设完成判据: 没压到目标就是没完成
  assert.ok(!injected.includes('完成判据'), '不设完成判据, 未达目标就该继续压')
})

test('ensureRecycleReminder: 非最新 user 消息不注入 (一轮最多一次)', () => {
  const { deps, files } = makeDeps()
  files.set(PROJ_MD, Array.from({ length: 110 }, (_, i) => `- 经验${i}`).join('\n'))
  const r = createExperienceReviewer(deps)
  // 历史 user 消息 + 后续 assistant 消息 → 不该往历史 user 上注入
  const messages = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: '第一条' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: '回复' }] },
  ]
  r.ensureRecycleReminder({ messages })
  assert.equal(messages[0].parts.length, 1, '最新消息不是 user 时不注入')
})

test('ensureGlobalRuleSync: 全局 AGENTS.md 已有规则句 → 不重复写入', () => {
  const { deps, files, logs } = makeDeps()
  files.set(GLOBAL_MD, '# 全局规则\n- 项目 AGENTS.md 出现 `[建议全局]` 前缀的经验条目时, 当面向用户确认是否转全局: 用户否 → 删标记留项目; 用户是 → 迁全局并删原条目\n')
  const r = createExperienceReviewer(deps)
  r.ensureGlobalRuleSync({ messages: msgs(1) })
  assert.equal(files.get(GLOBAL_MD).includes('用户是 → 迁全局并删原条目'), true)
  assert.ok(!logs.some((l) => l.startsWith('GLOBAL_RULE_WRITE')), '已有规则句不应写入')
})

test('ensureGlobalRuleSync: 全局 AGENTS.md 缺少规则句 → 自动追加写入 (文件尾补换行)', () => {
  const { deps, files, logs } = makeDeps()
  files.set(GLOBAL_MD, '# 全局规则\n- 其它条目')
  const r = createExperienceReviewer(deps)
  r.ensureGlobalRuleSync({ messages: msgs(1) })
  const content = files.get(GLOBAL_MD)
  assert.ok(content.includes('用户是 → 迁全局并删原条目'), '缺规则句应自动补写')
  assert.ok(content.endsWith('\n'), '写入后应以换行结尾')
  assert.ok(logs.some((l) => l.startsWith('GLOBAL_RULE_WRITE')), '应有写入日志')
  // 再次调用 → 检测命中 → 不再重复写入
  r.ensureGlobalRuleSync({ messages: msgs(1) })
  const writeCount = logs.filter((l) => l.startsWith('GLOBAL_RULE_WRITE')).length
  assert.equal(writeCount, 1, '检测命中后不应重复写入')
})

test('ensureGlobalRuleSync: 全局 AGENTS.md 不存在 → 创建并写入', () => {
  const { deps, files } = makeDeps()
  const r = createExperienceReviewer(deps) // GLOBAL_MD 未在 files 中 → exists=false
  r.ensureGlobalRuleSync({ messages: msgs(1) })
  assert.ok(files.has(GLOBAL_MD), '缺文件应创建全局 AGENTS.md')
  assert.ok(files.get(GLOBAL_MD).includes('用户是 → 迁全局并删原条目'))
})