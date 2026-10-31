import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { HostBridge } from "./bridge";
import { hostBridgeExtension, type PiApiLike } from "./pi-extension";
import { createHostBridgeExtensionFromEnv } from "./worker-extension";

let directory: string;
let workspace: string;
let sessionDir: string;
let auditPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-bridge-"));
  workspace = join(directory, "workspace");
  sessionDir = join(workspace, ".cairn", "sessions", "task-1");
  mkdirSync(sessionDir, { recursive: true });
  auditPath = join(sessionDir, "audit.jsonl");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

type ToolCallHandler = Parameters<PiApiLike["on"]>[1];

function toolCallHandler(extension: (pi: PiApiLike) => void): ToolCallHandler {
  let handler: ToolCallHandler | null = null;
  extension({
    on(_event, registered) {
      handler = registered;
      return undefined;
    },
  });
  if (handler === null) throw new Error("the extension registered no tool-call handler");
  return handler;
}

function bridge(
  targets: string[] = ["127.0.0.1:8080", "*.example.test", "example.test"],
  overrides: {
    auditPath?: string;
    protectedWriteRoots?: string[];
    artifactDir?: string;
    maxToolCalls?: number;
  } = {},
): HostBridge {
  return new HostBridge({
    projectId: "proj-1",
    taskId: "task-1",
    workspace,
    sessionDir,
    scopeTargets: targets,
    ...(overrides.protectedWriteRoots === undefined
      ? {}
      : { protectedWriteRoots: overrides.protectedWriteRoots }),
    ...(overrides.artifactDir === undefined
      ? {}
      : { artifactDir: overrides.artifactDir }),
    ...(overrides.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: overrides.maxToolCalls }),
    auditPath: overrides.auditPath ?? auditPath,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

function auditLines(): Array<Record<string, unknown>> {
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("host bridge network policy", () => {
  test("allows a command whose endpoints are all in scope", () => {
    const gate = bridge();
    expect(gate.checkToolCall("bash", { command: "curl -s http://127.0.0.1:8080/health" }).allowed).toBe(
      true,
    );
    expect(gate.checkToolCall("bash", { command: "nmap -p8080 127.0.0.1" }).allowed).toBe(true);
    expect(
      gate.checkToolCall("bash", { command: "nmap -p 8080 127.0.0.1" }).allowed,
    ).toBe(true);
  });

  test("blocks an endpoint outside the authorized scope", () => {
    const gate = bridge();
    const wrongHost = gate.checkToolCall("bash", { command: "curl http://evil.test/" });
    expect(wrongHost.allowed).toBe(false);
    expect(wrongHost.reason).toContain("outside the authorized scope");

    const wrongPort = gate.checkToolCall("bash", { command: "curl http://127.0.0.1:8081/" });
    expect(wrongPort.allowed).toBe(false);

    const wrongNetwork = gate.checkToolCall("bash", { command: "nmap -p8080 10.0.0.5" });
    expect(wrongNetwork.allowed).toBe(false);
  });

  test("supports wildcard host targets without matching the bare domain", () => {
    const gate = bridge(["*.example.test"]);
    expect(gate.checkToolCall("bash", { command: "curl https://api.example.test/x" }).allowed).toBe(
      true,
    );
    expect(gate.checkToolCall("bash", { command: "curl https://example.test/x" }).allowed).toBe(
      false,
    );
    expect(
      gate.checkToolCall("bash", { command: "curl https://api.example.test.evil.test/x" }).allowed,
    ).toBe(false);
  });

  test("supports IPv4 CIDR targets", () => {
    const gate = bridge(["10.10.0.0/16"]);
    expect(gate.checkToolCall("bash", { command: "nmap -p22 10.10.3.4" }).allowed).toBe(true);
    expect(gate.checkToolCall("bash", { command: "nmap -p22 10.11.0.1" }).allowed).toBe(false);
  });

  test("fails closed when a network tool has no verifiable endpoint", () => {
    const gate = bridge();
    const decision = gate.checkToolCall("bash", { command: "curl -s https://" });
    // "https://" is not a usable URL and the tool name still implies network use.
    expect(decision.allowed).toBe(false);
    const bare = gate.checkToolCall("bash", { command: "curl" });
    if (bare.allowed) {
      // curl without arguments is a usage error, not a request; the analyzer treats
      // no-endpoint network tools as unverifiable, so this must block.
      throw new Error("curl without an endpoint must be blocked");
    }
  });

  test("allows an in-scope endpoint even when wrapped in a quoted command", () => {
    const gate = bridge();
    expect(
      gate.checkToolCall("bash", {
        command: "bash -c \"curl http://127.0.0.1:8080/health\"",
      }).allowed,
    ).toBe(true);
  });

  test("treats a help invocation as non-network", () => {
    const gate = bridge(["127.0.0.1"]);
    expect(gate.checkToolCall("bash", { command: "curl --help" }).allowed).toBe(true);
  });
});

describe("host bridge file policy", () => {
  test("reads and writes under the project workspace", () => {
    writeFileSync(join(workspace, "notes.txt"), "hello", "utf8");
    const gate = bridge();
    expect(gate.checkToolCall("read", { path: "notes.txt" }).allowed).toBe(true);
    expect(gate.checkToolCall("write", { path: "out.txt", content: "x" }).allowed).toBe(true);
    expect(gate.checkToolCall("grep", { pattern: "hello" }).allowed).toBe(true);
  });

  test("confines artifact writes to this task when scoped", () => {
    const gate = bridge(["127.0.0.1:8080"], {
      artifactDir: "artifacts/explore-0123456789ab",
    });

    expect(
      gate.checkToolCall("write", {
        path: "artifacts/explore-0123456789ab/scan.log",
        content: "ok",
      }).allowed,
    ).toBe(true);
    expect(
      gate.checkToolCall("edit", {
        path: "artifacts/explore-0123456789ab/nested/out.txt",
      }).allowed,
    ).toBe(true);
    expect(gate.checkToolCall("write", { path: "notes.txt", content: "x" }).allowed).toBe(
      true,
    );

    const otherTask = gate.checkToolCall("write", {
      path: "artifacts/explore-bbbbbbbbbbbb/out.txt",
      content: "x",
    });
    expect(otherTask.allowed).toBe(false);
    expect(otherTask.reason).toContain("outside this task's artifact directory");

    const root = gate.checkToolCall("write", { path: "artifacts/out.txt", content: "x" });
    expect(root.allowed).toBe(false);

    // Reads remain workspace-wide so tasks can reuse earlier artifacts.
    mkdirSync(join(workspace, "artifacts", "explore-bbbbbbbbbbbb"), { recursive: true });
    writeFileSync(
      join(workspace, "artifacts", "explore-bbbbbbbbbbbb", "out.txt"),
      "old",
      "utf8",
    );
    expect(
      gate.checkToolCall("read", { path: "artifacts/explore-bbbbbbbbbbbb/out.txt" }).allowed,
    ).toBe(true);
  });

  test("blocks reads outside the workspace and file scope", () => {
    const gate = bridge();
    const outside = join(directory, "outside.txt");
    writeFileSync(outside, "secret", "utf8");
    const decision = gate.checkToolCall("read", { path: outside });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("outside the project workspace");
  });

  test("allows reads from an explicit file: scope target", () => {
    const evidence = join(directory, "evidence");
    mkdirSync(evidence);
    writeFileSync(join(evidence, "dump.txt"), "evidence", "utf8");
    const url = `file:///${evidence.replaceAll("\\", "/")}`;
    const gate = bridge([url]);
    const decision = gate.checkToolCall("read", { path: join(evidence, "dump.txt") });
    expect(decision.allowed).toBe(true);
  });

  test("blocks writes outside the workspace", () => {
    const gate = bridge();
    const decision = gate.checkToolCall("write", {
      path: join(directory, "outside.txt"),
      content: "x",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("outside the project workspace");
  });

  test("blocks reads of the agent configuration directory", () => {
    const gate = bridge(["file:///" + join(directory, "evidence").replaceAll("\\", "/")]);
    for (const target of [
      join(homedir(), ".cairnweave", "config", "auth.json"),
      join(homedir(), ".cairnweave", "runtime.json"),
      join(homedir(), ".tch-agent", "config", "auth.json"),
    ]) {
      const decision = gate.checkToolCall("read", { path: target });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain("protected agent configuration");
    }
  });

  test("blocks a symlink escape from the workspace", () => {
    const outside = join(directory, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    let linked = true;
    try {
      symlinkSync(outside, join(workspace, "link"), "junction");
    } catch {
      linked = false;
    }
    if (!linked) return;

    const gate = bridge();
    const decision = gate.checkToolCall("read", { path: join(workspace, "link", "secret.txt") });
    expect(decision.allowed).toBe(false);
  });
});

describe("host bridge fail-closed cases", () => {
  test("blocks when the scope is empty or invalid", () => {
    const empty = bridge([]);
    expect(empty.checkToolCall("read", { path: "notes.txt" }).allowed).toBe(false);

    const invalid = bridge(["not a host"]);
    const decision = invalid.checkToolCall("read", { path: "notes.txt" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("invalid target");
  });

  test("blocks tools it does not understand", () => {
    const gate = bridge();
    const decision = gate.checkToolCall("mystery_tool", {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not covered");
  });

  test("blocks a bash call without a command", () => {
    const gate = bridge();
    expect(gate.checkToolCall("bash", {}).allowed).toBe(false);
  });

  test("allows worker-local tools in the allowlist", () => {
    const gate = bridge();
    expect(gate.checkToolCall("subagent", { agent: "recon", task: "x" }).allowed).toBe(true);
    expect(gate.checkToolCall("document_finding", {}).allowed).toBe(true);
  });

  test("allows only read-only Observer board tools", () => {
    const gate = bridge();
    expect(gate.checkToolCall("memory_list", {}).allowed).toBe(true);
    expect(gate.checkToolCall("idea_list", {}).allowed).toBe(true);
    expect(gate.checkToolCall("idea_search", { query: "ssrf" }).allowed).toBe(true);
    // The sidecar owns board writes and does not load the bridge; the solver must not
    // be able to mutate the board it is being advised from.
    expect(gate.checkToolCall("memory_add", { kind: "note", content: "x" }).allowed).toBe(
      false,
    );
    expect(gate.checkToolCall("memory_update", { entry_id: "m1" }).allowed).toBe(false);
    expect(gate.checkToolCall("memory_delete", { entry_id: "m1" }).allowed).toBe(false);
    expect(gate.checkToolCall("idea_add", { content: "x" }).allowed).toBe(false);
    expect(gate.checkToolCall("idea_update", { idea_id: "i1", status: "failed" }).allowed).toBe(
      false,
    );
  });

  test("keeps the Observer board read-only for the main solver's file tools", () => {
    const boardDir = join(workspace, ".cairn", "board");
    const gate = bridge(undefined, { protectedWriteRoots: [boardDir] });
    expect(gate.checkToolCall("read", { path: ".cairn/board/ideas.json" }).allowed).toBe(
      true,
    );
    expect(gate.checkToolCall("write", { path: ".cairn/board/ideas.json" }).allowed).toBe(
      false,
    );
    expect(gate.checkToolCall("write", { path: "notes.txt" }).allowed).toBe(true);
  });

  test("keeps the Observer task state and proposal queue read-only", () => {
    const stateDir = join(workspace, ".cairn", "sessions", "task-1", "observer");
    const gate = bridge(undefined, { protectedWriteRoots: [stateDir] });
    expect(
      gate.checkToolCall("read", { path: ".cairn/sessions/task-1/observer/proposals/a.json" })
        .allowed,
    ).toBe(true);
    expect(
      gate.checkToolCall("write", {
        path: ".cairn/sessions/task-1/observer/proposals/a.json",
      }).allowed,
    ).toBe(false);
    expect(gate.checkToolCall("write", { path: "notes.txt" }).allowed).toBe(true);
  });

  test("fails closed when the audit log cannot be written", () => {
    const gate = bridge(undefined, { auditPath: workspace });
    const decision = gate.checkToolCall("read", { path: "notes.txt" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("audit log is unavailable");
  });
});

describe("host bridge audit", () => {
  test("appends one JSON line per decision", () => {
    const gate = bridge();
    gate.checkToolCall("bash", { command: "curl http://127.0.0.1:8080/" });
    gate.checkToolCall("bash", { command: "curl http://evil.test/" });

    const lines = auditLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      ts: "2026-01-01T00:00:00.000Z",
      task_id: "task-1",
      project_id: "proj-1",
      tool: "bash",
      action: "bash",
      decision: "allow",
      reason: null,
    });
    expect(lines[1]).toMatchObject({ decision: "block" });
    expect(String(lines[1]!["reason"])).toContain("outside the authorized scope");
    expect(String(lines[1]!["detail"])).toContain("evil.test");
  });
});

describe("host bridge tool budget", () => {
  test("blocks calls past the ceiling and marks the audit event", () => {
    const gate = bridge(undefined, { maxToolCalls: 2 });
    expect(gate.checkToolCall("read", { path: "notes.txt" }).allowed).toBe(true);
    expect(gate.checkToolCall("read", { path: "notes.txt" }).allowed).toBe(true);

    const blocked = gate.checkToolCall("read", { path: "notes.txt" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("tool budget exhausted (2 calls)");
    expect(blocked.event).toBe("tool_budget_exhausted");

    // Blocked calls do not consume another slot.
    expect(gate.checkToolCall("read", { path: "notes.txt" }).event).toBe(
      "tool_budget_exhausted",
    );

    const lines = auditLines();
    expect(lines).toHaveLength(4);
    expect(lines[0]).not.toHaveProperty("event");
    expect(lines[2]).toMatchObject({
      decision: "block",
      event: "tool_budget_exhausted",
    });
  });

  test("does not count calls when no ceiling is configured", () => {
    const gate = bridge();
    for (let index = 0; index < 10; index += 1) {
      expect(gate.checkToolCall("read", { path: "notes.txt" }).allowed).toBe(true);
    }
    expect(auditLines().every((line) => line["event"] === undefined)).toBe(true);
  });
});

describe("pi extension adapter", () => {
  test("returns a block result for denied calls and undefined for allowed ones", async () => {
    interface Registered {
      handler: (event: { toolName?: unknown; input?: unknown }) => Promise<
        { block: true; reason: string } | undefined
      >;
    }
    let registered: Registered | null = null;
    const pi: PiApiLike = {
      on(_event, handler) {
        registered = { handler };
        return undefined;
      },
    };

    hostBridgeExtension(bridge())(pi);
    expect(registered).not.toBeNull();
    const handler = (registered as unknown as Registered).handler;

    const allowed = await handler({
      toolName: "bash",
      input: { command: "curl http://127.0.0.1:8080/" },
    });
    expect(allowed).toBeUndefined();

    const blocked = await handler({
      toolName: "bash",
      input: { command: "curl http://evil.test/" },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("outside the authorized scope");
  });
});

describe("environment-driven bridge", () => {
  const key = "CAIRN_SCOPE_POLICY";
  const budgetKey = "CAIRN_TASK_MAX_TOOL_CALLS";
  const previous = process.env[key];
  const previousBudget = process.env[budgetKey];

  afterEach(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousBudget === undefined) delete process.env[budgetKey];
    else process.env[budgetKey] = previousBudget;
  });

  test("builds a gate from the worker policy", () => {
    process.env[key] = JSON.stringify({
      projectId: "proj-1",
      taskId: "task-1",
      workspace,
      sessionDir,
      targets: ["127.0.0.1:8080"],
      artifactDir: "artifacts/explore-0123456789ab",
    });
    expect(() => createHostBridgeExtensionFromEnv()).not.toThrow();
  });

  test("rejects an unsafe artifact namespace", () => {
    process.env[key] = JSON.stringify({
      projectId: "proj-1",
      taskId: "task-1",
      workspace,
      sessionDir,
      targets: ["127.0.0.1:8080"],
      artifactDir: "artifacts/../escape",
    });
    expect(() => createHostBridgeExtensionFromEnv()).toThrow("artifactDir");
  });

  test("refuses to build without a policy", () => {
    delete process.env[key];
    expect(() => createHostBridgeExtensionFromEnv()).toThrow("CAIRN_SCOPE_POLICY is required");
  });

  test("refuses a malformed policy", () => {
    process.env[key] = JSON.stringify({ projectId: "p", taskId: "t", targets: [] });
    expect(() => createHostBridgeExtensionFromEnv()).toThrow("workspace");
  });

  test("validates the tool-call ceiling from the environment", () => {
    process.env[key] = JSON.stringify({
      projectId: "proj-1",
      taskId: "task-1",
      workspace,
      sessionDir,
      targets: ["127.0.0.1:8080"],
    });
    process.env[budgetKey] = "0";
    expect(() => createHostBridgeExtensionFromEnv()).toThrow("CAIRN_TASK_MAX_TOOL_CALLS");
    process.env[budgetKey] = "abc";
    expect(() => createHostBridgeExtensionFromEnv()).toThrow("CAIRN_TASK_MAX_TOOL_CALLS");
    process.env[budgetKey] = "12";
    expect(() => createHostBridgeExtensionFromEnv()).not.toThrow();
  });

  test("enforces the SSRF marker mode carried by the policy", async () => {
    process.env[key] = JSON.stringify({
      projectId: "proj-1",
      taskId: "task-1",
      workspace,
      sessionDir,
      targets: ["127.0.0.1:8080"],
      ssrfMarkers: "block",
      protectedHosts: ["cairn-control.internal"],
    });
    const handler = toolCallHandler(createHostBridgeExtensionFromEnv());

    const blocked = await handler({
      toolName: "bash",
      input: {
        command: "curl -s -d 'callback=cairn-control.internal' http://127.0.0.1:8080/form",
      },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("hard floor");

    const carried = await handler({
      toolName: "bash",
      input: { command: "curl -s 'http://127.0.0.1:8080/x?cb=http://10.0.0.9/admin'" },
    });
    expect(carried?.reason).toContain("SSRF markers are set to block");
  });

  test("refuses to start on an unrecognized marker mode or host list", () => {
    process.env[key] = JSON.stringify({
      projectId: "proj-1",
      taskId: "task-1",
      workspace,
      sessionDir,
      targets: ["127.0.0.1:8080"],
      ssrfMarkers: "watch",
    });
    expect(() => createHostBridgeExtensionFromEnv()).toThrow("CAIRN_SCOPE_POLICY.ssrfMarkers");

    process.env[key] = JSON.stringify({
      projectId: "proj-1",
      taskId: "task-1",
      workspace,
      sessionDir,
      targets: ["127.0.0.1:8080"],
      protectedHosts: "cairn-control.internal",
    });
    expect(() => createHostBridgeExtensionFromEnv()).toThrow(
      "CAIRN_SCOPE_POLICY.protectedHosts",
    );
  });
});
