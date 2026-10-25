import { BreachWeaveSolver } from "./breachweave";
import { FakeSolver } from "./fake";
import type { Solver } from "./types";

export type { Solver } from "./types";

/**
 * Solver registry. `fake` stays the default so tests and offline runs never need model
 * credentials; `breachweave` is selected per worker with `CAIRN_SOLVER=breachweave`.
 */
export function createSolver(name: string = process.env["CAIRN_SOLVER"] ?? "fake"): Solver {
  switch (name) {
    case "fake":
      return new FakeSolver();
    case "breachweave":
      return new BreachWeaveSolver();
    default:
      throw new Error(`unknown solver: ${name} (expected fake or breachweave)`);
  }
}
