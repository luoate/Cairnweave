import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experiment } from "../../contracts/src/testdata/experiment";
import { buildAgentContext, buildTaskContextSnapshot, configureDatabase, createIntent, createProject, exportProjectYaml,
  getIntentMeta, listProjectIntentMeta, recordIntentMeta, renderAgentContextYaml, setIntentStatus, type CairnDatabase } from "./index";
let db: CairnDatabase; let dir: string; let projectId: string; let intentId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "experiment-storage-")); db = configureDatabase(join(dir, "db.sqlite"));
  db.withConn(conn => {
    projectId = createProject(conn, { title: "lab", origin: "origin", goal: "goal", hints: null, bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    intentId = createIntent(conn, projectId, { from: ["origin"], description: "compare", creator: "test", worker: null }).id;
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const read = () => db.withConn(conn => getIntentMeta(conn, projectId, intentId));
const save = () => db.withConn(conn => recordIntentMeta(conn, { projectId, intentId, source: "strategist", experiment: experiment() }));
describe("M51a experiment metadata", () => {
  test("round trips and reopens, preserving the plan when unrelated metadata and lifecycle change", () => {
    save(); db = configureDatabase(db.path);
    expect(read()?.experiment).toEqual(experiment());
    db.withConn(conn => {
      recordIntentMeta(conn, { projectId, intentId, priority: 90 });
      setIntentStatus(conn, { projectId, intentId, status: "abandoned", reason: "manual", by: "operator" });
    });
    expect(read()).toMatchObject({ priority: 90, status: "abandoned", experiment: experiment() });
    expect(db.withConn(conn => listProjectIntentMeta(conn, projectId))[0]?.experiment).toEqual(experiment());
  });
  test("legacy metadata and corrupted stored plans omit experiment rather than inventing a plan", () => {
    db.withConn(conn => recordIntentMeta(conn, { projectId, intentId, source: "test" }));
    expect(read()).not.toHaveProperty("experiment");
    for (const invalid of ["{", JSON.stringify({ ...experiment(), version: 9 }), "a".repeat(9000)]) {
      db.withConn(conn => conn.query("UPDATE intent_meta SET experiment = ? WHERE project_id = ? AND intent_id = ?").run(invalid, projectId, intentId));
      expect(read()).not.toHaveProperty("experiment");
    }
  });
  test("invalid metadata and transaction failures never leave partial plans or intents", () => {
    expect(() => db.withConn(conn => recordIntentMeta(conn, { projectId, intentId, experiment: { ...experiment(), hypothesis: " " } }))).toThrow("Invalid experiment contract");
    expect(read()).toBeNull();
    expect(() => db.withConn(conn => {
      recordIntentMeta(conn, { projectId, intentId, experiment: experiment() }); throw new Error("rollback");
    })).toThrow("rollback");
    expect(read()).toBeNull();
  });
  test("projects the bounded plan into agent context and snapshots, never graph facts or graph YAML", () => {
    const before = db.withConn(conn => exportProjectYaml(conn, projectId)); save();
    db.withConn(conn => {
      const context = buildAgentContext(conn, projectId, { kind: "explore", focusIntentId: intentId });
      expect(context.intents.find(i => i.id === intentId)?.experiment).toEqual(experiment());
      const yaml = Bun.YAML.parse(renderAgentContextYaml(context)) as { intents: Array<{ experiment_plan_not_evidence?: unknown }> };
      expect(yaml.intents[0]?.experiment_plan_not_evidence).toEqual(experiment());
      expect(buildTaskContextSnapshot(conn, projectId).intents.find(i => i.id === intentId)?.experiment).toEqual(experiment());
      expect(exportProjectYaml(conn, projectId)).toBe(before);
    });
  });
});
