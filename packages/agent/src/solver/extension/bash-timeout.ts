/**
 * M58b: give every bash command a deadline, from the `tool_call` extension hook.
 *
 * The first M58 attempt replaced the bash tool object in the prompt tool map. That cannot
 * work: `createAgentSession` only reads tool *names* from its options and rebuilds the tools
 * from the SDK's own `allTools`, so the wrapper was silently discarded. proj_051 then ran
 * a 20000-request scan for 397 s untouched and was killed at the hard deadline, with zero
 * "Command timed out" results in the whole project.
 *
 * The supported hook is `tool_call`: its `input` is the same arguments object the tool will
 * execute with, so mutating it in place is how a timeout is injected. Every command is
 * capped by, in order:
 *   - the model's own `timeout` when it passed a shorter one,
 *   - the task ceiling (`tasks.bash_timeout_seconds`, default 150 s),
 *   - **the time left before the soft deadline**, so no command is still running when the
 *     control plane asks the worker to wrap up,
 *   - a short cap after the soft deadline, so the wrap-up window stays usable,
 *   - the time left before the hard deadline minus a margin for writing result.json.
 *
 * Env contract, exported by `apps/cairn/src/solver/breachweave.ts`:
 *   CAIRN_BASH_TIMEOUT_SECONDS     task ceiling in seconds
 *   CAIRN_TASK_SOFT_DEADLINE_MS    absolute epoch ms; may be absent (conclude had none)
 *   CAIRN_TASK_HARD_DEADLINE_MS    absolute epoch ms
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"

export const DEFAULT_BASH_TIMEOUT_SECONDS = 150
/** Smallest timeout we hand the tool; below this a command cannot do anything useful. */
export const MIN_TIMEOUT_SECONDS = 5
/** Ceiling once the soft deadline has passed and the task is writing its result. */
export const SOFT_DEADLINE_TIMEOUT_SECONDS = 30
/** Head room kept before the soft deadline so the wrap-up instruction can be acted on. */
export const SOFT_DEADLINE_MARGIN_SECONDS = 5
/** Head room kept before the hard deadline so the worker can still write result.json. */
export const HARD_DEADLINE_MARGIN_SECONDS = 10

export interface CommandDeadlineEnv {
  ceilingSeconds?: number
  softDeadlineMs?: number
  hardDeadlineMs?: number
}

export function readCommandDeadlineFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CommandDeadlineEnv {
  const number = (raw: string | undefined): number | undefined => {
    const value = raw === undefined ? Number.NaN : Number(raw.trim() === "" ? Number.NaN : raw)
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  const ceiling = number(env["CAIRN_BASH_TIMEOUT_SECONDS"])
  const soft = number(env["CAIRN_TASK_SOFT_DEADLINE_MS"])
  const hard = number(env["CAIRN_TASK_HARD_DEADLINE_MS"])
  return {
    ...(ceiling === undefined ? {} : { ceilingSeconds: Math.floor(ceiling) }),
    ...(soft === undefined ? {} : { softDeadlineMs: soft }),
    ...(hard === undefined ? {} : { hardDeadlineMs: hard }),
  }
}

/**
 * Resolves the timeout for one command. Always returns a positive integer: a bash call
 * never runs without a bound.
 */
export function resolveCommandTimeoutSeconds(input: {
  requested?: unknown
  ceilingSeconds: number
  softDeadlineMs?: number
  hardDeadlineMs?: number
  now: number
}): number {
  const ceiling = Math.max(MIN_TIMEOUT_SECONDS, Math.floor(input.ceilingSeconds))
  const requested =
    typeof input.requested === "number" &&
    Number.isFinite(input.requested) &&
    input.requested > 0
      ? Math.floor(input.requested)
      : undefined
  let limit = requested === undefined ? ceiling : Math.min(requested, ceiling)

  const soft = input.softDeadlineMs
  if (soft !== undefined && Number.isFinite(soft)) {
    const untilSoft = Math.floor((soft - input.now) / 1000)
    if (untilSoft <= 0) {
      // The task is wrapping up: several short commands can still improve the result,
      // one long one would only reach the hard deadline again.
      limit = Math.min(limit, SOFT_DEADLINE_TIMEOUT_SECONDS)
    } else {
      limit = Math.min(limit, Math.max(MIN_TIMEOUT_SECONDS, untilSoft - SOFT_DEADLINE_MARGIN_SECONDS))
    }
  }

  const hard = input.hardDeadlineMs
  if (hard !== undefined && Number.isFinite(hard)) {
    const untilHard = Math.floor((hard - input.now) / 1000)
    limit = Math.min(limit, Math.max(MIN_TIMEOUT_SECONDS, untilHard - HARD_DEADLINE_MARGIN_SECONDS))
  }

  return Math.max(1, limit)
}

export interface BashTimeoutExtensionOptions extends CommandDeadlineEnv {
  /** Test hook; defaults to `Date.now`. */
  now?: () => number
  /** Test hook; defaults to reading the process environment on every call. */
  readEnv?: () => CommandDeadlineEnv
}

/**
 * Returns the extension that bounds every bash command. It mutates `event.input.timeout`
 * in place — the SDK documents that as the supported way to modify a tool call — so it
 * works on the real bash tool rather than on a copy that would be discarded.
 */
export function bashTimeoutExtension(
  options: BashTimeoutExtensionOptions = {},
): ExtensionFactory {
  const now = options.now ?? Date.now
  const readEnv: () => CommandDeadlineEnv =
    options.readEnv ??
    (() => {
      const fromEnv = readCommandDeadlineFromEnv()
      return {
        ...((fromEnv.ceilingSeconds ?? options.ceilingSeconds) === undefined
          ? {}
          : { ceilingSeconds: fromEnv.ceilingSeconds ?? options.ceilingSeconds }),
        ...((fromEnv.softDeadlineMs ?? options.softDeadlineMs) === undefined
          ? {}
          : { softDeadlineMs: fromEnv.softDeadlineMs ?? options.softDeadlineMs }),
        ...((fromEnv.hardDeadlineMs ?? options.hardDeadlineMs) === undefined
          ? {}
          : { hardDeadlineMs: fromEnv.hardDeadlineMs ?? options.hardDeadlineMs }),
      }
    })

  return (pi) => {
    pi.on("tool_call", (event) => {
      const target = event as { toolName?: unknown; input?: unknown }
      if (target.toolName !== "bash") return undefined
      const input = target.input
      if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
      const args = input as Record<string, unknown>
      const env = readEnv()
      args["timeout"] = resolveCommandTimeoutSeconds({
        requested: args["timeout"],
        ceilingSeconds: env.ceilingSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS,
        ...(env.softDeadlineMs === undefined ? {} : { softDeadlineMs: env.softDeadlineMs }),
        ...(env.hardDeadlineMs === undefined ? {} : { hardDeadlineMs: env.hardDeadlineMs }),
        now: now(),
      })
      return undefined
    })
  }
}
