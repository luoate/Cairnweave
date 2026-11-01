/**
 * Completion policy and verification history.
 *
 * The policy is sidecar data: it never changes the Cairn graph export. A project without
 * a row (created before M14a) behaves as `evidence` by default, which keeps the acceptance
 * rule "every Fact is traceable to evidence" without rewriting old graphs. Callers can
 * pass a different fallback for legacy projects (the dispatcher maps
 * `verification.evidence_enforcement: off` to `off`); it is never persisted.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { HttpError } from "./errors";
import type {
  GoalConditionKind,
  GoalConditionResult,
  ProjectGoalCondition,
  ProjectGoalConditionInput,
  ProjectReportVerification,
  ProjectVerification,
  ProjectVerificationInput,
  VerificationCheck,
  VerificationKind,
} from "./models";
import { getProjectOr404, utcnow } from "./services";

export const DEFAULT_VERIFICATION_KIND: VerificationKind = "evidence";

/** Hard bounds keep a malformed operator request from creating an unbounded AND list. */
export const MAX_PROJECT_GOAL_CONDITIONS = 8;
export const MAX_FLAG_COUNT_CONDITION = 10_000;

export interface RecordVerificationCheckInput {
  projectId: string;
  kind: VerificationKind;
  ok: boolean;
  detail: string;
  challengeCode?: string | null;
  flagCount?: number | null;
  flagGotCount?: number | null;
  evidenceRefs?: readonly string[];
  conditions?: readonly GoalConditionResult[];
  checkedAt?: string;
}

interface VerificationRow {
  project_id: string;
  kind: string;
  challenge_code: string | null;
  created_at: string;
}

interface GoalConditionRow {
  project_id: string;
  ordinal: number;
  kind: string;
  config: string;
  created_at: string;
}

interface CheckRow {
  id: number;
  project_id: string;
  kind: string;
  ok: number;
  detail: string;
  challenge_code: string | null;
  flag_count: number | null;
  flag_got_count: number | null;
  evidence_refs: string;
  conditions: string;
  checked_at: string;
}

export function setProjectVerification(
  conn: Database,
  projectId: string,
  input: ProjectVerificationInput,
  createdAt?: string,
): ProjectVerification {
  getProjectOr404(conn, projectId);
  const now = createdAt ?? utcnow();
  const policy = writeVerificationPolicy(conn, projectId, input, now);
  // A project with at most one condition is still expressed by the legacy alias, so
  // changing the alias rewrites that condition. A multi-condition list is authoritative:
  // only the alias projection changes.
  if (listProjectGoalConditions(conn, projectId).length <= 1) {
    replaceGoalConditionRows(conn, projectId, rowsForPolicy(policy), now);
  }
  return getProjectVerification(conn, projectId);
}

function writeVerificationPolicy(
  conn: Database,
  projectId: string,
  input: ProjectVerificationInput,
  createdAt: string,
): ProjectVerification {
  const challengeCode = input.challenge_code?.trim() ?? null;
  run(
    conn,
    `INSERT INTO project_verification (project_id, kind, challenge_code, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       kind = excluded.kind,
       challenge_code = excluded.challenge_code`,
    projectId,
    input.kind,
    challengeCode === "" ? null : challengeCode,
    createdAt,
  );
  return getProjectVerification(conn, projectId);
}

function rowsForPolicy(
  policy: ProjectVerification,
): Array<{ kind: GoalConditionKind; config: Record<string, unknown> }> {
  if (policy.kind === "off") return [];
  return [
    {
      kind: policy.kind,
      config:
        policy.kind === "challenge" && policy.challenge_code !== null
          ? { challenge_code: policy.challenge_code }
          : {},
    },
  ];
}

function replaceGoalConditionRows(
  conn: Database,
  projectId: string,
  conditions: readonly {
    kind: GoalConditionKind;
    config: Record<string, unknown>;
  }[],
  createdAt: string,
): void {
  run(conn, "DELETE FROM project_goal_conditions WHERE project_id = ?", projectId);
  conditions.forEach((condition, ordinal) => {
    run(
      conn,
      `INSERT INTO project_goal_conditions (project_id, ordinal, kind, config, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      projectId,
      ordinal,
      condition.kind,
      JSON.stringify(condition.config),
      createdAt,
    );
  });
}

export function getProjectVerification(
  conn: Database,
  projectId: string,
  fallbackKind: VerificationKind = DEFAULT_VERIFICATION_KIND,
): ProjectVerification {
  const project = getProjectOr404(conn, projectId);
  const row = get<VerificationRow>(
    conn,
    "SELECT * FROM project_verification WHERE project_id = ?",
    projectId,
  );
  if (row === null) {
    return {
      project_id: projectId,
      kind: fallbackKind,
      challenge_code: null,
      created_at: project.created_at,
    };
  }
  return {
    project_id: row.project_id,
    kind: normalizeKind(row.kind),
    challenge_code: row.challenge_code,
    created_at: row.created_at,
  };
}

/**
 * Replaces the complete ordered condition list and keeps the legacy
 * `project_verification` alias in step. An empty list is valid: it means the project has
 * no automatic condition (`verification: off`). New projects always store their
 * conditions, while pre-M41 projects keep no rows and are synthesized on read.
 */
export function setProjectGoalConditions(
  conn: Database,
  projectId: string,
  inputs: readonly ProjectGoalConditionInput[],
  createdAt?: string,
): ProjectGoalCondition[] {
  getProjectOr404(conn, projectId);
  const normalized = normalizeGoalConditionInputs(inputs);
  const now = createdAt ?? utcnow();
  replaceGoalConditionRows(conn, projectId, normalized, now);
  writeVerificationPolicy(conn, projectId, aliasForNormalized(normalized), now);
  return listProjectGoalConditions(conn, projectId);
}

function aliasForNormalized(
  conditions: readonly { kind: GoalConditionKind; config: Record<string, unknown> }[],
): ProjectVerificationInput {
  const challenge = conditions.find((condition) => condition.kind === "challenge");
  if (challenge !== undefined) {
    const code = challenge.config["challenge_code"];
    return {
      kind: "challenge",
      challenge_code: typeof code === "string" ? code : null,
    };
  }
  return conditions.length === 0 ? { kind: "off" } : { kind: "evidence" };
}

export function listProjectGoalConditions(
  conn: Database,
  projectId: string,
): ProjectGoalCondition[] {
  getProjectOr404(conn, projectId);
  return all<GoalConditionRow>(
    conn,
    `SELECT * FROM project_goal_conditions
     WHERE project_id = ?
     ORDER BY ordinal`,
    projectId,
  ).map(goalConditionFromRow);
}

/**
 * Stored conditions when present; otherwise one condition synthesized from the legacy
 * `project_verification` alias. This is how old projects keep their exact behavior.
 */
export function resolveProjectGoalConditions(
  conn: Database,
  projectId: string,
  fallbackKind: VerificationKind = DEFAULT_VERIFICATION_KIND,
): ProjectGoalCondition[] {
  const stored = listProjectGoalConditions(conn, projectId);
  if (stored.length > 0) return stored;
  return goalConditionsFromVerification(
    getProjectVerification(conn, projectId, fallbackKind),
  );
}

/** Conditions implied by a legacy single-policy alias. `off` implies none. */
export function goalConditionsFromVerification(
  policy: ProjectVerification,
): ProjectGoalCondition[] {
  if (policy.kind === "off") return [];
  return [
    {
      project_id: policy.project_id,
      ordinal: 0,
      kind: policy.kind,
      challenge_code: policy.kind === "challenge" ? policy.challenge_code : null,
      min: null,
      created_at: policy.created_at,
    },
  ];
}

/**
 * Compatibility alias stored in `project_verification` for callers that still read the
 * single-policy field. A flag-count-only project is aliased to `evidence`; evaluation
 * always reads the condition list.
 */
export function verificationAliasForGoalConditions(
  conditions: readonly ProjectGoalConditionInput[],
): ProjectVerificationInput {
  const challenge = conditions.find((condition) => condition.kind === "challenge");
  if (challenge !== undefined) {
    return {
      kind: "challenge",
      challenge_code: challenge.challenge_code ?? null,
    };
  }
  if (conditions.length === 0) return { kind: "off" };
  return { kind: "evidence" };
}

export function hasObjectiveGoalCondition(
  conditions: readonly Pick<ProjectGoalCondition, "kind">[],
): boolean {
  return conditions.some(
    (condition) => condition.kind === "challenge" || condition.kind === "flag_count",
  );
}

function normalizeGoalConditionInputs(
  inputs: readonly ProjectGoalConditionInput[],
): Array<{ kind: GoalConditionKind; config: Record<string, unknown> }> {
  if (inputs.length > MAX_PROJECT_GOAL_CONDITIONS) {
    throw new HttpError(
      400,
      `goal_conditions must contain at most ${MAX_PROJECT_GOAL_CONDITIONS} conditions`,
    );
  }
  const seenKinds = new Set<string>();
  const seenCodes = new Set<string>();
  return inputs.map((input, ordinal) => {
    if (input.kind === "challenge") {
      const code = input.challenge_code?.trim() ?? "";
      if (code === "") {
        throw new HttpError(400, `goal_conditions[${ordinal}] requires challenge_code`);
      }
      if (code.length > 200) {
        throw new HttpError(
          400,
          `goal_conditions[${ordinal}].challenge_code must be at most 200 characters`,
        );
      }
      if (input.min !== undefined && input.min !== null) {
        throw new HttpError(
          400,
          `goal_conditions[${ordinal}].min is only valid for flag_count`,
        );
      }
      if (seenCodes.has(code)) {
        throw new HttpError(400, `duplicate challenge condition: ${code}`);
      }
      seenCodes.add(code);
      return { kind: "challenge", config: { challenge_code: code } };
    }
    if (seenKinds.has(input.kind)) {
      throw new HttpError(400, `duplicate ${input.kind} goal condition`);
    }
    seenKinds.add(input.kind);
    if (input.kind === "flag_count") {
      const min = input.min ?? null;
      if (
        min === null ||
        !Number.isInteger(min) ||
        min < 1 ||
        min > MAX_FLAG_COUNT_CONDITION
      ) {
        throw new HttpError(
          400,
          `goal_conditions[${ordinal}].min must be an integer between 1 and ${MAX_FLAG_COUNT_CONDITION}`,
        );
      }
      return { kind: "flag_count", config: { min } };
    }
    if (input.min !== undefined && input.min !== null) {
      throw new HttpError(
        400,
        `goal_conditions[${ordinal}].min is only valid for flag_count`,
      );
    }
    return { kind: "evidence", config: {} };
  });
}

function goalConditionFromRow(row: GoalConditionRow): ProjectGoalCondition {
  const config = parseConditionConfig(row.config);
  const kind = normalizeGoalConditionKind(row.kind);
  return {
    project_id: row.project_id,
    ordinal: row.ordinal,
    kind,
    challenge_code:
      kind === "challenge" && typeof config["challenge_code"] === "string"
        ? config["challenge_code"]
        : null,
    min:
      kind === "flag_count" &&
      typeof config["min"] === "number" &&
      Number.isInteger(config["min"]) &&
      config["min"] > 0
        ? config["min"]
        : null,
    created_at: row.created_at,
  };
}

function parseConditionConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeGoalConditionKind(value: string): GoalConditionKind {
  return value === "challenge" || value === "flag_count" ? value : "evidence";
}

export function recordVerificationCheck(
  conn: Database,
  input: RecordVerificationCheckInput,
): VerificationCheck {
  getProjectOr404(conn, input.projectId);
  run(
    conn,
    `INSERT INTO verification_checks
       (project_id, kind, ok, detail, challenge_code, flag_count, flag_got_count,
        evidence_refs, conditions, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.projectId,
    input.kind,
    input.ok ? 1 : 0,
    input.detail,
    input.challengeCode ?? null,
    input.flagCount ?? null,
    input.flagGotCount ?? null,
    JSON.stringify([...(input.evidenceRefs ?? [])]),
    JSON.stringify([...(input.conditions ?? [])]),
    input.checkedAt ?? utcnow(),
  );
  const inserted = get<{ id: number }>(conn, "SELECT last_insert_rowid() AS id");
  const row = inserted === null
    ? null
    : get<CheckRow>(conn, "SELECT * FROM verification_checks WHERE id = ?", inserted.id);
  if (row === null) {
    throw new Error("verification check was not stored");
  }
  return checkFromRow(row);
}

export function listVerificationChecks(
  conn: Database,
  projectId: string,
  limit = 20,
): VerificationCheck[] {
  getProjectOr404(conn, projectId);
  return all<CheckRow>(
    conn,
    `SELECT * FROM verification_checks
     WHERE project_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    projectId,
    Math.max(1, Math.min(limit, 100)),
  ).map(checkFromRow);
}

export function getLatestVerificationCheck(
  conn: Database,
  projectId: string,
): VerificationCheck | null {
  const rows = listVerificationChecks(conn, projectId, 1);
  return rows[0] ?? null;
}

export interface ProjectVerificationSummary {
  policy: ProjectVerification;
  /** Effective M41 condition list (stored, or synthesized for a legacy project). */
  goal_conditions: ProjectGoalCondition[];
  checks: ProjectReportVerification["checks"];
  latest: VerificationCheck | null;
}

/**
 * The policy, the pass/fail aggregate over every stored check, and the most recent check.
 * Challenge flag values are not read here; the checks themselves keep only the counters.
 */
export function summarizeProjectVerification(
  conn: Database,
  projectId: string,
  fallbackKind: VerificationKind = DEFAULT_VERIFICATION_KIND,
): ProjectVerificationSummary {
  const policy = getProjectVerification(conn, projectId, fallbackKind);
  const row = get<{
    total: number;
    passed: number;
    failed: number;
    last_checked_at: string | null;
  }>(
    conn,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS passed,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
            MAX(checked_at) AS last_checked_at
     FROM verification_checks WHERE project_id = ?`,
    projectId,
  );
  return {
    policy,
    goal_conditions: resolveProjectGoalConditions(conn, projectId, fallbackKind),
    checks: {
      total: row?.total ?? 0,
      passed: row?.passed ?? 0,
      failed: row?.failed ?? 0,
      last_checked_at: row?.last_checked_at ?? null,
    },
    latest: getLatestVerificationCheck(conn, projectId),
  };
}

function checkFromRow(row: CheckRow): VerificationCheck {
  return {
    id: row.id,
    project_id: row.project_id,
    kind: normalizeKind(row.kind),
    ok: row.ok === 1,
    detail: row.detail,
    challenge_code: row.challenge_code,
    flag_count: row.flag_count,
    flag_got_count: row.flag_got_count,
    evidence_refs: parseRefs(row.evidence_refs),
    conditions: parseConditionResults(row.conditions),
    checked_at: row.checked_at,
  };
}

function parseConditionResults(raw: string): GoalConditionResult[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      const kind =
        row["kind"] === "challenge" ||
        row["kind"] === "flag_count" ||
        row["kind"] === "evidence"
          ? row["kind"]
          : null;
      if (kind === null || typeof row["ok"] !== "boolean") return [];
      return [
        {
          ordinal: typeof row["ordinal"] === "number" ? row["ordinal"] : 0,
          kind,
          ok: row["ok"],
          detail: typeof row["detail"] === "string" ? row["detail"] : "",
          challenge_code:
            typeof row["challenge_code"] === "string" ? row["challenge_code"] : null,
          flag_count: typeof row["flag_count"] === "number" ? row["flag_count"] : null,
          flag_got_count:
            typeof row["flag_got_count"] === "number" ? row["flag_got_count"] : null,
          evidence_refs: Array.isArray(row["evidence_refs"])
            ? row["evidence_refs"].filter(
                (value): value is string => typeof value === "string",
              )
            : [],
        },
      ];
    });
  } catch {
    return [];
  }
}

function parseRefs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeKind(value: string): VerificationKind {
  return value === "challenge" || value === "off" ? value : "evidence";
}
