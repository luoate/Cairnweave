# 项目报告导出（M15c）

`GET /projects/{id}/report` 把一个项目的图与旁路数据合成一个只读快照，用于人工复核、
交接与归档。它不写 Fact、意图或旁路历史，也不改变调度；与其它读取项目详情的端点一样，
它会顺带让过期租约失效。任何既有端点返回的语义都不受影响。

```bash
# JSON（默认）
curl -s http://127.0.0.1:8787/projects/proj_001/report | jq .

# 人读版本
curl -s "http://127.0.0.1:8787/projects/proj_001/report?format=markdown"
```

## 1. 结构

```json
{
  "generated_at": "2026-10-27T12:00:00Z",
  "project": {"id": "proj_001", "title": "...", "status": "active", "bootstrap_enabled": false,
              "created_at": "...", "reason": null},
  "verification": {
    "kind": "evidence",
    "challenge_code": null,
    "checks": {"total": 2, "passed": 1, "failed": 1, "last_checked_at": "..."},
    "latest": {"id": 2, "ok": false, "detail": "...", "flag_count": 2, "flag_got_count": 1,
               "evidence_refs": [], "checked_at": "..."}
  },
  "graph": {"facts": 12, "current_facts": 10, "superseded_facts": 2,
            "intents": 8, "open_intents": 1, "hints": 3},
  "current_facts": [{"id": "f001", "description": "..."}],
  "hints": [{"id": "h001", "content": "...", "creator": "operator", "created_at": "..."}],
  "supersessions": [{"fact_id": "f002", "description": "...", "superseded_by": "f007",
                     "superseded_by_description": "...", "created_at": "..."}],
  "runs": {
    "totals": {"runs": 5, "finished": 5, "succeeded": 3, "failed": 2,
               "tokens": 123456, "cost_usd": 0.42, "avg_duration_ms": 18500},
    "by_worker": [], "by_model": [], "by_profile": []
  },
  "cost": {"tokens": 123456, "cost_usd": 0.42,
           "unattributed_tokens": 8123, "unattributed_cost_usd": 0.01,
           "by_kind": [{"kind": "explore", "runs": 3, "tokens": 90000, "cost_usd": 0.3}]},
  "audit": {"tasks": 5, "events": 240, "first_at": "...", "last_at": "..."},
  "artifacts": {"count": 4, "bytes": 50123}
}
```

字段来源：

| 字段 | 来源 |
| --- | --- |
| `project` / `current_facts` / `hints` | 图（`getProjectDetail`）；`current_facts` 排除已被取代的 Fact，按 id 排序 |
| `verification` | `project_verification` + `verification_checks`；没有策略行时按路由的默认策略（`evidence`）合成 |
| `graph` | 图计数；`current_facts = facts - superseded_facts` |
| `supersessions` | `fact_meta.supersedes` 推导的反向边（M15b） |
| `runs` | `runs` 旁路与 `/stats` 相同的分桶 |
| `cost` | `/cost` 的总量、未归因余量与 `by_kind` |
| `audit` | 每个任务的导入摘要，仅计数与时间边界 |
| `artifacts` | 工件索引的文件数与字节数 |

`runs.totals` 与 `cost.totals` 都来自同一批 `runs` 行；前者是运行口径，后者用于成本
归因。`cost.by_kind` 的所有 `tokens` 之和等于 `cost.tokens`。

## 2. 顺序与确定性

除 `generated_at` 外，报告是确定的：

- `current_facts` 按 Fact id 排序；
- `hints` 按 `created_at`、再按 id 排序；
- `supersessions` 按被取代 Fact id 排序；
- `by_worker` / `by_model` / `by_profile` 沿用 `/stats` 的排序（模型为 `null` 的桶
  排在最后）；
- `by_kind` 按 kind 字典序。

`generated_at` 每次请求都会变化；测试用 `buildProjectReport(conn, id, {generatedAt})`
注入固定值。

## 3. 脱敏与边界

报告刻意只输出**汇总**，不输出原始内容：

- 不含审计事件原文（Host Bridge 会记录命令、路径与结果，其中可能有凭据或 flag）；
- 不含工件路径、SHA-256 或文件内容（这些仍可从 `/artifacts` 与证据端点按需读取）；
- 不含证据文件内容；`verification.latest` 只含检查结果、证据引用与 flag 计数；
- 挑战验证只读取并导出 `flag_count` / `flag_got_count`，从不读取 flag 本身；
- Fact 与 Hint 是图内容，按图原样进入报告。若模型把敏感值写进了 Fact 描述，报告不会
  替它脱敏——这与 `GET /projects/{id}` 和 YAML 导出一致，需要在上游 prompt 与
  Observer 提案校验处约束。

Markdown 渲染会把 Fact、Hint、错误 detail 中的换行折叠为空格，并转义表格单元格中的
`|`，避免内容破坏文档结构。

## 4. HTTP 行为

| 请求 | 结果 |
| --- | --- |
| `GET /projects/{id}/report` | `200`，`application/json` |
| `GET /projects/{id}/report?format=markdown` | `200`，`text/markdown; charset=utf-8` |
| `format` 不是 `json` / `markdown` | `400`，`{"detail":"Supported formats: json, markdown"}` |
| 未知项目 | `404` |
| `POST` / `PUT` / `DELETE` | `405` |

路由无需请求体，也没有查询参数上限之外的副作用；它与其他只读端点一样不做认证，容器
或公网部署仍需网络层访问控制。

## 4.1 静态 UI（M15d）

「报告」页签打开时请求上面的 JSON 路由，渲染完成判定、图状态、当前 Fact、取代边、
run 总量与分桶、审计/工件计数；右上角 `Markdown` 按钮直接链接到
`?format=markdown`，由浏览器下载，前端不重复实现渲染。Fact 详情的“取代关系”来自
`GET /projects/{id}/facts/{id}/meta` 的 `supersedes` / `superseded_by`，只在存在边时
出现；点击两侧 id 复用图选择，不产生写请求。

## 5. 已知边界

- 报告是某一时刻的快照，不保证与并发中的任务一致；`runs.totals` 只统计已写入的行，
  运行中的任务尚未回报用量。
- 不包含 timeline / YAML 导出；需要可重放的图文本时仍用
  `GET /projects/{id}/export?format=yaml|timeline`。
- 当前 Fact 与 Hint 全量输出，没有分页；超大项目（数千 Fact）的报告也会很大。
- 报告不跨项目聚合；多项目汇总需要调用方逐个请求。
