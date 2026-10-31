import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostBridge, type SsrfMarkerPolicy } from "./bridge";

let directory: string;
let workspace: string;
let sessionDir: string;
let auditPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-bridge-ssrf-"));
  workspace = join(directory, "workspace");
  sessionDir = join(workspace, ".cairn", "sessions", "task-1");
  mkdirSync(sessionDir, { recursive: true });
  auditPath = join(sessionDir, "audit.jsonl");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function bridge(
  targets: string[] = ["127.0.0.1:8080"],
  options: { ssrfMarkers?: SsrfMarkerPolicy; protectedHosts?: string[] } = {},
): HostBridge {
  return new HostBridge({
    projectId: "proj-1",
    taskId: "task-1",
    workspace,
    sessionDir,
    scopeTargets: targets,
    ...(options.ssrfMarkers === undefined ? {} : { ssrfMarkers: options.ssrfMarkers }),
    ...(options.protectedHosts === undefined
      ? {}
      : { protectedHosts: options.protectedHosts }),
    auditPath,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

interface AuditLine {
  event?: string;
  decision?: string;
  reason?: string | null;
  targets?: string[];
  tool?: string;
}

function auditLines(): AuditLine[] {
  return readFileSync(auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditLine);
}

function candidates(): AuditLine[] {
  return auditLines().filter((line) => line.event === "ssrf_candidate");
}

/** The whole point of `observe`: the request runs and the hop is still on record. */
describe("host bridge ssrf marker policy: observe", () => {
  test("is the default and lets an out-of-scope carried target through", () => {
    const gate = bridge();
    const decision = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/fetch?url=http://10.0.0.9/admin"',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();

    const marker = candidates();
    expect(marker.length).toBe(1);
    expect(marker[0]!.decision).toBe("allow");
    expect(marker[0]!.targets).toEqual(["http://10.0.0.9/admin"]);
    expect(marker[0]!.reason).toContain("SSRF markers (observe)");
    expect(marker[0]!.reason).toContain("1 outside the authorized scope");
  });

  test("records the marker after the decision line it belongs to", () => {
    const gate = bridge();
    gate.checkToolCall("bash", {
      command: 'curl -s -d "target=http://10.0.0.9:6379/" http://127.0.0.1:8080/proxy',
    });
    const lines = auditLines();
    expect(lines.length).toBe(2);
    expect(lines[0]!.event).toBeUndefined();
    expect(lines[0]!.decision).toBe("allow");
    expect(lines[1]!.event).toBe("ssrf_candidate");
  });

  test("does not report a carried target that is itself in scope", () => {
    const gate = bridge(["127.0.0.1:8080", "127.0.0.1:6379"]);
    const decision = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/proxy?url=http://127.0.0.1:6379/"',
    });
    expect(decision.allowed).toBe(true);
    expect(candidates().length).toBe(0);
  });

  test("leaves the audit untouched for a plain request", () => {
    const gate = bridge();
    expect(gate.checkToolCall("bash", { command: "curl -s http://127.0.0.1:8080/health" }).allowed).toBe(
      true,
    );
    expect(auditLines().length).toBe(1);
  });
});

/** The hard floor holds in every mode except `off`. */
describe("host bridge ssrf marker hard floor", () => {
  test("refuses a link-local metadata target under observe", () => {
    const gate = bridge();
    const decision = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/redir?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F"',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("protected infrastructure");
    expect(decision.reason).toContain("SSRF hard floor");
    expect(candidates()[0]!.decision).toBe("block");
  });

  test("refuses a named metadata host", () => {
    const gate = bridge();
    const decision = gate.checkToolCall("bash", {
      command: "curl -s -d 'host=metadata.google.internal' http://127.0.0.1:8080/probe",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("metadata.google.internal");
  });

  test("refuses an operator-protected host carried inside a request", () => {
    const gate = bridge(["127.0.0.1:8080"], { protectedHosts: ["cairn-control.internal"] });
    const decision = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/x?cb=http://cairn-control.internal:9000/audit"',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("hard floor");
  });

  test("matches a protected host only at a label boundary", () => {
    const gate = bridge(["127.0.0.1:8080"], { protectedHosts: ["cairn-control.internal"] });
    const lookalike = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/x?cb=http://cairn-control.internal.evil.test/"',
    });
    expect(lookalike.allowed).toBe(true);
    expect(lookalike.reason).toBeUndefined();

    const subdomain = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/x?cb=http://audit.cairn-control.internal/"',
    });
    expect(subdomain.allowed).toBe(false);
  });

  test("refuses an infrastructure name carried with neither scheme nor port", () => {
    const gate = bridge(["127.0.0.1:8080"], { protectedHosts: ["cairn-control.internal"] });
    const decision = gate.checkToolCall("bash", {
      command: "curl -s -d 'callback=cairn-control.internal' http://127.0.0.1:8080/form",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("hard floor");
    expect(candidates()[0]!.targets).toEqual(["cairn-control.internal"]);
  });

  test("applies to the http tool, not only to bash", () => {
    const gate = bridge(["127.0.0.1:8080"]);
    const decision = gate.checkToolCall("fetch", {
      url: "http://127.0.0.1:8080/fetch?url=http://169.254.169.254/latest/meta-data/",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("hard floor");
  });

  test("a destination in scope keeps its own check regardless of the marker policy", () => {
    const gate = bridge(["127.0.0.1:8080"], { ssrfMarkers: "off" });
    expect(gate.checkToolCall("bash", { command: "curl -s http://10.0.0.9/" }).allowed).toBe(false);
  });
});

describe("host bridge ssrf marker policy: block", () => {
  test("refuses an out-of-scope carried target and still records the marker", () => {
    const gate = bridge(["127.0.0.1:8080"], { ssrfMarkers: "block" });
    const decision = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/fetch?url=http://10.0.0.9/admin"',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("outside the scope");
    expect(decision.reason).toContain("SSRF markers are set to block");

    const lines = auditLines();
    expect(lines.length).toBe(2);
    expect(lines[0]!.decision).toBe("block");
    expect(lines[1]!.event).toBe("ssrf_candidate");
    expect(lines[1]!.reason).toContain("SSRF markers (block)");
  });

  test("lets an in-scope carried target through", () => {
    const gate = bridge(["127.0.0.1:8080", "127.0.0.1:6379"], { ssrfMarkers: "block" });
    expect(
      gate.checkToolCall("bash", {
        command: 'curl -s "http://127.0.0.1:8080/proxy?url=redis://127.0.0.1:6379"',
      }).allowed,
    ).toBe(true);
  });
});

describe("host bridge ssrf marker policy: off", () => {
  test("ignores carried targets entirely", () => {
    const gate = bridge(["127.0.0.1:8080"], { ssrfMarkers: "off" });
    const decision = gate.checkToolCall("bash", {
      command: 'curl -s "http://127.0.0.1:8080/redir?url=http%3A%2F%2F169.254.169.254%2F"',
    });
    expect(decision.allowed).toBe(true);
    expect(auditLines().length).toBe(1);
    expect(auditLines()[0]!.event).toBeUndefined();
  });

  test("does not look for named infrastructure either", () => {
    const gate = bridge(["127.0.0.1:8080"], {
      ssrfMarkers: "off",
      protectedHosts: ["cairn-control.internal"],
    });
    expect(
      gate.checkToolCall("bash", {
        command: "curl -s -d 'callback=cairn-control.internal' http://127.0.0.1:8080/form",
      }).allowed,
    ).toBe(true);
  });
});

describe("host bridge ssrf payload files", () => {
  test("reads a workspace payload reference and reports its targets", () => {
    writeFileSync(join(workspace, "payload.xml"), '<!ENTITY x SYSTEM "http://10.0.0.9:6379/">', "utf8");
    const gate = bridge();
    const decision = gate.checkToolCall("bash", {
      command: "curl -s --data-binary @payload.xml http://127.0.0.1:8080/xxe",
    });
    expect(decision.allowed).toBe(true);
    const marker = candidates();
    expect(marker.length).toBe(1);
    expect(marker[0]!.targets).toEqual(["http://10.0.0.9:6379/"]);
    expect(marker[0]!.reason).toContain("1 payload file(s) read");
  });

  test("refuses a payload marker under block", () => {
    writeFileSync(join(workspace, "payload.txt"), "redirect=http://10.0.0.9/x", "utf8");
    const gate = bridge(["127.0.0.1:8080"], { ssrfMarkers: "block" });
    const decision = gate.checkToolCall("bash", {
      command: "curl -s -d @payload.txt http://127.0.0.1:8080/form",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("SSRF markers are set to block");
    expect(decision.reason).toContain("10.0.0.9");
    expect(candidates()[0]!.reason).toContain("1 payload file(s) read");
  });

  test("skips a payload reference outside the workspace instead of refusing", () => {
    const gate = bridge();
    const absolute = gate.checkToolCall("bash", {
      command: "curl -s -d @/etc/passwd http://127.0.0.1:8080/x",
    });
    expect(absolute.allowed).toBe(true);
    const escaped = gate.checkToolCall("bash", {
      command: "curl -s -d @../outside.txt http://127.0.0.1:8080/x",
    });
    expect(escaped.allowed).toBe(true);
    expect(candidates().length).toBe(0);
  });

  test("skips a binary payload and a missing file", () => {
    writeFileSync(join(workspace, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    const gate = bridge();
    expect(
      gate.checkToolCall("bash", { command: "curl -s -T blob.bin http://127.0.0.1:8080/up" }).allowed,
    ).toBe(true);
    expect(
      gate.checkToolCall("bash", { command: "curl -s -T nope.bin http://127.0.0.1:8080/up" }).allowed,
    ).toBe(true);
    expect(candidates().length).toBe(0);
  });

  test("does not open payload files when the policy is off", () => {
    writeFileSync(join(workspace, "payload.xml"), "http://10.0.0.9:6379/", "utf8");
    const gate = bridge(["127.0.0.1:8080"], { ssrfMarkers: "off" });
    expect(
      gate.checkToolCall("bash", {
        command: "curl -s --data-binary @payload.xml http://127.0.0.1:8080/xxe",
      }).allowed,
    ).toBe(true);
    expect(auditLines().length).toBe(1);
  });
});
