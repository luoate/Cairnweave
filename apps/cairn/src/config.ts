/**
 * Dispatcher configuration.
 *
 * The shape follows Cairn's `dispatch.yaml` for the sections that still apply:
 * `server`, `runtime`, `tasks`, `container`, `local`, `common_env`. The per-worker
 * list and `WORKER_ENV_KEYS` are gone because the merged runtime has exactly one
 * worker implementation. A small `worker` section adds runner-specific knobs.
 *
 * Field names in TypeScript are camelCase; YAML keys keep Cairn's snake_case.
 */

import { readFileSync } from "node:fs";
import { validatePromptResources } from "./prompts/prompting";

export type ExecutionMode = "container" | "local";
export type WorkerHealthcheckMode = "startup_and_task" | "startup_only" | "disabled";
export type CompletedAction = "remove" | "stop";
export type LocalCompletedAction = "keep" | "remove";

export interface RuntimeConfig {
  maxWorkers: number;
  maxRunningProjects: number;
  maxProjectWorkers: number;
  interval: number;
  healthcheckTimeout: number;
  workerHealthcheck: WorkerHealthcheckMode;
  execution: ExecutionMode;
  promptGroup: string;
}

export interface BootstrapTaskConfig {
  timeout: number;
  concludeTimeout: number;
}

export interface ReasonTaskConfig {
  timeout: number;
  maxIntents: number;
}

export interface ExploreTaskConfig {
  timeout: number;
  concludeTimeout: number;
}

export interface GraphSliceConfig {
  /**
   * Opt-in: explore (and explore conclude) tasks receive a focused subgraph instead of
   * the full graph. Off by default so the exported graph stays identical to Cairn.
   */
  enabled: boolean;
  /** Soft cap; the focus intent and other open intents are never dropped. */
  maxFacts: number;
  /** Soft cap; open intents and provenance intents within the fact cap are kept. */
  maxIntents: number;
}

export interface EvidenceConfig {
  /**
   * Smallest accepted evidence file in bytes; 0 disables the check. Empty and tiny
   * files are usually placeholders, so the default rejects zero-byte evidence.
   */
  minBytes: number;
}

export interface TasksConfig {
  bootstrap: BootstrapTaskConfig;
  reason: ReasonTaskConfig;
  explore: ExploreTaskConfig;
  graphSlice: GraphSliceConfig;
  evidence: EvidenceConfig;
}

export const DEFAULT_GRAPH_SLICE: GraphSliceConfig = {
  enabled: false,
  maxFacts: 80,
  maxIntents: 60,
};

export const DEFAULT_EVIDENCE: EvidenceConfig = { minBytes: 1 };

export type ObserverTaskKind = "bootstrap" | "reason" | "explore" | "conclude";

/**
 * Opt-in Observer sidecar. It maintains a project-level ideas/memory board and runs a
 * separate model review; it never writes the graph or changes the task result.
 */
export interface ObserverConfig {
  enabled: boolean;
  /** model-prefs.json entry for the review model; null reuses the prompt model. */
  model: string | null;
  /** Assistant rounds between periodic reviews. */
  everyRounds: number;
  /** Number of recent rounds included in one review. */
  windowRounds: number;
  /** Upper bound for one review (and for the final flush). */
  timeoutSeconds: number;
  /** Hard cap on reviews executed for one task. */
  maxReviewsPerTask: number;
  /** Task kinds that get the observer. Defaults to explore only. */
  kernelTasks: ObserverTaskKind[];
}

export const DEFAULT_OBSERVER: ObserverConfig = {
  enabled: false,
  model: null,
  everyRounds: 4,
  windowRounds: 8,
  timeoutSeconds: 60,
  maxReviewsPerTask: 8,
  kernelTasks: ["explore"],
};

export const OBSERVER_TASK_KINDS: readonly ObserverTaskKind[] = [
  "bootstrap",
  "reason",
  "explore",
  "conclude",
];

export interface ContainerConfig {
  image: string;
  networkMode: string;
  completedAction: CompletedAction;
  capAdd: string[];
  /**
   * Host directory whose `<project_id>` children are mounted into containers. M3
   * extension (Cairn's container section did not need a host path); defaults to the
   * control plane's cwd.
   */
  workspaceRoot: string | null;
  /**
   * Container-side argv prefix for one worker task; the worker-view task.json path is
   * appended. The default matches the image built from `Dockerfile.worker`.
   */
  workerArgv: string[];
}

export const DEFAULT_CONTAINER_WORKER_ARGV = [
  "bun",
  "/app/apps/cairn/src/cli.ts",
  "worker",
  "--task",
] as const;

export interface LocalConfig {
  workspaceRoot: string | null;
  completedAction: LocalCompletedAction;
}

/** Runner-specific settings for the single merged worker implementation. */
export interface WorkerRunnerConfig {
  /**
   * Fraction of a task's hard deadline written into task.json as
   * `softDeadlineSeconds`; the supervisor currently only logs it (steering is M4).
   */
  softDeadlineRatio: number;
  /** Keep task.json/result.json after a task finishes (useful for audit). */
  retainTaskFiles: boolean;
  /** How long the control plane waits for result.json after the worker exits. */
  resultGraceSeconds: number;
}

export interface DispatchConfig {
  /** Accepted for compatibility; the in-process scheduler does not call this endpoint. */
  server: string;
  commonEnv: Record<string, string>;
  runtime: RuntimeConfig;
  tasks: TasksConfig;
  container: ContainerConfig | null;
  local: LocalConfig | null;
  worker: WorkerRunnerConfig;
  observer: ObserverConfig;
}

export interface ConfigOptions {
  /** Override the prompt directory (tests). Defaults to the bundled prompts. */
  promptsRoot?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TOP_LEVEL_KEYS = new Set([
  "server",
  "common_env",
  "runtime",
  "tasks",
  "container",
  "local",
  "worker",
  "observer",
]);

type Mapping = Record<string, unknown>;

function isRecord(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, path: string): Mapping {
  if (!isRecord(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value;
}

function has(mapping: Mapping, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(mapping, key);
}

function requiredValue(mapping: Mapping, key: string, path: string): unknown {
  if (!has(mapping, key)) {
    throw new ConfigError(`${path}.${key} is required`);
  }
  return mapping[key];
}

function requiredObject(mapping: Mapping, key: string, path: string): Mapping {
  return recordAt(requiredValue(mapping, key, path), `${path}.${key}`);
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string") {
    throw new ConfigError(`${path} must be a string`);
  }
  if (!allowEmpty && value.trim() === "") {
    throw new ConfigError(`${path} must not be empty`);
  }
  return value;
}

function requiredString(mapping: Mapping, key: string, path: string): string {
  return stringAt(requiredValue(mapping, key, path), `${path}.${key}`);
}

function optionalString(mapping: Mapping, key: string, path: string): string | null {
  if (!has(mapping, key) || mapping[key] === null) {
    return null;
  }
  return stringAt(mapping[key], `${path}.${key}`, true);
}

function positiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${path} must be a positive integer`);
  }
  return value;
}

function requiredPositiveInt(mapping: Mapping, key: string, path: string): number {
  return positiveInt(requiredValue(mapping, key, path), `${path}.${key}`);
}

function nonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${path} must be a non-negative integer`);
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ConfigError(`${path} must be a boolean`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${path} must be an array of strings`);
  }
  return value.map((item, index) => stringAt(item, `${path}[${index}]`, true));
}

function stringMap(value: unknown, path: string): Record<string, string> {
  const mapping = recordAt(value, path);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(mapping)) {
    if (typeof entry !== "string") {
      throw new ConfigError(`${path}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

function parseRuntime(value: unknown): RuntimeConfig {
  const runtime = recordAt(value, "runtime");
  const maxWorkers = requiredPositiveInt(runtime, "max_workers", "runtime");
  const maxProjectWorkers = requiredPositiveInt(runtime, "max_project_workers", "runtime");
  if (maxProjectWorkers > maxWorkers) {
    throw new ConfigError("runtime.max_project_workers cannot exceed runtime.max_workers");
  }
  return {
    maxWorkers,
    maxRunningProjects: requiredPositiveInt(runtime, "max_running_projects", "runtime"),
    maxProjectWorkers,
    interval: requiredPositiveInt(runtime, "interval", "runtime"),
    healthcheckTimeout: requiredPositiveInt(runtime, "healthcheck_timeout", "runtime"),
    workerHealthcheck: has(runtime, "worker_healthcheck")
      ? oneOf(runtime["worker_healthcheck"], "runtime.worker_healthcheck", [
          "startup_and_task",
          "startup_only",
          "disabled",
        ] as const)
      : "startup_only",
    execution: has(runtime, "execution")
      ? oneOf(runtime["execution"], "runtime.execution", ["container", "local"] as const)
      : "container",
    promptGroup: requiredString(runtime, "prompt_group", "runtime"),
  };
}

function parseTasks(value: unknown): TasksConfig {
  const tasks = recordAt(value, "tasks");
  const bootstrap = requiredObject(tasks, "bootstrap", "tasks");
  const reason = requiredObject(tasks, "reason", "tasks");
  const explore = requiredObject(tasks, "explore", "tasks");
  return {
    bootstrap: {
      timeout: requiredPositiveInt(bootstrap, "timeout", "tasks.bootstrap"),
      concludeTimeout: requiredPositiveInt(
        bootstrap,
        "conclude_timeout",
        "tasks.bootstrap",
      ),
    },
    reason: {
      timeout: requiredPositiveInt(reason, "timeout", "tasks.reason"),
      maxIntents: has(reason, "max_intents")
        ? requiredPositiveInt(reason, "max_intents", "tasks.reason")
        : 3,
    },
    explore: {
      timeout: requiredPositiveInt(explore, "timeout", "tasks.explore"),
      concludeTimeout: requiredPositiveInt(explore, "conclude_timeout", "tasks.explore"),
    },
    graphSlice: has(tasks, "graph_slice")
      ? parseGraphSlice(tasks["graph_slice"])
      : { ...DEFAULT_GRAPH_SLICE },
    evidence: has(tasks, "evidence")
      ? parseEvidence(tasks["evidence"])
      : { ...DEFAULT_EVIDENCE },
  };
}

function parseEvidence(value: unknown): EvidenceConfig {
  const evidence = recordAt(value, "tasks.evidence");
  return {
    minBytes: has(evidence, "min_bytes")
      ? nonNegativeInt(evidence["min_bytes"], "tasks.evidence.min_bytes")
      : DEFAULT_EVIDENCE.minBytes,
  };
}

function parseGraphSlice(value: unknown): GraphSliceConfig {
  const slice = recordAt(value, "tasks.graph_slice");
  const maxFacts = has(slice, "max_facts")
    ? requiredPositiveInt(slice, "max_facts", "tasks.graph_slice")
    : DEFAULT_GRAPH_SLICE.maxFacts;
  const maxIntents = has(slice, "max_intents")
    ? requiredPositiveInt(slice, "max_intents", "tasks.graph_slice")
    : DEFAULT_GRAPH_SLICE.maxIntents;
  if (maxFacts < 2) {
    throw new ConfigError("tasks.graph_slice.max_facts must be at least 2 (origin and goal)");
  }
  return {
    enabled: has(slice, "enabled")
      ? booleanAt(slice["enabled"], "tasks.graph_slice.enabled")
      : DEFAULT_GRAPH_SLICE.enabled,
    maxFacts,
    maxIntents,
  };
}

function parseContainer(value: unknown): ContainerConfig {
  const container = recordAt(value, "container");
  const capAdd = has(container, "cap_add")
    ? stringList(container["cap_add"], "container.cap_add")
    : [];
  const workerArgv = has(container, "worker_argv")
    ? stringList(container["worker_argv"], "container.worker_argv")
    : [...DEFAULT_CONTAINER_WORKER_ARGV];
  if (workerArgv.length === 0) {
    throw new ConfigError("container.worker_argv must not be empty");
  }
  return {
    image: requiredString(container, "image", "container"),
    networkMode: requiredString(container, "network_mode", "container"),
    completedAction: oneOf(
      requiredValue(container, "completed_action", "container"),
      "container.completed_action",
      ["remove", "stop"] as const,
    ),
    capAdd,
    workspaceRoot: optionalString(container, "workspace_root", "container"),
    workerArgv,
  };
}

function parseLocal(value: unknown): LocalConfig {
  const local = recordAt(value, "local");
  return {
    workspaceRoot: optionalString(local, "workspace_root", "local"),
    completedAction: has(local, "completed_action")
      ? oneOf(local["completed_action"], "local.completed_action", [
          "keep",
          "remove",
        ] as const)
      : "keep",
  };
}

function parseObserverTaskKinds(value: unknown): ObserverTaskKind[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("observer.kernel_tasks must be an array of task kinds");
  }
  return value.map((item, index) =>
    oneOf(item, `observer.kernel_tasks[${index}]`, OBSERVER_TASK_KINDS),
  );
}

function parseObserver(value: unknown): ObserverConfig {
  const observer = recordAt(value, "observer");
  const model =
    has(observer, "model") && observer["model"] !== null
      ? stringAt(observer["model"], "observer.model")
      : DEFAULT_OBSERVER.model;
  return {
    enabled: has(observer, "enabled")
      ? booleanAt(observer["enabled"], "observer.enabled")
      : DEFAULT_OBSERVER.enabled,
    model,
    everyRounds: has(observer, "every_rounds")
      ? requiredPositiveInt(observer, "every_rounds", "observer")
      : DEFAULT_OBSERVER.everyRounds,
    windowRounds: has(observer, "window_rounds")
      ? requiredPositiveInt(observer, "window_rounds", "observer")
      : DEFAULT_OBSERVER.windowRounds,
    timeoutSeconds: has(observer, "timeout_seconds")
      ? requiredPositiveInt(observer, "timeout_seconds", "observer")
      : DEFAULT_OBSERVER.timeoutSeconds,
    maxReviewsPerTask: has(observer, "max_reviews_per_task")
      ? nonNegativeInt(observer["max_reviews_per_task"], "observer.max_reviews_per_task")
      : DEFAULT_OBSERVER.maxReviewsPerTask,
    kernelTasks: has(observer, "kernel_tasks")
      ? parseObserverTaskKinds(observer["kernel_tasks"])
      : [...DEFAULT_OBSERVER.kernelTasks],
  };
}

function parseWorker(value: unknown): WorkerRunnerConfig {
  const worker = recordAt(value, "worker");
  let softDeadlineRatio = 0.8;
  if (has(worker, "soft_deadline_ratio")) {
    const raw = worker["soft_deadline_ratio"];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw >= 1) {
      throw new ConfigError("worker.soft_deadline_ratio must be a number between 0 and 1");
    }
    softDeadlineRatio = raw;
  }
  return {
    softDeadlineRatio,
    retainTaskFiles: has(worker, "retain_task_files")
      ? booleanAt(worker["retain_task_files"], "worker.retain_task_files")
      : true,
    resultGraceSeconds: has(worker, "result_grace_seconds")
      ? nonNegativeInt(worker["result_grace_seconds"], "worker.result_grace_seconds")
      : 15,
  };
}

export function parseDispatchConfig(value: unknown, options: ConfigOptions = {}): DispatchConfig {
  const root = recordAt(value ?? {}, "config");

  if (has(root, "workers")) {
    throw new ConfigError(
      "config 'workers' is no longer supported; remove it (the merged runtime has one worker implementation)",
    );
  }
  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(`config has unknown key: ${key}`);
    }
  }

  const runtime = parseRuntime(requiredValue(root, "runtime", "config"));
  const tasks = parseTasks(requiredValue(root, "tasks", "config"));

  let container: ContainerConfig | null = null;
  if (has(root, "container")) {
    container = parseContainer(root["container"]);
  }
  if (runtime.execution === "container" && container === null) {
    throw new ConfigError("container config is required when runtime.execution is container");
  }

  let local: LocalConfig | null = null;
  if (has(root, "local")) {
    local = parseLocal(root["local"]);
  } else if (runtime.execution === "local") {
    local = { workspaceRoot: null, completedAction: "keep" };
  }

  const commonEnv = has(root, "common_env")
    ? stringMap(root["common_env"], "common_env")
    : {};

  const worker = has(root, "worker")
    ? parseWorker(root["worker"])
    : { softDeadlineRatio: 0.8, retainTaskFiles: true, resultGraceSeconds: 15 };

  const observer = has(root, "observer")
    ? parseObserver(root["observer"])
    : { ...DEFAULT_OBSERVER, kernelTasks: [...DEFAULT_OBSERVER.kernelTasks] };

  try {
    validatePromptResources(runtime.promptGroup, options.promptsRoot);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }

  return {
    server: requiredString(root, "server", "config"),
    commonEnv,
    runtime,
    tasks,
    container,
    local,
    worker,
    observer,
  };
}

export function loadDispatchConfig(path: string, options: ConfigOptions = {}): DispatchConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read config ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${path}: ${(error as Error).message}`);
  }
  return parseDispatchConfig(parsed, options);
}
