/**
 * Best-effort flag extraction for the project view.
 *
 * CTF flags are produced by workers and end up in artifacts, but the shareable project
 * report deliberately omits artifact contents. This scanner therefore reads only the
 * indexed artifacts under `<workspace>/artifacts/`, rejects paths that escape that
 * directory (including symlinked parents), skips binary files, and caps files, bytes and
 * line length so a hostile or huge workspace cannot pin the HTTP handler.
 *
 * Older workers redacted captured flags inside artifacts after the prompt asked them not
 * to paste flag values. Those artifacts now only contain placeholders, so when no real
 * flag is found there the scanner falls back to the worker solver-session JSONL logs,
 * where tool output still holds the exact value. The fallback is read-only and returns
 * only flag strings and session paths, never log contents.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_LINE_LENGTH = 8 * 1024;
const SESSION_MAX_FILES = 64;
const SESSION_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SESSION_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const FLAG_PATTERN = /([A-Za-z0-9_-]{1,64})\{([^{}\s]{4,200})\}/g;
const PLACEHOLDER_BODIES = new Set([
  "flag",
  "example",
  "placeholder",
  "redacted",
  "todo",
  "your_flag",
  "flag_here",
  "changeme",
]);

export interface FlagArtifact {
  path: string;
  size: number;
}

export interface FlagScanOptions {
  /** Host path of the project workspace. */
  workspace: string;
  artifacts: ReadonlyArray<FlagArtifact>;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface SessionFlagScanOptions {
  /** Host path of the project workspace. */
  workspace: string;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface ProjectFlagMatch {
  flag: string;
  source: string;
  occurrences: number;
  sources: string[];
}

export interface ProjectFlagResult {
  found: boolean;
  flag: string | null;
  source: string | null;
  occurrences: number;
  sources: string[];
  scanned_files: number;
  truncated: boolean;
}

export function emptyFlagResult(): ProjectFlagResult {
  return {
    found: false,
    flag: null,
    source: null,
    occurrences: 0,
    sources: [],
    scanned_files: 0,
    truncated: false,
  };
}

export function scanProjectFlag(options: FlagScanOptions): ProjectFlagResult {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const root = resolve(options.workspace, "artifacts");

  let realRoot: string;
  try {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return emptyFlagResult();
    realRoot = realpathSync(root);
  } catch {
    return emptyFlagResult();
  }

  const matches = new Map<string, ProjectFlagMatch>();
  let scannedFiles = 0;
  let totalBytes = 0;
  let truncated = false;

  for (const artifact of options.artifacts) {
    if (scannedFiles >= maxFiles || totalBytes >= maxTotalBytes) {
      truncated = true;
      break;
    }
    const target = resolveArtifact(realRoot, artifact.path, maxFileBytes);
    if (target === null) continue;

    let content: string;
    try {
      const stats = lstatSync(target);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      if (stats.size === 0 || stats.size > maxFileBytes) continue;
      if (totalBytes + stats.size > maxTotalBytes) {
        truncated = true;
        break;
      }
      const buffer = readFileSync(target);
      if (buffer.includes(0)) continue;
      content = buffer.toString("utf8");
      totalBytes += stats.size;
      scannedFiles += 1;
    } catch {
      continue;
    }

    const path = normalizePath(artifact.path);
    for (const flag of findFlags(content)) {
      const existing = matches.get(flag);
      if (existing === undefined) {
        matches.set(flag, {
          flag,
          source: path,
          occurrences: 1,
          sources: [path],
        });
        continue;
      }
      existing.occurrences += 1;
      if (!existing.sources.includes(path)) existing.sources.push(path);
    }
  }

  return rankMatches(matches, scannedFiles, truncated);
}

/**
 * Recovers a captured flag from worker solver-session logs. Used only when artifacts
 * hold nothing but placeholders, because the logs keep the raw tool output.
 */
export function scanSolverSessionFlags(options: SessionFlagScanOptions): ProjectFlagResult {
  const maxFiles = options.maxFiles ?? SESSION_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? SESSION_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? SESSION_MAX_TOTAL_BYTES;
  const root = resolve(options.workspace, ".cairn", "sessions");

  let realRoot: string;
  try {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return emptyFlagResult();
    realRoot = realpathSync(root);
  } catch {
    return emptyFlagResult();
  }

  let sessionNames: string[];
  try {
    sessionNames = readdirSync(realRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return emptyFlagResult();
  }

  const matches = new Map<string, ProjectFlagMatch>();
  let scannedFiles = 0;
  let totalBytes = 0;
  let truncated = false;

  for (const name of sessionNames) {
    if (scannedFiles >= maxFiles || totalBytes >= maxTotalBytes) {
      truncated = true;
      break;
    }
    const sessionDir = resolve(realRoot, name);
    if (!isInside(realRoot, sessionDir)) continue;
    const solverDir = resolve(sessionDir, "solver-session");
    let realSolverDir: string;
    try {
      const stats = lstatSync(solverDir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      realSolverDir = realpathSync(solverDir);
      if (!isInside(realRoot, realSolverDir)) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(realSolverDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl"),
        )
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }

    for (const file of files) {
      if (scannedFiles >= maxFiles || totalBytes >= maxTotalBytes) {
        truncated = true;
        break;
      }
      const target = resolve(realSolverDir, file);
      let content: string;
      try {
        const stats = lstatSync(target);
        if (!stats.isFile() || stats.isSymbolicLink()) continue;
        if (stats.size === 0 || stats.size > maxFileBytes) continue;
        if (totalBytes + stats.size > maxTotalBytes) {
          truncated = true;
          break;
        }
        const realTarget = realpathSync(target);
        if (!isInside(realRoot, realTarget)) continue;
        const buffer = readFileSync(target);
        if (buffer.includes(0)) continue;
        content = buffer.toString("utf8");
        totalBytes += stats.size;
        scannedFiles += 1;
      } catch {
        continue;
      }

      const path = `.cairn/sessions/${name}/solver-session/${file}`;
      for (const flag of findFlags(content, maxFileBytes)) {
        const existing = matches.get(flag);
        if (existing === undefined) {
          matches.set(flag, {
            flag,
            source: path,
            occurrences: 1,
            sources: [path],
          });
          continue;
        }
        existing.occurrences += 1;
        if (!existing.sources.includes(path)) existing.sources.push(path);
      }
    }
  }

  return rankMatches(matches, scannedFiles, truncated);
}

function rankMatches(
  matches: Map<string, ProjectFlagMatch>,
  scannedFiles: number,
  truncated: boolean,
): ProjectFlagResult {
  const ranked = [...matches.values()].sort(
    (left, right) =>
      right.sources.length - left.sources.length ||
      right.occurrences - left.occurrences ||
      right.flag.length - left.flag.length ||
      left.flag.localeCompare(right.flag),
  );
  const best = ranked[0];
  if (best === undefined) {
    return { ...emptyFlagResult(), scanned_files: scannedFiles, truncated };
  }
  return {
    found: true,
    flag: best.flag,
    source: best.source,
    occurrences: best.occurrences,
    sources: best.sources,
    scanned_files: scannedFiles,
    truncated,
  };
}

export function findFlags(content: string, maxLineLength: number = MAX_LINE_LENGTH): string[] {
  const found: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const scoped = line.length > maxLineLength ? line.slice(0, maxLineLength) : line;
    for (const match of scoped.matchAll(FLAG_PATTERN)) {
      const prefix = match[1]!.toLowerCase();
      if (prefix !== "flag" && !prefix.endsWith("flag") && !prefix.includes("ctf")) continue;
      const body = match[2]!;
      if (isPlaceholder(body)) continue;
      found.push(`${match[1]}{${body}}`);
    }
  }
  return found;
}

function isPlaceholder(body: string): boolean {
  const lower = body.toLowerCase();
  if (PLACEHOLDER_BODIES.has(lower)) return true;
  if (lower.includes("redact") || lower.includes("masked") || lower.includes("hidden")) return true;
  if (/^[._-]+$/.test(body)) return true;
  if (/^x+$/i.test(body)) return true;
  if (/^\[.*\]$/.test(body)) return true;
  return body.includes("<") || body.includes(">");
}

function resolveArtifact(realRoot: string, raw: string, maxFileBytes: number): string | null {
  if (raw.length === 0 || raw.length > 512 || raw.includes("\0")) return null;
  const normalized = normalizePath(raw);
  if (normalized === "" || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;

  const target = resolve(realRoot, ...segments);
  try {
    const stats = lstatSync(target);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    if (stats.size > maxFileBytes) return null;
    const realTarget = realpathSync(target);
    if (!isInside(realRoot, realTarget)) return null;
    return target;
  } catch {
    return null;
  }
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").trim();
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return true;
}
