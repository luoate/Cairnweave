import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  CONTAINER_WORKSPACE,
  containerPathFor,
  fileScopeTargetPath,
  mapScopeTargetForWorker,
  workerFileUrl,
} from "./paths";

describe("container path mapping", () => {
  test("maps the workspace root and its children", () => {
    const workspace = resolve("C:/runs/project-a");
    expect(containerPathFor(workspace, workspace)).toBe(CONTAINER_WORKSPACE);
    expect(containerPathFor(workspace, resolve(workspace, "artifacts", "out.txt"))).toBe(
      "/cairn/workspace/artifacts/out.txt",
    );
  });

  test("rejects paths outside the workspace and sibling prefixes", () => {
    const workspace = resolve("C:/runs/project-a");
    expect(containerPathFor(workspace, resolve("C:/runs/project-b/x"))).toBeNull();
    expect(containerPathFor(workspace, resolve("C:/runs/project-a/../project-b"))).toBeNull();
  });
});

describe("file: scope targets", () => {
  test("parses win and posix forms", () => {
    expect(fileScopeTargetPath("file:///C:/evidence/a.txt")).toBe("C:\\evidence\\a.txt");
    expect(resolve(fileScopeTargetPath("file:///tmp/evidence")!)).toBe(
      process.platform === "win32" ? resolve("C:/tmp/evidence") : resolve("/tmp/evidence"),
    );
    expect(resolve(fileScopeTargetPath("file:/tmp/evidence")!)).toBe(
      process.platform === "win32" ? resolve("C:/tmp/evidence") : resolve("/tmp/evidence"),
    );
  });

  test("decodes percent escapes", () => {
    expect(fileScopeTargetPath("file:///tmp/a%20b")).toContain("a b");
  });

  test("returns null for non-file and remote-authority targets", () => {
    expect(fileScopeTargetPath("https://example.test/")).toBeNull();
    expect(fileScopeTargetPath("file://server/share/x")).toBeNull();
  });
});

describe("worker scope rewriting", () => {
  test("builds a file URL without assuming the platform", () => {
    expect(workerFileUrl("/cairn/workspace/a b.txt")).toBe(
      "file:///cairn/workspace/a%20b.txt",
    );
  });

  test("rewrites only targets under the workspace", () => {
    const map = (hostPath: string): string | null =>
      hostPath.endsWith("inside.txt") ? "/cairn/workspace/inside.txt" : null;

    expect(mapScopeTargetForWorker("file:///C:/ws/inside.txt", map)).toBe(
      "file:///cairn/workspace/inside.txt",
    );
    expect(mapScopeTargetForWorker("file:///C:/other/outside.txt", map)).toBe(
      "file:///C:/other/outside.txt",
    );
    expect(mapScopeTargetForWorker("127.0.0.1:8080", map)).toBe("127.0.0.1:8080");
  });
});
