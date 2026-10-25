import {
  extractJsonObject,
  isTaskResult,
  isWorkerTask,
  taskErrors,
  WORKER_EXIT,
  type TaskResult,
  type WorkerTask,
} from "@cairn/contracts";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { createSolver } from "../solver";

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
function normalizeResult(payload: Record<string, unknown>): TaskResult {
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
      result = { accepted: true, data: payload["data"] };
    }
  } else {
    result = { accepted: true, data: payload };
  }

  if (!isTaskResult(result)) {
    throw new Error("solver answer does not form a valid result");
  }
  return result;
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
