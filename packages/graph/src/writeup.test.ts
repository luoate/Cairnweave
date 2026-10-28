import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProjectWriteup,
  clearProjectWriteup,
  concludeIntent,
  configureDatabase,
  createHint,
  createIntent,
  createProject,
  finishRun,
  getProjectWriteup,
  heartbeatIntent,
  recordFactMeta,
  recordProjectArtifacts,
  recordVerificationCheck,
  renderProjectWriteupMarkdown,
  renderProjectWriteupPrompt,
  run,
  saveProjectWriteup,
  setProjectVerification,
  startRun,
  type BuildProjectWriteupOptions,
  type CairnDatabase,
  type ProjectWriteupSnapshot,
} from "./index";

const FIXTURE_FLAG = "CTF2{fixture_flag_value}";

let directory: string;
let workspace: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-writeup-"));
  workspace = join(directory, "workspace");
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "签到题复盘",
        origin: "目标 http://127.0.0.1:8080 提供登录页",
        goal: "拿到后台 Flag",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"], notes: "仅限本机实验室环境" },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Concludes an intent from origin and returns `{ intentId, factId }`. */
function step(description: string, supersedes: readonly string[] = []) {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description,
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    const { fact } = concludeIntent(conn, projectId, intent.id, "cairn-worker", description, {
      supersedes,
    });
    return { intentId: intent.id, factId: fact.id };
  });
}

function snapshot(options: BuildProjectWriteupOptions = {}): ProjectWriteupSnapshot {
  return db.withConn((conn) =>
    buildProjectWriteup(conn, projectId, { generatedAt: "2026-10-28T12:00:00Z", ...options }),
  );
}

describe("buildProjectWriteup", () => {
  test("returns an empty Chinese draft for a fresh project", () => {
    const result = snapshot();

    expect(result.generated_at).toBe("2026-10-28T12:00:00Z");
    expect(result.project).toEqual({
      id: projectId,
      title: "签到题复盘",
      status: "active",
      created_at: result.project.created_at,
      challenge_code: null,
      targets: ["127.0.0.1:8080"],
      scope_notes: "仅限本机实验室环境",
    });
    expect(result.origin).toContain("登录页");
    expect(result.goal).toBe("拿到后台 Flag");
    expect(result.steps).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.flag).toBeNull();
    expect(result.verification).toEqual({
      kind: "evidence",
      checks: { total: 0, passed: 0, failed: 0, last_checked_at: null },
      latest: null,
    });
    expect(result.artifacts).toEqual([]);

    const markdown = renderProjectWriteupMarkdown(result);
    expect(markdown).toContain("# Writeup：签到题复盘");
    expect(markdown).toContain("## 攻击路径");
    expect(markdown).toContain("（没有已完成的探索意图）");
    expect(markdown).toContain("- Flag：未捕获");
    expect(markdown).toContain("- 授权范围：127.0.0.1:8080");
    expect(markdown).toContain("- 范围备注：仅限本机实验室环境");
  });

  test("applies the caller's fallback policy to legacy projects", () => {
    expect(snapshot().verification.kind).toBe("evidence");
    // Projects created before M14a have no pinned policy row at all.
    db.withConn((conn) =>
      run(conn, "DELETE FROM project_verification WHERE project_id = ?", projectId),
    );
    expect(snapshot({ verificationFallback: "off" }).verification.kind).toBe("off");
    expect(renderProjectWriteupMarkdown(snapshot({ verificationFallback: "off" }))).toContain(
      "- 校验策略：off",
    );
  });

  test("maps concluded intents to attack-path steps with run and evidence detail", () => {
    const first = step("信息收集：探测登录接口");
    const second = step("SQL 注入绕过登录");
    db.withConn((conn) => {
      startRun(conn, {
        id: "run-1",
        projectId,
        taskId: "task-1",
        kind: "solver",
        intentId: first.intentId,
        worker: "cairn-worker",
        startedAt: "2026-10-28T11:00:00Z",
      });
      finishRun(conn, "run-1", {
        outcome: "success",
        finishedAt: "2026-10-28T11:01:00Z",
        durationMs: 60_000,
        model: "demo/model-a",
        usage: { totalTokens: 1200, costUsd: 0.01 },
      });
      recordFactMeta(conn, {
        projectId,
        factId: first.factId,
        runId: "run-1",
        evidenceRefs: ["findings.md"],
        evidenceStatus: "provided",
      });
      startRun(conn, {
        id: "run-2",
        projectId,
        taskId: "task-2",
        kind: "solver",
        intentId: second.intentId,
        worker: "cairn-worker",
        startedAt: "2026-10-28T11:02:00Z",
      });
      finishRun(conn, "run-2", {
        outcome: "failed",
        finishedAt: "2026-10-28T11:03:00Z",
        durationMs: 60_000,
        model: "demo/model-a",
        usage: { totalTokens: 800, costUsd: 0.005 },
      });
      recordFactMeta(conn, {
        projectId,
        factId: second.factId,
        runId: "run-2",
        evidenceRefs: [],
        evidenceStatus: "missing",
      });
      createHint(conn, projectId, {
        content: "操作员提示：注意注册接口",
        creator: "operator",
      });
    });

    const result = snapshot({ flag: { value: FIXTURE_FLAG, source: "findings.md" } });
    expect(result.steps.map((entry) => entry.fact_id)).toEqual([first.factId, second.factId]);
    expect(result.steps[0]).toMatchObject({
      intent_id: first.intentId,
      description: "信息收集：探测登录接口",
      from: ["origin"],
      run_id: "run-1",
      worker: "cairn-worker",
      model: "demo/model-a",
      outcome: "success",
      evidence: ["findings.md"],
    });
    expect(result.steps[1]).toMatchObject({ outcome: "failed", evidence: [] });
    expect(result.findings.map((fact) => fact.id)).toEqual([first.factId, second.factId]);
    expect(result.hints.map((hint) => hint.content)).toEqual([
      "操作员提示：注意注册接口",
    ]);
    expect(result.runs).toMatchObject({ runs: 2, finished: 2, succeeded: 1, failed: 1, tokens: 2000 });
    expect(result.runs.by_worker[0]).toMatchObject({ worker: "cairn-worker", runs: 2 });
    expect(result.runs.by_model[0]).toMatchObject({ model: "demo/model-a", runs: 2 });
    expect(result.flag).toEqual({ value: FIXTURE_FLAG, source: "findings.md" });

    const markdown = renderProjectWriteupMarkdown(result);
    expect(markdown).toContain("1. **信息收集：探测登录接口**（基于 origin）");
    expect(markdown).toContain("`" + first.factId + "`：信息收集：探测登录接口");
    expect(markdown).toContain("model：demo/model-a，结果：success");
    expect(markdown).toContain("- 证据：`findings.md`");
    expect(markdown).toContain("- Flag：`" + FIXTURE_FLAG + "`");
    expect(markdown).toContain("本项目已拿到 Flag");
    expect(markdown).toContain("## 关键发现（当前有效事实清单）");
    expect(markdown).toContain("| cairn-worker | 2 | 1 | 2000 |");
  });

  test("separates open intents, standalone findings and superseded judgements", () => {
    const done = step("已完成探索");
    const stale = step("旧结论");
    const fresh = step("新结论", [stale.factId]);
    db.withConn((conn) => {
      createIntent(conn, projectId, {
        from: ["origin"],
        description: "尚未开始的探索",
        creator: "tester",
        worker: null,
      });
      recordFactMeta(conn, {
        projectId,
        factId: done.factId,
        evidenceRefs: [],
        evidenceStatus: "missing",
      });
    });

    const result = snapshot();
    expect(result.open_intents.map((intent) => intent.description)).toEqual([
      "尚未开始的探索",
    ]);
    expect(result.findings.map((fact) => fact.id)).toEqual([done.factId, fresh.factId]);
    expect(result.supersessions).toHaveLength(1);
    expect(result.supersessions[0]!.fact_id).toBe(stale.factId);

    const markdown = renderProjectWriteupMarkdown(result);
    expect(markdown).toContain("### 尚未完成的探索");
    expect(markdown).toContain("## 关键发现");
    expect(markdown).toContain("## 被取代的判断");
  });

  test("reports the latest verification check in the draft", () => {
    db.withConn((conn) => {
      setProjectVerification(conn, projectId, { kind: "challenge", challenge_code: "CH-1" });
      recordVerificationCheck(conn, {
        projectId,
        kind: "challenge",
        ok: true,
        detail: "flag count matched",
        challengeCode: "CH-1",
        flagCount: 1,
        flagGotCount: 1,
        checkedAt: "2026-10-28T11:30:00Z",
      });
    });

    const result = snapshot();
    expect(result.project.challenge_code).toBe("CH-1");
    expect(result.verification.kind).toBe("challenge");
    expect(result.verification.checks).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      last_checked_at: "2026-10-28T11:30:00Z",
    });
    expect(result.verification.latest?.flag_got_count).toBe(1);

    const markdown = renderProjectWriteupMarkdown(result);
    expect(markdown).toContain("- 题目编号：CH-1");
    expect(markdown).toContain("- 校验策略：challenge");
    expect(markdown).toContain("- 最近校验：通过（2026-10-28T11:30:00Z），计数 1/1");
  });

  test("caps the artifact appendix and flags the truncation", () => {
    writeFileSync(join(workspace, "artifacts", "note.md"), "note\n", "utf8");
    db.withConn((conn) => {
      recordProjectArtifacts(conn, { projectId, taskId: "task-1", workspace });
      for (let index = 0; index < 200; index += 1) {
        run(
          conn,
          `INSERT INTO project_artifacts (project_id, path, task_id, size, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          projectId,
          `pad-${index}.md`,
          "task-1",
          1,
          "0".repeat(64),
          "2026-10-28T11:00:00Z",
        );
      }
    });

    const result = snapshot();
    expect(result.artifacts).toHaveLength(200);
    expect(result.artifacts_truncated).toBe(true);
    expect(renderProjectWriteupMarkdown(result)).toContain("## 附录：证据文件");
  });

  test("keeps multi-line fact text on one Markdown line", () => {
    step("第一行\n第二行 说明");
    const markdown = renderProjectWriteupMarkdown(snapshot());
    expect(markdown).toContain("1. **第一行 第二行 说明**");
  });
});

describe("renderProjectWriteupPrompt", () => {
  test("wraps the draft with the Chinese hard rules", () => {
    const result = snapshot({ flag: { value: FIXTURE_FLAG, source: "findings.md" } });
    const prompt = renderProjectWriteupPrompt(result);

    expect(prompt).toContain("你是 CTF 复盘写手");
    expect(prompt).toContain("全程使用简体中文");
    expect(prompt).toContain("保留草稿里的 Flag 原文，逐字符照抄");
    expect(prompt).toContain("不得写入任何凭据、token、cookie、API key");
    expect(prompt).toContain("# 草稿");
    expect(prompt).toContain(FIXTURE_FLAG);
    expect(prompt).toContain("## 攻击路径");
  });
});

describe("project_writeups storage", () => {
  test("stores, replaces and clears the model-written narrative", () => {
    expect(db.withConn((conn) => getProjectWriteup(conn, projectId))).toBeNull();

    const saved = db.withConn((conn) =>
      saveProjectWriteup(conn, {
        projectId,
        markdown: "# 模型版\n\n中文正文\n",
        model: "demo/model-a",
        createdAt: "2026-10-28T12:00:00Z",
      }),
    );
    expect(saved).toEqual({
      project_id: projectId,
      markdown: "# 模型版\n\n中文正文\n",
      model: "demo/model-a",
      created_at: "2026-10-28T12:00:00Z",
    });

    db.withConn((conn) =>
      saveProjectWriteup(conn, {
        projectId,
        markdown: "# 第二版\n",
        model: "demo/model-b",
        createdAt: "2026-10-28T12:30:00Z",
      }),
    );
    expect(db.withConn((conn) => getProjectWriteup(conn, projectId))?.markdown).toBe(
      "# 第二版\n",
    );

    db.withConn((conn) => clearProjectWriteup(conn, projectId));
    expect(db.withConn((conn) => getProjectWriteup(conn, projectId))).toBeNull();
  });

  test("rejects a writeup for an unknown project", () => {
    expect(() =>
      db.withConn((conn) => saveProjectWriteup(conn, { projectId: "proj_missing", markdown: "x", model: null })),
    ).toThrow();
  });
});
