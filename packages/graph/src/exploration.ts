/** M52a/b: deterministic read models only. Never a dispatch gate or a hypothesis verdict. */
import { createHash } from "node:crypto";
import { EXPERIMENT_FIELDS, type ExperimentContract } from "@cairn/contracts";
import type { SnapshotAttempt, SnapshotIntent, TaskContextSnapshot } from "./context-snapshot";

export type ExplorationStatus = "new_observation" | "repeated_observation" | "interpretation_only" |
  "no_observation" | "operationally_incomplete" | "unknown";
export interface ExplorationProgress {
  version: 1;
  mode: "observe_only";
  status: ExplorationStatus;
  reason: string | null;
  plan_fingerprint: string | null;
  checkpoint_sequence: number | null;
  observations: { new: number; repeated: number };
  /** Across comparable finished runs, not checkpoint saves. Unknown breaks continuity; faults are skipped. */
  consecutive_without_new_observation: number | null;
  hypothesis_verdict: "unknown";
}
interface Peers { count: number; intent_ids: string[]; omitted: number }
export interface ExplorationSummary {
  version: 1;
  mode: "observe_only";
  plan_fingerprint: string | null;
  proposal_fingerprint: string | null;
  same_plan: Peers;
  same_proposal: Peers;
  history_scope: "same_plan_in_current_project_scope";
  counts: Record<ExplorationStatus, number>;
  consecutive_without_new_observation: number | null;
  latest: { run_id: string; intent_id: string | null; status: ExplorationStatus } | null;
  advisory: "same_plan_recorded" | "review_without_new_observation" | "need_observation" | "none";
  hypothesis_verdict: "unknown";
}
const normalize = (value: string): string => value.replace(/\r\n?/g, "\n").trim();
const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const plan = (value: ExperimentContract) => EXPERIMENT_FIELDS.map(field => normalize(value[field]));

/** Cosmetic boundary whitespace/line endings only; preserve case, internal spaces, quotes and array values. */
export function explorationPlanFingerprint(projectId: string, scopeTargets: readonly string[] | undefined,
  from: readonly string[], experiment: ExperimentContract): string | null {
  if (scopeTargets === undefined || scopeTargets.length === 0) return null;
  return digest(["m52-plan-v1", projectId, sorted(scopeTargets), sorted(from), experiment.version, plan(experiment)]);
}
function proposalFingerprint(intent: SnapshotIntent, fingerprint: string | null): string | null {
  if (fingerprint === null) return null;
  const review = intent.experiment_review;
  const refs = review?.observations.map(ref => JSON.stringify([ref.run_id, ref.checkpoint_sequence, ref.attempt_id])).sort() ?? [];
  // choice/rationale/description/priority are not new experimental inputs. Source and exact refs are.
  return digest(["m52-proposal-v1", fingerprint, review?.source_intent_id ?? null, refs]);
}
const emptyCounts = (): Record<ExplorationStatus, number> => ({ new_observation: 0, repeated_observation: 0,
  interpretation_only: 0, no_observation: 0, operationally_incomplete: 0, unknown: 0 });
const operationalResults = new Set(["tool_failure", "environment_failure", "timeout", "cancelled", "scope_denied", "not_executed"]);

function compareRun(snapshot: TaskContextSnapshot, intent: SnapshotIntent, attempt: SnapshotAttempt,
  fingerprint: string | null, seen: Set<string>, finishedAt: ReadonlyMap<string, string>, currentFacts: ReadonlySet<string>): ExplorationProgress {
  const memory = attempt.memory;
  const result: ExplorationProgress = { version: 1, mode: "observe_only", status: "unknown", reason: null,
    plan_fingerprint: fingerprint, checkpoint_sequence: memory?.sequence ?? null,
    observations: { new: 0, repeated: 0 }, consecutive_without_new_observation: null, hypothesis_verdict: "unknown" };
  const stop = (status: ExplorationStatus, reason: string) => Object.assign(result, { status, reason });
  if (attempt.failure !== undefined || memory?.control.failure !== undefined || attempt.outcome !== "success" ||
      (memory !== undefined && (memory.control.outcome !== "success" ||
        (memory.control.termination_reason !== null && memory.control.termination_reason !== "finished")))) {
    return stop("operationally_incomplete", "run_not_normally_successful");
  }
  if (!Number.isFinite(Date.parse(finishedAt.get(attempt.run_id) ?? ""))) return stop("unknown", "completion_time_unknown");
  if (memory === undefined) return stop("unknown", "checkpoint_missing");
  if (memory.control.termination_reason !== "finished") return stop("unknown", "termination_unknown");
  const checkpoint = memory.checkpoint;
  if (checkpoint.project_id !== snapshot.project.id || checkpoint.intent_id !== intent.id ||
      checkpoint.sequence !== memory.sequence) return stop("unknown", "checkpoint_identity_mismatch");
  if (checkpoint.attempts.some(item => operationalResults.has(item.result))) {
    return stop("operationally_incomplete", "checkpoint_reports_operational_error");
  }
  if (memory.experiment_plan === undefined) return stop("unknown", "dispatch_plan_missing");
  if (JSON.stringify(plan(memory.experiment_plan)) !== JSON.stringify(plan(intent.experiment!))) return stop("unknown", "dispatch_plan_changed");
  if (fingerprint === null || memory.reuse.scope_status !== "unchanged_requires_authorization") return stop("unknown", "scope_changed_or_unknown");
  if (memory.reuse.facts.some(fact => fact.status !== "current") ||
      intent.from.some(id => !currentFacts.has(id))) {
    return stop("unknown", "fact_changed_or_missing");
  }
  const observations = checkpoint.attempts.filter(item => normalize(item.observation) !== "");
  const evidence = new Map(memory.reuse.evidence.map(item => [item.ref, item.status]));
  if (observations.some(item => item.result !== "observed" && item.result !== "negative_observation")) return stop("unknown", "observation_inconclusive");
  if (observations.some(item => item.evidence_refs.length === 0 || item.evidence_refs.some(ref => evidence.get(ref) !== "available"))) {
    return stop("unknown", "observation_evidence_unavailable");
  }
  // New filenames, IDs, interpretations and checkpoint versions alone are NOT new observations.
  // This compares reports, not evidence bytes, target state, causality or scientific information gain.
  const keys = new Set(observations.map(item => digest(["m52-observation-v1", normalize(item.action),
    normalize(item.observation), item.result, sorted(item.fact_refs)])));
  for (const key of keys) {
    if (seen.has(key)) result.observations.repeated++;
    else result.observations.new++;
  }
  for (const key of keys) seen.add(key);
  result.status = keys.size > 0 ? (result.observations.new > 0 ? "new_observation" : "repeated_observation")
    : checkpoint.attempts.some(item => normalize(item.interpretation) !== "") ? "interpretation_only" : "no_observation";
  return result;
}

/** Reconstructed from durable run/checkpoint history on every read; never writes counters or graph data. */
export function projectExploration(snapshot: TaskContextSnapshot, scopeTargets: readonly string[] | undefined,
  finishedAt: ReadonlyMap<string, string>): Pick<TaskContextSnapshot, "intents" | "attempts"> {
  const identities = new Map(snapshot.intents.filter(intent => intent.experiment !== undefined).map(intent => {
    const fingerprint = explorationPlanFingerprint(snapshot.project.id, scopeTargets, intent.from, intent.experiment!);
    return [intent.id, { intent, fingerprint, proposal: proposalFingerprint(intent, fingerprint) }] as const;
  }));
  const plans = new Map<string, string[]>(), proposals = new Map<string, string[]>();
  for (const { intent, fingerprint, proposal } of identities.values()) {
    for (const [key, groups] of [[fingerprint, plans], [proposal, proposals]] as const) {
      if (key !== null) { const group = groups.get(key) ?? []; group.push(intent.id); groups.set(key, group); }
    }
  }
  for (const groups of [plans, proposals]) for (const group of groups.values()) group.sort();
  const peers = (id: string, key: string | null, groups: Map<string, string[]>): Peers => {
    const group = key === null ? [] : groups.get(key) ?? [];
    const count = Math.max(0, group.length - 1);
    return { count, intent_ids: group.slice(0, 9).filter(other => other !== id).slice(0, 8), omitted: Math.max(0, count - 8) };
  };
  interface History { seen: Set<string>; counts: Record<ExplorationStatus, number>; streak: number | null;
    latest: ExplorationSummary["latest"] }
  const currentFacts = new Set(snapshot.facts.filter(fact => fact.status === "current").map(fact => fact.id));
  const histories = new Map<string, History>(), progress = new Map<string, ExplorationProgress>();
  const groupKey = (id: string) => identities.get(id)!.fingerprint ?? `unknown:${id}`;
  // Completion order, not start order: concurrent tasks may finish in the opposite order.
  // An unorderable historical completion is conservative: break continuity after known records.
  const completionTime = (id: string) => {
    const value = Date.parse(finishedAt.get(id) ?? "");
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  const attempts = [...snapshot.attempts].sort((a, b) =>
    completionTime(a.run_id) - completionTime(b.run_id) ||
    a.started_at.localeCompare(b.started_at) || a.run_id.localeCompare(b.run_id));
  for (const attempt of attempts) {
    const identity = attempt.intent_id === null ? undefined : identities.get(attempt.intent_id);
    if (identity === undefined) continue;
    const key = groupKey(identity.intent.id);
    const history = histories.get(key) ?? { seen: new Set<string>(), counts: emptyCounts(), streak: null, latest: null };
    const item = compareRun(snapshot, identity.intent, attempt, identity.fingerprint, history.seen, finishedAt, currentFacts);
    history.counts[item.status]++;
    if (item.status === "new_observation") history.streak = 0;
    else if (item.status === "unknown") history.streak = null;
    else if (item.status !== "operationally_incomplete") history.streak = (history.streak ?? 0) + 1;
    item.consecutive_without_new_observation = history.streak;
    history.latest = { run_id: attempt.run_id, intent_id: attempt.intent_id, status: item.status };
    histories.set(key, history); progress.set(attempt.run_id, item);
  }
  return {
    intents: snapshot.intents.map(intent => {
      const identity = identities.get(intent.id);
      if (identity === undefined) return intent;
      const history = histories.get(groupKey(intent.id));
      const samePlan = peers(intent.id, identity.fingerprint, plans);
      const latest = history?.latest ?? null;
      const advisory: ExplorationSummary["advisory"] = latest?.status === "unknown" || latest?.status === "operationally_incomplete"
        ? "need_observation" : latest !== null && latest.status !== "new_observation" ? "review_without_new_observation"
        : samePlan.count > 0 ? "same_plan_recorded" : "none";
      const exploration: ExplorationSummary = { version: 1, mode: "observe_only", plan_fingerprint: identity.fingerprint,
        proposal_fingerprint: identity.proposal, same_plan: samePlan, same_proposal: peers(intent.id, identity.proposal, proposals),
        history_scope: "same_plan_in_current_project_scope", counts: history?.counts ?? emptyCounts(),
        consecutive_without_new_observation: history?.streak ?? null, latest, advisory, hypothesis_verdict: "unknown" };
      return { ...intent, exploration };
    }),
    attempts: snapshot.attempts.map(attempt => progress.has(attempt.run_id)
      ? { ...attempt, exploration: progress.get(attempt.run_id)! } : attempt),
  };
}
