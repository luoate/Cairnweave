import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { MODEL_TRACE_FILE, modelTraceExtension } from "./model-trace"

type Handler = (event: any) => unknown

let traceDir: string

beforeEach(() => {
    traceDir = mkdtempSync(join(tmpdir(), "model-trace-"))
})

afterEach(() => {
    rmSync(traceDir, { recursive: true, force: true })
})

function handlers(options: Parameters<typeof modelTraceExtension>[0] = { traceDir }): Map<string, Handler> {
    const registered = new Map<string, Handler>()
    modelTraceExtension(options)({
        on(name: string, handler: Handler) {
            registered.set(name, handler)
        },
    } as unknown as ExtensionAPI)
    return registered
}

function lines(): any[] {
    const path = join(traceDir, MODEL_TRACE_FILE)
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

describe("model trace extension", () => {
    test("reads tool names from both OpenAI and flat tool shapes", () => {
        const event = handlers()
        event.get("before_provider_request")!({
            type: "before_provider_request",
            payload: {
                model: "m",
                // pi-ai's openai-completions provider wraps each tool as a function object;
                // a flat `name` is what the other providers send.
                tools: [
                    { type: "function", function: { name: "bash" } },
                    { name: "read", description: "read a file" },
                ],
            },
        })
        expect(lines()[0].tools).toEqual(["bash", "read"])
    })

    test("records the request body summary without dumping the whole payload", () => {
        const event = handlers()
        event.get("before_provider_request")!({
            type: "before_provider_request",
            payload: {
                model: "deepseek-flash",
                baseUrl: "https://gateway.example.test/ai/openai/v1?token=SECRET",
                temperature: 0.2,
                reasoning_effort: "none",
                tools: [{ name: "bash" }, { name: "read" }],
                messages: [
                    { role: "system", content: "s".repeat(50) },
                    { role: "user", content: [{ type: "text", text: "u".repeat(30) }] },
                    { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "id" } }] },
                ],
            },
        })

        const [request] = lines()
        expect(request.type).toBe("request")
        expect(request.turn).toBe(1)
        expect(request.model).toBe("deepseek-flash")
        // Unknown fields such as baseUrl are never copied: the prefix can carry a credential.
        expect(request).not.toHaveProperty("host")
        expect(request).not.toHaveProperty("baseUrl")
        expect(JSON.stringify(request)).not.toContain("SECRET")
        // The scalar params show whether the reasoning switch really reached the provider.
        expect(request.params.reasoning_effort).toBe("none")
        expect(request.tools).toEqual(["bash", "read"])
        expect(request.message_count).toBe(3)
        expect(request.messages[0].role).toBe("system")
        expect(request.messages[0].chars).toBe(50)
        expect(request.messages[2].tool_calls[0].name).toBe("bash")
    })

    test("records a response with its usage, stop reason and tool calls", () => {
        const event = handlers()
        event.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "m" } })
        event.get("message_end")!({
            type: "message_end",
            message: {
                role: "assistant",
                api: "openai-completions",
                model: "m",
                stopReason: "toolUse",
                content: [
                    { type: "text", text: "checking" },
                    { type: "toolCall", name: "bash", arguments: { command: "nmap -Pn 10.0.0.5" } },
                ],
                usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 13, cost: { total: 0.001 } },
            },
        })

        const response = lines().find((line) => line.type === "response")
        expect(response).toMatchObject({
            stop_reason: "toolUse",
            chars: "checking".length,
            tool_calls: [{ name: "bash" }],
            usage: { input: 10, output: 3, cache_read: 2, total: 13, cost_usd: 0.001 },
        })
        expect(typeof response.latency_ms).toBe("number")
    })

    test("surfaces a model error instead of hiding it", () => {
        const event = handlers()
        event.get("message_end")!({
            type: "message_end",
            message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "422 unknown variant `developer`",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            },
        })
        expect(lines()[0]).toMatchObject({
            type: "response",
            stop_reason: "error",
            error: "422 unknown variant `developer`",
        })
    })

    test("throttles streaming updates and keeps only the tail", () => {
        const event = handlers({ traceDir, streamIntervalMs: 0 })
        event.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "m" } })
        const update = event.get("message_update")!
        update({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })
        update({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hello world" }] } })

        const streams = lines().filter((line) => line.type === "stream")
        expect(streams.map((line) => line.chars)).toEqual(["hello".length, "hello world".length])
        expect(streams[1].tail).toBe("hello world")
    })

    test("writes one truncation marker and then stops", () => {
        // maxBytes is clamped by the config layer, but the extension must stay bounded even
        // when it is driven directly with a tiny budget.
        const event = handlers({ traceDir, maxBytes: 200 })
        const request = event.get("before_provider_request")!
        for (let index = 0; index < 10; index++) {
            request({ type: "before_provider_request", payload: { model: "m", messages: [{ role: "user", content: "x".repeat(40) }] } })
        }
        const all = lines()
        const truncated = all.filter((line) => line.type === "truncated")
        expect(truncated).toHaveLength(1)
        expect(all[all.length - 1].type).toBe("truncated")
    })

    test("writes nothing when disabled", () => {
        // The solver already skips the factory when the toggle is off; a directly constructed
        // disabled extension must stay inert instead of half-registering handlers.
        expect(handlers({ traceDir, enabled: false }).size).toBe(0)
        expect(existsSync(join(traceDir, MODEL_TRACE_FILE))).toBe(false)
    })

    test("continues the sequence when a session resumes an existing trace", () => {
        // A resumed task appends to the same file. Restarting at seq 1 would look "older"
        // than the cursor the control plane already holds and the new events would vanish.
        writeFileSync(
            join(traceDir, MODEL_TRACE_FILE),
            `${JSON.stringify({ seq: 41, at: "2026-01-02T03:00:00Z", type: "request" })}\n` +
                `${JSON.stringify({ seq: 42, at: "2026-01-02T03:00:01Z", type: "response" })}\n`,
            "utf8",
        )
        const event = handlers()
        event.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "m" } })
        const written = lines()
        expect(written).toHaveLength(3)
        expect(written[2].seq).toBe(43)
    })

    test("records tool executions with their result size", () => {
        const event = handlers()
        event.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "id" } })
        event.get("tool_execution_end")!({
            type: "tool_execution_end",
            toolCallId: "c1",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "uid=0(root)" }] },
        })
        const [start, end] = lines()
        expect(start).toMatchObject({ type: "tool_start", tool: "bash", args_preview: '{"command":"id"}' })
        expect(end).toMatchObject({ type: "tool_end", is_error: false, result_chars: "uid=0(root)".length })
    })
})
