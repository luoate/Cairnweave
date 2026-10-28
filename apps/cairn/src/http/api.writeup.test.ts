import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  heartbeatIntent,
  recordProjectArtifacts,
  type CairnDatabase,
} from "@cairn/graph";

import { createApi, type Api } from "./api";
import type { WriteupGenerationInput, WriteupGenerator } from "./project-writeup";

const FIXTURE_FLAG = "CTF2{fixture_flag_value}";

let directory: string;
let db: CairnDatabase;
let projectId: string;
let workspaceRoot: string;
let workspace: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-writeup-"));
  db = configureDatabase(join(directory, "cairn.db"));
  workspaceRoot = join(directory, "projects");
  const created = db.withConn((conn) =>
    createProject(conn, {
      title: "签到题复盘",
      origin: "目标 http://127.0.0.1:8080 提供登录页",
      goal: "拿到后台 Flag",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
  projectId = created.project.id;
  workspace = join(workspaceRoot, projectId);
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "信息收集：探测登录接口",
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, "cairn-worker");
    concludeIntent(conn, projectId, intent.id, "cairn-worker", "发现 SQL 注入点");
  });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function start(options: Omit<Parameters<typeof createApi>[0], "db"> = {}): Api {
  return createApi({ workspaceRoot, ...options, db });
}

function get(path: string, api = start()): Promise<Response> {
  return api.handle(new Request(`http://cairn.test${path}`));
}

function post(api: Api, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test/projects/${projectId}/writeup`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function mutate(api: Api, method: string, headers: Record<string, string> = {}): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test/projects/${projectId}/writeup`, { method, headers }),
  );
}

describe("GET /projects/{id}/writeup", () => {
  test("renders the recorded graph as a Chinese draft", async () => {
    const response = await get(`/projects/${projectId}/writeup`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      project_id: string;
      source: string;
      model: string | null;
      markdown: string;
      flag: unknown;
      verification: { kind: string };
    };

    expect(body.project_id).toBe(projectId);
    expect(body.source).toBe("draft");
    expect(body.model).toBeNull();
    expect(body.flag).toBeNull();
    expect(body.verification.kind).toBe("evidence");
    expect(body.markdown).toContain("# Writeup：签到题复盘");
    expect(body.markdown).toContain("## 攻击路径");
    expect(body.markdown).toContain("发现 SQL 注入点");
    expect(body.markdown).toContain("- 授权范围：127.0.0.1:8080");
  });

  test("includes the captured flag from the project artifacts", async () => {
    writeFileSync(join(workspace, "artifacts", "findings.md"), `flag ${FIXTURE_FLAG}\n`, "utf8");
    db.withConn((conn) =>
      recordProjectArtifacts(conn, { projectId, taskId: "task-1", workspace }),
    );

    const body = (await (await get(`/projects/${projectId}/writeup`)).json()) as {
      flag: { value: string; source: string } | null;
      markdown: string;
    };
    expect(body.flag?.value).toBe(FIXTURE_FLAG);
    expect(body.flag?.source).toBe("findings.md");
    expect(body.markdown).toContain(`- Flag：\`${FIXTURE_FLAG}\``);
  });

  test("serves the draft as Markdown and rejects unknown formats", async () => {
    const response = await get(`/projects/${projectId}/writeup?format=markdown`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toContain("## 关键发现（当前有效事实清单）");

    const bad = await get(`/projects/${projectId}/writeup?format=pdf`);
    expect(bad.status).toBe(400);
  });

  test("returns 404 for an unknown project", async () => {
    const response = await get("/projects/proj_missing/writeup");
    expect(response.status).toBe(404);
  });
});

describe("POST /projects/{id}/writeup", () => {
  test("stores the model-written narrative and serves it afterwards", async () => {
    const seen: WriteupGenerationInput[] = [];
    const api = start({
      writeupGenerator: async (input) => {
        seen.push(input);
        return { ok: true, text: "# 模型撰写版\n\n完整中文复盘。\n", model: "demo/model-a" };
      },
    });

    const response = await post(api, { model: "cairn-worker" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, source: "model", model: "demo/model-a" });
    expect(body.markdown).toBe("# 模型撰写版\n\n完整中文复盘。");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.modelPrefId).toBe("cairn-worker");
    expect(seen[0]!.systemPrompt).toContain("CTF 复盘写手");
    expect(seen[0]!.prompt).toContain("只使用草稿中出现的事实");
    expect(seen[0]!.prompt).toContain("发现 SQL 注入点");

    const draft = (await (await get(`/projects/${projectId}/writeup`, api)).json()) as {
      source: string;
      markdown: string;
    };
    expect(draft.source).toBe("model");
    expect(draft.markdown).toContain("完整中文复盘");

    const raw = await get(`/projects/${projectId}/writeup?format=markdown`, api);
    expect(await raw.text()).toContain("# 模型撰写版");
  });

  test("keeps the default model pref when the body is empty", async () => {
    let pref = "";
    const api = start({
      writeupGenerator: async (input) => {
        pref = input.modelPrefId;
        return { ok: true, text: "正文" };
      },
    });
    const response = await post(api, "");
    expect(response.status).toBe(200);
    expect(pref).toBe("cairn-worker");
  });

  test("leaves the stored narrative untouched when the model fails", async () => {
    const api = start({
      writeupGenerator: async () => ({ ok: true, text: "第一版正文\n" }),
    });
    await post(api, {});

    const failing = start({
      writeupGenerator: async () => ({ ok: false, error: "provider exploded" }),
    });
    const response = await post(failing, {});
    expect(response.status).toBe(502);
    expect(((await response.json()) as { detail: string }).detail).toBe("provider exploded");

    const body = (await (await get(`/projects/${projectId}/writeup`, api)).json()) as {
      source: string;
      markdown: string;
    };
    expect(body.source).toBe("model");
    expect(body.markdown).toBe("第一版正文");
  });

  test("sanitizes provider errors before returning them", async () => {
    const api = start({
      writeupGenerator: async () => ({
        ok: false,
        error: "auth failed: Bearer sk-test-abcdefghijklmnop",
      }),
    });
    const body = (await (await post(api, {})).json()) as { detail: string };
    expect(body.detail).not.toContain("sk-test-abcdefghijklmnop");
    expect(body.detail).toContain("<redacted>");
  });

  test("answers with 504 when generation hangs", async () => {
    const api = start({
      writeupTimeoutMs: 20,
      writeupGenerator: () => new Promise<never>(() => {}),
    });
    const response = await post(api, {});
    expect(response.status).toBe(504);
    expect(((await response.json()) as { detail: string }).detail).toContain("timed out");
  });

  test("validates the request body", async () => {
    const api = start({ writeupGenerator: async () => ({ ok: true, text: "x" }) });
    expect((await post(api, "not json")).status).toBe(400);
    expect((await post(api, "[1,2]")).status).toBe(400);
    expect((await post(api, { model: 42 })).status).toBe(400);
    expect((await post(api, { model: "bad model id" })).status).toBe(400);
  });

  test("requires the operator token and same-origin for writes", async () => {
    const api = start({
      operatorToken: "secret-token",
      writeupGenerator: async () => ({ ok: true, text: "x" }),
    });
    expect((await post(api, {})).status).toBe(401);
    expect((await mutate(api, "DELETE")).status).toBe(401);
    expect(
      (
        await post(api, {}, { "x-cairn-operator-token": "secret-token" })
      ).status,
    ).toBe(200);

    const crossOrigin = await api.handle(
      new Request(`http://cairn.test/projects/${projectId}/writeup`, {
        method: "POST",
        headers: { origin: "http://evil.test", "x-cairn-operator-token": "secret-token" },
        body: "{}",
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });

  test("still answers GET without an operator token", async () => {
    const api = start({ operatorToken: "secret-token" });
    expect((await get(`/projects/${projectId}/writeup`, api)).status).toBe(200);
  });
});

describe("DELETE /projects/{id}/writeup", () => {
  test("falls back to the draft after the stored narrative is cleared", async () => {
    const generator: WriteupGenerator = async () => ({ ok: true, text: "模型版本\n" });
    const api = start({ writeupGenerator: generator });
    await post(api, {});

    const response = await mutate(api, "DELETE");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string; markdown: string };
    expect(body.source).toBe("draft");
    expect(body.markdown).toContain("# Writeup：签到题复盘");
  });
});
