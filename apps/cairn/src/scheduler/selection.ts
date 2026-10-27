/**
 * Stats-driven worker profile selection (M15a, epsilon exploration in M15e).
 *
 * The policy is deterministic so a dispatch is reproducible from the run history: sample
 * every profile up to `min_runs` finished runs in config order, then exploit the highest
 * observed success rate. Ties prefer fewer tokens per finished run, then lower cost, then
 * config order.
 *
 * M15e inserts a decaying epsilon-greedy exploration schedule between sampling and
 * exploitation. The schedule derives from the number of finished runs after every profile
 * reached `min_runs`, not from a random source: the expected number of explorations is the
 * cumulative sum of the effective epsilon, and a dispatch explores when that sum crosses
 * an integer. Exploration picks the least-sampled configured profile (config order on a
 * tie), so evidence stays balanced instead of locking onto an early leader.
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
      (profile) => finishedFor(profile, byProfile) < selection.minRuns,
    );
    if (rookie !== undefined) return rookie;
  }

  const eligibleRuns = eligibleFinishedRuns(profiles, byProfile, selection);
  if (explorationDue(selection, eligibleRuns)) {
    return leastSampled(profiles, byProfile);
  }

  let best = profiles[0]!;
  for (const candidate of profiles.slice(1)) {
    if (isBetter(candidate, best, byProfile)) best = candidate;
  }
  return best;
}

/**
 * Finished dispatches since every configured profile reached `min_runs`. This is the
 * clock for the exploration schedule; a newly added profile resets it by raising the
 * baseline.
 */
export function eligibleFinishedRuns(
  profiles: readonly WorkerProfileConfig[],
  byProfile: ReadonlyMap<string, ProfileRunStats>,
  selection: WorkerSelectionConfig,
): number {
  const total = profiles.reduce(
    (sum, profile) => sum + finishedFor(profile, byProfile),
    0,
  );
  return Math.max(0, total - selection.minRuns * profiles.length);
}

/** Exploration probability at one eligible dispatch after `eligibleRuns` steps of decay. */
export function effectiveEpsilon(
  selection: WorkerSelectionConfig,
  eligibleRuns: number,
): number {
  if (selection.epsilon <= 0) return 0;
  const decayed =
    selection.epsilon *
    Math.pow(selection.epsilonDecay, Math.max(0, eligibleRuns));
  return Math.max(selection.epsilonMin, decayed);
}

/**
 * Expected number of explorations over `eligibleRuns` eligible dispatches. A geometric
 * sum handles the decaying part analytically; everything after the epsilon reaches its
 * floor contributes `epsilonMin` per dispatch.
 */
export function explorationBudget(
  selection: WorkerSelectionConfig,
  eligibleRuns: number,
): number {
  if (eligibleRuns <= 0 || selection.epsilon <= 0) return 0;
  const { epsilon, epsilonDecay: decay, epsilonMin } = selection;
  if (decay >= 1) return epsilon * eligibleRuns;

  let decayedSteps = eligibleRuns;
  if (epsilonMin > 0) {
    const crossing = Math.ceil(
      Math.log(epsilonMin / epsilon) / Math.log(decay),
    );
    if (Number.isFinite(crossing)) {
      decayedSteps = Math.min(eligibleRuns, Math.max(0, crossing));
    }
  }
  const geometric = (epsilon * (1 - Math.pow(decay, decayedSteps))) / (1 - decay);
  const floored = Math.max(0, eligibleRuns - decayedSteps) * epsilonMin;
  return geometric + floored;
}

/** True when this eligible dispatch is scheduled to explore. */
export function explorationDue(
  selection: WorkerSelectionConfig,
  eligibleRuns: number,
): boolean {
  return (
    Math.floor(explorationBudget(selection, eligibleRuns + 1)) >
    Math.floor(explorationBudget(selection, eligibleRuns))
  );
}

function finishedFor(
  profile: WorkerProfileConfig,
  byProfile: ReadonlyMap<string, ProfileRunStats>,
): number {
  return byProfile.get(profile.id)?.finished ?? 0;
}

function leastSampled(
  profiles: readonly WorkerProfileConfig[],
  byProfile: ReadonlyMap<string, ProfileRunStats>,
): WorkerProfileConfig {
  let chosen = profiles[0]!;
  let finished = finishedFor(chosen, byProfile);
  for (const profile of profiles.slice(1)) {
    const candidate = finishedFor(profile, byProfile);
    if (candidate < finished) {
      chosen = profile;
      finished = candidate;
    }
  }
  return chosen;
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
