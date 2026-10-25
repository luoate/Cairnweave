/**
 * Test fixture for same-project concurrency. Every explore worker registers at a
 * rendezvous barrier inside the shared workspace and only reports a normal fact once a
 * peer has registered too; on timeout it reports a distinguishable "serialized" fact so
 * the integration test fails fast instead of retrying the intent.
 *
 * Reason tasks complete the project from `origin` so `runUntilIdle` terminates.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface TaskShape {
  taskId: string;
  kind: string;
  workspace: string;
  resultPath: string;
  artifactDir?: string;
}

const PEER_COUNT = 2;
const BARRIER_TIMEOUT_MS = 5_000;

function writeResult(task: TaskShape, result: unknown): void {
  writeFileSync(task.resultPath, JSON.stringify(result), "utf8");
}

async function waitForPeers(barrier: string): Promise<boolean> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readdirSync(barrier).length >= PEER_COUNT) return true;
    await Bun.sleep(50);
  }
  return false;
}

const taskPath = process.argv[2];
if (taskPath === undefined) {
  console.error("usage: concurrent-worker.ts <task.json>");
  process.exit(2);
}

const task = JSON.parse(await Bun.file(taskPath).text()) as TaskShape;

if (task.kind !== "explore") {
  writeResult(task, {
    accepted: true,
    data: {
      complete: { from: ["origin"], description: "concurrent project complete" },
    },
  });
  process.exit(0);
}

const barrier = join(task.workspace, ".barrier");
mkdirSync(barrier, { recursive: true });
writeFileSync(join(barrier, task.taskId), "", "utf8");
const overlapped = await waitForPeers(barrier);

const namespace = (task.artifactDir ?? "artifacts").split("/");
const artifactDir = join(task.workspace, ...namespace);
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "out.txt"), `artifact from ${task.taskId}\n`, "utf8");

writeResult(task, {
  accepted: true,
  data: {
    description: overlapped
      ? `concurrent fact from ${task.taskId}`
      : `serialized fact from ${task.taskId}`,
  },
  evidence_refs: [`${namespace.join("/")}/out.txt`],
});
