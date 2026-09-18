/**
 * task-context-injector — OpenCode plugin (v3: messages.transform 版)
 *
 * 目的: 弥补 opencode 子代理上下文隔离 (OPENCODE_PERFORMANCE_GAP.md §三.1)。
 * 当父代理调用 `task` 工具派发子代理时, 向子代理实际收到的 LLM 消息中
 * 注入"派活交接规范": 要求子代理补齐项目/业务背景 + 约束输出结构。
 *
 * 为什么不用 tool.execute.before mutation (v1/v2 教训):
 *   tool.execute.before 对 OMO(oh-my-opencode) 这类 SDK 插件工具**会触发**,
 *   但 `output.args.prompt = ...` 的 mutation **不传播**给 execute():
 *   插件工具经 schema 校验产生另一份 args 对象, before-hook 的写入丢失。
 *   实测: INJECTED 日志 promptLen=75->514, 但子代理实际收到 107 字符无注入。
 *
 * 机制 (v3):
 *   hook `experimental.chat.messages.transform` → 直接改 output.messages
 *   (即将发给 LLM 的消息数组)。这是 OMO team-mailbox-injector 使用的
 *   生产验证机制, 对主会话和子代理会话都触发, 修改必然到达模型。
 *
 * 注入目标识别 (子代理 vs 主会话):
 *   1) 白名单: tool.execute.after 从 task 工具返回的 <task_metadata>
 *      session_id: ses_... 捕获子代理会话 ID (set)。
 *   2) 内容启发式: OMO 给每个派发任务的 prompt 末尾追加
 *      `<!-- OMO_INTERNAL_INITIATOR -->`, 主会话的该标记则出现在
 *      <system-reminder> 包装内。裸 prompt 含标记 + 不含 system-reminder
 *      → 判定为子代理会话初始化消息。
 *   上述任一命中即注入。注入后记录 injectedSIDs + 消息内 MARKER 防重复。
 *
 * 全局开关: 改 ENABLED = false 即整体禁用 (无需删插件)。
 *
 * 验证方法 (重启 opencode 后):
 *   派发任意 task → 子代理回复中出现"派活交接规范"相关字样
 *   → hook 已触发且注入内容被 LLM 看到。
 *   或查看 debug log (系统 TEMP 目录下 task-context-injector.log)。
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ENABLED = true
const MARKER = '[task-context-injector]'
const DEBUG_LOG = join(homedir(), 'AppData', 'Local', 'Temp', 'task-context-injector.log')
/** OMO 派发任务时追加到子代理 prompt 末尾的标记 (干净测试已证实) */
const OMO_INITIATOR = 'OMO_INTERNAL_INITIATOR'

/** 注入内容: 命令式 (商量语气会被 agent 当可选忽略), 核心 ≤15 行, 含后果说明 */
const INJECTION = `## ⚠️ 派活交接规范 (${MARKER})

在开始任何工作前, 先检查本任务的上下文是否完整:

1. 项目背景: 若本 prompt 未说明项目/业务背景, 先 Read 项目根 AGENTS.md (若存在); 仍不明晰时调用 ag_overview 获取项目认知。禁止在缺背景时直接动手。
2. 任务背景: 明确本任务的目标、范围边界、已完成的相关工作。若 prompt 中确实缺失, 在最终输出显式标注"背景缺失: 缺 XX", 不得编造。
3. 输出结构 (强制): 最终回复必须结构化, 按此顺序:
   - 结论 (本任务的核心产出, 一句话)
   - 证据 (涉及的文件路径 / 关键数据 / 验证结果)
   - 风险与未决问题 (如有)
   - 下一步建议 (如有)
   禁止只输出过程流水账。

后果: 缺背景直接动手 → 产出与项目实际不符, 父代理必须返工; 无结构化输出 → 父代理无法直接复用你的结果。`

/** 已注入过的子代理会话 ID (防每轮重复注入) */
const injectedSIDs = new Set()
/** tool.execute.after 捕获到的子代理会话 ID 白名单 */
const knownSubagentSIDs = new Set()

function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
  } catch {
    /* debug 日志失败不阻塞插件 */
  }
}

/** oh-my-opencode 官方 TASK_TOOLS 同款 (dist/index.js:104908) */
const TASK_TOOLS = ['task', 'call_omo_agent']

function findLastUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role === 'user') {
      return index
    }
  }
  return -1
}

function partsToText(parts) {
  return (parts ?? [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function extractSubagentSessionID(result) {
  // task 工具返回结果中形如: session_id: ses_xxx (见 <task_metadata>)
  const text = typeof result === 'string' ? result : ''
  const match = text.match(/session_id:\s*(ses_[A-Za-z0-9]+)/)
  return match ? match[1] : null
}

const plugin = {
  id: 'opencode-task-context-injector',
  server: async () => {
    debugLog('server() STARTED (v3 messages.transform)')
    return {
      'tool.execute.before': async (hookInput, output) => {
        // 仅诊断: v1/v2 已证明 args mutation 对 OMO 插件工具不传播, 此处不再注入
        const tool = hookInput?.tool ?? '(none)'
        const sid = hookInput?.sessionID ?? '(none)'
        const args = output?.args
        const argsKeys = args && typeof args === 'object' ? Object.keys(args).join(',') : `(${typeof args})`
        const promptLen = typeof args?.prompt === 'string' ? args.prompt.length : -1
        if (TASK_TOOLS.includes(tool)) {
          debugLog(`BEFORE tool=${tool} sid=${sid} args=[${argsKeys}] promptLen=${promptLen} (no mutation, v3)`)
        }
      },
      'tool.execute.after': async (hookInput, output) => {
        const tool = hookInput?.tool ?? '(none)'
        if (!TASK_TOOLS.includes(tool)) return
        const sid = hookInput?.sessionID ?? '(none)'
        // output.output = 工具返回值 (task 元数据含 session_id: ses_...)
        const result = output?.output ?? output?.result
        const childSID = extractSubagentSessionID(typeof result === 'string' ? result : JSON.stringify(result ?? ''))
        if (childSID) {
          knownSubagentSIDs.add(childSID)
          debugLog(`AFTER tool=${tool} sid=${sid} capturedSubagent=${childSID}`)
        } else {
          debugLog(`AFTER tool=${tool} sid=${sid} noSessionID (resultLen=${JSON.stringify(result ?? '').length})`)
        }
      },
      'experimental.chat.messages.transform': async (input, output) => {
        const messages = output?.messages ?? []
        if (messages.length === 0) return

        const sid = input?.sessionID ?? (typeof input?.agent === 'string' ? input.agent : '(none)')
        const agent = typeof input?.agent === 'string' ? input.agent : '(none)'

        // 防重复 1: 消息里已含 MARKER (注入内容持久化到会话历史后)
        const alreadyInjected = messages.some((message) =>
          (message?.parts ?? []).some((part) => part?.type === 'text' && part.text?.includes(MARKER))
        )
        if (alreadyInjected) return
        // 防重复 2: 会话 ID 已注入过
        if (typeof sid === 'string' && injectedSIDs.has(sid)) return

        const lastUserIndex = findLastUserMessageIndex(messages)
        if (lastUserIndex === -1) return
        const lastUser = messages[lastUserIndex]
        const userText = partsToText(lastUser?.parts)

        // 子代理识别:
        //  a) 白名单命中 (tool.execute.after 捕获过该会话)
        //  b) 内容启发式: 裸 prompt 含 OMO_INTERNAL_INITIATOR 且非 system-reminder 包装
        const isKnownSubagent = typeof sid === 'string' && knownSubagentSIDs.has(sid)
        const hasOMOInitiator = userText.includes(OMO_INITIATOR) && !userText.includes('<system-reminder')
        const isSubagentSession = isKnownSubagent || hasOMOInitiator

        debugLog(
          `TRANSFORM sid=${sid} agent=${agent} msgCount=${messages.length} ` +
          `userLen=${userText.length} isKnownSubagent=${isKnownSubagent} hasOMOInitiator=${hasOMOInitiator}`
        )

        if (!ENABLED || !isSubagentSession) return

        // 注入: 追加一个 synthetic text part 到最后一条 user 消息
        // (synthetic: true 是 opencode 注入消息的标准标记, team-mailbox 同款)
        lastUser.parts.push({ type: 'text', text: `\n\n${INJECTION}`, synthetic: true })
        if (typeof sid === 'string') {
          injectedSIDs.add(sid)
        }
        debugLog(`INJECTED_TRANSFORM sid=${sid} agent=${agent} userLen=${userText.length}->${userText.length + INJECTION.length}`)
      },
    }
  },
}

export default plugin