import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createIntent,
  createProject,
  getFactMeta,
  getProjectDetail,
  getTaskAudit,
  hashFileSha256,
  listFactEvidence,
  listPendingConcludes,
  listProjectArtifacts,
  listProjectAudit,
  listProjectRuns,
  recordPendingConclude,
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
};

const SCOPE = { targets: ["127.0.0.1:8080"] };

let directory: string;
let db: CairnDatabase;
let config: DispatchConfig;
let logs: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-scheduler-"));
  db = configureDatabase(join(directory, "cairn.db"));
  config = parseDispatchConfig(CONFIG);
  logs = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createProjectRow(bootstrapEnabled: boolean, scope = SCOPE): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: `scheduler-${bootstrapEnabled}`,
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: bootstrapEnabled,
      hints: null,
      scope,
    }),
  );
}

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}

function scheduler(): Scheduler {
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
  });
}

function flakyScheduler(retainTaskFiles = true): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "flaky-worker.ts");
  const flakyConfig =
    retainTaskFiles === true
      ? config
      : parseDispatchConfig({
          ...CONFIG,
          worker: { ...CONFIG.worker, retain_task_files: false },
        });
  return new Scheduler({
    db,
    config: flakyConfig,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function auditScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "audit-worker.ts");
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function slicedScheduler(): Scheduler {
  return new Scheduler({
    db,
    config: parseDispatchConfig({
      ...CONFIG,
      tasks: {
        ...CONFIG.tasks,
        graph_slice: { enabled: true, max_facts: 80, max_intents: 60 },
      },
    }),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
  });
}

describe("scheduler with the fake solver", () => {
  test(
    "drives a non-bootstrap project to completion with two facts",
    async () => {
      const project = createProjectRow(false);
      const loop = scheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      if (detail.project.status !== "completed") {
        console.error(logs.join("\n"));
        console.error(JSON.stringify(detail, null, 2));
      }
      expect(detail.project.status).toBe("completed");

      const dynamicFacts = detail.facts.filter(
        (fact) => fact.id !== "origin" && fact.id !== "goal",
      );
      expect(dynamicFacts).toHaveLength(2);
      expect(dynamicFacts.every((fact) => fact.description.startsWith("fake fact"))).toBe(
        true,
      );

      const completion = detail.intents.find((intent) => intent.to === "goal");
      expect(completion).toBeDefined();
      expect(completion!.from).toEqual(dynamicFacts.map((fact) => fact.id));
      expect(completion!.worker).toBe("cairn-worker");

      const exploreIntents = detail.intents.filter((intent) => intent.to !== "goal");
      expect(exploreIntents).toHaveLength(2);
      expect(exploreIntents.every((intent) => intent.concluded_at !== null)).toBe(true);
      expect(loop.runningCount).toBe(0);
    },
    30_000,
  );

  test(
    "bootstrap produces a fact and completes the project",
    async () => {
      const project = createProjectRow(true);
      const loop = scheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("completed");

      const bootstrapFact = detail.facts.find(
        (fact) => fact.description === "fake bootstrap fact",
      );
      expect(bootstrapFact).toBeDefined();

      const bootstrapIntent = detail.intents.find(
        (intent) => intent.description === "bootstrap",
      );
      expect(bootstrapIntent?.to).toBe(bootstrapFact!.id);
      expect(bootstrapIntent?.creator).toBe("dispatcher.bootstrap");

      const completion = detail.intents.find((intent) => intent.to === "goal");
      expect(completion?.from).toEqual([bootstrapFact!.id]);
      expect(detail.facts).toHaveLength(3);
    },
    30_000,
  );

  test(
    "indexes artifacts after a task finishes",
    async () => {
      const project = createProjectRow(false);
      const artifactsDir = join(
        directory,
        "workspace",
        project.project.id.replaceAll("/", "-"),
        "artifacts",
      );
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(join(artifactsDir, "evidence.txt"), "captured", "utf8");

      const loop = scheduler();
      await loop.runUntilIdle();

      const artifacts = db.withConn((conn) =>
        listProjectArtifacts(conn, project.project.id),
      );
      // The fake solver also writes one evidence file per fact task; keep this test
      // focused on the pre-existing file.
      const evidence = artifacts.find((artifact) => artifact.path === "evidence.txt");
      expect(evidence).toMatchObject({ path: "evidence.txt", size: 8 });
      expect(evidence!.sha256).toHaveLength(64);
    },
    30_000,
  );

  test(
    "records one run per task and evidence for every produced fact",
    async () => {
      const project = createProjectRow(false);
      const loop = scheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      const dynamicFacts = detail.facts.filter(
        (fact) => fact.id !== "origin" && fact.id !== "goal",
      );
      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));

      expect(runs.length).toBeGreaterThanOrEqual(4);
      expect(runs.every((run) => run.outcome === "success")).toBe(true);
      expect(runs.filter((run) => run.kind !== "reason")).toHaveLength(
        dynamicFacts.length,
      );
      expect(
        runs.every(
          (run) =>
            run.session !== null &&
            !run.session.startsWith("/") &&
            !run.session.includes("\\") &&
            !run.session.includes(directory),
        ),
      ).toBe(true);

      for (const fact of dynamicFacts) {
        const meta = db.withConn((conn) =>
          getFactMeta(conn, project.project.id, fact.id),
        );
        expect(meta).not.toBeNull();
        expect(meta!.evidence_status).toBe("provided");
        expect(meta!.run_id).not.toBeNull();
        expect(meta!.evidence_refs).toHaveLength(1);
        expect(meta!.evidence_refs[0]!.startsWith("artifacts/fake-")).toBe(true);

        const files = db.withConn((conn) =>
          listFactEvidence(conn, project.project.id, fact.id),
        );
        expect(files).toHaveLength(1);
        expect(files![0]!.path).toBe(meta!.evidence_refs[0]!);
        const evidencePath = join(
          directory,
          "workspace",
          project.project.id.replaceAll("/", "-"),
          files![0]!.path,
        );
        expect(files![0]!.size).toBe(readFileSync(evidencePath).byteLength);
        expect(files![0]!.sha256).toBe(hashFileSha256(evidencePath));

        const run = runs.find((entry) => entry.id === meta!.run_id);
        expect(run?.kind).toBe("explore");
        expect(run?.evidence_count).toBe(1);
      }

      const reasonRuns = runs.filter((run) => run.kind === "reason");
      expect(reasonRuns.every((run) => run.evidence_count === 0)).toBe(true);
    },
    30_000,
  );

  test(
    "resumes a crashed explore session in a conclude turn",
    async () => {
      const project = createProjectRow(false);
      const loop = flakyScheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("completed");

      const dynamic = detail.facts.filter(
        (fact) => fact.id !== "origin" && fact.id !== "goal",
      );
      expect(dynamic).toHaveLength(2);
      expect(dynamic.every((fact) => fact.description.startsWith("fake fact from"))).toBe(
        true,
      );
      expect(logs.some((line) => line.includes("conclude queued"))).toBe(true);
      expect(logs.some((line) => line.includes("dispatched conclude"))).toBe(true);

      const explored = detail.intents.filter(
        (intent) => intent.to !== null && intent.to !== "goal",
      );
      expect(explored).toHaveLength(2);
      expect(explored.every((intent) => intent.concluded_at !== null)).toBe(true);
    },
    // The flaky fixture delegates conclude to the real worker CLI. On Windows that takes
    // near 30s on its own, so the old bound flaked whenever the full suite ran in parallel.
    60_000,
  );

  test(
    "bootstrap conclude writes a fact without claiming completion",
    async () => {
      const project = createProjectRow(true);
      const loop = flakyScheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("completed");
      expect(
        detail.facts.some(
          (fact) => fact.description === "fake conclude fact from i001",
        ),
      ).toBe(true);
      expect(logs.some((line) => line.includes("phase=bootstrap"))).toBe(true);
    },
    60_000,
  );

  test(
    "dispatches a conclude queued by a previous process",
    async () => {
      const project = createProjectRow(false);
      const intent = db.withConn((conn) =>
        createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "queued before restart",
          creator: "tester",
          worker: null,
        }),
      );
      const session = ".cairn/sessions/explore-restart";
      const workspace = join(directory, "workspace", project.project.id);
      mkdirSync(join(workspace, ...session.split("/"), "solver-session"), {
        recursive: true,
      });
      writeFileSync(
        join(workspace, ...session.split("/"), "solver-session", "session.jsonl"),
        "{}\n",
        "utf8",
      );
      db.withConn((conn) =>
        recordPendingConclude(conn, {
          projectId: project.project.id,
          intentId: intent.id,
          phase: "explore",
          session,
        }),
      );
      expect(
        db.withConn((conn) => listPendingConcludes(conn, project.project.id)),
      ).toHaveLength(1);

      // A fresh scheduler has no in-memory queue: the row alone must drive dispatch.
      const loop = scheduler();
      await loop.runUntilIdle();

      expect(logs.some((line) => line.includes("dispatched conclude"))).toBe(true);
      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(
        runs.some((run) => run.kind === "conclude" && run.outcome === "success"),
      ).toBe(true);
      expect(
        db.withConn((conn) => listPendingConcludes(conn, project.project.id)),
      ).toEqual([]);
      const concluded = load(project.project.id).intents.find(
        (entry) => entry.id === intent.id,
      );
      expect(concluded?.to).not.toBeNull();
    },
    30_000,
  );

  test(
    "slices explore graph snapshots but not reason snapshots when enabled",
    async () => {
      const project = createProjectRow(false);
      const loop = slicedScheduler();
      await loop.runUntilIdle();

      const sessions = join(
        directory,
        "workspace",
        project.project.id,
        ".cairn",
        "sessions",
      );
      const dirs = readdirSync(sessions);
      const exploreDirs = dirs.filter((name) => name.startsWith("explore-"));
      const reasonDirs = dirs.filter((name) => name.startsWith("reason-"));
      expect(exploreDirs.length).toBeGreaterThan(0);
      expect(reasonDirs.length).toBeGreaterThan(0);

      const exploreYaml = readFileSync(
        join(sessions, exploreDirs[0]!, "graph.yaml"),
        "utf8",
      );
      expect(exploreYaml).toContain("slice:");
      expect(exploreYaml).toContain("focus_intent:");
      expect(exploreYaml).toContain("truncated:");

      for (const name of reasonDirs) {
        const reasonYaml = readFileSync(join(sessions, name, "graph.yaml"), "utf8");
        expect(reasonYaml).not.toContain("slice:");
      }
    },
    30_000,
  );

  test(
    "drops the failed and conclude session directories when retention is off",
    async () => {
      const project = createProjectRow(false);
      const loop = flakyScheduler(false);
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("completed");

      const sessions = join(
        directory,
        "workspace",
        project.project.id,
        ".cairn",
        "sessions",
      );
      const remaining = existsSync(sessions) ? readdirSync(sessions) : [];
      expect(remaining).toEqual([]);
      expect(logs.some((line) => line.includes("conclude queued"))).toBe(true);
    },
    30_000,
  );

  test(
    "ingests worker audit into the control-plane ledger",
    async () => {
      const project = createProjectRow(true);
      const loop = auditScheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("completed");

      const summaries = db.withConn((conn) =>
        listProjectAudit(conn, project.project.id),
      );
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        expect(summary.event_count).toBe(1);
        const audit = db.withConn((conn) =>
          getTaskAudit(conn, project.project.id, summary.task_id),
        );
        expect(audit.chain_ok).toBe(true);
        expect(audit.events[0]!.event).toMatchObject({
          type: "tool_call",
          decision: "allow",
        });
      }
      expect(logs.some((line) => line.includes("audit ingested"))).toBe(true);
    },
    30_000,
  );

  test("refuses to dispatch a project without a scope", async () => {
    const unscoped = db.withConn((conn) =>
      createProject(conn, {
        title: "no scope",
        origin: "origin",
        goal: "goal",
        bootstrap_enabled: false,
        hints: null,
        scope: null,
      }),
    );

    const loop = scheduler();
    await loop.runUntilIdle();

    const detail = load(unscoped.project.id);
    expect(detail.project.status).toBe("active");
    expect(detail.intents).toHaveLength(0);
    expect(detail.facts).toHaveLength(2);
    expect(logs.some((line) => line.includes("no authorized scope"))).toBe(true);
  });
});
