/**
 * M4a gate: the conclude fallback resumes the failed task's real BreachWeave session
 * instead of starting cold, and the model still returns a valid conclude payload.
 *
 * This gate is intentionally outside `bun test`: it calls a real model and costs money.
 * It needs credentials under `~/.tch-agent/config` (override with CAIRN_AGENT_CONFIG_DIR).
 *
 *   bun run tools/gate/m4-conclude-gate.ts
 *
 * What it proves:
 * - a real bootstrap task persists a solver session under the task session directory;
 * - a conclude task built by the scheduler's `prepareTask` points at that directory;
 * - `SessionManager.open` resumes the same session (same id/file) and appends the
 *   conclude turn to the original JSONL instead of creating a new session;
 * - the resumed model output validates as a bootstrap conclude payload (a Fact).
 *
 * This gate deliberately drives `prepareTask` + `BreachWeaveSolver` directly. The
 * scheduler's queueing/failure paths are covered by the deterministic flaky-worker tests
 * (`loop.test.ts`), so no artificial crash injection is needed here.
 *
 * Set CAIRN_GATE_KEEP=1 to keep the temporary directory for inspection.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateBootstrapConcludePayload,
  validateBootstrapExecutePayload,
  parseTaskResultJson,
} from "@cairn/contracts";
import {
  configureDatabase,
  createIntent,
  createProject,
  exportProjectYaml,
  getProjectDetail,
  type ProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { prepareTask } from "../../apps/cairn/src/scheduler/tasks";
import { BreachWeaveSolver } from "../../apps/cairn/src/solver/breachweave";
import { latestSolverSessionFile } from "../../apps/cairn/src/solver/session-file";

const MARKER = "CAIRN-M4A-CONCLUDE-GATE-7f3a";
const TIMEOUT_SECONDS = 300;

const directory = mkdtempSync(join(tmpdir(), "cairn-m4a-conclude-gate-"));
const workspaceRoot = join(directory, "workspace");
const db = configureDatabase(join(directory, "cairn.db"));
const config = parseDispatchConfig({
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
    bootstrap: { timeout: TIMEOUT_SECONDS, conclude_timeout: 120 },
    reason: { timeout: TIMEOUT_SECONDS, max_intents: 1 },
    explore: { timeout: TIMEOUT_SECONDS, conclude_timeout: 120 },
  },
  local: { completed_action: "keep" },
  worker: {
    soft_deadline_ratio: 0.9,
    retain_task_files: true,
    result_grace_seconds: 10,
  },
});

const scope = {
  targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`],
  notes: "Local temporary workspace created by the M4a conclude gate.",
};

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
let failure: string | null = null;

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}

function sessionIdOf(file: string): string | null {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>)["type"] === "session"
      ) {
        const id = (entry as Record<string, unknown>)["id"];
        return typeof id === "string" ? id : null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function entryCount(file: string): number {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

try {
  const created = db.withConn((conn) =>
    createProject(conn, {
      title: "m4a-conclude-gate",
      origin:
        "A local lab workspace is the worker's current working directory. It contains marker.txt, a file created for this authorized test.",
      goal: "Report the exact contents of marker.txt in the workspace.",
      bootstrap_enabled: true,
      hints: null,
      scope,
    }),
  );
  const projectId = created.project.id;
  const workspace = join(workspaceRoot, projectId);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "marker.txt"), `${MARKER}\n`, "utf8");

  const intent = db.withConn((conn) =>
    createIntent(conn, projectId, {
      from: ["origin"],
      description: "bootstrap",
      creator: "dispatcher.bootstrap",
      worker: null,
    }),
  );

  process.env["CAIRN_SOLVER"] = "breachweave";
  const solver = new BreachWeaveSolver();

  // Phase 1: a real bootstrap task. It is not applied to the graph here; the gate only
  // needs the persisted solver session and a real assistant turn to resume.
  const bootstrapTask = prepareTask({
    config,
    project: load(projectId),
    exportYaml: db.withConn((conn) => exportProjectYaml(conn, projectId)),
    kind: "bootstrap",
    intent,
    scope,
    workspaceRoot,
  });
  const bootstrapText = await solver.solve(bootstrapTask.task);
  const bootstrapResult = parseTaskResultJson(bootstrapText);
  check("bootstrap produced a result envelope", bootstrapResult !== null, preview(bootstrapText));
  const bootstrapPayload =
    bootstrapResult === null || !bootstrapResult.accepted
      ? null
      : validateBootstrapExecutePayload(bootstrapResult.data);
  check(
    "bootstrap payload is a complete/fact envelope",
    bootstrapPayload?.kind === "complete",
    bootstrapPayload?.kind ?? "invalid",
  );

  const sessionFile = latestSolverSessionFile(bootstrapTask.hostSessionDir);
  check("bootstrap persisted a solver session", sessionFile !== null, sessionFile ?? "");
  const beforeId = sessionFile === null ? null : sessionIdOf(sessionFile);
  const beforeEntries = sessionFile === null ? 0 : entryCount(sessionFile);
  check(
    "recorded session has a header and at least one turn",
    beforeId !== null && beforeEntries >= 3,
    `id=${beforeId ?? "none"} entries=${beforeEntries}`,
  );

  // Phase 2: the scheduler's conclude task, pointed at the failed bootstrap session.
  const concludeTask = prepareTask({
    config,
    project: load(projectId),
    exportYaml: db.withConn((conn) => exportProjectYaml(conn, projectId)),
    kind: "conclude",
    intent,
    scope,
    concludeOf: "bootstrap",
    resumeFromHostSessionDir: bootstrapTask.hostSessionDir,
    workspaceRoot,
  });
  check(
    "conclude task carries the resume directory",
    concludeTask.task.resumeSessionDir === bootstrapTask.hostSessionDir &&
      concludeTask.task.concludeOf === "bootstrap",
    `resume=${concludeTask.task.resumeSessionDir ?? ""} of=${concludeTask.task.concludeOf ?? ""}`,
  );

  const concludeText = await solver.solve(concludeTask.task);
  const concludeResult = parseTaskResultJson(concludeText);
  check("conclude produced a result envelope", concludeResult !== null, preview(concludeText));
  const concludePayload =
    concludeResult === null || !concludeResult.accepted
      ? null
      : validateBootstrapConcludePayload(concludeResult.data);
  check(
    "conclude payload is an accepted Fact",
    concludePayload?.kind === "fact" && concludePayload.data.trim() !== "",
    concludePayload?.kind === "fact" ? preview(concludePayload.data) : "invalid",
  );

  const resumedFile = latestSolverSessionFile(bootstrapTask.hostSessionDir);
  check(
    "conclude resumed the same session file",
    resumedFile === sessionFile,
    resumedFile ?? "none",
  );
  check(
    "conclude kept the session id",
    resumedFile !== null && sessionIdOf(resumedFile) === beforeId,
    sessionIdOf(resumedFile ?? "") ?? "none",
  );
  check(
    "conclude appended to the recorded session",
    resumedFile !== null && entryCount(resumedFile) > beforeEntries,
    `entries ${beforeEntries} -> ${resumedFile === null ? "?" : entryCount(resumedFile)}`,
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
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

function preview(value: string): string {
  const flat = value.replaceAll(/\s+/g, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 157)}...`;
}
