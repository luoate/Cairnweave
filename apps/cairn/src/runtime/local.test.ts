import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalRuntime } from "./local";
import { environmentSnapshot } from "./types";

// A real child reads only these fixture keys; it never starts the solver or makes requests.
async function readWorkerEnv(overrides?: Record<string, string>) {
  const workspace = mkdtempSync(join(tmpdir(), "cairn-local-env-"));
  const keys = ["HTTPS_PROXY", "ALL_PROXY", "COMMON_VALUE", "CONTROLLER_VALUE", "CAIRN_OBSERVER_ENABLED"];
  const runtime = new LocalRuntime({
    local: { workspaceRoot: workspace, completedAction: "keep", env: overrides },
    log: () => {},
    workerArgv: () => [process.execPath, "-e", `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(k => [k, process.env[k]]))))`],
  });
  try {
    const child = runtime.spawnWorker({
      taskId: "env-test", projectId: "proj-test", workerTaskPath: join(workspace, "task.json"),
      workerWorkspace: workspace, hostWorkspace: workspace, hardDeadlineSeconds: 10,
      controllerEnv: {
        ...environmentSnapshot(process.env), HTTPS_PROXY: "http://controller:1",
        ALL_PROXY: "http://inherited:1", CONTROLLER_VALUE: "local-only",
      },
      baseEnv: { HTTPS_PROXY: "http://host.docker.internal:18899", COMMON_VALUE: "shared" },
      extraEnv: { CAIRN_OBSERVER_ENABLED: "1" },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    runtime.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe("local worker environment", () => {
  test("local.env replaces a container proxy without losing common or controller values", async () => {
    expect(await readWorkerEnv({
      HTTPS_PROXY: "http://127.0.0.1:18899", ALL_PROXY: "", CAIRN_OBSERVER_ENABLED: "0",
    })).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:18899", ALL_PROXY: "", COMMON_VALUE: "shared",
      CONTROLLER_VALUE: "local-only", CAIRN_OBSERVER_ENABLED: "1",
    });
  });

  test("absent runtime overrides preserve existing common_env precedence", async () => {
    expect((await readWorkerEnv()).HTTPS_PROXY).toBe("http://host.docker.internal:18899");
  });
});
