/**
 * Test fixture: a reason turn that retires one intent. The target id is passed as the
 * third argument by the test so the fixture does not have to parse the prompt.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  resultPath: string;
}

const taskPath = process.argv[2];
const target = process.argv[3];
if (taskPath === undefined) {
  console.error("usage: abandon-reason-worker.ts <task.json> [intent_id]");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
if (task.kind === "reason") {
  const data =
    target === undefined
      ? {}
      : {
          abandon: [
            { intent_id: target, reason: "two failed attempts produced nothing" },
          ],
        };
  writeFileSync(task.resultPath, JSON.stringify({ accepted: true, data }), "utf8");
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
