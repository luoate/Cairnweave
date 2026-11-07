import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { configureDatabase, concludeIntent, createIntent, createProject, getProjectDetail, listProjectRuns, type CairnDatabase } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { LocalRuntime } from "../runtime/local";
import { Scheduler } from "./loop";
let dir: string; let db: CairnDatabase; let projectId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-pack-dispatch-")); db = configureDatabase(join(dir, "db.sqlite"));
  db.withConn((conn) => {
    projectId = createProject(conn, { title: "compact dispatch", origin: "授权起点", goal: "objective goal",
      bootstrap_enabled: false, hints: null, scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    for (let i = 0; i < 120; i += 1) {
      const intent = createIntent(conn, projectId, { from: ["origin"], description: `history ${i}`, creator: "test", worker: null });
      concludeIntent(conn, projectId, intent.id, "test", `fact ${i}`);
    }
    createIntent(conn, projectId, { from: ["origin"], description: "held work", creator: "peer", worker: "peer" });
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
async function dispatch(mode: "off" | "shadow" | "apply", options: { maxBytes?: number; breakStore?: boolean; claim?: boolean; explore?: boolean; graphSlice?: boolean } = {}) {
  if (options.explore) db.withConn((conn) => createIntent(conn, projectId, {
    from: ["f050"], description: "fresh focus", creator: "test", worker: null,
  }));
  const config = parseDispatchConfig({ server: "http://127.0.0.1:8000",
    runtime: { execution: "local", max_workers: 1, max_running_projects: 1, max_project_workers: 1, interval: 1,
      healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
    tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 }, explore: { timeout: 30, conclude_timeout: 10 },
      context_pack: { mode }, context_plan: { max_initial_bytes: options.maxBytes ?? 131072 },
      // The pack exists to shrink the *full* legacy export; enable slicing explicitly in the
      // test that checks how the two features interact.
      graph_slice: { enabled: options.graphSlice ?? false } },
    budget: { max_project_tokens: 10000 }, observer: { enabled: false } });
  const logs: string[] = [];
  const runtime = new LocalRuntime({ local: config.local, log: (line) => logs.push(line), workerArgv: (path) =>
    [process.execPath, join(import.meta.dir, "testdata", "context-pack-worker.ts"), path, ...(options.claim ? ["claim"] : [])] });
  if (options.breakStore) {
    const original = runtime.mapPath.bind(runtime);
    runtime.mapPath = (path) => {
      if (basename(path).startsWith("reason-")) mkdirSync(join(path, "context-store"), { recursive: true });
      return original(path);
    };
  }
  const scheduler = new Scheduler({ db, config, runtime, workspaceRoot: join(dir, "workspace"), log: (line) => logs.push(line) });
  try {
    expect(scheduler.tick()).toBe(true); await scheduler.waitForIdle();
    if (options.explore) { expect(scheduler.tick()).toBe(true); await scheduler.waitForIdle(); }
    const runs = db.withConn((conn) => listProjectRuns(conn, projectId));
    expect(runs).toHaveLength(options.explore ? 2 : 1);
    expect(runs.at(-1)!.outcome).toBe(options.claim ? "rejected" : "success");
    expect(db.withConn((conn) => getProjectDetail(conn, projectId)).project.status).toBe("active");
    const sessions = join(dir, "workspace", projectId, ".cairn", "sessions");
    const session = join(sessions, readdirSync(sessions).find((name) => name.startsWith(options.explore ? "explore-" : "reason-"))!);
    return { logs, pack: JSON.parse(readFileSync(join(session, "context-read-proof.json"), "utf8")).input === "compact"
      ? Bun.YAML.parse(readFileSync(join(session, "context-pack.yaml"), "utf8")) as any : null, proof: JSON.parse(readFileSync(join(session, "context-read-proof.json"), "utf8")),
      plan: JSON.parse(readFileSync(join(session, "context-plan.json"), "utf8")),
      selection: JSON.parse(readFileSync(join(session, "context-selection.json"), "utf8")) };
  } finally { await scheduler.stop(); }
}

describe("M48 actual scheduler/worker acceptance", () => {
  test("explore receives project usage and task ceilings as pinned state", async () => {
    const { pack, plan, proof } = await dispatch("apply", { explore: true });
    expect(plan.kind).toBe("explore"); expect(proof.input).toBe("compact");
    expect(pack.core.budget.limit_tokens).toBe(10000);
    expect(pack.task.limits.hard_deadline_seconds).toBe(30);
    expect(pack.intents.find((intent: any) => intent.id === pack.task.focus_intent_id).description).toBe("fresh focus");
  });

  test("applies compact input and recovers an omitted fact with ordinary file reads", async () => {
    const { logs, proof, plan } = await dispatch("apply");
    expect(proof.input).toBe("compact"); expect(proof.recovered_id).toMatch(/^f/);
    expect(plan.version).toBe(2); expect(plan.budget.status).toBe("within_budget");
    expect(logs.some((line) => line.includes("context-pack applied"))).toBe(true);
  });
  test("shadow sends legacy input, not the candidate", async () => {
    const { proof, plan, logs } = await dispatch("shadow");
    expect(proof.input).toBe("legacy"); expect(plan.version).toBe(1);
    expect(logs.some((line) => line.includes("context-pack shadow"))).toBe(true);
  });
  for (const options of [{ maxBytes: 1 }, { breakStore: true }]) test(`safe fallback ${JSON.stringify(options)}`, async () => {
    const { proof, plan, logs } = await dispatch("apply", options);
    expect(proof.input).toBe("legacy"); expect(plan.version).toBe(1);
    expect(logs.some((line) => line.includes("context-pack fallback"))).toBe(true);
  });
  test("compact input does not allow seed-only completion to close a project", async () => {
    const { proof, logs } = await dispatch("apply", { claim: true });
    expect(proof.input).toBe("compact");
    expect(logs.some((line) => line.includes("context-pack applied"))).toBe(true);
  });
  test("sliced explore input already beats the pack, so it falls back to legacy", async () => {
    const { proof, selection, logs } = await dispatch("apply", { explore: true, graphSlice: true });
    expect(proof.input).toBe("legacy");
    expect(selection.status).toBe("fallback");
    expect(selection.fallback_reason).toBe("no_benefit");
    expect(selection.legacy_initial_bytes).toBeLessThan(selection.candidate_initial_bytes);
    expect(logs.some((line) => line.includes("context-pack fallback"))).toBe(true);
  });
});
