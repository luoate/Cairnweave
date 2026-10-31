import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  heartbeatSchedulerInstance,
  listActiveSchedulerPeers,
  registerSchedulerInstance,
  stopSchedulerInstance,
  type CairnDatabase,
  type SchedulerInstanceRow,
} from "./index";

let directory: string;
let db: CairnDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-scheduler-instances-"));
  db = configureDatabase(join(directory, "cairn.db"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function register(id: string, at: string): void {
  db.withConn((conn) => registerSchedulerInstance(conn, { id, at }));
}

function row(id: string): SchedulerInstanceRow | null {
  return db.withConn(
    (conn) =>
      conn
        .query(
          `SELECT id, started_at, heartbeat_at, stopped_at
           FROM scheduler_instances WHERE id = ?`,
        )
        .get(id) as SchedulerInstanceRow | null,
  );
}

function peers(
  instanceId: string,
  now: string,
  timeoutSeconds: number,
): SchedulerInstanceRow[] {
  return db.withConn((conn) =>
    listActiveSchedulerPeers(conn, instanceId, { now, timeoutSeconds }),
  );
}

describe("scheduler instance liveness", () => {
  test("registers one boot row and keeps a stopped boot stopped", () => {
    register("boot_a", "2026-01-02T03:00:00Z");
    expect(row("boot_a")).toEqual({
      id: "boot_a",
      started_at: "2026-01-02T03:00:00Z",
      heartbeat_at: "2026-01-02T03:00:00Z",
      stopped_at: null,
    });

    // Re-registering the same boot id only refreshes the heartbeat; the boot moment stays.
    register("boot_a", "2026-01-02T03:00:30Z");
    expect(row("boot_a")).toMatchObject({
      started_at: "2026-01-02T03:00:00Z",
      heartbeat_at: "2026-01-02T03:00:30Z",
    });

    db.withConn((conn) => stopSchedulerInstance(conn, "boot_a", "2026-01-02T03:01:00Z"));
    expect(row("boot_a")?.stopped_at).toBe("2026-01-02T03:01:00Z");

    // A late heartbeat must not resurrect a boot that already stopped.
    db.withConn((conn) => heartbeatSchedulerInstance(conn, "boot_a", "2026-01-02T03:02:00Z"));
    expect(row("boot_a")?.heartbeat_at).toBe("2026-01-02T03:00:30Z");
  });

  test("reports peers inside the window, excluding this instance and stale or stopped rows", () => {
    register("boot_self", "2026-01-02T03:00:00Z");
    register("boot_boundary", "2026-01-02T03:00:00Z");
    register("boot_live", "2026-01-02T03:00:10Z");
    register("boot_stale", "2026-01-02T02:00:00Z");
    register("boot_stopped", "2026-01-02T03:00:05Z");
    db.withConn((conn) => stopSchedulerInstance(conn, "boot_stopped", "2026-01-02T03:01:00Z"));

    const live = peers("boot_self", "2026-01-02T03:00:30Z", 30);
    // Exactly `timeoutSeconds` old still counts as alive, so one lost beat does not.
    expect(live.map((peer) => peer.id)).toEqual(["boot_boundary", "boot_live"]);
  });

  test("treats a row with an unreadable heartbeat as dead", () => {
    register("boot_self", "2026-01-02T03:00:00Z");
    db.withConn((conn) =>
      conn
        .query(
          `INSERT INTO scheduler_instances (id, started_at, heartbeat_at, stopped_at)
           VALUES ('boot_garbage', 'not a date', 'not a date', NULL)`,
        )
        .run(),
    );

    expect(peers("boot_self", "2026-01-02T03:00:30Z", 30)).toEqual([]);
  });
});
