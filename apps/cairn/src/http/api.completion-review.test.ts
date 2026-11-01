import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectDetail,
  recordCompletionReview,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-completion-review-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db });
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "completion review",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
        verification: { kind: "off" },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function capture(description = "the goal looks done", fromFacts = ["origin"]): number {
  return db.withConn(
    (conn) =>
      recordCompletionReview(conn, projectId, {
        runId: "run_0001",
        taskId: "task_0001",
        kind: "reason",
        description,
        fromFacts,
      }).review.id,
  );
}

function status(): string {
  return db.withConn((conn) => getProjectDetail(conn, projectId)).project.status;
}

function hints(): string[] {
  return db.withConn((conn) => getProjectDetail(conn, projectId).hints).map(
    (hint) => hint.content,
  );
}

describe("completion review API", () => {
  test("exposes the pending review on the project detail and its own route", async () => {
    const id = capture();

    const detail = (await (await get(`/projects/${projectId}`)).json()) as {
      completion_review: {
        pending: { id: number; status: string } | null;
        history: unknown[];
      };
    };
    expect(detail.completion_review).toMatchObject({
      pending: { id, status: "pending" },
      history: [],
    });

    const response = await get(`/projects/${projectId}/completion-review`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail.completion_review);
  });

  test("approve completes the project with the recorded sources", async () => {
    const id = capture("verified manually", ["origin"]);

    const response = await post(
      `/projects/${projectId}/completion-review/${id}/decision`,
      { decision: "approve", note: "checked by hand" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      review: { status: string; note: string };
      project: { status: string };
      completion_review: { pending: unknown; history: unknown[] };
    };
    expect(body.review).toMatchObject({ status: "approved", note: "checked by hand" });
    expect(body.project.status).toBe("completed");
    expect(body.completion_review.pending).toBeNull();
    expect(body.completion_review.history).toHaveLength(1);

    const detail = db.withConn((conn) => getProjectDetail(conn, projectId));
    expect(detail.project.status).toBe("completed");
    expect(
      detail.intents.filter((intent) => intent.to === "goal"),
    ).toMatchObject([
      {
        from: ["origin"],
        description: "verified manually",
        worker: "operator",
      },
    ]);
  });

  test("reject keeps the project active and records a hint", async () => {
    const id = capture();

    const response = await post(
      `/projects/${projectId}/completion-review/${id}/decision`,
      { decision: "reject", note: "flag still missing" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      review: { status: string; note: string };
      completion_review: { pending: unknown; history: unknown[] };
    };
    expect(body.review).toMatchObject({ status: "rejected", note: "flag still missing" });
    expect(body.completion_review.pending).toBeNull();
    expect(status()).toBe("active");
    expect(hints()).toEqual(["操作员拒绝完成声明，请继续探索。"]);
  });

  test("a second decision conflicts and an empty-source approval is refused", async () => {
    const id = capture();
    expect(
      (
        await post(`/projects/${projectId}/completion-review/${id}/decision`, {
          decision: "reject",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(`/projects/${projectId}/completion-review/${id}/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(409);

    const empty = db.withConn((conn) => {
      const review = recordCompletionReview(conn, projectId, {
        kind: "reason",
        description: "no sources",
        fromFacts: ["origin"],
      }).review;
      conn
        .query("UPDATE completion_reviews SET from_facts = '[]' WHERE id = ?")
        .run(review.id);
      return review.id;
    });
    expect(
      (
        await post(`/projects/${projectId}/completion-review/${empty}/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(409);
    expect(status()).toBe("active");
  });

  test("validates the review id, body and project", async () => {
    const id = capture();
    expect(
      (
        await post(`/projects/${projectId}/completion-review/abc/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/projects/${projectId}/completion-review/${id}/decision`, {
          decision: "maybe",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/projects/${projectId}/completion-review/999/decision`, {
          decision: "approve",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post("/projects/proj_999/completion-review/1/decision", {
          decision: "approve",
        })
      ).status,
    ).toBe(404);
  });

  test("rejects cross-origin writes and requires the operator token when configured", async () => {
    const id = capture();
    const guarded = createApi({ db, operatorToken: "secret-token" });
    const path = `/projects/${projectId}/completion-review/${id}/decision`;

    const crossOrigin = await guarded.handle(
      new Request(`http://cairn.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.test",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const missing = await guarded.handle(
      new Request(`http://cairn.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
    );
    expect(missing.status).toBe(401);

    const allowed = await guarded.handle(
      new Request(`http://cairn.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-cairn-operator-token": "secret-token",
        },
        body: JSON.stringify({ decision: "reject" }),
      }),
    );
    expect(allowed.status).toBe(200);
  });
});
