import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_WRITEUP_PAYLOAD_CHARS } from "@cairn/graph";

import { collectWriteupPayloads } from "./project-payload";

const TASK = "explore-1a2b3c4d5e6f";

let directory: string;
let workspace: string;
let artifacts: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-payload-"));
  workspace = join(directory, "project");
  artifacts = join(workspace, "artifacts");
  mkdirSync(artifacts, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(relativePath: string, content: string | Buffer): void {
  const target = join(artifacts, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function scan(paths: readonly string[]) {
  return collectWriteupPayloads({ workspace, artifacts: paths.map((path) => ({ path })) });
}

describe("collectWriteupPayloads", () => {
  test("inlines the selected paths and marks binary content", () => {
    write(`${TASK}/forge.py`, "print('payload')\n");
    write(`${TASK}/blob.zip`, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]));

    expect(scan([`${TASK}/forge.py`, `${TASK}/blob.zip`])).toEqual([
      {
        path: `${TASK}/forge.py`,
        binary: false,
        text: "print('payload')\n",
        truncated: false,
      },
      { path: `${TASK}/blob.zip`, binary: true, text: null, truncated: false },
    ]);
  });

  test("trims inline text to the cap and flags it", () => {
    write(`${TASK}/long_payload.txt`, `${"A".repeat(MAX_WRITEUP_PAYLOAD_CHARS + 500)}\n`);

    const [payload] = scan([`${TASK}/long_payload.txt`]);
    expect(payload?.text).toHaveLength(MAX_WRITEUP_PAYLOAD_CHARS);
    expect(payload?.truncated).toBe(true);
  });

  test("omits files it cannot read", () => {
    write("../../outside.py", "print('outside')\n");
    write(`${TASK}/huge_script.py`, "A".repeat(200 * 1024));
    write(`${TASK}/gone.py`, "print('gone')\n");
    rmSync(join(artifacts, TASK, "gone.py"));

    expect(
      scan([
        "../../outside.py",
        `${TASK}/huge_script.py`,
        `${TASK}/gone.py`,
        "/etc/passwd",
        `${TASK}/../secret.py`,
      ]),
    ).toEqual([]);
  });

  test("answers with nothing when the workspace has no artifacts directory", () => {
    rmSync(artifacts, { recursive: true, force: true });
    expect(scan([`${TASK}/forge.py`])).toEqual([]);
  });
});
