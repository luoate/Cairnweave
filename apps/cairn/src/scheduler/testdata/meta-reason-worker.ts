/**
 * Test fixture: a reason turn that proposes intents with priority/budget hints, stable
 * dedupe keys, and one strategy hint. All other kinds delegate to the real worker so the
 * scheduler can still finish the project.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  intentId?: string;
  resultPath: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: meta-reason-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;
if (task.kind === "reason") {
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: {
        intents: [
          {
            from: ["origin"],
            description: "high priority direction",
            priority: 90,
            budget: { max_seconds: 20, max_tool_calls: 5 },
            dedupe_key: "high-priority-direction",
          },
          {
            from: ["origin"],
            description: "low priority direction",
            priority: 10,
            dedupe_key: "low-priority-direction",
          },
        ],
        hints: [{ content: "inspect the login flow" }],
      },
    }),
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
