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
import {
  findFlags,
  scanProjectFlag,
  scanSolverSessionFlags,
  type ProjectFlagResult,
} from "./project-flag";

const FIXTURE_FLAG = "CTF2{fixture_flag_value}";
const SECOND_FLAG = "flag{secondary_fixture}";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;
let workspaceRoot: string;
let artifacts: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-flag-"));
  db = configureDatabase(join(directory, "cairn.db"));
  workspaceRoot = join(directory, "projects");
  api = createApi({ db, workspaceRoot });
  const created = db.withConn((conn) =>
    createProject(conn, {
      title: "flag",
      origin: "origin",
      goal: "goal",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
  projectId = created.project.id;
  artifacts = join(workspaceRoot, projectId, "artifacts");
  mkdirSync(artifacts, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function get(path: string): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function record(): void {
  db.withConn((conn) =>
    recordProjectArtifacts(conn, {
      projectId,
      taskId: "explore-000000000000",
      workspace: join(workspaceRoot, projectId),
    }),
  );
}

describe("GET /projects/{id}/flag", () => {
  test("returns the captured flag with its source artifact", async () => {
    writeFileSync(join(artifacts, "findings.md"), `# results\n\n${FIXTURE_FLAG}\n`, "utf8");
    record();

    const response = await get(`/projects/${projectId}/flag`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProjectFlagResult & {
      verification: { policy: { kind: string }; latest: unknown };
    };
    expect(body).toMatchObject({
      found: true,
      flag: FIXTURE_FLAG,
      source: "findings.md",
      occurrences: 1,
      sources: ["findings.md"],
      scanned_files: 1,
      truncated: false,
    });
    expect(body.verification.policy.kind).toBe("evidence");
    expect(body.verification.latest).toBeNull();
  });

  test("ignores placeholders and prefers a flag seen in more files", async () => {
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify({ flag: "CTF2{...}", note: "flag{placeholder}" }),
      "utf8",
    );
    writeFileSync(join(artifacts, "one.txt"), `token ${SECOND_FLAG}\n`, "utf8");
    writeFileSync(join(artifacts, "two.txt"), `token ${SECOND_FLAG}\n`, "utf8");
    record();

    const body = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(body.flag).toBe(SECOND_FLAG);
    expect(body.occurrences).toBe(2);
    expect(body.sources).toEqual(["one.txt", "two.txt"]);
  });

  test("skips binary and oversized artifacts", async () => {
    writeFileSync(join(artifacts, "blob.bin"), Buffer.from(`\0\0${FIXTURE_FLAG}\0`, "utf8"));
    writeFileSync(
      join(artifacts, "huge.log"),
      `${"x".repeat(300 * 1024)} ${SECOND_FLAG}\n`,
      "utf8",
    );
    record();

    const body = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(body.found).toBe(false);
    expect(body.scanned_files).toBe(0);
  });

  test("never follows indexed paths outside the artifacts directory", async () => {
    writeFileSync(join(workspaceRoot, projectId, "outside.txt"), `${FIXTURE_FLAG}\n`, "utf8");
    db.withConn((conn) =>
      conn
        .query(
          `INSERT INTO project_artifacts (project_id, path, task_id, size, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(projectId, "../outside.txt", "explore-000000000000", 10, "x", new Date().toISOString()),
    );

    const body = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(body.found).toBe(false);
    expect(body.scanned_files).toBe(0);
  });

  test("returns not-found when there is no scheduler workspace", async () => {
    const httpOnly = createApi({ db });
    const response = await httpOnly.handle(
      new Request(`http://cairn.test/projects/${projectId}/flag`),
    );
    const body = (await response.json()) as ProjectFlagResult & {
      verification: { policy: { kind: string } };
    };
    expect(body).toMatchObject({
      found: false,
      flag: null,
      source: null,
      occurrences: 0,
      sources: [],
      scanned_files: 0,
      truncated: false,
    });
    expect(body.verification.policy.kind).toBe("evidence");
  });

  test("404s for an unknown project", async () => {
    const response = await get("/projects/nope/flag");
    expect(response.status).toBe(404);
  });

  test("falls back to solver-session logs when artifacts only hold redacted placeholders", async () => {
    writeFileSync(join(artifacts, "findings.md"), "captured CTF2{[REDACTED]}\n", "utf8");
    record();
    writeSession("explore-111111111111", "session.jsonl", FIXTURE_FLAG);

    const body = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(body).toMatchObject({
      found: true,
      flag: FIXTURE_FLAG,
      source: ".cairn/sessions/explore-111111111111/solver-session/session.jsonl",
      occurrences: 1,
      sources: [".cairn/sessions/explore-111111111111/solver-session/session.jsonl"],
      scanned_files: 2,
      truncated: false,
    });
  });

  test("prefers a real artifact flag over session logs", async () => {
    writeFileSync(join(artifacts, "findings.md"), `${FIXTURE_FLAG}\n`, "utf8");
    record();
    writeSession("explore-222222222222", "session.jsonl", SECOND_FLAG);

    const body = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(body.flag).toBe(FIXTURE_FLAG);
    expect(body.source).toBe("findings.md");
    expect(body.scanned_files).toBe(1);
  });

  test("reports not-found when redacted artifacts have no session logs", async () => {
    writeFileSync(join(artifacts, "findings.md"), "CTF2{[REDACTED]}\n", "utf8");
    record();

    const body = (await (await get(`/projects/${projectId}/flag`)).json()) as ProjectFlagResult;
    expect(body.found).toBe(false);
    expect(body.flag).toBeNull();
  });
});

function writeSession(taskId: string, name: string, content: string): void {
  const directory = join(workspaceRoot, projectId, ".cairn", "sessions", taskId, "solver-session");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, name), `${JSON.stringify({ output: content })}\n`, "utf8");
}

describe("findFlags", () => {
  test("accepts common CTF prefixes and ignores unrelated braces", () => {
    expect(findFlags(`a ${FIXTURE_FLAG} b picoCTF{ok_value} c flag{also_ok}`)).toEqual([
      FIXTURE_FLAG,
      "picoCTF{ok_value}",
      "flag{also_ok}",
    ]);
    expect(findFlags("const obj = { value: 1 }; function f{}")).toEqual([]);
  });

  test("rejects placeholder bodies", () => {
    for (const placeholder of [
      "CTF2{...}",
      "flag{....}",
      "flag{xxxx}",
      "flag{<value>}",
      "flag{flag_here}",
      "flag{redacted}",
      "CTF2{[REDACTED]}",
      "flag{masked_value}",
      "flag{[hidden]}",
      "flag{[REDACTED]}",
    ]) {
      expect(findFlags(placeholder)).toEqual([]);
    }
  });

  test("does not truncate long session lines", () => {
    const padding = "a".repeat(20 * 1024);
    expect(findFlags(`${padding} ${FIXTURE_FLAG}`, 64 * 1024)).toEqual([FIXTURE_FLAG]);
  });
});

describe("scanSolverSessionFlags", () => {
  test("returns not-found without a sessions directory", () => {
    const result = scanSolverSessionFlags({ workspace: join(workspaceRoot, projectId) });
    expect(result.found).toBe(false);
    expect(result.scanned_files).toBe(0);
  });

  test("picks the real flag over redacted placeholders across sessions", () => {
    writeSession("explore-333333333333", "a.jsonl", "CTF2{[REDACTED]}");
    writeSession("explore-444444444444", "b.jsonl", FIXTURE_FLAG);

    const result = scanSolverSessionFlags({ workspace: join(workspaceRoot, projectId) });
    expect(result.found).toBe(true);
    expect(result.flag).toBe(FIXTURE_FLAG);
    expect(result.scanned_files).toBe(2);
  });

  test("ignores missing and binary session files", () => {
    const directory = join(
      workspaceRoot,
      projectId,
      ".cairn",
      "sessions",
      "explore-555555555555",
    );
    mkdirSync(join(directory, "solver-session"), { recursive: true });
    writeFileSync(
      join(directory, "solver-session", "blob.jsonl"),
      Buffer.from(`\0${FIXTURE_FLAG}\0`, "utf8"),
    );

    const result = scanSolverSessionFlags({ workspace: join(workspaceRoot, projectId) });
    expect(result.found).toBe(false);
    expect(result.scanned_files).toBe(0);
  });
});

describe("scanProjectFlag limits", () => {
  test("reports truncation when the file cap is reached", () => {
    writeFileSync(join(artifacts, "a.txt"), FIXTURE_FLAG, "utf8");
    writeFileSync(join(artifacts, "b.txt"), SECOND_FLAG, "utf8");
    record();

    const result = scanProjectFlag({
      workspace: join(workspaceRoot, projectId),
      artifacts: [
        { path: "a.txt", size: 1 },
        { path: "b.txt", size: 1 },
      ],
      maxFiles: 1,
    });
    expect(result.found).toBe(true);
    expect(result.flag).toBe(FIXTURE_FLAG);
    expect(result.scanned_files).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
