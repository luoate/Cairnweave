/**
 * Slow-layer trigger evaluation.
 *
 * Pure function so the policy can be unit-tested without a scheduler or database. The
 * caller supplies the current graph snapshot, persisted watermarks, recent productive
 * runs, and how many reason runs started in the last hour.
 */

import type {
  Intent,
  ProjectDetail,
  StrategistRunSummary,
  StrategistState,
} from "@cairn/graph";

import type { StrategistConfig } from "../config";

export type StrategistSuppression =
  | "failure_backoff"
  | "cooldown"
  | "rate_limit"
  | "tasks_running";

export interface StrategistEvaluation {
  /** Non-null when the scheduler should start a reason task. */
  trigger: string | null;
  /** Urgent triggers bypass the cooldown and hourly cap. */
  urgent: boolean;
  /** Why an otherwise-eligible trigger was held back. */
  suppressed: StrategistSuppression | null;
  zeroOutputStreak: number;
  factsDelta: number;
  hintsDelta: number;
  openIntentCount: number;
  staleIntentCount: number;
}

export interface EvaluateStrategistInput {
  project: ProjectDetail;
  state: StrategistState | null;
  /** Newest finished bootstrap/explore/conclude runs. */
  recentRuns: readonly StrategistRunSummary[];
  /** Reason runs started in the rolling hour (only needed when the cap is enabled). */
  reasonRunsLastHour: number;
  /** Running bootstrap/explore/conclude tasks for this project. */
  runningProductiveTasks: number;
  runningIntentIds: ReadonlySet<string>;
  now: Date;
  policy: StrategistConfig;
}

export function evaluateStrategistTrigger(
  input: EvaluateStrategistInput,
): StrategistEvaluation {
  const { project, state, policy, now } = input;
  const openIntents = project.intents.filter((intent) => intent.to === null);
  const factsDelta = delta(project.facts.length, state?.last_fact_count ?? 0);
  const hintsDelta = delta(project.hints.length, state?.last_hint_count ?? 0);
  const lastSuccess = state?.last_success_at ?? null;

  const zeroOutputStreak = countZeroOutputStreak(
    input.recentRuns,
    lastSuccess,
  );
  const staleIntentCount = countStaleIntents(
    openIntents,
    input.runningIntentIds,
    now,
    policy.staleIntentSeconds,
  );

  const evaluation = (
    trigger: string | null,
    urgent: boolean,
    suppressed: StrategistSuppression | null = null,
  ): StrategistEvaluation => ({
    trigger,
    urgent,
    suppressed,
    zeroOutputStreak,
    factsDelta,
    hintsDelta,
    openIntentCount: openIntents.length,
    staleIntentCount,
  });

  // A failed reason turn holds back every trigger, including urgent ones, so a crash
  // cannot turn into a per-tick retry storm.
  if (
    policy.failureBackoffSeconds > 0 &&
    state?.last_failure_at !== null &&
    state?.last_failure_at !== undefined
  ) {
    const elapsed = elapsedSeconds(now, state.last_failure_at);
    if (elapsed !== null && elapsed < policy.failureBackoffSeconds) {
      return evaluation(null, false, "failure_backoff");
    }
  }

  // The first reason turn seeds directions. If an unclaimed direction is already
  // waiting, let the fast layer explore it first; reason runs once the graph settles.
  const unseenInitial = state === null || state.last_success_at === null;
  // A leftover bootstrap intent is not fast-layer work for a project that has disabled
  // bootstrap; counting it would suppress every trigger and leave the project idle.
  const fastWorkPending = openIntents.some(
    (intent) =>
      intent.worker === null &&
      !(
        intent.description === "bootstrap" &&
        intent.creator === "dispatcher.bootstrap"
      ),
  );
  if (unseenInitial && fastWorkPending) {
    return evaluation(null, false);
  }
  const initial = unseenInitial;
  const initialTrigger = initial ? evaluation("initial", true) : null;

  // "All open intents are gone" is only urgent when the previous reason turn actually
  // left open intents behind. Otherwise a no-op reason that produced no intents would
  // retrigger itself on every tick; new facts still arrive via the graph-delta trigger.
  const openEmpty =
    !initial &&
    openIntents.length === 0 &&
    input.runningProductiveTasks === 0 &&
    (state?.last_open_intent_count ?? 0) > 0;

  const openEmptyTrigger = openEmpty
    ? evaluation(
        `open_intents:${state?.last_open_intent_count ?? 0}->0`,
        true,
      )
    : null;

  let candidate = initialTrigger ?? openEmptyTrigger;
  if (candidate === null) {
    if (
      policy.zeroOutputThreshold > 0 &&
      zeroOutputStreak >= policy.zeroOutputThreshold
    ) {
      candidate = evaluation(`zero_output:${zeroOutputStreak}`, false);
    } else if (
      policy.staleIntentSeconds > 0 &&
      openIntents.length > 0 &&
      staleIntentCount === openIntents.length
    ) {
      candidate = evaluation(`stale_intents:${staleIntentCount}`, false);
    } else if (
      (policy.minNewFacts > 0 && factsDelta >= policy.minNewFacts) ||
      (policy.minNewHints > 0 && hintsDelta >= policy.minNewHints)
    ) {
      candidate = evaluation(
        [
          factsDelta > 0 ? `facts:${state?.last_fact_count ?? 0}->${project.facts.length}` : null,
          hintsDelta > 0 ? `hints:${state?.last_hint_count ?? 0}->${project.hints.length}` : null,
        ]
          .filter((entry): entry is string => entry !== null)
          .join(","),
        false,
      );
    } else if (policy.fallbackIntervalSeconds > 0 && lastSuccess !== null) {
      const elapsed = elapsedSeconds(now, lastSuccess);
      if (elapsed !== null && elapsed >= policy.fallbackIntervalSeconds) {
        candidate = evaluation(`fallback:${Math.floor(elapsed)}s`, false);
      }
    }
  }

  if (candidate === null) return evaluation(null, false);

  // The slow layer looks at a settled graph. If another productive task is still
  // running, wait for it to finish instead of reasoning about a moving snapshot. This
  // includes the urgent initial turn: it must not race an explore that was just
  // dispatched from the same graph snapshot.
  if (input.runningProductiveTasks > 0) {
    return evaluation(null, false, "tasks_running");
  }

  if (!candidate.urgent) {
    const lastAttempt = state?.last_attempt_at ?? null;
    if (policy.cooldownSeconds > 0 && lastAttempt !== null) {
      const elapsed = elapsedSeconds(now, lastAttempt);
      if (elapsed !== null && elapsed < policy.cooldownSeconds) {
        return evaluation(null, false, "cooldown");
      }
    }
    if (
      policy.maxRunsPerHour > 0 &&
      input.reasonRunsLastHour >= policy.maxRunsPerHour
    ) {
      return evaluation(null, false, "rate_limit");
    }
  }

  return candidate;
}

function delta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

/** Newest-first runs: stop at the first fact-producing run or the last success watermark. */
export function countZeroOutputStreak(
  recentRuns: readonly StrategistRunSummary[],
  lastSuccessAt: string | null,
): number {
  let streak = 0;
  for (const run of recentRuns) {
    if (lastSuccessAt !== null && run.finished_at <= lastSuccessAt) break;
    if (run.produced_fact) break;
    streak += 1;
  }
  return streak;
}

function countStaleIntents(
  openIntents: readonly Intent[],
  runningIntentIds: ReadonlySet<string>,
  now: Date,
  staleSeconds: number,
): number {
  if (staleSeconds <= 0) return 0;
  let stale = 0;
  for (const intent of openIntents) {
    if (runningIntentIds.has(intent.id)) continue;
    const reference = intent.last_heartbeat_at ?? intent.created_at;
    const elapsed = elapsedSeconds(now, reference);
    if (elapsed !== null && elapsed >= staleSeconds) stale += 1;
  }
  return stale;
}

function elapsedSeconds(now: Date, isoTimestamp: string): number | null {
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 1000);
}
