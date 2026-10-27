# Cairn（合并重写）

把 Cairn 的图内核（事实 / 意图 / 调度）与 BreachWeave 的执行层（Solver / tools /
skills / Observer）合并成**一个 Bun/TypeScript 代码库**，不再维护 Python ↔ TypeScript
之间的进程桥、JSONL RPC 和 worker 适配器。

状态：**M15e（真实模型校准 + epsilon 探索/衰减）**；M0–M4、M5a–M5c、
M6–M11、M12a、M12b、M12c、M13a、M13b、M14a、M14b、M14c、M14d、M15a、M15b、M15c、M15d、M15e 的计划项全部完成。Phase 1 的
“本地看板 + Observer 提案 + 证据门 + 单一写图者”闭环已具备；提案默认关闭。Phase 2
的触发持久化、意图优先级/预算、单项目 token/成本与并发配额、只读慢层观测、逐 Fact
成本归因与因果链，以及 reason 的 Hint/去重输出、人工重规划与资源压力触发均已落地，并
已用真实模型 gate 核对用量记账、预算耗尽、慢层 API 与 `/cost` 的一致性，见
`docs/STRATEGIST.md`。Phase 3 的完成语义已收口：项目默认按证据验证，challenge 项目按
外部挑战 API 的 `flag_count` / `flag_got_count` 验证；worker 的 “complete” 只是声明，
失败不会关项目。M14c 起 `runs` 记录真实 Solver 的模型标签（来自 `usage.json`），
UI 的 Fact 详情可沿 `run_id` 下钻到产出 run 与该任务的工具调用审计。M14d 增加只读
`/stats` 与「统计」页签，按 Worker 和模型汇总成功/失败、Token、成本与耗时。M15a 把它
接回派发：命名 worker profile 映射到 model-prefs，`worker_selection.mode: stats` 先按
配置顺序采样、再按历史成功率（Token/成本打破平局）选择，运行 model 与 profile 一并
落到 task 与 `runs`。M14a 的完成判定随后收紧：证据必须来自 run 且带 `evidence_refs`，
challenge 计数严格相等，默认策略由 `verification.evidence_enforcement` 决定，手工
`/complete` 可选 operator token。M15b 在不动图的前提下增加 Fact 取代链：Observer 的
fact 提案可用 `supersedes` 声明它取代哪些旧结论，控制面校验后写入
`fact_meta.supersedes`，读取时推导 `superseded_by`；完成 oracle 拒绝引用已被取代的
Fact，只读 `GET /projects/{id}/supersedes` 给出当前/被取代计数与边。M15c 增加只读
`GET /projects/{id}/report`：把图、完成验证、run/成本统计、审计与工件汇总合成一个
快照，`format=markdown` 渲染同一对象；审计事件原文、工件路径与证据内容不进入报告。
M15d 把这些只读视图接进静态 UI：新增「报告」页签展示完成判定、当前事实、取代边、
run/成本与审计/工件汇总，并提供 Markdown 下载；Fact 详情显示 `superseded_by` 与它
取代的旧 Fact，可点击跳转。UI 仍只发 GET（唯一例外是慢层的人工重规划）。M15e 给
`stats` 选择补上 epsilon-greedy 探索：采样期结束后按解析式预算确定何时探索，探索时选
样本最少的 profile，`epsilon` 可按 `epsilon_decay` 衰减到 `epsilon_min` 下限；策略仍由
run 历史确定性推导，不引入随机数，离线可复现。`tools/gate/m15e-calibration.ts` 用真实
model-prefs 跑一次小项目，核对每个 run 的 profile/model 记账、项目统计与报告分桶一致，
并输出当前 epsilon 与探索预算。
`cairn serve` 是可运行的 Cairn 兼容服务：SQLite schema、领域服务、全部
五个路由、YAML/timeline 导出、静态 Web UI 均已就位，并用 Python Cairn 生成的 golden
做了逐字对照。进程内 scheduler、任务/结果文件 worker 协议、BreachWeave Solver 接入已在 M2
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

- **证据门控**：worker 可在 `result.json` 根级返回 `evidence_refs`（工作区相对路径）；
  模型写进 `data` 的 `evidence_refs` 会由 worker 提升到根级。控制面在写图前逐条校验：
  拒绝绝对路径、`..`、目录、符号链接、不存在或越界；最多 20 条、每条 ≤512 字符。
  省略/空数组记为 `evidence_status: "missing"`，不拒绝；一旦声称却非法，任务失败
  （explore/bootstrap 仍走 conclude 回退）。
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

M6 增加：

- **session 保留策略**：`retention.session_max_age_days` 与
  `session_keep_per_project`（默认都为 `0`，即保留全部）。sweep 只扫描
  `<workspace>/.cairn/sessions` 的直接子目录，跳过符号链接；正在运行的任务目录、
  待恢复的 conclude 会话，以及所有 `pending_concludes` 指向的目录不会被删除（受保护
  目录仍占 keep 名额）。保护信息查询失败时整轮跳过删除（fail closed）。
- **启动与周期 sweep**：`cairn serve --config` 在首次派发前跑一次 sweep，之后按
  `retention.sweep_interval_seconds`（默认 3600，`0` 关闭周期执行）重复；启动 sweep
  先对账 `pending_concludes`，避免上一进程遗留的无效行占用队列。
- **pending 对账**：项目不存在/非 active、intent 已结束或不存在、会话目录里已没有
  `solver-session/*.jsonl` 时删除该行；会话缺失且 intent 仍开放时同时释放租约，
  让 explore 正常重试。
- **artifacts 刷新**：`retention.refresh_artifacts: true` 时每次 sweep 重建 artifacts
  索引；已索引路径保留最初记录它的 `task_id`，新路径记为 `retention-sweep`。

M7 增加：

- **控制面审计账本**：任务结束（成功、失败、取消）时，控制面读取
  `<sessionDir>/audit.jsonl`，按行写入 `audit_events` 旁路表（项目、task、seq、
  事件 JSON、`prev_hash`、`hash`）。哈希绑定项目/task/序号/前一条哈希/事件文本，
  每个 task 一条独立链。
- **有界导入**：只接受普通文件（不跟随符号链接），最多 8 MiB / 10,000 条，单条
  ≤16K 字符；空行、非 JSON、非对象和超长行跳过并计数。已有同内容前缀时不重复追加
  （M9 起实时流留下的前缀由文件导入补写缺失后缀）；导入失败只记日志，不影响任务结果。
- **只读查询**：`GET /projects/{id}/audit` 返回每个 task 的
  `event_count`/`root_hash`/时间范围；`GET /projects/{id}/audit/{task_id}` 返回事件
  与重新计算的 `chain_ok`/`broken_at`。未知项目 404，无记录的 task 返回空链。
  `GET /projects/{id}/audit/{task_id}/stream-lost` 单独返回实时流丢失状态，
  不改变上面的空链响应形状。
- 账本存放在 SQLite，因此 session 目录被 M6 retention 清理后审计仍可查询。哈希链
  能发现账本行被改写或链接断裂，但不是签名：能重写数据库的人也能重算整条链，
  且控制面崩溃前未 finish 的事件不会进入账本。

M8 增加：

- **任务级 artifacts 命名空间**：`runtime.max_project_workers > 1` 时默认开启
  `worker.scoped_artifacts`（可显式 `false` 关闭）。scheduler 为每个任务写入
  `artifactDir: "artifacts/<task-id>"`，prompt 追加 Artifact Policy；Host Bridge 的
  `write` / `edit` 只允许写本任务目录，读仍可跨任务。`evidence_refs` 使用该命名空间。
- **索引溯源**：artifacts 索引的 `task_id` 表示“最初产生该路径的任务”。后续任务重扫
  全树时不会改写已有行；新出现的 `artifacts/<task-id>/...` 直接按目录名归属。
- **项目级 Observer 复核租约**：review 开始前获取 `<board>/locks/review.lock` 跨进程
  租约，带心跳、过期接管和有界等待。拿不到租约时本轮 review 跳过（审计
  `review_skipped`，reason `board_lock_busy` / `board_lock_error`），不阻塞 solver
  收尾，也不改变 `result.json`。
- **并发集成测试**：两个同项目 explore 任务在 `max_project_workers: 2` 下通过工作区内
  的 rendezvous barrier 真正重叠执行，验证两个 Fact、两条成功 run、各自的 artifacts
  索引与 provenance，以及 task.json 中的命名空间和 prompt 注入。

边界：命名空间与 locks 都是**策略级**协调，不是内核隔离。`bash` 仍可直接写共享工作区
或另一个任务的 artifacts 目录（审计会记录命令，但不解析路径）；写看板仍受同样的
`bash` 限制。需要强隔离时使用容器/只读挂载。

M9 增加：

- **实时审计流（可选）**：`audit_stream.enabled: true` 时，scheduler 为每个任务签发
  独立 bearer token（只保存 SHA-256，按任务批量复用），通过 `CAIRN_AUDIT_STREAM_URL` /
  `CAIRN_AUDIT_STREAM_TOKEN` 注入 worker；Host Bridge 在写完 `audit.jsonl` 后把同一条
  事件按 `(task_id, seq)` 推送到 `POST /projects/{id}/tasks/{task_id}/audit`。token 绑定
  项目与任务，任务结束立即撤销，且不写进 `task.json`/prompt/日志。
- **幂等链式追加**：控制面按显式 `seq` 校验并追加到现有哈希链。重试内容一致算重复
  （`duplicates`），乱序、缺号或同号异内容返回 409，不续写、不分叉。
- **有界发送与降级**：worker 侧队列、批量、请求超时和重试预算都有上限；认证失败、
  链冲突或队列溢出让发送器永久停止并写本地 `audit-stream-lost.json`，不会跳过序号。
  任务结束时仍导入 `audit.jsonl`，只补写缺失的后缀，因此实时流只降低暴露窗口，不改变
  M7 的最终一致性。
- **默认关闭**：容器模式无法自动推断控制面地址，必须显式配置 `audit_stream.url`；
  本地模式缺省使用实际监听的 loopback 地址。关闭时行为与 M7 完全相同。容器模式需要
  控制面在容器可达的私网/网关地址上监听，此时应为整个 API 加网络层访问控制：任务
  token 只保护这一条审计写入路由，不能替代其它路由的认证。

M9.1 收尾：

- **token 传输**：容器模式下 `CAIRN_AUDIT_STREAM_TOKEN` 的值只放在 `docker exec`
  客户端进程的环境里，argv 仅出现 `-e CAIRN_AUDIT_STREAM_TOKEN`；宿主进程列表不再
  暴露 token。其它 worker 环境变量仍走 `-e NAME=value`。
- **丢失可见性**：任务结束时读取 worker 写的 `audit-stream-lost.json`，校验普通文件、
  64 KiB 上限、JSON 字段与非负计数后写入 `audit_stream_lost` 表；只读路由
  `GET /projects/{id}/audit/{task_id}/stream-lost` 返回
  `{task_id,stream_lost}`。畸形/符号链接/超限 marker 以通用 `invalid`/`unreadable`
  落库；该旁路只用于可见性，不改变任务结果或 `audit.jsonl` 的补写。
- **请求边界**：实时审计路由先检查 `Content-Length`，再按块读取并在超过 1 MiB 时
  立即取消；单条事件文本与文件导入共用 16,384 字符上限，超限返回 400。
- **真实容器验证**：新增 `tools/gate/m9-audit-stream-gate.ts`，用真实容器中的 Host
  Bridge 向真实控制面流式写 allow/block，验证链路、重放幂等、撤销后 401 和 token
  不出现在 worker 输出；不需要模型凭据。

M10 增加：

- **只读运维面板**：现有单文件 Alpine.js UI（界面文案为中文）增加第二行
  `运行 / 审计 / 证据` 页签，仍由 `GET /` 与 `/static/*` 直接提供，没有构建步骤。
  - Runs：`GET /projects/{id}/runs`，显示 kind、worker、outcome、退出码、时长、
    evidence 数量与 detail，并可跳到对应 task 的 Audit。
  - Audit：`GET /projects/{id}/audit` 的任务汇总、`/{task_id}` 的哈希链与事件、
    `/{task_id}/stream-lost` 的实时流丢失标记；断链、allow/block 和 gap 均有显式状态。
  - Evidence：按 Fact 选择后读取 `/{fact_id}/meta` 与 `/{fact_id}/evidence`，显示
    `provided/missing/legacy`、写入时摘要与当前 `ok/modified/missing/unreadable/
    invalid/unverified` 校验结果。
- **只读边界**：所有面板只调用 GET；打开页签或点刷新才拉取，不参与写图、调度或
  scope 判定。UI 本身没有认证，容器/远程部署仍必须由网络层限制整个控制面 API 的访问。

M11 增加：

- **Observer 提案闭环（默认关闭）**：sidecar 新增 `propose_graph_change` 工具，只能把
  候选 fact / intent / hint 写成任务级
  `<session>/observer/proposals/<uuid>.json`；没有新增 HTTP 写路由，主 Solver 也不能写
  该目录（Host Bridge 把整个 `<session>/observer/` 视为只读）。任务结束时 scheduler
  读取候选文件（普通文件、非符号链接、单文件/总量/条数上限），校验结构后写入
  `proposals` 旁路表。
- **控制面审核**：每条 pending 提案单独事务处理。`hint` 按内容去重；`intent` 要求
  `dedupe_key`，按“未结束 intent / 已应用提案”去重，创建未认领 intent；`fact` 必须有
  来源 Fact 与通过 `collectEvidence` 校验的证据，然后走与 worker 相同的
  `createIntent` + `concludeIntent` 写图，并记录 `run_id` 与证据摘要。项目非 active
  时拒绝（`project_inactive`）。
- **三种模式**：`proposals.mode: off | dry_run | apply`。`dry_run` 完整执行来源、证据与
  重复校验，但只把结果记为 `dry_run`，不写图；`apply` 才真正写入。所有决策
  （`applied / rejected / duplicate / dry_run`）带 `decision_reason` 与 `applied_id`。
- **只读观测**：`GET /projects/{id}/proposals` 支持 `status`/`kind` 过滤；UI 增加第四个
  只读页签“提案”，显示候选内容、来源、证据、去重键、审核结果与写入 ID。提案文件与
  `proposals` 表都是旁路数据，YAML 导出与 Cairn 图语义不变。
- **失败隔离**：候选解析/审核错误只记日志并落为 rejected，不影响任务结果、退出码或
  `result.json`；重新导入同一保留会话目录是幂等的（提案 ID 由项目、任务、文件名派生）。

M12a 增加：

- **持久化触发状态**：新旁路表 `strategist_state` 按项目保存最近一次 reason 成功的
  Fact/Hint/open-intent 水位、成功/尝试/失败时间、trigger 与 run id。控制面重启后，
  未变化的图不会再触发 reason；失败只写 attempt/failure，不推进水位，因此重试仍能看到
  同一批 delta。表随项目级联删除，不进入图导出或 worker 契约。
- **事件触发**：`reason` 不再对每个新 Fact 无条件触发。纯函数求值器按顺序判断失败退避、
  `initial`、`open_intents:N->0`、零产出连续 run、陈旧意图、Fact/Hint 增量、空闲 fallback，
  并统一施加 `tasks_running`、冷却与滚动一小时配额。`initial` 与 open-intent 清空是紧急
  触发，绕过冷却/配额但不绕过失败退避；`initial` 还会让路给未认领的 explore 意图。
- **策略配置**：新增 `strategist` 段（8 个非负整数字段，含关闭开关）；默认
  `cooldown_seconds: 30`、`failure_backoff_seconds: 120`、`max_runs_per_hour: 12`、
  `zero_output_threshold: 3`，其余阈值见示例配置。抑制日志按项目/原因去重。
- **可观测性**：`runs.trigger` 记录实际触发串，`strategist_state.last_trigger` 保留最近
  一次；M12a 本身不新增 HTTP 路由或 UI，由 M12c 补齐。详见 `docs/STRATEGIST.md`。

M12b 增加：

- **意图优先级与意图级预算**：reason 输出的 intent 可带 `priority`（`0..100`，默认 50）
  与 `budget.max_seconds` / `budget.max_tool_calls`。它们落在旁路表 `intent_meta`
  （`source='strategist'`），不改变 Cairn 图或 YAML。快层按
  `priority DESC, created_at DESC, id DESC` 选择未认领 explore 意图；reason 触发时仍
  先于 explore。`max_seconds` 只收紧任务超时，`max_tool_calls` 传给 Host Bridge，
  超限拒绝以 `tool_budget_exhausted` 进入审计。
- **单项目预算与并发配额**：顶层 `budget` 段支持 `max_project_tokens`、
  `max_project_cost_usd`、`max_project_tasks`（`0` 关闭/继承）。token/成本按该项目
  所有已结束 run 汇总后拦截新 bootstrap/reason/explore；pending conclude 不受拦截，
  以免失败的意图永久卡住。
- **用量记账**：worker 在 solver 结束后写 `<sessionDir>/usage.json`（失败任务也写），
  控制面读取后落到 `runs` 的六个用量列；`GET /projects/{id}/runs` 自动带出这些字段。

M12c 增加：

- **只读慢层 API**：`GET /projects/{id}/strategist?limit=20` 返回
  `{state, budget, intents, reason_runs}`。`state` 是持久化触发水位；`budget` 含已用
  token/成本、在途任务数、配置上限（纯 HTTP 模式为 `null`）与 token/成本/并发耗尽标记；
  `intents` 只列未结束意图并按派发优先级排序，附带 `priority`/`budget`/`source`；
  `reason_runs` 只含 reason 且最新在前。`limit` 默认 20、范围 1–100，未知项目 404，
  非法值 400，只有 GET。
- **“慢层”页签**：现有 Alpine UI 新增只读面板，显示预算、触发水位、未结束意图与推理
  历史。它只调用该路由的 GET，不新增任何写操作或 schema/worker 契约变更。
  用量是尽力而为的主会话计数，不是计费凭证；在途任务和子代理可能造成偏差。
  详见 `docs/STRATEGIST.md` 第 6–9 节。

M13a 增加：

- **真实模型成本基线 gate**：`tools/gate/m13-cost-baseline.ts` 在临时工作区用真实
  BreachWeave Solver 跑一个有界项目（bootstrap 关闭，首个 reason 负责初始方向），逐任务
  核对 `<sessionDir>/usage.json` → `runs` 六个用量列 → `getProjectUsage()` →
  `GET /projects/{id}/strategist` 的汇总一致，并断言触发水位、reason 历史、意图排序与
  预算上限。预算模式（`CAIRN_GATE_EXPECT_EXHAUSTED=1`）验证越过 token 上限后不再派发新
  的 bootstrap/explore/reason。报告默认写入 `runs/m13-baseline.json`（该目录不入库）。
- **启动快照脱敏**：真实 Solver 的 `startup.json` 曾把
  `sessionOptions.authStorage.data.<provider>.key` 原文写进项目工作区。
  `packages/agent/src/solver/session.ts` 现在按字段名脱敏
  `key/token/secret/password/authorization/credential` 等，主 Solver 与子代理快照一致；
  gate 会扫描项目工作区文本文件，发现 `auth.json` 里的凭据值立即失败，且只报告路径。
- **基线结果（2026-10-26，`deepseek-flash`）**：默认 gate 跑 3 个 reason + 2 个 explore，
  共 **134,740 tokens**（input 10,954 / output 5,898 / cache_read 117,888，缓存读占
  87.5%），耗时 65 秒，产出 2 个 Fact。慢层 74,273 tokens（55.1%），快层 60,467 tokens；
  全项目摊薄约 67,370 tokens/Fact（两个 explore 的直接归属分别为 36,438 与 24,029）。
  M13b 归因显示：Fact 直付 60,467，reason 创建意图的编排分摊 24,115（两个意图各一半），
  已归因 84,582，因两个 reason 验证轮没有创建意图而留下 50,158 未归因。网关未返回价格
  （`models.json` 的 cost 为 0），因此报告把 token 作为基线、费用记 0 并给出 warning；
  可用 `CAIRN_GATE_PRICE_*_PER_M` 在报告中估算美元成本。该轮两个 Fact 都没有被接受的证据，
  说明“完成项目”与“可复核证据”在当时仍是两件事；M14a 已把这个缺口补上。
- **M14a 证据强制基线（2026-10-26，`deepseek-flash`）**：gate 新增“完成策略为 evidence”
  “最近一次 `verification_checks` 通过”“每个动态 Fact 有已接受证据”“marker 出现在 Fact
  描述或被接受的证据文件”四项断言。成功轮共 3 个任务（2 reason + 1 explore）、
  **132,967 tokens**（input 12,317 / output 8,522 / cache_read 112,128，缓存读占 84.3%），
  1 个 Fact 带 `provided` 证据，项目由 oracle 判定完成后关闭，45/45 检查通过。模型的探索
  拆分差异会显著影响用量（同配置的失败试跑达到 23–25 万 tokens），token 只作量级基线；
  报告写入 `runs/m14a-baseline.json`。

M13b 增加：

- **意图来源溯源**：`intent_meta` 新增 `origin_run_id`；reason 输出与 Observer 提案
  被应用时记录创建该意图的 run。旧库自动补列，历史意图保持 `null`（来源无法回溯）。
  这不改 Cairn 图、YAML 导出或 worker 契约。
- **只读成本 API**：`GET /projects/{id}/cost` 返回项目总用量、按 run kind 汇总、
  `attribution`（事实直付 / 编排分摊 / 已归因 / 未归因）、逐 Fact 成本、逐意图成本、
  逐 run 产出与 `edges` 因果边。分配规则是每个 run 的用量平均分给直接产出（创建的
  意图 + 产出的事实），意图的创建份额再分给它产出的事实；失败的 run、无产出 reason
  和无 Fact 意图留在 `unattributed`。**事实成本合计是项目用量的分区；意图成本包含
  执行 run，与事实合计重叠，不能相加。** 只有 GET；未知项目 404，其他方法 405。
- **“成本”页签**：现有 Alpine UI 新增只读面板，展示总量、归因完整性、按类型汇总、
  每个 Fact 的直付/编排成本及其来源 run/意图、意图执行成本、因果边与 run 产出。
  它只调用 `/cost` 的 GET，不新增写路由或调度行为。
- **gate 扩展**：`tools/gate/m13-cost-baseline.ts` 额外核对 `/cost` 的总量与
  `by_kind` 和 `runs` 行一致、`attributed + unattributed = total`、动态 Fact 有直付
  归属且能回溯创建意图的 run、所有因果边只引用已记录节点，并确认 POST 被拒绝。

M14a 增加（Phase 3 收口）：

- **完成不再由模型自证**：项目创建时可选 `verification.kind`：`challenge`（外部挑战
  API 计分）、`evidence`（默认）、`off`。`verification.evidence_enforcement`
  （`completion` 默认 / `off`）决定 API 新建项目与旧项目的默认策略，只在完成时强制，
  探索阶段保持宽容。worker 返回的 `complete` 只是声明；scheduler 在写完成前调用
  oracle。验证失败时 reason 释放租约、项目保持 active，bootstrap 仍保留已产出的 Fact
  但推迟完成；每次判定写入 `verification_checks`。手工
  `POST /projects/{id}/complete` 仍是显式的操作员覆盖；设置 `CAIRN_OPERATOR_TOKEN`
  后该路由要求 `X-Cairn-Operator-Token`。
- **challenge oracle**：从 `data.challenges[]` 按 `code` 读取 `flag_count` /
  `flag_got_count`，只有 `flag_got_count == flag_count > 0` 才通过（计数不一致也失败）。
  基址与 Agent-Token 只按**环境变量名**读取（默认 `TCH_CHALLENGE_API_BASE_URL` /
  `TCH_CHALLENGE_AGENT_TOKEN`，可在 `verification.challenge` 改名）；配置、任务文件、
  日志和数据库只保存计数，不保存 flag 明文或 token。
- **evidence oracle**：reason 的 `complete.from` 中每个非种子 Fact 必须关联到一次
  run（`fact_meta.run_id` 非空）、`evidence_status = provided`、`evidence_refs` 非空
  且至少一条 `fact_evidence`；`origin` / `goal` 是前提，不作为证据要求，但只有种子
  Fact 的完成声明仍然失败。bootstrap 用任务级 `evidence_refs` 校验（它的 Fact 在同一
  事务里新建）。缺少证据的完成声明被拒绝，并记录缺口。
- **只读查询与手动复核**：`GET /projects/{id}/verification` 返回策略与最近一次检查；
  `POST /projects/{id}/verify` 可手动重跑（可带 `facts` 子集）。两种策略的判定都会入
  `verification_checks`。
- **prompt 契约**：每个任务的 prompt 末尾追加 Completion Verification 段；
  BreachWeave 入口也明确要求 `evidence_refs`，并提示不要写 flag 明文或凭据。
  详见 `docs/VERIFICATION.md`。

M14b 增加（Phase 2 补全）：

- **reason 输出扩展**：一次 reason 可同时返回 `intents` 与 `hints`，也可在仍有未结束
  意图时只返回 `hints`。意图可带 `priority`（0–100，默认 50）、`budget`
  （`max_seconds` / `max_tool_calls`）与 `dedupe_key`（≤128 字符）；控制面按未结束意图
  的 dedupe key 跳过重复方向，按去空白后的内容跳过重复 Hint。`complete` 不能与
  `intents` / `hints` 并存。
- **prompt 扩展**：reason prompt 末尾追加 Strategist Output Extensions（输出示例、
  priority/budget/dedupe 语义、Hint 不是证据、禁止写 flag/凭据）；启用预算时再附
  Resource Budget（已结束 run 的 token/成本与上限）。默认 prompt 模板保持与 Python
  Cairn 逐字一致，扩展只在运行时拼接。
- **人工重规划**：`POST /projects/{id}/replan`（body 可省略；`reason` ≤500 字，
  `requested_by` ≤128 字，默认 `human`）把请求持久化到 `strategist_state`。scheduler
  把它当作 urgent `manual_replan` 触发，跳过冷却与小时配额，但仍受失败退避和
  “有生产任务在跑”约束；成功或失败后自动清除。reason 租约已占用返回 409，非 active
  项目返回 403。只读「慢层」页签新增“请求重规划”操作。
- **资源压力触发**：`strategist.resource_pressure_ratio`（0–1，默认 `0` 关闭）。已结束
  run 的 token 或成本用量达到配置比例时，以非 urgent 的
  `resource_pressure:tokens:80%,cost_usd:90%` 触发一次 reason；同一压力区间不重复触发，
  直到水位被其他触发覆盖。

M14c 增加（可观测性补链）：

- **runs 记录模型**：`usage.json` 新增可选 `model`（`provider/model-id`，≤200 字符，
  拒绝空白与控制字符）。BreachWeave worker 从真实 Solver 会话读取模型，只在写出用量
  时一并落到 `runs.model`；fake solver、没有用量的任务和被硬杀的任务保持 `null`。
  `GET /runs`、成本归因与 UI 直接读这一列，不改图模型、YAML 导出或既有响应。
- **Fact → run → 工具调用下钻**：选中单个 Fact 时，UI 用
  `GET /facts/{id}/meta` 的 `run_id` 定位产出 run（优先复用已加载的 runs，否则补一次
  GET），显示 run、模型与 task id；“查看工具调用”把审计页签切到该 task 的链式事件。
  多选或选择 origin/goal 时清空溯源。新增调用全部是 GET。
- **验证**：新增契约、图迁移/回读、solver 模型格式化、scheduler 用量、HTTP 下钻链路
  与 UI GET-only 测试；并在浏览器中实测选中 Fact 后显示 run/model/task、点击后看到
  该任务的 read/grep/bash 审计事件（`chain_ok: true`）。

M14d 增加（逐 Worker/模型统计）：

- **只读统计路由**：`GET /projects/{id}/stats` 从 `runs` 旁路表汇总 `totals`、
  `by_worker` 与 `by_model`。每组包含运行数、运行中、已结束、成功/失败/拒绝/取消/
  不健康/未激活计数、`success_rate`（成功 ÷ 已结束；没有结束运行时为 `null`）、
  Token、成本、平均耗时、证据数与最近启动时间。未知项目 404，只有 GET。
- **「统计」页签**：Alpine UI 新增只读页签，显示项目总览与按 Worker、按模型两张分组
  卡片。模型为 `null` 的运行归入“未记录模型”，不会被当成 0% 成功率；若该组有拒绝或
  失败运行，成功率仍按已结束运行计算。
- **已知边界**：统计按项目隔离；`model` 只随 `usage.json` 在任务结束时落库，所以在跑
  任务暂时归入“未记录模型”，被硬杀的任务也没有模型。当前 `worker` 仍固定为
  `cairn-worker`，统计只提供数据，尚未改变派发。

M15a 增加（Worker Profile 与统计驱动选择）：

- **命名 Profile**：`worker_profiles` 是 `{id, model}` 列表，`model` 指向
  `model-prefs.json` 条目；id 限 `[A-Za-z0-9][A-Za-z0-9._-]*` 且唯一。凭据仍只在
  agent 配置里，派发表只写 profile id 与模型名。
- **模型覆盖贯通**：scheduler 把选中的 profile 写进 `task.json` 的 `workerProfile` /
  `model`；worker 用 `model` 覆盖 prompt frontmatter 的模型，不再要求为每个 profile
  复制一份 prompt。`runs.worker_profile` 由 M15a 迁移补齐，prompt 模式与旧行为保持
  `NULL`。
- **选择策略**：`worker_selection.mode: prompt`（默认）完全保持原行为；`stats` 先按
  配置顺序采样，直到每个 profile 有 `min_runs` 个已结束 run，然后取成功率最高者，
  依次用“每结束 run 的 Token 更少”“成本更低”“配置顺序靠前”打破平局。失败的
  explore 排队的 conclude 会复用该任务的 profile（仍配置时），避免用另一个模型接管
  原会话。
- **观察**：`GET /stats` 新增 `by_profile`，只统计打过 profile 的 run；「统计」页签
  新增“按 Profile”卡片，prompt 模式下为空。
- **验证**：配置测试覆盖默认值、解析与非法 id/重复/缺 model/`stats` 无 profile；
  契约测试覆盖 task 字段；图测试覆盖迁移、回读与跨项目 profile 聚合；选择单测覆盖
  采样、利用与全部平局规则；scheduler 集成测试确认前几个任务按配置顺序采样并落到
  run；HTTP/UI 测试覆盖 `by_profile` 与页签文案。

M15b 增加（Fact 取代链）：

- **只追加的取代关系**：新 Fact 不修改旧 Fact；`fact_meta.supersedes` 记录它取代
  哪些旧 Fact，反向 `superseded_by` 在读取时推导。未知/自指/重复目标被忽略；同一目标
  被多次取代时按 `created_at` 取最新，时间相同按取代者 id 决定，结果稳定。
- **写入与校验**：只有 Observer 的 `fact` 提案可带 `supersedes`（≤20 个、每个 ≤64
  字符）；控制面拒绝取代 `origin`/`goal`、目标不存在、目标已被取代，避免链式二次替换。
- **完成语义**：evidence oracle 拒绝引用已被取代 Fact 的完成声明（`fact was superseded
  by fXXX`），旧结论不能关闭项目。
- **观察**：只读 `GET /projects/{id}/supersedes` 返回当前/被取代计数与边；
  Fact meta 同时暴露 `supersedes` 与 `superseded_by`。
- **验证**：图测试覆盖反向边、重复目标取最新、平局规则、未知/自指忽略与计数；提案
  测试覆盖正常写入与四类拒绝；Observer 候选测试覆盖 fact 透传、非 fact 拒绝与上限；
  oracle 测试确认旧 Fact 不能完成；HTTP 测试覆盖响应、404 与只能 GET。

M15c 增加（项目报告导出）：

- **一个快照**：`buildProjectReport` 组合既有读取——项目与图、完成策略与检查汇总、
  run 总量与按 worker/model/profile 分桶、成本与 `by_kind`、审计任务/事件计数、工件
  文件数与字节数。不新增图语义、不写图；与其它读端点一样会顺带清理过期租约。
- **当前 Fact**：报告排除已被取代的 Fact 并单列取代边；`graph.current_facts` 与
  `current_facts.length` 一致。
- **脱敏**：`audit` 只有计数与时间边界，`artifacts` 只有文件数与字节数；审计事件
  原文（可能含命令输出与凭据）、工件路径与证据文件内容都不导出。挑战验证只读并导出
  `flag_count` / `flag_got_count`，不读取 flag；Fact 与 Hint 按图原样导出。
- **HTTP**：`GET /projects/{id}/report` 默认 JSON，`format=markdown` 返回人读版本；
  非法 `format` 400、未知项目 404、非 GET 405。Markdown 渲染折叠换行并转义表格。
- **验证**：图测试覆盖空项目、取代排除、run/成本分桶、验证与工件汇总、旧项目策略
  回退、审计脱敏与 Markdown 稳定性；HTTP 测试覆盖 JSON、Markdown、400/404/405。

M15d 增加（报告页与取代视图）：

- **报告页签**：「报告」读取 `GET /projects/{id}/report`，显示完成判定（策略、通过/
  失败、最近检查、题目编号）、图状态（当前/全部 Fact、被取代数、意图、Hint）、当前
  Fact、取代边、run 总量与按 worker/model/profile 分桶、审计与工件计数。打开页签或
  点刷新时拉取；错误在面板内显示并可重试。
- **Markdown 导出**：面板右上角链接到 `GET /projects/{id}/report?format=markdown`，
  由浏览器直接下载；UI 不重新渲染 Markdown。
- **取代视图**：Fact 详情在 `meta.superseded_by` 或 `supersedes` 非空时显示“取代关系”；
  被取代的 Fact 标出取代者，取代者可点回旧 Fact，二者都复用现有图选择。报告页签同时
  列出项目内全部取代边。
- **只读约束**：新增 loader 只发 GET；报告与取代视图不改变调度、图或旁路数据。
- **验证**：UI 静态测试覆盖页签、`loadReport` 的 GET-only 约束、报告/取代文案与
  Markdown 链接；全量测试与 typecheck 通过。

M15e 增加（epsilon 探索与真实模型校准）：

- **探索时钟**：`stats` 模式先按配置顺序采样到每个 profile 有 `min_runs` 个已结束
  run；之后每个 profile 的平均样本数构成“合格 run”计数。选择器用解析式累计预算
  `Σ ε·decay^k`（到 `epsilon_min` 下限后保持）判定本次是否探索：累计预算的整数部分
  增长时派发一次探索，否则利用当前成功率最高的 profile。
- **探索目标**：探索时选已结束 run 最少的 profile（配置顺序打破平局），把样本补向
  短板；利用规则与 M15a 相同（成功率 → Token → 成本 → 配置顺序）。整套判断只读取
  `runs.worker_profile` 历史，不含随机数，冷启动/重放结果稳定。
- **衰减与关闭**：`epsilon`（默认 `0.1`）、`epsilon_decay`（默认 `0.99`，须
  `0 < decay ≤ 1`）、`epsilon_min`（默认 `0.01`，不得大于 `epsilon`）。`epsilon: 0`
  关闭探索，回到纯 M15a 行为；`epsilon_min: 0` 让衰减最终淘汰探索。
- **真实模型校准**：`bun run tools/gate/m15e-calibration.ts` 用 agent 配置中的真实
  model-prefs 跑一个临时项目（默认最多 2 个任务），断言 run 都带配置内 profile、两个
  profile 都拿到任务、至少一个 run 上报模型、`by_profile` 与项目 run 一致、报告分桶与
  统计一致，并输出当前 eligible/epsilon/预算/下一次是否探索。默认两个 profile 映射同一
  model-prefs 时只校准记账而非模型质量；用 `CAIRN_GATE_PROFILE_B_MODEL` 指向第二个条目
  才能比较模型。该 gate 调用真实模型，默认不进 `bun test`。
- **验证**：选择单测覆盖采样后首次探索、最少样本优先、衰减/下限/关闭与首选 profile
  优先级；配置测试覆盖 `epsilon` 范围、`decay` 的 `(0,1]` 约束与 `min ≤ epsilon`；
  全量测试与 typecheck 通过。

默认仍是确定性 fake solver，测试与离线运行不需要模型凭据。Observer 只接在
`CAIRN_SOLVER=breachweave` 的真实 Solver 路径上，fake solver 会忽略它。

## 三个已定决策

1. **控制面 + 每项目 worker 进程**：`cairn serve` 是唯一写图者；worker 跑在项目沙箱里，
   按任务拉起，不是常驻守护进程。同一项目默认串行（`max_project_workers: 1`）；提高
   上限时由 M8 的 artifacts 命名空间与 Observer 复核租约协调共享工作区。
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
        ├─ Observer（可选）：主 Solver 只读项目看板；独立 sidecar 维护看板并提交候选
        ├─ 提案候选：<session>/observer/proposals/*.json（控制面在任务结束时导入）
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
  http/static/           Cairn Web UI + 只读 运行/慢层/审计/证据/提案 面板（无构建步骤）
  config.ts              dispatch.yaml 校验（Bun.YAML）
  prompts/prompting.ts   prompt 加载、渲染、JSON 格式化、占位符校验
  prompts/default/*.md   上游默认 prompt（逐字复制）
  prompts/mock/*.md      上游 mock prompt（逐字复制）
  scheduler/loop.ts      tick、派发、租约、超时、artifacts、切片选择、Observer env、runs
  scheduler/tasks.ts     prompt 渲染 + 路径映射 + task.json/context 落盘
  scheduler/evidence.ts  证据校验、哈希与实时比对（工作区包含、realpath、上限）
  scheduler/proposals.ts 候选文件导入、结构校验、证据/去重审核与图写入
  scheduler/strategist.ts 慢层触发求值（水位、事件、退避、冷却、小时配额）
  scheduler/retention.ts session 目录扫描、age/count 选择与受保护路径判定
  scheduler/audit.ts     有界读取 audit.jsonl 并导入控制面账本
  verification/oracle.ts 完成 oracle：evidence / challenge / off 与检查历史
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
  src/cost.ts            逐 Fact/意图成本归因与因果边（只读，M13b）
  src/fact-evidence.ts   fact_evidence 内容摘要读写
  src/pending-concludes.ts 跨重启的 conclude 队列
  src/proposals.ts      proposals / intent_meta 旁路表与去重查询
  src/strategist.ts     strategist_state 水位与 reason run 摘要/计数
  src/verification.ts   项目验证策略与 verification_checks 旁路表
  src/audit.ts           控制面审计账本：哈希链、查询与断链校验
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
tools/gate/m6-restart-gate.ts    fake solver 的跨进程 conclude 恢复 gate（不计费）
tools/gate/m13-cost-baseline.ts  真实模型的用量/预算/慢层与成本归因 gate（计费）
tools/vendor/            vendor 资产生成器
runs/m13-baseline.json   最近一次真实模型基线报告（本地生成，不入库）
docs/ARCHITECTURE.md     角色、数据所有权、时序、沙箱、失败语义
docs/OBSERVER.md         Observer 实现、配置、权限、flush 语义与已知限制（M4c）
docs/STRATEGIST.md       慢层触发、意图优先级/预算、Hint/去重、人工/资源触发、成本归因（M12a–M14b）
docs/VERIFICATION.md     完成验证：策略、oracle、路由、失败语义与安全边界（M14a）
docs/REPORT.md           项目报告：JSON 结构、来源、排序、脱敏与边界（M15c）
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
- 已知边界：看板写保护只覆盖结构化文件工具；`bash` 仍可在工作区内写看板。同项目并发
  时由 M8 的项目级 review 租约串行化复核（拿不到租约就跳过本轮），但看板写入本身仍是
  策略级保护。详见 `docs/OBSERVER.md`。

### 图提案（M11，可选，默认关闭）

提案让 Observer 的结论进入 Cairn 图，但**不把写权限交给 worker**。sidecar 只能写候选
文件；控制面是唯一审核者和写图者。

```yaml
observer:
  enabled: true
  kernel_tasks: ["explore"]

proposals:
  enabled: true
  mode: apply                 # off | dry_run | apply
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
- `dry_run` 适合先观察模型会提出什么：它执行全部校验，但只记录 `dry_run`，不写图。
- 只读查询：`GET /projects/{id}/proposals[?status=&kind=]`；UI 的“提案”页签同样只发
  GET。控制面 API 仍未认证，远程/容器部署必须加网络层访问控制。

### 慢层触发（M12a）

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

### 调度优先级与项目预算（M12b）

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

### 慢层只读视图（M12c）

```bash
curl "http://127.0.0.1:8000/projects/<project_id>/strategist?limit=20"
```

- 响应含 `state`（`strategist_state` 或 `null`）、`budget`、`intents` 与 `reason_runs`。
- `budget.limits` 只在 `cairn serve --config` 时出现；纯 HTTP 模式返回 `null`，但仍显示
  已记录用量。`budget.running_tasks` 统计 `runs.outcome IS NULL`，可能与调度器内存状态
  因崩溃遗留而略有差异；`exhausted.tasks` 只在 `max_project_tasks > 0` 时判断。
- UI 的“慢层”页签显示同一数据；API 仍未认证，远程/容器部署需要网络层访问控制。

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

## 验证（M1 + M2a + M2b + M2c + M3 + M4a + M4b + M4c + M5a + M5b + M5c + M6 + M7 + M8 + M9 + M9.1 + M10 + M11 + M12a + M12b + M12c + M13a + M13b + M14a + M14b + M14c + M14d + M15a + M15b + M15c + M15d + M15e，2026-10-27，Bun 1.4.4）

- `bun test`：**545 passed**（62 个文件），0 failed。
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
  与负值/非整数拒绝也有覆盖；`retention` 四个字段的默认值、合法覆盖与
  负值/非整数/非布尔拒绝同样有断言；`strategist` 的 9 个默认值、完整覆盖与
  负数/类型/非对象拒绝也有断言（含 `resource_pressure_ratio` 的 0–1 校验）。
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
- **保留与重启恢复（M6）**：`retention.ts` 覆盖扫描顺序、忽略文件/符号链接、age 规则、
  keep count（受保护目录仍占名额）与双规则关闭。sweep 集成测试覆盖：无效 pending 行
  （会话缺失、intent 已结束/不存在、项目已完成）在对账时删除并释放租约，有效行保留；
  过旧目录按 age 删除、超出 keep 的目录按 count 删除，而受保护的排队会话与工作区内
  其它文件不受影响；`refresh_artifacts` 重建索引并保留原有 `task_id`。跨进程 gate
  `tools/gate/m6-restart-gate.ts` 为 **9/9 PASS**（2026-10-25）：新启动的
  `cairn serve` 从持久化状态直接派发 conclude，随后队列清空、Fact 与 run 证据落库。
- **审计账本（M7）**：图侧覆盖链式写入、每 task 独立序号与 `prev_hash`、重复导入不追加、
  项目/任务隔离、未知项目 404、改写事件或断开链接后的 `broken_at`、非对象事件拒绝与
  项目删除级联。导入侧覆盖空行/非法 JSON/标量/数组/超长行跳过、缺失路径、目录替代、
  符号链接拒绝、10,000 条上限与空文件；scheduler 集成测试用 `audit-worker` fixture
  断言任务结束后账本可查且 `chain_ok`。HTTP 测试覆盖汇总、明细、篡改后的
  `chain_ok:false`、未知 task 空链与未知项目 404。
- **同项目并发（M8）**：契约测试覆盖 `artifactDir` 的合法命名空间与越界拒绝；配置测试
  覆盖 `scoped_artifacts` 在 `max_project_workers` 为 1/2 时的默认值与显式覆盖；Host
  Bridge 测试断言只能写本任务目录、可跨任务读；Observer 租约测试覆盖互斥、心跳过期
  接管、缺元数据回收、释放不误删已接管锁，以及另一任务持锁时 review 被跳过。scheduler
  集成测试用 `concurrent-worker` fixture 让两个同项目 explore 任务在屏障处真正重叠，
  断言两个 Fact、两条成功 run、各自的 `artifacts/<task-id>/out.txt` 索引与 provenance，
  以及 `task.json` 的 `artifactDir` 与 prompt 注入。
- **实时审计流（M9）**：图侧覆盖显式 seq 追加、重复事件幂等、缺号/冲突拒绝与
  `onConflict: "stop"` 的结束时补写；token 测试覆盖项目/任务绑定、替换、撤销与空 token；
  HTTP 测试覆盖鉴权失败（缺失/异项目/已撤销）、乱序与分叉 409、批次信封校验和未启用
  时的 404；Host Bridge 测试覆盖本地文件与转发内容一致、批量/顺序、瞬时失败重试、409
  永久停止、队列溢出与 flush 超时的本地标记。scheduler 集成测试用 `stream-worker`
  fixture 先实时追加 seq 1、再在结束时由文件导入补写 seq 2，并断言 token 已撤销且从未
  出现在 `task.json`。
- **M9.1 加固**：Docker runtime 单测断言审计 token 只出现在 `docker exec` 客户端环境，
  不在 argv/worker 环境之外；HTTP 测试覆盖声明的超长 body（不读取即 413）、chunked
  超长 body（读约 5 块即中止）和单事件 20K 字符（400）；图侧与导入共用 16K 上限。
  丢失 marker 单测覆盖有效、缺失、畸形、超长、超长原因截断和符号链接不跟随；scheduler
  集成测试断言 finish 写入 `audit_stream_lost` 并记录 `audit stream lost` 日志；API
  测试覆盖 `stream-lost` 路由、未知 task 返回 `null`、未知项目 404，且 M7 链详情响应
  不变。真实容器 gate 15/15、M3 容器 smoke 14/14、M3 真实模型容器 gate 16/16。
- **只读运维面板（M10）**：HTTP 测试确认 `/` 与静态资产可服务；内联 `cairnApp()` 脚本
  通过语法解析；三个面板的 loader 只发 GET。另用 headless Edge + CDP 在播种了 runs、
  audit、stream-loss 与证据的临时项目上实际点击 Runs/Audit/Evidence，断言 2 条 run、
  2 个 task 的链完整、loss 标记与 `ok` 证据均渲染，浏览器无 JS 异常。
- **Observer 提案闭环（M11）**：图侧覆盖提案存储、按项目/状态/类型过滤、确定性 ID 去重、
  一次性状态迁移与项目级联删除；scheduler 侧覆盖候选文件摄取（幂等、坏文件跳过、单文件/
  单任务/总字节预算、符号链接与符号链接目录拒绝）、hint/intent/fact 三类应用、三类去重
  （精确内容、已应用 dedupe key、打开中的 intent）、证据缺失/无效/越界/来源 Fact 缺失的
  拒绝、`dry_run` 不写图、项目停用与损坏 payload；sidecar 侧覆盖文本归一化、证据强制、
  阈值与类型校验、原子写入与无临时文件残留、数量与字节上限；HTTP 侧覆盖只读列表/过滤、
  非法过滤 400、未知项目 404、POST 405 且不落库；另有 UI 第四个页签的 GET-only 断言、
  提案环境变量契约与 Host Bridge 对 `observer/` 状态目录的只读保护测试。
- **慢层触发（M12a）**：图侧覆盖状态缺失、成功水位、失败不清水位、新项目失败不造水位与
  项目级联；run 摘要覆盖产 Fact 判定、reason 排除与滚动一小时计数。纯求值器覆盖
  `initial`、快层让路、Fact/Hint 阈值、open-intent 清空与死循环保护、冷却、失败退避、
  小时配额、零产出重置、运行中任务抑制、陈旧意图与 fallback。scheduler 集成测试断言
  成功状态落库后新 Scheduler 不重复 reason，以及失败写入 backoff 后下一次 tick 只记录
  抑制日志；`runs.trigger` 同步记录 `initial`。
- **调度优先级与项目预算（M12b）**：图侧覆盖 `runs` 用量列持久化、项目汇总、旧表增量
  迁移，以及 `intent_meta` 优先级/预算往返与损坏数据归一化；契约侧覆盖 priority 范围、
  budget 未知键/空预算/非正整数字段与 usage 负值/损坏/超大旁路拒绝。scheduler 集成测试
  断言 reason 的优先级/预算落库、按优先级选择 explore、worker usage 端到端持久化、
  token/成本门禁、pending conclude 绕过预算，以及 `max_project_tasks` 的配额与继承；
  Host Bridge 测试覆盖工具上限拒绝与 `tool_budget_exhausted` 审计事件。
- **慢层只读 API 与 UI（M12c）**：HTTP 侧覆盖空状态与纯 HTTP 模式的 `null` limits、
  未结束意图的优先级排序与元数据、状态字段、reason-only 过滤与 `limit`、运行中/失败
  任务用量汇总、预算上限与耗尽标记、未知项目 404、非法 `limit` 400 与非 GET 405；
  UI 侧断言“慢层”页签存在、`loadStrategist` 只发 GET 且带 `?limit=20`，内联脚本仍可
  解析。
- **真实模型成本基线与归因（M13a + M13b）**：默认 gate **44/44 PASS**（2026-10-26）：
  5 个真实任务（3 reason + 2 explore）全部成功，项目 completed；每个 `usage.json` 的
  六个字段与 `runs` 行、`getProjectUsage()`、`/strategist` 汇总逐项相等；触发水位、
  reason 历史与未结束意图顺序和调度器一致；`/cost` 的总量/分类与 `runs` 一致、归因
  可对账、动态 Fact 有直付归属并能回溯创建 run、13 条因果边只引用已知节点，POST 返回
  405；扫描 50 个文件未发现凭据。预算模式 **43/43 PASS**：首个真实 reason 使用
  22,381 tokens 越过 1,000 上限，`exhausted.tokens=true`，之后没有新的
  bootstrap/explore/reason 派发。`session.test.ts` 另用 2 条单测断言主 Solver 与子代理
  的 `startup.json` 不再包含凭据原文。两项 gate 均计费、不在 `bun test` 中。
- **成本归因与因果链（M13b）**：图侧测试覆盖多 run 分摊、整数余数、意图创建份额二次
  分摊、证据状态/来源事实、缺失来源时归因停在上层、空项目与未知项目；迁移测试确认旧
  `intent_meta` 自动补 `origin_run_id` 且历史行保持 `null`；scheduler 测试确认 reason
  创建的意图落库创建 run。HTTP/UI 测试覆盖 `/cost` 的零状态、完整归因、404/405，以及
  “成本”页签与 `loadCost` 只发 GET。M13a gate 同时校验 `/cost` 与 run 行一致、归因
  可对账、因果边只引用已知节点，并拒绝 POST。
- **完成验证（M14a）**：图侧测试覆盖默认 `evidence`、创建时选择 `challenge`、upsert
  清理旧 challenge code、检查历史顺序/limit 与请求校验；oracle 测试覆盖证据齐全/缺失、
  显式 Fact 子集、空事实集、bootstrap 任务级证据、`off`，以及 challenge 的全 Flag/部分
  Flag、环境缺失、网络/HTTP/信封错误、缺失挑战、非法计数、零 Flag 和无 code；scheduler
  测试确认拒绝后项目保持 active、bootstrap 保留 Fact、部分 Flag 不完成、全 Flag 完成、
  oracle 抛错按任务失败；HTTP 测试覆盖 `/verify` 成功/子集/400/404/422、
  `/verification` 空状态与 404，并断言返回体不含 token。golden 仍逐字通过（固定时钟下
  创建项目不额外取时）。
- **慢层输出扩展与人工/资源触发（M14b）**：契约测试覆盖 hints 裁剪/去空白、hints-only
  （仍有未结束意图时）、`complete`+hints 拒绝、dedupe key 的空白/长度/类型校验；
  scheduler 测试确认 Hint 落图并按内容去重、重复的 open dedupe key 被跳过（第二次
  reason 不新增意图/提示）、`manual_replan` 为 urgent 且受失败退避与在跑任务约束、
  资源压力在阈值处触发一次并受冷却约束；HTTP 测试覆盖 `/replan` 的成功/默认 body/
  幂等覆盖/404/403/409/422/405 与 GET 回读；prompt 测试断言扩展段和 Resource Budget
  数字；UI 测试断言唯一的显式写操作调用 `POST /replan`。默认 prompt golden 未变。
- **运行模型与溯源下钻（M14c）**：契约测试覆盖 `model` 的合法值、空白、控制字符与
  超长拒绝；图侧测试覆盖 `runs.model` 默认 `null`、写入回读与旧库迁移；solver 测试
  覆盖 `provider/id` 组合、缺 provider 回退与空值；scheduler 测试确认用量里的 model
  落到 run；HTTP 测试覆盖 `/runs` 的 model 字段，以及 fact meta → run → task audit
  的完整下钻；UI 测试断言 `loadFactTrace` 只发 GET 且页面含“溯源/查看工具调用”。
  浏览器实测选中 `f001` 后显示 run/model/task，点击后审计面板显示该任务的工具事件。
- **逐 Worker/模型统计（M14d）**：图侧测试覆盖空项目、按 worker/model 分组的成功/
  失败/拒绝/运行中计数、成功率与平均值、`null` 模型桶和未知项目；HTTP 测试覆盖
  `/stats` 的聚合结果、404 与 POST 405；UI 测试断言「统计」页签、`loadStats` 仅发
  GET，且页面含“按 Worker/按模型/成功率”。浏览器实测 5 个 run 的总览与两张分组卡片，
  控制台无 JS 错误。
- **Worker Profile 与统计选择（M15a）**：配置测试覆盖默认 `prompt` 模式、合法/非法
  profile 与 `stats` 缺少 profile 的拒绝；契约测试覆盖 `workerProfile`/`model` 的
  空白、超长与控制字符；图测试覆盖 `worker_profile` 迁移、回读与跨项目聚合；选择单测
  逐条覆盖采样顺序、成功率/Token/成本/配置顺序平局和 preferred profile；scheduler
  集成测试确认 `runs.worker_profile` 与任务字段一致；HTTP/UI 测试覆盖 `by_profile`
  与“按 Profile”卡片。
- **项目报告导出（M15c）**：图测试覆盖空项目快照、取代 Fact 排除、run 总量与
  worker/model/profile 分桶、验证检查汇总与工件字节数、旧项目策略回退、审计计数不含
  事件原文、Markdown 确定性与空集合标记；HTTP 测试覆盖默认 JSON、Markdown
  content-type、非法 `format` 400、未知项目 404 与 POST 405。
- **报告页与取代视图（M15d）**：UI 静态测试确认「报告」页签、`loadReport` 仅发 GET、
  Markdown 链接指向 `format=markdown`，页面含“完成判定/当前事实/取代关系/已被取代”；
  内联脚本仍可解析。浏览器实测报告页与 Fact 取代跳转。
- **epsilon 探索与校准（M15e）**：选择单测用固定 run 历史断言采样后首次探索的
  eligible 计数、最少样本优先、`epsilon: 0` 关闭、几何衰减与 `epsilon_min` 下限
  （含精确累计预算）以及 preferred/rookie 的优先级；配置测试覆盖三个新字段的默认值、
  范围与 `epsilon_min > epsilon` 拒绝。真实模型 gate 见 `tools/gate/m15e-calibration.ts`。

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
| M6 ✅ | session 保留策略、启动/周期 sweep、pending 对账、artifacts 刷新 | 242 passed / 30 files；跨进程恢复 gate 9/9（2026-10-25） |
| M7 ✅ | 控制面审计账本：任务结束导入、逐任务哈希链、只读查询 | 258 passed / 33 files（2026-10-25） |
| M8 ✅ | 同项目并发协调：任务级 artifacts 命名空间、索引溯源、Observer 复核租约 | 270 passed / 34 files（2026-10-25） |
| M9 ✅ | 实时审计流：任务级 token、幂等链式追加、有界发送与结束补写 | 286 passed / 37 files（2026-10-25） |
| M9.1 ✅ | 审计流收尾：token 不再出现在宿主 argv、丢失 marker 落库/只读路由、请求体与事件上限、真实容器 gate | 295 passed / 37 files；M9 gate 15/15（2026-10-25） |
| M10 ✅ | 只读运维面板：现有 Alpine UI 的 运行 / 审计 / 证据 页签 | 298 passed / 38 files；headless Edge 实测三个面板无 JS 异常（2026-10-26） |
| M11 ✅ | Observer 提案闭环：sidecar 候选文件 → 控制面摄取/证据门控/去重/单写者落图 → 只读 API 与「提案」页签 | 332 passed / 42 files（2026-10-26） |
| M12a ✅ | 慢层触发持久化：`strategist_state` 水位、事件触发、失败退避、冷却/小时配额 | 354 passed / 44 files（2026-10-26） |
| M12b ✅ | 调度优先级与预算：`intent_meta` 优先级/意图预算、单项目 token/成本门禁、并发配额、用量记账 | 387 passed / 46 files（2026-10-26） |
| M12c ✅ | 慢层只读观测：`GET /strategist` 状态/预算/意图/推理历史 + Alpine「慢层」页签 | 394 passed / 47 files（2026-10-26） |
| M13a ✅ | 真实模型成本基线：用量旁路 → runs → API 核对、预算耗尽门禁、`startup.json` 凭据脱敏 | 396 passed / 48 files；真实模型 gate 33/33 + 预算模式 32/32（2026-10-26） |
| M13b ✅ | 成本归因与因果链：`intent_meta.origin_run_id`、只读 `/cost`、逐 Fact/意图分摊与因果边、Alpine「成本」页签 | 405 passed / 50 files；真实模型 gate 44/44 + 预算模式 43/43（2026-10-26） |
| M14a ✅ | 可验证完成：项目级 `evidence`/`challenge`/`off` 策略、证据/外部 Flag 计数 oracle、scheduler 完成门控、`/verify` 与 `/verification` | 444 passed / 54 files（2026-10-26） |
| M14b ✅ | Phase 2 补全：reason 输出 Hint/priority/budget/dedupe、`POST /replan` 人工重规划、资源压力触发、慢层页签操作 | 470 passed / 54 files（2026-10-26） |
| M14c ✅ | 可观测性补链：`usage.json` → `runs.model`、Fact 详情溯源到产出 run 与该任务工具调用审计 | 477 passed / 55 files；浏览器实测下钻（2026-10-26） |
| M14d ✅ | 逐 Worker/模型统计：`GET /stats` 汇总成功率、Token、成本与耗时，新增只读「统计」页签 | 482 passed / 56 files；浏览器实测（2026-10-26） |
| M15a ✅ | Phase 4 起点：`worker_profiles` 映射 model-prefs、任务级模型覆盖、`runs.worker_profile`、先采样后利用的统计驱动派发、`by_profile` 统计与「按 Profile」卡片 | 495 passed / 57 files（2026-10-26） |
| M14a 收口 ✅ | 完成判定收紧：证据 Fact 必须关联 run、challenge 计数严格相等、`verification.evidence_enforcement` 默认开关、`/complete` 可选 operator token、模型把 `evidence_refs` 写进 `data` 时由 worker 提升、gate 断言完成时证据覆盖 | 509 passed / 58 files（2026-10-26） |
| M15b ✅ | Fact 取代链：`fact_meta.supersedes` 只追加边、反向 `superseded_by` 推导、Observer fact 提案校验（种子/不存在/已取代）、完成 oracle 拒绝旧 Fact、只读 `GET /projects/{id}/supersedes` | 529 passed / 60 files（2026-10-27） |
| M15c ✅ | 项目报告导出：只读 `GET /projects/{id}/report` 合成图、完成验证、run/成本统计、审计与工件汇总；`format=markdown` 人读版本；审计原文、工件路径与证据内容不导出 | 540 passed / 62 files（2026-10-27） |
| M15d ✅ | 报告页与取代视图：「报告」页签展示完成判定、当前事实、取代边、run/成本与审计/工件汇总，提供 Markdown 下载；Fact 详情显示 `superseded_by`/`supersedes` 并可跳转 | 540 passed / 62 files（2026-10-27） |
| M15e ✅ | 真实模型校准 + epsilon 探索/衰减：采样后按解析式预算探索（最少样本优先），`epsilon`/`epsilon_decay`/`epsilon_min` 可配；`tools/gate/m15e-calibration.ts` 用真实 model-prefs 核对 profile/model 记账与统计/报告一致 | 545 passed / 62 files（2026-10-27） |

## 与 Phase 0 的关系

`ctfagent/` 里的 Phase 0 实现（`tch` driver、`tch_bridge.py`、overlay 补丁）保留作对照，
M2c 验收通过后删除。它的价值是验证了 BreachWeave Solver 能被 Cairn 的任务契约驱动；
它的成本是每次任务多一次进程、多一层 JSONL 转译——这两点在本项目中消失。

## 许可证与合规

本项目整体按 **AGPL-3.0** 分发（见 `LICENSE`）。仅用于已获明确书面授权的渗透测试、
靶场、比赛或企业自查；未授权扫描或利用不在支持范围内。
