import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureDatabase, type CairnDatabase } from "@cairn/graph";

import { createApi, type Api } from "./api";

const KEY = "sk-flow-abcdef123456";
const HEADER_VALUE = "tenant-token-flow";

let directory: string;
let configDir: string;
let db: CairnDatabase;
let api: Api;
let raws: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-agent-flow-"));
  configDir = join(directory, "agent");
  db = configureDatabase(join(directory, "cairn.db"));
  api = createApi({ db, agentConfigDir: configDir });
  raws = [];
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const response = await api.handle(
    new Request(`http://cairn.test${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const raw = await response.text();
  raws.push(raw);
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown> };
}

function readConfig(name: string): string {
  return readFileSync(join(configDir, name), "utf8");
}

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
  input: string[] | null;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  contextWindow: number | null;
  maxTokens: number | null;
  isDefault: boolean;
  referencedBy: string[];
}

interface Snapshot {
  defaultModelPrefId: string | null;
  providers: ProviderView[];
  models: ModelView[];
  protocols: string[];
  builtinProviders: Array<{ provider: string; modelCount: number }>;
}

describe("agent config end-to-end walkthrough", () => {
  test("drives an empty config dir to a default worker model and back", async () => {
    const empty = await call("GET", "/settings/agent");
    expect(empty.status).toBe(200);
    const initial = empty.body as unknown as Snapshot;
    expect(initial.providers).toEqual([]);
    expect(initial.models).toEqual([]);
    expect(initial.defaultModelPrefId).toBeNull();
    expect(initial.protocols).toContain("openai-completions");
    expect(initial.builtinProviders.map((entry) => entry.provider)).toContain("anthropic");

    const created = await call("POST", "/settings/agent/providers", {
      id: "lab-gateway",
      name: "lab-gateway",
      api: "openai-completions",
      baseUrl: "https://lab.invalid/v1",
      apiKey: KEY,
      headers: { "x-tenant": HEADER_VALUE },
    });
    expect(created.status).toBe(200);

    const model = await call("POST", "/settings/agent/models", {
      id: "lab-model",
      providerId: "lab-gateway",
      modelId: "lab-model-1",
      name: "Lab Model",
      thinkingLevel: "low",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 2048,
    });
    expect(model.status).toBe(200);

    const worker = await call("PUT", "/settings/agent/default-model", {
      modelPrefId: "lab-model",
    });
    expect(worker.status).toBe(200);

    const saved = (await call("GET", "/settings/agent")).body as unknown as Snapshot;
    expect(saved.defaultModelPrefId).toBe("cairn-worker");

    const provider = saved.providers.find((entry) => entry.id === "lab-gateway")!;
    expect(provider).toEqual({
      id: "lab-gateway",
      name: "lab-gateway",
      api: "openai-completions",
      baseUrl: "https://lab.invalid/v1",
      hasApiKey: true,
      apiKeySummary: "sk-flow-...123456",
      headerNames: ["x-tenant"],
    });

    const source = saved.models.find((entry) => entry.id === "lab-model")!;
    const fallback = saved.models.find((entry) => entry.id === "cairn-worker")!;
    expect(source.isDefault).toBe(false);
    expect(source.referencedBy).toEqual([]);
    expect(fallback).toMatchObject({
      provider: "lab-gateway",
      providerId: "lab-gateway",
      modelId: "lab-model-1",
      name: "Lab Model",
      thinkingLevel: "low",
      reasoning: false,
      input: ["text"],
      cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0 },
      contextWindow: 65536,
      maxTokens: 2048,
      isDefault: true,
      referencedBy: ["prompt:cairn-worker"],
    });

    expect(readConfig("provider-prefs.json")).not.toContain(KEY);
    expect(readConfig("provider-prefs.json")).not.toContain(HEADER_VALUE);
    expect(readConfig("auth.json")).toContain(KEY);
    const prefs = JSON.parse(readConfig("model-prefs.json")) as {
      models: Array<{ id: string; provider: string; providerId?: string; modelId: string }>;
    };
    expect(prefs.models.find((entry) => entry.id === "cairn-worker")).toMatchObject({
      provider: "lab-gateway",
      providerId: "lab-gateway",
      modelId: "lab-model-1",
    });
    const modelsJson = JSON.parse(readConfig("models.json")) as {
      providers: Record<
        string,
        { api?: string; baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> }
      >;
    };
    const runtime = modelsJson.providers["provider:lab-gateway"]!;
    expect(runtime.api).toBe("openai-completions");
    expect(runtime.baseUrl).toBe("https://lab.invalid/v1");
    expect(runtime.apiKey).toBe(KEY);
    expect(runtime.models?.map((entry) => entry.id)).toContain("lab-model-1");

    const blocked = await call("DELETE", "/settings/agent/providers/lab-gateway");
    expect(blocked.status).toBe(409);
    expect(String(blocked.body["detail"])).toContain("2 model config(s)");

    const forced = await call("DELETE", "/settings/agent/providers/lab-gateway?force=true");
    expect(forced.status).toBe(200);
    expect(new Set(forced.body["removedModels"] as string[])).toEqual(
      new Set(["lab-model", "cairn-worker"]),
    );

    const cleared = (await call("GET", "/settings/agent")).body as unknown as Snapshot;
    expect(cleared.providers).toEqual([]);
    expect(cleared.models).toEqual([]);
    expect(cleared.defaultModelPrefId).toBeNull();

    for (const raw of raws) {
      expect(raw).not.toContain(KEY);
      expect(raw).not.toContain(HEADER_VALUE);
    }
  });
});
