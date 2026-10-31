/**
 * Environment-driven Host Bridge loader used inside a worker process.
 *
 * The worker role writes CAIRN_SCOPE_POLICY and CAIRN_HOST_BRIDGE_MODULE before starting
 * the solver. The vendored agent dynamically imports this module for the solver session
 * and for every subagent session, so a delegated subagent inherits the same gate instead
 * of bypassing it. A missing or malformed policy throws: the session must not start
 * without a scope gate.
 */

import { HostBridge, type SsrfMarkerPolicy } from "./bridge";
import { hostBridgeExtension, type PiApiLike } from "./pi-extension";

interface ScopePolicyEnvelope {
  projectId: string;
  taskId: string;
  workspace: string;
  sessionDir: string;
  targets: string[];
  artifactDir?: string;
  /** scope.ssrf_markers; the bridge falls back to observe when absent. */
  ssrfMarkers?: SsrfMarkerPolicy;
  /** scope.protected_hosts plus this deployment's own named hosts. */
  protectedHosts?: string[];
}

interface AuditStreamEnvelope {
  url: string;
  token: string;
}

interface CachedBridge {
  key: string;
  bridge: HostBridge;
}

// The factory runs once per solver/subagent session. They share one task, so they must
// also share one audit sender: per-session senders would restart sequence numbers at 1.
let cached: CachedBridge | null = null;

export function createHostBridgeExtensionFromEnv(): (pi: PiApiLike) => void {
  return hostBridgeExtension(bridgeFromEnv());
}

/** Flushes queued live audit entries; called by the worker before it exits. */
export async function flushHostBridgeAudit(): Promise<void> {
  await cached?.bridge.flushAuditStream();
}

function bridgeFromEnv(): HostBridge {
  const policy = parsePolicy(process.env["CAIRN_SCOPE_POLICY"]);
  const stream = parseAuditStream();
  const maxToolCalls = parseMaxToolCalls(process.env["CAIRN_TASK_MAX_TOOL_CALLS"]);
  const boardDir = process.env["CAIRN_OBSERVER_BOARD_DIR"]?.trim();
  const observerStateDir = process.env["CAIRN_OBSERVER_STATE_DIR"]?.trim();
  const protectedWriteRoots = [boardDir, observerStateDir].filter(
    (path): path is string => path !== undefined && path !== "",
  );
  const key = [
    process.env["CAIRN_SCOPE_POLICY"] ?? "",
    protectedWriteRoots.join("\u0000"),
    stream?.url ?? "",
    stream?.token ?? "",
    maxToolCalls === undefined ? "" : String(maxToolCalls),
  ].join("\u0000");
  if (cached !== null && cached.key === key) return cached.bridge;

  const bridge = new HostBridge({
    projectId: policy.projectId,
    taskId: policy.taskId,
    workspace: policy.workspace,
    sessionDir: policy.sessionDir,
    scopeTargets: policy.targets,
    ...(policy.artifactDir === undefined ? {} : { artifactDir: policy.artifactDir }),
    ...(policy.ssrfMarkers === undefined ? {} : { ssrfMarkers: policy.ssrfMarkers }),
    ...(policy.protectedHosts === undefined || policy.protectedHosts.length === 0
      ? {}
      : { protectedHosts: policy.protectedHosts }),
    ...(protectedWriteRoots.length === 0 ? {} : { protectedWriteRoots }),
    ...(stream === undefined ? {} : { auditStream: stream }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
  });
  cached = { key, bridge };
  return bridge;
}

function parseMaxToolCalls(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 1_000_000) {
    throw new Error("CAIRN_TASK_MAX_TOOL_CALLS must be a positive integer up to 1000000");
  }
  return value;
}

function parseAuditStream(): AuditStreamEnvelope | undefined {
  const url = process.env["CAIRN_AUDIT_STREAM_URL"]?.trim();
  const token = process.env["CAIRN_AUDIT_STREAM_TOKEN"]?.trim();
  if (url === undefined || url === "") {
    if (token !== undefined && token !== "") {
      throw new Error("CAIRN_AUDIT_STREAM_URL is required when a stream token is set");
    }
    return undefined;
  }
  if (token === undefined || token === "") {
    throw new Error("CAIRN_AUDIT_STREAM_TOKEN is required when a stream URL is set");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("CAIRN_AUDIT_STREAM_URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CAIRN_AUDIT_STREAM_URL must be an http(s) URL");
  }
  return { url, token };
}

function parsePolicy(raw: string | undefined): ScopePolicyEnvelope {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CAIRN_SCOPE_POLICY is required; refusing to start without a scope gate");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CAIRN_SCOPE_POLICY is not valid JSON: ${describe(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CAIRN_SCOPE_POLICY must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const projectId = requireString(record, "projectId");
  const taskId = requireString(record, "taskId");
  const workspace = requireString(record, "workspace");
  const sessionDir = requireString(record, "sessionDir");
  const targets = record["targets"];
  if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string")) {
    throw new Error("CAIRN_SCOPE_POLICY.targets must be an array of strings");
  }
  const artifactDir = record["artifactDir"];
  if (artifactDir !== undefined) {
    if (typeof artifactDir !== "string" || artifactDir.trim() === "") {
      throw new Error("CAIRN_SCOPE_POLICY.artifactDir must be a non-empty string");
    }
    const segments = artifactDir.split("/");
    if (
      artifactDir.includes("\\") ||
      artifactDir.startsWith("/") ||
      /^[A-Za-z]:/.test(artifactDir) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      segments[0] !== "artifacts" ||
      segments.length < 2
    ) {
      throw new Error('CAIRN_SCOPE_POLICY.artifactDir must be a relative path under "artifacts/"');
    }
  }
  const ssrfMarkers = record["ssrfMarkers"];
  if (ssrfMarkers !== undefined) {
    if (ssrfMarkers !== "block" && ssrfMarkers !== "observe" && ssrfMarkers !== "off") {
      throw new Error("CAIRN_SCOPE_POLICY.ssrfMarkers must be block, observe or off");
    }
  }
  const protectedHosts = record["protectedHosts"];
  if (protectedHosts !== undefined) {
    if (
      !Array.isArray(protectedHosts) ||
      protectedHosts.some((host) => typeof host !== "string" || host.trim() === "")
    ) {
      throw new Error("CAIRN_SCOPE_POLICY.protectedHosts must be an array of hostnames");
    }
  }
  return {
    projectId,
    taskId,
    workspace,
    sessionDir,
    targets: targets as string[],
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(ssrfMarkers === undefined ? {} : { ssrfMarkers: ssrfMarkers as SsrfMarkerPolicy }),
    ...(protectedHosts === undefined ? {} : { protectedHosts: protectedHosts as string[] }),
  };
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`CAIRN_SCOPE_POLICY.${key} must be a non-empty string`);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
