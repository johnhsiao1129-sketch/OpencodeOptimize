# experience-reviewer — OpenCode 会话经验回顾插件 (mission 161, v2.0)

## 解决什么问题
对话中产生的**可复用经验**（一句话规则 / 多行使用规范）随会话结束而丢失。
本插件周期性回顾会话上下文，自动把可沉淀内容留存：
- **简单经验**（一句话能说明白，如"你叫老吴"、"不准直接修改 db"）→ 写入 AGENTS.md
  （项目级 `<项目根>/AGENTS.md`；带 `scope:"global"` 的写全局 `~/.config/opencode/AGENTS.md`）
- **复杂经验**（需要多行才能说明白的可复用知识/流程）→ 经 **OCM HTTP API** 写入 OCM 经验库
  （API 未就绪时留 stub，仅记 `EXP_COMPLEX_API_NOT_READY` 日志，不推进 cursor 以便重试）

## v2.0 架构（subagent 模式，主 agent 零中断）
v1.0 用 `messages.transform` 直接向主会话注入回顾指令——验证可行，但会打断主 agent 节奏。
v2.0 改为 **hook 只做触发检测，总结由独立 subagent 进程完成**：

```
[主会话]                          [独立进程]
hook 检测到 轮次/时间 触发 ──→  spawn `opencode run --pure` (subagent)
                                    │
├─ 读 opencode.db 未总结消息（cursor 增量）
                                     ├─ 提示词要求输出 JSON: {"simple":[...],"complex":[...]}
                                    ├─ 解析结果
                                    └─ 简单经验→AGENTS.md | 复杂经验→OCM HTTP API(stub)
```

- **cursor 文件**：每项目 `<项目根>/.experience-reviewer/experience-cursor.json`（插件自有目录，启动时自动创建），记录 `{lastMessageId, lastReviewAt, lastReviewRound, userCount, roundsSince, timeSinceMs}`
- **数据源**：直读 opencode 官方库（`~/.local/share/opencode/opencode.db`，env `EXP_OPENCODE_DB_PATH` 可覆盖），
  不依赖 OCM 插件。三表：`session`（directory 匹配项目根 + `parent_id IS NULL` 排除 subagent 子会话）、
  `message`（`json_extract(data,'$.role') IN ('user','assistant')`，cursor 用 `time_created` 毫秒 epoch）、
  `part`（`type='text'` 分区拼文本，工具调用/think 分区天然排除）
- **轮次聚合（v2.1）**：`groupIntoTurns` 把 cursor 之后的全部新消息按"轮次"分组——连续 user 消息合并为
  一次发言、连续 assistant 消息合并为一次回复，`user段+assistant段` 才算一个**完整轮次**；
  孤儿 assistant（无前置 user 的回复尾巴）丢弃、尾部悬挂 user（无回复）不交付；
  cursor 只推进到**最后一个完整轮次末尾**（不吞半截对话）
- **cursor 兼容**：`lastMessageId`（`msg_xxx`）与 opencode.db `message.id` 同源 → 从 memory.db 切换零迁移
- **只读安全**：`readOnly` 打开 WAL 库，与运行中的 opencode 并发读无锁冲突；7GB 库读打开开销极小
- **subagent 纯净模式**：`opencode run --pure <prompt>`（prompt 文本直接作为 positional message；不加载外部插件/无 MCP），
  binary 优先 npm 全局 exe（`.../npm/node_modules/opencode-ai/bin/opencode.exe`），避免 shell 转义中文。
  ⚠️ 勿用 `-f` 传输入：当前 opencode 的 `-f/--file` 是"附加文件到消息"而非"从文件读 prompt"，只传 `-f` 不传 message 会报 `You must provide a message or a command`
- **简单经验写入**：去重 + 20KB 上限（`MAX_MD_BYTES`），超限跳过并告警（原因同 v1，见 §"为什么 20KB"）
- **复杂经验失败**：OCM API 未就绪 → 不更新 cursor，下次回顾重试；API 就绪后替换两个 stub
  （`storeComplexExperience` / `queryExperiences`，返回格式与 MCP `experience_store`/`experience_query` 一致）

## 工作机制

### 触发（双触发，任一先满足 → fireReview；触发后两种计时器同时重置）
| 触发 | 条件 | 默认 |
|---|---|---|
| 轮次 | 距上次回顾 ≥ `ROUND_INTERVAL` 轮用户消息 | 3 轮 |
| 时间 | 距上次回顾 ≥ `TIME_INTERVAL_MS` | 10 分钟 |

- `handleTransform` 只做检测（**不注入任何 part**），检测到触发后**异步** fireReview（`reviewInFlight` 防并发）
- 子代理会话（含 `OMO_INTERNAL_INITIATOR`）→ 跳过，防污染/防循环

### 回顾执行链路（fireReview）
1. 读 cursor（`<项目根>/.experience-reviewer/experience-cursor.json`，无则全量）→ `readUnsummarizedMessages`
   （`directory` 匹配 + `parent_id IS NULL` + role 过滤 + `time_created > cursor`）→ `groupIntoTurns`
   按轮次聚合，只保留完整轮次（user段+assistant段），prompt 超长时按轮次从尾部截断
2. 构建 subagent 提示词（prompt 文本，非临时文件）→ `spawn opencode run --pure <prompt>`
3. 解析输出 JSON：`{"simple":[{"scope":"project|global","text":"..."}],"complex":[...]}`
4. 简单经验 → `writeSimpleEntries`（AGENTS.md 去重+上限）；复杂经验 → `storeComplexExperience` stub
5. 全部成功 → 更新 cursor；任何失败 → 不更新（下次重试）

## 为什么 AGENTS.md 上限取 20KB（50KB 的问题）
50KB 能放 ≈1000-1500 条一句话规则，折合约 1.5万-2.5万 token。但 AGENTS.md **每轮对话全量注入**
system prompt：50KB = 每轮固定吃掉 1.5万-2.5万 token 上下文，8k 上下文模型直接不可用，大上下文
模型也是持续成本。20KB ≈ 400-600 条短规则 ≈ 0.7万-1万 token/轮，实际积累量级足够，是合理折中。

## 注册（已完成，见根 README §4；v2 无需改配置——plugin id/路径不变）
```jsonc
"plugin": [
  "D:/AI/my_programs/OpencodeOptimize/experience-reviewer/index.js"
]
```

## 配置
| 项 | 默认 | 说明 |
|---|---|---|
| `ENABLED`（代码内常量） | `true` | 改 `false` 整体禁用 |
| `EXP_REVIEW_ROUND_INTERVAL`（环境变量） | 3（轮） | 轮次触发阈值 |
| `EXP_REVIEW_TIME_INTERVAL_MS`（环境变量） | 600000（10 分钟） | 时间触发阈值 |
| `EXP_REVIEW_MAX_MD_BYTES`（环境变量） | 20480（20KB） | AGENTS.md 上限，超限跳过+告警 |
| `EXP_REVIEW_MODEL`（环境变量） | `opencode/big-pickle` | subagent 模型（`opencode run -m <model>`）。⚠️ 勿清空：无 `-m` 时 opencode 默认解析会选中不可用的 `nvidia/moonshotai/kimi-k3` 导致 subagent 挂起 |
| `EXP_REVIEW_MAX_MESSAGES`（环境变量） | 200 | SQL 防御上限；cursor 之后**全部**新内容都应提取，超出部分按完整轮次截断 |
| `EXP_REVIEW_TIMEOUT_MS`（环境变量） | 120000（2 分钟） | subagent 超时 |

## 调试日志
`%TEMP%\experience-reviewer.log`

关键行：`server() STARTED`（已加载）、`TRIGGER sessionID=... roundHit=... timeHit=...`
（触发回顾，roundHit=true / timeHit=true）、`REVIEW_START project=... db=...`（开始回顾）、
`REVIEW_SKIP`（无新消息）、`REVIEW_PARSE ok=...`（subagent 输出解析成功/失败/超时）、
`MD_WRITE scope=... path=...`（AGENTS.md 落盘）、`EXP_COMPLEX_API_NOT_READY`（OCM API stub）、
`REVIEW_DONE`（cursor 已更新）、`MD_FULL`（超限跳过）。

## 验证方法
1. **已加载**：重启 opencode 后 `%TEMP%\experience-reviewer.log` 首行 `server() STARTED [experience-reviewer]`
2. **触发**：对话 ≥3 轮后 log 出现 `TRIGGER ... roundHit=true`
3. **回顾链路**：log 出现 `REVIEW_START` → `REVIEW_PARSE ok=true` → `MD_WRITE` / `REVIEW_DONE`
   （subagent 会对新消息总结；无新消息则 `REVIEW_SKIP`）
4. **复杂经验**：OCM API 就绪后，log 出现 `COMPLEX_STORED`；未就绪则 `EXP_COMPLEX_API_NOT_READY`
   （且 cursor 不推进，下次重试）
5. **单元测试**：`node --test test/experience-reviewer.test.mjs` 21/21

## 待办（OCM API 协商中）
- [ ] OCM 侧提供 `POST /experience`（写经验）与 `GET /experience`（查经验，project+global，去重用）
      ——返回格式与 MCP `experience_store`/`experience_query` 一致
- [ ] 替换 `storeComplexExperience` / `queryExperiences` 两个 stub
- [ ] 真实验证复杂经验全链路

## 状态
**v2.0 已实现（2026-09-17 数据源切换）**：单元测试 21/21 全绿（真实 node:sqlite 内存库模拟 opencode.db 三表）；
数据源已从 OCM memory.db 切换为直读 opencode.db（directory 路由 + parent_id 排除子会话 + role 过滤 +
text 分区聚合，cursor 无缝兼容）；待真实会话观察触发效果；
OCM HTTP API 未就绪（stub 已留，不影响简单经验链路）。