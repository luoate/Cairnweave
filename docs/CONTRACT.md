# Worker 契约

控制面与 worker 之间只通过**文件**通信：`task.json` → `result.json` + `usage.json` +
`audit.jsonl`（M49 可选另有 `checkpoint.json`）。worker 不连接 SQLite，也不通过 RPC 回传结果。本文件是这些文件的字段、
校验与边界的权威说明；任务生命周期与目录布局见
[`ARCHITECTURE.md`](./ARCHITECTURE.md) 第 3–4 节。

## 1. 版本

`task.json` 带 `protocol: 1`（`packages/contracts/src/task.ts` 的
`TASK_PROTOCOL_VERSION`）。新增**可选**字段不升版本；删除字段、改变必填性或语义时升版本，
worker 与控制面必须同版本部署。所有校验是“收集全部错误再返回”，不是遇到第一个就抛。

## 2. task.json（控制面 → worker）

worker 视角的绝对路径；本地模式就是宿主路径，容器模式是 `/cairn/workspace/...`。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `protocol` | 是 | 固定 `1` |
| `taskId` | 是 | `<kind>-<12 hex>`，同时是 run 的关联键 |
| `kind` | 是 | `bootstrap` / `reason` / `explore` / `conclude` |
| `projectId` | 是 | 项目 id |
| `intentId` | explore/conclude 必填 | 本次任务推进的意图 |
| `prompt` | 是 | 已渲染的完整 prompt；图只给路径，不内联 |
| `graphSnapshotPath` | 是 | `sessionDir/graph.yaml`（或切片） |
| `workspace` | 是 | 项目工作区 |
| `sessionDir` | 是 | 本次任务目录 |
| `resultPath` | 是 | **必须位于 `sessionDir` 内**；worker 启动时再次校验 |
| `resumeSessionDir` | conclude 必填 | 失败任务的 session 目录，用于续跑 |
| `concludeOf` | conclude 必填 | `bootstrap` / `explore` |
| `artifactDir` | 否 | `artifacts/<task-id>`，只能位于 `artifacts/` 下的相对路径；开启同项目并发时出现 |
| `scope.targets` | 是 | 已授权的 host / host:port / URL / CIDR，**不得为空**（fail closed） |
| `scope.notes` | 否 | 字符串 |
| `softDeadlineSeconds` | 否 | 正数且小于 `hardDeadlineSeconds`；conclude 不设置 |
| `hardDeadlineSeconds` | 是 | 正整数 |
| `maxToolCalls` | 否 | 正整数；Host Bridge 的调用上限，超出后只拒绝工具、仍允许写结果 |
| `workerProfile` | 否 | 命名的派发 profile id，≤64 字符且无控制字符 |
| `model` | 否 | model-prefs 条目名，≤128 字符且无控制字符；覆盖 prompt frontmatter |

`scope.targets` 不是提示：Host Bridge 在每次工具调用前用它做硬校验，允许与拒绝都写入
`audit.jsonl`。`artifactDir` 存在时，写其它任务的 artifacts 目录同样被拒绝。

## 3. result.json（worker → 控制面）

沿用 Cairn 原信封，worker 原子的写（临时文件 + `rename`）：

```json
{ "accepted": true,  "data": { "description": "..." }, "evidence_refs": ["loot/flag.txt"] }
{ "accepted": false, "reason": "explain why the task declined" }
```

- `accepted` 必须是布尔值；`false` 时 `reason` 必须是非空字符串。
- `true` 时 `data` 必须是对象；`data.description` 若出现必须是字符串。
- `evidence_refs` 可选，元素必须是工作区相对路径的非空字符串；控制面只校验路径合法性与
  工作区包含关系，不证明文件内容支持该 Fact。
- 结果文件是**唯一权威输出**。stdout/stderr 只作诊断，模型把 JSON 打到 stdout 不算结果。
- 宽松 JSON 提取（整段、fence、前后散文）只作用于 Solver 文本；写进 `result.json` 的必须
  是严格 JSON。解析失败按“没有可用答案”处理。

`data` 的载荷按 `kind` 解释（`packages/contracts/src/payloads.ts`）：

| kind | 可接受的 `data` |
| --- | --- |
| `reason` | `{"complete":{"from":[...],"description":"..."}}` 或 `{"intents":[...],"hints":[...]}`；intent 需 `from` + `description`，可选 `priority`（0–100）、`budget`（`max_seconds` / `max_tool_calls` 正整数）与 `dedupe_key`（≤128）；hint 只允许 `{"content":"..."}`；M37 还可带 `"abandon":[{"intent_id":"...","reason":"..."}]`（≤1 条、理由 ≤500 字符，需 `strategist.reason_abandon: on` 才会生效） |
| `bootstrap` | `{"fact":{"description":"..."},"complete":{"description":"..."}}` |
| `explore` | `{"description":"..."}` |
| `conclude` | `{"fact":{"description":"..."}}` |

兼容性：控制面同时接受带信封与裸载荷，`intents` 也接受单数 `intent`。`complete` 与
`intents`/`hints`/`abandon` 不能同时出现；`open_intents` 为空时不允许返回空 intents。
数量由 `tasks.reason.max_intents` 等配置截断。

## 4. usage.json（worker → 控制面）

与 `result.json` 同目录的旁路文件，来自 Solver 会话自身的计数器，不来自模型回答：

| 字段 | 校验 |
| --- | --- |
| `input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens` / `total_tokens` | 非负整数 |
| `cost_usd` | 非负有限数 |
| `model` | 可选，`provider/model-id`，≤200 字符且无控制字符 |

单文件上限 16 KiB。缺失或非法时按“没有用量”处理：run 记为 0 Token/成本、`model` 为
`null`；不会让任务失败，也不会阻断结果落图。

## 5. audit.jsonl（worker → 控制面）

Host Bridge 每做一次工具决策就追加一行 JSON：

```json
{"ts":"2026-10-27T00:00:00.000Z","task_id":"explore-...","project_id":"proj_001",
 "tool":"bash","action":"command","targets":["127.0.0.1:8080"],"decision":"allow",
 "reason":null,"detail":"command=nmap 127.0.0.1","event":"tool_budget_exhausted"}
```

- `decision` 为 `allow` / `block`；`reason` 在允许时为 `null`；`detail` 最多 400 字符；
  `targets` 是归一化后的目标；`event` 可选。
- M33 的携带目标观察在同一次工具调用后**再追加一行**，`event` 固定为 `ssrf_candidate`：
  `targets` 是请求内部携带的字面量（不是这条命令的连接目的，最多 16 个），`decision` 沿用
  本次调度的判定（`observe` 通常是 `allow`，`block` 模式拒绝时为 `block`），`reason` 以
  `SSRF markers (<mode>):` 开头并给出携带数、越界数与读取的载荷文件数。

```json
{"ts":"2026-10-31T00:00:00.000Z","task_id":"explore-...","project_id":"proj_001",
 "tool":"bash","action":"command","targets":["http://10.0.0.9/admin"],"decision":"allow",
 "reason":"SSRF markers (observe): 1 carried target(s), 1 outside the authorized scope, 1 payload file(s) read",
 "detail":"command=curl --data-binary @payload.xml","event":"ssrf_candidate"}
```

  摄入不按 `event` 过滤（任何 JSON 对象行都进哈希链），所以新增事件类型不需要 schema 变更。
- 单条事件的紧凑 JSON 上限 16,384 字符（`MAX_AUDIT_EVENT_TEXT_CHARS`）。
- 任务结束时控制面把 `audit.jsonl` 导入项目级 `audit_events`，按 `(task_id, seq)` 计算
  哈希链（`prev_hash` / `hash`）；可经 `/projects/{id}/audit` 读取。链只防库内改行，不是
  签名；worker 崩溃前没写下的决策不在链上。
- 启用 `audit_stream` 时，Host Bridge 先写本地文件，再把同一事件 POST 到控制面；流只转发
  文件里已有的行，本地文件始终是 finish-time 回溯的源。

## 6. 退出码

`packages/contracts/src/exit-codes.ts`：

| 码 | 含义 |
| --- | --- |
| `0` | 已写出合法 `result.json`（`accepted: false` 也是 0） |
| `2` | 调用方式错误（缺 `--task`、未知参数） |
| `3` | 跑了但没有可用答案（硬超时、Solver 崩溃、空回复） |
| `4` | worker 自身崩溃或无法写结果 |
| `10` | 任务文件缺失、不可读或违反契约 |

非 0 退出都按失败处理；explore/bootstrap 失败且存在 `solver-session/*.jsonl` 时，控制面
保留租约并排队 `conclude`，否则释放意图。

## 7. 路径与原子性

- 目录：`<workspace_root>/<project_id>/.cairn/sessions/<taskId>/`。
- worker 写：`result.json`（临时文件 + `rename`）、`usage.json`、`audit.jsonl`、
  `solver-session/**`；控制面写：`task.json`、`graph.yaml`、`agent-context.yaml`（M36，
  `runtime.strategy_context: on` 时）、`stdout.log`、`stderr.log`。`agent-context.yaml`
  只在提示词里被引用，不是 `task.json` 字段。
- 控制面在 `worker.result_grace_seconds` 内轮询 `resultPath`；任务文件默认保留，
  `worker.retain_task_files: false` 可关闭。
- worker 的**所有**输出都按不可信输入处理：JSON 必须过本文件的校验后才写图，路径必须在
  工作区/`artifactDir`/`scope` 允许范围内。

## 8. 安全边界

`task.json`、`result.json`、`usage.json` 与日志里**不得出现模型凭据**。凭据只存在于
agent 配置目录（`~/.cairnweave/config`，M26 前为 `~/.tch-agent/config`）；控制面写派发文件时只写 profile id 与
model-prefs 条目名。Host Bridge 是工具调用层的闸门，不是代码沙箱；对抗不可信代码时以
容器网络/文件系统命名空间为准。控制面 API 与 UI 没有身份认证，默认只绑定回环地址，
远程部署必须加网络层访问控制。

## 9. checkpoint.json（M49，可选、未验证进度）

任务协议仍是 `protocol:1`，WorkerTask 不加字段。控制面由固定环境
`CAIRN_TASK_CHECKPOINT=1`、`CAIRN_CHECKPOINT_INTERVAL_SECONDS=1..60` 启用本任务采集；默认关闭。
本文件是与 result/usage 分开的**数据通道**，不能改变 accepted、outcome 或完成判定。

```json
{
  "version": 1,
  "project_id": "proj_example",
  "task_id": "explore-example",
  "intent_id": "i001",
  "sequence": 3,
  "stage": "working",
  "progress": "请求尚未执行",
  "attempts": [{
    "id": "a1",
    "action": "测试候选入口",
    "observation": "依赖不可用，工具没有启动",
    "interpretation": "尚不能检验或否定该假设",
    "result": "environment_failure",
    "fact_refs": ["origin"],
    "evidence_refs": ["artifacts/task-example/test.log"]
  }],
  "unresolved": ["依赖缺失"],
  "next_steps": ["仅供后续重新判断，不自动执行"]
}
```

所有字段必填，intent_id 可以为 null；version 固定 1，sequence 为正 safe integer；身份必须与控制面
run/project/task/focus 完全一致。stage 仅 `started/working/soft_deadline/solver_returned/solver_failed`，
也是 worker 自报，不是控制面终止原因。

每条 attempt 的 result 仅 `observed/negative_observation/tool_failure/environment_failure/timeout/cancelled/
scope_denied/not_executed/inconclusive`；非执行/工具失败/超时不能被解释成假设反证。
字符上限：project_id/intent_id 128、task_id 192、progress 4096、attempt id 96（非空且本快照唯一）、
action 2048（非空）、observation 4096、interpretation 2048；最多 32 个 attempts、每条 32 个非空 fact refs
（每个最多 128 字符）、16 个 evidence refs（每个最多 512 字符）、unresolved/next_steps 各 16 条
（每条 1024 字符）。evidence refs 必须是工作区相对文件路径，不能含空路径段、点/父目录、控制字符、
冒号或反斜线。最终文件上限 65536 UTF-8 字节；不是字符数上限。未知字段拒绝，不能夹带 complete/授权字段。

原子发布仅替换同 session 的固定 `checkpoint.json`，临时文件不接收。文件保持 `0600`；Linux 容器/宿主
不同 UID 部署需确保控制面读取权限，本阶段不自动放宽权限。控制面进行有界普通文件读取与严格
schema 校验，只返回固定状态，不输出原始解析异常；与旧 task/result 的字段错误列表口径不同。
同 sequence 同语义 payload 为 duplicate，同 sequence 不同内容为 conflict，更低为 stale；三者都不覆盖
最后有效版本。最终化后拒绝新版本，坏/缺/半写文件不清空已有记录。每个 run 一条最新 SQLite sidecar。

主 solver 的 `save_task_checkpoint({json})` 只接受 progress/attempts/unresolved/next_steps，身份、sequence
和 stage 由发布器填写；每次完整替换，模型负责保留相关累计记录。工具走原 gate 与工具预算，不注册给
subagent，不执行正文中的任何建议。CLI 启动、周期重发、软截止和结束更新尽力而为；硬杀不保证最后一个
动作已保存。模型未调用保存工具时可能只有空进度与生命周期标记，不能伪称已保存完整执行语义。

复用时 `attempts.memory.trust=worker_claim_not_verified`，control 字段独立取自 runs/sidecar；reuse 标注
当前意图状态、Scope 变化、项目状态、事实替代/缺失与证据 available/missing/unavailable，并明确当前预算
应取 pack core、automatic_execution 为 false。available 仅表示当前文件存在且在项目内，不代表验证通过。
正文按 M48 预算整体选择或省略，完整授权记录在 attempts 恢复分区；原 AgentContext/graph 形状不变。
不调用模型做摘要，不自动改图/完成状态，不把 SDK 历史持久化当成检查点接收成功。
