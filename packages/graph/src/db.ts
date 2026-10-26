import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Values SQLite accepts as bind parameters. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/**
 * Cairn's schema, copied verbatim from `cairn/server/db.py`. Existing databases must keep
 * working, so columns may only be added (see `ensureProjectColumns`), never renamed.
 */
export const SCHEMA = `\
CREATE TABLE IF NOT EXISTS settings (
    intent_timeout INTEGER NOT NULL DEFAULT 15,
    reason_timeout INTEGER NOT NULL DEFAULT 15
);

INSERT OR IGNORE INTO settings (rowid, intent_timeout, reason_timeout) VALUES (1, 15, 15);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    bootstrap_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    reason_worker TEXT,
    reason_trigger TEXT,
    reason_started_at TEXT,
    reason_last_heartbeat_at TEXT
);

CREATE TABLE IF NOT EXISTS facts (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS intents (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_fact_id TEXT,
    description TEXT NOT NULL,
    creator TEXT NOT NULL,
    worker TEXT,
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    concluded_at TEXT,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS intent_sources (
    intent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (intent_id, project_id, fact_id),
    FOREIGN KEY (intent_id, project_id) REFERENCES intents(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS project_scopes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    targets TEXT NOT NULL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS project_verification (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    challenge_code TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ok INTEGER NOT NULL,
    detail TEXT NOT NULL,
    challenge_code TEXT,
    flag_count INTEGER,
    flag_got_count INTEGER,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_checks_project
    ON verification_checks(project_id, checked_at);

CREATE TABLE IF NOT EXISTS project_artifacts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    task_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    detail TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS runs_project_started ON runs(project_id, started_at);

CREATE TABLE IF NOT EXISTS fact_meta (
    fact_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    evidence_status TEXT NOT NULL DEFAULT 'missing',
    created_at TEXT NOT NULL,
    PRIMARY KEY (fact_id, project_id),
    FOREIGN KEY (fact_id, project_id) REFERENCES facts(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fact_evidence (
    project_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, fact_id, path),
    FOREIGN KEY (fact_id, project_id) REFERENCES facts(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_concludes (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    session TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, intent_id)
);

-- Candidate graph changes submitted by an Observer/Strategist. The control plane reviews
-- them; workers never write this table or the graph directly.
CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT,
    run_id TEXT,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedupe_key TEXT,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    decision_reason TEXT,
    applied_id TEXT,
    created_at TEXT NOT NULL,
    reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS proposals_project_status
    ON proposals(project_id, status, created_at);

-- Sidecar metadata for accepted intents. It keeps dedupe/source/provenance out of the
-- Cairn graph and is also where Phase 2 can store priority/budget.
CREATE TABLE IF NOT EXISTS intent_meta (
    project_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    dedupe_key TEXT,
    source TEXT,
    proposal_id TEXT,
    origin_run_id TEXT,
    priority INTEGER,
    budget TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, intent_id),
    FOREIGN KEY (intent_id, project_id) REFERENCES intents(id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS intent_meta_dedupe
    ON intent_meta(project_id, dedupe_key);

-- Persistent slow-layer trigger state (M12a). The scheduler stores watermarks instead of
-- keeping them in memory so a restart does not re-run reason for an unchanged graph.
CREATE TABLE IF NOT EXISTS strategist_state (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    last_success_at TEXT,
    last_attempt_at TEXT,
    last_failure_at TEXT,
    last_trigger TEXT,
    last_run_id TEXT,
    last_fact_count INTEGER NOT NULL DEFAULT 0,
    last_hint_count INTEGER NOT NULL DEFAULT 0,
    last_open_intent_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id, seq)
);

-- One row per task whose live sender stopped before delivering everything. The finish-time
-- audit.jsonl import remains the recovery path; this only makes the loss visible.
CREATE TABLE IF NOT EXISTS audit_stream_lost (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    delivered INTEGER NOT NULL,
    pending INTEGER NOT NULL,
    reported_at TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (project_id, task_id)
);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('project', 0);

CREATE TABLE IF NOT EXISTS scoped_counters (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, kind)
);
`;

/** Same default as Cairn: `~/.local/share/cairn/cairn.db`. */
export function defaultDatabasePath(): string {
  return join(homedir(), ".local", "share", "cairn", "cairn.db");
}

/**
 * A graph database handle. Each call to `withConn` gets a fresh SQLite connection, mirroring
 * Cairn's `get_conn()`: PRAGMAs are applied per connection and the callback runs in one
 * transaction that commits on return and rolls back on throw.
 */
export class CairnDatabase {
  constructor(readonly path: string) {}

  withConn<T>(fn: (conn: Database) => T): T {
    const conn = new Database(this.path, { create: true, strict: true });
    try {
      conn.exec("PRAGMA journal_mode=WAL");
      conn.exec("PRAGMA foreign_keys=ON");
      const transaction = conn.transaction(() => fn(conn));
      return transaction();
    } finally {
      conn.close();
    }
  }
}

/** Creates the schema if needed and upgrades legacy `projects` tables in place. */
export function configureDatabase(path: string): CairnDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const database = new CairnDatabase(path);
  database.withConn((conn) => {
    conn.exec(SCHEMA);
    ensureProjectColumns(conn);
    ensureRunColumns(conn);
    ensureIntentMetaColumns(conn);
  });
  return database;
}

function ensureProjectColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(projects)").map((row) => row.name),
  );
  if (!columns.has("bootstrap_enabled")) {
    conn.exec("ALTER TABLE projects ADD COLUMN bootstrap_enabled INTEGER NOT NULL DEFAULT 1");
    if (columns.has("bootstrap_mode")) {
      conn.exec(
        "UPDATE projects SET bootstrap_enabled = CASE WHEN bootstrap_mode = 'disabled' THEN 0 ELSE 1 END",
      );
    }
  }
}

/**
 * M12b adds usage counters to `runs`. `CREATE TABLE IF NOT EXISTS` does not alter an
 * existing table, so apply the same additive migration pattern as `projects`.
 */
function ensureRunColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(runs)").map((row) => row.name),
  );
  const additions = [
    ["input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["output_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["cost_usd", "REAL NOT NULL DEFAULT 0"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      conn.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * M13b adds the producing run to intent metadata so cost attribution can walk
 * reason run → intent → fact. Existing rows stay null: provenance cannot be recovered.
 */
function ensureIntentMetaColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(intent_meta)").map((row) => row.name),
  );
  if (!columns.has("origin_run_id")) {
    conn.exec("ALTER TABLE intent_meta ADD COLUMN origin_run_id TEXT");
  }
}

export function all<T>(conn: Database, sql: string, ...params: SqlValue[]): T[] {
  return conn.query(sql).all(...params) as T[];
}

export function get<T>(conn: Database, sql: string, ...params: SqlValue[]): T | null {
  return (conn.query(sql).get(...params) ?? null) as T | null;
}

export function run(conn: Database, sql: string, ...params: SqlValue[]): void {
  conn.query(sql).run(...params);
}
