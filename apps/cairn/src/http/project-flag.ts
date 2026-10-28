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
 *
 * The fallback reads tool results only. A model narrating its own progress writes truncated
 * or guessed flag shapes (`CTF2{c8xxxx}`, `CTF2{c8...}`) into assistant messages, and those
 * strings would otherwise outrank the real value that a tool returned earlier. Anything the
 * scanner rejects as a mask is still reported through `placeholder_suspect` and `candidates`
 * so the UI can say "flag-shaped text seen, none of it trustworthy" instead of going quiet.
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
/** Marks a model uses when it abbreviates a value: `c8...`, `c8…`, `c8xxx`, `**`. */
const MASK_MARK = /(\.{2,}|…|\*{2,}|x{3,})/i;
/** Stand-in words for a value, matched on segments so `fragmented` stays a real word. */
const MASK_WORD =
  /(^|[^a-z])(uuid|guid|frag|partial|truncat\w*|sample|dummy|tbd|unknown|missing)([^a-z]|$)/;
const MAX_CANDIDATES = 3;

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

/** One ranked flag-shaped string, with how much evidence stands behind it. */
export interface FlagCandidate {
  value: string;
  occurrences: number;
  /** Number of distinct files this value was seen in. */
  sources: number;
  /** True when the value was rejected as a mask or redaction placeholder. */
  placeholder: boolean;
}

export interface ProjectFlagResult {
  found: boolean;
  flag: string | null;
  source: string | null;
  occurrences: number;
  sources: string[];
  scanned_files: number;
  truncated: boolean;
  /** Top values that passed the placeholder filter, or the masks when none did. */
  candidates: FlagCandidate[];
  /** Flag-shaped text was seen, but every value looked like a mask or redaction. */
  placeholder_suspect: boolean;
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
    candidates: [],
    placeholder_suspect: false,
  };
}

export function scanProjectFlag(options: FlagScanOptions): ProjectFlagResult {
  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  const realRoot = openArtifactRoot(options.workspace);
  if (realRoot === null) return emptyFlagResult();

  const groups = newFlagGroups();
  let scannedFiles = 0;
  let totalBytes = 0;
  let truncated = false;

  for (const artifact of options.artifacts) {
    if (scannedFiles >= maxFiles || totalBytes >= maxTotalBytes) {
      truncated = true;
      break;
    }
    if (artifact.size === 0 || artifact.size > maxFileBytes) continue;
    if (totalBytes + artifact.size > maxTotalBytes) {
      truncated = true;
      break;
    }
    const file = readArtifactFile(realRoot, artifact.path, maxFileBytes);
    if (file === null || file.includes(0) || file.length === 0) continue;
    const content = file.toString("utf8");
    totalBytes += file.length;
    scannedFiles += 1;

    recordFlags(groups, content, normalizePath(artifact.path));
  }

  return rankMatches(groups, scannedFiles, truncated);
}

/**
 * Recovers a captured flag from worker solver-session logs. Used only when artifacts
 * hold nothing but placeholders, because the logs keep the raw tool output.
 *
 * Only `toolResult` entries are scanned: assistant messages are where the model narrates
 * truncated guesses, and those must not compete with what a tool really printed.
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

  const groups = newFlagGroups();
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
      for (const line of content.split(/\r?\n/)) {
        if (line.length === 0) continue;
        const text = sessionToolText(line);
        if (text === null) continue;
        recordFlags(groups, text, path);
      }
    }
  }

  return rankMatches(groups, scannedFiles, truncated);
}

/**
 * Artifact scan first, then the solver-session fallback. Shared by `/flag` and the writeup
 * draft so the two views can never disagree about which flag was captured.
 */
export function collectProjectFlag(
  options: FlagScanOptions & SessionFlagScanOptions,
): ProjectFlagResult {
  const artifactResult = scanProjectFlag(options);
  if (artifactResult.found) return artifactResult;
  const sessionResult = scanSolverSessionFlags(options);
  const combined: ProjectFlagResult = {
    ...sessionResult,
    scanned_files: artifactResult.scanned_files + sessionResult.scanned_files,
    truncated: artifactResult.truncated || sessionResult.truncated,
  };
  if (combined.found) return combined;
  // Nothing trustworthy anywhere: report the masks both scans saw, artifacts first.
  const candidates = mergeCandidates(artifactResult.candidates, sessionResult.candidates);
  return { ...combined, candidates, placeholder_suspect: candidates.length > 0 };
}

interface FlagGroups {
  accepted: Map<string, ProjectFlagMatch>;
  suspects: Map<string, ProjectFlagMatch>;
}

function newFlagGroups(): FlagGroups {
  return { accepted: new Map(), suspects: new Map() };
}

function recordFlags(groups: FlagGroups, content: string, path: string): void {
  for (const sighting of classifyFlags(content)) {
    recordMatch(sighting.placeholder ? groups.suspects : groups.accepted, sighting.flag, path);
  }
}

function recordMatch(
  matches: Map<string, ProjectFlagMatch>,
  flag: string,
  path: string,
): void {
  const existing = matches.get(flag);
  if (existing === undefined) {
    matches.set(flag, { flag, source: path, occurrences: 1, sources: [path] });
    return;
  }
  existing.occurrences += 1;
  if (!existing.sources.includes(path)) existing.sources.push(path);
}

/**
 * Pulls tool output out of one solver-session JSONL entry, or null when the entry is not a
 * tool result. `content` is either a string or blocks; only text blocks count.
 */
function sessionToolText(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const message = (entry as { message?: unknown })?.message;
  if (typeof message !== "object" || message === null) return null;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "toolResult") return null;
  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(
      (block): block is { text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  return text === "" ? null : text;
}

function rankMatches(
  groups: FlagGroups,
  scannedFiles: number,
  truncated: boolean,
): ProjectFlagResult {
  const accepted = rankList(groups.accepted);
  const suspects = rankList(groups.suspects);
  const best = accepted[0] ?? null;
  const candidates = (accepted.length > 0 ? accepted : suspects)
    .slice(0, MAX_CANDIDATES)
    .map((match) => toCandidate(match, accepted.length === 0));
  return {
    found: best !== null,
    flag: best === null ? null : best.flag,
    source: best === null ? null : best.source,
    occurrences: best === null ? 0 : best.occurrences,
    sources: best === null ? [] : best.sources,
    scanned_files: scannedFiles,
    truncated,
    candidates,
    placeholder_suspect: best === null && suspects.length > 0,
  };
}

function rankList(matches: Map<string, ProjectFlagMatch>): ProjectFlagMatch[] {
  return [...matches.values()].sort(
    (left, right) =>
      right.sources.length - left.sources.length ||
      right.occurrences - left.occurrences ||
      right.flag.length - left.flag.length ||
      left.flag.localeCompare(right.flag),
  );
}

function toCandidate(match: ProjectFlagMatch, placeholder: boolean): FlagCandidate {
  return {
    value: match.flag,
    occurrences: match.occurrences,
    sources: match.sources.length,
    placeholder,
  };
}

function mergeCandidates(left: FlagCandidate[], right: FlagCandidate[]): FlagCandidate[] {
  const merged = new Map<string, FlagCandidate>();
  for (const candidate of [...left, ...right]) {
    const existing = merged.get(candidate.value);
    if (existing === undefined) {
      merged.set(candidate.value, { ...candidate });
      continue;
    }
    existing.occurrences += candidate.occurrences;
    existing.sources += candidate.sources;
  }
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.sources - a.sources || b.occurrences - a.occurrences || a.value.localeCompare(b.value),
    )
    .slice(0, MAX_CANDIDATES);
}

export function findFlags(content: string, maxLineLength: number = MAX_LINE_LENGTH): string[] {
  return classifyFlags(content, maxLineLength)
    .filter((sighting) => !sighting.placeholder)
    .map((sighting) => sighting.flag);
}

/** Every flag-shaped string in `content`, marked as a mask when it looks redacted or truncated. */
function classifyFlags(
  content: string,
  maxLineLength: number = MAX_LINE_LENGTH,
): Array<{ flag: string; placeholder: boolean }> {
  const found: Array<{ flag: string; placeholder: boolean }> = [];
  for (const line of content.split(/\r?\n/)) {
    const scoped = line.length > maxLineLength ? line.slice(0, maxLineLength) : line;
    for (const match of scoped.matchAll(FLAG_PATTERN)) {
      const prefix = match[1]!.toLowerCase();
      if (prefix !== "flag" && !prefix.endsWith("flag") && !prefix.includes("ctf")) continue;
      const body = match[2]!;
      found.push({ flag: `${match[1]}{${body}}`, placeholder: isPlaceholder(body) });
    }
  }
  return found;
}

function isPlaceholder(body: string): boolean {
  const lower = body.toLowerCase();
  if (PLACEHOLDER_BODIES.has(lower)) return true;
  if (lower.includes("redact") || lower.includes("masked") || lower.includes("hidden")) return true;
  if (MASK_MARK.test(body)) return true;
  if (MASK_WORD.test(lower)) return true;
  if (/^[._-]+$/.test(body)) return true;
  if (/^\[.*\]$/.test(body)) return true;
  return body.includes("<") || body.includes(">");
}

/** Realpath of `<workspace>/artifacts`; null when it is absent, symlinked or not a directory. */
export function openArtifactRoot(workspace: string): string | null {
  const root = resolve(workspace, "artifacts");
  try {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
    return realpathSync(root);
  } catch {
    return null;
  }
}

/**
 * Reads one indexed artifact: a regular non-symlink file that stays inside `realRoot` and
 * is at most `maxFileBytes` on disk. Returns null when any check fails.
 */
export function readArtifactFile(realRoot: string, rawPath: string, maxFileBytes: number): Buffer | null {
  const target = resolveArtifact(realRoot, rawPath, maxFileBytes);
  if (target === null) return null;
  try {
    return readFileSync(target);
  } catch {
    return null;
  }
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
