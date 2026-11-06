import { describe, expect, test } from "bun:test";
import { EXPERIMENT_FIELDS, isExperimentContract, MAX_EXPERIMENT_BYTES, parseExperimentContract } from "./experiment";
import { validateReasonPayload } from "./payloads";
import { experiment } from "./testdata/experiment";

describe("M51a optional experiment contract", () => {
  test("accepts wrapped, bare and singular reason intents without changing legacy payloads", () => {
    for (const plan of [undefined, experiment()]) {
      const intent = { from: ["origin"], description: "check", ...(plan === undefined ? {} : { experiment: plan }) };
      for (const payload of [{ intents: [intent] }, { intent }, { accepted: true, data: { intents: [intent] } }]) {
        const result = validateReasonPayload(payload, true, 2);
        expect(result.kind).toBe("intents");
        if (result.kind !== "intents") throw new Error("unexpected result");
        expect(result.data.intents).toEqual([intent]);
      }
    }
  });
  test("rejects invalid shape, null, versions, unknown keys and non-string or missing fields", () => {
    for (const bad of [null, [], "plan", {}, { ...experiment(), version: 2 }, { ...experiment(), extra: true }]) {
      expect(isExperimentContract(bad)).toBe(false);
    }
    for (const key of EXPERIMENT_FIELDS) {
      const missing: Record<string, unknown> = { ...experiment() }; delete missing[key];
      for (const bad of [missing, { ...experiment(), [key]: " \n\t" }, { ...experiment(), [key]: 12 }]) {
        expect(isExperimentContract(bad)).toBe(false);
        expect(() => validateReasonPayload({ intents: [{ from: ["origin"], description: "check", experiment: bad }] }, true, 2)).toThrow("invalid intent experiment");
      }
    }
  });
  test("enforces each text bound and the UTF-8 total including JSON overhead", () => {
    for (const key of EXPERIMENT_FIELDS) {
      const limit = key === "action" ? 2048 : 1024;
      expect(isExperimentContract(experiment({ [key]: "a".repeat(limit) }))).toBe(true);
      expect(isExperimentContract(experiment({ [key]: "a".repeat(limit + 1) }))).toBe(false);
    }
    const multibyte = experiment({ hypothesis: "中".repeat(1024), action: "中".repeat(2048) });
    expect(JSON.stringify(multibyte).length).toBeLessThan(MAX_EXPERIMENT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(multibyte))).toBeGreaterThan(MAX_EXPERIMENT_BYTES);
    expect(isExperimentContract(multibyte)).toBe(false);
    const boundary = experiment({ hypothesis: "中".repeat(1024), action: "中".repeat(1500) });
    const bytes = Buffer.byteLength(JSON.stringify(boundary));
    boundary.evidence_required += "a".repeat(MAX_EXPERIMENT_BYTES - bytes);
    expect(Buffer.byteLength(JSON.stringify(boundary))).toBe(MAX_EXPERIMENT_BYTES);
    expect(isExperimentContract(boundary)).toBe(true);
    expect(isExperimentContract({ ...boundary, evidence_required: boundary.evidence_required + "a" })).toBe(false);
  });
  test("stored malformed or oversized JSON is absent, not repaired", () => {
    expect(parseExperimentContract(JSON.stringify(experiment()))).toEqual(experiment());
    for (const bad of [undefined, null, "{", "null", "[]", JSON.stringify({ ...experiment(), extra: true }), " ".repeat(8193)]) {
      expect(parseExperimentContract(bad)).toBeNull();
    }
  });
  test("validates the whole reason list before applying limits", () => {
    expect(() => validateReasonPayload({ intents: [
      { from: ["origin"], description: "valid", experiment: experiment() },
      { from: ["origin"], description: "invalid", experiment: null },
    ] }, true, 1)).toThrow("invalid intent experiment at index 1");
  });
});
