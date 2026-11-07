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

-- The primary key leads with id, so project-scoped reads and the per-project fact count
-- cannot use it; without this index every project list entry triggers a full table scan.
CREATE INDEX IF NOT EXISTS facts_project ON facts(project_id);

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

-- Operator provenance is control-plane sidecar data, never inferred from creator text.
CREATE TABLE IF NOT EXISTS operator_hint_meta (
    project_id TEXT NOT NULL,
    hint_id TEXT NOT NULL,
    planned_run_id TEXT,
    PRIMARY KEY (project_id, hint_id),
    FOREIGN KEY (hint_id, project_id) REFERENCES hints(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_scopes (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    targets TEXT NOT NULL,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS project_execution (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('local', 'container'))
);

CREATE TABLE IF NOT EXISTS project_verification (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    challenge_code TEXT,
    created_at TEXT NOT NULL
);

-- M41: ordered completion conditions. The legacy project_verification row stays as a
-- compatibility alias; projects created before this table have no rows and are read as a
-- single condition synthesized from that policy.
CREATE TABLE IF NOT EXISTS project_goal_conditions (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, ordinal)
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
    conditions TEXT NOT NULL DEFAULT '[]',
    checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS verification_checks_project
    ON verification_checks(project_id, checked_at);

-- Operator review of captured flags. A pending row pauses dispatch for the project until
-- an operator says whether the value is real (and whether more remain) or a decoy. One row
-- per project and flag value, so repeated sightings never queue a second decision.
CREATE TABLE IF NOT EXISTS flag_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    fact_id TEXT,
    run_id TEXT,
    flag TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS flag_reviews_project_flag
    ON flag_reviews(project_id, flag);

CREATE INDEX IF NOT EXISTS flag_reviews_project_status
    ON flag_reviews(project_id, status, created_at);

-- A model completion claim under verification: off is not trusted automatically. The
-- scheduler records one pending row per project and keeps the project active until an
-- operator approves or rejects it. Repeated claims update the pending row.
CREATE TABLE IF NOT EXISTS completion_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT,
    task_id TEXT,
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    from_facts TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS completion_reviews_one_pending
    ON completion_reviews(project_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS completion_reviews_project
    ON completion_reviews(project_id, created_at, id);

CREATE TABLE IF NOT EXISTS project_artifacts (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    task_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
);

-- The latest model-written writeup per project. Drafts are rendered on read from the
-- graph, so only a generated narrative needs a row here.
CREATE TABLE IF NOT EXISTS project_writeups (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    markdown TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL
);

-- Challenge files an operator uploaded for the project. Bytes live in the project workspace
-- under attachments/ so the worker can read them; this row is the ledger (name, size, digest).
CREATE TABLE IF NOT EXISTS project_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS project_attachments_project_name
    ON project_attachments(project_id, name);

CREATE INDEX IF NOT EXISTS project_attachments_project_created
    ON project_attachments(project_id, created_at, id);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    intent_id TEXT,
    worker TEXT NOT NULL,
    worker_profile TEXT,
    model TEXT,
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
    cost_usd REAL NOT NULL DEFAULT 0,
    instance_id TEXT,
    execution TEXT
);

CREATE INDEX IF NOT EXISTS runs_project_started ON runs(project_id, started_at);

-- Operational failures are not negative evidence about a target or hypothesis.
CREATE TABLE IF NOT EXISTS run_failures (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    domain TEXT NOT NULL CHECK(domain IN ('infrastructure', 'execution')),
    code TEXT NOT NULL
);

-- Project-scoped, durable dispatch circuit. No credentials or provider bodies.
CREATE TABLE IF NOT EXISTS infrastructure_faults (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    code TEXT NOT NULL,
    last_run_id TEXT,
    consecutive_failures INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('backoff', 'blocked')),
    retry_after TEXT,
    updated_at TEXT NOT NULL
);

-- M49: one latest accepted checkpoint per run, independent of session retention.
CREATE TABLE IF NOT EXISTS task_checkpoints (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL DEFAULT 0,
    payload TEXT,
    sha256 TEXT,
    accepted_at TEXT,
    termination_reason TEXT,
    scope_targets TEXT,
    experiment_plan TEXT
);

-- One row per scheduler boot. A runs row is opened at dispatch time and only closed by the
-- process that owns the task, so a restart strands rows nobody can finish. The heartbeat
-- makes process liveness visible in the database: a new boot reconciles those rows only when
-- no other instance is still beating.
CREATE TABLE IF NOT EXISTS scheduler_instances (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    stopped_at TEXT
);

-- Task-level claim ledger (M39). The scheduler's in-memory task map can only supervise the
-- processes it owns, so it cannot answer "is this intent already being worked" for a second
-- control plane, and nothing records who owned a task after a crash. A claim is active while
-- released_at IS NULL; the partial unique indexes below keep at most one active claim per
-- intent and one per project reason slot regardless of process state. instance_id has no
-- foreign key on purpose: a claim must still be readable when its instance row is gone, and
-- reap treats that as "this owner is not heartbeating".
CREATE TABLE IF NOT EXISTS task_claims (
    task_id TEXT PRIMARY KEY,
    run_id TEXT,
    instance_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT,
    kind TEXT NOT NULL,
    worker TEXT NOT NULL,
    created_at TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    released_at TEXT,
    release_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS task_claims_active_intent
    ON task_claims(project_id, intent_id)
    WHERE released_at IS NULL AND intent_id IS NOT NULL AND kind <> 'reason';

CREATE UNIQUE INDEX IF NOT EXISTS task_claims_active_reason
    ON task_claims(project_id)
    WHERE released_at IS NULL AND kind = 'reason';

CREATE INDEX IF NOT EXISTS task_claims_instance
    ON task_claims(instance_id, released_at);

CREATE TABLE IF NOT EXISTS fact_meta (
    fact_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run_id TEXT,
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    evidence_status TEXT NOT NULL DEFAULT 'missing',
    supersedes TEXT NOT NULL DEFAULT '[]',
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
    worker_profile TEXT,
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
    experiment TEXT,
    experiment_review TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    status_reason TEXT,
    status_at TEXT,
    status_by TEXT,
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
    replan_requested_at TEXT,
    replan_requested_by TEXT,
    replan_reason TEXT,
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

CREATE TABLE IF NOT EXISTS runtime_config_overrides (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO runtime_config_overrides (id, overrides, updated_at) VALUES (1, '{}', '');

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
    ensureFactMetaColumns(conn);
    ensurePendingConcludeColumns(conn);
    ensureIntentMetaColumns(conn);
    ensureStrategistColumns(conn);
    ensureVerificationCheckColumns(conn);
    if (!all<{ name: string }>(conn, "PRAGMA table_info(task_checkpoints)").some(column => column.name === "experiment_plan")) {
      conn.exec("ALTER TABLE task_checkpoints ADD COLUMN experiment_plan TEXT");
    }
  });
  return database;
}

/** M41 adds per-condition results without rewriting existing verification history. */
function ensureVerificationCheckColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(verification_checks)").map(
      (row) => row.name,
    ),
  );
  if (!columns.has("conditions")) {
    conn.exec(
      "ALTER TABLE verification_checks ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]'",
    );
  }
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
 * M12b adds usage counters, M14c the solver model and M39 the owning scheduler instance to
 * `runs`. `CREATE TABLE IF NOT EXISTS` does not alter an existing table, so apply the same
 * additive migration pattern as `projects`.
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
    ["model", "TEXT"],
    ["worker_profile", "TEXT"],
    ["instance_id", "TEXT"],
    ["execution", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      conn.exec(`ALTER TABLE runs ADD COLUMN ${name} ${definition}`);
    }
  }
}

/** M15a keeps the failed task's profile so a queued conclude reuses the same model. */
function ensurePendingConcludeColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(pending_concludes)").map(
      (row) => row.name,
    ),
  );
  if (!columns.has("worker_profile")) {
    conn.exec("ALTER TABLE pending_concludes ADD COLUMN worker_profile TEXT");
  }
}

/** M15b records which older facts a new fact replaces without touching the graph. */
function ensureFactMetaColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(fact_meta)").map((row) => row.name),
  );
  if (!columns.has("supersedes")) {
    conn.exec("ALTER TABLE fact_meta ADD COLUMN supersedes TEXT NOT NULL DEFAULT '[]'");
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
  // M37 lifecycle + M51 optional experiment plan; no inference for legacy rows.
  const additions = [
    ["experiment", "TEXT"],
    ["experiment_review", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'open'"],
    ["status_reason", "TEXT"],
    ["status_at", "TEXT"],
    ["status_by", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      conn.exec(`ALTER TABLE intent_meta ADD COLUMN ${name} ${definition}`);
    }
  }
}

/**
 * M14b adds the operator-requested replan marker. It lives beside the trigger watermarks
 * so a request survives a control-plane restart and is cleared by the next reason outcome.
 */
function ensureStrategistColumns(conn: Database): void {
  const columns = new Set(
    all<{ name: string }>(conn, "PRAGMA table_info(strategist_state)").map((row) => row.name),
  );
  const additions = [
    ["replan_requested_at", "TEXT"],
    ["replan_requested_by", "TEXT"],
    ["replan_reason", "TEXT"],
    // M57c: distinguishes a deterministic payload-contract failure (short backoff) from
    // an execution failure (full backoff) without re-reading the run ledger.
    ["last_failure_code", "TEXT"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      conn.exec(`ALTER TABLE strategist_state ADD COLUMN ${name} ${definition}`);
    }
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
