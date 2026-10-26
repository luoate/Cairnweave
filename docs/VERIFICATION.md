# 完成验证（M14a）

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
| `evidence`（默认） | 完成声明引用的每个非种子 Fact 必须有 `evidence_status=provided` 且至少一条 `fact_evidence` |
| `challenge` | 读取外部挑战 API 的 `flag_got_count` / `flag_count`；全部拿到才通过 |
| `off` | 显式关闭验证；用于导入项目或只关心图推进的场景 |

没有 `project_verification` 行的旧项目按 `evidence` 处理。`kind=challenge` 必须带
非空 `challenge_code`（≤200 字符）；`evidence` / `off` 不接受 `challenge_code`。

## 2. 判定来源

### evidence

- reason：取 `data.complete.from` 的 Fact 列表；每个 Fact 必须存在、证据状态为
  `provided`，且 `fact_evidence` 至少一行。任一缺口都会失败并列出 Fact 与原因。
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
且 `flag_got_count >= flag_count` 才通过。以下情况一律失败（fail closed）：环境变量
缺失、网络错误、超时、非 2xx、非法 JSON、`code != 0`、列表或字段形状错误、挑战不存在。

**flag 明文不进入控制面。** oracle 只读取两个计数，`verification_checks` 只存
`flag_count` / `flag_got_count`；token 只从环境变量读取，不写配置、task.json、日志或
数据库。prompt 也明确要求不要输出 flag 值。

## 3. 配置

```yaml
verification:
  challenge:
    base_url_env: TCH_CHALLENGE_API_BASE_URL
    agent_token_env: TCH_CHALLENGE_AGENT_TOKEN
    timeout_ms: 5000
```

`base_url_env` / `agent_token_env` 是环境变量**名**，不是值。默认名与 `TCH` 挑战
平台一致；换成其他平台时只改名字，凭据仍放在进程环境里。

## 4. HTTP

- `POST /projects/{id}/verify`：body 可省略或为 `{}`；`{"facts": ["f001", ...]}` 可
  限定检查哪些 Fact。返回 `VerificationOutcome`：
  `{project_id, kind, ok, detail, challenge_code, flag_count, flag_got_count,
  evidence_refs, checked_at, check}`。未知项目 404；body 不是对象或 `facts` 非法 400。
- `GET /projects/{id}/verification`：`{policy, latest}`。`policy` 对没有旁路行的项目
  合成 `evidence` 默认值；`latest` 是最近一次检查或 `null`。
- 手工 `POST /projects/{id}/complete` 不经过 oracle，仍是操作员显式覆盖；调度器不会
  调用它。

## 5. 数据

- `project_verification(project_id, kind, challenge_code, created_at)`：主键
  `project_id`，项目删除时级联删除。
- `verification_checks(id, project_id, kind, ok, detail, challenge_code, flag_count,
  flag_got_count, evidence_refs, checked_at)`：每次调用 oracle 追加一行（包括失败与
  `off`）。`evidence_refs` 为 JSON 数组，按项目时间倒序查询，默认 20、范围 1–100。

这两张表都不参与图导出、timeline 或既有 HTTP golden 响应。

## 6. 失败语义

- reason 完成声明未通过：不关项目；reason 租约正常释放，慢层可在后续 tick 重试。
- bootstrap 完成声明未通过：Fact 已写入并保留；项目保持 active，下一个 reason 决定
  是否补充证据或继续探索。
- 验证过程抛错（例如实现缺陷）：任务按失败处理，项目保持 active，日志记录
  `verification error`。
- `off` 策略直接通过，不读取任何 Fact 或网络。

## 7. 已知边界

- evidence 只证明“完成声明引用的 Fact 有已记录的文件摘要”，不证明文件内容能推出
  Fact 描述；人工复核仍需要看证据文件。
- challenge 的信任落在外部挑战 API 与 token 的保管上；控制面不校验 flag 明文。
- 并发完成声明可能重复调用 oracle；每次都是一行新检查，`latest` 只反映最后一次。
- 手工 `/complete` 可绕过验证，审计上需要把它当作操作员决策。
