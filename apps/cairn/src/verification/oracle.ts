/**
 * Completion oracle.
 *
 * A worker saying "done" is a claim, not a fact. The control plane only completes a
 * project after this service confirms the claim:
 *
 * - `challenge`: the external challenge service reports every flag obtained. Flag values
 *   never enter the control plane, task files or logs; only counts are recorded.
 * - `evidence`: every completing fact has at least one recorded evidence file.
 * - `off`: explicit legacy escape hatch for imported projects.
 *
 * Verification failures are recorded too, so the UI and `/verify` can explain why a
 * project is still active. The service fails closed: a missing challenge endpoint,
 * malformed response, empty fact set or unreachable API is never a pass.
 */

import type { CairnDatabase } from "@cairn/graph";
import {
  getFactMeta,
  getProjectVerification,
  listFactEvidence,
  recordVerificationCheck,
  type ProjectVerification,
  type VerificationCheck,
  type VerificationKind,
} from "@cairn/graph";

import {
  defaultVerificationKind,
  defaultVerificationPolicy,
  type DefaultVerificationPolicy,
  type VerificationConfig,
} from "../config";

export interface VerificationOptions {
  /** Fact ids that justify completion. Defaults to every non-seed fact. */
  facts?: readonly string[];
  /**
   * Evidence collected from the completing task itself. Bootstrap completes a fact that
   * does not exist yet, so it is checked against the task-level evidence instead.
   */
  taskEvidence?: {
    status: "provided" | "missing";
    refs: readonly string[];
  };
}

export interface VerificationOutcome {
  project_id: string;
  kind: VerificationKind;
  ok: boolean;
  detail: string;
  challenge_code: string | null;
  flag_count: number | null;
  flag_got_count: number | null;
  evidence_refs: string[];
  checked_at: string;
  check: VerificationCheck;
}

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => Promise<Response>;

interface EvidenceGap {
  factId: string;
  reason: string;
}

interface ChallengeListData {
  challenges: Array<{
    title?: unknown;
    code?: unknown;
    flag_count?: unknown;
    flag_got_count?: unknown;
  }>;
}

interface ChallengeEnvelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

export class VerificationService {
  private readonly fetchImpl: FetchLike;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly db: CairnDatabase,
    private readonly config: VerificationConfig,
    options: {
      fetch?: FetchLike;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
  }

  /**
   * Policy used for projects created before `project_verification` existed. Read through
   * the shared config so a runtime override applies without restarting the server.
   */
  get defaultKind(): "evidence" | "off" {
    return defaultVerificationKind(this.config);
  }

  /**
   * Policy used when a project is created without an explicit `verification` field.
   * A challenge environment supplies the code automatically.
   */
  defaultPolicy(): DefaultVerificationPolicy {
    return defaultVerificationPolicy(this.config, this.env);
  }

  async verify(
    projectId: string,
    options: VerificationOptions = {},
  ): Promise<VerificationOutcome> {
    const policy = this.db.withConn((conn) =>
      getProjectVerification(conn, projectId, this.defaultKind),
    );
    const checkedAt = new Date().toISOString();

    let result: {
      ok: boolean;
      detail: string;
      flagCount: number | null;
      flagGotCount: number | null;
      evidenceRefs: string[];
    };

    switch (policy.kind) {
      case "off":
        result = {
          ok: true,
          detail: "verification is disabled for this project",
          flagCount: null,
          flagGotCount: null,
          evidenceRefs: [],
        };
        break;
      case "evidence":
        result = this.checkEvidence(projectId, options);
        break;
      case "challenge":
        result = await this.checkChallenge(policy);
        break;
    }

    const check = this.db.withConn((conn) =>
      recordVerificationCheck(conn, {
        projectId,
        kind: policy.kind,
        ok: result.ok,
        detail: result.detail,
        challengeCode: policy.challenge_code,
        flagCount: result.flagCount,
        flagGotCount: result.flagGotCount,
        evidenceRefs: result.evidenceRefs,
        checkedAt,
      }),
    );
    return {
      project_id: projectId,
      kind: policy.kind,
      ok: result.ok,
      detail: result.detail,
      challenge_code: policy.challenge_code,
      flag_count: result.flagCount,
      flag_got_count: result.flagGotCount,
      evidence_refs: result.evidenceRefs,
      checked_at: checkedAt,
      check,
    };
  }

  private checkEvidence(
    projectId: string,
    options: VerificationOptions,
  ): {
    ok: boolean;
    detail: string;
    flagCount: null;
    flagGotCount: null;
    evidenceRefs: string[];
  } {
    if (options.facts === undefined && options.taskEvidence !== undefined) {
      const provided =
        options.taskEvidence.status === "provided" && options.taskEvidence.refs.length > 0;
      return {
        ok: provided,
        detail: provided
          ? `task recorded ${options.taskEvidence.refs.length} evidence file(s)`
          : "the completing task did not record any evidence",
        flagCount: null,
        flagGotCount: null,
        evidenceRefs: [...options.taskEvidence.refs],
      };
    }
    const requested = options.facts;
    const snapshot = this.db.withConn((conn) => {
      // Seed facts are premises, not produced evidence. A completion claim may include
      // them (for example `from: ["origin", "f003"]`), but only non-seed facts are checked.
      const factIds =
        requested === undefined
          ? (
              conn
                .query(
                  "SELECT id FROM facts WHERE project_id = ? AND id NOT IN ('origin', 'goal') ORDER BY rowid",
                )
                .all(projectId) as Array<{ id: string }>
            ).map((row) => row.id)
          : requested.filter((factId) => factId !== "origin" && factId !== "goal");
      const gaps: EvidenceGap[] = [];
      const refs: string[] = [];
      for (const factId of factIds) {
        const meta = getFactMeta(conn, projectId, factId);
        if (meta === null) {
          gaps.push({ factId, reason: "fact does not exist" });
          continue;
        }
        // Superseded facts stay in the append-only graph but must not justify
        // completion; the model should cite the replacement instead.
        if (meta.superseded_by !== null) {
          gaps.push({ factId, reason: `fact was superseded by ${meta.superseded_by}` });
          continue;
        }
        const files = listFactEvidence(conn, projectId, factId);
        if (meta.evidence_status !== "provided") {
          gaps.push({ factId, reason: `evidence status is ${meta.evidence_status}` });
          continue;
        }
        if (meta.run_id === null) {
          gaps.push({ factId, reason: "fact is not linked to a run" });
          continue;
        }
        if (meta.evidence_refs.length === 0) {
          gaps.push({ factId, reason: "no evidence refs were recorded" });
          continue;
        }
        if (files === null || files.length === 0) {
          gaps.push({ factId, reason: "no evidence files were recorded" });
          continue;
        }
        refs.push(...files.map((file) => file.path));
      }
      return { factIds, gaps, refs };
    });

    if (snapshot.factIds.length === 0) {
      return {
        ok: false,
        detail: "no non-seed facts are available to evidence completion",
        flagCount: null,
        flagGotCount: null,
        evidenceRefs: [],
      };
    }
    if (snapshot.gaps.length > 0) {
      return {
        ok: false,
        detail: `missing evidence for ${snapshot.gaps
          .map((gap) => `${gap.factId} (${gap.reason})`)
          .join(", ")}`,
        flagCount: null,
        flagGotCount: null,
        evidenceRefs: snapshot.refs,
      };
    }
    return {
      ok: true,
      detail: `${snapshot.factIds.length} fact(s) have recorded evidence`,
      flagCount: null,
      flagGotCount: null,
      evidenceRefs: snapshot.refs,
    };
  }

  private async checkChallenge(policy: ProjectVerification): Promise<{
    ok: boolean;
    detail: string;
    flagCount: number | null;
    flagGotCount: number | null;
    evidenceRefs: string[];
  }> {
    const code = policy.challenge_code;
    if (code === null || code.trim() === "") {
      return challengeFailure("challenge verification requires a challenge_code");
    }
    const { baseUrlEnv, agentTokenEnv, timeoutMs } = this.config.challenge;
    const baseUrl = this.env[baseUrlEnv]?.trim() ?? "";
    const agentToken = this.env[agentTokenEnv]?.trim() ?? "";
    if (baseUrl === "") {
      return challengeFailure(`challenge API base URL is not set (${baseUrlEnv})`);
    }
    if (agentToken === "") {
      return challengeFailure(`challenge API token is not set (${agentTokenEnv})`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(challengeUrl(baseUrl), {
        method: "GET",
        headers: { "Agent-Token": agentToken },
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? `challenge API timed out after ${timeoutMs}ms`
          : `challenge API request failed: ${error instanceof Error ? error.message : String(error)}`;
      return challengeFailure(reason);
    } finally {
      clearTimeout(timer);
    }

    let envelope: ChallengeEnvelope;
    try {
      envelope = (await response.json()) as ChallengeEnvelope;
    } catch {
      return challengeFailure(`challenge API returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      return challengeFailure(
        `challenge API returned HTTP ${response.status}: ${messageOf(envelope)}`,
      );
    }
    if (envelope.code !== 0) {
      return challengeFailure(`challenge API rejected the request: ${messageOf(envelope)}`);
    }
    const data = asChallengeList(envelope.data);
    if (data === null) {
      return challengeFailure("challenge API returned an invalid challenge list");
    }
    const challenge = data.challenges.find(
      (entry) => typeof entry.code === "string" && entry.code === code,
    );
    if (challenge === undefined) {
      return challengeFailure(`challenge "${code}" was not found`);
    }
    const flagCount = nonNegativeInteger(challenge.flag_count);
    const flagGotCount = nonNegativeInteger(challenge.flag_got_count);
    if (flagCount === null || flagGotCount === null) {
      return challengeFailure(`challenge "${code}" returned invalid flag counters`);
    }
    if (flagCount <= 0) {
      return challengeFailure(`challenge "${code}" has no flags to verify`);
    }
    if (flagGotCount !== flagCount) {
      return {
        ok: false,
        detail: `challenge "${code}" has ${flagGotCount}/${flagCount} flags`,
        flagCount,
        flagGotCount,
        evidenceRefs: [],
      };
    }
    return {
      ok: true,
      detail: `challenge "${code}" has all ${flagCount} flag(s)`,
      flagCount,
      flagGotCount,
      evidenceRefs: [],
    };
  }
}

function challengeFailure(detail: string): {
  ok: false;
  detail: string;
  flagCount: null;
  flagGotCount: null;
  evidenceRefs: string[];
} {
  return { ok: false, detail, flagCount: null, flagGotCount: null, evidenceRefs: [] };
}

function challengeUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const root = trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
  return `${root}/challenges`;
}

function messageOf(envelope: ChallengeEnvelope): string {
  return typeof envelope.message === "string" && envelope.message.trim() !== ""
    ? envelope.message.trim()
    : "unknown error";
}

function asChallengeList(value: unknown): ChallengeListData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const challenges = (value as { challenges?: unknown }).challenges;
  if (!Array.isArray(challenges)) return null;
  return {
    challenges: challenges.filter(
      (entry): entry is ChallengeListData["challenges"][number] =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    ),
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
