/**
 * Read-only model trace access.
 *
 * The worker appends `<sessionDir>/solver-session/model-trace.jsonl`; this module turns it
 * into a cursor-based view for the UI. Two constraints shape it:
 *
 * - It must never be a way to read arbitrary files. The caller passes a project id and a
 *   task id, both re-validated here, and the path is resolved under the project workspace
 *   with the same symlink/escape checks the artifact readers use. No worker-selected path
 *   ever reaches the filesystem.
 * - It must stay cheap while a task is live. The file can be megabytes; reads are capped to
 *   a tail window and the response is bounded by `limit` events after `cursor`.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Must match `MODEL_TRACE_FILE` in `packages/agent/src/solver/extension/model-trace.ts`.
 * It is duplicated on purpose: importing it would pull the whole agent package (and the
 * model SDK) into the control plane's HTTP module graph.
 */
const TRACE_FILE = "model-trace.jsonl";

const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export interface TraceEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface ModelTraceView {
  task_id: string;
  /** False when the task never wrote a trace (disabled, fake solver, or not started). */
  available: boolean;
  /** More events exist earlier than the returned window. */
  truncated: boolean;
  /** Pass back as `cursor` to fetch only new events. */
  cursor: number;
  events: TraceEvent[];
}

function safeId(value: string | undefined, pattern: RegExp): boolean {
  return value !== undefined && pattern.test(value);
}

/**
 * Reads the tail of the trace, parses complete lines, and returns the events after
 * `cursor`. A line that is still being appended is dropped rather than surfaced half-written:
 * the reader only trusts content up to the last newline.
 */
export function readModelTrace(
  workspaceRoot: string | undefined,
  projectId: string,
  taskId: string,
  options: { cursor?: number; limit?: number } = {},
): ModelTraceView {
  const empty: ModelTraceView = { task_id: taskId, available: false, truncated: false, cursor: 0, events: [] };
  if (workspaceRoot === undefined || projectId === "") return empty;
  if (!safeId(projectId, /^[A-Za-z0-9_-]+$/) || !safeId(taskId, /^[A-Za-z0-9_-]{1,192}$/)) return empty;

  const base = resolve(workspaceRoot);
  const sessionDir = join(base, projectId, ".cairn", "sessions", taskId);
  // The trace sits next to the SDK session it describes, exactly where the worker's
  // `TCH_SOLVER_SESSION_DIR` points; the task directory itself is the outer one.
  const solverDir = join(sessionDir, "solver-session");
  const path = join(solverDir, TRACE_FILE);
  if (!isPlainDirectory(sessionDir) || realpathSync(sessionDir) !== sessionDir) return empty;
  if (!isPlainDirectory(solverDir) || realpathSync(solverDir) !== solverDir) return empty;

  let fd: number | undefined;
  try {
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink() || realpathSync(path) !== path) return empty;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev) return empty;
    const start = Math.max(0, stat.size - MAX_READ_BYTES);
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    const count = readSync(fd, bytes, 0, bytes.length, start);
    let text = bytes.subarray(0, count).toString("utf8");
    if (start > 0) {
      // The window starts mid-line; that partial line is not trustworthy.
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
    // Drop a trailing partial write: only newline-terminated lines are complete.
    const lastNewline = text.lastIndexOf("\n");
    const truncatedHead = start > 0;
    text = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);

    const parsed: TraceEvent[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let item: unknown;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (item === null || typeof item !== "object") continue;
      const event = item as TraceEvent;
      if (typeof event.seq !== "number" || typeof event.type !== "string") continue;
      parsed.push(event);
    }

    const cursor = Number.isInteger(options.cursor) && (options.cursor ?? 0) > 0 ? (options.cursor as number) : 0;
    const limit = Number.isInteger(options.limit) && (options.limit ?? 0) >= 1
      ? Math.min(options.limit as number, MAX_LIMIT)
      : DEFAULT_LIMIT;
    const after = parsed.filter((event) => event.seq > cursor);
    const events = after.slice(-limit);
    const droppedNewer = Math.max(0, after.length - events.length);
    return {
      task_id: taskId,
      available: true,
      truncated: truncatedHead || droppedNewer > 0,
      cursor: events.length > 0 ? events[events.length - 1]!.seq : cursor,
      events,
    };
  } catch {
    return empty;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isPlainDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
