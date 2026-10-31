import { describe, expect, test } from "bun:test";

import { modelLabel, ssrfMarkerFields } from "./breachweave";

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

describe("worker SSRF marker fields", () => {
  test("adds nothing when the scheduler sent no policy", () => {
    expect(ssrfMarkerFields({})).toEqual({});
    expect(
      ssrfMarkerFields({ CAIRN_SSRF_POLICY: "  ", CAIRN_SSRF_PROTECTED_HOSTS: "," }),
    ).toEqual({});
  });

  test("carries the marker mode and protected hosts into the scope policy", () => {
    expect(
      ssrfMarkerFields({
        CAIRN_SSRF_POLICY: "block",
        CAIRN_SSRF_PROTECTED_HOSTS: " host.test , cairn-control.internal ,",
      }),
    ).toEqual({
      ssrfMarkers: "block",
      protectedHosts: ["host.test", "cairn-control.internal"],
    });
  });

  test("passes an unrecognized mode through for the policy parser to refuse", () => {
    expect(ssrfMarkerFields({ CAIRN_SSRF_POLICY: "watch" })).toEqual({
      ssrfMarkers: "watch",
    });
  });
});
