# experience-reviewer — OpenCode 会话经验回顾插件 (mission 161, v5.5)

## 解决什么问题
对话中产生的**可复用经验**（一句话规则 / 多行使用规范）随会话结束而丢失。
本插件周期性回顾会话上下文，自动把可沉淀内容留存：
- **简单经验**（一句话能说明白，如"你叫老吴"、"不准直接修改 db"）→ 写入项目 AGENTS.md
  （`<项目根>/AGENTS.md`；**v2.2 起全部写项目**，疑似全局条目加 `[建议全局] ` 前缀，
  由主 agent 当面向用户确认后迁全局，不再由 subagent 直写全局）
- **复杂经验**（需要多行才能说明白的可复用知识/流程）→ 经 **OCM HTTP API** 写入 OCM 经验库
  （API 未就绪时留 stub，仅记 `EXP_COMPLEX_API_NOT_READY` 日志，不推进 cursor 以便重试）

## 准入门槛（v5.3，2026-11-05）

### 为什么要有这一节
**恶性循环**：规范越存越多 → 每轮对话注入的 system prompt 越来越长 → token 消耗加速 →
压缩更频繁 → 每次压缩又产出好几条新规范 → 规范继续膨胀。

实测（676 条真实历史提取，135 个压缩批次）：

| 口径 | 保留条数 | token | 相对现行 |
|---|---|---|---|
| 现行（仅长度护栏） | 609 | ~17.3k | — |
| + 每批 ≤2 条 | 259 | ~7.7k | **-55.4%** |
| + 每批 ≤1 条 | 133 | ~4.0k | **-76.9%** |

**每批条数上限是最强杠杆** —— 膨胀主因不是"单条太长"，而是"条数太多"
（历史上平均每批产 5 条，最多的一批 13 条）。

### 口径来源：Claude Code auto memory
官方分类法（<https://code.claude.com/docs/en/memory>）只存四类：
`user`（用户角色/偏好）、`feedback`（用户纠正与确认）、`project`（从代码推导不出的决策）、
`reference`（外部资源位置）；并**硬排除**「能从代码/仓库推导出来的」与「CLAUDE.md 已有的」；
总判据是「这条信息在未来的对话里还用得上吗」；`MEMORY.md` 上限 200 行 / 25KB，写满即报错要求重写索引。

本插件的提示词已改成同一套口径（规则 2 列四类、规则 3 列硬排除、规则 4 宁缺毋滥 + 动态告知上限）。
规则 3 的硬排除清单里**第一条**是 v5.5 新增的「用户布置的任务/指令本身（"要我做什么" ≠ "以后怎么做"）」——
实测反面案例：用户说"异宠线用 w01 角色做 6 张 pilot"，被当成项目决策沉淀成了规范。

### 门槛执行链（`writeSimpleEntries`，按顺序）
1. **长度护栏** — ≤35 词（汉字按字、英文按单词、一个标识符算一词）且 ≤120 字符。
2. **纯代码兜底** — 整条就是一段代码 → 拒（`MD_CODE_SKIP`）。
   ⚠️ 刻意做得极窄：中文语境下用"文件路径 / snake_case 标识符 / module.attr"启发式会大面积误伤——
   实测连 `AGENTS.md` 这种文档路径都能命中，把「用户明确不迁全局也不留项」这种**用户偏好**也误杀了（66 条）。
   所以"能否从代码推导"交给**提示词侧**（模型判），插件侧不猜。
3. **近重复检测** — 2-gram Jaccard ≥ 0.55 与已有 AGENTS.md 条目 / 本批已选条目重复 → 拒（`MD_NEAR_DUP`）。
   字面去重（`existing.includes(text)`）拦不住同义改写：实测 335 条存量里检出 13 对近重复，其中 1 对 Jaccard=1.00。
4. **用户信号优先** — 带用户明确表达（用户/明确/偏好/禁止/要求…）的条目排前面。
   ⚠️ **只排序、不硬排**：硬排会误杀「V2 plugin ctx 拿项目目录用 ctx.directory」这类高价值通用技术坑
   （它们没有用户字样但值得沉淀）。排序后同样额度下留下的条目明显更好，又不丢条目。
5. **每批条数上限** — 最多写 `EXP_SIMPLE_MAX_PER_BATCH` 条（默认 **2**），超出的记 `MD_BATCH_CAP`。
   被 `MD_FULL`（AGENTS.md 满）拒绝的条目**不占额度**。
   ⚠️ 这是**上限不是目标**（v5.5 措辞修正）：`0~N 条皆可`，1 条、0 条都正常，绝不为了凑数放宽标准。
   旧措辞只写"最多输出 N 条"，实测模型连着两次都恰好给满 2 条。

## 注入点清单（v5.5，2026-11-05）

插件一共 **4 处**向模型注入文本，准入口径必须四处一致，否则会出现"写得严、清得松"或反之。

| # | 注入点 | 触发时机 | 与准入门槛的关系 | v5.5 状态 |
|---|---|---|---|---|
| 1 | `extractionInstructionForCompact` | 压缩前，把提取指令追加到 compact prompt 末尾 | **写入侧主闸门**：四类口径 + 硬排除 + `0~N` 条皆可 | ✅ v5.5 加"任务/指令不算规范"、上限措辞改 `0~N 条皆可` |
| 2 | `ensureRecycleReminder` | 自有条目数 ≥100 时（每轮 user turn） | **清理侧闸门**：清理标准必须与写入侧同一把尺子 | ✅ v5.5 同步加"用户布置的任务/指令本身"到"一律删"清单 |
| 3 | `ensureOverviewReminder` | 项目 AGENTS.md 缺 `> **项目概述**: ` 首行 | 与门槛无关（补项目自述） | ✅ 无需改 |
| 4 | `ensureSuggestGlobalReminder` | 出现 `[建议全局] ` 前缀条目时 | 与门槛无关（问用户是否迁全局） | ✅ 无需改 |

另有 `appendSyntheticText` 追加的「回归主线」锚点（每条提醒后一条）——纯防跑偏，不涉及门槛。

### ⚠️ 外部注入块不计入条目数（v5.4 修复）
`countMdEntries` 原来统计 AGENTS.md 里**所有** `- ` 开头的行，包括别的插件写入的
`<!-- XXX:START -->` .. `<!-- XXX:END -->` 注入块。两个后果：
1. **阈值判断失真** —— 实测某项目自有条目 11 条、外部块 39 条，计数却是 50；
2. **回收提醒可能让模型删掉外部块里的行** —— 那块标注了不可手改。

现在计数排除外部注入块，清理提醒也明确写了「只处理本项目自己写的条目，不要动外部注入块」。

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
- **简单经验写入（v2.2，v2.7 盖时间戳）**：全部写项目 `<项目根>/AGENTS.md`；疑似全局条目（`suggestGlobal=true`）
  加 `[建议全局] ` 前缀，等主 agent 当面向用户确认后迁全局（规则见全局 AGENTS.md）；去重 + 20KB 上限
  （`MAX_MD_BYTES`），超限跳过并告警（原因同 v1，见 §"为什么 20KB"）。
  v2.7 起落盘即盖创建戳 `- [YYYY-MM-DD] 文本`（标记 `[建议全局] ` 恒在日期之前，不破坏前缀计数），
  供「用后刷新 + 长期未用清理」判据
- **提取排除规则（v2.2，v2.6 扩展，v2.7 加规则 9）**：subagent 提示词内置硬排除——能从代码/文档推导的信息、当次任务一次性安排、
  特定 skill/领域专属经验（如 job-hunter 判岗、画图风格）、已存过/高度相似内容，一律不提取；
  v2.6 追加三类直述拒绝项（一次性描述=已交付产物写法/与项目概述 `> **项目概述**: ` 行重叠/行业平台公开知识会变）
  + 规则 7 可复用性反问（「未来会被 agent 在本项目多轮工作中反复应用吗?」不会 → 拒绝入库）；
  v2.7 追加规则 9：输出前必读项目 AGENTS.md 对照已有条目——同义不重复、矛盾不提取、同主题不加第二条，
  本批应用过的已有条目记入 `usedEntries`（返回该条目前 10 字符）→ 触发时间戳刷新；
  归属拿不准默认 project，不猜全局。⚠️ 拒绝项一律**直述字面含义**，不引用「模式 A/C/D」编号——subagent 纯净模式无该上下文
- **时间戳刷新（v2.7）**：`refreshUsageStamps` 按 `usedEntries` 命中条目行把时间戳刷为当天（旧日期替换、
  无日期插入、只改时间戳不动内容）；片段剥前缀/截 10 字/≥3 字符过滤，无命中或超 20KB 不写盘；
  失败只记日志不阻塞 cursor。漏报安全：全体显老 → 退化为粗筛，不误删
- **项目概述提醒（v2.2 → v2.5 改 persistent）**：`server` 层追加 `ensureOverviewReminder`——读 `<项目根>/AGENTS.md` 前 50 行，
  匹配 `> **项目概述**: ` 标记（顶部首行格式）；缺 → **每次 user-turn transform 都注入提醒**
  （v2.5 移除 cursor `overviewPrompted` one-shot 限制，废弃该字段——旧设计让 task() 派生的 subagent
  session 抢先触发一次后主 agent 永久收不到，与「未写入就一直提醒」的设计意图冲突），
  补写后验证到 → cursor `hasOverview=true` 永久停；**禁用 `# 标题` 判断**（全局 AGENTS.md
  首行即 `# ...` 会误判）。与 `handleTransform` 零注入职责分离
- **容量回收提醒（v2.3，v2.4 调整为 100）**：条数 ≥ `RECYCLE_THRESHOLD`（100）时向主 agent 注入压缩指令，目标
  `Math.floor(100 × RECYCLE_TARGET_RATIO)` = 60 条（比例常量可调，不写死数字）。
  **代码判据只有一条：`count >= RECYCLE_THRESHOLD` 就提醒，无基线、无同值静默、无回落重置**，
  达标期间每轮都提醒。**注入正文只报两样：当前状态（已达 N 条）+ 目标状态（压到 M 条以内）**，
  不向上下文暴露上限数值、不设完成判据——`RECYCLE_THRESHOLD` 纯属插件内部触发线。
  正文另给 **8 个可判定清理方向**（准入门槛+可复用性=事实性描述/一次性描述/与概述重叠/行业平台知识 / 已解决 / 重复同义 / 作用域错位 /
  同一主题拆多条 / 低频占常驻 / 依赖环境已变化 / 长期未用=时间戳久未刷新优先审查，v2.6 第 1 条与存储侧规则 3/7 对齐，
  v2.7 第 8 条基于时间戳、不绑 OCM）+ 正向声明的门槛白名单 + 硬约束
  （删系统文件前先问用户、完成后回报条数变化与分类计数）。限流靠「最新一条必须是 user 消息」，一轮最多注入一次。
  ⚠️ 已修 bug，勿加回：v2.3 前用 cursor `recyclePromptedCount` 存「上次提醒时的条数」做同值静默，
  回落重置时又把基线写成当前值 → 清理到仍超上限时被自己锁死永久静默
- **回归主线锚点（2026-10-27）**：`appendSyntheticText()` 在推完任何一条提醒后，**再推一条**「回归主线」
  合成 part——把用户本轮原话重述一次 + 声明「上面这条系统任务是插进来的附带项，做完回原任务」。
  动机：提醒是插件插进来的**系统子任务**，落在用户原话之后 → 模型读到的是系统任务，
  做完就停在系统任务上、忘了原任务（用户侧表现为「加完油不继续上路」）。
  实现要点：原话 = 同一条 user 消息里**非 `synthetic`** 的 text part（插件注入都带 `synthetic`）；
  锚点带 `mainline:true` 私有标记（**不用文本匹配**，避免误删用户自己写的同名字符串）；
  追加新提醒前先摘掉旧锚点 → 同回合多条提醒时**锚点始终在最后一条、且只保留一份**；
  原话超 `MAINLINE_MAX_LEN`（300）截断并提示「完整原文见本消息上文」；无原话不生成锚点。
  纯提示词，不新增文件/不改配置；每条注入多约 80 token
- **⚠️ JSON 提取解析修复（v5.1，2026-10-28，已修 bug，勿加回）**：`extractJsonBlock()` 原为
  `init` 遗留（994a6cd），隐含假设「整段文本只有一个 JSON 块」。v5 改用 **compact 摘要全文**
  （`event.data.text`）当提取输入后该假设失效：摘要正文常提到 ` ```json ` 字面量
  （如用户需求里写「末尾附 ```json 块」），首个 ``` 匹配会从正文那个字面量一路吞到真正 JSON 块的
  结束围栏 → 切出的 `{ }` 中段是散文 → `JSON.parse` 抛错**被 catch 静默吞掉** → 整批经验丢失
  （实测 v5 时代 66 次压缩丢 13 批 / 81 条；丢失原因 100% 吻合「摘要里 ```json 出现 ≥2 次」）。
  修法（改动面 = 1 个函数）：保留「首个 ``` 匹配」为**首选候选**（行为完全不变），仅当其解析失败时
  再依次尝试所有 ` ```json ` 块（从后往前）。798 个真实历史摘要全量回归：救回 14 批 85 条、
  **回归 0**、**解析结果内容变化 0**。踩坑：JS 的 `String.lastIndexOf` 只有两个参数
  （第二参是 position），照搬 Python `rfind(sub, start, end)` 三参数语义 → 索引不递减 →
  死循环 → 32s OOM；必须用 `[...text.matchAll(/```json/g)].map(m => m.index)` 一次取全部位置
- **⚠️ 条目长度口径改「词数」（v5.2，2026-10-28，已修 bug）**：v5.1 及以前代码用 `text.length > 50`
  判「超长不写盘」，而提示词写的是「≤50 字」。中文语境下模型把「50 字」理解成 **50 个汉字**，
  而 `text.length` 把每个英文字母/标点/空格各算 1 → **两把尺子，规则不可执行**：
  模型认为达标的条目（汉字仅 24~30）被代码判成 58~81 字符 → 静默丢弃。
  实测历史 299 条提取里 **117 条（39%）** 这么被丢，63 个有提取的批次里 15 个全军覆没
  （`MD_TOO_LONG` → `MD_NOOP` → `wroteFile=false`，日志上看不出失败）。
  改法：新增 `wordCount(text)` = **汉字数 + 英文单词数**（一个标识符算一词，连字符算标识符内部），
  提示词规则 1 同步改成「≤35 词」→ 提示词与代码同一把尺子，模型可自行估算。
  **35 词的依据**（374 条真实历史条目实测，配 120 字符硬顶）：
  门槛 30 → 丢弃 13.2%（纯中文条目丢 20.2%，误伤明显）；门槛 35 → 丢弃 **3.4%**
  （纯中文丢 3.6%，通过项 max token 41.2）；门槛 38 → 丢弃 2.1%（max token 43.1）。
  取 35：丢弃率比旧口径（32.4%）低一个数量级，token 预算与现状（max 39.6）持平。
  **另配 120 字符硬顶**：词数口径只数「有几个词」，对无空格长串（base64 / 长标识符 / 整段代码）
  会算成 1 个词而放行；374 条真实样本实测最长英文 token 仅 25 字符、词数≤35 的通过项最长 113 字符，
  故 120 硬顶在真实数据上零损失。
  **798 个真实历史摘要全量回归**：丢弃率 31.7% → **3.5%**，新放行 107 条（均为含英文的真实好经验），
  误丢 2 条（同一句重复出现），旧通过集 236 条**内容零变化**。
  环境变量：`EXP_SIMPLE_MAX_WORDS`（默认 35，替换旧的 `EXP_SIMPLE_MAX_CHARS`）。
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
3. 解析输出 JSON：`{"simple":[{"scope":"project","text":"...","suggestGlobal":false}],"complex":[...],"usedEntries":[...]}`；
   scope 一律归一为 project，旧 `scope:"global"` 与 `suggestGlobal:true` 归一为 suggestGlobal（不再直写全局）；
   `usedEntries`（v2.7）= 本批应用过的已有条目片段（剥前缀/时间戳、截 10 字、≥3 字符过滤）
4. 简单经验 → `writeSimpleEntries`（全部写项目 AGENTS.md，suggestGlobal 加 `[建议全局] ` 前缀、
   落盘盖创建时间戳，去重+上限）；复杂经验 → `storeComplexExperience` stub；
   `usedEntries` 命中 → `refreshUsageStamps` 刷新已有条目时间戳（写盘失败只记 `MD_STAMP_REFRESH` 日志，不阻塞）
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
| `EXP_SIMPLE_MAX_WORDS`（环境变量） | 35 | simple 单条词数上限（汉字按字 + 英文按单词，一个标识符算一词） |
| `EXP_SIMPLE_MAX_PER_BATCH`（环境变量） | **2** | **每次压缩最多沉淀几条**（收紧准入门槛的主杠杆；设 1 更狠；0 视为非法值回落默认） |
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
`MD_STAMP_REFRESH updated=N`（时间戳刷新命中数）、`MD_STAMP_REFRESH_SKIP`（超限跳过刷新，v2.7）、
`REVIEW_DONE`（cursor 已更新）、`MD_FULL`（超限跳过）。
v5.3 新增：`MD_BATCH_CAP cap=N`（超每批条数上限被拒）、`MD_NEAR_DUP`（近重复被拒）、
`MD_CODE_SKIP`（纯代码条目被拒）、`MD_TOO_LONG`（超长度护栏被拒）。

## 验证方法
1. **已加载**：重启 opencode 后 `%TEMP%\experience-reviewer.log` 首行 `server() STARTED [experience-reviewer]`
2. **触发**：对话 ≥3 轮后 log 出现 `TRIGGER ... roundHit=true`
3. **回顾链路**：log 出现 `REVIEW_START` → `REVIEW_PARSE ok=true` → `MD_WRITE` / `REVIEW_DONE`
   （subagent 会对新消息总结；无新消息则 `REVIEW_SKIP`）
4. **项目概述**：项目 AGENTS.md 缺 `> **项目概述**: ` 首行时，log 出现 `OVERVIEW_REMINDER injected (recurring until written)`
   （v2.5 persistent：每次 user-turn transform 都注入，不再 one-shot；补写后下轮 `OVERVIEW_OK hasOverview=true` 永久停）
5. **复杂经验**：OCM API 就绪后，log 出现 `COMPLEX_STORED`；未就绪则 `EXP_COMPLEX_API_NOT_READY`
   （且 cursor 不推进，下次重试）
6. **单元测试**：`node --test test/experience-reviewer.test.mjs` 72/72；`bun test test/bun-smoke.test.mjs` 5/5

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
  一次性安排/skill 专属/已存过 不提取）；新增项目概述机制（`> **项目概述**: ` 首行标记，缺则每次 user-turn 都提醒，
  补写后永久停；v2.5 移除 one-shot）；单元测试 52/52 全绿（真实 node:sqlite 内存库模拟 opencode.db 三表）
- v2.3（2026-09-28）：容量回收机制——`RECYCLE_TARGET_RATIO = 0.6` 动态算出压缩目标，
  回收提醒正文升级为 7 个可判定清理方向 + 正向门槛白名单 + 硬约束（替换原"无用/重复"模糊表述）；
  代码判据简化为「超过上限就提醒」，删除会锁死自身的 cursor 条数基线；注入正文只报当前状态与
  目标状态，不暴露上限、不设完成判据；单元测试 70/70 全绿，bun smoke 5/5
- v2.4（2026-09-28）：上限 50 → **100**（目标自动 60）；**移除达上限禁止新增机制**——`buildSubagentPrompt`
  容量行改为只作参考不限制提取，删掉 `prune` 字段的提示、解析与 schema 声明（清理设计是「给 7 条规则、
  主 agent 自行判断」，不需要旁路产出清单）。单测 70/70 全绿、bun smoke 5/5
- **v2.5（2026-10-01）**：项目概述提醒 one-shot → **persistent**——移除 `cursor.overviewPrompted` 字段（废弃），
  缺概述时每次 user-turn transform 都注入提醒，直到补写到 `> **项目概述**: ` 才永久停。修复 mission id=200
  根因：旧 one-shot 让 subagent session（task() 派生）抢先触发一次后，主 agent 永久收不到，与「未写入就一直提醒」
  设计意图冲突。单测 70/70 全绿（测试名更新为「v2.5 persistent」语义）、bun smoke 5/5
- **v2.6（2026-10-07）**：提取准入对齐可复用性——规则 3 追加三类直述拒绝项（一次性描述/与项目概述重叠/
  行业平台公开知识）；规则 7 追加可复用性反问（「会被 agent 多轮反复应用吗?」不会 → 拒绝入库）；
  清理提醒第 1 条同步改为「准入门槛 + 可复用性」（两侧判断口径一致）；
  拒绝项禁止引用「模式 A/C/D」编号（subagent 纯净模式看不懂）；单测 72/72 全绿、bun smoke 5/5
- **v2.7（2026-10-07）**：提取/清理双向对齐，全程零 OCM 依赖（开源通用）——
  ① 提示词加规则 9：输出前必读项目 AGENTS.md 去重（同义不重复/矛盾不提取/同主题不加第二条），
  schema 加 `usedEntries`（返回已应用条目前 10 字符）；
  ② 写入盖创建时间戳 `- [YYYY-MM-DD] 文本`（`[建议全局] ` 标记恒在日期之前，去重按原文不受戳影响）；
  ③ `refreshUsageStamps` 按 `usedEntries` 刷新命中条目为当天（无命中/超 20KB 不写盘）；
  ④ 清理方向 8 长期未用（时间戳久未刷新优先审查，不引用 memory_search/OCM）。
  单测 80/80 全绿、bun smoke 5/5
- **v5.3（2026-11-05）**：收紧准入门槛，阻断「规范累积 → token 消耗 → 压缩更频繁 → 更多规范」恶性循环——
  ① 提示词改用 **Claude auto memory 四类口径**（user / feedback / project / reference）+ 硬排除清单
     （可从代码推导 / 一次性安排 / 已交付产物写法 / 行业公开知识 / AGENTS.md 已有）+ 宁缺毋滥；
  ② 新增**每批条数上限**（默认 2，`EXP_SIMPLE_MAX_PER_BATCH`）——最强杠杆，实测 -55.4%（≤1 则 -76.9%）；
  ③ 新增**近重复检测**（2-gram Jaccard ≥0.55，种子=已有 AGENTS.md 条目 + 本批已选）；
  ④ 新增**用户信号优先排序**（不硬排，避免误杀高价值通用技术坑）；
  ⑤ 新增**纯代码兜底**（极窄，仅拦"整条就是代码"）。
  单测 72/72 全绿、bun smoke 5/5
- **v5.4（2026-11-05）**：注入点全量对齐 —— ① 回收提醒的清理标准改成与写入侧**同一把尺子**
  （Claude 四类 + 硬排除清单），"重复同义"改为按语义判（措辞不同也算同义）；
  ② `countMdEntries` **排除外部注入块**（`<!-- XXX:START/END -->`）——原统计把别的插件写的条目也算了，
  导致阈值失真（实测自有 11 条 / 外部 39 条 / 计数 50），且可能让模型去删标注了不可手改的块；
  ③ 提取指令里的条目数措辞改为"自有条目数"。
  单测 75/75 全绿、bun smoke 5/5
- **v5.5（2026-11-05）**：① 硬排除清单新增第一条「**用户布置的任务/指令本身**不算规范」
  （"要我做什么" ≠ "以后怎么做"；反面案例：用户的一句生图任务被沉淀成了项目决策）；
  ② 条数上限措辞由"最多输出 N 条"改为「**`0~N` 条皆可（N 是上限不是目标）**，1 条、0 条都正常，绝不凑数」
  ——旧措辞下模型连续两次都恰好给满 2 条；③ 清理侧同步把"用户布置的任务/指令本身"加进"一律删"清单。
  单测 75/75 全绿、bun smoke 5/5
OCM HTTP API 未就绪（stub 已留，不影响简单经验链路）。