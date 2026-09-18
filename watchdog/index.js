/**
 * watchdog — OpenCode 看门狗插件 (mission 162)
 *
 * 目的: 治"数小时卡 Thinking" (opencode issues #48675 / #49033 的插件级缓解)。
 *       会话 busy 且长时间无任何模型产出、且没有工具在执行 → 判定卡死 → 自动 abort。
 *
 * 判定逻辑 (三层, 缺一不可才 abort):
 *   1. 状态层: session.status.type === "busy"  (opencode 自己报的在跑)
 *   2. 产出层: 连续 STALL_TIMEOUT_MS 无 message.part.delta / assistant part.updated
 *              (reasoning 阶段的 delta 也会刷新 → 长思考不误杀)
 *   3. 活动层: 该 session 无未完成的工具执行 (tool.execute.before 未配 after 则豁免)
 *              → 等第三方返回 (图片/视频生成) 不误杀
 *
 * 为什么只用一个 event hook:
 *   - opencode 事件流原生包含 session.status / message.part.delta / tool.execute.*
 *     (对照 oh-my-opencode: dist/index.js:81085/81101 用同一批事件类型判活)
 *   - 无需自连 SSE, 无需 tool.execute.before hook
 *
 * 全局开关: ENABLED = false 即整体禁用。阈值可用环境变量 WATCHDOG_STALL_TIMEOUT_MS 覆盖。
 *
 * 验证方法 (重启 opencode 后):
 *   单元: test/watchdog.test.mjs 模拟事件序列断言状态机
 *   真实: WATCHDOG_STALL_TIMEOUT_MS=30000 起 opencode, 发一个注定卡死的请求
 *         → 30s 后 debug log 出现 WATCHDOG_ABORT → 会话被中断
 *   误杀: 发长任务 (bash 工具 / reasoning) → 确认无 abort、log 无 false positive
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENABLED = true
const MARKER = '[watchdog]'
const DEBUG_LOG = join(homedir(), 'AppData', 'Local', 'Temp', 'watchdog.log')
const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000 // 15 分钟 (可配置)
/** abort 调用最长等待 (OMO abortWithTimeout 同款: Promise.race 保护) */
const ABORT_TIMEOUT_MS = 10 * 1000

const envTimeout = Number(process.env.WATCHDOG_STALL_TIMEOUT_MS)
const STALL_TIMEOUT_MS =
  Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_STALL_TIMEOUT_MS

/** 视为"模型活着"的产出事件 (reasoning delta 也包含在内) */
const ACTIVITY_EVENT_TYPES = new Set([
  'message.part.delta',
  'message.part.updated',
  'message.updated',
  'message.part.removed',
  'message.removed',
])

function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* debug 日志失败不阻塞插件 */
  }
}

/** OMO resolveSessionEventID 同款: 从事件 properties 尽力提取 sessionID */
function resolveSessionEventID(properties) {
  const props = properties && typeof properties === 'object' ? properties : undefined
  const info = props?.info && typeof props.info === 'object' ? props.info : undefined
  return firstString(props?.sessionID, info?.sessionID, info?.id)
}

/** OMO resolveMessageEventSessionID 同款: message/part 事件额外查 part.sessionID */
function resolveMessageEventSessionID(properties) {
  const props = properties && typeof properties === 'object' ? properties : undefined
  const info = props?.info && typeof props.info === 'object' ? props.info : undefined
  const part = props?.part && typeof props.part === 'object' ? props.part : undefined
  return firstString(props?.sessionID, info?.sessionID, part?.sessionID)
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 看门狗状态机。纯逻辑、依赖注入, 便于单元测试。
 * 依赖: now() / setTimeout / clearTimeout / log / abort(sessionID)
 */
function createWatchdog(deps) {
  const {
    stallTimeoutMs = STALL_TIMEOUT_MS,
    abortTimeoutMs = ABORT_TIMEOUT_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    log = debugLog,
    abort = async () => {},
  } = deps ?? {}

  /** sessionID → 状态 */
  const sessions = new Map()

  function getState(sessionID) {
    let state = sessions.get(sessionID)
    if (!state) {
      state = {
        busy: false, // 最近一次 session.status 是否 busy
        toolDepth: 0, // 未完成的 tool.execute.before 深度
        timer: undefined, // 当前计时器句柄
        armedAt: undefined, // 最近一次 arm 时间 (证据)
        aborted: false, // 本会话已 abort 过 (幂等: 只 abort 一次)
      }
      sessions.set(sessionID, state)
    }
    return state
  }

  function clearTimerFor(state) {
    if (state.timer) {
      clearTimer(state.timer)
      state.timer = undefined
    }
  }

  /** 开始/重置计时 (条件是: busy && 无工具执行中 && 未 abort) */
  function arm(sessionID) {
    const state = getState(sessionID)
    clearTimerFor(state)
    // 工具执行中不 arm (等待第三方返回场景豁免); 已 abort 过不再计时
    if (!state.busy || state.toolDepth > 0 || state.aborted) return
    state.armedAt = now()
    state.timer = setTimer(() => expire(sessionID), stallTimeoutMs)
  }

  /** 计时到期: 仍处于卡死条件则 abort */
  async function expire(sessionID) {
    const state = sessions.get(sessionID)
    if (!state) return
    state.timer = undefined
    if (state.aborted || state.toolDepth > 0 || !state.busy) return
    state.aborted = true
    log(
      `WATCHDOG_ABORT sessionID=${sessionID} stalledMs=${now() - (state.armedAt ?? 0)} ` +
        `lastToolDepth=${state.toolDepth} -> aborting`
    )
    const ok = await abort(sessionID, abortTimeoutMs)
    log(`WATCHDOG_ABORT_RESULT sessionID=${sessionID} ok=${ok}`)
  }

  function cleanupIfInactive(sessionID) {
    const state = sessions.get(sessionID)
    if (state && !state.busy && state.toolDepth <= 0 && !state.timer) {
      sessions.delete(sessionID)
    }
  }

  /** 处理单个事件 (event hook 入口) */
  async function handleEvent(event) {
    const type = event?.type
    const props = event?.properties
    log(`EVENT type=${type ?? '(none)'}`)
    if (type === 'session.status') {
      const sessionID = resolveSessionEventID(props)
      if (!sessionID) return
      const statusType = props?.status?.type
      const state = getState(sessionID)
      state.busy = statusType === 'busy'
      log(`STATUS sessionID=${sessionID} busy=${state.busy}`)
      if (state.busy) {
        arm(sessionID)
      } else {
        clearTimerFor(state)
        cleanupIfInactive(sessionID)
      }
      return
    }
    if (type === 'session.idle') {
      const sessionID = resolveSessionEventID(props)
      if (!sessionID) return
      const state = getState(sessionID)
      state.busy = false
      clearTimerFor(state)
      cleanupIfInactive(sessionID)
      return
    }
    if (type === 'session.deleted') {
      const sessionID = resolveSessionEventID(props)
      if (sessionID) sessions.delete(sessionID)
      return
    }
    if (type === 'tool.execute.before') {
      const sessionID = resolveMessageEventSessionID(props)
      if (!sessionID) return
      const state = getState(sessionID)
      state.toolDepth += 1
      state.busy = true // 工具执行必然在 busy 会话里
      // 工具执行中: 豁免计时
      clearTimerFor(state)
      log(`TOOL_BEFORE sessionID=${sessionID} depth=${state.toolDepth} (exempt)`);
      return
    }
    if (type === 'tool.execute.after') {
      const sessionID = resolveMessageEventSessionID(props)
      if (!sessionID) return
      const state = getState(sessionID)
      state.toolDepth = Math.max(0, state.toolDepth - 1)
      // 工具执行完 → 恢复计时 (若 busy 且此前未 abort)
      log(`TOOL_AFTER sessionID=${sessionID} depth=${state.toolDepth}`)
      arm(sessionID)
      return
    }
    if (ACTIVITY_EVENT_TYPES.has(type)) {
      const sessionID = resolveMessageEventSessionID(props)
      if (!sessionID) return
      // 模型有产出 → 刷新计时
      arm(sessionID)
      // 顺手解析 abortDetectedAt 语义: 有产出说明活着
      return
    }
  }

  return {
    handleEvent,
    /** 测试/诊断: 内部状态快照 */
    _sessions: sessions,
  }
}

const plugin = {
  id: 'opencode-watchdog',
  server: async ({ client }) => {
    debugLog(
      `server() STARTED ${MARKER} stallTimeoutMs=${STALL_TIMEOUT_MS} abortTimeoutMs=${ABORT_TIMEOUT_MS} enabled=${ENABLED}`
    )
    const watchdog = createWatchdog({
      abort: async (sessionID, timeoutMs) => {
        if (!client?.session?.abort) {
          debugLog(`WATCHDOG_ABORT_SKIP sessionID=${sessionID} reason=no-client`)
          return false
        }
        try {
          const result = await Promise.race([
            client.session.abort({ path: { id: sessionID } }).then(
              (response) => {
                const error = response?.error
                if (error !== undefined && error !== null) {
                  debugLog(`WATCHDOG_ABORT_ERROR sessionID=${sessionID} error=${JSON.stringify(error)}`)
                  return false
                }
                return true
              },
              (error) => {
                debugLog(`WATCHDOG_ABORT_FAIL sessionID=${sessionID} error=${String(error)}`)
                return false
              },
            ),
            new Promise((resolve) => {
              setTimeout(() => resolve(false), timeoutMs)
            }),
          ])
          return result
        } catch (error) {
          debugLog(`WATCHDOG_ABORT_EXCEPTION sessionID=${sessionID} error=${String(error)}`)
          return false
        }
      },
    })
    if (!ENABLED) {
      debugLog('server() DISABLED (ENABLED=false)')
      return {}
    }
    return {
      event: ({ event }) => watchdog.handleEvent(event),
    }
  },
}

export default plugin
export { createWatchdog }