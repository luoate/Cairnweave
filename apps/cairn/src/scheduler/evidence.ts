/**
 * Evidence refs arrive from an untrusted worker result. They are paths relative to the
 * project workspace that must name real, regular files inside it. Symlinks (including a
 * symlinked parent directory) are rejected so a worker cannot point the control plane at
 * host files outside the sandbox. Accepted files are hashed so later readers can detect
 * replacement or deletion.
 */

import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  hashFileSha256,
  type EvidenceFileStatus,
  type FactEvidenceFile,
  type VerifiedFactEvidence,
} from "@cairn/graph";

const MAX_EVIDENCE_REFS = 20;
const MAX_REF_LENGTH = 512;

export type EvidenceStatus = "provided" | "missing";

export interface EvidenceIssue {
  ref: string;
  reason: string;
}

export interface EvidenceFile {
  path: string;
  size: number;
  sha256: string;
}

export interface EvidenceCollection {
  status: EvidenceStatus;
  refs: string[];
  files: EvidenceFile[];
  invalid: EvidenceIssue[];
}

export function collectEvidence(
  refs: readonly string[] | undefined,
  workspace: string,
): EvidenceCollection {
  if (refs === undefined || refs.length === 0) {
    return { status: "missing", refs: [], files: [], invalid: [] };
  }
  if (refs.length > MAX_EVIDENCE_REFS) {
    return {
      status: "missing",
      refs: [],
      files: [],
      invalid: [{ ref: "", reason: `too many evidence refs (max ${MAX_EVIDENCE_REFS})` }],
    };
  }

  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    return {
      status: "missing",
      refs: [],
      files: [],
      invalid: [{ ref: "", reason: "workspace is not readable" }],
    };
  }

  const seen = new Set<string>();
  const files: EvidenceFile[] = [];
  const invalid: EvidenceIssue[] = [];
  for (const raw of refs) {
    const checked = checkRef(raw, realWorkspace);
    if ("reason" in checked) {
      invalid.push({ ref: raw, reason: checked.reason });
      continue;
    }
    if (seen.has(checked.file.path)) continue;
    seen.add(checked.file.path);
    files.push(checked.file);
  }
  return {
    status: files.length === 0 ? "missing" : "provided",
    refs: files.map((file) => file.path),
    files,
    invalid,
  };
}

/** Compares stored digests with the current workspace files without touching the database. */
export function verifyEvidenceFiles(
  files: readonly FactEvidenceFile[],
  workspace: string,
): VerifiedFactEvidence[] {
  let realWorkspace: string | null = null;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    // Fall through: every entry is reported as unreadable.
  }

  return files.map((stored) => {
    if (realWorkspace === null) {
      return {
        ...stored,
        status: "unreadable" as const,
        current_size: null,
        current_sha256: null,
      };
    }
    const checked = checkRef(stored.path, realWorkspace);
    if ("reason" in checked) {
      return {
        ...stored,
        status: statusForReason(checked.reason),
        current_size: null,
        current_sha256: null,
      };
    }
    const current = checked.file;
    return {
      ...stored,
      status:
        current.size === stored.size && current.sha256 === stored.sha256
          ? ("ok" as const)
          : ("modified" as const),
      current_size: current.size,
      current_sha256: current.sha256,
    };
  });
}

type RefResult = { file: EvidenceFile } | { reason: string };

function checkRef(raw: string, realWorkspace: string): RefResult {
  if (raw.length > MAX_REF_LENGTH) return { reason: "path is too long" };
  const normalized = raw.replaceAll("\\", "/").trim();
  if (normalized === "") return { reason: "path is empty" };
  if (normalized.includes("\0")) return { reason: "path contains NUL" };
  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
    return { reason: "path must be relative to the workspace" };
  }

  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return { reason: "path is empty" };
  if (segments.includes("..")) return { reason: "path escapes the workspace" };
  const ref = segments.join("/");

  const target = resolve(realWorkspace, ...segments);
  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) return { reason: "symlinks are not accepted as evidence" };
    if (!stats.isFile()) return { reason: "evidence must be a regular file" };
  } catch {
    return { reason: "file does not exist" };
  }

  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return { reason: "file is not readable" };
  }
  if (!isInside(realWorkspace, realTarget)) {
    return { reason: "resolved path escapes the workspace" };
  }

  let sha256: string;
  try {
    sha256 = hashFileSha256(realTarget);
    return { file: { path: ref, size: lstatSync(realTarget).size, sha256 } };
  } catch {
    return { reason: "file is not readable" };
  }
}

function statusForReason(reason: string): EvidenceFileStatus {
  if (reason === "file does not exist") return "missing";
  if (reason === "file is not readable" || reason === "workspace is not readable") {
    return "unreadable";
  }
  return "invalid";
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false;
  }
  return true;
}
