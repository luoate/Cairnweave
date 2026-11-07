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
export type StrategyContextMode = "off" | "on";

export interface RuntimeConfig {
  maxWorkers: number;
  maxRunningProjects: number;
  maxProjectWorkers: number;
  interval: number;
  healthcheckTimeout: number;
  workerHealthcheck: WorkerHealthcheckMode;
  execution: ExecutionMode;
  promptGroup: string;
  /**
   * M36: write `agent-context.yaml` next to `graph.yaml` and point reason/explore at it.
   * `off` keeps the pre-M36 behavior exactly (no file, no prompt section).
   */
  strategyContext: StrategyContextMode;
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

export interface ToolResultSpillConfig {
  /**
   * Writes an oversized tool result to `<workspace>/.tool-results/` and hands the model a
   * preview plus the pointer instead of the raw text. On by default: one verbose HTTP dump
   * otherwise stays in the context for the rest of the task.
   */
  enabled: boolean;
  /** Serialized tool result at or below this many characters is passed through untouched. */
  maxInlineChars: number;
}

export interface ContextPlanConfig {
  /** Audit only: never trims input or blocks dispatch. */
  mode: "off" | "audit";
  /** UTF-8 bytes of prompt + required initial files, not the SDK context window. */
  maxInitialBytes: number;
}

export const DEFAULT_CONTEXT_PLAN: ContextPlanConfig = {
  mode: "audit",
  maxInitialBytes: 128 * 1024,
};

export interface TaskCheckpointConfig {
  enabled: boolean;
  intervalSeconds: number;
}
export const DEFAULT_TASK_CHECKPOINT: TaskCheckpointConfig = { enabled: false, intervalSeconds: 5 };

export interface ContextPackConfig {
  mode: "off" | "shadow" | "apply";
  shardMaxBytes: number;
}

export const DEFAULT_CONTEXT_PACK: ContextPackConfig = { mode: "off", shardMaxBytes: 8192 };

export interface TasksConfig {
  bootstrap: BootstrapTaskConfig;
  reason: ReasonTaskConfig;
  explore: ExploreTaskConfig;
  graphSlice: GraphSliceConfig;
  evidence: EvidenceConfig;
  toolResultSpill: ToolResultSpillConfig;
  contextPlan: ContextPlanConfig;
  contextPack: ContextPackConfig;
  checkpoint: TaskCheckpointConfig;
  explorationSuppression: { enabled: boolean };
}

/**
 * Explore only needs its intent's causal neighbourhood, and reason/bootstrap still get the
 * whole graph, so slicing is on by default: a large graph costs prompt bytes on every
 * explore turn for facts the task cannot use. `enabled: false` restores the full export.
 */
export const DEFAULT_GRAPH_SLICE: GraphSliceConfig = {
  enabled: true,
  maxFacts: 80,
  maxIntents: 60,
};

export const DEFAULT_EVIDENCE: EvidenceConfig = { minBytes: 1 };

/** `PREVIEW_CHARS` in the worker-side spill extension stays at 600 and is not configurable. */
export const DEFAULT_TOOL_RESULT_SPILL: ToolResultSpillConfig = {
  enabled: true,
  maxInlineChars: 32_000,
};

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
 * Host Bridge scope behaviour. `ssrf_markers` decides what happens to a host literal that a
 * worker hands to an *authorized* destination inside the request itself — a URL query, a form
 * body, an uploaded payload — which only the receiving server resolves.
 *
 * - `observe`: record it in the audit log and let the command run.
 * - `block`: refuse it unless the literal is itself inside the authorized scope.
 * - `off`: ignore carried targets entirely. A deliberate relaxation: before M33 the bridge
 *   checked these literals as destinations.
 *
 * Link-local metadata addresses and `protectedHosts` are refused under both `observe` and
 * `block`, so the marker policy never reopens the deployment's own infrastructure.
 */
export type SsrfMarkerMode = "block" | "observe" | "off";

export const SSRF_MARKER_MODES: readonly SsrfMarkerMode[] = ["block", "observe", "off"];

export interface ScopeConfig {
  ssrfMarkers: SsrfMarkerMode;
  /** Hostnames of this deployment's own facilities, refused as carried targets. */
  protectedHosts: string[];
}

export const DEFAULT_SCOPE: ScopeConfig = {
  ssrfMarkers: "observe",
  protectedHosts: [],
};

/**
 * Hostnames the Host Bridge refuses to see carried inside an authorized request: the
 * operator's list plus this deployment's own control plane and audit stream hosts.
 *
 * IP literals are deliberately left out. A local control plane shares 127.0.0.1 with the lab
 * target, so protecting it would protect nothing and refuse the engagement instead; a named
 * host (`host.docker.internal`, an internal FQDN) identifies our own infrastructure without
 * that collision.
 */
export function protectedTargetHosts(config: DispatchConfig): string[] {
  const hosts = new Set(config.scope.protectedHosts.map((host) => host.toLowerCase()));
  for (const raw of [config.server, config.auditStream.url ?? ""]) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let hostname: string;
    try {
      hostname = new URL(trimmed).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      continue;
    }
    if (hostname === "" || /^[\d.]+$/.test(hostname) || hostname.includes(":")) continue;
    hosts.add(hostname);
  }
  hosts.delete("");
  return [...hosts].sort();
}

/**
 * Completion verification. The policy is chosen per project when it is created
 * (`challenge`, `evidence`, or `off`), and `evidence_enforcement` supplies the default
 * for projects created through the API and for legacy projects without a policy row.
 * It only decides whether the evidence rule runs at completion time; exploration stays
 * lenient. Credentials are read from the named environment variables at verification
 * time and never stored here.
 */
export type EvidenceEnforcement = "completion" | "off";
export type FlagReviewMode = "manual" | "off";
/** Whether an `off` project's completion claim waits for an operator. */
export type OffCompletionMode = "manual" | "auto";
/** Whether an evidence-only project's completion claim waits for an operator (M41). */
export type EvidenceCompletionMode = "manual" | "auto";

export const EVIDENCE_ENFORCEMENT_MODES: readonly EvidenceEnforcement[] = [
  "completion",
  "off",
];
export const FLAG_REVIEW_MODES: readonly FlagReviewMode[] = ["manual", "off"];
export const OFF_COMPLETION_MODES: readonly OffCompletionMode[] = ["manual", "auto"];
export const EVIDENCE_COMPLETION_MODES: readonly EvidenceCompletionMode[] = [
  "manual",
  "auto",
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
  /**
   * `manual` pauses a project when a worker captures a flag-shaped value and waits for an
   * operator decision; `off` keeps dispatch and completion fully automatic.
   */
  flagReview: FlagReviewMode;
  /**
   * `manual` (default) turns an `off` project's completion claim into an operator review;
   * `auto` keeps the legacy "model says complete, project closes" behavior for sandboxes
   * that deliberately run without a human.
   */
  offCompletion: OffCompletionMode;
  /**
   * M41: `manual` (default) turns a project whose only goal condition is `evidence`
   * into an operator review. Set `auto` only for sandboxes that deliberately accept
   * traceability as proof of completion.
   */
  evidenceCompletion: EvidenceCompletionMode;
  challenge: ChallengeVerifierConfig;
}

export const DEFAULT_VERIFICATION: VerificationConfig = {
  evidenceEnforcement: "completion",
  flagReview: "manual",
  offCompletion: "manual",
  evidenceCompletion: "manual",
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
 * Observer/Strategist candidate proposals. Enabled by default in dry-run mode: every
 * candidate is validated and recorded, but the graph is untouched until an operator
 * switches `mode` to `apply` after reviewing the proposal tab.
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
  enabled: true,
  mode: "dry_run",
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
  /**
   * M37: allow a reason turn to retire one open intent through `data.abandon`.
   * Operator abandonment is always available; this switch only covers model agency.
   */
  reasonAbandon: "off" | "on";
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
  reasonAbandon: "off",
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
  /** Worker-only overrides of common_env; never inherit the controller environment. */
  env?: Record<string, string>;
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
  /** Local worker-only overrides of common_env and the inherited environment. */
  env?: Record<string, string>;
  workspaceRoot: string | null;
  completedAction: LocalCompletedAction;
}

/**
 * Which task kinds ask the model to reason before answering.
 *
 * `reason` is the default: choosing *what* to explore needs a chain of deductions and one
 * bad call burns a whole explore task, while explore and bootstrap get corrected by their
 * own tool output and conclude only wraps up findings the session already produced. `all`
 * restores reasoning everywhere (the pre-M55 behaviour) and `off` silences it everywhere.
 * The control plane writes the decision into each task file, so a change reaches the next
 * dispatch without restarting.
 */
export type ReasoningMode = "off" | "reason" | "all";

export const REASONING_MODES: readonly ReasoningMode[] = ["off", "reason", "all"];

/**
 * Generation is most of a task's wall clock, and reasoning inflates it, so only the one
 * kind that cannot be corrected by tool output pays for it by default. Deployments that
 * want the older "reason everywhere" behaviour set `worker.reasoning: all` explicitly.
 */
export const DEFAULT_REASONING_MODE: ReasoningMode = "reason";

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
  /** Which kinds send a reasoning budget; written into task.json as `reasoning`. */
  reasoning: ReasoningMode;
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
  scope: ScopeConfig;
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
  "scope",
  "proposals",
  "strategist",
  "budget",
  "worker_profiles",
  "worker_selection",
]);

/**
 * Sections an operator may override at runtime from the web UI. The stored patch keeps
 * dispatch.yaml's snake_case shape; it is merged onto the parsed document and re-parsed,
 * so these validators stay the only source of truth. Deployment settings (container
 * image/network, credentials, Observer, audit stream, prompt group, worker profiles)
 * remain file-only and need a restart. `runtime.execution` is editable, but the store
 * only accepts a switch while the scheduler is idle; see `RuntimeConfigStore`.
 */
const EDITABLE_OVERRIDE_KEYS: Record<string, readonly string[]> = {
  runtime: [
    "execution",
    "max_workers",
    "max_running_projects",
    "max_project_workers",
    "interval",
  ],
  tasks: ["bootstrap", "reason", "explore", "graph_slice", "evidence", "tool_result_spill", "context_plan", "context_pack", "checkpoint", "exploration_suppression"],
  worker: [
    "soft_deadline_ratio",
    "retain_task_files",
    "result_grace_seconds",
    "scoped_artifacts",
    "reasoning",
  ],
  retention: [
    "session_max_age_days",
    "session_keep_per_project",
    "sweep_interval_seconds",
    "refresh_artifacts",
  ],
  verification: ["evidence_enforcement", "flag_review"],
  scope: ["ssrf_markers"],
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
  tool_result_spill: ["enabled", "max_inline_chars"],
  context_plan: ["mode", "max_initial_bytes"],
  context_pack: ["mode", "shard_max_bytes"],
  checkpoint: ["enabled", "interval_seconds"],
  exploration_suppression: ["enabled"],
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
    strategyContext: has(runtime, "strategy_context")
      ? oneOf(runtime["strategy_context"], "runtime.strategy_context", [
          "off",
          "on",
        ] as const)
      : "on",
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
    toolResultSpill: has(tasks, "tool_result_spill")
      ? parseToolResultSpill(tasks["tool_result_spill"])
      : { ...DEFAULT_TOOL_RESULT_SPILL },
    contextPlan: has(tasks, "context_plan")
      ? parseContextPlan(tasks["context_plan"])
      : { ...DEFAULT_CONTEXT_PLAN },
    explorationSuppression: has(tasks, "exploration_suppression")
      ? parseExplorationSuppression(tasks["exploration_suppression"]) : { enabled: false },
    checkpoint: has(tasks, "checkpoint") ? parseTaskCheckpointConfig(tasks["checkpoint"]) : { ...DEFAULT_TASK_CHECKPOINT },
    contextPack: has(tasks, "context_pack")
      ? parseContextPack(tasks["context_pack"])
      : { ...DEFAULT_CONTEXT_PACK },
  };
}

function parseExplorationSuppression(value: unknown): { enabled: boolean } {
  const policy = recordAt(value, "tasks.exploration_suppression");
  checkOverrideKeys(policy, ["enabled"], "tasks.exploration_suppression");
  return { enabled: has(policy, "enabled") ? booleanAt(policy["enabled"], "tasks.exploration_suppression.enabled") : false };
}

function parseTaskCheckpointConfig(value: unknown): TaskCheckpointConfig {
  const checkpoint = recordAt(value, "tasks.checkpoint");
  checkOverrideKeys(checkpoint, ["enabled", "interval_seconds"], "tasks.checkpoint");
  const intervalSeconds = has(checkpoint, "interval_seconds")
    ? requiredPositiveInt(checkpoint, "interval_seconds", "tasks.checkpoint") : DEFAULT_TASK_CHECKPOINT.intervalSeconds;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds > 60) throw new ConfigError("tasks.checkpoint.interval_seconds must be an integer from 1 to 60");
  return { enabled: has(checkpoint, "enabled") ? booleanAt(checkpoint["enabled"], "tasks.checkpoint.enabled") : false, intervalSeconds };
}

function parseContextPack(value: unknown): ContextPackConfig {
  const pack = recordAt(value, "tasks.context_pack");
  checkOverrideKeys(pack, ["mode", "shard_max_bytes"], "tasks.context_pack");
  const shardMaxBytes = has(pack, "shard_max_bytes")
    ? requiredPositiveInt(pack, "shard_max_bytes", "tasks.context_pack") : DEFAULT_CONTEXT_PACK.shardMaxBytes;
  if (!Number.isSafeInteger(shardMaxBytes) || shardMaxBytes < 1024 || shardMaxBytes > 65536) {
    throw new ConfigError("tasks.context_pack.shard_max_bytes must be an integer from 1024 to 65536");
  }
  return { mode: has(pack, "mode")
    ? oneOf(pack["mode"], "tasks.context_pack.mode", ["off", "shadow", "apply"] as const)
    : DEFAULT_CONTEXT_PACK.mode, shardMaxBytes };
}

function parseContextPlan(value: unknown): ContextPlanConfig {
  const plan = recordAt(value, "tasks.context_plan");
  return {
    mode: has(plan, "mode")
      ? oneOf(plan["mode"], "tasks.context_plan.mode", ["off", "audit"] as const)
      : DEFAULT_CONTEXT_PLAN.mode,
    maxInitialBytes: has(plan, "max_initial_bytes")
      ? requiredPositiveInt(plan, "max_initial_bytes", "tasks.context_plan")
      : DEFAULT_CONTEXT_PLAN.maxInitialBytes,
  };
}

function parseToolResultSpill(value: unknown): ToolResultSpillConfig {
  const spill = recordAt(value, "tasks.tool_result_spill");
  return {
    enabled: has(spill, "enabled")
      ? booleanAt(spill["enabled"], "tasks.tool_result_spill.enabled")
      : DEFAULT_TOOL_RESULT_SPILL.enabled,
    maxInlineChars: has(spill, "max_inline_chars")
      ? requiredPositiveInt(spill, "max_inline_chars", "tasks.tool_result_spill")
      : DEFAULT_TOOL_RESULT_SPILL.maxInlineChars,
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
    ...(has(container, "env") ? { env: stringMap(container["env"], "container.env") } : {}),
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
    ...(has(local, "env") ? { env: stringMap(local["env"], "local.env") } : {}),
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
  const flagReview = has(root, "flag_review")
    ? oneOf(root["flag_review"], "verification.flag_review", FLAG_REVIEW_MODES)
    : DEFAULT_VERIFICATION.flagReview;
  const offCompletion = has(root, "off_completion")
    ? oneOf(root["off_completion"], "verification.off_completion", OFF_COMPLETION_MODES)
    : DEFAULT_VERIFICATION.offCompletion;
  const evidenceCompletion = has(root, "evidence_completion")
    ? oneOf(
        root["evidence_completion"],
        "verification.evidence_completion",
        EVIDENCE_COMPLETION_MODES,
      )
    : DEFAULT_VERIFICATION.evidenceCompletion;
  if (!has(root, "challenge")) {
    return {
      evidenceEnforcement,
      flagReview,
      offCompletion,
      evidenceCompletion,
      challenge: { ...defaults },
    };
  }
  const challenge = recordAt(root["challenge"], "verification.challenge");
  return {
    evidenceEnforcement,
    flagReview,
    offCompletion,
    evidenceCompletion,
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

/**
 * `scope` is the Host Bridge section: how the action-level gate reads a host literal that a
 * worker carries inside a request to an authorized destination.
 */
const SCOPE_SECTION_KEYS = new Set(["ssrf_markers", "protected_hosts"]);

function parseScope(value: unknown): ScopeConfig {
  const root = recordAt(value, "scope");
  for (const key of Object.keys(root)) {
    if (!SCOPE_SECTION_KEYS.has(key)) {
      throw new ConfigError(`scope has unsupported key: ${key}`);
    }
  }
  const protectedHosts = has(root, "protected_hosts")
    ? stringList(root["protected_hosts"], "scope.protected_hosts").map((host, index) => {
        const trimmed = host.trim();
        if (trimmed === "" || /[\s/:@]/.test(trimmed)) {
          throw new ConfigError(
            `scope.protected_hosts[${index}] must be a bare hostname, got "${host}"`,
          );
        }
        return trimmed;
      })
    : [...DEFAULT_SCOPE.protectedHosts];
  return {
    ssrfMarkers: has(root, "ssrf_markers")
      ? oneOf(root["ssrf_markers"], "scope.ssrf_markers", SSRF_MARKER_MODES)
      : DEFAULT_SCOPE.ssrfMarkers,
    protectedHosts,
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
  type NumericStrategistKey = Exclude<keyof StrategistConfig, "reasonAbandon">;
  const intAt = (key: NumericStrategistKey): number => {
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
    reasonAbandon: has(strategist, "reason_abandon")
      ? oneOf(strategist["reason_abandon"], "strategist.reason_abandon", [
          "off",
          "on",
        ] as const)
      : DEFAULT_STRATEGIST.reasonAbandon,
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
    reasoning: has(worker, "reasoning")
      ? oneOf(worker["reasoning"], "worker.reasoning", REASONING_MODES)
      : DEFAULT_REASONING_MODE,
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
  if (tasks.contextPack.mode !== "off" &&
      (tasks.contextPlan.mode !== "audit" || runtime.strategyContext !== "on")) {
    throw new ConfigError("tasks.context_pack requires tasks.context_plan.mode audit and runtime.strategy_context on");
  }

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
        reasoning: DEFAULT_REASONING_MODE,
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
        flagReview: DEFAULT_VERIFICATION.flagReview,
        offCompletion: DEFAULT_VERIFICATION.offCompletion,
        evidenceCompletion: DEFAULT_VERIFICATION.evidenceCompletion,
        challenge: { ...DEFAULT_VERIFICATION.challenge },
      };

  const scope = has(root, "scope")
    ? parseScope(root["scope"])
    : {
        ssrfMarkers: DEFAULT_SCOPE.ssrfMarkers,
        protectedHosts: [...DEFAULT_SCOPE.protectedHosts],
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
    scope,
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
