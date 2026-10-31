/**
 * Challenge attachment upload (M35).
 *
 * A CTF task often ships a file — a binary to reverse, a pcap, an app bundle. The operator
 * puts those bytes into the project workspace here so the worker can read them with its
 * normal file tools, and the ledger row gives the UI and the task prompt a name, size and
 * digest to cite.
 *
 * One file per request: the filename is the `name` query parameter and the request body is
 * the raw bytes, so the size cap is enforced while streaming instead of after a multipart
 * parser has already buffered everything. A browser upload is `fetch(url, { body: file })`;
 * curl is `curl -T file "…?name=file"`.
 *
 * Hardening: writes require the operator token and same-origin, names are sanitized into a
 * single workspace path segment, the per-file and per-project byte budgets are checked
 * before anything touches the disk, and downloads refuse symlinked or missing paths.
 */

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";

import {
  ATTACHMENT_DIRECTORY,
  HttpError,
  addProjectAttachment,
  getProjectAttachment,
  listProjectAttachments,
  removeProjectAttachment,
  sumProjectAttachmentBytes,
  type CairnDatabase,
} from "@cairn/graph";

import { projectWorkspace } from "../scheduler/tasks";
import type { RouteContext } from "./api";
import { isCrossOrigin, requireOperator } from "./auth";

/** Approved limits: one file at most 32 MiB, one project at most 256 MiB. */
export const MAX_ATTACHMENT_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ATTACHMENT_PROJECT_BYTES = 256 * 1024 * 1024;

export interface AttachmentRouteOptions {
  db: CairnDatabase;
  /** Host workspace root; absent in pure HTTP mode, where no bytes can be stored. */
  workspaceRoot?: string | (() => string);
  operatorToken?: string;
  /** Test seams for the two budgets. */
  maxFileBytes?: number;
  maxProjectBytes?: number;
}

type RouteRegistrar = (
  method: string,
  template: string,
  handler: (context: RouteContext) => Promise<Response> | Response,
) => void;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Reads at most `maxBytes` of the body. A declared Content-Length above the cap is rejected
 * before the first read; a chunked body is cancelled as soon as it crosses the cap.
 */
async function readBoundedBytes(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      throw new HttpError(413, `attachment exceeds the ${maxBytes}-byte file limit`);
    }
  }
  if (request.body === null) {
    throw new HttpError(400, "attachment upload needs the file bytes as the request body");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The peer may already have closed the stream.
        }
        throw new HttpError(413, `attachment exceeds the ${maxBytes}-byte file limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** `attachments/` inside the workspace, with the stored name proven not to escape it. */
function attachmentHostPath(workspace: string, name: string): string | null {
  const root = resolve(workspace);
  const target = resolve(root, ATTACHMENT_DIRECTORY, name);
  const inner = relative(root, target);
  if (inner === "" || inner === ".." || inner.startsWith(`..${sep}`) || isAbsolute(inner)) {
    return null;
  }
  return target;
}

/** Regular non-symlink file inside `attachments/`; null when absent, linked or escaped. */
function readableAttachmentPath(workspace: string, name: string): string | null {
  const target = attachmentHostPath(workspace, name);
  if (target === null) return null;
  try {
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    if (!isInside(realpathSync(workspace), realpathSync(resolve(target, "..")))) return null;
    return target;
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Download header: an ASCII fallback plus the RFC 5987 form for non-ASCII names. */
function contentDisposition(name: string): string {
  const ascii = (name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "attachment").replace(
    /"/g,
    "",
  );
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function readNameParam(url: URL): string {
  const raw = url.searchParams.get("name");
  if (raw === null || raw.trim() === "") {
    throw new HttpError(400, "attachment upload needs a name query parameter");
  }
  return raw;
}

function attachmentId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "attachment id must be a positive integer");
  }
  return id;
}

/** Filesystem error identity for the operator: `EPERM`, `ENOENT`, or the message. */
function reason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? error.message;
  }
  return String(error);
}

export function registerAttachmentRoutes(
  register: RouteRegistrar,
  options: AttachmentRouteOptions,
): void {
  const { db } = options;
  const workspaceRootValue = options.workspaceRoot;
  const workspaceRoot = (): string | undefined =>
    typeof workspaceRootValue === "function" ? workspaceRootValue() : workspaceRootValue;
  const maxFileBytes = options.maxFileBytes ?? MAX_ATTACHMENT_FILE_BYTES;
  const maxProjectBytes = options.maxProjectBytes ?? MAX_ATTACHMENT_PROJECT_BYTES;

  function guard(request: Request): void {
    if (isCrossOrigin(request)) {
      throw new HttpError(403, "cross-origin attachment writes are not allowed");
    }
    requireOperator(request, options.operatorToken);
  }

  /** Host path of the project workspace, or 409 when the server runs without one. */
  function workspaceDirectory(projectId: string): string {
    const root = workspaceRoot();
    if (root === undefined) {
      throw new HttpError(409, "workspace root is not mounted, so attachments cannot be stored");
    }
    return projectWorkspace(root, projectId);
  }

  function summary(conn: Database, projectId: string) {
    return {
      attachments: listProjectAttachments(conn, projectId),
      total_bytes: sumProjectAttachmentBytes(conn, projectId),
      limits: { file_bytes: maxFileBytes, project_bytes: maxProjectBytes },
      available: workspaceRoot() !== undefined,
    };
  }

  register("GET", "/projects/{project_id}/attachments", ({ params }) =>
    db.withConn((conn) => json(summary(conn, params["project_id"]!))),
  );

  register("POST", "/projects/{project_id}/attachments", async ({ params, request, url }) => {
    guard(request);
    const projectId = params["project_id"]!;
    const rawName = readNameParam(url);
    const bytes = await readBoundedBytes(request, maxFileBytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const directory = workspaceDirectory(projectId);

    const { attachment, created } = db.withConn((conn) =>
      addProjectAttachment(conn, projectId, {
        name: rawName,
        sha256: digest,
        size: bytes.byteLength,
        creator: "operator",
        maxTotalBytes: maxProjectBytes,
      }),
    );
    const target = attachmentHostPath(directory, attachment.name);
    if (target === null) throw new HttpError(400, "attachment name is not a safe path");
    try {
      mkdirSync(resolve(target, ".."), { recursive: true });
      // Written even for a replayed digest, so the ledger can never point at a missing file.
      await Bun.write(target, bytes);
    } catch (error) {
      if (created) {
        db.withConn((conn) => removeProjectAttachment(conn, projectId, attachment.id));
      }
      throw new HttpError(500, `could not store ${attachment.name}: ${reason(error)}`);
    }
    return db.withConn((conn) =>
      json({ ...summary(conn, projectId), created }, created ? 201 : 200),
    );
  });

  register("GET", "/projects/{project_id}/attachments/{attachment_id}", ({ params }) => {
    const projectId = params["project_id"]!;
    const id = attachmentId(params["attachment_id"]);
    const directory = workspaceDirectory(projectId);
    return db.withConn((conn) => {
      const attachment = getProjectAttachment(conn, projectId, id);
      const target = readableAttachmentPath(directory, attachment.name);
      if (target === null) {
        throw new HttpError(409, `${attachment.name} is no longer readable in the workspace`);
      }
      return new Response(Bun.file(target), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": contentDisposition(attachment.name),
          "cache-control": "no-store",
        },
      });
    });
  });

  register("DELETE", "/projects/{project_id}/attachments/{attachment_id}", ({ params, request }) => {
    guard(request);
    const projectId = params["project_id"]!;
    const id = attachmentId(params["attachment_id"]);
    const directory = workspaceDirectory(projectId);
    return db.withConn((conn) => {
      const attachment = getProjectAttachment(conn, projectId, id);
      const target = readableAttachmentPath(directory, attachment.name);
      if (target !== null) {
        try {
          rmSync(target);
        } catch (error) {
          // A worker holding the file open is the usual cause on Windows; the row stays so
          // the operator can retry instead of losing track of the bytes.
          throw new HttpError(409, `${attachment.name} is still held open (${reason(error)})`);
        }
      }
      removeProjectAttachment(conn, projectId, id);
      return json({ ...summary(conn, projectId), deleted: attachment });
    });
  });
}
