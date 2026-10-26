import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadDispatchConfig,
  parseDispatchConfig,
  type ConfigOptions,
} from "./config";
import { DEFAULT_PROMPT_REQUIRED_TOKENS } from "./prompts/prompting";

const BASE = `server: "http://127.0.0.1:8000"
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
  reason: {timeout: 300}
  explore: {timeout: 600, conclude_timeout: 120}
`;

function parse(text: string, options: ConfigOptions = {}) {
  return parseDispatchConfig(Bun.YAML.parse(text), options);
}

describe("dispatcher config", () => {
  test("applies merged defaults", () => {
    const config = parse(BASE);
    expect(config.server).toBe("http://127.0.0.1:8000");
    expect(config.runtime).toEqual({
      maxWorkers: 4,
      maxRunningProjects: 2,
      maxProjectWorkers: 1,
      interval: 3,
      healthcheckTimeout: 15,
      workerHealthcheck: "startup_only",
      execution: "local",
      promptGroup: "default",
    });
    expect(config.tasks.reason.maxIntents).toBe(3);
    expect(config.tasks.evidence).toEqual({ minBytes: 1 });
    expect(config.local).toEqual({ workspaceRoot: null, completedAction: "keep" });
    expect(config.container).toBeNull();
    expect(config.commonEnv).toEqual({});
    expect(config.worker).toEqual({
      softDeadlineRatio: 0.8,
      retainTaskFiles: true,
      resultGraceSeconds: 15,
      scopedArtifacts: false,
    });
    expect(config.retention).toEqual({
      sessionMaxAgeDays: 0,
      sessionKeepPerProject: 0,
      sweepIntervalSeconds: 3600,
      refreshArtifacts: false,
    });
    expect(config.auditStream).toEqual({ enabled: false, url: null });
    expect(config.proposals).toEqual({
      enabled: false,
      mode: "apply",
      maxPerTask: 20,
      maxFileBytes: 16 * 1024,
      maxTotalBytes: 64 * 1024,
      allowKinds: ["fact", "intent", "hint"],
      requireEvidenceForFact: true,
      minConfidence: 0,
    });
    expect(config.strategist).toEqual({
      minNewFacts: 1,
      minNewHints: 1,
      cooldownSeconds: 30,
      failureBackoffSeconds: 120,
      maxRunsPerHour: 12,
      zeroOutputThreshold: 3,
      staleIntentSeconds: 0,
      fallbackIntervalSeconds: 0,
      resourcePressureRatio: 0,
    });
    expect(config.budget).toEqual({
      maxProjectTokens: 0,
      maxProjectCostUsd: 0,
      maxProjectTasks: 0,
    });
    expect(config.workerProfiles).toEqual([]);
    expect(config.workerSelection).toEqual({ mode: "prompt", minRuns: 3 });
    expect(config.verification).toEqual({
      challenge: {
        baseUrlEnv: "TCH_CHALLENGE_API_BASE_URL",
        agentTokenEnv: "TCH_CHALLENGE_AGENT_TOKEN",
        timeoutMs: 5000,
      },
    });
  });

  test("parses the challenge verifier environment names", () => {
    const config = parse(
      BASE +
        `verification:
  challenge:
    base_url_env: CUSTOM_BASE_URL
    agent_token_env: CUSTOM_AGENT_TOKEN
    timeout_ms: 1500
`,
    );
    expect(config.verification.challenge).toEqual({
      baseUrlEnv: "CUSTOM_BASE_URL",
      agentTokenEnv: "CUSTOM_AGENT_TOKEN",
      timeoutMs: 1500,
    });
  });

  test("rejects an invalid verification timeout", () => {
    expect(() =>
      parse(
        BASE +
          `verification:
  challenge:
    timeout_ms: 0
`,
      ),
    ).toThrow("verification.challenge.timeout_ms");
  });

  test("parses per-project budget policy", () => {
    const config = parse(
      BASE +
        `budget:
  max_project_tokens: 250000
  max_project_cost_usd: 1.25
  max_project_tasks: 2
`,
    );
    expect(config.budget).toEqual({
      maxProjectTokens: 250000,
      maxProjectCostUsd: 1.25,
      maxProjectTasks: 2,
    });
  });

  test("rejects negative budget values", () => {
    expect(() => parse(BASE + "budget:\n  max_project_tokens: -1\n")).toThrow(
      "budget.max_project_tokens",
    );
    expect(() => parse(BASE + "budget:\n  max_project_cost_usd: -0.01\n")).toThrow(
      "budget.max_project_cost_usd",
    );
    expect(() => parse(BASE + "budget:\n  max_project_tasks: -2\n")).toThrow(
      "budget.max_project_tasks",
    );
  });

  test("parses and validates the Strategist trigger policy", () => {
    const config = parse(
      BASE +
        `strategist:
  min_new_facts: 2
  min_new_hints: 0
  cooldown_seconds: 5
  failure_backoff_seconds: 30
  max_runs_per_hour: 4
  zero_output_threshold: 2
  stale_intent_seconds: 600
  fallback_interval_seconds: 900
  resource_pressure_ratio: 0.8
`,
    );
    expect(config.strategist).toEqual({
      minNewFacts: 2,
      minNewHints: 0,
      cooldownSeconds: 5,
      failureBackoffSeconds: 30,
      maxRunsPerHour: 4,
      zeroOutputThreshold: 2,
      staleIntentSeconds: 600,
      fallbackIntervalSeconds: 900,
      resourcePressureRatio: 0.8,
    });

    expect(() => parse(BASE + "strategist: {cooldown_seconds: -1}\n")).toThrow(
      "strategist.cooldown_seconds must be a non-negative integer",
    );
    expect(() => parse(BASE + 'strategist: {max_runs_per_hour: "4"}\n')).toThrow(
      "strategist.max_runs_per_hour must be a non-negative integer",
    );
    expect(() => parse(BASE + "strategist: {resource_pressure_ratio: 1.5}\n")).toThrow(
      "strategist.resource_pressure_ratio must be a number between 0 and 1",
    );
    expect(() => parse(BASE + "strategist: {resource_pressure_ratio: -0.1}\n")).toThrow(
      "strategist.resource_pressure_ratio must be a number between 0 and 1",
    );
    expect(() => parse(BASE + "strategist: []\n")).toThrow(
      "strategist must be an object",
    );
  });

  test("parses and validates the proposal policy", () => {
    const config = parse(
      BASE +
        `proposals:
  enabled: true
  mode: dry_run
  max_per_task: 4
  max_file_bytes: 2048
  max_total_bytes: 8192
  allow_kinds: [hint, intent]
  require_evidence_for_fact: false
  min_confidence: 0.4
`,
    );
    expect(config.proposals).toEqual({
      enabled: true,
      mode: "dry_run",
      maxPerTask: 4,
      maxFileBytes: 2048,
      maxTotalBytes: 8192,
      allowKinds: ["hint", "intent"],
      requireEvidenceForFact: false,
      minConfidence: 0.4,
    });

    expect(() => parse(BASE + "proposals: {enabled: 1}\n")).toThrow(
      "proposals.enabled must be a boolean",
    );
    expect(() => parse(BASE + "proposals: {mode: live}\n")).toThrow(
      "proposals.mode must be one of: off, dry_run, apply",
    );
    expect(() => parse(BASE + "proposals: {allow_kinds: [flag]}\n")).toThrow(
      "proposals.allow_kinds[0] must be one of: fact, intent, hint",
    );
    expect(() => parse(BASE + "proposals: {min_confidence: 2}\n")).toThrow(
      "proposals.min_confidence must be a number between 0 and 1",
    );
    expect(() =>
      parse(BASE + "proposals: {max_file_bytes: 2048, max_total_bytes: 1024}\n"),
    ).toThrow("proposals.max_total_bytes cannot be smaller than max_file_bytes");
    expect(() => parse(BASE + "proposals: {max_per_task: -1}\n")).toThrow(
      "proposals.max_per_task must be a non-negative integer",
    );
  });

  test("parses and validates audit streaming", () => {
    const config = parse(
      BASE +
        `audit_stream:
  enabled: true
  url: "http://host.docker.internal:8000"
`,
    );
    expect(config.auditStream).toEqual({
      enabled: true,
      url: "http://host.docker.internal:8000",
    });
    expect(() => parse(BASE + "audit_stream: {enabled: 1}\n")).toThrow(
      "audit_stream.enabled must be a boolean",
    );
    expect(() => parse(BASE + 'audit_stream: {url: "ftp://x"}\n')).toThrow(
      "audit_stream.url must be a valid http(s) URL",
    );
    expect(() => parse(BASE + 'audit_stream: {url: "not a url"}\n')).toThrow(
      "audit_stream.url must be a valid http(s) URL",
    );
  });

  test("defaults graph slicing off and parses overrides", () => {
    expect(parse(BASE).tasks.graphSlice).toEqual({
      enabled: false,
      maxFacts: 80,
      maxIntents: 60,
    });
    const config = parse(
      BASE +
        `  graph_slice:
    enabled: true
    max_facts: 12
    max_intents: 5
`,
    );
    expect(config.tasks.graphSlice).toEqual({
      enabled: true,
      maxFacts: 12,
      maxIntents: 5,
    });
  });

  test("validates graph slice options", () => {
    expect(() => parse(BASE + '  graph_slice: {enabled: "yes"}\n')).toThrow(
      "tasks.graph_slice.enabled must be a boolean",
    );
    expect(() => parse(BASE + "  graph_slice: {max_facts: 1}\n")).toThrow(
      "tasks.graph_slice.max_facts must be at least 2",
    );
    expect(() => parse(BASE + "  graph_slice: {max_intents: 0}\n")).toThrow(
      "tasks.graph_slice.max_intents must be a positive integer",
    );
  });

  test("parses and validates the evidence minimum size", () => {
    expect(parse(BASE + "  evidence: {min_bytes: 0}\n").tasks.evidence).toEqual({
      minBytes: 0,
    });
    expect(parse(BASE + "  evidence: {min_bytes: 12}\n").tasks.evidence).toEqual({
      minBytes: 12,
    });
    expect(() => parse(BASE + "  evidence: {min_bytes: -1}\n")).toThrow(
      "tasks.evidence.min_bytes must be a non-negative integer",
    );
    expect(() => parse(BASE + '  evidence: {min_bytes: "1"}\n')).toThrow(
      "tasks.evidence.min_bytes must be a non-negative integer",
    );
  });

  test("parses and validates retention", () => {
    const config = parse(
      BASE +
        `retention:
  session_max_age_days: 14
  session_keep_per_project: 5
  sweep_interval_seconds: 60
  refresh_artifacts: true
`,
    );
    expect(config.retention).toEqual({
      sessionMaxAgeDays: 14,
      sessionKeepPerProject: 5,
      sweepIntervalSeconds: 60,
      refreshArtifacts: true,
    });
    expect(() => parse(BASE + "retention: {session_max_age_days: -1}\n")).toThrow(
      "retention.session_max_age_days must be a non-negative integer",
    );
    expect(() => parse(BASE + "retention: {session_keep_per_project: 1.5}\n")).toThrow(
      "retention.session_keep_per_project must be a non-negative integer",
    );
    expect(() => parse(BASE + 'retention: {refresh_artifacts: "yes"}\n')).toThrow(
      "retention.refresh_artifacts must be a boolean",
    );
  });

  test("defaults the Observer off and parses overrides", () => {
    expect(parse(BASE).observer).toEqual({
      enabled: false,
      model: null,
      everyRounds: 4,
      windowRounds: 8,
      timeoutSeconds: 60,
      maxReviewsPerTask: 8,
      kernelTasks: ["explore"],
    });

    const config = parse(
      BASE +
        `observer:
  enabled: true
  model: "cheap-review"
  every_rounds: 2
  window_rounds: 5
  timeout_seconds: 20
  max_reviews_per_task: 0
  kernel_tasks: ["explore", "reason"]
`,
    );
    expect(config.observer).toEqual({
      enabled: true,
      model: "cheap-review",
      everyRounds: 2,
      windowRounds: 5,
      timeoutSeconds: 20,
      maxReviewsPerTask: 0,
      kernelTasks: ["explore", "reason"],
    });
  });

  test("validates Observer options", () => {
    expect(() => parse(BASE + 'observer: {enabled: "yes"}\n')).toThrow(
      "observer.enabled must be a boolean",
    );
    expect(() => parse(BASE + "observer: {every_rounds: 0}\n")).toThrow(
      "observer.every_rounds must be a positive integer",
    );
    expect(() => parse(BASE + "observer: {window_rounds: 0}\n")).toThrow(
      "observer.window_rounds must be a positive integer",
    );
    expect(() => parse(BASE + "observer: {timeout_seconds: 0}\n")).toThrow(
      "observer.timeout_seconds must be a positive integer",
    );
    expect(() => parse(BASE + "observer: {max_reviews_per_task: -1}\n")).toThrow(
      "observer.max_reviews_per_task must be a non-negative integer",
    );
    expect(() => parse(BASE + "observer: {kernel_tasks: [explore, bogus]}\n")).toThrow(
      "observer.kernel_tasks[1] must be one of: bootstrap, reason, explore, conclude",
    );
  });

  test("parses worker overrides and common_env", () => {
    const config = parse(
      BASE +
        `worker:
  soft_deadline_ratio: 0.5
  retain_task_files: false
  result_grace_seconds: 0
common_env:
  HTTPS_PROXY: "http://127.0.0.1:7897"
  NO_COLOR: ""
`,
    );
    expect(config.worker).toEqual({
      softDeadlineRatio: 0.5,
      retainTaskFiles: false,
      resultGraceSeconds: 0,
      scopedArtifacts: false,
    });
    expect(config.commonEnv).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_COLOR: "",
    });
  });

  test("parses worker profiles and stats selection", () => {
    const config = parse(
      BASE +
        `worker_profiles:
  - id: fast
    model: cairn-worker
  - id: deep
    model: deep-reasoner
worker_selection:
  mode: stats
  min_runs: 2
`,
    );
    expect(config.workerProfiles).toEqual([
      { id: "fast", model: "cairn-worker" },
      { id: "deep", model: "deep-reasoner" },
    ]);
    expect(config.workerSelection).toEqual({ mode: "stats", minRuns: 2 });
  });

  test("scopes artifacts by default only for concurrent project workers", () => {
    expect(parse(BASE).worker.scopedArtifacts).toBe(false);
    expect(
      parse(BASE.replace("max_project_workers: 1", "max_project_workers: 2")).worker
        .scopedArtifacts,
    ).toBe(true);
    expect(
      parse(
        BASE.replace("max_project_workers: 1", "max_project_workers: 2") +
          "worker: {scoped_artifacts: false}\n",
      ).worker.scopedArtifacts,
    ).toBe(false);
    expect(
      parse(BASE + "worker: {scoped_artifacts: true}\n").worker.scopedArtifacts,
    ).toBe(true);
  });

  test("parses container mode and its config", () => {
    const config = parse(
      BASE.replace("execution: local", "execution: container") +
        `container:
  image: "example/worker:latest"
  network_mode: "host"
  completed_action: remove
`,
    );
    expect(config.runtime.execution).toBe("container");
    expect(config.local).toBeNull();
    expect(config.container).toEqual({
      image: "example/worker:latest",
      networkMode: "host",
      completedAction: "remove",
      capAdd: [],
      workspaceRoot: null,
      workerArgv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
    });
  });

  test("parses local workspace and completed_action", () => {
    const config = parse(
      BASE +
        `local:
  workspace_root: "/data/cairn-runs"
  completed_action: remove
`,
    );
    expect(config.local).toEqual({
      workspaceRoot: "/data/cairn-runs",
      completedAction: "remove",
    });
  });

  test("loads the checked-in example config", () => {
    const path = join(import.meta.dir, "..", "..", "..", "dispatch.example.yaml");
    const config = loadDispatchConfig(path);
    expect(config.runtime.execution).toBe("local");
    expect(config.runtime.promptGroup).toBe("default");
    expect(config.runtime.maxProjectWorkers).toBe(1);
  });
});

describe("config validation", () => {
  test("rejects an empty document", () => {
    expect(() => parse("")).toThrow("config.runtime is required");
  });

  test("rejects the removed workers section", () => {
    expect(() => parse(BASE + "workers: []\n")).toThrow("workers' is no longer supported");
  });

  test("rejects unknown top-level keys", () => {
    expect(() => parse(BASE + "extra: 1\n")).toThrow("unknown key: extra");
  });

  test("requires server", () => {
    const withoutServer = BASE.split("\n")
      .filter((line) => !line.startsWith("server:"))
      .join("\n");
    expect(() => parse(withoutServer)).toThrow("config.server is required");
  });

  test("requires max_project_workers <= max_workers", () => {
    expect(() =>
      parse(BASE.replace("max_project_workers: 1", "max_project_workers: 9")),
    ).toThrow("cannot exceed runtime.max_workers");
  });

  test("requires container config in container mode", () => {
    expect(() =>
      parse(BASE.replace("execution: local", "execution: container")),
    ).toThrow("container config is required");
  });

  test("validates integer fields", () => {
    expect(() => parse(BASE.replace("max_workers: 4", 'max_workers: "4"'))).toThrow(
      "runtime.max_workers must be a positive integer",
    );
    expect(() => parse(BASE.replace("interval: 3", "interval: 0"))).toThrow(
      "runtime.interval must be a positive integer",
    );
    expect(() =>
      parse(BASE.replace("reason: {timeout: 300}", "reason: {timeout: 300, max_intents: 0}")),
    ).toThrow("tasks.reason.max_intents must be a positive integer");
  });

  test("validates the worker section", () => {
    expect(() => parse(BASE + "worker: {soft_deadline_ratio: 1}\n")).toThrow(
      "worker.soft_deadline_ratio must be a number between 0 and 1",
    );
    expect(() => parse(BASE + "worker: {retain_task_files: yes}\n")).toThrow(
      "worker.retain_task_files must be a boolean",
    );
    expect(() => parse(BASE + "worker: {result_grace_seconds: -1}\n")).toThrow(
      "worker.result_grace_seconds must be a non-negative integer",
    );
    expect(() => parse(BASE + "worker: {scoped_artifacts: yes}\n")).toThrow(
      "worker.scoped_artifacts must be a boolean",
    );
  });

  test("validates worker profiles and selection", () => {
    expect(() => parse(BASE + "worker_profiles: {}\n")).toThrow(
      "worker_profiles must be an array",
    );
    expect(() =>
      parse(BASE + "worker_profiles: [{id: '', model: m}]\n"),
    ).toThrow("worker_profiles[0].id must not be empty");
    expect(() =>
      parse(BASE + "worker_profiles: [{id: 'bad id', model: m}]\n"),
    ).toThrow("worker_profiles[0].id must be at most");
    expect(() =>
      parse(
        BASE +
          "worker_profiles: [{id: dup, model: a}, {id: dup, model: b}]\n",
      ),
    ).toThrow('duplicates profile "dup"');
    expect(() =>
      parse(BASE + "worker_profiles: [{id: fast}]\n"),
    ).toThrow("worker_profiles[0].model is required");
    expect(() =>
      parse(BASE + "worker_selection: {mode: stats}\n"),
    ).toThrow("stats requires at least one worker_profiles entry");
    expect(() =>
      parse(BASE + "worker_selection: {mode: random}\n"),
    ).toThrow("worker_selection.mode must be one of: prompt, stats");
    expect(() =>
      parse(BASE + "worker_selection: {min_runs: -1}\n"),
    ).toThrow("worker_selection.min_runs must be a non-negative integer");
  });

  test("validates common_env values", () => {
    expect(() => parse(BASE + "common_env: {PORT: 8080}\n")).toThrow(
      "common_env.PORT must be a string",
    );
  });

  test("validates prompt resources", () => {
    expect(() => parse(BASE.replace("prompt_group: default", "prompt_group: missing"))).toThrow(
      "missing prompt group: missing",
    );
  });

  test("wraps prompt-placeholder errors as ConfigError", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-config-prompts-"));
    try {
      mkdirSync(join(root, "default"));
      for (const [name, tokens] of Object.entries(DEFAULT_PROMPT_REQUIRED_TOKENS)) {
        writeFileSync(join(root, "default", name), tokens.join(" "));
      }
      writeFileSync(join(root, "default", "bootstrap.md"), "{origin} {goal}");
      expect(() => parse(BASE, { promptsRoot: root })).toThrow(ConfigError);
      expect(() => parse(BASE, { promptsRoot: root })).toThrow(
        "missing placeholders: {hints}",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports unreadable files and invalid YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-config-"));
    try {
      expect(() => loadDispatchConfig(join(dir, "missing.yaml"))).toThrow(
        "cannot read config",
      );
      const bad = join(dir, "bad.yaml");
      writeFileSync(bad, "server: [\n");
      expect(() => loadDispatchConfig(bad)).toThrow("invalid YAML");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
