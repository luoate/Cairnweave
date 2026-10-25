import { defineTool } from "@mariozechner/pi-coding-agent"
import type { Static } from "@sinclair/typebox"
import { Type } from "@sinclair/typebox"
import { requestHostBridge } from "../../challenge/host-bridge-client"

const EmptyParams = Type.Object({})
const SubmitFlagParams = Type.Object({
    flag: Type.String({ description: "Flag value to submit" }),
    writeup: Type.Optional(Type.String({ description: "Optional concise route summary for how this flag was obtained" })),
})
const ChallengeHintParams = Type.Object({})

type SubmitFlagInput = Static<typeof SubmitFlagParams>

export const challengeSubmitFlagTool = defineTool({
    name: "challenge_submit_flag",
    label: "Challenge Submit Flag",
    description: "Submit flag for current challenge. Include a concise writeup when you know the route so other solvers can avoid repeating it.",
    promptSnippet: "challenge_submit_flag: submit one flag, optionally with a concise route writeup",
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
    description: "Fetch or read persisted hint for current challenge .",
    promptSnippet: "challenge_get_hint: fetch hint for current challenge",
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
