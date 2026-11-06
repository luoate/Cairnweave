import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimReason, configureDatabase, createHint, createProject, getProjectDetail, type CairnDatabase } from "@cairn/graph";
import { createApi, type Api } from "./api";

let directory: string;
let db: CairnDatabase;
let api: Api;
let projectId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-guidance-"));
  db = configureDatabase(join(directory, "db.sqlite"));
  projectId = db.withConn(conn => createProject(conn, { title: "guidance", origin: "start", goal: "goal", hints: null,
    bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } }).project.id);
  api = createApi({ db });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
async function post(content = "优先检查登录入口") {
  return api.handle(new Request(`http://cairn.test/projects/${projectId}/hints`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ content, creator: "arbitrary-display-name" }) }));
}
const detail = () => db.withConn(conn => getProjectDetail(conn, projectId));

test("operator hints are high priority, regardless of display name, and the response stays compatible", async () => {
  const response = await post();
  expect(response.status).toBe(201);
  expect(Object.keys(await response.json() as object)).toEqual(["id", "content", "creator", "created_at"]);
  const result = await api.handle(new Request(`http://cairn.test/projects/${projectId}`));
  expect((await result.json() as any).hints[0]).toMatchObject({ operator_guidance: "pending", creator: "arbitrary-display-name" });
  db.withConn(conn => createHint(conn, projectId, { content: "ordinary note", creator: "operator" }));
  expect(detail().hints[1]).not.toHaveProperty("operator_guidance");
});

for (const status of ["stopped", "completed"] as const) test(`${status} projects save guidance without resuming`, async () => {
  db.withConn(conn => conn.query("UPDATE projects SET status = ? WHERE id = ?").run(status, projectId));
  expect((await post()).status).toBe(201);
  expect(detail().project.status).toBe(status);
  expect(detail().hints[0]?.operator_guidance).toBe("pending");
});

test("guidance can be queued while a reason task is already running", async () => {
  db.withConn(conn => claimReason(conn, projectId, "fixture", "initial"));
  expect((await post()).status).toBe(201);
  expect(detail().project.reason?.worker).toBe("fixture");
  expect(detail().hints[0]?.operator_guidance).toBe("pending");
});

test("invalid hint requests create neither hints nor priority metadata", async () => {
  expect((await post("")).status).toBe(422);
  expect(detail().hints).toHaveLength(0);
  expect(db.withConn(conn => conn.query("SELECT COUNT(*) AS n FROM operator_hint_meta").get())).toEqual({ n: 0 });
});
