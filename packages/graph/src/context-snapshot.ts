import { attachAttemptMemories, type AttemptMemory, type AttemptMemoryOptions } from "./checkpoints";
/** M48: an uncapped, explicitly whitelisted worker-visible projection, not a DB export. */
import type { Database } from "bun:sqlite";
import { all } from "./db";
import { buildAgentContext, type BuildAgentContextOptions } from "./agent-context";
import { getProjectDetail } from "./commands";
import type { AgentContext, AgentContextFact, AgentContextIntent, Hint } from "./models";
import { listProjectIntentMeta } from "./proposals";
import { getFactMeta } from "./runs";
import { summarizeProjectVerification } from "./verification";
import { projectExploration, type ExplorationProgress, type ExplorationSummary } from "./exploration";

export interface SnapshotFact extends AgentContextFact {
  created_at: string | null;
  /** Exact fact_meta timestamp used by the existing timestamp delta selector. */
  metadata_created_at: string | null;
  /** Causal inputs, not supersede edges. */
  from: string[];
  evidence_refs: string[];
}
export interface SnapshotIntent extends AgentContextIntent {
  /** M52a/b read-only monitor; only on explicitly checkpoint-enriched snapshots. */
  exploration?: ExplorationSummary;
  to: string | null;
  worker: string | null;
  creator: string;
  created_at: string;
  concluded_at: string | null;
  dedupe_key: string | null;
  budget: { max_seconds?: number; max_tool_calls?: number } | null;
}
export type SnapshotAttempt = AgentContext["recent_attempts"][number] & {
  memory?: AttemptMemory;
  exploration?: ExplorationProgress;
};
export interface TaskContextSnapshot {
  version: 1;
  project: AgentContext["project"];
  goal: AgentContext["goal"];
  goal_conditions: Array<{ ordinal: number; kind: string; challenge_code: string | null; min: number | null }>;
  budget: AgentContext["budget"];
  delta: { since: string; new_facts: number; concluded_intents: number; new_hints: number; failed_attempts: number } | null;
  reviews: { flags: Record<string, number>; completion: Record<string, number> };
  facts: SnapshotFact[];
  intents: SnapshotIntent[];
  attempts: SnapshotAttempt[];
  hints: Hint[];
  /** Raw error/log text beyond the existing detail visibility policy is not exported. */
  detail_policy: "agent_context_500_chars";
}

export function buildTaskContextSnapshot(
  conn: Database, projectId: string,
  options: Pick<BuildAgentContextOptions, "generatedAt" | "verificationFallback" | "budget"> & { checkpoint?: AttemptMemoryOptions } = {},
): TaskContextSnapshot {
  // Never start from the already capped task AgentContext. Remove only record-count
  // selection limits, not its detail visibility policy.
  const full = buildAgentContext(conn, projectId, {
    ...options, kind: "reason", limits: {
      maxFacts: Number.MAX_SAFE_INTEGER, maxIntents: Number.MAX_SAFE_INTEGER,
      maxConcludedIntents: Number.MAX_SAFE_INTEGER, maxAbandonedIntents: Number.MAX_SAFE_INTEGER,
      maxAttempts: Number.MAX_SAFE_INTEGER, maxDeltaIds: Number.MAX_SAFE_INTEGER,
    },
  });
  const project = getProjectDetail(conn, projectId);
  const rawIntents = new Map(project.intents.map((intent) => [intent.id, intent]));
  const meta = new Map(listProjectIntentMeta(conn, projectId).map((entry) => [entry.intent_id, entry]));
  const producers = new Map(project.intents.filter((intent) => intent.to !== null).map((intent) => [intent.to!, intent]));
  const reviewCounts = (table: "flag_reviews" | "completion_reviews", statuses: readonly string[]) => {
    const counts: Record<string, number> = Object.fromEntries(statuses.map((status) => [status, 0]));
    for (const row of all<{ status: string; count: number }>(conn,
      `SELECT status, COUNT(*) AS count FROM ${table} WHERE project_id = ? GROUP BY status`, projectId)) {
      counts[row.status] = row.count;
    }
    return counts;
  };
  const snapshot: TaskContextSnapshot = {
    version: 1, project: full.project, goal: full.goal,
    goal_conditions: summarizeProjectVerification(conn, projectId, options.verificationFallback).goal_conditions
      .map(({ ordinal, kind, challenge_code, min }) => ({ ordinal, kind, challenge_code, min })),
    budget: full.budget,
    delta: full.delta === null ? null : { since: full.delta.since, new_facts: full.delta.new_facts.length,
      concluded_intents: full.delta.concluded_intents.length, new_hints: full.delta.new_hints,
      failed_attempts: full.delta.failed_attempts },
    reviews: {
      flags: reviewCounts("flag_reviews", ["pending", "real_more", "real_done", "fake", "dismissed"]),
      completion: reviewCounts("completion_reviews", ["pending", "approved", "rejected"]),
    },
    facts: full.facts.map((fact) => {
      const evidence = getFactMeta(conn, projectId, fact.id);
      const producer = producers.get(fact.id);
      return { ...fact, created_at: evidence?.created_at ?? producer?.concluded_at ?? null,
        metadata_created_at: evidence?.created_at ?? null,
        from: [...(producer?.from ?? [])],
        evidence_refs: (evidence?.evidence_refs ?? []).filter(safeRelativeRef) };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    intents: full.intents.map((intent) => {
      const raw = rawIntents.get(intent.id)!;
      const entry = meta.get(intent.id);
      return { ...intent, to: raw.to, worker: raw.worker, creator: raw.creator, created_at: raw.created_at,
        concluded_at: raw.concluded_at, dedupe_key: entry?.dedupe_key ?? null, budget: entry?.budget ?? null };
    }).sort((a, b) => a.id.localeCompare(b.id)),
    attempts: full.recent_attempts,
    hints: [...project.hints].sort((a, b) => a.id.localeCompare(b.id)),
    detail_policy: "agent_context_500_chars",
  };
  if (options.checkpoint !== undefined) {
    snapshot.attempts = attachAttemptMemories(conn, projectId,
      snapshot.attempts, snapshot.facts, snapshot.intents, snapshot.project.status, options.checkpoint);
    if (snapshot.intents.some(intent => intent.experiment !== undefined)) {
      const finishedAt = new Map(all<{ id: string; finished_at: string }>(conn,
        "SELECT id, finished_at FROM runs WHERE project_id = ? AND finished_at IS NOT NULL", projectId)
        .map(row => [row.id, row.finished_at]));
      Object.assign(snapshot, projectExploration(snapshot, options.checkpoint.scopeTargets, finishedAt));
    }
  }
  return snapshot;
}

function safeRelativeRef(value: string): boolean {
  return value.length > 0 && !/[\x00-\x1f\:]/.test(value) && !value.startsWith("/") &&
    !value.split("/").some((part) => part === ".." || part === "." || part === "");
}
