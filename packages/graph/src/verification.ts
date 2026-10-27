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
import type {
  ProjectReportVerification,
  ProjectVerification,
  ProjectVerificationInput,
  VerificationCheck,
  VerificationKind,
} from "./models";
import { getProjectOr404, utcnow } from "./services";

export const DEFAULT_VERIFICATION_KIND: VerificationKind = "evidence";

export interface RecordVerificationCheckInput {
  projectId: string;
  kind: VerificationKind;
  ok: boolean;
  detail: string;
  challengeCode?: string | null;
  flagCount?: number | null;
  flagGotCount?: number | null;
  evidenceRefs?: readonly string[];
  checkedAt?: string;
}

interface VerificationRow {
  project_id: string;
  kind: string;
  challenge_code: string | null;
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
  checked_at: string;
}

export function setProjectVerification(
  conn: Database,
  projectId: string,
  input: ProjectVerificationInput,
  createdAt?: string,
): ProjectVerification {
  getProjectOr404(conn, projectId);
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
    createdAt ?? utcnow(),
  );
  return getProjectVerification(conn, projectId);
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

export function recordVerificationCheck(
  conn: Database,
  input: RecordVerificationCheckInput,
): VerificationCheck {
  getProjectOr404(conn, input.projectId);
  run(
    conn,
    `INSERT INTO verification_checks
       (project_id, kind, ok, detail, challenge_code, flag_count, flag_got_count,
        evidence_refs, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.projectId,
    input.kind,
    input.ok ? 1 : 0,
    input.detail,
    input.challengeCode ?? null,
    input.flagCount ?? null,
    input.flagGotCount ?? null,
    JSON.stringify([...(input.evidenceRefs ?? [])]),
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
    checked_at: row.checked_at,
  };
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
