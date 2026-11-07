import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"

/**
 * Model trace: what the worker actually sent to the provider and what came back.
 *
 * The session file records messages only after they complete, and it never records the
 * request body at all — neither the system prompt size, nor the tools offered, nor whether
 * `reasoning_effort` was really sent. That is exactly what is needed when a solve stalls or
 * a model answers 422, so this extension appends a bounded NDJSON trace next to the session
 * and the control plane serves it read-only.
 *
 * Three properties matter more than completeness:
 *
 * - It must never disturb the solve. Every handler swallows its own errors; a broken trace
 *   degrades to a missing file, never to a failed task.
 * - It must not leak the operator's credentials. Provider headers and API keys are never
 *   serialized; request summaries are rebuilt from named fields instead of dumping the body.
 * - It must stay small. Each text field keeps `previewChars`, the whole file stops at
 *   `maxBytes` with one `truncated` marker, and streaming updates are throttled.
 */

export interface ModelTraceOptions {
    /** Directory the trace is written to; the session directory in practice. */
    traceDir: string
    enabled?: boolean
    previewChars?: number
    maxBytes?: number
    /** Minimum gap between two `stream` lines for the same assistant message. */
    streamIntervalMs?: number
}

export const MODEL_TRACE_FILE = "model-trace.jsonl"

const DEFAULT_PREVIEW_CHARS = 2000
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_STREAM_INTERVAL_MS = 400

/** A preview keeps the head and the tail: the tail is the part that is still arriving. */
function previewOf(text: string, limit: number): string {
    if (text.length <= limit) return text
    const head = Math.floor(limit * 0.35)
    const tail = limit - head
    return `${text.slice(0, head)}\n…（省略 ${text.length - limit} 字符）…\n${text.slice(text.length - tail)}`
}

/**
 * Request-shape scalars worth seeing. This is a whitelist, not a filter: provider bodies also
 * carry fields the operator should not see (a gateway may echo its base URL, a key, or a
 * custom `extra_body`), and a denylist would have to guess their names.
 */
const TRACEABLE_PARAMS = new Set([
    "model",
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "thinking",
    "stream",
    "tool_choice",
    "parallel_tool_calls",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "service_tier",
])

function scalarParams(source: Record<string, unknown>, limit: number): Record<string, string | number | boolean> {
    const params: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(source)) {
        if (!TRACEABLE_PARAMS.has(key)) continue
        if (typeof value === "number" || typeof value === "boolean") {
            params[key] = value
            continue
        }
        if (typeof value === "string" && value.length <= limit) params[key] = value
    }
    return params
}

interface MessageSummary {
    role: string
    chars: number
    preview: string
    tool_calls?: { name: string; args_preview: string }[]
    tool_error?: boolean
}

function summarizeContent(content: unknown): { text: string; thinking: string; toolCalls: { name: string; args: string }[] } {
    const text: string[] = []
    const thinking: string[] = []
    const toolCalls: { name: string; args: string }[] = []
    if (typeof content === "string") return { text: content, thinking: "", toolCalls }
    if (!Array.isArray(content)) return { text: "", thinking: "", toolCalls }
    for (const block of content) {
        if (block === null || typeof block !== "object") continue
        const item = block as Record<string, unknown>
        if (item["type"] === "text" && typeof item["text"] === "string") text.push(item["text"])
        else if (item["type"] === "thinking" && typeof item["thinking"] === "string") thinking.push(item["thinking"])
        else if (item["type"] === "toolCall") {
            toolCalls.push({
                name: typeof item["name"] === "string" ? item["name"] : "?",
                args: JSON.stringify(item["arguments"] ?? {}),
            })
        } else if (item["type"] === "image") text.push("[图片]")
    }
    return { text: text.join("\n"), thinking: thinking.join("\n"), toolCalls }
}

function summarizeMessages(payload: Record<string, unknown>, previewChars: number): MessageSummary[] {
    const summaries: MessageSummary[] = []
    if (typeof payload["system"] === "string") {
        const system = payload["system"] as string
        summaries.push({ role: "system", chars: system.length, preview: previewOf(system, previewChars) })
    }
    const messages = Array.isArray(payload["messages"]) ? payload["messages"] : []
    for (const raw of messages) {
        if (raw === null || typeof raw !== "object") continue
        const message = raw as Record<string, unknown>
        const role = typeof message["role"] === "string" ? message["role"] : "unknown"
        const content = summarizeContent(message["content"])
        const summary: MessageSummary = {
            role,
            chars: content.text.length + content.thinking.length,
            preview: previewOf(content.text, previewChars),
        }
        if (content.toolCalls.length > 0) {
            summary.tool_calls = content.toolCalls.map((call) => ({
                name: call.name,
                args_preview: previewOf(call.args, Math.min(previewChars, 500)),
            }))
        }
        if (role === "tool" || role === "toolResult") {
            if (message["is_error"] === true || message["isError"] === true) summary.tool_error = true
        }
        summaries.push(summary)
    }
    return summaries
}

function toolNames(payload: Record<string, unknown>): string[] {
    const tools = payload["tools"]
    if (!Array.isArray(tools)) return []
    const names: string[] = []
    for (const tool of tools) {
        if (tool === null || typeof tool !== "object") continue
        const entry = tool as Record<string, unknown>
        // OpenAI-compatible providers send `{type:"function", function:{name}}`; the other
        // providers send the schema flat. Both shapes have to be readable, or the trace
        // would claim the worker offered no tools at all.
        const nested = entry["function"]
        const name = typeof entry["name"] === "string"
            ? entry["name"]
            : nested !== null && typeof nested === "object" && typeof (nested as Record<string, unknown>)["name"] === "string"
                ? (nested as Record<string, unknown>)["name"]
                : undefined
        if (typeof name === "string") names.push(name)
        if (names.length >= 60) break
    }
    return names
}

function payloadBytes(payload: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(payload) ?? "")
    } catch {
        return 0
    }
}

function usageView(usage: unknown): Record<string, number> | undefined {
    if (usage === null || typeof usage !== "object") return undefined
    const source = usage as Record<string, unknown>
    const value = (key: string) => (typeof source[key] === "number" ? (source[key] as number) : 0)
    const view: Record<string, number> = {
        input: value("input"),
        output: value("output"),
        cache_read: value("cacheRead"),
        cache_write: value("cacheWrite"),
        total: value("totalTokens"),
    }
    const cost = source["cost"]
    if (cost !== null && typeof cost === "object" && typeof (cost as Record<string, unknown>)["total"] === "number") {
        view["cost_usd"] = (cost as Record<string, number>)["total"] ?? 0
    }
    return view
}

/**
 * Builds the extension. A disabled trace still returns a factory: the solver registers one
 * unconditionally and the toggle only decides whether anything is written.
 */
export function modelTraceExtension(options: ModelTraceOptions): ExtensionFactory {
    const enabled = options.enabled ?? true
    const previewChars = options.previewChars ?? DEFAULT_PREVIEW_CHARS
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const streamIntervalMs = options.streamIntervalMs ?? DEFAULT_STREAM_INTERVAL_MS
    const path = join(options.traceDir, MODEL_TRACE_FILE)

    let seq = 0
    let written = 0
    let sealed = false
    let turn = 0
    let requestStartedAt = 0
    let lastStreamAt = 0
    let lastStreamChars = 0

    const write = (event: Record<string, unknown>): void => {
        if (!enabled || sealed) return
        try {
            const line = `${JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), ...event })}\n`
            const bytes = Buffer.byteLength(line)
            if (written + bytes > maxBytes) {
                sealed = true
                const marker = `${JSON.stringify({
                    seq: seq + 1,
                    at: new Date().toISOString(),
                    type: "truncated",
                    max_bytes: maxBytes,
                })}\n`
                appendFileSync(path, marker, "utf8")
                return
            }
            if (written === 0) mkdirSync(options.traceDir, { recursive: true })
            appendFileSync(path, line, "utf8")
            seq += 1
            written += bytes
        } catch {
            // A trace is diagnostic: never let it fail or slow the solve.
            sealed = true
        }
    }

    const safe = (handler: () => void): void => {
        try {
            handler()
        } catch {
            sealed = true
        }
    }

    return (pi) => {
        if (!enabled) return
        // The file is per task and the task directory is fresh; if an older file is there it
        // is a resumed session, so append after its current size and sequence instead of
        // restarting either (a cursor taken before the restart must keep working).
        try {
            written = statSync(path).size
        } catch {
            written = 0
        }
        seq = lastSeqOf(path)
        if (written >= maxBytes) sealed = true

        pi.on("before_provider_request", (event) => {
            safe(() => {
                turn += 1
                requestStartedAt = Date.now()
                lastStreamAt = 0
                lastStreamChars = 0
                const payload = event.payload
                if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
                    write({ type: "request", turn, payload_kind: typeof payload })
                    return
                }
                const body = payload as Record<string, unknown>
                // The payload is the provider body itself (pi-ai calls `onPayload` with the
                // params it is about to send), so it carries no base URL or headers at all.
                write({
                    type: "request",
                    turn,
                    model: typeof body["model"] === "string" ? body["model"] : undefined,
                    bytes: payloadBytes(payload),
                    message_count: Array.isArray(body["messages"]) ? (body["messages"] as unknown[]).length : 0,
                    // Scalars such as temperature and reasoning_effort, which is the field that
                    // shows whether the per-task reasoning switch reached the provider.
                    params: scalarParams(body, 120),
                    tools: toolNames(body),
                    messages: summarizeMessages(body, previewChars),
                })
            })
        })

        pi.on("message_update", (event) => {
            safe(() => {
                const message = event.message as { role?: string; content?: unknown } | undefined
                if (message?.role !== "assistant") return
                const now = Date.now()
                if (now - lastStreamAt < streamIntervalMs) return
                const content = summarizeContent(message.content)
                const chars = content.text.length
                if (chars <= lastStreamChars && content.thinking.length === 0) return
                lastStreamAt = now
                lastStreamChars = chars
                write({
                    type: "stream",
                    turn,
                    chars,
                    thinking_chars: content.thinking.length,
                    tail: previewOf(content.text.slice(-previewChars), previewChars),
                })
            })
        })

        pi.on("message_end", (event) => {
            safe(() => {
                const message = event.message as Record<string, unknown> | undefined
                if (message?.role !== "assistant") return
                const content = summarizeContent(message["content"])
                const latencyMs = requestStartedAt === 0 ? undefined : Date.now() - requestStartedAt
                requestStartedAt = 0
                write({
                    type: "response",
                    turn,
                    model: typeof message["model"] === "string" ? message["model"] : undefined,
                    api: typeof message["api"] === "string" ? message["api"] : undefined,
                    stop_reason: typeof message["stopReason"] === "string" ? message["stopReason"] : undefined,
                    chars: content.text.length,
                    thinking_chars: content.thinking.length,
                    text: previewOf(content.text, previewChars),
                    thinking: content.thinking === "" ? undefined : previewOf(content.thinking, previewChars),
                    tool_calls: content.toolCalls.map((call) => ({
                        name: call.name,
                        args_preview: previewOf(call.args, Math.min(previewChars, 500)),
                    })),
                    usage: usageView(message["usage"]),
                    latency_ms: latencyMs,
                    ...(typeof message["errorMessage"] === "string"
                        ? { error: previewOf(message["errorMessage"], 1000) }
                        : {}),
                })
            })
        })

        pi.on("tool_execution_start", (event) => {
            safe(() => {
                write({
                    type: "tool_start",
                    turn,
                    tool: event.toolName,
                    tool_call_id: event.toolCallId,
                    args_preview: previewOf(JSON.stringify(event.args ?? {}), Math.min(previewChars, 500)),
                })
            })
        })

        pi.on("tool_execution_end", (event) => {
            safe(() => {
                const content = summarizeContent(
                    (event.result as { content?: unknown } | undefined)?.content ?? event.result,
                )
                write({
                    type: "tool_end",
                    turn,
                    tool: event.toolName,
                    tool_call_id: event.toolCallId,
                    is_error: event.isError === true,
                    result_chars: content.text.length,
                    result_preview: previewOf(content.text, Math.min(previewChars, 800)),
                })
            })
        })
    }
}

/**
 * Reads the last sequence number from an existing trace. A resumed task opens the same file,
 * and the control plane pages by `seq > cursor`: restarting at 1 would make every new event
 * look old. Only the tail is read, and a half-written final line is skipped.
 */
function lastSeqOf(path: string): number {
    try {
        const size = statSync(path).size
        if (size === 0) return 0
        const length = Math.min(size, 64 * 1024)
        const buffer = Buffer.alloc(length)
        const fd = openSync(path, "r")
        try {
            readSync(fd, buffer, 0, length, size - length)
        } finally {
            closeSync(fd)
        }
        const lines = buffer.toString("utf8").split("\n")
        for (let index = lines.length - 1; index >= 0; index--) {
            const line = lines[index]?.trim()
            if (!line) continue
            try {
                const value = (JSON.parse(line) as { seq?: unknown }).seq
                if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value
            } catch {
                // The tail window can start mid-line and a crash can leave a partial last line.
            }
        }
        return 0
    } catch {
        return 0
    }
}

