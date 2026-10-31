# 设计文档：AgentContext —— 让决策者看到系统知道的

状态：**Phase A 已实现（M36）；Phase B 已实现（M37，收窄为 `abandoned`，不含
`refuted` / `done_when` / reopen）；Phase C1 已规划为 M38，C2 与 Phase D 仍为草案**。
本文只讨论结构与语义，不代表后续阶段已经排期。实现记录见 `docs/MILESTONES.md`。
兼容性约束：不改变 Cairn 图的形状、YAML 导出、对外 HTTP golden 与 worker 契约中的既有字段。

## 1. 摘要

系统的数据模型已经分了两层：一层是 Cairn 兼容的**图**（facts / intents / hints），另一层是围绕图生长的**旁路表**（runs、证据、完成验证、取代边、flag 复核、附件、成本……）。但还缺第三层：**给做决策的 agent 看的投影**。

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
- 重启后：租约按心跳过期恢复；`runs` 中 `outcome = NULL` 的行无人收尾。

### 6.2 目标

把「队列状态」与「进程监督」分开：

- **队列/租约**：DB 中的 claim 行（谁在什么时候认领了哪个 intent/任务、租约到何时）是唯一真相；scheduler 每个 tick 从 DB 派生可派发集合与 `running` 视图。
- **进程监督**：子进程句柄、容器名、信号仍留在内存；重启后通过 startup sweep 与 DB 对账，而不是依赖内存。
- **启动对账**（最小第一步）：把上一进程遗留的 `runs.outcome = NULL` 标为 `inactive`，detail 写 `control plane restarted before finish`；同时调用既有 `pending_concludes` 对账。它先解决读模型的幽灵任务，不改变派发路径。

### 6.3 迁移

- 先加 startup 对账（低风险、独立可测），观察一个版本；
- 再把快层 claim 从内存 map 迁到 DB（新增 claim 字段或表，`intent_meta` 不够表达任务级租约）；
- 全程保持 `runs` 列不变，避免破坏 `/runs`、`/stats`、`/cost` 与报告。

## 7. 完成与目标模型

### 7.1 现状

`goal` 是图里的一个 Fact；完成是模型声明 + oracle 检查“引用的事实是否可追溯”。`challenge` 是唯一真正的目标验证，`evidence` 更接近审计。部分完成、多 flag、子目标都没有进入决策输入。

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
| **C1（M38 计划）** | 启动对账：`scheduler_instances` 心跳；无活跃同伴时把遗留 `runs.outcome = NULL` 标为 `inactive`；不动租约与派发路径 | `runs` 列不变；仅读模型从 running 变成 inactive；可单独回滚 |
| **C2（M39 草案）** | DB claim：任务级 claim 表成为队列真相；双 claim 拒绝、租约接管 | 在 C1 之后；失败可回退到内存 claim |
| **D** | 目标条件与部分完成；`done_when` 进入提示词；评估集接入 milestone | 旧 `verification` 作为别名保留 |

每个阶段的最小验证：
- A：构建器确定性、上限/截断、脱敏断言、session 文件存在、提示词段落存在、golden 不变；fake solver 端到端跑通。
- B：状态迁移表、非法提议丢弃、派发排除、操作员路由 403/409、UI 断言。
- C1：重启模拟（NULL run → inactive）、活跃同伴跳过对账、实例心跳过期、`/stats` 的 running 归零而 finished/inactive 增加；pending conclude 对账不变。
- C2：双 claim 拒绝、租约接管、进程重启后 claim 仍在。
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

## 13. M38 计划：启动对账（Phase C1）

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

- `id` 是每次 scheduler 启动生成的随机 boot id；`heartbeat_at` 由既有 lease 定时器更新；
  `stop()` 写 `stopped_at`。
- 不修改 `runs` 列。`inactive` 已经是 `RunOutcome` 的合法值，`/stats`、UI 与报告已按
  finished/inactive 统计，因此读模型自然收敛。
- 表随项目库一起迁移，旧库自动建表；没有行时视为“没有活跃实例”。

### 13.3 启动、心跳与停止

`Scheduler.start()` 的顺序变为：

1. `registerInstance()` 写入本进程的 boot 行（`heartbeat_at = started_at = now`）。
2. 检查是否存在**其它**活跃实例：`stopped_at IS NULL` 且
   `now - heartbeat_at <= instanceTimeout`。`instanceTimeout` 取
   `max(2 × runtime.interval, 30s)`，测试可注入时钟。
3. 没有活跃同伴时调用 `reconcileOrphanRuns()`：把全部 `outcome IS NULL` 的行写成
   `outcome = 'inactive'`、`finished_at = now`、`duration_ms = NULL`、detail 为
   `control plane restarted before finish`；返回受影响行数并逐条记日志。
4. 有活跃同伴时跳过对账并记录日志。两个 scheduler 共用一个库本来就不是受支持部署；
   M38 只保证不会误杀另一个**仍在心跳**的控制面。
5. 继续已有的 `sweepNow()`（pending conclude、session 保留、工件刷新），然后进入 tick。

心跳与停止：复用 `leaseIntervalMs` 定时器更新 `heartbeat_at`；`stop()` 先写
`stopped_at`，再取消任务与关闭 runtime。崩溃不会写 `stopped_at`，因此下一次启动只能依赖
心跳过期判断，而不是只看状态列。

对账本身是幂等的：第二次执行没有 `outcome IS NULL` 行，返回 0。

### 13.4 读模型与预算

- `/stats` 与 `/report`：原先的幽灵任务从 `running` 变为 `finished` 且 `inactive + 1`；
  succeeded / failed / rejected 不变，Token 与成本不变。
- `/strategist` 与 `AgentContext.budget.running_tasks` 直接过滤 `outcome === null`，对账后
  自然归零。
- `/projects/{id}/runs` 原样显示新 outcome 与 detail；不需要新路由，也不新增写路由。

### 13.5 边界与风险

- **worker 可能比控制面活得久**：容器模式下 `docker exec` 进程可能继续写 session 目录。
  M38 只把 run 标为 inactive，不删除 session；旧 worker 之后写出的 result 不会被导入，
  这是一次性可见语义，必须在 detail 与文档里说清楚。
- **时钟**：心跳与 `utcnow()` 使用同一时钟；实例超时至少两个 interval，避免单次抖动误判。
- **不释放租约**：意图 / reason 租约仍按各自心跳 TTL 过期，避免控制面刚重启就把仍在运行的
  worker 挤掉；这也是 M38 不改变派发路径的原因之一。
- **测试隔离**：只有 `start()` 注册实例并做对账；`runUntilIdle()` 不触发，因此现有测试中
  人为保留的 NULL run 不受影响。

### 13.6 验收

- `runs.test.ts`：两个 NULL + 一个 finished；对账后只改 NULL 行，detail/finished_at/
  duration 正确，第二次调用返回 0。
- `scheduler/startup.test.ts`：旧库启动 → inactive 且日志含计数；活跃同伴 → 跳过；
  同伴心跳过期 → 允许对账；`stop()` 后重启 → 立即视为死亡实例。
- `stats.test.ts` / `api.stats`：running 归零、finished + N、inactive 计数正确；预算
  `running_tasks` 归零；pending conclude 对账仍按原逻辑执行。
- `bun run check` 全量通过；版本 `0.61.0-m38`。

### 13.7 之后：C2（M39）草案

M38 稳定一个版本后，再把快层 claim 从内存 map 迁到 DB：新增任务级 claim 表（instance_id、
project_id、intent_id、kind、lease_expires_at），调度每个 tick 从 DB 派生可派发集合与
running 视图；`runs.instance_id` 用于归因；双 claim 拒绝与租约接管进入验收。M38 的实例心跳
与启动对账是那张表的前置条件。

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
| `project_writeups` | 已生成的 Writeup |
| `project_scopes` | 授权范围 |
| `runtime_config_overrides` | 运行时配置覆盖 |

## 附录 C：症状到阶段

| 症状 | 阶段 |
| --- | --- |
| S1 陈旧 Fact、S2 证据不可见、S4 flag 进度 | A |
| S3 执行记忆、S5 意图失败态 | A（历史） + B（状态与淘汰） |
| S6 调度双真相 | C |
| 完成契约、部分完成 | D |
| 能力不可度量 | 评估集（可独立开始） |
