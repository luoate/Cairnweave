# 架构（M22 更新）

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
conclude 使用切片，reason/bootstrap 始终拿全图，默认关闭。M4c 已落地：Observer
sidecar（M22 起默认开启，可显式关闭；`packages/agent/src/solver/extension/cairn-observer/`）；主 solver 只读项目级
看板，独立 sidecar 会话每 N 轮/结束时 review，`BreachWeaveSolver` 在返回前做有界
`flush()`。没有 challenge 续跑、host-bridge RPC 或效率 steer，失败不影响任务结果。
实现、配置与已知限制见 `docs/OBSERVER.md`。M5a 已落地：证据门控与 `runs` 旁路表。
控制面为每个任务生成 `run_id` 并记录启动/完成；worker 结果可在根级带
`evidence_refs`，控制面按工作区做路径校验后才写图。证据缺失只降级记录（不拒绝）；
声称存在但非法/越界/不存在的证据按失败处理。图模型、YAML 导出与既有 HTTP 响应保持
不变，新数据只进旁路表。M5b 已落地：接受证据时流式计算 size/SHA-256 并写入
`fact_evidence`；`GET /projects/{id}/facts/{fact_id}/evidence` 用当前工作区重算摘要，
返回 `ok | modified | missing | unreadable | invalid`（无 workspace root 时为
`unverified`）。摘要只代表写入时的内容快照，不是签名。M5c 已落地：默认拒绝 0 字节
证据（`tasks.evidence.min_bytes`），并把失败任务的 conclude 队列写入
`pending_concludes`，使控制面重启后仍能优先派发；会话路径以工作区相对路径存储。
M6 已落地：scheduler 在首次派发前跑一次 housekeeping sweep，之后按配置周期执行；
`scheduler/retention.ts` 按 age/count 选择可删除的 session 目录，并保护运行中任务、
待恢复 conclude 与所有 pending 行指向的目录；启动 sweep 同时对账
`pending_concludes`，丢弃指向已完成项目、已结束 intent 或缺失会话的行。可选
`retention.refresh_artifacts` 在同一轮重建 artifacts 索引并保留原 `task_id`。
M7 已落地：任务结束时把 `audit.jsonl` 有界导入控制面 SQLite 的 `audit_events`，
按 task 建立哈希链，并提供汇总/明细只读路由。审计因此不再依赖 session 目录存活；
但导入发生在 finish 之后，worker 崩溃前的事件与伪造/漏写不在账本覆盖范围内。
M8 已落地：同项目并发时的任务级 artifacts 命名空间、索引溯源与项目级 Observer review
租约。M9 已落地：可选的实时审计流。Host Bridge 在写本地 `audit.jsonl` 的同时，用任务级
bearer token 把同一事件按显式 `seq` 追加到控制面；结束时仍导入文件，只补写实时流未覆盖
的后缀。实时流降低暴露窗口，但不改变 M7 的最终一致性与信任边界。M9.1 收尾：容器模式
的 token 值改由 `docker exec` 客户端环境保护（argv 只留变量名），请求体真正流式限界，
单事件上限与文件导入共用，并把 worker 的 `audit-stream-lost.json` 持久化/只读暴露。
M10 已落地：在原有单文件 Alpine.js UI 上追加只读 `Runs / Audit / Evidence` 页签；
它们只调用已有的 GET 路由，不引入构建步骤，也不改变图、调度或 scope 判定。
M11 已落地：Observer 提案闭环。sidecar 通过 `propose_graph_change` 把候选
fact/intent/hint 写成任务级 JSON 文件；scheduler 摄取并落 `proposals` 旁路表，控制面
按项目状态、来源、证据与去重规则逐条审核，只有 `apply` 模式才调用既有图命令写图。
没有新增未认证的写路由，主 Solver 也不能写该目录；提案只影响图写入，不改变任务结果、
YAML 导出或既有 HTTP 响应。M12a 已落地：慢层（reason）触发状态持久化与事件触发。
`scheduler/strategist.ts` 是纯求值器，`strategist_state` 旁路表保存每个项目最近成功的
图水位与尝试/失败时间；scheduler 据此判断 initial、open-intent 清空、零产出、陈旧意图、
Fact/Hint delta 与 fallback，并施加 `tasks_running`、冷却、失败退避与滚动小时配额。
控制面重启不会对未变化的图重复 reason。M12b 已落地：reason 输出可带被校验的意图
`priority` / `budget`，存入 `intent_meta`；快层按优先级选择未认领 explore，且 reason
仍先于 explore。顶层 `budget` 配置提供单项目 token/成本门禁与并发配额；worker 的
主 solver 用量写入 `usage.json` 旁路并汇总到 `runs` 的六个用量列。M12c 已落地：新增
只读 `GET /projects/{id}/strategist`，返回 `strategist_state`、项目用量/上限/耗尽标记、
按派发顺序排列的未结束意图（含 `intent_meta` 优先级/预算）与最近的 reason run；静态 UI
增加“慢层”页签。没有新增写路由、schema 或 worker 契约变更。M13a 已落地：真实模型
基线 gate 逐任务核对 `usage.json` → `runs` → 项目汇总 → 慢层 API，并用预算模式验证
token 上限耗尽后停止派发；同时修复 `startup.json` 把认证存储写进项目工作区的问题
（按字段名脱敏）。详见 `docs/STRATEGIST.md` 第 10 节。M13b 已落地：`intent_meta`
增加 `origin_run_id`，只读 `GET /projects/{id}/cost` 把每个 run 的用量分摊给直接产出
（创建的意图 + 产出的事实），再沿意图把创建成本分给 Fact，并输出因果边；静态 UI 增加
“成本”页签。它只读旁路数据，不改 Cairn 图、YAML 导出或 worker 契约。详见
`docs/STRATEGIST.md` 第 11 节。M14a 已落地：完成验证从模型自证改为控制面 oracle。
项目可选择 `evidence`（默认）/ `challenge` / `off`；scheduler 在关项目前检查证据或
外部挑战 API 的 `flag_count` / `flag_got_count`，失败只推迟完成并写
`verification_checks`。oracle、配置、任务文件与数据库都不保存 flag 明文或 token；
flag 原文只由 worker 写入 Fact/证据，M18g 起也用于项目页展示。详见
`docs/VERIFICATION.md`。M14b 已落地：reason 输出增加 `hints`、意图 `dedupe_key` 与
runtime prompt 扩展（priority/budget/dedupe/Hint 语义）；`POST /projects/{id}/replan`
把人工重规划持久化到 `strategist_state` 并作为 urgent 触发，`strategist` 配置新增
`resource_pressure_ratio` 以在用量接近上限时触发一次非紧急 reason。默认 prompt 模板、
图模型与 YAML 导出不变。详见 `docs/STRATEGIST.md`。M14c 已落地：`usage.json` 可选
`model`（`provider/model-id`），worker 从真实 Solver 会话读取并随用量写入 `runs.model`；
`GET /runs` 暴露该列，UI 选中 Fact 后可沿 `run_id` 跳到产出 run 的模型/任务与该任务的
工具调用审计。没有用量的任务（含 fake solver、硬杀）保持 `null`。M14d 已落地：只读
`GET /projects/{id}/stats` 按 worker 与 model 汇总 runs 的 outcome、用量和耗时，静态 UI
增加「统计」页签；它只读旁路数据，不改变图模型、YAML 导出或调度。M15a 已落地：
`worker_profiles` 把稳定 id 映射到 model-prefs 条目，`worker_selection.mode: stats`
按历史 `runs.worker_profile` 采样后选择模型，并把 profile/model 写入 task.json 与
`runs`；prompt 模式保持原行为。M15c 已落地：只读 `GET /projects/{id}/report` 把一个
项目的图、完成验证、run/成本统计、审计与工件汇总合成一个快照，`format=markdown`
渲染同一对象；它不写图也不写旁路，且不输出审计事件原文、工件路径或证据内容。M15d
已落地：静态 UI 增加「报告」页签读取该快照并提供 Markdown 下载，Fact 详情显示
`supersedes`/`superseded_by` 并可在取代链上跳转。详见
`docs/REPORT.md`。M15e 已落地：`stats` 选择在采样期后按解析式累计预算做
epsilon-greedy 探索，探索时选已结束 run 最少的 profile，`epsilon` 按
`epsilon_decay` 衰减到 `epsilon_min` 下限；判断只读 run 历史、不含随机数。
`tools/gate/m15e-calibration.ts` 用真实 model-prefs 核对 run 的 profile/model 记账、
项目统计与报告分桶一致，并输出当前 epsilon 与探索预算。M15f 收尾 Phase 4：UI 常驻
“无身份认证”提示、非回环绑定启动警告，新增 `docs/CONTRACT.md` 汇总 worker 文件契约，
并把 Phase 0 相关表述改为已移除的现状。M16a 增加 CI 门槛
（`.github/workflows/ci.yml`：`bun install --frozen-lockfile` → `typecheck` →
`bun test`，本地等价命令 `bun run check`）与真实模型 A/B 工具
`tools/gate/m16-model-ab.ts`：两个 arm 各自独立数据库/工作区、单 profile 统计配置，
跑同一组 marker 项目，并要求两个 model-prefs 解析到不同模型、两侧 `runs.model`
不重叠；第二个模型未配置时 gate 拒绝运行。M17a 修复前端 P0：新建项目表单强制填写
授权目标，去重后随 `POST /projects` 的 `scope` 提交；新增 `GET/PUT
/projects/{id}/scope` 以便给既有项目补配或修改范围，`GET /projects` 的
`ProjectSummary` 增加 `has_scope` 供列表标记“未授权”。范围仍是项目配置，写入后只影响
之后的派发；`POST /projects` 的既有字段与响应不变，`GET /projects` 只多一个字段。M17b
改善日常操作：项目列表在客户端搜索标题/ID/状态/备注、按状态计数筛选并提供三种排序，
筛选与排序写入 `localStorage`；轮询在 `document.hidden` 时暂停，恢复可见时立即刷新，
失败按 5s→60s 指数退避，列表与项目视图显示错误横幅和重试，列表页展示最后更新时间。
侧栏八个运维页签改为横向滚动，并按项目记忆上次页签。M17c 收口表单与弹窗：13 个
overlay（M18b 起 14 个）由 `syncModal` 维护同一个模态栈，Esc 只关最上层（输入法组合中忽略）、Tab 在
最上层内回焦、关闭后把焦点还给触发元素，autofocus 按帧重试直到该层真正完成布局（上限
8 帧，因为 Alpine 在 `x-effect` 之后一拍才应用 `x-show`）；写操作在请求期间禁用按钮并
显示进度，行内校验取代静默失败；停止单个项目与“停止全部”改为先确认再发 PATCH。
M17d 对齐详情与图的交互：列表卡片成为可聚焦的 `role="button"`，Enter/Space 打开项目且
卡片内按钮不冒泡；打开项目后焦点落在图视图标题，返回列表时按 `data-project-card` 找到
来源卡片并聚焦（已删除则回落到搜索框），两者复用同一个“布局完成后按帧重试”的焦点
助手，因为视图切换同样由 `x-show` 延迟一拍。图视图在无弹窗、焦点不在输入控件时按 Esc
清除选择；多选详情面板显示已选数量并提供“清空选择”；图页头删除改为显式传 id/标题的
`deleteProjectById`，不再从选中状态推断。
以上都只影响静态 UI，不改变 HTTP 契约、图或调度语义。

M18a 增加模型与密钥管理 API（`apps/cairn/src/http/agent-config.ts`，挂载
`/settings/agent*`）：`GET /settings/agent` 汇总 provider-prefs 与 model-prefs，
密钥与自定义请求头的值永不回读，只给 `hasApiKey`/掩码摘要与 `headerNames`；写接口
（provider/模型增删改、默认模型、发现、测试）沿用 operator token，并额外拒绝跨源
`Origin`。密钥写入 `auth.json`，同时按 SDK 要求在 `models.json` 的
`provider:<id>` 副本里保留明文，因此 `provider-prefs.json` 与所有 HTTP 响应都不含
密钥/请求头值；`apiKey: null` 或空串清除两侧。默认模型通过把来源条目复制为
`cairn-worker` 实现，prompt 侧仍只认这个名字。删除被 prompt/worker profile/Observer
引用的 provider 或模型返回 409，`?force=true` 才执行并回收其模型。远端发现与连通性
测试的错误输出按注入的 fake manager 单测要求脱敏（密钥、`Authorization`、`Bearer`
片段），只保留可读摘要。协议支持沿用 config 层的 `listSupportedProtocols`（OpenAI
compatible、Anthropic、Google 等），内置 provider/模型走本地目录，不访问网络。
M18b 把它接成 UI：页头 CPU 入口打开 `data-modal="agent"` 弹窗，Provider 页签维护
provider（名称/协议/Base URL/密钥/请求头，删除 409 时就地切换“强制删除”），模型页签
维护条目（拉取内置目录或远端 `/models`、手工模型 ID、thinkingLevel/reasoning/输入
模态/成本/上下文/最大 Token/请求头、默认标记与引用方、测试、删除确认）。写操作沿用
模态栈的禁用与回焦；表单在发送前做与 API 同构的校验。config 层在同步 `provider:<id>`
时，若 pref 只写了名称且与内置 provider 同名，会继承内置协议与 Base URL，使 UI 创建的
内置 provider 能被 SDK 直接加载；测试路由在 provider 尚无密钥时返回可读提示，避免把
`models.json` 的文件系统错误暴露到页面。
M18c 收尾：`docs/MODELS.md` 是一页操作手册（五步接入、HTTP 速查、文件落点、常见错误、
临时目录演练、M16b 真实 A/B 步骤），`agent-config.flow.test.ts` 在全新临时配置目录上按同一
顺序跑完整链路，并逐步断言响应不含密钥或 header 值。真实 A/B 的前提是两个可用模型，
gate 不会用占位凭据放行；M16b 就是按这条路径接入第二个模型（同网关的 zhipu 协议路径）
并跑通首次对比的，步骤与数字见 `docs/MODELS.md` 第 7 节。
M18d 补齐连通性测试：新增 `POST /settings/agent/providers/{id}/test`，按
`providerId`（或同名 provider）找到绑定模型，优先用 `cairn-worker`，否则取第一条；
没有模型条目时返回可读提示而不调用上游。模型级与 provider 级测试共用
`testModelResponse`，以 `agentTestTimeoutMs`（默认 60 秒）为上限，
`Promise.race` 超时后返回 `connectivity test timed out after …` 并保留摘要，底层调用
不再拖住 HTTP 请求。控制面的 `Bun.serve` 将 `idleTimeout` 设为 120 秒，避免 Bun 默认
10 秒在测试完成前中断连接；Provider 卡片显示测试中/结果与实际测试的模型。
M18e 增加前端 Flag 展示，同时保持报告的“可分享”契约不变：`/report` 仍不含工件
路径或内容，Flag 由独立的只读 `GET /projects/{id}/flag` 提供。该路由只读取
`project_artifacts` 索引里的路径，在 `<workspace>/artifacts/` 下重新校验普通文件与
realpath 包含关系（拒绝 `..`、绝对路径、符号链接和越界父目录），跳过含 NUL 的二进制
与超过 256 KiB 的文件，单次最多 200 个文件 / 8 MiB 总读取量、单行 8 KiB；匹配
`CTF{…}` / `flag{…}` / `picoCTF{…}` 一类前缀，过滤 `CTF2{...}`、`[REDACTED]`、
`masked`、`[hidden]` 等占位符，并按出现文件数、次数、长度排序取第一名。未命中、
无 scheduler workspace 或 artifacts 目录缺失都返回 200 + `found:false`，未知项目
404。UI 在项目页头下方显示绿色横幅（值、来源、复制按钮），打开项目时加载、轮询期间
在未命中时重试，找到后停止重复扫描。M18g 起，artifacts 未命中时 `/flag` 仅读取
`.cairn/sessions/<task>/solver-session/*.jsonl` 作为回退（拒绝符号链接越界、跳过
二进制，限 64 个文件 / 单文件 2 MiB / 总计 8 MiB），只返回 flag 与相对路径，
用于恢复旧 prompt 下被改写为 `CTF2{[REDACTED]}` 的真实值。
M21 把这条回退收紧成「只有工具输出算证据」：逐行只取 `message.role === "toolResult"` 的文本块
（`sessionToolText`），assistant/user 消息不再进候选池——模型在自己叙述里写下的 `CTF2{c8xxxx}`
曾按出现次数压过工具返回的真实值，横幅与 Writeup 因此给出不同的 Flag。`isPlaceholder` 同时新增
掩码判定（`...`、`…`、`**`、`x{3,}` 连写，以及 `uuid`/`guid`/`frag`/`partial`/`truncat*`/
`sample`/`dummy`/`tbd`/`unknown`/`missing` 等替身词，两侧按词段匹配以免误杀
`flag{fragment_of_the_flag}`）。被拒的值不静默丢弃：`candidates`（≤3 条，带 `occurrences`、
`sources`、`placeholder`；artifacts 与会话两路按值合并、次数相加）与 `placeholder_suspect`
一起上报，UI 据此显示琥珀色「FLAG 可疑」条；Writeup 草稿的 `flag_suspects` 与 prompt 里
「不得把占位串当成答案」的硬规则同源于此。
M22 把运行期配置的写权限从“改 YAML + 重启”扩到页头「运行配置」弹窗，同时把 Observer
复盘改为默认开启（`observer.enabled` 默认 `true`；只读复盘，提案仍默认关闭）。覆盖以
snake_case patch 存进 SQLite 表 `runtime_config_overrides`（单行，`id = 1`），由
`apps/cairn/src/config-overrides.ts` 的 `RuntimeConfigStore` 管理：它保留
`loadDispatchConfigWithSource` 返回的解析前文档副本，应用时把 patch 深合并到该副本上，
再走同一个 `parseDispatchConfig`（因此键白名单与跨字段约束都复用 config 层），成功后
用 `syncConfigInPlace` 原地写回共享的 `DispatchConfig`。原地同步保留 `config.budget`、
`config.verification` 等对象引用，HTTP API、VerificationService 与 Scheduler 无需重新
注入；`onApply` 只让 Scheduler `reconfigure()` 重挂 `runtime.interval` 与
`retention.sweep_interval_seconds` 定时器。覆盖在进程重启时重放，坏数据（未知键或
值越界）记日志后清空而不是让服务起不来。`verification.evidence_enforcement` 通过
getter 生效，改完下一个请求即用新值。部署项（`server`、`common_env`、container/local
工作区、Observer、审计流、worker_profiles、prompt 组、健康检查）仍是只读，需改
dispatch.yaml 并重启。详见 `docs/CONFIG.md`。
M18f 打开 challenge/Flag 自动校验：`POST /projects` 未给 `verification` 时，控制面读
`verification.challenge.code_env`（默认 `TCH_CHALLENGE_ID`）；非空即写入
`{kind: challenge, challenge_code}`，否则按 `evidence_enforcement` 落 `evidence` /
`off`。显式请求体优先，策略仍在创建时固定。`GET /projects/{id}/flag` 现在附带
`verification: {policy, latest}`；页头横幅显示题目校验的通过计数或失败原因，challenge
项目最近一次检查未通过时轮询继续刷新 `/flag`，直到调度器写入通过的检查。新建弹窗
增加“完成校验”选择（自动 / 题目 / 证据 / 关闭）与题目编号行内校验。

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
  的 `audit.jsonl` 由 worker 进程写入 `sessionDir`，控制面在任务结束时把它导入
  `audit_events` 账本（有界、逐 task 哈希链）。导入失败只记日志，不改变任务结果。
- `--config` 时还运行 housekeeping sweep：启动时（首次派发前）执行一次，之后按
  `retention.sweep_interval_seconds` 周期执行。sweep 对账 `pending_concludes`、清理
  过期/超额 session 目录，并可选刷新 artifacts 索引。保护信息读取失败时跳过本轮的
  删除，而不是在不确定状态下继续清理。

scheduler 与 HTTP API 共用 `packages/graph/src/commands.ts` 的命令，不经过 HTTP 自调用。
两者语义一致；API 的逐字行为由 golden 锁定，scheduler 的语义由集成测试锁定。

### Worker `cairn worker --task <file>`

- 在**项目沙箱**内运行：本地模式是项目工作区，容器模式是每项目一个长驻容器的
  `docker exec`。两种模式走同一个 `RuntimeBackend` 接口（`runtime/types.ts`）。
- 一个任务一个 worker 进程；同一项目默认串行（`runtime.max_project_workers` 默认 1）。
  提高上限后同一项目可并发多个任务，由 M8 协调共享工作区：每个任务拿到
  `artifactDir: artifacts/<task-id>`，Host Bridge 的文件写工具只允许写本任务目录
  （读不限）；Observer 复核通过项目级租约串行。容器模式下同一项目共用一个容器，
  结束单个任务用任务文件路径做 `pkill`，不会杀掉同项目的其它进程。
- 不访问数据库，不调用控制面 API；只读 `task.json` 与引用的图快照，只写 `result.json`
  和 `sessionDir` 内文件。
- 通过 `Solver` 接口执行任务：默认是确定性 fake solver（`solver/fake.ts`）；
  `CAIRN_SOLVER=breachweave` 时使用 `solver/breachweave.ts`，以库方式启动
  `packages/agent` 中的 BreachWeave 会话（无 RPC 适配进程、无 Python 桥）。
- 所有模型工具调用经过 Host Bridge；未知工具、无效 scope、审计不可写都**fail closed**。
  Bridge 通过环境变量注入 Solver 与 subagent 会话，子代理不能绕过。
- Observer（M22 起默认开启，可显式关闭）在 Solver 会话旁运行一个独立 review 会话。主 Solver 只拿到
  只读看板工具；sidecar 只维护项目级看板，不执行验证、不写图，也不影响 `result.json`。
  同项目并发时，review 先获取 `<board>/locks/review.lock` 项目级租约（心跳 + 过期接管
  + 有界等待），拿不到就跳过本轮并记 `review_skipped`。M11 起 sidecar 还可拿到
  `propose_graph_change`，但只写任务级候选文件；写图仍由控制面单写者完成。

隔离单位是项目（容器/工作区），不是进程常驻。这样既保留崩溃隔离，又不需要额外的
常驻 daemon 协议。

## 3. 数据所有权

| 数据 | 写入者 | 读取者 | 位置 |
| --- | --- | --- | --- |
| SQLite（projects/facts/intents/hints/settings/project_scopes/project_artifacts） | 控制面 | 控制面 | 控制面主机 |
| SQLite 旁路表（`runs` / `fact_meta` / `fact_evidence` / `pending_concludes` / `audit_events` / `audit_stream_lost` / `proposals` / `intent_meta` / `strategist_state` / `project_verification` / `verification_checks` / `project_writeups`） | 控制面（不进入图模型与 YAML） | 控制面 | 控制面主机 |
| `graph.yaml` 快照 | 控制面 | worker | 项目工作区/容器内绝对路径 |
| `task.json` | 控制面 | worker | `sessionDir` |
| `result.json` | worker（临时文件 + rename 原子写） | 控制面 | `sessionDir` |
| `stdout.log` / `stderr.log` | 控制面（进程退出后归档） | 人/审计 | `sessionDir` |
| `audit.jsonl` | worker 内的 Host Bridge | 人/审计 | `sessionDir` |
| `artifacts/**` | worker | 控制面扫描后只记索引 | 项目工作区 |
| `solver-session/**` | BreachWeave 会话 | 人/审计 | `<sessionDir>/solver-session/` |
| `.cairn/board/**` | Observer sidecar | 主 Solver（只读工具）、后续任务 | 项目工作区（跨任务持久） |
| `observer-context.json` / `observer/**` | 控制面写 context；worker 写 review 状态 | review sidecar、人/审计 | `<sessionDir>/`（任务级） |
| `observer/proposals/*.json` | Observer sidecar（主 Solver 结构化文件工具只读） | 控制面摄取 | `<sessionDir>/observer/proposals/`（任务级） |
| 模型/凭据（`~/.tch-agent/config`） | 用户 | worker（只读使用） | 控制面主机（容器模式只读挂载） |

规则：worker 的任何输出都是**不可信输入**；控制面必须按契约校验后才写图。各文件的字段、
校验与退出码见 [`CONTRACT.md`](./CONTRACT.md)。

## 4. 一次任务的生命周期

以下为 M12a 的实际实现；Observer 仅在 `observer.enabled`（M22 起默认 `true`）且任务 kind 命中
`kernel_tasks` 时接入，图切片仅在 `tasks.graph_slice.enabled: true` 时影响 explore 类
任务，reason 的派发由 `strategist` 策略与持久化水位共同决定。

1. scheduler tick 列出所有项目，只考虑 `status=active` 且**有 scope** 的项目。已经在跑的
   项目优先续派，其余按轮转顺序取空闲项目，受 `max_workers` /
   `max_running_projects` / `max_project_workers` 约束。
2. 决定任务种类（与 Cairn 相同）：
   - 先看 `pending_concludes`：失败 explore/bootstrap 排队的 conclude 优先于新工作；
     该行在 conclude 结束或意图失效前一直保留，控制面重启后同样生效；
   - 初始项目（只有 origin/goal）：`bootstrap_enabled` → bootstrap（先建
     `creator=dispatcher.bootstrap` 的意图）；否则也走慢层求值器（没有成功水位时为
     `initial`，且必须没有未认领的 open intent、没有生产任务在跑）；
   - 没有 reason 在跑时，慢层求值器按持久化水位和事件决定 trigger；顺序为失败退避、
     `manual_replan`（人工请求，urgent）、`initial`、`open_intents:N->0`、零产出连续
     run、陈旧意图、`facts:x->y` / `hints:x->y`、`resource_pressure:*`、fallback。
     人工与 initial/open-empty 触发跳过冷却与滚动一小时配额；其余触发受两者约束。
     任何生产任务在跑时统一抑制（`tasks_running`），人工请求也不能越过；
   - 没有 reason 触发时，取最新的未认领、非 bootstrap 意图 → explore。
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
   `solver-session/*.jsonl`，控制面**保留租约**并把一行 `pending_concludes`
   （项目、意图、phase、工作区相对的会话路径）写入旁路表；否则释放租约。没有 session
   （例如模型还没产出任何 assistant 消息）时无法 conclude，按 Cairn 原语义释放 intent。
8. 下一个 tick 优先派发 pending conclude（先于初始项目判断，避免失败 intent 被立刻
   重派 explore）：它把失败任务的 session 目录作为 `resumeSessionDir`，
   `SessionManager.open` 打开最新 JSONL 并追加 `explore_conclude` /
   `bootstrap_conclude` prompt。conclude 的硬截止取
   `bootstrap.conclude_timeout` 或 `explore.conclude_timeout`，不设 soft deadline，也不
   推进 reason 的成功水位；但它和 explore/bootstrap 一样作为生产 run 参与零产出连续计数。
   explore conclude 的图快照也按同一 intent 切片（若启用）；
   bootstrap conclude 与 reason 一样拿全图。队列行在 conclude 结束、意图失效或任务准备
   失败时删除；控制面重启后行仍在，按存储的相对路径重建宿主会话目录并继续派发。
9. 应用结果（同一事务）。写图前先校验证据（见 §4.1）：reason 不要求证据；其余 kind 的
   `evidence_refs` 只要有任一条非法，本任务按失败处理、不写图（explore/bootstrap 仍可走
   conclude 回退）。校验通过后：
   - reason：`complete` → 先调用完成 oracle（M14a；见 §4.2），通过才关项目，失败则释放
     reason 租约并保持项目 active；intents → 先写 `hints`（按去空白内容去重），再以
     `creator=cairn-worker` 创建意图（带 `dedupe_key` 时跳过已打开的同一方向）；
     hints-only → 只写 Hint 并成功；noop → 成功。payload 校验在控制面按实时图状态做；
   - explore：`accepted:false` → 释放意图；否则 conclude 意图产生 Fact，并写
     `fact_meta`（`run_id`、证据引用与状态）；
   - bootstrap：conclude 意图产生 Fact（同样写 `fact_meta`），再调用 oracle；通过才用
     该 Fact 完成项目，失败则保留 Fact、项目继续 active；
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
  会话（`review.ts`）每次启动独立的 pi session，`tools: []`，只注册看板读写工具、
  `query_solver_history` 与（M11 启用时）`propose_graph_change`，不加载 Host Bridge。
- review 由 `tool_execution_*` / `message_end` / `agent_end` 事件驱动，串行消费任务级
  队列；`max_reviews_per_task` 在入队前生效。`BreachWeaveSolver.solve()` 在返回答案前
  调用 `flush()`，最多等待 `timeout_seconds`，任何异常都只写
  `<session>/observer/audit.jsonl`，不改变结果。
- 任务被硬杀时未完成的 review 随进程终止；看板可能落后一轮。`memory_*` / `idea_*`
  写工具不在主 Solver 的 Host Bridge 白名单中，看板文件工具的 `write`/`edit` 也被
  `protectedWriteRoots` 拒绝。`bash` 不受文件路径分析约束，这是策略闸门的已知边界。

### Observer 提案闭环（M11，可选，默认关闭）

提案是 sidecar 影响图语义的唯一通道，仍然满足“控制面是唯一写者”。

- **候选文件**：`propose_graph_change` 把归一化后的 `{version,id,source,kind,
  project_id,task_id,created_at,dedupe_key,evidence_refs,payload}` 以
  `<session>/observer/proposals/<uuid>.json` 落盘（临时文件 + `wx` + rename）。工具
  自身执行字段、类型、置信度、证据与单文件/条数/总字节配额校验；拒绝时返回
  `isError`，不影响 solver。
- **摄取**：任务 `finish()` 时与每个 tick 的 active 项目 review 前，scheduler 只扫描
  普通 `.json` 文件，拒绝符号链接、非法文件名、超限文件与超预算集合。提案 ID 由
  `project_id + task_id + 文件名` 派生，重复扫描幂等。结构校验通过后写入 `proposals`
  （`pending`）；任何错误只记日志。
- **审核**：每条 pending 提案单独事务。`hint` 按内容去重后调用 `createHint`；
  `intent` 要求 `dedupe_key`，按未结束 intent 与已应用提案去重后创建未认领 intent，
  并在 `intent_meta` 记录 key；`fact` 必须有存在的非 goal 来源与合法证据，走
  `createIntent` + `concludeIntent`，与 worker 产出的 Fact 使用同一套证据固化逻辑。
  项目非 active、来源缺失、证据缺失/非法、重复均记为 `rejected`/`duplicate`。
- **模式**：`off` 完全不启用；`dry_run` 完整校验但只记 `dry_run`，不写图；`apply`
  才写图。决策写入 `proposals` 的 `status` / `decision_reason` / `applied_id`。
- **观测**：`GET /projects/{id}/proposals` 只读，可按 `status` / `kind` 过滤；UI 的第
  四个页签展示。没有新增写路由。提案/`intent_meta` 不进入图模型与 YAML 导出。
- **边界**：异步批量生效；审核阶段不复读证据内容；`bash` 仍可伪造候选文件，但控制面
  校验项目/任务绑定、结构与去重，不能借此绕过审核；`dry_run` 行不会自动重放。

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
  `evidence_refs` 提升到根级。模型仍常把它写进 `data`（payload 所在处），所以 worker
  归一化时会把 `data.evidence_refs` 提升到根级并从 `data` 移除，根级值优先；否则
  控制面只会看到“无证据”，而模型自己认为已经提供了。
- **路径校验**（`scheduler/evidence.ts`）：逐条要求非空字符串、长度 ≤512、最多 20 条，
  拒绝 NUL、绝对路径/盘符、`..`、目录、符号链接；先按工作区做词法包含检查，再用
  realpath 复核，防止链接逃逸。通过后反斜杠统一为 `/` 并去重。
- **最小大小**：默认拒绝小于 1 字节的证据（`tasks.evidence.min_bytes`，`0` 关闭），
  空文件因此按非法证据失败；阈值只在接受阶段生效，`/evidence` 校验不受影响。
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

### 完成 oracle（M14a）

完成验证只在应用 `complete` 声明时发生；oracle 的网络调用在 `withConn` 事务之外，
判定结果随后单独写入 `verification_checks`。

- **策略**：`project_verification.kind` 为 `evidence`（默认）/ `challenge` / `off`；
  创建项目时可指定。未指定时（M18f）先看 `code_env` 指向的环境变量，非空即
  `challenge`；否则由 `verification.evidence_enforcement`（`completion` 默认 / `off`）
  决定，也是旧项目无行时的回退。策略不进入图模型或 YAML。
- **evidence**：reason 检查 `data.complete.from` 的每个 Fact 的 `fact_meta` 与
  `fact_evidence`：必须有 `run_id`、非空 `evidence_refs`、`evidence_status=provided`
  且至少一条证据文件。bootstrap 因为 Fact 在同一事务里创建，改用任务级
  `evidence_refs`。无任何非种子 Fact 时失败。
- **challenge**：`GET <base_url>/api/challenges`，`Agent-Token` 取自环境变量；
  按 `challenge_code` 匹配，要求 `flag_count > 0` 且
  `flag_got_count == flag_count`。环境缺失、网络/超时、非 2xx、非法 JSON、
  `code != 0`、形状错误或计数不一致一律失败。
  **oracle 只保存计数，不读取、不保存 flag 明文或 token**；flag 原文由 worker 写入
  Fact/证据，供项目页展示。
- **失败**：reason 释放租约并保持 active；bootstrap 保留 Fact、推迟完成；oracle 抛错
  按任务失败处理。手工 `POST /complete` 仍是操作员覆盖，不经过 oracle；配置
  `CAIRN_OPERATOR_TOKEN` 后要求 `X-Cairn-Operator-Token`。
- 详见 `docs/VERIFICATION.md`。

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
- 模型若把 `evidence_refs` 写进 `data`，worker 会在写结果文件前把它提升到根级
  （根级已有时以根级为准），因为控制面只读根级字段。
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
- **任务命名空间（M8）**：`runtime.max_project_workers > 1` 时 `worker.scoped_artifacts`
  默认为 `true`，每个任务在 `task.json` 中得到 `artifactDir: artifacts/<task-id>` 并在
  prompt 追加 Artifact Policy。Host Bridge 的 `write` / `edit` 拒绝写其他任务的目录和
  `artifacts/` 根；读取仍可跨任务。可显式 `false` 关闭，但那会重新引入并发覆盖风险。
- **索引时机**：每个任务结束时（成功、失败、拒绝都算）由 `finish` 扫描一次；整个项目的
  索引按本次扫描重建。`artifacts/` 不存在时保留旧索引；单次扫描最多 2000 个文件、递归
  深度 20，跳过符号链接和非普通文件。开启 `retention.refresh_artifacts` 后，每次
  housekeeping sweep 也会重建索引。
- **记录内容**：相对 `artifacts/` 根的路径（`/` 分隔）、字节数、流式 SHA-256、
  `task_id`、`created_at`。`task_id` 表示**最初产生该路径的任务**：后续任务重扫全树时
  保留已有行；新路径若位于 `artifacts/<task-id>/` 下则按目录名归属，否则归本次扫描者；
  retention sweep 的新路径记为 `retention-sweep`。不保存文件内容，也不提供下载路由。
- **HTTP**：`GET /projects/{id}/artifacts` 返回
  `[{path,size,sha256,task_id,created_at}]`，按路径排序；未知项目 404。响应与既有 API
  一样由控制面从 SQLite 读取。
- 索引失败只记日志，不影响任务结果；下一次扫描会重建。

### 5.6 旁路表：runs、fact_meta、fact_evidence、pending_concludes、audit_events、audit_stream_lost、intent_meta、strategist_state、verification 与 project_writeups

这些表都在 `packages/graph/src/db.ts` 中创建，既不属于图导出，也不参与任何既有命令：

- `runs(id, project_id, task_id, kind, intent_id, worker, trigger, outcome, exit_code,
  started_at, finished_at, duration_ms, session, evidence_count, detail, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, model,
  worker_profile)`，
  按 `(project_id, started_at)` 建索引；项目删除时级联删除。六个用量列由 M12b 增量迁移
  补齐，旧行为 0；`model` 由 M14c 迁移补齐，旧行与没有用量的任务为 `NULL`；
  `worker_profile` 由 M15a 迁移补齐，prompt 模式与未做选择的任务为 `NULL`。失败任务
  的用量同样保留。
- `fact_meta(fact_id, project_id, run_id, evidence_refs, evidence_status, supersedes,
  created_at)`，主键 `(fact_id, project_id)`，外键指向 Fact 并级联删除。`evidence_refs`
  与 `supersedes` 以 JSON 数组存储。`evidence_status` 为 `provided | missing | legacy`。
  `supersedes` 由 M15b 迁移补齐，旧行为 `[]`（见 §5.7）。
- `fact_evidence(project_id, fact_id, path, size, sha256, created_at)`，主键
  `(project_id, fact_id, path)`，外键指向 Fact 并级联删除。路径是写入时规范化后的
  工作区相对路径；只存摘要，不存内容。
- `pending_concludes(project_id, intent_id, phase, session, worker_profile, created_at)`，
  主键 `(project_id, intent_id)`，外键指向项目并级联删除。`phase` 是 `bootstrap |
  explore`；`session` 是失败任务的工作区相对会话目录，重启后由当前 workspace root
  重建宿主路径。M15a 补的 `worker_profile` 让 conclude 在同名 profile 仍配置时复用
  失败任务的模型。插入是幂等的：同一 intent 重复失败不会重置已排队的 phase。
- `audit_events(project_id, task_id, seq, event, prev_hash, hash, created_at)`，主键
  `(project_id, task_id, seq)`，外键指向项目并级联删除。`event` 是规范化后的单行
  JSON 文本；哈希输入为 `project_id\ntask_id\nseq\nprev_hash\nevent`，每个 task 的
  首条 `prev_hash` 是 64 个 `0`。写入按显式 `seq` 连续追加：同号同内容算重复（重试或
  实时流/文件导入重叠），乱序、缺号或同号异内容拒绝，不会分叉。结束导入使用
  `onConflict: "stop"`，保留已记录前缀并补写后缀；实时流使用 `"throw"`（409）。
- `audit_stream_lost(project_id, task_id, reason, delivered, pending, reported_at,
  recorded_at)`，主键 `(project_id, task_id)`，外键指向项目并级联删除。finish 从
  `audit-stream-lost.json` 导入，同一 task 重复导入覆盖为最新值；只用于暴露实时流
  未完整送达，不参与哈希链，也不影响 `audit_events` 的补写。
- `strategist_state(project_id, last_success_at, last_attempt_at, last_failure_at,
  last_trigger, last_run_id, last_fact_count, last_hint_count, last_open_intent_count,
  replan_requested_at, replan_requested_by, replan_reason, updated_at)`（M12a，M14b 补
  三列），主键 `project_id`，外键指向项目并级联删除。reason 成功时写入时间、trigger/run
  与当时的 Fact/Hint/open-intent 水位，并清除 failure 与 replan 标记；失败只写
  attempt/failure/trigger/run，保留旧水位，同样清除 replan 标记；`cancelled`/`inactive`
  不写。replan 三列由 `POST /replan` 写入，旧库自动补列。表只服务调度，不进入 YAML、
  HTTP 图响应或 worker 契约。
- `intent_meta(project_id, intent_id, dedupe_key, source, proposal_id, origin_run_id,
  priority, budget, created_at)`，主键 `(project_id, intent_id)`，外键指向项目并级联
  删除。M11 用它存提案去重键；M12b 起 reason 创建的意图写 `source='strategist'`、
  `priority`（默认 50）与 `budget` JSON；M13b 起 reason 和已应用提案写
  `origin_run_id`，旧库自动补列且历史行保持 `NULL`。读取时归一化非法优先级/预算为
  `NULL`。不进入图模型、YAML 或 HTTP 图响应。
- `project_verification(project_id, kind, challenge_code, created_at)`（M14a），主键
  `project_id`，外键指向项目并级联删除。`kind` 为 `challenge | evidence | off`；
  没有行时读取合成 `evidence`，不改旧项目。
- `verification_checks(id, project_id, kind, ok, detail, challenge_code, flag_count,
  flag_got_count, evidence_refs, checked_at)`（M14a），按 `(project_id, checked_at)`
  建索引，项目删除时级联删除。每次 oracle 调用（含失败与 `off`）追加一行；
  `evidence_refs` 以 JSON 数组存储，`challenge_code` 是外部挑战的标识，不是 flag。
- `project_writeups(project_id, markdown, model, created_at)`（M19a），主键
  `project_id`，外键指向项目并级联删除。只在 `POST /projects/{id}/writeup` 成功后
  upsert 一行，`DELETE` 清除；中文草稿不落库，始终由图数据现算。表不进入图模型、
  YAML 导出或 worker 契约。
- `runtime_config_overrides(id, overrides, updated_at)`（M22），单行 `id = 1`，
  `overrides` 是 snake_case JSON patch，`updated_at` 是最后一次成功写入的 ISO 时间。
  由 `RuntimeConfigStore` 读写，不进入图导出、worker 契约或项目数据；`DELETE
  /settings/runtime` 把它重置为 `{}`。启动时会重放；非法内容记日志后清空。

HTTP（除实时追加外均为只读，均在控制面进程内直接查库）：

- `GET /projects/{id}/runs` → run 数组，按 `started_at, id` 排序；每行含六个用量列、
  `model` 与 `worker_profile`（无记录时为 `null`）；未知项目 404。
- `GET /projects/{id}/stats`（M14d/M15a，只读）→
  `{project_id, totals, by_worker, by_model, by_profile}`。
  每组统计运行数、运行中/已结束、各 outcome 计数、`success_rate`（成功 ÷ 已结束，
  无结束运行为 `null`）、Token、成本、平均耗时、证据数与最近启动时间；`by_model`
  把没有模型的运行归入 `model: null` 并排在最后；`by_profile` 只含打过
  `worker_profile` 的运行。未知项目 404；只有 GET。
- `GET /projects/{id}/supersedes`（M15b，只读）→
  `{project_id, facts: {total, current, superseded}, supersessions}`。`supersessions`
  每条含 `fact_id`、`description`、`superseded_by`、`superseded_by_description`、
  `created_at`，按被取代 Fact id 排序；未知项目 404；只有 GET，其他方法 405。
- `GET /projects/{id}/report?format=json|markdown`（M15c，只读）→
  `{generated_at, project, verification, graph, current_facts, hints, supersessions,
  runs: {totals, by_worker, by_model, by_profile}, cost, audit, artifacts}`。`format`
  默认 `json`；`markdown` 用 `text/markdown` 返回同一对象的渲染结果。`audit` 与
  `artifacts` 只有汇总（任务数、事件数、时间边界、文件数与字节数），不含审计事件
  原文、工件路径或证据内容。未知项目 404；非法 `format` 400；其他方法 405。
- `GET /projects/{id}/flag`（M18e/M18f/M18g/M21，只读）→
  `{found, flag, source, occurrences, sources, scanned_files, truncated, candidates,
  placeholder_suspect, verification: {policy, latest}}`。扫描
  `project_artifacts` 中登记且仍在 `<workspace>/artifacts/` 内的普通文件；占位符、掩码、
  二进制、超大文件与越界路径被跳过。artifacts 无结果时再限量扫描
  `.cairn/sessions/*/solver-session/*.jsonl`，M21 起只取其中 `role:"toolResult"` 的消息正文，
  只返回 flag 值与路径，不返回日志内容。`candidates` 是最多 3 条的排名结果（命中时为通过筛选
  的值，否则为被拒的掩码），`placeholder_suspect` 表示「看到过 flag 形状文本，但一个都没采纳」。
  未命中返回 `found:false` 的 200；未知项目 404；只有 GET。`verification` 与
  `/verification` 同源，供页头横幅显示校验状态。
- `GET|POST|DELETE /projects/{id}/writeup`（M19a）→
  `{project_id, source: draft|model, model, created_at, markdown, flag, generated_at,
  verification}`。GET 只读、免 operator token，`format=markdown` 用 `text/markdown`
  返回同一份正文；草稿每次现算，未知项目 404，非法 `format` 400。POST 请求体可选
  `{model_pref}`（默认 `cairn-worker`），用无工具的单轮补全按草稿重写中文正文并
  upsert `project_writeups`，返回存储后的视图；生成失败 502、超时 504，两者都不清除
  已存正文。DELETE 只删除存储行，让 GET 回到草稿。POST/DELETE 需 operator token
  （配置时）并拒绝跨源写；详见 §5.10 与 `docs/WRITEUP.md`。
- `GET /projects/{id}/writeup/archive`（M20b，只读）→ `application/zip`，
  `content-disposition: attachment; filename="writeup-<id>.zip"`，内含 `writeup.md`、
  `MANIFEST.md` 与 `artifacts/<索引路径>`。未挂载 workspace root 时 409，未知项目 404。
  三个 writeup 视图的 JSON 都多带 `payloads`（M20a，`total/count/inlined/binary/unread/
  truncated` 与 `files[]`）和 `archive:{available,files}`（M20b），侧栏据此显示载荷摘要与
  下载按钮。
- `GET /projects/{id}/strategist?limit=20`（M12c，只读）→
  `{state, budget, intents, reason_runs}`。`state` 为 `strategist_state` 或 `null`；
  `budget` 含 `used_tokens` / `used_cost_usd` / `running_tasks`、配置上限（纯 HTTP
  模式为 `null`）与 `exhausted` 标记；`intents` 只含未结束意图，按
  `priority DESC, created_at DESC, id DESC` 排序并附带 `priority` / `budget` /
  `source`；`reason_runs` 只含 `kind='reason'`，最新在前。`limit` 默认 20、范围
  1–100，非法值 400；未知项目 404；只有 GET。不修改任何状态。
- `POST /projects/{id}/replan`（M14b）→ `{reason?, requested_by?}`，body 可省略；
  `reason` ≤500 字、`requested_by` ≤128 字（默认 `human`）。把请求写入
  `strategist_state.replan_*`，scheduler 在下一次派发时按 urgent `manual_replan` 处理，
  reason 成功或失败后清除。返回更新后的 state。未知项目 404；非 active 项目 403；
  reason 租约正在被占用 409；body 形状非法 400、非法 JSON 422。
- `GET /projects/{id}/cost`（M13b，只读）→
  `{project_id, totals, by_kind, attribution, facts, intents, runs, edges}`。总量、
  分类与每个 run 的用量来自 `runs`；Fact/意图成本由 `packages/graph/src/cost.ts` 分摊：
  run 用量平均分给直接产出（`intent_meta.origin_run_id` 创建的意图 +
  `fact_meta.run_id` 产出的事实），意图创建份额再分给它产出的事实。Fact 成本是项目
  用量的分区；意图成本包含执行 run，与 Fact 合计重叠。`edges` 节点前缀为
  `run:` / `intent:` / `fact:`，kind 为 `created_intent` / `executed_by` /
  `produced_fact` / `source_fact` / `concluded_fact`。未知项目 404；只有 GET，
  其他方法 405；不修改任何状态。
- `POST /projects/{id}/verify`（M14a）→ 手动运行完成 oracle，body 可省略或为 `{}`；
  `{"facts": [...]}` 限定检查子集。返回 `{project_id, kind, ok, detail,
  challenge_code, flag_count, flag_got_count, evidence_refs, checked_at, check}`。
  未知项目 404；body 形状非法 400；非法 JSON 422。会追加一行 `verification_checks`。
- `GET /projects/{id}/verification`（M14a，只读）→ `{policy, latest}`。`policy` 对
  无行项目按 `verification.evidence_enforcement` 合成 `evidence` / `off`；`latest` 为
  最近一次检查或 `null`。未知项目 404。
- `GET /projects/{id}/facts/{fact_id}/meta` → 单条 meta；Fact 存在但没有 sidecar 行时
  返回合成的 `legacy` 记录，未知 Fact 404。响应形状与既有 API 一致，直接是 JSON 对象，
  不加信封。
- `GET /projects/{id}/facts/{fact_id}/evidence` → 证据数组，按路径排序；每条包含
  写入时的 `path/size/sha256/created_at`、实时 `status` 与 `current_size` /
  `current_sha256`。`serve --config` 时用配置的 workspace root 校验；纯 HTTP 模式返回
  `unverified`。未知 Fact 或项目 404，无证据 Fact 返回 `[]`。校验是同步流式哈希，耗时
  与文件大小成正比；证据数量上限 20，响应不缓存结果。
- `GET /projects/{id}/audit` → 每个已有账本的 task 一行
  `{task_id,event_count,root_hash,first_at,last_at}`，按 `task_id` 排序；未知项目 404。
- `GET /projects/{id}/audit/{task_id}` → `{task_id,event_count,chain_ok,broken_at,
  root_hash,events}`。`events` 按 `seq` 排序，`event` 为解析后的 JSON（解析失败时保留
  原文）；`chain_ok` 由控制面按存储文本重新计算，`broken_at` 是首个不匹配的 seq。
  未知项目 404；该 task 没有账本时返回空链（`chain_ok:true`、`root_hash:null`）。
- `POST /projects/{id}/tasks/{task_id}/audit`（M9，仅在 `audit_stream.enabled` 时注册）→
  body `{"events":[{"seq":1,"event":{...}}]}`，最多 256 条、1 MiB；单条事件文本与
  文件导入共用 16K 字符上限。请求体先检查声明的 `Content-Length`，再按块读取并在
  超过 1 MiB 时立即取消，不会先整包缓冲。要求 `Authorization: Bearer <token>`，token
  只能写绑定的项目/task。成功返回 `{recorded,duplicates}`；鉴权失败 401，缺号/分叉
  409，信封/事件非法 400，超限 413。
- `GET /projects/{id}/audit/{task_id}/stream-lost`（M9.1，只读）→
  `{task_id, stream_lost}`。`stream_lost` 为 `null` 或
  `{task_id,reason,delivered,pending,reported_at,recorded_at}`；未知项目 404。
  该路由与 M7 的链详情响应分开，空链响应保持原样。

只读运维面板（M10）：

- 静态 UI 仍是单文件 `index.html`（Alpine.js + Cytoscape + vendored Tailwind），由
  `GET /` 与 `/static/*` 直接提供，没有构建/打包步骤。页签分两行：原有
  `Detail / Hints / Log`，以及运维页签 `Runs / Strategist / Audit / Evidence /
  Proposals / Cost`。
- 弹窗（M17c）：每个 overlay 是 body 的直接子节点，带 `data-modal="<name>"` 与
  `x-effect="syncModal('<name>', showX, $el)"`；`syncModal` 维护 `modalOrder` 栈和
  `modalReturnFocus`，全局 `keydown` 处理器只对栈顶执行 Esc（`dismissModal` 走
  `modalClosers()`，请求进行中拒绝关闭）与 Tab 焦点陷阱。新增弹窗时必须保持 overlay 的
  `</div>` 平衡——漏一个闭合标签会把之后的弹窗嵌进它，父层 `x-show` 为假时子弹窗即使
  自己为真也拿不到布局与焦点。
- 视图切换与选择态（M17d）：列表卡片带 `data-project-card`、`role="button"` 与
  `tabindex="0"`，Enter/Space 用 `.self` 修饰避免内部按钮冒泡；`openProject` 聚焦
  `#graphHeading`，`backToList` 记录离开的项目并回焦对应卡片。`focusAfterRender` 是
  M17c autofocus 的泛化版本，供模态层、图标题与列表卡片共用。`handleGraphEscape` 挂在
  全局 `keydown` 的首位，只有图视图、`modalOrder` 为空、焦点不在 `INPUT/TEXTAREA/SELECT`
  或可编辑区域、且确有选择时才清除，避免与弹窗 Esc 和输入框自带行为冲突。
- `Runs` 读取 `GET /projects/{id}/runs`，按最新在前显示 kind、worker、profile、模型、
  outcome、退出码、时长、evidence 数量和 detail；每行可跳到该 task 的 Audit。
- Fact 详情（M14c）在单选时读取 `GET /facts/{id}/meta`，用 `run_id` 从已加载或补取的
  runs 中定位产出 run，显示模型与 task id；“查看工具调用”复用 Audit 页签。多选或
  origin/goal 不发起溯源请求。
- `Strategist`（慢层）读取 `GET /projects/{id}/strategist?limit=20`，显示单项目
  token/成本/并发用量与上限、耗尽徽标、最近成功/尝试/失败水位与触发串、按优先级排序的
  未结束意图（含意图预算）以及最近 20 次 reason run。纯 HTTP 模式下上限显示为未配置。
  面板内的“请求重规划”是唯一显式写操作，调用 `POST /replan` 后重新读取；其他数据仍只读。
- `Audit` 读取汇总与选举 task 的链详情，并同时读取 `stream-lost`。汇总按 `last_at`
  最新在前；链详情显示 `chain_ok/broken_at/root_hash`、逐条 allow/block 与原始事件；
  stream loss 以独立卡片显示 `reason/delivered/pending`。从 Runs 跳到尚无账本事件的
  task 时，下拉框保留该 task，并显示空链与 loss 状态。
- `Evidence` 通过 Fact 下拉选择后并发读取 meta 与 evidence，显示 sidecar 的
  `provided/missing/legacy`、写入时 `size/sha256` 与实时 `status/current_*`。没有
  workspace root 时沿用 API 的 `unverified` 语义。
- `Stats`（统计，M14d/M15a）读取 `GET /projects/{id}/stats`，显示项目总览与按 Worker、
  按模型、按 Profile 三组卡片：运行数、成功/结束、成功率、Token、成本、平均耗时和最近
  启动。`model: null` 显示为“未记录模型”；`by_profile` 只在统计驱动选择启用后有数据；
  没有结束运行的组显示“无结束运行”而不是 0%。
- `Report`（报告，M15d）读取 `GET /projects/{id}/report`，显示完成判定（策略、通过/
  失败、最近检查、题目编号）、图状态、当前 Fact、取代边、run 总量与按 worker/model/
  profile 分桶、审计与工件计数；右上角链接到同一路由的 `format=markdown` 由浏览器
  下载。它只展示报告快照，不在前端重新组合数据。
- `Flag` 横幅（M18e/M18f/M18g/M21）读取 `GET /projects/{id}/flag`，在项目页头下方显示
  命中的 Flag、来源工件或 solver-session 路径与复制按钮；未命中时不占位。M18f 起
  同一响应带 `verification` 快照，横幅追加校验徽标（题目通过 n/n、失败原因或
  “校验已关闭”），challenge 未通过时轮询继续刷新。M18g 起显示的是真实 flag 原文，
  而不是 `[REDACTED]` 占位符。M21 起横幅还会标注“另有 N 个候选”，并且在没有 Flag 但
  `placeholder_suspect` 为真时于其下方显示琥珀色「FLAG 可疑」条，逐字列出被拒的 flag 形状
  文本（该条不给复制按钮，避免把掩码当答案提交）。它不进入报告页，避免把工件内容带进可分享快照。
- `Writeup`（M19a/M19b/M20a/M20b/M21）读取 `GET /projects/{id}/writeup`，用 `<pre>` 原样展示中文
  Markdown 正文，标题行、状态摘要与操作条分三段纵向排列（操作条自身 `flex-wrap`，不与标题争
  宽度），标注“中文草稿”或“模型撰写”及所用模型与生成时间；状态摘要含 Flag 是否记录（M21 起区分
  “已记录 Flag（另有 N 个候选）”与“尚未记录 Flag（N 处疑似占位）”）、校验状态与
  “载荷 N 个（内联 K）”（M20a）。操作条提供刷新、复制、
  `下载 Markdown`（指向 `?format=markdown`，文件名 `writeup-<项目id>.md`）、
  `附件包 N`（M20b，GET `.../writeup/archive`，文件名 `writeup-<项目id>.zip`，按下后 toast
  汇报附件数；`archive.available` 为假时整个按钮不出现）、`AI 撰写`
  （POST，生成期间禁用）与仅在模型版下出现的`恢复草稿`（DELETE）。页签同样按项目记在
  `localStorage`，只在激活时加载，失败给行内错误与重试。前端不自行拼接正文，也不把
  Writeup 混入报告快照。
- Fact 详情（M15d）在 `GET /facts/{id}/meta` 返回 `superseded_by` 或非空 `supersedes`
  时额外显示“取代关系”：点取代者可跳到新 Fact，点旧 Fact 可回到被取代项。
- `Cost`（成本，M13b）读取 `GET /projects/{id}/cost`，显示项目总量与归因完整性、
  按 run kind 汇总、逐 Fact 的直付/编排成本及产出/创建 run、逐意图的执行与创建成本、
  因果边和每个 run 的直接产出。它不把意图合计与 Fact 合计相加。
- 这些面板只在打开页签或点刷新时拉取，全部使用 GET；错误在面板内显示并可重试，
  不弹写操作、不参与调度。UI 本身不带认证，远程/容器部署仍需网络层限制整个 API。
- `模型与密钥`（M18b）是唯一非项目级、且带写操作的弹窗（`data-modal="agent"`）：
  打开时读取 `GET /settings/agent`，Provider 页签管理 provider（协议下拉来自
  `protocols`，名称建议来自 `builtinProviders`），模型页签管理条目并可在
  `POST /providers/{id}/discover` 后从下拉选择模型、自动回填显示名。密钥输入永远为空，
  留空表示不修改；保存后重读配置。删除先走行内确认，409 时显示依赖方并切换
  “强制删除”；所有请求期间关闭按钮与提交按钮同时禁用。操作步骤与错误对照见
  `docs/MODELS.md`。
- `运行配置`（M22）是页头第二个写弹窗（`data-modal="runtime"`）：打开时读取
  `GET /settings/runtime`，按分组渲染数字/开关/下拉/多选控件，与文件基线不同的字段
  显示“已覆盖”；保存只发最小 patch（`PUT`），服务端 400 的行内错误原样显示。恢复默认
  需要 4 秒内二次点击并发 `DELETE`。只读区展示需要改 dispatch.yaml 的部署项。字段、
  热生效范围与边界见 `docs/CONFIG.md`。

实时审计流（M9）：

- scheduler 在每次 spawn 前向进程内 `AuditTokenRegistry` 申请 token（32 字节随机数，
  只存 SHA-256），通过 `CAIRN_AUDIT_STREAM_URL` / `CAIRN_AUDIT_STREAM_TOKEN` 合并进
  worker 的 `extraEnv`。token 不进入 `task.json`、prompt 或日志；任务 `finish()` 与
  spawn 失败路径都会撤销它，控制面重启后不存在。
- 容器模式下，`CAIRN_AUDIT_STREAM_TOKEN` 的值放在 `docker exec` 客户端进程的环境里，
  argv 只出现 `-e CAIRN_AUDIT_STREAM_TOKEN`（docker CLI 从自身环境取值），避免 token
  出现在宿主进程列表/命令行；其它变量仍用 `-e NAME=value`。本地模式本来就是进程环境，
  不经过 argv。
- Host Bridge 先追加本地 `audit.jsonl`，成功后才把同一 entry 放进有界队列（512 条）。
  后台按批（≤32）发送并重试瞬时失败/429/5xx；认证失败、400/409/413 或队列溢出视为
  永久失败，停止发送并写 `<sessionDir>/audit-stream-lost.json`。停止时丢弃未发送队列
  而不是跳过序号，因此已写账本始终是连续前缀。
- worker 在 solver 返回后（含异常）调用 `flushAuditStream()`，最多等 3 秒；CLI 随后
  显式 `process.exit`，未完成的请求不再等待。finish 仍完整导入文件：重复前缀被忽略，
  缺失后缀被补写。流是延迟优化，不是一次性导入的替代品。
- finish 同时读取 `audit-stream-lost.json`（M9.1）：只接受普通文件、≤64 KiB、
  合法 JSON 和非负整数计数；符号链接、超限或畸形内容不会跟随/采信，而是以通用
  `unreadable`/`invalid` 原因落库。有效 marker 写入 `audit_stream_lost` 表（按
  `(project_id,task_id)` 覆盖），reason 截断到 512 字符。该记录只用于可见性，既不改
  任务结果，也不影响 `audit.jsonl` 的补写；控制面崩溃导致未执行 finish 的 marker
  不会被补导。
- 启用条件：`audit_stream.enabled: true` 且存在可达 URL。本地模式缺省取实际监听的
  loopback 地址；容器模式必须显式配置 `audit_stream.url`（容器内的 loopback 不是
  控制面），并让控制面在容器可达的私网/网关地址上监听。此时 task token 只保护审计
  写入路由；控制面其余 API 仍需由部署方在网络层限制访问。纯 HTTP 模式（无 scheduler）
  不注册该路由。

审计导入的边界：

- 只读取 `sessionDir/audit.jsonl` 这个普通文件，`lstat` 后拒绝符号链接与目录。
- 最多读取 8 MiB、写入 10,000 条，单条文本上限 16K 字符；该上限与实时接口共用
  `MAX_AUDIT_EVENT_TEXT_CHARS`。空行、非法 JSON、非对象和超长行跳过。文件/条目超限
  时截断并在日志中标记，不报错。
- 导入是 best-effort：数据库或文件错误只记日志，任务结果与 run 记录不受影响。
  控制面崩溃导致未执行 `finish` 的任务不会自动补导；其 session 目录可能在后续
  retention 中被删除。

### 5.7 Fact 取代链（M15b）

图仍然只追加：新 Fact 不修改、不删除旧 Fact，取代关系只存在于旁路。

- `fact_meta.supersedes` 记录“本 Fact 取代了哪些旧 Fact id”；反向的 `superseded_by`
  在读取时从其他行推导，不落库。未知 id、自指与重复项在读取时忽略；同一目标被多个
  新 Fact 取代时取 `created_at` 最新的一条，时间相同按取代者 id 决定，保证结果稳定。
- **写入路径**：只有 Observer 的 `fact` 提案可以带 `supersedes`（最多 20 个、每个
  ≤64 字符），由控制面在审批时校验并写入；任务结果与手工 conclude 不接受该字段。
- **审批校验**：不能取代 `origin` / `goal`（前提不是可替换结论）；目标必须存在
  （`supersede_target_missing`）；已经存在取代边的事实不能再次被取代
  （`fact_already_superseded`）。因此边不会形成链式二次替换。
- **完成判定**：evidence oracle 拒绝引用已被取代 Fact 的完成声明（detail 为
  `fact was superseded by fXXX`），完成声明必须引用当前 Fact；这防止模型用旧结论
  关闭项目。
- **只读视图**：`GET /projects/{id}/supersedes` 返回 `{project_id, facts: {total,
  current, superseded}, supersessions}`；`current = total - superseded`，统计包含种子
  Fact。`GET /projects/{id}/facts/{fact_id}` 的 `meta` 也带 `supersedes` 与
  `superseded_by`。
- **边界**：取代不改变意图、提示词、timeline 或 YAML 导出；`GET /projects/{id}` 仍
  返回全部 Fact（追加语义）。取代链只在项目内生效，不支持跨项目引用。

### 5.8 项目报告导出（M15c）

报告是只读快照，不引入新的图语义；与其它读取项目详情的端点一样会顺带让过期租约失效，
但不写 Fact、意图或旁路历史：

- **组成**：`packages/graph/src/report.ts` 组合既有读取——`getProjectDetail`（项目、
  Fact、意图、Hint）、`listFactSupersessions`（取代边）、
  `summarizeProjectVerification`（策略、检查汇总、最近一次检查）、`runs` +
  `buildProjectRunStats`（总用量与按 worker/model/profile 分桶）、
  `buildProjectCostReport`（成本与 `by_kind`）、`listProjectAudit`（任务与事件计数）、
  `listProjectArtifacts`（文件数与字节数）。
- **当前 Fact**：`current_facts` 排除有 `superseded_by` 的 Fact，按 id 排序；取代边
  原样输出。`graph.current_facts` 等于 `current_facts.length`。
- **确定性**：除 `generated_at` 外，所有数组都有稳定排序（Fact 按 id、Hint 按
  `created_at, id`、run 分桶沿用 `/stats` 的顺序）。测试注入固定的 `generatedAt`。
- **脱敏**：`audit` 只有 `{tasks, events, first_at, last_at}`，`artifacts` 只有
  `{count, bytes}`。审计事件原文（可能含命令输出）、工件路径与证据文件内容都不进入
  报告；挑战验证只读取并输出计数，从不读取 flag。Fact / Hint 是图内容，按图原样导出。
- **路由**：`GET /projects/{id}/report` 默认 JSON；`format=markdown` 返回同一对象的
  人读版本。Markdown 渲染把用户内容折叠成单行并转义表格中的 `|`。只有 GET。
- **边界**：报告不包含 timeline / YAML 导出（仍走 `GET /projects/{id}/export`），
  也不支持跨项目汇总；大项目会返回全部当前 Fact 与 Hint，尚无分页。
- **静态 UI（M15d）**：「报告」页签打开时读取 JSON 快照并渲染上述字段，Markdown 按钮
  直接指向 `?format=markdown`；Fact 详情的“取代关系”只读取 fact meta。两者都不写图、
  不写旁路，也不改变调度；UI 的唯一写操作仍是慢层的人工重规划。

### 5.9 session 保留与启动对账（M6）

scheduler 的 housekeeping sweep 由 `scheduler/retention.ts` 与 `loop.ts` 共同实现：

- **运行时机**：`start()` 在第一次 tick 前同步跑一次；`retention.sweep_interval_seconds`
  非 0 时再用独立定时器周期执行。sweep 与 tick 解耦，失败只记日志，不影响派发。
- **扫描范围**：只枚举 `<workspace>/.cairn/sessions` 的直接子目录（`lstat`，跳过符号
  链接与非目录）。Observer 看板、artifacts 和项目根目录下的其它文件不在清理范围内。
- **保护集合**：当前 `running` 任务的 `sessionDir` / `resumeSessionDir`，以及所有
  `pending_concludes` 行按当前 workspace root 重建的目录。受保护目录不会删除，但仍然
  占用 keep-count 名额。保护集合查询失败时本轮直接跳过删除（fail closed）。
- **选择规则**：`session_max_age_days > 0` 且目录 mtime 早于阈值 → 按 age 删除；
  `session_keep_per_project > 0` 时按 mtime 从新到旧保留前 N 个，其余按 count 删除。
  两条规则都为 0 时整个清理阶段不运行。
- **pending 对账**：对每一行检查项目是否存在且 active、intent 是否存在且仍开放、
  会话目录中是否仍有 `solver-session/*.jsonl`。任一不满足就删除该行；若仅会话缺失而
  intent 仍开放，还会释放该 intent 的租约，让 explore 正常重试。正在本进程运行的任务
  不参与对账。
- **效果**：上一控制面崩溃遗留的无效队列项不会阻塞新工作；有效项在首次 tick 前保留，
  由正常派发分支优先执行。清理与对账都不要求图可写，也不修改 Fact / intent 历史。

### 5.10 项目 Writeup 生成（M19a/M20a/M20b）

Writeup 是面向人的中文复盘文本，分两层，全部逻辑在 `packages/graph/src/writeup.ts`
与 `apps/cairn/src/http/project-writeup.ts`：

- **草稿（默认，永远可用）**：`buildProjectWriteup` 只读组合 `getProjectDetail`、
  `getProjectScope`、`listFactSupersessions`、`buildProjectRunStats`、
  `summarizeProjectVerification`、`listProjectArtifacts`、`fact_meta`（证据引用与
  产出 run）与 `runs` 的精简投影。`renderProjectWriteupMarkdown` 渲染结论、题目与
  目标、攻击路径（按意图 → Fact 排序，附 worker/model/outcome 与证据路径）、尚未完成
  的探索、当前有效事实清单、被取代的判断、Hint、Flag 与校验、执行统计（worker/model
  两张表）与证据文件附录（≤200 项，超出标记 `artifacts_truncated`）。除 `generated_at`
  外输出确定；不写图、不写旁路、不改调度。
- **Flag 一致性**：草稿的 Flag 与校验段复用 `/flag` 的 `collectProjectFlag`（artifacts
  优先、solver-session 的工具输出回退），两个视图不会给出不同结论；M18g 的原文展示策略同样适用
  于 Writeup，草稿与 prompt 都保留 flag 原文，不做脱敏。M21 起扫描结果里的 `candidates` 也接进
  草稿：命中时把较弱的同前缀值列成「其他候选」（`flag.alternatives`），只扫到掩码时列
  `flag_suspects` 并把结论改成「尚未记录到可信 Flag」，prompt 明确禁止把占位串当答案或自己拼出
  一个看起来完整的 Flag。
- **载荷（M20a）**：`isWriteupPayloadPath` 用扩展名表（脚本、模板、SQL/HTML、zip/pkl
  等投递容器与图片）与文件名关键字（`payload exploit poc inject sqli xss ssrf ssti xxe
  traver webshell deserial forg bypass` 等）从 `project_artifacts` 里确定性筛出载荷，
  普通响应转储（`.txt/.out/.resp/.md/.json`）不算，仍留在附录。条目超过 20 条时按“被
  `fact_meta.evidence_refs` 引用过的优先、再按路径”截断（`selectWriteupPayloadArtifacts`），
  保证支撑结论的载荷不会被探测脚本挤掉。文件字节由 HTTP 层的
  `collectWriteupPayloads` 读取——`@cairn/graph` 不碰文件系统，只把 `payloadContents`
  注入快照——读取复用 Flag 扫描的收敛：`<workspace>/artifacts` 真实目录、非符号链接、
  路径不逃逸、单文件 ≤128 KiB、只读选中的 ≤20 条、单项目 ≤24000 字符、含 NUL 判定为二进制。
  `## 载荷（Payload）` 逐字内联文本（正文含反引号时自动加长围栏）、超预算标注截断、
  二进制与未挂载工作区分别写“未内联”“内容未读取”，从不留空或编造；每条载荷带
  `referenced_by`（哪些 Fact 的 `evidence_refs` 引用它），快照另有 `payloads_total` 说明
  一共识别到多少个，JSON 视图给出 `state: inline|binary|unread` 的投影。
- **附件包（M20b）**：正文只内联 ≤20 条载荷，剩余字节由
  `GET /projects/{id}/writeup/archive` 一次交付。打包布局与正文引用一一对应——
  `writeup.md`（当前服务的正文，模型版或草稿）、`MANIFEST.md`（中文清单：项目、打包时间、
  Flag、载荷统计、逐文件 sha256 与「未打包文件 + 原因」两张表）、
  `artifacts/<索引路径>`。打包范围取该项目的**全部** `project_artifacts`（上限 500 个文件 /
  单文件 4 MiB / 总量 64 MiB），读取复用同一套收敛函数 `openArtifactRoot` +
  `readArtifactFile`，因此索引里指向包外、目录或已清理文件的路径只会进未打包表。ZIP 由
  `apps/cairn/src/http/zip.ts` 自己写：store 与 raw deflate 取更短者、CRC-32、单一中央目录、
  文件名 UTF-8 标志位、时间戳由调用方固定，所以同一批输入产出同一份字节；`readZip()` 读回并
  校验 CRC，既是格式自检也是测试断言入口。条目名先归一化再拒绝空段与 `..`，解包不会逃出根
  目录。该路由只读，不设 operator token（与其余读取端点一致），未挂载 workspace 时返回 409；
  JSON 视图用 `archive: {available, files}` 告诉前端能不能下、大概多少文件。
- **模型撰写版（可选）**：`renderProjectWriteupPrompt` 把同一份草稿作为唯一素材交给
  `@cairn/agent` 的 `completeText`（`tools: []`、`SessionManager.inMemory()` 的单轮
  补全，不授予任何工具），system prompt 要求全程简体中文、只使用草稿中的事实/证据/
  Flag、Flag 与载荷逐字符照抄（草稿只给路径时不得虚构内容）、如实标注未验证与未完成、
  不得写入凭据或内网敏感地址。结果
  upsert 进 `project_writeups`（每项目一行），GET 随即服务存储版；DELETE 清除后回到
  草稿。生成失败或超时都不会覆盖已存正文。
- **限额与守卫**：prompt ≤60000 字符、正文 ≤200000 字符、请求体 ≤4 KiB、model pref id
  受 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` 约束、默认 90 秒超时（`writeupTimeoutMs`）。
  POST/DELETE 走 `requireOperator` 与 `isCrossOrigin`；上游报错文本先经 `sanitizeText`
  掩掉密钥样式再放进 `detail`。`@cairn/graph` 不依赖 `@cairn/agent`：生成器由 HTTP 层
  注入，测试用 fake generator 覆盖成功、失败、超时与脱敏路径。
- **与报告的分工**：`/report` 仍是可分享的只读快照，不含工件路径与 Flag；Writeup
  面向复盘，含证据路径与 Flag 原文，因此只在同源/operator 守卫下写入，且不提供跨项目
  汇总。

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
- **工具调用上限（M12b）**：任务可带 `maxToolCalls`，worker 以
  `CAIRN_TASK_MAX_TOOL_CALLS` 传给 Host Bridge。达到上限后所有后续调用被拒绝，审计
  条目附 `event: "tool_budget_exhausted"`，让 solver 用已有证据收尾。计数在每个 worker
  进程内独立，subagent 进程另有自己的计数；它是最佳努力的成本护栏，不是安全边界。
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
不改既有列；`POST /projects` 的响应体不变），任务生成时写入 `task.json`。M17a 起还可
通过 `PUT /projects/{id}/scope` 补配或替换，`GET /projects/{id}/scope` 只读返回当前
范围；`GET /projects` 的 `has_scope` 直接查询该表。worker 不读
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
  `soft_deadline_ratio`、`retain_task_files`、`result_grace_seconds`、`scoped_artifacts`
  （布尔；缺省时等于 `runtime.max_project_workers > 1`，显式 `false` 可以关闭任务级
  artifacts 命名空间）。
- `tasks.graph_slice` 是新增的可选段：`enabled`（布尔，默认 `false`）、`max_facts`
  （整数 ≥ 2，默认 80）、`max_intents`（正整数，默认 60）。缺省即保持全图行为；非法值
  在启动时以 `ConfigError` 拒绝。
- `tasks.evidence.min_bytes` 控制接受证据的最小字节数（非负整数，默认 `1`，`0` 关闭）。
  缺省拒绝 0 字节文件；非法值在启动时以 `ConfigError` 拒绝。
- `retention` 是新增的可选段（M6）：`session_max_age_days`（非负整数，默认 `0` 关闭）、
  `session_keep_per_project`（非负整数，默认 `0` 关闭）、`sweep_interval_seconds`
  （非负整数，默认 `3600`，`0` 只保留启动 sweep）、`refresh_artifacts`（布尔，默认
  `false`）。四个字段都可省略；负值、非整数或非布尔值以 `ConfigError` 拒绝。
- `observer` 是可选段（M4c；M22 起 `enabled` 默认为 `true`，可写 `false` 关闭）：`enabled`（布尔）、`model`
  （model-prefs 条目或 `null`）、`every_rounds` / `window_rounds` / `timeout_seconds`
  （正整数）、`max_reviews_per_task`（非负整数）、`kernel_tasks`（
  `bootstrap|reason|explore|conclude` 的子集，默认 `["explore"]`）。`enabled` 默认开启是
  M22 的行为变化；非法值在启动时以 `ConfigError` 拒绝。scheduler 只把该配置翻译成
  `CAIRN_OBSERVER_*` 环境变量，不写进 `task.json`。
- `proposals` 是新增的可选段（M11，默认关闭）：`enabled`（布尔）、`mode`
  （`off|dry_run|apply`，默认 `apply`）、`max_per_task`（非负整数，默认 20）、
  `max_file_bytes` / `max_total_bytes`（正整数，默认 16384 / 65536，后者不得小于
  前者）、`allow_kinds`（`fact|intent|hint` 的子集，默认全部）、
  `require_evidence_for_fact`（布尔，默认 `true`）、`min_confidence`（`[0,1]`，默认
  `0`）。只有 `observer.enabled` 且任务命中 `kernel_tasks` 时才会生成候选；scheduler
  把策略翻译成 `CAIRN_OBSERVER_PROPOSALS_*` 环境变量，不写进 `task.json`。
- `strategist` 是新增的可选段（M12a）：`min_new_facts`、`min_new_hints`、
  `cooldown_seconds`、`failure_backoff_seconds`、`max_runs_per_hour`、
  `zero_output_threshold`、`stale_intent_seconds`、`fallback_interval_seconds`，全部为
  非负整数。默认依次为 `1/1/30/120/12/3/0/0`；`0` 关闭对应维度（`min_new_facts` 与
  `min_new_hints` 同时为 `0` 时只剩 initial/open-empty/零产出/陈旧/fallback 等事件）。
  M14b 增加 `resource_pressure_ratio`（`[0,1]`，默认 `0` 关闭）：已结束 run 的 token
  或成本用量达到该比例时触发一次非紧急 `resource_pressure:*`，同一压力区间不重复。
  该段只影响 reason 何时派发，不改变图、任务契约或 worker 环境。
- `budget` 是新增的可选段（M12b）：`max_project_tokens` 与 `max_project_tasks` 为非负
  整数，`max_project_cost_usd` 为非负有限数，默认全为 `0`。token/成本 `0` 关闭门禁；
  `max_project_tasks` 为 `0` 时继承 `runtime.max_project_workers`，非零值仍会与全局
  `runtime.max_workers` 取较小值。token/成本按项目已结束 run 汇总，只拦截新的
  bootstrap/reason/explore，不拦截 pending conclude；在途任务未上报前可能超预算。
- `worker_profiles` 与 `worker_selection` 是新增的可选段（M15a/M15e）：profiles 是
  `{id, model}` 数组，id 匹配 `[A-Za-z0-9][A-Za-z0-9._-]*`（≤64）且唯一，model 是
  model-prefs 条目名（≤128）；selection 的 `mode` 为 `prompt | stats`（默认 `prompt`），
  `min_runs` 是非负整数（默认 `3`）。`epsilon`（默认 `0.1`，`0` 关闭探索）是采样期后
  每次派发的探索概率上界，`epsilon_decay`（默认 `0.99`，范围 `(0,1]`）在每次合格派发后
  乘到 `epsilon` 上，`epsilon_min`（默认 `0.01`）是下限且不得大于 `epsilon`。
  `stats` 模式必须至少有一个 profile。scheduler
  把选中的 `workerProfile` / `model` 写入 `task.json`，并按 profile id/模型记录
  `runs`；`prompt` 模式完全保持旧行为。选择读取跨项目 `runs.worker_profile` 历史：
  先按配置顺序采样到每个 profile 有 `min_runs` 个已结束 run，再按成功率选择，平局依次
  比较每结束 run 的 Token、成本与配置顺序；合格派发（扣除采样期）的累计探索预算
  `Σ ε·decay^k` 整数部分增长时改为探索，选已结束 run 最少的 profile；排队的 conclude
  复用失败任务的 profile。策略是确定性的：同样的 run 历史永远得到同样的选择。
  凭据仍只在 agent 配置中，派发表只出现 id 与模型名。
- `verification` 是新增的可选段（M14a/M18f）：`evidence_enforcement` 为
  `completion | off`（默认 `completion`），决定 API 新建项目与旧项目的完成证据策略；
  `challenge.base_url_env` / `challenge.agent_token_env` / `challenge.code_env` 是
  **环境变量名**（默认 `TCH_CHALLENGE_API_BASE_URL` / `TCH_CHALLENGE_AGENT_TOKEN` /
  `TCH_CHALLENGE_ID`），`challenge.timeout_ms` 是正整数（默认 `5000`）。`code_env`
  非空时新项目自动选择 challenge。配置里不保存地址、token 或题目编号的值；
  缺省使用默认值，非法值以 `ConfigError` 拒绝。
- `audit_stream` 是新增的可选段（M9，默认关闭）：`enabled`（布尔，默认 `false`）、
  `url`（可选的 http(s) 地址）。启用后 scheduler 才签发 bearer token 并注入 worker；
  本地模式在 `url` 缺省时使用实际监听的 loopback 地址，容器模式必须显式配置。缺省值
  不改变 M7 的行为；非法 URL 在启动时以 `ConfigError` 拒绝。
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
  `model-prefs.json`、`provider-prefs.json`）与 prompt frontmatter 的 `model`。M15a 起
  启用 `worker_profiles` 时，任务里的 `model` 覆盖 prompt frontmatter 的选择，但仍
  解析到同一个 model-prefs 文件；没有任务级 `model` 时保持原行为。本地模式由
  worker 在启动真实 Solver 前补齐内置 prompts/skills；容器模式由控制面在挂载前补齐，容器
  内因 `CAIRN_AGENT_CONFIG_READONLY=1` 跳过写入。`CAIRN_AGENT_CONFIG_DIR` 可覆盖配置目录
  （测试用）。手工配置时 API key 通常只写 `auth.json`，`models.json` 的 `apiKey`
  写环境变量名（如 `CAIRN_MODEL_API_KEY`）作占位即可。M18a 的 API 创建的自定义
  provider 例外：SDK 按 provider 读取 `models.json` 的 `apiKey`，所以
  `applyProviderApiKey` 同时写 `auth.json` 与 `models.json` 的明文副本，清除时两侧
  一起删除；`provider-prefs.json` 与所有 HTTP 响应仍只保留掩码/`hasApiKey`。
  `setProviderHeaders` 同样只写 `models.json`，不把请求头值复制到
  `provider-prefs.json`。
- **容器内的只读配置与任务副本**：宿主配置目录以 `readonly` 挂到 `/cairn/agent-config`，
  但上游 `AuthStorage` 会在 `auth.json` 旁建 `auth.json.lock`。只读挂载下该操作以 `EROFS`
  失败，错误被存储层记录后凭据集合为空，`getApiKey` 回退到 `models.json` 的字面占位符，
  表现为网关 401。因此每个任务在容器内把配置复制到
  `/tmp/cairn-agent-config/<task_id>/`（目录 `0700`、`auth.json` `0600`），设置
  `CAIRN_AGENT_CONFIG_DIR` 指向副本，任务结束即删除。源挂载始终只读，副本只在容器可写层，
  不写入工作区、`task.json` 或日志；配置目录的拒绝读取规则仍然覆盖源挂载。
- `cairn-worker` 提示词引用的 12 个 skills 随 `packages/agent` vendor；未引用的
  `fuzz-dicts-skills` 与 `payloads-everything` 已删除以控制仓库体积。
- **启动快照脱敏（M13a）**：真实 Solver 会把会话选项写入任务会话目录的
  `startup.json`。该文件曾把 `sessionOptions.authStorage.data.<provider>.key` 原文带进
  项目工作区。`packages/agent/src/solver/session.ts` 现在对字段名匹配
  `key/token/secret/password/authorization/credential`（含 camelCase、下划线、连字符）
  的值写 `[REDACTED]`，主 Solver 与子代理共用同一序列化路径；`session.test.ts` 锁定该
  行为；M13a 的真实模型 gate 还会扫描整个项目工作区，出现 `auth.json` 中的凭据值即失败。
  这不能替代文件权限与容器边界（模型仍可通过 `bash` 读取可访问的文件），但保证控制面
  自己生成的诊断文件不再落明文密钥。
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
- 重试策略：不自动重试同一任务；由 scheduler 依据 `strategist_state` 水位、事件触发与
  未认领意图决定是否再派发。reason 失败后按 `failure_backoff_seconds` 退避；退避期间
  连紧急触发也被抑制。
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

## 11. Phase 0 遗留物的处置

以下 Phase 0 组件已从合并版移除，仓库内不再保留对照副本（2026-10-27 复核）：

- `WorkerDriver` / `registry` / `workers/adapters/*` / `WORKER_ENV_KEYS`；
- `tch.py`、`tch_bridge.py`、`solver rpc` 适配、`tch` 提示词释放逻辑；
- `ctfagent/scripts/apply_overlay.py` 及其文本补丁；
- Python 的 prompt 渲染、调度、进程 runtime（由 TS 端口替代）。

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
- session 保留（M6）只删除 `<workspace>/.cairn/sessions` 的直接子目录，跳过符号链接；
  运行中任务与 pending 会话受保护。保护集合读取失败时整轮不删除（fail closed）。删除
  不可恢复，默认关闭两条规则；若要保留审计证据，应先备份或把 session 移出可清理范围。
- 审计账本（M7）把 `audit.jsonl` 导入控制面 SQLite，因此 session 目录被清理后审计仍
  可查询；逐 task 哈希链能发现账本行被改写或链接断裂。但事件仍由 worker 生成，导入只
  证明“控制面在任务结束时看到了这些行”，不证明 worker 没有漏写或伪造；能改写数据库的
  人也能重算整条链。默认仍不是实时账本；控制面崩溃前未 `finish` 的事件不在覆盖范围内。
  M9 的可选实时流把已发生的 `tool_call` 事件及时送入同一账本，token 绑定项目/task、
  只存哈希、任务结束撤销；但 Host Bridge 运行在不可信 worker 内，token 也只在 worker
  环境里，因此它降低暴露窗口，不能阻止 worker 漏写/伪造或本地文件被篡改。实时流默认
  关闭，且必须由部署显式提供 worker 可达的控制面 URL。
- Observer 看板是**建议性数据**，不是图事实：主 Solver 只读，真正结论仍必须写进
  `result.json` 并经控制面校验。看板的写保护只覆盖结构化文件工具与白名单；`bash` 可在
  工作区内改写它。看板不得存 flag、凭据、完整工具输出或与授权范围无关的数据。同项目
  并发（M8）时 review 通过 `<board>/locks/review.lock` 项目级租约串行，拿不到租约就
  跳过本轮；该租约只覆盖 Observer review，不覆盖 `bash` 直写看板，也不是进程退出后
  自动回收的强锁（靠心跳过期接管）。artifacts 命名空间同样只约束结构化文件工具。
- Observer 提案（M11）是**不可信输入**：sidecar 与主 Solver 都在 worker 内，候选文件
  可能被模型、被 `bash` 或被篡改的工作区伪造。控制面把它当作外部输入重新校验版本、
  类型、项目/任务绑定、来源 Fact、证据路径、置信度与去重键，再在独立事务中决定是否
  写图；`off`/`dry_run` 不写图。提案不能删除或改写既有事实，也不能绕过 Scope 或证据
  校验。主 Solver 的结构化文件工具对 `<session>/observer/` 只读，但 `bash` 不受此约束；
  因此候选配额可能被挤占，审核结论仍需按不可信数据处理。UI 对提案只读，但整个 API
  仍无认证，远程部署必须加网络层访问控制。
- 慢层触发状态是控制面内部的调度数据（`strategist_state`），worker 不可读写，也不进入
  `task.json`；触发/抑制日志只包含项目、trigger、计数与原因，不含 prompt 或模型输出。
- 凭据只读挂载；日志脱敏；任务与结果文件按项目隔离。exec 环境只传白名单，容器不暴露
  Docker socket。M13a 起，Solver 的 `startup.json` 按字段名脱敏认证存储，真实模型 gate
  还会对项目工作区做凭据值扫描，防止诊断快照把 `auth.json` 的内容带进工作区。
- 模型配置 API（M18a）改变了凭据的**写入面**，因此额外约束：所有写路由要求
  operator token，并拒绝 `Origin` 与控制面 host 不一致的请求；读取只返回掩码与
  `headerNames`；删除被引用的 provider/模型默认 409。`models.json` 因 SDK 约定保存
  明文 `apiKey`，与 `auth.json` 同属敏感文件，部署时仍按凭据文件保护（测试目录用
  `0700`/`0600`）。发现与连通性测试会让控制面访问用户提供的 `baseUrl`，这是有意的
  SSRF 面，仅限已认证操作员且只接受 http(s)、不含内嵌凭据的地址，错误信息按已知
  密钥与常见认证字段脱敏后再返回。
- 容器是主要的爆炸半径边界；本地模式仅用于受控开发/靶场。
- 合规前提：仅限已获明确书面授权的测试、靶场、比赛或企业自查。

## 13. 待定问题

1. 任务文件保留多久：M3 默认保留全部 `sessionDir` 供审计，
   `worker.retain_task_files: false` 可整目录删除。M6 已提供按项目/时间/数量的
   `retention` sweep（默认两条规则均为 `0`，即行为不变）；默认值是否需要收紧、以及
   审计要求下是否允许自动删除仍需按部署决定。
2. ~~同一项目并发 worker~~：M8 已提供任务级 artifacts 命名空间、索引溯源和项目级
   Observer review 租约，并有一个真实重叠的并发集成测试。剩余边界：`bash` 写路径不
   受命名空间约束；review 租约靠心跳过期接管，进程被冻结超过 stale 窗口时仍可能短暂
   双持有；M6 的 retention 保护集合只覆盖本进程 `running` 表与 pending 行，若同一
   工作区被多个控制面共用仍没有跨进程协调。
3. ~~conclude 的会话恢复~~：M4a 已定为复用失败任务的 `sessionDir`，由
   `SessionManager.open` 恢复最新 JSONL；M5c 已将 pending 队列持久化到
   `pending_concludes`，重启后按行优先派发（不再依赖内存或租约过期重派）。M6 在
   启动 sweep 中删除指向已完成项目、已结束/不存在 intent 或缺失会话的行，并为后者
   释放租约。
4. Prompt group 是否在 M3 后彻底移除，还是保留给 fake/mock 集成测试。
5. 本地模式的 `bash` 依赖：容器镜像自带 POSIX shell 与 `procps`；本地模式仍要求用户在
   Windows 安装 Git Bash/MSYS2/Cygwin/WSL 之一，是否注入跨平台 shell 替身待定。
6. 强审计：M7 已在任务结束时把 `audit.jsonl` 有界导入控制面 SQLite（逐 task 哈希链），
   M9 又提供可选的逐事件实时转发；审计不再依赖 worker 可写的 session 目录存活，实时流
   也缩短了“事件已发生但尚未入账”的窗口。剩余边界：实时流默认关闭且依赖部署提供可达
   URL；worker 崩溃前未 flush 的尾部事件、worker 的漏写/伪造，以及能重写数据库的攻击者
   都不在账本防护范围内。由控制面在每次 `tool_call` 时直接判定并记账（而非信任 worker
   转发）仍是后续增强，需要把 Host Bridge 决策搬到控制面或引入双向 RPC。
7. 图切片的默认 caps（80 facts / 60 intents）尚未在真实大项目上调参；是否也对 reason
   启用切片、以及是否需要按 token 预算而非对象计数，待有真实数据后决定。
8. Observer 看板的完整性：结构化文件工具的写保护已落地，但 `bash` 仍可写工作区内的
   看板；是否要对 bash 解析重定向/`tee`/脚本写入，或把看板移出 worker 可写挂载，待定。
   `tools/gate/m4c-observer-gate.ts` 已用真实模型跑通一次短 bootstrap（14/14），但长任务
   下的成本、延迟和看板质量仍需更多实测。
9. 证据的强度：M5b 已把 size/SHA-256 固化到 `fact_evidence` 并提供实时校验；M5c 增加
   `tasks.evidence.min_bytes`（默认拒绝 0 字节文件），但仍不要求证据在 Fact 之后保持
   存在，也不检查内容是否真的支持结论。是否引入控制面签名、以及是否按任务类型设置
   不同阈值，待定。符号链接一律拒绝，在 Windows 上开发时会跳过依赖 symlink 的测试。
10. 提案的实时性与审批：M11 只在任务结束或后续 tick 摄取，不是实时写图，也没有人工
    审批队列；是否需要受任务 token 保护的实时上报通道，以及是否给 `apply` 增加人工
    确认步骤，待有真实使用数据后决定。
11. 慢层调度与成本：M12a 已持久化触发水位并加事件触发、失败退避、冷却与小时配额；
    M12b 已加意图优先级/预算、单项目 token/成本门禁与并发配额；M12c 已提供只读
    strategist API 与“慢层”UI。M13a 在真实模型上跑通了用量链路与预算耗尽（2026-10-26，
    `deepseek-flash`）：5 个短任务共 134,740 tokens，慢层占 74,273（55.1%），cache read
    占 87.5%，两个 Fact 均无被接受证据；1,000 token 上限在首个 reason（22,381 tokens）
    后阻止了后续派发。仍未解决：网关未返回价格，`cost_usd` 只能是 0 或用外部单价估算；
    只有短任务样本，默认 cooldown 30s、退避 120s、每小时 12 次、零产出 3 次尚未按长
    任务调参（`stale_intent_seconds` 与 fallback 默认关闭）；图切片是否扩展到 reason
    需要更多样本。用量的已知偏差：只统计主 solver 会话、在途任务不参与门禁、硬杀/旁路
    损坏按 0 计，因此 token/成本上限是软约束而非硬计费边界；慢层视图只展示该偏差，不做
    在途预留。是否把子代理用量汇总进项目账本，待定。M13b 的 `/cost` 只能做**平均分摊**：
    一个 reason run 创建多个意图、或一个 explore run 产出多个 Fact 时，无法知道真实归属；
    M13b 之前的意图没有 `origin_run_id`，其编排成本永久未归因。分摊保证总量守恒，但不是
    逐 token 计量，也不能作为对外计费凭证。M14b 补上了 reason 的 Hint/去重输出、人工
    重规划与资源压力触发；仍未解决：Prompt 扩展尚未在真实模型上做 A/B，Hint 质量与
    dedupe key 的稳定性没有基线；`resource_pressure_ratio` 默认关闭，触发阈值需要按长
    任务样本调整；人工重规划只有单项目级标记，没有排队、审批或原因审计。M14c 补上了
    `runs.model` 与 Fact→run→工具调用的 UI 下钻；仍未解决：model 只随 `usage.json`
    落库，fake solver、没有用量或被硬杀的任务为 `null`，conclude 是否应继承失败任务的
    模型也未单独标注。M14d 补上了只读逐 Worker/模型统计（成功率、outcome、Token、
    成本、平均耗时）与「统计」页签；仍未解决：统计按项目隔离，在跑任务的 model 尚为
    空，worker 仍固定为 `cairn-worker`，成功率的“结束”包含拒绝/取消/不健康，且统计
    尚未用于派发选择或跨项目汇总。M15a 已把 profile 统计接回派发：先采样后利用，
    平局按 Token、成本、配置顺序打破，conclude 复用失败任务的 profile；M15e 补上
    epsilon-greedy 探索（解析式衰减预算、探索时选最少样本）与真实 model-prefs 校准
    gate；仍未解决：选择只会在 `stats` 模式下发生，冷启动样本少时退化为配置顺序，
    成功率未按任务难度或项目类型分层，探索预算按“合格派发”而非墙钟时间计算，且
    epsilon 默认值尚无跨项目长跑样本可校准。
    M14a 把完成判定收紧为完成时强制证据后，真实模型基线首次通过：3 个任务共 132,967
    tokens（input 12,317 / output 8,522 / cache read 112,128），1 个 Fact 带 `provided`
    证据并通过 evidence oracle 关闭项目。token 量随模型自行拆分探索的粒度波动很大
    （同配置的失败试跑达到 23–25 万），只能作量级参考。
