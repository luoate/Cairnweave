import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  configureDatabase,
  createProject,
  decideFlagReview,
  dismissPendingFlagReviews,
  getFlagReview,
  hasPendingFlagReviews,
  listFlagReviews,
  listPendingFlagReviews,
  listRejectedFlags,
  listVerifiedFlags,
  recordFlagReview,
  summarizeFlagReviews,
  type CairnDatabase,
} from "./index";

const REAL_FLAG = "flag{real_value}";
const DECOY_FLAG = "CTF2{decoy_value}";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-flag-reviews-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "flag reviews",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function capture(flag: string, factId: string | null = "origin") {
  return db.withConn((conn) =>
    recordFlagReview(conn, projectId, { flag, factId, runId: "run_0001" }),
  );
}

function decide(id: number, decision: "real_more" | "real_done" | "fake", note?: string) {
  return db.withConn((conn) => decideFlagReview(conn, projectId, id, decision, note));
}

function statusOf(id: number): string {
  return db.withConn((conn) => getFlagReview(conn, projectId, id)).status;
}

describe("flag review storage", () => {
  test("records a pending review for a new value", () => {
    const { review, created } = capture(`  ${REAL_FLAG}  `);

    expect(created).toBe(true);
    expect(review).toMatchObject({
      project_id: projectId,
      fact_id: "origin",
      run_id: "run_0001",
      flag: REAL_FLAG,
      status: "pending",
      note: null,
      decided_at: null,
    });
    expect(statusOf(review.id)).toBe("pending");
  });

  test("never queues the same value twice, even after it was rejected", () => {
    const first = capture(DECOY_FLAG);
    decide(first.review.id, "fake");

    const second = capture(DECOY_FLAG);

    expect(second.created).toBe(false);
    expect(second.review.id).toBe(first.review.id);
    expect(statusOf(first.review.id)).toBe("fake");
    expect(hasPendingFlagReviewsForProject()).toBe(false);
  });

  test("rejects empty flags and unknown projects", () => {
    expect(() => capture("   ")).toThrow(HttpError);
    try {
      db.withConn((conn) => recordFlagReview(conn, "proj_missing", { flag: REAL_FLAG }));
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(404);
    }
  });

  test("keeps separate rows for separate values", () => {
    capture(REAL_FLAG);
    capture(DECOY_FLAG);

    const reviews = db.withConn((conn) => listFlagReviews(conn, projectId));
    expect(reviews.map((review) => review.flag).sort()).toEqual(
      [REAL_FLAG, DECOY_FLAG].sort(),
    );
    expect(hasPendingFlagReviewsForProject()).toBe(true);
  });
});

describe("flag review decisions", () => {
  test("real_more accepts the value and leaves the project runnable", () => {
    const { review } = capture(REAL_FLAG);

    const outcome = decide(review.id, "real_more", "  still two more  ");

    expect(outcome.review).toMatchObject({
      status: "real_more",
      note: "still two more",
    });
    expect(outcome.review.decided_at).not.toBeNull();
    expect(outcome.dismissed).toBe(0);
    expect(hasPendingFlagReviewsForProject()).toBe(false);
    expect(db.withConn((conn) => listVerifiedFlags(conn, projectId))).toEqual([REAL_FLAG]);
  });

  test("fake records a rejection and does not verify the value", () => {
    const { review } = capture(DECOY_FLAG);

    decide(review.id, "fake");

    expect(db.withConn((conn) => listRejectedFlags(conn, projectId))).toEqual([DECOY_FLAG]);
    expect(db.withConn((conn) => listVerifiedFlags(conn, projectId))).toEqual([]);
    expect(summary().rejected).toEqual([DECOY_FLAG]);
  });

  test("real_done dismisses sibling pending reviews", () => {
    const first = capture(REAL_FLAG);
    capture(DECOY_FLAG);

    const outcome = decide(first.review.id, "real_done");

    expect(outcome.review.status).toBe("real_done");
    expect(outcome.dismissed).toBe(1);
    expect(statusOf(first.review.id)).toBe("real_done");
    expect(summary().pending).toEqual([]);
    expect(summary().counts).toMatchObject({ real_done: 1, dismissed: 1 });
    expect(hasPendingFlagReviewsForProject()).toBe(false);
  });

  test("decisions are terminal", () => {
    const { review } = capture(REAL_FLAG);
    decide(review.id, "real_more");

    expect(() => decide(review.id, "fake")).toThrow(HttpError);
    expect(() => decide(review.id, "real_done")).toThrow(HttpError);
  });

  test("rejects an invalid decision and an unknown review", () => {
    expect(() =>
      db.withConn((conn) =>
        decideFlagReview(conn, projectId, 1, "maybe" as "fake"),
      ),
    ).toThrow(HttpError);
    expect(() => decide(9999, "fake")).toThrow(HttpError);
  });

  test("dismissPendingFlagReviews closes every pending row except the given id", () => {
    const first = capture(REAL_FLAG);
    capture(DECOY_FLAG);

    const dismissed = db.withConn((conn) =>
      dismissPendingFlagReviews(conn, projectId, first.review.id, "2026-01-02T03:04:05Z"),
    );

    expect(dismissed).toBe(1);
    expect(db.withConn((conn) => listPendingFlagReviews(conn, projectId)).map((r) => r.id)).toEqual([
      first.review.id,
    ]);
    expect(
      db.withConn((conn) => getFlagReview(conn, projectId, first.review.id)).decided_at,
    ).toBeNull();
  });
});

describe("flag review summary", () => {
  test("reports pending rows and the operator verdicts", () => {
    const pending = capture(REAL_FLAG);
    const more = capture("flag{another_real}");
    decide(more.review.id, "real_more");
    const rejected = capture(DECOY_FLAG);
    decide(rejected.review.id, "fake");

    const snapshot = summary();

    expect(snapshot.pending.map((review) => review.id)).toEqual([pending.review.id]);
    expect(snapshot.verified).toEqual(["flag{another_real}"]);
    expect(snapshot.rejected).toEqual([DECOY_FLAG]);
    expect(snapshot.counts).toEqual({
      pending: 1,
      real_more: 1,
      real_done: 0,
      fake: 1,
      dismissed: 0,
    });
  });

  test("404s for an unknown project", () => {
    expect(() => db.withConn((conn) => summarizeFlagReviews(conn, "proj_missing"))).toThrow(
      HttpError,
    );
  });
});

function hasPendingFlagReviewsForProject(): boolean {
  return db.withConn((conn) => hasPendingFlagReviews(conn, projectId));
}

function summary() {
  return db.withConn((conn) => summarizeFlagReviews(conn, projectId));
}
