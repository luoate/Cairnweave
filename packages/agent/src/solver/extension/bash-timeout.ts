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
 * M59: a bound the model cannot see is a bound the model cannot plan around. proj_052 spent
 * 66–94% of its tool time inside commands that were killed at 126/48/38/5 s, all of which
 * were the *remaining budget*, not the command, and the model read each one as "this command
 * is slow" and rewrote it. So every bash result now carries one line of budget:
 *
 *   [时间] 已用 213s，距软截止 267s、硬截止 387s；本条命令上限 126s（按剩余时间收紧，默认 150s）
 *
 * Successful results get it appended in `tool_result`. Failed results cannot be edited —
 * the SDK drops a `tool_result` handler's return value when `isError` is set — so for those
 * (the timeouts) the same line is delivered as a `nextTurn` message instead.
 *
 * Env contract, exported by `apps/cairn/src/solver/breachweave.ts`:
 *   CAIRN_BASH_TIMEOUT_SECONDS     task ceiling in seconds
 *   CAIRN_TASK_STARTED_MS          absolute epoch ms when the worker started
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
/** Below this much time left before the soft deadline the notice tells the model to wrap up. */
export const WRAP_UP_NOTICE_SECONDS = 60
/**
 * A failed command normally needs no notice — it already errored, and the model has the clock
 * from the successful calls around it. Inside this window the clock is worth a message.
 */
export const ERROR_NOTICE_SECONDS = 120

export interface CommandDeadlineEnv {
  ceilingSeconds?: number
  startedMs?: number
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
  const started = number(env["CAIRN_TASK_STARTED_MS"])
  const soft = number(env["CAIRN_TASK_SOFT_DEADLINE_MS"])
  const hard = number(env["CAIRN_TASK_HARD_DEADLINE_MS"])
  return {
    ...(ceiling === undefined ? {} : { ceilingSeconds: Math.floor(ceiling) }),
    ...(started === undefined ? {} : { startedMs: started }),
    ...(soft === undefined ? {} : { softDeadlineMs: soft }),
    ...(hard === undefined ? {} : { hardDeadlineMs: hard }),
  }
}

/** Which limit produced the final value; the budget notice names it so the model can tell
 *  "this command is slow" from "the task is nearly out of time". */
export type CommandTimeoutSource =
  | "model"
  | "ceiling"
  | "soft_deadline"
  | "wrap_up"
  | "hard_deadline"

export interface CommandTimeoutInput {
  requested?: unknown
  ceilingSeconds: number
  softDeadlineMs?: number
  hardDeadlineMs?: number
  now: number
}

export interface ResolvedCommandTimeout {
  seconds: number
  source: CommandTimeoutSource
}

/**
 * Resolves the timeout for one command. Always returns a positive integer: a bash call
 * never runs without a bound.
 */
export function resolveCommandTimeout(input: CommandTimeoutInput): ResolvedCommandTimeout {
  const ceiling = Math.max(MIN_TIMEOUT_SECONDS, Math.floor(input.ceilingSeconds))
  const requested =
    typeof input.requested === "number" &&
    Number.isFinite(input.requested) &&
    input.requested > 0
      ? Math.floor(input.requested)
      : undefined

  let seconds = ceiling
  let source: CommandTimeoutSource = "ceiling"
  if (requested !== undefined && requested < ceiling) {
    seconds = requested
    source = "model"
  }

  const soft = input.softDeadlineMs
  if (soft !== undefined && Number.isFinite(soft)) {
    const untilSoft = Math.floor((soft - input.now) / 1000)
    if (untilSoft <= 0) {
      // The task is wrapping up: several short commands can still improve the result,
      // one long one would only reach the hard deadline again.
      if (SOFT_DEADLINE_TIMEOUT_SECONDS < seconds) {
        seconds = SOFT_DEADLINE_TIMEOUT_SECONDS
        source = "wrap_up"
      }
    } else {
      const softLimit = Math.max(MIN_TIMEOUT_SECONDS, untilSoft - SOFT_DEADLINE_MARGIN_SECONDS)
      if (softLimit < seconds) {
        seconds = softLimit
        source = "soft_deadline"
      }
    }
  }

  const hard = input.hardDeadlineMs
  if (hard !== undefined && Number.isFinite(hard)) {
    const untilHard = Math.floor((hard - input.now) / 1000)
    const hardLimit = Math.max(MIN_TIMEOUT_SECONDS, untilHard - HARD_DEADLINE_MARGIN_SECONDS)
    if (hardLimit < seconds) {
      seconds = hardLimit
      source = "hard_deadline"
    }
  }

  return { seconds: Math.max(1, seconds), source }
}

/** Convenience wrapper for callers that only need the number. */
export function resolveCommandTimeoutSeconds(input: CommandTimeoutInput): number {
  return resolveCommandTimeout(input).seconds
}

export interface BudgetNoticeInput {
  limitSeconds: number
  source: CommandTimeoutSource
  defaultCeilingSeconds: number
  elapsedSeconds?: number
  untilSoftSeconds?: number
  untilHardSeconds?: number
  /** The command was cut off at its limit rather than finishing on its own. */
  timedOut?: boolean
}

function describeSource(input: BudgetNoticeInput): string {
  switch (input.source) {
    case "model":
      return "按你传入的 timeout"
    case "soft_deadline":
      return `按剩余时间收紧，默认 ${input.defaultCeilingSeconds}s`
    case "wrap_up":
      return `软截止已过，收尾期固定 ${SOFT_DEADLINE_TIMEOUT_SECONDS}s`
    case "hard_deadline":
      return "按硬截止前的剩余时间收紧"
    case "ceiling":
      return `本任务默认上限`
  }
}

/**
 * One line of budget the model can actually read. Kept short: it rides on every bash
 * result, so it has to earn its context.
 */
export function formatBudgetNotice(input: BudgetNoticeInput): string {
  const parts: string[] = []
  if (input.elapsedSeconds !== undefined) parts.push(`已用 ${input.elapsedSeconds}s`)
  if (input.untilSoftSeconds !== undefined) {
    parts.push(`距软截止 ${Math.max(0, input.untilSoftSeconds)}s`)
  }
  if (input.untilHardSeconds !== undefined) {
    parts.push(`距硬截止 ${Math.max(0, input.untilHardSeconds)}s`)
  }
  parts.push(`本条命令上限 ${input.limitSeconds}s（${describeSource(input)}）`)
  const lines = [`[时间] ${parts.join("，")}`]

  if (input.timedOut) {
    lines.push(
      input.source === "soft_deadline" ||
        input.source === "hard_deadline" ||
        input.source === "wrap_up"
        ? "这条命令是被任务剩余时间截断的，不是命令本身慢，它多半还没跑完：不要原样重跑，改成更小的批次，或先写成脚本再分批执行。"
        : "这条命令用满了自己的上限，它可能还没跑完：先缩小范围或分批，再决定要不要重跑。",
    )
  }

  if (input.untilSoftSeconds !== undefined && input.untilSoftSeconds <= WRAP_UP_NOTICE_SECONDS) {
    lines.push("距软截止已不足一分钟：不要再启动新命令，立刻整理已有结论并写出最终 JSON。")
  }
  return lines.join(" ")
}

export interface BashTimeoutExtensionOptions extends CommandDeadlineEnv {
  /** Test hook; defaults to `Date.now`. */
  now?: () => number
  /** Test hook; defaults to reading the process environment on every call. */
  readEnv?: () => CommandDeadlineEnv
  /** Test hook; the real value is `pi.sendMessage`, used when a failed result cannot be edited. */
  sendMessage?: (text: string) => void
}

interface CallRecord {
  limitSeconds: number
  source: CommandTimeoutSource
  startedAt: number
}

/**
 * Returns the extension that bounds every bash command and reports the budget back.
 *
 * `tool_call` mutates `event.input.timeout` in place — the SDK documents that as the
 * supported way to modify a tool call — so it works on the real bash tool rather than on a
 * copy that would be discarded.
 *
 * The result is reported twice over: appended to a successful result's content, and, for a
 * failed one, sent as a message, because the SDK ignores a `tool_result` handler's return
 * value when the tool errored — which is exactly the timeout case that matters most.
 */
export function bashTimeoutExtension(
  options: BashTimeoutExtensionOptions = {},
): ExtensionFactory {
  const now = options.now ?? Date.now
  const readEnv: () => CommandDeadlineEnv =
    options.readEnv ??
    (() => {
      const fromEnv = readCommandDeadlineFromEnv()
      const pick = <K extends keyof CommandDeadlineEnv>(key: K): CommandDeadlineEnv[K] =>
        (fromEnv[key] as CommandDeadlineEnv[K] | undefined) ?? options[key]
      const merged: CommandDeadlineEnv = {}
      for (const key of [
        "ceilingSeconds",
        "startedMs",
        "softDeadlineMs",
        "hardDeadlineMs",
      ] as const) {
        const value = pick(key)
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value
      }
      return merged
    })

  const calls = new Map<string, CallRecord>()

  const notice = (record: CallRecord | undefined, at: number, timedOut: boolean): string => {
    const env = readEnv()
    const ceiling = env.ceilingSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS
    const resolved = record ?? {
      limitSeconds: ceiling,
      source: "ceiling" as CommandTimeoutSource,
      startedAt: at,
    }
    const secondsUntil = (target: number | undefined): number | undefined =>
      target === undefined ? undefined : Math.floor((target - at) / 1000)
    return formatBudgetNotice({
      limitSeconds: resolved.limitSeconds,
      source: resolved.source,
      defaultCeilingSeconds: ceiling,
      ...(env.startedMs === undefined
        ? {}
        : { elapsedSeconds: Math.max(0, Math.floor((at - env.startedMs) / 1000)) }),
      ...(() => {
        const untilSoft = secondsUntil(env.softDeadlineMs)
        return untilSoft === undefined ? {} : { untilSoftSeconds: untilSoft }
      })(),
      ...(() => {
        const untilHard = secondsUntil(env.hardDeadlineMs)
        return untilHard === undefined ? {} : { untilHardSeconds: untilHard }
      })(),
      ...(timedOut ? { timedOut: true } : {}),
    })
  }

  return (pi) => {
    pi.on("tool_call", (event) => {
      const target = event as { toolName?: unknown; input?: unknown; toolCallId?: unknown }
      if (target.toolName !== "bash") return undefined
      const input = target.input
      if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
      const args = input as Record<string, unknown>
      const at = now()
      const env = readEnv()
      const resolved = resolveCommandTimeout({
        requested: args["timeout"],
        ceilingSeconds: env.ceilingSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS,
        ...(env.softDeadlineMs === undefined ? {} : { softDeadlineMs: env.softDeadlineMs }),
        ...(env.hardDeadlineMs === undefined ? {} : { hardDeadlineMs: env.hardDeadlineMs }),
        now: at,
      })
      args["timeout"] = resolved.seconds
      if (typeof target.toolCallId === "string") {
        // A blocked call never reports back; keep the map from growing for a whole session.
        if (calls.size >= 200) {
          const oldest = calls.keys().next()
          if (!oldest.done) calls.delete(oldest.value)
        }
        calls.set(target.toolCallId, {
          limitSeconds: resolved.seconds,
          source: resolved.source,
          startedAt: at,
        })
      }
      return undefined
    })

    pi.on("tool_result", (event) => {
      const target = event as {
        toolName?: unknown
        toolCallId?: unknown
        content?: unknown
        isError?: unknown
      }
      if (target.toolName !== "bash") return undefined
      const at = now()
      const id = typeof target.toolCallId === "string" ? target.toolCallId : undefined
      const record = id === undefined ? undefined : calls.get(id)
      if (id !== undefined) calls.delete(id)
      const content = Array.isArray(target.content) ? (target.content as unknown[]) : []
      const isText = (item: unknown): item is { type: "text"; text: string } => {
        const candidate = item as { type?: unknown; text?: unknown }
        return candidate?.type === "text" && typeof candidate.text === "string"
      }
      // Not every error is a timeout: only the bash tool's own message means the limit was hit.
      const text = content.filter(isText).map((item) => item.text).join("\n")
      const timedOut = target.isError === true && /Command timed out after \d+ seconds/.test(text)
      const noticeText = notice(record, at, timedOut)

      if (target.isError === true) {
        // A message is louder than a result suffix, so it is only spent where it changes what
        // the model does next: a budget cut, or a clock that is running out.
        const env = readEnv()
        const untilSoft = env.softDeadlineMs === undefined
          ? undefined
          : Math.floor((env.softDeadlineMs - at) / 1000)
        if (!timedOut && (untilSoft === undefined || untilSoft > ERROR_NOTICE_SECONDS)) {
          return undefined
        }
        // The SDK discards a tool_result result on error, so the notice has to arrive as a
        // message. `nextTurn` keeps it out of the middle of the pending tool batch.
        if (options.sendMessage) options.sendMessage(noticeText)
        else if (typeof (pi as { sendMessage?: unknown }).sendMessage === "function") {
          (pi as unknown as {
            sendMessage: (m: unknown, o?: unknown) => void
          }).sendMessage(
            {
              customType: "cairn-time-budget",
              content: [{ type: "text", text: noticeText }],
              display: false,
              details: { tool: "bash" },
            },
            { deliverAs: "nextTurn" },
          )
        }
        return undefined
      }

      const next = [...content]
      const index = next.map(isText).lastIndexOf(true)
      if (index >= 0) {
        const item = next[index] as { type: "text"; text: string }
        next[index] = { type: "text", text: `${item.text}\n\n${noticeText}` }
      } else {
        next.push({ type: "text", text: noticeText })
      }
      return { content: next }
    })
  }
}
