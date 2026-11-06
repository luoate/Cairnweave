/** M51d deterministic safety/traceability evaluation; no worker, model, network or cost claims. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateReasonPayload } from "@cairn/contracts";
import { buildExperimentReviewBasis, buildTaskContextSnapshot, configureDatabase, experimentReviewError } from "@cairn/graph";
import { experiment } from "../../packages/contracts/src/testdata/experiment";
import { review } from "../../packages/contracts/src/testdata/experiment-review";
import { EXPERIMENT_SCOPE, seedExperimentScenario } from "../../packages/graph/src/testdata/experiment-scenario";
const CASES = [
  { id: "observed_continue", accept: true, choice: "continue" },
  { id: "local_negative_change", accept: true, choice: "change_direction", options: { result: "negative_observation" } },
  { id: "missing_observation_need", accept: true, choice: "need_observation", options: { observation: " " } },
  { id: "operational_error_need", accept: true, choice: "need_observation", options: { outcome: "failed", failure: { domain: "infrastructure", code: "model_connection_error" } } },
  { id: "interpretation_only", accept: false, options: { observation: " " } },
  { id: "tool_failure", accept: false, options: { result: "tool_failure" } },
  { id: "infrastructure_failure", accept: false, options: { outcome: "failed", failure: { domain: "infrastructure", code: "model_timeout" } } },
  { id: "execution_failure", accept: false, options: { outcome: "failed", failure: { domain: "execution", code: "hard_deadline" } } },
  { id: "missing_evidence", accept: false },
  { id: "changed_scope", accept: false },
  { id: "stale_checkpoint", accept: false },
  { id: "changed_plan", accept: false },
  { id: "legacy_unbound_plan", accept: false },
  { id: "not_delivered", accept: false },
  { id: "cross_project_reference", accept: false },
  { id: "invented_observation", accept: false },
  { id: "abandoned_source", accept: false },
  { id: "missing_new_contract", accept: false },
  { id: "extra_refuted_verdict", accept: false },
] as const;
export function runExperimentEvaluation() {
  const dir = mkdtempSync(join(tmpdir(), "cairn-experiment-eval-"));
  try {
    const cases = CASES.map((scenario, index) => {
      const db = configureDatabase(join(dir, `${index}.sqlite`));
      return db.withConn(conn => {
        const scene = seedExperimentScenario(conn, ("options" in scenario ? scenario.options : {}) as Parameters<typeof seedExperimentScenario>[1]);
        const options = { checkpoint: { scopeTargets: EXPERIMENT_SCOPE, evidenceStatus: () => "available" as const } };
        const before = buildTaskContextSnapshot(conn, scene.projectId, options);
        const current = buildTaskContextSnapshot(conn, scene.projectId, options);
        const memory = current.attempts[0]!.memory!;
        switch (scenario.id) {
          case "missing_evidence": memory.experiment_result!.observations[0]!.evidence = "missing"; break;
          case "changed_scope": memory.reuse.scope_status = "changed_requires_authorization"; break;
          case "stale_checkpoint": memory.sequence = 2; memory.checkpoint.sequence = 2; break;
          case "changed_plan": current.intents[0]!.experiment = experiment({ hypothesis: "different" }); break;
          case "legacy_unbound_plan": delete memory.experiment_plan; break;
          case "abandoned_source": current.intents[0]!.status = "abandoned"; break;
        }
        const choice = "choice" in scenario ? scenario.choice : "change_direction";
        const candidate = review({ source_intent_id: scene.intentId, choice,
          observations: choice === "need_observation" ? [] : [{ run_id: scenario.id === "cross_project_reference" ? "another-project-run" : scene.runId,
            checkpoint_sequence: 1, attempt_id: scenario.id === "invented_observation" ? "invented" : "a1" }] });
        const newIntent = { from: ["origin"], description: "验证后续局部条件",
          experiment: scenario.id === "missing_new_contract" ? undefined : experiment(),
          experiment_review: scenario.id === "extra_refuted_verdict" ? { ...candidate, verdict: "refuted" } : candidate };
        let error: string | null = null;
        try {
          validateReasonPayload({ intents: [newIntent] }, false, 3);
          error = experimentReviewError(candidate, scenario.id === "not_delivered" ? undefined : buildExperimentReviewBasis(before), buildExperimentReviewBasis(current));
        } catch { error = "invalid_contract"; }
        const accepted = error === null;
        return { id: scenario.id, choice, expected: scenario.accept ? "accept" : "reject",
          actual: accepted ? "accept" : "reject", matched: accepted === scenario.accept,
          hypothesis_verdict: memory.experiment_result!.hypothesis_verdict,
          result_status: memory.experiment_result!.status, rejection: error };
      });
    });
    return { schema: 1, mode: "deterministic-experiment-review", model_calls: 0, real_cost_usd: null,
      note: "固定提案与检查点验证来源检查、安全边界和可追溯性，不测模型推理质量、真实成功率或费用收益。引用可用不等于证据有效；假设判定保持未知。",
      cases, metrics: { total: cases.length, matched: cases.filter(item => item.matched).length,
        accepted: cases.filter(item => item.actual === "accept").length,
        unsafe_acceptances: cases.filter(item => item.expected === "reject" && item.actual === "accept").length,
        verdict_changes: cases.filter(item => item.hypothesis_verdict !== "unknown").length } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const args = process.argv.slice(2).filter(arg => arg !== "--");
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--out")) {
    console.error("usage: bun run eval:experiments [--out report.json]"); process.exitCode = 2;
  } else {
    const report = runExperimentEvaluation();
    const path = resolve(args[1] ?? "runs/experiment-eval.json");
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report.metrics)); console.log(`Experiment review report: ${path} (0 model calls)`);
    if (report.metrics.matched !== report.metrics.total) process.exitCode = 1;
  }
}
