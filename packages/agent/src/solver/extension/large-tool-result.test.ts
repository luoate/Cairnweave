import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { largeToolResultExtension } from "./large-tool-result"

type Handler = (event: any) => Promise<any>

let workspace: string

beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "tool-spill-"))
})

afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
})

function toolResultHandler(maxInlineChars?: number): Handler {
    const handlers = new Map<string, Handler>()
    largeToolResultExtension({ workspaceRoot: workspace, maxInlineChars })((
        {
            on(name: string, handler: Handler) {
                handlers.set(name, handler)
            },
        } as unknown as ExtensionAPI
    ))
    const handler = handlers.get("tool_result")
    if (handler === undefined) throw new Error("extension did not register a tool_result handler")
    return handler
}

function text(length: number): string {
    return "a".repeat(length)
}

describe("large tool result spill", () => {
    test("passes a result inside the inline budget through untouched", async () => {
        const handler = toolResultHandler(100)
        expect(await handler({ toolName: "bash", toolCallId: "call-1", input: {}, content: [{ type: "text", text: text(100) }] })).toBeUndefined()
        expect(existsSync(join(workspace, ".tool-results"))).toBe(false)
    })

    test("moves an oversized result to the workspace and returns a pointer", async () => {
        const handler = toolResultHandler(100)
        const body = `${text(4000)} flag{spill_probe}`

        const patch = await handler({
            toolName: "bash",
            toolCallId: "call-2",
            input: { command: "curl http://target.test" },
            content: [{ type: "text", text: body }],
        })

        expect(patch.details).toEqual({
            type: "large_tool_result_spill",
            truncated: true,
            originalChars: body.length,
            path: expect.stringMatching(/^\.tool-results\/\d+-bash-call-2\.md$/),
        })

        const spills = readdirSync(join(workspace, ".tool-results"))
        expect(spills).toHaveLength(1)
        const file = readFileSync(join(workspace, ".tool-results", spills[0]!), "utf8")
        expect(file).toContain("curl http://target.test")
        expect(file).toContain(body)

        const message = patch.content[0].text as string
        // The pointer names the absolute path first: subagents run with their own cwd.
        expect(message).toContain(join(workspace, ".tool-results", spills[0]!))
        expect(message).toContain(`工具结果过大（${body.length} 个字符）`)
        expect(message).toContain(text(600))
        expect(message).not.toContain("flag{spill_probe}")
    })

    test("spills non-text blocks as JSON", async () => {
        const handler = toolResultHandler(20)
        const patch = await handler({
            toolName: "read",
            toolCallId: "call-3",
            input: { path: join(workspace, "big.bin.txt") },
            content: [{ type: "image", data: text(40) }],
        })

        expect(patch.details.originalChars).toBeGreaterThan(20)
        const spills = readdirSync(join(workspace, ".tool-results"))
        expect(readFileSync(join(workspace, ".tool-results", spills[0]!), "utf8")).toContain('{"type":"image"')
    })

    test("leaves SKILL.md reads inline so skill instructions stay verbatim", async () => {
        const handler = toolResultHandler(10)
        expect(
            await handler({
                toolName: "read",
                toolCallId: "call-4",
                input: { path: "/skills/targeted-pentest/SKILL.md" },
                content: [{ type: "text", text: text(5000) }],
            }),
        ).toBeUndefined()
        expect(existsSync(join(workspace, ".tool-results"))).toBe(false)
    })

    test("defaults the inline budget to 32000 characters", async () => {
        const handler = toolResultHandler()
        expect(await handler({ toolName: "bash", toolCallId: "call-5", input: {}, content: [{ type: "text", text: text(32_000) }] })).toBeUndefined()
        expect((await handler({ toolName: "bash", toolCallId: "call-6", input: {}, content: [{ type: "text", text: text(32_001) }] })).details
            .originalChars).toBe(32_001)
    })
})
