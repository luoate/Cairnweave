import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDispatchConfig, type DispatchConfig } from "../config";
import type { CommandResult, CommandRunner } from "./docker";
import { probeExecutionMode } from "./probe";

const SOURCE = `server: "http://127.0.0.1:8000"
runtime:
  execution: local
  interval: 3
  max_workers: 4
  max_running_projects: 2
  max_project_workers: 1
  healthcheck_timeout: 15
  prompt_group: default
tasks:
  bootstrap: {timeout: 300, conclude_timeout: 90}
  reason: {timeout: 300, max_intents: 3}
  explore: {timeout: 600, conclude_timeout: 120}
`;

const CONTAINER_SOURCE = `${SOURCE.replace("execution: local", "execution: container")}container:
  image: "example/worker:latest"
  network_mode: "bridge"
  completed_action: remove
`;

function config(text = SOURCE): DispatchConfig {
  return parseDispatchConfig(Bun.YAML.parse(text) as Record<string, unknown>);
}

function fakeRunner(respond: (argv: readonly string[]) => CommandResult) {
  const calls: string[][] = [];
  return {
    calls,
    run(argv: readonly string[]): CommandResult {
      calls.push([...argv]);
      return respond(argv);
    },
  } satisfies CommandRunner & { calls: string[][] };
}

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(stderr = "boom"): CommandResult {
  return { code: 1, stdout: "", stderr };
}

let directory: string;
let workspace: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-probe-"));
  workspace = join(directory, "workspace");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("probeExecutionMode local", () => {
  test("checks the Bun binary and writes a probe file into the workspace", () => {
    const runner = fakeRunner(() => ok("1.4.4\n"));

    const result = probeExecutionMode("local", config(), { runner, workspaceRoot: workspace });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual(["runtime", "workspace"]);
    expect(result.checks[0]!.detail).toBe("Bun 1.4.4");
    expect(result.checks[1]!.detail).toBe(workspace);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]![0]).toBe(process.execPath);
    expect(runner.calls[0]![1]).toBe("--version");
  });

  test("reports a missing runtime without hiding the workspace check", () => {
    const runner = fakeRunner(() => fail("bun not found"));

    const result = probeExecutionMode("local", config(), { runner, workspaceRoot: workspace });

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ id: "runtime", ok: false, detail: "bun not found" });
    expect(result.checks[1]).toMatchObject({ id: "workspace", ok: true });
  });

  test("fails when the workspace path cannot be created", () => {
    const blocker = join(directory, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");

    const result = probeExecutionMode("local", config(), {
      runner: fakeRunner(() => ok("1.4.4")),
      workspaceRoot: join(blocker, "workspace"),
    });

    expect(result.ok).toBe(false);
    expect(result.checks[1]).toMatchObject({ id: "workspace", ok: false });
    expect(result.checks[1]!.detail).toContain("blocked");
  });
});

describe("probeExecutionMode container", () => {
  test("checks the daemon, the image and a --rm start", () => {
    const runner = fakeRunner((argv) => {
      if (argv.includes("version")) return ok("28.0.1\n");
      if (argv.includes("inspect")) return ok("sha256:abc123\n");
      return ok("1.4.4\n");
    });

    const result = probeExecutionMode("container", config(CONTAINER_SOURCE), {
      runner,
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      "docker",
      "image",
      "start",
      "workspace",
    ]);
    expect(result.checks[1]!.detail).toBe("sha256:abc123");
    const start = runner.calls.find((argv) => argv.includes("run"))!;
    expect(start).toContain("--rm");
    expect(start).toContain("--network");
    expect(start).toContain("none");
    expect(start).toContain("example/worker:latest");
  });

  test("stops after a missing image and names the build command", () => {
    const runner = fakeRunner((argv) =>
      argv.includes("version") ? ok("28.0.1") : fail("No such image: example/worker:latest"),
    );

    const result = probeExecutionMode("container", config(CONTAINER_SOURCE), {
      runner,
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.id)).toEqual(["docker", "image", "start"]);
    expect(result.checks[2]).toMatchObject({ id: "start", ok: false });
    expect(result.checks[2]!.detail).toContain("docker build -f Dockerfile.worker");
    expect(runner.calls.some((argv) => argv.includes("run"))).toBe(false);
  });

  test("reports only the daemon when Docker is unreachable", () => {
    const runner = fakeRunner(() => fail("cannot connect to the Docker daemon"));

    const result = probeExecutionMode("container", config(CONTAINER_SOURCE), {
      runner,
      workspaceRoot: workspace,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ id: "docker", ok: false });
    expect(runner.calls).toHaveLength(1);
  });

  test("falls back to cairn-worker:latest when dispatch.yaml has no container section", () => {
    const runner = fakeRunner((argv) =>
      argv.includes("version") ? ok("28.0.1") : fail("No such image"),
    );

    const result = probeExecutionMode("container", config(), {
      runner,
      workspaceRoot: workspace,
    });

    expect(result.checks[1]!.label).toContain("cairn-worker:latest");
    expect(runner.calls[1]).toContain("cairn-worker:latest");
  });
});
