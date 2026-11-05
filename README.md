<div align="center">

# Cairnweave

**Cairn 图内核 + BreachWeave 执行层，一个 Bun/TypeScript 代码库。**

事实 · 意图 · 调度 · Solver · tools · Observer —— 单进程闭环，
没有 Python ↔ TypeScript 桥，没有 JSONL RPC。

[![CI](https://github.com/luoate/Cairnweave/actions/workflows/ci.yml/badge.svg)](https://github.com/luoate/Cairnweave/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-1279%20passed-brightgreen.svg)](docs/MILESTONES.md)
[![license](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Bun%201.4.4-black.svg)](package.json)

</div>

> **授权范围**：仅用于已获明确书面授权的渗透测试、靶场、比赛或企业自查。
> 未授权扫描或利用不在支持范围内；项目未配置授权目标时调度器 fail closed，不会派发任务。

## 它是什么

Cairnweave 是一个 CTF / 渗透测试领域的 **agent 控制面**（项目名取自 Cairn 图内核 + BreachWeave 执行层）。
控制面负责出题式的推理与调度：
用 Fact / Intent / Hint 构成图，决定下一步探索什么、什么时候收尾、结论是否可信；
worker 在项目沙箱里跑真实模型，每个任务启动一次进程，只返回一个 JSON 结果。

本项目把 Cairn 的图内核与 BreachWeave 的执行层（Solver / tools / skills / Observer）
合并到同一个代码库，因此控制面与 worker 之间只有**任务文件 + 结果文件 + 退出码**。

- 名称约定：项目、Web UI 与浏览器标题统一叫 **Cairnweave**；而 `CAIRN_*` 环境变量、工作区里的
  `.cairn/` 目录、`cairn-worker` prompt、`@cairn/*` 包名与 `cairn` 命令沿用 Cairn 图内核的协议名，
  刻意不跟着改名——它们是与 Python 版做 golden 对照、以及已跑出的项目数据共同依赖的标识。
- 默认确定性 fake solver，`bun test` 与离线演示不需要任何模型凭据。
- 真实模型通过 `CAIRN_SOLVER=breachweave` 启用，凭据只留在本机 agent 配置目录。
- 控制面与 UI 只绑定 `127.0.0.1`；界面本身没有身份认证，远程部署必须加网络层访问控制。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 图内核与调度 | projects / facts / intents / hints、SQLite 单一写者、bootstrap / reason / explore / conclude 四类任务，保留 Cairn 语义并用 Python 版做 golden 对照 |
| Agent 上下文 | 任务级 `agent-context.yaml` 把 Fact 的当前/被取代状态、证据可用性、最近尝试、完成验证进度与 reason 增量交给决策层；只读投影，不改图与导出，`runtime.strategy_context: off` 可关闭 |
| 上下文预算 | 超过 `tasks.tool_result_spill.max_inline_chars`（默认 32000）字符的工具输出落盘 `<workspace>/.tool-results/`，上下文里换成文件路径 + 600 字符预览与「先 grep 再分片读」的提示；solver 与 subagent 共用，`enabled: false` 回到全量内联。原文仍在项目工作区，`/flag` 兜底会读它 |
| 上下文审计（M47） | 每个任务生成 `context-plan.json`，分别统计 Solver/Observer 的提示词、必读快照、可选资料、原有截断数量与恢复缺口；UTF-8 字节计量，默认 128 KiB 审计阈值，超限告警但不裁剪、不拦派发。`tasks.context_plan.mode: off` 关闭；`bun run eval:context` 离线跑八类准备场景，不调用模型，不把审计当作 SDK 窗口占用或压缩收益 |
| 任务记忆（M49） | `tasks.checkpoint.enabled: false` 默认关闭；原子/定时任务检查点 + SQLite 最后有效版本，区分动作、观察、解释和执行失败；已结束任务记忆经 M48 字节预算选择/恢复，复用前标注生命周期、Scope、替代事实和证据可用性，不自动执行建议或提升为 Fact |
| 上下文选择（M48） | `tasks.context_pack.mode: off/shadow/apply`（默认 off），新 default reason/explore 使用预算内 ContextPack + 可恢复的任务快照；省略不等于不存在，核心超预算或无净收益回退原输入。`bun run eval:context-pack` 对比八类场景的初始必读字节与完整授权投影恢复，不调用模型，不宣称真实费用/完成率收益 |
| 意图生命周期 | 操作员（或开启 `strategist.reason_abandon` 后的 reason）可放弃已经尝试且从未成功的 open 意图；状态存 `intent_meta` 旁路，派发、提示、水位与报告都排除它，UI 提供原因输入与二次确认 |
| Scope 硬校验 | `Host Bridge` 在每次模型工具调用前检查网络端点与文件路径，越界即拒绝，allow/block 全量写 `audit.jsonl`；无 `scope` 的项目不派发 |
| 证据门控 | worker 声明的 `evidence_refs` 在写图前逐条校验（存在、非目录、非符号链接、不越界、最小字节），并固化 SHA-256 以便事后比对 |
| 可验证完成 | 项目级目标条件列表（`challenge` / `flag_count` / `evidence`，有序 AND）与兼容别名 `evidence` / `challenge` / `off`；worker 的 “complete” 只是声明，oracle 不通过就不关项目；`flag_count` 只统计操作员已确认与挑战服务已确认的 flag，支持手动 `/verify`。自动完成至少需要一个客观条件：仅有 `evidence` 或 `off` 的完成声明默认进入人工确认（`completion_reviews`），`verification.evidence_completion: auto` 可保留旧的自动路径；创建弹窗显示 `auto` 实际解析出的策略并在需要人工复核时警告，项目页显示校验徽标；`bun run eval` 用同一组场景对比加固前后的完成率与错误完成率 |
| Observer sidecar | 真实 Solver 旁的独立复盘会话，只维护项目级看板（ideas / memory），主 Solver 仅拿到只读工具；失败、超时都不影响任务结果 |
| 图提案 | Observer 只能写候选文件，控制面是唯一审核者与写图者；默认 `dry_run`（完整校验、记录结果、不写图），改 `apply` 才落图 |
| 中文 Writeup | 从图中数据确定性渲染中文 Markdown 草稿，可由模型重写；附带载荷（payload）章节、附件 zip 打包与「AI 撰写 / 恢复草稿」 |
| 题目附件 | 操作员把题目给的二进制 / pcap / 源码包上传进项目工作区 `attachments/`（单文件 32 MiB、每项目 256 MiB），Worker 的任务提示直接列出文件清单，按只读输入读取；「附件」页签负责上传、下载与二次确认删除 |
| Flag 与校验 | `/flag` 从已索引工件、`.tool-results` 溢出文件与会话工具输出中提取真实 flag，拒绝占位符与掩码；兜底遍历有目录/条目上界，结果按工作区短缓存；challenge 项目按外部计分校验 |
| 人工 Flag 复核 | `verification.flag_review: manual`（默认）时，worker 写回的 flag 形状值会登记为后台复核，项目照常探索但不会在判定前结束，由操作员随时判定「真·还有更多 / 真·停止 / 假·继续」；判定写旁路表、驱动完成或提示，假 flag 不会二次入队、也不能成为结束项目的理由（引用它的完成声明会被拒绝，reason 继续跑）；设置里「运行与执行 → 图切片与校验」有「Flag 人工复核」开关（默认开），关闭即不再登记新复核 |
| 成本与预算 | `runs` 记录模型 / Token / 成本；意图级 priority 与预算、单项目 token/成本配额、逐 Fact 与逐意图的成本归因与因果边 |
| 只读运维视图 | 运行、慢层、审计、证据、提案、看板、成本、统计、报告、Writeup、附件十一个侧栏页签，除人工重规划与附件上传/删除外全部只发 GET |
| 运行期配置 | Observer、并发、超时、证据门、预算、策略阈值、提案参数等可在页头「设置 → 运行与执行」里热调，覆盖存 SQLite，重启不丢 |
| 启动对账 | `runs` 行只在拥有它的进程里收尾，控制面重启会留下永远“运行中”的幽灵任务；每次 `start()` 先在 `scheduler_instances` 注册 boot 行并按心跳判断是否有活跃同伴，无同伴时把遗留的 `outcome IS NULL` 补成 `inactive`（detail 说明原因），统计、慢层视图与预算的 running 计数随之归零；不改派发路径、不释放租约 |
| 任务 claim 账本 | 每个派发任务在 `task_claims` 里占一行（意图 / reason 槽各有一个部分唯一索引），配额、单项目并发与慢层抑制都改从这张表派生，`this.running` 退回成进程句柄表；误开第二个控制面时它看得见同一份账本，重复执行同一意图会在存储层被 409 挡回，崩溃那次的 claim 要等租约到期才被接管，优雅停止则立刻释放——图级租约照旧双写，删掉这张表就回到 M38 |
| 两种执行模式 | 新建题目时可选择本地进程、Docker 容器或跟随全局默认；显式选择按题目保存，可与其他模式的题目并行运行。Docker 不可用时不会回退到本地；容器配置只读挂载、不挂 Docker socket，设置中的「测试有效性」可检查执行环境 |
| 技能管理 | 页头「设置 → 技能」里新增、删除、启停与恢复技能；「预览」打开独立详情弹窗，左树右正文地浏览技能目录里的 `SKILL.md`、`references/`、`scripts/`；内置 17 个，仅写入 `cairn-worker` prompt 白名单的才生效；删除内置技能会在 `.deleted-builtins.json` 里留痕，重启不回填，可一键恢复 |
| 轻量首屏 | Tailwind 用 CLI 预编译成 `static/app.css` 入库（不再加载 451 KB 的 Play CDN），cytoscape 与布局引擎按项目/布局懒加载，静态响应带 ETag/304 与 gzip/br；列表页首屏传输从 3.82 MB 降到 96 KB |
| 审计与实时流 | 任务结束导入 `audit.jsonl` 到哈希链账本；可选实时流按 `(task_id, seq)` 幂等追加，只降低暴露窗口，不改变最终一致性 |

## 架构

```
cairn serve（控制面，一个进程）
  ├─ HTTP API（兼容 Cairn）+ 静态 UI（Alpine.js 单文件，样式预编译入库）
  ├─ SQLite（唯一写者）
  ├─ scheduler：bootstrap / reason / explore / conclude（启动时注册实例心跳并对账遗留 run）
  ├─ 渲染 prompt + 写 graph.yaml（默认全图；explore 可切片）
  └─ 为每个任务写 task.json，supervise worker 进程
        │
        ▼  项目工作区（每项目绑定到 /cairn/workspace）
  cairn worker --task <task.json>（按任务拉起；容器模式下是 docker exec）
        ├─ solver：默认确定性 fake；CAIRN_SOLVER=breachweave 用 packages/agent
        ├─ 模型/凭据：agent 配置目录（默认 ~/.cairnweave/config，CAIRN_AGENT_CONFIG_DIR 可指向仓库内 agent-config/；容器内只读挂载到 /cairn/agent-config）
        ├─ Host Bridge：每次 tool_call 前做 Scope 硬校验，逐条写 audit.jsonl
        ├─ Observer：主 Solver 只读项目看板；独立 sidecar 维护看板并提交候选
        ├─ 提案候选：<session>/observer/proposals/*.json（控制面在任务结束时导入）
        └─ 原子写入 result.json 后退出
```

控制面是唯一写图者；worker 跑在项目沙箱里，按任务拉起，不是常驻守护进程。
同一项目默认串行（`runtime.max_project_workers: 1`），提高上限时由任务级 artifacts
命名空间与 Observer 复核租约协调共享工作区。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速开始

需要 [Bun](https://bun.sh) 1.4.4。

```bash
bun install

# 只跑 HTTP API（无调度器）
bun run cairn serve --port 8000 --db-path ./cairn.db

# 控制面 + 调度器（fake solver）
bun run cairn serve --port 8000 --db-path ./cairn.db --config dispatch.example.yaml
```

浏览器打开 <http://127.0.0.1:8000/> 即静态控制台。创建一个带授权范围的项目：

```bash
curl -s -X POST localhost:8000/projects -H 'content-type: application/json' -d '{
  "title": "demo",
  "origin": "start",
  "goal": "finish",
  "bootstrap_enabled": false,
  "scope": { "targets": ["127.0.0.1:8080"], "notes": "local lab" }
}'

curl -s localhost:8000/projects/proj_001
```

`scope.targets` 至少一项，表示已获书面授权的目标；Host Bridge 会按它在每次工具调用前
强制校验。没有 `scope` 的项目保持 active 但零意图（fail closed）。

接管真实模型：

```bash
CAIRN_SOLVER=breachweave bun run cairn serve --port 8000 --db-path ./cairn.db \
  --config dispatch.example.yaml
```

启动参数：`--host`、`--port`、`--db-path`、`--static-dir`、`--log-level`、
`--access-log/--no-access-log`、`--config`。不带 `--config` 时只跑 HTTP API；
`--config` 指向与 [dispatch.example.yaml](dispatch.example.yaml) 同形状的文件并启用进程内
调度器。

## 配置

所有调度行为集中在 `dispatch.yaml`，字段与生效时机见 [docs/CONFIG.md](docs/CONFIG.md)。
两个值得注意的默认值（M22 / M23 起）：

```yaml
observer:                     # 默认开启；只读复盘，不改任务结果
  enabled: true
  every_rounds: 4
  window_rounds: 8
  timeout_seconds: 60
  max_reviews_per_task: 8
  kernel_tasks: ["explore"]

proposals:                    # 默认开启，但只演练
  enabled: true
  mode: dry_run               # off | dry_run | apply
  max_per_task: 20
  allow_kinds: ["fact", "intent", "hint"]
  require_evidence_for_fact: true
```

`dry_run` 会执行全部来源、证据与去重校验，把结果记入 `proposals` 表（`would_apply`），
但不写图；需要落图时改成 `apply`，或在「设置 → 运行与执行」里热切换。

运行期可改的字段（并发、间隔、超时、证据门、预算、策略阈值、提案参数、选择策略等）
通过 `GET/PUT/DELETE /settings/runtime` 存进 SQLite 覆盖层，深合并回 YAML 解析结果后
在下一个调度 tick 生效；部署项（`server`、`common_env`、`worker_profiles`、Observer 路径、
审计流派生项）仍需改 YAML 并重启。

## HTTP API

控制面 API 兼容 Cairn，未认证，只应监听回环地址。常用路由：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/projects` | 列表（含 `has_scope`）与创建（可带 `scope`、`goal_conditions` 或兼容别名 `verification`、`execution: "local"\|"container"`） |
| GET/PUT/DELETE | `/projects/{id}` | 详情、状态/标题更新、删除 |
| GET/PUT | `/projects/{id}/scope` | 授权范围读取与补配 |
| GET | `/projects/{id}/export` | YAML 图导出 |
| GET | `/projects/{id}/subgraph` | 以某个 Fact / Intent 为中心的按需子图（`around`、`depth`、`max_facts`、`max_intents`、`format=json\|yaml`） |
| GET | `/projects/{id}/runs` | 逐任务 run（kind、worker、模型、outcome、Token、成本） |
| GET | `/projects/{id}/facts/{fact_id}/meta` | Fact 溯源：产出 run、证据状态、取代关系 |
| GET | `/projects/{id}/facts/{fact_id}/evidence` | 证据实时校验（`ok` / `modified` / `missing` …） |
| GET | `/projects/{id}/artifacts` | 工件索引（路径、大小、SHA-256、来源任务） |
| GET | `/projects/{id}/audit[/{task_id}]` | 审计任务汇总与逐任务哈希链 |
| GET | `/verification/defaults` | `auto` 实际解析出的校验策略、目标条件、完成模式与人工复核警告 |
| GET | `/projects/{id}/verification` | 完成别名、目标条件列表与最近一次逐条件检查 |
| POST | `/projects/{id}/verify` | 手动重跑完成 oracle（可限定 Fact 子集） |
| GET | `/projects/{id}/flag` | 命中的 flag、候选与校验状态（按工作区缓存 10 s，结果带 `truncated`；排除已判假的 Flag，优先展示已确认值） |
| GET | `/projects/{id}/completion-review` | `verification: off` 项目的待确认完成声明与历史 |
| POST | `/projects/{id}/completion-review/{review_id}/decision` | 操作员决定 `approve` / `reject`；approve 用记录的来源 Fact 完成项目，reject 写提示并继续探索 |
| GET | `/projects/{id}/flag-reviews` | 待复核 Flag、已确认/已判假值与各状态计数 |
| POST | `/projects/{id}/flag-reviews/{review_id}/decision` | 操作员判定：`real_more` / `real_done` / `fake`；项目仍 active 时 `real_done` 直接完成项目 |
| GET | `/projects/{id}/stats` | 按 worker / 模型 / profile 的运行统计 |
| GET | `/projects/{id}/cost` | 总量、按类型汇总、逐 Fact/意图归因与因果边 |
| GET | `/projects/{id}/strategist` | 慢层状态、预算、未结束意图与推理历史 |
| POST | `/projects/{id}/replan` | 人工重规划（唯一会写状态的 UI 操作） |
| GET | `/projects/{id}/proposals` | Observer 提案与审核结果（可按 status / kind 过滤） |
| GET | `/projects/{id}/board` | 只读看板快照（ideas / memory，带截断标记） |
| GET | `/projects/{id}/report` | 项目报告快照，`?format=markdown` 下载 |
| GET | `/projects/{id}/supersedes` | Fact 取代链计数与边 |
| GET/POST/DELETE | `/projects/{id}/writeup` | 中文草稿 / 模型撰写版 / 恢复草稿 |
| GET | `/projects/{id}/writeup/archive` | 正文与全部附件的 zip 包 |
| GET/POST | `/projects/{id}/attachments` | 题目附件列表 / 上传（`?name=` + 原始字节正文，一次一个文件） |
| GET/DELETE | `/projects/{id}/attachments/{attachment_id}` | 下载附件字节 / 删除附件 |
| GET/PUT/DELETE | `/settings/runtime` | 运行配置覆盖（仅 `--config` 模式） |
| GET/POST/PUT/DELETE | `/settings/agent*` | 模型与密钥管理，详见 [docs/MODELS.md](docs/MODELS.md) |
| GET/POST/PUT/DELETE | `/settings/agent/skills*` | 技能列表、新增、删除、启停、内置恢复，以及只读的文件树 `/skills/{name}/files` 与单文件预览 `/skills/{name}/file?path=` |

写路由在设置 `CAIRN_OPERATOR_TOKEN` 后要求 `X-Cairn-Operator-Token`，并拒绝 Origin 与请求
host 不一致的浏览器写请求。

## Web UI

静态单页（Alpine.js，直接由 `GET /` 与 `/static/*` 提供），中文界面。没有打包器，只有一步
样式预编译：`bun run ui:css` 用 Tailwind CLI 将 `index.html` 的工具类与
`tools/ui/input.css` 的布局、设计变量一起生成 `static/app.css`，产物入库；
CI 重新生成后 `git diff --exit-code` 校验它没有漂移。

- 布局：深色固定导航 + 浅色工作区，青绿色为主操作色。首页按状态展示概览与项目卡片；
  项目页采用「分组导航 / 探索图 / 可调宽详情面板」，十四个面板入口按探索、执行溯源、
  分析交付分组，详情面板也提供完整选择器。项目操作收进可键盘访问的下拉菜单。
- 响应式：≤960px 导航收为抽屉；≤720px 探索图与详情改为单面板切换，保留节点选择、
  面板与运行数据。详情分隔条支持方向键调宽；移动端不会覆盖保存的桌面面板宽度。
- 加载：首屏只有 HTML、`app.css`、Alpine 与 `graph-loader.js`；打开项目才
  拉 cytoscape 与当前布局引擎，Klay / ELK 只在选中那种布局时才拉；静态响应带 size+mtime 的
  ETag、`Cache-Control: no-cache` 与 `Vary: Accept-Encoding`，刷新时未变动的资源回 304。
- 字号：保留命名工具刻度（`text-2xs` 最低 11px，`text-xs` 12px、`text-sm` 14px、
  `text-base` 16px），工作区与弹窗的小字提高到 12px，辅助标记最低 11px；主题同时声明
  `sans` 与 `mono`。布局间距、圆角、色板与响应式规则集中维护在 `tools/ui/input.css`。
- 列表：搜索、状态筛选、三种排序、按项目记忆视图；页面隐藏时暂停轮询，失败 5s→60s 退避。
- 项目页：图视图、Fact 详情、Flag 横幅、授权范围，以及分组导航中的运行 / 慢层 / 审计 /
  证据 / 提案 / 看板 / 成本 / 统计 / 报告 / Writeup / 附件面板。
- 无障碍：13 个弹窗保留模态栈（Esc 只关最上层、Tab 焦点陷阱、关闭回焦），增加对话框
  名称与语义、背景 `inert`、通知 live region；导航抽屉支持焦点约束与关闭回焦；动画尊重
  `prefers-reduced-motion`，选中状态有边框/文字，不仅依赖颜色。
- 「设置」是一个带五个页签的弹窗：运行与执行（含 local/container 切换、运行期覆盖与
  执行环境「测试有效性」）、模型与密钥、技能（新增 / 删除 / 启停 / 恢复内置，行内「预览」
  打开技能详情弹窗浏览文件）、本地偏好（操作者与默认布局，仅存浏览器）、服务端设置。

所有只读页签只发 GET；唯一的显式写操作是慢层的“请求重规划”。

## 模型与密钥

真实 Solver 读取 BreachWeave 的配置目录（默认 `~/.cairnweave/config`，旧版 `~/.tch-agent/config`
里的内容会在首次启动时复制过来且不删除原目录；`CAIRN_AGENT_CONFIG_DIR` 可覆盖）：`auth.json` 存凭据，`models.json` 存 provider / baseUrl /
协议与模型，`model-prefs.json` 是短 ID 到模型的映射（`cairn-worker` 指向当前默认模型）。
`worker_profiles` 把这些短 ID 组成命名 profile，交给统计驱动的派发选择。

本部署把该目录放在签出内的 `agent-config/`：`prompts/`、`skills/` 与 `settings.json` 作为
项目内容入库，凭据与 provider 接线文件仍被 `.gitignore` 排除，因此克隆仓库即得到可用的
提示词与技能，密钥仍需操作员自行配置（见
[docs/OPERATIONS.md](docs/OPERATIONS.md#仓库内的-agent-配置目录m44)）。

### 通过 API 与 UI 管理模型与密钥

页头齿轮按钮打开「设置」，在「模型与密钥」页签里管理模型：后端是 `/settings/agent` 系列路由：provider 与模型
CRUD、内置目录与远端 `/models` 发现、单模型或 provider 级连通性测试、设为默认 worker 模型。
API key 只写不读（响应只回掩码），写入 `auth.json` 并按上游 SDK 要求同步到 `models.json`；
自定义请求头同样只写，只回名字。删除仍被引用的条目返回 409，`?force=true` 才级联清理。
完整步骤、常见错误与真实模型 A/B 记录见 [docs/MODELS.md](docs/MODELS.md)。

## 安全模型

- **授权范围**：`scope.targets` 是调度与工具调用的前提；无范围项目不派发。
- **Host Bridge**：从 `bash` 命令提取 URL / `/dev/tcp` / IPv4 / IPv6 / CIDR / `host:port` 等端点，
  主机名按字面匹配（不做 DNS）；文件读写按 realpath + 词法双重判断，阻止符号链接逃逸；
  未知工具默认拒绝；审计不可写时同样拒绝。
- **SSRF 标记**：授权请求内部携带的其它主机字面量（查询串、表单体、`@payload` 文件）与连接
  目的分开判定。`scope.ssrf_markers` 默认 `observe`（放行并写 `ssrf_candidate` 审计行，UI
  标成琥珀色徽标），可切 `block`（越界携带目标直接拒绝）或 `off`（忽略携带目标，是放宽）。
  链路本地元数据段与本部署自身主机名在 `observe` / `block` 下都拒绝；`protected_hosts` 在
  dispatch.yaml 登记。
- **策略级，不是内核级**：Host Bridge 只看模型工具调用；`bash` 直连网络或写共享工作区仍需
  容器隔离（网络命名空间、不挂 socket、只读配置）来兜底。两者要同时启用。
- **无内建认证**：UI 与 API 会直接修改控制面数据，默认只绑定 `127.0.0.1`；需要远程访问时
  放在受信网络或反向代理之后。
- **凭据边界**：模型凭据只在 agent 配置目录，且该目录被 Host Bridge 登记为拒绝根，worker
  工具读不到；仓库里的 `agent-config/` 只跟踪提示词、技能与 `settings.json`，`auth.json`
  一类文件不入库。任务文件、日志、审计账本与数据库不保存明文 key。challenge oracle 只读
  计数，不读 flag 明文。

## 测试与 CI

```bash
bun test             # 1279 passed / 115 files（fake solver，不需凭据）
bun run typecheck    # tsc --noEmit
bun run eval         # 五个完成场景的 legacy / hardened 对照，写 runs/eval-<date>.json
bun run eval:context # M47 八类任务准备场景：上下文账单、截断/恢复说明与 audit/off 兼容性
bun run eval:context-pack # M48 同图 off/shadow/apply 选择、字节减少与按需恢复对照
bun run ui:css       # 改了 index.html 的 class 后重新生成 static/app.css
bun run check        # typecheck + test；CI 还会校验 app.css 与 index.html 不漂移
```

`.github/workflows/ci.yml` 在 push 到 `main` 与 PR 时用 Bun 1.4.4 执行
`bun install --frozen-lockfile`、重新生成 `static/app.css` 并 `git diff --exit-code`（产物
必须与 `index.html` 同步入库）、`bun run typecheck`、`bun test`。真实模型与真实 Docker 的
gate 放在 `tools/gate/`，手动执行、不计入 CI，命令与环境变量见
[docs/OPERATIONS.md](docs/OPERATIONS.md#真实模型-gate)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 角色、数据所有权、时序、沙箱与失败语义 |
| [DESIGN.md](docs/DESIGN.md) | 设计与实现记录：AgentContext、意图生命周期、调度真相、完成契约、M47 上下文预算审计、M48 选择/恢复与 M49 检查点/尝试记忆 |
| [CONFIG.md](docs/CONFIG.md) | 运行配置字段、SQLite 覆盖、热生效范围与只读项 |
| [OPERATIONS.md](docs/OPERATIONS.md) | 容器模式、Host Bridge、artifacts、证据、切片、Observer、提案、预算、真实模型 gate |
| [CONTRACT.md](docs/CONTRACT.md) | worker 契约：task / result / usage / audit、退出码与校验边界 |
| [VERIFICATION.md](docs/VERIFICATION.md) | 完成验证策略、oracle、路由与安全边界 |
| [OBSERVER.md](docs/OBSERVER.md) | Observer 实现、权限、flush 语义、看板与提案 |
| [STRATEGIST.md](docs/STRATEGIST.md) | 慢层触发、意图优先级 / 预算、Hint、人工与资源触发、成本归因 |
| [REPORT.md](docs/REPORT.md) | 项目报告的 JSON 结构、来源、排序与脱敏 |
| [WRITEUP.md](docs/WRITEUP.md) | 中文 Writeup：草稿组成、载荷、附件包、Flag 置信度与模型撰写 |
| [MODELS.md](docs/MODELS.md) | 模型与密钥的一页操作手册 |
| [PORTING.md](docs/PORTING.md) | Python Cairn → TypeScript 的模块映射与对照测试策略 |
| [MILESTONES.md](docs/MILESTONES.md) | M1–M49 实现记录、完整验证清单与里程碑表 |

## 仓库结构

<details>
<summary>展开目录</summary>

```
apps/cairn/src/
  cli.ts                 serve / worker / version
  roles/control.ts       cairn serve：HTTP API + SQLite（--config 时启动 scheduler）
  roles/worker.ts        worker：跑 solver、宽容解析、原子写 result.json
  http/api.ts            Cairn 兼容路由（Bun.serve 零依赖）
  http/project-board.ts  只读看板读取（M23）
  http/static-assets.ts  静态资源：ETag/304 再验证与 gzip/br 变体（M27）
  http/static/           Cairnweave Web UI（Alpine.js 单文件；`app.css` 预编译入库，图引擎懒加载）
  config.ts              dispatch.yaml 校验（Bun.YAML）
  config-overrides.ts    运行期覆盖：SQLite patch ↔ dispatch.yaml（M22/M24）
  prompts/               prompt 加载、渲染与上游默认模板
  scheduler/             tick、派发、租约、证据、提案、策略、保留、审计
  verification/oracle.ts 完成 oracle：goal_conditions（challenge / flag_count / evidence）与兼容别名
  runtime/               scheduler ↔ 沙箱接口（local / container）与执行环境探测（M24b）
  host-bridge/           tool_call 级 Scope 校验 + audit.jsonl + 看板保护
  solver/                fake 与 breachweave 两种 solver
packages/contracts/      control ↔ worker 契约
packages/agent/          vendor 的 BreachWeave core（Apache-2.0，含 cairn-observer 适配层）
packages/graph/          schema、领域模型、服务、命令、导出、成本归因
packages/pi-mcp-adapter/ vendor 的 MCP 适配器（MIT）
tools/golden/generate.py Python Cairn golden 生成器
tools/gate/              真实模型 / 真实 Docker 的联调 gate（不计入 bun test）
tools/ui/                Tailwind 入口与配置：`bun run ui:css` 生成 static/app.css
docs/                    架构、配置、契约与各主题说明
dispatch.example.yaml    调度器配置示例
Dockerfile.worker        worker 镜像（bun + procps）
agent-config/            本部署的 agent 配置目录：只跟踪 prompts/ 与 skills/、settings.json（M44）
```

</details>

## 许可证与合规

整体按 **AGPL-3.0** 分发（见 [LICENSE](LICENSE)）。并入的 BreachWeave 代码保留其
Apache-2.0 许可声明，第三方清单见 [THIRD_PARTY.md](THIRD_PARTY.md)。

仅用于已获明确书面授权的安全测试。**未授权扫描或利用不在支持范围内。**
