import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

const EmptyParams = Type.Object({})
const SubmitFlagParams = Type.Object({
    flag: Type.String({ description: "要提交的 flag 值" }),
    writeup: Type.Optional(Type.String({ description: "可选的简要利用路径说明，描述这枚 flag 是如何取得的" })),
})
const ChallengeHintParams = Type.Object({})

type SubmitFlagInput = Static<typeof SubmitFlagParams>

export const challengeSubmitFlagTool = defineTool({
    name: "challenge_submit_flag",
    label: "Challenge Submit Flag",
    description: "为当前题目提交 flag。若已知利用路径，请附上简要 writeup，方便其他 solver 避免重复。",
    promptSnippet: "challenge_submit_flag: 提交一枚 flag，可附带简要的利用路径 writeup",
    parameters: SubmitFlagParams,
    async execute(_toolCallId, params: SubmitFlagInput) {
        const details = await requestHostBridge<{
            remote: { correct: boolean; flag_got_count?: number; flag_count?: number }
            challenge?: unknown
            is_completed: boolean
        }>("challenge_submit_flag", { flag: params.flag, ...(params.writeup?.trim() ? { writeup: params.writeup.trim() } : {}) })
        const gotCount = typeof details.remote.flag_got_count === "number" ? details.remote.flag_got_count : undefined
        const flagCount = typeof details.remote.flag_count === "number" ? details.remote.flag_count : undefined
        const remainingCount = typeof gotCount === "number" && typeof flagCount === "number" ? Math.max(flagCount - gotCount, 0) : undefined
        const completion =
            remainingCount !== undefined
                ? details.is_completed
                    ? "challenge completed"
                    : `${remainingCount} flags remaining`
                : details.is_completed
                  ? "challenge completed"
                  : "challenge not completed"
        return {
            content: [{ type: "text", text: `submitted flag: ${details.remote.correct ? "correct" : "incorrect"}, ${completion}` }],
            details,
        }
    },
})

export const challengeGetHintTool = defineTool({
    name: "challenge_get_hint",
    label: "Challenge Get Hint",
    description: "获取或读取当前题目已持久化的 hint。",
    promptSnippet: "challenge_get_hint: 获取当前题目的 hint",
    parameters: ChallengeHintParams,
    async execute() {
        const details = await requestHostBridge<{
            code: string
            hint_content: string | null
        }>("challenge_get_hint", {})
        const hint = details.hint_content?.trim()
        return {
            content: [{ type: "text", text: hint ? `challenge hint:\n${hint}` : "challenge hint is empty" }],
            details,
        }
    },
})

export const challengeTools = [
    challengeGetHintTool,
    challengeSubmitFlagTool,
]

export const challengeToolNames = new Set(challengeTools.map((tool) => tool.name))
