import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  concludeIntent,
  configureDatabase,
  createIntent,
  createProject,
  heartbeatIntent,
  type CairnDatabase,
} from "@cairn/graph";

import { DEFAULT_VERIFICATION } from "../config";
import { VerificationService } from "../verification/oracle";
import { createApi, type Api } from "./api";

const WORKER = "cairn-worker";
const CONTENT = "probe result\n";

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-api-verification-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = createProjectRow();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createProjectRow(verification?: {
  kind: "challenge" | "evidence" | "off";
  challenge_code?: string | null;
}): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title: "verification",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
        verification,
      }).project.id,
  );
}

function addFact(projectId: string, evidence = true): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe",
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, WORKER);
    return concludeIntent(
      conn,
      projectId,
      intent.id,
      WORKER,
      "found",
      evidence
        ? {
            runId: "run_001",
            evidenceRefs: ["artifacts/probe.txt"],
            evidenceStatus: "provided",
            evidenceFiles: [
              {
                path: "artifacts/probe.txt",
                size: Buffer.byteLength(CONTENT),
                sha256: createHash("sha256").update(CONTENT).digest("hex"),
              },
            ],
          }
        : { evidenceStatus: "missing" },
    ).fact.id;
  });
}

function api(verification?: VerificationService): Api {
  return createApi({ db, ...(verification === undefined ? {} : { verification }) });
}

function post(instance: Api, path: string, body?: unknown): Promise<Response> {
  return instance.handle(
    new Request(`http://cairn.test${path}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    }),
  );
}

describe("POST /projects/{id}/verify", () => {
  test("verifies the default evidence policy and records the check", async () => {
    addFact(projectId);
    const service = api();

    const response = await post(service, `/projects/${projectId}/verify`, {});

    expect(response.status).toBe(200);
    const outcome = (await response.json()) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      project_id: projectId,
      kind: "evidence",
      ok: true,
      evidence_refs: ["artifacts/probe.txt"],
    });

    const view = (await (
      await service.handle(
        new Request(`http://cairn.test/projects/${projectId}/verification`),
      )
    ).json()) as { policy: Record<string, unknown>; latest: Record<string, unknown> };
    expect(view.policy).toMatchObject({ kind: "evidence", challenge_code: null });
    expect(view.latest).toMatchObject({ ok: true, kind: "evidence" });
  });

  test("accepts an explicit fact subset", async () => {
    const evidenced = addFact(projectId);
    const bare = addFact(projectId, false);

    const ok = await post(api(), `/projects/${projectId}/verify`, {
      facts: [evidenced],
    });
    expect(((await ok.json()) as Record<string, unknown>).ok).toBe(true);

    const failed = await post(api(), `/projects/${projectId}/verify`, {
      facts: [bare],
    });
    expect(((await failed.json()) as Record<string, unknown>).ok).toBe(false);
  });

  test("rejects malformed bodies", async () => {
    const service = api();
    expect(
      (await post(service, `/projects/${projectId}/verify`, { facts: [] })).status,
    ).toBe(400);
    expect(
      (await post(service, `/projects/${projectId}/verify`, { facts: [1] })).status,
    ).toBe(400);
    expect(
      (await post(service, `/projects/${projectId}/verify`, [])).status,
    ).toBe(400);
    expect(
      (await post(service, `/projects/${projectId}/verify`, "not json")).status,
    ).toBe(422);
  });

  test("404s for unknown projects", async () => {
    const response = await post(api(), "/projects/proj_999/verify", {});
    expect(response.status).toBe(404);
  });

  test("verifies challenge projects through the injected oracle", async () => {
    const challengeProject = createProjectRow({
      kind: "challenge",
      challenge_code: "web-01",
    });
    const service = new VerificationService(db, DEFAULT_VERIFICATION, {
      env: {
        TCH_CHALLENGE_API_BASE_URL: "https://challenge.test",
        TCH_CHALLENGE_AGENT_TOKEN: "secret-token",
      },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://challenge.test/api/challenges");
        expect(new Headers(init?.headers).get("Agent-Token")).toBe("secret-token");
        return new Response(
          JSON.stringify({
            code: 0,
            message: "ok",
            data: { challenges: [{ code: "web-01", flag_count: 2, flag_got_count: 2 }] },
          }),
          { status: 200 },
        );
      },
    });

    const response = await post(
      api(service),
      `/projects/${challengeProject}/verify`,
      {},
    );
    const outcome = (await response.json()) as Record<string, unknown>;

    expect(outcome).toMatchObject({
      kind: "challenge",
      challenge_code: "web-01",
      ok: true,
      flag_count: 2,
      flag_got_count: 2,
    });
    expect(JSON.stringify(outcome)).not.toContain("secret-token");
  });

  test("off projects verify without evidence", async () => {
    const offProject = createProjectRow({ kind: "off" });
    const response = await post(api(), `/projects/${offProject}/verify`, {});
    const outcome = (await response.json()) as Record<string, unknown>;

    expect(outcome).toMatchObject({ kind: "off", ok: true });
  });
});

describe("GET /projects/{id}/verification", () => {
  test("reports the policy and an empty history for a new project", async () => {
    const response = await api().handle(
      new Request(`http://cairn.test/projects/${projectId}/verification`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      policy: expect.objectContaining({
        project_id: projectId,
        kind: "evidence",
        challenge_code: null,
      }),
      latest: null,
    });
  });

  test("404s for unknown projects", async () => {
    const response = await api().handle(
      new Request("http://cairn.test/projects/proj_999/verification"),
    );
    expect(response.status).toBe(404);
  });
});
