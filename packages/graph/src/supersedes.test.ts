import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProjectSupersedeSummary,
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  findSupersedingFact,
  heartbeatIntent,
  listFactSupersessions,
  parseSupersededIds,
  recordFactMeta,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-supersedes-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "supersedes",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Concludes a fresh intent and returns the new fact id. */
function fact(description: string, supersedes: readonly string[] = []): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description,
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    return concludeIntent(conn, projectId, intent.id, "cairn-worker", description, {
      supersedes,
    }).fact.id;
  });
}

describe("parseSupersededIds", () => {
  test("keeps only non-empty string ids", () => {
    expect(parseSupersededIds('["f001", "", 3, null, "f002"]')).toEqual(["f001", "f002"]);
  });

  test("tolerates malformed sidecar values", () => {
    expect(parseSupersededIds("not json")).toEqual([]);
    expect(parseSupersededIds('{"fact":"f001"}')).toEqual([]);
  });
});

describe("supersede edges", () => {
  test("derives the reverse edge with both descriptions", () => {
    const older = fact("service is on port 80");
    const newer = fact("service is on port 8080", [older]);

    const edges = db.withConn((conn) => listFactSupersessions(conn, projectId));
    expect(edges).toEqual([
      {
        fact_id: older,
        description: "service is on port 80",
        superseded_by: newer,
        superseded_by_description: "service is on port 8080",
        created_at: expect.any(String),
      },
    ]);
    expect(db.withConn((conn) => findSupersedingFact(conn, projectId, older))).toBe(newer);
    expect(db.withConn((conn) => findSupersedingFact(conn, projectId, newer))).toBeNull();
  });

  test("collapses duplicate targets to the newest replacement", () => {
    const target = fact("target");
    const earlier = fact("earlier replacement", [target]);
    const later = fact("later replacement", [target]);
    db.withConn((conn) => {
      recordFactMeta(conn, {
        projectId,
        factId: earlier,
        evidenceStatus: "missing",
        supersedes: [target],
        createdAt: "2026-01-01T00:00:00Z",
      });
      recordFactMeta(conn, {
        projectId,
        factId: later,
        evidenceStatus: "missing",
        supersedes: [target],
        createdAt: "2026-01-02T00:00:00Z",
      });
    });

    const [edge] = db.withConn((conn) => listFactSupersessions(conn, projectId));
    expect(edge?.fact_id).toBe(target);
    expect(edge?.superseded_by).toBe(later);
    expect(db.withConn((conn) => findSupersedingFact(conn, projectId, target))).toBe(later);
  });

  test("breaks created_at ties deterministically by the replacing fact id", () => {
    const target = fact("target");
    const left = fact("left", [target]);
    const right = fact("right", [target]);
    db.withConn((conn) => {
      for (const factId of [left, right]) {
        recordFactMeta(conn, {
          projectId,
          factId,
          evidenceStatus: "missing",
          supersedes: [target],
          createdAt: "2026-01-01T00:00:00Z",
        });
      }
    });

    const [edge] = db.withConn((conn) => listFactSupersessions(conn, projectId));
    expect(edge?.superseded_by).toBe(left < right ? right : left);
  });

  test("ignores self references and unknown targets", () => {
    const older = fact("older");
    const newer = fact("newer", [older, "f999", older]);
    db.withConn((conn) =>
      recordFactMeta(conn, {
        projectId,
        factId: newer,
        evidenceStatus: "missing",
        supersedes: [newer, "f999", older],
      }),
    );

    const edges = db.withConn((conn) => listFactSupersessions(conn, projectId));
    expect(edges.map((edge) => edge.fact_id)).toEqual([older]);
    expect(edges[0]?.superseded_by).toBe(newer);
  });

  test("summarizes current and superseded counts, seed facts included", () => {
    const older = fact("older");
    fact("newer", [older]);

    const summary = db.withConn((conn) =>
      buildProjectSupersedeSummary(conn, projectId),
    );
    // origin + goal + two dynamic facts; only the older fact is replaced.
    expect(summary.facts).toEqual({ total: 4, current: 3, superseded: 1 });
    expect(summary.supersessions).toHaveLength(1);
    expect(summary.project_id).toBe(projectId);
  });

  test("an empty project has no supersede edges", () => {
    const summary = db.withConn((conn) =>
      buildProjectSupersedeSummary(conn, projectId),
    );
    expect(summary.facts).toEqual({ total: 2, current: 2, superseded: 0 });
    expect(summary.supersessions).toEqual([]);
  });
});
