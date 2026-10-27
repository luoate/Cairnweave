/**
 * M16a gate: compare two real models on identical, authorized marker projects.
 *
 * The gate runs two arms sequentially. Each arm owns a fresh database, workspace, and
 * single-profile stats configuration (`min_runs: 0`, `epsilon: 0`), so every dispatched
 * explore task must go to that arm's model-prefs entry. Both arms receive the same two
 * marker files and the same goal; the gate then compares outcome, token usage, cost, and
 * duration, and rejects runs that report the same model on both sides.
 *
 * It needs two distinct model-prefs entries in the agent config, for example:
 *
 *   {
 *     "models": [
 *       { "id": "ab-arm-a", "provider": "<provider>", "modelId": "<model-id>" },
 *       { "id": "ab-arm-b", "provider": "<provider>", "modelId": "<other-model-id>" }
 *     ]
 *   }
 *
 * Model-prefs entry ids are passed as `CAIRN_AB_MODEL_A` / `CAIRN_AB_MODEL_B`. The gate
 * refuses to start when either entry is missing or both resolve to the same
 * provider/model, so it never reports a meaningless "A/B" of one model.
 *
 * This gate is intentionally outside `bun test`: it calls real models and costs money.
 *
 *   CAIRN_AB_MODEL_A=ab-arm-a CAIRN_AB_MODEL_B=ab-arm-b \
 *     bun run tools/gate/m16-model-ab.ts
 *
 * Optional environment:
 *   CAIRN_AGENT_CONFIG_DIR=~/.tch-agent/config   agent config directory
 *   CAIRN_AB_TASKS=2                             explore tasks per arm (1-6)
 *   CAIRN_AB_MAX_MINUTES=20                      total wall-clock cap
 *   CAIRN_AB_REPORT=path                         default runs/m16-model-ab.json
 *   CAIRN_AB_KEEP=1                              keep both temporary directories
 *   CAIRN_AB_SOLVER=breachweave                  fake runs the arms without a model
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  configureDatabase,
  createIntent,
  createProject,
  listProjectRuns,
  type Run,
} from "@cairn/graph";

import {
  parseDispatchConfig,
  type WorkerProfileConfig,
  type WorkerSelectionConfig,
} from "../../apps/cairn/src/config";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";
import { projectWorkspace } from "../../apps/cairn/src/scheduler/tasks";

const AGENT_CONFIG_DIR =
  process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim() || join(homedir(), ".tch-agent", "config");
const MODEL_A = process.env["CAIRN_AB_MODEL_A"]?.trim() ?? "";
const MODEL_B = process.env["CAIRN_AB_MODEL_B"]?.trim() ?? "";
const TASKS = envInt("CAIRN_AB_TASKS", 2, 1, 6);
const MAX_MINUTES = envInt("CAIRN_AB_MAX_MINUTES", 20, 1, 120);
const KEEP = process.env["CAIRN_AB_KEEP"] === "1";
const SOLVER = process.env["CAIRN_AB_SOLVER"]?.trim() || "breachweave";
const REPORT_PATH = resolve(
  process.env["CAIRN_AB_REPORT"]?.trim() || join("runs", "m16-model-ab.json"),
);

const MARKER = `CAIRN-M16-AB-${crypto.randomUUID().slice(0, 8)}`;
const SECOND = `CAIRN-M16-AB-SECOND-${MARKER}`;

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
  duration_ms: number | null;
}

interface ArmSummary {
  runs: number;
  success: number;
  failure: number;
  other: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

interface ArmResult {
  arm: "a" | "b";
  profile: string;
  model_pref: string;
  declared_model: string;
  project_id: string | null;
  directory: string;
  runs: RunView[];
  models: string[];
  summary: ArmSummary;
}

interface AbReport {
  generated_at: string;
  gate: "m16a-model-ab";
  passed: boolean;
  failure: string | null;
  config_dir: string;
  tasks_per_arm: number;
  marker: string;
  arms: { a: ArmResult; b: ArmResult } | null;
  delta: {
    tokens: number;
    cost_usd: number;
    duration_ms: number;
    success: number;
  } | null;
  checks: Check[];
  warnings: string[];
}

const checks: Check[] = [];
const warnings: string[] = [];
let failure: string | null = null;

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function warn(message: string): void {
  warnings.push(message);
  console.warn(`WARN  ${message}`);
}

interface StoredPref {
  id: string;
  provider: string;
  modelId: string;
}

function readPrefs(): StoredPref[] {
  const path = join(AGENT_CONFIG_DIR, "model-prefs.json");
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    if (!Array.isArray(data.models)) return [];
    return data.models
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && typeof entry["id"] === "string",
      )
      .map((entry) => ({
        id: String(entry["id"]),
        provider: typeof entry["provider"] === "string" ? entry["provider"] : "",
        modelId: typeof entry["modelId"] === "string" ? entry["modelId"] : "",
      }));
  } catch (error) {
    warn(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function declaredModel(label: string, prefId: string, prefs: readonly StoredPref[]): string {
  const pref = prefs.find((entry) => entry.id === prefId);
  if (!pref) throw new Error(`model-prefs entry ${prefId} is not configured (arm ${label})`);
  if (!pref.modelId) throw new Error(`model-prefs entry ${prefId} has no modelId (arm ${label})`);
  return `${pref.provider}/${pref.modelId}`;
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
    duration_ms: run.duration_ms,
  };
}

function summarize(runs: readonly Run[]): ArmSummary {
  const summary: ArmSummary = {
    runs: runs.length,
    success: 0,
    failure: 0,
    other: 0,
    total_tokens: 0,
    cost_usd: 0,
    duration_ms: 0,
  };
  for (const run of runs) {
    if (run.outcome === "success") summary.success += 1;
    else if (run.outcome === "failed") summary.failure += 1;
    else summary.other += 1;
    summary.total_tokens += run.total_tokens;
    summary.cost_usd += run.cost_usd;
    summary.duration_ms += run.duration_ms ?? 0;
  }
  return summary;
}

const SELECTION: WorkerSelectionConfig = {
  mode: "stats",
  minRuns: 0,
  epsilon: 0,
  epsilonDecay: 1,
  epsilonMin: 0,
};

function dispatchConfig(profile: WorkerProfileConfig) {
  return parseDispatchConfig({
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
      // The arms pre-create their intents; keep the slow layer from interleaving a
      // reason turn between the two explore tasks.
      min_new_facts: 0,
      min_new_hints: 0,
      cooldown_seconds: 0,
      failure_backoff_seconds: 60,
      max_runs_per_hour: 0,
      zero_output_threshold: 0,
      stale_intent_seconds: 0,
      fallback_interval_seconds: 0,
    },
    budget: { max_project_tasks: TASKS },
    worker_profiles: [profile],
    worker_selection: {
      mode: SELECTION.mode,
      min_runs: SELECTION.minRuns,
      epsilon: SELECTION.epsilon,
      epsilon_decay: SELECTION.epsilonDecay,
      epsilon_min: SELECTION.epsilonMin,
    },
  });
}

async function runArm(
  arm: "a" | "b",
  prefId: string,
  declared: string,
  deadline: number,
): Promise<ArmResult> {
  const profile: WorkerProfileConfig = { id: `arm-${arm}`, model: prefId };
  const config = dispatchConfig(profile);
  const directory = mkdtempSync(join(tmpdir(), `cairn-m16-ab-${arm}-`));
  const workspaceRoot = join(directory, "workspace");
  const db = configureDatabase(join(directory, "cairn.db"));
  let projectId: string | null = null;
  let scheduler: Scheduler | null = null;

  try {
    const project = db.withConn((conn) =>
      createProject(conn, {
        title: `m16-ab-arm-${arm}`,
        origin:
          "A local temporary workspace is the worker's current working directory. It " +
          "contains marker files created for this authorized model-comparison test.",
        goal:
          "Read marker.txt and second.txt in the workspace and record both exact values " +
          "as separate facts. Do not mark the project complete before both values are recorded.",
        bootstrap_enabled: false,
        hints: [
          {
            content:
              "Treat each marker file as an independent exploration direction and record " +
              "its exact string.",
            creator: `m16-ab-${arm}`,
          },
        ],
        scope: {
          targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`],
          notes: "Local temporary workspace created by the M16a A/B gate.",
        },
        verification: { kind: "off" },
      }),
    );
    projectId = project.project.id;
    const workspace = projectWorkspace(workspaceRoot, projectId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "marker.txt"), `${MARKER}\n`, "utf8");
    writeFileSync(join(workspace, "second.txt"), `${SECOND}\n`, "utf8");
    db.withConn((conn) => {
      createIntent(conn, project.project.id, {
        from: ["origin"],
        description: `Record the value in marker.txt (arm ${arm})`,
        creator: `m16-ab-${arm}`,
        worker: null,
      });
      createIntent(conn, project.project.id, {
        from: ["origin"],
        description: `Record the value in second.txt (arm ${arm})`,
        creator: `m16-ab-${arm}`,
        worker: null,
      });
    });

    scheduler = new Scheduler({
      db,
      config,
      workspaceRoot,
      log: (message) => console.error(`[arm-${arm}] ${message}`),
    });

    let dispatched = 0;
    while (dispatched < TASKS && Date.now() < deadline) {
      const before = countRuns(db, projectId);
      const didDispatch = scheduler.tick();
      if (!didDispatch) break;
      await scheduler.waitForIdle();
      const after = countRuns(db, projectId);
      if (after <= before) {
        throw new Error(`arm ${arm}: scheduler reported a dispatch without recording a run`);
      }
      dispatched += after - before;
    }
    if (Date.now() >= deadline) warn(`arm ${arm}: wall-clock cap reached`);
    if (dispatched >= TASKS) warn(`arm ${arm}: task cap of ${TASKS} reached`);
  } finally {
    if (scheduler !== null) {
      try {
        await scheduler.stop();
      } catch (error) {
        warn(
          `arm ${arm}: scheduler shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const id = projectId;
  const recorded = id === null ? [] : db.withConn((conn) => listProjectRuns(conn, id));
  const models = [...new Set(recorded.map((run) => run.model).filter((m): m is string => !!m))].sort();
  return {
    arm,
    profile: profile.id,
    model_pref: prefId,
    declared_model: declared,
    project_id: projectId,
    directory,
    runs: recorded.map(view),
    models,
    summary: summarize(recorded),
  };
}

function countRuns(db: ReturnType<typeof configureDatabase>, projectId: string): number {
  return db.withConn((conn) => listProjectRuns(conn, projectId)).length;
}

async function main(): Promise<{ a: ArmResult; b: ArmResult } | null> {
  try {
    const modelsPath = join(AGENT_CONFIG_DIR, "models.json");
    const authPath = join(AGENT_CONFIG_DIR, "auth.json");
    const credentialsPresent = existsSync(modelsPath) && existsSync(authPath);
    check(
      "model credentials are configured",
      credentialsPresent,
      credentialsPresent ? `${AGENT_CONFIG_DIR} (not printed)` : "models.json or auth.json is missing",
    );
    if (!credentialsPresent) throw new Error("real-model credentials are missing");

    if (!MODEL_A || !MODEL_B) {
      throw new Error(
        "set CAIRN_AB_MODEL_A and CAIRN_AB_MODEL_B to two model-prefs entry ids " +
          `(configure them in ${join(AGENT_CONFIG_DIR, "model-prefs.json")})`,
      );
    }
    check(
      "the two arms use different model-prefs entries",
      MODEL_A !== MODEL_B,
      `${MODEL_A} vs ${MODEL_B}`,
    );
    if (MODEL_A === MODEL_B) throw new Error("A/B comparison requires two different model-prefs entries");

    const prefs = readPrefs();
    const declaredA = declaredModel("a", MODEL_A, prefs);
    const declaredB = declaredModel("b", MODEL_B, prefs);
    check(
      "the two entries resolve to different models",
      declaredA !== declaredB,
      `${declaredA} vs ${declaredB}`,
    );
    if (declaredA === declaredB) {
      throw new Error(
        `both model-prefs entries resolve to ${declaredA}; point one arm at a second model`,
      );
    }

    process.env["CAIRN_SOLVER"] = SOLVER;
    check("real solver is selected", SOLVER === "breachweave", SOLVER);

    const deadline = Date.now() + MAX_MINUTES * 60_000;
    const armA = await runArm("a", MODEL_A, declaredA, deadline);
    const armB = await runArm("b", MODEL_B, declaredB, deadline);

    verifyArm(armA);
    verifyArm(armB);
    check(
      "both arms dispatched the same number of tasks",
      armA.runs.length === armB.runs.length,
      `${armA.runs.length} vs ${armB.runs.length}`,
    );
    check(
      "the two arms reported disjoint model sets",
      armA.models.length > 0 &&
        armB.models.length > 0 &&
        armA.models.every((model) => !armB.models.includes(model)),
      `a=${armA.models.join(",") || "none"} b=${armB.models.join(",") || "none"}`,
    );
    return { a: armA, b: armB };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    return null;
  }
}

function verifyArm(result: ArmResult): void {
  check(
    `arm ${result.arm} dispatched at least ${TASKS} task(s)`,
    result.runs.length >= TASKS,
    `${result.runs.length}`,
  );
  check(
    `arm ${result.arm} tagged every run with profile ${result.profile}`,
    result.runs.length > 0 && result.runs.every((run) => run.worker_profile === result.profile),
    result.runs.map((run) => `${run.id}:${run.worker_profile ?? "none"}`).join(", ") || "no runs",
  );
  check(
    `arm ${result.arm} reported a model on every run`,
    result.runs.length > 0 && result.runs.every((run) => run.model !== null),
    result.runs.map((run) => `${run.id}:${run.model ?? "none"}`).join(", ") || "no runs",
  );
  if (result.summary.cost_usd === 0) {
    warn(`arm ${result.arm}: the gateway did not report cost; compare tokens instead`);
  }
}

let arms: { a: ArmResult; b: ArmResult } | null = null;

arms = await main();

mkdirSync(join(process.cwd(), "runs"), { recursive: true });

const failedChecks = checks.filter((entry) => !entry.ok);
const passed = failure === null && failedChecks.length === 0;
const keep = KEEP || !passed;

const delta =
  arms === null
    ? null
    : {
        tokens: arms.a.summary.total_tokens - arms.b.summary.total_tokens,
        cost_usd: arms.a.summary.cost_usd - arms.b.summary.cost_usd,
        duration_ms: arms.a.summary.duration_ms - arms.b.summary.duration_ms,
        success: arms.a.summary.success - arms.b.summary.success,
      };

const report: AbReport = {
  generated_at: new Date().toISOString(),
  gate: "m16a-model-ab",
  passed,
  failure,
  config_dir: AGENT_CONFIG_DIR,
  tasks_per_arm: TASKS,
  marker: MARKER,
  arms,
  delta,
  checks,
  warnings,
};

console.log("");
if (arms !== null) {
  for (const arm of [arms.a, arms.b]) {
    console.log(
      `arm ${arm.arm} (${arm.declared_model}): ${arm.summary.runs} run(s), ` +
        `${arm.summary.success} success, ${arm.summary.failure} failure, ` +
        `${arm.summary.total_tokens} token(s), $${arm.summary.cost_usd.toFixed(6)}, ` +
        `${(arm.summary.duration_ms / 1000).toFixed(1)}s`,
    );
    for (const run of arm.runs) {
      console.log(
        `  ${run.id} ${run.kind} ${run.worker_profile ?? "none"} ${run.model ?? "no-model"} ` +
          `${run.outcome ?? "running"} ${run.total_tokens} token(s) $${run.cost_usd.toFixed(6)}`,
      );
    }
  }
  if (delta !== null) {
    console.log(
      `delta (A-B): tokens=${delta.tokens} cost=$${delta.cost_usd.toFixed(6)} ` +
        `duration=${(delta.duration_ms / 1000).toFixed(1)}s success=${delta.success}`,
    );
  }
}
console.log(`checks: ${checks.length - failedChecks.length} passed, ${failedChecks.length} failed`);
if (warnings.length > 0) console.log(`warnings: ${warnings.length}`);
console.log(`report: ${REPORT_PATH}`);

writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (arms !== null) {
  for (const arm of [arms.a, arms.b]) {
    if (keep) {
      console.log(`kept arm ${arm.arm} directory: ${arm.directory}`);
    } else {
      rmSync(arm.directory, { recursive: true, force: true });
    }
  }
}
process.exit(passed ? 0 : failure !== null ? 2 : 1);

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
