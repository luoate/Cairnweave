import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProjectActivity,
  claimTask,
  configureDatabase,
  createProject,
  finishRun,
  recordPendingConclude,
  registerSchedulerInstance,
  startRun,
  type CairnDatabase,
  type RunFailure,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-activity-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "activity",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface RecordedRun {
  id: string;
  kind?: "bootstrap" | "reason" | "explore" | "conclude";
  intentId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  outcome?: "success" | "failed" | "rejected" | "cancelled" | "unhealthy" | "inactive" | null;
  detail?: string | null;
  failure?: RunFailure;
  evidenceCount?: number;
}

function record(input: RecordedRun): void {
  db.withConn((conn) => {
    startRun(conn, {
      id: input.id,
      projectId,
      taskId: `task-${input.id}`,
      kind: input.kind ?? "explore",
      intentId: input.intentId ?? "i001",
      worker: "cairn-worker",
      workerProfile: "primary",
      instanceId: "boot_activity",
      execution: "container",
      startedAt: input.startedAt,
    });
    if (input.outcome === null || input.outcome === undefined) return;
    finishRun(conn, input.id, {
      outcome: input.outcome,
      finishedAt: input.finishedAt ?? input.startedAt,
      durationMs: input.durationMs ?? 0,
      exitCode: 0,
      evidenceCount: input.evidenceCount ?? 0,
      detail: input.detail ?? null,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
    });
  });
}

function activity(options: Parameters<typeof buildProjectActivity>[2] = {}) {
  return db.withConn((conn) => buildProjectActivity(conn, projectId, options));
}

describe("project activity timeline", () => {
  test("an untouched project has no events and no live run", () => {
    const view = activity();
    expect(view.project_id).toBe(projectId);
    expect(view.project.status).toBe("active");
    expect(view.running).toEqual([]);
    expect(view.pending_concludes).toEqual([]);
    expect(view.events).toEqual([]);
    expect(view.truncated).toBe(false);
  });

  test("dispatches and finishes become one ordered feed", () => {
    record({ id: "run_001", startedAt: "2026-01-02T03:00:00Z",
      finishedAt: "2026-01-02T03:00:05Z", durationMs: 5000, outcome: "success" });

    const view = activity({ now: new Date("2026-01-02T03:00:10Z") });
    expect(view.events.map((event) => event.kind))
      .toEqual(["run_dispatched", "run_finished"]);
    expect(view.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(view.events[0]?.title).toBe("派发探索任务");
    expect(view.events[0]?.category).toBe("dispatch");
    expect(view.events[0]?.meta).toEqual([
      "cairn-worker", "primary", "容器",
    ]);
    expect(view.events[1]).toMatchObject({
      level: "success",
      category: "success",
      title: "探索完成",
      outcome: "success",
      duration_ms: 5000,
      run_id: "run_001",
      task_id: "task-run_001",
    });
  });

  test("failure codes choose the badge without inventing a reason", () => {
    record({ id: "run_evidence", startedAt: "2026-01-02T03:00:00Z",
      finishedAt: "2026-01-02T03:10:00Z", durationMs: 600_000, outcome: "failed",
      detail: "invalid evidence: page_flag.php: file is empty (0 bytes; minimum 1)",
      failure: { domain: "execution", code: "evidence_invalid" } });
    record({ id: "run_deadline", kind: "bootstrap", startedAt: "2026-01-02T03:11:00Z",
      finishedAt: "2026-01-02T03:21:00Z", durationMs: 600_000, outcome: "failed",
      detail: "任务达到硬截止时间，worker 已被终止",
      failure: { domain: "execution", code: "hard_deadline" } });
    record({ id: "run_cancelled", startedAt: "2026-01-02T03:22:00Z",
      finishedAt: "2026-01-02T03:23:00Z", durationMs: 60_000, outcome: "cancelled",
      detail: "任务已取消：项目已停止或删除" });
    record({ id: "run_rejected", startedAt: "2026-01-02T03:24:00Z",
      finishedAt: "2026-01-02T03:25:00Z", durationMs: 60_000, outcome: "rejected",
      detail: "result rejected" });

    const view = activity({ now: new Date("2026-01-02T03:30:00Z") });
    const finished = view.events.filter((event) => event.kind === "run_finished");
    expect(finished.map((event) => [event.category, event.level])).toEqual([
      ["evidence", "error"],
      ["deadline", "error"],
      ["cancelled", "warning"],
      ["rejected", "warning"],
    ]);
    expect(finished[0]?.detail).toBe("证据文件不可用：page_flag.php: file is empty (0 bytes; minimum 1)");
    expect(finished[1]?.title).toBe("初始探索达到硬截止时间");
    expect(finished[2]?.detail).toBe("任务已取消：项目已停止或删除");
  });

  test("retries keep their attempt number even when old runs are truncated", () => {
    for (const [index, at] of ["2026-01-02T03:00:00Z", "2026-01-02T03:01:00Z",
      "2026-01-02T03:02:00Z"].entries()) {
      record({ id: `run_${index + 1}`, kind: "bootstrap", intentId: "i001",
        startedAt: at, finishedAt: at, durationMs: 1000, outcome: "failed",
        failure: { domain: "execution", code: "worker_failed" } });
    }

    const view = activity({ now: new Date("2026-01-02T03:10:00Z"), limit: 2 });
    expect(view.truncated).toBe(true);
    const dispatches = view.events.filter((event) => event.kind === "run_dispatched");
    expect(dispatches.map((event) => [event.run_id, event.attempt, event.title])).toEqual([
      ["run_2", 2, "重新派发初始探索任务（第 2 次尝试）"],
      ["run_3", 3, "重新派发初始探索任务（第 3 次尝试）"],
    ]);
  });

  test("a soft-deadline warning appears only when a run actually crossed it", () => {
    record({ id: "run_001", startedAt: "2026-01-02T03:00:00Z",
      finishedAt: "2026-01-02T03:02:30Z", durationMs: 150_000, outcome: "success" });
    const deadlines = new Map([["run_001", { hard_seconds: 300, soft_seconds: 240 }]]);

    const crossed = activity({
      now: new Date("2026-01-02T03:10:00Z"),
      deadlineFor: (run) => deadlines.get(run.id) ?? null,
    }).events.filter((event) => event.kind === "deadline_soft");
    expect(crossed).toEqual([]);

    const other = activity({
      now: new Date("2026-01-02T03:10:00Z"),
      deadlineFor: () => ({ hard_seconds: 300, soft_seconds: 60 }),
    });
    const soft = other.events.filter((event) => event.kind === "deadline_soft");
    expect(soft).toHaveLength(1);
    expect(soft[0]).toMatchObject({
      at: "2026-01-02T03:01:00.000Z",
      level: "warning",
      category: "deadline",
      title: "探索软截止时间已过（仅提示）",
      detail: "软截止后任务继续运行 1 分 30 秒才结束。",
    });
  });

  test("an open run reports elapsed time, deadline phase, claim and scheduler heartbeat", () => {
    record({ id: "run_live", startedAt: "2026-01-02T03:00:00Z", outcome: null });
    db.withConn((conn) => {
      registerSchedulerInstance(conn, { id: "boot_activity", at: "2026-01-02T03:00:00Z" });
      claimTask(conn, {
        taskId: "task-run_live",
        runId: "run_live",
        instanceId: "boot_activity",
        projectId,
        intentId: "i001",
        kind: "explore",
        worker: "cairn-worker",
        leaseSeconds: 300,
        at: "2026-01-02T03:00:00Z",
      });
    });

    const view = activity({
      now: new Date("2026-01-02T03:01:40Z"),
      deadlineFor: () => ({ hard_seconds: 120, soft_seconds: 90 }),
    });
    expect(view.running).toHaveLength(1);
    expect(view.running[0]).toMatchObject({
      run_id: "run_live",
      attempt: 1,
      elapsed_ms: 100_000,
      deadline: {
        hard_seconds: 120,
        soft_seconds: 90,
        hard_at: "2026-01-02T03:02:00.000Z",
        soft_at: "2026-01-02T03:01:30.000Z",
        hard_remaining_ms: 20_000,
        soft_remaining_ms: -10_000,
        phase: "soft_overdue",
      },
      claim: {
        task_id: "task-run_live",
        instance_id: "boot_activity",
        lease_remaining_ms: 200_000,
      },
      scheduler: {
        instance_id: "boot_activity",
        heartbeat_age_ms: 100_000,
        stopped_at: null,
      },
    });
    // The open run has a dispatch event but no finish event.
    expect(view.events.map((event) => event.kind)).toEqual(["run_dispatched"]);
  });

  test("queued concludes are live state, not fabricated events", () => {
    db.withConn((conn) => recordPendingConclude(conn, {
      projectId,
      intentId: "i002",
      phase: "explore",
      session: ".cairn/sessions/explore-aaaaaaaaaaaa",
      workerProfile: "primary",
      createdAt: "2026-01-02T03:05:00Z",
    }));

    const view = activity({ now: new Date("2026-01-02T03:06:00Z") });
    expect(view.pending_concludes).toEqual([{
      intent_id: "i002",
      phase: "explore",
      created_at: "2026-01-02T03:05:00Z",
      worker_profile: "primary",
    }]);
    expect(view.events).toEqual([]);
  });

  test("an unknown project is a 404 even when runs are queried", () => {
    expect(() => db.withConn((conn) => buildProjectActivity(conn, "proj_missing"))).toThrow(
      "Project not found",
    );
  });
});
