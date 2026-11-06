/** Read-only bounded diagnostics: never expose provider bodies or credentials. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const MODEL_FAILURES = {
  model_connection_error: { title: "模型连接失败", message: "无法连接模型服务，请检查模型网关地址、代理与网络。" },
  model_auth_error: { title: "模型认证失败", message: "模型服务拒绝认证或访问，请检查密钥与模型权限。" },
  model_rate_limit: { title: "模型服务限流", message: "模型服务返回限流或配额错误，请检查服务额度并稍后重试。" },
  model_timeout: { title: "模型请求超时", message: "等待模型服务响应超时，请检查服务状态与网络。" },
  model_error: { title: "模型请求失败", message: "模型服务未正常返回。原始错误可能含敏感信息，未向页面公开。" },
} as const;
export type ModelFailureCode = keyof typeof MODEL_FAILURES;
export interface ModelDiagnostic {
  code: ModelFailureCode;
  title: string;
  message: string;
  observed_at: string | null;
  recent_error_count: number;
  source: "worker_session" | "run_detail";
}

export function classifyModelError(value: string): ModelFailureCode {
  const text = value.slice(0, 8192);
  for (const code of Object.keys(MODEL_FAILURES) as ModelFailureCode[]) {
    if (text.startsWith(`[${code}] ${MODEL_FAILURES[code].message}`)) return code;
  }
  if (/\b(401|403)\b|unauthorized|authentication|invalid.api.key|permission.denied/i.test(text)) return "model_auth_error";
  if (/\b429\b|rate.limit|quota.exceeded|insufficient.quota/i.test(text)) return "model_rate_limit";
  if (/timed?.?out|timeout|ETIMEDOUT/i.test(text)) return "model_timeout";
  if (/connection.error|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch.failed|socket.*closed|network.error/i.test(text)) return "model_connection_error";
  return "model_error";
}

const MAX_TAIL_BYTES = 131072;

/** The caller supplies a fixed task directory, never a worker-selected path. */
export function readModelDiagnostic(sessionDir: string): ModelDiagnostic | null {
  return readModelSessionState(sessionDir).diagnostic;
}

export interface ModelSessionState {
  diagnostic: ModelDiagnostic | null;
  /** Tool results are only a salvage hint, never verified facts. null = history incomplete. */
  hasUsefulWork: boolean | null;
}
export function readModelSessionState(sessionDir: string): ModelSessionState {
  let diagnostic: ModelDiagnostic | null = null;
  let resolvedAssistant = false;
  let useful = false;
  let complete = true;
  try {
    const session = resolve(sessionDir);
    if (realpathSync(session) !== session) return { diagnostic: null, hasUsefulWork: null };
    const root = join(session, "solver-session");
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) return { diagnostic: null, hasUsefulWork: null };
    const dir = opendirSync(root);
    const names: string[] = [];
    let exhausted = false;
    try {
      for (let i = 0; i < 64; i++) {
        const entry = dir.readSync();
        if (entry === null) { exhausted = true; break; }
        if (entry.isFile() && /^[A-Za-z0-9_-]{1,160}\.jsonl$/.test(entry.name)) names.push(entry.name);
        else complete = false;
      }
    } finally { dir.closeSync(); }
    complete &&= exhausted && names.length > 0 && names.length <= 2;
    // Native filenames start with ISO time. Read at most two 128 KiB tails.
    for (const name of names.sort().reverse().slice(0, 2)) {
      const path = join(root, name);
      let fd: number | undefined;
      try {
        const link = lstatSync(path);
        if (!link.isFile() || link.isSymbolicLink() || realpathSync(path) !== path) { complete = false; continue; }
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev) { complete = false; continue; }
        const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
        const bytes = Buffer.alloc(Math.min(stat.size, MAX_TAIL_BYTES));
        const count = readSync(fd, bytes, 0, bytes.length, start);
        if (start > 0 || count !== bytes.length) complete = false;
        let tail = bytes.subarray(0, count);
        if (start > 0) {
          const newline = tail.indexOf(10);
          if (newline < 0) continue;
          tail = tail.subarray(newline + 1);
        }
        let latest: ModelDiagnostic | null = null;
        let sawAssistant = false;
        let errors = 0;
        const lines = tail.toString("utf8").split("\n");
        if (lines.pop() !== "") complete = false; // Ignore partial events, but never infer no work from them.
        for (const line of lines) {
          if (line.trim() === "") continue;
          let item;
          try { item = JSON.parse(line); } catch { complete = false; continue; }
          if (item?.type !== "message") continue;
          if (item.message?.role === "toolResult") useful = true;
          if (item.message?.role !== "assistant") continue;
          sawAssistant = true;
          latest = null;
          if (item.message.stopReason !== "error" && Array.isArray(item.message.content) &&
              item.message.content.some((block: { text?: unknown; type?: unknown }) => block !== null &&
                ((typeof block.text === "string" && block.text.trim() !== "") || block.type === "toolCall"))) useful = true;
          if (item.message.stopReason !== "error" || typeof item.message.errorMessage !== "string") continue;
          errors++;
          const code = classifyModelError(item.message.errorMessage);
          const timestamp = typeof item.timestamp === "string" &&
            /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(item.timestamp) ? item.timestamp : null;
          latest = { code, ...MODEL_FAILURES[code], observed_at: timestamp,
            recent_error_count: errors, source: "worker_session" };
        }
        // Only the newest assistant turn controls diagnosis. Older files may still
        // contain work worth salvaging, but must not revive a recovered model error.
        if (sawAssistant && !resolvedAssistant) { diagnostic = latest; resolvedAssistant = true; }
      } finally { if (fd !== undefined) closeSync(fd); }
    }
  } catch { complete = false; /* Missing, unreadable, or raced files are not proof of no work. */ }
  return { diagnostic, hasUsefulWork: useful ? true : complete ? false : null };
}

export function modelFailureDetail(diagnostic: ModelDiagnostic): string {
  return `[${diagnostic.code}] ${MODEL_FAILURES[diagnostic.code].message}`;
}

/** A resumed solver writes into the old session. Mirror only its fixed safe failure
 * into the current task so supervision never reuses an old assistant answer as success. */
export function persistModelDiagnostic(sessionDir: string, diagnostic: ModelDiagnostic): void {
  const root = join(sessionDir, "solver-session");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "model-error.jsonl"), JSON.stringify({ type: "message", timestamp: new Date().toISOString(),
    message: { role: "assistant", stopReason: "error", errorMessage: modelFailureDetail(diagnostic) } }) + "\n", "utf8");
}

export function persistedModelDiagnostic(detail: string | null, at: string | null): ModelDiagnostic | null {
  for (const code of Object.keys(MODEL_FAILURES) as ModelFailureCode[]) {
    if (detail?.startsWith(`[${code}] ${MODEL_FAILURES[code].message}`)) {
      return { code, ...MODEL_FAILURES[code], observed_at: at, recent_error_count: 0, source: "run_detail" };
    }
  }
  return null;
}
