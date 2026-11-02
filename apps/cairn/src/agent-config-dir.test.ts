import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  agentConfigDeniedRoots,
  agentConfigDirFromEnv,
  CAIRNWEAVE_HOME_DIR,
  DEFAULT_AGENT_CONFIG_DIR,
  isDefaultAgentConfigDir,
  LEGACY_AGENT_CONFIG_DIR,
  migrateAgentConfigDir,
} from "./agent-config-dir";

const previousConfigDir = process.env["CAIRN_AGENT_CONFIG_DIR"];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cairn-agent-config-"));
}

test("the default config directory lives under the project home", () => {
  expect(DEFAULT_AGENT_CONFIG_DIR).toBe(join(CAIRNWEAVE_HOME_DIR, "config"));
  expect(isDefaultAgentConfigDir(DEFAULT_AGENT_CONFIG_DIR)).toBe(true);
  expect(isDefaultAgentConfigDir(LEGACY_AGENT_CONFIG_DIR)).toBe(false);
});

test("CAIRN_AGENT_CONFIG_DIR wins over the default", () => {
  const dir = tempDir();
  try {
    process.env["CAIRN_AGENT_CONFIG_DIR"] = dir;
    expect(agentConfigDirFromEnv()).toBe(dir);
  } finally {
    if (previousConfigDir === undefined) delete process.env["CAIRN_AGENT_CONFIG_DIR"];
    else process.env["CAIRN_AGENT_CONFIG_DIR"] = previousConfigDir;
    rmSync(dir, { recursive: true, force: true });
  }
  process.env["CAIRN_AGENT_CONFIG_DIR"] = "  ";
  expect(agentConfigDirFromEnv()).toBe(DEFAULT_AGENT_CONFIG_DIR);
  if (previousConfigDir === undefined) delete process.env["CAIRN_AGENT_CONFIG_DIR"];
  else process.env["CAIRN_AGENT_CONFIG_DIR"] = previousConfigDir;
});

test("both config generations and the deployment override are denied roots", () => {
  const dir = tempDir();
  process.env["CAIRN_AGENT_CONFIG_DIR"] = dir;
  try {
    const roots = agentConfigDeniedRoots().map((path) => resolve(path));
    expect(roots).toContain(CAIRNWEAVE_HOME_DIR);
    expect(roots).toContain(DEFAULT_AGENT_CONFIG_DIR);
    expect(roots).toContain(LEGACY_AGENT_CONFIG_DIR);
    expect(roots).toContain(resolve(dir));
    expect(new Set(roots).size).toBe(roots.length);
  } finally {
    if (previousConfigDir === undefined) delete process.env["CAIRN_AGENT_CONFIG_DIR"];
    else process.env["CAIRN_AGENT_CONFIG_DIR"] = previousConfigDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migration copies the legacy tree once and leaves it in place", async () => {
  const root = tempDir();
  try {
    const legacy = join(root, ".tch-agent", "config");
    const target = join(root, ".cairnweave", "config");
    mkdirSync(join(legacy, "skills", "web-scan"), { recursive: true });
    mkdirSync(join(legacy, "empty-dir"), { recursive: true });
    writeFileSync(join(legacy, "auth.json"), '{"api_key":"secret"}', "utf8");
    writeFileSync(join(legacy, "skills", "web-scan", "SKILL.md"), "# skill", "utf8");

    const messages: string[] = [];
    expect(await migrateAgentConfigDir({ legacyDir: legacy, targetDir: target, log: (m) => messages.push(m) })).toBe(true);

    expect(readFileSync(join(target, "auth.json"), "utf8")).toContain("secret");
    expect(readFileSync(join(target, "skills", "web-scan", "SKILL.md"), "utf8")).toBe("# skill");
    expect(readFileSync(join(legacy, "auth.json"), "utf8")).toContain("secret");
    expect(messages.join("\n")).toContain("the legacy directory is unchanged");

    // A second run is a no-op: the target already holds files and nothing is overwritten.
    writeFileSync(join(target, "auth.json"), "{}", "utf8");
    expect(await migrateAgentConfigDir({ legacyDir: legacy, targetDir: target })).toBe(false);
    expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("{}");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration skips a missing legacy directory and an empty copy stays silent", async () => {
  const root = tempDir();
  try {
    const legacy = join(root, ".tch-agent", "config");
    const target = join(root, ".cairnweave", "config");
    expect(await migrateAgentConfigDir({ legacyDir: legacy, targetDir: target })).toBe(false);

    mkdirSync(legacy, { recursive: true });
    expect(await migrateAgentConfigDir({ legacyDir: legacy, targetDir: target })).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration refuses to copy a directory into itself", async () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "auth.json"), "{}", "utf8");
    expect(
      await migrateAgentConfigDir({
        legacyDir: join(root, "config"),
        targetDir: join(root, "config"),
      }),
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The repo's own live config directory is project content for prompts and skills only, so the
// git rules are part of the contract: credentials must stay out even if a new secret-named file
// appears, and the seeded content must be visible in `git status`.
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SECRET_FILES = [
  "agent-config/auth.json",
  "agent-config/models.json",
  "agent-config/provider-prefs.json",
  "agent-config/model-prefs.json",
];
const CONTENT_FILES = [
  "agent-config/settings.json",
  "agent-config/prompts/cairn-worker.md",
  "agent-config/prompts/CHALLENGE_PLANNER.md",
  "agent-config/skills/recon/SKILL.md",
];

function gitLines(args: string[]): string[] | null {
  if (Bun.which("git") === null) return null;
  const result = Bun.spawnSync(["git", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode > 1) return null;
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

test("git ignores every credential file but none of the prompt or skill content", () => {
  const ignored = gitLines(["check-ignore", ...SECRET_FILES, ...CONTENT_FILES, ".cairnweave/config/auth.json"]);
  if (ignored === null) return;
  const set = new Set(ignored);
  for (const path of SECRET_FILES) expect(set.has(path)).toBe(true);
  // The pre-move location keeps its rule, so a stray default dir never leaks either.
  expect(set.has(".cairnweave/config/auth.json")).toBe(true);
  for (const path of CONTENT_FILES) expect(set.has(path)).toBe(false);
});

test("the live prompts, skills and settings are listed as repository content", () => {
  const listed = gitLines(["ls-files", "-co", "--exclude-standard", "--", "agent-config"]);
  if (listed === null) return;
  const set = new Set(listed);
  for (const path of CONTENT_FILES) expect(set.has(path)).toBe(true);
  for (const path of SECRET_FILES) expect(set.has(path)).toBe(false);
  expect([...set].filter((path) => path.startsWith("agent-config/skills/")).length).toBeGreaterThan(50);
});
