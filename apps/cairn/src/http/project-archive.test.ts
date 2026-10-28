import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProjectWriteup,
  configureDatabase,
  createProject,
  listProjectArtifacts,
  recordProjectArtifacts,
  run,
  type CairnDatabase,
  type ProjectArtifact,
  type ProjectWriteupSnapshot,
} from "@cairn/graph";

import {
  buildWriteupArchive,
  MAX_ARCHIVE_FILE_BYTES,
  MAX_ARCHIVE_FILES,
} from "./project-archive";
import { readZip } from "./zip";

const TASK = "explore-1a2b3c4d5e6f";

let directory: string;
let db: CairnDatabase;
let projectId: string;
let workspace: string;
let artifacts: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-archive-"));
  db = configureDatabase(join(directory, "cairn.db"));
  workspace = join(directory, "projects", "proj");
  artifacts = join(workspace, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  projectId = db.withConn((conn) =>
    createProject(conn, {
      title: "签到题复盘",
      origin: "目标 http://127.0.0.1:8080 提供登录页",
      goal: "拿到后台 Flag",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function write(relativePath: string, content: string | Buffer): void {
  const target = join(artifacts, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function index(): ProjectArtifact[] {
  return db.withConn((conn) => {
    recordProjectArtifacts(conn, { projectId, taskId: TASK, workspace });
    return listProjectArtifacts(conn, projectId);
  });
}

interface BundleInput {
  artifacts?: ProjectArtifact[];
  snapshot?: ProjectWriteupSnapshot;
  markdown?: string;
  source?: "draft" | "model";
  workspace?: string;
}

function bundle(input: BundleInput = {}) {
  return buildWriteupArchive({
    workspace: input.workspace ?? workspace,
    artifacts: input.artifacts ?? index(),
    snapshot: input.snapshot ?? db.withConn((conn) => buildProjectWriteup(conn, projectId)),
    markdown: input.markdown ?? "# Writeup：签到题复盘\n",
    source: input.source ?? "draft",
    generatedAt: new Date("2026-10-28T12:00:00Z"),
  });
}

function entries(bytes: Uint8Array): Map<string, Buffer> {
  return new Map(readZip(bytes).map((entry) => [entry.name, entry.data]));
}

function manifest(bytes: Uint8Array): string {
  return (entries(bytes).get("MANIFEST.md") ?? Buffer.from("")).toString("utf8");
}

describe("buildWriteupArchive", () => {
  test("bundles the writeup, a manifest and every indexed artifact", () => {
    write(`${TASK}/forge.py`, "print('payload')\n");
    write(`${TASK}/shot.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    write(`${TASK}/findings.md`, "响应正文\n");

    const result = bundle();
    const packed = entries(result.bytes);

    expect([...packed.keys()]).toEqual([
      "writeup.md",
      "MANIFEST.md",
      `artifacts/${TASK}/findings.md`,
      `artifacts/${TASK}/forge.py`,
      `artifacts/${TASK}/shot.png`,
    ]);
    expect(packed.get("writeup.md")?.toString("utf8")).toBe("# Writeup：签到题复盘\n");
    expect(packed.get(`artifacts/${TASK}/forge.py`)?.toString("utf8")).toBe("print('payload')\n");
    expect(packed.get(`artifacts/${TASK}/shot.png`)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    expect(result.bundled).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  test("lists bundled files with size and checksum in the manifest", () => {
    write(`${TASK}/forge.py`, "print('payload')\n");

    const text = manifest(bundle().bytes);

    expect(text).toContain("# 附件包清单：签到题复盘");
    expect(text).toContain(`| \`artifacts/${TASK}/forge.py\` |`);
    expect(text).toContain("writeup.md 来源：控制面草稿");
    expect(text).toContain("附件文件：1 个已打包");
  });

  test("records why a file was left out", () => {
    write(`${TASK}/kept.py`, "print(1)\n");
    write(`${TASK}/big.zip`, Buffer.alloc(MAX_ARCHIVE_FILE_BYTES + 1024, 0x41));
    const indexed = index();
    db.withConn((conn) =>
      run(
        conn,
        `INSERT INTO project_artifacts (project_id, path, task_id, size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        projectId,
        `${TASK}/gone.py`,
        TASK,
        12,
        "0".repeat(64),
        "2026-10-28T11:00:00Z",
      ),
    );
    const rows = db.withConn((conn) => listProjectArtifacts(conn, projectId));
    expect(indexed).toHaveLength(2);

    const result = bundle({ artifacts: rows });
    const text = manifest(result.bytes);

    expect(result.bundled).toEqual([`${TASK}/kept.py`]);
    expect(result.skipped.map((entry) => entry.path)).toEqual([`${TASK}/big.zip`, `${TASK}/gone.py`]);
    expect(text).toContain("单文件超过");
    expect(text).toContain("文件缺失或不是普通文件");
  });

  test("caps the bundle and says so in the manifest", () => {
    for (let file = 0; file < MAX_ARCHIVE_FILES + 2; file += 1) {
      write(`${TASK}/p-${String(file).padStart(4, "0")}.txt`, "x");
    }

    const result = bundle();

    expect(result.bundled).toHaveLength(MAX_ARCHIVE_FILES);
    expect(result.truncated).toBe(true);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.reason).toBe("超出附件包上限");
    expect(manifest(result.bytes)).toContain("受上限约束，未全部打包");
  });

  test("bundles only the writeup when nothing is indexed", () => {
    const result = bundle({ artifacts: [] });

    expect([...entries(result.bytes).keys()]).toEqual(["writeup.md", "MANIFEST.md"]);
    expect(manifest(result.bytes)).toContain("（没有可打包的附件）");
  });

  test("skips every file when the artifact directory is unreadable", () => {
    write(`${TASK}/forge.py`, "print(1)\n");
    const indexed = index();
    rmSync(artifacts, { recursive: true, force: true });

    const result = bundle({ artifacts: indexed });

    expect(result.bundled).toEqual([]);
    expect(result.skipped.every((entry) => entry.reason === "附件目录不可读")).toBe(true);
  });

  test("carries the model-written narrative when one is stored", () => {
    write(`${TASK}/forge.py`, "print(1)\n");

    const result = bundle({ markdown: "# 模型成稿\n", source: "model" });

    expect(entries(result.bytes).get("writeup.md")?.toString("utf8")).toBe("# 模型成稿\n");
    expect(manifest(result.bytes)).toContain("writeup.md 来源：模型撰写版");
  });

  test("refuses artifact paths that escape the workspace", () => {
    write("../outside.py", "print('outside')\n");
    write(`${TASK}/forge.py`, "print(1)\n");
    const indexed = index();
    db.withConn((conn) =>
      run(
        conn,
        `INSERT INTO project_artifacts (project_id, path, task_id, size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        projectId,
        "../outside.py",
        TASK,
        18,
        "0".repeat(64),
        "2026-10-28T11:00:00Z",
      ),
    );
    const rows = db.withConn((conn) => listProjectArtifacts(conn, projectId));

    const result = bundle({ artifacts: rows });

    expect(result.bundled).toEqual([`${TASK}/forge.py`]);
    expect([...entries(result.bytes).keys()]).not.toContain("artifacts/../outside.py");
    expect(result.skipped[0]?.path).toBe("../outside.py");
    expect(indexed).toHaveLength(1);
  });
});
