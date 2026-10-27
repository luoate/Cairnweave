# Worker 契约

控制面与 worker 之间只通过**文件**通信：`task.json` → `result.json` + `usage.json` +
`audit.jsonl`。worker 不连接 SQLite，也不通过 RPC 回传结果。本文件是这些文件的字段、
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
| `reason` | `{"complete":{"from":[...],"description":"..."}}` 或 `{"intents":[...],"hints":[...]}`；intent 需 `from` + `description`，可选 `priority`（0–100）、`budget`（`max_seconds` / `max_tool_calls` 正整数）与 `dedupe_key`（≤128）；hint 只允许 `{"content":"..."}` |
| `bootstrap` | `{"fact":{"description":"..."},"complete":{"description":"..."}}` |
| `explore` | `{"description":"..."}` |
| `conclude` | `{"fact":{"description":"..."}}` |

兼容性：控制面同时接受带信封与裸载荷，`intents` 也接受单数 `intent`。`complete` 与
`intents`/`hints` 不能同时出现；`open_intents` 为空时不允许返回空 intents。数量由
`tasks.reason.max_intents` 等配置截断。

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
  `solver-session/**`；控制面写：`task.json`、`graph.yaml`、`stdout.log`、`stderr.log`。
- 控制面在 `worker.result_grace_seconds` 内轮询 `resultPath`；任务文件默认保留，
  `worker.retain_task_files: false` 可关闭。
- worker 的**所有**输出都按不可信输入处理：JSON 必须过本文件的校验后才写图，路径必须在
  工作区/`artifactDir`/`scope` 允许范围内。

## 8. 安全边界

`task.json`、`result.json`、`usage.json` 与日志里**不得出现模型凭据**。凭据只存在于
agent 配置目录（`~/.tch-agent/config`）；控制面写派发文件时只写 profile id 与
model-prefs 条目名。Host Bridge 是工具调用层的闸门，不是代码沙箱；对抗不可信代码时以
容器网络/文件系统命名空间为准。控制面 API 与 UI 没有身份认证，默认只绑定回环地址，
远程部署必须加网络层访问控制。
