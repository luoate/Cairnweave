# 完成契约评估集（M42）

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
