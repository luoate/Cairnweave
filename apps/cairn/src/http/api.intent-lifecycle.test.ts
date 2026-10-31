import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  heartbeatIntent,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;
let intentId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-intents-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "lifecycle",
        origin: "origin fact",
        goal: "goal fact",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
  intentId = db.withConn(
    (conn) =>
      createIntent(conn, projectId, {
        from: ["origin"],
        description: "check the admin panel",
        creator: "tester",
        worker: null,
      }).id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function abandon(
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
  target = intentId,
  useApi: Api = api,
): Promise<Response> {
  return useApi.handle(
    new Request(`http://cairn.test/projects/${id}/intents/${target}/abandon`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function lifecycle(id = projectId, useApi: Api = api): Promise<Response> {
  return useApi.handle(
    new Request(`http://cairn.test/projects/${id}/intents/lifecycle`),
  );
}

describe("POST /projects/{id}/intents/{intent_id}/abandon", () => {
  test("retires an open intent and exposes it through the lifecycle view", async () => {
    const response = await abandon(projectId, { reason: "  two attempts produced nothing  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      intent_id: intentId,
      status: "abandoned",
      status_reason: "two attempts produced nothing",
      status_at: expect.any(String),
      status_by: "operator",
    });

    const list = await lifecycle();
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      project_id: projectId,
      intents: [
        {
          intent_id: intentId,
          status: "abandoned",
          status_reason: "two attempts produced nothing",
          status_at: expect.any(String),
          status_by: "operator",
        },
      ],
    });
  });

  test("is idempotent and keeps the first reason", async () => {
    await abandon(projectId, { reason: "first reason" });
    const second = await abandon(projectId, { reason: "second reason" });

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "abandoned",
      status_reason: "first reason",
    });
  });

  test("rejects cross-origin writes, bad bodies and unknown targets", async () => {
    const crossOrigin = await abandon(
      projectId,
      { reason: "x" },
      { origin: "http://evil.test" },
    );
    expect(crossOrigin.status).toBe(403);

    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(501) }, { reason: 7 }]) {
      expect((await abandon(projectId, body)).status).toBe(400);
    }

    const missingIntent = await abandon(projectId, { reason: "x" }, {}, "i999");
    expect(missingIntent.status).toBe(404);
    const missingProject = await abandon("proj_missing", { reason: "x" });
    expect(missingProject.status).toBe(404);
    expect((await lifecycle("proj_missing")).status).toBe(404);
  });

  test("refuses the bootstrap intent, claimed intents and concluded intents", async () => {
    const bootstrapId = db.withConn(
      (conn) =>
        createIntent(conn, projectId, {
          from: ["origin"],
          description: "bootstrap",
          creator: "dispatcher.bootstrap",
          worker: null,
        }).id,
    );
    expect((await abandon(projectId, { reason: "x" }, {}, bootstrapId)).status).toBe(409);

    db.withConn((conn) => heartbeatIntent(conn, projectId, intentId, "cairn-worker"));
    expect((await abandon(projectId, { reason: "x" })).status).toBe(409);

    const secondId = db.withConn(
      (conn) =>
        createIntent(conn, projectId, {
          from: ["origin"],
          description: "concluded direction",
          creator: "tester",
          worker: null,
        }).id,
    );
    db.withConn((conn) => {
      heartbeatIntent(conn, projectId, secondId, "cairn-worker");
      concludeIntent(conn, projectId, secondId, "cairn-worker", "it worked");
    });
    expect((await abandon(projectId, { reason: "x" }, {}, secondId)).status).toBe(409);
  });

  test("honors the operator token when configured", async () => {
    const guarded = createApi({ db, operatorToken: "secret" });
    expect((await abandon(projectId, { reason: "x" }, {}, intentId, guarded)).status).toBe(
      401,
    );
    expect(
      (
        await abandon(
          projectId,
          { reason: "x" },
          { "x-cairn-operator-token": "wrong" },
          intentId,
          guarded,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await abandon(
          projectId,
          { reason: "x" },
          { "x-cairn-operator-token": "secret" },
          intentId,
          guarded,
        )
      ).status,
    ).toBe(200);
  });
});

describe("GET /projects/{id}/intents/lifecycle", () => {
  test("returns only non-open intents and stays read-only", async () => {
    expect(await (await lifecycle()).json()).toEqual({
      project_id: projectId,
      intents: [],
    });

    const write = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/intents/lifecycle`, {
        method: "POST",
      }),
    );
    expect(write.status).toBe(405);
  });
});
