import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeProject,
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  getProjectDetail,
  heartbeatIntent,
  listPendingConcludes,
  listProjectArtifacts,
  recordPendingConclude,
  recordProjectArtifacts,
  type CairnDatabase,
  type ProjectDetail,
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
};

const WORKER = "cairn-worker";
const DAY = 86_400_000;

let directory: string;
let workspaceRoot: string;
let db: CairnDatabase;
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-sweep-"));
  workspaceRoot = join(directory, "workspace");
  db = configureDatabase(join(directory, "cairn.db"));
  logs = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createProjectRow(): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: "sweep",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: false,
      hints: null,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
}

function createOpenIntent(projectId: string, claim = false): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe",
      creator: "tester",
      worker: null,
    });
    if (claim) heartbeatIntent(conn, projectId, intent.id, WORKER);
    return intent.id;
  });
}

function queue(projectId: string, intentId: string, session: string): void {
  db.withConn((conn) =>
    recordPendingConclude(conn, {
      projectId,
      intentId,
      phase: "explore",
      session,
    }),
  );
}

/** Creates a session directory with a solver JSONL and returns its relative path. */
function makeSession(projectId: string, name: string, mtime = new Date()): string {
  const host = join(workspaceRoot, projectId, ...".cairn/sessions".split("/"), name);
  mkdirSync(join(host, "solver-session"), { recursive: true });
  writeFileSync(join(host, "solver-session", "session.jsonl"), "{}\n", "utf8");
  utimesSync(host, mtime, mtime);
  return `.cairn/sessions/${name}`;
}

function sessionPath(projectId: string, name: string): string {
  return join(workspaceRoot, projectId, ...".cairn/sessions".split("/"), name);
}

function sweeper(retention: Record<string, unknown> = {}): Scheduler {
  return new Scheduler({
    db,
    config: parseDispatchConfig({ ...CONFIG, retention }),
    workspaceRoot,
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
  });
}

describe("pending conclude reconciliation", () => {
  test("drops rows for missing sessions, concluded intents and inactive projects", () => {
    const project = createProjectRow();
    const projectId = project.project.id;

    const missing = createOpenIntent(projectId, true);
    queue(projectId, missing, ".cairn/sessions/gone");

    const concluded = createOpenIntent(projectId);
    const closedSession = makeSession(projectId, "explore-closed");
    db.withConn((conn) => {
      heartbeatIntent(conn, projectId, concluded, WORKER);
      concludeIntent(conn, projectId, concluded, WORKER, "done");
    });
    queue(projectId, concluded, closedSession);

    queue(projectId, "i999", makeSession(projectId, "explore-ghost"));

    const done = createProjectRow();
    db.withConn((conn) =>
      completeProject(conn, done.project.id, {
        from: ["origin"],
        description: "complete",
        worker: "tester",
      }),
    );
    queue(
      done.project.id,
      "i999",
      makeSession(done.project.id, "explore-done"),
    );

    sweeper().sweepNow();

    expect(db.withConn((conn) => listPendingConcludes(conn, projectId))).toEqual([]);
    expect(db.withConn((conn) => listPendingConcludes(conn, done.project.id))).toEqual([]);
    const released = db
      .withConn((conn) => getProjectDetail(conn, projectId))
      .intents.find((intent) => intent.id === missing);
    expect(released?.worker).toBeNull();
    expect(logs.some((line) => line.includes("session missing"))).toBe(true);
    expect(logs.some((line) => line.includes("intent concluded"))).toBe(true);
    expect(logs.some((line) => line.includes("project completed"))).toBe(true);
  });

  test("keeps rows whose intent and session are still usable", () => {
    const project = createProjectRow();
    const projectId = project.project.id;
    const intentId = createOpenIntent(projectId, true);
    queue(projectId, intentId, makeSession(projectId, "explore-live"));

    sweeper().sweepNow();

    expect(
      db.withConn((conn) => listPendingConcludes(conn, projectId)).map((row) => row.intent_id),
    ).toEqual([intentId]);
  });
});

describe("session retention", () => {
  test("deletes by age while protecting queued sessions and other files", () => {
    const project = createProjectRow();
    const projectId = project.project.id;
    const now = Date.now();

    makeSession(projectId, "fresh", new Date(now));
    const stale = makeSession(projectId, "stale", new Date(now - 40 * DAY));
    const queued = makeSession(projectId, "queued", new Date(now - 50 * DAY));
    const intentId = createOpenIntent(projectId, true);
    queue(projectId, intentId, queued);

    const board = join(workspaceRoot, projectId, ".cairn", "board", "notes.md");
    mkdirSync(join(workspaceRoot, projectId, ".cairn", "board"), { recursive: true });
    writeFileSync(board, "keep", "utf8");

    sweeper({ session_max_age_days: 30 }).sweepNow();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(sessionPath(projectId, "fresh"))).toBe(true);
    expect(existsSync(sessionPath(projectId, "queued"))).toBe(true);
    expect(existsSync(board)).toBe(true);
    expect(logs.some((line) => line.includes("reason=age"))).toBe(true);
  });

  test("keeps the newest N sessions per project", () => {
    const project = createProjectRow();
    const projectId = project.project.id;
    const now = Date.now();

    makeSession(projectId, "newest", new Date(now));
    const middle = makeSession(projectId, "middle", new Date(now - DAY));
    const queued = makeSession(projectId, "queued", new Date(now - 20 * DAY));
    const intentId = createOpenIntent(projectId, true);
    queue(projectId, intentId, queued);

    sweeper({ session_keep_per_project: 1 }).sweepNow();

    expect(existsSync(middle)).toBe(false);
    expect(existsSync(sessionPath(projectId, "newest"))).toBe(true);
    expect(existsSync(sessionPath(projectId, "queued"))).toBe(true);
    expect(logs.some((line) => line.includes("reason=count"))).toBe(true);
  });
});

describe("artifact refresh", () => {
  test("re-indexes artifacts during a sweep and preserves task provenance", () => {
    const project = createProjectRow();
    const projectId = project.project.id;
    const workspace = join(workspaceRoot, projectId);
    const artifacts = join(workspace, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "a.txt"), "alpha", "utf8");
    db.withConn((conn) =>
      recordProjectArtifacts(conn, { projectId, taskId: "task-1", workspace }),
    );

    writeFileSync(join(artifacts, "a.txt"), "changed", "utf8");
    writeFileSync(join(artifacts, "b.txt"), "beta", "utf8");
    sweeper({ refresh_artifacts: true }).sweepNow();

    const indexed = db.withConn((conn) => listProjectArtifacts(conn, projectId));
    expect(indexed.map((artifact) => artifact.path)).toEqual(["a.txt", "b.txt"]);
    const byPath = new Map(indexed.map((artifact) => [artifact.path, artifact]));
    expect(byPath.get("a.txt")).toMatchObject({ task_id: "task-1", size: 7 });
    expect(byPath.get("b.txt")?.task_id).toBe("retention-sweep");
  });
});
