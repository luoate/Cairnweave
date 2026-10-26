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
import { VerificationService } from "./oracle";

const WORKER = "cairn-worker";
const CONTENT = "captured probe output\n";

let directory: string;
let db: CairnDatabase;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-oracle-"));
  db = configureDatabase(join(directory, "cairn.db"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function createRow(
  verification?: { kind: "challenge" | "evidence" | "off"; challenge_code?: string | null },
): string {
  return db.withConn(
    (conn) =>
      createProject(conn, {
        title: "oracle",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
        verification,
      }).project.id,
  );
}

function addFact(
  projectId: string,
  options: { evidence: boolean; status?: "provided" | "missing" } = { evidence: true },
): string {
  return db.withConn((conn) => {
    const intent = createIntent(conn, projectId, {
      from: ["origin"],
      description: "probe",
      creator: "tester",
      worker: null,
    });
    heartbeatIntent(conn, projectId, intent.id, WORKER);
    const evidence = options.evidence
      ? {
          runId: "run_001",
          evidenceRefs: ["artifacts/probe.txt"],
          evidenceStatus: "provided" as const,
          evidenceFiles: [
            {
              path: "artifacts/probe.txt",
              size: Buffer.byteLength(CONTENT),
              sha256: createHash("sha256").update(CONTENT).digest("hex"),
            },
          ],
        }
      : { evidenceStatus: options.status ?? ("missing" as const) };
    return concludeIntent(conn, projectId, intent.id, WORKER, "found", evidence).fact.id;
  });
}

function service(
  options: NonNullable<ConstructorParameters<typeof VerificationService>[2]> = {},
): VerificationService {
  return new VerificationService(db, DEFAULT_VERIFICATION, options);
}

function challengeEnvelope(challenges: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ code: 0, message: "ok", data: { challenges } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const CHALLENGE_ENV = {
  TCH_CHALLENGE_API_BASE_URL: "https://challenge.test/root/",
  TCH_CHALLENGE_AGENT_TOKEN: "agent-token-value",
};

describe("evidence verification", () => {
  test("passes when every completing fact has evidence", async () => {
    const projectId = createRow();
    const factId = addFact(projectId);

    const outcome = await service().verify(projectId, { facts: [factId] });

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe("evidence");
    expect(outcome.evidence_refs).toEqual(["artifacts/probe.txt"]);
    expect(outcome.check.ok).toBe(true);
  });

  test("fails and records the gap when evidence is missing", async () => {
    const projectId = createRow();
    const factId = addFact(projectId, { evidence: false });

    const outcome = await service().verify(projectId);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(factId);
    expect(outcome.detail).toContain("evidence status is missing");
    expect(outcome.check.ok).toBe(false);
  });

  test("fails when explicitly completing from a fact without evidence", async () => {
    const projectId = createRow();
    const evidenced = addFact(projectId);
    const bare = addFact(projectId, { evidence: false });

    expect((await service().verify(projectId, { facts: [evidenced] })).ok).toBe(true);
    expect((await service().verify(projectId, { facts: [bare] })).ok).toBe(false);
  });

  test("fails when there are no non-seed facts to evidence", async () => {
    const projectId = createRow();
    const outcome = await service().verify(projectId);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("no non-seed facts");
  });

  test("checks bootstrap completion against the task-level evidence", async () => {
    const projectId = createRow();

    const missing = await service().verify(projectId, {
      taskEvidence: { status: "missing", refs: [] },
    });
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("did not record any evidence");

    const provided = await service().verify(projectId, {
      taskEvidence: { status: "provided", refs: ["artifacts/bootstrap.txt"] },
    });
    expect(provided.ok).toBe(true);
    expect(provided.evidence_refs).toEqual(["artifacts/bootstrap.txt"]);
  });

  test("passes without facts when verification is off", async () => {
    const projectId = createRow({ kind: "off" });
    const outcome = await service().verify(projectId);

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe("off");
  });
});

describe("challenge verification", () => {
  test("requires all flags from the configured challenge API", async () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const oracle = service({
      env: CHALLENGE_ENV,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return challengeEnvelope([
          { code: "web-01", flag_count: 3, flag_got_count: 2 },
          { code: "web-02", flag_count: 1, flag_got_count: 1 },
        ]);
      },
    });

    const outcome = await oracle.verify(projectId);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('challenge "web-01" has 2/3 flags');
    expect(outcome.flag_count).toBe(3);
    expect(outcome.flag_got_count).toBe(2);

    const fetched = calls[0]!;
    expect(fetched.url).toBe("https://challenge.test/root/api/challenges");
    expect(new Headers(fetched.init?.headers).get("Agent-Token")).toBe(
      "agent-token-value",
    );
    expect(JSON.stringify(outcome)).not.toContain("agent-token-value");
  });

  test("passes only when every flag was obtained", async () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });
    const oracle = service({
      env: { ...CHALLENGE_ENV, TCH_CHALLENGE_API_BASE_URL: "https://challenge.test/api" },
      fetch: async (input) => {
        expect(String(input)).toBe("https://challenge.test/api/challenges");
        return challengeEnvelope([
          { code: "web-01", flag_count: 3, flag_got_count: 3 },
        ]);
      },
    });

    const outcome = await oracle.verify(projectId);

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe('challenge "web-01" has all 3 flag(s)');
  });

  test("fails closed when the environment is incomplete", async () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });

    const noBase = await service({ env: {}, fetch: async () => challengeEnvelope([]) })
      .verify(projectId);
    expect(noBase.ok).toBe(false);
    expect(noBase.detail).toContain("TCH_CHALLENGE_API_BASE_URL");

    const noToken = await service({
      env: { TCH_CHALLENGE_API_BASE_URL: "https://challenge.test" },
      fetch: async () => challengeEnvelope([]),
    }).verify(projectId);
    expect(noToken.ok).toBe(false);
    expect(noToken.detail).toContain("TCH_CHALLENGE_AGENT_TOKEN");
  });

  test("fails closed on transport, HTTP and envelope errors", async () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });

    const transport = await service({
      env: CHALLENGE_ENV,
      fetch: async () => {
        throw new Error("connection refused");
      },
    }).verify(projectId);
    expect(transport.ok).toBe(false);
    expect(transport.detail).toContain("connection refused");

    const http = await service({
      env: CHALLENGE_ENV,
      fetch: async () =>
        new Response(JSON.stringify({ code: 1, message: "denied" }), { status: 401 }),
    }).verify(projectId);
    expect(http.ok).toBe(false);
    expect(http.detail).toContain("HTTP 401");

    const envelope = await service({
      env: CHALLENGE_ENV,
      fetch: async () =>
        new Response(JSON.stringify({ code: 2, message: "bad token" }), { status: 200 }),
    }).verify(projectId);
    expect(envelope.ok).toBe(false);
    expect(envelope.detail).toContain("bad token");
  });

  test("rejects missing challenges, bad counters and empty challenges", async () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });

    const missing = await service({
      env: CHALLENGE_ENV,
      fetch: async () => challengeEnvelope([{ code: "other", flag_count: 1, flag_got_count: 1 }]),
    }).verify(projectId);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("was not found");

    const invalid = await service({
      env: CHALLENGE_ENV,
      fetch: async () =>
        challengeEnvelope([{ code: "web-01", flag_count: "3", flag_got_count: 3 }]),
    }).verify(projectId);
    expect(invalid.ok).toBe(false);
    expect(invalid.detail).toContain("invalid flag counters");

    const empty = await service({
      env: CHALLENGE_ENV,
      fetch: async () => challengeEnvelope([{ code: "web-01", flag_count: 0, flag_got_count: 0 }]),
    }).verify(projectId);
    expect(empty.ok).toBe(false);
    expect(empty.detail).toContain("no flags to verify");
  });

  test("rejects challenge verification without a challenge code", async () => {
    const projectId = createRow({ kind: "challenge", challenge_code: "web-01" });
    db.withConn((conn) =>
      conn
        .query("UPDATE project_verification SET challenge_code = NULL WHERE project_id = ?")
        .run(projectId),
    );

    const outcome = await service({
      env: CHALLENGE_ENV,
      fetch: async () => challengeEnvelope([]),
    }).verify(projectId);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("challenge_code");
  });
});
