# 完成验证（M14a + M18f + M32 + M32b）

M14a 把“项目完成”从模型自证改为控制面可验证。worker 返回的 `complete` 只是声明；
scheduler 在关项目之前运行 oracle，并把每次判定写入旁路表。验证失败不会丢工作：
reason 释放租约、项目保持 active；bootstrap 保留已产出的 Fact，只推迟完成。

## 1. 策略

策略是项目级旁路数据（`project_verification`），不进入 Cairn 图、YAML 导出或
`GET /projects/{id}` 的图响应。创建项目时可指定：

```json
{
  "title": "...",
  "origin": "...",
  "goal": "...",
  "scope": {"targets": ["10.0.0.5"]},
  "verification": {"kind": "challenge", "challenge_code": "web-01"}
}
```

| kind | 语义 |
| --- | --- |
| `evidence`（默认） | 完成声明引用的每个非种子 Fact 必须有 `run_id`、`evidence_status=provided` 且至少一条 `fact_evidence` |
| `challenge` | 读取外部挑战 API 的 `flag_got_count` / `flag_count`；两者严格相等才通过 |
| `off` | 显式关闭验证；用于导入项目或只关心图推进的场景 |

没有 `project_verification` 行的旧项目按配置的
`verification.evidence_enforcement` 处理（默认 `completion` → `evidence`；`off` →
`off`）。`kind=challenge` 必须带非空 `challenge_code`（≤200 字符）；`evidence` / `off`
不接受 `challenge_code`。

`POST /projects` 未显式给出 `verification` 时（M18f），控制面先看环境变量
`verification.challenge.code_env`（默认 `TCH_CHALLENGE_ID`）：非空即落库
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

## 3. 人工 Flag 复核（M32 + M32b）

M32 把“抓到的 flag 值是否可信”交给操作员，而不是模型自判。开关
`verification.flag_review`（默认 `manual`，`off` 关闭）只控制是否登记复核，与完成策略
无关。M32b 收起暂停语义：复核在后台进行，项目边跑边等判定。

- **检测**：任务结果落图后，用与 `/flag` 相同的分类器（`apps/cairn/src/flags.ts`；
  前缀为 `flag` / `*flag` / 含 `ctf`，且不是 `[REDACTED]`、`...`、`<...>` 等掩码）
  扫描 explore / conclude 的 Fact 描述、bootstrap 的 Fact 与完成描述、reason 的完成
  描述。每个命中值按项目登记一行 `pending`；同一值只登记一次。
- **不暂停**：`pending` 行不进入调度门禁，也不推迟任何完成声明；explore / conclude /
  reason / bootstrap 照常派发，项目可以带着未判定的复核直接完成。项目页头的琥珀色
  「Flag 复核」条提示“项目继续运行”，列出待判定值与三枚按钮，操作员随时可以作答。
- **三种判定**：
  - `real_more`：值记入 `verified`；项目仍为 active 时写一条去重 Hint（“操作员确认 …
    为真且还有其他 Flag，继续探索。”）。
  - `real_done`：值记入 `verified`，同项目其余 `pending` 置 `dismissed`。项目仍为
    active 时控制面直接调用 `completeProject`（来源是该 flag 关联的 Fact，没有 Fact
    则 409）；项目已经结束时只记录判定，不重复写入完成 Intent。
  - `fake`：值记入 `rejected`；项目仍为 active 时写一条去重 Hint（“操作员判定 … 是假
    Flag …”）。同一值不会再入 `pending`，`/flag`、Writeup 扫描与候选列表都会过滤它。

判定是终态：再次提交同一行返回 409。设置 `CAIRN_OPERATOR_TOKEN` 后判定路由同样要求
`X-Cairn-Operator-Token`（与 `/complete` 一致）。

## 4. 配置

```yaml
verification:
  # completion：完成时必须满足证据规则（默认）；off：旧项目/离线测试的逃生口。
  # 该值在创建项目时写入 project_verification，之后改配置不会改变已有项目。
  evidence_enforcement: completion
  # manual：登记抓到 flag 形状的值供操作员后台复核（不暂停项目）；off 关闭复核。
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
`verification` 时，控制面按上一节的自动规则落库。

`flag_review` 是服务端配置（不写入 `project_verification`），改配置后在下一个调度
tick 生效；`off` 只跳过复核，不影响已有的 `flag_reviews` 行与展示过滤。

## 5. HTTP

- `POST /projects/{id}/verify`：body 可省略或为 `{}`；`{"facts": ["f001", ...]}` 可
  限定检查哪些 Fact。返回 `VerificationOutcome`：
  `{project_id, kind, ok, detail, challenge_code, flag_count, flag_got_count,
  evidence_refs, checked_at, check}`。未知项目 404；body 不是对象或 `facts` 非法 400。
- `GET /projects/{id}/verification`：`{policy, latest}`。`policy` 对没有旁路行的项目
  合成 `evidence` 默认值；`latest` 是最近一次检查或 `null`。
- `GET /projects/{id}/flag`（M18f/M18g 扩展）：在原有 Flag 扫描结果上附带
  `verification: {policy, latest}`，与上一条同源。项目页头横幅据此显示校验状态，
  challenge 策略且尚未通过时轮询会持续刷新，直到调度器写入一次通过的检查。
  M18g 起，证据中没有真实 flag 时回退扫描 `.cairn/sessions/*/solver-session/*.jsonl`
  （同样的文件数/字节数/二进制限制，仅返回 flag 与相对路径），以恢复旧任务因
  prompt 要求而被改写成 `CTF2{[REDACTED]}` 的真实值；`[REDACTED]`、`masked`、
  `[hidden]` 等占位符永不作为结果返回。
- 新建项目弹窗（M18f）提供“完成校验”选择：`auto`（默认，题目环境优先）、
  `challenge`（需填写题目编号）、`evidence`、`off`。选择只影响创建请求；已有项目的
  策略仍按 `project_verification` 固定，需要改策略时应新建项目。
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
- 手工 `POST /projects/{id}/complete` 不经过 oracle，仍是操作员显式覆盖；调度器不会
  调用它。设置 `CAIRN_OPERATOR_TOKEN` 后，该路由要求
  `X-Cairn-Operator-Token` 匹配，否则返回 401；未设置时保持旧行为，兼容本地单用户
  部署与 golden。

## 6. 数据

- `project_verification(project_id, kind, challenge_code, created_at)`：主键
  `project_id`，项目删除时级联删除。
- `verification_checks(id, project_id, kind, ok, detail, challenge_code, flag_count,
  flag_got_count, evidence_refs, checked_at)`：每次调用 oracle 追加一行（包括失败与
  `off`）。`evidence_refs` 为 JSON 数组，按项目时间倒序查询，默认 20、范围 1–100。
- `flag_reviews(id, project_id, fact_id, run_id, flag, status, note, created_at,
  decided_at)`（M32）：`UNIQUE(project_id, flag)`，`status` 为 `pending` /
  `real_more` / `real_done` / `fake` / `dismissed`。项目删除时级联删除。

这三张表都不参与图导出、timeline 或既有 HTTP golden 响应。

## 7. 失败语义

- reason 完成声明未通过：不关项目；reason 租约正常释放，慢层可在后续 tick 重试。
- bootstrap 完成声明未通过：Fact 已写入并保留；项目保持 active，下一个 reason 决定
  是否补充证据或继续探索。
- 验证过程抛错（例如实现缺陷）：任务按失败处理，项目保持 active，日志记录
  `verification error`。
- `off` 策略直接通过，不读取任何 Fact 或网络。
- flag 复核 pending 时任务照常结束并落图，项目继续派发甚至完成；判定失败（400 /
  404 / 409）不改项目状态，复核行保持 `pending`。

## 8. 已知边界

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
- 复核不阻塞项目，因此项目可能在判定前就已完成；此时 `real_more` / `fake` 只记录
  判定、不再追加探索 Hint，`real_done` 只记录判定而不新增完成 Intent。`real_done`
  以该复核行关联的 Fact 作为完成来源，若项目仍为 active 且任务没有留下 Fact 就只能
  改选另外两种判定。
