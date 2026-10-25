/**
 * Tolerant JSON-object extraction, ported from Cairn's `dispatcher/output_parser.py`.
 *
 * Solver output may contain prose or Markdown fences around the JSON answer. Cairn tries
 * the whole text first, then each fenced block, and inside each segment parses from every
 * `{` position. The first JSON object wins. This is intentionally permissive about the
 * wrapper, not about the JSON itself: malformed JSON is never repaired.
 */

const FENCED_BLOCK_RE = /```(?:json)?\s*\n?(.*?)```/gis;

export function extractJsonObject(text: string): Record<string, unknown> {
  const seen = new Set<string>();

  for (const candidate of candidateSegments(text)) {
    const segment = candidate.trim();
    if (segment === "" || seen.has(segment)) {
      continue;
    }
    seen.add(segment);

    const direct = tryParseObject(segment);
    if (direct !== null) {
      return direct;
    }

    for (let start = 0; start < segment.length; start += 1) {
      if (segment[start] !== "{") {
        continue;
      }
      const end = balancedObjectEnd(segment, start);
      if (end < 0) {
        continue;
      }
      const parsed = tryParseObject(segment.slice(start, end));
      if (parsed !== null) {
        return parsed;
      }
    }
  }

  throw new Error("no JSON object found in output");
}

function candidateSegments(text: string): string[] {
  const segments = [text.trim()];
  for (const match of text.matchAll(FENCED_BLOCK_RE)) {
    segments.push((match[1] ?? "").trim());
  }
  return segments;
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the index just past the `}` that closes the object opened at `start`, or -1.
 * Braces inside JSON strings do not count.
 */
function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}
