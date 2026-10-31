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
  finishRun,
  getAuditStreamLoss,
  getFactMeta,
  getProjectDetail,
  getStrategistState,
  getTaskAudit,
  hashFileSha256,
  listFactEvidence,
  listPendingConcludes,
  listProjectArtifacts,
  listProjectAudit,
  listProjectIntentMeta,
  listProjectRuns,
  recordIntentMeta,
  recordPendingConclude,
  requestStrategistReplan,
  startRun,
  type CairnDatabase,
  type ProjectDetail,
} from "@cairn/graph";

import { AuditTokenRegistry } from "../audit-stream/tokens";
import { parseDispatchConfig, type DispatchConfig } from "../config";
import { createApi } from "../http/api";
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
  // Keep dispatch deterministic in scheduling tests; trigger policy has its own tests.
  strategist: {
    cooldown_seconds: 0,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
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

function createProjectRow(
  bootstrapEnabled: boolean,
  scope = SCOPE,
  verification?: { kind: "challenge" | "evidence" | "off"; challenge_code?: string | null },
): ProjectDetail {
  return db.withConn((conn) =>
    createProject(conn, {
      title: `scheduler-${bootstrapEnabled}`,
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: bootstrapEnabled,
      hints: null,
      scope,
      ...(verification === undefined ? {} : { verification }),
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
    config: parseDispatchConfig({
      ...CONFIG,
      common_env: { CAIRN_TEST_AUDIT_LOST: "1" },
    }),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function ssrfScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "ssrf-env-worker.ts");
  return new Scheduler({
    db,
    config: parseDispatchConfig({
      ...CONFIG,
      server: "http://cairn-control.test:8000",
      scope: { ssrf_markers: "block", protected_hosts: ["Internal-Lab.test"] },
    }),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function concurrentScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "concurrent-worker.ts");
  return new Scheduler({
    db,
    config: parseDispatchConfig({
      ...CONFIG,
      runtime: { ...CONFIG.runtime, max_project_workers: 2 },
    }),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function successfulReasonScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "successful-reason-worker.ts");
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function failingReasonScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "failing-reason-worker.ts");
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function metaReasonScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "meta-reason-worker.ts");
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function rewordedReasonScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "reworded-reason-worker.ts");
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function usageScheduler(): Scheduler {
  const fixture = join(import.meta.dir, "testdata", "usage-worker.ts");
  return new Scheduler({
    db,
    config,
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
    workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
  });
}

function profileScheduler(): Scheduler {
  return new Scheduler({
    db,
    config: parseDispatchConfig({
      ...CONFIG,
      worker_profiles: [
        { id: "fast", model: "cairn-worker" },
        { id: "deep", model: "deep-reasoner" },
      ],
      worker_selection: { mode: "stats", min_runs: 1 },
    }),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
  });
}

function budgetScheduler(budget: {
  max_project_tokens?: number;
  max_project_cost_usd?: number;
  max_project_tasks?: number;
}): Scheduler {
  return new Scheduler({
    db,
    config: parseDispatchConfig({
      ...CONFIG,
      runtime: { ...CONFIG.runtime, max_project_workers: 2 },
      budget,
    }),
    workspaceRoot: join(directory, "workspace"),
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
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
    "selects worker profiles from stats and records them on runs",
    async () => {
      const project = createProjectRow(false);
      const loop = profileScheduler();
      await loop.runUntilIdle();

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(runs.length).toBeGreaterThanOrEqual(3);
      // min_runs=1 forces one sample per profile before exploitation; config order wins
      // the first dispatch and the second profile is explored next.
      expect(runs[0]!.worker_profile).toBe("fast");
      expect(new Set(runs.map((run) => run.worker_profile))).toEqual(
        new Set(["fast", "deep"]),
      );
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
    "runs two same-project tasks concurrently with scoped artifacts",
    async () => {
      // The fixture completes from the seed origin fact, which carries no evidence to
      // verify. Completion gating has dedicated coverage; keep this test about overlap.
      const project = createProjectRow(false, SCOPE, { kind: "off" });
      const first = db.withConn((conn) =>
        createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "concurrent direction one",
          creator: "tester",
          worker: null,
        }),
      );
      const second = db.withConn((conn) =>
        createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "concurrent direction two",
          creator: "tester",
          worker: null,
        }),
      );

      const loop = concurrentScheduler();
      await loop.runUntilIdle();

      const detail = load(project.project.id);
      expect(detail.project.status).toBe("completed");
      for (const intentId of [first.id, second.id]) {
        const intent = detail.intents.find((entry) => entry.id === intentId);
        expect(intent?.to).not.toBeNull();
      }

      // The fixture only reports this prefix when both explore workers met at the
      // in-workspace barrier, so it also proves the scheduler let them overlap.
      const facts = detail.facts.filter(
        (fact) => fact.id !== "origin" && fact.id !== "goal",
      );
      expect(facts).toHaveLength(2);
      expect(
        facts.every((fact) => fact.description.startsWith("concurrent fact from explore-")),
      ).toBe(true);

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      const exploreRuns = runs.filter((run) => run.kind === "explore");
      expect(exploreRuns).toHaveLength(2);
      expect(exploreRuns.every((run) => run.outcome === "success")).toBe(true);
      expect(new Set(exploreRuns.map((run) => run.task_id)).size).toBe(2);

      const artifacts = db.withConn((conn) =>
        listProjectArtifacts(conn, project.project.id),
      );
      const workspace = join(
        directory,
        "workspace",
        project.project.id.replaceAll("/", "-"),
      );
      for (const run of exploreRuns) {
        // Indexed paths are relative to the `artifacts/` root, not the workspace.
        const artifact = artifacts.find(
          (entry) => entry.path === `${run.task_id}/out.txt`,
        );
        expect(artifact).toBeDefined();
        // Provenance comes from the path namespace even though every finishing task
        // rescans the whole tree.
        expect(artifact!.task_id).toBe(run.task_id);

        const taskFile = JSON.parse(
          readFileSync(
            join(workspace, ...(run.session ?? "").split("/"), "task.json"),
            "utf8",
          ),
        ) as { artifactDir?: string; prompt: string };
        expect(taskFile.artifactDir).toBe(`artifacts/${run.task_id}`);
        expect(taskFile.prompt).toContain(`\`artifacts/${run.task_id}/\``);
      }
    },
    // Two workers plus a barrier timeout on failure; Windows process startup is slow.
    60_000,
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
    "writes an agent-context snapshot for reason and explore tasks",
    async () => {
      const project = createProjectRow(false);
      const loop = scheduler();
      await loop.runUntilIdle();

      const sessions = join(
        directory,
        "workspace",
        project.project.id,
        ".cairn",
        "sessions",
      );
      const dirs = readdirSync(sessions);
      const reasonDirs = dirs.filter((name) => name.startsWith("reason-"));
      const exploreDirs = dirs.filter((name) => name.startsWith("explore-"));
      expect(reasonDirs.length).toBeGreaterThan(0);
      expect(exploreDirs.length).toBeGreaterThan(0);

      const reason = readFileSync(
        join(sessions, reasonDirs[0]!, "agent-context.yaml"),
        "utf8",
      );
      expect(reason).toContain("version: 1");
      expect(reason).toContain("kind: reason");
      expect(reason).toContain("truncated:");
      expect(reason).toContain("verification:");

      const explore = readFileSync(
        join(sessions, exploreDirs[0]!, "agent-context.yaml"),
        "utf8",
      );
      expect(explore).toContain("kind: explore");
      expect(explore).toContain("status: open");
      expect(explore).toContain("attempts:");

      const task = JSON.parse(
        readFileSync(join(sessions, reasonDirs[0]!, "task.json"), "utf8"),
      ) as { prompt: string };
      expect(task.prompt).toContain("# Investigation State");
      expect(task.prompt).toContain("agent-context.yaml");
    },
    30_000,
  );

  test(
    "omits agent-context when strategy_context is off",
    async () => {
      const project = createProjectRow(false);
      const loop = new Scheduler({
        db,
        config: parseDispatchConfig({
          ...CONFIG,
          runtime: { ...CONFIG.runtime, strategy_context: "off" },
        }),
        workspaceRoot: join(directory, "workspace"),
        log: (message) => logs.push(message),
        leaseIntervalMs: 500,
      });
      await loop.runUntilIdle();

      const sessions = join(
        directory,
        "workspace",
        project.project.id,
        ".cairn",
        "sessions",
      );
      const dirs = readdirSync(sessions);
      expect(dirs.length).toBeGreaterThan(0);
      for (const name of dirs) {
        expect(existsSync(join(sessions, name, "agent-context.yaml"))).toBe(false);
        const task = JSON.parse(
          readFileSync(join(sessions, name, "task.json"), "utf8"),
        ) as { prompt: string };
        expect(task.prompt).not.toContain("# Investigation State");
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

      const lost = db.withConn((conn) =>
        getAuditStreamLoss(conn, project.project.id, summaries[0]!.task_id),
      );
      expect(lost).toMatchObject({
        task_id: summaries[0]!.task_id,
        reason: "queue overflow",
        delivered: 0,
        pending: 1,
        reported_at: "2026-03-01T00:00:00.000Z",
      });
      expect(logs.some((line) => line.includes("audit stream lost"))).toBe(true);
    },
    30_000,
  );

  test(
    "hands the SSRF marker policy and protected hosts down to the worker",
    async () => {
      const project = createProjectRow(true);
      const loop = ssrfScheduler();
      await loop.runUntilIdle();

      expect(load(project.project.id).project.status).toBe("completed");
      const summaries = db.withConn((conn) =>
        listProjectAudit(conn, project.project.id),
      );
      expect(summaries.length).toBeGreaterThan(0);
      for (const summary of summaries) {
        const audit = db.withConn((conn) =>
          getTaskAudit(conn, project.project.id, summary.task_id),
        );
        expect(audit.events[0]!.event).toMatchObject({
          event: "ssrf_candidate",
          detail: "ssrf_markers=block protected=cairn-control.test,internal-lab.test",
        });
      }
    },
    30_000,
  );

  test(
    "streams audit entries live and backfills the rest at finish",
    async () => {
      const tokens = new AuditTokenRegistry();
      const api = createApi({ db, auditTokens: tokens });
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => api.handle(request),
      });
      try {
        const project = createProjectRow(true);

        const fixture = join(import.meta.dir, "testdata", "stream-worker.ts");
        const loop = new Scheduler({
          db,
          config: parseDispatchConfig({
            ...CONFIG,
            audit_stream: { enabled: true },
          }),
          workspaceRoot: join(directory, "workspace"),
          log: (message) => logs.push(message),
          leaseIntervalMs: 500,
          workerArgv: (taskPath) => [process.execPath, fixture, taskPath],
          auditTokens: tokens,
          auditStreamUrl: `http://127.0.0.1:${server.port}`,
        });

        await loop.runUntilIdle();

        const summaries = db.withConn((conn) =>
          listProjectAudit(conn, project.project.id),
        );
        expect(summaries).toHaveLength(1);
        const taskId = summaries[0]!.task_id;
        expect(taskId.startsWith("bootstrap-")).toBe(true);

        const audit = db.withConn((conn) =>
          getTaskAudit(conn, project.project.id, taskId),
        );
        expect(audit.chain_ok).toBe(true);
        expect(audit.events.map((entry) => entry.event)).toMatchObject([
          { tool: "read" },
          { tool: "grep" },
        ]);
        // Only seq 2 was new at finish; seq 1 was already written by the live stream.
        expect(
          logs.some(
            (line) =>
              line.includes(`audit ingested`) &&
              line.includes(`task=${taskId}`) &&
              line.includes("events=1"),
          ),
        ).toBe(true);
        // The token must not outlive the task, and it never enters the task contract.
        expect(tokens.size).toBe(0);
        const taskJson = readFileSync(
          join(
            directory,
            "workspace",
            project.project.id.replaceAll("/", "-"),
            ".cairn",
            "sessions",
            taskId,
            "task.json",
          ),
          "utf8",
        );
        expect(taskJson).not.toContain("cairn_audit_");
        expect(taskJson).not.toContain("CAIRN_AUDIT_STREAM");
      } finally {
        server.stop(true);
      }
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

describe("Strategist trigger persistence", () => {
  test(
    "records success watermarks and a fresh scheduler does not repeat reason",
    async () => {
      const project = createProjectRow(false);
      // A direction already claimed by another worker keeps the project active with an
      // open intent, so the fake solver's reason turn is a successful no-op.
      db.withConn((conn) =>
        createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "held by another worker",
          creator: "other-worker",
          worker: "other-worker",
        }),
      );

      const loop = successfulReasonScheduler();
      await loop.runUntilIdle();

      const firstRuns = db.withConn((conn) =>
        listProjectRuns(conn, project.project.id),
      );
      const firstReasonRuns = firstRuns.filter((run) => run.kind === "reason");
      expect(firstReasonRuns).toHaveLength(1);
      expect(firstReasonRuns[0]!.trigger).toBe("initial");

      const state = db.withConn((conn) =>
        getStrategistState(conn, project.project.id),
      );
      expect(state).toMatchObject({
        last_trigger: "initial",
        last_run_id: firstReasonRuns[0]!.id,
        last_fact_count: 2,
        last_hint_count: 0,
        last_open_intent_count: 1,
      });
      expect(state!.last_success_at).not.toBeNull();
      expect(state!.last_failure_at).toBeNull();

      // The watermark survives the process: a new scheduler sees an unchanged graph and
      // must not spend another reason turn on it.
      const restarted = successfulReasonScheduler();
      await restarted.runUntilIdle();

      const secondRuns = db.withConn((conn) =>
        listProjectRuns(conn, project.project.id),
      );
      expect(secondRuns.filter((run) => run.kind === "reason")).toHaveLength(1);
    },
    30_000,
  );

  test(
    "persists a failed reason attempt and applies backoff to the retry",
    async () => {
      const project = createProjectRow(false);
      const loop = failingReasonScheduler();
      await loop.runUntilIdle();

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      const reasonRuns = runs.filter((run) => run.kind === "reason");
      expect(reasonRuns).toHaveLength(1);
      expect(reasonRuns[0]!.outcome).toBe("failed");
      expect(reasonRuns[0]!.trigger).toBe("initial");

      const state = db.withConn((conn) =>
        getStrategistState(conn, project.project.id),
      );
      expect(state).toMatchObject({
        last_success_at: null,
        last_trigger: "initial",
        last_run_id: reasonRuns[0]!.id,
        last_fact_count: 0,
        last_open_intent_count: 0,
      });
      expect(state!.last_failure_at).not.toBeNull();

      await loop.runUntilIdle();

      const retried = db.withConn((conn) =>
        listProjectRuns(conn, project.project.id),
      );
      expect(retried.filter((run) => run.kind === "reason")).toHaveLength(1);
      expect(
        logs.some(
          (line) =>
            line.includes(`slow-layer suppressed project=${project.project.id}`) &&
            line.includes("reason=failure_backoff"),
        ),
      ).toBe(true);
    },
    30_000,
  );
});

describe("Strategist priority and project budgets", () => {
  test(
    "persists reason priority and budget hints in intent_meta",
    async () => {
      const project = createProjectRow(false);
      const loop = metaReasonScheduler();
      loop.tick();
      await loop.waitForIdle();

      const meta = db.withConn((conn) =>
        listProjectIntentMeta(conn, project.project.id),
      );
      expect(meta).toHaveLength(2);
      expect(meta.every((entry) => entry.source === "strategist")).toBe(true);
      expect(meta.map((entry) => entry.dedupe_key).sort()).toEqual([
        "high-priority-direction",
        "low-priority-direction",
      ]);

      const reasonRun = db.withConn((conn) =>
        listProjectRuns(conn, project.project.id).find((run) => run.kind === "reason"),
      );
      expect(reasonRun).toBeDefined();
      expect(meta.every((entry) => entry.origin_run_id === reasonRun!.id)).toBe(true);

      const detail = load(project.project.id);
      const high = detail.intents.find(
        (intent) => intent.description === "high priority direction",
      );
      const low = detail.intents.find(
        (intent) => intent.description === "low priority direction",
      );
      expect(high).toBeDefined();
      expect(low).toBeDefined();
      expect(meta.find((entry) => entry.intent_id === high!.id)).toMatchObject({
        priority: 90,
        budget: { max_seconds: 20, max_tool_calls: 5 },
      });
      expect(meta.find((entry) => entry.intent_id === low!.id)).toMatchObject({
        priority: 10,
        budget: null,
      });
      expect(detail.hints.map((hint) => hint.content)).toEqual([
        "inspect the login flow",
      ]);
    },
    30_000,
  );

  test(
    "dedupes open intents and hints on an operator-requested replan",
    async () => {
      const project = createProjectRow(false);
      const loop = metaReasonScheduler();
      loop.tick();
      await loop.waitForIdle();

      db.withConn((conn) =>
        requestStrategistReplan(conn, project.project.id, {
          reason: "operator pivot",
          requestedBy: "tester",
        }),
      );
      loop.tick();
      await loop.waitForIdle();

      const runs = db.withConn((conn) =>
        listProjectRuns(conn, project.project.id),
      );
      const reasonRuns = runs.filter((run) => run.kind === "reason");
      expect(reasonRuns.map((run) => run.trigger)).toEqual([
        "initial",
        "manual_replan",
      ]);
      expect(reasonRuns.every((run) => run.outcome === "success")).toBe(true);

      const detail = load(project.project.id);
      expect(detail.intents.filter((intent) => intent.to === null)).toHaveLength(2);
      expect(detail.hints).toHaveLength(1);
      expect(
        db.withConn((conn) => getStrategistState(conn, project.project.id)),
      ).toMatchObject({
        last_trigger: "manual_replan",
        replan_requested_at: null,
        replan_requested_by: null,
        replan_reason: null,
      });
    },
    30_000,
  );

  test(
    "drops a reworded direction and still counts the turn as a success",
    async () => {
      const project = createProjectRow(false);
      const loop = rewordedReasonScheduler();
      loop.tick();
      await loop.waitForIdle();

      const detail = load(project.project.id);
      const open = detail.intents.filter((intent) => intent.to === null);
      expect(open).toHaveLength(1);
      expect(open[0]!.description).toBe("利用 f003 的凭据通过 SMB 横向到 10.0.2.0/24");

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      const reasonRuns = runs.filter((run) => run.kind === "reason");
      expect(reasonRuns).toHaveLength(1);
      expect(reasonRuns[0]!.outcome).toBe("success");

      const meta = db.withConn((conn) =>
        listProjectIntentMeta(conn, project.project.id),
      );
      expect(meta).toHaveLength(1);
      expect(meta[0]).toMatchObject({
        intent_id: open[0]!.id,
        source: "strategist",
        dedupe_key: "lateral-smb",
      });

      db.withConn((conn) =>
        requestStrategistReplan(conn, project.project.id, {
          reason: "recheck duplicates",
          requestedBy: "tester",
        }),
      );
      loop.tick();
      await loop.waitForIdle();

      const rerun = db
        .withConn((conn) => listProjectRuns(conn, project.project.id))
        .filter((run) => run.kind === "reason");
      expect(rerun.map((run) => run.trigger)).toEqual(["initial", "manual_replan"]);
      expect(rerun.every((run) => run.outcome === "success")).toBe(true);
      expect(
        load(project.project.id).intents.filter((intent) => intent.to === null),
      ).toHaveLength(1);
    },
    30_000,
  );

  test(
    "dispatches the highest-priority unclaimed intent first",
    async () => {
      const project = createProjectRow(false);
      const high = db.withConn((conn) => {
        const intent = createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "urgent direction",
          creator: "tester",
          worker: null,
        });
        recordIntentMeta(conn, {
          projectId: project.project.id,
          intentId: intent.id,
          source: "tester",
          priority: 90,
        });
        return intent;
      });
      db.withConn((conn) => {
        const intent = createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "background direction",
          creator: "tester",
          worker: null,
        });
        recordIntentMeta(conn, {
          projectId: project.project.id,
          intentId: intent.id,
          source: "tester",
          priority: 10,
        });
      });

      const loop = scheduler();
      loop.tick();
      await loop.waitForIdle();

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: "explore", intent_id: high.id });
    },
    30_000,
  );

  test(
    "records usage written by the worker and stops at the token budget",
    async () => {
      const project = createProjectRow(false);
      db.withConn((conn) =>
        createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "metered direction",
          creator: "tester",
          worker: null,
        }),
      );

      const loop = usageScheduler();
      loop.tick();
      await loop.waitForIdle();

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        total_tokens: 165,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        cost_usd: 0.25,
        model: "gateway/deepseek-flash",
      });

      const gated = budgetScheduler({ max_project_tokens: 165 });
      gated.tick();
      await gated.waitForIdle();
      expect(gated.runningCount).toBe(0);
      expect(
        logs.some((line) => line.includes("budget exhausted") && line.includes("tokens=165/165")),
      ).toBe(true);
    },
    30_000,
  );

  test(
    "stops new work at the cost budget",
    async () => {
      const project = createProjectRow(false);
      db.withConn((conn) => {
        startRun(conn, {
          id: "run_seed",
          projectId: project.project.id,
          taskId: "seed-task",
          kind: "explore",
          worker: "cairn-worker",
          intentId: null,
          trigger: null,
          startedAt: "2026-01-02T03:00:00Z",
          session: ".cairn/sessions/seed",
        });
        finishRun(conn, "run_seed", {
          outcome: "success",
          finishedAt: "2026-01-02T03:00:01Z",
          durationMs: 1000,
          exitCode: 0,
          evidenceCount: 0,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            costUsd: 0.5,
          },
        });
      });

      const loop = budgetScheduler({ max_project_cost_usd: 0.5 });
      loop.tick();
      await loop.waitForIdle();

      expect(loop.runningCount).toBe(0);
      expect(
        logs.some((line) => line.includes("budget exhausted") && line.includes("cost_usd=0.5/0.5")),
      ).toBe(true);
      expect(
        db.withConn((conn) => listProjectRuns(conn, project.project.id)),
      ).toHaveLength(1);
    },
    30_000,
  );

  test(
    "salvages a pending conclude even when the budget is exhausted",
    async () => {
      const project = createProjectRow(false);
      const intent = db.withConn((conn) =>
        createIntent(conn, project.project.id, {
          from: ["origin"],
          description: "queued before budget exhaustion",
          creator: "tester",
          worker: null,
        }),
      );
      const session = ".cairn/sessions/explore-budget";
      const workspace = join(directory, "workspace", project.project.id);
      mkdirSync(join(workspace, ...session.split("/"), "solver-session"), {
        recursive: true,
      });
      writeFileSync(
        join(workspace, ...session.split("/"), "solver-session", "session.jsonl"),
        "{}\n",
        "utf8",
      );
      db.withConn((conn) => {
        startRun(conn, {
          id: "run_seed",
          projectId: project.project.id,
          taskId: "seed-task",
          kind: "explore",
          worker: "cairn-worker",
          intentId: null,
          trigger: null,
          startedAt: "2026-01-02T03:00:00Z",
          session: ".cairn/sessions/seed",
        });
        finishRun(conn, "run_seed", {
          outcome: "success",
          finishedAt: "2026-01-02T03:00:01Z",
          durationMs: 1000,
          exitCode: 0,
          evidenceCount: 0,
          usage: {
            inputTokens: 500,
            outputTokens: 500,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 1000,
            costUsd: 0,
          },
        });
        recordPendingConclude(conn, {
          projectId: project.project.id,
          intentId: intent.id,
          phase: "explore",
          session,
        });
      });

      const loop = budgetScheduler({ max_project_tokens: 100 });
      await loop.runUntilIdle();

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(
        runs.some((run) => run.kind === "conclude" && run.outcome === "success"),
      ).toBe(true);
      // No new reason/explore work was dispatched, but the salvage ran.
      expect(runs.filter((run) => run.kind === "explore")).toHaveLength(1);
      expect(runs.filter((run) => run.kind === "reason")).toHaveLength(0);
      expect(
        db.withConn((conn) => listPendingConcludes(conn, project.project.id)),
      ).toEqual([]);
      expect(
        load(project.project.id).intents.find((entry) => entry.id === intent.id)?.to,
      ).not.toBeNull();
    },
    60_000,
  );
});

describe("per-project concurrency quota", () => {
  function twoOpenIntents(projectId: string): void {
    for (const description of ["direction one", "direction two"]) {
      db.withConn((conn) =>
        createIntent(conn, projectId, {
          from: ["origin"],
          description,
          creator: "tester",
          worker: null,
        }),
      );
    }
  }

  test(
    "caps one project at budget.max_project_tasks",
    async () => {
      const project = createProjectRow(false);
      twoOpenIntents(project.project.id);

      const loop = budgetScheduler({ max_project_tasks: 1 });
      loop.tick();
      await loop.waitForIdle();

      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.kind).toBe("explore");
    },
    30_000,
  );

  test(
    "inherits runtime.max_project_workers when max_project_tasks is 0",
    async () => {
      const project = createProjectRow(false);
      twoOpenIntents(project.project.id);

      const loop = budgetScheduler({ max_project_tasks: 0 });
      loop.tick();
      await loop.waitForIdle();

      // The tick starts both tasks before either worker can finish.
      const runs = db.withConn((conn) => listProjectRuns(conn, project.project.id));
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.kind === "explore")).toBe(true);
    },
    30_000,
  );
});

describe("runtime settings hot reload", () => {
  test("swaps the backend when execution changes while idle", async () => {
    const loop = scheduler();
    try {
      expect(loop.executionMode).toBe("local");
      config.runtime.execution = "container";
      config.container = {
        image: "cairn-worker:latest",
        networkMode: "bridge",
        completedAction: "remove",
        capAdd: [],
        workspaceRoot: null,
        workerArgv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
      };

      loop.reconfigure();
      expect(loop.executionMode).toBe("container");
      expect(logs.some((message) => message.includes("runtime switched to container"))).toBe(true);

      config.runtime.execution = "local";
      loop.reconfigure();
      expect(loop.executionMode).toBe("local");
    } finally {
      await loop.stop();
    }
  });

  test("re-arms interval timers after the config changes", async () => {
    const loop = scheduler();
    loop.start();
    try {
      config.runtime.interval = 1;
      config.retention.sweepIntervalSeconds = 60;
      expect(() => loop.reconfigure()).not.toThrow();
      expect(loop.runningCount).toBe(0);
    } finally {
      await loop.stop();
    }
  });

  test("ignores reconfigure before start", () => {
    const loop = scheduler();
    expect(() => loop.reconfigure()).not.toThrow();
  });
});
