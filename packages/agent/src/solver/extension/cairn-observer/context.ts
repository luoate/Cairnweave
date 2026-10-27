import { readFile } from "node:fs/promises"
import type {
    CairnObserverContextFile,
    CairnObserverOptions,
    CairnObserverProposalOptions,
    CairnReviewPayload,
} from "./types"

function envText(name: string): string | undefined {
    const value = process.env[name]?.trim()
    return value ? value : undefined
}

function envPositiveInt(name: string, fallback: number): number {
    const raw = envText(name)
    if (!raw) return fallback
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function envNonNegativeInt(name: string, fallback: number): number {
    const raw = envText(name)
    if (!raw) return fallback
    const parsed = Number(raw)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function envUnitInterval(name: string, fallback: number): number {
    const raw = envText(name)
    if (!raw) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}

function envBool(name: string): boolean {
    return process.env[name] === "1"
}

function readProposalOptions(): CairnObserverProposalOptions | undefined {
    if (!envBool("CAIRN_OBSERVER_PROPOSALS_ENABLED")) return undefined
    const dir = envText("CAIRN_OBSERVER_PROPOSALS_DIR")
    const projectId = envText("CAIRN_OBSERVER_PROJECT_ID")
    const taskId = envText("CAIRN_OBSERVER_TASK_ID")
    const allowedKinds = (envText("CAIRN_OBSERVER_PROPOSALS_ALLOW_KINDS") ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter((kind) => kind === "fact" || kind === "intent" || kind === "hint")
    if (!dir || !projectId || !taskId || allowedKinds.length === 0) {
        console.error(
            "[observer] proposals disabled: dir, project id, task id and at least one allowed kind are required",
        )
        return undefined
    }
    return {
        dir,
        projectId,
        taskId,
        allowedKinds,
        maxPerTask: envNonNegativeInt("CAIRN_OBSERVER_PROPOSALS_MAX_PER_TASK", 20),
        maxFileBytes: envPositiveInt("CAIRN_OBSERVER_PROPOSALS_MAX_FILE_BYTES", 16 * 1024),
        maxTotalBytes: envPositiveInt("CAIRN_OBSERVER_PROPOSALS_MAX_TOTAL_BYTES", 64 * 1024),
        minConfidence: envUnitInterval("CAIRN_OBSERVER_PROPOSALS_MIN_CONFIDENCE", 0),
        requireEvidenceForFact: envBool("CAIRN_OBSERVER_PROPOSALS_REQUIRE_EVIDENCE"),
    }
}

/**
 * Reads the scheduler->worker Observer contract. Returns undefined unless the scheduler
 * explicitly enabled it for this task; a malformed contract is logged and treated as off.
 */
export function readCairnObserverOptionsFromEnv(): CairnObserverOptions | undefined {
    if (process.env["CAIRN_OBSERVER_ENABLED"] !== "1") return undefined

    const contextPath = envText("CAIRN_OBSERVER_CONTEXT_PATH")
    const boardDir = envText("CAIRN_OBSERVER_BOARD_DIR")
    const stateDir = envText("CAIRN_OBSERVER_STATE_DIR")
    if (!contextPath || !boardDir || !stateDir) {
        console.error(
            "[observer] disabled: CAIRN_OBSERVER_CONTEXT_PATH, CAIRN_OBSERVER_BOARD_DIR and CAIRN_OBSERVER_STATE_DIR are required",
        )
        return undefined
    }

    const proposals = readProposalOptions()
    return {
        contextPath,
        boardDir,
        stateDir,
        ...(envText("CAIRN_OBSERVER_MODEL") ? { model: envText("CAIRN_OBSERVER_MODEL") } : {}),
        everyRounds: envPositiveInt("CAIRN_OBSERVER_EVERY_ROUNDS", 4),
        windowRounds: envPositiveInt("CAIRN_OBSERVER_WINDOW_ROUNDS", 8),
        timeoutSeconds: envPositiveInt("CAIRN_OBSERVER_TIMEOUT_SECONDS", 60),
        maxReviewsPerTask: envNonNegativeInt("CAIRN_OBSERVER_MAX_REVIEWS_PER_TASK", 8),
        ...(proposals === undefined ? {} : { proposals }),
    }
}

/** Missing or malformed context is not fatal: the reviewer still sees solver rounds. */
export async function loadCairnObserverContext(
    path: string,
): Promise<CairnObserverContextFile | undefined> {
    try {
        const text = await readFile(path, "utf8")
        const parsed = JSON.parse(text) as CairnObserverContextFile
        if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return undefined
        return parsed
    } catch {
        return undefined
    }
}

export function formatCairnObserverContext(
    context: CairnObserverContextFile | undefined,
): string {
    if (!context) return "## Project\n- context unavailable (the scheduler snapshot is missing)"

    const lines = [
        "## Project",
        `- id: ${context.project.id}`,
        `- title: ${context.project.title || "-"}`,
        "",
        "## Current Focus",
        `- task_id: ${context.focus.task_id}`,
        `- kind: ${context.focus.kind}`,
        `- intent_id: ${context.focus.intent_id ?? "-"}`,
        `- intent: ${context.focus.intent_description ?? "-"}`,
        "",
        "## Authorized Scope",
        `- targets: ${context.scope.targets.join(", ") || "-"}`,
    ]
    if (context.scope.notes) lines.push(`- notes: ${context.scope.notes}`)

    lines.push("", "## Open Intents")
    if (context.open_intents.length === 0) {
        lines.push("- (none)")
    } else {
        for (const intent of context.open_intents) {
            lines.push(`- ${intent.id}: ${intent.description}`)
        }
    }

    lines.push("", "## Recent Facts")
    if (context.facts.length === 0) {
        lines.push("- (none)")
    } else {
        for (const fact of context.facts) {
            lines.push(`- [${fact.id}] ${fact.description}`)
        }
    }

    if (context.hints.length > 0) {
        lines.push("", "## Hints")
        for (const hint of context.hints) {
            lines.push(`- (${hint.creator}): ${hint.content}`)
        }
    }

    return lines.join("\n")
}

export function formatCairnReviewRounds(
    rounds: CairnReviewPayload["rounds"],
): string {
    if (rounds.length === 0) return "(none)"
    return rounds
        .map((round) => {
            const lines = [`### Round ${round.round}`]
            lines.push(`- assistant: ${round.assistant_summary.trim() || "(empty)"}`)
            if (round.tool_logs.length === 0) {
                lines.push("- tools: (none)")
            } else {
                lines.push("- tools:")
                for (const tool of round.tool_logs) {
                    lines.push(`  - [${tool.is_error ? "error" : "ok"}] ${tool.tool_name}`)
                    lines.push(`    args: ${tool.args_summary || "-"}`)
                    lines.push(`    result: ${tool.result_summary || "-"}`)
                }
            }
            return lines.join("\n")
        })
        .join("\n\n")
}

export function buildCairnObserverPrompt(
    contextText: string,
    payload: CairnReviewPayload,
    proposalsEnabled = false,
): string {
    const lines = [
        contextText,
        "",
        "## Recent Solver Activity",
        formatCairnReviewRounds(payload.rounds),
        "",
        "## Review Trigger",
        `- reason: ${payload.reason}`,
        "",
        "## Response Contract",
        "- 没有改动就只回复 `NO_CHANGE`。",
        "- 有改动就只写 1-4 条短 bullet，描述你维护了什么。",
        "- 你的全部结论必须落在 ideas / memory 看板上；不要输出解题过程或工具调用。",
    ]
    if (proposalsEnabled) {
        lines.push(
            "",
            "## Graph Proposals",
            "- 只有出现值得进入 Cairn 图的 durable 结论时，才调用 `propose_graph_change`。",
            "- `fact` 必须引用已有 fact id 和真实 evidence 文件；`intent` 必须给出稳定的 `dedupe_key`；`hint` 要短且可复用。",
            "- 新结论推翻旧 fact 时，在 `fact` 提案里用 `supersedes` 列出被取代的 fact id（不要重复提交一条几乎相同的 fact）；被取代的 fact 不能再用于完成项目。",
            "- 提案只是候选：控制面会做证据、去重与范围校验，可能拒绝或标为重复，不代表已写入图。",
            "- 不要提交 flag、凭据、完整工具输出、临时路径或题面复述。",
        )
    }
    return lines.join("\n")
}
