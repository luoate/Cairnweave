# 中文 Writeup 生成（M19a）

Writeup 是给人看的中文复盘文本。它有两种形态：**中文草稿**由控制面依据图中数据确定
性渲染，永远可用、只读、不需要模型；**模型撰写版**可选，让配置的模型把同一份草稿重写
成连贯文章并存储。两者都只重组已经记录的事实，不会新增未经核实的内容。

```bash
# 中文草稿（JSON，含 markdown 正文）
curl -s http://127.0.0.1:8787/projects/proj_001/writeup | jq -r .markdown

# 直接下载 Markdown
curl -s "http://127.0.0.1:8787/projects/proj_001/writeup?format=markdown" -o writeup.md

# 让模型按草稿重写（默认使用 model-prefs 里的 cairn-worker）
curl -s -X POST http://127.0.0.1:8787/projects/proj_001/writeup \
  -H 'content-type: application/json' -d '{}' | jq .source   # => "model"

# 指定模型条目
curl -s -X POST http://127.0.0.1:8787/projects/proj_001/writeup \
  -d '{"model":"strong-reasoner"}'

# 删除模型撰写版，回到草稿
curl -s -X DELETE http://127.0.0.1:8787/projects/proj_001/writeup | jq .source  # => "draft"
```

## 1. 草稿包含什么

`packages/graph/src/writeup.ts` 的 `buildProjectWriteup` 只做读取，组合
`getProjectDetail`（项目、Fact、意图、Hint）、`getProjectScope`、
`listFactSupersessions`、`buildProjectRunStats`、`summarizeProjectVerification`、
`listProjectArtifacts`、`fact_meta`（证据引用与产出 run）以及 `runs` 的精简投影。
渲染出的章节：

| 章节 | 内容 |
| --- | --- |
| 头部 | 项目 id、状态、创建/生成时间、题目编号、授权范围与备注 |
| 结论 | 是否拿到 Flag、校验状态、完成的探索意图数与当前有效事实数 |
| 题目与目标 | origin / goal 原文 |
| 攻击路径 | 已结束的意图按 `created_at, id` 排序，逐步列出基于哪些 Fact、产出的 Fact、worker / model / 结果、证据引用 |
| 尚未完成的探索 | 仍开放的意图（有则出现） |
| 关键发现 | 全部当前有效事实（排除 origin/goal 与被取代者），附证据引用 |
| 被取代的判断 | `fact_meta.supersedes` 推导的反向边 |
| 提示 | Hint 按 `created_at, id` 排序 |
| Flag 与校验 | Flag 原文与来源、校验策略、最近一次检查与 flag 计数 |
| 执行统计 | 运行数、结束/成功/失败、Token、成本，附 worker 与 model 两张表 |
| 附录：证据文件 | 工件索引的路径、大小、sha256 前 12 位与来源任务，最多 200 项 |

确定性：除 `generated_at` 外，排序与文案固定；测试通过
`buildProjectWriteup(conn, id, {generatedAt})` 注入时钟。多行 Fact 描述会被折叠成单行，
表格单元格里的 `|` 会被转义。

Flag 由 `/flag` 同一个 `collectProjectFlag` 提供（artifacts 优先，未命中时限量回退扫描
`solver-session` JSONL），所以横幅与 Writeup 不会给出不同的 Flag。按 M18g 的策略，
Flag 保留原文、不做脱敏；没有 workspace root 的纯 HTTP 模式下 Flag 段为“未捕获”。

## 2. 模型撰写版

`renderProjectWriteupPrompt` 把整份草稿作为唯一素材交给模型，硬性要求写在 prompt 里：

- 全程简体中文（技术名词可保留英文）；
- 只使用草稿中出现的事实、证据路径与 Flag，不补充未记录的利用细节；
- 证据不足或未完成要如实写“未验证”“未完成”；
- Flag 逐字符照抄，不改写、不脱敏、不截断；
- 不得写入凭据、token、cookie、API key 或内网敏感地址（草稿授权范围内的目标除外）；
- 建议结构：题目概述 → 信息收集 → 利用链 → 获取 Flag → 复盘与遗留问题；
- 输出正文，篇幅约 1200 字以内。

调用走 `@cairn/agent` 的 `completeText`：一次**无工具**的单轮补全（`tools: []`、
内存会话、不写图、不派任务），因此撰写过程不能触发任何 shell、网络或文件操作。
成功结果 upsert 进 `project_writeups`（每项目一行，记 `markdown` / `model` /
`created_at`），此后 GET 与 Markdown 下载服务存储版；`DELETE` 清除后回到草稿。

## 3. 限额与守卫

| 项 | 取值 |
| --- | --- |
| prompt 上限 | 60000 字符，超出则截断草稿尾部 |
| 正文上限 | 200000 字符，超出则截断并标注 |
| 附录文件数 | 200（超出置 `artifacts_truncated`） |
| 请求体 | ≤4 KiB，`model` 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` |
| 超时 | 默认 90 秒（`writeupTimeoutMs`），到时返回 504 |
| 写守卫 | POST/DELETE 需 operator token（配置时）且拒绝跨源写 |
| 错误文本 | provider 报错先经 `sanitizeText` 掩掉密钥样式再进 `detail` |

生成失败（502）或超时（504）**不会**清除或覆盖已存储的正文，读到的仍是上一次成功的
Writeup。`@cairn/graph` 不依赖 `@cairn/agent`：生成器由 HTTP 层注入，测试用 fake
generator 覆盖成功、失败、超时与脱敏路径。

## 4. HTTP 行为

`GET|POST|DELETE /projects/{id}/writeup` 统一返回：

```json
{
  "project_id": "proj_001",
  "source": "draft",
  "model": null,
  "created_at": null,
  "markdown": "# Writeup：…",
  "flag": {"value": "CTF{...}", "source": "artifacts/flag.txt", "occurrences": 1},
  "generated_at": "2026-10-28T09:00:00Z",
  "verification": {"kind": "evidence",
                   "checks": {"total": 1, "passed": 1, "failed": 0, "last_checked_at": "..."},
                   "latest": null}
}
```

| 请求 | 结果 |
| --- | --- |
| `GET /projects/{id}/writeup` | `200`，`application/json`；有存储版时 `source:"model"` |
| `GET ...?format=markdown` | `200`，`text/markdown; charset=utf-8`，与 JSON 里同一份正文 |
| `format` 非法 | `400`，`{"detail":"Supported formats: json, markdown"}` |
| 未知项目 | `404`（三种方法都先构建草稿） |
| `POST` 成功 | `200`，`{..., ok:true}`，`source:"model"` |
| `POST` 模型不可用 / 空输出 | `502`，`detail` 为脱敏后的原因 |
| `POST` 超时 | `504`，`writeup generation timed out after Ns` |
| `POST` 请求体非法 | `400`；超过 4 KiB 为 `413` |
| `PUT` / `PATCH` 等其他方法 | `405` |

草稿是只读的，但与其它读取项目详情的端点一样会顺带让过期租约失效；只有 POST/DELETE
会写 `project_writeups`，不写图、不写旁路历史、不改变调度。

## 5. 静态 UI

侧栏「Writeup」页签（与其它运维页签一样按项目记在 `localStorage`）进入时请求 JSON 路由，
把正文原样放在 `<pre>` 里显示，标注“中文草稿”或“模型撰写”、所用模型与生成时间。
可用操作：刷新、复制、`Markdown` 下载（直接指向 `?format=markdown`）、`AI 撰写`
（POST，生成期间按钮禁用并提示进度）与仅在模型版下出现的`恢复草稿`（DELETE）。
失败给行内错误与重试，前端不自行拼接正文。

## 6. 与报告的分工

`GET /projects/{id}/report` 是可分享的只读快照：不含工件路径、证据内容与 Flag。
Writeup 面向复盘，包含证据文件路径与 Flag 原文，因此写操作受 operator token 与同源
约束，也不做跨项目汇总。需要交接材料时先发报告，需要复现过程时发 Writeup。

## 7. 已知边界

- 草稿质量受图中数据限制：Fact 描述含糊或没有 `evidence_refs` 时，Writeup 只能照实
  呈现，不会替它补全利用细节。
- 没有 workspace root 时无法扫描 Flag。
- 模型撰写版按项目只存一份，后写覆盖前者；历史版本需要外部存档。
- 撰写调用不落 `runs`，因此它的 Token 与成本不出现在 `/stats` 与 `/cost` 里；需要核
  对时看模型提供方自己的用量面板。
