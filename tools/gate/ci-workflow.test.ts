import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(
  join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml"),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

describe("CI workflow", () => {
  test("enforces the same thresholds as bun run check", () => {
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run typecheck");
    expect(workflow).toContain("bun test");
  });

  test("pins Bun and caches the install directory", () => {
    expect(workflow).toContain("bun-version: 1.4.4");
    expect(workflow).toContain("~/.bun/install/cache");
  });

  test("bun run check chains typecheck and tests", () => {
    expect(rootPackage.scripts?.["typecheck"]).toContain("--noEmit");
    expect(rootPackage.scripts?.["check"]).toBe("bun run typecheck && bun test");
  });
});
