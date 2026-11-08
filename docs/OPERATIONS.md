# 运行手册

按主题归档的运行参考：容器模式、Host Bridge、artifacts、证据与 runs、图切片、Observer、
图提案、慢层触发与预算、真实 Solver 与模型配置、模型/密钥 API、运行配置，以及需要真实
模型或 Docker 的 gate 命令。

快速开始、架构图与 HTTP API 概览见 [README](../README.md)；配置字段与生效时机见
[CONFIG.md](CONFIG.md)；worker 契约见 [CONTRACT.md](CONTRACT.md)。

## M50 升级与恢复

M50 的代码/离线验收与实际部署分开。升级前先停止需要暂停的项目并等待任务退出，按部署策略备份 SQLite 数据库（运行中的 WAL 数据库应使用 SQLite 备份接口，而非只复制主文件）；数据库写入者必须使用同版本代码。新 sidecar 表随 `configureDatabase` 增量创建，不需要改写图或凭据。

取得操作员授权后，使用既有服务管理方式重启控制面以加载代码与部署配置。先只读检查项目、runs 和用户引导状态；不要为验证升级自动恢复停止的项目或触发真实模型请求。真实模型与 Docker 连通性 gate 需要另行授权和预算。

环境退避/blocked 不会因服务重启消失。blocked 恢复顺序：停止项目、修复模型/代理/运行时配置、必要时重启服务、操作员恢复运行。只有真正 stopped→active 才重置故障；恢复后仍需成功探测才说明调用恢复。已有错误 run 不靠自由文本回填权威分类，成本历史不清零。详细退避、收尾保留及落库失败保护见 [CONFIG](CONFIG.md#环境故障与解题结果分流)。

## M51a–d 随代码升级

M51 阶段累计版本为 `0.75.0-m51`。在同一升级流程中，`intent_meta.experiment`、
`intent_meta.experiment_review` 和 `task_checkpoints.experiment_plan` 自动增量添加，历史行留空。
最后一列是控制面在任务派发时绑定的计划，worker 不能通过检查点改写。旧检查点仍按原 M49 schema
读取并派生结果索引，但不以当前计划回填历史派发绑定，因此不具备结果驱动后续决策的资格；
仍可明确提出 `need_observation`。没有第二套尝试正文迁移。
不开启 checkpoint / ContextPack 时保持原采集/交付行为；不要为了验收悄悄开启开关或恢复项目。
CLI `cairn version`、根与应用 package 版本应一致，worker 与控制面仍须同版本部署。
本轮离线测试不等于现有服务已经重载；实际部署、项目恢复和真实模型验证仍分别需要授权。

## M52a–d 随代码升级

当前版本 `0.77.0-m52`。本阶段增加派生读模型、默认关闭的排序偏好与只读展示，没有新数据库迁移或持久化计数器；由既有
intent_meta、runs、task_checkpoints 在读取时重建，session 清理后仍可读取已有检查点，证据可用性
按当前工作区复核。旧记录缺派发计划/检查点/结束信息时标 unknown，不回填、也不把故障算作路线停滞。
同计划 ID 摘要有界，但内部沿用项目完整 snapshot，不宣称 SQL 分页或固定内存上限。

自动交付仍依赖成功 apply 的 ContextPack；默认开关不变。已有 experiment GET 可只读核对 mode、
指纹、状态与计数，不需要新写路由。代码验收不等于服务已升级；同版本部署、备份、重启和实际项目恢复
仍按前述授权流程执行，不能为观察计数自动恢复项目、调用模型或改写存储优先级。

M52c 开关 `tasks.exploration_suppression.enabled` 默认 false；仅显式启用才按连续 3 次未新增报告应用
最多 20 分、5 分钟、不滚动续期的排序偏好，唯一方向仍可执行。可通过既有运行配置覆盖启停并持久化重放；
禁用后下一次选择恢复基础排序，已运行任务不取消。新 Fact/Hint、报告或 unknown 会重新累计资格，故障不增计数。
不必为读取已有有效历史强制开启当前 checkpoint 或 M48；新历史采集与模型交付仍分别由原开关约束。

M52d 意图详情只读展示观察进展和读取时排序预览，可手动刷新查看原因、基础/有效优先级与到期时间；
预览不保证实际派发。出现历史/时间/证据不可比较时不降权，读取异常回基础排序，原环境/用户引导/预算/
claim/Scope 门保持不变。无新数据库计时器，重启从历史重建窗口。离线验证命令：
`bun run eval:exploration --out runs/exploration-eval.json`，不调用模型或 Docker、不授权项目恢复。
本轮未自动开启真实部署开关、重启服务或运行真实模型；需要部署时仍由操作员单独授权。

## 容器模式（M3）

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

**改完 worker 代码要重建镜像，并清掉旧容器。** 镜像里是 `COPY . .` 的源码快照，重启
控制面不会让容器换代码；更隐蔽的是 `ensureProject()` 对已停止的容器只做 `docker start`，
不会用新镜像重建，所以旧代码会一直跑下去。重建后先删掉残留容器：

```bash
docker build -f Dockerfile.worker -t cairn-worker:latest .
docker ps -a --filter "name=cairn-dispatch-" --format '{{.Names}}' \
  | xargs -r docker rm -f
# 确认镜像里有新代码（应打印文件路径）：
docker run --rm --entrypoint sh cairn-worker:latest -c "grep -rl <新符号> /app"
```

同样地，`worker.reasoning` 这类**控制面**配置放 `dispatch.yaml` / `/settings/runtime` 就能
生效，但真正按任务类型开关推理的 `applyReasoningMode()` 在 worker 里——不重建镜像，
容器任务看起来就是“开关没生效”。

## Host Bridge 与审计

worker 启动真实 Solver 前会把 `task.scope.targets` 与工作区/会话路径写入
`CAIRN_SCOPE_POLICY`。`packages/agent` 的 solver 会话和 subagent 会话都会加载
`CAIRN_HOST_BRIDGE_MODULE`（`apps/cairn/src/host-bridge/worker-extension.ts`），因此
子代理不能绕过同一道闸门。

- 网络：从 `bash` 命令中提取 URL、`/dev/tcp`、IPv4/IPv6、CIDR、`host:port`、`nc host port`
  等端点；主机名按字面匹配（不做 DNS），支持 `*.example.com` 与 IPv4 CIDR。识别为网络
  工具却提取不到端点时 **拒绝**。
- **命令位置（M57d）**：只有简单命令的“命令词”是网络工具才算网络调用。`which curl`、
  `ls curl`、`command -v curl` 都只是提到工具名；`sudo -u root nmap …`、`timeout 60 curl …`
  会跳过包装命令取其后的命令词。位置参数里的裸主机名只有在该命令词是网络工具时才成为
  主目标。
- **heredoc 与请求头（M57d）**：`cat > file <<'EOF'` 写出的脚本正文不扫描（正文是数据），
  `python - <<'EOF'` 这类继承 stdin 的 heredoc 仍扫描，其 `import socket` 照样 fail closed。
  `-H/--header`、`-b/--cookie`、`-A/--user-agent`、`-e/--referer` 的值按“携带目标”处理，
  默认 `observe` 只记录，不当作连接目的。
- **默认端口（M57d）**：scope 写成 `http://host`（端口 80）时，脚本里不带 scheme、不带端口
  的主机字面量视为同一目标；显式 `host:8080` 不会被裸主机名匹配。
- **命令超时（M58b）**：每条 bash 命令都带超时，由 worker 侧 `tool_call` 扩展在调用前写入
  （不能包装工具对象——SDK 只取工具名后用自己的实现重建）。实际值取
  `min(模型值, tasks.bash_timeout_seconds, 距软截止剩余 − 5 秒, 距硬截止剩余 − 10 秒)`，
  最小 5 秒；软截止之后固定 30 秒。所以不会有命令跨过软截止还活着，收尾时刻一定拿得到。
  `find /` 在这台机器上会进入 `/proc/registry*` 虚拟目录，几百秒都走不完；超时会让它带着
  “Command timed out” 返回，模型还能继续。
- **时间预算回显（M59）**：模型看不到上限就会把「剩余预算」误读成「命令慢」。所以每条成功的
  bash 结果末尾都有一行 `[时间] 已用 …s，距软截止 …s，硬截止 …s；本条命令上限 …s（原因）`；
  被截断的调用（以失败返回，SDK 不允许改写其结果内容）改发一条 `nextTurn` 消息，写明是剩余
  时间截断而不是命令本身慢。排查任务时按这行就能判断模型当时还剩多少时间。
- 文件：读只能在工作区或 `file:` scope 目标内；写只能在项目工作区内；agent 配置目录
  （`/cairn/agent-config`、`~/.cairnweave`、旧版 `~/.tch-agent` 与 `CAIRN_AGENT_CONFIG_DIR`
  指定的目录）始终拒绝；按 realpath + 词法双重判断，阻止符号链接逃逸。
- 未知工具默认 **拒绝**；只有明确列出的 worker 本地工具（subagent、document_finding、
  challenge 工具等）放行，`subagent` 的会话仍受同一闸门约束。
- **SSRF 标记（M33）**：授权请求*内部*携带的其它主机字面量（URL 查询串 / 片段、`--data`
  表单体、`@payload` 引用的文件正文）与连接目的分开判定，`scope.ssrf_markers` 决定处置：
  - `observe`（默认）：命令照常执行，越界的携带目标在同一次调用后多写一行
    `event:"ssrf_candidate"` 审计；UI「审计」页签把它标成琥珀色「SSRF 标记」徽标，判定与
    拒绝分开看。事后回溯用这条线，不打断任务。
  - `block`：携带目标越界时该 tool_call 直接失败并同样留痕。观察到噪声会误导判断、或要在
    真实目标前硬挡一跳时切这里。
  - `off`：只看连接目的，不检查携带字面量。这是相对 M33 **之前**的放宽（旧版把携带字面量
    当连接目的检查），只在误报确实阻碍工作时使用。
  硬底线与模式无关：链路本地 `169.254.0.0/16`、GCP 元数据主机名、`scope.protected_hosts`
  以及本部署 `server` / `audit_stream.url` 里的命名主机，在 `observe` 与 `block` 下都拒绝；
  把控制面自身地址登记进 `protected_hosts` 是不改代码的防护手段（IP 字面量不参与自动登记，
  本机 `127.0.0.1` 通常同时是靶机）。载荷文件只在 `observe` / `block` 下读取，且限定工作区
  内的文本（单文件 64 KiB、总计 256 KiB、最多 16 个目标）；绝对路径、symlink、二进制一律
  **跳过**而不是拒绝。三种模式在设置弹窗「运行配置 → SSRF 标记」切换，下一个任务生效；
  `protected_hosts` 只在 dispatch.yaml 配置。
- 每次 allow/block 都追加到 `<sessionDir>/audit.jsonl`（task_id、project_id、tool、
  action、targets、decision、reason、detail）。审计不可写时同样拒绝。M33 的携带目标观察是
  同一次调用后的第二行，靠 `event:"ssrf_candidate"` 区分，不改表结构。
- **边界**：这是模型工具调用的策略闸门，不是针对任意代码的沙箱。模型若通过未识别的
  程序发起网络请求，Host Bridge 看不到；容器隔离（网络命名空间、不挂 socket、只读配置）
  才是内核边界。两者必须同时启用。

## artifacts

任务结束（成功、失败、取消都算）后，控制面扫描 `<workspace>/artifacts/**`：跳过符号
链接，最多 2000 个文件/20 层，逐文件流式 SHA-256，记录到 `project_artifacts` 表。查询：

```bash
curl -s localhost:8000/projects/proj_001/artifacts
```

索引是扫描结果而非信任边界；artifacts 目录不存在时保留上一版索引。

## 工具结果溢出（M43）

模型看到的单次工具输出有长度上限：超过 `tasks.tool_result_spill.max_inline_chars`（默认
32000 字符）的原文写到 `<workspace>/.tool-results/<毫秒>-<工具>-<调用id>.md`，上下文里只留
绝对路径 + 600 字符预览。排障时那里才是完整的 `curl` / `nmap` 输出，但它是工作区文件、
**不是 artifact**：不出现在 `/artifacts` 索引、附件包或报告里，也不受 `retention` 清理，
随项目工作区长存。指针里的绝对路径是 worker 视角的（容器模式为 `/cairn/workspace/…`），
在宿主上按工作区相对路径 `.tool-results/` 找即可。

```bash
ls "<workspace>/.tool-results" | tail          # 最近溢出的工具结果
grep -l "flag{" "<workspace>/.tool-results"/*.md
```

## 模型轨迹（M56）

调度日志的「模型轨迹」按钮打开任务级的实时模型请求/响应流。它读 worker 写在会话目录里的
`<workspace>/<project>/.cairn/sessions/<task>/solver-session/model-trace.jsonl`（NDJSON，一行一个事件），
由 solver 会话注册的 `model-trace` 扩展在 `before_provider_request`、`message_end`、
`tool_execution_start/end` 时追加：

- `request`：模型名、请求体字节数、消息条数与预览、工具名、白名单参数
  （`temperature`、`reasoning_effort` 等——可据此确认推理开关是否真的到了 provider）。
- `stream`：节流后的流式尾预览；`response`：文本、思考、停止原因、token 用量、延迟和错误。
- `tool_start` / `tool_end`：工具参数与返回预览；写满上限时最后一条是 `truncated`。

边界：请求头、base URL 与 API key 从不写入（`before_provider_request` 拿到的是 provider 请求体本身，不含这些字段）；每个文本字段按
`tasks.model_trace.preview_chars` 截断，整文件按 `tasks.model_trace.max_bytes` 封顶；
写失败只会让文件缺失，不会让任务失败。控制面只读地经
`GET /projects/{id}/runs/{task_id}/trace?cursor=&limit=` 提供最新窗口（默认 200 条、
最多 500 条、单次最多读 4 MiB），UI 每 1.5 秒用 `cursor` 增量拉取。

```bash
curl -s 'localhost:8000/projects/proj_001/runs/explore-abc/trace?limit=50' | jq '.events[-3:]'
tail -f "<workspace>/proj_001/.cairn/sessions/explore-abc/solver-session/model-trace.jsonl"
```

关闭 `tasks.model_trace.enabled` 后只影响新任务；已有文件仍可查看。轨迹不是
`project_artifacts`，也不进 WorkerTask、prompt 或审计账本，随会话清理一起删除。

## 任务失败码与处置（M56 补充）

运行卡片的「执行异常」不是路线反证。按 `failure.code` 区分原因（UI 现在给的是中文标签，
`GET /projects/{id}/runs` 里仍是原始码）：

| code | 含义 | 典型处置 |
| --- | --- | --- |
| `result_invalid` | worker 的结果文件缺失，或 JSON 到了但不符合契约（如 `experiment` 缺 `version`、优先级/预算/dedupe_key 非法）。run 的 `detail` 会带上校验器原文；下一次 reason 的提示词也会引用这段话，并且只等 `strategist.schema_backoff_seconds`（默认 15 秒）就重试 | 看 detail 与模型轨迹的 `response`；契约问题通常换个模型或收紧提示词即可，不需要改图 |
| `evidence_invalid` | `evidence_refs` 里存在不存在的路径、目录或 0 字节文件（`tasks.evidence.min_bytes`），且该结果携带完成声明或 `tasks.evidence.invalid_refs: fail` | 检查模型引用的实际路径（`ls artifacts/<task>/`）。默认 `drop` 模式下普通 explore/bootstrap 结果只会逐条丢弃并在 `detail` 记录 `invalid evidence refs dropped: …`，不再整轮失败 |
| `tool_budget_reserve` / `tool_budget_exhausted`（audit 事件） | 调用进入预算末尾保留段却尝试探测，或预算已耗尽（M57b） | 前者说明 worker 没在保留段前写出结论；看 audit 的 `reason` 与 `run.detail`，必要时调大 `worker.budget_reserve_calls` 或 intent 预算 |
| `verification_error` | 完成校验执行出错（不是校验未通过） | 检查题目服务与校验策略 |
| `apply_failed` | 写图时控制面内部异常（数据库/事务），不是模型的问题 | 看控制面日志 `apply failed task=…` 的异常原文 |
| `result_missing` / `worker_failed` / `hard_deadline` / `lease_lost` | worker 没产出结果、异常退出、超硬截止、租约被其它控制面接管 | 看 `<session>/stderr.log` 与调度日志。M58b 起命令不会跨过软截止还活着；如果仍然 `hard_deadline`，先看模型轨迹里最后几条 `tool_start` 的 `timeout` 与耗时——命令之外的模型往返或结果写入也可能超时 |

排除法：`infrastructure` 域的失败（模型连接/认证/限流/超时、worker 启动、运行时不可用）会
进入项目级背压与熔断，与本节的任务级失败分开记录；两者都不代表目标不可达。

`/flag` 的兜底扫描会把这里算作取证来源（先于会话目录、共用字节与条目额度），所以开启溢出
不会让 flag 从横幅里消失；M29 的 ≤10 s 缓存按工件指纹失效，新落盘的溢出文件要等 TTL 到期。
完全关掉外置换回内联：`tasks.tool_result_spill.enabled: false`，或经
`PUT /settings/runtime` 热改（下一次派发生效）。

## 证据、内容校验与 runs（M5a + M5b）

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

## 图切片（M4b，可选）

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

## Observer（M4c，M22 起默认开启）

Observer 是真实 Solver 旁边的 review sidecar。它只维护看板，不执行验证，也不改变任务
结果；fake solver 会忽略它。M22 起默认开启，需要显式 `enabled: false` 才关闭。

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
  M23 起 UI 的「看板」页签通过只读 `GET /projects/{id}/board` 展示同一份想法与记忆。
- 主 Solver 只有 `memory_list` / `idea_list` / `idea_search` 三个只读工具；写工具不在
  Host Bridge 白名单，文件工具对看板目录的 `write` / `edit` 也被拒绝。
- sidecar 使用 `CAIRN_AGENT_CONFIG_DIR`，只注册看板工具与 `query_solver_history`，没有
  shell/文件/网络工具，不加载 Host Bridge，不触发 challenge 续跑或效率 steer。
- 每 `every_rounds` 轮、`agent_end` 和 `solve()` 返回前的 `flush()` 触发串行 review。
  `flush()` 最多等待 `timeout_seconds`，任何失败只写
  `<session>/observer/audit.jsonl`，绝不影响 `result.json`。
- 已知边界：看板写保护只覆盖结构化文件工具；`bash` 仍可在工作区内写看板。同项目并发
  时由 M8 的项目级 review 租约串行化复核（拿不到租约就跳过本轮），但看板写入本身仍是
  策略级保护。详见 `docs/OBSERVER.md`。

## 图提案（M11，M23 起默认演练）

提案让 Observer 的结论进入 Cairn 图，但**不把写权限交给 worker**。sidecar 只能写候选
文件；控制面是唯一审核者和写图者。

```yaml
observer:
  enabled: true
  kernel_tasks: ["explore"]

proposals:
  enabled: true
  mode: dry_run               # off | dry_run | apply（默认 dry_run）
  max_per_task: 20
  max_file_bytes: 16384
  max_total_bytes: 65536
  allow_kinds: ["fact", "intent", "hint"]
  require_evidence_for_fact: true
  min_confidence: 0
```

- 启用条件：`observer.enabled`、任务 kind 命中 `kernel_tasks`、`proposals.enabled`、
  `mode != off`、`max_per_task > 0` 且 `allow_kinds` 非空。否则 sidecar 不注册
  `propose_graph_change`，也不会注入提案环境变量。
- 传输：`<session>/observer/proposals/<uuid>.json`，原子写入；控制面在任务结束时按
  文件名确定性地派生提案 ID，因此保留目录重复导入不会产生重复行。
- 审核规则：`fact` 必须有存在的来源 Fact 与真实证据文件，审核通过后用
  `createIntent` + `concludeIntent` 写入；`intent` 必须有 `dedupe_key`，与未结束
  intent 或已应用提案重复时标为 `duplicate`；`hint` 按内容去重。项目非 active 时
  拒绝。审核失败只记录，不影响 worker 结果。
- `dry_run` 默认开启：它执行全部校验，但只记录 `dry_run`，不写图；需要写图时再改
  `mode: apply`，或在「设置 → 运行与执行」里热切换。
- 只读查询：`GET /projects/{id}/proposals[?status=&kind=]`；UI 的“提案”页签同样只发
  GET。看板另走 `GET /projects/{id}/board`（M23）。控制面 API 仍未认证，远程/容器部署
  必须加网络层访问控制。

## 慢层触发（M12a）

reason 的触发条件与退避可以按项目统一配置；这些值只影响调度，不改变 Cairn 图或任务
契约：

```yaml
strategist:
  min_new_facts: 1              # 0 关闭 Fact 增量触发
  min_new_hints: 1              # 0 关闭 Hint 增量触发
  cooldown_seconds: 30          # 非紧急触发的最小间隔；0 关闭
  failure_backoff_seconds: 120  # 失败后禁止任何触发的窗口；0 关闭
  max_runs_per_hour: 12         # 滚动一小时 reason 上限；0 关闭
  zero_output_threshold: 3      # 连续零产出 run 阈值；0 关闭
  stale_intent_seconds: 0       # 所有 open intent 陈旧多久后触发；0 关闭
  fallback_interval_seconds: 0  # 空闲兜底间隔；0 关闭
```

- 求值顺序与紧急/抑制规则见 `docs/STRATEGIST.md`。失败退避优先于一切；紧急触发不绕过
  退避，也要等运行中的 explore/conclude 结束。
- `initial` 只在没有未认领 open intent 时触发；已有方向时先让 explore 跑。
- 每次 reason 的成功/失败写入 `strategist_state`；成功的 noop 也推进水位。状态写失败
  只记日志，不影响任务结果。

## 调度优先级与项目预算（M12b）

```yaml
budget:
  max_project_tokens: 0       # 该项目已结束 run 的 total_tokens 上限；0 关闭
  max_project_cost_usd: 0     # 该项目已结束 run 的 cost_usd 上限；0 关闭
  max_project_tasks: 0        # 单项目并发上限；0 使用 runtime.max_project_workers
```

- reason 可给每个 intent 附 `priority` 与 `budget`；priority 只决定快层 explore 的先后，
  不会让 explore 抢在已触发的 reason 之前。
- `max_seconds` 只能收紧该任务类型的超时；`max_tool_calls` 是每 worker 进程的 Host
  Bridge 调用上限，超限后拒绝并以 `tool_budget_exhausted` 审计，不是安全边界。
- token/成本门禁只统计已结束 run，且不拦截 pending conclude；在途任务完成前可能超预算。
- worker 的用量写在 `usage.json` 并汇总到 `runs`。

## 慢层只读视图（M12c）

```bash
curl "http://127.0.0.1:8000/projects/<project_id>/strategist?limit=20"
```

- 响应含 `state`（`strategist_state` 或 `null`）、`budget`、`intents` 与 `reason_runs`。
- `budget.limits` 只在 `cairn serve --config` 时出现；纯 HTTP 模式返回 `null`，但仍显示
  已记录用量。`budget.running_tasks` 统计 `runs.outcome IS NULL`，因此与调度器内存中的在途
  任务口径一致；M38 起控制面每次启动都会把上一进程遗留的这类行补写成 `inactive`（日志
  `startup reconcile closed N orphan run(s)`），崩溃遗留的幽灵任务不再长期占住
  `exhausted.tasks`。`exhausted.tasks` 只在 `max_project_tasks > 0` 时判断。
- UI 的“慢层”页签显示同一数据；API 仍未认证，远程/容器部署需要网络层访问控制。

## 真实 Solver 与模型配置（M2c）

默认 solver 是确定性的 `fake`。用环境变量启用真实 BreachWeave Solver：

```bash
CAIRN_SOLVER=breachweave bun run cairn serve --port 8000 --db-path ./cairn.db \
  --config dispatch.example.yaml
```

也可以在 `dispatch.yaml` 的 `common_env` 里设置 `CAIRN_SOLVER: breachweave`。真实 Solver
读取 BreachWeave 的配置目录（默认 `~/.cairnweave/config`，`CAIRN_AGENT_CONFIG_DIR` 可
覆盖；仍在使用默认目录时，首次启动会把旧版 `~/.tch-agent/config` 的内容复制过来，旧目录
不删除），首次启动时会把内置 prompts/skills 补齐到该目录。本仓库的实验室把该目录放在
签出内的 `agent-config/`（由 `common_env.CAIRN_AGENT_CONFIG_DIR` 指过去），让提示词与技能
作为项目内容入库，细节见[仓库内的 agent 配置目录](#仓库内的-agent-配置目录m44)：

- `auth.json`：provider 凭据；手工配置时**API key 只保存在这里**；
- `models.json`：provider、baseUrl、api 协议与模型列表。自定义 provider 的 `apiKey`
  字段是上游 SDK 的必填项；手工配置可把它写成环境变量名（例如
  `CAIRN_MODEL_API_KEY`），请求时优先使用 `auth.json` 的凭据。经 M18a API 写入的
  密钥会同时落到 `auth.json` 与这里的 `provider:<id>.apiKey`（SDK 按 provider 读取），
  清除时两侧一起删除；
- `model-prefs.json`：短 ID → 模型映射；`cairn-worker` 提示词的 frontmatter
  `model: "cairn-worker"` 引用同名条目；
- `prompts/`、`skills/`：用户可覆盖内置资源；放在仓库 `agent-config/` 时这两项与
  `settings.json` 是入库的项目内容。

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

凭据与 provider 接线文件（`auth.json`、`models.json`、`model-prefs.json`、
`provider-prefs.json`）不属于仓库，也不会写进 `task.json`；权限应仅限本人。

## 通过 API 与 UI 管理模型与密钥（M18a/M18b/M18d）

控制面新增 `/settings/agent` 路由；目录按 `--config` 的 `common_env`
（`CAIRN_AGENT_CONFIG_DIR`）→ 进程环境变量 → `~/.cairnweave/config` 解析，纯 HTTP 模式
同样可用。返回的 provider/模型列表带掩码状态，密钥、provider 与模型的自定义 header
值都不会回传。静态 UI 的页头“模型与密钥”入口直接使用这些路由：Provider 页签维护
provider 与密钥，模型页签负责拉取/手工录入、设为默认、测试与删除；密钥输入框永远
是空值，留空即保持原值。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings/agent` | provider（`hasApiKey`/`apiKeySummary`/`headerNames`）、模型（含 `isDefault`/`referencedBy`）、支持的协议与内置 provider |
| POST/PUT | `/settings/agent/providers[/{id}]` | 创建/更新；内置 provider 可只填 `apiKey`，自定义 provider 必须同时给 `api` 与 `baseUrl` |
| DELETE | `/settings/agent/providers/{id}` | 仍有模型引用时返回 409，`?force=true` 级联删除 |
| POST | `/settings/agent/providers/{id}/discover` | 拉取模型列表；无 `baseUrl` 的内置 provider 返回内置目录 |
| POST/PUT | `/settings/agent/models[/{id}]` | 模型条目支持 `name`、`thinkingLevel`、`reasoning`、`input`、`cost`、`contextWindow`、`maxTokens`、`headers`、`compat` |
| DELETE | `/settings/agent/models/{id}` | 被 prompt 默认、`worker_profiles` 或 Observer 引用时返回 409 |
| POST | `/settings/agent/providers/{id}/test` | 用该 provider 的 `cairn-worker` 条目（否则第一条）测试；无模型条目时返回可读提示 |
| POST | `/settings/agent/models/{id}/test` | 真实调用一次模型；错误文本先替换真实密钥再遮蔽常见凭据形态；60 秒超时 |
| PUT | `/settings/agent/default-model` | 把 `cairn-worker` 条目重指向选中模型（dispatch 的 `worker_profiles` 仍可覆盖） |

`apiKey` 只写：省略表示不改，`null` 表示删除；provider 的 `headers` 同样只写，保存在
`models.json`。通过 API 保存的密钥会按上游 SDK 要求同步到 `models.json`；若要求该文件
不落明文密钥，请手工把该字段改为环境变量名（见上），API 不做这种转换。设置
`CAIRN_OPERATOR_TOKEN` 后，所有写路由都要求 `X-Cairn-Operator-Token`，并拒绝 Origin
与请求 host 不一致的浏览器写请求。完整操作步骤、常见错误与 M16b 真实 A/B 记录见
`docs/MODELS.md`。

## 管理技能（M25，M26 统一浏览）

「设置 → 技能」页签使用 `/settings/agent/skills` 路由；配置目录与模型设置相同，
接管的是 `<configDir>/skills/<name>/SKILL.md`（及其 `references/`、`scripts/` 等附属文件）。
内置技能共 17 个，`cairn-worker` prompt 默认启用其中 12 个；只有白名单里的技能会进入模型上下文。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings/agent/skills` | 补齐内置文件后返回 `{prompt, promptFound, enabledCount, skills}`，每行带 `builtin`/`deleted`/`enabled` |
| POST | `/settings/agent/skills` | `{name, description, content, enabled?}`；默认立即启用（写入 prompt 白名单） |
| DELETE | `/settings/agent/skills/{name}` | 删除目录并移出白名单；内置技能把目录名记入 `.deleted-builtins.json` |
| POST | `/settings/agent/skills/{name}/restore` | 仅内置：清除删除记录并回填文件，不自动启用 |
| PUT | `/settings/agent/skills/{name}/enabled` | `{enabled}`，只改 `cairn-worker` prompt 的 `meta.skills` |
| GET | `/settings/agent/skills/{name}/files` | 只读文件树 `{files:[{path,size}],truncated}`，`SKILL.md` 排第一；≤200 个文件、深度 ≤8 |
| GET | `/settings/agent/skills/{name}/file?path=` | 只读单文件 `{content,size,truncated,binary}`，正文 ≤256 KiB 前缀；越界 400，缺失 404 |

- 新增名须为小写 slug（`^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤64），即目录名；描述单行 ≤1024，
  正文非空 ≤96 KiB，请求体 ≤512 KiB。
- 删除内置跨重启持久：重新打开页签或重启服务都不会回填，直到点「恢复」。
- 手动改 prompt 的 `skills` 数组与页签等价；直接改磁盘文件时，请保持 `SKILL.md` 的
  frontmatter 含非空 `description`，否则 SDK 会跳过该技能。
- 浏览走页签行内的「预览」：左侧文件树、右侧正文，打开即预览第一个文件，头部仍可启停。
  两条只读路由免 operator token（GET 一律开放），但绝不写出目录之外的路径——软链接、
  `..`、绝对路径与含保留字符的文件名都会被拒绝。

## 配置目录改名与迁移（M26）

默认 agent 配置目录自 M26 起为 `~/.cairnweave/config`（Windows 下即 `%USERPROFILE%\.cairnweave\config`）。
解析顺序不变：`--config` 的 `common_env.CAIRN_AGENT_CONFIG_DIR` → 进程环境变量 → 默认值。

- 迁移在 `cairn serve` 启动、播种内置 prompts/skills **之前**执行，且只在解析结果仍是默认目录
  时触发；用环境变量指定别处就不迁移。
- 只在目标目录为空时复制；逐文件 `lstat`，跳过软链接，总量上限 64 MiB，绝不覆盖已存在的目标
  文件。旧目录 `~/.tch-agent/config` **不会被删除或修改**，因此回滚只需把
  `CAIRN_AGENT_CONFIG_DIR` 指回旧目录。
- 复制完成后日志给出 `copied N agent config file(s) from ... to ...; the legacy directory is unchanged`；
  命中上限或出错时不写入部分结果的语义保持不变——已复制的文件留在新目录，下次启动因目标非空
  而跳过迁移，可手动清空新目录重试。
- Host Bridge 的拒绝根同时包含 `~/.cairnweave`、`~/.tch-agent` 与显式配置的目录，模型密钥不会因
  改名而变成可读的工作区文件。
- BreachWeave 内核的 runtime、solvers 与 challenge 目录仍在 `~/.tch-agent` 下，未随本次改名迁移。

## 仓库内的 agent 配置目录（M44）

实验室把配置目录放进签出本身：`<repo>/agent-config/`，由 `dispatch.yaml` 的
`common_env.CAIRN_AGENT_CONFIG_DIR`（Windows 启动脚本用 `%CD%\agent-config`）指过去，
`~/.cairnweave/config` 因此不再创建。代码里的默认值与 M26 迁移逻辑不变——只有解析结果
仍是默认目录才迁移，指到仓库目录就不会触发。

- `.gitignore` 用「整目录忽略 + 白名单」：`/agent-config/*` 全忽略，只有 `prompts/`、
  `skills/`、`settings.json` 反选回来。新增的密钥或本地状态文件默认仍是忽略的，不需要
  每次补规则；`apps/cairn/src/agent-config-dir.test.ts` 用 `git check-ignore` 与
  `git ls-files` 钉住这个姿态。
- 这里的 `prompts/`、`skills/` 是内置播种层的副本：首次启动时内核把内置资源写进配置目录，
  所以内容可以 fork 出差异。操作员在设置弹窗里改过的提示词或技能会表现为工作区 diff，
  这是预期行为，不是漂移。
- 安全边界不变：`agentConfigDeniedRoots()` 把解析后的目录连同两代旧家目录一起登记为拒绝根，
  worker 的工具读不到 `agent-config/auth.json`；容器模式下宿主目录仍以 `readonly` 挂到
  `/cairn/agent-config`，worker 环境被无条件重写成容器内路径，宿主绝对路径不会漏进容器。
- 提交前照例扫描新增行：`agent-config/` 里被跟踪的只有提示词、技能与 `settings.json`，
  凭据文件绝不允许进入 diff。

## 运行配置（M22 起，M24 统一入口，M24b 环境测试）

`--config` 启动时，页头齿轮按钮打开「设置 → 运行与执行」。覆盖存进 SQLite，重启后保留，
并在下一个调度 tick 生效；`DELETE` 清空全部覆盖回到 dispatch.yaml 的原值。
`runtime.execution` 也可在这里切换（local / container），但要求调度器空闲且本机有
Docker；切换在任务全部结束后重建 runtime 后端，不会中断在跑的任务。下拉旁的「测试有效性」
会在保存前实际探测所选模式（Bun/工作区，或 Docker/镜像/试启动），结果逐项显示在弹窗里。
「SSRF 标记」组（M33）在下拉下面直接把 `observe` / `block` / `off` 的区别写成说明；切换同样
立即写入覆盖，但只对下一个任务的 worker 生效——已经在跑的 worker 沿用启动时注入的策略。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings/runtime` | `{defaults, editable, overrides, updated_at, read_only}`；`defaults` 是仅取 dispatch.yaml 的值，`overrides` 是当前被覆盖的叶子路径，`read_only` 展示部署项 |
| PUT | `/settings/runtime` | 整组替换覆盖 patch（snake_case）；未知键、越界值或跨字段冲突返回 400，运行中的配置保持不变 |
| POST | `/settings/runtime/test` | 探测 `{"execution":"local"\|"container"}`，返回 `{ok,checks[]}`；不改配置 |
| DELETE | `/settings/runtime` | 删除所有覆盖，恢复 dispatch.yaml 值 |

写路由沿用 operator token 与同源校验；没有 `--config` 的纯 HTTP 模式所有方法都返回
409。字段清单、热生效范围与只读项见 `docs/CONFIG.md`。

## 真实模型 gate

以下 gate 不在 `bun test` 中（会调用模型、产生费用）：

```bash
bun run tools/gate/m2c-gate.ts
```

它创建临时项目，让真实模型读取工作区的 `marker.txt`。通过条件：项目 `completed`、
至少新增一个 Fact、且 Fact 描述包含 marker。失败时保留临时目录，`CAIRN_GATE_KEEP=1`
可强制保留以便检查 `task.json`、`result.json`、`solver-session/` 与日志。

真实模型的成本/预算基线 gate（M13a，M13b 扩展了 `/cost` 归因）默认最多跑 6 个任务
（可调），并核对用量旁路、`runs`、项目汇总、慢层 API 与因果链：

```bash
bun run tools/gate/m13-cost-baseline.ts
CAIRN_GATE_BUDGET_TOKENS=1000 CAIRN_GATE_EXPECT_EXHAUSTED=1 \
  CAIRN_GATE_REPORT=runs/m13-budget-exhaustion.json \
  bun run tools/gate/m13-cost-baseline.ts
```

报告默认写到 `runs/m13-baseline.json`；参数、断言与基线数字见 `docs/STRATEGIST.md`
第 10 节。它同样计费、不在 `bun test` 中。

M15e 的派发校准 gate 用真实 model-prefs 跑一个两任务小项目，核对每个 run 的
profile/model 记账、项目统计与报告分桶，并输出 epsilon 与探索预算：

```bash
CAIRN_GATE_MAX_TASKS=2 CAIRN_GATE_MAX_MINUTES=8 \
  bun run tools/gate/m15e-calibration.ts
```

报告默认写到 `runs/m15e-calibration.json`。默认两个 profile 都指向 `cairn-worker`
时只校准记账；用 `CAIRN_GATE_PROFILE_B_MODEL` 指向第二个 model-prefs 条目才会比较模型。

M16a 的 A/B gate 需要两个不同的 model-prefs 条目，分别跑独立的 marker 项目：

```bash
CAIRN_AB_MODEL_A=cairn-worker CAIRN_AB_MODEL_B=zhipu-glm-flash \
  CAIRN_AB_TASKS=2 bun run tools/gate/m16-model-ab.ts
```

报告默认写到 `runs/m16-model-ab.json`。gate 在条目缺失、相同或解析到同一模型时直接
退出 2；跑完后要求两侧 `run.model` 不重叠、任务数相同。M16b 已用上面这条命令跑通一次
（`gw-deepseek/deepseek-flash` 对 `gw-zhipu/GLM-5.3-Flash`，12 项检查
全通过），添加第二个真实模型的具体步骤与数字见 `docs/MODELS.md` 第 7 节。

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

审计流的真实容器 gate 不需要模型凭据，适合在每次改 Docker 环境注入或审计路由后运行：

```bash
bun run tools/gate/m9-audit-stream-gate.ts
```

它在临时项目容器里运行 Host Bridge，向宿主上真实启动的控制面流式提交 allow/block，
再断言账本链、序号、重放幂等、撤销后 401、无丢失标记，以及 token 不出现在 worker
输出；同样要求 Docker 与 `cairn-worker:latest`（镜像需包含当前源码）。

Observer 的真实模型联调 gate 是 `tools/gate/m4c-observer-gate.ts`。它在本地模式跑一个
bootstrap 任务，预置一条 pending idea，并检查主 solver 只使用只读看板工具、sidecar 只用
看板/history 工具、review 审计与 flush 完成、看板被真实更新且任务结果不变：

```bash
CAIRN_GATE_KEEP=1 bun run tools/gate/m4c-observer-gate.ts
```

M6 的跨进程恢复 gate 不调用模型：它先写下一台崩溃控制面遗留的 `pending_concludes`
行、已认领 intent 与 solver session，再启动一个全新的 `cairn serve`（fake solver，
端口 `0`），要求新进程完成 conclude、写 Fact、清空队列：

```bash
bun run tools/gate/m6-restart-gate.ts
```

