import type { WorkerTask } from "@cairn/contracts";

/**
 * A solver turns one task into the raw answer text a model would produce. The answer is
 * not trusted: the worker extracts JSON from it tolerantly and the control plane validates
 * the payload against the graph state before applying anything.
 */
export interface Solver {
  readonly name: string;
  solve(task: WorkerTask): Promise<string>;
}
