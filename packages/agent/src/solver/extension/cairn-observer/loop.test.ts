import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { attachCairnObserverLoop } from "./loop"
import type { CairnObserverOptions, CairnReviewPayload } from "./types"

type Handler = (event: any, ctx?: any) => Promise<void>

let directory: string
let stateDir: string

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cairn-observer-loop-"))
    stateDir = join(directory, "observer")
    process.env["CAIRN_OBSERVER_STATE_DIR"] = stateDir
    process.env["CAIRN_OBSERVER_BOARD_DIR"] = join(directory, "board")
})

afterEach(() => {
    delete process.env["CAIRN_OBSERVER_STATE_DIR"]
    delete process.env["CAIRN_OBSERVER_BOARD_DIR"]
    rmSync(directory, { recursive: true, force: true })
})

function options(overrides: Partial<CairnObserverOptions> = {}): CairnObserverOptions {
    return {
        contextPath: join(directory, "observer-context.json"),
        boardDir: join(directory, "board"),
        stateDir,
        everyRounds: 1,
        windowRounds: 8,
        timeoutSeconds: 60,
        maxReviewsPerTask: 8,
        ...overrides,
    }
}

function fakePi() {
    const handlers = new Map<string, Handler>()
    const pi = {
        on(name: string, handler: Handler) {
            handlers.set(name, handler)
            return undefined
        },
    } as unknown as ExtensionAPI
    return { pi, handlers }
}

function messageEnd(text: string): { message: { role: "assistant"; content: { type: "text"; text: string }[] } } {
    return {
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
        },
    }
}

describe("cairn observer loop", () => {
    test("persists rounds, reviews periodically, and flushes the final round", async () => {
        const { pi, handlers } = fakePi()
        const reviews: CairnReviewPayload[] = []
        const handle = attachCairnObserverLoop(pi, options({ everyRounds: 2 }), {
            async review(_options, payload) {
                reviews.push(payload)
                return { applied: true, summary: "no change" }
            },
        })

        await handlers.get("message_end")!(messageEnd("round one"))
        await handlers.get("message_end")!(messageEnd("round two"))
        await handle.flush(1_000)

        expect(reviews.length).toBe(2)
        expect(reviews[0]!.reason).toBe("periodic")
        expect(reviews[0]!.rounds.map((round) => round.round)).toEqual([1, 2])
        expect(reviews[1]!.reason).toBe("flush")
        expect(reviews[1]!.rounds.map((round) => round.round)).toEqual([1, 2])

        const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { event: string })
        expect(audit.filter((entry) => entry.event === "review_started")).toHaveLength(2)
        expect(audit.some((entry) => entry.event === "flush_finished")).toBe(true)
    })

    test("serializes state updates for parallel tool calls", async () => {
        const { pi, handlers } = fakePi()
        attachCairnObserverLoop(pi, options({ everyRounds: 99 }), {
            async review() {
                return { applied: false }
            },
        })
        const start = handlers.get("tool_execution_start")!
        const end = handlers.get("tool_execution_end")!

        await Promise.all([
            start({ toolCallId: "call-a", args: { command: "a" } }),
            start({ toolCallId: "call-b", args: { command: "b" } }),
        ])
        await Promise.all([
            end({ toolCallId: "call-a", toolName: "bash", result: "result-a", isError: false }),
            end({ toolCallId: "call-b", toolName: "bash", result: "result-b", isError: false }),
        ])

        const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as {
            current_round_tool_logs: { result_summary: string }[]
        }
        expect(
            state.current_round_tool_logs.map((log) => log.result_summary).sort(),
        ).toEqual(["result-a", "result-b"])
    })

    test("honors max_reviews_per_task", async () => {
        const { pi, handlers } = fakePi()
        let calls = 0
        const handle = attachCairnObserverLoop(
            pi,
            options({ everyRounds: 1, maxReviewsPerTask: 2 }),
            {
                async review() {
                    calls += 1
                    return { applied: false }
                },
            },
        )

        for (let round = 1; round <= 5; round += 1) {
            await handlers.get("message_end")!(messageEnd(`round ${round}`))
        }
        await handlers.get("agent_end")!({})
        await handle.flush(1_000)

        expect(calls).toBe(2)
        const audit = readFileSync(join(stateDir, "audit.jsonl"), "utf8")
        expect(audit).toContain("max_reviews_per_task")
    })

    test("flush times out without throwing when a review hangs", async () => {
        const { pi, handlers } = fakePi()
        const handle = attachCairnObserverLoop(pi, options({ everyRounds: 1 }), {
            async review() {
                await new Promise(() => {
                    // Never resolves; flush must abandon it.
                })
                return { applied: false }
            },
        })

        await handlers.get("message_end")!(messageEnd("stuck"))
        const startedAt = Date.now()
        await handle.flush(100)
        expect(Date.now() - startedAt).toBeLessThan(1_000)

        const auditPath = join(stateDir, "audit.jsonl")
        expect(existsSync(auditPath)).toBe(true)
        expect(readFileSync(auditPath, "utf8")).toContain("flush_timeout")
    })

    test("flush never throws when the observer state directory is unusable", async () => {
        const blocked = join(directory, "blocked")
        writeFileSync(blocked, "not a directory", "utf8")
        const { pi } = fakePi()
        const handle = attachCairnObserverLoop(
            pi,
            options({ stateDir: join(blocked, "observer") }),
            {
                async review() {
                    return { applied: false }
                },
            },
        )

        await expect(handle.flush(50)).resolves.toBeUndefined()
    })
})
