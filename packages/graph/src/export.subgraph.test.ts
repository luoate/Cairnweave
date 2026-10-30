import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concludeIntent, createIntent, createProject } from "./commands";
import { configureDatabase, type CairnDatabase } from "./db";
import {
  exportProjectSubgraphYaml,
  selectSubgraph,
  SUBGRAPH_MAX_DEPTH,
} from "./export";
import { HttpError } from "./errors";

interface SubgraphYaml {
  project: { title: string; origin: string; goal: string; bootstrap_enabled: boolean };
  slice: {
    around: string;
    focus_kind: "fact" | "intent";
    depth: number;
    included_facts: number;
    included_intents: number;
    max_facts: number;
    max_intents: number;
    truncated: boolean;
  };
  hints?: Array<{ content: string }>;
  facts: Array<{ id: string; description: string }>;
  intents?: Array<{ from: string[]; to: string | null; description: string }>;
}

let directory: string;
let db: CairnDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-subgraph-"));
  db = configureDatabase(join(directory, "cairn.db"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function parse(text: string): SubgraphYaml {
  return Bun.YAML.parse(text) as SubgraphYaml;
}

/**
 * Chain shape:
 *   origin --i001--> f001 --i002--> f002 --i003--> f003
 */
function seedChain(): { projectId: string; factIds: string[]; intentIds: string[] } {
  return db.withConn((conn) => {
    const project = createProject(conn, {
      title: "subgraph",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: false,
      hints: [{ content: "hint one", creator: "human" }],
      scope: { targets: ["127.0.0.1:8080"] },
    });
    const projectId = project.project.id;
    const factIds = ["origin"];
    const intentIds: string[] = [];
    let from = "origin";
    for (const [index, label] of ["first", "second", "third"].entries()) {
      const intent = createIntent(conn, projectId, {
        from: [from],
        description: label,
        creator: "cairn-worker",
        worker: null,
      });
      const conclusion = concludeIntent(
        conn,
        projectId,
        intent.id,
        "cairn-worker",
        `fact ${index + 1}`,
      );
      intentIds.push(intent.id);
      from = conclusion.fact.id;
      factIds.push(from);
    }
    return { projectId, factIds, intentIds };
  });
}

describe("selectSubgraph", () => {
  test("walks one hop from a focus fact and gates produced facts by depth", () => {
    const { projectId, factIds, intentIds } = seedChain();
    const selection = db.withConn((conn) =>
      selectSubgraph(conn, projectId, {
        around: factIds[1]!,
        depth: 1,
        maxFacts: 60,
        maxIntents: 40,
      }),
    );

    expect(selection.focus).toEqual({ kind: "fact", id: "f001" });
    expect(selection.facts.map((fact) => fact.id)).toEqual(["origin", "goal", "f001"]);
    expect(selection.intents.map((intent) => intent.id)).toEqual([
      intentIds[0]!,
      intentIds[1]!,
    ]);
    expect(selection.sourcesByIntent.get(intentIds[1]!)).toEqual(["f001"]);
    expect(selection.truncated).toBe(false);
  });

  test("includes deeper consumers only once the walk reaches them", () => {
    const { projectId, factIds, intentIds } = seedChain();
    const atThree = db.withConn((conn) =>
      selectSubgraph(conn, projectId, {
        around: factIds[1]!,
        depth: 3,
        maxFacts: 60,
        maxIntents: 40,
      }),
    );
    expect(atThree.intents.map((intent) => intent.id)).toContain(intentIds[2]!);
    expect(atThree.facts.map((fact) => fact.id)).not.toContain(factIds[3]!);

    const atFour = db.withConn((conn) =>
      selectSubgraph(conn, projectId, {
        around: factIds[1]!,
        depth: SUBGRAPH_MAX_DEPTH,
        maxFacts: 60,
        maxIntents: 40,
      }),
    );
    expect(atFour.facts.map((fact) => fact.id)).toContain(factIds[3]!);
  });

  test("focuses an intent and keeps its sources and produced fact", () => {
    const { projectId, factIds, intentIds } = seedChain();
    const selection = db.withConn((conn) =>
      selectSubgraph(conn, projectId, {
        around: intentIds[1]!,
        depth: 2,
        maxFacts: 60,
        maxIntents: 40,
      }),
    );

    expect(selection.focus).toEqual({ kind: "intent", id: intentIds[1]! });
    expect(selection.facts.map((fact) => fact.id)).toEqual([
      "origin",
      "goal",
      "f001",
      "f002",
    ]);
    expect(selection.intents.map((intent) => intent.id)).toEqual([
      intentIds[0]!,
      intentIds[1]!,
      intentIds[2]!,
    ]);
  });

  test("always seeds open intents so work in flight stays visible", () => {
    const { projectId, factIds } = seedChain();
    const { openId, selection } = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: [factIds[3]!],
        description: "pending direction",
        creator: "cairn-worker",
        worker: null,
      });
      return {
        openId: intent.id,
        selection: selectSubgraph(conn, projectId, {
          around: factIds[1]!,
          depth: 1,
          maxFacts: 60,
          maxIntents: 40,
        }),
      };
    });

    expect(selection.intents.map((intent) => intent.id)).toContain(openId);
    expect(selection.facts.map((fact) => fact.id)).toContain(factIds[3]!);
  });

  test("applies caps with origin and goal first and reports truncation", () => {
    const { projectId, factIds } = seedChain();
    const selection = db.withConn((conn) =>
      selectSubgraph(conn, projectId, {
        around: factIds[1]!,
        depth: 2,
        maxFacts: 2,
        maxIntents: 1,
      }),
    );

    expect(selection.facts.map((fact) => fact.id)).toEqual(["origin", "goal"]);
    expect(selection.intents).toHaveLength(1);
    expect(selection.truncated).toBe(true);
  });

  test("rejects a node that is not in the project", () => {
    const { projectId } = seedChain();
    let status = 0;
    try {
      db.withConn((conn) =>
        selectSubgraph(conn, projectId, {
          around: "f999",
          depth: 1,
          maxFacts: 60,
          maxIntents: 40,
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      status = (error as HttpError).status;
    }
    expect(status).toBe(404);
  });
});

describe("exportProjectSubgraphYaml", () => {
  test("renders the slice header and is deterministic", () => {
    const { projectId, factIds } = seedChain();
    const options = { around: factIds[1]!, depth: 2, maxFacts: 60, maxIntents: 40 };
    const first = db.withConn((conn) => exportProjectSubgraphYaml(conn, projectId, options));
    const second = db.withConn((conn) => exportProjectSubgraphYaml(conn, projectId, options));
    expect(first).toBe(second);

    const yaml = parse(first);
    expect(yaml.project).toEqual({
      title: "subgraph",
      origin: "start here",
      goal: "reach the end",
      bootstrap_enabled: false,
    });
    expect(yaml.slice).toEqual({
      around: "f001",
      focus_kind: "fact",
      depth: 2,
      included_facts: 4,
      included_intents: 2,
      max_facts: 60,
      max_intents: 40,
      truncated: false,
    });
    expect(yaml.hints?.map((hint) => hint.content)).toEqual(["hint one"]);
    expect(first.endsWith("\n")).toBe(true);
  });
});
