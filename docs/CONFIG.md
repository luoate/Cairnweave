# 运行配置（M22 起；M24 扩展执行模式与统一设置入口）

dispatch.yaml 仍是配置的事实来源；M22 增加一层**运行期覆盖**，让不含部署信息的调度参数
可以在页头「设置 → 运行与执行」里改，并在下一个调度周期生效，不必重启进程。M24 把
`runtime.execution`（local / container）也纳入可编辑项（仅在调度器空闲时切换），并把
运行配置、模型密钥、本地偏好与服务端设置收进同一个「设置」弹窗。Observer 复盘在
M22 改为默认开启（`observer.enabled` 默认 `true`），提案自 M23 起默认 `enabled: true` +
`mode: dry_run`（完整校验并记录，不写图）。

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
| `execution` | local | `local` / `container`；只在调度器空闲时切换（见下） |
| `max_workers` | 3 | 全局并发任务上限，正整数 |
| `max_running_projects` | 2 | 同时调度的项目数，正整数 |
| `max_project_workers` | 1 | 单项目并发任务，正整数且 ≤ `max_workers` |
| `interval` | 3 | 调度 tick 秒数，正整数；改动会重挂定时器 |

### 执行模式切换

`PUT /settings/runtime` 接受 `{"runtime":{"execution":"container"}}`（或反向切回
`local`）。`RuntimeConfigStore` 在解析成功后、写入活配置前调用 `validateNext`：

- 切到 `container` 时先检查本机 `docker`；不可用返回 400 并说明原因。
- 调度器有任务在跑时返回 400（“wait for running tasks to finish…”）；正在切换时同样拒绝，
  避免并发替换后端。
- 校验通过后，`Scheduler.reconfigure()` 用新的执行模式重建 runtime 后端：等空闲 → 创建
  新后端 → 关闭旧后端 → 重新解析工作区根目录。进入容器模式时，控制面先把内置
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
| `bootstrap.timeout` / `bootstrap.conclude_timeout` | 300 / 90 | 秒 |
| `reason.timeout` / `reason.max_intents` | 300 / 2 | 秒；单次 reason 新增意图上限 |
| `explore.timeout` / `explore.conclude_timeout` | 600 / 120 | 秒 |
| `graph_slice.enabled` | false | explore 及其 conclude 是否拿切片 |
| `graph_slice.max_facts` / `graph_slice.max_intents` | 80 / 60 | 软上限；`max_facts ≥ 2` |
| `evidence.min_bytes` | 1 | 0 表示接受空证据 |

### Worker `worker` / `worker_selection`

| 键 | 默认 | 说明 |
| --- | --- | --- |
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
| `flag_review` | manual | `manual` 把抓到 flag 形状的值登记为后台复核（派发不暂停，完成声明等判定；操作员判定真·还有更多 / 真·停止 / 假·继续探索）；`off` 关闭复核。运行配置弹窗的「Flag 人工复核」开关直接切换这两个值，默认打开 |

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
| `scope.ssrf_markers` | 下一次任务准备的 worker 环境（`CAIRN_SSRF_POLICY` 折进 `CAIRN_SCOPE_POLICY`）；已启动的 worker 沿用注入时的模式 |
| `worker.*` | 下一次 `prepareTask`；运行中的任务沿用已经写好的 `task.json` |

正在运行的任务不会被改写或中断；新配置只影响之后的派发。

## 5. 只读项

以下内容涉及进程、网络或凭据布局，仍须改 dispatch.yaml 并重启。弹窗的灰色只读区只做
展示：

- `server`
- `runtime.prompt_group`、`runtime.healthcheck_timeout`、`runtime.worker_healthcheck`
- `common_env`（只显示键名，不显示值）
- container / local 的 `workspace_root` 与 `completed_action`
- container 的 `image` / `network_mode` / `worker_argv` / `cap_add`
- `observer`（`enabled`、`model`、节奏、`kernel_tasks`）
- `audit_stream`
- `scope.protected_hosts`（部署自身设施名单，只在 yaml 配置；弹窗只读区不展示，模式本身可切）
- `worker_profiles`
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
  的覆盖/重置与非法枚举、`protected_hosts` 被白名单挡在运行期之外、`validateNext` 拒绝。
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
  新旧两代、迁移只在目标为空时复制、跳过软链接、超过 64 MiB 上限、旧目录保持不变。
