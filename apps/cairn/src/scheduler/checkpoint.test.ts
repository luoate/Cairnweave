import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, createProject, startRun, registerCheckpointRun, type CairnDatabase } from "@cairn/graph";
import { MAX_CHECKPOINT_BYTES } from "@cairn/contracts";
import { checkpoint } from "../../../../packages/contracts/src/testdata/checkpoint";
import { ingestCheckpoint, checkpointEvidenceStatus } from "./checkpoint";
let dir: string; let db: CairnDatabase; let projectId: string; let sessionDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "checkpoint-ingest-")); db = configureDatabase(join(dir, "db.sqlite"));
  sessionDir = join(dir, "session"); mkdirSync(sessionDir);
  db.withConn((conn) => { projectId = createProject(conn, { title: "p", origin: "o", goal: "g", hints: null, bootstrap_enabled: false, scope: { targets: ["127.0.0.1"] } }).project.id;
    startRun(conn, { id: "r1", projectId, taskId: "task", kind: "reason", worker: "worker", startedAt: "2026-11-05T00:00:00Z" });
    registerCheckpointRun(conn, "r1", ["127.0.0.1"]); });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = () => join(sessionDir, "checkpoint.json");
const ingest = () => ingestCheckpoint(db, { runId: "r1", projectId, taskId: "task", sessionDir });
function write(sequence = 1) { writeFileSync(file(), JSON.stringify(checkpoint({ project_id: projectId, task_id: "task", intent_id: null, sequence }))); }
describe("M49 bounded file channel", () => {
  test("invalid, partial and missing newer files preserve last accepted checkpoint", () => {
    expect(ingest()).toBe("unavailable"); write(); expect(ingest()).toBe("accepted");
    writeFileSync(file(), '{"version":1'); expect(ingest()).toBe("invalid");
    writeFileSync(file(), Buffer.alloc(MAX_CHECKPOINT_BYTES + 1)); expect(ingest()).toBe("invalid");
    rmSync(file()); expect(ingest()).toBe("unavailable");
    expect(db.withConn((conn) => conn.query("SELECT sequence FROM task_checkpoints WHERE run_id='r1'").get())).toEqual({ sequence: 1 });
    write(2); expect(ingest()).toBe("accepted"); expect(ingest()).toBe("duplicate");
  });
  test("directory and session-junction redirection cannot import outside bytes", () => {
    mkdirSync(file()); expect(ingest()).toBe("invalid"); rmSync(file(), { recursive: true });
    write(); const outside = join(dir, "outside"); mkdirSync(outside); writeFileSync(join(outside, "checkpoint.json"), readFileSync(file()));
    rmSync(sessionDir, { recursive: true }); symlinkSync(outside, sessionDir, "junction"); expect(ingest()).toBe("invalid");
  });
  test("evidence existence is reconciled without reading content or granting verification", () => {
    const workspace = join(dir, "workspace"); mkdirSync(join(workspace, "artifacts"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "test.log"), "untrusted evidence");
    expect(checkpointEvidenceStatus(workspace, "artifacts/test.log")).toBe("available");
    rmSync(join(workspace, "artifacts", "test.log")); expect(checkpointEvidenceStatus(workspace, "artifacts/test.log")).toBe("missing");
    expect(checkpointEvidenceStatus(workspace, "../db.sqlite")).toBe("unavailable");
    write(); symlinkSync(sessionDir, join(workspace, "redirect"), "junction");
    expect(checkpointEvidenceStatus(workspace, "redirect/checkpoint.json")).toBe("unavailable");
  });
});
