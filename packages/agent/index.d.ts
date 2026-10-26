/**
 * Public surface of the vendored BreachWeave agent.
 *
 * The runtime entry point is the vendored TypeScript (`src/index.ts`); this declaration
 * file is what `tsc` sees, so the vendored tree is not typechecked with the merged
 * project's stricter settings. Extend it when the solver adapter needs more of the API.
 */

export interface SolverInitPayload {
  solverId: string;
  promptName: string;
  task: string;
  challengeId?: string;
  /** Absolute path of a persisted session JSONL to continue instead of a new session. */
  resumeSessionFile?: string;
}

/** Main-session usage counters; subagent sessions are not included. */
export interface AgentSessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface AgentSession {
  prompt(
    text: string,
    options?: { expandPromptTemplates?: boolean; source?: string },
  ): Promise<unknown>;
  steer(message: string): Promise<unknown>;
  getLastAssistantText(): string;
  /** Must be called before `dispose()`. */
  getSessionStats(): AgentSessionStats;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): unknown;
}

export interface SolverObserverHandle {
  /** Waits for queued Observer reviews; never changes the task result. */
  flush(timeoutMs?: number): Promise<void>;
}

export interface SolverSession {
  session: AgentSession;
  sessionDir: string;
  workspaceDir: string;
  /** Present when the scheduler enabled the opt-in Observer for this task. */
  observer?: SolverObserverHandle;
}

export class ConfigManager {
  static getInstance(configDir?: string): Promise<ConfigManager>;
  readonly dir: string;
}

export function createSolverSession(init: SolverInitPayload): Promise<SolverSession>;

export interface RunSolverOptions {
  promptName: string;
  task: string;
  onEvent?: (event: unknown) => void;
}

export function runSolverCli(options: RunSolverOptions): Promise<void>;

export function initBuiltinPrompts(configDir: string): Promise<void>;
export function initBuiltinSkills(configDir: string): Promise<void>;

export const TCH_AGENT_HOME_DIR: string;
export const DEFAULT_CONFIG_DIR: string;
