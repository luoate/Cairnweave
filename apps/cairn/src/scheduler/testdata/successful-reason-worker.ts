/**
 * Test fixture: a reason turn that succeeds without changing the graph. This models the
 * ordinary "open work already exists, nothing to add" case so persistence tests can
 * observe the stored watermarks instead of running the project to completion.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  resultPath: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: successful-reason-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
if (task.kind === "reason") {
  writeFileSync(
    task.resultPath,
    JSON.stringify({ accepted: true, data: {} }),
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
