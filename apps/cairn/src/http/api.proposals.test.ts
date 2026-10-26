import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProposal,
  createProject,
  recordProposalDecision,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-proposals-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
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

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function addProposal(id: string, kind: "fact" | "intent" | "hint", payload: Record<string, unknown>) {
  db.withConn((conn) =>
    createProposal(conn, {
      id,
      projectId,
      taskId: "explore-1",
      runId: "run-1",
      source: "observer",
      kind,
      payload,
      ...(kind === "intent" ? { dedupeKey: `key-${id}` } : {}),
    }),
  );
}

describe("proposal routes", () => {
  test("lists proposals read-only with their review fields", async () => {
    addProposal("p1", "hint", { content: "check /admin" });
    addProposal("p2", "intent", { description: "probe admin", from: ["origin"] });
    db.withConn((conn) =>
      recordProposalDecision(conn, projectId, "p1", {
        status: "applied",
        appliedId: "h1",
      }),
    );

    const response = await get(`/projects/${projectId}/proposals`);
    expect(response.status).toBe(200);
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    expect(rows.map((row) => row["id"])).toEqual(["p1", "p2"]);
    expect(rows[0]).toMatchObject({
      project_id: projectId,
      task_id: "explore-1",
      run_id: "run-1",
      source: "observer",
      kind: "hint",
      status: "applied",
      applied_id: "h1",
      payload: { content: "check /admin" },
      evidence_refs: [],
    });
    expect(rows[1]).toMatchObject({
      kind: "intent",
      status: "pending",
      dedupe_key: "key-p2",
      applied_id: null,
    });
  });

  test("filters by status and kind", async () => {
    addProposal("p1", "hint", { content: "hint" });
    addProposal("p2", "intent", { description: "intent", from: ["origin"] });
    db.withConn((conn) =>
      recordProposalDecision(conn, projectId, "p1", {
        status: "rejected",
        reason: "evidence_required",
      }),
    );

    const pending = await get(`/projects/${projectId}/proposals?status=pending`);
    expect(((await pending.json()) as Array<Record<string, unknown>>).map((row) => row["id"])).toEqual([
      "p2",
    ]);

    const hints = await get(`/projects/${projectId}/proposals?kind=hint`);
    expect(((await hints.json()) as Array<Record<string, unknown>>).map((row) => row["id"])).toEqual([
      "p1",
    ]);

    const both = await get(`/projects/${projectId}/proposals?kind=hint&status=rejected`);
    expect(((await both.json()) as Array<Record<string, unknown>>).map((row) => row["id"])).toEqual([
      "p1",
    ]);
  });

  test("validates filters and project existence", async () => {
    expect((await get(`/projects/${projectId}/proposals?status=unknown`)).status).toBe(400);
    expect((await get(`/projects/${projectId}/proposals?kind=goal`)).status).toBe(400);
    expect((await get(`/projects/p-missing/proposals`)).status).toBe(404);
  });

  test("has no write route", async () => {
    const response = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/proposals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "hint", content: "forged" }),
      }),
    );
    expect(response.status).toBe(405);
    expect(db.withConn((conn) => conn.query("SELECT COUNT(*) AS n FROM proposals").get())).toEqual({
      n: 0,
    });
  });
});
