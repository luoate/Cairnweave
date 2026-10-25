# 移植映射（Cairn Python → TypeScript）

原则：**先等价移植，再改进**。M1/M2 不重新设计领域模型、API 形状或 JSON 契约；任何偏离都要
有对照测试和一条明确理由。

## 1. 模块映射

行数来自 `Cairn-main/cairn/src`（2026-10-25）。

| Python | 行数 | TypeScript 目标 | 说明 |
| --- | --- | --- | --- |
| `server/db.py` | — | `packages/graph/src/db.ts` | `bun:sqlite`；schema 原样，含 `CREATE TABLE IF NOT EXISTS` 与 counters |
| `server/models.py` | — | `packages/graph/src/models.ts` | 领域类型与状态机 |
| `server/services.py` | — | `packages/graph/src/services.ts` | 事实/意图/提示的业务规则；事务边界保持 |
| `server/app.py` | — | `apps/cairn/src/http/app.ts` | 路由装配；建议 Hono（Bun 原生），零依赖时用 `Bun.serve` |
| `server/routers/{projects,intents,hints,settings,export}.py` | — | `apps/cairn/src/http/routes/*.ts` | 路径、方法、状态码、错误体逐项对齐 |
| `dispatcher/config.py` | — | `apps/cairn/src/config.ts` | 保留 `server/runtime/tasks/container/local/common_env`；删除 `workers` 与 `WORKER_ENV_KEYS`；新增 `worker` 段（软截止比例、任务文件保留、结果宽限）、可选的 `tasks.graph_slice`（M4b）与 `observer`（M4c，默认关闭） |
| `dispatcher/contracts.py` | — | `packages/contracts/src/` | 任务/结果契约（M0 已建立，按此扩充） |
| `dispatcher/output_parser.py` | — | `packages/contracts/src/parse.ts` | 宽容 JSON 提取；算法与测试逐条移植 |
| `dispatcher/prompting.py` + `prompts/{default,mock}/*.md` | — | `apps/cairn/src/prompts/` | 模板逐字复制；渲染顺序与 `json.dumps(indent=2, ensure_ascii=False)` 一致；golden 对照 |
| `dispatcher/tasks/{bootstrap,reason,explore,common}.py` | — | `apps/cairn/src/scheduler/{tasks,loop}.ts` | prompt/graph 落盘在 `tasks.ts`；结果应用与租约释放在 `loop.ts`；`conclude` 在 M4a 落地为独立任务（恢复失败会话）；M4b 的可选切片只作用于 explore/explore-conclude；M4c 的 observer context 与 `CAIRN_OBSERVER_*` env 也在 `tasks.ts` |
| `dispatcher/scheduler/loop.py` | — | `apps/cairn/src/scheduler/loop.ts` | Python 线程池 → 单进程异步 supervisor；leases/heartbeat/超时语义保持 |
| `dispatcher/scheduler/worker_select.py` | — | **删除** | 只剩一个 worker 实现，固定名 `cairn-worker`；槽位由 `max_workers` / `max_project_workers` 控制 |
| `dispatcher/runtime/{process,local_process}.py` | — | `apps/cairn/src/runtime/local.ts` + `runtime/types.ts` | `Bun.spawn` + SIGTERM/SIGKILL + stdout/stderr 归档 |
| `dispatcher/workers/adapters/mock.py` | — | `apps/cairn/src/solver/fake.ts` | 确定性 fake solver，供端到端测试；M2c 后保留为默认/离线替身 |
| `dispatcher/runtime/{containers,local_backend}.py` | — | `apps/cairn/src/runtime/{docker,paths}.ts` | Docker CLI + 每项目长驻容器；宿主 ↔ `/cairn/workspace` 路径映射 |
| `dispatcher/runtime/{heartbeat,cancellation,startup_healthcheck}.py` | — | `apps/cairn/src/scheduler/loop.ts` + `roles/control.ts` | 续租、取消、硬截止；启动时单次 Docker/模型检查 |
| `dispatcher/protocol/client.py` | — | `packages/api-client/src/` | 仅 CLI/UI/测试使用；控制面内部直接调 services |
| `dispatcher/logging.py` | — | `apps/cairn/src/logging.ts` | 结构化日志与脱敏 |
| `dispatcher/workers/**` | ~1.1k（含 Phase 0 的 tch） | **删除** | 由 `roles/worker.ts` + `packages/agent` 取代 |
| `dispatcher/workers/adapters/tch*.py` | — | **删除** | Phase 0 的桥，不进入新项目 |

`packages/agent` 是 BreachWeave `packages/core` 的并入点（M2c 已 vendor，Apache-2.0）：

| BreachWeave（`packages/core/src`） | 合并后位置 | 说明 |
| --- | --- | --- |
| `config/**`（含 builtin prompts/skills、generated assets） | `packages/agent/src/config/**` | 原样 vendor；新增 `cairn-worker` prompt 的 `model` frontmatter |
| `solver/**`（session、工具、事件） | `packages/agent/src/solver/**` | vendor 后做 Cairn 适配：board 根目录可配置、`session.ts` 选择 Cairn Observer、`cairn-observer/` 新目录；worker 直接调用 `createSolverSession`，不走 RPC |
| BreachWeave challenge-observer | `packages/agent/src/solver/extension/cairn-observer/**` | 新增的 Cairn 适配层；复用看板工具与 `OBSERVER_SYSTEM_PROMPT`，不复用 challenge 续跑/host-bridge RPC/steer（见 `docs/OBSERVER.md`） |
| `runtime/**`、`challenge/**`、`mcp/**` 等其余模块 | `packages/agent/src/**` | 原样 vendor，供 Solver 依赖 |
| `*.test.ts`、`__tests__` | **删除** | 不纳入本仓库测试 |
| `config/skills/builtin/fuzz-dicts-skills`、`payloads-everything` | **删除** | `cairn-worker` 未引用；约 56 MB |
| `packages/libs/pi-mcp-adapter` 2.2.2 | `packages/pi-mcp-adapter/` | 原样 vendor（MIT），workspace 依赖 |

类型边界是 `packages/agent/index.d.ts`：根 `tsconfig.json` 排除 vendor 目录，`tsc` 只检查
这个手写声明，Bun 运行时执行 vendor 的 TypeScript。`tools/vendor/generate-agent-assets.ts`
用于重新生成内置资源清单。上游版本与改动见 `THIRD_PARTY.md`。

## 2. 必须逐字/逐字段保持的语义

- **SQLite schema**：表、列、默认值、复合主键、外键与级联行为。允许新增表，不得改动既有列。
- **计数器与 ID**：project / fact / intent / hint 的编号格式、scoped counters 的并发语义。
- **状态与时间戳**：项目/意图状态枚举、`created_at` / `concluded_at` / heartbeat 字段。
- **HTTP API**：路径、方法、状态码、字段名、空值与错误体。现有客户端不应需要改动。
- **图 YAML 导出**：节点顺序、字段顺序、缩进与引号风格。建议先定义 canonical emitter，再用
  PyYAML 输出做 golden。M4b 的切片导出是**新增的独立函数**（`exportProjectSliceYaml`），
  只在 `tasks.graph_slice.enabled` 时用于 explore 快照；默认全图导出与 golden 逐字不变。切片
  文件额外带 `slice:` 顶层段，仍由同一 YAML emitter 生成。
- **Prompt 渲染**：五个模板（reason / explore / explore_conclude / bootstrap /
  bootstrap_conclude）的占位符替换结果（含换行）必须一致；M4a 起五个模板都会被实际派发
  使用。替换按 dict 插入顺序逐 token 执行（值里出现的后续 token 也会被替换，与 Python
  相同）。`graph_yaml` 仍替换为文件路径
  说明，而非内联内容；M2c 本地模式用 `sandbox` 作为文字，容器模式与 Python 一样用
  `container`。
- **结果契约**：`{"accepted":true,"data":{...}}` / `{"accepted":false,"reason":"..."}`，以及
  宽容提取（fence、前后散文）的接受范围。
- **超时与租约**：软截止、硬截止、heartbeat 失效、intent 释放/失败边界。

M1 已记录的偏离（均不影响合法客户端）：

- 422 只保证状态码与 `{"detail": [...]}` 信封；不复刻 pydantic 的 `ctx`/`url`。
- `bootstrap_enabled` 只接受 JSON 布尔值，超时字段只接受整数；pydantic 会做更多强制转换。
- PyYAML 对含控制字符的超长标量会折行；本实现的双引号标量不折行（语义等价）。
- **配置更严格**：顶层未知键直接报错，旧的 `workers` 段给出明确迁移错误；数值与布尔字段
  不做 pydantic 式强制转换。
- **Prompt 的 graph 位置文字**：本地模式写 `sandbox`，容器模式写 `container`；模板和其余
  替换内容逐字一致。
- **控制面与 worker 的通信**：Python 版 scheduler 通过 HTTP 调用同一个 Cairn API；合并版
  的 scheduler 在控制面进程内直接调用 `packages/graph/src/commands.ts`，worker 只读
  `task.json`、只写 `result.json`。HTTP API 与 scheduler 共用同一组命令，golden 保证
  API 行为未变。
- **Scope 是新增的硬前置条件**：`POST /projects` 可带 `scope`（新增字段，响应体不变）；
  没有 scope 的项目永远不会被调度。Python 版没有这个概念；Host Bridge 在工具调用级别
  强制它，并写 `audit.jsonl`。
- **Artifacts 是新增的只读索引**：`GET /projects/{id}/artifacts` 返回
  `[{path,size,sha256,task_id,created_at}]`。Python 版没有该路由；其余既有路由与响应体
  不变。

## 3. 对照测试策略

1. **Golden fixtures**：用固定数据库和固定操作序列跑 Python 版，记录：
   - 每个 API 请求的状态码与 JSON；
   - `export` 的 YAML 原文；
   - default 与 mock 两组 prompt 的渲染结果、模板原文与 JSON 格式化输出。
   TS 版必须逐字匹配；不匹配时优先改 TS，确实需要变更则更新 golden 并在 PR 说明。
   422 响应只比较状态码：pydantic 的 `ctx`/`url` 字段不进入契约。

   已落地四份 golden：

   | 文件 | 内容 | 比对方 |
   | --- | --- | --- |
   | `apps/cairn/src/http/testdata/api.golden.json` | 60 步请求/响应 + 固定时钟 + 直接 SQL 步骤 | 状态码、content-type、正文 |
   | `packages/graph/testdata/export.golden.json` | 固定行集、YAML 与 timeline 原文 | 逐字 |
   | `packages/graph/testdata/scalars.golden.json` | 61 条 PyYAML 标量用例 | 逐字 |
   | `apps/cairn/src/prompts/testdata/prompts.golden.json` | 10 个模板 + 替换结果 + 格式化输入输出 + 必需 token 表 | 逐字 |

   **重新生成**（`tools/golden/generate.py`，只读取上游源码）：

   ```bash
   python -m venv tools/golden/.venv
   tools/golden/.venv/Scripts/python -m pip install "fastapi>=0.115" "httpx>=0.27" "pyyaml>=6.0"
   TZ=UTC tools/golden/.venv/Scripts/python -I tools/golden/generate.py \
     --cairn-root ../Cairn-main
   ```

   约束：脚本必须留在 `tools/golden/`，用 `-I` 启动，并把上游路径作为参数传入；不要在
   `Cairn-main/` 内运行解释器。测试端固定 `TZ=UTC`（API 与导出测试都在文件顶部设置）。
2. **移植现有单测**：`Cairn-main/cairn/tests` 约 2.1k 行，按模块转成 `bun:test`，保留原 case 名。
3. **契约/混沌测试**（新增）：
   - worker 在写结果前被杀 → 控制面释放 intent；
   - `result.json` 缺失、非法 JSON、`accepted` 类型错误；
   - 空 scope → worker 退出 10；
   - 同一 `taskId` 重复应用 → 幂等；
   - 软截止触发 steer、硬截止触发 kill。

   M2b 已覆盖：宽容 JSON 提取、payload 校验、worker 结果原子写入、resultPath 逃逸拒绝、
   scope 缺失 fail closed、租约续期归属。M2c 的真实 Solver 另由
   `tools/gate/m2c-gate.ts` 覆盖（见下）。M3 覆盖：in/out-of-scope 网络、端口/CIDR/通配符、
   不可验证端点 fail closed、文件读写边界与 symlink 逃逸、未知工具、审计失败、审计字段、
   pi `tool_call` 拦截、环境变量策略加载、artifacts 索引与 HTTP 路由、容器参数/exec 环境/
   任务级终止（fake Docker CLI）。M4a 覆盖：worker 进程退出 1 后 scheduler 排队 conclude、
   conclude 任务携带 `resumeSessionDir`/`concludeOf`、bootstrap conclude 只写 Fact 不完成
   项目（`flaky-worker` fixture），以及 `retain_task_files: false` 时失败任务与 conclude
   两个 session 目录都在结束后删除。M4b 覆盖：切片导出保留 focus intent/来源与其他未结束
   intent、确定性、极小 caps 下的硬保留与 `truncated`、未知 focus 报错；scheduler 层确认
   开启后 explore 快照含 `slice:` 而 reason 快照仍是全图；配置默认值与非法 caps 校验。
   M4c 覆盖：Observer 配置默认关闭与非法值、环境契约（精确 `1`、必需路径、数值回落）、
   scheduler 的 context/env 注入与 `kernel_tasks` 过滤、focus intent 在 open-intent
   上限之外仍保留、board/state 路径
   优先级与 fail closed、周期 + flush、`max_reviews_per_task`、review 挂起时 flush 超时
   不抛、state 目录不可用时 flush 不抛、损坏队列条目被跳过、只读看板工具的 Host Bridge
   白名单与看板写路径拒绝、runtime `extraEnv` 合并。真实 review 模型由
   `tools/gate/m4c-observer-gate.ts` 覆盖（计费，14/14 PASS，2026-10-25）。尚未覆盖：
   软/硬截止在 scheduler 里的真实时钟注入；pending conclude 队列的跨重启持久化（当前
   按设计只在内存）；大图下切片 caps 的效果（缺少真实规模数据）；长任务下 Observer 的
   成本、延迟与看板质量。任务级 `pkill` 的实机语义已由
   `m3-real-container-gate.ts` 覆盖。
4. **M2c 端到端**：确定性 fake solver（固定 JSON）已在 M2b 验证调度/写图（非 bootstrap
   项目产出 2 个 Fact，bootstrap 项目产出 1 个 Fact）。M2c 的 gate 用真实模型：
   bootstrap 项目在临时 workspace 中读取 `marker.txt`，产出 Fact `f001`（描述含
   `CAIRN-M2C-GATE-9c41`）并 completed。gate 不计入 `bun test`，因为它需要
   `~/.tch-agent/config` 凭据并产生模型费用；reason-only 项目可合法通过
   `data.complete` 结束而不新增 Fact，所以 gate 固定走 bootstrap 路径。
5. **M3 硬拦截 gate**：`tools/gate/m3-gate.ts` 不调用模型、不产生费用。它直接用与 Solver
   相同的 Host Bridge 验证：in-scope 网络放行、out-of-scope/工作区外读取/未知工具拒绝、
   `audit.jsonl` 同时记录 allow 与 block、artifact 大小与 SHA-256、HTTP artifacts 路由，
   并报告 Docker 是否可用；设置 `CAIRN_GATE_DOCKER_IMAGE` 时额外做容器 ensure/mapPath/
   cleanup 烟测。Docker 不可用的宿主上该项标为 **SKIP（未验证）**，而不是通过；fake CLI
   单测只证明命令构造正确，不能替代真实容器集成。另有
   `tools/gate/m3-container-e2e.ts`：用 fake solver 真正经过 `execution: container` 跑完
   一个项目，验证两次 `docker exec`、bind mount 结果回传、容器清理与日志（Docker 29.9.2
   下 4/4 PASS）。`tools/gate/m3-real-container-gate.ts` 进一步用真实模型在真实容器内跑完
   bootstrap 项目：Fact 含宿主靶场 marker，授权网络动作记为 allow；随后在容器内直接执行
   Host Bridge 探针，确认 out-of-scope 端口被 block 且审计行带 project/task 身份；并用
   两个容器内长驻进程验证任务级 `pkill` 只杀目标、兄弟任务与容器存活。它同时覆盖只读
   配置挂载下“每任务可写副本”的实际路径（Docker 29.9.2 下 17/17 PASS，2026-10-25）。
6. **M4a conclude gate**：`tools/gate/m4-conclude-gate.ts`（计费）用真实模型跑一个
   bootstrap 任务，再用 scheduler 的 `prepareTask` 构造 conclude。它验证
   `SessionManager.open` 恢复的是同一 session id / 同一 JSONL，conclude 追加后条目数
   增长（19→21），且输出通过 `validateBootstrapConcludePayload`（10/10 PASS，2026-10-25）。
   排队与失败语义不依赖模型，由 `loop.test.ts` 的 `flaky-worker` fixture 覆盖。
7. **M4b 图切片**：不调用模型、不计费。`packages/graph/src/export.slice.test.ts` 用带
   provenance 与并行 open intent 的种子图验证切片内容、确定性、极小 caps 下的硬保留与
   `truncated` 标记；`loop.test.ts` 用 fake solver 跑完一个项目，断言开启后 explore 的
   `graph.yaml` 含 `slice:` 段而 reason 的仍是全图。因为默认关闭，既有导出 golden 与
   全图测试保持不变。
8. **M4c Observer**：确定性测试不调用模型、不计费。
   `cairn-observer/loop.test.ts` 注入 stub reviewer，验证周期 + `agent_end`/`flush`、
   串行队列、`max_reviews_per_task`、review 挂起时 flush 超时不抛、state 目录不可用时
   flush 不抛、并行工具事件不丢日志；`challenge-observer/observer-store.test.ts` 验证
   损坏队列条目被跳过；`scheduler/tasks.test.ts` 验证 context/env、`kernel_tasks` 过滤、
   facts/hints 截断与 focus intent 保留；`board-store.test.ts` 验证路径优先级；Host
   Bridge 测试验证只读看板工具与看板写保护。`tools/gate/m4c-observer-gate.ts`（计费）
   用真实模型验证完整链路：主 solver 只读看板、sidecar 执行 review 并更新看板、审计与
   flush 完成、最终 Fact 不变；2026-10-25 为 **14/14 PASS**。长任务成本、延迟与看板质量
   仍需更多实测。

## 4. 移植顺序

| 步骤 | 内容 | 完成标准 | 状态 |
| --- | --- | --- | --- |
| M1a | `db.ts` + `models.ts` + `services.ts` + YAML 导出 | 领域单测 + YAML golden 通过 | ✅ 2026-10-25 |
| M1b | 五个 router + 错误处理 + settings/export | API golden 全绿 | ✅ 2026-10-25 |
| M2a | config + prompting + 默认 prompts | prompt golden 全绿 | ✅ 2026-10-25 |
| M2b | scheduler + worker supervisor + `roles/worker.ts` + 宽容解析 | fake solver 端到端通过 | ✅ 2026-10-25 |
| M2c | vendor `packages/agent`，接真实 Solver | 真实项目产出 Fact | ✅ 2026-10-25 |
| M3 | 容器 runtime + Host Bridge + Scope 硬拦截 + artifacts | 越界拒绝 + 审计 + artifacts；真实 Docker 容器端到端 4/4；真实容器 + 真实模型 17/17 | ✅ 2026-10-25 |
| M4a | conclude 回退（独立任务 + 持久会话恢复） | 真实模型 gate 10/10；flaky-worker 调度测试 | ✅ 2026-10-25 |
| M4b | 可选图切片（explore / explore-conclude） | 切片导出单测 + scheduler/config 断言；默认关闭不改变全图 golden | ✅ 2026-10-25 |
| M4c | Observer：项目级看板、只读主 Solver、sidecar review、bounded flush | 配置/路径/loop/队列/Host Bridge 单测；`bun test` 187 passed；真实模型 gate 14/14 | ✅ 2026-10-25 |
| M4 | Observer | 完成（M4c）；长任务模型质量/成本仍需更多实测 | ✅ 2026-10-25 |

## 5. 不移植的东西

- `WorkerDriver` / registry / adapters / `WORKER_ENV_KEYS`；
- `tch` driver、`tch_bridge.py`、`solver rpc` 适配、overlay 文本补丁；
- FastAPI、uvicorn、pydantic、requests、docker-py：分别由 Bun HTTP、`Bun.serve`、手写校验/后续
  zod、`fetch`、Docker CLI 取代；
- 模板式的 worker 健康检查：合并后只剩一种执行器，做一次模型/凭据探测即可；
- 配置里的 `workers` 列表、按 worker 类型的 env 注入，以及 `resolve_mock_behavior`
  （mock 的随机行为由 M2b 的确定性 fake solver 取代，不再从配置读取）；
- BreachWeave 的 CLI/TUI 入口与 `solver rpc`：合并版 worker 直接调用
  `createSolverSession`；`runSolverCli` 等入口仅作为 vendor 库的一部分保留，未使用。

## 6. 已识别风险

| 风险 | 缓解 |
| --- | --- |
| PyYAML 与 JS YAML 库输出不一致 | 自写 block-style emitter；61 条标量 golden + 导出 golden 逐字对照。双引号长标量不折行，已记录为可接受偏离 |
| Python 线程模型 vs Bun 异步 | 先保持“每任务一个监督协程”的简单模型；并发上限显式配置 |
| Docker Python SDK vs CLI | 统一走 CLI，输出解析加测试；错误语义按退出码映射 |
| Windows 路径/信号差异 | 路径转换集中在 `runtime/paths.ts`；本地模式可在 Windows 开发/测试，生产隔离走容器；bind mount 用 `--mount type=bind` 避免盘符歧义 |
| Solver 库的日志污染 stdout | 结果写文件，stdout 仅诊断；worker 启动时接管 console |
| 模型凭据进入仓库/任务文件 | 凭据只在 `~/.tch-agent/config`；`models.json` 的自定义 provider 用环境变量名占位；task/result 不含凭据；检索与 code review 时检查 |
| 本地模式缺少 POSIX shell | Windows 上 `bash` 工具不可用，模型回退到跨平台文件工具；gate 已验证该路径；生产用容器（`Dockerfile.worker` 自带 shell 与 procps） |
| AGPL + Apache 混合 | 整体 AGPL-3.0；保留 BreachWeave 许可声明；分发时提供源码 |
