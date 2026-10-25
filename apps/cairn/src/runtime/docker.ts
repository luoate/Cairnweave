/**
 * Per-project Docker runtime.
 *
 * One long-lived container per project (`sleep infinity`) owns the project workspace via
 * a bind mount. Each task is a separate `docker exec`, so a crashed solver cannot take
 * the control plane or another project down, and killing a task is a container signal.
 *
 * Security notes:
 * - the Docker socket is never mounted into the worker container;
 * - the agent config directory is mounted read-only;
 * - container processes get only `common_env` plus the explicit CAIRN_* variables below,
 *   never the control plane's whole environment.
 */

import { existsSync, mkdirSync } from "node:fs";

import type { ContainerConfig } from "../config";
import { CONTAINER_AGENT_CONFIG, CONTAINER_WORKSPACE, containerPathFor } from "./paths";
import {
  describeError,
  type RuntimeBackend,
  type WorkerProcess,
  type WorkerSpawnOptions,
} from "./types";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(argv: readonly string[], timeoutMs?: number): CommandResult;
}

export const bunCommandRunner: CommandRunner = {
  run(argv, timeoutMs = 120_000): CommandResult {
    try {
      const result = Bun.spawnSync({
        cmd: [...argv],
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs,
      });
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } catch (error) {
      return { code: 127, stdout: "", stderr: describeError(error) };
    }
  },
};

export interface DockerChild {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: string): void;
}

export type DockerSpawn = (
  argv: readonly string[],
  options: { stdout: "pipe"; stderr: "pipe" },
) => DockerChild;

const defaultSpawn: DockerSpawn = (argv, options) => {
  const child = Bun.spawn([...argv], options);
  return {
    exited: child.exited,
    stdout: child.stdout as ReadableStream<Uint8Array>,
    stderr: child.stderr as ReadableStream<Uint8Array>,
    kill: (signal) => child.kill(signal as never),
  };
};

export interface DockerRuntimeOptions {
  container: ContainerConfig;
  /** Host directory mounted read-only at /cairn/agent-config. */
  agentConfigDir: string;
  log: (message: string) => void;
  /** Test hook; defaults to `docker` on PATH. */
  dockerArgv?: string[];
  /** Test hook for the docker CLI itself. */
  runner?: CommandRunner;
  /** Test hook for `docker exec` child processes. */
  spawn?: DockerSpawn;
  /** Overrides container.workerArgv (tests). */
  workerArgv?: (workerTaskPath: string) => string[];
}

type ContainerState = "running" | "stopped" | "missing" | "error";

export class DockerRuntime implements RuntimeBackend {
  readonly execution = "container" as const;
  private readonly container: ContainerConfig;
  private readonly agentConfigDir: string;
  private readonly log: (message: string) => void;
  private readonly dockerArgv: string[];
  private readonly runner: CommandRunner;
  private readonly spawn: DockerSpawn;
  private readonly workerArgv: (workerTaskPath: string) => string[];
  /** projectId -> { hostWorkspace, containerName } for projects we ensured. */
  private readonly projects = new Map<
    string,
    { hostWorkspace: string; containerName: string }
  >();

  constructor(options: DockerRuntimeOptions) {
    this.container = options.container;
    this.agentConfigDir = options.agentConfigDir;
    this.log = options.log;
    this.dockerArgv = options.dockerArgv ?? [process.env["CAIRN_DOCKER"] ?? "docker"];
    this.runner = options.runner ?? bunCommandRunner;
    this.spawn = options.spawn ?? defaultSpawn;
    this.workerArgv =
      options.workerArgv ??
      ((taskPath) => [...this.container.workerArgv, taskPath]);
  }

  ensureProject(projectId: string, hostWorkspace: string): boolean {
    const containerName = containerNameFor(projectId);
    try {
      mkdirSync(hostWorkspace, { recursive: true });
      if (!existsSync(this.agentConfigDir)) {
        this.log(
          `agent config dir ${this.agentConfigDir} does not exist; the container will start without usable model configuration`,
        );
      }
      mkdirSync(this.agentConfigDir, { recursive: true });
    } catch (error) {
      this.log(`container workspace setup failed project=${projectId}: ${describeError(error)}`);
      return false;
    }

    this.projects.set(projectId, { hostWorkspace, containerName });

    const inspected = this.inspect(containerName);
    if (inspected === "running") return true;
    if (inspected === "stopped") {
      const started = this.docker(["start", containerName]);
      if (started.code !== 0) {
        this.log(
          `container start failed project=${projectId} name=${containerName}: ${preview(started.stderr)}`,
        );
        return false;
      }
      return true;
    }
    if (inspected === "error") return false;

    const args = [
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      `cairn.project=${projectId}`,
      "--label",
      "cairn.managed=1",
      "--network",
      this.container.networkMode,
      ...this.container.capAdd.flatMap((capability) => ["--cap-add", capability]),
      // `--mount` avoids the host-path/colon ambiguity of `-v` on Windows.
      "--mount",
      `type=bind,source=${hostWorkspace},target=${CONTAINER_WORKSPACE}`,
      "--mount",
      `type=bind,source=${this.agentConfigDir},target=${CONTAINER_AGENT_CONFIG},readonly`,
      "-w",
      CONTAINER_WORKSPACE,
      "-e",
      `CAIRN_AGENT_CONFIG_DIR=${CONTAINER_AGENT_CONFIG}`,
      "-e",
      "CAIRN_AGENT_CONFIG_READONLY=1",
      this.container.image,
      "sleep",
      "infinity",
    ];
    const created = this.docker(args);
    if (created.code !== 0) {
      this.log(
        `container start failed project=${projectId} image=${this.container.image}: ${preview(created.stderr)}`,
      );
      return false;
    }
    return true;
  }

  mapPath(hostPath: string): string {
    const mapped = this.mapPathIfUnderWorkspace(hostPath);
    if (mapped === null) {
      throw new Error(`path is outside every project workspace: ${hostPath}`);
    }
    return mapped;
  }

  mapPathIfUnderWorkspace(hostPath: string): string | null {
    for (const { hostWorkspace } of this.projects.values()) {
      const mapped = containerPathFor(hostWorkspace, hostPath);
      if (mapped !== null) return mapped;
    }
    return null;
  }

  spawnWorker(options: WorkerSpawnOptions): WorkerProcess {
    const project = this.projects.get(options.projectId);
    if (project === undefined) {
      throw new Error(`container is not prepared for project ${options.projectId}`);
    }

    const workerEnv: Record<string, string> = {
      ...options.baseEnv,
      ...options.extraEnv,
    };
    // Honor a control-plane-level solver selection unless common_env overrides it.
    const solver = options.controllerEnv["CAIRN_SOLVER"];
    if (solver !== undefined && workerEnv["CAIRN_SOLVER"] === undefined) {
      workerEnv["CAIRN_SOLVER"] = solver;
    }
    workerEnv["CAIRN_AGENT_CONFIG_DIR"] = CONTAINER_AGENT_CONFIG;
    workerEnv["CAIRN_AGENT_CONFIG_READONLY"] = "1";

    const args = [
      ...this.dockerArgv,
      "exec",
      "-i",
      "-w",
      CONTAINER_WORKSPACE,
    ];
    for (const [key, value] of Object.entries(workerEnv)) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(project.containerName, ...this.workerArgv(options.workerTaskPath));

    const child = this.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const containerName = project.containerName;
    const taskPath = options.workerTaskPath;
    return {
      exited: child.exited,
      stdout: child.stdout,
      stderr: child.stderr,
      // Killing the `docker exec` client does not reach the process inside the
      // container, and killing the container would kill every task of the project.
      // Match the task path instead; it is unique per task and present in the argv.
      terminate: () => {
        this.signalTask(containerName, taskPath, "SIGTERM");
        try {
          child.kill("SIGTERM");
        } catch {
          // The client may already have exited.
        }
      },
      kill: () => {
        this.signalTask(containerName, taskPath, "SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      },
    };
  }

  cleanupInactive(activeProjectIds: ReadonlySet<string>): void {
    for (const projectId of [...this.projects.keys()]) {
      if (activeProjectIds.has(projectId)) continue;
      this.cleanupProject(projectId);
    }
  }

  close(): void {
    for (const projectId of [...this.projects.keys()]) {
      const project = this.projects.get(projectId);
      if (project === undefined) continue;
      const result = this.docker(["stop", project.containerName], 60_000);
      if (result.code !== 0) {
        this.log(
          `container stop on shutdown failed project=${projectId}: ${preview(result.stderr)}`,
        );
      }
      this.projects.delete(projectId);
    }
  }

  private cleanupProject(projectId: string): void {
    const project = this.projects.get(projectId);
    if (project === undefined) return;
    this.projects.delete(projectId);

    const args =
      this.container.completedAction === "remove"
        ? ["rm", "-f", project.containerName]
        : ["stop", project.containerName];
    const result = this.docker(args, 60_000);
    if (result.code !== 0) {
      this.log(
        `container cleanup failed project=${projectId} action=${this.container.completedAction}: ${preview(result.stderr)}`,
      );
      return;
    }
    this.log(
      `container ${this.container.completedAction === "remove" ? "removed" : "stopped"} project=${projectId}`,
    );
  }

  /**
   * Signals one task process inside the container. The task path is unique and appears in
   * the worker argv, so this does not touch other tasks of the same project. Exit code 1
   * means "no match" (the task already exited) and 127 means the image lacks pkill; both
   * are non-fatal because the local `docker exec` client is killed as well.
   */
  private signalTask(
    containerName: string,
    taskPath: string,
    signal: "SIGTERM" | "SIGKILL",
  ): void {
    const result = this.docker(
      ["exec", containerName, "pkill", `-${signal}`, "-f", "--", taskPath],
      15_000,
    );
    if (result.code !== 0 && result.code !== 1 && result.code !== 127) {
      this.log(
        `task signal failed name=${containerName} signal=${signal}: ${preview(result.stderr)}`,
      );
    }
  }

  private inspect(containerName: string): ContainerState {
    const result = this.docker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerName,
    ]);
    if (result.code !== 0) {
      if (/no such (object|container)/i.test(result.stderr)) return "missing";
      this.log(
        `container inspect failed name=${containerName}: ${preview(result.stderr)}`,
      );
      return "error";
    }
    return result.stdout.trim() === "true" ? "running" : "stopped";
  }

  private docker(args: readonly string[], timeoutMs?: number): CommandResult {
    return this.runner.run([...this.dockerArgv, ...args], timeoutMs);
  }
}

export function containerNameFor(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64);
  return `cairn-dispatch-${safe === "" ? "project" : safe}`;
}

/** Startup check used by `cairn serve --config` in container mode. */
export function checkDocker(
  dockerArgv: readonly string[] = [process.env["CAIRN_DOCKER"] ?? "docker"],
  runner: CommandRunner = bunCommandRunner,
): { ok: boolean; detail: string } {
  const result = runner.run(
    [...dockerArgv, "version", "--format", "{{.Server.Version}}"],
    20_000,
  );
  if (result.code !== 0) {
    return {
      ok: false,
      detail: preview(result.stderr) || `docker exited with code ${result.code}`,
    };
  }
  return { ok: true, detail: result.stdout.trim() };
}

function preview(text: string, limit = 500): string {
  const compact = text.split(/\s+/).filter(Boolean).join(" ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}
