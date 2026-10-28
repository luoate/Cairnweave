import { describe, expect, test } from "bun:test";

import { buildZip, crc32, readZip, type ZipEntryInput } from "./zip";

const STAMP = new Date("2026-10-28T12:00:00Z");

function entry(name: string, text: string): ZipEntryInput {
  return { name, data: Buffer.from(text, "utf8"), modifiedAt: STAMP };
}

function names(bytes: Uint8Array): string[] {
  return readZip(bytes).map((item) => item.name);
}

describe("crc32", () => {
  test("matches the published check vector", () => {
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("buildZip", () => {
  test("round-trips names and bytes through the central directory", () => {
    const bytes = buildZip([entry("writeup.md", "# 标题\n正文\n"), entry("artifacts/t/forge.py", "print(1)\n")]);

    expect(names(bytes)).toEqual(["writeup.md", "artifacts/t/forge.py"]);
    expect(readZip(bytes)[0]?.data.toString("utf8")).toBe("# 标题\n正文\n");
    expect(readZip(bytes)[1]?.data.toString("utf8")).toBe("print(1)\n");
  });

  test("preserves binary content byte for byte", () => {
    const raw = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80, 0x01, 0x00]);
    const bytes = buildZip([{ name: "artifacts/t/blob.zip", data: raw, modifiedAt: STAMP }]);

    expect(readZip(bytes)[0]?.data.equals(raw)).toBe(true);
  });

  test("deflates compressible text and stores what deflate cannot shrink", () => {
    const compressible = buildZip([entry("artifacts/t/repeat.txt", "AAAA".repeat(400))]);
    const raw = Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 37) & 0xff));
    const incompressible = buildZip([{ name: "artifacts/t/blob.bin", data: raw, modifiedAt: STAMP }]);

    expect(readZip(compressible)[0]?.data.toString("utf8")).toBe("AAAA".repeat(400));
    expect(compressible.length).toBeLessThan(1600);
    expect(readZip(incompressible)[0]?.data.equals(raw)).toBe(true);
  });

  test("carries an empty file and an empty archive", () => {
    expect(readZip(buildZip([entry("artifacts/t/empty.txt", "")]))[0]?.data.length).toBe(0);
    expect(readZip(buildZip([]))).toEqual([]);
  });

  test("keeps the same bytes for the same input", () => {
    const input = [entry("a.md", "x"), entry("b/c.md", "yy")];
    expect(Buffer.compare(buildZip(input), buildZip(input))).toBe(0);
  });

  test("normalizes separators and rejects escaping names", () => {
    expect(names(buildZip([entry("artifacts\\t\\forge.py", "print(1)\n")]))).toEqual([
      "artifacts/t/forge.py",
    ]);
    expect(names(buildZip([entry("/artifacts/forge.py", "print(1)\n")]))).toEqual([
      "artifacts/forge.py",
    ]);

    for (const name of ["../evil.py", "artifacts/../../evil.py", "", "artifacts//forge.py"]) {
      expect(() => buildZip([entry(name, "x")])).toThrow(/invalid zip entry name/);
    }
  });

  test("refuses to read back a corrupted entry", () => {
    const bytes = Buffer.from(buildZip([entry("artifacts/t/forge.py", "print(1)\n")]));
    const dataStart = bytes.indexOf(Buffer.from("print(", "utf8"));
    expect(dataStart).toBeGreaterThan(0);
    bytes[dataStart] = 0x00;

    expect(() => readZip(bytes)).toThrow(/checksum mismatch|crc mismatch/);
  });
});
