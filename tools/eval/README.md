# 确定性评估：完成契约与上下文

## 完成契约评估（M42）

`tools/eval/` 是 M40/M41 的最小回归评估集。它用确定性 worker 跑同一组五个场景，分别模拟
加固前后：

- **legacy**：M40/M41 之前的策略（单数 `verification` + `off_completion: auto` /
  `evidence_completion: auto`），完成声明可以直接关项目。
- **hardened**：当前契约（M41 目标条件 + 默认人工完成复核）。

```bash
bun run eval                 # 写 runs/eval-<date>.json
bun run eval -- --out /tmp/eval.json
bun run eval -- --cycles 2   # 调试时缩短每个场景的调度轮数
```

`runs/` 已被 git 忽略。脚本不调用模型，使用 `scenario-worker.ts` 写 `usage.json` 与
`result.json`，因此完成结果、成本、耗时和尝试次数在 CI 中可重复。

## 场景

| id | 目标是否真的达成 | 行为 |
| --- | --- | --- |
| `single_flag` | 是 | 目标只需一个 flag，worker 声明完成；challenge 计数 1/1 |
| `partial_flag` | 否 | 目标需要两个 flag，只拿到 1/2，worker 仍声明完成 |
| `wrong_completion` | 否 | 没有任何已确认 flag，worker 用完成声明收尾 |
| `budget_exhausted` | 否 | bootstrap 只交 Fact，预算在 100 tokens 处耗尽 |
| `missing_evidence` | 否 | 声明完成，但任务没有留下证据文件 |

## 指标

- `completion_rate`：项目在评估轮数内变成 `completed` 的比例。
- `legitimate_completion_rate`：完成且场景目标确实达成的比例。
- `wrong_completion_rate`：完成但目标未达成的比例。这是 M40/M41 要压到 0 的指标。
- `tokens` / `cost_usd`：来自每个 worker 的 `usage.json`，由 scheduler 的 `runs` 汇总。
- `duration_ms`：`runs.duration_ms` 之和；另在报告里给 `wall_ms` 方便排查。
- `attempts`：该场景派发并结束的 run 数。

## 结果解读

在 2026-11-01 的基线运行中：

| 版本 | 完成率 | 错误完成率 | 合法完成 |
| --- | --- | --- | --- |
| legacy | 3/5 | 2/5 | 1/5 |
| hardened | 1/5 | 0 | 1/5 |

legacy 的两次错误完成分别来自 `partial_flag`（只拿到 1/2）与 `wrong_completion`（没有
flag）。hardened 把两者都留在 active，并把 `missing_evidence` 与 `budget_exhausted`
继续挡在完成的门外。成本与尝试次数会随配置变化，比较时以同一次报告里的两个 variant 为准。

## `done_when` 的处理

M42 **不**把 `intent_meta.done_when` 写进提示词。当前数据层没有该列，prompt 与
AgentContext 也没有对应字段，因此本评估集把结论固定为：

```json
"done_when": {"in_prompt": false, "evaluated": false}
```

它应作为独立实验评估：先在 `intent_meta` 落列并只写入 AgentContext，再用同一组场景做
“提示词含 done_when / 不含 done_when”的 A/B，重点看错误完成率与平均尝试次数是否改善。
在该实验通过前，不把 `done_when` 加入默认 prompt。

## 真实模型评估

`scenario-worker.ts` 只是 fake solver。要做真实模型对照，保留 `scenarios.ts` 的定义，
把 worker 换成真实 `cairn worker`，并为每个场景准备确定性的本地靶场；报告 schema 与
指标口径可以直接复用。真实运行不进 CI。

## 任务上下文评估（M47）

```bash
bun run eval:context
bun run eval:context -- --out /tmp/context-eval.json
```

`context.ts` 在隔离临时库与工作区中构建真实图、sidecar 和任务文件，生成 ContextPlan，
再用同一份输入关闭审计重新准备，对比 WorkerTask（仅规范化随机 task ID）与图/AgentContext
的文件字节；结束后删除临时目录。**不启动 worker、不调用 SDK/模型或网络服务**，不需要凭据。
默认报告写 `runs/context-eval-<date>.json`，不覆盖 M42 的完成评估；可用 `--out` 指定路径。

| id | 内容 | 重点 |
| --- | --- | --- |
| `small` | 3 条新增事实、2 条开放意图 | 小项目基线 |
| `many_facts` | 260 条新增事实 | AgentContext 事实上限与完整图恢复范围 |
| `many_intents` | 130 条开放意图 | 意图上限与历史子分组被挤出 |
| `long_description` | 一条约 630 KB 的 UTF-8 描述 | 条数上限不能限制总字节；不自动裁剪 |
| `many_hints` | 80 条长提示 | 图中 hints 的完整保留 |
| `agent_context_truncated` | 230 条新增事实、110 条开放意图、30 次失败尝试 | 原有多处截断、detail clipping 和历史恢复缺口 |
| `graph_slice` | 有因果链的图，explore 切片 | project coverage 与旧 slice.truncated 分开 |
| `conclude_resume` | explore conclude 携带恢复目录 | 历史大小必须 unknown，不能视为零 |

报告 `schema: 1`、`mode: deterministic-context-preparation`、`model_calls: 0`、
`compression_applied: false`。每个场景包含：

- `totals.solver` / `totals.observer`：提示词、必读快照、可选资料、未知来源，两个消费者不相加。
- `sources`：各来源字节、measurement、读取要求、coverage、候选/选入/省略数、限制与恢复说明。
  不复制随机 task ID、文件路径、正文、摘要或动态时间戳。父 selection 与子分组不可重复求和。
- `budget` / `warnings`：128 KiB 审计阈值与超限告警；绝不影响输入或派发。
- `compatibility`：`worker_inputs_unchanged` 与 `snapshot_bytes_unchanged` 必须都为 true。
- 默认 token 估算均为 `null`；不是字符除以四，不模拟真实费用。

同一环境下反复运行的指标应相同；路径长度/平台换行等运行环境可能改变 prompt 字节，跨环境
比较需明确基线。生产任务的原始清单另含 task ID 与文件 SHA-256，故不承诺原始清单跨任务
逐字节相同。

2026-11-04 的离线验收：8 个场景兼容性全部通过；超长描述、大量 hints、AgentContext 已截断
三个场景超过默认阈值，只告警而不改输入。该结果证明**计量与兼容性**，不证明模型少花了
多少 token、少做了多少重复探索、完成率改善或 SDK 会话压缩后的信息保真度；这些留待后续
选择/恢复功能及经批准的真实模型评估。

## 预算选择与恢复评估（M48）

```bash
bun run eval:context-pack
bun run eval:context-pack -- --out /tmp/context-pack-eval.json
```

`context-pack.ts` 通过共享的 `seedContextScenario` 复用 M47 **同一组八类图夹具**，分别准备 off、
shadow、apply 的真实任务文件；没有 worker、SDK、模型或网络调用。默认报告写
`runs/context-pack-eval-<date>.json`，不覆盖 M47/M42 报告。

报告 `schema:1`、`mode:deterministic-context-pack`、`model_calls:0`。每个场景给出：

- `legacy_initial_bytes / candidate_initial_bytes / actual_initial_bytes`：原输入、候选与实际账单；候选不能当实际节省。
- `status / fallback_reason`：applied、fallback 或 not_applicable；无净收益时允许保留原输入。
- `saved_initial_bytes / reduction_percent`：仅首次必读 UTF-8 字节，不是模型 token 或费用。
- `shadow_worker_inputs_unchanged`、`legacy_snapshot_bytes_unchanged`、`observer_snapshot_unchanged`。
- `pinned_state_preserved`：确实生成候选时，对照目标/条件、审核、Scope 和预算核心状态；否则 null。
- `recovered_records / recoverable_records`：逐条从实际 store 恢复并与授权投影比较；没有生成 store 的回退/不适用场景为 0/0，**不是已经验证恢复成功**。
- `selections` 与 `resumed_history_unknown`：真实候选/选入数量及不适用的恢复会话继续 unknown。

验收要求：所有实际 apply 的账单不超过共享阈值且比 legacy 小；大量 facts/intents/hints 固定夹具
至少减少 30%；shadow worker 输入、Observer 与兼容快照不变；可恢复授权记录全部比对成功。
原始 run detail 超过既有 500 字符边界的部分仍为 control_plane_only，不在恢复率分母中。

这里验证的是**输入选择与授权投影恢复**。完整快照/索引会增加磁盘与准备开销，后续读取也可能把
上下文重新扩大；不能据此声称真实完成率、探索质量、全会话费用或 SDK 会话压缩质量改善。需要
另行批准的真实模型对照才能测这些指标；不同平台路径长度不同，应在同一环境内比较。


## 任务检查点验收（M49）

```bash
bun test packages/contracts/src/checkpoint.test.ts packages/graph/src/checkpoints.test.ts
bun test apps/cairn/src/checkpoint/worker.test.ts apps/cairn/src/scheduler/checkpoint.test.ts
bun test apps/cairn/src/scheduler/checkpoint.scheduler.test.ts apps/cairn/src/scheduler/checkpoint.context-pack.test.ts
```

前两组校验有界契约、原子/定时发布、版本接收与状态复核。scheduler 测试用真实 LocalRuntime 子进程
产生确定性观察，覆盖运行中接收、成功/崩溃/硬截止/取消/半写入、启动补接与 session 删除后的保留；
ContextPack 测试对比预算内整条输入和有界分片恢复，实际任务准备的 ContextPlan 字节另在
`context-pack.tasks.test.ts` 验证。全程不调用 SDK 模型或外网，也不执行检查点的 next_steps。

`eval:context`、`eval:context-pack` 与 M42 `eval` 仍作为默认关闭的兼容/完成契约回归，不把检查点保存率
冒充重复探索减少、模型完成率或费用改善。只有模型显式上报的语义能保存；周期重发不会生成未观察的细节。
