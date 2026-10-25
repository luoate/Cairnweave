/**
 * M6 gate: a queued conclude survives a control-plane restart and completes.
 *
 * This gate is intentionally outside `bun test`: it starts a real `cairn serve` process
 * against a database written by a previous process. It uses the deterministic fake solver,
 * so it needs no model credentials and costs nothing.
 *
 *   bun run tools/gate/m6-restart-gate.ts
 *
 * What it proves:
 * - the on-disk state a crashed control plane leaves behind (claimed intent, retained
 *   solver session, persisted pending_concludes row) is valid input for a fresh process;
 * - the startup reconciliation sweep keeps a row whose project, intent and session are
 *   still valid, instead of dropping it as stale;
 * - a new control-plane process dispatches the queued conclude without any explore retry,
 *   writes the Fact and evidence, and concludes the intent;
 * - the pending row is removed only after the conclude succeeds.
 *
 * A crash is simulated by seeding exactly the files/rows the scheduler persists before a
 * worker starts. The deterministic suite (retention-sweep.test.ts, loop.test.ts) drives
 * the failure path itself; this gate covers the cross-process recovery boundary.
 *
 * Set CAIRN_GATE_KEEP=1 to keep the temporary directory for inspection.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createIntent,
  createProject,
  getProjectDetail,
  heartbeatIntent,
  listPendingConcludes,
  listProjectRuns,
  recordPendingConclude,
  type ProjectDetail,
} from "@cairn/graph";

const ROOT = join(import.meta.dir, "..", "..");
const WORKER = "cairn-worker";
const TIMEOUT_MS = 90_000;

const directory = mkdtempSync(join(tmpdir(), "cairn-m6-restart-gate-"));
const workspaceRoot = join(directory, "workspace");
const dbPath = join(directory, "cairn.db");
const db = configureDatabase(dbPath);

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
let failure: string | null = null;
let proc: ReturnType<typeof Bun.spawn> | null = null;

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const created = db.withConn((conn) =>
    createProject(conn, {
      title: "m6-restart-gate",
      origin: "An authorized local lab workspace was left mid-run by a crashed control plane.",
      goal: "Salvage the queued conclusion after the control plane restarts.",
      bootstrap_enabled: false,
      hints: null,
      scope: { targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`] },
    }),
  );
  const projectId = created.project.id;
  const workspace = join(workspaceRoot, projectId);

  // The exact leftovers of a crash: a claimed intent, a persisted solver session and the
  // pending conclude row that points at it.
  const sessionName = "explore-crashed";
  const sessionHost = join(workspace, ".cairn", "sessions", sessionName);
  mkdirSync(join(sessionHost, "solver-session"), { recursive: true });
  writeFileSync(
    join(sessionHost, "solver-session", "session.jsonl"),
    `${JSON.stringify({ type: "session", id: "m6-gate-session" })}\n{"role":"user"}\n`,
    "utf8",
  );

  const intentId = db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe the restarted control plane",
      creator: "dispatcher.explore",
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
      session: `.cairn/sessions/${sessionName}`,
    }),
  );

  const before = load(projectId);
  const pendingBefore = db.withConn((conn) => listPendingConcludes(conn, projectId));
  const intentBefore = before.intents.find((intent) => intent.id === intentId);
  check(
    "pre-restart state holds the queued conclude",
    pendingBefore.length === 1 && pendingBefore[0]!.intent_id === intentId,
    `rows=${pendingBefore.length}`,
  );
  check(
    "pre-restart intent is open and claimed by the worker",
    intentBefore !== undefined && intentBefore.to === null && intentBefore.worker === WORKER,
    `to=${intentBefore === undefined ? "missing" : String(intentBefore.to)} worker=${intentBefore?.worker ?? "none"}`,
  );

  const configPath = join(directory, "dispatch.yaml");
  mkdirSync(join(directory, "static"), { recursive: true });
  writeFileSync(
    configPath,
    [
      'server: "http://127.0.0.1:8000"',
      "runtime:",
      "  execution: local",
      "  interval: 1",
      "  max_workers: 1",
      "  max_running_projects: 1",
      "  max_project_workers: 1",
      "  healthcheck_timeout: 15",
      "  worker_healthcheck: disabled",
      '  prompt_group: "default"',
      "tasks:",
      "  bootstrap: { timeout: 30, conclude_timeout: 15 }",
      "  reason: { timeout: 30, max_intents: 2 }",
      "  explore: { timeout: 60, conclude_timeout: 15 }",
      "worker:",
      "  soft_deadline_ratio: 0.8",
      "  retain_task_files: true",
      "  result_grace_seconds: 10",
      "local:",
      `  workspace_root: "${workspaceRoot.replaceAll("\\", "/")}"`,
      "  completed_action: keep",
      "retention:",
      "  session_max_age_days: 0",
      "  session_keep_per_project: 0",
      "  sweep_interval_seconds: 0",
      "  refresh_artifacts: false",
      "",
    ].join("\n"),
    "utf8",
  );

  // The "restart": a fresh process with a fresh database handle and no in-memory queue.
  proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(ROOT, "apps", "cairn", "src", "cli.ts"),
      "serve",
      "--config",
      configPath,
      "--db-path",
      dbPath,
      "--port",
      "0",
      "--static-dir",
      join(directory, "static"),
    ],
    cwd: ROOT,
    env: { ...process.env, CAIRN_SOLVER: "fake" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = Date.now() + TIMEOUT_MS;
  let recovered = false;
  while (Date.now() < deadline && proc.exitCode === null) {
    try {
      const pending = db.withConn((conn) => listPendingConcludes(conn, projectId));
      const detail = load(projectId);
      const intent = detail.intents.find((entry) => entry.id === intentId);
      if (pending.length === 0 && intent !== undefined && intent.to !== null) {
        recovered = true;
        break;
      }
    } catch {
      // A writer may hold the database briefly; retry on the next poll.
    }
    await sleep(250);
  }

  proc.kill();
  await proc.exited;
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  const stderr = await new Response(proc.stderr as ReadableStream).text();
  const output = `${stdout}\n${stderr}`;
  check(
    "restarted control plane started listening",
    output.includes("cairn listening on"),
    firstLine(output, "cairn listening on"),
  );
  check(
    "restarted process dispatched the queued conclude",
    output.includes("dispatched conclude"),
    firstLine(output, "dispatched conclude"),
  );
  check("recovery finished before the timeout", recovered, `pid=${proc.pid}`);

  const detail = load(projectId);
  const intent = detail.intents.find((entry) => entry.id === intentId);
  const dynamicFacts = detail.facts.filter(
    (fact) => fact.id !== "origin" && fact.id !== "goal",
  );
  const pendingAfter = db.withConn((conn) => listPendingConcludes(conn, projectId));
  const runs = db.withConn((conn) => listProjectRuns(conn, projectId));

  check("pending row was removed", pendingAfter.length === 0, `rows=${pendingAfter.length}`);
  check(
    "intent is concluded by the conclude run",
    intent !== undefined && intent.to !== null,
    `to=${intent?.to ?? "missing"}`,
  );
  check(
    "the salvaged fact matches the queued intent",
    dynamicFacts.length === 1 &&
      dynamicFacts[0]!.description === `fake fact from ${intentId}`,
    dynamicFacts.map((fact) => fact.id).join(",") || "none",
  );
  const concludeRun = runs.find((run) => run.kind === "conclude");
  check(
    "run history records the conclude with evidence",
    concludeRun !== undefined && concludeRun.evidence_count > 0,
    concludeRun === undefined ? "no run" : `evidence=${concludeRun.evidence_count}`,
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (proc !== null && proc.exitCode === null) {
    proc.kill();
    await proc.exited;
  }
  console.log("\n=== gate result ===");
  if (failure !== null) console.log(`error: ${failure}`);
  console.log(`directory: ${directory}`);
  const failed = checks.filter((entry) => !entry.ok).length;
  console.log(`checks: ${checks.length - failed} passed, ${failed} failed`);

  const passed = failure === null && failed === 0 && checks.length > 0;
  if (process.env["CAIRN_GATE_KEEP"] === "1" || !passed) {
    console.log("kept the gate directory for inspection");
  } else {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(passed ? 0 : 1);
}

function firstLine(text: string, needle: string): string {
  const line = text.split("\n").find((entry) => entry.includes(needle));
  if (line === undefined) return "";
  const flat = line.replaceAll(/\s+/g, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}...`;
}
