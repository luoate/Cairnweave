/**
 * Test fixture for M57a: every non-reason result cites one real evidence file and one
 * path that was never written. With `tasks.evidence.invalid_refs: drop` (the default)
 * only the bad entry is discarded and the run's conclusion is recorded; `fail` restores
 * the old all-or-nothing rejection.
 *
 * Flow: fact-only bootstrap -> reason proposes one intent -> explore produces the second
 * fact -> reason completes from both facts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  kind: string;
  taskId: string;
  resultPath: string;
  workspace: string;
  graphSnapshotPath: string;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: mixed-evidence-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

function evidenceRefs(): string[] {
  const relative = `artifacts/mixed-${task.taskId}.txt`;
  const absolute = join(task.workspace, relative);
  mkdirSync(join(task.workspace, "artifacts"), { recursive: true });
  writeFileSync(absolute, "observed evidence\n", "utf8");
  return [relative, `artifacts/mixed-${task.taskId}-missing.txt`];
}

function emit(data: Record<string, unknown>): never {
  writeFileSync(
    task.resultPath,
    JSON.stringify({ accepted: true, data, evidence_refs: evidenceRefs() }),
    "utf8",
  );
  process.exit(0);
}

if (task.kind === "bootstrap") {
  emit({ fact: { description: "mixed bootstrap fact" } });
}

if (task.kind === "explore") {
  emit({ description: `mixed explore fact from ${task.taskId}` });
}

if (task.kind === "reason") {
  const graph = Bun.YAML.parse(await Bun.file(task.graphSnapshotPath).text()) as {
    facts?: Array<{ id?: unknown }>;
  };
  const dynamic = (graph.facts ?? [])
    .map((fact) => fact.id)
    .filter((id): id is string => typeof id === "string" && id !== "origin" && id !== "goal");
  if (dynamic.length < 2) {
    writeFileSync(
      task.resultPath,
      JSON.stringify({
        accepted: true,
        data: {
          intents: [{ from: dynamic, description: "mixed evidence follow-up" }],
        },
      }),
      "utf8",
    );
    process.exit(0);
  }
  writeFileSync(
    task.resultPath,
    JSON.stringify({
      accepted: true,
      data: {
        complete: { from: dynamic.slice(-2), description: "mixed evidence completion" },
      },
    }),
    "utf8",
  );
  process.exit(0);
}

console.error(`unexpected task kind: ${task.kind}`);
process.exit(2);
