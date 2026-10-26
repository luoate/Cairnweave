/**
 * Test fixture: exits non-zero for reason tasks so the scheduler must record a failure
 * and apply the persisted backoff. Other kinds delegate to the real worker.
 */

import { join } from "node:path";

interface TaskShape {
  kind: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: failing-reason-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
if (task.kind === "reason") {
  console.error("[failing-reason-worker] simulated reason failure");
  process.exit(3);
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
