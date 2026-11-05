import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentContext, configureDatabase, concludeIntent, createIntent, createProject,
  exportProjectSliceYaml, exportProjectYaml, finishRun, recordStrategistSuccess,
  renderAgentContextYaml, setIntentStatus, startRun,
  type AgentContextAudit, type CairnDatabase, type GraphExportAudit,
} from "./index";
let dir: string;
let db: CairnDatabase;
let projectId: string;
let focus: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-selection-audit-"));
  db = configureDatabase(join(dir, "cairn.db"));
  db.withConn((conn) => {
    projectId = createProject(conn, { title: "audit", origin: "origin", goal: "goal",
      bootstrap_enabled: false, hints: [{ content: "hint", creator: "test" }],
      scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    let from = "origin";
    for (let i = 0; i < 6; i += 1) {
      const intent = createIntent(conn, projectId, { from: [from], description: `closed ${i}`, creator: "test", worker: null });
      from = concludeIntent(conn, projectId, intent.id, "test", `fact ${i}`).fact.id;
    }
    const abandoned = createIntent(conn, projectId, { from: ["origin"], description: "abandoned", creator: "test", worker: null });
    setIntentStatus(conn, { projectId, intentId: abandoned.id, status: "abandoned", reason: "not established", by: "test" });
    for (let i = 0; i < 5; i += 1) {
      focus = createIntent(conn, projectId, { from: [from], description: `open ${i}`, creator: "test", worker: null }).id;
    }
    for (let i = 0; i < 4; i += 1) {
      const id = `run-${i}`;
      startRun(conn, { id, projectId, taskId: `task-${i}`, kind: "explore", intentId: focus, worker: "test", startedAt: `2026-11-04T00:00:0${i}Z` });
      finishRun(conn, id, { outcome: "failed", detail: "long detail ".repeat(100), finishedAt: "2026-11-04T00:01:00Z", durationMs: 10 });
    }
    recordStrategistSuccess(conn, { projectId, runId: "reason-before", trigger: "initial",
      factCount: 2, hintCount: 0, openIntentCount: 0, at: "2000-01-01T00:00:00Z" });
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("M47 selector-owned audit metadata", () => {
  test("AgentContext emits exact counts from selected data without changing YAML", () => {
    db.withConn((conn) => {
      let audit: AgentContextAudit | undefined;
      const options = { kind: "reason" as const, generatedAt: "2026-11-04T00:00:00Z",
        limits: { maxFacts: 2, maxIntents: 3, maxConcludedIntents: 1, maxAbandonedIntents: 1,
          maxAttempts: 1, maxDeltaIds: 1, maxDetailChars: 12 } };
      const context = buildAgentContext(conn, projectId, { ...options, onAudit: (value) => { audit = value; } });
      const plain = buildAgentContext(conn, projectId, options);
      expect(renderAgentContextYaml(context)).toBe(renderAgentContextYaml(plain));
      expect(audit).toBeDefined();
      const selections = audit!.selections;
      expect(selections.find((item) => item.section === "facts")).toMatchObject({ candidates: 8, selected: context.facts.length, limits: { maxFacts: 2 } });
      expect(selections.find((item) => item.section === "intents")).toMatchObject({ candidates: 12, selected: context.intents.length });
      expect(selections.find((item) => item.section === "intents.abandoned")).toMatchObject({ candidates: 1, selected: 0 });
      expect(selections.find((item) => item.section === "intents.concluded")).toMatchObject({ candidates: 6, selected: 0 });
      expect(selections.find((item) => item.section === "recent_attempts")).toMatchObject({ candidates: 4, selected: 1 });
      expect(selections.find((item) => item.section === "delta.new_facts")).toMatchObject({ candidates: 6, selected: 1 });
      expect(selections.find((item) => item.section === "delta.concluded_intents")).toMatchObject({ candidates: 6, selected: 1 });
      expect(audit!.details).toMatchObject({ max_chars: 12, examined_fields: 2, clipped_fields: 2 });
      expect(JSON.stringify(audit)).not.toContain("long detail");
      expect(JSON.stringify(audit)).not.toContain("abandoned\",\"description");
    });
  });

  test("focus counts describe the focused selection, not the whole project", () => {
    db.withConn((conn) => {
      let audit: AgentContextAudit | undefined;
      const context = buildAgentContext(conn, projectId, { kind: "explore", focusIntentId: focus,
        limits: { maxAttempts: 2 }, onAudit: (value) => { audit = value; } });
      expect(audit!.selections.find((item) => item.section === "facts")).toMatchObject({ scope: "focus", candidates: 1, selected: context.facts.length });
      expect(audit!.selections.find((item) => item.section === "intents")).toMatchObject({ scope: "focus", candidates: 1, selected: 1 });
      expect(audit!.selections.find((item) => item.section === "recent_attempts")).toMatchObject({ scope: "focus", candidates: 4, selected: 2 });
    });
  });

  test("full graph emits exact full coverage without altering export bytes", () => {
    db.withConn((conn) => {
      let audit: GraphExportAudit | undefined;
      const actual = exportProjectYaml(conn, projectId, (value) => { audit = value; });
      expect(actual).toBe(exportProjectYaml(conn, projectId));
      const parsed = Bun.YAML.parse(actual) as { facts: unknown[]; intents: unknown[]; hints: unknown[] };
      expect(audit!.selections).toEqual([
        { section: "facts", scope: "project", candidates: 8, selected: parsed.facts.length, limits: {}, policy: "all" },
        { section: "intents", scope: "project", candidates: 12, selected: parsed.intents.length, limits: {}, policy: "all" },
        { section: "hints", scope: "project", candidates: 1, selected: parsed.hints.length, limits: {}, policy: "all" },
      ]);
      expect(audit!.sliced).toBe(false);
    });
  });

  test("slice preserves mandatory overflow and counts actual selected nodes", () => {
    db.withConn((conn) => {
      let audit: GraphExportAudit | undefined;
      const options = { focusIntentId: focus, maxFacts: 2, maxIntents: 1 };
      const actual = exportProjectSliceYaml(conn, projectId, { ...options, onAudit: (value) => { audit = value; } });
      expect(actual).toBe(exportProjectSliceYaml(conn, projectId, options));
      const parsed = Bun.YAML.parse(actual) as { facts: unknown[]; intents: unknown[]; hints: unknown[]; slice: { truncated: boolean } };
      expect(audit!.mandatory_over_cap).toBe(true);
      expect(audit!.legacy_truncated).toBe(parsed.slice.truncated);
      expect(audit!.selections[0]).toMatchObject({ candidates: 8, selected: parsed.facts.length });
      expect(audit!.selections[1]).toMatchObject({ candidates: 12, selected: parsed.intents.length });
      expect(audit!.selections[2]).toMatchObject({ candidates: 1, selected: 1 });
      expect(parsed.intents.length).toBeGreaterThan(options.maxIntents);
    });
  });
});
