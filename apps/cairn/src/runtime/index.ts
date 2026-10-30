import { join } from "node:path";

import { DEFAULT_AGENT_CONFIG_DIR } from "../agent-config-dir";
import type { DispatchConfig } from "../config";
import { DockerRuntime } from "./docker";
import { LocalRuntime } from "./local";
import type { RuntimeBackend } from "./types";

export type { RuntimeBackend, WorkerProcess, WorkerSpawnOptions } from "./types";
export { CONTAINER_AGENT_CONFIG, CONTAINER_WORKSPACE } from "./paths";
export { checkDocker, DockerRuntime } from "./docker";
export { LocalRuntime } from "./local";

export interface CreateRuntimeOptions {
  config: DispatchConfig;
  log: (message: string) => void;
  /** Test hook for local mode. */
  workerArgv?: (taskPath: string) => string[];
}

export function createRuntime(options: CreateRuntimeOptions): RuntimeBackend {
  const { config } = options;
  if (config.runtime.execution === "container") {
    if (config.container === null) {
      throw new Error("container config is required when runtime.execution is container");
    }
    return new DockerRuntime({
      container: config.container,
      agentConfigDir: resolveAgentConfigDir(config),
      log: options.log,
    });
  }
  return new LocalRuntime({
    local: config.local,
    log: options.log,
    workerArgv:
      options.workerArgv ??
      ((taskPath) => [
        process.execPath,
        join(import.meta.dir, "..", "cli.ts"),
        "worker",
        "--task",
        taskPath,
      ]),
  });
}

/**
 * The host config directory mounted read-only into worker containers. `common_env` wins
 * so a deployment can point at a service account directory.
 */
export function resolveAgentConfigDir(config: DispatchConfig): string {
  const fromConfig = config.commonEnv["CAIRN_AGENT_CONFIG_DIR"];
  if (fromConfig !== undefined && fromConfig.trim() !== "") return fromConfig;
  const fromEnv = process.env["CAIRN_AGENT_CONFIG_DIR"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  return DEFAULT_AGENT_CONFIG_DIR;
}
