import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectDetail } from "@cairn/graph";

import { parseDispatchConfig } from "../config";
import { observerEnvironment, prepareTask } from "./tasks";

const CONFIG = {
  server: "http://127.0.0.1:8000",
  runtime: {
    execution: "local",
    max_workers: 2,
    max_running_projects: 2,
    max_project_workers: 1,
    interval: 1,
    healthcheck_timeout: 15,
    worker_healthcheck: "disabled",
    prompt_group: "default",
  },
  tasks: {
    bootstrap: { timeout: 30, conclude_timeout: 10 },
    reason: { timeout: 30, max_intents: 3 },
    explore: { timeout: 30, conclude_timeout: 10 },
  },
  local: { completed_action: "keep" },
  worker: {
    soft_deadline_ratio: 0.8,
    retain_task_files: true,
    result_grace_seconds: 2,
  },
};

function observerConfig(kernelTasks: string[] = ["explore"]) {
  return parseDispatchConfig({
    ...CONFIG,
    observer: {
      enabled: true,
      model: "cheap-review",
      every_rounds: 3,
      window_rounds: 6,
      timeout_seconds: 15,
      max_reviews_per_task: 4,
      kernel_tasks: kernelTasks,
    },
  });
}

function projectFixture(): ProjectDetail {
  const facts = [
    { id: "origin", description: "start" },
    { id: "goal", description: "finish" },
    ...Array.from({ length: 33 }, (_value, index) => ({
      id: `f${index + 1}`,
      description: `fact ${index + 1}`,
    })),
  ];
  return {
    project: {
      id: "p1",
      title: "observer project",
      status: "active",
      bootstrap_enabled: false,
      created_at: "2026-01-01T00:00:00Z",
      reason: null,
    },
    facts,
    intents: [
      {
        id: "i1",
        from: ["origin"],
        to: null,
        description: "focus intent",
        creator: "reason",
        worker: null,
        last_heartbeat_at: null,
        created_at: "2026-01-01T00:00:00Z",
        concluded_at: null,
      },
      {
        id: "i2",
        from: ["f1"],
        to: null,
        description: "other open intent",
        creator: "reason",
        worker: null,
        last_heartbeat_at: null,
        created_at: "2026-01-01T00:00:00Z",
        concluded_at: null,
      },
      {
        id: "i3",
        from: ["f2"],
        to: "f3",
        description: "closed intent",
        creator: "reason",
        worker: "cairn-worker",
        last_heartbeat_at: null,
        created_at: "2026-01-01T00:00:00Z",
        concluded_at: "2026-01-01T00:00:00Z",
      },
    ],
    hints: Array.from({ length: 12 }, (_value, index) => ({
      id: `h${index + 1}`,
      content: `hint ${index + 1}`,
      creator: "human",
      created_at: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
    })),
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-observer-task-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("Observer task preparation", () => {
  test("writes a bounded context snapshot and env for an enabled explore task", () => {
    const project = projectFixture();
    const config = observerConfig();
    const prepared = prepareTask({
      config,
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"], notes: "lab only" },
      workspaceRoot: directory,
    });

    expect(prepared.observer.enabled).toBe(true);
    const workspace = join(directory, "p1");
    expect(prepared.observer.boardDir).toBe(join(workspace, ".cairn", "board"));
    expect(prepared.observer.stateDir).toBe(
      join(workspace, ".cairn", "sessions", prepared.task.taskId, "observer"),
    );
    expect(existsSync(prepared.observer.boardDir)).toBe(true);
    expect(existsSync(prepared.observer.stateDir)).toBe(true);
    expect(existsSync(prepared.observer.contextPath)).toBe(true);

    const context = JSON.parse(
      readFileSync(prepared.observer.contextPath, "utf8"),
    ) as {
      project: { id: string; title: string };
      focus: { task_id: string; kind: string; intent_id: string; intent_description: string };
      scope: { targets: string[]; notes: string };
      open_intents: { id: string }[];
      facts: { id: string }[];
      hints: { content: string }[];
    };
    expect(context.project).toEqual({ id: "p1", title: "observer project" });
    expect(context.focus).toEqual({
      task_id: prepared.task.taskId,
      kind: "explore",
      intent_id: "i1",
      intent_description: "focus intent",
    });
    expect(context.scope).toEqual({
      targets: ["127.0.0.1:8080"],
      notes: "lab only",
    });
    expect(context.open_intents.map((intent) => intent.id)).toEqual(["i1", "i2"]);
    // origin/goal are always retained, then the newest facts up to the cap.
    expect(context.facts).toHaveLength(30);
    expect(context.facts[0]!.id).toBe("origin");
    expect(context.facts[1]!.id).toBe("goal");
    expect(context.facts.some((fact) => fact.id === "f1")).toBe(false);
    expect(context.facts.at(-1)!.id).toBe("f33");
    expect(context.hints).toHaveLength(10);
    expect(context.hints[0]!.content).toBe("hint 3");

    expect(observerEnvironment(prepared.observer)).toEqual({
      CAIRN_OBSERVER_ENABLED: "1",
      CAIRN_OBSERVER_CONTEXT_PATH: prepared.observer.contextPath,
      CAIRN_OBSERVER_BOARD_DIR: prepared.observer.boardDir,
      CAIRN_OBSERVER_STATE_DIR: prepared.observer.stateDir,
      CAIRN_OBSERVER_EVERY_ROUNDS: "3",
      CAIRN_OBSERVER_WINDOW_ROUNDS: "6",
      CAIRN_OBSERVER_TIMEOUT_SECONDS: "15",
      CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK: "4",
      CAIRN_OBSERVER_MODEL: "cheap-review",
    });
  });

  test("keeps the focused intent visible when the open-intent cap is exceeded", () => {
    const base = projectFixture();
    const intents: ProjectDetail["intents"] = Array.from({ length: 25 }, (_value, index) => ({
      id: `i${index}`,
      from: ["origin"],
      to: null,
      description: `open intent ${index}`,
      creator: "reason",
      worker: null,
      last_heartbeat_at: null,
      created_at: "2026-01-01T00:00:00Z",
      concluded_at: null,
    }));
    const project: ProjectDetail = { ...base, intents };
    const prepared = prepareTask({
      config: observerConfig(),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: intents[24]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    const context = JSON.parse(
      readFileSync(prepared.observer.contextPath, "utf8"),
    ) as { open_intents: { id: string }[] };
    expect(context.open_intents).toHaveLength(20);
    expect(context.open_intents[0]!.id).toBe("i24");
    expect(context.open_intents.some((intent) => intent.id === "i24")).toBe(true);
  });

  test("does not write context for a task kind outside kernel_tasks", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: observerConfig(["explore"]),
      project,
      exportYaml: "project: p1\n",
      kind: "reason",
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    expect(prepared.observer.enabled).toBe(false);
    expect(existsSync(prepared.observer.contextPath)).toBe(false);
    expect(observerEnvironment(prepared.observer)).toEqual({
      CAIRN_OBSERVER_ENABLED: "0",
    });
  });

  test("stays off by default even when the task kind would match", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    expect(prepared.observer.enabled).toBe(false);
    expect(existsSync(join(directory, "p1", ".cairn", "board"))).toBe(false);
    expect(observerEnvironment(prepared.observer)).toEqual({
      CAIRN_OBSERVER_ENABLED: "0",
    });
  });
});
