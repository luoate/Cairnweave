import type { ChallengeManager } from "./manager"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import type { HostBridgeHandleContext, HostBridgeHandleResult, HostBridgeHandler, SolverInstance } from "../runtime/types"

function getObjectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return value as Record<string, unknown>
}

function getRequiredString(data: Record<string, unknown>, key: string): string {
    const value = data[key]
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${key} is required`)
    }
    return value.trim()
}

function getRequiredChallengeId(getSolverEnvValue: (key: string) => string | undefined): string {
    const challengeId = getSolverEnvValue(CHALLENGE_ENV_CHALLENGE_ID)
    if (!challengeId) {
        throw new Error(`${CHALLENGE_ENV_CHALLENGE_ID} is required for challenge actions`)
    }
    return challengeId
}

function getSolverPromptName(solver?: SolverInstance): string | undefined {
    return solver?.promptName?.trim() || undefined
}

function getSolverModelName(startup: unknown): string | undefined {
    if (!startup || typeof startup !== "object" || !("sessionOptions" in startup)) return
    const sessionOptions = (startup as { sessionOptions?: unknown }).sessionOptions
    if (!sessionOptions || typeof sessionOptions !== "object" || !("model" in sessionOptions)) return
    const model = (sessionOptions as { model?: unknown }).model
    if (!model || typeof model !== "object") return
    const provider = (model as { provider?: unknown }).provider
    const id = (model as { id?: unknown }).id
    const providerText = typeof provider === "string" ? provider.trim() : ""
    const idText = typeof id === "string" ? id.trim() : ""
    const text = [providerText, idText].filter(Boolean).join("/")
    return text || undefined
}

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function sendFollowUpToSolver(context: HostBridgeHandleContext, solverId: string, message: string): void {
    const text = message.trim()
    if (!text) return
    context.sendCommand?.(solverId, {
        type: "follow_up",
        message: text,
    })
}

function sendSteerToSolver(context: HostBridgeHandleContext, solverId: string, message: string): void {
    const text = message.trim()
    if (!text) return
    context.sendCommand?.(solverId, {
        type: "steer",
        message: text,
    })
}

function sendHintToSolver(context: HostBridgeHandleContext, solverId: string, hintContent: string): void {
    const message = hintContent.trim()
    if (!message) return
    sendSteerToSolver(context, solverId, `系统同步：赛题 hint 已更新。\n- 立即吸收这条 hint，并结合当前路线评估是否需要转向。\n- 如果它改变了攻击面理解，优先刷新 memory_list / idea_list。\n- hint:\n${message}`)
}

function broadcastHintToChallengeSolvers(context: HostBridgeHandleContext, challengeId: string, hintContent: string): void {
    const targetChallengeId = challengeId.trim()
    const message = hintContent.trim()
    if (!targetChallengeId || !message) return
    for (const solver of context.listSolvers?.() ?? []) {
        if (solver.challengeId !== targetChallengeId) continue
        if (solver.status !== "running") continue
        try {
            sendHintToSolver(context, solver.id, message)
        } catch {
            // ignore inactive solver pipes
        }
    }
}

function broadcastToChallengeSolvers(
    context: HostBridgeHandleContext,
    challengeId: string,
    message: string,
    options?: { excludeSolverId?: string; delivery?: "follow_up" | "steer" },
): void {
    const targetChallengeId = challengeId.trim()
    const text = message.trim()
    if (!targetChallengeId || !text) return
    for (const solver of context.listSolvers?.() ?? []) {
        if (solver.challengeId !== targetChallengeId) continue
        if (solver.status !== "running") continue
        if (options?.excludeSolverId && solver.id === options.excludeSolverId) continue
        try {
            if (options?.delivery === "steer") {
                sendSteerToSolver(context, solver.id, text)
            } else {
                sendFollowUpToSolver(context, solver.id, text)
            }
        } catch {
            // ignore inactive solver pipes
        }
    }
}

function pickIdeaSummary(items: Array<{ id: string; status: string; content: string; result: string }>): string[] {
    const weighted = [...items].sort((left, right) => {
        const score = (status: string) => {
            switch (status) {
                case "verified":
                    return 4
                case "testing":
                    return 3
                case "failed":
                    return 2
                case "pending":
                    return 1
                case "skipped":
                    return 0
                default:
                    return -1
            }
        }
        return score(right.status) - score(left.status)
    })
    return weighted.slice(0, 6).map((item) => `- [${item.status}] ${clipText(item.content, 120)}${item.result.trim() ? ` -> ${clipText(item.result, 140)}` : ""}`)
}

function pickMemorySummary(items: Array<{ kind: string; content: string }>): string[] {
    return items.slice(-6).map((item) => `- [${item.kind}] ${clipText(item.content, 140)}`)
}

function formatFlagSolvedBroadcastMessage(input: {
    flag: string
    gotCount?: number
    flagCount?: number
    isCompleted: boolean
    writeup?: string
    ideas: Array<{ id: string; status: string; content: string; result: string }>
    memory: Array<{ kind: string; content: string }>
}): string {
    const progress =
        typeof input.gotCount === "number" && typeof input.flagCount === "number"
            ? `${input.gotCount}/${input.flagCount}`
            : "-"
    const remaining =
        typeof input.gotCount === "number" && typeof input.flagCount === "number"
            ? Math.max(input.flagCount - input.gotCount, 0)
            : undefined
    const ideaLines = pickIdeaSummary(input.ideas)
    const memoryLines = pickMemorySummary(input.memory)

    return [
        "协作同步：同题已有 solver 提交正确 flag。",
        `- flag: ${input.flag}`,
        `- 进度: ${progress}`,
        typeof remaining === "number" ? `- 剩余 flag: ${remaining}` : undefined,
        input.isCompleted ? "- 题目已完成，不要继续重复当前路线。" : "- 这条路线已经拿到一个 flag，不要重复挖同一支，转向剩余 flag。",
        input.writeup?.trim() ? "- 本次 flag 路线摘要：" : undefined,
        input.writeup?.trim() ? `- ${clipText(input.writeup, 300)}` : undefined,
        ideaLines.length > 0 ? "- 当前思路板摘要：" : undefined,
        ...(ideaLines.length > 0 ? ideaLines : []),
        memoryLines.length > 0 ? "- 当前记忆摘要：" : undefined,
        ...(memoryLines.length > 0 ? memoryLines : []),
        ideaLines.length === 0 && memoryLines.length === 0 ? "- 当前还没有足够的结构化思路摘要，请先查看 memory_list / idea_list。" : undefined,
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

async function handleChallengeAction(
    challengeManager: ChallengeManager,
    context: HostBridgeHandleContext,
): Promise<HostBridgeHandleResult> {
    const { solverId, action, params, getSolverEnvValue, getSolver, getSolverStartup } = context
    const data = getObjectValue(params)

    switch (action) {
        case "challenge_get_state": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const challenge = await challengeManager.getChallenge(challengeId)
            const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
            return { handled: true, data: { challenge_id: challengeId, challenge, is_completed: isCompleted } }
        }
        case "challenge_get_hint": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const challenge = await challengeManager.getChallenge(challengeId)
            const cachedHint = challenge?.hint_content?.trim()
            if (cachedHint) {
                return {
                    handled: true,
                    data: {
                        code: challengeId,
                        hint_content: cachedHint,
                    },
                }
            }
            const result = await challengeManager.getHint(challengeId)
            if (result.remote.hint_content?.trim()) {
                broadcastHintToChallengeSolvers(context, challengeId, result.remote.hint_content)
            }
            return { handled: true, data: result.remote }
        }
        case "challenge_submit_flag": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const flag = getRequiredString(data, "flag")
            const writeup = typeof data.writeup === "string" && data.writeup.trim() ? data.writeup.trim() : undefined
            const result = await challengeManager.submitFlag(challengeId, flag, {
                solverId,
                promptName: getSolverPromptName(getSolver?.()),
                modelName: getSolverModelName((await getSolverStartup?.()) ?? undefined),
                writeup,
            })
            if (result.remote.correct) {
                const [memory, ideas] = await Promise.all([challengeManager.listMemory(challengeId), challengeManager.listIdeas(challengeId)])
                broadcastToChallengeSolvers(
                    context,
                    challengeId,
                    formatFlagSolvedBroadcastMessage({
                        flag,
                        gotCount: result.remote.flag_got_count,
                        flagCount: result.remote.flag_count,
                        isCompleted: result.is_completed,
                        writeup,
                        ideas,
                        memory,
                    }),
                    { excludeSolverId: solverId, delivery: "steer" },
                )
            }
            return { handled: true, data: { challenge_id: challengeId, ...result } }
        }
        case "challenge_is_completed": {
            const challengeId = getRequiredChallengeId(getSolverEnvValue)
            const isCompleted = await challengeManager.isChallengeCompleted(challengeId)
            return { handled: true, data: { challenge_id: challengeId, is_completed: isCompleted } }
        }
        default:
            return { handled: false }
    }
}

export function createChallengeHostBridgeHandler(challengeManager: ChallengeManager): HostBridgeHandler {
    return {
        async handle(context) {
            return handleChallengeAction(challengeManager, context)
        },
    }
}
