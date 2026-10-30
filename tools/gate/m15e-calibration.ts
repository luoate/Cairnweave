/**
 * M15e gate: calibrate stats-driven dispatch against a real BreachWeave model.
 *
 * Two named worker profiles drive one small project. The gate checks that every run is
 * tagged with the profile/model that produced it, that the global profile statistics used
 * by selection agree with the project report, and that the epsilon schedule recorded from
 * the run history matches the configured policy. With two profiles mapped to the same
 * model-prefs entry the gate calibrates dispatch bookkeeping, not model quality; point
 * `CAIRN_GATE_PROFILE_B_MODEL` at a second model-prefs entry to compare models.
 *
 * This gate is intentionally outside `bun test`: it calls a real model and costs money.
 * It needs credentials under `~/.cairnweave/config` (override with CAIRN_AGENT_CONFIG_DIR).
 *
 *   bun run tools/gate/m15e-calibration.ts
 *
 * Optional environment:
 *   CAIRN_GATE_MAX_TASKS=2               hard cap on dispatched tasks (default 2)
 *   CAIRN_GATE_MAX_MINUTES=10            wall-clock cap (default 10)
 *   CAIRN_GATE_PROFILE_A_MODEL=cairn-worker   model-prefs entry for profile `primary`
 *   CAIRN_GATE_PROFILE_B_MODEL=cairn-worker   model-prefs entry for profile `alternate`
 *   CAIRN_GATE_MIN_RUNS=1                samples per profile before exploitation
 *   CAIRN_GATE_EPSILON=1                 exploration probability for the recorded schedule
 *   CAIRN_GATE_EPSILON_DECAY=1           per-dispatch decay
 *   CAIRN_GATE_EPSILON_MIN=0             exploration floor
 *   CAIRN_GATE_REPORT=path               report path (default runs/m15e-calibration.json)
 *   CAIRN_GATE_KEEP=1                    keep the temporary directory
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  buildProjectReport,
  buildProjectRunStats,
  configureDatabase,
  createProject,
  listProjectRuns,
  type ProjectReport,
  type ProfileRunStats,
  type Run,
} from "@cairn/graph";

import {
  parseDispatchConfig,
  type WorkerProfileConfig,
  type WorkerSelectionConfig,
} from "../../apps/cairn/src/config";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";
import {
  effectiveEpsilon,
  eligibleFinishedRuns,
  explorationBudget,
  explorationDue,
} from "../../apps/cairn/src/scheduler/selection";
import { projectWorkspace } from "../../apps/cairn/src/scheduler/tasks";

const AGENT_CONFIG_DIR =
  process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim() || join(homedir(), ".cairnweave", "config");
const MAX_TASKS = envInt("CAIRN_GATE_MAX_TASKS", 2, 2, 20);
const MAX_MINUTES = envInt("CAIRN_GATE_MAX_MINUTES", 10, 1, 120);
const MIN_RUNS = envInt("CAIRN_GATE_MIN_RUNS", 1, 0, 20);
const EPSILON = envUnit("CAIRN_GATE_EPSILON", 1);
const EPSILON_DECAY = envPositiveUnit("CAIRN_GATE_EPSILON_DECAY", 1);
const EPSILON_MIN = envUnit("CAIRN_GATE_EPSILON_MIN", 0);
const KEEP = process.env["CAIRN_GATE_KEEP"] === "1";
const REPORT_PATH = resolve(
  process.env["CAIRN_GATE_REPORT"]?.trim() || join("runs", "m15e-calibration.json"),
);

const PROFILES: WorkerProfileConfig[] = [
  {
    id: "primary",
    model: process.env["CAIRN_GATE_PROFILE_A_MODEL"]?.trim() || "cairn-worker",
  },
  {
    id: "alternate",
    model: process.env["CAIRN_GATE_PROFILE_B_MODEL"]?.trim() || "cairn-worker",
  },
];
const SAME_MODEL = PROFILES[0]!.model === PROFILES[1]!.model;

const SELECTION: WorkerSelectionConfig = {
  mode: "stats",
  minRuns: MIN_RUNS,
  epsilon: EPSILON,
  epsilonDecay: EPSILON_DECAY,
  epsilonMin: EPSILON_MIN,
};

const MARKER = `CAIRN-M15E-${crypto.randomUUID().slice(0, 8)}`;
const directory = mkdtempSync(join(tmpdir(), "cairn-m15e-calibration-"));
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
    bootstrap: { timeout: 300, conclude_timeout: 120 },
    reason: { timeout: 300, max_intents: 2 },
    explore: { timeout: 300, conclude_timeout: 120 },
  },
  local: { completed_action: "keep" },
  worker: {
    soft_deadline_ratio: 0.9,
    retain_task_files: true,
    result_grace_seconds: 10,
  },
  strategist: {
    min_new_facts: 1,
    min_new_hints: 1,
    cooldown_seconds: 0,
    failure_backoff_seconds: 60,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
    stale_intent_seconds: 0,
    fallback_interval_seconds: 0,
  },
  budget: { max_project_tasks: MAX_TASKS },
  worker_profiles: PROFILES,
  worker_selection: {
    mode: SELECTION.mode,
    min_runs: SELECTION.minRuns,
    epsilon: SELECTION.epsilon,
    epsilon_decay: SELECTION.epsilonDecay,
    epsilon_min: SELECTION.epsilonMin,
  },
});

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface RunView {
  id: string;
  kind: string;
  worker_profile: string | null;
  model: string | null;
  outcome: string | null;
  total_tokens: number;
  cost_usd: number;
}

interface CalibrationReport {
  generated_at: string;
  gate: "m15e";
  passed: boolean;
  failure: string | null;
  model: { solver: string; config_dir: string; same_model: boolean };
  profiles: WorkerProfileConfig[];
  selection: WorkerSelectionConfig;
  project_id: string | null;
  runs: RunView[];
  by_profile: ProfileRunStats[];
  report_by_profile: ProfileRunStats[];
  schedule: {
    eligible_runs: number;
    effective_epsilon: number;
    exploration_budget: number;
    next_dispatch_explores: boolean;
  } | null;
  checks: Check[];
  warnings: string[];
  directory: string;
}

const checks: Check[] = [];
const warnings: string[] = [];
const logs: string[] = [];
let failure: string | null = null;
let projectId: string | null = null;
let scheduler: Scheduler | null = null;
let dispatchedTasks = 0;

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function warn(message: string): void {
  warnings.push(message);
  console.warn(`WARN  ${message}`);
}

function runs(): Run[] {
  const id = projectId;
  return id === null ? [] : db.withConn((conn) => listProjectRuns(conn, id));
}

function view(run: Run): RunView {
  return {
    id: run.id,
    kind: run.kind,
    worker_profile: run.worker_profile,
    model: run.model,
    outcome: run.outcome,
    total_tokens: run.total_tokens,
    cost_usd: run.cost_usd,
  };
}

function counts(rows: readonly ProfileRunStats[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.worker_profile, row.runs]));
}

function countRunsByProfile(rows: readonly Run[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const run of rows) {
    if (run.worker_profile === null) continue;
    result[run.worker_profile] = (result[run.worker_profile] ?? 0) + 1;
  }
  return result;
}

async function main(): Promise<void> {
  try {
    const modelsPath = join(AGENT_CONFIG_DIR, "models.json");
    const authPath = join(AGENT_CONFIG_DIR, "auth.json");
    const credentialsPresent = existsSync(modelsPath) && existsSync(authPath);
    check(
      "model credentials are configured",
      credentialsPresent,
      credentialsPresent
        ? `${AGENT_CONFIG_DIR} (not printed)`
        : "models.json or auth.json is missing",
    );
    if (!credentialsPresent) throw new Error("real-model credentials are missing");

    process.env["CAIRN_SOLVER"] = "breachweave";
    check(
      "real solver is selected",
      process.env["CAIRN_SOLVER"] === "breachweave",
      "breachweave",
    );
    if (SAME_MODEL) {
      warn(
        "both profiles use the same model-prefs entry; calibration covers dispatch " +
          "bookkeeping, not model quality (set CAIRN_GATE_PROFILE_B_MODEL to compare)",
      );
    }

    const project = db.withConn((conn) =>
      createProject(conn, {
        title: "m15e-calibration",
        origin:
          "A local temporary workspace is the worker's current working directory. It " +
          "contains two marker files created for this authorized dispatch-calibration test.",
        goal:
          "Read marker.txt and second.txt in the workspace and record both exact values as " +
          "separate facts. Do not mark the project complete before both values are recorded.",
        bootstrap_enabled: false,
        hints: [
          {
            content:
              "Treat each marker file as an independent exploration direction and record " +
              "its exact string.",
            creator: "m15e-gate",
          },
        ],
        scope: {
          targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`],
          notes: "Local temporary workspace created by the M15e calibration gate.",
        },
        verification: { kind: "off" },
      }),
    );
    projectId = project.project.id;
    const workspace = projectWorkspace(workspaceRoot, projectId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "marker.txt"), `${MARKER}\n`, "utf8");
    writeFileSync(join(workspace, "second.txt"), `CAIRN-M15E-SECOND-${MARKER}\n`, "utf8");
    check(
      "workspace contains both marker files",
      existsSync(join(workspace, "marker.txt")) && existsSync(join(workspace, "second.txt")),
      workspace,
    );

    scheduler = new Scheduler({
      db,
      config,
      workspaceRoot,
      log: (message) => {
        logs.push(message);
        console.error(`[gate] ${message}`);
      },
    });

    const deadline = Date.now() + MAX_MINUTES * 60_000;
    while (dispatchedTasks < MAX_TASKS && Date.now() < deadline) {
      const before = runs().length;
      const didDispatch = scheduler.tick();
      if (!didDispatch) break;
      await scheduler.waitForIdle();
      const after = runs().length;
      if (after <= before) {
        failure = "scheduler reported a dispatch without recording a run";
        break;
      }
      dispatchedTasks += after - before;
    }
    if (Date.now() >= deadline) warn(`wall-clock cap of ${MAX_MINUTES} minute(s) reached`);
    if (dispatchedTasks >= MAX_TASKS) {
      warn(`task cap of ${MAX_TASKS} reached before the scheduler went idle`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (scheduler !== null) {
      try {
        await scheduler.stop();
      } catch (error) {
        warn(
          `scheduler shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

await main();

mkdirSync(join(process.cwd(), "runs"), { recursive: true });
const recordedRuns = runs();
const calibratedProjectId = projectId;
const stats =
  calibratedProjectId === null
    ? null
    : db.withConn((conn) => buildProjectRunStats(conn, calibratedProjectId));
const report: ProjectReport | null =
  calibratedProjectId === null
    ? null
    : db.withConn((conn) => buildProjectReport(conn, calibratedProjectId));

check("at least two tasks were dispatched", recordedRuns.length >= 2, `${recordedRuns.length}`);
check(
  "every run is tagged with a configured profile",
  recordedRuns.length > 0 &&
    recordedRuns.every(
      (run) =>
        run.worker_profile !== null &&
        PROFILES.some((profile) => profile.id === run.worker_profile),
    ),
  recordedRuns.map((run) => `${run.id}:${run.worker_profile ?? "none"}`).join(", ") ||
    "no runs",
);

const profileSet = new Set(recordedRuns.map((run) => run.worker_profile));
check(
  "both profiles received work",
  PROFILES.every((profile) => profileSet.has(profile.id)),
  [...profileSet].map(String).join(", ") || "none",
);
check(
  "at least one run reported a model",
  recordedRuns.some((run) => run.model !== null),
  recordedRuns.map((run) => `${run.id}:${run.model ?? "none"}`).join(", "),
);

if (stats !== null) {
  const expected = countRunsByProfile(recordedRuns);
  const actual = counts(stats.by_profile);
  check(
    "profile stats agree with the project runs",
    PROFILES.every(
      (profile) => (actual[profile.id] ?? 0) === (expected[profile.id] ?? 0),
    ),
    JSON.stringify(actual),
  );
}

check(
  "project report exposes the same profile buckets",
  report !== null &&
    stats !== null &&
    JSON.stringify(counts(report.runs.by_profile)) === JSON.stringify(counts(stats.by_profile)),
  report === null ? "no report" : JSON.stringify(counts(report.runs.by_profile)),
);

let schedule: CalibrationReport["schedule"] = null;
if (stats !== null) {
  const byProfile = new Map(stats.by_profile.map((row) => [row.worker_profile, row]));
  const eligible = eligibleFinishedRuns(PROFILES, byProfile, SELECTION);
  schedule = {
    eligible_runs: eligible,
    effective_epsilon: effectiveEpsilon(SELECTION, eligible),
    exploration_budget: explorationBudget(SELECTION, eligible),
    next_dispatch_explores: explorationDue(SELECTION, eligible),
  };
}

const collected: Omit<CalibrationReport, "passed"> = {
  generated_at: new Date().toISOString(),
  gate: "m15e",
  failure,
  model: {
    solver: process.env["CAIRN_SOLVER"] ?? "unknown",
    config_dir: AGENT_CONFIG_DIR,
    same_model: SAME_MODEL,
  },
  profiles: PROFILES,
  selection: SELECTION,
  project_id: projectId,
  runs: recordedRuns.map(view),
  by_profile: stats?.by_profile ?? [],
  report_by_profile: report?.runs.by_profile ?? [],
  schedule,
  checks,
  warnings,
  directory,
};

const failedChecks = checks.filter((entry) => !entry.ok);
const passed = failure === null && failedChecks.length === 0;
const keep = KEEP || !passed;

console.log("");
for (const run of collected.runs) {
  console.log(
    `  ${run.id} ${run.kind} ${run.worker_profile ?? "none"} ` +
      `${run.model ?? "no-model"} ${run.outcome ?? "running"} ` +
      `${run.total_tokens} token(s) $${run.cost_usd.toFixed(6)}`,
  );
}
if (schedule !== null) {
  console.log(
    `schedule: eligible=${schedule.eligible_runs} ` +
      `epsilon=${schedule.effective_epsilon.toFixed(4)} ` +
      `budget=${schedule.exploration_budget.toFixed(4)} ` +
      `next_explores=${schedule.next_dispatch_explores}`,
  );
}
console.log(`checks: ${checks.length - failedChecks.length} passed, ${failedChecks.length} failed`);
if (warnings.length > 0) console.log(`warnings: ${warnings.length}`);
console.log(`report: ${REPORT_PATH}`);
console.log(`directory: ${directory}`);

writeFileSync(
  REPORT_PATH,
  `${JSON.stringify({ ...collected, passed }, null, 2)}\n`,
  "utf8",
);
if (keep) {
  console.log("kept the gate directory for inspection");
} else {
  rmSync(directory, { recursive: true, force: true });
}
if (failedChecks.length > 0) {
  console.error("--- scheduler log ---");
  console.error(logs.join("\n"));
}
process.exit(passed ? 0 : 1);

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function envUnit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return value;
}

function envPositiveUnit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be a number greater than 0 and at most 1`);
  }
  return value;
}
