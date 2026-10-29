/**
 * Runtime settings routes (M22).
 *
 * `GET /settings/runtime` returns the effective dispatch configuration plus the values
 * from dispatch.yaml alone, so the UI can show what an override changed and build a
 * minimal patch. `PUT` replaces the stored override set and applies it to the live
 * scheduler configuration; `DELETE` clears every override. Without `--config` there is
 * no store and both writes answer 409 instead of pretending to persist.
 */

import { HttpError } from "@cairn/graph";

import type { RuntimeConfigStore } from "../config-overrides";
import { ConfigError } from "../config";
import type { RouteContext } from "./api";
import { isCrossOrigin, requireOperator } from "./auth";

type RouteRegistrar = (
  method: string,
  template: string,
  handler: (context: RouteContext) => Promise<Response> | Response,
) => void;

const MAX_BODY_BYTES = 64 * 1024;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readPatch(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError(413, "runtime settings body is too large");
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "runtime settings body is too large");
  }
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "runtime settings body must be a JSON object");
  }
}

export interface SettingsRuntimeOptions {
  store: RuntimeConfigStore | null;
  operatorToken?: string;
}

export function registerSettingsRuntimeRoutes(
  register: RouteRegistrar,
  options: SettingsRuntimeOptions,
): void {
  function requireStore(): RuntimeConfigStore {
    if (options.store === null) {
      throw new HttpError(
        409,
        "no dispatch config is loaded; start `cairn serve --config <file>` to edit runtime settings",
      );
    }
    return options.store;
  }

  function guard(request: Request): void {
    if (isCrossOrigin(request)) {
      throw new HttpError(403, "cross-origin runtime settings are not allowed");
    }
    requireOperator(request, options.operatorToken);
  }

  register("GET", "/settings/runtime", () => json(requireStore().view()));

  register("PUT", "/settings/runtime", async ({ request }) => {
    guard(request);
    const store = requireStore();
    const body = await readPatch(request);
    try {
      return json(store.apply(body));
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new HttpError(400, error.message);
      }
      throw error;
    }
  });

  register("DELETE", "/settings/runtime", ({ request }) => {
    guard(request);
    return json(requireStore().reset());
  });
}
