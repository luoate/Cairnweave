/** M52d deterministic read-model/preference safety evaluation; no models, network or worker execution. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { acceptTaskCheckpoint, buildExplorationSuppression, buildTaskContextSnapshot, configureDatabase, exportProjectYaml,
  finishRun, finalizeCheckpointRun, listProjectIntentMeta, listProjectRuns, recordIntentMeta, registerCheckpointRun, startRun } from "@cairn/graph";
import { experiment } from "../../packages/contracts/src/testdata/experiment";
import { seedExperimentScenario, EXPERIMENT_SCOPE } from "../../packages/graph/src/testdata/experiment-scenario";
interface Case { id: string; expected: number; enabled?: boolean; repeats?: number; minute?: number; priority?: number;
  change?: "evidence" | "scope" | "plan" | "checkpoint" | "fault" | "tool" | "fact" | "hint" | "interpretation" | "empty" | "new" }
const CASES: Case[] = [
  { id: "default_off", enabled: false, expected: 0 }, { id: "bounded_preference", expected: 20 },
  { id: "below_threshold", repeats: 2, expected: 0 }, { id: "expired", minute: 9, expected: 0 },
  { id: "non_renewing", repeats: 7, minute: 10, expected: 0 }, { id: "priority_floor", priority: 5, expected: 5 },
  { id: "missing_evidence", change: "evidence", expected: 0 }, { id: "changed_scope", change: "scope", expected: 0 },
  { id: "changed_plan", change: "plan", expected: 0 }, { id: "missing_checkpoint", change: "checkpoint", expected: 0 },
  { id: "infrastructure_fault", change: "fault", expected: 0 }, { id: "tool_fault", change: "tool", expected: 0 },
  { id: "new_fact", change: "fact", expected: 0 }, { id: "operator_guidance", change: "hint", expected: 0 },
  { id: "interpretation_not_observation", change: "interpretation", expected: 20 },
  { id: "empty_report", change: "empty", expected: 20 }, { id: "new_observation", change: "new", expected: 0 },
];
const at = (minute: number) => `2026-11-06T00:${String(minute).padStart(2, "0")}:00Z`;
export function runExplorationEvaluation() {
  const dir = mkdtempSync(join(tmpdir(), "exploration-eval-"));
  try {
    const cases = CASES.map((scenario, index) => configureDatabase(join(dir, `${index}.sqlite`)).withConn(conn => {
      const scene = seedExperimentScenario(conn), repeats = scenario.repeats ?? 3;
      recordIntentMeta(conn, { projectId: scene.projectId, intentId: scene.intentId, priority: scenario.priority ?? 50 });
      for (let n = 1; n <= repeats; n++) {
        const id = `repeat-${n}`, last = n === repeats;
        startRun(conn, { id, projectId: scene.projectId, intentId: scene.intentId, taskId: id, kind: "explore", worker: "fixture", startedAt: at(n) });
        registerCheckpointRun(conn, id, EXPERIMENT_SCOPE, experiment());
        const checkpoint = structuredClone(scene.checkpoint); checkpoint.task_id = id;
        if (last && scenario.change === "tool") checkpoint.attempts[0]!.result = "tool_failure";
        if (scenario.change === "interpretation" || scenario.change === "empty") checkpoint.attempts[0]!.observation = "";
        if (scenario.change === "empty") checkpoint.attempts[0]!.interpretation = "";
        if (last && scenario.change === "new") checkpoint.attempts[0]!.observation = "new reported signal";
        if (!(last && scenario.change === "checkpoint")) acceptTaskCheckpoint(conn, { runId: id, projectId: scene.projectId,
          taskId: id, bytes: Buffer.from(JSON.stringify(checkpoint)) });
        finishRun(conn, id, { outcome: "success", durationMs: 1, finishedAt: at(n + 1), ...(last && scenario.change === "fault"
          ? { failure: { domain: "infrastructure" as const, code: "model_timeout" as const } } : {}) });
        finalizeCheckpointRun(conn, id, "finished");
      }
      if (scenario.change === "plan") recordIntentMeta(conn, { projectId: scene.projectId, intentId: scene.intentId, experiment: experiment({ action: "changed" }) });
      const snapshot = buildTaskContextSnapshot(conn, scene.projectId, { checkpoint: {
        scopeTargets: scenario.change === "scope" ? ["other-authorized-scope"] : EXPERIMENT_SCOPE,
        evidenceStatus: () => scenario.change === "evidence" ? "missing" : "available",
      } });
      if (scenario.change === "fact") snapshot.facts.push({ ...snapshot.facts[0]!, id: "new-fact", created_at: at(3) });
      if (scenario.change === "hint") snapshot.hints.push({ id: "h1", content: "operator input", creator: "operator", created_at: at(3), operator_guidance: "pending" });
      const before = JSON.stringify(snapshot), graph = exportProjectYaml(conn, scene.projectId), meta = listProjectIntentMeta(conn, scene.projectId);
      const decision = buildExplorationSuppression(snapshot, listProjectRuns(conn, scene.projectId), {
        enabled: scenario.enabled ?? true, now: new Date(at(scenario.minute ?? 5)),
      }).get(scene.intentId)!;
      const unchanged = before === JSON.stringify(snapshot) && graph === exportProjectYaml(conn, scene.projectId) &&
        JSON.stringify(meta) === JSON.stringify(listProjectIntentMeta(conn, scene.projectId));
      return { id: scenario.id, expected_penalty: scenario.expected, penalty: decision.penalty, state: decision.state,
        reason: decision.reason, until: decision.until, matched: decision.penalty === scenario.expected, unchanged,
        hypothesis_verdict: snapshot.intents[0]!.exploration!.hypothesis_verdict };
    }));
    return { schema: 1, mode: "deterministic-exploration-preference", model_calls: 0, real_cost_usd: null,
      note: "固定夹具只验证有界排序偏好与安全边界，不测真实探索成功率、停滞减少或成本收益；不是语义去重或路线反证。",
      cases, metrics: { total: cases.length, matched: cases.filter(item => item.matched).length,
        unsafe_reductions: cases.filter(item => item.expected_penalty === 0 && item.penalty > 0).length,
        mutations: cases.filter(item => !item.unchanged).length, verdict_changes: cases.filter(item => item.hypothesis_verdict !== "unknown").length } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--out")) {
    console.error("usage: bun run eval:exploration [--out report.json]"); process.exitCode = 2;
  } else {
    const report = runExplorationEvaluation(), path = resolve(args[1] ?? "runs/exploration-eval.json");
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.metrics)); console.log(`Exploration report: ${path} (0 model calls)`);
    if (report.metrics.matched !== report.metrics.total || report.metrics.mutations > 0 || report.metrics.verdict_changes > 0) process.exitCode = 1;
  }
}
