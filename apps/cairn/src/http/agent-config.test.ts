import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConfigManager } from "@cairn/agent";
import { configureDatabase, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

const KEY = "sk-test-abcdef123456";
const ROTATED_KEY = "sk-test-rotated-654321";
const TENANT = "tenant-1";
const MODEL_TOKEN = "model-secret";

let directory: string;
let configDir: string;
let db: CairnDatabase;
let api: Api;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-agent-config-"));
  configDir = join(directory, "agent");
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, agentConfigDir: configDir });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function readConfig(name: string): string {
  return readFileSync(join(configDir, name), "utf8");
}

async function createProvider(extra: Record<string, unknown> = {}): Promise<string> {
  const response = await call("POST", "/settings/agent/providers", {
    name: "lab-gateway",
    api: "openai-completions",
    baseUrl: "https://lab.invalid/v1",
    apiKey: KEY,
    ...extra,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function createModel(providerId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await call("POST", "/settings/agent/models", {
    providerId,
    modelId: "lab-model",
    ...extra,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string };
  return body.id;
}

describe("agent config routes", () => {
  test("stores a provider key without echoing it", async () => {
    const providerId = await createProvider();

    const prefs = readConfig("provider-prefs.json");
    expect(prefs).not.toContain(KEY);
    expect(readConfig("auth.json")).toContain(KEY);

    const response = await call("GET", "/settings/agent");
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(KEY);

    const body = JSON.parse(raw) as {
      providers: Array<{
        id: string;
        name: string;
        api: string;
        baseUrl: string;
        hasApiKey: boolean;
        apiKeySummary: string;
      }>;
      models: unknown[];
      protocols: string[];
    };
    const provider = body.providers.find((entry) => entry.id === providerId)!;
    expect(provider.name).toBe("lab-gateway");
    expect(provider.api).toBe("openai-completions");
    expect(provider.baseUrl).toBe("https://lab.invalid/v1");
    expect(provider.hasApiKey).toBe(true);
    expect(provider.apiKeySummary).toBe("sk-test-...123456");
    expect(body.protocols).toContain("openai-completions");
    expect(body.models).toEqual([]);
  });

  test("inherits built-in protocol and base URL for a provider pref", async () => {
    const response = await call("POST", "/settings/agent/providers", { name: "anthropic" });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };

    const models = JSON.parse(readConfig("models.json")) as {
      providers: Record<string, { displayName?: string; api?: string; baseUrl?: string }>;
    };
    const runtime = models.providers[`provider:${id}`]!;
    expect(runtime.displayName).toBe("anthropic");
    expect(runtime.api).toBe("anthropic-messages");
    expect(runtime.baseUrl).toBe("https://api.anthropic.com");

    const discovery = await call("POST", `/settings/agent/providers/${id}/discover`);
    expect(discovery.status).toBe(200);
    const discovered = (await discovery.json()) as { models: Array<{ id: string }> };
    expect(discovered.models.some((model) => model.id === "claude-sonnet-4-5")).toBe(true);
  });

  test("keeps custom headers write-only and exposes only their names", async () => {
    const providerId = await createProvider({ headers: { "x-tenant": TENANT } });
    await createModel(providerId, {
      name: "Lab Model",
      thinkingLevel: "medium",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 4096,
      input: ["text", "image"],
      cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
      headers: { "x-model-token": MODEL_TOKEN },
      compat: { supportsStore: false },
    });

    expect(readConfig("provider-prefs.json")).not.toContain(TENANT);
    expect(readConfig("provider-prefs.json")).not.toContain(MODEL_TOKEN);

    const response = await call("GET", "/settings/agent");
    const raw = await response.text();
    expect(raw).not.toContain(TENANT);
    expect(raw).not.toContain(MODEL_TOKEN);

    const body = JSON.parse(raw) as {
      providers: Array<{ id: string; headerNames: string[] }>;
      models: Array<Record<string, unknown> & { headerNames: string[] }>;
    };
    expect(body.providers.find((entry) => entry.id === providerId)!.headerNames).toEqual([
      "x-tenant",
    ]);
    const model = body.models[0]!;
    expect(model.name).toBe("Lab Model");
    expect(model.thinkingLevel).toBe("medium");
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBe(128000);
    expect(model.maxTokens).toBe(4096);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.cost).toEqual({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 });
    expect(model.compat).toEqual({ supportsStore: false });
    expect(model.headerNames).toEqual(["x-model-token"]);
  });

  test("rotates and clears the key in auth.json and models.json", async () => {
    const providerId = await createProvider();
    await createModel(providerId);

    const rotated = await call("PUT", `/settings/agent/providers/${providerId}`, {
      apiKey: ROTATED_KEY,
    });
    expect(rotated.status).toBe(200);
    expect(JSON.stringify(await rotated.json())).not.toContain(ROTATED_KEY);

    const modelsJson = JSON.parse(readConfig("models.json")) as {
      providers: Record<string, { apiKey?: string }>;
    };
    expect(modelsJson.providers[`provider:${providerId}`]!.apiKey).toBe(ROTATED_KEY);
    expect(readConfig("auth.json")).toContain(ROTATED_KEY);

    const cleared = await call("PUT", `/settings/agent/providers/${providerId}`, {
      apiKey: null,
    });
    expect(cleared.status).toBe(200);
    const after = (await cleared.json()) as { provider: { hasApiKey: boolean; apiKeySummary: string | null } };
    expect(after.provider.hasApiKey).toBe(false);
    expect(after.provider.apiKeySummary).toBeNull();
    expect(readConfig("auth.json")).not.toContain(ROTATED_KEY);
  });

  test("sets the default worker model from an existing pref", async () => {
    const providerId = await createProvider();
    const modelId = await createModel(providerId);

    const response = await call("PUT", "/settings/agent/default-model", {
      modelPrefId: modelId,
    });
    expect(response.status).toBe(200);

    const state = (await (await call("GET", "/settings/agent")).json()) as {
      defaultModelPrefId: string;
      models: Array<{
        id: string;
        providerId: string | null;
        modelId: string;
        isDefault: boolean;
        referencedBy: string[];
      }>;
    };
    expect(state.defaultModelPrefId).toBe("cairn-worker");
    const source = state.models.find((entry) => entry.id === modelId)!;
    const fallback = state.models.find((entry) => entry.id === "cairn-worker")!;
    expect(source.isDefault).toBe(false);
    expect(fallback.isDefault).toBe(true);
    expect(fallback.providerId).toBe(providerId);
    expect(fallback.modelId).toBe("lab-model");
    expect(fallback.referencedBy).toEqual(["prompt:cairn-worker"]);
  });

  test("guards deleting a provider that still owns models", async () => {
    const providerId = await createProvider();
    const modelId = await createModel(providerId);

    const blocked = await call("DELETE", `/settings/agent/providers/${providerId}`);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({
      detail: `provider is used by 1 model config(s): ${modelId}`,
    });

    const forced = await call("DELETE", `/settings/agent/providers/${providerId}?force=true`);
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ deleted: true, removedModels: [modelId] });

    const state = (await (await call("GET", "/settings/agent")).json()) as {
      providers: unknown[];
      models: unknown[];
    };
    expect(state.providers).toEqual([]);
    expect(state.models).toEqual([]);
  });

  test("guards deleting the prompt default model", async () => {
    const providerId = await createProvider();
    const modelId = await createModel(providerId);
    await call("PUT", "/settings/agent/default-model", { modelPrefId: modelId });

    const blocked = await call("DELETE", "/settings/agent/models/cairn-worker");
    expect(blocked.status).toBe(409);

    const forced = await call("DELETE", "/settings/agent/models/cairn-worker?force=true");
    expect(forced.status).toBe(200);
  });

  test("validates provider and model input", async () => {
    const badUrl = await call("POST", "/settings/agent/providers", {
      name: "lab",
      api: "openai-completions",
      baseUrl: "ftp://lab.invalid",
    });
    expect(badUrl.status).toBe(400);

    const missingUrl = await call("POST", "/settings/agent/providers", {
      name: "lab",
      api: "openai-completions",
    });
    expect(missingUrl.status).toBe(400);

    const missingApi = await call("POST", "/settings/agent/providers", {
      name: "lab",
      baseUrl: "https://lab.invalid/v1",
    });
    expect(missingApi.status).toBe(400);

    const unknownProtocol = await call("POST", "/settings/agent/providers", {
      name: "lab",
      api: "not-a-protocol",
      baseUrl: "https://lab.invalid/v1",
    });
    expect(unknownProtocol.status).toBe(400);

    const credentialsInUrl = await call("POST", "/settings/agent/providers", {
      name: "lab",
      api: "openai-completions",
      baseUrl: "https://user:pass@lab.invalid/v1",
    });
    expect(credentialsInUrl.status).toBe(400);

    const providerId = await createProvider();
    const unknownProvider = await call("POST", "/settings/agent/models", {
      providerId: "missing",
      modelId: "lab-model",
    });
    expect(unknownProvider.status).toBe(400);

    const badModelId = await call("POST", "/settings/agent/models", {
      providerId,
      modelId: "lab-model",
      id: "not a slug",
    });
    expect(badModelId.status).toBe(400);

    const badThinking = await call("POST", "/settings/agent/models", {
      providerId,
      modelId: "lab-model",
      thinkingLevel: "extreme",
    });
    expect(badThinking.status).toBe(400);
  });

  test("requires the operator token on mutations when configured", async () => {
    api = createApi({ db, agentConfigDir: configDir, operatorToken: "operator-secret" });

    const denied = await call("POST", "/settings/agent/providers", {
      name: "lab",
      api: "openai-completions",
      baseUrl: "https://lab.invalid/v1",
    });
    expect(denied.status).toBe(401);

    const allowed = await call(
      "POST",
      "/settings/agent/providers",
      { name: "lab", api: "openai-completions", baseUrl: "https://lab.invalid/v1" },
      { "x-cairn-operator-token": "operator-secret" },
    );
    expect(allowed.status).toBe(200);

    const read = await call("GET", "/settings/agent");
    expect(read.status).toBe(200);
  });

  test("rejects cross-origin browser writes", async () => {
    const denied = await call(
      "POST",
      "/settings/agent/providers",
      { name: "lab", api: "openai-completions", baseUrl: "https://lab.invalid/v1" },
      { origin: "http://evil.test" },
    );
    expect(denied.status).toBe(403);

    const allowed = await call(
      "POST",
      "/settings/agent/providers",
      { name: "lab", api: "openai-completions", baseUrl: "https://lab.invalid/v1" },
      { origin: "http://cairn.test" },
    );
    expect(allowed.status).toBe(200);
  });
});

describe("agent config route sanitization", () => {
  test("asks for an API key before testing a provider-backed model", async () => {
    const response = await call("POST", "/settings/agent/providers", {
      name: "lab-gateway",
      api: "openai-completions",
      baseUrl: "https://lab.invalid/v1",
    });
    expect(response.status).toBe(200);
    const { id: providerId } = (await response.json()) as { id: string };
    const modelId = await createModel(providerId);

    const result = await call("POST", `/settings/agent/models/${modelId}/test`);
    expect(result.status).toBe(200);
    const body = (await result.json()) as {
      ok: boolean;
      error: string;
      summary: { modelPrefId: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("API key");
    expect(body.error).not.toContain("models.json");
    expect(body.summary.modelPrefId).toBe(modelId);
  });

  test("strips credentials from model test output", async () => {
    const secret = "sk-fake-secret-1234567890";
    const fake = {
      listModelPrefs: async () => [
        { id: "cairn-worker", provider: "lab", modelId: "lab-model" },
      ],
      getApiKeyValue: (name: string) => (name === "provider:lab" ? secret : undefined),
      testModel: async () => ({
        ok: false,
        error: `HTTP 401 for key ${secret}`,
        details: {
          modelPrefId: "cairn-worker",
          provider: "lab",
          providerLabel: "lab",
          runtimeProvider: "provider:lab",
          modelId: "lab-model",
          api: "openai-completions",
          baseUrl: "https://lab.invalid/v1",
          apiKeySummary: "sk-fake-...7890",
          headers: { authorization: `Bearer ${secret}` },
        },
      }),
      discoverModels: async () => [{ id: "m1", name: "M1" }],
      listProviderPrefs: async () => [
        { id: "lab", name: "lab", api: "openai-completions", baseUrl: "https://lab.invalid/v1" },
      ],
      listBuiltInProviders: () => [],
    };
    api = createApi({
      db,
      agentConfigDir: configDir,
      agentConfigFactory: async () => fake as unknown as ConfigManager,
    });

    const response = await call("POST", "/settings/agent/models/cairn-worker/test");
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("authorization");
    expect(raw).not.toContain("Bearer");

    const body = JSON.parse(raw) as {
      ok: boolean;
      error: string;
      summary: { apiKeySummary: string; baseUrl: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("<redacted>");
    expect(body.summary.apiKeySummary).toBe("sk-fake-...7890");
    expect(body.summary.baseUrl).toBe("https://lab.invalid/v1");

    const discovery = await call("POST", "/settings/agent/providers/lab/discover");
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ models: [{ id: "m1", name: "M1" }] });
  });
});
