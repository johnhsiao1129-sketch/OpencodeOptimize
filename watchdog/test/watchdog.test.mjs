/**
 * watchdog 状态机单元测试 (node:test, 零依赖)
 * 运行: node --test test/watchdog.test.mjs
 *
 * 用假 timer + 假 clock 完全控制时序, 断言四件事:
 *   1. busy + 静默超过阈值 → abort 恰好一次 (幂等)
 *   2. delta/delta 刷新 → 重置计时 → 不 abort
 *   3. busy → idle → disarm → 不 abort
 *   4. tool.execute.before 豁免 → after 恢复计时 → abort
 *   5. 工具执行中超时到期 → 不 abort (等第三方返回场景)
 *   6. 多 session 独立计时 / session.deleted 清理
 *   7. V2 事件名 → V1 形状映射 (v2EventToV1) + V2 序列端到端 (场景 8-11)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatchdog, v2EventToV1 } from '../index.js'

/** 假时钟 + 假 timer: 完全同步控制 */
function fakeDeps({ stallTimeoutMs = 1000, abortTimeoutMs = 100 } = {}) {
  let nowMs = 0
  const timers = new Set() // 存活 timer 句柄
  let nextTimerId = 1
  const aborted = [] // 每次 abort 调用的 sessionID

  return {
    deps: {
      stamp: null, // 占位
      stallTimeoutMs,
      abortTimeoutMs,
      now: () => nowMs,
      setTimer: (fn, ms) => {
        const handle = { id: nextTimerId++, fn, ms, fired: false, at: nowMs }
        timers.add(handle)
        return handle
      },
      clearTimer: (handle) => {
        timers.delete(handle)
      },
      log: () => {}, // 静默
      abort: async (sessionID, timeoutMs) => {
        aborted.push({ sessionID, timeoutMs })
        return true
      },
    },
    /** 推进时钟 + 触发到期 timer (按注册顺序) */
    advance(ms) {
      nowMs += ms
      const due = [...timers].filter((t) => !t.fired && nowMs - t.at >= t.ms)
      for (const t of due) {
        if (!timers.has(t)) continue
        t.fired = true
        timers.delete(t)
        t.fn()
      }
    },
    /** 手动触发某个类型的事件 */
    timers,
    aborted,
    get now() {
      return nowMs
    },
  }
}

// ---- 场景 1: busy + 静默超时 → abort 一次 ----
test('busy + 静默超过阈值 → abort 恰好一次', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  assert.equal(aborted.length, 0, '刚 busy 不应 abort')

  advance(1500) // 静默超过 1000ms 阈值
  assert.equal(aborted.length, 1, '静默超时应 abort')
  assert.equal(aborted[0].sessionID, 's1')

  advance(2000) // 再等更久
  assert.equal(aborted.length, 1, '幂等: 同一 session 只 abort 一次')
})

// ---- 场景 2: delta 刷新 → 不 abort ----
test('delta 刷新计时 → 静默被重置 → 不 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  advance(600) // 接近但未到阈值
  await wd.handleEvent({ type: 'message.part.delta', properties: { sessionID: 's1' } })
  advance(600) // 刷新后再等 600
  assert.equal(aborted.length, 0, 'delta 后 600ms 不应 abort')
  advance(600) // 累计 1200ms > 1000ms, 无新 delta
  assert.equal(aborted.length, 1, '刷新后再次静默超时应 abort')
})

// ---- 场景 3: busy → idle → disarm → 不 abort ----
test('busy → idle → disarmed → 不再 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  advance(500)
  await wd.handleEvent({ type: 'session.idle', properties: { sessionID: 's1' } })
  advance(2000)
  assert.equal(aborted.length, 0, 'idle 后不应 abort')
})

// ---- 场景 4: 工具执行豁免 → after 恢复计时 → abort ----
test('tool.execute.before 豁免 → after 恢复计时 → 超时仍 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await wd.handleEvent({ type: 'tool.execute.before', properties: { sessionID: 's1', tool: 'bash' } })
  advance(2000) // 工具执行中远超阈值
  assert.equal(aborted.length, 0, '工具执行中不应 abort (等第三方返回)')

  await wd.handleEvent({ type: 'tool.execute.after', properties: { sessionID: 's1', tool: 'bash' } })
  await wd.handleEvent({ type: 'message.part.delta', properties: { sessionID: 's1' } }) // 模型恢复产出
  advance(1500) // 恢复后静默超时
  assert.equal(aborted.length, 1, '工具结束 + 恢复计时后静默超时应 abort')
})

// ---- 场景 5: 工具执行 本身超时 (极端场景, v1 不杀但状态要正确清理) ----
test('tool.after 无 before 配对 → depth 不低于 0 → 不误杀后续', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await wd.handleEvent({ type: 'tool.execute.after', properties: { sessionID: 's1', tool: 'bash' } }) // 孤儿 after
  advance(1500)
  assert.equal(aborted.length, 1, '孤儿 after 不影响: 无 before 不需要豁免, 静默超时应 abort')
})

// ---- 场景 6: 不同 session 互不干扰 ----
test('多 session 独立计时互不干扰', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's2', status: { type: 'busy' } } })
  advance(1500)
  assert.equal(aborted.length, 2, '两个都静默超时 → 都 abort')
  assert.deepEqual(aborted.map((a) => a.sessionID).sort(), ['s1', 's2'])
})

// ---- 场景 7: session.deleted 清理状态 ----
test('session.deleted → 状态清理 → 不再 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } })
  await wd.handleEvent({ type: 'session.deleted', properties: { sessionID: 's1' } })
  advance(2000)
  assert.equal(aborted.length, 0, 'session 删除后不 abort')
})

// ---- 场景 8: V2 事件名 → V1 形状映射 (翻译层) ----
test('v2EventToV1: V2 事件名映射到 V1 形状 (含 quiet 标记)', () => {
  const sid = 'v2-s1'
  assert.deepEqual(v2EventToV1({ type: 'session.execution.started', data: { sessionID: sid } }), {
    type: 'session.status',
    properties: { sessionID: sid, status: { type: 'busy' } },
  })
  assert.deepEqual(v2EventToV1({ type: 'session.execution.succeeded', data: { sessionID: sid } }), {
    type: 'session.idle',
    properties: { sessionID: sid },
  })
  assert.deepEqual(v2EventToV1({ type: 'session.execution.interrupted', data: { sessionID: sid } }), {
    type: 'session.idle',
    properties: { sessionID: sid },
  })
  assert.deepEqual(v2EventToV1({ type: 'session.tool.called', data: { sessionID: sid, tool: 'bash' } }), {
    type: 'tool.execute.before',
    properties: { sessionID: sid, tool: 'bash' },
  })
  assert.deepEqual(v2EventToV1({ type: 'session.tool.success', data: { sessionID: sid, tool: 'bash' } }), {
    type: 'tool.execute.after',
    properties: { sessionID: sid, tool: 'bash' },
  })

  const delta = v2EventToV1({ type: 'session.text.delta', data: { sessionID: sid } })
  assert.equal(delta.type, 'message.part.delta')
  assert.equal(delta.properties.sessionID, sid)
  assert.equal(delta.__quiet, true, '逐 token delta 应是 quiet (不刷日志)')

  const stepEnded = v2EventToV1({ type: 'session.step.ended', data: { sessionID: sid } })
  assert.equal(stepEnded.type, 'message.part.delta')
  assert.notEqual(stepEnded.__quiet, true, '粗粒度事件仍要写日志')

  // V1 形状原样放行 (V1 版 opencode 直接走这条)
  const v1Event = { type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } }
  assert.equal(v2EventToV1(v1Event), v1Event)

  // 未知事件不影响状态机, 也不刷日志
  const unknown = v2EventToV1({ type: 'plugin.added', data: {} })
  assert.equal(unknown.__quiet, true)
})

// ---- 场景 9: V2 事件序列端到端驱动状态机 ----
test('V2 事件序列: execution.started → delta 刷新 → 静默超时 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent(v2EventToV1({ type: 'session.execution.started', data: { sessionID: 'v2' } }))
  advance(600)
  await wd.handleEvent(v2EventToV1({ type: 'session.text.delta', data: { sessionID: 'v2' } }))
  advance(600)
  assert.equal(aborted.length, 0, 'delta 刷新后 600ms 不应 abort')
  advance(600)
  assert.equal(aborted.length, 1, '刷新后静默超时应 abort')
})

// ---- 场景 10: V2 工具事件映射后仍满足豁免语义 ----
test('V2 事件序列: tool.called 豁免 → tool.success 恢复计时 → 超时 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent(v2EventToV1({ type: 'session.execution.started', data: { sessionID: 'v2' } }))
  await wd.handleEvent(v2EventToV1({ type: 'session.tool.called', data: { sessionID: 'v2', tool: 'bash' } }))
  advance(2000)
  assert.equal(aborted.length, 0, '工具执行中不应 abort (等第三方返回)')

  await wd.handleEvent(v2EventToV1({ type: 'session.tool.success', data: { sessionID: 'v2', tool: 'bash' } }))
  await wd.handleEvent(v2EventToV1({ type: 'session.text.delta', data: { sessionID: 'v2' } }))
  advance(1500)
  assert.equal(aborted.length, 1, '工具结束恢复计时后静默超时应 abort')
})

// ---- 场景 11: toolDepth 卡死自愈 (V2 中断导致 success 事件缺失) ----
test('session.idle 归零 toolDepth → 下一轮静默超时仍能 abort', async () => {
  const { deps, advance, aborted } = fakeDeps({ stallTimeoutMs: 1000 })
  const wd = createWatchdog(deps)

  await wd.handleEvent(v2EventToV1({ type: 'session.execution.started', data: { sessionID: 'v2' } }))
  await wd.handleEvent(v2EventToV1({ type: 'session.tool.called', data: { sessionID: 'v2', tool: 'bash' } }))
  advance(2000)
  assert.equal(aborted.length, 0, '工具执行中豁免')

  // 会话被中断 → 收不到 tool.success → 靠 execution.interrupted 归零 toolDepth
  await wd.handleEvent(v2EventToV1({ type: 'session.execution.interrupted', data: { sessionID: 'v2' } }))

  // 新的一轮: 若无归零, toolDepth 残留会让该会话永久豁免 → 永不 abort
  await wd.handleEvent(v2EventToV1({ type: 'session.execution.started', data: { sessionID: 'v2' } }))
  advance(1500)
  assert.equal(aborted.length, 1, 'toolDepth 归零后静默超时应 abort')
})