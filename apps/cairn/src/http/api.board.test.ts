import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, createProject, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";
import { readProjectBoard } from "./project-board";

let directory: string;
let workspaceRoot: string;
let workspace: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-board-"));
  workspaceRoot = join(directory, "workspace");
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, workspaceRoot });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "board",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
  workspace = join(workspaceRoot, projectId);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function boardDir(): string {
  return join(workspace, ".cairn", "board", "board");
}

function seedIdea(item: Record<string, unknown>): void {
  mkdirSync(join(boardDir(), "ideas"), { recursive: true });
  const path = join(boardDir(), "ideas", "index.json");
  let items: unknown[] = [];
  try {
    const existing = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown[] };
    items = Array.isArray(existing.items) ? existing.items : [];
  } catch {
    items = [];
  }
  items.push(item);
  writeFileSync(path, JSON.stringify({ challengeId: "board", updated_at: "2026-10-29T00:00:00Z", items }), "utf8");
}

function seedMemory(name: string, entry: Record<string, unknown> | string): void {
  const dir = join(boardDir(), "memory", "entries");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof entry === "string" ? entry : JSON.stringify(entry), "utf8");
}

function idea(id: string, status: string, content: string, result = ""): Record<string, unknown> {
  return {
    id,
    content,
    normalized: content.toLowerCase(),
    status,
    result,
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T01:00:00Z",
  };
}

function memory(id: string, kind: string, content: string): Record<string, unknown> {
  return {
    id,
    challengeId: "board",
    kind,
    content,
    refs: ["artifacts/scan.log"],
    source: "observer",
    created_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:00:00Z",
  };
}

describe("project board route", () => {
  test("reports a missing board without failing", async () => {
    const response = await get(`/projects/${projectId}/board`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      ideas: [],
      memory: [],
      ideas_total: 0,
      memory_total: 0,
      truncated: false,
    });
  });

  test("returns 404 for an unknown project", async () => {
    const response = await get("/projects/proj_999/board");
    expect(response.status).toBe(404);
  });

  test("returns ideas and memory with normalized status and kind", async () => {
    seedIdea(idea("idea_1", "testing", "probe /admin", "403 so far"));
    seedIdea(idea("idea_2", "bogus-status", "retry login"));
    seedMemory("1700000000000-mem_1.json", memory("mem_1", "failure", "WAF blocks union"));
    seedMemory("1700000000001-mem_2.json", memory("mem_2", "weird", "note text"));

    const response = await get(`/projects/${projectId}/board`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.available).toBe(true);
    expect(body.ideas_total).toBe(2);
    expect(body.ideas).toEqual([
      {
        id: "idea_1",
        status: "testing",
        content: "probe /admin",
        result: "403 so far",
        created_at: "2026-10-29T00:00:00Z",
        updated_at: "2026-10-29T01:00:00Z",
      },
      {
        id: "idea_2",
        status: "pending",
        content: "retry login",
        result: "",
        created_at: "2026-10-29T00:00:00Z",
        updated_at: "2026-10-29T01:00:00Z",
      },
    ]);
    expect(body.memory.map((entry: any) => [entry.id, entry.kind])).toEqual([
      ["mem_1", "failure"],
      ["mem_2", "note"],
    ]);
    expect(body.memory[0].refs).toEqual(["artifacts/scan.log"]);
    expect(body.truncated).toBe(false);
  });

  test("skips malformed entries and caps the idea list", async () => {
    for (let index = 0; index < 201; index += 1) {
      seedIdea(idea(`idea_${index}`, "pending", `idea ${index}`));
    }
    mkdirSync(join(boardDir(), "memory", "entries"), { recursive: true });
    writeFileSync(join(boardDir(), "memory", "entries", "broken.json"), "{not json", "utf8");
    seedMemory("1700000000002-good.json", memory("mem_good", "note", "usable"));

    const board = readProjectBoard({ workspace });
    expect(board.available).toBe(true);
    expect(board.ideas.length).toBe(200);
    expect(board.ideas_total).toBe(201);
    expect(board.memory.map((entry) => entry.id)).toEqual(["mem_good"]);
    expect(board.truncated).toBe(true);
  });

  test("rejects a board directory that is a symlink outside the workspace", () => {
    const outside = join(directory, "outside-board");
    mkdirSync(join(outside, "board"), { recursive: true });
    mkdirSync(join(workspace, ".cairn"), { recursive: true });
    try {
      symlinkSync(outside, join(workspace, ".cairn", "board"), "junction");
    } catch {
      return; // Symlinks may require privileges on Windows; the lstat check is the same.
    }
    expect(readProjectBoard({ workspace })).toEqual({
      available: false,
      ideas: [],
      memory: [],
      ideas_total: 0,
      memory_total: 0,
      truncated: false,
    });
  });

  test("rejects a symlinked memory entry", () => {
    const outside = join(directory, "outside.json");
    writeFileSync(outside, JSON.stringify(memory("mem_outside", "note", "secret")), "utf8");
    seedMemory("1700000000003-link.json", memory("mem_real", "note", "real"));
    rmSync(join(boardDir(), "memory", "entries", "1700000000003-link.json"));
    try {
      symlinkSync(outside, join(boardDir(), "memory", "entries", "1700000000003-link.json"), "file");
    } catch {
      return;
    }
    const board = readProjectBoard({ workspace });
    expect(board.memory).toEqual([]);
    expect(board.truncated).toBe(true);
  });

  test("pure HTTP mode reports no board", async () => {
    const httpOnly = createApi({ db });
    const response = await httpOnly.handle(new Request(`http://cairn.test/projects/${projectId}/board`));
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)["available"]).toBe(false);
  });
});
