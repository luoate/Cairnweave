/**
 * Content digests for accepted evidence. The graph keeps only id/description; this sidecar
 * table records what the file looked like when the fact was written so later readers can
 * detect replacement or deletion.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import type { FactEvidenceFile } from "./models";
import { getProjectOr404, utcnow } from "./services";

export interface FactEvidenceFileInput {
  path: string;
  size: number;
  sha256: string;
}

export interface RecordFactEvidenceInput {
  projectId: string;
  factId: string;
  files: readonly FactEvidenceFileInput[];
  createdAt?: string;
}

export function recordFactEvidence(conn: Database, input: RecordFactEvidenceInput): void {
  const createdAt = input.createdAt ?? utcnow();
  for (const file of input.files) {
    run(
      conn,
      `INSERT OR REPLACE INTO fact_evidence
          (project_id, fact_id, path, size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.projectId,
      input.factId,
      file.path,
      file.size,
      file.sha256,
      createdAt,
    );
  }
}

/** Returns null when the fact does not exist; an existing fact without evidence returns []. */
export function listFactEvidence(
  conn: Database,
  projectId: string,
  factId: string,
): FactEvidenceFile[] | null {
  getProjectOr404(conn, projectId);
  const fact = get<{ id: string }>(
    conn,
    "SELECT id FROM facts WHERE id = ? AND project_id = ?",
    factId,
    projectId,
  );
  if (fact === null) return null;

  return all<FactEvidenceFile>(
    conn,
    `SELECT path, size, sha256, created_at
     FROM fact_evidence WHERE project_id = ? AND fact_id = ? ORDER BY path`,
    projectId,
    factId,
  );
}
