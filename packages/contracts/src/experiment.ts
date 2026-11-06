/** M51a: optional bounded plan, never evidence, authorization or an executable command. */
export interface ExperimentContract {
  version: 1;
  hypothesis: string;
  action: string;
  expected_signal: string;
  evidence_required: string;
  stop_condition: string;
}
export const MAX_EXPERIMENT_BYTES = 8192;
export const EXPERIMENT_FIELDS = ["hypothesis", "action", "expected_signal", "evidence_required", "stop_condition"] as const;
export function isExperimentContract(value: unknown): value is ExperimentContract {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item["version"] !== 1 || Object.keys(item).length !== 6 ||
      Object.keys(item).some(key => key !== "version" && !(EXPERIMENT_FIELDS as readonly string[]).includes(key))) return false;
  if (!EXPERIMENT_FIELDS.every(key => typeof item[key] === "string" && item[key].trim() !== "" &&
      item[key].length <= (key === "action" ? 2048 : 1024))) return false;
  // JSON overhead and multibyte text count toward the same deterministic bound.
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_EXPERIMENT_BYTES;
}
/** Stored metadata is untrusted as well; malformed/oversized values are absent, not partially repaired. */
export function parseExperimentContract(text: string | null | undefined): ExperimentContract | null {
  if (text == null || text.length > MAX_EXPERIMENT_BYTES || new TextEncoder().encode(text).byteLength > MAX_EXPERIMENT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isExperimentContract(value) ? value : null;
  } catch { return null; }
}
