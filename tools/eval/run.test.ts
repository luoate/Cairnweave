import { describe, expect, test } from "bun:test";

import { runEvaluation } from "./run";
import { SCENARIOS } from "./scenarios";

describe("M42 evaluation set", () => {
  test(
    "compares legacy and hardened completion on the same five scenarios",
    async () => {
      const report = await runEvaluation();

      expect(report.scenarios.map((scenario) => scenario.id)).toEqual(
        SCENARIOS.map((scenario) => scenario.id),
      );
      expect(report.scenarios).toHaveLength(5);

      const byId = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));
      expect(byId.get("single_flag")!.legacy.completed).toBe(true);
      expect(byId.get("single_flag")!.hardened.completed).toBe(true);
      expect(byId.get("partial_flag")!.legacy.wrong_completion).toBe(true);
      expect(byId.get("partial_flag")!.hardened.completed).toBe(false);
      expect(byId.get("wrong_completion")!.legacy.wrong_completion).toBe(true);
      expect(byId.get("wrong_completion")!.hardened.wrong_completion).toBe(false);
      expect(byId.get("budget_exhausted")!.hardened.completed).toBe(false);
      expect(byId.get("missing_evidence")!.hardened.completed).toBe(false);

      expect(report.summary.legacy.wrong_completions).toBe(2);
      expect(report.summary.hardened.wrong_completions).toBe(0);
      expect(report.summary.hardened.legitimate_completions).toBe(1);
      expect(report.summary.legacy.completion_rate).toBeGreaterThan(
        report.summary.hardened.completion_rate,
      );

      for (const scenario of report.scenarios) {
        for (const variant of [scenario.legacy, scenario.hardened]) {
          expect(variant.attempts).toBeGreaterThan(0);
          expect(variant.tokens).toBeGreaterThan(0);
          expect(variant.cost_usd).toBeGreaterThan(0);
        }
      }

      expect(report.done_when.in_prompt).toBe(false);
      expect(report.done_when.evaluated).toBe(false);
    },
    120_000,
  );
});
