/**
 * Host Bridge: the action-level scope gate.
 *
 * The bridge sees every pi `tool_call` in the solver process and decides before the tool
 * runs. Every decision, allow or block, is appended to `<sessionDir>/audit.jsonl`. A
 * malformed task, an unknown tool, a missing scope or an unwritable audit log fails
 * closed: the tool does not run.
 *
 * Limits are deliberate and documented in docs/ARCHITECTURE.md: file tools are checked
 * path-by-path, and network tools are checked by extracting endpoints from the command.
 * The container is the kernel boundary for arbitrary code; see `scope-targets.ts` and
 * `command.ts` for what the analyzer can and cannot see.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { CONTAINER_AGENT_CONFIG } from "../runtime/paths";
import { analyzeCommand } from "./command";
import {
  endpointAllowed,
  endpointFromUrl,
  parseScopeTargets,
  type Endpoint,
  type ParsedTarget,
} from "./scope-targets";

export interface HostBridgeOptions {
  projectId: string;
  taskId: string;
  /** Worker-view project workspace. */
  workspace: string;
  /** Worker-view session directory; audit.jsonl is written here. */
  sessionDir: string;
  scopeTargets: readonly string[];
  /**
   * Paths the main solver may read but not write through file tools. Used for the
   * project-level Observer board, which is owned by the sidecar.
   */
  protectedWriteRoots?: readonly string[];
  /**
   * Task-scoped artifact namespace relative to the workspace. When set, file writes under
   * `<workspace>/artifacts/` must stay inside this directory. Absent means the workspace
   * is shared (single-worker projects).
   */
  artifactDir?: string;
  /** Test hook. */
  auditPath?: string;
  /** Test hook. */
  now?: () => Date;
}

export interface BridgeDecision {
  allowed: boolean;
  tool: string;
  action: string;
  targets: string[];
  reason?: string;
}

type Action =
  | { kind: "bash"; command: string }
  | { kind: "file"; mode: "read" | "write"; path: string }
  | { kind: "http"; url: string }
  | { kind: "local" }
  | { kind: "invalid"; reason: string };

interface Classification {
  actions: Action[];
  targets: string[];
  detail: string;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const HTTP_TOOLS = new Set([
  "fetch",
  "http",
  "http_request",
  "web_fetch",
  "webfetch",
  "url_fetch",
]);
/**
 * Tools that only touch worker-local state or the fixed challenge/search service. They
 * cannot reach a target of their own, so they pass without a scope lookup. `subagent` is
 * listed because subagent sessions load the same bridge from the worker environment;
 * anything not listed here fails closed.
 *
 * The Observer board tools are read-only on the main solver and resolve only the
 * project-level board directory. Write tools (`memory_add/update/delete`, `idea_add/
 * update`) are deliberately absent: the Observer sidecar is the only writer and does not
 * load this bridge at all.
 */
const LOCAL_TOOLS = new Set([
  "subagent",
  "document_finding",
  "ingest_sub_agent_output",
  "submit_sub_agent_output",
  "challenge_submit_flag",
  "challenge_get_hint",
  "security_kimi_search",
  "memory_list",
  "idea_list",
  "idea_search",
]);

export class HostBridge {
  readonly auditPath: string;
  private readonly projectId: string;
  private readonly taskId: string;
  private readonly workspace: string;
  private readonly deniedRoots: string[];
  private readonly protectedWriteRoots: string[];
  private readonly fileRoots: string[];
  private readonly artifactDir: string | null;
  private readonly artifactsRoot: string | null;
  private readonly taskArtifactsRoot: string | null;
  private readonly targets: ParsedTarget[];
  private readonly invalidTargets: Array<{ raw: string; reason: string }>;
  private readonly now: () => Date;

  constructor(options: HostBridgeOptions) {
    this.projectId = options.projectId;
    this.taskId = options.taskId;
    this.workspace = canonicalPath(resolve(options.workspace));
    this.auditPath =
      options.auditPath ?? resolve(options.sessionDir, "audit.jsonl");
    this.now = options.now ?? (() => new Date());
    this.deniedRoots = [
      CONTAINER_AGENT_CONFIG,
      resolve(homedir(), ".tch-agent", "config"),
      resolve(homedir(), ".tch-agent"),
    ].map((path) => canonicalPath(path));
    this.protectedWriteRoots = (options.protectedWriteRoots ?? []).map((path) =>
      canonicalPath(resolve(path)),
    );
    this.artifactDir = options.artifactDir ?? null;
    this.artifactsRoot =
      this.artifactDir === null
        ? null
        : canonicalPath(resolve(this.workspace, "artifacts"));
    this.taskArtifactsRoot =
      this.artifactDir === null
        ? null
        : canonicalPath(resolve(this.workspace, ...this.artifactDir.split("/")));

    const parsed = parseScopeTargets(options.scopeTargets);
    this.targets = parsed.targets;
    this.invalidTargets = parsed.invalid;
    this.fileRoots = parsed.targets
      .filter((target) => target.kind === "file" && target.path !== undefined)
      .map((target) => canonicalPath(resolve(target.path!)))
      .filter((path) => path !== this.workspace);
  }

  checkToolCall(toolName: string, input: unknown): BridgeDecision {
    const tool = toolName.trim().toLowerCase();
    const classification = classify(tool, input, this.workspace);
    let decision: BridgeDecision;

    if (this.invalidTargets.length > 0) {
      decision = this.decision(
        false,
        tool,
        classification,
        `task scope contains invalid target(s): ${this.invalidTargets
          .map((entry) => `${entry.raw} (${entry.reason})`)
          .join(", ")}`,
      );
    } else if (this.targets.length === 0) {
      decision = this.decision(
        false,
        tool,
        classification,
        "task scope has no usable targets; failing closed",
      );
    } else {
      decision = this.evaluate(tool, classification);
    }

    const auditError = this.writeAudit(decision, classification.detail);
    if (auditError !== null) {
      return {
        allowed: false,
        tool,
        action: decision.action,
        targets: decision.targets,
        reason: `audit log is unavailable (${auditError}); failing closed`,
      };
    }
    return decision;
  }

  private evaluate(tool: string, classification: Classification): BridgeDecision {
    for (const action of classification.actions) {
      const problem = this.actionProblem(action);
      if (problem !== null) {
        return this.decision(false, tool, classification, problem);
      }
    }
    return this.decision(true, tool, classification);
  }

  private actionProblem(action: Action): string | null {
    switch (action.kind) {
      case "invalid":
        return action.reason;
      case "local":
        return null;
      case "file":
        return this.fileProblem(action.mode, action.path);
      case "http": {
        const endpoint = endpointFromUrl(action.url);
        if (endpoint === null) return `"${action.url}" is not a valid HTTP(S) URL`;
        return this.endpointProblem(endpoint);
      }
      case "bash": {
        const analysis = analyzeCommand(action.command);
        if (analysis.unverifiable) {
          return "network command has no verifiable endpoint; refusing under fail-closed scope policy";
        }
        for (const endpoint of analysis.endpoints) {
          const problem = this.endpointProblem(endpoint);
          if (problem !== null) return problem;
        }
        if (analysis.networkIntent && analysis.endpoints.length === 0) {
          return "network command has no verifiable endpoint; refusing under fail-closed scope policy";
        }
        return null;
      }
    }
  }

  private endpointProblem(endpoint: Endpoint): string | null {
    if (endpointAllowed(endpoint, this.targets)) return null;
    return `target "${endpoint.raw}" is outside the authorized scope`;
  }

  private fileProblem(mode: "read" | "write", rawPath: string): string | null {
    if (rawPath.includes("\0")) return "path contains a NUL byte";
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(this.workspace, rawPath);
    const path = canonicalPath(absolute);

    if (this.deniedRoots.some((root) => isUnder(root, path))) {
      return `path "${rawPath}" is protected agent configuration`;
    }

    if (mode === "write") {
      if (!isUnder(this.workspace, path)) {
        return `write path "${rawPath}" is outside the project workspace`;
      }
      if (this.protectedWriteRoots.some((root) => isUnder(root, path))) {
        return `write path "${rawPath}" is the Observer board; the solver is read-only`;
      }
      if (
        this.artifactsRoot !== null &&
        this.taskArtifactsRoot !== null &&
        isUnder(this.artifactsRoot, path) &&
        !isUnder(this.taskArtifactsRoot, path)
      ) {
        return `write path "${rawPath}" is outside this task's artifact directory (${this.artifactDir}); concurrent tasks share the workspace`;
      }
      return null;
    }

    if (isUnder(this.workspace, path)) return null;
    if (this.fileRoots.some((root) => isUnder(root, path))) return null;
    return `read path "${rawPath}" is outside the project workspace and file scope`;
  }

  private decision(
    allowed: boolean,
    tool: string,
    classification: Classification,
    reason?: string,
  ): BridgeDecision {
    return {
      allowed,
      tool,
      action: actionName(classification.actions),
      targets: classification.targets,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  private writeAudit(decision: BridgeDecision, detail: string): string | null {
    const entry = {
      ts: this.now().toISOString(),
      task_id: this.taskId,
      project_id: this.projectId,
      tool: decision.tool,
      action: decision.action,
      targets: decision.targets,
      decision: decision.allowed ? "allow" : "block",
      reason: decision.reason ?? null,
      detail: detail.slice(0, 400),
    };
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, "utf8");
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

function classify(tool: string, input: unknown, workspace: string): Classification {
  const record = asRecord(input);
  if (tool === "bash") {
    const command = stringField(record, "command");
    if (command === null || command.trim() === "") {
      return invalid("bash input.command must be a non-empty string");
    }
    return {
      actions: [{ kind: "bash", command }],
      targets: [],
      detail: `command=${command.replace(/\s+/g, " ").slice(0, 300)}`,
    };
  }

  if (READ_TOOLS.has(tool) || WRITE_TOOLS.has(tool)) {
    const mode = WRITE_TOOLS.has(tool) ? "write" : "read";
    const paths = pathFields(record);
    if (paths.length === 0) {
      if (tool === "grep" || tool === "find" || tool === "ls") {
        return {
          actions: [{ kind: "file", mode, path: workspace }],
          targets: [workspace],
          detail: `${tool} path=<workspace>`,
        };
      }
      return invalid(`${tool} input requires a path`);
    }
    return {
      actions: paths.map((path) => ({ kind: "file" as const, mode, path })),
      targets: paths.map((path) =>
        isAbsolute(path) ? path : resolve(workspace, path),
      ),
      detail: `${tool} path=${paths.join(",").slice(0, 300)}`,
    };
  }

  if (LOCAL_TOOLS.has(tool)) {
    return {
      actions: [{ kind: "local" }],
      targets: [],
      detail: `${tool} (worker-local)`,
    };
  }

  if (HTTP_TOOLS.has(tool)) {
    const url = stringField(record, "url") ?? stringField(record, "uri");
    if (url === null || url.trim() === "") {
      return invalid(`${tool} input requires a url`);
    }
    return {
      actions: [{ kind: "http", url }],
      targets: [url],
      detail: `url=${url.slice(0, 300)}`,
    };
  }

  return invalid(`tool "${tool}" is not covered by the Host Bridge`);
}

function invalid(reason: string): Classification {
  return {
    actions: [{ kind: "invalid", reason }],
    targets: [],
    detail: reason.slice(0, 300),
  };
}

function actionName(actions: readonly Action[]): string {
  const kinds = [...new Set(actions.map((action) => action.kind))];
  return kinds.join(",") || "none";
}

function pathFields(record: Record<string, unknown> | null): string[] {
  if (record === null) return [];
  for (const key of ["path", "file_path", "filePath", "paths"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return [value];
    if (Array.isArray(value)) {
      return value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      );
    }
  }
  return [];
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function canonicalPath(input: string): string {
  let current = resolve(input);
  const missing: string[] = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return resolve(realpathSync.native(current), ...missing);
    } catch {
      if (existsSync(current)) return resolve(current, ...missing);
      const parent = dirname(current);
      if (parent === current) break;
      missing.unshift(basename(current));
      current = parent;
    }
  }
  return resolve(current, ...missing);
}

export function isUnder(root: string, target: string): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(target));
  if (rel === "") return true;
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function normalizeForCompare(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
