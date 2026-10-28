# 模型与密钥操作手册（M18d/M16b）

面向需要给 Cairn 接入真实模型的运维者：从空配置走到“默认 worker 模型可用”，再到用
第二个模型跑通 M16b 的真实 A/B。界面入口是页头 CPU 图标的“模型与密钥”弹窗；纯 HTTP
部署使用同一组 `/settings/agent` 路由。所有写操作都是操作员动作，不构成身份审计。

## 1. 前置

- 配置目录按 `--config` 的 `common_env.CAIRN_AGENT_CONFIG_DIR` → 进程环境变量
  `CAIRN_AGENT_CONFIG_DIR` → `~/.tch-agent/config` 解析。`cairn serve` 不带 `--config`
  时只看后两者，纯 HTTP 模式同样可用。
- 设置 `CAIRN_OPERATOR_TOKEN` 后，所有写路由要求 `X-Cairn-Operator-Token`；GET 保持
  开放。未设置时沿用本地单用户行为。跨源浏览器写请求一律 403。
- 密钥只写不读：任何响应只返回掩码（`sk-...123456`）或 header 名称。真实值只落在
  `auth.json` 与 SDK 要求的 `models.json` 副本里。

## 2. 五步接入

1. **建 provider**：内置名（如 `anthropic`、`openai`、`openrouter`）可只填名称与密钥，
   协议与 Base URL 自动继承；自定义 provider 必须同时给 `api` 与 `baseUrl`。可选
   `headers` 用于租户/网关鉴权，同样只写。留空密钥表示不修改，`null` 表示清除。
2. **拉模型**：内置且未填 `baseUrl` 的 provider 返回离线目录，不访问网络；其余情况
   调用 `<baseUrl>/models`，要求先保存密钥。拉取结果只是候选项，不自动创建模型条目。
   不提供 `/models` 的网关（例如某些 OpenAI 兼容转发路径）会让这一步返回
   `model discovery failed`，此时直接手填上游真实模型名，再用第 5 步的“测试”验证。
3. **加模型**：`modelId` 是上游真实模型名；可选短 `id` 作为本地引用名。高级字段：
   `thinkingLevel`（minimal/low/medium/high/xhigh）、`reasoning`、`input`（text/image）、
   `cost`（input/output/cacheRead/cacheWrite）、`contextWindow`、`maxTokens`、模型级
   `headers` 与 `compat`。
4. **设为默认**：把当前条目复制为 `cairn-worker`，`cairn-worker.md` 的
   `model: "cairn-worker"` 始终指向这份副本。`worker_profiles` 仍可按任务覆盖模型。
5. **测试**：对目标条目真实调用一次模型。未保存密钥时返回可读提示而不是 SDK 文件路径
   错误；失败文本会先替换真实密钥再遮蔽常见凭据形态。模型行与 Provider 卡片都有入口：
   Provider 级会优先测试该 provider 的 `cairn-worker` 默认条目（否则第一条），并在结果
   里标明实际测试的模型；该 provider 还没有模型条目时直接提示，不会调用上游。服务端
   60 秒未返回就报 `connectivity test timed out after 60s`，不会无限挂起。

## 3. HTTP 速查

```bash
BASE=http://127.0.0.1:8000
# 仅在设置 CAIRN_OPERATOR_TOKEN 时需要：
H='X-Cairn-Operator-Token: <operator-token>'

curl -s "$BASE/settings/agent"
curl -s -X POST "$BASE/settings/agent/providers" -H 'content-type: application/json' -H "$H" \
  -d '{"name":"anthropic","apiKey":"<api-key>"}'
curl -s -X POST "$BASE/settings/agent/providers/<provider-id>/discover" -H "$H"
curl -s -X POST "$BASE/settings/agent/models" -H 'content-type: application/json' -H "$H" \
  -d '{"providerId":"<provider-id>","modelId":"<upstream-model>"}'
curl -s -X PUT "$BASE/settings/agent/default-model" -H 'content-type: application/json' -H "$H" \
  -d '{"modelPrefId":"<model-pref-id>"}'
curl -s -X POST "$BASE/settings/agent/models/<model-pref-id>/test" -H "$H"
curl -s -X POST "$BASE/settings/agent/providers/<provider-id>/test" -H "$H"
```

把含密钥的请求体先写进权限 600 的临时文件、用 `--data @file` 提交，避免留在 shell
历史里；用完删除。路由与字段见 README“通过 API 与 UI 管理模型与密钥”。

## 4. 文件落点

| 文件 | 内容 | 是否含密钥 |
| --- | --- | --- |
| `provider-prefs.json` | provider 名称、协议、Base URL | 否（header 值也不落盘） |
| `model-prefs.json` | 模型引用名、provider 绑定、模型参数 | 否 |
| `auth.json` | provider 凭据（`provider:<id>`） | 是，权限应仅限本人 |
| `models.json` | SDK 运行时 provider 副本与模型定义 | 是（SDK 按 provider 读取 `apiKey`） |

经 API 写入的密钥会同步到 `auth.json` 与 `models.json` 两处；清除时两侧一起删除。若
要求磁盘不出现明文，请手工把 `models.json` 的 `apiKey` 改为环境变量名（如
`CAIRN_MODEL_API_KEY`），API 不做这种转换。这些文件不属于仓库，也不要写进 `task.json`。

## 5. 常见错误

| 现象 | 处理 |
| --- | --- |
| `baseUrl is required for a custom provider` / `api is required when baseUrl is set` | 自定义 provider 两项都必须给；内置名可省略 |
| `unsupported api: ...` | 只接受 `GET /settings/agent` 返回的 `protocols` |
| 400 提到 URL 非法或内嵌凭据 | Base URL 必须是 http(s)，且不能带 `user:pass@` |
| `API key is required before discovering models` | 先保存 provider 密钥再拉取 |
| 测试返回 `provider has no API key; save one before testing` | 保存密钥后重试；这不是网络错误 |
| `connectivity test timed out after 60s` | 上游 60 秒内没有响应；检查 Base URL、代理与网关负载 |
| Provider 测试返回 `provider has no model config` | 先在该 provider 下添加模型条目；Provider 测试按默认/首条模型执行 |
| 401 / 403 | 写请求缺 operator token，或 Origin 与请求 host 不一致 |
| 409 删除被拒 | 条目仍被模型/`worker_profiles`/Observer/prompt 默认引用；确认后加 `?force=true` |
| `model discovery failed: ...` | 上游不可达或返回形状不符；错误已脱敏，检查 Base URL 与协议 |
| 网关返回 `MODEL_NOT_SUPPORTED` | 模型名不被该网关提供；用发现结果或更换模型 |
| 设为默认后任务仍用旧模型 | `worker_profiles` 的任务级覆盖优先于 `cairn-worker` |

## 6. 临时目录演练

不碰真实配置的完整走查：

```bash
DEMO=$(mktemp -d)
CAIRN_AGENT_CONFIG_DIR="$DEMO/agent" bun run cairn serve --port 8017 --db-path "$DEMO/cairn.db"
```

打开 `http://127.0.0.1:8017`，依次建 provider、拉模型、加模型、设为默认、测试。模型行
的“测试”和 Provider 卡片的“测试连通性”都应给出结果（后者会显示实际测试的模型）。用
占位密钥时“测试”应返回鉴权错误——这证明链路已通，只是上游拒绝。停止服务后删除 `$DEMO`。
同一序列的离线版本由 `apps/cairn/src/http/agent-config.flow.test.ts` 覆盖（空配置 →
provider/密钥 → 模型 → 默认 → 文件校验 → 强制删除），纳入 `bun test`。

## 7. M16b：两个模型的真实 A/B

真实 A/B 需要两个不同 model-prefs 条目解析到不同 provider/model，且两侧凭据可用：

1. 用第 2 节的流程添加第二个 provider 与模型（不要覆盖现有默认条目）。同一个网关换
   协议路径时可以复用同一把密钥：从配置目录取出已存的密钥值再 POST 给新 provider（密钥
   只写不读，不要打印，也不要留在 shell 历史里），然后只加模型条目、不动 `cairn-worker`。
   下面的示例用 `gw-deepseek` / `gw-zhipu` 指代两个 provider；真实的 provider 名与网关
   主机名只留在本机配置目录，不写进公共仓库。
2. `GET /settings/agent` 确认两个条目的 `id`，且 `modelId`/`provider` 不同。
3. 对新条目先跑一次“测试”（`POST /settings/agent/models/<pref-id>/test`）确认上游接受
   该模型名，再运行 gate（会产生模型费用）：

```bash
CAIRN_AB_MODEL_A=cairn-worker CAIRN_AB_MODEL_B=zhipu-glm-flash \
  CAIRN_AB_TASKS=2 bun run tools/gate/m16-model-ab.ts
```

gate 在条目缺失、相同或解析到同一模型时退出 2；跑完要求两侧 `run.model` 不重叠、任务
数相同，报告写到 `runs/m16-model-ab.json`。只想比较记账时可用
`CAIRN_GATE_PROFILE_B_MODEL=<second-pref>` 跑 `tools/gate/m15e-calibration.ts`。

已跑通的一次（2026-10-28，`CAIRN_AB_TASKS=2`，两侧同一网关的不同协议路径）：

| arm | model-pref | provider/model | runs | success | tokens | 墙钟 |
| --- | --- | --- | --- | --- | --- | --- |
| A | `cairn-worker` | `gw-deepseek/deepseek-flash` | 2 | 2 | 74,227 | 29.5 s |
| B | `zhipu-glm-flash` | `gw-zhipu/GLM-5.3-Flash` | 2 | 2 | 75,141 | 150.9 s |

12 项检查全部通过、`passed: true`，两侧观测到的模型集合不重叠（A 只有
`provider:gw-deepseek/deepseek-flash`，B 只有 `provider:gw-zhipu/GLM-5.3-Flash`）。
该网关不上报成本，两侧 `cost_usd` 都是 0，因此只能比较 Token 与耗时：这个样本里
Token 相差 914（1.2%），B 的墙钟是 A 的 5.1 倍。

两条限制要记住：一次 2 任务的样本只证明链路可用与量级差异，不足以判定哪个模型更好；
`outcome=success` 表示 worker 的返回值被接受并写入图，不代表 marker 值被逐字符记录，
要判定任务质量仍需回看该项目的事实与证据。凭据只放在配置目录或进程环境，不要提交到仓库。

## 8. 安全边界

- API 默认无身份认证；绑定非回环地址时请加网络层访问控制，并设置 operator token 限制写。
- 掩码与错误脱敏降低泄露面，但不等于加密；`models.json` 的明文副本需靠文件权限保护。
- 删除/强制删除是不可逆操作；`?force=true` 会级联删除模型条目，先确认引用方。
- 向公共远端推送前检查跟踪文件，确保没有把配置目录、报告或密钥误加进仓库。
