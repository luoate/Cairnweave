import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

const STATIC_DIR = join(import.meta.dir, "static");
const INDEX_PATH = join(STATIC_DIR, "index.html");

let directory: string;
let db: CairnDatabase;
let api: Api;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-ui-"));
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, staticDir: STATIC_DIR });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("static operations UI", () => {
  test("serves the single-page app and its vendored assets", async () => {
    const index = await api.handle(new Request("http://cairn.test/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    const html = await index.text();
    expect(html).toContain("function cairnApp()");
    expect(html).toContain("selectSideTab('runs')");
    expect(html).toContain("selectSideTab('strategist')");
    expect(html).toContain("selectSideTab('audit')");
    expect(html).toContain("selectSideTab('evidence')");
    expect(html).toContain("selectSideTab('proposals')");
    expect(html).toContain("selectSideTab('cost')");
    expect(html).toContain("selectSideTab('stats')");
    expect(html).toContain("selectSideTab('report')");

    const favicon = await api.handle(new Request("http://cairn.test/static/favicon.svg"));
    expect(favicon.status).toBe(200);
  });

  test("keeps the inline app script syntactically valid", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const match = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    expect(() => new Function(match![1]!)).not.toThrow();
  });

  test("keeps operations panels read-only and exposes one explicit replan action", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const appScript = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;
    for (const method of [
      "loadRuns",
      "loadFactTrace",
      "loadStrategist",
      "loadAudit",
      "loadAuditTask",
      "loadEvidenceFact",
      "loadProposals",
      "loadCost",
      "loadStats",
      "loadReport",
    ]) {
      const start = appScript.indexOf(`async ${method}(`);
      expect(start).toBeGreaterThan(-1);
      const end = appScript.indexOf("\n    },", start);
      const body = appScript.slice(start, end);
      expect(body).toContain("this.api('GET'");
      expect(body).not.toMatch(/this\.api\('(POST|PUT|DELETE)'/);
    }

    // The slow-layer panel has one explicit operator action; everything else stays GET.
    const replanStart = appScript.indexOf("async requestStrategistReplan(");
    expect(replanStart).toBeGreaterThan(-1);
    const replanEnd = appScript.indexOf("\n    },", replanStart);
    const replanBody = appScript.slice(replanStart, replanEnd);
    expect(replanBody).toContain("this.api('POST'");
    expect(replanBody).toContain("/replan`");
    expect(replanBody).toContain("requested_by: 'ui'");

    // The operations loaders call the existing read-only routes.
    expect(appScript).toContain("/runs`");
    expect(appScript).toContain("/facts/");
    expect(appScript).toContain("/strategist?limit=20`");
    expect(appScript).toContain("/meta`");
    expect(appScript).toContain("/audit`");
    expect(appScript).toContain("/stream-lost`");
    expect(appScript).toContain("/meta`");
    expect(appScript).toContain("/evidence`");
    expect(appScript).toContain("/proposals`");
    expect(appScript).toContain("/cost`");
    expect(appScript).toContain("/stats`");
    expect(appScript).toContain("/report`");
    expect(appScript).toContain("format=markdown");
    expect(html).toContain("慢层");
    expect(html).toContain("单项目预算");
    expect(html).toContain("推理历史");
    expect(html).toContain("请求重规划");
    expect(html).toContain("提案");
    expect(html).toContain("事实成本");
    expect(html).toContain("因果边");
    expect(html).toContain("按 Worker");
    expect(html).toContain("按模型");
    expect(html).toContain("按 Profile");
    expect(html).toContain("成功率");
    expect(html).toContain("全部归因");
    expect(html).toContain("仅演练");
    expect(html).toContain("只读");
    expect(html).toContain("溯源");
    expect(html).toContain("查看工具调用");
    expect(html).toContain("当前事实");
    expect(html).toContain("取代关系");
    expect(html).toContain("已被取代");
    expect(html).toContain("完成判定");
    expect(html).toContain("无身份认证");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("新建项目");
    expect(html).toContain("授权范围");
    expect(html).toContain("未配置授权范围");
    expect(html).toContain("未授权");
    expect(appScript).toContain("saveProjectScope");
    expect(appScript).toContain("/scope`");
    expect(appScript).toContain("has_scope");
    expect(html).toContain('x-model="listQuery"');
    expect(html).toContain('x-model="listSort"');
    expect(html).toContain("setListStatusFilter('active')");
    expect(html).toContain("clearListFilters()");
    expect(html).toContain("没有匹配的项目");
    expect(html).toContain("无法刷新项目列表");
    expect(html).toContain("无法刷新项目：");
    expect(appScript).toContain("projectError");
    expect(html).toContain("flex overflow-x-auto");
    expect(appScript).toContain("document.addEventListener('visibilitychange'");
    expect(appScript).toContain("document.hidden");
    expect(appScript).toContain("Math.min(5000 * 2 ** failures, 60000)");
    expect(appScript).toContain("cairn.listPrefs");
    expect(appScript).toContain("cairn.sideTabs");
    expect(appScript).toContain("opsTabs()");
  });
});

interface TestProject {
  id: string;
  title: string;
  status: string;
  created_at: string;
  reason: string | null;
  has_scope: boolean;
}

function loadApp(): Record<string, (...args: any[]) => any> {
  const html = readFileSync(INDEX_PATH, "utf8");
  const match = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/);
  if (!match) throw new Error("app script not found");
  const factory = new Function(`${match[1]}; return cairnApp;`)() as () => Record<
    string,
    (...args: any[]) => any
  >;
  return factory();
}

describe("project list search and sort", () => {
  const projects: TestProject[] = [
    {
      id: "proj_c",
      title: "Gamma",
      status: "completed",
      created_at: "2026-01-03T00:00:00Z",
      reason: null,
      has_scope: true,
    },
    {
      id: "proj_a",
      title: "Alpha",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      reason: null,
      has_scope: true,
    },
    {
      id: "proj_b",
      title: "Beta",
      status: "stopped",
      created_at: "2026-01-02T00:00:00Z",
      reason: "budget exhausted",
      has_scope: false,
    },
  ];

  function ids(app: ReturnType<typeof loadApp>, query = "", status = "all", sort = "created_desc") {
    return app.matchingProjects!(projects, query, status, sort).map((p: TestProject) => p.id);
  }

  test("matches title, id, status label and reason case-insensitively", () => {
    const app = loadApp();
    expect(ids(app, "alp")).toEqual(["proj_a"]);
    expect(ids(app, "proj_b")).toEqual(["proj_b"]);
    expect(ids(app, "进行中")).toEqual(["proj_a"]);
    expect(ids(app, "BUDGET")).toEqual(["proj_b"]);
    expect(ids(app, "  ")).toEqual(["proj_c", "proj_b", "proj_a"]);
  });

  test("applies the status filter and deterministic sort orders", () => {
    const app = loadApp();
    expect(ids(app, "", "active")).toEqual(["proj_a"]);
    expect(ids(app, "", "all", "title_asc")).toEqual(["proj_a", "proj_b", "proj_c"]);
    expect(ids(app, "", "all", "status")).toEqual(["proj_a", "proj_b", "proj_c"]);
    expect(ids(app, "", "all", "created_desc")).toEqual(["proj_c", "proj_b", "proj_a"]);
    // Sorting must not mutate the caller's array.
    expect(projects.map(p => p.id)).toEqual(["proj_c", "proj_a", "proj_b"]);
  });
});
