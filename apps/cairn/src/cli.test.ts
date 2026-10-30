import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_PROTOCOL_VERSION, type WorkerTask } from "@cairn/contracts";

const CLI = join(import.meta.dir, "cli.ts");
const workDir = mkdtempSync(join(tmpdir(), "cairn-cli-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function validTask(): WorkerTask {
  return {
    protocol: TASK_PROTOCOL_VERSION,
    taskId: "task-1",
    kind: "explore",
    projectId: "project-1",
    intentId: "intent-1",
    prompt: "advance intent-1",
    graphSnapshotPath: join(workDir, "graph.yaml"),
    workspace: join(workDir, "workspace"),
    sessionDir: join(workDir, "session"),
    resultPath: join(workDir, "session", "result.json"),
    scope: { targets: ["example.test"] },
    hardDeadlineSeconds: 900,
  };
}

function run(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function writeTask(name: string, value: unknown): string {
  const path = join(workDir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("cairn CLI", () => {
  test("prints its version", () => {
    const { code, stdout } = run(["version"]);
    expect(code).toBe(0);
    expect(stdout).toContain("cairn 0.50.0-m30");
  });

  test("prints usage for help and for no command", () => {
    expect(run(["help"]).stdout).toContain("cairn worker --task");
    expect(run([]).stdout).toContain("cairn serve");
  });

  test("rejects unknown commands with the usage exit code", () => {
    const { code, stderr } = run(["explode"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
  });

  test("worker requires --task", () => {
    const { code, stderr } = run(["worker"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--task");
  });

  test("worker rejects a missing task file", () => {
    const { code, stderr } = run(["worker", "--task", join(workDir, "missing.json")]);
    expect(code).toBe(10);
    expect(stderr).toContain("cannot read task");
  });

  test("worker reports every contract violation", () => {
    const path = writeTask("invalid.json", { ...validTask(), scope: { targets: [] } });
    const { code, stderr } = run(["worker", "--task", path]);
    expect(code).toBe(10);
    expect(stderr).toContain("invalid task");
    expect(stderr).toContain("scope.targets");
  });

  test("worker rejects a result path outside its session directory", () => {
    const task = validTask();
    const path = writeTask("bad-result-path.json", {
      ...task,
      resultPath: join(workDir, "escape.json"),
    });
    const { code, stderr } = run(["worker", "--task", path]);
    expect(code).toBe(10);
    expect(stderr).toContain("resultPath must be inside sessionDir");
  });

  test("worker executes a valid task and writes its result", () => {
    const task = validTask();
    const path = writeTask("valid.json", task);
    const { code, stderr } = run(["worker", "--task", path]);
    expect(code).toBe(0);
    expect(stderr).toContain("task-1");
    const result = JSON.parse(readFileSync(task.resultPath, "utf8"));
    expect(result).toMatchObject({
      accepted: true,
      data: { description: "fake fact from intent-1" },
    });
    expect(result.evidence_refs).toEqual(["artifacts/fake-task-1.txt"]);
    expect(existsSync(join(task.workspace, "artifacts", "fake-task-1.txt"))).toBe(true);
  });
});
