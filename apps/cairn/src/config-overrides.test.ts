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
    // Worker environment overrides are deployment-only, never an HTTP write surface.
    for (const section of ["common_env", "local", "container"]) {
      expect(() => parseRuntimeOverridePatch({ [section]: { env: { HTTPS_PROXY: "http://proxy:1" } } }))
        .toThrow(`overrides has unsupported section: ${section}`);
    }
    // The off-completion safety gate is deployment policy, not a runtime dial.
    expect(() =>
      parseRuntimeOverridePatch({ verification: { off_completion: "auto" } }),
    ).toThrow("overrides.verification has unsupported key: off_completion");
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

  test("context planning exposes only the audit switch and byte threshold", () => {
    expect(() => parseRuntimeOverridePatch({ tasks: { context_plan: { mode: "off", max_initial_bytes: 4096 } } })).not.toThrow();
    expect(() => parseRuntimeOverridePatch({ tasks: { context_plan: { tokenizer: "guess" } } })).toThrow("overrides.tasks.context_plan has unsupported key: tokenizer");
  });

  test("keeps tool-result spilling editable", () => {
    expect(() =>
      parseRuntimeOverridePatch({
        tasks: { tool_result_spill: { enabled: false, max_inline_chars: 4096 } },
      }),
    ).not.toThrow();
    expect(() =>
      parseRuntimeOverridePatch({ tasks: { tool_result_spill: { min_bytes: 1 } } }),
    ).toThrow("overrides.tasks.tool_result_spill has unsupported key: min_bytes");
  });

  test("keeps the reasoning policy editable", () => {
    // The store validates the merged document, so an unknown mode is refused there.
    expect(() => parseRuntimeOverridePatch({ worker: { reasoning: "sometimes" } })).not.toThrow();
    expect(() => newStore().apply({ worker: { reasoning: "sometimes" } })).toThrow(
      "worker.reasoning",
    );

    const store = newStore();
    const view = store.apply({ worker: { reasoning: "reason" } });
    expect(config.worker.reasoning).toBe("reason");
    expect(view.editable.worker.reasoning).toBe("reason");
    expect(view.overrides).toEqual(["worker.reasoning"]);

    expect(store.reset().editable.worker.reasoning).toBe("reason");
    expect(config.worker.reasoning).toBe("reason");
  });

  test("keeps the SSRF marker mode editable and the protected hosts fixed", () => {
    expect(() => parseRuntimeOverridePatch({ scope: { ssrf_markers: "block" } })).not.toThrow();
    // Deployment identity is not a dial: the protected list only comes from dispatch.yaml.
    expect(() =>
      parseRuntimeOverridePatch({ scope: { protected_hosts: ["host.test"] } }),
    ).toThrow("overrides.scope has unsupported key: protected_hosts");
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
    expect(view.read_only.runtime.strategy_context).toBe("on");
    expect(view.read_only.verification.off_completion).toBe("manual");
    expect(view.read_only.observer.enabled).toBe(true);
  });

  test("runtime patches and restart replay preserve file-only per-mode environments without exposing values", () => {
    const document = source();
    document["local"] = { env: { HTTPS_PROXY: "http://local-proxy:18899" } };
    document["container"] = {
      image: "worker:test", network_mode: "bridge", completed_action: "remove",
      env: { HTTPS_PROXY: "http://container-proxy:18899" },
    };
    const current = parseDispatchConfig(document);
    const store = new RuntimeConfigStore({ db, config: current, source: document });
    const view = store.apply({ runtime: { interval: 5 } });
    expect(current.local?.env?.["HTTPS_PROXY"]).toBe("http://local-proxy:18899");
    expect(current.container?.env?.["HTTPS_PROXY"]).toBe("http://container-proxy:18899");
    expect(JSON.stringify(view)).not.toContain("local-proxy");
    expect(JSON.stringify(view)).not.toContain("container-proxy");
    const restarted = parseDispatchConfig(document);
    new RuntimeConfigStore({ db, config: restarted, source: document });
    expect(restarted.runtime.interval).toBe(5);
    expect(restarted.local?.env).toEqual(current.local?.env);
    expect(restarted.container?.env).toEqual(current.container?.env);
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

  test("switches the SSRF marker mode on the live config", () => {
    const store = newStore();
    expect(config.scope.ssrfMarkers).toBe("observe");
    expect(store.view().editable.scope).toEqual({ ssrf_markers: "observe" });

    const view = store.apply({ scope: { ssrf_markers: "block" } });
    expect(config.scope.ssrfMarkers).toBe("block");
    expect(view.overrides).toEqual(["scope.ssrf_markers"]);
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({ scope: { ssrf_markers: "block" } });

    expect(() => store.apply({ scope: { ssrf_markers: "watch" } })).toThrow(
      "scope.ssrf_markers must be one of",
    );
    expect(config.scope.ssrfMarkers).toBe("block");

    expect(store.reset().editable.scope.ssrf_markers).toBe("observe");
    expect(config.scope.ssrfMarkers).toBe("observe");
  });

  test("context audit edits persist, replay and reset without accepting enforcement", () => {
    const store = newStore();
    expect(store.view().editable.tasks.context_plan).toEqual({ mode: "audit", max_initial_bytes: 131072 });
    const view = store.apply({ tasks: { context_plan: { mode: "off", max_initial_bytes: 4096 } } });
    expect(config.tasks.contextPlan).toEqual({ mode: "off", maxInitialBytes: 4096 });
    expect(view.overrides).toEqual(["tasks.context_plan.max_initial_bytes", "tasks.context_plan.mode"]);
    const restarted = parseDispatchConfig(source());
    newStore({ config: restarted });
    expect(restarted.tasks.contextPlan).toEqual(config.tasks.contextPlan);
    for (const patch of [{ mode: "enforce" }, { max_initial_bytes: 0 }]) {
      expect(() => store.apply({ tasks: { context_plan: patch } })).toThrow();
      expect(config.tasks.contextPlan).toEqual({ mode: "off", maxInitialBytes: 4096 });
    }
    expect(store.reset().editable.tasks.context_plan).toEqual({ mode: "audit", max_initial_bytes: 131072 });
  });

  test("edits the per-command bash timeout on the live config", () => {
    const store = newStore();
    expect(store.view().editable.tasks.bash_timeout_seconds).toBe(150);

    const view = store.apply({ tasks: { bash_timeout_seconds: 90 } });
    expect(config.tasks.bashTimeoutSeconds).toBe(90);
    expect(view.overrides).toEqual(["tasks.bash_timeout_seconds"]);
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({ tasks: { bash_timeout_seconds: 90 } });

    // A command always runs under a timeout, so zero is rejected by the merged re-parse.
    expect(() => store.apply({ tasks: { bash_timeout_seconds: 0 } })).toThrow(
      "tasks.bash_timeout_seconds must be a positive integer",
    );
    expect(config.tasks.bashTimeoutSeconds).toBe(90);
    expect(store.reset().editable.tasks.bash_timeout_seconds).toBe(150);
  });

  test("toggles tool-result spilling on the live config", () => {
    const store = newStore();
    expect(store.view().editable.tasks.tool_result_spill).toEqual({
      enabled: true,
      max_inline_chars: 32_000,
    });

    const view = store.apply({ tasks: { tool_result_spill: { enabled: false } } });
    expect(config.tasks.toolResultSpill).toEqual({ enabled: false, maxInlineChars: 32_000 });
    expect(view.overrides).toEqual(["tasks.tool_result_spill.enabled"]);
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({ tasks: { tool_result_spill: { enabled: false } } });

    expect(() =>
      store.apply({ tasks: { tool_result_spill: { max_inline_chars: 0 } } }),
    ).toThrow("tool_result_spill.max_inline_chars must be a positive integer");
    expect(config.tasks.toolResultSpill.enabled).toBe(false);

    expect(store.reset().editable.tasks.tool_result_spill).toEqual({
      enabled: true,
      max_inline_chars: 32_000,
    });
    expect(config.tasks.toolResultSpill).toEqual({ enabled: true, maxInlineChars: 32_000 });
  });

  test("toggles the model trace on the live config", () => {
    const store = newStore();
    expect(store.view().editable.tasks.model_trace).toEqual({
      enabled: true,
      preview_chars: 2000,
      max_bytes: 8 * 1024 * 1024,
    });

    const view = store.apply({ tasks: { model_trace: { preview_chars: 400 } } });
    expect(config.tasks.modelTrace).toEqual({ enabled: true, previewChars: 400, maxBytes: 8 * 1024 * 1024 });
    expect(view.overrides).toEqual(["tasks.model_trace.preview_chars"]);

    expect(() => store.apply({ tasks: { model_trace: { max_bytes: 1024 } } })).toThrow(
      "tasks.model_trace.max_bytes must be an integer from 262144 to 67108864",
    );
    expect(config.tasks.modelTrace.maxBytes).toBe(8 * 1024 * 1024);

    expect(store.reset().editable.tasks.model_trace).toEqual({
      enabled: true,
      preview_chars: 2000,
      max_bytes: 8 * 1024 * 1024,
    });
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

describe("M48 ContextPack hot overrides", () => {
  test("validates, persists, replays and resets rollout settings", () => {
    const store = newStore();
    store.apply({ tasks: { context_pack: { mode: "shadow", shard_max_bytes: 4096 } } });
    expect(config.tasks.contextPack).toEqual({ mode: "shadow", shardMaxBytes: 4096 });
    const fresh = parseDispatchConfig(source()); newStore({ config: fresh });
    expect(fresh.tasks.contextPack).toEqual(config.tasks.contextPack);
    expect(store.view().editable.tasks.context_pack).toEqual({ mode: "shadow", shard_max_bytes: 4096 });
    expect(() => store.apply({ tasks: { context_pack: { mode: "shadow" }, context_plan: { mode: "off" } } })).toThrow("context_pack requires");
    expect(config.tasks.contextPlan.mode).toBe("audit");
    expect(() => store.apply({ tasks: { context_pack: { shard_max_bytes: 4 } } })).toThrow("shard_max_bytes");
    store.apply({ tasks: { context_pack: { mode: "off" }, context_plan: { mode: "off" } } });
    expect(config.tasks.contextPack.mode).toBe("off");
    store.reset();
    expect(config.tasks.contextPack).toEqual({ mode: "off", shardMaxBytes: 8192 });
  });
  test("exposes only the approved pack override keys", () => {
    expect(() => parseRuntimeOverridePatch({ tasks: { context_pack: { mode: "apply", shard_max_bytes: 8192 } } })).not.toThrow();
    expect(() => parseRuntimeOverridePatch({ tasks: { context_pack: { max_initial_bytes: 1 } } })).toThrow("unsupported key");
  });
});

describe("M52c soft preference overrides", () => {
  test("is default-off, validates a strict enable flag, and persists/replays/resets", () => {
    const store = newStore();
    expect(config.tasks.explorationSuppression).toEqual({ enabled: false });
    expect(store.view().editable.tasks.exploration_suppression).toEqual({ enabled: false });
    store.apply({ tasks: { exploration_suppression: { enabled: true } } });
    expect(config.tasks.explorationSuppression.enabled).toBe(true);
    const fresh = parseDispatchConfig(source()); newStore({ config: fresh });
    expect(fresh.tasks.explorationSuppression.enabled).toBe(true);
    expect(() => store.apply({ tasks: { exploration_suppression: { enabled: "yes" } } })).toThrow();
    expect(() => store.apply({ tasks: { exploration_suppression: { max_penalty: 1000 } } })).toThrow("unsupported key");
    expect(config.tasks.explorationSuppression.enabled).toBe(true);
    expect(store.reset().editable.tasks.exploration_suppression.enabled).toBe(false);
  });
});

describe("M49 checkpoint hot overrides", () => {
  test("validates, persists, replays and resets collection settings", () => {
    const store = newStore();
    expect(store.view().editable.tasks.checkpoint).toEqual({ enabled: false, interval_seconds: 5 });
    store.apply({ tasks: { checkpoint: { enabled: true, interval_seconds: 2 } } });
    expect(config.tasks.checkpoint).toEqual({ enabled: true, intervalSeconds: 2 });
    const fresh = parseDispatchConfig(source()); newStore({ config: fresh });
    expect(fresh.tasks.checkpoint).toEqual(config.tasks.checkpoint);
    expect(() => store.apply({ tasks: { checkpoint: { interval_seconds: 61 } } })).toThrow();
    expect(config.tasks.checkpoint.enabled).toBe(true);
    expect(() => parseRuntimeOverridePatch({ tasks: { checkpoint: { automatic_execution: true } } })).toThrow("unsupported key");
    expect(store.reset().editable.tasks.checkpoint).toEqual({ enabled: false, interval_seconds: 5 });
  });
});
