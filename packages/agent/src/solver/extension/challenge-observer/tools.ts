import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import type { IdeaRecord, IdeaStatus, MemoryEntry, MemoryKind } from "../../../challenge/memory"
import {
    addSolverBoardIdea,
    appendSolverBoardMemory,
    deleteSolverBoardMemory,
    listSolverBoardIdeas,
    listSolverBoardMemory,
    searchSolverBoardIdeas,
    updateSolverBoardIdea,
    updateSolverBoardMemory,
} from "../../board-store"
import { formatIdeaTable, formatMemoryTable } from "./board-format"

const EmptyParams = Type.Object({})
const memoryKindToolParam = Type.Union([Type.Literal("fact"), Type.Literal("evidence"), Type.Literal("failure"), Type.Literal("note"), Type.Literal("hint")])
const ideaStatusToolParam = Type.Union([Type.Literal("pending"), Type.Literal("testing"), Type.Literal("verified"), Type.Literal("failed"), Type.Literal("skipped")])

const memoryAddToolParams = Type.Object({
    kind: memoryKindToolParam,
    content: Type.String(),
    refs: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.String()),
})

const memoryUpdateToolParams = Type.Object({
    entry_id: Type.String(),
    kind: Type.Optional(memoryKindToolParam),
    content: Type.Optional(Type.String()),
    refs: Type.Optional(Type.Array(Type.String())),
    source: Type.Optional(Type.String()),
})

const memoryDeleteToolParams = Type.Object({
    entry_id: Type.String(),
})

const ideaAddToolParams = Type.Object({
    content: Type.String({ minLength: 1 }),
    status: Type.Optional(ideaStatusToolParam),
    result: Type.Optional(Type.String()),
})

const ideaSearchToolParams = Type.Object({
    query: Type.String(),
})

const querySolverHistoryToolParams = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
})

const steerToolParams = Type.Object({
    message: Type.String({ minLength: 1 }),
})

const ideaUpdateToolParams = Type.Object({
    idea_id: Type.String(),
    status: ideaStatusToolParam,
    result: Type.Optional(Type.String()),
})

type MemoryAddToolInput = Static<typeof memoryAddToolParams> & { kind: MemoryKind }
type MemoryUpdateToolInput = Static<typeof memoryUpdateToolParams> & { kind?: MemoryKind }
type MemoryDeleteToolInput = Static<typeof memoryDeleteToolParams>
type IdeaSearchToolInput = Static<typeof ideaSearchToolParams>
type QuerySolverHistoryToolInput = Static<typeof querySolverHistoryToolParams>
type IdeaAddToolInput = Static<typeof ideaAddToolParams>
type SteerToolInput = Static<typeof steerToolParams>
type IdeaUpdateToolInput = Static<typeof ideaUpdateToolParams> & { status: IdeaStatus }
const hiddenMemoryAddToolParams = Type.Object({
    kind: memoryKindToolParam,
    content: Type.String(),
    refs: Type.Optional(Type.Array(Type.String())),
    source: Type.String(),
})
type HiddenMemoryAddToolInput = Static<typeof hiddenMemoryAddToolParams> & { kind: MemoryKind }

function clipText(value: string, maxChars: number): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
}

function formatMemoryMutation(action: "added" | "updated" | "deleted", entry: MemoryEntry): string {
    return `${action} memory [${entry.kind}] ${entry.id}: ${clipText(entry.content, 160)}`
}

function formatIdeaMutation(action: "added" | "updated", item: IdeaRecord): string {
    const result = item.result.trim()
    return `${action} idea [${item.status}] ${item.id}: ${clipText(item.content, 140)}${result ? ` -> ${clipText(result, 160)}` : ""}`
}

interface SolverHistoryRecord {
    kind: "user" | "assistant" | "tool"
    entry_id: string
    timestamp: string
    summary: string
}

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function extractTextBlocks(content: unknown): string[] {
    if (typeof content === "string") return [content]
    if (!Array.isArray(content)) return []
    return content
        .filter((item): item is { type?: unknown; text?: unknown } => !!item && typeof item === "object")
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text.trim())
        .filter((item) => item.length > 0)
}

function extractToolCalls(content: unknown): Array<{ name: string; arguments: string }> {
    if (!Array.isArray(content)) return []
    return content
        .filter((item): item is { type?: unknown; name?: unknown; arguments?: unknown } => !!item && typeof item === "object")
        .filter((item): item is { type: "toolCall"; name: string; arguments?: unknown } => item.type === "toolCall" && typeof item.name === "string")
        .map((item) => ({
            name: item.name,
            arguments: clipText(safeJsonStringify(item.arguments ?? {}), 160),
        }))
}

function extractToolResultSummary(message: Record<string, unknown>): string {
    const text = extractTextBlocks(message.content).join("\n").trim()
    if (text) return clipText(text, 240)
    return clipText(safeJsonStringify(message.content ?? ""), 240)
}

function buildSolverHistoryRecords(entries: unknown[]): SolverHistoryRecord[] {
    const records: SolverHistoryRecord[] = []

    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue
        if ((entry as { type?: unknown }).type !== "message") continue

        const message = (entry as { message?: unknown }).message
        if (!message || typeof message !== "object") continue

        const entryId = typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : "-"
        const timestamp =
            typeof (entry as { timestamp?: unknown }).timestamp === "string" ? (entry as { timestamp: string }).timestamp : "-"
        const role = (message as { role?: unknown }).role

        if (role === "assistant") {
            const assistantText = extractTextBlocks((message as { content?: unknown }).content).join("\n").trim()
            const toolCalls = extractToolCalls((message as { content?: unknown }).content)
            const summaryLines: string[] = []
            if (assistantText) {
                summaryLines.push(`assistant: ${clipText(assistantText, 240)}`)
            }
            for (const toolCall of toolCalls) {
                summaryLines.push(`tool_call: ${toolCall.name} ${toolCall.arguments}`)
            }
            if (summaryLines.length > 0) {
                records.push({
                    kind: "assistant",
                    entry_id: entryId,
                    timestamp,
                    summary: summaryLines.join("\n"),
                })
            }
            continue
        }

        if (role === "user") {
            const userText = extractTextBlocks((message as { content?: unknown }).content).join("\n").trim()
            if (!userText) continue
            records.push({
                kind: "user",
                entry_id: entryId,
                timestamp,
                summary: `user: ${clipText(userText, 240)}`,
            })
            continue
        }

        if (role === "toolResult") {
            const toolName = typeof (message as { toolName?: unknown }).toolName === "string" ? (message as { toolName: string }).toolName : "tool"
            const resultSummary = extractToolResultSummary(message as Record<string, unknown>)
            records.push({
                kind: "tool",
                entry_id: entryId,
                timestamp,
                summary: `tool_result: ${toolName}\nresult: ${resultSummary}`,
            })
        }
    }

    return records
}

function formatSolverHistory(records: SolverHistoryRecord[], totalEntries: number, offset: number): string {
    if (records.length === 0) {
        return ["## Solver History", `- total: ${totalEntries}`, "- showing: none"].join("\n")
    }

    return [
        "## Solver History",
        `- total: ${totalEntries}`,
        `- showing: ${offset + 1}-${offset + records.length}`,
        "",
        ...records.map((record, index) =>
            [`### ${offset + index + 1}. ${record.kind}`, `- entry_id: ${record.entry_id}`, `- timestamp: ${record.timestamp}`, record.summary].join("\n"),
        ),
    ].join("\n")
}

const observerSidecarBoardTools = [
    defineTool({
        name: "memory_list",
        label: "Memory List",
        description: "列出当前的 durable memory 条目。先用它查看，删除或合并条目前再核对一次。",
        promptSnippet: "memory_list: 整理前先查看当前 durable memory",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardMemory()
            return {
                content: [{ type: "text", text: formatMemoryTable(items) }],
                details: { items },
            }
        },
    }),
    defineTool({
        name: "memory_add",
        label: "Memory Add",
        description: "新增一条 durable memory 条目。只用于值得长期保留的 fact、evidence、失败边界、hint 或重要约束。",
        promptSnippet: "memory_add: 新增 durable 的 fact/evidence/failure/hint/约束",
        parameters: memoryAddToolParams,
        async execute(_toolCallId, params: MemoryAddToolInput) {
            const entry = await appendSolverBoardMemory({
                kind: params.kind,
                content: params.content,
                refs: params.refs ?? [],
                source: params.source?.trim() || "observer",
            })
            return {
                content: [{ type: "text", text: formatMemoryMutation("added", entry) }],
                details: { entry },
            }
        },
    }),
    defineTool({
        name: "memory_update",
        label: "Memory Update",
        description: "按 id 或 id 前缀更新一条 memory 条目。当某条 memory 需要收紧、合并，或改写成更强的 durable 结论时使用。",
        promptSnippet: "memory_update: 收紧或合并已有的 memory 条目",
        parameters: memoryUpdateToolParams,
        async execute(_toolCallId, params: MemoryUpdateToolInput) {
            const entry = await updateSolverBoardMemory(params.entry_id, {
                ...(params.kind ? { kind: params.kind } : {}),
                ...(params.content !== undefined ? { content: params.content } : {}),
                ...(params.refs !== undefined ? { refs: params.refs } : {}),
                ...(params.source !== undefined ? { source: params.source } : {}),
            })
            return {
                content: [{ type: "text", text: formatMemoryMutation("updated", entry) }],
                details: { entry },
            }
        },
    }),
    defineTool({
        name: "memory_delete",
        label: "Memory Delete",
        description: "按 id 或 id 前缀删除一条 memory 条目。用于重复项、低价值的操作日志、过期条目，或已被更强记录取代的 memory。",
        promptSnippet: "memory_delete: 删除重复、嘈杂、过期或已被取代的 memory",
        parameters: memoryDeleteToolParams,
        async execute(_toolCallId, params: MemoryDeleteToolInput) {
            const entry = await deleteSolverBoardMemory(params.entry_id)
            return {
                content: [{ type: "text", text: formatMemoryMutation("deleted", entry) }],
                details: { entry },
            }
        },
    }),
    defineTool({
        name: "idea_list",
        label: "Idea List",
        description: "列出当前的策略 idea。先用它查看现有的攻击假设看板。",
        promptSnippet: "idea_list: 整理前先查看当前攻击假设",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardIdeas()
            return {
                content: [{ type: "text", text: formatIdeaTable(items) }],
                details: { items },
            }
        },
    }),
    defineTool({
        name: "idea_search",
        label: "Idea Search",
        description: "按关键词搜索策略 idea。在新增 idea 前使用，避免出现近似重复的攻击假设。",
        promptSnippet: "idea_search: 检查是否已存在相似的攻击假设",
        parameters: ideaSearchToolParams,
        async execute(_toolCallId, params: IdeaSearchToolInput) {
            const items = await searchSolverBoardIdeas(params.query)
            return {
                content: [{ type: "text", text: formatIdeaTable(items) }],
                details: { query: params.query, items },
            }
        },
    }),
    defineTool({
        name: "idea_add",
        label: "Idea Add",
        description: "新增一条策略 idea。创建时可直接设定 status/result。只用于具体的攻击假设，不要用于观察记录或已完成的动作。",
        promptSnippet: "idea_add: 新增一条具体的攻击假设，可选带 status/result",
        parameters: ideaAddToolParams,
        async execute(_toolCallId, params: IdeaAddToolInput) {
            const result = await addSolverBoardIdea({
                content: params.content,
                status: params.status,
                result: params.result ?? "",
            })
            return {
                content: [{ type: "text", text: formatIdeaMutation("added", result.item) }],
                details: result,
            }
        },
    }),
    defineTool({
        name: "idea_update",
        label: "Idea Update",
        description: "按 id 或 id 前缀更新某条策略 idea 的 status 与 result。当假设进入测试，或达到 verified/failed/skipped 时使用。",
        promptSnippet: "idea_update: 推进假设生命周期并记录 result",
        parameters: ideaUpdateToolParams,
        async execute(_toolCallId, params: IdeaUpdateToolInput) {
            const item = await updateSolverBoardIdea(params.idea_id, {
                status: params.status,
                result: params.result ?? "",
            })
            return {
                content: [{ type: "text", text: formatIdeaMutation("updated", item) }],
                details: { item },
            }
        },
    }),
]

export function createObserverSidecarTools(sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean) {
    return createObserverSidecarToolsWithOptions({ sendCorrectionNotice })
}

export function createObserverSidecarToolsWithOptions(options?: {
    sendCorrectionNotice?: (message: string) => Promise<boolean> | boolean
    getSolverEntries?: () => Promise<unknown[]> | unknown[]
    /** Default true (upstream behavior). Cairn omits the steer tool entirely. */
    enableSteer?: boolean
}) {
    const sendCorrectionNotice = options?.sendCorrectionNotice
    const getSolverEntries = options?.getSolverEntries
    const enableSteer = options?.enableSteer !== false
    const steerTools = enableSteer
        ? [
              defineTool({
                  name: "send_efficiency_reminder",
                  label: "Efficiency Reminder",
                  description:
                      "只有当 solver 明显且持续陷入低效率模式时，才发送一条简短的效率提醒。不要打断正常推进中的工作，也不要用它代替 idea 或 memory。",
                  promptSnippet:
                      "send_efficiency_reminder: 谨慎使用，仅针对明显且持续的低效率行为；不要打断正常推进中的工作",
                  parameters: steerToolParams,
                  async execute(_toolCallId, params: SteerToolInput) {
                      const delivered = (await sendCorrectionNotice?.(params.message)) !== false
                      return {
                          content: [
                              {
                                  type: "text",
                                  text: delivered
                                      ? `sent efficiency reminder: ${clipText(params.message, 200)}`
                                      : `suppressed efficiency reminder: ${clipText(params.message, 200)}`,
                              },
                          ],
                          details: { delivered, message: params.message },
                      }
                  },
              }),
          ]
        : []
    return [
        ...observerSidecarBoardTools,
        defineTool({
            name: "query_solver_history",
            label: "Query Solver History",
            description:
                "当压缩后的上下文不够用时，查看最近的 solver 历史。可分页浏览用户指令、assistant 输出、工具调用与工具结果。",
            promptSnippet:
                "query_solver_history: 上下文压缩后不够用时，分页查看最近的用户指令、assistant 输出与工具活动",
            parameters: querySolverHistoryToolParams,
            async execute(_toolCallId, params: QuerySolverHistoryToolInput, _signal, _onUpdate, ctx) {
                const baseEntries = (await getSolverEntries?.()) ?? ctx.sessionManager.getEntries()
                const records = buildSolverHistoryRecords(baseEntries).reverse()
                const offset = params.offset ?? 0
                const limit = params.limit ?? 8
                const slice = records.slice(offset, offset + limit)
                return {
                    content: [{ type: "text", text: formatSolverHistory(slice, records.length, offset) }],
                    details: {
                        total_entries: records.length,
                        returned_count: slice.length,
                    },
                }
            },
        }),
        ...steerTools,
    ]
}

export const challengeObserverAgentTools = [
    defineTool({
        name: "memory_add",
        label: "Memory Add",
        description: "追加一条 durable memory 条目。在你确认了值得跨压缩保留的 fact、evidence、失败边界或 hint 之后使用。",
        promptSnippet: "memory_add: 确认后把 durable 的 fact/evidence/failure/hint 落库",
        parameters: hiddenMemoryAddToolParams,
        async execute(_toolCallId, params: HiddenMemoryAddToolInput) {
            const entry = await appendSolverBoardMemory({
                kind: params.kind,
                content: params.content,
                refs: params.refs ?? [],
                source: params.source,
            })
            return {
                content: [{ type: "text", text: formatMemoryMutation("added", entry) }],
                details: { entry },
            }
        },
    }),
    defineTool({
        name: "memory_list",
        label: "Memory List",
        description: "列出 durable memory。在开始时、压缩后，或上下文可能已过期的重试攻击路线前使用。",
        promptSnippet: "memory_list: 选择下一步前先查看 durable 的 fact/evidence/failure",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardMemory()
            return {
                content: [{ type: "text", text: formatMemoryTable(items, { updatedAtFallback: true }) }],
                details: { items },
            }
        },
    }),
    defineTool({
        name: "idea_list",
        label: "Idea List",
        description: "列出当前的攻击假设。在选择或切换方向前作为只读输入使用。",
        promptSnippet: "idea_list: 选择方向前查看当前攻击假设",
        parameters: EmptyParams,
        async execute() {
            const items = await listSolverBoardIdeas()
            return {
                content: [{ type: "text", text: formatIdeaTable(items, { updatedAtFallback: true }) }],
                details: { items },
            }
        },
    }),
    defineTool({
        name: "idea_search",
        label: "Idea Search",
        description: "在重试某个具体攻击向量（如 SQLi、upload、SSRF、RCE、format string、overflow）前，按关键词搜索当前的攻击假设。",
        promptSnippet: "idea_search: 检查该向量是否已在当前看板上",
        parameters: ideaSearchToolParams,
        async execute(_toolCallId, params: IdeaSearchToolInput) {
            const items = await searchSolverBoardIdeas(params.query)
            return {
                content: [{ type: "text", text: formatIdeaTable(items, { updatedAtFallback: true }) }],
                details: { query: params.query, items },
            }
        },
    }),
]

/**
 * Read-only subset for the Cairn main solver. The Observer sidecar owns all board
 * writes, so the solver cannot accidentally rewrite the board it is being advised from.
 */
export const cairnObserverAgentTools = challengeObserverAgentTools.filter(
    (tool) => tool.name !== "memory_add",
)
