/**
 * Test fixture: records the SSRF marker environment the scheduler handed down, then
 * delegates to the real worker. Pins the config -> worker-env hop, which the bridge and
 * solver unit tests each cover only from their own side.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  taskId: string;
  kind: string;
  projectId: string;
  sessionDir: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: ssrf-env-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
mkdirSync(task.sessionDir, { recursive: true });
writeFileSync(
  join(task.sessionDir, "audit.jsonl"),
  `${JSON.stringify({
    ts: "2026-10-31T00:00:00.000Z",
    task_id: task.taskId,
    project_id: task.projectId,
    tool: "bash",
    action: "command",
    targets: [],
    decision: "allow",
    reason: null,
    detail: `ssrf_markers=${process.env["CAIRN_SSRF_POLICY"] ?? "-"} protected=${
      process.env["CAIRN_SSRF_PROTECTED_HOSTS"] ?? "-"
    }`,
    event: "ssrf_candidate",
  })}\n`,
  "utf8",
);

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
