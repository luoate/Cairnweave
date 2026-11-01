/**
 * Regression fixture copied from proj_030's bootstrap result: the model says the goal was
 * NOT achieved but still supplies a `complete` object. With `verification: off` and the
 * default `off_completion: manual`, this must become a pending operator review instead of
 * closing the project.
 */

import { writeFileSync } from "node:fs";

interface TaskShape {
  kind: string;
  resultPath: string;
  workspace: string;
  taskId: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: negative-complete-bootstrap-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

if (task.kind === "bootstrap") {
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: {
        fact: {
          description:
            "Confirmed arbitrary file read via /admin, recovered /app/flask_app.py, " +
            "and listed the root directory where /flag exists.",
        },
        complete: {
          description:
            "Goal NOT definitively achieved: the flag value at /flag was not read; " +
            "completion cannot be claimed.",
        },
      },
    }),
    "utf8",
  );
  process.exit(0);
}

console.error(`unexpected task kind: ${task.kind}`);
process.exit(2);
