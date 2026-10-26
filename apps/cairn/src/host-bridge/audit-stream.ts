/**
 * Bounded live sender for the audit ledger.
 *
 * The Host Bridge still appends every decision to `audit.jsonl` first; this sender only
 * forwards the same entry with an explicit sequence number. Delivery is best-effort and
 * must never block a tool call: `enqueue` is synchronous and one background loop drains the
 * queue in order.
 *
 * Ordering is the safety property. When delivery fails, is rejected, or overflows the
 * queue, the sender stops permanently instead of skipping ahead; the finish-time import
 * of `audit.jsonl` then fills every remaining sequence. A local marker records why the
 * live stream ended.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AUDIT_STREAM_LOST_FILE } from "../audit-stream/constants";

export { AUDIT_STREAM_LOST_FILE } from "../audit-stream/constants";

const DEFAULT_MAX_QUEUE = 512;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BUDGET_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

export interface StreamEntry {
  seq: number;
  event: unknown;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuditStreamSenderOptions {
  /** Control-plane base URL, without the route suffix. */
  url: string;
  token: string;
  projectId: string;
  taskId: string;
  /** Worker-view session directory; the lost marker is written here. */
  sessionDir: string;
  maxQueue?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  retryBudgetMs?: number;
  retryDelayMs?: number;
  closeTimeoutMs?: number;
  /** Test hook. */
  fetch?: FetchLike;
}

export class AuditStreamSender {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly taskId: string;
  private readonly sessionDir: string;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly retryBudgetMs: number;
  private readonly retryDelayMs: number;
  private readonly closeTimeoutMs: number;
  private readonly fetchFn: FetchLike;

  private queue: StreamEntry[] = [];
  private nextSeq = 1;
  private delivered = 0;
  private closed = false;
  private stopped = false;
  private pending: Promise<void> | null = null;

  constructor(options: AuditStreamSenderOptions) {
    this.endpoint =
      `${options.url.replace(/\/+$/, "")}/projects/` +
      `${encodeURIComponent(options.projectId)}/tasks/` +
      `${encodeURIComponent(options.taskId)}/audit`;
    this.token = options.token;
    this.taskId = options.taskId;
    this.sessionDir = options.sessionDir;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryBudgetMs = options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Assigns the next sequence number and starts delivery. Never throws. */
  enqueue(event: unknown): void {
    if (this.closed || this.stopped) return;
    const entry: StreamEntry = { seq: this.nextSeq, event };
    this.nextSeq += 1;
    if (this.queue.length >= this.maxQueue) {
      this.stop("queue overflow");
      return;
    }
    this.queue.push(entry);
    this.kick();
  }

  /** Waits up to `closeTimeoutMs` for the queue to drain, then stops for good. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const deadline = Date.now() + this.closeTimeoutMs;
    while (!this.stopped && (this.queue.length > 0 || this.pending !== null)) {
      if (Date.now() >= deadline) {
        this.stop("flush timeout");
        return;
      }
      await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  /** True when no live batch can be sent any more. */
  get isStopped(): boolean {
    return this.stopped;
  }

  private kick(): void {
    if (this.pending !== null || this.stopped || this.closed) return;
    this.pending = this.drain().finally(() => {
      this.pending = null;
      if (this.queue.length > 0 && !this.stopped && !this.closed) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const batch = this.queue.slice(0, this.batchSize);
      if (!(await this.sendWithRetry(batch))) return;
      this.queue.splice(0, batch.length);
      this.delivered += batch.length;
    }
  }

  private async sendWithRetry(batch: readonly StreamEntry[]): Promise<boolean> {
    const deadline = Date.now() + this.retryBudgetMs;
    let lastError = "unknown error";
    for (;;) {
      try {
        const response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (response.ok) {
          await response.body?.cancel().catch(() => {});
          return true;
        }
        // Retrying cannot fix authentication or a chain conflict; stop so the finish-time
        // import owns the rest of the file.
        if (response.status !== 408 && response.status !== 429 && response.status < 500) {
          this.stop(`rejected with status ${response.status}`);
          return false;
        }
        lastError = `status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() + this.retryDelayMs > deadline) {
        this.stop(`delivery failed: ${lastError}`);
        return false;
      }
      await Bun.sleep(this.retryDelayMs);
    }
  }

  private stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    const pending = this.queue.length;
    this.queue = [];
    try {
      writeFileSync(
        join(this.sessionDir, AUDIT_STREAM_LOST_FILE),
        `${JSON.stringify({
          ts: new Date().toISOString(),
          task_id: this.taskId,
          reason,
          delivered: this.delivered,
          pending,
        })}\n`,
        "utf8",
      );
    } catch {
      // The marker is diagnostic; the local audit file is the recovery source.
    }
  }
}
