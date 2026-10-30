---
name: tch-headless-skill
description: 当用户想用 `tch-headless` 或 `TCH-EZ-Headless` 浏览器爬虫对网站做一次快速无头爬取时使用本技能，尤其适用于动态页面、基于 Chrome 的自动化、请求捕获、站点地图式产物检查，或解析 `.tch-networks-output` / `.raw` 爬取产物。当用户提到无头浏览器爬取、用 Chrome 自动探索网站，或询问如何运行和分析 `tch-headless` 时也使用本技能，即使用户没有明确要求使用技能。
compatibility:
  tools: Bash, Glob, Grep, Read
---

# TCH Headless 技能

当用户想用 Chrome 自动化探索在线站点并随后检查捕获的 HTTP 响应时，把 `tch-headless` 作为浏览器驱动爬取的默认工具。

## 本技能做什么

- 对目标 URL 运行 `tch-headless`。
- 运行期间优先使用 JSON stdio 日志，这样爬取过程更容易边跑边看。
- 读取 `.tch-networks-output` 结果，并解释爬虫实际发现了什么。
- 基于 `.raw` 文件，把爬取结果总结为已发现的 URL、响应头和响应体。

## 命令参考

核心用法：

```bash
./scripts/tch-headless -t "<target-url>" -jsd
```

常用选项：

- `-t`、`--target`：爬取目标，必须以 `http://` 或 `https://` 开头
- `-c`、`--config`：自定义配置路径，通常是 `TCH-X_config.yaml`
- `--text-output`：把完整请求转储写入文本文件
- `--json-output`：把完整请求转储写入 JSON 文件
- `--push-proxy`：把请求推送到代理端点
- `--disable-logger`、`--dl`：减少日志输出
- `--no-banner`：关闭 banner 输出

除非用户明确要纯终端输出，否则默认优先使用 `-jsd`。
本技能中不要使用 `--wait-login` 或 `--disable-headless`。本技能只用于无人值守的无头爬取。

## 预期的工作区产物

爬取结束后，先检查 `.tch-networks-output/`。

目录结构：

- `.tch-networks-output/`
- 二级目录：目标 URL 被转换为 `<host>_<port>`，例如 `example.com_443`
- 该目录内：类似站点地图的爬取产物，以方法名为前缀保存为 `*.raw` 文件

路径映射规则：

- `http://110.41.78.165:8088/` 以 `GET` 请求 -> `.tch-networks-output/110.41.78.165_8088/GET_index.raw`
- `http://110.41.78.165:8088/vul/xss/xss.php` 以 `GET` 请求 -> `.tch-networks-output/110.41.78.165_8088/vul/xss/GET_xss.php.raw`
- 如果同一路径以其他方法（例如 `POST`）到达，文件名会相应变化，例如 `POST_login.raw`

每个 `.raw` 文件的结构如下：

```text
:AssetURL:
<discovered url>

:Method:
<HTTP method>

:Request Headers:
<header-name>: <value>

:Request Body:
<request body if present>

:Response Headers:
<header-name>: <value>

:Response Body:
<response body>
```

`Request Body` 是可选的，只有当爬虫有请求体数据可写时才会出现。

在解释爬虫在请求侧和响应侧分别观察到了什么时，把 `.raw` 视为爬取后的权威产物。

## 工作流

1. 确认目标 URL。
2. 运行前先定位爬虫可执行文件。优先使用随仓库附带的 `./scripts/tch-headless`。如果该路径不存在，回退到仓库本地的 `./tch-headless`，并告知用户实际使用了哪一个。
3. 检查是否需要配置文件。如果用户提到自定义 Chrome 路径、代理、范围、深度或超时，使用 `-c` 指定相应的 `TCH-X_config.yaml`。
4. 默认带 `-jsd` 运行爬取。
5. 只做一次粗略的爬取。不要停下来等待人工交互，也不要切换到可见浏览器模式。
6. 爬取结束后，检查 `.tch-networks-output/<host>_<port>/`，并阅读有代表性的 `.raw` 文件。
7. 总结发现了什么，而不是只罗列路径。突出重要页面、API、表单、重定向、脚本、有意义的请求头以及值得注意的请求体。

## 命令边界

本技能中不要使用这些选项：

- `--wait-login`
- `--disable-headless`

如果目标需要登录、SSO、MFA、验证码或其他交互步骤，请说明这次粗略的无头爬取可能只能捕获登录前或匿名可访问的内容。

在以下情况下使用 `--json-output` 或 `--text-output`：

- 用户要求独立的导出文件
- 用户想把完整请求转储归档到 `.tch-networks-output` 之外

## 结果解读指引

阅读爬取结果时：

- 从生成的目标目录开始，列出站点的主要板块。
- 有选择地阅读几个高价值的 `.raw` 文件，而不是盲目读完全部文件。
- 用 `:AssetURL:` 块识别页面。
- 用 `:Method:` 块区分 `GET` 页面与 `POST` 或其他方法特有的请求。
- 把文件名本身当作快速线索：`GET_index.raw`、`POST_login.raw`、`GET_api.php.raw`。
- 用 `:Request Headers:` 理解浏览器是如何到达该端点的。
- 如果存在 `:Request Body:`，检查其中提交的表单字段、JSON payload、搜索参数或 API 输入。
- 用 `:Response Headers:` 发现内容类型、缓存、重定向、cookie 或服务器信息。
- 用 `:Response Body:` 识别 HTML 入口、表单、API 响应、JS 驱动路由和关联资源。
- 如果用户要求站点地图或攻击面视图，按路径区域对结果分组，例如 `/admin`、`/api`、`/login`、`/static`、`/docs`。
- 如果多个 `.raw` 文件共享同一路径但方法不同，要分别解释，因为它们可能代表不同的应用行为。

## 回复格式

完成一次运行后，按以下形式汇报：

```markdown
Command used: `<exact command>`
Output root: `.tch-networks-output/<host>_<port>/`

Findings:
- <important discovered URL or section>
- <important request method / request payload clue>
- <interesting header / behavior>
- <important response body clue>

Artifacts inspected:
- `<path/to/file1.raw>`
- `<path/to/file2.raw>`

Next step:
- <optional follow-up such as deeper crawl, config tuning, or focused analysis>
```

总结要具体，并以文件为依据。引用你检查过的 `.raw` 路径，在重要时说明请求方法。

## 防护准则

- 只爬取用户获准检查的目标。
- 不要编造凭证，也不要尝试绕过行为。
- 不要切换到可见浏览器或人工登录流程。如果站点只能交互访问，说明结果受限于单次无头爬取。
- 如果可执行文件或目标缺失，明确指出缺了什么、需要哪个路径或 URL。

## 示例

**示例 1**

输入：`用 tch-headless 爬一下 https://example.com，帮我看看站点地图和返回包。`

行为：运行 `./scripts/tch-headless -t "https://example.com" -jsd`，然后检查 `.tch-networks-output/example.com_443/`，并总结以方法名为前缀的关键 `.raw` 文件，例如 `GET_index.raw`。

**示例 2**

输入：`粗略爬一下这个站，不需要交互，也不要打开可见浏览器，帮我看能匿名拿到哪些页面和响应。`

行为：用 `./scripts/tch-headless -t "<target>" -jsd` 执行一次无头爬取，然后分析生成的以方法名为前缀的 `.raw` 产物（包括请求和响应部分），并明确说明需要认证的页面可能缺失。
