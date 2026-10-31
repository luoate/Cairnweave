/**
 * Agent-facing projection of the graph and its sidecars (M36).
 *
 * The Cairn graph is deliberately thin: facts only carry `{id, description}`. Everything
 * the control plane learned around it — evidence, supersede edges, run outcomes,
 * verification progress — lives in sidecar tables and was, until M36, visible only to the
 * operator and the completion oracle. This module projects that state into one deterministic
 * file per task, so reason and explore can plan against what the system actually knows.
 *
 * This is a read model. It never writes, never changes the graph export, and never carries
 * raw audit events, evidence contents, attachment bytes or flag plaintext.
 */

import type { Database } from "bun:sqlite";

import { all } from "./db";
import type {
  AgentContext,
  AgentContextAttempt,
  AgentContextBudget,
  AgentContextDelta,
  AgentContextFact,
  AgentContextIntent,
  AgentContextKind,
  AgentContextVerification,
  EvidenceStatus,
  FactSupersession,
  Intent,
  IntentMeta,
  Run,
  RunOutcome,
  VerificationKind,
} from "./models";
import { listProjectIntentMeta } from "./proposals";
import { listProjectRuns } from "./runs";
import { buildIntents, getProjectOr404, utcnow } from "./services";
import { getStrategistState } from "./strategist";
import { listFactSupersessions } from "./supersedes";
import { summarizeProjectVerification } from "./verification";
import { map, renderYaml, type YamlValue } from "./yaml";

export interface AgentContextLimits {
  maxFacts: number;
  maxIntents: number;
  maxConcludedIntents: number;
  maxAttempts: number;
  maxDeltaIds: number;
  maxDetailChars: number;
}

/**
 * Bounds keep the file useful without letting a large project blow up the worker prompt.
 * They are deliberately generous: the default project in the gates has a handful of facts,
 * and the caps only matter once a project has explored for a long time.
 */
export const DEFAULT_AGENT_CONTEXT_LIMITS: AgentContextLimits = {
  maxFacts: 200,
  maxIntents: 100,
  maxConcludedIntents: 20,
  maxAttempts: 20,
  maxDeltaIds: 50,
  maxDetailChars: 500,
};

/** Usage snapshot passed by the scheduler; reason already shows the same numbers. */
export interface AgentContextBudgetInput {
  usedTokens: number;
  usedCostUsd: number;
  maxTokens: number;
  maxCostUsd: number;
}

export interface BuildAgentContextOptions {
  kind: AgentContextKind;
  /** Explore/conclude: the intent being worked on. */
  focusIntentId?: string;
  /** Injectable clock; tests pass a fixed value. */
  generatedAt?: string;
  /** Policy used for legacy projects without a `project_verification` row. */
  verificationFallback?: VerificationKind;
  /** Reason only: finished-run usage and the configured limits. */
  budget?: AgentContextBudgetInput | null;
  limits?: Partial<AgentContextLimits>;
}

interface FactRow {
  id: string;
  description: string;
}

interface FactMetaRow {
  fact_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
  created_at: string;
}

interface HintRow {
  id: string;
  created_at: string;
}

export function buildAgentContext(
  conn: Database,
  projectId: string,
  options: BuildAgentContextOptions,
): AgentContext {
  const project = getProjectOr404(conn, projectId);
  const limits: AgentContextLimits = {
    ...DEFAULT_AGENT_CONTEXT_LIMITS,
    ...options.limits,
  };

  const factRows = all<FactRow>(
    conn,
    "SELECT id, description FROM facts WHERE project_id = ?",
    projectId,
  );
  const factById = new Map(factRows.map((fact) => [fact.id, fact]));
  const metaByFact = new Map(
    all<FactMetaRow>(
      conn,
      `SELECT fact_id, run_id, evidence_refs, evidence_status, created_at
       FROM fact_meta WHERE project_id = ?`,
      projectId,
    ).map((row) => [row.fact_id, row]),
  );
  const supersessions = listFactSupersessions(conn, projectId);
  const supersededBy = new Map(supersessions.map((edge) => [edge.fact_id, edge]));
  const intents = buildIntents(conn, projectId);
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));
  const intentMeta = new Map(
    listProjectIntentMeta(conn, projectId).map((meta) => [meta.intent_id, meta]),
  );
  const runs = listProjectRuns(conn, projectId);
  const hints = all<HintRow>(
    conn,
    "SELECT id, created_at FROM hints WHERE project_id = ?",
    projectId,
  );

  const verification = summarizeProjectVerification(
    conn,
    projectId,
    options.verificationFallback,
  );
  const state = options.kind === "reason" ? getStrategistState(conn, projectId) : null;

  const truncatedSections: string[] = [];
  const facts = selectFacts({
    kind: options.kind,
    factRows,
    supersessions,
    focus: options.focusIntentId === undefined
      ? undefined
      : intentById.get(options.focusIntentId),
    limits,
    truncatedSections,
  }).flatMap((id) => {
    const view = factView(id, factById, metaByFact, supersededBy);
    return view === null ? [] : [view];
  });

  const intentsView = selectIntents({
    kind: options.kind,
    intents,
    intentMeta,
    runs,
    focusIntentId: options.focusIntentId,
    limits,
    truncatedSections,
  });

  const recentAttempts = selectAttempts({
    kind: options.kind,
    runs,
    focusIntentId: options.focusIntentId,
    limits,
    truncatedSections,
  });

  const budget = options.budget === undefined || options.budget === null
    ? null
    : {
        used_tokens: options.budget.usedTokens,
        limit_tokens: options.budget.maxTokens,
        used_cost_usd: roundCost(options.budget.usedCostUsd),
        limit_cost_usd: roundCost(options.budget.maxCostUsd),
        running_tasks: runs.reduce(
          (count, run) => count + (run.outcome === null ? 1 : 0),
          0,
        ),
      } satisfies AgentContextBudget;

  const delta = buildDelta({
    kind: options.kind,
    state,
    factRows,
    metaByFact,
    intents,
    hints,
    runs,
    limits,
    truncatedSections,
  });

  return {
    version: 1,
    kind: options.kind,
    generated_at: options.generatedAt ?? utcnow(),
    project: {
      id: project.id,
      title: project.title,
      status: project.status as AgentContext["project"]["status"],
    },
    goal: {
      description: factById.get("goal")?.description ?? "",
      verification: verificationView(verification, limits),
    },
    facts,
    intents: intentsView,
    recent_attempts: recentAttempts,
    delta,
    budget,
    truncated: truncatedSections.length > 0,
    truncated_sections: truncatedSections,
  };
}

/** Renders the projection as the YAML file the worker reads next to `graph.yaml`. */
export function renderAgentContextYaml(context: AgentContext): string {
  const entries: Array<[string, YamlValue]> = [
    ["version", context.version],
    ["kind", context.kind],
    ["generated_at", context.generated_at],
    [
      "project",
      map([
        ["id", context.project.id],
        ["title", context.project.title],
        ["status", context.project.status],
      ]),
    ],
    [
      "goal",
      map([
        ["description", context.goal.description],
        [
          "verification",
          map([
            ["kind", context.goal.verification.kind],
            ["challenge_code", context.goal.verification.challenge_code],
            [
              "progress",
              map([
                ["found", context.goal.verification.progress.found],
                ["total", context.goal.verification.progress.total],
                [
                  "last_checked_at",
                  context.goal.verification.progress.last_checked_at,
                ],
              ]),
            ],
            [
              "checks",
              map([
                ["total", context.goal.verification.checks.total],
                ["passed", context.goal.verification.checks.passed],
                ["failed", context.goal.verification.checks.failed],
              ]),
            ],
            [
              "latest",
              context.goal.verification.latest === null
                ? null
                : map([
                    ["ok", context.goal.verification.latest.ok],
                    ["detail", context.goal.verification.latest.detail],
                    ["checked_at", context.goal.verification.latest.checked_at],
                  ]),
            ],
          ]),
        ],
      ]),
    ],
    [
      "facts",
      context.facts.map((fact) =>
        map([
          ["id", fact.id],
          ["description", fact.description],
          ["status", fact.status],
          ["superseded_by", fact.superseded_by],
          [
            "evidence",
            map([
              ["status", fact.evidence.status],
              ["run_id", fact.evidence.run_id],
              ["refs", fact.evidence.refs],
            ]),
          ],
        ]),
      ),
    ],
    [
      "intents",
      context.intents.map((intent) =>
        map([
          ["id", intent.id],
          ["description", intent.description],
          ["from", [...intent.from]],
          ["status", intent.status],
          ["attempts", intent.attempts],
          ["last_outcome", intent.last_outcome],
          ["last_error", intent.last_error],
          ["priority", intent.priority],
        ]),
      ),
    ],
    [
      "recent_attempts",
      context.recent_attempts.map((attempt) =>
        map([
          ["run_id", attempt.run_id],
          ["kind", attempt.kind],
          ["intent_id", attempt.intent_id],
          ["outcome", attempt.outcome],
          ["started_at", attempt.started_at],
          ["duration_ms", attempt.duration_ms],
          ["tokens", attempt.tokens],
          ["detail", attempt.detail],
        ]),
      ),
    ],
    [
      "delta",
      context.delta === null
        ? null
        : map([
            ["since", context.delta.since],
            ["new_facts", [...context.delta.new_facts]],
            ["concluded_intents", [...context.delta.concluded_intents]],
            ["new_hints", context.delta.new_hints],
            ["failed_attempts", context.delta.failed_attempts],
          ]),
    ],
    [
      "budget",
      context.budget === null
        ? null
        : map([
            ["used_tokens", context.budget.used_tokens],
            ["limit_tokens", context.budget.limit_tokens],
            ["used_cost_usd", context.budget.used_cost_usd],
            ["limit_cost_usd", context.budget.limit_cost_usd],
            ["running_tasks", context.budget.running_tasks],
          ]),
    ],
    ["truncated", context.truncated],
    ["truncated_sections", [...context.truncated_sections]],
  ];
  return renderYaml(map(entries));
}

function selectFacts(input: {
  kind: AgentContextKind;
  factRows: readonly FactRow[];
  supersessions: readonly FactSupersession[];
  focus: Intent | undefined;
  limits: AgentContextLimits;
  truncatedSections: string[];
}): string[] {
  if (input.kind === "reason") {
    const superseded = new Set(input.supersessions.map((edge) => edge.fact_id));
    const current = input.factRows
      .filter((fact) => !superseded.has(fact.id))
      .map((fact) => fact.id)
      .sort();
    const replaced = [...input.supersessions]
      .sort((left, right) => {
        const byTime = right.created_at.localeCompare(left.created_at);
        return byTime === 0 ? left.fact_id.localeCompare(right.fact_id) : byTime;
      })
      .map((edge) => edge.fact_id);

    const selected = current.slice(0, input.limits.maxFacts);
    const remaining = input.limits.maxFacts - selected.length;
    if (remaining > 0) selected.push(...replaced.slice(0, remaining));
    if (current.length + replaced.length > selected.length) {
      input.truncatedSections.push("facts");
    }
    return selected;
  }

  // Explore/conclude only need the facts the focus intent starts from.
  const sources = [...new Set(input.focus?.from ?? [])].filter((id) =>
    input.factRows.some((fact) => fact.id === id),
  );
  if (sources.length > input.limits.maxFacts) {
    input.truncatedSections.push("facts");
  }
  return sources.slice(0, input.limits.maxFacts);
}

function selectIntents(input: {
  kind: AgentContextKind;
  intents: readonly Intent[];
  intentMeta: ReadonlyMap<string, IntentMeta>;
  runs: readonly Run[];
  focusIntentId: string | undefined;
  limits: AgentContextLimits;
  truncatedSections: string[];
}): AgentContextIntent[] {
  if (input.kind !== "reason") {
    const focus = input.intents.find((intent) => intent.id === input.focusIntentId);
    return focus === undefined
      ? []
      : [intentView(focus, input.intentMeta, input.runs, input.limits)];
  }

  const allOpen = input.intents.filter((intent) => intent.to === null);
  const allConcluded = input.intents.filter((intent) => intent.to !== null);

  const open = allOpen.sort((left, right) =>
    compareOpenIntents(left, right, input.intentMeta),
  );
  const concluded = allConcluded
    .sort((left, right) => {
      const byTime = (right.concluded_at ?? "").localeCompare(
        left.concluded_at ?? "",
      );
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    })
    .slice(0, input.limits.maxConcludedIntents);

  const selected = [...open, ...concluded];
  if (
    selected.length > input.limits.maxIntents ||
    allOpen.length + allConcluded.length > selected.length
  ) {
    input.truncatedSections.push("intents");
  }
  return selected
    .slice(0, input.limits.maxIntents)
    .map((intent) => intentView(intent, input.intentMeta, input.runs, input.limits));
}

function compareOpenIntents(
  left: Intent,
  right: Intent,
  meta: ReadonlyMap<string, IntentMeta>,
): number {
  const leftPriority = meta.get(left.id)?.priority ?? DEFAULT_PRIORITY;
  const rightPriority = meta.get(right.id)?.priority ?? DEFAULT_PRIORITY;
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  if (left.created_at !== right.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }
  return right.id.localeCompare(left.id);
}

const DEFAULT_PRIORITY = 50;

function intentView(
  intent: Intent,
  intentMeta: ReadonlyMap<string, IntentMeta>,
  runs: readonly Run[],
  limits: AgentContextLimits,
): AgentContextIntent {
  const attempts = runs.filter((run) => run.intent_id === intent.id);
  const last = finishedRuns(attempts)[0] ?? null;
  const meta = intentMeta.get(intent.id);
  return {
    id: intent.id,
    description: intent.description,
    from: [...intent.from],
    status: intent.to !== null ? "concluded" : "open",
    attempts: attempts.length,
    last_outcome: last?.outcome ?? null,
    last_error:
      last !== null && last.outcome !== "success" && last.detail !== null
        ? truncate(last.detail, limits.maxDetailChars)
        : null,
    priority: meta?.priority ?? null,
  };
}

function selectAttempts(input: {
  kind: AgentContextKind;
  runs: readonly Run[];
  focusIntentId: string | undefined;
  limits: AgentContextLimits;
  truncatedSections: string[];
}): AgentContextAttempt[] {
  const scoped =
    input.kind === "reason"
      ? input.runs
      : input.runs.filter((run) => run.intent_id === input.focusIntentId);
  const finished = finishedRuns(scoped);
  if (finished.length > input.limits.maxAttempts) {
    input.truncatedSections.push("attempts");
  }
  return finished.slice(0, input.limits.maxAttempts).map((run) => ({
    run_id: run.id,
    kind: run.kind,
    intent_id: run.intent_id,
    outcome: run.outcome,
    started_at: run.started_at,
    duration_ms: run.duration_ms,
    tokens: run.total_tokens,
    detail: run.detail === null ? null : truncate(run.detail, input.limits.maxDetailChars),
  }));
}

/** Finished runs, newest first; a deterministic id tie-break keeps tests stable. */
function finishedRuns(runs: readonly Run[]): Array<Run & { outcome: RunOutcome }> {
  return runs
    .filter((run): run is Run & { outcome: RunOutcome } => run.outcome !== null)
    .sort((left, right) => {
      const byTime = right.started_at.localeCompare(left.started_at);
      return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
    });
}

function factView(
  id: string,
  factById: ReadonlyMap<string, FactRow>,
  metaByFact: ReadonlyMap<string, FactMetaRow>,
  supersededBy: ReadonlyMap<string, FactSupersession>,
): AgentContextFact | null {
  const fact = factById.get(id);
  if (fact === undefined) return null;
  const meta = metaByFact.get(id);
  const edge = supersededBy.get(id);
  return {
    id,
    description: fact.description,
    status: edge === undefined ? "current" : "superseded",
    superseded_by: edge?.superseded_by ?? null,
    evidence: {
      status: normalizeEvidenceStatus(meta?.evidence_status),
      run_id: meta?.run_id ?? null,
      refs: meta === undefined ? 0 : countRefs(meta.evidence_refs),
    },
  };
}

function verificationView(
  verification: ReturnType<typeof summarizeProjectVerification>,
  limits: AgentContextLimits,
): AgentContextVerification {
  const { policy, checks, latest } = verification;
  const challenge = policy.kind === "challenge" ? latest : null;
  return {
    kind: policy.kind,
    challenge_code: policy.challenge_code,
    progress: {
      found: challenge?.flag_got_count ?? null,
      total: challenge?.flag_count ?? null,
      last_checked_at: checks.last_checked_at,
    },
    checks: {
      total: checks.total,
      passed: checks.passed,
      failed: checks.failed,
    },
    latest:
      latest === null
        ? null
        : {
            ok: latest.ok,
            detail: truncate(latest.detail, limits.maxDetailChars),
            checked_at: latest.checked_at,
          },
  };
}

function buildDelta(input: {
  kind: AgentContextKind;
  state: ReturnType<typeof getStrategistState>;
  factRows: readonly FactRow[];
  metaByFact: ReadonlyMap<string, FactMetaRow>;
  intents: readonly Intent[];
  hints: readonly HintRow[];
  runs: readonly Run[];
  limits: AgentContextLimits;
  truncatedSections: string[];
}): AgentContextDelta | null {
  if (input.kind !== "reason" || input.state === null) return null;
  const since = input.state.last_success_at ?? input.state.last_attempt_at;
  if (since === null) return null;

  const newFacts = input.factRows
    .filter((fact) => {
      const meta = input.metaByFact.get(fact.id);
      return meta !== undefined && meta.created_at > since;
    })
    .map((fact) => fact.id)
    .sort();
  const concludedIntents = input.intents
    .filter((intent) => intent.concluded_at !== null && intent.concluded_at > since)
    .map((intent) => intent.id)
    .sort();
  const newHints = input.hints.filter((hint) => hint.created_at > since).length;
  const failedAttempts = input.runs.filter(
    (run) =>
      run.outcome !== null &&
      run.outcome !== "success" &&
      (run.finished_at ?? run.started_at) > since,
  ).length;

  if (
    newFacts.length > input.limits.maxDeltaIds ||
    concludedIntents.length > input.limits.maxDeltaIds
  ) {
    input.truncatedSections.push("delta");
  }
  return {
    since,
    new_facts: newFacts.slice(0, input.limits.maxDeltaIds),
    concluded_intents: concludedIntents.slice(0, input.limits.maxDeltaIds),
    new_hints: newHints,
    failed_attempts: failedAttempts,
  };
}

function normalizeEvidenceStatus(value: string | undefined): EvidenceStatus {
  return value === "provided" || value === "missing" ? value : "legacy";
}

function countRefs(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").length
      : 0;
  } catch {
    return 0;
  }
}

/** One-line, bounded detail: the file is read by a model, not a log collector. */
function truncate(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxChars
    ? oneLine
    : `${oneLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Match the cost rounding used by stats/report so the views agree. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
