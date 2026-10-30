import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  configureDatabase,
  createHint,
  createIntent,
  createProposal,
  createProject,
  findAppliedProposalByDedupeKey,
  findDuplicateOpenIntent,
  findFactByDescription,
  findHintByContent,
  findOpenIntentByDedupeKey,
  getIntentMeta,
  normalizeIntentDescription,
  getProposal,
  listPendingProposals,
  listProjectIntentMeta,
  listProjectProposals,
  recordIntentMeta,
  recordProposalDecision,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-proposals-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "proposals",
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

function addProposal(
  id: string,
  overrides: Partial<Parameters<typeof createProposal>[1]> = {},
) {
  return db.withConn((conn) =>
    createProposal(conn, {
      id,
      projectId,
      taskId: "explore-1",
      runId: "run-1",
      source: "observer",
      kind: "hint",
      payload: { content: "try the admin panel" },
      ...overrides,
    }),
  );
}

describe("proposal storage", () => {
  test("creates, lists and reads candidates", () => {
    expect(addProposal("p1")).toBe(true);
    expect(addProposal("p2", {
      kind: "intent",
      payload: { description: "probe admin", from: ["origin"] },
      dedupeKey: "probe-admin",
      evidenceRefs: ["notes/a.txt"],
    })).toBe(true);

    const all = db.withConn((conn) => listProjectProposals(conn, projectId));
    expect(all.map((proposal) => proposal.id)).toEqual(["p1", "p2"]);
    expect(all[1]).toMatchObject({
      task_id: "explore-1",
      run_id: "run-1",
      source: "observer",
      kind: "intent",
      status: "pending",
      dedupe_key: "probe-admin",
      evidence_refs: ["notes/a.txt"],
      payload: { description: "probe admin", from: ["origin"] },
      decision_reason: null,
      applied_id: null,
    });
    expect(db.withConn((conn) => getProposal(conn, projectId, "p2"))?.kind).toBe("intent");
    expect(db.withConn((conn) => getProposal(conn, projectId, "missing"))).toBeNull();
  });

  test("ignores a duplicate id and filters by status and kind", () => {
    expect(addProposal("p1")).toBe(true);
    expect(addProposal("p1", { payload: { content: "changed" } })).toBe(false);
    expect(addProposal("p2", { kind: "fact", payload: { description: "x", from: ["origin"] } })).toBe(
      true,
    );

    const hints = db.withConn((conn) =>
      listProjectProposals(conn, projectId, { kind: "hint" }),
    );
    expect(hints.map((proposal) => proposal.id)).toEqual(["p1"]);

    expect(
      db.withConn((conn) =>
        recordProposalDecision(conn, projectId, "p1", {
          status: "duplicate",
          reason: "hint_exists",
          appliedId: "h1",
        }),
      ),
    ).toBe(true);
    // A second decision must not overwrite the first one.
    expect(
      db.withConn((conn) =>
        recordProposalDecision(conn, projectId, "p1", {
          status: "applied",
          appliedId: "h2",
        }),
      ),
    ).toBe(false);
    expect(db.withConn((conn) => getProposal(conn, projectId, "p1"))).toMatchObject({
      status: "duplicate",
      decision_reason: "hint_exists",
      applied_id: "h1",
    });

    expect(
      db.withConn((conn) =>
        listProjectProposals(conn, projectId, { status: "pending" }),
      ).map((proposal) => proposal.id),
    ).toEqual(["p2"]);
    expect(db.withConn((conn) => listPendingProposals(conn, projectId)).map((p) => p.id)).toEqual([
      "p2",
    ]);
  });

  test("missing projects are 404 and cascades remove proposals", () => {
    expect(() =>
      db.withConn((conn) => listProjectProposals(conn, "p-missing")),
    ).toThrow(HttpError);
    addProposal("p1");
    db.withConn((conn) => {
      conn.query("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    expect(
      db.withConn((conn) => conn.query("SELECT COUNT(*) AS n FROM proposals").get()),
    ).toEqual({ n: 0 });
  });
});

describe("intent metadata and dedupe lookups", () => {
  test("persists strategist priority and budget hints", () => {
    const created = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "priority probe",
        creator: "cairn-worker",
        worker: null,
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: intent.id,
        source: "strategist",
        priority: 90,
        budget: JSON.stringify({ max_seconds: 120, max_tool_calls: 8 }),
      });
      return intent;
    });

    expect(db.withConn((conn) => getIntentMeta(conn, projectId, created.id))).toEqual({
      project_id: projectId,
      intent_id: created.id,
      dedupe_key: null,
      source: "strategist",
      proposal_id: null,
      origin_run_id: null,
      priority: 90,
      budget: { max_seconds: 120, max_tool_calls: 8 },
      created_at: expect.any(String),
    });
    expect(
      db.withConn((conn) => listProjectIntentMeta(conn, projectId)).map((meta) => meta.intent_id),
    ).toEqual([created.id]);
  });

  test("normalizes malformed stored priority and budget to null", () => {
    const created = db.withConn((conn) => {
      const intent = createIntent(conn, projectId, {
        from: ["origin"],
        description: "bad meta",
        creator: "cairn-worker",
        worker: null,
      });
      conn
        .query(
          "INSERT INTO intent_meta (project_id, intent_id, priority, budget, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(projectId, intent.id, 900, '{"max_seconds":-1}', "2026-01-01T00:00:00Z");
      return intent;
    });

    const meta = db.withConn((conn) => getIntentMeta(conn, projectId, created.id));
    expect(meta?.priority).toBeNull();
    expect(meta?.budget).toBeNull();
  });

  test("finds open intents by dedupe key and ignores concluded ones", () => {
    const intent = db.withConn((conn) => {
      const created = createIntent(conn, projectId, {
        from: ["origin"],
        description: "probe admin",
        creator: "observer",
        worker: null,
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: created.id,
        dedupeKey: "probe-admin",
        source: "observer",
        proposalId: "p1",
      });
      return created;
    });

    expect(
      db.withConn((conn) => findOpenIntentByDedupeKey(conn, projectId, "probe-admin")?.id),
    ).toBe(intent.id);

    db.withConn((conn) => {
      conn
        .query(
          "UPDATE intents SET to_fact_id = 'goal', concluded_at = ? WHERE id = ? AND project_id = ?",
        )
        .run("2026-01-01T00:00:00Z", intent.id, projectId);
    });
    expect(
      db.withConn((conn) => findOpenIntentByDedupeKey(conn, projectId, "probe-admin")),
    ).toBeNull();
  });

  test("treats reworded descriptions of the same direction as duplicates", () => {
    const intent = db.withConn((conn) =>
      createIntent(conn, projectId, {
        from: ["origin"],
        description: "利用 f003 的凭据通过 SMB 横向到 10.0.2.0/24",
        creator: "cairn-worker",
        worker: null,
      }),
    );

    const same = db.withConn((conn) =>
      findDuplicateOpenIntent(conn, projectId, {
        dedupeKey: null,
        description: "利用f003的凭据，通过SMB横向到10.0.2.0/24。",
      }),
    );
    expect(same).toMatchObject({ reason: "description", intent: { id: intent.id } });

    const different = db.withConn((conn) =>
      findDuplicateOpenIntent(conn, projectId, {
        dedupeKey: null,
        description: "在 /upload 用 polyglot PHP 绕过上传限制",
      }),
    );
    expect(different).toBeNull();
  });

  test("prefers an explicit key and never judges short or concluded intents", () => {
    const keyed = db.withConn((conn) => {
      const created = createIntent(conn, projectId, {
        from: ["origin"],
        description: "probe admin",
        creator: "observer",
        worker: null,
      });
      recordIntentMeta(conn, {
        projectId,
        intentId: created.id,
        dedupeKey: "probe-admin",
        source: "observer",
      });
      return created;
    });

    expect(
      db.withConn((conn) =>
        findDuplicateOpenIntent(conn, projectId, {
          dedupeKey: "probe-admin",
          description: "完全不同的方向",
        }),
      ),
    ).toMatchObject({ reason: "dedupe_key", intent: { id: keyed.id } });

    expect(
      db.withConn((conn) =>
        findDuplicateOpenIntent(conn, projectId, {
          dedupeKey: null,
          description: "probe",
        }),
      ),
    ).toBeNull();

    db.withConn((conn) => {
      conn
        .query(
          "UPDATE intents SET to_fact_id = 'goal', concluded_at = ? WHERE id = ? AND project_id = ?",
        )
        .run("2026-01-01T00:00:00Z", keyed.id, projectId);
    });
    expect(
      db.withConn((conn) =>
        findDuplicateOpenIntent(conn, projectId, {
          dedupeKey: "probe-admin",
          description: "probe admin",
        }),
      ),
    ).toBeNull();
  });

  test("normalizes widths, case and punctuation before comparing", () => {
    expect(normalizeIntentDescription("  ＡＢＣ，全角！ ")).toBe("abc全角");
    expect(normalizeIntentDescription("SMB / Lateral,\n10.0.2.0")).toBe("smblateral10020");
  });

  test("finds only applied proposals for a dedupe key", () => {
    addProposal("p1", { dedupeKey: "same" });
    expect(
      db.withConn((conn) =>
        findAppliedProposalByDedupeKey(conn, projectId, "hint", "same"),
      ),
    ).toBeNull();

    db.withConn((conn) =>
      recordProposalDecision(conn, projectId, "p1", {
        status: "applied",
        appliedId: "h1",
      }),
    );
    expect(
      db.withConn((conn) =>
        findAppliedProposalByDedupeKey(conn, projectId, "hint", "same"),
      )?.applied_id,
    ).toBe("h1");
  });

  test("indexes hints and facts by exact content for duplicate checks", () => {
    const hint = db.withConn((conn) =>
      createHint(conn, projectId, { content: "check /admin", creator: "observer" }),
    );
    expect(
      db.withConn((conn) => findHintByContent(conn, projectId, "check /admin")?.id),
    ).toBe(hint.id);
    expect(
      db.withConn((conn) => findHintByContent(conn, projectId, "Check /admin")),
    ).toBeNull();

    const fact = db.withConn((conn) => {
      conn
        .query("INSERT INTO facts (id, project_id, description) VALUES ('f1', ?, 'admin panel')")
        .run(projectId);
      return "f1";
    });
    expect(
      db.withConn((conn) => findFactByDescription(conn, projectId, "admin panel")?.id),
    ).toBe(fact);
    expect(
      db.withConn((conn) => findFactByDescription(conn, projectId, "admin")),
    ).toBeNull();
  });
});
