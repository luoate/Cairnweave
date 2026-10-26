import { describe, expect, test } from "bun:test";

import type { ProfileRunStats } from "@cairn/graph";

import type { WorkerProfileConfig, WorkerSelectionConfig } from "../config";
import { selectWorkerProfile } from "./selection";

const PROFILES: WorkerProfileConfig[] = [
  { id: "fast", model: "cairn-worker" },
  { id: "deep", model: "deep-reasoner" },
];

const STATS_MODE: WorkerSelectionConfig = { mode: "stats", minRuns: 2 };
const PROMPT_MODE: WorkerSelectionConfig = { mode: "prompt", minRuns: 2 };

function group(
  worker_profile: string,
  overrides: Partial<ProfileRunStats> = {},
): ProfileRunStats {
  return {
    worker_profile,
    runs: 0,
    running: 0,
    finished: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    cancelled: 0,
    unhealthy: 0,
    inactive: 0,
    success_rate: null,
    tokens: 0,
    cost_usd: 0,
    avg_duration_ms: null,
    evidence_count: 0,
    last_started_at: null,
    ...overrides,
  };
}

describe("worker profile selection", () => {
  test("stays out of the way in prompt mode or without profiles", () => {
    expect(selectWorkerProfile(PROFILES, PROMPT_MODE, [], "fast")).toBeNull();
    expect(
      selectWorkerProfile(PROFILES, PROMPT_MODE, [group("fast")], "fast"),
    ).toBeNull();
    expect(selectWorkerProfile([], STATS_MODE, [])).toBeNull();
  });

  test("samples under-observed profiles in config order before exploiting", () => {
    // Both are under min_runs; config order wins even though `deep` has a better rate.
    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [
        group("fast", { finished: 1, succeeded: 0, success_rate: 0 }),
        group("deep", { finished: 1, succeeded: 1, success_rate: 1 }),
      ]),
    ).toMatchObject({ id: "fast" });

    // `fast` reached min_runs, so the remaining rookie is explored next.
    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [
        group("fast", { finished: 2, succeeded: 0, success_rate: 0 }),
        group("deep", { finished: 1, succeeded: 1, success_rate: 1 }),
      ]),
    ).toMatchObject({ id: "deep" });
  });

  test("exploits the highest success rate once every profile is sampled", () => {
    const selected = selectWorkerProfile(PROFILES, STATS_MODE, [
      group("fast", { finished: 4, succeeded: 2, success_rate: 0.5 }),
      group("deep", { finished: 3, succeeded: 3, success_rate: 1 }),
    ]);
    expect(selected?.id).toBe("deep");
  });

  test("breaks success-rate ties by tokens, then cost, then config order", () => {
    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [
        group("fast", {
          finished: 2,
          succeeded: 2,
          success_rate: 1,
          tokens: 100,
        }),
        group("deep", {
          finished: 2,
          succeeded: 2,
          success_rate: 1,
          tokens: 80,
        }),
      ]),
    ).toMatchObject({ id: "deep" });

    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [
        group("fast", {
          finished: 2,
          succeeded: 2,
          success_rate: 1,
          tokens: 100,
          cost_usd: 0.2,
        }),
        group("deep", {
          finished: 2,
          succeeded: 2,
          success_rate: 1,
          tokens: 100,
          cost_usd: 0.1,
        }),
      ]),
    ).toMatchObject({ id: "deep" });

    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [
        group("fast", {
          finished: 2,
          succeeded: 2,
          success_rate: 1,
          tokens: 100,
          cost_usd: 0.1,
        }),
        group("deep", {
          finished: 2,
          succeeded: 2,
          success_rate: 1,
          tokens: 100,
          cost_usd: 0.1,
        }),
      ]),
    ).toMatchObject({ id: "fast" });
  });

  test("reuses a preferred profile and falls back when it was removed", () => {
    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [], "deep"),
    ).toMatchObject({ id: "deep", model: "deep-reasoner" });
    expect(
      selectWorkerProfile(PROFILES, STATS_MODE, [], "removed"),
    ).toMatchObject({ id: "fast" });
  });
});
