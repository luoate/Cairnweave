---
name: ffuf-skill
description: 协助使用 ffuf 对 Web 参数进行模糊测试。当用户想用 ffuf 对 Web 请求路径、查询参数、请求头、POST 请求体、JSON 字段或原始 HTTP 请求进行 fuzz，或者询问 ffuf 命令、字典选择、误报过滤、matcher/filter 调优，以及如何把命中结果重放到 Burp/ZAP 时，使用本技能。
---

# ffuf-skill

用本技能把一个 Web 模糊测试目标变成可用的 `ffuf` 命令，而不是一大篇理论。

聚焦以下请求位置：
- URL 路径片段
- 查询参数名
- 查询参数值
- 请求头名或值
- 表单请求体字段
- JSON 请求体字段
- 含一个或多个 `FUZZ` 标记的原始 HTTP 请求文件

不要偏离到无关的攻击性指导。把帮助限定在授权测试和用户声明的目标范围内。

## 安全边界

- 只协助授权测试、实验环境、演示或用户自有的系统。
- 如果授权不明确，在给出针对具体目标的命令前，先问一句简短澄清。
- 用户没有说明时，不要假定目标已获授权。

## 默认回复风格

与用户使用的语言保持一致。

对大多数请求，按下面的结构组织回答：

### 推荐命令

先给出一条主要的 `ffuf` 命令。如果有意义明确的变体，再在其后给出一条备选命令。

### 为什么这样配置

简要说明关键参数：
- fuzz 位置
- 所选字典
- 请求方法/请求体/请求头
- 为什么所选的 matcher/filter 是合理的起点

### 降低噪声的建议

说明在当前场景下如何减少误报。

### 该关注什么

告诉用户哪些结果差异通常有意义，例如：
- 状态码变化
- 响应长度不同
- 单词数或行数不同
- 响应体或响应头中出现正则命中
- 异常的响应时间

解释保持简洁。用户要的是能直接跑起来的东西。

如果提示缺少一项关键细节，先问一个简短问题。好的例子：
- 应该 fuzz 哪个请求位置
- 用户是否已有原始请求文件
- 应该过滤掉哪条基线响应

如果请求已经足够清楚，就不要停下来问额外问题。

## 本地字典

`dicts/` 是本技能使用的本地字典目录。

使用方法：
- 生成命令时，优先使用 `ffuf-skill/dicts/` 中的字典。
- 不要假定已安装 `SecLists` 或其他外部字典。
- 如果用户没有指定字典，根据 fuzz 目标推荐 `dicts/` 中可能合适的文件。
- 如果 `dicts/` 中还没有合适的文件，说明需要哪一类字典，例如参数名、请求头、JSON 键、路径或 payload 值。

字典清单占位：

| 文件 | 用途 | 典型用法 | 备注 |
| --- | --- | --- | --- |

本目录建议的字典分类：
- `params.txt`：常见查询参数或表单参数名
- `json-fields.txt`：常见 JSON 字段名
- `header-names.txt`：常见请求头名
- `header-values.txt`：请求头 payload 或候选值
- `paths.txt`：常见目录、接口或文件名
- `values.txt`：常见 ID、角色、标志位或 payload 值

## 核心工作流

按以下顺序执行。

1. 识别 fuzz 点
- 判断用户想 fuzz 的是路径、查询键、查询值、请求头、表单字段、JSON 字段，还是原始请求。
- 如果提示中已包含请求样例，复用它的方法、请求头和请求体结构。

2. 选择请求格式
- 简单的路径或查询 fuzz，优先用 `-u`。
- 当用户已有来自 Burp 或其他代理的原始 HTTP 请求时，优先用 `-request <file>`。
- 当内联重建请求仍然简单时，使用 `-X`、`-H` 和 `-d`。
- 当用户已有真实的带认证请求时，优先用 `-request`，以保持 cookie、token 和特殊请求头完整。

3. 选择字典
- 参数名 fuzz：选择参数名或 API 字段字典。
- 请求头 fuzz：选择请求头名字典或值 payload 字典。
- JSON 或表单值 fuzz：选择 payload 或候选值。
- 路径 fuzz：选择路径、文件或接口字典。

4. 添加起始 matcher 或 filter
- 从简单开始。
- 如果应用返回多种状态码，先用 `-mc`。
- 如果应用对一切请求都返回同一状态码，先用 `-mc all` 加上 `-fs`、`-fw` 或 `-fl`。
- 只有在有明确理由时才使用正则或时间差。

5. 告诉用户如何验证命中
- 当人工检查重要时，建议用 `-replay-proxy` 把可疑命中重放到 Burp/ZAP。
- 指出哪些差异更像信号，哪些只是背景噪声。

6. 宁可给一条最佳命令，也不要给一堆平庸命令
- 先给一条默认命令。
- 只有在存在真正取舍时才加一条备选，例如 `-request` 与内联重建之间，或 `-fs` 与 `-fw` 之间。
- 除非用户要求对比，否则不要倒出五个变体。

## 命令模式

### 路径 fuzz

当未知部分是 URL 路径中的目录、接口或文件名时使用。

示例：

```bash
ffuf -w ffuf-skill/dicts/paths.txt -u 'https://target.example/FUZZ' -mc all -fs 1234
```

### 查询参数名 fuzz

当应用可能接受未文档化的 GET 参数名时使用。

当用户说“fuzz 一下这个请求参数”却只给了一个 URL 时，这是最有价值的默认做法之一。

示例：

```bash
ffuf -w ffuf-skill/dicts/params.txt -u 'https://target.example/search?FUZZ=test' -mc all -fs 4242
```

### 查询参数值 fuzz

当参数名已知、真正有意思的是它的值时使用。

示例：

```bash
ffuf -w ffuf-skill/dicts/values.txt -u 'https://target.example/api/items?id=FUZZ' -mc all -fw 87
```

### 请求头 fuzz

当请求头名或值可能改变应用行为时使用。

典型场景：
- 与 IP 相关的请求头，例如 `X-Forwarded-For`
- 缓存或路由请求头
- 功能开关或调试请求头
- 应用自定义请求头

请求头值 fuzz 示例：

```bash
ffuf -w ffuf-skill/dicts/header-values.txt -u 'https://target.example/profile' -H 'X-Forwarded-For: FUZZ' -mc all -fl 52
```

请求头名 fuzz 示例：

```bash
ffuf -w ffuf-skill/dicts/header-names.txt -u 'https://target.example/profile' -H 'FUZZ: 127.0.0.1' -mc all -fl 52
```

### 表单请求体 fuzz

当请求体是表单编码时使用。

示例：

```bash
ffuf -w ffuf-skill/dicts/form-fields.txt -u 'https://target.example/login' -X POST -H 'Content-Type: application/x-www-form-urlencoded' -d 'FUZZ=test' -mc all -fs 3010
```

### JSON 请求体 fuzz

当请求体是 JSON 时使用。记得保留 `Content-Type: application/json`。

字段值 fuzz 示例：

```bash
ffuf -w ffuf-skill/dicts/json-values.txt -u 'https://target.example/api/user' -X POST -H 'Content-Type: application/json' -d '{"role":"FUZZ"}' -mc all -fw 91
```

字段名 fuzz 示例：

```bash
ffuf -w ffuf-skill/dicts/json-fields.txt -u 'https://target.example/api/user' -X POST -H 'Content-Type: application/json' -d '{"FUZZ":"test"}' -mc all -fw 91
```

### 原始请求 fuzz

当用户已有在 Burp 中捕获的完整请求，或希望在不内联重建请求的情况下 fuzz 多个自定义请求头/请求体字段时，使用 `-request`。

示例：

```bash
ffuf -w ffuf-skill/dicts/params.txt -request request.txt -mc all -fs 4242
```

如果请求是普通 HTTP 而非 HTTPS，添加 `-request-proto http`。

## Matcher 与 filter

本技能最关键的部分，是为“信号与噪声”选一个合理的起点。

### 好的默认选择

- 当有意义的响应已经能靠状态码区分时，使用 `-mc`。
- 当应用把行为藏在统一状态码后面时，使用 `-mc all`。
- 然后用以下之一过滤已知基线：
  - `-fs` 按响应大小
  - `-fw` 按单词数
  - `-fl` 按行数

### 何时优先用哪种控制

- 当应用稳定、返回的响应体几乎完全一致时，优先用 `-fs`。
- 当内容长度因用户输入回显而轻微变化时，优先用 `-fw`。
- 当页面模板稳定但单词数变化过大时，优先用 `-fl`。
- 当用户关心特定字符串或请求头模式时，使用 `-mr` 或 `-fr`。
- 只有在延迟本身就是信号时，才用 `-mt` 或 `-ft` 做时间差判断。

### 基线优先的习惯

如果应用行为不清楚，告诉用户先发一两次已知失败的请求，记录常见响应特征：
- 状态码
- 大小
- 单词数
- 行数

然后围绕该基线构建第一个 filter，而不是凭感觉猜。

在有帮助时，明确告诉用户：
- 如果状态码统一，先用 `-mc all`
- 如果响应体长度稳定，试试 `-fs`
- 如果输入回显导致长度轻微变化，试试 `-fw`
- 如果只有某个特定标记重要，使用 `-mr`

## 多字典用法

只有当用户明确需要时才引入多字典。

- `clusterbomb` 会尝试所有组合，规模增长极快。
- `pitchfork` 让多个字典同步推进，适合成对数据。

对普通的 Web 参数 fuzz，一个字典通常就是正确的默认选择。

## 重放与输出

- 当用户想把有希望的命中送到 Burp 或 ZAP 人工审查时，使用 `-replay-proxy http://127.0.0.1:8080`。
- 当用户想要便于后续处理的结构化输出时，使用 `-o <file> -of json`。
- 当用户在自动化中需要机器可读的 stdout 时，使用 `-json`。

## 反模式

避免这些常见错误：
- JSON 请求体 fuzz 时忘记 `Content-Type: application/json`
- 明明 `-request` 能安全保留复杂的带认证请求，却去内联重建它
- 在建立基线之前就叠加过多 filter
- 假定每个有价值的命中都会使用不同的状态码
- 对简单的单参数 fuzz 推荐多字典模式

## 何时查阅参考资料

在以下情况下阅读 `references/ffuf-web-params.md`：
- 你需要更密集的参数速查表
- 你需要更多示例模板
- 你需要快速回顾 matcher/filter 的取舍
- 用户询问 ffuf 配置或 scraper 相关功能

## 本技能应能很好处理的示例提示

- `帮我写一个 ffuf 命令，fuzz 这个 GET 请求里可能存在的隐藏参数名。`
- `我有个 Burp 导出的 request.txt，想 fuzz JSON body 里的字段名。`
- `这个站所有响应都是 200，我该怎么用 ffuf 过滤误报？`
- `我想 fuzz X-Forwarded-For 头的值，并把命中的请求转发到 Burp。`
- `帮我根据这个 POST 请求写 ffuf，目标是 fuzz form body 里的字段名。`
- `这个 API 返回长度会变，状态码没区别，ffuf 应该先用 fs 还是 fw？`
