import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_TASK_USAGE_BYTES, TASK_USAGE_FILE } from "@cairn/contracts";

import { readTaskUsage } from "./usage";

const VALID = {
  input_tokens: 12,
  output_tokens: 3,
  cache_read_tokens: 1,
  cache_write_tokens: 0,
  total_tokens: 16,
  cost_usd: 0.001,
};

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-usage-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("worker usage sidecar", () => {
  test("reads a valid usage file", () => {
    writeFileSync(join(directory, TASK_USAGE_FILE), JSON.stringify(VALID), "utf8");
    expect(readTaskUsage(directory)).toEqual(VALID);
  });

  test("treats a missing file as no usage", () => {
    expect(readTaskUsage(directory)).toBeNull();
  });

  test("rejects malformed and invalid documents", () => {
    writeFileSync(join(directory, TASK_USAGE_FILE), "not json", "utf8");
    expect(readTaskUsage(directory)).toBeNull();

    writeFileSync(
      join(directory, TASK_USAGE_FILE),
      JSON.stringify({ ...VALID, total_tokens: -1 }),
      "utf8",
    );
    expect(readTaskUsage(directory)).toBeNull();
  });

  test("rejects an oversized sidecar", () => {
    writeFileSync(
      join(directory, TASK_USAGE_FILE),
      " ".repeat(MAX_TASK_USAGE_BYTES + 1),
      "utf8",
    );
    expect(readTaskUsage(directory)).toBeNull();
  });

  test("rejects a directory named like the sidecar", () => {
    mkdirSync(join(directory, TASK_USAGE_FILE));
    expect(readTaskUsage(directory)).toBeNull();
  });
});
