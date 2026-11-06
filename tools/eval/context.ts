/** M47 deterministic task-input audit. Prepares files only: no worker/model/network calls. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import {
  buildAgentContext, configureDatabase, concludeIntent, createHint, createIntent, createProject,
  exportProjectSliceYaml, exportProjectYaml, finishRun, getProjectDetail, renderAgentContextYaml,
  startRun, type AgentContextAudit, type GraphExportAudit,
} from "@cairn/graph";
import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { prepareTask } from "../../apps/cairn/src/scheduler/tasks";
import type { ContextPlan } from "../../apps/cairn/src/scheduler/context-plan";

export const CONTEXT_SCENARIOS = [
  { id: "small", title: "小项目", facts: 3, open: 2 },
  { id: "many_facts", title: "大量事实", facts: 260, open: 3 },
  { id: "many_intents", title: "大量开放意图", facts: 3, open: 130 },
  { id: "long_description", title: "单条超长描述", facts: 1, open: 1, long: true },
  { id: "many_hints", title: "大量提示", facts: 3, open: 2, hints: 80 },
  { id: "agent_context_truncated", title: "AgentContext 已截断", facts: 230, open: 110, attempts: 30 },
  { id: "graph_slice", title: "图切片已开启", facts: 20, open: 3, slice: true },
  { id: "conclude_resume", title: "恢复已有会话", facts: 3, open: 1, resume: true },
] as const;

export interface ContextScenario {
  id: string; title: string; facts: number; open: number;
  long?: boolean; hints?: number; attempts?: number; slice?: boolean; resume?: boolean;
}

/** Shared M47/M48 deterministic graph fixture; no task execution or model calls. */
export function seedContextScenario(conn: Database, scenario: ContextScenario): { projectId: string; focus: string } {
  const projectId = createProject(conn, {
    title: scenario.title, origin: "授权本地测试输入", goal: "记录可追溯的客观结论",
    bootstrap_enabled: false, hints: null, scope: { targets: ["127.0.0.1:8080"] },
  }).project.id;
  let from = "origin";
  for (let i = 0; i < scenario.facts; i += 1) {
    const intent = createIntent(conn, projectId, { from: [from], description: `历史探索 ${i}`, creator: "eval", worker: null });
    from = concludeIntent(conn, projectId, intent.id, "eval",
      scenario.long ? "长描述".repeat(70_000) : `客观事实 ${i}`).fact.id;
  }
  let focus = "";
  for (let i = 0; i < scenario.open; i += 1) {
    focus = createIntent(conn, projectId, { from: [from], description: `开放方向 ${i}`, creator: "eval", worker: null }).id;
  }
  for (let i = 0; i < (scenario.hints ?? 0); i += 1) {
    createHint(conn, projectId, { content: `${i}: ${"提示内容 ".repeat(200)}`, creator: "eval" });
  }
  for (let i = 0; i < (scenario.attempts ?? 0); i += 1) {
    const runId = `eval-run-${String(i).padStart(3, "0")}`;
    startRun(conn, { id: runId, projectId, taskId: `eval-task-${i}`, kind: "explore", intentId: focus,
      worker: "eval", startedAt: "2026-11-04T00:00:00Z" });
    finishRun(conn, runId, { outcome: "failed", detail: "超时并不证明假设错误 ".repeat(100),
      finishedAt: "2026-11-04T00:01:00Z", durationMs: 1 });
  }
  // Commands use the real graph clock. Normalize fixture-owned rows only, rather
  // than overriding a process-global clock (which could affect the caller).
  // Crossing a second during seeding must not change time-based context selection.
  const timestamp = "2026-11-04T00:00:00Z";
  conn.query("UPDATE projects SET created_at = ? WHERE id = ?").run(timestamp, projectId);
  conn.query(`UPDATE intents SET created_at = ?,
    concluded_at = CASE WHEN concluded_at IS NULL THEN NULL ELSE ? END,
    last_heartbeat_at = CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE ? END
    WHERE project_id = ?`).run(timestamp, timestamp, timestamp, projectId);
  for (const table of ["hints", "fact_meta", "project_verification", "project_goal_conditions"]) {
    conn.query(`UPDATE ${table} SET created_at = ? WHERE project_id = ?`).run(timestamp, projectId);
  }
  return { projectId, focus };
}

export interface ContextScenarioMetrics {
  id: string;
  title: string;
  kind: "reason" | "explore" | "conclude";
  status: ContextPlan["status"];
  totals: ContextPlan["totals"];
  budget: ContextPlan["budget"];
  warnings: string[];
  /** No random task IDs, timestamps, digests, paths or model-visible content. */
  sources: Array<Pick<ContextPlan["sources"][number],
    "id" | "consumer" | "bytes" | "measurement" | "read_requirement" | "coverage" |
    "selections" | "truncated_sections" | "detail_clipping" | "graph_slice">>;
  compatibility: { worker_inputs_unchanged: boolean; snapshot_bytes_unchanged: boolean };
}
export interface ContextEvaluationReport {
  schema: 1;
  mode: "deterministic-context-preparation";
  model_calls: 0;
  compression_applied: false;
  note: string;
  scenarios: ContextScenarioMetrics[];
}

export function runContextEvaluation(): ContextEvaluationReport {
  const dir = mkdtempSync(join(tmpdir(), "cairn-context-eval-"));
  try {
    const scenarios: ContextScenarioMetrics[] = [];
    for (const raw of CONTEXT_SCENARIOS) {
      const scenario: ContextScenario = raw;
      const db = configureDatabase(join(dir, `${scenario.id}.sqlite`));
      const result = db.withConn((conn) => {
        const { projectId, focus } = seedContextScenario(conn, scenario);
        const project = getProjectDetail(conn, projectId);
        const kind = scenario.resume ? "conclude" as const : scenario.slice ? "explore" as const : "reason" as const;
        let graphAudit: GraphExportAudit | undefined;
        const captureGraph = (value: GraphExportAudit) => { graphAudit = value; };
        const exportYaml = scenario.slice
          ? exportProjectSliceYaml(conn, projectId, { focusIntentId: focus, maxFacts: 5, maxIntents: 4, onAudit: captureGraph })
          : exportProjectYaml(conn, projectId, captureGraph);
        let agentContextAudit: AgentContextAudit | undefined;
        const agentContextYaml = renderAgentContextYaml(buildAgentContext(conn, projectId, {
          kind, focusIntentId: focus, generatedAt: "2026-11-04T00:00:00Z",
          onAudit: (value) => { agentContextAudit = value; },
        }));
        const config = parseDispatchConfig({
          server: "http://127.0.0.1:8000",
          runtime: { execution: "local", max_workers: 1, max_running_projects: 1, max_project_workers: 1,
            interval: 1, healthcheck_timeout: 5, prompt_group: "default" },
          tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 },
            explore: { timeout: 30, conclude_timeout: 10 } },
          observer: { enabled: true, kernel_tasks: ["reason", "explore", "conclude"] },
        });
        const taskInput = {
          config, project, kind, exportYaml, agentContextYaml, intent: project.intents.find((intent) => intent.id === focus)!,
          scope: { targets: ["127.0.0.1:8080"] }, workspaceRoot: join(dir, "workspace"),
          ...(graphAudit === undefined ? {} : { graphAudit }),
          ...(agentContextAudit === undefined ? {} : { agentContextAudit }),
          ...(scenario.resume ? { concludeOf: "explore" as const, resumeFromHostSessionDir: join(dir, "previous-session") } : {}),
        };
        const prepared = prepareTask(taskInput);
        if (prepared.contextPlan.status !== "written") throw new Error(`context audit unavailable: ${scenario.id}`);
        const plan = prepared.contextPlan.plan;
        const off = prepareTask({ ...taskInput, config: {
          ...config, tasks: { ...config.tasks, contextPlan: { ...config.tasks.contextPlan, mode: "off" } },
        } });
        const canonical = (task: typeof prepared.task) => JSON.stringify(task).replaceAll(task.taskId, "TASK");
        return {
          id: scenario.id, title: scenario.title, kind, status: plan.status,
          totals: plan.totals, budget: plan.budget, warnings: plan.warnings,
          sources: plan.sources.map((source) => ({
            id: source.id, consumer: source.consumer, bytes: source.bytes, measurement: source.measurement,
            read_requirement: source.read_requirement, coverage: source.coverage,
            selections: source.selections, truncated_sections: source.truncated_sections,
            detail_clipping: source.detail_clipping,
            ...(source.graph_slice === undefined ? {} : { graph_slice: source.graph_slice }),
          })),
          compatibility: {
            worker_inputs_unchanged: canonical(prepared.task) === canonical(off.task),
            snapshot_bytes_unchanged:
              readFileSync(prepared.hostGraphSnapshotPath).equals(readFileSync(off.hostGraphSnapshotPath)) &&
              readFileSync(prepared.hostAgentContextPath).equals(readFileSync(off.hostAgentContextPath)),
          },
        } satisfies ContextScenarioMetrics;
      });
      scenarios.push(result);
    }
    return {
      schema: 1, mode: "deterministic-context-preparation", model_calls: 0, compression_applied: false,
      note: "计量任务提示词与要求读取的快照；不运行 worker、不调用模型。token 未估算；不代表 SDK 窗口占用、压缩质量、真实费用或完成率。绝对路径长度随运行环境变化，字节指标应在相同环境下比较。",
      scenarios,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--out")) {
    console.error("usage: bun run eval:context [--out <report.json>]");
    process.exitCode = 2;
  } else {
    const out = resolve(args[1] ?? `runs/context-eval-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
    const report = runContextEvaluation();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    for (const scenario of report.scenarios) {
      console.log(`${scenario.id}: solver=${scenario.totals.solver.required_initial_bytes}B observer=${scenario.totals.observer.required_initial_bytes}B ${scenario.budget.status} compatible=${scenario.compatibility.worker_inputs_unchanged && scenario.compatibility.snapshot_bytes_unchanged}`);
    }
    console.log(`Context audit report: ${out} (0 model calls)`);
  }
}
