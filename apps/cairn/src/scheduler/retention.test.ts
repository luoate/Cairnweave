import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanSessionDirs, selectSessionsForRemoval } from "./retention";

let directory: string;
let workspace: string;
let sessions: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-retention-"));
  workspace = join(directory, "workspace");
  sessions = join(workspace, ".cairn", "sessions");
  mkdirSync(sessions, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function makeSession(name: string, mtime: Date): string {
  const path = join(sessions, name);
  mkdirSync(path, { recursive: true });
  utimesSync(path, mtime, mtime);
  return path;
}

describe("session scan", () => {
  test("lists directories newest first and ignores files and symlinks", () => {
    const now = Date.now();
    makeSession("old", new Date(now - 60_000));
    makeSession("new", new Date(now));
    writeFileSync(join(sessions, "notes.txt"), "not a session", "utf8");

    const outside = join(directory, "outside");
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(sessions, "linked"));
    } catch {
      // Windows without developer mode; the directory filter is still exercised.
    }

    expect(scanSessionDirs(workspace).map((entry) => entry.name)).toEqual([
      "new",
      "old",
    ]);
  });

  test("returns an empty list when the workspace has no sessions", () => {
    expect(scanSessionDirs(join(directory, "missing"))).toEqual([]);
  });
});

describe("retention selection", () => {
  const now = 1_700_000_000_000;
  const day = 86_400_000;
  const dirs = [
    { path: "new", name: "new", mtimeMs: now - day },
    { path: "middle", name: "middle", mtimeMs: now - 10 * day },
    { path: "old", name: "old", mtimeMs: now - 40 * day },
  ];

  test("removes sessions past the age limit but keeps protected ones", () => {
    const removals = selectSessionsForRemoval(
      dirs,
      { sessionMaxAgeDays: 30, sessionKeepPerProject: 0 },
      new Set(),
      now,
    );
    expect(removals).toEqual([{ path: "old", name: "old", reason: "age" }]);

    expect(
      selectSessionsForRemoval(
        dirs,
        { sessionMaxAgeDays: 30, sessionKeepPerProject: 0 },
        new Set(["old"]),
        now,
      ),
    ).toEqual([]);
  });

  test("keeps the newest N and protects queued sessions", () => {
    expect(
      selectSessionsForRemoval(
        dirs,
        { sessionMaxAgeDays: 0, sessionKeepPerProject: 1 },
        new Set(),
        now,
      ).map((entry) => entry.name),
    ).toEqual(["middle", "old"]);

    expect(
      selectSessionsForRemoval(
        dirs,
        { sessionMaxAgeDays: 0, sessionKeepPerProject: 1 },
        new Set(["old"]),
        now,
      ).map((entry) => entry.name),
    ).toEqual(["middle"]);
  });

  test("does nothing when both rules are disabled", () => {
    expect(
      selectSessionsForRemoval(
        dirs,
        { sessionMaxAgeDays: 0, sessionKeepPerProject: 0 },
        new Set(),
        now,
      ),
    ).toEqual([]);
  });
});
