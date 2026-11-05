import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointPublisher, registerCheckpointTool, startWorkerCheckpoint, stopWorkerCheckpoint, type CheckpointToolApi } from "./worker";
import { checkpoint } from "../../../../packages/contracts/src/testdata/checkpoint";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "checkpoint-worker-")); });
afterEach(() => { stopWorkerCheckpoint(); rmSync(dir, { recursive: true, force: true }); delete process.env["CAIRN_TASK_CHECKPOINT"]; });
const progress = () => { const { progress, attempts, unresolved, next_steps } = checkpoint(); return { progress, attempts, unresolved, next_steps }; };
const read = () => JSON.parse(readFileSync(join(dir, "checkpoint.json"), "utf8"));
describe("M49 worker atomic checkpoint", () => {
  test("publishes increasing complete replacements and retains claims across lifecycle marks", () => {
    const publisher = new CheckpointPublisher({ taskId: "task", projectId: "project", intentId: "i1", sessionDir: dir });
    publisher.start(60000);
    try {
      expect(read()).toMatchObject({ sequence: 1, stage: "started", attempts: [] });
      expect(publisher.save(progress())).toBe(2);
      publisher.mark("soft_deadline"); expect(read()).toMatchObject({ sequence: 3, stage: "soft_deadline", ...progress() });
      expect(readdirSync(dir)).toEqual(["checkpoint.json"]);
    } finally { publisher.stop(); }
  });
  test("invalid or oversized updates preserve the previous file and sequence", () => {
    const publisher = new CheckpointPublisher({ taskId: "task", projectId: "project", sessionDir: dir });
    publisher.save(progress()); const before = read();
    expect(() => publisher.save({ ...progress(), progress: "x".repeat(4097) })).toThrow();
    const big = progress(); big.attempts = Array.from({ length: 32 }, (_, n) => ({ ...big.attempts[0]!, id: String(n), observation: "中".repeat(4096) }));
    expect(() => publisher.save(big)).toThrow("over limit"); expect(read()).toEqual(before);
    expect(publisher.save(progress())).toBe(2);
  });
  test("periodically republishes the last structured observation without inventing progress", async () => {
    const publisher = new CheckpointPublisher({ taskId: "task", projectId: "project", sessionDir: dir });
    publisher.start(20);
    try {
      publisher.save(progress()); await Bun.sleep(100);
      expect(read().sequence).toBeGreaterThan(2); expect(read().attempts).toEqual(progress().attempts);
    } finally { publisher.stop(); }
  });
  test("off registers no tool and performs no file writes", () => {
    let calls = 0; registerCheckpointTool({ registerTool: () => { calls++; } });
    expect(calls).toBe(0); expect(readdirSync(dir)).toEqual([]);
  });
  test("native tool injects task identity and validates model input without leaking exception bodies", async () => {
    process.env["CAIRN_TASK_CHECKPOINT"] = "1";
    startWorkerCheckpoint({ taskId: "task", projectId: "project", sessionDir: dir } as any);
    let tool: Parameters<NonNullable<CheckpointToolApi["registerTool"]>>[0] | undefined;
    registerCheckpointTool({ registerTool: (value) => { tool = value; } });
    expect(tool?.name).toBe("save_task_checkpoint");
    expect((await tool!.execute("id", { json: JSON.stringify(progress()) })).details.saved).toBe(true);
    expect(read().task_id).toBe("task");
    const before = read();
    const bad = await tool!.execute("id", { json: '{secret-credential' });
    expect(bad.details.saved).toBe(false); expect(JSON.stringify(bad)).not.toContain("secret-credential"); expect(read()).toEqual(before);
    expect((await tool!.execute("id", { json: JSON.stringify({ ...progress(), task_id: "forged" }) })).details.saved).toBe(false);
  });
});
