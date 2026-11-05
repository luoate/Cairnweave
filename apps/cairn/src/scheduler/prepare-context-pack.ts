/** ContextPack rollout seam. Failures restore legacy input, never relax task authority. */
import type { WorkerTask } from "@cairn/contracts";
import type { TaskContextSnapshot } from "@cairn/graph";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchConfig } from "../config";
import { buildContextPack, type ContextPackReport, type PackCandidate, type PackFallbackReason } from "./context-pack";
import { buildContextStore, persistContextStore, type ContextStore } from "./context-store";

export interface PreparedContextPack {
  report: ContextPackReport;
  applied?: { prompt: string; candidate: PackCandidate; store: ContextStore };
}
export function prepareContextPack(input: {
  config: DispatchConfig;
  task: WorkerTask;
  hostSessionDir: string;
  snapshot?: TaskContextSnapshot;
  legacyInitialBytes: number;
  renderCompactPrompt: () => string;
}): PreparedContextPack {
  const { config, task, hostSessionDir, legacyInitialBytes } = input;
  const mode = config.tasks.contextPack.mode;
  const report: ContextPackReport = {
    version: 1, mode, status: mode === "off" ? "off" : "fallback", fallback_reason: null,
    legacy_initial_bytes: legacyInitialBytes, candidate_initial_bytes: null, actual_initial_bytes: legacyInitialBytes,
    max_initial_bytes: config.tasks.contextPlan.maxInitialBytes, snapshot_id: null, selections: [],
  };
  const persistReport = (candidate?: PackCandidate) => {
    try {
      writeFileSync(join(hostSessionDir, "context-selection.json"), `${JSON.stringify({ ...report,
        ...(candidate === undefined ? {} : { selected_ids: candidate.selected_ids }) }, null, 2)}\n`, "utf8");
      if (mode === "shadow") writeFileSync(join(hostSessionDir, "context-candidate.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch { /* Diagnostic failure cannot change a safe task or disclose error text. */ }
  };
  const fallback = (reason: PackFallbackReason): PreparedContextPack => {
    report.fallback_reason = reason;
    if (reason === "not_applicable" || reason === "unsupported_template") report.status = "not_applicable";
    persistReport(); return { report };
  };
  if (mode === "off") return { report };
  if ((task.kind !== "reason" && task.kind !== "explore") || task.resumeSessionDir !== undefined) return fallback("not_applicable");
  if (config.runtime.promptGroup !== "default") return fallback("unsupported_template");
  if (input.snapshot === undefined || input.snapshot.project.id !== task.projectId || config.runtime.strategyContext !== "on" || config.tasks.contextPlan.mode !== "audit") return fallback("snapshot_unavailable");
  let store: ContextStore;
  let prompt: string;
  let result: ReturnType<typeof buildContextPack>;
  try {
    store = buildContextStore(input.snapshot, config.tasks.contextPack.shardMaxBytes);
    prompt = input.renderCompactPrompt();
    result = buildContextPack({ snapshot: input.snapshot, catalog: store.catalog,
      kind: task.kind, ...(task.intentId === undefined ? {} : { focusIntentId: task.intentId }),
      scope: task.scope, taskId: task.taskId,
      taskBudget: { hard_deadline_seconds: task.hardDeadlineSeconds, soft_deadline_seconds: task.softDeadlineSeconds ?? null, max_tool_calls: task.maxToolCalls ?? null },
      promptBytes: Buffer.byteLength(prompt),
      maxInitialBytes: report.max_initial_bytes, legacyInitialBytes,
      completionPolicy: { evidence_enforcement: config.verification.evidenceEnforcement,
        flag_review: config.verification.flagReview, off_completion: config.verification.offCompletion,
        evidence_completion: config.verification.evidenceCompletion },
    });
  } catch { return fallback("snapshot_unavailable"); }
  report.snapshot_id = store.catalog.snapshot_id;
  if (result.status === "fallback") {
    report.candidate_initial_bytes = result.candidateInitialBytes;
    return fallback(result.reason);
  }
  const { candidate } = result;
  report.candidate_initial_bytes = Buffer.byteLength(prompt) + candidate.bytes;
  report.selections = candidate.selections;
  try {
    persistContextStore(hostSessionDir, store);
    const path = join(hostSessionDir, "context-pack.yaml");
    writeFileSync(path, candidate.text, { encoding: "utf8", flag: "wx" });
    if (readFileSync(path, "utf8") !== candidate.text) throw new Error("pack validation failed");
  } catch { return fallback("snapshot_write_failed"); }
  report.status = mode === "apply" ? "applied" : "shadow";
  if (mode === "apply") report.actual_initial_bytes = report.candidate_initial_bytes;
  persistReport(candidate);
  return mode === "apply" ? { report, applied: { prompt, candidate, store } } : { report };
}
