/**
 * Payload text for the Chinese writeup (M20a).
 *
 * The graph module decides *which* indexed artifacts are payloads (`isWriteupPayloadPath`)
 * and renders them; this module only supplies the bytes, because reading files needs the
 * host workspace. Every read goes through the artifact path checks used by the flag scanner:
 * regular non-symlink file, inside `<workspace>/artifacts`, under the per-file cap.
 *
 * A file is reported as binary when its bytes contain NUL, so the writeup records the path
 * without inlining it. Files that cannot be read at all are simply omitted; the writeup then
 * says the content was not read instead of pretending the payload was empty.
 */

import {
  MAX_WRITEUP_PAYLOAD_CHARS,
  type WriteupPayloadContent,
} from "@cairn/graph";

import { openArtifactRoot, readArtifactFile } from "./project-flag";

/** Read window per file: large enough for scripts, small enough to bound the handler. */
const MAX_PAYLOAD_FILE_BYTES = 128 * 1024;
const MAX_PAYLOAD_TOTAL_CHARS = 24_000;

export interface WriteupPayloadScanOptions {
  /** Host path of the project workspace. */
  workspace: string;
  /** Payload artifacts already selected and capped by `selectWriteupPayloadArtifacts`. */
  artifacts: ReadonlyArray<{ path: string }>;
}

export function collectWriteupPayloads(
  options: WriteupPayloadScanOptions,
): WriteupPayloadContent[] {
  const realRoot = openArtifactRoot(options.workspace);
  if (realRoot === null) return [];

  const contents: WriteupPayloadContent[] = [];
  let usedChars = 0;
  for (const artifact of options.artifacts) {
    if (usedChars >= MAX_PAYLOAD_TOTAL_CHARS) break;
    const buffer = readArtifactFile(realRoot, artifact.path, MAX_PAYLOAD_FILE_BYTES);
    if (buffer === null) continue;
    if (buffer.includes(0)) {
      contents.push({ path: artifact.path, binary: true, text: null, truncated: false });
      continue;
    }
    const budget = Math.min(MAX_WRITEUP_PAYLOAD_CHARS, MAX_PAYLOAD_TOTAL_CHARS - usedChars);
    const text = buffer.toString("utf8");
    const inline = text.length > budget ? text.slice(0, budget) : text;
    usedChars += inline.length;
    contents.push({
      path: artifact.path,
      binary: false,
      text: inline,
      truncated: inline.length < text.length,
    });
  }
  return contents;
}
