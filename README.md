# OpencodeOptimize

> **opencode plugins & tools that fix specific pain points** — stall detection, subagent context isolation, experience extraction.
> 解决 opencode 具体痛点的插件集:卡死检测 / 子代理上下文隔离 / 经验提取。

**本仓库 = 所有对 opencode 的修改资产 + 部署手册。**

每个子项目解决一个具体问题,并存留一份可用备份,保证:
- opencode 升级 / 换机后能第一时间恢复部署;
- 任何人拿到本仓库后,可让他的 agent 照本 README 快速布置。

---

## 1. 项目介绍 / Overview

本仓库收录一组针对 **opencode** (AI 编码助手 CLI) 具体痛点的插件与运维脚本。**每个子项目解决一个明确、可验证的问题**;所有插件都附带真实可跑的验证脚本(`node:test` 单测 + 端到端冒烟),不是 demo 代码。

### 1.1 解决的三个具体痛点

| # | 痛点 | 触发场景 | 插件方案 |
|---|---|---|---|
| 1 | **会话卡死数小时 Thinking 不退出** | `session.status=busy` 但无 `message.part.delta` / 工具调用,`session.idle` 永不触发,只能手动 Ctrl+C 释放 | `watchdog/` 监听事件流,三层判定(仅 busy 计时 / 长思考不误杀 / 等工具返回不误杀) → `WATCHDOG_ABORT` 强制 abort 释放 |
| 2 | **子代理上下文隔离导致缺背景就动手** | 派发 `task(...)` 后,子代理拿到隔离会话上下文,没有项目背景 / 输出约束就开始乱干 | `task-context-injector/` 在 `experimental.chat.messages.transform` 阶段注入"派活交接规范"(项目背景 + 输出约束 + 防误杀开关) |
| 3 | **长对话里踩的坑下次又踩** | 一个 session 跑 50+ 轮,里面发现的可复用规律下次又重新摸索 | `experience-reviewer/` 每 3 轮 / 10min 触发 subagent 提取;simple 经验写 `AGENTS.md`,complex 经验入 OCM 经验表(下次任务自动注入 prompt) |

### 1.2 设计原则

- **问题驱动**:先有真实可复现的痛点 (issue / 现场),再写代码;
- **零或轻依赖**:所有插件只用 opencode 内置 API + `node:` 原生模块;
- **可证伪**:每个子项目有独立 README 写明"验证通过" + 单测 / E2E 命令;
- **可回滚**:单文件修改 + 备份就地,恢复只需重启 opencode。

### 1.3 适用人群

- 中 / 重度 opencode 用户(日均 5+ 会话、跨项目切换、依赖子代理协助);
- 遇到上述任一痛点被卡住、官方 issue 长期未修;
- 想系统沉淀 opencode 使用经验到 `AGENTS.md` / OCM 经验库,跨 session 复用。

---

## 2. 安装 / Installation

```bash
# Prereq: Node.js 18+, opencode (npm install -g opencode-ai)

git clone https://github.com/[GITHUB_USER]/OpencodeOptimize.git [REPO_DIR]
```

把以下三个插件路径加入 opencode 全局配置 `plugin` 数组(用绝对路径,占位符替换):

```jsonc
"plugin": [
  "[REPO_DIR]/watchdog/index.js",
  "[REPO_DIR]/task-context-injector/index.js",
  "[REPO_DIR]/experience-reviewer/index.js"
]
```

全局配置路径:Windows `%USERPROFILE%\.config\opencode\opencode.jsonc` / Linux·macOS `~/.config/opencode/opencode.jsonc`。

重启 opencode,跑:

```bash
powershell -ExecutionPolicy Bypass -File scripts/check-watchdog.ps1   # Windows
# bash scripts/check-watchdog.sh                                       # Linux/macOS (if present)
```

输出 `ACTIVE` = 成功。

---

## 3. 目录结构

```
OpencodeOptimize/
├── watchdog/                   # 治"数小时卡 Thinking"：会话卡死自动 abort
│   ├── index.js                 #     插件本体（零依赖 ESM，全局 plugin 数组指向此处）
│   ├── package.json
│   ├── README.md               #     子项目说明（问题/机制/配置/验证）
│   └── test/watchdog.test.mjs  #     单元测试 7/7
├── task-context-injector/      # 治子代理上下文隔离：task 派发时注入交接规范
│   ├── index.js
│   ├── package.json
│   └── README.md
├── experience-reviewer/        # 增量提取可复用经验：每 N 轮/10min 触发 subagent 提取
│   ├── index.js                #     v2 架构: subagent + opencode.db 游标 + OCM HTTP API
│   ├── package.json
│   ├── README.md
│   └── test/
│       ├── experience-reviewer.test.mjs  # node:test 单测 45/45
│       └── bun-smoke.test.mjs            # bun 环境冒烟 5/5
├── config-backup/              # opencode 全局配置备份（脱敏版，API key 已掩码）
│   └── opencode.jsonc
├── scripts/                    # 运维/验证脚本
│   ├── check-watchdog.ps1      #     一键验证 watchdog 是否加载 + 生效
│   ├── cleanup-opencode-db.mjs #     opencode.db 瘦身 (event 表清理 + VACUUM, 有进程检测 fail-closed + 备份)
│   └── (check-watchdog 与此结构解耦，仅依赖 %TEMP%\watchdog.log)
└── README.md                   # 本手册
```

---

## 4. 子项目清单（细分子项目）

| 子项目 | 使命 | 解决什么问题 | 状态 | 子项目文档 |
|---|---|---|---|---|
| `watchdog/` | 治卡死 | 会话数小时卡 Thinking（busy 无产出无工具执行）→ 自动 `abort` 释放会话。GitHub issue #48675 / #49033 的插件级缓解 | ✅ 实现 + 真实验证通过 (2026-09-15) | [watchdog/README.md](watchdog/README.md) |
| `task-context-injector/` | 治上下文隔离 | 子代理上下文隔离导致缺背景就动手 → 派发时向子代理注入"派活交接规范"（项目/业务背景 + 输出结构约束） | ✅ v3 实现（messages.transform 机制） | [task-context-injector/README.md](task-context-injector/README.md) |
| `experience-reviewer/` | 治经验流失 | 长对话里沉淀的可复用经验没人抽取 → 每 3 轮/10min 触发 subagent 提取，simple 写 AGENTS.md，complex 入 OCM 经验表 | ✅ v2 实现（subagent + memory.db 游标 + OCM HTTP API） | [experience-reviewer/README.md](experience-reviewer/README.md) |
| `config-backup/` | 备份 | 全局配置丢失后项目内可直接恢复 | ✅ 已同步（脱敏版） | [config-backup/opencode.jsonc](config-backup/opencode.jsonc) |
| `scripts/` | 运维 | 部署后一键验证 | ✅ check-watchdog 实测通过 | — |

---

## 5. 各子项目部署步骤（详细）

### 5.1 watchdog — 卡死自动中断

**注册**（`opencode.jsonc` 的 `plugin` 数组，`<PROJECT_ROOT>` 换成实际路径）：
```jsonc
"plugin": [
  "<PROJECT_ROOT>/watchdog/index.js"
]
```

**配置**（均可选）：
| 项 | 默认 | 说明 |
|---|---|---|
| `ENABLED`（index.js 内常量） | `true` | 改 `false` 整体禁用 |
| `WATCHDOG_STALL_TIMEOUT_MS`（环境变量） | 300000（15 分钟） | 无产出多久判定卡死；验证/调试调低 |

**调试日志**：`%TEMP%\watchdog.log`（`server() STARTED`=已加载 / `EVENT type=...`=事件流在跑 / `WATCHDOG_ABORT`=触发过中断）。

**机制摘要**（防误杀三层判定，缺一不可）：
1. `session.status` = busy 才开始计时；
2. 连续 `STALL_TIMEOUT_MS` 无模型产出（`message.part.delta` / assistant `part.updated` 刷新计时，长思考不误杀）；
3. 无未配对的 `tool.execute.before`（等第三方返回不误杀）。
幂等 abort + Promise.race 10s 超时保护。

### 5.2 task-context-injector — 子代理上下文注入

**注册**：
```jsonc
"plugin": [
  "<PROJECT_ROOT>/task-context-injector/index.js"
]
```

**为什么必须用 `messages.transform`（架构约束，勿改回 before-hook）**：
`tool.execute.before` 对插件工具的 `output.args.prompt` mutation **不会传播**给 execute()（插件工具经 schema 校验另生成 args 对象，写入丢失——v1/v2 已证伪）。`experimental.chat.messages.transform` 直接改即将发给 LLM 的 `output.messages`，必然到达。

**识别子代理会话**：`tool.execute.after` 白名单捕获 task 返回的 `<task_metadata>` 会话 ID + OMO 派发标记 `OMO_INTERNAL_INITIATOR` 内容启发式；`injectedSIDs` + 消息内 MARKER 防重复注入。

**调试日志**：`%TEMP%\task-context-injector.log`（`INJECTED sid=... promptLen=...->...`=注入成功）。

### 5.3 config-backup — 配置备份

- 权威源：`C:\Users\JohnHsiao\.config\opencode\opencode.jsonc`（opencode 实际读取）
- 备份：`config-backup/opencode.jsonc`（脱敏版，明文 API key 已替换为 `${env:...}` 占位）
- 同步规则：**任何对权威源的修改（增删插件 / 改 MCP / 改 provider）后必须同步此备份。**

---

## 6. opencode 升级 / 换机后的恢复清单

### 6.1 opencode 普通升级（配置一般保留，插件路径不变）

```powershell
# 1. 重启 opencode（插件在启动时加载，升级后必须重启）
# 2. 验证插件是否仍加载：
powershell -ExecutionPolicy Bypass -File <PROJECT_ROOT>\scripts\check-watchdog.ps1
```

- ✅ `ACTIVE` → 一切正常，无需任何操作。
- ❌ `FAIL: watchdog.log not found` → 检查 §6.1-a / §6.1-b：
  - **6.1-a 版本破坏插件 API**（升级后 event 名 / hook 签名变更）→ 更新插件适配新事件 schema（先看 `%TEMP%\watchdog.log` 是否还有 `EVENT` 行，以及 opencode changelog）。
  - **6.1-b 配置被重置/覆盖** → 用 `config-backup/opencode.jsonc` 为底，填回实际 API key 与路径，覆盖权威源，重启。

### 6.2 换机 / 重装系统（全量恢复）

```powershell
# 1. 拷贝本仓库到目标机器
# 2. 设环境变量（项目不含任何明文密钥，按你的 provider 补）：
#    SILICONFLOW_API_KEY 等（参见 config-backup 中 ${env:...} 占位）
# 3. 确认全局配置存在；不存在则以 config-backup/opencode.jsonc 为底重建：
#    （填回实际路径 <PROJECT_ROOT> 为绝对路径 + 真实 API key）
# 4. 按 §2 注册两个插件 → 重启 → check-watchdog.ps1 验证 ACTIVE
```

### 6.3 恢复后必做

1. 跑一遍 §7 全部验证项；
2. 确认 `config-backup/opencode.jsonc` 与权威源一致（改过就同步）。

---

## 7. 验证方法汇总

| 验证什么 | 命令 / 方法 | 通过标准 |
|---|---|---|
| watchdog 已加载 + 事件流在跑 | `powershell -ExecutionPolicy Bypass -File scripts\check-watchdog.ps1` | 输出 `ACTIVE`，exit 0 |
| watchdog 曾触发中断 | 同上 | exit 2 + 显示 `WATCHDOG_ABORT sessionID=...`（证明卡死链路真实可用） |
| watchdog 卡死全链路（不依赖真实模型） | 假 LLM server 造卡死（见 OCM 经验 `6e39110d`） | `WATCHDOG_ABORT stalledMs=...` → 会话 idle → abort ok=true |
| task-context-injector 生效 | 派发任意 `task`，看子代理回复是否含"派活交接规范"；`%TEMP%\task-context-injector.log` 有 `INJECTED` 行 | 子代理回复/日志命中 |
| experience-reviewer 触发 | 长对话 3 轮后或 10min 后，看 `%TEMP%\experience-reviewer.log` 是否有 `ERO_DIR_READY` + `timeHit`/`roundHit` | subagent 被 spawn 并写回 OCM 经验库或 AGENTS.md |

---

## 8. 新增一个子项目（规范）

1. 在项目根目录建 `<问题域>/` 独立目录（一个插件一个目录，不混放）；
2. 目录内含：`index.js` + `package.json` + `README.md`（README 必须写明：解决什么问题 / 工作机制 / 注册方式 / 配置项 / 验证方法）；
3. 在全局 `opencode.jsonc` 的 `plugin` 数组注册（绝对路径指向本项目）；
4. 同步更新 `config-backup/opencode.jsonc`（脱敏）；
5. 真实验证通过后更新子项目 README 状态节；
6. 验证脚本放 `scripts/` 并在此索引登记；
7. 更新 §3 目录图 + §4 子项目清单 + §5 部署步骤；
8. 沉淀到 AG 图谱（plugin 子图）与 OCM 经验库。