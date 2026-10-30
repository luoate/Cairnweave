import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigManager, initBuiltinSkills } from "@cairn/agent";
import { configureDatabase, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

const BUILTIN_COUNT = 17;
const ENABLED_BY_DEFAULT = 12;

let directory: string;
let configDir: string;
let db: CairnDatabase;
let api: Api;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-skills-"));
  configDir = join(directory, "agent");
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, agentConfigDir: configDir });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface Row {
  name: string;
  directory: string;
  description: string;
  builtin: boolean;
  deleted: boolean;
  enabled: boolean;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await api.handle(
    new Request(`http://cairn.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

async function promptSkills(): Promise<string[]> {
  const manager = await ConfigManager.getInstance(configDir);
  const prompt = await manager.getPrompt("cairn-worker");
  return prompt?.meta.skills ?? [];
}

const validSkill = {
  name: "lab-notes",
  description: "Capture lab-only notes and reuse them across tasks",
  content: "# Lab notes\n\nRead the target brief first.\n",
};

describe("skill settings routes", () => {
  test("releases the builtin skills and reports the worker allowlist", async () => {
    const result = await call("GET", "/settings/agent/skills");
    expect(result.status).toBe(200);
    expect(result.body.prompt).toBe("cairn-worker");
    expect(result.body.promptFound).toBe(true);
    expect(result.body.enabledCount).toBe(ENABLED_BY_DEFAULT);

    const rows = result.body.skills as Row[];
    expect(rows.filter((row) => row.builtin && !row.deleted)).toHaveLength(BUILTIN_COUNT);
    expect(rows.find((row) => row.directory === "recon")).toMatchObject({
      name: "recon",
      builtin: true,
      deleted: false,
      enabled: true,
    });
    expect(rows.find((row) => row.directory === "agent-browser")).toMatchObject({
      builtin: true,
      enabled: false,
    });
    expect(existsSync(join(configDir, "skills", "recon", "SKILL.md"))).toBe(true);
    expect(existsSync(join(configDir, "prompts", "cairn-worker.md"))).toBe(true);
  });

  test("creates a skill, writes SKILL.md and enables it in the worker prompt", async () => {
    const created = await call("POST", "/settings/agent/skills", validSkill);
    expect(created.status).toBe(200);
    expect(created.body.skill).toMatchObject({
      name: "lab-notes",
      directory: "lab-notes",
      builtin: false,
      deleted: false,
      enabled: true,
    });

    const file = readFileSync(join(configDir, "skills", "lab-notes", "SKILL.md"), "utf8");
    expect(file.startsWith("---\nname: lab-notes\ndescription: ")).toBe(true);
    expect(file).toContain("# Lab notes");
    expect(file).toContain("Read the target brief first.");
    expect(await promptSkills()).toContain("lab-notes");

    const listed = await call("GET", "/settings/agent/skills");
    expect((listed.body.skills as Row[]).find((row) => row.directory === "lab-notes")).toMatchObject(
      { enabled: true, builtin: false, deleted: false },
    );
  });

  test("creates a skill without enabling it when enabled is false", async () => {
    const created = await call("POST", "/settings/agent/skills", {
      ...validSkill,
      enabled: false,
    });
    expect(created.status).toBe(200);
    expect(created.body.skill.enabled).toBe(false);
    expect(await promptSkills()).not.toContain("lab-notes");
  });

  test("rejects invalid names, descriptions, content and bodies", async () => {
    const invalid: unknown[] = [
      {},
      { name: "Bad Name", description: "x", content: "x" },
      { name: "a--b", description: "x", content: "x" },
      { name: "-ab", description: "x", content: "x" },
      { name: "Upper", description: "x", content: "x" },
      { name: "ok-name", description: "", content: "x" },
      { name: "ok-name", description: "two\nlines", content: "x" },
      { name: "ok-name", description: "x", content: "   " },
      { name: "ok-name", description: "x", content: "a".repeat(96 * 1024 + 1) },
      { name: "ok-name", description: "x", content: "x", enabled: "yes" },
    ];
    for (const body of invalid) {
      const result = await call("POST", "/settings/agent/skills", body);
      expect(result.status).toBe(400);
    }

    expect((await call("POST", "/settings/agent/skills", "{bad json")).status).toBe(400);
    expect((await call("POST", "/settings/agent/skills", [])).status).toBe(400);
    expect(
      (await call("POST", "/settings/agent/skills", { content: "x".repeat(600 * 1024) })).status,
    ).toBe(413);
    expect(existsSync(join(configDir, "skills", "ok-name"))).toBe(false);
  });

  test("refuses duplicate names, including a deleted builtin", async () => {
    await call("GET", "/settings/agent/skills");
    expect((await call("DELETE", "/settings/agent/skills/recon")).status).toBe(200);
    expect(
      (await call("POST", "/settings/agent/skills", { ...validSkill, name: "recon" })).status,
    ).toBe(409);

    expect((await call("POST", "/settings/agent/skills", validSkill)).status).toBe(200);
    expect((await call("POST", "/settings/agent/skills", validSkill)).status).toBe(409);
  });

  test("toggles builtin and custom skills in the worker prompt", async () => {
    await call("GET", "/settings/agent/skills");
    expect(await promptSkills()).not.toContain("agent-browser");

    const enabled = await call("PUT", "/settings/agent/skills/agent-browser/enabled", {
      enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body).toEqual({
      name: "agent-browser",
      directory: "agent-browser",
      enabled: true,
    });
    expect(await promptSkills()).toContain("agent-browser");

    const disabled = await call("PUT", "/settings/agent/skills/recon/enabled", {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect(await promptSkills()).not.toContain("recon");

    expect(
      (await call("PUT", "/settings/agent/skills/missing-skill/enabled", { enabled: true }))
        .status,
    ).toBe(404);
    expect(
      (await call("PUT", "/settings/agent/skills/recon/enabled", { enabled: "no" })).status,
    ).toBe(400);
    expect((await call("PUT", "/settings/agent/skills/..%2Fescape/enabled", { enabled: true }))
      .status).toBe(400);
  });

  test("deletes a custom skill directory", async () => {
    expect((await call("POST", "/settings/agent/skills", validSkill)).status).toBe(200);
    expect(existsSync(join(configDir, "skills", "lab-notes"))).toBe(true);

    const deleted = await call("DELETE", "/settings/agent/skills/lab-notes");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, builtin: false });
    expect(existsSync(join(configDir, "skills", "lab-notes"))).toBe(false);
    expect(await promptSkills()).not.toContain("lab-notes");
    expect((await call("DELETE", "/settings/agent/skills/lab-notes")).status).toBe(404);
  });

  test("keeps a deleted builtin deleted across re-seeding and restores it", async () => {
    await call("GET", "/settings/agent/skills");
    const deleted = await call("DELETE", "/settings/agent/skills/recon");
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, builtin: true });
    expect(existsSync(join(configDir, "skills", "recon"))).toBe(false);
    expect(await promptSkills()).not.toContain("recon");

    const listed = await call("GET", "/settings/agent/skills");
    expect((listed.body.skills as Row[]).find((row) => row.directory === "recon")).toMatchObject({
      name: "recon",
      builtin: true,
      deleted: true,
      enabled: false,
    });

    await initBuiltinSkills(configDir);
    expect(existsSync(join(configDir, "skills", "recon"))).toBe(false);

    const restored = await call("POST", "/settings/agent/skills/recon/restore");
    expect(restored.status).toBe(200);
    expect(restored.body.skill).toMatchObject({
      name: "recon",
      builtin: true,
      deleted: false,
      enabled: false,
    });
    expect(existsSync(join(configDir, "skills", "recon", "SKILL.md"))).toBe(true);
    expect(await promptSkills()).not.toContain("recon");

    expect((await call("POST", "/settings/agent/skills/recon/restore")).status).toBe(409);
    expect((await call("POST", "/settings/agent/skills/agent-browser/restore")).status).toBe(409);
    expect((await call("POST", "/settings/agent/skills/lab-notes/restore")).status).toBe(404);
  });

  test("rejects cross-origin writes", async () => {
    const result = await call("POST", "/settings/agent/skills", validSkill, {
      origin: "http://evil.test",
    });
    expect(result.status).toBe(403);
    expect(existsSync(join(configDir, "skills", "lab-notes"))).toBe(false);
  });
});

describe("skill settings operator guard", () => {
  beforeEach(() => {
    api = createApi({ db, agentConfigDir: configDir, operatorToken: "operator-secret" });
  });

  test("requires the operator token for mutations but not reads", async () => {
    expect((await call("GET", "/settings/agent/skills")).status).toBe(200);
    expect((await call("POST", "/settings/agent/skills", validSkill)).status).toBe(401);

    const auth = { "x-cairn-operator-token": "operator-secret" };
    expect((await call("POST", "/settings/agent/skills", validSkill, auth)).status).toBe(200);
    expect(
      (await call("DELETE", "/settings/agent/skills/lab-notes", undefined, {
        "x-cairn-operator-token": "wrong",
      })).status,
    ).toBe(401);
    expect(
      (await call("PUT", "/settings/agent/skills/lab-notes/enabled", { enabled: false }, auth))
        .status,
    ).toBe(200);
  });
});

describe("skill file browsing routes", () => {
  test("lists the builtin tree with SKILL.md first", async () => {
    await call("GET", "/settings/agent/skills");
    const result = await call("GET", "/settings/agent/skills/recon/files");
    expect(result.status).toBe(200);
    expect(result.body.directory).toBe("recon");
    expect(result.body.truncated).toBe(false);
    expect(result.body.files[0]).toMatchObject({ path: "SKILL.md" });
    expect(result.body.files[0].size).toBeGreaterThan(0);
  });

  test("reads SKILL.md verbatim, frontmatter included", async () => {
    await call("GET", "/settings/agent/skills");
    const result = await call("GET", "/settings/agent/skills/recon/file?path=SKILL.md");
    expect(result.status).toBe(200);
    expect(result.body.path).toBe("SKILL.md");
    expect(result.body.binary).toBe(false);
    expect(result.body.truncated).toBe(false);
    expect(result.body.content.startsWith("---\n")).toBe(true);
    expect(result.body.content).toContain("name: recon");
  });

  test("creates a nested tree and lists it with the relative posix path", async () => {
    mkdirSync(join(configDir, "skills", "lab-notes", "references"), { recursive: true });
    writeFileSync(join(configDir, "skills", "lab-notes", "SKILL.md"), "# notes\n", "utf8");
    writeFileSync(
      join(configDir, "skills", "lab-notes", "references", "payloads.md"),
      "payloads\n",
      "utf8",
    );

    const result = await call("GET", "/settings/agent/skills/lab-notes/files");
    expect(result.status).toBe(200);
    expect(result.body.files.map((file: { path: string }) => file.path)).toEqual([
      "SKILL.md",
      "references/payloads.md",
    ]);

    const nested = await call(
      "GET",
      "/settings/agent/skills/lab-notes/file?path=references%2Fpayloads.md",
    );
    expect(nested.status).toBe(200);
    expect(nested.body.path).toBe("references/payloads.md");
    expect(nested.body.content).toBe("payloads\n");
  });

  test("marks a binary file and truncates an oversized one", async () => {
    mkdirSync(join(configDir, "skills", "blobbed"), { recursive: true });
    writeFileSync(join(configDir, "skills", "blobbed", "SKILL.md"), "# blob\n", "utf8");
    writeFileSync(join(configDir, "skills", "blobbed", "blob.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(configDir, "skills", "blobbed", "big.md"), "a".repeat(300 * 1024));

    const binary = await call("GET", "/settings/agent/skills/blobbed/file?path=blob.bin");
    expect(binary.status).toBe(200);
    expect(binary.body).toMatchObject({ binary: true, content: "", size: 4 });

    const big = await call("GET", "/settings/agent/skills/blobbed/file?path=big.md");
    expect(big.status).toBe(200);
    expect(big.body.truncated).toBe(true);
    expect(big.body.size).toBe(300 * 1024);
    expect(big.body.content.length).toBe(256 * 1024);
  });

  test("rejects traversal, unknown skills and missing files", async () => {
    await call("GET", "/settings/agent/skills");
    for (const path of [
      "../auth.json",
      "..%2Fauth.json",
      "skills/recon/SKILL.md",
      "SKILL.md/../../auth.json",
      "C:/Windows/win.ini",
      "SKILL.md\\..\\..\\auth.json",
    ]) {
      const result = await call("GET", `/settings/agent/skills/recon/file?path=${encodeURIComponent(path)}`);
      expect([400, 404]).toContain(result.status);
    }

    expect((await call("GET", "/settings/agent/skills/recon/file")).status).toBe(400);
    expect((await call("GET", "/settings/agent/skills/ghost/files")).status).toBe(404);
    expect((await call("GET", "/settings/agent/skills/recon/file?path=missing.md")).status).toBe(
      404,
    );
  });

  test("reads are allowed without an operator token but writes are not", async () => {
    api = createApi({ db, agentConfigDir: configDir, operatorToken: "operator-secret" });
    await call("GET", "/settings/agent/skills");
    expect((await call("GET", "/settings/agent/skills/recon/files")).status).toBe(200);
    expect((await call("GET", "/settings/agent/skills/recon/file?path=SKILL.md")).status).toBe(200);
    expect((await call("POST", "/settings/agent/skills/recon/files")).status).toBe(405);
  });
});
