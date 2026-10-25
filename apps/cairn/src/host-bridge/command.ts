/**
 * Bash command analysis for the Host Bridge.
 *
 * This is a conservative endpoint extractor, not a shell interpreter. It recognizes the
 * common network tools used by the solver plus URLs, IPs, CIDRs and host:port tokens.
 * A recognized network action with no verifiable endpoint fails closed. Commands that
 * hide their destination inside an interpreter program are rejected by the same rule.
 *
 * The container network namespace remains the kernel-level boundary; this analyzer makes
 * the policy decision auditable and blocks the ordinary tool paths the model uses.
 */

import { isIP } from "node:net";

import { endpointFromUrl, type Endpoint, type IPv4Cidr } from "./scope-targets";

const NETWORK_TOOLS = new Set([
  "curl",
  "wget",
  "http",
  "httpie",
  "aria2c",
  "nmap",
  "masscan",
  "zmap",
  "rustscan",
  "naabu",
  "ffuf",
  "gobuster",
  "feroxbuster",
  "dirsearch",
  "nikto",
  "sqlmap",
  "wfuzz",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
  "ping",
  "ping6",
  "dig",
  "nslookup",
  "host",
  "whois",
  "tftp",
  "smbclient",
  "snmpwalk",
  "redis-cli",
  "mysql",
  "psql",
  "mongo",
  "mongosh",
  "grpcurl",
]);

const PORT_TOOLS = new Set([
  "nmap",
  "masscan",
  "zmap",
  "rustscan",
  "naabu",
  "nc",
  "ncat",
  "netcat",
]);

const HELP_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

const FILE_LIKE_TLDS = new Set([
  "txt",
  "json",
  "xml",
  "yaml",
  "yml",
  "log",
  "csv",
  "html",
  "htm",
  "php",
  "py",
  "js",
  "ts",
  "sh",
  "md",
  "conf",
  "ini",
  "zip",
  "gz",
  "bz2",
  "xz",
  "tar",
  "pcap",
  "pcapng",
  "bin",
  "exe",
  "dll",
  "so",
  "db",
  "sql",
  "bak",
  "tmp",
  "out",
  "err",
  "lock",
]);

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export interface CommandAnalysis {
  networkIntent: boolean;
  endpoints: Endpoint[];
  /** Set when a network action has no endpoint we can verify. */
  unverifiable: boolean;
}

export function analyzeCommand(command: string): CommandAnalysis {
  const tokens = tokenize(command);
  const tools = new Set(
    tokens.map((token) => basename(token)).filter((name) => NETWORK_TOOLS.has(name)),
  );
  const interpreterNetwork =
    /\b(?:import|require\s*\()\s*(?:socket|urllib|urllib3|requests|http\.client|aiohttp|httpx)\b/i.test(
      command,
    ) ||
    /\bfrom\s+(?:socket|urllib|requests|http\.client)\s+import\b/i.test(command);
  const powerShell =
    /\b(?:Invoke-WebRequest|Invoke-RestMethod|Test-NetConnection|New-Object\s+Net\.WebClient)\b/i.test(
      command,
    );
  const devTcp = /\/dev\/(?:tcp|udp)\//i.test(command);
  const opensslClient = /\bopenssl\s+(?:s_client|s_server)\b/i.test(command);
  // A URL is network intent even when the command is hidden from the token scan (for
  // example `bash -c "curl http://..."`, where the quoted token is not the tool name).
  const httpUrl = /\bhttps?:\/\//i.test(command);
  const networkIntent =
    tools.size > 0 || interpreterNetwork || powerShell || devTcp || opensslClient || httpUrl;

  if (!networkIntent) {
    return { networkIntent: false, endpoints: [], unverifiable: false };
  }

  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();
  const add = (endpoint: Endpoint): void => {
    const key =
      endpoint.cidr !== undefined
        ? `cidr:${endpoint.cidr.base}/${endpoint.cidr.prefix}|${endpoint.port ?? ""}`
        : `host:${endpoint.host ?? ""}|${endpoint.port ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push(endpoint);
  };

  const portHints = collectPortHints(tokens, tools);

  // URLs with an explicit scheme are always checked, even without a known tool.
  const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
  for (const match of command.matchAll(urlPattern)) {
    const raw = match[0]!.replace(/[),.;\]}]+$/, "");
    if (/^file:/i.test(raw)) continue;
    const endpoint = endpointFromUrl(raw);
    if (endpoint !== null) add(endpoint);
  }

  // /dev/tcp/host/port and similar shell escapes.
  const devTcpPattern = /\/dev\/(?:tcp|udp)\/([^/\s]+)\/(\d{1,5})/gi;
  for (const match of command.matchAll(devTcpPattern)) {
    const host = normalizeHost(match[1]!);
    const port = Number(match[2]);
    if (isValidPort(port)) add({ raw: match[0], host, port });
  }

  // CIDRs first so the IPv4 pattern does not also record the network address as a host.
  const cidrPattern = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})(?![\w.])/g;
  for (const match of command.matchAll(cidrPattern)) {
    const cidr = toCidr(match[1]!, Number(match[2]));
    if (cidr !== null) add({ raw: match[0], cidr });
  }

  const ipv4Pattern = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?![\w.])/g;
  for (const match of command.matchAll(ipv4Pattern)) {
    if (parseIpv4(match[1]!) === null) continue;
    const explicitPort = match[2] === undefined ? undefined : Number(match[2]);
    if (explicitPort !== undefined && !isValidPort(explicitPort)) continue;
    const ports = explicitPort === undefined ? portHints : [explicitPort];
    if (ports.length === 0) {
      add({ raw: match[0], host: normalizeHost(match[1]!) });
    } else {
      for (const port of ports) {
        add({ raw: match[0], host: normalizeHost(match[1]!), port });
      }
    }
  }

  const ipv6Pattern = /\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?/g;
  for (const match of command.matchAll(ipv6Pattern)) {
    const host = normalizeHost(match[1]!);
    if (isIP(host) !== 6) continue;
    const port = match[2] === undefined ? undefined : Number(match[2]);
    if (port !== undefined && !isValidPort(port)) continue;
    add({ raw: match[0], host, ...(port === undefined ? {} : { port }) });
  }

  // user@host (ssh, scp, rsync-style).
  for (const match of command.matchAll(/\b[A-Za-z0-9._-]+@([A-Za-z0-9.-]+)/g)) {
    const host = normalizeHost(match[1]!);
    if (host !== "" && (isIP(host) !== 0 || looksLikeHostname(host))) {
      add({ raw: match[0], host });
    }
  }

  // Positional hostnames / host:port tokens for recognized network tools.
  if (tools.size > 0) {
    for (const token of tokens) {
      if (token.startsWith("-")) continue;
      if (token.startsWith("[") && token.includes("]")) continue;

      const hostPort = /^([^:\s/]+):(\d{1,5})$/.exec(token);
      if (hostPort !== null) {
        const host = normalizeHost(hostPort[1]!);
        const port = Number(hostPort[2]);
        if (isValidPort(port) && (isIP(host) !== 0 || looksLikeHostname(host))) {
          add({ raw: token, host, port });
        }
        continue;
      }

      if (isIP(token) !== 0) continue; // covered above
      if (!looksLikeHostname(token)) continue;
      const ports = portHints.length > 0 ? portHints : [undefined];
      for (const port of ports) {
        add({ raw: token, host: normalizeHost(token), ...(port === undefined ? {} : { port }) });
      }
    }
  }

  // nc/ncat host port (the port is positional, not a -p flag).
  if (tools.has("nc") || tools.has("ncat") || tools.has("netcat")) {
    const positional: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("-")) continue;
      if (NETWORK_TOOLS.has(basename(token))) continue;
      positional.push(token);
    }
    if (
      positional.length >= 2 &&
      (isIP(positional[0]!) !== 0 || looksLikeHostname(positional[0]!)) &&
      /^\d{1,5}$/.test(positional[1]!)
    ) {
      const port = Number(positional[1]);
      if (isValidPort(port)) {
        add({ raw: positional.slice(0, 2).join(" "), host: normalizeHost(positional[0]!), port });
      }
    }
  }

  if (endpoints.length === 0 && tokens.some((token) => HELP_FLAGS.has(token))) {
    return { networkIntent: false, endpoints: [], unverifiable: false };
  }

  return {
    networkIntent: true,
    endpoints,
    unverifiable: endpoints.length === 0,
  };
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&<>()]+/g;
  for (const match of command.matchAll(pattern)) {
    const raw = match[0]!;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      tokens.push(raw.slice(1, -1));
    } else {
      tokens.push(raw);
    }
  }
  return tokens;
}

function basename(token: string): string {
  const parts = token.replaceAll("\\", "/").split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function collectPortHints(tokens: readonly string[], tools: ReadonlySet<string>): number[] {
  if (![...tools].some((tool) => PORT_TOOLS.has(tool))) return [];
  const ports = new Set<number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    let value: string | undefined;
    if (token === "-p" || token === "--ports") {
      value = tokens[index + 1];
      index += 1;
    } else if (token.startsWith("--ports=")) {
      value = token.slice("--ports=".length);
    } else if (/^-p[\d]/.test(token)) {
      // nmap-style attached form: -p80, -p80,443, -p1-100.
      value = token.slice(2);
    } else if (/^-\d[\d,-]*$/.test(token)) {
      value = token.slice(1);
    }
    if (value === undefined) continue;
    for (const part of value.split(",")) {
      const range = /^(\d{1,5})-(\d{1,5})$/.exec(part);
      if (range !== null) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (isValidPort(start) && isValidPort(end) && end >= start && end - start <= 64) {
          for (let port = start; port <= end; port += 1) ports.add(port);
        }
        continue;
      }
      const port = Number(part);
      if (isValidPort(port)) ports.add(port);
    }
  }
  return [...ports];
}

function looksLikeHostname(token: string): boolean {
  const lower = token.toLowerCase();
  if (lower === "localhost") return true;
  if (!DOMAIN_RE.test(lower)) return false;
  const tld = lower.split(".").pop() ?? "";
  return !FILE_LIKE_TLDS.has(tld);
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

function toCidr(address: string, prefix: number): IPv4Cidr | null {
  const ip = parseIpv4(address);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, prefix };
}
