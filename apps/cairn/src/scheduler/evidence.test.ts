import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectEvidence, verifyEvidenceFiles } from "./evidence";

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

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("evidence collection", () => {
  test("treats absent and empty refs as missing", () => {
    expect(collectEvidence(undefined, workspace)).toEqual({
      status: "missing",
      refs: [],
      files: [],
      invalid: [],
    });
    expect(collectEvidence([], workspace)).toEqual({
      status: "missing",
      refs: [],
      files: [],
      invalid: [],
    });
  });

  test("accepts regular files inside the workspace and records their digests", () => {
    const collected = collectEvidence(
      ["artifacts/scan.log", "./artifacts/nested/dump.txt", "artifacts\\scan.log"],
      workspace,
    );
    expect(collected).toEqual({
      status: "provided",
      refs: ["artifacts/scan.log", "artifacts/nested/dump.txt"],
      files: [
        {
          path: "artifacts/scan.log",
          size: 15,
          sha256: sha("open port 8080\n"),
        },
        {
          path: "artifacts/nested/dump.txt",
          size: 5,
          sha256: sha("dump\n"),
        },
      ],
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

  test("rejects zero-byte evidence by default", () => {
    writeFileSync(join(workspace, "artifacts", "empty.txt"), "", "utf8");
    expect(collectEvidence(["artifacts/empty.txt"], workspace)).toEqual({
      status: "missing",
      refs: [],
      files: [],
      invalid: [
        {
          ref: "artifacts/empty.txt",
          reason: "file is smaller than the minimum evidence size (1 byte)",
        },
      ],
    });
  });

  test("honours a configured minimum and allows disabling it", () => {
    writeFileSync(join(workspace, "artifacts", "empty.txt"), "", "utf8");
    const rejected = collectEvidence(
      ["artifacts/empty.txt", "artifacts/nested/dump.txt", "artifacts/scan.log"],
      workspace,
      { minBytes: 6 },
    );
    expect(rejected.status).toBe("provided");
    expect(rejected.refs).toEqual(["artifacts/scan.log"]);
    expect(rejected.invalid).toEqual([
      {
        ref: "artifacts/empty.txt",
        reason: "file is smaller than the minimum evidence size (6 bytes)",
      },
      {
        ref: "artifacts/nested/dump.txt",
        reason: "file is smaller than the minimum evidence size (6 bytes)",
      },
    ]);

    const disabled = collectEvidence(["artifacts/empty.txt"], workspace, { minBytes: 0 });
    expect(disabled.status).toBe("provided");
    expect(disabled.files).toEqual([
      { path: "artifacts/empty.txt", size: 0, sha256: sha("") },
    ]);
  });
});

describe("evidence verification", () => {
  test("compares stored digests with the current files", () => {
    const collected = collectEvidence(
      ["artifacts/scan.log", "artifacts/nested/dump.txt"],
      workspace,
    );
    const stored = collected.files.map((file) => ({
      ...file,
      created_at: "2026-01-01T00:00:00Z",
    }));
    expect(
      verifyEvidenceFiles(stored, workspace).map((entry) => entry.status),
    ).toEqual(["ok", "ok"]);

    writeFileSync(join(workspace, "artifacts", "scan.log"), "tampered\n", "utf8");
    rmSync(join(workspace, "artifacts", "nested", "dump.txt"));
    const verified = verifyEvidenceFiles(stored, workspace);
    expect(verified.map((entry) => entry.status)).toEqual(["modified", "missing"]);
    expect(verified[0]).toMatchObject({
      path: "artifacts/scan.log",
      size: 15,
      sha256: sha("open port 8080\n"),
      current_size: 9,
      current_sha256: sha("tampered\n"),
    });
    expect(verified[1]).toMatchObject({
      status: "missing",
      current_size: null,
      current_sha256: null,
    });
  });

  test("reports invalid paths and unreadable workspaces", () => {
    const collected = collectEvidence(["artifacts/scan.log"], workspace);
    const stored = collected.files.map((file) => ({
      ...file,
      created_at: "2026-01-01T00:00:00Z",
    }));

    rmSync(join(workspace, "artifacts", "scan.log"));
    mkdirSync(join(workspace, "artifacts", "scan.log"));
    expect(verifyEvidenceFiles(stored, workspace)[0]!.status).toBe("invalid");

    expect(
      verifyEvidenceFiles(stored, join(directory, "missing-workspace")).map(
        (entry) => entry.status,
      ),
    ).toEqual(["unreadable"]);
  });
});
