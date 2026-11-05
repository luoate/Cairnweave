/** M48 offline comparison on the SAME eight graph fixtures as M47. No SDK/model/network. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildAgentContext, buildTaskContextSnapshot, configureDatabase, exportProjectSliceYaml, exportProjectYaml,
  getProjectDetail, getProjectUsage, renderAgentContextYaml, type AgentContextAudit, type GraphExportAudit } from "@cairn/graph";
import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { prepareTask } from "../../apps/cairn/src/scheduler/tasks";
import { recoverContextRecord, STORE_SECTIONS } from "../../apps/cairn/src/scheduler/context-store";
import type { ContextPackReport } from "../../apps/cairn/src/scheduler/context-pack";
import { CONTEXT_SCENARIOS, seedContextScenario, type ContextScenario } from "./context";

export interface PackScenarioMetrics {
  id: string;
  kind: string;
  status: ContextPackReport["status"];
  fallback_reason: ContextPackReport["fallback_reason"];
  legacy_initial_bytes: number;
  candidate_initial_bytes: number | null;
  actual_initial_bytes: number;
  saved_initial_bytes: number;
  reduction_percent: number;
  max_initial_bytes: number;
  shadow_worker_inputs_unchanged: boolean;
  legacy_snapshot_bytes_unchanged: boolean;
  observer_snapshot_unchanged: boolean;
  pinned_state_preserved: boolean | null;
  recovered_records: number;
  recoverable_records: number;
  selections: ContextPackReport["selections"];
  resumed_history_unknown: boolean;
}
export interface PackEvaluationReport {
  schema: 1;
  mode: "deterministic-context-pack";
  model_calls: 0;
  note: string;
  scenarios: PackScenarioMetrics[];
}
export function runContextPackEvaluation(): PackEvaluationReport {
  const dir = mkdtempSync(join(tmpdir(), "cairn-context-pack-eval-"));
  try {
    const scenarios = CONTEXT_SCENARIOS.map((raw) => {
      const scenario: ContextScenario = raw;
      const db = configureDatabase(join(dir, `${scenario.id}.sqlite`));
      return db.withConn((conn): PackScenarioMetrics => {
        const { projectId, focus } = seedContextScenario(conn, scenario);
        const project = getProjectDetail(conn, projectId);
        const kind = scenario.resume ? "conclude" as const : scenario.slice ? "explore" as const : "reason" as const;
        let graphAudit: GraphExportAudit | undefined; let agentContextAudit: AgentContextAudit | undefined;
        const onGraph = (value: GraphExportAudit) => { graphAudit = value; };
        const exportYaml = scenario.slice ? exportProjectSliceYaml(conn, projectId, { focusIntentId: focus, maxFacts: 5, maxIntents: 4, onAudit: onGraph })
          : exportProjectYaml(conn, projectId, onGraph);
        const agentContextYaml = renderAgentContextYaml(buildAgentContext(conn, projectId, {
          kind, focusIntentId: focus, generatedAt: "2026-11-05T00:00:00Z", onAudit: (value) => { agentContextAudit = value; },
        }));
        const usage = getProjectUsage(conn, projectId);
        const snapshot = buildTaskContextSnapshot(conn, projectId, { budget: {
          usedTokens: usage.tokens, usedCostUsd: usage.cost_usd, maxTokens: 0, maxCostUsd: 0,
        } });
        const configFor = (mode: "off" | "shadow" | "apply") => parseDispatchConfig({
          server: "http://127.0.0.1:8000",
          runtime: { execution: "local", max_workers: 1, max_running_projects: 1, max_project_workers: 1, interval: 1,
            healthcheck_timeout: 5, prompt_group: "default" },
          tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 }, explore: { timeout: 30, conclude_timeout: 10 }, context_pack: { mode } },
          observer: { enabled: true, kernel_tasks: ["reason", "explore", "conclude"] },
        });
        const prepare = (mode: "off" | "shadow" | "apply") => prepareTask({
          config: configFor(mode), project, kind, exportYaml, agentContextYaml, graphAudit: graphAudit!, agentContextAudit: agentContextAudit!,
          contextSnapshot: snapshot, intent: project.intents.find((intent) => intent.id === focus)!,
          scope: { targets: ["127.0.0.1:8080"] }, workspaceRoot: join(dir, "workspace"),
          ...(scenario.resume ? { concludeOf: "explore" as const, resumeFromHostSessionDir: join(dir, "previous-session") } : {}),
        });
        const legacy = prepare("off"); const shadow = prepare("shadow"); const actual = prepare("apply");
        if (legacy.contextPlan.status !== "written" || actual.contextPlan.status !== "written") throw new Error("missing actual input audit");
        const canonical = (prepared: typeof legacy) => JSON.stringify(prepared.task).replaceAll(prepared.task.taskId, "TASK");
        const legacyBytes = legacy.contextPlan.plan.totals.solver.required_initial_bytes;
        const actualBytes = actual.contextPlan.plan.totals.solver.required_initial_bytes;
        const source = actual.contextPack.status === "applied" ? actual : shadow.contextPack.status === "shadow" ? shadow : null;
        let recovered = 0; let recoverable = 0; let pinned: boolean | null = null;
        if (source !== null) {
          const pack = Bun.YAML.parse(readFileSync(join(source.hostSessionDir, "context-pack.yaml"), "utf8")) as any;
          pinned = JSON.stringify(pack.core.goal) === JSON.stringify(snapshot.goal) &&
            JSON.stringify(pack.core.goal_conditions) === JSON.stringify(snapshot.goal_conditions) &&
            JSON.stringify(pack.core.reviews) === JSON.stringify(snapshot.reviews) &&
            JSON.stringify(pack.core.budget) === JSON.stringify(snapshot.budget) &&
            JSON.stringify(pack.core.scope) === JSON.stringify(source.task.scope);
          for (const section of STORE_SECTIONS) for (const record of snapshot[section]) {
            recoverable += 1;
            const id = "run_id" in record && !("id" in record) ? record.run_id : (record as { id: string }).id;
            const value = recoverContextRecord(join(source.hostSessionDir, "context-store"), projectId,
              source.contextPack.snapshot_id!, section, id);
            if (JSON.stringify(value) === JSON.stringify(record)) recovered += 1;
          }
        }
        const observer = (prepared: typeof legacy) => readFileSync(join(prepared.hostSessionDir, "observer-context.json"), "utf8").replaceAll(prepared.task.taskId, "TASK");
        return {
          id: scenario.id, kind, status: actual.contextPack.status, fallback_reason: actual.contextPack.fallback_reason,
          legacy_initial_bytes: legacyBytes, candidate_initial_bytes: actual.contextPack.candidate_initial_bytes,
          actual_initial_bytes: actualBytes, saved_initial_bytes: legacyBytes - actualBytes,
          reduction_percent: Math.round((legacyBytes - actualBytes) / legacyBytes * 10000) / 100,
          max_initial_bytes: actual.contextPack.max_initial_bytes,
          shadow_worker_inputs_unchanged: canonical(shadow) === canonical(legacy),
          legacy_snapshot_bytes_unchanged: readFileSync(actual.hostGraphSnapshotPath).equals(readFileSync(legacy.hostGraphSnapshotPath)) &&
            readFileSync(actual.hostAgentContextPath).equals(readFileSync(legacy.hostAgentContextPath)),
          observer_snapshot_unchanged: observer(actual) === observer(legacy),
          pinned_state_preserved: pinned, recovered_records: recovered, recoverable_records: recoverable,
          selections: actual.contextPack.selections,
          resumed_history_unknown: actual.contextPlan.plan.sources.find((item) => item.id === "resumed_history")?.bytes === null,
        };
      });
    });
    return { schema: 1, mode: "deterministic-context-pack", model_calls: 0,
      note: "同一图快照的真实任务准备对照；仅测初始必读 UTF-8 字节与授权投影恢复。没有执行模型，不代表总会话 token、真实费用、完成率或探索质量。指标仅在同一运行环境下比较。", scenarios };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--out")) {
    console.error("usage: bun run eval:context-pack [--out <report.json>]"); process.exitCode = 2;
  } else {
    const out = resolve(args[1] ?? `runs/context-pack-eval-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
    const report = runContextPackEvaluation(); mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    for (const scenario of report.scenarios) console.log(`${scenario.id}: ${scenario.legacy_initial_bytes}B -> ${scenario.actual_initial_bytes}B (${scenario.reduction_percent}%) ${scenario.status} reason=${scenario.fallback_reason ?? "none"} recovery=${scenario.recovered_records}/${scenario.recoverable_records}`);
    console.log(`ContextPack report: ${out} (0 model calls)`);
  }
}
