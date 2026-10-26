/**
 * In-memory bearer tokens for the live audit stream.
 *
 * Only the SHA-256 of a token is kept, and comparisons are constant-time. A token is bound
 * to one (project, task) pair: a worker can append to its own chain and nothing else. The
 * registry lives in the control plane process; tokens die with the task and are gone
 * after a restart, which only falls back to the finish-time file import.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

interface TokenRecord {
  projectId: string;
  taskId: string;
  digest: Buffer;
}

function taskKey(projectId: string, taskId: string): string {
  return `${projectId}\u0000${taskId}`;
}

function digestOf(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class AuditTokenRegistry {
  private readonly byDigest = new Map<string, TokenRecord>();
  private readonly byTask = new Map<string, string>();

  /** Mints a new token and replaces any previous token for the same task. */
  register(projectId: string, taskId: string): string {
    this.revoke(projectId, taskId);
    const token = `cairn_audit_${randomBytes(32).toString("base64url")}`;
    const digest = digestOf(token);
    const record: TokenRecord = { projectId, taskId, digest };
    this.byDigest.set(digest.toString("hex"), record);
    this.byTask.set(taskKey(projectId, taskId), digest.toString("hex"));
    return token;
  }

  authenticate(token: string, projectId: string, taskId: string): boolean {
    if (token === "") return false;
    const record = this.byDigest.get(digestOf(token).toString("hex"));
    if (record === undefined) return false;
    if (record.projectId !== projectId || record.taskId !== taskId) return false;
    return timingSafeEqual(record.digest, digestOf(token));
  }

  revoke(projectId: string, taskId: string): void {
    const key = taskKey(projectId, taskId);
    const hex = this.byTask.get(key);
    if (hex === undefined) return;
    this.byTask.delete(key);
    this.byDigest.delete(hex);
  }

  get size(): number {
    return this.byTask.size;
  }
}
