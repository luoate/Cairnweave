import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  recordProjectArtifacts,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;
let workspace: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-artifacts-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  const created = db.withConn((conn) =>
    createProject(conn, {
      title: "artifacts",
      origin: "origin",
      goal: "goal",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
  projectId = created.project.id;
  workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

describe("GET /projects/{id}/artifacts", () => {
  test("returns an empty list before any artifact is recorded", async () => {
    const response = await get(`/projects/${projectId}/artifacts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("returns the recorded index", async () => {
    mkdirSync(join(workspace, "artifacts", "scans"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "scans", "nmap.xml"), "<nmap/>", "utf8");
    db.withConn((conn) =>
      recordProjectArtifacts(conn, { projectId, taskId: "task-9", workspace }),
    );

    const response = await get(`/projects/${projectId}/artifacts`);
    const body = (await response.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      path: "scans/nmap.xml",
      size: 7,
      task_id: "task-9",
    });
    expect(typeof body[0]!["sha256"]).toBe("string");
  });

  test("404s for an unknown project", async () => {
    const response = await get("/projects/nope/artifacts");
    expect(response.status).toBe(404);
  });
});

