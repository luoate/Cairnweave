import { mkdir, rename } from "fs/promises"
import { dirname, join } from "path"
import type { ChallengeInfoRecord, ChallengeSubmissionLogRecord } from "./store"
import { listChallengeAttemptLogs, listChallengeSubmissionLogs } from "./store"
import { readMessagesFromSessionDir, readStartup } from "../runtime/helpers"
import { solverSessionDir, solverStartupPath } from "../runtime/types"

export interface UsageTotals {
    input: number
    output: number
    cache_read: number
    cache_write: number
    reasoning: number
    total: number
}

export interface SolverStatsRecord {
    solver_id: string
    challenge_id: string
    prompt_name?: string
    model_name?: string
    started_at?: string
    ended_at?: string
    duration_ms: number
    usage: UsageTotals
}

export interface ChallengeStatsRecord {
    challenge_id: string
    solver_count: number
    attempt_count: number
    submission_count: number
    correct_submission_count: number
    first_attempt_at?: string
    first_correct_submission_at?: string
    solve_duration_ms?: number
    solver_active_duration_ms_total: number
    usage: UsageTotals
    updated_at: string
}

export interface ChallengeStatsOverviewBucket {
    key: string
    label: string
    solver_count: number
    challenge_count: number
    total_flag_count: number
    solved_count: number
    completion_rate: number
    submission_count: number
    correct_submission_count: number
    error_rate: number
    total_duration_ms: number
    total_tokens: number
    quality_score: number
}

export interface ChallengeStatsOverview {
    challenges_total: number
    challenges_solved: number
    flags_total: number
    flags_solved: number
    flag_completion_rate: number
    solver_count: number
    submission_count: number
    correct_submission_count: number
    completion_rate: number
    error_rate: number
    wall_time_ms_total: number
    solver_active_duration_ms_total: number
    total_tokens: number
    quality_score: number
    challenge_series: Array<{
        challenge_id: string
        title: string
        difficulty: string
        solved: boolean
        solve_duration_ms: number
        total_tokens: number
        quality_score: number
    }>
    models: ChallengeStatsOverviewBucket[]
    prompts: ChallengeStatsOverviewBucket[]
    updated_at: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function challengeBaseDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function challengeStatsPath(rootDir: string, challengeId: string): string {
    return join(challengeBaseDir(rootDir, challengeId), "stats.json")
}

function solverStatsPath(rootDir: string, challengeId: string, solverId: string): string {
    return join(challengeBaseDir(rootDir, challengeId), "solver-stats", `${encodeURIComponent(solverId)}.json`)
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

function parseIso(value?: string): number | undefined {
    if (!value) return
    const ts = Date.parse(value)
    return Number.isNaN(ts) ? undefined : ts
}

function formatIso(value?: number): string | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return
    return new Date(value).toISOString()
}

function emptyUsageTotals(): UsageTotals {
    return {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        reasoning: 0,
        total: 0,
    }
}

function addUsage(target: UsageTotals, source: Partial<UsageTotals>): UsageTotals {
    target.input += source.input ?? 0
    target.output += source.output ?? 0
    target.cache_read += source.cache_read ?? 0
    target.cache_write += source.cache_write ?? 0
    target.reasoning += source.reasoning ?? 0
    target.total = target.input + target.output + target.cache_read + target.cache_write + target.reasoning
    return target
}

function extractUsage(value: unknown): Partial<UsageTotals> {
    if (!value || typeof value !== "object") return {}
    const usage = value as Record<string, unknown>
    return {
        input: typeof usage.input === "number" ? usage.input : 0,
        output: typeof usage.output === "number" ? usage.output : 0,
        cache_read: typeof usage.cacheRead === "number" ? usage.cacheRead : 0,
        cache_write: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0,
        reasoning: typeof usage.reasoning === "number" ? usage.reasoning : typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : 0,
    }
}

function extractPromptName(startup: unknown): string | undefined {
    if (!startup || typeof startup !== "object" || !("init" in startup)) return
    const init = (startup as { init?: unknown }).init
    if (!init || typeof init !== "object") return
    const promptName = (init as { promptName?: unknown }).promptName
    return typeof promptName === "string" && promptName.trim() ? promptName.trim() : undefined
}

function extractModelName(startup: unknown): string | undefined {
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

function normalizeModelBucketName(modelName?: string): string | undefined {
    const value = modelName?.trim()
    if (!value) return
    const slashIndex = value.lastIndexOf("/")
    if (slashIndex < 0) return value
    const modelId = value.slice(slashIndex + 1).trim()
    return modelId || value
}

function computeDurationMs(startedAt?: number, endedAt?: number): number {
    if (!startedAt || !endedAt || endedAt < startedAt) return 0
    return endedAt - startedAt
}

function difficultyWeight(difficulty?: string): number {
    if (difficulty === "hard") return 3
    if (difficulty === "medium") return 2
    return 1
}

function computeQualityScore(challenge: ChallengeInfoRecord): number {
    return Math.max(challenge.total_score, 0) * difficultyWeight(challenge.difficulty)
}

export async function refreshChallengeStats(rootDir: string, challengeId: string): Promise<{ stats: ChallengeStatsRecord; solver_stats: SolverStatsRecord[] }> {
    const attempts = await listChallengeAttemptLogs(rootDir, challengeId)
    const submissions = await listChallengeSubmissionLogs(rootDir, challengeId)
    const solverIds = [...new Set(attempts.map((item) => item.solver_id).filter(Boolean))]
    const solverStats: SolverStatsRecord[] = []

    for (const solverId of solverIds) {
        const startup = await readStartup(solverStartupPath(solverId))
        const mainSession = await readMessagesFromSessionDir(solverSessionDir(solverId))
        const usage = emptyUsageTotals()
        let lastTimestamp = typeof mainSession.createdAt === "number" ? mainSession.createdAt : undefined

        for (const message of mainSession.messages) {
            if (!message || typeof message !== "object") continue
            const usagePart = extractUsage("usage" in message ? (message as { usage?: unknown }).usage : undefined)
            addUsage(usage, usagePart)
            const timestamp = "timestamp" in message ? (message as { timestamp?: unknown }).timestamp : undefined
            if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
                lastTimestamp = Math.max(lastTimestamp ?? timestamp, timestamp)
            }
        }

        const startedAt =
            (startup && typeof startup === "object" && "createdAt" in startup && typeof (startup as { createdAt?: unknown }).createdAt === "number"
                ? (startup as { createdAt: number }).createdAt
                : undefined) ?? mainSession.createdAt
        const endedAt = lastTimestamp
        const stat: SolverStatsRecord = {
            solver_id: solverId,
            challenge_id: challengeId,
            prompt_name: extractPromptName(startup) ?? attempts.find((item) => item.solver_id === solverId)?.prompt_name,
            model_name: normalizeModelBucketName(extractModelName(startup)),
            started_at: formatIso(startedAt),
            ended_at: formatIso(endedAt),
            duration_ms: computeDurationMs(startedAt, endedAt),
            usage,
        }
        solverStats.push(stat)
        await atomicWriteJson(solverStatsPath(rootDir, challengeId, solverId), stat)
    }

    const firstAttemptAt = attempts.map((item) => parseIso(item.created_at)).filter((item): item is number => typeof item === "number").sort((a, b) => a - b)[0]
    const firstCorrectSubmissionAt = submissions
        .filter((item) => item.correct)
        .map((item) => parseIso(item.created_at))
        .filter((item): item is number => typeof item === "number")
        .sort((a, b) => a - b)[0]

    const usage = solverStats.reduce((total, item) => addUsage(total, item.usage), emptyUsageTotals())
    const stats: ChallengeStatsRecord = {
        challenge_id: challengeId,
        solver_count: solverStats.length,
        attempt_count: attempts.length,
        submission_count: submissions.length,
        correct_submission_count: submissions.filter((item) => item.correct).length,
        first_attempt_at: formatIso(firstAttemptAt),
        first_correct_submission_at: formatIso(firstCorrectSubmissionAt),
        solve_duration_ms:
            typeof firstAttemptAt === "number" && typeof firstCorrectSubmissionAt === "number" && firstCorrectSubmissionAt >= firstAttemptAt
                ? firstCorrectSubmissionAt - firstAttemptAt
                : undefined,
        solver_active_duration_ms_total: solverStats.reduce((sum, item) => sum + item.duration_ms, 0),
        usage,
        updated_at: nowIso(),
    }

    await atomicWriteJson(challengeStatsPath(rootDir, challengeId), stats)
    return { stats, solver_stats: solverStats.sort((a, b) => a.solver_id.localeCompare(b.solver_id)) }
}

export function buildChallengeStatsOverview(
    entries: Array<{
        challenge: ChallengeInfoRecord
        stats: ChallengeStatsRecord
        solver_stats: SolverStatsRecord[]
        submissions: ChallengeSubmissionLogRecord[]
    }>,
): ChallengeStatsOverview {
    const modelBuckets = new Map<string, ChallengeStatsOverviewBucket>()
    const promptBuckets = new Map<string, ChallengeStatsOverviewBucket>()
    const modelBucketChallengeSeen = new Map<string, Set<string>>()
    const promptBucketChallengeSeen = new Map<string, Set<string>>()
    const modelBucketCorrectFlagSeen = new Map<string, Set<string>>()
    const promptBucketCorrectFlagSeen = new Map<string, Set<string>>()

    function ensureSeenSet(map: Map<string, Set<string>>, key: string): Set<string> {
        const existing = map.get(key)
        if (existing) return existing
        const created = new Set<string>()
        map.set(key, created)
        return created
    }

    for (const entry of entries) {
        const qualityScore = computeQualityScore(entry.challenge)
        const submissionsBySolver = new Map<string, ChallengeSubmissionLogRecord[]>()
        for (const submission of entry.submissions) {
            if (!submission.solver_id) continue
            const items = submissionsBySolver.get(submission.solver_id) ?? []
            items.push(submission)
            submissionsBySolver.set(submission.solver_id, items)
        }

        function applyBucket(
            map: Map<string, ChallengeStatsOverviewBucket>,
            challengeSeenByBucket: Map<string, Set<string>>,
            correctFlagSeenByBucket: Map<string, Set<string>>,
            key: string | undefined,
            label: string | undefined,
            solverStat: SolverStatsRecord,
        ) {
            if (!key || !label) return
            const bucket =
                map.get(key) ??
                {
                    key,
                    label,
                    solver_count: 0,
                    challenge_count: 0,
                    total_flag_count: 0,
                    solved_count: 0,
                    completion_rate: 0,
                    submission_count: 0,
                    correct_submission_count: 0,
                    error_rate: 0,
                    total_duration_ms: 0,
                    total_tokens: 0,
                    quality_score: 0,
                }

            bucket.solver_count += 1
            bucket.total_duration_ms += solverStat.duration_ms
            bucket.total_tokens += solverStat.usage.total

            const challengeSeen = ensureSeenSet(challengeSeenByBucket, key)
            if (!challengeSeen.has(entry.challenge.id)) {
                challengeSeen.add(entry.challenge.id)
                bucket.challenge_count += 1
                bucket.total_flag_count += Math.max(entry.challenge.flag_count, 0)
            }

            const solverSubmissions = submissionsBySolver.get(solverStat.solver_id) ?? []
            bucket.submission_count += solverSubmissions.length
            bucket.correct_submission_count += solverSubmissions.filter((item) => item.correct).length

            const correctFlagSeen = ensureSeenSet(correctFlagSeenByBucket, key)
            const challengeFlagCount = Math.max(entry.challenge.flag_count, 1)
            const qualityPerFlag = qualityScore / challengeFlagCount
            for (const submission of solverSubmissions) {
                if (!submission.correct) continue
                const uniqueFlagKey = `${entry.challenge.id}::${submission.flag}`
                if (correctFlagSeen.has(uniqueFlagKey)) continue
                correctFlagSeen.add(uniqueFlagKey)
                bucket.solved_count += 1
                bucket.quality_score += qualityPerFlag
            }

            map.set(key, bucket)
        }

        for (const solverStat of entry.solver_stats) {
            const modelBucketName = normalizeModelBucketName(solverStat.model_name)
            applyBucket(modelBuckets, modelBucketChallengeSeen, modelBucketCorrectFlagSeen, modelBucketName, modelBucketName, solverStat)
            applyBucket(promptBuckets, promptBucketChallengeSeen, promptBucketCorrectFlagSeen, solverStat.prompt_name, solverStat.prompt_name, solverStat)
        }
    }

    function finalizeBuckets(map: Map<string, ChallengeStatsOverviewBucket>): ChallengeStatsOverviewBucket[] {
        return [...map.values()]
            .map((bucket) => ({
                key: bucket.key,
                label: bucket.label,
                solver_count: bucket.solver_count,
                challenge_count: bucket.challenge_count,
                total_flag_count: bucket.total_flag_count,
                solved_count: bucket.solved_count,
                completion_rate: bucket.total_flag_count > 0 ? bucket.solved_count / bucket.total_flag_count : 0,
                submission_count: bucket.submission_count,
                correct_submission_count: bucket.correct_submission_count,
                error_rate: bucket.submission_count > 0 ? (bucket.submission_count - bucket.correct_submission_count) / bucket.submission_count : 0,
                total_duration_ms: bucket.total_duration_ms,
                total_tokens: bucket.total_tokens,
                quality_score: bucket.quality_score,
            }))
            .sort((a, b) => b.quality_score - a.quality_score || b.total_tokens - a.total_tokens || a.label.localeCompare(b.label))
    }

    const challengesTotal = entries.length
    const challengesSolved = entries.filter((entry) => entry.challenge.flag_count > 0 && entry.challenge.flag_got_count >= entry.challenge.flag_count).length
    const flagsTotal = entries.reduce((sum, entry) => sum + Math.max(entry.challenge.flag_count, 0), 0)
    const flagsSolved = entries.reduce(
        (sum, entry) => sum + Math.min(Math.max(entry.challenge.flag_got_count, 0), Math.max(entry.challenge.flag_count, 0)),
        0,
    )
    const submissionCount = entries.reduce((sum, entry) => sum + entry.stats.submission_count, 0)
    const correctSubmissionCount = entries.reduce((sum, entry) => sum + entry.stats.correct_submission_count, 0)

    return {
        challenges_total: challengesTotal,
        challenges_solved: challengesSolved,
        flags_total: flagsTotal,
        flags_solved: flagsSolved,
        flag_completion_rate: flagsTotal > 0 ? flagsSolved / flagsTotal : 0,
        solver_count: entries.reduce((sum, entry) => sum + entry.stats.solver_count, 0),
        submission_count: submissionCount,
        correct_submission_count: correctSubmissionCount,
        completion_rate: challengesTotal > 0 ? challengesSolved / challengesTotal : 0,
        error_rate: submissionCount > 0 ? (submissionCount - correctSubmissionCount) / submissionCount : 0,
        wall_time_ms_total: entries.reduce((sum, entry) => sum + (entry.stats.solve_duration_ms ?? 0), 0),
        solver_active_duration_ms_total: entries.reduce((sum, entry) => sum + entry.stats.solver_active_duration_ms_total, 0),
        total_tokens: entries.reduce((sum, entry) => sum + entry.stats.usage.total, 0),
        quality_score: entries.reduce((sum, entry) => sum + (entry.stats.correct_submission_count > 0 ? computeQualityScore(entry.challenge) : 0), 0),
        challenge_series: entries
            .map((entry) => ({
                challenge_id: entry.challenge.id,
                title: entry.challenge.title,
                difficulty: entry.challenge.difficulty,
                solved: entry.stats.correct_submission_count > 0,
                solve_duration_ms: entry.stats.solve_duration_ms ?? 0,
                total_tokens: entry.stats.usage.total,
                quality_score: entry.stats.correct_submission_count > 0 ? computeQualityScore(entry.challenge) : 0,
            }))
            .sort((a, b) => a.challenge_id.localeCompare(b.challenge_id)),
        models: finalizeBuckets(modelBuckets),
        prompts: finalizeBuckets(promptBuckets),
        updated_at: nowIso(),
    }
}
