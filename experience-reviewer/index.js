/**
 * experience-reviewer — OpenCode 经验回顾插件 (mission 161, v2.0 架构)
 *
 * 目的: 周期性回顾项目对话, 把可沉淀内容自动留存:
 *   - 简单经验 (一句话能说明白) → 写 AGENTS.md (项目级/全局, 去重 + 上限)
 *   - 复杂经验 (需多行说明的可复用知识) → OCM 经验库 HTTP API
 *     (subagent 在 --pure 纯净进程跑, 无 OCM MCP; 插件解析后代写入)
 *
 * v2.0 相比 v1.0 的架构变化:
 *   v1: messages.transform 往主会话注入回顾指令 → 主 agent 顺带总结
 *       ✗ 打断主 agent 工作节奏 / 指令在 context 中部 KV cache 不友好
 *   v2: hook 只做触发检测 (不注入任何内容) → 插件异步 spawn
 *       `opencode run --pure` 独立 subagent, 读 memory.db 未总结消息,
 *       subagent 输出结构化 JSON → 插件写 AGENTS.md / OCM API
 *       ✓ 主 agent 零感知 / 独立 context 可完整缓存
 *
 * 流程:
 *   [触发] hook (轮次≥3 或 时间≥10min, 任一先满足, 双冷却重置)
 *     → state.needReview = true (不修改 messages, 不注入任何 part)
 *   [执行] fire-and-forget 异步 (不阻塞主会话):
 *     1. 读 cursor (.experience-reviewer/experience-cursor.json) → lastMessageId
 *     2. 直读 opencode.db (~/.local/share/opencode/opencode.db, 任何 opencode 用户都有,
 *        不依赖 OCM 插件):
 *        a. session: 本项目主会话 (directory 匹配 + parent_id IS NULL 排除 subagent)
 *        b. message: 主会话下 role IN (user,assistant) 的消息 (data JSON 的 role 字段)
 *        c. part:   消息的 type='text' 分区拼 text (工具调用/think 天然排除)
 *        d. 增量: message.time_created > cursor 对应消息的时间戳
 *     3. 无新消息 → 静默返回, 不更新 cursor
 *     5. 构建提示词 (经验提取指令 + 消息快照), 直接作为 positional message 传入
 *     6. spawn: opencode run --pure [-m model] <提示词>  (勿用 -f: 那是 attach 文件语义, 非读 prompt)
 *     7. 解析 subagent stdout 中 JSON: {"simple":[{"scope","text"}],"complex":[...]}
 *     8. simple → 写 AGENTS.md ; complex → OCM API (stub, 等 API 就绪)
 *     9. 更新 cursor → 下次从最后一条之后继续
 *
 * 配置 (环境变量, 全部可选):
 *   EXP_REVIEW_ROUND_INTERVAL   触发轮次阈值 (默认 3)
 *   EXP_REVIEW_TIME_INTERVAL_MS 触发时间阈值 ms (默认 10min)
 *   EXP_REVIEW_MAX_MD_BYTES     AGENTS.md 上限 (默认 20KB)
 *   EXP_REVIEW_MAX_MESSAGES     SQL 防御上限 (默认 200; cursor 之后全部新内容都应提取, 超出按完整轮次截断)
 *   EXP_REVIEW_MODEL            subagent 模型 (默认 opencode 默认模型)
 *   EXP_REVIEW_TIMEOUT_MS       subagent 超时 ms (默认 120s)
 *
 * 验证 (重启 opencode 后):
 *   单元: node --test test/ (零依赖)
 *   真实: EXP_REVIEW_ROUND_INTERVAL=1, 对话几轮 → %TEMP%\experience-reviewer.log
 *         出现 TRIGGER → REVIEW_START → REVIEW_PARSE → MD_WRITE 链路
 * 复杂经验: complex 条目自动走 OCM API stub (当前 log EXP_COMPLEX_API_NOT_READY)
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
import { spawn } from 'node:child_process'

// ── SQLite 双运行时适配 (OCM db.js 已验证模式) ──────────────────────────────
// opencode 插件宿主是 bun: bun (Windows) 无 node:sqlite 内置模块, import 即抛错,
// 导致 opencode 静默跳过整个插件 (零日志/零加载)。按 OCM plugin-v2/src/memory/db.js
// 同款: IS_BUN 检测 → createRequire 按运行时选 bun:sqlite / node:sqlite。
// 两 API 兼容: prepare().all/get/run, exec(), close(); 仅模块名/类名/readonly 拼写不同。
const IS_BUN = typeof process.versions !== 'undefined' && !!process.versions.bun
const require = createRequire(import.meta.url)
const DatabaseSync = IS_BUN
  ? require('bun:sqlite').Database
  : require('node:sqlite').DatabaseSync

/** 打开 SQLite db: 吸收 bun/node 构造选项差异。bun quirk: 显式传 readonly:false 抛错, 默认开别传 */
function openSqlite(path, { readOnly } = {}) {
  if (IS_BUN) {
    return readOnly ? new DatabaseSync(path, { readonly: true }) : new DatabaseSync(path)
  }
  return new DatabaseSync(path, { readOnly: !!readOnly })
}

const ENABLED = true
const MARKER = '[experience-reviewer]'
const DEBUG_LOG = join(homedir(), 'AppData', 'Local', 'Temp', 'experience-reviewer.log')

const DEFAULT_ROUND_INTERVAL = 3 // 触发: 距上次回顾 ≥3 轮用户消息
const DEFAULT_TIME_INTERVAL_MS = 10 * 60 * 1000 // 触发: 距上次回顾 ≥10 分钟
// AGENTS.md 上限 20KB (≈400-600 条一句话规则 ≈ 0.7万-1万 token/轮):
const DEFAULT_MAX_MD_BYTES = 20 * 1024
const DEFAULT_MAX_MESSAGES = 200 // SQL 防御上限 (cursor 之后全部新内容都应提取; 超出部分按完整轮次截断, 游标保持一致)
const DEFAULT_TIMEOUT_MS = 120 * 1000 // subagent 进程超时
const DEFAULT_MAX_PROMPT_CHARS = 30000 // Windows 命令行长度 ~32k, 留余量防 spawn ENAMETOOLONG
/** cursor 文件: 每项目 .experience-reviewer/experience-cursor.json (状态只认项目路径, 与 session 无关) */
const CURSOR_FILE = join('.experience-reviewer', 'experience-cursor.json')

const envRound = Number(process.env.EXP_REVIEW_ROUND_INTERVAL)
const ROUND_INTERVAL = Number.isFinite(envRound) && envRound > 0 ? envRound : DEFAULT_ROUND_INTERVAL
const envTime = Number(process.env.EXP_REVIEW_TIME_INTERVAL_MS)
const TIME_INTERVAL_MS =
  Number.isFinite(envTime) && envTime > 0 ? envTime : DEFAULT_TIME_INTERVAL_MS
const envMax = Number(process.env.EXP_REVIEW_MAX_MD_BYTES)
const MAX_MD_BYTES = Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_MD_BYTES
const envMaxMsgs = Number(process.env.EXP_REVIEW_MAX_MESSAGES)
const MAX_MESSAGES = Number.isFinite(envMaxMsgs) && envMaxMsgs > 0 ? envMaxMsgs : DEFAULT_MAX_MESSAGES
const envTimeout = Number(process.env.EXP_REVIEW_TIMEOUT_MS)
const TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS
const envPromptMax = Number(process.env.EXP_REVIEW_MAX_PROMPT_CHARS)
const MAX_PROMPT_CHARS =
  Number.isFinite(envPromptMax) && envPromptMax > 0 ? envPromptMax : DEFAULT_MAX_PROMPT_CHARS
/** simple 经验单条最大字符数: 提示词要求 ≤50 字单句, 护栏兜底拦截超长 (超长应升级为 complex) */
const envSimpleMax = Number(process.env.EXP_SIMPLE_MAX_CHARS)
const SIMPLE_MAX_CHARS = Number.isFinite(envSimpleMax) && envSimpleMax > 0 ? envSimpleMax : 50
/** subagent 模型: 默认 opencode/big-pickle (实测可用; 无 -m 时 opencode 默认解析会选中不可用的 kimi-k3 挂起) */
const REVIEW_MODEL = (process.env.EXP_REVIEW_MODEL || '').trim() || 'opencode/big-pickle'
/**
 * subagent 会话标记: spawn 时传 --title, 落库到 session.title。
 * readUnsumm 按此排除 subagent 独立会话 (parent_id IS NULL 拦不住 --pure 独立进程,
 * 其 directory 与项目相同 → 必须靠 title 标记隔离)。固定值, 永不变化。
 */
const SUBAGENT_SESSION_TITLE = 'EXP_EXTRACTOR'

/**
 * OCM HTTP API base URL (复杂经验读写走此 API; 由 OCM MCP server 同进程 boot,
 * 端口默认 7333, 见 OCM plugin-v2/src/api/http.js)。环境变量可覆盖。
 */
const OCM_API_BASE = (process.env.EXP_OCM_API_BASE || 'http://127.0.0.1:7333').replace(/\/+$/, '')
const OCM_TIMEOUT_MS = 8000

/**
 * opencode.db 路径 (数据直读源, 不依赖 OCM 插件; 任何 opencode 用户都有此库)
 * 默认 ~/.local/share/opencode/opencode.db, 环境变量 EXP_OPENCODE_DB_PATH 可覆盖
 */
function openCodeDbPath() {
  const env = (process.env.EXP_OPENCODE_DB_PATH || '').trim()
  return env || join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

/** OCM 项目标识: sha256(项目根路径)[:16] (已验证: 当前项目 = b86d670963d94466) */
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

/** OMO resolveMessageEventSessionID 同款: message/part 事件尽力提取 sessionID */
function resolveMessageEventSessionID(properties) {
  const props = properties && typeof properties === 'object' ? properties : undefined
  const info = props?.info && typeof props.info === 'object' ? props.info : undefined
  const part = props?.part && typeof props.part === 'object' ? props.part : undefined
  for (const value of [props?.sessionID, info?.sessionID, part?.sessionID]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 读取未总结消息: opencode.db → [{message_id, role, text}]
 * 定位: session.directory 匹配项目根 (反斜杠/正斜杠归一化, 大小写不敏感)
 * 过滤: parent_id IS NULL 排除 subagent 子会话; role IN (user,assistant)
 * 文本: part 表 type='text' 分区拼接 (工具调用/think 天然排除)
 * cursor 语义: lastMessageId 为已总结到的最后一条 (msg_id 与 opencode.db message.id 同源,
 *   跨数据源无缝续迁)。取该消息 time_created 作时间游标 (time_created 是毫秒 epoch 整数, 比字符串可靠)
 * 无 cursor → 不啃历史, 只取最近 limit 条 (DESC LIMIT 再反转 → 时间升序)
 * @param {object} db 打开的 opencode.db (readOnly)
 * @param {string} directory 项目根路径 (opencode 传给插件的 directory)
 * @returns {Array<{message_id:string, role:string, text:string}>} 按时间升序
 */
function readUnsummarizedMessages({ db, directory, lastMessageId = null, limit = MAX_MESSAGES }) {
  const normDir = String(directory || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
  if (!normDir) return []
  // 1. 本项目主会话: session 表全量主会话 (量级几百行, 可接受), JS 端归一化匹配路径
  //    title 排除: --pure 独立进程的 directory 与项目相同, parent_id IS NULL 拦不住
  //    必须靠 runSubagent 传入的 --title 标记 (SUBAGENT_SESSION_TITLE) 隔离
  const sessions = db.prepare(`SELECT id, directory, title FROM session WHERE parent_id IS NULL`).all() ?? []
  const sessionIds = sessions
    .filter((s) => String(s?.directory || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === normDir)
    .filter((s) => s?.title !== SUBAGENT_SESSION_TITLE)
    .map((s) => s.id)
  if (!sessionIds.length) return []
  const ph = sessionIds.map(() => '?').join(',')
  // 2. cursor → time_created 时间游标 (找不到 cursor 消息 → 视为首次)
  let cursorTime = null
  if (lastMessageId) {
    const row = db.prepare(`SELECT time_created FROM message WHERE id = ?`).get(lastMessageId)
    if (row?.time_created != null) cursorTime = row.time_created
  }
  // 3. 拉消息 (role 过滤)
  const SCOPE_SQL = `FROM message m WHERE m.session_id IN (${ph}) AND json_extract(m.data, '$.role') IN ('user','assistant')`
  /** @type {Array<{message_id:string, role:string, time_created:number}>} */
  let rows
  if (cursorTime != null) {
    rows =
      db
        .prepare(
          `SELECT m.id AS message_id, json_extract(m.data, '$.role') AS role ${SCOPE_SQL} AND m.time_created > ? ORDER BY m.time_created ASC, m.id ASC LIMIT ?`
        )
        .all(...sessionIds, cursorTime, limit) ?? []
  } else {
    rows =
      db
        .prepare(
          `SELECT m.id AS message_id, json_extract(m.data, '$.role') AS role ${SCOPE_SQL} ORDER BY m.time_created DESC, m.id DESC LIMIT ?`
        )
        .all(...sessionIds, limit) ?? []
    rows.reverse()
  }
  if (!rows.length) return []
  // 4. 取文本: part 表 type='text' 分区 (同消息多分区拼接)
  const mh = rows.map((r) => '?').join(',')
  const parts =
    db
      .prepare(
        `SELECT message_id, data FROM part WHERE message_id IN (${mh}) AND json_extract(data, '$.type') = 'text'`
      )
      .all(...rows.map((r) => r.message_id)) ?? []
  const textByMsg = {}
  for (const p of parts) {
    try {
      const d = JSON.parse(p.data)
      if (d && typeof d.text === 'string' && d.text.trim()) {
        textByMsg[p.message_id] = (textByMsg[p.message_id] ? textByMsg[p.message_id] + '\n' : '') + d.text
      }
    } catch {
      /* 坏 JSON 分区跳过 */
    }
  }
  return rows
    .filter((r) => textByMsg[r.message_id] !== undefined)
    .map((r) => ({ message_id: r.message_id, role: r.role ?? 'user', text: textByMsg[r.message_id] }))
}

/**
 * 从 step-finish part 的 tokens 计算 KV cache 统计。
 * opencode part.data (step-finish): {tokens: {input, output, cache: {write, read}}} — 模型返回的 usage。
 * hitRate = cache.read / (cache.read + input): 命中缓存占本次输入总量比例。
 * @param {object|null|undefined} tokens part.data.tokens
 * @returns {{input:number, cacheRead:number, cacheWrite:number, hitRate:number}|null} 无法解析 → null
 */
function computeCacheStats(tokens) {
  if (!tokens || typeof tokens !== 'object') return null
  const input = Number(tokens.input)
  const cacheRead = Number(tokens.cache?.read)
  const cacheWrite = Number(tokens.cache?.write)
  if (!Number.isFinite(input) || !Number.isFinite(cacheRead) || !Number.isFinite(cacheWrite)) return null
  const total = cacheRead + input
  return {
    input,
    cacheRead,
    cacheWrite,
    hitRate: total > 0 ? Number((cacheRead / total).toFixed(4)) : 0,
  }
}

/**
 * 读最近一次 EXP_EXTRACTOR subagent 会话的 step-finish part tokens (KV cache 统计)。
 * 查不到 (无该会话/无 step-finish/解析失败) → null, 不阻塞 REVIEW_DONE。
 * @param {object} db 打开的 opencode.db (readOnly)
 * @returns {ReturnType<typeof computeCacheStats>|null}
 */
function readLastSubagentUsage(db, title = SUBAGENT_SESSION_TITLE) {
  try {
    const row = db
      .prepare(
        `SELECT p.data AS data FROM part p
         JOIN message m ON m.id = p.message_id
         JOIN session s ON s.id = m.session_id
         WHERE s.title = ? AND json_extract(p.data, '$.type') = 'step-finish'
         ORDER BY m.time_created DESC LIMIT 1`
      )
      .get(title)
    if (!row?.data) return null
    const d = JSON.parse(row.data)
    return computeCacheStats(d?.tokens)
  } catch {
    return null
  }
}

/**
 * 轮次聚合: 把扁平消息流按"轮次"分组。
 * 轮次定义 = 一次用户发言 (连续 user 消息段) + 对应助手回复 (连续 assistant 消息段)。
 *  - user 段: 连续 user 消息合并为一次发言 (用户+用户+agent 也只算一轮的"发言部分")
 *  - assistant 段: 连续 assistant 消息合并为一次回复 (用户+agent+agent 也只算一轮的"回复部分")
 *  - 孤儿消息: 流开头的 assistant (无前置 user, 属于上一轮已总结的回复尾巴) → 丢弃,
 *    保证每个交付轮次都同时含 user 与 assistant 上下文, LLM 不会拿到无头片段。
 *  - 悬挂 user: 末尾只有 user 没有 assistant (对话进行中/回复未落库) → 不构成完整轮次,
 *    不交付, 且游标不推进过它 (等下次回复补齐后再总结)。
 * @param {Array<{message_id:string, role:string, text:string}>} messages 时间升序
 * @returns {{turns: Array<{user: Array<{message_id,text}>, assistant: Array<{message_id,text}>}>, lastCompleteMessageId: string|null}}
 *   turns        仅完整轮次 (user 段 + assistant 段都有)
 *   lastCompleteMessageId 最后一个完整轮次的最后一条消息 id (cursor 应推进到的位置)
 */
function groupIntoTurns(messages) {
  /** @type {Array<{user: Array, assistant: Array}>} */
  const raw = []
  let current = null
  for (const m of messages) {
    if (m.role === 'user') {
      if (current && current.assistant.length === 0) {
        // 连续 user = 同一轮的一次发言, 合并 (用户+用户+agent = 一轮)
        current.user.push(m)
      } else {
        // 新轮次开始 (前一轮已有回复, 或尚无轮次)
        current = { user: [], assistant: [] }
        raw.push(current)
        current.user.push(m)
      }
    } else if (m.role === 'assistant') {
      if (current) {
        // 连续 assistant = 同一轮的一次回复, 合并 (用户+agent+agent = 一轮)
        current.assistant.push(m)
      }
      // else: 流开头孤儿 assistant → 丢弃 (属于上一轮已总结的回复尾巴)
    }
  }
  // 完整轮次 = 同时有 user 与 assistant
  const turns = raw.filter((r) => r.user.length > 0 && r.assistant.length > 0)
  const lastComplete = turns[turns.length - 1]
  const lastCompleteMessageId = lastComplete
    ? lastComplete.assistant[lastComplete.assistant.length - 1].message_id
    : null
  return { turns, lastCompleteMessageId }
}

/** 读 cursor 文件: 不存在 → null; 损坏 → null (安全: 视为首次) */
function readCursor(cursorPath) {
  try {
    if (!existsSync(cursorPath)) return null
    const raw = readFileSync(cursorPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.lastMessageId === 'string' && parsed.lastMessageId) return parsed
    return null
  } catch {
    return null
  }
}

/** 写 cursor 文件 (确保 .experience-reviewer/ 目录存在) */
function writeCursor(cursorPath, cursor) {
  try {
    mkdirSync(join(cursorPath, '..'), { recursive: true })
    writeFileSync(cursorPath, JSON.stringify(cursor, null, 2) + '\n', 'utf8')
  } catch (error) {
    debugLog(`CURSOR_WRITE_FAIL path=${cursorPath} error=${String(error)}`)
  }
}

/** 项目概述标记: AGENTS.md 顶部首行格式, 前 50 行内检测 */
const OVERVIEW_MARKER = '> **项目概述**: '
/** 缺概述时向主 agent 注入的提醒 (必须执行, 不允许忽略) */
const OVERVIEW_REMINDER =
  '【必须执行】本项目 AGENTS.md 缺少项目概述, 这是必须完成的事项。立即将一句话概述写入 AGENTS.md 顶部首行, 格式 `> **项目概述**: <一句话>`; 不得跳过、不得推迟、不得找理由忽略, 完成补写后才算满足要求。'
/** [建议全局] 经验提示: 项目 AGENTS.md 出现该前缀条目时, 主 agent 须询问用户去留 */
const SUGGEST_GLOBAL_MARKER = '[建议全局] '
/** 经验回收阈值: AGENTS.md 条目数 ≥ 此值 → 提醒主 agent 检查清理 */
const RECYCLE_THRESHOLD = 100
/** 回收压缩目标比例: 提醒后压到「上限 × 该比例」以内 (用户定 60%), 防止只压到刚好低于上限 */
const RECYCLE_TARGET_RATIO = 0.6
/** 动态计算的压缩目标条数 (上限 100 → 目标 60) */
function recycleTargetCount() {
  return Math.max(1, Math.floor(RECYCLE_THRESHOLD * RECYCLE_TARGET_RATIO))
}
/** 统计 AGENTS.md 中 `- ` 开头的一行经验条目数 */
function countMdEntries(content) {
  return content.split('\n').filter((line) => line.trim().startsWith('- ')).length
}
/** 全局规则句: 全局 AGENTS.md 缺这句时由插件自动补写 (用户批准: 有则不管, 无则自动写入) */
const SUGGEST_GLOBAL_RULE =
  '- 项目 AGENTS.md 出现 `[建议全局]` 前缀的经验条目时, 当面向用户确认是否转全局: 用户否 → 删标记留项目; 用户是 → 迁全局并删原条目'
/** 检测子串: 规则句核心短语, 用户微调措辞保留语义也能命中, 防重复写入 */
const SUGGEST_GLOBAL_RULE_KEY = '出现 `[建议全局]` 前缀的经验条目时'

/**
 * 构建 subagent 提示词: 对话记录原文在前, 提取规则在最末尾。
 * 规则部分全固定 → 前缀 = 对话原文 (与主会话一致), 规则注入不打断前缀缓存 (KV cache 友好)。
 * v2.2 规则: 排除 Claude 同类硬排除 + scope 默认 project + 疑似全局 [建议全局] 标记
 * (skill 专属经验不提取, subagent 不再直写全局)。
 */
function buildSubagentPrompt(messages, projectOverview = '', entryCount = 0) {
  const { turns } = groupIntoTurns(messages)
  if (!turns.length) return ''
  const transcript = turns
    .map((t, i) => {
      const userText = t.user.map((m) => `[用户] ${m.text}`).join('\n')
      const asstText = t.assistant.map((m) => `[助手] ${m.text}`).join('\n')
      return `[轮次 ${i + 1}]\n${userText}\n${asstText}`
    })
    .join('\n\n')
  // 上下文原文在前, 提取规则在最末尾 (规则固定, 前缀=对话原文 → KV cache 一致)
  const identity = projectOverview
    ? `===== 项目身份 =====\n你正在为以下项目提取经验: ${projectOverview}\n\n`
    : ''
  return (
    identity +
    `===== 对话记录 =====\n${transcript}\n\n` +
    `===== 提取任务 =====\n` +
    `你是经验提取器。阅读上方对话记录, 提取值得沉淀为经验的内容。\n` +
    `规则:\n` +
    `1. simple: 一句话能说明白的 规则/偏好/事实/教训, 单条 ≤50 字单句。scope 一律 project (写入项目 AGENTS.md)。\n` +
    `2. 归属 (suggestGlobal): 仅当"主语是用户本人跨项目偏好"或"工具链通用坑(与任何项目无关)"时 suggestGlobal=true; 拿不准一律 false。\n` +
    `3. 排除 (以下绝不提取): 能从项目代码/文档推导出的信息; 当次任务的一次性安排(如"先出5张试探"); ` +
    `特定 skill/领域专属经验(如 job-hunter 判岗、画图风格规则); 已存过/高度相似内容。\n` +
    `4. complex: 需多行才说得清的 可复用知识/流程。字段 title/description/content/scope/type。` +
    `description 以 "使用时机: " 开头; type ∈ dev/research/data/process/negative。` +
    `scope: project=默认, global=跨项目通用(仅限用户偏好/工具链坑)。\n` +
    `5. 总判据: 只有"未来对话还用得上"的才提取。\n` +
    `6. 容量: 项目 AGENTS.md 经验条目上限 ${RECYCLE_THRESHOLD} 条, 当前 ${entryCount} 条。` +
    `本条仅作参考, 不限制提取: 达上限后主 agent 会收到清理提醒, 但仍按上述规则正常提取, 不要自行禁用 simple 输出。\n` +
    `7. 准入门槛: 经验条目必须是「可参考、可执行的规范」(规则/偏好/流程); 拒绝单纯事实性描述(路径/版本/API 行为等可从代码/文档推导的内容), 即使重复出现也不入库, 避免库膨胀失效。\n` +
    `8. 无内容 → 输出空数组, 不要编造。\n` +
    `只输出 JSON (不要 markdown 代码块包裹, 不要其他文字):\n` +
    `{"simple":[{"scope":"project","text":"...","suggestGlobal":false}],"complex":[]}`
  )
}

/** 从 subagent stdout 提取 JSON 块 (容错: 可能带前后缀/代码块) */
function extractJsonBlock(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  // 去掉 ```json ``` 包裹
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

/**
 * 解析 subagent 输出 → {simple:[{scope,suggestGlobal,text}], complex:[...]}
 * v2.2: 取消直写全局 — scope 一律 project; suggestGlobal 标记疑似全局条目
 * (subagent 输出 suggestGlobal=true, 或兼容旧格式 scope=global → 归一为 suggestGlobal)。
 */
function parseReviewOutput(stdout) {
  const json = extractJsonBlock(stdout)
  if (!json) return { simple: [], complex: [] }
  const simple = Array.isArray(json.simple)
    ? json.simple
        .filter((e) => e && typeof e.text === 'string' && e.text.trim())
        .map((e) => ({
          scope: 'project',
          suggestGlobal: e.suggestGlobal === true || e.scope === 'global',
          text: e.text.trim(),
        }))
    : []
  const complex = Array.isArray(json.complex)
    ? json.complex.filter(
        (e) => e && typeof e.title === 'string' && typeof e.content === 'string'
      )
    : []
  return { simple, complex }
}

/** 定位 opencode 可执行文件: 优先 npm 全局 exe (避免 shell 转义中文), 兜底 PATH */
function resolveOpenCodeBin() {
  const candidates = [
    join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      'opencode-ai',
      'bin',
      'opencode.exe'
    ),
    join(homedir(), '.opencode', 'bin', 'opencode.exe'),
  ]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      /* 跳过不可访问路径 */
    }
  }
  return 'opencode'
}

/**
 * 运行 subagent: spawn `opencode run --pure [-m model] <prompt>`
 * 注意: opencode 的 -f/--file 是 "attach 文件到消息", 不是从文件读 prompt,
 *       只传 -f 不传 message 会报 "You must provide a message or a command",
 *       故 prompt 文本直接作为 positional message 传入 (exe 分支不经 shell, 中文安全)。
 * @returns {Promise<{ok:boolean, code?:number, reason?:string, stdout:string, stderr:string}>}
 */
function runSubagent({ prompt, model = REVIEW_MODEL, timeoutMs = TIMEOUT_MS, cwd }) {
  return new Promise((resolve) => {
    // --title 固定标记 → session.title 落库 → readUnsumm 按 SUBAGENT_SESSION_TITLE 排除
    const args = ['run', '--pure', '--title', SUBAGENT_SESSION_TITLE, ...(model ? ['-m', model] : []), prompt]
    const bin = resolveOpenCodeBin()
    const useShell = !bin.endsWith('.exe') // .cmd/.ps1 需 shell; exe 直接参数数组 (中文安全)
    const child = spawn(bin, args, {
      shell: useShell,
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, reason: `timeout(${timeoutMs}ms)`, stdout, stderr })
    }, timeoutMs)
    child.stdout?.on('data', (d) => {
      stdout += d
    })
    child.stderr?.on('data', (d) => {
      stderr += d
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, reason: `spawn-error: ${String(err)}`, stdout, stderr })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

/** 辅助: OCM HTTP 请求 (fetch + AbortController 超时, 零外部依赖) */
async function ocmFetch(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OCM_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${OCM_API_BASE}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    let data = null
    try { data = await res.json() } catch { /* non-JSON response */ }
    return { ok: res.ok, status: res.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: error?.name === 'AbortError' ? 'timeout' : String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 写复杂经验 → OCM HTTP API (POST /experiences)
 * 字段映射: OCM title/description/content/scope/type/triggers/projectHash
 * OCM store 无去重 —— 调用侧负责调 queryExperiences 查重。
 * 返回 { success: true, id } 或 { success: false, reason }
 */
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

/**
 * 查经验 (OCM HTTP API, GET /experiences) — 用于 store 前去重。
 * 注意: HTTP 路由未透传 projectHash (OCM gap #1), projectHash 为 hint,
 * server 用 detectProject() fallback 可能不匹配。scope=global 可靠。
 * 返回 { success, experiences[], reason? }
 */
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
 * 经验回顾状态机。纯逻辑 + 依赖注入, 便于单元测试。
 * v2: handleTransform 只做触发检测 (绝不注入), 触发后异步 fireReview。
 */
function createExperienceReviewer(deps) {
  const {
    roundInterval = ROUND_INTERVAL,
    timeIntervalMs = TIME_INTERVAL_MS,
    maxMdBytes = MAX_MD_BYTES,
    maxMessages = MAX_MESSAGES,
    now = Date.now,
    log = debugLog,
    directory = '',
    globalAgentsPath = join(homedir(), '.config', 'opencode', 'AGENTS.md'),
    model = REVIEW_MODEL,
    read = readFileSync,
    write = writeFileSync,
    exists = existsSync,
    mkdir = mkdirSync,
    runSub = runSubagent,
    readUnsumm = readUnsummarizedMessages,
    storeComplex = storeComplexExperience,
    queryExp = queryExperiences,
    projectIdFn = projectIdFromCwd,
    openDb = (path) => openSqlite(path, { readOnly: true }),
    configFile = join(directory, '.experience-reviewer', 'config.json'),
  } = deps ?? {}

  /** 触发器状态 (只认项目路径 → cursor 文件持久化; session 无关) */
  let reviewInFlight = false

  /**
   * 按项目开关: <项目根>/.experience-reviewer/config.json 里 {"enabled": false} 关闭本项目提取。
   * 缺省 (无文件 / enabled 未定义 / enabled!==false) = 开。用注入的 fs (测试可 mock)。
   * 原因: 提取会 spawn subagent 消耗 token (即使 cache 命中 99% 也非免费), 不值得的项目在配置中关闭。
   */
  function isDisabled() {
    try {
      if (!exists(configFile)) return false
      const cfg = JSON.parse(read(configFile, 'utf8'))
      return cfg && typeof cfg === 'object' && cfg.enabled === false
    } catch {
      return false // 配置损坏 → 视为开启 (不误伤)
    }
  }

  /** 本轮用户消息条数 (回合计数基准) */
  function userMessageCount(messages) {
    return messages.filter((m) => m?.info?.role === 'user').length
  }

  /** 项目 cursor 路径 */
  function cursorPath() {
    return join(directory, CURSOR_FILE)
  }

  /** 读项目 AGENTS.md 概述 (前 50 行匹配 OVERVIEW_MARKER)。无概述 → '' */
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

  /** 读 cursor: 用注入的 fs (测试可 mock)。无文件/损坏 → null */
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

  /** 写 cursor: 用注入的 fs (测试可 mock) */
  function writeCursorLocal(cursorPathArg = cursorPath(), cursor) {
    try {
      mkdir(join(cursorPathArg, '..'), { recursive: true })
      write(cursorPathArg, JSON.stringify(cursor, null, 2) + '\n', 'utf8')
    } catch (error) {
      log(`CURSOR_WRITE_FAIL path=${cursorPathArg} error=${String(error)}`)
    }
  }

  /**
   * 异步回顾: 读未总结消息 → spawn subagent → 解析 → 写 AGENTS.md / OCM → 更新 cursor
   * 返回 Promise<boolean>; 任何失败返回 false 且不更新 cursor (下次重试)。
   */
  async function fireReview() {
    if (!directory) {
      log(`REVIEW_SKIP reason=no-directory`)
      return false
    }
    if (isDisabled()) {
      log(`REVIEW_SKIP reason=disabled-by-config`)
      return false
    }
    const projectId = projectIdFn(directory)
    const dbPath = openCodeDbPath()
    log(`REVIEW_START project=${projectId} db=${dbPath}`)
    let db
    try {
      db = openDb(dbPath)
    } catch (error) {
      log(`REVIEW_OPEN_FAIL error=${String(error)}`)
      return false
    }
    let messages
    let turnsGroup
    try {
      const cursor = readCursorLocal()
      messages = readUnsumm({
        db,
        directory,
        lastMessageId: cursor?.lastMessageId ?? null,
        limit: maxMessages,
      })
      // 轮次聚合: 只保留完整轮次 (user 段 + assistant 段), 游标推进到最后一个完整轮次末尾
      turnsGroup = groupIntoTurns(messages)
    } catch (error) {
      log(`REVIEW_READ_FAIL error=${String(error)}`)
      db.close()
      return false
    }
    db.close()
    if (!messages.length) {
      log(`REVIEW_SKIP reason=no-new-messages`)
      return false
    }
    if (!turnsGroup.turns.length) {
      // 有消息但无完整轮次 (全是回复尾巴/悬挂 user) → 不交付, 游标不动, 等下次补齐
      log(`REVIEW_SKIP reason=no-complete-turns total=${messages.length}`)
      return false
    }

    // 构建 prompt 并直接作为 positional message 传入 (opencode -f 是 attach 语义, 并不可靠)
    // prompt 超长时按轮次从尾部截断 (游标只推进到已交付的最后一个完整轮次, 不丢数据)
    let promptText
    let deliveredTurns = turnsGroup.turns
    const projectOverview = readProjectOverview()
    // 当前 AGENTS.md 条目数 → 注入提取提示词容量参考行 (只作参考, 不限制提取)
    const mdPath = join(directory, 'AGENTS.md')
    let entryCount = 0
    try {
      entryCount = exists(mdPath) ? countMdEntries(read(mdPath, 'utf8')) : 0
    } catch (error) {
      log(`MD_COUNT_FAIL path=${mdPath} error=${String(error)}`)
    }
    try {
      promptText = buildSubagentPrompt(deliveredTurns.flatMap((t) => [...t.user, ...t.assistant]), projectOverview, entryCount)
      while (promptText.length > MAX_PROMPT_CHARS && deliveredTurns.length > 1) {
        deliveredTurns = deliveredTurns.slice(0, -1)
        promptText = buildSubagentPrompt(deliveredTurns.flatMap((t) => [...t.user, ...t.assistant]), projectOverview, entryCount)
        log(`REVIEW_TRUNCATE turned turns=${deliveredTurns.length} len=${promptText.length}`)
      }
      if (promptText.length > MAX_PROMPT_CHARS) {
        log(`REVIEW_INPUT_TOO_LONG len=${promptText.length} max=${MAX_PROMPT_CHARS}`)
        return false
      }
    } catch (error) {
      log(`REVIEW_INPUT_BUILD_FAIL error=${String(error)}`)
      return false
    }

    // spawn subagent
    const res = await runSub({ prompt: promptText, cwd: directory })
    if (!res.ok) {
      log(`REVIEW_SUBAGENT_FAIL code=${res.code ?? '-'} reason=${res.reason ?? '-'} stderr=${(res.stderr || '').slice(-300)}`)
      return false
    }

    // 解析 + 写入
    const { simple, complex } = parseReviewOutput(res.stdout)
    log(`REVIEW_PARSE simple=${simple.length} complex=${complex.length} stdoutLen=${res.stdout.length}`)
    if (simple.length) writeSimpleEntries(simple)

    // 复杂经验: OCM store 无去重 → 先查现有 title, 已存在跳过
    let existingTitles = new Set()
    if (complex.length) {
      try {
        const q = await queryExp({ scope: 'all', type: 'all', topK: 500, projectId })
        if (q?.success) existingTitles = new Set(q.experiences.map((x) => x.title))
      } catch { /* 查重失败不阻塞, 视为无重复 */ }
    }

    let complexOk = true
    for (const e of complex) {
      if (existingTitles.has(e.title)) {
        log(`COMPLEX_DEDUP title="${e.title}"`)
        continue
      }
      const ok = await storeComplex(e, { projectId })
      if (!ok?.success) complexOk = false
    }
    if (complex.length && complexOk === false) {
      // 复杂经验写入失败 → 不更新 cursor (下次重试)
      log(`REVIEW_COMPLEX_FAILED complex=${complex.length} → cursor 保持, 下次重试`)
      return false
    }

    // 更新 cursor: 推进到已交付轮次的最后一个完整轮次末尾 (不是全局最后一条消息)
    const lastDelivered = deliveredTurns[deliveredTurns.length - 1]
    const lastMessageId = lastDelivered
      ? lastDelivered.assistant[lastDelivered.assistant.length - 1]?.message_id ?? null
      : null
    if (!lastMessageId) {
      log(`REVIEW_SKIP reason=no-cursor-progress`)
      return false
    }
    const cur = readCursorLocal() ?? {}
    // 缓存命中率统计: 读最近 EXP_EXTRACTOR 会话的 step-finish tokens (拿不到不阻塞 REVIEW_DONE)
    let lastCacheHitRate = null
    try {
      const dbC = openDb(dbPath)
      try {
        lastCacheHitRate = readLastSubagentUsage(dbC, SUBAGENT_SESSION_TITLE)?.hitRate ?? null
      } finally {
        dbC.close()
      }
    } catch (error) {
      log(`REVIEW_CACHE_STATS_FAIL error=${String(error)}`)
    }
    writeCursorLocal(cursorPath(), {
      ...cur,
      lastMessageId,
      lastReviewAt: new Date().toISOString(),
      ...(lastCacheHitRate !== null ? { lastCacheHitRate } : {}),
    })
    log(
      `REVIEW_DONE cursor=${lastMessageId} turns=${deliveredTurns.length} simple=${simple.length} ` +
        `complex=${complex.length} cacheHitRate=${lastCacheHitRate ?? '-'}`
    )
    return true
  }

  /**
   * transform hook 入口。触发状态只认项目路径 (cursor 文件), 与 session 无关:
   * 换 session / 重启 / 任何 agent 在本项目下的对话, 共享同一份触发状态。
   * 触发 → 异步 fireReview (fire-and-forget, 不阻塞主会话)。
   */
  function handleTransform({ messages = [] } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return
    if (isDisabled()) return // 按项目关闭 → 完全跳过 (零开销, 不写 cursor 不触发)
    const userCount = userMessageCount(messages)
    const cursor = readCursorLocal() ?? {}
    const lastReviewRound = typeof cursor.lastReviewRound === 'number' ? cursor.lastReviewRound : 0
    const lastReviewAtMs =
      typeof cursor.lastReviewAt === 'string'
        ? Date.parse(cursor.lastReviewAt)
        : typeof cursor.lastReviewAt === 'number'
          ? cursor.lastReviewAt
          : now()
    if (lastReviewRound === 0) {
      // 首次: 基线, 避免开局立即触发
      writeCursorLocal(cursorPath(), {
        ...cursor,
        lastReviewRound: userCount,
        lastReviewAt: new Date(lastReviewAtMs).toISOString(),
      })
      return
    }
    // clamp 负数: 流式增量 / 消息回退不产生负 diff (修 rounds=-2)
    const roundsSince = Math.max(0, userCount - lastReviewRound)
    const timeSince = now() - lastReviewAtMs
    const roundHit = roundsSince >= roundInterval
    const timeHit = timeSince >= timeIntervalMs
    if (!roundHit && !timeHit) {
      // 统计字段随每次 transform 落盘 (cursor 文件 = 同路径统计真相源)
      writeCursorLocal(cursorPath(), {
        ...cursor,
        userCount,                    // 累计用户消息条数 (当前 session)
        roundsSince,                  // 距上次回顾轮数差
        timeSinceMs: timeSince,       // 距上次回顾毫秒
      })
      log(
        `TRANSFORM_WATCH rounds=${roundsSince}/${roundInterval} ms=${timeSince}/${timeIntervalMs} userCount=${userCount}`
      )
      return
    }

    // 触发 → 双冷却重置 (任一先触发, 两个都进入冷却)
    writeCursorLocal(cursorPath(), {
      ...cursor,
      lastReviewRound: userCount,
      lastReviewAt: new Date(now()).toISOString(),
    })
    log(`TRIGGER roundHit=${roundHit} timeHit=${timeHit} userCount=${userCount}`)

    if (reviewInFlight) {
      log(`REVIEW_SKIP reason=already-in-flight`)
      return
    }
    reviewInFlight = true
    fireReview().finally(() => {
      reviewInFlight = false
    })
  }

  /**
   * 简单经验写入项目 AGENTS.md (v2.2: 取消 subagent 直写全局)。
   * 全部写项目 MD; 疑似全局条目加 `[建议全局] ` 前缀, 由主 agent 当面向用户确认后迁全局。
   * 去重按原文 (前缀不参与); 大小上限保持。
   */
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
        // 护栏: 超长 simple 拒绝落盘 (提示词已要求 ≤50 字, 兜底防 LLM 百字长句冒充)
        log(`MD_TOO_LONG chars=${text.length} max=${SIMPLE_MAX_CHARS} skipped="${text.slice(0, 30)}…"`)
        continue
      }
      if (existing.includes(text) || added.includes(text)) continue // 去重 (原文)
      const line = `- ${e.suggestGlobal ? `[建议全局] ${text}` : text}`
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
   * 项目概述提醒 (v2.2 → v2.5 改 persistent): 读项目 AGENTS.md 前 50 行,
   * 匹配 `> **项目概述**: ` 标记。缺 → 每次 user-turn transform 都注入提醒
   * (用户要求「未写入就一直提醒直到写入为止」); 补写后 → 记 cursor.hasOverview 永久停。
   * v2.5 移除 one-shot (cursor.overviewPrompted 字段废弃): 旧设计为「首次提醒后永不再提醒」,
   * 导致 task() 派生的 subagent session 抢先触发一次后, 主 agent 永久收不到这条提示,
   * 与「未写入就一直提醒」的设计意图冲突。
   * 不能用 `# 标题` 判断 (全局 AGENTS.md 首行就是 `# ...` 会误判)。
   */
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
    // v2.5: 去掉 cursor.overviewPrompted one-shot 限制, 只要未写入每次 user-turn 都注入
    const lastUser = [...messages]
      .reverse()
      .find((m) => m?.info?.role === 'user' && Array.isArray(m.parts))
    if (!lastUser) return
    // 最小修改: 只在用户新消息到达的 transform 注入; assistant 生成/工具循环阶段跳过
    if (messages[messages.length - 1] !== lastUser) return
    // 与 task-context-injector 同款: synthetic part 追加到最后一条 user 消息
    lastUser.parts.push({ type: 'text', text: `\n\n${OVERVIEW_REMINDER}`, synthetic: true })
    log(`OVERVIEW_REMINDER injected (recurring until written)`)
  }

  /**
   * [建议全局] 询问提醒 (v2.2): 扫描项目 AGENTS.md 中 `- [建议全局] ` 开头的条目。
   * 有 → 注入提醒, 让主 agent 当面向用户询问: 升级→移入全局 AGENTS.md; 不升级→删除前缀。
   * 防刷屏: cursor.suggestGlobalPromptedCount 存「上次提醒时的条数」; 回落(处理/清零)时重置基线,
   * 条数涨回超过基线才重新提醒 (不存历史峰值, 防清理后再涨回同值被静默吞掉)。
   */
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
    // 回落 (含清零) → 重置基线: 用户处理过部分条目, 下次新增时能再次提醒
    if (count < lastCount) {
      writeCursorLocal(cursorPath(), { ...cursor, suggestGlobalPromptedCount: count })
      return
    }
    if (count === 0) return
    if (count === lastCount) return // 同值不重复提醒
    const lastUser = [...messages]
      .reverse()
      .find((m) => m?.info?.role === 'user' && Array.isArray(m.parts))
    if (!lastUser) return
    if (messages[messages.length - 1] !== lastUser) return
    const reminder =
      `【必须执行】项目 AGENTS.md 中有 ${count} 条以 \`[建议全局] \` 开头的经验。` +
      `请逐条当面向用户询问是否升级为全局经验: 用户同意 → 移动到全局 AGENTS.md; 不同意 → 删除 \`[建议全局] \` 前缀。` +
      `不得跳过、不得推迟, 处理完所有条目才算满足要求。`
    lastUser.parts.push({ type: 'text', text: `\n\n${reminder}`, synthetic: true })
    writeCursorLocal(cursorPath(), { ...cursor, suggestGlobalPromptedCount: count })
    log(`SUGGEST_GLOBAL_REMINDER injected count=${count}`)
  }

  /**
   * 经验回收提醒 (v2.3/v2.4): 项目 AGENTS.md 经验条目数 ≥ RECYCLE_THRESHOLD (100) 时,
   * 注入提醒让主 agent 按 7 个方向逐条清理 (删除/合并/迁移)。
   * 判据只有上限一条: 达标就一直提醒, 压回上限以下自动停。
   * (v2.3 前曾用 cursor.recyclePromptedCount 存「上次提醒时的条数」做同值静默,
   *  回落重置时又把基线写成当前值 → 清理到仍超上限时被自己锁死, 已删除该层。)
   * 限流靠「最新一条必须是 user 消息」, 天然一轮最多注入一次。
   */
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
      .find((m) => m?.info?.role === 'user' && Array.isArray(m.parts))
    if (!lastUser) return
    if (messages[messages.length - 1] !== lastUser) return
    const target = recycleTargetCount()
    // 目录名做项目标识: 尾部分隔符要一并剥掉 (根目录 '/' → 空)
    const projectName = directory.split(/[\\/]/).filter(Boolean).pop() ?? '未知项目'
    const reminder =
      `【${projectName}】*必须执行* 项目 AGENTS.md 经验条目已达 ${count} 条, 目标压到 ${target} 条以内。\n` +
      `逐条过现有条目, 命中即处理 (删除/合并/迁移), 每条给出原文和理由:\n` +
      `1. 不符合存储门槛 → 删。门槛 = 用户偏好 / 用户纠正 / 无法从代码推导的项目决策 / 反复踩的工程坑; skill 与领域专属经验不在门槛内\n` +
      `2. 已解决的问题\n` +
      `3. 重复/同义\n` +
      `4. 作用域错位 (与本项目无关的工具链坑)\n` +
      `5. 同一主题拆成多条\n` +
      `6. 低频场景占常驻\n` +
      `7. 依赖环境已变化\n` +
      `约束: 删除系统文件或全局 AGENTS.md 前先向用户说明; 完成后回报原条数 → 新条数, 以及各类方向各删/合并/迁了几条; 不得跳过推迟。`
    lastUser.parts.push({ type: 'text', text: `\n\n${reminder}`, synthetic: true })
    log(`RECYCLE_REMINDER injected count=${count}`)
  }

  /**
   * 全局规则句同步 (v2.2): 全局 AGENTS.md 缺 `[建议全局]` 确认规则句时自动补写。
   * 用户批准方案: 有则不管 (检测到即跳过), 无则自动写入 (一次性, 写入后下次检测命中不再重复)。
   * 与 reminder 不同: 不注入对话, 直接落盘全局文件。
   */
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
    if (content.includes(SUGGEST_GLOBAL_RULE_KEY)) return // 已有规则句(或保留语义的微调版本), 不管
    try {
      // 追加到全局 AGENTS.md 末尾; 已有内容且不以换行结尾时先补换行, 防止段落粘连
      const sep = content && !content.endsWith('\n') ? '\n' : ''
      write(globalMd, content + sep + SUGGEST_GLOBAL_RULE + '\n', 'utf8')
      log(`GLOBAL_RULE_WRITE path=${globalMd}`)
    } catch (error) {
      log(`GLOBAL_RULE_WRITE_FAIL path=${globalMd} error=${String(error)}`)
    }
  }

  return {
    handleTransform,
    fireReview,
    parseReviewOutput,
    writeSimpleEntries,
    ensureOverviewReminder,
    ensureSuggestGlobalReminder,
    ensureRecycleReminder,
    ensureGlobalRuleSync,
    readCursor: readCursorLocal,
    writeCursor: writeCursorLocal,
    isDisabled,
  }
}

const plugin = {
  id: 'opencode-experience-reviewer',
  server: async ({ directory }) => {
    // 启动即确保项目统计目录 .experience-reviewer/ 存在 (插件自有, 不寄生 .omo)
    const omoDir = join(directory, '.experience-reviewer')
    try {
      mkdirSync(omoDir, { recursive: true })
      debugLog(`ERO_DIR_READY path=${omoDir}`)
    } catch (error) {
      debugLog(`ERO_DIR_FAIL path=${omoDir} error=${String(error)}`)
    }
    debugLog(
      `server() STARTED ${MARKER} v2 roundInterval=${ROUND_INTERVAL} ` +
        `timeIntervalMs=${TIME_INTERVAL_MS} maxMdBytes=${MAX_MD_BYTES} ` +
        `maxMessages=${MAX_MESSAGES} model=${REVIEW_MODEL ?? '(default)'} enabled=${ENABLED}`
    )
    if (!ENABLED) {
      debugLog('server() DISABLED (ENABLED=false)')
      return {}
    }
    const reviewer = createExperienceReviewer({ directory })
    return {
      'experimental.chat.messages.transform': async (input, output) => {
        // 职责分离: handleTransform 只做触发检测 (零注入), 其余四个提醒单独注入
        reviewer.handleTransform({ messages: output?.messages })
        reviewer.ensureOverviewReminder({ messages: output?.messages })
        reviewer.ensureSuggestGlobalReminder({ messages: output?.messages })
        reviewer.ensureRecycleReminder({ messages: output?.messages })
        reviewer.ensureGlobalRuleSync({ messages: output?.messages })
      },
    }
  },
}

export default plugin
export {
  createExperienceReviewer,
  buildSubagentPrompt,
  parseReviewOutput,
  extractJsonBlock,
  readUnsummarizedMessages,
  groupIntoTurns,
  projectIdFromCwd,
  openCodeDbPath,
  storeComplexExperience,
  queryExperiences,
  computeCacheStats,
  readLastSubagentUsage,
}