/**
 * Worker -> control-plane result contract.
 *
 * The JSON shape is Cairn's existing contract, unchanged:
 *   {"accepted": true,  "data": {...}}
 *   {"accepted": false, "reason": "..."}
 *
 * The worker writes it to `WorkerTask.resultPath` and exits. It deliberately does NOT
 * print the result to stdout, because the solver and its tools may write logs there; the
 * result file is the only authoritative output.
 */

export interface AcceptedResult {
  readonly accepted: true;
  readonly data: Record<string, unknown>;
  /**
   * Task-level evidence paths, relative to the worker workspace. Optional so older models
   * and fake solvers stay compatible; the control plane marks facts without it as missing.
   */
  readonly evidence_refs?: readonly string[];
}

export interface RejectedResult {
  readonly accepted: false;
  readonly reason: string;
}

export type TaskResult = AcceptedResult | RejectedResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resultErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["result must be a JSON object"];

  const errors: string[] = [];
  const accepted = value["accepted"];
  if (typeof accepted !== "boolean") {
    errors.push("accepted must be a boolean");
    return errors;
  }

  if (accepted) {
    const data = value["data"];
    if (!isRecord(data)) {
      errors.push("data must be an object when accepted is true");
    } else if (data["description"] !== undefined && typeof data["description"] !== "string") {
      errors.push("data.description must be a string when present");
    }
    const evidence = value["evidence_refs"];
    if (evidence !== undefined) {
      if (!Array.isArray(evidence)) {
        errors.push("evidence_refs must be an array of strings");
      } else {
        evidence.forEach((ref, index) => {
          if (typeof ref !== "string" || ref.trim() === "") {
            errors.push(`evidence_refs[${index}] must be a non-empty string`);
          }
        });
      }
    }
  } else if (typeof value["reason"] !== "string" || value["reason"].trim().length === 0) {
    errors.push("reason must be a non-empty string when accepted is false");
  }

  return errors;
}

export function isTaskResult(value: unknown): value is TaskResult {
  return resultErrors(value).length === 0;
}

/**
 * Strict JSON parse of a result file. Cairn's tolerant "JSON inside prose/fences"
 * extraction is ported separately in M1 (`parse.ts`) and applied only to solver output
 * before it is written to the result file.
 */
export function parseTaskResultJson(text: string): TaskResult | null {
  try {
    const value: unknown = JSON.parse(text);
    return isTaskResult(value) ? value : null;
  } catch {
    return null;
  }
}
