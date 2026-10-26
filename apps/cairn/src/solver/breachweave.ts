import type { WorkerTask } from "@cairn/contracts";
import type { AgentSession, SolverObserverHandle } from "@cairn/agent";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { latestSolverSessionFile } from "./session-file";
import type { Solver, SolverUsage } from "./types";

/** Prompt file released from `packages/agent/src/config/prompts/builtin/cairn-worker.md`. */
const PROMPT_NAME = "cairn-worker";

/** Same wrap-up wording as the Phase 0 bridge, sent when the soft deadline arrives. */
const STEER_MESSAGE =
  "The task time budget is nearly exhausted. Stop starting new exploration, " +
  "consolidate the results you have already confirmed, and reply now with the exact " +
  "final JSON object required by the task. Do not call any more tools after this message.";

/**
 * Real BreachWeave solver, called in-process.
 *
 * The vendored agent reads its model/credential configuration from
 * `~/.tch-agent/config` (override with `CAIRN_AGENT_CONFIG_DIR`). The model is selected
 * by the `model: "cairn-worker"` entry in the prompt frontmatter, which points at a
 * model-prefs.json record.
 */
export class BreachWeaveSolver implements Solver {
  readonly name = PROMPT_NAME;
  private lastUsage: SolverUsage | null = null;

  constructor(
    private readonly configDir: string | undefined = process.env["CAIRN_AGENT_CONFIG_DIR"],
  ) {}

  getLastUsage(): SolverUsage | null {
    return this.lastUsage;
  }

  async solve(task: WorkerTask): Promise<string> {
    this.lastUsage = null;
    // Released once per config directory; existing user files are never overwritten.
    const agent = await import("@cairn/agent");
    const sourceConfigDir = this.configDir ?? agent.DEFAULT_CONFIG_DIR;
    // Container mode mounts the agent config read-only. The vendored session's auth
    // storage takes a lock file next to auth.json, which fails with EROFS on that mount
    // and silently drops the credentials. Give each task a private writable copy under
    // the container's /tmp; the source mount stays read-only and the copy is removed when
    // the task ends.
    const prepared = prepareConfigDir(sourceConfigDir, task.taskId);
    const configDir = prepared.dir;
    try {
      if (process.env["CAIRN_AGENT_CONFIG_READONLY"] !== "1") {
        await agent.initBuiltinSkills(configDir);
        await agent.initBuiltinPrompts(configDir);
      }

      // The vendored session reads these injected paths; the worker handles one task, so
      // process-wide environment is per-task by construction.
      process.env["TCH_SOLVER_BASE_DIR"] = task.sessionDir;
      process.env["TCH_SOLVER_SESSION_DIR"] = `${task.sessionDir}/solver-session`;
      process.env["TCH_SOLVER_WORKSPACE"] = task.workspace;

      // Every solver and subagent session loads the gate from these variables. The module
      // path is derived from this file, never from scope/task data.
      process.env["CAIRN_SCOPE_POLICY"] = JSON.stringify({
        projectId: task.projectId,
        taskId: task.taskId,
        workspace: task.workspace,
        sessionDir: task.sessionDir,
        targets: task.scope.targets,
        ...(task.artifactDir === undefined ? {} : { artifactDir: task.artifactDir }),
      });
      process.env["CAIRN_HOST_BRIDGE_MODULE"] = join(
        import.meta.dir,
        "..",
        "host-bridge",
        "worker-extension.ts",
      );

      // A conclude task appends one wrap-up turn to the failed task's session instead of
      // starting cold. The session file lives in the previous task's directory, which the
      // scheduler keeps alive until this task finishes.
      const resumeSessionFile =
        task.kind === "conclude" ? resumeFileFor(task) : undefined;

      let session: AgentSession;
      let observer: SolverObserverHandle | undefined;
      try {
        const created = await agent.createSolverSession({
          solverId: safeId(task.taskId),
          promptName: PROMPT_NAME,
          task: solverText(task),
          ...(resumeSessionFile === undefined ? {} : { resumeSessionFile }),
        });
        session = created.session;
        observer = created.observer;
      } catch (error) {
        throw new Error(
          `BreachWeave session failed (check the model config in ${configDir}): ${describe(error)}`,
        );
      }

      let steerTimer: ReturnType<typeof setTimeout> | undefined;
      if (task.softDeadlineSeconds !== undefined) {
        steerTimer = setTimeout(() => {
          session.steer(STEER_MESSAGE).catch(() => {
            // The session may already be finished; the hard deadline still applies.
          });
        }, task.softDeadlineSeconds * 1000);
      }

      try {
        await session.prompt(solverText(task), {
          expandPromptTemplates: true,
          source: "cairn",
        });
        const answer = session.getLastAssistantText();
        if (typeof answer !== "string" || answer.trim() === "") {
          throw new Error("solver finished without an assistant message");
        }
        // The worker exits immediately after this method returns; give the async
        // Observer a bounded chance to finish. Failures never touch the answer.
        await flushObserver(observer);
        return answer;
      } finally {
        if (steerTimer !== undefined) clearTimeout(steerTimer);
        // Read counters before disposal; a thrown prompt still burned tokens.
        try {
          this.lastUsage = usageFromStats(session.getSessionStats());
        } catch {
          this.lastUsage = null;
        }
        session.dispose();
      }
    } finally {
      prepared.cleanup();
    }
  }
}

interface PreparedConfig {
  dir: string;
  cleanup(): void;
}

/**
 * In container mode the source config is a read-only mount. Copy it to a private
 * per-task directory so pi's auth lock and settings writes work; delete it afterwards.
 * Outside container mode the configured directory is used in place.
 */
function prepareConfigDir(sourceDir: string, taskId: string): PreparedConfig {
  if (process.env["CAIRN_AGENT_CONFIG_READONLY"] !== "1") {
    return { dir: sourceDir, cleanup: () => {} };
  }
  const dir = join(tmpdir(), "cairn-agent-config", safeId(taskId));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(sourceDir, dir, { recursive: true });
  chmodSync(dir, 0o700);
  try {
    chmodSync(join(dir, "auth.json"), 0o600);
  } catch {
    // auth.json may be supplied by an environment-based provider instead.
  }
  process.env["CAIRN_AGENT_CONFIG_DIR"] = dir;
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Cairn's task text with the authorized scope stated up front. This is advisory only:
 * the hard enforcement point is the M3 Host Bridge, not the prompt.
 */
function solverText(task: WorkerTask): string {
  const notes = task.scope.notes === undefined ? "" : ` (${task.scope.notes})`;
  const scope = `Authorized scope (hard limit): ${task.scope.targets.join(", ")}${notes}.
Only interact with these targets. Anything outside this list is out of scope; do not
attempt it.`;
  const evidence = `Evidence contract: the final JSON envelope may carry "evidence_refs" at
the top level, an array of paths relative to the workspace (for example
"artifacts/scan.log") for files you created that support the reported fact. Use paths
inside the workspace only; the control plane rejects absolute paths, parent traversal,
symlinks and missing files. Omit the field when you have no file evidence.`;
  return `${scope}\n\n${evidence}\n\n${task.prompt}`;
}

/** The newest persisted solver session under the failed task's directory. */
function resumeFileFor(task: WorkerTask): string {
  const dir = task.resumeSessionDir;
  if (dir === undefined || dir.trim() === "") {
    throw new Error("conclude task is missing resumeSessionDir");
  }
  const file = latestSolverSessionFile(dir);
  if (file === null) {
    throw new Error(`no solver session to resume under ${dir}`);
  }
  return file;
}

function usageFromStats(stats: {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}): SolverUsage {
  return {
    inputTokens: nonNegative(stats.tokens.input),
    outputTokens: nonNegative(stats.tokens.output),
    cacheReadTokens: nonNegative(stats.tokens.cacheRead),
    cacheWriteTokens: nonNegative(stats.tokens.cacheWrite),
    totalTokens: nonNegative(stats.tokens.total),
    costUsd: nonNegative(stats.cost),
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
  return cleaned === "" ? "cairn-worker" : cleaned;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function flushObserver(observer: SolverObserverHandle | undefined): Promise<void> {
  if (observer === undefined) return;
  try {
    await observer.flush();
  } catch (error) {
    console.error(`[observer] flush failed; keeping the task result: ${describe(error)}`);
  }
}
