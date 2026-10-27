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
 * V1 / V2 双入口 (与 OCM 的 plugin-v2 同款做法):
 *   - V1: `{ id, server() }` 返回 `{ event }` hook, opencode 1.x 走这条
 *   - V2: `{ id, setup(ctx) }` 调 `ctx.event.subscribe()`, opencode 2.x 走这条
 *     (V2 只认 setup/effect, 不认 server; 缺 setup 会被拒载)
 *   - 两版事件名完全不同 (V2 不再发 session.status / session.idle /
 *     message.part.delta / tool.execute.*), 差异全部收敛在 v2EventToV1() 翻译层,
 *     状态机 createWatchdog() 一行没改
 *   - V2 中断用 `ctx.session.interrupt({ sessionID, continue:false })`,
 *     V1 用 `client.session.abort({ path: { id } })`
 *
 * 全局开关: ENABLED = false 即整体禁用。阈值可用环境变量 WATCHDOG_STALL_TIMEOUT_MS 覆盖。
 *
 * 验证方法 (重启 opencode 后):
 *   单元: test/watchdog.test.mjs 模拟事件序列断言状态机
 *   真实: WATCHDOG_STALL_TIMEOUT_MS=30000 起 opencode, 发一个注定卡死的请求
 *         → 30s 后 debug log 出现 WATCHDOG_ABORT → 会话被中断
 *   误杀: 发长任务 (bash 工具 / reasoning) → 确认无 abort、log 无 false positive
 */
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENABLED = true
const MARKER = '[watchdog]'
const DEBUG_LOG = join(homedir(), 'AppData', 'Local', 'Temp', 'watchdog.log')
const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000 // 15 分钟 (可配置)
/** abort 调用最长等待 (OMO abortWithTimeout 同款: Promise.race 保护) */
const ABORT_TIMEOUT_MS = 10 * 1000
/** 日志上限: 超过即轮转 (V1 曾因逐条打印 delta 事件写到 209MB) */
const MAX_LOG_BYTES = 64 * 1024 * 1024

const envTimeout = Number(process.env.WATCHDOG_STALL_TIMEOUT_MS)
const STALL_TIMEOUT_MS =
  Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_STALL_TIMEOUT_MS

/** 视为"模型活着"的产出事件 (reasoning delta 也包含在内) —— V1 事件名 */
const ACTIVITY_EVENT_TYPES = new Set([
  'message.part.delta',
  'message.part.updated',
  'message.updated',
  'message.part.removed',
  'message.removed',
])

// ---------------------------------------------------------------------------
// OpenCode V2 事件 → V1 事件形状 (bridge)
//
// V2 是破坏性变更: 事件流里**不再有** `session.status` / `session.idle` /
// `message.part.delta` / `message.part.updated` / `tool.execute.*`
// (V1 那套在 V2 一个都不发; 见 opencode.exe 内的事件名表 + 实测)。
// V2 真正的生命周期信号是:
//   session.execution.started            → 忙 (≈ V1 session.status busy)
//   session.execution.succeeded/failed/
//     interrupted                        → 本轮结束 (≈ V1 session.idle)
//   session.text.* / session.reasoning.* / session.step.* /
//     session.tool.input.* / session.tool.progress / part.*
//                                        → 模型有产出 (刷新计时)
//   session.tool.called / .success / .failed
//                                        → 工具开始 / 结束 (豁免判据)
// 保留 V1 名字的兼容处理: 若事件本身就是 V1 形状, 原样放行。
// ---------------------------------------------------------------------------
const V2_BUSY_TYPES = new Set(['session.execution.started'])
const V2_IDLE_TYPES = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
])
const V2_TOOL_BEFORE_TYPES = new Set(['session.tool.called'])
const V2_TOOL_AFTER_TYPES = new Set(['session.tool.success', 'session.tool.failed'])
const V2_ACTIVITY_TYPES = new Set([
  'session.text.started',
  'session.text.delta',
  'session.text.ended',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.step.started',
  'session.step.streamed',
  'session.step.ended',
  'session.step.failed',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.progress',
  'session.compaction.started',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'part.added',
  'part.done',
])
/** 高频事件: 不逐条写日志 (只更新计时), 防日志爆炸 */
const V2_QUIET_TYPES = new Set([
  'session.text.delta',
  'session.reasoning.delta',
  'session.step.streamed',
  'session.tool.input.delta',
  'session.tool.progress',
  'session.compaction.delta',
])

/**
 * 把 V2 事件翻译成状态机认的 V1 事件形状。
 * - V1 形状(或未知事件) → 原样返回 / 标记 quiet
 * - 已知 V2 事件 → 映射到 session.status / session.idle / tool.execute.* / message.part.delta
 */
function v2EventToV1(event) {
  const type = event?.type
  if (typeof type !== 'string') return event
  // 已是 V1 形状 → 放行 (V1 版本 opencode 直接走这条)
  if (
    type === 'session.status' ||
    type === 'session.idle' ||
    type === 'session.deleted' ||
    type.startsWith('tool.execute.') ||
    ACTIVITY_EVENT_TYPES.has(type)
  ) {
    return event
  }
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  const info = data.info && typeof data.info === 'object' ? data.info : undefined
  const sessionID = firstString(data.sessionID, info?.sessionID, info?.id)
  const properties = { sessionID }
  if (V2_BUSY_TYPES.has(type)) {
    return { type: 'session.status', properties: { ...properties, status: { type: 'busy' } } }
  }
  if (V2_IDLE_TYPES.has(type)) {
    return { type: 'session.idle', properties }
  }
  if (V2_TOOL_BEFORE_TYPES.has(type)) {
    return { type: 'tool.execute.before', properties: { ...properties, tool: firstString(data.tool, data.name) } }
  }
  if (V2_TOOL_AFTER_TYPES.has(type)) {
    return { type: 'tool.execute.after', properties: { ...properties, tool: firstString(data.tool, data.name) } }
  }
  if (V2_ACTIVITY_TYPES.has(type)) {
    return { type: 'message.part.delta', properties, __quiet: V2_QUIET_TYPES.has(type) }
  }
  if (type === 'session.deleted') {
    return { type: 'session.deleted', properties }
  }
  // 其它 V2 事件(plugin.added / catalog.updated 之类) → 不影响状态机, 也不刷日志
  return { ...event, __quiet: true }
}

function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* debug 日志失败不阻塞插件 */
  }
}

/** 日志过大即轮转 (保留"轮转过"证据行), 避免 209MB 那种不可读日志 */
function rotateLogIfHuge() {
  try {
    if (statSync(DEBUG_LOG).size > MAX_LOG_BYTES) {
      writeFileSync(DEBUG_LOG, `[${new Date().toISOString()}] LOG_ROTATED (previous > ${MAX_LOG_BYTES} bytes)\n`)
    }
  } catch {
    /* 文件不存在等 → 忽略 */
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
    // 高频事件(逐 token delta)不逐条写日志, 否则日志会膨胀到几百 MB
    if (event?.__quiet !== true) log(`EVENT type=${type ?? '(none)'}`)
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
      // 本轮结束 ⇒ 不可能还有工具在执行; 顺手归零, 防 success/failed 事件
      // 缺失 (如会话被中断) 导致 toolDepth 永久 >0 把该会话一直豁免计时
      if (state.toolDepth !== 0) {
        log(`TOOL_DEPTH_RESET sessionID=${sessionID} from=${state.toolDepth} (turn ended)`)
        state.toolDepth = 0
      }
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

/** V1 入口的中断实现: `client.session.abort` (两参 hook 时代) */
function makeV1Abort(client) {
  return async (sessionID, timeoutMs) => {
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
  }
}

/**
 * V2 入口的中断实现: `ctx.session.interrupt({ sessionID, continue: false })`
 * V2 删掉了 `session.abort`; `continue:false` = 中断后不自动续跑。
 */
function makeV2Abort(ctx) {
  return async (sessionID, timeoutMs) => {
    if (!ctx?.session?.interrupt) {
      debugLog(`WATCHDOG_ABORT_SKIP sessionID=${sessionID} reason=no-ctx-session`)
      return false
    }
    try {
      return await Promise.race([
        ctx.session.interrupt({ sessionID, continue: false }).then(
          () => true,
          (error) => {
            debugLog(`WATCHDOG_ABORT_FAIL sessionID=${sessionID} error=${String(error)}`)
            return false
          },
        ),
        new Promise((resolve) => {
          setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } catch (error) {
      debugLog(`WATCHDOG_ABORT_EXCEPTION sessionID=${sessionID} error=${String(error)}`)
      return false
    }
  }
}

/**
 * OpenCode V2 入口。default export 必须是带 id + (setup|effect) 的 definition,
 * 否则拒载: "Plugin must export a default definition with an id and an effect
 * or setup function"。V2 事件先经 v2EventToV1() 翻译, 再喂同一个状态机。
 *
 * 关于重复订阅 (实测结论):
 *   - V2 会为同一进程内的多个(会话级)插件实例各调一次 setup (实测 46 次)
 *   - 每个实例的 ctx.event.subscribe() 都收到**全量**进程事件 (实测同事件 5 份),
 *     且**无法去重** (各订阅拿到的是不同对象副本; 实测 WeakSet 无效)
 *   - 订阅随实例失效而失效 (实测复用旧订阅会静默收不到事件) → 只能每个 setup
 *     都订阅新流
 *   后果: 卡死时可能有 N 个实例各 abort 一次 —— interrupt 幂等, 无害。
 */
const plugin = {
  id: 'opencode-watchdog',

  setup: async (ctx) => {
    rotateLogIfHuge()
    debugLog(
      `setup() STARTED ${MARKER} stallTimeoutMs=${STALL_TIMEOUT_MS} abortTimeoutMs=${ABORT_TIMEOUT_MS} enabled=${ENABLED}`
    )
    if (!ENABLED) {
      debugLog('setup() DISABLED (ENABLED=false)')
      return
    }
    const watchdog = createWatchdog({ abort: makeV2Abort(ctx) })
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          await watchdog.handleEvent(v2EventToV1(event))
        }
      } catch (error) {
        if (!controller.signal.aborted) debugLog(`SUBSCRIBE_ERROR error=${String(error)}`)
      }
    })()
    debugLog('setup(): subscribed to event stream')
    // 清理函数: 插件实例卸载时停止订阅
    return () => controller.abort()
  },

  /**
   * OpenCode V1 入口 (旧版 opencode): 返回 hooks 对象。V2 不再调用它,
   * 保留只为兼容 V1 —— 与 OCM 的双入口做法一致。
   */
  server: async ({ client }) => {
    rotateLogIfHuge()
    debugLog(
      `server() STARTED ${MARKER} stallTimeoutMs=${STALL_TIMEOUT_MS} abortTimeoutMs=${ABORT_TIMEOUT_MS} enabled=${ENABLED}`
    )
    const watchdog = createWatchdog({ abort: makeV1Abort(client) })
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
export { createWatchdog, v2EventToV1 }