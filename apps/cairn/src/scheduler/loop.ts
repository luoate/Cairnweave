/**
 * In-process scheduler.
 *
 * It owns dispatch decisions and is the only writer of leases and the graph. Workers get
 * a task file and a result path; they never touch SQLite. Semantics follow Cairn's
 * dispatcher loop (bootstrap/reason/explore priority, reason triggers, leases, timeout
 * handling), minus the HTTP hop and the per-worker type registry.
 */

import {
  DEFAULT_INTENT_PRIORITY,
  parseTaskResultJson,
  validateBootstrapConcludePayload,
  validateBootstrapExecutePayload,
  validateExplorePayload,
  validateReasonPayload,
  type ReasonIntentBudget,
  type TaskResult,
  type TaskUsage,
} from "@cairn/contracts";
import {
  HttpError,
  claimReason,
  completeProject,
  concludeIntent,
  countReasonRunsSince,
  createHint,
  createIntent,
  deletePendingConclude,
  exportProjectSliceYaml,
  exportProjectYaml,
  findHintByContent,
  findOpenIntentByDedupeKey,
  finishRun,
  getIntentMeta,
  getPendingConclude,
  getProjectDetail,
  getProjectScope,
  getProjectUsage,
  getStrategistState,
  hasPendingConclude,
  heartbeatIntent,
  isPendingConcludeSession,
  listAllPendingConcludes,
  listProjectIntentMeta,
  listProjects,
  listRecentStrategistRuns,
  nextRunId,
  recordIntentMeta,
  recordPendingConclude,
  recordStrategistFailure,
  recordStrategistSuccess,
  releaseIntent,
  releaseReason,
  recordProjectArtifacts,
  refreshProjectArtifacts,
  renewIntentLease,
  renewReasonLease,
  startRun,
  utcnow,
  type CairnDatabase,
  type Intent,
  type IntentMeta,
  type PendingConcludeRow,
  type ProjectDetail,
  type ProjectScope,
  type ProjectSummary,
  type RunOutcome,
} from "@cairn/graph";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { AuditTokenRegistry } from "../audit-stream/tokens";
import type { DispatchConfig } from "../config";
import {
  VerificationService,
  type VerificationOptions,
  type VerificationOutcome,
} from "../verification/oracle";
import { createRuntime, type RuntimeBackend, type WorkerProcess } from "../runtime";
import { environmentSnapshot } from "../runtime/types";
import { latestSolverSessionFile } from "../solver/session-file";
import { collectEvidence, type EvidenceCollection } from "./evidence";
import { ingestAuditStreamLoss, ingestTaskAudit } from "./audit";
import { ingestTaskProposals, reviewPendingProposals } from "./proposals";
import { scanSessionDirs, selectSessionsForRemoval } from "./retention";
import { evaluateStrategistTrigger } from "./strategist";
import { readTaskUsage } from "./usage";
import {
  observerEnvironment,
  prepareTask,
  projectWorkspace,
  resolveWorkspaceRoot,
  type ConcludeOf,
  type PreparedTask,
  type RunnableTaskKind,
} from "./tasks";

const WORKER_NAME = "cairn-worker";
const BOOTSTRAP_INTENT_DESCRIPTION = "bootstrap";
const BOOTSTRAP_INTENT_CREATOR = "dispatcher.bootstrap";
const KILL_GRACE_MS = 5_000;
const RESULT_POLL_MS = 50;

export type TaskOutcome =
  | "success"
  | "failed"
  | "rejected"
  | "cancelled"
  | "unhealthy"
  | "inactive";

export interface SchedulerOptions {
  db: CairnDatabase;
  config: DispatchConfig;
  /** Project workspace root; overrides `local.workspace_root` (tests). */
  workspaceRoot?: string;
  /** Test hook: replaces the default local `bun cli.ts worker --task <file>` invocation. */
  workerArgv?: (taskPath: string) => string[];
  /** Test hook: replace the local/container backend entirely. */
  runtime?: RuntimeBackend;
  log?: (message: string) => void;
  /** Override the lease renewal cadence; defaults to runtime.interval seconds. */
  leaseIntervalMs?: number;
  /** Token registry shared with the HTTP API; required to enable live audit streaming. */
  auditTokens?: AuditTokenRegistry;
  /** Control-plane base URL reachable from workers; defaults to `audit_stream.url`. */
  auditStreamUrl?: string | null;
  /** Test hook: clock used by the Strategist trigger policy. */
  now?: () => Date;
  /** Completion oracle; defaults to the configured challenge/evidence policy. */
  verification?: VerificationService;
}

interface AuditStreamTarget {
  tokens: AuditTokenRegistry;
  url: string;
}

/**
 * A failed execute task whose solver session is kept so a follow-up conclude task can
 * append a wrap-up turn. The intent stays claimed by this scheduler while it is queued.
 */
interface PendingConclude {
  intentId: string;
  of: ConcludeOf;
  hostSessionDir: string;
}

interface RunningTask {
  taskId: string;
  /** Control-plane generated id for the sidecar `runs` row. */
  runId: string;
  projectId: string;
  kind: RunnableTaskKind;
  intentId?: string;
  /** Conclude only: which failed phase is being wrapped up. */
  concludeOf?: ConcludeOf;
  /** Conclude only: host-side session directory of the failed task being resumed. */
  resumeSessionDir?: string;
  openIntentsEmpty: boolean;
  /** Reason only: the trigger that produced this task, persisted on success/failure. */
  trigger?: string;
  /** Host-side session directory. */
  sessionDir: string;
  /** Host-side result path. */
  resultPath: string;
  hostWorkspace: string;
  leaseLost: boolean;
  cancelled: boolean;
  startedAtMs: number;
  evidenceCount: number;
  exitCode: number | null;
  /** Why a failed task ended; recorded on the run row. */
  detail?: string;
  promise: Promise<void>;
}

export class Scheduler {
  private readonly db: CairnDatabase;
  private readonly config: DispatchConfig;
  private readonly workspaceRoot: string;
  private readonly runtime: RuntimeBackend;
  private readonly log: (message: string) => void;
  private readonly leaseIntervalMs: number;
  private readonly auditStream: AuditStreamTarget | null;
  private readonly verification: VerificationService;
  private readonly now: () => Date;

  private readonly running = new Map<string, RunningTask>();
  private readonly loggedSkips = new Set<string>();
  private readonly processes = new Map<string, WorkerProcess>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private projectCursor = 0;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.workspaceRoot = resolveWorkspaceRoot(options.config, options.workspaceRoot);
    this.log = options.log ?? ((message) => console.error(`[scheduler] ${message}`));
    this.now = options.now ?? (() => new Date());
    this.runtime =
      options.runtime ??
      createRuntime({
        config: options.config,
        log: this.log,
        ...(options.workerArgv === undefined ? {} : { workerArgv: options.workerArgv }),
      });
    this.leaseIntervalMs =
      options.leaseIntervalMs ?? this.config.runtime.interval * 1000;
    this.verification =
      options.verification ?? new VerificationService(this.db, this.config.verification);

    const url =
      options.auditStreamUrl === undefined
        ? this.config.auditStream.url
        : options.auditStreamUrl;
    this.auditStream =
      this.config.auditStream.enabled &&
      options.auditTokens !== undefined &&
      url !== null
        ? { tokens: options.auditTokens, url: url.replace(/\/+$/, "") }
        : null;
    if (this.config.auditStream.enabled && this.auditStream === null) {
      this.log(
        "audit_stream.enabled is set but no reachable URL/token registry is available; " +
          "live streaming is disabled and the finish-time import remains authoritative",
      );
    }
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** Background mode used by `cairn serve --config`. */
  start(): void {
    if (this.timer !== null) return;
    // Reconcile persisted state before the first dispatch: rows left by a previous process
    // may point at concluded intents or deleted sessions.
    try {
      this.sweepNow();
    } catch (error) {
      this.log(`startup sweep failed: ${describe(error)}`);
    }
    const sweepSeconds = this.config.retention.sweepIntervalSeconds;
    if (sweepSeconds > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.sweepNow();
        } catch (error) {
          this.log(`retention sweep failed: ${describe(error)}`);
        }
      }, sweepSeconds * 1000);
    }
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.log(`tick failed: ${describe(error)}`);
      }
    }, this.config.runtime.interval * 1000);
    this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const task of this.running.values()) {
      this.cancel(task, "shutdown");
    }
    await this.waitForIdle();
    try {
      this.runtime.close();
    } catch (error) {
      this.log(`runtime shutdown failed: ${describe(error)}`);
    }
  }

  /** Dispatches until the graph stops producing work. Used by integration tests. */
  async runUntilIdle(maxTicks = 200): Promise<void> {
    for (let index = 0; index < maxTicks; index += 1) {
      const dispatched = this.tick();
      if (this.running.size === 0) {
        if (!dispatched) return;
        continue;
      }
      await this.waitForIdle();
    }
    throw new Error("scheduler did not become idle");
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((task) => task.promise));
    }
  }

  // --- housekeeping -----------------------------------------------------------------

  /**
   * One reconciliation/retention pass. Called at startup and on the configured interval;
   * tests call it directly. All steps are best-effort and never abort dispatch.
   */
  sweepNow(): void {
    let summaries: ProjectSummary[];
    try {
      summaries = this.db.withConn((conn) => listProjects(conn));
    } catch (error) {
      this.log(`sweep project list failed: ${describe(error)}`);
      return;
    }
    this.reconcilePendingConcludes();
    this.pruneSessions(summaries);
    if (this.config.retention.refreshArtifacts) {
      this.refreshArtifacts(summaries);
    }
  }

  /** Drops queued concludes that can no longer run, releasing a still-open intent. */
  private reconcilePendingConcludes(): void {
    let rows: PendingConcludeRow[];
    try {
      rows = this.db.withConn((conn) => listAllPendingConcludes(conn));
    } catch (error) {
      this.log(`pending reconcile load failed: ${describe(error)}`);
      return;
    }
    if (rows.length === 0) return;

    const details = new Map<string, ProjectDetail | null>();
    const unreadable = new Set<string>();
    for (const row of rows) {
      if (this.isIntentRunning(row.project_id, row.intent_id)) continue;
      if (unreadable.has(row.project_id)) continue;

      let detail: ProjectDetail | null;
      if (details.has(row.project_id)) {
        detail = details.get(row.project_id)!;
      } else {
        try {
          detail = this.db.withConn((conn) =>
            getProjectDetail(conn, row.project_id),
          );
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            detail = null;
          } else {
            // A transient read failure must not be mistaken for a missing project.
            this.log(
              `pending reconcile project load failed project=${row.project_id}: ${describe(error)}`,
            );
            unreadable.add(row.project_id);
            continue;
          }
        }
        details.set(row.project_id, detail);
      }

      let reason: string | null = null;
      let releaseOpenIntent = false;
      if (detail === null) {
        reason = "project missing";
      } else if (detail.project.status !== "active") {
        reason = `project ${detail.project.status}`;
      } else {
        const intent = detail.intents.find((entry) => entry.id === row.intent_id);
        if (intent === undefined) {
          reason = "intent missing";
        } else if (intent.to !== null) {
          reason = "intent concluded";
        } else if (
          latestSolverSessionFile(this.pendingHostSession(row)) === null
        ) {
          reason = "session missing";
          releaseOpenIntent = true;
        }
      }
      if (reason === null) continue;

      try {
        this.db.withConn((conn) =>
          deletePendingConclude(conn, row.project_id, row.intent_id),
        );
      } catch (error) {
        this.log(
          `pending reconcile delete failed project=${row.project_id} ` +
            `intent=${row.intent_id}: ${describe(error)}`,
        );
        continue;
      }
      this.log(
        `pending conclude dropped project=${row.project_id} intent=${row.intent_id}: ${reason}`,
      );
      // Without the retained session there is nothing to resume; let a normal explore
      // retry instead of leaving the intent claimed by this worker.
      if (releaseOpenIntent) {
        this.releaseBestEffort({
          projectId: row.project_id,
          kind: "conclude",
          intentId: row.intent_id,
        });
      }
    }
  }

  private pruneSessions(summaries: readonly ProjectSummary[]): void {
    const retention = this.config.retention;
    if (
      retention.sessionMaxAgeDays === 0 &&
      retention.sessionKeepPerProject === 0
    ) {
      return;
    }
    const protectedPaths = this.protectedSessionPaths();
    if (protectedPaths === null) return;
    let removed = 0;
    for (const summary of summaries) {
      const workspace = projectWorkspace(this.workspaceRoot, summary.id);
      const dirs = scanSessionDirs(workspace);
      if (dirs.length === 0) continue;
      for (const decision of selectSessionsForRemoval(
        dirs,
        retention,
        protectedPaths,
      )) {
        try {
          rmSync(decision.path, { recursive: true, force: true });
          removed += 1;
          this.log(
            `retention removed project=${summary.id} dir=${decision.name} reason=${decision.reason}`,
          );
        } catch (error) {
          this.log(
            `retention delete failed project=${summary.id} dir=${decision.name}: ${describe(error)}`,
          );
        }
      }
    }
    if (removed > 0) this.log(`retention sweep removed ${removed} session dir(s)`);
  }

  /** Null means the lookup failed: fail closed and skip pruning for this pass. */
  private protectedSessionPaths(): Set<string> | null {
    const paths = new Set<string>();
    for (const task of this.running.values()) {
      paths.add(task.sessionDir);
      if (task.resumeSessionDir !== undefined) {
        paths.add(task.resumeSessionDir);
      }
    }
    try {
      const rows = this.db.withConn((conn) => listAllPendingConcludes(conn));
      for (const row of rows) paths.add(this.pendingHostSession(row));
    } catch (error) {
      this.log(`retention protection lookup failed: ${describe(error)}`);
      return null;
    }
    return paths;
  }

  private refreshArtifacts(summaries: readonly ProjectSummary[]): void {
    for (const summary of summaries) {
      const workspace = projectWorkspace(this.workspaceRoot, summary.id);
      try {
        const artifacts = this.db.withConn((conn) =>
          refreshProjectArtifacts(conn, { projectId: summary.id, workspace }),
        );
        if (artifacts.length > 0) {
          this.log(
            `artifacts refreshed project=${summary.id} count=${artifacts.length}`,
          );
        }
      } catch (error) {
        this.log(
          `artifact refresh failed project=${summary.id}: ${describe(error)}`,
        );
      }
    }
  }

  private pendingHostSession(row: PendingConcludeRow): string {
    const workspace = projectWorkspace(this.workspaceRoot, row.project_id);
    return join(workspace, ...row.session.split("/"));
  }

  // --- dispatch ---------------------------------------------------------------------

  /** Returns true when at least one task was started. */
  /** One dispatch pass. Public so focused tests can observe a single tick. */
  tick(): boolean {
    const summaries = this.db.withConn((conn) => listProjects(conn));
    const active = summaries.filter((summary) => summary.status === "active");
    const statusById = new Map(summaries.map((summary) => [summary.id, summary.status]));
    const activeIds = new Set(active.map((summary) => summary.id));

    for (const task of this.running.values()) {
      if (statusById.get(task.projectId) !== "active") {
        this.cancel(task, "project_inactive");
      }
    }

    // Completed, stopped and deleted projects release their containers/workspaces here.
    try {
      this.runtime.cleanupInactive(activeIds);
    } catch (error) {
      this.log(`runtime cleanup failed: ${describe(error)}`);
    }

    if (active.length === 0) return false;
    this.reviewProjectProposals(active);

    let dispatchedAny = false;
    let progress = true;
    while (this.running.size < this.config.runtime.maxWorkers && progress) {
      progress = false;
      const runningIds = this.activeRunningProjectIds(active);
      const runningProjects = active.filter((summary) => runningIds.has(summary.id));
      const idleProjects = active.filter((summary) => !runningIds.has(summary.id));

      for (const summary of this.order(runningProjects)) {
        if (this.running.size >= this.config.runtime.maxWorkers) break;
        if (this.tryDispatch(summary)) {
          dispatchedAny = true;
          progress = true;
        }
      }
      if (progress) continue;

      if (
        this.runningProjectCount(active) >= this.config.runtime.maxRunningProjects
      ) {
        break;
      }
      for (const summary of this.order(idleProjects)) {
        if (this.running.size >= this.config.runtime.maxWorkers) break;
        if (
          this.runningProjectCount(active) >= this.config.runtime.maxRunningProjects
        ) {
          break;
        }
        if (this.tryDispatch(summary)) {
          dispatchedAny = true;
          progress = true;
          break;
        }
      }
    }
    return dispatchedAny;
  }

  private tryDispatch(summary: ProjectSummary): boolean {
    if (this.projectTaskCount(summary.id) >= this.projectTaskLimit()) {
      return false;
    }

    let scope: ProjectScope | null;
    try {
      scope = this.db.withConn((conn) => getProjectScope(conn, summary.id));
    } catch (error) {
      this.log(`scope lookup failed project=${summary.id}: ${describe(error)}`);
      return false;
    }
    if (scope === null) {
      // Fail closed: no authorized scope, no work.
      this.logOnce(
        `scope:${summary.id}`,
        `skip project=${summary.id} because it has no authorized scope`,
      );
      return false;
    }
    this.loggedSkips.delete(`scope:${summary.id}`);

    let project: ProjectDetail;
    try {
      project = this.db.withConn((conn) => getProjectDetail(conn, summary.id));
    } catch (error) {
      this.log(`project load failed project=${summary.id}: ${describe(error)}`);
      return false;
    }
    if (project.project.status !== "active") return false;

    // A queued conclude has priority over new work: it holds the failed task's lease and
    // must either write the salvaged fact or release the intent before explore retries.
    const pending = this.pendingConcludeFor(summary.id);
    if (pending !== undefined) {
      const intent = project.intents.find(
        (entry) => entry.id === pending.intentId && entry.to === null,
      );
      if (intent === undefined) {
        this.dropPending(summary.id, pending);
      } else if (this.isIntentRunning(summary.id, pending.intentId)) {
        return false;
      } else {
        // Keep the entry until the conclude task actually finishes: if the sandbox or
        // spawn is temporarily unavailable, the next tick should retry the salvage rather
        // than fall back to exploring from scratch. `finish` removes it.
        return this.startClaimed(
          project,
          scope,
          "conclude",
          intent,
          undefined,
          pending,
        );
      }
    }

    // Cost budgets gate every new dispatch, but not the salvage conclude above: that task
    // holds an intent lease and must either write its fact or release the intent.
    if (this.projectBudgetExhausted(summary.id)) return false;

    if (isInitialProject(project)) {
      if (project.project.reason !== null) return false;
      if (project.project.bootstrap_enabled) {
        return this.dispatchBootstrap(project, scope);
      }
      // Route through the persisted trigger policy even for the first reason turn:
      // a failed initial attempt must respect backoff after a restart.
      const trigger = this.strategistTrigger(project);
      return trigger === null ? false : this.dispatchReason(project, scope, trigger);
    }

    if (project.project.reason === null) {
      const trigger = this.strategistTrigger(project);
      if (trigger !== null) {
        return this.dispatchReason(project, scope, trigger);
      }
    }

    const runningIntentIds = new Set(
      [...this.running.values()]
        .filter(
          (task) =>
            task.projectId === summary.id &&
            task.kind === "explore" &&
            task.intentId !== undefined,
        )
        .map((task) => task.intentId!),
    );
    const unclaimed = project.intents.filter(
      (intent) =>
        intent.to === null &&
        intent.worker === null &&
        !runningIntentIds.has(intent.id) &&
        !isBootstrapIntent(intent),
    );
    if (unclaimed.length > 0) {
      return this.dispatchExplore(
        project,
        scope,
        pickByPriority(unclaimed, this.intentMetaFor(summary.id)),
      );
    }

    this.logOnce(
      `idle:${summary.id}`,
      `project=${summary.id} has no dispatchable work facts=${project.facts.length} hints=${project.hints.length} intents=${project.intents.length}`,
    );
    return false;
  }

  private dispatchBootstrap(project: ProjectDetail, scope: ProjectScope): boolean {
    let intent = project.intents.find(isBootstrapIntent);
    if (intent === undefined) {
      try {
        intent = this.db.withConn((conn) =>
          createIntent(conn, project.project.id, {
            from: ["origin"],
            description: BOOTSTRAP_INTENT_DESCRIPTION,
            creator: BOOTSTRAP_INTENT_CREATOR,
            worker: null,
          }),
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) return false;
        this.log(
          `bootstrap intent create failed project=${project.project.id}: ${describe(error)}`,
        );
        return false;
      }
    }

    if (this.hasRunningBootstrap(project.project.id)) return false;
    if (intent.worker !== null) return false;
    return this.startClaimed(project, scope, "bootstrap", intent);
  }

  private dispatchExplore(
    project: ProjectDetail,
    scope: ProjectScope,
    intent: Intent,
  ): boolean {
    return this.startClaimed(project, scope, "explore", intent);
  }

  private dispatchReason(
    project: ProjectDetail,
    scope: ProjectScope,
    trigger: string,
  ): boolean {
    return this.startClaimed(project, scope, "reason", undefined, trigger);
  }

  /**
   * Claims the lease and prepares the task in one transaction so the graph snapshot
   * matches the state the task is about to reason about. A lost race (403/409) is a skip,
   * not an error.
   */
  private startClaimed(
    project: ProjectDetail,
    scope: ProjectScope,
    kind: RunnableTaskKind,
    intent: Intent | undefined,
    trigger?: string,
    pending?: PendingConclude,
  ): boolean {
    const projectId = project.project.id;
    const hostWorkspace = projectWorkspace(this.workspaceRoot, projectId);
    try {
      if (!this.runtime.ensureProject(projectId, hostWorkspace)) {
        this.logOnce(
          `sandbox:${projectId}`,
          `skip project=${projectId} because its sandbox is not available`,
        );
        return false;
      }
      this.loggedSkips.delete(`sandbox:${projectId}`);
    } catch (error) {
      this.log(`sandbox prepare failed project=${projectId}: ${describe(error)}`);
      return false;
    }

    let started: { prepared: PreparedTask; runId: string };
    try {
      started = this.db.withConn((conn) => {
        if (kind === "reason") {
          claimReason(conn, projectId, WORKER_NAME, trigger ?? "initial");
        } else {
          if (intent === undefined) {
            throw new Error(`${kind} task requires an intent`);
          }
          heartbeatIntent(conn, projectId, intent.id, WORKER_NAME);
        }
        // Explore work only needs the causal neighbourhood of its intent; reason and
        // bootstrap need the global graph to propose/complete directions. Slicing stays
        // opt-in (tasks.graph_slice.enabled) so the default export matches Cairn.
        const slice = this.config.tasks.graphSlice;
        const sliceFocus =
          slice.enabled &&
          intent !== undefined &&
          (kind === "explore" || (kind === "conclude" && pending?.of === "explore"))
            ? intent
            : undefined;
        const exportYaml =
          sliceFocus === undefined
            ? exportProjectYaml(conn, projectId)
            : exportProjectSliceYaml(conn, projectId, {
                focusIntentId: sliceFocus.id,
                maxFacts: slice.maxFacts,
                maxIntents: slice.maxIntents,
              });
        // Intent-level budgets are sidecar data; read them in the same transaction that
        // claims the lease so the deadline and tool ceiling belong to this attempt.
        const intentBudget =
          intent === undefined
            ? null
            : (getIntentMeta(conn, projectId, intent.id)?.budget ?? null);
        // Reason sees open-intent dedupe keys and the project's finished-run spend so it
        // can plan under the same budget the dispatch gate enforces.
        const openIntentMeta =
          kind === "reason" ? listProjectIntentMeta(conn, projectId) : undefined;
        const projectBudget =
          kind === "reason"
            ? (() => {
                const usage = getProjectUsage(conn, projectId);
                return {
                  usedTokens: usage.tokens,
                  usedCostUsd: usage.cost_usd,
                  maxTokens: this.config.budget.maxProjectTokens,
                  maxCostUsd: this.config.budget.maxProjectCostUsd,
                };
              })()
            : undefined;
        const prepared = prepareTask({
          config: this.config,
          project,
          exportYaml,
          kind,
          ...(intent === undefined ? {} : { intent }),
          ...(pending === undefined
            ? {}
            : {
                concludeOf: pending.of,
                resumeFromHostSessionDir: pending.hostSessionDir,
              }),
          ...(intentBudget === null ? {} : { budget: intentBudget }),
          ...(openIntentMeta === undefined ? {} : { intentMeta: openIntentMeta }),
          ...(projectBudget === undefined ? {} : { projectBudget }),
          scope,
          workspaceRoot: this.workspaceRoot,
          pathMapper: (hostPath) => this.runtime.mapPath(hostPath),
        });
        // The run row exists before applyResult can attach fact metadata to it, and its
        // id is never supplied by the worker.
        const runId = nextRunId(conn, projectId);
        startRun(conn, {
          id: runId,
          projectId,
          taskId: prepared.task.taskId,
          kind,
          intentId: intent?.id ?? null,
          worker: WORKER_NAME,
          trigger: trigger ?? null,
          startedAt: utcnow(),
          session: workspaceReference(prepared.hostWorkspace, prepared.hostSessionDir),
        });
        return { prepared, runId };
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 409)) {
        this.log(
          `claim lost project=${projectId} task=${kind} status=${error.status}`,
        );
        return false;
      }
      this.log(`task prepare failed project=${projectId} task=${kind}: ${describe(error)}`);
      this.releaseBestEffort({ projectId, kind, intentId: intent?.id });
      // A deterministic prepare error (bad paths, contract bug) must not retry the
      // conclude forever; drop it and let the normal explore path take over.
      if (pending !== undefined) this.dropPending(projectId, pending);
      return false;
    }

    if (
      !this.startProcess(
        started.prepared,
        started.runId,
        kind,
        intent?.id,
        trigger,
        pending?.of,
        pending?.hostSessionDir,
      )
    ) {
      this.releaseBestEffort({ projectId, kind, intentId: intent?.id });
      return false;
    }
    this.log(`dispatched ${kind} project=${projectId}${intent ? ` intent=${intent.id}` : ""}`);
    return true;
  }

  private startProcess(
    prepared: PreparedTask,
    runId: string,
    kind: RunnableTaskKind,
    intentId: string | undefined,
    trigger: string | undefined,
    concludeOf?: ConcludeOf,
    resumeSessionDir?: string,
  ): boolean {
    const task = prepared.task;
    const startedAtMs = Date.now();

    const extraEnv = observerEnvironment(prepared.observer);
    if (task.maxToolCalls !== undefined) {
      extraEnv["CAIRN_TASK_MAX_TOOL_CALLS"] = String(task.maxToolCalls);
    }
    if (this.auditStream !== null) {
      extraEnv["CAIRN_AUDIT_STREAM_URL"] = this.auditStream.url;
      extraEnv["CAIRN_AUDIT_STREAM_TOKEN"] = this.auditStream.tokens.register(
        task.projectId,
        task.taskId,
      );
    }

    let processHandle: WorkerProcess;
    try {
      processHandle = this.runtime.spawnWorker({
        taskId: task.taskId,
        projectId: task.projectId,
        // The controller created the task at the host path; the worker reads it through
        // the runtime path mapping (identity for local, /cairn/workspace for containers).
        workerTaskPath: prepared.workerTaskPath,
        workerWorkspace: task.workspace,
        hostWorkspace: prepared.hostWorkspace,
        baseEnv: this.config.commonEnv,
        controllerEnv: environmentSnapshot(process.env),
        extraEnv,
        hardDeadlineSeconds: task.hardDeadlineSeconds,
      });
    } catch (error) {
      this.auditStream?.tokens.revoke(task.projectId, task.taskId);
      this.log(`worker spawn failed task=${task.taskId}: ${describe(error)}`);
      this.recordRunFinish(
        runId,
        "failed",
        `worker spawn failed: ${describe(error)}`,
        null,
        0,
        startedAtMs,
        null,
      );
      return false;
    }

    const running: RunningTask = {
      taskId: task.taskId,
      runId,
      projectId: task.projectId,
      kind,
      ...(intentId === undefined ? {} : { intentId }),
      ...(concludeOf === undefined ? {} : { concludeOf }),
      ...(resumeSessionDir === undefined ? {} : { resumeSessionDir }),
      openIntentsEmpty: prepared.openIntentsEmpty,
      ...(trigger === undefined ? {} : { trigger }),
      sessionDir: prepared.hostSessionDir,
      resultPath: prepared.hostResultPath,
      hostWorkspace: prepared.hostWorkspace,
      leaseLost: false,
      cancelled: false,
      startedAtMs,
      evidenceCount: 0,
      exitCode: null,
      promise: Promise.resolve(),
    };
    running.promise = this.supervise(running, prepared, processHandle);
    this.running.set(task.taskId, running);
    this.processes.set(task.taskId, processHandle);
    this.loggedSkips.delete(`idle:${task.projectId}`);
    return true;
  }

  // --- supervision ------------------------------------------------------------------

  private async supervise(
    running: RunningTask,
    prepared: PreparedTask,
    processHandle: WorkerProcess,
  ): Promise<void> {
    const task = prepared.task;
    const hardSeconds = task.hardDeadlineSeconds;
    const hardTimer = setTimeout(() => {
      this.log(`hard deadline reached task=${task.taskId}; terminating worker`);
      this.terminate(processHandle);
    }, hardSeconds * 1000);

    const softTimer =
      task.softDeadlineSeconds === undefined
        ? null
        : setTimeout(() => {
            // Steering the solver is M4 work; record the deadline for now.
            this.log(
              `soft deadline reached task=${task.taskId} at ${task.softDeadlineSeconds}s`,
            );
          }, task.softDeadlineSeconds * 1000);

    const leaseTimer = setInterval(() => {
      if (running.leaseLost) return;
      const ok = this.renewLease(running);
      if (!ok) {
        running.leaseLost = true;
        this.log(`lease lost task=${task.taskId}; terminating worker`);
        this.terminate(processHandle);
      }
    }, this.leaseIntervalMs);

    const stdoutPromise = new Response(processHandle.stdout as ReadableStream).text();
    const stderrPromise = new Response(processHandle.stderr as ReadableStream).text();

    let exitCode = -1;
    try {
      exitCode = await processHandle.exited;
    } finally {
      clearTimeout(hardTimer);
      if (softTimer !== null) clearTimeout(softTimer);
      clearInterval(leaseTimer);
    }
    running.exitCode = exitCode;

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    try {
      mkdirSync(running.sessionDir, { recursive: true });
      writeFileSync(join(running.sessionDir, "stdout.log"), stdout, "utf8");
      writeFileSync(join(running.sessionDir, "stderr.log"), stderr, "utf8");
    } catch {
      // Logs are diagnostic only.
    }

    try {
      if (running.cancelled) {
        this.releaseOwnedLease(running);
        this.finish(running, "cancelled", "cancelled");
        return;
      }
      if (running.leaseLost) {
        this.releaseOwnedLease(running);
        this.finish(running, "failed", "lease lost");
        return;
      }
      if (exitCode !== 0) {
        this.log(
          `worker exited task=${task.taskId} code=${exitCode} stderr=${preview(stderr)}`,
        );
        this.failRunning(running, "worker exited");
        this.finish(running, "failed", `worker exited with code ${exitCode}`);
        return;
      }

      const raw = await this.readResult(running);
      if (raw === null) {
        this.log(`result missing task=${task.taskId}`);
        this.failRunning(running, "result missing");
        this.finish(running, "failed", "result missing");
        return;
      }
      const result = parseTaskResultJson(raw);
      if (result === null) {
        this.log(`result invalid task=${task.taskId} preview=${preview(raw)}`);
        this.failRunning(running, "result invalid");
        this.finish(running, "failed", "result invalid");
        return;
      }

      const outcome = await this.applyResult(running, result);
      this.finish(running, outcome, running.detail);
    } catch (error) {
      this.log(`task supervision crashed task=${task.taskId}: ${describe(error)}`);
      this.releaseOwnedLease(running);
      this.finish(running, "failed", `supervision crashed: ${describe(error)}`);
    }
  }

  private async readResult(running: RunningTask): Promise<string | null> {
    const deadline =
      Date.now() + this.config.worker.resultGraceSeconds * 1000;
    for (;;) {
      try {
        const file = Bun.file(running.resultPath);
        if (await file.exists()) {
          return await file.text();
        }
      } catch {
        // Retry until the grace window closes.
      }
      if (Date.now() >= deadline) return null;
      await Bun.sleep(RESULT_POLL_MS);
    }
  }

  private renewLease(task: RunningTask): boolean {
    try {
      return this.db.withConn((conn) =>
        task.kind === "reason"
          ? renewReasonLease(conn, task.projectId, WORKER_NAME)
          : task.intentId === undefined
            ? false
            : renewIntentLease(conn, task.projectId, task.intentId, WORKER_NAME),
      );
    } catch (error) {
      this.log(`lease renewal failed task=${task.taskId}: ${describe(error)}`);
      return false;
    }
  }

  private async applyResult(
    running: RunningTask,
    result: TaskResult,
  ): Promise<TaskOutcome> {
    if (!result.accepted) {
      this.releaseOwnedLease(running);
      return "rejected";
    }

    // Reason turns do not write facts; for every other kind, validate the worker's
    // evidence claim before touching the graph. Missing evidence is recorded, invalid
    // evidence fails the task (the filesystem is untrusted input).
    const evidence: EvidenceCollection =
      running.kind === "reason"
        ? { status: "missing", refs: [], files: [], invalid: [] }
        : collectEvidence(result.evidence_refs, running.hostWorkspace, {
            minBytes: this.config.tasks.evidence.minBytes,
          });
    if (evidence.invalid.length > 0) {
      const reasons = evidence.invalid
        .map((issue) => `${issue.ref || "<ref>"}: ${issue.reason}`)
        .join("; ");
      running.detail = `invalid evidence: ${reasons}`;
      this.log(`evidence rejected task=${running.taskId}: ${reasons}`);
      this.failRunning(running, "evidence invalid");
      return "failed";
    }
    running.evidenceCount = evidence.refs.length;

    // A completion claim is verified before any graph write. The oracle is allowed to
    // call the challenge service, so it runs outside the graph transaction; a failure
    // leaves the project active instead of recording a model-declared completion.
    const claim = completionClaim(running, result, evidence);
    let verification: VerificationOutcome | null = null;
    if (claim !== null) {
      try {
        verification = await this.verification.verify(running.projectId, claim);
      } catch (error) {
        running.detail = `completion verification failed: ${describe(error)}`;
        this.log(`verification error task=${running.taskId}: ${describe(error)}`);
        this.failRunning(running, "verification error");
        return "failed";
      }
      if (!verification.ok) {
        this.log(
          `completion not verified task=${running.taskId} kind=${verification.kind} detail=${verification.detail}`,
        );
        running.detail = `completion not verified: ${verification.detail}`;
      }
    }

    try {
      return this.db.withConn((conn) => {
        switch (running.kind) {
          case "reason": {
            return this.applyReason(conn, running, result.data, verification);
          }
          case "explore": {
            return this.applyExplore(conn, running, result.data, evidence);
          }
          case "bootstrap": {
            return this.applyBootstrap(conn, running, result.data, evidence, verification);
          }
          case "conclude": {
            return this.applyConclude(conn, running, result.data, evidence);
          }
        }
      });
    } catch (error) {
      if (error instanceof HttpError) {
        this.log(
          `apply rejected task=${running.taskId} status=${error.status} detail=${String(error.detail)}`,
        );
        this.releaseOwnedLease(running);
        return error.status === 403 ? "inactive" : "failed";
      }
      this.log(`apply failed task=${running.taskId}: ${describe(error)}`);
      this.failRunning(running, "apply failed");
      return "failed";
    }
  }

  private applyReason(
    conn: Database,
    running: RunningTask,
    data: Record<string, unknown>,
    verification: VerificationOutcome | null,
  ): TaskOutcome {
    const validated = validateReasonPayload(
      { accepted: true, data },
      running.openIntentsEmpty,
      this.config.tasks.reason.maxIntents,
    );
    switch (validated.kind) {
      case "rejected":
        releaseReason(conn, running.projectId, WORKER_NAME);
        return "rejected";
      case "noop":
        return "success";
      case "hints": {
        this.applyReasonHints(conn, running.projectId, validated.data);
        return "success";
      }
      case "complete": {
        const from = requireFactIds(validated.data["from"]);
        const description = requireText(validated.data["description"]);
        // `completionClaim` verified the same fact set before the transaction. A missing
        // outcome here means the claim shape changed under us; fail closed.
        if (verification === null || !verification.ok) {
          releaseReason(conn, running.projectId, WORKER_NAME);
          this.log(
            `completion deferred project=${running.projectId}: ${verification?.detail ?? "no verification result"}`,
          );
          return "rejected";
        }
        completeProject(conn, running.projectId, {
          from,
          description,
          worker: WORKER_NAME,
        });
        return "success";
      }
      case "intents": {
        const hintsCreated = this.applyReasonHints(
          conn,
          running.projectId,
          validated.data.hints,
        );
        let created = 0;
        let deduped = 0;
        for (const entry of validated.data.intents) {
          const from = requireFactIds(entry["from"]);
          const description = requireText(entry["description"]);
          const dedupeKey = dedupeKeyOf(entry["dedupe_key"]);
          if (
            dedupeKey !== null &&
            findOpenIntentByDedupeKey(conn, running.projectId, dedupeKey) !== null
          ) {
            deduped += 1;
            continue;
          }
          try {
            const intent = createIntent(conn, running.projectId, {
              from,
              description,
              creator: WORKER_NAME,
              worker: null,
            });
            const budget = intentBudgetOf(entry["budget"]);
            recordIntentMeta(conn, {
              projectId: running.projectId,
              intentId: intent.id,
              source: "strategist",
              originRunId: running.runId,
              dedupeKey,
              priority: intentPriorityOf(entry["priority"]),
              budget: budget === null ? null : JSON.stringify(budget),
            });
            created += 1;
          } catch (error) {
            if (error instanceof HttpError && error.status === 409) continue;
            throw error;
          }
        }
        return created > 0 || hintsCreated > 0 || deduped > 0
          ? "success"
          : "failed";
      }
    }
  }

  /** Adds strategy hints, skipping exact duplicates already present in the project. */
  private applyReasonHints(
    conn: Database,
    projectId: string,
    hints: readonly Record<string, unknown>[],
  ): number {
    let created = 0;
    for (const hint of hints) {
      const content = requireText(hint["content"]);
      if (findHintByContent(conn, projectId, content) !== null) continue;
      createHint(conn, projectId, { content, creator: WORKER_NAME });
      created += 1;
    }
    return created;
  }

  private applyExplore(
    conn: Database,
    running: RunningTask,
    data: Record<string, unknown>,
    evidence: EvidenceCollection,
  ): TaskOutcome {
    if (running.intentId === undefined) return "failed";
    const validated = validateExplorePayload({ accepted: true, data });
    if (validated.kind === "rejected") {
      releaseIntent(conn, running.projectId, running.intentId, WORKER_NAME);
      return "rejected";
    }
    concludeIntent(
      conn,
      running.projectId,
      running.intentId,
      WORKER_NAME,
      validated.data,
      {
        runId: running.runId,
        evidenceRefs: evidence.refs,
        evidenceStatus: evidence.status,
        evidenceFiles: evidence.files,
      },
    );
    return "success";
  }

  /**
   * Writes the salvage fact from a conclude task. Bootstrap conclude uses the
   * fact-only payload (it must not claim completion); explore conclude uses the normal
   * explore description. The project still has to be completed by a later reason turn.
   */
  private applyConclude(
    conn: Database,
    running: RunningTask,
    data: Record<string, unknown>,
    evidence: EvidenceCollection,
  ): TaskOutcome {
    if (running.intentId === undefined || running.concludeOf === undefined) {
      return "failed";
    }
    const validated =
      running.concludeOf === "bootstrap"
        ? validateBootstrapConcludePayload({ accepted: true, data })
        : validateExplorePayload({ accepted: true, data });
    if (validated.kind === "rejected") {
      releaseIntent(conn, running.projectId, running.intentId, WORKER_NAME);
      return "rejected";
    }
    concludeIntent(
      conn,
      running.projectId,
      running.intentId,
      WORKER_NAME,
      validated.data,
      {
        runId: running.runId,
        evidenceRefs: evidence.refs,
        evidenceStatus: evidence.status,
        evidenceFiles: evidence.files,
      },
    );
    return "success";
  }

  private applyBootstrap(
    conn: Database,
    running: RunningTask,
    data: Record<string, unknown>,
    evidence: EvidenceCollection,
    verification: VerificationOutcome | null,
  ): TaskOutcome {
    if (running.intentId === undefined) return "failed";
    const validated = validateBootstrapExecutePayload({ accepted: true, data });
    if (validated.kind === "rejected") {
      releaseIntent(conn, running.projectId, running.intentId, WORKER_NAME);
      return "rejected";
    }

    const conclude = concludeIntent(
      conn,
      running.projectId,
      running.intentId,
      WORKER_NAME,
      validated.data.factDescription,
      {
        runId: running.runId,
        evidenceRefs: evidence.refs,
        evidenceStatus: evidence.status,
        evidenceFiles: evidence.files,
      },
    );
    // The bootstrap fact is worth keeping even when verification fails; the project stays
    // active and a later reason turn can close it once the oracle agrees.
    if (verification === null || !verification.ok) {
      this.log(
        `bootstrap completion deferred project=${running.projectId}: ${verification?.detail ?? "no verification result"}`,
      );
      return "success";
    }
    try {
      completeProject(conn, running.projectId, {
        from: [conclude.fact.id],
        description: validated.data.completeDescription,
        worker: WORKER_NAME,
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 403 || error.status === 409)) {
        this.log(
          `bootstrap complete deferred project=${running.projectId} status=${error.status}`,
        );
        return "success";
      }
      throw error;
    }
    return "success";
  }

  private finish(running: RunningTask, outcome: TaskOutcome, detail?: string | null): void {
    this.running.delete(running.taskId);
    this.processes.delete(running.taskId);
    // The worker flushed before exiting; no process may append to this chain any more.
    this.auditStream?.tokens.revoke(running.projectId, running.taskId);

    // A conclude task is one salvage attempt. Whether it succeeded or failed, the queued
    // entry is done; a failure releases the intent for the normal explore path.
    if (running.kind === "conclude" && running.intentId !== undefined) {
      try {
        this.db.withConn((conn) =>
          deletePendingConclude(conn, running.projectId, running.intentId!),
        );
      } catch (error) {
        this.log(
          `pending conclude cleanup failed project=${running.projectId} ` +
            `intent=${running.intentId}: ${describe(error)}`,
        );
      }
    }

    this.recordArtifacts(running);
    this.recordAudit(running);
    this.recordAuditStreamLoss(running);
    this.recordProposals(running);
    // Read before the retention cleanup below removes the task directory.
    this.recordRunFinish(
      running.runId,
      outcome,
      detail ?? running.detail ?? null,
      running.exitCode,
      running.evidenceCount,
      running.startedAtMs,
      readTaskUsage(running.sessionDir),
    );

    // Cairn always releases the reason lease in `finally`: success already created the
    // intents/completion, but the claim itself must not outlive the task.
    if (running.kind === "reason") {
      this.releaseBestEffort({ projectId: running.projectId, kind: "reason" });
    }

    if (running.kind === "reason") {
      this.recordStrategistOutcome(running, outcome);
    }
    if (outcome !== "success" && outcome !== "rejected") {
      this.log(
        `task finished project=${running.projectId} task=${running.kind} outcome=${outcome}`,
      );
    }

    if (!this.config.worker.retainTaskFiles) {
      this.removeTaskDir(running.projectId, running.sessionDir);
      // The failed task's directory was kept alive for the conclude; now that the salvage
      // attempt is over, it follows the same retention policy.
      if (running.resumeSessionDir !== undefined) {
        this.removeTaskDir(running.projectId, running.resumeSessionDir);
      }
    }
  }

  private removeTaskDir(projectId: string, hostSessionDir: string): void {
    const workspace = projectWorkspace(this.workspaceRoot, projectId);
    const session = workspaceReference(workspace, hostSessionDir);
    try {
      if (
        this.db.withConn((conn) =>
          isPendingConcludeSession(conn, projectId, session),
        )
      ) {
        return;
      }
    } catch (error) {
      // Fail closed: without a definite answer, keep the directory rather than delete a
      // session a queued conclude still needs.
      this.log(
        `retention check failed project=${projectId} session=${session}: ${describe(error)}`,
      );
      return;
    }
    try {
      rmSync(hostSessionDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }

  /** Forget a queued conclude and release its retained directory per retention policy. */
  private dropPending(projectId: string, pending: PendingConclude): void {
    try {
      this.db.withConn((conn) =>
        deletePendingConclude(conn, projectId, pending.intentId),
      );
    } catch (error) {
      this.log(
        `drop pending failed project=${projectId} intent=${pending.intentId}: ${describe(error)}`,
      );
    }
    if (!this.config.worker.retainTaskFiles) {
      this.removeTaskDir(projectId, pending.hostSessionDir);
    }
  }

  /**
   * Indexes `<workspace>/artifacts` for the project. Artifacts are untrusted output, so
   * indexing never follows symlinks and a failure only logs.
   */
  private recordArtifacts(running: RunningTask): void {
    try {
      const artifacts = this.db.withConn((conn) =>
        recordProjectArtifacts(conn, {
          projectId: running.projectId,
          taskId: running.taskId,
          workspace: running.hostWorkspace,
        }),
      );
      if (artifacts.length > 0) {
        this.log(
          `artifacts indexed project=${running.projectId} task=${running.taskId} count=${artifacts.length}`,
        );
      }
    } catch (error) {
      this.log(
        `artifact indexing failed project=${running.projectId} task=${running.taskId}: ${describe(error)}`,
      );
    }
  }

  /**
   * Imports candidate files the Observer sidecar wrote during this task, then reviews
   * everything pending for the project. Both steps are bookkeeping and never change the
   * task outcome; a malformed candidate is skipped or rejected, not retried forever.
   */
  private recordProposals(running: RunningTask): void {
    try {
      const ingest = ingestTaskProposals(this.db, this.config, {
        projectId: running.projectId,
        taskId: running.taskId,
        runId: running.runId,
        sessionDir: running.sessionDir,
      });
      if (ingest.ingested > 0) {
        this.log(
          `proposals ingested project=${running.projectId} task=${running.taskId} ` +
            `count=${ingest.ingested} skipped=${ingest.skipped}`,
        );
      }
      for (const issue of ingest.issues) {
        this.log(
          `proposal skipped project=${running.projectId} task=${running.taskId}: ${issue}`,
        );
      }
    } catch (error) {
      this.log(
        `proposal ingest failed project=${running.projectId} task=${running.taskId}: ${describe(error)}`,
      );
    }
    this.reviewProjectProposalsFor(running.projectId, running.hostWorkspace);
  }

  /** Failure here must not stop dispatch, so every project is reviewed in isolation. */
  private reviewProjectProposals(projects: readonly ProjectSummary[]): void {
    if (!this.config.proposals.enabled || this.config.proposals.mode === "off") return;
    for (const project of projects) {
      this.reviewProjectProposalsFor(
        project.id,
        projectWorkspace(this.workspaceRoot, project.id),
      );
    }
  }

  private reviewProjectProposalsFor(projectId: string, workspace: string): void {
    if (!this.config.proposals.enabled || this.config.proposals.mode === "off") return;
    try {
      const result = reviewPendingProposals(
        this.db,
        this.config,
        projectId,
        workspace,
        this.log,
      );
      const changed =
        result.applied + result.rejected + result.duplicate + result.dryRun + result.skipped;
      if (changed > 0) {
        this.log(
          `proposals reviewed project=${projectId} applied=${result.applied} ` +
            `rejected=${result.rejected} duplicate=${result.duplicate} ` +
            `dry_run=${result.dryRun} skipped=${result.skipped}`,
        );
      }
    } catch (error) {
      this.log(`proposal review failed project=${projectId}: ${describe(error)}`);
    }
  }

  /**
   * The audit file is written by the worker and may be absent, malformed or huge.
   * Ingestion is sidecar bookkeeping and must never change the task outcome.
   */
  private recordAudit(running: RunningTask): void {
    try {
      const result = ingestTaskAudit(this.db, {
        projectId: running.projectId,
        taskId: running.taskId,
        sessionDir: running.sessionDir,
      });
      if (result.status === "recorded") {
        this.log(
          `audit ingested project=${running.projectId} task=${running.taskId} ` +
            `events=${result.recorded} skipped=${result.skipped}` +
            (result.truncated ? " truncated=true" : ""),
        );
      } else if (result.status === "unreadable") {
        this.log(
          `audit unreadable project=${running.projectId} task=${running.taskId}`,
        );
      }
    } catch (error) {
      this.log(
        `audit ingest failed project=${running.projectId} task=${running.taskId}: ${describe(error)}`,
      );
    }
  }

  /**
   * Makes a live-stream loss visible without touching the task outcome. The marker is
   * worker-written; ingestion validates it and never follows a symlink.
   */
  private recordAuditStreamLoss(running: RunningTask): void {
    try {
      const result = ingestAuditStreamLoss(this.db, {
        projectId: running.projectId,
        taskId: running.taskId,
        sessionDir: running.sessionDir,
      });
      if (result.status === "recorded" && result.loss !== null) {
        this.log(
          `audit stream lost project=${running.projectId} task=${running.taskId} ` +
            `reason=${JSON.stringify(result.loss.reason)} ` +
            `delivered=${result.loss.delivered} pending=${result.loss.pending}`,
        );
      } else if (result.status === "invalid" || result.status === "unreadable") {
        this.log(
          `audit stream marker ${result.status} project=${running.projectId} ` +
            `task=${running.taskId}`,
        );
      }
    } catch (error) {
      this.log(
        `audit stream loss ingest failed project=${running.projectId} ` +
          `task=${running.taskId}: ${describe(error)}`,
      );
    }
  }

  /** Sidecar run bookkeeping must never change the task outcome. */
  private recordRunFinish(
    runId: string,
    outcome: RunOutcome,
    detail: string | null,
    exitCode: number | null,
    evidenceCount: number,
    startedAtMs: number,
    usage: TaskUsage | null,
  ): void {
    try {
      this.db.withConn((conn) =>
        finishRun(conn, runId, {
          outcome,
          finishedAt: utcnow(),
          durationMs: Math.max(0, Date.now() - startedAtMs),
          exitCode,
          evidenceCount,
          detail,
          usage:
            usage === null
              ? null
              : {
                  inputTokens: usage.input_tokens,
                  outputTokens: usage.output_tokens,
                  cacheReadTokens: usage.cache_read_tokens,
                  cacheWriteTokens: usage.cache_write_tokens,
                  totalTokens: usage.total_tokens,
                  costUsd: usage.cost_usd,
                },
        }),
      );
    } catch (error) {
      this.log(`run record failed run=${runId} outcome=${outcome}: ${describe(error)}`);
    }
  }

  private cancel(task: RunningTask, reason: string): void {
    if (task.cancelled) return;
    task.cancelled = true;
    this.log(`cancelling task=${task.taskId} reason=${reason}`);
    const processHandle = this.processes.get(task.taskId);
    if (processHandle !== undefined) this.terminate(processHandle);
  }

  private terminate(processHandle: WorkerProcess): void {
    try {
      processHandle.terminate();
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        processHandle.kill();
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    timer.unref?.();
  }

  private releaseOwnedLease(running: RunningTask): void {
    this.releaseBestEffort({
      projectId: running.projectId,
      kind: running.kind,
      intentId: running.intentId,
    });
  }

  /**
   * On a failed execute task, keep the lease if the solver left a session on disk and
   * queue a conclude turn; otherwise release so the intent can be explored again.
   */
  private failRunning(running: RunningTask, why: string): void {
    if (this.queueConclude(running, why)) return;
    this.releaseOwnedLease(running);
  }

  private queueConclude(running: RunningTask, why: string): boolean {
    if (running.kind !== "explore" && running.kind !== "bootstrap") return false;
    if (running.intentId === undefined) return false;
    const sessionFile = latestSolverSessionFile(running.sessionDir);
    if (sessionFile === null) {
      this.log(
        `conclude unavailable task=${running.taskId} (${why}): no solver session on disk`,
      );
      return false;
    }
    const { projectId, intentId, kind } = running;
    const session = workspaceReference(running.hostWorkspace, running.sessionDir);
    let alreadyQueued: boolean;
    try {
      alreadyQueued = this.db.withConn((conn) => {
        if (hasPendingConclude(conn, projectId, intentId)) return true;
        recordPendingConclude(conn, { projectId, intentId, phase: kind, session });
        return false;
      });
    } catch (error) {
      this.log(`conclude queue failed task=${running.taskId}: ${describe(error)}`);
      return false;
    }
    if (alreadyQueued) return true;
    this.log(
      `conclude queued project=${projectId} intent=${intentId} ` +
        `phase=${kind} reason=${why} session=${sessionFile}`,
    );
    return true;
  }

  private pendingConcludeFor(projectId: string): PendingConclude | undefined {
    let row: PendingConcludeRow | null;
    try {
      row = this.db.withConn((conn) => getPendingConclude(conn, projectId));
    } catch (error) {
      this.log(`pending conclude load failed project=${projectId}: ${describe(error)}`);
      return undefined;
    }
    if (row === null) return undefined;
    // Rebuild from the current workspace root: the stored path is relative, so the queue
    // keeps working if the control plane restarts with a different root.
    return {
      intentId: row.intent_id,
      of: row.phase,
      hostSessionDir: this.pendingHostSession(row),
    };
  }

  private isIntentRunning(projectId: string, intentId: string): boolean {
    for (const task of this.running.values()) {
      if (task.projectId === projectId && task.intentId === intentId) return true;
    }
    return false;
  }

  private releaseBestEffort(context: {
    projectId: string;
    kind: RunnableTaskKind;
    intentId?: string;
  }): void {
    try {
      this.db.withConn((conn) => {
        if (context.kind === "reason") {
          releaseReason(conn, context.projectId, WORKER_NAME);
        } else if (context.intentId !== undefined) {
          releaseIntent(conn, context.projectId, context.intentId, WORKER_NAME);
        }
      });
    } catch (error) {
      if (error instanceof HttpError && [403, 404, 409].includes(error.status)) {
        return;
      }
      this.log(
        `lease release failed project=${context.projectId} task=${context.kind}: ${describe(error)}`,
      );
    }
  }

  // --- scheduling helpers -----------------------------------------------------------

  private strategistTrigger(project: ProjectDetail): string | null {
    const projectId = project.project.id;
    const policy = this.config.strategist;
    const now = this.now();

    const runningTasks = [...this.running.values()].filter(
      (task) => task.projectId === projectId && task.kind !== "reason",
    );
    const runningIntentIds = new Set<string>();
    for (const task of runningTasks) {
      if (task.intentId !== undefined) runningIntentIds.add(task.intentId);
    }

    let snapshot: {
      state: ReturnType<typeof getStrategistState>;
      recentRuns: ReturnType<typeof listRecentStrategistRuns>;
      reasonRunsLastHour: number;
      budget?: {
        usedTokens: number;
        usedCostUsd: number;
        maxTokens: number;
        maxCostUsd: number;
      };
    };
    try {
      snapshot = this.db.withConn((conn) => {
        const since = new Date(now.getTime() - 3_600_000).toISOString();
        const limit =
          policy.zeroOutputThreshold > 0
            ? Math.max(policy.zeroOutputThreshold, 10)
            : 0;
        const pressureEnabled =
          policy.resourcePressureRatio > 0 &&
          (this.config.budget.maxProjectTokens > 0 ||
            this.config.budget.maxProjectCostUsd > 0);
        const usage = pressureEnabled ? getProjectUsage(conn, projectId) : null;
        return {
          state: getStrategistState(conn, projectId),
          recentRuns:
            limit > 0 ? listRecentStrategistRuns(conn, projectId, limit) : [],
          reasonRunsLastHour:
            policy.maxRunsPerHour > 0
              ? countReasonRunsSince(conn, projectId, since)
              : 0,
          ...(usage === null
            ? {}
            : {
                budget: {
                  usedTokens: usage.tokens,
                  usedCostUsd: usage.cost_usd,
                  maxTokens: this.config.budget.maxProjectTokens,
                  maxCostUsd: this.config.budget.maxProjectCostUsd,
                },
              }),
        };
      });
    } catch (error) {
      // Without reliable watermarks, stay in the fast layer rather than risk a reason
      // loop. Explore work keeps running.
      this.log(`strategist state load failed project=${projectId}: ${describe(error)}`);
      return null;
    }

    const evaluation = evaluateStrategistTrigger({
      project,
      state: snapshot.state,
      recentRuns: snapshot.recentRuns,
      reasonRunsLastHour: snapshot.reasonRunsLastHour,
      runningProductiveTasks: runningTasks.length,
      runningIntentIds,
      ...(snapshot.budget === undefined ? {} : { budget: snapshot.budget }),
      now,
      policy,
    });

    if (evaluation.trigger !== null) {
      for (const reason of [
        "failure_backoff",
        "cooldown",
        "rate_limit",
        "tasks_running",
      ]) {
        this.loggedSkips.delete(`strategist:${projectId}:${reason}`);
      }
      return evaluation.trigger;
    }
    if (evaluation.suppressed !== null) {
      this.logOnce(
        `strategist:${projectId}:${evaluation.suppressed}`,
        `slow-layer suppressed project=${projectId} reason=${evaluation.suppressed} ` +
          `facts_delta=${evaluation.factsDelta} hints_delta=${evaluation.hintsDelta} ` +
          `open_intents=${evaluation.openIntentCount} ` +
          `zero_output_streak=${evaluation.zeroOutputStreak}`,
      );
    }
    return null;
  }

  private recordStrategistOutcome(
    running: RunningTask,
    outcome: TaskOutcome,
  ): void {
    const trigger = running.trigger;
    if (trigger === undefined) return;
    try {
      if (outcome === "success") {
        const detail = this.db.withConn((conn) =>
          getProjectDetail(conn, running.projectId),
        );
        const openIntentCount = detail.intents.filter(
          (intent) => intent.to === null,
        ).length;
        this.db.withConn((conn) =>
          recordStrategistSuccess(conn, {
            projectId: running.projectId,
            runId: running.runId,
            trigger,
            factCount: detail.facts.length,
            hintCount: detail.hints.length,
            openIntentCount,
          }),
        );
      } else if (
        outcome === "failed" ||
        outcome === "rejected" ||
        outcome === "unhealthy"
      ) {
        this.db.withConn((conn) =>
          recordStrategistFailure(conn, {
            projectId: running.projectId,
            runId: running.runId,
            trigger,
          }),
        );
      }
    } catch (error) {
      // State is advisory: a bookkeeping failure must not change the task result.
      this.log(
        `strategist state update failed project=${running.projectId} ` +
          `task=${running.taskId}: ${describe(error)}`,
      );
    }
  }

  private order(summaries: readonly ProjectSummary[]): ProjectSummary[] {
    if (summaries.length === 0) return [];
    const ids = summaries.map((summary) => summary.id);
    ids.sort();
    const offset = this.projectCursor % ids.length;
    this.projectCursor += 1;
    const orderedIds = ids.slice(offset).concat(ids.slice(0, offset));
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    return orderedIds.map((id) => byId.get(id)!);
  }

  private activeRunningProjectIds(active: readonly ProjectSummary[]): Set<string> {
    const activeIds = new Set(active.map((summary) => summary.id));
    const ids = new Set<string>();
    for (const task of this.running.values()) {
      if (activeIds.has(task.projectId)) ids.add(task.projectId);
    }
    return ids;
  }

  private runningProjectCount(active: readonly ProjectSummary[]): number {
    return this.activeRunningProjectIds(active).size;
  }

  private projectTaskCount(projectId: string): number {
    let count = 0;
    for (const task of this.running.values()) {
      if (task.projectId === projectId) count += 1;
    }
    return count;
  }

  /** Per-project concurrency quota; a budget of 0 inherits the runtime default. */
  private projectTaskLimit(): number {
    const configured = this.config.budget.maxProjectTasks;
    if (configured <= 0) return this.config.runtime.maxProjectWorkers;
    return Math.min(configured, this.config.runtime.maxWorkers);
  }

  private intentMetaFor(projectId: string): Map<string, IntentMeta> {
    try {
      const rows = this.db.withConn((conn) =>
        listProjectIntentMeta(conn, projectId),
      );
      this.loggedSkips.delete(`intent-meta:${projectId}`);
      return new Map(rows.map((row) => [row.intent_id, row]));
    } catch (error) {
      // Priority is advisory: fall back to newest-first instead of stalling dispatch.
      this.logOnce(
        `intent-meta:${projectId}`,
        `intent metadata load failed project=${projectId}: ${describe(error)}`,
      );
      return new Map();
    }
  }

  /**
   * Token/cost ceilings are per project and checked against all recorded runs. Tasks in
   * flight have not reported usage yet, so the next dispatch after they finish is the
   * first one that sees their full cost.
   */
  private projectBudgetExhausted(projectId: string): boolean {
    const limits = this.config.budget;
    if (limits.maxProjectTokens <= 0 && limits.maxProjectCostUsd <= 0) return false;

    let usage;
    try {
      usage = this.db.withConn((conn) => getProjectUsage(conn, projectId));
    } catch (error) {
      // Fail closed: an unreadable budget must not let spend run unbounded.
      this.logOnce(
        `budget:${projectId}:unavailable`,
        `budget lookup failed project=${projectId}: ${describe(error)}; skipping dispatch`,
      );
      return true;
    }

    const tokenKey = `budget:${projectId}:tokens`;
    const costKey = `budget:${projectId}:cost`;
    if (
      limits.maxProjectTokens > 0 &&
      usage.tokens >= limits.maxProjectTokens
    ) {
      this.logOnce(
        tokenKey,
        `budget exhausted project=${projectId} tokens=${usage.tokens}/${limits.maxProjectTokens}`,
      );
      return true;
    }
    if (
      limits.maxProjectCostUsd > 0 &&
      usage.cost_usd >= limits.maxProjectCostUsd
    ) {
      this.logOnce(
        costKey,
        `budget exhausted project=${projectId} cost_usd=${usage.cost_usd}/` +
          `${limits.maxProjectCostUsd}`,
      );
      return true;
    }
    this.loggedSkips.delete(tokenKey);
    this.loggedSkips.delete(costKey);
    return false;
  }

  private hasRunningBootstrap(projectId: string): boolean {
    for (const task of this.running.values()) {
      if (task.projectId === projectId && task.kind === "bootstrap") return true;
    }
    return false;
  }

  private logOnce(key: string, message: string): void {
    if (this.loggedSkips.has(key)) return;
    this.loggedSkips.add(key);
    this.log(message);
  }
}

/** Workspace-relative, forward-slash session path for the runs API (no host paths). */
function workspaceReference(workspace: string, target: string): string {
  return relative(workspace, target).split(sep).join("/");
}

function isInitialProject(project: ProjectDetail): boolean {
  const ids = project.facts.map((fact) => fact.id);
  if (ids.length !== 2 || !ids.includes("origin") || !ids.includes("goal")) {
    return false;
  }
  if (project.intents.length === 0) return true;
  return project.intents.every(isBootstrapIntent);
}

function isBootstrapIntent(intent: Intent): boolean {
  return (
    intent.description === BOOTSTRAP_INTENT_DESCRIPTION &&
    intent.creator === BOOTSTRAP_INTENT_CREATOR &&
    intent.from.length === 1 &&
    intent.from[0] === "origin" &&
    intent.to === null
  );
}

/**
 * Reason is still dispatched before explore when its trigger fires; within the fast layer,
 * higher-priority intents go first, then the newest, then the id for determinism.
 */
function pickByPriority(
  intents: readonly Intent[],
  meta: ReadonlyMap<string, IntentMeta>,
): Intent {
  let best = intents[0]!;
  for (const intent of intents) {
    if (compareIntentPriority(intent, best, meta) < 0) best = intent;
  }
  return best;
}

function compareIntentPriority(
  left: Intent,
  right: Intent,
  meta: ReadonlyMap<string, IntentMeta>,
): number {
  const leftPriority = meta.get(left.id)?.priority ?? DEFAULT_INTENT_PRIORITY;
  const rightPriority = meta.get(right.id)?.priority ?? DEFAULT_INTENT_PRIORITY;
  if (leftPriority !== rightPriority) return rightPriority - leftPriority;
  if (left.created_at !== right.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }
  return right.id.localeCompare(left.id);
}

function intentPriorityOf(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : DEFAULT_INTENT_PRIORITY;
}

function dedupeKeyOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key === "" ? null : key;
}

function intentBudgetOf(value: unknown): ReasonIntentBudget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const budget: ReasonIntentBudget = {};
  const seconds = record["max_seconds"];
  if (typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0) {
    budget.max_seconds = seconds;
  }
  const calls = record["max_tool_calls"];
  if (typeof calls === "number" && Number.isInteger(calls) && calls > 0) {
    budget.max_tool_calls = calls;
  }
  return Object.keys(budget).length === 0 ? null : budget;
}

/**
 * Recognizes the two task kinds that can close a project and describes what the oracle
 * must verify. Malformed claims return null here; the normal payload validation in the
 * apply step reports the real error.
 */
function completionClaim(
  running: RunningTask,
  result: TaskResult,
  evidence: EvidenceCollection,
): VerificationOptions | null {
  if (!result.accepted) return null;
  if (running.kind === "bootstrap") {
    return {
      taskEvidence: { status: evidence.status, refs: evidence.refs },
    };
  }
  if (running.kind !== "reason") return null;

  let payload: Record<string, unknown> = result.data;
  const nested = asRecord(payload["data"]);
  if (payload["accepted"] === true && nested !== null) {
    payload = nested;
  }
  const complete = asRecord(payload["complete"]);
  if (complete === null) return null;
  const from = complete["from"];
  if (!Array.isArray(from) || from.length === 0) return null;
  if (from.some((factId) => typeof factId !== "string" || factId.trim() === "")) {
    return null;
  }
  return { facts: from.map((factId) => (factId as string).trim()) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireFactIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("fact ids must be a non-empty array");
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error("fact ids must be non-empty strings");
    }
    return item.trim();
  });
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("description must be a non-empty string");
  }
  return value.trim();
}

function preview(text: string, limit = 1200): string {
  const compact = text.split(/\s+/).filter(Boolean).join(" ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
