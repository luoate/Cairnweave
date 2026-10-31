/**
 * Test fixture for the flag-review bootstrap path: the bootstrap task captures a flag and
 * claims the goal in one run, the reason turn completes without repeating the value. That
 * reproduces a project that would close on its own claim before the operator judges the
 * captured flag.
 */

import { writeFileSync } from "node:fs";

const FLAG = "flag{bootstrap_value}";

interface TaskShape {
  kind: string;
  resultPath: string;
  graphSnapshotPath: string;
}

interface GraphFact {
  id: string;
  description: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: flag-bootstrap-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

if (task.kind === "bootstrap") {
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: {
        fact: { description: `bootstrap target leaked ${FLAG}` },
        complete: { description: "the bootstrap objective is satisfied" },
      },
    }),
    "utf8",
  );
  process.exit(0);
}

if (task.kind === "reason") {
  const facts = dynamicFacts(await readGraph(task.graphSnapshotPath));
  const data = {
    complete: {
      from: facts.map((fact) => fact.id),
      description: "the goal is reached",
    },
  };
  writeFileSync(task.resultPath, JSON.stringify({ accepted: true, data }), "utf8");
  process.exit(0);
}

console.error(`unexpected task kind: ${task.kind}`);
process.exit(2);

async function readGraph(path: string): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(path).text());
}

function dynamicFacts(snapshot: unknown): GraphFact[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const facts = (snapshot as Record<string, unknown>)["facts"];
  if (!Array.isArray(facts)) return [];
  return facts
    .filter(
      (fact): fact is GraphFact =>
        typeof fact === "object" &&
        fact !== null &&
        typeof (fact as Record<string, unknown>)["id"] === "string" &&
        typeof (fact as Record<string, unknown>)["description"] === "string",
    )
    .map((fact) => ({ id: fact.id, description: fact.description }))
    .filter((fact) => fact.id !== "origin" && fact.id !== "goal");
}
