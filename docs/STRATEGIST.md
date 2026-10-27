# 慢层触发、调度预算、输出扩展、真实成本基线与归因（M12a + M12b + M12c + M13a + M13b + M14b，已实现）

`scheduler/reason` 是 Cairn 的 Strategist：它看全图，提出新方向或完成项目。M12a 把
“什么时候跑 reason”从内存检查点改成**持久化水位 + 事件触发**，使控制面重启后不会对
未变化的图重复思考，也让失败退避、冷却和小时配额真正生效。M12b 在此基础上增加：

- reason 输出可带**意图优先级**与**意图级预算**（截止时间、工具调用上限）；
- 快层（explore）按优先级选择未认领意图；
- **单项目** token/成本预算与按项目并发配额；
- 每个 worker 的 solver 用量记账（`runs` + `usage.json` 旁路）。

M12c 增加只读可观测性：`GET /projects/{id}/strategist` 暴露触发水位、预算用量与
未结束意图，静态 UI 增加“慢层”页签。它不新增写路由，也不改变图或 worker 契约。

M13a 用真实模型 gate 把上述链路从“单测覆盖”推进到“计费实测”：逐任务核对用量旁路、
`runs`、项目汇总与只读 API，并验证 token 预算耗尽后停止派发。基线还暴露了两个需要
后续处理的事实：网关未提供价格，以及当前目标下产出的 Fact 没有可接受证据。详见第 10 节。

M13b 在同样的旁路数据上增加逐 Fact/意图的成本归因与因果链。它记录“哪个 run 创建了
意图”，把 run 用量分给直接产出，再沿 `intent → run → fact` 汇总；只读
`GET /projects/{id}/cost` 与 Alpine“成本”页签负责展示。详见第 11 节。

M14b 补齐 Phase 2 的策略能力：reason 可同时输出 Hint，意图可带稳定的 `dedupe_key`；
prompt 在运行时追加输出与资源预算说明；`POST /projects/{id}/replan` 提供人工重规划；
`strategist.resource_pressure_ratio` 在已结束用量接近上限时触发一次非紧急 reason。

## 1. 状态表

`strategist_state` 是旁路表（`packages/graph/src/db.ts`），一行一个项目，随项目删除：

```sql
CREATE TABLE strategist_state (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    last_success_at TEXT,
    last_attempt_at TEXT,
    last_failure_at TEXT,
    last_trigger TEXT,
    last_run_id TEXT,
    last_fact_count INTEGER NOT NULL DEFAULT 0,
    last_hint_count INTEGER NOT NULL DEFAULT 0,
    last_open_intent_count INTEGER NOT NULL DEFAULT 0,
    replan_requested_at TEXT,
    replan_requested_by TEXT,
    replan_reason TEXT,
    updated_at TEXT NOT NULL
);
```

- `last_success_at`：最近一次 reason **成功**（包括 noop）的时间。fallback 与零产出
  计数以它为基准。
- `last_attempt_at`：最近一次 reason 结束的时间（成功或失败都写）；非紧急触发的冷却
  以它为基准。
- `last_failure_at`：最近一次失败；下一次成功会清空。
- `last_fact_count` / `last_hint_count` / `last_open_intent_count`：该次成功时图的水位。
  只有成功才推进，失败保留旧值，因此重试仍能看到同一批未处理的 delta。
- `last_trigger` / `last_run_id`：诊断用，直接对应 `runs.trigger` 与 `runs.id`。
- `replan_requested_at` / `replan_requested_by` / `replan_reason`（M14b）：待处理的人工
  重规划请求。由 `POST /replan` 写入，reason 成功或失败后清空；`cancelled` / `inactive`
  不清空，请求会保留到下一次真正的 reason 结果。

表不进入 YAML 导出、HTTP 图响应或 worker 契约；唯一的写路由是 `POST /replan`。

## 2. 触发判定顺序

纯函数 `apps/cairn/src/scheduler/strategist.ts::evaluateStrategistTrigger()` 按以下顺序
返回第一个命中项。scheduler 只负责提供图快照、状态、最近 run、小时计数和运行中任务。

| 顺序 | 触发 | 条件 | 紧急 |
| --- | --- | --- | --- |
| 1 | `failure_backoff` | `last_failure_at` 在 `failure_backoff_seconds` 内 | 抑制所有触发 |
| 2 | `manual_replan` | `replan_requested_at` 非空（人工请求） | 是 |
| 3 | `initial` | 没有成功水位，且没有未认领的 open intent | 是 |
| 4 | `open_intents:N->0` | 上次成功时有 open intent，现在全部结束，且没有运行中的生产任务 | 是 |
| 5 | `zero_output:K` | 自上次成功以来连续 K 个 bootstrap/explore/conclude run 没有产出 Fact | 否 |
| 6 | `stale_intents:K` | 所有 open intent 都超过 `stale_intent_seconds` 未心跳，且都不在运行 | 否 |
| 7 | `facts:x->y` / `hints:x->y` | Fact 或 Hint 增量达到阈值 | 否 |
| 8 | `resource_pressure:*` | 已结束 run 的 token/成本用量达到 `resource_pressure_ratio`，且上次触发不是同一压力区间 | 否 |
| 9 | `fallback:Ns` | 距上次成功超过 `fallback_interval_seconds`，且启用了该值 | 否 |

判定后的统一约束：

- **任务静止**：任何非 `reason` 任务仍在运行时，一律返回
  `suppressed: "tasks_running"`，包括 `initial` 与 `manual_replan`。慢层不分析移动中的图。
- **失败退避**：在退避窗口内连 `initial` / `open_intents:N->0` / `manual_replan` 也不
  放行，避免崩溃后每个 tick 重试。
- **冷却**：非紧急触发距 `last_attempt_at` 不足 `cooldown_seconds` 时返回
  `suppressed: "cooldown"`。
- **小时配额**：非紧急触发在最近一小时 reason run 数达到 `max_runs_per_hour` 时返回
  `suppressed: "rate_limit"`。计数直接查 `runs`，重启不清零。
- 紧急触发（`manual_replan`、`initial`、`open_intents:N->0`）绕过冷却与小时配额，但不
  绕过失败退避和 `tasks_running`。

### 为什么 `initial` 要让路给快层

`initial` 只负责“图里还没有方向时先想一轮”。如果已经有未认领（`worker=null`）且非
bootstrap 的 open intent，scheduler 应先 explore；否则 reason 会和 explorer 抢同一个
图快照。未认领意图清空后，下一次判定自然会重新看到 `initial`。被其他 worker 认领的
open intent 不算可派发工作，因此不妨碍 `initial`；遗留的
`creator=dispatcher.bootstrap` 意图也不算，避免 `bootstrap_enabled: false` 的项目被
一个旧意图永久压住。

### 为什么 `open_intents:N->0` 需要上次水位

如果 reason 成功但没提出任何 intent，`last_open_intent_count` 会是 `0`。若只看到“当前
open intent 为 0”就紧急触发，会形成 reason → noop → 再 reason 的死循环。要求上次成功
时确实有 open intent（`N > 0`），才能把“全部做完”与“本来就没事可做”区分开。新的
Fact/Hint 仍会通过普通 delta 触发。

### 零产出连续计数

`listRecentStrategistRuns()` 取最新的已结束 bootstrap/explore/conclude run，并用
`EXISTS(fact_meta.run_id)` 判断是否产出 Fact。reason run 本身不产 Fact，被排除。
计数从最新向前走，遇到产出 Fact 的 run 或早于 `last_success_at` 的 run 就停止。
`conclude` 成功写 Fact 会重置计数；失败或“只结束 intent 没写 Fact”的任务会累加。

### 陈旧意图

“陈旧”按 `last_heartbeat_at ?? created_at` 计算。任一 open intent 仍新鲜、或任一 open
intent 正在被本控制面执行时，不触发。该触发用于打破“意图无人认领但也没人建新方向”
的停滞。`stale_intent_seconds: 0` 关闭。

### 人工重规划

`POST /projects/{id}/replan` 把 `reason` / `requested_by` 写入 `strategist_state`，下一次
tick 以 urgent `manual_replan` 派发。它跳过冷却与小时配额，但仍等待生产任务结束，并受
失败退避约束；reason 成功或失败后清除。请求是单项目级覆盖写，重复提交只保留最新一条。
路由在 reason 租约已占用时返回 409，非 active 项目返回 403。

### 资源压力

`resource_pressure_ratio`（`[0,1]`，默认 `0` 关闭）只看**已结束** run 的用量：token 或
成本任一达到 `max_*` 的配置比例时触发一次。触发串形如
`resource_pressure:tokens:80%,cost_usd:90%`，按 1% 向下取整。它是普通（非紧急）触发，
受冷却与小时配额约束，并且只在该压力区间触发一次：成功后 `last_trigger` 以
`resource_pressure` 开头，直到另一个触发覆盖水位才允许再次触发。没有配置上限或对应
上限为 `0` 的维度不参与判定。

## 3. 成功与失败的持久化

`finish()` 对 kind=`reason` 的任务调用 `recordStrategistOutcome()`：

- `success`：重新读取当前项目，写成功时间、attempt 时间、trigger、run id，以及当前
  fact/hint/open-intent 数；清除 `last_failure_at` 与 `replan_*`。
- `failed` / `rejected` / `unhealthy`：写 attempt 时间、failure 时间、trigger、run id，
  **保留**上次成功的图水位，同时清除 `replan_*`。
- `cancelled` / `inactive`：不写状态，也不清除人工重规划请求。取消或项目停用不是策略
  失败，不应触发退避，也不应吞掉操作员的请求。
- 状态写失败只记日志，绝不改变任务结果或退出码。

成功的 noop 也推进水位：模型已经看过这张图，并在当时判断无需新方向。

## 4. 配置

```yaml
strategist:
  min_new_facts: 1
  min_new_hints: 1
  cooldown_seconds: 30
  failure_backoff_seconds: 120
  max_runs_per_hour: 12
  zero_output_threshold: 3
  stale_intent_seconds: 0
  fallback_interval_seconds: 0
  resource_pressure_ratio: 0.0
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `min_new_facts` | `1` | 新增 Fact 达到该值触发；`0` 关闭该维度 |
| `min_new_hints` | `1` | 新增 Hint 达到该值触发；`0` 关闭该维度 |
| `cooldown_seconds` | `30` | 非紧急触发的最小间隔；`0` 关闭 |
| `failure_backoff_seconds` | `120` | 失败后禁止任何触发的窗口；`0` 关闭 |
| `max_runs_per_hour` | `12` | 滚动一小时 reason 上限；`0` 关闭 |
| `zero_output_threshold` | `3` | 连续零产出 run 阈值；`0` 关闭 |
| `stale_intent_seconds` | `0` | 判定意图陈旧的秒数；`0` 关闭 |
| `fallback_interval_seconds` | `0` | 空闲兜底间隔；`0` 关闭 |
| `resource_pressure_ratio` | `0` | 已结束 token/成本用量触发比例（`[0,1]`）；`0` 关闭 |

除 `resource_pressure_ratio` 是 `[0,1]` 的有限数外，其余字段都是非负整数；非法值启动时
以 `ConfigError` 拒绝。省略整个段即使用默认值。`initial`、成功后的首个 delta、失败退避
等核心行为不受字段关闭影响。

## 5. 与调度的关系

- 非 bootstrap 的“初始项目”也走同一触发判定，不再无条件派发 `initial`。因此 restart
  后如果失败退避仍有效，不会立即重试。
- bootstrap 仍优先于 reason：`bootstrap_enabled` 的初始项目先跑 bootstrap。
- pending conclude 仍最先派发；它可能产出 Fact，从而成为下一次 reason 的 delta。
- `runs.trigger` 记录实际触发串（例如 `initial`、`facts:2->4`、`facts:2->3,hints:0->1`），
  reason 成功/失败后同一串写入 `strategist_state.last_trigger`。
- 抑制日志按 `(project, reason)` 去重，每个抑制原因只打一次；一旦放行或原因变化会重新
  允许记录，避免每个 tick 刷屏。

## 6. 意图优先级、意图级预算与 reason 输出扩展（M12b + M14b）

reason 的 intent 条目可以多带三个可选字段：

```json
{
  "from": ["f001"],
  "description": "验证上传接口的路径穿越",
  "priority": 90,
  "budget": { "max_seconds": 600, "max_tool_calls": 40 },
  "dedupe_key": "upload-traversal"
}
```

- `priority`：`0..100` 的整数。省略时按 `50`（`DEFAULT_INTENT_PRIORITY`）处理。
- `budget.max_seconds` / `budget.max_tool_calls`：正整数；至少出现一个，未知键拒绝。
- `dedupe_key`：可选的稳定方向标识，去空白后 1–128 字符。控制面在创建前检查同一
  项目内仍打开的意图；key 已存在时跳过该条并计为去重成功。
- 三个字段都由 `packages/contracts` 校验。非法条目会让整个 reason 结果被拒绝，而不是
  静默忽略。

一次 reason 还可以同时返回 Hint：

```json
{
  "accepted": true,
  "data": {
    "intents": [{ "from": ["f001"], "description": "...", "dedupe_key": "a" }],
    "hints": [{ "content": "认证会跳转到 /login，先从这里开始。" }]
  }
}
```

- `hints[].content` 去空白后必须非空；一次最多 `tasks.reason.max_intents` 条。
- 已有未结束意图时，可以只返回 `hints`（不新增意图）；没有未结束意图时仍必须给出至少
  一个 intent，避免慢层空转。
- `complete` 不能与 `intents` 或 `hints` 并存。
- Hint 只是给后续 worker 的策略提示，不是证据，不能用于完成验证；内容按去空白后的
  文本精确去重。

落库位置是旁路表 `intent_meta` 与图内 `hints`，不进入 YAML 导出之外的额外结构：

| 列 / 目标 | M14b 写入 |
| --- | --- |
| `source` | `strategist` |
| `priority` | 校验后的优先级，未提供时为 `50` |
| `budget` | `{"max_seconds":...,"max_tool_calls":...}` 的 JSON 文本；未提供为 `NULL` |
| `dedupe_key` | 校验后的 key；未提供为 `NULL` |
| 图 `hints` | `createHint(creator=cairn-worker)`；与现有内容完全相同的条目跳过 |

读取时会再次归一化：越界优先级、损坏 JSON、负数或未知预算字段都视为 `NULL`，避免旧
数据或手工写入让调度器进入异常状态。

### prompt 扩展

默认 `reason.md` 模板保持与 Python Cairn 逐字一致（golden 测试锁定）。M14b 在渲染后
追加 `# Strategist Output Extensions`，说明 intents+hints 的 JSON 形状、priority 范围、
budget 只能收紧限制、dedupe key 的稳定性要求、Hint 不是证据以及禁止写 flag/凭据。
配置了 token 或成本上限时再追加 `# Resource Budget`，列出已结束 run 的用量与上限；
在途任务尚未上报，不参与该数字。open intent 上下文也带上 `priority` / `budget` /
`dedupe_key` / `source`，模型可以据此避免重复方向。

### 派发顺序

优先级只作用于**快层**。总体顺序仍是：

1. pending conclude（失败任务的补救）；
2. bootstrap；
3. reason（当触发判定放行时）；
4. 未认领（`to IS NULL AND worker IS NULL`）且非 bootstrap 的 explore intent。

第 4 步内部按 `priority DESC, created_at DESC, id DESC` 选择。因此：
reason 一旦触发仍先于任何 explore；`priority` 不会让 explore 抢在 reason 前面。
没有 `intent_meta` 的意图（例如人工创建或 Observer 创建）按默认 50 参与排序。

### 预算如何生效

- `max_seconds` 只会**收紧**，不会延长任务类型的超时：
  `hardDeadline = max(1, min(configured, max_seconds))`。软截止时间仍按
  `worker.soft_deadline_ratio` 从收紧后的硬截止推导；conclude 沿用所属阶段的超时。
- `max_tool_calls` 写入 `WorkerTask.maxToolCalls`，worker 再以
  `CAIRN_TASK_MAX_TOOL_CALLS` 传给 Host Bridge。达到上限后 Host Bridge 拒绝后续工具
  调用，并把该拒绝以 `event: "tool_budget_exhausted"` 写入 `audit.jsonl`，让 solver
  用已有证据收尾。
- 工具预算是**每个 worker 进程**的计数。子代理进程会各自加载 Host Bridge、拥有独立
  计数，因此它是最佳努力的成本护栏，不是安全边界。真正的越权边界仍是动作级 scope
  拦截与容器。
- 任务 JSON 或环境里的非法上限会直接报错（worker 启动失败），不会悄悄放行。

## 7. 单项目 token/成本预算（M12b）

顶层 `budget` 段是每个项目的默认策略（不是全局共享池）：

```yaml
budget:
  max_project_tokens: 0       # 0 = 关闭
  max_project_cost_usd: 0     # 0 = 关闭
  max_project_tasks: 0        # 0 = 使用 runtime.max_project_workers
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `max_project_tokens` | `0` | 该项目所有已结束 run 的 `total_tokens` 之和达到即停止新派发 |
| `max_project_cost_usd` | `0` | 该项目所有已结束 run 的 `cost_usd` 之和达到即停止新派发 |
| `max_project_tasks` | `0` | 单项目并发任务上限；`0` 继承 `runtime.max_project_workers` |

`max_project_tokens` 必须是非负整数，`max_project_cost_usd` 必须是非负有限数，
`max_project_tasks` 必须是非负整数。并发上限最终仍受全局 `runtime.max_workers` 约束。

### 门禁范围与已知偏差

- token/成本门禁位于 pending conclude 之后，只拦截新的 bootstrap/reason/explore。
  pending conclude 必须继续：它持有失败任务的 intent 租约，需要写入可挽救的 Fact
  或释放 intent，否则该意图会永久卡住。
- 门禁只统计**已结束**的 run。正在执行的任务尚未写回用量，因此项目可能超出预算最多
  “在途任务已消耗但未上报”的量。下一个 tick 看到用量后才停止后续派发。
- 用量查询失败时**失败关闭**（跳过新派发），并只记一次日志；不会把数据库错误当成
  “预算充足”。
- 达到上限后每类（token / cost）只记一次日志；用量回落到上限以下（例如运维调高配置
  或删除 run）会清除去重键，允许重新记录。

## 8. 用量记账（M12b）

worker 在 solver 结束（成功、失败、被拒绝都算）后，把主 solver 会话的计数写到
`<sessionDir>/usage.json`：

```json
{
  "input_tokens": 120,
  "output_tokens": 30,
  "cache_read_tokens": 10,
  "cache_write_tokens": 5,
  "total_tokens": 165,
  "cost_usd": 0.0042
}
```

控制面读取该旁路并写入 `runs.input_tokens` 等六列；`finishRun` 允许用量为空，旧数据
或读取失败一律按 0 计。`getProjectUsage()` 汇总 `total_tokens` 与 `cost_usd`。

限制：

- 只统计**主 solver 会话**。子代理会话的 token/成本可能重复计费或未计入主会话，
  取决于上游实现；当前不把子代理用量单独汇总。
- worker 被硬杀、崩溃在写文件之前，或 `usage.json` 缺失/损坏时，该次任务按 0 计。
  记账是尽力而为，不能作为计费凭证。
- 用量写失败只记日志，绝不改变任务结果。
- 读取侧只接受 session 目录内**普通、非符号链接、大小受限**（16 KiB）的 JSON 对象，
  非负整数计数与有限成本；否则视为“未上报”。

## 9. 慢层 API 与 UI（M12c + M14b）

### 路由

```http
GET /projects/{project_id}/strategist?limit=20
```

- `limit` 只限制 `reason_runs` 的长度，默认 `20`，允许 `1..100`；非整数、越界或负数
  返回 `400`，不会静默截断。未知项目 `404`。
- GET 路由只读；`POST` / `PUT` / `DELETE` 由通用路由表返回 `405`。
- 路由只读旁路表与图，不修改 `strategist_state`、`runs` 或 `intent_meta`。

```http
POST /projects/{project_id}/replan
```

- body 可省略或为 `{}`；`reason` 可选（≤500 字），`requested_by` 可选（≤128 字，默认
  `human`）。返回更新后的 `state`。
- 写入 `strategist_state.replan_*`，下一次调度按 urgent `manual_replan` 处理；reason
  成功或失败后清除。未知项目 `404`；非 active 项目 `403`；reason 租约已占用 `409`；
  形状非法 `400`、非法 JSON `422`。

响应：

```json
{
  "state": {
    "project_id": "project_001",
    "last_success_at": "2026-10-26T03:00:00Z",
    "last_attempt_at": "2026-10-26T03:00:00Z",
    "last_failure_at": null,
    "last_trigger": "facts:2->4",
    "last_run_id": "run_003",
    "last_fact_count": 4,
    "last_hint_count": 0,
    "last_open_intent_count": 2,
    "replan_requested_at": null,
    "replan_requested_by": null,
    "replan_reason": null,
    "updated_at": "2026-10-26T03:00:00Z"
  },
  "budget": {
    "used_tokens": 12000,
    "used_cost_usd": 0.42,
    "running_tasks": 1,
    "limits": {
      "max_project_tokens": 50000,
      "max_project_cost_usd": 2,
      "max_project_tasks": 2
    },
    "exhausted": { "tokens": false, "cost_usd": false, "tasks": false }
  },
  "intents": [
    {
      "id": "intent_004",
      "from": ["fact_002"],
      "to": null,
      "description": "验证上传接口的路径穿越",
      "creator": "strategist",
      "worker": null,
      "last_heartbeat_at": null,
      "created_at": "2026-10-26T03:00:00Z",
      "concluded_at": null,
      "priority": 90,
      "budget": { "max_seconds": 600, "max_tool_calls": 40 },
      "source": "strategist",
      "dedupe_key": "upload-traversal"
    }
  ],
  "reason_runs": []
}
```

字段语义：

- `state`：`strategist_state` 原样返回；从未成功或失败过时为 `null`。`replan_*` 是待处理
  的人工重规划请求，`null` 表示没有请求。
- `intents`：只含未结束意图（`to IS NULL`），包括已被认领、正在执行的任务。排序与
  快层派发一致：`priority DESC, created_at DESC, id DESC`。没有 `intent_meta` 的意图
  使用默认优先级 `50`，`budget` / `source` / `dedupe_key` 为 `null`。
- `reason_runs`：`kind='reason'` 的 run，最新在前，最多 `limit` 条；其他 kind 不出现。
- `budget.used_tokens` / `used_cost_usd`：`getProjectUsage()` 对所有 run 的汇总，失败
  任务也计入（与调度门禁一致）。
- `budget.running_tasks`：`runs.outcome IS NULL` 的行数。它近似调度器内存中的在途任务；
  崩溃遗留的未结束行也会被计入。
- `budget.exhausted.tokens` / `cost_usd`：`limits` 存在且上限 `> 0` 且用量达到上限。
- `budget.exhausted.tasks`：`max_project_tasks > 0` 且 `running_tasks >= max_project_tasks`。
  `max_project_tasks = 0` 表示继承 `runtime.max_project_workers`，但纯 HTTP 视图不知道
  runtime 配置，因此不报告为“已满”；实际调度仍按继承值执行。
- 纯 HTTP 模式（`cairn serve` 不带 `--config`）没有预算策略，`limits` 为 `null`，
  `exhausted` 全为 `false`；用量仍从既有 `runs` 读取。

### UI

静态页的“慢层”页签读取同一路由（`?limit=20`），显示：

- 单项目预算：已用/上限 token、成本、并发任务数，以及“Token 用尽 / 成本用尽 /
  并发已满”徽标；
- 触发水位：最近成功/尝试/失败时间、最近触发串、fact/hint/open-intent 水位与 run id；
- 人工重规划：可选原因输入框与“请求重规划”按钮；待处理请求显示请求人与原因；
- 未结束意图：优先级徽标、来源事实、意图预算、来源与创建时间；
- 推理历史：触发、结果、耗时、token、成本与 detail。

页签只在选中时发一次 `GET`，刷新按钮重复同一请求；“请求重规划”是唯一显式写操作，
提交后重新读取慢层状态。API 本身仍是未认证的，容器或公网部署仍需网络层访问控制。

## 10. 真实模型成本基线（M13a）

Gate 位于 `tools/gate/m13-cost-baseline.ts`，不属于 `bun test`：它创建临时项目与两个
marker 文件，关闭 bootstrap，让首次 reason 触发初始方向，再用 `Scheduler.tick()` /
`waitForIdle()` 循环派发最多 N 个任务。它不接触生产数据库，默认结束后删除临时目录
（`CAIRN_GATE_KEEP=1` 保留）。

### 运行

```bash
# 基线：最多 6 个任务，20 分钟硬上限
bun run tools/gate/m13-cost-baseline.ts

# 预算耗尽：token 上限 1000，期望首个 reason 后停止派发
CAIRN_GATE_BUDGET_TOKENS=1000 CAIRN_GATE_EXPECT_EXHAUSTED=1 \
  CAIRN_GATE_MAX_TASKS=2 CAIRN_GATE_REPORT=runs/m13-budget-exhaustion.json \
  bun run tools/gate/m13-cost-baseline.ts
```

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `CAIRN_GATE_MAX_TASKS` | 6（1–20） | 本次 gate 最多派发的任务数；`max_project_tasks` 是并发上限，不是总量上限 |
| `CAIRN_GATE_MAX_MINUTES` | 20（1–120） | 墙钟硬上限 |
| `CAIRN_GATE_BUDGET_TOKENS` | 0 | 写入 `budget.max_project_tokens`；0 关闭 |
| `CAIRN_GATE_BUDGET_COST_USD` | 0 | 写入 `budget.max_project_cost_usd`；0 关闭 |
| `CAIRN_GATE_EXPECT_EXHAUSTED` | 未设置 | `1` 时允许项目未 completed，并要求预算耗尽 + 停止派发 |
| `CAIRN_GATE_PRICE_INPUT_PER_M` 等 | 0 | `INPUT` / `OUTPUT` / `CACHE_READ` / `CACHE_WRITE` 每百万 token 美元价；仅用于报告估算 |
| `CAIRN_GATE_REPORT` | `runs/m13-baseline.json` | 报告路径 |
| `CAIRN_GATE_KEEP` | 未设置 | `1` 保留临时工作区 |

需要 `~/.tch-agent/config` 中的真实凭据；gate 只打印配置目录路径，不打印密钥。

### 断言链

- 凭据存在、`CAIRN_SOLVER=breachweave`、两个 marker 文件已播种；
- 至少一个任务，全部 finished/success，reason 与 explore 各至少一次；基线模式要求项目
  completed；
- `usage.json` 存在且六个字段与该 run 的 `runs` 列相等；所有 run 的旁路之和等于
  `getProjectUsage()`；
- 每个动态 Fact 归属到某个 run 且证据状态为 `provided`；marker 值出现在 Fact 描述或其
  被接受的证据文件中（模型常把值只写进证据文件，M14a 以证据文件为准）；
- 完成策略是 `evidence`，最近一次 `verification_checks` 为通过；
- `strategist_state` 前进，最后一个 run 是 reason，trigger 描述图变化；
- `/strategist` 的 state、usage、`running_tasks`、limits、exhausted、reason 历史与
  未结束意图顺序均与数据库/调度器一致；
- `/cost` 的总量与 `by_kind` 和 run 行一致，`attributed + unattributed = total`，
  动态 Fact 有非零直付并带 `origin_run_ids`，所有因果边只引用该项目的 run/意图/Fact，
  `created_intent` 覆盖所有带来源的意图，`produced_fact` 覆盖所有动态 Fact，POST 405；
- 预算模式：配置了上限、用量已越线、越线后没有新的 bootstrap/explore/reason；
- 工作区文本文件不含 `auth.json` 中的任何凭据值（只报告路径）。

### 基线（2026-10-26，`deepseek-flash`）

| 指标 | 值 |
| --- | --- |
| 任务 | 5（reason 3 / explore 2），全部成功 |
| 墙钟 | 65,192 ms |
| 总 tokens | 134,740 |
| input / output | 10,954 / 5,898 |
| cache read / write | 117,888 / 0（缓存读占 87.5%） |
| 慢层（reason） | 74,273 tokens（55.1%） |
| 快层（explore） | 60,467 tokens |
| Facts | 2（均无被接受证据） |
| tokens/Fact | 67,370（全项目摊薄；直接归属 36,438 / 24,029） |
| 归因 | 直付 60,467 + 编排 24,115 = 84,582；未归因 50,158 |
| 网关费用 | $0（未配置价格） |

逐任务：

| run | kind | trigger | tokens | 时长 | Fact |
| --- | --- | --- | ---: | ---: | --- |
| run_001 | reason | initial | 24,115 | 14.6s | — |
| run_002 | explore | — | 36,438 | 14.8s | f001 |
| run_003 | reason | facts:2->3 | 24,993 | 12.8s | — |
| run_004 | explore | — | 24,029 | 11.9s | f002 |
| run_005 | reason | open_intents:1->0 | 25,165 | 10.8s | — |

run_001 创建 i001/i002，两个意图各分得 12,057/12,058 的编排成本；两个 Fact 的完整成本
为 48,495（f001）与 36,087（f002）。run_003/run_005 是验证轮，没有创建新意图，因此
50,158 tokens 留在未归因。

预算模式：1 个 reason 任务使用 22,381 tokens（上限 1,000），API 报告
`exhausted.tokens=true`，没有后续普通任务；43/43 检查通过。该模式没有 Fact，因此
`/cost` 全部 22,381 tokens 落在未归因，但 run/意图创建边仍然一致。

### M14a 基线：完成时证据强制（2026-10-26，`deepseek-flash`）

| 指标 | 值 |
| --- | --- |
| 任务 | 3（reason 2 / explore 1），全部成功 |
| 总 tokens | 132,967 |
| input / output | 12,317 / 8,522 |
| cache read / write | 112,128 / 0（84.3%） |
| 慢层（reason） | 69,949 tokens（52.6%） |
| 快层（explore） | 63,018 tokens |
| Facts | 1（`evidence_status=provided`） |
| 完成判定 | `verification_checks`：`kind=evidence`、`ok=true` |
| 检查 | 45 passed / 0 failed |

这一轮模型把两个 marker 都写进同一个 explore 结论（值同时出现在 Fact 描述和证据文件），
所以只派发了 1 个 explore。此前两轮同样配置的失败试跑消耗 236,939 与 253,608 tokens，
说明模型的探索拆分粒度会让用量波动一倍以上；token 数只适合作量级参考，不是固定预算。
报告写入 `runs/m14a-baseline.json`。

### 结论与限制

- 用量链路（旁路 → `runs` → 汇总 → API）在真实会话上逐字段一致；预算门禁在真实模型
  下确实阻止了后续派发。
- 慢层占约六成 token，且每个 reason run 都重新读取全图；这是当前“保留 Cairn 语义”的
  直接成本。若要降本，应优先评估把图切片扩展到 reason（见第 13 节）。
- 网关的 `models.json` 没有价格，`cost_usd` 恒为 0。provider cost 不能当作计费凭证；
  报告在价格未配置时明确 warning，并支持用 `CAIRN_GATE_PRICE_*_PER_M` 估算。
- 两个 Fact 都没有 `evidence_refs`，证据门只能把它们标为 `missing`；任务/项目仍算成功。
  这是当前 goal 与 prompt 的产物，不是记账缺陷。
- M13b 的 `/cost` 与 run 行完全对账：84,582/134,740 tokens 可归因到 Fact（62.8%）。
  剩余 50,158 来自两次没有创建新意图的 reason 验证轮——它们影响项目结论，但不属于
  任何单个 Fact，因此保持未归因是刻意选择，而不是漏算。
- gate 使用真实模型，结果会随模型、网关缓存与 prompt 版本波动；这里是单次样本，不是
  统计均值。

## 11. 成本归因与因果链（M13b）

M13a 能回答“项目总共花了多少”，但不能回答“哪个 Fact 花了多少、哪个 reason 产生了
这条方向”。`runs`、`fact_meta` 与 `intent_meta` 已经足够拼出这条链，M13b 只补一个
缺口：reason 输出或提案应用时创建意图的 run。

### 数据来源

- `intent_meta.origin_run_id`：创建该意图的 run。reason 在 `applyReason` 写意图时设置；
  Observer 提案 apply 时写 `proposal.run_id`。旧库自动补列，历史行为 `null`。
- `fact_meta.run_id`：产出该 Fact 的 run；`runs.intent_id` 把 explore/conclude run
  绑回意图。
- `intent_sources`：意图来源 Fact；`intents.to`：意图结论 Fact。

这些都是旁路数据，不进入 Cairn 图、YAML 导出或 worker 契约。

### 分配规则

`packages/graph/src/cost.ts` 的 `buildProjectCostReport` 按以下顺序计算：

1. 每个 run 的直接产出 = 它创建的意图（`origin_run_id`）+ 它产出的 Fact
   （`fact_meta.run_id`）。run 的 token 与成本**平均分给**这些产出；整数 token 的
   余数按排序后的前几个产出分配，保证总和不变。
2. 每个意图的创建份额，再平均分给该意图产出的事实（通过产出 run 的
   `runs.intent_id` 关联）。
3. 没有直接产出的 run（失败的 reason、零产出 reason、无 Fact 的意图执行）不计入
   任何 Fact；其用量进入 `attribution.unattributed_*`。

因此：

- **Fact 的 `total_tokens` 是项目用量的分区**：所有 Fact 的 `total_tokens` 相加，
  加上 `unattributed_tokens`，等于项目总量。
- **意图的 `total_tokens` 会与执行 run 重叠**：它 = 执行意图的 run 用量（`direct_*`）
  + reason/提案创建该意图的分摊（`orchestration_*`）。把多个意图相加会重复计算
  执行 run，不能与 Fact 合计相加。
- `attribution.orchestration_tokens` 是所有意图创建份额的总和；
  `orchestration_attributed_tokens` 只是其中最终落到 Fact 的部分。意图没有产出 Fact
  时，创建份额仍在 `orchestration_tokens` 里，但会计入 `unattributed_tokens`；等式是
  `fact_direct + orchestration_attributed = attributed`，而不是
  `fact_direct + orchestration_tokens = attributed`。
- `attribution.complete` 只在没有未归因 token 且成本误差小于 1e-9 时为 `true`。
  基线项目可能因 reason 创建的意图未产出 Fact 而显示“存在未归因”。
- 成本为派生值，按 1e-9 美元取整以消除浮点噪声；provider 未配置价格时所有成本仍为 0。

### `GET /projects/{id}/cost`

只读 JSON，无查询参数：

```jsonc
{
  "project_id": "proj_001",
  "totals": { "tokens": 230, "cost_usd": 2.3, "runs": 4 },
  "by_kind": [{ "kind": "explore", "runs": 2, "tokens": 100, "cost_usd": 1 }],
  "attribution": {
    "fact_direct_tokens": 100,
    "orchestration_tokens": 100,
    "orchestration_attributed_tokens": 100,
    "attributed_tokens": 200,
    "unattributed_tokens": 30,
    "complete": false
  },
  "facts": [{
    "id": "f001",
    "run_id": "run_002",
    "intent_id": "i001",
    "origin_run_ids": ["run_001"],
    "evidence_status": "provided",
    "direct_tokens": 40,
    "orchestration_tokens": 50,
    "total_tokens": 90
  }],
  "intents": [{
    "id": "i001",
    "origin_run_id": "run_001",
    "run_ids": ["run_002"],
    "produced_fact_ids": ["f001"],
    "direct_tokens": 40,
    "orchestration_tokens": 50,
    "total_tokens": 90
  }],
  "runs": [{
    "id": "run_001",
    "created_intent_ids": ["i001"],
    "produced_fact_ids": []
  }],
  "edges": [{
    "from": "run:run_001",
    "to": "intent:i001",
    "kind": "created_intent",
    "tokens": 50,
    "cost_usd": 0.5
  }]
}
```

`edges` 的节点 ID 带前缀 `run:` / `intent:` / `fact:`，`kind` 为：

| kind | 方向 | 含义 | 带金额 |
| --- | --- | --- | --- |
| `created_intent` | run → intent | 该 run 创建了意图 | 是（分摊） |
| `executed_by` | intent → run | 该意图由该 run 执行 | 是（run 全量） |
| `produced_fact` | run → fact | 该 run 产出了事实 | 是（分摊） |
| `source_fact` | fact → intent | 事实是意图的来源 | 否（0） |
| `concluded_fact` | intent → fact | 意图结论写成了事实 | 否（0） |

只有 GET；未知项目 404，其他方法 405。`goal`/`origin` 与历史 Fact 没有
`fact_meta`，仍会出现在 `facts` 中，但 `run_id=null`、`evidence_status=legacy`、
成本为 0。

### UI

Alpine 侧边栏新增“成本”页签：顶部显示项目总量与归因完整性，随后是按 run kind 汇总、
逐 Fact 成本（直付/编排/产出 run/创建 run/证据）、逐意图成本、因果边与每个 run 的
直接产出。它只调用 `/cost` 的 GET，打开页签或手动刷新才拉取；不参与调度或写图。

## 12. 测试覆盖

- `packages/graph/src/strategist.test.ts`：状态缺失/成功水位/失败不清水位/新项目失败
  不造假水位/项目级联；run 摘要的产 Fact 判定、reason 排除与滚动计数；人工重规划写入
  不移动水位、成功/失败清除、reason 租约 409 与非 active 403。
- `apps/cairn/src/scheduler/strategist.test.ts`：initial、快层让路、delta 阈值、
  open-intent 清空与死循环保护、冷却、失败退避、小时配额、零产出重置、任务运行抑制、
  陈旧意图、fallback；`manual_replan` 的 urgent/退避/在跑抑制，以及资源压力的阈值/
  双维度/关闭/不重复/冷却。
- `apps/cairn/src/scheduler/loop.test.ts`：成功状态落库且新 Scheduler 不重复 reason；
  失败的 reason 任务写入 backoff，下一次 tick 只记录抑制日志、不再派发。
- `apps/cairn/src/config.test.ts`：默认值、完整覆盖与负数/类型/非对象拒绝，含
  `budget` 默认值、解析与负数拒绝，以及 `resource_pressure_ratio` 的 0–1 校验。
- `packages/contracts/src/parse.test.ts`：priority 范围/整数校验，budget 未知键、空
  预算、非正整数字段拒绝，以及合法字段原样保留；M14b 增加 hints 去空白/裁剪/
  hints-only 条件、`complete`+hints 拒绝与 dedupe key 的空白/长度/类型校验。
- `packages/contracts/src/usage.test.ts` + `apps/cairn/src/scheduler/usage.test.ts`：
  usage 契约、负值/分数/非有限值拒绝、缺失/损坏/超大/目录型旁路拒绝。
- `packages/graph/src/runs.test.ts`：用量持久化、失败任务仍计入、项目汇总、未知项目
  404。
- `packages/graph/src/db.test.ts`：旧 `runs` 表增量迁移六个用量列并回填 0；旧
  `intent_meta` 自动补 `origin_run_id`（历史行保持 `null`）；旧 `strategist_state`
  自动补 `replan_*` 三列。
- `packages/graph/src/proposals.test.ts`：`intent_meta` 优先级/预算往返与损坏数据归一化，
  以及 `origin_run_id` 的默认 `null` 与往返。
- `packages/graph/src/cost.test.ts`：run → 意图 → Fact 的两级分摊、整数余数、直接/编排/
  未归因对账、证据与来源事实、缺失来源时归因停在上层、零 run 项目与未知项目。
- `apps/cairn/src/scheduler/tasks.test.ts`：`max_seconds` 收紧硬截止、不会延长，
  `maxToolCalls` 写入任务；reason prompt 含输出扩展、open intent 元数据与
  Resource Budget 数字，无预算快照时省略该段。
- `apps/cairn/src/scheduler/loop.test.ts`：Hint 落图并按内容去重、重复 open dedupe key
  跳过（人工重规划后不新增意图/提示）、`manual_replan` 触发与标记清除。
- `apps/cairn/src/host-bridge/bridge.test.ts`：工具上限拒绝、`tool_budget_exhausted`
  审计事件、未配置时不计数、环境变量校验。
- `apps/cairn/src/scheduler/loop.test.ts`：reason 优先级/预算落库、reason 创建的意图
  写入 `origin_run_id`、按优先级选 explore、usage 端到端持久化、token/成本门禁、
  pending conclude 绕过预算、按项目并发配额与继承 `runtime.max_project_workers`。
- `apps/cairn/src/http/api.strategist.test.ts`：空状态与纯 HTTP 模式的 `null` limits、
  未结束意图的优先级排序与元数据、运行中/失败任务用量汇总、`reason_runs` 过滤与限制、
  状态字段、404、非法 `limit`（0/101/小数/非数字/负数）以及非 GET 的 405；M14b 增加
  `/replan` 的成功/默认 body/覆盖写/404/403/409/422/405 与 GET 回读。
- `apps/cairn/src/http/api.cost.test.ts`：空项目零报告、reason → explore → Fact 的
  总量/分类/归因/因果边、未知项目 404 与非 GET 405。
- `apps/cairn/src/http/api.ui.test.ts`：慢层与成本页签存在、`loadStrategist` 带
  `?limit=20`、`loadCost` 只发 GET、`requestStrategistReplan` 是唯一显式 POST、
  内联脚本仍可解析。
- `packages/agent/src/solver/session.test.ts`：主 Solver 与子代理的 `startup.json`
  对 `authStorage` 中的密钥按字段名脱敏，不包含原文，且保留 `[REDACTED]` 标记。
- `tools/gate/m13-cost-baseline.ts` 是真实模型 gate（不在 `bun test` 中）：默认模式
  **44/44**，覆盖第 10 节的用量/API/预算/凭据断言，以及第 11 节的 `/cost` 总量、
  分类、归因对账、动态 Fact 直付与来源 run、因果边引用和 POST 拒绝；预算模式
  **43/43**。

## 13. 尚未实现

- 触发状态与 `intent_meta` 仍不暴露给 worker，也不进入图；它们是控制面的调度决策
  数据。`runs` 用量已可通过既有 `GET /projects/{id}/runs` 读取。
- 用量汇总只覆盖主 solver 会话；子代理与会话外成本不在当前预算模型内。预算门禁只
  统计已结束 run，在途任务可能造成超额；慢层 API 只是如实展示这一偏差，不做预留。
- 阈值与成本参数尚未在真实长任务上校准；`cooldown_seconds`、失败退避与
  `max_runs_per_hour` 的默认值仍是保守起点。
- 成本归因是**分摊**，不是模型真实的逐 token 计量：一个 reason run 创建多个意图时
  平均分配，无法知道每个意图的实际思考成本；一个 explore run 产出多个 Fact 时同理。
  分摊只能保证总量守恒，不能证明某条方向“真的更贵”。
- M13b 之前创建的意图没有 `origin_run_id`，其 reason 成本永久留在 `unattributed`；
  丢失的来源无法从现有数据反推。
- 子代理/子会话仍不计入 `runs` 用量，因此归因与预算一样只覆盖主 solver 会话。
- M14b 的 prompt 扩展尚未在真实模型上做 A/B；Hint 质量、`dedupe_key` 的稳定性与
  “是否会过度合并不同方向”没有基线数据。
- 人工重规划只有单项目级覆盖标记：没有排队、优先级、审批或操作审计；同一项目连续
  提交只保留最后一条，取消/停用不会清除请求。
- 资源压力默认关闭，阈值也只能按已结束 run 计算；在途任务可能让实际用量先越过阈值。
  `resource_pressure_ratio` 的合适取值仍需真实长任务样本。
