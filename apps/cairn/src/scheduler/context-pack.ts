/** Deterministic M48 selection. A byte target is never a licence to cut pinned state. */
import { map, renderYaml, type ContextSelection, type SnapshotFact, type SnapshotIntent,
  type TaskContextSnapshot, type YamlValue } from "@cairn/graph";
import type { ScopePolicy } from "@cairn/contracts";
import type { ContextPackConfig } from "../config";
import { type StoreCatalog, type StoreSection, STORE_SECTIONS, recordPath, sha256, jsonBytes } from "./context-store";

export type PackFallbackReason = "not_applicable" | "unsupported_template" | "snapshot_unavailable" |
  "snapshot_inconsistent" | "pinned_content_over_budget" | "no_benefit" | "snapshot_write_failed";
export interface ContextPackReport {
  version: 1;
  mode: ContextPackConfig["mode"];
  status: "off" | "not_applicable" | "shadow" | "applied" | "fallback";
  fallback_reason: PackFallbackReason | null;
  legacy_initial_bytes: number;
  candidate_initial_bytes: number | null;
  actual_initial_bytes: number;
  max_initial_bytes: number;
  snapshot_id: string | null;
  selections: ContextSelection[];
}
export interface PackCandidate {
  text: string;
  bytes: number;
  pinned_initial_bytes: number;
  selections: ContextSelection[];
  selected_ids: Record<StoreSection, string[]>;
}
export interface BuildPackInput {
  snapshot: TaskContextSnapshot;
  catalog: StoreCatalog;
  kind: "reason" | "explore";
  focusIntentId?: string;
  scope: ScopePolicy;
  taskId: string;
  taskBudget?: { hard_deadline_seconds: number; soft_deadline_seconds: number | null; max_tool_calls: number | null };
  promptBytes: number;
  maxInitialBytes: number;
  /** Prevent replacing a small legacy input with a larger pack. */
  legacyInitialBytes: number;
  completionPolicy: { evidence_enforcement: string; flag_review: string; off_completion: string; evidence_completion: string };
}
export type BuildPackResult = { status: "ready"; candidate: PackCandidate } |
  { status: "fallback"; reason: PackFallbackReason; candidateInitialBytes: number | null };

function yamlValue(value: unknown): YamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(yamlValue);
  if (typeof value === "object") return map(Object.entries(value).map(([key, item]) => [key, yamlValue(item)]));
  throw new Error("invalid context value");
}

export function buildContextPack(input: BuildPackInput): BuildPackResult {
  const { snapshot, catalog } = input;
  if (catalog.project_id !== snapshot.project.id || catalog.snapshot_id !== sha256(jsonBytes(snapshot))) return { status: "fallback", reason: "snapshot_inconsistent", candidateInitialBytes: null };
  const facts = new Map(snapshot.facts.map((fact) => [fact.id, fact]));
  const focus = input.focusIntentId === undefined ? undefined : snapshot.intents.find((intent) => intent.id === input.focusIntentId);
  if (!facts.has("origin") || !facts.has("goal") || (input.kind === "explore" && focus === undefined)) {
    return { status: "fallback", reason: "snapshot_inconsistent", candidateInitialBytes: null };
  }
  const selected = { facts: [] as SnapshotFact[], intents: [] as SnapshotIntent[],
    attempts: [] as TaskContextSnapshot["attempts"], hints: [] as TaskContextSnapshot["hints"] };
  const ids: Record<StoreSection, Set<string>> = { facts: new Set(), intents: new Set(), attempts: new Set(), hints: new Set() };
  const closure = (sources: readonly string[]): SnapshotFact[] | null => {
    const result: SnapshotFact[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      let id: string | null = source;
      const chain = new Set<string>();
      while (id !== null) {
        if (chain.has(id)) return null;
        chain.add(id);
        const fact = facts.get(id);
        if (fact === undefined) return null;
        if (!seen.has(id) && id !== "origin" && id !== "goal") result.push(fact);
        seen.add(id);
        id = fact.superseded_by;
      }
    }
    return result;
  };
  if (input.kind === "explore") {
    const pinned = closure(focus!.from);
    if (pinned === null) return { status: "fallback", reason: "snapshot_inconsistent", candidateInitialBytes: null };
    selected.facts.push(...pinned);
    pinned.forEach((fact) => ids.facts.add(fact.id));
    selected.intents.push(focus!); ids.intents.add(focus!.id);
  }
  const totals = Object.fromEntries(STORE_SECTIONS.map((section) => [section, snapshot[section].length]));
  const render = () => renderYaml(yamlValue({
    version: 1, task: { id: input.taskId, kind: input.kind, focus_intent_id: focus?.id ?? null, limits: input.taskBudget ?? null },
    snapshot: { id: catalog.snapshot_id, project_id: snapshot.project.id, semantics: "dispatch_snapshot_not_live_state" },
    core: { project: snapshot.project, origin: facts.get("origin")!, goal: snapshot.goal,
      goal_conditions: snapshot.goal_conditions, scope: input.scope, completion_policy: input.completionPolicy,
      reviews: snapshot.reviews, budget: snapshot.budget, delta: snapshot.delta },
    overview: { totals, intent_status: {
      open: snapshot.intents.filter((intent) => intent.status === "open").length,
      abandoned: snapshot.intents.filter((intent) => intent.status === "abandoned").length,
      concluded: snapshot.intents.filter((intent) => intent.status === "concluded").length,
    }, included: { facts: selected.facts.length + 2, intents: selected.intents.length,
      attempts: selected.attempts.length, hints: selected.hints.length },
    omitted_are_unknown_not_absent: true },
    recovery: { root: "context-store", catalog: "context-store/catalog.json", sections: catalog.sections,
      detail_policy: catalog.detail_policy, raw_details: catalog.raw_details,
      ...(catalog.checkpoint_policy === undefined ? {} : { checkpoint_policy: catalog.checkpoint_policy }) },
    ...selected,
  }) as ReturnType<typeof map>);
  let text = render();
  const pinnedInitial = input.promptBytes + Buffer.byteLength(text);
  if (pinnedInitial > input.maxInitialBytes) return { status: "fallback", reason: "pinned_content_over_budget", candidateInitialBytes: pinnedInitial };
  const cap = Math.min(input.maxInitialBytes, input.legacyInitialBytes - 1);
  if (pinnedInitial > cap) return { status: "fallback", reason: "no_benefit", candidateInitialBytes: pinnedInitial };
  type Entry = { section: StoreSection; id: string; record: unknown };
  const tryGroup = (entries: Entry[]) => {
    const added: Entry[] = [];
    for (const entry of entries) {
      if (ids[entry.section].has(entry.id)) continue;
      ids[entry.section].add(entry.id);
      (selected[entry.section] as unknown[]).push(entry.record);
      added.push(entry);
    }
    const next = render();
    if (input.promptBytes + Buffer.byteLength(next) <= cap) { text = next; return; }
    for (const entry of added.reverse()) {
      (selected[entry.section] as unknown[]).pop(); ids[entry.section].delete(entry.id);
    }
  };
  const factEntry = (fact: SnapshotFact): Entry => ({ section: "facts", id: fact.id, record: fact });
  const byRecentFact = (a: SnapshotFact, b: SnapshotFact) =>
    Number(b.status === "current") - Number(a.status === "current") ||
    (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
    Number(b.evidence.status === "provided") - Number(a.evidence.status === "provided") || b.id.localeCompare(a.id);
  const byIntent = (a: SnapshotIntent, b: SnapshotIntent) =>
    (b.priority ?? 50) - (a.priority ?? 50) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
  const focusedAttempts = snapshot.attempts.filter((attempt) => input.kind === "reason" || attempt.intent_id === focus!.id ||
      attempt.memory?.checkpoint.attempts.some((item) => item.fact_refs.some((id) => ids.facts.has(id) || focus!.from.includes(id))))
    .sort((a, b) => Number(b.intent_id === focus?.id) - Number(a.intent_id === focus?.id) ||
      Number(b.memory !== undefined) - Number(a.memory !== undefined) ||
      Number(b.outcome !== "success") - Number(a.outcome !== "success") ||
      b.started_at.localeCompare(a.started_at) || b.run_id.localeCompare(a.run_id));
  let relevantFacts: SnapshotFact[];
  if (input.kind === "reason") relevantFacts = [...snapshot.facts].sort(byRecentFact).filter((fact) => fact.id !== "origin" && fact.id !== "goal");
  else {
    // Two bounded provenance layers beyond the pinned direct/supersede dependencies.
    const neighbourhood = new Set(selected.facts.flatMap((fact) => fact.from));
    for (const id of [...neighbourhood]) facts.get(id)?.from.forEach((source) => neighbourhood.add(source));
    relevantFacts = snapshot.facts.filter((fact) => neighbourhood.has(fact.id) && fact.id !== "origin" && fact.id !== "goal").sort(byRecentFact);
  }
  const relatedIntents = snapshot.intents.filter((intent) => input.kind === "reason" ||
    intent.from.some((source) => ids.facts.has(source) || focus!.from.includes(source)));
  const groups: Entry[][] = [
    focusedAttempts.slice(0, input.kind === "reason" ? 12 : 8).map((record) => ({ section: "attempts", id: record.run_id, record })),
    relatedIntents.filter((intent) => intent.status === "abandoned").sort((a, b) => (b.status_at ?? "").localeCompare(a.status_at ?? "") || b.id.localeCompare(a.id))
      .slice(0, 4).map((record) => ({ section: "intents", id: record.id, record })),
    relatedIntents.filter((intent) => intent.status === "concluded").sort((a, b) => (b.concluded_at ?? "").localeCompare(a.concluded_at ?? "") || b.id.localeCompare(a.id))
      .slice(0, 4).map((record) => ({ section: "intents", id: record.id, record })),
    relevantFacts.slice(0, input.kind === "reason" ? 80 : 24).map(factEntry),
    relatedIntents.filter((intent) => intent.status === "open").sort(byIntent).slice(0, input.kind === "reason" ? 16 : 8)
      .map((record) => ({ section: "intents", id: record.id, record })),
    [...snapshot.hints].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .slice(0, input.kind === "reason" ? 8 : 4).map((record) => ({ section: "hints", id: record.id, record })),
  ];
  // Round-robin prevents a large open frontier from crowding out failures and hints.
  for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index += 1) {
    for (const group of groups) {
      const entry = group[index];
      if (entry === undefined) continue;
      if (entry.section === "facts") {
        const bundle = closure([entry.id]);
        if (bundle !== null) tryGroup(bundle.map(factEntry));
      } else tryGroup([entry]);
    }
  }
  const selectedIds = { facts: ["origin", "goal", ...ids.facts], intents: [...ids.intents],
    attempts: [...ids.attempts], hints: [...ids.hints] };
  const selections: ContextSelection[] = STORE_SECTIONS.map((section) => ({
    section, scope: "project", candidates: snapshot[section].length, selected: selectedIds[section].length,
    limits: { maxInitialBytes: input.maxInitialBytes },
    policy: section === "attempts" && snapshot.attempts.some((attempt) => attempt.memory !== undefined)
      ? "structured_attempt_memory_balanced_v1"
      : input.kind === "reason" ? "recent_current_balanced_frontier_v1" : "pinned_focus_supersedes_bounded_provenance_v1",
  }));
  return { status: "ready", candidate: { text, bytes: Buffer.byteLength(text),
    pinned_initial_bytes: pinnedInitial, selections, selected_ids: selectedIds } };
}

export function contextPackLog(report: ContextPackReport): string | null {
  if (report.status === "off") return null;
  return `context-pack ${report.status} mode=${report.mode} reason=${report.fallback_reason ?? "none"}` +
    ` legacy_initial_bytes=${report.legacy_initial_bytes} candidate_initial_bytes=${report.candidate_initial_bytes ?? "unknown"}` +
    ` actual_initial_bytes=${report.actual_initial_bytes} max_initial_bytes=${report.max_initial_bytes}`;
}

/** A fixed locator; never put user IDs directly into filesystem paths. */
export function recoveryLocator(section: StoreSection, id: string): string {
  return `context-store/${recordPath(section, id)}`;
}
