# 第三方代码与许可证

本项目整体按 **AGPL-3.0** 分发（`LICENSE`）。以下上游项目的代码/语义会进入本仓库，分发时
必须保留相应的版权与许可声明。此文不是法律意见；对外分发前请按组织流程做法务确认。

## Cairn（`Cairn-main`）

- 许可证：GNU Affero General Public License v3.0（AGPL-3.0）。
- 使用方式：M1 已把 `cairn/src/cairn/server` 的领域语义移植为 TypeScript（见
  `docs/PORTING.md`），并原样复制了 `server/static/` 下的 Web UI 到
  `apps/cairn/src/http/static/`；M2a 又原样复制了
  `dispatcher/prompts/{default,mock}/*.md` 到 `apps/cairn/src/prompts/`，并按行为移植了
  `dispatcher/config.py` 与 `dispatcher/prompting.py`；M2b 按行为移植了
  `dispatcher/scheduler/**`、任务构造与 mock adapter（改写成确定性 fake solver），没有
  复制 Python 源码。
- 使用方式（对照数据）：`packages/graph/testdata/` 与 `apps/cairn/src/http/testdata/`
  的 golden 由运行 Python Cairn（含 PyYAML/FastAPI）生成，属于行为快照，不是源代码副本。
- 义务：合并作品整体按 AGPL-3.0 分发；通过网络提供服务时，向用户提供对应源码。保留原始
  版权与许可文本。

## BreachWeave（`BreachWeave-main`）

- 许可证：Apache License 2.0。
- 上游快照：`BreachWeave-main`（根包 `tch-agent` 0.0.1，`@tch/core` 0.0.1）。该目录没有
  版本库元数据，无法记录 commit；更新 vendor 时请同时更新本节。
- 已 vendor（M2c）到 `packages/agent/`：`packages/core/src/` 的配置、prompt、skills、
  solver 会话、runtime 与 challenge 模块。`packages/agent/LICENSE` 为其 Apache-2.0 原文。
- vendor 时的改动（均有记录）：
  - 在 `src/index.ts` 增加 `createSolverSession`、`initBuiltinPrompts`、
    `initBuiltinSkills`、`DEFAULT_CONFIG_DIR` 导出，供 worker 进程内调用；
  - `config/prompts/builtin/cairn-worker.md` 的 frontmatter 增加
    `model: "cairn-worker"`，用于选择 `model-prefs.json` 中的模型配置；
  - 删除 `*.test.ts`、`__tests__`，以及未使用的 `fuzz-dicts-skills`（约 50 MB）与
    `payloads-everything`（约 6 MB）两个内置 skill；
  - 用 `tools/vendor/generate-agent-assets.ts` 重新生成
    `config/builtin-assets.generated.ts`；
  - 新增 `index.d.ts` 作为类型边界，避免 vendor 代码进入本项目更严格的 `tsc` 检查；
  - M3 在 `solver/session.ts` 增加 Host Bridge 注入：从 `CAIRN_AGENT_CONFIG_DIR` 读取配置
    目录，并在 Solver 与 subagent 会话创建时动态导入 `CAIRN_HOST_BRIDGE_MODULE`，逻辑
    位于 `apps/cairn/src/host-bridge/`；
  - M4c 增加 Cairn Observer 适配（默认关闭）：新增
    `solver/extension/cairn-observer/`；`solver/board-store.ts` 支持
    `CAIRN_OBSERVER_BOARD_DIR`；`challenge-observer` 下的 `tools.ts`、`observer-store.ts`、
    `observer-agent.ts` 增加只读工具子集、可配置队列/状态根目录与可复用 system prompt；
    `solver/session.ts` 在非 challenge 模式下按 `CAIRN_OBSERVER_ENABLED` 选择 Cairn
    Observer；`index.d.ts` 增加 Observer handle。详见 `docs/OBSERVER.md`。
- 义务：保留 Apache-2.0 许可文本、文件头版权与（如有）NOTICE。Apache-2.0 代码可以并入
  AGPL-3.0 作品，但被并入的文件仍保留其 Apache 声明；整体分发按 AGPL-3.0。

## pi-mcp-adapter（`BreachWeave-main/packages/libs/pi-mcp-adapter`）

- 许可证：MIT（见 `packages/pi-mcp-adapter/LICENSE`）。
- 版本：2.2.2（BreachWeave 的本地副本；npm 上的 6.x 与之 API 不同，故按上游锁定）。
- 使用方式：原样复制运行时文件到 `packages/pi-mcp-adapter/`，由 `packages/agent` 以
  workspace 依赖引用。未修改源码。
- 义务：保留 MIT 许可与版权声明。

## 容器镜像（`Dockerfile.worker`）

- 基础镜像：`oven/bun:1.4`（Bun 为 MIT；镜像内 Debian 用户态组件的许可随镜像保留）。
- 构建时安装 `procps`（GPL-2.0-or-later，任务级 `pkill` 需要）与 `ca-certificates`
  （MPL-2.0，容器内 HTTPS 需要）。
- 镜像只包含本仓库代码与上述运行时包；不包含模型凭据、`auth.json` 或宿主机配置。

## Tailwind CSS（devDependency）

- 许可证：MIT（`node_modules/tailwindcss/LICENSE`，Copyright (c) Tailwind Labs, Inc.）。
- 使用方式：M27 起 UI 的样式由 Tailwind CLI 3.4.16 在生成期产出
  `apps/cairn/src/http/static/app.css`（`bun run ui:css`，配置在 `tools/ui/`），运行时分发的
  只有这份生成产物，不含上游源码。M10–M26 期间随 Cairn 静态 UI 一起复制进来的 Play CDN 副本
  `vendor/tailwindcss.js` 已删除。
- 义务：本项目不重新分发 Tailwind 源码，仅在 `node_modules` 中作为构建依赖存在；若对外分发
  包含 `node_modules` 的归档，需一并保留上述 MIT 许可文本。

## 本项目原创

`packages/contracts`、`apps/cairn` 的骨架、`runtime/`、`host-bridge/`、artifacts 索引、
`docs/` 与 `cairn-worker` 提示词为本项目原创，按 AGPL-3.0 分发。

## 当前并入范围

截至 M3：

- 已原样复制 Cairn 的静态 Web UI（`apps/cairn/src/http/static/`，AGPL-3.0）；其中
  `tailwindcss.js`（Play CDN 副本）自 M27 起删除，样式改由本项目用 Tailwind CLI 生成的
  `app.css` 代替；
- 已原样复制 Cairn 的 default/mock prompt 模板（`apps/cairn/src/prompts/`，AGPL-3.0）；
- 已按行为移植 Cairn 的服务端、config、prompting、scheduler、runtime 与 worker 语义，
  并提交由 Python 版生成的 golden；
- 已 vendor BreachWeave core 到 `packages/agent/`（Apache-2.0，含上述改动）；
- 已 vendor `pi-mcp-adapter` 2.2.2 到 `packages/pi-mcp-adapter/`（MIT，未修改）；
- Host Bridge、容器 runtime 与 artifacts 索引为原创实现，不含新的第三方源码。
