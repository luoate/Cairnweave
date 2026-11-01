/**
 * Test fixture for the M40 bootstrap contract: the bootstrap turn reports a fact without
 * a `complete` claim, so the project must stay active and continue with a reason turn.
 */

import { writeFileSync } from "node:fs";

interface TaskShape {
  kind: string;
  resultPath: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: fact-only-bootstrap-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

if (task.kind === "bootstrap") {
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: { fact: { description: "partial bootstrap progress" } },
    }),
    "utf8",
  );
  process.exit(0);
}

if (task.kind === "reason") {
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: {
        intents: [{ from: ["origin"], description: "continue after fact-only bootstrap" }],
      },
    }),
    "utf8",
  );
  process.exit(0);
}

console.error(`unexpected task kind: ${task.kind}`);
process.exit(2);
