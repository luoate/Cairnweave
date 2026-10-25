import { ChallengeApiClient } from "./api-client"
import type { ChallengeApiChallenge, ChallengeApiHintData, ChallengeApiListData, ChallengeApiStartData, ChallengeApiSubmitData } from "./api-client"
import { createAgentSession, defineTool, SessionManager } from "@mariozechner/pi-coding-agent"
import type { ResourceLoader, ToolDefinition } from "@mariozechner/pi-coding-agent"
import type { ConfigManager } from "../config/index"
import { join } from "path"
import { CHALLENGE_ENV_CHALLENGE_ID } from "./env"
import {
    appendChallengeAttemptLog,
    appendChallengeSubmissionLog,
    listChallengeAttemptLogs,
    listChallengeSubmissionLogs,
    type ChallengeInfoRecord,
    type ChallengeRecord,
    type ChallengeAttemptLogRecord,
    type ChallengeSubmissionLogRecord,
    computeChallengeCompleted,
    ensureChallengeStoreBaseDir,
    listChallengeRecords,
    readChallengeRecord,
    resolveChallengeDir,
    saveChallengeRecord,
} from "./store"
import type { ChallengeStatsOverviewBucket, ChallengeStatsRecord, SolverStatsRecord } from "./stats"
import { buildChallengeStatsOverview, refreshChallengeStats } from "./stats"
import {
    type AddIdeaResult,
    type AddIdeaInput,
    type AddMemoryInput,
    type IdeaRecord,
    type IdeaStatus,
    type MemoryKind,
    type MemoryEntry,
    type UpdateIdeaInput,
    addChallengeIdea,
    appendChallengeMemory,
    deleteChallengeIdea,
    deleteChallengeMemory,
    listChallengeIdeas,
    listChallengeMemory,
    searchChallengeIdeas,
    updateChallengeMemory,
    updateChallengeIdea,
} from "./memory"
import type { RuntimeManager } from "../runtime/runtime"
import type { SolverInstance } from "../runtime/types"
import { solverSessionDir } from "../runtime/types"
import { seedSolverBoardSnapshot } from "../solver/board-store"
import { Type } from "@sinclair/typebox"
import { CHALLENGE_PLANNER_PROMPT_NAME } from "../config/prompts/index"

export type { IdeaStatus, MemoryKind, MemoryEntry, AddMemoryInput, IdeaRecord, AddIdeaInput, AddIdeaResult, UpdateIdeaInput } from "./memory"

const DEFAULT_PLANNER_PROMPT_NAME = CHALLENGE_PLANNER_PROMPT_NAME
const DEFAULT_TICK_INTERVAL_MS = 30_000
const DEFAULT_STALE_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_MAX_SOLVERS = 7
const MAX_ACTIVE_CHALLENGES = 3
const LIST_CHALLENGES_SYNC_COOLDOWN_MS = 10_000
const NOISY_ERROR_THROTTLE_WINDOW_MS = 60_000
const NOISY_ERROR_SIGNATURE_LIMIT = 200
const SOLVER_MEMORY_LIMIT = 10
const SOLVER_IDEA_LIMIT = 8
const SOLVER_HANDOFF_MAX_CHARS = 900
const SOLVER_MEMORY_CONTENT_MAX_CHARS = 220
const SOLVER_IDEA_CONTENT_MAX_CHARS = 120
const SOLVER_RESULT_MAX_CHARS = 180
const CHALLENGE_STATE_PLACEHOLDER = "{{CHALLENGE_STATE}}"
const AVAILABLE_SOLVER_PROMPTS_PLACEHOLDER = "{{AVAILABLE_SOLVER_PROMPTS}}"
const USER_STRATEGY_PLACEHOLDER = "{{USER_STRATEGY}}"
const PREVIOUS_PLANNER_ROUND_PLACEHOLDER = "{{PREVIOUS_PLANNER_ROUND}}"

export interface ChallengeListResult {
    remote: ChallengeApiListData
    local: ChallengeInfoRecord[]
    summary: {
        remote: number
        local: number
        solved: number
        total: number
        mockMode: boolean
        realApiMode: boolean
    }
}

export interface ChallengeActionResult<T> {
    remote: T
    challenge?: ChallengeInfoRecord
    is_completed: boolean
}

export interface ChallengeSubmissionMeta {
    solverId?: string
    promptName?: string
    modelName?: string
    writeup?: string
}

interface LaunchSolverOptions {
    plannerHandoff?: string
}

function extractErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) {
        const message = error.message.trim()
        return message || error.name
    }
    if (error === undefined) return
    return String(error)
}

function isNoisyChallengeApiError(errorMessage: string | undefined): boolean {
    if (!errorMessage) return false
    const text = errorMessage.toLowerCase()
    return (
        text.includes("challenge api get /challenges") ||
        text.includes("unable to connect") ||
        text.includes("typo in the url or port") ||
        text.includes("timeout after")
    )
}

interface PlannerSnapshotChallenge {
    id: string
    title: string
    difficulty: string
    level: number
    totalScore: number
    gotScore: number
    flagCount: number
    gotFlags: number
    remainingFlags: number
    remainingScore: number
    hintViewed: boolean
    instanceStatus: string
    entrypoint: string[] | null
    attemptCount: number
    submissionCount: number
    correctSubmissionCount: number
    untouched: boolean
    stale: boolean
    activeSolverCount: number
    activeSolverIds: string[]
    activeForMinutes?: number
    minutesSinceLastAttempt?: number
    minutesSinceLastCorrectSubmission?: number
}

interface PlannerSnapshot {
    generatedAt: string
    constraints: {
        maxActiveChallenges: number
        maxSolvers: number
        activeChallenges: number
        activeSolvers: number
        staleTimeoutMs: number
    }
    activeSolvers: Array<{
        id: string
        challengeId?: string
        promptName: string
        status: string
        activeForMinutes: number
        timeoutStatus: "normal" | "stale"
    }>
    availableSolverPrompts: Array<{
        name: string
        description?: string
        modelPrefId?: string
        modelLabel?: string
        promptPerformance?: ChallengeStatsOverviewBucket
    }>
    challenges: PlannerSnapshotChallenge[]
}

interface PreviousPlannerRoundRecord {
    generated_at: string
    snapshot_digest: string
    actions: string[]
    summary: string
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function clampInt(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)))
}

function resolvePlannerTickIntervalMs(value?: number): number {
    return clampInt(value ?? DEFAULT_TICK_INTERVAL_MS, 5_000, 10 * 60 * 1000)
}

function parseTimestamp(value?: string): number | undefined {
    if (!value) return
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
}

function formatMinutesFromTimestamp(value?: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return
    const diffMs = Date.now() - value
    if (!Number.isFinite(diffMs) || diffMs < 0) return 0
    return Math.floor(diffMs / 60000)
}

function isActiveSolver(solver: SolverInstance): boolean {
    return solver.status === "starting" || solver.status === "running"
}

function escapeMarkdownTableCell(value: string): string {
    return value.replaceAll("|", "\\|").replaceAll("\n", "<br>")
}

function formatMarkdownTable(headers: string[], rows: string[][]): string {
    const header = `| ${headers.join(" | ")} |`
    const separator = `| ${headers.map(() => "---").join(" | ")} |`
    const body = rows.map((row) => `| ${row.map((cell) => escapeMarkdownTableCell(cell)).join(" | ")} |`)
    return [header, separator, ...body].join("\n")
}

function clipTaskText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function summarizeBroadcastRefs(refs: string[]): string | undefined {
    const items = refs
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .slice(0, 3)
        .map((item) => clipTaskText(item, 80))
    if (items.length === 0) return
    return items.join(" | ")
}

function formatChallengeMemoryBroadcastMessage(action: "added" | "updated" | "deleted", entry: MemoryEntry): string {
    const actionText = action === "added" ? "新增" : action === "updated" ? "更新" : "删除"
    const refsSummary = summarizeBroadcastRefs(entry.refs)

    return [
        `协作同步：Challenge Memory 已${actionText}。`,
        `- kind: ${entry.kind}`,
        `- source: ${clipTaskText(entry.source, 120)}`,
        `- content: ${clipTaskText(entry.content, 220)}`,
        refsSummary ? `- refs: ${refsSummary}` : undefined,
        action === "deleted" ? "- 这条 challenge memory 已被移除，不要继续把它当成当前背景事实。" : "- 这是 challenge 级背景更新；如它影响当前路线，再自行吸收并调整。",
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

function formatChallengeIdeaBroadcastMessage(action: "added" | "updated" | "deleted", idea: IdeaRecord): string {
    const actionText = action === "added" ? "新增" : action === "updated" ? "更新" : "删除"

    return [
        `协作同步：Challenge Idea 已${actionText}。`,
        `- status: ${idea.status}`,
        `- content: ${clipTaskText(idea.content, 200)}`,
        idea.result.trim() ? `- result: ${clipTaskText(idea.result, 180)}` : undefined,
        action === "deleted" ? "- 这条 challenge idea 已被移除，不要继续把它当成当前推荐路线。" : "- 这是 challenge 级背景更新；把它当作参考假设，不要直接当作结论。",
    ]
        .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
        .join("\n")
}

function sortByUpdatedAtDesc<T extends { updated_at?: string }>(items: T[]): T[] {
    return items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
            const timestampDiff = (parseTimestamp(right.item.updated_at) ?? 0) - (parseTimestamp(left.item.updated_at) ?? 0)
            if (timestampDiff !== 0) return timestampDiff
            return right.index - left.index
        })
        .map((entry) => entry.item)
}

function selectRecentItems<T extends { updated_at?: string }>(items: T[], limit: number): T[] {
    return sortByUpdatedAtDesc(items).slice(0, limit)
}

function formatSolverMemorySection(items: MemoryEntry[]): string {
    if (items.length === 0) return "无"
    const selected = selectRecentItems(items, SOLVER_MEMORY_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Kind", "Content", "Refs", "Source", "Updated"],
        selected.map((item) => [
            item.id,
            item.kind,
            clipTaskText(item.content, SOLVER_MEMORY_CONTENT_MAX_CHARS),
            item.refs.length > 0 ? clipTaskText(item.refs.join(", "), SOLVER_IDEA_CONTENT_MAX_CHARS) : "-",
            item.source,
            item.updated_at,
        ]),
    )
    if (selected.length === items.length) return table
    return `${table}\n\n注: 初始上下文仅展示最近 ${selected.length}/${items.length} 条 memory；需要全量记录时再调用 memory_list。`
}

function formatSolverIdeasSection(items: IdeaRecord[]): string {
    if (items.length === 0) return "无"
    const selected = selectRecentItems(items, SOLVER_IDEA_LIMIT)
    const table = formatMarkdownTable(
        ["ID", "Status", "Idea", "Result", "Updated"],
        selected.map((item) => [
            item.id,
            item.status,
            clipTaskText(item.content, SOLVER_IDEA_CONTENT_MAX_CHARS),
            item.result ? clipTaskText(item.result, SOLVER_RESULT_MAX_CHARS) : "-",
            item.updated_at,
        ]),
    )
    if (selected.length === items.length) return table
    return `${table}\n\n注: 初始上下文仅展示最近 ${selected.length}/${items.length} 条 idea；需要全量策略板时再调用 idea_list 或 idea_search。`
}

function formatSolverSubmissionsSection(items: ChallengeSubmissionLogRecord[]): string {
    const solvedItems = items.filter((item) => item.correct)
    if (solvedItems.length === 0) return "无"
    const sorted = [...solvedItems].sort((a, b) => (parseTimestamp(b.created_at) ?? 0) - (parseTimestamp(a.created_at) ?? 0))
    return formatMarkdownTable(
        ["Flag", "Writeup"],
        sorted.map((item) => [item.flag, item.writeup || "-"]),
    )
}

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
    if (!content) return ""
    return content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("")
        .trim()
}

function writePlannerTextChunk(chunk: string): void {
    const text = chunk.replace(/\r/g, "")
    if (!text) return
    process.stdout.write(text)
}

const CHALLENGE_LOG_SCOPE_ICONS: Record<string, string> = {
    planner: "🧠",
    "planner-tool": "🧠🛠",
    solver: "🤖",
    "sync-loop": "🔄",
    start: "🚀",
    stop: "🛑",
    submit: "🏁",
    hint: "💡",
    finish: "✅",
}

function formatChallengeLogScope(scope: string): string {
    const parts = scope.split(":").filter(Boolean)
    if (parts.length === 0) return "🎯"
    if (parts[0] === "challenge") parts.shift()
    if (parts.length === 0) return "🎯"
    return CHALLENGE_LOG_SCOPE_ICONS[parts.join(":")] ?? CHALLENGE_LOG_SCOPE_ICONS[parts[0]] ?? "🎯"
}

function formatPromptPerformance(bucket?: ChallengeStatsOverviewBucket): string {
    if (!bucket) return "-"
    return `${bucket.solved_count}/${bucket.total_flag_count}`
}

function formatAvailableSolverPromptsMarkdown(snapshot: PlannerSnapshot): string {
    const availablePromptRows = snapshot.availableSolverPrompts.map((prompt) => [
        prompt.name,
        prompt.modelLabel ?? "-",
        formatPromptPerformance(prompt.promptPerformance),
        prompt.description?.replaceAll("\n", " ") || "-",
    ])

    const table = availablePromptRows.length > 0 ? formatMarkdownTable(["Prompt", "Configured Model", "Prompt Flags", "Description"], availablePromptRows) : "No solver prompts available."

    const details = snapshot.availableSolverPrompts.flatMap((prompt) => [
        `### ${prompt.name}`,
        `- Description: ${prompt.description?.trim() || "-"}`,
        `- Configured model: ${prompt.modelLabel ?? "-"}`,
        `- Model pref id: ${prompt.modelPrefId ?? "-"}`,
        `- Prompt performance: ${formatPromptPerformance(prompt.promptPerformance)}`,
        "",
    ])

    return [table, "", "## Solver Prompt Details", ...details].join("\n")
}

function formatPlannerSnapshotMarkdown(snapshot: PlannerSnapshot): string {
    const challengeRows = snapshot.challenges.map((challenge) => [
        challenge.id,
        challenge.title.replaceAll("\n", " "),
        challenge.difficulty,
        String(challenge.level),
        `${challenge.gotScore}/${challenge.totalScore}`,
        `${challenge.gotFlags}/${challenge.flagCount}`,
        challenge.instanceStatus,
        String(challenge.activeSolverCount),
        challenge.untouched ? "yes" : "no",
        challenge.stale ? "yes" : "no",
        challenge.hintViewed ? "yes" : "no",
    ])
    const solverRows = snapshot.activeSolvers.map((solver) => [solver.id, solver.challengeId ?? "-", solver.promptName, solver.status, `${solver.activeForMinutes}m (${solver.timeoutStatus})`])

    return [
        "## Constraints",
        `- Max active challenge instances: ${snapshot.constraints.maxActiveChallenges}`,
        `- Max solvers: ${snapshot.constraints.maxSolvers}`,
        `- Active challenge instances: ${snapshot.constraints.activeChallenges}`,
        `- Active solvers: ${snapshot.constraints.activeSolvers}`,
        `- Idle challenge slots: ${Math.max(snapshot.constraints.maxActiveChallenges - snapshot.constraints.activeChallenges, 0)}`,
        `- Idle solver slots: ${Math.max(snapshot.constraints.maxSolvers - snapshot.constraints.activeSolvers, 0)}`,
        `- Visible unsolved challenges: ${snapshot.challenges.length}`,
        `- Stale timeout minutes: ${Math.floor(snapshot.constraints.staleTimeoutMs / 60000)}`,
        "",
        "## Challenges",
        challengeRows.length > 0
            ? formatMarkdownTable(["ID", "Title", "Difficulty", "Level", "Score", "Flags", "Instance", "Solvers", "Untouched", "Stale", "Hint"], challengeRows)
            : "No unsolved challenges.",
        "",
        "## Active Solvers",
        solverRows.length > 0 ? formatMarkdownTable(["Solver", "Challenge", "Prompt", "Status", "Active For"], solverRows) : "No active solvers.",
        "",
        "## Challenge Details",
        ...snapshot.challenges.flatMap((challenge) => [
            `### ${challenge.id} - ${challenge.title}`,
            `- Difficulty: ${challenge.difficulty}`,
            `- Level: ${challenge.level}`,
            `- Score: ${challenge.gotScore}/${challenge.totalScore}`,
            `- Flags: ${challenge.gotFlags}/${challenge.flagCount}`,
            `- Remaining score: ${challenge.remainingScore}`,
            `- Remaining flags: ${challenge.remainingFlags}`,
            `- Instance status: ${challenge.instanceStatus}`,
            `- Hint viewed: ${challenge.hintViewed ? "yes" : "no"}`,
            `- Attempt count: ${challenge.attemptCount}`,
            `- Submission count: ${challenge.submissionCount}`,
            `- Correct submissions: ${challenge.correctSubmissionCount}`,
            `- Active solver ids: ${challenge.activeSolverIds.length > 0 ? challenge.activeSolverIds.join(", ") : "none"}`,
            `- Untouched: ${challenge.untouched ? "yes" : "no"}`,
            `- Stale: ${challenge.stale ? "yes" : "no"}`,
            typeof challenge.activeForMinutes === "number" ? `- Active for minutes: ${challenge.activeForMinutes}` : "- Active for minutes: -",
            typeof challenge.minutesSinceLastAttempt === "number" ? `- Minutes since last attempt: ${challenge.minutesSinceLastAttempt}` : "- Minutes since last attempt: -",
            typeof challenge.minutesSinceLastCorrectSubmission === "number"
                ? `- Minutes since last correct submission: ${challenge.minutesSinceLastCorrectSubmission}`
                : "- Minutes since last correct submission: -",
            challenge.entrypoint && challenge.entrypoint.length > 0 ? `- Entrypoints: ${challenge.entrypoint.join(", ")}` : "- Entrypoints: -",
            "",
        ]),
    ].join("\n")
}

function formatPreviousPlannerRoundMarkdown(previousRound?: PreviousPlannerRoundRecord): string {
    if (!previousRound) return "无上一轮调度记录。"
    return [
        `- Snapshot digest: ${previousRound.snapshot_digest}`,
        `- Actions: ${previousRound.actions.length > 0 ? previousRound.actions.join(" | ") : "none"}`,
        "",
        previousRound.summary.trim() || "无摘要。",
    ].join("\n")
}

function computePlannerSnapshotDigest(snapshot: PlannerSnapshot): string {
    const payload = JSON.stringify({
        constraints: snapshot.constraints,
        activeSolvers: snapshot.activeSolvers.map((solver) => ({
            id: solver.id,
            challengeId: solver.challengeId,
            promptName: solver.promptName,
            status: solver.status,
        })),
        challenges: snapshot.challenges.map((challenge) => ({
            id: challenge.id,
            instanceStatus: challenge.instanceStatus,
            activeSolverIds: challenge.activeSolverIds,
            attemptCount: challenge.attemptCount,
            submissionCount: challenge.submissionCount,
            correctSubmissionCount: challenge.correctSubmissionCount,
            stale: challenge.stale,
        })),
        prompts: snapshot.availableSolverPrompts.map((prompt) => prompt.name),
    })
    return Bun.hash(payload).toString(16)
}

function wrapPlannerResourceLoader(base: ResourceLoader, snapshot: PlannerSnapshot, strategy?: string, previousRound?: PreviousPlannerRoundRecord): ResourceLoader {
    const stateText = formatPlannerSnapshotMarkdown(snapshot)
    const availableSolverPromptsText = formatAvailableSolverPromptsMarkdown(snapshot)
    const strategyText = strategy?.trim() ? strategy.trim() : "无额外用户偏好。按默认策略执行。"
    const previousPlannerRoundText = formatPreviousPlannerRoundMarkdown(previousRound)
    const basePrompt = base.getSystemPrompt() ?? ""
    const replacedPrompt = basePrompt
        .replaceAll(CHALLENGE_STATE_PLACEHOLDER, stateText)
        .replaceAll(AVAILABLE_SOLVER_PROMPTS_PLACEHOLDER, availableSolverPromptsText)
        .replaceAll(USER_STRATEGY_PLACEHOLDER, strategyText)
        .replaceAll(PREVIOUS_PLANNER_ROUND_PLACEHOLDER, previousPlannerRoundText)

    return {
        getExtensions: () => base.getExtensions(),
        getSkills: () => base.getSkills(),
        getPrompts: () => base.getPrompts(),
        getThemes: () => base.getThemes(),
        getAgentsFiles: () => base.getAgentsFiles(),
        getSystemPrompt: () => replacedPrompt,
        getAppendSystemPrompt: () => base.getAppendSystemPrompt(),
        extendResources: (paths) => base.extendResources(paths),
        reload: () => base.reload(),
    }
}

function isMockChallengeId(challengeId: string): boolean {
    return challengeId.startsWith("mock-")
}

function hasRealApiConfig(apiBaseUrl?: string, agentToken?: string): boolean {
    return Boolean(apiBaseUrl && agentToken)
}

function isChallengeSolved(record: { flag_count: number; flag_got_count: number } | undefined): boolean {
    if (!record) return false
    return record.flag_count > 0 && record.flag_got_count >= record.flag_count
}

function mapApiChallengeToRecord(challenge: ChallengeApiChallenge): ChallengeRecord {
    return {
        id: challenge.code,
        title: challenge.title,
        difficulty: challenge.difficulty,
        description: challenge.description,
        level: challenge.level,
        total_score: challenge.total_score,
        total_got_score: challenge.total_got_score,
        flag_count: challenge.flag_count,
        flag_got_count: challenge.flag_got_count,
        hint_viewed: challenge.hint_viewed,
        hint_content: null,
        instance_status: challenge.instance_status,
        entrypoint: challenge.entrypoint,
        flags: [],
    }
}

function mapRecordToApiChallenge(challenge: ChallengeInfoRecord): ChallengeApiChallenge {
    return {
        title: challenge.title,
        code: challenge.id,
        difficulty: challenge.difficulty,
        description: challenge.description,
        level: challenge.level,
        total_score: challenge.total_score,
        total_got_score: challenge.total_got_score,
        flag_count: challenge.flag_count,
        flag_got_count: challenge.flag_got_count,
        hint_viewed: challenge.hint_viewed,
        instance_status: challenge.instance_status,
        entrypoint: challenge.entrypoint,
    }
}

export class ChallengeManager {
    private readonly config: ConfigManager
    private api: ChallengeApiClient | undefined
    private rootDir: string | undefined
    private runtime: RuntimeManager | undefined
    private syncTimer: ReturnType<typeof setTimeout> | undefined
    private syncLoopStarted = false
    private syncRunning = false
    private finishingChallenges = new Set<string>()
    private plannerRunning = false
    private loopTickCount = 0
    private listChallengesSyncInFlight: Promise<void> | undefined
    private listChallengesSyncLastAttemptAt = 0
    private noisyErrorLogState = new Map<string, { lastLoggedAt: number; suppressedCount: number }>()

    constructor(config: ConfigManager) {
        this.config = config
    }

    private log(scope: string, message: string, fields?: Record<string, unknown>): void {
        const prefix = formatChallengeLogScope(scope)
        if (!fields || Object.keys(fields).length === 0) {
            console.log(`${prefix} ${message}`)
            return
        }
        console.log(`${prefix} ${message} ${JSON.stringify(fields)}`)
    }

    private error(scope: string, message: string, error?: unknown, fields?: Record<string, unknown>): void {
        const prefix = formatChallengeLogScope(scope)
        const nextFields: Record<string, unknown> = { ...(fields ?? {}) }
        const errorMessage = extractErrorMessage(error)
        if (errorMessage) {
            nextFields.error = errorMessage
        }

        if (isNoisyChallengeApiError(errorMessage)) {
            const signature = `${scope}|${message}|${errorMessage}`
            const now = Date.now()
            const state = this.noisyErrorLogState.get(signature)
            if (state && now - state.lastLoggedAt < NOISY_ERROR_THROTTLE_WINDOW_MS) {
                state.suppressedCount += 1
                return
            }
            const suppressedCount = state?.suppressedCount ?? 0
            this.noisyErrorLogState.set(signature, { lastLoggedAt: now, suppressedCount: 0 })
            if (this.noisyErrorLogState.size > NOISY_ERROR_SIGNATURE_LIMIT) {
                const oldest = this.noisyErrorLogState.keys().next()
                if (!oldest.done) this.noisyErrorLogState.delete(oldest.value)
            }
            if (suppressedCount > 0) {
                nextFields.suppressed = suppressedCount
            }
        }

        console.error(`${prefix} ${message}${Object.keys(nextFields).length > 0 ? ` ${JSON.stringify(nextFields)}` : ""}`)
    }

    attachRuntime(runtime: RuntimeManager): void {
        this.runtime = runtime
    }

    reloadFromConfig(): void {
        this.api = undefined
        this.listChallengesSyncInFlight = undefined
        this.listChallengesSyncLastAttemptAt = 0
    }

    getRuntime(): RuntimeManager | undefined {
        return this.runtime
    }

    private broadcastHintToRunningSolvers(challengeId: string, hintContent: string): void {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const message = hintContent.trim()
        if (!runtime || !targetChallengeId || !message) return
        for (const solver of runtime.list()) {
            if (solver.challengeId !== targetChallengeId) continue
            if (solver.status !== "running") continue
            try {
                runtime.sendCommand(solver.id, {
                    type: "follow_up",
                    message: `赛题提示：\n${message}`,
                })
            } catch {
                // ignore inactive solver pipes
            }
        }
    }

    private broadcastChallengeBoardUpdateToRunningSolvers(challengeId: string, message: string): void {
        const runtime = this.runtime
        const targetChallengeId = challengeId.trim()
        const text = message.trim()
        if (!runtime || !targetChallengeId || !text) return
        for (const solver of runtime.list()) {
            if (solver.challengeId !== targetChallengeId) continue
            if (solver.status !== "running") continue
            try {
                runtime.sendCommand(solver.id, {
                    type: "follow_up",
                    message: text,
                })
            } catch {
                // ignore inactive solver pipes
            }
        }
    }

    startSyncLoop(): void {
        if (this.syncLoopStarted) return
        this.syncLoopStarted = true
        this.log("challenge:sync-loop", "starting loop", { intervalMs: DEFAULT_TICK_INTERVAL_MS })
        const tick = async () => {
            this.syncRunning = true
            const tickId = ++this.loopTickCount
            let nextIntervalMs = DEFAULT_TICK_INTERVAL_MS
            try {
                console.log(`\n========== planner round #${tickId} ==========`)
                nextIntervalMs = resolvePlannerTickIntervalMs((await this.config.getHostSettings()).planner.tickIntervalMs)
                const realApiMode = await this.hasRealApiMode()
                let syncSummary: ChallengeListResult["summary"] | undefined
                if (await this.hasRealApiMode()) {
                    const result = await this.listChallenges("challenge-api:loop")
                    syncSummary = result.summary
                }
                await this.tickPlanner("challenge-planner:loop")
                if (syncSummary) {
                    this.log("challenge:sync-loop", "tick summary", {
                        tickId,
                        realApiMode,
                        sync: syncSummary,
                    })
                }
                console.log(`========== end planner round #${tickId} ==========\n`)
            } catch (error) {
                this.error("challenge:sync-loop", "tick failed", error, { tickId })
                console.log(`========== end planner round #${tickId} ==========\n`)
            } finally {
                this.syncRunning = false
                this.syncTimer = setTimeout(() => {
                    void tick()
                }, nextIntervalMs)
            }
        }
        void tick()
    }

    async tickPlanner(source = "challenge-planner:manual"): Promise<string | undefined> {
        const settings = await this.config.getHostSettings()
        resolvePlannerTickIntervalMs(settings.planner.tickIntervalMs)
        if (this.plannerRunning) return
        if (settings.planner.enabled !== true) return

        this.plannerRunning = true
        try {
            return await this.runPlannerOnce(source)
        } catch (error) {
            this.error("challenge:planner", "tick failed", error, { source })
            return
        } finally {
            this.plannerRunning = false
        }
    }

    private async getRootDir(): Promise<string> {
        if (this.rootDir) return this.rootDir
        const rootDir = resolveChallengeDir()
        await ensureChallengeStoreBaseDir(rootDir)
        this.rootDir = rootDir
        return rootDir
    }

    private async readPreviousPlannerRound(): Promise<PreviousPlannerRoundRecord | undefined> {
        const rootDir = await this.getRootDir()
        const file = Bun.file(join(rootDir, "planner-last-round.json"))
        if (!(await file.exists())) return
        try {
            return (await file.json()) as PreviousPlannerRoundRecord
        } catch {
            return
        }
    }

    private async writePreviousPlannerRound(record: PreviousPlannerRoundRecord): Promise<void> {
        const rootDir = await this.getRootDir()
        await Bun.write(join(rootDir, "planner-last-round.json"), JSON.stringify(record, null, 2))
    }

    private async isMockMode(): Promise<boolean> {
        const hostSettings = await this.config.getHostSettings()
        return hostSettings.challenge.mockEnabled === true
    }

    private async hasRealApiMode(): Promise<boolean> {
        const hostSettings = await this.config.getHostSettings()
        return hasRealApiConfig(hostSettings.challenge.apiBaseUrl, hostSettings.challenge.agentToken)
    }

    private async filterChallengesByMode(challenges: ChallengeInfoRecord[]): Promise<ChallengeInfoRecord[]> {
        const mockMode = await this.isMockMode()
        if (mockMode) return challenges.filter((challenge) => isMockChallengeId(challenge.id))

        const realApiMode = await this.hasRealApiMode()
        if (realApiMode) return challenges.filter((challenge) => !isMockChallengeId(challenge.id))

        return challenges
    }

    private async readVisibleChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        const rootDir = await this.getRootDir()
        const id = requireText(challengeId, "challengeId")
        const challenge = await readChallengeRecord(rootDir, id)
        if (!challenge) return
        const mockMode = await this.isMockMode()
        if (mockMode) return isMockChallengeId(id) ? challenge : undefined

        const realApiMode = await this.hasRealApiMode()
        if (realApiMode) return isMockChallengeId(id) ? undefined : challenge

        return challenge
    }

    private async getApi(): Promise<ChallengeApiClient> {
        if (this.api) return this.api
        const hostSettings = await this.config.getHostSettings()
        if (hostSettings.challenge.mockEnabled === true) {
            const rootDir = await this.getRootDir()
            const listStored = async () => this.filterChallengesByMode(await listChallengeRecords(rootDir))
            const api = ChallengeApiClient.createMock({
                listChallenges: async () => {
                    const challenges = await listStored()
                    return {
                        current_level: challenges.reduce((max, challenge) => Math.max(max, challenge.level), 0),
                        total_challenges: challenges.length,
                        solved_challenges: challenges.filter((challenge) => computeChallengeCompleted(challenge)).length,
                        challenges: challenges.map(mapRecordToApiChallenge),
                    }
                },
                startChallenge: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (computeChallengeCompleted(challenge)) {
                        return { already_completed: true }
                    }
                    if (challenge.instance_status === "running") {
                        return challenge.entrypoint && challenge.entrypoint.length > 0 ? challenge.entrypoint : ["127.0.0.1:8080"]
                    }
                    const runningCount = (await listStored()).filter((item) => item.instance_status === "running" || item.instance_status === "pending").length
                    if (runningCount >= 3) {
                        throw new Error("mock mode: at most 3 challenges can run at the same time")
                    }
                    const entrypoint = challenge.entrypoint && challenge.entrypoint.length > 0 ? challenge.entrypoint : ["127.0.0.1:8080"]
                    await saveChallengeRecord(
                        rootDir,
                        {
                            ...challenge,
                            instance_status: "running",
                            entrypoint,
                        },
                        "challenge-api:mock-start",
                    )
                    return entrypoint
                },
                stopChallenge: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running" && challenge.instance_status !== "pending") {
                        throw new Error("mock mode: challenge instance is not running")
                    }
                    await saveChallengeRecord(
                        rootDir,
                        {
                            ...challenge,
                            instance_status: "stopped",
                            entrypoint: null,
                        },
                        "challenge-api:mock-stop",
                    )
                    return null
                },
                submitFlag: async (code, flag) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running") {
                        throw new Error("mock mode: challenge instance is not running")
                    }
                    const flags = challenge.flags ?? []
                    const isCorrect = flags.includes(flag)
                    const alreadySolved = isCorrect && challenge.flag_got_count >= challenge.flag_count
                    const nextGotCount = isCorrect && !alreadySolved ? Math.min(challenge.flag_got_count + 1, challenge.flag_count) : challenge.flag_got_count
                    if (nextGotCount !== challenge.flag_got_count) {
                        await saveChallengeRecord(
                            rootDir,
                            {
                                ...challenge,
                                flag_got_count: nextGotCount,
                                total_got_score:
                                    challenge.flag_count > 0 ? Math.min(challenge.total_score, Math.round((challenge.total_score * nextGotCount) / challenge.flag_count)) : challenge.total_got_score,
                            },
                            "challenge-api:mock-submit",
                        )
                    }
                    return {
                        correct: isCorrect,
                        message: isCorrect ? "mock mode: flag correct" : "mock mode: flag incorrect",
                        flag_count: challenge.flag_count,
                        flag_got_count: nextGotCount,
                    }
                },
                getHint: async (code) => {
                    const challenge = await this.readVisibleChallenge(code)
                    if (!challenge) throw new Error(`challenge "${code}" not found`)
                    if (challenge.instance_status !== "running") {
                        throw new Error("mock mode: challenge instance is not running")
                    }
                    if (!challenge.hint_viewed) {
                        await saveChallengeRecord(
                            rootDir,
                            {
                                ...challenge,
                                hint_viewed: true,
                            },
                            "challenge-api:mock-hint",
                        )
                    }
                    return {
                        code,
                        hint_content: challenge.hint_content ?? null,
                    }
                },
            })
            this.api = api
            return api
        }
        if (!hasRealApiConfig(hostSettings.challenge.apiBaseUrl, hostSettings.challenge.agentToken)) {
            throw new Error("challenge.apiBaseUrl and challenge.agentToken are required")
        }
        const apiBaseUrl = requireText(hostSettings.challenge.apiBaseUrl ?? "", "challenge.apiBaseUrl")
        const agentToken = requireText(hostSettings.challenge.agentToken ?? "", "challenge.agentToken")
        const api = ChallengeApiClient.create(apiBaseUrl, agentToken)
        this.api = api
        return api
    }

    private async getContext(): Promise<{ api: ChallengeApiClient; rootDir: string }> {
        const api = await this.getApi()
        const rootDir = await this.getRootDir()
        return { api, rootDir }
    }

    async listChallenges(source = "challenge-api:list"): Promise<ChallengeListResult> {
        const { api, rootDir } = await this.getContext()
        const remote = await api.listChallenges()
        for (const challenge of remote.challenges) {
            const next = mapApiChallengeToRecord(challenge)
            const existing = await readChallengeRecord(rootDir, next.id)
            await saveChallengeRecord(
                rootDir,
                {
                    ...next,
                    hint_viewed: existing?.hint_viewed === true || next.hint_viewed,
                    flags: existing?.flags ?? next.flags,
                    hint_content: existing?.hint_content ?? next.hint_content,
                },
                source,
            )
            if (!isChallengeSolved(existing) && isChallengeSolved(next)) {
                void this.finishChallenge(next.id)
            }
        }
        const local = await this.filterChallengesByMode(await listChallengeRecords(rootDir))
        return {
            remote,
            local,
            summary: {
                remote: remote.challenges.length,
                local: local.length,
                solved: remote.solved_challenges,
                total: remote.total_challenges,
                mockMode: await this.isMockMode(),
                realApiMode: await this.hasRealApiMode(),
            },
        }
    }

    async listChallengesSafe(source = "challenge-api:list"): Promise<ChallengeInfoRecord[]> {
        const mockMode = await this.isMockMode()
        const realApiMode = await this.hasRealApiMode()
        if (!mockMode && !realApiMode) {
            return this.listStoredChallenges()
        }

        const stored = await this.listStoredChallenges()
        if (stored.length > 0) {
            if (realApiMode) this.scheduleListChallengesSync(source)
            return stored
        }

        try {
            const result = await this.listChallenges(source)
            return result.local
        } catch (error) {
            this.error(`challenge:list:${source}`, "sync failed, fallback to stored challenges", error)
            return this.listStoredChallenges()
        }
    }

    async listStoredChallenges(): Promise<ChallengeInfoRecord[]> {
        const rootDir = await this.getRootDir()
        return this.filterChallengesByMode(await listChallengeRecords(rootDir))
    }

    private scheduleListChallengesSync(source: string): void {
        if (this.listChallengesSyncInFlight) return
        const now = Date.now()
        if (now - this.listChallengesSyncLastAttemptAt < LIST_CHALLENGES_SYNC_COOLDOWN_MS) return

        this.listChallengesSyncLastAttemptAt = now
        const run = (async () => {
            try {
                await this.listChallenges(source)
            } catch (error) {
                this.error(`challenge:list:${source}`, "background sync failed", error)
            }
        })()

        this.listChallengesSyncInFlight = run
        void run.finally(() => {
            if (this.listChallengesSyncInFlight === run) {
                this.listChallengesSyncInFlight = undefined
            }
        })
    }

    async createChallenge(challenge: ChallengeRecord, source = "manual"): Promise<ChallengeInfoRecord | undefined> {
        const rootDir = await this.getRootDir()
        await saveChallengeRecord(rootDir, challenge, source)
        return this.readVisibleChallenge(challenge.id)
    }

    async getChallenge(challengeId: string): Promise<ChallengeInfoRecord | undefined> {
        return this.readVisibleChallenge(challengeId)
    }

    async startChallenge(challengeId: string): Promise<ChallengeActionResult<ChallengeApiStartData>> {
        const { api } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        this.log("challenge:start", "starting challenge instance", { challengeId: id })
        const remote = await api.startChallenge(id)
        const challenge = await this.syncChallenge(id, "challenge-api:start")
        this.log("challenge:start", "challenge instance started", {
            challengeId: id,
            instanceStatus: challenge?.instance_status,
            entrypoint: challenge?.entrypoint ?? null,
            alreadyCompleted: computeChallengeCompleted(challenge),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async stopChallenge(challengeId: string): Promise<ChallengeActionResult<null>> {
        const { api } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        this.log("challenge:stop", "stopping challenge instance", { challengeId: id })
        const remote = await api.stopChallenge(id)
        const challenge = await this.syncChallenge(id, "challenge-api:stop")
        this.log("challenge:stop", "challenge instance stopped", {
            challengeId: id,
            instanceStatus: challenge?.instance_status,
            completed: computeChallengeCompleted(challenge),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async submitFlag(challengeId: string, flag: string, meta?: ChallengeSubmissionMeta): Promise<ChallengeActionResult<ChallengeApiSubmitData>> {
        const { api, rootDir } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        const normalizedFlag = requireText(flag, "flag")
        this.log("challenge:submit", "submitting flag", {
            challengeId: id,
            solverId: meta?.solverId,
            promptName: meta?.promptName,
            modelName: meta?.modelName,
        })
        const remote = await api.submitFlag(id, normalizedFlag)
        await appendChallengeSubmissionLog(rootDir, {
            challengeId: id,
            solverId: meta?.solverId,
            promptName: meta?.promptName,
            modelName: meta?.modelName,
            flag: normalizedFlag,
            correct: remote.correct,
            message: "message" in remote && typeof remote.message === "string" ? remote.message : undefined,
            writeup: meta?.writeup,
        })
        const challenge = await this.syncChallenge(id, "challenge-api:submit")
        this.log("challenge:submit", "flag submission finished", {
            challengeId: id,
            correct: remote.correct,
            flags: `${remote.flag_got_count}/${remote.flag_count}`,
            completed: computeChallengeCompleted(challenge),
        })
        if (computeChallengeCompleted(challenge)) {
            setTimeout(() => {
                void this.finishChallenge(id)
            }, 0)
        }
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async getHint(challengeId: string): Promise<ChallengeActionResult<ChallengeApiHintData>> {
        const { api, rootDir } = await this.getContext()
        const id = requireText(challengeId, "challengeId")
        this.log("challenge:hint", "requesting hint", { challengeId: id })
        const remote = await api.getHint(id)
        const current = await this.readVisibleChallenge(id)
        if (current) {
            await saveChallengeRecord(
                rootDir,
                {
                    ...current,
                    hint_viewed: true,
                    hint_content: remote.hint_content,
                },
                "challenge-api:hint-content",
            )
        }
        const challenge = await this.syncChallenge(id, "challenge-api:hint")
        this.log("challenge:hint", "hint received", {
            challengeId: id,
            hintViewed: challenge?.hint_viewed === true,
            hasHintContent: Boolean(remote.hint_content?.trim()),
        })
        return {
            remote,
            challenge,
            is_completed: computeChallengeCompleted(challenge),
        }
    }

    async isChallengeCompleted(challengeId: string): Promise<boolean> {
        const challenge = await this.readVisibleChallenge(challengeId)
        return computeChallengeCompleted(challenge)
    }

    async appendMemory(input: AddMemoryInput): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await appendChallengeMemory(rootDir, input)
        this.broadcastChallengeBoardUpdateToRunningSolvers(input.challengeId, formatChallengeMemoryBroadcastMessage("added", entry))
        return entry
    }

    async listMemory(challengeId: string): Promise<MemoryEntry[]> {
        const rootDir = await this.getRootDir()
        return listChallengeMemory(rootDir, challengeId)
    }

    async updateMemory(challengeId: string, entryIdOrPrefix: string, patch: { kind?: MemoryKind; content?: string; refs?: string[]; source?: string }): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await updateChallengeMemory(rootDir, challengeId, entryIdOrPrefix, patch)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("updated", entry))
        return entry
    }

    async deleteMemory(challengeId: string, entryIdOrPrefix: string): Promise<MemoryEntry> {
        const rootDir = await this.getRootDir()
        const entry = await deleteChallengeMemory(rootDir, challengeId, entryIdOrPrefix)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeMemoryBroadcastMessage("deleted", entry))
        return entry
    }

    async listIdeas(challengeId: string): Promise<IdeaRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeIdeas(rootDir, challengeId)
    }

    async searchIdeas(challengeId: string, query: string): Promise<IdeaRecord[]> {
        const rootDir = await this.getRootDir()
        return searchChallengeIdeas(rootDir, challengeId, query)
    }

    async addIdea(challengeId: string, input: AddIdeaInput): Promise<AddIdeaResult> {
        const rootDir = await this.getRootDir()
        const result = await addChallengeIdea(rootDir, challengeId, input)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("added", result.item))
        return result
    }

    async updateIdea(challengeId: string, ideaIdOrPrefix: string, patch: UpdateIdeaInput): Promise<IdeaRecord> {
        const rootDir = await this.getRootDir()
        const item = await updateChallengeIdea(rootDir, challengeId, ideaIdOrPrefix, patch)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("updated", item))
        return item
    }

    async deleteIdea(challengeId: string, ideaIdOrPrefix: string): Promise<IdeaRecord> {
        const rootDir = await this.getRootDir()
        const item = await deleteChallengeIdea(rootDir, challengeId, ideaIdOrPrefix)
        this.broadcastChallengeBoardUpdateToRunningSolvers(challengeId, formatChallengeIdeaBroadcastMessage("deleted", item))
        return item
    }

    async appendAttemptLog(input: { challengeId: string; solverId: string; promptName: string; task: string }) {
        const rootDir = await this.getRootDir()
        return appendChallengeAttemptLog(rootDir, input)
    }

    async listAttemptLogs(challengeId: string): Promise<ChallengeAttemptLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeAttemptLogs(rootDir, challengeId)
    }

    async listSubmissionLogs(challengeId: string): Promise<ChallengeSubmissionLogRecord[]> {
        const rootDir = await this.getRootDir()
        return listChallengeSubmissionLogs(rootDir, challengeId)
    }

    async refreshStats(challengeId: string): Promise<{ stats: ChallengeStatsRecord; solver_stats: SolverStatsRecord[] }> {
        const rootDir = await this.getRootDir()
        return refreshChallengeStats(rootDir, challengeId)
    }

    private async seedSolverBoardFromChallenge(solverId: string, challengeId: string): Promise<void> {
        const [memoryItems, ideaItems] = await Promise.all([this.listMemory(challengeId), this.listIdeas(challengeId)])
        await seedSolverBoardSnapshot(
            {
                memory: memoryItems,
                ideas: ideaItems,
            },
            solverSessionDir(solverId),
        )
    }

    async launchSolver(challengeId: string, promptName: string, options?: LaunchSolverOptions): Promise<SolverInstance> {
        if (!this.runtime) {
            throw new Error("runtime is not attached")
        }
        const promptNameText = requireText(promptName, "promptName")
        this.log("challenge:solver", "launch requested", { challengeId, promptName: promptNameText })

        const prompt = await this.config.getPrompt(promptNameText)
        if (!prompt) {
            throw new Error(`prompt not found: ${promptNameText}`)
        }
        if (prompt.meta.disabled === true) {
            throw new Error(`prompt is disabled: ${promptNameText}`)
        }
        if (prompt.meta.isSubagent === true) {
            throw new Error(`subagent prompt cannot be started as solver: ${promptNameText}`)
        }

        const current = await this.getChallenge(challengeId)
        if (!current) {
            throw new Error(`challenge "${challengeId}" not found`)
        }
        if (computeChallengeCompleted(current)) {
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        let challenge: ChallengeInfoRecord | undefined = current
        if (current.instance_status === "running" || current.instance_status === "pending") {
            this.log("challenge:solver", "reuse running challenge instance", {
                challengeId,
                instanceStatus: current.instance_status,
                entrypoint: current.entrypoint ?? null,
            })
        } else {
            const started = await this.startChallenge(challengeId)
            challenge = started.challenge ?? (await this.getChallenge(challengeId))
        }
        if (!challenge) {
            throw new Error(`challenge "${challengeId}" not found after start`)
        }
        if (computeChallengeCompleted(challenge)) {
            void this.finishChallenge(challengeId)
            throw new Error(`challenge "${challengeId}" is already completed`)
        }

        const solverId = crypto.randomUUID().slice(0, 8)
        const task = await this.buildSolverTask(challenge, options)
        try {
            await this.seedSolverBoardFromChallenge(solverId, challengeId)
        } catch (error) {
            this.error("challenge:solver", "failed to seed solver board from challenge context", error, {
                challengeId,
                solverId,
            })
        }
        const solver = await this.runtime.launch(promptNameText, task, { [CHALLENGE_ENV_CHALLENGE_ID]: challengeId }, { solverId })
        await this.appendAttemptLog({
            challengeId,
            solverId: solver.id,
            promptName: promptNameText,
            task: solver.task,
        })
        this.log("challenge:solver", "solver launched", {
            challengeId,
            solverId: solver.id,
            promptName: promptNameText,
            solverName: solver.name,
        })
        return solver
    }

    async finishChallenge(challengeId: string): Promise<void> {
        const id = requireText(challengeId, "challengeId")
        if (this.finishingChallenges.has(id)) return
        this.finishingChallenges.add(id)
        this.log("challenge:finish", "finishing solved challenge", { challengeId: id })
        try {
            const challenge = await this.getChallenge(id)
            if (!computeChallengeCompleted(challenge)) return

            if (challenge && (challenge.instance_status === "running" || challenge.instance_status === "pending")) {
                try {
                    await this.stopChallenge(id)
                } catch (error) {
                    this.error("challenge:finish", "failed to stop challenge instance during finish", error, { challengeId: id })
                }
            }

            if (!this.runtime) return
            const solvers = await this.runtime.listAll()
            const active = solvers.filter((solver) => solver.challengeId === id && (solver.status === "starting" || solver.status === "running" || solver.status === "stopping"))
            await Promise.allSettled(active.map((solver) => this.runtime!.stopSolver(solver.id)))
            this.log("challenge:finish", "finished solved challenge cleanup", { challengeId: id, stoppedSolvers: active.map((solver) => solver.id) })
        } finally {
            this.finishingChallenges.delete(id)
        }
    }

    private async runPlannerOnce(source: string): Promise<string | undefined> {
        const runtime = this.getRuntime()
        if (!runtime) return

        const settings = await this.config.getHostSettings()
        const sessionOpts = await this.config.resolvePromptSession(DEFAULT_PLANNER_PROMPT_NAME)
        if (!sessionOpts?.resourceLoader) {
            this.error("challenge:planner", "planner prompt missing or failed to resolve", undefined, { promptName: DEFAULT_PLANNER_PROMPT_NAME })
            return
        }

        const snapshot = await this.buildPlannerSnapshot(source)
        if (snapshot.challenges.length === 0) {
            return `source=${source} unsolved=0`
        }

        const previousRound = await this.readPreviousPlannerRound()
        const resourceLoader = wrapPlannerResourceLoader(sessionOpts.resourceLoader, snapshot, settings.planner.strategy, previousRound)
        await resourceLoader.reload()

        const { session } = await createAgentSession({
            ...sessionOpts,
            resourceLoader,
            customTools: [...(sessionOpts.customTools ?? []), ...this.createPlannerTools(snapshot)],
            sessionManager: SessionManager.inMemory(),
        })

        let plannerMessage = ""
        let plannerStopReason = ""
        const plannerActions = new Map<string, string>()
        let plannerStreaming = false
        session.subscribe((event) => {
            if (event.type === "message_start") {
                plannerStreaming = false
            }
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
                if (!plannerStreaming) {
                    process.stdout.write(`${formatChallengeLogScope("challenge:planner")} output\n`)
                    plannerStreaming = true
                }
                writePlannerTextChunk(event.assistantMessageEvent.delta)
            }
            if (event.type === "message_end" && event.message?.role === "assistant") {
                if (plannerStreaming) process.stdout.write("\n")
                plannerMessage = extractTextContent(event.message.content as Array<{ type: string; text?: string }> | undefined)
                plannerStopReason = event.message.stopReason ?? ""
            }
            if (event.type === "tool_execution_start") {
                plannerActions.set(event.toolCallId, `${event.toolName} ${JSON.stringify(event.args ?? {})}`)
            }
            if (event.type === "tool_execution_end" && event.isError) {
                this.error("challenge:planner", "planner tool failed", undefined, { toolName: event.toolName, result: event.result })
            }
        })

        await session.prompt("开始本轮比赛调度。")
        session.dispose()
        const plannerText =
            plannerMessage ||
            [
                `unsolved=${snapshot.challenges.length}`,
                `activeChallenges=${snapshot.constraints.activeChallenges}`,
                `activeSolvers=${snapshot.constraints.activeSolvers}`,
                `availablePrompts=${snapshot.availableSolverPrompts.length}`,
            ].join(" ")
        const plannerHeader = `${formatChallengeLogScope("challenge:planner")} model output${plannerStopReason ? ` [${plannerStopReason}]` : ""}`
        console.log(`${plannerHeader}\n${plannerText}`)
        await this.writePreviousPlannerRound({
            generated_at: new Date().toISOString(),
            snapshot_digest: computePlannerSnapshotDigest(snapshot),
            actions: [...plannerActions.values()],
            summary: plannerText,
        })
        return plannerMessage || plannerStopReason || undefined
    }

    private createPlannerTools(snapshot: PlannerSnapshot): ToolDefinition[] {
        const emptyObject = Type.Object({})
        const challengeIds = snapshot.challenges.map((challenge) => challenge.id)
        const solverPromptNames = snapshot.availableSolverPrompts.map((prompt) => prompt.name)
        const activeSolverIds = snapshot.activeSolvers.map((solver) => solver.id)
        const snapshotChallenges = new Map(snapshot.challenges.map((challenge) => [challenge.id, challenge]))
        const snapshotSolvers = new Map(snapshot.activeSolvers.map((solver) => [solver.id, solver]))
        const challengeIdSchema = challengeIds.length > 0 ? Type.Union(challengeIds.map((id) => Type.Literal(id))) : Type.String({ description: "challenge id" })
        const promptNameSchema = solverPromptNames.length > 0 ? Type.Union(solverPromptNames.map((name) => Type.Literal(name))) : Type.String({ description: "solver prompt name" })
        const solverIdSchema = activeSolverIds.length > 0 ? Type.Union(activeSolverIds.map((id) => Type.Literal(id))) : Type.String({ description: "solver id" })

        return [
            defineTool({
                name: "planner_get_state",
                label: "Get Planner State",
                description: "Get current unsolved challenges, active challenge instances, solver allocation, attempts, submissions and stale indicators.",
                parameters: emptyObject,
                execute: async () => {
                    const snapshot = await this.buildPlannerSnapshot("challenge-planner:tool-state")
                    return {
                        content: [{ type: "text", text: formatPlannerSnapshotMarkdown(snapshot) }],
                        details: snapshot,
                    }
                },
            }),
            defineTool({
                name: "planner_start_challenge",
                label: "Start Challenge",
                description: "Start a challenge instance. Use when you want to occupy one of the 3 challenge-instance slots.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    this.log("challenge:planner-tool", "start challenge requested", { challengeId: params.challengeId })
                    const result = await this.startChallenge(params.challengeId)
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    }
                },
            }),
            defineTool({
                name: "planner_stop_challenge",
                label: "Stop Challenge",
                description: "Stop a challenge instance and free one of the 3 challenge-instance slots.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    const challenge = snapshotChallenges.get(params.challengeId)
                    if (challenge && !challenge.stale) {
                        throw new Error(`challenge "${params.challengeId}" is not stale yet; stop is blocked before stale timeout`)
                    }
                    this.log("challenge:planner-tool", "stop challenge requested", { challengeId: params.challengeId })
                    const result = await this.stopChallenge(params.challengeId)
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        details: result,
                    }
                },
            }),
            defineTool({
                name: "planner_launch_solver",
                label: "Launch Solver",
                description:
                    "Launch a solver for a challenge. Always include solverHandoff: a concise solver-facing startup brief distilled from user strategy and current challenge state. Do not paste scheduling rules verbatim.",
                parameters: Type.Object({
                    challengeId: challengeIdSchema,
                    promptName: promptNameSchema,
                    solverHandoff: Type.String({
                        minLength: 1,
                        maxLength: 1200,
                        description: "Short solver-facing startup note. Include only solver-executable guidance relevant to this challenge.",
                    }),
                }),
                execute: async (_toolCallId, params) => {
                    const promptName = requireText(params.promptName, "promptName")
                    const solverHandoff = clipTaskText(requireText(params.solverHandoff, "solverHandoff"), SOLVER_HANDOFF_MAX_CHARS)
                    this.log("challenge:planner-tool", "launch solver requested", { challengeId: params.challengeId, promptName })
                    try {
                        const solver = await this.launchSolver(params.challengeId, promptName, { plannerHandoff: solverHandoff })
                        return {
                            content: [{ type: "text", text: JSON.stringify(solver, null, 2) }],
                            details: solver,
                        }
                    } catch (error) {
                        this.error("challenge:planner-tool", "launch solver failed", error, { challengeId: params.challengeId, promptName })
                        throw error
                    }
                },
            }),
            defineTool({
                name: "planner_stop_solver",
                label: "Stop Solver",
                description: "Stop a running solver to free a solver slot.",
                parameters: Type.Object({
                    solverId: solverIdSchema,
                }),
                execute: async (_toolCallId, params) => {
                    const runtime = this.getRuntime()
                    if (!runtime) throw new Error("runtime is not attached")
                    const solver = snapshotSolvers.get(params.solverId)
                    const challenge = solver?.challengeId ? snapshotChallenges.get(solver.challengeId) : undefined
                    if (challenge && !challenge.stale) {
                        throw new Error(`challenge "${challenge.id}" is not stale yet; solver stop is blocked before stale timeout`)
                    }
                    this.log("challenge:planner-tool", "stop solver requested", { solverId: params.solverId })
                    await runtime.stopSolver(params.solverId)
                    return {
                        content: [{ type: "text", text: `stopped solver ${params.solverId}` }],
                        details: { solverId: params.solverId },
                    }
                },
            }),
        ]
    }

    private async buildPlannerSnapshot(source: string): Promise<PlannerSnapshot> {
        const runtime = this.getRuntime()
        if (!runtime) throw new Error("runtime is not attached")

        const settings = await this.config.getHostSettings()
        const maxSolvers = clampInt(settings.runtime.maxSolvers ?? DEFAULT_MAX_SOLVERS, 0, 64)
        const staleTimeoutMs = clampInt(settings.planner.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS, 5 * 60 * 1000, 24 * 60 * 60 * 1000)
        const challenges = await this.listChallengesSafe(source)
        const unsolved = challenges.filter((item) => !computeChallengeCompleted(item))
        const solvers = await runtime.listAll()
        const activeSolvers = solvers.filter(isActiveSolver)
        const modelPrefs = await this.config.listModelPrefs()
        const solverPrompts = (await this.config.listAgentPrompts()).filter(
            (prompt) => prompt.meta.isSubagent !== true && prompt.meta.disabled !== true && prompt.deleted !== true && prompt.name !== DEFAULT_PLANNER_PROMPT_NAME,
        )
        const statsOverview = buildChallengeStatsOverview(
            await Promise.all(
                challenges.map(async (challenge) => {
                    const [statsResult, submissions] = await Promise.all([this.refreshStats(challenge.id), this.listSubmissionLogs(challenge.id)])
                    return {
                        challenge,
                        stats: statsResult.stats,
                        solver_stats: statsResult.solver_stats,
                        submissions,
                    }
                }),
            ),
        )
        const promptPerformanceByName = new Map(statsOverview.prompts.map((bucket) => [bucket.key, bucket]))

        const challengeItems = await Promise.all(
            unsolved.map(async (challenge) => {
                const [attempts, submissions] = await Promise.all([this.listAttemptLogs(challenge.id), this.listSubmissionLogs(challenge.id)])
                return this.buildPlannerSnapshotItem(challenge, attempts, submissions, activeSolvers, staleTimeoutMs)
            }),
        )

        return {
            generatedAt: new Date().toISOString(),
            constraints: {
                maxActiveChallenges: MAX_ACTIVE_CHALLENGES,
                maxSolvers,
                activeChallenges: challengeItems.filter((item) => item.instanceStatus === "running" || item.instanceStatus === "pending").length,
                activeSolvers: activeSolvers.length,
                staleTimeoutMs,
            },
            activeSolvers: activeSolvers.map((solver) => ({
                id: solver.id,
                challengeId: solver.challengeId,
                promptName: solver.promptName,
                status: solver.status,
                activeForMinutes: formatMinutesFromTimestamp(solver.createdAt) ?? 0,
                timeoutStatus: solver.createdAt + staleTimeoutMs <= Date.now() ? "stale" : "normal",
            })),
            availableSolverPrompts: solverPrompts.map((prompt) => {
                const modelPrefId = typeof prompt.meta.model === "string" && prompt.meta.model.trim() ? prompt.meta.model.trim() : undefined
                const model = modelPrefId ? modelPrefs.find((entry) => entry.id === modelPrefId) : undefined
                const modelLabel = model ? `${model.provider}/${model.modelId}${model.name ? ` (${model.name})` : ""}` : modelPrefId
                const modelBucketKey = model ? `${model.provider}/${model.modelId}` : modelPrefId

                return {
                    name: prompt.name,
                    description: prompt.meta.description,
                    modelPrefId,
                    modelLabel,
                    promptPerformance: promptPerformanceByName.get(prompt.name),
                }
            }),
            challenges: challengeItems.sort((a, b) => {
                if (a.untouched !== b.untouched) return a.untouched ? -1 : 1
                if (a.difficulty !== b.difficulty) return a.difficulty.localeCompare(b.difficulty)
                return b.remainingScore - a.remainingScore
            }),
        }
    }

    private buildPlannerSnapshotItem(
        challenge: ChallengeInfoRecord,
        attempts: ChallengeAttemptLogRecord[],
        submissions: ChallengeSubmissionLogRecord[],
        activeSolvers: SolverInstance[],
        staleTimeoutMs: number,
    ): PlannerSnapshotChallenge {
        const challengeSolvers = activeSolvers.filter((solver) => solver.challengeId === challenge.id)
        const oldestActiveSolverAt = challengeSolvers.map((solver) => solver.createdAt).sort((a, b) => a - b)[0]
        const lastAttemptAt = attempts
            .map((item) => parseTimestamp(item.created_at))
            .filter((item): item is number => typeof item === "number")
            .sort((a, b) => b - a)[0]
        const lastCorrectSubmissionAt = submissions
            .filter((item) => item.correct)
            .map((item) => parseTimestamp(item.created_at))
            .filter((item): item is number => typeof item === "number")
            .sort((a, b) => b - a)[0]

        return {
            id: challenge.id,
            title: challenge.title,
            difficulty: challenge.difficulty,
            level: challenge.level,
            totalScore: challenge.total_score,
            gotScore: challenge.total_got_score,
            flagCount: challenge.flag_count,
            gotFlags: challenge.flag_got_count,
            remainingFlags: Math.max(challenge.flag_count - challenge.flag_got_count, 0),
            remainingScore: Math.max(challenge.total_score - challenge.total_got_score, 0),
            hintViewed: challenge.hint_viewed,
            instanceStatus: challenge.instance_status,
            entrypoint: challenge.entrypoint,
            attemptCount: attempts.length,
            submissionCount: submissions.length,
            correctSubmissionCount: submissions.filter((item) => item.correct).length,
            untouched: attempts.length === 0,
            stale: Boolean(oldestActiveSolverAt && Date.now() - oldestActiveSolverAt >= staleTimeoutMs && submissions.every((item) => item.correct !== true)),
            activeSolverCount: challengeSolvers.length,
            activeSolverIds: challengeSolvers.map((solver) => solver.id),
            activeForMinutes: formatMinutesFromTimestamp(oldestActiveSolverAt),
            minutesSinceLastAttempt: formatMinutesFromTimestamp(lastAttemptAt),
            minutesSinceLastCorrectSubmission: formatMinutesFromTimestamp(lastCorrectSubmissionAt),
        }
    }

    private async buildSolverTask(challenge: ChallengeInfoRecord, options?: LaunchSolverOptions): Promise<string> {
        if (!challenge.entrypoint || challenge.entrypoint.length === 0) {
            throw new Error(`challenge ${challenge.id} is missing entrypoint`)
        }
        if (!Number.isFinite(challenge.flag_count) || challenge.flag_count <= 0) {
            throw new Error(`challenge ${challenge.id} is missing flag_count`)
        }
        const [memoryItems, ideaItems, submissionItems] = await Promise.all([this.listMemory(challenge.id), this.listIdeas(challenge.id), this.listSubmissionLogs(challenge.id)])
        const entrypoint = challenge.entrypoint.map((item) => `- ${item}`).join("\n")
        const hint = challenge.hint_content?.trim() || "无"
        const plannerHandoff = options?.plannerHandoff?.trim()
        return [
            `你正在处理一道CTF赛题。`,
            ``,
            `难度: ${challenge.difficulty}`,
            `关卡: ${challenge.level}`,
            `Flag 总数: ${challenge.flag_count}`,
            `已获得 Flag: ${challenge.flag_got_count}`,
            `剩余 Flag: ${Math.max(challenge.flag_count - challenge.flag_got_count, 0)}`,
            ``,
            ...(plannerHandoff ? [`启动补充说明:`, plannerHandoff, ``] : []),
            `当前 Memory 摘要:`,
            formatSolverMemorySection(memoryItems),
            ``,
            `当前 Ideas 摘要:`,
            formatSolverIdeasSection(ideaItems),
            ``,
            `当前 Submissions 摘要:`,
            formatSolverSubmissionsSection(submissionItems),
            ``,
            `要求:`,
            `- 以当前题目为唯一目标推进,取得 flag 立马调用工具提交`,
            `- 这题可能不止一个 flag；即使提交正确，也要看比赛 API 是否已经完成`,
            `- 优先基于现有提示、入口和题面推进，不要偏题`,
            `- 如果卡住了，可以适当尝试一些可能的攻击手段，但不要偏离题目太远`,
            `- 上面的 memory / ideas 已在 solver 启动时作为初始背景拼接给你；后续 observer 会在这个基础上继续维护 memory / ideas`,
            `- 初始上下文只带了压缩摘要；运行中如果需要整理和回看当前 memory / ideas，按需调用 memory_list / idea_list / idea_search`,
            `- 如需切换路线，优先先看 idea_list / idea_search`,
            `- 在决定攻击方向前，先看当前 Submissions 摘要，优先理解哪些入口、突破口、漏洞链已经验证过，避免无差别重复劳动`,
            `- 如果题目是多 flag 组合、分层内网、或前置突破后还可能横向/纵向扩展，可以沿已有路线继续深挖；但要明确当前目标和现有 writeup 的新增差异`,
            `- 在重复某条路线、上下文变长、或怀疑自己忘了已验证的结论时，先看 memory_list`,
            `- 只有当你拿到了值得当前 solver 跨轮保留的事实、证据、失败边界、题目提示时，才写入 memory`,
            ``,
            `题目标题: ${challenge.title}`,
            ``,
            `目标入口:`,
            entrypoint,
            ``,
            `题目描述:`,
            challenge.description || "无",
            ``,
            `题目提示:`,
            hint,
            `提示：`,
            `- 如果目标入口无法访问，请耐心等待靶场开启后再尝试，靶场没有开启前，请不要做测试！`,
        ].join("\n")
    }

    private async syncChallenge(challengeId: string, source: string): Promise<ChallengeInfoRecord | undefined> {
        const result = await this.listChallenges(source)
        return result.local.find((challenge) => challenge.id === challengeId)
    }
}
