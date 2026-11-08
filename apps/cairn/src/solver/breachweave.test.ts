import { describe, expect, test } from "bun:test";

import { modelLabel, ssrfMarkerFields, workerDeadlineEnvironment } from "./breachweave";

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

describe("worker deadline environment", () => {
  test("exports absolute soft and hard deadlines and the bash ceiling", () => {
    expect(
      workerDeadlineEnvironment(
        { hardDeadlineSeconds: 60, softDeadlineSeconds: 48, bashTimeoutSeconds: 45 },
        1_000,
      ),
    ).toEqual({
      CAIRN_TASK_HARD_DEADLINE_MS: "61000",
      CAIRN_TASK_SOFT_DEADLINE_MS: "49000",
      CAIRN_BASH_TIMEOUT_SECONDS: "45",
    });
  });

  test("clears absent values so a previous task cannot leak them", () => {
    // A null tells the caller to delete the variable: a prior task's deadline or ceiling
    // must not survive into this one through the process environment.
    expect(workerDeadlineEnvironment({ hardDeadlineSeconds: 30 }, 0)).toEqual({
      CAIRN_TASK_HARD_DEADLINE_MS: "30000",
      CAIRN_TASK_SOFT_DEADLINE_MS: null,
      CAIRN_BASH_TIMEOUT_SECONDS: null,
    });
  });
});
