/**
 * In-process scheduler.
 *
 * It owns dispatch decisions and is the only writer of leases and the graph. Workers get
 * a task file and a result path; they never touch SQLite. Semantics follow Cairn's
 * dispatcher loop (bootstrap/reason/explore priority, reason triggers, leases, timeout
 * handling), minus the HTTP hop and the per-worker type registry.
 */

import {
  parseTaskResultJson,
  validateBootstrapConcludePayload,
  validateBootstrapExecutePayload,
  validateExplorePayload,
  validateReasonPayload,
  type TaskResult,
} from "@cairn/contracts";
import {
  HttpError,
  claimReason,
  completeProject,
  concludeIntent,
  createIntent,
  exportProjectSliceYaml,
  exportProjectYaml,
  finishRun,
  getProjectDetail,
  getProjectScope,
  heartbeatIntent,
  listProjects,
  nextRunId,
  releaseIntent,
  releaseReason,
  recordProjectArtifacts,
  renewIntentLease,
  renewReasonLease,
  startRun,
  utcnow,
  type CairnDatabase,
  type Intent,
  type ProjectDetail,
  type ProjectScope,
  type ProjectSummary,
  type RunOutcome,
} from "@cairn/graph";
import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { DispatchConfig } from "../config";
import { createRuntime, type RuntimeBackend, type WorkerProcess } from "../runtime";
import { environmentSnapshot } from "../runtime/types";
import { latestSolverSessionFile } from "../solver/session-file";
import { collectEvidence, type EvidenceCollection } from "./evidence";
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
}

interface ReasonCheckpoint {
  factCount: number;
  hintCount: number;
  openIntentCount: number;
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
  checkpoint: ReasonCheckpoint;
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

  private readonly running = new Map<string, RunningTask>();
  /** Keyed by `<projectId>:<intentId>`; survives only in this scheduler process. */
  private readonly pendingConcludes = new Map<string, PendingConclude>();
  private readonly checkpoints = new Map<string, ReasonCheckpoint>();
  private readonly loggedSkips = new Set<string>();
  private readonly processes = new Map<string, WorkerProcess>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private projectCursor = 0;

  constructor(options: SchedulerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.workspaceRoot = resolveWorkspaceRoot(options.config, options.workspaceRoot);
    this.log = options.log ?? ((message) => console.error(`[scheduler] ${message}`));
    this.runtime =
      options.runtime ??
      createRuntime({
        config: options.config,
        log: this.log,
        ...(options.workerArgv === undefined ? {} : { workerArgv: options.workerArgv }),
      });
    this.leaseIntervalMs =
      options.leaseIntervalMs ?? this.config.runtime.interval * 1000;
  }

  get runningCount(): number {
    return this.running.size;
  }

  /** Background mode used by `cairn serve --config`. */
  start(): void {
    if (this.timer !== null) return;
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

  // --- dispatch ---------------------------------------------------------------------

  /** Returns true when at least one task was started. */
  private tick(): boolean {
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
    this.initializeCheckpoints(active);

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
    if (this.projectTaskCount(summary.id) >= this.config.runtime.maxProjectWorkers) {
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

    if (isInitialProject(project)) {
      if (project.project.reason !== null) return false;
      if (project.project.bootstrap_enabled) {
        return this.dispatchBootstrap(project, scope);
      }
      return this.dispatchReason(project, scope, "initial");
    }

    if (project.project.reason === null) {
      const trigger = this.reasonTrigger(project);
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
      return this.dispatchExplore(project, scope, pickNewest(unclaimed));
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

    const checkpoint: ReasonCheckpoint = {
      factCount: project.facts.length,
      hintCount: project.hints.length,
      openIntentCount: project.intents.filter((entry) => entry.to === null).length,
    };
    if (
      !this.startProcess(
        started.prepared,
        started.runId,
        kind,
        intent?.id,
        checkpoint,
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
    checkpoint: ReasonCheckpoint,
    concludeOf?: ConcludeOf,
    resumeSessionDir?: string,
  ): boolean {
    const task = prepared.task;
    const startedAtMs = Date.now();

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
        extraEnv: observerEnvironment(prepared.observer),
        hardDeadlineSeconds: task.hardDeadlineSeconds,
      });
    } catch (error) {
      this.log(`worker spawn failed task=${task.taskId}: ${describe(error)}`);
      this.recordRunFinish(
        runId,
        "failed",
        `worker spawn failed: ${describe(error)}`,
        null,
        0,
        startedAtMs,
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
      checkpoint,
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

      const outcome = this.applyResult(running, result);
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

  private applyResult(running: RunningTask, result: TaskResult): TaskOutcome {
    if (!result.accepted) {
      this.releaseOwnedLease(running);
      return "rejected";
    }

    // Reason turns do not write facts; for every other kind, validate the worker's
    // evidence claim before touching the graph. Missing evidence is recorded, invalid
    // evidence fails the task (the filesystem is untrusted input).
    const evidence: EvidenceCollection =
      running.kind === "reason"
        ? { status: "missing", refs: [], invalid: [] }
        : collectEvidence(result.evidence_refs, running.hostWorkspace);
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

    try {
      return this.db.withConn((conn) => {
        switch (running.kind) {
          case "reason": {
            return this.applyReason(conn, running, result.data);
          }
          case "explore": {
            return this.applyExplore(conn, running, result.data, evidence);
          }
          case "bootstrap": {
            return this.applyBootstrap(conn, running, result.data, evidence);
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
      case "complete": {
        const from = requireFactIds(validated.data["from"]);
        const description = requireText(validated.data["description"]);
        completeProject(conn, running.projectId, {
          from,
          description,
          worker: WORKER_NAME,
        });
        return "success";
      }
      case "intents": {
        let created = 0;
        for (const entry of validated.data) {
          const from = requireFactIds(entry["from"]);
          const description = requireText(entry["description"]);
          try {
            createIntent(conn, running.projectId, {
              from,
              description,
              creator: WORKER_NAME,
              worker: null,
            });
            created += 1;
          } catch (error) {
            if (error instanceof HttpError && error.status === 409) continue;
            throw error;
          }
        }
        return created > 0 ? "success" : "failed";
      }
    }
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
      },
    );
    return "success";
  }

  private applyBootstrap(
    conn: Database,
    running: RunningTask,
    data: Record<string, unknown>,
    evidence: EvidenceCollection,
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
      },
    );
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

    // A conclude task is one salvage attempt. Whether it succeeded or failed, the queued
    // entry is done; a failure releases the intent for the normal explore path.
    if (running.kind === "conclude" && running.intentId !== undefined) {
      this.pendingConcludes.delete(pendingKey(running.projectId, running.intentId));
    }

    this.recordArtifacts(running);
    this.recordRunFinish(
      running.runId,
      outcome,
      detail ?? running.detail ?? null,
      running.exitCode,
      running.evidenceCount,
      running.startedAtMs,
    );

    // Cairn always releases the reason lease in `finally`: success already created the
    // intents/completion, but the claim itself must not outlive the task.
    if (running.kind === "reason") {
      this.releaseBestEffort({ projectId: running.projectId, kind: "reason" });
    }

    if (outcome === "success" && running.kind === "reason") {
      this.checkpoints.set(running.projectId, running.checkpoint);
    }
    if (outcome !== "success" && outcome !== "rejected") {
      this.log(
        `task finished project=${running.projectId} task=${running.kind} outcome=${outcome}`,
      );
    }

    if (!this.config.worker.retainTaskFiles) {
      this.removeTaskDir(running.sessionDir);
      // The failed task's directory was kept alive for the conclude; now that the salvage
      // attempt is over, it follows the same retention policy.
      if (running.resumeSessionDir !== undefined) {
        this.removeTaskDir(running.resumeSessionDir);
      }
    }
  }

  private removeTaskDir(hostSessionDir: string): void {
    if (this.isPendingSession(hostSessionDir)) return;
    try {
      rmSync(hostSessionDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }

  private isPendingSession(hostSessionDir: string): boolean {
    for (const pending of this.pendingConcludes.values()) {
      if (pending.hostSessionDir === hostSessionDir) return true;
    }
    return false;
  }

  /** Forget a queued conclude and release its retained directory per retention policy. */
  private dropPending(projectId: string, pending: PendingConclude): void {
    this.pendingConcludes.delete(pendingKey(projectId, pending.intentId));
    if (!this.config.worker.retainTaskFiles) {
      this.removeTaskDir(pending.hostSessionDir);
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

  /** Sidecar run bookkeeping must never change the task outcome. */
  private recordRunFinish(
    runId: string,
    outcome: RunOutcome,
    detail: string | null,
    exitCode: number | null,
    evidenceCount: number,
    startedAtMs: number,
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
    const key = pendingKey(running.projectId, running.intentId);
    if (this.pendingConcludes.has(key)) return true;
    this.pendingConcludes.set(key, {
      intentId: running.intentId,
      of: running.kind,
      hostSessionDir: running.sessionDir,
    });
    this.log(
      `conclude queued project=${running.projectId} intent=${running.intentId} ` +
        `phase=${running.kind} reason=${why} session=${sessionFile}`,
    );
    return true;
  }

  private pendingConcludeFor(projectId: string): PendingConclude | undefined {
    for (const [key, pending] of this.pendingConcludes) {
      if (key.startsWith(`${projectId}:`)) return pending;
    }
    return undefined;
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

  private initializeCheckpoints(active: readonly ProjectSummary[]): void {
    for (const summary of active) {
      if (this.checkpoints.has(summary.id)) continue;
      const openIntentCount =
        summary.working_intent_count + summary.unclaimed_intent_count;
      if (openIntentCount === 0) continue;
      this.checkpoints.set(summary.id, {
        factCount: summary.fact_count,
        hintCount: summary.hint_count,
        openIntentCount,
      });
    }
  }

  private reasonTrigger(project: ProjectDetail): string | null {
    const checkpoint = this.checkpoints.get(project.project.id);
    if (checkpoint === undefined) return "initial";

    const openIntentCount = project.intents.filter((intent) => intent.to === null).length;
    const changes: string[] = [];
    if (project.facts.length > checkpoint.factCount) {
      changes.push(`facts:${checkpoint.factCount}->${project.facts.length}`);
    }
    if (project.hints.length > checkpoint.hintCount) {
      changes.push(`hints:${checkpoint.hintCount}->${project.hints.length}`);
    }
    if (checkpoint.openIntentCount > 0 && openIntentCount === 0) {
      changes.push(`open_intents:${checkpoint.openIntentCount}->0`);
    }
    return changes.length === 0 ? null : changes.join(",");
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

function pendingKey(projectId: string, intentId: string): string {
  return `${projectId}:${intentId}`;
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

function pickNewest(intents: readonly Intent[]): Intent {
  let newest = intents[0]!;
  for (const intent of intents) {
    if (intent.created_at > newest.created_at) newest = intent;
  }
  return newest;
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
