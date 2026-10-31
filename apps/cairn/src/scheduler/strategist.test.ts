import { describe, expect, test } from "bun:test";

import type {
  Intent,
  ProjectDetail,
  StrategistRunSummary,
  StrategistState,
} from "@cairn/graph";

import { DEFAULT_STRATEGIST, type StrategistConfig } from "../config";
import {
  countZeroOutputStreak,
  evaluateStrategistTrigger,
  type EvaluateStrategistInput,
} from "./strategist";

const NOW = new Date("2026-01-01T00:10:00Z");

function at(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
}

function project(overrides: {
  facts?: number;
  hints?: number;
  intents?: Partial<Intent>[];
} = {}): ProjectDetail {
  return {
    project: {
      id: "p1",
      title: "strategist",
      status: "active",
      bootstrap_enabled: false,
      created_at: "2026-01-01T00:00:00Z",
      reason: null,
    },
    facts: Array.from({ length: overrides.facts ?? 2 }, (_value, index) => ({
      id: index === 0 ? "origin" : index === 1 ? "goal" : `f${index}`,
      description: `fact ${index}`,
    })),
    intents: (overrides.intents ?? []).map((intent, index) => ({
      id: intent.id ?? `i${index + 1}`,
      from: intent.from ?? ["origin"],
      to: intent.to ?? null,
      description: intent.description ?? `intent ${index + 1}`,
      creator: intent.creator ?? "reason",
      worker: intent.worker ?? null,
      last_heartbeat_at: intent.last_heartbeat_at ?? null,
      created_at: intent.created_at ?? at(60),
      concluded_at: intent.concluded_at ?? null,
    })),
    hints: Array.from({ length: overrides.hints ?? 0 }, (_value, index) => ({
      id: `h${index + 1}`,
      content: `hint ${index + 1}`,
      creator: "human",
      created_at: "2026-01-01T00:00:00Z",
    })),
  };
}

function state(overrides: Partial<StrategistState> = {}): StrategistState {
  return {
    project_id: "p1",
    last_success_at: at(60),
    last_attempt_at: at(60),
    last_failure_at: null,
    last_trigger: "initial",
    last_run_id: "r1",
    last_fact_count: 2,
    last_hint_count: 0,
    last_open_intent_count: 0,
    replan_requested_at: null,
    replan_requested_by: null,
    replan_reason: null,
    updated_at: at(60),
    ...overrides,
  };
}

function run(
  id: string,
  finishedAgo: number,
  producedFact: boolean,
): StrategistRunSummary {
  return {
    id,
    kind: "explore",
    outcome: producedFact ? "success" : "failed",
    started_at: at(finishedAgo + 1),
    finished_at: at(finishedAgo),
    produced_fact: producedFact,
  };
}

function evaluate(
  overrides: Omit<Partial<EvaluateStrategistInput>, "policy"> & {
    policy?: Partial<StrategistConfig>;
  } = {},
) {
  const { policy, ...rest } = overrides;
  return evaluateStrategistTrigger({
    project: project(),
    state: state(),
    recentRuns: [],
    reasonRunsLastHour: 0,
    runningProductiveTasks: 0,
    runningIntentIds: new Set(),
    now: NOW,
    policy: { ...DEFAULT_STRATEGIST, ...policy },
    ...rest,
  });
}

describe("Strategist trigger policy", () => {
  test("runs initially when no watermark exists", () => {
    const result = evaluate({ state: null });
    expect(result).toMatchObject({
      trigger: "initial",
      urgent: true,
      suppressed: null,
    });
  });

  test("lets the fast layer drain claimable intents before the initial turn", () => {
    expect(
      evaluate({
        state: null,
        project: project({ intents: [{ worker: null }] }),
      }).trigger,
    ).toBeNull();

    // An intent claimed by another worker is not dispatcher work; reason may still run.
    expect(
      evaluate({
        state: null,
        project: project({ intents: [{ worker: "other-worker" }] }),
      }).trigger,
    ).toBe("initial");

    // A leftover bootstrap direction is not dispatchable when bootstrap is disabled.
    expect(
      evaluate({
        state: null,
        project: project({
          intents: [
            {
              worker: null,
              description: "bootstrap",
              creator: "dispatcher.bootstrap",
            },
          ],
        }),
      }).trigger,
    ).toBe("initial");

    // Even the urgent initial turn waits for a settled graph.
    expect(
      evaluate({ state: null, runningProductiveTasks: 1 }),
    ).toMatchObject({ trigger: null, suppressed: "tasks_running" });
  });

  test("runs an operator replan urgently even when fast work is pending", () => {
    expect(
      evaluate({
        project: project({ intents: [{ worker: null }] }),
        state: state({ replan_requested_at: at(5) }),
        reasonRunsLastHour: 12,
        policy: { cooldownSeconds: 30, maxRunsPerHour: 12 },
      }),
    ).toMatchObject({ trigger: "manual_replan", urgent: true });

    // The request never overrides a settled-graph or failure-backoff guard.
    expect(
      evaluate({
        state: state({ replan_requested_at: at(5) }),
        runningProductiveTasks: 1,
      }),
    ).toMatchObject({ trigger: null, suppressed: "tasks_running" });
    expect(
      evaluate({
        state: state({
          replan_requested_at: at(5),
          last_failure_at: at(10),
        }),
        policy: { failureBackoffSeconds: 120 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "failure_backoff" });
  });

  test("does nothing when the graph is unchanged", () => {
    expect(evaluate()).toMatchObject({
      trigger: null,
      suppressed: null,
      factsDelta: 0,
      hintsDelta: 0,
    });
  });

  test("waits for the configured fact or hint delta", () => {
    const threeFacts = project({ facts: 3 });
    expect(
      evaluate({
        project: threeFacts,
        policy: { minNewFacts: 2 },
      }).trigger,
    ).toBeNull();
    expect(
      evaluate({
        project: project({ facts: 4 }),
        policy: { minNewFacts: 2 },
      }).trigger,
    ).toBe("facts:2->4");

    expect(
      evaluate({
        project: project({ facts: 3, hints: 1 }),
        state: state({ last_hint_count: 0 }),
      }).trigger,
    ).toBe("facts:2->3,hints:0->1");
  });

  test("treats an empty intent list as urgent only after draining open work", () => {
    const empty = project();
    expect(
      evaluate({
        project: empty,
        state: state({ last_open_intent_count: 2 }),
      }),
    ).toMatchObject({
      trigger: "open_intents:2->0",
      urgent: true,
    });

    // A just-finished no-op reason produced no intents and no new activity: do not loop.
    expect(
      evaluate({
        project: empty,
        state: state({ last_open_intent_count: 0, last_attempt_at: at(60) }),
      }).trigger,
    ).toBeNull();

    // New facts still reach the slow layer through the normal graph-delta trigger.
    expect(
      evaluate({
        project: project({ facts: 3 }),
        state: state({ last_open_intent_count: 0 }),
      }).trigger,
    ).toBe("facts:2->3");
  });

  test("applies cooldown to normal triggers but not urgent ones", () => {
    const changed = project({ facts: 3 });
    expect(
      evaluate({
        project: changed,
        state: state({ last_attempt_at: at(10) }),
        policy: { cooldownSeconds: 30 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "cooldown" });

    expect(
      evaluate({
        project: changed,
        state: state({
          last_attempt_at: at(10),
          last_open_intent_count: 1,
        }),
        policy: { cooldownSeconds: 30 },
      }),
    ).toMatchObject({ trigger: "open_intents:1->0", urgent: true });
  });

  test("holds back every trigger during failure backoff", () => {
    expect(
      evaluate({
        state: state({ last_failure_at: at(10) }),
        policy: { failureBackoffSeconds: 120 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "failure_backoff" });

    expect(
      evaluate({
        state: state({ last_failure_at: at(200) }),
        policy: { failureBackoffSeconds: 120 },
      }).trigger,
    ).toBeNull();

    expect(
      evaluate({
        project: project({ facts: 3 }),
        state: state({ last_failure_at: at(200) }),
        policy: { failureBackoffSeconds: 120 },
      }).trigger,
    ).toBe("facts:2->3");
  });

  test("caps normal triggers per hour but still allows urgent completion", () => {
    const changed = project({ facts: 3 });
    expect(
      evaluate({
        project: changed,
        reasonRunsLastHour: 12,
        policy: { maxRunsPerHour: 12 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "rate_limit" });

    expect(
      evaluate({
        reasonRunsLastHour: 12,
        state: state({ last_open_intent_count: 1 }),
        policy: { maxRunsPerHour: 12 },
      }),
    ).toMatchObject({ trigger: "open_intents:1->0", urgent: true });
  });

  test("triggers after a zero-output streak since the last success", () => {
    const failed = [
      run("r3", 2, false),
      run("r2", 4, false),
      run("r1", 6, false),
    ];
    expect(
      evaluate({
        state: state({ last_attempt_at: at(60), last_success_at: at(60) }),
        recentRuns: failed,
        policy: { zeroOutputThreshold: 3, cooldownSeconds: 0 },
      }).trigger,
    ).toBe("zero_output:3");

    // A productive run resets the streak.
    expect(
      evaluate({
        recentRuns: [run("r4", 1, true), ...failed],
        policy: { zeroOutputThreshold: 3, cooldownSeconds: 0 },
      }).trigger,
    ).toBeNull();

    // Runs that predate the last successful reason turn do not count again.
    expect(
      evaluate({
        state: state({
          last_success_at: at(1),
          last_attempt_at: at(1),
        }),
        recentRuns: failed,
        policy: { zeroOutputThreshold: 3, cooldownSeconds: 0 },
      }).trigger,
    ).toBeNull();

    // While another productive task is running, wait for a settled graph.
    expect(
      evaluate({
        recentRuns: failed,
        runningProductiveTasks: 1,
        policy: { zeroOutputThreshold: 3, cooldownSeconds: 0 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "tasks_running" });
  });

  test("triggers when every open intent is stale and nothing is running", () => {
    const stale = project({
      intents: [{ created_at: at(3600) }, { created_at: at(7200) }],
    });
    expect(
      evaluate({
        project: stale,
        state: state({ last_open_intent_count: 2 }),
        policy: { staleIntentSeconds: 600, cooldownSeconds: 0 },
      }).trigger,
    ).toBe("stale_intents:2");

    expect(
      evaluate({
        project: project({
          intents: [{ created_at: at(3600) }, { created_at: at(10) }],
        }),
        policy: { staleIntentSeconds: 600, cooldownSeconds: 0 },
      }).trigger,
    ).toBeNull();

    const runningIds = new Set(["i1"]);
    expect(
      evaluate({
        project: stale,
        runningIntentIds: runningIds,
        policy: { staleIntentSeconds: 600, cooldownSeconds: 0 },
      }).trigger,
    ).toBeNull();
  });

  test("uses a fallback interval only when configured and idle", () => {
    expect(
      evaluate({
        state: state({ last_success_at: at(1800), last_attempt_at: at(1800) }),
        policy: { fallbackIntervalSeconds: 900, cooldownSeconds: 0 },
      }).trigger,
    ).toBe("fallback:1800s");

    expect(
      evaluate({
        state: state({ last_success_at: at(1800), last_attempt_at: at(1800) }),
        runningProductiveTasks: 1,
        policy: { fallbackIntervalSeconds: 900, cooldownSeconds: 0 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "tasks_running" });
  });

  test("waits while another productive task is running", () => {
    expect(
      evaluate({
        project: project({ facts: 3 }),
        runningProductiveTasks: 1,
        policy: { cooldownSeconds: 0 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "tasks_running" });
  });

  test("abandoned intents are not open work", () => {
    const evaluation = evaluate({
      project: project({ intents: [{ id: "i1" }, { id: "i2" }] }),
      state: state({ last_open_intent_count: 2 }),
      abandonedIntentIds: new Set(["i1"]),
      policy: { cooldownSeconds: 0 },
    });
    expect(evaluation.openIntentCount).toBe(1);
  });
});

describe("resource pressure", () => {
  function budget(overrides: Partial<{
    usedTokens: number;
    usedCostUsd: number;
    maxTokens: number;
    maxCostUsd: number;
  }> = {}) {
    return {
      usedTokens: 800,
      usedCostUsd: 2,
      maxTokens: 1000,
      maxCostUsd: 10,
      ...overrides,
    };
  }

  test("is disabled by default and stays quiet below the threshold", () => {
    expect(evaluate({ budget: budget() }).trigger).toBeNull();
    expect(
      evaluate({
        budget: budget({ usedTokens: 799 }),
        policy: { resourcePressureRatio: 0.8 },
      }).trigger,
    ).toBeNull();
  });

  test("triggers once usage crosses the configured fraction", () => {
    expect(
      evaluate({
        budget: budget(),
        policy: { resourcePressureRatio: 0.8 },
      }),
    ).toMatchObject({
      trigger: "resource_pressure:tokens:80%",
      urgent: false,
    });
  });

  test("reports both token and cost dimensions", () => {
    expect(
      evaluate({
        budget: budget({ usedTokens: 900, usedCostUsd: 9 }),
        policy: { resourcePressureRatio: 0.75 },
      }).trigger,
    ).toBe("resource_pressure:tokens:90%,cost_usd:90%");
  });

  test("ignores unlimited dimensions", () => {
    expect(
      evaluate({
        budget: budget({ maxTokens: 0 }),
        policy: { resourcePressureRatio: 0.8 },
      }).trigger,
    ).toBeNull();
  });

  test("does not repeat during the same pressure episode", () => {
    expect(
      evaluate({
        budget: budget({ usedTokens: 950 }),
        state: state({ last_trigger: "resource_pressure:tokens:80%" }),
        policy: { resourcePressureRatio: 0.8 },
      }).trigger,
    ).toBeNull();
  });

  test("is a normal trigger subject to cooldown and running tasks", () => {
    expect(
      evaluate({
        budget: budget(),
        state: state({ last_attempt_at: at(10) }),
        policy: { resourcePressureRatio: 0.8, cooldownSeconds: 30 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "cooldown" });
    expect(
      evaluate({
        budget: budget(),
        runningProductiveTasks: 1,
        policy: { resourcePressureRatio: 0.8 },
      }),
    ).toMatchObject({ trigger: null, suppressed: "tasks_running" });
  });
});

describe("zero-output streak helper", () => {
  test("stops at a productive run or the success watermark", () => {
    expect(
      countZeroOutputStreak(
        [run("a", 2, false), run("b", 4, false), run("c", 6, true)],
        null,
      ),
    ).toBe(2);
    expect(countZeroOutputStreak([run("a", 2, false)], at(5))).toBe(1);
    expect(countZeroOutputStreak([run("a", 10, false)], at(5))).toBe(0);
  });
});
