/**
 * Solver payload validation, ported from Cairn's `dispatcher/contracts.py`.
 *
 * Cairn accepts both the documented wrapper (`{"accepted": true, "data": {...}}`) and a
 * bare payload for backward compatibility with models that ignore the wrapper. These
 * validators only validate; applying the result is the control plane's job.
 */

type JsonObject = Record<string, unknown>;

/** Priority assigned to a reason intent that does not specify one. */
export const DEFAULT_INTENT_PRIORITY = 50;

/** Optional reason-intent budget, stored in `intent_meta.budget` as JSON. */
export interface ReasonIntentBudget {
  /** Hard ceiling for this intent's task, capped by the configured kind timeout. */
  max_seconds?: number;
  /** Host Bridge tool-call ceiling for this task. */
  max_tool_calls?: number;
}

export type ReasonPayloadResult =
  | { kind: "rejected"; data: null }
  | { kind: "complete"; data: JsonObject }
  | { kind: "intents"; data: JsonObject[] }
  | { kind: "noop"; data: null };

export interface BootstrapExecuteResult {
  factDescription: string;
  completeDescription: string;
}

export function validateReasonPayload(
  payload: JsonObject,
  openIntentsEmpty: boolean,
  maxIntents: number,
): ReasonPayloadResult {
  const unwrapped = unwrapWrappedPayload(payload);
  if (unwrapped.accepted === false) {
    return { kind: "rejected", data: null };
  }
  let data: JsonObject;
  if (unwrapped.accepted === null) {
    if (!looksLikeReasonData(payload)) {
      throw new Error("accepted must be true or false");
    }
    data = payload;
  } else {
    data = unwrapped.data;
  }

  let complete = data["complete"];
  let intents = data["intents"];
  // Backward compatibility: accept the singular "intent" key from models.
  if (intents === undefined || intents === null) {
    const singular = data["intent"];
    if (isObject(singular)) {
      intents = [singular];
    }
  }

  if (complete !== undefined && complete !== null) {
    if (intents !== undefined && intents !== null) {
      throw new Error("complete and intents cannot coexist");
    }
    if (!isObject(complete) || !hasOwn(complete, "from") || !hasOwn(complete, "description")) {
      throw new Error("invalid complete payload");
    }
    return { kind: "complete", data: complete };
  }

  if (intents !== undefined && intents !== null) {
    if (!Array.isArray(intents)) {
      throw new Error("intents must be an array");
    }
    intents.forEach((intent, index) => {
      if (!isObject(intent) || !hasOwn(intent, "from") || !hasOwn(intent, "description")) {
        throw new Error(`invalid intent at index ${index}`);
      }
      validateIntentPriority(intent["priority"], index);
      validateIntentBudget(intent["budget"], index);
    });
    if (intents.length === 0 && openIntentsEmpty) {
      throw new Error("intents must not be empty when open_intents is empty");
    }
    const limited = intents.slice(0, maxIntents) as JsonObject[];
    if (limited.length === 0) {
      return { kind: "noop", data: null };
    }
    return { kind: "intents", data: limited };
  }

  if (openIntentsEmpty) {
    throw new Error("intents is required when open_intents is empty");
  }
  return { kind: "noop", data: null };
}

export function validateBootstrapExecutePayload(
  payload: JsonObject,
): { kind: "rejected"; data: null } | { kind: "complete"; data: BootstrapExecuteResult } {
  const unwrapped = unwrapWrappedPayload(payload);
  if (unwrapped.accepted === false) {
    return { kind: "rejected", data: null };
  }
  let data: JsonObject;
  if (unwrapped.accepted === null) {
    if (!looksLikeBootstrapExecuteData(payload)) {
      throw new Error("accepted must be true or false");
    }
    data = payload;
  } else {
    data = unwrapped.data;
  }

  const factDescription = requiredDescription(data["fact"], "fact");
  const complete = data["complete"];
  if (complete === undefined || complete === null) {
    throw new Error("complete is required");
  }
  if (!isObject(complete)) {
    throw new Error("complete must be an object");
  }
  const completeDescription = requiredDescription(complete, "complete");
  return {
    kind: "complete",
    data: { factDescription, completeDescription },
  };
}

export function validateBootstrapConcludePayload(
  payload: JsonObject,
): { kind: "rejected"; data: null } | { kind: "fact"; data: string } {
  const unwrapped = unwrapWrappedPayload(payload);
  if (unwrapped.accepted === false) {
    return { kind: "rejected", data: null };
  }
  let data: JsonObject;
  if (unwrapped.accepted === null) {
    if (!looksLikeBootstrapConcludeData(payload)) {
      throw new Error("accepted must be true or false");
    }
    data = payload;
  } else {
    data = unwrapped.data;
  }

  const extraKeys = Object.keys(data).filter((key) => key !== "fact" && key !== "complete");
  if (extraKeys.length > 0) {
    throw new Error("unexpected keys in conclude payload");
  }
  return { kind: "fact", data: requiredDescription(data["fact"], "fact") };
}

export function validateExplorePayload(
  payload: JsonObject,
): { kind: "rejected"; data: null } | { kind: "fact"; data: string } {
  const unwrapped = unwrapWrappedPayload(payload);
  if (unwrapped.accepted === false) {
    return { kind: "rejected", data: null };
  }
  let data: JsonObject;
  if (unwrapped.accepted === null) {
    if (!looksLikeExploreData(payload)) {
      throw new Error("accepted must be true or false");
    }
    data = payload;
  } else {
    data = unwrapped.data;
  }

  const description = data["description"];
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error("description is required");
  }
  return { kind: "fact", data: description.trim() };
}

type Unwrapped =
  | { accepted: false }
  | { accepted: true; data: JsonObject }
  | { accepted: null };

function unwrapWrappedPayload(payload: JsonObject): Unwrapped {
  const accepted = payload["accepted"];
  if (accepted === false) {
    return { accepted: false };
  }
  if (accepted === true) {
    const data = payload["data"];
    if (!isObject(data)) {
      throw new Error("data must be an object");
    }
    return { accepted: true, data };
  }
  return { accepted: null };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function keysEqual(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => hasOwn(value, key));
}

function looksLikeReasonData(payload: JsonObject): boolean {
  if (keysEqual(payload, ["complete"])) {
    const complete = payload["complete"];
    return isObject(complete) && hasOwn(complete, "from") && hasOwn(complete, "description");
  }
  if (keysEqual(payload, ["intents"])) {
    return Array.isArray(payload["intents"]);
  }
  if (keysEqual(payload, ["intent"])) {
    const intent = payload["intent"];
    return isObject(intent) && hasOwn(intent, "from") && hasOwn(intent, "description");
  }
  return false;
}

function looksLikeBootstrapExecuteData(payload: JsonObject): boolean {
  if (!keysEqual(payload, ["fact", "complete"])) {
    return false;
  }
  return isObject(payload["fact"]) && isObject(payload["complete"]);
}

function looksLikeBootstrapConcludeData(payload: JsonObject): boolean {
  if (!keysEqual(payload, ["fact"]) && !keysEqual(payload, ["fact", "complete"])) {
    return false;
  }
  return isObject(payload["fact"]);
}

function looksLikeExploreData(payload: JsonObject): boolean {
  return keysEqual(payload, ["description"]);
}

function requiredDescription(value: unknown, key: string): string {
  if (!isObject(value)) {
    throw new Error(`${key} is required`);
  }
  const description = value["description"];
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`${key}.description is required`);
  }
  return description.trim();
}

function validateIntentPriority(value: unknown, index: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`intent priority at index ${index} must be an integer between 0 and 100`);
  }
}

function validateIntentBudget(value: unknown, index: number): void {
  if (value === undefined || value === null) return;
  if (!isObject(value)) {
    throw new Error(`intent budget at index ${index} must be an object`);
  }
  const allowed = new Set(["max_seconds", "max_tool_calls"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`unexpected intent budget key at index ${index}: ${key}`);
    }
  }
  let fields = 0;
  for (const key of ["max_seconds", "max_tool_calls"] as const) {
    const field = value[key];
    if (field === undefined) continue;
    fields += 1;
    if (typeof field !== "number" || !Number.isInteger(field) || field <= 0) {
      throw new Error(
        `intent budget.${key} at index ${index} must be a positive integer`,
      );
    }
  }
  if (fields === 0) {
    throw new Error(
      `intent budget at index ${index} must contain max_seconds or max_tool_calls`,
    );
  }
}
