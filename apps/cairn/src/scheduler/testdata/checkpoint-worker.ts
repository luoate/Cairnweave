/** Offline worker process: produces progress, then succeeds, crashes or is terminated. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerTask } from "@cairn/contracts";
import { CheckpointPublisher } from "../../checkpoint/worker";
const task = await Bun.file(process.argv[2]!).json() as WorkerTask;
const mode = process.argv[3] ?? "success";
if (process.env["CAIRN_TASK_CHECKPOINT"] === "1") {
  const evidence = `${task.artifactDir ?? "artifacts/checkpoint-test"}/checkpoint-proof.log`;
  mkdirSync(dirname(join(task.workspace, evidence)), { recursive: true });
  writeFileSync(join(task.workspace, evidence), "tool could not start; no hypothesis test took place");
  const publisher = new CheckpointPublisher(task);
  publisher.start(10000);
  publisher.save({ progress: "请求未执行，环境问题待处理", attempts: [{ id: "a1", action: "测试候选入口",
    observation: "依赖不可用，未发出请求", interpretation: "不能否定该方向", result: "environment_failure",
    fact_refs: ["origin"], evidence_refs: [evidence] }], unresolved: ["依赖缺失"], next_steps: ["DO_NOT_EXECUTE_SUGGESTION"] });
  if (mode === "partial") { await Bun.sleep(1350); publisher.stop(); writeFileSync(join(task.sessionDir, "checkpoint.json"), '{"version":'); await Bun.sleep(1300); process.exit(17); }
  if (mode === "timeout" || mode === "cancel") await Bun.sleep(15000);
  else await Bun.sleep(1500);
  publisher.stop();
  if (mode === "crash") process.exit(17);
}
writeFileSync(task.resultPath, JSON.stringify({ accepted: true, data: task.kind === "reason" ? { intents: [{ from: ["origin"], description: "manual follow-up route" }] } : { description: "offline result" } }));
