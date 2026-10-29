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
 * Observer sidecar. It maintains a project-level ideas/memory board and runs a separate
 * model review; it never writes the graph or changes the task result. Enabled by default
 * because review-only sidecars cannot corrupt a solve (proposals stay opt-in).
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
  enabled: true,
  model: null,
  everyRounds: 4,
  windowRounds: 8,
  timeoutSeconds: 60,
  maxReviewsPerTask: 8,
  kernelTasks: ["explore"],
};

/**
 * Control-plane housekeeping. Zero/disabled values keep the historical behavior; the
 * startup reconciliation of `pending_concludes` always runs because it only removes
 * entries that can no longer be dispatched.
 */
export interface RetentionConfig {
  /** Delete finished session directories older than this; 0 disables the age rule. */
  sessionMaxAgeDays: number;
  /** Keep at most this many session directories per project; 0 disables the count rule. */
  sessionKeepPerProject: number;
  /** Seconds between background sweeps; 0 disables periodic sweeps. */
  sweepIntervalSeconds: number;
  /** Re-scan `<workspace>/artifacts` during every sweep. */
  refreshArtifacts: boolean;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  sessionMaxAgeDays: 0,
  sessionKeepPerProject: 0,
  sweepIntervalSeconds: 3600,
  refreshArtifacts: false,
};

/**
 * Opt-in live audit streaming. Workers keep writing `audit.jsonl`, but also POST each
 * `tool_call` decision to the control plane as it happens, using a per-task bearer token.
 * The finish-time file import stays as the backfill. Disabled by default because it needs
 * a control-plane URL that is reachable from the worker (not just the host).
 */
export interface AuditStreamConfig {
  enabled: boolean;
  /** Overrides the derived control-plane URL; required when containers cannot guess it. */
  url: string | null;
}

export const DEFAULT_AUDIT_STREAM: AuditStreamConfig = {
  enabled: false,
  url: null,
};

/**
 * Completion verification. The policy is chosen per project when it is created
 * (`challenge`, `evidence`, or `off`), and `evidence_enforcement` supplies the default
 * for projects created through the API and for legacy projects without a policy row.
 * It only decides whether the evidence rule runs at completion time; exploration stays
 * lenient. Credentials are read from the named environment variables at verification
 * time and never stored here.
 */
export type EvidenceEnforcement = "completion" | "off";

export const EVIDENCE_ENFORCEMENT_MODES: readonly EvidenceEnforcement[] = [
  "completion",
  "off",
];

export interface ChallengeVerifierConfig {
  baseUrlEnv: string;
  agentTokenEnv: string;
  /** Environment variable naming the current challenge; enables automatic challenge policy. */
  codeEnv: string;
  timeoutMs: number;
}

export interface VerificationConfig {
  /** `completion` requires evidence before a project may close; `off` disables it. */
  evidenceEnforcement: EvidenceEnforcement;
  challenge: ChallengeVerifierConfig;
}

export const DEFAULT_VERIFICATION: VerificationConfig = {
  evidenceEnforcement: "completion",
  challenge: {
    baseUrlEnv: "TCH_CHALLENGE_API_BASE_URL",
    agentTokenEnv: "TCH_CHALLENGE_AGENT_TOKEN",
    codeEnv: "TCH_CHALLENGE_ID",
    timeoutMs: 5000,
  },
};

/** Maps the completion-evidence switch to the per-project oracle policy. */
export function defaultVerificationKind(
  config: VerificationConfig,
): "evidence" | "off" {
  return config.evidenceEnforcement === "off" ? "off" : "evidence";
}

export interface DefaultVerificationPolicy {
  kind: "challenge" | "evidence" | "off";
  challenge_code?: string;
}

/**
 * Policy for `POST /projects` when the request omits `verification`. A challenge
 * environment (BreachWeave's `TCH_CHALLENGE_ID`) is the strongest signal, so it wins
 * over the generic evidence switch; otherwise the switch decides evidence vs off.
 */
export function defaultVerificationPolicy(
  config: VerificationConfig,
  env: Record<string, string | undefined>,
): DefaultVerificationPolicy {
  const code = env[config.challenge.codeEnv]?.trim() ?? "";
  if (code !== "") return { kind: "challenge", challenge_code: code };
  return { kind: defaultVerificationKind(config) };
}

export type ProposalMode = "off" | "dry_run" | "apply";
export type ProposalKindConfig = "fact" | "intent" | "hint";

/**
 * Observer/Strategist candidate proposals. Disabled by default. `dry_run` records the
 * control plane's decision without touching the graph, which is the recommended first
 * step when validating a new Observer model.
 */
export interface ProposalsConfig {
  enabled: boolean;
  mode: ProposalMode;
  maxPerTask: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  allowKinds: ProposalKindConfig[];
  requireEvidenceForFact: boolean;
  minConfidence: number;
}

export const DEFAULT_PROPOSALS: ProposalsConfig = {
  enabled: false,
  mode: "apply",
  maxPerTask: 20,
  maxFileBytes: 16 * 1024,
  maxTotalBytes: 64 * 1024,
  allowKinds: ["fact", "intent", "hint"],
  requireEvidenceForFact: true,
  minConfidence: 0,
};

export const PROPOSAL_MODES: readonly ProposalMode[] = ["off", "dry_run", "apply"];
export const PROPOSAL_KINDS: readonly ProposalKindConfig[] = ["fact", "intent", "hint"];

/**
 * Slow-layer (reason/Strategist) trigger policy. `initial` and "all open intents are
 * gone" are urgent and bypass the cooldown and hourly cap; failure backoff still applies.
 * Zero disables the corresponding optional trigger/limit.
 */
export interface StrategistConfig {
  /** Minimum new facts since the last successful reason turn. */
  minNewFacts: number;
  /** Minimum new hints since the last successful reason turn. */
  minNewHints: number;
  /** Minimum seconds between non-urgent reason turns; 0 disables. */
  cooldownSeconds: number;
  /** Seconds to wait after a failed/rejected reason turn; 0 disables. */
  failureBackoffSeconds: number;
  /** Maximum non-urgent reason runs started per rolling hour; 0 disables. */
  maxRunsPerHour: number;
  /** Consecutive finished productive tasks without a fact before a reason turn; 0 disables. */
  zeroOutputThreshold: number;
  /** Trigger when every open intent is older than this and idle; 0 disables. */
  staleIntentSeconds: number;
  /** Trigger after this long without a successful reason turn; 0 disables. */
  fallbackIntervalSeconds: number;
  /** Trigger when finished-run token or cost usage reaches this fraction of its limit. */
  resourcePressureRatio: number;
}

export const DEFAULT_STRATEGIST: StrategistConfig = {
  minNewFacts: 1,
  minNewHints: 1,
  cooldownSeconds: 30,
  failureBackoffSeconds: 120,
  maxRunsPerHour: 12,
  zeroOutputThreshold: 3,
  staleIntentSeconds: 0,
  fallbackIntervalSeconds: 0,
  resourcePressureRatio: 0,
};

/**
 * Per-project cost/concurrency guardrails. These are defaults applied independently to
 * every project; they are not a global pool. `0` disables the token/cost ceiling and makes
 * the task ceiling fall back to `runtime.max_project_workers`.
 *
 * Token/cost totals include finished runs only. Tasks already in flight have not reported
 * usage yet, so a project can overshoot by the usage of its currently running tasks; the
 * next dispatch after they finish observes the full total.
 */
export interface BudgetConfig {
  /** Stop dispatching new reason/explore/bootstrap work at this many total tokens. */
  maxProjectTokens: number;
  /** Stop dispatching at this total model cost (provider-reported, USD). */
  maxProjectCostUsd: number;
  /** Maximum concurrent tasks for one project; 0 uses runtime.max_project_workers. */
  maxProjectTasks: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  maxProjectTokens: 0,
  maxProjectCostUsd: 0,
  maxProjectTasks: 0,
};

export type WorkerSelectionMode = "prompt" | "stats";

/**
 * A named dispatch profile. The merged runtime has one worker implementation, so a
 * profile currently selects only the model-prefs entry the solver should use. The id is
 * recorded on every run and is the key for per-profile statistics.
 */
export interface WorkerProfileConfig {
  id: string;
  /** model-prefs.json entry name (for example `cairn-worker`). */
  model: string;
}

/**
 * How dispatch picks a worker profile. `prompt` keeps the model declared in the prompt
 * frontmatter and leaves runs untagged. `stats` samples every profile up to `min_runs`
 * finished runs, then exploits the observed best performer with a decaying epsilon
 * exploration budget. Exploration is a deterministic function of the finished-run count,
 * so a dispatch stays reproducible from run history.
 */
export interface WorkerSelectionConfig {
  mode: WorkerSelectionMode;
  /** Finished runs a profile needs before it is eligible for exploitation. */
  minRuns: number;
  /** Exploration probability per eligible dispatch before decay; 0 disables exploration. */
  epsilon: number;
  /** Per-eligible-dispatch multiplier applied to `epsilon`; 1 keeps it constant. */
  epsilonDecay: number;
  /** Exploration floor; 0 lets decay retire exploration entirely. */
  epsilonMin: number;
}

export const DEFAULT_WORKER_SELECTION: WorkerSelectionConfig = {
  mode: "prompt",
  minRuns: 3,
  // Conservative epsilon-greedy defaults: 10% exploration after sampling, decaying
  // towards a 1% floor so a project never locks onto an early leader.
  epsilon: 0.1,
  epsilonDecay: 0.99,
  epsilonMin: 0.01,
};

export const WORKER_SELECTION_MODES: readonly WorkerSelectionMode[] = ["prompt", "stats"];

export const MAX_WORKER_PROFILE_ID_LENGTH = 64;
export const MAX_WORKER_MODEL_PREF_LENGTH = 128;

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
  /**
   * Give every task its own `artifacts/<task-id>/` write namespace. Defaults to on when
   * `runtime.max_project_workers > 1`, because concurrent tasks otherwise overwrite each
   * other's evidence; explicit `false` opts out.
   */
  scopedArtifacts: boolean;
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
  retention: RetentionConfig;
  auditStream: AuditStreamConfig;
  verification: VerificationConfig;
  proposals: ProposalsConfig;
  strategist: StrategistConfig;
  budget: BudgetConfig;
  workerProfiles: WorkerProfileConfig[];
  workerSelection: WorkerSelectionConfig;
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
  "retention",
  "audit_stream",
  "verification",
  "proposals",
  "strategist",
  "budget",
  "worker_profiles",
  "worker_selection",
]);

/**
 * Sections an operator may override at runtime from the web UI. The stored patch keeps
 * dispatch.yaml's snake_case shape; it is merged onto the parsed document and re-parsed,
 * so these validators stay the only source of truth. Deployment settings (execution,
 * container, credentials, Observer, audit stream, prompt group, worker profiles) remain
 * file-only and need a restart.
 */
const EDITABLE_OVERRIDE_KEYS: Record<string, readonly string[]> = {
  runtime: ["max_workers", "max_running_projects", "max_project_workers", "interval"],
  tasks: ["bootstrap", "reason", "explore", "graph_slice", "evidence"],
  worker: [
    "soft_deadline_ratio",
    "retain_task_files",
    "result_grace_seconds",
    "scoped_artifacts",
  ],
  retention: [
    "session_max_age_days",
    "session_keep_per_project",
    "sweep_interval_seconds",
    "refresh_artifacts",
  ],
  verification: ["evidence_enforcement"],
  proposals: [
    "enabled",
    "mode",
    "max_per_task",
    "max_file_bytes",
    "max_total_bytes",
    "allow_kinds",
    "require_evidence_for_fact",
    "min_confidence",
  ],
  strategist: [
    "min_new_facts",
    "min_new_hints",
    "cooldown_seconds",
    "failure_backoff_seconds",
    "max_runs_per_hour",
    "zero_output_threshold",
    "stale_intent_seconds",
    "fallback_interval_seconds",
    "resource_pressure_ratio",
  ],
  budget: ["max_project_tokens", "max_project_cost_usd", "max_project_tasks"],
  worker_selection: ["mode", "min_runs", "epsilon", "epsilon_decay", "epsilon_min"],
};

const EDITABLE_TASK_KEYS: Record<string, readonly string[]> = {
  bootstrap: ["timeout", "conclude_timeout"],
  reason: ["timeout", "max_intents"],
  explore: ["timeout", "conclude_timeout"],
  graph_slice: ["enabled", "max_facts", "max_intents"],
  evidence: ["min_bytes"],
};

/** Snake_case patch accepted by `RuntimeConfigStore.apply`; see `EDITABLE_OVERRIDE_KEYS`. */
export type RuntimeOverridePatch = Record<string, unknown>;

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

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${path} must be a non-negative number`);
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

function parseRetention(value: unknown): RetentionConfig {
  const retention = recordAt(value, "retention");
  return {
    sessionMaxAgeDays: has(retention, "session_max_age_days")
      ? nonNegativeInt(retention["session_max_age_days"], "retention.session_max_age_days")
      : DEFAULT_RETENTION.sessionMaxAgeDays,
    sessionKeepPerProject: has(retention, "session_keep_per_project")
      ? nonNegativeInt(
          retention["session_keep_per_project"],
          "retention.session_keep_per_project",
        )
      : DEFAULT_RETENTION.sessionKeepPerProject,
    sweepIntervalSeconds: has(retention, "sweep_interval_seconds")
      ? nonNegativeInt(
          retention["sweep_interval_seconds"],
          "retention.sweep_interval_seconds",
        )
      : DEFAULT_RETENTION.sweepIntervalSeconds,
    refreshArtifacts: has(retention, "refresh_artifacts")
      ? booleanAt(retention["refresh_artifacts"], "retention.refresh_artifacts")
      : DEFAULT_RETENTION.refreshArtifacts,
  };
}

function parseAuditStream(value: unknown): AuditStreamConfig {
  const stream = recordAt(value, "audit_stream");
  const url = optionalString(stream, "url", "audit_stream");
  if (url !== null) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConfigError("audit_stream.url must be a valid http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConfigError("audit_stream.url must be a valid http(s) URL");
    }
  }
  return {
    enabled: has(stream, "enabled")
      ? booleanAt(stream["enabled"], "audit_stream.enabled")
      : DEFAULT_AUDIT_STREAM.enabled,
    url,
  };
}

function parseVerification(value: unknown): VerificationConfig {
  const root = recordAt(value, "verification");
  const defaults = DEFAULT_VERIFICATION.challenge;
  const evidenceEnforcement = has(root, "evidence_enforcement")
    ? oneOf(
        root["evidence_enforcement"],
        "verification.evidence_enforcement",
        EVIDENCE_ENFORCEMENT_MODES,
      )
    : DEFAULT_VERIFICATION.evidenceEnforcement;
  if (!has(root, "challenge")) {
    return { evidenceEnforcement, challenge: { ...defaults } };
  }
  const challenge = recordAt(root["challenge"], "verification.challenge");
  return {
    evidenceEnforcement,
    challenge: {
      baseUrlEnv: has(challenge, "base_url_env")
        ? requiredString(challenge, "base_url_env", "verification.challenge")
        : defaults.baseUrlEnv,
      agentTokenEnv: has(challenge, "agent_token_env")
        ? requiredString(challenge, "agent_token_env", "verification.challenge")
        : defaults.agentTokenEnv,
      codeEnv: has(challenge, "code_env")
        ? requiredString(challenge, "code_env", "verification.challenge")
        : defaults.codeEnv,
      timeoutMs: has(challenge, "timeout_ms")
        ? requiredPositiveInt(challenge, "timeout_ms", "verification.challenge")
        : defaults.timeoutMs,
    },
  };
}

function parseProposalKinds(value: unknown): ProposalKindConfig[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("proposals.allow_kinds must be an array of proposal kinds");
  }
  return value.map((item, index) =>
    oneOf(item, `proposals.allow_kinds[${index}]`, PROPOSAL_KINDS),
  );
}

function unitInterval(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigError(`${path} must be a number between 0 and 1`);
  }
  return value;
}

function positiveUnitInterval(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigError(`${path} must be a number greater than 0 and at most 1`);
  }
  return value;
}

function parseProposals(value: unknown): ProposalsConfig {
  const proposals = recordAt(value, "proposals");
  const maxFileBytes = has(proposals, "max_file_bytes")
    ? requiredPositiveInt(proposals, "max_file_bytes", "proposals")
    : DEFAULT_PROPOSALS.maxFileBytes;
  const maxTotalBytes = has(proposals, "max_total_bytes")
    ? requiredPositiveInt(proposals, "max_total_bytes", "proposals")
    : DEFAULT_PROPOSALS.maxTotalBytes;
  if (maxTotalBytes < maxFileBytes) {
    throw new ConfigError("proposals.max_total_bytes cannot be smaller than max_file_bytes");
  }
  return {
    enabled: has(proposals, "enabled")
      ? booleanAt(proposals["enabled"], "proposals.enabled")
      : DEFAULT_PROPOSALS.enabled,
    mode: has(proposals, "mode")
      ? oneOf(proposals["mode"], "proposals.mode", PROPOSAL_MODES)
      : DEFAULT_PROPOSALS.mode,
    maxPerTask: has(proposals, "max_per_task")
      ? nonNegativeInt(proposals["max_per_task"], "proposals.max_per_task")
      : DEFAULT_PROPOSALS.maxPerTask,
    maxFileBytes,
    maxTotalBytes,
    allowKinds: has(proposals, "allow_kinds")
      ? parseProposalKinds(proposals["allow_kinds"])
      : [...DEFAULT_PROPOSALS.allowKinds],
    requireEvidenceForFact: has(proposals, "require_evidence_for_fact")
      ? booleanAt(
          proposals["require_evidence_for_fact"],
          "proposals.require_evidence_for_fact",
        )
      : DEFAULT_PROPOSALS.requireEvidenceForFact,
    minConfidence: has(proposals, "min_confidence")
      ? unitInterval(proposals["min_confidence"], "proposals.min_confidence")
      : DEFAULT_PROPOSALS.minConfidence,
  };
}

function parseStrategist(value: unknown): StrategistConfig {
  const strategist = recordAt(value, "strategist");
  const intAt = (key: keyof StrategistConfig): number => {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return has(strategist, snake)
      ? nonNegativeInt(strategist[snake], `strategist.${snake}`)
      : DEFAULT_STRATEGIST[key];
  };
  return {
    minNewFacts: intAt("minNewFacts"),
    minNewHints: intAt("minNewHints"),
    cooldownSeconds: intAt("cooldownSeconds"),
    failureBackoffSeconds: intAt("failureBackoffSeconds"),
    maxRunsPerHour: intAt("maxRunsPerHour"),
    zeroOutputThreshold: intAt("zeroOutputThreshold"),
    staleIntentSeconds: intAt("staleIntentSeconds"),
    fallbackIntervalSeconds: intAt("fallbackIntervalSeconds"),
    resourcePressureRatio: has(strategist, "resource_pressure_ratio")
      ? unitInterval(
          strategist["resource_pressure_ratio"],
          "strategist.resource_pressure_ratio",
        )
      : DEFAULT_STRATEGIST.resourcePressureRatio,
  };
}

function parseBudget(value: unknown): BudgetConfig {
  const budget = recordAt(value, "budget");
  return {
    maxProjectTokens: has(budget, "max_project_tokens")
      ? nonNegativeInt(budget["max_project_tokens"], "budget.max_project_tokens")
      : DEFAULT_BUDGET.maxProjectTokens,
    maxProjectCostUsd: has(budget, "max_project_cost_usd")
      ? nonNegativeNumber(budget["max_project_cost_usd"], "budget.max_project_cost_usd")
      : DEFAULT_BUDGET.maxProjectCostUsd,
    maxProjectTasks: has(budget, "max_project_tasks")
      ? nonNegativeInt(budget["max_project_tasks"], "budget.max_project_tasks")
      : DEFAULT_BUDGET.maxProjectTasks,
  };
}

const WORKER_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseWorkerProfiles(value: unknown): WorkerProfileConfig[] {
  if (!Array.isArray(value)) {
    throw new ConfigError("worker_profiles must be an array");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const path = `worker_profiles[${index}]`;
    const profile = recordAt(item, path);
    const id = stringAt(requiredValue(profile, "id", path), `${path}.id`);
    if (
      id.length > MAX_WORKER_PROFILE_ID_LENGTH ||
      !WORKER_PROFILE_ID_PATTERN.test(id)
    ) {
      throw new ConfigError(
        `${path}.id must be at most ${MAX_WORKER_PROFILE_ID_LENGTH} characters of letters, digits, dot, underscore or dash`,
      );
    }
    if (seen.has(id)) {
      throw new ConfigError(`${path}.id duplicates profile "${id}"`);
    }
    seen.add(id);
    const model = stringAt(requiredValue(profile, "model", path), `${path}.model`);
    if (
      model.length > MAX_WORKER_MODEL_PREF_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(model)
    ) {
      throw new ConfigError(
        `${path}.model must be at most ${MAX_WORKER_MODEL_PREF_LENGTH} characters without control characters`,
      );
    }
    return { id, model };
  });
}

function parseWorkerSelection(value: unknown): WorkerSelectionConfig {
  const selection = recordAt(value, "worker_selection");
  const epsilon = has(selection, "epsilon")
    ? unitInterval(selection["epsilon"], "worker_selection.epsilon")
    : DEFAULT_WORKER_SELECTION.epsilon;
  const epsilonDecay = has(selection, "epsilon_decay")
    ? positiveUnitInterval(selection["epsilon_decay"], "worker_selection.epsilon_decay")
    : DEFAULT_WORKER_SELECTION.epsilonDecay;
  const epsilonMin = has(selection, "epsilon_min")
    ? unitInterval(selection["epsilon_min"], "worker_selection.epsilon_min")
    : DEFAULT_WORKER_SELECTION.epsilonMin;
  if (epsilonMin > epsilon) {
    throw new ConfigError(
      "worker_selection.epsilon_min must not exceed worker_selection.epsilon",
    );
  }
  return {
    mode: has(selection, "mode")
      ? oneOf(selection["mode"], "worker_selection.mode", WORKER_SELECTION_MODES)
      : DEFAULT_WORKER_SELECTION.mode,
    minRuns: has(selection, "min_runs")
      ? nonNegativeInt(selection["min_runs"], "worker_selection.min_runs")
      : DEFAULT_WORKER_SELECTION.minRuns,
    epsilon,
    epsilonDecay,
    epsilonMin,
  };
}

function parseWorker(value: unknown, scopedArtifactsDefault: boolean): WorkerRunnerConfig {
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
    scopedArtifacts: has(worker, "scoped_artifacts")
      ? booleanAt(worker["scoped_artifacts"], "worker.scoped_artifacts")
      : scopedArtifactsDefault,
  };
}

function checkOverrideKeys(
  mapping: Mapping,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`${path} has unsupported key: ${key}`);
    }
  }
}

/**
 * Validates the shape of a runtime override patch without applying it. Only the editable
 * paths are accepted so a typo cannot silently fall back to a default; value ranges are
 * checked later by re-parsing the merged document.
 */
export function parseRuntimeOverridePatch(value: unknown): RuntimeOverridePatch {
  const patch = recordAt(value ?? {}, "overrides");
  for (const section of Object.keys(patch)) {
    const allowed = EDITABLE_OVERRIDE_KEYS[section];
    if (allowed === undefined) {
      throw new ConfigError(`overrides has unsupported section: ${section}`);
    }
    const sectionValue = recordAt(patch[section], `overrides.${section}`);
    checkOverrideKeys(sectionValue, allowed, `overrides.${section}`);
    if (section !== "tasks") continue;
    for (const kind of Object.keys(sectionValue)) {
      const group = recordAt(sectionValue[kind], `overrides.tasks.${kind}`);
      checkOverrideKeys(
        group,
        EDITABLE_TASK_KEYS[kind]!,
        `overrides.tasks.${kind}`,
      );
    }
  }
  return structuredClone(patch) as RuntimeOverridePatch;
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

  const scopedArtifactsDefault = runtime.maxProjectWorkers > 1;
  const worker = has(root, "worker")
    ? parseWorker(root["worker"], scopedArtifactsDefault)
    : {
        softDeadlineRatio: 0.8,
        retainTaskFiles: true,
        resultGraceSeconds: 15,
        scopedArtifacts: scopedArtifactsDefault,
      };

  const observer = has(root, "observer")
    ? parseObserver(root["observer"])
    : { ...DEFAULT_OBSERVER, kernelTasks: [...DEFAULT_OBSERVER.kernelTasks] };

  const retention = has(root, "retention")
    ? parseRetention(root["retention"])
    : { ...DEFAULT_RETENTION };

  const auditStream = has(root, "audit_stream")
    ? parseAuditStream(root["audit_stream"])
    : { ...DEFAULT_AUDIT_STREAM };

  const verification = has(root, "verification")
    ? parseVerification(root["verification"])
    : {
        evidenceEnforcement: DEFAULT_VERIFICATION.evidenceEnforcement,
        challenge: { ...DEFAULT_VERIFICATION.challenge },
      };

  const proposals = has(root, "proposals")
    ? parseProposals(root["proposals"])
    : { ...DEFAULT_PROPOSALS, allowKinds: [...DEFAULT_PROPOSALS.allowKinds] };

  const strategist = has(root, "strategist")
    ? parseStrategist(root["strategist"])
    : { ...DEFAULT_STRATEGIST };

  const budget = has(root, "budget")
    ? parseBudget(root["budget"])
    : { ...DEFAULT_BUDGET };

  const workerProfiles = has(root, "worker_profiles")
    ? parseWorkerProfiles(root["worker_profiles"])
    : [];
  const workerSelection = has(root, "worker_selection")
    ? parseWorkerSelection(root["worker_selection"])
    : { ...DEFAULT_WORKER_SELECTION };
  if (workerSelection.mode === "stats" && workerProfiles.length === 0) {
    throw new ConfigError(
      "worker_selection.mode stats requires at least one worker_profiles entry",
    );
  }

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
    retention,
    auditStream,
    verification,
    proposals,
    strategist,
    budget,
    workerProfiles,
    workerSelection,
  };
}

export interface LoadedDispatchConfig {
  config: DispatchConfig;
  /**
   * Parsed YAML document before defaults are filled in. Runtime overrides are merged onto
   * this shape and re-parsed, so unchanged fields keep following the file.
   */
  source: Record<string, unknown>;
}

export function loadDispatchConfigWithSource(
  path: string,
  options: ConfigOptions = {},
): LoadedDispatchConfig {
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
  const config = parseDispatchConfig(parsed, options);
  return { config, source: recordAt(parsed ?? {}, "config") };
}

export function loadDispatchConfig(path: string, options: ConfigOptions = {}): DispatchConfig {
  return loadDispatchConfigWithSource(path, options).config;
}
