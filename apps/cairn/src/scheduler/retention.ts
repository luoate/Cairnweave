/**
 * Session-directory retention. Only direct children of `<workspace>/.cairn/sessions` are
 * candidates: task files, the Observer board and anything else in the workspace are never
 * touched. Symlinks are skipped so a cleanup cannot escape the workspace.
 */

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { RetentionConfig } from "../config";

export interface SessionDirEntry {
  path: string;
  name: string;
  mtimeMs: number;
}

export interface SessionRemoval {
  path: string;
  name: string;
  reason: "age" | "count";
}

/** Newest first; symlinks and unreadable entries are ignored. */
export function scanSessionDirs(workspace: string): SessionDirEntry[] {
  const root = join(workspace, ".cairn", "sessions");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: SessionDirEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    result.push({ path, name: entry.name, mtimeMs: stats.mtimeMs });
  }
  return result.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
  );
}

/**
 * A directory is removed when it is older than the age limit or falls outside the
 * per-project keep count. Protected directories (running or pending concludes) always
 * survive, but still consume a slot in the keep count.
 */
export function selectSessionsForRemoval(
  dirs: readonly SessionDirEntry[],
  config: Pick<RetentionConfig, "sessionMaxAgeDays" | "sessionKeepPerProject">,
  protectedPaths: ReadonlySet<string>,
  nowMs = Date.now(),
): SessionRemoval[] {
  if (config.sessionMaxAgeDays === 0 && config.sessionKeepPerProject === 0) {
    return [];
  }
  const cutoffMs = nowMs - config.sessionMaxAgeDays * 86_400_000;
  const removals: SessionRemoval[] = [];
  dirs.forEach((dir, index) => {
    if (protectedPaths.has(dir.path)) return;
    if (config.sessionMaxAgeDays > 0 && dir.mtimeMs < cutoffMs) {
      removals.push({ path: dir.path, name: dir.name, reason: "age" });
      return;
    }
    if (config.sessionKeepPerProject > 0 && index >= config.sessionKeepPerProject) {
      removals.push({ path: dir.path, name: dir.name, reason: "count" });
    }
  });
  return removals;
}
