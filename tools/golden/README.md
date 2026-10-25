# Golden 生成器

`generate.py` 用 Python Cairn 生成 TypeScript 实现的对照基准。它**只读取**上游源码，
把结果写到本仓库：

- `apps/cairn/src/http/testdata/api.golden.json`（固定时钟的 60 步 HTTP 序列）
- `packages/graph/testdata/export.golden.json`（YAML 与 timeline 原文）
- `packages/graph/testdata/scalars.golden.json`（61 条 PyYAML 标量用例）
- `apps/cairn/src/prompts/testdata/prompts.golden.json`（default/mock 各 5 个模板、渲染结果、
  JSON 格式化输出与必需 token 表）

## 准备（一次性）

```powershell
python -m venv tools/golden/.venv
tools/golden/.venv/Scripts/python.exe -m pip install "fastapi>=0.115" "httpx>=0.27" "pyyaml>=6.0"
```

POSIX 把 `Scripts/python.exe` 换成 `bin/python`。

## 生成

```powershell
$env:TZ='UTC'
tools/golden/.venv/Scripts/python.exe -I tools/golden/generate.py --cairn-root ..\Cairn-main
```

POSIX：

```bash
TZ=UTC tools/golden/.venv/bin/python -I tools/golden/generate.py --cairn-root ../Cairn-main
```

## 约束

- 必须用 `-I` 启动，并把 Cairn 路径作为参数传入；不要在 `Cairn-main/` 目录内运行解释器。
- `TZ=UTC` 必须与测试端一致（测试文件顶部设置 `process.env.TZ = "UTC"`）。
- 固定时钟从 `2026-01-02T03:04:05Z` 开始，每次 `utcnow()` 前进 60 秒。
- prompt golden 的 graph 引用路径使用固定 phase 与 UUID 片段（`...-0123456789ab`），
  避免每次生成都产生新路径。
- 只有确认 TypeScript 实现应跟随上游变化时才重新生成；提交时说明变化原因。
- `httpx` 的 StarletteDeprecationWarning 是上游依赖的提示，不影响输出。

生成后运行：

```bash
bun test
bun run typecheck
```
