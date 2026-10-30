import type { Database } from "bun:sqlite";

import { all } from "./db";
import { HttpError } from "./errors";
import type { FactRow, HintRow, IntentRow, ProjectRow } from "./services";
import {
  expireReasonLeases,
  expireWorkers,
  getProjectOr404,
} from "./services";
import { map, renderYaml, type YamlMap, type YamlValue } from "./yaml";

/**
 * Cairn renders export timestamps in the server's local timezone as
 * `%Y-%m-%d %H:%M:%S`; unparseable values pass through unchanged.
 */
export function formatExportTimestamp(value: string | null): string | null {
  if (!value) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (part: number): string => String(part).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export interface ProjectData {
  project: ProjectRow;
  facts: FactRow[];
  hints: HintRow[];
  intents: IntentRow[];
  sourcesByIntent: Map<string, string[]>;
}

export function loadProjectData(conn: Database, projectId: string): ProjectData {
  expireWorkers(conn, projectId);
  expireReasonLeases(conn, projectId);
  const project = getProjectOr404(conn, projectId);

  const facts = all<FactRow>(
    conn,
    "SELECT id, description FROM facts WHERE project_id = ?",
    projectId,
  );
  const hints = all<HintRow>(
    conn,
    "SELECT content, creator, created_at FROM hints WHERE project_id = ? ORDER BY created_at",
    projectId,
  );
  const intents = all<IntentRow>(
    conn,
    "SELECT * FROM intents WHERE project_id = ? ORDER BY created_at",
    projectId,
  );

  const sourcesByIntent = new Map<string, string[]>();
  for (const intent of intents) {
    const rows = all<{ fact_id: string }>(
      conn,
      "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
      intent.id,
      projectId,
    );
    sourcesByIntent.set(
      intent.id,
      rows.map((row) => row.fact_id),
    );
  }

  return { project, facts, hints, intents, sourcesByIntent };
}

/**
 * Options for `exportProjectSliceYaml`.
 *
 * Slicing is opt-in and only used for explore/conclude task snapshots: reason and
 * bootstrap need the global picture. The focus intent is always included together with
 * all of its source facts; other open intents are included so parallel workers can see
 * each other's directions. Provenance (the intent that produced an included fact) is
 * added on a best-effort basis up to the caps.
 */
export interface GraphSliceOptions {
  /** The intent the task is working on; must exist in the project. */
  focusIntentId: string;
  maxFacts: number;
  maxIntents: number;
}

export function exportProjectSliceYaml(
  conn: Database,
  projectId: string,
  options: GraphSliceOptions,
): string {
  const { project, facts, hints, intents, sourcesByIntent } = loadProjectData(
    conn,
    projectId,
  );
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));
  const focus = intentById.get(options.focusIntentId);
  if (focus === undefined) {
    throw new Error(`focus intent not found: ${options.focusIntentId}`);
  }

  const producerByFact = new Map<string, IntentRow>();
  for (const intent of intents) {
    if (intent.to_fact_id !== null && !producerByFact.has(intent.to_fact_id)) {
      producerByFact.set(intent.to_fact_id, intent);
    }
  }

  const includedFacts = new Set<string>();
  for (const id of ["origin", "goal"]) {
    if (factById.has(id)) includedFacts.add(id);
  }
  const includedIntents = new Set<string>();

  const addIntent = (intent: IntentRow, mandatory: boolean): boolean => {
    if (includedIntents.has(intent.id)) return true;
    const sources = sourcesByIntent.get(intent.id) ?? [];
    if (!mandatory) {
      let additions = 0;
      for (const factId of sources) {
        if (!includedFacts.has(factId) && factById.has(factId)) additions += 1;
      }
      if (includedIntents.size >= options.maxIntents) return false;
      if (includedFacts.size + additions > options.maxFacts) return false;
    }
    includedIntents.add(intent.id);
    for (const factId of sources) {
      if (factById.has(factId)) includedFacts.add(factId);
    }
    return true;
  };

  // The focus intent and every other open intent are mandatory: they define the work
  // that is currently in flight, so their sources are never dropped by the caps.
  const mandatory: IntentRow[] = [focus];
  for (const intent of intents) {
    if (intent.id !== focus.id && intent.to_fact_id === null) mandatory.push(intent);
  }
  for (const intent of mandatory) addIntent(intent, true);

  // Provenance closure: walk the sources of every included fact back to the intents
  // that produced them. This is best-effort once a cap is reached.
  const queue = [...includedFacts];
  const queued = new Set(queue);
  while (queue.length > 0) {
    const factId = queue.shift()!;
    const producer = producerByFact.get(factId);
    if (producer === undefined || includedIntents.has(producer.id)) continue;
    if (!addIntent(producer, false)) continue;
    for (const sourceId of sourcesByIntent.get(producer.id) ?? []) {
      if (factById.has(sourceId) && !includedFacts.has(sourceId)) {
        includedFacts.add(sourceId);
      }
      if (factById.has(sourceId) && !queued.has(sourceId)) {
        queued.add(sourceId);
        queue.push(sourceId);
      }
    }
  }

  const truncated =
    includedFacts.size > options.maxFacts ||
    includedIntents.size > options.maxIntents ||
    [...includedFacts].some((factId) => {
      const producer = producerByFact.get(factId);
      return producer !== undefined && !includedIntents.has(producer.id);
    });

  const entries: Array<[string, YamlValue]> = [
    [
      "project",
      projectMap(project, facts),
    ],
    [
      "slice",
      map([
        ["focus_intent", options.focusIntentId],
        ["included_facts", includedFacts.size],
        ["included_intents", includedIntents.size],
        ["max_facts", options.maxFacts],
        ["max_intents", options.maxIntents],
        ["truncated", truncated],
      ]),
    ],
  ];

  if (hints.length > 0) {
    entries.push(["hints", hintEntries(hints)]);
  }

  entries.push([
    "facts",
    facts
      .filter((fact) => includedFacts.has(fact.id))
      .map((fact) =>
        map([
          ["id", fact.id],
          ["description", fact.description],
        ]),
      ),
  ]);

  const slicedIntents = intents.filter((intent) => includedIntents.has(intent.id));
  if (slicedIntents.length > 0) {
    entries.push([
      "intents",
      slicedIntents.map((intent) => intentEntry(intent, sourcesByIntent)),
    ]);
  }

  return renderYaml(map(entries));
}

export function exportProjectYaml(conn: Database, projectId: string): string {
  const { project, facts, hints, intents, sourcesByIntent } = loadProjectData(
    conn,
    projectId,
  );

  const entries: Array<[string, YamlValue]> = [
    ["project", projectMap(project, facts)],
  ];

  if (hints.length > 0) {
    entries.push(["hints", hintEntries(hints)]);
  }

  entries.push([
    "facts",
    facts.map((fact) =>
      map([
        ["id", fact.id],
        ["description", fact.description],
      ]),
    ),
  ]);

  if (intents.length > 0) {
    entries.push([
      "intents",
      intents.map((intent) => intentEntry(intent, sourcesByIntent)),
    ]);
  }

  return renderYaml(map(entries));
}

/** Hard ceiling for `GET /projects/{id}/subgraph?depth=`; deeper walks cover most graphs. */
export const SUBGRAPH_MAX_DEPTH = 4;
export const SUBGRAPH_DEFAULT_DEPTH = 2;
export const SUBGRAPH_DEFAULT_FACTS = 60;
export const SUBGRAPH_DEFAULT_INTENTS = 40;

export interface SubgraphOptions {
  /** A fact or intent id; the kind is detected from the project graph. */
  around: string;
  depth: number;
  maxFacts: number;
  maxIntents: number;
}

export interface SubgraphSelection {
  project: ProjectRow;
  focus: { kind: "fact" | "intent"; id: string };
  depth: number;
  hints: HintRow[];
  /** Priority order: origin/goal, focus, intent sources, then by hop distance. */
  facts: FactRow[];
  intents: IntentRow[];
  sourcesByIntent: Map<string, string[]>;
  truncated: boolean;
}

/**
 * Causal neighbourhood around one node for context budgeting.
 *
 * Every open intent is a seed so parallel work in flight is always visible, then the walk
 * alternates fact→intent and intent→fact edges up to `depth` hops. When the caps bite the
 * priority is origin/goal, the focus node, open intents, then the nearest nodes. Output is
 * deterministic for identical graphs.
 */
export function selectSubgraph(
  conn: Database,
  projectId: string,
  options: SubgraphOptions,
): SubgraphSelection {
  const { project, facts, hints, intents, sourcesByIntent } = loadProjectData(
    conn,
    projectId,
  );
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const intentById = new Map(intents.map((intent) => [intent.id, intent]));

  const focusIntent = intentById.get(options.around);
  const focusFact =
    focusIntent === undefined ? factById.get(options.around) : undefined;
  if (focusIntent === undefined && focusFact === undefined) {
    throw new HttpError(404, `graph node not found: ${options.around}`);
  }
  const focus =
    focusIntent !== undefined
      ? { kind: "intent" as const, id: focusIntent.id }
      : { kind: "fact" as const, id: focusFact!.id };

  const producerByFact = new Map<string, IntentRow>();
  for (const intent of intents) {
    if (intent.to_fact_id !== null && !producerByFact.has(intent.to_fact_id)) {
      producerByFact.set(intent.to_fact_id, intent);
    }
  }
  const consumersByFact = new Map<string, IntentRow[]>();
  for (const intent of intents) {
    for (const factId of sourcesByIntent.get(intent.id) ?? []) {
      const list = consumersByFact.get(factId);
      if (list === undefined) consumersByFact.set(factId, [intent]);
      else list.push(intent);
    }
  }

  const factDepth = new Map<string, number>();
  const intentDepth = new Map<string, number>();
  const queue: Array<{ factId: string | null; intentId: string | null; depth: number }> = [];
  const seedFact = (factId: string, depth: number): void => {
    const known = factDepth.get(factId);
    if (known !== undefined && known <= depth) return;
    factDepth.set(factId, depth);
    queue.push({ factId, intentId: null, depth });
  };
  const seedIntent = (intentId: string, depth: number): void => {
    const known = intentDepth.get(intentId);
    if (known !== undefined && known <= depth) return;
    intentDepth.set(intentId, depth);
    queue.push({ factId: null, intentId, depth });
  };

  if (focus.kind === "fact") seedFact(focus.id, 0);
  else seedIntent(focus.id, 0);
  for (const intent of intents) {
    // Open intents are the work in flight; showing them keeps parallel workers oriented
    // even when they sit outside the focus neighbourhood.
    if (intent.to_fact_id === null) seedIntent(intent.id, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= options.depth) continue;
    const next = current.depth + 1;
    if (current.intentId !== null) {
      const intent = intentById.get(current.intentId)!;
      for (const factId of sourcesByIntent.get(intent.id) ?? []) {
        if (factById.has(factId)) seedFact(factId, next);
      }
      if (intent.to_fact_id !== null && factById.has(intent.to_fact_id)) {
        seedFact(intent.to_fact_id, next);
      }
      continue;
    }
    const factId = current.factId!;
    const producer = producerByFact.get(factId);
    if (producer !== undefined) seedIntent(producer.id, next);
    for (const consumer of consumersByFact.get(factId) ?? []) {
      seedIntent(consumer.id, next);
    }
  }

  const intentTier = (intent: IntentRow): number => {
    if (focus.kind === "intent" && intent.id === focus.id) return 0;
    return intent.to_fact_id === null ? 1 : 2;
  };
  const orderedIntents = intents
    .filter((intent) => intentDepth.has(intent.id))
    .sort((left, right) => {
      const tier = intentTier(left) - intentTier(right);
      if (tier !== 0) return tier;
      const depth = intentDepth.get(left.id)! - intentDepth.get(right.id)!;
      if (depth !== 0) return depth;
      return compareIds(left.id, right.id);
    });
  const keptIntents = orderedIntents.slice(0, options.maxIntents);
  let truncated = orderedIntents.length > keptIntents.length;

  const orderedFacts: string[] = [];
  const taken = new Set<string>();
  const addFact = (factId: string): void => {
    if (!factById.has(factId) || taken.has(factId)) return;
    taken.add(factId);
    orderedFacts.push(factId);
  };
  // origin/goal are the project header in every export, so they come first and the
  // HTTP layer refuses caps too small to hold both.
  addFact("origin");
  addFact("goal");
  if (focus.kind === "fact") addFact(focus.id);
  for (const intent of keptIntents) {
    // Only reorder facts the walk already reached; an intent one hop inside the cap can
    // still produce a fact one hop outside it, and that fact must stay out.
    for (const factId of sourcesByIntent.get(intent.id) ?? []) {
      if (factDepth.has(factId)) addFact(factId);
    }
    if (intent.to_fact_id !== null && factDepth.has(intent.to_fact_id)) {
      addFact(intent.to_fact_id);
    }
  }
  for (const fact of facts
    .filter((fact) => factDepth.has(fact.id) && !taken.has(fact.id))
    .sort((left, right) => {
      const depth = factDepth.get(left.id)! - factDepth.get(right.id)!;
      if (depth !== 0) return depth;
      return compareIds(left.id, right.id);
    })) {
    addFact(fact.id);
  }

  const keptFactIds = orderedFacts.slice(0, options.maxFacts);
  if (orderedFacts.length > keptFactIds.length) truncated = true;

  return {
    project,
    focus,
    depth: options.depth,
    hints,
    facts: keptFactIds.map((factId) => factById.get(factId)!),
    intents: [...keptIntents].sort((left, right) => {
      if (left.created_at !== right.created_at) {
        return left.created_at < right.created_at ? -1 : 1;
      }
      return compareIds(left.id, right.id);
    }),
    sourcesByIntent,
    truncated,
  };
}

export function exportProjectSubgraphYaml(
  conn: Database,
  projectId: string,
  options: SubgraphOptions,
): string {
  const selection = selectSubgraph(conn, projectId, options);
  const entries: Array<[string, YamlValue]> = [
    ["project", projectMap(selection.project, selection.facts)],
    [
      "slice",
      map([
        ["around", selection.focus.id],
        ["focus_kind", selection.focus.kind],
        ["depth", selection.depth],
        ["included_facts", selection.facts.length],
        ["included_intents", selection.intents.length],
        ["max_facts", options.maxFacts],
        ["max_intents", options.maxIntents],
        ["truncated", selection.truncated],
      ]),
    ],
  ];

  if (selection.hints.length > 0) {
    entries.push(["hints", hintEntries(selection.hints)]);
  }

  entries.push([
    "facts",
    selection.facts.map((fact) =>
      map([
        ["id", fact.id],
        ["description", fact.description],
      ]),
    ),
  ]);

  if (selection.intents.length > 0) {
    entries.push([
      "intents",
      selection.intents.map((intent) => intentEntry(intent, selection.sourcesByIntent)),
    ]);
  }

  return renderYaml(map(entries));
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function projectMap(project: ProjectRow, facts: FactRow[]): YamlMap {
  let origin = "";
  let goal = "";
  for (const fact of facts) {
    if (fact.id === "origin") {
      origin = fact.description;
    } else if (fact.id === "goal") {
      goal = fact.description;
    }
  }
  return map([
    ["title", project.title],
    ["origin", origin],
    ["goal", goal],
    ["bootstrap_enabled", Boolean(project.bootstrap_enabled)],
  ]);
}

function hintEntries(hints: HintRow[]): YamlValue[] {
  return hints.map((hint) =>
    map([
      ["content", hint.content],
      ["creator", hint.creator],
      ["created_at", formatExportTimestamp(hint.created_at)],
    ]),
  );
}

function intentEntry(
  intent: IntentRow,
  sourcesByIntent: Map<string, string[]>,
): YamlValue {
  return map([
    ["from", sourcesByIntent.get(intent.id) ?? []],
    ["to", intent.to_fact_id],
    ["description", intent.description],
    ["creator", intent.creator],
    ["worker", intent.worker],
    ["created_at", formatExportTimestamp(intent.created_at)],
    ["concluded_at", formatExportTimestamp(intent.concluded_at)],
  ]);
}

interface TimelineEvent {
  timestamp: string;
  order: number;
  text: string;
}

export function exportProjectTimeline(conn: Database, projectId: string): string {
  const { project, facts, hints, intents, sourcesByIntent } = loadProjectData(
    conn,
    projectId,
  );

  const factsById = new Map(facts.map((fact) => [fact.id, fact.description]));
  const events: TimelineEvent[] = [];
  let order = 0;

  const origin = factsById.get("origin") ?? "";
  const goal = factsById.get("goal") ?? "";
  const created = formatExportTimestamp(project.created_at) ?? "";
  events.push({
    timestamp: project.created_at || "",
    order: order++,
    text: `[${created}] PROJECT CREATED\n  origin: ${origin}\n  goal: ${goal}`,
  });

  for (const hint of hints) {
    const timestamp = formatExportTimestamp(hint.created_at) ?? "";
    events.push({
      timestamp: hint.created_at || "",
      order: order++,
      text: `[${timestamp}] HINT by ${hint.creator}\n  ${hint.content}`,
    });
  }

  for (const intent of intents) {
    const sources = sourcesByIntent.get(intent.id) ?? [];
    const fromText = sources.join(", ");

    const declaredAt = formatExportTimestamp(intent.created_at) ?? "";
    let meta = `  from: ${fromText}`;
    if (intent.worker && !intent.concluded_at) {
      meta += `\n  worker: ${intent.worker} (in progress)`;
    }
    events.push({
      timestamp: intent.created_at || "",
      order: order++,
      text:
        `[${declaredAt}] INTENT DECLARED ${intent.id} by ${intent.creator}\n` +
        `${meta}\n  ${intent.description}`,
    });

    if (!intent.concluded_at || !intent.to_fact_id) {
      continue;
    }

    const concludedAt = formatExportTimestamp(intent.concluded_at) ?? "";
    const actor = intent.worker || intent.creator;

    const text =
      intent.to_fact_id === "goal"
        ? `[${concludedAt}] PROJECT COMPLETED by ${actor}\n  via: ${intent.id} from ${fromText}`
        : `[${concludedAt}] INTENT CONCLUDED ${intent.id} by ${actor}\n` +
          `  from: ${fromText}\n  produced: ${intent.to_fact_id}\n  ` +
          `${factsById.get(intent.to_fact_id) ?? ""}`;
    events.push({
      timestamp: intent.concluded_at || "",
      order: order++,
      text,
    });
  }

  events.sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp < right.timestamp ? -1 : 1;
    }
    return left.order - right.order;
  });

  return `${events.map((event) => event.text).join("\n\n")}\n`;
}
