import { DefaultResourceLoader, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent"
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent"
import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_CONFIG_DIR, ConfigManager } from "../../../config/index"
import { OBSERVER_SYSTEM_PROMPT } from "../challenge-observer/observer-agent"
import { createObserverSidecarToolsWithOptions } from "../challenge-observer/tools"
import { buildCairnObserverPrompt } from "./context"
import type { CairnObserverOptions, CairnReviewPayload } from "./types"

/**
 * Cairn adaptation of the vendored Observer prompt. The board-maintenance rules are
 * unchanged; challenge-specific concepts (hints, flags, challenge state) do not exist in
 * the merged runtime and the steer tool is intentionally not registered.
 */
const CAIRN_OBSERVER_ADAPTER_PROMPT = `## Cairn Runtime Adaptation

你现在运行在 Cairn 合并版中，而不是 BreachWeave challenge 模式：

- 没有 challenge state、difficulty、flag、hint 或 instance 字段；不要等待这些信息。
- 你会收到 project / focus intent / authorized scope / recent facts / open intents 与最近轮次。
- 你不能执行 shell、文件、网络或验证工具，也不能提交 flag；你只维护 ideas 和 memory 看板。
- \`send_efficiency_reminder\` 在这个运行模式下不存在；不要尝试调用它。
- 看板可能被同一项目的其他任务读取；只写 durable、可复用、能跨任务成立的结论。
- 不记录 flag、凭据、完整工具输出、临时路径或与任务无关的题面复述。`

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return ""
    return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim()
}

function resolveObserverConfigDir(): string {
    return process.env.CAIRN_AGENT_CONFIG_DIR?.trim() || DEFAULT_CONFIG_DIR
}

function resolveObserverWorkspaceDir(): string {
    return process.env.TCH_SOLVER_WORKSPACE?.trim() || process.cwd()
}

async function loadSolverEntries(): Promise<unknown[]> {
    const solverSessionDir = process.env.TCH_SOLVER_SESSION_DIR?.trim()
    if (!solverSessionDir) return []

    try {
        const files = (await readdir(solverSessionDir)).filter((name) => name.endsWith(".jsonl")).sort()
        const entries: unknown[] = []
        for (const name of files) {
            const text = await Bun.file(join(solverSessionDir, name)).text().catch(() => "")
            for (const rawLine of text.split("\n")) {
                const line = rawLine.trim()
                if (!line) continue
                try {
                    entries.push(JSON.parse(line))
                } catch {
                    // ignore malformed lines
                }
            }
        }
        return entries
    } catch {
        return []
    }
}

async function resolveSessionOptions(
    config: ConfigManager,
    observerModel: string | undefined,
): Promise<CreateAgentSessionOptions> {
    const resourceLoader = new DefaultResourceLoader({
        agentDir: config.dir,
        systemPromptOverride: () => `${OBSERVER_SYSTEM_PROMPT}\n\n${CAIRN_OBSERVER_ADAPTER_PROMPT}`,
    })
    await resourceLoader.reload()

    const solverEntries = await loadSolverEntries()
    const options: CreateAgentSessionOptions = {
        tools: [],
        customTools: createObserverSidecarToolsWithOptions({
            getSolverEntries: () => solverEntries,
            enableSteer: false,
        }),
        resourceLoader,
        authStorage: config.auth,
        modelRegistry: config.models,
        settingsManager: config.settings,
    }

    if (observerModel) {
        const resolved = await config.resolveModelPref(observerModel)
        options.model = resolved.model
        options.thinkingLevel = resolved.thinkingLevel
    }
    return options
}

export interface CairnReviewResult {
    applied: boolean
    summary?: string
}

/**
 * Runs one sidecar review. Any error propagates to the loop, which audits it and keeps
 * the task result unchanged. The session is always disposed, including on timeout.
 */
export async function runCairnObserverReview(
    observerOptions: CairnObserverOptions,
    payload: CairnReviewPayload,
    contextText: string,
): Promise<CairnReviewResult> {
    if (payload.rounds.length === 0) return { applied: false }

    const config = await ConfigManager.getInstance(resolveObserverConfigDir())
    const sessionOptions = await resolveSessionOptions(config, observerOptions.model)
    const sidecarSessionDir = join(observerOptions.stateDir, "sidecar")
    await mkdir(sidecarSessionDir, { recursive: true })

    const workspaceDir = resolveObserverWorkspaceDir()
    const { session } = await createAgentSession({
        ...sessionOptions,
        cwd: workspaceDir,
        sessionManager: SessionManager.create(workspaceDir, sidecarSessionDir),
    })

    let summary = ""
    session.subscribe((event) => {
        if (event.type === "message_end" && event.message?.role === "assistant") {
            summary = extractTextContent(
                event.message.content as Array<{ type: string; text?: string }> | undefined,
            )
        }
    })

    let disposed = false
    const dispose = () => {
        if (disposed) return
        disposed = true
        try {
            session.dispose()
        } catch {
            // The session may already be closed after a timeout.
        }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            dispose()
            reject(new Error(`observer review timed out after ${observerOptions.timeoutSeconds}s`))
        }, observerOptions.timeoutSeconds * 1000)
    })

    try {
        await Promise.race([
            session.prompt(buildCairnObserverPrompt(contextText, payload)),
            timeoutPromise,
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
        dispose()
    }

    const trimmed = summary.trim()
    // "NO_CHANGE" means the sidecar inspected the board and deliberately left it alone.
    const applied = trimmed.length > 0 && trimmed.toUpperCase() !== "NO_CHANGE"
    return { applied, summary: trimmed || undefined }
}
