import { describe, expect, test } from "bun:test";
import {
  extractJsonObject,
  validateBootstrapConcludePayload,
  validateBootstrapExecutePayload,
  validateExplorePayload,
  validateReasonPayload,
} from "./index";

describe("extractJsonObject", () => {
  test("extracts an object from markdown noise", () => {
    expect(
      extractJsonObject('result:\n```json\n{"accepted": true, "data": {}}\n```'),
    ).toEqual({ accepted: true, data: {} });
  });

  test("prefers a directly parseable document over inner objects", () => {
    expect(extractJsonObject('{"outer": {"inner": 1}}')).toEqual({
      outer: { inner: 1 },
    });
  });

  test("skips malformed earlier braces", () => {
    expect(extractJsonObject('note {not json} then {"ok": true}')).toEqual({ ok: true });
  });

  test("handles braces and escaped quotes inside strings", () => {
    const text = 'noise {"description": "a } \\" { b", "n": 1} tail';
    expect(extractJsonObject(text)).toEqual({ description: 'a } " { b', n: 1 });
  });

  test("finds an object inside an array", () => {
    expect(extractJsonObject('[1, {"ok": true}]')).toEqual({ ok: true });
  });

  test("tries later fences when an earlier one is invalid", () => {
    expect(
      extractJsonObject('```json\n{bad}\n```\n```\n{"ok": true}\n```'),
    ).toEqual({ ok: true });
  });

  test("accepts a fence without a language tag", () => {
    expect(extractJsonObject('```\n{"ok": true}\n```')).toEqual({ ok: true });
  });

  test("rejects output without a JSON object", () => {
    expect(() => extractJsonObject("Need inspect files and keep working.")).toThrow(
      "no JSON object found",
    );
  });

  test("rejects arrays as the direct value when no object exists", () => {
    expect(() => extractJsonObject("[1, 2, 3]")).toThrow("no JSON object found");
  });
});

describe("validateReasonPayload", () => {
  test("limits the number of intents", () => {
    const result = validateReasonPayload(
      {
        accepted: true,
        data: {
          intents: [
            { from: ["f001"], description: "one" },
            { from: ["f001"], description: "two" },
          ],
        },
      },
      true,
      1,
    );
    expect(result).toEqual({
      kind: "intents",
      data: [{ from: ["f001"], description: "one" }],
    });
  });

  test("requires an intent when none are open", () => {
    expect(() =>
      validateReasonPayload({ accepted: true, data: {} }, true, 3),
    ).toThrow("intents is required");
  });

  test("accepts noop when intents are already open", () => {
    expect(validateReasonPayload({ accepted: true, data: {} }, false, 3)).toEqual({
      kind: "noop",
      data: null,
    });
  });

  test("accepts a bare complete payload", () => {
    expect(
      validateReasonPayload(
        { complete: { from: ["f001"], description: "done" } },
        true,
        3,
      ),
    ).toEqual({
      kind: "complete",
      data: { from: ["f001"], description: "done" },
    });
  });

  test("accepts the singular intent key", () => {
    expect(
      validateReasonPayload(
        { intent: { from: ["f001"], description: "one" } },
        false,
        3,
      ),
    ).toEqual({
      kind: "intents",
      data: [{ from: ["f001"], description: "one" }],
    });
  });

  test("rejects complete and intents together", () => {
    expect(() =>
      validateReasonPayload(
        {
          accepted: true,
          data: {
            complete: { from: ["f001"], description: "done" },
            intents: [{ from: ["f001"], description: "one" }],
          },
        },
        false,
        3,
      ),
    ).toThrow("cannot coexist");
  });

  test("rejects rejected payloads without data", () => {
    expect(
      validateReasonPayload({ accepted: false, reason: "policy_refusal" }, true, 3),
    ).toEqual({ kind: "rejected", data: null });
  });

  test("rejects an unknown bare payload", () => {
    expect(() => validateReasonPayload({ ok: true }, true, 3)).toThrow(
      "accepted must be true or false",
    );
  });
});

describe("validateExplorePayload", () => {
  test("accepts a wrapped fact description", () => {
    expect(
      validateExplorePayload({
        accepted: true,
        data: { description: "  found the flag  " },
      }),
    ).toEqual({ kind: "fact", data: "found the flag" });
  });

  test("rejects planning text", () => {
    expect(() => validateExplorePayload({ plan: "keep working" })).toThrow(
      "accepted must be true or false",
    );
  });

  test("rejects empty descriptions", () => {
    expect(() =>
      validateExplorePayload({ accepted: true, data: { description: "   " } }),
    ).toThrow("description is required");
  });
});

describe("validateBootstrapExecutePayload", () => {
  test("requires both fact and complete", () => {
    expect(() =>
      validateBootstrapExecutePayload({
        accepted: true,
        data: { fact: { description: "one" } },
      }),
    ).toThrow("complete is required");
  });

  test("returns trimmed descriptions", () => {
    expect(
      validateBootstrapExecutePayload({
        accepted: true,
        data: {
          fact: { description: " fact " },
          complete: { description: " goal " },
        },
      }),
    ).toEqual({
      kind: "complete",
      data: { factDescription: "fact", completeDescription: "goal" },
    });
  });
});

describe("validateBootstrapConcludePayload", () => {
  test("accepts a fact with a stray complete key", () => {
    expect(
      validateBootstrapConcludePayload({
        accepted: true,
        data: { fact: { description: "fact" }, complete: { description: "ignored" } },
      }),
    ).toEqual({ kind: "fact", data: "fact" });
  });

  test("rejects unexpected keys", () => {
    expect(() =>
      validateBootstrapConcludePayload({
        accepted: true,
        data: { fact: { description: "fact" }, extra: 1 },
      }),
    ).toThrow("unexpected keys");
  });
});
