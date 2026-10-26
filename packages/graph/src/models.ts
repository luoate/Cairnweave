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

/**
 * Advisory limits attached to one reason-produced intent. They are sidecar data and never
 * change the Cairn graph export. A missing field means "use the configured default".
 */
export interface IntentBudget {
  max_seconds?: number;
  max_tool_calls?: number;
}

/** Sidecar metadata for an accepted intent (priority, budget, provenance). */
export interface IntentMeta {
  project_id: string;
  intent_id: string;
  dedupe_key: string | null;
  source: string | null;
  proposal_id: string | null;
  /** Run whose output created this intent (reason turn or applied proposal). */
  origin_run_id: string | null;
  priority: number | null;
  budget: IntentBudget | null;
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

/** Content digest recorded when a fact's evidence was accepted (no content is stored). */
export interface FactEvidenceFile {
  path: string;
  size: number;
  sha256: string;
  created_at: string;
}

/**
 * Live comparison between the recorded digest and the file that exists now.
 * `unverified` means no workspace root was configured, so only stored metadata is known.
 */
export type EvidenceFileStatus =
  | "ok"
  | "modified"
  | "missing"
  | "unreadable"
  | "invalid"
  | "unverified";

export interface VerifiedFactEvidence extends FactEvidenceFile {
  status: EvidenceFileStatus;
  current_size: number | null;
  current_sha256: string | null;
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
  /** Dispatch profile id (M15a); null when selection is disabled. */
  worker_profile: string | null;
  /** Solver-session `provider/model-id`; null when the worker could not report one. */
  model: string | null;
  trigger: string | null;
  outcome: RunOutcome | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  session: string | null;
  evidence_count: number;
  detail: string | null;
  /** Solver-session usage; all zero when the worker could not report any. */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

/** One kind's share of the project's recorded usage (M13b). */
export interface CostKind {
  kind: string;
  runs: number;
  tokens: number;
  cost_usd: number;
}

/**
 * How the project total was assigned to facts. Fact totals partition the project usage;
 * intent totals are a separate, overlapping view and must not be summed with them.
 */
export interface CostAttribution {
  fact_direct_tokens: number;
  fact_direct_cost_usd: number;
  orchestration_tokens: number;
  orchestration_cost_usd: number;
  orchestration_attributed_tokens: number;
  orchestration_attributed_cost_usd: number;
  attributed_tokens: number;
  attributed_cost_usd: number;
  unattributed_tokens: number;
  unattributed_cost_usd: number;
  complete: boolean;
}

export interface CostRun {
  id: string;
  kind: string;
  intent_id: string | null;
  trigger: string | null;
  outcome: RunOutcome | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  tokens: number;
  cost_usd: number;
  created_intent_ids: string[];
  produced_fact_ids: string[];
}

export interface CostIntent {
  id: string;
  description: string;
  from: string[];
  to: string | null;
  creator: string;
  source: string | null;
  origin_run_id: string | null;
  created_at: string;
  concluded_at: string | null;
  run_ids: string[];
  produced_fact_ids: string[];
  direct_tokens: number;
  direct_cost_usd: number;
  orchestration_tokens: number;
  orchestration_cost_usd: number;
  total_tokens: number;
  total_cost_usd: number;
}

export interface CostFact {
  id: string;
  description: string;
  run_id: string | null;
  run_kind: string | null;
  intent_id: string | null;
  evidence_status: EvidenceStatus;
  evidence_refs: string[];
  source_fact_ids: string[];
  /** Runs whose output created the intent that produced this fact (reason or proposal). */
  origin_run_ids: string[];
  direct_tokens: number;
  direct_cost_usd: number;
  orchestration_tokens: number;
  orchestration_cost_usd: number;
  total_tokens: number;
  total_cost_usd: number;
}

export type CausalEdgeKind =
  | "created_intent"
  | "executed_by"
  | "produced_fact"
  | "source_fact"
  | "concluded_fact";

/**
 * One directed relation in the cost/因果链 view. Node ids are prefixed with
 * `run:`, `intent:` or `fact:`. `tokens`/`cost_usd` are local to that edge and are not
 * additive across kinds: `executed_by` repeats the run total, while `created_intent`
 * and `produced_fact` carry the allocated share used by the fact totals.
 */
export interface CausalEdge {
  from: string;
  to: string;
  kind: CausalEdgeKind;
  tokens: number;
  cost_usd: number;
}

export interface ProjectCostReport {
  project_id: string;
  totals: {
    tokens: number;
    cost_usd: number;
    runs: number;
  };
  by_kind: CostKind[];
  attribution: CostAttribution;
  facts: CostFact[];
  intents: CostIntent[];
  runs: CostRun[];
  edges: CausalEdge[];
}

/**
 * One worker or model bucket of run outcomes (M14d). `success_rate` is
 * `succeeded / finished` and is null while no run has finished, so a bucket with only
 * running tasks never reports a misleading zero.
 */
export interface RunStatsGroup {
  runs: number;
  running: number;
  finished: number;
  succeeded: number;
  failed: number;
  rejected: number;
  cancelled: number;
  unhealthy: number;
  inactive: number;
  success_rate: number | null;
  tokens: number;
  cost_usd: number;
  avg_duration_ms: number | null;
  evidence_count: number;
  last_started_at: string | null;
}

export interface WorkerRunStats extends RunStatsGroup {
  worker: string;
}

export interface ModelRunStats extends RunStatsGroup {
  /** Null groups runs whose solver never reported a model. */
  model: string | null;
}

export interface ProfileRunStats extends RunStatsGroup {
  worker_profile: string;
}

export interface ProjectRunStatsReport {
  project_id: string;
  totals: RunStatsGroup;
  by_worker: WorkerRunStats[];
  by_model: ModelRunStats[];
  /** Runs dispatched in prompt mode (no profile) are excluded. */
  by_profile: ProfileRunStats[];
}

/**
 * Persisted slow-layer watermarks. `last_*_count` describe the graph after the last
 * successful reason turn; failures only advance the attempt/failure timestamps.
 */
export interface StrategistState {
  project_id: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_failure_at: string | null;
  last_trigger: string | null;
  last_run_id: string | null;
  last_fact_count: number;
  last_hint_count: number;
  last_open_intent_count: number;
  /** Pending operator request; the next reason outcome clears it. */
  replan_requested_at: string | null;
  replan_requested_by: string | null;
  replan_reason: string | null;
  updated_at: string;
}

/** A finished productive run, used to compute the zero-output streak. */
export interface StrategistRunSummary {
  id: string;
  kind: string;
  outcome: RunOutcome | null;
  started_at: string;
  finished_at: string;
  produced_fact: boolean;
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

export type ProposalKind = "fact" | "intent" | "hint";
export type ProposalStatus = "pending" | "applied" | "rejected" | "duplicate" | "dry_run";
export type ProposalSource = "observer" | "strategist" | "human";

/**
 * One candidate graph change. `payload` is the validated, kind-specific JSON object;
 * `evidence_refs` is duplicated at the top level so the scheduler can review it without
 * reparsing the payload.
 */
export interface Proposal {
  id: string;
  project_id: string;
  task_id: string | null;
  run_id: string | null;
  source: ProposalSource;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  dedupe_key: string | null;
  evidence_refs: string[];
  status: ProposalStatus;
  decision_reason: string | null;
  applied_id: string | null;
  created_at: string;
  reviewed_at: string | null;
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

export type VerificationKind = "challenge" | "evidence" | "off";

/**
 * Per-project completion policy. `challenge` defers to the external challenge service's
 * flag counters, `evidence` requires recorded evidence on the completing facts, and
 * `off` keeps the legacy "the model said so" behavior for imported/legacy projects.
 */
export interface ProjectVerification {
  project_id: string;
  kind: VerificationKind;
  challenge_code: string | null;
  created_at: string;
}

export interface ProjectVerificationInput {
  kind: VerificationKind;
  challenge_code?: string | null;
}

export interface VerificationCheck {
  id: number;
  project_id: string;
  kind: VerificationKind;
  ok: boolean;
  detail: string;
  challenge_code: string | null;
  flag_count: number | null;
  flag_got_count: number | null;
  evidence_refs: string[];
  checked_at: string;
}

export interface CreateProjectRequest {
  title: string;
  origin: string;
  goal: string;
  bootstrap_enabled: boolean;
  hints: CreateHintInline[] | null;
  scope: ProjectScopeInput | null;
  /** Omitted by older callers; `createProject` defaults to `evidence`. */
  verification?: ProjectVerificationInput | null;
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

/** Operator request to run one Strategist turn even without a graph-delta trigger. */
export interface ReplanRequest {
  /** Free-form note shown to the operator; null when omitted. */
  reason: string | null;
  /** Who asked for the replan; defaults to "human" for hand-made requests. */
  requested_by: string;
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

function optionalProjectVerification(body: Body): ProjectVerificationInput | null {
  if (!has(body, "verification") || body["verification"] === null) {
    return null;
  }
  const raw = body["verification"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid(
      "model_attributes_type",
      ["body", "verification"],
      "Input should be a valid dictionary or object to extract fields from",
      raw,
    );
  }
  const record = raw as Body;
  const kind = record["kind"];
  if (kind !== "challenge" && kind !== "evidence" && kind !== "off") {
    invalid(
      "literal_error",
      ["body", "verification", "kind"],
      "Input should be 'challenge', 'evidence' or 'off'",
      kind,
    );
  }
  const rawCode = record["challenge_code"];
  if (rawCode !== undefined && rawCode !== null && typeof rawCode !== "string") {
    invalid(
      "string_type",
      ["body", "verification", "challenge_code"],
      "Input should be a valid string",
      rawCode,
    );
  }
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  if (kind === "challenge") {
    if (code === "") {
      invalid(
        "value_error",
        ["body", "verification", "challenge_code"],
        "Value error, challenge verification requires a non-empty challenge_code",
        rawCode,
      );
    }
    if (code.length > 200) {
      invalid(
        "string_too_long",
        ["body", "verification", "challenge_code"],
        "String should have at most 200 characters",
        rawCode,
      );
    }
    return { kind, challenge_code: code };
  }
  if (code !== "") {
    invalid(
      "value_error",
      ["body", "verification", "challenge_code"],
      `Value error, challenge_code is only valid for challenge verification`,
      rawCode,
    );
  }
  return { kind };
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
    verification: optionalProjectVerification(body),
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

export function parseReplanRequest(value: unknown): ReplanRequest {
  const body = bodyRecord(value);
  const reason = optionalString(body, "reason");
  const requestedBy = optionalString(body, "requested_by");
  if (reason !== null && reason.length > 500) {
    invalid("string_too_long", ["body", "reason"], "String should have at most 500 characters", reason);
  }
  if (requestedBy !== null && requestedBy.length > 128) {
    invalid(
      "string_too_long",
      ["body", "requested_by"],
      "String should have at most 128 characters",
      requestedBy,
    );
  }
  return {
    reason,
    requested_by: requestedBy ?? "human",
  };
}
