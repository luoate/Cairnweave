import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { latestSolverSessionFile, SOLVER_SESSION_DIR } from "./session-file";

describe("latestSolverSessionFile", () => {
  test("returns null when the task wrote no session", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-session-file-"));
    try {
      expect(latestSolverSessionFile(root)).toBeNull();
      mkdirSync(join(root, SOLVER_SESSION_DIR), { recursive: true });
      expect(latestSolverSessionFile(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("picks the newest jsonl and ignores other files", async () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-session-file-"));
    try {
      const dir = join(root, SOLVER_SESSION_DIR);
      mkdirSync(dir, { recursive: true });
      const older = join(dir, "older.jsonl");
      const newer = join(dir, "newer.jsonl");
      writeFileSync(older, "{}\n", "utf8");
      await Bun.sleep(20);
      writeFileSync(newer, "{}\n", "utf8");
      writeFileSync(join(dir, "notes.txt"), "ignored", "utf8");
      expect(latestSolverSessionFile(root)).toBe(newer);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
