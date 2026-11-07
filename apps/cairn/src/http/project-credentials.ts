/**
 * Target credentials for the Chinese writeup (M54).
 *
 * A writeup is only reproducible if the credentials it used are readable, so workers record
 * the values recovered from an authorized target in `artifacts/<task>/credentials.txt`, one
 * `name = value` per line. The graph module decides how the lines are rendered; this module
 * only reads them, through the same artifact-path checks the flag scanner and the payload
 * reader use (regular non-symlink file inside `<workspace>/artifacts`, under the size cap).
 *
 * Reading is bounded on every axis: file count, per-file bytes, line count and total
 * characters. A missing or oversized file is skipped rather than reported as empty, so the
 * writeup says nothing rather than claiming the worker recorded no credentials.
 */

import { CREDENTIAL_FILE_NAME, type WriteupCredentialFile } from "@cairn/graph";

import { openArtifactRoot, readArtifactFile } from "./project-flag";

/** Per-file read window; a credential list is short, this only bounds a runaway file. */
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_FILES = 5;
const MAX_CREDENTIAL_LINES = 60;
const MAX_CREDENTIAL_LINE_CHARS = 400;
const MAX_CREDENTIAL_CHARS = 8_000;

export interface WriteupCredentialScanOptions {
  /** Host path of the project workspace. */
  workspace: string;
  /** Every indexed artifact; only `<task>/credentials.txt` paths are read. */
  artifacts: ReadonlyArray<{ path: string }>;
}

export function collectWriteupCredentials(
  options: WriteupCredentialScanOptions,
): WriteupCredentialFile[] {
  const matches = options.artifacts
    .map((artifact) => artifact.path)
    .filter(isCredentialPath)
    .sort();
  if (matches.length === 0) return [];
  const realRoot = openArtifactRoot(options.workspace);
  if (realRoot === null) return [];

  const files: WriteupCredentialFile[] = [];
  let usedChars = 0;
  for (const path of matches.slice(0, MAX_CREDENTIAL_FILES)) {
    if (usedChars >= MAX_CREDENTIAL_CHARS) break;
    const buffer = readArtifactFile(realRoot, path, MAX_CREDENTIAL_FILE_BYTES);
    if (buffer === null || buffer.includes(0)) continue;
    const parsed = parseCredentialLines(buffer.toString("utf8"), MAX_CREDENTIAL_CHARS - usedChars);
    if (parsed.lines.length === 0) continue;
    usedChars += parsed.lines.reduce((total, line) => total + line.length, 0);
    files.push({ path, lines: parsed.lines, truncated: parsed.truncated });
  }
  return files;
}

function isCredentialPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return name === CREDENTIAL_FILE_NAME;
}

/**
 * Trims, drops blanks and `#` comments, folds duplicates and applies the line/char caps.
 * Values stay exactly as written: no masking, no truncation inside a line under the limit.
 */
function parseCredentialLines(
  text: string,
  charBudget: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  const seen = new Set<string>();
  let usedChars = 0;
  let truncated = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.length > MAX_CREDENTIAL_LINE_CHARS) {
      truncated = true;
      continue;
    }
    if (seen.has(line)) continue;
    if (lines.length >= MAX_CREDENTIAL_LINES || usedChars + line.length > charBudget) {
      truncated = true;
      break;
    }
    seen.add(line);
    lines.push(line);
    usedChars += line.length;
  }
  return { lines, truncated };
}
