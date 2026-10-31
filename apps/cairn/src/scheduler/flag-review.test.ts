import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  decideFlagReview,
  getProjectDetail,
  listFlagReviews,
  listProjectRuns,
  summarizeFlagReviews,
  type CairnDatabase,
  type FlagReview,
  type FlagReviewSummary,
  type ProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig } from "../config";
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
  strategist: {
    cooldown_seconds: 0,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
  },
};

const CAPTURED_FLAG = "flag{review_value}";

let directory: string;
let db: CairnDatabase;
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-flag-review-"));
  db = configureDatabase(join(directory, "cairn.db"));
  logs = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createRow(): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: "flag review",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: false,
      hints: null,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
}

function scheduler(flagReview: "manual" | "off" = "manual"): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "flag-worker.ts");
  const config =
    flagReview === "off"
      ? parseDispatchConfig({ ...CONFIG, verification: { flag_review: "off" } })
      : parseDispatchConfig(CONFIG);
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

async function advance(loop: Scheduler): Promise<void> {
  loop.tick();
  await loop.waitForIdle();
}

async function drive(
  loop: Scheduler,
  done: () => boolean,
  maxSteps = 12,
): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    await advance(loop);
    if (done()) return;
  }
  throw new Error("scheduler did not reach the expected state");
}

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}

function summary(projectId: string): FlagReviewSummary {
  return db.withConn((conn) => summarizeFlagReviews(conn, projectId));
}

function reviews(projectId: string): FlagReview[] {
  return db.withConn((conn) => listFlagReviews(conn, projectId));
}

function runCount(projectId: string): number {
  return db.withConn((conn) => listProjectRuns(conn, projectId).length);
}

async function capture(loop: Scheduler, projectId: string): Promise<FlagReview> {
  await drive(loop, () => summary(projectId).pending.length === 1);
  const pending = summary(projectId).pending[0];
  if (pending === undefined) throw new Error("no pending review");
  return pending;
}

describe("scheduler flag review capture", () => {
  test(
    "captures a flag but keeps dispatching while the review is pending",
    async () => {
      const project = createRow();
      const projectId = project.project.id;
      const loop = scheduler();

      const pending = await capture(loop, projectId);

      expect(pending.flag).toBe(CAPTURED_FLAG);
      expect(pending.fact_id).not.toBeNull();
      expect(load(projectId).project.status).toBe("active");
      expect(
        load(projectId).facts.some(
          (fact) => fact.id === pending.fact_id && fact.description.includes(CAPTURED_FLAG),
        ),
      ).toBe(true);

      const before = runCount(projectId);
      await loop.runUntilIdle();

      expect(runCount(projectId)).toBeGreaterThan(before);
      expect(load(projectId).project.status).toBe("completed");
      // The automated completion claim is not an operator verdict.
      expect(summary(projectId).pending).toHaveLength(1);
      expect(reviews(projectId)).toHaveLength(1);
      expect(logs.some((line) => line.includes("flag review is pending"))).toBe(false);
      expect(
        logs.some((line) => line.includes("deferred") && line.includes("flag review")),
      ).toBe(false);
    },
    60_000,
  );

  test(
    "a rejected decoy is recorded once and later sightings stay decided",
    async () => {
      const project = createRow();
      const projectId = project.project.id;
      const loop = scheduler();

      const pending = await capture(loop, projectId);
      db.withConn((conn) => decideFlagReview(conn, projectId, pending.id, "fake"));

      await loop.runUntilIdle();

      const snapshot = summary(projectId);
      expect(load(projectId).project.status).toBe("completed");
      expect(snapshot.pending).toEqual([]);
      expect(snapshot.rejected).toEqual([CAPTURED_FLAG]);
      expect(snapshot.counts.fake).toBe(1);
      expect(reviews(projectId)).toHaveLength(1);
    },
    60_000,
  );

  test(
    "an accepted flag leaves the project free to finish on its own",
    async () => {
      const project = createRow();
      const projectId = project.project.id;
      const loop = scheduler();

      const pending = await capture(loop, projectId);
      db.withConn((conn) => decideFlagReview(conn, projectId, pending.id, "real_more"));

      await loop.runUntilIdle();

      expect(load(projectId).project.status).toBe("completed");
      expect(summary(projectId).counts).toMatchObject({ real_more: 1, pending: 0 });
    },
    60_000,
  );

  test(
    "flag_review off skips the review and the project runs to completion",
    async () => {
      const project = createRow();
      const projectId = project.project.id;
      const loop = scheduler("off");

      await loop.runUntilIdle();

      expect(load(projectId).project.status).toBe("completed");
      expect(reviews(projectId)).toEqual([]);
      expect(summary(projectId).counts).toEqual({
        pending: 0,
        real_more: 0,
        real_done: 0,
        fake: 0,
        dismissed: 0,
      });
    },
    60_000,
  );
});
