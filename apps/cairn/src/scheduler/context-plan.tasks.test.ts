import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildAgentContext, configureDatabase, createIntent, createProject,
  exportProjectYaml, getProjectDetail, renderAgentContextYaml,
  type AgentContextAudit, type CairnDatabase, type GraphExportAudit,
} from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { prepareTask, type PrepareTaskInput, type RunnableTaskKind } from "./tasks";
import type { ContextPlan } from "./context-plan";

const BASE = {
  server: "http://127.0.0.1:8000",
  runtime: { execution: "local", max_workers: 2, max_running_projects: 2, max_project_workers: 1,
    interval: 1, healthcheck_timeout: 10, worker_healthcheck: "disabled", prompt_group: "default" },
  tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 }, explore: { timeout: 30, conclude_timeout: 10 } },
  observer: { enabled: true, kernel_tasks: ["bootstrap", "reason", "explore", "conclude"] },
};
let dir: string;
let db: CairnDatabase;
let projectId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-context-plan-"));
  db = configureDatabase(join(dir, "db.sqlite"));
  projectId = db.withConn((conn) => {
    const project = createProject(conn, { title: "context plan", origin: "起点", goal: "目标",
      hints: null, bootstrap_enabled: false, scope: { targets: ["127.0.0.1:8080"] } });
    createIntent(conn, project.project.id, { from: ["origin"], description: "探索", creator: "test", worker: null });
    return project.project.id;
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function prepare(kind: RunnableTaskKind = "reason", extra: Partial<PrepareTaskInput> = {}) {
  return db.withConn((conn) => {
    const project = getProjectDetail(conn, projectId);
    let graphAudit: GraphExportAudit | undefined;
    const exportYaml = exportProjectYaml(conn, projectId, (value) => { graphAudit = value; });
    let agentContextAudit: AgentContextAudit | undefined;
    const bootstrap = kind === "bootstrap" || extra.concludeOf === "bootstrap";
    const agentContextYaml = bootstrap ? undefined : renderAgentContextYaml(buildAgentContext(conn, projectId, {
      kind,
      focusIntentId: project.intents[0]!.id,
      generatedAt: "2026-11-04T00:00:00Z",
      onAudit: (value) => { agentContextAudit = value; },
    }));
    return prepareTask({
      config: parseDispatchConfig(BASE), project, exportYaml, kind,
      intent: project.intents[0]!, scope: { targets: ["127.0.0.1:8080"] }, workspaceRoot: dir,
      ...(graphAudit === undefined ? {} : { graphAudit }),
      ...(agentContextYaml === undefined ? {} : { agentContextYaml }),
      ...(agentContextAudit === undefined ? {} : { agentContextAudit }),
      ...(kind === "conclude" ? { concludeOf: "explore", resumeFromHostSessionDir: join(dir, "previous-session") } : {}),
      ...extra,
    });
  });
}
const planOf = (prepared: ReturnType<typeof prepare>): ContextPlan => {
  expect(prepared.contextPlan.status).toBe("written");
  return JSON.parse(readFileSync(join(prepared.hostSessionDir, "context-plan.json"), "utf8"));
};
const sourceOf = (plan: ContextPlan, id: string) => plan.sources.find((source) => source.id === id)!;

describe("M47 task preparation integration", () => {
  test("writes a complete plan from final files without changing the WorkerTask contract", () => {
    const prepared = prepare();
    const plan = planOf(prepared);
    expect(plan.status).toBe("complete");
    expect(plan.task_id).toBe(prepared.task.taskId);
    const graph = readFileSync(prepared.hostGraphSnapshotPath);
    expect(sourceOf(plan, "graph")).toMatchObject({ bytes: graph.byteLength,
      sha256: createHash("sha256").update(graph).digest("hex"), read_requirement: "required" });
    expect(plan.totals.solver.required_initial_bytes).toBe(
      Buffer.byteLength(prepared.task.prompt) + graph.byteLength + readFileSync(prepared.hostAgentContextPath).byteLength);
    expect(plan.totals.observer.required_initial_bytes).toBe(readFileSync(join(prepared.hostSessionDir, "observer-context.json")).byteLength);
    const worker = JSON.parse(readFileSync(prepared.hostTaskPath, "utf8"));
    expect(worker).not.toHaveProperty("contextPlan");
    expect(worker).not.toHaveProperty("graphAudit");
    expect(worker.prompt).not.toContain("context-plan.json");
    expect(JSON.stringify(plan)).not.toContain(dir);
  });

  test("audit and off produce equivalent worker inputs and graph snapshots", () => {
    const audited = prepare();
    const offConfig = parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, context_plan: { mode: "off" } } });
    const off = prepare("reason", { config: offConfig });
    const normalize = (value: typeof off) => JSON.stringify(value.task).replaceAll(value.task.taskId, "TASK");
    expect(normalize(audited)).toBe(normalize(off));
    expect(readFileSync(audited.hostGraphSnapshotPath)).toEqual(readFileSync(off.hostGraphSnapshotPath));
    expect(readFileSync(audited.hostAgentContextPath)).toEqual(readFileSync(off.hostAgentContextPath));
    expect(off.contextPlan).toEqual({ status: "off" });
    expect(existsSync(join(off.hostSessionDir, "context-plan.json"))).toBe(false);
  });

  for (const kind of ["bootstrap", "reason", "explore", "conclude"] as const) {
    test(`${kind} accounts for the files the renderer actually references`, () => {
      const plan = planOf(prepare(kind));
      expect(sourceOf(plan, "graph").read_requirement).toBe(kind === "bootstrap" ? "optional" : "required");
      expect(sourceOf(plan, "investigation_state").read_requirement).toBe(kind === "bootstrap" ? "disabled" : "required");
      if (kind === "conclude") expect(plan.totals.solver.unknown_sources).toContain("resumed_history");
    });
  }

  test("bootstrap conclude has no mandatory graph and leaves restored history unknown", () => {
    const plan = planOf(prepare("conclude", { concludeOf: "bootstrap" }));
    expect(sourceOf(plan, "graph").read_requirement).toBe("optional");
    expect(sourceOf(plan, "investigation_state").disabled_reason).toBe("not_applicable");
    expect(sourceOf(plan, "resumed_history").bytes).toBeNull();
  });

  test("mock templates do not count an unreferenced graph as mandatory", () => {
    const config = parseDispatchConfig({ ...BASE, runtime: { ...BASE.runtime, prompt_group: "mock" } });
    const plan = planOf(prepare("reason", { config }));
    expect(sourceOf(plan, "graph").read_requirement).toBe("optional");
    // The separately appended investigation-state policy still asks for this file.
    expect(sourceOf(plan, "investigation_state").read_requirement).toBe("required");
  });

  test("strategy_context off is preserved and visible in the plan", () => {
    const config = parseDispatchConfig({ ...BASE, runtime: { ...BASE.runtime, strategy_context: "off" } });
    const prepared = prepare("reason", { config, agentContextYaml: undefined, agentContextAudit: undefined });
    const plan = planOf(prepared);
    expect(existsSync(prepared.hostAgentContextPath)).toBe(false);
    expect(sourceOf(plan, "investigation_state").disabled_reason).toBe("strategy_context_off");
    expect(prepared.task.prompt).not.toContain("# 调查状态");
  });

  test("a huge optional attachment does not inflate mandatory initial bytes", () => {
    const prepared = prepare("reason", { attachments: [{ id: 1, project_id: projectId,
      name: "input.bin", path: "attachments/input.bin", size: 32 * 1024 * 1024,
      sha256: "a".repeat(64), creator: "test", created_at: "2026-11-04T00:00:00Z" }] });
    const plan = planOf(prepared);
    expect(sourceOf(plan, "attachments").bytes).toBe(32 * 1024 * 1024);
    expect(plan.totals.solver.required_initial_bytes).toBeLessThan(32768);
    expect(plan.budget.status).toBe("within_budget");
    expect(prepared.task.prompt).toContain("attachments/input.bin");
  });

  test("container path mapping does not leak host paths or change counting rules", () => {
    const config = parseDispatchConfig({ ...BASE,
      runtime: { ...BASE.runtime, execution: "container" },
      container: { image: "test-worker", network_mode: "bridge", completed_action: "stop", workspace_root: dir } });
    const prepared = prepare("explore", { config,
      pathMapper: (path) => `/workspace/${path.slice(dir.length).replaceAll("\\", "/").replace(/^\//, "")}` });
    const plan = planOf(prepared);
    expect(prepared.task.graphSnapshotPath).toStartWith("/workspace/");
    expect(prepared.task.prompt).toContain("当前容器");
    expect(JSON.stringify(plan)).not.toContain(dir);
    expect(plan.sources.every((source) => source.path === null || !source.path.includes("/"))).toBe(true);
    expect(plan.totals.solver.prompt_bytes).toBe(Buffer.byteLength(prepared.task.prompt));
    expect(sourceOf(plan, "graph").bytes).toBe(readFileSync(prepared.hostGraphSnapshotPath).byteLength);
  });

  test("an unwritable diagnostic file does not prevent task preparation", () => {
    const prepared = prepare("explore", { pathMapper: (path) => {
      if (basename(path).startsWith("explore-")) mkdirSync(join(path, "context-plan.json"), { recursive: true });
      return path;
    } });
    expect(prepared.contextPlan.status).toBe("unavailable");
    expect(existsSync(prepared.hostTaskPath)).toBe(true);
    expect(JSON.parse(readFileSync(prepared.hostTaskPath, "utf8")).kind).toBe("explore");
  });

  test("normal task-file failures remain failures, not a fake audit success", () => {
    expect(() => prepare("explore", { pathMapper: (path) => {
      if (basename(path) === "graph.yaml") mkdirSync(path, { recursive: true });
      return path;
    } })).toThrow();
  });

  test("over-budget preparation leaves the task and its full prompt intact", () => {
    const config = parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, context_plan: { mode: "audit", max_initial_bytes: 1 } } });
    const prepared = prepare("explore", { config });
    expect(planOf(prepared).budget.status).toBe("over_budget");
    expect(prepared.task.prompt).toContain("# 完成校验");
    expect(prepared.task.scope.targets).toEqual(["127.0.0.1:8080"]);
    expect(prepared.task.hardDeadlineSeconds).toBe(30);
    expect(JSON.parse(readFileSync(prepared.hostTaskPath, "utf8")).prompt).toBe(prepared.task.prompt);
  });
});
