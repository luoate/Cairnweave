/**
 * Test fixture: writes one Host Bridge-style audit line before delegating to the real
 * worker. The fake solver does not touch `audit.jsonl`, so this is the cheapest way to
 * exercise scheduler ingest without a real model.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AUDIT_STREAM_LOST_FILE } from "../../audit-stream/constants";

interface TaskShape {
  taskId: string;
  kind: string;
  sessionDir: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: audit-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
mkdirSync(task.sessionDir, { recursive: true });
writeFileSync(
  join(task.sessionDir, "audit.jsonl"),
  `${JSON.stringify({
    type: "tool_call",
    decision: "allow",
    tool: "read",
    task_id: task.taskId,
    kind: task.kind,
  })}\n`,
  "utf8",
);
if (process.env["CAIRN_TEST_AUDIT_LOST"] === "1") {
  writeFileSync(
    join(task.sessionDir, AUDIT_STREAM_LOST_FILE),
    `${JSON.stringify({
      ts: "2026-03-01T00:00:00.000Z",
      task_id: task.taskId,
      reason: "queue overflow",
      delivered: 0,
      pending: 1,
    })}\n`,
    "utf8",
  );
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
