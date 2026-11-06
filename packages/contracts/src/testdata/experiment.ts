import type { ExperimentContract } from "../experiment";
export function experiment(extra: Partial<ExperimentContract> = {}): ExperimentContract {
  return { version: 1, hypothesis: "入口是否存在差异", action: "在授权范围比较响应 {intent_id}",
    expected_signal: "响应状态和内容的可重复差异", evidence_required: "保存脱敏响应与请求条件",
    stop_condition: "范围不符或工具不可用时停止并报告未知", ...extra };
}
