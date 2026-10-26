import { describe, expect, test } from "bun:test"

import { buildSolverStartupSnapshot, buildSubagentStartupSnapshot } from "./session"

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
