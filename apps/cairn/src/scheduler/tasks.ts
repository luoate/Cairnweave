/**
 * Turns a project snapshot into one worker task: renders the Cairn prompt, writes the
 * graph snapshot and task.json into the project's session directory, and returns the
 * contract the supervisor spawns.
 */

import {
  DEFAULT_INTENT_PRIORITY,
  TASK_PROTOCOL_VERSION,
  type ScopePolicy,
  type TaskKind,
  type WorkerTask,
} from "@cairn/contracts";
import type {
  Intent,
  IntentBudget,
  IntentMeta,
  ProjectDetail,
  ProjectScope,
} from "@cairn/graph";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DispatchConfig } from "../config";
import { mapScopeTargetForWorker } from "../runtime/paths";
import {
  formatFactIds,
  formatHints,
  formatOpenIntents,
  graphSnapshotReference,
  loadPrompt,
  renderPrompt,
} from "../prompts/prompting";

export type RunnableTaskKind = TaskKind;
export type ConcludeOf = "bootstrap" | "explore";

/** Candidate-file writer contract for the Observer sidecar. */
export interface PreparedProposals {
  /** Worker-view `<stateDir>/proposals`. */
  dir: string;
  projectId: string;
  taskId: string;
  allowKinds: string[];
  maxPerTask: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  minConfidence: number;
  requireEvidenceForFact: boolean;
}

/** Worker-side coordinates for the opt-in Observer sidecar. */
export interface PreparedObserver {
  enabled: boolean;
  /** Compact project/focus snapshot written for the reviewer. */
  contextPath: string;
  /** Durable, project-level ideas/memory board. */
  boardDir: string;
  /** Per-task review queue/state and sidecar session directory. */
  stateDir: string;
  model: string | null;
  everyRounds: number;
  windowRounds: number;
  timeoutSeconds: number;
  maxReviewsPerTask: number;
  /** Null when proposals are disabled, the mode is off, or the Observer is off. */
  proposals: PreparedProposals | null;
}

export interface PreparedTask {
  task: WorkerTask;
  /** Host-side task file (control plane reads/writes this path). */
  taskPath: string;
  /** Worker-view task file (container path in container mode). */
  workerTaskPath: string;
  /** Host-side project workspace. */
  workspace: string;
  hostWorkspace: string;
  hostSessionDir: string;
  hostGraphSnapshotPath: string;
  hostResultPath: string;
  hostTaskPath: string;
  /** Reason needs to know whether the graph had open intents when it was dispatched. */
  openIntentsEmpty: boolean;
  observer: PreparedObserver;
}

export interface PrepareTaskInput {
  config: DispatchConfig;
  project: ProjectDetail;
  exportYaml: string;
  kind: RunnableTaskKind;
  intent?: Intent;
  scope: ProjectScope;
  /** Conclude only: the failed phase whose session is being wrapped up. */
  concludeOf?: ConcludeOf;
  /** Conclude only: host-side session directory of that failed phase. */
  resumeFromHostSessionDir?: string;
  /** Optional intent-level limits stored in `intent_meta` (reason output only). */
  budget?: IntentBudget | null;
  /** Reason only: sidecar metadata for open intents, used for dedupe visibility. */
  intentMeta?: readonly IntentMeta[];
  /** Reason only: finished-run usage and the configured per-project limits. */
  projectBudget?: ProjectBudgetSnapshot;
  /** Profile selected for this dispatch; absent in prompt-mode deployments. */
  workerProfile?: PreparedWorkerProfile;
  /** Test hook; otherwise resolved from config.local/container.workspace_root or cwd. */
  workspaceRoot?: string;
  /** Host -> worker path mapper. Identity in local mode. */
  pathMapper?: (hostPath: string) => string;
}

export interface PreparedWorkerProfile {
  id: string;
  /** model-prefs.json entry name. */
  model: string;
}

export interface ProjectBudgetSnapshot {
  usedTokens: number;
  usedCostUsd: number;
  maxTokens: number;
  maxCostUsd: number;
}

export function resolveWorkspaceRoot(
  config: DispatchConfig,
  override?: string,
): string {
  return (
    override ??
    config.container?.workspaceRoot ??
    config.local?.workspaceRoot ??
    process.cwd()
  );
}

export function projectWorkspace(root: string, projectId: string): string {
  return join(root, projectId.replaceAll("/", "-"));
}

export function prepareTask(input: PrepareTaskInput): PreparedTask {
  const { config, project, kind } = input;
  const hostWorkspace = projectWorkspace(
    resolveWorkspaceRoot(config, input.workspaceRoot),
    project.project.id,
  );
  const taskId = `${kind}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const artifactDir =
    config.worker.scopedArtifacts ? `artifacts/${taskId}` : undefined;
  const hostSessionDir = join(hostWorkspace, ".cairn", "sessions", taskId);
  const hostGraphSnapshotPath = join(hostSessionDir, "graph.yaml");
  const hostResultPath = join(hostSessionDir, "result.json");
  const hostTaskPath = join(hostSessionDir, "task.json");

  const mapPath = input.pathMapper ?? ((hostPath: string) => hostPath);
  const workerWorkspace = mapPath(hostWorkspace);
  const workerSessionDir = mapPath(hostSessionDir);
  const workerGraphSnapshotPath = mapPath(hostGraphSnapshotPath);
  const workerResultPath = mapPath(hostResultPath);
  const workerTaskPath = mapPath(hostTaskPath);

  const concludeOf = kind === "conclude" ? input.concludeOf : undefined;
  if (kind === "conclude" && concludeOf === undefined) {
    throw new Error("conclude task requires concludeOf");
  }
  const resumeSessionDir =
    kind === "conclude"
      ? mapPath(requireResumeDir(input.resumeFromHostSessionDir))
      : undefined;

  // An intent budget can only tighten the kind timeout, never extend it.
  const hardDeadlineSeconds = capDeadline(
    hardDeadline(config, kind, concludeOf),
    input.budget?.max_seconds,
  );
  const softDeadlineSeconds =
    kind === "conclude" ? undefined : softDeadline(config, hardDeadlineSeconds);
  const openIntents = project.intents.filter((intent) => intent.to === null);
  const intentMeta = new Map(
    (input.intentMeta ?? []).map((entry) => [entry.intent_id, entry]),
  );

  mkdirSync(hostSessionDir, { recursive: true });
  writeFileSync(hostGraphSnapshotPath, input.exportYaml.trim(), "utf8");

  const basePrompt = renderTaskPrompt(config, project, kind, input.intent, {
    graphSnapshotPath: workerGraphSnapshotPath,
    openIntents: openIntents.map((intent) => {
      const meta = intentMeta.get(intent.id);
      return {
        id: intent.id,
        from: intent.from,
        description: intent.description,
        worker: intent.worker,
        priority: meta?.priority ?? DEFAULT_INTENT_PRIORITY,
        budget: meta?.budget ?? null,
        dedupe_key: meta?.dedupe_key ?? null,
        source: meta?.source ?? null,
      };
    }),
    ...(input.projectBudget === undefined ? {} : { projectBudget: input.projectBudget }),
  }, concludeOf);
  const prompt = withCompletionPolicy(
    artifactDir === undefined
      ? basePrompt
      : withArtifactPolicy(basePrompt, artifactDir),
  );

  const mapScopePath = (hostPath: string): string | null => {
    try {
      return mapPath(hostPath);
    } catch {
      return null;
    }
  };
  const scope: ScopePolicy =
    input.scope.notes === undefined
      ? {
          targets: input.scope.targets.map((target) =>
            mapScopeTargetForWorker(target, mapScopePath),
          ),
        }
      : {
          targets: input.scope.targets.map((target) =>
            mapScopeTargetForWorker(target, mapScopePath),
          ),
          notes: input.scope.notes,
        };

  const task: WorkerTask = {
    protocol: TASK_PROTOCOL_VERSION,
    taskId,
    kind,
    projectId: project.project.id,
    ...(input.intent === undefined ? {} : { intentId: input.intent.id }),
    prompt,
    graphSnapshotPath: workerGraphSnapshotPath,
    workspace: workerWorkspace,
    sessionDir: workerSessionDir,
    ...(resumeSessionDir === undefined ? {} : { resumeSessionDir }),
    ...(concludeOf === undefined ? {} : { concludeOf }),
    resultPath: workerResultPath,
    ...(artifactDir === undefined ? {} : { artifactDir }),
    scope,
    ...(softDeadlineSeconds === undefined ? {} : { softDeadlineSeconds }),
    hardDeadlineSeconds,
    ...(input.budget?.max_tool_calls === undefined
      ? {}
      : { maxToolCalls: input.budget.max_tool_calls }),
    ...(input.workerProfile === undefined
      ? {}
      : {
          workerProfile: input.workerProfile.id,
          model: input.workerProfile.model,
        }),
  };

  const observer = prepareObserver(config, project, kind, task, scope, {
    mapPath,
    hostWorkspace,
    hostSessionDir,
  });

  writeFileSync(hostTaskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  return {
    task,
    taskPath: hostTaskPath,
    workerTaskPath,
    workspace: hostWorkspace,
    hostWorkspace,
    hostSessionDir,
    hostGraphSnapshotPath,
    hostResultPath,
    hostTaskPath,
    openIntentsEmpty: openIntents.length === 0,
    observer,
  };
}

interface ObserverPaths {
  mapPath: (hostPath: string) => string;
  hostWorkspace: string;
  hostSessionDir: string;
}

interface ObserverContext {
  version: 1;
  project: { id: string; title: string };
  focus: {
    task_id: string;
    kind: TaskKind;
    intent_id: string | null;
    intent_description: string | null;
  };
  scope: { targets: string[]; notes?: string };
  open_intents: { id: string; description: string; from: string[] }[];
  facts: { id: string; description: string }[];
  hints: { content: string; creator: string; created_at: string }[];
}

const OBSERVER_FACT_LIMIT = 30;
const OBSERVER_HINT_LIMIT = 10;
const OBSERVER_OPEN_INTENT_LIMIT = 20;

function prepareObserver(
  config: DispatchConfig,
  project: ProjectDetail,
  kind: RunnableTaskKind,
  task: WorkerTask,
  scope: ScopePolicy,
  paths: ObserverPaths,
): PreparedObserver {
  const enabled =
    config.observer.enabled && config.observer.kernelTasks.includes(kind);

  const hostBoardDir = join(paths.hostWorkspace, ".cairn", "board");
  const hostStateDir = join(paths.hostSessionDir, "observer");
  const hostProposalDir = join(hostStateDir, "proposals");
  const hostContextPath = join(paths.hostSessionDir, "observer-context.json");

  const proposalsEnabled =
    enabled &&
    config.proposals.enabled &&
    config.proposals.mode !== "off" &&
    config.proposals.maxPerTask > 0 &&
    config.proposals.allowKinds.length > 0;

  const observer: PreparedObserver = {
    enabled,
    contextPath: paths.mapPath(hostContextPath),
    boardDir: paths.mapPath(hostBoardDir),
    stateDir: paths.mapPath(hostStateDir),
    model: config.observer.model,
    everyRounds: config.observer.everyRounds,
    windowRounds: config.observer.windowRounds,
    timeoutSeconds: config.observer.timeoutSeconds,
    maxReviewsPerTask: config.observer.maxReviewsPerTask,
    proposals: proposalsEnabled
      ? {
          dir: paths.mapPath(hostProposalDir),
          projectId: project.project.id,
          taskId: task.taskId,
          allowKinds: [...config.proposals.allowKinds],
          maxPerTask: config.proposals.maxPerTask,
          maxFileBytes: config.proposals.maxFileBytes,
          maxTotalBytes: config.proposals.maxTotalBytes,
          minConfidence: config.proposals.minConfidence,
          requireEvidenceForFact: config.proposals.requireEvidenceForFact,
        }
      : null,
  };

  if (!enabled) return observer;

  // The board is project-level and must survive session cleanup; the review state is
  // task-scoped and is removed together with the session directory.
  mkdirSync(hostBoardDir, { recursive: true });
  mkdirSync(hostStateDir, { recursive: true });
  if (proposalsEnabled) mkdirSync(hostProposalDir, { recursive: true });

  // Keep the focused intent first so the cap can never hide the intent this task is
  // actually working on from its reviewer.
  const allOpenIntents = project.intents.filter((intent) => intent.to === null);
  const focusedIntent = allOpenIntents.find((intent) => intent.id === task.intentId);
  const orderedOpenIntents =
    focusedIntent === undefined
      ? allOpenIntents
      : [focusedIntent, ...allOpenIntents.filter((intent) => intent.id !== focusedIntent.id)];
  const openIntents = orderedOpenIntents.slice(0, OBSERVER_OPEN_INTENT_LIMIT).map((intent) => ({
    id: intent.id,
    description: intent.description,
    from: [...intent.from],
  }));
  const context: ObserverContext = {
    version: 1,
    project: { id: project.project.id, title: project.project.title },
    focus: {
      task_id: task.taskId,
      kind,
      intent_id: task.intentId ?? null,
      intent_description:
        project.intents.find((intent) => intent.id === task.intentId)?.description ?? null,
    },
    scope: {
      targets: [...scope.targets],
      ...(scope.notes === undefined ? {} : { notes: scope.notes }),
    },
    open_intents: openIntents,
    facts: recentFacts(project).map((fact) => ({
      id: fact.id,
      description: fact.description,
    })),
    hints: project.hints
      .slice(-OBSERVER_HINT_LIMIT)
      .map((hint) => ({
        content: hint.content,
        creator: hint.creator,
        created_at: hint.created_at,
      })),
  };
  writeFileSync(hostContextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  return observer;
}

/**
 * Keeps origin/goal regardless of the cap, then the most recently inserted facts. Facts
 * have no timestamps, so insertion order is the only recency signal the graph exposes.
 */
function recentFacts(project: ProjectDetail) {
  const mandatory = new Set(["origin", "goal"]);
  const rest = project.facts.filter((fact) => !mandatory.has(fact.id));
  const room = Math.max(0, OBSERVER_FACT_LIMIT - mandatory.size);
  const keep = new Set(rest.slice(Math.max(0, rest.length - room)).map((fact) => fact.id));
  for (const id of mandatory) keep.add(id);
  return project.facts.filter((fact) => keep.has(fact.id));
}

/** Environment contract between the scheduler and `BreachWeaveSolver`. */
export function observerEnvironment(observer: PreparedObserver): Record<string, string> {
  if (!observer.enabled) return { CAIRN_OBSERVER_ENABLED: "0" };
  const env: Record<string, string> = {
    CAIRN_OBSERVER_ENABLED: "1",
    CAIRN_OBSERVER_CONTEXT_PATH: observer.contextPath,
    CAIRN_OBSERVER_BOARD_DIR: observer.boardDir,
    CAIRN_OBSERVER_STATE_DIR: observer.stateDir,
    CAIRN_OBSERVER_EVERY_ROUNDS: String(observer.everyRounds),
    CAIRN_OBSERVER_WINDOW_ROUNDS: String(observer.windowRounds),
    CAIRN_OBSERVER_TIMEOUT_SECONDS: String(observer.timeoutSeconds),
    CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK: String(observer.maxReviewsPerTask),
  };
  if (observer.model !== null) env["CAIRN_OBSERVER_MODEL"] = observer.model;
  if (observer.proposals !== null) {
    env["CAIRN_OBSERVER_PROPOSALS_ENABLED"] = "1";
    env["CAIRN_OBSERVER_PROPOSALS_DIR"] = observer.proposals.dir;
    env["CAIRN_OBSERVER_PROJECT_ID"] = observer.proposals.projectId;
    env["CAIRN_OBSERVER_TASK_ID"] = observer.proposals.taskId;
    env["CAIRN_OBSERVER_PROPOSALS_ALLOW_KINDS"] = observer.proposals.allowKinds.join(",");
    env["CAIRN_OBSERVER_PROPOSALS_MAX_PER_TASK"] = String(observer.proposals.maxPerTask);
    env["CAIRN_OBSERVER_PROPOSALS_MAX_FILE_BYTES"] = String(observer.proposals.maxFileBytes);
    env["CAIRN_OBSERVER_PROPOSALS_MAX_TOTAL_BYTES"] = String(observer.proposals.maxTotalBytes);
    env["CAIRN_OBSERVER_PROPOSALS_MIN_CONFIDENCE"] = String(observer.proposals.minConfidence);
    env["CAIRN_OBSERVER_PROPOSALS_REQUIRE_EVIDENCE"] =
      observer.proposals.requireEvidenceForFact ? "1" : "0";
  }
  return env;
}

function hardDeadline(
  config: DispatchConfig,
  kind: RunnableTaskKind,
  concludeOf: ConcludeOf | undefined,
): number {
  switch (kind) {
    case "bootstrap":
      return config.tasks.bootstrap.timeout;
    case "reason":
      return config.tasks.reason.timeout;
    case "explore":
      return config.tasks.explore.timeout;
    case "conclude":
      return concludeOf === "bootstrap"
        ? config.tasks.bootstrap.concludeTimeout
        : config.tasks.explore.concludeTimeout;
  }
}

function capDeadline(configured: number, budgeted: number | undefined): number {
  if (budgeted === undefined) return configured;
  return Math.max(1, Math.min(configured, budgeted));
}

function requireResumeDir(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("conclude task requires the failed session directory");
  }
  return value;
}

function softDeadline(config: DispatchConfig, hard: number): number | undefined {
  const soft = Math.floor(hard * config.worker.softDeadlineRatio);
  return soft >= 1 && soft < hard ? soft : undefined;
}

interface PromptContext {
  graphSnapshotPath: string;
  openIntents: Record<string, unknown>[];
  projectBudget?: ProjectBudgetSnapshot;
}

function withArtifactPolicy(prompt: string, artifactDir: string): string {
  return `${prompt.trimEnd()}

# Artifact Policy
This project may run multiple tasks at the same time. Write every durable artifact (logs, scripts, payloads, captured output) under \`${artifactDir}/\` relative to the workspace. Do not write to the \`artifacts/\` root or another task's directory; reads elsewhere in the workspace remain allowed. Reference these files in \`evidence_refs\` as \`${artifactDir}/...\`.
`;
}

function withCompletionPolicy(prompt: string): string {
  return `${prompt.trimEnd()}

# Completion Verification
Saying "complete" is a claim, not proof. The control plane verifies the claim before it marks the project completed, and a rejected claim leaves the project active.
- Completion must cite at least one non-seed fact produced by a previous task (not \`origin\` or \`goal\`). Seed facts are premises and can never justify completion on their own; a claim whose only source is \`origin\` is rejected.
- Every fact that justifies completion must come from a recorded run and have at least one recorded file evidence entry. Put those paths in the result envelope's top-level \`evidence_refs\` array; descriptions alone are not evidence.
- A reason turn that has not produced any facts yet should propose intents instead of claiming completion. Let the explore tasks produce evidence-backed facts.
- Challenge-backed projects are checked against the external challenge service's flag counters. Never paste flag values or credentials into descriptions, evidence files, task output or logs.
- If verification fails, keep working and collect the missing evidence instead of repeating the same completion claim.
`;
}

function withReasonOutputPolicy(
  prompt: string,
  budget: ProjectBudgetSnapshot | undefined,
  maxIntents: number,
): string {
  const sections = [
    `# Strategist Output Extensions
A reason turn may return intents and hints together:
\`\`\`json
{"accepted": true, "data": {
  "intents": [{
    "from": ["f001"],
    "description": "Verify the upload endpoint rejects traversal",
    "priority": 80,
    "budget": {"max_seconds": 600, "max_tool_calls": 40},
    "dedupe_key": "upload-traversal"
  }],
  "hints": [{"content": "Authentication redirects to /login; start there."}]
}}
\`\`\`
- \`priority\` is an integer from 0 to 100; omit it for the default 50. Higher priorities are explored first.
- \`budget\` may contain positive integers \`max_seconds\` and/or \`max_tool_calls\`. It can only tighten the configured task timeout and tool ceiling.
- \`dedupe_key\` is a stable identifier of at most 128 characters for one direction. Open intents above show their keys; do not propose an intent whose key is already open or whose direction is otherwise already covered.
- \`hints\` are short strategic notes for later workers. They are not evidence and never justify completion. Do not repeat a hint already present in the graph YAML, and return at most ${maxIntents} hints.
- Never put flag values, credentials, tokens or other secrets in an intent, hint or description.
- \`complete\` cannot be combined with intents or hints.`,
  ];
  if (budget !== undefined) {
    sections.push(`# Resource Budget
Usage below counts finished runs; tasks still in flight have not reported yet.
- tokens: ${budget.usedTokens}${budget.maxTokens > 0 ? ` / ${budget.maxTokens} limit (${percent(budget.usedTokens, budget.maxTokens)})` : " used; no token limit configured"}
- cost_usd: ${budget.usedCostUsd}${budget.maxCostUsd > 0 ? ` / ${budget.maxCostUsd} limit (${percent(budget.usedCostUsd, budget.maxCostUsd)})` : " used; no cost limit configured"}
When a limit is close, spend the remaining budget on the highest-value directions and set tighter intent budgets where appropriate.`);
  }
  return `${prompt.trimEnd()}

${sections.join("\n\n")}
`;
}

function percent(used: number, limit: number): string {
  if (limit <= 0) return "0.0%";
  return `${((used / limit) * 100).toFixed(1)}%`;
}

function renderTaskPrompt(
  config: DispatchConfig,
  project: ProjectDetail,
  kind: RunnableTaskKind,
  intent: Intent | undefined,
  context: PromptContext,
  concludeOf?: ConcludeOf,
): string {
  const group = config.runtime.promptGroup;
  const location = config.runtime.execution === "local" ? "sandbox" : "container";
  const graphYaml = graphSnapshotReference(context.graphSnapshotPath, location);

  switch (kind) {
    case "reason": {
      const factIds = project.facts
        .map((fact) => fact.id)
        .filter((id) => id !== "goal");
      const prompt = renderPrompt(loadPrompt(group, "reason.md"), {
        graph_yaml: graphYaml,
        fact_ids: formatFactIds(factIds),
        open_intents: formatOpenIntents(context.openIntents),
        max_intents: String(config.tasks.reason.maxIntents),
      });
      return withReasonOutputPolicy(
        prompt,
        context.projectBudget,
        config.tasks.reason.maxIntents,
      );
    }
    case "explore": {
      if (intent === undefined) {
        throw new Error("explore task requires an intent");
      }
      return renderPrompt(loadPrompt(group, "explore.md"), {
        graph_yaml: graphYaml,
        intent_id: intent.id,
        intent_description: intent.description,
      });
    }
    case "bootstrap": {
      const { origin, goal } = bootstrapContext(project);
      return renderPrompt(loadPrompt(group, "bootstrap.md"), {
        origin,
        goal,
        hints: formatHints(
          project.hints.map((hint) => ({
            id: hint.id,
            content: hint.content,
            creator: hint.creator,
            created_at: hint.created_at,
          })),
        ),
      });
    }
    case "conclude": {
      // Mirrors Cairn's fallback: an explore conclude still sees the graph and the
      // intent, a bootstrap conclude summarizes Origin/Goal/Hints without a graph.
      if (concludeOf === "bootstrap") {
        const { origin, goal } = bootstrapContext(project);
        return renderPrompt(loadPrompt(group, "bootstrap_conclude.md"), {
          origin,
          goal,
          hints: formatHints(
            project.hints.map((hint) => ({
              id: hint.id,
              content: hint.content,
              creator: hint.creator,
              created_at: hint.created_at,
            })),
          ),
        });
      }
      if (intent === undefined) {
        throw new Error("conclude task requires an intent");
      }
      return renderPrompt(loadPrompt(group, "explore_conclude.md"), {
        graph_yaml: graphYaml,
        intent_id: intent.id,
        intent_description: intent.description,
      });
    }
  }
}

function bootstrapContext(project: ProjectDetail): { origin: string; goal: string } {
  return {
    origin: project.facts.find((fact) => fact.id === "origin")?.description ?? "",
    goal: project.facts.find((fact) => fact.id === "goal")?.description ?? "",
  };
}
