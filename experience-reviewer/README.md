# experience-reviewer — OpenCode 会话经验回顾插件 (mission 161, v2.3)

## 解决什么问题
对话中产生的**可复用经验**（一句话规则 / 多行使用规范）随会话结束而丢失。
本插件周期性回顾会话上下文，自动把可沉淀内容留存：
- **简单经验**（一句话能说明白，如"你叫老吴"、"不准直接修改 db"）→ 写入项目 AGENTS.md
  （`<项目根>/AGENTS.md`；**v2.2 起全部写项目**，疑似全局条目加 `[建议全局] ` 前缀，
  由主 agent 当面向用户确认后迁全局，不再由 subagent 直写全局）
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
                                     ├─ 提示词要求输出 JSON: {"simple":[{"scope":"project","text":"...","suggestGlobal":false}],"complex":[...]}
                                    ├─ 解析结果
                                    └─ 简单经验→项目 AGENTS.md ([建议全局] 标记) | 复杂经验→OCM HTTP API(stub)
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
- **简单经验写入（v2.2）**：全部写项目 `<项目根>/AGENTS.md`；疑似全局条目（`suggestGlobal=true`）
  加 `[建议全局] ` 前缀，等主 agent 当面向用户确认后迁全局（规则见全局 AGENTS.md）；去重 + 20KB 上限
  （`MAX_MD_BYTES`），超限跳过并告警（原因同 v1，见 §"为什么 20KB"）
- **提取排除规则（v2.2）**：subagent 提示词内置硬排除——能从代码/文档推导的信息、当次任务一次性安排、
  特定 skill/领域专属经验（如 job-hunter 判岗、画图风格）、已存过/高度相似内容，一律不提取；
  归属拿不准默认 project，不猜全局
- **项目概述提醒（v2.2）**：`server` 层追加 `ensureOverviewReminder`——读 `<项目根>/AGENTS.md` 前 50 行，
  匹配 `> **项目概述**: ` 标记（顶部首行格式）；缺 → 向主 agent 注入一次提醒（cursor `overviewPrompted`
  防刷屏），补写后验证到 → cursor `hasOverview=true` 永久停；**禁用 `# 标题` 判断**（全局 AGENTS.md
  首行即 `# ...` 会误判）。与 `handleTransform` 零注入职责分离
- **容量回收提醒（v2.3，v2.4 调整为 100）**：条数 ≥ `RECYCLE_THRESHOLD`（100）时向主 agent 注入压缩指令，目标
  `Math.floor(100 × RECYCLE_TARGET_RATIO)` = 60 条（比例常量可调，不写死数字）。
  **代码判据只有一条：`count >= RECYCLE_THRESHOLD` 就提醒，无基线、无同值静默、无回落重置**，
  达标期间每轮都提醒。**注入正文只报两样：当前状态（已达 N 条）+ 目标状态（压到 M 条以内）**，
  不向上下文暴露上限数值、不设完成判据——`RECYCLE_THRESHOLD` 纯属插件内部触发线。
  正文另给 **7 个可判定清理方向**（不符合存储门槛 / 已解决 / 重复同义 / 作用域错位 /
  同一主题拆多条 / 低频占常驻 / 依赖环境已变化）+ 正向声明的门槛白名单 + 硬约束
  （删系统文件前先问用户、完成后回报条数变化与分类计数）。限流靠「最新一条必须是 user 消息」，一轮最多注入一次。
  ⚠️ 已修 bug，勿加回：v2.3 前用 cursor `recyclePromptedCount` 存「上次提醒时的条数」做同值静默，
  回落重置时又把基线写成当前值 → 清理到仍超上限时被自己锁死永久静默
- **⚠️ 不拦截写入（v2.4，勿加回）**：v2.3 曾让 `buildSubagentPrompt` 在达上限时**禁止 subagent 新增**
  （simple 强制空数组，改输出 `prune` 清单）。该机制**已整体移除**，理由有二：
  ① 清理设计本就是「给一套 7 条规则，主 agent 自行判断」，不需要另一条产出清单的旁路；
  ② `prune` 字段解析出来后从未被任何消费点使用，属死功能。
  现在 `buildSubagentPrompt` 的容量行**只作参考、不限制提取**——达上限后 subagent 仍正常输出 simple，
  清理与新增并行不悖（超上限期间新经验继续入库，主 agent 同时被提醒压缩）。
  真正的写入硬上限只有 `EXP_REVIEW_MAX_MD_BYTES`（20KB，防上下文爆炸），与条数无关。
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
3. 解析输出 JSON：`{"simple":[{"scope":"project","text":"...","suggestGlobal":false}],"complex":[...]}`；
   scope 一律归一为 project，旧 `scope:"global"` 与 `suggestGlobal:true` 归一为 suggestGlobal（不再直写全局）
4. 简单经验 → `writeSimpleEntries`（全部写项目 AGENTS.md，suggestGlobal 加 `[建议全局] ` 前缀，去重+上限）；
   复杂经验 → `storeComplexExperience` stub
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
| **按项目开关**（`<项目根>/.experience-reviewer/config.json`） | 无文件=开 | `{"enabled": false}` 关闭本项目提取（避免无价值项目白烧 subagent token；即使 cache 命中 99% 也非免费）。缺省/损坏=开，不误伤 |
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
`MD_WRITE path=...`（AGENTS.md 落盘，v2.2 只写项目路径）、`OVERVIEW_OK` / `OVERVIEW_REMINDER`
（项目概述检测/注入）、`EXP_COMPLEX_API_NOT_READY`（OCM API stub）、
`REVIEW_DONE`（cursor 已更新）、`MD_FULL`（超限跳过）。

## 验证方法
1. **已加载**：重启 opencode 后 `%TEMP%\experience-reviewer.log` 首行 `server() STARTED [experience-reviewer]`
2. **触发**：对话 ≥3 轮后 log 出现 `TRIGGER ... roundHit=true`
3. **回顾链路**：log 出现 `REVIEW_START` → `REVIEW_PARSE ok=true` → `MD_WRITE` / `REVIEW_DONE`
   （subagent 会对新消息总结；无新消息则 `REVIEW_SKIP`）
4. **项目概述**：项目 AGENTS.md 缺 `> **项目概述**: ` 首行时，log 出现 `OVERVIEW_REMINDER injected once`
   （只注入一次；补写后下轮 `OVERVIEW_OK hasOverview=true` 永久停）
5. **复杂经验**：OCM API 就绪后，log 出现 `COMPLEX_STORED`；未就绪则 `EXP_COMPLEX_API_NOT_READY`
   （且 cursor 不推进，下次重试）
6. **单元测试**：`node --test test/experience-reviewer.test.mjs` 70/70

## 待办（OCM API 协商中）
- [ ] OCM 侧提供 `POST /experience`（写经验）与 `GET /experience`（查经验，project+global，去重用）
      ——返回格式与 MCP `experience_store`/`experience_query` 一致
- [ ] 替换 `storeComplexExperience` / `queryExperiences` 两个 stub
- [ ] 真实验证复杂经验全链路

## 状态
**v2.2 已实现（2026-09-28 分类防污染）**：
- v2.0（2026-09-17）：数据源切换，直读 opencode.db（directory 路由 + parent_id 排除子会话 + role 过滤 +
  text 分区聚合，cursor 无缝兼容）
- v2.2（2026-09-28）：取消 subagent 直写全局——simple 全部写项目 AGENTS.md，疑似全局加 `[建议全局] ` 前缀，
  由主 agent 当面向用户确认迁全局（全局 AGENTS.md 已加确认规则）；提示词内置硬排除规则（代码可推导/
  一次性安排/skill 专属/已存过 不提取）；新增项目概述机制（`> **项目概述**: ` 首行标记，缺则提醒一次，
  补写后永久停）；单元测试 52/52 全绿（真实 node:sqlite 内存库模拟 opencode.db 三表）
- v2.3（2026-09-28）：容量回收机制——`RECYCLE_TARGET_RATIO = 0.6` 动态算出压缩目标，
  回收提醒正文升级为 7 个可判定清理方向 + 正向门槛白名单 + 硬约束（替换原"无用/重复"模糊表述）；
  代码判据简化为「超过上限就提醒」，删除会锁死自身的 cursor 条数基线；注入正文只报当前状态与
  目标状态，不暴露上限、不设完成判据；单元测试 70/70 全绿，bun smoke 5/5
- v2.4（2026-09-28）：上限 50 → **100**（目标自动 60）；**移除达上限禁止新增机制**——`buildSubagentPrompt`
  容量行改为只作参考不限制提取，删掉 `prune` 字段的提示、解析与 schema 声明（清理设计是「给 7 条规则、
  主 agent 自行判断」，不需要旁路产出清单）。单测 70/70 全绿、bun smoke 5/5
OCM HTTP API 未就绪（stub 已留，不影响简单经验链路）。