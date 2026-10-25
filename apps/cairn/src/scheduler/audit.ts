/**
 * Imports a task's `audit.jsonl` into the control-plane ledger. The file is written by
 * the worker (untrusted), so ingestion is bounded, skips symlinks/malformed lines, and
 * never throws into the finish path: a bad audit file must not change the task outcome.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { recordTaskAudit, type CairnDatabase } from "@cairn/graph";

export const AUDIT_FILE_NAME = "audit.jsonl";
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIT_EVENTS = 10_000;
export const MAX_AUDIT_EVENT_CHARS = 16_384;

export type AuditIngestStatus =
  | "missing"
  | "unreadable"
  | "empty"
  | "recorded"
  | "existing";

export interface AuditIngestResult {
  status: AuditIngestStatus;
  /** Events written by this call (0 unless status is "recorded"). */
  recorded: number;
  /** Lines skipped as blank, malformed, non-object or oversized. */
  skipped: number;
  /** The file exceeded MAX_AUDIT_BYTES or MAX_AUDIT_EVENTS. */
  truncated: boolean;
}

export interface IngestAuditInput {
  projectId: string;
  taskId: string;
  sessionDir: string;
}

export function ingestTaskAudit(
  db: CairnDatabase,
  input: IngestAuditInput,
): AuditIngestResult {
  const path = join(input.sessionDir, AUDIT_FILE_NAME);
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return result("missing");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return result("unreadable");
  }

  let text: string;
  let truncated = false;
  try {
    const length = Math.min(stats.size, MAX_AUDIT_BYTES);
    truncated = stats.size > MAX_AUDIT_BYTES;
    const buffer = Buffer.allocUnsafe(length);
    const descriptor = openSync(path, "r");
    try {
      let offset = 0;
      while (offset < length) {
        const bytes = readSync(descriptor, buffer, offset, length - offset, offset);
        if (bytes <= 0) break;
        offset += bytes;
      }
      text = buffer.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return result("unreadable");
  }

  const events: unknown[] = [];
  let skipped = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (line.length > MAX_AUDIT_EVENT_CHARS) {
      skipped += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    if (events.length >= MAX_AUDIT_EVENTS) {
      truncated = true;
      break;
    }
    events.push(parsed);
  }

  if (events.length === 0) {
    return { status: "empty", recorded: 0, skipped, truncated };
  }

  const summary = db.withConn((conn) =>
    recordTaskAudit(conn, {
      projectId: input.projectId,
      taskId: input.taskId,
      events,
    }),
  );
  if (summary === null) {
    return { status: "existing", recorded: 0, skipped, truncated };
  }
  return { status: "recorded", recorded: summary.event_count, skipped, truncated };
}

function result(status: AuditIngestStatus): AuditIngestResult {
  return { status, recorded: 0, skipped: 0, truncated: false };
}
