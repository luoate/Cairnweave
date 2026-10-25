import { describe, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { map, renderYaml } from "./yaml";

interface ScalarCase {
  value: string;
  yaml: string;
}

const cases = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "testdata", "scalars.golden.json"), "utf8"),
) as ScalarCase[];

describe("scalar emission parity with PyYAML", () => {
  test("matches every corpus case", () => {
    for (const item of cases) {
      const actual = renderYaml(map([["v", item.value]]));
      if (actual !== item.yaml) {
        throw new Error(
          `mismatch for ${JSON.stringify(item.value)}\n` +
            `--- actual ---\n${JSON.stringify(actual)}\n` +
            `--- expected ---\n${JSON.stringify(item.yaml)}`,
        );
      }
    }
  });
});
