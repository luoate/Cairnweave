import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-subgraph-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  projectId = db.withConn((conn) => {
    const project = createProject(conn, {
      title: "subgraph api",
      origin: "origin",
      goal: "goal",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    });
    const id = project.project.id;
    const first = createIntent(conn, id, {
      from: ["origin"],
      description: "first",
      creator: "cairn-worker",
      worker: null,
    });
    const conclusion = concludeIntent(conn, id, first.id, "cairn-worker", "fact one");
    createIntent(conn, id, {
      from: [conclusion.fact.id],
      description: "second",
      creator: "cairn-worker",
      worker: null,
    });
    return id;
  });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

describe("GET /projects/{id}/subgraph", () => {
  test("returns the neighbourhood as JSON by default", async () => {
    const response = await get(`/projects/${projectId}/subgraph?around=f001&depth=1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.project).toEqual({ id: projectId, title: "subgraph api" });
    expect(body.focus).toEqual({ kind: "fact", id: "f001" });
    expect(body.depth).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.counts).toEqual({ facts: 3, intents: 2 });
    expect(body.facts.map((fact: any) => fact.id)).toEqual(["origin", "goal", "f001"]);
    expect(body.intents[1]).toMatchObject({ from: ["f001"], to: null, description: "second" });
  });

  test("returns YAML when asked", async () => {
    const response = await get(
      `/projects/${projectId}/subgraph?around=f001&depth=2&format=yaml`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("slice:");
    expect(text).toContain("around: f001");
    expect(text).toContain("focus_kind: fact");
  });

  test("accepts an intent as the focus", async () => {
    const response = await get(`/projects/${projectId}/subgraph?around=i001`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.focus).toEqual({ kind: "intent", id: "i001" });
  });

  test("rejects missing or malformed parameters", async () => {
    const missing = await get(`/projects/${projectId}/subgraph`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as Record<string, unknown>)["detail"]).toContain("around");

    for (const query of ["depth=0", "depth=9", "max_facts=1", "max_intents=0", "depth=abc"]) {
      const response = await get(`/projects/${projectId}/subgraph?around=f001&${query}`);
      expect(response.status).toBe(400);
    }

    const format = await get(`/projects/${projectId}/subgraph?around=f001&format=xml`);
    expect(format.status).toBe(400);
  });

  test("returns 404 for an unknown project or node", async () => {
    expect((await get("/projects/proj_999/subgraph?around=f001")).status).toBe(404);
    expect((await get(`/projects/${projectId}/subgraph?around=f999`)).status).toBe(404);
  });

  test("is read-only", async () => {
    const response = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/subgraph?around=f001`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(405);
  });
});
