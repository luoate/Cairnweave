import { describe, expect, test } from "bun:test";

import { modelLabel } from "./breachweave";

describe("solver model label", () => {
  test("formats provider and model id", () => {
    expect(modelLabel({ provider: "gateway", id: "deepseek-flash" })).toBe(
      "gateway/deepseek-flash",
    );
  });

  test("falls back to the model id when the provider is missing", () => {
    expect(modelLabel({ id: "deepseek-flash" })).toBe("deepseek-flash");
  });

  test("returns null when no model has been resolved", () => {
    expect(modelLabel(undefined)).toBeNull();
    expect(modelLabel({})).toBeNull();
    expect(modelLabel({ provider: "gateway", id: "  " })).toBeNull();
  });

  test("trims provider and model id", () => {
    expect(modelLabel({ provider: " gateway ", id: " deepseek-flash " })).toBe(
      "gateway/deepseek-flash",
    );
  });
});
