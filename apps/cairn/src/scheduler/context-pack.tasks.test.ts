import { experiment } from "../../../../packages/contracts/src/testdata/experiment";
import { checkpoint } from "../../../../packages/contracts/src/testdata/checkpoint";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildAgentContext, buildTaskContextSnapshot, configureDatabase, concludeIntent, createHint, createIntent,
  createProject, exportProjectSliceYaml, exportProjectYaml, getProjectDetail, markOperatorHint, recordFactMeta,
  renderAgentContextYaml, recordIntentMeta, listProjectIntentMeta, startRun, finishRun, registerCheckpointRun, acceptTaskCheckpoint, finalizeCheckpointRun, type AgentContextAudit, type CairnDatabase, type GraphExportAudit,
} from "@cairn/graph";
import { parseDispatchConfig } from "../config";
import { prepareTask, type PrepareTaskInput } from "./tasks";
import { recoverContextRecord } from "./context-store";
const BASE = { server: "http://127.0.0.1:8000",
  runtime: { execution: "local", max_workers: 2, max_running_projects: 2, max_project_workers: 1,
    interval: 1, healthcheck_timeout: 5, worker_healthcheck: "disabled", prompt_group: "default" },
  tasks: { bootstrap: { timeout: 30, conclude_timeout: 10 }, reason: { timeout: 30 }, explore: { timeout: 30, conclude_timeout: 10 } },
  observer: { enabled: true, kernel_tasks: ["reason", "explore"] },
};
let dir: string; let db: CairnDatabase; let projectId: string; let focus: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-pack-tasks-")); db = configureDatabase(join(dir, "db.sqlite"));
  db.withConn((conn) => {
    projectId = createProject(conn, { title: "pack integration", origin: "授权起点", goal: "已确认目标",
      scope: { targets: ["127.0.0.1:8080"] }, bootstrap_enabled: false, hints: null }).project.id;
    for (let index = 0; index < 100; index += 1) {
      const intent = createIntent(conn, projectId, { from: ["origin"], description: `历史方向 ${index}`, creator: "test", worker: null });
      concludeIntent(conn, projectId, intent.id, "test", `客观结果 ${index} ${"事实内容 ".repeat(10)}`);
    }
    for (let index = 0; index < 30; index += 1) createHint(conn, projectId, { content: `相关提示 ${index} ${"提示 ".repeat(30)}`, creator: "test" });
    focus = createIntent(conn, projectId, { from: ["f001"], description: "焦点任务", creator: "test", worker: null }).id;
    recordFactMeta(conn, { projectId, factId: "f100", evidenceStatus: "provided", supersedes: ["f001"], evidenceRefs: ["artifacts/proof.txt"] });
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function prepare(mode: "off" | "shadow" | "apply", extra: Partial<PrepareTaskInput> = {}, slice = false) {
  return db.withConn((conn) => {
    const project = getProjectDetail(conn, projectId); const kind = extra.kind ?? "reason";
    let graphAudit: GraphExportAudit | undefined; let agentContextAudit: AgentContextAudit | undefined;
    const exportYaml = slice ? exportProjectSliceYaml(conn, projectId, { focusIntentId: focus, maxFacts: 3, maxIntents: 3, onAudit: (value) => { graphAudit = value; } })
      : exportProjectYaml(conn, projectId, (value) => { graphAudit = value; });
    const agentContextYaml = renderAgentContextYaml(buildAgentContext(conn, projectId, { kind: kind === "bootstrap" ? "reason" : kind,
      focusIntentId: focus, generatedAt: "2026-11-05T00:00:00Z", onAudit: (value) => { agentContextAudit = value; } }));
    return prepareTask({ config: parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, context_pack: { mode } } }),
      project, kind, exportYaml, agentContextYaml, graphAudit: graphAudit!, agentContextAudit: agentContextAudit!,
      contextSnapshot: buildTaskContextSnapshot(conn, projectId), intent: project.intents.find((intent) => intent.id === focus)!,
      scope: { targets: ["127.0.0.1:8080"] }, workspaceRoot: dir,
      ...(kind === "conclude" ? { concludeOf: "explore" as const, resumeFromHostSessionDir: join(dir, "previous") } : {}), ...extra });
  });
}
const canonical = (prepared: ReturnType<typeof prepare>) => JSON.stringify(prepared.task).replaceAll(prepared.task.taskId, "TASK");

describe("M48 task rollout and actual delivery", () => {
  test("operator guidance stays pinned in apply/shadow/fallback prompts and is counted in initial bytes", () => {
    const id = db.withConn(conn => {
      const hint = createHint(conn, projectId, { content: "优先检查用户指定入口 /login", creator: "custom operator" });
      markOperatorHint(conn, projectId, hint.id); return hint.id;
    });
    for (const mode of ["off", "shadow", "apply"] as const) {
      const prepared = prepare(mode);
      expect(prepared.task.prompt).toStartWith("# 用户引导（优先处理）");
      expect(prepared.task.prompt).toContain("用户指定入口 /login");
      expect(prepared.operatorHintIds).toEqual([id]);
      if (mode === "apply") {
        expect(prepared.contextPack.status).toBe("applied");
        expect(prepared.contextPack.actual_initial_bytes).toBe(Buffer.byteLength(prepared.task.prompt) + readFileSync(join(prepared.hostSessionDir, "context-pack.yaml")).length);
      }
    }
    const fallback = prepare("apply", { config: parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks,
      context_pack: { mode: "apply" }, context_plan: { max_initial_bytes: 1 } } }) });
    expect(fallback.contextPack.status).toBe("fallback");
    expect(fallback.task.prompt).toContain("用户指定入口 /login");
  });
  test("literal placeholder-shaped directory names survive compact prompt rendering", () => {
    const applied = prepare("apply", { workspaceRoot: join(dir, "{intent_id}-{max_intents}") });
    expect(applied.contextPack.status).toBe("applied");
    expect(applied.task.prompt).toContain(join(applied.hostSessionDir, "context-pack.yaml"));
  });

  test("off has no new artifacts; shadow preserves exact worker inputs and v1 actual accounting", () => {
    const off = prepare("off"); const shadow = prepare("shadow");
    expect(canonical(shadow)).toBe(canonical(off));
    for (const name of ["context-pack.yaml", "context-store", "context-selection.json", "context-candidate.json"]) expect(existsSync(join(off.hostSessionDir, name))).toBe(false);
    expect(shadow.contextPack.status).toBe("shadow");
    expect(existsSync(join(shadow.hostSessionDir, "context-candidate.json"))).toBe(true);
    expect(shadow.contextPlan.status === "written" && shadow.contextPlan.plan.version).toBe(1);
    expect(readFileSync(off.hostGraphSnapshotPath)).toEqual(readFileSync(shadow.hostGraphSnapshotPath));
    expect(readFileSync(off.hostAgentContextPath)).toEqual(readFileSync(shadow.hostAgentContextPath));
  });

  test("apply replaces mandatory duplicates, reports v2 actual bytes and preserves task authority", () => {
    const off = prepare("off"); const applied = prepare("apply");
    expect(applied.contextPack.status).toBe("applied");
    expect(applied.task.prompt).toContain("context-pack.yaml");
    expect(applied.task.prompt).not.toContain("先完整读取该文件");
    expect(applied.task.prompt).not.toContain("# 调查状态");
    expect(applied.task.scope).toEqual(off.task.scope);
    expect(applied.task.hardDeadlineSeconds).toBe(off.task.hardDeadlineSeconds);
    expect(applied.task.softDeadlineSeconds).toBe(off.task.softDeadlineSeconds);
    expect(Object.keys(applied.task)).toEqual(Object.keys(off.task));
    expect(applied.contextPlan.status).toBe("written");
    if (applied.contextPlan.status !== "written") return;
    const plan = applied.contextPlan.plan;
    expect(plan.version).toBe(2);
    expect(plan.sources.filter((source) => source.consumer === "solver" && source.read_requirement === "required").map((source) => source.id)).toEqual(["prompt", "context_pack"]);
    expect(plan.totals.solver.required_initial_bytes).toBe(Buffer.byteLength(applied.task.prompt) + readFileSync(join(applied.hostSessionDir, "context-pack.yaml")).length);
    expect(plan.totals.solver.required_initial_bytes).toBe(applied.contextPack.actual_initial_bytes);
    expect(plan.totals.solver.required_initial_bytes).toBeLessThan(applied.contextPack.legacy_initial_bytes);
    if (off.contextPlan.status !== "written") throw new Error("missing legacy plan");
    expect(plan.totals.observer).toEqual(off.contextPlan.plan.totals.observer);
    expect(JSON.stringify(plan)).not.toContain(dir);
    expect(JSON.parse(readFileSync(applied.hostTaskPath, "utf8"))).not.toHaveProperty("contextPack");
  });

  test("explore pins direct sources and replacement facts; store is not built from a graph slice", () => {
    const applied = prepare("apply", { kind: "explore" });
    expect(applied.contextPack.status).toBe("applied");
    const pack = Bun.YAML.parse(readFileSync(join(applied.hostSessionDir, "context-pack.yaml"), "utf8")) as any;
    expect(pack.facts.find((fact: any) => fact.id === "f001")).toMatchObject({ status: "superseded", superseded_by: "f100" });
    expect(pack.facts.find((fact: any) => fact.id === "f100")).toMatchObject({ status: "current", evidence_refs: ["artifacts/proof.txt"] });
    const sliced = prepare("shadow", { kind: "explore" }, true);
    // A small legacy slice may beat the compact pack; both outcomes must be honest.
    if (sliced.contextPack.status === "shadow") {
      const recovered = recoverContextRecord(join(sliced.hostSessionDir, "context-store"), projectId, sliced.contextPack.snapshot_id!, "facts", "f050");
      expect(recovered).toMatchObject({ id: "f050", description: expect.stringContaining("客观结果 49") });
    } else expect(sliced.contextPack.fallback_reason).toBe("no_benefit");
  });

  test("over-budget core falls back to byte-equivalent legacy inputs without losing deadlines or scope", () => {
    const config = parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, context_pack: { mode: "apply" }, context_plan: { max_initial_bytes: 1 } } });
    const applied = prepare("apply", { config }); const off = prepare("off");
    expect(applied.contextPack).toMatchObject({ status: "fallback", fallback_reason: "pinned_content_over_budget" });
    expect(canonical(applied)).toBe(canonical(off));
    expect(applied.contextPlan.status === "written" && applied.contextPlan.plan.budget.status).toBe("over_budget");
  });

  test("snapshot failure preserves legacy input and does not expose the failed path", () => {
    const applied = prepare("apply", { pathMapper: (path) => {
      if (basename(path).startsWith("reason-")) mkdirSync(join(path, "context-store"), { recursive: true });
      return path;
    } });
    expect(applied.contextPack).toMatchObject({ status: "fallback", fallback_reason: "snapshot_write_failed" });
    expect(canonical(applied)).toBe(canonical(prepare("off")));
    expect(existsSync(applied.hostTaskPath)).toBe(true);
    expect(JSON.stringify(applied.contextPack)).not.toContain(dir);
  });

  test("missing snapshot falls back rather than claiming existing capped input is recoverable", () => {
    const applied = prepare("apply", { contextSnapshot: undefined });
    expect(applied.contextPack.fallback_reason).toBe("snapshot_unavailable");
    expect(canonical(applied)).toBe(canonical(prepare("off")));
  });

  test("diagnostic write errors do not undo a fully validated compact input", () => {
    const applied = prepare("apply", { pathMapper: (path) => {
      if (basename(path).startsWith("reason-")) {
        mkdirSync(join(path, "context-selection.json"), { recursive: true });
        mkdirSync(join(path, "context-plan.json"), { recursive: true });
      }
      return path;
    } });
    expect(applied.contextPack.status).toBe("applied");
    expect(applied.contextPlan.status).toBe("unavailable");
    expect(applied.task.prompt).toContain("context-pack.yaml");
    expect(existsSync(join(applied.hostSessionDir, "context-store", "catalog.json"))).toBe(true);
  });

  test("bootstrap, conclude and custom templates retain their legacy prompts", () => {
    for (const kind of ["bootstrap", "conclude"] as const) {
      const applied = prepare("apply", { kind });
      expect(applied.contextPack.fallback_reason).toBe("not_applicable");
      expect(canonical(applied)).toBe(canonical(prepare("off", { kind })));
    }
    const config = parseDispatchConfig({ ...BASE, runtime: { ...BASE.runtime, prompt_group: "mock" }, tasks: { ...BASE.tasks, context_pack: { mode: "apply" } } });
    const applied = prepare("apply", { config });
    expect(applied.contextPack.fallback_reason).toBe("unsupported_template");
    expect(existsSync(join(applied.hostSessionDir, "context-pack.yaml"))).toBe(false);
  });

  test("container mapping uses worker paths and attachments remain optional bodies", () => {
    const config = parseDispatchConfig({ ...BASE, runtime: { ...BASE.runtime, execution: "container" },
      container: { image: "test", network_mode: "bridge", completed_action: "stop", workspace_root: dir },
      tasks: { ...BASE.tasks, context_pack: { mode: "apply" } } });
    const applied = prepare("apply", { config,
      pathMapper: (path) => `/workspace/${path.slice(dir.length).replaceAll("\\", "/").replace(/^\//, "")}`,
      attachments: [{ id: 1, project_id: projectId, name: "input.bin", path: "attachments/input.bin", size: 32000000,
        sha256: "a".repeat(64), creator: "test", created_at: "2026-11-05T00:00:00Z" }] });
    expect(applied.contextPack.status).toBe("applied");
    expect(applied.task.prompt).toContain("/workspace/");
    expect(applied.task.prompt).not.toContain(dir);
    expect(applied.contextPack.actual_initial_bytes).toBeLessThan(131072);
    expect(applied.contextPlan.status === "written" && applied.contextPlan.plan.sources.find((source) => source.id === "attachments")!.bytes).toBe(32000000);
  });
});


describe("M51a experiment delivery", () => {
  function storePlan() {
    return db.withConn(conn => {
      recordIntentMeta(conn, { projectId, intentId: focus, source: "strategist", experiment: experiment() });
      return listProjectIntentMeta(conn, projectId);
    });
  }
  test("keeps literal plan data in off/shadow/apply and mandatory focus records, including exact byte accounting", () => {
    const intentMeta = storePlan();
    for (const mode of ["off", "shadow", "apply"] as const) {
      const prepared = prepare(mode, { kind: "explore", intentMeta });
      expect(prepared.task.prompt).toContain(JSON.stringify(experiment()));
      expect(prepared.task.prompt).toContain("{intent_id}");
      expect(prepared.task.prompt).toContain("未验证计划数据");
      expect(prepared.task.scope.targets).toEqual(["127.0.0.1:8080"]);
      expect(prepared.task.hardDeadlineSeconds).toBe(30);
      expect(prepared.task).not.toHaveProperty("experiment");
      if (mode === "apply") {
        expect(prepared.contextPack.status).toBe("applied");
        const pack = Bun.YAML.parse(readFileSync(join(prepared.hostSessionDir, "context-pack.yaml"), "utf8")) as any;
        expect(pack.intents.find((i: any) => i.id === focus)?.experiment).toEqual(experiment());
        expect(recoverContextRecord(join(prepared.hostSessionDir, "context-store"), projectId, prepared.contextPack.snapshot_id!, "intents", focus))
          .toMatchObject({ experiment: experiment() });
        expect(prepared.contextPack.actual_initial_bytes).toBe(Buffer.byteLength(prepared.task.prompt) + readFileSync(join(prepared.hostSessionDir, "context-pack.yaml")).length);
      }
    }
  });
  test("includes the plan in explore conclude, not bootstrap conclude, and leaves legacy intents unchanged", () => {
    const intentMeta = storePlan();
    expect(prepare("off", { kind: "conclude", intentMeta }).task.prompt).toContain(JSON.stringify(experiment()));
    expect(prepare("off", { kind: "conclude", concludeOf: "bootstrap", intentMeta }).task.prompt).not.toContain("# 当前探索契约");
    expect(prepare("off", { kind: "explore" }).task.prompt).not.toContain("# 当前探索契约");
    expect(prepare("off", { kind: "reason", intentMeta }).task.prompt).toContain("新建 intent 时可附加 experiment");
  });
  test("tells the model that experiment is exactly six keys and version is required", () => {
    // proj_047 lost three reason turns because `experiment` came back with the five text
    // fields and no `version`, while the contract requires exactly six keys. The
    // instruction has to say so outright instead of only showing it in the example.
    const prompt = prepare("off", { kind: "reason" }).task.prompt;
    expect(prompt).toContain("version 必须是数字 1");
    expect(prompt).toContain("恰好六个键");
    expect(prompt).toContain("全部作废");
  });
  test("over-budget fallback retains the entire experiment plan instead of silently trimming it", () => {
    const intentMeta = storePlan();
    const config = parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, context_pack: { mode: "apply" }, context_plan: { max_initial_bytes: 1 } } });
    const prepared = prepare("apply", { config, kind: "explore", intentMeta });
    expect(prepared.contextPack.status).toBe("fallback");
    expect(prepared.task.prompt).toContain(JSON.stringify(experiment()));
    expect(canonical(prepared)).toBe(canonical(prepare("off", { kind: "explore", intentMeta })));
  });
});

describe("M52a/b observe-only delivery", () => {
  function monitored() {
    return db.withConn(conn => {
      focus = createIntent(conn, projectId, { from: ["f100"], description: "可合理复验的方向", creator: "test", worker: null }).id;
      recordIntentMeta(conn, { projectId, intentId: focus, experiment: experiment(), priority: 7 });
      for (let index = 0; index < 2; index++) {
        const runId = `m52-${index}`, taskId = `m52-task-${index}`;
        startRun(conn, { id: runId, projectId, intentId: focus, taskId, kind: "explore", worker: "test", startedAt: `2026-11-05T00:0${index}:00Z` });
        registerCheckpointRun(conn, runId, ["127.0.0.1:8080"], experiment());
        const value = checkpoint({ project_id: projectId, task_id: taskId, intent_id: focus });
        value.attempts[0] = { ...value.attempts[0]!, result: "observed", observation: "相同观察报告", fact_refs: ["f100"], evidence_refs: ["evidence/proof.txt"] };
        expect(acceptTaskCheckpoint(conn, { runId, projectId, taskId, bytes: Buffer.from(JSON.stringify(value)) })).toBe("accepted");
        finishRun(conn, runId, { outcome: "success", durationMs: 1, finishedAt: `2026-11-05T00:1${index}:00Z` });
        finalizeCheckpointRun(conn, runId, "finished");
      }
      return { intentMeta: listProjectIntentMeta(conn, projectId), contextSnapshot: buildTaskContextSnapshot(conn, projectId, {
        checkpoint: { scopeTargets: ["127.0.0.1:8080"], evidenceStatus: () => "available" },
      }) };
    });
  }
  test("applied pack and authorized recovery preserve complete monitors with honest byte accounting", () => {
    const input = monitored();
    for (const kind of ["reason", "explore"] as const) {
      const off = prepare("off", { ...input, kind }), applied = prepare("apply", { ...input, kind });
      expect(applied.contextPack.status).toBe("applied");
      expect(applied.task.prompt).toContain("M52a/b，只读提示");
      const pack = Bun.YAML.parse(readFileSync(join(applied.hostSessionDir, "context-pack.yaml"), "utf8")) as any;
      expect(pack.intents.find((item: any) => item.id === focus).exploration).toMatchObject({ mode: "observe_only", consecutive_without_new_observation: 1 });
      const store = join(applied.hostSessionDir, "context-store"), id = applied.contextPack.snapshot_id!;
      expect(recoverContextRecord(store, projectId, id, "intents", focus)).toEqual(input.contextSnapshot.intents.find(item => item.id === focus)!);
      expect(recoverContextRecord(store, projectId, id, "attempts", "m52-1")).toEqual(input.contextSnapshot.attempts.find(item => item.run_id === "m52-1")!);
      expect(applied.contextPack.actual_initial_bytes).toBe(Buffer.byteLength(applied.task.prompt) + readFileSync(join(applied.hostSessionDir, "context-pack.yaml")).length);
      expect(applied.task.scope).toEqual(off.task.scope);
      expect(applied.task.hardDeadlineSeconds).toBe(off.task.hardDeadlineSeconds);
      expect(applied.task.intentId).toBe(off.task.intentId);
      expect(db.withConn(conn => getProjectDetail(conn, projectId)).intents.find(item => item.id === focus)!.to).toBeNull();
    }
  });
  test("off, shadow and budget fallback never introduce a new mandatory historical prompt", () => {
    const input = monitored();
    const off = prepare("off", input), shadow = prepare("shadow", input);
    expect(canonical(shadow)).toBe(canonical(off));
    expect(off.task.prompt).not.toContain("M52a/b，只读提示");
    const config = parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, context_pack: { mode: "apply" }, context_plan: { max_initial_bytes: 1 } } });
    const fallback = prepare("apply", { ...input, config });
    expect(fallback.contextPack.status).toBe("fallback");
    expect(canonical(fallback)).toBe(canonical(off));
    expect(fallback.task.prompt).not.toContain("M52a/b，只读提示");
  });
});

describe("M49 prepared task byte accounting", () => {
  test("checkpoint guidance and complete attempt memory enter the actual M48 byte budget, not an unbounded mandatory file", () => {
    const snapshot = db.withConn((conn) => {
      startRun(conn, { id: "checkpoint-run", projectId, taskId: "explore-old", intentId: focus, kind: "explore", worker: "test", startedAt: "2026-11-05T00:00:00Z" });
      registerCheckpointRun(conn, "checkpoint-run", ["127.0.0.1:8080"]);
      acceptTaskCheckpoint(conn, { runId: "checkpoint-run", projectId, taskId: "explore-old", bytes: Buffer.from(JSON.stringify(checkpoint({ project_id: projectId, task_id: "explore-old", intent_id: focus }))) });
      finishRun(conn, "checkpoint-run", { outcome: "failed", finishedAt: "2026-11-05T00:01:00Z", durationMs: 1 });
      return buildTaskContextSnapshot(conn, projectId, { checkpoint: {} });
    });
    const config = parseDispatchConfig({ ...BASE, tasks: { ...BASE.tasks, checkpoint: { enabled: true }, context_pack: { mode: "apply" } } });
    const prepared = prepare("apply", { config, contextSnapshot: snapshot });
    expect(prepared.contextPack.status).toBe("applied");
    expect(prepared.task.prompt).toContain("save_task_checkpoint");
    const pack = Bun.YAML.parse(readFileSync(join(prepared.hostSessionDir, "context-pack.yaml"), "utf8")) as any;
    expect(pack.attempts[0].memory.trust).toBe("worker_claim_not_verified");
    expect(pack.attempts[0].memory.experiment_result).toEqual(snapshot.attempts[0]?.memory?.experiment_result);
    expect(pack.attempts[0].memory.experiment_result).toMatchObject({ status: "operationally_incomplete", hypothesis_verdict: "unknown",
      observations: [{ attempt_id: "a1", reported_result: "tool_failure", evidence: "unavailable" }] });
    expect(prepared.contextPlan.status).toBe("written");
    if (prepared.contextPlan.status !== "written") throw new Error("no plan");
    const plan = prepared.contextPlan.plan;
    expect(plan.totals.solver.required_initial_bytes).toBe(Buffer.byteLength(prepared.task.prompt) + readFileSync(join(prepared.hostSessionDir, "context-pack.yaml")).length);
    expect(plan.totals.solver.required_initial_bytes).toBeLessThanOrEqual(config.tasks.contextPlan.maxInitialBytes);
    expect(plan.sources.filter((s) => s.read_requirement === "required" && s.consumer === "solver").map((s) => s.id)).toEqual(["prompt", "context_pack"]);
    expect(plan.sources.find((s) => s.id === "context_pack")?.selections.find((s) => s.section === "attempts")?.policy).toBe("structured_attempt_memory_balanced_v1");
    expect(recoverContextRecord(join(prepared.hostSessionDir, "context-store"), projectId, prepared.contextPack.snapshot_id!, "attempts", "checkpoint-run")).toEqual(snapshot.attempts[0]);
    expect(prepared.task).not.toHaveProperty("checkpoint");
  });
});
