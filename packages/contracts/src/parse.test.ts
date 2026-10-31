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
      data: { intents: [{ from: ["f001"], description: "one" }], hints: [], abandons: [] },
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
      data: { intents: [{ from: ["f001"], description: "one" }], hints: [], abandons: [] },
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

  test("accepts per-intent priority and budget hints unchanged", () => {
    const intent = {
      from: ["f001"],
      description: "one",
      priority: 80,
      budget: { max_seconds: 120, max_tool_calls: 12 },
    };
    expect(
      validateReasonPayload({ accepted: true, data: { intents: [intent] } }, true, 3),
    ).toEqual({
      kind: "intents",
      data: { intents: [intent], hints: [], abandons: [] },
    });
  });

  test("rejects an out-of-range or non-integer priority", () => {
    for (const priority of [-1, 101, 3.5, "high"]) {
      expect(() =>
        validateReasonPayload(
          {
            accepted: true,
            data: { intents: [{ from: ["f001"], description: "one", priority }] },
          },
          true,
          3,
        ),
      ).toThrow("priority");
    }
  });

  test("rejects malformed intent budgets", () => {
    for (const budget of [
      "soon",
      [],
      {},
      { max_seconds: 0 },
      { max_tool_calls: -1 },
      { max_seconds: 1.5 },
      { unknown: 1 },
    ]) {
      expect(() =>
        validateReasonPayload(
          {
            accepted: true,
            data: { intents: [{ from: ["f001"], description: "one", budget }] },
          },
          true,
          3,
        ),
      ).toThrow("budget");
    }
  });

  test("accepts trimmed hints and caps them with max_intents", () => {
    const result = validateReasonPayload(
      {
        accepted: true,
        data: {
          intents: [{ from: ["f001"], description: "one" }],
          hints: [
            { content: "  check the login flow  " },
            { content: "inspect headers" },
            { content: "third" },
          ],
        },
      },
      true,
      2,
    );
    expect(result).toEqual({
      kind: "intents",
      data: {
        intents: [{ from: ["f001"], description: "one" }],
        hints: [{ content: "check the login flow" }, { content: "inspect headers" }],
        abandons: [],
      },
    });
  });

  test("accepts hints without intents only while other intents are open", () => {
    expect(
      validateReasonPayload(
        { accepted: true, data: { hints: [{ content: "hint only" }] } },
        false,
        3,
      ),
    ).toEqual({ kind: "hints", data: [{ content: "hint only" }], abandons: [] });
    expect(() =>
      validateReasonPayload(
        { accepted: true, data: { hints: [{ content: "hint only" }] } },
        true,
        3,
      ),
    ).toThrow("intents is required");
  });

  test("rejects malformed hints and complete+hints", () => {
    for (const hints of ["one", [{}], [{ content: " " }], [{ content: "x", id: "h1" }]]) {
      expect(() =>
        validateReasonPayload(
          { accepted: true, data: { intents: [{ from: ["f001"], description: "one" }], hints } },
          true,
          3,
        ),
      ).toThrow("hint");
    }
    expect(() =>
      validateReasonPayload(
        {
          accepted: true,
          data: {
            complete: { from: ["f001"], description: "done" },
            hints: [{ content: "not now" }],
          },
        },
        false,
        3,
      ),
    ).toThrow("cannot coexist");
  });

  test("validates optional intent dedupe keys", () => {
    expect(
      validateReasonPayload(
        {
          accepted: true,
          data: {
            intents: [
              { from: ["f001"], description: "one", dedupe_key: "  login-flow  " },
            ],
          },
        },
        true,
        3,
      ),
    ).toMatchObject({
      kind: "intents",
      data: {
        intents: [{ dedupe_key: "  login-flow  " }],
      },
    });

    for (const dedupe_key of ["", "   ", 7, "x".repeat(129)]) {
      expect(() =>
        validateReasonPayload(
          {
            accepted: true,
            data: { intents: [{ from: ["f001"], description: "one", dedupe_key }] },
          },
          true,
          3,
        ),
      ).toThrow("dedupe_key");
    }
  });

  test("accepts one abandon proposal, wrapped or bare", () => {
    const expected = {
      kind: "abandon" as const,
      data: [{ intent_id: "i003", reason: "two attempts produced nothing" }],
    };
    expect(
      validateReasonPayload(
        {
          accepted: true,
          data: {
            abandon: [
              { intent_id: "  i003  ", reason: "  two attempts produced nothing  " },
            ],
          },
        },
        false,
        3,
      ),
    ).toEqual(expected);
    expect(
      validateReasonPayload(
        { abandon: [{ intent_id: "i003", reason: "two attempts produced nothing" }] },
        false,
        3,
      ),
    ).toEqual(expected);
  });

  test("accepts abandon alongside intents and hints", () => {
    const result = validateReasonPayload(
      {
        accepted: true,
        data: {
          intents: [{ from: ["f001"], description: "next" }],
          hints: [{ content: "check the login flow" }],
          abandon: [{ intent_id: "i002", reason: "dead end" }],
        },
      },
      false,
      3,
    );
    expect(result).toMatchObject({
      kind: "intents",
      data: {
        intents: [{ from: ["f001"], description: "next" }],
        hints: [{ content: "check the login flow" }],
        abandons: [{ intent_id: "i002", reason: "dead end" }],
      },
    });
  });

  test("keeps abandons with hints but no intents", () => {
    expect(
      validateReasonPayload(
        {
          accepted: true,
          data: {
            hints: [{ content: "note" }],
            abandon: [{ intent_id: "i002", reason: "dead end" }],
          },
        },
        false,
        3,
      ),
    ).toEqual({
      kind: "hints",
      data: [{ content: "note" }],
      abandons: [{ intent_id: "i002", reason: "dead end" }],
    });
  });

  test("rejects complete combined with abandon", () => {
    expect(() =>
      validateReasonPayload(
        {
          accepted: true,
          data: {
            complete: { from: ["f001"], description: "done" },
            abandon: [{ intent_id: "i002", reason: "dead end" }],
          },
        },
        false,
        3,
      ),
    ).toThrow("complete and abandon");
  });

  test("validates the abandon shape and caps the list at one", () => {
    for (const entry of [
      { intent_id: "", reason: "x" },
      { intent_id: "i001", reason: "   " },
      { intent_id: "i001", reason: "x".repeat(501) },
      { intent_id: "i001", reason: "x", extra: 1 },
      { reason: "x" },
    ]) {
      expect(() =>
        validateReasonPayload({ accepted: true, data: { abandon: [entry] } }, false, 3),
      ).toThrow("abandon");
    }
    expect(() =>
      validateReasonPayload(
        { accepted: true, data: { abandon: "nope" } },
        false,
        3,
      ),
    ).toThrow("abandon must be an array");
    expect(() =>
      validateReasonPayload(
        {
          accepted: true,
          data: {
            abandon: [
              { intent_id: "i001", reason: "one" },
              { intent_id: "i001", reason: "two" },
            ],
          },
        },
        false,
        3,
      ),
    ).toThrow("duplicate abandon");

    const capped = validateReasonPayload(
      {
        accepted: true,
        data: {
          abandon: [
            { intent_id: "i001", reason: "one" },
            { intent_id: "i002", reason: "two" },
          ],
        },
      },
      false,
      3,
    );
    expect(capped).toEqual({
      kind: "abandon",
      data: [{ intent_id: "i001", reason: "one" }],
    });
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
