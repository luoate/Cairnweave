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
    expect(html).toContain("新建项目");
  });
});
