import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAIM_RELEASE_OWNER_EXPIRED,
  configureDatabase,
  createIntent,
  createProject,
  listActiveTaskClaims,
  listProjectRuns,
  releaseReason,
  type CairnDatabase,
  type Intent,
  type ProjectDetail,
  type Run,
  type TaskClaim,
} from "@cairn/graph";

import { parseDispatchConfig, type DispatchConfig } from "../config";
import { Scheduler } from "./loop";
import type { RuntimeBackend, WorkerProcess } from "../runtime/types";

const CONFIG = {
  server: "http://127.0.0.1:8000",
  runtime: {
    execution: "local",
    max_workers: 2,
    max_running_projects: 2,
    max_project_workers: 2,
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
    // The stub worker never writes a result, so a released task should fail fast.
    result_grace_seconds: 0,
  },
  strategist: {
    cooldown_seconds: 0,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
  },
};

const SCOPE = { targets: ["127.0.0.1:8080"] };
const BOOT_AT = "2026-01-02T03:00:00Z";
const BOOT_MS = Date.parse(BOOT_AT);
/** `settings.intent_timeout` default, which M39 reuses as the claim lease TTL. */
const LEASE_SECONDS = 15;
/** `max(2 * runtime.interval, 30)`: inside this window a peer counts as alive. */
const PEER_TIMEOUT_SECONDS = 30;

let directory: string;
let db: CairnDatabase;
let config: DispatchConfig;
let clockMs: number;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-claims-"));
  db = configureDatabase(join(directory, "cairn.db"));
  config = parseDispatchConfig(CONFIG);
  clockMs = BOOT_MS;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

// --- stub runtime -------------------------------------------------------------------

interface Stub {
  backend: RuntimeBackend;
  /** Settle every child this boot still holds, so its tasks finish. */
  releaseAll(): void;
}

function stubRuntime(): Stub {
  const terminate = new Map<string, () => void>();
  const backend: RuntimeBackend = {
    execution: "local",
    ensureProject: () => true,
    mapPath: (hostPath) => hostPath,
    mapPathIfUnderWorkspace: (hostPath) => hostPath,
    spawnWorker(options) {
      let settle!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        settle = resolve;
      });
      const silence = () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
      // No result file is ever written: the task fails, and `finish` releases the claim.
      const stop = () => settle(143);
      terminate.set(options.taskId, stop);
      const handle: WorkerProcess = {
        exited,
        stdout: silence(),
        stderr: silence(),
        terminate: stop,
        kill: stop,
      };
      return handle;
    },
    cleanupInactive: () => undefined,
    close: () => undefined,
  };
  return {
    backend,
    releaseAll: () => {
      for (const stop of [...terminate.values()]) stop();
      terminate.clear();
    },
  };
}

// --- schedulers under test ----------------------------------------------------------

interface Boot {
  loop: Scheduler;
  logs: string[];
  /** End this boot's in-flight tasks and wait until their claims are released. */
  drain(): Promise<void>;
}

/**
 * A control plane that was never `start()`ed: work moves only when the test calls `tick()` or
 * `sweepNow()`, so no interval can change the ledger between two assertions.
 */
function boot(cfg: DispatchConfig = config): Boot {
  const logs: string[] = [];
  const stub = stubRuntime();
  const loop = new Scheduler({
    db,
    config: cfg,
    workspaceRoot: join(directory, "workspace"),
    runtime: stub.backend,
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    now: () => new Date(clockMs),
  });
  return {
    loop,
    logs,
    drain: async () => {
      stub.releaseAll();
      await loop.waitForIdle();
    },
  };
}

function createProjectRow(bootstrapEnabled: boolean): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: `claims-${bootstrapEnabled}`,
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: bootstrapEnabled,
      hints: null,
      scope: SCOPE,
    }),
  );
}

function openIntent(projectId: string, description: string): Intent {
  return db.withConn((conn) =>
    createIntent(conn, projectId, {
      from: ["origin"],
      description,
      creator: "tester",
      worker: null,
    }),
  );
}

function claimRows(): TaskClaim[] {
  return db.withConn(
    (conn) =>
      conn
        .query("SELECT * FROM task_claims ORDER BY project_id, created_at, task_id")
        .all() as TaskClaim[],
  );
}

/**
 * The rows this call did not see before. Task ids are random and two boots can claim in the
 * same second, so tests never address the ledger by position.
 */
function claimsAddedSince(seen: ReadonlySet<string>): TaskClaim[] {
  return claimRows().filter((row) => !seen.has(row.task_id));
}

function claimIds(): Set<string> {
  return new Set(claimRows().map((row) => row.task_id));
}

/** What the schedulers budget against right now: unreleased claims whose lease still covers. */
function activeClaims(): TaskClaim[] {
  return db.withConn((conn) =>
    listActiveTaskClaims(conn, { now: new Date(clockMs).toISOString().replace(/\.\d{3}Z$/, "Z") }),
  );
}

function runs(projectId: string): Run[] {
  return db.withConn((conn) => listProjectRuns(conn, projectId));
}

function reasonWorker(projectId: string): string | null {
  return db.withConn(
    (conn) =>
      conn
        .query("SELECT reason_worker FROM projects WHERE id = ?")
        .get(projectId) as { reason_worker: string | null } | null,
  )?.reason_worker ?? null;
}

function intentWorker(intentId: string): string | null {
  return db.withConn(
    (conn) =>
      conn
        .query("SELECT worker FROM intents WHERE id = ?")
        .get(intentId) as { worker: string | null } | null,
  )?.worker ?? null;
}

function instanceRows(): { id: string; heartbeat_at: string; stopped_at: string | null }[] {
  return db.withConn(
    (conn) =>
      conn
        .query(
          `SELECT id, heartbeat_at, stopped_at FROM scheduler_instances
           ORDER BY started_at, id`,
        )
        .all() as { id: string; heartbeat_at: string; stopped_at: string | null }[],
  );
}

function stamp(offsetSeconds: number): string {
  return new Date(BOOT_MS + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Move the clock both schedulers read. */
function advance(seconds: number): void {
  clockMs = BOOT_MS + seconds * 1000;
}

/** Move one claim's lease without changing the settings that produced it. */
function setLease(taskId: string, offsetSeconds: number): void {
  db.withConn((conn) =>
    conn
      .query("UPDATE task_claims SET lease_expires_at = ? WHERE task_id = ?")
      .run(stamp(offsetSeconds), taskId),
  );
}

// --- tests --------------------------------------------------------------------------

describe("cross-process task claims", () => {
  test("one dispatched task writes one claim row, owned by a registered boot", async () => {
    const project = createProjectRow(false);
    const intent = openIntent(project.project.id, "direction one");

    const a = boot();
    expect(a.loop.tick()).toBe(true);

    const rows = claimRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: project.project.id,
      intent_id: intent.id,
      kind: "explore",
      worker: "cairn-worker",
      created_at: BOOT_AT,
      lease_expires_at: stamp(LEASE_SECONDS),
      released_at: null,
      release_reason: null,
    });
    expect(rows[0]!.task_id).toMatch(/^explore-[0-9a-f]{12}$/);
    const owner = rows[0]!.instance_id;
    expect(owner).toMatch(/^boot-[0-9a-f]{12}$/);
    // A scheduler that dispatches without ever starting still gets an instance row, so
    // `instance_id` is never dangling and every takeover rule has an owner to judge.
    expect(instanceRows()).toEqual([
      { id: owner, heartbeat_at: BOOT_AT, stopped_at: null },
    ]);

    // The run row carries the same boot: that is how `/runs` attributes work to a process.
    const runRows = runs(project.project.id);
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      kind: "explore",
      intent_id: intent.id,
      instance_id: owner,
      outcome: null,
    });
    expect(rows[0]!.run_id).toBe(runRows[0]!.id);

    await a.drain();
    expect(claimRows()[0]).toMatchObject({
      released_at: BOOT_AT,
      release_reason: "failed",
    });
    expect(activeClaims()).toEqual([]);
  });

  test("a peer cannot re-dispatch an intent only the ledger knows about", async () => {
    const project = createProjectRow(false);
    const intent = openIntent(project.project.id, "direction one");

    const a = boot();
    const b = boot();
    expect(a.loop.tick()).toBe(true);
    const owner = claimRows()[0]!.instance_id;

    // B's own task map is empty: the claim view is the only reason it stays out.
    expect(b.loop.runningCount).toBe(0);
    expect(b.loop.tick()).toBe(false);
    expect(claimRows()).toHaveLength(1);
    expect(runs(project.project.id)).toHaveLength(1);
    expect(
      b.logs.some(
        (line) => line.includes(`project=${project.project.id} has no dispatchable work`),
      ),
    ).toBe(true);

    // The failed explore released both its claim and the intent's graph lease, so the
    // direction is fast-layer work again and B picks it up.
    const before = claimIds();
    await a.drain();
    expect(b.loop.tick()).toBe(true);
    expect(claimRows()).toHaveLength(2);
    const [second] = claimsAddedSince(before);
    expect(second).toMatchObject({
      kind: "explore",
      intent_id: intent.id,
      released_at: null,
      created_at: BOOT_AT,
    });
    expect(second!.instance_id).not.toBe(owner);
    await b.drain();
  });

  test("the reason slot stays one claim per project even without its graph lease", async () => {
    const project = createProjectRow(false);
    // A stub reason turn always fails, and the failure watermark is stamped with the real
    // clock while these tests drive an injected one. Back off nothing: the point here is the
    // claim index, not the trigger policy.
    const noBackoff = parseDispatchConfig({
      ...CONFIG,
      strategist: { ...CONFIG.strategist, failure_backoff_seconds: 0 },
    });

    const a = boot(noBackoff);
    const b = boot(noBackoff);
    expect(a.loop.tick()).toBe(true);

    const reason = claimRows().filter((row) => row.kind === "reason");
    expect(reason).toHaveLength(1);
    expect(reason[0]).toMatchObject({ intent_id: null, released_at: null });
    expect(runs(project.project.id)).toHaveLength(1);

    // B is stopped by its view of the ledger, so it never reaches an insert.
    expect(b.loop.tick()).toBe(false);
    expect(claimRows()).toHaveLength(1);

    // Both planes claim as `cairn-worker`, so a released reason lease leaves the claim index
    // as the only thing that can refuse the duplicate turn.
    db.withConn((conn) => releaseReason(conn, project.project.id, "cairn-worker"));
    expect(b.loop.tick()).toBe(false);
    expect(
      b.logs.some((line) => line.includes("claim lost") && line.includes("status=409")),
    ).toBe(true);
    expect(claimRows()).toHaveLength(1);
    // The loser's transaction rolled back, so the graph lease it grabbed is empty again.
    expect(reasonWorker(project.project.id)).toBeNull();

    await a.drain();
    // The released claim frees the slot at once: the reason index is per project, not per boot.
    expect(b.loop.tick()).toBe(true);
    const rows = claimRows().filter((row) => row.kind === "reason");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.instance_id).not.toBe(rows[0]!.instance_id);
    await b.drain();
  });

  test("concurrency caps count the ledger, not each task map", async () => {
    const capped = parseDispatchConfig({
      ...CONFIG,
      runtime: { ...CONFIG.runtime, max_workers: 1, max_project_workers: 1 },
    });
    const project = createProjectRow(false);
    openIntent(project.project.id, "direction one");
    openIntent(project.project.id, "direction two");

    const a = boot(capped);
    const b = boot(capped);
    expect(a.loop.tick()).toBe(true);
    // Two intents are open and B has a whole worker pool to itself, but the single global
    // slot is already spent by A's claim.
    expect(b.loop.runningCount).toBe(0);
    expect(b.loop.tick()).toBe(false);
    expect(activeClaims()).toHaveLength(1);
    expect(runs(project.project.id)).toHaveLength(1);
    const owner = claimRows()[0]!.instance_id;

    const before = claimIds();
    await a.drain();
    expect(b.loop.tick()).toBe(true);
    expect(activeClaims()).toHaveLength(1);
    const [second] = claimsAddedSince(before);
    expect(second!.instance_id).not.toBe(owner);
    await b.drain();
  });

  test("a graceful stop releases its claims so a peer dispatches at once", async () => {
    const project = createProjectRow(false);
    openIntent(project.project.id, "direction one");

    const a = boot();
    expect(a.loop.tick()).toBe(true);
    const owner = claimRows()[0]!.instance_id;

    const b = boot();
    b.loop.start();
    try {
      // A still beats, so B's boot left A's rows alone and dispatched nothing of its own.
      expect(claimRows()).toHaveLength(1);
      expect(instanceRows()).toHaveLength(2);
      expect(b.logs.some((line) => line.includes("startup reconcile skipped"))).toBe(true);

      await a.loop.stop();
      expect(claimRows()[0]).toMatchObject({ release_reason: "cancelled" });
      expect(activeClaims()).toEqual([]);

      // No lease to wait out: the work is dispatchable the moment its owner stops.
      const before = claimIds();
      expect(b.loop.tick()).toBe(true);
      const [second] = claimsAddedSince(before);
      expect(second).toMatchObject({
        project_id: project.project.id,
        released_at: null,
      });
      expect(second!.instance_id).not.toBe(owner);
    } finally {
      await b.drain();
    }
  });

  test("a crashed owner keeps its claim until the lease runs out", async () => {
    const project = createProjectRow(false);
    const intent = openIntent(project.project.id, "direction one");

    const a = boot();
    expect(a.loop.tick()).toBe(true);
    const taskId = claimRows()[0]!.task_id;
    const owner = claimRows()[0]!.instance_id;

    const b = boot();
    // A is gone — no beat for longer than the window — but its task lease still covers the
    // work, so B waits: a container worker can outlive the control plane that started it.
    advance(PEER_TIMEOUT_SECONDS + 1);
    setLease(taskId, PEER_TIMEOUT_SECONDS + 90);
    b.loop.sweepNow();
    expect(claimRows()[0]).toMatchObject({ released_at: null });
    expect(
      b.logs.some(
        (line) =>
          line.includes("stale claim waiting") &&
          line.includes(`task=${taskId}`) &&
          line.includes(`owner=${owner}`),
      ),
    ).toBe(true);
    // The live lease also holds the slot: B budgets against the ledger, not its empty map.
    expect(b.loop.tick()).toBe(false);

    advance(PEER_TIMEOUT_SECONDS + 91);
    b.loop.sweepNow();
    expect(claimRows()[0]).toMatchObject({
      released_at: stamp(PEER_TIMEOUT_SECONDS + 91),
      release_reason: CLAIM_RELEASE_OWNER_EXPIRED,
    });
    expect(
      b.logs.some(
        (line) =>
          line.includes("stale claim released") &&
          line.includes(`task=${taskId}`) &&
          line.includes(`reason=${CLAIM_RELEASE_OWNER_EXPIRED}`),
      ),
    ).toBe(true);
    expect(
      b.logs.some((line) => line.includes("claim reap released 1 stale claim(s)")),
    ).toBe(true);

    // Released, never deleted: the crashed boot's row stays for attribution and the slot is
    // free again. M39 takes over claims, not graph leases, so i001 still carries the dead
    // boot's `intents.worker` and the peer's first move is the slow layer.
    const before = claimIds();
    expect(b.loop.tick()).toBe(true);
    expect(claimRows()).toHaveLength(2);
    const [second] = claimsAddedSince(before);
    expect(second).toMatchObject({
      kind: "reason",
      intent_id: null,
      project_id: project.project.id,
      created_at: stamp(PEER_TIMEOUT_SECONDS + 91),
      released_at: null,
    });
    expect(second!.instance_id).not.toBe(owner);
    expect(claimRows().find((row) => row.task_id === taskId)!.released_at).not.toBeNull();
    // Takeover moves the claim ledger only: the graph lease the dead boot grabbed stays on the
    // intent, which is what lets a rollback to M38 drop this table without migration.
    expect(intentWorker(intent.id)).toBe("cairn-worker");

    await a.drain();
    await b.drain();
  });

  test("a live owner past its lease is left to its own renewal path", () => {
    const project = createProjectRow(false);
    openIntent(project.project.id, "direction one");

    const a = boot();
    expect(a.loop.tick()).toBe(true);
    const owner = claimRows()[0]!.instance_id;

    const b = boot();
    // Past the claim lease, well inside the heartbeat window.
    advance(LEASE_SECONDS + 1);
    b.loop.sweepNow();

    expect(claimRows()[0]).toMatchObject({ released_at: null, instance_id: owner });
    expect(b.logs.join("\n")).not.toContain("stale claim");
  });
});
