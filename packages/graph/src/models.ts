import { RequestValidationError, type ValidationLocation } from "./errors";

export type ProjectStatus = "active" | "stopped" | "completed";

export interface Settings {
  intent_timeout: number;
  reason_timeout: number;
}

export interface Fact {
  id: string;
  description: string;
}

export interface Intent {
  id: string;
  // Serialized as "from" to match Cairn's API.
  from: string[];
  to: string | null;
  description: string;
  creator: string;
  worker: string | null;
  last_heartbeat_at: string | null;
  created_at: string;
  concluded_at: string | null;
}

export interface Hint {
  id: string;
  content: string;
  creator: string;
  created_at: string;
}

export type EvidenceStatus = "provided" | "missing" | "legacy";

/**
 * Sidecar metadata for a fact. The graph itself stays `{id, description}`; evidence and
 * the producing run are joined by `project_id` + `fact_id` so exports stay Cairn-compatible.
 */
export interface FactMeta {
  fact_id: string;
  run_id: string | null;
  evidence_refs: string[];
  evidence_status: EvidenceStatus;
  created_at: string | null;
}

export type RunOutcome =
  | "success"
  | "failed"
  | "rejected"
  | "cancelled"
  | "unhealthy"
  | "inactive";

/** One worker task attempt. `outcome` stays null while the task is still running. */
export interface Run {
  id: string;
  project_id: string;
  task_id: string;
  kind: string;
  intent_id: string | null;
  worker: string;
  trigger: string | null;
  outcome: RunOutcome | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  session: string | null;
  evidence_count: number;
  detail: string | null;
}

export interface ProjectReason {
  worker: string;
  trigger: string;
  started_at: string;
  last_heartbeat_at: string;
}

export interface ProjectMeta {
  id: string;
  title: string;
  status: ProjectStatus;
  bootstrap_enabled: boolean;
  created_at: string;
  reason: ProjectReason | null;
}

export interface ProjectSummary extends ProjectMeta {
  fact_count: number;
  intent_count: number;
  working_intent_count: number;
  unclaimed_intent_count: number;
  hint_count: number;
}

export interface ProjectDetail {
  project: ProjectMeta;
  facts: Fact[];
  intents: Intent[];
  hints: Hint[];
}

export interface ConcludeResponse {
  fact: Fact;
  intent: Intent;
}

export interface ReopenResponse {
  project: ProjectMeta;
  fact: Fact;
  intent: Intent;
}

// --- Request bodies -----------------------------------------------------------------------

export interface CreateHintInline {
  content: string;
  creator: string;
}

/**
 * A project's authorized scope. The scheduler refuses to dispatch a project without
 * one; Host Bridge enforcement arrives in M3, this is the data plane for it.
 */
export interface ProjectScopeInput {
  targets: string[];
  notes?: string;
}

export interface CreateProjectRequest {
  title: string;
  origin: string;
  goal: string;
  bootstrap_enabled: boolean;
  hints: CreateHintInline[] | null;
  scope: ProjectScopeInput | null;
}

export interface CreateHintRequest {
  content: string;
  creator: string;
}

export interface CreateIntentRequest {
  from: string[];
  description: string;
  creator: string;
  worker: string | null;
}

export interface HeartbeatRequest {
  worker: string;
}

export interface ReasonClaimRequest {
  worker: string;
  trigger: string;
}

export interface ConcludeRequest {
  worker: string;
  description: string;
}

export interface CompleteRequest {
  from: string[];
  description: string;
  worker: string;
}

export interface UpdateProjectStatusRequest {
  status: "active" | "stopped";
}

export interface UpdateProjectTitleRequest {
  title: string;
}

export interface ReopenRequest {
  description: string;
  creator: string;
}

// --- Validation ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function invalid(
  type: string,
  loc: ValidationLocation,
  msg: string,
  input: unknown,
): never {
  throw new RequestValidationError([{ type, loc, msg, input }]);
}

function bodyRecord(value: unknown): Body {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(
      "model_attributes_type",
      ["body"],
      "Input should be a valid dictionary or object to extract fields from",
      value,
    );
  }
  return value as Body;
}

function has(body: Body, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function requiredString(body: Body, field: string): string {
  if (!has(body, field)) {
    invalid("missing", ["body", field], "Field required", body);
  }
  return trimmedString(body[field], ["body", field]);
}

function optionalString(body: Body, field: string): string | null {
  if (!has(body, field) || body[field] === null) {
    return null;
  }
  return trimmedString(body[field], ["body", field]);
}

function trimmedString(value: unknown, loc: ValidationLocation): string {
  if (typeof value !== "string") {
    invalid("string_type", loc, "Input should be a valid string", value);
  }
  const text = value.trim();
  if (text === "") {
    invalid("value_error", loc, "Value error, must not be empty", value);
  }
  return text;
}

function requiredFactIds(body: Body, field: string): string[] {
  // pydantic's `populate_by_name=True` accepts both the alias ("from") and the field name
  // ("from_"). Keep both working for clients that copied the Python model.
  const key = has(body, field) ? field : has(body, `${field}_`) ? `${field}_` : null;
  if (key === null) {
    invalid("missing", ["body", field], "Field required", body);
  }
  const value = body[key];
  if (!Array.isArray(value)) {
    invalid("list_type", ["body", field], "Input should be a valid list", value);
  }
  if (value.length < 1) {
    invalid(
      "too_short",
      ["body", field],
      "List should have at least 1 item after validation, not 0",
      value,
    );
  }
  return value.map((item, index) => {
    const loc = ["body", field, index] as const;
    if (typeof item !== "string") {
      invalid("string_type", loc, "Input should be a valid string", item);
    }
    const text = item.trim();
    if (text === "") {
      invalid("value_error", loc, "Value error, fact ids must not be empty", item);
    }
    return text;
  });
}

function requiredIntegerAtLeast(body: Body, field: string, minimum: number): number {
  if (!has(body, field)) {
    invalid("missing", ["body", field], "Field required", body);
  }
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalid("int_type", ["body", field], "Input should be a valid integer", value);
  }
  if (value < minimum) {
    invalid(
      "greater_than_equal",
      ["body", field],
      `Input should be greater than or equal to ${minimum}`,
      value,
    );
  }
  return value;
}

function requiredBoolean(body: Body, field: string): boolean {
  if (!has(body, field)) {
    invalid("missing", ["body", field], "Field required", body);
  }
  const value = body[field];
  if (typeof value !== "boolean") {
    invalid("bool_type", ["body", field], "Input should be a valid boolean", value);
  }
  return value;
}

function optionalBoolean(body: Body, field: string, fallback: boolean): boolean {
  return has(body, field) && body[field] !== null ? requiredBoolean(body, field) : fallback;
}

export function parseSettings(value: unknown): Settings {
  const body = bodyRecord(value);
  return {
    intent_timeout: requiredIntegerAtLeast(body, "intent_timeout", 5),
    reason_timeout: requiredIntegerAtLeast(body, "reason_timeout", 5),
  };
}

function optionalProjectScope(body: Body): ProjectScopeInput | null {
  if (!has(body, "scope") || body["scope"] === null) {
    return null;
  }
  const scope = body["scope"];
  if (typeof scope !== "object" || Array.isArray(scope)) {
    invalid(
      "model_attributes_type",
      ["body", "scope"],
      "Input should be a valid dictionary or object to extract fields from",
      scope,
    );
  }
  const record = scope as Body;
  const rawTargets = record["targets"];
  if (!Array.isArray(rawTargets)) {
    invalid(
      "list_type",
      ["body", "scope", "targets"],
      "Input should be a valid list",
      rawTargets,
    );
  }
  if (rawTargets.length === 0) {
    invalid(
      "too_short",
      ["body", "scope", "targets"],
      "List should have at least 1 item after validation, not 0",
      rawTargets,
    );
  }
  const targets = rawTargets.map((item, index) => {
    if (typeof item !== "string") {
      invalid(
        "string_type",
        ["body", "scope", "targets", index],
        "Input should be a valid string",
        item,
      );
    }
    const text = item.trim();
    if (text === "") {
      invalid(
        "value_error",
        ["body", "scope", "targets", index],
        "Value error, scope targets must not be empty",
        item,
      );
    }
    return text;
  });

  const notes = record["notes"];
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    invalid(
      "string_type",
      ["body", "scope", "notes"],
      "Input should be a valid string",
      notes,
    );
  }
  return notes === undefined || notes === null
    ? { targets }
    : { targets, notes: notes as string };
}

export function parseCreateProjectRequest(value: unknown): CreateProjectRequest {
  const body = bodyRecord(value);
  const title = requiredString(body, "title");
  const origin = requiredString(body, "origin");
  const goal = requiredString(body, "goal");
  const bootstrap_enabled = optionalBoolean(body, "bootstrap_enabled", true);

  let hints: CreateHintInline[] | null = null;
  if (has(body, "hints") && body["hints"] !== null) {
    const raw = body["hints"];
    if (!Array.isArray(raw)) {
      invalid("list_type", ["body", "hints"], "Input should be a valid list", raw);
    }
    hints = raw.map((item, index) => {
      const loc = ["body", "hints", index] as const;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        invalid(
          "model_attributes_type",
          loc,
          "Input should be a valid dictionary or object to extract fields from",
          item,
        );
      }
      const hint = item as Body;
      return {
        content: requiredString(hint, "content"),
        creator: requiredString(hint, "creator"),
      };
    });
  }

  return {
    title,
    origin,
    goal,
    bootstrap_enabled,
    hints,
    scope: optionalProjectScope(body),
  };
}

export function parseCreateHintRequest(value: unknown): CreateHintRequest {
  const body = bodyRecord(value);
  return {
    content: requiredString(body, "content"),
    creator: requiredString(body, "creator"),
  };
}

export function parseCreateIntentRequest(value: unknown): CreateIntentRequest {
  const body = bodyRecord(value);
  return {
    from: requiredFactIds(body, "from"),
    description: requiredString(body, "description"),
    creator: requiredString(body, "creator"),
    worker: optionalString(body, "worker"),
  };
}

export function parseHeartbeatRequest(value: unknown): HeartbeatRequest {
  const body = bodyRecord(value);
  return { worker: requiredString(body, "worker") };
}

export function parseReasonClaimRequest(value: unknown): ReasonClaimRequest {
  const body = bodyRecord(value);
  return {
    worker: requiredString(body, "worker"),
    trigger: requiredString(body, "trigger"),
  };
}

export function parseConcludeRequest(value: unknown): ConcludeRequest {
  const body = bodyRecord(value);
  return {
    worker: requiredString(body, "worker"),
    description: requiredString(body, "description"),
  };
}

export function parseCompleteRequest(value: unknown): CompleteRequest {
  const body = bodyRecord(value);
  return {
    from: requiredFactIds(body, "from"),
    description: requiredString(body, "description"),
    worker: requiredString(body, "worker"),
  };
}

export function parseUpdateProjectStatusRequest(value: unknown): UpdateProjectStatusRequest {
  const body = bodyRecord(value);
  if (!has(body, "status")) {
    invalid("missing", ["body", "status"], "Field required", body);
  }
  const status = body["status"];
  if (status !== "active" && status !== "stopped") {
    invalid(
      "literal_error",
      ["body", "status"],
      "Input should be 'active' or 'stopped'",
      status,
    );
  }
  return { status };
}

export function parseUpdateProjectTitleRequest(value: unknown): UpdateProjectTitleRequest {
  const body = bodyRecord(value);
  return { title: requiredString(body, "title") };
}

export function parseReopenRequest(value: unknown): ReopenRequest {
  const body = bodyRecord(value);
  return {
    description: requiredString(body, "description"),
    creator: requiredString(body, "creator"),
  };
}
