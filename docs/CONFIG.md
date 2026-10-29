# 运行配置（M22）

dispatch.yaml 仍是配置的事实来源；M22 增加一层**运行期覆盖**，让不含部署信息的调度参数
可以在页头「运行配置」弹窗里改，并在下一个调度周期生效，不必重启进程。Observer 复盘也在
M22 改为默认开启（`observer.enabled` 默认 `true`），但它仍只是只读 sidecar，提案继续由
`proposals.enabled` 单独控制。

## 1. 生效链路

```
dispatch.yaml ──解析前文档副本──┐
                               ├─ 深合并 patch ─ parseDispatchConfig ─ 原地同步 ─ 共享 DispatchConfig
SQLite runtime_config_overrides ┘                                          │
                                                         Scheduler.reconfigure()（仅定时器）
```

- 启动时 `loadDispatchConfigWithSource` 同时返回解析后的 `DispatchConfig` 和解析前的
  snake_case 文档。`RuntimeConfigStore` 保留后者作为基线。
- `PUT` 的 patch 以 JSON 存在 SQLite 表 `runtime_config_overrides`（单行 `id = 1`，
  带 `updated_at`）。重启后自动重放，因此覆盖不会被 `serve` 重启清掉。
- 应用时把 patch 深合并到**文件基线**（不是当前值）上，再用同一个
  `parseDispatchConfig` 重新解析。键白名单与跨字段约束（例如
  `max_project_workers ≤ max_workers`、`max_total_bytes ≥ max_file_bytes`、
  `graph_slice.max_facts ≥ 2`、`stats` 模式需要 `worker_profiles`）全部复用。
- 解析成功后用 `syncConfigInPlace` 原地写回正在使用的对象，`config.budget`、
  `config.verification` 等引用保持有效；解析失败则在任何改动之前抛错，调度器继续用旧值。
- 落库的 patch 若在升级后不再合法（未知键、越界值），启动日志会记录原因并清空覆盖，
  而不是让服务起不来。

`PUT` 是**整组替换**：patch 里没写的字段回到 dispatch.yaml 值。UI 只提交与文件基线
不同的叶子（`runtimeDiff`），所以把某个字段改回原值就会自动去掉它的覆盖标记。
`DELETE` 等价于空 patch。

## 2. HTTP

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings/runtime` | `{defaults, editable, overrides, updated_at, read_only}` |
| PUT | `/settings/runtime` | 请求体是覆盖 patch；成功返回同样的视图 |
| DELETE | `/settings/runtime` | 清空覆盖并返回视图 |

- `defaults` 是只取 dispatch.yaml 的值；`editable` 是调度器当前使用的值；二者形状相同。
- `overrides` 是排好序的点路径叶子列表（`tasks.graph_slice.enabled`），数组算一个叶子
  （`proposals.allow_kinds`），供 UI 打「已覆盖」标记。
- 请求体上限 64 KiB；空请求体视为 `{}`；非法 JSON 400。
- 配置了 `CAIRN_OPERATOR_TOKEN` 时写路由要求 `X-Cairn-Operator-Token`，并拒绝跨源
  `Origin`（与 `/settings/agent` 写路由一致）。GET 免 token。
- 没有 `--config` 的纯 HTTP 模式没有可变配置，三个方法都返回 409。
- 校验失败返回 400 + 具体字段路径；运行中的配置不受影响。

```bash
curl -X PUT http://127.0.0.1:8000/settings/runtime \
  -H 'Content-Type: application/json' \
  -d '{"runtime":{"interval":5},"tasks":{"graph_slice":{"enabled":true}}}'
```

## 3. 可编辑字段

值的类型与约束由 `parseDispatchConfig` 最终判定；下表列出常用范围与默认值。

### 调度 `runtime`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `max_workers` | 3 | 全局并发任务上限，正整数 |
| `max_running_projects` | 2 | 同时调度的项目数，正整数 |
| `max_project_workers` | 1 | 单项目并发任务，正整数且 ≤ `max_workers` |
| `interval` | 3 | 调度 tick 秒数，正整数；改动会重挂定时器 |

### 任务 `tasks`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bootstrap.timeout` / `bootstrap.conclude_timeout` | 300 / 90 | 秒 |
| `reason.timeout` / `reason.max_intents` | 300 / 2 | 秒；单次 reason 新增意图上限 |
| `explore.timeout` / `explore.conclude_timeout` | 600 / 120 | 秒 |
| `graph_slice.enabled` | false | explore 及其 conclude 是否拿切片 |
| `graph_slice.max_facts` / `graph_slice.max_intents` | 80 / 60 | 软上限；`max_facts ≥ 2` |
| `evidence.min_bytes` | 1 | 0 表示接受空证据 |

### Worker `worker` / `worker_selection`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `worker.soft_deadline_ratio` | 0.8 | 严格在 0 与 1 之间 |
| `worker.retain_task_files` | true | 任务结束是否保留 task/result/audit |
| `worker.result_grace_seconds` | 15 | worker 退出后等待 result.json |
| `worker.scoped_artifacts` | 由并发推导 | 工件按任务隔离 |
| `worker_selection.mode` | prompt | `prompt` / `stats` |
| `worker_selection.min_runs` | 3 | 进入利用前的最少结束 run |
| `worker_selection.epsilon` | 0.1 | 0–1 |
| `worker_selection.epsilon_decay` | 0.99 | 严格在 0 与 1 之间 |
| `worker_selection.epsilon_min` | 0.01 | 0–1，且 ≤ `epsilon` |

`stats` 模式要求只读区里至少有一个 `worker_profiles` 条目。

### 保留 `retention`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `session_max_age_days` | 0 | 0 关闭年龄清理 |
| `session_keep_per_project` | 0 | 每项目保留最近 N 个 session |
| `sweep_interval_seconds` | 3600 | 0 关闭周期清理；改动会重挂定时器 |
| `refresh_artifacts` | false | sweep 时重建工件索引 |

### 完成校验 `verification`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `evidence_enforcement` | completion | `completion` 阻断无证据完成，`off` 关闭；对新建项目与无策略行的项目生效 |

### 预算 `budget`

`max_project_tokens`、`max_project_cost_usd`、`max_project_tasks` 默认都是 0（不限制）。
0 的 `max_project_tasks` 回退到 `runtime.max_project_workers`。预算按项目独立计算。

### 策略触发 `strategist`

`min_new_facts`、`min_new_hints`、`cooldown_seconds`、`failure_backoff_seconds`、
`max_runs_per_hour`、`zero_output_threshold`、`stale_intent_seconds`、
`fallback_interval_seconds` 为非负整数，`resource_pressure_ratio` 为 0–1。0 表示关闭对应
的触发器或上限；initial 与“没有未结束意图”是 urgent 触发，不受冷却与小时上限限制。

### 提案 `proposals`

`enabled`（默认 false）、`mode`（`off` / `dry_run` / `apply`）、`max_per_task`、
`max_file_bytes`、`max_total_bytes`、`allow_kinds`、`require_evidence_for_fact`、
`min_confidence`（0–1）。提案仍需 Observer 开启、任务 kind 命中 `observer.kernel_tasks`
且 `enabled` 为真。

## 4. 生效时机

| 字段 | 生效点 |
| --- | --- |
| 并发、超时、切片、证据门、预算、策略阈值、提案、选择策略 | 下一个调度 tick / 下一次任务准备 |
| `runtime.interval`、`retention.sweep_interval_seconds` | `Scheduler.reconfigure()` 重挂定时器 |
| `verification.evidence_enforcement` | 下一次 `VerificationService.defaultKind` 读取（getter） |
| `worker.*` | 下一次 `prepareTask`；运行中的任务沿用已经写好的 `task.json` |

正在运行的任务不会被改写或中断；新配置只影响之后的派发。

## 5. 只读项

以下内容涉及进程、网络或凭据布局，仍须改 dispatch.yaml 并重启。弹窗的灰色只读区只做
展示：

- `server`
- `runtime.execution`、`runtime.prompt_group`、`runtime.healthcheck_timeout`、
  `runtime.worker_healthcheck`
- `common_env`（只显示键名，不显示值）
- container / local 的 `workspace_root` 与 `completed_action`
- `observer`（`enabled`、`model`、节奏、`kernel_tasks`）
- `audit_stream`
- `worker_profiles`
- `verification.challenge` 的环境变量名与超时

## 6. 前端行为

- 页头两个工具条各有一个滑块图标，打开 `data-modal="runtime"` 弹窗；Esc / 背景 / 关闭
  按钮走统一的模态栈，写请求进行中不允许关闭。
- 字段按「调度 / 任务超时 / 图切片与证据 / Worker 与选择 / 保留与预算 / 策略触发 / 提案」
  分组；数字、开关、下拉与多选（`allow_kinds`）四种控件。
- 与 `defaults` 不同的字段显示琥珀色「已覆盖」，顶部显示覆盖项数量与更新时间。
- 「保存并生效」发送最小 patch；服务端拒绝时把具体约束错误显示在弹窗里。
- 「恢复 dispatch.yaml 默认值」需要连续点击两次（4 秒内），然后发 `DELETE`。

## 7. 测试

- `apps/cairn/src/config-overrides.test.ts`：键白名单、深合并、视图形状、原地同步保持
  引用、持久化与重启重放、非法值不改配置、跨字段冲突、重置、坏数据清理。
- `apps/cairn/src/http/api.settings-runtime.test.ts`：GET/PUT/DELETE、409、400（未知键 /
  越界 / 非法 JSON）、413、operator token、跨源拒绝、错误不落库。
- `apps/cairn/src/scheduler/loop.test.ts`：`reconfigure()` 在启动后重挂定时器、启动前调用
  无副作用。
- `apps/cairn/src/http/api.ui.test.ts`：弹窗挂载点、每个可编辑路径恰好一个控件、最小
  patch、空数字输入、400/409 行内错误、二次确认重置、写入期间禁止关闭。
