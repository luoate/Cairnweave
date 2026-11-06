import { describe, expect, test } from "bun:test";
import { ATTEMPT_RESULTS } from "../../contracts/src/checkpoint";
import { checkpoint } from "../../contracts/src/testdata/checkpoint";
import { projectExperimentResult } from "./experiments";
import type { RunFailure } from "./failures";
function input() {
  return { checkpoint: checkpoint({ attempts: [
    { id: "observation", action: "请求", observation: "状态403", interpretation: "", result: "negative_observation", fact_refs: [], evidence_refs: ["artifacts/test.log"] },
    { id: "interpretation", action: "尚未执行", observation: " \n", interpretation: "可能需要认证", result: "inconclusive", fact_refs: [], evidence_refs: [] },
  ] }), outcome: "success", terminationReason: "finished", evidence: [{ ref: "artifacts/test.log", status: "available" as const }] };
}
describe("M51b checkpoint result index", () => {
  test("keeps observations and interpretations separate without copying their prose", () => {
    const value = input(); const result = projectExperimentResult(value);
    expect(result).toEqual({ source: "memory.checkpoint.attempts", trust: "worker_claim_not_verified", status: "observations_reported",
      observations: [{ attempt_id: "observation", reported_result: "negative_observation", evidence: "refs_available_not_verified" }],
      interpretations: [{ attempt_id: "interpretation", trust: "worker_claim_not_verified" }], unresolved_count: 1, hypothesis_verdict: "unknown" });
    expect(JSON.stringify(result)).not.toContain("状态403"); expect(JSON.stringify(result)).not.toContain("可能需要认证");
    for (const index of [...result.observations, ...result.interpretations]) expect(value.checkpoint.attempts.some(a => a.id === index.attempt_id)).toBe(true);
    expect(projectExperimentResult(value)).toEqual(result);
  });
  test("empty observations and interpretations alone stay unknown even when the worker reports observed", () => {
    const value = input(); value.checkpoint.attempts = [value.checkpoint.attempts[1]!]; value.checkpoint.attempts[0]!.result = "observed";
    expect(projectExperimentResult(value)).toMatchObject({ status: "unknown", observations: [], hypothesis_verdict: "unknown" });
  });
  test("every worker result remains a claim, and only actual reported observations set the report status", () => {
    for (const reported of ATTEMPT_RESULTS) {
      const value = input(); value.checkpoint.attempts[0]!.result = reported;
      const result = projectExperimentResult(value);
      expect(result.hypothesis_verdict).toBe("unknown");
      expect(result.status).toBe(["observed", "negative_observation"].includes(reported) ? "observations_reported" : "unknown");
    }
  });
  test("control-plane infrastructure and execution failures override worker success without erasing observations", () => {
    for (const failure of [{ domain: "infrastructure", code: "model_connection_error" }, { domain: "execution", code: "hard_deadline" }] satisfies RunFailure[]) {
      const result = projectExperimentResult({ ...input(), failure });
      expect(result.status).toBe("operationally_incomplete"); expect(result.observations).toHaveLength(1);
      expect(result.hypothesis_verdict).toBe("unknown");
    }
    for (const outcome of [null, "failed", "cancelled"]) expect(projectExperimentResult({ ...input(), outcome }).status).toBe("operationally_incomplete");
    for (const terminationReason of ["hard_deadline", "lease_lost", "cancelled", "worker_exit", "control_plane_restart"])
      expect(projectExperimentResult({ ...input(), terminationReason }).status).toBe("operationally_incomplete");
  });
  test("evidence presence never means verification and missing status takes precedence", () => {
    for (const status of ["available", "missing", "unavailable"] as const) {
      expect(projectExperimentResult({ ...input(), evidence: [{ ref: "artifacts/test.log", status }] }).observations[0]?.evidence)
        .toBe(status === "available" ? "refs_available_not_verified" : status);
    }
    const value = input(); value.evidence = [];
    expect(projectExperimentResult(value).observations[0]?.evidence).toBe("unavailable");
    value.checkpoint.attempts[0]!.evidence_refs = [];
    expect(projectExperimentResult(value).observations[0]?.evidence).toBe("not_supplied");
    value.checkpoint.attempts[0]!.evidence_refs = ["missing", "unknown"];
    expect(projectExperimentResult({ ...value, evidence: [{ ref: "missing", status: "missing" }] }).observations[0]?.evidence).toBe("missing");
  });
});
