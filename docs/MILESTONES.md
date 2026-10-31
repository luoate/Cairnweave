# 里程碑与验证记录

本文件保留 M1–M32b 的实现记录、测试与浏览器验证清单、与 Python Cairn 的已知差异、
里程碑表以及与 Phase 0 的关系。产品概览、快速开始与 API 概览见 [README](../README.md)。

## 实现记录

状态：**M32b（Flag 复核改为后台进行）**；M0–M4、M5a–M5c、
M6–M11、M12a、M12b、M12c、M13a、M13b、M14a、M14b、M14c、M14d、M15a、M15b、M15c、M15d、M15e、M15f、M16a、M16b、M17a、M17b、M17c、M17d、M18a、M18b、M18c、M18d、M18e、M18f、M18g、M19a、M19b、M20a、M20b、M21、M22、M23、M24、M24b、M25、M26、M26b、M27、M28、M29、M30、M31、M32、M32b 的计划项全部完成。Phase 1 的
“本地看板 + Observer 提案 + 证据门 + 单一写图者”闭环已具备；Observer 复盘自 M22 起默认
开启（只读复盘，不改任务结果），提案自 M23 起默认 `dry_run`（完整校验并记录，不写图）。
Phase 2 的触发持久化、意图优先级/预算、单项目 token/成本与并发配额、只读慢层观测、逐 Fact
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
并输出当前 epsilon 与探索预算。M15f 收尾 Phase 4：Phase 0 的对照副本已不存在于仓库，文档
改为现状说明；静态 UI 顶部常驻“无身份认证”提示，`cairn serve` 绑定非回环地址时在启动日志
再次警告；新增 `docs/CONTRACT.md` 汇总 task/result/usage/audit 的字段、校验与退出码。
M16a 加持续集成门槛：`.github/workflows/ci.yml` 在 Ubuntu 上用 Bun 1.4.4 执行
`bun install --frozen-lockfile`、`bun run typecheck` 与 `bun test`，根脚本
`bun run check` 在本地复现同一门槛，README 顶部显示 CI 徽章。真实模型 A/B 工具
`tools/gate/m16-model-ab.ts` 为两个 arm 各建独立数据库与工作区、用单 profile 统计配置
（`min_runs: 0`、`epsilon: 0`）跑同一组 marker 项目，比较成功率、Token、成本与耗时；
启动前校验两个 model-prefs 条目存在且解析到不同 provider/model，观测到的 run.model
集合必须不重叠，否则拒绝运行。第二个真实模型（`GLM-5.3-Flash`）的接入与首次真实对比
在 M16b 完成。
M17a 修复前端 P0：此前 UI 新建项目不带 `scope`，而调度器对无范围项目 fail-closed，页面
创建的项目永远不会派发。现在「新建项目」必须填写至少一个授权目标，按行去重后作为
`scope` 提交；项目列表对无范围项目显示“未授权”，项目详情常驻授权范围卡片，可对既有
项目补配或修改。后端新增 `GET/PUT /projects/{id}/scope`，`GET /projects` 增加
`has_scope`，`POST /projects` 的既有契约不变。
M17b 面向日常操作：项目列表增加搜索（标题/ID/状态/备注）、可点击的状态计数筛选与
三种排序，筛选与排序存入 `localStorage`；轮询在页面隐藏时暂停、恢复可见时立即刷新，
失败按 5s→60s 指数退避，列表与项目视图都显示错误横幅和重试按钮，并给出最后更新时间
与手动刷新。侧栏八个运维页签改为可横向滚动，并按项目记住上次停留的页签。
M17c 统一表单与弹窗：13 个 overlay 共用一个模态栈，Esc 只关最上层（输入法组合中不
响应），Tab 在最上层弹窗内回环、焦点逃出弹窗会被拉回，关闭后焦点回到触发元素；打开时
把焦点交给 `[data-autofocus]`，并在 Alpine 真正显示该层后重试，避免焦点掉回页面。
新建项目、范围补配、重命名与服务端设置改为行内校验：逐字段红框加提示，提交后聚焦第一个
错误项；所有写操作在请求期间禁用按钮并显示“…中…”，重复点击不再重复提交。停止项目与
“停止全部”不再直接发 PATCH，先弹出二次确认，说明已认领意图会被释放，取消或点背景不改
状态。以上仍只影响静态 UI，HTTP 契约、图与调度语义不变。
M17d 对齐详情与图的交互：项目卡片可用 Tab 到达并用 Enter/Space 打开（卡片内按钮不会
冒泡触发），进入项目后焦点落到图视图标题，返回列表时焦点回到来源卡片、卡片已被删除则
回到搜索框，返回按钮补齐可访问名称；图视图在无弹窗、焦点不在输入控件时按 Esc 清除选择，
多选详情面板显示“已选 N 个事实”并提供“清空选择”；图页头的删除入口与列表统一走
`deleteProjectById`，不再依赖当前选中状态推断标题。
M18a 增加模型与密钥管理 API（UI 在 M18b 接入）：控制面按需加载 `@cairn/agent` 的
`ConfigManager`，提供 `/settings/agent` 下的 provider/模型 CRUD、模型列表拉取（复用
`discoverModels`）、测试连接与“设为默认 worker 模型”。API key 只写不读：写入
`auth.json`，并在添加模型时同步到 SDK 必需的 `models.json` 副本，任何响应只返回掩码；
`provider-prefs.json` 不落 key，provider `headers` 只写 `models.json` 且只回传名字。
所有写路由在配置 `CAIRN_OPERATOR_TOKEN` 时要求 `X-Cairn-Operator-Token`，并拒绝
Origin 与请求 host 不一致的浏览器写请求；删除仍被模型、`worker_profiles`、Observer
或 prompt 默认引用的配置返回 409，`?force=true` 才级联删除。测试连接的错误文本会先
替换真实密钥，再遮蔽 `Bearer` 与 `api_key=…` 形态的凭据，且不回传 `details.headers`。
M18b 把这套 API 接进静态 UI：页头的 CPU 图标打开“模型与密钥”弹窗，Provider 页签可
新增/编辑名称、协议、Base URL、API Key 与额外请求头（密钥只写、留空表示不修改），
删除被引用条目时行内提示并切换为“强制删除”；模型页签可先拉取内置目录或远端
`/models`，再选模型 ID，或手工填写，并展开 thinkingLevel、reasoning、输入模态、四项
成本、contextWindow、maxTokens 与模型请求头。列表给出默认标记/引用方，支持设为默认、
编辑、测试与行内删除确认；所有写操作沿用弹窗栈的禁用与回焦约定（现为 14 个 overlay）。
内置 provider 只填名称时，同步到 `models.json` 的 `provider:<id>` 会继承内置协议与
Base URL；测试前若 provider 尚未保存密钥，直接给出可读提示而不是 SDK 的文件路径错误。
M18c 收尾模型管理：新增 `docs/MODELS.md` 一页操作手册（五步接入、HTTP 速查、文件落点、
常见错误、临时目录演练与 M16b 真实 A/B 步骤），并用
`apps/cairn/src/http/agent-config.flow.test.ts` 在空配置目录上串起“provider/密钥 →
模型 → 默认 → 配置文件校验 → 强制删除回收”的端到端流程，断言每一步响应都不含密钥与
header 值。gate 不会用占位凭据放行——M16b 就是用它当时留下的入口接入第二个模型的。
M18d 让连通性测试真正可用：Provider 卡片新增“测试连通性”，服务端优先选用该 provider
的 `cairn-worker` 默认条目（否则第一条）真实调用一次，响应标明实际测试的模型；没有
模型条目时返回可读提示。服务端给测试加 60 秒上限（`agentTestTimeoutMs` 可调），超时
返回 `connectivity test timed out after 60s` 而不是无限挂起；`Bun.serve` 的
`idleTimeout` 从默认 10 秒放宽到 120 秒，避免请求先被框架中断、拿不到脱敏结果。
M18e 把拿到的 Flag 显示到项目页：新增只读 `GET /projects/{id}/flag`，从已索引的
`artifacts/**` 中提取 `CTF{…}` / `flag{…}` 一类字符串，跳过二进制、超大文件和占位符
（如 `CTF2{...}`），并按出现文件数排序；不改变可分享的 `/report` 契约，也不暴露
任意文件读取。项目页头下方在命中时显示绿色 Flag 横幅，标注来源工件并提供复制按钮，
轮询期间找到后不再重复扫描。浏览器已用 proj_008 实测显示，proj_007 等无 Flag 项目
不显示横幅。
M18f 打开 challenge/Flag 自动校验：服务端环境存在 `TCH_CHALLENGE_ID`
（`verification.challenge.code_env` 可改名）时，新建项目自动落库
`verification.kind=challenge` 并以该值作为题目编号；显式请求体仍然优先，`code_env`
为空时回退 `evidence_enforcement`。新建弹窗新增“完成校验”选择（自动 / 题目 /
证据 / 关闭）与题目编号行内校验。`GET /projects/{id}/flag` 同时返回
`verification: {policy, latest}`，页头 Flag 横幅显示“题目校验：通过 n/n”或失败原因；
challenge 项目未通过时轮询会持续刷新校验状态，直到调度器写入通过检查。策略仍在
创建时固定，已有项目不会因环境变量变化而切换。
M18g 修复 Flag 被改成 `CTF2{[REDACTED]}` 的问题：worker prompt 不再要求隐藏 flag，
而是要求把真实值原样写进 Fact 描述与证据文件（凭据、token 与其他密钥仍然禁止）；
`/flag` 过滤 `redacted`、`masked`、`[hidden]` 等占位符，证据里只剩占位符时再以只读、
限量的方式回退扫描 `.cairn/sessions/*/solver-session/*.jsonl`，恢复旧任务被改写的
真实 flag。UI 横幅直接显示真实值，不回显日志内容或凭据。
M19a 增加中文 Writeup：`packages/graph/src/writeup.ts` 从图中数据（项目、scope、
当前 Fact、攻击路径、取代关系、Hint、Flag 与校验、run 统计、证据文件附录）确定性地
渲染一份简体中文 Markdown 草稿，只读、不调用模型、不新增未经核实的内容；
`GET /projects/{id}/writeup` 返回草稿（`format=markdown` 直接下载）。`POST` 可让所选
模型按草稿重写一份模型撰写版并存入新表 `project_writeups`，`DELETE` 回到草稿。
草稿同时作为模型 prompt 的唯一素材，Flag 原文照抄、凭据仍禁止；prompt ≤60000 字符、
正文 ≤200000 字符、默认 90 秒超时，失败沿用已存正文并返回 502/504。UI 新增
「Writeup」页签，支持复制、下载与“AI 撰写/恢复草稿”。详见 `docs/WRITEUP.md`。
M20a 让 Writeup 写明载荷：`isWriteupPayloadPath` 用扩展名与文件名关键字从工件索引里确定
性地挑出脚本、投递容器与 payload（普通响应转储 `.txt/.out/.resp/.md/.json` 不算），
`## 载荷（Payload）` 章节把文本逐字内联进带语言的代码块，二进制只登记路径，超预算截断并
标注，没读到内容时写“内容未读取”而不是留空。条目多于 20 个时由
`selectWriteupPayloadArtifacts` 排序截断：被某条 Fact 的 `evidence_refs` 引用过的载荷排最前，
纯探测脚本才被截进附件包，章节首行同时写明“识别到 N 个、此处列出 M 个”（`payloads_total`）。
读文件仍只在 HTTP 层发生
（`apps/cairn/src/http/project-payload.ts`），沿用 Flag 扫描的路径收敛：必须落在
`<workspace>/artifacts` 内、非符号链接、单文件 ≤128 KiB，只读选中的 ≤20 条、单项目 ≤24000 字符。
JSON 视图新增 `payloads` 投影（`state: inline|binary|unread` 与 `referenced_by`），模型
撰写 prompt 增加“载荷逐字符照抄、未内联不得虚构”的硬性要求。详见 `docs/WRITEUP.md` §1.1。
M20b 把 Writeup 引用的附件真的送到人手里：新增只读路由
`GET /projects/{id}/writeup/archive` 返回一个 zip，里面是 `writeup.md`（当前服务的正文，
模型版或草稿）、`MANIFEST.md`（中文清单：项目、打包时间、Flag、载荷统计、逐文件 sha256 与
来源任务，外加「未打包文件 + 原因」表）和 `artifacts/<索引路径>`，路径与正文引用逐字对应。
打包范围是该项目**全部**已登记工件（上限 500 个文件 / 单文件 4 MiB / 总量 64 MiB），读取复用
`openArtifactRoot` + `readArtifactFile` 的同一套收敛，越界、目录或已清理的路径只会进未打包表，
不会静默丢件。ZIP 由 `apps/cairn/src/http/zip.ts` 自行写出（store 与 raw deflate 取更短者、
CRC-32、单一中央目录、文件名 UTF-8 标志位、固定时间戳所以字节确定），同文件的 `readZip()` 读回
并校验 CRC 作为格式自检，Windows `Expand-Archive` 实测能直接解开。UI 的操作条加
「附件包 N」按钮，`archive:{available,files}` 为假时不出现。详见 `docs/WRITEUP.md` §1.2。
M21 修掉 Flag 扫描自己造出的假阳性：`/flag` 的 solver-session 回退原先逐行扫描 JSONL 原文，
模型在 assistant 叙述里写下的缩写（`CTF2{c8xxxx}`、`CTF2{c8...}`）因此也进候选池，并按出现
次数压过工具真正返回的那个值——横幅显示半截 Flag，Writeup 里却是正确的。现在回退只解析
`role: "toolResult"` 的消息正文（`sessionToolText`），assistant/user 文本不再算证据；
`isPlaceholder` 加上掩码判定（`...`、`…`、`**`、`xxx` 连写，以及 `uuid`/`partial`/`truncat*`
这类替身词按词段匹配，`flag{fragment_of_the_flag}` 与 base64 里的 `xx` 不会被误杀）。被拒的
值不静默消失：`/flag` 新增 `candidates`（≤3 条，含 `occurrences`/`sources`/`placeholder`）与
`placeholder_suspect`，UI 在没有采纳任何值、却看到 flag 形状文本时显示琥珀色「FLAG 可疑」条并
列出原文，绿色横幅则标注“另有 N 个候选”；Writeup 草稿的 Flag 段写“只扫描到疑似占位或截断的
flag 文本”，撰写 prompt 同步禁止把占位串当答案或自己拼一个看起来完整的 Flag。
详见 `docs/WRITEUP.md` §1.3。
M22 把运行期配置从“改文件再重启”变成“默认更可用、前端可调”：Observer 复盘默认开启
（`observer.enabled` 默认 `true`；它只写看板与审计，不改变任务结果，提案仍由
`proposals` 段单独控制，M23 起该段默认 `enabled: true` + `mode: dry_run`）。页头新增
「运行配置」弹窗，可调调度并发与间隔、任务超时、
图切片、证据门、Worker 软截止与保留、保留/清理策略、预算、策略触发阈值、提案参数与
Worker 选择策略。改动以 snake_case patch 存进 SQLite 的 `runtime_config_overrides`，
不会被下一次进程启动覆盖；服务端把它深合并到 dispatch.yaml 的解析结果上并**复用同一套
校验器**重新解析（跨字段约束如 `max_project_workers ≤ max_workers`、`max_total_bytes ≥
max_file_bytes` 依然生效），然后原地同步进正在运行的 `DispatchConfig`，调度器在下一个
tick 生效，间隔类字段会重新挂定时器。只读区展示 `server`、`common_env` 键名、
`worker_profiles`、Observer 与审计流等部署项，它们仍需改 YAML 并重启。`DELETE` 清空
全部覆盖回到文件值；`PUT` 整组替换（UI 只提交与文件基线不同的字段）。详见
`docs/CONFIG.md`。
M23 把 Observer 的两类产物默认打开：`proposals` 默认 `enabled: true`、`mode: dry_run`，
sidecar 仍只能提交候选，控制面照常做来源/证据/去重校验并把结果记进 `proposals` 表，
但没有一条写入图——把「提案」页签从空列表变成可观察的审核流水，真正写图仍需运营者把
`mode` 改成 `apply`。新增只读 `GET /projects/{id}/board`（`http/project-board.ts`）读取
工作区 `.cairn/board/board/`：想法索引取 `ideas/index.json`，记忆逐条读
`memory/entries/*.json`，未知状态/类型分别归一到 `pending` / `note`；工作区或看板目录是
符号链接、越界路径、非普通文件、超限文件都会被拒绝或跳过，条目数与正文/引用长度也有
上限，响应带 `ideas_total` / `memory_total` / `truncated`。没有看板（或纯 HTTP 模式）
回答 `available: false` 而不是报错。UI 在「提案」与「成本」之间新增只读「看板」页签，
按状态/类型着色展示想法与记忆，显示条目计数与截断标记；页签同样只发 GET，写看板仍只
发生在 Observer 的 sidecar 会话里。
M24 把执行模式变成可在线切换的设置项，并统一前端入口。`runtime.execution` 进入运行期
覆盖白名单：`RuntimeConfigStore` 新增 `validateNext` 钩子，在解析成功后、原地同步前拒绝
“调度器有任务在跑 / 正在切换 / 本机无 Docker”的请求；校验通过后 `Scheduler.reconfigure()`
发现模式变化，会等 `running` 清空再重建 runtime 后端、关闭旧后端，并重新解析工作区根
目录。dispatch.yaml 缺少 `container:` 段时只在解析前补上镜像/网络/收尾动作默认值，不写进
覆盖 patch。进入容器模式前，控制面把内置 prompts/skills 播种到宿主 agent 配置目录。API
的 `workspaceRoot` 改为 getter，工件、证据、Flag 与 Writeup 路由在切换后立即读新根。前端
把原先的「运行配置 / 模型与密钥 / 本地偏好 / 服务端设置」四个弹窗合并为一个带四页签的
「设置」弹窗，页头只留一个齿轮按钮；弹窗打开与切换页签时按需加载。浏览器标题随当前
项目变为「项目名 · Cairn」。
M24b 在执行模式下拉旁加「测试有效性」。`POST /settings/runtime/test` 探测请求里选择的
模式（不是运行中的模式）：`local` 检查 Bun 版本与工作区临时文件写入；`container` 检查
Docker 守护进程、`container.image`（缺省 `cairn-worker:latest`）是否存在，再用
`docker run --rm --network none <image> bun --version` 试启动一次，镜像缺失时在说明里给出
构建命令。逐项结果带 `{id,label,ok,detail}`，`ok` 为全部通过；探测不写配置，失败项在
弹窗内联显示，切换执行模式后清空旧结果。
M25 把技能纳入同一个「设置」弹窗。config 层在 `packages/agent/src/config/skills/index.ts`
增加 `createSkill` / `removeSkill` / `restoreBuiltinSkill` 与删除记录，`ConfigManager` 暴露
对应方法；控制面新增 `apps/cairn/src/http/agent-skills.ts` 挂载
`GET/POST /settings/agent/skills`、`PUT /settings/agent/skills/{name}/enabled`、
`POST /settings/agent/skills/{name}/restore` 与 `DELETE /settings/agent/skills/{name}`，
写路由沿用 operator token 与跨源拒绝。技能文件存在不等于生效：只有 `cairn-worker` prompt
`meta.skills` 白名单里的名字会被 `buildResourceLoader` 加载，所以新增默认同时写入白名单、
删除同时移出，内置但未引用的 5 个可用「启用」补齐。内置技能共 17 个，GET 每次幂等播种
（用户改过的文件不被覆盖）；删除内置把顶层目录名记进 `<configDir>/skills/.deleted-builtins.json`，重启与再次播种都跳过，列表保留「已删除」行并提供「恢复」，
恢复只回填文件、不自动启用。新增名按 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（≤64）校验且必须与
目录名一致，删除/启停按目录名做路径安全校验。UI 在「模型与密钥」与「本地偏好」之间新增
「技能」页签，行内完成启停、删除确认与恢复，底部表单新增技能并可选择「添加后立即启用」。
M26 把所有技能收进同一个入口，并把运行配置目录改成与项目同名的 `~/.cairnweave/config`。
config 层在 `packages/agent/src/config/skills/index.ts` 增加只读的 `listSkillFiles`
（≤200 个文件、递归深度 ≤8）与 `readSkillFile`（读 256 KiB 前缀、含 NUL 判为二进制、路径逐段
拒绝空段/`.`/`..`/超长段/保留字符与控制字符，再做词法与 realpath 双重包含并拒绝软链接），
`ConfigManager` 透传；控制面在 `apps/cairn/src/http/agent-skills.ts` 挂
`GET /settings/agent/skills/{name}/files` 与 `GET /settings/agent/skills/{name}/file?path=`，
只读路由沿用 GET 免 token 规则，非法路径 400、技能或文件缺失 404。前端给每个技能行加
「预览」，打开第 13 个 overlay `skillDetail`：左侧把扁平路径还原成目录树，右侧原样渲染正文，
打开即自动预览排序后的第一个文件，头部保留启停，启停写入期间不允许关闭、关闭时复位状态；
已删除的内置没有文件，因此不渲染「预览」。默认 agent 配置目录同时从 `~/.tch-agent/config`
改名（`apps/cairn/src/agent-config-dir.ts`）：控制面启动、播种内置技能之前，若仍在使用默认
目录且新目录为空，就逐文件复制旧目录（跳过软链接、总量 ≤64 MiB、绝不覆盖已有文件、绝不删除
旧目录，可重跑可回滚），`CAIRN_AGENT_CONFIG_DIR` 显式指定目录时不迁移；Host Bridge 的拒绝根
同时覆盖新旧两代与显式目录。BreachWeave 内核仍在 `~/.tch-agent` 下读写 runtime、solvers 与
challenge 目录，容器内只读挂载点 `/cairn/agent-config` 也未变。本轮还把 17 个内置技能的
`SKILL.md` 正文译为简体中文（frontmatter 的 `name` 仍是目录 slug；`description` 一并译成中文，
其中 5 个用了 YAML 块标量因此含换行，前端列表与详情用两行截断收纳）。
M26b 把项目名统一成 **Cairnweave**：仓库目录 `cairn-merged` 改名 `cairnweave`、根
`package.json` 的 `name` 随之改为 `cairnweave`（`bun.lock` 重新生成），README 标题与首段、
Web UI 的 `<title>`、页头品牌字与 `document.title`（「项目名 · Cairnweave」/列表页
「Cairnweave」）统一；协议标识刻意保持不变——`CAIRN_*` 环境变量、工作区 `.cairn/` 目录、
`cairn-worker` prompt、`@cairn/*` 包名与 `cairn` 命令仍是 Cairn 图内核的名字，Python golden
对照与已跑出的项目数据依赖它们。
M27 把前端首屏从 3.82 MB 压到 96 KB（br 后的传输量）。原来 `<head>` 里排着 9 个脚本：
Tailwind 的 Play CDN（vendored `tailwindcss.js`，451 KB，在浏览器里对着 class 名单现算样式）
加 cytoscape 核心、dagre/klay/elk 三对布局引擎（其中 `elk.bundled.js` 单个就 1.6 MB），全部
在列表页就下载。样式改成一次性预编译：`tools/ui/input.css` + `tools/ui/tailwind.config.mjs`
逐字复刻原先写在 `index.html` 里的 theme（连副作用一起照搬——顶层 `fontFamily` 覆盖整条字号族、
`bg-white/92` 落在默认透明度刻度外，所以 `font-mono` 与 `bg-white/92` 这两个 class 在旧版同样
不产生规则，测试里显式豁免），`bun run ui:css` 用 Tailwind CLI 生成入库的
`apps/cairn/src/http/static/app.css`（33 KB，br 后 6 KB），CI 重新生成一次并
`git diff --exit-code` 防止产物与页面漂移；除这一步之外仍然没有打包器。图视口的重量挪出首屏：
`static/graph-loader.js` 只在 `initGraph`、切换布局、保存偏好这三条路径上按需注入 cytoscape
核心与所选引擎，扩展文件在脚本加载时自己 `register(cytoscape)`，所以核心必须排在引擎前面串行
注入；默认 dagre 布局不再下载 klay 的 496 KB 与 elk 的 1.6 MB，注入失败给中文 toast 而不是白屏。
`http/static-assets.ts` 接管 `GET /` 与 `/static/*`：按 size+mtime 出 ETag，配
`Cache-Control: no-cache` 与 `Vary: Accept-Encoding`，`If-None-Match` 命中回 304，可压缩类型在
内存里（≤64 个文件）缓存 gzip 与 brotli 变体并按 `Accept-Encoding` 协商，`/static/` 之外或越出
目录的目标一律交回 API 路由。
M28 把界面文字收进一条命名字号刻度，并把中文可读性定成硬下限。`index.html` 里散着 472 处
`text-[9px]/[10px]/[11px]` 任意值（外加 3 处 `text-[12px]`、2 处 `text-[15px]`），同一档字号还分三行
写；全部映射到命名 token：三档小字号统一为 `text-2xs`，它是 `theme.extend.fontSize` 新增的
11px 一档（`line-height: 1.3`），`text-[12px]` 归 `text-xs`，两处标题归 `text-base`；`text-xs`
与 `text-sm` 原样保留，所以密度仍是紧凑仪表盘，只是不再有 9px 的中文。同一个配置补上
`fontFamily.mono`，修掉了 M27 记录里那个连带 bug——顶层 `theme.fontFamily` 替换整条字族刻度，
旧配置只列 `sans`，于是 94 处 `.font-mono` 编译不出任何规则，project id、Flag、路径、工具名这些
本该等宽的文字一直在用正文字体；现在它们真的等宽了，`api.ui.test.ts` 的豁免集合也随之从
`font-mono` + `bg-white/92` 收到只剩 `bg-white/92`。新增的 `typography scale` 用例锁住三件事：
markup 不出现 `text-[<数字`、`app.css` 里最小 `font-size` ≥ 11px 且存在 `.text-2xs`、配置同时声明
`sans` 与 `mono`。几何 A/B 用隐藏浏览器在 532×555 视口逐状态实测（列表 / 详情 / runs / audit /
writeup / settings）：最小字号 9px→11px，小于 11px 的节点从 14/11/56/133/13/13 归零，含中文的
小字从 14/8/33/74/8/8 归零，而横向溢出容器数（2）与越出视口的元素数（0/5/5/6/6/6）改前改后完全
一致——放大没有引入新的裁切。cytoscape 画在 canvas 上的标签（边 7px、节点 10px）留作图布局问题，
它被固定节点盒约束，不属于 DOM 文字，测试注释里记了这个例外。
M29 按实测数据收了两处后端热点。`facts` 的主键是 `(id, project_id)`，而项目列表的
`(SELECT COUNT(*) FROM facts WHERE project_id = p.id)` 与 `GET /projects/{id}` 的按项目读取都只带
`project_id`，因此每次都要整表扫描；`packages/graph/src/db.ts` 增加
`CREATE INDEX IF NOT EXISTS facts_project ON facts(project_id)`，`EXPLAIN QUERY PLAN` 由 `SCAN facts`
变为 `SEARCH facts USING (COVERING) INDEX facts_project`。这属于复杂度修正：demo 库只有 12 个项目 /
43 条 Fact，改前改后都在 0.06 ms 量级，量不出差别，所以只在 `db.test.ts` 的 `schema` 组里把两条查询
（含 `COUNT(*)` 的 covering 变体）的计划钉死，防止以后被改回去。第二处是 `/flag` 的会话兜底：原有
文件/字节上界只统计真正读到的文件，被跳过的会话目录不计入，于是一个积了三万多个任务目录的工作区会把
同步 handler 卡住——demo 数据里 proj_003 单次 `/flag` 2.4 s 且一个文件都没读。现在
`scanSolverSessionFlags` 用不带 `withFileTypes` 的 `readdirSync` 只取名字（Windows 上 `withFileTypes`
会先给每个条目做一次 lstat，正是开销来源），逐项改用 `lstatSync(path, { throwIfNoEntry: false })`，
并给遍历本身加上界：`SESSION_MAX_DIRECTORIES = 1000` 个会话目录、`SESSION_MAX_ENTRIES = 4000` 个
文件系统条目（被跳过的目录、缺失的 `solver-session`、非 jsonl 文件都占额度），撞到任一上界就把
`truncated` 置真——截断是对 UI 如实的“没扫完”，不是静默少看。`collectProjectFlag` 外面再包一层
按工作区键控的短缓存（TTL 10 s、最多 32 项、最旧淘汰）：指纹是调用方给的工件列表 `path + size`，
新增工件或大小变化立即失效，只有同名同大小的原地改写要等 TTL；返回值是副本，调用方改 `sources` /
`candidates` 不会污染缓存，`clearFlagCache()` 供测试与替换工作区时清空。
M30 补上融合方案里唯一的接口缺口：按需子图。M4b 的 `exportProjectSliceYaml` 是给 scheduler
用的「focus intent + 全部未结束 Intent + provenance 闭包」，没有跳数概念，也没有对外入口。
`packages/graph/src/export.ts` 新增 `selectSubgraph`：`around` 同时接受 Fact 与 Intent（类型由
项目图判定），在 Fact↔Intent 因果边上做 BFS，`depth` 默认 2、上限 4；所有未结束 Intent 作为
0 跳种子，保证并行方向始终可见。裁剪顺序固定为 `origin`/`goal` → focus → 已选 Intent 的来源 →
按跳数，被裁即 `truncated: true`；跳到上限之外的 Intent 产出 Fact 不会因为排序被重新拉回来，
这条在测试里单独钉住。`exportProjectSubgraphYaml` 复用同一套渲染辅助与 `slice:` 段风格。
HTTP 侧 `GET /projects/{id}/subgraph` 默认返回 JSON，`format=yaml` 返回快照文本；
`depth`/`max_facts`/`max_intents` 有显式上下界且越界返回 400 而不是静默夹取，`max_facts`
最小 2 是因为 `origin`/`goal` 是项目头，裁掉会让 YAML 的 `project` 段失真。该接口只读，
不改 `tasks.graph_slice` 的调度行为，全图导出与 golden 不受影响。
M31 补上融合方案的第二个缺口：描述级 Intent 去重。此前 reason 与 Observer 提案只看
`dedupe_key`，模型换个说法（同方向、不同 key）就会重复建意图，把并行 worker 引到同一处。
`packages/graph/src/proposals.ts` 新增 `findDuplicateOpenIntent`：先按非空 `dedupe_key`
精确匹配未结束 Intent，再对描述做 NFKC、转小写、去掉空白与标点（`\p{P}\p{S}`）归一化，
在归一化后 ≥10 字符、长度比 ≥0.75 的前提下比较字符二元组的 Jaccard 相似度，≥0.9 即命中；
命中原因区分 `dedupe_key` 与 `description`。只有未结束的 Intent 参与比较，已结束方向
可以重新提出。reason 侧命中只跳过该条并计入 `deduped`（整轮仍算成功），提案侧返回
`duplicate` + `intent_description_open`，`applied_id` 指向已存在的意图。匹配器不新增列、
不落库，图模型、YAML 与 HTTP 响应均不变。
M32 把 flag 真伪判定从模型手里交回操作员。此前 worker 只要在 Fact 描述里写一个
flag 形状的值，就会被 `/flag` 当作结果展示；假 flag（decoy）与真 flag 在图上没有区别，
模型也可能在抓到第一个 flag 后直接声明完成。新增共享分类器 `apps/cairn/src/flags.ts`
（与 `/flag` 同一套前缀/掩码规则），scheduler 在 explore / conclude 的 Fact 描述、
bootstrap 的 Fact 与完成描述、reason 的完成描述里发现 flag 值时，按
`UNIQUE(project_id, flag)` 记一行 `flag_reviews`。M32b 把最初的“暂停项目”改成后台复核：
`pending` 不进入 `tryDispatch` 门禁，reason / bootstrap 的完成声明也不再推迟，项目边跑
边等判定。操作员三选一：`real_more` 记 verified，项目仍 active 时写去重 Hint 继续探索；
`real_done` 记 verified、把其余 pending 置 dismissed，项目仍 active 时控制面用该 flag
关联的 Fact 直接 `completeProject`（没有 Fact 则 409），项目已结束时只记录判定；`fake`
记 rejected，项目仍 active 时写去重 Hint，此后同值不再入队，`/flag` 与 Writeup 扫描也
过滤它。判定是终态（重复提交 409），路由沿用操作员凭据；配置
`verification.flag_review` 默认 `manual`、`off` 关闭复核。`flag_reviews` 是旁路表，
图导出、YAML 与任务契约不变。
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

- **Observer sidecar（M22 起默认开启）**：`observer.enabled` 为真（默认）且任务 kind 命中
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

- **Observer 提案闭环（M23 起默认 dry_run）**：sidecar 新增 `propose_graph_change` 工具，只能把
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
- **三种模式**：`proposals.mode: off | dry_run | apply`，默认 `enabled: true` + `dry_run`。`dry_run` 完整执行来源、证据与
  重复校验，但只把结果记为 `dry_run`，不写图；`apply` 才真正写入。所有决策
  （`applied / rejected / duplicate / dry_run`）带 `decision_reason` 与 `applied_id`。
- **只读观测**：`GET /projects/{id}/proposals` 支持 `status`/`kind` 过滤；UI 增加只读页签
  “提案”，显示候选内容、来源、证据、去重键、审核结果与写入 ID。M23 又增加只读“看板”
  页签（`GET /projects/{id}/board`）直接展示 Observer 的想法与记忆。提案文件、看板文件与
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
  日志和数据库只保存计数，不保存 flag 明文或 token。flag 明文只出现在 worker 的
  Fact/证据与 solver-session 日志中，供项目页展示；oracle 从不读取它。
- **evidence oracle**：reason 的 `complete.from` 中每个非种子 Fact 必须关联到一次
  run（`fact_meta.run_id` 非空）、`evidence_status = provided`、`evidence_refs` 非空
  且至少一条 `fact_evidence`；`origin` / `goal` 是前提，不作为证据要求，但只有种子
  Fact 的完成声明仍然失败。bootstrap 用任务级 `evidence_refs` 校验（它的 Fact 在同一
  事务里新建）。缺少证据的完成声明被拒绝，并记录缺口。
- **只读查询与手动复核**：`GET /projects/{id}/verification` 返回策略与最近一次检查；
  `POST /projects/{id}/verify` 可手动重跑（可带 `facts` 子集）。两种策略的判定都会入
  `verification_checks`。
- **prompt 契约**：每个任务的 prompt 末尾追加 Completion Verification 段；
  BreachWeave 入口也明确要求 `evidence_refs`，并要求拿到 flag 时原样写入描述与证据
  （不得脱敏），同时严禁写入凭据、token 与其他密钥。详见 `docs/VERIFICATION.md`。

M18f 增加（自动 challenge 校验）：

- **环境驱动默认策略**：`POST /projects` 时若请求体未给 `verification`，先读
  `verification.challenge.code_env`（默认 `TCH_CHALLENGE_ID`）；非空即落库
  `{kind: challenge, challenge_code}`，否则按 `evidence_enforcement` 落 `evidence` /
  `off`。显式请求体优先；策略创建后固定。
- **UI 创建与展示**：新建弹窗可选择自动 / 题目 / 证据 / 关闭，并校验题目编号；
  Flag 横幅读取 `GET /projects/{id}/flag` 的 `verification` 快照，显示通过计数或失败
  原因，challenge 未通过时轮询持续刷新。
- **demo 配置**：`runs/demo/dispatch.yaml` 仍保留 `evidence_enforcement: off` 作为
  本地演练逃生口；设置 `TCH_CHALLENGE_ID` 后新建项目仍会自动走 challenge 校验。

M19a 增加（中文 Writeup 生成）：

- **确定性中文草稿**：`buildProjectWriteup` 只组合既有读取（`getProjectDetail`、
  `getProjectScope`、`listFactSupersessions`、`buildProjectRunStats`、
  `summarizeProjectVerification`、`listProjectArtifacts`、`fact_meta` 与 `runs`），
  渲染结论、题目与目标、攻击路径、当前有效事实清单、被取代的判断、Hint、Flag 与
  校验、执行统计与证据文件附录；除 `generated_at` 外输出稳定，不写图、不写旁路。
- **草稿与 Flag 一致**：草稿复用 `/flag` 的 `collectProjectFlag`，artifacts 优先、
  solver-session 回退，两个视图不会给出不同的 Flag。
- **模型撰写版可选**：`POST /projects/{id}/writeup` 用 `completeText`（无工具的
  单轮补全）按草稿重写，正文写入 `project_writeups`（每项目一行）；prompt 硬性要求
  全程简体中文、只使用草稿里的事实/证据/Flag、Flag 逐字符照抄、不得写入凭据。
  生成失败或被替换前，已存正文保持不变。
- **边界与守卫**：prompt ≤60000 字符、正文 ≤200000 字符、附录 ≤200 个文件、默认
  90 秒超时；写请求需 operator token 且拒绝跨源；provider 报错文本经 `sanitizeText`
  脱敏后才会出现在 `detail` 中。
- **UI**：侧栏「Writeup」页签按项目记忆，显示中文草稿或模型撰写版，提供复制、
  Markdown 下载、“AI 撰写”与“恢复草稿”。

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

M15f 增加（Phase 0 清理、认证提示与契约收尾）：

- **Phase 0 清理**：仓库内没有 `ctfagent/` 对照副本，Phase 0 的 `tch` driver、
  `tch_bridge.py`、`solver rpc` 适配与 overlay 补丁均已移除；README 与
  `ARCHITECTURE.md` 第 11 节改为现状说明，模块对应关系保留在 `docs/PORTING.md`。
- **认证提示**：静态 UI 在列表与图视图上方常驻“无身份认证”提示，说明界面与 API 会直接
  修改控制面数据、应只绑定回环地址或置于受信网络/反向代理之后；`cairn serve --host`
  绑定非回环地址时在启动日志输出同类警告。默认绑定仍是 `127.0.0.1`。
- **契约收尾**：新增 `docs/CONTRACT.md`，汇总 `task.json` 字段与校验、`result.json`
  信封与各 kind 载荷、`usage.json` 上限、`audit.jsonl` 事件与哈希链、worker 退出码以及
  路径/原子性与安全边界；README 文档索引与 `ARCHITECTURE.md` 数据所有权表指向它。
- **验证**：UI 静态测试断言认证提示文案与回环地址说明；全量测试与 typecheck 通过。

M16a 增加（CI 门槛与真实模型 A/B 工具）：

- **CI 门槛**：`.github/workflows/ci.yml` 固定 Bun 1.4.4，缓存安装目录后执行
  `bun install --frozen-lockfile`、`bun run typecheck`、`bun test`；`bun run check`
  在本地按同一顺序执行。CI 只使用 fake solver，不需要模型凭据。
- **真实模型 A/B**：`bun run tools/gate/m16-model-ab.ts`。两个 arm 顺序执行，各自使用
  独立临时数据库、工作区和单 profile 统计配置（`min_runs: 0`、`epsilon: 0`），
  创建同样的两个 marker 文件与两个未认领意图，因此每个任务都是 explore 且必然落到该
  arm 的 model-prefs。报告记录每个 run 的 profile/model/outcome/Token/成本/耗时，给出
  A−B 差值与两侧 summary。
- **拒跑条件**：缺少 `CAIRN_AB_MODEL_A` / `CAIRN_AB_MODEL_B`、两个条目相同、或两个
  条目解析到同一 `provider/model` 时直接失败（退出 2）；跑完后还要求两侧上报的
  `run.model` 集合不重叠、任务数相同。这样不会把“同一个模型跑两次”记成 A/B。
- **当前状态**：M16b 已用两个真实模型跑通（见下），`deepseek-chat` 等未被网关支持的
  候选仍会返回 `MODEL_NOT_SUPPORTED`，工具不会用占位凭据放行。`CAIRN_AB_SOLVER=fake`
  可离线演练两个 arm 的派发与报告，此时模型相关断言（`run.model`、模型集合不重叠）
  会按预期失败。
- **验证**：`bun run tools/gate/m16-model-ab.ts` 在缺参和同条目两种情况下均以退出码 2
  结束并写出 `runs/m16-model-ab.json`；全量测试与 typecheck 通过。

M16b 增加（第二个模型接入与真实 A/B）：

- **第二个真实模型**：在同一网关的另一协议路径上注册 provider（示例名 `gw-zhipu`，
  协议 `openai-completions`，Base URL 形如 `https://<gateway-host>/ai/<vendor>/openai/v1`；
  真实 provider 名与主机名只留在本机配置目录，不进公共仓库）与模型条目
  `zhipu-glm-flash`（`GLM-5.3-Flash`），复用已有密钥、不改默认 `cairn-worker`。
  这一步只用 M18a/M18b 已交付的 `/settings/agent` 路由，没有新增产品代码。
- **连通性先于 gate**：`POST /settings/agent/models/zhipu-glm-flash/test` 返回
  `ok: true`，证明同一把密钥在该协议路径上被上游接受；该网关不提供 `<baseUrl>/models`，
  模型发现返回 502，因此模型名按运维者给定值手填。
- **一次真实对比**：A/B 取 `CAIRN_AB_MODEL_A=cairn-worker`、
  `CAIRN_AB_MODEL_B=zhipu-glm-flash`、`CAIRN_AB_TASKS=2`，12 项检查全部通过、退出码 0，
  两侧观测模型集合不重叠。arm A（`deepseek-flash`）2 个 run 全成功、74,227 Token、
  墙钟 29.5 s；arm B（`GLM-5.3-Flash`）2 个 run 全成功、75,141 Token、墙钟 150.9 s。
  网关未上报成本，两侧 `cost_usd` 都是 0，比较落在 Token 与耗时上。
- **不把它当结论**：单样本 2 任务只证明链路可用与量级差异，`outcome=success` 表示
  worker 返回值被接受并写入图，不代表 marker 值逐字符正确；判定任务质量仍要回看项目
  事实与证据。报告文件在 `runs/`（已 gitignore），数字记录在 `docs/MODELS.md` 第 7 节。

默认仍是确定性 fake solver，测试与离线运行不需要模型凭据。Observer 只接在
`CAIRN_SOLVER=breachweave` 的真实 Solver 路径上，fake solver 会忽略它。


## 验证（M1 + M2a + M2b + M2c + M3 + M4a + M4b + M4c + M5a + M5b + M5c + M6 + M7 + M8 + M9 + M9.1 + M10 + M11 + M12a + M12b + M12c + M13a + M13b + M14a + M14b + M14c + M14d + M15a + M15b + M15c + M15d + M15e + M15f + M16a + M17a + M17b + M17c + M17d + M18a + M18b + M18c + M18d + M18e + M18f + M18g + M19a + M19b + M16b + M20a + M20b + M21 + M22 + M23 + M24 + M24b + M25 + M26 + M26b + M27 + M28 + M29 + M30 + M31 + M32 + M32b，2026-10-31，Bun 1.4.4）

- `bun test`：**863 passed**（83 个文件），0 failed。
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
- **Observer（M4c，不计费）**：配置合法性校验（M22 起默认开启，可 `observer.enabled: false` 关闭）；scheduler 的 context/env
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
- **Phase 0 清理与契约收尾（M15f）**：UI 静态测试断言“无身份认证”与回环地址提示；
  `docs/CONTRACT.md` 与 contracts 源码逐字段核对（task 字段/limits、result 信封、
  usage 上限、audit 事件、退出码）；仓库内无 Phase 0 对照副本。
- **CI 与 A/B 工具（M16a）**：`.github/workflows/ci.yml` 与 `bun run check` 执行同一
  typecheck + test 门槛；Linux 容器用 Bun 镜像复跑同一命令验证不依赖 Windows 路径。
  `tools/gate/m16-model-ab.ts` 在缺少两个 model-prefs、条目相同或同模型时以退出码 2
  拒跑，并写出失败报告；真实 A/B（M16b）已用两个真实模型跑通，见下一条。
- **真实 A/B（M16b）**：新模型条目 `zhipu-glm-flash`（`gw-zhipu/GLM-5.3-Flash`）
  的连通性测试返回 `ok: true`；A 臂取 `cairn-worker`、B 臂取该条目、每臂 2 个任务，gate
  以退出码 0 结束，`passed: true`、12 项检查 0 失败，两侧 `run.model` 集合不重叠。
  arm A 2 个 run 全成功 / 74,227 Token / 29.5 s，arm B 2 个 run 全成功 / 75,141 Token /
  150.9 s。该网关不提供 `<baseUrl>/models`（发现返回 502）也不上报成本，因此两侧
  `cost_usd` 为 0，比较只看 Token 与耗时；`runs/` 已在 `.gitignore` 中，报告不入仓库，
  数字记录在 `docs/MODELS.md` 第 7 节。
- **前端授权范围（M17a）**：UI 静态测试断言新建表单要求至少一个目标、`scope` 随
  `POST /projects` 提交、范围读写只走 `GET/PUT /projects/{id}/scope`、列表
  `has_scope` 徽章与详情卡片；HTTP 测试覆盖范围的默认空值、去重/裁剪、替换、空目标
  422 与未知项目 404。浏览器实测创建（重复行去重）、编辑范围，以及为无范围项目补配后
  `has_scope` 翻转。
- **列表与轮询（M17b）**：单测从内联脚本实例化 `cairnApp()`，直接校验搜索匹配
  （标题/ID/状态标签/备注）、状态筛选与三种排序，并断言排序不修改入参；UI 测试断言
  搜索框、排序选择、状态筛选、空结果提示、`visibilitychange`、指数退避、
  `cairn.listPrefs` 与 `cairn.sideTabs`。浏览器实测搜索/筛选/排序与刷新、失败横幅，
  以及运维页签横向滚动和按项目恢复。
- **表单与弹窗一致性（M17c）**：单测实例化 `cairnApp()` 校验模态栈的入栈/出栈与顶层
  判定、Tab 在两端回环、焦点逃出弹窗被拉回、禁用与隐藏控件不计入可聚焦集合、autofocus
  在该层完成布局前按帧重试且有上限、请求期间拒绝关闭弹窗；另校验授权目标按行去重与逐行报错、
  新建项目四个必填字段、超时整数校验，以及停止/停止全部的确认状态、确认与失败回吐后
  状态复位。UI 静态测试断言 14 个 overlay 都挂在同一 `syncModal` 栈上、各自只有一个
  `data-autofocus`、互为 body 直接子节点（漏掉一个 `</div>` 会把后续弹窗嵌进前一个，
  从而永不显示），并断言停止入口只走确认弹窗。浏览器实测 Esc/Tab 回环与回焦、背景点击
  取消、行内校验与聚焦第一个错误项、提交中禁用、停止单个/全部确认与恢复项目免确认。
- **详情/图交互一致性（M17d）**：单测校验返回列表时按项目 ID 找到来源卡片并聚焦、卡片
  不存在时回落到搜索框、离开列表后放弃残留焦点；Esc 处理器只在图视图、无弹窗、焦点不在
  输入控件且确有选择时清除选择，输入法组合中与空选择时不拦截。UI 静态测试断言卡片带
  `role="button"`/`tabindex="0"`/Enter-Space 处理（`.self` 避免内部按钮冒泡）、图标题
  可聚焦且返回按钮有可访问名称、多选面板有唯一“清空选择”入口，并断言删除入口只剩
  `deleteProjectById`。浏览器实测 Enter/Space 打开项目、进入后聚焦标题、返回后回焦卡片、
  Esc 清除选择与清空按钮、弹窗打开时 Esc 只关弹窗而不清选择。
- **模型与密钥管理 API（M18a）**：HTTP 测试在临时配置目录上跑完整 CRUD——写入密钥后
  `provider-prefs.json` 与 `GET /settings/agent` 都不含明文（仅 `sk-test-...123456` 掩码），
  `auth.json` 持有真实值；自定义请求头同样只写不读（只回 `headerNames`）；模型条目的
  `cost`/`input`/`compat`/`contextWindow` 可往返。轮换密钥后 `auth.json` 与
  `models.json` 的 `provider:<id>` 副本同步更新，`apiKey: null` 清除两侧；设为默认模型
  复制为 `cairn-worker`，`referencedBy` 为 `prompt:cairn-worker`。删除被引用的 provider/
  模型返回 409 并列出依赖方，`?force=true` 才放行并回收模型。校验矩阵覆盖非 http(s)
  URL、内嵌凭据、缺失 `api`/`baseUrl`、未知协议、未知 provider、非法 pref id 与
  thinkingLevel。operator token 缺失 401、GET 保持开放；跨源 Origin 的写请求 403。
  注入 fake manager 的用例断言 `test` 输出会抹掉密钥、`Authorization` 与 `Bearer` 片段，
  且发现接口只返回模型 id/名称。M18b 追加：以内置名创建 provider 时 `models.json` 的
  `provider:<id>` 继承 `anthropic-messages` 与官方 Base URL；未保存密钥时测试直接返回
  “provider has no API key”，不再暴露配置文件路径。
- **模型与密钥 UI（M18b）**：UI 静态测试从内联脚本实例化 `cairnApp()`，校验请求头解析
  （注释/空行、`:` 或 `=` 分隔、非法名称与超长值逐行报错）、provider 表单校验（自定义
  必须协议+地址、内置可省略、拒绝 `ftp://` 与内嵌凭据、密钥长度、非法 header 名）、
  模型提交载荷（思考级别/推理/输入模态/四项成本/上下文/最大 Token/请求头）、编辑时
  不带条目 ID、非法字段不发请求、拉取后选择模型并回填显示名、未命中提示、409 后切换
  “强制删除”、请求中禁止关闭弹窗，以及设为默认调用 `/settings/agent/default-model`。
  浏览器实测：打开弹窗并聚焦关闭按钮；添加内置 `anthropic` provider；拉取 22 个内置
  模型并选择 `claude-sonnet-4-5`；展开高级参数后保存，列表显示 `thinking:high`、
  `text+image`、`ctx 200000`、`max 8192` 与 `cost 3/15`；设为默认后出现 `cairn-worker`
  默认条目与 `prompt:cairn-worker` 引用；编辑名称并保存；无密钥测试显示可读错误；
  删除默认条目被 409 拒绝后出现“强制删除”；Esc 关闭并回焦入口按钮，控制台无脚本错误。
- **模型管理端到端流程（M18c）**：新测试在全新临时配置目录上按操作顺序执行 GET 空快照
  → 创建自定义 provider（含密钥与 header）→ 添加带高级字段的模型 → 设为默认 → 复核
  快照（掩码、默认标记、`prompt:cairn-worker` 引用、字段复制）→ 读取四个配置文件
  （`provider-prefs.json`/`model-prefs.json` 无密钥与 header 值，`auth.json` 持有密钥，
  `models.json` 的 `provider:<id>` 含协议/Base URL/模型）→ 无 force 删除 409 → 强制
  删除回收两个条目 → 快照清空。整轮收集的响应文本均不含密钥或 header 值。操作手册
  `docs/MODELS.md` 覆盖同一路径及 M16b 真实 A/B 步骤。修复 `runs.id` 是全局主键、而编号
  计数器按项目各从 1 开始导致的跨项目 `run_001` 冲突：分配时跳过已被其他项目占用的
  id，新增用例覆盖两个项目的连续分配。
- **连通性测试（M18d）**：路由测试用永不 resolve 的 fake manager 和 20ms 上限断言返回
  `connectivity test timed out after 20ms` 且不拖住请求；provider 测试用例确认优先选择
  `cairn-worker`、无模型条目时给出可读提示且不调用上游；UI 测试确认 Provider 卡片按钮
  调用 `/settings/agent/providers/{id}/test`、展示实际测试的模型并在失败时提示。服务端
  测试上限默认 60 秒，`Bun.serve` 的 `idleTimeout` 放宽到 120 秒。
- **Flag 展示（M18e）**：路由测试覆盖命中并回显来源、占位符过滤、二进制/超大文件跳过、
  `../` 越界路径拒绝、无 workspace 与未知项目 404；UI 测试确认 `loadProjectFlag` 调用
  `GET /projects/{id}/flag`、横幅来源文案与复制动作。浏览器在 proj_008 实测显示真实
  Flag，proj_007 不显示横幅。
- **challenge/Flag 自动校验（M18f）**：配置测试覆盖 `code_env` 解析与默认值；
  路由测试确认 `TCH_CHALLENGE_ID` 存在时新建项目自动落库 challenge 策略、显式
  `verification` 仍然优先；UI 测试确认校验徽标的通过/失败/关闭文案、challenge
  未通过时的继续轮询条件、新建弹窗的题目编号行内校验，以及 `auto`/`challenge`/
  `evidence`/`off` 到创建请求体的映射。
- **Flag 原文（M18g）**：prompt 契约用例断言要求真实 flag 原样写入、凭据仍禁止；
  扫描器用例覆盖 `[REDACTED]`/`masked`/`[hidden]` 与括号体占位符被拒、solver-session
  JSONL 回退恢复真实值、二进制与超限文件跳过。浏览器在 proj_008 复核横幅显示真实 flag。
- **中文 Writeup（M19a）**：`packages/graph/src/writeup.test.ts` 覆盖空项目草稿、
  校验策略回退、攻击路径（run worker/model/outcome 与证据引用）、当前事实清单、
  取代关系、Hint、challenge 校验渲染、附录 200 个文件截断、多行 Fact 折叠、prompt
  硬性规则（简体中文、只用草稿素材、Flag 照抄、禁止凭据）与 `project_writeups`
  存取/替换/清除；`apps/cairn/src/http/api.writeup.test.ts` 覆盖草稿 JSON/Markdown、
  非法 `format` 与未知项目、模型撰写入库与回读、默认 model pref、生成失败保留旧正文
  （502）、provider 错误脱敏为 `<redacted>`、20ms 超时 504、请求体校验 400、operator
  token 401 与跨源 403、GET 免 token、DELETE 恢复草稿；UI 测试确认 `loadWriteup` 只读、
  `generateWriteup` 走 POST 并置 `generating`、`resetWriteup` 走 DELETE、Markdown 下载
  链接与页签记忆。
- **Writeup 面板修正（M19b）**：UI 测试断言面板内不再出现 `justify-between`、操作条为
  `flex flex-wrap items-center gap-1.5`、`下载 Markdown` 按钮绑定 `downloadWriteup()`，
  并验证下载只走 GET 路由与本地锚点点击（不发写请求）、`writeupFileName()` 生成
  `writeup-proj_008.md` 并过滤 `../` 等非法字符。浏览器实测点击后锚点 href 指向
  `?format=markdown`、`download` 为 `writeup-proj_008.md` 并弹出“已下载”提示。
- **Writeup 载荷（M20a）**：`writeup.test.ts` 覆盖 `isWriteupPayloadPath` 的接受/拒绝清单、
  文本内联与 `referenced_by`（`artifacts/` 前缀与反斜杠都归一化）、二进制只登记路径、
  无字节时“内容未读取”、4000 字符截断、20 条上限与 `payloads_total`/附录不受影响、
  被证据引用的载荷排在截断之前（`selectWriteupPayloadArtifacts` 首条即 `z-forge.py`）、
  含反引号时加长围栏、空清单文案与 prompt 的载荷硬性规则；`project-payload.test.ts` 覆盖
  读取分类、超窗口/缺失/`../` 逃逸路径全部跳过、无 artifacts 目录时返回空；
  `api.writeup.test.ts` 覆盖 JSON `payloads` 投影的 total/inline/binary 计数与未挂载
  工作区时的 unread 状态。
- **Writeup 附件包（M20b）**：`zip.test.ts` 断言 crc32 已知向量（`0xcbf43926`）、
  `buildZip`/`readZip` 往返、二进制逐字节一致、deflate 与 store 各自选小者、空条目与空包、
  同一输入两次生成字节相同、条目名归一化（反斜杠与前导 `/`）与 `..`/空段拒绝、
  篡改正文后 `readZip` 报校验失败；`project-archive.test.ts` 覆盖条目顺序
  （`writeup.md`、`MANIFEST.md`、按路径排序的 `artifacts/**`）、清单里的文件表与校验行、
  四种跳过原因文案、500 条上限、索引为空、附件目录不可读、模型成稿优先与逃逸路径不入库；
  `api.writeup.test.ts` 覆盖 `GET /projects/{id}/writeup/archive` 的 200
  `application/zip` + `content-disposition`、把响应字节交回 `readZip` 校验、
  JSON `archive:{available,files}` 三种门控（未索引 / 已索引 / 工作区未挂载）、
  无 workspace root 时 409、未知项目 404；`api.ui.test.ts` 断言按钮只在
  `writeupArchive()` 非空时渲染、点击只走同源 GET 与本地锚点（不发 POST/DELETE）、
  `writeupArchiveFileName()` 生成 `writeup-proj_008.zip`。真实运行：在 `runs/` 之外的
  DB 副本上启动 `serve --config`，proj_008 打包出 141 个条目、103465 字节，
  Windows `Expand-Archive` 成功解压（不只依赖自研 `readZip`），浏览器实测按钮弹出
  “已下载 …（141 个附件）”提示，未挂载工作区的项目按钮不出现。
- **Flag 置信度（M21）**：`api.flag.test.ts` 断言占位符与掩码全部被拒（`CTF2{c8xxxx}`、
  `CTF2{c8...}`、`CTF2{c8…}`、`CTF2{uuid}`、截断 UUID、`flag{partial_value}`、`flag{****}`），
  形似真值的文本保留（`flag{fragment_of_the_flag}`、`flag{deadbeefcafe1x}`、完整合成 UUID、
  `CTF2{maxi_xx_service}`）；`toolLine()`/`assistantLine()` 构造真实 JSONL 信封，新测试证明回退
  只取 `role:"toolResult"` 的正文、assistant 叙述里的 flag 形状既不采纳也不触发
  `placeholder_suspect`，两次扫描都只见掩码时候选合并去重（≤3 条、次数相加）且
  `placeholder_suspect:true`，采纳成功时候选按证据强度排名且第一名与 `flag` 一致；
  `writeup.test.ts` 覆盖 `flag_suspects` 默认空、疑似占位文案 + 判定语 + prompt 硬规则、
  `alternatives` 行与“另有 N 个候选”；`api.writeup.test.ts` 覆盖 JSON 的 `flag.alternatives` 与
  `flag_suspects` 投影，以及“未捕获 + 逐字列出原文”的草稿文案；`api.ui.test.ts` 断言四个赋值点
  都带 `candidates`/`suspect`、琥珀色「FLAG 可疑」条的文案与原文列表、绿色横幅的“另有 N 个
  候选”徽标，且可疑条不含复制按钮。真实运行：在 `runs/` 之外的 DB 副本 + 工件副本上起
  `serve --config`，proj_010 的 `/flag` 返回 8 次命中 / 5 个来源的真实值、
  `placeholder_suspect:false`，Writeup 正文与浏览器绿色横幅同源一致（原报告里的 `CTF2{c8xxxx}`
  不再出现在横幅上）；给 proj_007 注入只含 `CTF2{c8xxxx}`、`CTF2{uuid}` 的工件后，`/flag` 报
  `placeholder_suspect:true` + 两条候选，草稿写“只扫描到疑似占位或截断的 flag 文本”，浏览器
  显示琥珀色提示条并逐字列出这两个串。
- **运行配置与 Observer 默认（M22）**：`config-overrides.test.ts` 覆盖 override 键白名单
  （拒绝了 `observer`、拼错的键与未知任务 kind，错误消息带完整路径）、深合并与点路径展开、
  `defaults`/`editable` 形状一致、原地同步保持 `config.budget`/`config.verification` 引用、
  SQLite 持久化与重启重放、越界值与跨字段冲突都不改动运行中的配置、`reset()` 清空、
  坏 patch 记日志后被清除；`api.settings-runtime.test.ts` 覆盖 GET 视图、无 `--config` 时
  三方法 409、PUT 落库并返回新视图、未知键/越界/非法 JSON 400 且不写库、`{}` 等价重置、
  64 KiB 上限 413、operator token 401、跨源 403、同源 200、DELETE 恢复文件值；
  `loop.test.ts` 证明启动后 `reconfigure()` 会重挂 sweep/tick 定时器且启动前调用无副作用；
  `config.test.ts` 与 `tasks.test.ts` 断言 Observer 默认开启并注入
  `CAIRN_OBSERVER_ENABLED=1`；`api.ui.test.ts` 断言弹窗与两个页头入口存在、可编辑路径
  每个恰有一个控件、最小 patch、空数字输入不改值、409/400 行内错误、二次确认重置与写入
  期间禁止关闭。真实运行见下方里程碑表的浏览器记录。
- **提案默认与看板（M23）**：`config.test.ts` 断言 `DEFAULT_PROPOSALS` 为
  `enabled: true` + `dry_run`，且显式 YAML 仍可覆盖；`tasks.test.ts` 断言默认注入
  `CAIRN_OBSERVER_PROPOSALS_*`（含 `PROJECT_ID`/`TASK_ID`），关闭 `observer` 时只注入
  `CAIRN_OBSERVER_ENABLED=0`；`api.board.test.ts` 覆盖缺失看板 `available:false`、未知
  项目 404、想法/记忆归一化、坏条目跳过与 200 条上限（`ideas_total`/`truncated`）、
  看板目录与记忆文件的符号链接拒绝、纯 HTTP 模式；`api.ui.test.ts` 断言页签、只发 GET、
  计数文案、空看板与错误重试。
- **技能管理与浏览（M25 / M26）**：`packages/agent/src/config/skills/*.test.ts` 与
  `api.skills.test.ts` 覆盖内置播种与白名单计数、创建（立即启用 / 不启用）、非法载荷与 413、
  重名与已删除内置 409、启停与 404/400、目录名穿越拒绝、自定义删除、内置删除跨重启持久化与
  恢复语义、跨源与 operator token 守卫；M26 追加文件浏览的排序（`SKILL.md` 恒在首位）、
  逐字节正文回传、嵌套 `references/` 读取、二进制与 256 KiB 截断标记、未知技能/缺失文件 404、
  `..`/绝对路径/软链接 400、GET 免 token 与 POST 405。`agent-config-dir.test.ts` 覆盖默认目录
  与环境变量解析、拒绝根同时包含新旧两代、迁移只在目标为空时复制、跳过软链接、64 MiB 上限、
  旧目录保持不变。`api.ui.test.ts` 断言 13 个 overlay 全部是 body 直接子节点并各自有一个
  closer，以及技能详情弹窗的文件树还原（目录 + 两级深度）、首个文件自动预览、路径 URL 编码、
  二进制/截断文案、已删除技能不打开、写入期间禁止关闭与关闭后复位。真实浏览器记录见下方
  里程碑表 M26 行。
- **首屏与静态资源（M27）**：`api.ui.test.ts` 的 `static asset delivery` 组覆盖 ETag 与
  `If-None-Match` → 304、`Vary: Accept-Encoding`、gzip/br/identity 协商、`/static/` 之外与
  `%2e%2e` 越界一律 404；断言 eager 脚本只剩 `["/static/vendor/alpine.min.js",
  "/static/graph-loader.js"]`、`<script src>` 不再直连 `/static/vendor/` 里的图库、页面里
  不存在 `tailwindcss.js`/`elk.bundled.js`/内联 `tailwind.config`；把 loader 声明的 7 个 vendor
  路径逐个验证在磁盘上存在，并要求 dagre/klay/elk 三对引擎都在表里；用假
  `document`/`window`/`cytoscape` 断言 `elk_lr` 先解析成 `elk`，注入失败时不建图（`cy` 为空，
  即使 `cytoscape` 被调用也直接抛错）并给出「布局引擎加载失败」toast，`applySelectedLayout` 与
  `saveLocalSettings` 两处源码也都先 `await this.ensureGraphEngine(this.layoutEngine())`；最后一道 CSS 覆盖守卫从 `index.html`
  收集 class 令牌（`class="…"` 与 `:class="…"` 里带破折号的字面量），逐个要求在 `app.css`
  里能找到对应选择器（含 `\2c` 之类的十六进制转义还原），只豁免历史上就无效的 `bg-white/92`
  （`font-mono` 在 M28 修好了主题，已从豁免集合移除），新增遗漏即失败。
- **字号刻度（M28）**：`api.ui.test.ts` 的 `typography scale` 组断言四件事——`index.html` 不再
  出现 `text-[<数字`、`app.css` 含 `.text-2xs{font-size:.6875rem`、编译产物里最小 `font-size`
  ≥ 11px、`<style>` 内联块不含 `font-size`；另外两个用例钉住刻度定义本身（配置里
  `"2xs": ["0.6875rem", …]`）与字族刻度同时声明 `sans`/`mono` 且产物里 `.font-mono` 真的落到
  `ui-monospace`。隐藏浏览器几何 A/B（532×555，proj_008，改前用 `git show HEAD:` 的
  `index.html` + `app.css` 做真对照）：最小字号 9px→11px，小于 11px 的文字节点在列表/详情/runs/
  audit/writeup/settings 六个状态分别从 14/11/56/133/13/13 归零，其中含中文的 14/8/33/74/8/8 同样
  归零；横向溢出容器数与越出视口的元素数改前改后一致（2 与 0/5/5/6/6/6），说明放大没有新增裁切；
  控制台无报错，重新生成的 `app.css` 与入库产物逐字节相同。图内 cytoscape 标签（边 7px、节点
  10px）按例外保留，理由与测试注释一致：canvas 文字受固定节点盒限制，属于图布局而非 DOM 文字。
- **后端热点（M29）**：`db.test.ts` 的 `schema` 组对 `SELECT COUNT(*) FROM facts WHERE project_id = ?` 与
  `SELECT id, description FROM facts WHERE project_id = ?` 跑 `EXPLAIN QUERY PLAN`，断言计划含
  `facts_project` 与 `SEARCH facts`、不含 `SCAN facts`（`COUNT(*)` 实际走 covering index，故只匹配索引名）。
  `api.flag.test.ts` 新增两组：`scanSolverSessionFlags bounds` 验证目录上界（8 个带日志的会话、上限 3 →
  `scanned_files === 3` 且 `truncated`）、条目上界（12 个没有 `solver-session` 的目录、上限 5 → 一个文件都
  没读也已截断，证明**被跳过的目录也占额度**）、以及小工作区不误报截断；`collectProjectFlag cache` 验证 TTL
  （同一工件列表、删掉磁盘文件后仍在 5 s 内命中，10_000 ms 边界即过期重扫）、新工件立即失效、工作区之间
  互不串味、返回值是副本（改 `sources`/`candidates` 后再取仍是原值）。
  真实 demo 工作区（14 个项目）实测：proj_003 会话遍历 2372.9 ms → 150.0 ms；14 个项目合计
  2401.9 ms → 358.4 ms；`collectProjectFlag` 冷启合计 675.0 ms、全部命中缓存 0.3 ms。改前改后 14 个项目的
  `found` / `scanned_files` 完全一致（proj_003 的 `truncated` 由 `false` 变为如实的 `true`）。
- **按需子图（M30）**：`export.subgraph.test.ts` 用一条三段链（`origin → i001 → f001 → i002 → f002 →
  i003 → f003`）钉住六件事——focus 为 Fact 且 `depth: 1` 时只含 `origin`/`goal`/`f001` 与一入一出两个
  Intent；`depth: 3` 含第三个 Intent 但不含它的产出 Fact，`depth: 4` 才含；focus 为 Intent 时保留来源与
  产出 Fact；远端未结束 Intent 仍被作为 0 跳种子带出；`max_facts: 2` / `max_intents: 1` 时保留
  `origin`/`goal` 并置 `truncated`；未知节点抛 `HttpError(404)`。另断言 YAML 两次输出逐字相同、
  `slice:` 段字段齐全。`api.subgraph.test.ts` 覆盖默认 JSON 形状（`focus`/`counts`/`intents[].from`）、
  `format=yaml`、Intent 焦点、`around` 缺失与 `depth=0/9`、`max_facts=1`、`max_intents=0`、
  `depth=abc`、`format=xml` 的 400，未知项目与未知节点的 404，以及 POST 的 405。
  同轮跑 `export.slice.test.ts`、`export.golden.test.ts`、`api.golden.test.ts`，M4b 切片与全图 golden
  均未变化。
- **描述级 Intent 去重（M31）**：`packages/graph/src/proposals.test.ts` 覆盖三种情形——换个说法
  （全角/标点/空白差异，`dedupe_key` 也不同）的未结束 Intent 被判为 `description` 重复，不同方向返回
  `null`；显式 key 优先于描述匹配，短描述（<10 字符）与已结束 Intent 永不判重；`normalizeIntentDescription`
  的 NFKC/小写/去标点结果被逐字钉住。`apps/cairn/src/scheduler/proposals.test.ts` 用两份 `apply` 模式提案
  断言审核结果为 `duplicate` + `intent_description_open`，`applied_id` 指向已存在意图且只落一条开放 Intent；
  `loop.test.ts` 用新 fixture `reworded-reason-worker.ts` 跑两轮 reason（初始 + 人工重规划）：第二轮两条
  都被去重，`deduped > 0` 仍记为 `success`，open Intent 保持 1 条、`intent_meta` 只有一行。
- **人工 Flag 复核（M32 + M32b）**：`flag-reviews.test.ts`（12 个用例）覆盖登记/去空值/重复值单行、
  空 flag 400 与未知项目 404、同项目不同值分行、`real_more` 的 note 与 verified 汇总、`fake`
  进入 rejected、`real_done` 把其余 pending 置 dismissed 且计数正确、终态重复判定 409、
  非法判定与未知复核行、`dismissPendingFlagReviews` 的 `exceptId`、汇总五种状态与 404。
  `api.flag-review.test.ts`（15 个用例）覆盖详情与 `/flag-reviews` 的空摘要、三种判定的
  Hint 文案与状态流转、`fake` 值从 `/flag` 隐藏、扫描器同时看到真假值时已确认值优先、
  扫描器没见过的已确认值以 `source: "operator review"` 合成且 `scanned_files: 0`
  （工作区目录缺失、整个 workspace root 未配置时同样可见）、`real_done` 用该 Fact 完成
  并以 `worker: "operator"` 落库、无 Fact 时 409 且项目保持 active、项目已结束时
  `real_done` 只记录判定（不新增完成 Intent，无 Fact 也不报错）、结束后的判定不追加
  Hint、404/400/409 校验与操作员 token 401/200。`scheduler/flag-review.test.ts`
  （4 个用例）用 `flag-worker.ts` fixture 跑完整调度：抓到 flag 后登记 pending 但继续
  派发直至项目自行完成（日志无 pending 暂停/推迟）、重复值只有一行；`fake` 判定后
  同值保持已判定、项目完成且计数为 1；`real_more` 判定后项目照常完成；`flag_review:
  "off"` 时直接完成、无复核行、计数全零。golden 只给两条 `GET /projects/{id}` 响应补了
  空的 `flag_reviews` 摘要，其余逐字不变。浏览器在临时 DB 的 8031 端口验证了进行中与
  已完成两种项目的复核条文案、Toast 与状态流转，控制台无消息。

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
| M15f ✅ | Phase 4 收尾：Phase 0 对照副本移除的现状说明、UI 常驻“无身份认证”提示与非回环绑定警告、`docs/CONTRACT.md` 汇总 task/result/usage/audit 契约与退出码 | 545 passed / 62 files（2026-10-27） |
| M16a ✅ | CI 门槛与真实模型 A/B 工具：GitHub Actions 执行 install/typecheck/test，`bun run check` 本地复现；`tools/gate/m16-model-ab.ts` 双 arm 独立数据库/工作区、同 marker、单 profile，强制两个不同 model-prefs 且两侧 run.model 不重叠 | 548 passed / 63 files（2026-10-27）；Linux 容器同门槛通过；真实 A/B 见 M16b |
| M16b ✅ | 第二个真实模型接入与首次真实 A/B：用 M18a/M18b 的 `/settings/agent` 路由在同网关另一协议路径注册 `gw-zhipu` + `zhipu-glm-flash`（`GLM-5.3-Flash`，复用既有密钥、默认 worker 不变，真实 provider 名与主机名不入库），先跑连通性测试再跑 gate；无新增产品代码，步骤与结果记入 `docs/MODELS.md` 第 7 节 | 655 passed / 69 files（2026-10-28）；gate `passed: true`、12 检查 0 失败，arm A 74,227 Token / 29.5 s 对 arm B 75,141 Token / 150.9 s，两侧模型集合不重叠 |
| M17a ✅ | 前端 P0：新建项目强制授权范围并随 `scope` 提交；`GET/PUT /projects/{id}/scope`；`GET /projects` 增加 `has_scope`；列表“未授权”徽章与详情范围卡片支持补配/修改 | 556 passed / 64 files（2026-10-27）；浏览器实测创建、编辑与补配 |
| M17b ✅ | 列表与轮询：搜索标题/ID/状态、可点击状态筛选、三种排序与 `localStorage` 记忆；页面隐藏暂停轮询、可见即刷新、失败 5s→60s 退避；列表/项目错误横幅与重试、最后更新时间；侧栏页签横向滚动并按项目记忆 | 558 passed / 64 files（2026-10-27）；浏览器实测筛选、错误横幅与页签恢复 |
| M17c ✅ | 表单与弹窗一致性：13 个 overlay 共用模态栈（Esc 关最上层、Tab 焦点陷阱、关闭回焦、显示后重试 autofocus）；新建/范围/重命名/设置逐字段行内校验并聚焦首个错误；写操作提交期间禁用并显示进度；停止单个与“停止全部”改为二次确认 | 578 passed / 64 files（2026-10-28）；浏览器实测 Esc/Tab/回焦、校验、确认与背景取消 |
| M17d ✅ | 详情/图交互一致性：项目卡片键盘可达（Tab + Enter/Space，内部按钮不冒泡）；进入项目聚焦图标题、返回列表回焦来源卡片（缺失回落搜索框）；返回按钮补可访问名称；图视图 Esc 清除选择、多选面板“已选 N 个事实/清空选择”；图页头删除统一走 `deleteProjectById` | 582 passed / 64 files（2026-10-28）；浏览器实测 Enter/Space 打开、标题/卡片回焦、Esc 与清空按钮、弹窗内 Esc 不清选择 |
| M18a ✅ | 模型与密钥管理 API：`GET /settings/agent` 汇总 provider/模型（密钥与请求头只回掩码/名称）；provider 与模型的增删改、默认模型设置（复制为 `cairn-worker`）、内置目录与远端 `/models` 发现、单模型连通性测试；删除被引用条目 409（`?force=true` 放行）；写请求要求 operator token 且拒绝跨源；测试/发现错误输出脱敏 | 592 passed / 65 files（2026-10-28）；入口弹窗与拉取模型列表 UI 列入 M18b |
| M18b ✅ | 模型与密钥管理 UI：页头入口与弹窗栈集成（14 overlay）；Provider/模型页签、密钥只写、请求头逐行解析、协议/Base URL、拉取或手工录入模型、thinkingLevel/reasoning/输入模态/成本/上下文/最大 Token、默认标记与引用方、设为默认、测试、行内删除确认与 409 强制删除；内置 provider 继承协议与 Base URL，无密钥测试给可读提示 | 604 passed / 65 files（2026-10-28）；浏览器实测完整 CRUD/拉取/默认/测试/强制删除流程 |
| M18c ✅ | 模型管理收尾：`docs/MODELS.md` 一页操作手册（五步接入、HTTP 速查、文件落点、错误排查、临时目录演练、M16b 真实 A/B 步骤）；端到端流程测试覆盖空目录 → provider/密钥 → 模型 → 默认 → 文件落点 → 强制删除，并断言全程响应无密钥/header 值 | 605 passed / 66 files（2026-10-28）；该入口在 M16b 被用来接入第二模型 |
| M18d ✅ | 连通性测试可用化：Provider 卡片“测试连通性”，优先测试该 provider 的 `cairn-worker` 条目并回显实际模型；无模型条目给可读提示；服务端 60 秒上限（`agentTestTimeoutMs` 可调）与超时文案；`Bun.serve` 空闲超时 120 秒，避免默认 10 秒先中断 | 609 passed / 66 files（2026-10-28） |
| M18e ✅ | 前端 Flag 展示：只读 `GET /projects/{id}/flag` 从已索引 artifacts 提取 Flag（过滤占位符、二进制、超大文件与越界路径，限制文件数/字节数/行长度），项目页头绿色横幅显示值、来源与复制按钮，轮询找到后停止重复扫描 | 619 passed / 67 files（2026-10-28）；浏览器实测 proj_008 显示、proj_007 不显示 |
| M18f ✅ | challenge/Flag 自动校验：`TCH_CHALLENGE_ID` 存在时新建项目自动选择 challenge 策略（显式请求体优先），新建弹窗提供校验选择与题目编号校验，`/flag` 附带 `verification` 快照并在横幅显示通过计数/失败原因，未通过时继续轮询 | 624 passed / 67 files（2026-10-28） |
| M18g ✅ | Flag 原文展示：prompt 改为要求把真实 flag 原样写入 Fact 描述与证据（凭据/token 仍禁止），`/flag` 拒绝 `[REDACTED]`/`masked`/`[hidden]` 等占位符，证据只剩占位符时只读回退扫描 solver-session JSONL（限文件数/字节数、跳过二进制）恢复真实值 | 631 passed / 67 files（2026-10-28）；浏览器实测 proj_008 显示真实 flag |
| M19a ✅ | 中文 Writeup：`buildProjectWriteup` 从图数据确定性渲染中文 Markdown 草稿（结论/目标/攻击路径/当前事实/取代/Hint/Flag 与校验/统计/证据附录），`GET\|POST\|DELETE /projects/{id}/writeup` 读取草稿、用 `completeText` 生成并存储模型撰写版（`project_writeups`）、清除回草稿；prompt 与正文限长、90 秒超时、写操作受 operator token 与同源约束、失败不覆盖旧正文；侧栏「Writeup」页签支持复制/下载/AI 撰写/恢复草稿 | 655 passed / 69 files（2026-10-28） |
| M19b ✅ | Writeup 面板显示修正：标题行/摘要/操作条改为三段纵向布局（操作条自身 `flex-wrap`），不再与标题争宽度导致窄侧栏里竖排字符；`Markdown` 链接改为 `下载 Markdown` 按钮，下载走 `?format=markdown` 并固定文件名 `writeup-<项目id>.md`（非法字符替换为 `_`），正文卡片头部改列显示来源与规模 | 655 passed / 69 files（2026-10-28）；浏览器实测下载锚点与文件名、模型撰写版显示 |
| M20a ✅ | Writeup 写明载荷：`isWriteupPayloadPath` 用扩展名/关键字从工件索引确定性选出脚本、投递容器与 payload，`## 载荷（Payload）` 章节逐字内联文本（自动加长围栏、截断标注）、二进制只登记路径、读不到写“内容未读取”；超过 20 条时 `selectWriteupPayloadArtifacts` 让被 `evidence_refs` 引用的载荷排在截断之前，快照带 `payloads_total`；每条载荷带 `referenced_by`（哪条 Fact 引用），HTTP 层 `collectWriteupPayloads` 复用 Flag 的路径收敛与限额（只读选中的 ≤20 条、单文件 128 KiB、总计 24000 字符）；prompt 增加“载荷照抄、未内联不得虚构”，侧栏摘要显示“载荷 N 个（内联 K）” | 670 passed / 70 files（2026-10-28） |
| M20b ✅ | Writeup 附件包下载：`GET /projects/{id}/writeup/archive`（只读）用自研最小 ZIP 写入器（`zip.ts`：store/deflate 取小者、CRC-32、单一中央目录、固定 DOS 时间戳 → 字节确定）把 `writeup.md`（模型成稿优先）、中文 `MANIFEST.md`（项目/来源/Flag/载荷统计/目录结构/`文件与校验`表/`未打包文件`表）与**全部**已索引工件 `artifacts/<任务>/<文件>` 打成 `writeup-<id>.zip`；上限 500 条目 / 单文件 4 MiB / 总量 64 MiB（无 zip64），跳过项在清单里给中文原因；读取沿用 Flag 的路径收敛（真实目录、非符号链接、不逃逸）；JSON 增 `archive:{available,files}`，UI「附件包 N」按钮据此显示并走同源 GET，未挂载工作区 409 | 692 passed / 72 files（2026-10-28）；浏览器实测下载与 `Expand-Archive` 解压 141 个附件 |
| M21 ✅ | Flag 扫描置信度：solver-session 回退改为只解析 `role:"toolResult"` 的消息正文（`sessionToolText`），模型自己的 assistant 叙述不再是证据——它在叙述里写下的 `CTF2{c8xxxx}` 曾按出现次数压过工具返回的真实值；`isPlaceholder` 增加掩码判定（`...`/`…`/`**`/`x{3,}` 连写与 `uuid`/`guid`/`frag`/`partial`/`truncat*`/`sample`/`dummy`/`tbd`/`unknown`/`missing` 词段匹配，`fragment_of_the_flag` 与 base64 里的 `xx` 不误杀）；被拒文本不静默丢弃：`/flag` 新增 `candidates`（≤3 条，带 `occurrences`/`sources`/`placeholder`，artifacts 与会话两路合并去重、次数相加）与 `placeholder_suspect`；Writeup 草稿的 `flag_suspects` 逐字列出它们并写“只扫描到疑似占位或截断的 flag 文本”，判定语与撰写 prompt 同步禁止把占位串当答案或拼一个看似完整的 Flag；UI 在未采纳任何值时显示琥珀色「FLAG 可疑」条（列出原文、不给复制按钮），命中时绿色横幅加“另有 N 个候选”徽标 | 703 passed / 72 files（2026-10-29）；`bun run typecheck` 通过；浏览器实测 proj_010 绿色横幅为真实 Flag、注入掩码的 proj_007 显示琥珀色可疑条 |
| M22 ✅ | Observer 默认开启（只读复盘、提案仍默认关闭）+ 运行配置前端可调：`RuntimeConfigStore` 把 snake_case patch 存入 SQLite `runtime_config_overrides`，深合并到 dispatch.yaml 解析前文档并复用 `parseDispatchConfig` 校验，成功后原地同步共享 `DispatchConfig`；新增 `GET/PUT/DELETE /settings/runtime`（operator token、同源、64 KiB、无 `--config` 409）；`Scheduler.reconfigure()` 重挂 tick/sweep 定时器，`evidence_enforcement` 改为 getter 热读；页头「运行配置」弹窗按七组渲染数字/开关/下拉/多选，标出覆盖项、只提交与文件基线的差异、二次确认恢复；新增 `docs/CONFIG.md` | 732 passed / 74 files（2026-10-29）；浏览器实测：临时 DB+配置起 `serve --port 8019`，把调度间隔 2→5 保存后 `GET` 返回 `overrides:["runtime.interval"]`、SQLite 落 `{"runtime":{"interval":5}}`，刷新页面后值与「已覆盖 1 项」仍在；把单项目 worker 数改成 9 被 400 行内拒绝（`runtime.max_project_workers cannot exceed runtime.max_workers`）且服务端仍是 1；两次点击恢复后回到 2 且覆盖清空 |
| M23 ✅ | 提案默认演练开启 + 看板只读页签：`DEFAULT_PROPOSALS` 改为 `enabled: true` + `mode: dry_run`（审核照常、只记录不写图）；新增 `http/project-board.ts` 与只读 `GET /projects/{id}/board`，读取 `.cairn/board/board/` 的想法索引与记忆条目，拒绝符号链接/越界/非普通文件，限制条目与文本上限并返回 `ideas_total`/`memory_total`/`truncated`，缺失看板返回 `available:false`；UI 在「提案」与「成本」之间新增「看板」页签，按状态/类型着色展示并支持刷新与错误重试 | 740 passed / 75 files（2026-10-29）；`bun run typecheck` 通过；浏览器实测临时 DB+配置起 `serve --port 8020`，预置 3 条想法/3 条记忆的项目显示计数与徽标、`GET /projects/proj_001/board` 200，无看板项目显示“暂无看板数据”，控制台无脚本错误 |
| M24 ✅ | 在线切换执行模式 + 统一设置入口：`runtime.execution` 进入运行期覆盖白名单，`RuntimeConfigStore` 新增 `validateNext` 钩子（拒绝调度器有任务在跑/正在切换/本机无 Docker），`Scheduler.reconfigure()` 模式变化时等 `running` 清空再重建 runtime 后端并重新解析工作区根；dispatch.yaml 缺 `container:` 段时只在校验前补镜像/网络/收尾默认值、不落覆盖 patch；进入容器前播种内置 prompts/skills；API `workspaceRoot` 改为 getter 供工件/证据/Flag/Writeup 路由热读；前端把运行配置、模型与密钥、本地偏好、服务端设置四个弹窗合并为一个四页签「设置」弹窗（页头单齿轮按钮、按需加载、写请求中禁止关闭），`document.title` 随项目变为「项目名 · Cairn」 | 748 passed / 75 files（2026-10-30）；`bun run typecheck` 通过；浏览器实测临时 DB+起 `serve --port 8021`：四个页签各自加载（agent 页签列出 provider、server 页签显示超时输入、local 页签显示操作者/布局），执行模式 local→container 保存后 `overrides:["runtime.execution"]` 且日志出现 `runtime switched to container`，切回 local 后覆盖清空；Esc 经 `dismissModal('settings')` 关闭；打开 proj_002 标题为「Browser Check · Cairn」，返回列表为「Cairn」 |
| M24b ✅ | 执行环境有效性测试：新增 `runtime/probe.ts` 与 `POST /settings/runtime/test`，按请求选择的 `execution` 探测——`local` 检查 Bun 版本与工作区临时文件写入；`container` 检查 Docker 守护进程、镜像是否存在（缺省 `cairn-worker:latest`）并用 `docker run --rm --network none <image> bun --version` 试启动，缺镜像时给出 `docker build` 命令；逐项返回 `{id,label,ok,detail}` 且不修改配置；路由沿用 operator token/同源守卫，无 `--config` 409、非法模式 400；执行模式下拉旁新增「测试有效性」按钮与内联 ✓/✗ 结果，切换模式清空旧结果 | 761 passed / 76 files（2026-10-30）；`bun run typecheck` 通过；浏览器实测临时 DB 起 `serve --port 8022`：local 返回 Bun 1.4.4 + 工作区可写，container 返回 Docker 29.9.2、镜像 `cairn-worker:latest`（sha256:f4f3df…）、试启动 Bun 1.4.4、工作区可写，弹窗逐项渲染且 toast「执行环境测试通过」，控制台无脚本错误 |
| M25 ✅ | 技能管理：config 层新增 `createSkill` / `removeSkill` / `restoreBuiltinSkill` 与 `<configDir>/skills/.deleted-builtins.json`，控制面新增 `agent-skills.ts` 挂载 `GET/POST /settings/agent/skills`、`PUT .../{name}/enabled`、`POST .../{name}/restore` 与 `DELETE .../{name}`，写路由沿用 operator token/同源守卫；技能生效以 `cairn-worker` prompt 的 `meta.skills` 白名单为准，新增默认启用、删除同时移出；内置 17 个，GET 幂等播种并跳过已删除；内置删除跨重启持久，恢复只回填文件不自动启用；新增名 slug 校验（≤64）且须等于目录名，删除/启停做路径安全校验；UI 新增五页签中的「技能」页签，行内启停/删除确认/恢复与新增表单 | 777 passed / 77 files（2026-10-30）；`bun run typecheck` 通过；浏览器实测临时 DB + 独立 agent 配置目录起 `serve --port 8023`：页签显示「17 个技能 · 12 个已启用 · 已写入 cairn-worker prompt」，新增 `m25-browser-skill` 后 SKILL.md 落盘、白名单从 12 增至 13；启用 `ad-pentest` 后 13→14，删除后该行转为「已删除」、启用数回到 13，`skills/.deleted-builtins.json` 记录目录名；重启服务后仍为已删除且未回填，恢复后文件回填但不自动启用；删除自定义技能后回到 17 个技能/12 个已启用；控制台无脚本错误 |
| M26 ✅ | 技能统一浏览 + 配置目录改名：`agent-config.ts` 新增只读 `GET /settings/agent/skills/{name}/files` 与 `GET .../file?path=`（`SKILL.md` 恒在首位、POSIX 相对路径、≤200 文件/深度 8/单文件 256 KiB 前缀，NUL 判二进制，逐段拒绝空/`.`/`..`/超长/保留字符，词法与 realpath 双重收敛、拒绝符号链接），GET 沿用免 token 的只读语义、同路径 POST 405；运行配置目录默认改为 `~/.cairnweave/config`（`agent-config-dir.ts` 统一解析：`CAIRN_AGENT_CONFIG_DIR` 覆盖 → 新默认），控制面在播种前一次性把旧 `~/.tch-agent/config` 复制过去——只在目标为空时执行、跳过符号链接、总量 64 MiB、绝不覆盖也绝不删除旧目录，日志给出复制数与“legacy directory is unchanged”；内置 skills 的 `SKILL.md` 全部中文化（正文与 `description`，命令/路径/YAML 键保持原样）；UI 技能行新增「预览」，第 13 个弹窗左侧是文件树（目录 + 大小），右侧正文 `<pre>` 逐字预览并标注二进制/截断，打开即预览首个文件，头部可直接启停并即时刷新徽标，写入期间禁止关闭、关闭复位，`line-clamp-2` 收纳多行描述 | 796 passed / 78 files（2026-10-30）；`bun run check`（tsc + 全量）通过；浏览器实测独立 `HOME`/`USERPROFILE` + 临时 DB 起 `serve --port 8026`：启动日志 `copied 4 agent config file(s) from …\\.tch-agent\\config to …\\.cairnweave\\config`，新目录拿到迁移后的 4 个配置文件与完整 `skills/`；`ad-pentest` 预览树为 9 文件 + 1 目录、`SKILL.md` 15.2 KiB 正文 11518 字符自动载入，点选 `references/04-adcs.md` 显示 10.7 KiB / 8997 字符；头部启停后 `enabledCount` 13→14、prompt 白名单同步 14 且列表行状态一致，再点回 13；`modalOrder` 由 `["settings","skillDetail"]` 在关闭后回到 `["settings"]` 且 `skillDetail.directory` 复位为空；`GET .../file?path=../../models.json` 400、缺失文件 404、同路径 POST 405。应用内浏览器页面处于隐藏态（`visibilityState=hidden`、`requestAnimationFrame` 挂起），截图与真实焦点落点无法在页内验证，改由 `api.ui.test.ts` 的假元素 `syncModal('skillDetail', …)` 断言自动聚焦关闭按钮与关闭后回焦技能行 |
| M26b ✅ | 项目名统一为 Cairnweave：仓库目录 `cairn-merged` → `cairnweave`，根 `package.json` 的 `name` 与 `bun.lock` 随之更新（顺带同步了 lock 里 `@cairn/app` 长期滞留的 `0.3.0-m3`），版本 `0.46.0-m26b`；README 标题/首段/目录树说明与 `docs/ARCHITECTURE.md`、`docs/CONFIG.md` 里引用 UI 品牌的句子都改成 Cairnweave，并新增一条「名称约定」说明为何 `CAIRN_*` 环境变量、工作区 `.cairn/` 目录、`cairn-worker` prompt、`@cairn/*` 包名与 `cairn` 命令保持不变（Python golden 对照与既有项目数据依赖这些协议名）；前端 `<title>`、页头品牌字与 `documentTitle()` 改为「Cairnweave」/「项目名 · Cairnweave」，测试同步断言这两处标记与三种标题取值 | 796 passed / 78 files（2026-10-30）；`bun run check`（tsc + 全量）在改名后的目录里通过；`bun run cairn version` 输出 `cairn 0.46.0-m26b`；浏览器实测独立 `HOME` + 临时 DB 起 `serve --port 8027`：列表页 `document.title` 与页头品牌均为「Cairnweave」，打开 proj_001（标题 brand-check）后为「brand-check · Cairnweave」，返回列表回到「Cairnweave」；`GET /` 返回的 HTML 含 `<title>Cairnweave</title>`；实验环境 `runs/demo/dispatch.yaml` 的两处 `workspace_root` 已指向新目录，`start-lab.bat` 用 `%~dp0` 相对定位无需改动；历史 `task.json` 与 `audit_events` 里记录的旧绝对路径按运行留痕保留不改 |
| M27 ✅ | 前端首屏体积与静态资源缓存：Tailwind Play CDN（vendored `tailwindcss.js`，451 KB 在浏览器里对着 class 名单现算样式）换成 Tailwind CLI 预编译入库的 `static/app.css`（`tools/ui/input.css` + `tools/ui/tailwind.config.mjs` 逐字复刻原内联 theme，`bun run ui:css` 生成 33 KB / br 6 KB，CI 再生成一次并 `git diff --exit-code`；`font-mono` 与 `bg-white/92` 两处历史上就无效的 class 由覆盖守卫显式豁免）；cytoscape 核心与 dagre/klay/elk 三对布局引擎改由 `static/graph-loader.js` 在 `initGraph`、切换布局、保存偏好三条路径上按需串行注入（扩展文件加载时自行 `register(cytoscape)`，所以核心必须在前），默认 dagre 不再下载 klay 的 496 KB 与 elk 的 1.6 MB，注入失败给中文 toast 且不建图；新增 `http/static-assets.ts` 接管 `GET /` 与 `/static/*`：size+mtime 生成 ETag，配 `Cache-Control: no-cache` 与 `Vary: Accept-Encoding`，`If-None-Match` 命中回 304，可压缩类型在内存里缓存 gzip/br 变体（≤64 文件、br quality 5、gzip 6），目录外与越界一律 404；`api.ts` 删除旧的 `serveStatic` | 803 passed / 78 files（2026-10-30）；`bun run check`（tsc + 全量）通过；浏览器实测独立 DB 起 `serve --port 8028`：列表页首屏传输 96,040 B（`index.html` 72,944 + `app.css` 5,972 + alpine 16,268 + `graph-loader.js` 663 + favicon 193，全部 br），同一路径优化前未压缩为 3,816,974 B；首屏 `window.tailwind` 为 `false`、未打开项目时 `typeof cytoscape === "undefined"`；点开项目才补 `cytoscape.min.js` 127,976 + `dagre.min.js` 61,331 + `cytoscape-dagre.js` 3,859（br），3 个 canvas 正常渲染、无 toast；切 `elk_lr` 才拉 `elk.bundled.js` + `cytoscape-elk.js`（`window.ELK` 就位）、切 `klay_lr` 才拉 `klay.js` + `cytoscape-klay.js`，切回 dagre 不再发请求；刷新后 alpine/graph-loader/favicon 回 304，`curl` 逐个带 `If-None-Match` 对 `app.css`/`graph-loader.js`/alpine/cytoscape/dagre 全部 304；控制台无消息 |
| M28 ✅ | 前端字号刻度与可读性下限：`tools/ui/tailwind.config.mjs` 新增 `theme.extend.fontSize["2xs"] = ["0.6875rem", {lineHeight:"1.3"}]`（11px，中文可读下限）并补上 `fontFamily.mono`——顶层 `theme.fontFamily` 替换整条字族刻度，旧配置只列 `sans`，因此 `.font-mono` 编译不出规则、94 处调用点静默回退正文字体；`index.html` 的 472 处 `text-[9px]/[10px]/[11px]` 全部换成 `text-2xs`，3 处 `text-[12px]` 归 `text-xs`，两处 15px 标题归 `text-base`，`text-xs`/`text-sm` 不动以保持紧凑仪表盘密度，内联 `<style>` 不含 `font-size`；`api.ui.test.ts` 的 CSS 覆盖守卫豁免从 `font-mono` + `bg-white/92` 收到只剩 `bg-white/92`，并新增 `typography scale` 三个用例（markup 无 `text-[<数字`、产物最小 `font-size` ≥ 11px 且含 `.text-2xs`、配置同列 `sans`/`mono` 且产物 `.font-mono` 落到 `ui-monospace`）；cytoscape canvas 标签（边 7px / 节点 10px）按例外保留 | 806 passed / 78 files（2026-10-30）；`bun run check`（tsc + 全量）通过；重新生成产物 33,112 B（br 6,420 B）与入库文件逐字节相同；隐藏浏览器 532×555 几何 A/B 用 `git show HEAD:` 的 `index.html` + `app.css` 做真对照，六个状态（列表/详情/runs/audit/writeup/settings）最小字号 9px→11px、小于 11px 的节点 14/11/56/133/13/13 全部归零、含中文的小字 14/8/33/74/8/8 全部归零，而横向溢出容器（2）与越出视口元素（0/5/5/6/6/6）改前改后一致，`.font-mono` 实测族名以 `ui-monospace` 开头，控制台无消息。曾试给图标题 `h2` 加 `min-w-0`/`flex-1` 让 `truncate` 生效，实测在 532px 下会把项目名压到 0 宽（标题消失比原有溢出更糟）故回退，窄窗口排布留给后续响应式一轮 |
| M29 ✅ | 后端热点两处：`packages/graph/src/db.ts` 为 `facts(project_id)` 增加 `facts_project` 索引——主键是 `(id, project_id)`，项目列表的 `fact_count` 子查询与 `GET /projects/{id}` 的按项目读 Fact 只能整表扫描，`EXPLAIN QUERY PLAN` 由 `SCAN facts` 变为 `SEARCH facts USING (COVERING) INDEX facts_project`；`/flag` 的会话兜底改为有界遍历：`readdirSync` 不再取 `withFileTypes`（Windows 上等于先给每个条目做一次 lstat），逐项用 `lstatSync(..., { throwIfNoEntry: false })`，新增 `SESSION_MAX_DIRECTORIES = 1000` 与 `SESSION_MAX_ENTRIES = 4000`（被跳过的目录/缺失的 `solver-session`/非 jsonl 文件都占额度），撞界即 `truncated: true`；`collectProjectFlag` 外包 10 s / 32 项的工作区级缓存，指纹为工件 `path + size`（新增或改大小立即失效，同名同大小改写等 TTL），返回副本并提供 `clearFlagCache()` | 814 passed / 78 files（2026-10-30）；`bun run check`（tsc + 全量）通过；`db.test.ts` 钉住两条查询计划的索引使用（含 `COUNT(*)` 的 covering 变体）；`api.flag.test.ts` 新增 `scanSolverSessionFlags bounds`（目录上界、条目上界、小工作区不误报）与 `collectProjectFlag cache`（TTL 边界 10_000 ms、新工件立即失效、工作区隔离、返回值副本）共 7 个用例；demo 工作区实测 proj_003 会话遍历 2372.9 ms → 150.0 ms、14 个项目合计 2401.9 ms → 358.4 ms、`collectProjectFlag` 冷启 675.0 ms 而全命中 0.3 ms，14 个项目的 `found`/`scanned_files` 改前改后一致（仅 proj_003 由 `truncated:false` 变为如实的 `true`）；索引在 12 项目 / 43 Fact 的 demo 上量不出耗时差异，按复杂度修正记录 |
| M30 ✅ | 按需子图 API：`packages/graph/src/export.ts` 新增 `selectSubgraph`（`around` 兼容 Fact / Intent，Fact↔Intent 因果边 BFS，`depth` 默认 2、上限 4）、`exportProjectSubgraphYaml` 与 HTTP 只读 `GET /projects/{id}/subgraph`（`around`/`depth`/`max_facts`/`max_intents`/`format=json\|yaml`）；未结束 Intent 作为 0 跳种子保证并行方向可见，裁剪优先级为 `origin`/`goal` → focus → 已选 Intent 来源 → 跳数，被裁即 `truncated`；`max_facts` 最小 2（项目头需要 origin/goal），越界参数 400 而非静默夹取，未知节点 404 | 827 passed / 80 files（2026-10-31）；`bun run check`（tsc + 全量）通过；`export.subgraph.test.ts` 覆盖 focus fact/intent、depth 1→4 的边界（深度外的 Intent 产出 Fact 不被排序拉回）、未结束 Intent 种子、caps 与 truncated、未知节点 404、YAML 确定性与 `slice:` 段；`api.subgraph.test.ts` 覆盖默认 JSON 形状、`format=yaml`、Intent 焦点、缺失/非法参数 400、未知项目/节点 404 与 POST 405；M4b 切片、全图导出与 golden 逐字节不变 |
| M31 ✅ | 描述级 Intent 去重：`packages/graph/src/proposals.ts` 新增 `findDuplicateOpenIntent`（未结束 Intent 先按非空 `dedupe_key` 精确匹配，再比较描述：NFKC + 小写 + 去空白/标点归一化、≥10 字符、长度比 ≥0.75、字符二元组 Jaccard ≥ 0.9）与 `normalizeIntentDescription`；reason 的 intents 分支与 Observer 提案审查都改用它，命中时 reason 跳过该条并计入 `deduped`（整轮仍算成功），提案返回 `duplicate` + `intent_description_open` 并指向已存在的意图；不带 `dedupe_key` 的 reason 意图也能被描述去重，已结束方向可重新提出；不新增列、不落库 | 832 passed / 80 files（2026-10-31）；`bun run check`（tsc + 全量）通过；`packages/graph/src/proposals.test.ts` 覆盖换说法（全角/标点/空白）判重、不同方向不判重、显式 key 优先、短描述与已结束 Intent 不判重、归一化输出；`proposals.test.ts`（scheduler）断言 `intent_description_open` 与只落一条开放 Intent；`loop.test.ts` 用 `reworded-reason-worker.ts` 验证首轮与重规划两轮去重后 open Intent 仍为 1、`intent_meta` 只有一行 |
| M32 ✅ | 人工 Flag 复核：新增共享分类器 `apps/cairn/src/flags.ts`（前缀 `flag`/`*flag`/含 `ctf`，拒绝掩码与占位符），scheduler 在 explore/conclude Fact 描述、bootstrap Fact 与完成描述、reason 完成描述里识别 flag 值，按 `UNIQUE(project_id, flag)` 落 `flag_reviews` 并暂停项目——`tryDispatch` 不派发任何任务（含 conclude 打捞），reason 完成声明推迟并释放租约；操作员三选一：`real_more`（verified + 去重 Hint，继续探索）、`real_done`（verified、其余 pending 置 dismissed、用关联 Fact 直接完成，无 Fact 409）、`fake`（rejected + 去重 Hint，继续探索且同值不再入队）；判定终态（重复 409）、路由沿用操作员凭据；`/flag` 与 Writeup 扫描过滤 rejected、已确认值置顶并可见 `source: "operator review"`，`GET /projects/{id}` 附带 `flag_reviews` 摘要，UI 页头新增琥珀色复核条与三枚按钮；配置 `verification.flag_review` 默认 `manual`、`off` 关闭 | 860 passed / 83 files（2026-10-31）；`bun run check`（tsc + 全量）通过；`flag-reviews.test.ts` 覆盖单行去重、三种判定与终态、sibling dismissal、汇总与 404；`api.flag-review.test.ts` 覆盖三种判定的 Hint/完成、展示过滤与 `operator review` 合成（含工作区目录缺失与 workspace root 未配置两种情况）、409/400/404 与 token 401/200；`scheduler/flag-review.test.ts` 用 `flag-worker.ts` 覆盖暂停、`fake` 恢复、`real_done` 完成与 `off` 直通；golden 仅在两条 GET 详情响应补空摘要，图导出与任务契约不变；浏览器实测临时 DB 起 `serve --port 8030`：proj_001 显示琥珀色「FLAG 复核」条与三个按钮，判 `real_more` 后 POST 200、横幅消失、绿色 Flag 条显示 `来自 operator review` 且提示数 +1；proj_002 判 `fake` 后横幅消失、`/flag` 不再返回该值并写反向 Hint；proj_003 两条 pending 点「真 · 停止」后项目 completed、sibling 记 dismissed、绿色条显示已确认值，控制台无消息。应用内浏览器处于隐藏态（`visibilityState=hidden`），原生坐标点击不触发事件，改用页面内 DOM `.click()` 触发同一 Alpine 处理函数 |
| M32b ✅ | Flag 复核改为后台进行：删掉 `tryDispatch` 的 pending 门禁与 reason / bootstrap 完成声明的推迟，`reviewCapturedFlags` 只登记复核不返回阻塞；项目带着未判定复核继续派发并可直接完成。判定路由对已结束项目改为只记录结果：`real_done` 不再调用 `completeProject`（active 且无 Fact 才 409），`real_more` / `fake` 仅在 active 时追加 Hint；UI 复核条文案改为“项目继续运行”，Toast 对已结束项目注明“仅记录判定”；调度器测试改写为“抓取后继续派发至自行完成”，HTTP 新增已完成项目的 `real_done`、无 Fact 容忍与不追加 Hint 用例 | 863 passed / 83 files（2026-10-31）；`bun run check`（tsc + 全量）通过；`scheduler/flag-review.test.ts` 断言 pending 期间 run 数继续增长、项目自行 completed、同值仅一行、日志无 pending 暂停/推迟，`fake` / `real_more` 判定后项目照常完成；`api.flag-review.test.ts` 新增已完成项目 `real_done` 只记录判定（完成 Intent 仍为 1 条且 worker 为 `cairn-worker`）、无 Fact 也返回 200、`fake` 不追加 Hint；浏览器实测临时 DB 起 `serve --port 8031`：进行中项目的复核条显示“检测到以下 Flag，项目继续运行。请判断：”，判「假 · 继续探索」后 Toast 为“已标记为假 Flag，继续探索”、横幅保留真值且假值从展示中消失，判「真 · 停止」后项目 completed、横幅消失、Toast 为“已确认 Flag 并停止项目”；已完成项目仍显示复核条，判「真 · 停止」后状态保持 completed、完成意图仍为 1 条、横幅消失、Toast 为“已确认为真 Flag（项目已结束，仅记录判定）”，控制台无消息 |

## 与 Phase 0 的关系

Phase 0 的 `tch` driver、`tch_bridge.py`、`solver rpc` 适配与 overlay 文本补丁已随合并完成
移除，本仓库不保留对照副本；模块对应关系与删除清单见 `docs/PORTING.md` 和
`docs/ARCHITECTURE.md` 第 11 节。Phase 0 的价值是验证了 BreachWeave Solver 能被 Cairn 的
任务契约驱动；它的成本是每次任务多一次进程、多一层 JSONL 转译——这两点在本项目中消失。
