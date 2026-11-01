/**
 * Deterministic worker for the M42 evaluation harness.
 *
 * It never calls a model. The harness passes `mode tokens cost` after the task path:
 *
 *   claim      bootstrap and reason both claim completion
 *   fact-only  bootstrap records a fact without a completion claim; reason keeps exploring
 *
 * `usage.json` is written before the result so the scheduler records cost, tokens and
 * duration exactly like a real solver session, without depending on a provider.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  resultPath: string;
  sessionDir: string;
  graphSnapshotPath: string;
}

interface GraphFact {
  id: string;
  description: string;
}

const [taskPath, mode = "claim", tokens = "600", cost = "0.002"] = process.argv.slice(2);
if (taskPath === undefined) {
  console.error("usage: scenario-worker.ts <task.json> [claim|fact-only] [tokens] [cost]");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
const total = Number(tokens);
const costUsd = Number(cost);

writeFileSync(
  join(task.sessionDir, "usage.json"),
  JSON.stringify({
    input_tokens: Math.floor(total * 0.8),
    output_tokens: Math.ceil(total * 0.2),
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: total,
    cost_usd: costUsd,
    model: "eval/fake",
  }),
  "utf8",
);

if (task.kind === "bootstrap") {
  const data =
    mode === "fact-only"
      ? {
          fact: {
            description: "Recorded an initial foothold and server behaviour.",
          },
        }
      : {
          fact: {
            description: "Recorded the foothold and the expected objective.",
          },
          complete: {
            description: "The evaluation worker claims the goal is reached.",
          },
        };
  write(data);
  process.exit(0);
}

if (task.kind === "reason") {
  if (mode === "fact-only") {
    write({
      intents: [
        {
          from: ["origin"],
          description: "Continue exploring after the bootstrap budget was spent.",
        },
      ],
    });
    process.exit(0);
  }
  const facts = dynamicFacts(await readGraph(task.graphSnapshotPath));
  write({
    complete: {
      from: facts.map((fact) => fact.id),
      description: "The evaluation worker claims the goal is reached.",
    },
  });
  process.exit(0);
}

if (task.kind === "explore") {
  write({
    intents: [
      {
        from: ["origin"],
        description: "Continue exploring until an objective condition passes.",
      },
    ],
  });
  process.exit(0);
}

console.error(`unexpected task kind: ${task.kind}`);
process.exit(2);

function write(data: unknown): void {
  writeFileSync(task.resultPath, JSON.stringify({ accepted: true, data }), "utf8");
}

async function readGraph(path: string): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(path).text());
}

function dynamicFacts(snapshot: unknown): GraphFact[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const facts = (snapshot as Record<string, unknown>)["facts"];
  if (!Array.isArray(facts)) return [];
  const result = facts
    .filter(
      (fact): fact is GraphFact =>
        typeof fact === "object" &&
        fact !== null &&
        typeof (fact as Record<string, unknown>)["id"] === "string" &&
        typeof (fact as Record<string, unknown>)["description"] === "string",
    )
    .map((fact) => ({ id: fact.id, description: fact.description }))
    .filter((fact) => fact.id !== "origin" && fact.id !== "goal");
  return result.length > 0 ? result : [{ id: "origin", description: "origin" }];
}
