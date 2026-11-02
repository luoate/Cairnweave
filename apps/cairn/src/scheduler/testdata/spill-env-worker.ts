/**
 * Test fixture: records the tool-result spill environment the scheduler handed down, then
 * delegates to the real worker. Pins the config -> worker-env hop for `tasks.tool_result_spill`,
 * which the Cairn side and the solver-side extension each cover only from their own end.
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
  console.error("usage: spill-env-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
mkdirSync(task.sessionDir, { recursive: true });
writeFileSync(
  join(task.sessionDir, "audit.jsonl"),
  `${JSON.stringify({
    ts: "2026-11-02T00:00:00.000Z",
    task_id: task.taskId,
    project_id: task.projectId,
    tool: "bash",
    action: "command",
    targets: [],
    decision: "allow",
    reason: null,
    detail: `spill_enabled=${process.env["CAIRN_TOOL_SPILL_ENABLED"] ?? "-"} max_chars=${
      process.env["CAIRN_TOOL_SPILL_MAX_CHARS"] ?? "-"
    }`,
    event: "tool_result_spill_contract",
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
