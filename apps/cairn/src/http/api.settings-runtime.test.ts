import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configureDatabase,
  getRuntimeConfigOverrides,
  type CairnDatabase,
} from "@cairn/graph";

import { parseDispatchConfig, type DispatchConfig } from "../config";
import { RuntimeConfigStore } from "../config-overrides";
import { createApi, type Api } from "./api";
import type { ExecutionProbe } from "./settings-runtime";

const SOURCE = `server: "http://127.0.0.1:8000"
runtime:
  execution: local
  interval: 3
  max_workers: 4
  max_running_projects: 2
  max_project_workers: 1
  healthcheck_timeout: 15
  prompt_group: default
tasks:
  bootstrap: {timeout: 300, conclude_timeout: 90}
  reason: {timeout: 300, max_intents: 3}
  explore: {timeout: 600, conclude_timeout: 120}
budget:
  max_project_tokens: 1000
`;

let directory: string;
let db: CairnDatabase;
let config: DispatchConfig;
let store: RuntimeConfigStore;

function document(): Record<string, unknown> {
  return Bun.YAML.parse(SOURCE) as Record<string, unknown>;
}

function makeApi(
  options: {
    store?: RuntimeConfigStore | null;
    operatorToken?: string;
    probe?: ExecutionProbe;
  } = {},
): Api {
  return createApi({
    db,
    ...(options.operatorToken === undefined ? {} : { operatorToken: options.operatorToken }),
    ...(options.store === null ? {} : { runtimeConfig: options.store ?? store }),
    ...(options.probe === undefined ? {} : { runtimeProbe: options.probe }),
  });
}

function call(
  api: Api,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return api.handle(
    new Request(`http://cairn.test${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "cairn-settings-runtime-"));
  db = configureDatabase(join(directory, "cairn.db"));
  config = parseDispatchConfig(document());
  store = new RuntimeConfigStore({ db, config, source: document() });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("GET /settings/runtime", () => {
  test("returns the effective configuration and the file baseline", async () => {
    const response = await call(makeApi(), "GET", "/settings/runtime");

    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      defaults: { budget: { max_project_tokens: number } };
      editable: {
        runtime: { max_workers: number; execution: string };
        verification: { flag_review: string };
      };
      overrides: string[];
      updated_at: string | null;
      read_only: { runtime: Record<string, unknown>; observer: { enabled: boolean } };
    };
    expect(view.defaults.budget.max_project_tokens).toBe(1000);
    expect(view.editable.verification.flag_review).toBe("manual");
    expect(view.editable.runtime.max_workers).toBe(4);
    expect(view.editable.runtime.execution).toBe("local");
    expect(view.overrides).toEqual([]);
    expect(view.updated_at).toBeNull();
    expect(view.read_only.runtime).not.toHaveProperty("execution");
    expect(view.read_only.observer.enabled).toBe(true);
  });

  test("answers 409 when no dispatch config was loaded", async () => {
    const response = await call(makeApi({ store: null }), "GET", "/settings/runtime");

    expect(response.status).toBe(409);
    expect(((await response.json()) as { detail: string }).detail).toContain("--config");
  });
});

describe("PUT /settings/runtime", () => {
  test("applies, persists and returns the new view", async () => {
    const response = await call(makeApi(), "PUT", "/settings/runtime", {
      runtime: { max_workers: 8 },
      budget: { max_project_tokens: 50 },
      tasks: { graph_slice: { enabled: true, max_facts: 40 } },
    });

    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      editable: { runtime: { max_workers: number }; budget: { max_project_tokens: number } };
      overrides: string[];
      updated_at: string | null;
    };
    expect(view.editable.runtime.max_workers).toBe(8);
    expect(view.editable.budget.max_project_tokens).toBe(50);
    expect(view.overrides).toEqual([
      "budget.max_project_tokens",
      "runtime.max_workers",
      "tasks.graph_slice.enabled",
      "tasks.graph_slice.max_facts",
    ]);
    expect(view.updated_at).not.toBeNull();

    expect(config.runtime.maxWorkers).toBe(8);
    expect(config.tasks.graphSlice).toEqual({ enabled: true, maxFacts: 40, maxIntents: 60 });
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({
      runtime: { max_workers: 8 },
      budget: { max_project_tokens: 50 },
      tasks: { graph_slice: { enabled: true, max_facts: 40 } },
    });
  });

  test("toggles flag review through the runtime patch", async () => {
    const response = await call(makeApi(), "PUT", "/settings/runtime", {
      verification: { flag_review: "off" },
    });

    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      editable: { verification: { flag_review: string } };
      overrides: string[];
    };
    expect(view.editable.verification.flag_review).toBe("off");
    expect(view.overrides).toEqual(["verification.flag_review"]);
    expect(config.verification.flagReview).toBe("off");
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({ verification: { flag_review: "off" } });
  });

  test("switches execution to container and persists the override", async () => {
    const response = await call(makeApi(), "PUT", "/settings/runtime", {
      runtime: { execution: "container" },
    });

    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      editable: { runtime: { execution: string } };
      overrides: string[];
    };
    expect(view.editable.runtime.execution).toBe("container");
    expect(view.overrides).toEqual(["runtime.execution"]);
    expect(config.runtime.execution).toBe("container");
    expect(config.container).toMatchObject({ image: "cairn-worker:latest" });
    expect(
      JSON.parse(db.withConn((conn) => getRuntimeConfigOverrides(conn)).overrides),
    ).toEqual({ runtime: { execution: "container" } });
  });

  test("maps a validateNext rejection to 400 and keeps the running mode", async () => {
    const guarded = new RuntimeConfigStore({
      db,
      config,
      source: document(),
      validateNext: () => "wait for running tasks to finish before switching the execution mode",
    });

    const response = await call(makeApi({ store: guarded }), "PUT", "/settings/runtime", {
      runtime: { execution: "container" },
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toBe(
      "wait for running tasks to finish before switching the execution mode",
    );
    expect(config.runtime.execution).toBe("local");
    expect(guarded.view().overrides).toEqual([]);
  });

  test("rejects unsupported and invalid values with 400", async () => {
    const api = makeApi();

    const unsupported = await call(api, "PUT", "/settings/runtime", {
      observer: { enabled: false },
    });
    expect(unsupported.status).toBe(400);
    expect(((await unsupported.json()) as { detail: string }).detail).toBe(
      "overrides has unsupported section: observer",
    );

    const invalid = await call(api, "PUT", "/settings/runtime", {
      worker_selection: { epsilon: 0.1, epsilon_min: 0.9 },
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { detail: string }).detail).toBe(
      "worker_selection.epsilon_min must not exceed worker_selection.epsilon",
    );

    const malformed = await call(api, "PUT", "/settings/runtime", "{");
    expect(malformed.status).toBe(400);

    expect(config.runtime.maxWorkers).toBe(4);
    expect(store.view().overrides).toEqual([]);
  });

  test("accepts an empty object as a full reset", async () => {
    const api = makeApi();
    await call(api, "PUT", "/settings/runtime", { budget: { max_project_tokens: 10 } });

    const response = await call(api, "PUT", "/settings/runtime", {});
    expect(response.status).toBe(200);
    expect(config.budget.maxProjectTokens).toBe(1000);
    expect(((await response.json()) as { overrides: string[] }).overrides).toEqual([]);
  });

  test("bounds the request body", async () => {
    const response = await call(
      makeApi(),
      "PUT",
      "/settings/runtime",
      JSON.stringify({ budget: { max_project_tokens: 1 } }).padEnd(65 * 1024, " "),
    );

    expect(response.status).toBe(413);
  });

  test("requires the operator token and a same-origin request", async () => {
    const api = makeApi({ operatorToken: "secret-token" });
    const body = { budget: { max_project_tokens: 3 } };

    const anonymous = await call(api, "PUT", "/settings/runtime", body);
    expect(anonymous.status).toBe(401);

    const crossOrigin = await call(api, "PUT", "/settings/runtime", body, {
      "x-cairn-operator-token": "secret-token",
      origin: "http://evil.test",
    });
    expect(crossOrigin.status).toBe(403);

    const allowed = await call(api, "PUT", "/settings/runtime", body, {
      "x-cairn-operator-token": "secret-token",
      origin: "http://cairn.test",
    });
    expect(allowed.status).toBe(200);

    const deleteDenied = await call(api, "DELETE", "/settings/runtime");
    expect(deleteDenied.status).toBe(401);
  });
});

describe("POST /settings/runtime/test", () => {
  test("probes the mode the caller selected and returns every check", async () => {
    const calls: string[] = [];
    const api = makeApi({
      probe: (execution) => {
        calls.push(execution);
        return {
          execution,
          ok: execution === "local",
          checks: [{ id: "runtime", label: "Bun 运行时", ok: true, detail: "Bun 1.4.4" }],
        };
      },
    });

    const response = await call(api, "POST", "/settings/runtime/test", {
      execution: "container",
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["container"]);
    const result = (await response.json()) as {
      execution: string;
      ok: boolean;
      checks: { id: string; label: string; ok: boolean; detail: string }[];
    };
    expect(result.execution).toBe("container");
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      { id: "runtime", label: "Bun 运行时", ok: true, detail: "Bun 1.4.4" },
    ]);
  });

  test("rejects missing, unknown and malformed bodies with 400", async () => {
    const api = makeApi();

    expect((await call(api, "POST", "/settings/runtime/test", {})).status).toBe(400);
    expect(
      (await call(api, "POST", "/settings/runtime/test", { execution: "vm" })).status,
    ).toBe(400);
    expect((await call(api, "POST", "/settings/runtime/test", "{")).status).toBe(400);
  });

  test("answers 409 when no dispatch config was loaded", async () => {
    const response = await call(
      makeApi({ store: null }),
      "POST",
      "/settings/runtime/test",
      { execution: "local" },
    );

    expect(response.status).toBe(409);
  });

  test("requires the operator token and a same-origin request", async () => {
    const calls: string[] = [];
    const api = makeApi({
      operatorToken: "secret-token",
      probe: (execution) => {
        calls.push(execution);
        return { execution, ok: true, checks: [] };
      },
    });
    const body = { execution: "local" };

    const anonymous = await call(api, "POST", "/settings/runtime/test", body);
    expect(anonymous.status).toBe(401);

    const crossOrigin = await call(api, "POST", "/settings/runtime/test", body, {
      "x-cairn-operator-token": "secret-token",
      origin: "http://evil.test",
    });
    expect(crossOrigin.status).toBe(403);

    const allowed = await call(api, "POST", "/settings/runtime/test", body, {
      "x-cairn-operator-token": "secret-token",
      origin: "http://cairn.test",
    });
    expect(allowed.status).toBe(200);
    expect(calls).toEqual(["local"]);
  });
});

describe("DELETE /settings/runtime", () => {
  test("restores dispatch.yaml values", async () => {
    const api = makeApi();
    await call(api, "PUT", "/settings/runtime", {
      runtime: { interval: 9 },
      retention: { sweep_interval_seconds: 60 },
    });

    const response = await call(api, "DELETE", "/settings/runtime");
    expect(response.status).toBe(200);
    expect(config.runtime.interval).toBe(3);
    expect(config.retention.sweepIntervalSeconds).toBe(3600);
    expect(((await response.json()) as { overrides: string[] }).overrides).toEqual([]);
  });
});
