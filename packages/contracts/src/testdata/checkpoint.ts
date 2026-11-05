import type { TaskCheckpoint } from "../checkpoint";
export function checkpoint(extra: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return { version: 1, project_id: "p1", task_id: "explore-test", sequence: 1, intent_id: "i1", stage: "working",
    progress: "已检查入口，仍不确定", attempts: [{ id: "a1", action: "尝试请求", observation: "工具无法启动",
      interpretation: "没有测试目标，不能否定假设", result: "tool_failure", fact_refs: ["f1"], evidence_refs: ["artifacts/test.log"] }],
    unresolved: ["环境未恢复"], next_steps: ["检查依赖，需重新授权"], ...extra };
}
