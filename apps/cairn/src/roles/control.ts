import {
  configureDatabase,
  defaultDatabasePath,
  get,
  type CairnDatabase,
} from "@cairn/graph";
import { join } from "node:path";

import { ConfigError, loadDispatchConfig, type DispatchConfig } from "../config";
import { createApi } from "../http/api";
import { checkDocker, resolveAgentConfigDir } from "../runtime";
import { Scheduler } from "../scheduler/loop";
import { resolveWorkspaceRoot } from "../scheduler/tasks";

const USAGE = `usage: cairn serve [options]

options:
  --host <host>          bind host (default: 127.0.0.1)
  --port <port>          bind port (default: 8000)
  --db-path <file>       SQLite database path (default: ~/.local/share/cairn/cairn.db)
  --config <file>        enable the in-process scheduler with this dispatch config
  --static-dir <dir>     directory with the web UI (default: bundled static/)
  --log-level <level>    accepted for CLI compatibility (default: info)
  --access-log           accepted for CLI compatibility (default: true)
  --no-access-log        accepted for CLI compatibility
  -h, --help             show this help
`;

function flagValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === name) {
      return args[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

/**
 * Control-plane role: HTTP API + graph store. It is the only process that writes SQLite.
 *
 * M2 adds the scheduler and worker supervision behind the same process.
 */
export async function runControl(args: readonly string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const host = flagValue(args, "--host") ?? "127.0.0.1";
  const portText = flagValue(args, "--port") ?? "8000";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid --port: ${portText}`);
    return 2;
  }

  const dbPath = flagValue(args, "--db-path") ?? defaultDatabasePath();
  const staticDir =
    flagValue(args, "--static-dir") ?? join(import.meta.dir, "..", "http", "static");

  const configPath = flagValue(args, "--config");
  let config: DispatchConfig | null = null;
  if (configPath !== undefined) {
    try {
      config = loadDispatchConfig(configPath);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error);
      console.error(`[control] ${message}`);
      return 2;
    }
    if (config.runtime.execution === "container") {
      const docker = checkDocker();
      if (!docker.ok) {
        console.error(
          `[control] Docker is required for runtime.execution=container: ${docker.detail}`,
        );
        return 2;
      }
      try {
        // The worker mount is read-only, so builtin prompts and skills are seeded here,
        // once, on the host directory that becomes /cairn/agent-config.
        const agent = await import("@cairn/agent");
        const configDir = resolveAgentConfigDir(config);
        await agent.initBuiltinSkills(configDir);
        await agent.initBuiltinPrompts(configDir);
      } catch (error) {
        console.error(`[control] cannot prepare the agent config directory: ${String(error)}`);
        return 2;
      }
    }
  }

  let db: CairnDatabase;
  try {
    db = configureDatabase(dbPath);
  } catch (error) {
    console.error(`[control] cannot open database ${dbPath}: ${String(error)}`);
    return 1;
  }

  if (config !== null && !validateSettings(db, config)) {
    return 1;
  }

  const api = createApi({
    db,
    staticDir,
    ...(config === null ? {} : { workspaceRoot: resolveWorkspaceRoot(config) }),
  });
  const scheduler = config === null ? null : new Scheduler({ db, config });

  try {
    const server = Bun.serve({
      hostname: host,
      port,
      fetch: (request) => api.handle(request),
    });
    console.log(`cairn listening on http://${server.hostname}:${server.port}`);
    console.log(`database: ${dbPath}`);
    if (config !== null) {
      console.log(
        `scheduler: execution=${config.runtime.execution} interval=${config.runtime.interval}s max_workers=${config.runtime.maxWorkers}`,
      );
      scheduler!.start();
    }

    // Stay alive until the operator stops us; the CLI exits with the returned code.
    return await new Promise<number>((resolve) => {
      let stopping = false;
      const stop = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        server.stop(true);
        if (scheduler !== null) {
          await scheduler.stop();
        }
        resolve(0);
      };
      process.once("SIGINT", () => void stop());
      process.once("SIGTERM", () => void stop());
    });
  } catch (error) {
    if (scheduler !== null) {
      await scheduler.stop();
    }
    console.error(`[control] failed to start: ${String(error)}`);
    return 1;
  }
}

/**
 * Cairn refuses to start when a lease timeout is not greater than the dispatch interval:
 * the scheduler could not renew a lease before the server expired it.
 */
function validateSettings(db: CairnDatabase, config: DispatchConfig): boolean {
  const row = db.withConn((conn) =>
    get<{ intent_timeout: number; reason_timeout: number }>(
      conn,
      "SELECT intent_timeout, reason_timeout FROM settings WHERE rowid = 1",
    ),
  );
  if (row === null) {
    console.error("[control] settings row is missing");
    return false;
  }
  for (const [name, value] of [
    ["intent_timeout", row.intent_timeout],
    ["reason_timeout", row.reason_timeout],
  ] as const) {
    if (value <= config.runtime.interval) {
      console.error(
        `[control] server ${name}=${value}s must be greater than scheduler interval=${config.runtime.interval}s`,
      );
      return false;
    }
  }
  return true;
}
