# 运行配置（M22 起；M24 扩展执行模式与统一设置入口）

dispatch.yaml 仍是配置的事实来源；M22 增加一层**运行期覆盖**，让不含部署信息的调度参数
可以在页头「设置 → 运行与执行」里改，并在下一个调度周期生效，不必重启进程。M24 把
`runtime.execution`（local / container）也纳入可编辑项（仅在调度器空闲时切换），并把
运行配置、模型密钥、本地偏好与服务端设置收进同一个「设置」弹窗。Observer 复盘在
M22 改为默认开启（`observer.enabled` 默认 `true`），提案自 M23 起默认 `enabled: true` +
`mode: dry_run`（完整校验并记录，不写图）。

## 用户提示：高优先级引导

项目页「添加提示」（现有 `POST /projects/{id}/hints`）新提交的内容作为用户引导，而非普通模型备注：

- **上下文优先**：所有 `pending` 用户引导，加上最近四条 `planned` 引导，以单独的「用户引导（优先处理）」段进入后续 bootstrap/reason/explore/conclude 的提示词前部。用户内容在模板渲染完成后按 JSON 插入，字面量占位符不会被二次替换。
- **调度优先**：待规划引导触发紧急 `operator_guidance` reason 回合，不受普通 hint 增量阈值、冷却期与每小时策略回合上限限制。已有任务自然结束后优先规划；等待期间不继续填充新的 explore，避免旧路线把引导饿死。既有失败收尾 conclude 仍优先。
- **边界不变**：仍受失败退避、Scope、项目状态、预算、工作槽位与完成验证限制；不抢占当前任务、不绕过其他控制面的 task claims、不自动恢复 stopped/completed 项目。初始 bootstrap 仍保持原有优先级，并同样接收用户引导。
- **可见状态**：`GET /projects/{id}` 的相关 hint 增加可选 `operator_guidance: "pending" | "planned"`。`planned` 仅表示内容被包含在成功结束的 reason 任务输入中，不证明模型遵从、动作已执行或目标已验证。失败、拒绝、取消及派发失败均不确认提示。reason 运行期间到达的新提示保留 pending，在后续回合处理，即使两条提示时间相同也不会被误吞。
- **可追溯来源**：来源由控制面在创建 hint 的同一事务中写入 `operator_hint_meta` sidecar，不能靠填写 `creator: "operator"` 获得优先级；显示姓名不变。历史提示、初始化/导入的普通 hints 和模型自产备注不按 creator 猜测回填。该标记表示入口来源，不是身份认证；既有无认证 API 仍须依赖部署层访问控制。
- **压缩不丢引导**：引导段同时用于 legacy/shadow/apply 的实际提示词，计入 ContextPlan/ContextPack 首次输入字节。待规划引导不会因普通 hints 数量上限被截掉；若必选内容超预算，按既有规则回退并报告超限，而非悄悄删提示。Observer 在原有十条 hint 上限内优先选择用户引导。

新提示是策略引导，不是事实或完成证据，也不能修改任务协议、凭据规则或授权范围。相同事项优先参考较新提示；不同且兼容的要求仍保留。实际执行仍由模型产生计划并由控制面校验，不能把「已纳入规划」当成必然服从的承诺。

## 环境故障与解题结果分流

运行记录仍保留兼容的 `outcome`，另通过可选 `failure: {domain, code}` 标明控制面分类：

- `infrastructure`：模型连接、认证、限流、模型超时/服务异常，以及 worker 启动失败、执行环境不可用。
- `execution`：任务硬截止、租约丢失、结果缺失/格式错误、证据或应用阶段异常等。它说明任务没有正常完成，并不证明某个目标假设错误。
- 不受影响及历史 run 不增加 `failure` 字段；不会根据历史自由文本猜测回填。实验的有效负面观察仍须走正常结果与证据校验，不能由进程失败代替。

分类写入 operational sidecar，不写成目标 Fact。typed operational failure 不计入路线尝试次数、失败 delta、零产出连续计数，也不能单独授权 reason 自动放弃方向。worker profile 的自动选择样本排除 infrastructure failure，但只读运行统计、预算与成本仍保留全部实际消耗。

### 项目级退避与暂停派发

环境故障持久化在 `infrastructure_faults`，仅影响该项目的**新派发**，覆盖 bootstrap/reason/explore/conclude、用户引导和人工 replan；不会强制中断已运行任务，也不更改项目的 active/stopped 状态。

| 连续环境失败 | 普通连接/模型/运行时故障 | 限流 |
| --- | --- | --- |
| 第一次 | 退避 30 秒 | 退避 60 秒 |
| 第二次 | 退避 60 秒 | 退避 120 秒 |
| 第三次 | 暂停新任务派发（blocked） | 暂停新任务派发（blocked） |

认证错误第一次即 blocked。计数跨环境故障类型累积。退避到期后只放行该项目内一个恢复探测任务（仍受预算、Scope、claims 等约束），并非宣告服务恢复。只有观察到当前这次 backoff 的任务成功，才能清除此故障；较早并行任务的晚到成功不能清除新故障，成功也不能自动解除 blocked。

退避/blocked 跨控制面重启保留。添加提示、人工 replan 或重复 PUT active 均不能绕过。若环境故障状态落库失败，本控制面另行暂停该项目派发直至控制面重启，日志会明确报告；这不是普通退避的恢复路径。

### 收尾与恢复

- 仅在 worker 非正常退出且最新受限会话事件明确报告模型故障时按模型环境错误分流；不把任意工具输出中的“401 / Connection error”当模型故障。控制面取消、租约丢失和硬截止判定优先。
- 完整有界会话确认只有模型错误、没有可保留工作时，释放任务租约，不额外调用 conclude。存在工具结果/实质输出，或历史不完整而无法确认时，保守保留待收尾会话；这只是成果抢救线索，不是验证过的事实。
- conclude 自身遇到环境故障时，保留原 pending conclude 和探索会话，恢复后再收尾，不把此次环境错误当“收尾已完成”。
- reason 环境失败不写普通策略失败退避、不吞人工重规划请求，也不确认待规划用户引导。

前端项目页显示「环境故障 · 等待退避重试」或「环境故障 · 新任务派发已暂停」，运行卡片区分「环境故障（非解题失败）」与「任务执行异常（非假设反证）」。只读 `GET /projects/{id}` 在有状态时附加 `infrastructure_fault`；`GET /projects/{id}/runs` 附加相应 run 分类。诊断只包含固定安全消息，不回传提供商原始错误或凭据。

blocked 后的恢复流程：**停止项目 → 修复模型/代理/运行时配置 → 必要时重启服务 → 恢复运行**。复用既有 `PUT /projects/{id}/status`，仅真正的 `stopped → active` 转换重置故障；停止动作本身不重置，completed 项目仍不能从此接口恢复。没有新增未认证写路由，既有部署层访问控制要求不变。恢复只允许重试，不代表连通性已验证；部署配置变更仍需重启服务，不会因恢复项目而热加载。

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
| POST | `/settings/runtime/test` | 探测 `{"execution": "local"\|"container"}` 是否可用，返回逐项检查 |
| DELETE | `/settings/runtime` | 清空覆盖并返回视图 |

- `defaults` 是只取 dispatch.yaml 的值；`editable` 是调度器当前使用的值；二者形状相同。
- `overrides` 是排好序的点路径叶子列表（`tasks.graph_slice.enabled`），数组算一个叶子
  （`proposals.allow_kinds`），供 UI 打「已覆盖」标记。
- 请求体上限 64 KiB；空请求体视为 `{}`；非法 JSON 400。
- 配置了 `CAIRN_OPERATOR_TOKEN` 时写路由要求 `X-Cairn-Operator-Token`，并拒绝跨源
  `Origin`（与 `/settings/agent` 写路由一致）。GET 免 token。
- 没有 `--config` 的纯 HTTP 模式没有可变配置，这些方法都返回 409。
- 校验失败返回 400 + 具体字段路径；运行中的配置不受影响。

```bash
curl -X PUT http://127.0.0.1:8000/settings/runtime \
  -H 'Content-Type: application/json' \
  -d '{"runtime":{"interval":5},"tasks":{"graph_slice":{"enabled":true}}}'
```

### 技能（M25）

「设置 → 技能」使用另一组路由，守卫与 `/settings/agent` 写路由相同：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings/agent/skills` | `{prompt, promptFound, enabledCount, skills}`；每次 GET 幂等补齐内置技能文件，再读 `cairn-worker` 白名单 |
| POST | `/settings/agent/skills` | 请求体 `{name, description, content, enabled?}`；`enabled` 默认 true，创建后立即追加白名单 |
| DELETE | `/settings/agent/skills/{name}` | 删除目录并从白名单移除；内置技能会把顶层目录名记进 `.deleted-builtins.json` |
| POST | `/settings/agent/skills/{name}/restore` | 仅内置技能：清除删除记录并回填文件，不自动启用；非内置 404，未删除仍存在 409 |
| PUT | `/settings/agent/skills/{name}/enabled` | 请求体 `{enabled}`，只改 `cairn-worker` prompt 的 `meta.skills` |
| GET | `/settings/agent/skills/{name}/files` | 只读文件树 `{directory, files:[{path,size}], truncated}`；`SKILL.md` 永远排第一，其余按路径排序 |
| GET | `/settings/agent/skills/{name}/file?path=` | 只读单文件 `{path, size, content, truncated, binary}`；`path` 必填，越界/目录/软链接 400，未知技能或文件 404 |

- 技能文件存在不等于生效：`buildResourceLoader` 只加载 prompt 白名单里的名字。内置 17 个，
  `cairn-worker` 默认引用其中 12 个；其余 5 个可在页签里「启用」。
- 浏览只走 GET：列表最多 200 个文件、递归深度 8、单文件读 256 KiB 前缀，超限分别置
  `truncated`；含 NUL 的内容标记 `binary` 且不回传正文。路径逐段拒绝空段、`.`、`..`、
  超长段与 `\/:*?"<>|` 及控制字符，再做词法 + realpath 双重包含检查，软链接一律拒绝。
- 名字须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 且 ≤64 字符，并与目录名一致；删除/启停按目录名
  另做 `[A-Za-z0-9][A-Za-z0-9._-]*` 校验，`..` 等越界标识返回 400。
- 删除内置只写删除记录并移除文件，重启或再次打开页签都不会回填；「恢复」只回填文件。
- 请求体上限 512 KiB；描述必须单行且 ≤1024 字符，正文非空且 ≤96 KiB。

## 3. 可编辑字段

值的类型与约束由 `parseDispatchConfig` 最终判定；下表列出常用范围与默认值。

### 调度 `runtime`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `execution` | local | 全局默认：`local` / `container`；只在调度器空闲时切换。已在创建时指定执行环境的项目不受该设置影响（见下） |
| `max_workers` | 3 | 全局并发任务上限，正整数 |
| `max_running_projects` | 2 | 同时调度的项目数，正整数 |
| `max_project_workers` | 1 | 单项目并发任务，正整数且 ≤ `max_workers` |
| `interval` | 3 | 调度 tick 秒数，正整数；改动会重挂定时器 |
| `strategy_context` | on | M36：写 `agent-context.yaml` 并在 reason/explore 提示里引用；`off` 回到 M36 之前的行为（只读项） |

### 题目的执行环境

新建题目可选择「本地进程」「Docker 容器」或「跟随全局默认设置」。API 创建请求可选
`execution: "local" | "container"`；显式选择保存在 `project_execution` 中，之后修改全局
`runtime.execution` 不改变它。旧项目、旧客户端和未选择时跟随全局默认；复制题目保留源项目
的显式选择。所有项目共享现有的工作区根目录与调度并发上限。

Docker 模式需要本机 Docker 和镜像；创建时不启动容器，派发时不可用则跳过并记录日志，
不会自动改用本地进程。若 dispatch.yaml 未配置 `container`，使用 `cairn-worker:latest`、
`bridge` 和 `remove` 的默认值；本地模式不提供容器隔离。无调度器时可以保存选择，但不会派发。
容器的实时审计流必须明确配置容器可访问的 `audit_stream.url`；否则仍在任务结束时导入审计文件。

### 本地与容器的 worker 环境变量

`common_env` 只放两种模式共用的值；`local.env` 和 `container.env` 是可选的字符串映射，
分别只传给对应模式的 worker。三者都是部署配置，修改 YAML 后需要重启服务，不能通过运行期
覆盖接口写入；环境值不写入 `task.json`，不要在 YAML 中放密钥。

```yaml
common_env:
  CAIRN_SOLVER: "breachweave"
local:
  completed_action: keep
  env:
    HTTPS_PROXY: "http://127.0.0.1:18899"
container:
  image: "cairn-worker:latest"
  network_mode: bridge
  completed_action: remove
  env:
    HTTPS_PROXY: "http://host.docker.internal:18899"
```

地址仅为已有代理的示例，不会自动启动代理或重写地址。`host.docker.internal` 面向容器访问
宿主机，不能假定本地 worker 使用它也可达；容器内的 `127.0.0.1` 则指向容器自身。
不需要代理时可不配置；若要清除已继承的代理，用空字符串显式覆盖相应变量，注意大小写变体。

合并优先级（从低到高）：

- 本地：控制面环境 → `common_env` → `local.env` → 调度器计算的任务变量。
- 容器：`common_env` → `container.env` → 调度器计算的任务变量；不整体继承控制面环境，
  原有 `CAIRN_SOLVER` 单键回退仍保留。配置目录最终固定为只读挂载点 `/cairn/agent-config`。
- 容器宿主配置目录从 `container.env.CAIRN_AGENT_CONFIG_DIR`、`common_env`、控制面环境、
  默认目录依次选择；`local.env` 不影响容器挂载。

项目显式选择的执行模式决定使用哪一组 env，不受全局默认模式影响。未配置新字段时保持原行为。
此设置不改变 Host Bridge Scope、Docker 网络隔离、审计 token 传递或完成校验规则。

### 执行模式切换

`PUT /settings/runtime` 接受 `{"runtime":{"execution":"container"}}`（或反向切回
`local`）。`RuntimeConfigStore` 在解析成功后、写入活配置前调用 `validateNext`：

- 切到 `container` 时先检查本机 `docker`；不可用返回 400 并说明原因。
- 调度器有任务在跑时返回 400（“wait for running tasks to finish…”）；正在切换时同样拒绝，
  避免并发替换后端。
- 校验通过后，`Scheduler.reconfigure()` 在空闲时切换全局默认后端；已创建的本地与容器
  后端按需保留，以便显式选择各自环境的项目继续使用。进入容器模式时，控制面先把内置
  prompts / skills 播种到宿主 agent 配置目录（容器内只读挂载）。
- dispatch.yaml 没有 `container:` 段也能切过去：校验时补上 `cairn-worker:latest` /
  `bridge` / `remove` 三个默认值，但这些默认值**不写入覆盖 patch**，之后改 YAML 仍然生效。
- 容器本身的 image / network_mode / worker_argv、挂载与凭据仍是只读项。

### 测试执行环境

「设置 → 运行与执行 → 执行环境」旁的「测试有效性」按钮调用
`POST /settings/runtime/test`，请求体 `{"execution":"local"|"container"}`，响应形如：

```json
{"execution":"container","ok":true,"checks":[{"id":"docker","label":"Docker 守护进程","ok":true,"detail":"29.9.2"}]}
```

- `local`：检查 Bun 可执行文件能否报出版本，并在工作区根目录写一个临时文件后删除。
- `container`：检查 Docker 守护进程、`container.image`（缺省 `cairn-worker:latest`）
  是否存在，再用 `docker run --rm --network none <image> bun --version` 试启动一次；
  前一步失败就停止，镜像缺失时 `detail` 给出 `docker build` 命令。
- 探测的是请求里选的模式，而不是当前运行的模式，所以可以在保存前验证；探测不会修改配置。
- 守卫与 `PUT` 相同（operator token / 同源）；无 `--config` 时 409，执行模式参数非法 400。
  `ok` 表示所有检查项都通过，失败项逐条返回，UI 内联展示。

### 任务 `tasks`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `bootstrap.timeout` / `bootstrap.conclude_timeout` | 600 / 90 | 秒；M42 把示例从 300 提到 600（旧 demo 为 120），软截止按 0.8 为 480 |
| `reason.timeout` / `reason.max_intents` | 300 / 2 | 秒；单次 reason 新增意图上限 |
| `explore.timeout` / `explore.conclude_timeout` | 600 / 120 | 秒 |
| `graph_slice.enabled` | true | explore 及其 conclude 是否拿切片；`false` 回到全图导出 |
| `graph_slice.max_facts` / `graph_slice.max_intents` | 80 / 60 | 软上限；`max_facts ≥ 2` |
| `evidence.min_bytes` | 1 | 0 表示接受空证据 |
| `tool_result_spill.enabled` / `.max_inline_chars` | true / 32000 | M43：工具结果序列化后超过 `max_inline_chars` 字符就落盘 `<workspace>/.tool-results/<毫秒>-<工具>-<调用id>.md`，上下文里换成「绝对路径 + 工作区相对路径 + 600 字符预览 + 先 grep 再分片读」的指针。`max_inline_chars` 必须为正整数（1 也合法，等于全部外置）；`enabled: false` 回到全量内联。solver 与 subagent 共用同一份开关和同一个工作区，指针因此总是绝对路径在前。溢出文件不进 `project_artifacts` 索引，但 `/flag` 的兜底扫描把它算作取证来源 |
| `context_plan.mode` | audit | M47：`off` / `audit`；生成任务级 `context-plan.json`。审计不改变输入、不阻断派发；没有 `enforce` 模式 |
| `context_plan.max_initial_bytes` | 131072 | 正整数；Solver 提示词 + 必读文件的 UTF-8 字节审计阈值，严格大于才告警；不是项目 token 配额或模型窗口 |
| `context_pack.mode` | off | M48：`off` / `shadow` / `apply`；仅新 default reason/explore。shadow 不改变实际输入，apply 成功时改用 ContextPack，否则回退 legacy |
| `checkpoint.enabled` | false | M49：同任务文件检查点与 SQLite 结构化尝试记忆；不新增模型调用；复用需要 M48 成功 apply |
| `checkpoint.interval_seconds` | 5 | 整数 1–60；worker 重发和控制面接收间隔，不保证最后一个动作已保存 |
| `context_pack.shard_max_bytes` | 8192 | 整数 1024–65536；恢复记录分片、索引页、目录及描述符的最终字节上限，不是会话总上限 |

`context_plan` 的两个键可经现有 `/settings/runtime` 覆盖与重置，下一次任务准备生效（本阶段
不加弹窗控件）。文件在 `<workspace>/.cairn/sessions/<task-id>/context-plan.json`，不进入
WorkerTask、prompt 或环境；与 session 一起保留/回收。`off` 不做诊断读写或记录相关日志。
读写审计失败只记固定 `unavailable` 并继续派发；普通 task/graph 写失败仍按原语义失败。

账单分别显示 Solver 与 Observer 的 `prompt_bytes` / `required_file_bytes` /
`required_initial_bytes` / `optional_known_bytes`。附件正文按账本声明大小列为可选（清单文字
已计入提示词），Observer 看板、恢复会话历史未知则保留 `null`；恢复 conclude 不能只统计新
提示词后宣称全会话很小。默认 token 估算为 `null`，不猜 tokenizer，也不调用计数 API。
选择器元数据缺失时 `status: incomplete`，不伪造截断数量；审计范围不含 SDK system/tools、
未来工具结果或真实窗口占用。完整字段与恢复说明见 [DESIGN §16](DESIGN.md#16-m47contextplan-v1已实现)。

### ContextPack（M48）

`context_pack` 两个键支持既有运行配置覆盖/重放/重置，下一任务生效，没有新增 UI 控件或 API 路由。
shadow/apply 要求 `runtime.strategy_context: on` 且 `tasks.context_plan.mode: audit`；不符合时配置拒绝，
不会偷偷重开功能。关闭审计前需在同一 override 中关闭 pack；既有运行配置 API 是**替换整份 override**，
不是累积 patch。

apply 共享 `max_initial_bytes`，限制最终 task.prompt + 首次必读 ContextPack 的 UTF-8 字节。
核心状态、目标条件/审核/资源预算与 explore 直接依赖不能裁剪；核心超限、无净收益或快照写失败时
回退原始输入并记录固定原因，任务仍可派发。成功 apply 必须在预算内且比 legacy 更小；不保证回退任务
也在阈值内。不把该阈值当作 SDK 窗口或费用限制，solver 的 scope/evidence 前缀和后续工具读取仍未计入。

成功 apply 的 ContextPlan 为 v2，必读源是 prompt/context_pack，旧 graph/investigation_state 与恢复目录
是 optional；未 apply 的任务保持 v1。shadow 的候选指标另在 `context-candidate.json`，不能冒充实际账单。
pack/store 在 session 中保留回收，不进入 WorkerTask 或证据账本；恢复资料是同次事务中的完整授权投影，
原始日志/凭据/附件和证据正文不采集，旧 500 字符 detail 边界仍保留为 `control_plane_only`。
bootstrap、conclude/已有会话及非 default 模板保持 legacy；`graph_slice` 仍控制兼容图/回退路径，不决定恢复库内容。
图切片自 M55 起默认开启，explore 的 legacy 输入本来就只含意图邻域，pack 往往因「无净收益」回退——这是
两套压缩在同一个预算下比较的结果，不是故障；需要 pack 生效时把 `graph_slice.enabled` 设为 `false` 再评估。
Observer 输入不变。完整选择/分片/失败规则见 [DESIGN §17](DESIGN.md#17-m48contextpack-v1已实现)。

### TaskCheckpoint（M49）

```yaml
tasks:
  checkpoint:
    enabled: true
    interval_seconds: 5
  # 若要自动把已结束尝试记忆交给后续新 default reason/explore：
  context_pack: {mode: apply, shard_max_bytes: 8192}
  context_plan: {mode: audit, max_initial_bytes: 131072}
runtime:
  strategy_context: on
```

`checkpoint` 可独立开启用于采集，不强制开启 pack。文件位于本任务 session 的 `checkpoint.json`；
原子发布、周期接收、退出前后尽力补接，最后有效版本落 `task_checkpoints`，删除 session 不删除记忆。
模型通过 `save_task_checkpoint` 完整替换累计进度；最多 65536 UTF-8 字节、32 个唯一 attempt，
非法新版本不覆盖旧版本。工具与已有 Host Bridge/调用预算兼容，只有主 solver 注册，不给 subagent 并发写权限。

复用只在成功 apply 的 M48 输入中发生，`attempts.memory` 是 worker 未验证声明，不是 Fact、证据验证
或执行授权；整体纳入原字节预算和恢复分片。pack off/fallback、bootstrap/conclude、自定义模板不会偷偷
多读一份完整历史文件。Scope/意图/事实替代链/证据存在性重新标注，使用本次 core 的当前预算，
旧 next_steps 不会自动执行。运行中检查点持久化不等于实时交给其他并行任务。

两个键支持现有运行配置覆盖、重放和重置，下一任务生效；已运行任务沿用派发时的采集开关和间隔。
检查点文件权限为 `0600`；Linux 容器/宿主 UID 不同的环境需在部署层保证控制面可读，不可读时记忆接收
不可用但原任务照常结束。本次未放宽文件权限、未运行真实 Docker 跨 UID gate。
没有新增 UI 控件、HTTP 写入接口、WorkerTask 字段或 SDK 恢复策略。完整边界见 DESIGN §18 与 CONTRACT §9。

### 可验证探索（M51a–d）

不新增配置项，也不默认开启 checkpoint 或 ContextPack。reason 新 intent 的可选 `experiment`
按 [CONTRACT §3.1](CONTRACT.md#31-reason-意图的可选探索契约m51a) 校验，存入元数据；
旧意图不要求补造。focused explore / explore conclude 的提示词直接带上该计划数据，即便 checkpoint
关闭也不影响原解题流程；reason 通过启用的 AgentContext / M48 输入读取已有计划。契约不扩展 Scope、调用预算或完成 oracle 权限。

开启上面的 checkpoint + 成功 apply 后，`attempts.memory.experiment_result` 是原检查点的只读索引，
观察与解释分开引用、运行故障独立标注；文件可用不等于证据有效，假设判决始终 unknown。
只有错误/解释、缺少检查点或执行不完整都不会变成路线反证。该索引与完整原记忆一起纳入 M48
预算与恢复分片，不增加第二套存储、模型判断调用或新的必读历史文件。
M51c 的 reason 新方向可附 `experiment_review`（继续验证／调整方向／需要新观察），必须同时带新契约。
只有成功 apply 的 reason 上下文恢复库提供来源授权；应用结果时重新核对当前计划、Scope、事实、
检查点版本和证据可用性。结果驱动选择还要求正常成功结束、无权威运行故障、控制面派发计划绑定一致。
旧无绑定检查点不回填；可用 `need_observation` 明确报告缺观察，但仍须当前授权来源。普通旧式无 review
规划不受这个新增来源协议限制；不把来源检查描述成对所有自然语言策略的验证。

M51d 在意图详情只读显示契约、观察与解释、运行异常、后续方向及精确引用；选择意图时加载，可手动刷新。
只读接口 `GET /projects/{project_id}/intents/{intent_id}/experiment` 每类最多返回 10 条记录并提示省略数量。
`bun run eval:experiments --out runs/experiment-eval.json` 运行确定性来源/安全评估，0 模型调用；
不测真实探索成功率、推理质量或费用收益。没有自动反证/退役、新 UI 编辑器或 M52 重复抑制。

### 重复探索与进展记录（M52a/b，只读）

a/b 本身不新增配置项、阈值或数据库计数器，也不改变 checkpoint 默认关闭与 ContextPack 默认 off。
显式 checkpoint-enriched snapshot 中，有合法 experiment 的意图附带可选 `exploration`：精确计划/
提案指纹、已有同计划记录的有限 ID 列表、观察报告分类和连续未新增观察报告次数。结束 run 可带
对应 `attempts[].exploration`。历史由现有 runs 与最后有效检查点重建，重启不丢计数。

自动交付仅沿用成功 apply 的 M48 输入，完整字段纳入原字节预算及授权恢复分片；只有存在该投影时
才为 compact prompt 追加解释。off/shadow/fallback 不新增必读历史；预算装不下整条必保留记录时回退，
不截断计划或计数。已有只读 experiment GET 也返回可选投影，无工作区或证据不可用时不猜测有效观察。

`new_observation` 仅指可比较历史中的新报告，不表示新 Fact、证据内容改变或真实信息增益；只有换描述、
解释、文件名、attempt ID 或 sequence 不产生新观察。环境/执行/工具故障不增加计数，未知记录中断连续性。
合理复验仍可继续；a/b 只读投影本身不调整优先级、派发、冷却、重试、预算或生命周期，不自动反证或完成项目。
具体指纹与状态边界见 DESIGN §20 / CONTRACT §9.2。可选 c 与只读 d 见下一节。

### 有界排序软偏好与只读进展（M52c/d）

```yaml
tasks:
  exploration_suppression:
    enabled: false  # 默认关闭；仅允许布尔 enabled，不开放阈值/窗口/penalty 调整
```

显式 true 时，对当前同计划、连续 3 次可比较任务未新增观察报告的方向，最多软降权 20、最低有效优先级 0。
窗口从首次跨阈值的结束时刻起 300 秒；继续重复/改名不会滚动续期，到期恢复基础优先级。
仅影响 explore 候选排序，不写回 priority，不排除候选，唯一候选仍可执行；不自动 reason/放弃/退役/完成。
新报告/unknown 中断并重置资格；故障跳过，最新故障/unknown 时不降权。
新非 origin/goal Fact 或任何 Hint 的最近创建时间独立重置资格，只有开始时间严格在其后的任务才重新累计。
当前计划/Scope/事实/证据、run 或输入时间不可比较时不降权；不是全局目标进展或科学信息增益测量。

开关支持既有运行配置热覆盖/验证/持久化重放/reset，下一次调度选择生效；false 立即恢复基础排序，
不撤销已运行任务。环境门、pending conclude、reason/用户引导、预算、claim 与 Scope 顺序不变。
可选历史读取异常回基础排序。已有有效检查点可供控制面排序，不要求当前 checkpoint enabled 或 M48 apply；
无历史则不降权，新采集仍需 checkpoint 开关。模型历史交付仍仅沿用 M48 成功 apply，不能绕过预算/恢复授权。

意图详情新增六类报告计数、连续次数（0 与未知分开）、最新 run、同计划/提案 peer、指纹与原因，以及
基础→有效优先级、到期和“读取时排序预览（不是派发授权）”。复用既有只读 experiment GET，刷新重新计算，
不新增未认证写路由或状态控件。`bun run eval:exploration --out runs/exploration-eval.json` 运行 17 个
确定性场景、0 模型调用，只测安全与排序边界，不证明真实停滞减少或成本收益。

### Worker `worker` / `worker_selection`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `worker.reasoning` | reason | `off` / `reason` / `all`：哪些任务让模型先推理 |
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

`worker.reasoning` 决定派发时写入 `task.json` 的 `reasoning: "on" | "off"`：默认的 `reason`
只给决定「下一步探索什么」的 reason 任务开启，bootstrap / explore / conclude 关闭；`off`
全部关闭，`all` 全部开启（M55 之前的旧行为，需显式配置）。关闭时 worker 对 OpenAI 兼容端点
发 `reasoning_effort: none`，开启时按 model-prefs.json 的 `thinkingLevel`（未配置则
`minimal`）；token 预算型端点（Anthropic 风格）关闭即不发送思考级别。该字段可由运行时配置
热覆盖，下一个任务生效，不需要重启调度器。

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
| `off_completion` | manual | `verification: off` 项目的完成声明是否需要操作员确认。`manual` 写一条 `completion_reviews` pending 并保持项目 active，由项目页「完成确认」或 `POST /projects/{id}/completion-review/{review_id}/decision` 决定；`auto` 保留旧的“模型说完成就关闭”行为，只用于不需要人工的沙盒。只读项，需改 dispatch.yaml 并重启 |
| `evidence_completion` | manual | 只有 `evidence` 条件（没有 `challenge` / `flag_count` 客观条件）的项目在 oracle 通过后是否自动完成。`manual` 写一条 `completion_reviews` pending 并保持 active；`auto` 保留 M41 之前的自动完成路径，只用于不需要人工的实验项目。客观条件齐全的项目不受此键影响。只读项，需改 dispatch.yaml 并重启 |
| `flag_review` | manual | `manual` 把抓到 flag 形状的值登记为后台复核（派发不暂停，完成声明等判定；操作员判定真·还有更多 / 真·停止 / 假·继续探索）；`off` 关闭复核。运行配置弹窗的「Flag 人工复核」开关直接切换这两个值，默认打开。与 M32 的两档不同，M34 的拒绝不看这个键：`manual` 与 `off` 下，完成声明只要引用了本项目已被判为 `fake` 的值就会被拒（reason 释放租约继续跑，并写一条去重 Hint），因为判过的值不再入队、等判定的 hold 会随判定消失 |

### 范围 `scope`（M33）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `ssrf_markers` | observe | Host Bridge 对「携带目标」的处置方式。携带目标 = 连接目的本身已授权，但请求里又写了另一个主机字面量（URL 查询串 / 表单体 / `--data` / 载荷文件），只有接收方服务器会去解析它。`observe` 让命令照常执行，另写一条 `ssrf_candidate` 审计行；`block` 直接拒绝越界的携带目标；`off` 完全忽略携带目标——相对 M33 之前是放宽（旧版把这些字面量当连接目的检查），只在确认误报阻碍工作时使用。运行配置弹窗的「SSRF 标记」下拉切换三者 |
| `protected_hosts` | 空 | 本部署自身设施的主机名，必须是不带 scheme、端口、路径的裸主机名。硬底线 = 链路本地 `169.254.0.0/16` + `metadata.google.internal` / `metadata.goog` + 这份名单 + `server`、`audit_stream.url` 里的**命名**主机（IP 字面量排除：本机 `127.0.0.1` 通常同时是靶机，把它列为受保护只会让任务做不下去）。硬底线在 `observe` 与 `block` 下都拒绝，只有 `off` 会把它一起关掉 |

`protected_hosts` 是部署身份而不是旋钮，因此不进运行期覆盖白名单；判定与审计细节见
ARCHITECTURE 的 Host Bridge 一节。

### 预算 `budget`

`max_project_tokens`、`max_project_cost_usd`、`max_project_tasks` 默认都是 0（不限制）。
0 的 `max_project_tasks` 回退到 `runtime.max_project_workers`。预算按项目独立计算。

### 策略触发 `strategist`

`min_new_facts`、`min_new_hints`、`cooldown_seconds`、`failure_backoff_seconds`、
`max_runs_per_hour`、`zero_output_threshold`、`stale_intent_seconds`、
`fallback_interval_seconds` 为非负整数，`resource_pressure_ratio` 为 0–1。0 表示关闭对应
的触发器或上限；initial 与“没有未结束意图”是 urgent 触发，不受冷却与小时上限限制。

`reason_abandon`（M37，`off` / `on`，默认 `off`）允许 reason 在结果里用 `abandon`
每轮放弃至多一个已经失败过的 open 意图；操作员通过
`POST /projects/{id}/intents/{intent_id}/abandon` 放弃不受该开关影响。它只能改
dispatch.yaml，不在运行期可编辑视图里。

### 提案 `proposals`

`enabled`（默认 true）、`mode`（默认 `dry_run`；`off` / `dry_run` / `apply`）、
`max_per_task`（20）、`max_file_bytes`（16384）、`max_total_bytes`（65536）、
`allow_kinds`（`fact`/`intent`/`hint`）、`require_evidence_for_fact`（true）、
`min_confidence`（0–1，默认 0）。提案仍需 Observer 开启、任务 kind 命中
`observer.kernel_tasks` 且 `enabled` 为真；默认 `dry_run` 只把审核流水写进 `proposals`
表，需显式改成 `apply` 才写图。

## 4. 生效时机

| 字段 | 生效点 |
| --- | --- |
| 并发、超时、切片、证据门、预算、策略阈值、提案、选择策略 | 下一个调度 tick / 下一次任务准备 |
| `runtime.interval`、`retention.sweep_interval_seconds` | `Scheduler.reconfigure()` 重挂定时器 |
| `verification.evidence_enforcement` | 下一次 `VerificationService.defaultKind` 读取（getter） |
| `verification.flag_review` | 下一个任务结果落图时的复核登记与完成门禁（派发不停） |
| `verification.off_completion` | 重启；`off` 项目的完成声明在任务结果落图时直接走人工确认或自动完成 |
| `verification.evidence_completion` | 重启；仅有 `evidence` 条件的完成声明在 oracle 通过后走人工确认或自动完成 |
| `scope.ssrf_markers` | 下一次任务准备的 worker 环境（`CAIRN_SSRF_POLICY` 折进 `CAIRN_SCOPE_POLICY`）；已启动的 worker 沿用注入时的模式 |
| `tasks.tool_result_spill` | 下一次任务派发的 worker 环境（`CAIRN_TOOL_SPILL_ENABLED` / `CAIRN_TOOL_SPILL_MAX_CHARS`）；已启动的 worker 与其 subagent 沿用注入时的值。关闭只影响新会话是否注册溢出扩展，不删已落盘的 `.tool-results/` |
| `tasks.context_plan` | 下一次任务准备的控制面审计；不改变 worker 输入，关闭不删除既有清单，超限也不阻断 |
| `tasks.checkpoint` | 下一任务的检查点采集与尝试记忆复用开关/间隔；已运行任务保持派发设置 |
| `tasks.context_pack` | 下一次新 default reason/explore 的选择模式与恢复分片；默认 off，成功 apply 改变首次输入，失败回退；不改已有会话 |
| `worker.*` | 下一次 `prepareTask`；运行中的任务沿用已经写好的 `task.json` |

正在运行的任务不会被改写或中断；新配置只影响之后的派发。

## 5. 只读项

以下内容涉及进程、网络或凭据布局，仍须改 dispatch.yaml 并重启。弹窗的灰色只读区只做
展示：

- `server`
- `runtime.prompt_group`、`runtime.healthcheck_timeout`、`runtime.worker_healthcheck`、
  `runtime.strategy_context`
- `common_env`（只显示键名，不显示值）
- container / local 的 `workspace_root` 与 `completed_action`
- container 的 `image` / `network_mode` / `worker_argv` / `cap_add`
- `observer`（`enabled`、`model`、节奏、`kernel_tasks`）
- `audit_stream`
- `scope.protected_hosts`（部署自身设施名单，只在 yaml 配置；弹窗只读区不展示，模式本身可切）
- `worker_profiles`
- `verification.off_completion`（关闭完成校验时的人工确认策略）
- `verification.evidence_completion`（仅有证据条件时的人工确认策略）
- `verification.challenge` 的环境变量名与超时

## 6. 前端行为

- 页头两个工具条各有一个齿轮按钮，打开 `data-modal="settings"` 弹窗；Esc / 背景 / 关闭
  按钮走统一的模态栈，任一写入（运行配置、模型配置、技能、服务端设置）进行中都不允许关闭。
- 弹窗有五个页签：运行与执行、模型与密钥、技能、本地偏好、服务端设置；切换页签时按需加载
  （运行配置只在首次打开时拉取，保留未保存的编辑；模型配置与技能配置只加载一次，保存后刷新）。
- 技能页签列出内置/自定义、已启用/未启用与已删除技能，行内启停、删除（内置先说明跨重启并
  提供恢复）与恢复；新增表单提交 `{name, description, content, enabled}`，与 API 同构地
  校验名称、单行描述与正文。
- 「预览」打开 `data-modal="skillDetail"` 详情弹窗（叠在设置弹窗之上，Esc 仍只关最上层）：
  左侧由 `skillDetailTree()` 把扁平路径还原成目录 + 文件两级视图并显示大小，右侧
  `<pre>` 原样渲染正文；打开即自动预览排序后的第一个文件。已删除的内置没有文件，行内
  不出现「预览」；启停按钮在详情头部，成功后按最新列表刷新徽标；启停写入期间不允许关闭。
- 运行配置字段按「执行环境 / 调度 / 任务超时 / 图切片与校验 / SSRF 标记 / Worker 与选择 /
  保留与预算 / 策略触发 / 提案」分组；数字、开关、下拉与多选（`allow_kinds`）四种控件。执行环境组放
  local / container 下拉与「测试有效性」按钮；测试结果在组内逐项列出（✓/✗ + 说明），
  切换执行模式后清空旧结果，写入进行中时按钮禁用。「图切片与校验」里的「Flag 人工复核」
  是 checkbox 开关，勾选写入 `manual`、取消写入 `off`，默认勾选。「SSRF 标记」组把三种
  模式的区别写在字段下方的说明里（只记录 / 拦截并拒绝 / 忽略，以及硬底线在 `off` 下也会
  关闭），操作员不需要翻文档就能判断该切哪一个。
- 与 `defaults` 不同的字段显示琥珀色「已覆盖」，顶部显示覆盖项数量与更新时间。
- 「保存并生效」发送最小 patch；服务端拒绝时把具体约束错误显示在弹窗里。
- 「恢复 dispatch.yaml 默认值」需要连续点击两次（4 秒内），然后发 `DELETE`。
- 浏览器标题在打开项目时显示「项目名 · Cairnweave」，回到列表后恢复「Cairnweave」。

## 7. 测试

- `apps/cairn/src/config-overrides.test.ts`：键白名单、深合并、视图形状、原地同步保持
  引用、持久化与重启重放、非法值不改配置、跨字段冲突、重置、坏数据清理、执行模式切换
  （容器默认值注入）、`Flag 人工复核` 开关的覆盖/重置与非法枚举、`scope.ssrf_markers`
  的覆盖/重置与非法枚举、`tasks.tool_result_spill` 的覆盖/重置、非法枚举与 `min_bytes`
  这类未知子键被白名单挡下、`protected_hosts` 被白名单挡在运行期之外、`validateNext` 拒绝。
- `apps/cairn/src/http/api.settings-runtime.test.ts`：GET/PUT/DELETE、409、400（未知键 /
  越界 / 非法 JSON / 非法执行模式）、413、operator token、跨源拒绝、错误不落库、执行模式
  切换与 `validateNext` 400、`verification.flag_review` 的读写与落库、`scope.ssrf_markers`
  的读写落库与 `protected_hosts` 的 400、
  `POST /settings/runtime/test` 的参数与结果透传。
- `apps/cairn/src/runtime/probe.test.ts`：本地模式检查 Bun 与工作区写入、工作区不可创建、
  Docker 守护进程/镜像/试启动、镜像缺失时停止并给出构建命令、无 `container:` 段时的镜像
  回退。
- `apps/cairn/src/scheduler/loop.test.ts`：`reconfigure()` 在启动后重挂定时器、启动前调用
  无副作用、空闲时替换 runtime 后端。
- `apps/cairn/src/http/api.ui.test.ts`：统一设置弹窗与页签、每个可编辑路径恰好一个控件、
  最小 patch（含 `runtime.execution`）、执行环境测试按钮的请求体/结果/切换清空、空数字
  输入、400/409 行内错误、二次确认重置、写入期间禁止关闭、浏览器标题跟随项目名；以及
  技能页签的按需加载与计数、表单校验与请求体、启停/删除确认/恢复、行内错误，技能详情弹窗
  的文件树与首个文件自动预览、路径编码、二进制/截断标记、写入期间禁止关闭与关闭后复位。
- `apps/cairn/src/http/api.skills.test.ts`：内置播种与白名单计数、创建（立即启用/不启用）、
  非法载荷与 413、重名与已删除内置 409、启停与 404/400、路径穿越拒绝、自定义删除、
  内置删除跨重启持久化与恢复语义、跨源与 operator token 守卫；文件浏览的排序与截断标记、
  正文逐字节回传、嵌套目录读取、二进制与 256 KiB 截断、穿越/未知技能/缺失文件拒绝。
- `apps/cairn/src/agent-config-dir.test.ts`：默认目录解析与环境变量覆盖、拒绝根同时覆盖
  新旧两代、迁移只在目标为空时复制、跳过软链接、超过 64 MiB 上限、旧目录保持不变；M44 起
  另加两例，用 `git check-ignore` 与 `git ls-files` 钉住仓库 `agent-config/` 的姿态——凭据与
  provider 接线文件被忽略，`prompts/`、`skills/`、`settings.json` 作为项目内容入库。

## 模型连接错误的页面诊断

项目详情页顶端与「任务运行」卡片会显示模型连接、认证、限流、请求超时或通用服务异常。
诊断随现有项目轮询刷新，运行尚未结束时也能显示已写入会话日志的错误；不是每个请求的
即时网络追踪，首次日志写出之前仍可能只有运行状态。错误消失、模型恢复正常返回后不再
将该次临时错误作为当前告警；后续成功运行也会清除项目顶端的旧告警。

这是 worker 会话的诊断，不是目标网站的可达性结论，也不替代 scheduler 的失败、取消、
硬截止等权威状态。硬截止记录明确显示任务被终止，不误标为模型连接失败。

服务端只从固定任务目录读取有界日志尾部：每次最多检查 20 个失败/运行中的记录，每个任务
最多枚举 64 个目录项、读取两个 128 KiB 日志尾部，拒绝软链接/目录重定向。只将错误分类、
固定中文说明、格式化时间和近期片段的错误次数传给前端；不返回原始响应、提示词、请求头、
凭据或宿主路径。没有工作区、日志已删、文件不可读或不完整时不阻断 API/任务。

新失败运行将固定错误码与说明写入原有 `runs.detail`，所以 session 清理后仍可看到原因；
历史的通用退出码记录只在日志仍存在时做只读补充展示，不重写历史、不修改图或完成状态。
运行期配置页面中的执行环境探测仍只验证运行时/工作区/容器可用性，不验证模型凭据。
