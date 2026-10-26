/** Shared names and bounds for the worker-written live-stream loss marker. */
export const AUDIT_STREAM_LOST_FILE = "audit-stream-lost.json";

/** The marker is a small diagnostic object; anything larger is not trusted. */
export const MAX_AUDIT_STREAM_LOST_BYTES = 64 * 1024;

/** Reasons can carry a fetch/status error; keep the stored value bounded. */
export const MAX_AUDIT_STREAM_LOST_REASON_CHARS = 512;

/** ISO timestamps are short; reject arbitrary worker-controlled text of unbounded length. */
export const MAX_AUDIT_STREAM_LOST_TS_CHARS = 64;
