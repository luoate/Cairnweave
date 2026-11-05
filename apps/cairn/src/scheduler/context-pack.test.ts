import { describe, expect, test } from "bun:test";
import { buildContextPack, contextPackLog, type BuildPackInput, type ContextPackReport } from "./context-pack";
import { buildContextStore } from "./context-store";
import { contextSnapshot } from "./testdata/context-pack-fixture";
function input(extra: Partial<BuildPackInput> = {}): BuildPackInput {
  const snapshot = extra.snapshot ?? contextSnapshot();
  return { snapshot, catalog: buildContextStore(snapshot, 8192).catalog, kind: "reason",
    taskId: "reason-test", scope: { targets: ["127.0.0.1:8080"] }, promptBytes: Buffer.byteLength("中文🧭"),
    maxInitialBytes: 16384, legacyInitialBytes: 100000,
    completionPolicy: { evidence_enforcement: "completion", flag_review: "manual", off_completion: "manual", evidence_completion: "manual" }, ...extra };
}
function ready(value: BuildPackInput) {
  const result = buildContextPack(value);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw new Error("expected candidate");
  return result.candidate;
}

describe("M48 budgeted deterministic selection", () => {
  test("pins goal conditions, progress, reviews, budget and scope, and counts final UTF-8 bytes", () => {
    const value = input();
    const candidate = ready(value);
    const parsed = Bun.YAML.parse(candidate.text) as any;
    expect(parsed.core.goal_conditions).toEqual(value.snapshot.goal_conditions);
    expect(parsed.core.goal).toEqual(value.snapshot.goal);
    expect(parsed.core.reviews).toEqual(value.snapshot.reviews);
    expect(parsed.core.budget).toEqual(value.snapshot.budget);
    expect(parsed.core.scope).toEqual(value.scope);
    expect(candidate.bytes).toBe(Buffer.byteLength(candidate.text));
    expect(candidate.bytes + value.promptBytes).toBeLessThanOrEqual(value.maxInitialBytes);
    expect(parsed.overview.omitted_are_unknown_not_absent).toBe(true);
    expect(candidate.selections[0]!.candidates).toBe(122);
    expect(candidate.selections[0]!.selected).toBe(parsed.facts.length + 2);
  });

  test("budget boundary preserves all core data and never silently clips it", () => {
    const value = input();
    const initial = ready(value).pinned_initial_bytes;
    const exact = ready({ ...value, maxInitialBytes: initial });
    expect(exact.pinned_initial_bytes).toBe(initial);
    expect(buildContextPack({ ...value, maxInitialBytes: initial - 1 })).toMatchObject({ status: "fallback", reason: "pinned_content_over_budget" });
    expect(buildContextPack({ ...value, legacyInitialBytes: initial })).toMatchObject({ status: "fallback", reason: "no_benefit" });
  });

  test("a long optional record becomes recoverable omission, not a misleading prefix", () => {
    const snapshot = contextSnapshot();
    snapshot.facts[2]!.description = "唯一长记录秘密尾部".repeat(40000);
    const candidate = ready(input({ snapshot }));
    expect(candidate.selected_ids.facts).not.toContain("f001");
    expect(candidate.text).not.toContain("唯一长记录秘密尾部");
    expect(candidate.selections[0]!.selected).toBeLessThan(candidate.selections[0]!.candidates);
  });

  test("explore pins every direct source and its complete replacement chain", () => {
    const snapshot = contextSnapshot(6);
    snapshot.facts[2]!.status = "superseded"; snapshot.facts[2]!.superseded_by = "f002";
    snapshot.facts[3]!.status = "superseded"; snapshot.facts[3]!.superseded_by = "f003";
    const candidate = ready(input({ snapshot, kind: "explore", focusIntentId: "i1" }));
    expect(candidate.selected_ids.facts).toEqual(expect.arrayContaining(["f001", "f002", "f003"]));
    expect((Bun.YAML.parse(candidate.text) as any).intents.find((entry: any) => entry.id === "i1")).toEqual(snapshot.intents[0]);
  });

  test("missing focus, broken or cyclic replacement chains and mismatched snapshots fail closed to legacy", () => {
    expect(buildContextPack(input({ kind: "explore", focusIntentId: "missing" }))).toMatchObject({ reason: "snapshot_inconsistent" });
    for (const target of ["missing", "f001"]) {
      const snapshot = contextSnapshot(); snapshot.facts[2]!.superseded_by = target;
      expect(buildContextPack(input({ snapshot, kind: "explore", focusIntentId: "i1" }))).toMatchObject({ reason: "snapshot_inconsistent" });
    }
    const value = input(); value.catalog.snapshot_id = "wrong";
    expect(buildContextPack(value)).toMatchObject({ reason: "snapshot_inconsistent" });
  });

  test("large pinned content falls back instead of truncating an explore dependency", () => {
    const snapshot = contextSnapshot(); snapshot.facts[2]!.description = "必需的依赖🧭".repeat(20000);
    expect(buildContextPack(input({ snapshot, kind: "explore", focusIntentId: "i1" }))).toMatchObject({ status: "fallback", reason: "pinned_content_over_budget" });
  });

  test("recent current facts outrank earliest IDs and failures retain their actual meaning", () => {
    const candidate = ready(input());
    const facts = (Bun.YAML.parse(candidate.text) as any).facts;
    expect(facts[0].id).toBe("f120");
    expect(candidate.text).toContain("hypothesis unproven");
    expect(candidate.text).toContain("abandoned");
    expect(candidate.text).toContain("concluded");
  });

  test("selection is deterministic, independent of file persistence, and never mutates input", () => {
    const value = input(); const before = JSON.stringify(value);
    expect(buildContextPack(value)).toEqual(buildContextPack(value));
    expect(JSON.stringify(value)).toBe(before);
  });

  test("fixed-code logs contain metrics, not source bodies or host paths", () => {
    const report: ContextPackReport = { version: 1, mode: "apply", status: "fallback", fallback_reason: "snapshot_write_failed",
      legacy_initial_bytes: 500, candidate_initial_bytes: null, actual_initial_bytes: 500,
      max_initial_bytes: 400, snapshot_id: null, selections: [] };
    expect(contextPackLog(report)).toContain("reason=snapshot_write_failed");
    expect(contextPackLog({ ...report, status: "off" })).toBeNull();
  });
});
