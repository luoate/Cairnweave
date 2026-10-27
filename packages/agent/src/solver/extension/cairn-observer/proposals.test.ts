import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path"

import {
    ProposalRejected,
    buildProposalCandidate,
    writeProposalFile,
    type ProposalToolOptions,
} from "./proposals"

let directory: string;

beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "cairn-sidecar-proposals-"));
});

afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
});

function options(overrides: Partial<ProposalToolOptions> = {}): ProposalToolOptions {
    return {
        dir: directory,
        projectId: "p1",
        taskId: "explore-1",
        allowedKinds: ["fact", "intent", "hint"],
        maxPerTask: 8,
        maxFileBytes: 8192,
        maxTotalBytes: 32768,
        minConfidence: 0,
        requireEvidenceForFact: true,
        now: () => new Date("2026-01-01T00:00:00Z"),
        ...overrides,
    };
}

describe("sidecar proposal candidates", () => {
    test("builds a normalized hint candidate", () => {
        const candidate = buildProposalCandidate(
            { kind: "hint", content: "  check   /admin  ", dedupe_key: " admin " },
            options(),
        );
        expect(candidate).toMatchObject({
            version: 1,
            source: "observer",
            kind: "hint",
            project_id: "p1",
            task_id: "explore-1",
            created_at: "2026-01-01T00:00:00.000Z",
            dedupe_key: "admin",
            evidence_refs: [],
            payload: { content: "check /admin", confidence: 1 },
        });
        expect(typeof candidate["id"]).toBe("string");
    });

    test("accepts an evidence-backed fact", () => {
        const candidate = buildProposalCandidate(
            {
                kind: "fact",
                description: "admin panel exists",
                from: ["origin", "origin", "f1"],
                evidence_refs: ["notes/a.txt", "notes/a.txt"],
                confidence: 0.8,
            },
            options({ minConfidence: 0.5 }),
        );
        expect(candidate["payload"]).toEqual({
            description: "admin panel exists",
            from: ["origin", "f1"],
            confidence: 0.8,
        });
        expect(candidate["evidence_refs"]).toEqual(["notes/a.txt"]);
    });

    test("rejects invalid kinds, fields and thresholds", () => {
        expect(() =>
            buildProposalCandidate({ kind: "intent", description: "x", from: ["origin"] }, options()),
        ).toThrow(ProposalRejected);

        expect(() =>
            buildProposalCandidate(
                { kind: "fact", description: "no evidence", from: ["origin"] },
                options(),
            ),
        ).toThrow("evidence_refs");

        expect(() =>
            buildProposalCandidate(
                { kind: "intent", description: "x", from: ["origin"], evidence_refs: ["a.txt"] },
                options(),
            ),
        ).toThrow("dedupe_key");

        expect(() =>
            buildProposalCandidate(
                {
                    kind: "hint",
                    content: "low confidence",
                    confidence: 0.2,
                },
                options({ minConfidence: 0.5 }),
            ),
        ).toThrow("confidence");

        expect(() =>
            buildProposalCandidate(
                { kind: "hint", content: "x".repeat(1001) },
                options(),
            ),
        ).toThrow("at most 1000");

        expect(() =>
            buildProposalCandidate(
                { kind: "hint", content: "kind off" },
                options({ allowedKinds: ["fact"] }),
            ),
        ).toThrow("not enabled");
    });

    test("allows facts without evidence when the control plane disables the requirement", () => {
        const candidate = buildProposalCandidate(
            { kind: "fact", description: "no evidence needed", from: ["origin"] },
            options({ requireEvidenceForFact: false }),
        );
        expect(candidate["evidence_refs"]).toEqual([]);
    });

    test("passes supersede targets through on fact proposals", () => {
        const candidate = buildProposalCandidate(
            {
                kind: "fact",
                description: "port is 8080",
                from: ["origin"],
                evidence_refs: ["notes/port.txt"],
                supersedes: ["f001", "f002"],
            },
            options(),
        );
        expect(candidate["payload"]).toEqual({
            description: "port is 8080",
            from: ["origin"],
            confidence: 1,
            supersedes: ["f001", "f002"],
        });
    });

    test("rejects supersedes on non-fact proposals", () => {
        expect(() =>
            buildProposalCandidate(
                { kind: "hint", content: "check admin", supersedes: ["f001"] },
                options(),
            ),
        ).toThrow("supersedes is only allowed for fact proposals");

        expect(() =>
            buildProposalCandidate(
                {
                    kind: "intent",
                    description: "probe admin",
                    from: ["origin"],
                    dedupe_key: "probe-admin",
                    evidence_refs: [],
                    supersedes: ["f001"],
                },
                options(),
            ),
        ).toThrow("supersedes is only allowed for fact proposals");
    });

    test("caps supersede targets", () => {
        expect(() =>
            buildProposalCandidate(
                {
                    kind: "fact",
                    description: "too many targets",
                    from: ["origin"],
                    evidence_refs: ["notes/a.txt"],
                    supersedes: Array.from({ length: 21 }, (_, index) => `f${index}`),
                },
                options(),
            ),
        ).toThrow("supersedes must contain at most 20 items");
    });
});

describe("sidecar proposal files", () => {
    test("writes one JSON file with no temporary leftover", async () => {
        const candidate = buildProposalCandidate(
            { kind: "hint", content: "durable hint" },
            options(),
        );
        const path = await writeProposalFile(directory, candidate, options());

        expect(path).toBe(join(directory, `${String(candidate["id"])}.json`));
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(candidate);
        expect(readdirSync(directory)).toEqual([`${String(candidate["id"])}.json`]);
    });

    test("enforces the per-file and per-task limits", async () => {
        const hint = buildProposalCandidate({ kind: "hint", content: "hint" }, options());
        await expect(
            writeProposalFile(directory, hint, {
                maxPerTask: 8,
                maxFileBytes: 10,
                maxTotalBytes: 100,
            }),
        ).rejects.toThrow("per-file limit");

        await writeProposalFile(directory, hint, {
            maxPerTask: 1,
            maxFileBytes: 8192,
            maxTotalBytes: 32768,
        });
        const other = buildProposalCandidate({ kind: "hint", content: "other" }, options());
        await expect(
            writeProposalFile(directory, other, {
                maxPerTask: 1,
                maxFileBytes: 8192,
                maxTotalBytes: 32768,
            }),
        ).rejects.toThrow("already wrote");
    });

    test("enforces the total byte budget", async () => {
        const first = buildProposalCandidate({ kind: "hint", content: "first" }, options());
        const size = Buffer.byteLength(`${JSON.stringify(first, null, 2)}\n`, "utf8");
        await writeProposalFile(directory, first, {
            maxPerTask: 8,
            maxFileBytes: 8192,
            maxTotalBytes: size,
        });
        const second = buildProposalCandidate({ kind: "hint", content: "second" }, options());
        await expect(
            writeProposalFile(directory, second, {
                maxPerTask: 8,
                maxFileBytes: 8192,
                maxTotalBytes: size,
            }),
        ).rejects.toThrow("budget exhausted");
    });
});
