import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ORPHAN_RUN_DETAIL,
  configureDatabase,
  createIntent,
  createProject,
  getProjectDetail,
  heartbeatIntent,
  listProjectRuns,
  recordPendingConclude,
  registerSchedulerInstance,
  startRun,
  type CairnDatabase,
  type Run,
  type SchedulerInstanceRow,
} from "@cairn/graph";

import { parseDispatchConfig } from "../config";
import { Scheduler } from "./loop";

const CONFIG = {
  server: "http://127.0.0.1:8000",
  runtime: {
    execution: "local",
    max_workers: 1,
    max_running_projects: 1,
    max_project_workers: 1,
    interval: 1,
    healthcheck_timeout: 15,
    worker_healthcheck: "disabled",
    prompt_group: "default",
  },
  tasks: {
    bootstrap: { timeout: 30, conclude_timeout: 10 },
    reason: { timeout: 30, max_intents: 3 },
    explore: { timeout: 30, conclude_timeout: 10 },
  },
  local: { completed_action: "keep" },
  worker: {
    soft_deadline_ratio: 0.8,
    retain_task_files: true,
    result_grace_seconds: 2,
  },
  strategist: {
    cooldown_seconds: 0,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
  },
};

const WORKER = "cairn-worker";
/** The scheduler's injected clock, so instance timestamps are predictable. */
const BOOT_AT = "2026-01-02T03:00:00Z";
const BOOT_MS = Date.parse(BOOT_AT);
/** `max(2 * runtime.interval, 30s)` — the floor applies at interval=1. */
const PEER_TIMEOUT_SECONDS = 30;

let directory: string;
let workspaceRoot: string;
let db: CairnDatabase;
let logs: string[];
let clockMs: number;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-startup-"));
  workspaceRoot = join(directory, "workspace");
  db = configureDatabase(join(directory, "cairn.db"));
  logs = [];
  clockMs = BOOT_MS;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function boot(options: { leaseIntervalMs?: number } = {}): Scheduler {
  return new Scheduler({
    db,
    config: parseDispatchConfig(CONFIG),
    workspaceRoot,
    log: (message) => logs.push(message),
    leaseIntervalMs: options.leaseIntervalMs ?? 500,
    now: () => new Date(clockMs),
  });
}

/** A project without an authorized scope: the scheduler fails closed and dispatches nothing. */
function createProjectRow(): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title: "startup",
        origin: "start here",
        goal: "reach the end",
        bootstrap_enabled: true,
        hints: null,
        scope: null,
      }).project.id,
  );
}

function seedOpenRun(projectId: string, runId: string, intentId: string | null = null): void {
  db.withConn((conn) =>
    startRun(conn, {
      id: runId,
      projectId,
      taskId: `explore-${runId}`,
      kind: "explore",
      intentId,
      worker: WORKER,
      startedAt: "2026-01-02T02:00:00Z",
      session: `.cairn/sessions/explore-${runId}`,
    }),
  );
}

function runs(projectId: string): Run[] {
  return db.withConn((conn) => listProjectRuns(conn, projectId));
}

function instances(): SchedulerInstanceRow[] {
  return db.withConn(
    (conn) =>
      conn
        .query(
          `SELECT id, started_at, heartbeat_at, stopped_at
           FROM scheduler_instances ORDER BY started_at, id`,
        )
        .all() as SchedulerInstanceRow[],
  );
}

function registerPeer(id: string, heartbeatAt: string): void {
  db.withConn((conn) =>
    registerSchedulerInstance(conn, { id, at: heartbeatAt }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("scheduler startup reconciliation", () => {
  test("closes the runs a previous process left open and logs the count", async () => {
    const projectId = createProjectRow();
    seedOpenRun(projectId, "run_001");
    seedOpenRun(projectId, "run_002");

    const loop = boot();
    loop.start();
    try {
      expect(runs(projectId)).toMatchObject([
        {
          id: "run_001",
          outcome: "inactive",
          finished_at: BOOT_AT,
          duration_ms: null,
          detail: ORPHAN_RUN_DETAIL,
        },
        { id: "run_002", outcome: "inactive", detail: ORPHAN_RUN_DETAIL },
      ]);
      expect(
        logs.some(
          (line) =>
            line.includes("orphan run closed") &&
            line.includes("run=run_001") &&
            line.includes(`project=${projectId}`) &&
            line.includes("task=explore-run_001"),
        ),
      ).toBe(true);
      expect(logs).toContain("startup reconcile closed 2 orphan run(s)");
      expect(logs.some((line) => line.includes("startup reconcile skipped"))).toBe(false);

      const rows = instances();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ started_at: BOOT_AT, stopped_at: null });
      expect(rows[0]?.id).toMatch(/^boot-[0-9a-f]{12}$/);
    } finally {
      await loop.stop();
    }
  });

  test("skips reconciliation while another instance is heartbeating", async () => {
    const projectId = createProjectRow();
    seedOpenRun(projectId, "run_001");
    // Ten seconds old, inside the 30s window: that peer owns the open runs.
    registerPeer("boot-peer", "2026-01-02T02:59:50Z");

    const loop = boot();
    loop.start();
    try {
      expect(runs(projectId)).toMatchObject([{ id: "run_001", outcome: null }]);
      expect(
        logs.some(
          (line) =>
            line.includes("startup reconcile skipped") &&
            line.includes(`${PEER_TIMEOUT_SECONDS}s`),
        ),
      ).toBe(true);
      expect(instances().map((row) => row.id)).toContain("boot-peer");
    } finally {
      await loop.stop();
    }
  });

  test("reconciles when the only peer stopped heartbeating in time", async () => {
    const projectId = createProjectRow();
    seedOpenRun(projectId, "run_001");
    // An hour without a beat: the process is gone, its rows are orphans.
    registerPeer("boot-crashed", "2026-01-02T02:00:00Z");

    const loop = boot();
    loop.start();
    try {
      expect(runs(projectId)).toMatchObject([
        { id: "run_001", outcome: "inactive", detail: ORPHAN_RUN_DETAIL },
      ]);
      expect(logs.some((line) => line.includes("startup reconcile skipped"))).toBe(false);
    } finally {
      await loop.stop();
    }
  });

  test("treats a cleanly stopped peer as dead so the next boot reconciles at once", async () => {
    const projectId = createProjectRow();

    const first = boot();
    first.start();
    await first.stop();
    expect(instances()).toMatchObject([{ started_at: BOOT_AT, stopped_at: BOOT_AT }]);

    // What a crash would have left behind.
    seedOpenRun(projectId, "run_002");

    const second = boot();
    second.start();
    try {
      expect(runs(projectId)).toMatchObject([
        { id: "run_002", outcome: "inactive", finished_at: BOOT_AT },
      ]);
      expect(logs.some((line) => line.includes("startup reconcile skipped"))).toBe(false);
      // Boot ids are random, so the two rows are told apart by state, not by order.
      const rows = instances();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.stopped_at === BOOT_AT)).toHaveLength(1);
      expect(rows.filter((row) => row.stopped_at === null)).toHaveLength(1);
    } finally {
      await second.stop();
    }
  });

  test("keeps a claimed intent lease that belongs to a live worker", async () => {
    const projectId = createProjectRow();
    const intentId = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "probe",
        creator: "tester",
        worker: null,
      });
      heartbeatIntent(conn, projectId, intent.id, WORKER);
      return intent.id;
    });
    seedOpenRun(projectId, "run_001", intentId);

    const loop = boot();
    loop.start();
    try {
      expect(runs(projectId)).toMatchObject([{ id: "run_001", outcome: "inactive" }]);
      const intent = db
        .withConn((conn) => getProjectDetail(conn, projectId))
        .intents.find((row) => row.id === intentId);
      expect(intent?.worker).toBe(WORKER);
    } finally {
      await loop.stop();
    }
  });

  test("still runs the pending conclude sweep it used to do alone", async () => {
    const projectId = createProjectRow();
    const intentId = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "probe",
        creator: "tester",
        worker: null,
      });
      heartbeatIntent(conn, projectId, intent.id, WORKER);
      return intent.id;
    });
    db.withConn((conn) =>
      recordPendingConclude(conn, {
        projectId,
        intentId,
        phase: "explore",
        session: ".cairn/sessions/gone",
      }),
    );

    const loop = boot();
    loop.start();
    try {
      expect(
        logs.some(
          (line) =>
            line.includes("pending conclude dropped") && line.includes("session missing"),
        ),
      ).toBe(true);
    } finally {
      await loop.stop();
    }
  });

  test("beats on the lease cadence so a later boot sees this process as alive", async () => {
    const projectId = createProjectRow();
    const loop = boot({ leaseIntervalMs: 20 });
    loop.start();
    const second = boot({ leaseIntervalMs: 20 });
    try {
      clockMs = BOOT_MS + 60_000;
      await sleep(150);
      expect(instances()).toMatchObject([
        { started_at: BOOT_AT, heartbeat_at: "2026-01-02T03:01:00Z", stopped_at: null },
      ]);

      // The live beat is what protects this process's own in-flight work from a newcomer.
      seedOpenRun(projectId, "run_001");
      second.start();
      expect(runs(projectId)).toMatchObject([{ id: "run_001", outcome: null }]);
      expect(
        logs.some((line) => line.includes("startup reconcile skipped")),
      ).toBe(true);
    } finally {
      await second.stop();
      await loop.stop();
    }
  });
});
