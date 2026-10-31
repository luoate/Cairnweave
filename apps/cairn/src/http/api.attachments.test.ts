import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, createProject, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

const PAYLOAD = Buffer.from(" ELF binary challenge \0", "utf8");

let directory: string;
let workspaceRoot: string;
let workspace: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

function serve(options: {
  workspaceRoot?: string;
  operatorToken?: string;
  attachmentFileBytes?: number;
  attachmentProjectBytes?: number;
}): void {
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, ...options });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "attachments",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
  workspace = join(options.workspaceRoot ?? "", projectId);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-attachments-"));
  workspaceRoot = join(directory, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  serve({ workspaceRoot });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function send(path: string, init?: RequestInit): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`, init));
}

function upload(name: string, bytes: Uint8Array = PAYLOAD, init: RequestInit = {}): Promise<Response> {
  return send(
    `/projects/${projectId}/attachments?name=${encodeURIComponent(name)}`,
    { method: "POST", body: bytes, ...init },
  );
}

function list(): Promise<Record<string, unknown>> {
  return send(`/projects/${projectId}/attachments`).then((response) =>
    response.json() as Promise<Record<string, unknown>>,
  );
}

interface Row {
  id: number;
  project_id: string;
  name: string;
  path: string;
  size: number;
  sha256: string;
  creator: string;
  created_at: string;
}

function rows(view: Record<string, unknown>): Row[] {
  return view["attachments"] as Row[];
}

function stored(name: string): string {
  return join(workspace, "attachments", name);
}

describe("attachment upload", () => {
  test("writes the bytes into the workspace and lists them", async () => {
    const response = await upload("challenge.bin");
    expect(response.status).toBe(201);
    const view = await list();
    expect(rows(view)).toEqual([
      {
        id: expect.any(Number),
        project_id: projectId,
        name: "challenge.bin",
        path: "attachments/challenge.bin",
        size: PAYLOAD.byteLength,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        creator: "operator",
        created_at: expect.any(String),
      },
    ]);
    expect(view["total_bytes"]).toBe(PAYLOAD.byteLength);
    expect(view["available"]).toBe(true);
    expect(view["limits"]).toEqual({
      file_bytes: 32 * 1024 * 1024,
      project_bytes: 256 * 1024 * 1024,
    });
    expect(readFileSync(stored("challenge.bin"))).toEqual(PAYLOAD);
  });

  test("stores only the sanitized leaf of a client path", async () => {
    const response = await upload("..\\..\\dist\\evil.sh");
    expect(response.status).toBe(201);
    const view = await list();
    expect(rows(view)[0]!.name).toBe("evil.sh");
    expect(existsSync(join(workspace, "dist"))).toBe(false);
    expect(readFileSync(stored("evil.sh"))).toEqual(PAYLOAD);
  });

  test("replaying the same digest answers 200 without a second row", async () => {
    expect((await upload("same.bin")).status).toBe(201);
    const replay = await upload("same.bin");
    expect(replay.status).toBe(200);
    expect((await replay.json() as Record<string, unknown>)["created"]).toBe(false);
    const view = await list();
    expect(rows(view)).toHaveLength(1);
    expect(view["total_bytes"]).toBe(PAYLOAD.byteLength);
  });

  test("refuses different bytes under a used name and leaves the file untouched", async () => {
    await upload("keep.bin");
    const conflict = await upload("keep.bin", Buffer.from("replacement bytes"));
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as Record<string, unknown>)["detail"]).toMatch(
      /already holds different bytes/,
    );
    expect(readFileSync(stored("keep.bin"))).toEqual(PAYLOAD);
  });

  test("needs a name and an existing project", async () => {
    expect((await upload("")).status).toBe(400);
    expect((await upload("a.bin")).status).toBe(201);
    expect(rows(await list())).toHaveLength(1);
    const missing = await send("/projects/proj_missing/attachments?name=a.bin", {
      method: "POST",
      body: PAYLOAD,
    });
    expect(missing.status).toBe(404);
  });

  test("405s an unsupported method on the collection", async () => {
    const response = await send(`/projects/${projectId}/attachments`, { method: "PUT" });
    expect(response.status).toBe(405);
  });
});

describe("attachment download and delete", () => {
  test("serves the stored bytes with a safe filename header", async () => {
    await upload("challenge.bin");
    const id = rows(await list())[0]!.id;
    const response = await send(`/projects/${projectId}/attachments/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain('filename="challenge.bin"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PAYLOAD);
  });

  test("keeps a non-ASCII name readable through the RFC 5987 header", async () => {
    await upload("题目.bin");
    const id = rows(await list())[0]!.id;
    const response = await send(`/projects/${projectId}/attachments/${id}`);
    expect(rows(await list())[0]!.name).toBe("题目.bin");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="__.bin"; filename*=UTF-8''${encodeURIComponent("题目.bin")}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PAYLOAD);
  });

  test("removes the bytes and the row, then 404s", async () => {
    await upload("gone.bin");
    const id = rows(await list())[0]!.id;
    const response = await send(`/projects/${projectId}/attachments/${id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)["deleted"]).toMatchObject({
      name: "gone.bin",
    });
    expect(existsSync(stored("gone.bin"))).toBe(false);
    expect(rows(await list())).toEqual([]);
    expect((await send(`/projects/${projectId}/attachments/${id}`)).status).toBe(404);
    expect(
      (await send(`/projects/${projectId}/attachments/${id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("reports a missing file as a conflict instead of serving nothing", async () => {
    await upload("lost.bin");
    const id = rows(await list())[0]!.id;
    rmSync(stored("lost.bin"));
    const response = await send(`/projects/${projectId}/attachments/${id}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>)["detail"]).toMatch(
      /no longer readable/,
    );
    // Deleting cleans up the ledger even when the bytes already went away.
    expect(
      (await send(`/projects/${projectId}/attachments/${id}`, { method: "DELETE" })).status,
    ).toBe(200);
    expect(rows(await list())).toEqual([]);
  });

  test("refuses a symlinked path", async () => {
    await upload("real.bin");
    const outside = join(directory, "outside.txt");
    writeFileSync(outside, "not an attachment", "utf8");
    try {
      symlinkSync(outside, join(workspace, "attachments", "link.bin"), "file");
    } catch {
      return; // Symlinks may require privileges on Windows; the lstat check is the same.
    }
    const linked = db.withConn((conn) =>
      conn
        .query(
          `INSERT INTO project_attachments
             (project_id, name, path, size, sha256, creator, created_at)
           VALUES (?, 'link.bin', 'attachments/link.bin', 15, ?, 'operator', '2026-10-31T00:00:00Z')`,
        )
        .run(projectId, "0".repeat(64)),
    );
    const realId = rows(await list()).find((row) => row.name === "real.bin")!.id;
    expect((await send(`/projects/${projectId}/attachments/${realId}`)).status).toBe(200);
    const response = await send(
      `/projects/${projectId}/attachments/${Number(linked.lastInsertRowid)}`,
    );
    expect(response.status).toBe(409);
    expect(readFileSync(outside, "utf8")).toBe("not an attachment");
  });
});

describe("attachment limits", () => {
  test("rejects a file over the per-file cap without storing it", async () => {
    serve({ workspaceRoot, attachmentFileBytes: 8 });
    const response = await upload("big.bin");
    expect(response.status).toBe(413);
    expect(((await response.json()) as Record<string, unknown>)["detail"]).toMatch(
      /exceeds the 8-byte file limit/,
    );
    expect(rows(await list())).toEqual([]);
    expect(existsSync(stored("big.bin"))).toBe(false);
  });

  test("holds the per-project budget but never a replay", async () => {
    serve({ workspaceRoot, attachmentProjectBytes: 30 });
    expect((await upload("a.bin")).status).toBe(201);
    const over = await upload("b.bin", Buffer.from("sixteen bytes here"));
    expect(over.status).toBe(413);
    expect(((await over.json()) as Record<string, unknown>)["detail"]).toMatch(/budget/);
    expect(existsSync(stored("b.bin"))).toBe(false);
    const view = await list();
    expect(rows(view).map((row) => row.name)).toEqual(["a.bin"]);
    expect(view["total_bytes"]).toBe(PAYLOAD.byteLength);
    expect((await upload("a.bin")).status).toBe(200);
  });

  test("asks for the operator token on writes only", async () => {
    serve({ workspaceRoot, operatorToken: "operator-secret" });
    expect((await upload("a.bin")).status).toBe(401);
    const allowed = await upload("a.bin", PAYLOAD, {
      headers: { "x-cairn-operator-token": "operator-secret" },
    });
    expect(allowed.status).toBe(201);
    expect((await send(`/projects/${projectId}/attachments`)).status).toBe(200);
    const id = rows(await list())[0]!.id;
    expect(
      (await send(`/projects/${projectId}/attachments/${id}`, { method: "DELETE" })).status,
    ).toBe(401);
  });

  test("refuses a cross-origin write", async () => {
    serve({ workspaceRoot });
    const response = await upload("a.bin", PAYLOAD, { headers: { origin: "http://evil.test" } });
    expect(response.status).toBe(403);
    expect(rows(await list())).toEqual([]);
  });

  test("lists without a workspace but stores nothing", async () => {
    serve({});
    const view = await list();
    expect(view["available"]).toBe(false);
    expect(rows(view)).toEqual([]);
    const response = await send(`/projects/${projectId}/attachments?name=a.bin`, {
      method: "POST",
      body: PAYLOAD,
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>)["detail"]).toMatch(
      /workspace root is not mounted/,
    );
  });
});
