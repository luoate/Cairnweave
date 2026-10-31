import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAIM_RELEASE_INSTANCE_STOPPED,
  CLAIM_RELEASE_OWNER_EXPIRED,
  CLAIM_RELEASE_SHUTDOWN,
  HttpError,
  claimTask,
  configureDatabase,
  createProject,
  getTaskClaim,
  listActiveTaskClaims,
  reapTaskClaims,
  registerSchedulerInstance,
  releaseTaskClaim,
  releaseTaskClaimsForInstance,
  renewTaskClaimLease,
  stopSchedulerInstance,
  type CairnDatabase,
  type ClaimTaskInput,
  type TaskClaim,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectA: string;
let projectB: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-task-claims-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectA = createProjectRow("a");
  projectB = createProjectRow("b");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createProjectRow(title: string): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title,
        origin: "start here",
        goal: "reach the end",
        bootstrap_enabled: true,
        hints: null,
        scope: null,
      }).project.id,
  );
}

/** One claim written in its own transaction, the way the dispatcher writes it. */
function claim(input: Partial<ClaimTaskInput> & { taskId: string }): TaskClaim {
  return db.withConn((conn) =>
    claimTask(conn, {
      instanceId: "boot_a",
      projectId: projectA,
      kind: "explore",
      worker: "cairn-worker",
      leaseSeconds: 15,
      at: "2026-01-02T03:00:00Z",
      ...input,
    }),
  );
}

function get(taskId: string): TaskClaim | null {
  return db.withConn((conn) => getTaskClaim(conn, taskId));
}

function claimError(input: Partial<ClaimTaskInput> & { taskId: string }): unknown {
  try {
    claim(input);
  } catch (error) {
    return error;
  }
  throw new Error(`claim ${input.taskId} unexpectedly succeeded`);
}

function active(now: string, projectId?: string): TaskClaim[] {
  return db.withConn((conn) => listActiveTaskClaims(conn, { now, projectId }));
}

function reap(now: string, timeoutSeconds = 30) {
  return db.withConn((conn) =>
    reapTaskClaims(conn, { now, instanceTimeoutSeconds: timeoutSeconds }),
  );
}

function peer(id: string, at: string): void {
  db.withConn((conn) => registerSchedulerInstance(conn, { id, at }));
}

function stopped(id: string, at: string): void {
  db.withConn((conn) => stopSchedulerInstance(conn, id, at));
}

describe("task claim ledger", () => {
  test("writes the ownership row a dispatcher needs", () => {
    const row = claim({
      taskId: "explore-1",
      runId: "run_1",
      intentId: "int_1",
    });
    expect(row).toEqual({
      task_id: "explore-1",
      run_id: "run_1",
      instance_id: "boot_a",
      project_id: projectA,
      intent_id: "int_1",
      kind: "explore",
      worker: "cairn-worker",
      created_at: "2026-01-02T03:00:00Z",
      lease_expires_at: "2026-01-02T03:00:15Z",
      released_at: null,
      release_reason: null,
    });
  });

  test("refuses a second active claim on the same intent", () => {
    claim({ taskId: "explore-1", intentId: "int_1" });

    const error = claimError({ taskId: "explore-2", intentId: "int_1" });
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(409);
    // The loser wrote nothing, so the ledger keeps exactly one owner for the intent.
    expect(get("explore-2")).toBeNull();

    // Another project may work the same-looking intent id, and a different intent in this
    // project is free: the index is per (project, intent).
    expect(
      claim({ taskId: "explore-3", projectId: projectB, intentId: "int_1" }).task_id,
    ).toBe("explore-3");
    expect(
      claim({ taskId: "explore-4", intentId: "int_2" }).task_id,
    ).toBe("explore-4");
  });

  test("holds one reason claim per project but not against an explore claim", () => {
    claim({ taskId: "reason-1", kind: "reason", intentId: null });
    expect((claimError({ taskId: "reason-2", kind: "reason" }) as HttpError).status).toBe(409);

    // The reason slot and an intent slot are different resources on the same project.
    expect(claim({ taskId: "explore-1", intentId: "int_1" }).task_id).toBe("explore-1");
    expect(active("2026-01-02T03:00:01Z", projectA).map((row) => row.task_id)).toEqual([
      "explore-1",
      "reason-1",
    ]);
  });

  test("releasing is idempotent and a released claim never revives", () => {
    claim({ taskId: "explore-1", intentId: "int_1" });

    expect(
      db.withConn((conn) => releaseTaskClaim(conn, "explore-1", "success", "2026-01-02T03:00:10Z")),
    ).toBe(true);
    expect(get("explore-1")).toMatchObject({
      released_at: "2026-01-02T03:00:10Z",
      release_reason: "success",
    });
    // A second release — the task's own `finish` racing the shutdown sweep — changes nothing.
    expect(
      db.withConn((conn) =>
        releaseTaskClaim(conn, "explore-1", CLAIM_RELEASE_SHUTDOWN, "2026-01-02T03:00:20Z"),
      ),
    ).toBe(false);
    expect(get("explore-1")).toMatchObject({
      released_at: "2026-01-02T03:00:10Z",
      release_reason: "success",
    });
    expect(db.withConn((conn) => releaseTaskClaim(conn, "gone", "success"))).toBe(false);

    // The intent is free for the next task, but the finished task id stays finished.
    expect(claim({ taskId: "explore-2", intentId: "int_1" }).task_id).toBe("explore-2");
    expect((claimError({ taskId: "explore-1", intentId: "int_2" }) as HttpError).status).toBe(409);
    expect(get("explore-1")?.release_reason).toBe("success");
  });

  test("the active view drops released and expired rows", () => {
    claim({ taskId: "explore-live", intentId: "int_1" });
    claim({ taskId: "explore-expired", intentId: "int_2", leaseSeconds: 5 });
    claim({ taskId: "explore-released", intentId: "int_3" });
    db.withConn((conn) => releaseTaskClaim(conn, "explore-released", "failed"));

    // Second precision, so `lease_expires_at` exactly equal to `now` has run out.
    expect(active("2026-01-02T03:00:05Z").map((row) => row.task_id)).toEqual(["explore-live"]);
    expect(active("2026-01-02T03:00:15Z")).toEqual([]);
  });

  test("renewal pushes the lease and stops working once the claim is gone", () => {
    claim({ taskId: "explore-1", intentId: "int_1", leaseSeconds: 5 });

    const renewed = db.withConn((conn) =>
      renewTaskClaimLease(conn, "explore-1", 15, "2026-01-02T03:00:04Z"),
    );
    expect(renewed).toBe(true);
    expect(get("explore-1")?.lease_expires_at).toBe("2026-01-02T03:00:19Z");

    db.withConn((conn) => releaseTaskClaim(conn, "explore-1", "success"));
    expect(
      db.withConn((conn) => renewTaskClaimLease(conn, "explore-1", 15, "2026-01-02T03:00:06Z")),
    ).toBe(false);
    expect(
      db.withConn((conn) => renewTaskClaimLease(conn, "never-claimed", 15)),
    ).toBe(false);
  });

  test("releases a whole instance at shutdown and leaves peers alone", () => {
    claim({ taskId: "explore-1", intentId: "int_1" });
    claim({ taskId: "explore-2", intentId: "int_2" });
    claim({ taskId: "explore-3", instanceId: "boot_b", intentId: "int_3" });

    const released = db.withConn((conn) =>
      releaseTaskClaimsForInstance(conn, "boot_a", CLAIM_RELEASE_SHUTDOWN, "2026-01-02T03:00:05Z"),
    );
    expect(released.map((row) => row.task_id)).toEqual(["explore-1", "explore-2"]);
    expect(get("explore-1")).toMatchObject({
      released_at: "2026-01-02T03:00:05Z",
      release_reason: CLAIM_RELEASE_SHUTDOWN,
    });
    expect(get("explore-3")?.released_at).toBeNull();
    // Nothing left to release: a repeated shutdown sweep is a no-op.
    expect(
      db.withConn((conn) => releaseTaskClaimsForInstance(conn, "boot_a", CLAIM_RELEASE_SHUTDOWN)),
    ).toEqual([]);
  });

  test("a stopped owner releases its claims at once", () => {
    peer("boot_a", "2026-01-02T03:00:00Z");
    // A long lease is irrelevant: a boot that wrote `stopped_at` will never release it itself.
    claim({ taskId: "explore-1", intentId: "int_1", leaseSeconds: 3600 });
    stopped("boot_a", "2026-01-02T03:00:01Z");

    const result = reap("2026-01-02T03:00:02Z");
    expect(result.released).toEqual([
      {
        task_id: "explore-1",
        run_id: null,
        instance_id: "boot_a",
        project_id: projectA,
        intent_id: "int_1",
        kind: "explore",
        worker: "cairn-worker",
        created_at: "2026-01-02T03:00:00Z",
        lease_expires_at: "2026-01-02T04:00:00Z",
        released_at: null,
        release_reason: null,
        reason: CLAIM_RELEASE_INSTANCE_STOPPED,
      },
    ]);
    expect(result.waiting).toEqual([]);
    expect(get("explore-1")).toMatchObject({
      released_at: "2026-01-02T03:00:02Z",
      release_reason: CLAIM_RELEASE_INSTANCE_STOPPED,
    });
  });

  test("a dead-looking owner with a live lease is waited out, then taken over", () => {
    peer("boot_a", "2026-01-02T03:00:00Z");
    claim({ taskId: "explore-1", intentId: "int_1", leaseSeconds: 60 });

    // Heartbeat older than the window, lease still running: the worker may still be alive.
    const first = reap("2026-01-02T03:00:40Z");
    expect(first.released).toEqual([]);
    expect(first.waiting.map((row) => row.task_id)).toEqual(["explore-1"]);
    expect(get("explore-1")?.released_at).toBeNull();

    const second = reap("2026-01-02T03:01:00Z");
    expect(second.released.map((row) => [row.task_id, row.reason])).toEqual([
      ["explore-1", CLAIM_RELEASE_OWNER_EXPIRED],
    ]);
    expect(get("explore-1")).toMatchObject({ release_reason: CLAIM_RELEASE_OWNER_EXPIRED });
  });

  test("never takes over a claim whose owner is still heartbeating", () => {
    peer("boot_a", "2026-01-02T03:00:50Z");
    claim({ taskId: "explore-1", intentId: "int_1", leaseSeconds: 10 });

    const result = reap("2026-01-02T03:01:00Z");
    // Past its lease but the owner is alive: that instance's own renewal path has to give it up,
    // so a peer leaves the row — and the slot it occupies — untouched.
    expect(result).toEqual({ released: [], waiting: [] });
    expect(get("explore-1")?.released_at).toBeNull();
  });

  test("treats a claim with no instance row as an owner that stopped beating", () => {
    claim({ taskId: "explore-1", instanceId: "boot_missing", intentId: "int_1", leaseSeconds: 60 });

    expect(reap("2026-01-02T03:00:30Z").waiting.map((row) => row.task_id)).toEqual([
      "explore-1",
    ]);
    expect(
      reap("2026-01-02T03:01:00Z").released.map((row) => row.reason),
    ).toEqual([CLAIM_RELEASE_OWNER_EXPIRED]);
  });

  test("reaping releases a claim a live instance can then replace", () => {
    peer("boot_a", "2026-01-02T02:00:00Z");
    claim({ taskId: "explore-1", intentId: "int_1", leaseSeconds: 15 });
    expect(
      (claimError({ taskId: "explore-2", instanceId: "boot_b", intentId: "int_1" }) as HttpError)
        .status,
    ).toBe(409);

    // The dead owner's lease has to run out first, then the intent is dispatchable again.
    expect(
      reap("2026-01-02T03:00:10Z").released.map((row) => row.task_id),
    ).toEqual([]);
    reap("2026-01-02T03:00:20Z");
    peer("boot_b", "2026-01-02T03:00:20Z");
    expect(
      claim({ taskId: "explore-2", instanceId: "boot_b", intentId: "int_1" }).instance_id,
    ).toBe("boot_b");
  });

  test("keeps released rows for attribution", () => {
    claim({ taskId: "explore-1", intentId: "int_1" });
    db.withConn((conn) => releaseTaskClaim(conn, "explore-1", "success"));
    expect(active("2026-01-02T03:00:01Z")).toEqual([]);
    expect(get("explore-1")).not.toBeNull();
    expect(
      db.withConn(
        (conn) =>
          conn.query("SELECT COUNT(*) AS n FROM task_claims").get() as { n: number },
      ).n,
    ).toBe(1);
  });
});
