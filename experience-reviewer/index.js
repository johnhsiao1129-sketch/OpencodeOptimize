/**
 * experience-reviewer — OpenCode 经验回顾插件 (v5: compact-hook)
 *
 * v5 架构 (2026-10):
 *   v3 独立 subagent 会话 (--title EXP_EXTRACTOR) → 读 opencode.db 未总结消息 → 提取
 *     ✗ cmd 8191 命令行硬上限 (生产 43 次失败)
 *   v4 改用 ctx.generate.text (官方进程内 API), 仍独立调用
 *     ✗ OpenCode's free tier can only be used from within OpenCode (被拦截)
 *   v5 完全不调子进程: 借 compact 的模型调用顺便做经验提取
 *     1. ctx.session.hook('compaction', cb) 在 opencode 调 compact 摘要模型前注入提取指令
 *     2. opencode 在我们的追加之后, 再 append 自己的 summary prompt
 *     3. 模型一次性输出 summary + JSON 经验条目 (同一段文本)
 *     4. ctx.event.subscribe() 监听 session.compaction.ended, 拿 data.text → 解析 JSON
 *     5. plugin 自己 parseReviewOutput → writeSimpleEntries → AGENTS.md
 *     ✓ 零额外模型调用 (搭 compact 便车) / 不受 free tier 拦截 / 几百 K 也能跑
 *     ⚠️ 节奏由 compact 决定 (token 阈值触发, 实测约 140k; 短会话永不提取)
 *
 * 保留项目级 4 项提醒 (与提取流程正交):
 *   ctx.session.hook('context', cb) → ensureOverviewReminder / ensureSuggestGlobalReminder
 *   / ensureRecycleReminder / ensureGlobalRuleSync (向主 agent 注入合成 part, 不动主流程)
 *
 * 配置 (环境变量, 全可选):
 *   EXP_REVIEW_MAX_MD_BYTES     AGENTS.md 上限 (默认 20KB)
 *   EXP_SIMPLE_MAX_CHARS        simple 单条上限 (默认 50, 兜底防 LLM 百字长句冒充)
 *   EXP_REVIEW_ENABLED          关闭插件 (默认 true)
 *   EXP_OPENCODE_DB_PATH        opencode.db 路径 (默认 ~/.local/share/opencode/opencode.db)
 *
 * 验证 (重启 opencode 后):
 *   单元: node --test test/ (零依赖)
 *   真实: 等 compact 触发 → %TEMP%\experience-reviewer.log
 *         出现 COMPACTION_INJECT → COMPACTION_REVIEW → MD_WRITE 链路
 *
 * 兜底: 项目级禁用开关 = <项目根>/.experience-reviewer/config.json 里 {"enabled": false}
 *
 * 历史遗留 (保留 exports, v5 不再调用, 但 OCM 复杂经验路径测试与代码原样保留):
 *   storeComplexExperience, queryExperiences → OCM HTTP API (complex → DB)
 *   v5 只处理 simple (≤50 字单句, 写 AGENTS.md)
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

// ── SQLite 双运行时适配 (OCM db.js 已验证模式) ──────────────────────────────
// opencode 插件宿主是 bun: bun (Windows) 无 node:sqlite 内置模块, import 即抛错,
// 导致 opencode 静默跳过整个插件 (零日志/零加载)。按 OCM plugin-v2/src/memory/db.js
// 同款: IS_BUN 检测 → createRequire 按运行时选 bun:sqlite / node:sqlite。
// 两 API 兼容: prepare().all/get/run, exec(), close(); 仅模块名/构造选项拼写不同。
const IS_BUN = typeof process.versions !== 'undefined' && !!process.versions.bun
const require = createRequire(import.meta.url)
const DatabaseSync = IS_BUN
  ? require('bun:sqlite').Database
  : require('node:sqlite').DatabaseSync

/** 打开 SQLite db: 吸收 bun/node 构造选项差异。bun quirk: 显式传 readonly:true 没问题, false 不传 */
function openSqlite(path, { readOnly } = {}) {
  if (IS_BUN) {
    return readOnly ? new DatabaseSync(path, { readonly: true }) : new DatabaseSync(path)
  }
  return new DatabaseSync(path, { readOnly: !!readOnly })
}

const ENABLED =
  String(process.env.EXP_REVIEW_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
const MARKER = '[experience-reviewer]'
const DEBUG_LOG = join(homedir(), 'AppData', 'Local', 'Temp', 'experience-reviewer.log')

const DEFAULT_MAX_MD_BYTES = 20 * 1024 // AGENTS.md 上限 (≈400-600 条一句话规则)
const envMax = Number(process.env.EXP_REVIEW_MAX_MD_BYTES)
const MAX_MD_BYTES = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_MD_BYTES
const envSimpleMax = Number(process.env.EXP_SIMPLE_MAX_CHARS)
const SIMPLE_MAX_CHARS =
  Number.isFinite(envSimpleMax) && envSimpleMax > 0 ? envSimpleMax : 50
/** cursor 文件: 每项目 .experience-reviewer/experience-cursor.json */
const CURSOR_FILE = join('.experience-reviewer', 'experience-cursor.json')

const OVERVIEW_MARKER = '> **项目概述**: '
const OVERVIEW_REMINDER =
  '【必须执行】本项目 AGENTS.md 缺少项目概述, 这是必须完成的事项。立即将一句话概述写入 AGENTS.md 顶部首行, 格式 `> **项目概述**: <一句话>`; 不得跳过、不得推迟、不得找理由忽略, 完成补写后才算满足要求。'
const SUGGEST_GLOBAL_MARKER = '[建议全局] '
const SUGGEST_GLOBAL_RULE =
  '- 项目 AGENTS.md 出现 `[建议全局]` 前缀的经验条目时, 当面向用户确认是否转全局: 用户否 → 删标记留项目; 用户是 → 迁全局并删原条目'
const SUGGEST_GLOBAL_RULE_KEY = '出现 `[建议全局]` 前缀的经验条目时'
const RECYCLE_THRESHOLD = 100
const RECYCLE_TARGET_RATIO = 0.6

/** opencode.db 路径 (项目级 sessionID → directory 反查) */
function openCodeDbPath() {
  const env = (process.env.EXP_OPENCODE_DB_PATH || '').trim()
  return env || join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

/** OCM 项目标识: sha256(项目根路径)[:16] */
function projectIdFromCwd(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* debug 日志失败不阻塞插件 */
  }
}

/** 项目根路径归一化 */
function normalizeProjectDir(directory) {
  return String(directory || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

// ── 消息形状自适应: V1 = {info:{role}, parts:[...]} / V2 = {role, content:[...]} ──
function messageRoleOf(message) {
  return message?.info?.role ?? message?.role
}

function messagePartsOf(message) {
  if (Array.isArray(message?.parts)) return message.parts
  if (Array.isArray(message?.content)) return message.content
  return null
}

function appendSyntheticText(message, text) {
  const parts = messagePartsOf(message)
  if (!parts) return false
  parts.push({ type: 'text', text, synthetic: true })
  return true
}

/** opencode.db 代际探测 */
function detectDbSchema(db) {
  try {
    const names = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() ?? []).map(
        (r) => r?.name
      )
    )
    return {
      v2: names.has('session_v2') && names.has('session_message'),
      v1: names.has('session') && names.has('message') && names.has('part'),
    }
  } catch {
    return { v2: false, v1: true }
  }
}

/** 本地时区日期戳 YYYY-MM-DD */
function dateStamp(ms = Date.now()) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 剥掉条目行上的 [建议全局] 标记与 [YYYY-MM-DD] 时间戳, 还原 subagent 所见原文 */
function stripEntryStamp(s) {
  if (typeof s !== 'string') return ''
  let t = s.trim()
  t = t.replace(/^-\s*/, '')
  t = t.replace(/^\[建议全局\]\s*/, '')
  // 一次剥掉完整 [YYYY-MM-DD] 或截断 [YYYY-MM (后者无 ']')
  t = t.replace(/^\[[\d-]+\]\s*|\[[\d-]+\s*$/, '')
  return t.trim()
}

/** 给条目行盖/刷新时间戳: 有旧日期替换, 无日期在标记后插入; 非条目行原样返回 */
function stampEntryLine(line, stamp) {
  if (!line.trim().startsWith('- ')) return line
  const body = stripEntryStamp(line)
  if (!body) return line
  const wasSuggest = /^\[建议全局\]\s*/.test(line.trim().slice(2))
  return wasSuggest
    ? `- ${SUGGEST_GLOBAL_MARKER}${stamp} ${body}`
    : `- ${stamp} ${body}`
}

/** 统计 AGENTS.md 中 `- ` 开头的一行经验条目数 */
function countMdEntries(content) {
  return content.split('\n').filter((line) => line.trim().startsWith('- ')).length
}

function recycleTargetCount() {
  return Math.max(1, Math.floor(RECYCLE_THRESHOLD * RECYCLE_TARGET_RATIO))
}

/** 从 subagent / compact stdout 提取 JSON 块 (容错: 可能带前后缀/代码块) */
function extractJsonBlock(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = codeBlock ? codeBlock[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

/** v5 解析: compact 文本里抽 simple + usedEntries (complex v5 不产出) */
function parseReviewOutput(stdout) {
  const json = extractJsonBlock(stdout)
  if (!json) return { simple: [], usedEntries: [] }
  const simple = Array.isArray(json.simple)
    ? json.simple
        .filter((e) => e && typeof e.text === 'string' && e.text.trim())
        .map((e) => ({
          scope: 'project',
          suggestGlobal: e.suggestGlobal === true || e.scope === 'global',
          text: e.text.trim(),
        }))
    : []
  const usedEntries = Array.isArray(json.usedEntries)
    ? json.usedEntries
        .filter((e) => typeof e === 'string' && e.trim())
        .map((e) => stripEntryStamp(e).slice(0, 10))
        .filter((e) => e.length >= 3)
    : []
  return { simple, usedEntries }
}

/**
 * v5 compact 提取指令 (追加到 opencode 给 compact 模型看的 messages 末尾)。
 * opencode 之后会再追加 summary prompt, 模型一次性输出 summary + JSON 块。
 *
 * 设计要点:
 *   - 不要求 read 工具 (compact 进程内调用, 没工具; 改由 plugin 端
 *     `writeSimpleEntries` 的 `existing.includes(text)` 兜底去重)
 *   - KV cache: 指令固定文本在前缀外追加, 不破坏 transcript 的 KV cache 复用
 *     (compact 的 transcript 来自项目主会话, 与插件无关; 我们追加的是固定段)
 */
function extractionInstructionForCompact(projectOverview = '', entryCount = 0) {
  const text =
    '【附加任务 · 必须完成 · 不可省略】在你即将给出的对话摘要之后，必须额外输出一段 fenced ```json 代码块，列出本对话中**值得沉淀为简单经验**的条目。\n' +
    '\n' +
    '⚠️ 严禁：\n' +
    '· 省略 JSON 块 / 用 "无内容" 一句带过 / 把 JSON 塞进摘要正文段落里\n' +
    '· 只输出 ```json``` 空骨架（必须填入完整 JSON 对象，空也要写 {"simple":[],"usedEntries":[]}）\n' +
    '· 输出 markdown 解释文字或额外标题，只允许一段纯 ```json``` 块\n' +
    '\n' +
    '格式（外层 ```json 包裹，不要 markdown 多余文本）：\n' +
    '{"simple":[{"scope":"project","text":"...","suggestGlobal":false}],"usedEntries":["..."]}\n' +
    '\n' +
    '规则：\n' +
    '1. simple: 单条 ≤50 字单句；scope 一律 project；只能沉淀「未来还会被反复应用的规则/偏好/教训」\n' +
    '2. suggestGlobal=true: 仅当「跨项目通用偏好」或「工具链通用坑」\n' +
    '3. 排除（绝不输出）：可从代码/文档推导、一次性任务安排、特定 skill 专属规则、已存过/高度相似、已交付产物的写法/格式、行业公开知识\n' +
    '4. usedEntries: 本对话明显应用过的已有项目经验条目的前 10 字符（插件侧按项目 AGENTS.md 去重时使用）\n' +
    '5. 无内容 → 必须输出 {"simple":[],"usedEntries":[]}，不是省略，不是空骨架\n' +
    '6. 当前项目概述：' + (projectOverview || '(无)') + '\n' +
    '7. 项目 AGENTS.md 现有条目数：' + entryCount + '（仅供参考，不限制提取）\n' +
    '\n' +
    '输出顺序：先写摘要正文 → 摘要末尾追加独立的 ```json``` 块。JSON 块必须存在、必须填满。'
  return {
    role: 'user',
    content: [{ type: 'text', text, synthetic: true }],
  }
}

// ── OCM HTTP (复杂经验, v5 不调用, 保留 exports 给将来/测试用) ───────────────
const OCM_API_BASE = (process.env.EXP_OCM_API_BASE || 'http://127.0.0.1:7333').replace(/\/+$/, '')
const OCM_TIMEOUT_MS = 8000

async function ocmFetch(path, { method = 'GET', body, fetchImpl } = {}) {
  const f = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!f) return { ok: false, status: 0, error: 'no-fetch', data: null }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), OCM_TIMEOUT_MS)
  try {
    const res = await f(`${OCM_API_BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return { ok: res.ok, status: res.status, data, error: null }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error), data: null }
  } finally {
    clearTimeout(timer)
  }
}

async function storeComplexExperience(entry, { projectId, fetchImpl } = {}) {
  const scope = entry.scope === 'global' ? 'global' : 'project'
  const body = {
    title: String(entry.title || ''),
    description: String(entry.description || ''),
    content: String(entry.content || ''),
    scope,
    type: entry.type || 'dev',
    ...(scope !== 'global' && projectId ? { projectHash: projectId } : {}),
  }
  if (entry.triggers !== undefined) {
    body.triggers = typeof entry.triggers === 'string' ? entry.triggers : JSON.stringify(entry.triggers)
  }
  const res = await ocmFetch('/experiences', { method: 'POST', body, fetchImpl })
  if (res.ok && res.data?.success) {
    debugLog(`EXP_COMPLEX_STORED id=${res.data.id} title="${body.title}" scope=${scope}`)
    return { success: true, id: res.data.id }
  }
  const reason = res.data?.error || res.data?.message || res.error || `http-${res.status}`
  debugLog(`EXP_COMPLEX_FAIL title="${body.title}" status=${res.status} reason=${reason}`)
  return { success: false, reason }
}

async function queryExperiences({ scope = 'all', type = 'all', topK = 100, projectId, fetchImpl } = {}) {
  const params = new URLSearchParams({ scope: String(scope), type: String(type), topK: String(topK) })
  if (projectId) params.set('projectHash', projectId)
  const res = await ocmFetch(`/experiences?${params.toString()}`, { fetchImpl })
  if (res.ok && res.data?.success) {
    return { success: true, experiences: Array.isArray(res.data.experiences) ? res.data.experiences : [] }
  }
  const reason = res.data?.error || res.data?.message || res.error || `http-${res.status}`
  return { success: false, experiences: [], reason }
}

/**
 * 经验回顾器实例: 每项目一个, 同项目多会话共享。
 * v5: 不再触发 / 不再 spawn, 只在 compact.ended 时被动处理。
 */
function createExperienceReviewer(deps) {
  const {
    maxMdBytes = MAX_MD_BYTES,
    now = Date.now,
    log = debugLog,
    directory = '',
    globalAgentsPath = join(homedir(), '.config', 'opencode', 'AGENTS.md'),
    read = readFileSync,
    write = writeFileSync,
    exists = existsSync,
    mkdir = mkdirSync,
  } = deps ?? {}

  function isDisabled() {
    try {
      const configFile = join(directory, '.experience-reviewer', 'config.json')
      if (!exists(configFile)) return false
      const cfg = JSON.parse(read(configFile, 'utf8'))
      return cfg && typeof cfg === 'object' && cfg.enabled === false
    } catch {
      return false // 配置损坏 → 视为开启 (不误伤)
    }
  }

  function cursorPath() {
    return join(directory, CURSOR_FILE)
  }

  function readCursorLocal(cursorPathArg = cursorPath()) {
    try {
      if (!exists(cursorPathArg)) return null
      const parsed = JSON.parse(read(cursorPathArg, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
      return null
    } catch {
      return null
    }
  }

  function writeCursorLocal(cursorPathArg, cursor) {
    try {
      mkdir(join(cursorPathArg, '..'), { recursive: true })
      write(cursorPathArg, JSON.stringify(cursor, null, 2) + '\n', 'utf8')
    } catch (error) {
      log(`CURSOR_WRITE_FAIL path=${cursorPathArg} error=${String(error)}`)
    }
  }

  function readProjectOverview() {
    const mdPath = join(directory, 'AGENTS.md')
    try {
      if (!exists(mdPath)) return ''
      const line = read(mdPath, 'utf8')
        .split('\n')
        .slice(0, 50)
        .find((l) => l.includes(OVERVIEW_MARKER))
      if (!line) return ''
      return line.slice(OVERVIEW_MARKER.length).trim()
    } catch {
      return ''
    }
  }

  function countMdEntriesSafe() {
    try {
      const mdPath = join(directory, 'AGENTS.md')
      return exists(mdPath) ? countMdEntries(read(mdPath, 'utf8')) : 0
    } catch {
      return 0
    }
  }

  function readMdSafe() {
    try {
      const p = join(directory, 'AGENTS.md')
      return exists(p) ? read(p, 'utf8') : ''
    } catch {
      return ''
    }
  }

  /**
   * v5 主入口: 处理一次 session.compaction.ended 事件。
   * 解析 event.data.text → writeSimpleEntries → refreshUsageStamps → cursor 推进。
   * @returns {{ok:boolean, reason?:string, simple?:Array, usedEntries?:Array}}
   */
  function handleCompactionEnded({ event } = {}) {
    if (!directory) {
      log(`COMPACTION_SKIP reason=no-directory`)
      return { ok: false, reason: 'no-directory' }
    }
    if (isDisabled()) {
      log(`COMPACTION_SKIP reason=disabled-by-config`)
      return { ok: false, reason: 'disabled' }
    }
    const sessionID = event?.data?.sessionID
    const text = typeof event?.data?.text === 'string' ? event.data.text : ''
    if (!text.trim()) {
      log(`COMPACTION_SKIP reason=empty-text sid=${sessionID ?? '-'}`)
      return { ok: false, reason: 'empty-text' }
    }

    // cursor 去重: 同 event.id 不重复处理 (auto + manual compact 都走同一路径)
    const cur = readCursorLocal(cursorPath()) ?? {}
    const eventID = typeof event?.id === 'string' ? event.id : null
    if (eventID && cur.lastCompactionEventID === eventID) {
      log(`COMPACTION_SKIP reason=duplicate-event sid=${sessionID ?? '-'} event=${eventID}`)
      return { ok: false, reason: 'duplicate' }
    }

    const { simple, usedEntries } = parseReviewOutput(text)
    log(
      `COMPACTION_REVIEW sid=${sessionID ?? '-'} textLen=${text.length} ` +
        `simple=${simple.length} used=${usedEntries.length} reason=${event?.data?.reason ?? '-'}`
    )

    const before = readMdSafe()
    if (simple.length) writeSimpleEntries(simple)
    if (usedEntries.length) refreshUsageStamps(usedEntries)
    const after = readMdSafe()
    const wrote = before !== after

    writeCursorLocal(cursorPath(), {
      ...cur,
      lastCompactionEventID: eventID,
      lastCompactionAt: new Date(now()).toISOString(),
      ...(wrote ? { lastWriteAt: new Date(now()).toISOString() } : {}),
    })

    log(
      `COMPACTION_DONE sid=${sessionID ?? '-'} event=${eventID ?? '-'} ` +
        `simpleWrote=${simple.length} usedWrote=${usedEntries.length} wroteFile=${wrote}`
    )
    return { ok: true, simple, usedEntries }
  }

  /**
   * v5 hook 注入构造: opencode 在 compact 调模型前触发 session.compaction hook,
   * 我们返回把 extraction 指令追加到末尾的新 messages 数组。
   * 返回 null / undefined = opencode 用原 messages 继续 (无副作用)。
   */
  function buildCompactionInjection() {
    if (!directory) return null
    if (isDisabled()) return null
    const overview = readProjectOverview()
    const entryCount = countMdEntriesSafe()
    return extractionInstructionForCompact(overview, entryCount)
  }

  // ── AGENTS.md 写入 (v5 主落点) ──
  function writeSimpleEntries(entries) {
    if (!entries.length) return
    const path = join(directory, 'AGENTS.md')
    let existing = ''
    try {
      existing = exists(path) ? read(path, 'utf8') : ''
    } catch (error) {
      log(`MD_READ_FAIL path=${path} error=${String(error)}`)
      return
    }
    let added = ''
    for (const e of entries) {
      const text = e?.text
      if (!text) continue
      if (text.length > SIMPLE_MAX_CHARS) {
        log(`MD_TOO_LONG chars=${text.length} max=${SIMPLE_MAX_CHARS} skipped="${text.slice(0, 30)}…"`)
        continue
      }
      if (existing.includes(text) || added.includes(text)) continue // 去重 (原文)
      const stamp = `[${dateStamp(now())}] `
      const line = `- ${e.suggestGlobal ? `${SUGGEST_GLOBAL_MARKER}${stamp}${text}` : `${stamp}${text}`}`
      if ((existing + added + line).length > maxMdBytes) {
        log(`MD_FULL maxBytes=${maxMdBytes} skipped="${text}"`)
        continue
      }
      added += line + '\n'
    }
    if (!added) {
      log(`MD_NOOP entries=${entries.length} reason=all-duplicate-or-full`)
      return
    }
    try {
      const sep = existing && !existing.endsWith('\n') ? '\n' : ''
      write(path, existing + sep + added, 'utf8')
      log(`MD_WRITE path=${path} newEntries=${entries.length} bytes=${(existing + sep + added).length}`)
    } catch (error) {
      log(`MD_WRITE_FAIL path=${path} error=${String(error)}`)
    }
  }

  /**
   * 用后刷新: 已存过的条目若本对话应用过, 把日期戳刷新到当天。
   * 仅改时间戳不动内容; 结果超 maxMdBytes 则跳过写盘。
   */
  function refreshUsageStamps(fragments) {
    if (!Array.isArray(fragments) || !fragments.length) return 0
    const cleaned = fragments
      .map((f) => stripEntryStamp(f).trim())
      .filter((f) => f.length >= 3)
    if (!cleaned.length) return 0
    const path = join(directory, 'AGENTS.md')
    let content = ''
    try {
      content = exists(path) ? read(path, 'utf8') : ''
    } catch (error) {
      log(`STAMP_READ_FAIL path=${path} error=${String(error)}`)
      return 0
    }
    const stamp = `[${dateStamp(now())}]`
    let updated = 0
    const lines = content.split('\n').map((line) => {
      if (!line.trim().startsWith('- ')) return line
      const body = stripEntryStamp(line)
      if (!body || !cleaned.some((f) => body.includes(f))) return line
      const next = stampEntryLine(line, stamp)
      if (next !== line) updated++
      return next
    })
    if (!updated) {
      log(`MD_STAMP_REFRESH updated=0 fragments=${cleaned.length}`)
      return 0
    }
    const nextContent = lines.join('\n')
    if (nextContent.length > maxMdBytes) {
      log(`MD_STAMP_REFRESH_SKIP reason=md-full len=${nextContent.length} max=${maxMdBytes}`)
      return 0
    }
    try {
      write(path, nextContent, 'utf8')
      log(`MD_STAMP_REFRESH updated=${updated}`)
      return updated
    } catch (error) {
      log(`STAMP_WRITE_FAIL path=${path} error=${String(error)}`)
      return 0
    }
  }

  // ── 项目级 4 项提醒 (context hook 触发, 与 compact 流程正交) ──
  function ensureOverviewReminder({ messages = [] } = {}) {
    if (isDisabled()) return
    const cursor = readCursorLocal(cursorPath()) ?? {}
    if (cursor.hasOverview) return
    const mdPath = join(directory, 'AGENTS.md')
    let head = ''
    try {
      head = exists(mdPath) ? read(mdPath, 'utf8') : ''
    } catch (error) {
      log(`OVERVIEW_READ_FAIL path=${mdPath} error=${String(error)}`)
      return
    }
    const hasOverview = head
      .split('\n')
      .slice(0, 50)
      .some((line) => line.includes(OVERVIEW_MARKER))
    if (hasOverview) {
      if (!cursor.hasOverview) {
        writeCursorLocal(cursorPath(), { ...cursor, hasOverview: true })
        log(`OVERVIEW_OK hasOverview=true`)
      }
      return
    }
    const lastUser = [...messages]
      .reverse()
      .find((m) => messageRoleOf(m) === 'user' && messagePartsOf(m))
    if (!lastUser) return
    if (messages[messages.length - 1] !== lastUser) return
    appendSyntheticText(lastUser, `\n\n${OVERVIEW_REMINDER}`)
    log(`OVERVIEW_REMINDER injected (recurring until written)`)
  }

  function ensureSuggestGlobalReminder({ messages = [] } = {}) {
    if (isDisabled()) return
    const mdPath = join(directory, 'AGENTS.md')
    let content = ''
    try {
      content = exists(mdPath) ? read(mdPath, 'utf8') : ''
    } catch (error) {
      log(`SUGGEST_GLOBAL_READ_FAIL path=${mdPath} error=${String(error)}`)
      return
    }
    const count = content
      .split('\n')
      .filter((line) => line.trim().startsWith('- ' + SUGGEST_GLOBAL_MARKER)).length
    const cursor = readCursorLocal(cursorPath()) ?? {}
    const lastCount = cursor.suggestGlobalPromptedCount ?? 0
    if (count < lastCount) {
      writeCursorLocal(cursorPath(), { ...cursor, suggestGlobalPromptedCount: count })
      return
    }
    if (count === 0) return
    if (count === lastCount) return
    const lastUser = [...messages]
      .reverse()
      .find((m) => messageRoleOf(m) === 'user' && messagePartsOf(m))
    if (!lastUser) return
    if (messages[messages.length - 1] !== lastUser) return
    const reminder =
      `【必须执行】项目 AGENTS.md 中有 ${count} 条以 \`[建议全局] \` 开头的经验。` +
      `请逐条当面向用户询问是否升级为全局经验: 用户同意 → 移动到全局 AGENTS.md; 不同意 → 删除 \`[建议全局] \` 前缀。` +
      `不得跳过、不得推迟, 处理完所有条目才算满足要求。`
    appendSyntheticText(lastUser, `\n\n${reminder}`)
    writeCursorLocal(cursorPath(), { ...cursor, suggestGlobalPromptedCount: count })
    log(`SUGGEST_GLOBAL_REMINDER injected count=${count}`)
  }

  function ensureRecycleReminder({ messages = [] } = {}) {
    if (isDisabled()) return
    const mdPath = join(directory, 'AGENTS.md')
    let content = ''
    try {
      content = exists(mdPath) ? read(mdPath, 'utf8') : ''
    } catch (error) {
      log(`RECYCLE_READ_FAIL path=${mdPath} error=${String(error)}`)
      return
    }
    const count = countMdEntries(content)
    if (count < RECYCLE_THRESHOLD) return
    const lastUser = [...messages]
      .reverse()
      .find((m) => messageRoleOf(m) === 'user' && messagePartsOf(m))
    if (!lastUser) return
    if (messages[messages.length - 1] !== lastUser) return
    const target = recycleTargetCount()
    const projectName = directory.split(/[\\/]/).filter(Boolean).pop() ?? '未知项目'
    const reminder =
      `【${projectName}】AGENTS.md 经验条目已达 ${count} 条, 目标压到 ${target} 条以内。\n` +
      `你自处理即可, 不必逐条展开处理过程——可在任务间隙按以下标准顺手处理:\n` +
      `1. 准入门槛 + 可复用性: 必须是「可参考、可执行的规范」+ 未来会被反复应用; 拒绝事实性描述/一次性描述(已交付产物写法)/与项目概述重叠/行业平台公开知识\n` +
      `2. 已解决\n` +
      `3. 重复同义\n` +
      `4. 作用域错位\n` +
      `5. 同一主题拆多条\n` +
      `6. 低频占常驻\n` +
      `7. 依赖环境已变化\n` +
      `8. 长期未用: 时间戳久未刷新(或无时间戳且创建已久)的条目 → 优先审查删除; 结合本会话印象, 拿不准的保留\n` +
      `不挤占主任务输出带宽, 不必立刻处理。`
    appendSyntheticText(lastUser, `\n\n${reminder}`)
    log(`RECYCLE_REMINDER injected count=${count}`)
  }

  function ensureGlobalRuleSync({ messages = [] } = {}) {
    if (isDisabled()) return
    const globalMd = globalAgentsPath
    let content = ''
    try {
      content = exists(globalMd) ? read(globalMd, 'utf8') : ''
    } catch (error) {
      log(`GLOBAL_RULE_READ_FAIL path=${globalMd} error=${String(error)}`)
      return
    }
    if (content.includes(SUGGEST_GLOBAL_RULE_KEY)) return // 已有规则句, 不管
    try {
      const sep = content && !content.endsWith('\n') ? '\n' : ''
      write(globalMd, content + sep + SUGGEST_GLOBAL_RULE + '\n', 'utf8')
      log(`GLOBAL_RULE_WRITE path=${globalMd}`)
    } catch (error) {
      log(`GLOBAL_RULE_WRITE_FAIL path=${globalMd} error=${String(error)}`)
    }
  }

  return {
    handleCompactionEnded,
    buildCompactionInjection,
    writeSimpleEntries,
    refreshUsageStamps,
    ensureOverviewReminder,
    ensureSuggestGlobalReminder,
    ensureRecycleReminder,
    ensureGlobalRuleSync,
    readCursor: readCursorLocal,
    writeCursor: writeCursorLocal,
    isDisabled,
    parseReviewOutput,
    extractionInstructionForCompact,
  }
}

// ── 插件入口 (v5: opencode 2.x) ──
const plugin = {
  id: 'opencode-experience-reviewer',
  setup: async (ctx) => {
    debugLog(
      `setup() STARTED ${MARKER} v5(compact-hook) maxMdBytes=${MAX_MD_BYTES} enabled=${ENABLED}`
    )
    if (!ENABLED) {
      debugLog('setup() DISABLED (ENABLED=false)')
      return () => {}
    }

    /** sessionID → {directory, title} (opencode.db 反查, 缓存) */
    const sessionMeta = new Map()
    /** directory → reviewer 实例 (同项目多会话共享) */
    const reviewers = new Map()

    function metaFor(sessionID) {
      if (!sessionID) return null
      if (sessionMeta.has(sessionID)) return sessionMeta.get(sessionID)
      let meta = null
      try {
        const db = openSqlite(openCodeDbPath(), { readOnly: true })
        try {
          const row = db.prepare(`SELECT directory, title FROM session_v2 WHERE id = ?`).get(sessionID)
          if (row?.directory) meta = { directory: row.directory, title: row.title ?? null }
        } finally {
          db.close()
        }
      } catch (error) {
        debugLog(`V2_META_FAIL sid=${sessionID} error=${String(error)}`)
      }
      if (!meta) debugLog(`V2_META_MISS sid=${sessionID}`)
      else debugLog(`V2_META sid=${sessionID} dir=${meta.directory} title=${meta.title ?? '-'}`)
      sessionMeta.set(sessionID, meta)
      return meta
    }

    function reviewerFor(directory) {
      const cached = reviewers.get(directory)
      if (cached) return cached
      const omoDir = join(directory, '.experience-reviewer')
      try {
        mkdirSync(omoDir, { recursive: true })
        debugLog(`ERO_DIR_READY path=${omoDir}`)
      } catch (error) {
        debugLog(`ERO_DIR_FAIL path=${omoDir} error=${String(error)}`)
      }
      const reviewer = createExperienceReviewer({ directory })
      reviewers.set(directory, reviewer)
      return reviewer
    }

    // ── hook 1: context (项目级 4 项提醒) ──
    ctx.session.hook('context', (event) => {
      try {
        const messages = event?.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        const meta = metaFor(event?.sessionID)
        if (!meta?.directory) return
        const reviewer = reviewerFor(meta.directory)
        reviewer.ensureOverviewReminder({ messages })
        reviewer.ensureSuggestGlobalReminder({ messages })
        reviewer.ensureRecycleReminder({ messages })
        reviewer.ensureGlobalRuleSync({ messages })
      } catch (error) {
        debugLog(`V2_CONTEXT_HOOK_FAIL ${String(error)}`)
      }
    })

    // ── hook 2: compaction (注入提取指令, V2 范式: mutate event) ──
    // V1 写法 (return { messages: [...] }) 在 V2 SDK 下被忽略 —— V2 callback
    // 只接受 mutate event 自身. event.messages 是 SDK 提供的 transcript 引用,
    // push 进去即 SDK 采纳. 若 event.messages 不是数组 (V2 SDK 偶发),
    // 打 COMPACTION_NO_MUTABLE_MESSAGES 告警但不抛错.
    ctx.session.hook('compaction', (event) => {
      try {
        const meta = metaFor(event?.sessionID)
        if (!meta?.directory) return // 不返回 = opencode 用原 messages 继续
        const reviewer = reviewerFor(meta.directory)
        const injection = reviewer.buildCompactionInjection()
        if (!injection) return
        if (!Array.isArray(event?.messages)) {
          debugLog(
            `COMPACTION_NO_MUTABLE_MESSAGES sid=${event?.sessionID ?? '-'} ` +
              `keys=${Object.keys(event || {}).join(',')}`
          )
          return
        }
        const before = event.messages.length
        event.messages.push(injection)
        debugLog(
          `COMPACTION_INJECT_V2 sid=${event?.sessionID ?? '-'} before=${before} after=${event.messages.length}`
        )
      } catch (error) {
        debugLog(`COMPACTION_HOOK_FAIL_V2 ${String(error)}`)
      }
    })

    // ── event: 订阅 session.compaction.ended / .failed ──
    try {
      const stream = ctx.event.subscribe()
      ;(async () => {
        try {
          for await (const evt of stream) {
            if (!evt || typeof evt !== 'object') continue
            if (evt.type === 'session.compaction.ended') {
              try {
                const meta = metaFor(evt.data?.sessionID)
                if (!meta?.directory) {
                  debugLog(`COMPACTION_NO_DIR sid=${evt.data?.sessionID ?? '-'}`)
                  continue
                }
                const reviewer = reviewerFor(meta.directory)
                reviewer.handleCompactionEnded({ event: evt })
              } catch (error) {
                debugLog(`COMPACTION_ENDED_HANDLER_FAIL ${String(error)}`)
              }
            } else if (evt.type === 'session.compaction.failed') {
              debugLog(
                `COMPACTION_FAILED sid=${evt.data?.sessionID ?? '-'} ` +
                  `error="${evt.data?.error?.message ?? '-'}"`
              )
            }
          }
        } catch (error) {
          debugLog(`EVENT_STREAM_BROKEN ${String(error)}`)
        }
      })()
    } catch (error) {
      debugLog(`EVENT_SUBSCRIBE_FAIL ${String(error)}`)
    }

    return () => {}
  },
}

export default plugin
export {
  createExperienceReviewer,
  parseReviewOutput,
  extractJsonBlock,
  extractionInstructionForCompact,
  projectIdFromCwd,
  storeComplexExperience,
  queryExperiences,
  // 基础工具 (测试 & 后续使用)
  countMdEntries,
  dateStamp,
  stripEntryStamp,
  stampEntryLine,
  normalizeProjectDir,
}
