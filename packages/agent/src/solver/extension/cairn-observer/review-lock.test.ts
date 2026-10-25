import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { acquireReviewLock, reviewLockPath } from "./review-lock"

let directory: string
let boardDir: string

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cairn-review-lock-"))
    boardDir = join(directory, "board")
})

afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
})

describe("observer review lease", () => {
    test("only one process may hold the lease", async () => {
        const first = await acquireReviewLock({ boardDir, staleMs: 60_000, waitMs: 0 })
        expect(first).not.toBeNull()

        const second = await acquireReviewLock({ boardDir, staleMs: 60_000, waitMs: 150 })
        expect(second).toBeNull()

        await first!.release()
        const third = await acquireReviewLock({ boardDir, staleMs: 60_000, waitMs: 500 })
        expect(third).not.toBeNull()
        await third!.release()
    })

    test("reclaims a lease whose heartbeat stopped", async () => {
        const lockDir = reviewLockPath(boardDir)
        mkdirSync(dirname(lockDir), { recursive: true })
        mkdirSync(lockDir)
        writeFileSync(
            join(lockDir, "lock-meta.json"),
            JSON.stringify({
                id: "abandoned",
                created_at: new Date(Date.now() - 120_000).toISOString(),
                pid: 1,
            }),
            "utf8",
        )

        const lease = await acquireReviewLock({ boardDir, staleMs: 60_000, waitMs: 1_000 })
        expect(lease).not.toBeNull()
        await lease!.release()
    })

    test("reclaims a lock directory that never got metadata", async () => {
        const lockDir = reviewLockPath(boardDir)
        mkdirSync(lockDir, { recursive: true })
        const old = new Date(Date.now() - 120_000)
        utimesSync(lockDir, old, old)

        const lease = await acquireReviewLock({ boardDir, staleMs: 60_000, waitMs: 1_000 })
        expect(lease).not.toBeNull()
        await lease!.release()
    })

    test("does not remove a lease that was taken over", async () => {
        const lease = await acquireReviewLock({ boardDir, staleMs: 60_000, waitMs: 0 })
        expect(lease).not.toBeNull()

        const metaPath = join(reviewLockPath(boardDir), "lock-meta.json")
        const current = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>
        writeFileSync(metaPath, JSON.stringify({ ...current, id: "someone-else" }), "utf8")

        await lease!.release()
        const after = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>
        expect(after["id"]).toBe("someone-else")
    })
})
