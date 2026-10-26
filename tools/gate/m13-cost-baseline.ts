/**
 * M13a/M13b gate: a real BreachWeave solver drives a small project through the slow layer,
 * and the resulting usage is reconciled across the worker sidecar, the `runs` table, the
 * read-only `/strategist` API and the per-fact `/cost` attribution chain. The run also
 * writes `runs/m13-baseline.json`.
 *
 * This gate is intentionally outside `bun test`: it calls a real model and costs money.
 * It needs credentials under `~/.tch-agent/config` (override with CAIRN_AGENT_CONFIG_DIR).
 *
 *   bun run tools/gate/m13-cost-baseline.ts
 *
 * Optional environment:
 *   CAIRN_GATE_MAX_TASKS=6            hard cap on dispatched tasks (default 6)
 *   CAIRN_GATE_MAX_MINUTES=20         wall-clock cap (default 20)
 *   CAIRN_GATE_BUDGET_TOKENS=0        per-project token ceiling (0 = baseline only)
 *   CAIRN_GATE_BUDGET_COST_USD=0      per-project cost ceiling (0 = baseline only)
 *   CAIRN_GATE_EXPECT_EXHAUSTED=1     require the configured budget to stop dispatch
 *   CAIRN_GATE_PRICE_INPUT_PER_M=...  optional USD/M token prices used for an estimate;
 *   CAIRN_GATE_PRICE_OUTPUT_PER_M=... the provider-reported cost stays authoritative when
 *   CAIRN_GATE_PRICE_CACHE_READ_PER_M=... models.json already carries pricing
 *   CAIRN_GATE_PRICE_CACHE_WRITE_PER_M=...
 *   CAIRN_GATE_REPORT=path            report path (default runs/m13-baseline.json)
 *   CAIRN_GATE_KEEP=1                 keep the temporary directory
 *
 * The lab target is two marker files in a temporary workspace. The project disables
 * bootstrap, so the first reason turn must propose the exploration directions itself.
 * Everything stays local; no container or network target is involved.
 */

import { DEFAULT_INTENT_PRIORITY, type TaskUsage } from "@cairn/contracts";
import {
  configureDatabase,
  createProject,
  getFactMeta,
  getProjectDetail,
  getProjectUsage,
  getStrategistState,
  listProjectIntentMeta,
  listProjectRuns,
  type CausalEdge,
  type CostKind,
  type Intent,
  type ProjectCostReport,
  type ProjectDetail,
  type ProjectUsage,
  type Run,
  type StrategistState,
} from "@cairn/graph";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parseDispatchConfig, type BudgetConfig } from "../../apps/cairn/src/config";
import { createApi } from "../../apps/cairn/src/http/api";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";
import { projectWorkspace } from "../../apps/cairn/src/scheduler/tasks";
import { readTaskUsage } from "../../apps/cairn/src/scheduler/usage";

const AGENT_CONFIG_DIR =
  process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim() || join(homedir(), ".tch-agent", "config");
const MAX_TASKS = envInt("CAIRN_GATE_MAX_TASKS", 6, 1, 20);
const MAX_MINUTES = envInt("CAIRN_GATE_MAX_MINUTES", 20, 1, 120);
const BUDGET_TOKENS = envNumber("CAIRN_GATE_BUDGET_TOKENS", 0);
const BUDGET_COST_USD = envNumber("CAIRN_GATE_BUDGET_COST_USD", 0);
const PRICE_INPUT_PER_M = envNumber("CAIRN_GATE_PRICE_INPUT_PER_M", 0);
const PRICE_OUTPUT_PER_M = envNumber("CAIRN_GATE_PRICE_OUTPUT_PER_M", 0);
const PRICE_CACHE_READ_PER_M = envNumber("CAIRN_GATE_PRICE_CACHE_READ_PER_M", 0);
const PRICE_CACHE_WRITE_PER_M = envNumber("CAIRN_GATE_PRICE_CACHE_WRITE_PER_M", 0);
const PRICING_CONFIGURED =
  PRICE_INPUT_PER_M > 0 ||
  PRICE_OUTPUT_PER_M > 0 ||
  PRICE_CACHE_READ_PER_M > 0 ||
  PRICE_CACHE_WRITE_PER_M > 0;
const EXPECT_EXHAUSTED = process.env["CAIRN_GATE_EXPECT_EXHAUSTED"] === "1";
// A budget that is deliberately crossed early may stop the project before exploration.
// In that mode the gate proves metering and the stop, not end-to-end goal completion.
const REQUIRE_EXPLORATION = !EXPECT_EXHAUSTED;
const KEEP = process.env["CAIRN_GATE_KEEP"] === "1";
const REPORT_PATH = resolve(
  process.env["CAIRN_GATE_REPORT"]?.trim() || join("runs", "m13-baseline.json"),
);

const MARKER = `CAIRN-M13-MARKER-${crypto.randomUUID().slice(0, 8)}`;
const SECOND = `CAIRN-M13-SECOND-${crypto.randomUUID().slice(0, 8)}`;

const directory = mkdtempSync(join(tmpdir(), "cairn-m13-cost-baseline-"));
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
    // Two independent checks give the reason turn a reason to propose two directions.
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
    // The gate wants the slow layer to run promptly after every graph delta. Failure
    // backoff stays enabled so a broken model cannot turn into a retry storm.
    cooldown_seconds: 0,
    failure_backoff_seconds: 60,
    max_runs_per_hour: 0,
    zero_output_threshold: 0,
    stale_intent_seconds: 0,
    fallback_interval_seconds: 0,
  },
  budget: {
    max_project_tokens: BUDGET_TOKENS,
    max_project_cost_usd: BUDGET_COST_USD,
    max_project_tasks: 1,
  },
});

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface RunReport {
  id: string;
  kind: string;
  intent_id: string | null;
  trigger: string | null;
  outcome: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  total_tokens: number;
  cost_usd: number;
  usage: TaskUsage | null;
  usage_matches: boolean;
  fact_ids: string[];
  allocated_tokens: number;
  allocated_cost_usd: number;
  session: string | null;
}

interface FactReport {
  id: string;
  description: string;
  run_id: string | null;
  evidence_status: string;
  evidence_ref_count: number;
  allocated_tokens: number;
  allocated_cost_usd: number;
}

interface StrategistBudgetView {
  used_tokens: number;
  used_cost_usd: number;
  running_tasks: number;
  limits: {
    max_project_tokens: number;
    max_project_cost_usd: number;
    max_project_tasks: number;
  } | null;
  exhausted: { tokens: boolean; cost_usd: boolean; tasks: boolean };
}

interface StrategistView {
  state: StrategistState | null;
  budget: StrategistBudgetView;
  intents: Array<Intent & { priority: number; source: string | null }>;
  reason_runs: Run[];
}

interface BaselineReport {
  generated_at: string;
  gate: "m13a+m13b";
  mode: "baseline" | "budget";
  passed: boolean;
  failure: string | null;
  model: { solver: string; config_dir: string };
  limits: BudgetConfig;
  project: {
    id: string;
    title: string;
    status: string;
    bootstrap_enabled: boolean;
    goal: string;
    origin: string;
  } | null;
  markers: { marker: string; second: string };
  workspace: string | null;
  dispatched_tasks: number;
  wall_clock_ms: number;
  totals: TaskUsage & { runs: number };
  pricing: {
    configured: boolean;
    input_per_million: number;
    output_per_million: number;
    cache_read_per_million: number;
    cache_write_per_million: number;
  };
  derived: {
    tokens_per_fact: number | null;
    reason_tokens: number;
    fast_layer_tokens: number;
    cache_read_share: number;
    provider_cost_usd: number;
    estimated_cost_usd: number | null;
  };
  runs: RunReport[];
  facts: FactReport[];
  strategist: {
    state: StrategistState | null;
    budget: StrategistBudgetView | null;
    reason_runs: Run[];
  };
  cost: ProjectCostReport | null;
  warnings: string[];
  checks: Check[];
  directory: string;
  directory_kept: boolean;
}

const checks: Check[] = [];
const warnings: string[] = [];
const logs: string[] = [];
const startedAt = Date.now();

let failure: string | null = null;
let project: ProjectDetail | null = null;
let projectId: string | null = null;
let scheduler: Scheduler | null = null;
let dispatchedTasks = 0;

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function warn(message: string): void {
  warnings.push(message);
  console.error(`WARN  ${message}`);
}

function load(projectIdToLoad: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectIdToLoad));
}

function runCount(): number {
  const id = projectId;
  return id === null ? 0 : db.withConn((conn) => listProjectRuns(conn, id)).length;
}

async function main(): Promise<void> {
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

    process.env["CAIRN_SOLVER"] = "breachweave";
    check("real solver is selected", process.env["CAIRN_SOLVER"] === "breachweave", "breachweave");

    project = db.withConn((conn) =>
      createProject(conn, {
        title: "m13-cost-baseline",
        origin:
          "A local temporary workspace is the worker's current working directory. It contains two " +
          "marker files created for this authorized cost-baseline test.",
        goal:
          "Read the exact contents of marker.txt and second.txt in the workspace and record both " +
          "values. These are two independent checks; each must be verified. Do not mark the project " +
          "complete until both exact values are confirmed.",
        bootstrap_enabled: false,
        hints: [
          {
            content:
              "The workspace root contains marker.txt and second.txt. Treat reading each file as a " +
              "separate exploration direction and report each exact string.",
            creator: "m13-gate",
          },
        ],
        scope: {
          targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`],
          notes: "Local temporary workspace created by the M13a cost-baseline gate.",
        },
      }),
    );
    projectId = project.project.id;
    const workspace = projectWorkspace(workspaceRoot, projectId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "marker.txt"), `${MARKER}\n`, "utf8");
    writeFileSync(join(workspace, "second.txt"), `${SECOND}\n`, "utf8");
    check(
      "workspace contains both marker files",
      readFileSync(join(workspace, "marker.txt"), "utf8").trim() === MARKER &&
        readFileSync(join(workspace, "second.txt"), "utf8").trim() === SECOND,
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

    const deadline = startedAt + MAX_MINUTES * 60_000;
    while (dispatchedTasks < MAX_TASKS && Date.now() < deadline) {
      const before = runCount();
      const didDispatch = scheduler.tick();
      if (!didDispatch) break;
      await scheduler.waitForIdle();
      const after = runCount();
      if (after <= before) {
        failure = "scheduler reported a dispatch without recording a run";
        break;
      }
      dispatchedTasks += after - before;
    }
    if (Date.now() >= deadline) {
      warn(`wall-clock cap of ${MAX_MINUTES} minute(s) reached`);
    }
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
        warn(`scheduler shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function sumUsage(runs: readonly Run[]): TaskUsage {
  return {
    input_tokens: runs.reduce((sum, run) => sum + run.input_tokens, 0),
    output_tokens: runs.reduce((sum, run) => sum + run.output_tokens, 0),
    cache_read_tokens: runs.reduce((sum, run) => sum + run.cache_read_tokens, 0),
    cache_write_tokens: runs.reduce((sum, run) => sum + run.cache_write_tokens, 0),
    total_tokens: runs.reduce((sum, run) => sum + run.total_tokens, 0),
    cost_usd: runs.reduce((sum, run) => sum + run.cost_usd, 0),
  };
}

/** Optional estimate using explicit prices; never overrides the provider's own cost. */
function estimateCost(usage: TaskUsage): number | null {
  if (!PRICING_CONFIGURED) return null;
  return (
    (usage.input_tokens * PRICE_INPUT_PER_M +
      usage.output_tokens * PRICE_OUTPUT_PER_M +
      usage.cache_read_tokens * PRICE_CACHE_READ_PER_M +
      usage.cache_write_tokens * PRICE_CACHE_WRITE_PER_M) /
    1_000_000
  );
}

function usageMatches(run: Run, usage: TaskUsage): boolean {
  return (
    run.input_tokens === usage.input_tokens &&
    run.output_tokens === usage.output_tokens &&
    run.cache_read_tokens === usage.cache_read_tokens &&
    run.cache_write_tokens === usage.cache_write_tokens &&
    run.total_tokens === usage.total_tokens &&
    close(run.cost_usd, usage.cost_usd)
  );
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function preview(value: string, limit = 180): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

function collectSecretValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    // Ignore env-var-name placeholders and short metadata; keep provider keys.
    if (
      value.length >= 20 &&
      !/\s/.test(value) &&
      !/^[A-Z0-9_]+$/.test(value) &&
      !/^https?:\/\//i.test(value) &&
      !/[\\/]/.test(value)
    ) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectSecretValues(item, out);
    }
  }
}

function readSecretValues(): string[] {
  const authPath = join(AGENT_CONFIG_DIR, "auth.json");
  if (!existsSync(authPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    const values: string[] = [];
    collectSecretValues(parsed, values);
    return [...new Set(values)];
  } catch {
    return [];
  }
}

function findFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(current, name);
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) stack.push(path);
      else if (stats.isFile()) found.push(path);
    }
  }
  return found.sort();
}

function readTextFile(path: string): string | null {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1_048_576) return null;
    const buffer = readFileSync(path);
    const probe = Math.min(buffer.length, 8192);
    for (let index = 0; index < probe; index += 1) {
      if (buffer[index] === 0) return null;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

function findSecretLeaks(root: string, secrets: readonly string[]): string[] {
  if (secrets.length === 0) return [];
  const leaks: string[] = [];
  for (const path of findFiles(root)) {
    const text = readTextFile(path);
    if (text === null) continue;
    if (secrets.some((secret) => text.includes(secret))) leaks.push(path);
  }
  return leaks;
}

function expectedIntentIds(projectIdToLoad: string, detail: ProjectDetail): string[] {
  const meta = new Map(
    db
      .withConn((conn) => listProjectIntentMeta(conn, projectIdToLoad))
      .map((entry) => [entry.intent_id, entry]),
  );
  return detail.intents
    .filter((intent) => intent.to === null && intent.concluded_at === null)
    .map((intent) => ({
      id: intent.id,
      priority: meta.get(intent.id)?.priority ?? DEFAULT_INTENT_PRIORITY,
      created_at: intent.created_at,
    }))
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.created_at.localeCompare(left.created_at) ||
        right.id.localeCompare(left.id),
    )
    .map((intent) => intent.id);
}

function expectedCostKinds(runs: readonly Run[]): CostKind[] {
  const kinds = new Map<string, CostKind>();
  for (const run of runs) {
    const row = kinds.get(run.kind) ?? { kind: run.kind, runs: 0, tokens: 0, cost_usd: 0 };
    row.runs += 1;
    row.tokens += run.total_tokens;
    row.cost_usd += run.cost_usd;
    kinds.set(run.kind, row);
  }
  return [...kinds.values()]
    .map((row) => ({ ...row, cost_usd: Math.round(row.cost_usd * 1e9) / 1e9 }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

/** M13b: verify the read-only cost API reconciles with runs and every causal edge. */
function verifyCostReport(
  projectIdToLoad: string,
  detail: ProjectDetail,
  runs: readonly Run[],
  report: ProjectCostReport,
): void {
  const totals = sumUsage(runs);
  check(
    "cost API totals match the run rows",
    report.project_id === projectIdToLoad &&
      report.totals.runs === runs.length &&
      report.totals.tokens === totals.total_tokens &&
      close(report.totals.cost_usd, totals.cost_usd),
    `${report.totals.runs}/${runs.length} runs, ` +
      `${report.totals.tokens}/${totals.total_tokens} tokens`,
  );
  check(
    "cost API kinds match the run rows",
    sameJson(report.by_kind, expectedCostKinds(runs)),
    report.by_kind.map((row) => `${row.kind}:${row.tokens}`).join(",") || "empty",
  );

  const attribution = report.attribution;
  check(
    "cost attribution partitions the project usage",
    attribution.attributed_tokens + attribution.unattributed_tokens === totals.total_tokens &&
      close(attribution.attributed_cost_usd + attribution.unattributed_cost_usd, totals.cost_usd),
    `attributed=${attribution.attributed_tokens}+` +
      `unattributed=${attribution.unattributed_tokens} tokens, ` +
      `$${attribution.attributed_cost_usd.toFixed(6)}+$${attribution.unattributed_cost_usd.toFixed(6)}`,
  );
  check(
    "cost attribution totals are internally consistent",
    attribution.fact_direct_tokens + attribution.orchestration_attributed_tokens ===
      attribution.attributed_tokens,
    `${attribution.fact_direct_tokens}+${attribution.orchestration_attributed_tokens}` +
      `=${attribution.attributed_tokens}`,
  );

  const dynamicFacts = detail.facts.filter((fact) => fact.id !== "origin" && fact.id !== "goal");
  const costFacts = new Map(report.facts.map((fact) => [fact.id, fact]));
  const missingFacts = dynamicFacts.filter((fact) => !costFacts.has(fact.id));
  check(
    "cost API covers every dynamic fact",
    missingFacts.length === 0,
    missingFacts.length === 0 ? `${dynamicFacts.length} fact(s)` : missingFacts.map((fact) => fact.id).join(","),
  );
  const factsWithoutDirect = dynamicFacts.filter((fact) => (costFacts.get(fact.id)?.direct_tokens ?? 0) <= 0);
  check(
    "dynamic facts carry direct run attribution",
    !REQUIRE_EXPLORATION || factsWithoutDirect.length === 0,
    factsWithoutDirect.length === 0
      ? "ok"
      : factsWithoutDirect.map((fact) => fact.id).join(","),
  );
  const factsWithoutOrigin = dynamicFacts.filter(
    (fact) => (costFacts.get(fact.id)?.origin_run_ids.length ?? 0) === 0,
  );
  check(
    "dynamic facts trace back to the run that created their intent",
    !REQUIRE_EXPLORATION || factsWithoutOrigin.length === 0,
    factsWithoutOrigin.length === 0
      ? "ok"
      : factsWithoutOrigin.map((fact) => fact.id).join(","),
  );

  const knownNodes = new Set<string>([
    ...detail.facts.map((fact) => `fact:${fact.id}`),
    ...detail.intents.map((intent) => `intent:${intent.id}`),
    ...runs.map((run) => `run:${run.id}`),
  ]);
  const unknownEdges = report.edges.filter(
    (edge) => !knownNodes.has(edge.from) || !knownNodes.has(edge.to),
  );
  check(
    "causal edges only reference recorded nodes",
    unknownEdges.length === 0,
    unknownEdges.length === 0
      ? `${report.edges.length} edge(s)`
      : unknownEdges.map((edge) => `${edge.from}->${edge.to}`).join(","),
  );
  check(
    "causal edges include intent creation and fact production",
    !REQUIRE_EXPLORATION ||
      (dynamicFacts.length > 0 &&
        dynamicFacts.every((fact) =>
          report.edges.some(
            (edge) => edge.kind === "produced_fact" && edge.to === `fact:${fact.id}`,
          ),
        ) &&
        report.intents.every(
          (intent) =>
            intent.origin_run_id === null ||
            report.edges.some(
              (edge) => edge.kind === "created_intent" && edge.to === `intent:${intent.id}`,
            ),
        )),
    `${report.edges.filter((edge: CausalEdge) => edge.kind === "created_intent").length} created, ` +
      `${report.edges.filter((edge) => edge.kind === "produced_fact").length} produced`,
  );
}

function reportFacts(
  projectIdToLoad: string,
  detail: ProjectDetail,
  runs: readonly Run[],
): { reports: FactReport[]; dynamicCount: number; attributedCount: number; evidenceCount: number } {
  const dynamic = detail.facts.filter((fact) => fact.id !== "origin" && fact.id !== "goal");
  const metas = db.withConn((conn) =>
    detail.facts.map((fact) => ({ fact, meta: getFactMeta(conn, projectIdToLoad, fact.id) })),
  );
  const byRun = new Map<string, string[]>();
  for (const entry of metas) {
    if (entry.fact.id === "origin" || entry.fact.id === "goal") continue;
    const runId = entry.meta?.run_id ?? null;
    if (runId === null) continue;
    const ids = byRun.get(runId) ?? [];
    ids.push(entry.fact.id);
    byRun.set(runId, ids);
  }

  const allocations = new Map<string, { tokens: number; cost: number }>();
  for (const run of runs) {
    const ids = byRun.get(run.id) ?? [];
    if (ids.length === 0) continue;
    const baseTokens = Math.floor(run.total_tokens / ids.length);
    const remainder = run.total_tokens % ids.length;
    const costShare = run.cost_usd / ids.length;
    ids.forEach((id, index) => {
      allocations.set(id, {
        tokens: baseTokens + (index < remainder ? 1 : 0),
        cost: costShare,
      });
    });
  }

  const reports = metas
    .filter((entry) => entry.fact.id !== "origin" && entry.fact.id !== "goal")
    .map((entry) => {
      const allocation = allocations.get(entry.fact.id) ?? { tokens: 0, cost: 0 };
      return {
        id: entry.fact.id,
        description: entry.fact.description,
        run_id: entry.meta?.run_id ?? null,
        evidence_status: entry.meta?.evidence_status ?? "legacy",
        evidence_ref_count: entry.meta?.evidence_refs.length ?? 0,
        allocated_tokens: allocation.tokens,
        allocated_cost_usd: allocation.cost,
      };
    });

  return {
    reports,
    dynamicCount: dynamic.length,
    attributedCount: reports.filter((report) => report.run_id !== null).length,
    evidenceCount: reports.filter((report) => report.evidence_status === "provided").length,
  };
}

async function collectAndCheck(): Promise<{
  detail: ProjectDetail | null;
  runs: Run[];
  usage: ProjectUsage;
  state: StrategistState | null;
  strategist: StrategistView | null;
  cost: ProjectCostReport | null;
  runReports: RunReport[];
  factReports: FactReport[];
}> {
  let detail: ProjectDetail | null = null;
  let runs: Run[] = [];
  let usage: ProjectUsage = { tokens: 0, cost_usd: 0 };
  let state: StrategistState | null = null;
  let strategist: StrategistView | null = null;
  let cost: ProjectCostReport | null = null;
  let runReports: RunReport[] = [];
  let factReports: FactReport[] = [];

  if (projectId === null) {
    check("project was created", false, "no project id");
    return { detail, runs, usage, state, strategist, cost, runReports, factReports };
  }
  const id = projectId;

  let loadedDetail: ProjectDetail | null = null;
  try {
    loadedDetail = load(id);
    runs = db.withConn((conn) => listProjectRuns(conn, id));
    usage = db.withConn((conn) => getProjectUsage(conn, id));
    state = db.withConn((conn) => getStrategistState(conn, id));
  } catch (error) {
    check("project state is readable", false, error instanceof Error ? error.message : String(error));
    return { detail, runs, usage, state, strategist, cost, runReports, factReports };
  }
  if (loadedDetail === null) {
    check("project state is readable", false, "project not found");
    return { detail, runs, usage, state, strategist, cost, runReports, factReports };
  }
  const current = loadedDetail;
  detail = current;

  check("at least one real task ran", runs.length > 0, `${runs.length} run(s)`);
  check(
    "every dispatched task finished",
    runs.length > 0 && runs.every((run) => run.outcome !== null),
    runs.map((run) => `${run.id}:${run.outcome ?? "running"}`).join(","),
  );
  const failedRuns = runs.filter((run) => run.outcome !== "success");
  check(
    "every dispatched task succeeded",
    runs.length > 0 && failedRuns.length === 0,
    failedRuns.length === 0 ? "ok" : failedRuns.map((run) => `${run.id}:${run.outcome}`).join(","),
  );
  const reasonRuns = runs.filter((run) => run.kind === "reason");
  check(
    "the slow layer ran at least once",
    reasonRuns.some((run) => run.outcome === "success"),
    `${reasonRuns.length} reason run(s)`,
  );
  check(
    "the fast layer explored at least once",
    !REQUIRE_EXPLORATION ||
      runs.some((run) => run.kind !== "reason" && run.outcome === "success"),
    [...new Set(runs.map((run) => run.kind))].join(","),
  );
  check(
    "project reached completed",
    !REQUIRE_EXPLORATION || current.project.status === "completed",
    current.project.status,
  );

  const totals = sumUsage(runs);
  check(
    "recorded usage is positive",
    totals.total_tokens > 0,
    `${totals.total_tokens} token(s), $${totals.cost_usd.toFixed(6)}`,
  );
  if (close(totals.cost_usd, 0)) {
    warn(
      "the provider reported zero cost; token counts are still a valid baseline " +
        "(configure model pricing or CAIRN_GATE_PRICE_*_PER_M for a USD estimate)",
    );
  }
  check(
    "getProjectUsage matches the run rows",
    usage.tokens === totals.total_tokens && close(usage.cost_usd, totals.cost_usd),
    `${usage.tokens}/${totals.total_tokens} tokens, ` +
      `$${usage.cost_usd.toFixed(6)}/$${totals.cost_usd.toFixed(6)}`,
  );

  const workspace = projectWorkspace(workspaceRoot, id);
  runReports = runs.map((run) => {
    const sessionDir = run.session === null ? null : join(workspace, run.session);
    const sidecar = sessionDir === null ? null : readTaskUsage(sessionDir);
    const matches = sidecar !== null && usageMatches(run, sidecar);
    if (run.outcome === "success") {
      check(
        `usage sidecar matches run ${run.id}`,
        sidecar !== null && matches,
        sidecar === null
          ? "usage.json missing"
          : matches
            ? `${sidecar.total_tokens} token(s)`
            : `run=${run.total_tokens}/${run.cost_usd} sidecar=${sidecar.total_tokens}/${sidecar.cost_usd}`,
      );
    } else if (sidecar !== null && !matches) {
      check(`usage sidecar matches run ${run.id}`, false, "values differ");
    } else if (sidecar === null) {
      warn(`run ${run.id} has no usage sidecar (outcome=${run.outcome ?? "running"})`);
    }
    return {
      id: run.id,
      kind: run.kind,
      intent_id: run.intent_id,
      trigger: run.trigger,
      outcome: run.outcome,
      started_at: run.started_at,
      finished_at: run.finished_at,
      duration_ms: run.duration_ms,
      total_tokens: run.total_tokens,
      cost_usd: run.cost_usd,
      usage: sidecar,
      usage_matches: matches,
      fact_ids: [],
      allocated_tokens: 0,
      allocated_cost_usd: 0,
      session: run.session,
    };
  });

  const sidecared = runReports.filter((run) => run.usage !== null);
  check(
    "all finished runs exposed a usage sidecar",
    runReports.length > 0 && runReports.every((run) => run.usage !== null),
    `${sidecared.length}/${runReports.length}`,
  );
  if (sidecared.length > 0) {
    const sidecarTotals = sidecared.reduce<TaskUsage>(
      (sum, run) => ({
        input_tokens: sum.input_tokens + (run.usage?.input_tokens ?? 0),
        output_tokens: sum.output_tokens + (run.usage?.output_tokens ?? 0),
        cache_read_tokens: sum.cache_read_tokens + (run.usage?.cache_read_tokens ?? 0),
        cache_write_tokens: sum.cache_write_tokens + (run.usage?.cache_write_tokens ?? 0),
        total_tokens: sum.total_tokens + (run.usage?.total_tokens ?? 0),
        cost_usd: sum.cost_usd + (run.usage?.cost_usd ?? 0),
      }),
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
      },
    );
    check(
      "usage sidecars sum to the recorded run usage",
      sidecared.length === runReports.length &&
        sidecarTotals.total_tokens === totals.total_tokens &&
        close(sidecarTotals.cost_usd, totals.cost_usd),
      `${sidecarTotals.total_tokens}/${totals.total_tokens} tokens, ` +
        `$${sidecarTotals.cost_usd.toFixed(6)}/$${totals.cost_usd.toFixed(6)}`,
    );
  }

  const factResult = reportFacts(id, current, runs);
  factReports = factResult.reports;
  check(
    "every dynamic fact is attributed to a run",
    !REQUIRE_EXPLORATION ||
      (factResult.dynamicCount > 0 && factResult.attributedCount === factResult.dynamicCount),
    `${factResult.attributedCount}/${factResult.dynamicCount}`,
  );
  if (factResult.dynamicCount > 0 && factResult.evidenceCount < factResult.dynamicCount) {
    warn(
      `${factResult.dynamicCount - factResult.evidenceCount} of ${factResult.dynamicCount} ` +
        "dynamic fact(s) have no accepted evidence",
    );
  }
  const factText = factReports.map((report) => report.description).join("\n");
  check(
    "a fact records the first marker",
    !REQUIRE_EXPLORATION || factText.includes(MARKER),
    factReports.some((report) => report.description.includes(MARKER))
      ? "marker.txt value present"
      : "marker value absent",
  );
  check(
    "a fact records the second marker",
    !REQUIRE_EXPLORATION || factText.includes(SECOND),
    factReports.some((report) => report.description.includes(SECOND))
      ? "second.txt value present"
      : "second value absent",
  );

  for (const report of factReports) {
    const run = runReports.find((entry) => entry.id === report.run_id);
    if (run !== undefined) {
      run.fact_ids.push(report.id);
      run.allocated_tokens += report.allocated_tokens;
      run.allocated_cost_usd += report.allocated_cost_usd;
    }
  }

  if (state === null) {
    check("strategist watermarks were persisted", false, "no strategist_state row");
  } else {
    check(
      "strategist watermarks advanced",
      state.last_success_at !== null && state.last_attempt_at !== null && state.last_run_id !== null,
      `trigger=${state.last_trigger ?? "null"} run=${state.last_run_id ?? "null"}`,
    );
    check(
      "strategist last run is a recorded reason run",
      reasonRuns.some((run) => run.id === state.last_run_id),
      state.last_run_id ?? "null",
    );
    check(
      "strategist trigger names a graph change",
      state.last_trigger !== null &&
        /^(initial|facts:|hints:|open_intents:|zero_output:|stale_intents:|fallback:)/.test(
          state.last_trigger,
        ),
      state.last_trigger ?? "null",
    );
  }

  const api = createApi({ db, budget: config.budget });
  let response: Response | null = null;
  try {
    response = await api.handle(
      new Request(`http://gate.local/projects/${id}/strategist?limit=100`),
    );
  } catch (error) {
    check(
      "strategist API responds",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (response !== null) {
    check("strategist API responds", response.status === 200, `status=${response.status}`);
    if (response.status === 200) {
      try {
        strategist = (await response.json()) as StrategistView;
      } catch (error) {
        check(
          "strategist API returns JSON",
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  if (strategist !== null) {
    const view = strategist;
    check(
      "API state matches the persisted watermarks",
      sameJson(view.state, state),
      view.state === null ? "null" : `trigger=${view.state.last_trigger ?? "null"}`,
    );
    check(
      "API usage matches getProjectUsage",
      view.budget.used_tokens === usage.tokens && close(view.budget.used_cost_usd, usage.cost_usd),
      `${view.budget.used_tokens}/${usage.tokens} tokens, ` +
        `$${view.budget.used_cost_usd.toFixed(6)}/$${usage.cost_usd.toFixed(6)}`,
    );
    check("API reports no running tasks after idle", view.budget.running_tasks === 0);
    const expectedLimits = {
      max_project_tokens: config.budget.maxProjectTokens,
      max_project_cost_usd: config.budget.maxProjectCostUsd,
      max_project_tasks: config.budget.maxProjectTasks,
    };
    check(
      "API limits match the scheduler configuration",
      sameJson(view.budget.limits, expectedLimits),
      JSON.stringify(view.budget.limits),
    );
    const expectedExhausted = {
      tokens:
        config.budget.maxProjectTokens > 0 &&
        usage.tokens >= config.budget.maxProjectTokens,
      cost_usd:
        config.budget.maxProjectCostUsd > 0 &&
        usage.cost_usd >= config.budget.maxProjectCostUsd,
      tasks:
        config.budget.maxProjectTasks > 0 &&
        view.budget.running_tasks >= config.budget.maxProjectTasks,
    };
    check(
      "API exhaustion flags match the configured limits",
      sameJson(view.budget.exhausted, expectedExhausted),
      JSON.stringify(view.budget.exhausted),
    );

    const expectedReasons = runs
      .filter((run) => run.kind === "reason")
      .slice()
      .reverse()
      .slice(0, 100)
      .map((run) => run.id);
    check(
      "API reason history matches the run rows",
      sameJson(
        view.reason_runs.map((run) => run.id),
        expectedReasons,
      ),
      view.reason_runs.map((run) => run.id).join(",") || "empty",
    );
    check(
      "API open-intent ordering matches the scheduler order",
      sameJson(
        view.intents.map((intent) => intent.id),
        expectedIntentIds(id, current),
      ),
      view.intents.map((intent) => intent.id).join(",") || "empty",
    );

    const budgetLimited =
      config.budget.maxProjectTokens > 0 || config.budget.maxProjectCostUsd > 0;
    if (EXPECT_EXHAUSTED) {
      check(
        "a budget ceiling is configured",
        budgetLimited,
        `tokens=${config.budget.maxProjectTokens} cost=$${config.budget.maxProjectCostUsd}`,
      );
      check(
        "the configured budget is exhausted",
        expectedExhausted.tokens || expectedExhausted.cost_usd,
        `used=${usage.tokens} tokens, $${usage.cost_usd.toFixed(6)}`,
      );
      const crossing = findBudgetCrossing(runs, config.budget);
      check(
        "no new non-conclude task started after the budget was crossed",
        crossing !== null &&
          runs
            .slice(crossing + 1)
            .every((run) => run.kind === "conclude"),
        crossing === null
          ? "no crossing run"
          : runs
              .slice(crossing + 1)
              .map((run) => `${run.id}:${run.kind}`)
              .join(",") || "none",
      );
    } else if (budgetLimited) {
      if (expectedExhausted.tokens || expectedExhausted.cost_usd) {
        warn("the configured budget was exhausted; run counts are capped by cost, not by the gate");
      } else {
        warn("a budget ceiling was configured but was not reached within the task cap");
      }
    }
  }

  let costResponse: Response | null = null;
  try {
    costResponse = await api.handle(new Request(`http://gate.local/projects/${id}/cost`));
  } catch (error) {
    check("cost API responds", false, error instanceof Error ? error.message : String(error));
  }
  if (costResponse !== null) {
    check("cost API responds", costResponse.status === 200, `status=${costResponse.status}`);
    if (costResponse.status === 200) {
      try {
        cost = (await costResponse.json()) as ProjectCostReport;
      } catch (error) {
        check(
          "cost API returns JSON",
          false,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  const costWrite = await api.handle(
    new Request(`http://gate.local/projects/${id}/cost`, { method: "POST" }),
  );
  check("cost API stays read-only", costWrite.status === 405, `status=${costWrite.status}`);
  if (cost !== null) verifyCostReport(id, current, runs, cost);

  const secrets = readSecretValues();
  if (secrets.length === 0) {
    warn("credential leak scan skipped: no key-like value found in auth.json");
  } else {
    const leaks = findSecretLeaks(workspace, secrets);
    check(
      "no credential value appears in project files",
      leaks.length === 0,
      leaks.length === 0 ? `${findFiles(workspace).length} file(s) scanned` : leaks.join(","),
    );
  }

  return { detail, runs, usage, state, strategist, cost, runReports, factReports };
}

function findBudgetCrossing(runs: readonly Run[], limits: BudgetConfig): number | null {
  let tokens = 0;
  let cost = 0;
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (run === undefined) continue;
    tokens += run.total_tokens;
    cost += run.cost_usd;
    if (
      (limits.maxProjectTokens > 0 && tokens >= limits.maxProjectTokens) ||
      (limits.maxProjectCostUsd > 0 && cost >= limits.maxProjectCostUsd)
    ) {
      return index;
    }
  }
  return null;
}

function writeReport(input: {
  detail: ProjectDetail | null;
  runs: Run[];
  usage: ProjectUsage;
  state: StrategistState | null;
  strategist: StrategistView | null;
  cost: ProjectCostReport | null;
  runReports: RunReport[];
  factReports: FactReport[];
  passed: boolean;
  kept: boolean;
}): void {
  const totals: TaskUsage = sumUsage(input.runs);
  const reasonTokens = sumUsage(input.runs.filter((run) => run.kind === "reason")).total_tokens;
  const report: BaselineReport = {
    generated_at: new Date().toISOString(),
    gate: "m13a+m13b",
    mode:
      config.budget.maxProjectTokens > 0 || config.budget.maxProjectCostUsd > 0
        ? "budget"
        : "baseline",
    passed: input.passed,
    failure,
    model: { solver: process.env["CAIRN_SOLVER"] ?? "unknown", config_dir: AGENT_CONFIG_DIR },
    limits: config.budget,
    project:
      input.detail === null || projectId === null
        ? null
        : {
            id: projectId,
            title: input.detail.project.title,
            status: input.detail.project.status,
            bootstrap_enabled: input.detail.project.bootstrap_enabled,
            goal: input.detail.facts.find((fact) => fact.id === "goal")?.description ?? "",
            origin: input.detail.facts.find((fact) => fact.id === "origin")?.description ?? "",
          },
    markers: { marker: MARKER, second: SECOND },
    workspace: projectId === null ? null : projectWorkspace(workspaceRoot, projectId),
    dispatched_tasks: dispatchedTasks,
    wall_clock_ms: Date.now() - startedAt,
    totals: { ...totals, runs: input.runs.length },
    pricing: {
      configured: PRICING_CONFIGURED,
      input_per_million: PRICE_INPUT_PER_M,
      output_per_million: PRICE_OUTPUT_PER_M,
      cache_read_per_million: PRICE_CACHE_READ_PER_M,
      cache_write_per_million: PRICE_CACHE_WRITE_PER_M,
    },
    derived: {
      tokens_per_fact:
        input.factReports.length === 0
          ? null
          : Math.round(totals.total_tokens / input.factReports.length),
      reason_tokens: reasonTokens,
      fast_layer_tokens: totals.total_tokens - reasonTokens,
      cache_read_share:
        totals.total_tokens === 0 ? 0 : totals.cache_read_tokens / totals.total_tokens,
      provider_cost_usd: totals.cost_usd,
      estimated_cost_usd: estimateCost(totals),
    },
    runs: input.runReports,
    facts: input.factReports,
    strategist: {
      state: input.state,
      budget: input.strategist?.budget ?? null,
      reason_runs: input.strategist?.reason_runs ?? [],
    },
    cost: input.cost,
    warnings,
    checks,
    directory,
    directory_kept: input.kept,
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function printSummary(input: {
  detail: ProjectDetail | null;
  runs: Run[];
  usage: ProjectUsage;
  state: StrategistState | null;
  strategist: StrategistView | null;
  cost: ProjectCostReport | null;
  runReports: RunReport[];
  factReports: FactReport[];
}): void {
  const totals = sumUsage(input.runs);
  console.log("\n=== M13a/M13b real-model cost baseline and attribution ===");
  if (failure !== null) console.log(`error: ${failure}`);
  if (input.detail !== null) {
    console.log(`project: ${input.detail.project.id} (${input.detail.project.status})`);
    console.log(`facts: ${input.factReports.length}`);
  }
  const kinds = new Map<string, number>();
  for (const run of input.runs) kinds.set(run.kind, (kinds.get(run.kind) ?? 0) + 1);
  console.log(
    `runs: ${input.runs.length} (${[...kinds.entries()]
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ")})`,
  );
  console.log(
    `tokens: ${totals.total_tokens} ` +
      `(in=${totals.input_tokens} out=${totals.output_tokens} ` +
      `cache_read=${totals.cache_read_tokens} cache_write=${totals.cache_write_tokens})`,
  );
  console.log(`cost_usd: ${totals.cost_usd.toFixed(6)}`);
  const reasonTokens = sumUsage(input.runs.filter((run) => run.kind === "reason")).total_tokens;
  const fastTokens = totals.total_tokens - reasonTokens;
  const cacheShare =
    totals.total_tokens === 0 ? 0 : (totals.cache_read_tokens / totals.total_tokens) * 100;
  const tokensPerFact =
    input.factReports.length === 0
      ? null
      : Math.round(totals.total_tokens / input.factReports.length);
  console.log(
    `split: slow-layer=${reasonTokens} fast-layer=${fastTokens} ` +
      `cache_read=${cacheShare.toFixed(1)}%`,
  );
  console.log(
    `tokens/fact: ${tokensPerFact === null ? "n/a" : tokensPerFact} (all project), ` +
      `direct attribution below`,
  );
  const estimate = estimateCost(totals);
  if (estimate !== null) {
    console.log(`estimated_cost_usd: ${estimate.toFixed(6)} (explicit prices)`);
  } else if (close(totals.cost_usd, 0)) {
    console.log(
      "cost note: provider reported 0 and no price is configured; " +
        "set CAIRN_GATE_PRICE_*_PER_M or models.json pricing for a USD estimate",
    );
  }
  const perFact = input.factReports
    .map(
      (fact) =>
        `${fact.id}=${fact.allocated_tokens}tok/$${fact.allocated_cost_usd.toFixed(6)}`,
    )
    .join(", ");
  console.log(`per-fact (run-attributed): ${perFact || "none"}`);
  if (input.state !== null) {
    console.log(
      `strategist: trigger=${input.state.last_trigger ?? "null"} ` +
        `run=${input.state.last_run_id ?? "null"} ` +
        `success=${input.state.last_success_at ?? "null"}`,
    );
  }
  if (input.strategist !== null) {
    const budget = input.strategist.budget;
    console.log(
      `budget: used=${budget.used_tokens} tokens/$${budget.used_cost_usd.toFixed(6)} ` +
        `limits=${JSON.stringify(budget.limits)} exhausted=${JSON.stringify(budget.exhausted)}`,
    );
  }
  if (input.cost !== null) {
    const attribution = input.cost.attribution;
    console.log(
      `cost attribution: direct=${attribution.fact_direct_tokens} ` +
        `orchestration_attributed=${attribution.orchestration_attributed_tokens}/` +
        `${attribution.orchestration_tokens} ` +
        `unattributed=${attribution.unattributed_tokens} ` +
        `complete=${attribution.complete}`,
    );
    console.log(
      `causal edges: ${input.cost.edges.length} ` +
        `(${[...new Set(input.cost.edges.map((edge) => edge.kind))].join(",") || "none"})`,
    );
  }
  for (const run of input.runReports) {
    console.log(
      `  ${run.id} ${run.kind} ${run.outcome ?? "running"} ` +
        `${run.total_tokens} token(s) $${run.cost_usd.toFixed(6)} ` +
        `facts=${run.fact_ids.join(",") || "none"}`,
    );
  }
  const passedCount = checks.filter((entry) => entry.ok).length;
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`checks: ${passedCount} passed, ${failed.length} failed`);
  if (warnings.length > 0) console.log(`warnings: ${warnings.length}`);
  console.log(`report: ${REPORT_PATH}`);
  console.log(`directory: ${directory}`);
}

await main();

const collected = await collectAndCheck();
const failedChecks = checks.filter((entry) => !entry.ok);
const passed = failure === null && checks.length > 0 && failedChecks.length === 0;
const keep = KEEP || !passed;

printSummary(collected);
writeReport({ ...collected, passed, kept: keep });

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

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}
