import type { WorkerTask } from "@cairn/contracts";

/** Solver-session counters, before mapping to the snake_case usage sidecar. */
export interface SolverUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

/**
 * A solver turns one task into the raw answer text a model would produce. The answer is
 * not trusted: the worker extracts JSON from it tolerantly and the control plane validates
 * the payload against the graph state before applying anything.
 */
export interface Solver {
  readonly name: string;
  solve(task: WorkerTask): Promise<string>;
  /**
   * Usage from the most recent solve attempt, available even when `solve` threw (the
   * worker writes it so failed tasks still count against the project's token budget).
   */
  getLastUsage?(): SolverUsage | null;
  /** Solver-session `provider/model-id`, when the solver can observe one (M14c). */
  getLastModel?(): string | null;
}
