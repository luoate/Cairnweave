# Observer（M4c，已实现）

状态：**已实现，默认关闭**。Cairn 合并版使用一个独立的 Cairn 原生适配层，复用
BreachWeave 的看板存储与 sidecar 工具，但不复用 challenge 续跑、host-bridge RPC 或
效率 steer。实现位于：

```
packages/agent/src/solver/extension/cairn-observer/
  index.ts      pi extension 工厂 + 主 solver 只读工具注册 + 系统提示
  context.ts    scheduler 环境契约、context/review prompt 格式化
  loop.ts       轮次采集、周期/结束/flush 触发、串行队列、审计
  review.ts     独立 sidecar 会话（只有看板/history 工具，无 shell/文件/网络）
  types.ts      选项、context、round/review payload 类型
```

配套改动在 `apps/cairn/src/config.ts`、`apps/cairn/src/scheduler/tasks.ts`、
`apps/cairn/src/scheduler/loop.ts`、`apps/cairn/src/runtime/{local,docker}.ts`、
`apps/cairn/src/solver/breachweave.ts`、`apps/cairn/src/host-bridge/`，以及 vendored
`packages/agent` 的 `board-store.ts`、`session.ts`、`index.d.ts` 和
`challenge-observer/{tools,observer-store,observer-agent}.ts`。

## 1. 行为摘要

- Observer 是**可选 sidecar**，只维护项目级 `ideas` / `memory` 看板；它不执行验证，
  不提交 flag，不写 Cairn 图，也不改变任务结果。
- 主 solver 只拿到三个**只读**看板工具：`memory_list`、`idea_list`、`idea_search`。
  看板写入由 sidecar 独占。
- 没有 `TCH_CHALLENGE_ID` 门控，没有 `attachChallengeContinuation`，没有
  `send_efficiency_reminder`。worker 仍然是一任务一进程、最后输出一个 JSON。
- `BreachWeaveSolver.solve()` 在返回答案前调用一次 `observer.flush()`；超时或任何
  Observer 错误只记录日志，**不会**改变结果、`result.json` 或退出码。
- 默认关闭；只有 `observer.enabled: true` 且任务 kind 命中 `kernel_tasks` 才启用。

## 2. 配置

```yaml
observer:
  enabled: false          # 默认关闭
  model: null             # model-prefs.json 条目；null 复用主 prompt 的模型
  every_rounds: 4         # 每 N 个 assistant 轮次触发一次周期 review
  window_rounds: 8        # 每次 review 带最近 N 轮
  timeout_seconds: 60     # 单次 review 与最终 flush 的上限
  max_reviews_per_task: 8 # 每任务最多执行的 review 数；0 等于关闭 review
  kernel_tasks: ["explore"]  # bootstrap / reason / explore / conclude
```

校验（`apps/cairn/src/config.ts`）：

- `enabled` 必须是布尔值；
- `model` 缺省或 `null` 表示复用主模型，显式空字符串报错；
- `every_rounds`、`window_rounds`、`timeout_seconds` 必须是正整数；
- `max_reviews_per_task` 必须是非负整数；
- `kernel_tasks` 只能包含上述四个 kind。

配置缺省时使用 `DEFAULT_OBSERVER`，因此旧的 `dispatch.yaml` 不需要改动。
`dispatch.example.yaml` 以注释形式给出默认关闭的 `observer:` 示例。

## 3. Scheduler → worker 契约

`scheduler/tasks.ts` 的 `prepareTask()` 为每个命中任务计算 Observer 路径并写入
`observer-context.json`；只有启用时才创建目录。路径全部经过现有的 host → worker
映射，容器模式下是 `/cairn/workspace/...`。

| 内容 | 本地路径 | 作用域 |
| --- | --- | --- |
| context 快照 | `<session>/observer-context.json` | 任务级 |
| 看板 | `<workspace>/.cairn/board/` | **项目级、跨任务** |
| review 状态/队列/轮次 | `<session>/observer/` | 任务级 |
| sidecar JSONL | `<session>/observer/sidecar/` | 任务级 |

环境变量（只有启用时注入完整契约；关闭时显式注入 `CAIRN_OBSERVER_ENABLED=0`）：

| 变量 | 必需 | 含义 |
| --- | --- | --- |
| `CAIRN_OBSERVER_ENABLED` | 是 | 只有精确的 `1` 才启用；其他值/缺失视为关闭 |
| `CAIRN_OBSERVER_CONTEXT_PATH` | 启用时 | 上面的 context 快照 |
| `CAIRN_OBSERVER_BOARD_DIR` | 启用时 | 项目级看板根目录 |
| `CAIRN_OBSERVER_STATE_DIR` | 启用时 | 任务级状态根目录 |
| `CAIRN_OBSERVER_MODEL` | 否 | model-prefs 条目；缺失时用主会话模型 |
| `CAIRN_OBSERVER_EVERY_ROUNDS` | 否 | 缺省 4 |
| `CAIRN_OBSERVER_WINDOW_ROUNDS` | 否 | 缺省 8 |
| `CAIRN_OBSERVER_TIMEOUT_SECONDS` | 否 | 缺省 60 |
| `CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK` | 否 | 缺省 8 |

`session.ts` 在**非 challenge 模式**且环境变量精确启用时才选择
`cairnObserverExtension`；否则保持原来的 `challengeObserverExtension` 路径。

### context 快照

任务开始时生成一次，不随图更新；内容来自 `ProjectDetail` + `task.json`：

- project id/title；
- focus task/kind/intent id 与描述；
- 已映射到 worker 视图的 scope targets/notes；
- 最多 20 个未结束 intent；**focus intent 永远排第一，不会被上限裁掉**；
- 最多 30 条 Fact：`origin` / `goal` 永远保留，其余优先最新插入的 Fact；
- 最多 10 条 Hint（最新）。

## 4. 轮次与 review

`loop.ts` 监听 pi 事件：

- `tool_execution_start/end`：按 `toolCallId` 关联参数摘要与结果摘要（各 160 字符），
  每轮结束后清空当前工具日志；
- `message_end`（仅 assistant）：轮次 +1，落盘 `<state>/rounds/00000N.json`，摘要最多
  220 字符；每 `every_rounds` 轮，若窗口内确实有活动，则入队一次 `periodic` review；
- `agent_end`：入队一次 `agent_end` review（每任务一次）；
- `flush`：若还没有 `agent_end` review，则把当前窗口作为 `flush` review 入队，然后等待
  队列清空。

review 队列串行消费；`max_reviews_per_task` 在入队前检查，超限写
`review_skipped: max_reviews_per_task`。队列中的损坏 JSON 会被删除并跳过，不会卡死后续
review。

## 5. sidecar 会话

`review.ts` 每次 review 创建独立会话：

- 配置目录使用 `CAIRN_AGENT_CONFIG_DIR`（缺省才回落到 `~/.tch-agent/config`），因此
  容器内任务级只读配置副本可用；
- 系统提示 = 上游 `OBSERVER_SYSTEM_PROMPT` + Cairn 适配段（没有 challenge
  state/difficulty/flag/hint 等概念）；
- `tools: []`，只注册 `createObserverSidecarToolsWithOptions({ enableSteer: false })`：
  `memory_list/add/update/delete`、`idea_list/search/add/update`、
  `query_solver_history`；
- 不加载 Host Bridge（sidecar 没有 shell/文件/网络工具），也不触发任何 challenge RPC；
- workspace 使用 `TCH_SOLVER_WORKSPACE`（或 cwd），JSONL 放在任务级
  `<state>/sidecar/`，与主 solver 的 session 隔离；
- `timeout_seconds` 到时会 dispose 会话并抛错，由 loop 审计为 `review_failed`。

## 6. flush、失败语义与审计

`BreachWeaveSolver.solve()` 在返回答案前：

```ts
await flushObserver(observer); // 有界等待，绝不抛到调用方
return answer;
```

- `CairnObserverHandle.flush()` 的整个实现包在 try/catch 中；即使状态目录不可用，
  也只会写一条审计（best effort）并返回，**不会抛出**；
- flush 的等待上限是 `timeout_seconds`（调用方可覆盖）；超时后放弃未完成的 review，
  因为 worker 随后就写结果并退出；
- 任务被硬杀时 review 一并终止，不补跑；看板可能落后一轮，这是明确接受的；
- Observer 的任何错误都不写 `result.json`，不改变 `accepted`，不改变 worker 退出码；
- 审计文件：`<state>/audit.jsonl`，事件包括 `review_started`、`review_finished`、
  `review_failed`、`review_skipped`、`flush_finished`、`flush_timeout`、
  `flush_failed`；记录触发原因、轮数、耗时、applied、错误文本，不记录完整 prompt 或
  工具输出。
- 同项目并发时，每次 review 前获取 `<board>/locks/review.lock` 项目级租约：原子
  `mkdir`、写入持有者/时间元数据、周期心跳；等待上限取 `min(5s, timeout_seconds)`。
  拿不到租约时跳过本轮，审计 `review_skipped` 且 reason 为 `board_lock_busy`（等待
  超时）或 `board_lock_error`（锁目录不可用）。释放前校验持有者 id，避免删除他人
  （已过期接管）的租约。跳过不阻塞 solver 收尾，也不改变结果。

## 7. 权限与 Host Bridge

- `LOCAL_TOOLS` 增加主 solver 的三个只读看板工具；它们只读项目看板，不接触 scope 目标。
- `memory_add/update/delete`、`idea_add/update` 不在主 solver 白名单中；Host Bridge 对
  未知工具 fail closed，因此主 solver 无法写看板。
- 文件工具额外受 `protectedWriteRoots` 限制：`CAIRN_OBSERVER_BOARD_DIR` 下的
  `write` / `edit` 会被拒绝，但 `read` 允许。
- sidecar 不加载 Host Bridge：它只有看板工具与 `query_solver_history`，没有任何可越界
  的执行能力。
- **边界**：`protectedWriteRoots` 只覆盖结构化文件工具，不解析 `bash` 命令的文件写入。
  主 solver 若用 `bash` 直接写 `.cairn/board`，当前闸门不会拦截（`audit.jsonl` 仍会记录
  该命令）。看板完整性因此是“策略级”，不是内核级；需要严格隔离时应把看板放到不挂载
  给 worker 的目录，或只给 worker 只读挂载。同项目并发时 review 之间的写入由项目级
  租约串行（见 §6），但该租约不拦截 `bash`，也不保护主 Solver 绕过只读工具的情况。

## 8. 测试覆盖

不计费的 `bun test` 覆盖：

- 配置：默认关闭、完整解析、非法 `every_rounds` / `timeout_seconds` /
  `kernel_tasks` 报错；
- 环境契约：只有精确 `CAIRN_OBSERVER_ENABLED=1` 才启用；必需路径缺失时关闭；数值非法
  时回落到默认值；
- scheduler：启用时写 context/env、`kernel_tasks` 之外不启用、默认关闭、focus intent
  在上限之外仍被保留、facts/hints 截断规则；
- 路径：`CAIRN_OBSERVER_BOARD_DIR` 优先、显式 sessionDir 保持上游布局、无配置时 fail
  closed；
- loop：周期 + flush、`max_reviews_per_task`、review 挂起时 flush 超时不抛、
  state 目录不可用时 flush 仍不抛、并行工具调用的事件写入串行化后不丢日志；
- review 租约：同一时刻只有一个持有者、心跳过期后可接管、缺元数据时按目录 mtime
  回收、释放不会删除已被接管的租约；另一任务持有租约时本轮 review 被跳过；
- 队列：损坏 JSON 被跳过并删除，后续 review 仍能消费；
- Host Bridge：只读看板工具 allow、写工具 block、看板文件写路径 block；
- runtime：`extraEnv` 合并与覆盖顺序。

`BreachWeaveSolver.solve()` 里的 `flushObserver()` 只是 try/catch 包装，没有单独的
真实 Solver 单测；`flush()` 本身“不抛”的契约已由 loop 测试覆盖。真实模型成功路径见
下面的计费 gate；失败注入（review 抛错/超时后答案不变）仍由代码结构、loop 契约和
审计测试保证，没有做真实模型故障注入。

**真实模型 gate**：`tools/gate/m4c-observer-gate.ts`（计费，不计入 `bun test`）在本地
模式跑一个真实 bootstrap 任务，预置一条 pending idea，并检查：

- scheduler 写出启用的 context，路径与 scope 正确；
- 主 solver 调用 `idea_list` / `memory_list` 只读工具，且没有调用任何看板写工具；
- sidecar 实际执行 review，只使用看板/history 工具，没有 `send_efficiency_reminder`；
- 审计包含 `review_started`、`review_finished`、`flush_finished`，没有失败/超时/跳过；
- review 队列在 solver 返回前清空；
- 预置 idea 从 pending 变为 verified，并新增 memory；
- 最终 Fact 仍包含真实 marker，证明 Observer 没有改变任务结果。

2026-10-25 实跑 **14/14 PASS**。该 gate 只覆盖一次短 bootstrap；长任务、真实成本、
延迟与看板质量仍需更多实测。

## 9. 与设计稿的差异 / 已知限制

1. 实现放在 `packages/agent/src/solver/extension/cairn-observer/`，而不是最初设计的
   `apps/cairn/src/observer/`。原因是 pi extension、sidecar 会话和看板工具都在
   `packages/agent` 内；放在 vendor 侧的独立子目录可以复用类型而不复制实现。代价是
   `packages/agent` 多了一个 Cairn 专用目录（已在上面的文件列表中说明）。
2. `observer.model: null` 表示复用主 prompt 模型；设计稿里写的是固定短 ID。这样默认
   行为最省配置，但长任务上 review 成本可能偏高，建议显式配置便宜模型。
3. 看板已有项目级 review 租约（M8），但它是**建议性协调**：租约只覆盖 Observer review
   的整个生命周期，不覆盖主 Solver 的 `bash` 写入；持有进程被冻结超过 stale 窗口时，
   另一个 review 会接管，两个 review 可能短暂同时运行。`board-store` 本身对
   ideas/memory 的跨进程目录锁仍保留，单条写入是原子的。
4. `bash` 对看板目录的写入不被 Host Bridge 拦截，见 §7。
5. `agent_end` review 与最终 `flush` 都会把“窗口内所有轮次”作为输入；Review prompt
   不内联看板内容，sidecar 需要自己调用 `memory_list` / `idea_list`。
6. 没有把看板摘要写进 `graph.yaml`；主 solver 需要显式调用只读工具才能看到看板，避免
   改变图导出语义。
7. `m4c-observer-gate.ts` 已用真实模型跑通 14/14，但只覆盖一次短 bootstrap；真实成本、
   延迟和长任务看板质量仍需更多实测。该 gate 不覆盖容器内 Observer 路径（容器配置副本
   与路径映射由 M3 gate 和 runtime 单测覆盖）。
8. `query_solver_history` 读取 `TCH_SOLVER_SESSION_DIR`；conclude 任务恢复的 JSONL 在
   失败任务的目录，而该变量仍指向 conclude 任务自己的 `solver-session/`，因此把
   `conclude` 加入 `kernel_tasks` 时 sidecar 可能看不到恢复的历史。默认只启用
   `explore`，不受影响；如需启用 conclude，需要额外传入实际恢复目录。
