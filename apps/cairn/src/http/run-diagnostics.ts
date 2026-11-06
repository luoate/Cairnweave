import { join } from "node:path";
import { persistedModelDiagnostic, readModelDiagnostic } from "../solver/diagnostics";

interface RunDiagnosticInput {
  task_id: string;
  outcome: string | null;
  detail: string | null;
  finished_at: string | null;
}

/** Read only the newest 20 failed/running records, without exposing raw log content. */
export function attachRunDiagnostics<T extends RunDiagnosticInput>(runs: T[], workspaceRoot: string | undefined, projectId: string) {
  let remaining = 20;
  return [...runs].reverse().map((run) => {
    let diagnostic = null;
    if ((run.outcome === null || run.outcome === "failed") && remaining-- > 0) {
      if (workspaceRoot !== undefined && /^[A-Za-z0-9_-]+$/.test(projectId) && /^[A-Za-z0-9_-]{1,192}$/.test(run.task_id)) {
        diagnostic = readModelDiagnostic(join(workspaceRoot, projectId, ".cairn", "sessions", run.task_id));
      }
      diagnostic ??= persistedModelDiagnostic(run.detail, run.finished_at);
    }
    return { ...run, ...(diagnostic === null ? {} : { diagnostic }) };
  }).reverse();
}

export function latestRunDiagnostic<T extends RunDiagnosticInput>(runs: ReturnType<typeof attachRunDiagnostics<T>>) {
  for (const run of [...runs].reverse()) {
    if (run.outcome !== null && run.outcome !== "failed" && run.outcome !== "cancelled") return null;
    if (run.diagnostic != null) return { ...run.diagnostic, task_id: run.task_id, outcome: run.outcome };
  }
  return null;
}
