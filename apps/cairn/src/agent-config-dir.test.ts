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
