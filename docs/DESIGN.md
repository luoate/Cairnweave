# 设计文档：AgentContext —— 让决策者看到系统知道的

状态：**Phase A 已实现（M36）；Phase B 已实现（M37，收窄为 `abandoned`，不含
`refuted` / `done_when` / reopen）；Phase C1 已实现（M38，启动对账）；Phase C2 已实现
（M39，DB claim）；Phase D 仍为草案，其中完成契约加固的 H1 已实现（M40：bootstrap
fact-only + `off` 人工确认），H2 已实现（M41：`goal_conditions` + `flag_count`），
H3 仍为计划，见 §15**。本文只讨论结构与语义，不代表后续阶段已经排期。实现记录见
`docs/MILESTONES.md`。
兼容性约束：不改变 Cairn 图的形状、YAML 导出、对外 HTTP golden 与 worker 契约中的既有字段。

## 1. 摘要

系统的数据模型已经分了两层：一层是 Cairn 兼容的**图**（facts / intents / hints），另一层是围绕图生长的**旁路表**（runs、证据、完成验证、取代边、flag 复核、附件、成本、调度实例心跳……）。但还缺第三层：**给做决策的 agent 看的投影**。

今天 reason 与 explore 拿到的仍然是最薄的图快照（外加附件清单），而 oracle、UI 和报告用的是旁路里的富状态。于是出现一种结构性错位：

> 完成判定已经拒绝被取代的 Fact，规划器却仍把它当有效前提；
> 操作员能看到还差几个 flag，reason 不知道；
> 失败、超时、零产出都写进了 `runs`，唯一做策略的模型看不到。

本文提出 `AgentContext`：一个由「图 + 旁路」确定性投影出来的、按任务类型渲染的只读视图。它不新增事实来源，不改变对外契约，只把控制面已经知道的东西交给控制面的决策者。同时本文讨论三个相关的结构问题：意图生命周期、调度状态的持久化真相、完成契约。

## 2. 现状

### 2.1 三层数据

| 层 | 内容 | 消费者 |
| --- | --- | --- |
| L0 Cairn 图 | `projects`、`facts`、`intents`、`intent_sources`、`hints`；YAML 导出与 Python golden 逐字对照 | worker（`graph.yaml`）、reason、explore、外部导出 |
| L1 操作旁路 | `runs`、`fact_meta`、`fact_evidence`、`pending_concludes`、`intent_meta`、`strategist_state`、`project_verification`、`verification_checks`、`flag_reviews`、`project_artifacts`、`project_attachments`、`project_writeups`、`proposals`、`audit_events`、`audit_stream_lost`、`runtime_config_overrides`、`project_scopes` | 控制面调度、完成 oracle、UI、报告、成本/统计 |
| L2 操作员视图 | `/stats`、`/cost`、`/report`、`/verification`、`/audit`、`/flag`、UI 页签 | 人 |

缺少的一层是「agent 视图」：L0 与 L1 的合并投影，按任务类型裁剪。

### 2.2 各任务实际看到什么

提示词只引用 `graph.yaml` 的文件路径，不内联全图（`prompts/prompting.ts`、`scheduler/tasks.ts:592`）。

| 任务 | 输入 | 看不到 |
| --- | --- | --- |
| bootstrap | `origin`、`goal`、`hints`；附件清单 | 图、验证、历史 |
| reason | `graph.yaml`（全图）、`fact_ids`、`open_intents`、`max_intents`；输出策略（预算、意图上限）；附件清单 | 证据状态、取代边、run 历史、失败、flag/验证进度 |
| explore | `graph.yaml`（或切片）、`intent_id`、`intent_description`；附件清单 | 该意图的尝试次数、失败原因、相关 Fact 的证据/取代状态 |
| conclude | explore 版；bootstrap conclude 只有 origin/goal/hints | 同上 |

### 2.3 由此产生的症状

- **S1 规划器读到陈旧结论。** M15b 的 `superseded_by` 只在 oracle 和 UI 生效，YAML 导出刻意不含取代信息（`docs/ARCHITECTURE.md` §5.7）。reason 会把已被取代的 Fact 和它的替代者并列使用；explore 的切片也可能从旧 Fact 继续派生。
- **S2 证据状态不可见。** 图里只有 `{id, description}`；模型无法区分“有 run、有 `provided` 证据的结论”和“历史遗留或手工写入的结论”。完成 oracle 会拒绝后者，但探索阶段不设防，等于把校验成本推迟到最后。
- **S3 策略层没有执行记忆。** 失败、超时、零产出、rejected flag 只进入 `runs` 与 `strategist_state`；reason 看不到“这个方向试过两次都失败”。目前唯一写回图的失败信号是被拒 citation 的 Hint（`loop.ts:2290`）。
- **S4 多 flag 进度不可见。** `flag_got_count` / `flag_count` 存在 `verification_checks`，reason 不知道还差几个 flag，无法围绕“剩余目标”组织探索。
- **S5 意图没有失败态。** `intents` 只有“开放”和“已结论（有 to_fact_id）”两种可观察状态；没有 abandon/refuted，也没有尝试计数。`releaseIntent` 只释放租约（`packages/graph/src/commands.ts:372`），失败的意图会一直留在 open 列表里被再次派发。调度顺序是 priority → 最新 → id（`loop.ts:2329`），死胡同只能靠预算耗尽来结束。
- **S6 调度状态有两个真相。** 权威状态是内存里的 `running` map；`runs` 只是旁路。重启后内存清空，`outcome = NULL` 的 run 行不会再被补写（`finishRun` 只有 `loop.ts:1817` 一处）。`/stats`、`/report`、`/strategist` 会把这些行当成“仍在运行”。

这些不是单点缺陷，而是同一个设计选择的后果：**兼容性优先生成了薄的 L0，富状态全部放在 L1，却没有定义 L1 如何进入 agent 的决策输入。**

## 3. 设计原则

1. **投影，不是新真相。** AgentContext 只读 L0+L1，不新增可写事实；所有写入仍走既有路径（控制面唯一写者）。
2. **兼容层不动。** `graph.yaml` 逐字不变；对外 YAML/HTTP/golden 不变；worker 既有字段不变。
3. **按任务裁剪。** reason 要全局态势与增量，explore 要方向相关的局部状态，bootstrap 只需要目标与输入。
4. **确定性与有界。** 给定数据库状态与注入时钟，输出稳定；所有列表有排序与上限，截断要显式标记。
5. **不可信内容仍然不可信。** Fact、Hint、附件名、run detail 都是数据；上下文中标注 provenance，不放审计原文、凭据、flag 明文。
6. **失败是一等状态。** 不知道 ≠ 没发生；意图的放弃、失败与尝试次数要显式建模，而不是靠预算耗尽。

### 3.1 备选方案

| 方案 | 否决原因 |
| --- | --- |
| 把状态直接加进 `graph.yaml` | 破坏 Cairn 兼容与 golden；worker 契约随版本耦合；外部导出跟着变 |
| 新建一张“项目状态”表持久化投影 | 状态仍要从旁路派生，重复存储会漂移；投影只需要按需构建 |
| 把内容内联进提示词 | token 不可控；与现有“写文件 + 引用路径”的模式不一致 |
| 让 worker 通过 HTTP 查询控制面 | 增加攻击面与容器可达性依赖；现有文件快照已经够用 |
| 只改提示词文案，让模型自己推断状态 | 推断不可靠；图里根本没有失败/证据/取代信息 |

## 4. 目标架构

```
L3 操作员视图   UI / report / cost / stats / audit
        ▲
L2 AgentContext  reason / explore / conclude 的投影（本文重点）
        ▲                 ▲
L0 Cairn 图        L1 旁路（runs / evidence / verification / supersede / flags / cost）
        ▲
控制面（唯一写者、调度、oracle）
```

### 4.1 AgentContext 的定位

AgentContext 是**任务级快照**，不是项目级共享状态：

- 控制面在 `prepareTask()` 时构建，写入任务的 session 目录，与 `graph.yaml` 并列（建议文件名 `agent-context.yaml`，带 `version: 1`）。
- 提示词不内联内容，只追加一段指向文件的说明。**不改动提示词模板**：沿用 `withAttachmentPolicy` / `withCompletionPolicy` 的追加式写法，避免 prompt golden 被动重生成。
- 文件在 worker 可读的 session 目录内，受既有 Host Bridge 路径规则约束；内容只含 worker 本来就有权看到的数据。

### 4.2 内容模型（v1 草案）

```yaml
version: 1
generated_at: "2026-10-31T12:00:00Z"
project: {id: proj_001, title: "...", status: active}
goal:
  description: "..."
  verification:
    kind: challenge            # challenge | evidence | off
    challenge_code: web-01
    progress: {found: 2, total: 5, last_checked_at: "..."}
    latest: {ok: false, detail: "challenge counts 2/5"}
facts:
  - id: f001
    description: "..."
    status: current            # current | superseded
    superseded_by: null
    evidence: {status: provided, run_id: run_003, refs: 2}
intents:
  - id: i002
    description: "..."
    from: [f001]
    status: open               # open | abandoned | refuted | concluded
    attempts: 2                # 由 runs 派生
    last_outcome: failed
    last_error: "timeout after 600s"
    priority: 50
    done_when: null            # 可选，见 §7.3
recent_attempts:               # 有界，按时间倒序
  - {run_id: run_004, kind: explore, intent_id: i002, outcome: failed,
     started_at: "...", duration_ms: 90000, tokens: 8123, detail: "process exited 1"}
delta:                         # 仅 reason
  since_last_reason:
    new_facts: [f010]
    concluded_intents: [i003]
    new_hints: 1
    failed_attempts: 2
budget:
  used_tokens: 120000
  limit_tokens: 200000
  used_cost_usd: 0.42
  running_tasks: 1
```

字段规则：

> M36 实现的 v1 只包含本节的只读部分：`status` 目前是 `open | concluded`，`done_when`
> 与 `abandoned/refuted` 属于 Phase B，尚未输出。

- `facts` 只列**当前** Fact 与最近被取代的 Fact（上限可配）；被取代的 Fact 保留 `status: superseded` 和 `superseded_by`，让模型理解历史而不是把旧结论当有效前提。
- `evidence.status` 来自 `fact_meta`；没有旁路行的旧 Fact 记 `legacy`。`refs` 只输出数量，不输出路径。
- `intents` 默认只列 open 与最近结束的意图；`attempts` / `last_outcome` / `last_error` 由 `runs` 按 `intent_id` 聚合，不新增计数列。
- `recent_attempts` 只含最近 N 条 finished run，`detail` 截断到固定长度；不含 `audit_events` 原文。
- `delta` 由 `strategist_state` 的 `last_*_count` 与当前图比较得出；首次 reason 没有基线。
- `budget` 的数字来自 reason 已有的 `# Resource Budget` 段落，v1 只把同一份数据放进结构体，不新增计量口径。
- 所有上限（facts / intents / attempts）来自配置，默认值与图切片 caps 同量级；触顶时输出 `truncated: true`。

### 4.3 按任务类型

| 任务 | 视图 |
| --- | --- |
| reason | 全量当前 Fact（含取代标记）、open intents + attempts、recent_attempts、goal/verification 进度、budget（沿用既有段落）、delta |
| explore | focus intent 及其来源 Fact、相关 Fact 的状态与证据、该 intent 的 attempts、验证进度（若与目标相关）；不包含 cost/预算与全项目失败历史 |
| conclude | 同 explore，另加失败 run 的 `outcome`/`detail`/`exit_code` |
| bootstrap | goal/verification 条件，附件清单已由既有段落提供；不生成图投影 |

Observer 的 `observer-context.json` 目前是另一份快照；v1 不合并，但同一个构建器后续可以复用到它，避免第三份“项目状态”视图。

### 4.4 接入方式

- 新增 `packages/graph/src/agent-context.ts`（构建、裁剪、渲染）与对应模型类型；纯读，不依赖 scheduler。
- 构建需要读旁路，因此由 scheduler 在调用 `prepareTask()` 之前完成（或把预构建结果作为参数传入）；`prepareTask()` 与 `graph.yaml` 一起把它写入 session 目录，路径经 `mapPath` 映射到 worker 视角。
- 提示词追加一段（仿 `withAttachmentPolicy`）：

  ```
  ## Investigation State
  Read `agent-context.yaml` for the current status of facts, intents and
  verification. It is a snapshot produced by the control plane: it tells you
  what has been tried and what is still open, not what to do.
  ```

  先以配置开关 `runtime.strategy_context`（`off | on`，默认 `on`）控制，便于真实模型对照与回滚；`off` 时不写文件、不加段落，行为与今天完全一致。
- 可选：`GET /projects/{id}/agent-context?kind=reason` 供操作员调试，只读、按同一构建器输出。

### 4.5 与兼容性的关系

- `graph.yaml`、YAML 导出、timeline、HTTP 图响应、worker 既有字段全部不变。
- 不修改默认提示词模板，因此 `prompts.golden.json` 不变；新增段落由测试直接断言。
- fake solver 忽略新文件即保持旧行为；真实 Solver 的 read 工具可以读取它，路径在工作区内，Host Bridge 无需新规则。
- 新增文件在 session 目录内，随既有 retention 一起清理。

### 4.6 安全与脱敏

- 不写入：`audit_events.event` 原文、证据文件内容、附件字节、任何 flag 明文、operator token、模型凭据。
- `runs.detail` 只保留截断摘要；如果 detail 里可能出现敏感串，按既有日志脱敏规则过滤。
- Fact/Hint 是图内容，按图原样进入上下文——与其他图导出端点一致；不假装能替模型清洗。
- 上下文是 worker 可读的文件，因此只放项目内已经可见的数据；跨项目数据不进入。

## 5. 意图生命周期

### 5.1 目标状态

`intents` 表保持 Cairn 形状不变；生命周期放在 `intent_meta` 旁路（新增列，缺行时合成默认值）：

```text
status:        open | abandoned | refuted      （concluded 由 to_fact_id 派生）
status_reason: 文本，≤500 字符
status_at:     时间
done_when:     可选文本，描述该方向的完成判据
```

> M37 只落地了 `status`（`open | abandoned`）、`status_reason`、`status_at`、
> `status_by`；`refuted`、`done_when` 与 reopen 仍属于后续阶段。

尝试次数不落列：`runs.intent_id` 已经足够聚合出 attempts、最近 outcome 与最近错误。

### 5.2 状态迁移

| 从 | 到 | 触发 | 约束 |
| --- | --- | --- | --- |
| open | concluded | `concludeIntent` | 既有路径，必须产出 Fact |
| open | abandoned | 操作员或 reason 提议 | 必须仍然是 open；reason 每轮最多 1 个 |
| open | refuted | reason 提议（证据表明方向不可行） | 同 abandoned；用于区分“放弃”与“证伪” |
| abandoned/refuted | — | 终态 | 不重新派发；可由操作员显式 reopen（后续） |

- **reason 提议**：reason 输出新增可选 `abandon: [{intent_id, reason, kind: abandoned|refuted}]`。控制面校验：目标存在、仍 open、至少一次 finished attempt、每轮不超过 1 个、带非空 reason；不合法就丢弃并记日志。这与现有 `complete`/`intents` 输出的校验风格一致。
- **操作员**：`POST /projects/{id}/intents/{intent_id}/abandon`，走 `isCrossOrigin` + 可选 operator token，写 `status_reason`。终态意图在 UI 上显示徽标，不参与派发。
- **自动规则**（默认关闭）：连续 N 次失败且无产出才允许自动 abandon；阈值必须保守，且只作为兜底，不替代策略判断。

### 5.3 调度与视图

- open intent 的选择逻辑不变，只过滤 `status != open`。
- AgentContext 列出 abandoned/refuted 的意图与原因；reason 因此知道“这条方向已经被放弃”，不会重复提议。
- 完成判定不受影响：abandoned 意图不产生 Fact，也不会让项目完成。
- 报告与统计仍按 `runs` 真实执行数据统计，不因 abandon 改写历史。

## 6. 调度状态：让 DB 成为队列真相

### 6.1 现状

- 内存 `running` map 是派发与并发配额的权威；`runs` 是旁路。
- 意图/ reason 的租约在 `intents.worker`、`projects.reason_*`；pending conclude 已持久化。
- 重启后：租约按心跳过期恢复；`runs` 中 `outcome = NULL` 的行原先无人收尾，M38 起由启动
  对账补成 `inactive`（见 §13）。

### 6.2 目标

把「队列状态」与「进程监督」分开：

- **队列/租约**：DB 中的 claim 行（谁在什么时候认领了哪个 intent/任务、租约到何时）是唯一真相；scheduler 每个 tick 从 DB 派生可派发集合与 `running` 视图。
- **进程监督**：子进程句柄、容器名、信号仍留在内存；重启后通过 startup sweep 与 DB 对账，而不是依赖内存。
- **启动对账**（最小第一步）：把上一进程遗留的 `runs.outcome = NULL` 标为 `inactive`，detail 写 `control plane restarted before finish`；同时调用既有 `pending_concludes` 对账。它先解决读模型的幽灵任务，不改变派发路径。

### 6.3 迁移

- 先加 startup 对账（低风险、独立可测），观察一个版本；——M38 已落地，见 §13；
- 再把快层 claim 从内存 map 迁到 DB（新增 claim 字段或表，`intent_meta` 不够表达任务级租约）；——M39 计划见 §14；
- 全程保持 `runs` 列不变，避免破坏 `/runs`、`/stats`、`/cost` 与报告。

## 7. 完成与目标模型

### 7.1 现状

`goal` 是图里的一个 Fact；完成是模型声明 + oracle 检查“引用的事实是否可追溯”。`challenge` 是唯一真正的目标验证，`evidence` 更接近审计。部分完成、多 flag、子目标都没有进入决策输入。

2026-11-01 的 proj_030（web8）把这个缺口暴露得很完整：项目在第一个 bootstrap 任务后就被标成 completed，但 worker 的完成文本明确写着“flag 没有读到”。触发条件与修复计划见 §15。

### 7.2 目标条件

把 `verification` 从“单一策略”扩展为“目标条件列表”（旁路表，不动图）：

```text
goal_conditions:
  - kind: challenge     {challenge_code: web-01}
  - kind: flag_count    {min: 3}          # 可选，基于 flag_reviews/本地 flag
  - kind: evidence      {}                 # 既有的可追溯性
```

- 条件全部通过才允许完成；任一失败则完成声明被推迟，理由写回 `verification_checks` 并进入 AgentContext。
- 保留 `evidence` / `challenge` / `off` 作为现有别名，迁移期不改旧项目的行为。
- 不引入任意命令/HTTP 断言执行器（那是执行面，需要单独的安全设计）。
- 在目标条件落地前，`off` 与 `evidence` 仍可能把“未达成目标”声明当成完成；加固顺序与临时门见 §15。

### 7.3 意图的 `done_when`

- `intent_meta.done_when` 是可选文本，由 reason 提议、控制面长度校验后写入。
- explore 提示词获得该字段；conclude 与完成声明可以用它自检。
- 它是**建议性判据**，不替代证据校验；但能减少“worker 自己觉得做完了”导致的过早结论。

### 7.4 部分完成

AgentContext 输出 `progress: {found, total}` 与最近一次检查，reason 据此优先补齐剩余 flag；完成仍只在满足全部条件时发生。

## 8. 能力评估闭环

现有的 `tools/gate/*` 验证的是管线（计量、恢复、拦截、预算），不是能力。建议新增独立评估：

- `tools/eval/`：固定一组小型挑战（或本地靶场），每个挑战有确定性的 fake solver 场景与一次真实模型运行；
- 指标：完成率、平均成本、平均耗时、错误完成率（声明完成但未达目标条件）、平均尝试次数；
- 输出 `runs/eval-<date>.json`，与 milestone 记录并列；
- fake 场景进 CI（不计费），真实模型评估手动执行；
- 设计变更（如 AgentContext）先在评估集上对照，再进入默认配置。

## 9. 迁移计划

| 阶段 | 内容 | 兼容性 / 回滚 |
| --- | --- | --- |
| **A（已实现，M36）** | AgentContext v1：构建器、`agent-context.yaml`、追加式提示词段落、`strategy_context` 开关；覆盖 Fact 状态/证据/取代、验证进度、recent attempts、delta；预算沿用既有段落的数据 | 关掉开关即回到今天的行为；图与 golden 不变 |
| **B（已实现，M37，收窄）** | 意图生命周期：`intent_meta.status/status_reason/status_at/status_by`；reason 提议 abandon（默认关闭）；操作员路由；派发/提示/水位/AgentContext 过滤；UI 徽标与二次确认。`refuted`、`done_when`、reopen 留到后续 | 旧数据缺列合成 `open`；abandon 只影响未来的派发 |
| **C1（已实现，M38）** | 启动对账：`scheduler_instances` 心跳；无活跃同伴时把遗留 `runs.outcome = NULL` 标为 `inactive`；不动租约与派发路径 | `runs` 列不变；仅读模型从 running 变成 inactive；可单独回滚 |
| **C2（已实现，M39）** | DB claim：新增 `task_claims` 任务级租约账本；并发计数、`isIntentRunning` 与跨进程防重由 DB 派生；崩溃按实例心跳与租约过期接管 | 保留图级租约；可回退到 M38 的内存运行视图 |
| **D** | 目标条件与部分完成；`done_when` 进入提示词；评估集接入 milestone。完成契约的紧急加固与分阶段计划见 §15 | 旧 `verification` 作为别名保留 |

每个阶段的最小验证：
- A：构建器确定性、上限/截断、脱敏断言、session 文件存在、提示词段落存在、golden 不变；fake solver 端到端跑通。
- B：状态迁移表、非法提议丢弃、派发排除、操作员路由 403/409、UI 断言。
- C1：重启模拟（NULL run → inactive）、活跃同伴跳过对账、实例心跳过期、`/stats` 的 running 归零而 finished/inactive 增加；pending conclude 对账不变。
- C2：唯一活跃意图/reason；两个 scheduler 竞争只有一方成功；优雅停止立即释放；崩溃在租约到期后接管；`/runs` 带 `instance_id`。
- D：条件组合、失败理由回写、进度字段、评估报告。

## 10. 非目标与取舍

- 不改变 Cairn 图 schema、YAML/timeline 导出、对外 HTTP golden、worker 契约既有字段。
- 不在本文处理身份认证、多用户或平台化；那是一个独立的产品形态决策。
- 不搬迁 Host Bridge：它在不可信 worker 内是已知的设计张力，需要单独的安全设计（控制面判定、边车代理或容器网络策略），不与本投影层混在一起。
- 不把 Observer 改造成项目级 actor；本设计只让它的产出（看板、提案、失败信号）可通过旁路进入 AgentContext。
- 不为 reason 做完整的图切片调参；AgentContext 先给全量当前 Fact 与有界历史，salience/切片留到评估数据之后。

## 11. 风险与开放问题

- **上下文可能误导**：截断的 attempts/facts 会让模型误以为历史就是全部；必须显式 `truncated` 并在提示词里说明。
- **模型过度信任状态**：`evidence.status` 是元数据，不是内容证明；提示词要区分“有证据”与“证据支持结论”。
- **文件双份**：`graph.yaml` 与 `agent-context.yaml` 可能不一致（构建时刻相同，但一个是导出、一个是投影）；应在构建器里复用同一次读取，测试断言两者对同一 Fact 的描述一致。
- **成本**：给 reason 增加历史会抬高输入 token；先按上限与截断控制，用评估集比较收益。
- **确定性**：`generated_at` 之外必须可复现；测试注入时钟与固定排序。
- **开放问题**：explore 的切片是否应直接省略被取代的 Fact？reason 是否需要更细的预算/成本分解（既有段落只有总量）？AgentContext 是否需要版本化迁移（v1→v2）与回放测试？abandon 的自动规则阈值如何定？这些都需要真实模型数据。

## 12. 关键决策清单

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| AgentContext 的形态 | 任务级派生文件，不落库 | 不做第二份真相；可回放、可版本化 |
| 与图的关系 | 旁路叠加，`graph.yaml` 不动 | 保住 Cairn 兼容与 golden |
| 提示词接入 | 追加段落，不改模板 | 不触发 prompt golden 重生成 |
| 意图尝试次数 | 由 `runs.intent_id` 派生 | 不引入会漂移的计数器 |
| 意图终态 | `intent_meta` 新增状态列 | 不改 `intents` 形状 |
| 调度真相 | DB claim；内存只管进程监督 | 重启可对账，幽灵任务消失 |
| 完成契约 | 目标条件 + 既有 `verification` 别名 | 渐进迁移，旧项目不变 |
| 能力评估 | 独立 `tools/eval` | 与管线 gate 的职责分开 |

## 13. M38：启动对账（Phase C1，已实现）

### 13.1 目标

控制面重启后，上一进程留下的 `runs.outcome = NULL` 行没有任何进程能收尾：内存 `running`
map 已随进程消失，`/stats`、`/strategist` 与 AgentContext 的预算却仍把它们算作“运行中”。
M38 只解决这个读模型与进程生命周期不一致的问题，不改变派发路径。

非目标：不迁移快层 claim、不接管租约、不采纳仍存活的 worker 进程；这些属于 C2（M39）。

### 13.2 数据模型

新增旁路表 `scheduler_instances`：

```sql
CREATE TABLE IF NOT EXISTS scheduler_instances (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  stopped_at TEXT
);
```

- `id` 是每次 `Scheduler.start()` 生成的 boot 行（`boot-<12 hex>`），同一 boot 内不变；
  `heartbeat_at` 由 `armTimers()` 里独立的心跳定时器按 `leaseIntervalMs` 更新；`stop()` 写
  `stopped_at`，且写心跳/停止的 SQL 都带 `stopped_at IS NULL` 条件——已停止的 boot 不会复活。
- 不修改 `runs` 列。`inactive` 已经是 `RunOutcome` 的合法值，`/stats`、UI 与报告已按
  finished/inactive 统计，因此读模型自然收敛。
- 表随项目库一起迁移，旧库自动建表；没有行时视为“没有活跃实例”。

### 13.3 启动、心跳与停止

`Scheduler.start()` 的顺序（`reconcilePreviousBoot()`，实现见 `apps/cairn/src/scheduler/loop.ts`）：

1. 同一次 `db.withConn` 事务里 `registerSchedulerInstance()` 写入本进程的 boot 行
   （`heartbeat_at = started_at = now`，重复注册只刷心跳、不改 `started_at`）。
2. `listActiveSchedulerPeers()` 检查是否存在**其它**活跃同伴：`stopped_at IS NULL` 且
   `(now - heartbeat_at) <= instanceTimeout`。`instanceTimeout` 取
   `max(2 × runtime.interval, 30s)`；`now` 来自可注入的 `this.now()`，截断到秒，测试可固定时钟。
3. 没有活跃同伴时在同一事务里调用 `reconcileOrphanRuns()`：把全部 `outcome IS NULL` 的行写成
   `outcome = 'inactive'`、`finished_at = now`、`duration_ms = NULL`、detail 为
   `ORPHAN_RUN_DETAIL` = `control plane restarted before finish`；返回被关闭的行并逐条记日志，
   最后记一条 `startup reconcile closed N orphan run(s)`。
4. 有活跃同伴时跳过对账（返回 `null` 以区分“跳过”和“没有孤儿”）并记录
   `startup reconcile skipped: another scheduler instance heartbeats within Ns`。两个 scheduler
   共用一个库本来就不是受支持部署；M38 只保证不会误杀另一个**仍在心跳**的控制面。
5. 注册/查询/对账任一 SQL 失败只记 `startup reconcile failed: ...`，不阻塞启动。
6. 继续已有的 `sweepNow()`（pending conclude、session 保留、工件刷新），然后 `armTimers()` 进 tick。

心跳与停止：`armTimers()` 额外挂一个 `heartbeatTimer`，按 `leaseIntervalMs` 调
`heartbeatSchedulerInstance()`——不搭 tick 回调，避免一次慢 tick 让本进程被同伴判为死亡；
`reconfigure()` 重挂时一并重建。`stop()` 先清定时器、再 `stopSchedulerInstance()` 写
`stopped_at`，然后取消任务与关闭 runtime。崩溃不会写 `stopped_at`，因此下一次启动只能依赖
心跳过期判断，而不是只看状态列。

对账本身是幂等的：第二次执行没有 `outcome IS NULL` 行，返回空数组、不写任何行。

### 13.4 读模型与预算

- `/stats` 与 `/report`：原先的幽灵任务从 `running` 变为 `finished` 且 `inactive + 1`；
  succeeded / failed / rejected 不变，Token 与成本不变。
- `/strategist` 与 `AgentContext.budget.running_tasks` 直接过滤 `outcome === null`，对账后
  自然归零；`budget.exhausted.tasks` 随之解除。
- `/projects/{id}/runs` 原样显示新 outcome 与 detail；不需要新路由，也不新增写路由。
- `/strategist` 的 recent-runs 视图按 `finished_at IS NOT NULL` 过滤，对账后这些孤儿 run 才
  第一次出现在视图里——这是预期的可见性变化，不是新统计口径。副作用：零产出连续计数
  （`countZeroOutputStreak`）读的正是这个列表，一次重启最多把 streak 抬高遗留任务的数量，
  可能更快触发 `zero_output:N`；它仍受冷却、小时配额与 `tasks_running` 抑制约束。

### 13.5 边界与风险

- **worker 可能比控制面活得久**：容器模式下 `docker exec` 进程可能继续写 session 目录。
  M38 只把 run 标为 inactive，不删除 session；旧 worker 之后写出的 result 不会被导入，
  这是一次性可见语义，必须在 detail 与文档里说清楚。
- **时钟**：boot 行、同伴判定与 `finished_at` 都取 `Scheduler.now()`（测试可注入，截断到秒），
  `reconcileOrphanRuns()` 不传 `finishedAt` 时退回 `utcnow()`；实例超时至少两个 interval，
  避免单次抖动误判。
- **每次启动换新 boot id**：`start()` 生成随机 id，因此重启后的进程不会把自己上一世的行当成
  活跃同伴；同一进程内重复 `start()` 幂等（`timer !== null` 直接返回）。
- **不释放租约**：意图 / reason 租约仍按各自心跳 TTL 过期，避免控制面刚重启就把仍在运行的
  worker 挤掉；这也是 M38 不改变派发路径的原因之一。
- **测试隔离**：只有 `start()` 注册实例并做对账；`runUntilIdle()` 不触发，因此现有测试中
  人为保留的 NULL run 不受影响。

### 13.6 验收（已达成）

- `packages/graph/src/runs.test.ts`：两个 NULL + 一个 finished；对账后只改 NULL 行，
  outcome/finished_at/duration/detail 正确，`duration_ms` 置 NULL，第二次调用返回空数组。
- `packages/graph/src/scheduler-instances.test.ts`：boot 行注册与重复注册、已停止的 boot 不复活、
  同伴窗口（30s 边界算活跃）、心跳不可解析视为死亡。
- `apps/cairn/src/scheduler/startup.test.ts`：旧库启动 → 全部 inactive 且日志含计数与 boot id；
  活跃同伴 → 跳过（run 仍 NULL）；同伴心跳过期（1h）→ 允许对账；`stop()` 后重启 → 立即视为死亡
  实例；意图/reason 租约不被释放；pending conclude 仍按原逻辑记 `session missing`；心跳按
  `leaseIntervalMs` 前进并能阻止新实例对账。
- `packages/graph/src/stats.test.ts`、`apps/cairn/src/http/api.runs.test.ts`：running 归零、
  finished + N、inactive 计数正确，`/projects/{id}/runs` 显示新 outcome 与 detail；
  `api.strategist.test.ts` 与 `agent-context.test.ts`：`running_tasks` 归零、`exhausted.tasks`
  解除、Token 与成本不变。
- `bun run check` 全量通过（1017 tests / 92 files）；版本 `0.61.0-m38`。

### 13.7 之后：C2（已实现，M39）

M38 之后的任务级 claim 已按 §14 落地：DB 的 `task_claims` 成为运行中任务的权威账本，并发计数、
`isIntentRunning` 与慢层抑制都从它派生，同时保留 `intents.worker` / `projects.reason_*` 作为图级
租约与 UI 镜像。M38 的孤儿 run 对账逻辑不变，仍只在没有活跃同伴时执行。

## 14. M39：DB claim（Phase C2，已实现）

### 14.1 目标

M38 修好了重启后的**读模型**，但“当前有哪些任务在跑”仍由进程内 `this.running` map 决定：
`maxWorkers` / 单项目并发、`isIntentRunning`、慢层触发抑制与 execution mode 切换都读它。
两个 scheduler 共用一个库时，各自的内存 map 互相不可见；一个崩溃后留下的任务级所有权也没有
DB 记录，只能等图级租约按 TTL 过期。

M39 把**运行中任务的 claim** 写进 DB，并让调度计数从 DB 派生。图级租约
（`intents.worker`、`projects.reason_*`）继续保留：它们是派发选择与 UI 的镜像，不是 M39
要替换的对象。

非目标：

- 不做多控制面集群或 leader 选举；只让“误开第二个 scheduler”不会重复执行同一意图。
- 不把 `intents.worker` / `projects.reason_*` 迁走，也不改变 `pending_concludes` 语义。
- 不新增写路由，不改图 schema、YAML/timeline 导出与 worker 契约既有字段。

### 14.2 数据模型

```sql
CREATE TABLE IF NOT EXISTS task_claims (
  task_id TEXT PRIMARY KEY,          -- 与 task.json 的 taskId 相同
  run_id TEXT,                       -- 同一事务里生成的 runs.id，便于归因
  instance_id TEXT NOT NULL,         -- scheduler_instances.id
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  intent_id TEXT,                    -- reason 为 NULL
  kind TEXT NOT NULL,                -- bootstrap | reason | explore | conclude
  worker TEXT NOT NULL,
  created_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS task_claims_active_intent
  ON task_claims(project_id, intent_id)
  WHERE released_at IS NULL AND intent_id IS NOT NULL AND kind <> 'reason';

CREATE UNIQUE INDEX IF NOT EXISTS task_claims_active_reason
  ON task_claims(project_id)
  WHERE released_at IS NULL AND kind = 'reason';

CREATE INDEX IF NOT EXISTS task_claims_instance
  ON task_claims(instance_id, released_at);
```

实现相对本节的唯一加料：`project_id` 带项目外键并级联删除，与其余旁路表一致——否则删除
项目会在账本里留下无人认领的行。`instance_id` **不**建外键：接管规则要读拥有者那次启动的
`stopped_at` / 心跳，而“没有实例行”本身就是一种死亡判定，级联删除反而会抹掉接管证据。

`runs` 增加可空列 `instance_id`（`ensureRunColumns`，旧行保持 `NULL`），由 `startRun` 写入；
`/projects/{id}/runs` 的响应增加同名字段。旧库自动建表、补列，没有行时视为“没有运行中任务”。

### 14.3 claim 生命周期

- **获取**：`startClaimed()` 的同一个 `db.withConn` 事务里，在现有图级 claim 之后、`startRun`
  之前插入 claim（`task_id = prepared.task.taskId`）。唯一索引冲突即抛出 409，事务回滚图级
  claim 与已生成的任务文件，外层按既有的 `claim lost` 跳过。
- **续租**：`renewLease()` 同时更新图级心跳与 `task_claims.lease_expires_at`；任一更新影响
  0 行即返回 false，沿用 `leaseLost` 取消路径。`lease_expires_at` 取该 kind 的既有超时
  （`getIntentTimeout` / `getReasonTimeout`），不新增配置项。
- **释放**：`finish()` 无条件按 `task_id` 释放 claim（`released_at`、`release_reason`），
  与图级租约的释放／保留分开：失败 explore 仍保留意图租约等待 conclude，但它的任务 claim
  已经结束；conclude 派发时插入新的 claim。
- **spawn 失败**：`startProcess()` 返回 false 的路径同时释放 claim 与图级租约。
- **幂等**：重复释放只更新 `released_at IS NULL` 的行；已释放 claim 不会复活。任务 id 每次派发
  重新随机生成，所以同一个 `task_id` 再次出现一定是异常，`claimTask()` 对已释放的行直接抛 409
  而不是把它悄悄复活。

### 14.4 调度计数从 DB 派生

`this.running` 保留为**进程句柄表**：`waitForIdle()`、`cancel()`、runtime 切换与信号仍用它。
以下判断改为查询未释放且未过期的 claim：

- 全局 `maxWorkers` 与 `maxRunningProjects`；
- 单项目 `maxProjectWorkers` / `budget.maxProjectTasks`；
- `isIntentRunning()`（pending conclude 对账、慢层触发抑制）；
- 新 tick 的“是否还有空位”判断。

`runningCount` 与 `busy` 仍表示本进程句柄（API 语义不变）；配额判断改读每 tick 构造一次的
claim 视图：`listActiveTaskClaims(now)` 打底，再并上 `this.running` 里尚未按 `task_id` 计入的
句柄，派发成功时就地累加，所以同一 tick 不会超卖，也不需要第二次查询。视图永不为空——读账本
失败时退化为“只按本地任务计数”并记一次日志，派发不会因此停摆。这样单进程时两者一致，第二个
scheduler 出现时配额是全局的，而 execution mode 切换不会被别人的任务阻塞。

慢层的抑制条件也走同一个视图：`productiveByProject`（非 reason claim 数）替代本进程的运行任务
数，`intentsByProject` 替代本进程正在跑的意图集合——peer 的 explore 工作和自己的探索一样压制慢层。

### 14.5 启动、停止与租约接管

- **实例身份**：`instanceId` 改在 Scheduler 构造时生成；`start()` 注册并做 M38 对账；
  未调用 `start()` 的测试在第一次 claim 前惰性注册（只注册，不对账），保证 claim 的
  `instance_id` 非空且各 Scheduler 实例互不相同。
- **优雅停止**：`stop()` 取消并等待本进程任务，`finish()` 释放各自 claim；随后
  `releaseTaskClaimsForInstance(instanceId, "shutdown")` 兜底，最后写 `stopped_at`。
- **崩溃**：进程不会写 `stopped_at`，claim 保留。启动（以及 `sweepNow`）按以下规则接管：
  - 所属实例 `stopped_at IS NOT NULL`：立即释放，reason `instance stopped`；
  - 所属实例心跳过期且 `lease_expires_at <= now`：释放，reason `owner instance expired`；
  - 心跳过期但租约未到期：保留并记日志，等 TTL 到期——这与 M38“重启不抢仍可能活着的
    worker”一致；
  - 所属实例仍在心跳：绝不接管，即使 claim 租约已过期（先让它自己的续租逻辑取消任务）。
- **sweep**：每个 `sweepNow()` 增加一次过期 claim 清理；不删除行，只写 `released_at`。
  已释放行暂不裁剪（一行一个任务，量级可控），后续需要时再加保留策略。

### 14.6 双 claim 与并发验收（已达成）

- `task-claims.test.ts`（13 例）：所有权行逐字段相等、活跃意图唯一（含 409 文案、冲突不留下
  半行、跨项目与不同意图互不干扰）、reason 槽唯一且能与 explore claim 并存、释放幂等（`success`
  不被后来的 `failed` 覆盖、未知 task id 返回 false、槽位立刻让给下一个 task、已释放的 task id
  再 claim 一律 409）、活跃查询按秒精度剔除过期与已释放（到期时刻等于 `now` 即视为过期）、续租
  推后 `lease_expires_at` 且释放后续租返回 false、按实例批量释放的次序与空转、拥有者已停止 →
  立即释放、拥有者死亡但租约未到期 → 先 `waiting` 再到期释放、拥有者仍在心跳 → 即使过期也不碰、
  实例行缺失按死亡处理、接管后新 claim 可以补上、已释放行只改不删（`COUNT(*)` 仍为 1）。
- `scheduler/claims.test.ts`（7 例，两个 Scheduler 共用一个临时库、共享一个可注入时钟）：
  一个派发写一行 claim 且 `runs.instance_id` 与拥有者 boot 一致、从未 `start()` 的实例也有一条
  自己的 `scheduler_instances` 行；B 只靠账本挡住同一意图（A 释放后 B 立即接上）；reason 槽
  跨进程唯一，先由视图挡住，再释放图级租约逼出唯一索引的 409，失败方的图级租约随事务回滚；
  `max_workers: 1` 时 B 的空 `this.running` 不会让它多开一个任务；优雅停止后 B 立刻派发；
  崩溃拥有者在心跳过期但租约未到期时只留下 `stale claim waiting`，租约到期才记
  `stale claim released` + 计数并让 B 接管（接管只动账本，意图的图级租约仍是死掉那个 boot 的）；
  仍在心跳的拥有者即使租约已过也不被接管。
- `loop.test.ts` 等既有 153 例 scheduler 用例保持通过：spawn 失败、取消、leaseLost、pending
  conclude 都释放 claim；`runningCount` / `busy` 语义不变。
- `runs.test.ts` / `api.runs.test.ts`：`instance_id` 落库并出现在 `/runs` 响应，不写它的旧行保持
  `null`。
- 全量 `bun run check` 通过（1038 tests / 94 files / 4234 expects，2026-11-01）；版本 `0.62.0-m39`。

### 14.7 兼容、回滚与风险

- **双写过渡**：M39 同时维护图级租约与 claim。回退到 M38 代码时 claim 表被忽略，图级租约
  仍然完整，派发不会失效；这是 M39 的回滚边界。
- **为什么必须双写**：两个控制面都以同一个 `WORKER_NAME`（`cairn-worker`）认领图级租约，
  `intents.worker` 里看不出是哪个进程，所以只有 `task_claims` 的两个部分唯一索引能真正拒绝
  重复派发。相应地，派发失败的 403/409 分支**不能**调用 `releaseBestEffort`：抢不过的一方
  一旦释放租约，就会把拥有者还在跑的图级租约也清掉。
- **漂移**：任何“claim 更新成功、图级租约更新失败”都会让两套状态不一致。所有写入必须放在
  同一个事务里；`releaseBestEffort` 与 `finish` 的测试要断言两边的最终状态。M39 只记录
  漂移告警，不自动“修复”图级租约。
- **旧 worker 比控制面活得久**：崩溃接管仍要求租约到期，避免容器里的旧进程与新任务并发写
  同一工作区；代价是崩溃后最多等待一个 intent/reason 超时。
- **测试隔离**：每个 Scheduler 有独立 `instanceId`；测试库互不共享时 claim 行随临时库删除。
  共享库的测试必须显式释放或等待租约，避免串扰。
- **迁移顺序**：先落 claim 表与双写（M39），观察一个版本；再考虑用 claim 直接派生可派发
  集合、删除部分图级租约判断（后续阶段）。M39 不改变“哪个意图可以被派发”的选择逻辑。

## 15. 完成契约加固（H1 已实现 M40；H2 已实现 M41）

### 15.1 触发案例与三个缺口

2026-11-01 的 proj_030（web8）在第一个 bootstrap 任务结束后就被标成 completed，但 worker 的
`complete.description` 原文是：

> Goal NOT definitively achieved: the flag value at /flag was not read… completion cannot be
> claimed.

这不是模型“擅自停止”那么简单，而是三个独立缺口叠加：

1. **`verification: off` 无条件放行**：`VerificationService` 对 `off` 直接返回
   `ok: true`，模型只要交出 `complete`，项目就会被关闭。
2. **bootstrap 契约强制 `complete`**：`validateBootstrapExecutePayload` 把 `complete` 当作
   必填；bootstrap 没有“只交 fact、保留未完成状态”的合法形状。模型被软截止要求收尾时，
   只能在“违反提示词”和“违反契约”之间二选一。
3. **`evidence` 不是目标验证**：`evidence` 只检查完成声明引用的 Fact 是否有可追溯的文件证据。
   proj_030 的 bootstrap fact 有 6 个证据文件，所以即使把 `off` 改成 `evidence`，同样的
   “没有 flag”完成声明仍会通过。只有 `challenge` 计数或新的 `flag_count` 条件能判断 flag。

此外，proj_030 的 bootstrap 配置是 120 秒超时、96 秒软截止。模型在 96 秒收到收尾指令时还没
绕过 `/app/flask_app.py` 里对 `flag`、`*`、`?` 的子串过滤；它已经拿到了 `/admin` 任意文件
读取、源码和根目录列表（看到 `/flag` 存在），但没有读到 flag 值。软截止本身不是根因，但它
决定了“未完成时也必须交卷”，从而触发了前两个缺口。

### 15.2 目标与非目标

目标：

- 允许 bootstrap 诚实地以“有进展、未完成”结束，并让项目继续进入 reason/explore。
- `off` 不再等同于“模型说完成就完成”；没有自动校验时，完成必须由操作员确认。
- 自动完成必须至少有一个**客观目标条件**（`challenge` 或确认过的 `flag_count`）；
  `evidence` 只作为附加的可追溯性条件。
- 所有改动保持旁路表与追加式提示词；不改图 schema、YAML/timeline 导出、HTTP golden 和
  worker 契约既有字段。

非目标：

- 不引入任意命令、HTTP 断言或脚本执行器；那属于执行面，需要单独的安全设计。
- 不把身份认证、多用户或平台化纳入本次加固。
- 不改变“哪个意图可以被派发”的选择逻辑；本计划只改完成判定与 bootstrap 收尾。

### 15.3 H1：bootstrap fact-only

这是最小、最直接的修复。

**契约**（`packages/contracts/src/payloads.ts`）：

- `validateBootstrapExecutePayload` 的返回值从 `rejected | complete` 扩展为
  `rejected | fact | complete`。
- `complete` 变为可选；缺省时返回 `{ kind: "fact", data: { factDescription } }`。
- `looksLikeBootstrapExecuteData` 同时接受 `["fact"]` 与 `["fact", "complete"]`。

**调度**（`apps/cairn/src/scheduler/loop.ts`）：

- `applyBootstrap` 始终 `concludeIntent` 并记录证据。
- fact-only：只结束 bootstrap 意图，不调用 `completeProject`，项目保持 active；下一轮进入
  reason/explore。
- 带 `complete`：保留现有的 flag 复核、拒绝引用检查与 verification 门。
- `completionClaim` 只在 payload 真的带 `complete` 时为 bootstrap 返回验证请求，避免
  fact-only 也去调用 challenge oracle。

**提示词**（`apps/cairn/src/prompts/default/bootstrap.md`）：

- 明确列出两种合法输出：
  - 未完成：`{"accepted": true, "data": {"fact": {"description": "..."}}}`
  - 已完成：`fact` + `complete`
- 写明：被 conclude / 软截止要求收尾时，如果目标未达成，返回 fact-only，不要把否定结论写进
  `complete`。
- 保留“不要拒绝任务、继续工作”的既有规则。

**兼容性**：旧 worker 继续返回 `fact + complete` 不受影响；`complete` 从必填变可选是向后
兼容的，不需要升 task protocol 版本。

**测试**：

- `parse.test.ts`：fact-only 合法、fact+complete 合法、缺 fact 报错、空 complete 报错。
- `loop.test.ts`：fact-only bootstrap 后项目 active、bootstrap 意图已结论、没有 goal 意图；
  下一 tick 会派发 reason/explore。
- 用 proj_030 的 `result.json` 造一个回归夹具，断言不再关闭项目。

### 15.4 H1：`off` 完成人工确认

即使 bootstrap 不再强制 `complete`，模型仍可能主动乱报完成。`verification: off` 的语义应
改为“没有自动校验”，而不是“无条件相信模型”。

**数据模型**：

```sql
CREATE TABLE IF NOT EXISTS completion_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  from_facts TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS completion_reviews_one_pending
  ON completion_reviews(project_id) WHERE status = 'pending';
```

**scheduler 流程**：

- `applyBootstrap` / `applyReason` 收到 `complete` 且策略为 `off` 时：
  - 写 pending review，不调用 `completeProject`；
  - 项目保持 active，日志记 `completion deferred project=...: verification is off`；
  - 释放任务 claim 与相应租约；已有的 flag review pending 逻辑仍然优先。
- 同一项目重复出现完成声明时更新 pending 行，而不是堆积多条。

**操作员路由**：

- `GET /projects/{id}/completion-review`：返回 pending 记录与历史。
- `POST /projects/{id}/completion-review/{review_id}/decision`：
  - `approve`：调用 `completeProject`，`from` 使用记录里的 `from_facts`，描述使用记录文本；
  - `reject`：记录一条 Hint 说明“操作员拒绝完成声明，请继续探索”，项目保持 active。
- 守卫与其它写路由一致：跨源拒绝，配置 `CAIRN_OPERATOR_TOKEN` 时要求
  `X-Cairn-Operator-Token`。

**UI**：项目页显示“模型请求完成，等待确认”横幅，展示完成描述和来源 Fact，提供
「确认完成 / 继续探索」。项目页同时显示当前完成校验模式。

**配置**：

```yaml
verification:
  off_completion: manual   # manual | auto
```

- `manual`（默认）：`off` 项目的完成声明进入人工确认。
- `auto`：保留当前的实验行为，仅用于不需要人工的沙盒；必须在 CONFIG 中说明风险。
- 该键进入配置校验与只读视图；不通过运行时 UI 热改。

### 15.5 H2：目标条件（真正的“拿到 flag 才完成”，已实现 M41）

H1 解决了“没人看就自动完成”，H2 解决“有人看之前，oracle 也应该能判断”。

**数据模型**（旁路表，不动图）：

```sql
CREATE TABLE IF NOT EXISTS project_goal_conditions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- challenge | flag_count | evidence
  config TEXT NOT NULL DEFAULT '{}',     -- 例如 {"min":1} / {"challenge_code":"web-01"}
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, ordinal)
);
```

**条件语义**：

- `challenge`：沿用现有外部挑战服务计数；全部计数达标才算通过。
- `flag_count`：只统计操作员确认过的真实 flag（`flag_reviews.status IN
  ('real_more','real_done')`）以及挑战服务已确认的捕获数，**不采信模型自述或未复核的候选**。
  `config.min` 为正整数；未达到即推迟完成。
- `evidence`：保留现有可追溯性检查，但它只是附加条件，不能单独证明目标达成。
- 所有条件 AND；任一失败时写回 `verification_checks`，detail 指明哪个条件失败、差多少。
- 没有 `project_goal_conditions` 的旧项目从现有 `project_verification` 合成一个条件，行为
  与今天一致。

**完成流程**：

1. worker 声明 `complete`；
2. 控制面校验载荷形状与证据；
3. 逐个评估目标条件；
4. 全部通过才 `completeProject`；否则项目保持 active，失败理由进入
   `verification_checks` 与 AgentContext；
5. AgentContext 输出逐条件进度，reason 优先补未完成条件。

**默认策略**：自动完成至少需要一个客观条件（`challenge` 或 `flag_count`）。只有
`evidence` 条件或 `off` 的项目默认进入 H1 的人工确认；这避免“有证据文件但没拿到 flag”再
次被自动关闭。需要完全自动的实验项目可显式配置 `verification.evidence_completion: auto`
放宽（默认 `manual`）。

**兼容性**：`verification: challenge | evidence | off` 继续作为创建时的别名；旧项目不重建
条件行，读取时按单条件解释。

### 15.6 H3：预算、提示与评估

- **超时**：demo 的 bootstrap 120 秒 / 软截止 96 秒对真实 Web 题偏短；建议
  `tasks.bootstrap.timeout` 提到 600 左右（软截止 480），或为 bootstrap/explore 提供独立的
  软截止比例。软截止仍保留，但配合 fact-only 后，收尾不再等于完成。
- **UI**：创建项目时显示实际解析出的完成校验策略（`auto` 可能解析成 `off` 或 `evidence`），
  当策略没有客观目标条件时给出警告；项目页增加校验模式徽标。
- **评估**：按 §8 建立 `tools/eval/` 基线，至少覆盖单 flag、部分 flag、错误完成、预算耗尽、
  证据缺失；H1/H2 落地前后用同一组场景对比完成率、错误完成率、成本、耗时和尝试次数。
- **回归**：把 proj_030 的 `result.json` 作为固定夹具，覆盖：
  - `off` + 否定 `complete` → pending review，项目 active；
  - fact-only bootstrap → 项目 active 并继续调度；
  - `evidence` 有证据但无 flag → H2 后必须被 `flag_count` 条件拒绝；
  - `challenge` 计数不足 → 完成声明被拒绝。

### 15.7 兼容、回滚与风险

- **bootstrap 契约**：`complete` 可选是加法变更；旧 worker 与新控制面、旧控制面与新 worker
  的组合都仍能工作。fact-only 结果在旧控制面上会被判为“complete is required”，因此部署时
  应让控制面先升级，或让 worker 在旧控制面上继续返回 complete。
- **新表**：`completion_reviews` 与 `project_goal_conditions` 都是旁路表；回退到旧代码时被
  忽略，图与租约不受影响。pending review 可以留在库里，不影响调度。
- **行为变化**：`off_completion: manual` 是默认行为变化；需要旧行为的部署显式设 `auto`。
  H2 的“自动完成需要客观条件”同样改变了仅 evidence 项目的完成路径：M41 起默认进入人工
  确认，需要旧行为的部署显式设 `evidence_completion: auto`。详见 MILESTONES 与 CONFIG。
- **模型语义**：不要尝试用“描述里有没有否定词”判断完成；这不可靠。结构性修复是 fact-only
  契约、客观条件与人工确认。
- **旧 worker 存活**：与 §14.5 相同，人工确认不改变租约与 claim 的接管规则。

### 15.8 验收

- `bun run check` 全量通过；新增测试覆盖上述四类回归。（M41 达成：1114 tests /
  96 files / 4595 expects。）
- `completion_reviews` 的 approve/reject 路由有 403/404/409/400 边界测试。
- `flag_count` 只统计操作员确认的 flag；未复核候选不计入。（M41 达成。）
- AgentContext 输出逐条件进度与最近一次失败理由；reason 能在下一轮看到“还差 flag”。
  （M41 达成：`goal.verification.conditions`。）
- proj_030 原始结果重放不再关闭项目。

### 15.9 落地顺序

| 阶段 | 内容 | 预计 |
| --- | --- | --- |
| H1a ✅ | bootstrap fact-only：契约 + 提示词 + scheduler + 回归 | 0.5–1 天 |
| H1b ✅ | `off` 完成人工确认：表 + 路由 + UI + 配置 | 1–2 天 |
| H2 ✅ | `goal_conditions` + `flag_count`/`challenge` + 部分完成 | 2–3 天 |
| H3 | bootstrap 超时、创建页警告、评估集回归 | 0.5–1 天 |

H1 是安全门，H2 是完成契约的正确形态，H3 是测量与体验收尾。执行模式在落地时编为 M39b，
因此 H1 作为 M40、H2 作为 M41 实现；H3 仍待排期。

### 15.10 M40 实现记录（H1）

- **bootstrap 契约**：`validateBootstrapExecutePayload` 返回 `rejected | fact | complete`；
  `complete` 可选，缺省时只返回 `factDescription`。裸载荷同时接受 `["fact"]` 与
  `["fact", "complete"]`。`completionClaim` 只在载荷真的带 `complete` 时请求 oracle。
- **调度语义**：`applyBootstrap` 始终结论 bootstrap 意图并记录证据；fact-only 只记日志
  `bootstrap completed without a goal claim`，项目保持 active，下一轮 reason/explore 继续。
  带 `complete` 时原有 flag 复核、拒绝引用与 oracle 检查顺序不变。
- **`off` 人工确认**：旁路表 `completion_reviews`（每个项目最多一条 pending），scheduler 在
  `verification.kind === "off"` 且 `off_completion: manual` 时写 pending 并保持 active；重复
  声明刷新同一行。`completeProject` 会关闭遗留 pending，避免之后误批准。
- **操作员路由**：`GET /projects/{id}/completion-review`（pending + 历史）与
  `POST /projects/{id}/completion-review/{review_id}/decision`（`approve | reject`）。
  approve 用记录的 `from_facts` 与描述调用 `completeProject`；reject 记录终态并写一条去重
  Hint。写路由跨源 403，配置 token 时要求 `X-Cairn-Operator-Token`。
- **UI/配置**：项目页在 active 且有 pending 时显示「完成确认」横幅，可确认完成或继续探索；
  项目详情与独立路由返回同一份摘要。`verification.off_completion` 默认 `manual`，只读展示，
  不在运行时热改；`auto` 保留旧行为。
- **验证**：`bun run check` 通过（1089 tests / 96 files / 4485 expects，2026-11-01）。新增
  `completion-reviews.test.ts` 8 例、`api.completion-review.test.ts` 6 例，以及
  `verification-gate.test.ts` 的 fact-only / proj_030 负向 complete / 人工批准用例；
  prompt golden 与 API golden 已同步。H2 的 `goal_conditions` 和 `flag_count` 当时仍未
  实现，因此 `evidence` 只证明可追溯、不证明拿到 flag 的限制在 M40 仍存在；该限制由 M41
  的 `flag_count` 条件解决。

### 15.11 M41 实现记录（H2）

- **存储**：旁路表 `project_goal_conditions(project_id, ordinal, kind, config,
  created_at)`；`verification_checks` 增加 `conditions` JSON 列。`setProjectGoalConditions`
  整体替换有序条件并同步 `project_verification` 兼容别名；单条件项目继续由别名驱动，
  多条件列表为权威来源。没有条件行的旧项目读取时按别名合成一个条件。
- **创建契约**：`POST /projects` 接受 `goal_conditions`（1–8 条，`challenge` 需
  `challenge_code`，`flag_count` 需 1–10000 的整数 `min`，`evidence` 无配置），与
  `verification` 互斥；`verification: challenge | evidence | off` 仍是创建别名。
- **判定**：oracle 逐条件 AND 评估。`challenge` 复用外部计数；`flag_count` 只累加
  `flag_reviews.status IN ('real_more','real_done')` 与挑战服务已确认的捕获数；
  `evidence` 保留可追溯性检查。失败时写回 `verification_checks.conditions`，detail 指明
  失败条件与差多少；单条件项目的 detail 与 M40 保持一致。
- **完成流程**：全部条件通过后，只有存在客观条件（`challenge` / `flag_count`）才自动完成；
  仅 `evidence` 或无条件项目进入 H1 人工确认（`verification.evidence_completion`，默认
  `manual`，`auto` 保留旧行为）。`off_completion` 只负责无条件项目。
- **AgentContext / UI**：`goal.verification.conditions` 输出逐条件 `ok`、最近 detail 与
  `found/total` 进度；项目详情的 `goal_conditions`、`/projects/{id}/verification`、
  `/projects/{id}/report` 也暴露同一列表，项目页「完成判定」显示逐条状态。
- **兼容性**：`verification` 别名继续存在；旧项目不重建条件行。回退旧代码时新表与新列被
  忽略。
- **验证**：`bun run check` 通过（1114 tests / 96 files / 4595 expects，2026-11-01）。
  新增 `verification.test.ts` 的条件存储/别名/校验用例、`oracle.test.ts` 的多条件 AND 与
  flag 计数用例、`verification-gate.test.ts` 的 evidence 人工确认 / `auto` 放宽 /
  flag_count 完成后重试用例、`agent-context.test.ts` 的逐条件进度用例，以及 API 创建与
  详情用例；API golden 与报告字段同步。UI 仅增加只读展示，创建页的客观条件输入与警告留给
  H3。

## 附录 A：当前提示词输入

| 模板 | 占位符 |
| --- | --- |
| `bootstrap.md` | `{origin}` `{goal}` `{hints}` |
| `reason.md` | `{graph_yaml}` `{fact_ids}` `{open_intents}` `{max_intents}` |
| `explore.md` | `{graph_yaml}` `{intent_id}` `{intent_description}` |
| `explore_conclude.md` | `{graph_yaml}` `{intent_id}` `{intent_description}` |
| `bootstrap_conclude.md` | `{origin}` `{goal}` `{hints}` |

`graph_yaml` 始终替换为文件路径引用；附件与证据策略以追加段落的形式写入，不改模板。

## 附录 B：旁路表清单

| 表 | 作用 |
| --- | --- |
| `runs` | 每次 worker 任务的 outcome、耗时、模型、用量、detail |
| `fact_meta` | Fact 的 run、证据状态/引用、取代边 |
| `fact_evidence` | 证据文件的 size/SHA-256 |
| `intent_meta` | 意图优先级、预算、来源、去重键、创建 run |
| `strategist_state` | 慢层水位、失败、重规划标记 |
| `project_verification` / `verification_checks` | 完成策略与每次 oracle 判定 |
| `flag_reviews` | flag 候选的人工复核与终态 |
| `project_artifacts` / `project_attachments` | 工件索引 / 题目附件账本 |
| `proposals` | Observer 提案与审核结果 |
| `pending_concludes` | 待恢复的 conclude 队列 |
| `audit_events` / `audit_stream_lost` | 工具调用哈希链与实时流丢失 |
| `scheduler_instances` | 每次控制面启动的 boot 行与心跳（M38） |
| `task_claims` | 派发任务的所有权账本与跨进程防重索引（M39） |
| `completion_reviews` | `verification: off` 时模型完成声明的人工确认队列（§15 H1，M40） |
| `project_goal_conditions` | 挑战 / flag 数 / 证据等目标条件列表（§15 H2，M41） |
| `project_writeups` | 已生成的 Writeup |
| `project_scopes` | 授权范围 |
| `runtime_config_overrides` | 运行时配置覆盖 |

## 附录 C：症状到阶段

| 症状 | 阶段 |
| --- | --- |
| S1 陈旧 Fact、S2 证据不可见、S4 flag 进度 | A |
| S3 执行记忆、S5 意图失败态 | A（历史） + B（状态与淘汰） |
| S6 调度双真相 | C1（启动对账） + C2（DB claim） |
| S8 未达目标却被完成（bootstrap 强制 complete / off 自动完成） | §15 H1 |
| S9 目标无法自动验证（evidence 只证明可追溯） | §15 H2（M41） |
| 完成契约、部分完成 | D |
| 能力不可度量 | 评估集（可独立开始） |
