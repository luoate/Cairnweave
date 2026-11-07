import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readModelTrace } from "./project-trace";

let root: string;
const projectId = "proj_001";
const taskId = "task_abc";

function sessionDir(): string {
  return join(root, projectId, ".cairn", "sessions", taskId, "solver-session");
}

function writeTrace(lines: string[]): void {
  mkdirSync(sessionDir(), { recursive: true });
  writeFileSync(join(sessionDir(), "model-trace.jsonl"), lines.join("\n") + "\n", "utf8");
}

function event(seq: number, type: string): string {
  return JSON.stringify({ seq, at: "2026-01-02T03:00:00Z", type });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cairn-trace-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("model trace reader", () => {
  test("returns a missing trace as unavailable instead of an error", () => {
    const view = readModelTrace(root, projectId, taskId);
    expect(view).toEqual({ task_id: taskId, available: false, truncated: false, cursor: 0, events: [] });
  });

  test("returns events in order with a cursor for the next poll", () => {
    writeTrace([event(1, "request"), event(2, "response")]);
    const view = readModelTrace(root, projectId, taskId);
    expect(view.available).toBe(true);
    expect(view.events.map((item) => item.type)).toEqual(["request", "response"]);
    expect(view.cursor).toBe(2);

    writeTrace([event(1, "request"), event(2, "response"), event(3, "tool_start")]);
    const next = readModelTrace(root, projectId, taskId, { cursor: view.cursor });
    expect(next.events.map((item) => item.seq)).toEqual([3]);
    expect(next.cursor).toBe(3);
  });

  test("keeps the newest events and flags the window as truncated", () => {
    writeTrace([event(1, "a"), event(2, "b"), event(3, "c")]);
    const view = readModelTrace(root, projectId, taskId, { limit: 2 });
    expect(view.events.map((item) => item.seq)).toEqual([2, 3]);
    expect(view.truncated).toBe(true);
  });

  test("only reads the solver session directory, not a stray file one level up", () => {
    // The writer puts the trace next to the SDK session; a same-named file at the task root
    // must not be served, or a planted file would be readable through this route.
    const outer = join(root, projectId, ".cairn", "sessions", taskId);
    mkdirSync(outer, { recursive: true });
    writeFileSync(join(outer, "model-trace.jsonl"), `${event(1, "request")}\n`, "utf8");
    expect(readModelTrace(root, projectId, taskId).available).toBe(false);
  });

  test("ignores a line that is still being appended", () => {
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(join(sessionDir(), "model-trace.jsonl"), `${event(1, "request")}\n{"seq":2,"ty`, "utf8");
    const view = readModelTrace(root, projectId, taskId);
    expect(view.events.map((item) => item.seq)).toEqual([1]);
  });

  test("rejects ids that could escape the workspace", () => {
    expect(readModelTrace(root, "../etc", taskId).available).toBe(false);
    expect(readModelTrace(root, projectId, "../../model-trace").available).toBe(false);
    expect(readModelTrace(root, projectId, "a/../b").available).toBe(false);
    expect(readModelTrace(undefined, projectId, taskId).available).toBe(false);
  });

  test("refuses a trace path that is a symlink", () => {
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, `${event(1, "request")}\n`, "utf8");
    mkdirSync(sessionDir(), { recursive: true });
    try {
      symlinkSync(outside, join(sessionDir(), "model-trace.jsonl"));
    } catch {
      return; // Symlinks may require privileges on Windows; the lstat check is the same.
    }
    expect(readModelTrace(root, projectId, taskId).available).toBe(false);
  });
});
