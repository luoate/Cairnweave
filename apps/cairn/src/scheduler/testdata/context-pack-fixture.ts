import type { SnapshotFact, TaskContextSnapshot } from "@cairn/graph";
export function contextSnapshot(count = 120): TaskContextSnapshot {
  const fact = (id: string, description: string): SnapshotFact => ({ id, description,
    status: "current", superseded_by: null, evidence: { status: "legacy", run_id: null, refs: 0 },
    created_at: "2026-11-05T00:00:00Z", metadata_created_at: null, from: id === "origin" || id === "goal" ? [] : ["origin"], evidence_refs: [] });
  return {
    version: 1, project: { id: "proj_001", title: "授权测试", status: "active" },
    goal: { description: "取得三项已确认成果", verification: { kind: "evidence", challenge_code: null,
      progress: { found: null, total: null, last_checked_at: null }, checks: { total: 0, passed: 0, failed: 0 },
      conditions: [{ ordinal: 0, kind: "flag_count", ok: null, detail: null, challenge_code: null, progress: { found: null, total: null } }], latest: null } },
    goal_conditions: [{ ordinal: 0, kind: "flag_count", challenge_code: null, min: 3 }],
    budget: { used_tokens: 10, limit_tokens: 1000, used_cost_usd: 0.01, limit_cost_usd: 1, running_tasks: 1 },
    delta: { since: "2026-11-04T00:00:00Z", new_facts: count, concluded_intents: 1, new_hints: 2, failed_attempts: 1 },
    reviews: { flags: { pending: 1, fake: 2 }, completion: { pending: 0, approved: 0, rejected: 1 } },
    facts: [fact("origin", "授权本地起点"), fact("goal", "取得三项已确认成果"),
      ...Array.from({ length: count }, (_, i) => fact(`f${String(i + 1).padStart(3, "0")}`, `客观事实 ${i + 1} 🧭`))],
    intents: ["open", "abandoned", "concluded"].map((status, index) => ({
      id: `i${index + 1}`, description: `探索方向 ${index + 1}`, from: ["f001"],
      status: status as "open" | "abandoned" | "concluded", status_reason: index === 1 ? "未能验证，不是反证" : null,
      status_by: index === 1 ? "operator" : null, status_at: index === 1 ? "2026-11-05T00:00:00Z" : null,
      attempts: 1, last_outcome: "failed", last_error: "timeout; hypothesis unproven", priority: 50,
      to: index === 2 ? "f002" : null, creator: "test", worker: index === 0 ? "peer" : null,
      created_at: "2026-11-05T00:00:00Z", concluded_at: index === 2 ? "2026-11-05T00:01:00Z" : null,
      dedupe_key: `route-${index}`, budget: { max_seconds: 30, max_tool_calls: 4 },
    })),
    attempts: [{ run_id: "run-1", kind: "explore", intent_id: "i1", outcome: "failed",
      started_at: "2026-11-05T00:00:00Z", duration_ms: 10, tokens: 10, detail: "timeout; hypothesis unproven" }],
    hints: Array.from({ length: 12 }, (_, index) => ({ id: `h${index}`, content: `线索 ${index}`,
      creator: "test", created_at: "2026-11-05T00:00:00Z" })),
    detail_policy: "agent_context_500_chars",
  };
}
