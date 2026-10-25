/**
 * Prompt loading and rendering, ported from Cairn's `dispatcher/prompting.py`.
 *
 * Templates are copied verbatim from Cairn so the placeholders, whitespace and
 * newlines stay stable. `graph_yaml` is always replaced with a short "read this
 * file" reference; the full graph is never inlined into the prompt.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PROMPT_REQUIRED_TOKENS: Readonly<Record<string, readonly string[]>> = {
  "reason.md": ["{graph_yaml}", "{fact_ids}", "{open_intents}", "{max_intents}"],
  "explore.md": ["{graph_yaml}", "{intent_id}", "{intent_description}"],
  "explore_conclude.md": ["{graph_yaml}", "{intent_id}", "{intent_description}"],
  "bootstrap.md": ["{origin}", "{goal}", "{hints}"],
  "bootstrap_conclude.md": ["{origin}", "{goal}", "{hints}"],
};

export const PROMPT_REQUIRED_TOKENS_BY_GROUP: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  mock: {
    "reason.md": ["{fact_ids}", "{open_intents}", "{max_intents}"],
    "explore.md": ["{intent_id}"],
    "explore_conclude.md": ["{intent_id}"],
    "bootstrap.md": ["{origin}", "{goal}", "{hints}"],
    "bootstrap_conclude.md": ["{origin}", "{goal}", "{hints}"],
  },
};

export type PromptGroup = "default" | "mock" | (string & {});

/** Directory holding the bundled prompt groups. */
export function promptsRoot(): string {
  return import.meta.dir;
}

export function promptGroupPath(group: string, root: string = promptsRoot()): string {
  return join(root, group);
}

export function loadPrompt(group: string, name: string, root: string = promptsRoot()): string {
  return readFileSync(join(promptGroupPath(group, root), name), "utf8");
}

/**
 * Replace `{key}` tokens in insertion order, exactly like Cairn's Python loop.
 * Order matters when a replacement value itself contains a later token.
 */
export function renderPrompt(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let text = template;
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{${key}}`, value);
  }
  return text;
}

export function formatFactIds(factIds: readonly string[]): string {
  return formatJsonBlock(factIds);
}

export function formatOpenIntents(intents: readonly Record<string, unknown>[]): string {
  return formatJsonBlock(intents);
}

export function formatHints(hints: readonly Record<string, unknown>[]): string {
  return formatJsonBlock(hints);
}

/** `json.dumps(value, ensure_ascii=False, indent=2)` equivalent. */
export function formatJsonBlock(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new TypeError("value is not JSON serializable");
  }
  return text;
}

/**
 * Text substituted for `{graph_yaml}`. The worker gets a path and must read the file;
 * the prompt deliberately does not embed the graph itself.
 */
export function graphSnapshotReference(
  path: string,
  location: "container" | "sandbox" = "container",
): string {
  return (
    `The graph YAML snapshot is stored in this file inside the current ${location}:\n\n` +
    `${path}\n\n` +
    "Before using the graph, read the entire file and treat its contents as the YAML snapshot " +
    "for this Graph section."
  );
}

/** Mirrors `validate_prompt_resources`: the group must exist and contain its placeholders. */
export function validatePromptResources(group: string, root: string = promptsRoot()): void {
  const dir = promptGroupPath(group, root);
  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new Error(`missing prompt group: ${group}`);
  }

  const required =
    PROMPT_REQUIRED_TOKENS_BY_GROUP[group] ?? DEFAULT_PROMPT_REQUIRED_TOKENS;
  for (const [name, tokens] of Object.entries(required)) {
    let content: string;
    try {
      content = loadPrompt(group, name, root);
    } catch {
      throw new Error(`prompt group ${group} missing resource: ${name}`);
    }
    const missing = tokens.filter((token) => !content.includes(token));
    if (missing.length > 0) {
      throw new Error(
        `prompt group ${group} resource ${name} missing placeholders: ${missing.join(", ")}`,
      );
    }
  }
}
