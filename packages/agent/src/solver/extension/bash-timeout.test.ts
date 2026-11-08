import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import {
    DEFAULT_BASH_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    SOFT_DEADLINE_TIMEOUT_SECONDS,
    bashTimeoutExtension,
    readCommandDeadlineFromEnv,
    resolveCommandTimeoutSeconds,
} from "./bash-timeout"

type Handler = (event: any) => unknown

function handlers(env: Parameters<typeof bashTimeoutExtension>[0] = {}, now = 0): Map<string, Handler> {
    const registered = new Map<string, Handler>()
    bashTimeoutExtension({ ...env, now: () => now })({
        on(name: string, handler: Handler) {
            registered.set(name, handler)
        },
    } as unknown as ExtensionAPI)
    return registered
}

describe("command timeout resolution", () => {
    test("always returns a positive timeout, even with no envelope at all", () => {
        expect(resolveCommandTimeoutSeconds({ ceilingSeconds: 150, now: 0 })).toBe(150)
        expect(resolveCommandTimeoutSeconds({ ceilingSeconds: 60, now: 0 })).toBe(60)
    })

    test("a shorter model value wins; a longer one is capped by the ceiling", () => {
        expect(resolveCommandTimeoutSeconds({ requested: 30, ceilingSeconds: 150, now: 0 })).toBe(30)
        expect(resolveCommandTimeoutSeconds({ requested: 600, ceilingSeconds: 150, now: 0 })).toBe(150)
    })

    test("nonsense model values are ignored", () => {
        for (const requested of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "30"]) {
            expect(resolveCommandTimeoutSeconds({ requested, ceilingSeconds: 150, now: 0 })).toBe(150)
        }
    })

    test("a command never runs past the soft deadline", () => {
        // 120 s until the soft deadline: 120 - 5 margin = 115 s, still under the ceiling.
        expect(
            resolveCommandTimeoutSeconds({ ceilingSeconds: 150, softDeadlineMs: 120_000, now: 0 }),
        ).toBe(115)
        // 40 s left: the command is cut to 35 s so the wrap-up moment is not missed.
        expect(
            resolveCommandTimeoutSeconds({ ceilingSeconds: 150, softDeadlineMs: 40_000, now: 0 }),
        ).toBe(35)
        // A finish line already passed still yields the floor, never zero.
        expect(
            resolveCommandTimeoutSeconds({ ceilingSeconds: 150, softDeadlineMs: 3_000, now: 0 }),
        ).toBe(MIN_TIMEOUT_SECONDS)
    })

    test("after the soft deadline commands drop to the wrap-up cap", () => {
        expect(
            resolveCommandTimeoutSeconds({ ceilingSeconds: 150, softDeadlineMs: -1, now: 0 }),
        ).toBe(SOFT_DEADLINE_TIMEOUT_SECONDS)
        expect(
            resolveCommandTimeoutSeconds({ requested: 5, ceilingSeconds: 150, softDeadlineMs: -1, now: 0 }),
        ).toBe(5)
    })

    test("the hard deadline always wins, keeping room for the result file", () => {
        expect(
            resolveCommandTimeoutSeconds({
                ceilingSeconds: 150,
                softDeadlineMs: 600_000,
                hardDeadlineMs: 60_000,
                now: 0,
            }),
        ).toBe(50)
        expect(
            resolveCommandTimeoutSeconds({ ceilingSeconds: 150, hardDeadlineMs: 5_000, now: 0 }),
        ).toBe(MIN_TIMEOUT_SECONDS)
    })

    test("a 60 s conclude with a 48 s soft deadline gets short commands throughout", () => {
        const deadline = { ceilingSeconds: 45, softDeadlineMs: 48_000, hardDeadlineMs: 60_000 }
        expect(resolveCommandTimeoutSeconds({ ...deadline, now: 0 })).toBe(43)
        expect(resolveCommandTimeoutSeconds({ ...deadline, now: 30_000 })).toBe(13)
        // Past the soft deadline the wrap-up cap applies, but the hard deadline with only
        // seconds left is tighter still — one short command, then the result has to be written.
        expect(resolveCommandTimeoutSeconds({ ...deadline, now: 50_000 })).toBe(MIN_TIMEOUT_SECONDS)
    })

    test("a long task past its soft deadline gets the 30 s wrap-up cap", () => {
        // bootstrap/explore: soft 480 s, hard 600 s. At 500 s there are 100 s left, so the
        // 30 s wrap-up cap is what applies.
        expect(
            resolveCommandTimeoutSeconds({
                ceilingSeconds: 150,
                softDeadlineMs: 480_000,
                hardDeadlineMs: 600_000,
                now: 500_000,
            }),
        ).toBe(SOFT_DEADLINE_TIMEOUT_SECONDS)
    })
})

describe("command deadline environment", () => {
    test("reads the ceiling and both deadlines", () => {
        expect(
            readCommandDeadlineFromEnv({
                CAIRN_BASH_TIMEOUT_SECONDS: "120",
                CAIRN_TASK_SOFT_DEADLINE_MS: "1794000480000",
                CAIRN_TASK_HARD_DEADLINE_MS: "1794000600000",
            } as NodeJS.ProcessEnv),
        ).toEqual({
            ceilingSeconds: 120,
            softDeadlineMs: 1794000480000,
            hardDeadlineMs: 1794000600000,
        })
    })

    test("ignores missing or malformed values", () => {
        expect(readCommandDeadlineFromEnv({} as NodeJS.ProcessEnv)).toEqual({})
        expect(
            readCommandDeadlineFromEnv({
                CAIRN_BASH_TIMEOUT_SECONDS: "abc",
                CAIRN_TASK_SOFT_DEADLINE_MS: "-1",
                CAIRN_TASK_HARD_DEADLINE_MS: "0",
            } as NodeJS.ProcessEnv),
        ).toEqual({})
    })

    test("defaults to 150 s when the task exported no ceiling", () => {
        expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(150)
    })
})

describe("bash timeout extension", () => {
    test("writes a timeout into a bash call the model left unbounded", () => {
        const handler = handlers({ ceilingSeconds: 90 }).get("tool_call")!
        const event = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } }
        expect(handler(event)).toBeUndefined()
        expect(event.input.timeout).toBe(90)
    })

    test("keeps the model's shorter timeout", () => {
        const handler = handlers({ ceilingSeconds: 150 }).get("tool_call")!
        const event = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls", timeout: 20 } }
        handler(event)
        expect(event.input.timeout).toBe(20)
    })

    test("caps a long command by the remaining task time", () => {
        const handler = handlers({ ceilingSeconds: 150, softDeadlineMs: 40_000 }).get("tool_call")!
        const event = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "find /" } }
        handler(event)
        // The extension is built with `now` fixed at 0 in these tests.
        expect(event.input.timeout).toBe(35)
    })

    test("leaves other tools alone", () => {
        const handler = handlers({ ceilingSeconds: 150 }).get("tool_call")!
        const event = { type: "tool_call", toolName: "read", toolCallId: "t1", input: { path: "a" } }
        handler(event)
        expect(event.input).toEqual({ path: "a" })
    })

    test("never throws on a malformed event", () => {
        const handler = handlers({ ceilingSeconds: 150 }).get("tool_call")!
        expect(handler({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: null })).toBeUndefined()
        expect(handler({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: [] })).toBeUndefined()
    })

    test("reads the task envelope from the environment on every call", () => {
        const env = {} as NodeJS.ProcessEnv
        env["CAIRN_BASH_TIMEOUT_SECONDS"] = "77"
        const handler = handlers(
            { readEnv: () => readCommandDeadlineFromEnv(env) },
        ).get("tool_call")!
        const first = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } }
        handler(first)
        expect(first.input.timeout).toBe(77)

        env["CAIRN_BASH_TIMEOUT_SECONDS"] = "33"
        const second = { type: "tool_call", toolName: "bash", toolCallId: "t2", input: { command: "ls" } }
        handler(second)
        expect(second.input.timeout).toBe(33)
    })
})
