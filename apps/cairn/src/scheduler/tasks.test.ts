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

describe("intent budgets", () => {
  test("tightens the deadline and carries the tool-call ceiling", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      budget: { max_seconds: 5, max_tool_calls: 7 },
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    expect(prepared.task.hardDeadlineSeconds).toBe(5);
    expect(prepared.task.softDeadlineSeconds).toBe(4);
    expect(prepared.task.maxToolCalls).toBe(7);
  });

  test("appends the completion verification policy to the prompt", () => {
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

    expect(prepared.task.prompt).toContain("# Completion Verification");
    expect(prepared.task.prompt).toContain("evidence_refs");
    expect(prepared.task.prompt).toContain("exact flag string verbatim");
    expect(prepared.task.prompt).toContain("Credentials, tokens and other secrets");
    expect(prepared.task.prompt).toContain("never redact, mask or shorten");
  });

  test("lists uploaded challenge files for the worker to read", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
      attachments: [
        {
          id: 1,
          project_id: project.project.id,
          name: "challenge.pcap",
          path: "attachments/challenge.pcap",
          size: 4096,
          sha256: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          creator: "operator",
          created_at: "2026-10-31T00:00:00Z",
        },
      ],
    });

    const prompt = prepared.task.prompt;
    expect(prompt).toContain("# Challenge Attachments");
    expect(prompt).toContain("- `attachments/challenge.pcap` (4096 bytes, sha256 `1234567890ab`)");
    expect(prompt).toContain("never write into `attachments/`");
    // The operator's files are listed before the task's own output rules.
    expect(prompt.indexOf("# Challenge Attachments")).toBeLessThan(
      prompt.indexOf("# Completion Verification"),
    );
    // Listing them in the prompt is the whole handoff: the task contract is unchanged.
    expect(prepared.task as unknown as Record<string, unknown>).not.toHaveProperty("attachments");
  });

  test("omits the attachment section when the project has none", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
      attachments: [],
    });

    expect(prepared.task.prompt).not.toContain("# Challenge Attachments");
  });

  test("never extends the configured task timeout", () => {    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      budget: { max_seconds: 600 },
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    expect(prepared.task.hardDeadlineSeconds).toBe(30);
    expect(prepared.task.softDeadlineSeconds).toBe(24);
    expect(prepared.task.maxToolCalls).toBeUndefined();
  });
});

describe("worker profile dispatch", () => {
  test("stamps the selected profile and model on task.json", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workerProfile: { id: "fast", model: "cairn-worker" },
      workspaceRoot: directory,
    });

    expect(prepared.task.workerProfile).toBe("fast");
    expect(prepared.task.model).toBe("cairn-worker");
    const written = JSON.parse(readFileSync(prepared.taskPath, "utf8")) as {
      workerProfile?: string;
      model?: string;
    };
    expect(written.workerProfile).toBe("fast");
    expect(written.model).toBe("cairn-worker");
  });

  test("leaves the prompt model in charge when no profile is selected", () => {
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

    expect(prepared.task.workerProfile).toBeUndefined();
    expect(prepared.task.model).toBeUndefined();
  });
});

describe("reason prompt extensions", () => {
  test("documents priority, budget, dedupe, hints and resource usage", () => {
    const project = projectFixture();
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project,
      exportYaml: "project: p1\n",
      kind: "reason",
      intentMeta: [
        {
          project_id: "p1",
          intent_id: "i1",
          dedupe_key: "focus-direction",
          source: "strategist",
          proposal_id: null,
          origin_run_id: "run-1",
          priority: 90,
          budget: { max_seconds: 20 },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          project_id: "p1",
          intent_id: "i2",
          dedupe_key: null,
          source: "human",
          proposal_id: null,
          origin_run_id: null,
          priority: null,
          budget: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      projectBudget: {
        usedTokens: 800,
        maxTokens: 1000,
        usedCostUsd: 1.5,
        maxCostUsd: 10,
      },
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    const prompt = prepared.task.prompt;
    expect(prompt).toContain("# Strategist Output Extensions");
    expect(prompt).toContain('"dedupe_key": "upload-traversal"');
    expect(prompt).toContain("at most 3 hints");
    expect(prompt).toContain('"dedupe_key": "focus-direction"');
    expect(prompt).toContain('"priority": 90');
    expect(prompt).toContain('"max_seconds": 20');
    expect(prompt).toContain("# Resource Budget");
    expect(prompt).toContain("tokens: 800 / 1000 limit (80.0%)");
    expect(prompt).toContain("cost_usd: 1.5 / 10 limit (15.0%)");
  });

  test("omits the resource section when no budget snapshot is available", () => {
    const prepared = prepareTask({
      config: parseDispatchConfig(CONFIG),
      project: projectFixture(),
      exportYaml: "project: p1\n",
      kind: "reason",
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    expect(prepared.task.prompt).toContain("# Strategist Output Extensions");
    expect(prepared.task.prompt).not.toContain("# Resource Budget");
  });
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
      // Proposals default to enabled + dry_run, so the proposal contract is present.
      CAIRN_OBSERVER_PROPOSALS_ENABLED: "1",
      CAIRN_OBSERVER_PROPOSALS_DIR: prepared.observer.proposals!.dir,
      CAIRN_OBSERVER_PROJECT_ID: "p1",
      CAIRN_OBSERVER_TASK_ID: prepared.task.taskId,
      CAIRN_OBSERVER_PROPOSALS_ALLOW_KINDS: "fact,intent,hint",
      CAIRN_OBSERVER_PROPOSALS_MAX_PER_TASK: "20",
      CAIRN_OBSERVER_PROPOSALS_MAX_FILE_BYTES: "16384",
      CAIRN_OBSERVER_PROPOSALS_MAX_TOTAL_BYTES: "65536",
      CAIRN_OBSERVER_PROPOSALS_MIN_CONFIDENCE: "0",
      CAIRN_OBSERVER_PROPOSALS_REQUIRE_EVIDENCE: "1",
    });
  });

  test("exposes the proposal contract only when both Observer and proposals are enabled", () => {
    const project = projectFixture();
    const config = parseDispatchConfig({
      ...CONFIG,
      observer: {
        enabled: true,
        every_rounds: 3,
        window_rounds: 6,
        timeout_seconds: 15,
        max_reviews_per_task: 4,
        kernel_tasks: ["explore"],
      },
      proposals: {
        enabled: true,
        mode: "dry_run",
        max_per_task: 3,
        max_file_bytes: 2048,
        max_total_bytes: 4096,
        allow_kinds: ["hint", "fact"],
        min_confidence: 0.25,
        require_evidence_for_fact: false,
      },
    });
    const prepared = prepareTask({
      config,
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });

    expect(prepared.observer.proposals).toMatchObject({
      projectId: "p1",
      taskId: prepared.task.taskId,
      allowKinds: ["hint", "fact"],
      maxPerTask: 3,
      maxFileBytes: 2048,
      maxTotalBytes: 4096,
      minConfidence: 0.25,
      requireEvidenceForFact: false,
    });
    expect(prepared.observer.proposals!.dir).toBe(
      join(prepared.observer.stateDir, "proposals"),
    );
    expect(existsSync(prepared.observer.proposals!.dir)).toBe(true);

    expect(observerEnvironment(prepared.observer)).toMatchObject({
      CAIRN_OBSERVER_PROPOSALS_ENABLED: "1",
      CAIRN_OBSERVER_PROPOSALS_DIR: prepared.observer.proposals!.dir,
      CAIRN_OBSERVER_PROJECT_ID: "p1",
      CAIRN_OBSERVER_TASK_ID: prepared.task.taskId,
      CAIRN_OBSERVER_PROPOSALS_ALLOW_KINDS: "hint,fact",
      CAIRN_OBSERVER_PROPOSALS_MAX_PER_TASK: "3",
      CAIRN_OBSERVER_PROPOSALS_MAX_FILE_BYTES: "2048",
      CAIRN_OBSERVER_PROPOSALS_MAX_TOTAL_BYTES: "4096",
      CAIRN_OBSERVER_PROPOSALS_MIN_CONFIDENCE: "0.25",
      CAIRN_OBSERVER_PROPOSALS_REQUIRE_EVIDENCE: "0",
    });

    const off = prepareTask({
      config: parseDispatchConfig({
        ...CONFIG,
        observer: {
          enabled: true,
          every_rounds: 3,
          window_rounds: 6,
          timeout_seconds: 15,
          max_reviews_per_task: 4,
          kernel_tasks: ["explore"],
        },
        proposals: { enabled: true, mode: "off" },
      }),
      project,
      exportYaml: "project: p1\n",
      kind: "explore",
      intent: project.intents[0]!,
      scope: { targets: ["127.0.0.1:8080"] },
      workspaceRoot: directory,
    });
    expect(off.observer.proposals).toBeNull();
    expect(observerEnvironment(off.observer)).not.toHaveProperty(
      "CAIRN_OBSERVER_PROPOSALS_ENABLED",
    );
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

  test("turns on by default for a matching task kind", () => {
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

    expect(prepared.observer.enabled).toBe(true);
    expect(existsSync(join(directory, "p1", ".cairn", "board"))).toBe(true);
    expect(observerEnvironment(prepared.observer)["CAIRN_OBSERVER_ENABLED"]).toBe("1");
  });
});
