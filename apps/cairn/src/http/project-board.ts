/**
 * Read-only view of the Observer board.
 *
 * The board lives inside the worker workspace at `.cairn/board/board/` (ideas index and
 * one JSON file per memory entry). The main solver can only read it through its tools;
 * this reader gives the UI the same view without exposing writes. Every path is checked
 * to be a real directory inside the workspace, symlinks are rejected, and files, entries
 * and text are capped so a hostile workspace cannot pin the HTTP handler.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const BOARD_NAMESPACE = "board";
const MAX_IDEAS = 200;
const MAX_MEMORY = 200;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 4000;
const MAX_REFS = 20;
const MAX_REF_LENGTH = 512;
const IDEA_STATUSES = new Set(["pending", "testing", "verified", "failed", "skipped"]);
const MEMORY_KINDS = new Set(["fact", "evidence", "failure", "note", "hint"]);

export interface BoardIdea {
  id: string;
  status: string;
  content: string;
  result: string;
  created_at: string;
  updated_at: string;
}

export interface BoardMemory {
  id: string;
  kind: string;
  content: string;
  refs: string[];
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectBoard {
  /** True when a board directory exists and was read. Missing boards are normal. */
  available: boolean;
  ideas: BoardIdea[];
  memory: BoardMemory[];
  ideas_total: number;
  memory_total: number;
  /** At least one entry or field was clipped or skipped by the read caps. */
  truncated: boolean;
}

export function emptyProjectBoard(): ProjectBoard {
  return { available: false, ideas: [], memory: [], ideas_total: 0, memory_total: 0, truncated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: string, max: number): { value: string; clipped: boolean } {
  if (value.length <= max) return { value, clipped: false };
  return { value: value.slice(0, max), clipped: true };
}

function within(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Returns the real path of a real directory inside the workspace, or null. */
function safeDirectory(path: string, workspaceReal: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const real = realpathSync(path);
    return within(workspaceReal, real) ? real : null;
  } catch {
    return null;
  }
}

function readJsonFile(path: string, limit: number): { data: unknown; bytes: number } | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) return null;
    const buffer = readFileSync(path);
    if (buffer.byteLength > limit) return null;
    return { data: JSON.parse(buffer.toString("utf8")) as unknown, bytes: buffer.byteLength };
  } catch {
    return null;
  }
}

function parseIdea(value: unknown): BoardIdea | null {
  if (!isRecord(value)) return null;
  const id = text(value["id"]).trim();
  const content = text(value["content"]).trim();
  if (id === "" || content === "") return null;
  const status = text(value["status"]);
  return {
    id: clip(id, 128).value,
    status: IDEA_STATUSES.has(status) ? status : "pending",
    content: clip(content, MAX_TEXT).value,
    result: clip(text(value["result"]).trim(), MAX_TEXT).value,
    created_at: text(value["created_at"]),
    updated_at: text(value["updated_at"]),
  };
}

function parseMemory(value: unknown): BoardMemory | null {
  if (!isRecord(value)) return null;
  const id = text(value["id"]).trim();
  const content = text(value["content"]).trim();
  if (id === "" || content === "") return null;
  const kind = text(value["kind"]);
  const refs = Array.isArray(value["refs"])
    ? value["refs"]
        .map((item) => clip(text(item).trim(), MAX_REF_LENGTH).value)
        .filter((item) => item !== "")
        .slice(0, MAX_REFS)
    : [];
  return {
    id: clip(id, 128).value,
    kind: MEMORY_KINDS.has(kind) ? kind : "note",
    content: clip(content, MAX_TEXT).value,
    refs,
    source: clip(text(value["source"]).trim(), 256).value,
    created_at: text(value["created_at"]),
    updated_at: text(value["updated_at"]),
  };
}

export function readProjectBoard(options: { workspace: string }): ProjectBoard {
  const result = emptyProjectBoard();
  let workspaceReal: string;
  try {
    const stat = lstatSync(options.workspace);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return result;
    workspaceReal = realpathSync(options.workspace);
  } catch {
    return result;
  }

  const boardDir = safeDirectory(resolve(options.workspace, ".cairn", BOARD_NAMESPACE, BOARD_NAMESPACE), workspaceReal);
  if (boardDir === null) return result;
  result.available = true;

  const ideasFile = resolve(boardDir, "ideas", "index.json");
  const index = readJsonFile(ideasFile, MAX_FILE_BYTES);
  if (index !== null && isRecord(index.data) && Array.isArray(index.data["items"])) {
    const raw = index.data["items"];
    result.ideas_total = raw.length;
    for (const item of raw) {
      if (result.ideas.length >= MAX_IDEAS) {
        result.truncated = true;
        break;
      }
      const idea = parseIdea(item);
      if (idea === null) {
        result.truncated = true;
        continue;
      }
      if (idea.content.length > MAX_TEXT || idea.result.length > MAX_TEXT) result.truncated = true;
      result.ideas.push(idea);
    }
  }

  const entriesDir = resolve(boardDir, "memory", "entries");
  let entries: string[] = [];
  try {
    entries = readdirSync(entriesDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    entries = [];
  }

  let totalBytes = 0;
  for (const name of entries) {
    if (result.memory.length >= MAX_MEMORY || totalBytes >= MAX_TOTAL_BYTES) {
      result.truncated = true;
      break;
    }
    const file = readJsonFile(resolve(entriesDir, name), Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes));
    if (file === null) {
      result.truncated = true;
      continue;
    }
    totalBytes += file.bytes;
    const entry = parseMemory(file.data);
    if (entry === null) {
      result.truncated = true;
      continue;
    }
    if (entry.content.length > MAX_TEXT) result.truncated = true;
    result.memory.push(entry);
  }
  result.memory_total = result.memory.length;
  return result;
}
