import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getFactMeta,
  getProjectDetail,
  listProjectRuns,
  type CairnDatabase,
  type ProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig, type DispatchConfig } from "../config";
import { Scheduler } from "./loop";

const CONFIG = {
  server: "http://127.0.0.1:8000",
  runtime: {
    execution: "local",
    max_workers: 2,
    max_running_projects: 2,
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
  // The fixture writes one real file and one path that never exists; completion is
  // automatic so the test can reach the goal without an operator review.
  verification: { evidence_completion: "auto" },
  strategist: {
    cooldown_seconds: 0,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
  },
};

const FIXTURE = "mixed-evidence-worker.ts";

let directory: string;
let db: CairnDatabase;
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-evidence-policy-"));
  db = configureDatabase(join(directory, "cairn.db"));
  logs = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createRow(): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: "evidence policy",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: true,
      hints: null,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
}

function scheduler(config: DispatchConfig = parseDispatchConfig(CONFIG)): Scheduler {
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath: string) => [
      process.execPath,
      join(import.meta.dir, "testdata", FIXTURE),
      taskPath,
    ],
  });
}

async function advance(loop: Scheduler): Promise<void> {
  loop.tick();
  await loop.waitForIdle();
}

async function drive(loop: Scheduler, done: () => boolean, maxSteps = 12): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    await advance(loop);
    if (done()) return;
  }
  throw new Error("scheduler did not reach the expected state");
}

function runs(projectId: string) {
  return db.withConn((conn) => listProjectRuns(conn, projectId));
}

describe("evidence invalid-ref policy", () => {
  test(
    "drops only the missing ref and keeps the fact (default)",
    async () => {
      const project = createRow();
      const projectId = project.project.id;
      const loop = scheduler();

      await advance(loop);

      const detail = db.withConn((conn) => getProjectDetail(conn, projectId));
      const fact = detail.facts.find((item) => item.description === "mixed bootstrap fact");
      expect(fact).toBeDefined();
      expect(detail.project.status).toBe("active");

      const meta = db.withConn((conn) => getFactMeta(conn, projectId, fact!.id));
      expect(meta!.evidence_status).toBe("provided");
      expect(meta!.evidence_refs).toHaveLength(1);
      expect(meta!.evidence_refs[0]).toContain(`mixed-bootstrap-`);

      const bootstrapRun = runs(projectId).find((run) => run.kind === "bootstrap");
      expect(bootstrapRun?.outcome).toBe("success");
      expect(bootstrapRun?.evidence_count).toBe(1);
      expect(bootstrapRun?.detail).toContain("invalid evidence refs dropped");
      expect(bootstrapRun?.detail).toContain("file does not exist");
      expect(logs.some((line) => line.includes("evidence refs dropped"))).toBe(true);

      // The project keeps going: the second fact has the same shape and the reason turn
      // still completes from both facts.
      await drive(loop, () => detailIsCompleted(projectId));
      expect(load(projectId).project.status).toBe("completed");
      expect(
        runs(projectId).every((run) => run.outcome === "success"),
      ).toBe(true);
    },
    60_000,
  );

  test(
    "rejects the run when invalid_refs is fail",
    async () => {
      const project = createRow();
      const projectId = project.project.id;
      const loop = scheduler(
        parseDispatchConfig({
          ...CONFIG,
          tasks: { ...CONFIG.tasks, evidence: { invalid_refs: "fail" } },
        }),
      );

      await advance(loop);

      const detail = db.withConn((conn) => getProjectDetail(conn, projectId));
      expect(
        detail.facts.some((fact) => fact.description === "mixed bootstrap fact"),
      ).toBe(false);

      const bootstrapRun = runs(projectId).find((run) => run.kind === "bootstrap");
      expect(bootstrapRun?.outcome).toBe("failed");
      expect(bootstrapRun?.failure).toEqual({
        domain: "execution",
        code: "evidence_invalid",
      });
      expect(bootstrapRun?.detail).toContain("invalid evidence:");
      expect(logs.some((line) => line.includes("evidence rejected"))).toBe(true);
    },
    60_000,
  );
});

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}

function detailIsCompleted(projectId: string): boolean {
  return load(projectId).project.status === "completed";
}
