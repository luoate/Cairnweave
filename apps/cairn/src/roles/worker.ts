import {
  extractJsonObject,
  isTaskResult,
  isWorkerTask,
  TASK_USAGE_FILE,
  taskErrors,
  taskUsageErrors,
  WORKER_EXIT,
  type TaskResult,
  type TaskUsage,
  type WorkerTask,
} from "@cairn/contracts";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { flushHostBridgeAudit } from "../host-bridge/worker-extension";
import { createSolver } from "../solver";
import type { SolverUsage } from "../solver/types";

/**
 * Worker role: runs inside the project sandbox, executes exactly one task, writes exactly
 * one result file, and exits. It never opens the database.
 *
 * The solver's answer is untrusted text. It is parsed tolerantly here, normalized into
 * Cairn's result envelope, and written atomically; semantic validation against the graph
 * happens in the control plane, which is the only writer.
 */
export async function runWorker(args: readonly string[]): Promise<number> {
  const taskPath = optionValue(args, "--task");
  if (taskPath === undefined) {
    console.error("usage: cairn worker --task <task.json>");
    return WORKER_EXIT.USAGE;
  }

  let raw: string;
  try {
    raw = await Bun.file(taskPath).text();
  } catch (error) {
    console.error(`[worker] cannot read task ${taskPath}: ${describe(error)}`);
    return WORKER_EXIT.INVALID_TASK;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    console.error(`[worker] task ${taskPath} is not valid JSON: ${describe(error)}`);
    return WORKER_EXIT.INVALID_TASK;
  }

  const errors = taskErrors(value);
  if (!isWorkerTask(value)) {
    console.error(`[worker] invalid task ${taskPath}:`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    return WORKER_EXIT.INVALID_TASK;
  }

  const task: WorkerTask = value;
  if (!isInside(task.sessionDir, task.resultPath)) {
    console.error("[worker] resultPath must be inside sessionDir");
    return WORKER_EXIT.INVALID_TASK;
  }

  console.error(`[worker] loaded ${task.kind} task ${task.taskId} (project ${task.projectId})`);

  let solver;
  try {
    solver = createSolver();
  } catch (error) {
    console.error(`[worker] ${describe(error)}`);
    return WORKER_EXIT.USAGE;
  }

  let output: string;
  try {
    output = await solver.solve(task);
  } catch (error) {
    console.error(`[worker] solver failed: ${describe(error)}`);
    return WORKER_EXIT.NO_ANSWER;
  } finally {
    // The CLI exits explicitly, so pending live-audit requests must be drained here; the
    // scheduler's finish-time import backfills anything still missing.
    await flushHostBridgeAudit();
    // Usage is a sidecar so a solver failure or a rejected answer still counts against
    // the project's token/cost budget. It never changes the task outcome.
    writeUsage(task, solver.getLastUsage?.() ?? null, solver.getLastModel?.() ?? null);
  }

  let result: TaskResult;
  try {
    result = normalizeResult(extractJsonObject(output));
  } catch (error) {
    console.error(`[worker] no usable answer: ${describe(error)}`);
    return WORKER_EXIT.NO_ANSWER;
  }

  try {
    mkdirSync(dirname(task.resultPath), { recursive: true });
    const temporary = `${task.resultPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, task.resultPath);
  } catch (error) {
    console.error(`[worker] cannot write result ${task.resultPath}: ${describe(error)}`);
    return WORKER_EXIT.CRASH;
  }

  console.error(`[worker] wrote result ${task.resultPath}`);
  return WORKER_EXIT.OK;
}

/**
 * Accepts either Cairn's wrapper (`accepted` boolean) or a bare payload from a model that
 * ignored the wrapper. A refusal without a reason still has to produce a valid envelope.
 */
export function normalizeResult(payload: Record<string, unknown>): TaskResult {
  const evidence = payload["evidence_refs"];
  let result: unknown;
  if (typeof payload["accepted"] === "boolean") {
    if (payload["accepted"] === false) {
      const reason = payload["reason"];
      result = {
        accepted: false,
        reason:
          typeof reason === "string" && reason.trim() !== ""
            ? reason.trim()
            : "solver rejected the task",
      };
    } else {
      // Models routinely put `evidence_refs` inside `data`, where their task payload
      // lives, even though the contract declares it top-level. Lift it out; a
      // top-level value wins when both are present.
      const lifted = liftNestedEvidence(payload["data"]);
      const refs = evidence === undefined ? lifted.evidence : evidence;
      result = {
        accepted: true,
        data: lifted.data,
        ...(refs === undefined ? {} : { evidence_refs: refs }),
      };
    }
  } else {
    // A bare payload has no envelope, so `evidence_refs` is lifted out of the data object
    // instead of being mistaken for a Cairn field.
    const { evidence_refs: lifted, ...data } = payload;
    result = {
      accepted: true,
      data,
      ...(lifted === undefined ? {} : { evidence_refs: lifted }),
    };
  }

  if (!isTaskResult(result)) {
    throw new Error("solver answer does not form a valid result");
  }
  return result;
}

/** Splits `data.evidence_refs` from the payload when `data` is an object. */
function liftNestedEvidence(data: unknown): { data: unknown; evidence: unknown } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { data, evidence: undefined };
  }
  const { evidence_refs: evidence, ...rest } = data as Record<string, unknown>;
  return { data: rest, evidence };
}

function writeUsage(task: WorkerTask, usage: SolverUsage | null, model: string | null): void {
  if (usage === null) return;
  const mapped: TaskUsage = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    total_tokens: usage.totalTokens,
    cost_usd: usage.costUsd,
    ...(model === null || model === "" ? {} : { model }),
  };
  const errors = taskUsageErrors(mapped);
  if (errors.length > 0) {
    console.error(`[worker] ignoring invalid usage: ${errors.join("; ")}`);
    return;
  }
  try {
    const path = join(task.sessionDir, TASK_USAGE_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(mapped, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    // Metering is advisory; never turn a successful answer into a failure.
    console.error(`[worker] cannot write usage: ${describe(error)}`);
  }
}

function isInside(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  const normalizedBase = process.platform === "win32" ? base.toLowerCase() : base;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  return target !== base && normalizedTarget.startsWith(normalizedBase + sep);
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("-") ? undefined : value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
