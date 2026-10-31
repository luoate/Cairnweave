import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpError,
  addProjectAttachment,
  attachmentRelativePath,
  configureDatabase,
  createProject,
  getProjectAttachment,
  listProjectAttachments,
  MAX_ATTACHMENT_NAME_CHARS,
  removeProjectAttachment,
  sanitizeAttachmentName,
  sumProjectAttachmentBytes,
  type CairnDatabase,
} from "./index";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);

let directory: string;
let db: CairnDatabase;
let projectId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-attachments-"));
  db = configureDatabase(join(directory, "cairn.db"));
  projectId = db.withConn(
    (conn) =>
      createProject(conn, {
        title: "attachments",
        origin: "origin",
        goal: "goal",
        hints: null,
        bootstrap_enabled: false,
        scope: { targets: ["127.0.0.1:8080"] },
      }).project.id,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function add(
  name: string,
  overrides: { sha256?: string; size?: number; maxTotalBytes?: number } = {},
) {
  return db.withConn((conn) =>
    addProjectAttachment(conn, projectId, {
      name,
      sha256: overrides.sha256 ?? DIGEST,
      size: overrides.size ?? 2048,
      creator: "operator",
      ...(overrides.maxTotalBytes === undefined
        ? {}
        : { maxTotalBytes: overrides.maxTotalBytes }),
    }),
  );
}

function catchHttpError(task: () => unknown): HttpError {
  try {
    task();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("expected an HttpError");
}

describe("sanitizeAttachmentName", () => {
  test("keeps an ordinary filename", () => {
    expect(sanitizeAttachmentName("challenge.pcap")).toBe("challenge.pcap");
    expect(sanitizeAttachmentName("my binary v2.1.zip")).toBe("my binary v2.1.zip");
  });

  test("takes the leaf of a path in either slash style", () => {
    expect(sanitizeAttachmentName("/etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("..\\..\\dist\\app.tar.gz")).toBe("app.tar.gz");
    expect(sanitizeAttachmentName("attachments/hidden.bin")).toBe("hidden.bin");
  });

  test("drops control characters and maps filesystem-reserved ones", () => {
    expect(sanitizeAttachmentName("evil\0name\t.bin")).toBe("evilname.bin");
    expect(sanitizeAttachmentName('a<b>:c"|d?e*f')).toBe("a_b__c__d_e_f");
  });

  test("rejects names with no usable characters and Windows reserved stems", () => {
    for (const rejected of ["", "   ", "..", ".", "/"]) {
      expect(() => sanitizeAttachmentName(rejected)).toThrow(HttpError);
    }
    expect(() => sanitizeAttachmentName("NUL")).toThrow(/reserved/);
    expect(() => sanitizeAttachmentName("con.txt")).toThrow(/reserved/);
  });

  test("caps long names and keeps the extension", () => {
    const truncated = sanitizeAttachmentName(`${"x".repeat(300)}.pcapng`);
    expect(truncated.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAME_CHARS);
    expect(truncated.endsWith(".pcapng")).toBe(true);
    expect(sanitizeAttachmentName(`${"y".repeat(300)}`).length).toBe(MAX_ATTACHMENT_NAME_CHARS);
  });
});

describe("project attachment ledger", () => {
  test("stores the sanitized name under attachments/", () => {
    const { attachment, created } = add("../uploads/flag machine.bin");
    expect(created).toBe(true);
    expect(attachment.name).toBe("flag machine.bin");
    expect(attachment.path).toBe(attachmentRelativePath("flag machine.bin"));
    expect(attachment.project_id).toBe(projectId);
    expect(attachment.sha256).toBe(DIGEST);
    expect(attachment.size).toBe(2048);
    expect(attachment.creator).toBe("operator");
    expect(attachment.created_at).not.toBeNull();
  });

  test("normalizes an uppercase digest and lists in upload order", () => {
    const stored = add("app.tar.gz", { sha256: `${"C".repeat(63)}d` });
    expect(stored.attachment.sha256).toBe("c".repeat(63) + "d");
    add("dist.zip");
    const listed = db.withConn((conn) => listProjectAttachments(conn, projectId));
    expect(listed.map((item) => item.name)).toEqual(["app.tar.gz", "dist.zip"]);
  });

  test("is idempotent for the same digest and refuses different bytes under a used name", () => {
    const first = add("challenge.bin");
    expect(add("challenge.bin").created).toBe(false);
    expect(add("challenge.bin").attachment.id).toBe(first.attachment.id);
    expect(() => add("challenge.bin", { sha256: OTHER_DIGEST })).toThrow(HttpError);
    try {
      add("challenge.bin", { sha256: OTHER_DIGEST });
    } catch (error) {
      const http = error as HttpError;
      expect(http.status).toBe(409);
      expect(http.message).toContain("challenge.bin");
    }
  });

  test("reads and removes one attachment by id", () => {
    const { attachment } = add("pcap0.pcap");
    expect(db.withConn((conn) => getProjectAttachment(conn, projectId, attachment.id))).toEqual(
      attachment,
    );
    const removed = db.withConn((conn) => removeProjectAttachment(conn, projectId, attachment.id));
    expect(removed.path).toBe("attachments/pcap0.pcap");
    expect(db.withConn((conn) => listProjectAttachments(conn, projectId))).toEqual([]);
    expect(() => db.withConn((conn) => getProjectAttachment(conn, projectId, attachment.id))).toThrow(
      /not found/,
    );
  });

  test("sums held bytes for the upload budget", () => {
    add("one.bin", { size: 1024 });
    add("two.bin", { size: 4096 });
    expect(db.withConn((conn) => sumProjectAttachmentBytes(conn, projectId))).toBe(5120);
    add("one.bin", { size: 1024 });
    expect(db.withConn((conn) => sumProjectAttachmentBytes(conn, projectId))).toBe(5120);
  });

  test("rejects bad input before writing a row", () => {
    expect(() => add("good.bin", { sha256: "not-a-digest" })).toThrow(/sha256/);
    expect(() => add("good.bin", { size: 1.5 })).toThrow(/non-negative integer/);
    expect(() => add("good.bin", { size: -1 })).toThrow(/non-negative integer/);
    expect(() =>
      db.withConn((conn) =>
        addProjectAttachment(conn, projectId, {
          name: "good.bin",
          sha256: DIGEST,
          size: 10,
          creator: "  ",
        }),
      ),
    ).toThrow(/creator/);
    expect(db.withConn((conn) => listProjectAttachments(conn, projectId))).toEqual([]);
  });

  test("enforces the byte budget for new files but not for a replay", () => {
    add("one.bin", { size: 900, maxTotalBytes: 1000 });
    const rejected = catchHttpError(() => add("two.bin", { size: 200, maxTotalBytes: 1000 }));
    expect(rejected.status).toBe(413);
    expect(rejected.message).toContain("budget");
    // Exactly at the limit is allowed, so the bound is inclusive of held + new bytes.
    add("two.bin", { size: 100, maxTotalBytes: 1000 });
    // The stored file replayed at a full budget adds no bytes, so it still answers.
    const replay = add("one.bin", { size: 900, maxTotalBytes: 1000 });
    expect(replay.created).toBe(false);
    expect(db.withConn((conn) => sumProjectAttachmentBytes(conn, projectId))).toBe(1000);
  });

  test("404s for an unknown project", () => {
    expect(() =>
      db.withConn((conn) =>
        addProjectAttachment(conn, "proj_missing", {
          name: "a.bin",
          sha256: DIGEST,
          size: 1,
          creator: "operator",
        }),
      ),
    ).toThrow(HttpError);
  });
});

