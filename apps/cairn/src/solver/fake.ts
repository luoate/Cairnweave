/**
 * Deterministic solver used to exercise the scheduler before the real BreachWeave
 * Solver lands in M2c. It reads the same graph snapshot a real solver reads, so the
 * prompt/snapshot plumbing is tested end to end.
 *
 * The graph walk it performs is deliberately simple and terminating:
 *   reason:    open intents -> noop; <2 facts -> one new intent; >=2 facts -> complete
 *   explore:   one fact describing the intent
 *   bootstrap: one fact, then complete the project
 */

import type { WorkerTask } from "@cairn/contracts";

import type { Solver } from "./types";

interface GraphFact {
  id: string;
  description: string;
}

interface GraphIntent {
  id: string;
  from: string[];
  to: string | null;
  description: string;
  creator?: string;
  worker?: string | null;
  created_at?: string | null;
  concluded_at?: string | null;
}

interface GraphView {
  facts: GraphFact[];
  intents: GraphIntent[];
}

export class FakeSolver implements Solver {
  readonly name = "fake";

  async solve(task: WorkerTask): Promise<string> {
    switch (task.kind) {
      case "reason":
        return JSON.stringify(reasonAnswer(await readGraph(task.graphSnapshotPath)));
      case "explore":
        return JSON.stringify(exploreAnswer(task.intentId));
      case "conclude":
        // Bootstrap conclude returns the fact-only payload; claiming completion here
        // would bypass the control plane's graph checks.
        return JSON.stringify(
          task.concludeOf === "bootstrap"
            ? {
                accepted: true,
                data: {
                  fact: { description: `fake conclude fact from ${task.intentId ?? "unknown"}` },
                },
              }
            : exploreAnswer(task.intentId),
        );
      case "bootstrap":
        return JSON.stringify({
          accepted: true,
          data: {
            fact: { description: "fake bootstrap fact" },
            complete: { description: "fake bootstrap completion" },
          },
        });
    }
  }
}

async function readGraph(path: string): Promise<GraphView> {
  const text = await Bun.file(path).text();
  const parsed: unknown = Bun.YAML.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`graph snapshot is not a mapping: ${path}`);
  }
  const root = parsed as Record<string, unknown>;
  const facts = Array.isArray(root["facts"]) ? root["facts"] : [];
  const intents = Array.isArray(root["intents"]) ? root["intents"] : [];
  return {
    facts: facts.filter(isFact),
    intents: intents.filter(isIntent),
  };
}

function isFact(value: unknown): value is GraphFact {
  if (typeof value !== "object" || value === null) return false;
  const fact = value as Record<string, unknown>;
  return typeof fact["id"] === "string" && typeof fact["description"] === "string";
}

function isIntent(value: unknown): value is GraphIntent {
  if (typeof value !== "object" || value === null) return false;
  const intent = value as Record<string, unknown>;
  const from = intent["from"];
  return (
    typeof intent["id"] === "string" &&
    Array.isArray(from) &&
    from.every((factId) => typeof factId === "string") &&
    (intent["to"] === null || typeof intent["to"] === "string") &&
    typeof intent["description"] === "string"
  );
}

function reasonAnswer(graph: GraphView): Record<string, unknown> {
  const openIntents = graph.intents.filter((intent) => intent.to === null);
  if (openIntents.length > 0) {
    return { accepted: true, data: {} };
  }

  const dynamicFacts = graph.facts.filter(
    (fact) => fact.id !== "origin" && fact.id !== "goal",
  );
  if (dynamicFacts.length >= 2) {
    const from = dynamicFacts.slice(-2).map((fact) => fact.id);
    return {
      accepted: true,
      data: {
        complete: {
          from,
          description: `fake completion using ${from.join(", ")}`,
        },
      },
    };
  }

  const from = dynamicFacts.length === 1 ? [dynamicFacts[0]!.id] : ["origin"];
  const description =
    dynamicFacts.length === 1
      ? `fake investigation ${dynamicFacts[0]!.id}`
      : "fake initial investigation";
  return {
    accepted: true,
    data: { intents: [{ from, description }] },
  };
}

function exploreAnswer(intentId: string | undefined): Record<string, unknown> {
  return {
    accepted: true,
    data: { description: `fake fact from ${intentId ?? "unknown"}` },
  };
}
