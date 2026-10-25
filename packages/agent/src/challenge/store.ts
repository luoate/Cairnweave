import { mkdir, readdir, rename, rm } from "fs/promises"
import { dirname, join, resolve } from "path"
import { TCH_AGENT_HOME_DIR } from "../config/index"
import { CHALLENGE_ENV_DIR } from "./env"

export const DEFAULT_CHALLENGE_DIR = resolve(TCH_AGENT_HOME_DIR, "challenge")

export interface ChallengeRecord {
    id: string
    title: string
    difficulty: string
    description: string
    level: number
    total_score: number
    total_got_score: number
    flag_count: number
    flag_got_count: number
    hint_viewed: boolean
    hint_content?: string | null
    instance_status: string
    entrypoint: string[] | null
    flags?: string[]
}

export interface ChallengeInfoRecord extends ChallengeRecord {
    updated_at: string
    source: string
}

export interface ChallengeAttemptLogRecord {
    id: string
    challenge_id: string
    solver_id: string
    prompt_name: string
    task: string
    created_at: string
}

export interface ChallengeSubmissionLogRecord {
    id: string
    challenge_id: string
    solver_id?: string
    prompt_name?: string
    model_name?: string
    flag: string
    correct: boolean
    message?: string
    writeup?: string
    created_at: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function requireText(value: string, fieldName: string): string {
    const text = value.trim()
    if (!text) throw new Error(`${fieldName} is required`)
    return text
}

function isDirectoryExistsError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST"
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
    const file = Bun.file(path)
    if (!(await file.exists())) return
    try {
        return (await file.json()) as T
    } catch {
        return
    }
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(tmpPath, JSON.stringify(data, null, 2))
    await rename(tmpPath, path)
}

async function withDirectoryLock<T>(lockDir: string, action: () => Promise<T>): Promise<T> {
    const startedAt = Date.now()
    const timeoutMs = 5000
    const staleMs = 60_000

    while (true) {
        try {
            await mkdir(lockDir)
            break
        } catch (error) {
            if (!isDirectoryExistsError(error)) throw error

            const lockMeta = await readJsonFile<{ created_at?: string }>(join(lockDir, "lock-meta.json"))
            const lockCreatedAt = lockMeta?.created_at ? Date.parse(lockMeta.created_at) : Number.NaN
            const lockAge = Number.isFinite(lockCreatedAt) ? Date.now() - lockCreatedAt : Number.NaN
            if (Number.isFinite(lockAge) && lockAge > staleMs) {
                await rm(lockDir, { recursive: true, force: true })
                continue
            }

            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`challenge lock timeout: ${lockDir}`)
            }
            await Bun.sleep(25)
        }
    }

    await Bun.write(join(lockDir, "lock-meta.json"), JSON.stringify({ created_at: nowIso(), pid: process.pid }, null, 2))
    try {
        return await action()
    } finally {
        await rm(lockDir, { recursive: true, force: true })
    }
}

function challengeDir(rootDir: string, challengeId: string): string {
    return join(rootDir, encodeURIComponent(challengeId))
}

function challengePath(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "challenge.json")
}

function challengeLockDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "locks", "challenge.lock")
}

function attemptLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "attempts")
}

function submissionLogsDir(rootDir: string, challengeId: string): string {
    return join(challengeDir(rootDir, challengeId), "submissions")
}

export function resolveChallengeDir(challengeDir?: string): string {
    const fromParam = challengeDir?.trim()
    if (fromParam) return fromParam
    const fromEnv = process.env[CHALLENGE_ENV_DIR]?.trim()
    if (fromEnv) return fromEnv
    return DEFAULT_CHALLENGE_DIR
}

export async function ensureChallengeStoreBaseDir(rootDir: string): Promise<void> {
    await mkdir(rootDir, { recursive: true })
}

async function ensureChallengeDirs(rootDir: string, challengeId: string): Promise<void> {
    const id = requireText(challengeId, "challengeId")
    const baseDir = challengeDir(rootDir, id)
    await mkdir(baseDir, { recursive: true })
    await mkdir(join(baseDir, "locks"), { recursive: true })
    await mkdir(attemptLogsDir(rootDir, id), { recursive: true })
    await mkdir(submissionLogsDir(rootDir, id), { recursive: true })
}

function createLogId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
}

export async function saveChallengeRecord(rootDir: string, challenge: ChallengeRecord, source = "save"): Promise<void> {
    const challengeId = requireText(challenge.id, "challenge.id")
    await ensureChallengeDirs(rootDir, challengeId)
    await withDirectoryLock(challengeLockDir(rootDir, challengeId), async () => {
        const record: ChallengeInfoRecord = {
            ...challenge,
            updated_at: nowIso(),
            source,
        }
        await atomicWriteJson(challengePath(rootDir, challengeId), record)
    })
}

export async function appendChallengeAttemptLog(
    rootDir: string,
    input: { challengeId: string; solverId: string; promptName: string; task: string },
): Promise<ChallengeAttemptLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)
    const record: ChallengeAttemptLogRecord = {
        id: createLogId("attempt"),
        challenge_id: challengeId,
        solver_id: requireText(input.solverId, "solverId"),
        prompt_name: requireText(input.promptName, "promptName"),
        task: requireText(input.task, "task"),
        created_at: nowIso(),
    }
    await atomicWriteJson(join(attemptLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`), record)
    return record
}

export async function appendChallengeSubmissionLog(
    rootDir: string,
    input: { challengeId: string; solverId?: string; promptName?: string; modelName?: string; flag: string; correct: boolean; message?: string; writeup?: string },
): Promise<ChallengeSubmissionLogRecord> {
    const challengeId = requireText(input.challengeId, "challengeId")
    await ensureChallengeDirs(rootDir, challengeId)
    const record: ChallengeSubmissionLogRecord = {
        id: createLogId("submission"),
        challenge_id: challengeId,
        solver_id: typeof input.solverId === "string" && input.solverId.trim() ? input.solverId.trim() : undefined,
        prompt_name: typeof input.promptName === "string" && input.promptName.trim() ? input.promptName.trim() : undefined,
        model_name: typeof input.modelName === "string" && input.modelName.trim() ? input.modelName.trim() : undefined,
        flag: requireText(input.flag, "flag"),
        correct: input.correct,
        message: typeof input.message === "string" && input.message.trim() ? input.message.trim() : undefined,
        writeup: typeof input.writeup === "string" && input.writeup.trim() ? input.writeup.trim() : undefined,
        created_at: nowIso(),
    }
    await atomicWriteJson(join(submissionLogsDir(rootDir, challengeId), `${Date.now()}-${record.id}.json`), record)
    return record
}

export async function listChallengeAttemptLogs(rootDir: string, challengeId: string): Promise<ChallengeAttemptLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = attemptLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(files.map((file) => readJsonFile<ChallengeAttemptLogRecord>(join(dir, file))))
    return items.filter((item): item is ChallengeAttemptLogRecord => Boolean(item))
}

export async function listChallengeSubmissionLogs(rootDir: string, challengeId: string): Promise<ChallengeSubmissionLogRecord[]> {
    const id = requireText(challengeId, "challengeId")
    const dir = submissionLogsDir(rootDir, id)
    let files: string[] = []
    try {
        files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort()
    } catch {
        return []
    }
    const items = await Promise.all(files.map((file) => readJsonFile<ChallengeSubmissionLogRecord>(join(dir, file))))
    return items.filter((item): item is ChallengeSubmissionLogRecord => Boolean(item))
}

export async function readChallengeRecord(rootDir: string, challengeId: string): Promise<ChallengeInfoRecord | undefined> {
    const id = requireText(challengeId, "challengeId")
    return readJsonFile<ChallengeInfoRecord>(challengePath(rootDir, id))
}

async function listChallengeIds(rootDir: string): Promise<string[]> {
    await ensureChallengeStoreBaseDir(rootDir)
    try {
        const entries = await readdir(rootDir, { withFileTypes: true })
        return entries.filter((entry) => entry.isDirectory()).map((entry) => decodeURIComponent(entry.name)).sort()
    } catch {
        return []
    }
}

export async function listChallengeRecords(rootDir: string): Promise<ChallengeInfoRecord[]> {
    const ids = await listChallengeIds(rootDir)
    const records = await Promise.all(ids.map((id) => readChallengeRecord(rootDir, id)))
    return records.filter((item): item is ChallengeInfoRecord => Boolean(item)).sort((a, b) => a.id.localeCompare(b.id))
}

export function computeChallengeCompleted(challenge: ChallengeInfoRecord | undefined): boolean {
    if (!challenge) return false
    return challenge.flag_count > 0 && challenge.flag_got_count >= challenge.flag_count
}

export async function isChallengeCompletedInStore(challengeId: string, challengeDir?: string): Promise<boolean> {
    const rootDir = resolveChallengeDir(challengeDir)
    const challenge = await readChallengeRecord(rootDir, requireText(challengeId, "challengeId"))
    return computeChallengeCompleted(challenge)
}
