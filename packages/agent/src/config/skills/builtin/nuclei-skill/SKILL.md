---
name: nuclei-skill
description: 协助安全、务实地使用 ProjectDiscovery Nuclei 进行授权扫描。当用户想要运行 `nuclei`、选择模板、按标签或严重级别过滤、扫描单台主机或目标列表、验证或运行自定义模板、调整输出格式、使用带认证的扫描，或了解关键 CLI 参数时，使用本技能。当请求类似“给我写 nuclei 命令”“怎么扫一批 URL”“怎么只跑高危模板”“帮我用 nuclei 跑自定义模板”“nuclei 结果怎么导出 JSONL”以及类似的 Nuclei 使用问题时触发，即使用户没有明确提到技能。
---

# nuclei-skill

用本技能把一次 Nuclei 需求转化为可运行的命令、紧凑的工作流，或简短的排障答复。

回答要保持实用。用户通常是想扫点东西、收窄范围、导出结果，或者弄清楚某次运行为什么会那样表现。

Nuclei 是一款由 YAML 模板驱动的高性能扫描器，支持 HTTP、DNS、SSL、TCP、headless、JavaScript、file 以及 workflow 等多种协议。本技能应帮助用户为其任务选出最小且正确的命令。

## 安全边界

- 只协助授权测试、实验环境、演示、CTF、内部资产，或用户获准扫描的系统。
- 如果请求针对特定目标且授权情况不明确，先问一句简短澄清，再给出扫描命令。
- 不要帮助隐藏滥用性扫描。避免给出以规避、隐蔽或绕过第三方系统防御为主要目的的建议。
- 让指导与用户声明的范围和速率限制保持一致。

## 默认回复风格

与用户使用的语言保持一致。

对大多数请求，采用下面的结构：

### 推荐命令

先给出一条主要的 `nuclei` 命令。

### 为什么这样配置

简要说明关键参数，以及它们为何适合当前场景。

### 注意事项

提一到两条实用提醒，例如模板选择、输出格式、认证或速率限制。

### 可选的下一步

只有在存在明显后续动作时才添加，例如验证自定义模板、导出 JSONL 或更新模板。

保持简洁。宁可给一条有力的命令，也不要给一堆变体。

## 何时先提问

只有在下列信息缺失且会实质影响命令时，才问一个简短问题：

- 该扫描是否已获授权
- 输入是单个目标还是一个文件/列表
- 用户想要内置/社区模板、自定义模板，还是 workflow
- 是否需要认证
- 是否需要机器可读输出，例如 JSON、JSONL、Markdown 或 SARIF

如果提示已经足够清楚，就不要用额外问题拖慢用户。

## 核心工作流

按以下顺序执行。

1. 识别输入形态
- 单个目标：使用 `-u` 或 `-target`。
- 目标列表：使用 `-l` 或 `-list`。
- 结构化输入，例如 Burp/OpenAPI/Swagger/列表文件：当用户已有该格式时，使用 `-im` 并指定正确的模式。

2. 确定模板来源
- 默认/社区模板：使用 `-t`、`-tags`、`-severity`、`-type` 或 `-as`。
- 仅使用新模板：使用 `-nt` 或 `-ntv`。
- 自定义模板文件或目录：使用 `-t <path>`。
- Workflow：使用 `-w <path>`。
- 远程模板/workflow URL：如果用户明确想用远程资源，使用 `-turl` 或 `-wurl`。

3. 保持范围紧凑
- 优先用标签、严重级别、模板 id 或协议类型过滤，而不是“全都扫”。
- 如果用户拿不准，根据资产类型和他们真正想找的东西，建议一个收窄的默认方案。

4. 添加执行控制
- 当速率、并发或稳定性重要时，使用 `-rl`、`-c`、`-bs`、`-timeout` 和 `-retries`。
- 对带认证的扫描，视情况添加 `-H` 请求头或 `-sf` 密钥文件。
- 对重定向，在 `-fr`、`-fhr`、`-mr` 或 `-dr` 中选择。

5. 选择输出
- 快速检查时，人类可读的终端输出就够了。
- 当用户需要产物文件时，使用 `-json-export`、`-jsonl-export`、`-markdown-export` 或 `-sarif-export`。
- 使用 `-o` 输出普通文本文件。

6. 在相关时提到验证和更新
- 对自定义模板，建议在完整运行前先执行 `-validate`。
- 当模板缺失或过旧时，建议使用 `-ut`。

## 命令模式

### 单目标 Web 扫描

用于一个 URL 或主机。

```bash
nuclei -u https://target.example
```

如果用户想要更窄的运行范围，添加模板过滤器，而不是扫描整套模板。

示例：

```bash
nuclei -u https://target.example -tags cve,exposure -severity medium,high,critical
```

### 扫描目标列表

当用户已经把 URL 或主机放在文件里时使用。

```bash
nuclei -l targets.txt -severity high,critical -jsonl-export findings.jsonl
```

这是批量扫描的稳健默认选择，因为 JSONL 导出后续容易消费。

### 运行指定的模板目录或文件

当用户确切知道要运行哪些模板时使用。

```bash
nuclei -u https://target.example -t http/cves/ -t ssl/
```

或者针对本地自定义模板：

```bash
nuclei -u https://target.example -t /path/to/template.yaml
```

### 安全地运行自定义模板

鼓励先做验证。

```bash
nuclei -validate -t /path/to/template.yaml
```

然后运行它：

```bash
nuclei -u https://target.example -t /path/to/template.yaml
```

如果出现语法问题且用户明确想测试草稿，只把 `-nss` 作为调试辅助提及，不要当作默认做法。

### 按标签、严重级别、协议类型或模板 id 过滤

当用户想要控制范围但不想点名具体文件时使用。

```bash
nuclei -l targets.txt -tags exposure,tech -severity low,medium,high -pt http,ssl
```

常用过滤器：
- `-tags`：按主题或用例选择
- `-severity`：按影响程度收窄
- `-pt`：按协议类型收窄
- `-id`：运行精确的模板 id 或支持通配符匹配的 id
- `-etags`、`-exclude-severity`、`-exclude-id`、`-et`：移除嘈杂或不想要的模板

### 自动扫描模式

当用户想做一次快速 Web 扫描、又不知道该选哪些标签时使用。

```bash
nuclei -u https://target.example -as
```

说明 `-as` 会利用技术栈识别来映射相关标签。它很方便，但在聚焦的评估中不能替代精心挑选的模板。

### 带认证的扫描

当目标需要 cookie、bearer token 或自定义请求头时使用。

基于请求头的示例：

```bash
nuclei -u https://target.example -H 'Authorization: Bearer <token>' -H 'Cookie: session=<value>' -tags exposure
```

密钥文件示例：

```bash
nuclei -u https://target.example -sf secrets.yaml -ps
```

当用户需要反复做带认证的扫描，或希望命令历史更干净时，优先使用密钥文件。

### 重定向行为

当行为取决于重定向时使用。

```bash
nuclei -u https://target.example -fr -mr 5
```

或者如果重定向造成干扰：

```bash
nuclei -u https://target.example -dr
```

### 机器可读导出

当用户想与脚本、CI、仪表盘或审阅流程集成时使用。

```bash
nuclei -l targets.txt -severity medium,high,critical -jsonl-export nuclei-findings.jsonl
```

其他常见导出：
- `-json-export results.json`
- `-markdown-export report-dir/`
- `-sarif-export results.sarif`

如果用户只希望在终端输出中看到命中结果，可以提到 `-silent`。

### 调试难以理解的扫描

仅在用户正在主动排障时使用。

```bash
nuclei -u https://target.example -t /path/to/template.yaml -debug -vv -validate
```

有用的调试参数：
- `-debug`、`-dreq`、`-dresp`
- `-vv` 显示已加载的模板
- `-ms` 显示 matcher 状态
- `-svd` 在涉及模板逻辑时查看变量转储
- `-hc` 用于健康检查

正常使用中不要一上来就给调试参数。

### 更新引擎或模板

当结果看起来过时，或用户询问如何更新时使用。

```bash
nuclei -ut
```

引擎更新：

```bash
nuclei -up
```

如果用户在自定义目录中管理模板，添加 `-ud <dir>`。

## 速率与规模建议

Nuclei 很快。这很有用，但也意味着错误的默认值可能打得过猛。

- 对敏感的内部环境，建议调低 `-rl`、`-c` 或 `-bs`。
- 对不稳定的目标，提到 `-timeout`、`-retries` 和 `-mhe`。
- 对超大的输入集，优先使用文件输入、结构化输出和明确的模板过滤器。
- 如果用户问如何避免重复劳动，提到 `-project`，必要时加上 `-project-path`。

保守的批量命令示例：

```bash
nuclei -l targets.txt -tags cve -severity high,critical -rl 20 -c 10 -bs 10 -jsonl-export findings.jsonl
```

## 结果解读

当用户询问如何阅读结果时，简要解释：

- 模板 ID 和命中结果说明触发了什么。
- 严重级别有助于排优先级，但模板上下文仍然重要。
- 请求/响应存储是可选的，通过 `-sresp` 或 `-srd` 开启，有助于研判。
- JSONL 通常是便于后续解析的最佳导出格式。

如果用户问到如何在输出中包含原始请求/响应对，说明 JSON/JSONL/Markdown 的输出行为由原始输出相关参数控制，并且为了可移植性或隐私，省略原始数据往往更合适。

## 使用自定义模板

如果用户请求帮助编写 Nuclei 模板：

- 首先判断他们需要 HTTP、DNS、TCP、SSL、file、headless、JavaScript 还是 workflow 逻辑。
- 产出一个小巧的起步模板，而不是庞大的通用脚手架。
- 优先给出一条清晰的 matcher/extractor 路径，能明确证明检测逻辑。
- 告诉他们在扫描前先用 `nuclei -validate -t <template>` 验证。
- 如果他们只是要运行已有模板，不要跑题去教整套 DSL。

如果请求发展为深入的模板编写、语法参考或 workflow 设计，保持回答实用，并以最小可运行示例为中心。

## 排障经验法则

当 `nuclei` 表现异常时，按顺序检查以下各项：

1. 输入形态错误
- 目标格式不对
- 文件输入忘了 `-l`
- 本应使用 `-im burp`、`-im openapi` 或类似方式

2. 模板选择错误
- 标签或严重级别过滤器不对
- 忘了 `-headless`、`-code`、`-file` 或其他能力开关
- 模板路径错误

3. 缺少认证或请求上下文
- 缺少必需的请求头/cookie
- 密钥文件未加载
- 重定向需要 `-fr`，或应当禁用

4. 输出预期错误
- 用户想要 JSONL，但只启用了终端输出
- 用户需要存储响应，却没有使用 `-sresp`

5. 运行时压力过大
- 速率/并发过于激进
- 超时设得太低

在有帮助时，推荐一条最小诊断命令，而不是长篇理论解释。

## 该做与不该做

该做：
- 先给一条有力的命令
- 严格收窄模板范围
- 对自定义模板提到验证
- 当用户很可能稍后要解析结果时，提到结构化导出
- 在适当时候提到授权和速率意识

不该做：
- 编造参数或模板行为
- 在没有明确授权的情况下，建议扫描整个互联网或第三方公开资产
- 把 `nuclei -h` 的完整输出倾倒出来，除非用户明确要求列出所有参数
- 把简单的“扫一下这台主机”请求复杂化

## 简短示例

**示例 1**
输入：帮我写一个 nuclei 命令，扫 `targets.txt` 里所有站点，只看高危和严重，输出成 jsonl

输出：

```bash
nuclei -l targets.txt -severity high,critical -jsonl-export findings.jsonl
```

需要简要说明的理由：用 `-l` 做批量输入、严重级别过滤、JSONL 导出便于后续处理。

**示例 2**
输入：我有一个本地模板 `./templates/test.yaml`，想先检查模板语法再跑 `https://demo.test`

输出：

```bash
nuclei -validate -t ./templates/test.yaml
nuclei -u https://demo.test -t ./templates/test.yaml
```

需要简要说明的理由：先验证，再对单个目标运行。

**示例 3**
输入：`nuclei` 怎么只跑跟 exposure 相关的模板，并带上登录 Cookie？

输出：

```bash
nuclei -u https://target.example -tags exposure -H 'Cookie: session=<value>'
```

需要简要说明的理由：基于标签收窄范围，并加上认证请求头/cookie。
