import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Cairnweave's own agent configuration home. Model credentials, prompts and skills live
 * under `config/` so the directory can be mounted read-only into a worker container.
 */
export const CAIRNWEAVE_HOME_DIR = resolve(homedir(), ".cairnweave");
export const DEFAULT_AGENT_CONFIG_DIR = join(CAIRNWEAVE_HOME_DIR, "config");

/** Pre-Cairnweave location (BreachWeave). Kept as a migration source and a denied root. */
export const LEGACY_AGENT_HOME_DIR = resolve(homedir(), ".tch-agent");
export const LEGACY_AGENT_CONFIG_DIR = join(LEGACY_AGENT_HOME_DIR, "config");

const MAX_MIGRATION_BYTES = 64 * 1024 * 1024;

/** `CAIRN_AGENT_CONFIG_DIR` when set, otherwise the Cairnweave default. */
export function agentConfigDirFromEnv(): string {
  const fromEnv = process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim();
  return fromEnv === undefined || fromEnv === "" ? DEFAULT_AGENT_CONFIG_DIR : fromEnv;
}

/**
 * True when a resolved directory is the Cairnweave default. Migration only applies then:
 * an explicit `CAIRN_AGENT_CONFIG_DIR` is the operator's own directory, so copying the
 * legacy home into it would surprise a deliberate deployment choice.
 */
export function isDefaultAgentConfigDir(configDir: string): boolean {
  return resolve(configDir) === DEFAULT_AGENT_CONFIG_DIR;
}

/**
 * Roots the Host Bridge must never let a tool read or write: both config generations and
 * the explicit deployment directory. Workers keep model credentials out of tool access.
 */
export function agentConfigDeniedRoots(): string[] {
  return [
    CAIRNWEAVE_HOME_DIR,
    DEFAULT_AGENT_CONFIG_DIR,
    LEGACY_AGENT_HOME_DIR,
    LEGACY_AGENT_CONFIG_DIR,
    agentConfigDirFromEnv(),
  ]
    .map((path) => resolve(path))
    .filter((path, index, all) => all.indexOf(path) === index);
}

export interface MigrateOptions {
  legacyDir?: string;
  targetDir?: string;
  log?: (message: string) => void;
}

async function walk(root: string, current: string): Promise<string[]> {
  const entries = await readdir(join(root, current), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = current === "" ? entry.name : `${current}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walk(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

/**
 * Copies the legacy `~/.tch-agent/config` into `~/.cairnweave/config` the first time the
 * new directory is used. The legacy directory is never modified, an existing file is
 * never overwritten, and symlinks are skipped, so a failed migration stays recoverable.
 * Callers guard with `isDefaultAgentConfigDir`.
 */
export async function migrateAgentConfigDir(options: MigrateOptions = {}): Promise<boolean> {
  const target = resolve(options.targetDir ?? DEFAULT_AGENT_CONFIG_DIR);
  const legacy = resolve(options.legacyDir ?? LEGACY_AGENT_CONFIG_DIR);
  const log = options.log ?? (() => {});

  if (target === legacy) return false;
  if (!existsSync(legacy)) return false;
  if (existsSync(target) && (await readdir(target).catch(() => ["occupied"])).length > 0) {
    return false;
  }

  let copied = 0;
  let bytes = 0;
  for (const relative of await walk(legacy, "")) {
    const source = join(legacy, relative);
    const destination = join(target, relative);
    const info = await lstat(source).catch(() => null);
    if (info === null || !info.isFile()) continue;
    if (bytes + info.size > MAX_MIGRATION_BYTES) {
      log(`agent config migration stopped at the ${MAX_MIGRATION_BYTES} byte limit`);
      break;
    }
    if (existsSync(destination)) continue;
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(source, destination);
    copied += 1;
    bytes += info.size;
  }

  if (copied > 0) {
    log(`copied ${copied} agent config file(s) from ${legacy} to ${target}; the legacy directory is unchanged`);
  }
  return copied > 0;
}
