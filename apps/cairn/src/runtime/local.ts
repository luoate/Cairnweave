/**
 * Local runtime: the M2c behavior, now behind the M3 runtime interface.
 *
 * This mode is for controlled development and labs on a trusted host. It is not an
 * isolation boundary; production runs use the container backend.
 */

import { mkdirSync, rmSync } from "node:fs";

import type { LocalConfig } from "../config";
import {
  describeError,
  type RuntimeBackend,
  type WorkerProcess,
  type WorkerSpawnOptions,
} from "./types";

export interface LocalRuntimeOptions {
  local: LocalConfig | null;
  workerArgv: (workerTaskPath: string) => string[];
  log: (message: string) => void;
}

export class LocalRuntime implements RuntimeBackend {
  readonly execution = "local" as const;
  private readonly workerArgv: (workerTaskPath: string) => string[];
  private readonly log: (message: string) => void;
  private readonly completedAction: "keep" | "remove";
  private readonly workspaces = new Map<string, string>();

  constructor(options: LocalRuntimeOptions) {
    this.workerArgv = options.workerArgv;
    this.log = options.log;
    this.completedAction = options.local?.completedAction ?? "keep";
  }

  ensureProject(projectId: string, hostWorkspace: string): boolean {
    try {
      mkdirSync(hostWorkspace, { recursive: true });
      this.workspaces.set(projectId, hostWorkspace);
      return true;
    } catch (error) {
      this.log(`local workspace create failed project=${projectId}: ${describeError(error)}`);
      return false;
    }
  }

  mapPath(hostPath: string): string {
    return hostPath;
  }

  mapPathIfUnderWorkspace(hostPath: string): string | null {
    return hostPath;
  }

  spawnWorker(options: WorkerSpawnOptions): WorkerProcess {
    const env: Record<string, string> = {
      ...options.controllerEnv,
      ...options.baseEnv,
      ...options.extraEnv,
    };
    const child = Bun.spawn(this.workerArgv(options.workerTaskPath), {
      cwd: options.workerWorkspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exited: child.exited,
      stdout: child.stdout as ReadableStream<Uint8Array>,
      stderr: child.stderr as ReadableStream<Uint8Array>,
      terminate: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
      },
      kill: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      },
    };
  }

  cleanupInactive(activeProjectIds: ReadonlySet<string>): void {
    if (this.completedAction !== "remove") {
      for (const projectId of [...this.workspaces.keys()]) {
        if (!activeProjectIds.has(projectId)) this.workspaces.delete(projectId);
      }
      return;
    }
    for (const [projectId, workspace] of [...this.workspaces]) {
      if (activeProjectIds.has(projectId)) continue;
      this.workspaces.delete(projectId);
      try {
        rmSync(workspace, { recursive: true, force: true });
        this.log(`removed local workspace project=${projectId} path=${workspace}`);
      } catch (error) {
        this.log(
          `local workspace cleanup failed project=${projectId}: ${describeError(error)}`,
        );
      }
    }
  }

  close(): void {
    // Local workers are supervised processes; nothing outlives the scheduler.
  }
}
