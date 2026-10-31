/**
 * Read-only project report (M15c).
 *
 * The report is a composition of reads that already exist: the graph detail, supersede
 * edges, verification history, the runs sidecar, cost attribution, the audit summaries and
 * the artifact index. It adds no graph semantics. Like every other read that loads project
 * detail it may expire stale leases, but it never writes facts, intents or sidecar history.
 *
 * Hardening: it carries aggregate audit and artifact data (counts, byte totals, time
 * bounds) instead of raw audit events, artifact paths or evidence contents. Command output
 * and Host Bridge audit payloads therefore never leave the database through this view.
 */

import type { Database } from "bun:sqlite";

import { listProjectArtifacts } from "./artifacts";
import { listProjectAudit } from "./audit";
import { getProjectDetail } from "./commands";
import { buildProjectCostReport } from "./cost";
import type {
  ProjectReport,
  ProjectReportRunTotals,
  VerificationKind,
} from "./models";
import { listProjectIntentMeta } from "./proposals";
import { buildProjectRunStats } from "./stats";
import { listFactSupersessions } from "./supersedes";
import { utcnow } from "./services";
import { summarizeProjectVerification } from "./verification";

export interface BuildProjectReportOptions {
  /** Injectable clock; tests pass a fixed value for a deterministic report. */
  generatedAt?: string;
  /** Policy reported for legacy projects without a `project_verification` row. */
  verificationFallback?: VerificationKind;
}

export function buildProjectReport(
  conn: Database,
  projectId: string,
  options: BuildProjectReportOptions = {},
): ProjectReport {
  const detail = getProjectDetail(conn, projectId);
  const supersessions = listFactSupersessions(conn, projectId);
  const superseded = new Set(supersessions.map((edge) => edge.fact_id));
  const currentFacts = detail.facts
    .filter((fact) => !superseded.has(fact.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const hints = [...detail.hints].sort((left, right) => {
    const byTime = left.created_at.localeCompare(right.created_at);
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
  });

  const verification = summarizeProjectVerification(
    conn,
    projectId,
    options.verificationFallback,
  );
  const stats = buildProjectRunStats(conn, projectId);
  const cost = buildProjectCostReport(conn, projectId);
  const audit = listProjectAudit(conn, projectId);
  const artifacts = listProjectArtifacts(conn, projectId);
  const abandonedIntentIds = new Set(
    listProjectIntentMeta(conn, projectId)
      .filter((meta) => meta.status === "abandoned")
      .map((meta) => meta.intent_id),
  );
  const openIntentCount = detail.intents.filter(
    (intent) => intent.to === null && !abandonedIntentIds.has(intent.id),
  ).length;
  const abandonedIntentCount = detail.intents.filter(
    (intent) => intent.to === null && abandonedIntentIds.has(intent.id),
  ).length;

  const runTotals: ProjectReportRunTotals = {
    runs: stats.totals.runs,
    finished: stats.totals.finished,
    succeeded: stats.totals.succeeded,
    failed: stats.totals.failed,
    tokens: stats.totals.tokens,
    cost_usd: stats.totals.cost_usd,
    avg_duration_ms: stats.totals.avg_duration_ms,
  };

  let auditFirst: string | null = null;
  let auditLast: string | null = null;
  let auditEvents = 0;
  for (const entry of audit) {
    auditEvents += entry.event_count;
    if (auditFirst === null || entry.first_at < auditFirst) auditFirst = entry.first_at;
    if (auditLast === null || entry.last_at > auditLast) auditLast = entry.last_at;
  }

  return {
    generated_at: options.generatedAt ?? utcnow(),
    project: detail.project,
    verification: {
      kind: verification.policy.kind,
      challenge_code: verification.policy.challenge_code,
      checks: verification.checks,
      latest: verification.latest,
    },
    graph: {
      facts: detail.facts.length,
      current_facts: currentFacts.length,
      superseded_facts: supersessions.length,
      intents: detail.intents.length,
      open_intents: openIntentCount,
      abandoned_intents: abandonedIntentCount,
      hints: hints.length,
    },
    current_facts: currentFacts,
    hints,
    supersessions,
    runs: {
      totals: runTotals,
      by_worker: stats.by_worker,
      by_model: stats.by_model,
      by_profile: stats.by_profile,
    },
    cost: {
      tokens: cost.totals.tokens,
      cost_usd: cost.totals.cost_usd,
      unattributed_tokens: cost.attribution.unattributed_tokens,
      unattributed_cost_usd: cost.attribution.unattributed_cost_usd,
      by_kind: cost.by_kind,
    },
    audit: {
      tasks: audit.length,
      events: auditEvents,
      first_at: auditFirst,
      last_at: auditLast,
    },
    artifacts: {
      count: artifacts.length,
      bytes: artifacts.reduce((sum, artifact) => sum + artifact.size, 0),
    },
  };
}

/**
 * Human-readable rendering of the same object. Every user-controlled string is collapsed
 * to one line so a fact or hint cannot break the surrounding Markdown structure.
 */
export function renderProjectReportMarkdown(report: ProjectReport): string {
  const lines: string[] = [];
  const push = (...values: string[]): void => {
    lines.push(...values);
  };

  push(`# ${inline(report.project.title) || report.project.id}`, "");
  push(`- project: \`${report.project.id}\``);
  push(`- status: ${report.project.status}`);
  push(`- bootstrap: ${report.project.bootstrap_enabled ? "enabled" : "disabled"}`);
  push(`- created: ${report.project.created_at}`);
  push(`- generated: ${report.generated_at}`);

  push("", "## Completion");
  push(`- policy: ${report.verification.kind}`);
  if (report.verification.challenge_code !== null) {
    push(`- challenge: ${inline(report.verification.challenge_code)}`);
  }
  const checks = report.verification.checks;
  push(
    `- checks: ${checks.total} total, ${checks.passed} passed, ${checks.failed} failed`,
  );
  if (checks.last_checked_at !== null) {
    push(`- last check: ${checks.last_checked_at}`);
  }
  if (report.verification.latest === null) {
    push("- latest: none");
  } else {
    const latest = report.verification.latest;
    push(
      `- latest: ${latest.ok ? "passed" : "failed"} at ${latest.checked_at} ` +
        `(${inline(latest.detail) || "no detail"})`,
    );
  }

  push("", "## Graph");
  push(
    `- facts: ${report.graph.facts} ` +
      `(current ${report.graph.current_facts}, superseded ${report.graph.superseded_facts})`,
  );
  push(`- intents: ${report.graph.intents} (open ${report.graph.open_intents})`);
  push(`- hints: ${report.graph.hints}`);

  push("", "### Current facts");
  appendList(
    lines,
    report.current_facts.map(
      (fact) => `- \`${fact.id}\`: ${inline(fact.description)}`,
    ),
  );

  push("", "### Supersessions");
  appendList(
    lines,
    report.supersessions.map(
      (edge) =>
        `- \`${edge.fact_id}\` → \`${edge.superseded_by}\`: ` +
        `${inline(edge.description)} → ${inline(edge.superseded_by_description)}`,
    ),
  );

  push("", "### Hints");
  appendList(
    lines,
    report.hints.map(
      (hint) => `- (${inline(hint.creator)}) ${inline(hint.content)}`,
    ),
  );

  push("", "## Runs");
  const totals = report.runs.totals;
  push(
    `- runs: ${totals.runs} (finished ${totals.finished}, succeeded ${totals.succeeded}, ` +
      `failed ${totals.failed})`,
  );
  push(`- tokens: ${totals.tokens}`);
  push(`- cost: $${totals.cost_usd.toFixed(6)}`);
  push(
    `- avg duration: ${totals.avg_duration_ms === null ? "n/a" : `${totals.avg_duration_ms} ms`}`,
  );

  push("", "### By worker");
  push(
    ...table(
      ["worker", "runs", "finished", "succeeded", "failed", "tokens", "cost USD"],
      report.runs.by_worker.map((group) => [
        cell(group.worker),
        String(group.runs),
        String(group.finished),
        String(group.succeeded),
        String(group.failed),
        String(group.tokens),
        group.cost_usd.toFixed(6),
      ]),
    ),
  );

  push("", "### By model");
  push(
    ...table(
      ["model", "runs", "finished", "succeeded", "failed", "tokens", "cost USD"],
      report.runs.by_model.map((group) => [
        group.model === null ? "(unreported)" : cell(group.model),
        String(group.runs),
        String(group.finished),
        String(group.succeeded),
        String(group.failed),
        String(group.tokens),
        group.cost_usd.toFixed(6),
      ]),
    ),
  );

  push("", "### By profile");
  push(
    ...table(
      ["profile", "runs", "finished", "succeeded", "failed", "tokens", "cost USD"],
      report.runs.by_profile.map((group) => [
        cell(group.worker_profile),
        String(group.runs),
        String(group.finished),
        String(group.succeeded),
        String(group.failed),
        String(group.tokens),
        group.cost_usd.toFixed(6),
      ]),
    ),
  );

  push("", "## Cost");
  push(`- tokens: ${report.cost.tokens}`);
  push(`- cost: $${report.cost.cost_usd.toFixed(6)}`);
  push(
    `- unattributed: ${report.cost.unattributed_tokens} tokens, ` +
      `$${report.cost.unattributed_cost_usd.toFixed(6)}`,
  );
  push("", "### By kind");
  push(
    ...table(
      ["kind", "runs", "tokens", "cost USD"],
      report.cost.by_kind.map((entry) => [
        cell(entry.kind),
        String(entry.runs),
        String(entry.tokens),
        entry.cost_usd.toFixed(6),
      ]),
    ),
  );

  push("", "## Audit and artifacts");
  push(
    `- audit: ${report.audit.tasks} task(s), ${report.audit.events} event(s)` +
      (report.audit.first_at === null
        ? ""
        : ` (${report.audit.first_at} .. ${report.audit.last_at ?? report.audit.first_at})`),
  );
  push(`- artifacts: ${report.artifacts.count} file(s), ${report.artifacts.bytes} byte(s)`);
  push("", "_Raw audit events, artifact paths and evidence contents are intentionally omitted._");

  return `${lines.join("\n")}\n`;
}

function appendList(lines: string[], items: string[]): void {
  if (items.length === 0) {
    lines.push("- (none)");
    return;
  }
  lines.push(...items);
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["(none)"];
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  return [header, divider, ...rows.map((row) => `| ${row.join(" | ")} |`)];
}

/** Collapses all whitespace so a multi-line value stays on one Markdown line. */
function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Table cells cannot contain an unescaped pipe. */
function cell(value: string): string {
  return inline(value).replace(/\|/g, "\\|");
}
