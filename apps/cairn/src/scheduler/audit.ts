/**
 * Imports a task's `audit.jsonl` into the control-plane ledger. The file is written by
 * the worker (untrusted), so ingestion is bounded, skips symlinks/malformed lines, and
 * never throws into the finish path: a bad audit file must not change the task outcome.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_AUDIT_EVENT_TEXT_CHARS,
  appendTaskAudit,
  recordAuditStreamLoss as recordAuditStreamLossRow,
  type AuditStreamLoss,
  type CairnDatabase,
} from "@cairn/graph";

import {
  AUDIT_STREAM_LOST_FILE,
  MAX_AUDIT_STREAM_LOST_BYTES,
  MAX_AUDIT_STREAM_LOST_REASON_CHARS,
  MAX_AUDIT_STREAM_LOST_TS_CHARS,
} from "../audit-stream/constants";

export const AUDIT_FILE_NAME = "audit.jsonl";
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIT_EVENTS = 10_000;
/** Kept as a named export for the scheduler docs/tests; the graph enforces the same cap. */
export const MAX_AUDIT_EVENT_CHARS = MAX_AUDIT_EVENT_TEXT_CHARS;

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

  const appended = db.withConn((conn) =>
    appendTaskAudit(conn, {
      projectId: input.projectId,
      taskId: input.taskId,
      entries: events.map((event, index) => ({ seq: index + 1, event })),
      // A live stream may already own a prefix; fill the tail without faulting finish.
      onConflict: "stop",
    }),
  );
  if (appended.recorded === 0) {
    return { status: "existing", recorded: 0, skipped, truncated };
  }
  return { status: "recorded", recorded: appended.recorded, skipped, truncated };
}

function result(status: AuditIngestStatus): AuditIngestResult {
  return { status, recorded: 0, skipped: 0, truncated: false };
}

export type AuditStreamLossStatus = "missing" | "unreadable" | "invalid" | "recorded";

export interface AuditStreamLossResult {
  status: AuditStreamLossStatus;
  /** The persisted row; null when the marker is absent or cannot be read. */
  loss: AuditStreamLoss | null;
}

interface MarkerFields {
  reason: string;
  delivered: number;
  pending: number;
  reportedAt: string | null;
}

type MarkerRead =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "invalid" }
  | { kind: "ok"; marker: MarkerFields };

/**
 * Imports `audit-stream-lost.json` written by the worker's live sender. The file is
 * untrusted: it is size-bounded, must be a regular file (no symlinks), and every stored
 * field is validated or replaced with a generic diagnostic.
 */
export function ingestAuditStreamLoss(
  db: CairnDatabase,
  input: IngestAuditInput,
): AuditStreamLossResult {
  const read = readLossMarker(join(input.sessionDir, AUDIT_STREAM_LOST_FILE));
  if (read.kind === "missing") {
    return { status: "missing", loss: null };
  }

  const fields: MarkerFields =
    read.kind === "ok"
      ? read.marker
      : {
          reason:
            read.kind === "invalid"
              ? "invalid audit-stream-lost.json"
              : "unreadable audit-stream-lost.json",
          delivered: 0,
          pending: 0,
          reportedAt: null,
        };

  const loss = db.withConn((conn) =>
    recordAuditStreamLossRow(conn, {
      projectId: input.projectId,
      taskId: input.taskId,
      reason: fields.reason,
      delivered: fields.delivered,
      pending: fields.pending,
      reportedAt: fields.reportedAt,
    }),
  );
  return { status: read.kind === "ok" ? "recorded" : read.kind, loss };
}

function readLossMarker(path: string): MarkerRead {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return isNotFound(error) ? { kind: "missing" } : { kind: "unreadable" };
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { kind: "unreadable" };
  }
  if (stats.size > MAX_AUDIT_STREAM_LOST_BYTES) {
    return { kind: "unreadable" };
  }

  let text: string;
  try {
    const buffer = Buffer.allocUnsafe(stats.size);
    const descriptor = openSync(path, "r");
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const bytes = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
        if (bytes <= 0) break;
        offset += bytes;
      }
      text = buffer.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return { kind: "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const marker = parseLossMarker(parsed);
  return marker === null ? { kind: "invalid" } : { kind: "ok", marker };
}

function parseLossMarker(value: unknown): MarkerFields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reason = record["reason"];
  const delivered = record["delivered"];
  const pending = record["pending"];
  const ts = record["ts"];
  if (typeof reason !== "string" || reason.trim() === "") return null;
  if (!Number.isSafeInteger(delivered) || (delivered as number) < 0) return null;
  if (!Number.isSafeInteger(pending) || (pending as number) < 0) return null;
  return {
    reason:
      reason.length <= MAX_AUDIT_STREAM_LOST_REASON_CHARS
        ? reason
        : reason.slice(0, MAX_AUDIT_STREAM_LOST_REASON_CHARS),
    delivered: delivered as number,
    pending: pending as number,
    reportedAt:
      typeof ts === "string" && ts.length <= MAX_AUDIT_STREAM_LOST_TS_CHARS ? ts : null,
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
