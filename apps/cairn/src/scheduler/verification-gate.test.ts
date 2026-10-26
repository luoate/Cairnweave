import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getLatestVerificationCheck,
  getProjectDetail,
  type CairnDatabase,
  type ProjectDetail,
} from "@cairn/graph";

import { DEFAULT_VERIFICATION, parseDispatchConfig } from "../config";
import { VerificationService } from "../verification/oracle";
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

let directory: string;
let db: CairnDatabase;
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-verification-gate-"));
  db = configureDatabase(join(directory, "cairn.db"));
  logs = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createRow(
  bootstrapEnabled = false,
  verification?: { kind: "challenge" | "evidence" | "off"; challenge_code?: string | null },
): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: "gate",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: bootstrapEnabled,
      hints: null,
      scope: { targets: ["127.0.0.1:8080"] },
      ...(verification === undefined ? {} : { verification }),
    }),
  );
}

function scheduler(verification?: VerificationService): Scheduler {
  return new Scheduler({
    db,
    config: parseDispatchConfig(CONFIG),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    ...(verification === undefined ? {} : { verification }),
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

const CHALLENGE_ENV = {
  TCH_CHALLENGE_API_BASE_URL: "https://challenge.test",
  TCH_CHALLENGE_AGENT_TOKEN: "agent-token-value",
};

function challengeService(flagGotCount: number): VerificationService {
  let calls = 0;
  return new VerificationService(db, DEFAULT_VERIFICATION, {
    env: CHALLENGE_ENV,
    fetch: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          data: {
            challenges: [
              { code: "web-01", flag_count: 2, flag_got_count: flagGotCount },
            ],
          },
        }),
        { status: 200 },
      );
    },
  });
}

describe("scheduler completion verification", () => {
  test(
    "defers a rejected completion claim and keeps the project active",
    async () => {
      const project = createRow(false, { kind: "challenge", challenge_code: "web-01" });
      const loop = scheduler();
      const projectId = project.project.id;

      await drive(loop, () =>
        db.withConn((conn) => getLatestVerificationCheck(conn, projectId)) !== null,
      );

      const detail = load(projectId);
      expect(detail.project.status).toBe("active");
      expect(detail.project.reason).toBeNull();
      expect(logs.some((line) => line.includes("completion not verified"))).toBe(true);

      const check = db.withConn((conn) =>
        getLatestVerificationCheck(conn, project.project.id),
      );
      expect(check).toMatchObject({ kind: "challenge", ok: false });
      expect(check!.detail).toContain("TCH_CHALLENGE_API_BASE_URL");
    },
    60_000,
  );

  test(
    "completes a challenge-backed project when the oracle confirms every flag",
    async () => {
      const project = createRow(false, { kind: "challenge", challenge_code: "web-01" });
      const loop = scheduler(challengeService(2));
      const projectId = project.project.id;

      await drive(loop, () => load(projectId).project.status === "completed");

      const detail = load(projectId);
      expect(detail.project.status).toBe("completed");

      const check = db.withConn((conn) =>
        getLatestVerificationCheck(conn, projectId),
      );
      expect(check).toMatchObject({
        kind: "challenge",
        ok: true,
        flag_count: 2,
        flag_got_count: 2,
      });
    },
    60_000,
  );

  test(
    "keeps a partially solved challenge active",
    async () => {
      const project = createRow(false, { kind: "challenge", challenge_code: "web-01" });
      const loop = scheduler(challengeService(1));
      const projectId = project.project.id;

      await drive(loop, () =>
        db.withConn((conn) => getLatestVerificationCheck(conn, projectId)) !== null,
      );

      const detail = load(projectId);
      expect(detail.project.status).toBe("active");

      const check = db.withConn((conn) =>
        getLatestVerificationCheck(conn, projectId),
      );
      expect(check).toMatchObject({
        kind: "challenge",
        ok: false,
        flag_count: 2,
        flag_got_count: 1,
      });
    },
    60_000,
  );

  test(
    "defers bootstrap completion but keeps the produced fact",
    async () => {
      const project = createRow(true, { kind: "challenge", challenge_code: "web-01" });
      const loop = scheduler();

      await advance(loop);

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("active");
      expect(
        detail.facts.some((fact) => fact.description === "fake bootstrap fact"),
      ).toBe(true);
      expect(logs.some((line) => line.includes("bootstrap completion deferred"))).toBe(
        true,
      );
    },
    60_000,
  );

  test(
    "fails the task and stays active when verification itself errors",
    async () => {
      const project = createRow(false, { kind: "off" });
      const throwing = {
        verify: async () => {
          throw new Error("oracle exploded");
        },
      } as unknown as VerificationService;
      const loop = scheduler(throwing);
      const projectId = project.project.id;

      await drive(loop, () =>
        logs.some((line) => line.includes("verification error")),
      );

      const detail = load(projectId);
      expect(detail.project.status).toBe("active");
      expect(logs.some((line) => line.includes("oracle exploded"))).toBe(true);
    },
    60_000,
  );
});
