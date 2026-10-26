import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUDIT_STREAM_LOST_FILE,
  AuditStreamSender,
  type AuditStreamSenderOptions,
} from "./audit-stream";
import { HostBridge } from "./bridge";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  events: Array<{ seq: number; event: unknown }>;
}

type Responder = (
  request: CapturedRequest,
  index: number,
) => Response | Promise<Response>;

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "cairn-audit-stream-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

function recorder(responder: Responder = () => new Response("{}", { status: 200 })) {
  const requests: CapturedRequest[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      events: Array<{ seq: number; event: unknown }>;
    };
    const request = { url, headers, events: body.events };
    requests.push(request);
    return responder(request, requests.length - 1);
  };
  return { requests, fetchFn };
}

function makeSender(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  overrides: Partial<AuditStreamSenderOptions> = {},
): AuditStreamSender {
  return new AuditStreamSender({
    url: "http://127.0.0.1:8000/",
    token: "cairn_audit_test",
    projectId: "proj-1",
    taskId: "explore-aaaaaaaaaaaa",
    sessionDir,
    retryDelayMs: 1,
    ...overrides,
    fetch: fetchFn,
  });
}

function marker(): Record<string, unknown> | null {
  try {
    return JSON.parse(
      readFileSync(join(sessionDir, AUDIT_STREAM_LOST_FILE), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe("audit stream sender", () => {
  test("posts ordered batches with the task token and drains on close", async () => {
    const { requests, fetchFn } = recorder();
    const sender = makeSender(fetchFn, { batchSize: 2 });

    for (const tool of ["read", "grep", "write", "bash", "fetch"]) {
      sender.enqueue({ tool });
    }
    await sender.close();

    const sent = requests.flatMap((request) =>
      request.events.map((entry) => entry.seq),
    );
    expect(sent).toEqual([1, 2, 3, 4, 5]);
    expect(requests[0]!.events[0]!.event).toEqual({ tool: "read" });
    for (const request of requests) {
      expect(request.events.length).toBeLessThanOrEqual(2);
    }
    expect(requests[0]!.url).toBe(
      "http://127.0.0.1:8000/projects/proj-1/tasks/explore-aaaaaaaaaaaa/audit",
    );
    expect(requests[0]!.headers["authorization"]).toBe("Bearer cairn_audit_test");
    expect(marker()).toBeNull();
  });

  test("retries transient failures without skipping a sequence", async () => {
    const { requests, fetchFn } = recorder((_request, index) =>
      index < 2 ? new Response("busy", { status: 503 }) : new Response("{}", { status: 200 }),
    );
    const sender = makeSender(fetchFn, { retryBudgetMs: 1_000 });

    sender.enqueue({ tool: "read" });
    sender.enqueue({ tool: "bash" });
    await sender.close();

    // The first batch is retried verbatim; the second event follows only after it lands.
    expect(requests.map((request) => request.events.map((entry) => entry.seq))).toEqual([
      [1],
      [1],
      [1],
      [2],
    ]);
    expect(sender.isStopped).toBe(false);
    expect(marker()).toBeNull();
  });

  test("stops on a rejected chain and leaves the rest to the file import", async () => {
    const { requests, fetchFn } = recorder(() => new Response("conflict", { status: 409 }));
    const sender = makeSender(fetchFn, { batchSize: 1 });

    sender.enqueue({ tool: "read" });
    sender.enqueue({ tool: "bash" });
    await sender.close();

    expect(requests).toHaveLength(1);
    sender.enqueue({ tool: "write" });
    await Bun.sleep(5);
    expect(requests).toHaveLength(1);
    expect(sender.isStopped).toBe(true);
    expect(marker()).toMatchObject({ reason: "rejected with status 409", delivered: 0 });
    expect(marker()).toMatchObject({ pending: 2 });
  });

  test("does not skip ahead after a queue overflow", async () => {
    const { requests, fetchFn } = recorder();
    const sender = makeSender(fetchFn, { maxQueue: 2, batchSize: 1 });

    sender.enqueue({ tool: "read" });
    sender.enqueue({ tool: "grep" });
    sender.enqueue({ tool: "bash" });
    await sender.close();

    expect(sender.isStopped).toBe(true);
    expect(requests.flatMap((request) => request.events.map((entry) => entry.seq))).not.toContain(
      3,
    );
    expect(marker()).toMatchObject({ reason: "queue overflow" });
  });

  test("the bridge forwards exactly the entry it wrote locally", async () => {
    const { requests, fetchFn } = recorder();
    const bridge = new HostBridge({
      projectId: "proj-1",
      taskId: "explore-aaaaaaaaaaaa",
      workspace: sessionDir,
      sessionDir,
      scopeTargets: ["127.0.0.1:8080"],
      auditStream: {
        url: "http://127.0.0.1:8000",
        token: "cairn_audit_test",
        fetch: fetchFn,
      },
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const decision = bridge.checkToolCall("bash", {
      command: "curl http://127.0.0.1:8080/health",
    });
    expect(decision.allowed).toBe(true);
    await bridge.flushAuditStream();

    const local = JSON.parse(
      readFileSync(join(sessionDir, "audit.jsonl"), "utf8").trim(),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]!.events).toEqual([{ seq: 1, event: local }]);
    expect(requests[0]!.headers["authorization"]).toBe("Bearer cairn_audit_test");
  });

  test("marks a stuck flush instead of blocking the worker", async () => {
    let release: (() => void) | null = null;
    const stuck = new Promise<Response>((resolve) => {
      release = () => resolve(new Response("{}", { status: 200 }));
    });
    const sender = makeSender(() => stuck, { closeTimeoutMs: 20 });

    sender.enqueue({ tool: "read" });
    await sender.close();

    expect(sender.isStopped).toBe(true);
    expect(marker()).toMatchObject({ reason: "flush timeout", pending: 1 });
    release!();
  });
});
