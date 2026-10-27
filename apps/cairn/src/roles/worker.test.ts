import { describe, expect, test } from "bun:test";

import { normalizeResult } from "./worker";

describe("worker result normalization", () => {
  test("prefers top-level evidence_refs when the model wrote both", () => {
    const result = normalizeResult({
      accepted: true,
      data: {
        description: "second marker verified",
        evidence_refs: ["evidence/second_summary.md", "artifacts/second_bytes.log"],
      },
      evidence_refs: ["artifacts/second_bytes.log"],
    });

    expect(result).toEqual({
      accepted: true,
      data: { description: "second marker verified" },
      evidence_refs: ["artifacts/second_bytes.log"],
    });
  });

  test("lifts nested evidence_refs even when the model omits them at the top level", () => {
    const result = normalizeResult({
      accepted: true,
      data: {
        description: "second marker verified",
        evidence_refs: ["evidence/second_summary.md"],
      },
    });

    expect(result).toEqual({
      accepted: true,
      data: { description: "second marker verified" },
      evidence_refs: ["evidence/second_summary.md"],
    });
  });

  test("leaves data untouched when it is not an object", () => {
    expect(() => normalizeResult({ accepted: true, data: ["not-a-record"] })).toThrow(
      "does not form a valid result",
    );
  });

  test("keeps a bare payload's top-level evidence_refs", () => {
    const result = normalizeResult({
      description: "fact without envelope",
      evidence_refs: ["artifacts/probe.txt"],
    });

    expect(result).toEqual({
      accepted: true,
      data: { description: "fact without envelope" },
      evidence_refs: ["artifacts/probe.txt"],
    });
  });

  test("omits evidence_refs when the model provided none", () => {
    const result = normalizeResult({ accepted: true, data: { description: "no evidence" } });

    expect(result).toEqual({ accepted: true, data: { description: "no evidence" } });
    expect("evidence_refs" in result).toBe(false);
  });
});
