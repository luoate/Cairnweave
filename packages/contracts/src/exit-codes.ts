/**
 * Worker exit codes. A policy refusal or a rejected task is not an error: the worker
 * writes a valid result file with `accepted: false` and exits OK.
 */
export const WORKER_EXIT = {
  /** A valid TaskResult was written to resultPath. */
  OK: 0,
  /** The worker was invoked incorrectly (missing --task, unknown flag, ...). */
  USAGE: 2,
  /** The task ran but produced no usable answer (hard timeout, solver crash, empty reply). */
  NO_ANSWER: 3,
  /** The worker itself crashed or could not write its result. */
  CRASH: 4,
  /** The task file is missing, unreadable, or violates the contract. */
  INVALID_TASK: 10,
} as const;

export type WorkerExitCode = (typeof WORKER_EXIT)[keyof typeof WORKER_EXIT];
