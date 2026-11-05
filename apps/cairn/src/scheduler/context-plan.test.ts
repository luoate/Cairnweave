import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  auditTaskContext, buildContextPlan, contextPlanLog,
  type ContextPlan, type ContextPlanInput,
} from "./context-plan";

function input(extra: Partial<ContextPlanInput> = {}): ContextPlanInput {
  return {
    task: { taskId: "reason-test", kind: "reason", prompt: "任务\n🧭" },
    maxInitialBytes: 131072, graph: Buffer.from("facts: [起点, 目标]\n"),
    graphRequired: true, strategyContext: "on",
    graphAudit: { sliced: false, legacy_truncated: false, mandatory_over_cap: false,
      selections: [{ section: "facts", scope: "project", candidates: 9, selected: 9, limits: {}, policy: "all" }] },
    ...extra,
  };
}
const find = (plan: ContextPlan, id: string) => plan.sources.find((source) => source.id === id)!;

function auditInput() {
  return {
    config: { mode: "audit" as const, maxInitialBytes: 131072 },
    task: input().task, hostSessionDir: "/private/host/session",
    graphRequired: true, graphAudit: input().graphAudit!,
    agentContextEnabled: false, strategyContext: "off" as const, observerEnabled: false,
  };
}

describe("M47 ContextPlan accounting", () => {
  test("counts actual UTF-8 bytes and hashes payloads without persisting bodies", () => {
    const value = input();
    const plan = buildContextPlan(value);
    expect(find(plan, "prompt").bytes).toBe(Buffer.byteLength(value.task.prompt, "utf8"));
    expect(find(plan, "graph").bytes).toBe(value.graph.byteLength);
    expect(find(plan, "graph").sha256).toBe(createHash("sha256").update(value.graph).digest("hex"));
    expect(plan.totals.solver.required_initial_bytes).toBe(Buffer.byteLength(value.task.prompt) + value.graph.byteLength);
    expect(JSON.stringify(plan)).not.toContain("🧭");
    expect(JSON.stringify(plan)).not.toContain("facts: [起点");
    expect(plan.scope).toBe("dispatch_inputs_only");
    expect(plan.unmeasured).toContain("sdk_session_occupancy");
  });

  test("budget is inclusive at the boundary and never enforced", () => {
    const initial = buildContextPlan(input()).totals.solver.required_initial_bytes;
    expect(buildContextPlan(input({ maxInitialBytes: initial })).budget.status).toBe("within_budget");
    const over = buildContextPlan(input({ maxInitialBytes: initial - 1 }));
    expect(over.budget.status).toBe("over_budget");
    expect(over.budget.enforced).toBe(false);
    expect(over.warnings).toContain("solver_initial_bytes_over_budget");
  });

  test("does not mistake optional graph and attachment sizes for required inputs", () => {
    const plan = buildContextPlan(input({ graphRequired: false, attachments: [{ size: 32 * 1024 * 1024 }] }));
    expect(plan.totals.solver.required_initial_bytes).toBe(Buffer.byteLength(input().task.prompt));
    expect(plan.totals.solver.optional_known_bytes).toBe(input().graph.byteLength + 32 * 1024 * 1024);
    expect(find(plan, "attachments")).toMatchObject({ measurement: "declared_bytes", sha256: null, item_count: 1 });
    expect(plan.budget.status).toBe("within_budget");
  });

  test("accounts for independent consumers instead of adding Observer to solver", () => {
    const plain = buildContextPlan(input());
    const plan = buildContextPlan(input({ observerContext: Buffer.from("{\"facts\":[\"审阅\"]}"), observerSelections: [] }));
    expect(plan.totals.solver).toEqual(plain.totals.solver);
    expect(plan.totals.observer.required_initial_bytes).toBe(Buffer.byteLength("{\"facts\":[\"审阅\"]}"));
    expect(plan.totals.observer.unknown_sources).toEqual(["observer_board"]);
    expect(find(plan, "observer_board").bytes).toBeNull();
    expect(plan.unmeasured).toContain("observer_review_prompt_and_activity_window");
  });

  test("counts repeated required files as delivered input, not unique physical bytes", () => {
    const value = input();
    const plan = buildContextPlan({ ...value, agentContext: value.graph, agentContextAudit: { selections: [], details: { max_chars: 500, examined_fields: 0, clipped_fields: 0 } } });
    expect(plan.totals.solver.required_file_bytes).toBe(2 * value.graph.byteLength);
    expect(find(plan, "graph").sha256).toBe(find(plan, "investigation_state").sha256);
  });

  test("does not pretend missing selector metadata is complete", () => {
    const { graphAudit: _ignored, ...value } = input();
    const plan = buildContextPlan({ ...value, agentContext: Buffer.from("version: 1\n") });
    expect(plan.status).toBe("incomplete");
    expect(plan.warnings).toContain("graph_selection_metadata_unavailable");
    expect(plan.warnings).toContain("investigation_selection_metadata_unavailable");
    expect(find(plan, "graph").coverage).toBe("unknown");
    expect(find(plan, "investigation_state").selections).toEqual([]);
  });

  test("records disabled projections without secretly enabling or sizing them", () => {
    const plan = buildContextPlan(input({ strategyContext: "off" }));
    expect(find(plan, "investigation_state")).toMatchObject({ coverage: "disabled", bytes: null, disabled_reason: "strategy_context_off" });
    expect(plan.totals.solver.unknown_sources).not.toContain("investigation_state");
    expect(find(plan, "observer_context").disabled_reason).toBe("observer_off");
  });

  test("distinguishes bootstrap exclusions from an unexpectedly absent projection", () => {
    expect(find(buildContextPlan(input({ task: { ...input().task, kind: "bootstrap" } })), "investigation_state").disabled_reason).toBe("not_applicable");
    expect(find(buildContextPlan(input()), "investigation_state").disabled_reason).toBe("not_provided");
  });

  test("restoring a session does not report its unknown history as zero", () => {
    const plan = buildContextPlan(input({ task: { ...input().task, kind: "conclude", concludeOf: "explore", resumeSessionDir: "C:\\host-secret\\previous" } }));
    expect(find(plan, "resumed_history")).toMatchObject({ bytes: null, estimated_tokens: null, path: null, read_requirement: "preexisting" });
    expect(plan.totals.solver.unknown_sources).toContain("resumed_history");
    expect(plan.warnings).toContain("resumed_history_unmeasured");
    expect(JSON.stringify(plan)).not.toContain("host-secret");
  });

  test("does not convert characters to made-up tokens", () => {
    const plan = buildContextPlan(input());
    expect(plan.totals.solver.estimated_initial_tokens).toBeNull();
    expect(plan.sources.every((source) => source.estimated_tokens === null && source.estimator === null)).toBe(true);
  });

  test("accepts an explicit model-matched local estimator and labels the estimate", () => {
    const plan = buildContextPlan(input({ task: { ...input().task, model: "test-model" },
      tokenEstimator: { id: "test-adapter-v1", model: "test-model", estimate: () => 7 } }));
    expect(plan.totals.solver.estimated_initial_tokens).toBe(14);
    expect(plan.totals.solver.estimator).toBe("test-adapter-v1");
    expect(find(plan, "attachments").estimated_tokens).toBeNull();
  });

  test("rejects model mismatches and invalid/throwing estimators without inventing counts", () => {
    for (const estimate of [() => -1, () => Infinity, () => 1.2, () => { throw new Error("private"); }]) {
      const plan = buildContextPlan(input({ task: { ...input().task, model: "test-model" },
        tokenEstimator: { id: "test", model: "test-model", estimate } }));
      expect(plan.totals.solver.estimated_initial_tokens).toBeNull();
      expect(plan.warnings).toContain("token_estimator_unavailable");
      expect(JSON.stringify(plan)).not.toContain("private");
    }
    const mismatch = buildContextPlan(input({ tokenEstimator: { id: "wrong", model: "other", estimate: () => 99 } }));
    expect(mismatch.totals.solver.estimated_initial_tokens).toBeNull();
    expect(mismatch.warnings).toContain("token_estimator_model_mismatch");
  });

  test("the same input yields the same metadata without mutating selector reports", () => {
    const value = input();
    const before = JSON.stringify(value.graphAudit);
    const first = buildContextPlan(value);
    find(first, "graph").selections[0]!.limits["mutated"] = 99;
    expect(JSON.stringify(value.graphAudit)).toBe(before);
    expect(buildContextPlan(value)).toEqual(buildContextPlan(value));
  });
});

describe("M47 omission recovery", () => {
  const stateAudit: NonNullable<ContextPlanInput["agentContextAudit"]> = {
    selections: [
      { section: "facts", scope: "project" as const, candidates: 9, selected: 2, limits: { maxFacts: 2 }, policy: "current_ids_then_recently_superseded" },
      { section: "recent_attempts", scope: "project" as const, candidates: 68, selected: 20, limits: { maxAttempts: 20 }, policy: "newest_finished_runs" },
    ],
    details: { max_chars: 500, examined_fields: 20, clipped_fields: 3 },
  };
  test("full graph restores descriptions but never sidecar state or run history", () => {
    const plan = buildContextPlan(input({ agentContext: Buffer.from("facts: []"), agentContextAudit: stateAudit }));
    const state = find(plan, "investigation_state");
    expect(state.coverage).toBe("partial");
    expect(state.selections[0]).toMatchObject({ candidates: 9, selected: 2, omitted: 7, limits: { maxFacts: 2 } });
    expect(state.selections[0]!.recovery).toEqual([
      { status: "snapshot_file", source_id: "graph", includes: "graph_content" },
      { status: "control_plane_only", source_id: null, includes: "state_and_history" },
    ]);
    expect(state.selections[1]!.recovery).toEqual([{ status: "control_plane_only", source_id: null, includes: "state_and_history" }]);
    expect(state.detail_clipping?.recovery[0]?.status).toBe("control_plane_only");
    expect(state.truncated_sections).toContain("detail_fields");
    state.selections[1]!.recovery[0]!.status = "unavailable";
    state.detail_clipping!.recovery[0]!.status = "unavailable";
    const next = find(buildContextPlan(input({ agentContext: Buffer.from("facts: []"), agentContextAudit: stateAudit })), "investigation_state");
    expect(next.selections[1]!.recovery[0]!.status).toBe("control_plane_only");
    expect(next.detail_clipping!.recovery[0]!.status).toBe("control_plane_only");
  });

  test("a partial graph is not advertised as a full recovery path", () => {
    const plan = buildContextPlan(input({ agentContext: Buffer.from("facts: []"), agentContextAudit: stateAudit,
      graphAudit: { sliced: true, legacy_truncated: false, mandatory_over_cap: false,
        selections: [{ section: "facts", scope: "project", candidates: 9, selected: 3, limits: { maxFacts: 4 }, policy: "bounded_provenance" }] } }));
    expect(find(plan, "graph").coverage).toBe("partial");
    expect(find(plan, "graph").graph_slice?.legacy_truncated).toBe(false);
    expect(find(plan, "investigation_state").selections[0]!.recovery.every((item) => item.status !== "snapshot_file")).toBe(true);
  });

  test("Observer has no raw graph read tool, even when solver has a full graph", () => {
    const plan = buildContextPlan(input({ observerContext: Buffer.from("{}"), observerSelections: stateAudit.selections }));
    expect(find(plan, "observer_context").selections[0]!.recovery[0]!.status).toBe("control_plane_only");
  });
});

describe("M47 audit persistence and safe logging", () => {
  test("off performs no diagnostic reads/writes", () => {
    const outcome = auditTaskContext({ ...auditInput(), config: { mode: "off", maxInitialBytes: 1 } }, {
      read: () => { throw new Error("must not read"); }, write: () => { throw new Error("must not write"); },
    });
    expect(outcome).toEqual({ status: "off" });
    expect(contextPlanLog(outcome)).toBeNull();
  });

  test("measures final serialized files and writes metadata only", () => {
    const reads: string[] = [];
    let output = "";
    const raw = Buffer.from("  graph: 中文\n\n");
    const outcome = auditTaskContext(auditInput(), {
      read: (path) => { reads.push(path); return raw; },
      write: (_path, value) => { output = value; },
    });
    expect(outcome.status).toBe("written");
    expect(reads).toHaveLength(1);
    expect(JSON.parse(output).sources.find((source: { id: string }) => source.id === "graph").bytes).toBe(raw.byteLength);
    expect(output).not.toContain("/private/host");
    expect(output).not.toContain("graph: 中文");
  });

  test("read and write errors cannot become dispatch errors or leak raw messages", () => {
    const unavailable = auditTaskContext(auditInput(), {
      read: () => { throw new Error("secret-token /absolute/path"); }, write: () => {},
    });
    expect(unavailable).toEqual({ status: "unavailable" });
    expect(contextPlanLog(unavailable)).toBe("context-plan unavailable; dispatch continues without audit");
    const failedWrite = auditTaskContext(auditInput(), {
      read: () => Buffer.from("graph"), write: () => { throw new Error("secret-token"); },
    });
    expect(failedWrite.status).toBe("unavailable");
  });

  test("over-budget logs use fixed source IDs and numeric metadata only", () => {
    const plan = buildContextPlan(input({ task: { ...input().task, prompt: "secret-token /private/host" }, maxInitialBytes: 1 }));
    const log = contextPlanLog({ status: "written", plan })!;
    expect(log).toContain("over_budget");
    expect(log).toContain("prompt:");
    expect(log).toContain("dispatch continues");
    expect(log).not.toContain("secret-token");
    expect(log).not.toContain("/private/host");
  });
});
