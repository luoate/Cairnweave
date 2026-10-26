import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getLatestVerificationCheck,
  getProjectVerification,
  listVerificationChecks,
  parseCreateProjectRequest,
  recordVerificationCheck,
  setProjectVerification,
  type CairnDatabase,
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
