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

describe("analyzeCommand command position", () => {
  test("a network tool mentioned as an argument is not a network intent", () => {
    expect(analyzeCommand("which curl python3").networkIntent).toBe(false);
    expect(analyzeCommand("ls artifacts; command -v curl").networkIntent).toBe(false);
    expect(analyzeCommand("grep -r curl .").networkIntent).toBe(false);
  });

  test("a wrapper still names the tool it runs", () => {
    const analysis = analyzeCommand("timeout 60 nmap -p8080 10.0.0.9");
    expect(analysis.networkIntent).toBe(true);
    expect(hosts(analysis.endpoints)).toContain("10.0.0.9:8080");

    const sudo = analyzeCommand("sudo -u root nmap -p8080 10.0.0.9");
    expect(sudo.networkIntent).toBe(true);
    expect(hosts(sudo.endpoints)).toContain("10.0.0.9:8080");
  });

  test("finds a command after shell grammar words", () => {
    const loop = analyzeCommand(
      "for p in a b; do curl -s http://target.example.test/$p; done",
    );
    expect(hosts(loop.endpoints)).toContain("target.example.test:80");

    // A variable endpoint is still unverifiable, so the call fails closed.
    const hidden = analyzeCommand('for p in a b; do curl -s "$B/$p"; done');
    expect(hidden.networkIntent).toBe(true);
    expect(hidden.unverifiable).toBe(true);
  });

  test("finds a command run by xargs or find -exec", () => {
    const piped = analyzeCommand("printf '%s' http://target.example.test | xargs curl -s");
    expect(piped.networkIntent).toBe(true);
    expect(hosts(piped.endpoints)).toContain("target.example.test:80");

    const exec = analyzeCommand("find . -name x -exec nmap -p8080 10.0.0.9 ;");
    expect(hosts(exec.endpoints)).toContain("10.0.0.9:8080");
  });

  test("a bare hostname is a destination only for a network tool", () => {
    expect(hosts(analyzeCommand("curl -s target.example.test").endpoints)).toEqual([
      "target.example.test:",
    ]);
    expect(analyzeCommand("echo target.example.test").networkIntent).toBe(false);
  });
});

describe("analyzeCommand heredocs", () => {
  test("does not scan a script written to disk", () => {
    const analysis = analyzeCommand(
      [
        "cat > fetch.py <<'EOF'",
        "import http.client, urllib.parse",
        'HOST = "93b5611157b1fe1b25ecf5c5.example.test"',
        "for body in parts: print(body.split)",
        "EOF",
      ].join("\n"),
    );
    expect(analysis.networkIntent).toBe(false);
    expect(analysis.endpoints).toEqual([]);
    expect(analysis.carried).toEqual([]);
  });

  test("finds the writer after a preceding command on the same line", () => {
    const analysis = analyzeCommand(
      [
        "cd artifacts && cat > ../fetch_git.sh <<'EOF'",
        '#!/bin/bash',
        'H="http://93b5611157b1fe1b25ecf5c5.example.test"',
        "for body in parts; do echo $body.split; done",
        "EOF",
      ].join("\n"),
    );
    expect(analysis.networkIntent).toBe(false);
    expect(analysis.endpoints).toEqual([]);
  });

  test("keeps a piped script visible so its imports still fail closed", () => {
    const analysis = analyzeCommand(
      ["python - <<'EOF'", "import socket", "s = socket.create_connection((h, p))", "EOF"].join(
        "\n",
      ),
    );
    expect(analysis.networkIntent).toBe(true);
    expect(analysis.unverifiable).toBe(true);
  });

  test("still reads a URL from the command line next to a written script", () => {
    const analysis = analyzeCommand(
      [
        "cat > probe.py <<'EOF'",
        "import http.client",
        "EOF",
        "curl -s http://target.example.test/health",
      ].join("\n"),
    );
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
  });
});

describe("analyzeCommand header data", () => {
  test("treats header and cookie values as carried, not as destinations", () => {
    const analysis = analyzeCommand(
      'curl -s -H "X-Forwarded-For: 127.0.0.1" -A "agent/1.0" http://target.example.test/',
    );
    expect(hosts(analysis.endpoints)).toEqual(["target.example.test:80"]);
    expect(hosts(analysis.carried)).toEqual(["127.0.0.1:"]);
  });

  test("records a target carried in a cookie value", () => {
    const analysis = analyzeCommand(
      "curl -s -b 'next=http://10.0.0.9/admin' http://target.example.test/",
    );
    expect(hosts(analysis.carried)).toEqual(["10.0.0.9:80"]);
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
