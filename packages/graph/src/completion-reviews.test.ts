import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  closePendingCompletionReviews,
  completeProject,
  configureDatabase,
  createProject,
  decideCompletionReview,
  getCompletionReview,
  getPendingCompletionReview,
  listCompletionReviews,
  recordCompletionReview,
  summarizeCompletionReviews,
  type CairnDatabase,
} from "./index";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-completion-reviews-"));
  db = configureDatabase(join(directory, "cairn.db"));
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

function capture(description = "the goal looks done", fromFacts = ["origin"]) {
  return db.withConn((conn) =>
    recordCompletionReview(conn, projectId, {
      runId: "run_0001",
      taskId: "task_0001",
      kind: "reason",
      description,
      fromFacts,
    }),
  );
}

describe("completion review storage", () => {
  test("records a pending claim with its source facts", () => {
    const { review, created } = capture("  the goal looks done  ");

    expect(created).toBe(true);
    expect(review).toMatchObject({
      project_id: projectId,
      run_id: "run_0001",
      task_id: "task_0001",
      kind: "reason",
      description: "the goal looks done",
      from_facts: ["origin"],
      status: "pending",
      note: null,
      decided_at: null,
    });
    expect(
      db.withConn((conn) => getPendingCompletionReview(conn, projectId)),
    ).toEqual(review);
  });

  test("a repeated claim refreshes one pending row", () => {
    const first = capture("first claim", ["origin"]);

    const second = db.withConn((conn) =>
      recordCompletionReview(conn, projectId, {
        runId: "run_0002",
        taskId: "task_0002",
        kind: "bootstrap",
        description: "second claim",
        fromFacts: ["goal"],
      }),
    );

    expect(second.created).toBe(false);
    expect(second.review.id).toBe(first.review.id);
    expect(second.review).toMatchObject({
      run_id: "run_0002",
      task_id: "task_0002",
      kind: "bootstrap",
      description: "second claim",
      from_facts: ["goal"],
      created_at: first.review.created_at,
    });
    expect(
      db.withConn((conn) => listCompletionReviews(conn, projectId)),
    ).toHaveLength(1);
  });

  test("only a pending review can be decided", () => {
    const { review } = capture();

    const approved = db.withConn((conn) =>
      decideCompletionReview(conn, projectId, review.id, "approve", "verified"),
    );
    expect(approved).toMatchObject({
      status: "approved",
      note: "verified",
    });
    expect(approved.decided_at).not.toBeNull();

    expect(() =>
      db.withConn((conn) =>
        decideCompletionReview(conn, projectId, review.id, "reject"),
      ),
    ).toThrow("already approved");
  });

  test("rejection is terminal and leaves history", () => {
    const { review } = capture();

    const rejected = db.withConn((conn) =>
      decideCompletionReview(conn, projectId, review.id, "reject", "not yet"),
    );
    expect(rejected.status).toBe("rejected");

    const summary = db.withConn((conn) =>
      summarizeCompletionReviews(conn, projectId),
    );
    expect(summary.pending).toBeNull();
    expect(summary.history).toMatchObject([
      { id: review.id, status: "rejected", note: "not yet" },
    ]);
  });

  test("a new claim can be recorded after a decision", () => {
    const first = capture("first");
    db.withConn((conn) =>
      decideCompletionReview(conn, projectId, first.review.id, "reject"),
    );

    const second = capture("second");
    expect(second.created).toBe(true);
    expect(second.review.id).not.toBe(first.review.id);
    expect(
      db.withConn((conn) => summarizeCompletionReviews(conn, projectId)).history,
    ).toHaveLength(1);
  });

  test("completing the project closes a leftover pending review", () => {
    const { review } = capture();

    db.withConn((conn) =>
      completeProject(conn, projectId, {
        from: ["origin"],
        description: "operator completed directly",
        worker: "operator",
      }),
    );

    const closed = db.withConn((conn) =>
      getCompletionReview(conn, projectId, review.id),
    );
    expect(closed.status).toBe("approved");
    expect(closed.note).toContain("without this review");
    expect(
      db.withConn((conn) => getPendingCompletionReview(conn, projectId)),
    ).toBeNull();

    expect(
      db.withConn((conn) =>
        closePendingCompletionReviews(conn, projectId, "already closed"),
      ),
    ).toBe(0);
  });

  test("rejects claims without a description or source fact", () => {
    expect(() => capture("   ")).toThrow("description");
    expect(() => capture("claim", [])).toThrow("source fact");
    expect(() => capture("claim", ["  "])).toThrow("non-empty ids");
  });

  test("404s for an unknown project or review", () => {
    expect(() =>
      db.withConn((conn) =>
        recordCompletionReview(conn, "proj_999", {
          kind: "reason",
          description: "claim",
          fromFacts: ["origin"],
        }),
      ),
    ).toThrow(HttpError);
    expect(() =>
      db.withConn((conn) => getCompletionReview(conn, projectId, 999)),
    ).toThrow("completion review not found");
  });
});
