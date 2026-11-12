/**
 * experience-reviewer 单元测试 (v5: compact-hook 架构)
 *
 * 运行: node --test test/experience-reviewer.test.mjs (零依赖)
 * 覆盖:
 *   - parseReviewOutput / extractJsonBlock (JSON 解析与归一)
 *   - writeSimpleEntries / refreshUsageStamps (AGENTS.md 写入与时间戳刷新)
 *   - countMdEntries / dateStamp / stripEntryStamp / stampEntryLine (基础工具)
 *   - projectIdFromCwd (与 OCM 实测一致)
 *   - extractionInstructionForCompact (v5 注入 prompt 形状)
 *   - createExperienceReviewer.handleCompactionEnded (v5 主入口: 解析 + 写盘 + cursor 去重)
 *   - createExperienceReviewer.buildCompactionInjection (v5 hook 注入构造)
 *   - ensure*Reminder 4 项 (overview / suggestGlobal / recycle / globalRule)
 *   - 项目级 enabled 开关
 *   - storeComplexExperience / queryExperiences (OCM HTTP, 保留)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createExperienceReviewer,
  parseReviewOutput,
  extractJsonBlock,
  extractionInstructionForCompact,
  projectIdFromCwd,
  storeComplexExperience,
  queryExperiences,
  countMdEntries,
  dateStamp,
  stripEntryStamp,
  stampEntryLine,
  wordCount,
  bigrams,
  isNearDuplicate,
  hasUserSignal,
  looksLikeCode,
} from '../index.js'

/** 内存 fs mock: cursor / AGENTS.md 全在 Map 里, 零真实写盘 */
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

/** 收集日志 (替代真实 debugLog 写 %TEMP%) */
function makeLogCollector() {
  const lines = []
  return { lines, log: (msg) => lines.push(msg) }
}

/** 临时项目目录 (每次测试独立, 不碰真实项目) */
function makeTempDir(tag) {
  return join(
    tmpdir(),
    `exp-review-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  )
}

/** 构造 deps: fs mock + log collector + 时间注入 */
function makeDeps({ tag = 'unit', now = () => 1_700_000_000_000, content = '' } = {}) {
  const collector = makeLogCollector()
  const dir = makeTempDir(tag)
  const mem = makeMemFs()
  if (content) mem.write(join(dir, 'AGENTS.md'), content)
  return {
    collector,
    dir,
    mem,
    deps: {
      now,
      log: collector.log,
      directory: dir,
      globalAgentsPath: join(dir, 'g-AGENTS.md'),
      read: mem.read,
      write: mem.write,
      exists: mem.exists,
      mkdir: mem.mkdir,
    },
  }
}

/** 构造 session.compaction.ended 事件 payload */
function makeCompactionEndedEvent({
  id = 'evt_abc123',
  sessionID = 'ses_test',
  reason = 'auto',
  text = '',
} = {}) {
  return {
    id,
    type: 'session.compaction.ended',
    data: { sessionID, reason, text },
  }
}

// ── JSON 解析基础 ──
test('extractJsonBlock: 纯 JSON', () => {
  const r = extractJsonBlock('{"a":1}')
  assert.deepEqual(r, { a: 1 })
})

test('extractJsonBlock: 带前缀说明', () => {
  const r = extractJsonBlock('这是说明文字\n{"a":1}\n后面也有')
  assert.deepEqual(r, { a: 1 })
})

test('extractJsonBlock: ```json``` 代码块', () => {
  const r = extractJsonBlock('前面文字 ```json\n{"a":1}\n``` 后面文字')
  assert.deepEqual(r, { a: 1 })
})

test('extractJsonBlock: ``` 代码块无 json 标记', () => {
  const r = extractJsonBlock('```\n{"a":1}\n```')
  assert.deepEqual(r, { a: 1 })
})

test('extractJsonBlock: 非 JSON → null', () => {
  assert.equal(extractJsonBlock('plain text'), null)
  assert.equal(extractJsonBlock(''), null)
  assert.equal(extractJsonBlock(null), null)
})

test('extractJsonBlock: 正文含裸 ```json 字面量 → 仍解出末尾真 JSON 块', () => {
  // 复刻 2026-10-27 真机 bug: 摘要正文提到 "末尾附 ```json 块", 真 JSON 块在末尾
  const text = [
    '## Requirements',
    '- 末尾附 ` ```json ` 块（simple/usedEntries 格式）',
    '## Work State',
    '- 改动完成，测试 66 pass',
    '```json',
    '{"simple":[{"scope":"project","text":"锚点已落地","suggestGlobal":false}],"usedEntries":["e30a45f9"]}',
    '```',
  ].join('\n')
  const r = extractJsonBlock(text)
  assert.ok(r, '必须能解出 JSON')
  assert.equal(r.simple.length, 1)
  assert.equal(r.simple[0].text, '锚点已落地')
  assert.deepEqual(r.usedEntries, ['e30a45f9'])
})

test('extractJsonBlock: 首个匹配本身合法 → 结果不变 (不回归)', () => {
  // 正文没有字面量干扰时, 行为与修复前完全一致
  const text = '前面文字 ```json\n{"a":1}\n``` 后面文字'
  assert.deepEqual(extractJsonBlock(text), { a: 1 })
  // 干扰存在但首个匹配仍合法 → 仍取首个
  const both = '提到 ```json 字面量\n```json\n{"a":2}\n```\n'
  assert.deepEqual(extractJsonBlock(both), { a: 2 })
})

test('parseReviewOutput: simple/complex/usedEntries 解析 + suggestGlobal 判定', () => {
  const stdout = JSON.stringify({
    simple: [
      { scope: 'project', text: '规则一', suggestGlobal: false },
      { text: '规则二', suggestGlobal: true }, // 无 scope 但 suggestGlobal=true → 升级
      { scope: 'global', text: '规则三' },     // scope=global → 升级
      { text: '' },                              // 空 text 过滤
      { text: '   ' },                           // 全空白过滤
      'bad',                                    // 非对象过滤
    ],
    complex: [{ title: 'unused', content: 'v5 不再走 complex 路径' }],
    usedEntries: ['- [2026-10-13] 已有规则 A 前 10 字符', '短', 'x'.repeat(15)],
  })
  const out = parseReviewOutput(stdout)
  assert.equal(out.simple.length, 3)
  assert.deepEqual(out.simple[0], { scope: 'project', suggestGlobal: false, text: '规则一' })
  assert.equal(out.simple[1].suggestGlobal, true)
  assert.equal(out.simple[2].suggestGlobal, true)
  // usedEntries: 剥时间戳, 取前 10 字符, 长度 <3 过滤
  assert.equal(out.usedEntries.length, 2)
  assert.equal(out.usedEntries[0].length, 10)
  assert.equal(out.usedEntries[1], 'xxxxxxxxxx')
})

test('parseReviewOutput: 非 JSON → 全空', () => {
  const out = parseReviewOutput('not json')
  assert.deepEqual(out, { simple: [], usedEntries: [] })
})

test('parseReviewOutput: simple 缺字段 → 空 simple', () => {
  const out = parseReviewOutput('{"usedEntries":["xxxxxxxxxx"]}')
  assert.equal(out.simple.length, 0)
  assert.equal(out.usedEntries.length, 1)
})

// ── 词数口径 (v5.2) ──
test('wordCount: 汉字按字 + 英文按单词 (一个标识符算一词)', () => {
  assert.equal(wordCount(''), 0)
  assert.equal(wordCount(null), 0)
  assert.equal(wordCount('中文四个字'), 5) // 中/文/四/个/字 = 5 个汉字
  assert.equal(wordCount('四个字'), 3)
  assert.equal(wordCount('hello world'), 2)
  assert.equal(wordCount('experience-reviewer 是插件'), 4) // 标识符 1 词 + 是插件 3 汉字
  // 真实历史条目 (53 字符 / 15 词): 旧字符口径 (>50) 会丢, 词数口径放行
  assert.equal(wordCount('V2 plugin hook 名必须查 SDK Hooks interface，context7 文档不全'), 15)
})

test('wordCount: 标点与空格不计词', () => {
  assert.equal(wordCount('!!! ??? ，。'), 0)
  assert.equal(wordCount('A，B，C'), 3)
})

test('extractionInstructionForCompact: 长度用词数口径 (≤45 词 / ≤160 字符), 不再用 "≤50 字"', () => {
  const instr = extractionInstructionForCompact('测试项目', 10)
  const text = instr.content[0].text
  assert.match(text, /≤45 词/)
  assert.match(text, /汉字按字算，英文按单词算/)
  assert.match(text, /≤160 字符/)
  assert.doesNotMatch(text, /≤50 字/)
})

// ── 写入 AGENTS.md ──
test('writeSimpleEntries: 全部写项目 MD, suggestGlobal → [建议全局] 前缀, 去重', () => {
  const fixedNow = 1_700_000_000_000
  const stamp = dateStamp(fixedNow)
  const { collector, deps, mem } = makeDeps({ tag: 'write-basic', now: () => fixedNow })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: '规则 A' },
    { scope: 'project', suggestGlobal: true, text: '规则 B' },
    { scope: 'project', suggestGlobal: false, text: '规则 A' }, // 重复
  ])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, new RegExp(`^- \\[${stamp}\\] 规则 A$`, 'm'))
  assert.match(md, new RegExp(`^- \\[建议全局\\] \\[${stamp}\\] 规则 B$`, 'm'))
  assert.match(collector.lines.join('\n'), /MD_WRITE/)
})

test('writeSimpleEntries: 大小上限 (超 maxMdBytes 不写)', () => {
  const { deps, mem } = makeDeps({ tag: 'write-cap' })
  // maxMdBytes=30: 第一条 17 字节可写, 加上后第二条检查时累计超 30 → MD_FULL 拒绝
  const r = createExperienceReviewer({ ...deps, maxMdBytes: 30 })
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: '短条目 1' },
    { scope: 'project', suggestGlobal: false, text: '短条目 2 填充字符' },
  ])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, /短条目 1/)
  assert.doesNotMatch(md, /短条目 2/)
})

test('writeSimpleEntries: 超长 simple 拒绝落盘 (MD_TOO_LONG 护栏, 词数口径)', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-too-long' })
  const r = createExperienceReviewer(deps)
  // 46 个汉字 = 46 词 > 45 → 拒绝
  r.writeSimpleEntries([{ scope: 'project', suggestGlobal: false, text: '字'.repeat(46) }])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.equal(md, '')
  assert.match(collector.lines.join('\n'), /MD_TOO_LONG/)
  assert.match(collector.lines.join('\n'), /words=46 max=45/)
})

test('writeSimpleEntries: 词数口径下 45 词内放行 (含英文, 旧字符口径会误杀)', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-wordcap-ok' })
  const r = createExperienceReviewer(deps)
  // 真实历史条目: 53 字符 / 23 词 —— 旧口径 (字符<=50) 会丢, 新口径放行
  const text = 'V2 plugin hook 名必须查 SDK Hooks interface，context7 文档不全'
  r.writeSimpleEntries([{ scope: 'project', suggestGlobal: false, text }])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, /V2 plugin hook 名必须查 SDK Hooks interface/)
  assert.doesNotMatch(collector.lines.join('\n'), /MD_TOO_LONG/)
})

test('writeSimpleEntries: 无空格长串被字符硬顶拦住 (词数口径漏网场景)', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-hardcap' })
  const r = createExperienceReviewer(deps)
  // 1 个英文 token = 1 词, 词数口径放行, 但 200 字符 > 160 硬顶 → 拒绝
  r.writeSimpleEntries([{ scope: 'project', suggestGlobal: false, text: 'x'.repeat(200) }])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.equal(md, '')
  assert.match(collector.lines.join('\n'), /MD_TOO_LONG/)
  assert.match(collector.lines.join('\n'), /chars=200 maxChars=160/)
})

test('writeSimpleEntries: 空数组 → 不动文件, 写 NOOP 日志', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-empty' })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([])
  assert.equal(mem.read(join(deps.directory, 'AGENTS.md')), '')
})

test('writeSimpleEntries: 已有内容末尾无换行时, 自动补换行 (防段落粘连)', () => {
  const fixedNow = 1_700_000_000_000
  const stamp = dateStamp(fixedNow)
  const { deps, mem } = makeDeps({
    tag: 'write-sep',
    now: () => fixedNow,
    content: '- [2023-11-13] 已有规则',
  })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([{ scope: 'project', suggestGlobal: false, text: '新规则' }])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, new RegExp(`已有规则\\n- \\[${stamp}\\] 新规则`))
})

// ── 时间戳刷新 ──
test('refreshUsageStamps: 命中条目行刷新到当天日期', () => {
  const { deps, mem } = makeDeps({
    tag: 'stamp',
    now: () => Date.UTC(2026, 9, 13), // 2026-10-13
    content: '- [2026-01-01] 旧规则 A\n- [2026-01-01] 旧规则 B\n- [2026-01-01] 旧规则 C',
  })
  const r = createExperienceReviewer(deps)
  const updated = r.refreshUsageStamps(['旧规则 A', '旧规则 B'])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.equal(updated, 2)
  assert.match(md, /^- \[2026-10-13\] 旧规则 A$/m)
  assert.match(md, /^- \[2026-10-13\] 旧规则 B$/m)
  assert.match(md, /^- \[2026-01-01\] 旧规则 C$/m) // 未命中 → 原样
})

test('refreshUsageStamps: 无命中 → updated=0, 不写盘', () => {
  const { collector, deps, mem } = makeDeps({
    tag: 'stamp-noop',
    content: '- [2026-01-01] 旧规则',
  })
  const r = createExperienceReviewer(deps)
  const updated = r.refreshUsageStamps(['完全不存在'])
  assert.equal(updated, 0)
  assert.match(mem.read(join(deps.directory, 'AGENTS.md')), /2026-01-01/)
})

test('refreshUsageStamps: 超 maxMdBytes → 跳过写盘 (保 20KB 不变式)', () => {
  const filler = '- [2026-01-01] ' + 'x'.repeat(80) + '\n'
  const { deps, mem } = makeDeps({
    tag: 'stamp-cap',
    content: filler.repeat(20),
  })
  const r = createExperienceReviewer({ ...deps, maxMdBytes: 800 })
  const updated = r.refreshUsageStamps(['xxx'])
  // 写盘会爆 → 跳过, 返回 0
  assert.equal(updated, 0)
})

// ── 基础工具 ──
test('countMdEntries: 仅计 `- ` 开头的一行条目', () => {
  assert.equal(countMdEntries(''), 0)
  assert.equal(countMdEntries('- a\n- b\n- c'), 3)
  assert.equal(countMdEntries('# 标题\n段落\n- 条目\n`代码`'), 1)
  assert.equal(countMdEntries('  - 缩进不是条目'), 1) // 缩进 list 项也算 (markdown 嵌套)
})

test('countMdEntries: 排除外部注入块 (别的插件写的条目不计入)', () => {
  // 外部注入块里的 `- ` 行不是本项目自己的规范, 计进来会让回收提醒被外部内容提前触发
  const md = [
    '- [2026-10-13] 自有条目 1',
    '- [2026-10-13] 自有条目 2',
    '<!-- XXX:START (scope=project) -->',
    '- **外部经验 A** id=aaa',
    '  使用时机: xxx',
    '- **外部经验 B** id=bbb',
    '<!-- XXX:END -->',
    '- [2026-10-13] 自有条目 3',
  ].join('\n')
  assert.equal(countMdEntries(md), 3) // 只有自有 3 条, 外部 2 条不计
})

test('dateStamp: YYYY-MM-DD 本地时区', () => {
  assert.equal(dateStamp(Date.UTC(2026, 0, 5)), '2026-01-05')
  assert.equal(dateStamp(Date.UTC(2026, 9, 13)), '2026-10-13')
})

test('stripEntryStamp: 剥前缀 [建议全局] / 日期 / 横线', () => {
  assert.equal(stripEntryStamp('- [2026-10-13] 文本'), '文本')
  assert.equal(stripEntryStamp('- [建议全局] [2026-10-13] 文本'), '文本')
  assert.equal(stripEntryStamp('  - 文本  '), '文本')
  assert.equal(stripEntryStamp('- [2026-10'), '') // 截断日期: 正则吃掉整个 fragment
})

test('stampEntryLine: 替换/插入日期戳, 保留 [建议全局] 标记', () => {
  assert.equal(
    stampEntryLine('- [2026-01-01] 文本', '[2026-10-13]'),
    '- [2026-10-13] 文本'
  )
  assert.equal(
    stampEntryLine('- [建议全局] [2026-01-01] 文本', '[2026-10-13]'),
    '- [建议全局] [2026-10-13] 文本'
  )
  assert.equal(stampEntryLine('# 标题', '[2026-10-13]'), '# 标题') // 非条目行原样
})

test('projectIdFromCwd: sha256 前 16 位, 跨调用稳定', () => {
  const a1 = projectIdFromCwd('D:/foo')
  const a2 = projectIdFromCwd('D:/foo')
  assert.equal(a1, a2)
  assert.equal(a1.length, 16)
  const b = projectIdFromCwd('D:/bar')
  assert.notEqual(a1, b)
})

// ── v5 extractionInstructionForCompact ──
test('extractionInstructionForCompact: 返回 user role + 含 JSON schema 的 text content', () => {
  const msg = extractionInstructionForCompact('我的项目', 12)
  assert.equal(msg.role, 'user')
  assert.equal(msg.content.length, 1)
  const text = msg.content[0].text
  assert.match(text, /```json/)
  assert.match(text, /"simple"/)
  assert.match(text, /"usedEntries"/)
  assert.match(text, /我的项目/)
  assert.match(text, /现有自有条目数[：:]\s*12/)
  assert.equal(msg.content[0].synthetic, true)
})

test('extractionInstructionForCompact: 空 overview/entryCount → fallback 文本', () => {
  const msg = extractionInstructionForCompact('', 0)
  assert.match(msg.content[0].text, /项目概述[：:]\s*\(无\)/)
  assert.match(msg.content[0].text, /现有自有条目数[：:]\s*0/)
})

// ── v5 handleCompactionEnded ──
test('handleCompactionEnded: 解析 JSON → 写 AGENTS.md + 推进 cursor', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'ce-basic' })
  const r = createExperienceReviewer(deps)
  const text =
    '这是 compact 摘要文本。\n\n```json\n{"simple":[{"scope":"project","text":"规则 X","suggestGlobal":false}],"usedEntries":["已有条目"]}\n```'
  const evt = makeCompactionEndedEvent({ id: 'evt_1', text })
  const result = r.handleCompactionEnded({ event: evt })
  assert.equal(result.ok, true)
  assert.equal(result.simple.length, 1)
  assert.match(mem.read(join(deps.directory, 'AGENTS.md')), /规则 X/)
  const cursorPath = join(deps.directory, '.experience-reviewer', 'experience-cursor.json')
  const cursor = JSON.parse(mem.read(cursorPath))
  assert.equal(cursor.lastCompactionEventID, 'evt_1')
  assert.ok(cursor.lastCompactionAt)
  const logs = collector.lines.join('\n')
  assert.match(logs, /COMPACTION_REVIEW/)
  assert.match(logs, /COMPACTION_DONE/)
})

test('handleCompactionEnded: 缺 text → SKIP empty-text, 不动文件不写 cursor', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'ce-empty' })
  const r = createExperienceReviewer(deps)
  const result = r.handleCompactionEnded({
    event: makeCompactionEndedEvent({ text: '   ' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty-text')
  assert.match(collector.lines.join('\n'), /COMPACTION_SKIP reason=empty-text/)
  // cursor 没写
  const cursorPath = join(deps.directory, '.experience-reviewer', 'experience-cursor.json')
  assert.equal(mem.exists(cursorPath), false)
})

test('handleCompactionEnded: 同 event.id 重复处理 → SKIP duplicate, 不再写盘', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'ce-dup' })
  const r = createExperienceReviewer(deps)
  const evt = makeCompactionEndedEvent({
    id: 'evt_same',
    text: '```json\n{"simple":[{"scope":"project","text":"A","suggestGlobal":false}],"usedEntries":[]}\n```',
  })
  // 第一次: 写
  const r1 = r.handleCompactionEnded({ event: evt })
  assert.equal(r1.ok, true)
  const mdAfter1 = mem.read(join(deps.directory, 'AGENTS.md'))
  // 第二次同 id: skip
  const r2 = r.handleCompactionEnded({ event: evt })
  assert.equal(r2.ok, false)
  assert.equal(r2.reason, 'duplicate')
  assert.equal(mem.read(join(deps.directory, 'AGENTS.md')), mdAfter1)
  assert.match(collector.lines.join('\n'), /COMPACTION_SKIP reason=duplicate-event/)
})

test('handleCompactionEnded: 项目禁用 → SKIP disabled', () => {
  const { collector, deps } = makeDeps({ tag: 'ce-disabled' })
  // 先写禁用配置
  deps.write(
    join(deps.directory, '.experience-reviewer', 'config.json'),
    JSON.stringify({ enabled: false })
  )
  const r = createExperienceReviewer(deps)
  const result = r.handleCompactionEnded({
    event: makeCompactionEndedEvent({ text: '```json\n{"simple":[]}\n```' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'disabled')
  assert.match(collector.lines.join('\n'), /reason=disabled-by-config/)
})

test('handleCompactionEnded: 文本无 JSON → simple/usedEntries 空, 但仍推进 cursor', () => {
  const { deps, mem } = makeDeps({ tag: 'ce-nojson' })
  const r = createExperienceReviewer(deps)
  const result = r.handleCompactionEnded({
    event: makeCompactionEndedEvent({ id: 'evt_nj', text: '摘要, 无 JSON 块' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.simple.length, 0)
  const cursorPath = join(deps.directory, '.experience-reviewer', 'experience-cursor.json')
  const cursor = JSON.parse(mem.read(cursorPath))
  assert.equal(cursor.lastCompactionEventID, 'evt_nj')
})

test('handleCompactionEnded: 无 directory → SKIP no-directory', () => {
  const { collector } = makeDeps({ tag: 'ce-nodir' })
  const r = createExperienceReviewer({ directory: '', log: collector.log })
  const result = r.handleCompactionEnded({
    event: makeCompactionEndedEvent({ text: 'any' }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-directory')
  assert.match(collector.lines.join('\n'), /reason=no-directory/)
})

test('handleCompactionEnded: 配合 usedEntries 刷新已有条目时间戳', () => {
  const { deps, mem } = makeDeps({
    tag: 'ce-used',
    now: () => Date.UTC(2026, 9, 13),
    content: '- [2026-01-01] 已有规则 X\n- [2026-01-01] 其它规则 Y',
  })
  const r = createExperienceReviewer(deps)
  const text =
    '```json\n{"simple":[],"usedEntries":["- [2026-01-01] 已有规则 X"]}\n```'
  r.handleCompactionEnded({ event: makeCompactionEndedEvent({ id: 'evt_used', text }) })
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, /^- \[2026-10-13\] 已有规则 X$/m)
  assert.match(md, /^- \[2026-01-01\] 其它规则 Y$/m)
})

// ── v5 buildCompactionInjection ──
test('buildCompactionInjection: 返回 user role 注入消息 (含项目上下文)', () => {
  const { deps } = makeDeps({
    tag: 'ci-basic',
    content: '> **项目概述**: 我的项目\n- [2026-01-01] 旧规则 A\n- [2026-01-01] 旧规则 B',
  })
  const r = createExperienceReviewer(deps)
  const inj = r.buildCompactionInjection()
  assert.ok(inj)
  assert.equal(inj.role, 'user')
  assert.match(inj.content[0].text, /我的项目/)
  assert.match(inj.content[0].text, /现有自有条目数[：:]\s*2/)
})

test('buildCompactionInjection: 项目禁用 → null', () => {
  const { deps } = makeDeps({ tag: 'ci-disabled' })
  deps.write(
    join(deps.directory, '.experience-reviewer', 'config.json'),
    JSON.stringify({ enabled: false })
  )
  const r = createExperienceReviewer(deps)
  assert.equal(r.buildCompactionInjection(), null)
})

test('buildCompactionInjection: 无 directory → null', () => {
  const r = createExperienceReviewer({ directory: '' })
  assert.equal(r.buildCompactionInjection(), null)
})

// ── 项目级 4 项提醒 (不变) ──
test('ensureOverviewReminder: 缺概述 → 每次 user-turn 都注入', () => {
  const { deps } = makeDeps({ tag: 'ov-missing' })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureOverviewReminder({ messages: [msg] })
  assert.match(msg.content[1].text, /必须执行.*项目概述/)
})

test('ensureOverviewReminder: 有概述 → 不注入, 记 cursor.hasOverview', () => {
  const { deps, mem } = makeDeps({
    tag: 'ov-present',
    content: '> **项目概述**: 已写好',
  })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureOverviewReminder({ messages: [msg] })
  assert.equal(msg.content.length, 1)
  const cursor = JSON.parse(
    mem.read(join(deps.directory, '.experience-reviewer', 'experience-cursor.json'))
  )
  assert.equal(cursor.hasOverview, true)
})

test('ensureOverviewReminder: 最后一条非 user (工具循环) → 不注入', () => {
  const { deps } = makeDeps({ tag: 'ov-asst' })
  const r = createExperienceReviewer(deps)
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
  ]
  r.ensureOverviewReminder({ messages: msgs })
  assert.equal(msgs[0].content.length, 1)
})

test('ensureSuggestGlobalReminder: 有 2 条 [建议全局] → 注入询问 + 记 count 基线', () => {
  const { deps, mem } = makeDeps({
    tag: 'sg-prompt',
    content:
      '- [建议全局] [2026-10-13] 全局条目 1\n- [建议全局] [2026-10-13] 全局条目 2\n- [2026-10-13] 项目条目',
  })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureSuggestGlobalReminder({ messages: [msg] })
  assert.match(msg.content[1].text, /2 条/)
  const cursor = JSON.parse(
    mem.read(join(deps.directory, '.experience-reviewer', 'experience-cursor.json'))
  )
  assert.equal(cursor.suggestGlobalPromptedCount, 2)
  // 同条数再次 → 不重复注入
  const msg2 = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureSuggestGlobalReminder({ messages: [msg2] })
  assert.equal(msg2.content.length, 1)
})

test('ensureSuggestGlobalReminder: 处理回落 (count<基线) → 重置基线', () => {
  const { deps } = makeDeps({
    tag: 'sg-reset',
    content: '- [2026-10-13] 项目条目',
  })
  const r = createExperienceReviewer(deps)
  // 预置基线 3
  deps.write(
    join(deps.directory, '.experience-reviewer', 'experience-cursor.json'),
    JSON.stringify({ suggestGlobalPromptedCount: 3 })
  )
  r.ensureSuggestGlobalReminder({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  // 不注入 (count=0 < lastCount=3 → 重置基线 → 不提醒)
})

test('ensureRecycleReminder: 条目数 ≥ 100 → 注入', () => {
  const lines = []
  for (let i = 1; i <= 105; i++) lines.push(`- [2026-10-13] 规则 ${i}`)
  const { deps } = makeDeps({ tag: 'recycle', content: lines.join('\n') })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureRecycleReminder({ messages: [msg] })
  assert.match(msg.content[1].text, /已达 105 条/)
})

test('ensureRecycleReminder: 条目数 < 100 → 不注入', () => {
  const { deps } = makeDeps({ tag: 'recycle-no', content: '- [2026-10-13] 规则 1' })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureRecycleReminder({ messages: [msg] })
  assert.equal(msg.content.length, 1)
})

test('ensureRecycleReminder: 清理标准与写入侧同一把尺子 (v5.6: 只留用户侧准则, 工作内容一律删) + 保护外部注入块', () => {
  const lines = []
  for (let i = 1; i <= 105; i++) lines.push(`- [2026-10-13] 规则 ${i}`)
  const { deps } = makeDeps({ tag: 'recycle-align', content: lines.join('\n') })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureRecycleReminder({ messages: [msg] })
  const text = msg.content[1].text
  // 清理标准 = 写入侧同一把尺子 (v5.7.0: 摘要自检 + agent-vs-work)
  assert.match(text, /唯一判据\(与写入侧同一把尺子\)/)
  assert.match(text, /这条讲的是「你\(agent\)以后该怎么做」, 还是「这件事该做成什么样」/)
  assert.match(text, /前者才留, 后者一律删/)
  assert.match(text, /领域\/数据\/接口规则/)
  assert.match(text, /本次会话做过\/讨论过\/总结出来的具体内容/)
  assert.match(text, /换了说法也算/)
  assert.match(text, /换个任务就作废/)
  assert.match(text, /只有这类才留/)
  assert.match(text, /用户对你做事方式的普适约束/)
  assert.match(text, /用户对你工作习惯的长期评价/)
  assert.match(text, /跨任务重复犯且造成实际损失/)
  // 同义去重 + 外部注入块保护
  assert.match(text, /措辞不同也算同义/)
  assert.match(text, /不要动 <!-- XXX:START\/END --> 这类外部注入块/)
})

test('ensureRecycleReminder: 外部注入块的条目不计入阈值 (不会被外部内容提前触发)', () => {
  const lines = []
  for (let i = 1; i <= 95; i++) lines.push(`- [2026-10-13] 自有规则 ${i}`)
  const md = [
    ...lines,
    '<!-- XXX:START (scope=project) -->',
    ...Array.from({ length: 40 }, (_, i) => `- **外部经验 ${i}** id=x${i}`),
    '<!-- XXX:END -->',
  ].join('\n')
  const { deps } = makeDeps({ tag: 'recycle-ext', content: md })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  r.ensureRecycleReminder({ messages: [msg] })
  assert.equal(msg.content.length, 1) // 自有 95 条 < 100 → 不注入
})

// ── 回归主线锚点 (提醒后补原任务) ──
test('回归主线: 注入提醒后追加锚点, 含用户原话 + 提醒在锚点之前', () => {
  const lines = []
  for (let i = 1; i <= 105; i++) lines.push(`- [2026-10-13] 规则 ${i}`)
  const { deps } = makeDeps({ tag: 'mainline', content: lines.join('\n') })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: '帮我把这个批次的图跑一遍 upscaling' }] }
  r.ensureRecycleReminder({ messages: [msg] })
  assert.equal(msg.content.length, 3) // 原话 + 提醒 + 锚点
  assert.match(msg.content[1].text, /已达 105 条/)
  const anchor = msg.content[2]
  assert.equal(anchor.synthetic, true)
  assert.equal(anchor.mainline, true)
  assert.match(anchor.text, /【回归主线】/)
  assert.match(anchor.text, /用户原本任务：帮我把这个批次的图跑一遍 upscaling/)
  assert.match(anchor.text, /不是本轮的新任务|不要把它当成本轮的新任务/)
})

test('回归主线: 用户原话超长 → 截断 300 字并提示完整原文见上文', () => {
  const lines = []
  for (let i = 1; i <= 105; i++) lines.push(`- [2026-10-13] 规则 ${i}`)
  const { deps } = makeDeps({ tag: 'mainline-long', content: lines.join('\n') })
  const r = createExperienceReviewer(deps)
  const long = 'A'.repeat(500)
  const msg = { role: 'user', content: [{ type: 'text', text: long }] }
  r.ensureRecycleReminder({ messages: [msg] })
  const anchor = msg.content[2]
  assert.match(anchor.text, /……（完整原文见本消息上文）/)
  // 锚点里引用的原话长度 = 300 (不含前缀/后缀)
  const quoted = anchor.text.split('用户原本任务：')[1].replace('……（完整原文见本消息上文）', '')
  assert.equal(quoted.length, 300)
})

test('回归主线: 同一回合多条提醒 → 只有一个锚点且在最后', () => {
  const lines = []
  for (let i = 1; i <= 105; i++) lines.push(`- [2026-10-13] 规则 ${i}`)
  const { deps } = makeDeps({ tag: 'mainline-multi', content: lines.join('\n') })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: '原任务' }] }
  r.ensureOverviewReminder({ messages: [msg] })
  r.ensureRecycleReminder({ messages: [msg] })
  const anchors = msg.content.filter((p) => p?.mainline === true)
  assert.equal(anchors.length, 1)
  assert.equal(msg.content[msg.content.length - 1].mainline, true)
  assert.equal(msg.content.length, 4) // 原话 + 概述提醒 + 回收提醒 + 锚点
})

test('回归主线: 无用户原话 (全是 synthetic) → 不加锚点', () => {
  const lines = []
  for (let i = 1; i <= 105; i++) lines.push(`- [2026-10-13] 规则 ${i}`)
  const { deps } = makeDeps({ tag: 'mainline-noreal', content: lines.join('\n') })
  const r = createExperienceReviewer(deps)
  const msg = { role: 'user', content: [{ type: 'text', text: 'x', synthetic: true }] }
  r.ensureRecycleReminder({ messages: [msg] })
  assert.equal(msg.content.filter((p) => p?.mainline === true).length, 0)
})

test('ensureGlobalRuleSync: 全局缺规则句 → 自动补写', () => {
  const { deps, mem } = makeDeps({ tag: 'gr-write' })
  const r = createExperienceReviewer(deps)
  r.ensureGlobalRuleSync({ messages: [] })
  const global = mem.read(deps.globalAgentsPath)
  assert.match(global, /出现 `\[建议全局\]` 前缀的经验条目时/)
})

test('ensureGlobalRuleSync: 全局已有规则句 → 不重复写', () => {
  const { deps, mem } = makeDeps({
    tag: 'gr-skip',
  })
  // 预置: globalAgentsPath 已有规则句
  mem.write(deps.globalAgentsPath, '用户配置\n- 项目 AGENTS.md 出现 `[建议全局]` 前缀的经验条目时, ...\n')
  const before = mem.read(deps.globalAgentsPath)
  const r = createExperienceReviewer(deps)
  r.ensureGlobalRuleSync({ messages: [] })
  assert.equal(mem.read(deps.globalAgentsPath), before)
})

// ── 项目级 enabled 开关 ──
test('项目开关: 无 config → 默认开启 (不误伤)', () => {
  const { deps } = makeDeps({ tag: 'cfg-default' })
  const r = createExperienceReviewer(deps)
  assert.equal(r.isDisabled(), false)
})

test('项目开关: enabled=false → isDisabled true', () => {
  const { deps } = makeDeps({ tag: 'cfg-off' })
  deps.write(
    join(deps.directory, '.experience-reviewer', 'config.json'),
    JSON.stringify({ enabled: false })
  )
  const r = createExperienceReviewer(deps)
  assert.equal(r.isDisabled(), true)
})

test('项目开关: 损坏 JSON → 不误伤 (视为开启)', () => {
  const { deps } = makeDeps({ tag: 'cfg-bad' })
  deps.write(
    join(deps.directory, '.experience-reviewer', 'config.json'),
    '{ this is not json'
  )
  const r = createExperienceReviewer(deps)
  assert.equal(r.isDisabled(), false)
})

// ── OCM HTTP (保留, v5 不调用但代码/接口稳定) ──
test('storeComplexExperience: POST /experiences 字段映射 (project+projectHash)', async () => {
  let captured = null
  const fakeFetch = async (url, init) => {
    captured = { url, init }
    return new Response(
      JSON.stringify({ success: true, id: 'ocm-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }
  const ok = await storeComplexExperience(
    {
      title: 'T',
      description: 'D',
      content: 'C',
      scope: 'project',
      type: 'dev',
      triggers: '["a","b"]',
    },
    { projectId: 'abc123', fetchImpl: fakeFetch }
  )
  assert.equal(ok.success, true)
  assert.equal(ok.id, 'ocm-1')
  assert.match(captured.url, /\/experiences$/)
  const body = JSON.parse(captured.init.body)
  assert.equal(body.projectHash, 'abc123')
  assert.equal(body.scope, 'project')
  assert.equal(body.triggers, '["a","b"]')
})

test('storeComplexExperience: scope=global 不带 projectHash', async () => {
  let captured = null
  const fakeFetch = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({ success: true, id: 'g-1' }), { status: 200 })
  }
  await storeComplexExperience(
    { title: 'T', description: 'D', content: 'C', scope: 'global', type: 'dev' },
    { projectId: 'abc123', fetchImpl: fakeFetch }
  )
  const body = JSON.parse(captured.init.body)
  assert.equal(body.scope, 'global')
  assert.equal(body.projectHash, undefined)
})

test('storeComplexExperience: 网络失败 → success=false + reason', async () => {
  const fakeFetch = async () => {
    throw new Error('ECONNREFUSED')
  }
  const ok = await storeComplexExperience(
    { title: 'T', description: 'D', content: 'C', scope: 'project', type: 'dev' },
    { projectId: 'p', fetchImpl: fakeFetch }
  )
  assert.equal(ok.success, false)
  assert.match(ok.reason, /ECONNREFUSED/)
})

test('storeComplexExperience: 用户态失败 (data.message) 透传', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ success: false, message: 'duplicate-title' }), { status: 200 })
  const ok = await storeComplexExperience(
    { title: 'T', description: 'D', content: 'C', scope: 'project', type: 'dev' },
    { projectId: 'p', fetchImpl: fakeFetch }
  )
  assert.equal(ok.success, false)
  assert.equal(ok.reason, 'duplicate-title')
})

test('queryExperiences: GET /experiences 传 scope/type/topK/projectHash', async () => {
  let captured = null
  const fakeFetch = async (url) => {
    captured = url
    return new Response(
      JSON.stringify({ success: true, experiences: [{ title: 'X' }] }),
      { status: 200 }
    )
  }
  const out = await queryExperiences({
    scope: 'project',
    type: 'dev',
    topK: 50,
    projectId: 'p1',
    fetchImpl: fakeFetch,
  })
  assert.equal(out.success, true)
  assert.equal(out.experiences.length, 1)
  assert.match(captured, /scope=project/)
  assert.match(captured, /type=dev/)
  assert.match(captured, /topK=50/)
  assert.match(captured, /projectHash=p1/)
})

test('queryExperiences: 失败 → success=false + 空数组', async () => {
  const fakeFetch = async () => {
    throw new Error('boom')
  }
  const out = await queryExperiences({ fetchImpl: fakeFetch })
  assert.equal(out.success, false)
  assert.deepEqual(out.experiences, [])
})

// ── 准入门槛 (v5.3 admission-gate) ─────────────────────────────────────────
// 背景: 历史上 135 个压缩批次产出 676 条, 平均每批 5 条 → AGENTS.md 膨胀主因。
// 门槛 = 长度护栏 → 纯代码兜底 → 近重复 → 用户信号优先排序 → 每批条数上限。

test('bigrams: 去空格与中英文标点, 只留实词 2-gram', () => {
  assert.deepEqual([...bigrams('规则 A')], ['规则', '则A'])
  assert.deepEqual([...bigrams('a')], ['a'])
  assert.equal(bigrams('').size, 0)
})

test('isNearDuplicate: 同义改写判为近重复, 无关条目不判', () => {
  // 真实存量里的一对 (Jaccard=0.67): 字面不同但说的是同一件事
  const a = 'lazy import 的 `_impl_path` 必须调用 `.resolve()` 转绝对路径，cwd 变化时解析出错'
  const b = 'lazy import 的 `_impl_path` 必须 `.resolve()` 转绝对路径，否则 cwd 变化时解析出错'
  assert.equal(isNearDuplicate(b, [bigrams(a)]), true)
  assert.equal(isNearDuplicate('完全不相干的一条规则：发布单与 CSV 要整体重写', [bigrams(a)]), false)
})

test('hasUserSignal: 识别用户明确表达, 普通事实句不算', () => {
  assert.equal(hasUserSignal('用户明确要求改代码前先报备拍板'), true)
  assert.equal(hasUserSignal('必须先备份再改 AGENTS.md'), true)
  assert.equal(hasUserSignal('状态栏上下文口径按单次请求实测计算'), false)
})

test('looksLikeCode: 只判"整条就是代码", 含文档路径的普通句子不算', () => {
  assert.equal(looksLikeCode('def process_batch(items):\n    return [x for x in items]'), true)
  assert.equal(looksLikeCode('const a = 1'), true)
  // 关键回归: 早期用路径/标识符启发式会误杀这一类 (含 AGENTS.md 但其实是用户偏好)
  assert.equal(looksLikeCode('AGENTS.md 出现 [建议全局] 前缀时, 当面向用户确认是否转全局'), false)
  assert.equal(looksLikeCode('改提示词要极简, 一句能说清绝不用一篇'), false)
})

test('writeSimpleEntries: 每批上限 2 条 → 第 3 条起被拒 (MD_BATCH_CAP)', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-batch-cap' })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: '条目甲' },
    { scope: 'project', suggestGlobal: false, text: '条目乙' },
    { scope: 'project', suggestGlobal: false, text: '条目丙' },
    { scope: 'project', suggestGlobal: false, text: '条目丁' },
  ])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, /条目甲/)
  assert.match(md, /条目乙/)
  assert.doesNotMatch(md, /条目丙/)
  assert.doesNotMatch(md, /条目丁/)
  assert.match(collector.lines.join('\n'), /MD_BATCH_CAP cap=2/)
})

test('writeSimpleEntries: 近重复拦截同义改写 (字面去重拦不住的那种)', () => {
  const { collector, deps, mem } = makeDeps({
    tag: 'write-near-dup',
    content: '- [2026-01-01] lazy import 的 `_impl_path` 必须调用 `.resolve()` 转绝对路径，cwd 变化时解析出错',
  })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: 'lazy import 的 `_impl_path` 必须 `.resolve()` 转绝对路径，否则 cwd 变化时解析出错' },
  ])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.doesNotMatch(md, /否则 cwd 变化时解析出错/)
  assert.match(collector.lines.join('\n'), /MD_NEAR_DUP/)
})

test('writeSimpleEntries: 纯代码条目被拒 (MD_CODE_SKIP)', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-code-skip' })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: 'def process_batch(items):\n    return [x for x in items]' },
  ])
  assert.equal(mem.read(join(deps.directory, 'AGENTS.md')), '')
  assert.match(collector.lines.join('\n'), /MD_CODE_SKIP/)
})

test('writeSimpleEntries: 用户信号优先 → 同额度下留有用户明确表达的条目', () => {
  const { deps, mem } = makeDeps({ tag: 'write-user-priority' })
  const r = createExperienceReviewer(deps)
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: '状态栏上下文口径按单次请求实测计算' },
    { scope: 'project', suggestGlobal: false, text: '缓存命中率从 usage.tokens.cache.read 取' },
    { scope: 'project', suggestGlobal: false, text: '用户明确要求改代码前先报备拍板' },
    { scope: 'project', suggestGlobal: false, text: '日志按天切分存放便于排查' },
  ])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, /用户明确要求改代码前先报备拍板/) // 有用户信号 → 必留
  assert.match(md, /状态栏上下文口径按单次请求实测计算/) // 无信号但排第 2 → 也留
  assert.doesNotMatch(md, /缓存命中率从 usage.tokens.cache.read 取/)
  assert.doesNotMatch(md, /日志按天切分存放便于排查/)
})

test('writeSimpleEntries: MD_FULL 拒绝的条目不占每批额度 (额度留给能写的)', () => {
  const { collector, deps, mem } = makeDeps({ tag: 'write-cap-nocount' })
  // maxMdBytes=45: 第 1 条写入后占 22 字节; 第 2 条过长 (29+22>45) 被 MD_FULL 拒;
  // 第 3 条 (21+22=43<=45) 仍能写 → 证明被拒的条目没有吃掉每批额度
  const r = createExperienceReviewer({ ...deps, maxMdBytes: 45 })
  r.writeSimpleEntries([
    { scope: 'project', suggestGlobal: false, text: '短条目 1' },
    { scope: 'project', suggestGlobal: false, text: '短条目 2 填充字符超出上限' },
    { scope: 'project', suggestGlobal: false, text: '末尾条目 3' },
  ])
  const md = mem.read(join(deps.directory, 'AGENTS.md'))
  assert.match(md, /短条目 1/)
  assert.match(md, /末尾条目 3/) // 第 2 条被 MD_FULL 拒, 不吃掉额度
  assert.doesNotMatch(md, /短条目 2/)
  assert.match(collector.lines.join('\n'), /MD_FULL/)
})

test('extractionInstructionForCompact: 含 T0/T1/T2 分级 + 工作内容禁项 + 每批上限', () => {
  const { text } = extractionInstructionForCompact('我的项目', 3).content[0]
  // 分级 (级别从高到低)
  assert.match(text, /要什么（最多 2 条，级别从高到低）/)
  assert.match(text, /T0 用户对你做事方式的普适约束/)
  assert.match(text, /T1 用户对你「工作习惯」的长期评价/)
  assert.match(text, /T2 你自己跨任务重复犯且造成实际损失/)
  assert.match(text, /不是同一处改两遍/)
  // v5.7.0: 判据 = 对照自己刚写的摘要 (客观参照物; 不问模型"以后还用得上吗" —— 它一律答"会")
  assert.match(text, /先自检：你刚写的摘要 = 本次任务的内容/)
  assert.match(text, /跟摘要里已经写过的内容说的是同一件事/)
  assert.match(text, /换了说法也算/)
  assert.match(text, /心跳改成 60 秒/)
  assert.match(text, /工作内容，丢弃，不许写成经验/)
  // v5.6.4: 主体判据仍在 (挡领域规则: "不能有游离的边")
  assert.match(text, /唯一判据：这条讲的是「你（agent）以后该怎么做」，还是「这件事该做成什么样」/)
  assert.match(text, /前者才是经验/)
  assert.match(text, /领域\/数据\/接口规则/)
  assert.match(text, /都是工作内容，一个字都不存/)
  // 主观的"以后还会用吗"问法不许复活
  assert.doesNotMatch(text, /凡是换个任务就作废的/)
  assert.doesNotMatch(text, /不管它披着任务、纠正、表扬、批评还是技术结论的皮/)
  assert.match(text, /拿不准 → 不存/)
  assert.match(text, /AGENTS\.md 里已有的（措辞不同也算）也不存/)
  // 长度口径
  assert.match(text, /≤45 词/)
  assert.match(text, /≤160 字符/)
  assert.doesNotMatch(text, /≤50 字/)
  // 旧口径不许复活
  assert.doesNotMatch(text, /0~2 条皆可/)
  assert.doesNotMatch(text, /宁缺毋滥/)
  assert.doesNotMatch(text, /四类口径/)
})
