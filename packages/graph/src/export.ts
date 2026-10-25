import type { Database } from "bun:sqlite";

import { all } from "./db";
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
