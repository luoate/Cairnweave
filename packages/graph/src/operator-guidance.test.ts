import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureDatabase, type CairnDatabase } from "./db";
import { createHint, createProject, getProjectDetail } from "./commands";
import { acknowledgeOperatorGuidance, markOperatorHint, selectOperatorGuidance } from "./operator-guidance";

let directory: string;
let db: CairnDatabase;
let projectId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-operator-guidance-"));
  db = configureDatabase(join(directory, "db.sqlite"));
  projectId = db.withConn(conn => createProject(conn, { title: "guidance", origin: "start", goal: "goal", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function hint(content: string, operator = true) {
  return db.withConn(conn => {
    const value = createHint(conn, projectId, { content, creator: "operator" });
    if (operator) markOperatorHint(conn, projectId, value.id);
    return value.id;
  });
}
const hints = () => db.withConn(conn => getProjectDetail(conn, projectId).hints);

test("priority comes from control-plane provenance, not creator text", () => {
  const ordinary = hint("model-authored note", false);
  const guidance = hint("operator direction");
  expect(hints().find(item => item.id === ordinary)).not.toHaveProperty("operator_guidance");
  expect(hints().find(item => item.id === guidance)?.operator_guidance).toBe("pending");
});

test("acknowledges exact IDs; new hints, including same-second arrivals, survive", () => {
  const first = hint("first");
  const later = hint("later");
  db.withConn(conn => acknowledgeOperatorGuidance(conn, "proj_other", [later], "r-wrong"));
  db.withConn(conn => acknowledgeOperatorGuidance(conn, projectId, [first], "r-success"));
  db = configureDatabase(join(directory, "db.sqlite"));
  expect(hints().find(item => item.id === first)?.operator_guidance).toBe("planned");
  expect(hints().find(item => item.id === later)?.operator_guidance).toBe("pending");
});

test("all pending guidance is retained ahead of four recent planned hints", () => {
  const planned = Array.from({ length: 8 }, (_, index) => hint(`planned-${index}`));
  db.withConn(conn => acknowledgeOperatorGuidance(conn, projectId, planned, "r-success"));
  const pending = Array.from({ length: 12 }, (_, index) => hint(`pending-${index}`));
  const selected = selectOperatorGuidance(hints());
  expect(selected.slice(0, 12).every(item => item.operator_guidance === "pending")).toBe(true);
  expect(new Set(selected.slice(0, 12).map(item => item.id))).toEqual(new Set(pending));
  expect(selected.filter(item => item.operator_guidance === "planned")).toHaveLength(4);
});

test("operator provenance rolls back atomically with the hint", () => {
  expect(() => db.withConn(conn => {
    const value = createHint(conn, projectId, { content: "rolled back", creator: "user" });
    markOperatorHint(conn, projectId, value.id);
    throw new Error("fixture rollback");
  })).toThrow("fixture rollback");
  expect(hints()).toHaveLength(0);
});
