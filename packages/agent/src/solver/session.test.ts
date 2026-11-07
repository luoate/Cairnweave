import { afterEach, describe, expect, test } from "bun:test"

import { buildSolverStartupSnapshot, buildSubagentStartupSnapshot, applyReasoningMode, narrowSessionTools, readToolSpillFromEnv } from "./session"

const init = { solverId: "solver-1", promptName: "cairn-worker", task: "task" }
const prompt = { name: "cairn-worker", meta: {}, content: "prompt" }
const paths = { solverDir: "/solver", sessionDir: "/solver/session", workspaceDir: "/workspace" }

describe("solver startup snapshots", () => {
    test("redacts credential-shaped fields before writing the snapshot", () => {
        const snapshot = buildSolverStartupSnapshot(
            init,
            prompt as never,
            {
                model: { id: "deepseek-flash", provider: "gateway" },
                authStorage: { data: { gateway: { key: "SECRET-VALUE" } } },
                nested: { apiKey: "SECOND-SECRET", token: "THIRD-SECRET" },
            } as never,
            paths,
        )

        const serialized = JSON.stringify(snapshot)
        expect(serialized).not.toContain("SECRET-VALUE")
        expect(serialized).not.toContain("SECOND-SECRET")
        expect(serialized).not.toContain("THIRD-SECRET")
        expect(serialized).toContain("[REDACTED]")
        expect(serialized).toContain("deepseek-flash")
    })

    test("applies the same redaction to subagent snapshots", () => {
        const snapshot = buildSubagentStartupSnapshot(
            "cairn-worker",
            "task",
            "call-1",
            1,
            prompt as never,
            { authorization: "Bearer SECRET-VALUE", provider: { password: "SECOND-SECRET" } } as never,
            { subagentDir: "/sub", sessionDir: "/sub/session", workspaceDir: "/workspace" },
        )

        const serialized = JSON.stringify(snapshot)
        expect(serialized).not.toContain("SECRET-VALUE")
        expect(serialized).not.toContain("SECOND-SECRET")
        expect(serialized).toContain("[REDACTED]")
    })
})

describe("per-task reasoning mode", () => {
    const openaiModel = {
        id: "deepseek-flash",
        provider: "gateway",
        api: "openai-completions",
    }

    test("silences every thinking level for openai-compatible providers", () => {
        const options = applyReasoningMode(
            { model: openaiModel as never, thinkingLevel: "medium" },
            "off",
        )
        expect(options.thinkingLevel).toBe("medium")
        const model = options.model as unknown as {
            reasoning: boolean
            compat: { supportsReasoningEffort: boolean; reasoningEffortMap: Record<string, string> }
        }
        expect(model.reasoning).toBe(true)
        expect(model.compat.supportsReasoningEffort).toBe(true)
        expect(model.compat.reasoningEffortMap).toEqual({
            minimal: "none",
            low: "none",
            medium: "none",
            high: "none",
            xhigh: "none",
        })
    })

    test("strips a silencing map when reasoning is on", () => {
        const options = applyReasoningMode(
            {
                model: {
                    ...openaiModel,
                    reasoning: true,
                    compat: {
                        supportsReasoningEffort: true,
                        reasoningEffortMap: { minimal: "none", low: "none", high: "high" },
                    },
                } as never,
                thinkingLevel: "medium",
            },
            "on",
        )
        const model = options.model as unknown as {
            compat: { reasoningEffortMap: Record<string, string> }
        }
        expect(model.compat.reasoningEffortMap).toEqual({ high: "high" })
    })

    test("keeps the system role unless the model pref opts into the developer role", () => {
        // pi-ai's URL heuristic calls almost every custom gateway "standard OpenAI" and then
        // swaps the system message for OpenAI's `developer` role as soon as the model reasons.
        // Gateways that only know `system` answer 422 "unknown variant `developer`", so the
        // role is opt-in per model pref and reasoning must never turn it on by itself.
        const off = applyReasoningMode({ model: openaiModel as never, thinkingLevel: "medium" }, "off")
        expect(
            (off.model as unknown as { compat: { supportsDeveloperRole: boolean } }).compat
                .supportsDeveloperRole,
        ).toBe(false)

        const optedIn = applyReasoningMode(
            {
                model: { ...openaiModel, compat: { supportsDeveloperRole: true } } as never,
                thinkingLevel: "medium",
            },
            "on",
        )
        expect(
            (optedIn.model as unknown as { compat: { supportsDeveloperRole: boolean } }).compat
                .supportsDeveloperRole,
        ).toBe(true)
    })

    test("honours a pref that says the endpoint rejects reasoning_effort", () => {
        // zhipu-glm-flash is configured this way: an explicit false must survive the per-task
        // switch, otherwise every task would send a parameter the gateway does not accept.
        const options = applyReasoningMode(
            {
                model: {
                    ...openaiModel,
                    compat: { supportsReasoningEffort: false },
                } as never,
                thinkingLevel: "medium",
            },
            "off",
        )
        const compat = (options.model as unknown as { compat: Record<string, unknown> }).compat
        expect(compat.supportsReasoningEffort).toBe(false)
    })

    test("does not mutate the resolved options", () => {
        const original = { model: openaiModel as never, thinkingLevel: "medium" as const }
        applyReasoningMode(original, "off")
        expect(original.model).toEqual(openaiModel as never)
        expect((original.model as unknown as { compat?: unknown }).compat).toBeUndefined()
    })

    test("expresses off by dropping the level for token-budget providers", () => {
        const anthropicModel = { id: "claude-test", provider: "anthropic", api: "anthropic-messages" }
        const off = applyReasoningMode({ model: anthropicModel as never, thinkingLevel: "high" }, "off")
        expect(off.thinkingLevel).toBeUndefined()
        const on = applyReasoningMode({ model: anthropicModel as never, thinkingLevel: "high" }, "on")
        expect(on.thinkingLevel).toBe("high")
    })

    test("leaves options untouched when no model is resolved yet", () => {
        expect(applyReasoningMode({ thinkingLevel: "low" } as never, "off")).toEqual({
            thinkingLevel: "low",
        })
    })
})

describe("per-task tool allowlist", () => {
    const tools = [
        { name: "read" },
        { name: "bash" },
        { name: "write" },
        { name: "edit" },
        { name: "grep" },
    ]
    const customTools = [{ name: "memory_list" }, { name: "idea_list" }]

    test("keeps only the named built-in and custom tools", () => {
        const narrowed = narrowSessionTools(
            { tools, customTools } as never,
            ["read", "grep", "memory_list"],
        ) as { tools: Array<{ name: string }>; customTools?: Array<{ name: string }> }
        expect(narrowed.tools.map((tool) => tool.name)).toEqual(["read", "grep"])
        expect(narrowed.customTools?.map((tool) => tool.name)).toEqual(["memory_list"])
    })

    test("never adds a tool the prompt did not offer", () => {
        const narrowed = narrowSessionTools(
            { tools: [{ name: "read" }] } as never,
            ["read", "bash", "fetch"],
        ) as { tools: Array<{ name: string }> }
        expect(narrowed.tools.map((tool) => tool.name)).toEqual(["read"])
    })

    test("drops every custom tool when none is named", () => {
        const narrowed = narrowSessionTools(
            { tools, customTools } as never,
            ["read", "ls"],
        ) as { tools: Array<{ name: string }>; customTools?: unknown }
        expect(narrowed.tools.map((tool) => tool.name)).toEqual(["read"])
        expect(narrowed.customTools).toBeUndefined()
    })

    test("returns the same options when no allowlist is given", () => {
        const options = { tools } as never
        expect(narrowSessionTools(options, undefined)).toBe(options)
    })
})

describe("tool-result spill environment", () => {
    afterEach(() => {
        delete process.env["CAIRN_TOOL_SPILL_ENABLED"]
        delete process.env["CAIRN_TOOL_SPILL_MAX_CHARS"]
    })

    test("defaults to spilling at 32000 characters", () => {
        expect(readToolSpillFromEnv()).toEqual({ enabled: true, maxInlineChars: 32_000 })
    })

    test("honours the scheduler switch and inline budget", () => {
        process.env["CAIRN_TOOL_SPILL_ENABLED"] = "0"
        expect(readToolSpillFromEnv().enabled).toBe(false)

        process.env["CAIRN_TOOL_SPILL_ENABLED"] = "1"
        process.env["CAIRN_TOOL_SPILL_MAX_CHARS"] = " 8000 "
        expect(readToolSpillFromEnv()).toEqual({ enabled: true, maxInlineChars: 8000 })
    })

    test("falls back to the default budget for a nonsense value", () => {
        process.env["CAIRN_TOOL_SPILL_MAX_CHARS"] = "0"
        expect(readToolSpillFromEnv().maxInlineChars).toBe(32_000)
        process.env["CAIRN_TOOL_SPILL_MAX_CHARS"] = "many"
        expect(readToolSpillFromEnv().maxInlineChars).toBe(32_000)
        process.env["CAIRN_TOOL_SPILL_MAX_CHARS"] = "1.5"
        expect(readToolSpillFromEnv().maxInlineChars).toBe(32_000)
    })
})
