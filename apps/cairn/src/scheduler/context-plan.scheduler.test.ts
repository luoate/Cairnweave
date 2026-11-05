import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { configureDatabase, createIntent, createProject, getProjectDetail, listProjectRuns, type CairnDatabase } from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { LocalRuntime } from "../runtime/local";
import { Scheduler } from "./loop";
import type { ContextPlan } from "./context-plan";
let dir: string;
let db: CairnDatabase;
let projectId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-context-dispatch-"));
  db = configureDatabase(join(dir, "db.sqlite"));
  projectId = db.withConn((conn) => {
    const id = createProject(conn, { title: "audit-dispatch", origin: "start", goal: "finish",
      bootstrap_enabled: false, hints: null, scope: { targets: ["127.0.0.1:8080"] } }).project.id;
    // Existing in-flight work makes an empty reason response a legitimate no-op.
    createIntent(conn, id, { from: ["origin"], description: "held work", creator: "peer", worker: "peer" });
    return id;
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function dispatch(mode: "audit" | "off", breakAudit = false, strategyContext = "on") {
  const config = parseDispatchConfig({ server: "http://127.0.0.1:8000",
    runtime: { execution: "local", max_workers: 1, max_running_projects: 1, max_project_workers: 1,
      interval: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default", strategy_context: strategyContext },
    tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 },
      explore: { timeout: 30, conclude_timeout: 10 }, context_plan: { mode, max_initial_bytes: 1 } },
    observer: { enabled: false },
  });
  const logs: string[] = [];
  const runtime = new LocalRuntime({ local: config.local, log: (line) => logs.push(line),
    workerArgv: (path) => [process.execPath, join(import.meta.dir, "testdata", "successful-reason-worker.ts"), path] });
  if (breakAudit) {
    const map = runtime.mapPath.bind(runtime);
    runtime.mapPath = (path) => {
      if (basename(path).startsWith("reason-")) mkdirSync(join(path, "context-plan.json"), { recursive: true });
      return map(path);
    };
  }
  const loop = new Scheduler({ db, config, runtime, workspaceRoot: join(dir, "workspace"), log: (line) => logs.push(line) });
  try {
    expect(loop.tick()).toBe(true);
    await loop.waitForIdle();
    const runs = db.withConn((conn) => listProjectRuns(conn, projectId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: "reason", outcome: "success" });
    expect(db.withConn((conn) => getProjectDetail(conn, projectId)).project.status).toBe("active");
    const sessions = join(dir, "workspace", projectId, ".cairn", "sessions");
    const session = join(sessions, readdirSync(sessions)[0]!);
    return { logs, session };
  } finally {
    await loop.stop();
  }
}

describe("M47 real scheduler with a deterministic worker", () => {
  test("over-budget audit logs and records real selector metadata without blocking dispatch", async () => {
    const { logs, session } = await dispatch("audit");
    const plan = JSON.parse(readFileSync(join(session, "context-plan.json"), "utf8")) as ContextPlan;
    expect(plan.status).toBe("complete");
    expect(plan.budget.status).toBe("over_budget");
    expect(plan.sources.find((source) => source.id === "graph")!.selections[0]).toMatchObject({ candidates: 2, selected: 2 });
    expect(plan.sources.find((source) => source.id === "investigation_state")!.selections[0]).toMatchObject({ candidates: 2, selected: 2 });
    expect(logs.some((line) => line.includes("context-plan over_budget"))).toBe(true);
    expect(logs.some((line) => line.includes("dispatched reason"))).toBe(true);
    expect(logs.some((line) => line.includes("task prepare failed"))).toBe(false);
  });

  test("off leaves no plan or context-audit logs and still runs the worker", async () => {
    const { logs, session } = await dispatch("off");
    expect(existsSync(join(session, "context-plan.json"))).toBe(false);
    expect(logs.some((line) => line.includes("context-plan"))).toBe(false);
  });

  test("an audit write failure logs unavailable but the worker still succeeds", async () => {
    const { logs, session } = await dispatch("audit", true);
    expect(existsSync(join(session, "task.json"))).toBe(true);
    expect(logs.some((line) => line.includes("context-plan unavailable"))).toBe(true);
    expect(logs.some((line) => line.includes("task prepare failed"))).toBe(false);
  });

  test("strategy_context off remains off through the full dispatch path", async () => {
    const { session } = await dispatch("audit", false, "off");
    const plan = JSON.parse(readFileSync(join(session, "context-plan.json"), "utf8")) as ContextPlan;
    expect(existsSync(join(session, "agent-context.yaml"))).toBe(false);
    expect(plan.sources.find((source) => source.id === "investigation_state")!.disabled_reason).toBe("strategy_context_off");
  });
});
