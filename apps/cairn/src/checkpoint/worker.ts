/** Worker-only atomic publisher. No DB access and no model calls of its own. */
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHECKPOINT_BYTES, TASK_CHECKPOINT_FILE, isCheckpointProgress, isTaskCheckpoint,
  type CheckpointProgress, type TaskCheckpoint, type WorkerTask } from "@cairn/contracts";
export class CheckpointPublisher {
  private sequence = 0;
  private current: CheckpointProgress = { progress: "", attempts: [], unresolved: [], next_steps: [] };
  private stage: TaskCheckpoint["stage"] = "started";
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly task: Pick<WorkerTask, "taskId" | "projectId" | "intentId" | "sessionDir">) {}
  start(intervalMs: number): void {
    this.publish();
    // Periodically refresh the last structured state; no synthetic new observations.
    this.timer = setInterval(() => { try { this.publish(); } catch { /* Last accepted state survives. */ } }, intervalMs);
    this.timer.unref();
  }
  save(value: unknown): number {
    if (!isCheckpointProgress(value) || Object.keys(value as object).some((k) => !["progress", "attempts", "unresolved", "next_steps"].includes(k))) throw new Error("invalid checkpoint progress");
    return this.publish(structuredClone(value), "working");
  }
  mark(stage: TaskCheckpoint["stage"]): void { try { this.publish(this.current, stage); } catch { /* Best effort. */ } }
  stop(): void { if (this.timer !== undefined) clearInterval(this.timer); }
  private publish(progress = this.current, stage = this.stage): number {
    const value: TaskCheckpoint = { version: 1, project_id: this.task.projectId, task_id: this.task.taskId,
      intent_id: this.task.intentId ?? null, sequence: this.sequence + 1, stage, ...progress };
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (!isTaskCheckpoint(value) || bytes.length > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint over limit");
    const temporary = join(this.task.sessionDir, `.checkpoint-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, join(this.task.sessionDir, TASK_CHECKPOINT_FILE));
      this.current = progress; this.stage = stage; this.sequence = value.sequence;
      return this.sequence;
    } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
}
let publisher: CheckpointPublisher | undefined;
export function startWorkerCheckpoint(task: WorkerTask): void {
  publisher?.stop(); publisher = undefined;
  if (process.env["CAIRN_TASK_CHECKPOINT"] !== "1") return;
  const seconds = Number(process.env["CAIRN_CHECKPOINT_INTERVAL_SECONDS"] ?? 5);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) return;
  try { publisher = new CheckpointPublisher(task); publisher.start(seconds * 1000); }
  catch { publisher?.stop(); publisher = undefined; }
}
export function markWorkerCheckpoint(stage: TaskCheckpoint["stage"]): void { publisher?.mark(stage); }
export function stopWorkerCheckpoint(): void { publisher?.stop(); publisher = undefined; }
export interface CheckpointToolApi {
  registerTool?: (tool: {
    name: string; label: string; description: string; parameters: Record<string, unknown>;
    execute: (id: string, params: { json: string }) => Promise<{ content: Array<{ type: "text"; text: string }>; details: { saved: boolean } }>;
  }) => unknown;
}
export function registerCheckpointTool(pi: CheckpointToolApi): void {
  if (publisher === undefined || pi.registerTool === undefined) return;
  pi.registerTool({ name: "save_task_checkpoint", label: "保存任务检查点",
    description: "保存累计的结构化进度（未验证声明）。json 包含 progress、attempts、unresolved、next_steps；每次完整替换。操作员自己的机密（模型 key、operator token、私钥）禁止写入。",
    parameters: { type: "object", properties: { json: { type: "string", maxLength: MAX_CHECKPOINT_BYTES } }, required: ["json"], additionalProperties: false },
    execute: async (_id, params) => {
      try {
        if (Buffer.byteLength(params.json) > MAX_CHECKPOINT_BYTES) throw new Error("over limit");
        const sequence = publisher!.save(JSON.parse(params.json));
        return { content: [{ type: "text", text: `checkpoint saved sequence=${sequence}; not verified` }], details: { saved: true } };
      } catch { return { content: [{ type: "text", text: "checkpoint not saved: invalid, oversized, or unavailable; previous checkpoint preserved" }], details: { saved: false } }; }
    },
  });
}

/** Loaded only by the main solver; subagents must return observations to that writer. */
export function createTaskCheckpointExtensionFromEnv(): (pi: CheckpointToolApi) => void {
  return registerCheckpointTool;
}
