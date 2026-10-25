/**
 * M3 container end-to-end gate.
 *
 * Unlike `m3-gate.ts`, this runs a real project through the scheduler with
 * `runtime.execution: container` and the deterministic fake solver. It proves that the
 * control plane can create a per-project container, run a worker through `docker exec`,
 * receive the result over the bind mount, apply it to the graph, and remove the container.
 * It does not call a model and does not need credentials.
 *
 *   docker build -f Dockerfile.worker -t cairn-worker:latest .
 *   bun run tools/gate/m3-container-e2e.ts
 *
 * Override the image with CAIRN_GATE_DOCKER_IMAGE. Set CAIRN_GATE_KEEP=1 to keep the
 * temporary workspace for inspection.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { checkDocker, containerNameFor } from "../../apps/cairn/src/runtime/docker";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";

const image = process.env["CAIRN_GATE_DOCKER_IMAGE"]?.trim() || "cairn-worker:latest";
const directory = mkdtempSync(join(tmpdir(), "cairn-m3-container-"));
const workspaceRoot = join(directory, "workspace");
const agentConfigDir = join(directory, "agent-config");
const logs: string[] = [];

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  console.error("--- scheduler log ---");
  console.error(logs.join("\n"));
  throw new Error(message);
}

async function main(): Promise<number> {
  const docker = checkDocker();
  if (!docker.ok) {
    fail(`Docker is required for this gate: ${docker.detail}`);
  }
  console.log(`docker server ${docker.detail}, image ${image}`);

  mkdirSync(agentConfigDir, { recursive: true });
  const db = configureDatabase(join(directory, "cairn.db"));
  const config = parseDispatchConfig({
    server: "http://127.0.0.1:8000",
    runtime: {
      execution: "container",
      max_workers: 1,
      max_running_projects: 1,
      max_project_workers: 1,
      interval: 1,
      healthcheck_timeout: 15,
      worker_healthcheck: "disabled",
      prompt_group: "default",
    },
    tasks: {
      bootstrap: { timeout: 60, conclude_timeout: 20 },
      reason: { timeout: 60, max_intents: 3 },
      explore: { timeout: 60, conclude_timeout: 20 },
    },
    worker: {
      soft_deadline_ratio: 0.8,
      retain_task_files: true,
      result_grace_seconds: 15,
    },
    container: {
      image,
      network_mode: "none",
      completed_action: "remove",
      cap_add: [],
      worker_argv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
    },
    common_env: { CAIRN_AGENT_CONFIG_DIR: agentConfigDir },
  });

  const project = db.withConn((conn) =>
    createProject(conn, {
      title: "m3-container-e2e",
      origin: "start",
      goal: "finish",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
  const projectId = project.project.id;
  const containerName = containerNameFor(projectId);

  const loop = new Scheduler({
    db,
    config,
    workspaceRoot,
    log: (message) => logs.push(message),
    leaseIntervalMs: 500,
  });

  try {
    await loop.runUntilIdle();
  } finally {
    await loop.stop();
  }

  const detail = db.withConn((conn) => getProjectDetail(conn, projectId));
  if (detail.project.status !== "completed") {
    fail(`project ${projectId} is ${detail.project.status}, expected completed`);
  }
  const facts = detail.facts.filter(
    (fact) => fact.id !== "origin" && fact.id !== "goal",
  );
  if (facts.length !== 2) {
    fail(`expected 2 dynamic facts from two worker tasks, got ${facts.length}`);
  }
  if (!facts.every((fact) => fact.description.startsWith("fake fact"))) {
    fail("unexpected fake-solver fact content");
  }
  console.log("PASS  scheduler completed a project through the container runtime");
  console.log("PASS  two tasks produced results over the bind mount");

  const inspected = Bun.spawnSync(["docker", "inspect", containerName], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (inspected.exitCode === 0) {
    fail(`container ${containerName} still exists after project completion`);
  }
  console.log("PASS  per-project container removed after completion");

  const removedLog = logs.some(
    (line) => line.includes("container removed") && line.includes(projectId),
  );
  if (!removedLog) {
    fail("runtime did not log container removal");
  }
  console.log("PASS  removal is recorded in the runtime log");

  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith("FAIL")) {
    console.error(error);
    console.error("--- scheduler log ---");
    console.error(logs.join("\n"));
  }
  exitCode = 1;
} finally {
  if (process.env["CAIRN_GATE_KEEP"] === "1" || exitCode !== 0) {
    console.log(`kept the gate directory for inspection: ${directory}`);
  } else {
    rmSync(directory, { recursive: true, force: true });
  }
}
process.exit(exitCode);
