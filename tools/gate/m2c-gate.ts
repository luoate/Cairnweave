/**
 * M2c gate: a real BreachWeave solver must drive a project to completion and produce at
 * least one new fact.
 *
 * This script is intentionally outside `bun test`: it calls a real model, costs money and
 * needs `~/.tch-agent/config` credentials. Run it with:
 *
 *   bun run tools/gate/m2c-gate.ts
 *
 * The lab target is a marker file in a temporary workspace. The worker's file tools are
 * cross-platform, so the gate does not need bash. The project enables bootstrap: the
 * bootstrap contract always concludes its intent with a Fact, which makes "produced at
 * least one Fact" deterministic. A reason-only project can legitimately close through
 * `data.complete` without inserting a Fact, so it would not exercise this gate.
 * Set CAIRN_GATE_KEEP=1 to keep the temporary directory and inspect task files / logs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectDetail,
  type ProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";

const MARKER = "CAIRN-M2C-GATE-9c41";
const TIMEOUT_SECONDS = 600;

const directory = mkdtempSync(join(tmpdir(), "cairn-m2c-gate-"));
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

const logs: string[] = [];
let project: ProjectDetail | null = null;
let failure: string | null = null;

try {
  project = db.withConn((conn) =>
    createProject(conn, {
      title: "m2c-gate",
      origin:
        "A local lab workspace is the worker's current working directory. It contains marker.txt, a file created for this authorized test.",
      goal: "Report the exact contents of marker.txt in the workspace.",
      bootstrap_enabled: true,
      hints: null,
      scope: {
        targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`],
        notes: "Local temporary workspace created by the M2c gate.",
      },
    }),
  );

  const workspace = join(workspaceRoot, project.project.id);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "marker.txt"), `${MARKER}\n`, "utf8");

  process.env["CAIRN_SOLVER"] = "breachweave";
  const scheduler = new Scheduler({
    db,
    config,
    workspaceRoot,
    log: (message) => {
      logs.push(message);
      console.error(`[gate] ${message}`);
    },
  });

  await scheduler.runUntilIdle(1000);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  const detail = project === null ? null : load(project.project.id);
  console.log("\n=== gate result ===");
  if (failure !== null) console.log(`error: ${failure}`);
  if (detail !== null) {
    console.log(`status: ${detail.project.status}`);
    console.log(
      `facts: ${detail.facts.map((fact) => `${fact.id}: ${fact.description}`).join("\n       ")}`,
    );
    console.log(`intents: ${detail.intents.length}`);
  }
  console.log(`directory: ${directory}`);

  const dynamicFacts =
    detail?.facts.filter((fact) => fact.id !== "origin" && fact.id !== "goal") ?? [];
  const passed =
    failure === null &&
    detail !== null &&
    detail.project.status === "completed" &&
    dynamicFacts.length > 0 &&
    detail.facts.some((fact) => fact.description.includes(MARKER));

  if (process.env["CAIRN_GATE_KEEP"] === "1" || !passed) {
    console.log("kept the gate directory for inspection");
  } else {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(passed ? 0 : 1);
}

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}
