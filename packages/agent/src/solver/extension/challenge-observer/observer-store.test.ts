import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { takeNextObserverReview } from "./observer-store"

let directory: string
let queueDir: string
const ORIGINAL_STATE_DIR = process.env.CAIRN_OBSERVER_STATE_DIR

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cairn-observer-store-"))
    queueDir = join(directory, "review-queue")
    mkdirSync(queueDir, { recursive: true })
    process.env.CAIRN_OBSERVER_STATE_DIR = directory
})

afterEach(() => {
    if (ORIGINAL_STATE_DIR === undefined) delete process.env.CAIRN_OBSERVER_STATE_DIR
    else process.env.CAIRN_OBSERVER_STATE_DIR = ORIGINAL_STATE_DIR
    rmSync(directory, { recursive: true, force: true })
})

describe("observer review queue", () => {
    test("skips and removes a malformed entry instead of wedging later reviews", async () => {
        const malformed = join(queueDir, "000001-bad.json")
        const valid = join(queueDir, "000002-good.json")
        writeFileSync(malformed, "{not json", "utf8")
        writeFileSync(valid, JSON.stringify({ reason: "periodic", rounds: [] }), "utf8")

        expect(
            await takeNextObserverReview<{ reason: string; rounds: unknown[] }>(),
        ).toEqual({ reason: "periodic", rounds: [] })
        expect(existsSync(malformed)).toBe(false)
        expect(existsSync(valid)).toBe(false)
        expect(await takeNextObserverReview()).toBeUndefined()
    })
})
