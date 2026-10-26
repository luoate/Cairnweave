import { DEFAULT_INTENT_PRIORITY } from "@cairn/contracts";
import {
  HttpError,
  RequestValidationError,
  all,
  appendTaskAudit,
  buildProjectCostReport,
  checkProjectCompleted,
  checkProjectHintWritable,
  claimReason,
  clearProjectReason,
  completeProject,
  concludeIntent,
  createIntent,
  createProject,
  expireReasonLeases,
  exportProjectTimeline,
  exportProjectYaml,
  getAuditStreamLoss,
  getCompletionIntentOr409,
  getFactMeta,
  getLatestVerificationCheck,
  getProjectDetail,
  getProjectOr404,
  getProjectUsage,
  getProjectVerification,
  getStrategistState,
  getTaskAudit,
  heartbeatIntent,
  heartbeatReason,
  intentToModel,
  listFactEvidence,
  listProjectArtifacts,
  listProjectAudit,
  listProjectIntentMeta,
  listProjectProposals,
  listProjectRuns,
  listProjects,
  nextFactId,
  nextHintId,
  nextIntentId,
  parseCompleteRequest,
  parseConcludeRequest,
  parseCreateHintRequest,
  parseCreateIntentRequest,
  parseCreateProjectRequest,
  parseHeartbeatRequest,
  parseReasonClaimRequest,
  parseReopenRequest,
  parseSettings,
  parseUpdateProjectStatusRequest,
  parseUpdateProjectTitleRequest,
  projectMetaFromRow,
  recordFactMeta,
  releaseIntent,
  releaseReason,
  utcnow,
  type AuditEntry,
  type CairnDatabase,
  type IntentRow,
  type ProjectRow,
} from "@cairn/graph";
import { resolve, sep } from "node:path";

import type { AuditTokenRegistry } from "../audit-stream/tokens";
import { DEFAULT_VERIFICATION, type BudgetConfig } from "../config";
import { verifyEvidenceFiles } from "../scheduler/evidence";
import { projectWorkspace } from "../scheduler/tasks";
import { VerificationService } from "../verification/oracle";

export interface ApiOptions {
  db: CairnDatabase;
  /** Directory containing Cairn's static UI. When omitted only the JSON API is served. */
  staticDir?: string;
  /**
   * Host workspace root, present only when the scheduler is enabled. Evidence digests can
   * still be read without it, but live verification reports `unverified`.
   */
  workspaceRoot?: string;
  /** Enables the authenticated live audit append endpoint when provided. */
  auditTokens?: AuditTokenRegistry;
  /**
   * The scheduler's per-project budget policy. When omitted (pure HTTP mode) the
   * strategist view still reports recorded usage but returns null limits.
   */
  budget?: BudgetConfig;
  /** Completion oracle; defaults to the evidence policy and env-based challenge config. */
  verification?: VerificationService;
}

export interface Api {
  handle(request: Request): Promise<Response>;
}

interface RouteContext {
  params: Record<string, string>;
  url: URL;
  request: Request;
}

type RouteHandler = (context: RouteContext) => Promise<Response> | Response;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(value: string): Response {
  return new Response(value, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function parseVerifyFacts(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "verification body must be a JSON object");
  }
  const facts = (value as Record<string, unknown>)["facts"];
  if (facts === undefined || facts === null) return undefined;
  if (!Array.isArray(facts) || facts.length === 0) {
    throw new HttpError(400, "verification facts must be a non-empty array of fact ids");
  }
  return facts.map((fact, index) => {
    if (typeof fact !== "string" || fact.trim() === "") {
      throw new HttpError(
        400,
        `verification facts[${index}] must be a non-empty string`,
      );
    }
    return fact.trim();
  });
}

async function readBody(request: Request, maxBytes?: number): Promise<unknown> {
  const raw =
    maxBytes === undefined
      ? await request.text()
      : await readBoundedBody(request, maxBytes);
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestValidationError([
      {
        type: "json_invalid",
        loc: ["body", 0],
        msg: "JSON decode error",
        input: {},
      },
    ]);
  }
}

/**
 * Reads a request body without buffering more than `maxBytes`. A declared Content-Length
 * is rejected before the first read; a chunked body is aborted as soon as it crosses the
 * cap, so a client cannot force an unbounded allocation.
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      throw new HttpError(413, "Request body too large");
    }
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The peer may already have closed the stream.
        }
        throw new HttpError(413, "Request body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function requireAuditToken(
  request: Request,
  registry: AuditTokenRegistry,
  projectId: string,
  taskId: string,
): void {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  if (match === null || !registry.authenticate(match[1]!, projectId, taskId)) {
    throw new HttpError(401, "Invalid audit stream token");
  }
}

function parseAuditStreamBody(value: unknown): AuditEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "audit stream body must be a JSON object");
  }
  const events = (value as Record<string, unknown>)["events"];
  if (!Array.isArray(events)) {
    throw new HttpError(400, "audit stream events must be an array");
  }
  if (events.length === 0) {
    throw new HttpError(400, "audit stream events must not be empty");
  }
  if (events.length > MAX_AUDIT_STREAM_EVENTS) {
    throw new HttpError(
      400,
      `audit stream accepts at most ${MAX_AUDIT_STREAM_EVENTS} events per request`,
    );
  }
  return events.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new HttpError(400, `audit stream events[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (!("seq" in record) || !("event" in record)) {
      throw new HttpError(
        400,
        `audit stream events[${index}] must contain seq and event`,
      );
    }
    return { seq: record["seq"] as number, event: record["event"] };
  });
}

export function createApi(options: ApiOptions): Api {
  const { db, staticDir, workspaceRoot, auditTokens, budget } = options;
  const verification =
    options.verification ?? new VerificationService(db, DEFAULT_VERIFICATION);
  const routes = buildRoutes(db, workspaceRoot, auditTokens, budget, verification);

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let pathMatched = false;
    try {
      for (const route of routes) {
        const match = route.regex.exec(url.pathname);
        if (match === null) {
          continue;
        }
        pathMatched = true;
        if (route.method !== request.method) {
          continue;
        }
        const params: Record<string, string> = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? "");
        });
        return await route.handler({ params, url, request });
      }
      if (pathMatched) {
        return json({ detail: "Method Not Allowed" }, 405);
      }
      if (request.method === "GET" && staticDir !== undefined) {
        const staticResponse = await serveStatic(staticDir, url.pathname);
        if (staticResponse !== null) {
          return staticResponse;
        }
      }
      return json({ detail: "Not Found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ detail: error.detail }, error.status);
      }
      if (error instanceof RequestValidationError) {
        return json({ detail: error.issues }, 422);
      }
      console.error("[http] unhandled error", error);
      return json({ detail: "Internal Server Error" }, 500);
    }
  }

  return { handle };
}

async function serveStatic(staticDir: string, pathname: string): Promise<Response | null> {
  const root = resolve(staticDir);
  let relative: string;
  if (pathname === "/") {
    relative = "index.html";
  } else if (pathname.startsWith("/static/")) {
    relative = pathname.slice("/static/".length);
  } else {
    return null;
  }
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    return null;
  }
  const file = Bun.file(target);
  if (!(await file.exists())) {
    return null;
  }
  return new Response(file);
}

const MAX_AUDIT_STREAM_BODY_BYTES = 1024 * 1024;
const MAX_AUDIT_STREAM_EVENTS = 256;
const STRATEGIST_RUN_LIMIT_DEFAULT = 20;
const STRATEGIST_RUN_LIMIT_MAX = 100;

/**
 * `limit` bounds only the recent reason-run list. It is a single optional query parameter;
 * malformed or out-of-range values are rejected instead of silently clamped, so an
 * operator can tell a typo from an empty history.
 */
function parseStrategistLimit(raw: string | null): number {
  if (raw === null) return STRATEGIST_RUN_LIMIT_DEFAULT;
  if (!/^[0-9]+$/.test(raw)) {
    throw new HttpError(
      400,
      `limit must be an integer between 1 and ${STRATEGIST_RUN_LIMIT_MAX}`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > STRATEGIST_RUN_LIMIT_MAX) {
    throw new HttpError(
      400,
      `limit must be an integer between 1 and ${STRATEGIST_RUN_LIMIT_MAX}`,
    );
  }
  return parsed;
}

function buildRoutes(
  db: CairnDatabase,
  workspaceRoot?: string,
  auditTokens?: AuditTokenRegistry,
  budget?: BudgetConfig,
  verification?: VerificationService,
): Route[] {
  const routes: Route[] = [];
  const oracle = verification ?? new VerificationService(db, DEFAULT_VERIFICATION);

  function route(method: string, template: string, handler: RouteHandler): void {
    const keys: string[] = [];
    const source = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  }

  route("GET", "/settings", () =>
    db.withConn((conn) => {
      const row = conn
        .query("SELECT intent_timeout, reason_timeout FROM settings WHERE rowid = 1")
        .get() as { intent_timeout: number; reason_timeout: number } | null;
      if (row === null) {
        throw new Error("settings row is missing");
      }
      return json({ intent_timeout: row.intent_timeout, reason_timeout: row.reason_timeout });
    }),
  );

  route("PUT", "/settings", async ({ request }) => {
    const settings = parseSettings(await readBody(request));
    db.withConn((conn) => {
      conn
        .query("UPDATE settings SET intent_timeout = ?, reason_timeout = ? WHERE rowid = 1")
        .run(settings.intent_timeout, settings.reason_timeout);
    });
    return json(settings);
  });

  route("GET", "/projects", () =>
    db.withConn((conn) => json(listProjects(conn))),
  );

  route("POST", "/projects", async ({ request }) => {
    const body = parseCreateProjectRequest(await readBody(request));
    return db.withConn((conn) => json(createProject(conn, body), 201));
  });

  route("GET", "/projects/{project_id}", ({ params }) =>
    db.withConn((conn) => json(getProjectDetail(conn, params["project_id"]!))),
  );

  route("GET", "/projects/{project_id}/artifacts", ({ params }) =>
    db.withConn((conn) => {
      const projectId = params["project_id"]!;
      getProjectOr404(conn, projectId);
      return json(listProjectArtifacts(conn, projectId));
    }),
  );

  route("GET", "/projects/{project_id}/runs", ({ params }) =>
    db.withConn((conn) => json(listProjectRuns(conn, params["project_id"]!))),
  );

  // Read-only slow-layer view (M12c): persisted trigger watermarks, the effective
  // per-project budget, open intents in dispatch order, and recent reason runs.
  route("GET", "/projects/{project_id}/strategist", ({ params, url }) =>
    db.withConn((conn) => {
      const projectId = params["project_id"]!;
      getProjectOr404(conn, projectId);
      const limit = parseStrategistLimit(url.searchParams.get("limit"));

      const runs = listProjectRuns(conn, projectId);
      const usage = getProjectUsage(conn, projectId);
      const runningTasks = runs.reduce(
        (count, run) => count + (run.outcome === null ? 1 : 0),
        0,
      );
      const meta = new Map(
        listProjectIntentMeta(conn, projectId).map((entry) => [entry.intent_id, entry]),
      );
      const intents = getProjectDetail(conn, projectId).intents
        .filter((intent) => intent.to === null && intent.concluded_at === null)
        .map((intent) => {
          const extra = meta.get(intent.id);
          return {
            ...intent,
            priority: extra?.priority ?? DEFAULT_INTENT_PRIORITY,
            budget: extra?.budget ?? null,
            source: extra?.source ?? null,
          };
        })
        // Mirrors the scheduler's explore order: priority DESC, then newest first.
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            right.created_at.localeCompare(left.created_at) ||
            right.id.localeCompare(left.id),
        );

      const limits =
        budget === undefined
          ? null
          : {
              max_project_tokens: budget.maxProjectTokens,
              max_project_cost_usd: budget.maxProjectCostUsd,
              max_project_tasks: budget.maxProjectTasks,
            };
      const exhausted = {
        tokens:
          limits !== null &&
          limits.max_project_tokens > 0 &&
          usage.tokens >= limits.max_project_tokens,
        cost_usd:
          limits !== null &&
          limits.max_project_cost_usd > 0 &&
          usage.cost_usd >= limits.max_project_cost_usd,
        // max_project_tasks is a concurrency quota; 0 inherits runtime.max_project_workers,
        // which this HTTP-only view does not know, so it reports "not exhausted".
        tasks:
          limits !== null &&
          limits.max_project_tasks > 0 &&
          runningTasks >= limits.max_project_tasks,
      };

      return json({
        state: getStrategistState(conn, projectId),
        budget: {
          used_tokens: usage.tokens,
          used_cost_usd: usage.cost_usd,
          running_tasks: runningTasks,
          limits,
          exhausted,
        },
        intents,
        reason_runs: [...runs]
          .filter((run) => run.kind === "reason")
          .reverse()
          .slice(0, limit),
      });
    }),
  );

  // Read-only cost attribution and causal chain (M13b): which run paid for each fact,
  // which run created its intent, and how runs/intents/facts connect.
  route("GET", "/projects/{project_id}/cost", ({ params }) =>
    db.withConn((conn) => json(buildProjectCostReport(conn, params["project_id"]!))),
  );

  // Read-only: proposals are written by the scheduler from task-scoped candidate files.
  route("GET", "/projects/{project_id}/proposals", ({ params, url }) =>
    db.withConn((conn) => {
      const status = url.searchParams.get("status");
      if (
        status !== null &&
        !["pending", "applied", "rejected", "duplicate", "dry_run"].includes(status)
      ) {
        throw new HttpError(400, "Unsupported proposal status");
      }
      const kind = url.searchParams.get("kind");
      if (kind !== null && !["fact", "intent", "hint"].includes(kind)) {
        throw new HttpError(400, "Unsupported proposal kind");
      }
      return json(
        listProjectProposals(conn, params["project_id"]!, {
          ...(status === null ? {} : { status: status as "pending" | "applied" | "rejected" | "duplicate" | "dry_run" }),
          ...(kind === null ? {} : { kind: kind as "fact" | "intent" | "hint" }),
        }),
      );
    }),
  );

  route("GET", "/projects/{project_id}/audit", ({ params }) =>
    db.withConn((conn) => json(listProjectAudit(conn, params["project_id"]!))),
  );

  route("GET", "/projects/{project_id}/audit/{task_id}", ({ params }) =>
    db.withConn((conn) =>
      json(getTaskAudit(conn, params["project_id"]!, params["task_id"]!)),
    ),
  );

  route("GET", "/projects/{project_id}/audit/{task_id}/stream-lost", ({ params }) =>
    db.withConn((conn) => {
      const taskId = params["task_id"]!;
      return json({
        task_id: taskId,
        stream_lost: getAuditStreamLoss(conn, params["project_id"]!, taskId),
      });
    }),
  );

  if (auditTokens !== undefined) {
    route("POST", "/projects/{project_id}/tasks/{task_id}/audit", async ({ params, request }) => {
      const projectId = params["project_id"]!;
      const taskId = params["task_id"]!;
      // Authenticate before reading the body: an unauthorized caller gets no parsing work
      // and no information about the ledger.
      requireAuditToken(request, auditTokens, projectId, taskId);
      const entries = parseAuditStreamBody(
        await readBody(request, MAX_AUDIT_STREAM_BODY_BYTES),
      );
      return db.withConn((conn) => {
        // Live appends are strict: a gap or fork must be reported so the worker stops and
        // leaves the rest to the finish-time import.
        const result = appendTaskAudit(conn, {
          projectId,
          taskId,
          entries,
          onConflict: "throw",
        });
        return json({ recorded: result.recorded, duplicates: result.duplicates });
      });
    });
  }

  route("GET", "/projects/{project_id}/facts/{fact_id}/meta", ({ params }) => {
    const meta = db.withConn((conn) =>
      getFactMeta(conn, params["project_id"]!, params["fact_id"]!),
    );
    if (meta === null) {
      throw new HttpError(404, "Fact not found");
    }
    return json(meta);
  });

  route("GET", "/projects/{project_id}/facts/{fact_id}/evidence", ({ params }) => {
    const projectId = params["project_id"]!;
    const factId = params["fact_id"]!;
    const files = db.withConn((conn) => listFactEvidence(conn, projectId, factId));
    if (files === null) {
      throw new HttpError(404, "Fact not found");
    }
    if (workspaceRoot === undefined) {
      return json(
        files.map((file) => ({
          ...file,
          status: "unverified" as const,
          current_size: null,
          current_sha256: null,
        })),
      );
    }
    return json(verifyEvidenceFiles(files, projectWorkspace(workspaceRoot, projectId)));
  });

  route("DELETE", "/projects/{project_id}", ({ params }) =>
    db.withConn((conn) => {
      const projectId = params["project_id"]!;
      getProjectOr404(conn, projectId);
      conn.query("DELETE FROM projects WHERE id = ?").run(projectId);
      // Starlette keeps the JSON media type on an empty 204 response.
      return new Response(null, {
        status: 204,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  route("PUT", "/projects/{project_id}/title", async ({ params, request }) => {
    const body = parseUpdateProjectTitleRequest(await readBody(request));
    return db.withConn((conn) => {
      const projectId = params["project_id"]!;
      getProjectOr404(conn, projectId);
      conn.query("UPDATE projects SET title = ? WHERE id = ?").run(body.title, projectId);
      const updated = conn
        .query("SELECT * FROM projects WHERE id = ?")
        .get(projectId) as ProjectRow;
      return json(projectMetaFromRow(updated));
    });
  });

  route("PUT", "/projects/{project_id}/status", async ({ params, request }) => {
    const body = parseUpdateProjectStatusRequest(await readBody(request));
    return db.withConn((conn) => {
      const projectId = params["project_id"]!;
      expireReasonLeases(conn, projectId);
      const row = getProjectOr404(conn, projectId);
      if (row.status === "completed") {
        throw new HttpError(409, "Completed projects cannot change status");
      }
      if (row.status === body.status) {
        return json(projectMetaFromRow(row));
      }

      conn.query("UPDATE projects SET status = ? WHERE id = ?").run(body.status, projectId);
      if (body.status === "stopped") {
        conn
          .query(
            "UPDATE intents SET worker = NULL WHERE project_id = ? AND concluded_at IS NULL",
          )
          .run(projectId);
        clearProjectReason(conn, projectId);
      }
      const updated = conn
        .query("SELECT * FROM projects WHERE id = ?")
        .get(projectId) as ProjectRow;
      return json(projectMetaFromRow(updated));
    });
  });

  route("POST", "/projects/{project_id}/reason/claim", async ({ params, request }) => {
    const body = parseReasonClaimRequest(await readBody(request));
    return db.withConn((conn) =>
      json(claimReason(conn, params["project_id"]!, body.worker, body.trigger)),
    );
  });

  route("POST", "/projects/{project_id}/reason/heartbeat", async ({ params, request }) => {
    const body = parseHeartbeatRequest(await readBody(request));
    return db.withConn((conn) =>
      json(heartbeatReason(conn, params["project_id"]!, body.worker)),
    );
  });

  route("POST", "/projects/{project_id}/reason/release", async ({ params, request }) => {
    const body = parseHeartbeatRequest(await readBody(request));
    return db.withConn((conn) =>
      json(releaseReason(conn, params["project_id"]!, body.worker)),
    );
  });

  route("POST", "/projects/{project_id}/complete", async ({ params, request }) => {
    const body = parseCompleteRequest(await readBody(request));
    return db.withConn((conn) =>
      json(completeProject(conn, params["project_id"]!, body)),
    );
  });

  route("POST", "/projects/{project_id}/verify", async ({ params, request }) => {
    const facts = parseVerifyFacts(await readBody(request));
    const outcome = await oracle.verify(
      params["project_id"]!,
      facts === undefined ? {} : { facts },
    );
    return json(outcome);
  });

  route("GET", "/projects/{project_id}/verification", ({ params }) =>
    db.withConn((conn) => {
      const projectId = params["project_id"]!;
      return json({
        policy: getProjectVerification(conn, projectId),
        latest: getLatestVerificationCheck(conn, projectId),
      });
    }),
  );

  route("POST", "/projects/{project_id}/reopen", async ({ params, request }) => {
    const body = parseReopenRequest(await readBody(request));
    return db.withConn((conn) => {
      const projectId = params["project_id"]!;
      expireReasonLeases(conn, projectId);
      checkProjectCompleted(conn, projectId);
      const completion = getCompletionIntentOr409(conn, projectId);

      const sourceRows = all<{ fact_id: string }>(
        conn,
        "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
        completion.id,
        projectId,
      );
      const sourceIds = sourceRows.map((row) => row.fact_id);
      if (sourceIds.length === 0) {
        throw new HttpError(409, "Completion intent is missing its source facts");
      }

      const now = utcnow();
      const factId = nextFactId(conn, projectId);
      const intentId = nextIntentId(conn, projectId);

      conn
        .query("DELETE FROM intents WHERE id = ? AND project_id = ?")
        .run(completion.id, projectId);
      conn
        .query("INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)")
        .run(factId, projectId, body.description);
      recordFactMeta(conn, {
        projectId,
        factId,
        evidenceStatus: "missing",
        createdAt: now,
      });
      conn
        .query(
          "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          intentId,
          projectId,
          factId,
          "external_feedback",
          body.creator,
          body.creator,
          now,
          now,
          now,
        );
      for (const sourceId of sourceIds) {
        conn
          .query(
            "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
          )
          .run(intentId, projectId, sourceId);
      }
      clearProjectReason(conn, projectId);
      conn.query("UPDATE projects SET status = 'active' WHERE id = ?").run(projectId);

      const updatedProject = conn
        .query("SELECT * FROM projects WHERE id = ?")
        .get(projectId) as ProjectRow;
      const updatedIntent = conn
        .query("SELECT * FROM intents WHERE id = ? AND project_id = ?")
        .get(intentId, projectId) as IntentRow;

      return json({
        project: projectMetaFromRow(updatedProject),
        fact: { id: factId, description: body.description },
        intent: intentToModel(conn, updatedIntent, projectId),
      });
    });
  });

  route("POST", "/projects/{project_id}/intents", async ({ params, request }) => {
    const body = parseCreateIntentRequest(await readBody(request));
    return db.withConn((conn) =>
      json(createIntent(conn, params["project_id"]!, body), 201),
    );
  });

  route(
    "POST",
    "/projects/{project_id}/intents/{intent_id}/heartbeat",
    async ({ params, request }) => {
      const body = parseHeartbeatRequest(await readBody(request));
      return db.withConn((conn) =>
        json(
          heartbeatIntent(
            conn,
            params["project_id"]!,
            params["intent_id"]!,
            body.worker,
          ),
        ),
      );
    },
  );

  route(
    "POST",
    "/projects/{project_id}/intents/{intent_id}/release",
    async ({ params, request }) => {
      const body = parseHeartbeatRequest(await readBody(request));
      return db.withConn((conn) =>
        json(
          releaseIntent(
            conn,
            params["project_id"]!,
            params["intent_id"]!,
            body.worker,
          ),
        ),
      );
    },
  );

  route(
    "POST",
    "/projects/{project_id}/intents/{intent_id}/conclude",
    async ({ params, request }) => {
      const body = parseConcludeRequest(await readBody(request));
      return db.withConn((conn) =>
        json(
          concludeIntent(
            conn,
            params["project_id"]!,
            params["intent_id"]!,
            body.worker,
            body.description,
          ),
        ),
      );
    },
  );

  route("POST", "/projects/{project_id}/hints", async ({ params, request }) => {
    const body = parseCreateHintRequest(await readBody(request));
    return db.withConn((conn) => {
      const projectId = params["project_id"]!;
      checkProjectHintWritable(conn, projectId);

      const now = utcnow();
      const hintId = nextHintId(conn, projectId);
      conn
        .query(
          "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(hintId, projectId, body.content, body.creator, now);
      return json(
        { id: hintId, content: body.content, creator: body.creator, created_at: now },
        201,
      );
    });
  });

  route("GET", "/projects/{project_id}/export", ({ params, url }) =>
    db.withConn((conn) => {
      const projectId = params["project_id"]!;
      const format = url.searchParams.get("format") ?? "yaml";
      if (format !== "yaml" && format !== "timeline") {
        throw new HttpError(400, "Supported formats: yaml, timeline");
      }
      const body =
        format === "timeline"
          ? exportProjectTimeline(conn, projectId)
          : exportProjectYaml(conn, projectId);
      return text(body);
    }),
  );

  return routes;
}
