import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(html).toContain("selectSideTab('board')");
    expect(html).toContain("selectSideTab('cost')");
    expect(html).toContain("selectSideTab('stats')");
    expect(html).toContain("selectSideTab('report')");
    expect(html).toContain("selectSideTab('writeup')");
    expect(html).toContain("selectSideTab('attachments')");

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
      "loadBoard",
      "loadCost",
      "loadStats",
      "loadReport",
      "loadProjectFlag",
      "loadAttachments",
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
    expect(appScript).toContain("/flag`");
    expect(appScript).toContain("/attachments`");
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
    expect(html).toContain('x-model="newProject.verificationKind"');
    expect(html).toContain("题目 / Flag 自动校验");
    expect(html).toContain("自动（题目环境优先，否则证据校验）");
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

  test("wires the Chinese writeup tab with draft, generation and reset actions", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const appScript = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;

    // The loader is read-only; only the two operator actions mutate the stored narrative.
    const loadStart = appScript.indexOf("async loadWriteup(");
    expect(loadStart).toBeGreaterThan(-1);
    const loadBody = appScript.slice(loadStart, appScript.indexOf("\n    },", loadStart));
    expect(loadBody).toContain("this.api('GET'");
    expect(loadBody).not.toMatch(/this\.api\('(POST|DELETE)'/);

    const generateStart = appScript.indexOf("async generateWriteup(");
    expect(generateStart).toBeGreaterThan(-1);
    const generateBody = appScript.slice(generateStart, appScript.indexOf("\n    },", generateStart));
    expect(generateBody).toContain("this.api('POST'");
    expect(generateBody).toContain("writeupPanel.generating");

    const resetStart = appScript.indexOf("async resetWriteup(");
    expect(resetStart).toBeGreaterThan(-1);
    const resetBody = appScript.slice(resetStart, appScript.indexOf("\n    },", resetStart));
    expect(resetBody).toContain("this.api('DELETE'");

    expect(appScript).toContain("/writeup`");
    expect(appScript).toContain("/writeup?format=markdown");
    expect(html).toContain(`sideTab === 'writeup'`);
    expect(html).toContain("AI 撰写");
    expect(html).toContain("恢复草稿");
    expect(html).toContain("中文草稿");
    expect(html).toContain("x-text=\"writeupMarkdown()\"");
    // Generation is disabled while in flight and reports failures inline.
    expect(html).toContain("writeupPanel.generating || !writeupPanel.loadedFor");
    expect(html).toContain("writeupPanel.error");

    // The action bar is its own wrapping row: a title column squeezed beside five
    // controls wrapped one character per line in the narrow side panel.
    const panelStart = html.indexOf(`x-show="sideTab === 'writeup'"`);
    const panel = html.slice(panelStart, html.indexOf("<!-- ", panelStart + 200));
    expect(panel).not.toContain("justify-between");
    expect(panel).toContain("flex flex-wrap items-center gap-1.5");
    expect(panel).toContain("下载 Markdown");
    expect(panel).toContain("@click=\"downloadWriteup()\"");
    expect(panel).toContain("x-text=\"writeupSummary()\"");

    const downloadStart = appScript.indexOf("downloadWriteup()");
    expect(downloadStart).toBeGreaterThan(-1);
    const downloadBody = appScript.slice(downloadStart, appScript.indexOf("\n    },", downloadStart));
    // Downloading is a GET of the markdown route plus a local anchor click, never a write.
    expect(downloadBody).toContain("this.writeupMarkdownHref()");
    expect(downloadBody).toContain("link.download = this.writeupFileName()");
    expect(downloadBody).not.toMatch(/this\.api\('(POST|DELETE)'/);

    const app = loadApp() as unknown as {
      selectedProjectId: string | null;
      writeupFileName(): string;
    };
    app.selectedProjectId = "proj_008";
    expect(app.writeupFileName()).toBe("writeup-proj_008.md");
    app.selectedProjectId = "proj/../008";
    expect(app.writeupFileName()).toBe("writeup-proj_.._008.md");
    app.selectedProjectId = null;
    expect(app.writeupFileName()).toBe("writeup-project.md");
  });

  test("offers the attachment bundle only when artifacts are indexed", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const appScript = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;

    const panelStart = html.indexOf(`x-show="sideTab === 'writeup'"`);
    const panel = html.slice(panelStart, html.indexOf("<!-- ", panelStart + 200));
    expect(panel).toContain("<template x-if=\"writeupArchive()\">");
    expect(panel).toContain("@click=\"downloadWriteupArchive()\"");
    expect(panel).toContain("附件包");

    const archiveStart = appScript.indexOf("downloadWriteupArchive()");
    expect(archiveStart).toBeGreaterThan(-1);
    const archiveBody = appScript.slice(archiveStart, appScript.indexOf("\n    },", archiveStart));
    expect(archiveBody).toContain("this.writeupArchiveHref()");
    expect(archiveBody).toContain("link.download = this.writeupArchiveFileName()");
    expect(archiveBody).not.toMatch(/this\.api\('(POST|DELETE)'/);

    const app = loadApp() as unknown as {
      selectedProjectId: string | null;
      writeupPanel: { data: unknown };
      writeupArchive(): { available: boolean; files: number } | null;
      writeupArchiveHref(): string;
      writeupArchiveFileName(): string;
      writeupSummary(): string;
    };
    app.selectedProjectId = "proj_008";

    app.writeupPanel = { data: { archive: { available: true, files: 139 }, payloads: { total: 79, inlined: 7 } } };
    expect(app.writeupArchive()).toEqual({ available: true, files: 139 });
    expect(app.writeupArchiveHref()).toBe("/projects/proj_008/writeup/archive");
    expect(app.writeupArchiveFileName()).toBe("writeup-proj_008.zip");
    expect(app.writeupSummary()).toContain("载荷 79 个（内联 7）");

    // No mounted workspace, or an empty index: the panel hides a bundle it cannot serve.
    app.writeupPanel = { data: { archive: { available: false, files: 0 } } };
    expect(app.writeupArchive()).toBeNull();
    app.selectedProjectId = null;
    expect(app.writeupArchiveHref()).toBe("#");

    // The summary says *why* there is no flag instead of only "尚未记录".
    app.writeupPanel = {
      data: { flag: null, flag_suspects: ["CTF2{c8xxxx}", "CTF2{uuid}"] },
    };
    expect(app.writeupSummary()).toContain("尚未记录 Flag（2 处疑似占位）");
    app.writeupPanel = {
      data: { flag: { value: "CTF2{real_one}", alternatives: ["flag{second}"] }, flag_suspects: [] },
    };
    expect(app.writeupSummary()).toContain("已记录 Flag（另有 1 个候选）");
  });

  test("wires the challenge attachment tab with upload, download and armed delete", async () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const appScript = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;

    // Listing is read-only; the only writes are the upload POST and the delete DELETE.
    const loadStart = appScript.indexOf("async loadAttachments(");
    expect(loadStart).toBeGreaterThan(-1);
    const loadBody = appScript.slice(loadStart, appScript.indexOf("\n    },", loadStart));
    expect(loadBody).toContain("this.api('GET'");
    expect(loadBody).not.toMatch(/this\.api\('(POST|PUT|DELETE)'/);

    // The route takes the raw bytes as the body, so a buffered multipart form is not used.
    const uploadStart = appScript.indexOf("async uploadAttachment(");
    expect(uploadStart).toBeGreaterThan(-1);
    const uploadBody = appScript.slice(uploadStart, appScript.indexOf("\n    },", uploadStart));
    expect(uploadBody).toContain("?name=${encodeURIComponent(file.name)}");
    expect(uploadBody).toContain("{ method: 'POST', body: file }");

    const deleteStart = appScript.indexOf("async deleteAttachment(");
    expect(deleteStart).toBeGreaterThan(-1);
    const deleteBody = appScript.slice(deleteStart, appScript.indexOf("\n    },", deleteStart));
    expect(deleteBody).toContain("this.api('DELETE'");

    const panelStart = html.indexOf(`x-show="sideTab === 'attachments'"`);
    expect(panelStart).toBeGreaterThan(-1);
    const panel = html.slice(panelStart, html.indexOf("\n    </div>\n  </div>", panelStart));
    expect(panel).toContain('type="file" multiple');
    expect(panel).toContain('@change="uploadPickedAttachments($event)"');
    expect(panel).toContain('@click="downloadAttachment(attachment)"');
    expect(panel).toContain('@click="requestDeleteAttachment(attachment)"');
    expect(panel).toContain("再次点击确认删除");
    // The label and the rose colour must read the same armed field; a stale second field
    // name leaves the row armed while still looking idle.
    expect(panel).toContain("attachmentsPanel.armedAttachment === attachment");
    expect(panel).not.toContain("armedId");
    expect(panel).toContain("attachmentsPanel.available");
    expect(panel).toContain("attachmentsPanel.error");

    const app = loadState();
    expect(app.opsTabs()).toContain("attachments");
    app.selectedProjectId = "proj_009";
    expect(app.attachmentHref({ id: 7 })).toBe("/projects/proj_009/attachments/7");
    app.selectedProjectId = null;
    expect(app.attachmentHref({ id: 7 })).toBe("#");

    // The budget copy comes from the server, so the UI cannot drift from the route limits.
    expect(app.attachmentsSummaryLabel()).toContain("Worker 用文件工具直接读取");
    expect(app.attachmentsPolicyLabel()).toContain("只读输入");
    app.attachmentsPanel.loadedFor = "proj_009";
    app.applyAttachmentView({
      attachments: [
        {
          id: 7,
          name: "challenge.bin",
          path: "attachments/challenge.bin",
          size: 4096,
          sha256: "a".repeat(64),
          creator: "operator",
          created_at: "2026-10-31T00:00:00Z",
        },
      ],
      total_bytes: 4096,
      limits: { file_bytes: 32 * 1024 * 1024, project_bytes: 256 * 1024 * 1024 },
      available: true,
    });
    expect(app.attachmentsPanel.items).toHaveLength(1);
    expect(app.attachmentsSummaryLabel()).toBe("1 个附件 · 共 4.0 KiB");
    expect(app.attachmentWorkspaceLabel()).toBe("工作区 attachments/");
    expect(app.attachmentsPolicyLabel()).toContain("单个文件上限 32.0 MiB");
    expect(app.attachmentsPolicyLabel()).toContain("每个项目上限 256.0 MiB");
    expect(app.attachmentsPolicyLabel()).toContain("同名文件换内容会被拒绝");

    // A server without a mounted workspace stores nothing; the control says so instead of failing on click.
    app.applyAttachmentView({
      attachments: [],
      total_bytes: 0,
      limits: { file_bytes: 32 * 1024 * 1024, project_bytes: 256 * 1024 * 1024 },
      available: false,
    });
    expect(app.attachmentsPanel.available).toBe(false);
    expect(app.attachmentWorkspaceLabel()).toBe("工作区未挂载");
    expect(app.attachmentUploadLabel()).toContain("工作区未挂载，无法上传");
    expect(app.attachmentsSummaryLabel()).toBe("还没有上传附件。");

    // The first delete click only arms the row; the file is removed on the second click.
    const deleted: number[] = [];
    app.deleteAttachment = async (attachment: { id: number }) => {
      deleted.push(attachment.id);
    };
    const row = { id: 12, name: "pcap.bin" };
    const other = { id: 13, name: "other.bin" };
    app.requestDeleteAttachment(row);
    expect(deleted).toEqual([]);
    expect(app.attachmentsPanel.armedAttachment).toEqual(row);
    // Moving the arm to another row never deletes the first one.
    app.requestDeleteAttachment(other);
    expect(deleted).toEqual([]);
    expect(app.attachmentsPanel.armedAttachment).toEqual(other);
    app.requestDeleteAttachment(other);
    expect(deleted).toEqual([13]);
    expect(app.attachmentsPanel.armedAttachment).toBeNull();

    // A reload drops the arm: the row it pointed at may already be gone.
    app.requestDeleteAttachment(row);
    expect(app.attachmentsPanel.armedAttachment).toEqual(row);
    app.applyAttachmentView({ attachments: [], total_bytes: 0, limits: null, available: true });
    expect(app.attachmentsPanel.armedAttachment).toBeNull();
  });

  test("wires the read-only Observer board tab", async () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const appScript = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;

    expect(html).toContain("selectSideTab('board')");
    expect(html).toContain(`sideTab === 'board'`);
    expect(html).toContain("看板");
    expect(html).toContain("boardPanel.error");
    expect(html).toContain("boardIdeaStatusLabel(idea.status)");
    expect(html).toContain("boardMemoryKindLabel(entry.kind)");
    expect(appScript).toContain("/board`");

    const loadStart = appScript.indexOf("async loadBoard(");
    expect(loadStart).toBeGreaterThan(-1);
    const loadBody = appScript.slice(loadStart, appScript.indexOf("\n    },", loadStart));
    expect(loadBody).toContain("this.api('GET'");
    expect(loadBody).not.toMatch(/this\.api\('(POST|PUT|DELETE)'/);

    const app = loadState();
    app.selectedProjectId = "proj_1";
    const calls: any[] = [];
    app.api = async (method: string, path: string) => {
      calls.push([method, path]);
      return {
        available: true,
        ideas: [
          {
            id: "idea_1",
            status: "verified",
            content: "试试 IDOR",
            result: "拿到 admin 页面",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
          },
        ],
        memory: [
          {
            id: "mem_1",
            kind: "fact",
            content: "登录接口无速率限制",
            refs: ["runs/t1/findings.md"],
            source: "observer",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
        ideas_total: 1,
        memory_total: 1,
        truncated: false,
      };
    };

    await app.loadBoard();
    expect(calls).toEqual([["GET", "/projects/proj_1/board"]]);
    expect(app.boardPanel.data.available).toBe(true);
    expect(app.boardPanel.loadedFor).toBe("proj_1");
    expect(app.boardSummaryText()).toBe("1 条想法 · 1 条记忆");
    expect(app.boardIdeaStatusLabel("testing")).toBe("验证中");
    expect(app.boardIdeaStatusLabel("pending")).toBe("待验证");
    expect(app.boardMemoryKindLabel("failure")).toBe("失败");
    expect(app.boardCountText(1, 201)).toBe("1 / 201");
    expect(app.boardCountText(2, 2)).toBe("2");

    app.api = async () => ({
      available: false,
      ideas: [],
      memory: [],
      ideas_total: 0,
      memory_total: 0,
      truncated: false,
    });
    await app.loadBoard();
    expect(app.boardSummaryText()).toBe("此项目还没有看板");

    app.api = async () => {
      throw new Error("board unavailable");
    };
    await app.loadBoard();
    expect(app.boardPanel.error).toContain("board unavailable");
    expect(app.boardPanel.loading).toBe(false);
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

// The inline app script is Alpine-free at the method level, so the modal stack,
// validators and confirmation flow are testable without a DOM. State properties
// live on the same object as the methods, hence the `any` view.
function loadState(): any {
  return loadApp();
}

function fakeModal(labels: string[], options: { disabled?: string[]; hidden?: string[] } = {}) {
  const focusLog: string[] = [];
  const nodes = labels.map((label) => {
    const node: any = { label, focus: () => { focusLog.push(label); } };
    if (options.disabled?.includes(label)) node.disabled = true;
    if (options.hidden?.includes(label)) node.offsetParent = null;
    return node;
  });
  return {
    nodes,
    focusLog,
    byLabel: new Map(nodes.map((node: any) => [node.label, node])),
    querySelectorAll: () => nodes,
    contains: (candidate: unknown) => nodes.includes(candidate as any),
  };
}

function tabEvent(modal: ReturnType<typeof fakeModal>, label: string, shiftKey = false) {
  const event: any = {
    key: "Tab",
    shiftKey,
    target: modal.byLabel.get(label),
    prevented: false,
    preventDefault: () => { event.prevented = true; },
  };
  return event;
}

describe("modal focus management", () => {
  test("binds every overlay to the shared modal stack", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const overlays = [...html.matchAll(/<div x-show="(show[A-Za-z]+)"[^>]*>/g)]
      .map((match) => ({ flag: match[1], tag: match[0] }))
      .filter((overlay) => overlay.tag.includes("overlay"));
    expect(overlays.length).toBeGreaterThanOrEqual(12);

    const modalNames: string[] = [];
    for (const overlay of overlays) {
      const name = overlay.tag.match(/data-modal="([A-Za-z]+)"/)?.[1];
      expect(name, overlay.flag).toBeTruthy();
      expect(overlay.tag).toContain(`x-effect="syncModal('${name}', ${overlay.flag}, $el)"`);
      expect(overlay.tag).toContain(`@click.self="dismissModal('${name}')"`);
      modalNames.push(name!);
    }
    // Each overlay owns a distinct name and exactly one closer.
    expect(new Set(modalNames).size).toBe(modalNames.length);
    expect(Object.keys(loadState().modalClosers()).sort()).toEqual([...modalNames].sort());
  });

  test("keeps a LIFO stack and clears the remembered focus target on close", () => {
    const app = loadState();
    const element = { querySelector: () => null };
    app.syncModal("newProject", true, element);
    app.syncModal("confirm", true, element);
    expect(app.modalOrder).toEqual(["newProject", "confirm"]);
    expect(app.topModalName()).toBe("confirm");

    app.syncModal("confirm", false, element);
    expect(app.topModalName()).toBe("newProject");
    app.syncModal("newProject", false, element);
    expect(app.modalOrder).toEqual([]);
    expect(app.topModalName()).toBe("");
    expect(Object.keys(app.modalReturnFocus)).toEqual([]);
    // Re-opening must not accumulate duplicates.
    app.syncModal("hint", true, element);
    app.syncModal("hint", true, element);
    expect(app.modalOrder).toEqual(["hint"]);
  });

  test("skips disabled and hidden controls when collecting focusables", () => {
    const app = loadState();
    const modal = fakeModal(["first", "second", "third"], { disabled: ["second"], hidden: ["third"] });
    expect(app.modalFocusables(modal).map((node: any) => node.label)).toEqual(["first"]);
    expect(app.modalFocusables(null)).toEqual([]);
    expect(app.modalFocusables({})).toEqual([]);
  });

  test("wraps tab focus at both ends of the top modal", () => {
    const app = loadState();
    const modal = fakeModal(["first", "middle", "last"]);

    const forward = tabEvent(modal, "last");
    app.trapModalFocus(modal, forward);
    expect(forward.prevented).toBe(true);
    expect(modal.focusLog).toEqual(["first"]);

    const backward = tabEvent(modal, "first", true);
    app.trapModalFocus(modal, backward);
    expect(backward.prevented).toBe(true);
    expect(modal.focusLog).toEqual(["first", "last"]);

    const inside = tabEvent(modal, "middle");
    app.trapModalFocus(modal, inside);
    expect(inside.prevented).toBe(false);
    expect(modal.focusLog).toEqual(["first", "last"]);

    // Focus that escaped the modal (e.g. a browser chrome shortcut) is pulled back.
    const outside = { label: "outside", focus: () => { modal.focusLog.push("outside"); } };
    const rescue = { key: "Tab", shiftKey: false, target: outside, prevented: false, preventDefault: () => { rescue.prevented = true; } };
    app.trapModalFocus(modal, rescue);
    expect(rescue.prevented).toBe(true);
    expect(modal.focusLog).toEqual(["first", "last", "first"]);
  });

  test("keeps a modal open while its own submit is in flight", () => {
    const app = loadState();
    app.showNewProject = true;
    app.isCreatingProject = true;
    app.dismissModal("newProject");
    expect(app.showNewProject).toBe(true);
    app.isCreatingProject = false;
    app.dismissModal("newProject");
    expect(app.showNewProject).toBe(false);

    app.showScopeModal = true;
    app.isSavingScope = true;
    app.dismissModal("scope");
    expect(app.showScopeModal).toBe(true);
    app.isSavingScope = false;
    app.dismissModal("scope");
    expect(app.showScopeModal).toBe(false);

    app.showDeleteModal = true;
    app.isDeletingProject = true;
    app.dismissModal("delete");
    expect(app.showDeleteModal).toBe(true);

    expect(() => app.dismissModal("noSuchModal")).not.toThrow();
    expect(app.topModalName()).toBe("");
  });

  test("registers a single global keyboard handler for the modal stack", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const script = html.match(/<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/)![1]!;
    expect(script.match(/window\.addEventListener\('keydown', this\._modalShortcut\)/g)?.length).toBe(1);
    expect(script).toContain("if (event.isComposing) return;");
    expect(script).toContain("this.dismissModal(top);");
    expect(script).toContain("this.trapModalFocus(modal, event);");
  });

  test("focuses the requested element on open and returns focus on close", async () => {
    const focusLog: string[] = [];
    const trigger = { focus: () => { focusLog.push("trigger"); } };
    const target = { focus: () => { focusLog.push("target"); } };
    const element = { querySelector: (selector: string) => (selector === "[data-autofocus]" ? target : null) };
    const hadDocument = "document" in globalThis;
    (globalThis as any).document = { activeElement: trigger, contains: () => true };
    try {
      const app = loadState();
      app.syncModal("newProject", true, element);
      expect(app.modalReturnFocus.newProject).toBe(trigger);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(focusLog).toEqual(["target"]);

      app.syncModal("newProject", false, element);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(focusLog).toEqual(["target", "trigger"]);
      expect(app.modalReturnFocus).toEqual({});
    } finally {
      if (!hadDocument) delete (globalThis as any).document;
    }
  });

  test("keeps every overlay as a body-level sibling", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const start = html.indexOf("<!-- New Project -->");
    const end = html.indexOf("<!-- Toast -->");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const region = html.slice(start, end);

    let depth = 0;
    const overlayDepths: Record<string, number> = {};
    for (const token of region.matchAll(/<div\b[^>]*>|<\/div>/g)) {
      if (token[0].startsWith("</")) {
        depth -= 1;
        expect(depth).toBeGreaterThanOrEqual(0);
        continue;
      }
      const name = /data-modal="([A-Za-z]+)"/.exec(token[0])?.[1];
      if (name) overlayDepths[name] = depth;
      depth += 1;
    }
    // An unclosed overlay would nest every later modal inside it, hiding them.
    expect(depth).toBe(0);
    expect(Object.keys(overlayDepths).length).toBe(13);
    for (const [name, level] of Object.entries(overlayDepths)) {
      expect(level, name).toBe(0);
    }
  });

  test("retries autofocus only while the overlay is still laid out zero", async () => {
    const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
    const app = loadState();
    const calls: number[] = [];
    let width = 0;
    const target = {
      focus: () => calls.push(width),
      getBoundingClientRect: () => ({ width }),
    };
    const element = { querySelector: () => target };
    app.modalOrder = ["hint"];

    width = 0;
    app.focusModalContent("hint", element, 2);
    await tick();
    // Initial attempt plus the two permitted retries.
    expect(calls).toEqual([0, 0, 0]);

    // Once Alpine has applied x-show the next attempt wins and the retry loop ends.
    calls.length = 0;
    width = 320;
    app.focusModalContent("hint", element, 3);
    await tick();
    expect(calls).toEqual([320]);

    // A modal that is no longer open must not steal focus.
    calls.length = 0;
    app.focusModalContent("gone", element, 3);
    await tick();
    expect(calls).toEqual([]);

    // Missing roots or non-focusable targets are ignored instead of throwing.
    app.focusModalContent("hint", { querySelector: () => null }, 1);
    app.focusModalContent("hint", { querySelector: () => ({}) }, 1);
    app.focusModalContent("hint", {}, 1);
    await tick();
    expect(calls).toEqual([]);
  });

  test("gives every overlay exactly one autofocus target", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const flags = [...html.matchAll(/<div x-show="(show[A-Za-z]+)"[^>]*class="fixed inset-0[^"]*overlay"/g)]
      .map((match) => match[1]);
    expect(flags.length).toBeGreaterThanOrEqual(12);
    for (const flag of flags) {
      const start = html.indexOf(`<div x-show="${flag}"`);
      // Each overlay markup ends at the next `<!-- ... -->` section marker.
      const next = html.indexOf("\n<!-- ", start + 1);
      const block = html.slice(start, next === -1 ? html.length : next);
      expect(block, flag).toContain("data-autofocus");
      expect(block.match(/data-autofocus/g)!.length, flag).toBe(1);
    }
  });
});

describe("form validation and submitting states", () => {
  test("dedupes authorized targets and reports per-line problems", () => {
    const app = loadState();
    const parsed = app.validateScopeTargets(
      ["  10.0.0.1 ", "10.0.0.1", "", "https://exa mple", "x".repeat(256)].join("\n"),
    );
    expect(parsed.targets).toEqual(["10.0.0.1"]);
    expect(parsed.errors).toEqual([
      "目标不能包含空格：https://exa mple",
      `目标过长：${"x".repeat(32)}…`,
    ]);
    expect(app.scopeTargets("a.example\n\na.example")).toEqual(["a.example"]);
    expect(app.validateScopeTargets(undefined)).toEqual({ targets: [], errors: [] });
  });

  test("requires every new-project field including at least one target", () => {
    const app = loadState();
    expect(Object.keys(app.newProjectErrors()).sort()).toEqual(["goal", "origin", "targets", "title"]);
    app.newProject.title = "  Alpha Recon  ";
    app.newProject.origin = " foothold ";
    app.newProject.goal = " flag ";
    expect(app.newProjectErrors().targets).toBe("请至少填写一个授权目标");
    app.newProject.targetsText = "10.0.0.1";
    expect(app.newProjectErrors()).toEqual({});
    app.newProject.targetsText = "bad target";
    expect(app.newProjectErrors().targets).toBe("目标不能包含空格：bad target");
    app.newProject.targetsText = "10.0.0.1";
    app.newProject.title = "x".repeat(201);
    expect(app.newProjectErrors().title).toBe("标题不能超过 200 个字符");
    app.newProject.title = "Alpha";
    app.newProject.verificationKind = "challenge";
    expect(app.newProjectErrors().challengeCode).toBe("请填写题目编号");
    app.newProject.challengeCode = " web-01 ";
    expect(app.newProjectErrors()).toEqual({});
    app.newProject.verificationKind = "auto";
    expect(app.newProjectErrors()).toEqual({});
  });

  test("validates scheduler timeouts before saving settings", () => {
    const app = loadState();
    expect(app.settingsErrors()).toEqual({});
    app.settingsForm.intent_timeout = -1;
    app.settingsForm.reason_timeout = "2.5";
    const errors = app.settingsErrors();
    expect(errors.intent_timeout).toBe("意图超时必须是 ≥ 0 的整数");
    expect(errors.reason_timeout).toBe("推理超时必须是 ≥ 0 的整数");
    app.settingsForm.intent_timeout = 0;
    expect(app.settingsErrors()).toEqual({ reason_timeout: "推理超时必须是 ≥ 0 的整数" });
  });

  test("disables submit-driven modals and actions while pending", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    for (const flag of [
      "isCreatingProject", "isSavingScope", "isCreatingIntent", "isConcluding", "isCompleting",
      "isAddingHint", "isReopening", "isRenaming", "isSavingSettings", "isConfirmingAction",
      "isSavingAgentProvider", "isSavingAgentModel", "isSettingAgentDefault",
    ]) {
      expect(html, flag).toContain(`:disabled="${flag}"`);
    }
    for (const closer of ["conclude", "complete", "hint", "reopen", "rename", "settings", "intent"]) {
      expect(html).toContain(`@click="dismissModal('${closer}')"`);
    }
    expect(html).toContain("x-text=\"isCreatingProject ? '创建中…' : '创建'\"");
    expect(html).toContain("x-text=\"isSavingSettings ? '保存中…' : '保存服务端设置'\"");
    expect(html).toContain("intentSubmitting === 'declare' ? '提交中…' : '声明'");
    expect(html).toContain("intentSubmitting === 'claim' ? '提交中…' : '声明并认领'");
  });

  test("surfaces inline errors instead of silently rejecting submits", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain("newProjectShowErrors && newProjectErrors().title");
    expect(html).toContain("newProjectShowErrors && newProjectErrors().targets");
    expect(html).toContain("renameFormError");
    expect(html).toContain("settingsFormError");
    expect(html).toContain("scopeFormError");
  });
});

describe("dangerous action confirmation", () => {
  test("confirms stopping an active project and resumes without asking", async () => {
    const app = loadState();
    const calls: Array<[string, string]> = [];
    app.setProjectStatus = async (id: string, status: string) => { calls.push([id, status]); };

    app.requestToggleProjectStop("", "active", "Ghost");
    app.requestToggleProjectStop("proj_done", "completed", "Done");
    expect(app.showConfirmModal).toBe(false);
    expect(calls).toEqual([]);

    app.requestToggleProjectStop("proj_a", "active", "Alpha");
    expect(app.showConfirmModal).toBe(true);
    expect(app.confirmState).toEqual({ kind: "stop", projectId: "proj_a", projectTitle: "Alpha", count: 1 });
    expect(app.confirmActionTitle()).toBe("停止项目");
    expect(app.confirmActionBody()).toContain("proj_a - Alpha");

    await app.confirmDangerousAction();
    expect(calls).toEqual([["proj_a", "stopped"]]);
    expect(app.showConfirmModal).toBe(false);
    expect(app.confirmState).toEqual({ kind: "", projectId: "", projectTitle: "", count: 0 });
    expect(app.isConfirmingAction).toBe(false);

    app.requestToggleProjectStop("proj_b", "stopped", "Beta");
    expect(calls).toEqual([["proj_a", "stopped"], ["proj_b", "active"]]);
    expect(app.showConfirmModal).toBe(false);
  });

  test("batches stop-all behind the same confirmation", async () => {
    const app = loadState();
    app.projects = [
      { id: "proj_a", status: "active" },
      { id: "proj_b", status: "stopped" },
      { id: "proj_c", status: "active" },
    ];
    let stopAllCalls = 0;
    app.stopAllActiveProjects = async () => { stopAllCalls += 1; };

    app.requestStopAllProjects();
    expect(app.confirmState).toEqual({ kind: "stop_all", projectId: "", projectTitle: "", count: 2 });
    expect(app.confirmActionTitle()).toBe("停止全部进行中的项目");
    expect(app.confirmActionBody()).toContain("将停止 2 个进行中的项目");

    await app.confirmDangerousAction();
    expect(stopAllCalls).toBe(1);
    expect(app.showConfirmModal).toBe(false);

    app.projects = [{ id: "proj_b", status: "stopped" }];
    app.requestStopAllProjects();
    expect(app.showConfirmModal).toBe(false);
  });

  test("ignores re-entrant confirmation and close while a stop is running", async () => {
    const app = loadState();
    let statusCalls = 0;
    app.setProjectStatus = async () => { statusCalls += 1; };

    app.showConfirmModal = true;
    app.confirmState = { kind: "stop", projectId: "proj_a", projectTitle: "", count: 1 };
    app.isConfirmingAction = true;
    await app.confirmDangerousAction();
    app.closeConfirmModal();
    expect(statusCalls).toBe(0);
    expect(app.showConfirmModal).toBe(true);

    app.projects = [{ id: "proj_a", status: "active" }];
    app.isStoppingAllProjects = true;
    app.requestStopAllProjects();
    expect(app.showConfirmModal).toBe(true);
    expect(app.confirmState.kind).toBe("stop");

    app.isConfirmingAction = false;
    app.dismissModal("confirm");
    expect(app.showConfirmModal).toBe(false);
    expect(app.confirmState.kind).toBe("");
  });

  test("reports a failed stop through the toast rather than leaving state dirty", async () => {
    const app = loadState();
    const toasts: Array<[string, string]> = [];
    app.showToast = (message: string, kind = "info") => { toasts.push([message, kind]); };
    app.setProjectStatus = async () => { throw new Error("boom"); };

    app.requestToggleProjectStop("proj_a", "active", "Alpha");
    await app.confirmDangerousAction();
    expect(toasts).toEqual([["boom", "error"]]);
    expect(app.showConfirmModal).toBe(false);
    expect(app.isConfirmingAction).toBe(false);
    expect(app.confirmState.kind).toBe("");

    app.requestToggleProjectStop("proj_b", "stopped", "Beta");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toasts).toEqual([["boom", "error"], ["boom", "error"]]);
  });

  test("routes every stop action through the confirmation modal", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain("@click=\"requestStopAllProjects()\"");
    expect(html).toContain("@click.stop=\"requestToggleProjectStop(p.id, p.status, p.title)\"");
    expect(html).toContain("@click=\"requestToggleProjectStop(selectedProjectId, project.project.status, project.project.title)\"");
    expect(html).not.toContain("toggleProjectStop()");
    expect(html).not.toContain("toggleProjectStopById(");
    expect(html).toContain("data-modal=\"confirm\"");
    expect(html).toContain("confirmDangerousAction()");
  });
});

describe("detail and graph interaction parity", () => {
  test("makes list cards keyboard-operable and names the graph anchors", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain('x-bind:data-project-card="p.id"');
    expect(html).toContain('@keydown.enter.self.prevent="openProject(p.id)"');
    expect(html).toContain('@keydown.space.self.prevent="openProject(p.id)"');
    expect(html).toContain('role="button" tabindex="0"');
    expect(html).toContain("data-list-search");
    expect(html).toContain('id="graphHeading" tabindex="-1"');
    expect(html).toContain('aria-label="返回项目列表"');
    expect(html).toContain("if (this.handleGraphEscape(event)) return;");
  });

  test("focuses the originating card on return and falls back to search", async () => {
    const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
    const hadDocument = "document" in globalThis;
    const focused: string[] = [];
    const card = (id: string) => ({
      getAttribute: (name: string) => (name === "data-project-card" ? id : null),
      focus: () => focused.push(`card:${id}`),
    });
    const search = { focus: () => focused.push("search") };
    try {
      (globalThis as any).document = {
        querySelectorAll: () => [card("proj_a"), card("proj_b")],
        querySelector: () => search,
      };
      const app = loadState();
      app.view = "list";

      app.focusListProject("proj_b");
      await tick();
      expect(focused).toEqual(["card:proj_b"]);

      // A deleted project has no card left, so focus lands on the search field.
      focused.length = 0;
      app.focusListProject("proj_gone");
      await tick();
      expect(focused).toEqual(["search"]);

      // Leaving the list view abandons the pending focus move.
      focused.length = 0;
      app.view = "graph";
      app.focusListProject("proj_a");
      await tick();
      expect(focused).toEqual([]);
    } finally {
      if (!hadDocument) delete (globalThis as any).document;
    }
  });

  test("clears the graph selection with Escape outside modals and form fields", () => {
    const app = loadState();
    const arm = () => {
      app.view = "graph";
      app.modalOrder = [];
      app.selectedNode = { type: "fact", id: "f1" };
      app.selectedFacts = ["f1"];
      app.sideTab = "log";
      app.selectedTimelineEntryId = "t1";
    };
    const escape = (overrides: Record<string, unknown> = {}) => {
      const event: any = {
        key: "Escape",
        target: { tagName: "DIV" },
        prevented: false,
        stopped: false,
        preventDefault: () => { event.prevented = true; },
        stopPropagation: () => { event.stopped = true; },
        ...overrides,
      };
      return event;
    };

    arm();
    const event = escape();
    expect(app.handleGraphEscape(event)).toBe(true);
    expect(event.prevented).toBe(true);
    expect(app.selectedNode).toBe(null);
    expect(app.selectedFacts).toEqual([]);
    expect(app.selectedTimelineEntryId).toBe(null);

    // An empty selection leaves Escape untouched.
    expect(app.handleGraphEscape(escape())).toBe(false);

    arm();
    app.modalOrder = ["hint"];
    const inModal = escape();
    expect(app.handleGraphEscape(inModal)).toBe(false);
    expect(inModal.prevented).toBe(false);
    expect(app.selectedFacts).toEqual(["f1"]);

    arm();
    app.view = "list";
    expect(app.handleGraphEscape(escape())).toBe(false);

    arm();
    expect(app.handleGraphEscape(escape({ target: { tagName: "INPUT" } }))).toBe(false);
    expect(app.handleGraphEscape(escape({ target: { tagName: "div", isContentEditable: true } }))).toBe(false);

    arm();
    expect(app.handleGraphEscape(escape({ isComposing: true }))).toBe(false);
    expect(app.handleGraphEscape(escape({ key: "Enter" }))).toBe(false);
    expect(app.selectedFacts).toEqual(["f1"]);
  });

  test("offers one clear-selection entry point and one delete entry point", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain('@click="clearSelection()"');
    expect(html).toContain("Esc 清除选择");
    expect(html).toContain('@click="deleteProjectById(project.project.id, project.project.title)"');
    expect(html).not.toContain("deleteProject()");
  });
});

describe("model and key settings", () => {
  test("wires the model settings tab to the agent config routes", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const app = loadState();
    expect(html).toContain('data-modal="settings"');
    expect(html).toContain('data-settings-tab="agent"');
    expect(app.modalClosers().settings).toBeTruthy();
    expect(html).toContain("/settings/agent");
    expect(html).toContain("/discover`");
    expect(html).toContain("/test`");
    expect(html).toContain("/settings/agent/default-model");
    expect(html).toContain("?force=true");
    expect(html).toContain("拉取模型列表");
    expect(html).toContain("Anthropic Messages");
    expect(html).toContain("OpenAI Chat Completions");
    expect(html).toContain("thinkingLevel");
    expect(html).toContain("contextWindow");
    expect(html).toContain("maxTokens");
    expect(app.agentProtocolLabel("anthropic-messages")).toContain("Anthropic Messages");
    expect(app.agentProtocolLabel("openai-completions")).toContain("OpenAI Chat Completions");
  });

  test("parses extra headers and rejects malformed lines", () => {
    const app = loadState();
    expect(
      app.agentHeadersFromText("X-Tenant: team-a\nX-Token=abc\n\n# comment"),
    ).toEqual({ headers: { "X-Tenant": "team-a", "X-Token": "abc" }, errors: [] });
    const parsed = app.agentHeadersFromText("NoColon\nBad Name: x\nX-Empty: \nX-A: 1\nX-B: 2");
    expect(parsed.headers).toEqual({ "X-A": "1", "X-B": "2" });
    expect(parsed.errors).toEqual([
      "第 1 行缺少 “Name: value”",
      "请求头名称非法：Bad Name",
      "请求头 X-Empty 的值不能为空",
    ]);
    expect(app.agentHeadersFromText(undefined)).toEqual({ headers: {}, errors: [] });
  });

  test("validates provider transport, key length and header text", () => {
    const app = loadState();
    app.agentConfig.builtinProviders = [{ provider: "anthropic" }, { provider: "openai" }];
    app.agentProviderForm = {
      id: "", name: "my-gateway", api: "", baseUrl: "", apiKey: "", headersText: "",
      clearHeaders: false, clearBaseUrl: false,
    };
    expect(app.agentProviderErrors()).toMatchObject({
      api: expect.stringContaining("需要选择协议"),
      baseUrl: expect.stringContaining("需要填写 Base URL"),
    });

    app.agentProviderForm.name = "anthropic";
    expect(app.agentProviderErrors()).toEqual({});

    app.agentProviderForm.apiKey = "x";
    expect(app.agentProviderErrors().apiKey).toContain("4–4096");
    app.agentProviderForm.apiKey = "";

    app.agentProviderForm = {
      id: "", name: "gateway", api: "openai-completions",
      baseUrl: "https://user:pass@example.com/v1", apiKey: "", headersText: "Bad Name: x",
      clearHeaders: false, clearBaseUrl: false,
    };
    expect(app.agentProviderErrors().baseUrl).toContain("不能包含用户名或密码");
    expect(app.agentProviderErrors().headers).toBe("请求头名称非法：Bad Name");

    app.agentProviderForm.baseUrl = "ftp://example.com";
    expect(app.agentProviderErrors().baseUrl).toContain("只支持 http/https");
    app.agentProviderForm.baseUrl = "not a url";
    expect(app.agentProviderErrors().baseUrl).toContain("不是合法地址");
  });

  test("posts a full model entry including advanced fields", async () => {
    const app = loadState();
    const calls: any[] = [];
    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return { id: "claude-x" };
    };
    app.loadAgentConfig = async () => {};
    app.showToast = () => {};
    app.agentModelForm = {
      id: "", originalId: "", providerId: "anthropic", modelId: "claude-x", name: "Claude X",
      thinkingLevel: "high", reasoning: true, inputText: true, inputImage: true,
      costInput: "1", costOutput: "2", costCacheRead: "0.1", costCacheWrite: "0.2",
      contextWindow: "200000", maxTokens: "8192", headersText: "X-Org: acme",
    };

    await app.saveAgentModel();
    expect(calls[0]![0]).toBe("POST");
    expect(calls[0]![1]).toBe("/settings/agent/models");
    expect(calls[0]![2]).toEqual({
      providerId: "anthropic",
      modelId: "claude-x",
      name: "Claude X",
      thinkingLevel: "high",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
      contextWindow: 200000,
      maxTokens: 8192,
      headers: { "X-Org": "acme" },
    });
    expect(app.agentModelForm.originalId).toBe("");
    expect(app.isSavingAgentModel).toBe(false);
  });

  test("updates an existing entry without resending its id", async () => {
    const app = loadState();
    const calls: any[] = [];
    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return { id: "m1" };
    };
    app.loadAgentConfig = async () => {};
    app.showToast = () => {};
    app.agentModelForm = {
      id: "m1", originalId: "m1", providerId: "p1", modelId: "model-b", name: "",
      thinkingLevel: "", reasoning: false, inputText: true, inputImage: false,
      costInput: "", costOutput: "", costCacheRead: "", costCacheWrite: "",
      contextWindow: "", maxTokens: "", headersText: "",
    };

    await app.saveAgentModel();
    expect(calls[0]![0]).toBe("PUT");
    expect(calls[0]![1]).toBe("/settings/agent/models/m1");
    expect(calls[0]![2]).toEqual({
      providerId: "p1",
      modelId: "model-b",
      reasoning: false,
      input: ["text"],
    });
  });

  test("rejects invalid model fields before calling the API", async () => {
    const app = loadState();
    const calls: any[] = [];
    app.api = async (...args: any[]) => { calls.push(args); return {}; };
    app.agentModelForm = {
      id: "bad id", originalId: "", providerId: "", modelId: "", name: "",
      thinkingLevel: "", reasoning: false, inputText: true, inputImage: false,
      costInput: "1", costOutput: "", costCacheRead: "", costCacheWrite: "",
      contextWindow: "0", maxTokens: "", headersText: "Bad Name: x",
    };
    const errors = app.agentModelErrors();
    expect(errors.providerId).toBe("请选择 provider");
    expect(errors.modelId).toBe("请填写模型 ID");
    expect(errors.id).toContain("条目 ID");
    expect(errors.cost).toContain("cost.output");
    expect(errors.contextWindow).toContain("正整数");
    expect(errors.headers).toContain("请求头名称非法");
    await app.saveAgentModel();
    expect(calls).toEqual([]);
    expect(app.agentModelError).toBeTruthy();
  });

  test("discovers models for the selected provider and fills the form", async () => {
    const app = loadState();
    const calls: any[] = [];
    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return { models: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }] };
    };
    app.agentModelForm.providerId = "p1";
    await app.discoverAgentModels();
    expect(calls).toEqual([["POST", "/settings/agent/providers/p1/discover", {}]]);
    expect(app.agentDiscover.models.map((item: any) => item.id)).toEqual(["a", "b"]);
    expect(app.agentDiscover.loading).toBe(false);

    app.pickDiscoveredModel("b");
    expect(app.agentModelForm.modelId).toBe("b");
    expect(app.agentModelForm.name).toBe("Beta");

    app.api = async () => ({ models: [] });
    await app.discoverAgentModels();
    expect(app.agentDiscover.error).toContain("没有拉到模型");
  });

  test("tests a provider through its default model and surfaces failures", async () => {
    const app = loadState();
    const calls: any[] = [];
    const toasts: string[] = [];
    app.showToast = (message: string) => { toasts.push(message); };
    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return { ok: true, response: "pong", summary: { modelPrefId: "cairn-worker" } };
    };

    await app.testAgentProvider("lab");
    expect(calls).toEqual([["POST", "/settings/agent/providers/lab/test", {}]]);
    expect(app.agentProviderTest).toEqual({
      providerId: "lab",
      modelId: "cairn-worker",
      loading: false,
      ok: true,
      error: "",
      response: "pong",
    });

    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return { ok: false, error: "provider has no model config; add a model before testing" };
    };
    await app.testAgentProvider("lab");
    expect(app.agentProviderTest.ok).toBe(false);
    expect(app.agentProviderTest.error).toContain("no model config");
    expect(app.agentProviderTest.loading).toBe(false);
    expect(toasts.at(-1)).toContain("no model config");
  });

  test("loads a captured flag and copies it from the project header", async () => {
    const app = loadState();
    const calls: any[] = [];
    app.api = async (method: string, path: string) => {
      calls.push([method, path]);
      return {
        found: true,
        flag: "CTF2{ui_fixture}",
        source: "findings.md",
        occurrences: 2,
        sources: ["findings.md", "notes.txt"],
        verification: {
          policy: { kind: "evidence" },
          latest: { kind: "evidence", ok: true, detail: "1 fact(s) have recorded evidence" },
        },
      };
    };

    await app.loadProjectFlag("proj_1");
    expect(calls).toEqual([["GET", "/projects/proj_1/flag"]]);
    expect(app.projectFlag.found).toBe(true);
    expect(app.projectFlag.flag).toBe("CTF2{ui_fixture}");
    expect(app.projectFlagSourceLabel()).toContain("2 个文件");
    expect(app.projectFlag.verification.policy.kind).toBe("evidence");
    expect(app.projectFlagVerificationLabel()).toBe("证据校验：通过");

    const copied: string[] = [];
    const toasts: string[] = [];
    app.copyText = async (text: string) => { copied.push(text); };
    app.showToast = (message: string) => { toasts.push(message); };
    await app.copyProjectFlag();
    expect(copied).toEqual(["CTF2{ui_fixture}"]);
    expect(toasts).toEqual(["已复制 Flag"]);

    app.api = async () => ({ found: false, flag: null, source: null, occurrences: 0, sources: [] });
    await app.loadProjectFlag("proj_1");
    expect(app.projectFlag.found).toBe(false);
    expect(app.projectFlag.flag).toBe("");
    // A response without a verification snapshot degrades to "no policy", not a crash.
    expect(app.projectFlagVerificationLabel()).toBe("");
    expect(app.projectFlag.candidates).toEqual([]);
    expect(app.projectFlagSuspect()).toBe(false);
  });

  test("shows flag candidates and warns when only masks were found", async () => {
    const app = loadState();
    app.api = async () => ({
      found: true,
      flag: "CTF2{ui_fixture}",
      source: "findings.md",
      occurrences: 2,
      sources: ["findings.md"],
      candidates: [
        { value: "CTF2{ui_fixture}", occurrences: 2, sources: 1, placeholder: false },
        { value: "flag{ui_second}", occurrences: 1, sources: 1, placeholder: false },
      ],
      placeholder_suspect: false,
      verification: { policy: null, latest: null },
    });

    await app.loadProjectFlag("proj_1");
    expect(app.projectFlagSuspect()).toBe(false);
    expect(app.projectFlagConfidenceLabel()).toBe("另有 1 个候选");

    app.api = async () => ({
      found: false,
      flag: null,
      source: null,
      occurrences: 0,
      sources: [],
      candidates: [
        { value: "CTF2{c8xxxx}", occurrences: 3, sources: 2, placeholder: true },
        { value: "CTF2{uuid}", occurrences: 1, sources: 1, placeholder: true },
      ],
      placeholder_suspect: true,
      verification: { policy: null, latest: null },
    });

    await app.loadProjectFlag("proj_1");
    expect(app.projectFlag.found).toBe(false);
    expect(app.projectFlagSuspect()).toBe(true);
    expect(app.projectFlagSuspectLabel()).toContain("2 处");
    expect(app.projectFlagSuspectValues()).toBe("CTF2{c8xxxx} / CTF2{uuid}");
    expect(app.projectFlagConfidenceLabel()).toBe("");

    // The suspect banner is a separate strip: it never renders as a captured flag.
    const html = readFileSync(INDEX_PATH, "utf8");
    const suspectStart = html.indexOf('x-if="projectFlagSuspect()"');
    expect(suspectStart).toBeGreaterThan(-1);
    const banner = html.slice(suspectStart, html.indexOf("</template>", suspectStart));
    expect(banner).toContain("Flag 可疑");
    expect(banner).toContain("border-amber-200");
    expect(banner).not.toContain("copyProjectFlag()");
  });

  test("shows challenge verification progress and polls until it passes", async () => {
    const app = loadState();
    app.api = async () => ({
      found: true,
      flag: "CTF2{ui_fixture}",
      source: "findings.md",
      occurrences: 1,
      sources: ["findings.md"],
      verification: {
        policy: { kind: "challenge", challenge_code: "web-01" },
        latest: {
          kind: "challenge",
          ok: false,
          flag_count: 3,
          flag_got_count: 1,
          detail: 'challenge "web-01" has 1/3 flags',
        },
      },
    });
    await app.loadProjectFlag("proj_1");
    expect(app.projectFlagVerificationLabel()).toBe(
      '题目校验：未通过（challenge "web-01" has 1/3 flags）',
    );
    expect(app.projectFlagVerificationClass()).toContain("amber");
    expect(app.projectFlagVerificationPending()).toBe(true);

    app.projectFlag.verification.latest = {
      kind: "challenge",
      ok: true,
      flag_count: 3,
      flag_got_count: 3,
      detail: 'challenge "web-01" has all 3 flag(s)',
    };
    expect(app.projectFlagVerificationLabel()).toBe("题目校验：通过 3/3");
    expect(app.projectFlagVerificationClass()).toContain("emerald");
    expect(app.projectFlagVerificationPending()).toBe(false);

    app.projectFlag.verification = { policy: { kind: "challenge", challenge_code: "web-01" }, latest: null };
    expect(app.projectFlagVerificationLabel()).toBe("题目校验：等待完成");
    expect(app.projectFlagVerificationPending()).toBe(true);

    app.projectFlag.verification = { policy: { kind: "off" }, latest: null };
    expect(app.projectFlagVerificationLabel()).toBe("校验已关闭");
    expect(app.projectFlagVerificationClass()).toContain("slate");
    expect(app.projectFlagVerificationPending()).toBe(false);
  });

  test("maps the new-project verification selector into the create payload", async () => {
    const app = loadState();
    const posts: any[] = [];
    app.api = async (method: string, path: string, body: unknown) => {
      if (method === "POST" && path === "/projects") {
        posts.push(body);
        return { project: { id: "proj_new" } };
      }
      return {};
    };
    app.loadProjects = async () => {};
    app.openProject = async () => {};
    app.showToast = () => {};
    app.$refs = {};
    const base = {
      title: "T",
      origin: "O",
      goal: "G",
      bootstrap: true,
      targetsText: "10.0.0.5",
      scopeNotes: "",
      hints: [{ content: "" }],
    };

    app.newProject = { ...base, verificationKind: "auto", challengeCode: "" };
    await app.createProject();
    expect(posts.at(-1).verification).toBeUndefined();

    app.newProject = { ...base, verificationKind: "challenge", challengeCode: " web-01 " };
    await app.createProject();
    expect(posts.at(-1).verification).toEqual({ kind: "challenge", challenge_code: "web-01" });
    expect(app.newProject.verificationKind).toBe("auto");

    app.newProject = { ...base, verificationKind: "challenge", challengeCode: "   " };
    await app.createProject();
    expect(posts.length).toBe(2);
    expect(app.newProjectShowErrors).toBe(true);

    app.newProject = { ...base, verificationKind: "evidence", challengeCode: "" };
    await app.createProject();
    expect(posts.at(-1).verification).toEqual({ kind: "evidence" });

    app.newProject = { ...base, verificationKind: "off", challengeCode: "" };
    await app.createProject();
    expect(posts.at(-1).verification).toEqual({ kind: "off" });
    expect(posts.length).toBe(4);
  });

  test("turns a 409 delete into an explicit force action", async () => {
    const app = loadState();
    const calls: string[] = [];
    app.loadAgentConfig = async () => {};
    app.showToast = () => {};
    const conflict: any = new Error("model config is referenced by prompt:cairn-worker");
    conflict.status = 409;
    app.api = async (_method: string, path: string) => {
      calls.push(path);
      throw conflict;
    };
    app.agentDelete = { kind: "model", id: "m1", name: "m1", force: false, loading: false, error: "" };

    await app.confirmAgentDelete();
    expect(app.agentDelete.force).toBe(true);
    expect(app.agentDelete.error).toContain("referenced by");
    expect(app.agentDelete.loading).toBe(false);
    expect(app.agentDeletePrompt()).toContain("强制删除");

    app.api = async (_method: string, path: string) => {
      calls.push(path);
      return { deleted: true };
    };
    await app.confirmAgentDelete();
    expect(calls).toEqual([
      "/settings/agent/models/m1",
      "/settings/agent/models/m1?force=true",
    ]);
    expect(app.agentDelete.kind).toBe("");
  });

  test("keeps the settings modal open while an agent write is pending", () => {
    const app = loadState();
    app.showSettings = true;
    app.isSavingAgentProvider = true;
    app.dismissModal("settings");
    expect(app.showSettings).toBe(true);

    app.isSavingAgentProvider = false;
    app.agentDelete = { kind: "provider", id: "p1", name: "p1", force: false, loading: true, error: "" };
    app.dismissModal("settings");
    expect(app.showSettings).toBe(true);

    app.agentDelete.loading = false;
    app.dismissModal("settings");
    expect(app.showSettings).toBe(false);
  });

  test("sets the default model through the dedicated route", async () => {
    const app = loadState();
    const calls: any[] = [];
    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return { id: "cairn-worker" };
    };
    app.loadAgentConfig = async () => {};
    app.showToast = () => {};

    await app.setDefaultAgentModel("m2");
    expect(calls).toEqual([
      ["PUT", "/settings/agent/default-model", { modelPrefId: "m2" }],
    ]);
    expect(app.isSettingAgentDefault).toBe(false);
  });
});

describe("skill settings tab", () => {
  function skillFixture() {
    return {
      prompt: "cairn-worker",
      promptFound: true,
      enabledCount: 1,
      skills: [
        {
          name: "recon",
          directory: "recon",
          description: "Fast reconnaissance",
          builtin: true,
          deleted: false,
          enabled: true,
        },
        {
          name: "agent-browser",
          directory: "agent-browser",
          description: "Drive a headless browser",
          builtin: true,
          deleted: false,
          enabled: false,
        },
        {
          name: "retired-skill",
          directory: "retired-skill",
          description: "",
          builtin: true,
          deleted: true,
          enabled: false,
        },
      ],
    };
  }

  test("adds a fifth settings tab wired to the skill routes", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain('data-settings-tab="skills"');
    expect(html).toContain("/settings/agent/skills");
    expect(html).toContain("saveSkill()");
    expect(html).toContain("toggleSkill(skill)");
    expect(html).toContain("restoreSkill(skill)");
    expect(html).toContain("skillDeletePrompt()");
    expect(html).toContain("添加后立即启用");
  });

  test("loads the skill list once and summarizes the allowlist", async () => {
    const app = loadState();
    const calls: string[] = [];
    app.api = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return skillFixture();
    };

    await app.openSettings("skills");
    expect(app.showSettings).toBe(true);
    expect(app.settingsTab).toBe("skills");
    expect(calls).toEqual(["GET /settings/agent/skills"]);
    expect(app.skillsConfig.loaded).toBe(true);
    expect(app.skillsConfig.promptFound).toBe(true);
    expect(app.skillsHint()).toBe("2 个技能 · 1 个已启用 · 已写入 cairn-worker prompt");

    await app.setSettingsTab("skills");
    expect(calls).toHaveLength(1);
    expect(app.settingsWritePending()).toBe(false);
  });

  test("validates and posts a new skill, then reloads the list", async () => {
    const app = loadState();
    const calls: Array<[string, string, unknown]> = [];
    app.api = async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET") return skillFixture();
      return { skill: { name: "lab-notes" } };
    };

    app.skillForm = { name: "Bad Name", description: "", content: "", enabled: true };
    await app.saveSkill();
    expect(app.skillFormError).toContain("名称只能");
    expect(calls).toEqual([]);

    app.skillForm = {
      name: "lab-notes",
      description: "Capture lab notes",
      content: "# Body",
      enabled: true,
    };
    await app.saveSkill();
    expect(calls).toEqual([
      [
        "POST",
        "/settings/agent/skills",
        {
          name: "lab-notes",
          description: "Capture lab notes",
          content: "# Body",
          enabled: true,
        },
      ],
      ["GET", "/settings/agent/skills", undefined],
    ]);
    expect(app.skillForm.name).toBe("");
    expect(app.skillForm.enabled).toBe(true);
    expect(app.isSavingSkill).toBe(false);
  });

  test("toggles a skill and confirms deletion inline", async () => {
    const app = loadState();
    const calls: Array<[string, string, unknown]> = [];
    app.api = async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET") return skillFixture();
      if (method === "DELETE") return { deleted: true, builtin: true };
      return { name: "agent-browser", directory: "agent-browser", enabled: true };
    };
    app.showToast = () => {};

    const skill = skillFixture().skills[1]!;
    await app.toggleSkill(skill);
    expect(calls[0]).toEqual([
      "PUT",
      "/settings/agent/skills/agent-browser/enabled",
      { enabled: true },
    ]);
    expect(calls[1]![0]).toBe("GET");

    app.requestSkillDelete(skill);
    expect(app.skillDeletePrompt()).toContain("内置");
    expect(app.skillDeletePrompt()).toContain("cairn-worker");
    calls.length = 0;
    await app.confirmSkillDelete();
    expect(calls[0]).toEqual(["DELETE", "/settings/agent/skills/agent-browser", undefined]);
    expect(calls[1]![0]).toBe("GET");
    expect(app.skillDelete.directory).toBe("");
  });

  test("restores a deleted builtin and blocks the dialog while writing", async () => {
    const app = loadState();
    const calls: Array<[string, string, unknown]> = [];
    app.api = async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return skillFixture();
    };
    app.showToast = () => {};

    await app.restoreSkill(skillFixture().skills[2]);
    expect(calls[0]).toEqual([
      "POST",
      "/settings/agent/skills/retired-skill/restore",
      {},
    ]);
    expect(app.skillRestore.loading).toBe(false);

    app.skillToggle = { directory: "recon", loading: true };
    expect(app.settingsWritePending()).toBe(true);
    app.skillToggle = { directory: "", loading: false };
    expect(app.settingsWritePending()).toBe(false);
  });

  test("shows load errors inline", async () => {
    const app = loadState();
    app.api = async () => {
      throw new Error("config dir is unreadable");
    };
    await app.openSettings("skills");
    expect(app.skillsConfig.loading).toBe(false);
    expect(app.skillsConfig.loaded).toBe(false);
    expect(app.skillsConfig.error).toBe("config dir is unreadable");
  });
});

describe("skill detail modal", () => {
  function skillRow(overrides: Record<string, unknown> = {}) {
    return {
      name: "recon",
      directory: "recon",
      description: "Fast reconnaissance",
      builtin: true,
      deleted: false,
      enabled: true,
      ...overrides,
    };
  }

  function filesFixture() {
    return {
      directory: "recon",
      files: [
        { path: "SKILL.md", size: 120 },
        { path: "references/payloads.md", size: 2048 },
      ],
      truncated: false,
    };
  }

  test("wires the preview button, file tree and body pane to one modal", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain('data-modal="skillDetail"');
    expect(html).toContain('@click="openSkillDetail(skill)"');
    expect(html).toContain('template x-for="row in skillDetailTree()"');
    expect(html).toContain('@click="selectSkillFile(row.path)"');
    expect(html).toContain("@click=\"toggleSkillFromDetail()\"");
    expect(html).toContain("/files`");
    expect(html).toContain("/file?path=");
    expect(html).toContain('x-show="skillDetail.binary"');
  });

  test("lists files and previews the first entry on open", async () => {
    const app = loadState();
    const calls: string[] = [];
    app.api = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith("/files")) return filesFixture();
      return { ...filesFixture().files[0], content: "# Recon\n", truncated: false, binary: false };
    };

    await app.openSkillDetail(skillRow());
    expect(app.showSkillDetail).toBe(true);
    expect(calls).toEqual([
      "GET /settings/agent/skills/recon/files",
      "GET /settings/agent/skills/recon/file?path=SKILL.md",
    ]);
    expect(app.skillDetailTree()).toEqual([
      { type: "file", path: "SKILL.md", depth: 0, label: "SKILL.md", size: 120 },
      { type: "dir", path: "references", depth: 0, label: "references", size: null },
      { type: "file", path: "references/payloads.md", depth: 1, label: "payloads.md", size: 2048 },
    ]);
    expect(app.skillDetail.content).toBe("# Recon\n");
    expect(app.skillDetail.loading).toBe(false);
    expect(app.skillDetailFileMeta()).toBe("120 B");
  });

  test("encodes nested paths and marks binary plus truncated reads", async () => {
    const app = loadState();
    const calls: string[] = [];
    app.api = async (_method: string, path: string) => {
      calls.push(path);
      if (path.includes("probe")) {
        return { path: "scripts/probe shell.sh", size: 40, content: "\u0000\u0000", truncated: false, binary: true };
      }
      return { path: "SKILL.md", size: 300000, content: "# big", truncated: true, binary: false };
    };
    app.resetSkillDetail(skillRow());

    await app.selectSkillFile("scripts/probe shell.sh");
    expect(calls[0]).toBe("/settings/agent/skills/recon/file?path=scripts%2Fprobe%20shell.sh");
    expect(app.skillDetail.binary).toBe(true);
    expect(app.skillDetail.content).toBe("");
    expect(app.skillDetailFileMeta()).toContain("二进制文件");

    await app.selectSkillFile("SKILL.md");
    expect(app.skillDetail.truncatedContent).toBe(true);
    expect(app.skillDetailFileMeta()).toBe("293.0 KiB · 截断预览");
    expect(app.skillDetail.contentLoading).toBe(false);
  });

  test("keeps read failures inside the preview pane and refuses deleted skills", async () => {
    const app = loadState();
    let calls = 0;
    app.api = async () => {
      calls += 1;
      throw new Error("skill file not found");
    };

    await app.openSkillDetail(skillRow({ deleted: true }));
    expect(app.showSkillDetail).toBe(false);
    expect(calls).toBe(0);

    await app.openSkillDetail(skillRow());
    expect(app.showSkillDetail).toBe(true);
    expect(app.skillDetail.error).toBe("skill file not found");
    expect(app.skillDetail.loading).toBe(false);
  });

  test("toggles from the header and refreshes the badge", async () => {
    const app = loadState();
    const calls: Array<[string, string]> = [];
    app.showToast = () => {};
    app.api = async (method: string, path: string) => {
      calls.push([method, path]);
      if (path.endsWith("/files")) return filesFixture();
      if (method === "PUT") return { name: "recon", directory: "recon", enabled: false };
      return {
        prompt: "cairn-worker",
        promptFound: true,
        enabledCount: 0,
        skills: [skillRow({ enabled: false })],
      };
    };

    await app.openSkillDetail(skillRow());
    app.skillsConfig = { ...app.skillsConfig, skills: [skillRow()] };
    calls.length = 0;
    await app.toggleSkillFromDetail();
    expect(calls[0]).toEqual(["PUT", "/settings/agent/skills/recon/enabled"]);
    expect(app.skillDetail.enabled).toBe(false);
    expect(app.skillToggle.loading).toBe(false);
  });

  test("blocks closing while a write is in flight and resets on close", () => {
    const app = loadState();
    app.showSkillDetail = true;
    app.skillDetail = { ...app.skillDetail, directory: "recon", files: filesFixture().files };
    app.skillToggle = { directory: "recon", loading: true };

    app.dismissModal("skillDetail");
    expect(app.showSkillDetail).toBe(true);

    app.skillToggle = { directory: "", loading: false };
    app.dismissModal("skillDetail");
    expect(app.showSkillDetail).toBe(false);
    expect(app.skillDetail.directory).toBe("");
    expect(app.skillDetail.files).toEqual([]);
    expect(app.skillDetail.content).toBe("");
  });

  test("autofocuses its own closer and returns focus to the skill row", async () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const modal = html.slice(html.indexOf('data-modal="skillDetail"'));
    expect(modal.slice(0, 2600)).toContain("data-autofocus");

    const focusLog: string[] = [];
    const trigger = { focus: () => { focusLog.push("trigger"); } };
    const target = { focus: () => { focusLog.push("target"); } };
    const element = { querySelector: (selector: string) => (selector === "[data-autofocus]" ? target : null) };
    const hadDocument = "document" in globalThis;
    (globalThis as any).document = { activeElement: trigger, contains: () => true };
    try {
      const app = loadState();
      app.showSkillDetail = true;
      app.syncModal("skillDetail", true, element);
      expect(app.modalReturnFocus.skillDetail).toBe(trigger);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(focusLog).toEqual(["target"]);

      app.showSkillDetail = false;
      app.syncModal("skillDetail", false, element);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(focusLog).toEqual(["target", "trigger"]);
      expect(app.modalReturnFocus.skillDetail).toBeUndefined();
    } finally {
      if (!hadDocument) delete (globalThis as any).document;
    }
  });
});

describe("runtime settings modal", () => {
  function editableFixture() {
    return {
      runtime: {
        execution: "local",
        max_workers: 4,
        max_running_projects: 2,
        max_project_workers: 2,
        interval: 1,
      },
      tasks: {
        bootstrap: { timeout: 900, conclude_timeout: 120 },
        reason: { timeout: 900, max_intents: 5 },
        explore: { timeout: 900, conclude_timeout: 120 },
        graph_slice: { enabled: true, max_facts: 80, max_intents: 60 },
        evidence: { min_bytes: 32 },
      },
      worker: {
        soft_deadline_ratio: 0.8,
        retain_task_files: true,
        result_grace_seconds: 15,
        scoped_artifacts: true,
      },
      retention: {
        session_max_age_days: 14,
        session_keep_per_project: 20,
        sweep_interval_seconds: 3600,
        refresh_artifacts: false,
      },
      verification: { evidence_enforcement: "completion", flag_review: "manual" },
      scope: { ssrf_markers: "observe" },
      proposals: {
        enabled: false,
        mode: "off",
        max_per_task: 20,
        max_file_bytes: 16384,
        max_total_bytes: 65536,
        allow_kinds: ["fact", "intent", "hint"],
        require_evidence_for_fact: true,
        min_confidence: 0,
      },
      strategist: {
        min_new_facts: 1,
        min_new_hints: 1,
        cooldown_seconds: 30,
        failure_backoff_seconds: 120,
        max_runs_per_hour: 12,
        zero_output_threshold: 3,
        stale_intent_seconds: 0,
        fallback_interval_seconds: 0,
        resource_pressure_ratio: 0,
      },
      budget: { max_project_tokens: 0, max_project_cost_usd: 0, max_project_tasks: 0 },
      worker_selection: {
        mode: "prompt",
        min_runs: 3,
        epsilon: 0.1,
        epsilon_decay: 0.99,
        epsilon_min: 0.01,
      },
    };
  }

  function viewFixture(patch: { overrides?: string[]; editable?: any } = {}) {
    return {
      defaults: editableFixture(),
      editable: patch.editable ?? editableFixture(),
      overrides: patch.overrides ?? [],
      updated_at: null,
      read_only: {
        server: "127.0.0.1:8001",
        runtime: {
          prompt_group: "default",
          healthcheck_timeout: 30,
          worker_healthcheck: "startup_and_task",
        },
        observer: {
          enabled: true,
          model: null,
          every_rounds: 4,
          window_rounds: 8,
          timeout_seconds: 60,
          max_reviews_per_task: 8,
          kernel_tasks: ["explore"],
        },
        audit_stream: { enabled: false, url: null },
        worker_profiles: [],
        common_env_keys: [],
        workspace: { mode: "local", root: null },
      },
    };
  }

  function flatten(value: any, prefix = ""): string[] {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return prefix === "" ? [] : [prefix];
    }
    return Object.entries(value).flatMap(([key, child]) =>
      flatten(child, prefix === "" ? key : `${prefix}.${key}`),
    );
  }

  function fieldsOf(app: any) {
    return app.runtimeGroups().flatMap((group: any) => group.fields);
  }

  test("ships one settings entry point per toolbar and a dedicated runtime tab", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain('data-modal="settings"');
    expect(html).toContain('data-settings-tab="runtime"');
    expect(html).toContain("runtimeGroups()");
    expect(html).toContain("data-runtime-test");
    expect(html).toContain('@click="testRuntimeExecution()"');
    expect(html.match(/@click="openSettings\(\)"/g)?.length).toBe(2);
  });

  test("renders every editable path exactly once", () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const paths = fieldsOf(app).map((field: any) => field.path);
    expect([...paths].sort()).toEqual(flatten(editableFixture()).sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("loads the view and clones the effective values into the form", async () => {
    const app = loadState();
    const view = viewFixture();
    app.api = async (method: string, path: string) => {
      expect([method, path]).toEqual(["GET", "/settings/runtime"]);
      return view;
    };

    await app.openSettings("runtime");
    expect(app.showSettings).toBe(true);
    expect(app.settingsTab).toBe("runtime");
    expect(app.runtimeConfig.loading).toBe(false);
    expect(app.runtimeConfig.view).toBe(view);
    expect(app.runtimeForm).toEqual(view.editable);
    expect(app.runtimeForm).not.toBe(view.editable);
  });

  test("opens the consolidated dialog on the requested tab and loads it once", async () => {
    const app = loadState();
    const calls: string[] = [];
    app.api = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (path === "/settings/runtime") return viewFixture();
      if (path === "/settings/agent") {
        return { defaultModelPrefId: null, providers: [], models: [], protocols: [], builtinProviders: [] };
      }
      return { intent_timeout: 5, reason_timeout: 5 };
    };

    await app.openSettings();
    expect(app.showSettings).toBe(true);
    expect(app.settingsTab).toBe("runtime");

    await app.setSettingsTab("agent");
    await app.setSettingsTab("server");
    await app.setSettingsTab("runtime");
    expect(calls).toEqual(["GET /settings/runtime", "GET /settings/agent", "GET /settings"]);
    expect(app.settingsWritePending()).toBe(false);
  });

  test("switches execution through the runtime patch", () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const execution = fieldsOf(app).find((field: any) => field.path === "runtime.execution");

    expect(execution.type).toBe("select");
    expect(execution.options.map((option: any) => option.value)).toEqual(["local", "container"]);
    app.setRuntimeFieldValue(execution, "container");
    expect(app.runtimePatch()).toEqual({ runtime: { execution: "container" } });
    app.setRuntimeFieldValue(execution, "local");
    expect(app.runtimePatch()).toEqual({});
  });

  test("toggles flag review through the runtime switch", () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const review = fieldsOf(app).find(
      (field: any) => field.path === "verification.flag_review",
    );

    expect(review.type).toBe("bool");
    expect([review.on, review.off]).toEqual(["manual", "off"]);
    expect(app.runtimeFieldValue(review)).toBe(true);

    app.setRuntimeFieldValue(review, false);
    expect(app.runtimeFieldValue(review)).toBe(false);
    expect(app.runtimePatch()).toEqual({ verification: { flag_review: "off" } });

    app.setRuntimeFieldValue(review, true);
    expect(app.runtimeFieldValue(review)).toBe(true);
    expect(app.runtimePatch()).toEqual({});
  });

  test("switches the SSRF marker mode and spells out what each mode does", () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const markers = fieldsOf(app).find(
      (field: any) => field.path === "scope.ssrf_markers",
    );

    expect(markers.type).toBe("select");
    expect(markers.options.map((option: any) => option.value)).toEqual([
      "observe",
      "block",
      "off",
    ]);
    expect(app.runtimeFieldValue(markers)).toBe("observe");

    app.setRuntimeFieldValue(markers, "block");
    expect(app.runtimePatch()).toEqual({ scope: { ssrf_markers: "block" } });

    const group = app
      .runtimeGroups()
      .find((entry: any) =>
        (entry.fields ?? []).some((field: any) => field.path === "scope.ssrf_markers"),
      );
    const notes: string = (group.notes ?? []).join("\n");
    for (const phrase of ["只记录", "拦截并拒绝", "忽略", "169.254.0.0/16", "protected_hosts"]) {
      expect(notes).toContain(phrase);
    }
  });

  test("tests the selected execution mode and clears a stale result on change", async () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const execution = fieldsOf(app).find((field: any) => field.path === "runtime.execution");
    const calls: unknown[] = [];
    app.showToast = () => {};
    app.api = async (method: string, path: string, body: any) => {
      calls.push({ method, path, body });
      return {
        execution: body.execution,
        ok: body.execution === "container",
        checks: [{ id: "docker", label: "Docker 守护进程", ok: body.execution === "container", detail: "28.0.1" }],
      };
    };

    await app.testRuntimeExecution();
    expect(calls).toEqual([
      { method: "POST", path: "/settings/runtime/test", body: { execution: "local" } },
    ]);
    expect(app.runtimeTest).toEqual({
      running: false,
      execution: "local",
      ok: false,
      checks: [{ id: "docker", label: "Docker 守护进程", ok: false, detail: "28.0.1" }],
      error: "",
    });

    app.setRuntimeFieldValue(execution, "container");
    await app.testRuntimeExecution();
    expect(app.runtimeTest.ok).toBe(true);
    expect(app.runtimeTest.checks).toHaveLength(1);

    app.setRuntimeFieldValue(execution, "local");
    expect(app.runtimeTest).toEqual({
      running: false,
      execution: "",
      ok: null,
      checks: [],
      error: "",
    });
  });

  test("shows probe errors inline when the test request fails", async () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    app.showToast = () => {};
    app.api = async () => {
      throw new Error("probe unavailable");
    };

    await app.testRuntimeExecution();

    expect(app.runtimeTest.running).toBe(false);
    expect(app.runtimeTest.ok).toBe(false);
    expect(app.runtimeTest.error).toBe("probe unavailable");
  });

  test("surfaces the 409 message when no dispatch config is loaded", async () => {
    const app = loadState();
    const conflict: any = new Error("no dispatch config is loaded");
    conflict.status = 409;
    app.api = async () => {
      throw conflict;
    };

    await app.openSettings("runtime");
    expect(app.runtimeForm).toBeNull();
    expect(app.runtimeConfig.view).toBeNull();
    expect(app.runtimeConfig.error).toBe("no dispatch config is loaded");
  });

  test("builds a minimal patch with only changed leaves", () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const fields = fieldsOf(app);
    const interval = fields.find((field: any) => field.path === "runtime.interval");
    const enabled = fields.find((field: any) => field.path === "proposals.enabled");
    const kinds = fields.find((field: any) => field.path === "proposals.allow_kinds");

    expect(app.runtimePatch()).toEqual({});

    app.setRuntimeFieldValue(interval, "3");
    app.setRuntimeFieldValue(enabled, true);
    expect(app.runtimePatch()).toEqual({
      runtime: { interval: 3 },
      proposals: { enabled: true },
    });

    app.toggleRuntimeKind(kinds, "intent", false);
    app.toggleRuntimeKind(kinds, "hint", false);
    expect(app.runtimePatch().proposals.allow_kinds).toEqual(["fact"]);
    app.toggleRuntimeKind(kinds, "intent", true);
    expect(app.runtimePatch().proposals.allow_kinds).toEqual(["fact", "intent"]);
  });

  test("ignores blank numeric input and keeps booleans typed", () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const interval = fieldsOf(app).find((field: any) => field.path === "runtime.interval");
    app.setRuntimeFieldValue(interval, "");
    expect(app.runtimeFieldValue(interval)).toBe(1);
    const flag = fieldsOf(app).find((field: any) => field.path === "worker.retain_task_files");
    app.setRuntimeFieldValue(flag, false);
    expect(app.runtimeFieldValue(flag)).toBe(false);
    expect(app.runtimePatch()).toEqual({ worker: { retain_task_files: false } });
  });

  test("puts the patch, applies the returned view and reports the override count", async () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const interval = fieldsOf(app).find((field: any) => field.path === "runtime.interval");
    app.setRuntimeFieldValue(interval, "2");

    const calls: any[] = [];
    const next = viewFixture({ overrides: ["runtime.interval"] });
    next.editable.runtime.interval = 2;
    app.api = async (method: string, path: string, body: unknown) => {
      calls.push([method, path, body]);
      return next;
    };
    const toasts: any[] = [];
    app.showToast = (message: string, type: string) => toasts.push([message, type]);

    await app.saveRuntimeSettings();
    expect(calls).toEqual([["PUT", "/settings/runtime", { runtime: { interval: 2 } }]]);
    expect(app.runtimeConfig.view).toBe(next);
    expect(app.runtimeForm).toEqual(next.editable);
    expect(app.runtimeConfig.saving).toBe(false);
    expect(toasts).toEqual([["运行配置已生效（覆盖 1 项）", undefined]]);
  });

  test("keeps the error inline when the server rejects the patch", async () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture();
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const bad: any = new Error("runtime.max_project_workers cannot exceed runtime.max_workers");
    bad.status = 400;
    app.api = async () => {
      throw bad;
    };

    await app.saveRuntimeSettings();
    expect(app.runtimeConfig.error).toContain("cannot exceed");
    expect(app.runtimeConfig.saving).toBe(false);
    expect(app.runtimeConfig.view).not.toBeNull();
  });

  test("requires a second click before deleting every override", async () => {
    const app = loadState();
    app.runtimeConfig.view = viewFixture({ overrides: ["runtime.interval"] });
    app.runtimeForm = app.cloneData(app.runtimeConfig.view.editable);
    const calls: string[] = [];
    const reset = viewFixture();
    app.api = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return reset;
    };
    app.showToast = () => {};

    await app.resetRuntimeSettings();
    expect(calls).toEqual([]);
    expect(app.runtimeResetArmed).toBe(true);

    await app.resetRuntimeSettings();
    expect(calls).toEqual(["DELETE /settings/runtime"]);
    expect(app.runtimeResetArmed).toBe(false);
    expect(app.runtimeConfig.view).toBe(reset);
    if (app.runtimeResetTimer) clearTimeout(app.runtimeResetTimer);
  });

  test("blocks closing while a runtime write is pending", () => {
    const app = loadState();
    app.showSettings = true;
    app.runtimeConfig.saving = true;
    app.dismissModal("settings");
    expect(app.showSettings).toBe(true);

    app.runtimeConfig.saving = false;
    app.dismissModal("settings");
    expect(app.showSettings).toBe(false);
  });

  test("uses the open project title as the document title", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const app = loadState();
    expect(html).toContain('x-effect="syncDocumentTitle()"');
    expect(html).toContain("<title>Cairnweave</title>");
    expect(html).toContain('tracking-tight">Cairnweave</span>');
    expect(app.documentTitle()).toBe("Cairnweave");

    app.view = "graph";
    app.project = { project: { title: "web-01" } };
    expect(app.documentTitle()).toBe("web-01 · Cairnweave");

    app.project = { project: { title: "   " } };
    expect(app.documentTitle()).toBe("Cairnweave");
  });
});

// ─────────────────────────── M27: first-payload budget ───────────────────────────
const APP_CSS_PATH = join(STATIC_DIR, "app.css");
const GRAPH_LOADER_PATH = join(STATIC_DIR, "graph-loader.js");
const BACKSLASH = String.fromCharCode(92);

/** Tailwind escapes selector punctuation, including hex escapes such as `\2c `. */
function unescapeCss(css: string): string {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .split(BACKSLASH)
    .join("");
}

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of html.matchAll(/(?:^|[^:\w])class="([^"]*)"/g)) {
    for (const token of match[1]!.split(/\s+/)) if (token) tokens.add(token);
  }
  for (const match of html.matchAll(/:class="([^"]*)"/g)) {
    for (const quoted of match[1]!.matchAll(/['"]([^'"]+)['"]/g)) {
      for (const token of quoted[1]!.split(/\s+/)) if (token) tokens.add(token);
    }
  }
  return tokens;
}

function cssHasSelector(css: string, token: string): boolean {
  const needle = `.${token}`;
  let at = css.indexOf(needle);
  while (at !== -1) {
    const next = css[at + needle.length];
    if (next === undefined || !/[A-Za-z0-9_-]/.test(next)) return true;
    at = css.indexOf(needle, at + 1);
  }
  return false;
}

describe("SSRF marker rows in the audit ledger", () => {
  const marker = (decision: string) => ({
    tool: "bash",
    action: "exec",
    decision,
    event: "ssrf_candidate",
    targets: ["http://10.0.0.9/admin"],
    reason: "SSRF markers (observe): 1 carried target(s), 1 outside the authorized scope",
  });

  test("badges the observation line and keeps it apart from a refusal", () => {
    const app = loadState();

    expect(app.auditEventKind(marker("allow"))).toBe("ssrf_candidate");
    expect(app.auditEventKindLabel(marker("allow"))).toBe("SSRF 标记");
    expect(app.auditEventKindLabel({ tool: "bash", decision: "allow" })).toBe("");
    expect(app.auditEventReasonClass(marker("allow"))).toBe("text-amber-700 break-words");
    expect(app.auditEventReasonClass(marker("block"))).toBe("text-rose-600 break-words");
  });

  test("renders the badge in the audit event list", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    expect(html).toContain("auditEventKindLabel(row.event)");
    expect(html).toContain(':class="auditEventReasonClass(row.event)"');
  });
});

describe("static asset delivery", () => {
  test("revalidates a vendored asset with its ETag instead of re-transferring it", async () => {
    const first = await api.handle(new Request("http://cairn.test/static/app.css"));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/css");
    expect(first.headers.get("cache-control")).toBe("no-cache");
    expect(first.headers.get("vary")).toBe("Accept-Encoding");
    expect(Date.parse(first.headers.get("last-modified")!)).not.toBeNaN();
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);

    const revalidated = await api.handle(
      new Request("http://cairn.test/static/app.css", { headers: { "if-none-match": etag } }),
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(etag);
    expect((await revalidated.arrayBuffer()).byteLength).toBe(0);

    const changed = await api.handle(
      new Request("http://cairn.test/static/app.css", { headers: { "if-none-match": '"0-0"' } }),
    );
    expect(changed.status).toBe(200);
  });

  test("compresses text assets, prefers brotli and stays identity when declined", async () => {
    const identity = await api.handle(new Request("http://cairn.test/"));
    const identityBytes = (await identity.arrayBuffer()).byteLength;
    expect(identity.headers.get("content-encoding")).toBeNull();

    const gzipped = await api.handle(
      new Request("http://cairn.test/", { headers: { "accept-encoding": "gzip, deflate" } }),
    );
    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    const gzippedBytes = (await gzipped.arrayBuffer()).byteLength;
    expect(gzippedBytes).toBeLessThan(identityBytes);

    const brotli = await api.handle(
      new Request("http://cairn.test/", { headers: { "accept-encoding": "gzip, deflate, br, zstd" } }),
    );
    expect(brotli.headers.get("content-encoding")).toBe("br");
    expect((await brotli.arrayBuffer()).byteLength).toBeLessThan(gzippedBytes);

    const vendor = await api.handle(
      new Request("http://cairn.test/static/graph-loader.js", { headers: { "accept-encoding": "br" } }),
    );
    expect(vendor.headers.get("content-type")).toContain("javascript");
    expect(vendor.headers.get("content-encoding")).toBe("br");
  });

  test("serves nothing outside the static directory", async () => {
    const missing = await api.handle(new Request("http://cairn.test/static/nope.js"));
    expect(missing.status).toBe(404);
    const escape = await api.handle(new Request("http://cairn.test/static/%2e%2e/package.json"));
    expect(escape.status).toBe(404);
  });

  test("loads only the stylesheet and the two boot scripts on first paint", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const eager = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!);
    expect(eager).toEqual(["/static/vendor/alpine.min.js", "/static/graph-loader.js"]);
    expect(html).toContain('<link rel="stylesheet" href="/static/app.css">');
    expect(html).not.toMatch(/<script[^>]*src="\/static\/vendor\/(?!alpine)/);
    expect(html).not.toContain("tailwindcss.js");
    expect(html).not.toContain("elk.bundled.js");
    expect(html).not.toContain("tailwind.config");
  });

  test("resolves every graph library the lazy loader names", () => {
    const loader = readFileSync(GRAPH_LOADER_PATH, "utf8");
    expect(() => new Function(loader)).not.toThrow();
    const paths = [...loader.matchAll(/'(\/static\/[^']+)'/g)].map((match) => match[1]!);
    for (const engine of ["dagre", "klay", "elk"]) {
      expect(loader).toContain(`${engine}: [`);
    }
    expect(paths.length).toBe(7);
    for (const path of paths) {
      expect(existsSync(join(STATIC_DIR, path.slice("/static/".length)))).toBe(true);
    }
    expect(existsSync(APP_CSS_PATH)).toBe(true);
  });

  test("keeps the graph behind its layout engine", async () => {
    const app = loadState();
    const globals = globalThis as Record<string, any>;
    const previous = { document: globals.document, window: globals.window, cytoscape: globals.cytoscape };
    const requested: string[] = [];
    try {
      globals.document = { getElementById: () => ({ id: "cy" }) };
      globals.window = {
        graphLoader: {
          ensure: async (engine: string) => {
            requested.push(engine);
            throw new Error("/static/vendor/elk.bundled.js");
          },
        },
      };
      globals.cytoscape = () => {
        throw new Error("graph built before its engine loaded");
      };
      app.layoutMode = "elk_lr";
      app.cy = null;
      await app.initGraph();
      expect(requested).toEqual(["elk"]);
      expect(app.cy).toBeNull();
      expect(app.toast.show).toBe(true);
      expect(app.toast.message).toContain("布局引擎加载失败");
    } finally {
      Object.assign(globals, previous);
    }

    const appScript = readFileSync(INDEX_PATH, "utf8").match(
      /<script>\s*(function cairnApp\(\)[\s\S]*?)<\/script>/,
    )![1]!;
    for (const method of ["applySelectedLayout", "saveLocalSettings"]) {
      const body = appScript.slice(appScript.indexOf(`${method}(`));
      expect(body.slice(0, 600)).toMatch(/await this\.ensureGraphEngine\(this\.layoutEngine\(\)\)/);
    }
  });

  test("ships a selector for every utility the markup asks for", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const css = unescapeCss(readFileSync(APP_CSS_PATH, "utf8"));
    const custom = new Set(
      [...html.match(/<style>([\s\S]*?)<\/style>/)![1]!.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!),
    );
    // `mono` is live now (the theme declares it), so the only inert utility left is
    // the opacity step `/92`, which is not in the default scale.
    const inert = new Set(["bg-white/92"]);
    const missing = [...classTokens(html)]
      .filter((token) => token.includes("-"))
      .filter((token) => !cssHasSelector(css, token) && !custom.has(token) && !inert.has(token));
    expect(missing).toEqual([]);
  });
});

/**
 * Cytoscape draws its own node and edge labels in canvas, where the size is bounded by
 * the node box, so those literals are not covered here — this guard is about DOM text.
 */
describe("typography scale", () => {
  const UI_CONFIG_PATH = join(import.meta.dir, "..", "..", "..", "..", "tools", "ui", "tailwind.config.mjs");
  const ROOT_PX = 16;

  function declaredSizes(css: string): number[] {
    return [...css.matchAll(/font-size:\s*([0-9.]+)(rem|px)/g)].map((match) =>
      match[2] === "rem" ? Number.parseFloat(match[1]!) * ROOT_PX : Number.parseFloat(match[1]!),
    );
  }

  test("keeps every DOM size on the named scale with 11px as the floor", () => {
    const html = readFileSync(INDEX_PATH, "utf8");
    const css = readFileSync(APP_CSS_PATH, "utf8");
    expect(html).not.toMatch(/text-\[\d/);
    expect(css).toContain(".text-2xs{font-size:.6875rem");
    const sizes = declaredSizes(css);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
    expect(html.match(/<style>([\s\S]*?)<\/style>/)![1]).not.toMatch(/font-size/);
  });

  test("declares the floor in the tailwind config instead of in markup", async () => {
    const config = readFileSync(UI_CONFIG_PATH, "utf8");
    expect(config).toMatch(/"2xs":\s*\["0\.6875rem"/);
  });

  test("keeps a monospace family in the font scale", () => {
    const config = readFileSync(UI_CONFIG_PATH, "utf8");
    // A top-level `fontFamily` replaces the whole scale, so listing only `sans` used to
    // leave the 94 `font-mono` call sites with no rule at all.
    expect(config).toMatch(/fontFamily:\s*\{[\s\S]*?sans:[\s\S]*?mono:\s*\[[\s\S]*?\n\s*\},/);
    expect(readFileSync(APP_CSS_PATH, "utf8")).toMatch(/\.font-mono\{font-family:ui-monospace/);
  });
});
