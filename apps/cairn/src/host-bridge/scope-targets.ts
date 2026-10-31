/**
 * Scope target parsing and matching.
 *
 * Targets are intentionally literal: hostnames are not resolved through DNS in the
 * enforcement path (a resolver could be tricked), so a hostname target matches that exact
 * hostname, and CIDR targets only match literal IP endpoints.
 */

import { isIP } from "node:net";
import { resolve } from "node:path";

import { fileScopeTargetPath } from "../runtime/paths";

export interface IPv4Cidr {
  base: number;
  prefix: number;
}

export interface ParsedTarget {
  raw: string;
  kind: "file" | "host";
  /** For file targets. */
  path?: string;
  /** For host targets: lower-cased hostname or IP literal. */
  host?: string;
  port?: number;
  wildcard?: boolean;
  cidr?: IPv4Cidr;
}

export interface ParsedScope {
  targets: ParsedTarget[];
  invalid: Array<{ raw: string; reason: string }>;
}

export interface Endpoint {
  raw: string;
  /** Lower-cased hostname or IP literal. */
  host?: string;
  port?: number;
  cidr?: IPv4Cidr;
  /**
   * Where the literal came from. `primary` is a destination the command connects to;
   * `carried` is a host literal inside an authorized request — a URL's query or fragment,
   * a request body or a form field — which the command does not contact itself but the
   * receiving server might. Absent means primary.
   */
  role?: "primary" | "carried";
}

export function parseScopeTargets(rawTargets: readonly string[]): ParsedScope {
  const targets: ParsedTarget[] = [];
  const invalid: Array<{ raw: string; reason: string }> = [];
  for (const rawTarget of rawTargets) {
    const raw = rawTarget.trim();
    if (raw === "") {
      invalid.push({ raw, reason: "empty scope target" });
      continue;
    }
    try {
      targets.push(parseTarget(raw));
    } catch (error) {
      invalid.push({ raw, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { targets, invalid };
}

function parseTarget(raw: string): ParsedTarget {
  const filePath = fileScopeTargetPath(raw);
  if (filePath !== null) {
    return { raw, kind: "file", path: resolve(filePath) };
  }
  if (/^file:/i.test(raw)) {
    throw new Error("remote file: authorities are not supported");
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported URL scheme: ${url.protocol}`);
    }
    const host = normalizeHost(url.hostname);
    if (host === "") throw new Error("URL has no host");
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : parsePort(url.port);
    return { raw, kind: "host", host, port };
  }

  const cidr = parseCidr(raw);
  if (cidr !== null) {
    return { raw, kind: "host", cidr };
  }

  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(raw);
  if (bracketed !== null) {
    const host = normalizeHost(bracketed[1]!);
    if (isIP(host) !== 6) throw new Error("invalid IPv6 address");
    return {
      raw,
      kind: "host",
      host,
      ...(bracketed[2] === undefined ? {} : { port: parsePort(bracketed[2]) }),
    };
  }

  if (isIP(raw) === 6) {
    return { raw, kind: "host", host: normalizeHost(raw) };
  }

  const hostPort = /^([^:\s/]+):(\d{1,5})$/.exec(raw);
  if (hostPort !== null) {
    const host = normalizeHost(hostPort[1]!);
    validateHost(host);
    return { raw, kind: "host", host, port: parsePort(hostPort[2]!) };
  }

  const lower = normalizeHost(raw);
  if (lower.startsWith("*.")) {
    const suffix = lower.slice(2);
    validateHost(suffix);
    return { raw, kind: "host", host: suffix, wildcard: true };
  }
  validateHost(lower);
  return { raw, kind: "host", host: lower };
}

export function endpointAllowed(endpoint: Endpoint, targets: readonly ParsedTarget[]): boolean {
  return targets.some((target) => target.kind === "host" && matches(target, endpoint));
}

function matches(target: ParsedTarget, endpoint: Endpoint): boolean {
  if (target.cidr !== undefined) {
    if (endpoint.cidr !== undefined) {
      if (!cidrSubset(endpoint.cidr, target.cidr)) return false;
      return portAllowed(target.port, endpoint.port);
    }
    if (endpoint.host === undefined) return false;
    const ip = parseIpv4(endpoint.host);
    if (ip === null || !cidrContains(target.cidr, ip)) return false;
    return portAllowed(target.port, endpoint.port);
  }

  if (target.host === undefined) return false;

  if (endpoint.cidr !== undefined) {
    if (endpoint.cidr.prefix !== 32) return false;
    if (!hostMatches(target, intToIpv4(endpoint.cidr.base))) return false;
    return portAllowed(target.port, endpoint.port);
  }

  if (endpoint.host === undefined) return false;
  if (!hostMatches(target, endpoint.host)) return false;
  return portAllowed(target.port, endpoint.port);
}

function hostMatches(target: ParsedTarget, host: string): boolean {
  const candidate = normalizeHost(host);
  if (target.wildcard === true) {
    return candidate.endsWith(`.${target.host}`);
  }
  return candidate === target.host;
}

function portAllowed(targetPort: number | undefined, endpointPort: number | undefined): boolean {
  if (targetPort === undefined) return true;
  return endpointPort !== undefined && endpointPort === targetPort;
}

function cidrContains(cidr: IPv4Cidr, ip: number): boolean {
  if (cidr.prefix === 0) return true;
  const mask = maskFor(cidr.prefix);
  return (ip & mask) === cidr.base;
}

function cidrSubset(inner: IPv4Cidr, outer: IPv4Cidr): boolean {
  if (inner.prefix < outer.prefix) return false;
  return cidrContains(outer, inner.base);
}

function maskFor(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function parseCidr(raw: string): IPv4Cidr | null {
  const match = /^([^/\s]+)\/(\d{1,2})$/.exec(raw);
  if (match === null) return null;
  const ip = parseIpv4(match[1]!);
  const prefix = Number(match[2]);
  if (ip === null) throw new Error("CIDR requires an IPv4 address");
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error("IPv4 CIDR prefix must be between 0 and 32");
  }
  return { base: (ip & maskFor(prefix)) >>> 0, prefix };
}

function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function validateHost(host: string): void {
  if (host === "") throw new Error("empty host");
  if (isIP(host) !== 0) return;
  if (host.length > 253) throw new Error("host is too long");
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
    throw new Error("invalid host name");
  }
  if (host.includes("..")) throw new Error("invalid host name");
}

function parsePort(raw: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new Error("invalid port");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be between 1 and 65535");
  }
  return port;
}

/** Parses an HTTP(S) URL into an endpoint; other schemes are ignored. */
export function endpointFromUrl(raw: string): Endpoint | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = normalizeHost(url.hostname);
  if (host === "") return null;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { raw, host, port };
}
