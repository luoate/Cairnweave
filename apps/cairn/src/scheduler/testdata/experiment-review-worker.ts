/** Offline M51c protocol fixture: reads task-local recovery files, never a DB or model. */
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { recoverContextRecord } from "../context-store";
import { experiment } from "../../../../../packages/contracts/src/testdata/experiment";
const taskPath = process.argv[2]!;
const task = JSON.parse(await Bun.file(taskPath).text());
const runId = process.argv[3]!, mode = process.argv[4] ?? "continue";
if (task.kind !== "reason") {
  writeFileSync(task.resultPath, JSON.stringify({ accepted: false, reason: "offline fixture only" }));
  process.exit(0);
}
let source: any;
try {
  const root = join(dirname(taskPath), "context-store");
  const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
  source = recoverContextRecord(root, task.projectId, catalog.snapshot_id, "attempts", runId);
} catch { /* exercise unauthorized output rejection */ }
const intent = {
  from: ["origin"], description: "根据局部响应差异验证新的对照条件", priority: 90, dedupe_key: "experiment-followup",
  experiment: experiment({ hypothesis: "下一次对照 {max_intents} 是否可复现", action: "比较新的授权条件" }),
  experiment_review: {
    source_intent_id: source?.intent_id ?? "i001", choice: mode === "invalid-ref" ? "change_direction" : mode,
    rationale: "把局部观察与预期信号对照，不作整体反证",
    observations: mode === "need_observation" ? [] : [{ run_id: runId,
      checkpoint_sequence: source?.memory?.sequence ?? 1, attempt_id: mode === "invalid-ref" ? "invented" : "a1" }],
  },
};
writeFileSync(task.resultPath, JSON.stringify({ accepted: true, data: { intents: [
  ...(mode === "invalid-ref" ? [{ from: ["origin"], description: "不得残留的前置方向", dedupe_key: "partial" }] : []), intent,
] } }));
