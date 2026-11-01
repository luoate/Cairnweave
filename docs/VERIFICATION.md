# 完成验证（M14a + M18f + M32 + M32b + M40 + M41）

M14a 把“项目完成”从模型自证改为控制面可验证。worker 返回的 `complete` 只是声明；
scheduler 在关项目之前运行 oracle，并把每次判定写入旁路表。验证失败不会丢工作：
reason 释放租约、项目保持 active；bootstrap 保留已产出的 Fact，只推迟完成。

## 1. 策略

完成策略是项目级旁路数据：M41 起由有序目标条件列表（`project_goal_conditions`）
表达，`project_verification` 保留为兼容别名。两者都不进入 Cairn 图、YAML 导出或
`GET /projects/{id}` 的图响应。创建项目时可指定条件列表：

```json
{
  "title": "...",
  "origin": "...",
  "goal": "...",
  "scope": {"targets": ["10.0.0.5"]},
  "goal_conditions": [
    {"kind": "challenge", "challenge_code": "web-01"},
    {"kind": "flag_count", "min": 2},
    {"kind": "evidence"}
  ]
}
```

oracle 按 `ordinal` 升序（即请求顺序）求值，所有条件通过才完成（AND）：

| kind | 语义 |
| --- | --- |
| `evidence`（默认单条件） | 完成声明引用的每个非种子 Fact 必须有 `run_id`、`evidence_status=provided` 且至少一条 `fact_evidence` |
| `challenge` | 读取外部挑战 API 的 `flag_got_count` / `flag_count`；两者严格相等才通过 |
| `flag_count` | 操作员已确认的 Flag 数加上 challenge 条件已确认的 `flag_got_count`，达到 `min` 即通过 |
| （空列表） | 等价于 `off`：显式关闭自动验证，用于导入项目或只关心图推进的场景 |

- 列表最多 8 条（`MAX_PROJECT_GOAL_CONDITIONS`）；顺序即 `ordinal`，允许重复 kind
  （例如两个不同的 `challenge_code`）。
- `challenge` 必须带非空 `challenge_code`（≤200 字符）且不接受 `min`；`flag_count`
  必须带整数 `min`（1–10000）且不接受 `challenge_code`；`evidence` 两者都不接受。
  任何未知字段都会被拒绝。
- 创建请求里的 `goal_conditions` 必须非空；空列表只在存储层表示“没有自动条件”。
- `goal_conditions` 与单数 `verification` 不能同时出现（422）。

旧的单数 `verification` 仍然可用（`kind` 为 `challenge` / `evidence` / `off`，
`challenge` 带 `challenge_code`）。控制面把它投影成单条条件写入条件表，`off` 写成
空列表；两条路径最终读到的都是同一份有序条件。`GET /projects/{id}/verification`
的 `policy` 是这份数据的兼容视图：有 challenge 条件时显示该 challenge，否则显示
`evidence`，空列表显示 `off`。

没有 `project_goal_conditions` 行的旧项目在读取时按 `project_verification` 合成一条
条件（`off` 合成空列表）；连 `project_verification` 行也没有时按配置的
`verification.evidence_enforcement` 回退（默认 `completion` → `evidence`；`off` →
`off`）。这样 M41 之前的项目保持原有行为，无需迁移数据。

`POST /projects` 未显式给出 `verification` 或 `goal_conditions` 时（M18f），控制面先看
环境变量 `verification.challenge.code_env`（默认 `TCH_CHALLENGE_ID`）：非空即落库
`{kind: challenge, challenge_code: <值>}`，否则回退到 `evidence_enforcement` 映射的
`evidence` / `off`。显式请求体始终优先。策略在创建时固定；已有项目不会因环境变量或
配置变化而切换。

## 2. 判定来源

### evidence

- reason：取 `data.complete.from` 的 Fact 列表；`origin` / `goal` 是前提，不要求证据
  （只有它们是种子 Fact 时仍失败）。每个非种子 Fact 必须存在、关联到一次 run
  （`fact_meta.run_id` 非空）、证据状态为 `provided`、`fact_meta.evidence_refs`
  非空，且 `fact_evidence` 至少一行。任一缺口都会失败并列出 Fact 与原因。
- 已被取代的 Fact（`fact_meta.superseded_by` 非空，见 M15b）不能用于完成声明：
  oracle 会以 `fact was superseded by fXXX` 失败，要求引用当前 Fact 而不是旧结论。
- bootstrap：它要完成的 Fact 与结论在同一事务里创建，外层看不到；因此用任务级
  `evidence_refs` 校验，要求 `evidence_status=provided` 且至少一条引用。
- 显式 `POST /verify` 可带 `facts` 子集；不带时检查全部非 `origin`/`goal` Fact。
- 没有任何非种子 Fact 时失败（“no non-seed facts”），不会把空图当完成。

### challenge

请求：`GET <base_url>/api/challenges`（`base_url` 已以 `/api` 结尾时不重复追加），
header `Agent-Token: <token>`，超时默认 5000ms。响应必须是：

```json
{"code": 0, "message": "ok", "data": {"challenges": [
  {"code": "web-01", "flag_count": 3, "flag_got_count": 3}
]}}
```

按 `code` 精确匹配；`flag_count` / `flag_got_count` 必须是非负整数；`flag_count > 0`
且 `flag_got_count == flag_count` 才通过。计数器不一致（包括 `flag_got_count >
flag_count`）同样失败。以下情况一律失败（fail closed）：环境变量缺失、网络错误、
超时、非 2xx、非法 JSON、`code != 0`、列表或字段形状错误、挑战不存在。

**oracle 不读取 flag 明文。** oracle 只读取两个计数，`verification_checks` 只存
`flag_count` / `flag_got_count`；token 只从环境变量读取，不写配置、task.json、日志或
数据库。从 M18g 起，worker 被要求把拿到的 flag 原样写进 Fact 描述与证据文件，便于
操作员在项目页直接查看；prompt 仍严禁写入凭据、token 或其他密钥。`GET /flag` 优先
展示证据中的真实 flag，只有证据里只剩 `[REDACTED]` 等占位符时才回退读取 worker 的
solver-session 日志（只返回 flag 值与路径，不返回日志内容）。

### 组合求值（M41）

- 条件按 `ordinal` 升序求值，全部通过才 `ok=true`。多个条件引用同一 `challenge_code`
  时只请求一次挑战 API，结果复用。
- 单条件项目的顶层 `detail` 就是该条件的 detail，行为与 M41 之前一致；多条件通过时是
  `all N goal conditions passed`，失败时是
  `goal conditions failed: kind (detail); ...`（只列失败条件）。
- `flag_count` 的已确认数 = 操作员复核为 `real_more` / `real_done` 的 Flag 数 +
  所有 challenge 条件返回的 `flag_got_count` 之和（即使某个 challenge 条件本身尚未
  通过，它已拿到的计数仍算数）。detail 形如
  `flag_count requires 2 confirmed flag(s), found 1 operator-confirmed + 1 challenge-confirmed`。
  它只读计数，不读 flag 明文。
- 每个条件的逐条结果（`ordinal` / `kind` / `ok` / `detail` / `challenge_code` /
  `flag_count` / `flag_got_count` / `evidence_refs`）写入
  `verification_checks.conditions`；顶层 `flag_count` / `flag_got_count` 取第一个带
  计数的 challenge 条件，没有时取 flag_count 条件。
- AgentContext（M36/M41）在 `goal.verification.conditions` 中按同一顺序暴露每条条件的
  `ok` / `detail` / `progress`。M41 之前写入的检查没有逐条结果，读取时把顶层结果
  映射到旧项目合成的那一条条件，渲染不变。

## 3. 人工 Flag 复核（M32 + M32b + M32f + M34）

M32 把“抓到的 flag 值是否可信”交给操作员，而不是模型自判。开关
`verification.flag_review`（默认 `manual`，`off` 关闭）只控制是否登记复核，与完成策略
无关；设置弹窗「运行与执行 → 图切片与校验 → Flag 人工复核」就是这个开关，默认勾选，
保存后写回运行配置覆盖，无需重启。M32b 收起暂停语义：复核在后台进行，项目边跑边等
判定；派发不停，但在判定前项目不会被完成声明结束。

- **检测**：任务结果落图后，用与 `/flag` 相同的分类器（`apps/cairn/src/flags.ts`；
  前缀为 `flag` / `*flag` / 含 `ctf`，且不是 `[REDACTED]`、`...`、`<...>` 等掩码）
  扫描 explore / conclude 的 Fact 描述、bootstrap 的 Fact 与完成描述、reason 的完成
  描述。每个命中值按项目登记一行 `pending`；同一值只登记一次。M32f 起分类器先把工件里
  JSON 转义正文（`\n` 写作两个字符）粘上的那一个字母剥回，扫描值与操作员判定值是同一拼写，
  已判假的值不会因为多扫进几个文件就换一种写法重新出现。
- **不暂停派发，只推迟完成**：`pending` 行不进入调度门禁，explore / conclude / reason /
  bootstrap 照常派发；但项目的任何完成声明在判定前都不落地——bootstrap 保留已产出的
  Fact，reason 的完成声明释放租约并留待下一次 reason，日志分别是
  `bootstrap completion deferred … flag review pending` 与
  `completion deferred … operator flag review pending`。这样未判定的值（可能是假 Flag）
  不会直接结束项目。项目页头的琥珀色「Flag 复核」条提示“项目继续探索，判定前不会结束”，
  列出待判定值与三枚按钮，操作员随时可以作答。
- **判定后恢复**：`real_more` / `fake` 写 Hint 并驱动下一次 reason，未再引用被判假值的
  完成声明重新生效；`real_done` 直接结束项目。判定前若项目已自行完成（例如旧复核行），
  判定只记录结果，不会重复写入完成 Intent。
- **三种判定**：
  - `real_more`：值记入 `verified`；项目仍为 active 时写一条去重 Hint（“操作员确认 …
    为真且还有其他 Flag，继续探索。”）。
  - `real_done`：值记入 `verified`，同项目其余 `pending` 置 `dismissed`。项目仍为
    active 时控制面直接调用 `completeProject`（来源是该 flag 关联的 Fact，没有 Fact
    则 409）；项目已经结束时只记录判定，不重复写入完成 Intent。
  - `fake`：值记入 `rejected`；项目仍为 active 时写一条去重 Hint（“操作员判定 … 是假
    Flag …”）。同一值不会再入 `pending`，`/flag`、Writeup 扫描与候选列表都会过滤它。
- **判假值不能成为结束理由（M34）**：判定是终态且同一值不再入队，所以“等判定”的 hold 在
  判定落地那一刻就消失了；下一轮 reason 完全可能把同一个被判假的值重新写进完成描述，而
  `verification.mode: off` 会让它直接通过校验器，项目于是自己 completed 并停止探索。调度器
  在 reason 的 `complete` 分支与 bootstrap 的完成分支各加一道检查：声明文本里出现该项目
  任何 `status='fake'` 的值即拒绝这次完成——reason 释放租约继续跑（按 `success` 记账，所以
  不会累计慢层失败、不会触发 `failure_backoff`），bootstrap 保留已产出的 Fact 并保持 active，
  两种路径都写一条内容去重的控制面 Hint 说明被拒原因，日志为
  `completion deferred …: cites an operator-rejected flag` 与
  `bootstrap completion deferred …: cites an operator-rejected flag`。这道门禁与
  `verification.flag_review` 无关：`off` 只关掉复核登记，判过「假」的值在任何模式下都不算
  完成依据。判定是终态，一个值不能从「假」改判成「真」；要让项目真的结束，操作员可以
  直接 `POST /projects/{id}/complete`（走操作员 Token，这条路径不经过该门禁），或对该项目
  仍 `pending` 的其它值选「真 · 停止」（`real_done`），或者接受它继续探索、等 reason 给出
  未出现过的值。项目已经误关时用 `POST /projects/{id}/reopen` 拉回 active。

判定是终态：再次提交同一行返回 409。设置 `CAIRN_OPERATOR_TOKEN` 后判定路由同样要求
`X-Cairn-Operator-Token`（与 `/complete` 一致）。

## 4. 人工完成复核（M40 + M41）

自动完成需要至少一条客观条件（`challenge` 或 `flag_count`）。`off`（空条件）与只有
`evidence` 的项目无法由控制面证明“目标真的达成”——前者没有 oracle，后者只证明 Fact
可追溯——因此默认把完成声明交给操作员复核，而不是直接关项目：

| 条件 | 默认行为 | 配置逃生口 |
| --- | --- | --- |
| 含 `challenge` / `flag_count` 且全部通过 | 直接完成 | — |
| 只有 `evidence` 且通过 | 登记待复核，项目保持 active | `verification.evidence_completion: auto` |
| `off` / 空条件（`ok=true`） | 登记待复核，项目保持 active | `verification.off_completion: auto` |

- 调度器在 reason 与 bootstrap 的完成分支调用同一个判断；被推迟时写入/刷新一行
  `completion_reviews`（`pending`），日志为
  `completion deferred project=…: verification is off; operator review pending` 或
  `…: no objective goal condition; operator review pending`。reason 按 `success` 记账，
  不触发 `failure_backoff`；bootstrap 保留已产出的 Fact。
- 每个项目最多一行 `pending`（数据库部分唯一索引保证）；重复完成声明刷新同一行的
  `run_id` / `task_id` / `description` / `from_facts`，首次 `created_at` 不变。
- 操作员在项目页的「完成复核」横幅上批准或拒绝，或调用
  `POST /projects/{id}/completion-review/{review_id}/decision`
  （`{"decision": "approve" | "reject", "note": "可选"}`）。批准要求项目仍 active、
  复核行仍有来源 Fact，然后按该复核的 `from_facts` / `description` 完成项目；拒绝把
  行置为 `rejected`，项目仍 active 时写一条去重 Hint（“操作员拒绝完成声明，请继续探索。”）。
- 任何其它完成路径（自动 oracle、操作员 `/complete` 等）关闭项目时会把遗留的
  `pending` 复核置为 `approved` 并注明“without this review”，防止旧复核事后套用到
  另一次完成上。判定是终态，重复判定返回 409。

## 5. 配置

```yaml
verification:
  # completion：完成时必须满足证据规则（默认）；off：旧项目/离线测试的逃生口。
  # 该值在创建项目时写入 project_verification（及目标条件），之后改配置不会改变已有项目。
  evidence_enforcement: completion
  # M40：manual（默认）时 `off` / 空条件的完成声明登记人工复核；auto 恢复直接完成。
  off_completion: manual
  # M41：manual（默认）时只有 evidence 条件（无 challenge / flag_count）的完成声明
  # 登记人工复核；auto 恢复 M41 之前的自动完成，适合离线实验。
  evidence_completion: manual
  # manual：登记抓到 flag 形状的值供操作员后台复核（派发不停，完成声明等判定）；
  # off 关闭复核。M34 的「完成声明不得引用被判假的值」不受这个键影响：off 只是不再
  # 新登记 pending 行，已有的 rejected 判定照样会拒掉引用它的完成声明。
  flag_review: manual
  challenge:
    base_url_env: TCH_CHALLENGE_API_BASE_URL
    agent_token_env: TCH_CHALLENGE_AGENT_TOKEN
    # 当前题目编号所在的环境变量名；非空时新项目自动使用 challenge 校验。
    code_env: TCH_CHALLENGE_ID
    timeout_ms: 5000
```

`base_url_env` / `agent_token_env` / `code_env` 是环境变量**名**，不是值。默认名与
`TCH` 挑战平台一致；换成其他平台时只改名字，凭据与题目编号仍放在进程环境里。

`evidence_enforcement` 只影响完成判定，不在探索阶段拦截；它同时作为没有
`project_verification` 行的旧项目的回退策略，也是 `code_env` 为空时新项目的默认
（`completion` → `evidence`，`off` → `off`）。`POST /projects` 未显式给出
`verification` 或 `goal_conditions` 时，控制面按上一节的自动规则落库。

`off_completion` / `evidence_completion` 是服务端配置，不写入项目旁路数据，也不改变
oracle 的判定，只决定“判定通过后是否还需要人工批准”。两者都只在 `manual` 时登记
复核；显式设为 `auto` 即恢复旧的自动关项目行为。

`flag_review` 是服务端配置（不写入 `project_verification`），在设置弹窗里用
「Flag 人工复核」开关切换，保存后作为运行配置覆盖持久化到 SQLite，下一个任务结果落图时
生效；`off` 只跳过新复核的登记，不影响已有的 `flag_reviews` 行与展示过滤。

## 6. HTTP

- `POST /projects`：body 里用 `goal_conditions` 给出有序条件列表（M41），或用旧的
  单数 `verification`；两者不能同时出现。都不给时按上一节的自动规则落库。
- `POST /projects/{id}/verify`：body 可省略或为 `{}`；`{"facts": ["f001", ...]}` 可
  限定检查哪些 Fact。返回 `VerificationOutcome`：
  `{project_id, kind, ok, detail, challenge_code, flag_count, flag_got_count,
  evidence_refs, conditions, checked_at, check}`；`conditions` 是逐条结果数组。
  未知项目 404；body 不是对象或 `facts` 非法 400。
- `GET /projects/{id}/verification`：`{policy, goal_conditions, latest}`。`policy`
  是兼容别名；`goal_conditions` 是实际求值的有序条件（旧项目按别名合成，`off` 为
  空列表）；`latest` 是最近一次检查或 `null`。
- `GET /projects/{id}` 同样附带 `goal_conditions` 与 `completion_review`
  （`{pending, history}`），供项目页展示目标条件与完成复核。
- `GET /projects/{id}/flag`（M18f/M18g 扩展）：在原有 Flag 扫描结果上附带
  `verification: {policy, latest}`，与上一条同源。项目页头横幅据此显示校验状态，
  challenge 策略且尚未通过时轮询会持续刷新，直到调度器写入一次通过的检查。
  M18g 起，证据中没有真实 flag 时回退扫描 `.cairn/sessions/*/solver-session/*.jsonl`
  （同样的文件数/字节数/二进制限制，仅返回 flag 与相对路径），以恢复旧任务因
  prompt 要求而被改写成 `CTF2{[REDACTED]}` 的真实值；`[REDACTED]`、`masked`、
  `[hidden]` 等占位符永不作为结果返回。
- 新建项目弹窗（M18f）提供“完成校验”选择：`auto`（默认，题目环境优先）、
  `challenge`（需填写题目编号）、`evidence`、`off`。选择只影响创建请求，落库为
  单条件；多条件列表目前通过 API 创建。已有项目的条件固定，需要改条件时应新建项目。
- `GET /projects/{id}/flag-reviews`（M32）：返回
  `{pending, verified, rejected, counts}`；`pending` 带 `id` / `fact_id` / `run_id` /
  `flag` / `created_at`，`verified` / `rejected` 是值列表，`counts` 覆盖五种状态。
  `GET /projects/{id}` 的响应里同样附带这份 `flag_reviews` 摘要。
- `POST /projects/{id}/flag-reviews/{review_id}/decision`（M32/M32b）：body
  `{"decision": "real_more" | "real_done" | "fake", "note": "可选"}`（`note` ≤500
  字符）。返回 `{review, dismissed, reviews}`；非法判定 400、已判定 409、未知项目或
  复核行 404、项目仍为 active 时 `real_done` 没有关联 Fact 409；项目已结束时
  `real_done` 只记录判定。设置 `CAIRN_OPERATOR_TOKEN` 后要求操作员凭据。
- `GET /projects/{id}/flag` 的 M32 扩展：返回 `reviews` 摘要，并把 `fake` 值从
  `found` / `candidates` 中剔除、把已确认的值排在前面；扫描器从未见过的已确认值会以
  `source: "operator review"` 合成一条结果。Writeup 的 Flag 扫描用同一份过滤。
- `GET /projects/{id}/completion-review`（M40）：返回 `{pending, history}`。`pending`
  是当前待复核的完成声明（没有则为 `null`），带 `id` / `run_id` / `task_id` / `kind` /
  `description` / `from_facts` / `created_at`；`history` 是按 id 倒序的已判定行。
- `POST /projects/{id}/completion-review/{review_id}/decision`（M40/M41）：body
  `{"decision": "approve" | "reject", "note": "可选"}`。批准按复核的来源 Fact 完成项目，
  返回 `{review, project, completion_review}`；拒绝返回 `{review, completion_review}`
  并在项目仍 active 时写继续探索的 Hint。非法判定 400、未知项目或复核行 404、
  已判定或项目不 active 的批准 409、复核没有来源 Fact 409。设置
  `CAIRN_OPERATOR_TOKEN` 后要求操作员凭据。
- 手工 `POST /projects/{id}/complete` 不经过 oracle，仍是操作员显式覆盖；调度器不会
  调用它。设置 `CAIRN_OPERATOR_TOKEN` 后，该路由要求
  `X-Cairn-Operator-Token` 匹配，否则返回 401；未设置时保持旧行为，兼容本地单用户
  部署与 golden。

## 7. 数据

- `project_goal_conditions(project_id, ordinal, kind, config, created_at)`（M41）：主键
  `(project_id, ordinal)`，`config` 是 JSON（challenge 存 `challenge_code`，
  flag_count 存 `min`）。有序 AND 列表，项目删除时级联删除。读取顺序即 `ordinal`。
- `project_verification(project_id, kind, challenge_code, created_at)`：主键
  `project_id`，项目删除时级联删除。M41 起仅作为兼容别名保留。
- `verification_checks(id, project_id, kind, ok, detail, challenge_code, flag_count,
  flag_got_count, evidence_refs, conditions, checked_at)`：每次调用 oracle 追加一行
  （包括失败与 `off`）。`evidence_refs` 与 `conditions` 为 JSON，`conditions` 保存
  逐条结果；按项目时间倒序查询，默认 20、范围 1–100。
- `flag_reviews(id, project_id, fact_id, run_id, flag, status, note, created_at,
  decided_at)`（M32）：`UNIQUE(project_id, flag)`，`status` 为 `pending` /
  `real_more` / `real_done` / `fake` / `dismissed`。项目删除时级联删除。
- `completion_reviews(id, project_id, run_id, task_id, kind, description, from_facts,
  status, note, created_at, decided_at)`（M40）：`from_facts` 为 JSON 数组，
  `status` 为 `pending` / `approved` / `rejected`；部分唯一索引保证每项目最多一行
  `pending`。项目删除时级联删除。

这些表都不参与图导出、timeline 或既有 HTTP golden 响应（项目详情响应会附带只读摘要）。

## 8. 失败语义

- reason 完成声明未通过：不关项目；reason 租约正常释放，慢层可在后续 tick 重试。
- bootstrap 完成声明未通过：Fact 已写入并保留；项目保持 active，下一个 reason 决定
  是否补充证据或继续探索。
- 验证过程抛错（例如实现缺陷）：任务按失败处理，项目保持 active，日志记录
  `verification error`。
- `off`（空条件）的 oracle 直接通过，不读取任何 Fact 或网络；是否直接关项目由
  `off_completion` 决定，默认登记人工完成复核。
- 只有 `evidence` 条件且通过时，默认不自动关项目，而是登记完成复核；任何条件
  （challenge / flag_count）未通过时仍按普通验证失败处理，不会登记完成复核。
- flag 复核 pending 时任务照常结束并落图、项目继续派发，但完成声明推迟到判定之后；
  判定失败（400 / 404 / 409）不改项目状态，复核行保持 `pending`。
- 完成复核 pending 时项目保持 active 并继续派发；`approve` / `reject` 失败
  （400 / 404 / 409）不改项目状态，复核行保持 `pending`。

## 9. 已知边界

- evidence 只证明“完成声明引用的 Fact 来自一次 run 且有已记录的文件摘要”，不证明
  文件内容能推出 Fact 描述；人工复核仍需要看证据文件。
- challenge 的信任落在外部挑战 API 与 token 的保管上；控制面不校验 flag 明文。
- 并发完成声明可能重复调用 oracle；每次都是一行新检查，`latest` 只反映最后一次。
- 自动 challenge 选择只读取服务端进程环境；`TCH_CHALLENGE_ID` 存在但 API 凭据缺失时，
  新项目仍会落库为 challenge 策略，并在完成时以“未设置”失败（fail closed），不会退回
  evidence。
- 手工 `/complete` 可绕过验证（配置 token 后至少要求操作员凭据），审计上仍需要把它
  当作操作员决策。
- flag 复核按文本形状识别候选，不证明真伪；`real_more` / `fake` 判定后，若模型在
  没有新 flag 的情况下提出完成，`evidence` / `off` 策略仍可能放行——复核只提示“抓到
  flag”，不替代完成 oracle。
- 复核不暂停派发，因此项目在判定前可以继续探索并落更多 Fact；唯一被推迟的是完成
  声明。若复核行在项目结束后才被判定（旧数据或手工结束），`real_more` / `fake` 只
  记录判定、不再追加探索 Hint，`real_done` 只记录判定而不新增完成 Intent。
  `real_done` 以该复核行关联的 Fact 作为完成来源，若项目仍为 active 且任务没有留下
  Fact 就只能改选另外两种判定。
- `flag_count` 的“已确认”只统计操作员复核（`real_more` / `real_done`）与 challenge
  API 返回的计数；尚未复核的 flag 形状值、模型自述都不算数。
- “至少一条客观条件”只决定完成是否需要人工复核，不保证条件语义就是题目目标；
  `challenge_code` / `min` 仍由操作员在创建项目时选定。
- 目标条件在创建后固定，目前没有修改路由；要改变完成标准应新建项目（与单数策略的
  旧约束一致）。
- M41 之前写入的 `verification_checks` 没有逐条 `conditions`；AgentContext 只在单条件
  项目上把顶层结果映射到该条件，多条件项目需要一次新检查才会显示逐条进度。
