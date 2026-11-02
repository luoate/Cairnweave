import { mkdir } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"

const DEFAULT_MAX_INLINE_CHARS = 32000
const PREVIEW_CHARS = 600

export interface LargeToolResultOptions {
    workspaceRoot: string
    maxInlineChars?: number
}

interface SerializedToolResult {
    text: string
    hasContent: boolean
}

interface ToolContentBlock {
    type: string
    text?: string
}

function formatNow(): string {
    return new Date().toISOString()
}

function sanitizeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-")
}

function serializeContentBlocks(content: ToolContentBlock[]): SerializedToolResult {
    if (!Array.isArray(content) || content.length === 0) {
        return { text: "", hasContent: false }
    }

    const chunks: string[] = []
    for (const block of content) {
        if (block.type === "text") {
            chunks.push(block.text ?? "")
            continue
        }
        chunks.push(JSON.stringify(block))
    }
    return { text: chunks.join("\n\n"), hasContent: true }
}

function shouldBypassForSkillMarkdown(toolName: string, input: unknown): boolean {
    if (toolName !== "read" || !input || typeof input !== "object") return false
    const payload = input as { path?: unknown; file_path?: unknown }
    const rawPath = (typeof payload.path === "string" ? payload.path : typeof payload.file_path === "string" ? payload.file_path : "").trim()
    if (!rawPath) return false
    return basename(rawPath) === "SKILL.md"
}

function buildSpillFileBody(toolName: string, toolCallId: string, input: unknown, serializedText: string): string {
    return [
        "# 工具结果溢出文件",
        "",
        `- time: ${formatNow()}`,
        `- tool: ${toolName}`,
        `- toolCallId: ${toolCallId}`,
        `- originalChars: ${serializedText.length}`,
        "",
        "## 输入",
        "```json",
        JSON.stringify(input ?? {}, null, 2),
        "```",
        "",
        "## 完整内容",
        "```text",
        serializedText,
        "```",
        "",
    ].join("\n")
}

function buildTruncatedMessage(relPath: string, absPath: string, serializedText: string): string {
    const preview = serializedText.slice(0, PREVIEW_CHARS)
    const suffix = serializedText.length > PREVIEW_CHARS ? "..." : ""
    // Subagent sessions run with their own cwd under the workspace, where the relative pointer
    // would not resolve, so the absolute path is the one worth quoting first.
    return [
        `工具结果过大（${serializedText.length} 个字符）。`,
        `完整结果已保存到：${absPath}`,
        `工作区相对路径：${relPath}`,
        `这是一个函数调用的溢出文件。不要盲目整读整个文件。`,
        `先用 grep/find 定位相关片段，再按 offset/limit 分块读取。`,
        `示例：在 ${absPath} 上 grep 目标模式；读取 {"path":"${absPath}","offset":1,"limit":200}`,
        "",
        `预览：${preview}${suffix}`,
    ].join("\n")
}

export function largeToolResultExtension(options: LargeToolResultOptions): ExtensionFactory {
    const maxInlineChars = options.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS

    return (pi) => {
        console.log("Large Tool Result extension initialized")
        pi.on("tool_result", async (event) => {
            if (shouldBypassForSkillMarkdown(event.toolName, event.input)) return
            const serialized = serializeContentBlocks(event.content)
            if (!serialized.hasContent || serialized.text.length <= maxInlineChars) return

            const outputDir = join(options.workspaceRoot, ".tool-results")
            await mkdir(outputDir, { recursive: true })

            const fileName = `${Date.now()}-${sanitizeName(event.toolName)}-${sanitizeName(event.toolCallId)}.md`
            const absPath = join(outputDir, fileName)
            const relPath = `.tool-results/${fileName}`

            const fileBody = buildSpillFileBody(event.toolName, event.toolCallId, event.input, serialized.text)
            await Bun.write(absPath, fileBody)

            return {
                content: [{ type: "text", text: buildTruncatedMessage(relPath, absPath, serialized.text) }],
                details: {
                    type: "large_tool_result_spill",
                    truncated: true,
                    originalChars: serialized.text.length,
                    path: relPath,
                },
            }
        })
    }
}
