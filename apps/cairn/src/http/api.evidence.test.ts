import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const CONTENT = "probe result\n";

let directory: string;
let workspaceRoot: string;
let db: CairnDatabase;
let projectId: string;
let projectWorkspace: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-evidence-"));
  workspaceRoot = join(directory, "workspace");
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "evidence",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
  projectWorkspace = join(workspaceRoot, projectId.replaceAll("/", "-"));
  mkdirSync(join(projectWorkspace, "artifacts"), { recursive: true });
  writeFileSync(join(projectWorkspace, "artifacts", "probe.txt"), CONTENT, "utf8");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function concludeWithEvidence(): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe",
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    return concludeIntent(conn, projectId, intent.id, "cairn-worker", "found", {
      runId: "run_001",
      evidenceRefs: ["artifacts/probe.txt"],
      evidenceStatus: "provided",
      evidenceFiles: [
        {
          path: "artifacts/probe.txt",
          size: Buffer.byteLength(CONTENT),
          sha256: sha(CONTENT),
        },
      ],
    }).fact.id;
  });
}

function withWorkspace(): Api {
  return createApi({ db, workspaceRoot });
}

function get(api: Api, path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

async function firstEntry(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as Array<Record<string, unknown>>;
  return body[0]!;
}

describe("GET /projects/{id}/facts/{fact_id}/evidence", () => {
  test("verifies an unchanged evidence file", async () => {
    const factId = concludeWithEvidence();
    const response = await get(
      withWorkspace(),
      `/projects/${projectId}/facts/${factId}/evidence`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        path: "artifacts/probe.txt",
        size: Buffer.byteLength(CONTENT),
        sha256: sha(CONTENT),
        created_at: expect.any(String),
        status: "ok",
        current_size: Buffer.byteLength(CONTENT),
        current_sha256: sha(CONTENT),
      },
    ]);
  });

  test("reports a modified file with its current digest", async () => {
    const factId = concludeWithEvidence();
    writeFileSync(join(projectWorkspace, "artifacts", "probe.txt"), "tampered\n", "utf8");

    const response = await get(
      withWorkspace(),
      `/projects/${projectId}/facts/${factId}/evidence`,
    );
    expect(await firstEntry(response)).toMatchObject({
      status: "modified",
      sha256: sha(CONTENT),
      current_size: 9,
      current_sha256: sha("tampered\n"),
    });
  });

  test("reports a deleted file as missing", async () => {
    const factId = concludeWithEvidence();
    rmSync(join(projectWorkspace, "artifacts", "probe.txt"));

    const response = await get(
      withWorkspace(),
      `/projects/${projectId}/facts/${factId}/evidence`,
    );
    expect(await firstEntry(response)).toMatchObject({
      status: "missing",
      current_size: null,
      current_sha256: null,
    });
  });

  test("returns stored digests as unverified without a workspace root", async () => {
    const factId = concludeWithEvidence();
    const response = await get(
      createApi({ db }),
      `/projects/${projectId}/facts/${factId}/evidence`,
    );
    expect(await firstEntry(response)).toMatchObject({
      status: "unverified",
      sha256: sha(CONTENT),
      current_size: null,
      current_sha256: null,
    });
  });

  test("returns an empty list for a fact without evidence", async () => {
    const response = await get(
      withWorkspace(),
      `/projects/${projectId}/facts/origin/evidence`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("404s for unknown facts and projects", async () => {
    expect(
      (
        await get(
          withWorkspace(),
          `/projects/${projectId}/facts/f999/evidence`,
        )
      ).status,
    ).toBe(404);
    expect((await get(withWorkspace(), "/projects/proj_999/facts/origin/evidence")).status).toBe(
      404,
    );
  });
});
