# 架构（M5b 更新）

本文固定合并后的角色边界、数据所有权和失败语义。实现以本文为准；需要改动时先改本文并
记录原因。

M1 已落地：`packages/graph`（schema/领域服务/导出）、`apps/cairn/src/http`（五个兼容
路由 + 静态 UI）。M2a 已落地：`apps/cairn/src/config.ts` 与 `apps/cairn/src/prompts/`
（配置校验、模板加载、替换渲染）。M2b 已落地：进程内 scheduler
（`scheduler/{tasks,loop}.ts`）、worker 角色（`roles/worker.ts`）、任务/结果文件协议、
宽容 JSON 解析与确定性 fake solver。M2c 已落地：BreachWeave core 并入 `packages/agent`，
worker 可用 `CAIRN_SOLVER=breachweave` 在进程内启动真实 Solver 会话，读取
`~/.tch-agent/config` 的模型配置，并在软截止时向会话发送 wrap-up steer。M3 已落地：
`runtime/{types,local,docker,paths}.ts`（每项目容器或本地进程）、
`host-bridge/{bridge,command,scope-targets,pi-extension,worker-extension}.ts`
（`tool_call` 级 Scope 闸门与 `audit.jsonl`）、`packages/graph/src/artifacts.ts` 与
`GET /projects/{id}/artifacts` 的 artifacts 索引。M4a 已落地：conclude 作为独立 worker
任务，在 explore/bootstrap 失败后复用失败任务落盘的 solver session（`SessionManager.open`）
追加一轮 wrap-up；`packages/contracts` 的任务契约增加 `resumeSessionDir` / `concludeOf`。
M4b 已落地：可选的图切片导出（`packages/graph/src/export.ts` 的
`exportProjectSliceYaml`）与 `tasks.graph_slice` 配置；scheduler 只对 explore 及其
conclude 使用切片，reason/bootstrap 始终拿全图，默认关闭。M4c 已落地：可选的 Observer
sidecar（`packages/agent/src/solver/extension/cairn-observer/`）；主 solver 只读项目级
看板，独立 sidecar 会话每 N 轮/结束时 review，`BreachWeaveSolver` 在返回前做有界
`flush()`。没有 challenge 续跑、host-bridge RPC 或效率 steer，失败不影响任务结果。
实现、配置与已知限制见 `docs/OBSERVER.md`。M5a 已落地：证据门控与 `runs` 旁路表。
控制面为每个任务生成 `run_id` 并记录启动/完成；worker 结果可在根级带
`evidence_refs`，控制面按工作区做路径校验后才写图。证据缺失只降级记录（不拒绝）；
声称存在但非法/越界/不存在的证据按失败处理。图模型、YAML 导出与既有 HTTP 响应保持
不变，新数据只进旁路表。M5b 已落地：接受证据时流式计算 size/SHA-256 并写入
`fact_evidence`；`GET /projects/{id}/facts/{fact_id}/evidence` 用当前工作区重算摘要，
返回 `ok | modified | missing | unreadable | invalid`（无 workspace root 时为
`unverified`）。摘要只代表写入时的内容快照，不是签名。

## 1. 范围

目标：一个 Bun/TypeScript 代码库，保留 Cairn 的图语义和 HTTP API，把 BreachWeave 的
Solver 作为**库**调用，消除 Phase 0 的 worker 适配器、`solver rpc` 和 Python 桥。

M0–M3 的非目标：多用户认证、分布式存储、Web UI 重设计、跨机调度。

## 2. 角色与进程模型

### 控制面 `cairn serve`

- 唯一写 SQLite 的进程。
- 提供兼容 Cairn 的 HTTP API。
- `--config` 时运行进程内 scheduler：选择 intent、分配 worker 槽位、渲染 prompt、写图
  快照。没有 `--config` 时只跑 HTTP API。
- 派发前确保项目沙箱存在（本地工作区或每项目容器），沙箱不可用时跳过而不是降级。
- 为每个任务生成 `task.json`，拉起并监督 worker，读取并校验 `result.json`。
- 任务结束后扫描 `<workspace>/artifacts/**` 并写入 `project_artifacts` 索引；Host Bridge
  的 `audit.jsonl` 由 worker 进程写入 `sessionDir`。

scheduler 与 HTTP API 共用 `packages/graph/src/commands.ts` 的命令，不经过 HTTP 自调用。
两者语义一致；API 的逐字行为由 golden 锁定，scheduler 的语义由集成测试锁定。

### Worker `cairn worker --task <file>`

- 在**项目沙箱**内运行：本地模式是项目工作区，容器模式是每项目一个长驻容器的
  `docker exec`。两种模式走同一个 `RuntimeBackend` 接口（`runtime/types.ts`）。
- 一个任务一个 worker 进程；同一项目同一时刻最多一个
  （`runtime.max_project_workers` 默认 1，可调）。容器模式下同一项目共用一个容器，
  结束单个任务用任务文件路径做 `pkill`，不会杀掉同项目的其它进程。
- 不访问数据库，不调用控制面 API；只读 `task.json` 与引用的图快照，只写 `result.json`
  和 `sessionDir` 内文件。
- 通过 `Solver` 接口执行任务：默认是确定性 fake solver（`solver/fake.ts`）；
  `CAIRN_SOLVER=breachweave` 时使用 `solver/breachweave.ts`，以库方式启动
  `packages/agent` 中的 BreachWeave 会话（无 RPC 适配进程、无 Python 桥）。
- 所有模型工具调用经过 Host Bridge；未知工具、无效 scope、审计不可写都**fail closed**。
  Bridge 通过环境变量注入 Solver 与 subagent 会话，子代理不能绕过。
- 可选 Observer（默认关闭）在 Solver 会话旁运行一个独立 review 会话。主 Solver 只拿到
  只读看板工具；sidecar 只维护项目级看板，不执行验证、不写图，也不影响 `result.json`。

隔离单位是项目（容器/工作区），不是进程常驻。这样既保留崩溃隔离，又不需要额外的
常驻 daemon 协议。

## 3. 数据所有权

| 数据 | 写入者 | 读取者 | 位置 |
| --- | --- | --- | --- |
| SQLite（projects/facts/intents/hints/settings/project_scopes/project_artifacts） | 控制面 | 控制面 | 控制面主机 |
| SQLite 旁路表（`runs` / `fact_meta` / `fact_evidence`） | 控制面（不进入图模型与 YAML） | 控制面 | 控制面主机 |
| `graph.yaml` 快照 | 控制面 | worker | 项目工作区/容器内绝对路径 |
| `task.json` | 控制面 | worker | `sessionDir` |
| `result.json` | worker（临时文件 + rename 原子写） | 控制面 | `sessionDir` |
| `stdout.log` / `stderr.log` | 控制面（进程退出后归档） | 人/审计 | `sessionDir` |
| `audit.jsonl` | worker 内的 Host Bridge | 人/审计 | `sessionDir` |
| `artifacts/**` | worker | 控制面扫描后只记索引 | 项目工作区 |
| `solver-session/**` | BreachWeave 会话 | 人/审计 | `<sessionDir>/solver-session/` |
| `.cairn/board/**` | Observer sidecar | 主 Solver（只读工具）、后续任务 | 项目工作区（跨任务持久） |
| `observer-context.json` / `observer/**` | 控制面写 context；worker 写 review 状态 | review sidecar、人/审计 | `<sessionDir>/`（任务级） |
| 模型/凭据（`~/.tch-agent/config`） | 用户 | worker（只读使用） | 控制面主机（容器模式只读挂载） |

规则：worker 的任何输出都是**不可信输入**；控制面必须按契约校验后才写图。

## 4. 一次任务的生命周期

以下为 M4c 的实际实现；Observer 仅在 `observer.enabled: true` 且任务 kind 命中
`kernel_tasks` 时接入，图切片仅在 `tasks.graph_slice.enabled: true` 时影响 explore 类
任务。

1. scheduler tick 列出所有项目，只考虑 `status=active` 且**有 scope** 的项目。已经在跑的
   项目优先续派，其余按轮转顺序取空闲项目，受 `max_workers` /
   `max_running_projects` / `max_project_workers` 约束。
2. 决定任务种类（与 Cairn 相同）：
   - 初始项目（只有 origin/goal）：`bootstrap_enabled` → bootstrap（先建
     `creator=dispatcher.bootstrap` 的意图）；否则 reason，trigger=`initial`；
   - 非初始项目：若没有 reason 在跑，按检查点算 trigger（`facts:x->y`、`hints:x->y`、
     `open_intents:N->0`）→ reason；
   - 否则取最新的未认领、非 bootstrap 意图 → explore。
3. 认领前先调用 `runtime.ensureProject(projectId, hostWorkspace)`：本地模式创建工作区，
   容器模式在没有可用容器时创建它。返回 false（例如 Docker 不可用）时**跳过该项目的
   本次派发**，不降级到本地执行。随后在**一个事务**里认领租约（reason claim 或 intent
   heartbeat）、导出图 YAML、渲染 prompt、生成 `task.json`，并为该任务插入一行
   `runs`（`id` 由控制面生成，格式 `run_<三位项目内序号>`，例如 `run_001`；同一事务内
   完成）。
   租约竞态（403/409）只算跳过，不报错。图快照默认是全图；开启
   `tasks.graph_slice` 后，explore 与 explore-conclude 使用以该 intent 为 focus 的
   子图（见 §7），其余任务仍导出全图。
4. 文件布局：`<workspace_root>/<project_id>/.cairn/sessions/<kind>-<12 hex>/` 内含
   `graph.yaml`、`task.json`、`result.json`（worker 写）、`audit.jsonl`（worker 写），
   以及控制面事后写的 `stdout.log` / `stderr.log`。控制面始终用**宿主路径**写这些文件；
   写入 `task.json` 前通过 `runtime.mapPath` 转换为 worker 视角（本地模式恒等，容器模式
   为 `/cairn/workspace/...`）。scope 中的 `file:` 目标也按同一规则重写。prompt 里只给图
   快照路径，不内联。
5. 控制面拉起 worker（`RuntimeBackend.spawnWorker`）：
   - 本地模式：`bun apps/cairn/src/cli.ts worker --task <host path>`，`cwd` = 项目工作区，
     环境变量 = 控制面环境 + `common_env`。
   - 容器模式：在项目容器内执行 `container.worker_argv + [workerTaskPath]`（默认
     `bun /app/apps/cairn/src/cli.ts worker --task`），工作目录
     `/cairn/workspace`。环境变量是**白名单**：`common_env`、`CAIRN_AGENT_CONFIG_DIR`、
     `CAIRN_AGENT_CONFIG_READONLY=1` 等；不继承控制面完整环境。
   - 监督：按 `runtime.interval` 续租；硬截止到期先 SIGTERM，5 秒后 SIGKILL；租约丢失或
     项目被停用也终止 worker。容器模式用 `docker exec <container> pkill -<SIG> -f --
     <task path>` 只终止该任务，不杀同项目的其它进程。
6. worker 读取任务、校验契约（失败退出 10）、确认 `resultPath` 在 `sessionDir` 内，然后
   调用 Solver。真实 Solver 的会话把自身 JSONL 写入
   `<sessionDir>/solver-session/`；worker 宽容解析它的最终文本、归一化为 Cairn 结果信封，
   原子写入 `resultPath`（临时文件 + rename），退出 0。任务文本前会加一段来自
   `task.scope` 的授权范围声明；它只是提示，硬校验是 Host Bridge：worker 把
   `CAIRN_SCOPE_POLICY`（含 project/task/workspace/session 与 targets）和
   `CAIRN_HOST_BRIDGE_MODULE` 放入 Solver 进程环境，`packages/agent` 在创建 Solver 与
   subagent 会话时动态加载该模块。缺少任一环境变量时拒绝启动。
7. 控制面在 `worker.result_grace_seconds` 内轮询结果文件；退出码非 0、文件缺失或非法
   JSON 都按失败处理。若失败的是 explore/bootstrap，且该任务目录下存在
   `solver-session/*.jsonl`，控制面**保留租约**并把 `<projectId>:<intentId>` 放入内存
   pending 队列；否则释放租约。没有 session（例如模型还没产出任何 assistant 消息）时
   无法 conclude，按 Cairn 原语义释放 intent。
8. 下一个 tick 优先派发 pending conclude（先于初始项目判断，避免失败 intent 被立刻
   重派 explore）：它把失败任务的 session 目录作为 `resumeSessionDir`，
   `SessionManager.open` 打开最新 JSONL 并追加 `explore_conclude` /
   `bootstrap_conclude` prompt。conclude 的硬截止取
   `bootstrap.conclude_timeout` 或 `explore.conclude_timeout`，不设 soft deadline，也不
   参与 reason 检查点。explore conclude 的图快照也按同一 intent 切片（若启用）；
   bootstrap conclude 与 reason 一样拿全图。pending 队列只在控制面进程内：控制面重启后
   条目丢失，失败任务的租约到期后由 scheduler 按正常流程重派 explore；不承诺跨重启的
   conclude。
9. 应用结果（同一事务）。写图前先校验证据（见 §4.1）：reason 不要求证据；其余 kind 的
   `evidence_refs` 只要有任一条非法，本任务按失败处理、不写图（explore/bootstrap 仍可走
   conclude 回退）。校验通过后：
   - reason：`complete` → 关项目；intents → 以 `creator=cairn-worker` 创建意图；
     noop → 成功。payload 校验在控制面按实时图状态做；
   - explore：`accepted:false` → 释放意图；否则 conclude 意图产生 Fact，并写
     `fact_meta`（`run_id`、证据引用与状态）；
   - bootstrap：conclude 意图产生 Fact（同样写 `fact_meta`），再用该 Fact 完成项目；
   - conclude：bootstrap conclude 只接受 fact-only payload 并结束 bootstrap 意图，
     **不**完成项目（下一个 reason 再判断）；explore conclude 接受普通 description，
     写 Fact 并结束该意图；`accepted:false` → 释放意图。
10. `finish` 阶段先把 `<hostWorkspace>/artifacts/**` 扫描进 `project_artifacts`（不跟随
    符号链接；目录不存在时保留旧索引；失败只记日志），再把 `runs` 行的 outcome、退出码、
    时长、证据数与 detail 补全（成功、失败、取消都记录；写失败只记日志），随后**总是**
    释放 reason 租约（对应 Python 的 `finally`）。会话目录默认保留作审计，
    `worker.retain_task_files: false` 时删除；但若该目录仍被 pending conclude 引用
    （失败任务的目录），则延迟到 conclude 结束。

软截止：控制面只记录日志；worker 在真实 Solver 模式下会于软截止时向会话发送一次
“时间预算将尽，尽快收敛”的 steer（`solver/breachweave.ts`），这仍是第一道收敛手段。
若任务最终失败（被杀、结果缺失/非法），conclude 回退如上：新任务恢复原会话并追加
`explore_conclude` / `bootstrap_conclude`。与 Python 的进程内 conclude 不同，合并实现
的 conclude 是**独立 worker 任务**（一个任务一个进程的模型所限），会话 JSONL 是两者之间
唯一的交接状态。

### Observer sidecar（M4c，可选）

- scheduler 在 `prepareTask()` 中判断 `observer.enabled && observer.kernel_tasks` 是否
  命中当前 kind；命中时创建 `<workspace>/.cairn/board/` 与
  `<session>/observer/`，写入 `observer-context.json`，并通过 `spawnWorker` 的
  `extraEnv` 注入 `CAIRN_OBSERVER_ENABLED=1` 及路径/参数。未命中时显式注入
  `CAIRN_OBSERVER_ENABLED=0`。
- Observer 契约不进入 `task.json`，只通过环境变量传递；context 是任务开始时的快照，
  不随图更新。focus intent 永远保留在 open intents 中。
- 主 Solver 的 pi extension 只注册 `memory_list` / `idea_list` / `idea_search`；review
  会话（`review.ts`）每次启动独立的 pi session，`tools: []`，只注册看板读写工具与
  `query_solver_history`，不加载 Host Bridge。
- review 由 `tool_execution_*` / `message_end` / `agent_end` 事件驱动，串行消费任务级
  队列；`max_reviews_per_task` 在入队前生效。`BreachWeaveSolver.solve()` 在返回答案前
  调用 `flush()`，最多等待 `timeout_seconds`，任何异常都只写
  `<session>/observer/audit.jsonl`，不改变结果。
- 任务被硬杀时未完成的 review 随进程终止；看板可能落后一轮。`memory_*` / `idea_*`
  写工具不在主 Solver 的 Host Bridge 白名单中，看板文件工具的 `write`/`edit` 也被
  `protectedWriteRoots` 拒绝。`bash` 不受文件路径分析约束，这是策略闸门的已知边界。

### 证据门控、哈希与 runs（M5a + M5b）

M5a/M5b 只增加旁路数据，不改图模型、YAML 导出和既有 HTTP 响应的字节。

- **`run_id` 由控制面生成**：认领任务时在同一事务里插入 `runs` 行；worker 不生成 ID，
  也不能改写已有 run。run 记录项目、任务、kind、intent、worker、trigger、会话路径、
  开始/结束时间、outcome（`success | failed | rejected | cancelled | unhealthy |
  inactive`）、退出码、证据数与 detail。取消与 lease 丢失分别记为 `cancelled` /
  `failed`，并在 detail 中说明原因。
- **证据引用在结果根级**：worker 可以在 `result.json` 顶层写
  `evidence_refs: ["artifacts/report.txt", ...]`。它不进入 Cairn payload（`data`），
  因此现有 payload 校验器和 golden 响应不受影响；宽容解析器也会把裸 payload 里的
  `evidence_refs` 提升到根级。
- **路径校验**（`scheduler/evidence.ts`）：逐条要求非空字符串、长度 ≤512、最多 20 条，
  拒绝 NUL、绝对路径/盘符、`..`、目录、符号链接；先按工作区做词法包含检查，再用
  realpath 复核，防止链接逃逸。通过后反斜杠统一为 `/` 并去重。
- **软/硬语义**：没有 `evidence_refs`（或空数组）不算失败，记为
  `evidence_status: "missing"`；只要声称了但有一条非法，任务失败（fail closed），
  explore/bootstrap 的既有 conclude 回退仍适用。reason 任务不产出 Fact，不要求证据。
- **内容摘要（M5b）**：路径校验通过后，逐文件流式计算 `size` 与 SHA-256（`hashing.ts`
  同时供 artifacts 使用），随 Fact 一起写入 `fact_evidence`。哈希发生在 worker 退出、
  结论应用阶段，因此反映的是结论时的文件内容；不复制文件，也不证明作者。
- **实时校验（M5b）**：读取 `/evidence` 时重新走同一套路径检查与哈希，逐条给出
  `ok`（size+sha 一致）、`modified`（内容变化）、`missing`（不存在）、`unreadable`
  （权限/工作区不可读）、`invalid`（符号链接、越界、目录等）。没有 workspace root 时
  返回 `unverified`，只展示写入时摘要。校验是只读操作，不修改 CLI 或任务状态。
- **`fact_meta`**：每个由任务产出的 Fact 写一行，记录 `run_id`、`evidence_refs` 与
  `evidence_status`（`provided | missing | legacy`）。M5a 之前存在或经 HTTP 手工创建的
  Fact 没有行，读取时合成 `legacy` 视图，不批量回填。

## 5. 内部契约

### 5.1 `task.json`

字段定义和校验在 `packages/contracts/src/task.ts`。要点：

- `protocol: 1`，不兼容变更时递增。
- `kind`: `bootstrap | reason | explore | conclude`；后两者必须带 `intentId`。四种任务
  都会被派发（M4a 起 conclude 由 scheduler 在失败回退时排队）。
- `resumeSessionDir` / `concludeOf`: 仅 conclude 必填。前者是失败任务的 worker 视角
  session 目录（其中最新的 `solver-session/*.jsonl` 会被恢复）；后者为 `bootstrap` 或
  `explore`，决定 prompt 模板与结果 payload 校验器。出现在非 conclude 任务上、或在
  conclude 上缺失，契约校验都会失败。
- `prompt`: 已渲染好的完整任务文本（系统提示词由 worker 的 prompt 配置提供）。
- `graphSnapshotPath` / `workspace` / `sessionDir` / `resultPath`: worker 视角的逻辑绝对
  路径（本地模式即宿主路径；容器模式为 `/cairn/workspace/...`）。控制面自己始终用宿主
  路径访问同一批文件。契约不区分全图与切片；切片文件多一个 `slice:` 段，worker 仍
  按普通 YAML 读取。
- `scope.targets`: 授权目标，**空数组是错误**，绝不表示“全部允许”。
- `hardDeadlineSeconds`: 控制面硬杀时间；`softDeadlineSeconds` 必须更小且为正数；比例
  由 `worker.soft_deadline_ratio` 计算，算不出不小于 1 的整数时省略。
- 校验失败时 worker 一次列出全部问题并退出 10；`sessionDir` 与 `resultPath` 的关系不在
  契约校验器里，由 worker 额外检查（`resultPath` 必须位于 `sessionDir` 内，防止模型或
  坏任务把结果写到别处）。

### 5.2 `result.json`

沿用 Cairn 现有契约，不加信封；M5a 只在根级增加可选的 `evidence_refs`：

```json
{"accepted": true, "data": {"description": "..."}}
{"accepted": true, "data": {"description": "..."}, "evidence_refs": ["artifacts/report.txt"]}
{"accepted": false, "reason": "..."}
```

- `evidence_refs` 必须是字符串数组，路径相对**项目工作区**、以 `/` 分隔；它不影响
  `data` 的既有 payload 校验。`accepted:false` 时忽略。M5b 起每条被接受的文件都会在
  `fact_evidence` 里留下 size/SHA-256 快照。
- 省略或空数组表示“本任务没有文件证据”，记为 `missing`，不拒绝任务；一旦提供了条目，
  任一条非法（绝对路径、`..`、目录、符号链接、不存在、越界）就使任务失败。详见 §4.1。
- 为什么写文件而不是 stdout：Solver、工具和依赖都可能往 stdout 打日志；结果文件是唯一
  权威输出，也便于容器模式和审计。stdout/stderr 只作诊断。

### 5.3 退出码

定义在 `packages/contracts/src/exit-codes.ts`：

| 码 | 含义 | 控制面动作 |
| --- | --- | --- |
| 0 | 已写入合法 result | 校验并应用 |
| 2 | worker 调用方式错误 | 视为配置错误，任务失败 |
| 3 | 无可用答案（超时/空回复/Solver 崩溃） | 释放 intent，记录失败边界 |
| 4 | worker 自身崩溃 | 同上，额外告警 |
| 10 | 任务文件缺失或违反契约 | 视为内部 bug，告警 |

策略拒绝不是错误：模型返回 `accepted:false`，worker 正常退出 0。

### 5.4 进度事件

M3 仍不定义正式进度协议。worker 的 stderr 是人类日志，控制面在进程结束后把 stdout 与
stderr 归档到 `sessionDir/{stdout,stderr}.log`。需要 UI 实时进度时再加逐行 JSON 事件
（`{"event":"...","taskId":"..."}`），但不得污染 result 文件。

### 5.5 Artifacts

- **写入约定**：worker 把扫描结果、导出文件等放到 `<workspace>/artifacts/**`；其它位置
  不算 artifact。artifact 是**不可信数据**，控制面只索引，不执行、不解析内容。
- **索引时机**：每个任务结束时（成功、失败、拒绝都算）由 `finish` 扫描一次；整个项目的
  索引按本次扫描重建。`artifacts/` 不存在时保留旧索引；单次扫描最多 2000 个文件、递归
  深度 20，跳过符号链接和非普通文件。
- **记录内容**：相对路径（`/` 分隔）、字节数、流式 SHA-256、最后写入的 `taskId`、
  `created_at`。不保存文件内容，也不提供下载路由。
- **HTTP**：`GET /projects/{id}/artifacts` 返回
  `[{path,size,sha256,task_id,created_at}]`，按路径排序；未知项目 404。响应与既有 API
  一样由控制面从 SQLite 读取。
- 索引失败只记日志，不影响任务结果；下一次扫描会重建。

### 5.6 runs、fact_meta 与 fact_evidence

三张表都在 `packages/graph/src/db.ts` 中创建，既不属于图导出，也不参与任何既有命令：

- `runs(id, project_id, task_id, kind, intent_id, worker, trigger, outcome, exit_code,
  started_at, finished_at, duration_ms, session, evidence_count, detail)`，按
  `(project_id, started_at)` 建索引；项目删除时级联删除。
- `fact_meta(fact_id, project_id, run_id, evidence_refs, evidence_status, created_at)`，
  主键 `(fact_id, project_id)`，外键指向 Fact 并级联删除。`evidence_refs` 以 JSON 数组
  存储。`evidence_status` 为 `provided | missing | legacy`。
- `fact_evidence(project_id, fact_id, path, size, sha256, created_at)`，主键
  `(project_id, fact_id, path)`，外键指向 Fact 并级联删除。路径是写入时规范化后的
  工作区相对路径；只存摘要，不存内容。

HTTP（只读，均在控制面进程内直接查库）：

- `GET /projects/{id}/runs` → run 数组，按 `started_at, id` 排序；未知项目 404。
- `GET /projects/{id}/facts/{fact_id}/meta` → 单条 meta；Fact 存在但没有 sidecar 行时
  返回合成的 `legacy` 记录，未知 Fact 404。响应形状与既有 API 一致，直接是 JSON 对象，
  不加信封。
- `GET /projects/{id}/facts/{fact_id}/evidence` → 证据数组，按路径排序；每条包含
  写入时的 `path/size/sha256/created_at`、实时 `status` 与 `current_size` /
  `current_sha256`。`serve --config` 时用配置的 workspace root 校验；纯 HTTP 模式返回
  `unverified`。未知 Fact 或项目 404，无证据 Fact 返回 `[]`。校验是同步流式哈希，耗时
  与文件大小成正比；证据数量上限 20，响应不缓存结果。

## 6. 沙箱与 Scope Policy

### 6.1 两个层次

- **进程隔离**：worker 不在控制面进程内；崩溃、OOM、卡死不会拖垮控制面。
- **动作隔离**：模型发起的工具调用（shell/文件/网络）经 Host Bridge 检查，越界即拒绝并
  审计。任意代码（例如 `python -c`）不经过工具层，由容器边界兜底。

### 6.2 Host Bridge（M3，已实现）

Host Bridge 是 pi 的 `tool_call` 扩展：它在工具执行**之前**拿到工具名与输入，拒绝时返回
`{block:true, reason}`。它不执行工具，也不替模型重写命令。

- **接入**：worker 把 `CAIRN_SCOPE_POLICY`（JSON：project/task/workspace/session/targets）
  与 `CAIRN_HOST_BRIDGE_MODULE`（`worker-extension.ts` 的绝对路径）放进 Solver 进程环境。
  `packages/agent` 在创建 Solver 会话**和每个 subagent 会话**时动态加载该模块；缺环境
  变量、模块不存在、策略非法都直接抛错，worker 不会无闸门运行。
- **工具分类**：
  - `bash`：解析命令中的 HTTP(S) URL、`/dev/tcp`、IPv4/IPv6、CIDR、`user@host` 以及
    `-p` / `-p80,443` / `--ports=` / `nc` 位置参数里的端口。识别出的网络工具（curl、nmap、
    nc、ssh 等）或任意 HTTP(S) URL 都算网络意图；网络意图存在但提取不到可验证端点时
    **拒绝**。`bash -c "curl …"` 的引号内容同样按命令文本分析。
  - 文件工具（`read`/`grep`/`find`/`ls`/`write`/`edit`）：相对路径按工作区解析；写入必须
    落在项目工作区；读取必须落在工作区或 `file:` scope 根内；`realpath` 后判断，防止
    symlink/junction 逃逸；`~/.tch-agent/config` 与 `/cairn/agent-config` 永远拒绝。
    容器内的每任务配置副本位于 `/tmp/cairn-agent-config/<task_id>/`，不在工作区或任何
    scope 根内，因此同样的读写规则会拒绝访问它；它只供 Solver 进程自己加载。
    `CAIRN_OBSERVER_BOARD_DIR` 另外作为 `protectedWriteRoots`：读取看板允许，结构化文件
    工具的 `write`/`edit` 被拒绝（看板由 sidecar 独占写入）。`bash` 命令不参与该路径
    分析，因此直接写看板的 shell 命令不会被拦截，仍以工作区为边界。
  - HTTP 类工具（`fetch`/`http`/`web_fetch` 等）：URL 必须是合法 HTTP(S)，host/port 必须
    命中 scope。
  - worker 本地工具（`subagent`、finding/flag/hint/search 相关）有显式白名单；其它未知
    工具一律**拒绝**。`subagent` 本身只做本地派生，它的工具调用仍经过同一个 Bridge。
    M4c 的白名单包含只读看板工具 `memory_list` / `idea_list` / `idea_search`；写工具
    `memory_add/update/delete`、`idea_add/update` 不在其中，因此主 Solver 不能改看板。
- **匹配语义**：hostname 按字面匹配，不做 DNS 解析；`*.example.com` 只匹配子域（不含
  apex）；`host:port` 要求端口一致；IPv4 CIDR 支持目标与端点都是 CIDR 时的子集判断。
  scheme 只接受 `http`/`https`；`file:` 目标支持本地路径形式。
- **审计**：每次 allow/block 都向 `<sessionDir>/audit.jsonl` 追加一行（`ts`、`task_id`、
  `project_id`、`tool`、`action`、`targets`、`decision`、`reason`、截断后的 `detail`）。
  审计写入失败时本次调用也按拒绝处理。`detail` 只截断保存，不落完整凭据。
- **边界**：这是**工具调用策略闸门**，不是任意代码沙箱。它无法理解 `python -c` 里构造的
  任意 socket 逻辑，也不能替代内核隔离；容器网络命名空间才是最后的内核边界。因此本地
  模式只用于受控开发/靶场，生产必须用容器模式。凭据同理：Solver 进程必须能读取模型密钥
  才能工作，因此同一容器内的任意代码（不经过工具层时）也能读取它；Host Bridge 不是
  凭据边界，只降低模型“按工具调用直接读取配置目录”的概率。容器临时副本、只读源挂载与
  `0600` 权限减少持久化面，但不能让恶意代码看不到密钥。

### 6.3 Scope 的来源

Scope 属于项目配置，由控制面在创建项目时校验并持久化到 `project_scopes` 表（新增表，
不改既有列；`POST /projects` 的响应体不变），任务生成时写入 `task.json`。worker 不读
数据库，只信任务里的 scope；控制面负责保证它来自授权记录。

fail-closed 有两层：控制面在**派发前**拒绝没有 scope 的项目；worker 再把同一份 scope 交给
Host Bridge，在**每个工具调用**上强制（目标非法或一个可用目标都没有同样拒绝）。任务里的
scope 是快照，修改项目 scope 只影响之后的派发，不影响正在运行的任务。

## 7. 提示词与图快照

- 已把 Cairn `prompts/default/*.md` 原样移植为 `apps/cairn/src/prompts/default/*.md`，占位符
  保持 `{graph_yaml}`、`{intent_id}`、`{origin}`、`{hints}` 等不变；`mock/` 同步复制用于
  确定性测试。10 个模板的渲染结果与 Python 版逐字对照（M2a）。
- `graph_yaml` 仍替换为“文件路径 + 先读整个文件”的说明，**不内联**图内容。默认导出全图，
  与 Phase 0 / Python Cairn 一致；本地模式文字用 “sandbox”，容器模式用 “container”。
- **可选切片（M4b）**：`tasks.graph_slice.enabled: true` 时，explore 与 explore-conclude
  的 `graph.yaml` 只含与当前 intent 相关的子图。硬保留：`origin`、`goal`、focus intent、
  所有其他未结束 intent 及其来源 Fact——这些不受 caps 限制，保证并行 worker 仍能看到
  彼此方向。其余 provenance（产生已含 Fact 的 intent 及其来源）按包含顺序尽力补齐，
  触到 `max_facts` / `max_intents` 即停。切片顶部多一个 `slice:` 段（`focus_intent`、
  `included_facts`、`included_intents`、`max_facts`、`max_intents`、`truncated`）；
  `truncated: true` 表示 caps 或缺失的 producer 使 provenance 不完整。reason/bootstrap
  从不切片：它们需要全局视野。全图导出函数与 golden 不受影响。
- 替换按配置字典的插入顺序逐 token 执行；这与 Python `render_prompt` 在替换值含后续 token
  时的行为一致。
- BreachWeave 的 `cairn-worker` 系统提示词位于
  `packages/agent/src/config/prompts/builtin/cairn-worker.md`，首次启动时由
  `initBuiltinPrompts` 释放到 `~/.tch-agent/config/prompts/`；conclude 的会话恢复也使用
  同一提示词配置。它的 frontmatter `model: "cairn-worker"` 指向 `model-prefs.json` 中的
  同名条目。Observer 不依赖该 frontmatter 的 `observerEnabled`：启用与否由 scheduler
  注入的 `CAIRN_OBSERVER_ENABLED` 决定；启用时 `cairnObserverExtension` 另行附加
  “Cairn Observer”提示段。
- 提示词分组（`default` / `mock`）暂时保留，兼容现有配置；`mock` 供确定性测试与 fake
  solver 使用，worker 类型维度的提示词选择消失。

## 8. 配置、模型与密钥

- 应用配置：移植 Cairn 的 `server` / `runtime` / `tasks` / `container` / `local` /
  `common_env` 段；删除 `workers` 和 `WORKER_ENV_KEYS`。并发仍由 `runtime.max_workers`
  与 `runtime.max_project_workers` 控制（保持旧配置兼容），新增单一的 `worker` 段：
  `soft_deadline_ratio`、`retain_task_files`、`result_grace_seconds`。
- `tasks.graph_slice` 是新增的可选段：`enabled`（布尔，默认 `false`）、`max_facts`
  （整数 ≥ 2，默认 80）、`max_intents`（正整数，默认 60）。缺省即保持全图行为；非法值
  在启动时以 `ConfigError` 拒绝。
- `observer` 是新增的可选段（M4c，默认关闭）：`enabled`（布尔）、`model`
  （model-prefs 条目或 `null`）、`every_rounds` / `window_rounds` / `timeout_seconds`
  （正整数）、`max_reviews_per_task`（非负整数）、`kernel_tasks`（
  `bootstrap|reason|explore|conclude` 的子集，默认 `["explore"]`）。缺省值不会改变旧
  配置行为；非法值在启动时以 `ConfigError` 拒绝。scheduler 只把该配置翻译成
  `CAIRN_OBSERVER_*` 环境变量，不写进 `task.json`。
- `runtime.execution` 选择 `container`（默认）或 `local`，两种模式共用同一个
  `RuntimeBackend`；不新增重复的 `sandbox` 段。
  - `container`: `image`（必填）、`network_mode`（必填）、`completed_action`
    (`remove` | `stop`)、`cap_add`（数组）、可选的 `workspace_root` 与 `worker_argv`
    （默认 `["bun","/app/apps/cairn/src/cli.ts","worker","--task"]`）。
  - `local`: 可选的 `workspace_root`、`completed_action` (`keep` | `remove`)。
  - 工作区根优先级：`container.workspace_root` → `local.workspace_root` → 控制面
    `cwd`；项目目录为 `<root>/<project_id>`。
- `serve --config` 在容器模式启动时检查 Docker，并先把内置 prompts/skills 释放到
  agent 配置目录，再以只读方式挂载进容器；容器内跳过写入内置 prompts/skills 的逻辑。
- 模型与凭据：沿用 BreachWeave 的 `~/.tch-agent/config`（`models.json`、`auth.json`、
  `model-prefs.json`、`provider-prefs.json`）与 prompt frontmatter 的 `model`。本地模式由
  worker 在启动真实 Solver 前补齐内置 prompts/skills；容器模式由控制面在挂载前补齐，容器
  内因 `CAIRN_AGENT_CONFIG_READONLY=1` 跳过写入。`CAIRN_AGENT_CONFIG_DIR` 可覆盖配置目录
  （测试用）。API key 只存在于 `auth.json`；上游 SDK 要求自定义 provider 在 `models.json`
  提供 `apiKey` 字段，因此该字段写成环境变量名（如 `CAIRN_MODEL_API_KEY`）作占位，请求时
  `auth.json` 的凭据优先。
- **容器内的只读配置与任务副本**：宿主配置目录以 `readonly` 挂到 `/cairn/agent-config`，
  但上游 `AuthStorage` 会在 `auth.json` 旁建 `auth.json.lock`。只读挂载下该操作以 `EROFS`
  失败，错误被存储层记录后凭据集合为空，`getApiKey` 回退到 `models.json` 的字面占位符，
  表现为网关 401。因此每个任务在容器内把配置复制到
  `/tmp/cairn-agent-config/<task_id>/`（目录 `0700`、`auth.json` `0600`），设置
  `CAIRN_AGENT_CONFIG_DIR` 指向副本，任务结束即删除。源挂载始终只读，副本只在容器可写层，
  不写入工作区、`task.json` 或日志；配置目录的拒绝读取规则仍然覆盖源挂载。
- `cairn-worker` 提示词引用的 12 个 skills 随 `packages/agent` vendor；未引用的
  `fuzz-dicts-skills` 与 `payloads-everything` 已删除以控制仓库体积。
- 任务文件可能被保留用于审计，因此**不得包含密钥**。

## 9. 超时、失败与幂等

- 软截止：控制面只记录日志；真实 Solver 模式下 worker 在软截止时发送一次 wrap-up steer
  （不中断当前工具调用）。硬截止仍是最强约束；硬杀之后若失败任务已落盘 session，则由
  conclude 任务恢复会话 salvage 一个 Fact。
- 硬截止：控制面先 SIGTERM，5 秒宽限后 SIGKILL；租约丢失或项目被停用同样终止 worker。
  容器模式通过 `docker exec … pkill -TERM/-KILL -f -- <task.json>` 实现同一语义，只影响
  本次任务；若 `pkill` 不可用（镜像缺少 procps）则退化为结束本地 `docker exec` 客户端，
  任务进程可能继续运行，因此 `Dockerfile.worker` 显式安装 `procps`。
  `m3-real-container-gate.ts` 已在实机验证：同一容器内两个不同 task 路径的进程，只有
  目标被终止，兄弟任务与容器继续运行。
- 结果宽限：进程退出后控制面在 `worker.result_grace_seconds` 内轮询 `result.json`，容忍
  文件系统可见性延迟；超时按“结果缺失”处理。
- 结果失败分类：进程非零退出、结果文件缺失、非法 JSON、字段不合法分别记录日志。语义
  校验（图状态相关）在控制面做；失败一律释放租约，intent 回到未认领状态供后续重派。
- 幂等：同一个 `taskId` 在一次控制面进程内只应用一次（它在 `running` 表里）。**跨进程的
  持久化 taskId 账本尚未实现**；控制面重启后依赖 Cairn 的意图租约过期语义恢复，已应用
  的结果不会被重放。M4 若需要更强的幂等保证再补账本。
- 重试策略：不自动重试同一任务；由 scheduler 依据检查点与未认领意图决定是否再派发。
  conclude 不是重试：它不重新探索，只把失败会话里已确认的内容写成一个 Fact；若连
  conclude 也失败，则释放 intent，后续按正常流程重派。

## 10. 容器与路径

- **每项目一个长驻容器**：`cairn-dispatch-<safe-project-id>`，标签 `cairn.project` 与
  `cairn.managed=1`，命令 `sleep infinity`；同一项目内的任务各跑一次 `docker exec`。
  容器名按项目 ID 派生并做安全化，避免路径分隔符等字符进入名字。
- **创建参数**：镜像来自 `container.image`；`--network` 来自 `network_mode`；`--cap-add`
  逐项来自 `cap_add`；工作区用 `--mount type=bind,source=<host>,target=/cairn/workspace`
  （不用 `-v`，避免 Windows 盘符与冒号歧义）；agent 配置用
  `--mount type=bind,source=<config>,target=/cairn/agent-config,readonly`。容器内设置
  `CAIRN_AGENT_CONFIG_DIR=/cairn/agent-config` 与 `CAIRN_AGENT_CONFIG_READONLY=1`。
- **exec 环境**：只传白名单（`common_env` 与固定的 `CAIRN_*` 变量），不把控制面完整环境
  带进容器；模型凭据只通过只读配置挂载，不进入 `task.json`、镜像或工作区。
- **路径**：`runtime/paths.ts` 负责宿主 ↔ worker 映射。工作区内路径映射到
  `/cairn/workspace/...`，工作区外调用 `mapPath` 直接抛错；`mapPathIfUnderWorkspace` 用于
  可选项。`file:` scope 目标按同一规则重写，`workerFileUrl` 不假设 worker 平台。
- **生命周期**：`ensureProject` 幂等（inspect 后决定 run/start）；已停止的受管容器会重启；
  inspect 失败按不可用处理（fail closed）。`cleanupInactive` 只处理本控制面**追踪过**的
  项目，`completed_action` 决定 remove 还是 stop；不按全局标签清理，避免误删另一个控制面
  的容器。进程退出时 `close()` 只清理自己追踪的容器。
- **Docker 不可用**：`serve --config` 在容器模式启动时直接报错退出（码 2）；运行中
  `ensureProject` 返回 false 时该项目跳过派发，**不会降级到本地**。
- 容器内不暴露 Docker socket（不 mount `/var/run/docker.sock`），worker 没有宿主权限。
- Windows 宿主：本地模式可运行（路径与 `resultPath` 校验处理 win32 大小写），但只用于
  开发与测试；生产隔离要求容器模式。本地模式的 `bash` 工具需要
  Git Bash/MSYS2/Cygwin/WSL 之一；没有时模型会收到工具错误并回退到
  `read`/`write`/`edit`/`grep`/`find`/`ls`。`Dockerfile.worker` 提供带 `procps` 的
  Linux worker 镜像。

## 11. Phase 0 的删除清单

合并完成后不再存在：

- `WorkerDriver` / `registry` / `workers/adapters/*` / `WORKER_ENV_KEYS`；
- `tch.py`、`tch_bridge.py`、`solver rpc` 适配、`tch` 提示词释放逻辑；
- `ctfagent/scripts/apply_overlay.py` 及其文本补丁；
- Python 的 prompt 渲染、调度、进程 runtime（由 TS 端口替代）。

`ctfagent/` 目录在本仓库之外，**尚未删除**；删除它需要用户明确确认，不属于 M3 验收条件。

## 12. 安全模型

- 模型输出和工具输出都不可信；只做 JSON 解析与契约校验，不 `eval`。
- Scope 校验必须 fail closed；未知工具、无可验证端点、非法目标、审计不可写都拒绝。允许和
  拒绝都写 `audit.jsonl`。
- Host Bridge 是**工具调用层**的策略闸门，不能阻止任意代码（例如 `python -c` 自己开
  socket）；它让常规工具路径可审计，容器网络命名空间才是内核边界。不得把本地模式当作
  对抗不可信代码的沙箱。
- Bridge 运行在 worker 内，`audit.jsonl` 与 `result.json` 一样由不可信进程写入；它能证明
  控制面看到的行为，但不是防篡改账本。需要强审计时把 `sessionDir` 放到控制面独占写入的
  位置（后续里程碑），或外加日志收集。
- artifacts 只索引路径/大小/哈希，不作为可信内容；解压或读取下载文件时仍按不可信数据
  处理。`evidence_refs` 来自 worker，同样不可信：控制面只做路径合法性与工作区包含校验，
  不证明文件内容支持该 Fact；索引与证据都不构成密码学承诺。
- 证据摘要（M5b）在任务结束后计算，只能发现**之后**的替换/删除；它不能证明文件由该
  任务生成，也不是签名。worker 在工作区内始终有写权限，因此强完整性仍需容器/文件系统
  层配合（只写挂载、外部日志或签名）。校验路由只读取工作区，不跟随符号链接。
- Observer 看板是**建议性数据**，不是图事实：主 Solver 只读，真正结论仍必须写进
  `result.json` 并经控制面校验。看板的写保护只覆盖结构化文件工具与白名单；`bash` 可在
  工作区内改写它。看板不得存 flag、凭据、完整工具输出或与授权范围无关的数据。默认
  `max_project_workers: 1` 时同项目任务串行，避免并发写；提高该上限时没有跨任务锁。
- 凭据只读挂载；日志脱敏；任务与结果文件按项目隔离。exec 环境只传白名单，容器不暴露
  Docker socket。
- 容器是主要的爆炸半径边界；本地模式仅用于受控开发/靶场。
- 合规前提：仅限已获明确书面授权的测试、靶场、比赛或企业自查。

## 13. 待定问题

1. 任务文件保留多久：M3 默认保留全部 `sessionDir` 供审计，
   `worker.retain_task_files: false` 可整目录删除；长期保留策略（按项目/时间清理）待定。
2. 同一项目并发 worker：`runtime.max_project_workers` 默认 1。容器模式已支持同项目多次
   `docker exec`，但共享工作区（包括 Observer 项目看板）的写冲突没有协调；提高并发前
   需要评估，或为看板增加跨任务锁/分片。
3. ~~conclude 的会话恢复~~：M4a 已定为复用失败任务的 `sessionDir`，由
   `SessionManager.open` 恢复最新 JSONL；是否会为 conclude 增加跨重启的持久化队列待定
   （目前 pending 队列只在内存，重启后按租约过期重派）。
4. Prompt group 是否在 M3 后彻底移除，还是保留给 fake/mock 集成测试。
5. 本地模式的 `bash` 依赖：容器镜像自带 POSIX shell 与 `procps`；本地模式仍要求用户在
   Windows 安装 Git Bash/MSYS2/Cygwin/WSL 之一，是否注入跨平台 shell 替身待定。
6. 强审计：`audit.jsonl` 目前写在 worker 可写目录。是否把审计事件逐行实时转发到控制面
   （或由控制面只写账本）属于 M4 的安全增强。
7. 图切片的默认 caps（80 facts / 60 intents）尚未在真实大项目上调参；是否也对 reason
   启用切片、以及是否需要按 token 预算而非对象计数，待有真实数据后决定。
8. Observer 看板的完整性：结构化文件工具的写保护已落地，但 `bash` 仍可写工作区内的
   看板；是否要对 bash 解析重定向/`tee`/脚本写入，或把看板移出 worker 可写挂载，待定。
   `tools/gate/m4c-observer-gate.ts` 已用真实模型跑通一次短 bootstrap（14/14），但长任务
   下的成本、延迟和看板质量仍需更多实测。
9. 证据的强度：M5b 已把 size/SHA-256 固化到 `fact_evidence` 并提供实时校验，但仍不
   要求证据在 Fact 之后保持存在，也不对“声称有证据但为空文件”设内容门槛；是否为
   空文件/极小文件增加策略、以及是否引入控制面签名，待定。符号链接一律拒绝，在
   Windows 上开发时会跳过依赖 symlink 的测试。
