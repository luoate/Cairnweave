import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, createProject, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-scope-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "unscoped",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: null,
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );
}

async function listHasScope(): Promise<boolean> {
  const response = await call("GET", "/projects");
  const items = (await response.json()) as { id: string; has_scope: boolean }[];
  return items.find((item) => item.id === projectId)!.has_scope;
}

describe("project scope routes", () => {
  test("reports a missing scope without failing the read", async () => {
    const response = await call("GET", `/projects/${projectId}/scope`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scope: null });
    expect(await listHasScope()).toBe(false);
  });

  test("stores a new scope and exposes it on the list", async () => {
    const response = await call("PUT", `/projects/${projectId}/scope`, {
      targets: [" 127.0.0.1:8080 ", "https://lab.test"],
      notes: "authorized lab",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      scope: { targets: ["127.0.0.1:8080", "https://lab.test"], notes: "authorized lab" },
    });

    const read = await call("GET", `/projects/${projectId}/scope`);
    expect(await read.json()).toEqual({
      scope: { targets: ["127.0.0.1:8080", "https://lab.test"], notes: "authorized lab" },
    });
    expect(await listHasScope()).toBe(true);
  });

  test("replaces an existing scope", async () => {
    await call("PUT", `/projects/${projectId}/scope`, { targets: ["a.test"] });
    const response = await call("PUT", `/projects/${projectId}/scope`, {
      targets: ["b.test"],
    });

    expect(await response.json()).toEqual({ scope: { targets: ["b.test"] } });
  });

  test("rejects an empty target list", async () => {
    const response = await call("PUT", `/projects/${projectId}/scope`, { targets: [] });

    expect(response.status).toBe(422);
    expect(await listHasScope()).toBe(false);
  });

  test("returns 404 for an unknown project", async () => {
    const read = await call("GET", "/projects/proj_999/scope");
    expect(read.status).toBe(404);

    const write = await call("PUT", "/projects/proj_999/scope", { targets: ["a.test"] });
    expect(write.status).toBe(404);
  });
});
