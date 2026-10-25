/**
 * M4c gate: a real model runs one Cairn bootstrap task with the Observer enabled, then
 * the Observer sidecar performs a real review on the same task.
 *
 * This gate is intentionally outside `bun test`: it calls a real model and costs money.
 * It needs credentials under `~/.tch-agent/config` (override with CAIRN_AGENT_CONFIG_DIR).
 *
 *   bun run tools/gate/m4c-observer-gate.ts
 *
 * What it proves:
 * - the scheduler injects the Observer environment and writes the context snapshot;
 * - the real main solver can use the three read-only board tools;
 * - the real sidecar runs with only board/history tools, not `send_efficiency_reminder`;
 * - the sidecar's review is persisted in the audit and the task-scoped queue is drained
 *   before the solver returns;
 * - the project-level board changes after the review;
 * - the main solver cannot mutate the board, and the task result is unaffected.
 *
 * The gate runs locally, not in a container. Container-specific Observer behaviour
 * (read-only config copy and path mapping) is covered by the M3 gate and deterministic
 * runtime tests. Set CAIRN_GATE_KEEP=1 to keep the temporary directory for inspection.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  createProject,
  getProjectDetail,
  type ProjectDetail,
} from "@cairn/graph";

import { parseDispatchConfig } from "../../apps/cairn/src/config";
import { Scheduler } from "../../apps/cairn/src/scheduler/loop";

const MARKER = `CAIRN-M4C-OBSERVER-${crypto.randomUUID().slice(0, 8)}`;
const TIMEOUT_SECONDS = 300;
const SEEDED_IDEA = "Read marker.txt in the workspace and record the exact marker value.";
const READ_BOARD_TOOLS = new Set(["memory_list", "idea_list", "idea_search"]);
const FORBIDDEN_MAIN_TOOLS = new Set([
  "memory_add",
  "memory_update",
  "memory_delete",
  "idea_add",
  "idea_update",
]);
const ALLOWED_SIDECAR_TOOLS = new Set([
  "memory_list",
  "memory_add",
  "memory_update",
  "memory_delete",
  "idea_list",
  "idea_search",
  "idea_add",
  "idea_update",
  "query_solver_history",
]);

const directory = mkdtempSync(join(tmpdir(), "cairn-m4c-observer-gate-"));
const workspaceRoot = join(directory, "workspace");
const agentConfigDir =
  process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim() || join(homedir(), ".tch-agent", "config");
const db = configureDatabase(join(directory, "cairn.db"));

const config = parseDispatchConfig({
  server: "http://127.0.0.1:8000",
  runtime: {
    execution: "local",
    max_workers: 1,
    max_running_projects: 1,
    max_project_workers: 1,
    interval: 1,
    healthcheck_timeout: 15,
    worker_healthcheck: "disabled",
    prompt_group: "default",
  },
  tasks: {
    bootstrap: { timeout: TIMEOUT_SECONDS, conclude_timeout: 180 },
    reason: { timeout: TIMEOUT_SECONDS, max_intents: 1 },
    explore: { timeout: TIMEOUT_SECONDS, conclude_timeout: 180 },
  },
  local: { completed_action: "keep" },
  worker: {
    soft_deadline_ratio: 0.9,
    retain_task_files: true,
    result_grace_seconds: 10,
  },
  observer: {
    enabled: true,
    model: "cairn-worker",
    // The final flush/agent_end review is the one this gate needs. Avoid extra periodic
    // reviews so the real-model cost stays small.
    every_rounds: 99,
    window_rounds: 8,
    timeout_seconds: 180,
    max_reviews_per_task: 1,
    kernel_tasks: ["bootstrap"],
  },
});

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The board is a stable on-disk contract (`<root>/board/{ideas,memory}`). The gate reads
 * and seeds it directly so the tool under test is the sidecar, not an in-process helper.
 */
interface BoardIdea {
  id: string;
  content: string;
  status: string;
  result: string;
}

interface BoardSnapshot {
  ideas: BoardIdea[];
  memory: unknown[];
}

const checks: Check[] = [];
const logs: string[] = [];
let failure: string | null = null;
let scheduler: Scheduler | null = null;
let boardDir = "";
let seededIdea: BoardIdea | null = null;

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` - ${detail}`}`);
}

function load(projectId: string): ProjectDetail {
  return db.withConn((conn) => getProjectDetail(conn, projectId));
}

function preview(value: string, limit = 220): string {
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

async function seedBoard(boardRoot: string, content: string): Promise<BoardIdea> {
  const now = new Date().toISOString();
  const item: BoardIdea = {
    id: `idea_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
    content,
    status: "pending",
    result: "",
  };
  const ideasDir = join(boardRoot, "board", "ideas");
  const byIdDir = join(ideasDir, "by-id");
  mkdirSync(byIdDir, { recursive: true });
  mkdirSync(join(boardRoot, "board", "memory", "entries"), { recursive: true });
  await Bun.write(
    join(ideasDir, "index.json"),
    `${JSON.stringify(
      {
        challengeId: "board",
        updated_at: now,
        items: [{ ...item, normalized: content.trim().toLowerCase(), created_at: now, updated_at: now }],
      },
      null,
      2,
    )}\n`,
  );
  await Bun.write(
    join(byIdDir, `${item.id}.json`),
    `${JSON.stringify({ ...item, normalized: content.trim().toLowerCase(), created_at: now, updated_at: now }, null, 2)}\n`,
  );
  return item;
}

function readBoard(boardRoot: string): BoardSnapshot {
  const indexPath = join(boardRoot, "board", "ideas", "index.json");
  let ideas: BoardIdea[] = [];
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { items?: unknown };
      if (Array.isArray(parsed.items)) ideas = parsed.items as BoardIdea[];
    } catch {
      ideas = [];
    }
  }
  const memoryDir = join(boardRoot, "board", "memory", "entries");
  const memory = existsSync(memoryDir)
    ? readdirSync(memoryDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name)
    : [];
  return { ideas, memory };
}

function findFiles(root: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      found.push(...findFiles(path, predicate));
    } else if (predicate(path)) {
      found.push(path);
    }
  }
  return found.sort();
}

interface SessionScan {
  files: string[];
  toolCalls: string[];
  assistantTexts: string[];
}

function scanSessions(files: string[]): SessionScan {
  const toolCalls: string[] = [];
  const assistantTexts: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== "object") continue;
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object") continue;
      if ((message as { role?: unknown }).role !== "assistant") continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if ((block as { type?: unknown }).type === "toolCall") {
          const name = (block as { name?: unknown }).name;
          if (typeof name === "string") toolCalls.push(name);
        }
        if ((block as { type?: unknown }).type === "text") {
          const value = (block as { text?: unknown }).text;
          if (typeof value === "string" && value.trim() !== "") {
            assistantTexts.push(value.trim());
          }
        }
      }
    }
  }
  return { files, toolCalls, assistantTexts };
}

interface AuditEntry {
  event?: unknown;
  reason?: unknown;
  applied?: unknown;
  error?: unknown;
}

function readAudit(workspace: string): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const file of findFiles(workspace, (path) => path.endsWith("observer/audit.jsonl") || path.endsWith("observer\\audit.jsonl"))) {
    for (const rawLine of readFileSync(file, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (line === "") continue;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // A torn log line from a killed worker is not useful here.
      }
    }
  }
  return entries;
}

function hasBoardChange(
  beforeIdea: BoardIdea,
  after: BoardSnapshot,
): boolean {
  if (after.memory.length > 0) return true;
  if (after.ideas.length > 1) return true;
  const current = after.ideas.find((idea) => idea.id === beforeIdea.id);
  if (current === undefined) return true;
  return (
    current.status !== beforeIdea.status ||
    current.result.trim() !== beforeIdea.result.trim() ||
    current.content.trim() !== beforeIdea.content.trim()
  );
}

function describeBoard(board: BoardSnapshot): string {
  const ideaSummary = board.ideas
    .map((idea) => `${idea.id}:${idea.status}${idea.result.trim() === "" ? "" : "=result"}`)
    .join(", ");
  return `ideas=[${ideaSummary}] memory=${board.memory.length}`;
}

try {
  const modelsPath = join(agentConfigDir, "models.json");
  const authPath = join(agentConfigDir, "auth.json");
  const configPresent = existsSync(modelsPath) && existsSync(authPath);
  check(
    "model credentials are configured",
    configPresent,
    configPresent ? `${agentConfigDir} (not printed)` : "models.json or auth.json is missing",
  );
  if (!configPresent) throw new Error("real-model credentials are missing");

  const created = db.withConn((conn) =>
    createProject(conn, {
      title: "m4c-observer-gate",
      origin:
        "A local temporary workspace is the worker's current working directory. It contains marker.txt, " +
        "created for this authorized test.",
      goal:
        "Read the exact contents of marker.txt in the workspace and report them in the bootstrap Fact. " +
        "Before you act, call idea_list and memory_list to inspect the project board. " +
        "Do not modify or delete board entries. Then return the required JSON.",
      bootstrap_enabled: true,
      hints: [
        {
          content:
            "The project board has one pending idea about reading marker.txt. Confirm the marker before considering it verified.",
          creator: "m4c-gate",
        },
      ],
      scope: {
        targets: [`file://${workspaceRoot.replaceAll("\\", "/")}`],
        notes: "Local temporary workspace created by the M4c Observer gate.",
      },
    }),
  );
  const projectId = created.project.id;
  const workspace = join(workspaceRoot, projectId);
  mkdirSync(workspace, { recursive: true });
  const markerPath = join(workspace, "marker.txt");
  await Bun.write(markerPath, `${MARKER}\n`);

  boardDir = join(workspace, ".cairn", "board");
  seededIdea = await seedBoard(boardDir, SEEDED_IDEA);
  check(
    "project board is seeded before the task",
    existsSync(join(boardDir, "board", "ideas", "index.json")),
    `idea=${seededIdea.id} status=${seededIdea.status}`,
  );

  process.env["CAIRN_SOLVER"] = "breachweave";
  scheduler = new Scheduler({
    db,
    config,
    workspaceRoot,
    log: (message) => {
      logs.push(message);
      console.error(`[gate] ${message}`);
    },
  });
  await scheduler.runUntilIdle(1_000);

  const detail = load(projectId);
  const dynamicFacts = detail.facts.filter((fact) => fact.id !== "origin" && fact.id !== "goal");
  check("project completed", detail.project.status === "completed", detail.project.status);
  check(
    "real solver produced a Fact containing the marker",
    dynamicFacts.some((fact) => fact.description.includes(MARKER)),
    `${dynamicFacts.length} dynamic fact(s)`,
  );

  const sessionDirs = findFiles(workspace, (path) => path.endsWith("observer-context.json"));
  const contextPath = sessionDirs.at(-1);
  let contextOk = false;
  let contextDetail = "observer-context.json missing";
  if (contextPath !== undefined) {
    try {
      const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
        version?: unknown;
        project?: { id?: unknown };
        focus?: { kind?: unknown };
        scope?: { targets?: unknown };
      };
      const normalizedRoot = workspaceRoot.replaceAll("\\", "/");
      contextOk =
        context.version === 1 &&
        context.project?.id === projectId &&
        context.focus?.kind === "bootstrap" &&
        Array.isArray(context.scope?.targets) &&
        context.scope.targets.some(
          (target) => typeof target === "string" && target.includes(normalizedRoot),
        );
      contextDetail = contextOk ? preview(readFileSync(contextPath, "utf8")) : "unexpected context values";
    } catch (error) {
      contextDetail = error instanceof Error ? error.message : String(error);
    }
  }
  check("scheduler wrote the enabled Observer context", contextOk, contextDetail);

  const audit = readAudit(workspace);
  const events = audit.map((entry) => entry.event);
  check(
    "Observer audit records a started and finished review",
    events.includes("review_started") && events.includes("review_finished"),
    events.join(",") || "no audit",
  );
  check(
    "Observer review did not fail or time out",
    !events.includes("review_failed") &&
      !events.includes("flush_failed") &&
      !events.includes("flush_timeout") &&
      !events.includes("review_skipped"),
    events.join(",") || "no audit",
  );
  const finished = audit.filter((entry) => entry.event === "review_finished").at(-1);
  check(
    "Observer flush drained the queue before the task returned",
    events.includes("flush_finished") &&
      findFiles(workspace, (path) => path.includes("review-queue") && path.endsWith(".json")).length === 0,
    finished === undefined ? "no review_finished" : `applied=${String(finished.applied)}`,
  );

  const allSessionFiles = findFiles(workspace, (path) => path.endsWith(".jsonl"));
  const sidecarFiles = allSessionFiles.filter((path) => path.includes("observer/sidecar") || path.includes("observer\\sidecar"));
  const mainFiles = allSessionFiles.filter(
    (path) =>
      path.includes("solver-session") &&
      !path.includes("observer/sidecar") &&
      !path.includes("observer\\sidecar"),
  );
  const sidecar = scanSessions(sidecarFiles);
  const main = scanSessions(mainFiles);

  check(
    "sidecar persisted a real assistant review",
    sidecar.files.length > 0 && sidecar.assistantTexts.length > 0,
    `${sidecar.files.length} file(s), ${sidecar.assistantTexts.length} assistant message(s)`,
  );
  const sidecarTools = [...new Set(sidecar.toolCalls)];
  check(
    "sidecar only used board/history tools",
    sidecarTools.length > 0 && sidecarTools.every((name) => ALLOWED_SIDECAR_TOOLS.has(name)),
    sidecarTools.join(",") || "no tool calls",
  );
  check(
    "sidecar did not receive the efficiency-steer tool",
    !sidecarTools.includes("send_efficiency_reminder"),
    sidecarTools.join(",") || "no tool calls",
  );

  const mainTools = [...new Set(main.toolCalls)];
  check(
    "main solver used the read-only board tools",
    mainTools.some((name) => READ_BOARD_TOOLS.has(name)),
    mainTools.join(",") || "no tool calls",
  );
  check(
    "main solver never called a board mutation tool",
    !mainTools.some((name) => FORBIDDEN_MAIN_TOOLS.has(name)),
    mainTools.join(",") || "no tool calls",
  );

  const after = readBoard(boardDir);
  check(
    "sidecar changed the durable project board",
    seededIdea !== null && hasBoardChange(seededIdea, after),
    describeBoard(after),
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (scheduler !== null) {
    try {
      await scheduler.stop();
    } catch {
      // Best effort.
    }
  }

  console.log("\n=== M4c Observer gate ===");
  if (failure !== null) console.log(`error: ${failure}`);
  const passedCount = checks.filter((entry) => entry.ok).length;
  const failed = checks.filter((entry) => !entry.ok);
  console.log(`checks: ${passedCount} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.error("--- scheduler log ---");
    console.error(logs.join("\n"));
  }
  console.log(`directory: ${directory}`);
  const passed = failure === null && checks.length > 0 && failed.length === 0;
  if (process.env["CAIRN_GATE_KEEP"] === "1" || !passed) {
    console.log("kept the gate directory for inspection");
  } else {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(passed ? 0 : 1);
}
