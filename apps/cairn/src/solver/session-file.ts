/**
 * Locates the solver session to resume for a conclude task.
 *
 * BreachWeave's session manager writes one append-only JSONL per session under
 * `<task session dir>/solver-session/`. A worker is killed between tasks, so conclude
 * recovery looks at the failed task's directory on disk rather than process memory.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SOLVER_SESSION_DIR = "solver-session";

/** Newest `.jsonl` session file, or null when the task produced none. */
export function latestSolverSessionFile(taskSessionDir: string): string | null {
  const dir = join(taskSessionDir, SOLVER_SESSION_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }

  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (best === null || stat.mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // The file may disappear while the task directory is cleaned up.
    }
  }
  return best?.path ?? null;
}
