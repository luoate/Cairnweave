import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptTaskCheckpoint, configureDatabase, createIntent, exportProjectYaml, finalizeCheckpointRun,
  recordIntentMeta, registerCheckpointRun, startRun, finishRun, type CairnDatabase } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { RuntimeConfigStore } from "../config-overrides";
import { experiment } from "../../../../packages/contracts/src/testdata/experiment";
import { review } from "../../../../packages/contracts/src/testdata/experiment-review";
import { EXPERIMENT_EVIDENCE, EXPERIMENT_SCOPE, seedExperimentScenario } from "../../../../packages/graph/src/testdata/experiment-scenario";
import { createApi, type Api } from "./api";
let dir: string, db: CairnDatabase, api: Api, scene: ReturnType<typeof seedExperimentScenario>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "experiment-api-")); db = configureDatabase(join(dir, "db.sqlite"));
  scene = db.withConn(conn => seedExperimentScenario(conn));
  mkdirSync(join(dir, scene.projectId, "evidence"), { recursive: true });
  writeFileSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE), "local fixture");
  api = createApi({ db, workspaceRoot: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const url = () => `http://cairn.test/projects/${scene.projectId}/intents/${scene.intentId}/experiment`;
const get = async () => (await api.handle(new Request(url()))).json() as Promise<any>;
test("read-only view separates plan, observation, interpretation and strategy provenance without mutating the graph", async () => {
  const before = db.withConn(conn => exportProjectYaml(conn, scene.projectId));
  const data = await get();
  expect(data.experiment).toEqual(experiment());
  expect(data.hypothesis_verdict).toBe("unknown");
  expect(data.attempts[0].memory.checkpoint.attempts[0]).toMatchObject({ observation: "条件 A 返回 403，条件 B 返回 200", interpretation: "可能存在条件差异，需下一次验证" });
  expect(data.attempts[0].memory.experiment_result.observations[0].evidence).toBe("refs_available_not_verified");
  expect(data.attempts[0].memory.experiment_plan).toEqual(experiment());
  expect(data.exploration).toMatchObject({ version: 1, mode: "observe_only", counts: { new_observation: 1 }, consecutive_without_new_observation: 0 });
  expect(data.exploration_suppression).toMatchObject({ mode: "off", state: "off", penalty: 0,
    semantics: "priority_preview_not_dispatch_authorization" });
  expect(data.attempts[0].exploration).toMatchObject({ status: "new_observation", hypothesis_verdict: "unknown" });
  await get();
  expect(db.withConn(conn => exportProjectYaml(conn, scene.projectId))).toBe(before);
  expect((await api.handle(new Request(url(), { method: "POST", body: "{}" }))).status).toBeGreaterThanOrEqual(400);
  expect((await api.handle(new Request(url().replace(scene.intentId, "missing")))).status).toBe(404);
  expect((await api.handle(new Request(url().replace(scene.projectId, "missing")))).status).toBe(404);
});
test("missing checkpoints and evidence stay unknown; operational failures override worker result", async () => {
  rmSync(join(dir, scene.projectId, EXPERIMENT_EVIDENCE));
  expect((await get()).attempts[0].memory.experiment_result.observations[0].evidence).toBe("missing");
  db.withConn(conn => finishRun(conn, scene.runId, { outcome: "failed", durationMs: 2,
    finishedAt: "2026-11-06T00:02:00Z", failure: { domain: "infrastructure", code: "model_timeout" } }));
  const failed = await get();
  expect(failed.attempts[0].failure.code).toBe("model_timeout");
  expect(failed.attempts[0].memory.experiment_result.status).toBe("operationally_incomplete");
  expect(failed.hypothesis_verdict).toBe("unknown");
  db.withConn(conn => conn.query("UPDATE task_checkpoints SET payload = NULL WHERE run_id = ?").run(scene.runId));
  expect((await get()).attempts[0].memory).toBeNull();
});
test("bounds histories to ten entries and does not expose unrelated project records", async () => {
  db.withConn(conn => {
    for (let i = 0; i < 12; i++) {
      const id = `new-run-${String(i).padStart(2, "0")}`;
      startRun(conn, { id, projectId: scene.projectId, taskId: id, intentId: scene.intentId, kind: "explore", worker: "test", startedAt: "2026-11-06T01:00:00Z" });
      finishRun(conn, id, { outcome: "success", durationMs: 1, finishedAt: "2026-11-06T01:01:00Z" });
      const intent = createIntent(conn, scene.projectId, { from: ["origin"], description: `followup ${i}`, creator: "test", worker: null });
      recordIntentMeta(conn, { projectId: scene.projectId, intentId: intent.id, experiment: experiment(), experimentReview: review() });
    }
    seedExperimentScenario(conn);
  });
  const data = await get();
  expect(data.attempts).toHaveLength(10); expect(data.followups).toHaveLength(10);
  expect(data.omitted).toEqual({ attempts: 3, followups: 2 });
  expect(data.exploration.counts).toMatchObject({ new_observation: 1, unknown: 12 });
  expect(data.exploration.same_plan.count).toBe(12);
  expect(data.exploration.same_plan.intent_ids).toHaveLength(8);
  expect(JSON.stringify(data)).not.toContain("proj_002");
  expect(data.followups.every((item: any) => item.review.source_intent_id === scene.intentId)).toBe(true);
});
test("legacy intents omit invented plans and review data", async () => {
  db.withConn(conn => conn.query("DELETE FROM intent_meta WHERE project_id = ?").run(scene.projectId));
  expect(await get()).toMatchObject({ experiment: null, experiment_review: null, hypothesis_verdict: "unknown" });
  expect(await get()).not.toHaveProperty("exploration");
});
test("M52d previews live opt-in preference and immediately reflects disable and expired history", async () => {
  const now = Date.now(), at = (minute: number) => new Date(now - (5 - minute) * 60_000).toISOString();
  db.withConn(conn => {
    conn.query("UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?").run(at(0), at(1), scene.runId);
    for (let n = 1; n <= 3; n++) {
      const id = `repeat-${n}`;
      startRun(conn, { id, projectId: scene.projectId, intentId: scene.intentId, taskId: id, kind: "explore", worker: "fixture", startedAt: at(n) });
      registerCheckpointRun(conn, id, EXPERIMENT_SCOPE, experiment());
      expect(acceptTaskCheckpoint(conn, { runId: id, projectId: scene.projectId, taskId: id,
        bytes: Buffer.from(JSON.stringify({ ...scene.checkpoint, task_id: id })) })).toBe("accepted");
      finishRun(conn, id, { outcome: "success", durationMs: 1, finishedAt: at(n + 1) }); finalizeCheckpointRun(conn, id, "finished");
    }
  });
  const source = { server: "http://127.0.0.1:8000", runtime: { execution: "local", interval: 3, max_workers: 4,
    max_running_projects: 2, max_project_workers: 1, healthcheck_timeout: 15, prompt_group: "default" },
    tasks: { bootstrap: { timeout: 300, conclude_timeout: 90 }, reason: { timeout: 300, max_intents: 3 },
      explore: { timeout: 600, conclude_timeout: 120 } } };
  const config = parseDispatchConfig(source);
  const runtimeConfig = new RuntimeConfigStore({ db, config, source });
  api = createApi({ db, workspaceRoot: dir, runtimeConfig });
  expect((await get()).exploration_suppression.state).toBe("off");
  runtimeConfig.apply({ tasks: { exploration_suppression: { enabled: true } } });
  expect((await get()).exploration_suppression).toMatchObject({ mode: "soft", state: "reduced", penalty: 20, effective_priority: 30 });
  runtimeConfig.apply({ tasks: { exploration_suppression: { enabled: false } } });
  expect((await get()).exploration_suppression).toMatchObject({ state: "off", penalty: 0, effective_priority: 50 });
  runtimeConfig.apply({ tasks: { exploration_suppression: { enabled: true } } });
  db.withConn(conn => {
    conn.query("UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?").run(at(-5), at(-4), scene.runId);
    conn.query("UPDATE runs SET started_at = ?, finished_at = ? WHERE id LIKE 'repeat-%'").run(at(-3), at(-2));
  });
  expect((await get()).exploration_suppression).toMatchObject({ state: "inactive", reason: "window_expired", penalty: 0 });
});
function app() {
  const html = readFileSync(join(import.meta.dir, "static", "index.html"), "utf8");
  const script = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;
  return { html, state: new Function(`${script}; return cairnApp();`)() as any };
}
test("UI is text-only for untrusted records and never turns availability into verification", () => {
  const { html, state } = app();
  expect(html).toContain("data-experiment-detail");
  expect(html).toContain("观察报告（未验证）"); expect(html).toContain("解释（模型推断）");
  expect(html).not.toMatch(/x-html="[^"]*(?:experiment|attempt\.|followup\.)/);
  expect(state.experimentRunLabel({ failure: { domain: "infrastructure", code: "model_timeout" } })).toContain("不是路线反证");
  expect(state.experimentEvidenceLabel({ experiment_result: { observations: [{ attempt_id: "a1", evidence: "refs_available_not_verified" }] } }, "a1")).toContain("未验证");
});
test("M52d labels distinguish zero, unknown, faults, bounded peers and optional soft preference", () => {
  const { html, state } = app();
  expect(html).toContain("data-exploration-progress");
  expect(html).toContain("读取时排序预览（不是派发授权）");
  expect(html).not.toMatch(/x-html="[^"]*(?:exploration|suppression)/);
  expect(state.explorationStreakLabel(0)).toBe("0");
  for (const unknown of [null, undefined, -1, "0", Number.NaN]) expect(state.explorationStreakLabel(unknown)).toBe("未知");
  expect(state.explorationStatusLabel("operationally_incomplete")).toContain("不增计数");
  expect(state.explorationStatusLabel("unknown")).toContain("中断连续性");
  expect(state.explorationPeersLabel("同计划", { count: 12, intent_ids: ["i1", "<img src=x>"], omitted: 10 })).toContain("另省略 10");
  expect(state.explorationSuppressionLabel({ mode: "off", state: "off", reason: "disabled", base_priority: 50, effective_priority: 50 })).toContain("关闭");
  expect(state.explorationSuppressionLabel({ mode: "soft", state: "inactive", reason: "window_expired", base_priority: 50, effective_priority: 50 })).toContain("不滚动续期");
});

test("UI suppresses stale responses, clears old data and surfaces read failures", async () => {
  const { state } = app(); state.selectedProjectId = scene.projectId; state.selectedNode = { type: "intent", id: scene.intentId };
  const pending: Array<(value: unknown) => void> = [];
  state.api = (method: string) => { expect(method).toBe("GET"); return new Promise(resolve => pending.push(resolve)); };
  const first = state.loadIntentExperiment(), second = state.loadIntentExperiment();
  pending[1]!({ intent_id: scene.intentId, version: 2 }); await second;
  pending[0]!({ intent_id: scene.intentId, version: 1 }); await first;
  expect(state.experimentDetail().version).toBe(2);
  state.api = async () => { throw new Error("read failed"); }; await state.loadIntentExperiment();
  expect(state.experimentDetail()).toBeNull(); expect(state.experimentPanel.error).toContain("read failed");
  state.selectedNode = { type: "fact", id: "origin" }; await state.loadIntentExperiment();
  expect(state.experimentPanel.loading).toBe(false); expect(state.experimentDetail()).toBeNull();
});
