import { describe, expect, test } from "bun:test";

import {
  MAX_TASK_MODEL_LENGTH,
  isTaskUsage,
  parseTaskUsageJson,
  taskUsageErrors,
} from "./index";

const VALID = {
  input_tokens: 120,
  output_tokens: 30,
  cache_read_tokens: 10,
  cache_write_tokens: 5,
  total_tokens: 165,
  cost_usd: 0.0042,
};

describe("task usage sidecar", () => {
  test("accepts non-negative integer counters and a finite cost", () => {
    expect(taskUsageErrors(VALID)).toEqual([]);
    expect(isTaskUsage(VALID)).toBe(true);
    expect(parseTaskUsageJson(JSON.stringify(VALID))).toEqual(VALID);
  });

  test("accepts zero usage", () => {
    expect(
      isTaskUsage({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
      }),
    ).toBe(true);
  });

  test("accepts an optional model label", () => {
    const withModel = { ...VALID, model: "gateway/deepseek-flash" };
    expect(taskUsageErrors(withModel)).toEqual([]);
    expect(parseTaskUsageJson(JSON.stringify(withModel))).toEqual(withModel);
  });

  test("rejects malformed model labels", () => {
    for (const model of ["", "   ", "gateway/line\nbreak", "x".repeat(MAX_TASK_MODEL_LENGTH + 1)]) {
      expect(taskUsageErrors({ ...VALID, model }).join()).toContain("model");
    }
  });

  test("rejects negative, fractional and non-finite counters", () => {
    expect(taskUsageErrors({ ...VALID, input_tokens: -1 }).join()).toContain(
      "input_tokens",
    );
    expect(taskUsageErrors({ ...VALID, output_tokens: 1.5 }).join()).toContain(
      "output_tokens",
    );
    expect(taskUsageErrors({ ...VALID, cost_usd: Number.NaN }).join()).toContain(
      "cost_usd",
    );
    expect(taskUsageErrors({ ...VALID, cost_usd: -0.01 }).join()).toContain("cost_usd");
  });

  test("rejects malformed documents and missing fields", () => {
    expect(taskUsageErrors(null).join()).toContain("object");
    expect(taskUsageErrors([]).join()).toContain("object");
    expect(taskUsageErrors({}).join()).toContain("total_tokens");
    expect(parseTaskUsageJson("not json")).toBeNull();
    expect(parseTaskUsageJson(JSON.stringify({ ...VALID, total_tokens: "1" }))).toBeNull();
  });
});
