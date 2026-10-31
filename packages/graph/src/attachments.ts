/**
 * Operator-uploaded challenge files.
 *
 * CTF tasks often ship a file (a binary, a pcap, an app bundle). The bytes live in the
 * project workspace under `attachments/<name>` so the worker reads them with its normal
 * file tools, and this table is the ledger the control plane shows in the UI and lists in
 * the task prompt.
 *
 * Names are unique per project. Re-uploading the same digest is idempotent; uploading
 * different bytes under a used name is refused, because a file a worker already read must
 * not silently change underneath it.
 */

import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";
import { HttpError } from "./errors";
import type { ProjectAttachment } from "./models";
import { getProjectOr404, utcnow } from "./services";

export const ATTACHMENT_DIRECTORY = "attachments";
export const MAX_ATTACHMENT_NAME_CHARS = 120;

const RESERVED_WIN32_STEMS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const ILLEGAL_CHARACTERS = new Set(['<', '>', ':', '"', "/", "\\", "|", "?", "*"]);

/**
 * Turn a client-supplied filename into one safe workspace path segment.
 *
 * A browser sends a leaf, but a curl/multipart client can send a whole path and a bundle
 * archive can carry control characters, so the leaf is taken, directory parts and reserved
 * characters are removed, and the result is capped so long names still stay readable in the UI.
 */
export function sanitizeAttachmentName(rawName: string): string {
  const leaf = rawName.replace(/\\/g, "/").split("/").pop() ?? "";
  const stripped = Array.from(leaf)
    .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
    .map((char) => (ILLEGAL_CHARACTERS.has(char) ? "_" : char))
    .join("")
    .replace(/ +/g, " ")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (stripped === "") throw new HttpError(400, "attachment name has no usable characters");
  if (RESERVED_WIN32_STEMS.test(stripped)) {
    throw new HttpError(400, `attachment name ${stripped} is reserved by Windows`);
  }
  if (stripped.length <= MAX_ATTACHMENT_NAME_CHARS) return stripped;
  const dot = stripped.lastIndexOf(".");
  const extension = dot > 0 && stripped.length - dot <= 12 ? stripped.slice(dot) : "";
  const stem = stripped.slice(0, MAX_ATTACHMENT_NAME_CHARS - extension.length).replace(/[. ]+$/, "");
  return `${stem}${extension}`;
}

/** Where the bytes live, relative to the project workspace root. */
export function attachmentRelativePath(name: string): string {
  return `${ATTACHMENT_DIRECTORY}/${name}`;
}

export interface AddProjectAttachmentInput {
  /** Raw client filename; sanitized here so every caller gets the same stored name. */
  name: string;
  sha256: string;
  size: number;
  creator: string;
  createdAt?: string;
  /**
   * Per-project byte budget. A new row that would cross it is refused; replaying a file
   * the project already holds is not, because it stores no new bytes.
   */
  maxTotalBytes?: number;
}

interface AttachmentRow {
  id: number;
  project_id: string;
  name: string;
  path: string;
  size: number;
  sha256: string;
  creator: string;
  created_at: string;
}

/**
 * Record one uploaded file. The caller writes the bytes first, so a row always describes
 * something that exists on disk.
 */
export function addProjectAttachment(
  conn: Database,
  projectId: string,
  input: AddProjectAttachmentInput,
): { attachment: ProjectAttachment; created: boolean } {
  getProjectOr404(conn, projectId);
  const sha256 = input.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new HttpError(400, "attachment requires a sha256 hex digest");
  }
  if (!Number.isInteger(input.size) || input.size < 0) {
    throw new HttpError(400, "attachment size must be a non-negative integer");
  }
  const creator = input.creator.trim();
  if (creator === "") throw new HttpError(400, "attachment requires a creator");
  const name = sanitizeAttachmentName(input.name);

  const existing = get<AttachmentRow>(
    conn,
    "SELECT * FROM project_attachments WHERE project_id = ? AND name = ?",
    projectId,
    name,
  );
  if (existing !== null) {
    if (existing.sha256 === sha256) {
      return { attachment: attachmentFromRow(existing), created: false };
    }
    throw new HttpError(
      409,
      `${name} already holds different bytes; delete it before uploading a replacement`,
    );
  }
  if (input.maxTotalBytes !== undefined) {
    const held = sumProjectAttachmentBytes(conn, projectId);
    if (held + input.size > input.maxTotalBytes) {
      throw new HttpError(
        413,
        `this upload would exceed the ${input.maxTotalBytes}-byte attachment budget`,
      );
    }
  }
  const inserted = conn
    .query(
      `INSERT INTO project_attachments
         (project_id, name, path, size, sha256, creator, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      name,
      attachmentRelativePath(name),
      input.size,
      sha256,
      creator,
      input.createdAt ?? utcnow(),
    );
  const stored = get<AttachmentRow>(
    conn,
    "SELECT * FROM project_attachments WHERE project_id = ? AND id = ?",
    projectId,
    Number(inserted.lastInsertRowid),
  );
  if (stored === null) throw new Error("attachment was not stored");
  return { attachment: attachmentFromRow(stored), created: true };
}

export function listProjectAttachments(
  conn: Database,
  projectId: string,
): ProjectAttachment[] {
  getProjectOr404(conn, projectId);
  return all<AttachmentRow>(
    conn,
    "SELECT * FROM project_attachments WHERE project_id = ? ORDER BY created_at, id",
    projectId,
  ).map(attachmentFromRow);
}

export function getProjectAttachment(
  conn: Database,
  projectId: string,
  id: number,
): ProjectAttachment {
  getProjectOr404(conn, projectId);
  const row = get<AttachmentRow>(
    conn,
    "SELECT * FROM project_attachments WHERE project_id = ? AND id = ?",
    projectId,
    id,
  );
  if (row === null) throw new HttpError(404, "attachment not found");
  return attachmentFromRow(row);
}

/** Drop the ledger row and hand it back so the caller can unlink the bytes. */
export function removeProjectAttachment(
  conn: Database,
  projectId: string,
  id: number,
): ProjectAttachment {
  const attachment = getProjectAttachment(conn, projectId, id);
  run(conn, "DELETE FROM project_attachments WHERE project_id = ? AND id = ?", projectId, id);
  return attachment;
}

/** Bytes already held for the project, used to enforce the per-project upload budget. */
export function sumProjectAttachmentBytes(conn: Database, projectId: string): number {
  getProjectOr404(conn, projectId);
  const row = get<{ total: number | null }>(
    conn,
    "SELECT SUM(size) AS total FROM project_attachments WHERE project_id = ?",
    projectId,
  );
  return row?.total ?? 0;
}

function attachmentFromRow(row: AttachmentRow): ProjectAttachment {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    path: row.path,
    size: row.size,
    sha256: row.sha256,
    creator: row.creator,
    created_at: row.created_at,
  };
}
