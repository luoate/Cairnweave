import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, createProject, type CairnDatabase } from "@cairn/graph";

import { AuditTokenRegistry } from "../audit-stream/tokens";
import { createApi, type Api } from "./api";

const TASK_ID = "explore-aaaaaaaaaaaa";

let directory: string;
let db: CairnDatabase;
let api: Api;
let tokens: AuditTokenRegistry;
let projectId: string;
let token: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-audit-stream-"));
  db = configureDatabase(join(directory, "cairn.db"));
  tokens = new AuditTokenRegistry();
  api = createApi({ db, auditTokens: tokens });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "stream",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
  token = tokens.register(projectId, TASK_ID);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function post(
  events: unknown,
  options: { token?: string; taskId?: string; path?: string } = {},
): Promise<Response> {
  const taskId = options.taskId ?? TASK_ID;
  return api.handle(
    new Request(
      `http://cairn.test${options.path ?? `/projects/${projectId}/tasks/${taskId}/audit`}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token ?? token}`,
        },
        body: JSON.stringify({ events }),
      },
    ),
  );
}

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

describe("live audit stream route", () => {
  test("appends an authenticated batch and stays idempotent on retry", async () => {
    const events = [
      { seq: 1, event: { decision: "allow", tool: "read" } },
      { seq: 2, event: { decision: "block", tool: "bash" } },
    ];

    const first = await post(events);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ recorded: 2, duplicates: 0 });

    const retry = await post(events);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ recorded: 0, duplicates: 2 });

    const detail = await get(`/projects/${projectId}/audit/${TASK_ID}`);
    const body = (await detail.json()) as {
      chain_ok: boolean;
      events: Array<{ seq: number; event: unknown }>;
    };
    expect(body.chain_ok).toBe(true);
    expect(body.events.map((row) => row.seq)).toEqual([1, 2]);
    expect(body.events.map((row) => row.event)).toEqual([
      { decision: "allow", tool: "read" },
      { decision: "block", tool: "bash" },
    ]);
  });

  test("rejects a missing, foreign or revoked token", async () => {
    const events = [{ seq: 1, event: { tool: "read" } }];

    expect((await post(events, { token: "cairn_audit_wrong" })).status).toBe(401);
    expect((await post(events, { taskId: "explore-bbbbbbbbbbbb" })).status).toBe(401);

    const otherProject = db.withConn(
      (conn) =>
        createProject(conn, {
          title: "other",
          origin: "origin",
          goal: "goal",
          hints: null,
          bootstrap_enabled: false,
          scope: { targets: ["127.0.0.1:8080"] },
        }).project.id,
    );
    expect(
      (
        await post(events, {
          path: `/projects/${otherProject}/tasks/${TASK_ID}/audit`,
        })
      ).status,
    ).toBe(401);

    tokens.revoke(projectId, TASK_ID);
    expect((await post(events)).status).toBe(401);
  });

  test("rejects gaps and forks instead of extending the chain", async () => {
    expect(
      (
        await post([
          { seq: 1, event: { tool: "read" } },
          { seq: 2, event: { tool: "grep" } },
        ])
      ).status,
    ).toBe(200);

    const gap = await post([{ seq: 4, event: { tool: "write" } }]);
    expect(gap.status).toBe(409);

    const fork = await post([{ seq: 2, event: { tool: "bash" } }]);
    expect(fork.status).toBe(409);

    const detail = (await (
      await get(`/projects/${projectId}/audit/${TASK_ID}`)
    ).json()) as { event_count: number; chain_ok: boolean };
    expect(detail.event_count).toBe(2);
    expect(detail.chain_ok).toBe(true);
  });

  test("validates the batch envelope", async () => {
    expect((await post("not-an-array")).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post(["not-an-entry"])).status).toBe(400);
    expect((await post([{ event: { tool: "read" } }])).status).toBe(400);
    expect((await post([{ seq: 0, event: { tool: "read" } }])).status).toBe(400);
    expect((await post([{ seq: 1, event: "text" }])).status).toBe(400);
    expect(
      (await post([{ seq: 1, event: { tool: "x".repeat(20_000) } }])).status,
    ).toBe(400);

    const tooMany = Array.from({ length: 257 }, (_, index) => ({
      seq: index + 1,
      event: { tool: "read" },
    }));
    expect((await post(tooMany)).status).toBe(400);
  });

  test("aborts an oversized chunked body instead of buffering it", async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 100) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    const request = new Request(
      `http://cairn.test/projects/${projectId}/tasks/${TASK_ID}/audit`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body,
        duplex: "half",
      } as RequestInit,
    );
    const response = await api.handle(request);
    expect(response.status).toBe(413);
    // One MiB cap / 256 KiB chunks: stop at the fifth chunk, not after the whole stream.
    expect(pulls).toBeLessThan(10);
  });

  test("rejects a declared oversized body without reading it", async () => {
    let readerOpened = false;
    // A synthetic request lets us declare a Content-Length that `fetch` would normally
    // compute from the actual body; the handler must trust the early bound and stop.
    const body = {
      getReader() {
        readerOpened = true;
        throw new Error("body must not be read");
      },
    } as unknown as ReadableStream<Uint8Array>;
    const request = {
      url: `http://cairn.test/projects/${projectId}/tasks/${TASK_ID}/audit`,
      method: "POST",
      headers: new Headers({
        authorization: `Bearer ${token}`,
        "content-length": String(1024 * 1024 + 1),
      }),
      body,
    } as unknown as Request;
    const response = await api.handle(request);
    expect(response.status).toBe(413);
    expect(readerOpened).toBe(false);
  });

  test("is absent when no registry is configured", async () => {
    const plain = createApi({ db });
    const response = await plain.handle(
      new Request(`http://cairn.test/projects/${projectId}/tasks/${TASK_ID}/audit`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: [{ seq: 1, event: { tool: "read" } }] }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
