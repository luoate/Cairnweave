# Cairn（合并重写）

把 Cairn 的图内核（事实 / 意图 / 调度）与 BreachWeave 的执行层（Solver / tools /
skills / Observer）合并成**一个 Bun/TypeScript 代码库**，不再维护 Python ↔ TypeScript
之间的进程桥、JSONL RPC 和 worker 适配器。

状态：**M5c（证据最小大小 + conclude 队列持久化已落地）**；M0–M4、M5a、M5b 的计划项全部完成。
`cairn serve` 是可运行的 Cairn 兼容服务：SQLite schema、领域服务、全部五个路由、
YAML/timeline 导出、静态 Web UI 均已就位，并用 Python Cairn 生成的 golden 做了逐字
对照。进程内 scheduler、任务/结果文件 worker 协议、BreachWeave Solver 接入已在 M2
完成。M3 增加：

- `runtime.execution: container`：每项目一个长期容器，每个任务一次 `docker exec`；
  本地模式仍保留（`execution: local`）；
- **Host Bridge**：在每次 pi `tool_call` 前按项目 scope 校验网络端点与文件路径，
  allow/block 全部写入 `<sessionDir>/audit.jsonl`；subagent 会话也加载同一道闸门；
- **artifacts 索引**：任务结束后扫描 `<workspace>/artifacts/**`（不跟随符号链接），
  记录相对路径、大小与 SHA-256，`GET /projects/{id}/artifacts` 可查。

M4a 增加：

- **conclude 回退**：explore/bootstrap 因退出码、结果缺失或结果非法失败时，scheduler
  不释放 lease，而是排队一个 conclude 任务；它通过 `SessionManager.open` 复用失败任务
  已落盘的 `solver-session/*.jsonl`，追加一轮 `explore_conclude` / `bootstrap_conclude`
  prompt。bootstrap conclude 只写 Fact、不完成项目；explore conclude 写 Fact 并结束该
  intent。失败任务目录在该 conclude 完成前不会被清理。

M4b 增加：

- **可选图切片**：`tasks.graph_slice.enabled: true` 时，explore（以及 explore 的
  conclude）任务拿到的是切片后的 `graph.yaml`。focus intent、全部未结束 intent 及其
  来源 Fact 永不裁掉；其余 provenance 在 `max_facts` / `max_intents` 内尽力补齐，超出
  时 `slice.truncated: true`。reason 与 bootstrap 仍拿全图。默认关闭，保持 Cairn
  全图导出的语义。

M4c 增加：

- **Observer sidecar（默认关闭）**：`observer.enabled: true` 且任务 kind 命中
  `kernel_tasks` 时，worker 在真实 Solver 会话旁运行一个独立的 review 模型。它维护
  **项目级、跨任务**的 `<workspace>/.cairn/board/` ideas/memory 看板；主 Solver 只拿到
  `memory_list` / `idea_list` / `idea_search` 三个只读工具。每 `every_rounds` 轮、
  `agent_end` 以及最终 `flush()` 触发串行 review；`timeout_seconds` 与
  `max_reviews_per_task` 是硬上限。Observer 失败、超时或 worker 被硬杀都不会改变
  `result.json`、`accepted` 或退出码。
- 没有 challenge 门控、续跑、host-bridge RPC 或效率 steer；sidecar 只注册看板工具
  （含 `query_solver_history`），不加载 Host Bridge，也没有 shell/文件/网络工具。
- 详见 `docs/OBSERVER.md`。

M5a 增加：

- **证据门控**：worker 可在 `result.json` 根级返回 `evidence_refs`（工作区相对路径）。
  控制面在写图前逐条校验：拒绝绝对路径、`..`、目录、符号链接、不存在或越界；
  最多 20 条、每条 ≤512 字符。省略/空数组记为 `evidence_status: "missing"`，不拒绝；
  一旦声称却非法，任务失败（explore/bootstrap 仍走 conclude 回退）。
- **`runs` 旁路表**：控制面在认领任务时生成 `run_id` 并记录启动，结束时补全
  outcome/退出码/时长/证据数/detail；成功、失败、取消、lease 丢失都有一行。
- **`fact_meta` 旁路表**：每个由任务产出的 Fact 记录对应 `run_id`、证据引用与状态；
  M5a 之前或手工创建的 Fact 读取时合成 `legacy` 视图。
- **只读查询**：`GET /projects/{id}/runs` 与
  `GET /projects/{id}/facts/{fact_id}/meta`。图模型、YAML 导出和既有 HTTP golden
  响应保持逐字不变。

M5b 增加：

- **证据内容哈希**：接受证据时流式计算字节数与 SHA-256，写入 `fact_evidence`
  旁路表；只保存摘要，不复制内容。Fact 删除或项目删除时级联清理。
- **实时校验**：`GET /projects/{id}/facts/{fact_id}/evidence` 按当前工作区重算摘要，
  逐条返回 `ok | modified | missing | unreadable | invalid` 及 `current_size` /
  `current_sha256`。没有 workspace root（例如不带 `--config` 的纯 HTTP 模式）时返回
  `unverified`，仍能看到写入时摘要。
- 校验不会跟随符号链接或越出工作区；摘要只证明“结论时文件内容如此”，不证明文件是
  任务生成或未被提前篡改。

M5c 增加：

- **最小证据大小**：`tasks.evidence.min_bytes`（默认 `1`，`0` 关闭）在写图前拒绝空文件
  和极小文件；被拒绝的引用按非法证据处理，任务失败。该校验只发生在接受阶段，实时
  校验仍只比较内容漂移。
- **持久化 conclude 队列**：失败 explore/bootstrap 排队的 conclude 写入
  `pending_concludes` 旁路表（项目、意图、phase、工作区相对的会话路径）。控制面重启
  后仍优先派发，会话路径按当前 workspace root 重建；conclude 结束、意图失效或准备
  失败时删除行，项目删除级联清理。

默认仍是确定性 fake solver，测试与离线运行不需要模型凭据。Observer 只接在
`CAIRN_SOLVER=breachweave` 的真实 Solver 路径上，fake solver 会忽略它。

## 三个已定决策

1. **控制面 + 每项目 worker 进程**：`cairn serve` 是唯一写图者；worker 跑在项目沙箱里，
   按任务拉起（同一项目同时最多一个），不是常驻守护进程。
2. **保留 Cairn 语义**：projects / facts / intents / hints 模型、SQLite schema、HTTP API、
   JSON 结果契约都不重新设计，以便用现有 Python 版做对照测试。
3. **整体 AGPL-3.0**：合并作品按 AGPL-3.0 分发；BreachWeave 的 Apache-2.0 代码在并入时
   保留其许可声明（见 `THIRD_PARTY.md`）。

## 拓扑

```
cairn serve（控制面，一个进程）
  ├─ HTTP API（兼容 Cairn）+ 静态 UI
  ├─ SQLite（唯一写者）
  ├─ scheduler：bootstrap / reason / explore / conclude
  ├─ 渲染 prompt + 写 graph.yaml（默认全图；explore 可切片）
  └─ 为每个任务写 task.json，supervise worker 进程
        │
        ▼  项目工作区（每项目绑定到 /cairn/workspace）
  cairn worker --task <task.json>（按任务拉起；容器模式下是 docker exec）
        ├─ solver：默认确定性 fake；CAIRN_SOLVER=breachweave 用 packages/agent
        ├─ 模型/凭据：~/.tch-agent/config（容器内只读挂载到 /cairn/agent-config）
        ├─ Host Bridge：每次 tool_call 前做 Scope 硬校验，逐条写 audit.jsonl
        ├─ Observer（可选）：主 Solver 只读项目看板；独立 sidecar 会话维护看板
        └─ 原子写入 result.json 后退出
```

容器模式下控制面通过 `docker run -d ... sleep infinity` 建立项目容器，任务用
`docker exec -i` 执行；Docker socket 不进入 worker，agent 配置只读挂载，worker 只拿到
`common_env` 与必要的 `CAIRN_*` 变量。

控制面与 worker 之间只有**任务文件 + 结果文件 + 退出码**，没有桥接进程，也没有
`solver rpc` 的 JSONL 转译。stdout/stderr 仅作诊断日志。

## 目录

```
apps/cairn/src/
  cli.ts                 serve / worker / version
  roles/control.ts       cairn serve：HTTP API + SQLite（--config 时启动 scheduler）
  roles/worker.ts        worker：跑 solver、宽容解析、原子写 result.json
  http/api.ts            Cairn 兼容路由（Bun.serve 零依赖）
  http/static/           Cairn 原有 Web UI（来自上游，AGPL-3.0）
  config.ts              dispatch.yaml 校验（Bun.YAML）
  prompts/prompting.ts   prompt 加载、渲染、JSON 格式化、占位符校验
  prompts/default/*.md   上游默认 prompt（逐字复制）
  prompts/mock/*.md      上游 mock prompt（逐字复制）
  scheduler/loop.ts      tick、派发、租约、超时、artifacts、切片选择、Observer env、runs
  scheduler/tasks.ts     prompt 渲染 + 路径映射 + task.json/context 落盘
  scheduler/evidence.ts  证据校验、哈希与实时比对（工作区包含、realpath、上限）
  runtime/types.ts       scheduler ↔ 沙箱接口（local / container）
  runtime/local.ts       本地子进程 runtime
  runtime/docker.ts      每项目容器、docker exec、任务级终止、清理
  runtime/paths.ts       host ↔ /cairn/workspace 路径映射
  host-bridge/bridge.ts  tool_call 级 Scope 校验 + audit.jsonl + 看板只读保护
  host-bridge/command.ts bash 端点提取（保守、fail closed）
  host-bridge/scope-targets.ts  scope 解析与匹配（主机名不查 DNS）
  host-bridge/worker-extension.ts  worker 环境变量 → pi extension
  solver/fake.ts         确定性 fake solver（默认，测试用）
  solver/breachweave.ts  真实 Solver：进程内会话、软截止 steer、注入桥、Observer flush
packages/contracts/      control ↔ worker 契约（任务、结果、退出码、宽容解析）
packages/agent/          vendor 的 BreachWeave core（Apache-2.0，含内置 prompts/skills）
  src/solver/extension/cairn-observer/  Cairn Observer 适配层（默认关闭）
packages/pi-mcp-adapter/ vendor 的 MCP 适配器 2.2.2（MIT）
packages/graph/          schema、领域模型、服务、命令、导出、YAML 发射器
  src/db.ts              bun:sqlite、schema、旧库迁移、事务连接
  src/models.ts          领域类型 + 请求校验（含 project scope）
  src/services.ts        ID/租约/状态机
  src/commands.ts        HTTP API 与 scheduler 共用的图变更命令
  src/artifacts.ts       artifacts 扫描、SHA-256、索引查询
  src/hashing.ts         流式 SHA-256（artifacts 与证据共用）
  src/runs.ts            runs / fact_meta 旁路表读写
  src/fact-evidence.ts   fact_evidence 内容摘要读写
  src/pending-concludes.ts 跨重启的 conclude 队列
  src/export.ts          YAML、timeline 与图切片导出
  src/yaml.ts            PyYAML 兼容的 block-style 发射器
  testdata/              Python 生成的 golden
apps/cairn/src/http/testdata/api.golden.json   60 步 HTTP 对照
apps/cairn/src/prompts/testdata/prompts.golden.json  10 个 prompt 渲染对照
dispatch.example.yaml    调度器配置示例（默认本地模式，含容器段注释）
Dockerfile.worker        worker 镜像（bun + procps）
tools/golden/generate.py golden 生成器（Python）
tools/gate/m2c-gate.ts   真实模型的端到端 gate（不计入 bun test）
tools/gate/m3-gate.ts    Scope/审计/artifacts/容器 gate（不调用模型）
tools/gate/m3-container-e2e.ts  真实容器 + fake solver 的调度端到端 gate
tools/gate/m3-real-container-gate.ts  真实容器 + 真实模型 + Scope 硬拦截 gate（计费）
tools/gate/m4-conclude-gate.ts  真实模型的会话恢复 conclude gate（计费）
tools/gate/m4c-observer-gate.ts  真实模型的 Observer 看板 review gate（计费）
tools/vendor/            vendor 资产生成器
docs/ARCHITECTURE.md     角色、数据所有权、时序、沙箱、失败语义
docs/OBSERVER.md         Observer 实现、配置、权限、flush 语义与已知限制（M4c）
docs/PORTING.md          Python 模块 → TS 模块映射与对照测试策略
```

## 命令

```bash
bun install
bun run cairn serve --port 8000 --db-path ./cairn.db
bun run cairn version
bun test
bun run typecheck
```

`serve` 支持 `--host`、`--port`、`--db-path`、`--static-dir`、`--log-level`、
`--access-log/--no-access-log`（后两者为兼容 Cairn CLI 而接受）。`--config` 指向
`dispatch.example.yaml` 同形状的文件，并启用进程内 scheduler；不带 `--config` 时只跑
HTTP API。M3 同时支持 `runtime.execution: local` 与 `container`。

快速验证：

```bash
# 终端 1：控制面 + scheduler
bun run cairn serve --port 8000 --db-path ./cairn.db --config dispatch.example.yaml

# 终端 2：创建带授权范围的项目
curl -s -X POST localhost:8000/projects -H 'content-type: application/json' -d '{
  "title":"demo","origin":"start","goal":"finish","bootstrap_enabled":false,
  "scope":{"targets":["127.0.0.1:8080"],"notes":"local lab"}
}'
curl -s localhost:8000/projects/proj_001
```

**没有 `scope` 的项目不会被调度**（fail closed）：`scope.targets` 至少一项，表示已获
书面授权的目标。Host Bridge 会在每次模型工具调用前强制校验它。

本地模式下每个项目的工作区是 `<workspace_root>/<project_id>/`，任务文件、graph 快照、
stdout/stderr 日志和结果文件都在 `<workspace>/.cairn/sessions/<task_id>/`；默认保留
以便审计（`worker.retain_task_files: false` 可关闭）。

### 容器模式（M3）

```bash
docker build -f Dockerfile.worker -t cairn-worker:latest .
# 若 Docker Hub 不可达，可先拉取镜像站并 tag，或使用 build arg：
# docker build --build-arg BUN_IMAGE=<mirror>/oven/bun:1.4 -f Dockerfile.worker -t cairn-worker:latest .
```

`dispatch.yaml`：

```yaml
runtime:
  execution: container
container:
  image: "cairn-worker:latest"
  network_mode: "bridge"
  completed_action: remove        # 项目完成后 rm -f；stop 则保留容器
  cap_add: []                     # 按需，例如 NET_RAW
  workspace_root: "/srv/cairn-runs"  # 可选；默认控制面 cwd
  worker_argv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"]
```

行为：

- 每个项目一个容器 `cairn-dispatch-<project_id>`（ID 做安全化处理），带
  `cairn.managed=1` 标签；
  控制面启动时用 `docker version` 检查 daemon，不可用则拒绝启动；
- 宿主 `<workspace_root>/<project_id>` 用 `--mount` 绑定到 `/cairn/workspace`；
  agent 配置目录只读挂载到 `/cairn/agent-config`，容器启动时内置 prompts/skills
  由控制面预先写入宿主目录；
- 容器内每个任务把只读配置复制到 `/tmp/cairn-agent-config/<task_id>/`（目录 `0700`，
  `auth.json` 为 `0600`）再交给 Solver。原因是上游会话的 auth 存储在 `auth.json` 旁建
  锁文件，只读挂载下会以 `EROFS` 失败并静默丢弃凭据；任务结束后删除副本。宿主上的源
  配置始终只读，副本只存在于容器临时层，不进入工作区或任务文件；
- 每个任务 `docker exec -i` 一次；超时/取消用 `pkill -TERM/-KILL -f -- <task.json>`
  只终止该任务，不会杀掉同项目的其他任务，也不杀容器；
- 容器不挂 Docker socket，环境变量只来自 `common_env`、`CAIRN_SOLVER` 和固定的
  `CAIRN_AGENT_CONFIG_*`；
- 项目 completed/stopped/deleted 后按 `completed_action` 删除或停止容器；控制面退出
  时停止仍在跟踪的容器。

### Host Bridge 与审计

worker 启动真实 Solver 前会把 `task.scope.targets` 与工作区/会话路径写入
`CAIRN_SCOPE_POLICY`。`packages/agent` 的 solver 会话和 subagent 会话都会加载
`CAIRN_HOST_BRIDGE_MODULE`（`apps/cairn/src/host-bridge/worker-extension.ts`），因此
子代理不能绕过同一道闸门。

- 网络：从 `bash` 命令中提取 URL、`/dev/tcp`、IPv4/IPv6、CIDR、`host:port`、`nc host port`
  等端点；主机名按字面匹配（不做 DNS），支持 `*.example.com` 与 IPv4 CIDR。识别为网络
  工具却提取不到端点时 **拒绝**。
- 文件：读只能在工作区或 `file:` scope 目标内；写只能在项目工作区内；agent 配置目录
  （`/cairn/agent-config`、`~/.tch-agent`）始终拒绝；按 realpath + 词法双重判断，阻止
  符号链接逃逸。
- 未知工具默认 **拒绝**；只有明确列出的 worker 本地工具（subagent、document_finding、
  challenge 工具等）放行，`subagent` 的会话仍受同一闸门约束。
- 每次 allow/block 都追加到 `<sessionDir>/audit.jsonl`（task_id、project_id、tool、
  action、targets、decision、reason、detail）。审计不可写时同样拒绝。
- **边界**：这是模型工具调用的策略闸门，不是针对任意代码的沙箱。模型若通过未识别的
  程序发起网络请求，Host Bridge 看不到；容器隔离（网络命名空间、不挂 socket、只读配置）
  才是内核边界。两者必须同时启用。

### artifacts

任务结束（成功、失败、取消都算）后，控制面扫描 `<workspace>/artifacts/**`：跳过符号
链接，最多 2000 个文件/20 层，逐文件流式 SHA-256，记录到 `project_artifacts` 表。查询：

```bash
curl -s localhost:8000/projects/proj_001/artifacts
```

索引是扫描结果而非信任边界；artifacts 目录不存在时保留上一版索引。

### 证据、内容校验与 runs（M5a + M5b）

worker 可以在 `result.json` 根级返回工作区相对的 `evidence_refs`（不进入 Cairn
payload，因此既有校验和 golden 响应不变）：

```json
{"accepted": true, "data": {"description": "..."},
 "evidence_refs": ["artifacts/report.txt"]}
```

- 控制面在写图前校验每条路径：非空、≤512 字符、最多 20 条，拒绝绝对路径、盘符、
  `..`、NUL、目录、符号链接、不存在与 realpath 越界；通过后统一为 `/` 并去重。
- 证据文件默认至少要 1 字节（`tasks.evidence.min_bytes`，`0` 关闭）：空文件通常是
  占位符，声明了却无法提供内容时按非法证据失败。
- 省略或空数组 → `evidence_status: "missing"`，任务照常完成；声称了但有一条非法 →
  任务失败。reason 任务不产出 Fact，不要求证据。
- 每个任务一行 `runs`（成功/失败/取消/lease 丢失都记录），每个任务产出的 Fact 一行
  `fact_meta`。M5a 之前或手工创建的 Fact 没有行，读取时显示 `legacy`。
- M5b 在结论时为每条证据记录 `size` 与 `sha256`（`fact_evidence`）。之后读取
  `/evidence` 会重算当前文件：内容一致为 `ok`，大小或摘要变化为 `modified`，删除为
  `missing`，读不了为 `unreadable`，路径不再是合法普通文件为 `invalid`。
- 查询：

```bash
curl -s localhost:8000/projects/proj_001/runs
curl -s localhost:8000/projects/proj_001/facts/<fact_id>/meta
curl -s localhost:8000/projects/proj_001/facts/<fact_id>/evidence
```

fake solver 会为每个任务写 `artifacts/fake-<task_id>.txt` 并返回对应证据；真实 Solver
的 prompt 增加了一段证据契约，但只在有文件证据时才应提供 `evidence_refs`。

哈希在控制面、worker 退出后计算，是**事后快照**：它能发现结论之后的替换/删除，但不能
证明文件由该任务创建，也不是签名。需要防篡改时应在容器/文件系统层再加控制。

### 图切片（M4b，可选）

默认发给 worker 的是全图 `graph.yaml`，与 Cairn 一致。项目变大后可只给 explore 任务
相关的子图，减少无关上下文：

```yaml
tasks:
  graph_slice:
    enabled: true
    max_facts: 80
    max_intents: 60
```

- 只影响 `explore` 以及由失败 explore 触发的 `conclude`；`reason` / `bootstrap` 始终
  使用全图（它们需要全局视野）。
- **硬保留**：focus intent、所有其他未结束 intent、以及它们的来源 Fact（`origin` /
  `goal` 也总在）不受 caps 限制。
- 其余 provenance（产生某个已含 Fact 的 intent 及其来源）按包含顺序尽力补齐；触到
  caps 就停止，并由 `slice.truncated: true` 标记。
- 切片文件多一个 `slice:` 段：`focus_intent`、`included_facts`、`included_intents`、
  `max_facts`、`max_intents`、`truncated`。全图导出不变。

### Observer（M4c，可选，默认关闭）

Observer 是真实 Solver 旁边的 review sidecar。它只维护看板，不执行验证，也不改变任务
结果；fake solver 会忽略它。

```yaml
observer:
  enabled: true
  model: null                 # model-prefs.json 条目；null 复用主 prompt 模型
  every_rounds: 4
  window_rounds: 8
  timeout_seconds: 60
  max_reviews_per_task: 8
  kernel_tasks: ["explore"]   # bootstrap / reason / explore / conclude
```

- scheduler 只为命中 `kernel_tasks` 的任务写 `observer-context.json` 并注入
  `CAIRN_OBSERVER_*`；关闭时显式注入 `CAIRN_OBSERVER_ENABLED=0`。
- 看板是**项目级** `<workspace>/.cairn/board/`，跨任务持久；review 状态/队列/轮次是
  任务级 `<session>/observer/`。sidecar 的 JSONL 在 `<session>/observer/sidecar/`。
- 主 Solver 只有 `memory_list` / `idea_list` / `idea_search` 三个只读工具；写工具不在
  Host Bridge 白名单，文件工具对看板目录的 `write` / `edit` 也被拒绝。
- sidecar 使用 `CAIRN_AGENT_CONFIG_DIR`，只注册看板工具与 `query_solver_history`，没有
  shell/文件/网络工具，不加载 Host Bridge，不触发 challenge 续跑或效率 steer。
- 每 `every_rounds` 轮、`agent_end` 和 `solve()` 返回前的 `flush()` 触发串行 review。
  `flush()` 最多等待 `timeout_seconds`，任何失败只写
  `<session>/observer/audit.jsonl`，绝不影响 `result.json`。
- 已知边界：看板写保护只覆盖结构化文件工具；`bash` 仍可在工作区内写看板。默认
  `max_project_workers: 1` 避免同项目并发写。详见 `docs/OBSERVER.md`。

## 真实 Solver 与模型配置（M2c）

默认 solver 是确定性的 `fake`。用环境变量启用真实 BreachWeave Solver：

```bash
CAIRN_SOLVER=breachweave bun run cairn serve --port 8000 --db-path ./cairn.db \
  --config dispatch.example.yaml
```

也可以在 `dispatch.yaml` 的 `common_env` 里设置 `CAIRN_SOLVER: breachweave`。真实 Solver
读取 BreachWeave 的配置目录（默认 `~/.tch-agent/config`，`CAIRN_AGENT_CONFIG_DIR` 可
覆盖），首次启动时会把内置 prompts/skills 补齐到该目录：

- `auth.json`：provider 凭据，**API key 只保存在这里**；
- `models.json`：provider、baseUrl、api 协议与模型列表。自定义 provider 的 `apiKey`
  字段是上游 SDK 的必填项；把它写成环境变量名（例如 `CAIRN_MODEL_API_KEY`）即可不在
  该文件中落盘密钥，请求时优先使用 `auth.json` 的凭据；
- `model-prefs.json`：短 ID → 模型映射；`cairn-worker` 提示词的 frontmatter
  `model: "cairn-worker"` 引用同名条目；
- `prompts/`、`skills/`：用户可覆盖内置资源。

最小形状（示例，不含真实密钥）：

```json
{ "models": [{ "id": "cairn-worker", "provider": "my-provider", "modelId": "model-id" }] }
```

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://gateway.example/v1",
      "api": "openai-completions",
      "models": [{ "id": "model-id" }],
      "apiKey": "CAIRN_MODEL_API_KEY"
    }
  }
}
```

```json
{ "my-provider": { "type": "api_key", "key": "..." } }
```

这些文件不属于仓库，也不会写进 `task.json`；权限应仅限本人。真实模型 gate 不在
`bun test` 中（会调用模型、产生费用）：

```bash
bun run tools/gate/m2c-gate.ts
```

它创建临时项目，让真实模型读取工作区的 `marker.txt`。通过条件：项目 `completed`、
至少新增一个 Fact、且 Fact 描述包含 marker。失败时保留临时目录，`CAIRN_GATE_KEEP=1`
可强制保留以便检查 `task.json`、`result.json`、`solver-session/` 与日志。

容器 + 真实模型的联调 gate 是 `tools/gate/m3-real-container-gate.ts`，同样不在
`bun test` 中。它要求 Docker、`cairn-worker:latest` 与本机模型凭据，会真实调用模型并
产生费用。除模型路径外，它还会在容器内用 `docker exec` 直接运行 Host Bridge 的
allow/block 探针，因此越界拒绝不依赖模型是否配合。容器访问宿主上的靶场服务走
`host.docker.internal`；若模型网关只能从宿主访问，gate 会自行在宿主上起一个仅用于
测试的 CONNECT 代理，并通过 `HTTPS_PROXY` 注入容器，不修改宿主全局代理设置。运行：

```bash
CAIRN_GATE_PROXY_PROBE_URL=https://<gateway>/v1/models \
  bun run tools/gate/m3-real-container-gate.ts
```

`CAIRN_GATE_PROXY_PROBE_URL` 只验证“容器能把 HTTPS 经代理送出去”（任何 HTTP 状态码都
算连通）；`CAIRN_GATE_DOCKER_IMAGE`、`CAIRN_DOCKER`、`CAIRN_AGENT_CONFIG_DIR` 可覆盖
镜像、CLI 与配置目录。

Observer 的真实模型联调 gate 是 `tools/gate/m4c-observer-gate.ts`。它在本地模式跑一个
bootstrap 任务，预置一条 pending idea，并检查主 solver 只使用只读看板工具、sidecar 只用
看板/history 工具、review 审计与 flush 完成、看板被真实更新且任务结果不变：

```bash
CAIRN_GATE_KEEP=1 bun run tools/gate/m4c-observer-gate.ts
```

## 验证（M1 + M2a + M2b + M2c + M3 + M4a + M4b + M4c + M5a + M5b + M5c，2026-10-25，Bun 1.4.4）

- `bun test`：**230 passed**（28 个文件），0 failed。
- `bun run typecheck`：`tsc --noEmit` 通过。
- **HTTP 对照**：`api.golden.json` 的 60 步请求（成功路径、400/403/404/405/409、租约过期、
  删除级联、导出、路由错误）由 Python FastAPI + 固定时钟生成；TS 重放后状态码、content-type
  与响应正文逐字一致。422 只比较状态码（见下）。
- **导出对照**：PyYAML 生成的 YAML 与 Python timeline 在包含多行、中文、emoji、超长折行、
  需要引号的标量上逐字一致。
- **标量对照**：61 条 PyYAML 标量用例逐字一致（含 80 列折行、单/双引号选择）。
- **Prompt 对照**：default 与 mock 各 5 个模板、替换后的完整文本、3 个 JSON 格式化函数
  均与 Python 版逐字一致；含中文、引号、换行、`{origin}` 字面量与替换顺序用例。
- **配置校验**：`dispatch.example.yaml` 可加载；未知顶层键、旧 `workers` 段、并发上限、
  容器模式缺少 `container`、prompt 组/占位符缺失均报错；`tasks.graph_slice` 的默认值
  （关闭，80/60）与非法 caps 均有断言；`tasks.evidence.min_bytes` 的默认值、`0` 关闭
  与负值/非整数拒绝也有覆盖。
- **契约解析**：宽容 JSON 提取（整段、fence、前后散文、字符串内大括号、嵌套对象、
  先坏后好）与四个 payload 校验器覆盖 Cairn 的接受范围和错误文本。
- **scheduler 端到端**：真实拉起 `cairn worker` 子进程（fake solver）。非 bootstrap 项目
  经 2 次 reason + 2 次 explore 产出 2 个 Fact 并 completed；bootstrap 项目产出 1 个 Fact
  后 completed；无 scope 项目保持 active 且零意图（fail closed）。
- **conclude 调度**：`flaky-worker` fixture 在 explore/bootstrap 首次执行时落盘一个
  partial session 后退出 1。断言 scheduler 记录 `conclude queued` / `dispatched conclude`、
  conclude 任务带 `resumeSessionDir` 与 `concludeOf`、explore 两个 intent 都被结束；
  bootstrap conclude 只产出一个 Fact 而不把项目标记为完成。另有一条
  `retain_task_files: false` 用例，断言 conclude 结束后失败任务与 conclude 任务两个
  session 目录都被删除。M5c 另用预置的 `pending_concludes` 行 + 新 Scheduler 实例
  验证重启后无需内存状态即可派发 conclude，并在结束后清空队列。
- **图切片**：4 条导出单测覆盖 focus intent/来源、其他未结束 intent、确定性与全图不变、
  极小 caps 下仍保留硬性内容并置 `truncated: true`、未知 focus 报错；scheduler 测试确认
  开启后 explore 快照含 `slice:` 段而 reason 快照仍是全图。
- **真实进程冒烟**：`cairn serve` 实际监听；创建项目、创建意图、YAML 导出、静态首页、
  删除后 404 均通过。
- **真实 Solver gate**：`tools/gate/m2c-gate.ts` 用真实模型跑通 bootstrap 项目（临时
  workspace + `marker.txt`），模型通过 `read` 工具读取文件，产出 Fact `f001`（描述含
  `CAIRN-M2C-GATE-9c41`）并完成项目；同一 gate 在 reason-only 项目中也能正常完成，但
  `complete` 路径不新增 Fact，因此 gate 固定走 bootstrap 以获得确定性的 Fact 断言。
- **Host Bridge**：进程内 scope 测试覆盖 in/out-of-scope 网络、端口/CIDR/通配主机名、
  workspace 内外读写、`file:` 目标、agent 配置保护、符号链接逃逸、空/非法 scope、
  未知工具、审计不可写，以及 pi extension 的 block 返回；`audit.jsonl` 每条决策逐字段
  校验。M4c 另覆盖只读看板工具 allow、看板写工具 block、看板目录的 `write`/`edit`
  block 以及 `read` allow。
- **Observer（M4c，不计费）**：配置默认关闭与合法性校验；scheduler 的 context/env
  注入、`kernel_tasks` 过滤、facts/hints 截断、focus intent 在 20 条上限之外仍保留；
  board/state 路径优先级与 fail closed；周期 + flush、`max_reviews_per_task`、review
  挂起时 flush 超时不抛、state 目录不可用时 flush 不抛；损坏队列条目被跳过；并行工具
  事件写入串行化；`extraEnv` 合并顺序。真实 review 模型路径见下面的计费 gate。
- **runtime**：容器参数（mount、label、只读配置、环境变量白名单、不泄漏控制面环境）
  与 lifecycle（创建/复用/重启/inspect 失败 fail closed/清理/关闭）有 fake docker CLI
  单测；任务终止只发 `pkill`，不杀项目容器。真实 Docker（29.9.2）下另有两个 gate：
  - `tools/gate/m3-gate.ts`：**14 passed / 0 failed / 0 skipped**（不调用模型），覆盖
    越界网络/文件拒绝与审计、未知工具 fail closed、artifacts 索引与 HTTP 查询、真实容器
    启动与 `/cairn/workspace` 映射。未安装 Docker 时该项显示 **SKIP（未验证）**，而不是
    伪装通过。
  - `tools/gate/m3-container-e2e.ts`：真实容器端到端 **4/4 PASS**。scheduler 用
    `execution: container` 与 fake solver 完成一个项目（2 个 Fact），两次 `docker exec`
    的结果经 bind mount 回到控制面，项目完成后容器被删除并记录日志。
  - `tools/gate/m3-real-container-gate.ts`：真实容器 + 真实模型 **17 passed / 0 failed**
    （2026-10-25，Docker 29.9.2，`cairn-worker:latest`）。真实 Solver 在容器内经
    `docker exec` 完成 bootstrap 项目，模型执行授权范围内的 `bun -e 'fetch(...)'`，
    Fact 含宿主靶场 marker；`audit.jsonl` 记录该网络动作的 allow。随后 gate 在容器内
    直接加载 Host Bridge 探针，同形命令对 out-of-scope 端口得到 block 且审计落盘，所有
    审计行都带 `project_id`/`task_id`。最后用两个不同 task 路径的容器内长驻进程验证
    `pkill -f -- <task.json>` 的实机语义：只终止目标任务，同项目兄弟任务存活，容器
    继续运行；项目完成后容器被删除，探针后再次删除。gate 的 CONNECT 代理只用于让容器
    访问宿主可达的模型网关，属于测试夹具，不进入生产配置。
- **Observer 真实模型 gate**：`tools/gate/m4c-observer-gate.ts` 在本地模式跑一个真实
  bootstrap 任务。**14/14 PASS**（2026-10-25）：scheduler 写出启用的 context，主 solver
  调用 `idea_list`/`memory_list` 后读取 marker 并完成项目；sidecar 只调用
  `idea_list`/`memory_list`/`idea_update`/`memory_add`，没有
  `send_efficiency_reminder`；审计记录 `review_started`、`review_finished`、
  `flush_finished` 且队列为空；预置 idea 从 `pending` 变为 `verified` 并新增 1 条
  memory；主 solver 没有任何看板写工具调用，最终 Fact 仍含 marker。该 gate 计费、
  不计入 `bun test`。
- **conclude + 真实会话恢复**：`tools/gate/m4-conclude-gate.ts` 用真实模型先跑一个
  bootstrap 任务，再用 scheduler 的 `prepareTask` 构造 bootstrap conclude。**10/10 PASS**
  （2026-10-25）：conclude 通过 `SessionManager.open` 打开同一个 JSONL（同一 session id、
  同一文件），追加后条目数 19 → 21，模型返回可校验的 `{"accepted":true,"data":{"fact":
  {"description":...}}}`。该 gate 计费、不计入 `bun test`；调度/失败路径由上面的
  flaky-worker 测试覆盖。
- **artifacts**：嵌套路径、大小、SHA-256、刷新、目录缺失保留旧索引、符号链接跳过，
  以及 `GET /projects/{id}/artifacts` 路由。
- **证据与 runs（M5a）**：证据校验覆盖缺失、合法/去重/反斜杠、绝对路径与 `..`、
  不存在/目录、符号链接（平台不支持时跳过）、20 条上限；契约测试覆盖
  `evidence_refs` 的接受与拒绝。scheduler 断言每个任务一行 `runs`、每个动态 Fact 都有
  `provided` 的 `fact_meta` 并链接到 run，reason 的 `evidence_count` 为 0。HTTP 测试
  覆盖 runs 列表、run 的顺序、Fact meta 的 `provided`/`legacy`/未知 Fact 404；手动
  conclude 产生的 Fact 记为 `missing`。项目删除会级联清理两张旁路表。
- **证据哈希与校验（M5b）**：采集证据时断言字节数与 SHA-256 和文件内容一致；校验函数
  覆盖 `ok`、改写后的 `modified`、删除后的 `missing`、目录替换后的 `invalid` 以及
  workspace 不存在时的 `unreadable`。HTTP 测试覆盖未改动、篡改、删除、无 workspace
  root 的 `unverified`、无证据 Fact 的空数组、未知 Fact/项目 404；scheduler 端到端
  断言 `fact_evidence` 行的摘要与实际文件逐字一致。
- **最小证据与持久化队列（M5c）**：默认拒绝 0 字节文件，`min_bytes` 的边界（等于阈值
  接受、小于阈值拒绝）与 `0` 关闭均有断言；`pending_concludes` 覆盖去重、排序、删除、
  会话查找、未知项目 404 与项目级联删除。

golden 由 `tools/golden/generate.py` 在 Python Cairn 检出上生成（固定时钟、`TZ=UTC`）。
重新生成方法与约束见 `docs/PORTING.md`。

## 与 Python Cairn 的已知差异

这些差异是刻意的或只影响诊断信息：

- **422 错误体**：状态码与 `{"detail": [...]}` 信封保持一致，但不复刻 pydantic 的
  `ctx`/`url` 字段；golden 对 422 只比较状态码。
- **请求类型更严格**：`bootstrap_enabled` 只接受 JSON 布尔值（pydantic 还会把
  `"yes"`、`1` 等强制转换）；超时字段只接受整数。合法客户端不受影响，异常输入更早失败。
- **静态文件 content-type**：Bun 输出 `text/html;charset=utf-8`，Starlette 是
  `text/html; charset=utf-8`；JSON/export 的 content-type 已逐字对齐。
- **YAML 双引号长标量**：控制字符/制表符触发的双引号标量不做 PyYAML 式折行；语义等价，
  单/双引号选择与转义一致。

## 里程碑

| 阶段 | 内容 | Gate |
| --- | --- | --- |
| **M0** | 仓库骨架、任务/结果契约、角色 CLI、架构与移植文档 | `bun test` + `tsc` 通过 |
| **M1** | 图存储、SQLite、HTTP API、YAML 导出、静态 UI | 与 Python Cairn 的 golden 一致 |
| M2a ✅ | config + prompting + 默认 prompts | prompt golden 全绿（2026-10-25） |
| M2b ✅ | scheduler、worker supervisor、宽容解析、fake solver | fake solver 端到端产出 Fact（2026-10-25） |
| M2c ✅ | vendor BreachWeave core，接真实 Solver | 真实项目产出 Fact（`f001`，2026-10-25） |
| M3 ✅ | 每项目容器、Host Bridge、Scope 硬拦截、artifacts | 越界工具调用被拒绝且可审计；真实 Docker 容器端到端 4/4；真实容器 + 真实模型 17/17（2026-10-25） |
| M4a ✅ | conclude 回退：独立任务 + 持久会话恢复 | 真实模型 gate 10/10（同 session id/文件，19→21 条）；flaky-worker 调度测试（2026-10-25） |
| M4b ✅ | 可选图切片：explore / explore-conclude 使用子图快照 | 切片导出 4 条单测 + scheduler/配置断言（2026-10-25） |
| M4c ✅ | Observer：项目级看板、只读主 Solver、sidecar review、bounded flush | 187 passed / 23 files；真实模型 gate 14/14（2026-10-25） |
| **M4** | Observer | 完成（M4c）；设计与已知限制见 `docs/OBSERVER.md` |
| M5a ✅ | 证据门控 + `runs` / `fact_meta` 旁路表 + 两个只读路由 | 210 passed / 26 files；图/YAML/golden 响应不变（2026-10-25） |
| M5b ✅ | 证据 size/SHA-256 固化 + 实时校验路由 | 221 passed / 27 files（2026-10-25） |
| M5c ✅ | 证据最小字节策略 + 跨重启持久化 conclude 队列 | 230 passed / 28 files（2026-10-25） |

## 与 Phase 0 的关系

`ctfagent/` 里的 Phase 0 实现（`tch` driver、`tch_bridge.py`、overlay 补丁）保留作对照，
M2c 验收通过后删除。它的价值是验证了 BreachWeave Solver 能被 Cairn 的任务契约驱动；
它的成本是每次任务多一次进程、多一层 JSONL 转译——这两点在本项目中消失。

## 许可证与合规

本项目整体按 **AGPL-3.0** 分发（见 `LICENSE`）。仅用于已获明确书面授权的渗透测试、
靶场、比赛或企业自查；未授权扫描或利用不在支持范围内。
