/**
 * Project artifact index.
 *
 * The worker writes large/derived files under `<workspace>/artifacts/**`; after every
 * task the control plane records relative path, size and SHA-256. The index is a scan of
 * the directory, not a trust boundary: symlinks are skipped so the scan cannot follow a
 * link out of the workspace.
 */

import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";

import { all, get, run } from "./db";

const MAX_FILES = 2_000;
const MAX_DEPTH = 20;
const HASH_CHUNK_BYTES = 1024 * 1024;

export interface ProjectArtifact {
  path: string;
  size: number;
  sha256: string;
  task_id: string;
  created_at: string;
}

export interface RecordArtifactsOptions {
  projectId: string;
  taskId: string;
  /** Host path of the project workspace. */
  workspace: string;
}

interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  size: number;
}

/**
 * Refreshes the artifact index for one project. Returns the current list (possibly the
 * previous one when the workspace has no artifacts directory yet).
 */
export function recordProjectArtifacts(
  conn: Database,
  options: RecordArtifactsOptions,
): ProjectArtifact[] {
  const root = join(options.workspace, "artifacts");
  const files = scanArtifacts(root);
  if (files === null) {
    return listProjectArtifacts(conn, options.projectId);
  }

  const createdAt = new Date().toISOString();
  run(conn, "DELETE FROM project_artifacts WHERE project_id = ?", options.projectId);
  for (const file of files) {
    run(
      conn,
      `INSERT INTO project_artifacts (project_id, path, task_id, size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      options.projectId,
      file.relativePath,
      options.taskId,
      file.size,
      hashFile(file.absolutePath),
      createdAt,
    );
  }
  return listProjectArtifacts(conn, options.projectId);
}

export function listProjectArtifacts(
  conn: Database,
  projectId: string,
): ProjectArtifact[] {
  return all<ProjectArtifact>(
    conn,
    `SELECT path, size, sha256, task_id, created_at
     FROM project_artifacts WHERE project_id = ? ORDER BY path`,
    projectId,
  );
}

export function getProjectArtifact(
  conn: Database,
  projectId: string,
  path: string,
): ProjectArtifact | null {
  return get<ProjectArtifact>(
    conn,
    `SELECT path, size, sha256, task_id, created_at
     FROM project_artifacts WHERE project_id = ? AND path = ?`,
    projectId,
    path,
  );
}

/** Returns null when `artifacts/` is absent (keep the previous index). */
function scanArtifacts(root: string): ScannedFile[] | null {
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;

  const files: ScannedFile[] = [];
  walk(root, root, 0, files);
  return files;
}

function walk(
  root: string,
  directory: string,
  depth: number,
  files: ScannedFile[],
): void {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    const absolutePath = join(directory, entry.name);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(root, absolutePath, depth + 1, files);
      continue;
    }
    if (!stat.isFile()) continue;
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    files.push({ relativePath, absolutePath, size: stat.size });
  }
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
