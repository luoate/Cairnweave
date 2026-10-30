import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { all, configureDatabase, get, run, type CairnDatabase } from "./db";

const directories: string[] = [];

function temporaryDatabase(): { database: CairnDatabase; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "cairn-db-"));
  directories.push(directory);
  return { database: configureDatabase(join(directory, "cairn.db")), directory };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("schema", () => {
  test("creates the default settings and project counter", () => {
    const { database } = temporaryDatabase();
    const state = database.withConn((conn) => ({
      settings: get<{ intent_timeout: number; reason_timeout: number }>(
        conn,
        "SELECT intent_timeout, reason_timeout FROM settings WHERE rowid = 1",
      ),
      counter: get<{ value: number }>(
        conn,
        "SELECT value FROM counters WHERE name = 'project'",
      ),
      journal: get<{ journal_mode: string }>(conn, "PRAGMA journal_mode"),
    }));
    expect(state.settings).toEqual({ intent_timeout: 15, reason_timeout: 15 });
    expect(state.counter).toEqual({ value: 0 });
    expect(state.journal).toEqual({ journal_mode: "wal" });
  });

  test("indexes facts by project so per-project reads never scan the table", () => {
    const { database } = temporaryDatabase();
    const plans = database.withConn((conn) =>
      ["SELECT COUNT(*) FROM facts WHERE project_id = ?", "SELECT id, description FROM facts WHERE project_id = ?"]
        .map((sql) =>
          all<{ detail: string }>(conn, `EXPLAIN QUERY PLAN ${sql}`)
            .map((row) => row.detail)
            .join(" | "),
        ),
    );
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan).toContain("facts_project");
      expect(plan).toContain("SEARCH facts");
      expect(plan).not.toContain("SCAN facts");
    }
  });

  test("is idempotent and keeps existing data", () => {
    const { database, directory } = temporaryDatabase();
    database.withConn((conn) => {
      run(
        conn,
        "INSERT INTO projects (id, title, created_at) VALUES ('proj_001', 'kept', '2026-01-01T00:00:00Z')",
      );
    });
    const reopened = configureDatabase(join(directory, "cairn.db"));
    const row = reopened.withConn((conn) =>
      get<{ title: string }>(conn, "SELECT title FROM projects WHERE id = 'proj_001'"),
    );
    expect(row).toEqual({ title: "kept" });
  });
});

describe("legacy migrations", () => {
  test("adds bootstrap_enabled to a legacy projects table", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-legacy-"));
    directories.push(directory);
    const path = join(directory, "legacy.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          reason_worker TEXT,
          reason_trigger TEXT,
          reason_started_at TEXT,
          reason_last_heartbeat_at TEXT
      )
    `);
    legacy
      .query("INSERT INTO projects (id, title, created_at) VALUES (?, ?, ?)")
      .run("proj_001", "legacy", "2026-01-01T00:00:00Z");
    legacy.close();

    const database = configureDatabase(path);
    const row = database.withConn((conn) =>
      get<{ bootstrap_enabled: number }>(
        conn,
        "SELECT bootstrap_enabled FROM projects WHERE id = 'proj_001'",
      ),
    );
    expect(row).toEqual({ bootstrap_enabled: 1 });
  });

  test("adds usage columns to a legacy runs table", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-legacy-"));
    directories.push(directory);
    const path = join(directory, "legacy-runs.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          intent_id TEXT,
          worker TEXT NOT NULL,
          trigger TEXT,
          outcome TEXT,
          exit_code INTEGER,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER,
          session TEXT,
          evidence_count INTEGER NOT NULL DEFAULT 0,
          detail TEXT
      )
    `);
    legacy
      .query(
        "INSERT INTO runs (id, project_id, task_id, kind, worker, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("run_001", "proj_001", "task-1", "explore", "cairn-worker", "2026-01-01T00:00:00Z");
    legacy.close();

    const database = configureDatabase(path);
    const row = database.withConn((conn) =>
      get<{
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        total_tokens: number;
        cost_usd: number;
        model: string | null;
      }>(
        conn,
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, model FROM runs WHERE id = 'run_001'",
      ),
    );
    expect(row).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      model: null,
    });
  });

  test("adds origin_run_id to a legacy intent_meta table", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-legacy-"));
    directories.push(directory);
    const path = join(directory, "legacy-intent-meta.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE intent_meta (
          project_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          dedupe_key TEXT,
          source TEXT NOT NULL,
          proposal_id TEXT,
          priority TEXT,
          budget TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, intent_id)
      )
    `);
    legacy
      .query(
        `INSERT INTO intent_meta (project_id, intent_id, source, created_at)
         VALUES ('proj_001', 'i001', 'strategist', '2026-01-01T00:00:00Z')`,
      )
      .run();
    legacy.close();

    const database = configureDatabase(path);
    const row = database.withConn((conn) =>
      get<{ origin_run_id: string | null }>(
        conn,
        "SELECT origin_run_id FROM intent_meta WHERE project_id = 'proj_001' AND intent_id = 'i001'",
      ),
    );
    expect(row).toEqual({ origin_run_id: null });
  });

  test("adds replan columns to a legacy strategist_state table", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-legacy-"));
    directories.push(directory);
    const path = join(directory, "legacy-strategist.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE strategist_state (
          project_id TEXT PRIMARY KEY,
          last_success_at TEXT,
          last_attempt_at TEXT,
          last_failure_at TEXT,
          last_trigger TEXT,
          last_run_id TEXT,
          last_fact_count INTEGER NOT NULL DEFAULT 0,
          last_hint_count INTEGER NOT NULL DEFAULT 0,
          last_open_intent_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
      )
    `);
    legacy
      .query(
        "INSERT INTO strategist_state (project_id, updated_at) VALUES (?, ?)",
      )
      .run("proj_001", "2026-01-01T00:00:00Z");
    legacy.close();

    const database = configureDatabase(path);
    const row = database.withConn((conn) =>
      get<{
        replan_requested_at: string | null;
        replan_requested_by: string | null;
        replan_reason: string | null;
      }>(
        conn,
        "SELECT replan_requested_at, replan_requested_by, replan_reason FROM strategist_state WHERE project_id = 'proj_001'",
      ),
    );
    expect(row).toEqual({
      replan_requested_at: null,
      replan_requested_by: null,
      replan_reason: null,
    });
  });

  test("maps the intermediate bootstrap_mode column to bootstrap_enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-legacy-"));
    directories.push(directory);
    const path = join(directory, "intermediate.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          bootstrap_mode TEXT NOT NULL DEFAULT 'auto',
          created_at TEXT NOT NULL,
          reason_worker TEXT,
          reason_trigger TEXT,
          reason_started_at TEXT,
          reason_last_heartbeat_at TEXT
      )
    `);
    const insert = legacy.query(
      "INSERT INTO projects (id, title, bootstrap_mode, created_at) VALUES (?, ?, ?, ?)",
    );
    insert.run("proj_001", "disabled", "disabled", "2026-01-01T00:00:00Z");
    insert.run("proj_002", "enabled", "enabled", "2026-01-01T00:00:00Z");
    legacy.close();

    const database = configureDatabase(path);
    const rows = database.withConn((conn) =>
      conn
        .query("SELECT id, bootstrap_enabled FROM projects ORDER BY id")
        .all() as Array<{ id: string; bootstrap_enabled: number }>,
    );
    expect(rows).toEqual([
      { id: "proj_001", bootstrap_enabled: 0 },
      { id: "proj_002", bootstrap_enabled: 1 },
    ]);
  });
});

describe("connections", () => {
  test("rolls the whole callback back when it throws", () => {
    const { database } = temporaryDatabase();
    expect(() =>
      database.withConn((conn) => {
        run(
          conn,
          "INSERT INTO projects (id, title, created_at) VALUES ('proj_001', 'rolled back', '2026-01-01T00:00:00Z')",
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const count = database.withConn((conn) =>
      get<{ count: number }>(conn, "SELECT COUNT(*) AS count FROM projects"),
    );
    expect(count).toEqual({ count: 0 });
  });

  test("deletes dependent rows through foreign-key cascades", () => {
    const { database } = temporaryDatabase();
    database.withConn((conn) => {
      run(
        conn,
        "INSERT INTO projects (id, title, created_at) VALUES ('proj_001', 'cascade', '2026-01-01T00:00:00Z')",
      );
      run(
        conn,
        "INSERT INTO facts (id, project_id, description) VALUES ('origin', 'proj_001', 'start')",
      );
      run(
        conn,
        "INSERT INTO intents (id, project_id, description, creator, created_at) VALUES ('i001', 'proj_001', 'work', 'reasoner', '2026-01-01T00:00:00Z')",
      );
      run(
        conn,
        "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES ('i001', 'proj_001', 'origin')",
      );
      run(
        conn,
        "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES ('h001', 'proj_001', 'hint', 'human', '2026-01-01T00:00:00Z')",
      );
      run(
        conn,
        "INSERT INTO scoped_counters (project_id, kind, value) VALUES ('proj_001', 'fact', 1)",
      );
      run(conn, "DELETE FROM projects WHERE id = 'proj_001'");
    });

    const counts = database.withConn((conn) => ({
      facts: get<{ count: number }>(conn, "SELECT COUNT(*) AS count FROM facts"),
      intents: get<{ count: number }>(conn, "SELECT COUNT(*) AS count FROM intents"),
      sources: get<{ count: number }>(
        conn,
        "SELECT COUNT(*) AS count FROM intent_sources",
      ),
      hints: get<{ count: number }>(conn, "SELECT COUNT(*) AS count FROM hints"),
      counters: get<{ count: number }>(
        conn,
        "SELECT COUNT(*) AS count FROM scoped_counters",
      ),
    }));
    expect(counts).toEqual({
      facts: { count: 0 },
      intents: { count: 0 },
      sources: { count: 0 },
      hints: { count: 0 },
      counters: { count: 0 },
    });
  });
});
