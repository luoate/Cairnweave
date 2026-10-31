import { describe, expect, test } from "bun:test";

import { analyzeCommand } from "./command";

function hosts(endpoints: { host?: string; port?: number }[]): string[] {
  return endpoints.map((endpoint) =>
    endpoint.host === undefined ? "" : `${endpoint.host}:${endpoint.port ?? ""}`,
  );
}

describe("analyzeCommand primary endpoints", () => {
  test("keeps the destination of a URL primary", () => {
    const analysis = analyzeCommand("curl -s http://target.example.test/health");
    expect(analysis.networkIntent).toBe(true);
    expect(analysis.unverifiable).toBe(false);
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
    expect(analysis.carried).toEqual([]);
    expect(analysis.endpoints[0]!.role).toBe("primary");
  });

  test("treats positional tool hosts and scan ports as primary", () => {
    expect(hosts(analyzeCommand("nmap -p8080 127.0.0.1").endpoints)).toEqual(["127.0.0.1:8080"]);
    // Only the `-p` scan flags of PORT_TOOLS expand into port endpoints; other tools leave
    // the host bare, and nc additionally records its positional host/port pair.
    expect(hosts(analyzeCommand("redis-cli -h 10.0.0.9 -p 6379").endpoints)).toEqual([
      "10.0.0.9:",
    ]);
    expect(hosts(analyzeCommand("nc 10.0.0.9 4444").endpoints)).toEqual([
      "10.0.0.9:",
      "10.0.0.9:4444",
    ]);
  });

  test("fails closed when a network command hides its destination", () => {
    const analysis = analyzeCommand('python3 -c "import socket; socket.create_connection((h, p))"');
    expect(analysis.networkIntent).toBe(true);
    expect(analysis.endpoints).toEqual([]);
    expect(analysis.unverifiable).toBe(true);
  });

  test("still treats a literal URL inside a variable destination as primary", () => {
    const analysis = analyzeCommand('curl -s "$BASE/fetch?url=http://127.0.0.1:6379/"');
    expect(hosts(analysis.endpoints)).toEqual(["127.0.0.1:6379"]);
    expect(analysis.carried).toEqual([]);
    expect(analysis.unverifiable).toBe(false);
  });
});

describe("analyzeCommand carried endpoints", () => {
  test("reads a target out of an authorized URL query", () => {
    const analysis = analyzeCommand(
      "curl -s http://target.example.test/proxy?url=http://127.0.0.1:6379/",
    );
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
    expect(hosts(analysis.carried)).toEqual(["127.0.0.1:6379"]);
    expect(analysis.carried[0]!.role).toBe("carried");
  });

  test("decodes percent-escapes in a carried target", () => {
    const analysis = analyzeCommand(
      "curl -G http://target.example.test/fetch --url-query 'u=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data'",
    );
    expect(hosts(analysis.carried)).toContain("169.254.169.254:80");
  });

  test("reads a carried target from a request body", () => {
    const analysis = analyzeCommand(
      'curl -X POST -d \'link=internal.test:8080&cb=10.0.0.7\' http://target.example.test/parse',
    );
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
    expect(hosts(analysis.carried).sort()).toEqual(["10.0.0.7:", "internal.test:8080"]);
  });

  test("reads a carried target from a URL fragment", () => {
    const analysis = analyzeCommand(
      "wget -q -O- 'http://target.example.test/page#ping=192.168.1.13:80'",
    );
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
    expect(hosts(analysis.carried)).toEqual(["192.168.1.13:80"]);
  });

  test("does not report a carried target that is also the destination", () => {
    const analysis = analyzeCommand(
      "curl -s http://127.0.0.1:8080/redirect?to=http://127.0.0.1:8080/next",
    );
    expect(hosts(analysis.endpoints)).toEqual(["127.0.0.1:8080"]);
    expect(analysis.carried).toEqual([]);
  });

  test("ignores the scan ports of the outer tool for carried literals", () => {
    const analysis = analyzeCommand("nmap -p1-3 http://target.example.test/?host=10.0.0.7");
    expect(hosts(analysis.carried)).toEqual(["10.0.0.7:"]);
  });

  test("keeps file-like tokens in a body out of the carried list", () => {
    const analysis = analyzeCommand(
      'curl -d "backup=db.sql&note=readme.txt" http://target.example.test/upload',
    );
    expect(analysis.carried).toEqual([]);
  });

  test("treats a URL quoted inside a request body as carried", () => {
    const analysis = analyzeCommand(
      'curl -X POST -d \'<!ENTITY x SYSTEM "http://127.0.0.1:6379/">\' http://target.example.test/xml',
    );
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
    expect(hosts(analysis.carried)).toEqual(["127.0.0.1:6379"]);
  });

  test("reports one carried entry per URL target", () => {
    const analysis = analyzeCommand("curl 'http://target.test/p?u=http://169.254.169.254/latest'");
    expect(hosts(analysis.carried)).toEqual(["169.254.169.254:80"]);
  });

  test("bounds the carried list so one command cannot grow the audit entry", () => {
    const pairs = Array.from({ length: 40 }, (_, index) => `u=http://10.0.0.${index + 1}/`).join("&");
    const analysis = analyzeCommand(`curl -s "http://target.example.test/batch?${pairs}"`);
    expect(analysis.carried.length).toBe(16);
  });

  test("reports a caller-named host carried without a scheme or port", () => {
    const analysis = analyzeCommand(
      "curl -s -d 'vpc=metadata.google.internal&tenant=other' http://target.example.test/meta",
      ["metadata.google.internal"],
    );
    expect(analysis.carried.map((endpoint) => endpoint.raw)).toEqual(["metadata.google.internal"]);
  });

  test("does not invent a carried host the caller did not name", () => {
    const unnamed = analyzeCommand(
      "curl -s -d 'vpc=metadata.google.internal' http://target.example.test/meta",
    );
    expect(unnamed.carried).toEqual([]);

    const boundary = analyzeCommand(
      "curl -s -d 'path=/srv/metadata.google.internal.cfg' http://target.example.test/meta",
      ["metadata.google.internal"],
    );
    expect(boundary.carried).toEqual([]);
  });

  test("names a carried host once even when the body spells it two ways", () => {
    const analysis = analyzeCommand(
      'curl -s -d \'h=metadata.google.internal&u=http://metadata.google.internal/\' http://target.example.test/meta',
      ["metadata.google.internal"],
    );
    expect(analysis.carried.map((endpoint) => endpoint.raw)).toEqual([
      "http://metadata.google.internal/",
    ]);
  });
});

describe("analyzeCommand payload references", () => {
  test("collects @file references from body and upload flags", () => {
    const analysis = analyzeCommand(
      'curl -T payload.xml http://target.example.test/dav --data-binary @bypass.dtd -F "doc=@/tmp/evil.xml"',
    );
    expect(analysis.payloadRefs).toEqual(["payload.xml", "bypass.dtd", "/tmp/evil.xml"]);
  });

  test("does not read an email address as a payload reference", () => {
    const analysis = analyzeCommand('curl -d "to=admin@internal.test" http://target.example.test/');
    expect(analysis.payloadRefs).toEqual([]);
    expect(hosts(analysis.carried)).toEqual(["internal.test:"]);
  });

  test("bounds the payload reference list", () => {
    const flags = Array.from({ length: 12 }, (_, index) => `--data-binary @p${index}.txt`).join(" ");
    const analysis = analyzeCommand(`curl ${flags} http://target.example.test/`);
    expect(analysis.payloadRefs.length).toBe(8);
  });
});

describe("analyzeCommand unchanged classes", () => {
  test("treats help and version invocations as no network intent", () => {
    expect(analyzeCommand("curl --help").networkIntent).toBe(false);
    expect(analyzeCommand("nmap -V").networkIntent).toBe(false);
  });

  test("returns empty lists for commands with no network intent", () => {
    const analysis = analyzeCommand("ls -la artifacts");
    expect(analysis).toEqual({
      networkIntent: false,
      endpoints: [],
      carried: [],
      payloadRefs: [],
      unverifiable: false,
    });
  });

  test("keeps a local file scope read as no network intent", () => {
    expect(analyzeCommand("cat /etc/passwd").networkIntent).toBe(false);
  });
});
