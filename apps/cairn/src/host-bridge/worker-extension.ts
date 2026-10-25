/**
 * Environment-driven Host Bridge loader used inside a worker process.
 *
 * The worker role writes CAIRN_SCOPE_POLICY and CAIRN_HOST_BRIDGE_MODULE before starting
 * the solver. The vendored agent dynamically imports this module for the solver session
 * and for every subagent session, so a delegated subagent inherits the same gate instead
 * of bypassing it. A missing or malformed policy throws: the session must not start
 * without a scope gate.
 */

import { HostBridge } from "./bridge";
import { hostBridgeExtension, type PiApiLike } from "./pi-extension";

interface ScopePolicyEnvelope {
  projectId: string;
  taskId: string;
  workspace: string;
  sessionDir: string;
  targets: string[];
}

export function createHostBridgeExtensionFromEnv(): (pi: PiApiLike) => void {
  const policy = parsePolicy(process.env["CAIRN_SCOPE_POLICY"]);
  const bridge = new HostBridge({
    projectId: policy.projectId,
    taskId: policy.taskId,
    workspace: policy.workspace,
    sessionDir: policy.sessionDir,
    scopeTargets: policy.targets,
    ...(process.env["CAIRN_OBSERVER_BOARD_DIR"]?.trim()
      ? { protectedWriteRoots: [process.env["CAIRN_OBSERVER_BOARD_DIR"]!.trim()] }
      : {}),
  });
  return hostBridgeExtension(bridge);
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
  return { projectId, taskId, workspace, sessionDir, targets: targets as string[] };
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
