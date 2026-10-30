/**
 * Test fixture: a reason turn that proposes the same direction twice. The second entry
 * only differs in character width, whitespace, and punctuation, so description-level
 * dedupe has to drop it even though the two entries carry different dedupe keys.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  resultPath: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: reworded-reason-worker.ts <task.json>");
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
            description: "利用 f003 的凭据通过 SMB 横向到 10.0.2.0/24",
            dedupe_key: "lateral-smb",
          },
          {
            from: ["origin"],
            description: "利用ｆ００３的凭据，通过ＳＭＢ横向到１０．０．２．０／２４。",
            dedupe_key: "lateral-smb-reworded",
          },
        ],
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
