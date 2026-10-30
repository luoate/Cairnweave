import { basename } from "node:path";

import type { ConfigManager, PromptFileView, SkillEntry } from "@cairn/agent";
import { HttpError } from "@cairn/graph";

import { loadAgentConfigManager, type AgentConfigOptions } from "./agent-config";
import type { RouteContext } from "./api";
import { isCrossOrigin, requireOperator } from "./auth";

/** The prompt whose `skills` allowlist decides which skills the worker can load. */
const WORKER_PROMPT = "cairn-worker";
const MAX_BODY_BYTES = 512 * 1024;
const MAX_DESCRIPTION = 1024;
const MAX_CONTENT = 96 * 1024;
const MAX_SKILL_NAME = 64;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type RouteRegistrar = (
  method: string,
  template: string,
  handler: (context: RouteContext) => Promise<Response> | Response,
) => void;

interface SkillRowView {
  name: string;
  directory: string;
  description: string;
  builtin: boolean;
  deleted: boolean;
  enabled: boolean;
}

export function registerAgentSkillsRoutes(
  register: RouteRegistrar,
  options: AgentConfigOptions = {},
): void {
  let managerPromise: Promise<ConfigManager> | undefined;

  function manager(): Promise<ConfigManager> {
    managerPromise ??= loadAgentConfigManager(options).catch((error: unknown) => {
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

  guarded("GET", "/settings/agent/skills", async () => {
    const store = await manager();
    const prompt = await ensureAgentConfig(store);
    const enabled = new Set(prompt?.meta.skills ?? []);

    const rows = store.listSkills().map((skill) => skillRow(store, skill, enabled));
    const present = new Set(rows.map((row) => row.directory));
    for (const directory of store.listDeletedBuiltinSkills()) {
      if (present.has(directory)) continue;
      rows.push({
        name: directory,
        directory,
        description: "",
        builtin: true,
        deleted: true,
        enabled: false,
      });
    }
    rows.sort((left, right) => {
      if (left.deleted !== right.deleted) return left.deleted ? 1 : -1;
      return left.name.localeCompare(right.name);
    });

    return json({
      prompt: WORKER_PROMPT,
      promptFound: prompt !== undefined,
      enabledCount: rows.filter((row) => row.enabled).length,
      skills: rows,
    });
  });

  guarded("POST", "/settings/agent/skills", async ({ request }) => {
    const store = await manager();
    const body = await readBody(request);
    const name = readSkillName(body);
    const description = readDescription(body);
    const content = readContent(body);
    const enabled = readEnabled(body) ?? true;

    if (
      store.listSkills().some((skill) => basename(skill.baseDir) === name) ||
      store.listDeletedBuiltinSkills().includes(name)
    ) {
      throw new HttpError(409, `skill "${name}" already exists`);
    }

    try {
      await store.createSkill({ name, description, content });
    } catch (error) {
      throw new HttpError(409, describe(error));
    }

    let prompt = enabled ? await ensurePrompt(store) : await store.getPrompt(WORKER_PROMPT);
    if (enabled) {
      await applySkillEnabled(store, prompt, name, true);
      prompt = await store.getPrompt(WORKER_PROMPT);
    }

    const created = store.listSkills().find((skill) => basename(skill.baseDir) === name);
    if (!created) throw new HttpError(500, "skill was not persisted");
    return json({ skill: skillRow(store, created, new Set(prompt?.meta.skills ?? [])) });
  });

  guarded("DELETE", "/settings/agent/skills/{name}", async ({ params }) => {
    const store = await manager();
    const directory = readDirectory(params.name);
    const skill = store.listSkills().find((item) => basename(item.baseDir) === directory);
    const recorded = store.listDeletedBuiltinSkills().includes(directory);
    if (!skill && !recorded) throw new HttpError(404, "skill not found");

    if (skill) {
      const prompt = await store.getPrompt(WORKER_PROMPT);
      if (prompt) await applySkillEnabled(store, prompt, skill.name, false);
    }
    await store.removeSkill(directory);
    return json({ deleted: true, builtin: store.isBuiltinSkill(directory) });
  });

  guarded("POST", "/settings/agent/skills/{name}/restore", async ({ params }) => {
    const store = await manager();
    const directory = readDirectory(params.name);
    if (!store.isBuiltinSkill(directory)) throw new HttpError(404, "builtin skill not found");

    const present = store.listSkills().some((skill) => basename(skill.baseDir) === directory);
    const recorded = store.listDeletedBuiltinSkills().includes(directory);
    if (present && !recorded) throw new HttpError(409, `skill "${directory}" is not deleted`);

    await store.restoreBuiltinSkill(directory);
    const prompt = await ensurePrompt(store);
    const restored = store.listSkills().find((skill) => basename(skill.baseDir) === directory);
    if (!restored) throw new HttpError(500, "skill was not restored");
    return json({ skill: skillRow(store, restored, new Set(prompt?.meta.skills ?? [])) });
  });

  guarded("PUT", "/settings/agent/skills/{name}/enabled", async ({ params, request }) => {
    const store = await manager();
    const directory = readDirectory(params.name);
    const skill = store.listSkills().find((item) => basename(item.baseDir) === directory);
    if (!skill) throw new HttpError(404, "skill not found");

    const body = await readBody(request);
    const enabled = readEnabled(body);
    if (enabled === undefined) throw new HttpError(400, "enabled must be a boolean");

    const prompt = await ensurePrompt(store);
    await applySkillEnabled(store, prompt, skill.name, enabled);
    return json({ name: skill.name, directory, enabled });
  });
}

function skillRow(
  store: ConfigManager,
  skill: SkillEntry,
  enabled: ReadonlySet<string>,
): SkillRowView {
  const directory = basename(skill.baseDir);
  return {
    name: skill.name,
    directory,
    description: skill.description,
    builtin: store.isBuiltinSkill(directory),
    deleted: false,
    enabled: enabled.has(skill.name),
  };
}

/**
 * The settings panel works against a config dir that may never have run a task, so the
 * skills tab releases the builtin assets before listing (deleted builtins stay deleted).
 */
async function ensureAgentConfig(store: ConfigManager): Promise<PromptFileView | undefined> {
  const agent = await import("@cairn/agent");
  await agent.initBuiltinSkills(store.dir);
  return ensurePrompt(store);
}

async function ensurePrompt(store: ConfigManager): Promise<PromptFileView | undefined> {
  const prompt = await store.getPrompt(WORKER_PROMPT);
  if (prompt) return prompt;
  const agent = await import("@cairn/agent");
  await agent.initBuiltinPrompts(store.dir);
  return store.getPrompt(WORKER_PROMPT);
}

/** Keep the worker prompt allowlist in step with the enabled switch. */
async function applySkillEnabled(
  store: ConfigManager,
  prompt: PromptFileView | undefined,
  skillName: string,
  enabled: boolean,
): Promise<void> {
  if (!prompt) {
    throw new HttpError(
      409,
      `worker prompt "${WORKER_PROMPT}" is missing; run one task to seed it`,
    );
  }
  const current = prompt.meta.skills ?? [];
  const next = enabled
    ? [...current.filter((name) => name !== skillName), skillName]
    : current.filter((name) => name !== skillName);
  if (next.length === current.length && next.every((name, index) => name === current[index])) {
    return;
  }
  await store.setPrompt({ ...prompt, meta: { ...prompt.meta, skills: next } });
}

function readSkillName(record: Record<string, unknown>): string {
  const value = record["name"];
  if (typeof value !== "string") throw new HttpError(400, "name must be a string");
  const name = value.trim();
  if (name === "") throw new HttpError(400, "name is required");
  if (name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name)) {
    throw new HttpError(
      400,
      "name must be lowercase letters, digits and single hyphens (max 64)",
    );
  }
  return name;
}

function readDescription(record: Record<string, unknown>): string {
  const value = record["description"];
  if (typeof value !== "string") throw new HttpError(400, "description must be a string");
  const description = value.trim();
  if (description === "") throw new HttpError(400, "description is required");
  if (description.length > MAX_DESCRIPTION) throw new HttpError(400, "description is too long");
  if (/[\r\n]/.test(description)) {
    throw new HttpError(400, "description must be a single line");
  }
  return description;
}

function readContent(record: Record<string, unknown>): string {
  const value = record["content"];
  if (typeof value !== "string") throw new HttpError(400, "content must be a string");
  if (value.trim() === "") throw new HttpError(400, "content is required");
  if (value.length > MAX_CONTENT) throw new HttpError(400, "content is too long");
  if (value.includes("\u0000")) throw new HttpError(400, "content contains a NUL byte");
  return value;
}

function readEnabled(record: Record<string, unknown>): boolean | undefined {
  const value = record["enabled"];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "enabled must be a boolean");
  return value;
}

function readDirectory(value: string | undefined): string {
  if (value === undefined || !SAFE_DIRECTORY.test(value)) {
    throw new HttpError(400, "invalid skill name");
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
