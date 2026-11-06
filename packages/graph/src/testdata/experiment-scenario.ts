import type { Database } from "bun:sqlite";
import type { AttemptResult, TaskCheckpoint } from "@cairn/contracts";
import { experiment } from "../../../contracts/src/testdata/experiment";
import { acceptTaskCheckpoint, createIntent, createProject, finishRun, finalizeCheckpointRun,
  recordIntentMeta, registerCheckpointRun, startRun, type RunFailure } from "../index";
export const EXPERIMENT_SCOPE = ["127.0.0.1:8080"];
export const EXPERIMENT_EVIDENCE = "evidence/source.txt";
export function seedExperimentScenario(conn: Database, options: {
  result?: AttemptResult; observation?: string; interpretation?: string;
  outcome?: "success" | "failed"; failure?: RunFailure;
} = {}) {
  const projectId = createProject(conn, { title: "授权本地探索评估", origin: "local fixture", goal: "验证局部假设",
    bootstrap_enabled: false, hints: null, scope: { targets: EXPERIMENT_SCOPE } }).project.id;
  const intentId = createIntent(conn, projectId, { from: ["origin"], description: "比较本地响应差异", creator: "fixture", worker: null }).id;
  recordIntentMeta(conn, { projectId, intentId, experiment: experiment() });
  const runId = `experiment-${projectId}`, taskId = `task-${projectId}`;
  startRun(conn, { id: runId, projectId, taskId, intentId, kind: "explore", worker: "fixture", startedAt: "2026-11-06T00:00:00Z" });
  registerCheckpointRun(conn, runId, EXPERIMENT_SCOPE, experiment());
  const checkpoint: TaskCheckpoint = { version: 1, project_id: projectId, task_id: taskId, intent_id: intentId,
    sequence: 1, stage: "solver_returned", progress: "比较完成", attempts: [{ id: "a1", action: "比较授权输入",
      observation: options.observation ?? "条件 A 返回 403，条件 B 返回 200", interpretation: options.interpretation ?? "可能存在条件差异，需下一次验证",
      result: options.result ?? "observed", fact_refs: ["origin"], evidence_refs: [EXPERIMENT_EVIDENCE] }], unresolved: ["尚未证明因果关系"], next_steps: [] };
  if (acceptTaskCheckpoint(conn, { runId, projectId, taskId, bytes: Buffer.from(JSON.stringify(checkpoint)) }) !== "accepted") throw new Error("fixture checkpoint rejected");
  finishRun(conn, runId, { outcome: options.outcome ?? "success", durationMs: 1, finishedAt: "2026-11-06T00:01:00Z",
    ...(options.failure === undefined ? {} : { failure: options.failure }) });
  finalizeCheckpointRun(conn, runId, "finished");
  return { projectId, intentId, runId, taskId, checkpoint };
}
