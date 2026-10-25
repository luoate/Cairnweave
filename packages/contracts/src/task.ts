/**
 * Internal control-plane -> worker task contract.
 *
 * This replaces the Phase 0 worker-driver layer: the control plane writes one task file
 * into the project workspace and spawns `cairn worker --task <file>` inside the project
 * sandbox. The worker never talks to SQLite. Paths in the task are expressed in the
 * worker's view of the filesystem (host paths in local mode, container paths in Docker).
 */

export const TASK_PROTOCOL_VERSION = 1 as const;

export type TaskKind = "bootstrap" | "reason" | "explore" | "conclude";

const TASK_KINDS: readonly TaskKind[] = ["bootstrap", "reason", "explore", "conclude"];

export interface ScopePolicy {
  /**
   * Authorized targets: host, host:port, URL or CIDR. The worker enforces this against
   * every outbound action; an empty list is a configuration error, never "allow all".
   */
  readonly targets: readonly string[];
  readonly notes?: string;
}

export interface WorkerTask {
  readonly protocol: typeof TASK_PROTOCOL_VERSION;
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly projectId: string;
  /** Required for explore/conclude; the intent this task advances. */
  readonly intentId?: string;
  /** Fully rendered Cairn prompt (full graph is referenced by path, not inlined). */
  readonly prompt: string;
  readonly graphSnapshotPath: string;
  readonly workspace: string;
  readonly sessionDir: string;
  /**
   * Conclude only: worker-view directory of the task session to resume. The scheduler
   * sets it to the failed explore/bootstrap session so the solver can append a wrap-up
   * turn instead of starting cold. Never set on execute tasks.
   */
  readonly resumeSessionDir?: string;
  /** Conclude only: whether the failed phase was bootstrap or an explore intent. */
  readonly concludeOf?: "bootstrap" | "explore";
  /** The worker writes exactly one TaskResult here (atomic write). */
  readonly resultPath: string;
  /**
   * Task-scoped artifact namespace relative to the workspace (`artifacts/<task-id>`).
   * Present when same-project concurrency is enabled; the Host Bridge then rejects writes
   * to another task's artifacts. Evidence refs stay relative to the workspace.
   */
  readonly artifactDir?: string;
  readonly scope: ScopePolicy;
  /** Ask the solver to wrap up and emit its result before the hard kill. */
  readonly softDeadlineSeconds?: number;
  readonly hardDeadlineSeconds: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Returns every problem with the task; an empty array means it is valid.
 * Kept as a list (rather than throwing) so the worker can report all issues at once.
 */
export function taskErrors(value: unknown): string[] {
  if (!isRecord(value)) return ["task must be a JSON object"];

  const errors: string[] = [];

  if (value["protocol"] !== TASK_PROTOCOL_VERSION) {
    errors.push(`protocol must be ${TASK_PROTOCOL_VERSION}`);
  }
  for (const key of [
    "taskId",
    "projectId",
    "prompt",
    "graphSnapshotPath",
    "workspace",
    "sessionDir",
    "resultPath",
  ] as const) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }

  const kind = value["kind"];
  const resumeSessionDir = value["resumeSessionDir"];
  if (!TASK_KINDS.includes(kind as TaskKind)) {
    errors.push(`kind must be one of ${TASK_KINDS.join(", ")}`);
  } else if ((kind === "explore" || kind === "conclude") && !isNonEmptyString(value["intentId"])) {
    errors.push(`${kind} tasks require intentId`);
  }
  if (resumeSessionDir !== undefined) {
    if (!isNonEmptyString(resumeSessionDir)) {
      errors.push("resumeSessionDir must be a non-empty string when present");
    }
    if (kind !== "conclude") {
      errors.push("resumeSessionDir is only valid on conclude tasks");
    }
  } else if (kind === "conclude") {
    errors.push("conclude tasks require resumeSessionDir");
  }

  const concludeOf = value["concludeOf"];
  if (concludeOf !== undefined) {
    if (concludeOf !== "bootstrap" && concludeOf !== "explore") {
      errors.push("concludeOf must be bootstrap or explore");
    }
    if (kind !== "conclude") {
      errors.push("concludeOf is only valid on conclude tasks");
    }
  } else if (kind === "conclude") {
    errors.push("conclude tasks require concludeOf");
  }

  const artifactDir = value["artifactDir"];
  if (artifactDir !== undefined) {
    if (!isNonEmptyString(artifactDir)) {
      errors.push("artifactDir must be a non-empty string when present");
    } else {
      const segments = artifactDir.split("/");
      if (
        artifactDir.includes("\\") ||
        artifactDir.startsWith("/") ||
        /^[A-Za-z]:/.test(artifactDir) ||
        segments.some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ) ||
        segments[0] !== "artifacts" ||
        segments.length < 2
      ) {
        errors.push('artifactDir must be a relative path under "artifacts/"');
      }
    }
  }

  const scope = value["scope"];
  if (!isRecord(scope)) {
    errors.push("scope must be an object");
  } else {
    const targets = scope["targets"];
    if (!Array.isArray(targets) || targets.length === 0) {
      errors.push("scope.targets must be a non-empty array");
    } else {
      targets.forEach((target, index) => {
        if (!isNonEmptyString(target)) {
          errors.push(`scope.targets[${index}] must be a non-empty string`);
        }
      });
    }
    if (scope["notes"] !== undefined && typeof scope["notes"] !== "string") {
      errors.push("scope.notes must be a string when present");
    }
  }

  const hard = value["hardDeadlineSeconds"];
  if (!isPositiveInteger(hard)) {
    errors.push("hardDeadlineSeconds must be a positive integer");
  }

  const soft = value["softDeadlineSeconds"];
  if (soft !== undefined) {
    if (!isPositiveNumber(soft)) {
      errors.push("softDeadlineSeconds must be a positive number when present");
    } else if (isPositiveInteger(hard) && soft >= hard) {
      errors.push("softDeadlineSeconds must be smaller than hardDeadlineSeconds");
    }
  }

  return errors;
}

export function isWorkerTask(value: unknown): value is WorkerTask {
  return taskErrors(value).length === 0;
}
