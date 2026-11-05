/**
 * M47: dispatch-time input accounting, not SDK context occupancy or a compression policy.
 * Only metadata is persisted. No model calls, DB reads, input trimming or dispatch gates.
 */
import type { TaskKind, WorkerTask } from "@cairn/contracts";
import type { AgentContextAudit, ContextSelection, GraphExportAudit } from "@cairn/graph";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextPlanConfig, StrategyContextMode } from "../config";
import type { ContextPackReport } from "./context-pack";

export interface RecoveryReference {
  status: "snapshot_file" | "control_plane_only" | "unavailable";
  source_id: string | null;
  /** A graph does not restore sidecar status, evidence metadata or run history. */
  includes: "graph_content" | "state_and_history";
}

export interface SelectionCoverage extends ContextSelection {
  omitted: number;
  recovery: RecoveryReference[];
}

export interface ContextSource {
  id: "prompt" | "graph" | "investigation_state" | "attachments" |
    "observer_context" | "observer_board" | "resumed_history" | "context_pack" | "context_store";
  consumer: "solver" | "observer";
  delivery: "inline" | "file" | "inventory" | "history";
  read_requirement: "required" | "optional" | "preexisting" | "disabled";
  /** Fixed task-relative names only; never control-plane absolute paths. */
  path: string | null;
  bytes: number | null;
  measurement: "utf8" | "file_bytes" | "declared_bytes" | "unknown";
  sha256: string | null;
  coverage: "full" | "task_scoped" | "partial" | "unknown" | "disabled";
  selections: SelectionCoverage[];
  truncated_sections: string[];
  detail_clipping: (AgentContextAudit["details"] & { recovery: RecoveryReference[] }) | null;
  estimated_tokens: number | null;
  estimator: string | null;
  item_count?: number;
  disabled_reason?: "strategy_context_off" | "not_applicable" | "not_provided" | "observer_off";
  graph_slice?: { legacy_truncated: boolean; mandatory_over_cap: boolean };
}

export interface ContextPlan {
  version: 1 | 2;
  /** Present only for applied M48 input; v1 dispatches retain their original shape. */
  selection?: ContextPackReport;
  task_id: string;
  kind: TaskKind;
  mode: "audit";
  status: "complete" | "incomplete";
  scope: "dispatch_inputs_only";
  /** Excluded on purpose: this is not a measurement of the whole SDK request/session. */
  unmeasured: string[];
  sources: ContextSource[];
  totals: Record<"solver" | "observer", {
    prompt_bytes: number;
    required_file_bytes: number;
    required_initial_bytes: number;
    optional_known_bytes: number;
    unknown_sources: string[];
    estimated_initial_tokens: number | null;
    estimator: string | null;
  }>;
  budget: {
    metric: "solver_required_initial_bytes";
    max_initial_bytes: number;
    status: "within_budget" | "over_budget";
    enforced: false;
  };
  warnings: string[];
}

/** An explicitly model-matched, local adapter; absent by default (no guessed tokenizer). */
export interface ContextTokenEstimator {
  id: string;
  model: string;
  estimate: (text: string) => number;
}

export interface ContextPlanInput {
  task: Pick<WorkerTask, "taskId" | "kind" | "prompt" | "concludeOf" | "resumeSessionDir" | "model">;
  maxInitialBytes: number;
  graph: Uint8Array;
  graphRequired: boolean;
  graphAudit?: GraphExportAudit;
  agentContext?: Uint8Array;
  agentContextAudit?: AgentContextAudit;
  strategyContext: StrategyContextMode;
  observerContext?: Uint8Array;
  observerSelections?: readonly ContextSelection[];
  attachments?: readonly { size: number }[];
  tokenEstimator?: ContextTokenEstimator;
  pack?: { content: Uint8Array; report: ContextPackReport; storeBytes: number };
}

const CONTROL_PLANE: RecoveryReference = {
  status: "control_plane_only", source_id: null, includes: "state_and_history",
};

/** Pure metadata transformation, useful for deterministic evaluations. */
export function buildContextPlan(input: ContextPlanInput): ContextPlan {
  const warnings: string[] = [];
  const payloads = new Map<string, Uint8Array>();
  const source = (
    id: ContextSource["id"], consumer: ContextSource["consumer"],
    delivery: ContextSource["delivery"], requirement: ContextSource["read_requirement"],
    content: Uint8Array | undefined, path: string | null,
    coverage: ContextSource["coverage"],
  ): ContextSource => {
    if (content !== undefined) payloads.set(id, content);
    return {
      id, consumer, delivery, read_requirement: requirement, path,
      bytes: content?.byteLength ?? null,
      measurement: content === undefined ? "unknown" : delivery === "inline" ? "utf8" : "file_bytes",
      sha256: content === undefined ? null : createHash("sha256").update(content).digest("hex"),
      coverage, selections: [], truncated_sections: [], detail_clipping: null,
      estimated_tokens: null, estimator: null,
    };
  };
  const selection = (item: ContextSelection, recovery: RecoveryReference[]): SelectionCoverage => ({
    ...item, limits: { ...item.limits }, omitted: item.candidates - item.selected,
    recovery: item.candidates > item.selected ? recovery.map((reference) => ({ ...reference })) : [],
  });
  const prompt = source("prompt", "solver", "inline", "required",
    Buffer.from(input.task.prompt, "utf8"), null, "full");
  const graph = source("graph", "solver", "file", input.graphRequired ? "required" : "optional",
    input.graph, "graph.yaml", input.graphAudit === undefined ? "unknown" : "full");
  if (input.graphAudit !== undefined) {
    graph.selections = input.graphAudit.selections.map((item) =>
      selection(item, [{ ...CONTROL_PLANE, includes: "graph_content" }]));
    graph.coverage = graph.selections.some((item) => item.omitted > 0) ? "partial" : "full";
    graph.graph_slice = {
      legacy_truncated: input.graphAudit.legacy_truncated,
      mandatory_over_cap: input.graphAudit.mandatory_over_cap,
    };
    graph.truncated_sections = graph.selections.filter((item) => item.omitted > 0).map((item) => item.section);
  } else {
    warnings.push("graph_selection_metadata_unavailable");
  }

  const investigation = source("investigation_state", "solver", "file",
    input.agentContext === undefined ? "disabled" : input.pack === undefined ? "required" : "optional",
    input.agentContext, input.agentContext === undefined ? null : "agent-context.yaml",
    input.agentContext === undefined ? "disabled" : "unknown");
  if (input.agentContext === undefined) {
    investigation.disabled_reason = input.strategyContext === "off" ? "strategy_context_off" :
      input.task.kind === "bootstrap" || input.task.concludeOf === "bootstrap" ? "not_applicable" : "not_provided";
  } else if (input.agentContextAudit !== undefined) {
    investigation.selections = input.agentContextAudit.selections.map((item) => {
      // Full graph content can restore descriptions/edges, but never sidecar state.
      const contentRecoverable = (item.section === "facts" || item.section.startsWith("intents")) &&
        graph.selections.some((entry) => entry.section === (item.section.startsWith("intents") ? "intents" : "facts") && entry.omitted === 0);
      return selection(item, contentRecoverable ? [
        { status: "snapshot_file", source_id: "graph", includes: "graph_content" }, CONTROL_PLANE,
      ] : [CONTROL_PLANE]);
    });
    investigation.detail_clipping = {
      ...input.agentContextAudit.details,
      recovery: input.agentContextAudit.details.clipped_fields > 0 ? [{ ...CONTROL_PLANE }] : [],
    };
    investigation.truncated_sections = investigation.selections.filter((item) => item.omitted > 0).map((item) => item.section);
    if (investigation.detail_clipping.clipped_fields > 0) investigation.truncated_sections.push("detail_fields");
    investigation.coverage = investigation.truncated_sections.length > 0 ? "partial" : "task_scoped";
  } else {
    warnings.push("investigation_selection_metadata_unavailable");
  }

  const attachments = source("attachments", "solver", "inventory", "optional", undefined, null, "unknown");
  attachments.bytes = (input.attachments ?? []).reduce((sum, item) => sum + item.size, 0);
  attachments.measurement = "declared_bytes";
  attachments.item_count = input.attachments?.length ?? 0;

  const observer = source("observer_context", "observer", "file",
    input.observerContext === undefined ? "disabled" : "required", input.observerContext,
    input.observerContext === undefined ? null : "observer-context.json",
    input.observerContext === undefined ? "disabled" : "task_scoped");
  if (input.observerContext === undefined) {
    observer.disabled_reason = "observer_off";
  } else if (input.observerSelections !== undefined) {
    // Graph files are not registered as read tools for this consumer.
    observer.selections = input.observerSelections.map((item) => selection(item, [CONTROL_PLANE]));
    observer.truncated_sections = observer.selections.filter((item) => item.omitted > 0).map((item) => item.section);
    if (observer.truncated_sections.length > 0) observer.coverage = "partial";
  } else {
    observer.coverage = "unknown";
    warnings.push("observer_selection_metadata_unavailable");
  }
  const sources = [prompt, graph, investigation, attachments, observer];
  if (input.pack !== undefined) {
    const recovery: RecoveryReference = { status: "snapshot_file", source_id: "context_store", includes: "state_and_history" };
    const pack = source("context_pack", "solver", "file", "required", input.pack.content,
      "context-pack.yaml", "task_scoped");
    pack.selections = input.pack.report.selections.map((item) => selection(item, [recovery]));
    pack.truncated_sections = pack.selections.filter((item) => item.omitted > 0).map((item) => item.section);
    if (pack.truncated_sections.length > 0) pack.coverage = "partial";
    const store = source("context_store", "solver", "inventory", "optional", undefined,
      "context-store", "task_scoped");
    store.bytes = input.pack.storeBytes;
    store.measurement = "file_bytes";
    store.selections = input.pack.report.selections.map((item) => selection({ ...item,
      selected: item.candidates, policy: "complete_authorized_dispatch_projection" }, []));
    // Recovery restores the authorized projection, not arbitrary raw DB/log columns.
    for (const item of investigation.selections) {
      if (item.omitted > 0) item.recovery = [{ ...recovery }];
    }
    for (const item of graph.selections) {
      if (item.omitted > 0) item.recovery = [{ ...recovery, includes: "graph_content" }];
    }
    sources.push(pack, store);
  }
  if (input.observerContext !== undefined) {
    sources.push(source("observer_board", "observer", "history", "optional", undefined, null, "unknown"));
  }
  if (input.task.resumeSessionDir !== undefined) {
    sources.push(source("resumed_history", "solver", "history", "preexisting", undefined, null, "unknown"));
    warnings.push("resumed_history_unmeasured");
  }

  const adapter = input.tokenEstimator;
  if (adapter !== undefined && input.task.model === adapter.model) {
    try {
      for (const item of sources) {
        const content = payloads.get(item.id);
        if (content === undefined) continue;
        const tokens = adapter.estimate(Buffer.from(content).toString("utf8"));
        if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("invalid estimate");
        item.estimated_tokens = tokens;
        item.estimator = adapter.id;
      }
    } catch {
      for (const item of sources) { item.estimated_tokens = null; item.estimator = null; }
      warnings.push("token_estimator_unavailable");
    }
  } else if (adapter !== undefined) {
    warnings.push("token_estimator_model_mismatch");
  }

  const total = (consumer: ContextSource["consumer"]): ContextPlan["totals"]["solver"] => {
    const own = sources.filter((item) => item.consumer === consumer && item.read_requirement !== "disabled");
    const required = own.filter((item) => item.read_requirement === "required");
    const promptBytes = required.filter((item) => item.delivery === "inline").reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    const fileBytes = required.filter((item) => item.delivery === "file").reduce((sum, item) => sum + (item.bytes ?? 0), 0);
    const estimated = required.length > 0 && required.every((item) => item.estimated_tokens !== null);
    return {
      prompt_bytes: promptBytes, required_file_bytes: fileBytes,
      required_initial_bytes: promptBytes + fileBytes,
      optional_known_bytes: own.filter((item) => item.read_requirement === "optional").reduce((sum, item) => sum + (item.bytes ?? 0), 0),
      unknown_sources: own.filter((item) => item.bytes === null).map((item) => item.id),
      estimated_initial_tokens: estimated ? required.reduce((sum, item) => sum + item.estimated_tokens!, 0) : null,
      estimator: estimated ? adapter!.id : null,
    };
  };
  const totals = { solver: total("solver"), observer: total("observer") };
  const overBudget = totals.solver.required_initial_bytes > input.maxInitialBytes;
  if (overBudget) warnings.push("solver_initial_bytes_over_budget");
  return {
    version: input.pack === undefined ? 1 : 2,
    ...(input.pack === undefined ? {} : { selection: structuredClone(input.pack.report) }),
    task_id: input.task.taskId, kind: input.task.kind, mode: "audit",
    status: warnings.some((warning) => warning.endsWith("metadata_unavailable")) ? "incomplete" : "complete",
    scope: "dispatch_inputs_only",
    unmeasured: ["sdk_system_prompt_and_tool_schemas", "solver_scope_and_evidence_preamble", "future_tool_results", "sdk_session_occupancy",
      ...(input.observerContext === undefined ? [] : ["observer_review_prompt_and_activity_window"])],
    sources, totals,
    budget: { metric: "solver_required_initial_bytes", max_initial_bytes: input.maxInitialBytes,
      status: overBudget ? "over_budget" : "within_budget", enforced: false },
    warnings,
  };
}

export type ContextPlanOutcome =
  | { status: "off" }
  | { status: "unavailable" }
  | { status: "written"; plan: ContextPlan };

export interface TaskContextAuditInput {
  config: ContextPlanConfig;
  hostSessionDir: string;
  task: ContextPlanInput["task"];
  graphRequired: boolean;
  graphAudit?: GraphExportAudit;
  agentContextEnabled: boolean;
  agentContextAudit?: AgentContextAudit;
  strategyContext: StrategyContextMode;
  observerEnabled: boolean;
  observerSelections?: readonly ContextSelection[];
  attachments?: readonly { size: number }[];
  pack?: { report: ContextPackReport; storeBytes: number };
}

/** Read final serialized files, not a fresh DB snapshot. Audit failure never gates a task. */
export function auditTaskContext(
  input: TaskContextAuditInput,
  io = { read: (path: string): Uint8Array => readFileSync(path), write: (path: string, data: string) => writeFileSync(path, data, "utf8") },
): ContextPlanOutcome {
  if (input.config.mode === "off") return { status: "off" };
  try {
    const plan = buildContextPlan({
      task: input.task, maxInitialBytes: input.config.maxInitialBytes,
      graph: io.read(join(input.hostSessionDir, "graph.yaml")), graphRequired: input.graphRequired,
      ...(input.graphAudit === undefined ? {} : { graphAudit: input.graphAudit }),
      ...(input.agentContextEnabled ? { agentContext: io.read(join(input.hostSessionDir, "agent-context.yaml")) } : {}),
      ...(input.agentContextAudit === undefined ? {} : { agentContextAudit: input.agentContextAudit }),
      strategyContext: input.strategyContext,
      ...(input.observerEnabled ? { observerContext: io.read(join(input.hostSessionDir, "observer-context.json")) } : {}),
      ...(input.observerSelections === undefined ? {} : { observerSelections: input.observerSelections }),
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.pack === undefined ? {} : { pack: { ...input.pack,
        content: io.read(join(input.hostSessionDir, "context-pack.yaml")),
      } }),
    });
    io.write(join(input.hostSessionDir, "context-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    return { status: "written", plan };
  } catch {
    // Errors may contain absolute paths or secret-shaped input. Log only this fixed status.
    return { status: "unavailable" };
  }
}

/** Fixed metadata only: never include user content, source paths or raw exception messages. */
export function contextPlanLog(outcome: ContextPlanOutcome): string | null {
  if (outcome.status === "off") return null;
  if (outcome.status === "unavailable") return "context-plan unavailable; dispatch continues without audit";
  const { plan } = outcome;
  const sources = plan.sources.filter((source) => source.consumer === "solver" && source.read_requirement === "required")
    .map((source) => `${source.id}:${source.bytes}`).join(",");
  return `context-plan ${plan.budget.status} status=${plan.status} required_initial_bytes=${plan.totals.solver.required_initial_bytes}` +
    ` max_initial_bytes=${plan.budget.max_initial_bytes} sources=${sources}` +
    ` warnings=${plan.warnings.join(",") || "none"}; audit only, dispatch continues`;
}
