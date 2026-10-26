/**
 * Per-task model usage written by the worker as `usage.json` next to `result.json`.
 *
 * The worker derives it from the solver session's own counters, not from the model's
 * answer, so it can be trusted enough for advisory cost budgets. It is a sidecar rather
 * than a TaskResult field so the Cairn result envelope stays unchanged and usage survives
 * a rejected or malformed answer.
 */

export interface TaskUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number;
  /** Optional `provider/model-id` that produced these counters (M14c). */
  readonly model?: string;
}

export const TASK_USAGE_FILE = "usage.json";
/** Bounds the worker-written sidecar; legitimate records are a few hundred bytes. */
export const MAX_TASK_USAGE_BYTES = 16 * 1024;
/** Model identifiers are diagnostic labels, not free-form text. */
export const MAX_TASK_MODEL_LENGTH = 200;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function taskUsageErrors(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["usage must be a JSON object"];
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "total_tokens",
  ] as const) {
    if (!isNonNegativeInteger(record[key])) {
      errors.push(`${key} must be a non-negative integer`);
    }
  }
  if (!isNonNegativeNumber(record["cost_usd"])) {
    errors.push("cost_usd must be a non-negative number");
  }
  const model = record["model"];
  if (
    model !== undefined &&
    (typeof model !== "string" ||
      model.trim() === "" ||
      model.length > MAX_TASK_MODEL_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(model))
  ) {
    errors.push("model must be a non-empty string without control characters");
  }
  return errors;
}

export function isTaskUsage(value: unknown): value is TaskUsage {
  return taskUsageErrors(value).length === 0;
}

/** Strict JSON parse of a usage sidecar; null means absent or invalid. */
export function parseTaskUsageJson(text: string): TaskUsage | null {
  try {
    const value: unknown = JSON.parse(text);
    return isTaskUsage(value) ? value : null;
  } catch {
    return null;
  }
}
