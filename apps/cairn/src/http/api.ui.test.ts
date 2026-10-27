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
    expect(overlays.length).toBeGreaterThanOrEqual(13);

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
    expect(flags.length).toBeGreaterThanOrEqual(13);
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
