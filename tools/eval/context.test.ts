import { describe, expect, test } from "bun:test";
import { CONTEXT_SCENARIOS, runContextEvaluation } from "./context";

describe("M47 deterministic context evaluation", () => {
  test("covers eight real preparation scenarios without worker/model calls or input changes", () => {
    const report = runContextEvaluation();
    expect(report.model_calls).toBe(0);
    expect(report.compression_applied).toBe(false);
    expect(report.scenarios.map((scenario) => scenario.id)).toEqual(CONTEXT_SCENARIOS.map((scenario) => scenario.id));
    const byId = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
    for (const scenario of report.scenarios) {
      expect(scenario.status).toBe("complete");
      expect(scenario.compatibility).toEqual({ worker_inputs_unchanged: true, snapshot_bytes_unchanged: true });
      expect(scenario.totals.solver.required_initial_bytes).toBeGreaterThan(0);
      expect(scenario.totals.solver.estimated_initial_tokens).toBeNull();
      const required = scenario.sources.filter((source) => source.consumer === "solver" && source.read_requirement === "required");
      expect(required.reduce((sum, source) => sum + source.bytes!, 0)).toBe(scenario.totals.solver.required_initial_bytes);
      for (const source of scenario.sources) {
        for (const selection of source.selections) expect(selection.omitted).toBe(selection.candidates - selection.selected);
      }
    }
    expect(byId.get("small")!.budget.status).toBe("within_budget");
    expect(byId.get("long_description")!.budget.status).toBe("over_budget");
    expect(byId.get("many_hints")!.budget.status).toBe("over_budget");
    const truncated = byId.get("agent_context_truncated")!.sources.find((source) => source.id === "investigation_state")!;
    expect(truncated.truncated_sections).toContain("facts");
    expect(truncated.truncated_sections).toContain("intents");
    expect(truncated.truncated_sections).toContain("recent_attempts");
    expect(truncated.detail_clipping!.clipped_fields).toBeGreaterThan(0);
    const sliced = byId.get("graph_slice")!.sources.find((source) => source.id === "graph")!;
    expect(sliced.coverage).toBe("partial");
    expect(sliced.graph_slice!.legacy_truncated).toBe(true);
    expect(byId.get("conclude_resume")!.totals.solver.unknown_sources).toContain("resumed_history");
    expect(JSON.stringify(report)).not.toContain("长描述长描述");
  }, 30000);

  test("metrics are stable for repeated runs in the same environment", () => {
    expect(runContextEvaluation()).toEqual(runContextEvaluation());
  }, 30000);
});
