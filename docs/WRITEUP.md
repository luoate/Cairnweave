# 中文 Writeup 生成（M19a / M20a / M20b / M21）

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

# 附件包：Writeup 正文 + 清单 + 全部已登记工件，打成一个 zip
curl -s http://127.0.0.1:8787/projects/proj_001/writeup/archive -o writeup-proj_001.zip
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
| 载荷（Payload） | 工件索引里命中载荷/脚本特征的文件：文本逐字内联，二进制只登记路径，见 §1.1 |
| 被取代的判断 | `fact_meta.supersedes` 推导的反向边 |
| 提示 | Hint 按 `created_at, id` 排序 |
| Flag 与校验 | Flag 原文与来源、其它候选、疑似占位文本、校验策略、最近一次检查与 flag 计数 |
| 执行统计 | 运行数、结束/成功/失败、Token、成本，附 worker 与 model 两张表 |
| 附录：证据文件 | 工件索引的路径、大小、sha256 前 12 位与来源任务，最多 200 项 |

确定性：除 `generated_at` 外，排序与文案固定；测试通过
`buildProjectWriteup(conn, id, {generatedAt})` 注入时钟。多行 Fact 描述会被折叠成单行，
表格单元格里的 `|` 会被转义。

Flag 由 `/flag` 同一个 `collectProjectFlag` 提供（artifacts 优先，未命中时限量回退扫描
`solver-session` 的**工具输出**），所以横幅与 Writeup 不会给出不同的 Flag。按 M18g 的策略，
Flag 保留原文、不做脱敏；被判定为占位或截断的 flag 形状文本不会当成 Flag，只作为
`flag_suspects` 列出，见 §1.3。没有 workspace root 的纯 HTTP 模式下 Flag 段为“未捕获”。

### 1.1 载荷（Payload）章节（M20a）

Writeup 必须写明攻击用到的载荷与脚本。哪些工件算载荷由一条确定性规则决定，写在
`packages/graph/src/writeup.ts`，`@cairn/graph` 与测试共用同一个 `isWriteupPayloadPath`：

- **脚本与投递格式扩展名**：`py sh bash zsh php php5 phtml phar js ts rb pl pm ps1 bat cmd c cpp go rs java jsp asp aspx sql html htm xml svg xsl xslt yaml yml pkl pickle zip tar gz bz2 xz 7z rar jar war class png jpg jpeg gif bmp ico webp pdf`；
- **文件名关键字**：`payload exploit attack poc inject sqli xss ssrf ssti xxe pickle pkl traver webshell reverse[-_]shell bind[-_]shell deserial forg bypass`。

普通响应转储（`.txt`、`.out`、`.resp`、`.md`、`.json`，除非文件名命中关键字）不算载荷，
它们留在「附录：证据文件」里。这样「载荷」章节给的是**打向目标的东西**，而不是 worker
保存下来的所有字节。

命中载荷的文件可以很多，章节只放前 `MAX_WRITEUP_PAYLOADS` 个，顺序是先排**被某条 Fact 的
`evidence_refs` 引用过的**（引用数多的更前），再按路径字典序——`selectWriteupPayloadArtifacts`
实现这条排序。这样 20 条上限不会把真正支撑结论的载荷挤掉，纯探测脚本才会被截到附件包里。
HTTP 层只读这份选出来的清单，不再自己筛选或计数。

读文件由 HTTP 层负责（`apps/cairn/src/http/project-payload.ts`），`@cairn/graph` 不碰文件
系统：它只把路径、大小、sha256、来源任务与「哪条 Fact 的 `evidence_refs` 引用了它」
（`referenced_by`）组装进快照。读取沿用 Flag 扫描的收敛规则——`<workspace>/artifacts`
真实目录、非符号链接的普通文件、路径不逃逸、单文件 ≤128 KiB；含 NUL 的字节判定为二进制，
只登记路径不内联。渲染规则：

| 情况 | 章节里显示 |
| --- | --- |
| 文本载荷且已读到 | 带语言的围栏代码块，逐字引用（正文含反引号时自动加长围栏） |
| 文本载荷但超预算 | 截断到上限并标注“内容已截断，完整文件见附件包” |
| 二进制载荷 | “二进制载荷，未内联，完整文件见附件包” |
| 工作区未挂载或文件已被清理 | “内容未读取：工作区未挂载或文件已被清理” |
| 一个都没命中 | “（没有识别到载荷或脚本文件）” |

章节开头写明“识别到 N 个、此处列出 M 个、其中 K 个逐字内联”（N 是 `payloads_total`，
包含被上限截掉的那些），截断时结尾追加“…其余 N-M 个载荷文件见附件包。”，读者据此知道
附件包里还有更多内容。

JSON 视图里的 `payloads` 是同一份清单的投影（不含正文）：`files[]` 每项带
`state: inline|binary|unread`、`language`、`truncated` 与 `referenced_by`，外加
`total / count / inlined / binary / unread / truncated` 汇总（`total` 是识别到的全部载荷数，
`count` 是实际列出的条数），侧栏摘要用它显示“载荷 N 个（内联 K）”。

### 1.2 附件包（M20b）

「载荷」章节受内联预算约束，正文之外的字节由 `GET /projects/{id}/writeup/archive` 一次
交付。打包布局刻意与 Writeup 的引用一致，读者照着正文里的路径就能在压缩包里找到同一个
文件：

```
writeup.md                        # 当前服务的正文：有存储版就是模型版，否则是草稿
MANIFEST.md                       # 中文清单：项目、打包时间、Flag、载荷统计、逐文件校验
artifacts/<任务目录>/<文件>        # 工件索引里的每个文件，路径与正文引用一致
```

写入器是自己实现的极简 ZIP（`apps/cairn/src/http/zip.ts`）：store 与 raw deflate 两种
method（deflate 不省字节时回退 store）、CRC-32、单一中央目录、文件名字段带 UTF-8 标志位、
DOS 时间戳由调用方固定，因此同一批输入产出同一份字节。配套的 `readZip()` 会校验 CRC，
测试用它当格式自检，Windows `Expand-Archive` 与常见解压器都能直接打开。条目名先归一化
（`\`→`/`、去掉前导 `/`），出现空段或 `..` 直接拒绝，防止解包时逃出根目录。

打包范围是**该项目的全部已登记工件**（`project_artifacts`），不是正文里列出的那 ≤20 个
载荷——图片、响应转储、脚本都进包，上限见 §3。读取沿用 Flag 扫描与载荷读取同一套收敛
函数（`openArtifactRoot` + `readArtifactFile`）：只读 `<workspace>/artifacts` 里的常规
非符号链接文件，索引里指向包外、目录或已被清理的路径一律跳过。

`MANIFEST.md` 把「没打进包」写成显式信息：`## 文件与校验` 表逐条列打包成功的路径、字节、
sha256 与来源任务；`## 未打包文件` 表给出被跳过的路径与中文原因（`附件目录不可读`、
`超出附件包上限`、`单文件超过 N 字节`、`文件缺失或不是普通文件`）。触发过文件数或字节上限
时，头部标注「附件文件：N 个已打包（受上限约束，未全部打包）」。校验列取工件索引登记的
值（索引时算出的 sha256），因此它与正文「附录：证据文件」里的哈希完全对得上。

### 1.3 Flag 置信度（M21）

Flag 只有一个来源：`collectProjectFlag`（`apps/cairn/src/http/project-flag.ts`），`/flag` 横幅、
Writeup 草稿与撰写 prompt 共用它，所以三处不会给出不同的 Flag。M21 收紧两件事——**什么算证据**
和**什么算 Flag**。

**证据只来自工具输出。** 先扫 `project_artifacts` 登记的工件正文；都没命中才回退读
`.cairn/sessions/<task>/solver-session/*.jsonl`，且只取 `message.role === "toolResult"` 的文本块
（`sessionToolText`）。此前逐行扫描原始 JSONL，模型在自己叙述进度时写下的 `CTF2{c8xxxx}`、
`CTF2{c8...}` 同样进候选池，并按出现次数与来源数压过工具真正返回的值，横幅于是显示一个提交
不进去的假 Flag。叙述不是证据：它既不会被采纳，也不会触发下面的可疑提示。

**掩码一律拒收。** `isPlaceholder` 在原有词表（`flag`/`example`/`placeholder`/`redacted`/`todo`/
`your_flag`/`flag_here`/`changeme`）与 `redact`/`mask`/`hidden` 关键字之外新增两条：

- `MASK_MARK`：正文含 `...`、`…`、`**` 或三个以上连续 `x`。取 `x{3,}` 而非 `x{2,}`，因为 base64
  正文合法地可能出现两个 `x`；
- `MASK_WORD`：出现 `uuid`、`guid`、`frag`、`partial`、`truncat*`、`sample`、`dummy`、`tbd`、
  `unknown`、`missing` 等替身词，两侧按词段匹配，所以 `flag{fragment_of_the_flag}`、
  `CTF2{maxi_xx_service}` 这类真实值仍被保留。

**被拒的文本要看得见。** 拒收不等于静默丢弃：`/flag` 返回 `candidates`（最多 3 条，每条带
`occurrences`、`sources`、`placeholder`；artifacts 与会话两路按值合并去重、次数相加）与
`placeholder_suspect`（看到 flag 形状文本但一个都没采纳时为 `true`）。草稿据此渲染两种文案：

- 命中 Flag 但还有较弱的候选 → `- 其他候选：\`A\`、\`B\``，结论段加「另有 N 个候选」；
- 只看到掩码 → Flag 段写 `- 只扫描到疑似占位或截断的 flag 文本：\`A\`、\`B\``，结论段改成
  「本项目尚未记录到可信 Flag（只扫描到疑似占位或截断的文本）」；JSON 里对应
  `flag.alternatives` 与 `flag_suspects`。

UI 在没有 Flag 而 `placeholder_suspect` 为真时于页头下方显示琥珀色「FLAG 可疑」条并逐字列出原文
（不给复制按钮，避免把假值当答案提交），命中时绿色横幅标注「另有 N 个候选」。prompt 同步加一条
硬规则：草稿标注为疑似占位的文本不是已拿到的 Flag，要照实写「尚未拿到可确认的 Flag」，不得把
占位串当成答案，也不得自己拼出一个看起来完整的 Flag。

## 2. 模型撰写版

`renderProjectWriteupPrompt` 把整份草稿作为唯一素材交给模型，硬性要求写在 prompt 里：

- 全程简体中文（技术名词可保留英文）；
- 只使用草稿中出现的事实、证据路径与 Flag，不补充未记录的利用细节；
- 证据不足或未完成要如实写“未验证”“未完成”；
- Flag 逐字符照抄，不改写、不脱敏、不截断；
- 草稿的 Flag 段若标注“疑似占位或截断”，那些文本不是已拿到的 Flag：照实写“尚未拿到可确认的 Flag”，不得把占位串当成答案，也不得自己拼出一个看起来完整的 Flag（M21）；
- 载荷与 payload 同样逐字符照抄；草稿只给了路径或标注“未内联”时，只说附件包里有这个文件，不得虚构内容；
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
| 载荷条目 | 20（`MAX_WRITEUP_PAYLOADS`，超出置 `payloads_truncated`） |
| 载荷内联 | 单条 4000 字符、单项目 24000 字符、单文件读取窗口 128 KiB |
| 附件包条目 | 500 个文件（`MAX_ARCHIVE_FILES`），超出后余条记为「超出附件包上限」 |
| 附件包单文件 | 4 MiB（`MAX_ARCHIVE_FILE_BYTES`），同时是解引用后的读取上限 |
| 附件包总量 | 64 MiB（`MAX_ARCHIVE_TOTAL_BYTES`），在内存里一次成型，无 zip64 |
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
  "flag": {"value": "CTF{...}", "source": "artifacts/flag.txt", "occurrences": 1, "alternatives": []},
  "flag_suspects": [],
  "payloads": {"total": 2, "count": 1, "inlined": 1, "binary": 0, "unread": 0, "truncated": false,
               "files": [{"path": "explore-1a2b3c4d5e6f/forge.py", "size": 571,
                          "sha256": "…", "task_id": "explore-1a2b3c4d5e6f",
                          "language": "python", "state": "inline", "truncated": false,
                          "referenced_by": ["f003"]}]},
  "archive": {"available": true, "files": 139},
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
| `GET .../writeup/archive` | `200`，`application/zip`，`content-disposition: attachment; filename="writeup-<id>.zip"`（id 非法字符换成 `_`） |
| 附件包遇到未挂载 workspace | `409`，`workspace root is not mounted, so attachments cannot be read` |
| 附件包遇到未知项目 | `404`（与其它方法一样先构建草稿） |

JSON 视图的 `archive` 只回答「能不能下载、大概多少文件」：`available` 要求既挂载了
workspace root 又至少登记了一个工件，`files` 则是已登记工件的条数（未挂载时也照实上报，
便于排查）。它不预扫磁盘，真实打包结果以 zip 里的 `MANIFEST.md` 为准。

草稿是只读的，但与其它读取项目详情的端点一样会顺带让过期租约失效；只有 POST/DELETE
会写 `project_writeups`，不写图、不写旁路历史、不改变调度。

## 5. 静态 UI

侧栏「Writeup」页签（与其它运维页签一样按项目记在 `localStorage`）进入时请求 JSON 路由，
把正文原样放在 `<pre>` 里显示。标题行、状态摘要与操作条是**上下三段**，操作条自身
`flex-wrap`：把按钮和标题挤在同一行的 `justify-between` 里会在窄侧栏里把标题压成一列
竖排字符（M19b 修正）。可用操作：

- `刷新`：重新读取当前视图（草稿现算，模型版读存储行）；
- `复制`：把正文写入剪贴板；
- `下载 Markdown`：指向 `?format=markdown` 的同源下载，文件名固定为
  `writeup-<项目id>.md`（id 里的非法字符替换为 `_`），保存下来即带扩展名；
- `附件包 N`：GET `.../writeup/archive` 的同源下载，文件名 `writeup-<项目id>.zip`，按下时
  toast 汇报「已下载 …（N 个附件）」。`archive.available` 为假（没挂载 workspace 或一个
  工件都没登记）时整个按钮不出现，避免给出一包只有 `writeup.md` 的空附件包；悬停标题写明
  「打包 Writeup 与 N 个证据/载荷附件」；
- `AI 撰写`：POST 生成模型撰写版，生成期间按钮禁用并显示“撰写中…”；
- `恢复草稿`：仅在模型版下出现，DELETE 存储行后回到草稿。

正文卡片头部显示来源与规模（`控制面草稿 · N 字符 · 时间` 或
`撰写模型 <model> · N 字符 · 时间`）。失败给行内错误与重试，前端不自行拼接正文。
状态摘要的 Flag 一项按 §1.3 区分两种情形：`已记录 Flag（另有 N 个候选）` 与
`尚未记录 Flag（N 处疑似占位）`，后者对应草稿里的 `flag_suspects`。

## 6. 与报告的分工

`GET /projects/{id}/report` 是可分享的只读快照：不含工件路径、证据内容与 Flag。
Writeup 面向复盘，包含证据文件路径与 Flag 原文，因此写操作受 operator token 与同源
约束，也不做跨项目汇总。需要交接材料时先发报告，需要复现过程时发 Writeup。

## 7. 已知边界

- 草稿质量受图中数据限制：Fact 描述含糊或没有 `evidence_refs` 时，Writeup 只能照实
  呈现，不会替它补全利用细节。
- 载荷识别是命名与扩展名规则：worker 把载荷存成 `notes-2.txt` 这类名字时，它只会出现在
  附录与附件包里，不会进「载荷」章节。
- 工作区被 retention 清理或控制面没挂载 workspace 时，载荷条目仍在，但正文显示“内容未读取”。
- 附件包是单次请求内在内存里成型再整体发出的，不流式；上限见 §3，超大 pcap 之类只会以
  「单文件超过 N 字节」出现在清单的未打包表里。
- 清单的 sha256 列取自工件索引登记值，与正文附录同源同值；若文件在索引之后被改写，包内
  字节会与登记哈希不一致，这属于工作区被外部改动的信号，不是打包器的重算结果。
- 附件包与其余读取端点一样不设写守卫：GET 就能取走全部证据原文（含 Flag 命中文件与探测
  转储），安全边界仍然是「控制面只绑本机或受控网络」。需要对外交接时先发 `/report`。
- 没有 workspace root 时无法扫描 Flag。
- Flag 判定是启发式（§1.3）：worker 若把真实 Flag 缩写成 `CTF2{c8xxxx}` 存进工件，它会被当作
  掩码拒收，只在可疑条与 `flag_suspects` 里出现——宁可不显示，也不给一个提交不进去的值；反过来，
  一个恰好像十六进制的假值仍可能被采纳，最终结论以题目校验或人工提交为准。
- 模型撰写版按项目只存一份，后写覆盖前者；历史版本需要外部存档。
- 撰写调用不落 `runs`，因此它的 Token 与成本不出现在 `/stats` 与 `/cost` 里；需要核
  对时看模型提供方自己的用量面板。
