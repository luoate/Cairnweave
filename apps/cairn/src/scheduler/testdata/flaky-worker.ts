/**
 * Test fixture: behaves like a solver that persisted a session and then crashed on the
 * first explore attempt. Conclude tasks (which carry resumeSessionDir) are delegated to
 * the real worker so the deterministic fake solver can finish them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  sessionDir: string;
  resumeSessionDir?: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: flaky-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

if (
  (task.kind === "explore" || task.kind === "bootstrap") &&
  task.resumeSessionDir === undefined
) {
  const sessionDir = join(task.sessionDir, "solver-session");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "partial-session.jsonl"),
    `${JSON.stringify({ type: "session", note: "simulated crash" })}\n`,
    "utf8",
  );
  console.error("[flaky-worker] crashing after persisting a partial session");
  process.exit(1);
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
