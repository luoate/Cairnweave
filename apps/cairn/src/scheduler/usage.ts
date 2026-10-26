/**
 * Reads the worker-written `usage.json` sidecar. The file is untrusted input: only a
 * regular, size-bounded JSON object with non-negative counters is accepted. A missing or
 * malformed sidecar means "no usage reported", never a task failure.
 */

import {
  MAX_TASK_USAGE_BYTES,
  TASK_USAGE_FILE,
  parseTaskUsageJson,
  type TaskUsage,
} from "@cairn/contracts";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readTaskUsage(sessionDir: string): TaskUsage | null {
  const path = join(sessionDir, TASK_USAGE_FILE);
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  if (stats.size <= 0 || stats.size > MAX_TASK_USAGE_BYTES) return null;
  try {
    return parseTaskUsageJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
