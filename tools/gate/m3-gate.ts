/**
 * M3 gate: action-level scope enforcement, auditability, artifacts and (optionally) the
 * container lifecycle.
 *
 * Unlike the M2c gate this does not call a model. It exercises the same Host Bridge the
 * solver uses, writes and reads real audit lines, indexes real artifacts through the graph
 * store and HTTP route, and reports whether Docker is available on this host. Without
 * Docker the container lifecycle is reported as SKIPPED, not passed: the fake-CLI unit
 * tests cover the command construction, but they are not a container integration run.
 *
 *   bun run tools/gate/m3-gate.ts
 *
 * Optional container smoke test (requires Docker and an image built from
 * `Dockerfile.worker`):
 *
 *   CAIRN_GATE_DOCKER_IMAGE=cairn-worker:latest bun run tools/gate/m3-gate.ts
 *
 * Set CAIRN_GATE_KEEP=1 to keep the temporary directory.
 */

import { createHash } from "node:crypto";
import {
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
  listProjectArtifacts,
  recordProjectArtifacts,
} from "@cairn/graph";

import { HostBridge } from "../../apps/cairn/src/host-bridge/bridge";
import { createApi } from "../../apps/cairn/src/http/api";
import { checkDocker, DockerRuntime } from "../../apps/cairn/src/runtime/docker";

const directory = mkdtempSync(join(tmpdir(), "cairn-m3-gate-"));
const workspace = join(directory, "workspace");
const sessionDir = join(workspace, ".cairn", "sessions", "gate-task");

const checks: Array<{ name: string; status: "pass" | "fail" | "skip"; detail: string }> =
  [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, status: ok ? "pass" : "fail", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function skip(name: string, detail: string): void {
  checks.push({ name, status: "skip", detail });
  console.log(`SKIP  ${name} - ${detail}`);
}

async function main(): Promise<number> {
  mkdirSync(join(workspace, "artifacts"), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "in-workspace", "utf8");
  writeFileSync(join(directory, "outside.txt"), "outside-workspace", "utf8");

  // --- Host Bridge -----------------------------------------------------------------
  const auditPath = join(sessionDir, "audit.jsonl");
  const bridge = new HostBridge({
    projectId: "gate-project",
    taskId: "gate-task",
    workspace,
    sessionDir,
    scopeTargets: [
      "127.0.0.1:8080",
      `file:///${join(directory, "evidence").replaceAll("\\", "/")}`,
    ],
    auditPath,
  });

  const allowedNetwork = bridge.checkToolCall("bash", {
    command: "curl -s http://127.0.0.1:8080/health",
  });
  check("in-scope network action is allowed", allowedNetwork.allowed);

  const deniedNetwork = bridge.checkToolCall("bash", {
    command: "curl -s http://192.0.2.10/",
  });
  check(
    "out-of-scope network action is blocked",
    !deniedNetwork.allowed,
    deniedNetwork.reason ?? "",
  );

  const deniedFile = bridge.checkToolCall("read", { path: join(directory, "outside.txt") });
  check("out-of-workspace read is blocked", !deniedFile.allowed, deniedFile.reason ?? "");

  const allowedFile = bridge.checkToolCall("read", { path: join(workspace, "notes.txt") });
  check("in-workspace read is allowed", allowedFile.allowed);

  const deniedTool = bridge.checkToolCall("undocumented_tool", {});
  check("unknown tool fails closed", !deniedTool.allowed, deniedTool.reason ?? "");

  const audit = readAudit(auditPath);
  check("every decision is audited", audit.length === 5, `${audit.length} lines`);
  check(
    "audit records both allow and block",
    audit.some((line) => line["decision"] === "allow") &&
      audit.some((line) => line["decision"] === "block"),
  );
  check(
    "audit records the denied target",
    audit.some((line) => String(line["detail"]).includes("192.0.2.10")),
  );

  // --- Artifacts -------------------------------------------------------------------
  writeFileSync(join(workspace, "artifacts", "nmap.xml"), "<nmaprun/>", "utf8");
  const db = configureDatabase(join(directory, "cairn.db"));
  const project = db.withConn((conn) =>
    createProject(conn, {
      title: "m3-gate",
      origin: "gate",
      goal: "gate",
      hints: null,
      bootstrap_enabled: false,
      scope: { targets: ["127.0.0.1:8080"] },
    }),
  );
  const artifacts = db.withConn((conn) =>
    recordProjectArtifacts(conn, {
      projectId: project.project.id,
      taskId: "gate-task",
      workspace,
    }),
  );
  check("artifact is indexed", artifacts.length === 1 && artifacts[0]!.path === "nmap.xml");
  check(
    "artifact size and hash are recorded",
    artifacts[0]?.size === 10 &&
      artifacts[0]?.sha256 === createHash("sha256").update("<nmaprun/>").digest("hex"),
  );

  const api = createApi({ db });
  const response = await api.handle(
    new Request(`http://cairn.test/projects/${project.project.id}/artifacts`),
  );
  const listed = (await response.json()) as Array<Record<string, unknown>>;
  check(
    "HTTP artifacts route serves the index",
    response.status === 200 && listed.length === 1 && listed[0]!["path"] === "nmap.xml",
  );

  // --- Container runtime ------------------------------------------------------------
  const docker = checkDocker();
  if (!docker.ok) {
    skip(
      "container lifecycle (Docker)",
      `Docker is not available on this host (${docker.detail}); only the fake-CLI unit tests ran, so container integration is NOT verified here`,
    );
  } else {
    check("Docker availability", true, `server ${docker.detail}`);
    const image = process.env["CAIRN_GATE_DOCKER_IMAGE"]?.trim();
    if (image === undefined || image === "") {
      skip(
        "container smoke test",
        "set CAIRN_GATE_DOCKER_IMAGE to verify ensure/mapPath/cleanup",
      );
    } else {
      const agentConfigDir = join(directory, "agent-config");
      mkdirSync(agentConfigDir, { recursive: true });
      const runtime = new DockerRuntime({
        container: {
          image,
          networkMode: "none",
          completedAction: "remove",
          capAdd: [],
          workspaceRoot: null,
          workerArgv: ["bun", "/app/apps/cairn/src/cli.ts", "worker", "--task"],
        },
        agentConfigDir,
        log: (message) => console.error(`[gate:docker] ${message}`),
      });
      try {
        const created = runtime.ensureProject(project.project.id, workspace);
        check("container starts for the project", created);
        check(
          "host workspace maps into the container",
          runtime.mapPath(join(workspace, "artifacts", "nmap.xml")) ===
            "/cairn/workspace/artifacts/nmap.xml",
        );
      } finally {
        runtime.cleanupInactive(new Set());
        runtime.close();
      }
    }
  }

  const failed = checks.filter((entry) => entry.status === "fail");
  const skipped = checks.filter((entry) => entry.status === "skip");
  const passed = checks.filter((entry) => entry.status === "pass");
  console.log("\n=== M3 gate ===");
  console.log(
    `${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
  );
  for (const entry of skipped) {
    console.log(`skipped: ${entry.name} (${entry.detail})`);
  }
  console.log(`directory: ${directory}`);

  if (process.env["CAIRN_GATE_KEEP"] === "1" || failed.length > 0) {
    console.log("kept the gate directory for inspection");
  } else {
    rmSync(directory, { recursive: true, force: true });
  }
  return failed.length === 0 ? 0 : 1;
}

function readAudit(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

process.exit(await main());

