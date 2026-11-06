import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectExperimentResult, type AttemptMemory } from "@cairn/graph";
import { checkpoint } from "../../../../packages/contracts/src/testdata/checkpoint";
import { contextSnapshot } from "./testdata/context-pack-fixture";
import { buildContextPack, type BuildPackInput } from "./context-pack";
import { buildContextStore, persistContextStore, recoverContextRecord } from "./context-store";
function fixture() {
  const snapshot = contextSnapshot();
  const memory: AttemptMemory = { trust: "worker_claim_not_verified", sequence: 3, accepted_at: "2026-11-05T00:01:00Z",
    checkpoint: checkpoint({ project_id: snapshot.project.id, sequence: 3 }),
    control: { outcome: "failed", termination_reason: "hard_deadline" },
    reuse: { intent_status: "open", scope_status: "unchanged_requires_authorization", project_status: "active",
      budget: "recheck_current_pack_core", automatic_execution: false,
      facts: [{ id: "f1", status: "missing", superseded_by: null }], evidence: [{ ref: "artifacts/test.log", status: "missing" }] } };
  memory.experiment_result = projectExperimentResult({ checkpoint: memory.checkpoint, outcome: memory.control.outcome,
    terminationReason: memory.control.termination_reason, evidence: memory.reuse.evidence });
  snapshot.attempts[0]!.memory = memory;
  return snapshot;
}
function input(snapshot = fixture()): BuildPackInput {
  return { snapshot, catalog: buildContextStore(snapshot, 1024).catalog, kind: "reason", taskId: "reason-test",
    scope: { targets: ["127.0.0.1:8080"] }, promptBytes: 100, maxInitialBytes: 20000, legacyInitialBytes: 100000,
    completionPolicy: { evidence_enforcement: "completion", flag_review: "manual", off_completion: "manual", evidence_completion: "manual" } };
}
describe("M49 ContextPack structured attempt memory", () => {
  test("selects complete memory as data, with control outcome and stale metadata separate from claims", () => {
    const value = input(); const result = buildContextPack(value);
    expect(result.status).toBe("ready"); if (result.status !== "ready") throw new Error("no candidate");
    const parsed = Bun.YAML.parse(result.candidate.text) as any;
    expect(parsed.attempts[0].memory).toEqual(value.snapshot.attempts[0]!.memory);
    expect(result.candidate.bytes + value.promptBytes).toBeLessThanOrEqual(value.maxInitialBytes);
    expect(result.candidate.selections.find((s) => s.section === "attempts")?.policy).toBe("structured_attempt_memory_balanced_v1");
  });
  test("oversized optional memories are omitted whole and recovered byte-equivalently from bounded shards", () => {
    const value = input();
    value.snapshot.attempts[0]!.memory!.checkpoint.progress = "未验证的长进展🧭".repeat(400);
    value.catalog = buildContextStore(value.snapshot, 1024).catalog;
    const generous = buildContextPack(value); if (generous.status !== "ready") throw new Error("no candidate");
    value.maxInitialBytes = generous.candidate.pinned_initial_bytes + 200;
    const result = buildContextPack(value); expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("no candidate");
    expect(result.candidate.selected_ids.attempts).toEqual([]); expect(result.candidate.text).not.toContain("未验证的长进展");
    expect(result.candidate.bytes + value.promptBytes).toBeLessThanOrEqual(value.maxInitialBytes);
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-recovery-"));
    try {
      const store = buildContextStore(value.snapshot, 1024); persistContextStore(dir, store);
      for (const bytes of store.files.values()) expect(bytes.byteLength).toBeLessThanOrEqual(1024);
      expect(recoverContextRecord(join(dir, "context-store"), value.snapshot.project.id, store.catalog.snapshot_id, "attempts", "run-1")).toEqual(value.snapshot.attempts[0]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("explore can select a related old intent's memory by pinned fact without treating it as a current fact", () => {
    const value = input(); value.kind = "explore"; value.focusIntentId = "i1";
    value.snapshot.attempts[0]!.intent_id = "i2";
    value.snapshot.attempts[0]!.memory!.checkpoint.attempts[0]!.fact_refs = ["f001"];
    value.catalog = buildContextStore(value.snapshot, 1024).catalog;
    const result = buildContextPack(value); expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("no candidate");
    expect(result.candidate.selected_ids.attempts).toContain("run-1");
    const parsed = Bun.YAML.parse(result.candidate.text) as any;
    expect(parsed.facts.every((f: any) => f.description !== "工具无法启动")).toBe(true);
  });
});
