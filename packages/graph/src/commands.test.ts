import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createIntent,
  createProject,
  getProjectScope,
  listProjects,
  parseCreateProjectRequest,
  parseProjectScopeRequest,
  renewIntentLease,
  setProjectScope,
  type CairnDatabase,
} from "./index";
import { RequestValidationError } from "./errors";
import { run } from "./db";

let directory: string;
let db: CairnDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-commands-"));
  db = configureDatabase(join(directory, "cairn.db"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const BODY = {
  title: "scope test",
  origin: "origin",
  goal: "goal",
  hints: [],
};

describe("project scope", () => {
  test("parses a scope with trimmed targets and notes", () => {
    const parsed = parseCreateProjectRequest({
      ...BODY,
      scope: { targets: [" 127.0.0.1:8080 ", "https://example.test"], notes: "lab" },
    });
    expect(parsed.scope).toEqual({
      targets: ["127.0.0.1:8080", "https://example.test"],
      notes: "lab",
    });
  });

  test("defaults to no scope", () => {
    expect(parseCreateProjectRequest(BODY).scope).toBeNull();
  });

  test("rejects an empty target list", () => {
    expect(() =>
      parseCreateProjectRequest({ ...BODY, scope: { targets: [] } }),
    ).toThrow(RequestValidationError);
  });

  test("rejects non-string targets", () => {
    expect(() =>
      parseCreateProjectRequest({ ...BODY, scope: { targets: [127] } }),
    ).toThrow(RequestValidationError);
  });

  test("parses a standalone scope request", () => {
    expect(
      parseProjectScopeRequest({ targets: [" 127.0.0.1:8080 "], notes: "lab" }),
    ).toEqual({ targets: ["127.0.0.1:8080"], notes: "lab" });
  });

  test("rejects a standalone scope request without targets", () => {
    expect(() => parseProjectScopeRequest({ notes: "lab" })).toThrow(RequestValidationError);
    expect(() => parseProjectScopeRequest({ targets: [] })).toThrow(RequestValidationError);
  });

  test("list flags which projects have an authorized scope", () => {
    const unscoped = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: null,
      }),
    );
    const scoped = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: { targets: ["a.test"] },
      }),
    );

    const summaries = db.withConn((conn) => listProjects(conn));
    const byId = new Map(summaries.map((item) => [item.id, item.has_scope]));
    expect(byId.get(unscoped.project.id)).toBe(false);
    expect(byId.get(scoped.project.id)).toBe(true);
  });

  test("round-trips through the database", () => {
    const project = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: { targets: ["10.0.0.0/24"], notes: "authorized range" },
      }),
    );
    const scope = db.withConn((conn) => getProjectScope(conn, project.project.id));
    expect(scope).toEqual({ targets: ["10.0.0.0/24"], notes: "authorized range" });
  });

  test("updates an existing scope in place", () => {
    const project = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: { targets: ["a.test"] },
      }),
    );
    db.withConn((conn) =>
      setProjectScope(conn, project.project.id, { targets: ["b.test"] }),
    );
    expect(
      db.withConn((conn) => getProjectScope(conn, project.project.id)),
    ).toEqual({ targets: ["b.test"] });
  });

  test("fails closed on a malformed stored value", () => {
    const project = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: { targets: ["a.test"] },
      }),
    );
    db.withConn((conn) => {
      run(conn, "UPDATE project_scopes SET targets = ? WHERE project_id = ?", "{}", project.project.id);
    });
    expect(db.withConn((conn) => getProjectScope(conn, project.project.id))).toBeNull();
  });
});

describe("lease renewal", () => {
  function claim(conn: Database, projectId: string): string {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe",
      creator: "tester",
      worker: null,
    });
    run(
      conn,
      "UPDATE intents SET worker = 'tester', last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE id = ?",
      intent.id,
    );
    return intent.id;
  }

  test("renews a lease owned by the caller", () => {
    const project = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: null,
      }),
    );
    const intentId = db.withConn((conn) => claim(conn, project.project.id));
    expect(
      db.withConn((conn) => renewIntentLease(conn, project.project.id, intentId, "tester")),
    ).toBe(true);
  });

  test("reports false for a lease owned by someone else", () => {
    const project = db.withConn((conn) =>
      createProject(conn, {
        ...BODY,
        bootstrap_enabled: false,
        hints: null,
        scope: null,
      }),
    );
    const intentId = db.withConn((conn) => claim(conn, project.project.id));
    expect(
      db.withConn((conn) => renewIntentLease(conn, project.project.id, intentId, "intruder")),
    ).toBe(false);
  });
});
