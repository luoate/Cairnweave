/**
 * M9 real-container audit-stream gate.
 *
 * Deterministic and model-free: a Host Bridge probe runs inside a real per-project
 * container, streams allow/block events to a real control-plane API over
 * `host.docker.internal`, and the gate verifies the chain, retry idempotency, token
 * revocation and the secure token transport added in M9.1.
 *
 *   docker build -f Dockerfile.worker -t cairn-worker:latest .
 *   bun run tools/gate/m9-audit-stream-gate.ts
 *
 * Set CAIRN_GATE_KEEP=1 to keep the temporary directory for inspection.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getAuditStreamLoss,
  getTaskAudit,
  run,
} from "@cairn/graph";

import { AUDIT_STREAM_LOST_FILE } from "../../apps/cairn/src/audit-stream/constants";
import { AuditTokenRegistry } from "../../apps/cairn/src/audit-stream/tokens";
import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { createApi } from "../../apps/cairn/src/http/api";
import {
  bunCommandRunner,
  checkDocker,
  containerNameFor,
  DockerRuntime,
} from "../../apps/cairn/src/runtime/docker";

const image = process.env["CAIRN_GATE_DOCKER_IMAGE"]?.trim() || "cairn-worker:latest";
const dockerArgv = [process.env["CAIRN_DOCKER"]?.trim() || "docker"];
const directory = mkdtempSync(join(tmpdir(), "cairn-m9-audit-stream-"));
const workspaceRoot = join(directory, "workspace");
const agentConfigDir = join(directory, "agent-config");
const taskId = `explore-${randomBytes(6).toString("hex")}`;
const marker = `CAIRN-M9-${randomBytes(4).toString("hex")}`;

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const logs: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function docker(args: readonly string[], timeoutMs = 120_000) {
  return bunCommandRunner.run([...dockerArgv, ...args], timeoutMs);
}

interface ProbeOutput {
  allow?: unknown;
  block?: { block?: boolean; reason?: string } | null;
}

async function main(): Promise<number> {
  const dockerStatus = checkDocker(dockerArgv, bunCommandRunner);
  if (!dockerStatus.ok) {
    check("Docker availability", false, dockerStatus.detail);
    return 1;
  }
  check("Docker availability", true, `server ${dockerStatus.detail}`);

  const imageStatus = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  if (imageStatus.code !== 0) {
    check("worker image is present", false, `image ${image} is missing`);
    return 1;
  }
  check("worker image is present", true, `${image} ${imageStatus.stdout.trim().slice(0, 19)}`);

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(agentConfigDir, { recursive: true });
  writeFileSync(join(workspaceRoot, "evidence.txt"), `${marker}\n`, "utf8");
  const sessionDir = join(workspaceRoot, ".cairn", "sessions", taskId);
  mkdirSync(sessionDir, { recursive: true });

  const db = configureDatabase(join(directory, "cairn.db"));
  const tokens = new AuditTokenRegistry();
  const api = createApi({ db, auditTokens: tokens });
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch: (request) => api.handle(request),
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    check("control-plane API bound", false);
    return 1;
  }
  check("control-plane API bound", true, `0.0.0.0:${port}`);

  let runtime: DockerRuntime | null = null;
  let projectId = "";
  try {
    // Container names are global on the Docker host. Seed the counter so this gate never
    // reuses (or cleans up) a real deployment's `proj_001` container.
    const seed = 100_000 + (randomBytes(3).readUIntBE(0, 3) % 800_000);
    db.withConn((conn) =>
      run(conn, "UPDATE counters SET value = ? WHERE name = 'project'", seed),
    );
    const project = db.withConn((conn) =>
      createProject(conn, {
        title: "m9-audit-stream-gate",
        origin: "authorized local gate",
        goal: "probe the Host Bridge audit stream",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["host.docker.internal:1"] },
      }),
    );
    projectId = project.project.id;
    const token = tokens.register(projectId, taskId);

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
        bootstrap: { timeout: 60, conclude_timeout: 30 },
        reason: { timeout: 60, max_intents: 1 },
        explore: { timeout: 60, conclude_timeout: 30 },
      },
      worker: {
        soft_deadline_ratio: 0.9,
        retain_task_files: true,
        result_grace_seconds: 5,
      },
      container: {
        image,
        network_mode: "bridge",
        completed_action: "remove",
        cap_add: [],
        worker_argv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
      },
    });

    const policy = JSON.stringify({
      projectId,
      taskId,
      workspace: "/cairn/workspace",
      sessionDir: `/cairn/workspace/.cairn/sessions/${taskId}`,
      targets: ["host.docker.internal:1"],
    });
    const script =
      "const m = await import(process.env.CAIRN_HOST_BRIDGE_MODULE);" +
      "const ext = m.createHostBridgeExtensionFromEnv();" +
      "let handler;" +
      'ext({ on: (event, h) => { if (event === "tool_call") handler = h; } });' +
      'if (typeof handler !== "function") throw new Error("no tool_call handler");' +
      'const allow = await handler({ toolName: "read", input: { path: "/cairn/workspace/evidence.txt" } });' +
      'const block = await handler({ toolName: "read", input: { path: "/etc/hostname" } });' +
      "await m.flushHostBridgeAudit();" +
      "console.log(JSON.stringify({ allow: allow ?? null, block: block ?? null }));";

    runtime = new DockerRuntime({
      container: config.container!,
      agentConfigDir,
      log: (message) => logs.push(message),
      workerArgv: () => ["bun", "-e", script],
    });
    const created = runtime.ensureProject(projectId, workspaceRoot);
    check("per-project container created", created, containerNameFor(projectId));
    if (!created) return 1;

    const process = runtime.spawnWorker({
      taskId,
      projectId,
      workerTaskPath: `/cairn/workspace/.cairn/sessions/${taskId}/task.json`,
      workerWorkspace: "/cairn/workspace",
      hostWorkspace: workspaceRoot,
      baseEnv: {},
      controllerEnv: {},
      extraEnv: {
        CAIRN_SCOPE_POLICY: policy,
        CAIRN_HOST_BRIDGE_MODULE:
          "/app/apps/cairn/src/host-bridge/worker-extension.ts",
        CAIRN_AUDIT_STREAM_URL: `http://host.docker.internal:${port}`,
        CAIRN_AUDIT_STREAM_TOKEN: token,
      },
      hardDeadlineSeconds: 60,
    });
    const stdoutPromise = new Response(process.stdout).text();
    const stderrPromise = new Response(process.stderr).text();
    const exitCode = await process.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    let probe: ProbeOutput | null = null;
    try {
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      probe = JSON.parse(line) as ProbeOutput;
    } catch {
      // Reported below.
    }
    check(
      "in-container Host Bridge allowed the workspace read",
      exitCode === 0 && probe !== null && probe.allow === null,
      exitCode === 0 ? stdout.trim() : preview(stderr),
    );
    check(
      "in-container Host Bridge blocked the out-of-scope read",
      probe !== null &&
        probe.block?.block === true &&
        typeof probe.block.reason === "string",
      probe?.block?.reason ?? preview(stderr),
    );
    check(
      "audit token does not appear in worker output",
      !`${stdout}\n${stderr}`.includes(token),
    );

    let audit = db.withConn((conn) => getTaskAudit(conn, projectId, taskId));
    for (let attempt = 0; attempt < 50 && audit.event_count < 2; attempt += 1) {
      await Bun.sleep(100);
      audit = db.withConn((conn) => getTaskAudit(conn, projectId, taskId));
    }
    check(
      "live events reached the control-plane ledger",
      audit.event_count === 2 && audit.chain_ok,
      `events=${audit.event_count} chain_ok=${audit.chain_ok}`,
    );
    check(
      "ledger sequence is dense and in order",
      audit.events.map((row) => row.seq).join(",") === "1,2",
      audit.events.map((row) => row.seq).join(","),
    );
    check(
      "ledger decisions match the probe",
      audit.events.map((row) => (row.event as { decision?: string }).decision).join(",") ===
        "allow,block",
    );

    const auditPath = join(sessionDir, "audit.jsonl");
    const localEntries = existsSync(auditPath)
      ? readFileSync(auditPath, "utf8")
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    check(
      "worker kept the local audit file",
      localEntries.length === 2 &&
        localEntries.map((entry) => entry["decision"]).join(",") === "allow,block",
      `${localEntries.length} line(s)`,
    );
    check(
      "the live sender wrote no loss marker",
      !existsSync(join(sessionDir, AUDIT_STREAM_LOST_FILE)),
    );
    check(
      "no stream-loss row was recorded",
      db.withConn((conn) => getAuditStreamLoss(conn, projectId, taskId)) === null,
    );

    const retry = await fetch(
      `http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}` +
        `/tasks/${encodeURIComponent(taskId)}/audit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          events: localEntries.map((event, index) => ({ seq: index + 1, event })),
        }),
      },
    );
    const retryBody = (await retry.json()) as {
      recorded?: number;
      duplicates?: number;
    };
    check(
      "replaying the local file is idempotent",
      retry.status === 200 &&
        retryBody.recorded === 0 &&
        retryBody.duplicates === localEntries.length,
      `status=${retry.status} recorded=${retryBody.recorded} duplicates=${retryBody.duplicates}`,
    );

    tokens.revoke(projectId, taskId);
    const revoked = await fetch(
      `http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}` +
        `/tasks/${encodeURIComponent(taskId)}/audit`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events: [{ seq: 3, event: { decision: "allow" } }] }),
      },
    );
    check("revoked token is rejected", revoked.status === 401, `status=${revoked.status}`);

    return checks.every((entry) => entry.ok) ? 0 : 1;
  } finally {
    server.stop(true);
    if (runtime !== null) {
      try {
        runtime.cleanupInactive(new Set());
        runtime.close();
      } catch {
        // Best effort.
      }
    }
    if (projectId !== "") {
      docker(["rm", "-f", containerNameFor(projectId)], 30_000);
    }
  }
}

function preview(text: string, limit = 500): string {
  const compact = text.split(/\s+/).filter(Boolean).join(" ");
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  const failed = checks.filter((entry) => !entry.ok);
  console.log("\n=== M9 real-container audit-stream gate ===");
  console.log(`${checks.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error("--- scheduler/docker log ---");
    console.error(logs.join("\n"));
  }
  console.log(`directory: ${directory}`);
  if (process.env["CAIRN_GATE_KEEP"] === "1" || exitCode !== 0) {
    console.log("kept the gate directory for inspection");
  } else {
    rmSync(directory, { recursive: true, force: true });
  }
}
process.exit(exitCode);
