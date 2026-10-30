/**
 * Candidate graph changes and their review state.
 *
 * A worker (or, later, the Strategist) can only submit a proposal. The control plane is
 * the sole writer: it validates the payload, checks evidence and dedupe, then applies the
 * change through the normal graph commands. Keeping the candidate outside `facts` /
 * `intents` preserves the append-only Cairn graph and the single-writer invariant.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import type {
  Intent,
  IntentBudget,
  IntentMeta,
  Proposal,
  ProposalKind,
  ProposalSource,
  ProposalStatus,
} from "./models";
import { getProjectOr404, utcnow } from "./services";

export interface CreateProposalInput {
  id: string;
  projectId: string;
  taskId?: string | null;
  runId?: string | null;
  source: ProposalSource;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  evidenceRefs?: readonly string[];
  status?: ProposalStatus;
  createdAt?: string;
}

/** Returns false when a proposal with the same id already exists. */
export function createProposal(conn: Database, input: CreateProposalInput): boolean {
  const result = conn
    .query(
      `
      INSERT OR IGNORE INTO proposals
          (id, project_id, task_id, run_id, source, kind, payload, dedupe_key,
           evidence_refs, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      input.id,
      input.projectId,
      input.taskId ?? null,
      input.runId ?? null,
      input.source,
      input.kind,
      JSON.stringify(input.payload),
      input.dedupeKey ?? null,
      JSON.stringify([...(input.evidenceRefs ?? [])]),
      input.status ?? "pending",
      input.createdAt ?? utcnow(),
    );
  return Number(result.changes) > 0;
}

export interface ProposalFilters {
  status?: ProposalStatus;
  kind?: ProposalKind;
}

export function listProjectProposals(
  conn: Database,
  projectId: string,
  filters: ProposalFilters = {},
): Proposal[] {
  getProjectOr404(conn, projectId);
  const clauses = ["project_id = ?"];
  const params: Array<string> = [projectId];
  if (filters.status !== undefined) {
    clauses.push("status = ?");
    params.push(filters.status);
  }
  if (filters.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(filters.kind);
  }
  const rows = conn
    .query(
      `SELECT * FROM proposals WHERE ${clauses.join(" AND ")}
       ORDER BY created_at, id`,
    )
    .all(...params) as ProposalRow[];
  return rows.map(proposalFromRow);
}

export function getProposal(
  conn: Database,
  projectId: string,
  proposalId: string,
): Proposal | null {
  const row = get<ProposalRow>(
    conn,
    "SELECT * FROM proposals WHERE id = ? AND project_id = ?",
    proposalId,
    projectId,
  );
  return row === null ? null : proposalFromRow(row);
}

export interface ProposalDecisionInput {
  status: Exclude<ProposalStatus, "pending">;
  reason?: string | null;
  appliedId?: string | null;
  reviewedAt?: string;
}

/**
 * Transitions a pending proposal exactly once. Returns false when another review already
 * claimed it or the row no longer exists.
 */
export function recordProposalDecision(
  conn: Database,
  projectId: string,
  proposalId: string,
  decision: ProposalDecisionInput,
): boolean {
  const result = conn
    .query(
      `
      UPDATE proposals
      SET status = ?, decision_reason = ?, applied_id = ?, reviewed_at = ?
      WHERE id = ? AND project_id = ? AND status = 'pending'
      `,
    )
    .run(
      decision.status,
      decision.reason ?? null,
      decision.appliedId ?? null,
      decision.reviewedAt ?? utcnow(),
      proposalId,
      projectId,
    );
  return Number(result.changes) > 0;
}

export function listPendingProposals(conn: Database, projectId: string): Proposal[] {
  const rows = all<ProposalRow>(
    conn,
    "SELECT * FROM proposals WHERE project_id = ? AND status = 'pending' ORDER BY created_at, id",
    projectId,
  );
  return rows.map(proposalFromRow);
}

export interface RecordIntentMetaInput {
  projectId: string;
  intentId: string;
  dedupeKey?: string | null;
  source?: string | null;
  proposalId?: string | null;
  originRunId?: string | null;
  priority?: number | null;
  budget?: string | null;
  createdAt?: string;
}

export function recordIntentMeta(conn: Database, input: RecordIntentMetaInput): void {
  run(
    conn,
    `
    INSERT OR REPLACE INTO intent_meta
        (project_id, intent_id, dedupe_key, source, proposal_id, origin_run_id,
         priority, budget, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    input.projectId,
    input.intentId,
    input.dedupeKey ?? null,
    input.source ?? null,
    input.proposalId ?? null,
    input.originRunId ?? null,
    input.priority ?? null,
    input.budget ?? null,
    input.createdAt ?? utcnow(),
  );
}

export function getIntentMeta(
  conn: Database,
  projectId: string,
  intentId: string,
): IntentMeta | null {
  const row = get<IntentMetaRow>(
    conn,
    "SELECT * FROM intent_meta WHERE project_id = ? AND intent_id = ?",
    projectId,
    intentId,
  );
  return row === null ? null : intentMetaFromRow(row);
}

/** All sidecar metadata for one project; used to order dispatchable intents. */
export function listProjectIntentMeta(
  conn: Database,
  projectId: string,
): IntentMeta[] {
  getProjectOr404(conn, projectId);
  const rows = all<IntentMetaRow>(
    conn,
    "SELECT * FROM intent_meta WHERE project_id = ? ORDER BY intent_id",
    projectId,
  );
  return rows.map(intentMetaFromRow);
}

interface IntentMetaRow {
  project_id: string;
  intent_id: string;
  dedupe_key: string | null;
  source: string | null;
  proposal_id: string | null;
  origin_run_id: string | null;
  priority: number | null;
  budget: string | null;
  created_at: string;
}

function intentMetaFromRow(row: IntentMetaRow): IntentMeta {
  return {
    project_id: row.project_id,
    intent_id: row.intent_id,
    dedupe_key: row.dedupe_key,
    source: row.source,
    proposal_id: row.proposal_id,
    origin_run_id: row.origin_run_id,
    priority:
      typeof row.priority === "number" &&
      Number.isInteger(row.priority) &&
      row.priority >= 0 &&
      row.priority <= 100
        ? row.priority
        : null,
    budget: parseIntentBudget(row.budget),
    created_at: row.created_at,
  };
}

/**
 * Sidecar budget JSON is written by the control plane, but older databases and manual
 * edits can contain anything. Unknown or malformed fields are ignored rather than
 * letting a bad row break dispatch.
 */
function parseIntentBudget(text: string | null): IntentBudget | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const budget: IntentBudget = {};
  const seconds = record["max_seconds"];
  if (typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0) {
    budget.max_seconds = seconds;
  }
  const calls = record["max_tool_calls"];
  if (typeof calls === "number" && Number.isInteger(calls) && calls > 0) {
    budget.max_tool_calls = calls;
  }
  return Object.keys(budget).length === 0 ? null : budget;
}

/** An open intent already covering the same direction, if one exists. */
export function findOpenIntentByDedupeKey(
  conn: Database,
  projectId: string,
  dedupeKey: string,
): Intent | null {
  const row = get<IntentRow>(
    conn,
    `
    SELECT i.*
    FROM intents i
    JOIN intent_meta m
      ON m.intent_id = i.id AND m.project_id = i.project_id
    WHERE i.project_id = ? AND i.to_fact_id IS NULL AND m.dedupe_key = ?
    LIMIT 1
    `,
    projectId,
    dedupeKey,
  );
  return row === null ? null : intentWithSources(conn, projectId, row);
}

export type IntentDuplicateReason = "dedupe_key" | "description";

export interface OpenIntentDuplicate {
  intent: Intent;
  reason: IntentDuplicateReason;
}

/** Shorter text is too easy to collide on, so it is never judged a duplicate. */
const MIN_DUPLICATE_DESCRIPTION_CHARS = 10;
const DUPLICATE_JACCARD = 0.9;
const DUPLICATE_LENGTH_RATIO = 0.75;

/**
 * Normalizes a direction description for duplicate detection: compatibility form,
 * lowercase, then whitespace and punctuation removed. Character bigrams make the
 * comparison work for Chinese as well as space-separated languages.
 */
export function normalizeIntentDescription(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, "");
}

/**
 * Two open intents collide when they share an explicit dedupe key, or when their
 * descriptions are near-identical after normalization. The description check keeps the
 * graph from growing parallel directions that differ only by wording, without needing
 * the model to remember to set a key.
 */
export function findDuplicateOpenIntent(
  conn: Database,
  projectId: string,
  check: { dedupeKey?: string | null; description: string },
): OpenIntentDuplicate | null {
  const rows = all<IntentRow & { meta_dedupe_key: string | null }>(
    conn,
    `
    SELECT i.*, m.dedupe_key AS meta_dedupe_key
    FROM intents i
    LEFT JOIN intent_meta m
      ON m.intent_id = i.id AND m.project_id = i.project_id
    WHERE i.project_id = ? AND i.to_fact_id IS NULL
    ORDER BY i.created_at, i.id
    `,
    projectId,
  );
  const dedupeKey = check.dedupeKey?.trim() ?? "";
  if (dedupeKey !== "") {
    const keyed = rows.find((row) => row.meta_dedupe_key === dedupeKey);
    if (keyed !== undefined) {
      return { intent: intentWithSources(conn, projectId, keyed), reason: "dedupe_key" };
    }
  }

  const target = normalizeIntentDescription(check.description);
  if (target.length < MIN_DUPLICATE_DESCRIPTION_CHARS) return null;
  const targetGrams = bigrams(target);
  for (const row of rows) {
    const other = normalizeIntentDescription(row.description);
    if (other.length < MIN_DUPLICATE_DESCRIPTION_CHARS) continue;
    const shorter = Math.min(target.length, other.length);
    const longer = Math.max(target.length, other.length);
    if (shorter / longer < DUPLICATE_LENGTH_RATIO) continue;
    if (jaccardSimilarity(targetGrams, bigrams(other)) >= DUPLICATE_JACCARD) {
      return { intent: intentWithSources(conn, projectId, row), reason: "description" };
    }
  }
  return null;
}

function intentWithSources(conn: Database, projectId: string, row: IntentRow): Intent {
  const sources = all<{ fact_id: string }>(
    conn,
    "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
    row.id,
    projectId,
  ).map((source) => source.fact_id);
  return {
    id: row.id,
    from: sources,
    to: row.to_fact_id,
    description: row.description,
    creator: row.creator,
    worker: row.worker,
    last_heartbeat_at: row.last_heartbeat_at,
    created_at: row.created_at,
    concluded_at: row.concluded_at,
  };
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    grams.add(text.slice(index, index + 2));
  }
  return grams;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

/** An already-applied proposal with the same direction, used for cross-kind/fact dedupe. */
export function findAppliedProposalByDedupeKey(
  conn: Database,
  projectId: string,
  kind: ProposalKind,
  dedupeKey: string,
): Proposal | null {
  const row = get<ProposalRow>(
    conn,
    `
    SELECT * FROM proposals
    WHERE project_id = ? AND kind = ? AND dedupe_key = ? AND status = 'applied'
    ORDER BY reviewed_at DESC, id
    LIMIT 1
    `,
    projectId,
    kind,
    dedupeKey,
  );
  return row === null ? null : proposalFromRow(row);
}

/** Exact-description duplicate check for facts (the graph has no unique constraint). */
export function findFactByDescription(
  conn: Database,
  projectId: string,
  description: string,
): { id: string } | null {
  return get<{ id: string }>(
    conn,
    "SELECT id FROM facts WHERE project_id = ? AND description = ? LIMIT 1",
    projectId,
    description,
  );
}

export function findHintByContent(
  conn: Database,
  projectId: string,
  content: string,
): { id: string } | null {
  return get<{ id: string }>(
    conn,
    "SELECT id FROM hints WHERE project_id = ? AND content = ? LIMIT 1",
    projectId,
    content,
  );
}

interface ProposalRow {
  id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  source: string;
  kind: string;
  payload: string;
  dedupe_key: string | null;
  evidence_refs: string;
  status: string;
  decision_reason: string | null;
  applied_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface IntentRow {
  id: string;
  project_id: string;
  to_fact_id: string | null;
  description: string;
  creator: string;
  worker: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  concluded_at: string | null;
}

function proposalFromRow(row: ProposalRow): Proposal {
  return {
    id: row.id,
    project_id: row.project_id,
    task_id: row.task_id,
    run_id: row.run_id,
    source: row.source as ProposalSource,
    kind: row.kind as ProposalKind,
    payload: parseObject(row.payload),
    dedupe_key: row.dedupe_key,
    evidence_refs: parseStringArray(row.evidence_refs),
    status: row.status as ProposalStatus,
    decision_reason: row.decision_reason,
    applied_id: row.applied_id,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}
