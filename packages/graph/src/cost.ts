/**
 * Cost attribution and causal chain for one project (M13b).
 *
 * The report is read-only and lives outside the Cairn graph. It answers two questions
 * without inventing new graph semantics:
 *
 * - which run paid for each fact, and which reason/proposal run created the intent that
 *   led to it;
 * - how runs, intents and facts are connected (run → intent → run → fact, plus the
 *   source-fact edges already stored on intents).
 *
 * Allocation rule: every run's usage is split evenly across its direct outputs (intents
 * it created and facts it produced). A reason/proposal run with two created intents gives
 * each half; an explore run with one fact gives that fact the full amount. An intent's
 * creation share is then split across the facts that intent produced. Unallocated usage
 * (failed runs, intents that produced no fact, reason turns with no output) stays in
 * `unattributed`. This makes fact totals a partition of the project total, while intent
 * totals intentionally overlap with their execution runs and must not be summed with it.
 */

import type { Database } from "bun:sqlite";

import { all } from "./db";
import { getProjectDetail } from "./commands";
import type {
  CostAttribution,
  CostFact,
  CostIntent,
  CostKind,
  CostRun,
  CausalEdge,
  ProjectCostReport,
  Run,
} from "./models";
import { listProjectIntentMeta } from "./proposals";
import { listProjectRuns } from "./runs";
import { getProjectOr404 } from "./services";

interface FactMetaRow {
  fact_id: string;
  run_id: string | null;
  evidence_refs: string;
  evidence_status: string;
}

interface Output {
  kind: "intent" | "fact";
  id: string;
}

export function buildProjectCostReport(conn: Database, projectId: string): ProjectCostReport {
  getProjectOr404(conn, projectId);
  const detail = getProjectDetail(conn, projectId);
  const runs = listProjectRuns(conn, projectId);
  const intentMeta = listProjectIntentMeta(conn, projectId);
  const metaRows = all<FactMetaRow>(
    conn,
    "SELECT fact_id, run_id, evidence_refs, evidence_status FROM fact_meta WHERE project_id = ?",
    projectId,
  );

  const runById = new Map(runs.map((run) => [run.id, run]));
  const intentById = new Map(detail.intents.map((intent) => [intent.id, intent]));
  const factMetaById = new Map(metaRows.map((row) => [row.fact_id, row]));
  const intentMetaById = new Map(intentMeta.map((meta) => [meta.intent_id, meta]));

  const facts = [...detail.facts].sort((left, right) => left.id.localeCompare(right.id));
  const intents = [...detail.intents].sort((left, right) => left.id.localeCompare(right.id));
  const factIds = new Set(facts.map((fact) => fact.id));

  // Run outputs. Intent creation comes first so the token remainder is deterministic.
  const createdIntentsByRun = new Map<string, string[]>();
  const createdFactsByRun = new Map<string, string[]>();
  for (const meta of intentMeta) {
    if (meta.origin_run_id === null || !runById.has(meta.origin_run_id)) continue;
    if (!intentById.has(meta.intent_id)) continue;
    const list = createdIntentsByRun.get(meta.origin_run_id) ?? [];
    list.push(meta.intent_id);
    createdIntentsByRun.set(meta.origin_run_id, list);
  }
  for (const list of createdIntentsByRun.values()) list.sort();
  for (const fact of facts) {
    const runId = factMetaById.get(fact.id)?.run_id ?? null;
    if (runId === null || !runById.has(runId)) continue;
    const list = createdFactsByRun.get(runId) ?? [];
    list.push(fact.id);
    createdFactsByRun.set(runId, list);
  }
  for (const list of createdFactsByRun.values()) list.sort();

  const intentCreationTokens = new Map<string, number>();
  const intentCreationCost = new Map<string, number>();
  const factDirectTokens = new Map<string, number>();
  const factDirectCost = new Map<string, number>();

  for (const run of runs) {
    const outputs: Output[] = [
      ...(createdIntentsByRun.get(run.id) ?? []).map((id) => ({ kind: "intent" as const, id })),
      ...(createdFactsByRun.get(run.id) ?? []).map((id) => ({ kind: "fact" as const, id })),
    ];
    outputs.forEach((output, index) => {
      const tokens = splitInteger(run.total_tokens, outputs.length, index);
      const cost = outputs.length === 0 ? 0 : run.cost_usd / outputs.length;
      if (output.kind === "intent") {
        add(intentCreationTokens, output.id, tokens);
        add(intentCreationCost, output.id, cost);
      } else {
        add(factDirectTokens, output.id, tokens);
        add(factDirectCost, output.id, cost);
      }
    });
  }

  // Facts produced by each intent (through the intent id stored on the producing run).
  const factsByIntent = new Map<string, string[]>();
  for (const fact of facts) {
    const runId = factMetaById.get(fact.id)?.run_id ?? null;
    if (runId === null) continue;
    const intentId = runById.get(runId)?.intent_id ?? null;
    if (intentId === null || !intentById.has(intentId)) continue;
    const list = factsByIntent.get(intentId) ?? [];
    list.push(fact.id);
    factsByIntent.set(intentId, list);
  }
  for (const list of factsByIntent.values()) list.sort();

  // Reallocate each created intent's share across the facts it produced.
  const factOrchestrationTokens = new Map<string, number>();
  const factOrchestrationCost = new Map<string, number>();
  for (const [intentId, tokens] of intentCreationTokens) {
    const produced = factsByIntent.get(intentId) ?? [];
    const cost = intentCreationCost.get(intentId) ?? 0;
    produced.forEach((factId, index) => {
      add(factOrchestrationTokens, factId, splitInteger(tokens, produced.length, index));
      add(factOrchestrationCost, factId, produced.length === 0 ? 0 : cost / produced.length);
    });
  }

  const runsByIntent = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.intent_id === null || !intentById.has(run.intent_id)) continue;
    const list = runsByIntent.get(run.intent_id) ?? [];
    list.push(run);
    runsByIntent.set(run.intent_id, list);
  }

  const costRuns: CostRun[] = runs.map((run) => ({
    id: run.id,
    kind: run.kind,
    intent_id: run.intent_id,
    trigger: run.trigger,
    outcome: run.outcome,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    tokens: run.total_tokens,
    cost_usd: roundCost(run.cost_usd),
    created_intent_ids: createdIntentsByRun.get(run.id) ?? [],
    produced_fact_ids: createdFactsByRun.get(run.id) ?? [],
  }));

  const costIntents: CostIntent[] = intents.map((intent) => {
    const meta = intentMetaById.get(intent.id);
    const intentRuns = runsByIntent.get(intent.id) ?? [];
    const directTokens = intentRuns.reduce((sum, run) => sum + run.total_tokens, 0);
    const directCost = intentRuns.reduce((sum, run) => sum + run.cost_usd, 0);
    const creationTokens = intentCreationTokens.get(intent.id) ?? 0;
    const creationCost = intentCreationCost.get(intent.id) ?? 0;
    return {
      id: intent.id,
      description: intent.description,
      from: [...intent.from],
      to: intent.to,
      creator: intent.creator,
      source: meta?.source ?? null,
      origin_run_id: meta?.origin_run_id ?? null,
      created_at: intent.created_at,
      concluded_at: intent.concluded_at,
      run_ids: intentRuns.map((run) => run.id),
      produced_fact_ids: factsByIntent.get(intent.id) ?? [],
      direct_tokens: directTokens,
      direct_cost_usd: roundCost(directCost),
      orchestration_tokens: creationTokens,
      orchestration_cost_usd: roundCost(creationCost),
      total_tokens: directTokens + creationTokens,
      total_cost_usd: roundCost(directCost + creationCost),
    };
  });

  const costFacts: CostFact[] = facts.map((fact) => {
    const meta = factMetaById.get(fact.id);
    const runId = meta?.run_id ?? null;
    const run = runId === null ? null : (runById.get(runId) ?? null);
    const intentId = run?.intent_id ?? null;
    const intent = intentId === null ? null : (intentById.get(intentId) ?? null);
    const intentMetaEntry = intentId === null ? null : (intentMetaById.get(intentId) ?? null);
    const directTokens = factDirectTokens.get(fact.id) ?? 0;
    const directCost = factDirectCost.get(fact.id) ?? 0;
    const orchestrationTokens = factOrchestrationTokens.get(fact.id) ?? 0;
    const orchestrationCost = factOrchestrationCost.get(fact.id) ?? 0;
    return {
      id: fact.id,
      description: fact.description,
      run_id: runId,
      run_kind: run?.kind ?? null,
      intent_id: intentId,
      evidence_status:
        meta === undefined ? "legacy" : meta.evidence_status === "provided" ? "provided" : "missing",
      evidence_refs: meta === undefined ? [] : parseStringArray(meta.evidence_refs),
      source_fact_ids: intent === null ? [] : [...intent.from],
      origin_run_ids: intentMetaEntry?.origin_run_id === null || intentMetaEntry?.origin_run_id === undefined
        ? []
        : [intentMetaEntry.origin_run_id],
      direct_tokens: directTokens,
      direct_cost_usd: roundCost(directCost),
      orchestration_tokens: orchestrationTokens,
      orchestration_cost_usd: roundCost(orchestrationCost),
      total_tokens: directTokens + orchestrationTokens,
      total_cost_usd: roundCost(directCost + orchestrationCost),
    };
  });

  const edges: CausalEdge[] = [];
  for (const run of runs) {
    for (const intentId of createdIntentsByRun.get(run.id) ?? []) {
      edges.push({
        from: `run:${run.id}`,
        to: `intent:${intentId}`,
        kind: "created_intent",
        tokens: intentCreationTokens.get(intentId) ?? 0,
        cost_usd: roundCost(intentCreationCost.get(intentId) ?? 0),
      });
    }
    for (const factId of createdFactsByRun.get(run.id) ?? []) {
      edges.push({
        from: `run:${run.id}`,
        to: `fact:${factId}`,
        kind: "produced_fact",
        tokens: factDirectTokens.get(factId) ?? 0,
        cost_usd: roundCost(factDirectCost.get(factId) ?? 0),
      });
    }
  }
  for (const intent of intents) {
    for (const run of runsByIntent.get(intent.id) ?? []) {
      edges.push({
        from: `intent:${intent.id}`,
        to: `run:${run.id}`,
        kind: "executed_by",
        tokens: run.total_tokens,
        cost_usd: roundCost(run.cost_usd),
      });
    }
    for (const factId of intent.from) {
      if (!factIds.has(factId)) continue;
      edges.push({
        from: `fact:${factId}`,
        to: `intent:${intent.id}`,
        kind: "source_fact",
        tokens: 0,
        cost_usd: 0,
      });
    }
    if (intent.to !== null) {
      edges.push({
        from: `intent:${intent.id}`,
        to: `fact:${intent.to}`,
        kind: "concluded_fact",
        tokens: 0,
        cost_usd: 0,
      });
    }
  }
  edges.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to),
  );

  const totalTokens = runs.reduce((sum, run) => sum + run.total_tokens, 0);
  const totalCost = roundCost(runs.reduce((sum, run) => sum + run.cost_usd, 0));
  const attributedTokens = costFacts.reduce((sum, fact) => sum + fact.total_tokens, 0);
  const attributedCost = roundCost(costFacts.reduce((sum, fact) => sum + fact.total_cost_usd, 0));
  const factDirectTokensTotal = costFacts.reduce((sum, fact) => sum + fact.direct_tokens, 0);
  const factDirectCostTotal = roundCost(
    costFacts.reduce((sum, fact) => sum + fact.direct_cost_usd, 0),
  );
  const orchestrationTokens = [...intentCreationTokens.values()].reduce((sum, value) => sum + value, 0);
  const orchestrationCost = roundCost(
    [...intentCreationCost.values()].reduce((sum, value) => sum + value, 0),
  );
  const orchestrationAttributedTokens = costFacts.reduce(
    (sum, fact) => sum + fact.orchestration_tokens,
    0,
  );
  const orchestrationAttributedCost = roundCost(
    costFacts.reduce((sum, fact) => sum + fact.orchestration_cost_usd, 0),
  );
  const unattributedTokens = totalTokens - attributedTokens;
  const rawUnattributedCost = totalCost - attributedCost;
  const unattributedCost = roundCost(rawUnattributedCost);

  const kinds = new Map<string, CostKind>();
  for (const run of runs) {
    const entry = kinds.get(run.kind) ?? {
      kind: run.kind,
      runs: 0,
      tokens: 0,
      cost_usd: 0,
    };
    entry.runs += 1;
    entry.tokens += run.total_tokens;
    entry.cost_usd += run.cost_usd;
    kinds.set(run.kind, entry);
  }

  const attribution: CostAttribution = {
    fact_direct_tokens: factDirectTokensTotal,
    fact_direct_cost_usd: factDirectCostTotal,
    orchestration_tokens: orchestrationTokens,
    orchestration_cost_usd: orchestrationCost,
    orchestration_attributed_tokens: orchestrationAttributedTokens,
    orchestration_attributed_cost_usd: orchestrationAttributedCost,
    attributed_tokens: attributedTokens,
    attributed_cost_usd: attributedCost,
    unattributed_tokens: unattributedTokens,
    unattributed_cost_usd: unattributedCost,
    complete: unattributedTokens === 0 && Math.abs(rawUnattributedCost) < 1e-9,
  };

  return {
    project_id: projectId,
    totals: {
      tokens: totalTokens,
      cost_usd: totalCost,
      runs: runs.length,
    },
    by_kind: [...kinds.values()]
      .sort((left, right) => left.kind.localeCompare(right.kind))
      .map((row) => ({ ...row, cost_usd: roundCost(row.cost_usd) })),
    attribution,
    facts: costFacts,
    intents: costIntents,
    runs: costRuns,
    edges,
  };
}

/** Costs are dollars; keep derived arithmetic stable at nano-dollar precision. */
function roundCost(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function add(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Split a non-negative integer into `count` parts; earlier parts get the remainder. */
function splitInteger(total: number, count: number, index: number): number {
  if (count <= 0) return 0;
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return base + (index < remainder ? 1 : 0);
}

function parseStringArray(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
  } catch {
    return [];
  }
}
