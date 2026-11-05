import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentContext, buildTaskContextSnapshot, configureDatabase, concludeIntent, createIntent, createProject,
  finishRun, recordCompletionReview, recordFlagReview, startRun, type CairnDatabase,
} from "./index";
let dir: string;
let db: CairnDatabase;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cairn-snapshot-test-")); db = configureDatabase(join(dir, "db.sqlite")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("M48 complete authorized projection", () => {
  test("captures records before AgentContext count caps and isolates projects", () => {
    db.withConn((conn) => {
      const id = createProject(conn, { title: "snapshot", origin: "start", goal: "finish", hints: null,
        scope: { targets: ["127.0.0.1:8080"] }, bootstrap_enabled: false, goal_conditions: [{ kind: "flag_count", min: 3 }, { kind: "evidence" }] }).project.id;
      for (let i = 0; i < 205; i += 1) {
        const intent = createIntent(conn, id, { from: ["origin"], description: `step ${i}`, creator: "test", worker: null });
        concludeIntent(conn, id, intent.id, "test", `fact ${i}`);
      }
      createProject(conn, { title: "other-project-private", origin: "other-private-origin", goal: "other-private-goal", hints: null, scope: { targets: ["127.0.0.1:8080"] }, bootstrap_enabled: false });
      const capped = buildAgentContext(conn, id, { kind: "reason" });
      const snapshot = buildTaskContextSnapshot(conn, id);
      expect(capped.facts).toHaveLength(200);
      expect(capped.intents).toHaveLength(20);
      expect(snapshot.facts).toHaveLength(207);
      expect(snapshot.intents).toHaveLength(205);
      expect(snapshot.facts.find((fact) => fact.description === "fact 204")).toBeDefined();
      expect(snapshot.goal_conditions.map(({ kind, min }) => ({ kind, min }))).toEqual([{ kind: "flag_count", min: 3 }, { kind: "evidence", min: null }]);
      expect(JSON.stringify(snapshot)).not.toContain("other-private");
      expect(JSON.stringify(snapshot)).not.toContain("other-project");
    });
  });

  test("preserves outcome uncertainty and bounded detail visibility, not run/session or review bodies", () => {
    db.withConn((conn) => {
      const id = createProject(conn, { title: "snapshot", origin: "start", goal: "finish", hints: null, scope: { targets: ["127.0.0.1:8080"] }, bootstrap_enabled: false }).project.id;
      const intent = createIntent(conn, id, { from: ["origin"], description: "test a hypothesis", creator: "peer", worker: "peer" });
      for (let i = 0; i < 23; i += 1) {
        const runId = `run-${i}`;
        startRun(conn, { id: runId, projectId: id, taskId: `task-${i}`, kind: "explore", intentId: intent.id,
          worker: "test", session: "C:/private-session", startedAt: "2026-11-05T00:00:00Z" });
        finishRun(conn, runId, { outcome: "failed", finishedAt: "2026-11-05T00:01:00Z", detail: "timeout: no conclusion ".repeat(80) + "PRIVATE_RAW_TAIL", durationMs: 10 });
      }
      recordCompletionReview(conn, id, { kind: "reason", description: "PRIVATE_REVIEW_DESCRIPTION", fromFacts: ["origin"] });
      recordFlagReview(conn, id, { flag: "PRIVATE_REVIEW_VALUE" });
      const snapshot = buildTaskContextSnapshot(conn, id);
      expect(snapshot.attempts).toHaveLength(23);
      expect(snapshot.attempts.every((attempt) => attempt.outcome === "failed" && attempt.detail!.length <= 500)).toBe(true);
      expect(snapshot.intents[0]).toMatchObject({ worker: "peer", attempts: 23, last_outcome: "failed", status: "open" });
      expect(snapshot.reviews.flags["pending"]).toBe(1);
      expect(snapshot.reviews.completion["pending"]).toBe(1);
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
      expect(JSON.stringify(snapshot)).not.toContain("private-session");
      expect(snapshot.detail_policy).toBe("agent_context_500_chars");
    });
  });
});
