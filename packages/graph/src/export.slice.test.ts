import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concludeIntent, createIntent, createProject } from "./commands";
import { configureDatabase, type CairnDatabase } from "./db";
import { exportProjectSliceYaml, exportProjectYaml } from "./export";

interface SliceYaml {
  project: { title: string; origin: string; goal: string; bootstrap_enabled: boolean };
  slice: {
    focus_intent: string | null;
    included_facts: number;
    included_intents: number;
    max_facts: number;
    max_intents: number;
    truncated: boolean;
  };
  hints?: Array<{ content: string; creator: string; created_at: string }>;
  facts: Array<{ id: string; description: string }>;
  intents?: Array<{ from: string[]; to: string | null; description: string }>;
}

let directory: string;
let db: CairnDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-slice-"));
  db = configureDatabase(join(directory, "cairn.db"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function parse(text: string): SliceYaml {
  return Bun.YAML.parse(text) as SliceYaml;
}

/**
 * Project shape:
 *   origin -> i001 ("first") -> f001
 *   f001   -> i002 ("second", open, focus)
 *   origin -> i003 ("parallel", open)
 */
function seed(): { projectId: string; focusIntentId: string } {
  return db.withConn((conn) => {
    const project = createProject(conn, {
      title: "slice",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: false,
      hints: [{ content: "hint one", creator: "human" }],
      scope: { targets: ["127.0.0.1:8080"] },
    });
    const projectId = project.project.id;

    const first = createIntent(conn, projectId, {
      from: ["origin"],
      description: "first",
      creator: "cairn-worker",
      worker: null,
    });
    const concluded = concludeIntent(
      conn,
      projectId,
      first.id,
      "cairn-worker",
      "fact from first",
    );
    const focus = createIntent(conn, projectId, {
      from: [concluded.fact.id],
      description: "second",
      creator: "cairn-worker",
      worker: null,
    });
    createIntent(conn, projectId, {
      from: ["origin"],
      description: "parallel",
      creator: "cairn-worker",
      worker: null,
    });
    return { projectId, focusIntentId: focus.id };
  });
}

describe("exportProjectSliceYaml", () => {
  test("keeps the focus intent, its sources, provenance, and other open intents", () => {
    const { projectId, focusIntentId } = seed();
    const sliced = db.withConn((conn) =>
      exportProjectSliceYaml(conn, projectId, {
        focusIntentId,
        maxFacts: 80,
        maxIntents: 60,
      }),
    );

    const yaml = parse(sliced);
    expect(yaml.project).toEqual({
      title: "slice",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: false,
    });
    expect(yaml.hints?.map((hint) => hint.content)).toEqual(["hint one"]);
    expect(yaml.facts.map((fact) => fact.id)).toEqual(["origin", "goal", "f001"]);
    expect(yaml.intents?.map((intent) => intent.description)).toEqual([
      "first",
      "second",
      "parallel",
    ]);
    expect(yaml.slice).toEqual({
      focus_intent: focusIntentId,
      included_facts: 3,
      included_intents: 3,
      max_facts: 80,
      max_intents: 60,
      truncated: false,
    });
    expect(sliced.endsWith("\n")).toBe(true);
  });

  test("is deterministic and keeps the full export shape unchanged", () => {
    const { projectId, focusIntentId } = seed();
    const options = { focusIntentId, maxFacts: 80, maxIntents: 60 };
    const first = db.withConn((conn) => exportProjectSliceYaml(conn, projectId, options));
    const second = db.withConn((conn) => exportProjectSliceYaml(conn, projectId, options));
    expect(first).toBe(second);

    const full = db.withConn((conn) => exportProjectYaml(conn, projectId));
    expect(full).not.toContain("slice:");
    expect(parse(full).facts).toHaveLength(3);
  });

  test("never drops the focus sources or open intents when the caps are tiny", () => {
    const { projectId, focusIntentId } = seed();
    const yaml = parse(
      db.withConn((conn) =>
        exportProjectSliceYaml(conn, projectId, {
          focusIntentId,
          maxFacts: 2,
          maxIntents: 1,
        }),
      ),
    );

    // origin/goal plus the focus source f001; the focus and parallel intents stay.
    // Provenance (i001) no longer fits, so the slice reports itself as truncated.
    expect(yaml.facts.map((fact) => fact.id)).toEqual(["origin", "goal", "f001"]);
    expect(yaml.intents?.map((intent) => intent.description)).toEqual([
      "second",
      "parallel",
    ]);
    expect(yaml.slice.truncated).toBe(true);
  });

  test("rejects an unknown focus intent", () => {
    const { projectId } = seed();
    expect(() =>
      db.withConn((conn) =>
        exportProjectSliceYaml(conn, projectId, {
          focusIntentId: "i999",
          maxFacts: 80,
          maxIntents: 60,
        }),
      ),
    ).toThrow("focus intent not found: i999");
  });
});
