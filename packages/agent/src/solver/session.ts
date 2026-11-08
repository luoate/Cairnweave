import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent"
import type { AgentSession, CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { ThinkingLevel } from "@mariozechner/pi-ai"
import { mkdir } from "node:fs/promises"
import { ConfigManager } from "../config/index"
import type { PromptFile } from "../config/prompts/index"
import type { SolverInitPayload } from "./rpc/rpc-types"
import { solverDir, solverSessionDir, solverWorkspaceDir } from "../runtime/types"
import { challengeObserverExtension } from "./extension/challenge-observer/index"
import { isChallengeMode } from "./extension/challenge-observer/ralph-loop"
import { cairnObserverExtension } from "./extension/cairn-observer/index"
import { readCairnObserverOptionsFromEnv } from "./extension/cairn-observer/context"
import type { CairnObserverHandle } from "./extension/cairn-observer/types"
import { pentestCompactionExtension } from "./extension/pentest-compaction"
import { scopeGuardExtension } from "./extension/scope-guard"
import { largeToolResultExtension } from "./extension/large-tool-result"
import { modelTraceExtension } from "./extension/model-trace"
import { bashTimeoutExtension } from "./extension/bash-timeout"
import { rtkRewriteExtension } from "./extension/rtk-rewrite"

export interface SolverSession {
    session: AgentSession
    sessionDir: string
    workspaceDir: string
    /** Present when the scheduler enabled the opt-in observer for this task. */
    observer?: CairnObserverHandle
}

export interface SubagentSession {
    session: AgentSession
    baseDir: string
    sessionDir: string
    workspaceDir: string
}

export type SolverStartupDebugValue = string | number | boolean | null | undefined | SolverStartupDebugValue[] | { [key: string]: SolverStartupDebugValue }

export interface SolverStartupSnapshot {
    createdAt: number
    init: SolverInitPayload
    prompt: PromptFile
    paths: { solverDir: string; sessionDir: string; workspaceDir: string }
    sessionOptions: SolverStartupDebugValue
}

export interface SubagentStartupSnapshot {
    createdAt: number
    init: { promptName: string; task: string; parentToolCallId?: string; step?: number }
    prompt: PromptFile
    paths: { subagentDir: string; sessionDir: string; workspaceDir: string }
    sessionOptions: SolverStartupDebugValue
}

/**
 * OpenAI-compatible providers only receive `reasoning_effort` when the model carries
 * `reasoning: true` and a non-off thinking level, both of which come from the model pref.
 * A per-task decision therefore edits the resolved model: `off` aliases every level to the
 * provider's "none", `on` drops those aliases so the pref's own level reaches the provider.
 * Token-budget providers (Anthropic-style) express "off" by not sending a level at all.
 *
 * A pref that explicitly marks `supportsReasoningEffort: false` means the endpoint rejects the
 * parameter; forcing it on would fail every task on such a gateway, so that opt-out wins and
 * the switch simply cannot silence reasoning there.
 */
const REASONING_OFF_EFFORT: Record<string, string> = {
    minimal: "none",
    low: "none",
    medium: "none",
    high: "none",
    xhigh: "none",
}

export function applyReasoningMode(
    options: CreateAgentSessionOptions,
    mode: "on" | "off",
): CreateAgentSessionOptions {
    const model = options.model
    if (!model) return options
    const thinkingLevel: ThinkingLevel = options.thinkingLevel ?? "minimal"
    if (model.api !== "openai-completions") {
        if (mode === "on") return { ...options, thinkingLevel }
        const { thinkingLevel: _level, ...rest } = options
        return rest
    }
    const compat = { ...((model.compat ?? {}) as Record<string, unknown>) }
    if (compat.supportsReasoningEffort !== false) compat.supportsReasoningEffort = true
    // pi-ai sends the system message as OpenAI's `developer` role whenever the model reasons
    // and compat allows it. Its URL heuristic treats almost every custom gateway as a
    // first-party OpenAI endpoint, and gateways that only know `system` answer 422
    // ("unknown variant `developer`"). Reasoning must not change the message roles, so the
    // role is opt-in per model pref rather than inherited from detection.
    if (compat.supportsDeveloperRole !== true) compat.supportsDeveloperRole = false
    const map = { ...((compat.reasoningEffortMap ?? {}) as Record<string, string>) }
    if (mode === "on") {
        // A pref configured to silence the provider must not drag a reasoning task with it.
        for (const [level, effort] of Object.entries(map)) {
            if (effort === "none") delete map[level]
        }
    } else {
        Object.assign(map, REASONING_OFF_EFFORT)
    }
    compat.reasoningEffortMap = map
    return {
        ...options,
        model: { ...model, reasoning: true, compat: compat as typeof model.compat },
        thinkingLevel,
    }
}

function readInjectedPath(name: string): string | undefined {
    const value = process.env[name]?.trim()
    return value ? value : undefined
}

/** Mirrors `DEFAULT_TOOL_RESULT_SPILL.max_inline_chars` in the Cairn config layer. */
const DEFAULT_TOOL_SPILL_MAX_CHARS = 32000

/**
 * Reads the tool-result spill contract (`tasks.tool_result_spill`) that the scheduler exports as
 * CAIRN_TOOL_SPILL_*. Only the scheduler writes these; an absent pair falls back to the config
 * default (spill on, 32000 chars) so a hand-started worker behaves like a dispatched one.
 */
export function readToolSpillFromEnv(): { enabled: boolean; maxInlineChars: number } {
    const enabled = process.env.CAIRN_TOOL_SPILL_ENABLED?.trim() !== "0"
    const raw = process.env.CAIRN_TOOL_SPILL_MAX_CHARS?.trim()
    const parsed = raw ? Number(raw) : Number.NaN
    const maxInlineChars = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_SPILL_MAX_CHARS
    return { enabled, maxInlineChars }
}

function toolSpillExtensions(workspaceDir: string): ExtensionFactory[] {
    const spill = readToolSpillFromEnv()
    if (!spill.enabled) return []
    return [largeToolResultExtension({ workspaceRoot: workspaceDir, maxInlineChars: spill.maxInlineChars })]
}

/** Mirrors `DEFAULT_MODEL_TRACE` in the Cairn config layer. */
const DEFAULT_MODEL_TRACE_PREVIEW_CHARS = 2000
const DEFAULT_MODEL_TRACE_MAX_BYTES = 8 * 1024 * 1024

/**
 * Reads the model-trace contract (`tasks.model_trace`) that the scheduler exports as
 * CAIRN_MODEL_TRACE_*. A worker started by hand falls back to the defaults, so the trace is
 * available even when nobody wired the scheduler.
 */
export function readModelTraceFromEnv(): { enabled: boolean; previewChars: number; maxBytes: number } {
    const enabled = process.env["CAIRN_MODEL_TRACE_ENABLED"]?.trim() !== "0"
    const preview = Number(process.env["CAIRN_MODEL_TRACE_PREVIEW_CHARS"]?.trim() ?? "")
    const previewChars = Number.isInteger(preview) && preview >= 200 && preview <= 20000
        ? preview
        : DEFAULT_MODEL_TRACE_PREVIEW_CHARS
    const bytes = Number(process.env["CAIRN_MODEL_TRACE_MAX_BYTES"]?.trim() ?? "")
    const maxBytes = Number.isInteger(bytes) && bytes >= 262_144 && bytes <= 64 * 1024 * 1024
        ? bytes
        : DEFAULT_MODEL_TRACE_MAX_BYTES
    return { enabled, previewChars, maxBytes }
}

/**
 * Only the main solver gets a trace: subagents write their own session under the workspace
 * and would double-count the same turn budget. `<sessionDir>/model-trace.jsonl` sits in the
 * project workspace, which the control plane can read in both local and container mode.
 */
function modelTraceExtensions(sessionDir: string): ExtensionFactory[] {
    const trace = readModelTraceFromEnv()
    if (!trace.enabled) return []
    return [modelTraceExtension({ traceDir: sessionDir, ...trace })]
}

/**
 * Loads the host-side scope gate when the worker injected one.
 *
 * The module path is set by the worker role (never by the model) and the module builds its
 * bridge from CAIRN_SCOPE_POLICY. Both solver and subagent sessions call this: subagents
 * are separate processes and otherwise would bypass the solver's in-process gate.
 */
async function loadHostBridgeExtension(): Promise<ExtensionFactory | undefined> {
    const modulePath = readInjectedPath("CAIRN_HOST_BRIDGE_MODULE")
    if (!modulePath) return undefined
    const module = (await import(modulePath)) as {
        createHostBridgeExtensionFromEnv?: () => ExtensionFactory
    }
    const factory = module.createHostBridgeExtensionFromEnv
    if (typeof factory !== "function") {
        throw new Error(`host bridge module ${modulePath} does not export createHostBridgeExtensionFromEnv`)
    }
    return factory()
}

/** Main solver only: one cumulative checkpoint writer per task, never per subagent. */
async function loadTaskCheckpointExtension(): Promise<ExtensionFactory | undefined> {
    if (process.env["CAIRN_TASK_CHECKPOINT"] !== "1") return undefined
    const modulePath = readInjectedPath("CAIRN_CHECKPOINT_MODULE")
    if (!modulePath) return undefined
    try {
        const module = (await import(modulePath)) as {
            createTaskCheckpointExtensionFromEnv?: () => ExtensionFactory
        }
        return module.createTaskCheckpointExtensionFromEnv?.()
    } catch {
        console.warn("[checkpoint] extension unavailable; task continues")
        return undefined
    }
}

export function buildSolverStartupSnapshot(
    init: SolverInitPayload,
    prompt: PromptFile,
    sessionOpts: CreateAgentSessionOptions,
    paths: { solverDir: string; sessionDir: string; workspaceDir: string },
): SolverStartupSnapshot {
    return {
        createdAt: Date.now(),
        init,
        prompt,
        paths,
        sessionOptions: sanitizeForDebug(sessionOpts),
    }
}

export function buildSubagentStartupSnapshot(
    promptName: string,
    task: string,
    parentToolCallId: string | undefined,
    step: number | undefined,
    prompt: PromptFile,
    sessionOpts: CreateAgentSessionOptions,
    paths: { subagentDir: string; sessionDir: string; workspaceDir: string },
): SubagentStartupSnapshot {
    return {
        createdAt: Date.now(),
        init: { promptName, task, parentToolCallId, step },
        prompt,
        paths,
        sessionOptions: sanitizeForDebug(sessionOpts),
    }
}

/**
 * Keys whose values are credentials, not diagnostic state. The startup snapshot is
 * written inside the project workspace, so a provider key copied there would be exposed
 * to the solver and to anything that reads its session directory.
 */
const SENSITIVE_DEBUG_KEY =
    /^(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|authorization|credential|credentials)$/i

function sanitizeForDebug(value: unknown, depth = 0): SolverStartupDebugValue {
    if (value == null) return value
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
    if (depth >= 4) return `[${value.constructor?.name || "Object"}]`

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForDebug(item, depth + 1))
    }

    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
        if (entries.length === 0) return `[${value.constructor?.name || "Object"}]`

        return Object.fromEntries(
            entries.map(([key, item]) => [
                key,
                SENSITIVE_DEBUG_KEY.test(key) ? "[REDACTED]" : sanitizeForDebug(item, depth + 1),
            ]),
        )
    }

    return String(value)
}

/**
 * Create an AgentSession configured for a solver.
 * Resolves prompt config, prepares directories, returns the session.
 * Caller is responsible for sending prompts and disposing.
 */
export async function createSolverSession(init: SolverInitPayload): Promise<SolverSession> {
    const config = await ConfigManager.getInstance(readInjectedPath("CAIRN_AGENT_CONFIG_DIR"))

    const workspaceDir = readInjectedPath("TCH_SOLVER_WORKSPACE") ?? solverWorkspaceDir(init.solverId)
    const sessionDir = readInjectedPath("TCH_SOLVER_SESSION_DIR") ?? solverSessionDir(init.solverId)
    const baseDir = readInjectedPath("TCH_SOLVER_BASE_DIR") ?? solverDir(init.solverId)
    const startupPath = readInjectedPath("TCH_SOLVER_STARTUP_PATH") ?? `${baseDir}/startup.json`
    await mkdir(baseDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const prompt = await config.getPrompt(init.promptName)
    if (!prompt) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
    if (prompt.meta.isSubagent) {
        throw new Error(`subagent prompt cannot be started as solver: ${init.promptName}`)
    }

    const observerEnabled = prompt.meta.observerEnabled === true
    const promptModel = typeof prompt.meta.model === "string" && prompt.meta.model.trim() ? prompt.meta.model.trim() : undefined
    const observerModel = typeof prompt.meta.observerModel === "string" && prompt.meta.observerModel.trim() ? prompt.meta.observerModel.trim() : promptModel

    // The Cairn observer is scheduler-driven and mutually exclusive with challenge mode.
    // In challenge mode the vendored continuation/observer behavior stays byte-identical.
    const cairnObserverOptions = isChallengeMode() ? undefined : readCairnObserverOptionsFromEnv()
    const cairnObserver = cairnObserverOptions
        ? cairnObserverExtension({
              ...cairnObserverOptions,
              ...((cairnObserverOptions.model ?? observerModel)
                  ? { model: cairnObserverOptions.model ?? observerModel }
                  : {}),
          })
        : undefined

    const hostBridge = await loadHostBridgeExtension()
    const checkpoint = await loadTaskCheckpointExtension()
    const extensions = [
        // The gate must run before any other extension can touch the tool call.
        ...(hostBridge ? [hostBridge] : []),
        ...(checkpoint ? [checkpoint] : []),
        // Registered after the gate so scope auditing still sees the full result, and before the
        // observers so the context carries a pointer instead of a dump.
        ...toolSpillExtensions(workspaceDir),
        // Pure observation: it appends to the session directory and never alters a message.
        ...modelTraceExtensions(sessionDir),
        // M58b: bounds every bash command. It has to be an extension: the SDK rebuilds its
        // tools from its own map, so a wrapped tool object would be discarded.
        bashTimeoutExtension(),
        cairnObserver ? cairnObserver.extension : challengeObserverExtension({ observerEnabled, observerModel }),
        // rtkRewriteExtension(),
    ]

    const resolvedSessionOpts = await config.resolvePromptSession(init.promptName, extensions, init.model)
    if (!resolvedSessionOpts) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
    // M57c: a task-level allowlist narrows the prompt's own tool list. It is applied
    // before the reasoning edit so the two changes compose without renaming tools.
    const narrowedSessionOpts = narrowSessionTools(resolvedSessionOpts, init.tools)
    const sessionOpts = init.reasoning === undefined
        ? narrowedSessionOpts
        : applyReasoningMode(narrowedSessionOpts, init.reasoning)
    const startupSnapshot = buildSolverStartupSnapshot(init, prompt, sessionOpts, {
        solverDir: baseDir,
        sessionDir,
        workspaceDir,
    })
    await Bun.write(startupPath, JSON.stringify(startupSnapshot, null, 2))

    const sessionManager = init.resumeSessionFile
        ? SessionManager.open(init.resumeSessionFile, sessionDir, workspaceDir)
        : SessionManager.create(workspaceDir, sessionDir)

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        sessionManager,
    })
    await session.bindExtensions({})

    return {
        session,
        sessionDir,
        workspaceDir,
        ...(cairnObserver ? { observer: cairnObserver.handle } : {}),
    }
}

/**
 * Keeps only the named tools, never adding one the prompt did not offer. Built-in tools
 * are filtered by `name`; custom tools and MCP-provided tools have no per-task filter, so
 * any allowlist that omits all custom tools also drops them.
 */
export function narrowSessionTools(
    options: CreateAgentSessionOptions,
    allowed: readonly string[] | undefined,
): CreateAgentSessionOptions {
    if (allowed === undefined) return options
    const keep = new Set(allowed)
    const tools = (options.tools ?? []).filter((tool) => keep.has((tool as { name?: unknown }).name as string))
    const customTools = (options.customTools ?? []).filter(
        (tool) => keep.has((tool as { name?: unknown }).name as string),
    )
    return {
        ...options,
        tools,
        ...(customTools.length === 0 ? { customTools: undefined } : { customTools }),
    }
}

export async function createSubagentSession(promptName: string, task: string): Promise<SubagentSession> {
    const solverWorkspace = process.env.TCH_SOLVER_WORKSPACE?.trim()
    if (!solverWorkspace) {
        throw new Error("TCH_SOLVER_WORKSPACE is required for subagent sessions")
    }

    const config = await ConfigManager.getInstance(readInjectedPath("CAIRN_AGENT_CONFIG_DIR"))
    const prompt = await config.getPrompt(promptName)
    if (!prompt) {
        throw new Error(`prompt not found: ${promptName}`)
    }
    if (prompt.meta.isSubagent !== true) {
        throw new Error(`prompt is not a subagent: ${promptName}`)
    }

    const baseDir = process.cwd()
    const sessionDir = `${baseDir}/session`
    const workspaceDir = solverWorkspace
    const parentToolCallId = process.env.TCH_SUBAGENT_PARENT_TOOL_CALL_ID?.trim() || undefined
    const stepValue = process.env.TCH_SUBAGENT_STEP?.trim()
    const step = stepValue && Number.isFinite(Number(stepValue)) ? Number(stepValue) : undefined
    await mkdir(baseDir, { recursive: true })
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })

    const hostBridge = await loadHostBridgeExtension()
    const extensionFactories: ExtensionFactory[] = [
        ...(hostBridge ? [hostBridge] : []),
        // Subagents inherit CAIRN_TOOL_SPILL_* through process.env and share the solver workspace,
        // so their spills land in the same scan root as the parent's.
        ...toolSpillExtensions(workspaceDir),
        // M58b: a subagent's bash commands are bounded by the same task deadlines.
        bashTimeoutExtension(),
        // rtkRewriteExtension(),
        // pentestCompactionExtension(),
        // scopeGuardExtension({ workspaceRoot: workspaceDir, agentRole: "subagent" }),
    ]

    const sessionOpts = await config.resolvePromptSession(promptName, extensionFactories)
    if (!sessionOpts) {
        throw new Error(`prompt not found: ${promptName}`)
    }

    const startupSnapshot = buildSubagentStartupSnapshot(promptName, task, parentToolCallId, step, prompt, sessionOpts, {
        subagentDir: baseDir,
        sessionDir,
        workspaceDir,
    })
    await Bun.write(`${baseDir}/startup.json`, JSON.stringify(startupSnapshot, null, 2))

    const { session } = await createAgentSession({
        ...sessionOpts,
        cwd: workspaceDir,
        sessionManager: SessionManager.create(workspaceDir, sessionDir),
    })
    await session.bindExtensions({})

    return { session, baseDir, sessionDir, workspaceDir }
}
