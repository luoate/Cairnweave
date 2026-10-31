/**
 * Chinese writeup routes (M19a).
 *
 * `GET /projects/{id}/writeup` always answers: it renders the recorded graph into a
 * Chinese Markdown draft, or returns the stored model-written narrative when one exists.
 * `POST` asks a configured model to rewrite that draft as prose and stores the result, so
 * an operator without model credentials still gets a usable writeup and the narrative is
 * strictly bounded by data the control plane already has.
 *
 * Hardening: the generation call is bounded in both directions (prompt characters and
 * wall-clock timeout), the provider error text is sanitized before it is returned, writes
 * require the operator token and same-origin, and a failed generation leaves any previously
 * stored writeup untouched.
 */

import type { Database } from "bun:sqlite";

import {
  buildProjectWriteup,
  clearProjectWriteup,
  getProjectWriteup,
  listProjectArtifacts,
  listRejectedFlags,
  listVerifiedFlags,
  renderProjectWriteupMarkdown,
  renderProjectWriteupPrompt,
  saveProjectWriteup,
  selectWriteupPayloadArtifacts,
  type CairnDatabase,
  type ProjectArtifact,
  type ProjectWriteupRecord,
  type ProjectWriteupSnapshot,
  type VerificationKind,
  type WriteupFlag,
  type WriteupPayloadContent,
} from "@cairn/graph";
import { HttpError } from "@cairn/graph";

import { projectWorkspace } from "../scheduler/tasks";
import type { RouteContext } from "./api";
import { isCrossOrigin, requireOperator } from "./auth";
import {
  loadAgentConfigManager,
  sanitizeText,
  type AgentConfigOptions,
} from "./agent-config";
import { collectProjectFlag } from "./project-flag";
import { buildWriteupArchive } from "./project-archive";
import { collectWriteupPayloads } from "./project-payload";

/** `cairn-worker.md` binds the default worker to this model-prefs entry. */
const DEFAULT_WRITEUP_MODEL_PREF = "cairn-worker";
const DEFAULT_WRITEUP_TIMEOUT_MS = 90_000;
const MAX_WRITEUP_PROMPT_CHARS = 60_000;
const MAX_WRITEUP_MARKDOWN_CHARS = 200_000;
const MAX_REQUEST_BYTES = 4 * 1024;
const MODEL_PREF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface WriteupGenerationInput {
  modelPrefId: string;
  systemPrompt: string;
  prompt: string;
}

export interface WriteupGenerationResult {
  ok: boolean;
  text?: string;
  model?: string;
  error?: string;
}

export type WriteupGenerator = (
  input: WriteupGenerationInput,
) => Promise<WriteupGenerationResult>;

export interface WriteupRouteOptions {
  db: CairnDatabase;
  /**
   * Host workspace root; absent in pure HTTP mode, which omits the flag and payload bytes.
   * A getter follows a live local↔container switch, whose roots may differ.
   */
  workspaceRoot?: string | (() => string);
  /** Policy reported for legacy projects without a `project_verification` row. */
  verificationFallback: VerificationKind;
  operatorToken?: string;
  /** Config directory/factory shared with the model routes. */
  agentConfig?: AgentConfigOptions;
  /** Test seam; defaults to `@cairn/agent`'s `ConfigManager.completeText`. */
  generator?: WriteupGenerator;
  timeoutMs?: number;
  /** model-prefs entry used when the request does not name one. */
  modelPref?: string;
}

type RouteRegistrar = (
  method: string,
  template: string,
  handler: (context: RouteContext) => Promise<Response> | Response,
) => void;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function markdown(value: string): Response {
  return new Response(value, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

function zip(bytes: Uint8Array, filename: string): Response {
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.byteLength),
    },
  });
}

/** `writeup-proj_008.zip`; only safe filename characters reach the header. */
function archiveFilename(projectId: string): string {
  const safe = projectId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "project";
  return `writeup-${safe}.zip`;
}

interface FlagView {
  value: string;
  source: string | null;
  occurrences: number;
  /** Other accepted flag-shaped values, ranked below `value`. */
  alternatives: string[];
}

/** JSON projection of the payload list: the Markdown body carries the text itself. */
interface PayloadFileView {
  path: string;
  size: number;
  sha256: string;
  task_id: string;
  language: string | null;
  state: "inline" | "binary" | "unread";
  truncated: boolean;
  referenced_by: string[];
}

interface PayloadView {
  files: PayloadFileView[];
  total: number;
  count: number;
  inlined: number;
  binary: number;
  unread: number;
  truncated: boolean;
}

/** Whether `GET .../writeup/archive` can serve bytes, and how many files it would bundle. */
interface ArchiveView {
  available: boolean;
  files: number;
}

interface Draft {
  snapshot: ProjectWriteupSnapshot;
  markdown: string;
  flag: FlagView | null;
  payloads: PayloadView;
  artifacts: ProjectArtifact[];
  generated_at: string;
}

function payloadView(snapshot: ProjectWriteupSnapshot): PayloadView {
  const payloads = snapshot.payloads;
  const files = payloads.map((payload) => ({
    path: payload.path,
    size: payload.size,
    sha256: payload.sha256,
    task_id: payload.task_id,
    language: payload.language,
    state:
      payload.text !== null ? "inline" as const : payload.binary ? "binary" as const : "unread" as const,
    truncated: payload.truncated,
    referenced_by: payload.referenced_by,
  }));
  return {
    files,
    total: snapshot.payloads_total,
    count: files.length,
    inlined: files.filter((file) => file.state === "inline").length,
    binary: files.filter((file) => file.state === "binary").length,
    unread: files.filter((file) => file.state === "unread").length,
    truncated: snapshot.payloads_truncated,
  };
}

/** The payload every writeup route answers with; `source` records which text is served. */
function view(record: ProjectWriteupRecord | null, draft: Draft, archive: ArchiveView) {
  return {
    project_id: draft.snapshot.project.id,
    source: record === null ? "draft" : "model",
    model: record?.model ?? null,
    created_at: record?.created_at ?? null,
    markdown: record?.markdown ?? draft.markdown,
    flag: draft.flag,
    flag_suspects: draft.snapshot.flag_suspects,
    payloads: draft.payloads,
    archive,
    generated_at: draft.generated_at,
    verification: draft.snapshot.verification,
  };
}

export function registerWriteupRoutes(
  register: RouteRegistrar,
  options: WriteupRouteOptions,
): void {
  const { db, verificationFallback } = options;
  const workspaceRootValue = options.workspaceRoot;
  const workspaceRoot = (): string | undefined =>
    typeof workspaceRootValue === "function" ? workspaceRootValue() : workspaceRootValue;
  const timeoutMs =
    typeof options.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_WRITEUP_TIMEOUT_MS;
  const defaultModelPref = options.modelPref ?? DEFAULT_WRITEUP_MODEL_PREF;
  const generator = options.generator ?? defaultGenerator(options.agentConfig);

  function guard(request: Request): void {
    if (isCrossOrigin(request)) {
      throw new HttpError(403, "cross-origin writeups are not allowed");
    }
    requireOperator(request, options.operatorToken);
  }

  function archiveView(draft: Draft): ArchiveView {
    return {
      available: workspaceRoot() !== undefined && draft.artifacts.length > 0,
      files: draft.artifacts.length,
    };
  }

  register("GET", "/projects/{project_id}/writeup", ({ params, url }) => {
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "markdown") {
      throw new HttpError(400, "Supported formats: json, markdown");
    }
    return db.withConn((conn) => {
      const draft = buildDraft(conn, params["project_id"]!);
      const stored = getProjectWriteup(conn, draft.snapshot.project.id);
      if (format === "markdown") {
        return markdown(stored === null ? draft.markdown : stored.markdown);
      }
      return json(view(stored, draft, archiveView(draft)));
    });
  });

  register("GET", "/projects/{project_id}/writeup/archive", ({ params }) => {
    const projectId = params["project_id"]!;
    const root = workspaceRoot();
    if (root === undefined) {
      throw new HttpError(409, "workspace root is not mounted, so attachments cannot be read");
    }
    return db.withConn((conn) => {
      const draft = buildDraft(conn, projectId);
      const stored = getProjectWriteup(conn, draft.snapshot.project.id);
      const archive = buildWriteupArchive({
        workspace: projectWorkspace(root, projectId),
        artifacts: draft.artifacts,
        snapshot: draft.snapshot,
        markdown: stored === null ? draft.markdown : stored.markdown,
        source: stored === null ? "draft" : "model",
        generatedAt: new Date(),
      });
      return zip(archive.bytes, archiveFilename(draft.snapshot.project.id));
    });
  });

  register("POST", "/projects/{project_id}/writeup", async ({ params, request }) => {
    guard(request);
    const projectId = params["project_id"]!;
    const modelPref = await readModelPref(request, defaultModelPref);
    const draft = db.withConn((conn) => buildDraft(conn, projectId));
    const prompt = trimPrompt(renderProjectWriteupPrompt(draft.snapshot));

    let outcome: WriteupGenerationResult;
    try {
      const raced = await withTimeout(
        generator({
          modelPrefId: modelPref,
          systemPrompt:
            "你是 CTF 复盘写手。只依据用户提供的控制面草稿撰写，不编造未记录的步骤。",
          prompt,
        }),
        timeoutMs,
      );
      if (raced === TIMEOUT) {
        throw new HttpError(
          504,
          `writeup generation timed out after ${Math.round(timeoutMs / 1000)}s`,
        );
      }
      outcome = raced;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, sanitizeText(describe(error)));
    }

    const text = outcome.text?.trim() ?? "";
    if (!outcome.ok || text === "") {
      throw new HttpError(
        502,
        sanitizeText(
          outcome.error === undefined || outcome.error.trim() === ""
            ? "model returned no writeup"
            : outcome.error,
        ),
      );
    }

    // A failed generation must leave the previously stored narrative untouched, so the
    // write happens only after the model produced non-empty text.
    const stored = db.withConn((conn) =>
      saveProjectWriteup(conn, {
        projectId,
        markdown: clampMarkdown(text),
        model: outcome.model ?? modelPref,
      }),
    );
    return json({ ...view(stored, draft, archiveView(draft)), ok: true }, 200);
  });

  register("DELETE", "/projects/{project_id}/writeup", ({ params, request }) => {
    guard(request);
    const projectId = params["project_id"]!;
    return db.withConn((conn) => {
      const draft = buildDraft(conn, projectId);
      clearProjectWriteup(conn, projectId);
      return json(view(null, draft, archiveView(draft)));
    });
  });

  function buildDraft(conn: Database, projectId: string): Draft {
    const artifacts = listProjectArtifacts(conn, projectId);
    const root = workspaceRoot();
    const workspace = root === undefined ? null : projectWorkspace(root, projectId);
    const flag =
      workspace === null
        ? null
        : collectProjectFlag({
            workspace,
            artifacts,
            rejectedFlags: listRejectedFlags(conn, projectId),
            verifiedFlags: listVerifiedFlags(conn, projectId),
          });
    const suspects =
      flag === null ? [] : flag.candidates.filter((c) => c.placeholder).map((c) => c.value);
    const flagView: FlagView | null =
      flag !== null && flag.found && flag.flag !== null
        ? {
            value: flag.flag,
            source: flag.source,
            occurrences: flag.occurrences,
            alternatives: flag.candidates
              .filter((candidate) => !candidate.placeholder)
              .slice(1)
              .map((candidate) => candidate.value),
          }
        : null;
    const payloadContents: WriteupPayloadContent[] =
      workspace === null
        ? []
        : collectWriteupPayloads({
            workspace,
            artifacts: selectWriteupPayloadArtifacts(conn, projectId),
          });
    const snapshot = buildProjectWriteup(conn, projectId, {
      verificationFallback,
      payloadContents,
      flagSuspects: suspects,
      ...(flagView === null
        ? {}
        : {
            flag: {
              value: flagView.value,
              source: flagView.source ?? "",
              alternatives: flagView.alternatives,
            },
          }),
    });
    return {
      snapshot,
      markdown: renderProjectWriteupMarkdown(snapshot),
      flag: flagView,
      payloads: payloadView(snapshot),
      artifacts,
      generated_at: snapshot.generated_at,
    };
  }
}

async function readModelPref(request: Request, fallback: string): Promise<string> {
  const raw = await request.text();
  if (raw.trim() === "") return fallback;
  if (raw.length > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Request body too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "JSON decode error");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "writeup body must be a JSON object");
  }
  const model = (parsed as Record<string, unknown>)["model"];
  if (model === undefined || model === null || model === "") return fallback;
  if (typeof model !== "string" || !MODEL_PREF_ID.test(model.trim())) {
    throw new HttpError(400, "writeup model must be a model-pref id");
  }
  return model.trim();
}

function trimPrompt(prompt: string): string {
  if (prompt.length <= MAX_WRITEUP_PROMPT_CHARS) return prompt;
  return `${prompt.slice(0, MAX_WRITEUP_PROMPT_CHARS)}\n\n（草稿过长，后续章节已截断）`;
}

function clampMarkdown(text: string): string {
  if (text.length <= MAX_WRITEUP_MARKDOWN_CHARS) return text;
  return `${text.slice(0, MAX_WRITEUP_MARKDOWN_CHARS)}\n\n…（模型输出过长，已截断）`;
}

const TIMEOUT = Symbol("writeup-timeout");

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Production generator: one tool-less agent turn through the shared ConfigManager. */
function defaultGenerator(
  agentConfig: AgentConfigOptions | undefined,
): WriteupGenerator {
  return async (input) => {
    const manager = await loadAgentConfigManager(agentConfig ?? {});
    const result = await manager.completeText({
      modelPrefId: input.modelPrefId,
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
    });
    return {
      ok: result.ok,
      ...(result.text === undefined ? {} : { text: result.text }),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  };
}
