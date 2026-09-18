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
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatchdog } from '../index.js'

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