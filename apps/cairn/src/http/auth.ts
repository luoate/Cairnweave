import { timingSafeEqual } from "node:crypto";

import { HttpError } from "@cairn/graph";

/**
 * Manual completion is an operator override, not a worker action. The guard is opt-in so
 * existing deployments and the API golden keep working when no token is configured.
 */
export function requireOperator(request: Request, operatorToken: string | undefined): void {
  if (operatorToken === undefined || operatorToken === "") {
    return;
  }
  const provided = request.headers.get("x-cairn-operator-token") ?? "";
  const expected = Buffer.from(operatorToken);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(401, "operator token required");
  }
}

/**
 * The control plane has no authentication, so the credential routes also reject browser
 * writes whose Origin does not match the request host. Non-browser clients normally omit
 * Origin and keep working; the operator token, when configured, still applies.
 */
export function isCrossOrigin(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return false;
  const origin = request.headers.get("origin");
  if (origin === null || origin.trim() === "") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  return originHost !== new URL(request.url).host;
}
