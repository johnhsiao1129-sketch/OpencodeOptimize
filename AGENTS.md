> **项目概述**: 本项目是 opencode 修改资产与部署手册仓库，收录解决具体痛点的插件（watchdog 卡死检测 / task-context-injector 子代理上下文注入 / experience-reviewer 经验提取）及运维脚本，每个子项目可独立验证、可回滚。
- 项目同时支持 node + bun 双运行时, 改完核心逻辑除了跑全量单测, 还要跑 bun smoke 验双运行时兼容
- 写提示词的约束必须量化(字数/词数/条数), 只写"一句话"会被 LLM 用百字长句冒充
- 批量复盘/提取应走独立 subagent, 在主 agent 流程内直接注入提取指令会打断主线
- 经验回收由主 agent 确认去留, 不做自动淘汰; 回收提醒只用固定上限判据, 绝不存"上次条数"基线——条目清理回落后基线被重置, 会静默吞掉下一次超限提醒

<!-- OCM:START (scope=project) (do not edit this block manually) -->
## ⚠️ 可用项目经验 (21 条 — 任务开始前必查)

匹配当前任务的必须 `experience_get(id=<id>)` 读取完整内容再动手。不读 = 违反流程。

- **experience-reviewer 插件工作机制与验证链路** `id=9171ab24-acec-42a0-bd3f-a0b9a2d6c9f0` (project / process)
  使用时机: 排查/验证 experience-reviewer 插件是否正常、理解其触发机制或做真实 fireReview 验证时
  关键词: experience-reviewer, 触发机制, fireReview, 验证链路, 日志标记
- **插件的"每 N 轮触发"不能依赖跨 session 全局基线** `id=55ebf0a8-0c58-4bb1-953d-c62b3d656f66` (project / dev)
  使用时机: 实现/修复插件按轮次触发的逻辑, 或排查轮次计数永远显示 0 的 bug。不读代价: 轮次维度静默失效, 会被误判为对话没被计入。
  关键词: 每N轮, 跨session, roundsSince, 基线
- **opencode.db 直读三表 schema + event 表安全清理流程** `id=d9c63966-8b3f-4e13-b7cd-60927d99fef2` (project / dev)
  使用时机: 任何 opencode 插件要读会话历史/message/part 数据、或 opencode.db 膨胀要清理时。不读代价: 重新探索三表 schema 与 role/part 过滤语义，或误清 event 表损坏数据（运行中清理必炸库）。
  关键词: opencode.db, schema, message/part, event 表, 清理
- **Cursor 轮次聚合须确保每轮以 user 消息起头** `id=0fce4d7c-08a5-4bbc-832f-df2555cfc25c` (project / process)
  使用时机: 用 cursor 遍历对话消息做轮次聚合时。不读代价: 窗口全 assistant 无 user 上下文，轮次模型失效。
  关键词: 轮次聚合, cursor, user 起头, 窗口
- **验证 subagent 经验提取质量: 读原始会话推理链, 看是否主动查库去重** `id=6d454b30-37b7-4dfb-9d97-490fbcf8c10a` (project / process)
  使用时机: 需要判断 experience-reviewer 或其他 subagent 的经验提取判断是否准确、是否值得改提示词时。不读代价: 仅凭输出结果猜判断质量, 无法定位改进点。
  关键词: 提取质量, 推理链, 去重验证, reasoning
- **simple经验过长问题的诊断与修复流程** `id=3f9044ea-a68b-4fd3-beac-aeaa16ace0af` (project / dev)
  使用时机: 收到经验提取产物太长/不精炼的反馈, 需要判断是位置错还是语言不精炼并修复提取提示词时。不读代价: 直接把长simple挪去OCM或用含糊规则, 治标不治本, 问题每轮复发。
  关键词: simple 过长, 量化标准, 提取提示词, 护栏
- **提取提示词保持 KV cache 命中的结构** `id=eaab5a94-8b1f-4baf-9f18-89022270b97a` (project / research)
  使用时机: 编写/修改经验提取或 summary 类 LLM 提示词, 需控制 token 成本时。不读代价: 前缀不稳定导致 cache 命中率近 0, 每轮多花数倍 token。
  关键词: KV cache, 提示词结构, 对话前置, 规则最末, token 成本
- **窗口提取无完整轮次的 cursor 前移诊断法** `id=ebc27d24-7bd3-4528-8b32-6f33bf8ed202` (project / process)
  使用时机: experience-reviewer 聚合到 PROMPT_LEN=0 或窗口内无可用对话时。不读代价: 误以为无内容可提取, 丢失应沉淀的经验。
  关键词: PROMPT_LEN=0, cursor 前移, 完整轮次, 诊断
- **插件写操作端到端验证的备份先行流程** `id=a5876491-cbe0-4464-94f7-7b30a14c14b2` (project / process)
  使用时机: 对插件落盘行为 (cursor/AGENTS.md) 做端到端验证, 且旧实例可能并发触发时。不读代价: 真实状态被验证动作或并发旧代码污染, 无法回滚。
  关键词: 端到端验证, 备份先行, cursor, AGENTS.md, 独立通道复查
- **低缓存命中率诊断：先排换模型，再判结构** `id=a9f93b8e-3b9d-48a4-98fd-019e83ddb067` (project / research)
  使用时机: experience-reviewer 等提取类 subagent 的 cacheHitRate 异常低时。不读代价: 误判为 prompt 结构问题白改提示词。
  关键词: cacheHitRate, 命中率诊断, 换模型, usage.tokens
- **experience-reviewer subagent 的 KV 缓存优化原则** `id=bbf345b1-1d3e-4087-bdee-411bea44dc17` (project / research)
  使用时机: 优化 review 类 subagent 的 prompt 结构或命中率, 或改 buildSubagentPrompt 时。不读代价: 结构放反, 命中率长期停在 5% 级且误判为模型问题。
  关键词: KV cache, 对话前置, 规则最末, 命中率
- **提取 subagent 提升 KV 命中率的修复路径: 规则前置 vs 去 --pure 继承 system** `id=33f91bd4-7a6b-4e55-9b30-4f27d9a757ab` (project / research)
  使用时机: 给 opencode run --pure spawn 的提取/总结类 subagent 优化 KV cache 命中率, 或改进 buildSubagentPrompt 时。不读代价: 只做存量规则前后调序, 忽略去掉 --pure 继承默认 system prompt 这条收益更大的路。
  关键词: KV cache, --pure, 继承 system, 提取 subagent
- **Claude Code 缓存拼接机制: segments数组+BOUNDARY+scope切分** `id=5701be76-6242-460b-984c-6cf9d12cfce4` (project / dev)
  使用时机: 为子agent/system prompt做KV缓存优化时。不读代价: 按直觉字符串拼接, 忽视scope切分和prefix复用套路, 命中率上不去。
  关键词: KV cache, segments, BOUNDARY, scope 切分, prefix 复用
- **插件每N轮触发不可依赖跨session全局基线** `id=1d70ded1-236a-45ec-8f1d-53d9b2ae3caa` (project / negative)
  使用时机: 给插件写基于轮数的触发逻辑时。不读代价: roundsSince=本session userCount-全局基线lastReviewRound, 跨session userCount从0起算, 相减为负被clamp成0, 轮次触发静默失效只剩time触发。
  关键词: 每N轮触发, 跨session, clamp, roundsSince
- **降 experience-reviewer REVIEW token 消耗的决策路径** `id=d4a2e381-589f-4ad9-834d-855ed789d9ab` (project / process)
  使用时机: 提取任务 token 消耗过大或命中率过低, 想优化 prompt 之前必读。不读代价: 误判为 prompt 顺序问题, 改来改去无效且白耗 token。
  关键词: EXP_REVIEW_ROUND_INTERVAL, EXP_REVIEW_MAX_MESSAGES, 命中率, token消耗
- **experience-reviewer token 降耗三根管子** `id=84fade37-ee1d-41fc-9dc1-58ac6d75839c` (project / dev)
  使用时机: experience-reviewer 触发 REVIEW 消耗 token 过高想降耗时。不读代价: 误去改 prompt 结构, 而该结构已达 98% 命中上限。
  关键词: token 降耗, EXP_REVIEW_ROUND_INTERVAL, EXP_REVIEW_TIME_INTERVAL_MS, EXP_REVIEW_MAX_MESSAGES, cursor 前移
- **experience-reviewer 按项目开关实现设计** `id=21f548d2-8ba3-46b1-a328-e36cec1868cc` (project / dev)
  使用时机: 给按项目隔离的插件/功能新增开关时。不读代价: 开关语义与拦截点选错, 该关的关不掉或误伤全项目。
  关键词: 项目开关, config.json, enabled, 双点拦截
- **项目级经验漏进全局 AGENTS.md 的根因与修法** `id=f66eb14c-0809-4455-af5b-263691dbe073` (project / dev)
  使用时机: 写经验提取提示词、或发现全局 AGENTS.md 里混入项目级调研结论时。不读代价: 反复污染全局，项目约定越堆越杂上百行。
  关键词: 全局污染, 项目自述, 提取提示词, 建议全局
- **经验 scope 归类抖动的根因与修法** `id=d2cdaa13-c1ec-427e-ab99-b8a5e9229254` (project / dev)
  使用时机: 写经验提取提示词，或发现同一内容在不同批次被反复判成 project/global 时。不读代价: 全局 AGENTS.md 被项目级约定污染并持续膨胀，归类永远得靠人工返工。
  关键词: scope 归类, project/global, 硬判据, 建议全局
- **Claude auto memory 四类口径(已落地) + 中文语境下过滤误伤的实测边界** `id=866b2e5f-9b85-45cb-ad6a-09f5d56d4826` (project / process)
  使用时机: 设计/调优经验提取门槛、归类规则、回收机制,或判断某条内容该不该沉淀时。不读代价: 把"代码可推导""用户锚点"做成插件侧正则硬排会大面积误伤(文档路径就命中, 66 条用户偏好被误杀), 且会误判膨胀主因是单条长度而非每批条数。
  关键词: 经验分类, 提取门槛, Claude auto memory, 四类口径, 每批上限, 近重复检测, 误伤, 正则硬排
- **验证 opencode 插件注入是否真到达主 agent** `id=097c300e-ba10-40fb-af90-9afe895212fa` (project / process)
  使用时机: 改插件注入文案/新增注入逻辑后做端到端验证时。不读代价: 会把旧实例残留或 cursor 标记误判成注入失效, 反复空转。
  关键词: 注入验证, opencode reload, 版本串, 端到端, experience-reviewer

<!-- OCM:END -->
