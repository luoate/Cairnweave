/**
 * Chinese project writeup (M19a).
 *
 * A writeup is a narrative view of data the control plane already stores: the project
 * header, the authorized scope, the origin/goal pair, the intent→fact chain that produced
 * the current findings, superseded judgements, hints, the captured flag, the verification
 * outcome and the run statistics. This module only reads; rendering the snapshot into
 * Chinese Markdown adds no graph semantics.
 *
 * The Markdown draft doubles as the input for the model-written variant: the HTTP layer
 * asks a model to rewrite the draft as prose and stores the result in `project_writeups`,
 * so a project without model credentials still has a complete Chinese writeup.
 */

import type { Database } from "bun:sqlite";

import { listProjectArtifacts } from "./artifacts";
import { getProjectDetail, getProjectScope } from "./commands";
import { all, get, run } from "./db";
import type { FactSupersession, Hint, VerificationKind } from "./models";
import { buildProjectRunStats } from "./stats";
import { listFactSupersessions } from "./supersedes";
import { utcnow } from "./services";
import { summarizeProjectVerification } from "./verification";

const MAX_WRITEUP_ARTIFACTS = 200;

export interface WriteupFlag {
  value: string;
  source: string;
}

export interface BuildProjectWriteupOptions {
  /** Captured flag plus the file it was read from. */
  flag?: WriteupFlag | null;
  /** Injectable clock for deterministic rendering. */
  generatedAt?: string;
  /** Policy reported for legacy projects without a `project_verification` row. */
  verificationFallback?: VerificationKind;
}

export interface WriteupStep {
  intent_id: string;
  description: string;
  from: string[];
  fact_id: string | null;
  fact_description: string | null;
  run_id: string | null;
  worker: string | null;
  model: string | null;
  outcome: string | null;
  evidence: string[];
  created_at: string;
}

export interface WriteupFinding {
  id: string;
  description: string;
  evidence: string[];
}


export interface WriteupArtifact {
  path: string;
  size: number;
  sha256: string;
  task_id: string;
}

export interface ProjectWriteupSnapshot {
  generated_at: string;
  project: {
    id: string;
    title: string;
    status: string;
    created_at: string;
    challenge_code: string | null;
    targets: string[];
    scope_notes: string | null;
  };
  origin: string | null;
  goal: string | null;
  steps: WriteupStep[];
  open_intents: { id: string; description: string }[];
  /** Every current fact except origin/goal and superseded ones. */
  findings: WriteupFinding[];
  supersessions: FactSupersession[];
  hints: Hint[];
  flag: WriteupFlag | null;
  verification: {
    kind: VerificationKind;
    checks: {
      total: number;
      passed: number;
      failed: number;
      last_checked_at: string | null;
    };
    latest: {
      ok: boolean;
      detail: string;
      flag_count: number | null;
      flag_got_count: number | null;
      checked_at: string;
    } | null;
  };
  runs: {
    runs: number;
    finished: number;
    succeeded: number;
    failed: number;
    tokens: number;
    cost_usd: number;
    by_worker: { worker: string; runs: number; succeeded: number; tokens: number }[];
    by_model: { model: string | null; runs: number; succeeded: number; tokens: number }[];
  };
  artifacts: WriteupArtifact[];
  artifacts_truncated: boolean;
}

interface FactMetaRow {
  fact_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
}

export function buildProjectWriteup(
  conn: Database,
  projectId: string,
  options: BuildProjectWriteupOptions = {},
): ProjectWriteupSnapshot {
  const detail = getProjectDetail(conn, projectId);
  const scope = getProjectScope(conn, projectId);
  const supersessions = listFactSupersessions(conn, projectId);
  const superseded = new Set(supersessions.map((edge) => edge.fact_id));
  const factById = new Map(detail.facts.map((fact) => [fact.id, fact]));
  const stats = buildProjectRunStats(conn, projectId);
  const verification = summarizeProjectVerification(
    conn,
    projectId,
    options.verificationFallback,
  );

  const metaRows = all<FactMetaRow>(
    conn,
    "SELECT fact_id, run_id, evidence_refs, evidence_status FROM fact_meta WHERE project_id = ?",
    projectId,
  );
  const evidenceByFact = new Map<string, string[]>();
  const runByFact = new Map<string, string | null>();
  for (const row of metaRows) {
    runByFact.set(row.fact_id, row.run_id);
    evidenceByFact.set(row.fact_id, parseRefs(row.evidence_refs));
  }
  const runRows = new Map<string, LiteRunRow>();
  for (const entry of listRunsLite(conn, projectId)) runRows.set(entry.id, entry);

  const concluded = detail.intents
    .filter((intent) => intent.to !== null)
    .sort((left, right) => {
      const byTime = left.created_at.localeCompare(right.created_at);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    });

  const steps: WriteupStep[] = concluded.map((intent) => {
    const factId = intent.to;
    const runId = factId === null ? null : runByFact.get(factId) ?? null;
    const run = runId === null ? undefined : runRows.get(runId);
    return {
      intent_id: intent.id,
      description: intent.description,
      from: intent.from,
      fact_id: factId,
      fact_description: factId === null ? null : factById.get(factId)?.description ?? null,
      run_id: runId,
      worker: run?.worker ?? intent.worker,
      model: run?.model ?? null,
      outcome: run?.outcome ?? null,
      evidence: factId === null ? [] : evidenceByFact.get(factId) ?? [],
      created_at: intent.created_at,
    };
  });

  const findings = detail.facts
    .filter(
      (fact) =>
        fact.id !== "origin" &&
        fact.id !== "goal" &&
        !superseded.has(fact.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((fact) => ({
      id: fact.id,
      description: fact.description,
      evidence: evidenceByFact.get(fact.id) ?? [],
    }));

  const artifacts = listProjectArtifacts(conn, projectId);

  return {
    generated_at: options.generatedAt ?? utcnow(),
    project: {
      id: detail.project.id,
      title: detail.project.title,
      status: detail.project.status,
      created_at: detail.project.created_at,
      challenge_code: verification.policy.challenge_code,
      targets: scope?.targets ?? [],
      scope_notes: scope?.notes ?? null,
    },
    origin: factById.get("origin")?.description ?? null,
    goal: factById.get("goal")?.description ?? null,
    steps,
    open_intents: detail.intents
      .filter((intent) => intent.to === null)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((intent) => ({ id: intent.id, description: intent.description })),
    findings,
    supersessions,
    hints: [...detail.hints].sort((left, right) => {
      const byTime = left.created_at.localeCompare(right.created_at);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    }),
    flag: options.flag ?? null,
    verification: {
      kind: verification.policy.kind,
      checks: verification.checks,
      latest:
        verification.latest === null
          ? null
          : {
              ok: verification.latest.ok,
              detail: verification.latest.detail,
              flag_count: verification.latest.flag_count,
              flag_got_count: verification.latest.flag_got_count,
              checked_at: verification.latest.checked_at,
            },
    },
    runs: {
      runs: stats.totals.runs,
      finished: stats.totals.finished,
      succeeded: stats.totals.succeeded,
      failed: stats.totals.failed,
      tokens: stats.totals.tokens,
      cost_usd: stats.totals.cost_usd,
      by_worker: stats.by_worker.map((group) => ({
        worker: group.worker,
        runs: group.runs,
        succeeded: group.succeeded,
        tokens: group.tokens,
      })),
      by_model: stats.by_model.map((group) => ({
        model: group.model,
        runs: group.runs,
        succeeded: group.succeeded,
        tokens: group.tokens,
      })),
    },
    artifacts: artifacts
      .slice(0, MAX_WRITEUP_ARTIFACTS)
      .map((artifact) => ({
        path: artifact.path,
        size: artifact.size,
        sha256: artifact.sha256,
        task_id: artifact.task_id,
      })),
    artifacts_truncated: artifacts.length > MAX_WRITEUP_ARTIFACTS,
  };
}

/** Draft Chinese Markdown, used directly when no model-written writeup exists. */
export function renderProjectWriteupMarkdown(snapshot: ProjectWriteupSnapshot): string {
  const lines: string[] = [];
  const push = (...values: string[]): void => {
    lines.push(...values);
  };

  push(`# Writeup：${inline(snapshot.project.title) || snapshot.project.id}`, "");
  push(`- 项目：\`${snapshot.project.id}\``);
  push(`- 状态：${snapshot.project.status}`);
  push(`- 创建时间：${snapshot.project.created_at}`);
  push(`- 生成时间：${snapshot.generated_at}`);
  if (snapshot.project.challenge_code !== null) {
    push(`- 题目编号：${inline(snapshot.project.challenge_code)}`);
  }
  if (snapshot.project.targets.length > 0) {
    push(`- 授权范围：${snapshot.project.targets.map((target) => inline(target)).join("、")}`);
  } else {
    push("- 授权范围：未记录");
  }
  if (snapshot.project.scope_notes !== null && snapshot.project.scope_notes !== "") {
    push(`- 范围备注：${inline(snapshot.project.scope_notes)}`);
  }

  push("", "## 结论", snapshotVerdict(snapshot));

  push("", "## 题目与目标");
  push(`- 背景：${snapshot.origin === null ? "未记录" : inline(snapshot.origin)}`);
  push(`- 目标：${snapshot.goal === null ? "未记录" : inline(snapshot.goal)}`);

  push("", "## 攻击路径");
  if (snapshot.steps.length === 0) {
    push("（没有已完成的探索意图）");
  }
  snapshot.steps.forEach((step, index) => {
    const head = `${index + 1}. **${inline(step.description) || step.intent_id}**`;
    const sources = step.from.length === 0 ? "" : `（基于 ${step.from.join("、")}）`;
    push(`${head}${sources}`);
    if (step.fact_description !== null) {
      push(`   - 产出 \`${step.fact_id}\`：${inline(step.fact_description)}`);
    } else {
      push("   - 未产出事实");
    }
    const meta: string[] = [];
    if (step.worker !== null) meta.push(`worker：${inline(step.worker)}`);
    if (step.model !== null) meta.push(`model：${inline(step.model)}`);
    if (step.outcome !== null) meta.push(`结果：${inline(step.outcome)}`);
    if (meta.length > 0) push(`   - ${meta.join("，")}`);
    if (step.evidence.length > 0) {
      push(`   - 证据：${step.evidence.map((ref) => `\`${ref}\``).join("、")}`);
    }
  });

  if (snapshot.open_intents.length > 0) {
    push("", "### 尚未完成的探索");
    for (const intent of snapshot.open_intents) {
      push(`- \`${intent.id}\`：${inline(intent.description)}`);
    }
  }

  push("", "## 关键发现（当前有效事实清单）");
  if (snapshot.findings.length === 0) {
    push("（没有当前有效事实）");
  }
  for (const finding of snapshot.findings) {
    const evidence = finding.evidence.length === 0
      ? ""
      : `（证据：${finding.evidence.map((ref) => `\`${ref}\``).join("、")}）`;
    push(`- \`${finding.id}\`：${inline(finding.description)}${evidence}`);
  }

  push("", "## 被取代的判断");
  if (snapshot.supersessions.length === 0) {
    push("（没有取代记录）");
  }
  for (const edge of snapshot.supersessions) {
    push(
      `- \`${edge.fact_id}\` → \`${edge.superseded_by}\`：` +
        `${inline(edge.description)} → ${inline(edge.superseded_by_description)}`,
    );
  }

  push("", "## 提示");
  if (snapshot.hints.length === 0) {
    push("（没有提示）");
  }
  for (const hint of snapshot.hints) {
    push(`- （${inline(hint.creator)}）${inline(hint.content)}`);
  }

  push("", "## Flag 与校验");
  if (snapshot.flag === null) {
    push("- Flag：未捕获");
  } else {
    push(`- Flag：\`${snapshot.flag.value}\``);
    push(`- 来源：\`${snapshot.flag.source}\``);
  }
  push(`- 校验策略：${snapshot.verification.kind}`);
  const latest = snapshot.verification.latest;
  if (latest === null) {
    push("- 最近校验：无记录");
  } else {
    push(
      `- 最近校验：${latest.ok ? "通过" : "未通过"}（${latest.checked_at}）` +
        (latest.flag_count !== null && latest.flag_got_count !== null
          ? `，计数 ${latest.flag_got_count}/${latest.flag_count}`
          : ""),
    );
    if (inline(latest.detail) !== "") push(`- 校验说明：${inline(latest.detail)}`);
  }

  push("", "## 执行统计");
  const runs = snapshot.runs;
  push(
    `- 运行：${runs.runs} 次（结束 ${runs.finished}，成功 ${runs.succeeded}，` +
      `失败 ${runs.failed}）`,
  );
  push(`- Token：${runs.tokens}`);
  push(`- 成本：$${runs.cost_usd.toFixed(6)}`);
  push("", ...table(
    ["worker", "运行", "成功", "Token"],
    runs.by_worker.map((group) => [
      cell(group.worker),
      String(group.runs),
      String(group.succeeded),
      String(group.tokens),
    ]),
  ));
  push("", ...table(
    ["model", "运行", "成功", "Token"],
    runs.by_model.map((group) => [
      group.model === null ? "（未上报）" : cell(group.model),
      String(group.runs),
      String(group.succeeded),
      String(group.tokens),
    ]),
  ));

  push("", "## 附录：证据文件");
  if (snapshot.artifacts.length === 0) {
    push("（没有登记工件）");
  }
  for (const artifact of snapshot.artifacts) {
    push(
      `- \`${artifact.path}\`（${artifact.size} 字节，sha256 ${artifact.sha256.slice(0, 12)}…，` +
        `来自 \`${artifact.task_id}\`）`,
    );
  }
  if (snapshot.artifacts_truncated) {
    push(`- …仅列出前 ${snapshot.artifacts.length} 个文件`);
  }

  push("", "_本 Writeup 由 Cairn 控制面依据图中数据生成；模型撰写版只重组事实，不新增未经核实的内容。_");
  return `${lines.join("\n")}\n`;
}

/**
 * The instruction pair used for the model-written variant. The draft is part of the prompt
 * so the model rewrites recorded data instead of inventing steps.
 */
export function renderProjectWriteupPrompt(snapshot: ProjectWriteupSnapshot): string {
  return [
    "你是 CTF 复盘写手。请把下面这份由控制面生成的中文 Writeup 草稿重写为一篇可直接发布的中文 Writeup。",
    "",
    "# 硬性要求",
    "- 全程使用简体中文；技术名词（如 SQLi、SSTI、pickle）可以保留英文。",
    "- 只使用草稿中出现的事实、证据路径与 Flag。不得补充草稿里没有的利用细节、工具版本或结论。",
    "- 证据不足或尚未完成的环节要如实写成“未验证”“未完成”，不要写成已成功。",
    "- 保留草稿里的 Flag 原文，逐字符照抄，不要改写、脱敏或截断。",
    "- 不得写入任何凭据、token、cookie、API key 或内网敏感地址（草稿里授权范围内的目标地址除外）。",
    "- 结构建议：题目概述 → 信息收集 → 利用链（按攻击路径顺序）→ 获取 Flag → 复盘与遗留问题。",
    "- 允许使用 Markdown 标题、列表和代码块；输出正文，不要包裹在 JSON 或额外说明里。",
    "- 篇幅控制在 1200 字以内，突出关键判断与转折点。",
    "",
    "# 草稿",
    renderProjectWriteupMarkdown(snapshot).trimEnd(),
  ].join("\n");
}

export function saveProjectWriteup(
  conn: Database,
  input: { projectId: string; markdown: string; model: string | null; createdAt?: string },
): ProjectWriteupRecord {
  run(
    conn,
    `INSERT INTO project_writeups (project_id, markdown, model, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       markdown = excluded.markdown,
       model = excluded.model,
       created_at = excluded.created_at`,
    input.projectId,
    input.markdown,
    input.model,
    input.createdAt ?? utcnow(),
  );
  const row = get<WriteupRow>(
    conn,
    "SELECT * FROM project_writeups WHERE project_id = ?",
    input.projectId,
  );
  if (row === undefined || row === null) {
    throw new Error("writeup was not stored");
  }
  return {
    project_id: row.project_id,
    markdown: row.markdown,
    model: row.model,
    created_at: row.created_at,
  };
}

export function getProjectWriteup(
  conn: Database,
  projectId: string,
): ProjectWriteupRecord | null {
  const row = get<WriteupRow>(
    conn,
    "SELECT * FROM project_writeups WHERE project_id = ?",
    projectId,
  );
  if (row === null) return null;
  return {
    project_id: row.project_id,
    markdown: row.markdown,
    model: row.model,
    created_at: row.created_at,
  };
}

export function clearProjectWriteup(conn: Database, projectId: string): void {
  run(conn, "DELETE FROM project_writeups WHERE project_id = ?", projectId);
}

export interface ProjectWriteupRecord {
  project_id: string;
  markdown: string;
  model: string | null;
  created_at: string;
}

interface WriteupRow {
  project_id: string;
  markdown: string;
  model: string | null;
  created_at: string;
}

interface LiteRunRow {
  id: string;
  worker: string;
  model: string | null;
  outcome: string | null;
}

function listRunsLite(conn: Database, projectId: string): LiteRunRow[] {
  return all<LiteRunRow>(
    conn,
    "SELECT id, worker, model, outcome FROM runs WHERE project_id = ?",
    projectId,
  );
}

function snapshotVerdict(snapshot: ProjectWriteupSnapshot): string {
  const parts: string[] = [];
  if (snapshot.flag === null) {
    parts.push("本项目尚未记录到 Flag");
  } else {
    parts.push(`本项目已拿到 Flag \`${snapshot.flag.value}\``);
  }
  const latest = snapshot.verification.latest;
  if (latest === null) {
    parts.push(`完成校验（策略 ${snapshot.verification.kind}）尚无记录`);
  } else if (latest.ok) {
    parts.push(
      latest.flag_count !== null && latest.flag_got_count !== null
        ? `题目校验通过（${latest.flag_got_count}/${latest.flag_count}）`
        : "题目校验通过",
    );
  } else {
    parts.push(
      `题目校验未通过${inline(latest.detail) === "" ? "" : `：${inline(latest.detail)}`}`,
    );
  }
  parts.push(
    `共完成 ${snapshot.steps.length} 个探索意图，` +
      `留下 ${snapshot.findings.length} 条当前有效事实`,
  );
  return `${parts.join("；")}。`;
}

function parseRefs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["（无数据）"];
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  return [header, divider, ...rows.map((row) => `| ${row.join(" | ")} |`)];
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cell(value: string): string {
  return inline(value).replace(/\|/g, "\\|");
}
