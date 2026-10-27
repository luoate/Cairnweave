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

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-supersedes-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "supersedes",
        origin: "origin fact",
        goal: "goal fact",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function addFact(description: string, supersedes: readonly string[] = []): string {
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

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

describe("GET /projects/{id}/supersedes", () => {
  test("returns an empty summary for a fresh project", async () => {
    const response = await get(`/projects/${projectId}/supersedes`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project_id: projectId,
      facts: { total: 2, current: 2, superseded: 0 },
      supersessions: [],
    });
  });

  test("returns current/superseded counts and direct edges", async () => {
    const older = addFact("service listens on port 80");
    const newer = addFact("service listens on port 8080", [older]);

    const response = await get(`/projects/${projectId}/supersedes`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project_id: projectId,
      facts: { total: 4, current: 3, superseded: 1 },
      supersessions: [
        {
          fact_id: older,
          description: "service listens on port 80",
          superseded_by: newer,
          superseded_by_description: "service listens on port 8080",
          created_at: expect.any(String),
        },
      ],
    });
  });

  test("returns 404 for an unknown project and stays read-only", async () => {
    const missing = await get("/projects/proj_missing/supersedes");
    expect(missing.status).toBe(404);

    const write = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/supersedes`, {
        method: "POST",
      }),
    );
    expect(write.status).toBe(405);
  });
});
