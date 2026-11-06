/** M52c: bounded priority preference, never a dispatch veto or a hypothesis verdict. */
import type { TaskContextSnapshot } from "./context-snapshot";
export const EXPLORATION_SOFT_LIMITS = { threshold: 3, max_penalty: 20, window_seconds: 300 } as const;
export interface ExplorationSuppression {
  version: 1;
  mode: "off" | "soft";
  state: "off" | "inactive" | "reduced";
  reason: string;
  base_priority: number;
  effective_priority: number;
  penalty: number;
  window_started_at: string | null;
  until: string | null;
  evaluated_at: string | null;
  limits: typeof EXPLORATION_SOFT_LIMITS;
  semantics: "priority_preview_not_dispatch_authorization";
}
export interface ExplorationRunTime { id: string; started_at: string; finished_at: string | null }
const time = (value: string | null | undefined) => Date.parse(value ?? "");
const noNew = new Set(["repeated_observation", "interpretation_only", "no_observation"]);

/** No counters/timers to persist: the first threshold crossing owns a non-renewing window.
 * New facts/hints restart eligibility independently of the report-only a/b streak. */
export function buildExplorationSuppression(snapshot: TaskContextSnapshot, runs: readonly ExplorationRunTime[],
  options: { enabled: boolean; now: Date }): Map<string, ExplorationSuppression> {
  const now = options.now.getTime(), byRun = new Map(runs.map(run => [run.id, run]));
  const progressTimes = [...snapshot.facts.filter(fact => fact.id !== "origin" && fact.id !== "goal")
    .map(fact => time(fact.created_at)), ...snapshot.hints.map(hint => time(hint.created_at))];
  const progressKnown = progressTimes.every(Number.isFinite);
  const progressAt = Math.max(Number.NEGATIVE_INFINITY, ...progressTimes);
  const groups = new Map<string, TaskContextSnapshot["attempts"]>();
  for (const attempt of snapshot.attempts) {
    const key = attempt.exploration?.plan_fingerprint;
    if (key != null) { const group = groups.get(key) ?? []; group.push(attempt); groups.set(key, group); }
  }
  const windows = new Map<string, { reason: string; anchor: number | null }>();
  for (const [key, attempts] of groups) {
    attempts.sort((a, b) => time(byRun.get(a.run_id)?.finished_at) - time(byRun.get(b.run_id)?.finished_at) ||
      a.started_at.localeCompare(b.started_at) || a.run_id.localeCompare(b.run_id));
    let count = 0, anchor: number | null = null, valid = true;
    for (const attempt of attempts) {
      const run = byRun.get(attempt.run_id), finished = time(run?.finished_at), started = time(run?.started_at);
      if (!Number.isFinite(finished) || !Number.isFinite(started) || finished < started || finished > now) { valid = false; break; }
      const status = attempt.exploration!.status;
      if (status === "unknown" || status === "new_observation") { count = 0; anchor = null; }
      // Operational failures are skipped, not attributed to the route. A latest fault also exempts below.
      if (status === "operationally_incomplete") continue;
      if (started <= progressAt) { count = 0; anchor = null; continue; }
      if (noNew.has(status)) {
        count++;
        if (count === EXPLORATION_SOFT_LIMITS.threshold) anchor = finished;
      }
    }
    const latest = attempts.at(-1)?.exploration?.status;
    windows.set(key, { reason: !valid ? "history_time_unknown" : latest === "unknown" || latest === "operationally_incomplete"
      ? "latest_not_comparable" : anchor === null ? "below_threshold_or_new_input" : "window", anchor: valid ? anchor : null });
  }
  return new Map(snapshot.intents.map(intent => {
    const base = intent.priority ?? 50;
    const result: ExplorationSuppression = { version: 1, mode: options.enabled ? "soft" : "off", state: options.enabled ? "inactive" : "off",
      reason: "disabled", base_priority: base, effective_priority: base, penalty: 0, window_started_at: null, until: null,
      evaluated_at: Number.isFinite(now) ? options.now.toISOString() : null, limits: { ...EXPLORATION_SOFT_LIMITS },
      semantics: "priority_preview_not_dispatch_authorization" };
    const monitor = intent.exploration;
    if (!options.enabled) return [intent.id, result];
    if (!Number.isFinite(now) || !progressKnown) result.reason = "progress_time_unknown";
    else if (snapshot.project.status !== "active" || snapshot.hints.some(hint => hint.operator_guidance === "pending")) result.reason = "project_or_operator_gate";
    else if (intent.status !== "open" || intent.worker !== null) result.reason = "not_unclaimed_open";
    else if (monitor?.plan_fingerprint == null) result.reason = "plan_unknown";
    else {
      const window = windows.get(monitor.plan_fingerprint);
      result.reason = window?.reason ?? "history_missing";
      if (window?.reason === "window" && window.anchor !== null) {
        const until = window.anchor + EXPLORATION_SOFT_LIMITS.window_seconds * 1000;
        result.window_started_at = new Date(window.anchor).toISOString(); result.until = new Date(until).toISOString();
        result.reason = now < until ? "repeated_reports_window" : "window_expired";
        if (now < until) {
          result.state = "reduced"; result.penalty = Math.min(base, EXPLORATION_SOFT_LIMITS.max_penalty);
          result.effective_priority = base - result.penalty;
        }
      }
    }
    return [intent.id, result];
  }));
}
