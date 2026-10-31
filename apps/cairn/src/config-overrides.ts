/**
 * Effective runtime configuration.
 *
 * dispatch.yaml stays the baseline. Operator edits from the web UI are stored as a
 * snake_case patch in SQLite, merged onto the parsed document and re-parsed with the same
 * validators, then applied to the live `DispatchConfig` in place. The scheduler and the
 * HTTP API share that object, so changed values are visible on the next scheduler tick;
 * `onApply` lets the scheduler re-arm interval-driven timers.
 */

import {
  clearRuntimeConfigOverrides,
  getRuntimeConfigOverrides,
  setRuntimeConfigOverrides,
  type CairnDatabase,
} from "@cairn/graph";

import {
  ConfigError,
  parseDispatchConfig,
  parseRuntimeOverridePatch,
  type ConfigOptions,
  type DispatchConfig,
  type EvidenceEnforcement,
  type ExecutionMode,
  type FlagReviewMode,
  type ProposalKindConfig,
  type ProposalMode,
  type RuntimeOverridePatch,
  type SsrfMarkerMode,
  type WorkerHealthcheckMode,
  type WorkerSelectionMode,
} from "./config";

export interface EditableRuntimeConfig {
  runtime: {
    execution: ExecutionMode;
    max_workers: number;
    max_running_projects: number;
    max_project_workers: number;
    interval: number;
  };
  tasks: {
    bootstrap: { timeout: number; conclude_timeout: number };
    reason: { timeout: number; max_intents: number };
    explore: { timeout: number; conclude_timeout: number };
    graph_slice: { enabled: boolean; max_facts: number; max_intents: number };
    evidence: { min_bytes: number };
  };
  worker: {
    soft_deadline_ratio: number;
    retain_task_files: boolean;
    result_grace_seconds: number;
    scoped_artifacts: boolean;
  };
  retention: {
    session_max_age_days: number;
    session_keep_per_project: number;
    sweep_interval_seconds: number;
    refresh_artifacts: boolean;
  };
  verification: {
    evidence_enforcement: EvidenceEnforcement;
    flag_review: FlagReviewMode;
  };
  scope: {
    ssrf_markers: SsrfMarkerMode;
  };
  proposals: {
    enabled: boolean;
    mode: ProposalMode;
    max_per_task: number;
    max_file_bytes: number;
    max_total_bytes: number;
    allow_kinds: ProposalKindConfig[];
    require_evidence_for_fact: boolean;
    min_confidence: number;
  };
  strategist: {
    min_new_facts: number;
    min_new_hints: number;
    cooldown_seconds: number;
    failure_backoff_seconds: number;
    max_runs_per_hour: number;
    zero_output_threshold: number;
    stale_intent_seconds: number;
    fallback_interval_seconds: number;
    resource_pressure_ratio: number;
  };
  budget: {
    max_project_tokens: number;
    max_project_cost_usd: number;
    max_project_tasks: number;
  };
  worker_selection: {
    mode: WorkerSelectionMode;
    min_runs: number;
    epsilon: number;
    epsilon_decay: number;
    epsilon_min: number;
  };
}

/** Deployment settings that need a dispatch.yaml edit and a restart. */
export interface ReadOnlyRuntimeConfig {
  server: string;
  runtime: {
    prompt_group: string;
    healthcheck_timeout: number;
    worker_healthcheck: WorkerHealthcheckMode;
  };
  observer: {
    enabled: boolean;
    model: string | null;
    every_rounds: number;
    window_rounds: number;
    timeout_seconds: number;
    max_reviews_per_task: number;
    kernel_tasks: string[];
  };
  audit_stream: { enabled: boolean; url: string | null };
  worker_profiles: { id: string; model: string }[];
  common_env_keys: string[];
  workspace: { mode: ExecutionMode; root: string | null };
}

export interface RuntimeConfigView {
  /** Effective values from dispatch.yaml alone (before overrides). */
  defaults: EditableRuntimeConfig;
  /** Values the scheduler is using right now. */
  editable: EditableRuntimeConfig;
  /** Dotted snake_case paths currently overridden, for UI badges. */
  overrides: string[];
  updated_at: string | null;
  read_only: ReadOnlyRuntimeConfig;
}

export interface RuntimeConfigStoreOptions {
  db: CairnDatabase;
  /** Live config object shared with the scheduler and API; mutated in place. */
  config: DispatchConfig;
  /** Parsed dispatch document (snake_case) before defaults, from the loader. */
  source: Record<string, unknown>;
  /** Passed to `parseDispatchConfig` (tests that override the prompts root). */
  configOptions?: ConfigOptions;
  now?: () => Date;
  log?: (message: string) => void;
  /**
   * Last chance to reject a parsed patch before the live config is mutated. Returning a
   * message turns into a `ConfigError`, so the running scheduler keeps its previous
   * settings. Used to refuse an execution-mode switch while tasks are in flight.
   */
  validateNext?: (next: DispatchConfig, current: DispatchConfig) => string | null;
  /** Called after a successful change; the scheduler re-arms interval timers here. */
  onApply?: () => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function syncValue(target: unknown, source: unknown): unknown {
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key of Object.keys(target)) {
      if (!(key in source)) delete target[key];
    }
    for (const [key, value] of Object.entries(source)) {
      target[key] = syncValue(target[key], value);
    }
    return target;
  }
  return structuredClone(source);
}

/**
 * Copies `source` into `target` while keeping every section object's identity, because the
 * API holds references to `config.budget` and the oracle holds `config.verification`.
 */
export function syncConfigInPlace(target: DispatchConfig, source: DispatchConfig): void {
  syncValue(target, source);
}

/** Deep-merges a patch onto a clone of the parsed document; arrays replace wholesale. */
export function mergeOverrideDocuments(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? mergeOverrideDocuments(current, value)
      : structuredClone(value);
  }
  return merged;
}

/**
 * A dispatch.yaml without a `container` section still parses while execution is local,
 * so the first switch to container from the UI has nothing to mount or exec into. These
 * defaults match `Dockerfile.worker` and are merged in for validation only; they are not
 * stored in the override patch, so a later dispatch.yaml edit still wins.
 */
const CONTAINER_SECTION_DEFAULTS = {
  image: "cairn-worker:latest",
  network_mode: "bridge",
  completed_action: "remove",
} as const;

function withContainerDefaults(merged: Record<string, unknown>): Record<string, unknown> {
  const runtime = merged["runtime"];
  if (!isPlainObject(runtime) || runtime["execution"] !== "container") return merged;
  if (!isPlainObject(merged["container"])) {
    merged["container"] = { ...CONTAINER_SECTION_DEFAULTS };
  }
  return merged;
}

/** Flattens a patch into dotted leaf paths (arrays count as one leaf). */
export function overridePaths(patch: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, prefix: string): void => {
    if (!isPlainObject(value)) {
      if (prefix !== "") paths.push(prefix);
      return;
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      if (prefix !== "") paths.push(prefix);
      return;
    }
    for (const [key, child] of entries) {
      walk(child, prefix === "" ? key : `${prefix}.${key}`);
    }
  };
  walk(patch, "");
  return paths.sort();
}

export class RuntimeConfigStore {
  private readonly options: RuntimeConfigStoreOptions;
  private readonly base: Record<string, unknown>;
  private readonly defaultConfig: DispatchConfig;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  private overrides: RuntimeOverridePatch = {};
  private updatedAt: string | null = null;

  constructor(options: RuntimeConfigStoreOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.base = structuredClone(options.source);
    this.defaultConfig = parseDispatchConfig(
      structuredClone(this.base),
      options.configOptions,
    );

    const stored = options.db.withConn((conn) => getRuntimeConfigOverrides(conn));
    if (stored.overrides.trim() === "" || stored.overrides.trim() === "{}") {
      return;
    }
    try {
      const patch = parseRuntimeOverridePatch(JSON.parse(stored.overrides));
      this.install(patch, stored.updatedAt);
    } catch (error) {
      this.log(
        `ignoring invalid stored runtime overrides: ${error instanceof Error ? error.message : String(error)}`,
      );
      options.db.withConn((conn) => clearRuntimeConfigOverrides(conn, ""));
    }
  }

  /** Live config the scheduler is using; the execution probe reads image and workspace. */
  get config(): DispatchConfig {
    return this.options.config;
  }

  view(): RuntimeConfigView {
    return {
      defaults: editableView(this.defaultConfig),
      editable: editableView(this.options.config),
      overrides: overridePaths(this.overrides),
      updated_at: this.updatedAt,
      read_only: readOnlyView(this.options.config),
    };
  }

  /** Replaces the stored override set; an empty patch restores dispatch.yaml values. */
  apply(value: unknown): RuntimeConfigView {
    const patch = parseRuntimeOverridePatch(value);
    const updatedAt = this.now().toISOString();
    this.install(patch, updatedAt);
    this.options.db.withConn((conn) =>
      setRuntimeConfigOverrides(conn, JSON.stringify(this.overrides), updatedAt),
    );
    return this.view();
  }

  reset(): RuntimeConfigView {
    const updatedAt = this.now().toISOString();
    this.install({}, updatedAt);
    this.options.db.withConn((conn) => clearRuntimeConfigOverrides(conn, updatedAt));
    return this.view();
  }

  private install(patch: RuntimeOverridePatch, updatedAt: string | null): void {
    const merged = withContainerDefaults(mergeOverrideDocuments(this.base, patch));
    // Throws ConfigError before anything is mutated, so a rejected patch leaves the
    // running scheduler on its previous configuration.
    const next = parseDispatchConfig(merged, this.options.configOptions);
    const rejection = this.options.validateNext?.(next, this.options.config) ?? null;
    if (rejection !== null) {
      throw new ConfigError(rejection);
    }
    syncConfigInPlace(this.options.config, next);
    this.overrides = patch;
    this.updatedAt = updatedAt;
    this.options.onApply?.();
  }
}

function editableView(config: DispatchConfig): EditableRuntimeConfig {
  return {
    runtime: {
      execution: config.runtime.execution,
      max_workers: config.runtime.maxWorkers,
      max_running_projects: config.runtime.maxRunningProjects,
      max_project_workers: config.runtime.maxProjectWorkers,
      interval: config.runtime.interval,
    },
    tasks: {
      bootstrap: {
        timeout: config.tasks.bootstrap.timeout,
        conclude_timeout: config.tasks.bootstrap.concludeTimeout,
      },
      reason: {
        timeout: config.tasks.reason.timeout,
        max_intents: config.tasks.reason.maxIntents,
      },
      explore: {
        timeout: config.tasks.explore.timeout,
        conclude_timeout: config.tasks.explore.concludeTimeout,
      },
      graph_slice: {
        enabled: config.tasks.graphSlice.enabled,
        max_facts: config.tasks.graphSlice.maxFacts,
        max_intents: config.tasks.graphSlice.maxIntents,
      },
      evidence: { min_bytes: config.tasks.evidence.minBytes },
    },
    worker: {
      soft_deadline_ratio: config.worker.softDeadlineRatio,
      retain_task_files: config.worker.retainTaskFiles,
      result_grace_seconds: config.worker.resultGraceSeconds,
      scoped_artifacts: config.worker.scopedArtifacts,
    },
    retention: {
      session_max_age_days: config.retention.sessionMaxAgeDays,
      session_keep_per_project: config.retention.sessionKeepPerProject,
      sweep_interval_seconds: config.retention.sweepIntervalSeconds,
      refresh_artifacts: config.retention.refreshArtifacts,
    },
    verification: {
      evidence_enforcement: config.verification.evidenceEnforcement,
      flag_review: config.verification.flagReview,
    },
    scope: {
      ssrf_markers: config.scope.ssrfMarkers,
    },
    proposals: {
      enabled: config.proposals.enabled,
      mode: config.proposals.mode,
      max_per_task: config.proposals.maxPerTask,
      max_file_bytes: config.proposals.maxFileBytes,
      max_total_bytes: config.proposals.maxTotalBytes,
      allow_kinds: [...config.proposals.allowKinds],
      require_evidence_for_fact: config.proposals.requireEvidenceForFact,
      min_confidence: config.proposals.minConfidence,
    },
    strategist: {
      min_new_facts: config.strategist.minNewFacts,
      min_new_hints: config.strategist.minNewHints,
      cooldown_seconds: config.strategist.cooldownSeconds,
      failure_backoff_seconds: config.strategist.failureBackoffSeconds,
      max_runs_per_hour: config.strategist.maxRunsPerHour,
      zero_output_threshold: config.strategist.zeroOutputThreshold,
      stale_intent_seconds: config.strategist.staleIntentSeconds,
      fallback_interval_seconds: config.strategist.fallbackIntervalSeconds,
      resource_pressure_ratio: config.strategist.resourcePressureRatio,
    },
    budget: {
      max_project_tokens: config.budget.maxProjectTokens,
      max_project_cost_usd: config.budget.maxProjectCostUsd,
      max_project_tasks: config.budget.maxProjectTasks,
    },
    worker_selection: {
      mode: config.workerSelection.mode,
      min_runs: config.workerSelection.minRuns,
      epsilon: config.workerSelection.epsilon,
      epsilon_decay: config.workerSelection.epsilonDecay,
      epsilon_min: config.workerSelection.epsilonMin,
    },
  };
}

function readOnlyView(config: DispatchConfig): ReadOnlyRuntimeConfig {
  const root =
    config.runtime.execution === "container"
      ? (config.container?.workspaceRoot ?? null)
      : (config.local?.workspaceRoot ?? null);
  return {
    server: config.server,
    runtime: {
      prompt_group: config.runtime.promptGroup,
      healthcheck_timeout: config.runtime.healthcheckTimeout,
      worker_healthcheck: config.runtime.workerHealthcheck,
    },
    observer: {
      enabled: config.observer.enabled,
      model: config.observer.model,
      every_rounds: config.observer.everyRounds,
      window_rounds: config.observer.windowRounds,
      timeout_seconds: config.observer.timeoutSeconds,
      max_reviews_per_task: config.observer.maxReviewsPerTask,
      kernel_tasks: [...config.observer.kernelTasks],
    },
    audit_stream: {
      enabled: config.auditStream.enabled,
      url: config.auditStream.url,
    },
    worker_profiles: config.workerProfiles.map((profile) => ({ ...profile })),
    common_env_keys: Object.keys(config.commonEnv).sort(),
    workspace: { mode: config.runtime.execution, root },
  };
}
