import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readCairnObserverOptionsFromEnv } from "./context"

const KEYS = [
    "CAIRN_OBSERVER_ENABLED",
    "CAIRN_OBSERVER_CONTEXT_PATH",
    "CAIRN_OBSERVER_BOARD_DIR",
    "CAIRN_OBSERVER_STATE_DIR",
    "CAIRN_OBSERVER_MODEL",
    "CAIRN_OBSERVER_EVERY_ROUNDS",
    "CAIRN_OBSERVER_WINDOW_ROUNDS",
    "CAIRN_OBSERVER_TIMEOUT_SECONDS",
    "CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK",
] as const

const ORIGINAL = new Map<string, string | undefined>()

beforeEach(() => {
    for (const key of KEYS) {
        ORIGINAL.set(key, process.env[key])
        delete process.env[key]
    }
})

afterEach(() => {
    for (const key of KEYS) {
        const value = ORIGINAL.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
})

function setPaths(): void {
    process.env["CAIRN_OBSERVER_CONTEXT_PATH"] = "/task/context.json"
    process.env["CAIRN_OBSERVER_BOARD_DIR"] = "/project/.cairn/board"
    process.env["CAIRN_OBSERVER_STATE_DIR"] = "/task/observer"
}

describe("Cairn observer environment contract", () => {
    test("enables only on the exact value 1", () => {
        setPaths()
        expect(readCairnObserverOptionsFromEnv()).toBeUndefined()

        process.env["CAIRN_OBSERVER_ENABLED"] = " 1 "
        expect(readCairnObserverOptionsFromEnv()).toBeUndefined()

        process.env["CAIRN_OBSERVER_ENABLED"] = "true"
        expect(readCairnObserverOptionsFromEnv()).toBeUndefined()
    })

    test("disables when a required path is missing", () => {
        process.env["CAIRN_OBSERVER_ENABLED"] = "1"
        process.env["CAIRN_OBSERVER_CONTEXT_PATH"] = "/task/context.json"
        process.env["CAIRN_OBSERVER_BOARD_DIR"] = "/project/.cairn/board"
        expect(readCairnObserverOptionsFromEnv()).toBeUndefined()
    })

    test("reads paths, optional model, and numeric knobs", () => {
        process.env["CAIRN_OBSERVER_ENABLED"] = "1"
        setPaths()
        process.env["CAIRN_OBSERVER_MODEL"] = "cheap-review"
        process.env["CAIRN_OBSERVER_EVERY_ROUNDS"] = "5"
        process.env["CAIRN_OBSERVER_WINDOW_ROUNDS"] = "7"
        process.env["CAIRN_OBSERVER_TIMEOUT_SECONDS"] = "20"
        process.env["CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK"] = "0"

        expect(readCairnObserverOptionsFromEnv()).toEqual({
            contextPath: "/task/context.json",
            boardDir: "/project/.cairn/board",
            stateDir: "/task/observer",
            model: "cheap-review",
            everyRounds: 5,
            windowRounds: 7,
            timeoutSeconds: 20,
            maxReviewsPerTask: 0,
        })
    })

    test("falls back to defaults for malformed numeric values", () => {
        process.env["CAIRN_OBSERVER_ENABLED"] = "1"
        setPaths()
        process.env["CAIRN_OBSERVER_EVERY_ROUNDS"] = "0"
        process.env["CAIRN_OBSERVER_WINDOW_ROUNDS"] = "nope"
        process.env["CAIRN_OBSERVER_TIMEOUT_SECONDS"] = "1.5"
        process.env["CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK"] = "-1"

        expect(readCairnObserverOptionsFromEnv()).toEqual({
            contextPath: "/task/context.json",
            boardDir: "/project/.cairn/board",
            stateDir: "/task/observer",
            everyRounds: 4,
            windowRounds: 8,
            timeoutSeconds: 60,
            maxReviewsPerTask: 8,
        })
    })
})
