/**
 * Per-worker and per-model run statistics for one project (M14d).
 *
 * This is a read-only view over the `runs` sidecar. It deliberately keeps raw outcome
 * counts instead of a single score: worker selection needs to distinguish failed,
 * rejected, cancelled and still-running attempts, and a model with no finished run must
 * not look like a model with a 0% success rate.
 */

import type { Database } from "bun:sqlite";

import type {
  ModelRunStats,
  ProfileRunStats,
  ProjectRunStatsReport,
  Run,
  RunStatsGroup,
  WorkerRunStats,
} from "./models";
import { listAllRuns, listProjectRuns } from "./runs";

interface MutableGroup {
  runs: number;
  running: number;
  finished: number;
  succeeded: number;
  failed: number;
  rejected: number;
  cancelled: number;
  unhealthy: number;
  inactive: number;
  tokens: number;
  costUsd: number;
  durationSum: number;
  durationCount: number;
  evidenceCount: number;
  lastStartedAt: string | null;
}

export function buildProjectRunStats(conn: Database, projectId: string): ProjectRunStatsReport {
  const runs = listProjectRuns(conn, projectId);
  const totals = emptyGroup();
  const workers = new Map<string, MutableGroup>();
  const models = new Map<string, MutableGroup>();
  const profiles = new Map<string, MutableGroup>();

  for (const run of runs) {
    addRun(totals, run);
    addRun(groupFor(workers, run.worker), run);
    addRun(groupFor(models, run.model ?? ""), run);
    if (run.worker_profile !== null) {
      addRun(groupFor(profiles, run.worker_profile), run);
    }
  }

  return {
    project_id: projectId,
    totals: finishGroup(totals),
    by_worker: [...workers.entries()]
      .map(([worker, group]): WorkerRunStats => ({ worker, ...finishGroup(group) }))
      .sort((left, right) => left.worker.localeCompare(right.worker)),
    by_model: [...models.entries()]
      .map(([model, group]): ModelRunStats => ({
        model: model === "" ? null : model,
        ...finishGroup(group),
      }))
      .sort(compareModels),
    by_profile: finishProfiles(profiles),
  };
}

/**
 * Cross-project profile history. Selection uses it as the sample set; untagged prompt-mode
 * runs are excluded because they cannot inform a profile choice.
 */
export function buildProfileRunStats(conn: Database): ProfileRunStats[] {
  const profiles = new Map<string, MutableGroup>();
  for (const run of listAllRuns(conn)) {
    if (run.worker_profile === null) continue;
    addRun(groupFor(profiles, run.worker_profile), run);
  }
  return finishProfiles(profiles);
}

function finishProfiles(groups: Map<string, MutableGroup>): ProfileRunStats[] {
  return [...groups.entries()]
    .map(([worker_profile, group]): ProfileRunStats => ({
      worker_profile,
      ...finishGroup(group),
    }))
    .sort((left, right) => left.worker_profile.localeCompare(right.worker_profile));
}

function emptyGroup(): MutableGroup {
  return {
    runs: 0,
    running: 0,
    finished: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
    unhealthy: 0,
    inactive: 0,
    tokens: 0,
    costUsd: 0,
    durationSum: 0,
    durationCount: 0,
    evidenceCount: 0,
    lastStartedAt: null,
  };
}

function groupFor(groups: Map<string, MutableGroup>, key: string): MutableGroup {
  const existing = groups.get(key);
  if (existing !== undefined) return existing;
  const created = emptyGroup();
  groups.set(key, created);
  return created;
}

function addRun(group: MutableGroup, run: Run): void {
  group.runs += 1;
  group.tokens += run.total_tokens;
  group.costUsd += run.cost_usd;
  group.evidenceCount += run.evidence_count;
  if (group.lastStartedAt === null || run.started_at > group.lastStartedAt) {
    group.lastStartedAt = run.started_at;
  }
  if (run.outcome === null) {
    group.running += 1;
    return;
  }
  group.finished += 1;
  if (run.duration_ms !== null) {
    group.durationSum += run.duration_ms;
    group.durationCount += 1;
  }
  switch (run.outcome) {
    case "success":
      group.succeeded += 1;
      break;
    case "failed":
      group.failed += 1;
      break;
    case "rejected":
      group.rejected += 1;
      break;
    case "cancelled":
      group.cancelled += 1;
      break;
    case "unhealthy":
      group.unhealthy += 1;
      break;
    case "inactive":
      group.inactive += 1;
      break;
  }
}

function finishGroup(group: MutableGroup): RunStatsGroup {
  return {
    runs: group.runs,
    running: group.running,
    finished: group.finished,
    succeeded: group.succeeded,
    failed: group.failed,
    rejected: group.rejected,
    cancelled: group.cancelled,
    unhealthy: group.unhealthy,
    inactive: group.inactive,
    success_rate: group.finished === 0 ? null : group.succeeded / group.finished,
    tokens: group.tokens,
    cost_usd: roundCost(group.costUsd),
    avg_duration_ms:
      group.durationCount === 0 ? null : Math.round(group.durationSum / group.durationCount),
    evidence_count: group.evidenceCount,
    last_started_at: group.lastStartedAt,
  };
}

function compareModels(left: ModelRunStats, right: ModelRunStats): number {
  if (left.model === null) return right.model === null ? 0 : 1;
  if (right.model === null) return -1;
  return left.model.localeCompare(right.model);
}

/** Match cost attribution's nano-dollar rounding so both views agree on totals. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}
