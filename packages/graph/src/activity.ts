/**
 * Read-only scheduler activity for one project.
 *
 * The graph timeline answers "what did the solver learn"; it cannot answer "why is the
 * project still running". Dispatch, deadlines, retries, evidence rejection and cancellation
 * live in `runs`, `task_claims`, `pending_concludes` and `scheduler_instances`; this module
 * turns those sidecars into one ordered feed plus the live state a UI can poll.
 *
 * Nothing here writes, and nothing is inferred from a worker's self-report: an event is
 * emitted only from a persisted control-plane row. When a run has no `task.json` deadline
 * the view says so instead of guessing one.
 */

import type { Database } from "bun:sqlite";

import { all } from "./db";
import type { RunFailure } from "./failures";
import type { Run, RunExecution, RunOutcome } from "./models";
import { listPendingConcludes } from "./pending-concludes";
import { listProjectRuns } from "./runs";
import { getSchedulerInstance } from "./scheduler-instances";
import { getProjectOr404 } from "./services";
import { listActiveTaskClaims, type TaskClaim } from "./task-claims";

export type ActivityLevel = "info" | "success" | "warning" | "error";

export type ActivityCategory =
  | "dispatch"
  | "success"
  | "failure"
  | "deadline"
  | "evidence"
  | "rejected"
  | "cancelled"
  | "inactive";

export type ActivityEventKind =
  | "run_dispatched"
  | "run_finished"
  | "deadline_soft";

export interface ActivityDeadline {
  hard_seconds: number;
  soft_seconds: number | null;
}

export interface ActivityEvent {
  /** Stable per (run, lifecycle); the same event keeps its id across polls. */
  id: string;
  /** Position in the returned feed, 1-based; useful as a cursor for incremental renders. */
  seq: number;
  at: string;
  kind: ActivityEventKind;
  level: ActivityLevel;
  category: ActivityCategory;
  title: string;
  detail: string | null;
  run_id: string | null;
  task_id: string | null;
  intent_id: string | null;
  task_kind: string | null;
  /** Per (kind, intent) attempt number, counted over the project's whole run history. */
  attempt: number | null;
  outcome: RunOutcome | null;
  failure: RunFailure | null;
  duration_ms: number | null;
  meta: string[];
}

export type ActivityLivePhase = "running" | "soft_overdue" | "hard_overdue";

export interface ActivityDeadlineView {
  hard_seconds: number;
  soft_seconds: number | null;
  started_at: string;
  hard_at: string;
  soft_at: string | null;
  /** Negative once the deadline has passed. */
  hard_remaining_ms: number;
  soft_remaining_ms: number | null;
  phase: ActivityLivePhase;
}

export interface ActivityClaimView {
  task_id: string;
  instance_id: string;
  lease_expires_at: string;
  /** Negative when the lease has expired but the run row is still open. */
  lease_remaining_ms: number | null;
  release_reason: string | null;
}

export interface ActivitySchedulerView {
  instance_id: string;
  heartbeat_at: string;
  heartbeat_age_ms: number | null;
  stopped_at: string | null;
}

export interface ActivityLiveRun {
  run_id: string;
  task_id: string;
  kind: string;
  intent_id: string | null;
  worker: string;
  worker_profile: string | null;
  model: string | null;
  execution: RunExecution | null;
  trigger: string | null;
  started_at: string;
  elapsed_ms: number;
  attempt: number;
  evidence_count: number;
  deadline: ActivityDeadlineView | null;
  claim: ActivityClaimView | null;
  scheduler: ActivitySchedulerView | null;
  /** Last intent heartbeat; null for project-level tasks such as reason turns. */
  heartbeat_at: string | null;
}

export interface ActivityPendingConclude {
  intent_id: string;
  phase: string;
  created_at: string;
  worker_profile: string | null;
}

export interface ProjectActivity {
  project_id: string;
  generated_at: string;
  project: {
    id: string;
    title: string;
    status: string;
    created_at: string;
  };
  /** Open runs, oldest first. Normally zero or one per project. */
  running: ActivityLiveRun[];
  pending_concludes: ActivityPendingConclude[];
  events: ActivityEvent[];
  /** True when older runs were dropped by `limit`; the attempts they carried still count. */
  truncated: boolean;
}

export interface BuildProjectActivityOptions {
  now?: Date;
  /** Deadline source, normally read from the run's `task.json` by the HTTP layer. */
  deadlineFor?: (run: Run) => ActivityDeadline | null;
  /** How many most-recent runs to include. Defaults to 80; hard-capped at 500. */
  limit?: number;
}

export const DEFAULT_ACTIVITY_RUN_LIMIT = 80;
export const MAX_ACTIVITY_RUN_LIMIT = 500;

const KIND_LABEL: Record<string, string> = {
  bootstrap: "初始探索",
  reason: "慢层推理",
  explore: "探索",
  conclude: "结论收束",
};

const EXECUTION_LABEL: Record<RunExecution, string> = {
  local: "本地",
  container: "容器",
};

export function buildProjectActivity(
  conn: Database,
  projectId: string,
  options: BuildProjectActivityOptions = {},
): ProjectActivity {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const project = getProjectOr404(conn, projectId);
  const allRuns = listProjectRuns(conn, projectId);
  const limit = Math.max(
    1,
    Math.min(MAX_ACTIVITY_RUN_LIMIT, Math.trunc(options.limit ?? DEFAULT_ACTIVITY_RUN_LIMIT)),
  );
  const truncated = allRuns.length > limit;
  const runs = truncated ? allRuns.slice(-limit) : allRuns;
  const attempts = countAttempts(allRuns);

  const deadlineCache = new Map<string, ActivityDeadline | null>();
  const deadlineFor = (run: Run): ActivityDeadline | null => {
    if (!deadlineCache.has(run.id)) {
      deadlineCache.set(run.id, options.deadlineFor?.(run) ?? null);
    }
    return deadlineCache.get(run.id) ?? null;
  };

  const events = buildEvents(runs, attempts, deadlineFor);

  const claims = new Map(
    listActiveTaskClaims(conn, { now: now.toISOString(), projectId })
      .map((claim) => [claim.task_id, claim] as const),
  );
  const heartbeats = new Map(
    all<{ id: string; last_heartbeat_at: string | null }>(
      conn,
      "SELECT id, last_heartbeat_at FROM intents WHERE project_id = ?",
      projectId,
    ).map((row) => [row.id, row.last_heartbeat_at] as const),
  );

  const running = runs
    .filter((run) => run.outcome === null)
    .map((run): ActivityLiveRun => {
      const startedMs = Date.parse(run.started_at);
      const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
      const deadline = deadlineFor(run);
      const claim = claims.get(run.task_id) ?? null;
      const instance = run.instance_id === null ? null : getSchedulerInstance(conn, run.instance_id);
      return {
        run_id: run.id,
        task_id: run.task_id,
        kind: run.kind,
        intent_id: run.intent_id,
        worker: run.worker,
        worker_profile: run.worker_profile,
        model: run.model,
        execution: run.execution,
        trigger: run.trigger,
        started_at: run.started_at,
        elapsed_ms: elapsedMs,
        attempt: attempts.get(run.id) ?? 1,
        evidence_count: run.evidence_count,
        deadline: deadlineView(deadline, startedMs, nowMs),
        claim: claim === null ? null : claimView(claim, nowMs),
        scheduler: instance === null ? null : {
          instance_id: instance.id,
          heartbeat_at: instance.heartbeat_at,
          heartbeat_age_ms: ageMs(instance.heartbeat_at, nowMs),
          stopped_at: instance.stopped_at,
        },
        heartbeat_at: run.intent_id === null ? null : heartbeats.get(run.intent_id) ?? null,
      };
    });

  return {
    project_id: projectId,
    generated_at: now.toISOString(),
    project: {
      id: project.id,
      title: project.title,
      status: project.status,
      created_at: project.created_at,
    },
    running,
    pending_concludes: listPendingConcludes(conn, projectId).map((row) => ({
      intent_id: row.intent_id,
      phase: row.phase,
      created_at: row.created_at,
      worker_profile: row.worker_profile,
    })),
    events,
    truncated,
  };
}

function buildEvents(
  runs: readonly Run[],
  attempts: ReadonlyMap<string, number>,
  deadlineFor: (run: Run) => ActivityDeadline | null,
): ActivityEvent[] {
  const drafts: ActivityEvent[] = [];
  const push = (event: Omit<ActivityEvent, "seq">): void => {
    drafts.push({ ...event, seq: 0 });
  };

  for (const run of runs) {
    const kindLabel = KIND_LABEL[run.kind] ?? run.kind;
    const attempt = attempts.get(run.id) ?? 1;
    const meta = runMeta(run);
    push({
      id: `run:${run.id}:dispatched`,
      at: run.started_at,
      kind: "run_dispatched",
      level: "info",
      category: "dispatch",
      title: attempt > 1
        ? `重新派发${kindLabel}任务（第 ${attempt} 次尝试）`
        : `派发${kindLabel}任务`,
      detail: null,
      run_id: run.id,
      task_id: run.task_id,
      intent_id: run.intent_id,
      task_kind: run.kind,
      attempt,
      outcome: null,
      failure: null,
      duration_ms: null,
      meta,
    });

    if (run.outcome !== null) {
      const outcome = finishEventView(run, run.outcome, kindLabel);
      push({
        id: `run:${run.id}:finished`,
        at: run.finished_at ?? run.started_at,
        kind: "run_finished",
        level: outcome.level,
        category: outcome.category,
        title: outcome.title,
        detail: outcome.detail,
        run_id: run.id,
        task_id: run.task_id,
        intent_id: run.intent_id,
        task_kind: run.kind,
        attempt,
        outcome: run.outcome,
        failure: run.failure ?? null,
        duration_ms: run.duration_ms,
        meta,
      });
    }

    const soft = softDeadlineEvent(run, kindLabel, deadlineFor(run));
    if (soft !== null) push(soft);
  }

  // The feed is chronological. `sort` is stable, so events created for the same instant keep
  // run order: a finish always precedes the dispatch of the next attempt.
  drafts.sort((left, right) => left.at.localeCompare(right.at));
  return drafts.map((event, index) => ({ ...event, seq: index + 1 }));
}

function finishEventView(
  run: Run,
  outcome: RunOutcome,
  kindLabel: string,
): { level: ActivityLevel; category: ActivityCategory; title: string; detail: string | null } {
  const detail = run.detail;
  switch (outcome) {
    case "success":
      return { level: "success", category: "success", title: `${kindLabel}完成`, detail };
    case "rejected":
      return { level: "warning", category: "rejected", title: `${kindLabel}结果被拒绝`, detail };
    case "cancelled":
      return { level: "warning", category: "cancelled", title: `${kindLabel}已取消`, detail };
    case "inactive":
      return { level: "warning", category: "inactive", title: `${kindLabel}结果被丢弃（项目非活动）`, detail };
    case "unhealthy":
      return { level: "warning", category: "failure", title: `${kindLabel}状态异常`, detail };
    case "failed": {
      const code = run.failure?.code;
      if (code === "hard_deadline") {
        return { level: "error", category: "deadline", title: `${kindLabel}达到硬截止时间`, detail };
      }
      if (code === "evidence_invalid") {
        return {
          level: "error",
          category: "evidence",
          title: `${kindLabel}证据校验失败`,
          detail: detail === null
            ? null
            : detail.replace(/^invalid evidence:\s*/, "证据文件不可用："),
        };
      }
      if (run.failure?.domain === "infrastructure") {
        return { level: "error", category: "failure", title: `${kindLabel}中断（环境故障）`, detail };
      }
      return {
        level: "error",
        category: "failure",
        title: code === undefined ? `${kindLabel}失败` : `${kindLabel}失败（${code}）`,
        detail,
      };
    }
  }
}

function softDeadlineEvent(
  run: Run,
  kindLabel: string,
  deadline: ActivityDeadline | null,
): Omit<ActivityEvent, "seq"> | null {
  if (run.outcome === null || deadline === null || deadline.soft_seconds === null) return null;
  if (run.duration_ms === null) return null;
  const startedMs = Date.parse(run.started_at);
  if (!Number.isFinite(startedMs)) return null;
  const softMs = deadline.soft_seconds * 1000;
  if (run.duration_ms < softMs) return null;
  return {
    id: `run:${run.id}:soft_deadline`,
    at: new Date(startedMs + softMs).toISOString(),
    kind: "deadline_soft",
    level: "warning",
    category: "deadline",
    title: `${kindLabel}软截止时间已过（仅提示）`,
    detail: `软截止后任务继续运行 ${durationText(run.duration_ms - softMs)}才结束。`,
    run_id: run.id,
    task_id: run.task_id,
    intent_id: run.intent_id,
    task_kind: run.kind,
    attempt: null,
    outcome: run.outcome,
    failure: run.failure ?? null,
    duration_ms: run.duration_ms,
    meta: [],
  };
}

function countAttempts(runs: readonly Run[]): Map<string, number> {
  const counters = new Map<string, number>();
  const attempts = new Map<string, number>();
  for (const run of runs) {
    const key = `${run.kind}:${run.intent_id ?? ""}`;
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    attempts.set(run.id, next);
  }
  return attempts;
}

function deadlineView(
  deadline: ActivityDeadline | null,
  startedMs: number,
  nowMs: number,
): ActivityDeadlineView | null {
  if (deadline === null || !Number.isFinite(startedMs)) return null;
  const hardAt = startedMs + deadline.hard_seconds * 1000;
  const softAt = deadline.soft_seconds === null ? null : startedMs + deadline.soft_seconds * 1000;
  return {
    hard_seconds: deadline.hard_seconds,
    soft_seconds: deadline.soft_seconds,
    started_at: new Date(startedMs).toISOString(),
    hard_at: new Date(hardAt).toISOString(),
    soft_at: softAt === null ? null : new Date(softAt).toISOString(),
    hard_remaining_ms: hardAt - nowMs,
    soft_remaining_ms: softAt === null ? null : softAt - nowMs,
    phase: nowMs >= hardAt ? "hard_overdue" : softAt !== null && nowMs >= softAt ? "soft_overdue" : "running",
  };
}

function claimView(claim: TaskClaim, nowMs: number): ActivityClaimView {
  return {
    task_id: claim.task_id,
    instance_id: claim.instance_id,
    lease_expires_at: claim.lease_expires_at,
    lease_remaining_ms: relativeMs(claim.lease_expires_at, nowMs),
    release_reason: claim.release_reason,
  };
}

/** Signed milliseconds from `at` to `nowMs`; null for an unparseable timestamp. */
function relativeMs(at: string, nowMs: number): number | null {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed - nowMs : null;
}

/** How long before `nowMs` the timestamp was written; null for an unparseable timestamp. */
function ageMs(at: string, nowMs: number): number | null {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? nowMs - parsed : null;
}

function runMeta(run: Run): string[] {
  const meta = [run.worker];
  if (run.worker_profile !== null) meta.push(run.worker_profile);
  if (run.model !== null) meta.push(run.model);
  if (run.execution !== null) meta.push(EXECUTION_LABEL[run.execution]);
  if (run.trigger !== null) meta.push(`触发 ${run.trigger}`);
  return meta;
}

function durationText(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}
