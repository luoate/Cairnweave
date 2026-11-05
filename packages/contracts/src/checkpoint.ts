/** M49: bounded, untrusted worker progress. Never a Fact or completion assertion. */
export const TASK_CHECKPOINT_FILE = "checkpoint.json";
export const MAX_CHECKPOINT_BYTES = 65536;
export const ATTEMPT_RESULTS = ["observed", "negative_observation", "tool_failure", "environment_failure",
  "timeout", "cancelled", "scope_denied", "not_executed", "inconclusive"] as const;
export type AttemptResult = typeof ATTEMPT_RESULTS[number];
export interface CheckpointAttempt {
  id: string;
  action: string;
  observation: string;
  interpretation: string;
  result: AttemptResult;
  fact_refs: string[];
  evidence_refs: string[];
}
export interface CheckpointProgress {
  progress: string;
  attempts: CheckpointAttempt[];
  unresolved: string[];
  next_steps: string[];
}
export interface TaskCheckpoint extends CheckpointProgress {
  version: 1;
  project_id: string;
  task_id: string;
  sequence: number;
  intent_id: string | null;
  /** Worker-reported lifecycle only; authoritative termination lives in the control plane. */
  stage: "started" | "working" | "soft_deadline" | "solver_returned" | "solver_failed";
}
export function safeCheckpointRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\x00-\x1f\:]/.test(value) && !value.startsWith("/") && !value.includes(String.fromCharCode(92)) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const list = (v: unknown, max: number, check: (item: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(check);
export function isCheckpointProgress(v: unknown): v is CheckpointProgress {
  if (!object(v) || !text(v["progress"], 4096) || !list(v["unresolved"], 16, (s) => text(s, 1024)) ||
      !list(v["next_steps"], 16, (s) => text(s, 1024)) || !Array.isArray(v["attempts"]) || v["attempts"].length > 32) return false;
  const ids = new Set<string>();
  for (const a of v["attempts"]) {
    if (!object(a) || !keys(a, ["id", "action", "observation", "interpretation", "result", "fact_refs", "evidence_refs"]) ||
        !text(a["id"], 96, 1) || ids.has(a["id"]) || !text(a["action"], 2048, 1) ||
        !text(a["observation"], 4096) || !text(a["interpretation"], 2048) ||
        !(ATTEMPT_RESULTS as readonly unknown[]).includes(a["result"]) ||
        !list(a["fact_refs"], 32, (s) => text(s, 128, 1)) || !list(a["evidence_refs"], 16, safeCheckpointRef)) return false;
    ids.add(a["id"]);
  }
  return true;
}
export function isTaskCheckpoint(v: unknown): v is TaskCheckpoint {
  return object(v) && keys(v, ["version", "project_id", "task_id", "sequence", "intent_id", "stage", "progress", "attempts", "unresolved", "next_steps"]) &&
    v["version"] === 1 && text(v["project_id"], 128, 1) && text(v["task_id"], 192, 1) &&
    Number.isSafeInteger(v["sequence"]) && (v["sequence"] as number) > 0 &&
    (v["intent_id"] === null || text(v["intent_id"], 128, 1)) &&
    ["started", "working", "soft_deadline", "solver_returned", "solver_failed"].includes(v["stage"] as string) && isCheckpointProgress(v);
}
export function parseTaskCheckpoint(bytes: Uint8Array): TaskCheckpoint | null {
  if (bytes.byteLength > MAX_CHECKPOINT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isTaskCheckpoint(value) ? value : null;
  } catch { return null; }
}
