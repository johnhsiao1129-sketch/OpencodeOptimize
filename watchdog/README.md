# watchdog — OpenCode 看门狗插件 (mission 162)

## 解决什么问题
治 opencode **"数小时卡 Thinking"**（[#48675](https://github.com/sst/opencode/issues/48675) / [#49033](https://github.com/sst/opencode/issues/49033) 的插件级缓解）。
会话显示 busy 但模型长时间无产出、无工具在执行 → 判定卡死 → 自动 `abort` 中断并释放会话。

## 工作机制
单个 `event` hook 状态机，三层判定**缺一不可**才 abort：

| 层 | 判定 | 事件 |
|---|---|---|
| 状态层 | 会话确实在跑 | `session.status` = busy |
| 产出层 | 连续 `STALL_TIMEOUT_MS` 无模型产出 | `message.part.delta` / assistant `part.updated`（reasoning delta 也刷新 → 长思考不误杀） |
| 活动层 | 无未配对的工具执行 | `tool.execute.before` 未配 `after` 则豁免（等第三方返回不误杀） |

- 幂等：每 session 只 abort 一次
- abort 用 Promise.race 10s 超时保护（OMO abortWithTimeout 同款）
- 事件解析照抄 OMO `resolveSessionEventID` / `resolveMessageEventSessionID`

## 注册（已在 opencode.jsonc）
```jsonc
"plugin": [
  "D:/AI/my_programs/OpencodeOptimize/watchdog/index.js"
]
```

## 配置
| 项 | 默认 | 说明 |
|---|---|---|
| `ENABLED`（代码内常量） | `true` | 改 `false` 整体禁用，无需删插件 |
| `WATCHDOG_STALL_TIMEOUT_MS`（环境变量） | 15 分钟 | 无产出多久判定卡死；验证/调试时可调低 |

## 调试日志
`%TEMP%\watchdog.log`（Windows: `C:\Users\<user>\AppData\Local\Temp\watchdog.log`）

关键行：`server() STARTED`（已加载）、`EVENT type=...`（事件流在跑）、`WATCHDOG_ABORT sessionID=... stalledMs=...`（触发了一次中断）、`WATCHDOG_ABORT_RESULT ok=true`（abort 调用成功）。

## 验证方法
1. **已加载**：重启 opencode 后 `%TEMP%\watchdog.log` 首行有 `server() STARTED [watchdog] ... enabled=true`
2. **事件流在跑**：正常对话后 log 出现持续 `EVENT type=message.part.delta` 等
3. **卡死链路**（验证脚本）：`scripts/check-watchdog.ps1` 检查上述状态
4. **全链路**（不依赖真实模型，见经验 `6e39110d`）：假 LLM server 造卡死 → `WATCHDOG_ABORT stalledMs=30026` → 会话 idle

## 状态
**已实现 + 真实验证通过（2026-09-15）**：单元测试 7/7；真实环境验证卡死 30s abort 链路 + 流式 delta 33s+ 不误杀 + 抗噪音（tui.toast 事件不刷新计时）。