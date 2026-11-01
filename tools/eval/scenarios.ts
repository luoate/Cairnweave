import type {
  ProjectGoalConditionInput,
  VerificationKind,
} from "@cairn/graph";

/** Ground truth: did the scenario really satisfy its stated goal? */
export type ScenarioExpectation = "achieved" | "not_achieved";

export type ScenarioMode = "claim" | "fact-only";

export interface ChallengeCounts {
  code: string;
  flag_count: number;
  flag_got_count: number;
}

export interface EvalScenario {
  id: string;
  title: string;
  description: string;
  expectation: ScenarioExpectation;
  mode: ScenarioMode;
  /** Policy a pre-M40/M41 deployment would have used for this scenario. */
  legacyVerification: {
    kind: VerificationKind;
    challenge_code?: string | null;
  };
  /** M41 goal conditions used by the hardened variant. */
  goalConditions: ProjectGoalConditionInput[];
  challenge?: ChallengeCounts;
  /** Tokens after which the scheduler must stop dispatching reason/explore/bootstrap. */
  maxProjectTokens?: number;
  usage: { tokens: number; costUsd: number };
  maxCycles: number;
}

/**
 * Five situations from the M42 acceptance list. The same worker behaviour is run twice:
 * once with the pre-hardening policy and auto completion, once with M41 goal conditions.
 */
export const SCENARIOS: readonly EvalScenario[] = [
  {
    id: "single_flag",
    title: "单 flag",
    description: "目标只需要一个 flag，模型声明完成。",
    expectation: "achieved",
    mode: "claim",
    legacyVerification: { kind: "off" },
    goalConditions: [{ kind: "challenge", challenge_code: "eval-single" }],
    challenge: { code: "eval-single", flag_count: 1, flag_got_count: 1 },
    usage: { tokens: 600, costUsd: 0.002 },
    maxCycles: 3,
  },
  {
    id: "partial_flag",
    title: "部分 flag",
    description: "目标需要两个 flag，只拿到一个，模型仍声明完成。",
    expectation: "not_achieved",
    mode: "claim",
    legacyVerification: { kind: "off" },
    goalConditions: [{ kind: "challenge", challenge_code: "eval-partial" }],
    challenge: { code: "eval-partial", flag_count: 2, flag_got_count: 1 },
    usage: { tokens: 700, costUsd: 0.0025 },
    maxCycles: 3,
  },
  {
    id: "wrong_completion",
    title: "错误完成",
    description: "没有任何 flag，模型用否定目标的口吻提交 complete。",
    expectation: "not_achieved",
    mode: "claim",
    legacyVerification: { kind: "off" },
    goalConditions: [{ kind: "flag_count", min: 1 }],
    usage: { tokens: 500, costUsd: 0.0018 },
    maxCycles: 3,
  },
  {
    id: "budget_exhausted",
    title: "预算耗尽",
    description: "bootstrap 记录一个事实后预算耗尽，不应关闭项目。",
    expectation: "not_achieved",
    mode: "fact-only",
    legacyVerification: { kind: "off" },
    goalConditions: [{ kind: "flag_count", min: 1 }],
    maxProjectTokens: 100,
    usage: { tokens: 600, costUsd: 0.002 },
    maxCycles: 4,
  },
  {
    id: "missing_evidence",
    title: "证据缺失",
    description: "模型声明完成，但任务没有留下任何证据文件。",
    expectation: "not_achieved",
    mode: "claim",
    legacyVerification: { kind: "evidence" },
    goalConditions: [{ kind: "evidence" }],
    usage: { tokens: 400, costUsd: 0.0015 },
    maxCycles: 3,
  },
];
