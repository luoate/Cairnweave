/** Offline worker that actually reads the selected input and recovers an omitted record. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerTask } from "@cairn/contracts";
const task = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as WorkerTask;
let recovered: string | null = null;
const compact = task.prompt.includes("context-pack.yaml");
if (compact) {
  const pack = Bun.YAML.parse(readFileSync(join(task.sessionDir, "context-pack.yaml"), "utf8")) as any;
  if (pack.core.scope.targets[0] !== task.scope.targets[0]) throw new Error("scope mismatch");
  const root = join(task.sessionDir, "context-store");
  const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
  if (catalog.project_id !== task.projectId || catalog.snapshot_id !== pack.snapshot.id) throw new Error("snapshot mismatch");
  const seen = new Set(["origin", "goal", ...pack.facts.map((fact: any) => fact.id)]);
  for (let index = 0; index < catalog.sections.facts.index_pages && recovered === null; index += 1) {
    const lines = readFileSync(join(root, `facts/index-${index}.jsonl`), "utf8").trim().split("\n");
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (seen.has(entry.id)) continue;
      let record = JSON.parse(readFileSync(join(root, entry.path), "utf8"));
      if (record.chunked === true) {
        const parts: Buffer[] = [];
        for (let part = 0; part < record.parts; part += 1) parts.push(readFileSync(join(root, record.part_pattern.replace("{index}", String(part)))));
        const bytes = Buffer.concat(parts);
        if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) throw new Error("digest mismatch");
        record = JSON.parse(bytes.toString("utf8"));
      }
      if (record.id !== entry.id || typeof record.description !== "string") throw new Error("bad recovery");
      recovered = record.id; break;
    }
  }
  if (recovered === null) throw new Error("fixture needs an omitted record");
}
writeFileSync(join(task.sessionDir, "context-read-proof.json"), JSON.stringify({ input: compact ? "compact" : "legacy", recovered_id: recovered }));
writeFileSync(task.resultPath, JSON.stringify(process.argv[3] === "claim"
  ? { accepted: true, data: { complete: { from: ["origin"], description: "unsupported completion claim" } } }
  : task.kind === "explore" ? { accepted: true, data: { description: "焦点任务的新确认结果" } } : { accepted: true, data: {} }));
