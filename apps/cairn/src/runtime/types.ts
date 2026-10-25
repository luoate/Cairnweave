/**
 * Runtime backend seam between the scheduler and the project sandbox.
 *
 * M2c only had a local process runtime. M3 adds per-project Docker containers without
 * leaking Docker details into the scheduler: the scheduler prepares a task in host paths,
 * asks the backend for the worker's view of those paths, and spawns one worker through
 * the same small interface in both modes.
 */

import type { ExecutionMode } from "../config";

/** The subset of a child process the scheduler needs. */
export interface WorkerProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** SIGTERM-equivalent: stop the worker but leave room for it to exit. */
  terminate(): void;
  /** SIGKILL-equivalent after the grace period. */
  kill(): void;
}

export interface WorkerSpawnOptions {
  taskId: string;
  projectId: string;
  /** Task file path in the worker's view. */
  workerTaskPath: string;
  /** Project workspace in the worker's view. */
  workerWorkspace: string;
  /** Project workspace on the host (container mount source). */
  hostWorkspace: string;
  /** `common_env` from dispatch.yaml. */
  baseEnv: Record<string, string>;
  /** The control plane's own environment. Only local mode inherits it wholesale. */
  controllerEnv: Record<string, string>;
  /** Scheduler-computed variables (Observer and similar); merged last in both modes. */
  extraEnv?: Record<string, string>;
  hardDeadlineSeconds: number;
}

export interface RuntimeBackend {
  readonly execution: ExecutionMode;
  /**
   * Makes sure the sandbox exists before the scheduler writes task files. Returns false
   * when dispatch must be skipped (for example Docker is unavailable).
   */
  ensureProject(projectId: string, hostWorkspace: string): boolean;
  /** Maps a host path to the worker's view. Throws outside the project workspace. */
  mapPath(hostPath: string): string;
  /** Returns null instead of throwing when the path is outside the project workspace. */
  mapPathIfUnderWorkspace(hostPath: string): string | null;
  spawnWorker(options: WorkerSpawnOptions): WorkerProcess;
  /** Removes/stops sandboxes for projects that are no longer active. */
  cleanupInactive(activeProjectIds: ReadonlySet<string>): void;
  /** Releases resources when the control plane stops. */
  close(): void;
}

export function environmentSnapshot(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
