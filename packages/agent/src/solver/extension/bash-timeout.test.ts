import { describe, expect, test } from "bun:test"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

import {
    DEFAULT_BASH_TIMEOUT_SECONDS,
    MIN_TIMEOUT_SECONDS,
    SOFT_DEADLINE_TIMEOUT_SECONDS,
    bashTimeoutExtension,
    formatBudgetNotice,
    readCommandDeadlineFromEnv,
    resolveCommandTimeout,
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
    test("reads the ceiling, the start time and both deadlines", () => {
        expect(
            readCommandDeadlineFromEnv({
                CAIRN_BASH_TIMEOUT_SECONDS: "120",
                CAIRN_TASK_STARTED_MS: "1794000000000",
                CAIRN_TASK_SOFT_DEADLINE_MS: "1794000480000",
                CAIRN_TASK_HARD_DEADLINE_MS: "1794000600000",
            } as NodeJS.ProcessEnv),
        ).toEqual({
            ceilingSeconds: 120,
            startedMs: 1794000000000,
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

describe("command timeout source", () => {
    test("names which limit produced the value", () => {
        const at = (over: Partial<Parameters<typeof resolveCommandTimeout>[0]>) =>
            resolveCommandTimeout({ ceilingSeconds: 150, now: 0, ...over }).source
        expect(at({})).toBe("ceiling")
        expect(at({ requested: 30 })).toBe("model")
        // A model value above the ceiling is capped, so the ceiling is the source.
        expect(at({ requested: 900 })).toBe("ceiling")
        // 120 s until the soft deadline is under the 150 s ceiling, so it is what applies.
        expect(at({ softDeadlineMs: 120_000 })).toBe("soft_deadline")
        expect(at({ softDeadlineMs: -1 })).toBe("wrap_up")
        expect(at({ hardDeadlineMs: 60_000 })).toBe("hard_deadline")
    })

    test("reports the same number the wrapper returns", () => {
        const input = { ceilingSeconds: 150, softDeadlineMs: 120_000, now: 0 }
        expect(resolveCommandTimeout(input).seconds).toBe(resolveCommandTimeoutSeconds(input))
    })
})

describe("budget notice", () => {
    const base = {
        limitSeconds: 126,
        source: "soft_deadline" as const,
        defaultCeilingSeconds: 150,
    }

    test("states elapsed time, time left and the limit with its cause", () => {
        const text = formatBudgetNotice({
            ...base,
            elapsedSeconds: 349,
            untilSoftSeconds: 131,
            untilHardSeconds: 251,
        })
        expect(text).toContain("[时间]")
        expect(text).toContain("已用 349s")
        expect(text).toContain("距软截止 131s")
        expect(text).toContain("硬截止 251s")
        expect(text).toContain("本条命令上限 126s")
        // The whole point: the model must not read a shortened limit as "this command is slow".
        expect(text).toContain("默认 150s")
    })

    test("explains a timeout as a budget cut, not a slow command", () => {
        const text = formatBudgetNotice({ ...base, untilSoftSeconds: 5, timedOut: true })
        expect(text).toContain("不是命令本身慢")
        expect(text).toContain("不要原样重跑")
    })

    test("a timeout at the task's own ceiling is not blamed on the deadline", () => {
        const text = formatBudgetNotice({
            limitSeconds: 150,
            source: "ceiling",
            defaultCeilingSeconds: 150,
            timedOut: true,
        })
        expect(text).toContain("用满了自己的上限")
        expect(text).not.toContain("不是命令本身慢")
    })

    test("warns to wrap up inside the last minute", () => {
        expect(formatBudgetNotice({ ...base, untilSoftSeconds: 45 })).toContain("不足一分钟")
        expect(formatBudgetNotice({ ...base, untilSoftSeconds: 300 })).not.toContain("不足一分钟")
    })

    test("names the wrap-up and hard-deadline caps", () => {
        expect(
            formatBudgetNotice({ ...base, limitSeconds: 30, source: "wrap_up" }),
        ).toContain("收尾期固定 30s")
        expect(
            formatBudgetNotice({ ...base, source: "hard_deadline" }),
        ).toContain("硬截止")
        expect(formatBudgetNotice({ ...base, limitSeconds: 20, source: "model" })).toContain(
            "按你传入的 timeout",
        )
    })

    test("still says something when the task exported no deadlines", () => {
        const text = formatBudgetNotice({ ...base, limitSeconds: 150, source: "ceiling" })
        expect(text).toBe("[时间] 本条命令上限 150s（本任务默认上限）")
    })
})

describe("bash timeout extension: reporting the budget back", () => {
    function full(
        env: Parameters<typeof bashTimeoutExtension>[0] = {},
        now = 0,
    ): { call: Handler; result: Handler; sent: string[] } {
        const registered = new Map<string, Handler>()
        const sent: string[] = []
        bashTimeoutExtension({ ...env, now: () => now, sendMessage: (t) => sent.push(t) })({
            on(name: string, handler: Handler) {
                registered.set(name, handler)
            },
        } as unknown as ExtensionAPI)
        return { call: registered.get("tool_call")!, result: registered.get("tool_result")!, sent }
    }

    const envelope = {
        ceilingSeconds: 150,
        startedMs: 0,
        softDeadlineMs: 480_000,
        hardDeadlineMs: 600_000,
    }

    test("appends the budget to a successful bash result", () => {
        const { call, result } = full(envelope, 200_000)
        call({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "ls" } })
        const out = result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "t1",
            input: { command: "ls" },
            content: [{ type: "text", text: "a\nb" }],
            isError: false,
        }) as { content: { type: string; text: string }[] }
        expect(out.content).toHaveLength(1)
        expect(out.content[0].text.startsWith("a\nb\n\n[时间]")).toBe(true)
        expect(out.content[0].text).toContain("已用 200s")
        expect(out.content[0].text).toContain("距软截止 280s")
        expect(out.content[0].text).toContain("本条命令上限 150s")
    })

    test("reports the budget the call actually received, not the ceiling", () => {
        const { call, result } = full({ ...envelope, softDeadlineMs: 221_000 }, 207_000)
        const event = { type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "x" } }
        call(event)
        expect(event.input.timeout).toBe(9)
        const out = result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "t1",
            content: [{ type: "text", text: "out" }],
            isError: false,
        }) as { content: { text: string }[] }
        expect(out.content[0].text).toContain("本条命令上限 9s")
        expect(out.content[0].text).toContain("按剩余时间收紧")
    })

    test("a failed result cannot be edited, so the notice goes out as a message", () => {
        const { call, result, sent } = full({ ...envelope, softDeadlineMs: 221_000 }, 207_000)
        call({ type: "tool_call", toolName: "bash", toolCallId: "t1", input: { command: "x" } })
        const returned = result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "t1",
            content: [{ type: "text", text: "Command timed out after 9 seconds" }],
            isError: true,
        })
        expect(returned).toBeUndefined()
        expect(sent).toHaveLength(1)
        expect(sent[0]).toContain("不是命令本身慢")
        expect(sent[0]).toContain("距软截止 14s")
    })

    test("a plain failure mid-task stays silent: the model already has the clock", () => {
        const { result, sent } = full(envelope, 100_000)
        const returned = result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "unknown",
            content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
            isError: true,
        })
        expect(returned).toBeUndefined()
        expect(sent).toHaveLength(0)
    })

    test("a failure late in the task does get the clock", () => {
        // 400 s in: 80 s left before the soft deadline.
        const { result, sent } = full(envelope, 400_000)
        result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "unknown",
            content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
            isError: true,
        })
        expect(sent).toHaveLength(1)
        expect(sent[0]).toContain("距软截止 80s")
        expect(sent[0]).not.toContain("不是命令本身慢")
    })

    test("leaves other tools alone in both directions", () => {
        const { result, sent } = full(envelope, 0)
        expect(
            result({
                type: "tool_result",
                toolName: "read",
                toolCallId: "t1",
                content: [{ type: "text", text: "x" }],
                isError: false,
            }),
        ).toBeUndefined()
        expect(sent).toHaveLength(0)
    })

    test("adds a text block when the result had none", () => {
        const { result } = full(envelope, 0)
        const out = result({
            type: "tool_result",
            toolName: "bash",
            toolCallId: "unknown",
            content: [],
            isError: false,
        }) as { content: { type: string; text: string }[] }
        expect(out.content).toHaveLength(1)
        expect(out.content[0].text.startsWith("[时间]")).toBe(true)
    })
})
