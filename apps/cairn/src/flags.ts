/**
 * Flag-shaped text detection shared by the read-only `/flag` view and the scheduler's
 * operator review gate. Both must agree on what counts as a flag and what is a mask or
 * placeholder, so the classifier lives here rather than in the HTTP layer.
 */

export const MAX_FLAG_LINE_LENGTH = 8 * 1024;

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

export interface FlagSighting {
  flag: string;
  /** True when the value looks redacted, truncated or like a mask. */
  placeholder: boolean;
}

/**
 * JSON dumps and captured HTTP responses store newlines as the two-character escape `\r\n`, so
 * the greedy prefix class swallows the escape's trailing letter and reads `flag{...}` as
 * `nflag{...}` — a value that no longer matches what an operator already rejected as a decoy.
 * Only that single glued letter is dropped, and only when the match starts right after a
 * backslash, so `picoCTF{...}` keeps its real prefix and a genuine `nflag{...}` format written
 * anywhere else keeps its own spelling.
 */
function canonicalPrefix(line: string, rawPrefix: string, index: number): string {
  if (line[index - 1] !== "\\") return rawPrefix;
  if (!ESCAPE_TAIL.test(rawPrefix)) return rawPrefix;
  const stripped = rawPrefix.slice(1);
  return acceptablePrefix(stripped.toLowerCase()) ? stripped : rawPrefix;
}

const ESCAPE_TAIL = /^[nrtbfvux0]/i;

function acceptablePrefix(lower: string): boolean {
  return lower === "flag" || lower.endsWith("flag") || lower.includes("ctf");
}

/** Every flag-shaped string in `content`, marked as a mask when it looks redacted. */
export function classifyFlags(
  content: string,
  maxLineLength: number = MAX_FLAG_LINE_LENGTH,
): FlagSighting[] {
  const found: FlagSighting[] = [];
  for (const line of content.split(/\r?\n/)) {
    const scoped = line.length > maxLineLength ? line.slice(0, maxLineLength) : line;
    for (const match of scoped.matchAll(FLAG_PATTERN)) {
      if (!acceptablePrefix(match[1]!.toLowerCase())) continue;
      const body = match[2]!;
      found.push({
        flag: `${canonicalPrefix(scoped, match[1]!, match.index)}{${body}}`,
        placeholder: isPlaceholder(body),
      });
    }
  }
  return found;
}

/** Values that pass the placeholder filter, in first-seen order. */
export function findFlags(
  content: string,
  maxLineLength: number = MAX_FLAG_LINE_LENGTH,
): string[] {
  return classifyFlags(content, maxLineLength)
    .filter((sighting) => !sighting.placeholder)
    .map((sighting) => sighting.flag);
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
