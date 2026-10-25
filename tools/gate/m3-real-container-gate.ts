/**
 * M3 real-container gate: a real BreachWeave solver runs inside the per-project container,
 * reaches an authorized lab target on the host, and produces an audited Fact.
 *
 * This gate is intentionally outside `bun test`: it calls a real model and costs money.
 * It needs Docker, an image built from `Dockerfile.worker`, and credentials under
 * `~/.tch-agent/config` (override with CAIRN_AGENT_CONFIG_DIR).
 *
 *   docker build -f Dockerfile.worker -t cairn-worker:latest .
 *   bun run tools/gate/m3-real-container-gate.ts
 *
 * What it proves:
 * - the control plane creates a per-project container and runs the real solver in it;
 * - the solver reaches `host.docker.internal` through the container network;
 * - the Host Bridge allows the authorized target and audits the call;
 * - a deterministic in-container probe is blocked for an out-of-scope target and audited;
 * - the container is removed when the project completes.
 *
 * Egress note: this host's model gateway is only reachable from the host, so the gate
 * starts a temporary CONNECT proxy on 0.0.0.0 and injects HTTPS_PROXY through
 * `common_env`. That is a test harness, not a production design: a deployment should use a
 * controlled egress proxy with its own allowlist. HTTP lab traffic is not proxied.
 *
 * Optional preflight (recommended, avoids a wasted model run):
 *
 *   CAIRN_GATE_PROXY_PROBE_URL=https://<model-gateway>/v1/models \
 *     bun run tools/gate/m3-real-container-gate.ts
 *
 * A 401/403 from the gateway is a pass: it proves TLS egress reached the gateway.
 * Set CAIRN_GATE_KEEP=1 to keep the temporary directory for inspection.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig } from "../../apps/cairn/src/config";
import {
  bunCommandRunner,
  checkDocker,
  containerNameFor,
  DockerRuntime,
} from "../../apps/cairn/src/runtime/docker";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";

const MARKER = `CAIRN-M3-REAL-CONTAINER-${randomBytes(4).toString("hex")}`;
const TIMEOUT_SECONDS = 300;
const image = process.env["CAIRN_GATE_DOCKER_IMAGE"]?.trim() || "cairn-worker:latest";
const dockerArgv = [process.env["CAIRN_DOCKER"]?.trim() || "docker"];
const directory = mkdtempSync(join(tmpdir(), "cairn-m3-real-container-"));
const workspaceRoot = join(directory, "workspace");
const agentConfigDir =
  process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim() || join(homedir(), ".tch-agent", "config");

const checks: Array<{ name: string; status: "pass" | "fail"; detail: string }> = [];
const logs: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, status: ok ? "pass" : "fail", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function docker(args: readonly string[], timeoutMs = 120_000) {
  return bunCommandRunner.run([...dockerArgv, ...args], timeoutMs);
}

/**
 * Async docker call used while the gate's own Bun.serve lab endpoints are up.
 * `bunCommandRunner` is synchronous and would block the event loop, so the container's
 * fetch would never be answered and would time out.
 */
async function dockerAsync(
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([...dockerArgv, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { code: timedOut ? null : code, stdout, stderr };
}

interface ProxyHandle {
  port: number;
  close(): void;
}

interface ProbeResult {
  allow?: unknown;
  block?: { block?: boolean; reason?: string } | null;
}

/** Bun's `node:net` server types omit the event-emitter surface we need here. */
interface NetServerLike {
  on(event: "error", listener: (error: Error) => void): void;
  listen(port: number, host: string, callback: () => void): void;
  address(): { port: number } | string | null;
  close(): void;
}

/**
 * Minimal HTTP CONNECT proxy bound to all interfaces so the container can reach it via
 * `host.docker.internal`. HTTPS only: the gate does not set HTTP_PROXY, so plain HTTP lab
 * traffic goes directly to the lab server and the model gateway uses this tunnel.
 */
function startConnectProxy(): Promise<ProxyHandle> {
  const server = createNetServer((client) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > 16 * 1024) client.destroy();
        return;
      }
      client.off("data", onData);
      const header = buffered.subarray(0, end).toString("latin1");
      const match = /^CONNECT ([^ ]+):(\d+) HTTP\/1\.[01]$/m.exec(header);
      if (match === null) {
        client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return;
      }
      const upstream = netConnect({ host: match[1]!, port: Number(match[2]) }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = buffered.subarray(end + 4);
        if (rest.length > 0) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => client.destroy());
  });

  const listener = server as unknown as NetServerLike;
  return new Promise((resolve, reject) => {
    listener.on("error", reject);
    listener.listen(0, "0.0.0.0", () => {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        listener.close();
        reject(new Error("CONNECT proxy did not bind a TCP port"));
        return;
      }
      resolve({ port: address.port, close: () => listener.close() });
    });
  });
}

function startLab(body: string): { port: number; stop(): void } {
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch() {
      return new Response(`${body}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("lab server did not bind a TCP port");
  }
  return { port, stop: () => server.stop(true) };
}

/** Runs a one-off container command. The image must already exist. */
function oneOff(script: string, env: Record<string, string> = {}, proxyPort?: number) {
  const args = [
    "run",
    "--rm",
    "--add-host",
    "host.docker.internal:host-gateway",
  ];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  if (proxyPort !== undefined) {
    args.push("-e", `HTTPS_PROXY=http://host.docker.internal:${proxyPort}`);
    args.push("-e", `https_proxy=http://host.docker.internal:${proxyPort}`);
  }
  args.push(image, "bun", "-e", script);
  return dockerAsync(args, 120_000);
}

async function main(): Promise<number> {
  const dockerStatus = checkDocker();
  if (!dockerStatus.ok) {
    check("Docker availability", false, dockerStatus.detail);
    return 1;
  }
  check("Docker availability", true, `server ${dockerStatus.detail}`);

  const imageStatus = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  if (imageStatus.code !== 0) {
    check(
      "worker image is present",
      false,
      `image ${image} is missing; run: docker build -f Dockerfile.worker -t ${image} .`,
    );
    return 1;
  }
  check("worker image is present", true, `${image} ${imageStatus.stdout.trim().slice(0, 19)}`);

  const modelsPath = join(agentConfigDir, "models.json");
  const authPath = join(agentConfigDir, "auth.json");
  const configPresent = existsSync(modelsPath) && existsSync(authPath);
  check(
    "model credentials are configured",
    configPresent,
    configPresent
      ? `${agentConfigDir} (mounted read-only, not printed)`
      : `${agentConfigDir} is missing models.json or auth.json`,
  );
  if (!configPresent) return 1;

  const inScope = startLab(MARKER);
  const outOfScope = startLab(`${MARKER}-OUT-OF-SCOPE`);
  let proxy: ProxyHandle | null = null;
  let runtime: DockerRuntime | null = null;
  let database: ReturnType<typeof configureDatabase> | null = null;
  let projectId = "";

  try {
    proxy = await startConnectProxy();
    console.log(
      `lab in-scope :${inScope.port}, out-of-scope :${outOfScope.port}, CONNECT proxy :${proxy.port}`,
    );

    // Preflight 1: the container can reach the host lab server directly (plain HTTP).
    const labProbe = await oneOff(
      "const r = await fetch(process.env.CAIRN_GATE_PROBE_URL, { signal: AbortSignal.timeout(30000) }); process.stdout.write(await r.text());",
      { CAIRN_GATE_PROBE_URL: `http://host.docker.internal:${inScope.port}/` },
    );
    check(
      "container reaches the authorized host target",
      labProbe.code === 0 && labProbe.stdout.includes(MARKER),
      labProbe.code === 0
        ? "lab marker received"
        : `docker exit ${labProbe.code}: ${preview(labProbe.stderr)}`,
    );
    if (labProbe.code !== 0 || !labProbe.stdout.includes(MARKER)) {
      console.error("--- preflight stderr ---");
      console.error(preview(labProbe.stderr, 2000));
      return 1;
    }

    // Preflight 2 (optional): TLS egress through the proxy to the model gateway.
    const proxyProbeUrl = process.env["CAIRN_GATE_PROXY_PROBE_URL"]?.trim();
    if (proxyProbeUrl !== undefined && proxyProbeUrl !== "") {
      const proxyProbe = await oneOff(
        "try { const r = await fetch(process.env.CAIRN_GATE_PROBE_URL, { signal: AbortSignal.timeout(30000) }); console.log(`status=${r.status}`); } catch (e) { console.log(`error=${e instanceof Error ? e.message : String(e)}`); }",
        { CAIRN_GATE_PROBE_URL: proxyProbeUrl },
        proxy.port,
      );
      const reached = proxyProbe.code === 0 && /status=\d{3}/.test(proxyProbe.stdout);
      check(
        "container reaches the model gateway through the proxy",
        reached,
        reached ? proxyProbe.stdout.trim() : preview(proxyProbe.stderr || proxyProbe.stdout),
      );
      if (!reached) return 1;
    }

    database = configureDatabase(join(directory, "cairn.db"));
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
        bootstrap: { timeout: TIMEOUT_SECONDS, conclude_timeout: 120 },
        reason: { timeout: TIMEOUT_SECONDS, max_intents: 1 },
        explore: { timeout: TIMEOUT_SECONDS, conclude_timeout: 120 },
      },
      worker: {
        soft_deadline_ratio: 0.9,
        retain_task_files: true,
        result_grace_seconds: 10,
      },
      container: {
        image,
        network_mode: "bridge",
        completed_action: "remove",
        cap_add: [],
        worker_argv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
      },
      common_env: {
        CAIRN_AGENT_CONFIG_DIR: agentConfigDir,
        HTTPS_PROXY: `http://host.docker.internal:${proxy.port}`,
        https_proxy: `http://host.docker.internal:${proxy.port}`,
      },
    });

    const project = database.withConn((conn) =>
      createProject(conn, {
        title: "m3-real-container-gate",
        origin:
          "Authorized lab. The worker runs inside a per-project container with a read-only agent config mount. " +
          "The host exposes one lab HTTP endpoint for this test.",
        goal:
          "Use the bash tool to run exactly this command and read its output:\n\n" +
          `bun -e 'const r = await fetch("http://host.docker.internal:${inScope.port}/"); console.log(await r.text());'\n\n` +
          "The response body is a marker. Put the exact marker in fact.description. " +
          "Do not contact any other host or port. Then return the required JSON.",
        hints: null,
        bootstrap_enabled: true,
        scope: {
          targets: [`host.docker.internal:${inScope.port}`],
          notes: "Single authorized lab endpoint created by the M3 real-container gate.",
        },
      }),
    );
    projectId = project.project.id;

    process.env["CAIRN_SOLVER"] = "breachweave";
    const scheduler = new Scheduler({
      db: database,
      config,
      workspaceRoot,
      log: (message) => {
        logs.push(message);
        console.error(`[gate] ${message}`);
      },
    });

    try {
      await scheduler.runUntilIdle(600);
    } finally {
      await scheduler.stop();
    }

    const detail = database.withConn((conn) => getProjectDetail(conn, projectId));
    const facts = detail.facts.filter((fact) => fact.id !== "origin" && fact.id !== "goal");
    check("project completed", detail.project.status === "completed", detail.project.status);
    check(
      "solver produced a Fact containing the lab marker",
      facts.some((fact) => fact.description.includes(MARKER)),
      `${facts.length} dynamic fact(s)`,
    );

    const workspace = join(workspaceRoot, projectId);
    const audit = readAudit(workspace);
    check(
      "the model's authorized network action is audited as allow",
      audit.some(
        (entry) =>
          entry["project_id"] === projectId &&
          entry["decision"] === "allow" &&
          JSON.stringify(entry).includes(`:${inScope.port}`),
      ),
      `${audit.length} audit line(s)`,
    );

    const containerName = containerNameFor(projectId);
    const stillThere = docker(["inspect", "--format", "{{.State.Running}}", containerName]);
    check(
      "per-project container removed after completion",
      stillThere.code !== 0,
      stillThere.code !== 0 ? containerName : `still running: ${preview(stillThere.stdout)}`,
    );

    // Deterministic in-container gate check. The model is told not to touch anything else,
    // so the out-of-scope attempt is made by the same worker-extension module inside a
    // fresh container for the same project.
    runtime = new DockerRuntime({
      container: config.container!,
      agentConfigDir,
      log: (message) => console.error(`[gate:docker] ${message}`),
    });
    const created = runtime.ensureProject(projectId, workspace);
    check("container can be recreated for the negative probe", created);
    if (created) {
      const sessions = listSessionDirs(workspace);
      const sessionId = sessions[0];
      check(
        "the probe has a real session directory",
        sessionId !== undefined,
        sessionId ?? "none",
      );
      if (sessionId !== undefined) {
        const policy = JSON.stringify({
          projectId,
          taskId: sessionId,
          workspace: "/cairn/workspace",
          sessionDir: `/cairn/workspace/.cairn/sessions/${sessionId}`,
          targets: [`host.docker.internal:${inScope.port}`],
        });
        const script =
          "const m = await import(process.env.CAIRN_HOST_BRIDGE_MODULE);" +
          "const ext = m.createHostBridgeExtensionFromEnv();" +
          "let handler;" +
          'ext({ on: (event, h) => { if (event === "tool_call") handler = h; } });' +
          'if (typeof handler !== "function") throw new Error("no tool_call handler");' +
          'const allow = await handler({ toolName: "bash", input: { command: "curl -s http://host.docker.internal:' +
          inScope.port +
          '/" } });' +
          'const block = await handler({ toolName: "bash", input: { command: "curl -s http://host.docker.internal:' +
          outOfScope.port +
          '/" } });' +
          "console.log(JSON.stringify({ allow: allow ?? null, block: block ?? null }));";
        const probe = await dockerAsync(
          [
            "exec",
            "-w",
            "/cairn/workspace",
            "-e",
            `CAIRN_SCOPE_POLICY=${policy}`,
            "-e",
            "CAIRN_HOST_BRIDGE_MODULE=/app/apps/cairn/src/host-bridge/worker-extension.ts",
            containerName,
            "bun",
            "-e",
            script,
          ],
          60_000,
        );
        let result: ProbeResult | null = null;
        try {
          result = JSON.parse(probe.stdout.trim()) as ProbeResult;
        } catch {
          // Reported below.
        }
        check(
          "in-container Host Bridge allows the authorized action",
          probe.code === 0 && result !== null && result.allow === null,
          probe.code === 0 ? "allow decision" : preview(probe.stderr),
        );
        check(
          "in-container Host Bridge blocks the out-of-scope action",
          probe.code === 0 &&
            result !== null &&
            result.block?.block === true &&
            typeof result.block.reason === "string",
          result?.block?.reason ?? preview(probe.stderr),
        );
      }

      // Task-scoped termination under real procps. DockerRuntime signals by matching the
      // task path in argv; two detached sleepers with different paths prove the target is
      // killed, the sibling task survives, and the container itself is untouched.
      const targetPath = `/cairn/workspace/.cairn/sessions/${sessionId ?? "probe-a"}/task.json`;
      const siblingPath = `/cairn/workspace/.cairn/sessions/${sessionId ?? "probe-a"}-sibling/task.json`;
      const sleepScript = "await Bun.sleep(300000);";
      const spawnTarget = await dockerAsync(
        ["exec", "-d", containerName, "bun", "-e", sleepScript, targetPath],
        30_000,
      );
      const spawnSibling = await dockerAsync(
        ["exec", "-d", containerName, "bun", "-e", sleepScript, siblingPath],
        30_000,
      );
      if (spawnTarget.code === 0 && spawnSibling.code === 0) {
        const signal = await dockerAsync(
          ["exec", containerName, "pkill", "-SIGTERM", "-f", "--", targetPath],
          30_000,
        );
        await Bun.sleep(1000);
        const targetAlive = await dockerAsync(
          ["exec", containerName, "pgrep", "-f", "--", targetPath],
          15_000,
        );
        const siblingAlive = await dockerAsync(
          ["exec", containerName, "pgrep", "-f", "--", siblingPath],
          15_000,
        );
        const containerState = await dockerAsync(
          ["inspect", "--format", "{{.State.Running}}", containerName],
          15_000,
        );
        check(
          "task-scoped pkill terminates only the targeted task",
          signal.code === 0 &&
            targetAlive.code === 1 &&
            siblingAlive.code === 0 &&
            containerState.stdout.trim() === "true",
          `pkill=${signal.code} target=${targetAlive.code === 1 ? "gone" : "alive"} ` +
            `sibling=${siblingAlive.code === 0 ? "alive" : "gone"} ` +
            `container=${containerState.stdout.trim() || preview(containerState.stderr)}`,
        );
      } else {
        check(
          "task-scoped pkill terminates only the targeted task",
          false,
          preview(spawnTarget.stderr + spawnSibling.stderr),
        );
      }
    }

    const finalAudit = readAudit(workspace);
    check(
      "the out-of-scope action is audited as block",
      finalAudit.some(
        (entry) =>
          entry["project_id"] === projectId &&
          entry["decision"] === "block" &&
          JSON.stringify(entry).includes(`:${outOfScope.port}`),
      ),
      finalAudit.some((entry) => entry["decision"] === "block")
        ? "block line recorded"
        : "no block line",
    );
    check(
      "every audit line carries project and task identity",
      finalAudit.length > 0 &&
        finalAudit.every(
          (entry) =>
            entry["project_id"] === projectId &&
            typeof entry["task_id"] === "string" &&
            entry["task_id"] !== "",
        ),
    );

    if (runtime !== null) {
      runtime.cleanupInactive(new Set());
      runtime.close();
      runtime = null;
    }
    const goneAfterProbe = docker(["inspect", containerName]);
    check(
      "container removed after the negative probe",
      goneAfterProbe.code !== 0,
      goneAfterProbe.code !== 0 ? containerName : "still present",
    );

    return checks.every((entry) => entry.status === "pass") ? 0 : 1;
  } finally {
    inScope.stop();
    outOfScope.stop();
    proxy?.close();
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

function listSessionDirs(workspace: string): string[] {
  const sessionsRoot = join(workspace, ".cairn", "sessions");
  if (!existsSync(sessionsRoot)) return [];
  return readdirSync(sessionsRoot)
    .filter((name) => existsSync(join(sessionsRoot, name, "task.json")))
    .sort((left, right) => {
      const a = statSync(join(sessionsRoot, left)).mtimeMs;
      const b = statSync(join(sessionsRoot, right)).mtimeMs;
      return b - a;
    });
}

function readAudit(workspace: string): Array<Record<string, unknown>> {
  const sessionsRoot = join(workspace, ".cairn", "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const entries: Array<Record<string, unknown>> = [];
  for (const name of readdirSync(sessionsRoot)) {
    const path = join(sessionsRoot, name, "audit.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // A torn line from a killed worker; ignore it here.
      }
    }
  }
  return entries;
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
  const failed = checks.filter((entry) => entry.status === "fail");
  console.log("\n=== M3 real-container gate ===");
  console.log(
    `${checks.filter((entry) => entry.status === "pass").length} passed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.error("--- scheduler log ---");
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
