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
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { agentConfigDeniedRoots } from "../agent-config-dir";
import { CONTAINER_AGENT_CONFIG } from "../runtime/paths";
import { AuditStreamSender, type AuditStreamSenderOptions } from "./audit-stream";
import { analyzeCommand, carriedFromUrl, carriedTargetsInText } from "./command";
import {
  endpointAllowed,
  endpointFromUrl,
  parseScopeTargets,
  type Endpoint,
  type ParsedTarget,
} from "./scope-targets";

/**
 * What to do with a host literal that the worker hands to an authorized destination inside
 * the request itself (a URL query, a form body, a payload file). The destination, not the
 * worker, would resolve it.
 *
 * - `block`: refuse unless the carried target is itself inside the authorized scope.
 * - `observe`: record it and let the command run, except for the hard floor.
 * - `off`: ignore carried targets entirely.
 */
export type SsrfMarkerPolicy = "block" | "observe" | "off";

/** Hosts refused under every policy except `off`: cloud metadata and named infrastructure. */
const HARD_FLOOR_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);
/** 169.254.0.0/16, which carries the link-local metadata services. */
const HARD_FLOOR_LINK_LOCAL_PREFIX = 0xa9fe;
const MAX_CARRIED_TARGETS = 16;
const PAYLOAD_MAX_FILE_BYTES = 64 * 1024;
const PAYLOAD_MAX_TOTAL_BYTES = 256 * 1024;
const FAIL_CLOSED_REASON =
  "network command has no verifiable endpoint; refusing under fail-closed scope policy";

/** One SSRF observation, recorded next to the decision it belongs to. */
interface CarriedNotice {
  endpoints: Endpoint[];
  outOfScope: number;
  policy: SsrfMarkerPolicy;
  payloadFiles: string[];
}

interface ActionOutcome {
  problem: string | null;
  carried: CarriedNotice | null;
}

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
  /** Optional live forwarding of the same entries to the control plane. */
  auditStream?: Omit<AuditStreamSenderOptions, "projectId" | "taskId" | "sessionDir">;
  /**
   * Tool-call ceiling for this worker process. Once exhausted, further calls are blocked
   * (and audited as `tool_budget_exhausted`) so the solver can still emit its answer.
   * Subagent processes have their own bridge and counter.
   */
  maxToolCalls?: number;
  /** How to treat carried targets. Defaults to `observe`. */
  ssrfMarkers?: SsrfMarkerPolicy;
  /**
   * Hosts of this deployment's own facilities (control plane, audit stream, scoring
   * service). A carried target naming one of them is refused even under `observe`.
   */
  protectedHosts?: readonly string[];
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
  /** Set for the budget refusal and for the SSRF marker observation line. */
  event?: "tool_budget_exhausted" | "ssrf_candidate";
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
  private readonly auditStream: AuditStreamSender | null;
  private readonly maxToolCalls: number | null;
  private readonly ssrfMarkers: SsrfMarkerPolicy;
  private readonly protectedHosts: string[];
  /** Infrastructure names the analyzer reports even when a body carries no port. */
  private readonly carriedHostNames: string[];
  private toolCallCount = 0;

  constructor(options: HostBridgeOptions) {
    this.projectId = options.projectId;
    this.taskId = options.taskId;
    this.workspace = canonicalPath(resolve(options.workspace));
    this.auditPath =
      options.auditPath ?? resolve(options.sessionDir, "audit.jsonl");
    this.now = options.now ?? (() => new Date());
    this.maxToolCalls = options.maxToolCalls ?? null;
    this.ssrfMarkers = options.ssrfMarkers ?? "observe";
    this.protectedHosts = (options.protectedHosts ?? []).map((host) =>
      host.trim().toLowerCase().replace(/\.$/, ""),
    );
    this.carriedHostNames =
      this.ssrfMarkers === "off"
        ? []
        : [...new Set([...HARD_FLOOR_HOSTS, ...this.protectedHosts])];
    this.auditStream =
      options.auditStream === undefined
        ? null
        : new AuditStreamSender({
            ...options.auditStream,
            projectId: options.projectId,
            taskId: options.taskId,
            sessionDir: options.sessionDir,
          });
    this.deniedRoots = [CONTAINER_AGENT_CONFIG, ...agentConfigDeniedRoots()].map(
      (path) => canonicalPath(path),
    );
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
    let carried: CarriedNotice | null = null;

    if (this.maxToolCalls !== null && this.toolCallCount >= this.maxToolCalls) {
      decision = {
        ...this.decision(
          false,
          tool,
          classification,
          `tool budget exhausted (${this.maxToolCalls} calls); finish the task with the evidence already collected`,
        ),
        event: "tool_budget_exhausted",
      };
    } else {
      if (this.maxToolCalls !== null) this.toolCallCount += 1;
      const outcome = this.evaluateScoped(tool, classification);
      decision = outcome.decision;
      carried = outcome.carried;
    }

    const auditError = this.writeAudit(decision, classification.detail);
    if (auditError === null && carried !== null) {
      const markerError = this.writeCarriedAudit(decision, classification.detail, carried);
      return markerError === null
        ? decision
        : this.auditUnavailable(tool, decision, markerError);
    }
    return auditError === null ? decision : this.auditUnavailable(tool, decision, auditError);
  }

  private auditUnavailable(tool: string, decision: BridgeDecision, auditError: string) {
    return {
      allowed: false,
      tool,
      action: decision.action,
      targets: decision.targets,
      reason: `audit log is unavailable (${auditError}); failing closed`,
    };
  }

  private evaluateScoped(
    tool: string,
    classification: Classification,
  ): { decision: BridgeDecision; carried: CarriedNotice | null } {
    if (this.invalidTargets.length > 0) {
      return {
        decision: this.decision(
          false,
          tool,
          classification,
          `task scope contains invalid target(s): ${this.invalidTargets
            .map((entry) => `${entry.raw} (${entry.reason})`)
            .join(", ")}`,
        ),
        carried: null,
      };
    }
    if (this.targets.length === 0) {
      return {
        decision: this.decision(
          false,
          tool,
          classification,
          "task scope has no usable targets; failing closed",
        ),
        carried: null,
      };
    }
    return this.evaluate(tool, classification);
  }

  private evaluate(
    tool: string,
    classification: Classification,
  ): { decision: BridgeDecision; carried: CarriedNotice | null } {
    let notice: CarriedNotice | null = null;
    for (const action of classification.actions) {
      const outcome = this.actionOutcome(action);
      if (outcome.carried !== null) notice = outcome.carried;
      if (outcome.problem !== null) {
        return {
          decision: this.decision(false, tool, classification, outcome.problem),
          carried: notice,
        };
      }
    }
    return { decision: this.decision(true, tool, classification), carried: notice };
  }

  private actionOutcome(action: Action): ActionOutcome {
    switch (action.kind) {
      case "invalid":
        return { problem: action.reason, carried: null };
      case "local":
        return { problem: null, carried: null };
      case "file": {
        const problem = this.fileProblem(action.mode, action.path);
        return { problem, carried: null };
      }
      case "http": {
        const endpoint = endpointFromUrl(action.url);
        if (endpoint === null) {
          return { problem: `"${action.url}" is not a valid HTTP(S) URL`, carried: null };
        }
        const problem = this.endpointProblem(endpoint);
        if (problem !== null) return { problem, carried: null };
        return this.carriedOutcome(carriedFromUrl(action.url, this.carriedHostNames), []);
      }
      case "bash": {
        const analysis = analyzeCommand(action.command, this.carriedHostNames);
        if (analysis.unverifiable) {
          return { problem: FAIL_CLOSED_REASON, carried: null };
        }
        for (const endpoint of analysis.endpoints) {
          const problem = this.endpointProblem(endpoint);
          if (problem !== null) return { problem, carried: null };
        }
        if (analysis.networkIntent && analysis.endpoints.length === 0) {
          return { problem: FAIL_CLOSED_REASON, carried: null };
        }
        const payload = this.readPayloadTargets(analysis.payloadRefs);
        return this.carriedOutcome(
          dedupeCarried([...analysis.carried, ...payload.endpoints]),
          payload.files,
        );
      }
    }
  }

  /**
   * Carried targets never widen the scope of the destination check above. `block` refuses
   * one that is not itself authorized, `observe` records it, and both still refuse a target
   * that names this deployment's own facilities or a link-local metadata address.
   *
   * `off` skips all of it. Before M33 these literals were checked as destinations, so
   * choosing `off` is a deliberate relaxation, not a return to the old behaviour.
   */
  private carriedOutcome(
    carried: readonly Endpoint[],
    payloadFiles: readonly string[],
  ): ActionOutcome {
    if (this.ssrfMarkers === "off") return { problem: null, carried: null };
    if (carried.length === 0) return { problem: null, carried: null };
    const notice: CarriedNotice = {
      endpoints: [...carried],
      outOfScope: carried.filter((endpoint) => !endpointAllowed(endpoint, this.targets)).length,
      policy: this.ssrfMarkers,
      payloadFiles: [...payloadFiles],
    };
    for (const endpoint of carried) {
      if (this.isHardFloor(endpoint)) {
        return {
          problem: `carried target "${endpoint.raw}" is protected infrastructure; refused under the SSRF hard floor`,
          carried: notice,
        };
      }
    }
    if (this.ssrfMarkers === "block") {
      const refused = carried.find((endpoint) => !endpointAllowed(endpoint, this.targets));
      if (refused !== undefined) {
        return {
          problem: `carried target "${refused.raw}" inside an authorized request is outside the scope (SSRF markers are set to block)`,
          carried: notice,
        };
      }
    }
    // A carried literal that is itself authorized is not a hop worth reporting.
    if (notice.outOfScope === 0) return { problem: null, carried: null };
    return { problem: null, carried: notice };
  }

  private isHardFloor(endpoint: Endpoint): boolean {
    const host = endpoint.host ?? "";
    if (host === "" || endpoint.cidr !== undefined) return false;
    if (HARD_FLOOR_HOSTS.has(host)) return true;
    const octets = host.split(".");
    if (octets.length === 4 && Number(octets[0]) * 256 + Number(octets[1]) === HARD_FLOOR_LINK_LOCAL_PREFIX) {
      return true;
    }
    return this.protectedHosts.some(
      (protectedHost) => host === protectedHost || host.endsWith(`.${protectedHost}`),
    );
  }

  /**
   * Payload files are the declared channel for a target that only the receiving server
   * resolves. Reads are bounded and workspace-confined, so a hostile workspace cannot make
   * the gate open files or stall: absolute paths, symlinked parents, binaries and oversized
   * files are skipped, never refused.
   */
  private readPayloadTargets(refs: readonly string[]): { endpoints: Endpoint[]; files: string[] } {
    const endpoints: Endpoint[] = [];
    const files: string[] = [];
    if (this.ssrfMarkers === "off" || refs.length === 0) return { endpoints, files };
    let totalBytes = 0;
    for (const ref of refs) {
      if (endpoints.length >= MAX_CARRIED_TARGETS || totalBytes >= PAYLOAD_MAX_TOTAL_BYTES) break;
      const text = this.readPayloadFile(ref, PAYLOAD_MAX_TOTAL_BYTES - totalBytes);
      if (text === null) continue;
      totalBytes += text.bufferedLength;
      files.push(ref);
      for (const endpoint of text.targets) {
        if (endpoints.length >= MAX_CARRIED_TARGETS) break;
        endpoints.push(endpoint);
      }
    }
    return { endpoints, files };
  }

  private readPayloadFile(
    ref: string,
    remainingBytes: number,
  ): { targets: Endpoint[]; bufferedLength: number } | null {
    const raw = ref.replace(/^@/, "").trim();
    if (raw === "" || raw === "-" || raw.includes("\0") || isAbsolute(raw) || raw.includes("\\") || raw.startsWith("/")) {
      return null;
    }
    const candidate = canonicalPath(resolve(this.workspace, raw));
    if (!isUnder(this.workspace, candidate)) return null;
    const stats = lstatSync(candidate, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) return null;
    const limit = Math.min(PAYLOAD_MAX_FILE_BYTES, remainingBytes);
    if (stats.size === 0 || stats.size > limit) return null;
    let real: string;
    try {
      real = canonicalPath(realpathSync(candidate));
    } catch {
      return null;
    }
    if (!isUnder(this.workspace, real)) return null;
    let buffer: Buffer;
    try {
      buffer = readFileSync(candidate);
    } catch {
      return null;
    }
    if (buffer.includes(0)) return null;
    const text = buffer.toString("utf8");
    return {
      targets: carriedTargetsInText(text, this.carriedHostNames),
      bufferedLength: buffer.length,
    };
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
        return `write path "${rawPath}" is owned by the Observer; the solver is read-only`;
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
    return this.appendAudit({
      ts: this.now().toISOString(),
      task_id: this.taskId,
      project_id: this.projectId,
      tool: decision.tool,
      action: decision.action,
      targets: decision.targets,
      decision: decision.allowed ? "allow" : "block",
      reason: decision.reason ?? null,
      detail: detail.slice(0, 400),
      ...(decision.event === undefined ? {} : { event: decision.event }),
    });
  }

  /**
   * One extra line per action that carried a target inside an authorized request, so an
   * operator can see the shape of a server-side hop even when the policy let it through.
   */
  private writeCarriedAudit(
    decision: BridgeDecision,
    detail: string,
    notice: CarriedNotice,
  ): string | null {
    const files = notice.payloadFiles.length;
    return this.appendAudit({
      ts: this.now().toISOString(),
      task_id: this.taskId,
      project_id: this.projectId,
      tool: decision.tool,
      action: decision.action,
      targets: notice.endpoints.map((endpoint) => endpoint.raw),
      decision: decision.allowed ? "allow" : "block",
      reason:
        `SSRF markers (${notice.policy}): ${notice.endpoints.length} carried target(s), ` +
        `${notice.outOfScope} outside the authorized scope` +
        (files === 0 ? "" : `, ${files} payload file(s) read`),
      detail: detail.slice(0, 400),
      event: "ssrf_candidate",
    });
  }

  private appendAudit(entry: Record<string, unknown>): string | null {
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true });
      appendFileSync(this.auditPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    // Only forward what the local file already contains: the file remains the source of
    // truth for the finish-time backfill.
    this.auditStream?.enqueue(entry);
    return null;
  }

  /** Flushes the live audit queue; the worker calls this before writing its result. */
  async flushAuditStream(): Promise<void> {
    await this.auditStream?.close();
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

/**
 * The same host can reach the gate through several channels — a query parameter and the
 * payload file that mirrors it — so one refusal names it once.
 */
function dedupeCarried(endpoints: readonly Endpoint[]): Endpoint[] {
  const seen = new Set<string>();
  const unique: Endpoint[] = [];
  for (const endpoint of endpoints) {
    if (unique.length >= MAX_CARRIED_TARGETS) break;
    const key =
      endpoint.cidr === undefined
        ? `host:${endpoint.host ?? ""}:${endpoint.port ?? ""}`
        : `cidr:${endpoint.cidr.base}/${endpoint.cidr.prefix}:${endpoint.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(endpoint);
  }
  return unique;
}
