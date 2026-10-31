import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  getRuntimeConfigOverrides,
  type CairnDatabase,
} from "@cairn/graph";

import {
  parseDispatchConfig,
  parseRuntimeOverridePatch,
  type DispatchConfig,
} from "./config";
import { RuntimeConfigStore, mergeOverrideDocuments, overridePaths } from "./config-overrides";

const SOURCE = `server: "http://127.0.0.1:8000"
runtime:
  execution: local
  interval: 3
  max_workers: 4
  max_running_projects: 2
  max_project_workers: 1
  healthcheck_timeout: 15
  prompt_group: default
tasks:
  bootstrap: {timeout: 300, conclude_timeout: 90}
  reason: {timeout: 300, max_intents: 3}
  explore: {timeout: 600, conclude_timeout: 120}
budget:
  max_project_tokens: 1000
`;

let directory: string;
let db: CairnDatabase;
let config: DispatchConfig;

function source(): Record<string, unknown> {
  return Bun.YAML.parse(SOURCE) as Record<string, unknown>;
}

function newStore(
  options: {
    config?: DispatchConfig;
    onApply?: () => void;
    validateNext?: (next: DispatchConfig, current: DispatchConfig) => string | null;
  } = {},
) {
  return new RuntimeConfigStore({
    db,
    config: options.config ?? config,
    source: source(),
    ...(options.onApply === undefined ? {} : { onApply: options.onApply }),
    ...(options.validateNext === undefined ? {} : { validateNext: options.validateNext }),
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-config-overrides-"));
  db = configureDatabase(join(directory, "cairn.db"));
  config = parseDispatchConfig(source());
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("runtime override patches", () => {
  test("accepts only the editable sections and keys", () => {
    expect(() => parseRuntimeOverridePatch({ observer: { enabled: false } })).toThrow(
      "overrides has unsupported section: observer",
    );
    expect(() => parseRuntimeOverridePatch({ budget: { typo: 1 } })).toThrow(
      "overrides.budget has unsupported key: typo",
    );
    expect(() =>
      parseRuntimeOverridePatch({ tasks: { reason: { max_intent: 2 } } }),
    ).toThrow("overrides.tasks.reason has unsupported key: max_intent");
    expect(() => parseRuntimeOverridePatch({ tasks: { review: {} } })).toThrow(
      "overrides.tasks has unsupported key: review",
    );
  });

  test("merges nested sections and flattens overridden paths", () => {
    const merged = mergeOverrideDocuments(source(), {
      tasks: { reason: { max_intents: 5 } },
      budget: { max_project_tokens: 9 },
    });
    expect(merged["tasks"]).toEqual({
      bootstrap: { timeout: 300, conclude_timeout: 90 },
      reason: { timeout: 300, max_intents: 5 },
      explore: { timeout: 600, conclude_timeout: 120 },
    });
    expect(merged["budget"]).toEqual({ max_project_tokens: 9 });

    expect(
      overridePaths({
        tasks: { reason: { max_intents: 5 } },
        proposals: { allow_kinds: ["fact"] },
      }),
    ).toEqual(["proposals.allow_kinds", "tasks.reason.max_intents"]);
  });
});

describe("RuntimeConfigStore", () => {
  test("starts with no overrides and identical effective values", () => {
    const store = newStore();
    const view = store.view();
    expect(view.editable).toEqual(view.defaults);
    expect(view.overrides).toEqual([]);
    expect(view.updated_at).toBeNull();
    expect(view.editable.runtime.execution).toBe("local");
    expect(view.read_only.runtime).not.toHaveProperty("execution");
    expect(view.read_only.observer.enabled).toBe(true);
  });

  test("applies a patch to the live config in place and persists it", () => {
    let applied = 0;
    const store = newStore({ onApply: () => (applied += 1) });
    const budgetRef = config.budget;
    const verificationRef = config.verification;

    const view = store.apply({
      runtime: { max_workers: 6, interval: 5 },
      tasks: { reason: { max_intents: 5 }, graph_slice: { enabled: true } },
      budget: { max_project_tokens: 250 },
      verification: { evidence_enforcement: "off" },
      worker_selection: { epsilon: 0.2 },
      proposals: { enabled: true, allow_kinds: ["fact", "hint"] },
    });

    expect(applied).toBe(1);
    expect(config.runtime.maxWorkers).toBe(6);
    expect(config.tasks.reason.maxIntents).toBe(5);
    expect(config.tasks.graphSlice.enabled).toBe(true);
    expect(config.budget.maxProjectTokens).toBe(250);
    expect(config.budget).toBe(budgetRef);
    expect(config.verification).toBe(verificationRef);
    expect(config.verification.evidenceEnforcement).toBe("off");
    expect(config.workerSelection.epsilon).toBe(0.2);
    expect(config.proposals.allowKinds).toEqual(["fact", "hint"]);

    expect(view.overrides).toEqual([
      "budget.max_project_tokens",
      "proposals.allow_kinds",
      "proposals.enabled",
      "runtime.interval",
      "runtime.max_workers",
      "tasks.graph_slice.enabled",
      "tasks.reason.max_intents",
      "verification.evidence_enforcement",
      "worker_selection.epsilon",
    ]);
    expect(view.updated_at).not.toBeNull();
    expect(view.defaults.runtime.max_workers).toBe(4);
    expect(view.defaults.budget.max_project_tokens).toBe(1000);

    const stored = db.withConn((conn) => getRuntimeConfigOverrides(conn));
    expect(JSON.parse(stored.overrides)).toEqual({
      runtime: { max_workers: 6, interval: 5 },
      tasks: { reason: { max_intents: 5 }, graph_slice: { enabled: true } },
      budget: { max_project_tokens: 250 },
      verification: { evidence_enforcement: "off" },
      worker_selection: { epsilon: 0.2 },
      proposals: { enabled: true, allow_kinds: ["fact", "hint"] },
    });
    expect(stored.updatedAt).toBe(view.updated_at);
  });

  test("toggles the flag review switch and restores it on reset", () => {
    const store = newStore();
    expect(config.verification.flagReview).toBe("manual");
    expect(store.view().editable.verification.flag_review).toBe("manual");

    const view = store.apply({ verification: { flag_review: "off" } });
    expect(config.verification.flagReview).toBe("off");
    expect(view.editable.verification).toEqual({
      evidence_enforcement: "completion",
      flag_review: "off",
    });
    expect(view.overrides).toEqual(["verification.flag_review"]);
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({ verification: { flag_review: "off" } });

    expect(store.reset().editable.verification.flag_review).toBe("manual");
    expect(config.verification.flagReview).toBe("manual");
  });

  test("replays stored overrides on a fresh config after restart", () => {
    newStore().apply({ retention: { session_keep_per_project: 7 } });

    const restarted = parseDispatchConfig(source());
    const store = newStore({ config: restarted });
    expect(restarted.retention.sessionKeepPerProject).toBe(7);
    expect(store.view().overrides).toEqual(["retention.session_keep_per_project"]);
  });

  test("rejects invalid values and keeps the running config untouched", () => {
    const store = newStore();
    store.apply({ budget: { max_project_tokens: 5 } });

    expect(() => store.apply({ worker_selection: { mode: "stats" } })).toThrow(
      "worker_selection.mode stats requires at least one worker_profiles entry",
    );
    expect(() =>
      store.apply({ worker_selection: { epsilon: 0.1, epsilon_min: 0.5 } }),
    ).toThrow("worker_selection.epsilon_min must not exceed worker_selection.epsilon");
    expect(() => store.apply({ tasks: { graph_slice: { max_facts: 1 } } })).toThrow(
      "graph_slice.max_facts must be at least 2",
    );
    expect(() => store.apply({ runtime: { max_workers: 0 } })).toThrow(
      "runtime.max_workers must be a positive integer",
    );
    expect(() => store.apply({ proposals: { mode: "sometimes" } })).toThrow(
      "proposals.mode must be one of",
    );
    expect(() => store.apply({ verification: { flag_review: "sometimes" } })).toThrow(
      "verification.flag_review must be one of: manual, off",
    );

    expect(config.budget.maxProjectTokens).toBe(5);
    expect(store.view().overrides).toEqual(["budget.max_project_tokens"]);
  });

  test("rejects cross-field violations inside one patch", () => {
    const store = newStore();
    expect(() =>
      store.apply({ runtime: { max_workers: 2, max_project_workers: 3 } }),
    ).toThrow("runtime.max_project_workers cannot exceed runtime.max_workers");
    expect(config.runtime.maxWorkers).toBe(4);
    expect(config.runtime.maxProjectWorkers).toBe(1);
    expect(store.view().overrides).toEqual([]);
  });

  test("switches to container mode with validation defaults", () => {
    const store = newStore();
    const view = store.apply({ runtime: { execution: "container" } });

    expect(config.runtime.execution).toBe("container");
    expect(config.container).toMatchObject({
      image: "cairn-worker:latest",
      networkMode: "bridge",
      completedAction: "remove",
    });
    expect(view.editable.runtime.execution).toBe("container");
    expect(view.overrides).toEqual(["runtime.execution"]);
    expect(JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides)).toEqual({
      runtime: { execution: "container" },
    });
  });

  test("lets validateNext reject a switch without touching the live config", () => {
    const store = newStore({
      validateNext: (next, current) =>
        next.runtime.execution === current.runtime.execution
          ? null
          : "wait for running tasks to finish before switching the execution mode",
    });
    store.apply({ budget: { max_project_tokens: 7 } });

    expect(() => store.apply({ runtime: { execution: "container" } })).toThrow(
      "wait for running tasks to finish before switching the execution mode",
    );
    expect(config.runtime.execution).toBe("local");
    expect(config.budget.maxProjectTokens).toBe(7);
    expect(store.view().overrides).toEqual(["budget.max_project_tokens"]);
  });

  test("resets to the dispatch.yaml values", () => {
    const store = newStore();
    store.apply({
      budget: { max_project_tokens: 250 },
      tasks: { reason: { max_intents: 8 } },
    });

    const view = store.reset();
    expect(config.budget.maxProjectTokens).toBe(1000);
    expect(config.tasks.reason.maxIntents).toBe(3);
    expect(view.overrides).toEqual([]);
    expect(view.editable).toEqual(view.defaults);
    expect(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides).toBe("{}");
  });

  test("ignores and clears a corrupt stored patch", () => {
    db.withConn((conn) =>
      conn
        .query("UPDATE runtime_config_overrides SET overrides = ? WHERE id = 1")
        .run('{"budget": {"typo": 1}}'),
    );
    const messages: string[] = [];
    const store = new RuntimeConfigStore({
      db,
      config,
      source: source(),
      log: (message) => messages.push(message),
    });

    expect(messages[0]).toContain("ignoring invalid stored runtime overrides");
    expect(store.view().overrides).toEqual([]);
    expect(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides).toBe("{}");
  });
});
