/**
 * Chinese project writeup (M19a).
 *
 * A writeup is a narrative view of data the control plane already stores: the project
 * header, the authorized scope, the origin/goal pair, the intent→fact chain that produced
 * the current findings, superseded judgements, hints, the captured flag, the verification
 * outcome and the run statistics. This module only reads; rendering the snapshot into
 * Chinese Markdown adds no graph semantics.
 *
 * Payload candidates (M20a) are selected from the artifact index by deterministic naming and
 * extension rules; their bytes are read by the HTTP layer, which passes the already capped
 * text in through `payloadContents`. This module never touches the filesystem, so the
 * writeup stays reproducible from the database plus one injected list.
 *
 * The Markdown draft doubles as the input for the model-written variant: the HTTP layer
 * asks a model to rewrite the draft as prose and stores the result in `project_writeups`,
 * so a project without model credentials still has a complete Chinese writeup.
 */

import type { Database } from "bun:sqlite";

import { listProjectArtifacts, type ProjectArtifact } from "./artifacts";
import { getProjectDetail, getProjectScope } from "./commands";
import { all, get, run } from "./db";
import type { FactSupersession, Hint, VerificationKind } from "./models";
import { buildProjectRunStats } from "./stats";
import { listFactSupersessions } from "./supersedes";
import { utcnow } from "./services";
import { summarizeProjectVerification } from "./verification";

const MAX_WRITEUP_ARTIFACTS = 200;

/** Payload list size and inline-text cap, shared with the HTTP layer that reads the bytes. */
export const MAX_WRITEUP_PAYLOADS = 20;
export const MAX_WRITEUP_PAYLOAD_CHARS = 4_000;

/**
 * File names and extensions that mark a worker-written exploit artifact: scripts, delivery
 * containers and the usual attack keywords. Response dumps (`.txt`, `.out`, `.resp`, `.md`,
 * `.json`) stay out of the list, so the payload section records what was thrown at the
 * target rather than everything the worker saved.
 */
const PAYLOAD_EXTENSION_LANGUAGES = new Map<string, string | null>([
  ["py", "python"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["php", "php"],
  ["php5", "php"],
  ["phtml", "php"],
  ["phar", null],
  ["js", "javascript"],
  ["ts", "typescript"],
  ["rb", "ruby"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["ps1", "powershell"],
  ["bat", "bat"],
  ["cmd", "bat"],
  ["c", "c"],
  ["cpp", "cpp"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["jsp", null],
  ["asp", null],
  ["aspx", null],
  ["sql", "sql"],
  ["html", "html"],
  ["htm", "html"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["xsl", "xml"],
  ["xslt", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["pkl", null],
  ["pickle", null],
  ["zip", null],
  ["tar", null],
  ["gz", null],
  ["bz2", null],
  ["xz", null],
  ["7z", null],
  ["rar", null],
  ["jar", null],
  ["war", null],
  ["class", null],
  ["png", null],
  ["jpg", null],
  ["jpeg", null],
  ["gif", null],
  ["bmp", null],
  ["ico", null],
  ["webp", null],
  ["pdf", null],
]);

/** Keywords that make a file a payload even when its extension is not on the list. */
const PAYLOAD_NAME_PATTERN =
  /(payload|exploit|attack|\bpoc\b|inject|sqli|xss|ssrf|ssti|xxe|pickle|pkl|traver|webshell|reverse[-_]?shell|bind[-_]?shell|deserial|forg|bypass)/i;

export interface WriteupFlag {
  value: string;
  source: string;
}

/** One payload file whose bytes the HTTP layer already read and capped. */
export interface WriteupPayloadContent {
  /** Artifact-index-relative path, for example `explore-1a2b3c4d5e6f/forge.py`. */
  path: string;
  /** True when the bytes are not text, so only the path is recorded. */
  binary: boolean;
  /** Inlined text, or null for a binary or unreadable file. */
  text: string | null;
  /** True when the caller cut the text because the file is larger than its cap. */
  truncated: boolean;
}

export interface BuildProjectWriteupOptions {
  /** Captured flag plus the file it was read from. */
  flag?: WriteupFlag | null;
  /** Payload file contents keyed by artifact path; absent entries render as unread. */
  payloadContents?: readonly WriteupPayloadContent[];
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

export interface WriteupPayload {
  path: string;
  size: number;
  sha256: string;
  task_id: string;
  /** Fenced-block language inferred from the extension; null for containers and binaries. */
  language: string | null;
  /** True when the read bytes are not text, so the writeup records the path only. */
  binary: boolean;
  /** Inlined payload text, or null when nothing could be inlined. */
  text: string | null;
  truncated: boolean;
  /** Fact ids whose `evidence_refs` cite this file. */
  referenced_by: string[];
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
  /** Worker-written payload and script files, capped to `MAX_WRITEUP_PAYLOADS`. */
  payloads: WriteupPayload[];
  /** Payload artifacts recognised in the index, including the ones the cap dropped. */
  payloads_total: number;
  payloads_truncated: boolean;
}

interface FactMetaRow {
  fact_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
}

/**
 * The payload artifacts a writeup should inline, capped to `MAX_WRITEUP_PAYLOADS`. Files
 * cited by a fact's `evidence_refs` come first, then by path, so the cap cannot drop the
 * payloads that carry the conclusion. The HTTP layer reads exactly these paths.
 */
export function selectWriteupPayloadArtifacts(
  conn: Database,
  projectId: string,
): ProjectArtifact[] {
  const ordered = orderWriteupPayloadArtifacts(
    listProjectArtifacts(conn, projectId),
    factsByEvidencePath(
      all<Pick<FactMetaRow, "fact_id" | "evidence_refs">>(
        conn,
        "SELECT fact_id, evidence_refs FROM fact_meta WHERE project_id = ?",
        projectId,
      ),
    ),
  );
  return ordered.slice(0, MAX_WRITEUP_PAYLOADS);
}

function orderWriteupPayloadArtifacts(
  artifacts: readonly ProjectArtifact[],
  factsByArtifact: ReadonlyMap<string, string[]>,
): ProjectArtifact[] {
  return artifacts
    .filter((artifact) => isWriteupPayloadPath(artifact.path))
    .sort((left, right) => {
      const byEvidence =
        (factsByArtifact.get(normalizeArtifactPath(right.path))?.length ?? 0) -
        (factsByArtifact.get(normalizeArtifactPath(left.path))?.length ?? 0);
      return byEvidence !== 0 ? byEvidence : left.path.localeCompare(right.path);
    });
}

function factsByEvidencePath(
  rows: readonly Pick<FactMetaRow, "fact_id" | "evidence_refs">[],
): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const row of rows) {
    for (const ref of parseRefs(row.evidence_refs)) {
      const key = normalizeArtifactPath(ref);
      if (key === "") continue;
      const known = byPath.get(key);
      if (known === undefined) byPath.set(key, [row.fact_id]);
      else if (!known.includes(row.fact_id)) known.push(row.fact_id);
    }
  }
  return byPath;
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

  const factsByArtifact = factsByEvidencePath(metaRows);
  const contents = new Map(
    (options.payloadContents ?? []).map((entry) => [normalizeArtifactPath(entry.path), entry]),
  );
  const orderedPayloads = orderWriteupPayloadArtifacts(artifacts, factsByArtifact);
  const payloads: WriteupPayload[] = orderedPayloads.slice(0, MAX_WRITEUP_PAYLOADS).map((row) => {
    const content = contents.get(normalizeArtifactPath(row.path));
    const raw = content?.text ?? null;
    const text = raw === null ? null : clampText(raw, MAX_WRITEUP_PAYLOAD_CHARS);
    return {
      path: row.path,
      size: row.size,
      sha256: row.sha256,
      task_id: row.task_id,
      language: payloadLanguage(row.path),
      binary: content?.binary ?? false,
      text,
      truncated: (content?.truncated ?? false) || (raw !== null && text !== raw),
      referenced_by: [...(factsByArtifact.get(normalizeArtifactPath(row.path)) ?? [])].sort(),
    };
  });

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
    payloads,
    payloads_total: orderedPayloads.length,
    payloads_truncated: orderedPayloads.length > MAX_WRITEUP_PAYLOADS,
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

  push("", "## 载荷（Payload）");
  if (snapshot.payloads.length === 0) {
    push("（没有识别到载荷或脚本文件）");
  } else {
    const inlined = snapshot.payloads.filter((payload) => payload.text !== null).length;
    push(
      `（识别到 ${snapshot.payloads_total} 个载荷/脚本文件，此处列出 ${snapshot.payloads.length} 个，` +
        `其中 ${inlined} 个逐字内联；完整附件请从 Writeup 附件包下载。）`,
    );
    for (const payload of snapshot.payloads) {
      push("", `### \`${payload.path}\``);
      push(
        `- ${payload.size} 字节，sha256 ${payload.sha256.slice(0, 12)}…，` +
          `来自 \`${payload.task_id}\``,
      );
      if (payload.referenced_by.length > 0) {
        push(`- 关联事实：${payload.referenced_by.map((id) => `\`${id}\``).join("、")}`);
      }
      if (payload.text !== null) {
        const fence = codeFence(payload.text);
        push("", `${fence}${payload.language ?? ""}`);
        for (const line of payload.text.replace(/\n$/, "").split("\n")) push(line);
        push(fence);
        if (payload.truncated) push("（内容已截断，完整文件见附件包。）");
      } else if (payload.binary) {
        push("（二进制载荷，未内联，完整文件见附件包。）");
      } else {
        push("（内容未读取：工作区未挂载或文件已被清理，完整文件见附件包。）");
      }
    }
    if (snapshot.payloads_truncated) {
      push("", `…其余 ${snapshot.payloads_total - snapshot.payloads.length} 个载荷文件见附件包。`);
    }
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
    "- 草稿的“载荷（Payload）”章节给出脚本与 payload 原文：引用时同样逐字符照抄，" +
      "不得改写、补全或自己编造；只登记了路径或标注未内联的载荷，就照实说附件包里有这个文件，不要虚构内容。",
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

/**
 * Artifact paths reach this module in two shapes: the index stores them relative to
 * `artifacts/` with forward slashes, `evidence_refs` stores them with the `artifacts/`
 * prefix and whatever separator the worker wrote. Normalizing both makes the join work.
 */
function normalizeArtifactPath(path: string): string {
  let value = path.replaceAll("\\", "/").trim();
  while (value.startsWith("./")) value = value.slice(2);
  if (value.startsWith("artifacts/")) value = value.slice("artifacts/".length);
  return value;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Fenced-block language for a payload path; null for containers and binary formats. */
export function payloadLanguage(path: string): string | null {
  const normalized = normalizeArtifactPath(path);
  const language = PAYLOAD_EXTENSION_LANGUAGES.get(extensionOf(normalized));
  return language === undefined ? null : language;
}

/** True when an artifact looks like something the worker threw at the target. */
export function isWriteupPayloadPath(path: string): boolean {
  const normalized = normalizeArtifactPath(path);
  if (normalized === "") return false;
  if (PAYLOAD_NAME_PATTERN.test(normalized)) return true;
  return PAYLOAD_EXTENSION_LANGUAGES.has(extensionOf(normalized));
}

/** Cuts long text at a line boundary so a fenced block never ends mid-character. */
function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = value.slice(0, maxChars);
  const newline = head.lastIndexOf("\n");
  return newline > maxChars / 2 ? head.slice(0, newline) : head;
}

/** A fence longer than any run of backticks inside the quoted text. */
function codeFence(text: string): string {
  let length = 3;
  while (text.includes("`".repeat(length))) length += 1;
  return "`".repeat(length);
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
