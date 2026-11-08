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
| `softDeadlineSeconds` | 否 | 正数且小于 `hardDeadlineSeconds`；所有任务类型都设置（M58b 起 conclude 也有，默认 `worker.soft_deadline_ratio` 0.8，60 秒硬截止 → 48 秒） |
| `hardDeadlineSeconds` | 是 | 正整数 |
| `maxToolCalls` | 否 | 正整数；Host Bridge 的调用上限，超出后只拒绝工具、仍允许写结果 |
| `reserveToolCalls` | 否 | 正整数，须小于 `maxToolCalls`；M57b 的末尾保留段，进入后只有本任务 `artifactDir`（未开启工件隔离时为工作区内）的写入被放行，其余调用以 `tool_budget_reserve` 拒绝且不消耗保留段 |
| `workerProfile` | 否 | 命名的派发 profile id，≤64 字符且无控制字符 |
| `model` | 否 | model-prefs 条目名，≤128 字符且无控制字符；覆盖 prompt frontmatter |
| `reasoning` | 否 | `"on"` / `"off"`；调度器按 `worker.reasoning` 与任务类型写入，缺省时由模型配置决定 |
| `tools` | 否 | M57c：工具白名单，与 prompt 已声明的工具取交集。只能收窄，不会新增；reason 默认只给 read/grep/find/ls |
| `bashTimeoutSeconds` | 否 | M58：本任务单条 bash 命令的上限（秒）。控制面写入 `min(tasks.bash_timeout_seconds, hardDeadlineSeconds − 15)`，worker 再按实际剩余时间收紧；任务总会带一个值，命令不可能无超时运行。M59：worker 另从进程环境导出 `CAIRN_TASK_STARTED_MS`（绝对时间），连同软/硬截止一起用于把剩余时间回显到工具结果；这些都不是 task.json 字段 |

`scope.targets` 不是提示：Host Bridge 在每次工具调用前用它做硬校验，允许与拒绝都写入
`audit.jsonl`。`artifactDir` 存在时，写其它任务的 artifacts 目录同样被拒绝。

M57d 的端点识别规则（仍然 fail closed，只消除误报）：只有**命令位置**的工具才算网络调用
（`which curl`、`ls curl` 不算，`sudo`/`timeout` 等包装命令会跳过）；写在脚本里的 heredoc
正文不扫描（`python - <<EOF` 这类继承 stdin 的 heredoc 仍扫描，其 import 照样拒绝）；
`-H/--header`、`-b/--cookie`、`-A/--user-agent`、`-e/--referer` 的值按 carried 处理，交给
`scope.ssrf_markers` 策略而不是主目标校验；端点没有端口时，若 scope 目标是默认 Web 端口
（80/443）则视为同一目标。

`reasoning` 只影响生成参数，不改变工具权限或范围校验：`off` 时 worker 对整个会话关闭思考
（OpenAI 兼容端点发 `reasoning_effort: "none"`，Anthropic 风格不发思考级别），旧 task 文件
没有该字段时行为与升级前一致。

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
- 无效引用（不存在、目录、符号链接、越界或小于 `tasks.evidence.min_bytes`）默认**逐条丢弃**：
  合法子集照常记录，被丢弃的条目连同原因写进 `run.detail`（`invalid evidence refs dropped: …`）。
  带 `complete` 声明的结果仍是严格的——任何一个无效引用都会让整次完成声称失败（M57a）。
  `tasks.evidence.invalid_refs: fail` 恢复旧行为。
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

## 3.1 reason 意图的可选探索契约（M51a）

在 `data.intents[*]`（兼容单数 `data.intent`）增加可选 `experiment`，不是 WorkerTask 顶层字段：

```json
{
  "from": ["origin"], "description": "比较授权入口的响应差异",
  "experiment": {
    "version": 1,
    "hypothesis": "在相同请求条件下入口存在可重复差异",
    "action": "在当前 Scope 内比较两次响应",
    "expected_signal": "状态与正文的可重复差异",
    "evidence_required": "保存脱敏请求条件和响应",
    "stop_condition": "工具不可用、范围不符或预算耗尽时停止并报告未知"
  }
}
```

省略时沿用旧行为；提供时必须是上述六个字段，`null`、额外字段、未知版本或缺字段均拒绝。
五个文本都须非空，action 最多 2048 字符，其余各 1024 字符；整个 experiment 含 JSON 开销
最多 **8192 UTF-8 字节**。先校验整份 reason 意图列表，再按任务数量上限截断；非法契约不能留下半批新意图。
控制面把它存入 `intent_meta.experiment`，不写目标 Fact，不改图导出；存储损坏时整体省略，不修补/补造。

它只是未验证计划，不是命令执行通道、Scope 授权、证据或项目完成条件。reason 通过启用的
AgentContext / M48 输入看到已有契约；focused explore 和 explore conclude 在模板展开后收到原 JSON 数据，花括号不再作模板占位符解释。
M48 apply 的焦点意图也完整保留契约并计入预算，必保留内容超预算则回退而非截断计划。

## 3.2 reason 后续方向的可选决策来源（M51c）

新 intent 可同时携带合法 `experiment` 与 `experiment_review`，后者不是 WorkerTask 顶层字段：

```json
{
  "source_intent_id": "i003",
  "choice": "change_direction",
  "rationale": "局部观察与预期不同，下一次比较新的对照条件，不反证整体假设",
  "observations": [{"run_id": "run-id", "checkpoint_sequence": 1, "attempt_id": "a1"}]
}
```

严格四字段；choice 仅 `continue` / `change_direction` / `need_observation`。前两者须有 1–4 条
唯一 observation 引用；`need_observation` 必须空数组。rationale 非空且 ≤1024 字符；source_intent_id
和 run_id 非空且 ≤128 字符，attempt_id 非空且 ≤96 字符，sequence 为正 safe integer。每条引用
严格三字段；整体 compact JSON ≤4096 UTF-8 字节。禁止额外 verdict/refuted 等字段。整表形状
先于数量截断验证，保留的 review 在写入前统一校验来源，失败不会留下半批意图或 Hint。

只有 reason 成功 apply 的 M48 授权恢复库构成派发 basis（不声称模型实际读取全部记录）。应用时
重新检查当前 Scope、来源意图/计划和证据可用性。结果驱动选择只接受同一 run/sequence/attempt 的
非空观察、正常成功结束、无权威故障、同派发计划、当前事实和可用证据引用；解释、工具错误、跨项目、
陈旧版本、缺证据或无历史派发绑定不能充当结果。`need_observation` 仍需授权且未退役的当前来源及
计划一致，但不要求存在观察。off/shadow/fallback 不授权 review。

合法来源存 `intent_meta.experiment_review`，reason run 沿用 origin_run_id。去重不覆盖旧计划/决策；
旧字段省略兼容，损坏存储整体省略。控制面只验证来源与可用性，不验证推理真伪；新方向仍受既有
Scope、优先级、预算与完成门禁约束，不自动反证、退役或重开原方向。普通无 review 的旧式规划仍可使用。

M51d 仅增加只读 `GET /projects/{project_id}/intents/{intent_id}/experiment`，包含计划、决策来源、
最多 10 条结束尝试和 10 条后续方向及 omitted 计数。正文来自原检查点；缺记录即 null/unknown，
证据文件可用不代表内容有效，hypothesis_verdict 始终 unknown。没有对应写路由。

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
  `solver-session/**`（含 M56 诊断旁路 `solver-session/model-trace.jsonl`）；控制面写：
  `task.json`、`graph.yaml`、`agent-context.yaml`（M36，`runtime.strategy_context: on`
  时）、`stdout.log`、`stderr.log`。`agent-context.yaml` 只在提示词里被引用，不是
  `task.json` 字段；`model-trace.jsonl` 同样只是只读旁路，协议不加字段，控制面从不校验
  或采用它的内容。
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

### 9.1 M51b：观察／解释结果索引

不新增 worker 输出文件、工具或检查点字段。控制面从有效的 M49 `attempts.memory.checkpoint`
派生可选只读 `attempts.memory.experiment_result`，不另落一份尝试正文：

- `source: memory.checkpoint.attempts`，`trust: worker_claim_not_verified`。
- `observations` 只含 observation 非空的 attempt ID、worker 的 `reported_result` 与证据可用性。
  `interpretations` 只索引 interpretation 非空的 attempt ID；按 ID 读取原字段，解释不能充当观察。
- 证据为 `refs_available_not_verified / missing / unavailable / not_supplied`，只表示引用的当前文件可用性，
  不表示内容有效或已经支持假设。
- `status` 为 `observations_reported / operationally_incomplete / unknown`：只有控制面 success、
  无分类故障且无异常终止原因，并存在非空观察、worker 自报 observed/negative_observation，才是
  observations_reported；它仍不是验证成功。工具错误或仅有解释不会形成负面实验结论。
- `control.failure`（若有）来自 M50 控制面分类；任何分类故障、非 success outcome 或非 finished
  终止原因优先标 operationally_incomplete，已有观察仍保留。历史空终止原因不补造异常。
- `unresolved_count` 指向原未决列表的数量，`hypothesis_verdict` **始终为 `unknown`**。
  不比较 expected_signal 自动裁决，不自动放弃方向、重试或改变完成状态。

缺少有效检查点、未开启采集/复用、旧序列化记忆没有该索引，都表示未知，不得推导为假设为假。
复用开关和 M48 整条选择/有界恢复规则不变；原最终 `result.json` 契约不变。

### 9.2 M52a/b：只读重复与观察进展投影

不修改 WorkerTask、TaskCheckpoint、result.json 或 reason 新意图输出协议。显式附带检查点的完整
snapshot 中，合法 experiment 意图可带 `intents[].exploration`，其结束 run 可带 `attempts[].exploration`。
同一投影可从既有只读 experiment GET 获取；没有 experiment 的旧意图不补造字段。

两类记录均为 `version:1 / mode:observe_only / hypothesis_verdict:unknown`。意图摘要包含：

- `plan_fingerprint`：SHA-256，版本域 m52-plan-v1；输入为项目 ID、Scope targets 集合、from 事实 ID
  集合、契约版本与五字段。文本只规范行尾及两端空白，内部空格、大小写保留；集合精确去重并排序。
  Scope 未知/空时为 null，不把未知计划混为同一组。
- `proposal_fingerprint`：m52-proposal-v1 域，额外比较来源意图和排序后的精确 run/sequence/attempt
  引用。描述、priority、dedupe_key、choice、rationale 本身不改变实验输入。
- `same_plan / same_proposal`：其它同指纹意图的 count、最多 8 个排序 intent_ids、omitted；包含已结束
  或退役的已有记录，不表示可派发资格，也不删除或合并意图。
- `history_scope:same_plan_in_current_project_scope`；六类状态 counts、最新 run/intent/status、连续计数
  与 advisory（same_plan_recorded / review_without_new_observation / need_observation / none）。

每个结束 run 的记录包含 status、未知/异常 reason、计划指纹、checkpoint_sequence、唯一报告指纹的
new/repeated 数量及截至该 run 的 `consecutive_without_new_observation`。状态为：

| status | 只读含义 |
| --- | --- |
| new_observation | 可比较历史中首次出现行动/观察/result/事实引用报告 |
| repeated_observation | 有可比较报告，但均已出现 |
| interpretation_only | 无非空观察，只有解释 |
| no_observation | 无观察也无解释 |
| operationally_incomplete | 权威运行/终止异常，或检查点自报工具/环境/超时/取消/Scope 错误等 |
| unknown | 缺检查点/结束时间/派发绑定，身份不匹配，计划/Scope/事实变化，证据未供/不可用，观察 inconclusive 等 |

报告指纹使用 m52-observation-v1 域：规范后的 action、observation、自报 result、排序事实引用；不比较
解释、证据文件名、run/attempt ID、sequence 或证据正文。可比较观察要求 observed/negative_observation、
证据引用当前可用、正常 success/finished 且无分类故障；契约输入和引用事实必须仍 current。同一 run
重复报告只计一次，累计 checkpoint 只使用最后有效版本。它不证明证据有效或目标状态没变。

按结束时间排序（同时间按 started_at/run_id）；不可排序历史保守置后并中断连续性。新观察把连续计数置 0；
重复/仅解释/空观察加 1；unknown 置 null，故障保留原值而不增加。计数不是全局“无进展”判决，不覆盖
新增 Fact、目标进展或复验价值。完整记录沿用 M48 整条预算/授权恢复；off/shadow/fallback 无新必读历史。
a/b 本身不新增写接口、表或自动抑制，不改变 Scope、优先级、重试及完成门禁。

### 9.3 M52c/d：独立可选排序偏好与只读预览

worker 及 reason 输出协议不变。`tasks.exploration_suppression.enabled` 是控制面运行配置，默认 false，
不是 worker 可提交的指令。a/b 投影仍为 observe_only/unknown；即使启用 c，也不允许写入 refuted verdict。

既有 `GET /projects/{project_id}/intents/{intent_id}/experiment` 顶层增加 `exploration_suppression`：

- `version:1`、`mode:off|soft`、`state:off|inactive|reduced`、机器可读 `reason`。
- `base_priority`、`effective_priority`、`penalty`：本次排序预览，不修改意图元数据。
- `window_started_at`、`until`（未建立窗口为 null）、`evaluated_at`（无合法时钟为 null），ISO 时间。
- `limits:{threshold:3,max_penalty:20,window_seconds:300}`：固定上限，不可由 worker 或配置放大。
- `semantics:priority_preview_not_dispatch_authorization`：非 claim、执行授权或派发承诺。读取后配置、输入、
  候选或时间变化会使实际选择不同；环境、用户引导、预算、claim、Scope 与完成门禁仍独立生效。

新观察/unknown、新 Fact/Hint 重置资格；故障不推进，最新故障/unknown 免责。窗口从首个阈值完成时刻
开始、同一连续段不滚动续期，唯一候选仍可执行；完整保守复核边界见 DESIGN §20.4。
API 与 scheduler 共用派生纯函数，无写操作、新端点、持久化窗口或额外模型判断调用。
UI 使用 x-text，明确区分 null 与 0，显示原因、peer 省略数、到期与刷新语义，不提供状态写入控件。
