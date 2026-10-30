/**
 * Execution-environment probe behind `POST /settings/runtime/test`.
 *
 * The settings dialog lets an operator flip between local processes and Docker
 * containers, so "will this mode actually start a worker?" needs an answer before the
 * switch: local mode checks the Bun binary and a writable workspace, container mode
 * checks the daemon, the worker image and a one-off container start. Every check is
 * read-only apart from a temporary probe file and a `--rm` container.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DispatchConfig, ExecutionMode } from "../config";
import { resolveWorkspaceRoot } from "../scheduler/tasks";
import { bunCommandRunner, checkDocker, type CommandRunner } from "./docker";

export interface ExecutionProbeCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ExecutionProbeResult {
  execution: ExecutionMode;
  ok: boolean;
  checks: ExecutionProbeCheck[];
  error?: string;
}

export interface ExecutionProbeOptions {
  runner?: CommandRunner;
  dockerArgv?: readonly string[];
  /** Overrides the workspace root derived from the config (tests). */
  workspaceRoot?: string;
  /** Overrides the image derived from the config (tests). */
  image?: string;
}

const DEFAULT_IMAGE = "cairn-worker:latest";
const VERSION_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 60_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compact(text: string, limit = 300): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}...`;
}

/** Writes and removes a tiny file so the check matches what the worker needs. */
function probeWorkspace(root: string): ExecutionProbeCheck {
  const label = "工作区可写";
  const path = join(root, `.cairn-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path, "cairn", "utf8");
    rmSync(path, { force: true });
    return { id: "workspace", label, ok: true, detail: root };
  } catch (error) {
    return { id: "workspace", label, ok: false, detail: `${root}：${describe(error)}` };
  }
}

function probeLocal(
  options: ExecutionProbeOptions,
  workspaceRoot: string,
): ExecutionProbeCheck[] {
  const runner = options.runner ?? bunCommandRunner;
  const runtime = runner.run([process.execPath, "--version"], VERSION_TIMEOUT_MS);
  const checks: ExecutionProbeCheck[] = [
    {
      id: "runtime",
      label: "Bun 运行时",
      ok: runtime.code === 0,
      detail:
        runtime.code === 0
          ? `Bun ${compact(runtime.stdout)}`
          : compact(runtime.stderr) || `exited with code ${runtime.code}`,
    },
    probeWorkspace(workspaceRoot),
  ];
  return checks;
}

function probeContainer(
  options: ExecutionProbeOptions,
  config: DispatchConfig,
  workspaceRoot: string,
): ExecutionProbeCheck[] {
  const runner = options.runner ?? bunCommandRunner;
  const dockerArgv = [...(options.dockerArgv ?? [process.env["CAIRN_DOCKER"] ?? "docker"])];
  const image = options.image ?? config.container?.image ?? DEFAULT_IMAGE;
  const checks: ExecutionProbeCheck[] = [];

  const daemon = checkDocker(dockerArgv, runner);
  checks.push({
    id: "docker",
    label: "Docker 守护进程",
    ok: daemon.ok,
    detail: daemon.detail,
  });
  if (!daemon.ok) {
    return checks;
  }

  const inspect = runner.run(
    [...dockerArgv, "image", "inspect", image, "--format", "{{.Id}}"],
    INSPECT_TIMEOUT_MS,
  );
  checks.push({
    id: "image",
    label: `Worker 镜像 ${image}`,
    ok: inspect.code === 0,
    detail:
      inspect.code === 0
        ? compact(inspect.stdout)
        : compact(inspect.stderr) || `exited with code ${inspect.code}`,
  });
  if (inspect.code !== 0) {
    checks.push({
      id: "start",
      label: "容器可启动",
      ok: false,
      detail: `镜像不存在，先运行 docker build -f Dockerfile.worker -t ${image} .`,
    });
    return checks;
  }

  // `--network none` keeps the probe independent of the configured network while still
  // proving the daemon can create a container from this image and execute its runtime.
  const start = runner.run(
    [...dockerArgv, "run", "--rm", "--network", "none", image, "bun", "--version"],
    START_TIMEOUT_MS,
  );
  checks.push({
    id: "start",
    label: "容器可启动",
    ok: start.code === 0,
    detail:
      start.code === 0
        ? `Bun ${compact(start.stdout)}`
        : compact(start.stderr) || `exited with code ${start.code}`,
  });

  checks.push(probeWorkspace(workspaceRoot));
  return checks;
}

export function probeExecutionMode(
  execution: ExecutionMode,
  config: DispatchConfig,
  options: ExecutionProbeOptions = {},
): ExecutionProbeResult {
  const workspaceRoot = options.workspaceRoot ?? resolveWorkspaceRoot(config);
  try {
    const checks =
      execution === "container"
        ? probeContainer(options, config, workspaceRoot)
        : probeLocal(options, workspaceRoot);
    return {
      execution,
      ok: checks.every((check) => check.ok),
      checks,
    };
  } catch (error) {
    return { execution, ok: false, checks: [], error: describe(error) };
  }
}
