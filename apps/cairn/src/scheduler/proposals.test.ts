import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getFactMeta,
  listFactEvidence,
  listProjectProposals,
  type CairnDatabase,
  type Proposal,
} from "@cairn/graph";

import { parseDispatchConfig } from "../config";
import { ingestTaskProposals, reviewPendingProposals } from "./proposals";

const BASE = {
  server: "http://127.0.0.1:8000",
  runtime: {
    execution: "local",
    max_workers: 2,
    max_running_projects: 2,
    max_project_workers: 1,
    interval: 1,
    healthcheck_timeout: 15,
    worker_healthcheck: "disabled",
    prompt_group: "default",
  },
  tasks: {
    bootstrap: { timeout: 30, conclude_timeout: 10 },
    reason: { timeout: 30, max_intents: 3 },
    explore: { timeout: 30, conclude_timeout: 10 },
  },
  local: { completed_action: "keep" },
};

function config(overrides: Record<string, unknown> = {}) {
  return parseDispatchConfig({
    ...BASE,
    proposals: { enabled: true, mode: "apply", ...overrides },
  });
}

let directory: string;
let workspace: string;
let sessionDir: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-proposals-scheduler-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "proposals",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
  workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
  sessionDir = join(directory, "session");
  mkdirSync(join(sessionDir, "observer", "proposals"), { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface CandidateInput {
  kind: "fact" | "intent" | "hint";
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  evidenceRefs?: string[];
}

function candidate(input: CandidateInput): Record<string, unknown> {
  return {
    version: 1,
    id: "ignored-by-control-plane",
    source: "observer",
    kind: input.kind,
    project_id: projectId,
    task_id: "explore-test",
    created_at: "2026-01-01T00:00:00Z",
    dedupe_key: input.dedupeKey ?? null,
    evidence_refs: input.evidenceRefs ?? [],
    payload: input.payload,
  };
}

function writeCandidate(name: string, value: unknown): void {
  writeFileSync(
    join(sessionDir, "observer", "proposals", name),
    typeof value === "string" ? value : JSON.stringify(value),
    "utf8",
  );
}

function ingest(overrides: Record<string, unknown> = {}) {
  return ingestTaskProposals(db, config(overrides), {
    projectId,
    taskId: "explore-test",
    runId: "run-1",
    sessionDir,
  });
}

function review(overrides: Record<string, unknown> = {}) {
  return reviewPendingProposals(db, config(overrides), projectId, workspace);
}

function proposals(): Proposal[] {
  return db.withConn((conn) => listProjectProposals(conn, projectId));
}

describe("proposal ingestion", () => {
  test("is off unless enabled", () => {
    writeCandidate("a.json", candidate({ kind: "hint", payload: { content: "h" } }));
    const result = ingestTaskProposals(
      db,
      parseDispatchConfig({ ...BASE, proposals: { enabled: false } }),
      { projectId, taskId: "explore-test", runId: "run-1", sessionDir },
    );
    expect(result.status).toBe("disabled");
    expect(result.ingested).toBe(0);
    expect(proposals()).toEqual([]);
  });

  test("imports valid files, skips bad ones and is idempotent", () => {
    writeCandidate(
      "hint-a.json",
      candidate({ kind: "hint", payload: { content: "check /admin", confidence: 1 } }),
    );
    writeCandidate("bad.json", "not json");
    writeCandidate(
      "wrong-kind.json",
      candidate({ kind: "fact", payload: { description: "x", from: ["origin"] } }),
    );
    writeCandidate(
      "oversized.json",
      candidate({ kind: "hint", payload: { content: "x".repeat(20_000) } }),
    );

    const result = ingestTaskProposals(
      db,
      config({ allow_kinds: ["hint"], max_file_bytes: 4096 }),
      { projectId, taskId: "explore-test", runId: "run-1", sessionDir },
    );
    expect(result.status).toBe("read");
    expect(result.ingested).toBe(1);
    expect(result.skipped).toBe(3);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(proposals()).toHaveLength(1);
    expect(proposals()[0]).toMatchObject({
      task_id: "explore-test",
      run_id: "run-1",
      source: "observer",
      kind: "hint",
      status: "pending",
      payload: { content: "check /admin", confidence: 1 },
    });

    const again = ingest({ allow_kinds: ["hint"], max_file_bytes: 4096 });
    expect(again.ingested).toBe(0);
    expect(again.skipped).toBe(4);
    expect(proposals()).toHaveLength(1);
  });

  test("honors max_per_task and the byte budget", () => {
    for (let index = 0; index < 3; index += 1) {
      writeCandidate(
        `hint-${index}.json`,
        candidate({ kind: "hint", payload: { content: `hint ${index}` } }),
      );
    }
    const capped = ingest({ max_per_task: 2 });
    expect(capped.ingested).toBe(2);
    expect(capped.skipped).toBe(1);
    expect(proposals()).toHaveLength(2);

    const budget = ingestTaskProposals(
      db,
      config({ max_per_task: 10, max_file_bytes: 400, max_total_bytes: 400 }),
      { projectId, taskId: "explore-test-2", runId: "run-2", sessionDir },
    );
    expect(budget.ingested).toBe(1);
    expect(budget.skipped).toBe(2);
    expect(proposals()).toHaveLength(3);
  });

  test("does not follow a symlinked candidate", () => {
    const outside = join(directory, "outside.json");
    writeFileSync(
      outside,
      JSON.stringify(candidate({ kind: "hint", payload: { content: "leak" } })),
      "utf8",
    );
    let linked = true;
    try {
      symlinkSync(outside, join(sessionDir, "observer", "proposals", "link.json"));
    } catch {
      linked = false;
    }
    if (!linked) return;

    const result = ingest();
    expect(result.ingested).toBe(0);
    expect(proposals()).toEqual([]);
  });

  test("rejects a symlinked proposal directory", () => {
    const real = join(directory, "elsewhere");
    mkdirSync(real, { recursive: true });
    rmSync(join(sessionDir, "observer", "proposals"), { recursive: true, force: true });
    let linked = true;
    try {
      symlinkSync(real, join(sessionDir, "observer", "proposals"), "dir");
    } catch {
      linked = false;
    }
    if (!linked) return;

    expect(ingest().status).toBe("unreadable");
  });
});

describe("proposal review", () => {
  test("applies a hint and reports an exact-content duplicate", () => {
    writeCandidate(
      "hint-a.json",
      candidate({ kind: "hint", payload: { content: "check /admin" } }),
    );
    writeCandidate(
      "hint-b.json",
      candidate({ kind: "hint", payload: { content: "check /admin" } }),
    );
    expect(ingest().ingested).toBe(2);

    const result = review();
    expect(result).toMatchObject({ applied: 1, duplicate: 1, rejected: 0, dryRun: 0 });
    const rows = proposals();
    const applied = rows.find((proposal) => proposal.status === "applied")!;
    const duplicate = rows.find((proposal) => proposal.status === "duplicate")!;
    expect(applied.applied_id).toMatch(/^h\d+$/);
    expect(duplicate.decision_reason).toBe("hint_exists");
    expect(duplicate.applied_id).toBe(applied.applied_id);

    const detail = db.withConn((conn) =>
      conn.query("SELECT content FROM hints WHERE project_id = ?").all(projectId),
    );
    expect(detail).toEqual([{ content: "check /admin" }]);
  });

  test("applies an intent once and dedupes by dedupe_key", () => {
    writeCandidate(
      "intent-a.json",
      candidate({
        kind: "intent",
        payload: { description: "probe admin login", from: ["origin"] },
        dedupeKey: "probe-admin",
      }),
    );
    writeCandidate(
      "intent-b.json",
      candidate({
        kind: "intent",
        payload: { description: "try the admin panel", from: ["origin"] },
        dedupeKey: "probe-admin",
      }),
    );
    expect(ingest().ingested).toBe(2);

    const result = review();
    expect(result).toMatchObject({ applied: 1, duplicate: 1 });
    const applied = proposals().find((proposal) => proposal.status === "applied")!;
    expect(applied.applied_id).toMatch(/^i\d+$/);
    const duplicate = proposals().find((proposal) => proposal.status === "duplicate")!;
    expect(duplicate.decision_reason).toBe("intent_open");
    expect(duplicate.applied_id).toBe(applied.applied_id);

    const intents = db.withConn((conn) =>
      conn
        .query(
          "SELECT id, description, worker FROM intents WHERE project_id = ? AND to_fact_id IS NULL",
        )
        .all(projectId),
    );
    expect(intents).toEqual([
      {
        id: applied.applied_id,
        description: applied.payload.description,
        worker: null,
      },
    ]);
    const meta = db.withConn((conn) =>
      conn
        .query("SELECT intent_id, dedupe_key, source FROM intent_meta WHERE project_id = ?")
        .all(projectId),
    );
    expect(meta).toEqual([
      { intent_id: applied.applied_id, dedupe_key: "probe-admin", source: "observer" },
    ]);
  });

  test("applies an evidence-backed fact and rejects duplicates", () => {
    mkdirSync(join(workspace, "notes"), { recursive: true });
    writeFileSync(join(workspace, "notes", "admin.txt"), "admin panel found\n", "utf8");
    writeCandidate(
      "fact-a.json",
      candidate({
        kind: "fact",
        payload: { description: "the admin panel exists", from: ["origin"] },
        evidenceRefs: ["notes/admin.txt"],
      }),
    );
    writeCandidate(
      "fact-b.json",
      candidate({
        kind: "fact",
        payload: { description: "the admin panel exists", from: ["origin"] },
        evidenceRefs: ["notes/admin.txt"],
      }),
    );
    expect(ingest().ingested).toBe(2);

    const result = review();
    expect(result).toMatchObject({ applied: 1, duplicate: 1, rejected: 0 });
    const applied = proposals().find((proposal) => proposal.status === "applied")!;
    expect(applied.applied_id).toMatch(/^f\d+$/);
    const duplicate = proposals().find((proposal) => proposal.status === "duplicate")!;
    expect(duplicate.decision_reason).toBe("fact_exists");
    expect(duplicate.applied_id).toBe(applied.applied_id);

    const meta = db.withConn((conn) => getFactMeta(conn, projectId, applied.applied_id!));
    expect(meta).toMatchObject({
      fact_id: applied.applied_id,
      run_id: "run-1",
      evidence_status: "provided",
      evidence_refs: ["notes/admin.txt"],
    });
    const files = db.withConn((conn) =>
      listFactEvidence(conn, projectId, applied.applied_id!),
    );
    expect(files).toHaveLength(1);
    expect(files![0]).toMatchObject({ path: "notes/admin.txt", size: 18 });
    expect(files![0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("applies a superseding fact and records both directions", () => {
    mkdirSync(join(workspace, "notes"), { recursive: true });
    writeFileSync(join(workspace, "notes", "port.txt"), "port 8080\n", "utf8");
    writeCandidate(
      "fact-old.json",
      candidate({
        kind: "fact",
        payload: { description: "the service listens on port 80", from: ["origin"] },
        evidenceRefs: ["notes/port.txt"],
      }),
    );
    expect(ingest().ingested).toBe(1);
    expect(review()).toMatchObject({ applied: 1, rejected: 0 });
    const older = proposals().find((proposal) => proposal.status === "applied")!;

    writeCandidate(
      "fact-new.json",
      candidate({
        kind: "fact",
        payload: {
          description: "the service listens on port 8080",
          from: ["origin"],
          supersedes: [older.applied_id!],
        },
        evidenceRefs: ["notes/port.txt"],
      }),
    );
    expect(ingest().ingested).toBe(1);
    expect(review()).toMatchObject({ applied: 1, rejected: 0 });
    const newer = proposals().find(
      (proposal) => proposal.status === "applied" && proposal.id !== older.id,
    )!;

    const olderMeta = db.withConn((conn) => getFactMeta(conn, projectId, older.applied_id!));
    const newerMeta = db.withConn((conn) => getFactMeta(conn, projectId, newer.applied_id!));
    expect(olderMeta?.superseded_by).toBe(newer.applied_id);
    expect(newerMeta?.supersedes).toEqual([older.applied_id!]);
  });

  test("rejects superseding a seed fact", () => {
    writeCandidate(
      "fact-seed.json",
      candidate({
        kind: "fact",
        payload: { description: "replace origin", from: ["origin"], supersedes: ["origin"] },
      }),
    );
    expect(ingest().ingested).toBe(1);
    expect(review()).toMatchObject({ applied: 0, rejected: 1 });
    expect(proposals()[0]?.decision_reason).toBe("supersede_origin_or_goal");
  });

  test("rejects superseding a missing fact", () => {
    writeCandidate(
      "fact-missing-target.json",
      candidate({
        kind: "fact",
        payload: { description: "replace nothing", from: ["origin"], supersedes: ["f999"] },
      }),
    );
    expect(ingest().ingested).toBe(1);
    expect(review()).toMatchObject({ applied: 0, rejected: 1 });
    expect(proposals()[0]?.decision_reason).toBe("supersede_target_missing");
  });

  test("rejects superseding a fact that was already replaced", () => {
    mkdirSync(join(workspace, "notes"), { recursive: true });
    writeFileSync(join(workspace, "notes", "state.txt"), "state\n", "utf8");
    writeCandidate(
      "fact-a.json",
      candidate({
        kind: "fact",
        payload: { description: "state is old", from: ["origin"] },
        evidenceRefs: ["notes/state.txt"],
      }),
    );
    ingest();
    review();
    const older = proposals().find((proposal) => proposal.status === "applied")!;

    writeCandidate(
      "fact-b.json",
      candidate({
        kind: "fact",
        payload: {
          description: "state is new",
          from: ["origin"],
          supersedes: [older.applied_id!],
        },
        evidenceRefs: ["notes/state.txt"],
      }),
    );
    ingest();
    review();

    writeCandidate(
      "fact-c.json",
      candidate({
        kind: "fact",
        payload: {
          description: "state is newer",
          from: ["origin"],
          supersedes: [older.applied_id!],
        },
        evidenceRefs: ["notes/state.txt"],
      }),
    );
    ingest();
    expect(review()).toMatchObject({ applied: 0, rejected: 1 });
    const rejected = proposals().find(
      (proposal) =>
        proposal.status === "rejected" &&
        proposal.payload.description === "state is newer",
    );
    expect(rejected?.decision_reason).toBe(
      `fact_already_superseded: ${older.applied_id}`,
    );
  });

  test("rejects supersedes on non-fact proposals", () => {
    writeCandidate(
      "hint-supersedes.json",
      candidate({
        kind: "hint",
        payload: { content: "check /admin", supersedes: ["origin"] },
      }),
    );
    const result = ingest();
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issues.join(" ")).toContain("supersedes is only allowed for facts");
    expect(proposals()).toEqual([]);
  });

  test("rejects facts without accepted evidence", () => {
    writeCandidate(
      "missing.json",
      candidate({
        kind: "fact",
        payload: { description: "no evidence", from: ["origin"] },
      }),
    );
    writeCandidate(
      "broken.json",
      candidate({
        kind: "fact",
        payload: { description: "bad evidence", from: ["origin"] },
        evidenceRefs: ["../outside.txt"],
      }),
    );
    writeCandidate(
      "no-such-fact.json",
      candidate({
        kind: "fact",
        payload: { description: "missing source", from: ["f999"] },
        evidenceRefs: ["notes/a.txt"],
      }),
    );
    writeFileSync(join(directory, "outside.txt"), "outside\n", "utf8");
    writeCandidate(
      "escape.json",
      candidate({
        kind: "fact",
        payload: { description: "escapes", from: ["origin"] },
        evidenceRefs: ["../outside.txt"],
      }),
    );
    expect(ingest().ingested).toBe(4);

    const result = review();
    expect(result).toMatchObject({ applied: 0, rejected: 4 });
    const reasons = proposals().map((proposal) => proposal.decision_reason);
    expect(reasons).toContain("evidence_required");
    expect(reasons.some((reason) => reason?.startsWith("evidence_invalid:"))).toBe(true);
    expect(reasons).toContain("source_fact_missing");
    expect(proposals().every((proposal) => proposal.applied_id === null)).toBe(true);
  });

  test("dry_run records decisions without writing the graph", () => {
    writeCandidate(
      "hint.json",
      candidate({ kind: "hint", payload: { content: "preview hint" } }),
    );
    writeCandidate(
      "intent.json",
      candidate({
        kind: "intent",
        payload: { description: "preview intent", from: ["origin"] },
        dedupeKey: "preview",
      }),
    );
    expect(ingest().ingested).toBe(2);

    const result = review({ mode: "dry_run" });
    expect(result).toMatchObject({ applied: 0, dryRun: 2, rejected: 0 });
    expect(proposals().map((proposal) => proposal.status)).toEqual([
      "dry_run",
      "dry_run",
    ]);
    const counts = db.withConn((conn) =>
      conn
        .query(
          "SELECT (SELECT COUNT(*) FROM facts) AS facts, (SELECT COUNT(*) FROM intents) AS intents, (SELECT COUNT(*) FROM hints) AS hints",
        )
        .get(),
    );
    expect(counts).toEqual({ facts: 2, intents: 0, hints: 0 });
  });

  test("rejects pending proposals when the project is inactive", () => {
    writeCandidate(
      "hint.json",
      candidate({ kind: "hint", payload: { content: "too late" } }),
    );
    expect(ingest().ingested).toBe(1);
    db.withConn((conn) => {
      conn.query("UPDATE projects SET status = 'stopped' WHERE id = ?").run(projectId);
    });

    const result = review();
    expect(result).toMatchObject({ applied: 0, rejected: 1 });
    expect(proposals()[0]).toMatchObject({
      status: "rejected",
      decision_reason: "project_inactive",
    });
  });

  test("rejects a malformed stored payload without crashing", () => {
    // Bypass ingestion to simulate a row written by an older/buggy control plane.
    db.withConn((conn) => {
      conn
        .query(
          "INSERT INTO proposals (id, project_id, task_id, run_id, source, kind, payload, dedupe_key, evidence_refs, status, created_at) VALUES ('broken', ?, 't', 'r', 'observer', 'hint', '{}', NULL, '[]', 'pending', '2026-01-01T00:00:00Z')",
        )
        .run(projectId);
    });

    const result = review();
    expect(result).toMatchObject({ applied: 0, rejected: 1 });
    expect(proposals()[0]!.decision_reason).toBe("apply_failed");
  });
});
