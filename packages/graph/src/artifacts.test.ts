import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectArtifact,
  listProjectArtifacts,
  recordProjectArtifacts,
  refreshProjectArtifacts,
  type CairnDatabase,
} from "./index";

let directory: string;
let workspace: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-artifacts-"));
  workspace = join(directory, "workspace");
  mkdirSync(workspace, { recursive: true });
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "artifacts",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function record(taskId = "task-1"): ReturnType<typeof listProjectArtifacts> {
  return db.withConn((conn) =>
    recordProjectArtifacts(conn, { projectId, taskId, workspace }),
  );
}

describe("artifact indexing", () => {
  test("records nested files with relative paths, sizes and SHA-256", () => {
    mkdirSync(join(workspace, "artifacts", "nested"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "a.txt"), "alpha", "utf8");
    writeFileSync(join(workspace, "artifacts", "nested", "b.bin"), Buffer.from([1, 2, 3]));

    const artifacts = record();
    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "a.txt",
      "nested/b.bin",
    ]);
    expect(artifacts[0]).toMatchObject({
      size: 5,
      sha256: createHash("sha256").update("alpha").digest("hex"),
      task_id: "task-1",
    });
    expect(artifacts[1]!.size).toBe(3);
  });

  test("refreshes the index after files change or disappear", () => {
    mkdirSync(join(workspace, "artifacts"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "old.txt"), "old", "utf8");
    expect(record().map((artifact) => artifact.path)).toEqual(["old.txt"]);

    rmSync(join(workspace, "artifacts", "old.txt"));
    writeFileSync(join(workspace, "artifacts", "new.txt"), "new", "utf8");
    const refreshed = record("task-2");
    expect(refreshed.map((artifact) => artifact.path)).toEqual(["new.txt"]);
    expect(refreshed[0]!.task_id).toBe("task-2");
  });

  test("keeps the previous index when the artifacts directory is absent", () => {
    mkdirSync(join(workspace, "artifacts"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "keep.txt"), "keep", "utf8");
    record();
    rmSync(join(workspace, "artifacts"), { recursive: true, force: true });

    const artifacts = record("task-2");
    expect(artifacts.map((artifact) => artifact.path)).toEqual(["keep.txt"]);
    expect(artifacts[0]!.task_id).toBe("task-1");
  });

  test("keeps provenance when a sweep refreshes the index", () => {
    mkdirSync(join(workspace, "artifacts"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "old.txt"), "old", "utf8");
    record("task-1");

    writeFileSync(join(workspace, "artifacts", "old.txt"), "changed", "utf8");
    writeFileSync(join(workspace, "artifacts", "new.txt"), "new", "utf8");
    const refreshed = db.withConn((conn) =>
      refreshProjectArtifacts(conn, { projectId, workspace }),
    );
    expect(refreshed.map((artifact) => artifact.path)).toEqual(["new.txt", "old.txt"]);
    const byPath = new Map(refreshed.map((artifact) => [artifact.path, artifact]));
    expect(byPath.get("old.txt")).toMatchObject({ task_id: "task-1", size: 7 });
    expect(byPath.get("new.txt")?.task_id).toBe("retention-sweep");
  });

  test("skips symlinks so the scan cannot leave the workspace", () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    mkdirSync(join(workspace, "artifacts"), { recursive: true });
    let linked = true;
    try {
      symlinkSync(join(outside, "secret.txt"), join(workspace, "artifacts", "link.txt"));
    } catch {
      linked = false;
    }
    if (!linked) return;

    const artifacts = record();
    expect(artifacts).toEqual([]);
  });

  test("exposes lookup helpers scoped to the project", () => {
    mkdirSync(join(workspace, "artifacts"), { recursive: true });
    writeFileSync(join(workspace, "artifacts", "flag.txt"), "flag", "utf8");
    record();

    const found = db.withConn((conn) => getProjectArtifact(conn, projectId, "flag.txt"));
    expect(found?.size).toBe(4);
    expect(db.withConn((conn) => getProjectArtifact(conn, projectId, "missing"))).toBeNull();
    expect(db.withConn((conn) => listProjectArtifacts(conn, "unknown"))).toEqual([]);
  });
});

