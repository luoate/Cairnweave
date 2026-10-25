import {
  HttpError,
  RequestValidationError,
  all,
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
  getCompletionIntentOr409,
  getFactMeta,
  getProjectDetail,
  getProjectOr404,
  heartbeatIntent,
  heartbeatReason,
  intentToModel,
  listFactEvidence,
  listProjectArtifacts,
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
  type CairnDatabase,
  type IntentRow,
  type ProjectRow,
} from "@cairn/graph";
import { resolve, sep } from "node:path";

import { verifyEvidenceFiles } from "../scheduler/evidence";
import { projectWorkspace } from "../scheduler/tasks";

export interface ApiOptions {
  db: CairnDatabase;
  /** Directory containing Cairn's static UI. When omitted only the JSON API is served. */
  staticDir?: string;
  /**
   * Host workspace root, present only when the scheduler is enabled. Evidence digests can
   * still be read without it, but live verification reports `unverified`.
   */
  workspaceRoot?: string;
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

async function readBody(request: Request): Promise<unknown> {
  const raw = await request.text();
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

export function createApi(options: ApiOptions): Api {
  const { db, staticDir, workspaceRoot } = options;
  const routes = buildRoutes(db, workspaceRoot);

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

function buildRoutes(db: CairnDatabase, workspaceRoot?: string): Route[] {
  const routes: Route[] = [];

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
