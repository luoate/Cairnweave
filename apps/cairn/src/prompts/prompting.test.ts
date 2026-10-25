import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROMPT_REQUIRED_TOKENS,
  PROMPT_REQUIRED_TOKENS_BY_GROUP,
  formatFactIds,
  formatHints,
  formatJsonBlock,
  formatOpenIntents,
  graphSnapshotReference,
  loadPrompt,
  renderPrompt,
  validatePromptResources,
} from "./prompting";

interface PromptCase {
  group: string;
  name: string;
  template: string;
  replacements: Record<string, string>;
  rendered: string;
}

interface PromptGolden {
  cases: PromptCase[];
  formatters: {
    fact_ids: { input: string[]; output: string };
    open_intents: { input: Record<string, unknown>[]; output: string };
    hints: { input: Record<string, unknown>[]; output: string };
  };
  required_tokens: {
    default: Record<string, string[]>;
    mock: Record<string, string[]>;
  };
}

const golden: PromptGolden = JSON.parse(
  readFileSync(join(import.meta.dir, "testdata", "prompts.golden.json"), "utf8"),
);

describe("prompt golden", () => {
  for (const promptCase of golden.cases) {
    test(`${promptCase.group}/${promptCase.name} matches Python Cairn`, () => {
      expect(loadPrompt(promptCase.group, promptCase.name)).toBe(promptCase.template);
      expect(renderPrompt(promptCase.template, promptCase.replacements)).toBe(
        promptCase.rendered,
      );
    });
  }

  test("JSON formatters match json.dumps(indent=2, ensure_ascii=False)", () => {
    expect(formatFactIds(golden.formatters.fact_ids.input)).toBe(
      golden.formatters.fact_ids.output,
    );
    expect(formatOpenIntents(golden.formatters.open_intents.input)).toBe(
      golden.formatters.open_intents.output,
    );
    expect(formatHints(golden.formatters.hints.input)).toBe(
      golden.formatters.hints.output,
    );
  });

  test("required-token tables match the Python config", () => {
    expect(DEFAULT_PROMPT_REQUIRED_TOKENS).toEqual(golden.required_tokens.default);
    expect(PROMPT_REQUIRED_TOKENS_BY_GROUP.mock).toEqual(golden.required_tokens.mock);
  });
});

describe("prompt rendering", () => {
  test("replaces every occurrence of every token", () => {
    expect(renderPrompt("{a} {a} {b}", { a: "x", b: "y" })).toBe("x x y");
  });

  test("replaces in insertion order, like the Python loop", () => {
    expect(renderPrompt("{a}{b}", { a: "{b}", b: "X" })).toBe("XX");
    expect(renderPrompt("{b}{a}", { a: "{b}", b: "X" })).toBe("XX");
  });

  test("leaves unknown tokens untouched", () => {
    expect(renderPrompt("{a} {unknown}", { a: "x" })).toBe("x {unknown}");
  });

  test("formatJsonBlock rejects non-JSON values", () => {
    expect(() => formatJsonBlock(undefined)).toThrow(TypeError);
  });

  test("graph reference is a path, not inline YAML", () => {
    expect(graphSnapshotReference("/tmp/cairn-prompts/explore_execute-abc/graph.yaml")).toBe(
      "The graph YAML snapshot is stored in this file inside the current container:\n\n" +
        "/tmp/cairn-prompts/explore_execute-abc/graph.yaml\n\n" +
        "Before using the graph, read the entire file and treat its contents as the YAML snapshot " +
        "for this Graph section.",
    );
    expect(graphSnapshotReference("/workspace/graph.yaml", "sandbox")).toContain(
      "inside the current sandbox:",
    );
  });
});

describe("prompt validation", () => {
  test("accepts the bundled default and mock groups", () => {
    expect(() => validatePromptResources("default")).not.toThrow();
    expect(() => validatePromptResources("mock")).not.toThrow();
  });

  test("rejects a missing group", () => {
    expect(() => validatePromptResources("nope")).toThrow("missing prompt group: nope");
  });

  test("rejects a missing template", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-prompts-"));
    try {
      mkdirSync(join(root, "default"));
      expect(() => validatePromptResources("default", root)).toThrow(
        "missing resource: reason.md",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a template that lacks a required placeholder", () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-prompts-"));
    try {
      mkdirSync(join(root, "default"));
      for (const [name, tokens] of Object.entries(DEFAULT_PROMPT_REQUIRED_TOKENS)) {
        const content =
          name === "reason.md"
            ? tokens.filter((token) => token !== "{max_intents}").join(" ")
            : tokens.join(" ");
        writeFileSync(join(root, "default", name), content);
      }
      expect(() => validatePromptResources("default", root)).toThrow(
        "missing placeholders: {max_intents}",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
