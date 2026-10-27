import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ConfigManager, ModelConfigEntry, ProviderPrefEntry } from "@cairn/agent";
import { HttpError } from "@cairn/graph";

import type { RouteContext } from "./api";
import { isCrossOrigin, requireOperator } from "./auth";

/** `cairn-worker.md` frontmatter binds the default worker to this model-prefs entry. */
const DEFAULT_WORKER_MODEL_PREF = "cairn-worker";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_NAME = 64;
const MAX_MODEL_ID = 128;
const MAX_BASE_URL = 2048;
const MAX_API_KEY = 4096;
const MAX_HEADER_VALUE = 4096;
const MAX_HEADER_COUNT = 32;
const THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const INPUT_MODALITIES = new Set(["text", "image"]);
const MODEL_PREF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface AgentModelReferences {
  workerProfiles?: { id: string; model: string }[];
  observerModel?: string | null;
}

export interface AgentConfigOptions {
  /** Defaults to `CAIRN_AGENT_CONFIG_DIR` or `~/.tch-agent/config`. */
  configDir?: string;
  /** Test seam; production lazily imports `@cairn/agent`. */
  factory?: (configDir: string) => Promise<ConfigManager>;
  operatorToken?: string;
  /** model-pref references from the dispatch config, used by delete guards. */
  references?: AgentModelReferences;
}

type RouteRegistrar = (
  method: string,
  template: string,
  handler: (context: RouteContext) => Promise<Response> | Response,
) => void;

interface ProviderView {
  id: string;
  name: string;
  api: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeySummary: string | null;
  headerNames: string[];
}

interface ModelView {
  id: string;
  provider: string;
  providerId: string | null;
  modelId: string;
  name: string | null;
  thinkingLevel: string | null;
  reasoning: boolean | null;
  input: ("text" | "image")[] | null;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  contextWindow: number | null;
  maxTokens: number | null;
  compat: unknown;
  headerNames: string[];
  isDefault: boolean;
  referencedBy: string[];
}

export function registerAgentConfigRoutes(
  register: RouteRegistrar,
  options: AgentConfigOptions = {},
): void {
  let managerPromise: Promise<ConfigManager> | undefined;

  function manager(): Promise<ConfigManager> {
    managerPromise ??= loadManager(options).catch((error: unknown) => {
      managerPromise = undefined;
      throw error;
    });
    return managerPromise;
  }

  function guarded(
    method: string,
    template: string,
    handler: (context: RouteContext) => Promise<Response> | Response,
  ): void {
    register(method, template, async (context) => {
      if (isCrossOrigin(context.request)) {
        throw new HttpError(403, "cross-origin request rejected");
      }
      if (method !== "GET") {
        requireOperator(context.request, options.operatorToken);
      }
      return handler(context);
    });
  }

  const references = (): AgentModelReferences => options.references ?? {};

  guarded("GET", "/settings/agent", async () => {
    const store = await manager();
    const [providerPrefs, modelPrefs] = await Promise.all([
      store.listProviderPrefs(),
      store.listModelPrefs(),
    ]);
    const providers: ProviderView[] = [];
    for (const pref of providerPrefs) {
      providers.push(await providerView(store, pref));
    }
    const models = modelPrefs.map((pref) => modelView(pref, references()));
    return json({
      defaultModelPrefId: models.some((model) => model.isDefault)
        ? DEFAULT_WORKER_MODEL_PREF
        : null,
      providers,
      models,
      protocols: store.listSupportedProtocols(),
      builtinProviders: store.listBuiltInProviders().map((entry) => ({
        provider: entry.provider,
        modelCount: entry.modelCount,
      })),
    });
  });

  guarded("POST", "/settings/agent/providers", async ({ request }) => {
    const store = await manager();
    const body = await readBody(request);
    const name = readRequiredText(body, "name", MAX_NAME);
    const api = readProtocol(store, body);
    const baseUrl = readBaseUrl(body);
    const apiKey = readApiKey(body);
    const headers = readHeaders(body, "headers");
    const id = readOptionalText(body, "id", MAX_NAME);
    if (id === null) throw new HttpError(400, "id must not be empty");
    if (id !== undefined && !MODEL_PREF_ID.test(id)) {
      throw new HttpError(400, "id must be a short slug of letters, digits, dot, dash or underscore");
    }
    validateTransport(store, name, api, baseUrl ?? undefined);

    const result = await store.addProviderPref({
      ...(id === undefined ? {} : { id }),
      name,
      ...(api === undefined ? {} : { api }),
      ...(baseUrl === undefined || baseUrl === null ? {} : { baseUrl }),
    });
    if (result.rejected) throw new HttpError(409, result.rejected);
    if (apiKey !== undefined) await store.applyProviderApiKey(result.id, apiKey);
    if (headers !== undefined) await store.setProviderHeaders(result.id, headers);

    const saved = (await store.listProviderPrefs()).find((pref) => pref.id === result.id);
    if (!saved) throw new HttpError(500, "provider was not persisted");
    return json({ id: result.id, provider: await providerView(store, saved) });
  });

  guarded("PUT", "/settings/agent/providers/{id}", async ({ params, request }) => {
    const store = await manager();
    const existing = (await store.listProviderPrefs()).find((pref) => pref.id === params.id);
    if (!existing) throw new HttpError(404, "provider not found");
    const body = await readBody(request);
    const name = readOptionalText(body, "name", MAX_NAME);
    const api = readProtocol(store, body);
    const baseUrl = readBaseUrl(body);
    const apiKey = readApiKey(body);
    const headers = readHeaders(body, "headers");

    const nextBaseUrl = baseUrl === undefined ? existing.baseUrl : baseUrl ?? undefined;
    validateTransport(store, name ?? existing.name, api ?? existing.api, nextBaseUrl);

    const patch: Partial<ProviderPrefEntry> = {};
    if (name !== undefined && name !== null) patch.name = name;
    if (api !== undefined) patch.api = api;
    if (baseUrl !== undefined) patch.baseUrl = baseUrl ?? undefined;

    const result = await store.updateProviderPref(existing.id, patch);
    if (result?.rejected) throw new HttpError(409, result.rejected);
    if (apiKey !== undefined) await store.applyProviderApiKey(existing.id, apiKey);
    if (headers !== undefined) await store.setProviderHeaders(existing.id, headers);

    const saved = (await store.listProviderPrefs()).find((pref) => pref.id === existing.id);
    if (!saved) throw new HttpError(500, "provider was not persisted");
    return json({ id: saved.id, provider: await providerView(store, saved) });
  });

  guarded("DELETE", "/settings/agent/providers/{id}", async ({ params, request }) => {
    const store = await manager();
    const existing = (await store.listProviderPrefs()).find((pref) => pref.id === params.id);
    if (!existing) throw new HttpError(404, "provider not found");
    const dependent = (await store.listModelPrefs()).filter(
      (pref) =>
        pref.providerId === existing.id ||
        (pref.providerId === undefined && pref.provider === existing.name),
    );
    if (dependent.length > 0 && !wantForce(request)) {
      throw new HttpError(
        409,
        `provider is used by ${dependent.length} model config(s): ${dependent
          .map((pref) => pref.id)
          .join(", ")}`,
      );
    }
    await store.removeProviderPref(existing.id);
    return json({ deleted: true, removedModels: dependent.map((pref) => pref.id) });
  });

  guarded("POST", "/settings/agent/providers/{id}/discover", async ({ params }) => {
    const store = await manager();
    const existing = (await store.listProviderPrefs()).find((pref) => pref.id === params.id);
    if (!existing) throw new HttpError(404, "provider not found");

    const isBuiltIn = store
      .listBuiltInProviders()
      .some((entry) => entry.provider === existing.name);
    if (isBuiltIn && existing.baseUrl === undefined) {
      return json({
        models: store
          .listBuiltInModels(existing.name)
          .map((model) => ({ id: model.id, name: model.name ?? model.id })),
      });
    }

    if (!store.getApiKeyValue(`provider:${existing.id}`)) {
      throw new HttpError(400, "API key is required before discovering models");
    }
    try {
      return json({ models: await store.discoverModels(existing.id) });
    } catch (error) {
      throw new HttpError(502, `model discovery failed: ${sanitizeText(describe(error))}`);
    }
  });

  guarded("POST", "/settings/agent/models", async ({ request }) => {
    const store = await manager();
    const body = await readBody(request);
    const providerId = readRequiredText(body, "providerId", MAX_NAME);
    const providerPref = (await store.listProviderPrefs()).find(
      (pref) => pref.id === providerId,
    );
    if (!providerPref) throw new HttpError(400, `unknown provider: ${providerId}`);
    const modelId = readRequiredText(body, "modelId", MAX_MODEL_ID);
    const id = readOptionalText(body, "id", MAX_NAME);
    if (id === null) throw new HttpError(400, "id must not be empty");
    if (id !== undefined && !MODEL_PREF_ID.test(id)) {
      throw new HttpError(400, "id must be a short slug of letters, digits, dot, dash or underscore");
    }

    const result = await store.addModelPref({
      ...(id === undefined ? {} : { id }),
      provider: providerPref.name,
      providerId,
      modelId,
      ...readModelFields(body),
    });
    if (result.rejected) throw new HttpError(409, result.rejected);
    const saved = (await store.listModelPrefs()).find((pref) => pref.id === result.id);
    if (!saved) throw new HttpError(500, "model config was not persisted");
    return json({ id: result.id, model: modelView(saved, references()) });
  });

  guarded("PUT", "/settings/agent/models/{id}", async ({ params, request }) => {
    const store = await manager();
    const existing = (await store.listModelPrefs()).find((pref) => pref.id === params.id);
    if (!existing) throw new HttpError(404, "model config not found");
    const body = await readBody(request);

    const patch: Partial<ModelConfigEntry> = { ...readModelFields(body) };
    const providerId = readOptionalText(body, "providerId", MAX_NAME);
    if (providerId === null) throw new HttpError(400, "providerId must not be empty");
    if (providerId !== undefined) {
      const providerPref = (await store.listProviderPrefs()).find(
        (pref) => pref.id === providerId,
      );
      if (!providerPref) throw new HttpError(400, `unknown provider: ${providerId}`);
      patch.provider = providerPref.name;
      patch.providerId = providerId;
    }
    const modelId = readOptionalText(body, "modelId", MAX_MODEL_ID);
    if (modelId === null) throw new HttpError(400, "modelId must not be empty");
    if (modelId !== undefined) patch.modelId = modelId;

    const result = await store.updateModelPref(existing.id, patch);
    if (!result) throw new HttpError(404, "model config not found");
    if (result.rejected) throw new HttpError(409, result.rejected);
    const saved = (await store.listModelPrefs()).find((pref) => pref.id === existing.id);
    if (!saved) throw new HttpError(500, "model config was not persisted");
    return json({ id: saved.id, model: modelView(saved, references()) });
  });

  guarded("DELETE", "/settings/agent/models/{id}", async ({ params, request }) => {
    const store = await manager();
    const existing = (await store.listModelPrefs()).find((pref) => pref.id === params.id);
    if (!existing) throw new HttpError(404, "model config not found");
    const usedBy = referencesFor(existing.id, references());
    if (usedBy.length > 0 && !wantForce(request)) {
      throw new HttpError(409, `model config is referenced by ${usedBy.join(", ")}`);
    }
    await store.removeModelPref(existing.id);
    return json({ deleted: true });
  });

  guarded("POST", "/settings/agent/models/{id}/test", async ({ params }) => {
    const store = await manager();
    const existing = (await store.listModelPrefs()).find((pref) => pref.id === params.id);
    if (!existing) throw new HttpError(404, "model config not found");

    let result: Awaited<ReturnType<ConfigManager["testModel"]>>;
    try {
      result = await store.testModel(existing.id);
    } catch (error) {
      return json({ ok: false, error: sanitizeText(describe(error)), summary: testSummary(existing) });
    }

    const details = result.details;
    const secret =
      details?.runtimeProvider === undefined
        ? undefined
        : store.getApiKeyValue(details.runtimeProvider);
    const summary = {
      ...testSummary(existing),
      ...(details?.api === undefined ? {} : { api: details.api }),
      ...(details?.baseUrl === undefined ? {} : { baseUrl: details.baseUrl }),
      apiKeySummary:
        details?.apiKeySummary ?? (secret === undefined ? null : maskKey(secret)),
    };
    return json({
      ok: result.ok === true,
      ...(result.error === undefined ? {} : { error: sanitizeText(result.error, secret) }),
      ...(result.response === undefined
        ? {}
        : { response: truncate(sanitizeText(result.response, secret), 4000) }),
      summary,
    });
  });

  guarded("PUT", "/settings/agent/default-model", async ({ request }) => {
    const store = await manager();
    const body = await readBody(request);
    const sourceId = readRequiredText(body, "modelPrefId", MAX_NAME);
    const modelPrefs = await store.listModelPrefs();
    const source = modelPrefs.find((pref) => pref.id === sourceId);
    if (!source) throw new HttpError(404, "model config not found");

    if (source.id === DEFAULT_WORKER_MODEL_PREF) {
      return json({ id: source.id, model: modelView(source, references()) });
    }

    const target: Partial<ModelConfigEntry> = {
      provider: source.provider,
      ...(source.providerId === undefined ? {} : { providerId: source.providerId }),
      modelId: source.modelId,
      ...copyModelFields(source),
    };
    const existingDefault = modelPrefs.some(
      (pref) => pref.id === DEFAULT_WORKER_MODEL_PREF,
    );
    const result = existingDefault
      ? await store.updateModelPref(DEFAULT_WORKER_MODEL_PREF, target, { allowDuplicate: true })
      : await store.addModelPref(
          { id: DEFAULT_WORKER_MODEL_PREF, ...target } as ModelConfigEntry,
          { allowDuplicate: true },
        );
    if (!result) throw new HttpError(500, "default model config was not persisted");
    if (result.rejected) throw new HttpError(409, result.rejected);

    const saved = (await store.listModelPrefs()).find(
      (pref) => pref.id === DEFAULT_WORKER_MODEL_PREF,
    );
    if (!saved) throw new HttpError(500, "default model config was not persisted");
    return json({ id: saved.id, model: modelView(saved, references()) });
  });
}

async function loadManager(options: AgentConfigOptions): Promise<ConfigManager> {
  const configDir = resolveConfigDir(options.configDir);
  if (options.factory !== undefined) return options.factory(configDir);
  // Lazy: the control plane stays cheap when the operator never opens the model panel.
  const agent = await import("@cairn/agent");
  return agent.ConfigManager.getInstance(configDir);
}

function resolveConfigDir(explicit: string | undefined): string {
  const fromOption = explicit?.trim();
  if (fromOption !== undefined && fromOption !== "") return resolve(fromOption);
  const fromEnv = process.env["CAIRN_AGENT_CONFIG_DIR"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  return join(homedir(), ".tch-agent", "config");
}

async function providerView(
  store: ConfigManager,
  pref: ProviderPrefEntry,
): Promise<ProviderView> {
  const runtime = `provider:${pref.id}`;
  const key = store.getApiKeyValue(runtime);
  const config = await store.getProvider(runtime);
  return {
    id: pref.id,
    name: pref.name,
    api: pref.api ?? null,
    baseUrl: pref.baseUrl ?? null,
    hasApiKey: typeof key === "string" && key.length > 0,
    apiKeySummary: key === undefined || key === "" ? null : maskKey(key),
    headerNames: headerNamesOf(config?.["headers"]),
  };
}

function modelView(pref: ModelConfigEntry, refs: AgentModelReferences): ModelView {
  return {
    id: pref.id,
    provider: pref.provider,
    providerId: pref.providerId ?? null,
    modelId: pref.modelId,
    name: pref.name ?? null,
    thinkingLevel: pref.thinkingLevel ?? null,
    reasoning: typeof pref.reasoning === "boolean" ? pref.reasoning : null,
    input: Array.isArray(pref.input) ? pref.input : null,
    cost:
      pref.cost === undefined
        ? null
        : {
            input: pref.cost.input,
            output: pref.cost.output,
            cacheRead: pref.cost.cacheRead,
            cacheWrite: pref.cost.cacheWrite,
          },
    contextWindow: typeof pref.contextWindow === "number" ? pref.contextWindow : null,
    maxTokens: typeof pref.maxTokens === "number" ? pref.maxTokens : null,
    compat: pref.compat ?? null,
    headerNames: headerNamesOf(pref.headers),
    isDefault: pref.id === DEFAULT_WORKER_MODEL_PREF,
    referencedBy: referencesFor(pref.id, refs),
  };
}

function referencesFor(id: string, refs: AgentModelReferences): string[] {
  const used: string[] = [];
  if (id === DEFAULT_WORKER_MODEL_PREF) used.push(`prompt:${DEFAULT_WORKER_MODEL_PREF}`);
  for (const profile of refs.workerProfiles ?? []) {
    if (profile.model === id) used.push(`worker_profile:${profile.id}`);
  }
  if (refs.observerModel !== null && refs.observerModel !== undefined && refs.observerModel === id) {
    used.push("observer");
  }
  return used;
}

function testSummary(pref: ModelConfigEntry) {
  return {
    modelPrefId: pref.id,
    provider: pref.provider,
    providerId: pref.providerId ?? null,
    modelId: pref.modelId,
    thinkingLevel: pref.thinkingLevel ?? null,
    reasoning: typeof pref.reasoning === "boolean" ? pref.reasoning : null,
    contextWindow: typeof pref.contextWindow === "number" ? pref.contextWindow : null,
    maxTokens: typeof pref.maxTokens === "number" ? pref.maxTokens : null,
    apiKeySummary: null as string | null,
  };
}

function headerNamesOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function copyModelFields(pref: ModelConfigEntry): Partial<ModelConfigEntry> {
  const copy: Partial<ModelConfigEntry> = {};
  for (const field of [
    "name",
    "thinkingLevel",
    "reasoning",
    "input",
    "cost",
    "contextWindow",
    "maxTokens",
    "headers",
    "compat",
  ] as const) {
    const value = pref[field];
    if (value !== undefined) {
      (copy as Record<string, unknown>)[field] = value;
    }
  }
  return copy;
}

function wantForce(request: Request): boolean {
  return new URL(request.url).searchParams.get("force") === "true";
}

function validateTransport(
  store: ConfigManager,
  name: string,
  api: string | undefined,
  baseUrl: string | undefined,
): void {
  const isBuiltIn = store.listBuiltInProviders().some((entry) => entry.provider === name);
  if (baseUrl === undefined) {
    if (isBuiltIn) return;
    throw new HttpError(400, "baseUrl is required for a custom provider");
  }
  if (api === undefined) {
    throw new HttpError(400, "api is required when baseUrl is set");
  }
}

function readProtocol(store: ConfigManager, record: Record<string, unknown>): string | undefined {
  const api = readOptionalText(record, "api", 64);
  if (api === undefined || api === null) return undefined;
  if (!store.listSupportedProtocols().includes(api)) {
    throw new HttpError(400, `unsupported api: ${api}`);
  }
  return api;
}

function readBaseUrl(record: Record<string, unknown>): string | null | undefined {
  const value = readOptionalText(record, "baseUrl", MAX_BASE_URL);
  if (value === undefined || value === null) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "baseUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "baseUrl must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new HttpError(400, "baseUrl must not contain credentials");
  }
  return value;
}

function readApiKey(record: Record<string, unknown>): string | null | undefined {
  const value = record["apiKey"];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "apiKey must be a string");
  const key = value.trim();
  if (key === "") return null;
  if (key.length < 4) throw new HttpError(400, "apiKey is too short");
  if (key.length > MAX_API_KEY) throw new HttpError(400, "apiKey is too long");
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new HttpError(400, "apiKey contains control characters");
  return key;
}

function readHeaders(
  record: Record<string, unknown>,
  field: string,
): Record<string, string> | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADER_COUNT) {
    throw new HttpError(400, `${field} has too many entries`);
  }
  const headers: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!HEADER_NAME.test(name)) {
      throw new HttpError(400, `${field} contains an invalid header name`);
    }
    if (typeof raw !== "string") {
      throw new HttpError(400, `${field}.${name} must be a string`);
    }
    if (raw.length > MAX_HEADER_VALUE || /[\r\n]/.test(raw)) {
      throw new HttpError(400, `${field}.${name} is invalid`);
    }
    headers[name] = raw;
  }
  return headers;
}

function readModelFields(record: Record<string, unknown>): Partial<ModelConfigEntry> {
  const fields: Partial<ModelConfigEntry> = {};
  const name = readOptionalText(record, "name", 128);
  if (name !== undefined) fields.name = name ?? undefined;

  const thinkingLevel = readOptionalText(record, "thinkingLevel", 16);
  if (thinkingLevel !== undefined) {
    if (thinkingLevel !== null && !THINKING_LEVELS.has(thinkingLevel)) {
      throw new HttpError(400, `unsupported thinkingLevel: ${thinkingLevel}`);
    }
    fields.thinkingLevel = thinkingLevel ?? undefined;
  }

  const reasoning = readOptionalBoolean(record, "reasoning");
  if (reasoning !== undefined) fields.reasoning = reasoning ?? undefined;

  const input = readInputModalities(record);
  if (input !== undefined) fields.input = input ?? undefined;

  const cost = readCost(record);
  if (cost !== undefined) fields.cost = cost ?? undefined;

  const contextWindow = readOptionalPositiveInt(record, "contextWindow");
  if (contextWindow !== undefined) fields.contextWindow = contextWindow ?? undefined;

  const maxTokens = readOptionalPositiveInt(record, "maxTokens");
  if (maxTokens !== undefined) fields.maxTokens = maxTokens ?? undefined;

  const headers = readHeaders(record, "headers");
  if (headers !== undefined) fields.headers = headers ?? undefined;

  const compat = readCompat(record);
  if (compat !== undefined) fields.compat = compat as ModelConfigEntry["compat"];

  return fields;
}

function readInputModalities(
  record: Record<string, unknown>,
): ("text" | "image")[] | null | undefined {
  const value = record["input"];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new HttpError(400, "input must be a non-empty array of modalities");
  }
  const seen = new Set<"text" | "image">();
  for (const item of value) {
    if (typeof item !== "string" || !INPUT_MODALITIES.has(item)) {
      throw new HttpError(400, 'input supports only "text" and "image"');
    }
    seen.add(item as "text" | "image");
  }
  return [...seen];
}

function readCost(
  record: Record<string, unknown>,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null | undefined {
  const value = record["cost"];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "cost must be an object");
  }
  const source = value as Record<string, unknown>;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const raw = source[field];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1_000_000) {
      throw new HttpError(400, `cost.${field} must be a non-negative number`);
    }
    cost[field] = raw;
  }
  return cost;
}

function readCompat(
  record: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const value = record["compat"];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "compat must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new HttpError(400, "compat has too many entries");
  const compat: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new HttpError(400, `compat.${key} must be a string, number or boolean`);
    }
    compat[key] = raw;
  }
  return compat;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

function readOptionalPositiveInt(
  record: Record<string, unknown>,
  field: string,
): number | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpError(400, `${field} must be a positive integer`);
  }
  if (value > 10_000_000) throw new HttpError(400, `${field} is too large`);
  return value;
}

function readOptionalText(
  record: Record<string, unknown>,
  field: string,
  max: number,
): string | null | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${field} is too long`);
  return text === "" ? null : text;
}

function readRequiredText(record: Record<string, unknown>, field: string, max: number): string {
  const value = readOptionalText(record, field, max);
  if (value === undefined || value === null) {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body too large");
    }
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function maskKey(key: string): string {
  if (key.length <= 16) return `${key.slice(0, 6)}...${key.slice(-4)}`;
  if (key.length <= 28) return `${key.slice(0, 8)}...${key.slice(-6)}`;
  return `${key.slice(0, 10)}...${key.slice(-8)}`;
}

function sanitizeText(text: string, secret?: string): string {
  let out = text;
  if (secret !== undefined && secret.length >= 4) {
    out = out.split(secret).join("<redacted>");
  }
  out = out.replace(/\b(?:sk|pk|rk|ak)[-_][A-Za-z0-9_-]{6,}\b/g, (match) => `${match.slice(0, 3)}<redacted>`);
  out = out.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer <redacted>");
  out = out.replace(
    /\b(api[_-]?key|token|secret|password|authorization)\b(\s*[:=]\s*)([^\s"',;}]+)/gi,
    (_match, label: string, separator: string) => `${label}${separator}<redacted>`,
  );
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
