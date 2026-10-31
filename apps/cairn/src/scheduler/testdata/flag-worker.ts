/**
 * Test fixture: explores always report one flag-shaped value, and reason stops after two
 * facts with a completion claim that repeats the same value. That lets the flag-review
 * tests exercise the pause gate, the decoy dedupe and the operator override.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FLAG = "flag{review_value}";

interface TaskShape {
  kind: string;
  resultPath: string;
  workspace: string;
  taskId: string;
  graphSnapshotPath: string;
}

interface GraphFact {
  id: string;
  description: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: flag-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

if (task.kind === "reason") {
  const facts = dynamicFacts(await readGraph(task.graphSnapshotPath));
  const data =
    facts.length >= 2
      ? {
          complete: {
            from: facts.slice(-2).map((fact) => fact.id),
            description: `finished after capturing ${FLAG}`,
          },
        }
      : {
          intents: [
            {
              from: facts.length === 1 ? [facts[0]!.id] : ["origin"],
              description: `keep looking pass ${facts.length + 1}`,
            },
          ],
        };
  writeFileSync(task.resultPath, JSON.stringify({ accepted: true, data }), "utf8");
  process.exit(0);
}

if (task.kind === "explore") {
  const name = `flag-${task.taskId}.txt`;
  const absolute = join(task.workspace, "artifacts", name);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `captured ${FLAG}\n`, "utf8");
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: { description: `found ${FLAG} in the target` },
      evidence_refs: [`artifacts/${name}`],
    }),
    "utf8",
  );
  process.exit(0);
}

const child = Bun.spawn(
  [
    process.execPath,
    join(import.meta.dir, "..", "..", "cli.ts"),
    "worker",
    "--task",
    taskPath,
  ],
  { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
);
process.exit(await child.exited);

async function readGraph(path: string): Promise<unknown> {
  return Bun.YAML.parse(await Bun.file(path).text());
}

function dynamicFacts(snapshot: unknown): GraphFact[] {
  if (typeof snapshot !== "object" || snapshot === null) return [];
  const facts = (snapshot as Record<string, unknown>)["facts"];
  if (!Array.isArray(facts)) return [];
  return facts.filter(
    (fact): fact is GraphFact =>
      typeof fact === "object" &&
      fact !== null &&
      typeof (fact as Record<string, unknown>)["id"] === "string" &&
      typeof (fact as Record<string, unknown>)["description"] === "string",
  ).map((fact) => ({
    id: fact.id,
    description: fact.description,
  })).filter((fact) => fact.id !== "origin" && fact.id !== "goal");
}
