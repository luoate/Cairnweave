import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectEvidence } from "./evidence";

let directory: string;
let workspace: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-evidence-"));
  workspace = join(directory, "workspace");
  mkdirSync(join(workspace, "artifacts", "nested"), { recursive: true });
  writeFileSync(join(workspace, "artifacts", "scan.log"), "open port 8080\n", "utf8");
  writeFileSync(join(workspace, "artifacts", "nested", "dump.txt"), "dump\n", "utf8");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("evidence collection", () => {
  test("treats absent and empty refs as missing", () => {
    expect(collectEvidence(undefined, workspace)).toEqual({
      status: "missing",
      refs: [],
      invalid: [],
    });
    expect(collectEvidence([], workspace)).toEqual({
      status: "missing",
      refs: [],
      invalid: [],
    });
  });

  test("accepts regular files inside the workspace", () => {
    const collected = collectEvidence(
      ["artifacts/scan.log", "./artifacts/nested/dump.txt", "artifacts\\scan.log"],
      workspace,
    );
    expect(collected).toEqual({
      status: "provided",
      refs: ["artifacts/scan.log", "artifacts/nested/dump.txt"],
      invalid: [],
    });
  });

  test("rejects absolute paths and parent traversal", () => {
    const outside = join(directory, "outside.txt");
    writeFileSync(outside, "secret", "utf8");
    const collected = collectEvidence(
      [outside, "../outside.txt", "artifacts/../../outside.txt"],
      workspace,
    );
    expect(collected.status).toBe("missing");
    expect(collected.invalid.map((issue) => issue.reason)).toEqual([
      "path must be relative to the workspace",
      "path escapes the workspace",
      "path escapes the workspace",
    ]);
  });

  test("rejects missing files and directories", () => {
    const collected = collectEvidence(["artifacts/nope.log", "artifacts"], workspace);
    expect(collected.invalid.map((issue) => issue.reason)).toEqual([
      "file does not exist",
      "evidence must be a regular file",
    ]);
  });

  test("rejects a symlink and a symlinked parent that escapes the workspace", () => {
    const outsideDir = join(directory, "outside");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "secret.txt"), "secret", "utf8");
    try {
      symlinkSync(join(outsideDir, "secret.txt"), join(workspace, "artifacts", "link.log"));
      symlinkSync(outsideDir, join(workspace, "artifacts", "linked"));
    } catch {
      // Windows without developer mode cannot create symlinks; the check is still
      // exercised on POSIX and on privileged Windows runners.
      return;
    }

    const collected = collectEvidence(
      ["artifacts/link.log", "artifacts/linked/secret.txt"],
      workspace,
    );
    expect(collected.invalid.map((issue) => issue.reason)).toEqual([
      "symlinks are not accepted as evidence",
      "resolved path escapes the workspace",
    ]);
  });

  test("caps the number of refs", () => {
    const refs = Array.from({ length: 21 }, (_, index) => `artifacts/f${index}.txt`);
    const collected = collectEvidence(refs, workspace);
    expect(collected.invalid).toEqual([
      { ref: "", reason: "too many evidence refs (max 20)" },
    ]);
  });
});
