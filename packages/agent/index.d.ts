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
  /** Current model, once the session has resolved one. */
  readonly model?: { provider: string; id: string };
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

export interface ProviderPrefEntry {
  id: string;
  hash?: string;
  name: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelConfigEntry {
  id: string;
  hash?: string;
  provider: string;
  providerId?: string;
  modelId: string;
  thinkingLevel?: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export interface AddResult {
  id: string;
  /** Set when the write was refused, for example an identical existing entry. */
  rejected?: string;
}

export interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
}

export interface SkillFileEntry {
  /** POSIX path relative to the skill directory. */
  path: string;
  size: number;
}

export interface SkillFileListing {
  files: SkillFileEntry[];
  truncated: boolean;
}

export interface SkillFileContent extends SkillFileEntry {
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface PromptFileView {
  name: string;
  meta: Record<string, unknown> & { skills?: string[] };
  content: string;
  builtin?: boolean;
  deleted?: boolean;
}

export interface BuiltInProvider {
  provider: string;
  apis: string[];
  baseUrls: string[];
  modelCount: number;
}

export interface DiscoveredModel {
  id: string;
  name: string;
}

export interface TestModelDetails {
  modelPrefId: string;
  provider: string;
  providerId?: string;
  providerLabel: string;
  runtimeProvider: string;
  modelId: string;
  api?: string;
  baseUrl?: string;
  thinkingLevel?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  apiKeySummary?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export class ConfigManager {
  static getInstance(configDir?: string): Promise<ConfigManager>;
  readonly dir: string;
  listProviderPrefs(): Promise<ProviderPrefEntry[]>;
  addProviderPref(entry: Omit<ProviderPrefEntry, "id"> & { id?: string }): Promise<AddResult>;
  updateProviderPref(id: string, patch: Partial<ProviderPrefEntry>): Promise<AddResult | undefined>;
  removeProviderPref(id: string): Promise<void>;
  getProvider(name: string): Promise<Record<string, unknown> | undefined>;
  setProvider(name: string, config: Record<string, unknown>): Promise<void>;
  applyProviderApiKey(id: string, apiKey: string | null): Promise<void>;
  setProviderHeaders(id: string, headers: Record<string, string> | null): Promise<void>;
  getApiKeyValue(provider: string): string | undefined;
  hasApiKey(provider: string): boolean;
  listSupportedProtocols(): string[];
  listBuiltInProviders(): BuiltInProvider[];
  listBuiltInModels(provider: string): Array<{ id: string; name?: string }>;
  discoverModels(providerName: string): Promise<DiscoveredModel[]>;
  listModelPrefs(): Promise<ModelConfigEntry[]>;
  addModelPref(
    entry: Omit<ModelConfigEntry, "id"> & { id?: string },
    options?: { allowDuplicate?: boolean },
  ): Promise<AddResult>;
  updateModelPref(
    id: string,
    patch: Partial<ModelConfigEntry>,
    options?: { allowDuplicate?: boolean },
  ): Promise<AddResult | undefined>;
  removeModelPref(id: string): Promise<void>;
  testModel(prefId: string): Promise<{
    ok: boolean;
    error?: string;
    response?: string;
    details?: TestModelDetails;
  }>;
  /** Tool-less single-turn text completion for offline narrative work (writeups). */
  completeText(options: {
    modelPrefId: string;
    systemPrompt: string;
    prompt: string;
  }): Promise<{ ok: boolean; text?: string; error?: string; model?: string }>;
  listSkills(): SkillEntry[];
  getSkill(name: string): SkillEntry | undefined;
  createSkill(input: CreateSkillInput): Promise<{ name: string; directory: string }>;
  removeSkill(name: string): Promise<void>;
  listDeletedBuiltinSkills(): string[];
  isBuiltinSkill(name: string): boolean;
  restoreBuiltinSkill(name: string): Promise<void>;
  listSkillFiles(name: string): SkillFileListing;
  readSkillFile(name: string, path: string): SkillFileContent;
  getPrompt(name: string): Promise<PromptFileView | undefined>;
  setPrompt(prompt: PromptFileView): Promise<void>;
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
export const CAIRNWEAVE_HOME_DIR: string;
export const DEFAULT_CONFIG_DIR: string;
