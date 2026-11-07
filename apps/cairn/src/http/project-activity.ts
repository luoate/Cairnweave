/**
 * Deadline source for the scheduler activity feed.
 *
 * A run row records what was attempted, never the limits it was given: `task.json` in the
 * task's session directory is the only persisted copy of `hardDeadlineSeconds` /
 * `softDeadlineSeconds`. The file is written once at dispatch and never rewritten, so
 * successful reads are cached for the life of the process; misses are retried, because a
 * transient read failure must not permanently hide a live deadline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ActivityDeadline, Run } from "@cairn/graph";

const deadlineCache = new Map<string, ActivityDeadline>();
const CACHE_LIMIT = 2000;

/** Returns a reader scoped to one project; without a host workspace every lookup is null. */
export function taskDeadlineReader(
  workspaceRoot: string | undefined,
  projectId: string,
): (run: Run) => ActivityDeadline | null {
  if (workspaceRoot === undefined || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    return () => null;
  }
  return (run) => {
    if (!/^[A-Za-z0-9_-]{1,192}$/.test(run.task_id)) return null;
    const key = join(workspaceRoot, projectId, run.task_id);
    const cached = deadlineCache.get(key);
    if (cached !== undefined) return cached;
    const deadline = readTaskDeadline(
      join(workspaceRoot, projectId, ".cairn", "sessions", run.task_id, "task.json"),
    );
    if (deadline === null) return null;
    if (deadlineCache.size >= CACHE_LIMIT) deadlineCache.clear();
    deadlineCache.set(key, deadline);
    return deadline;
  };
}

function readTaskDeadline(path: string): ActivityDeadline | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const task = parsed as Record<string, unknown>;
    const hard = task["hardDeadlineSeconds"];
    if (typeof hard !== "number" || !Number.isFinite(hard) || hard <= 0) return null;
    const soft = task["softDeadlineSeconds"];
    return {
      hard_seconds: hard,
      soft_seconds: typeof soft === "number" && Number.isFinite(soft) && soft > 0 ? soft : null,
    };
  } catch {
    return null;
  }
}
