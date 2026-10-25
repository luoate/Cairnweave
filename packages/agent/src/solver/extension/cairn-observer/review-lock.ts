import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * Project-level lease that serializes Observer reviews across task processes.
 *
 * The board is shared by every task of a project. Tool writes already take per-entry
 * locks, but a review is a read-decide-write cycle across several tool calls: two reviews
 * that start from the same snapshot can undo each other. The lease makes the whole review
 * exclusive. Waiting is bounded so a task's `flush()` is never held hostage; a busy lease
 * is reported and the review is skipped.
 */

const DEFAULT_WAIT_MS = 5_000
const RETRY_MS = 100

export interface ReviewLockOptions {
    /** Durable project-level board directory (`CAIRN_OBSERVER_BOARD_DIR`). */
    boardDir: string
    /** A lease with no heartbeat for this long is considered abandoned. */
    staleMs: number
    /** Give up and return null after this long. */
    waitMs?: number
    /** Diagnostics only; the lease identity is a random UUID. */
    owner?: string
}

export interface ReviewLock {
    release(): Promise<void>
}

interface LockMeta {
    id: string
    created_at: string
    pid: number
    owner?: string
}

export function reviewLockPath(boardDir: string): string {
    return join(boardDir, "locks", "review.lock")
}

export async function acquireReviewLock(
    options: ReviewLockOptions,
): Promise<ReviewLock | null> {
    const lockDir = reviewLockPath(options.boardDir)
    const metaPath = join(lockDir, "lock-meta.json")
    const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
    const deadline = Date.now() + Math.max(0, waitMs)

    await mkdir(dirname(lockDir), { recursive: true })

    while (true) {
        const id = crypto.randomUUID()
        try {
            await mkdir(lockDir)
            await writeMeta(metaPath, {
                id,
                created_at: new Date().toISOString(),
                pid: process.pid,
                ...(options.owner === undefined ? {} : { owner: options.owner }),
            })
            let active = true
            const heartbeatMs = Math.max(1_000, Math.floor(options.staleMs / 3))
            const timer = setInterval(() => {
                void refresh(metaPath, id).catch(() => {
                    // A failed heartbeat merely makes the lease stale sooner.
                })
            }, heartbeatMs)
            if (typeof timer.unref === "function") timer.unref()
            return {
                async release(): Promise<void> {
                    if (!active) return
                    active = false
                    clearInterval(timer)
                    await releaseIfOwner(lockDir, metaPath, id)
                },
            }
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error
        }

        const meta = await readMeta(metaPath)
        const age = await leaseAge(meta, lockDir)
        if (age !== null && age > options.staleMs) {
            await rm(lockDir, { recursive: true, force: true }).catch(() => {})
            continue
        }
        if (Date.now() >= deadline) return null
        await Bun.sleep(RETRY_MS)
    }
}

async function writeMeta(path: string, meta: LockMeta): Promise<void> {
    await writeFile(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8")
}

async function readMeta(path: string): Promise<LockMeta | null> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockMeta>
        if (typeof parsed.id !== "string" || typeof parsed.created_at !== "string") {
            return null
        }
        return {
            id: parsed.id,
            created_at: parsed.created_at,
            pid: typeof parsed.pid === "number" ? parsed.pid : 0,
            ...(typeof parsed.owner === "string" ? { owner: parsed.owner } : {}),
        }
    } catch {
        return null
    }
}

/** Falls back to the directory mtime when the metadata was never written. */
async function leaseAge(meta: LockMeta | null, lockDir: string): Promise<number | null> {
    if (meta !== null) {
        const createdAt = Date.parse(meta.created_at)
        if (Number.isFinite(createdAt)) return Date.now() - createdAt
    }
    try {
        const stats = await stat(lockDir)
        return Date.now() - stats.mtimeMs
    } catch {
        return null
    }
}

async function refresh(metaPath: string, id: string): Promise<void> {
    const current = await readMeta(metaPath)
    if (current === null || current.id !== id) return
    await writeMeta(metaPath, {
        ...current,
        created_at: new Date().toISOString(),
    })
}

async function releaseIfOwner(
    lockDir: string,
    metaPath: string,
    id: string,
): Promise<void> {
    const current = await readMeta(metaPath)
    if (current !== null && current.id !== id) return
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
}

function isDirectoryExistsError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code === "EEXIST"
    )
}
