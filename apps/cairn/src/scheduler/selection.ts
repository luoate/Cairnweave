/**
 * Stats-driven worker profile selection (M15a).
 *
 * The policy is deliberately simple and deterministic so a dispatch is reproducible from
 * the run history: sample every profile up to `min_runs` finished runs in config order,
 * then exploit the highest observed success rate. Ties prefer fewer tokens per finished
 * run, then lower cost, then config order.
 */

import type { ProfileRunStats } from "@cairn/graph";

import type { WorkerProfileConfig, WorkerSelectionConfig } from "../config";

/**
 * Returns null when selection is disabled (prompt mode or no profiles), which keeps the
 * prompt-declared model and leaves the run untagged. A known preferred profile (queued
 * conclude) wins so the salvage turn reuses the model that produced the session.
 */
export function selectWorkerProfile(
  profiles: readonly WorkerProfileConfig[],
  selection: WorkerSelectionConfig,
  stats: readonly ProfileRunStats[],
  preferredProfileId?: string | null,
): WorkerProfileConfig | null {
  if (selection.mode !== "stats" || profiles.length === 0) return null;

  if (preferredProfileId !== undefined && preferredProfileId !== null) {
    const preferred = profiles.find((profile) => profile.id === preferredProfileId);
    if (preferred !== undefined) return preferred;
  }

  const byProfile = new Map(stats.map((row) => [row.worker_profile, row]));

  if (selection.minRuns > 0) {
    const rookie = profiles.find(
      (profile) => (byProfile.get(profile.id)?.finished ?? 0) < selection.minRuns,
    );
    if (rookie !== undefined) return rookie;
  }

  let best = profiles[0]!;
  for (const candidate of profiles.slice(1)) {
    if (isBetter(candidate, best, byProfile)) best = candidate;
  }
  return best;
}

function isBetter(
  candidate: WorkerProfileConfig,
  current: WorkerProfileConfig,
  byProfile: ReadonlyMap<string, ProfileRunStats>,
): boolean {
  const left = score(byProfile.get(candidate.id));
  const right = score(byProfile.get(current.id));
  if (left.successRate !== right.successRate) {
    return left.successRate > right.successRate;
  }
  if (left.avgTokens !== right.avgTokens) return left.avgTokens < right.avgTokens;
  if (left.avgCost !== right.avgCost) return left.avgCost < right.avgCost;
  return false;
}

interface ProfileScore {
  successRate: number;
  avgTokens: number;
  avgCost: number;
}

function score(row: ProfileRunStats | undefined): ProfileScore {
  if (row === undefined || row.finished === 0) {
    return { successRate: -1, avgTokens: Infinity, avgCost: Infinity };
  }
  return {
    successRate: row.success_rate ?? 0,
    avgTokens: row.tokens / row.finished,
    avgCost: row.cost_usd / row.finished,
  };
}
