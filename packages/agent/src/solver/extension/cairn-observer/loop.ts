import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
    enqueueObserverReview,
    loadLatestObserverRoundNumber,
    loadRecentObserverRounds,
    persistObserverRound,
    takeNextObserverReview,
    updateObserverState,
    type ObserverRuntimeState,
} from "../challenge-observer/observer-store"
import { formatCairnObserverContext, loadCairnObserverContext } from "./context"
import { acquireReviewLock, type ReviewLock } from "./review-lock"
import { runCairnObserverReview } from "./review"
import type {
    CairnObserverHandle,
    CairnObserverOptions,
    CairnReviewPayload,
    CairnReviewRound,
} from "./types"

const TOOL_ARGS_PREVIEW_CHARS = 160
const TOOL_RESULT_PREVIEW_CHARS = 160
const ASSISTANT_SUMMARY_PREVIEW_CHARS = 220
const REVIEW_LOCK_WAIT_MS = 5_000

function reviewLockStaleMs(options: CairnObserverOptions): number {
    return Math.max(options.timeoutSeconds * 1000 + 30_000, 60_000)
}

export interface CairnObserverLoopDeps {
    /** Test hook; defaults to the real sidecar model session. */
    review?: (
        options: CairnObserverOptions,
        payload: CairnReviewPayload,
        contextText: string,
    ) => Promise<{ applied: boolean; summary?: string }>
}

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function summarizeArgs(value: unknown): string {
    return clipText(safeJsonStringify(value), TOOL_ARGS_PREVIEW_CHARS)
}

function summarizeResult(value: unknown): string {
    if (typeof value === "string") return clipText(value, TOOL_RESULT_PREVIEW_CHARS)
    if (value && typeof value === "object" && "content" in (value as Record<string, unknown>)) {
        const content = (value as { content?: unknown }).content
        if (Array.isArray(content)) {
            const text = content
                .map((block) => {
                    if (!block || typeof block !== "object") return safeJsonStringify(block)
                    if ((block as { type?: unknown }).type === "text") {
                        return typeof (block as { text?: unknown }).text === "string"
                            ? (block as { text: string }).text
                            : ""
                    }
                    return safeJsonStringify(block)
                })
                .join("\n")
            return clipText(text, TOOL_RESULT_PREVIEW_CHARS)
        }
    }
    return clipText(safeJsonStringify(value), TOOL_RESULT_PREVIEW_CHARS)
}

function extractAssistantSummary(
    content: Array<{ type: string; text?: string }> | undefined,
): string {
    const text = (content ?? [])
        .filter((item): item is { type: "text"; text: string } =>
            item.type === "text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("")
    return clipText(text, ASSISTANT_SUMMARY_PREVIEW_CHARS)
}

async function writeAudit(
    stateDir: string,
    entry: Record<string, unknown>,
): Promise<void> {
    try {
        await mkdir(stateDir, { recursive: true })
        await appendFile(
            join(stateDir, "audit.jsonl"),
            `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
        )
    } catch {
        // Audit is best-effort; never affect the task.
    }
}

/**
 * Attaches the Cairn Observer event loop.
 *
 * Differences from the vendored challenge loop:
 * - no `TCH_CHALLENGE_ID` gate and no challenge continuation;
 * - no host-bridge RPC and no hint trigger;
 * - configurable interval/window/caps;
 * - an explicit `flush()` lets the one-shot worker wait for the final review.
 */
export function attachCairnObserverLoop(
    pi: ExtensionAPI,
    options: CairnObserverOptions,
    deps: CairnObserverLoopDeps = {},
): CairnObserverHandle {
    // The shared store resolves paths from the environment; make the injected contract
    // authoritative even if the worker was started without these variables.
    if (!process.env.CAIRN_OBSERVER_STATE_DIR?.trim()) {
        process.env.CAIRN_OBSERVER_STATE_DIR = options.stateDir
    }
    if (!process.env.CAIRN_OBSERVER_BOARD_DIR?.trim()) {
        process.env.CAIRN_OBSERVER_BOARD_DIR = options.boardDir
    }

    const review = deps.review ?? runCairnObserverReview
    const contextReady = loadCairnObserverContext(options.contextPath)
        .then((context) => formatCairnObserverContext(context))
        .catch(() => formatCairnObserverContext(undefined))

    let scheduledReviews = 0
    let finalEnqueued = false
    let flushed = false
    let draining = false
    let drainRequested = false
    let drainPromise: Promise<void> | undefined

    // pi can emit tool events for parallel calls in the same turn. Serialize the
    // load-modify-write so one event cannot overwrite another's tool log.
    let stateWriteQueue: Promise<unknown> = Promise.resolve()
    function updateState<T>(
        mutate: (state: ObserverRuntimeState) => { nextState: ObserverRuntimeState; result: T },
    ): Promise<T> {
        const operation = stateWriteQueue.then(
            () => updateObserverState(mutate),
            () => updateObserverState(mutate),
        )
        stateWriteQueue = operation.then(
            () => undefined,
            () => undefined,
        )
        return operation
    }

    const roundStateReady = updateState((state) => ({
        nextState: { ...state, round: Math.max(state.round, 0) },
        result: undefined,
    })).then(async () => {
        const latestRound = await loadLatestObserverRoundNumber()
        await updateState((state) => ({
            nextState: { ...state, round: Math.max(state.round, latestRound) },
            result: undefined,
        }))
    })

    async function executeReview(payload: CairnReviewPayload): Promise<void> {
        const startedAt = Date.now()
        let lease: ReviewLock | null
        try {
            lease = await acquireReviewLock({
                boardDir: options.boardDir,
                staleMs: reviewLockStaleMs(options),
                waitMs: Math.min(REVIEW_LOCK_WAIT_MS, options.timeoutSeconds * 1000),
                owner: options.stateDir,
            })
        } catch (error) {
            await writeAudit(options.stateDir, {
                event: "review_skipped",
                reason: "board_lock_error",
                error: error instanceof Error ? error.message : String(error),
            })
            return
        }
        if (lease === null) {
            await writeAudit(options.stateDir, {
                event: "review_skipped",
                reason: "board_lock_busy",
            })
            return
        }

        try {
            await writeAudit(options.stateDir, {
                event: "review_started",
                reason: payload.reason,
                rounds: payload.rounds.length,
            })
            try {
                const contextText = await contextReady
                const result = await review(options, payload, contextText)
                await writeAudit(options.stateDir, {
                    event: "review_finished",
                    reason: payload.reason,
                    applied: result.applied,
                    summary_chars: result.summary?.length ?? 0,
                    duration_ms: Date.now() - startedAt,
                })
            } catch (error) {
                await writeAudit(options.stateDir, {
                    event: "review_failed",
                    reason: payload.reason,
                    duration_ms: Date.now() - startedAt,
                    error: error instanceof Error ? error.message : String(error),
                })
                console.error(
                    `[observer] review failed: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
        } finally {
            await lease.release().catch(() => {
                // A failed release is recovered by the stale-lease rule.
            })
        }
    }

    async function drainLoop(): Promise<void> {
        draining = true
        try {
            while (true) {
                const payload = await takeNextObserverReview<CairnReviewPayload>()
                if (!payload) {
                    if (drainRequested) {
                        drainRequested = false
                        continue
                    }
                    return
                }
                await executeReview(payload)
            }
        } finally {
            draining = false
            drainPromise = undefined
        }
    }

    function requestDrain(): Promise<void> {
        if (draining && drainPromise) {
            drainRequested = true
            return drainPromise
        }
        const started = drainLoop()
        drainPromise = started
        return started
    }

    async function enqueueReview(payload: CairnReviewPayload): Promise<void> {
        if (scheduledReviews >= options.maxReviewsPerTask) {
            await writeAudit(options.stateDir, {
                event: "review_skipped",
                reason: payload.reason,
                skipped: "max_reviews_per_task",
            })
            return
        }
        scheduledReviews += 1
        try {
            await enqueueObserverReview(payload)
        } catch (error) {
            scheduledReviews -= 1
            console.error(
                `[observer] enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
        }
        void requestDrain().catch((error) => {
            console.error(
                `[observer] review drain failed: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
    }

    pi.on("tool_execution_start", async (event) => {
        await roundStateReady
        await updateState((state) => ({
            nextState: {
                ...state,
                tool_args_by_call_id: {
                    ...state.tool_args_by_call_id,
                    [event.toolCallId]: summarizeArgs(event.args),
                },
            },
            result: undefined,
        }))
    })

    pi.on("tool_execution_end", async (event) => {
        await roundStateReady
        await updateState((state) => {
            const toolArgsByCallId = { ...state.tool_args_by_call_id }
            const argsSummary = toolArgsByCallId[event.toolCallId] ?? ""
            delete toolArgsByCallId[event.toolCallId]
            return {
                nextState: {
                    ...state,
                    current_round_tool_logs: [
                        ...state.current_round_tool_logs,
                        {
                            tool_name: event.toolName,
                            args_summary: argsSummary,
                            result_summary: summarizeResult(event.result),
                            is_error: event.isError,
                        },
                    ],
                    tool_args_by_call_id: toolArgsByCallId,
                },
                result: undefined,
            }
        })
    })

    pi.on("message_end", async (event) => {
        if (event.message?.role !== "assistant") return

        await roundStateReady
        const assistantSummary = "content" in event.message
            ? extractAssistantSummary(
                  event.message.content as Array<{ type: string; text?: string }> | undefined,
              )
            : ""

        const { roundRecord, periodicDue } = await updateState((state) => {
            const nextRound = state.round + 1
            const record: CairnReviewRound = {
                round: nextRound,
                assistant_summary: assistantSummary,
                tool_logs: state.current_round_tool_logs,
            }
            return {
                nextState: {
                    ...state,
                    round: nextRound,
                    current_round_tool_logs: [],
                    force_review_reason: undefined,
                },
                result: {
                    roundRecord: record,
                    periodicDue: nextRound % options.everyRounds === 0,
                },
            }
        })
        await persistObserverRound(roundRecord)
        if (!periodicDue) return

        const recentRounds = await loadRecentObserverRounds(options.windowRounds)
        if (recentRounds.length === 0) return
        if (
            !recentRounds.some(
                (round) =>
                    round.tool_logs.length > 0 || round.assistant_summary.trim().length > 0,
            )
        ) {
            return
        }
        await enqueueReview({
            reason: "periodic",
            rounds: recentRounds.slice(-options.windowRounds),
        })
    })

    pi.on("agent_end", async () => {
        await roundStateReady
        if (finalEnqueued) return
        const recentRounds = await loadRecentObserverRounds(options.windowRounds)
        if (recentRounds.length === 0) return
        finalEnqueued = true
        await enqueueReview({
            reason: "agent_end",
            rounds: recentRounds.slice(-options.windowRounds),
        })
    })

    async function withTimeout(
        promise: Promise<void>,
        timeoutMs: number,
    ): Promise<boolean> {
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(() => {
                timedOut = true
                resolve()
            }, timeoutMs)
        })
        try {
            await Promise.race([promise, timeout])
        } finally {
            if (timer !== undefined) clearTimeout(timer)
        }
        return timedOut
    }

    return {
        async flush(timeoutMs = options.timeoutSeconds * 1000): Promise<void> {
            if (flushed) return
            flushed = true
            try {
                if (options.maxReviewsPerTask === 0) return

                await roundStateReady
                if (!finalEnqueued) {
                    const recentRounds = await loadRecentObserverRounds(options.windowRounds)
                    if (recentRounds.length > 0) {
                        finalEnqueued = true
                        await enqueueReview({
                            reason: "flush",
                            rounds: recentRounds.slice(-options.windowRounds),
                        })
                    }
                }

                if (!draining && scheduledReviews === 0) return
                const startedAt = Date.now()
                const timedOut = await withTimeout(requestDrain(), Math.max(1, timeoutMs))
                // A timeout never propagates: the worker must still write its result. The
                // unfinished review is abandoned when the process exits.
                const elapsed = Date.now() - startedAt
                if (timedOut) {
                    await writeAudit(options.stateDir, {
                        event: "flush_timeout",
                        timeout_ms: timeoutMs,
                        scheduled_reviews: scheduledReviews,
                    })
                    console.error(
                        `[observer] flush timed out after ${timeoutMs}ms; task continues`,
                    )
                } else {
                    await writeAudit(options.stateDir, {
                        event: "flush_finished",
                        duration_ms: elapsed,
                        scheduled_reviews: scheduledReviews,
                    })
                }
            } catch (error) {
                // The handle contract is that flush never throws: the solver answer is
                // already final and Observer failures must not change it.
                await writeAudit(options.stateDir, {
                    event: "flush_failed",
                    error: error instanceof Error ? error.message : String(error),
                })
                console.error(
                    `[observer] flush failed; task continues: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                )
            }
        },
    }
}
