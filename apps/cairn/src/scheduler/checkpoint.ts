/** Only a bounded, regular same-session file is imported. No worker-chosen DB paths. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_CHECKPOINT_BYTES, TASK_CHECKPOINT_FILE, safeCheckpointRef } from "@cairn/contracts";
import { acceptTaskCheckpoint, type CairnDatabase } from "@cairn/graph";
export function ingestCheckpoint(db: CairnDatabase, input: {
  runId: string; projectId: string; taskId: string; sessionDir: string;
}): string {
  let fd: number | undefined;
  try {
    const root = realpathSync(input.sessionDir);
    if (root !== resolve(input.sessionDir)) return "invalid";
    const path = join(root, TASK_CHECKPOINT_FILE);
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink() || realpathSync(path) !== path) return "invalid";
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES || stat.ino !== link.ino || stat.dev !== link.dev) return "invalid";
    const bytes = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_CHECKPOINT_BYTES) return "invalid";
    return db.withConn((conn) => acceptTaskCheckpoint(conn, { ...input, bytes: bytes.subarray(0, count) }));
  } catch { return "unavailable"; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Availability is not evidence verification and never follows links outside the project. */
export function checkpointEvidenceStatus(workspace: string, ref: string): "available" | "missing" | "unavailable" {
  if (!safeCheckpointRef(ref)) return "unavailable";
  try {
    const root = realpathSync(workspace);
    const target = realpathSync(join(root, ref));
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return "unavailable";
    return lstatSync(target).isFile() ? "available" : "unavailable";
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable"; }
}
