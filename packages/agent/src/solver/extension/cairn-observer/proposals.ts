import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { randomUUID } from "node:crypto"
import { readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The sidecar's only way to influence the graph. It writes one candidate file; the control
 * plane validates it, checks evidence/dedupe, and applies it through the normal graph
 * commands. The solver and the sidecar never touch `facts` / `intents` / `hints` directly.
 */

const MAX_TEXT_CHARS = 1000
const MAX_DEDUPE_KEY_CHARS = 128
const MAX_FROM_FACTS = 20
const MAX_EVIDENCE_REFS = 20
const MAX_EVIDENCE_REF_CHARS = 512
const MAX_SUPERSEDES = 20

const proposalKindParam = Type.Union([
    Type.Literal("fact"),
    Type.Literal("intent"),
    Type.Literal("hint"),
])

const proposeGraphChangeParams = Type.Object({
    kind: proposalKindParam,
    /** Fact/Intent description. Required for those kinds. */
    description: Type.Optional(Type.String()),
    /** Hint content. Required for hints. */
    content: Type.Optional(Type.String()),
    /** Existing fact ids this proposal derives from (required for fact/intent). */
    from: Type.Optional(Type.Array(Type.String())),
    /** Stable direction key. Required for intents; recommended for facts/hints. */
    dedupe_key: Type.Optional(Type.String()),
    /** Workspace-relative evidence files (required for facts when configured). */
    evidence_refs: Type.Optional(Type.Array(Type.String())),
    /** Fact only: older fact ids this conclusion replaces. */
    supersedes: Type.Optional(Type.Array(Type.String())),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
})

type ProposeGraphChangeInput = Static<typeof proposeGraphChangeParams>

export interface ProposalToolOptions {
    /** `<stateDir>/proposals`; the scheduler ingests files from here at task finish. */
    dir: string
    projectId: string
    taskId: string
    allowedKinds: readonly string[]
    maxPerTask: number
    maxFileBytes: number
    maxTotalBytes: number
    minConfidence: number
    requireEvidenceForFact: boolean
    /** Test hook. */
    now?: () => Date
}

export class ProposalRejected extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ProposalRejected"
    }
}

function clip(value: string): string {
    return value.trim().replace(/\s+/g, " ")
}

function requireText(value: string | undefined, field: string, maxChars: number): string {
    const text = typeof value === "string" ? clip(value) : ""
    if (text === "") throw new ProposalRejected(`${field} must not be empty`)
    if (text.length > maxChars) {
        throw new ProposalRejected(`${field} must be at most ${maxChars} characters`)
    }
    return text
}

function stringList(
    value: string[] | undefined,
    field: string,
    options: { required: boolean; maxItems: number; maxChars: number },
): string[] {
    const raw = value ?? []
    if (raw.length > options.maxItems) {
        throw new ProposalRejected(`${field} must contain at most ${options.maxItems} items`)
    }
    const items = raw.map((item) => {
        const text = typeof item === "string" ? item.trim() : ""
        if (text === "") throw new ProposalRejected(`${field} entries must not be empty`)
        if (text.length > options.maxChars) {
            throw new ProposalRejected(`${field} entries must be at most ${options.maxChars} characters`)
        }
        return text
    })
    if (options.required && items.length === 0) {
        throw new ProposalRejected(`${field} must contain at least one item`)
    }
    return [...new Set(items)]
}

/** Validates and normalizes one candidate before it reaches the filesystem. */
export function buildProposalCandidate(
    input: ProposeGraphChangeInput,
    options: ProposalToolOptions,
): Record<string, unknown> {
    if (!options.allowedKinds.includes(input.kind)) {
        throw new ProposalRejected(
            `kind "${input.kind}" is not enabled (allowed: ${options.allowedKinds.join(", ") || "none"})`,
        )
    }

    const confidence = input.confidence ?? 1
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new ProposalRejected("confidence must be between 0 and 1")
    }
    if (confidence < options.minConfidence) {
        throw new ProposalRejected(`confidence must be at least ${options.minConfidence}`)
    }

    let payload: Record<string, unknown>
    let dedupeKey: string | null = null
    let evidenceRefs: string[] = []
    let supersedes: string[] = []

    if (input.kind === "hint") {
        if (input.supersedes !== undefined && input.supersedes.length > 0) {
            throw new ProposalRejected("supersedes is only allowed for fact proposals")
        }
        const content = requireText(input.content, "content", MAX_TEXT_CHARS)
        dedupeKey = optionalDedupeKey(input.dedupe_key)
        payload = { content, confidence }
    } else {
        const description = requireText(input.description, "description", MAX_TEXT_CHARS)
        const from = stringList(input.from, "from", {
            required: true,
            maxItems: MAX_FROM_FACTS,
            maxChars: 64,
        })
        dedupeKey = optionalDedupeKey(input.dedupe_key)
        if (input.kind === "intent" && dedupeKey === null) {
            throw new ProposalRejected("dedupe_key is required for intent proposals")
        }
        evidenceRefs = stringList(input.evidence_refs, "evidence_refs", {
            required: options.requireEvidenceForFact && input.kind === "fact",
            maxItems: MAX_EVIDENCE_REFS,
            maxChars: MAX_EVIDENCE_REF_CHARS,
        })
        if (input.kind === "fact") {
            supersedes = stringList(input.supersedes, "supersedes", {
                required: false,
                maxItems: MAX_SUPERSEDES,
                maxChars: 64,
            })
        } else if (input.supersedes !== undefined && input.supersedes.length > 0) {
            throw new ProposalRejected("supersedes is only allowed for fact proposals")
        }
        payload = {
            description,
            from,
            confidence,
            ...(supersedes.length === 0 ? {} : { supersedes }),
        }
    }

    const createdAt = (options.now?.() ?? new Date()).toISOString()
    return {
        version: 1,
        id: randomUUID(),
        source: "observer",
        kind: input.kind,
        project_id: options.projectId,
        task_id: options.taskId,
        created_at: createdAt,
        dedupe_key: dedupeKey,
        evidence_refs: evidenceRefs,
        payload,
    }
}

function optionalDedupeKey(value: string | undefined): string | null {
    if (value === undefined) return null
    const text = clip(value)
    if (text === "") return null
    if (text.length > MAX_DEDUPE_KEY_CHARS) {
        throw new ProposalRejected(`dedupe_key must be at most ${MAX_DEDUPE_KEY_CHARS} characters`)
    }
    return text
}

async function existingProposalFiles(dir: string): Promise<{ count: number; bytes: number }> {
    let names: string[]
    try {
        names = await readdir(dir)
    } catch {
        return { count: 0, bytes: 0 }
    }
    let count = 0
    let bytes = 0
    for (const name of names) {
        if (!name.endsWith(".json") || name.startsWith(".")) continue
        try {
            const info = await stat(join(dir, name))
            if (!info.isFile()) continue
            count += 1
            bytes += info.size
        } catch {
            // Raced with ingestion/cleanup; ignore.
        }
    }
    return { count, bytes }
}

/** Writes `<dir>/<uuid>.json` atomically; never overwrites an existing candidate. */
export async function writeProposalFile(
    dir: string,
    candidate: Record<string, unknown>,
    options: Pick<ProposalToolOptions, "maxPerTask" | "maxFileBytes" | "maxTotalBytes">,
): Promise<string> {
    const id = typeof candidate["id"] === "string" ? candidate["id"] : randomUUID()
    const body = `${JSON.stringify(candidate, null, 2)}\n`
    const bytes = Buffer.byteLength(body, "utf8")
    if (bytes > options.maxFileBytes) {
        throw new ProposalRejected(
            `proposal is ${bytes} bytes; the per-file limit is ${options.maxFileBytes}`,
        )
    }

    const existing = await existingProposalFiles(dir)
    if (existing.count >= options.maxPerTask) {
        throw new ProposalRejected(`this task already wrote ${options.maxPerTask} proposals`)
    }
    if (existing.bytes + bytes > options.maxTotalBytes) {
        throw new ProposalRejected(
            `proposal budget exhausted (${existing.bytes + bytes} > ${options.maxTotalBytes} bytes)`,
        )
    }

    const finalPath = join(dir, `${id}.json`)
    const tempPath = join(dir, `.tmp-${id}.json`)
    await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" })
    try {
        await rename(tempPath, finalPath)
    } catch (error) {
        await unlink(tempPath).catch(() => undefined)
        throw error
    }
    return finalPath
}

export function createProposeGraphChangeTool(options: ProposalToolOptions) {
    return defineTool({
        name: "propose_graph_change",
        label: "Propose Graph Change",
        description:
            "Submit one candidate fact, intent, or hint for the control plane to review. This does not change the graph; it only queues a proposal that may be rejected, deduplicated, or applied after evidence checks.",
        promptSnippet:
            "propose_graph_change: queue one evidence-backed fact/intent/hint for review; never assume it was applied",
        parameters: proposeGraphChangeParams,
        async execute(_toolCallId, params: ProposeGraphChangeInput) {
            try {
                const candidate = buildProposalCandidate(params, options)
                const path = await writeProposalFile(options.dir, candidate, options)
                return {
                    content: [
                        {
                            type: "text",
                            text: `queued ${params.kind} proposal ${String(candidate["id"])} (pending control-plane review)`,
                        },
                    ],
                    details: { id: candidate["id"], kind: params.kind, path, status: "pending" },
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                return {
                    content: [{ type: "text", text: `proposal rejected: ${message}` }],
                    details: { rejected: true, reason: message },
                    isError: true,
                }
            }
        },
    })
}
