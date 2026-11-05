import { describe, expect, test } from "bun:test";
import { ATTEMPT_RESULTS, MAX_CHECKPOINT_BYTES, isTaskCheckpoint, parseTaskCheckpoint, safeCheckpointRef } from "./checkpoint";
import { checkpoint } from "./testdata/checkpoint";
describe("M49 bounded checkpoint contract", () => {
  test("preserves separate action, observation, interpretation and all result classes", () => {
    for (const result of ATTEMPT_RESULTS) {
      const value = checkpoint(); value.attempts[0]!.result = result;
      expect(parseTaskCheckpoint(Buffer.from(JSON.stringify(value)))).toEqual(value);
    }
  });
  test("rejects forged versions, non-monotonic-shaped sequences and unknown authority fields", () => {
    for (const patch of [{ version: 2 }, { sequence: 0 }, { sequence: 1.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { stage: "complete" }, { completed: true }, { project_id: "" }, { intent_id: 4 }]) {
      expect(isTaskCheckpoint({ ...checkpoint(), ...patch })).toBe(false);
    }
  });
  test("bounds nested fields, counts, identities and duplicated attempts", () => {
    const base = checkpoint();
    for (const value of [checkpoint({ attempts: Array(33).fill(base.attempts[0]) }),
      checkpoint({ attempts: [base.attempts[0]!, base.attempts[0]!] }), checkpoint({ progress: "长".repeat(4097) }),
      checkpoint({ unresolved: Array(17).fill("x") }), checkpoint({ next_steps: ["x".repeat(1025)] }),
      { ...base, attempts: [{ ...base.attempts[0], accepted: true }] },
      { ...base, attempts: [{ ...base.attempts[0], result: "hypothesis_refuted" }] }]) expect(isTaskCheckpoint(value)).toBe(false);
  });
  test("rejects invalid UTF-8, partial JSON and serialized byte overflow", () => {
    expect(parseTaskCheckpoint(Buffer.from('{"version":'))).toBeNull();
    expect(parseTaskCheckpoint(new Uint8Array([0xff]))).toBeNull();
    expect(parseTaskCheckpoint(Buffer.alloc(MAX_CHECKPOINT_BYTES + 1))).toBeNull();
    expect(parseTaskCheckpoint(Buffer.from(JSON.stringify(checkpoint()) + " ".repeat(MAX_CHECKPOINT_BYTES)))).toBeNull();
  });
  test("references are portable project-relative data, not arbitrary read paths", () => {
    for (const ref of ["../outside", "/abs", "C:/secret", ["artifacts", "a"].join(String.fromCharCode(92)), "a//b", "a/./b", "a\u0000b", "a/../b", "a:" , ""]) {
      expect(safeCheckpointRef(ref)).toBe(false);
      const value = checkpoint(); value.attempts[0]!.evidence_refs = [ref]; expect(isTaskCheckpoint(value)).toBe(false);
    }
    expect(safeCheckpointRef("artifacts/任务/证据.log")).toBe(true);
  });
});
