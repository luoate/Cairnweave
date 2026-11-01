/**
 * M42 minimal evaluation set.
 *
 * Runs the five scenarios in `scenarios.ts` twice — once as a pre-M40/M41 deployment
 * (legacy `verification` + automatic completion) and once with the hardened contract
 * (M41 goal conditions + manual review) — and reports completion, wrong completion,
 * cost, duration and attempts.
 *
 * The worker is deterministic and never calls a model. This makes the harness safe to
 * run in CI; a real-model comparison can reuse the same scenarios later.
 *
 *   bun run eval                 # write runs/eval-<date>.json
 *   bun run eval -- --out /tmp/eval.json
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectDetail,
  listProjectRuns,
  type CairnDatabase,
} from "@cairn/graph";

import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";
import { VerificationService } from "../../apps/cairn/src/verification/oracle";
import { SCENARIOS, type EvalScenario } from "./scenarios";

const WORKER = join(import.meta.dir, "scenario-worker.ts");
const CHALLENGE_ENV = {
  TCH_CHALLENGE_API_BASE_URL: "https://challenge.eval.test",
  TCH_CHALLENGE_AGENT_TOKEN: "eval-token",
};

export type EvalVariant = "legacy" | "hardened";

export interface VariantMetrics {
  completed: boolean;
  legitimate_completion: boolean;
  wrong_completion: boolean;
  attempts: number;
  tokens: number;
  cost_usd: number;
  duration_ms: number;
  wall_ms: number;
  run_kinds: string[];
  status: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  description: string;
  expectation: "achieved" | "not_achieved";
  legacy: VariantMetrics;
  hardened: VariantMetrics;
}

export interface AggregateMetrics {
  scenarios: number;
  completions: number;
  legitimate_completions: number;
  wrong_completions: number;
  completion_rate: number;
  legitimate_completion_rate: number;
  wrong_completion_rate: number;
  tokens: number;
  cost_usd: number;
  duration_ms: number;
  attempts: number;
}

export interface EvaluationReport {
  schema: 1;
  generated_at: string;
  mode: "deterministic-fake-worker";
  note: string;
  done_when: {
    in_prompt: boolean;
    evaluated: boolean;
    note: string;
  };
  scenarios: ScenarioResult[];
  summary: {
    legacy: AggregateMetrics;
    hardened: AggregateMetrics;
  };
}

export interface RunEvaluationOptions {
  /** Override the per-scenario cycle cap when debugging. */
  maxCycles?: number;
  log?: (message: string) => void;
}

interface VariantRun {
  metrics: VariantMetrics;
}

export async function runEvaluation(
  options: RunEvaluationOptions = {},
): Promise<EvaluationReport> {
  const scenarios: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    const legacy = await runVariant(scenario, "legacy", options);
    const hardened = await runVariant(scenario, "hardened", options);
    scenarios.push({
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      expectation: scenario.expectation,
      legacy: legacy.metrics,
      hardened: hardened.metrics,
    });
    options.log?.(
      `${scenario.id}: legacy=${legacy.metrics.status} hardened=${hardened.metrics.status}`,
    );
  }

  return {
    schema: 1,
    generated_at: new Date().toISOString(),
    mode: "deterministic-fake-worker",
    note:
      "legacy = pre-M40/M41 policy with auto completion; hardened = M41 goal conditions " +
      "with manual completion review. Cost/tokens come from the worker's usage.json.",
    done_when: {
      in_prompt: false,
      evaluated: false,
      note:
        "intent_meta.done_when is not stored or rendered yet. Evaluate prompt injection " +
        "separately (A/B with the same scenarios) before making it part of M42's default.",
    },
    scenarios,
    summary: {
      legacy: aggregate(scenarios.map((scenario) => scenario.legacy)),
      hardened: aggregate(scenarios.map((scenario) => scenario.hardened)),
    },
  };
}

async function runVariant(
  scenario: EvalScenario,
  variant: EvalVariant,
  options: RunEvaluationOptions,
): Promise<VariantRun> {
  const directory = mkdtempSync(join(tmpdir(), `cairn-eval-${scenario.id}-${variant}-`));
  const db = configureDatabase(join(directory, "cairn.db"));
  const logs: string[] = [];
  try {
    const config = parseDispatchConfig(configFor(scenario, variant));
    const verification = new VerificationService(db, config.verification, {
      env: CHALLENGE_ENV,
      fetch: async () => challengeResponse(scenario),
    });
    const projectId = db.withConn(
      (conn) =>
        createProject(conn, {
          title: `${scenario.id} ${variant}`,
          origin: "Evaluation starts with no foothold.",
          goal: scenario.description,
          bootstrap_enabled: true,
          hints: null,
          scope: { targets: ["127.0.0.1:8080"] },
          ...(variant === "legacy"
            ? { verification: scenario.legacyVerification }
            : { goal_conditions: scenario.goalConditions }),
        }).project.id,
    );
    const loop = new Scheduler({
      db,
      config,
      workspaceRoot: join(directory, "workspace"),
      log: (message) => logs.push(message),
      leaseIntervalMs: 500,
      verification,
      workerArgv: (taskPath) => [
        process.execPath,
        WORKER,
        taskPath,
        scenario.mode,
        String(scenario.usage.tokens),
        String(scenario.usage.costUsd),
      ],
    });

    const started = performance.now();
    const cycles = options.maxCycles ?? scenario.maxCycles;
    for (let index = 0; index < cycles; index += 1) {
      loop.tick();
      await loop.waitForIdle();
      if (statusOf(db, projectId) !== "active") break;
    }
    const wallMs = performance.now() - started;

    const runs = db.withConn((conn) => listProjectRuns(conn, projectId));
    const status = statusOf(db, projectId);
    const completed = status === "completed";
    const legitimate = completed && scenario.expectation === "achieved";
    return {
      metrics: {
        completed,
        legitimate_completion: legitimate,
        wrong_completion: completed && !legitimate,
        attempts: runs.length,
        tokens: sum(runs, (run) => run.total_tokens),
        cost_usd: round(sum(runs, (run) => run.cost_usd), 6),
        duration_ms: sum(runs, (run) => run.duration_ms ?? 0),
        wall_ms: Math.round(wallMs),
        run_kinds: runs.map((run) => run.kind),
        status,
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function configFor(scenario: EvalScenario, variant: EvalVariant): Record<string, unknown> {
  return {
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
      bootstrap: { timeout: 30, conclude_timeout: 10 },
      reason: { timeout: 30, max_intents: 2 },
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
    verification: {
      evidence_enforcement: "completion",
      flag_review: "off",
      off_completion: variant === "legacy" ? "auto" : "manual",
      evidence_completion: variant === "legacy" ? "auto" : "manual",
    },
    ...(scenario.maxProjectTokens === undefined
      ? {}
      : { budget: { max_project_tokens: scenario.maxProjectTokens } }),
  };
}

function challengeResponse(scenario: EvalScenario): Response {
  const counts = scenario.challenge ?? {
    code: scenario.goalConditions.find((condition) => condition.kind === "challenge")
      ?.challenge_code ?? "eval-none",
    flag_count: 0,
    flag_got_count: 0,
  };
  return new Response(
    JSON.stringify({
      code: 0,
      message: "ok",
      data: { challenges: [counts] },
    }),
    { status: 200 },
  );
}

function statusOf(db: CairnDatabase, projectId: string): string {
  return db.withConn((conn) => getProjectDetail(conn, projectId).project.status);
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function aggregate(metrics: readonly VariantMetrics[]): AggregateMetrics {
  const count = metrics.length;
  const completions = metrics.filter((item) => item.completed).length;
  const legitimate = metrics.filter((item) => item.legitimate_completion).length;
  const wrong = metrics.filter((item) => item.wrong_completion).length;
  return {
    scenarios: count,
    completions,
    legitimate_completions: legitimate,
    wrong_completions: wrong,
    completion_rate: count === 0 ? 0 : round(completions / count, 4),
    legitimate_completion_rate: count === 0 ? 0 : round(legitimate / count, 4),
    wrong_completion_rate: count === 0 ? 0 : round(wrong / count, 4),
    tokens: sum(metrics, (item) => item.tokens),
    cost_usd: round(sum(metrics, (item) => item.cost_usd), 6),
    duration_ms: sum(metrics, (item) => item.duration_ms),
    attempts: sum(metrics, (item) => item.attempts),
  };
}

/** Default report location; `runs/` is already ignored by git. */
export function defaultOutPath(now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return resolve(import.meta.dir, "..", "..", "runs", `eval-${date}.json`);
}

export function writeReport(
  report: EvaluationReport,
  outPath: string = defaultOutPath(),
): string {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return outPath;
}

function printSummary(report: EvaluationReport): void {
  const header = ["scenario", "legacy", "hardened", "wrong(legacy→hardened)", "attempts"];
  console.log(header.join("\t"));
  for (const scenario of report.scenarios) {
    console.log(
      [
        scenario.id,
        scenario.legacy.completed ? "completed" : scenario.legacy.status,
        scenario.hardened.completed ? "completed" : scenario.hardened.status,
        `${scenario.legacy.wrong_completion ? "yes" : "no"}→${
          scenario.hardened.wrong_completion ? "yes" : "no"
        }`,
        `${scenario.legacy.attempts}→${scenario.hardened.attempts}`,
      ].join("\t"),
    );
  }
  console.log("");
  for (const variant of ["legacy", "hardened"] as const) {
    const summary = report.summary[variant];
    console.log(
      `${variant}: completion=${summary.completion_rate} ` +
        `wrong=${summary.wrong_completion_rate} ` +
        `tokens=${summary.tokens} cost=$${summary.cost_usd.toFixed(4)} ` +
        `duration=${summary.duration_ms}ms attempts=${summary.attempts}`,
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let out = defaultOutPath();
  let maxCycles: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--out") out = resolve(args[++index] ?? out);
    else if (args[index] === "--cycles") maxCycles = Number(args[++index]);
  }
  if (maxCycles !== undefined && (!Number.isInteger(maxCycles) || maxCycles < 1)) {
    console.error("--cycles must be a positive integer");
    process.exit(2);
  }
  const report = await runEvaluation({ maxCycles });
  const path = writeReport(report, out);
  printSummary(report);
  console.log(`\nreport: ${path}`);
}
