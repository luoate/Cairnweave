import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_FLAG_COUNT_CONDITION,
  MAX_PROJECT_GOAL_CONDITIONS,
  configureDatabase,
  createProject,
  getLatestVerificationCheck,
  getProjectVerification,
  goalConditionsFromVerification,
  hasObjectiveGoalCondition,
  listProjectGoalConditions,
  listVerificationChecks,
  parseCreateProjectRequest,
  recordVerificationCheck,
  resolveProjectGoalConditions,
  setProjectGoalConditions,
  setProjectVerification,
  summarizeProjectVerification,
  verificationAliasForGoalConditions,
  type CairnDatabase,
  type ProjectGoalConditionInput,
} from "./index";

let directory: string;
let db: CairnDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-verification-"));
  db = configureDatabase(join(directory, "cairn.db"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createRow(verification?: { kind: "challenge" | "evidence" | "off"; challenge_code?: string | null }): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title: "verification",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
        verification,
      }).project.id,
  );
}

describe("project verification policy", () => {
  test("defaults projects without a row to evidence", () => {
    const projectId = createRow();
    const policy = db.withConn((conn) => getProjectVerification(conn, projectId));

    expect(policy).toMatchObject({
      project_id: projectId,
      kind: "evidence",
      challenge_code: null,
    });
  });

  test("stores the verification chosen at project creation", () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });
    const policy = db.withConn((conn) => getProjectVerification(conn, projectId));

    expect(policy.kind).toBe("challenge");
    expect(policy.challenge_code).toBe("web-01");
  });

  test("upserts the policy and clears a stale challenge code", () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });
    db.withConn((conn) => setProjectVerification(conn, projectId, { kind: "off" }));

    const policy = db.withConn((conn) => getProjectVerification(conn, projectId));
    expect(policy.kind).toBe("off");
    expect(policy.challenge_code).toBeNull();
  });

  test("rejects unknown projects", () => {
    expect(() =>
      db.withConn((conn) => getProjectVerification(conn, "proj_999")),
    ).toThrow();
    expect(() =>
      db.withConn((conn) =>
        setProjectVerification(conn, "proj_999", { kind: "evidence" }),
      ),
    ).toThrow();
  });
});

describe("verification checks", () => {
  test("records outcomes and returns the latest first", () => {
    const projectId = createRow();

    const first = db.withConn((conn) =>
      recordVerificationCheck(conn, {
        projectId,
        kind: "challenge",
        ok: false,
        detail: "1/2 flags",
        challengeCode: "web-01",
        flagCount: 2,
        flagGotCount: 1,
        evidenceRefs: [],
        checkedAt: "2026-01-01T00:00:01Z",
      }),
    );
    db.withConn((conn) =>
      recordVerificationCheck(conn, {
        projectId,
        kind: "evidence",
        ok: true,
        detail: "2 fact(s) have recorded evidence",
        evidenceRefs: ["artifacts/a.txt", "artifacts/b.txt"],
        checkedAt: "2026-01-01T00:00:02Z",
      }),
    );

    expect(first).toMatchObject({
      kind: "challenge",
      ok: false,
      flag_count: 2,
      flag_got_count: 1,
      evidence_refs: [],
    });

    const latest = db.withConn((conn) => getLatestVerificationCheck(conn, projectId));
    expect(latest).toMatchObject({
      kind: "evidence",
      ok: true,
      evidence_refs: ["artifacts/a.txt", "artifacts/b.txt"],
    });

    const checks = db.withConn((conn) => listVerificationChecks(conn, projectId));
    expect(checks.map((check) => check.ok)).toEqual([true, false]);
  });

  test("clamps the list limit", () => {
    const projectId = createRow();
    for (let index = 0; index < 3; index += 1) {
      db.withConn((conn) =>
        recordVerificationCheck(conn, {
          projectId,
          kind: "off",
          ok: true,
          detail: `check ${index}`,
        }),
      );
    }

    expect(db.withConn((conn) => listVerificationChecks(conn, projectId, 0))).toHaveLength(1);
    expect(db.withConn((conn) => listVerificationChecks(conn, projectId, 500))).toHaveLength(3);
  });

  test("returns an empty list and no latest check for a new project", () => {
    const projectId = createRow();
    expect(
      db.withConn((conn) => listVerificationChecks(conn, projectId)),
    ).toEqual([]);
    expect(
      db.withConn((conn) => getLatestVerificationCheck(conn, projectId)),
    ).toBeNull();
  });
});

describe("project creation validation", () => {
  function body(verification: unknown): unknown {
    return {
      title: "verification",
      origin: "origin",
      goal: "goal",
      scope: { targets: ["127.0.0.1:8080"] },
      verification,
    };
  }

  test("accepts each verification kind", () => {
    expect(parseCreateProjectRequest(body({ kind: "evidence" })).verification).toEqual({
      kind: "evidence",
    });
    expect(parseCreateProjectRequest(body({ kind: "off" })).verification).toEqual({
      kind: "off",
    });
    expect(
      parseCreateProjectRequest(body({ kind: "challenge", challenge_code: " web-01 " }))
        .verification,
    ).toEqual({ kind: "challenge", challenge_code: "web-01" });
  });

  test("requires a challenge code for challenge verification", () => {
    expect(() =>
      parseCreateProjectRequest(body({ kind: "challenge" })),
    ).toThrow("challenge_code");
    expect(() =>
      parseCreateProjectRequest(body({ kind: "challenge", challenge_code: "   " })),
    ).toThrow("challenge_code");
  });

  test("rejects a challenge code for other kinds", () => {
    expect(() =>
      parseCreateProjectRequest(body({ kind: "off", challenge_code: "web-01" })),
    ).toThrow("challenge_code");
  });

  test("rejects unknown kinds and oversized codes", () => {
    expect(() =>
      parseCreateProjectRequest(body({ kind: "partial" })),
    ).toThrow();
    expect(() =>
      parseCreateProjectRequest(
        body({ kind: "challenge", challenge_code: "x".repeat(201) }),
      ),
    ).toThrow();
  });
});

function createConditionRow(goalConditions: ProjectGoalConditionInput[]): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title: "goal conditions",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
        goal_conditions: goalConditions,
      }).project.id,
  );
}

const MIXED_CONDITIONS: ProjectGoalConditionInput[] = [
  { kind: "challenge", challenge_code: "web-01" },
  { kind: "flag_count", min: 3 },
  { kind: "evidence" },
];

describe("project goal conditions", () => {
  test("stores the ordered AND list and the compatibility alias", () => {
    const projectId = createConditionRow(MIXED_CONDITIONS);

    const stored = db.withConn((conn) => listProjectGoalConditions(conn, projectId));
    expect(stored.map((condition) => condition.ordinal)).toEqual([0, 1, 2]);
    expect(stored.map((condition) => condition.kind)).toEqual([
      "challenge",
      "flag_count",
      "evidence",
    ]);
    expect(stored[0]).toMatchObject({ challenge_code: "web-01", min: null });
    expect(stored[1]).toMatchObject({ challenge_code: null, min: 3 });

    const policy = db.withConn((conn) => getProjectVerification(conn, projectId));
    expect(policy).toMatchObject({ kind: "challenge", challenge_code: "web-01" });

    const summary = db.withConn((conn) =>
      summarizeProjectVerification(conn, projectId),
    );
    expect(summary.goal_conditions).toHaveLength(3);
  });

  test("aliases a flag_count-only list to evidence", () => {
    const projectId = createConditionRow([{ kind: "flag_count", min: 2 }]);
    const policy = db.withConn((conn) => getProjectVerification(conn, projectId));

    expect(policy.kind).toBe("evidence");
    expect(policy.challenge_code).toBeNull();
    expect(
      db.withConn((conn) => resolveProjectGoalConditions(conn, projectId)),
    ).toMatchObject([{ kind: "flag_count", min: 2 }]);
  });

  test("synthesizes one condition from the legacy verification alias", () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });
    const conditions = db.withConn((conn) =>
      resolveProjectGoalConditions(conn, projectId),
    );

    expect(conditions).toMatchObject([
      { ordinal: 0, kind: "challenge", challenge_code: "web-01", min: null },
    ]);
    expect(db.withConn((conn) => listProjectGoalConditions(conn, projectId))).toHaveLength(
      1,
    );
  });

  test("treats off and missing aliases as no conditions", () => {
    const off = createRow({ kind: "off" });
    expect(db.withConn((conn) => resolveProjectGoalConditions(conn, off))).toEqual([]);

    const projectId = createRow();
    db.withConn((conn) => {
      conn
        .query("DELETE FROM project_goal_conditions WHERE project_id = ?")
        .run(projectId);
      conn
        .query("DELETE FROM project_verification WHERE project_id = ?")
        .run(projectId);
    });
    expect(
      db.withConn((conn) => resolveProjectGoalConditions(conn, projectId, "off")),
    ).toEqual([]);
    expect(
      db.withConn((conn) => resolveProjectGoalConditions(conn, projectId, "evidence")),
    ).toMatchObject([{ kind: "evidence" }]);
  });

  test("replaces the whole list, including with an empty list", () => {
    const projectId = createConditionRow(MIXED_CONDITIONS);

    db.withConn((conn) =>
      setProjectGoalConditions(conn, projectId, [{ kind: "flag_count", min: 1 }]),
    );
    expect(db.withConn((conn) => listProjectGoalConditions(conn, projectId))).toMatchObject(
      [{ ordinal: 0, kind: "flag_count", min: 1 }],
    );

    db.withConn((conn) => setProjectGoalConditions(conn, projectId, []));
    expect(db.withConn((conn) => listProjectGoalConditions(conn, projectId))).toEqual([]);
    expect(db.withConn((conn) => resolveProjectGoalConditions(conn, projectId))).toEqual([]);
  });

  test("rejects duplicate or malformed conditions at storage time", () => {
    const projectId = createRow();
    const set = (conditions: ProjectGoalConditionInput[]) =>
      db.withConn((conn) => setProjectGoalConditions(conn, projectId, conditions));

    expect(() => set([{ kind: "evidence" }, { kind: "evidence" }])).toThrow("duplicate");
    expect(() =>
      set([
        { kind: "challenge", challenge_code: "web-01" },
        { kind: "challenge", challenge_code: "web-01" },
      ]),
    ).toThrow("duplicate challenge condition");
    expect(() => set([{ kind: "challenge", challenge_code: "  " }])).toThrow(
      "challenge_code",
    );
    expect(() => set([{ kind: "flag_count", min: 0 }])).toThrow("min");
    expect(() => set([{ kind: "flag_count", min: MAX_FLAG_COUNT_CONDITION + 1 }])).toThrow(
      "min",
    );
    expect(() =>
      set([{ kind: "evidence", min: 1 }]),
    ).toThrow("only valid for flag_count");
    expect(() =>
      set(
        Array.from({ length: MAX_PROJECT_GOAL_CONDITIONS + 1 }, () => ({
          kind: "evidence" as const,
        })),
      ),
    ).toThrow("at most");
  });

  test("derives the alias and objective flag from a condition list", () => {
    expect(verificationAliasForGoalConditions(MIXED_CONDITIONS)).toEqual({
      kind: "challenge",
      challenge_code: "web-01",
    });
    expect(verificationAliasForGoalConditions([{ kind: "flag_count", min: 1 }])).toEqual({
      kind: "evidence",
    });
    expect(verificationAliasForGoalConditions([{ kind: "evidence" }])).toEqual({
      kind: "evidence",
    });
    expect(verificationAliasForGoalConditions([])).toEqual({ kind: "off" });

    const synthesized = goalConditionsFromVerification({
      project_id: "proj_001",
      kind: "evidence",
      challenge_code: null,
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(synthesized).toMatchObject([{ ordinal: 0, kind: "evidence" }]);
    expect(hasObjectiveGoalCondition(MIXED_CONDITIONS)).toBe(true);
    expect(hasObjectiveGoalCondition([{ kind: "evidence" }])).toBe(false);
    expect(hasObjectiveGoalCondition([])).toBe(false);
  });
});

describe("goal condition parsing", () => {
  function body(goalConditions: unknown): unknown {
    return {
      title: "goal conditions",
      origin: "origin",
      goal: "goal",
      scope: { targets: ["127.0.0.1:8080"] },
      goal_conditions: goalConditions,
    };
  }

  test("accepts an ordered list and preserves ordinals", () => {
    expect(
      parseCreateProjectRequest(body(MIXED_CONDITIONS)).goal_conditions,
    ).toEqual(MIXED_CONDITIONS);
  });

  test("rejects goal_conditions next to the legacy verification field", () => {
    expect(() =>
      parseCreateProjectRequest({
        ...(body([{ kind: "evidence" }]) as Record<string, unknown>),
        verification: { kind: "off" },
      }),
    ).toThrow("cannot coexist");
  });

  test("rejects malformed condition entries", () => {
    expect(() => parseCreateProjectRequest(body([]))).toThrow();
    expect(() => parseCreateProjectRequest(body("evidence"))).toThrow();
    expect(() => parseCreateProjectRequest(body([{ kind: "other" }]))).toThrow();
    expect(() => parseCreateProjectRequest(body([{ kind: "challenge" }]))).toThrow();
    expect(() =>
      parseCreateProjectRequest(body([{ kind: "evidence", min: 1 }])),
    ).toThrow();
    expect(() =>
      parseCreateProjectRequest(body([{ kind: "flag_count", min: 0 }])),
    ).toThrow();
    expect(() =>
      parseCreateProjectRequest(body([{ kind: "evidence", extra: true }])),
    ).toThrow();
    expect(() =>
      parseCreateProjectRequest(
        body([
          { kind: "challenge", challenge_code: "a" },
          { kind: "challenge", challenge_code: "a" },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseCreateProjectRequest(
        body(Array.from({ length: 9 }, () => ({ kind: "evidence" }))),
      ),
    ).toThrow();
  });
});
