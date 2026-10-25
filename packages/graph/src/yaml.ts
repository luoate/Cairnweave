/**
 * Minimal YAML block-style emitter for the graph export.
 *
 * PyYAML's `dump(..., default_flow_style=False, sort_keys=False, allow_unicode=True)` is the
 * reference. This module reproduces its output for the shapes the export uses (mappings,
 * indentless sequences, scalars) including its 80-column folding for plain and single-quoted
 * scalars. Double-quoted scalars (control characters, tabs, CR, spaces around a line break)
 * are escaped but not folded; the result is semantically identical, which is all a YAML
 * reader needs. See `docs/PORTING.md`.
 */

const WIDTH = 80;

export type YamlLeaf = string | number | boolean | null;

export interface YamlMap {
  entries: Array<[string, YamlValue]>;
}

export type YamlValue = YamlLeaf | YamlValue[] | YamlMap;

export function map(entries: Array<[string, YamlValue]>): YamlMap {
  return { entries };
}

/** Renders a complete document with a trailing newline. */
export function renderYaml(root: YamlMap): string {
  const lines: string[] = [];
  renderMap(root, 0, lines);
  return `${lines.join("\n")}\n`;
}

function renderMap(node: YamlMap, indent: number, lines: string[]): void {
  for (const [key, value] of node.entries) {
    renderEntry(key, value, indent, lines);
  }
}

function renderEntry(key: string, value: YamlValue, indent: number, lines: string[]): void {
  const prefix = " ".repeat(indent) + key + ":";
  if (value === null) {
    lines.push(`${prefix} null`);
  } else if (typeof value === "boolean" || typeof value === "number") {
    lines.push(`${prefix} ${String(value)}`);
  } else if (typeof value === "string") {
    const startColumn = prefix.length + 1;
    lines.push(`${prefix} ${emitScalar(value, indent + 2, startColumn)}`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix} []`);
      return;
    }
    lines.push(prefix);
    renderSequence(value, indent, lines);
  } else {
    lines.push(prefix);
    renderMap(value, indent + 2, lines);
  }
}

function renderSequence(items: YamlValue[], indent: number, lines: string[]): void {
  const marker = " ".repeat(indent) + "- ";
  for (const item of items) {
    if (item === null) {
      lines.push(`${marker}null`);
    } else if (typeof item === "boolean" || typeof item === "number") {
      lines.push(`${marker}${String(item)}`);
    } else if (typeof item === "string") {
      lines.push(`${marker}${emitScalar(item, indent + 4, marker.length)}`);
    } else if (Array.isArray(item)) {
      throw new Error("nested sequences are not supported by the export emitter");
    } else {
      renderSequenceMap(item, indent, lines);
    }
  }
}

/** A mapping inside a sequence item: the first key shares the `- ` line. */
function renderSequenceMap(node: YamlMap, indent: number, lines: string[]): void {
  node.entries.forEach(([key, value], index) => {
    if (index === 0) {
      const prefix = " ".repeat(indent) + "- " + key + ":";
      if (value === null) {
        lines.push(`${prefix} null`);
      } else if (typeof value === "boolean" || typeof value === "number") {
        lines.push(`${prefix} ${String(value)}`);
      } else if (typeof value === "string") {
        lines.push(`${prefix} ${emitScalar(value, indent + 4, prefix.length + 1)}`);
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          lines.push(`${prefix} []`);
        } else {
          lines.push(prefix);
          renderSequence(value, indent + 2, lines);
        }
      } else {
        lines.push(prefix);
        renderMap(value, indent + 4, lines);
      }
      return;
    }
    renderEntry(key, value, indent + 2, lines);
  });
}

export function emitScalar(text: string, indent: number, startColumn: number): string {
  if (needsDoubleQuotes(text)) {
    return doubleQuote(text);
  }
  if (needsSingleQuotes(text)) {
    return `'${foldSingle(text.replaceAll("'", "''"), indent, startColumn + 1)}'`;
  }
  return foldPlain(text, indent, startColumn);
}

function needsDoubleQuotes(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a) {
      continue;
    }
    if (isNonPrintable(code) || char === "\t" || char === "\r") {
      return true;
    }
  }
  // A space next to a line break cannot survive single-quoted folding.
  return /[ ]\n|\n[ ]/.test(text);
}

function needsSingleQuotes(text: string): boolean {
  if (text.includes("\n")) {
    return true;
  }
  return !isPlainSafe(text);
}

function isNonPrintable(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfffe ||
    code === 0xffff
  );
}

const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const NULL = /^(?:~|null|Null|NULL)$/;
const INT =
  /^[-+]?(?:0b[0-1_]+|0[0-7_]+|(?:0|[1-9][0-9_]*)|0x[0-9a-fA-F_]+|[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const FLOAT =
  /^[-+]?(?:(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9_]+(?:[eE][-+][0-9]+)?|[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|\.(?:inf|Inf|INF))$|^\.(?:nan|NaN|NAN)$/;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)?$/;

function resolvesToNonString(text: string): boolean {
  return (
    BOOL.test(text) ||
    NULL.test(text) ||
    INT.test(text) ||
    FLOAT.test(text) ||
    TIMESTAMP.test(text) ||
    text === "<<" ||
    text === "=" ||
    text === ""
  );
}

function isPlainSafe(text: string): boolean {
  if (text === "" || text !== text.trim()) {
    return false;
  }
  if (resolvesToNonString(text)) {
    return false;
  }
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(text)) {
    return false;
  }
  if (text === "---" || text === "...") {
    return false;
  }
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) {
    return false;
  }

  const first = text[0]!;
  if ("?:-".includes(first)) {
    if (text.length === 1 || text[1] === " ") {
      return false;
    }
  } else if (",[]{}#&*!|>'\"%@`".includes(first)) {
    return false;
  }
  return true;
}

type Folded = { text: string; column: number };

/** Breaks at space runs once PyYAML's column exceeds the width. */
function foldWords(piece: string, indent: number, startColumn: number): Folded {
  const parts = piece.split(/( +)/);
  let text = "";
  let column = startColumn;
  let pendingSpace: string | null = null;

  for (const part of parts) {
    if (part === "") {
      continue;
    }
    if (/^ +$/.test(part)) {
      pendingSpace = part;
      continue;
    }
    if (text === "") {
      if (pendingSpace !== null) {
        text += pendingSpace;
        column += pendingSpace.length;
      }
      text += part;
      column += part.length;
    } else {
      if (pendingSpace !== null) {
        if (column > WIDTH) {
          text += "\n" + " ".repeat(indent);
          column = indent;
        } else {
          text += pendingSpace;
          column += pendingSpace.length;
        }
      }
      text += part;
      column += part.length;
    }
    pendingSpace = null;
  }

  if (pendingSpace !== null) {
    text += pendingSpace;
  }
  return { text, column };
}

function foldPlain(text: string, indent: number, startColumn: number): string {
  return foldWords(text, indent, startColumn).text;
}

function foldSingle(escaped: string, indent: number, startColumn: number): string {
  const parts = escaped.split(/(\n+)/);
  let text = "";
  let column = startColumn;

  for (const part of parts) {
    if (part === "") {
      continue;
    }
    if (part[0] === "\n") {
      // Single-quoted line breaks are folded by the reader, so one newline needs two.
      text += "\n".repeat(part.length + 1) + " ".repeat(indent);
      column = indent;
      continue;
    }
    const folded = foldWords(part, indent, column);
    text += folded.text;
    column = folded.column;
  }
  return text;
}

function doubleQuote(text: string): string {
  let out = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\0":
        out += "\\0";
        break;
      default:
        if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
          out += `\\x${code.toString(16).padStart(2, "0")}`;
        } else if (code === 0x2028 || code === 0x2029) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else {
          out += char;
        }
    }
  }
  return `${out}"`;
}
