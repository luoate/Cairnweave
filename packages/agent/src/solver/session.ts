import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent"
import type { AgentSession, CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent"
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
        cairnObserver ? cairnObserver.extension : challengeObserverExtension({ observerEnabled, observerModel }),
        // rtkRewriteExtension(),
    ]

    const sessionOpts = await config.resolvePromptSession(init.promptName, extensions, init.model)
    if (!sessionOpts) {
        throw new Error(`prompt not found: ${init.promptName}`)
    }
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
