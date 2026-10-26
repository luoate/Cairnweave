/**
 * Test fixture: writes two Host Bridge-style audit lines, streams only the first one to
 * the control plane, then delegates to the real worker. The finish-time import must see
 * the live seq 1 as a duplicate and append seq 2, proving both halves of M9.
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
  console.error("usage: stream-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
mkdirSync(task.sessionDir, { recursive: true });

const entries = ["read", "grep"].map((tool, index) => ({
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  task_id: task.taskId,
  project_id: task.projectId,
  tool,
  action: "file",
  targets: ["sample.txt"],
  decision: "allow",
  reason: null,
  detail: `file path=sample-${index}.txt`,
}));
writeFileSync(
  join(task.sessionDir, "audit.jsonl"),
  entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  "utf8",
);

const url = process.env["CAIRN_AUDIT_STREAM_URL"];
const token = process.env["CAIRN_AUDIT_STREAM_TOKEN"];
if (url === undefined || token === undefined) {
  console.error("stream worker started without the audit stream environment");
  process.exit(3);
}

const response = await fetch(
  `${url}/projects/${encodeURIComponent(task.projectId)}/tasks/` +
    `${encodeURIComponent(task.taskId)}/audit`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events: [{ seq: 1, event: entries[0]! }] }),
  },
);
if (!response.ok) {
  console.error(`live audit append failed: ${response.status} ${await response.text()}`);
  process.exit(4);
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
