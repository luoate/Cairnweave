/**
 * Test fixture: writes a usage sidecar before delegating to the real worker. The fake
 * solver reports no usage of its own, so the sidecar survives and the scheduler reads it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  sessionDir: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: usage-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
writeFileSync(
  join(task.sessionDir, "usage.json"),
  JSON.stringify({
    input_tokens: 120,
    output_tokens: 30,
    cache_read_tokens: 10,
    cache_write_tokens: 5,
    total_tokens: 165,
    cost_usd: 0.25,
    model: "gateway/deepseek-flash",
  }),
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
