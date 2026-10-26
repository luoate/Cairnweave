import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DockerRuntime,
  checkDocker,
  containerNameFor,
  type CommandResult,
  type CommandRunner,
} from "./docker";

interface Recorded {
  argv: string[];
}

function fakeRunner(
  respond: (argv: readonly string[]) => CommandResult | undefined,
): { runner: CommandRunner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    runner: {
      run(argv) {
        calls.push({ argv: [...argv] });
        return respond(argv) ?? { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

const inspectMissing: CommandResult = {
  code: 1,
  stdout: "",
  stderr: "Error: No such object: cairn-dispatch-proj-1",
};

function runtime(
  runner: CommandRunner,
  overrides: {
    completedAction?: "remove" | "stop";
    spawn?: (argv: readonly string[]) => {
      exited: Promise<number>;
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      kill: (signal?: string) => void;
    };
  } = {},
): {
  runtime: DockerRuntime;
  spawned: string[][];
  spawnedEnvs: Array<Record<string, string> | undefined>;
  killed: string[];
  logs: string[];
} {
  const spawned: string[][] = [];
  const spawnedEnvs: Array<Record<string, string> | undefined> = [];
  const killed: string[] = [];
  const logs: string[] = [];
  const instance = new DockerRuntime({
    container: {
      image: "cairn-worker:test",
      networkMode: "bridge",
      completedAction: overrides.completedAction ?? "remove",
      capAdd: ["NET_RAW"],
      workspaceRoot: null,
      workerArgv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
    },
    agentConfigDir: join(tmpdir(), "cairn-agent-config-test"),
    log: (message) => logs.push(message),
    dockerArgv: ["docker"],
    runner,
    spawn: (argv, options) => {
      spawned.push([...argv]);
      spawnedEnvs.push(options.env);
      if (overrides.spawn !== undefined) return overrides.spawn(argv);
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        kill: (signal) => killed.push(signal ?? "SIGTERM"),
      };
    },
  });
  return { runtime: instance, spawned, spawnedEnvs, killed, logs };
}

const HOST_WORKSPACE = join(tmpdir(), "cairn-docker-test", "proj-1");

describe("docker container lifecycle", () => {
  test("creates a long-lived container with mounts, labels and a read-only config", () => {
    const { runner, calls } = fakeRunner((argv) =>
      argv.includes("inspect") ? inspectMissing : undefined,
    );
    const { runtime: docker, logs } = runtime(runner);

    expect(docker.ensureProject("proj-1", HOST_WORKSPACE)).toBe(true);
    const runCall = calls.find((call) => call.argv.includes("run"));
    expect(runCall).toBeDefined();
    const argv = runCall!.argv;

    expect(argv).toContain("--name");
    expect(argv).toContain(containerNameFor("proj-1"));
    expect(argv).toContain("cairn.project=proj-1");
    expect(argv).toContain("cairn.managed=1");
    expect(argv).toContain(`type=bind,source=${HOST_WORKSPACE},target=/cairn/workspace`);
    expect(argv).toContain(
      `type=bind,source=${join(tmpdir(), "cairn-agent-config-test")},target=/cairn/agent-config,readonly`,
    );
    expect(argv).toContain("CAIRN_AGENT_CONFIG_DIR=/cairn/agent-config");
    expect(argv).toContain("CAIRN_AGENT_CONFIG_READONLY=1");
    expect(argv).toContain("--cap-add");
    expect(argv).toContain("NET_RAW");
    expect(argv.slice(-3)).toEqual(["cairn-worker:test", "sleep", "infinity"]);
    expect(logs.every((line) => !line.includes("failed"))).toBe(true);
  });

  test("reuses a running container and restarts a stopped one", () => {
    const running = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    expect(runtime(running.runner).runtime.ensureProject("proj-1", HOST_WORKSPACE)).toBe(true);
    expect(running.calls.some((call) => call.argv.includes("run"))).toBe(false);

    const stopped = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "false\n", stderr: "" } : undefined,
    );
    expect(runtime(stopped.runner).runtime.ensureProject("proj-1", HOST_WORKSPACE)).toBe(true);
    const start = stopped.calls.find((call) => call.argv.includes("start"));
    expect(start).toBeDefined();
    expect(start!.argv).toContain(containerNameFor("proj-1"));
  });

  test("fails closed when inspect fails for any other reason", () => {
    const { runner } = fakeRunner((argv) =>
      argv.includes("inspect")
        ? { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
        : undefined,
    );
    const { runtime: docker, logs } = runtime(runner);
    expect(docker.ensureProject("proj-1", HOST_WORKSPACE)).toBe(false);
    expect(logs.join("\n")).toContain("container inspect failed");
  });

  test("maps host paths after the project container is known", () => {
    const { runner } = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    const { runtime: docker } = runtime(runner);
    expect(() => docker.mapPath(join(HOST_WORKSPACE, "x"))).toThrow();
    docker.ensureProject("proj-1", HOST_WORKSPACE);
    expect(docker.mapPath(join(HOST_WORKSPACE, "x"))).toBe("/cairn/workspace/x");
    expect(docker.mapPathIfUnderWorkspace(join(tmpdir(), "elsewhere"))).toBeNull();
  });
});

describe("docker worker execution", () => {
  test("execs one task with only common_env and explicit CAIRN_* variables", () => {
    const { runner } = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    const { runtime: docker, spawned } = runtime(runner);
    docker.ensureProject("proj-1", HOST_WORKSPACE);

    const taskPath = "/cairn/workspace/.cairn/sessions/task-1/task.json";
    docker.spawnWorker({
      taskId: "task-1",
      projectId: "proj-1",
      workerTaskPath: taskPath,
      workerWorkspace: "/cairn/workspace",
      hostWorkspace: HOST_WORKSPACE,
      baseEnv: {
        CAIRN_SOLVER: "breachweave",
        HTTP_PROXY: "http://proxy:1",
        CAIRN_OBSERVER_ENABLED: "0",
      },
      controllerEnv: { SECRET_TOKEN: "do-not-leak", CAIRN_SOLVER: "ignored" },
      extraEnv: {
        CAIRN_OBSERVER_ENABLED: "1",
        CAIRN_OBSERVER_BOARD_DIR: "/cairn/workspace/.cairn/board",
      },
      hardDeadlineSeconds: 30,
    });

    expect(spawned).toHaveLength(1);
    const argv = spawned[0]!;
    expect(argv.slice(0, 6)).toEqual([
      "docker",
      "exec",
      "-i",
      "-w",
      "/cairn/workspace",
      "-e",
    ]);
    expect(argv).toContain("CAIRN_SOLVER=breachweave");
    expect(argv).toContain("HTTP_PROXY=http://proxy:1");
    expect(argv).toContain("CAIRN_AGENT_CONFIG_DIR=/cairn/agent-config");
    // Scheduler-computed variables override common_env and never come from the controller.
    expect(argv).toContain("CAIRN_OBSERVER_ENABLED=1");
    expect(argv).not.toContain("CAIRN_OBSERVER_ENABLED=0");
    expect(argv).toContain(
      "CAIRN_OBSERVER_BOARD_DIR=/cairn/workspace/.cairn/board",
    );
    // The control plane's environment must never be passed through wholesale.
    expect(argv.join(" ")).not.toContain("SECRET_TOKEN");
    expect(argv).toContain(containerNameFor("proj-1"));
    expect(argv.slice(-5)).toEqual([
      "bun",
      "/app/apps/cairn/src/cli.ts",
      "worker",
      "--task",
      taskPath,
    ]);
  });

  test("passes the audit token through the docker client environment, not argv", () => {
    const { runner } = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    const { runtime: docker, spawned, spawnedEnvs } = runtime(runner);
    docker.ensureProject("proj-1", HOST_WORKSPACE);

    const token = "cairn_audit_test_token_do_not_log";
    docker.spawnWorker({
      taskId: "task-1",
      projectId: "proj-1",
      workerTaskPath: "/cairn/workspace/.cairn/sessions/task-1/task.json",
      workerWorkspace: "/cairn/workspace",
      hostWorkspace: HOST_WORKSPACE,
      baseEnv: {},
      controllerEnv: { SECRET_TOKEN: "do-not-leak" },
      extraEnv: {
        CAIRN_AUDIT_STREAM_URL: "http://host.docker.internal:8000",
        CAIRN_AUDIT_STREAM_TOKEN: token,
      },
      hardDeadlineSeconds: 30,
    });

    const argv = spawned[0]!;
    expect(argv).toContain("CAIRN_AUDIT_STREAM_URL=http://host.docker.internal:8000");
    expect(argv).toContain("CAIRN_AUDIT_STREAM_TOKEN");
    expect(argv.join(" ")).not.toContain(token);
    expect(spawnedEnvs[0]?.["CAIRN_AUDIT_STREAM_TOKEN"]).toBe(token);
    // The token is passed to the docker CLI, not to the container, as a bare name.
    expect(argv).not.toContain(`CAIRN_AUDIT_STREAM_TOKEN=${token}`);
    // The control plane's environment is still not inherited wholesale.
    expect(spawnedEnvs[0]?.["SECRET_TOKEN"]).toBeUndefined();
  });

  test("signals only the task process, not the whole project container", () => {
    const { runner, calls } = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    const { runtime: docker, killed } = runtime(runner);
    docker.ensureProject("proj-1", HOST_WORKSPACE);
    const taskPath = "/cairn/workspace/.cairn/sessions/task-1/task.json";
    const handle = docker.spawnWorker({
      taskId: "task-1",
      projectId: "proj-1",
      workerTaskPath: taskPath,
      workerWorkspace: "/cairn/workspace",
      hostWorkspace: HOST_WORKSPACE,
      baseEnv: {},
      controllerEnv: {},
      hardDeadlineSeconds: 30,
    });

    handle.terminate();
    const term = calls.find((call) => call.argv.includes("pkill"));
    expect(term).toBeDefined();
    expect(term!.argv).toContain("-SIGTERM");
    expect(term!.argv).toContain(taskPath);
    expect(calls.some((call) => call.argv.includes("kill"))).toBe(false);

    handle.kill();
    expect(calls.filter((call) => call.argv.includes("pkill"))).toHaveLength(2);
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("docker cleanup", () => {
  test("removes inactive projects and keeps active ones", () => {
    const { runner, calls } = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    const { runtime: docker } = runtime(runner, { completedAction: "remove" });
    docker.ensureProject("proj-1", HOST_WORKSPACE);
    docker.ensureProject("proj-2", join(tmpdir(), "cairn-docker-test", "proj-2"));

    docker.cleanupInactive(new Set(["proj-1"]));
    const removals = calls.filter((call) => call.argv.includes("rm"));
    expect(removals).toHaveLength(1);
    expect(removals[0]!.argv).toContain(containerNameFor("proj-2"));

    docker.cleanupInactive(new Set(["proj-1"]));
    expect(calls.filter((call) => call.argv.includes("rm"))).toHaveLength(1);
  });

  test("stops instead of removing when completed_action is stop, and stops on close", () => {
    const { runner, calls } = fakeRunner((argv) =>
      argv.includes("inspect") ? { code: 0, stdout: "true\n", stderr: "" } : undefined,
    );
    const { runtime: docker } = runtime(runner, { completedAction: "stop" });
    docker.ensureProject("proj-1", HOST_WORKSPACE);
    docker.cleanupInactive(new Set());
    expect(calls.some((call) => call.argv.includes("stop"))).toBe(true);
    expect(calls.some((call) => call.argv.includes("rm"))).toBe(false);

    docker.ensureProject("proj-2", join(tmpdir(), "cairn-docker-test", "proj-2"));
    docker.close();
    const stops = calls.filter((call) => call.argv.includes("stop"));
    expect(stops.some((call) => call.argv.includes(containerNameFor("proj-2")))).toBe(true);
  });
});

describe("checkDocker", () => {
  test("reports the server version and the failure detail", () => {
    const ok = fakeRunner(() => ({ code: 0, stdout: "27.0.0\n", stderr: "" }));
    expect(checkDocker(["docker"], ok.runner)).toEqual({ ok: true, detail: "27.0.0" });

    const missing = fakeRunner(() => ({
      code: 127,
      stdout: "",
      stderr: "docker: command not found",
    }));
    const result = checkDocker(["docker"], missing.runner);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("command not found");
  });
});

describe("container names", () => {
  test("are deterministic and docker-safe", () => {
    expect(containerNameFor("proj-1")).toBe("cairn-dispatch-proj-1");
    expect(containerNameFor("a/b c")).toBe("cairn-dispatch-a-b-c");
    expect(containerNameFor("")).toBe("cairn-dispatch-project");
  });
});

test("cleanup helper works without touching the real docker CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "cairn-docker-"));
  try {
    const { runner } = fakeRunner((argv) =>
      argv.includes("inspect") ? inspectMissing : undefined,
    );
    const { runtime: docker } = runtime(runner);
    expect(docker.ensureProject("proj-1", join(directory, "proj-1"))).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
