import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeProject,
  configureDatabase,
  createProject,
  getProjectDetail,
  recordFlagReview,
  recordProjectArtifacts,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";
import { clearFlagCache, type ProjectFlagResult } from "./project-flag";

const REAL_FLAG = "flag{real_value}";
const DECOY_FLAG = "CTF2{decoy_value}";

let directory: string;
let db: CairnDatabase;
let api: Api;
let workspaceRoot: string;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-flag-review-"));
  db = configureDatabase(join(directory, "cairn.db"));
  workspaceRoot = join(directory, "projects");
  api = createApi({ db, workspaceRoot });
  clearFlagCache();
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "flag review",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
        verification: { kind: "off" },
      }).project.id,
  );
  mkdirSync(join(workspaceRoot, projectId, "artifacts"), { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function capture(flag: string, factId: string | null = "origin"): number {
  return db.withConn(
    (conn) => recordFlagReview(conn, projectId, { flag, factId }).review.id,
  );
}

function decide(id: number, decision: unknown, note?: string): Promise<Response> {
  const body: Record<string, unknown> = { decision };
  if (note !== undefined) body["note"] = note;
  return post(`/projects/${projectId}/flag-reviews/${id}/decision`, body);
}

function writeArtifact(name: string, content: string): void {
  const artifacts = join(workspaceRoot, projectId, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, name), content, "utf8");
  db.withConn((conn) =>
    recordProjectArtifacts(conn, {
      projectId,
      taskId: "explore-000000000000",
      workspace: join(workspaceRoot, projectId),
    }),
  );
}

function projectStatus(): string {
  return db.withConn((conn) => getProjectDetail(conn, projectId)).project.status;
}

function hintContents(): string[] {
  return db.withConn((conn) =>
    getProjectDetail(conn, projectId).hints.map((hint) => hint.content),
  );
}

describe("flag review API", () => {
  test("exposes an empty summary on the project detail", async () => {
    const detail = (await (await get(`/projects/${projectId}`)).json()) as {
      flag_reviews: unknown;
    };
    expect(detail.flag_reviews).toEqual({
      pending: [],
      verified: [],
      rejected: [],
      counts: { pending: 0, real_more: 0, real_done: 0, fake: 0, dismissed: 0 },
    });

    const response = await get(`/projects/${projectId}/flag-reviews`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(detail.flag_reviews);
  });

  test("real_more verifies the value, adds an operator hint and resumes", async () => {
    const id = capture(REAL_FLAG);

    const pendingList = (await (await get(`/projects/${projectId}/flag-reviews`)).json()) as {
      pending: Array<{ id: number; flag: string; status: string }>;
    };
    expect(pendingList.pending).toMatchObject([{ id, flag: REAL_FLAG, status: "pending" }]);

    const response = await decide(id, "real_more", "two remain");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["review"]).toMatchObject({ status: "real_more", note: "two remain" });
    expect(body["reviews"]).toMatchObject({
      pending: [],
      verified: [REAL_FLAG],
      rejected: [],
    });
    expect(projectStatus()).toBe("active");
    expect(hintContents()).toEqual([
      `操作员确认 ${REAL_FLAG} 为真且还有其他 Flag，继续探索。`,
    ]);
  });

  test("fake records a decoy, hints against it and hides it from /flag", async () => {
    const id = capture(DECOY_FLAG);
    writeArtifact("notes.txt", `decoys: ${DECOY_FLAG}\n`);

    expect((await decide(id, "fake")).status).toBe(200);
    expect(hintContents()).toEqual([
      `操作员判定 ${DECOY_FLAG} 是假 Flag，不要把它当作有效 Flag，继续探索。`,
    ]);

    const flag = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult & {
      reviews: { rejected: string[] };
    };
    expect(flag.found).toBe(false);
    expect(flag.flag).toBeNull();
    expect(flag.reviews.rejected).toEqual([DECOY_FLAG]);
    expect(projectStatus()).toBe("active");
  });

  test("the scanner prefers an accepted flag over a decoy in the same artifact", async () => {
    const decoy = capture(DECOY_FLAG);
    const real = capture(REAL_FLAG);
    expect((await decide(decoy, "fake")).status).toBe(200);
    expect((await decide(real, "real_more")).status).toBe(200);
    writeArtifact("notes.txt", `first ${DECOY_FLAG}\nsecond ${REAL_FLAG}\n`);

    const flag = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(flag.found).toBe(true);
    expect(flag.flag).toBe(REAL_FLAG);
  });

  test("an accepted value the scanner never saw still wins /flag", async () => {
    const id = capture(REAL_FLAG);
    expect((await decide(id, "real_more")).status).toBe(200);

    const flag = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(flag).toMatchObject({
      found: true,
      flag: REAL_FLAG,
      source: "operator review",
      scanned_files: 0,
    });
  });

  test("an accepted value survives a missing workspace", async () => {
    const id = capture(REAL_FLAG);
    expect((await decide(id, "real_more")).status).toBe(200);
    rmSync(join(workspaceRoot, projectId), { recursive: true, force: true });
    clearFlagCache();

    const flag = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(flag).toMatchObject({
      found: true,
      flag: REAL_FLAG,
      source: "operator review",
      scanned_files: 0,
    });
  });

  test("an accepted value is visible without a workspace root", async () => {
    const id = capture(REAL_FLAG);
    expect((await decide(id, "real_more")).status).toBe(200);
    const bare = createApi({ db });

    const response = await bare.handle(
      new Request(`http://cairn.test/projects/${projectId}/flag`),
    );
    const flag = (await response.json()) as ProjectFlagResult;
    expect(flag).toMatchObject({
      found: true,
      flag: REAL_FLAG,
      source: "operator review",
      scanned_files: 0,
    });
  });

  test("real_done completes the project and dismisses sibling reviews", async () => {
    const id = capture(REAL_FLAG);
    capture(DECOY_FLAG);

    const response = await decide(id, "real_done");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      review: { status: string };
      dismissed: number;
    };
    expect(body.review.status).toBe("real_done");
    expect(body.dismissed).toBe(1);
    expect(projectStatus()).toBe("completed");

    const detail = db.withConn((conn) => getProjectDetail(conn, projectId));
    const completion = detail.intents.find((intent) => intent.to === "goal");
    expect(completion).toMatchObject({
      from: ["origin"],
      description: `Operator confirmed ${REAL_FLAG} and stopped the project.`,
      worker: "operator",
    });
  });

  test("real_done without a fact cannot complete", async () => {
    const id = capture(REAL_FLAG, null);

    const response = await decide(id, "real_done");
    expect(response.status).toBe(409);
    expect(projectStatus()).toBe("active");
  });

  test("real_done on an already completed project only records the verdict", async () => {
    const id = capture(REAL_FLAG);
    db.withConn((conn) =>
      completeProject(conn, projectId, {
        from: ["origin"],
        description: "worker finished on its own",
        worker: "cairn-worker",
      }),
    );

    const response = await decide(id, "real_done");
    expect(response.status).toBe(200);
    expect(projectStatus()).toBe("completed");

    const goals = db
      .withConn((conn) => getProjectDetail(conn, projectId))
      .intents.filter((intent) => intent.to === "goal");
    expect(goals).toHaveLength(1);
    expect(goals[0]?.worker).toBe("cairn-worker");

    const reviews = (await (await get(`/projects/${projectId}/flag-reviews`)).json()) as {
      verified: string[];
    };
    expect(reviews.verified).toEqual([REAL_FLAG]);
  });

  test("real_done on a completed project tolerates a review without a fact", async () => {
    const id = capture(REAL_FLAG, null);
    db.withConn((conn) =>
      completeProject(conn, projectId, {
        from: ["origin"],
        description: "worker finished on its own",
        worker: "cairn-worker",
      }),
    );

    expect((await decide(id, "real_done")).status).toBe(200);
    expect(projectStatus()).toBe("completed");
  });

  test("a verdict on a completed project does not add exploration hints", async () => {
    const id = capture(DECOY_FLAG);
    db.withConn((conn) =>
      completeProject(conn, projectId, {
        from: ["origin"],
        description: "worker finished on its own",
        worker: "cairn-worker",
      }),
    );

    expect((await decide(id, "fake")).status).toBe(200);
    expect(hintContents()).toEqual([]);
    expect(projectStatus()).toBe("completed");
  });

  test("rejects unknown reviews, invalid decisions and decided reviews", async () => {
    expect((await decide(9999, "fake")).status).toBe(404);
    expect((await decide(1, "maybe")).status).toBe(400);
    expect((await decide(1, "fake", "x".repeat(501))).status).toBe(400);

    const invalid = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/flag-reviews/abc/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "fake" }),
      }),
    );
    expect(invalid.status).toBe(400);

    const id = capture(REAL_FLAG);
    expect((await decide(id, "real_more")).status).toBe(200);
    expect((await decide(id, "fake")).status).toBe(409);
  });

  test("requires the operator token when one is configured", async () => {
    const guarded = createApi({ db, workspaceRoot, operatorToken: "op-secret" });
    const id = capture(REAL_FLAG);
    const request = (headers: Record<string, string>) =>
      guarded.handle(
        new Request(`http://cairn.test/projects/${projectId}/flag-reviews/${id}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ decision: "fake" }),
        }),
      );

    expect((await request({})).status).toBe(401);
    expect((await request({ "x-cairn-operator-token": "op-secret" })).status).toBe(200);
  });

  test("404s for an unknown project", async () => {
    expect((await get("/projects/nope/flag-reviews")).status).toBe(404);
    expect(
      (await post("/projects/nope/flag-reviews/1/decision", { decision: "fake" })).status,
    ).toBe(404);
  });
});
