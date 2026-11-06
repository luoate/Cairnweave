/** Operator guidance provenance/acknowledgement: control-plane only, never trust creator names. */
import type { Database } from "bun:sqlite";
import { all, run } from "./db";
import type { Hint } from "./models";

/** Call in the same transaction that creates the hint through an operator entry point. */
export function markOperatorHint(conn: Database, projectId: string, hintId: string): void {
  run(conn, "INSERT INTO operator_hint_meta (project_id, hint_id) VALUES (?, ?)", projectId, hintId);
}

export function attachOperatorGuidance(conn: Database, projectId: string, hints: Hint[]): Hint[] {
  const meta = new Map(all<{ hint_id: string; planned_run_id: string | null }>(conn,
    "SELECT hint_id, planned_run_id FROM operator_hint_meta WHERE project_id = ?", projectId)
    .map((row) => [row.hint_id, row.planned_run_id]));
  return hints.map((hint) => !meta.has(hint.id) ? hint : { ...hint,
    operator_guidance: meta.get(hint.id) === null ? "pending" : "planned" });
}

/** Keep every unprocessed instruction; retain four recent processed ones for continuity. */
export function selectOperatorGuidance(hints: readonly Hint[]): Hint[] {
  const ordered = hints.filter((hint) => hint.operator_guidance !== undefined)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return [...ordered.filter((hint) => hint.operator_guidance === "pending"),
    ...ordered.filter((hint) => hint.operator_guidance === "planned").slice(0, 4)];
}

/** Acknowledge exactly the dispatch snapshot, not hints arriving while reason was running. */
export function acknowledgeOperatorGuidance(conn: Database, projectId: string, hintIds: readonly string[], runId: string): void {
  for (const hintId of hintIds) {
    run(conn, `UPDATE operator_hint_meta SET planned_run_id = ?
      WHERE project_id = ? AND hint_id = ? AND planned_run_id IS NULL`, runId, projectId, hintId);
  }
}
