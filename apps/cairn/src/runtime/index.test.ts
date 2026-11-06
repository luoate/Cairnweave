import { expect, test } from "bun:test";
import { join } from "node:path";

import { loadDispatchConfig } from "../config";
import { resolveAgentConfigDir } from "./index";

test("container-specific config directory controls the read-only mount, never local.env", () => {
  const config = loadDispatchConfig(join(import.meta.dir, "../../../../dispatch.example.yaml"));
  config.commonEnv = { CAIRN_AGENT_CONFIG_DIR: "/shared/config" };
  config.local = { workspaceRoot: null, completedAction: "keep", env: { CAIRN_AGENT_CONFIG_DIR: "/local/config" } };
  config.container = {
    image: "worker:test", networkMode: "bridge", completedAction: "remove", capAdd: [],
    workspaceRoot: null, workerArgv: ["bun"], env: { CAIRN_AGENT_CONFIG_DIR: "/container/config" },
  };
  expect(resolveAgentConfigDir(config)).toBe("/container/config");
  delete config.container.env;
  expect(resolveAgentConfigDir(config)).toBe("/shared/config");
});
