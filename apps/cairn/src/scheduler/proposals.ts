/**
 * Proposal ingestion and review.
 *
 * The Observer sidecar writes candidate JSON files under the task's session directory.
 * The control plane reads them after the worker exits, validates the untrusted payload,
 * checks evidence and dedupe, and only then applies a change through the normal graph
 * commands. Candidates never enter `facts` / `intents` / `hints` directly.
 */

import {
  HttpError,
  checkProjectActive,
  concludeIntent,
  createHint,
  createIntent,
  createProposal,
  findAppliedProposalByDedupeKey,
  findFactByDescription,
  findHintByContent,
  findOpenIntentByDedupeKey,
  listFactSupersessions,
  listPendingProposals,
  recordIntentMeta,
  recordProposalDecision,
  utcnow,
  validateFactsExist,
  validateGoalNotInSources,
  type CairnDatabase,
  type Proposal,
  type ProposalKind,
} from "@cairn/graph";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DispatchConfig } from "../config";
import { collectEvidence } from "./evidence";

const CANDIDATE_VERSION = 1;
const MAX_TEXT_CHARS = 1000;
const MAX_DEDUPE_KEY_CHARS = 128;
const MAX_FROM_FACTS = 20;
const MAX_EVIDENCE_REFS = 20;
const MAX_EVIDENCE_REF_CHARS = 512;
const MAX_SUPERSEDES = 20;
const OBSERVER_CREATOR = "observer";

export interface ProposalIngestInput {
  projectId: string;
  taskId: string;
  runId: string;
  /** Host-side task session directory. */
  sessionDir: string;
}

export interface ProposalIngestSummary {
  status: "disabled" | "absent" | "unreadable" | "read";
  ingested: number;
  skipped: number;
  issues: string[];
}

export interface ProposalReviewSummary {
  applied: number;
  rejected: number;
  duplicate: number;
  dryRun: number;
  skipped: number;
}

interface Candidate {
  id: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  evidenceRefs: string[];
}

/** Reads `<sessionDir>/observer/proposals/*.json` into the `proposals` sidecar table. */
export function ingestTaskProposals(
  db: CairnDatabase,
  config: DispatchConfig,
  input: ProposalIngestInput,
): ProposalIngestSummary {
  const summary: ProposalIngestSummary = {
    status: "disabled",
    ingested: 0,
    skipped: 0,
    issues: [],
  };
  if (
    !config.proposals.enabled ||
    config.proposals.mode === "off" ||
    config.proposals.maxPerTask === 0 ||
    config.proposals.allowKinds.length === 0
  ) {
    return summary;
  }

  const dir = join(input.sessionDir, "observer", "proposals");
  let names: string[];
  try {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      summary.status = "unreadable";
      summary.issues.push("proposal directory is not a regular directory");
      return summary;
    }
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    summary.status = isMissing(error) ? "absent" : "unreadable";
    if (summary.status === "unreadable") {
      summary.issues.push(describe(error));
    }
    return summary;
  }

  summary.status = "read";
  let totalBytes = 0;
  let considered = 0;
  for (const name of names) {
    if (considered >= config.proposals.maxPerTask) {
      summary.skipped += 1;
      continue;
    }
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name) || name.startsWith(".")) {
      summary.skipped += 1;
      continue;
    }
    const path = join(dir, name);
    const read = readBoundedFile(path, config.proposals.maxFileBytes);
    if ("reason" in read) {
      summary.skipped += 1;
      summary.issues.push(`${name}: ${read.reason}`);
      continue;
    }
    considered += 1;
    totalBytes += read.bytes;
    if (totalBytes > config.proposals.maxTotalBytes) {
      summary.skipped += 1;
      summary.issues.push(`${name}: proposal budget exceeded`);
      continue;
    }

    const parsed = parseCandidate(read.text, config);
    if ("reason" in parsed) {
      summary.skipped += 1;
      summary.issues.push(`${name}: ${parsed.reason}`);
      continue;
    }

    const inserted = db.withConn((conn) =>
      createProposal(conn, {
        id: proposalIdFor(input.projectId, input.taskId, name),
        projectId: input.projectId,
        taskId: input.taskId,
        runId: input.runId,
        source: "observer",
        kind: parsed.candidate.kind,
        payload: parsed.candidate.payload,
        dedupeKey: parsed.candidate.dedupeKey,
        evidenceRefs: parsed.candidate.evidenceRefs,
        status: "pending",
        createdAt: utcnow(),
      }),
    );
    if (inserted) summary.ingested += 1;
    else summary.skipped += 1;
  }
  return summary;
}

/**
 * Reviews every pending proposal once. Each proposal runs in its own transaction, so one
 * bad candidate cannot roll back another. Expected validation failures are recorded as
 * `rejected`; unexpected errors are logged and also recorded, never thrown.
 */
export function reviewPendingProposals(
  db: CairnDatabase,
  config: DispatchConfig,
  projectId: string,
  workspace: string,
  log: (message: string) => void = () => undefined,
): ProposalReviewSummary {
  const summary: ProposalReviewSummary = {
    applied: 0,
    rejected: 0,
    duplicate: 0,
    dryRun: 0,
    skipped: 0,
  };
  if (
    !config.proposals.enabled ||
    config.proposals.mode === "off" ||
    config.proposals.maxPerTask === 0
  ) {
    return summary;
  }

  const pending = db.withConn((conn) => listPendingProposals(conn, projectId));
  for (const proposal of pending) {
    let decision: {
      status: "applied" | "rejected" | "duplicate" | "dry_run";
      reason: string | null;
      appliedId: string | null;
    };
    try {
      decision = db.withConn((conn) => {
        checkProjectActive(conn, projectId);
        return reviewOne(conn, config, proposal, workspace);
      });
    } catch (error) {
      const reason = rejectionReason(error);
      decision = { status: "rejected", reason, appliedId: null };
      if (reason === "apply_failed") {
        log(
          `proposal review failed project=${projectId} proposal=${proposal.id}: ${describe(error)}`,
        );
      }
    }

    try {
      db.withConn((conn) =>
        recordProposalDecision(conn, projectId, proposal.id, {
          status: decision.status,
          reason: decision.reason,
          appliedId: decision.appliedId,
        }),
      );
    } catch (error) {
      log(
        `proposal decision failed project=${projectId} proposal=${proposal.id}: ${describe(error)}`,
      );
      summary.skipped += 1;
      continue;
    }

    if (decision.status === "applied") summary.applied += 1;
    else if (decision.status === "rejected") summary.rejected += 1;
    else if (decision.status === "duplicate") summary.duplicate += 1;
    else summary.dryRun += 1;
  }
  return summary;
}

function reviewOne(
  conn: Database,
  config: DispatchConfig,
  proposal: Proposal,
  workspace: string,
): { status: "applied" | "rejected" | "duplicate" | "dry_run"; reason: string | null; appliedId: string | null } {
  const dryRun = config.proposals.mode === "dry_run";
  const payload = proposal.payload;

  switch (proposal.kind) {
    case "hint":
      return reviewHint(conn, proposal, payload, dryRun);
    case "intent":
      return reviewIntent(conn, proposal, payload, dryRun);
    case "fact":
      return reviewFact(conn, config, proposal, payload, workspace, dryRun);
  }
}

function reviewHint(
  conn: Database,
  proposal: Proposal,
  payload: Record<string, unknown>,
  dryRun: boolean,
): { status: "applied" | "rejected" | "duplicate" | "dry_run"; reason: string | null; appliedId: string | null } {
  const content = textField(payload, "content");
  const existing = findHintByContent(conn, proposal.project_id, content);
  if (existing !== null) {
    return { status: "duplicate", reason: "hint_exists", appliedId: existing.id };
  }
  if (proposal.dedupe_key !== null) {
    const prior = findAppliedProposalByDedupeKey(
      conn,
      proposal.project_id,
      "hint",
      proposal.dedupe_key,
    );
    if (prior !== null) {
      return { status: "duplicate", reason: "dedupe_key_applied", appliedId: prior.applied_id };
    }
  }
  if (dryRun) return { status: "dry_run", reason: "would_apply", appliedId: null };

  const hint = createHint(conn, proposal.project_id, {
    content,
    creator: OBSERVER_CREATOR,
  });
  return { status: "applied", reason: null, appliedId: hint.id };
}

function reviewIntent(
  conn: Database,
  proposal: Proposal,
  payload: Record<string, unknown>,
  dryRun: boolean,
): { status: "applied" | "rejected" | "duplicate" | "dry_run"; reason: string | null; appliedId: string | null } {
  const description = textField(payload, "description");
  const from = factIdField(payload, "from");
  const dedupeKey = proposal.dedupe_key;
  if (dedupeKey === null) {
    return { status: "rejected", reason: "dedupe_key_required", appliedId: null };
  }

  const open = findOpenIntentByDedupeKey(conn, proposal.project_id, dedupeKey);
  if (open !== null) {
    return { status: "duplicate", reason: "intent_open", appliedId: open.id };
  }
  const prior = findAppliedProposalByDedupeKey(
    conn,
    proposal.project_id,
    "intent",
    dedupeKey,
  );
  if (prior !== null) {
    return { status: "duplicate", reason: "dedupe_key_applied", appliedId: prior.applied_id };
  }

  validateFactsExist(conn, proposal.project_id, from);
  validateGoalNotInSources(from);
  if (dryRun) return { status: "dry_run", reason: "would_apply", appliedId: null };

  const intent = createIntent(conn, proposal.project_id, {
    from,
    description,
    creator: OBSERVER_CREATOR,
    worker: null,
  });
  recordIntentMeta(conn, {
    projectId: proposal.project_id,
    intentId: intent.id,
    dedupeKey,
    source: "observer",
    proposalId: proposal.id,
    originRunId: proposal.run_id,
  });
  return { status: "applied", reason: null, appliedId: intent.id };
}

function reviewFact(
  conn: Database,
  config: DispatchConfig,
  proposal: Proposal,
  payload: Record<string, unknown>,
  workspace: string,
  dryRun: boolean,
): { status: "applied" | "rejected" | "duplicate" | "dry_run"; reason: string | null; appliedId: string | null } {
  const description = textField(payload, "description");
  const from = factIdField(payload, "from");
  const supersedes = optionalFactIdField(payload, "supersedes", MAX_SUPERSEDES);

  const existing = findFactByDescription(conn, proposal.project_id, description);
  if (existing !== null) {
    return { status: "duplicate", reason: "fact_exists", appliedId: existing.id };
  }
  if (proposal.dedupe_key !== null) {
    const prior = findAppliedProposalByDedupeKey(
      conn,
      proposal.project_id,
      "fact",
      proposal.dedupe_key,
    );
    if (prior !== null) {
      return { status: "duplicate", reason: "dedupe_key_applied", appliedId: prior.applied_id };
    }
  }

  validateFactsExist(conn, proposal.project_id, from);
  validateGoalNotInSources(from);
  if (supersedes.includes("origin") || supersedes.includes("goal")) {
    return { status: "rejected", reason: "supersede_origin_or_goal", appliedId: null };
  }
  try {
    validateFactsExist(conn, proposal.project_id, supersedes);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { status: "rejected", reason: "supersede_target_missing", appliedId: null };
    }
    throw error;
  }
  const alreadyReplaced = new Set(
    listFactSupersessions(conn, proposal.project_id).map((edge) => edge.fact_id),
  );
  const replaced = supersedes.find((factId) => alreadyReplaced.has(factId));
  if (replaced !== undefined) {
    return {
      status: "rejected",
      reason: `fact_already_superseded: ${replaced}`,
      appliedId: null,
    };
  }

  if (config.proposals.requireEvidenceForFact && proposal.evidence_refs.length === 0) {
    return { status: "rejected", reason: "evidence_required", appliedId: null };
  }
  const evidence = collectEvidence(proposal.evidence_refs, workspace, {
    minBytes: config.tasks.evidence.minBytes,
  });
  if (evidence.invalid.length > 0) {
    const reason = evidence.invalid
      .map((issue) => `${issue.ref || "<ref>"}: ${issue.reason}`)
      .join("; ");
    return { status: "rejected", reason: `evidence_invalid: ${reason}`, appliedId: null };
  }
  if (evidence.status === "missing") {
    return { status: "rejected", reason: "evidence_missing", appliedId: null };
  }
  if (dryRun) return { status: "dry_run", reason: "would_apply", appliedId: null };

  // A fact proposal uses the same two graph commands a worker uses: create a claimed
  // intent, then conclude it with the accepted evidence. No new graph semantics.
  const intent = createIntent(conn, proposal.project_id, {
    from,
    description,
    creator: OBSERVER_CREATOR,
    worker: OBSERVER_CREATOR,
  });
  recordIntentMeta(conn, {
    projectId: proposal.project_id,
    intentId: intent.id,
    dedupeKey: proposal.dedupe_key,
    source: "observer",
    proposalId: proposal.id,
    originRunId: proposal.run_id,
  });
  const concluded = concludeIntent(
    conn,
    proposal.project_id,
    intent.id,
    OBSERVER_CREATOR,
    description,
    {
      runId: proposal.run_id,
      evidenceRefs: evidence.refs,
      evidenceStatus: evidence.status,
      evidenceFiles: evidence.files,
      ...(supersedes.length === 0 ? {} : { supersedes }),
    },
  );
  return { status: "applied", reason: null, appliedId: concluded.fact.id };
}

type ParseResult = { candidate: Candidate } | { reason: string };

function parseCandidate(raw: string, config: DispatchConfig): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reason: "invalid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { reason: "candidate must be an object" };
  }
  const root = value as Record<string, unknown>;
  if (root["version"] !== CANDIDATE_VERSION) {
    return { reason: `unsupported version: ${String(root["version"])}` };
  }
  const kind = root["kind"];
  if (kind !== "fact" && kind !== "intent" && kind !== "hint") {
    return { reason: "invalid kind" };
  }
  if (!config.proposals.allowKinds.includes(kind)) {
    return { reason: `kind not enabled: ${kind}` };
  }
  const payload = root["payload"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { reason: "payload must be an object" };
  }
  const payloadRecord = payload as Record<string, unknown>;

  const confidence = payloadRecord["confidence"];
  if (confidence !== undefined) {
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return { reason: "confidence must be between 0 and 1" };
    }
    if (confidence < config.proposals.minConfidence) {
      return { reason: "confidence below threshold" };
    }
  }

  const dedupeKey = optionalString(root["dedupe_key"], MAX_DEDUPE_KEY_CHARS);
  if ("reason" in dedupeKey) return { reason: `dedupe_key: ${dedupeKey.reason}` };

  const evidence = stringList(root["evidence_refs"], {
    maxItems: MAX_EVIDENCE_REFS,
    maxChars: MAX_EVIDENCE_REF_CHARS,
  });
  if ("reason" in evidence) return { reason: `evidence_refs: ${evidence.reason}` };

  const supersedes = stringList(payloadRecord["supersedes"], {
    maxItems: MAX_SUPERSEDES,
    maxChars: 64,
  });
  if ("reason" in supersedes) return { reason: `supersedes: ${supersedes.reason}` };
  if (kind !== "fact" && supersedes.items.length > 0) {
    return { reason: "supersedes is only allowed for facts" };
  }

  if (kind === "hint") {
    const content = text(payloadRecord["content"], MAX_TEXT_CHARS);
    if ("reason" in content) return { reason: `content: ${content.reason}` };
    return {
      candidate: {
        id: String(root["id"] ?? ""),
        kind,
        payload: { content: content.text, confidence: confidence ?? 1 },
        dedupeKey: dedupeKey.value,
        evidenceRefs: evidence.items,
      },
    };
  }

  const description = text(payloadRecord["description"], MAX_TEXT_CHARS);
  if ("reason" in description) return { reason: `description: ${description.reason}` };
  const from = stringList(payloadRecord["from"], {
    maxItems: MAX_FROM_FACTS,
    maxChars: 64,
  });
  if ("reason" in from) return { reason: `from: ${from.reason}` };
  if (from.items.length === 0) return { reason: "from must contain at least one fact id" };
  if (kind === "intent" && dedupeKey.value === null) {
    return { reason: "dedupe_key is required for intents" };
  }
  return {
    candidate: {
      id: String(root["id"] ?? ""),
      kind,
      payload: {
        description: description.text,
        from: from.items,
        confidence: confidence ?? 1,
        ...(kind === "fact" && supersedes.items.length > 0
          ? { supersedes: supersedes.items }
          : {}),
      },
      dedupeKey: dedupeKey.value,
      evidenceRefs: evidence.items,
    },
  };
}

function textField(payload: Record<string, unknown>, field: string): string {
  const result = text(payload[field], MAX_TEXT_CHARS);
  if ("reason" in result) throw new Error(`${field}: ${result.reason}`);
  return result.text;
}

function factIdField(payload: Record<string, unknown>, field: string): string[] {
  const result = stringList(payload[field], { maxItems: MAX_FROM_FACTS, maxChars: 64 });
  if ("reason" in result) throw new Error(`${field}: ${result.reason}`);
  if (result.items.length === 0) throw new Error(`${field} must not be empty`);
  return result.items;
}

function optionalFactIdField(
  payload: Record<string, unknown>,
  field: string,
  maxItems: number,
): string[] {
  const result = stringList(payload[field], { maxItems, maxChars: 64 });
  if ("reason" in result) throw new Error(`${field}: ${result.reason}`);
  return result.items;
}

function text(value: unknown, maxChars: number): { text: string } | { reason: string } {
  if (typeof value !== "string") return { reason: "must be a string" };
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized === "") return { reason: "must not be empty" };
  if (normalized.length > maxChars) return { reason: `must be at most ${maxChars} characters` };
  return { text: normalized };
}

function optionalString(
  value: unknown,
  maxChars: number,
): { value: string | null } | { reason: string } {
  if (value === undefined || value === null) return { value: null };
  if (typeof value !== "string") return { reason: "must be a string" };
  const normalized = value.trim();
  if (normalized === "") return { value: null };
  if (normalized.length > maxChars) return { reason: `must be at most ${maxChars} characters` };
  return { value: normalized };
}

function stringList(
  value: unknown,
  options: { maxItems: number; maxChars: number },
): { items: string[] } | { reason: string } {
  if (value === undefined || value === null) return { items: [] };
  if (!Array.isArray(value)) return { reason: "must be an array" };
  if (value.length > options.maxItems) {
    return { reason: `must contain at most ${options.maxItems} items` };
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { reason: "entries must be strings" };
    const normalized = item.trim();
    if (normalized === "") return { reason: "entries must not be empty" };
    if (normalized.length > options.maxChars) {
      return { reason: `entries must be at most ${options.maxChars} characters` };
    }
    if (!items.includes(normalized)) items.push(normalized);
  }
  return { items };
}

function readBoundedFile(
  path: string,
  maxBytes: number,
): { text: string; bytes: number } | { reason: string } {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return { reason: "file disappeared" };
  }
  if (info.isSymbolicLink()) return { reason: "symlinks are not accepted" };
  if (!info.isFile()) return { reason: "not a regular file" };
  if (info.size > maxBytes) return { reason: `file exceeds ${maxBytes} bytes` };

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { reason: "file is not readable" };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { reason: "not a regular file" };
    if (opened.size > maxBytes) return { reason: `file exceeds ${maxBytes} bytes` };
    const buffer = Buffer.alloc(opened.size);
    const read = readSync(fd, buffer, 0, opened.size, 0);
    return { text: buffer.subarray(0, read).toString("utf8"), bytes: opened.size };
  } catch {
    return { reason: "file is not readable" };
  } finally {
    closeSync(fd);
  }
}

/** Deterministic id: re-ingesting a retained session directory is idempotent. */
function proposalIdFor(projectId: string, taskId: string, filename: string): string {
  const digest = createHash("sha256")
    .update(`${projectId}\u0000${taskId}\u0000${filename}`)
    .digest("hex");
  return `p_${digest.slice(0, 32)}`;
}

function rejectionReason(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 403) return "project_inactive";
    if (error.status === 404) return "source_fact_missing";
    if (error.status === 400) return "invalid_source";
    return `http_${error.status}`;
  }
  return "apply_failed";
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
