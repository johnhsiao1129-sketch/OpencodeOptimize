# task-context-injector — OpenCode 子代理上下文注入插件 (v3)

## 解决什么问题
弥补 opencode **子代理上下文隔离**问题（`OPENCODE_PERFORMANCE_GAP.md` §三.1）。
父代理调用 `task` 工具派发子代理时，向子代理实际收到的 LLM 消息中注入"派活交接规范"：要求补齐项目/业务背景 + 约束输出结构。

## 工作机制
单个 hook：`experimental.chat.messages.transform`（改 `output.messages`，即将发给 LLM 的消息数组）。

- **为什么不用 tool.execute.before mutation（v1/v2 教训）**：before-hook 对插件工具会触发，但 `output.args.prompt` 的 mutation **不传播**给 execute()——插件工具经 schema 校验产生另一份 args 对象，写入丢失。实测：INJECTED 日志 promptLen=75->514，但子代理实际只收到 107 字符（无注入）。
- **注入目标识别**（子代理 vs 主会话）：
  1. 白名单：`tool.execute.after` 从 task 工具返回的 `<task_metadata>` 捕获子代理会话 ID
  2. 内容启发式：OMO 派发任务时给 prompt 末尾追加 `<!-- OMO_INTERNAL_INITIATOR -->`，裸 prompt 含标记 + 不含 system-reminder → 判定子代理初始化消息
- 任一命中即注入；记录 `injectedSIDs` + 消息内 MARKER 防重复注入。

## 注册（已在 opencode.jsonc）
```jsonc
"plugin": [
  "D:/AI/my_programs/OpencodeOptimize/task-context-injector/index.js"
]
```

## 配置
| 项 | 默认 | 说明 |
|---|---|---|
| `ENABLED`（代码内常量） | `true` | 改 `false` 整体禁用 |
| `OMO_INITIATOR` | `OMO_INTERNAL_INITIATOR` | OMO 派发标记，如 OMO 改版需同步 |

## 调试日志
`%TEMP%\task-context-injector.log`（Windows: `C:\Users\<user>\AppData\Local\Temp\task-context-injector.log`）

关键行：`INJECTED sid=... promptLen=...->...`（注入成功）、`SKIP ...`（未命中识别规则，正常）。

## 验证方法
1. **生效**：派发任意 `task` → 子代理回复中出现"派活交接规范"相关字样（"项目背景"/"输出结构"）→ hook 已触发且注入被 LLM 看到
2. **日志**：`%TEMP%\task-context-injector.log` 出现 `INJECTED` 行
3. **不重复注入**：同子代理会话只注入一次（日志只有一行该 sid）

## 状态
v3 `messages.transform` 版已实现（复用 OMO team-mailbox-injector 生产验证机制）。