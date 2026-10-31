/**
 * Bash command analysis for the Host Bridge.
 *
 * This is a conservative endpoint extractor, not a shell interpreter. It recognizes the
 * common network tools used by the solver plus URLs, IPs, CIDRs and host:port tokens.
 * A recognized network action with no verifiable endpoint fails closed. Commands that
 * hide their destination inside an interpreter program are rejected by the same rule.
 *
 * Endpoints are split by provenance. `primary` is where the command connects; `carried` is
 * a host literal inside the request data it hands to that destination — a URL's query or
 * fragment, a `--data`/`-F` body, an uploaded file. The distinction is what the SSRF-marker
 * policy needs: the second class is not a destination the worker chose, so it is judged by
 * `scope.ssrf_markers` in `bridge.ts` instead of by the scope list.
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
  /** Destinations the command contacts itself. Enforced against scope. */
  endpoints: Endpoint[];
  /**
   * Host literals carried inside an authorized request — the query or fragment of a URL, a
   * request body, a form field. The command does not contact them, but the receiving server
   * may be told to. Feeds the SSRF-marker policy in `bridge.ts`.
   */
  carried: Endpoint[];
  /** Payload files referenced by request-body flags (`@file`), relative to the worker. */
  payloadRefs: string[];
  /** Set when a network action has no verifiable primary endpoint. */
  unverifiable: boolean;
}

/** Flags whose value is a request body sent to the primary destination. */
const BODY_VALUE_FLAGS = new Set([
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--url-query",
  "-F",
  "--form",
  "--form-string",
  "--post-data",
  "--body-data",
]);

/** Flags whose value names a local file whose contents are sent to the primary destination. */
const FILE_VALUE_FLAGS = new Set(["-T", "--upload-file", "--post-file", "--body-file"]);
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
const DEV_TCP_RE = /\/dev\/(?:tcp|udp)\/([^/\s]+)\/(\d{1,5})/gi;
const CIDR_RE = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})(?![\w.])/g;
const IPV4_RE = /(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?![\w.])/g;
const IPV6_RE = /\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?/g;
const USER_AT_HOST_RE = /\b[A-Za-z0-9._-]+@([A-Za-z0-9.-]+)/g;
/** `host:port` with no scheme, for scheme-less literals carried inside a parameter value. */
const HOST_PORT_RE =
  /(?<![\w./-])([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+):(\d{1,5})/gi;
/** A payload reference starts a value or follows `=`, `&` or whitespace, so emails stay out. */
const PAYLOAD_REF_RE = /(?:^|[=&\s])@([^\s"'`;|&<>(),]{1,512})/g;

const MAX_CARRIED_TEXT = 8 * 1024;
const MAX_CARRIED_ENDPOINTS = 16;
const MAX_PAYLOAD_REFS = 8;

interface ShellToken {
  value: string;
  /** Offset of the token in the command, pointing at the opening quote when quoted. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

interface CarriedRegion {
  start: number;
  end: number;
  text: string;
}

export function analyzeCommand(
  command: string,
  namedHosts: readonly string[] = [],
): CommandAnalysis {
  const positioned = scanTokens(command);
  const tokens = positioned.map((token) => token.value);
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
    return { networkIntent: false, endpoints: [], carried: [], payloadRefs: [], unverifiable: false };
  }

  // Regions the command sends *to* its destination rather than connecting to. They are cut
  // out of the text the primary scan reads and handed to the carried scan instead.
  const regions: CarriedRegion[] = [];
  for (const url of command.matchAll(URL_RE)) {
    const raw = url[0]!.replace(/[),.;\]}]+$/, "");
    const cut = parameterStart(raw);
    if (cut < 0) continue;
    regions.push({ start: url.index! + cut, end: url.index! + raw.length, text: raw.slice(cut) });
  }

  const payloadRefs: string[] = [];
  for (let index = 0; index < positioned.length; index += 1) {
    const body = bodyFlagValue(positioned, index);
    if (body === null) continue;
    index = body.nextTokenIndex;
    regions.push({ start: body.start, end: body.end, text: body.value });
    if (body.isFileFlag) pushPayloadRef(payloadRefs, body.value.replace(/^@/, ""));
    for (const match of body.value.matchAll(PAYLOAD_REF_RE)) {
      pushPayloadRef(payloadRefs, match[1]!);
    }
  }

  const scanText = maskRegions(command, regions);

  const endpoints: Endpoint[] = [];
  const seen = new Set<string>();
  const add = (endpoint: Endpoint): void => {
    const key = endpointKey(endpoint);
    if (seen.has(key)) return;
    seen.add(key);
    endpoints.push({ ...endpoint, role: "primary" });
  };

  const portHints = collectPortHints(tokens, tools);

  // URLs with an explicit scheme are always checked, even without a known tool. The
  // authority is what is contacted; parameter regions and request bodies were cut out above,
  // so a URL quoted inside `-d '<!ENTITY … "http://127.0.0.1:6379/">'` is carried, not a
  // destination.
  for (const match of scanText.matchAll(URL_RE)) {
    const raw = match[0]!.replace(/[),.;\]}]+$/, "");
    if (/^file:/i.test(raw)) continue;
    const endpoint = endpointFromUrl(raw);
    if (endpoint !== null) add(endpoint);
  }

  // /dev/tcp/host/port and similar shell escapes.
  for (const match of scanText.matchAll(DEV_TCP_RE)) {
    const host = normalizeHost(match[1]!);
    const port = Number(match[2]);
    if (isValidPort(port)) add({ raw: match[0], host, port });
  }

  // CIDRs first so the IPv4 pattern does not also record the network address as a host.
  for (const match of scanText.matchAll(CIDR_RE)) {
    const cidr = toCidr(match[1]!, Number(match[2]));
    if (cidr !== null) add({ raw: match[0], cidr });
  }

  for (const match of scanText.matchAll(IPV4_RE)) {
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

  for (const match of scanText.matchAll(IPV6_RE)) {
    const host = normalizeHost(match[1]!);
    if (isIP(host) !== 6) continue;
    const port = match[2] === undefined ? undefined : Number(match[2]);
    if (port !== undefined && !isValidPort(port)) continue;
    add({ raw: match[0], host, ...(port === undefined ? {} : { port }) });
  }

  // user@host (ssh, scp, rsync-style).
  for (const match of scanText.matchAll(USER_AT_HOST_RE)) {
    const host = normalizeHost(match[1]!);
    if (host !== "" && (isIP(host) !== 0 || looksLikeHostname(host))) {
      add({ raw: match[0], host });
    }
  }

  // Positional hostnames / host:port tokens for recognized network tools. Tokens that are a
  // request body are not destinations, whatever they mention.
  if (tools.size > 0) {
    for (const token of positioned) {
      if (isMasked(token.start, regions)) continue;
      if (token.value.startsWith("-")) continue;
      if (token.value.startsWith("[") && token.value.includes("]")) continue;

      const hostPort = /^([^:\s/]+):(\d{1,5})$/.exec(token.value);
      if (hostPort !== null) {
        const host = normalizeHost(hostPort[1]!);
        const port = Number(hostPort[2]);
        if (isValidPort(port) && (isIP(host) !== 0 || looksLikeHostname(host))) {
          add({ raw: token.value, host, port });
        }
        continue;
      }

      if (isIP(token.value) !== 0) continue; // covered above
      if (!looksLikeHostname(token.value)) continue;
      const ports = portHints.length > 0 ? portHints : [undefined];
      for (const port of ports) {
        add({
          raw: token.value,
          host: normalizeHost(token.value),
          ...(port === undefined ? {} : { port }),
        });
      }
    }
  }

  // nc/ncat host port (the port is positional, not a -p flag).
  if (tools.has("nc") || tools.has("ncat") || tools.has("netcat")) {
    const positional: string[] = [];
    for (const token of positioned) {
      if (isMasked(token.start, regions)) continue;
      if (token.value.startsWith("-")) continue;
      if (NETWORK_TOOLS.has(basename(token.value))) continue;
      positional.push(token.value);
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

  const carried = collectCarried(
    regions.map((region) => region.text),
    seen,
    namedHosts,
  );

  if (endpoints.length === 0 && tokens.some((token) => HELP_FLAGS.has(token))) {
    return {
      networkIntent: false,
      endpoints: [],
      carried: [],
      payloadRefs: [],
      unverifiable: false,
    };
  }

  return {
    networkIntent: true,
    endpoints,
    carried,
    payloadRefs,
    unverifiable: endpoints.length === 0,
  };
}

/**
 * Host literals inside request data. Percent-escapes are decoded once because a target
 * reaches the receiver's fetcher whether or not the caller encoded it; port hints from the
 * outer tool are ignored, since they describe the destination, not the carried literal.
 *
 * `namedHosts` is how the caller says "these spelled-out names are infrastructure, report
 * them even with no scheme and no port". Without it a body field that carries only a
 * hostname is invisible: most patterns here need a port or a scheme to tell a hostname
 * from ordinary text.
 */
function collectCarried(
  texts: readonly string[],
  primary: ReadonlySet<string>,
  namedHosts: readonly string[] = [],
): Endpoint[] {
  const carried: Endpoint[] = [];
  const seen = new Set<string>();
  const add = (endpoint: Endpoint): void => {
    if (carried.length >= MAX_CARRIED_ENDPOINTS) return;
    const key = endpointKey(endpoint);
    if (seen.has(key) || primary.has(key)) return;
    seen.add(key);
    carried.push({ ...endpoint, role: "carried" });
  };

  for (const region of texts) {
    const text = decodeCarriedText(region).slice(0, MAX_CARRIED_TEXT);
    const authorities: Array<{ start: number; end: number }> = [];
    for (const match of text.matchAll(URL_RE)) {
      const raw = match[0]!.replace(/[),.;\]}]+$/, "");
      if (/^file:/i.test(raw)) continue;
      const endpoint = endpointFromUrl(raw);
      if (endpoint === null) continue;
      add(endpoint);
      // Blank the authority so the literal patterns below do not report the same host a
      // second time without the URL's default port.
      const start = match.index! + raw.indexOf("://") + 3;
      let end = start;
      while (end < match.index! + raw.length && !"/?#".includes(text[end]!)) end += 1;
      authorities.push({ start, end });
    }
    const rest = blankRanges(text, authorities);
    for (const match of rest.matchAll(DEV_TCP_RE)) {
      const host = normalizeHost(match[1]!);
      const port = Number(match[2]);
      if (isValidPort(port)) add({ raw: match[0], host, port });
    }
    for (const match of rest.matchAll(CIDR_RE)) {
      const cidr = toCidr(match[1]!, Number(match[2]));
      if (cidr !== null) add({ raw: match[0], cidr });
    }
    for (const match of rest.matchAll(IPV4_RE)) {
      if (parseIpv4(match[1]!) === null) continue;
      const port = match[2] === undefined ? undefined : Number(match[2]);
      if (port !== undefined && !isValidPort(port)) continue;
      add({
        raw: match[0],
        host: normalizeHost(match[1]!),
        ...(port === undefined ? {} : { port }),
      });
    }
    for (const match of rest.matchAll(IPV6_RE)) {
      const host = normalizeHost(match[1]!);
      if (isIP(host) !== 6) continue;
      const port = match[2] === undefined ? undefined : Number(match[2]);
      if (port !== undefined && !isValidPort(port)) continue;
      add({ raw: match[0], host, ...(port === undefined ? {} : { port }) });
    }
    for (const match of rest.matchAll(USER_AT_HOST_RE)) {
      const host = normalizeHost(match[1]!);
      if (host !== "" && (isIP(host) !== 0 || looksLikeHostname(host))) {
        add({ raw: match[0], host });
      }
    }
    for (const match of rest.matchAll(HOST_PORT_RE)) {
      const host = normalizeHost(match[1]!);
      const port = Number(match[2]);
      if (!isValidPort(port)) continue;
      // looksLikeHostname already rejects file-like suffixes such as `backup.sql:80`.
      if (!looksLikeHostname(host)) continue;
      add({ raw: match[0], host, port });
    }
    for (const host of namedHosts) {
      // The URL form of the same name is already reported with its port.
      if (carried.some((endpoint) => endpoint.host === host)) continue;
      if (namedHostPattern(host).test(rest)) add({ raw: host, host });
    }
  }
  return carried;
}

const NAMED_HOST_PATTERNS = new Map<string, RegExp>();

/**
 * A caller-supplied hostname, matched only outside a path or a longer name: `/srv/name.cfg`
 * is a file, not a server.
 */
function namedHostPattern(host: string): RegExp {
  const cached = NAMED_HOST_PATTERNS.get(host);
  if (cached !== undefined) return cached;
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![a-z0-9._/-])${escaped}(?![a-z0-9.-])`, "i");
  NAMED_HOST_PATTERNS.set(host, pattern);
  return pattern;
}

function endpointKey(endpoint: Endpoint): string {
  return endpoint.cidr !== undefined
    ? `cidr:${endpoint.cidr.base}/${endpoint.cidr.prefix}|${endpoint.port ?? ""}`
    : `host:${endpoint.host ?? ""}|${endpoint.port ?? ""}`;
}

/** Offset just past the authority, where a URL stops naming the destination. */
function parameterStart(raw: string): number {
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd < 0) return -1;
  let index = schemeEnd + 3;
  while (index < raw.length && !"/?#".includes(raw[index]!)) index += 1;
  if (index >= raw.length) return -1;
  if (raw[index] !== "/") return index;
  for (let cursor = index; cursor < raw.length; cursor += 1) {
    if (raw[cursor] === "?" || raw[cursor] === "#") return cursor;
  }
  return -1;
}

function maskRegions(command: string, regions: readonly CarriedRegion[]): string {
  return blankRanges(command, regions);
}

/** Replaces each span with spaces so a scan of the result cannot read the removed text. */
function blankRanges(
  text: string,
  ranges: readonly { start: number; end: number }[],
): string {
  if (ranges.length === 0) return text;
  const chars = text.split("");
  for (const range of ranges) {
    for (let index = range.start; index < Math.min(range.end, chars.length); index += 1) {
      chars[index] = " ";
    }
  }
  return chars.join("");
}

function isMasked(start: number, regions: readonly CarriedRegion[]): boolean {
  return regions.some((region) => start >= region.start && start < region.end);
}

/** Reads the value of a request-body flag, either `--data=x` or `--data x`. */
function bodyFlagValue(
  tokens: readonly ShellToken[],
  index: number,
): { value: string; start: number; end: number; isFileFlag: boolean; nextTokenIndex: number } | null {
  const token = tokens[index]!;
  const equals = token.value.indexOf("=");
  const rawFlag = equals === -1 ? token.value : token.value.slice(0, equals);
  // Long flags are case-insensitive, short ones are not: `curl -f` (--fail) and `-F`
  // (form body) are different options and only the second carries request data.
  const flag = rawFlag.startsWith("--") ? rawFlag.toLowerCase() : rawFlag;
  const isFileFlag = FILE_VALUE_FLAGS.has(flag);
  if (!isFileFlag && !BODY_VALUE_FLAGS.has(flag)) return null;
  if (equals > 0) {
    return {
      value: token.value.slice(equals + 1),
      start: token.start + equals + 1,
      end: token.end,
      isFileFlag,
      nextTokenIndex: index,
    };
  }
  const next = tokens[index + 1];
  if (next === undefined || next.value.startsWith("-")) return null;
  return {
    value: next.value,
    start: next.start,
    end: next.end,
    isFileFlag,
    nextTokenIndex: index + 1,
  };
}

function pushPayloadRef(refs: string[], ref: string): void {
  if (refs.length >= MAX_PAYLOAD_REFS) return;
  const trimmed = ref.trim();
  if (trimmed === "" || trimmed === "-") return;
  if (!refs.includes(trimmed)) refs.push(trimmed);
}

function decodeCarriedText(text: string): string {
  const percent = text.replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return percent.replace(/\+/g, " ");
}

function scanTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&<>()]+/g;
  for (const match of command.matchAll(pattern)) {
    const raw = match[0]!;
    const start = match.index!;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      tokens.push({ value: raw.slice(1, -1), start: start + 1, end: start + raw.length - 1 });
    } else {
      tokens.push({ value: raw, start, end: start + raw.length });
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

/**
 * Carried targets inside a single URL, for the HTTP fetch tools where there is no command to
 * tokenize. A target that is also the URL's own authority is not carried.
 */
export function carriedFromUrl(
  rawUrl: string,
  namedHosts: readonly string[] = [],
): Endpoint[] {
  const cut = parameterStart(rawUrl);
  if (cut < 0) return [];
  const primary = endpointFromUrl(rawUrl.slice(0, cut));
  const skip = new Set(primary === null ? [] : [endpointKey(primary)]);
  return collectCarried([rawUrl.slice(cut)], skip, namedHosts);
}

/** Carried targets anywhere in a text blob, used for payload files and form values. */
export function carriedTargetsInText(
  text: string,
  namedHosts: readonly string[] = [],
): Endpoint[] {
  return collectCarried([text], new Set(), namedHosts);
}
