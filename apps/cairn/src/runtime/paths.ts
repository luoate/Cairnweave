/**
 * Host <-> worker path mapping.
 *
 * Container tasks use the project workspace bind-mounted at `/cairn/workspace`. Every
 * path written into task.json goes through this module; scheduler code never concatenates
 * container paths itself.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export const CONTAINER_WORKSPACE = "/cairn/workspace";
export const CONTAINER_AGENT_CONFIG = "/cairn/agent-config";

/** Returns the container path for a host path under `hostWorkspace`, else null. */
export function containerPathFor(hostWorkspace: string, hostPath: string): string | null {
  if (hostPath.trim() === "") return null;
  const rel = relative(resolve(hostWorkspace), resolve(hostPath));
  if (rel === "") return CONTAINER_WORKSPACE;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  const parts = rel.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  return parts.length === 0 ? CONTAINER_WORKSPACE : `${CONTAINER_WORKSPACE}/${parts.join("/")}`;
}

/**
 * Extracts a local path from a `file:` scope target. Supports the forms users actually
 * write: `file:///abs/path`, `file://C:/win/path`, `file:/abs/path`.
 * Returns null for remote authorities (unsupported) and non-file targets.
 */
export function fileScopeTargetPath(raw: string): string | null {
  if (!/^file:/i.test(raw)) return null;
  let rest = raw.slice("file:".length);

  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    if (/^\/[A-Za-z]:[\\/]/.test(rest)) {
      rest = rest.slice(1);
    }
    if (/^[A-Za-z]:[\\/]/.test(rest)) {
      return decodeURIComponent(rest).replaceAll("/", "\\");
    }
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const pathPart = slash === -1 ? "/" : rest.slice(slash);
    if (authority === "" || authority.toLowerCase() === "localhost") {
      return decodeURIComponent(pathPart);
    }
    return null;
  }

  if (!rest.startsWith("/") && !/^[A-Za-z]:/.test(rest)) {
    rest = `/${rest}`;
  }
  return decodeURIComponent(rest);
}

/** Builds a worker-view `file:` URL without assuming the worker's platform. */
export function workerFileUrl(workerPath: string): string {
  const normalized = workerPath.replaceAll("\\", "/");
  const encoded = encodeURI(normalized).replaceAll("#", "%23").replaceAll("?", "%3F");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

/**
 * Scope targets are host paths at the control plane and worker paths in the task. File
 * targets under the project workspace are rewritten; everything else is left untouched.
 */
export function mapScopeTargetForWorker(
  target: string,
  mapIfUnderWorkspace: (hostPath: string) => string | null,
): string {
  const hostPath = fileScopeTargetPath(target);
  if (hostPath === null) return target;
  const mapped = mapIfUnderWorkspace(hostPath);
  return mapped === null ? target : workerFileUrl(mapped);
}
