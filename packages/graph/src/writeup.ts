/**
 * Chinese project writeup (M19a).
 *
 * A writeup is a narrative view of data the control plane already stores: the project
 * header, the authorized scope, the origin/goal pair, the intent→fact chain that produced
 * the current findings, superseded judgements, hints, the captured flag, the verification
 * outcome and the run statistics. This module only reads; rendering the snapshot into
 * Chinese Markdown adds no graph semantics.
 *
 * Payload candidates (M20a) are selected from the artifact index by deterministic naming and
 * extension rules; their bytes are read by the HTTP layer, which passes the already capped
 * text in through `payloadContents`. This module never touches the filesystem, so the
 * writeup stays reproducible from the database plus one injected list.
 *
 * The Markdown draft doubles as the input for the model-written variant: the HTTP layer
 * asks a model to rewrite the draft as prose and stores the result in `project_writeups`,
 * so a project without model credentials still has a complete Chinese writeup.
 */

import type { Database } from "bun:sqlite";

import { listProjectArtifacts, type ProjectArtifact } from "./artifacts";
import { getProjectDetail, getProjectScope } from "./commands";
import { all, get, run } from "./db";
import type { FactSupersession, Hint, Intent, VerificationKind } from "./models";
import { buildProjectRunStats } from "./stats";
import { listFactSupersessions } from "./supersedes";
import { utcnow } from "./services";
import { summarizeProjectVerification } from "./verification";

const MAX_WRITEUP_ARTIFACTS = 200;

/** Payload list size and inline-text cap, shared with the HTTP layer that reads the bytes. */
export const MAX_WRITEUP_PAYLOADS = 20;
export const MAX_WRITEUP_PAYLOAD_CHARS = 4_000;

/**
 * File names and extensions that mark a worker-written exploit artifact: scripts, delivery
 * containers and the usual attack keywords. Response dumps (`.txt`, `.out`, `.resp`, `.md`,
 * `.json`) stay out of the list, so the payload section records what was thrown at the
 * target rather than everything the worker saved.
 */
const PAYLOAD_EXTENSION_LANGUAGES = new Map<string, string | null>([
  ["py", "python"],
  ["sh", "bash"],
  ["bash", "bash"],
  ["zsh", "bash"],
  ["php", "php"],
  ["php5", "php"],
  ["phtml", "php"],
  ["phar", null],
  ["js", "javascript"],
  ["ts", "typescript"],
  ["rb", "ruby"],
  ["pl", "perl"],
  ["pm", "perl"],
  ["ps1", "powershell"],
  ["bat", "bat"],
  ["cmd", "bat"],
  ["c", "c"],
  ["cpp", "cpp"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["jsp", null],
  ["asp", null],
  ["aspx", null],
  ["sql", "sql"],
  ["html", "html"],
  ["htm", "html"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["xsl", "xml"],
  ["xslt", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["pkl", null],
  ["pickle", null],
  ["zip", null],
  ["tar", null],
  ["gz", null],
  ["bz2", null],
  ["xz", null],
  ["7z", null],
  ["rar", null],
  ["jar", null],
  ["war", null],
  ["class", null],
  ["png", null],
  ["jpg", null],
  ["jpeg", null],
  ["gif", null],
  ["bmp", null],
  ["ico", null],
  ["webp", null],
  ["pdf", null],
]);

/** Keywords that make a file a payload even when its extension is not on the list. */
const PAYLOAD_NAME_PATTERN =
  /(payload|exploit|attack|\bpoc\b|inject|sqli|xss|ssrf|ssti|xxe|pickle|pkl|traver|webshell|reverse[-_]?shell|bind[-_]?shell|deserial|forg|bypass)/i;

/**
 * Logs and session transcripts are evidence dumps even when their name carries an attack
 * keyword (`login_bypass.log`, `sqli_probe.log`). Treating them as payloads would spend the
 * inline budget on responses and push the scripts that reproduce the chain out of the cap.
 */
const EVIDENCE_DUMP_EXTENSIONS = new Set(["log", "jsonl"]);

export interface WriteupFlag {
  value: string;
  source: string;
  /** Other accepted flag-shaped values, ranked below `value`. */
  alternatives?: string[];
}

/** One payload file whose bytes the HTTP layer already read and capped. */
export interface WriteupPayloadContent {
  /** Artifact-index-relative path, for example `explore-1a2b3c4d5e6f/forge.py`. */
  path: string;
  /** True when the bytes are not text, so only the path is recorded. */
  binary: boolean;
  /** Inlined text, or null for a binary or unreadable file. */
  text: string | null;
  /** True when the caller cut the text because the file is larger than its cap. */
  truncated: boolean;
}

export interface BuildProjectWriteupOptions {
  /** Captured flag plus the file it was read from. */
  flag?: WriteupFlag | null;
  /** Flag-shaped text the scanner rejected as a mask, newest evidence first. */
  flagSuspects?: string[];
  /** Payload file contents keyed by artifact path; absent entries render as unread. */
  payloadContents?: readonly WriteupPayloadContent[];
  /** Injectable clock for deterministic rendering. */
  generatedAt?: string;
  /** Policy reported for legacy projects without a `project_verification` row. */
  verificationFallback?: VerificationKind;
}

export interface WriteupStep {
  intent_id: string;
  description: string;
  from: string[];
  fact_id: string | null;
  fact_description: string | null;
  run_id: string | null;
  worker: string | null;
  model: string | null;
  outcome: string | null;
  evidence: string[];
  created_at: string;
}

/**
 * One intent on the reconstructed exploitation chain. The chain keeps the recorded
 * `from` edges: a step's `prerequisites` name the observations it consumed, and
 * `payload_refs` name the scripts the producing run left behind, so a reader can replay
 * the step with the same input the worker had.
 */
export interface WriteupChainStep extends WriteupStep {
  /** 1-based position in dependency order (not creation order). */
  position: number;
  /** Consumed facts with a one-line reminder of what each recorded. */
  prerequisites: { id: string; brief: string }[];
  /** Task directory of the run that produced this step's fact; null when no run is recorded. */
  task_id: string | null;
  /** Payload/script artifacts written by the run that produced this step's fact. */
  payload_refs: string[];
  /** True when this step produced a fact that carries the flag. */
  terminal: boolean;
}

/**
 * The exploitation chain as a deterministic projection of the graph. `steps` is the
 * dependency closure of the fact that carries the flag (or the operator's completion
 * sources), ordered so every prerequisite appears before the step that used it;
 * `side_steps` are concluded intents outside that closure.
 */
export interface WriteupChain {
  /** True when the chain was anchored on recorded flag evidence; false means it lists everything. */
  anchored: boolean;
  /** The fact the chain ends at, when one could be located. */
  flag_fact: string | null;
  /** Where the flag came from (`operator review`, an artifact path, …). */
  flag_source: string | null;
  steps: WriteupChainStep[];
  side_steps: WriteupStep[];
}

export interface WriteupFinding {
  id: string;
  description: string;
  evidence: string[];
}


export interface WriteupArtifact {
  path: string;
  size: number;
  sha256: string;
  task_id: string;
}

export interface WriteupPayload {
  path: string;
  size: number;
  sha256: string;
  task_id: string;
  /** Fenced-block language inferred from the extension; null for containers and binaries. */
  language: string | null;
  /** True when the read bytes are not text, so the writeup records the path only. */
  binary: boolean;
  /** Inlined payload text, or null when nothing could be inlined. */
  text: string | null;
  truncated: boolean;
  /** Fact ids whose `evidence_refs` cite this file. */
  referenced_by: string[];
}

export interface ProjectWriteupSnapshot {
  generated_at: string;
  project: {
    id: string;
    title: string;
    status: string;
    created_at: string;
    challenge_code: string | null;
    targets: string[];
    scope_notes: string | null;
  };
  origin: string | null;
  goal: string | null;
  /** Every concluded intent in creation order; kept for callers that want the raw list. */
  steps: WriteupStep[];
  /** Dependency-ordered exploitation chain plus the intents outside it. */
  chain: WriteupChain;
  open_intents: { id: string; description: string }[];
  /** Every current fact except origin/goal and superseded ones. */
  findings: WriteupFinding[];
  supersessions: FactSupersession[];
  hints: Hint[];
  flag: WriteupFlag | null;
  /** Flag-shaped text the scanner rejected as a mask; empty when nothing looked like a flag. */
  flag_suspects: string[];
  verification: {
    kind: VerificationKind;
    checks: {
      total: number;
      passed: number;
      failed: number;
      last_checked_at: string | null;
    };
    latest: {
      ok: boolean;
      detail: string;
      flag_count: number | null;
      flag_got_count: number | null;
      checked_at: string;
    } | null;
  };
  runs: {
    runs: number;
    finished: number;
    succeeded: number;
    failed: number;
    tokens: number;
    cost_usd: number;
    by_worker: { worker: string; runs: number; succeeded: number; tokens: number }[];
    by_model: { model: string | null; runs: number; succeeded: number; tokens: number }[];
  };
  artifacts: WriteupArtifact[];
  artifacts_truncated: boolean;
  /** Worker-written payload and script files, capped to `MAX_WRITEUP_PAYLOADS`. */
  payloads: WriteupPayload[];
  /** Payload artifacts recognised in the index, including the ones the cap dropped. */
  payloads_total: number;
  payloads_truncated: boolean;
}

interface FactMetaRow {
  fact_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
}

export interface SelectWriteupPayloadOptions {
  /**
   * Flag source, when the caller already knows it. It lets the selector put the payloads
   * the exploitation chain actually used ahead of unrelated probe scripts.
   */
  flagSource?: string | null;
}

/**
 * The payload artifacts a writeup should inline, capped to `MAX_WRITEUP_PAYLOADS`.
 * Artifacts the exploitation chain used come first (in chain order), then files cited by
 * any fact, then by path, so the cap cannot drop the scripts that reproduce the result.
 * The HTTP layer reads exactly these paths.
 */
export function selectWriteupPayloadArtifacts(
  conn: Database,
  projectId: string,
  options: SelectWriteupPayloadOptions = {},
): ProjectArtifact[] {
  const artifacts = listProjectArtifacts(conn, projectId);
  return orderWriteupPayloadArtifacts(
    artifacts,
    factsByEvidencePath(readFactRows(conn, projectId)),
    readChain(conn, projectId, options.flagSource ?? null, artifacts),
  ).slice(0, MAX_WRITEUP_PAYLOADS);
}

function readFactRows(conn: Database, projectId: string): FactMetaRow[] {
  return all<FactMetaRow>(
    conn,
    "SELECT fact_id, run_id, evidence_refs, evidence_status FROM fact_meta WHERE project_id = ?",
    projectId,
  );
}

function readChain(
  conn: Database,
  projectId: string,
  flagSource: string | null,
  artifacts: readonly ProjectArtifact[],
): WriteupChain {
  const detail = getProjectDetail(conn, projectId);
  const evidenceByFact = new Map<string, string[]>();
  const runByFact = new Map<string, string | null>();
  for (const row of readFactRows(conn, projectId)) {
    evidenceByFact.set(row.fact_id, parseRefs(row.evidence_refs));
    runByFact.set(row.fact_id, row.run_id);
  }
  const runRows = new Map<string, LiteRunRow>();
  for (const entry of listRunsLite(conn, projectId)) runRows.set(entry.id, entry);
  return computeChain({
    intents: detail.intents,
    factById: new Map(detail.facts.map((fact) => [fact.id, fact])),
    evidenceByFact,
    runByFact,
    runRows,
    artifacts,
    flagSource,
  });
}

function orderWriteupPayloadArtifacts(
  artifacts: readonly ProjectArtifact[],
  factsByArtifact: ReadonlyMap<string, string[]>,
  chain: WriteupChain,
): ProjectArtifact[] {
  // The scripts of the terminal step come first: that is the run that produced the flag,
  // so its files are what a reader replays to reproduce the result. Everything else on the
  // chain follows in dependency order, then artifacts outside the chain.
  const terminalTasks = new Set<string>();
  const terminalEvidence = new Set<string>();
  const chainEvidence = new Map<string, number>();
  const chainTask = new Map<string, number>();
  chain.steps.forEach((step, index) => {
    if (step.task_id !== null && !chainTask.has(step.task_id)) chainTask.set(step.task_id, index);
    for (const ref of step.evidence) {
      const key = normalizeArtifactPath(ref);
      if (key === "" || chainEvidence.has(key)) continue;
      chainEvidence.set(key, index);
      if (step.terminal) terminalEvidence.add(key);
    }
    if (step.terminal && step.task_id !== null) terminalTasks.add(step.task_id);
  });
  const sortKey = (artifact: ProjectArtifact): { tier: number; order: number } => {
    const key = normalizeArtifactPath(artifact.path);
    const evidenceOrder = chainEvidence.get(key);
    if (terminalTasks.has(artifact.task_id) || terminalEvidence.has(key)) return { tier: 0, order: 0 };
    if (evidenceOrder !== undefined) return { tier: 1, order: evidenceOrder };
    const taskOrder = chainTask.get(artifact.task_id);
    if (taskOrder !== undefined) return { tier: 2, order: taskOrder };
    return { tier: 3, order: 0 };
  };
  return artifacts
    .filter((artifact) => isWriteupPayloadPath(artifact.path))
    .sort((left, right) => {
      const leftKey = sortKey(left);
      const rightKey = sortKey(right);
      if (leftKey.tier !== rightKey.tier) return leftKey.tier - rightKey.tier;
      if (leftKey.order !== rightKey.order) return leftKey.order - rightKey.order;
      const byEvidenceCount =
        (factsByArtifact.get(normalizeArtifactPath(right.path))?.length ?? 0) -
        (factsByArtifact.get(normalizeArtifactPath(left.path))?.length ?? 0);
      return byEvidenceCount !== 0 ? byEvidenceCount : left.path.localeCompare(right.path);
    });
}

function factsByEvidencePath(
  rows: readonly Pick<FactMetaRow, "fact_id" | "evidence_refs">[],
): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const row of rows) {
    for (const ref of parseRefs(row.evidence_refs)) {
      const key = normalizeArtifactPath(ref);
      if (key === "") continue;
      const known = byPath.get(key);
      if (known === undefined) byPath.set(key, [row.fact_id]);
      else if (!known.includes(row.fact_id)) known.push(row.fact_id);
    }
  }
  return byPath;
}

interface ChainInput {
  intents: readonly Intent[];
  factById: ReadonlyMap<string, { description: string }>;
  evidenceByFact: ReadonlyMap<string, string[]>;
  runByFact: ReadonlyMap<string, string | null>;
  runRows: ReadonlyMap<string, LiteRunRow>;
  artifacts: readonly ProjectArtifact[];
  flagSource: string | null;
}

interface StepContext {
  factById: ReadonlyMap<string, { description: string }>;
  evidenceByFact: ReadonlyMap<string, string[]>;
  runByFact: ReadonlyMap<string, string | null>;
  runRows: ReadonlyMap<string, LiteRunRow>;
}

/**
 * Reconstructs the exploitation chain from the recorded edges only.
 *
 * Anchors are the facts that carry the flag: the ones whose `evidence_refs` cite the flag
 * source, and the facts an operator named when completing the project. Walking `intent.to`
 * backwards through `intent.from` gives the dependency closure; a topological order then
 * puts every prerequisite before the step that used it. Intents outside the closure are
 * reported separately instead of being interleaved by timestamp. When no anchor can be
 * located (no flag yet), the whole concluded graph is ordered by dependency so the draft
 * is still readable, and `anchored` says the chain could not be tied to a flag.
 */
function computeChain(input: ChainInput): WriteupChain {
  const concluded = input.intents
    .filter((intent) => intent.to !== null && intent.to !== "goal")
    .sort(byCreation);
  const producers = new Map<string, Intent>();
  for (const intent of concluded) {
    if (intent.to === null) continue;
    const current = producers.get(intent.to);
    if (current === undefined || byCreation(intent, current) < 0) producers.set(intent.to, intent);
  }

  const anchors = chainAnchors(input);
  const chosen = dependencyClosure(producers, anchors);
  const ctx: StepContext = input;
  const payloads = payloadsByTask(input.artifacts);

  if (chosen.size === 0) {
    const everyIntent = new Set(concluded.map((intent) => intent.id));
    const ordered = topologicalOrder(concluded, producers, everyIntent);
    return {
      anchored: false,
      flag_fact: null,
      flag_source: input.flagSource,
      steps: ordered.map((intent, index) =>
        toChainStep(intent, index + 1, ctx, payloads, new Set<string>()),
      ),
      side_steps: [],
    };
  }

  const ordered = topologicalOrder(concluded, producers, chosen);
  const placed = new Set(ordered.map((intent) => intent.id));
  return {
    anchored: true,
    flag_fact: anchors[0] ?? null,
    flag_source: input.flagSource,
    steps: ordered.map((intent, index) =>
      toChainStep(intent, index + 1, ctx, payloads, new Set(anchors)),
    ),
    side_steps: concluded
      .filter((intent) => !placed.has(intent.id))
      .map((intent) => toWriteupStep(intent, ctx)),
  };
}

function chainAnchors(input: ChainInput): string[] {
  const source = input.flagSource === null ? "" : normalizeArtifactPath(input.flagSource);
  const fromEvidence: string[] = [];
  if (source !== "") {
    for (const [factId, refs] of input.evidenceByFact) {
      if (refs.some((ref) => normalizeArtifactPath(ref) === source)) fromEvidence.push(factId);
    }
    fromEvidence.sort();
  }
  // `operator review` and verification-created flags have no artifact path; the operator's
  // completion intent records exactly which facts they accepted in `from`.
  const fromGoal: string[] = [];
  for (const intent of input.intents) {
    if (intent.to !== "goal") continue;
    for (const factId of intent.from) {
      if (factId === "origin" || factId === "goal" || fromEvidence.includes(factId)) continue;
      if (!fromGoal.includes(factId)) fromGoal.push(factId);
    }
  }
  return [...fromEvidence, ...fromGoal];
}

function dependencyClosure(
  producers: ReadonlyMap<string, Intent>,
  anchors: readonly string[],
): Set<string> {
  const chosen = new Set<string>();
  const queue = [...anchors];
  while (queue.length > 0) {
    const factId = queue.pop();
    if (factId === undefined) break;
    const producer = producers.get(factId);
    if (producer === undefined || chosen.has(producer.id)) continue;
    chosen.add(producer.id);
    queue.push(...producer.from);
  }
  return chosen;
}

/** Kahn's algorithm; ties and the ready queue are ordered by `created_at, id`. */
function topologicalOrder(
  intents: readonly Intent[],
  producers: ReadonlyMap<string, Intent>,
  chosen: ReadonlySet<string>,
): Intent[] {
  const chain = intents.filter((intent) => chosen.has(intent.id));
  const byId = new Map(chain.map((intent) => [intent.id, intent]));
  const indegree = new Map<string, number>(chain.map((intent) => [intent.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const intent of chain) {
    const seen = new Set<string>();
    for (const source of intent.from) {
      const producer = producers.get(source);
      if (
        producer === undefined ||
        producer.id === intent.id ||
        !byId.has(producer.id) ||
        seen.has(producer.id)
      ) {
        continue;
      }
      seen.add(producer.id);
      indegree.set(intent.id, (indegree.get(intent.id) ?? 0) + 1);
      const list = dependents.get(producer.id);
      if (list === undefined) dependents.set(producer.id, [intent.id]);
      else list.push(intent.id);
    }
  }
  const ready = chain.filter((intent) => (indegree.get(intent.id) ?? 0) === 0).sort(byCreation);
  const ordered: Intent[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    ordered.push(next);
    for (const dependentId of dependents.get(next.id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        const dependent = byId.get(dependentId);
        if (dependent !== undefined) insertSorted(ready, dependent);
      }
    }
  }
  if (ordered.length < chain.length) {
    // A cycle is not expected (intents only cite facts that existed), but never drop steps.
    const placed = new Set(ordered.map((intent) => intent.id));
    ordered.push(...chain.filter((intent) => !placed.has(intent.id)).sort(byCreation));
  }
  return ordered;
}

function insertSorted(list: Intent[], value: Intent): void {
  const index = list.findIndex((entry) => byCreation(value, entry) < 0);
  if (index < 0) list.push(value);
  else list.splice(index, 0, value);
}

function byCreation(left: Intent, right: Intent): number {
  const byTime = left.created_at.localeCompare(right.created_at);
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

function toWriteupStep(intent: Intent, ctx: StepContext): WriteupStep {
  const factId = intent.to;
  const runId = factId === null ? null : ctx.runByFact.get(factId) ?? null;
  const run = runId === null ? undefined : ctx.runRows.get(runId);
  return {
    intent_id: intent.id,
    description: intent.description,
    from: intent.from,
    fact_id: factId,
    fact_description: factId === null ? null : ctx.factById.get(factId)?.description ?? null,
    run_id: runId,
    worker: run?.worker ?? intent.worker,
    model: run?.model ?? null,
    outcome: run?.outcome ?? null,
    evidence: factId === null ? [] : ctx.evidenceByFact.get(factId) ?? [],
    created_at: intent.created_at,
  };
}

function toChainStep(
  intent: Intent,
  position: number,
  ctx: StepContext,
  payloads: ReadonlyMap<string, string[]>,
  terminals: ReadonlySet<string>,
): WriteupChainStep {
  const base = toWriteupStep(intent, ctx);
  const taskId = base.run_id === null ? null : ctx.runRows.get(base.run_id)?.task_id ?? null;
  return {
    ...base,
    position,
    prerequisites: intent.from.map((factId) => ({
      id: factId,
      brief: brief(ctx.factById.get(factId)?.description ?? ""),
    })),
    task_id: taskId,
    payload_refs: taskId === null ? [] : [...(payloads.get(taskId) ?? [])],
    terminal: intent.to !== null && terminals.has(intent.to),
  };
}

/** Payload-eligible artifact paths grouped by the task that produced them. */
function payloadsByTask(
  artifacts: readonly ProjectArtifact[],
): Map<string, string[]> {
  const byTask = new Map<string, string[]>();
  for (const artifact of artifacts) {
    if (!isWriteupPayloadPath(artifact.path)) continue;
    const list = byTask.get(artifact.task_id);
    if (list === undefined) byTask.set(artifact.task_id, [artifact.path]);
    else list.push(artifact.path);
  }
  for (const list of byTask.values()) list.sort();
  return byTask;
}

/** First clause of a fact, short enough to sit inside a prerequisite list. */
const BRIEF_CHARS = 80;

function brief(value: string): string {
  const single = inline(value);
  if (single === "") return "";
  const stop = single.search(/[。；;]/);
  const head = stop >= 0 ? single.slice(0, stop) : single;
  const clipped = head.length <= BRIEF_CHARS ? head : `${head.slice(0, BRIEF_CHARS)}…`;
  return clipped === "" ? `${single.slice(0, BRIEF_CHARS)}…` : clipped;
}

export function buildProjectWriteup(
  conn: Database,
  projectId: string,
  options: BuildProjectWriteupOptions = {},
): ProjectWriteupSnapshot {
  const detail = getProjectDetail(conn, projectId);
  const scope = getProjectScope(conn, projectId);
  const supersessions = listFactSupersessions(conn, projectId);
  const superseded = new Set(supersessions.map((edge) => edge.fact_id));
  const factById = new Map(detail.facts.map((fact) => [fact.id, fact]));
  const stats = buildProjectRunStats(conn, projectId);
  const verification = summarizeProjectVerification(
    conn,
    projectId,
    options.verificationFallback,
  );

  const metaRows = all<FactMetaRow>(
    conn,
    "SELECT fact_id, run_id, evidence_refs, evidence_status FROM fact_meta WHERE project_id = ?",
    projectId,
  );
  const evidenceByFact = new Map<string, string[]>();
  const runByFact = new Map<string, string | null>();
  for (const row of metaRows) {
    runByFact.set(row.fact_id, row.run_id);
    evidenceByFact.set(row.fact_id, parseRefs(row.evidence_refs));
  }
  const runRows = new Map<string, LiteRunRow>();
  for (const entry of listRunsLite(conn, projectId)) runRows.set(entry.id, entry);

  const concluded = detail.intents
    .filter((intent) => intent.to !== null)
    .sort(byCreation);
  const stepContext: StepContext = { factById, evidenceByFact, runByFact, runRows };
  const steps: WriteupStep[] = concluded.map((intent) => toWriteupStep(intent, stepContext));

  const findings = detail.facts
    .filter(
      (fact) =>
        fact.id !== "origin" &&
        fact.id !== "goal" &&
        !superseded.has(fact.id),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((fact) => ({
      id: fact.id,
      description: fact.description,
      evidence: evidenceByFact.get(fact.id) ?? [],
    }));

  const artifacts = listProjectArtifacts(conn, projectId);
  const chain = computeChain({
    intents: detail.intents,
    factById,
    evidenceByFact,
    runByFact,
    runRows,
    artifacts,
    flagSource: options.flag?.source ?? null,
  });

  const factsByArtifact = factsByEvidencePath(metaRows);
  const contents = new Map(
    (options.payloadContents ?? []).map((entry) => [normalizeArtifactPath(entry.path), entry]),
  );
  const orderedPayloads = orderWriteupPayloadArtifacts(artifacts, factsByArtifact, chain);
  const payloads: WriteupPayload[] = orderedPayloads.slice(0, MAX_WRITEUP_PAYLOADS).map((row) => {
    const content = contents.get(normalizeArtifactPath(row.path));
    const raw = content?.text ?? null;
    const text = raw === null ? null : clampText(raw, MAX_WRITEUP_PAYLOAD_CHARS);
    return {
      path: row.path,
      size: row.size,
      sha256: row.sha256,
      task_id: row.task_id,
      language: payloadLanguage(row.path),
      binary: content?.binary ?? false,
      text,
      truncated: (content?.truncated ?? false) || (raw !== null && text !== raw),
      referenced_by: [...(factsByArtifact.get(normalizeArtifactPath(row.path)) ?? [])].sort(),
    };
  });

  return {
    generated_at: options.generatedAt ?? utcnow(),
    project: {
      id: detail.project.id,
      title: detail.project.title,
      status: detail.project.status,
      created_at: detail.project.created_at,
      challenge_code: verification.policy.challenge_code,
      targets: scope?.targets ?? [],
      scope_notes: scope?.notes ?? null,
    },
    origin: factById.get("origin")?.description ?? null,
    goal: factById.get("goal")?.description ?? null,
    steps,
    chain,
    open_intents: detail.intents
      .filter((intent) => intent.to === null)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((intent) => ({ id: intent.id, description: intent.description })),
    findings,
    supersessions,
    hints: [...detail.hints].sort((left, right) => {
      const byTime = left.created_at.localeCompare(right.created_at);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    }),
    flag: options.flag ?? null,
    flag_suspects: [...(options.flagSuspects ?? [])],
    verification: {
      kind: verification.policy.kind,
      checks: verification.checks,
      latest:
        verification.latest === null
          ? null
          : {
              ok: verification.latest.ok,
              detail: verification.latest.detail,
              flag_count: verification.latest.flag_count,
              flag_got_count: verification.latest.flag_got_count,
              checked_at: verification.latest.checked_at,
            },
    },
    runs: {
      runs: stats.totals.runs,
      finished: stats.totals.finished,
      succeeded: stats.totals.succeeded,
      failed: stats.totals.failed,
      tokens: stats.totals.tokens,
      cost_usd: stats.totals.cost_usd,
      by_worker: stats.by_worker.map((group) => ({
        worker: group.worker,
        runs: group.runs,
        succeeded: group.succeeded,
        tokens: group.tokens,
      })),
      by_model: stats.by_model.map((group) => ({
        model: group.model,
        runs: group.runs,
        succeeded: group.succeeded,
        tokens: group.tokens,
      })),
    },
    artifacts: artifacts
      .slice(0, MAX_WRITEUP_ARTIFACTS)
      .map((artifact) => ({
        path: artifact.path,
        size: artifact.size,
        sha256: artifact.sha256,
        task_id: artifact.task_id,
      })),
    artifacts_truncated: artifacts.length > MAX_WRITEUP_ARTIFACTS,
    payloads,
    payloads_total: orderedPayloads.length,
    payloads_truncated: orderedPayloads.length > MAX_WRITEUP_PAYLOADS,
  };
}

/** Draft Chinese Markdown, used directly when no model-written writeup exists. */
export function renderProjectWriteupMarkdown(snapshot: ProjectWriteupSnapshot): string {
  const lines: string[] = [];
  const push = (...values: string[]): void => {
    lines.push(...values);
  };

  push(`# Writeup：${inline(snapshot.project.title) || snapshot.project.id}`, "");
  push(`- 项目：\`${snapshot.project.id}\``);
  push(`- 状态：${snapshot.project.status}`);
  push(`- 创建时间：${snapshot.project.created_at}`);
  push(`- 生成时间：${snapshot.generated_at}`);
  if (snapshot.project.challenge_code !== null) {
    push(`- 题目编号：${inline(snapshot.project.challenge_code)}`);
  }
  if (snapshot.project.targets.length > 0) {
    push(`- 授权范围：${snapshot.project.targets.map((target) => inline(target)).join("、")}`);
  } else {
    push("- 授权范围：未记录");
  }
  if (snapshot.project.scope_notes !== null && snapshot.project.scope_notes !== "") {
    push(`- 范围备注：${inline(snapshot.project.scope_notes)}`);
  }

  push("", "## 结论", snapshotVerdict(snapshot));

  push("", "## 题目与目标");
  push(`- 背景：${snapshot.origin === null ? "未记录" : inline(snapshot.origin)}`);
  push(`- 目标：${snapshot.goal === null ? "未记录" : inline(snapshot.goal)}`);

  push("", "## 攻击路径（利用链）");
  push(...chainIntro(snapshot.chain));
  const showStep = (step: WriteupChainStep, index: number): void => {
    const head = `${index + 1}. **${inline(step.description) || step.intent_id}**`;
    const sources = step.from.length === 0 ? "" : `（基于 ${step.from.join("、")}）`;
    push(`${head}${sources}`);
    if (step.prerequisites.length > 0) {
      const items = step.prerequisites.map((entry) =>
        entry.brief === "" ? `\`${entry.id}\`` : `\`${entry.id}\`（${entry.brief}）`,
      );
      push(`   - 前置：${items.join("、")}`);
    }
    if (step.fact_description !== null) {
      push(`   - 产出 \`${step.fact_id}\`：${inline(step.fact_description)}`);
    } else {
      push("   - 未产出事实");
    }
    const meta: string[] = [];
    if (step.worker !== null) meta.push(`worker：${inline(step.worker)}`);
    if (step.model !== null) meta.push(`model：${inline(step.model)}`);
    if (step.outcome !== null) meta.push(`结果：${inline(step.outcome)}`);
    if (meta.length > 0) push(`   - ${meta.join("，")}`);
    if (step.evidence.length > 0) {
      push(`   - 证据：${step.evidence.map((ref) => `\`${ref}\``).join("、")}`);
    }
    if (step.payload_refs.length > 0) {
      push(`   - 复现脚本：${payloadRefList(step.payload_refs)}`);
    }
    if (step.terminal && step.fact_id !== null) {
      const source = snapshot.chain.flag_source === null
        ? "来源未记录"
        : `来源：\`${inline(snapshot.chain.flag_source)}\``;
      push(`   - 终点：本步产出的 \`${step.fact_id}\` 是 Flag 所在事实（${source}）。`);
    }
  };
  if (snapshot.chain.steps.length === 0) {
    push("（没有已完成的探索意图）");
  }
  snapshot.chain.steps.forEach((step, index) => showStep(step, index));

  if (snapshot.chain.side_steps.length > 0) {
    push(
      "",
      "### 旁支探索（未进入利用链）",
      `以下 ${snapshot.chain.side_steps.length} 个已结束意图不在 Flag 所在事实的依赖闭包内，` +
        "保留作对照；它们不构成利用链的一步。",
    );
    for (const step of snapshot.chain.side_steps) {
      const label = brief(step.description) || step.intent_id;
      const fact = step.fact_description === null
        ? "未产出事实"
        : `\`${step.fact_id}\`：${brief(step.fact_description)}`;
      const outcome = step.outcome === null ? "" : `（结果：${inline(step.outcome)}）`;
      push(`- **${label}** → ${fact}${outcome}`);
    }
  }

  if (snapshot.open_intents.length > 0) {
    push("", "### 尚未完成的探索");
    for (const intent of snapshot.open_intents) {
      push(`- \`${intent.id}\`：${inline(intent.description)}`);
    }
  }

  push("", "## 关键发现（当前有效事实清单）");
  if (snapshot.findings.length === 0) {
    push("（没有当前有效事实）");
  }
  for (const finding of snapshot.findings) {
    const evidence = finding.evidence.length === 0
      ? ""
      : `（证据：${finding.evidence.map((ref) => `\`${ref}\``).join("、")}）`;
    push(`- \`${finding.id}\`：${inline(finding.description)}${evidence}`);
  }

  push("", "## 载荷（Payload）");
  if (snapshot.payloads.length === 0) {
    push("（没有识别到载荷或脚本文件）");
  } else {
    const inlined = snapshot.payloads.filter((payload) => payload.text !== null).length;
    push(
      `（识别到 ${snapshot.payloads_total} 个载荷/脚本文件，此处列出 ${snapshot.payloads.length} 个，` +
        `其中 ${inlined} 个逐字内联；完整附件请从 Writeup 附件包下载。）`,
    );
    for (const payload of snapshot.payloads) {
      push("", `### \`${payload.path}\``);
      push(
        `- ${payload.size} 字节，sha256 ${payload.sha256.slice(0, 12)}…，` +
          `来自 \`${payload.task_id}\``,
      );
      if (payload.referenced_by.length > 0) {
        push(`- 关联事实：${payload.referenced_by.map((id) => `\`${id}\``).join("、")}`);
      }
      if (payload.text !== null) {
        const fence = codeFence(payload.text);
        push("", `${fence}${payload.language ?? ""}`);
        for (const line of payload.text.replace(/\n$/, "").split("\n")) push(line);
        push(fence);
        if (payload.truncated) push("（内容已截断，完整文件见附件包。）");
      } else if (payload.binary) {
        push("（二进制载荷，未内联，完整文件见附件包。）");
      } else {
        push("（内容未读取：工作区未挂载或文件已被清理，完整文件见附件包。）");
      }
    }
    if (snapshot.payloads_truncated) {
      push("", `…其余 ${snapshot.payloads_total - snapshot.payloads.length} 个载荷文件见附件包。`);
    }
  }

  push("", "## 被取代的判断");
  if (snapshot.supersessions.length === 0) {
    push("（没有取代记录）");
  }
  for (const edge of snapshot.supersessions) {
    push(
      `- \`${edge.fact_id}\` → \`${edge.superseded_by}\`：` +
        `${inline(edge.description)} → ${inline(edge.superseded_by_description)}`,
    );
  }

  push("", "## 提示");
  if (snapshot.hints.length === 0) {
    push("（没有提示）");
  }
  for (const hint of snapshot.hints) {
    push(`- （${inline(hint.creator)}）${inline(hint.content)}`);
  }

  push("", "## Flag 与校验");
  if (snapshot.flag === null) {
    push("- Flag：未捕获");
    if (snapshot.flag_suspects.length > 0) {
      push(
        `- 只扫描到疑似占位或截断的 flag 文本：${snapshot.flag_suspects
          .map((value) => `\`${value}\``)
          .join("、")}`,
      );
    }
  } else {
    push(`- Flag：\`${snapshot.flag.value}\``);
    push(`- 来源：\`${snapshot.flag.source}\``);
    if (snapshot.flag.alternatives !== undefined && snapshot.flag.alternatives.length > 0) {
      push(
        `- 其他候选：${snapshot.flag.alternatives.map((value) => `\`${value}\``).join("、")}`,
      );
    }
  }
  push(`- 校验策略：${snapshot.verification.kind}`);
  const latest = snapshot.verification.latest;
  if (latest === null) {
    push("- 最近校验：无记录");
  } else {
    push(
      `- 最近校验：${latest.ok ? "通过" : "未通过"}（${latest.checked_at}）` +
        (latest.flag_count !== null && latest.flag_got_count !== null
          ? `，计数 ${latest.flag_got_count}/${latest.flag_count}`
          : ""),
    );
    if (inline(latest.detail) !== "") push(`- 校验说明：${inline(latest.detail)}`);
  }

  push("", "## 执行统计");
  const runs = snapshot.runs;
  push(
    `- 运行：${runs.runs} 次（结束 ${runs.finished}，成功 ${runs.succeeded}，` +
      `失败 ${runs.failed}）`,
  );
  push(`- Token：${runs.tokens}`);
  push(`- 成本：$${runs.cost_usd.toFixed(6)}`);
  push("", ...table(
    ["worker", "运行", "成功", "Token"],
    runs.by_worker.map((group) => [
      cell(group.worker),
      String(group.runs),
      String(group.succeeded),
      String(group.tokens),
    ]),
  ));
  push("", ...table(
    ["model", "运行", "成功", "Token"],
    runs.by_model.map((group) => [
      group.model === null ? "（未上报）" : cell(group.model),
      String(group.runs),
      String(group.succeeded),
      String(group.tokens),
    ]),
  ));

  push("", "## 附录：证据文件");
  if (snapshot.artifacts.length === 0) {
    push("（没有登记工件）");
  }
  for (const artifact of snapshot.artifacts) {
    push(
      `- \`${artifact.path}\`（${artifact.size} 字节，sha256 ${artifact.sha256.slice(0, 12)}…，` +
        `来自 \`${artifact.task_id}\`）`,
    );
  }
  if (snapshot.artifacts_truncated) {
    push(`- …仅列出前 ${snapshot.artifacts.length} 个文件`);
  }

  push("", "_本 Writeup 由 Cairn 控制面依据图中数据生成；模型撰写版只重组事实，不新增未经核实的内容。_");
  return `${lines.join("\n")}\n`;
}

/**
 * The instruction pair used for the model-written variant. The draft is part of the prompt
 * so the model rewrites recorded data instead of inventing steps.
 */
export function renderProjectWriteupPrompt(snapshot: ProjectWriteupSnapshot): string {
  return [
    "你是 CTF 复盘写手。请把下面这份由控制面生成的中文 Writeup 草稿重写为一篇可直接发布的中文 Writeup。",
    "",
    "# 硬性要求",
    "- 全程使用简体中文；技术名词（如 SQLi、SSTI、pickle）可以保留英文。",
    "- 只使用草稿中出现的事实、证据路径与 Flag。不得补充草稿里没有的利用细节、工具版本或结论。",
    "- 证据不足或尚未完成的环节要如实写成“未验证”“未完成”，不要写成已成功。",
    "- 保留草稿里的 Flag 原文，逐字符照抄，不要改写、脱敏或截断。",
    "- 草稿的 Flag 段落若标注“疑似占位或截断”，那些文本不是已拿到的 Flag：照实写“尚未拿到可确认的 Flag”，" +
      "不得把占位串当成答案，也不得自己拼出一个看起来完整的 Flag。",
    "- 草稿的“载荷（Payload）”章节给出脚本与 payload 原文：引用时同样逐字符照抄，" +
      "不得改写、补全或自己编造；只登记了路径或标注未内联的载荷，就照实说附件包里有这个文件，不要虚构内容。",
    "- 草稿的「攻击路径（利用链）」已按 Fact 依赖边排好顺序，每一步写明前置事实、产出的观察、证据与复现脚本。" +
      "重写时必须沿用这个顺序逐步展开，只写链上的步骤；标在「旁支探索」里的内容不要混进利用链，只放进复盘段。",
    "- 利用链的每一步至少写清四件事：前置（依赖草稿里的哪条已确认观察）、操作（引用草稿记录的载荷或脚本路径与原文）、" +
      "结果（事实原文里的判定或输出）、证据文件路径。读者应能按这个顺序重放，而不是只看到抽象概括。",
    "- 草稿给出「复现脚本」路径时，照抄该路径并说明它能从附件包取得；不得只写“使用脚本”这类抽象描述。",
    "- 草稿里写成否定结论的观察（未取得、不成立、不可用、失败）不得写成成功，也不要为了连贯而省略" +
      "“上一步失败后改走哪条路”。",
    "- 不得写入任何凭据、token、cookie、API key 或内网敏感地址（草稿里授权范围内的目标地址除外）。",
    "- 结构建议：题目概述 → 信息收集 → 利用链（按草稿依赖顺序，逐步可复现）→ 获取 Flag → " +
      "复现清单（按顺序列出脚本与关键请求）→ 复盘与遗留问题。",
    "- 允许使用 Markdown 标题、列表和代码块；输出正文，不要包裹在 JSON 或额外说明里。",
    "- 篇幅控制在 2500 字以内；利用链要写全，信息收集与复盘可以压缩。",
    "",
    "# 草稿",
    renderProjectWriteupMarkdown(snapshot).trimEnd(),
  ].join("\n");
}

export function saveProjectWriteup(
  conn: Database,
  input: { projectId: string; markdown: string; model: string | null; createdAt?: string },
): ProjectWriteupRecord {
  run(
    conn,
    `INSERT INTO project_writeups (project_id, markdown, model, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       markdown = excluded.markdown,
       model = excluded.model,
       created_at = excluded.created_at`,
    input.projectId,
    input.markdown,
    input.model,
    input.createdAt ?? utcnow(),
  );
  const row = get<WriteupRow>(
    conn,
    "SELECT * FROM project_writeups WHERE project_id = ?",
    input.projectId,
  );
  if (row === undefined || row === null) {
    throw new Error("writeup was not stored");
  }
  return {
    project_id: row.project_id,
    markdown: row.markdown,
    model: row.model,
    created_at: row.created_at,
  };
}

export function getProjectWriteup(
  conn: Database,
  projectId: string,
): ProjectWriteupRecord | null {
  const row = get<WriteupRow>(
    conn,
    "SELECT * FROM project_writeups WHERE project_id = ?",
    projectId,
  );
  if (row === null) return null;
  return {
    project_id: row.project_id,
    markdown: row.markdown,
    model: row.model,
    created_at: row.created_at,
  };
}

export function clearProjectWriteup(conn: Database, projectId: string): void {
  run(conn, "DELETE FROM project_writeups WHERE project_id = ?", projectId);
}

export interface ProjectWriteupRecord {
  project_id: string;
  markdown: string;
  model: string | null;
  created_at: string;
}

interface WriteupRow {
  project_id: string;
  markdown: string;
  model: string | null;
  created_at: string;
}

interface LiteRunRow {
  id: string;
  task_id: string;
  worker: string;
  model: string | null;
  outcome: string | null;
}

function listRunsLite(conn: Database, projectId: string): LiteRunRow[] {
  return all<LiteRunRow>(
    conn,
    "SELECT id, task_id, worker, model, outcome FROM runs WHERE project_id = ?",
    projectId,
  );
}

function chainIntro(chain: WriteupChain): string[] {
  if (chain.steps.length === 0) return [];
  if (chain.anchored) {
    const terminal = chain.flag_fact === null ? "" : `终点为 \`${chain.flag_fact}\`。`;
    const source = chain.flag_source === null || chain.flag_source === ""
      ? ""
      : `Flag 来源：\`${inline(chain.flag_source)}\`。`;
    const lines = [
      `利用链由记录中的 Fact 依赖边还原：共 ${chain.steps.length} 个已结束意图构成 Flag 事实的依赖闭包，` +
        `按依赖顺序排列，每个前置事实都先于使用它的步骤。${terminal}${source}`,
    ];
    if (chain.side_steps.length > 0) {
      lines.push(`另有 ${chain.side_steps.length} 个已结束意图不在此闭包内，列在「旁支探索」。`);
    }
    if (chain.steps.some((step) => step.payload_refs.length > 0)) {
      lines.push(
        "「复现脚本」是该步运行写下、且被判为载荷/脚本的工件路径；逐字原文见「载荷（Payload）」，" +
          "未内联或超出上限的文件以附件包为准。",
      );
    }
    return lines;
  }
  return [
    `未定位到 Flag 所在事实；以下按 Fact 依赖顺序列出全部 ${chain.steps.length} 个已结束意图，` +
      "每个前置事实都先于使用它的步骤。",
  ];
}

/** Up to six payload paths per step; the rest are still in the snapshot and the archive. */
function payloadRefList(refs: readonly string[]): string {
  const max = 6;
  const shown = refs.slice(0, max).map((ref) => `\`${ref}\``).join("、");
  return refs.length <= max ? shown : `${shown} 等 ${refs.length} 个`;
}

function snapshotVerdict(snapshot: ProjectWriteupSnapshot): string {
  const parts: string[] = [];
  if (snapshot.flag === null) {
    parts.push(
      snapshot.flag_suspects.length > 0
        ? "本项目尚未记录到可信 Flag（只扫描到疑似占位或截断的文本）"
        : "本项目尚未记录到 Flag",
    );
  } else {
    const alternatives = snapshot.flag.alternatives ?? [];
    parts.push(
      `本项目已拿到 Flag \`${snapshot.flag.value}\`` +
        (alternatives.length > 0 ? `，另有 ${alternatives.length} 个候选` : ""),
    );
  }
  const latest = snapshot.verification.latest;
  if (latest === null) {
    parts.push(`完成校验（策略 ${snapshot.verification.kind}）尚无记录`);
  } else if (latest.ok) {
    parts.push(
      latest.flag_count !== null && latest.flag_got_count !== null
        ? `题目校验通过（${latest.flag_got_count}/${latest.flag_count}）`
        : "题目校验通过",
    );
  } else {
    parts.push(
      `题目校验未通过${inline(latest.detail) === "" ? "" : `：${inline(latest.detail)}`}`,
    );
  }
  parts.push(
    `共完成 ${snapshot.steps.length} 个探索意图，` +
      `留下 ${snapshot.findings.length} 条当前有效事实`,
  );
  return `${parts.join("；")}。`;
}

function parseRefs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Artifact paths reach this module in two shapes: the index stores them relative to
 * `artifacts/` with forward slashes, `evidence_refs` stores them with the `artifacts/`
 * prefix and whatever separator the worker wrote. Normalizing both makes the join work.
 */
function normalizeArtifactPath(path: string): string {
  let value = path.replaceAll("\\", "/").trim();
  while (value.startsWith("./")) value = value.slice(2);
  if (value.startsWith("artifacts/")) value = value.slice("artifacts/".length);
  return value;
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Fenced-block language for a payload path; null for containers and binary formats. */
export function payloadLanguage(path: string): string | null {
  const normalized = normalizeArtifactPath(path);
  const language = PAYLOAD_EXTENSION_LANGUAGES.get(extensionOf(normalized));
  return language === undefined ? null : language;
}

/** True when an artifact looks like something the worker threw at the target. */
export function isWriteupPayloadPath(path: string): boolean {
  const normalized = normalizeArtifactPath(path);
  if (normalized === "") return false;
  const extension = extensionOf(normalized);
  if (EVIDENCE_DUMP_EXTENSIONS.has(extension)) return false;
  if (PAYLOAD_NAME_PATTERN.test(normalized)) return true;
  return PAYLOAD_EXTENSION_LANGUAGES.has(extension);
}

/** Cuts long text at a line boundary so a fenced block never ends mid-character. */
function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = value.slice(0, maxChars);
  const newline = head.lastIndexOf("\n");
  return newline > maxChars / 2 ? head.slice(0, newline) : head;
}

/** A fence longer than any run of backticks inside the quoted text. */
function codeFence(text: string): string {
  let length = 3;
  while (text.includes("`".repeat(length))) length += 1;
  return "`".repeat(length);
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["（无数据）"];
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  return [header, divider, ...rows.map((row) => `| ${row.join(" | ")} |`)];
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cell(value: string): string {
  return inline(value).replace(/\|/g, "\\|");
}
