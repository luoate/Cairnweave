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
    });
    expect(config.retention).toEqual({
      sessionMaxAgeDays: 0,
      sessionKeepPerProject: 0,
      sweepIntervalSeconds: 3600,
      refreshArtifacts: false,
    });
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
    });
    expect(config.commonEnv).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_COLOR: "",
    });
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
