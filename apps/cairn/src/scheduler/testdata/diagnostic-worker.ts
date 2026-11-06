// Deterministic infrastructure failure fixture. No solver or external requests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const task = await Bun.file(process.argv[2]!).json();
const dir = join(task.sessionDir, "solver-session");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "session.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-11-05T07:00:00Z",
  message: { role: "assistant", stopReason: "error", errorMessage: "Connection error. Bearer fixture-secret" } }) + "\n");
if (process.argv[3] === "timeout") await Bun.sleep(30000);
process.exit(3);
