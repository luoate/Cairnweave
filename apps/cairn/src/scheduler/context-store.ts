/** M48 task-local recovery. No live DB access, network endpoint, or arbitrary path lookup. */
import type { TaskContextSnapshot } from "@cairn/graph";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const STORE_SECTIONS = ["facts", "intents", "attempts", "hints"] as const;
export type StoreSection = typeof STORE_SECTIONS[number];
export interface StoreCatalog {
  version: 1;
  project_id: string;
  snapshot_id: string;
  shard_max_bytes: number;
  detail_policy: TaskContextSnapshot["detail_policy"];
  raw_details: "control_plane_only";
  checkpoint_policy?: "task_checkpoint_v1_bounded_worker_claims";
  sections: Record<StoreSection, { count: number; index_pages: number; index_pattern: string }>;
}
export interface ContextStore {
  catalog: StoreCatalog;
  /** Keys are generated relative filenames, never IDs or other user-controlled paths. */
  files: Map<string, Buffer>;
  bytes: number;
}
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const recordPath = (section: StoreSection, id: string): string => `${section}/${sha256(id)}.json`;
export const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

/** UTF-8 boundaries are preserved; concatenating the fragments restores the exact bytes. */
export function splitUtf8(content: Buffer, maxBytes: number): Buffer[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error("invalid shard size");
  const parts: Buffer[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + maxBytes, content.length);
    while (end < content.length && (content[end]! & 0xc0) === 0x80) end -= 1;
    parts.push(content.subarray(start, end));
    start = end;
  }
  return parts;
}

export function buildContextStore(snapshot: TaskContextSnapshot, maxBytes: number): ContextStore {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 65536) throw new Error("invalid shard size");
  const files = new Map<string, Buffer>();
  const catalog: StoreCatalog = {
    version: 1, project_id: snapshot.project.id, snapshot_id: sha256(jsonBytes(snapshot)),
    shard_max_bytes: maxBytes, detail_policy: snapshot.detail_policy, raw_details: "control_plane_only",
    ...(snapshot.attempts.some((attempt) => attempt.memory !== undefined)
      ? { checkpoint_policy: "task_checkpoint_v1_bounded_worker_claims" as const } : {}),
    sections: {} as StoreCatalog["sections"],
  };
  const add = (path: string, bytes: Buffer) => {
    if (bytes.length > maxBytes || files.has(path)) throw new Error("invalid snapshot file");
    files.set(path, bytes);
  };
  for (const section of STORE_SECTIONS) {
    let page: Buffer[] = [];
    let size = 0;
    let pages = 0;
    const flush = () => {
      if (page.length === 0) return;
      add(`${section}/index-${pages}.jsonl`, Buffer.concat(page));
      pages += 1; page = []; size = 0;
    };
    const records = snapshot[section].map((record) => ({ record,
      id: "run_id" in record && !("id" in record) ? record.run_id : (record as { id: string }).id,
    })).sort((a, b) => a.id.localeCompare(b.id));
    for (const { record, id } of records) {
      const path = recordPath(section, id);
      const bytes = jsonBytes(record);
      if (bytes.length <= maxBytes) add(path, bytes);
      else {
        const parts = splitUtf8(bytes, maxBytes);
        const stem = path.slice(0, -5);
        parts.forEach((part, index) => add(`${stem}.part-${index}.txt`, part));
        add(path, jsonBytes({ version: 1, chunked: true, id, bytes: bytes.length,
          sha256: sha256(bytes), parts: parts.length, part_pattern: `${stem}.part-{index}.txt` }));
      }
      const text = "memory" in record && record.memory !== undefined ? record.memory.checkpoint.progress : "description" in record ? record.description : "content" in record ? record.content : "detail" in record ? record.detail ?? "" : "";
      let preview = splitUtf8(Buffer.from(text), 240)[0]?.toString("utf8") ?? "";
      const indexLine = () => jsonBytes({ id, path, preview,
        ...("memory" in record && record.memory !== undefined ? { intent_id: record.intent_id,
          has_checkpoint: true, termination_reason: record.memory.control.termination_reason } : {}),
        ...("status" in record ? { status: record.status } : {}),
        ...("dedupe_key" in record ? { dedupe_key: record.dedupe_key } : {}) });
      let line = indexLine();
      // JSON escaping can expand control characters sixfold. Bound serialized indices,
      // not just the unescaped preview; the complete record remains untouched.
      while (line.length > maxBytes && preview.length > 0) {
        preview = Array.from(preview).slice(0, -1).join(""); line = indexLine();
      }
      if (size + line.length > maxBytes) flush();
      // An unexpectedly unbounded ID/key is an invalid snapshot, not silently dropped data.
      if (line.length > maxBytes) throw new Error("index entry over shard limit");
      page.push(line); size += line.length;
    }
    flush();
    catalog.sections[section] = { count: records.length, index_pages: pages, index_pattern: `${section}/index-{index}.jsonl` };
  }
  add("catalog.json", jsonBytes(catalog));
  return { catalog, files, bytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) };
}

/** Publish only a fully written and verified directory. Never overwrite an existing store. */
export function persistContextStore(sessionDir: string, store: ContextStore): void {
  const staging = join(sessionDir, `.context-store-${randomUUID()}`);
  try {
    mkdirSync(staging);
    for (const [path, bytes] of store.files) {
      if (!/^(catalog\.json|(facts|intents|attempts|hints)\/([a-f0-9]{64}(\.json|\.part-[0-9]+\.txt)|index-[0-9]+\.jsonl))$/.test(path)) {
        throw new Error("invalid snapshot path");
      }
      const target = join(staging, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx" });
    }
    for (const [path, bytes] of store.files) {
      if (!readFileSync(join(staging, path)).equals(bytes)) throw new Error("snapshot validation failed");
    }
    if (existsSync(join(sessionDir, "context-store"))) throw new Error("snapshot already exists");
    renameSync(staging, join(sessionDir, "context-store"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Offline recovery/validation helper; not an HTTP or worker write API. */
export function recoverContextRecord(
  storeRoot: string, projectId: string, snapshotId: string, section: StoreSection, id: string,
): unknown {
  if (!(STORE_SECTIONS as readonly string[]).includes(section)) throw new Error("invalid section");
  const root = realpathSync(storeRoot);
  const read = (path: string): Buffer => {
    const target = realpathSync(resolve(root, path));
    const rel = relative(root, target);
    if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
      throw new Error("snapshot path escapes root");
    }
    return readFileSync(target);
  };
  const catalog = JSON.parse(read("catalog.json").toString("utf8")) as StoreCatalog;
  if (catalog.version !== 1 || catalog.project_id !== projectId || catalog.snapshot_id !== snapshotId ||
      !Number.isSafeInteger(catalog.shard_max_bytes) || catalog.shard_max_bytes < 1024 || catalog.shard_max_bytes > 65536) {
    throw new Error("snapshot identity mismatch");
  }
  const path = recordPath(section, id);
  const first = read(path);
  if (first.length > catalog.shard_max_bytes) throw new Error("oversize record");
  let value = JSON.parse(first.toString("utf8")) as Record<string, unknown>;
  if (value["chunked"] === true) {
    const count = value["parts"];
    if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 1_000_000) throw new Error("invalid parts");
    const parts: Buffer[] = [];
    for (let index = 0; index < (count as number); index += 1) {
      const part = read(`${path.slice(0, -5)}.part-${index}.txt`);
      if (part.length > catalog.shard_max_bytes) throw new Error("oversize fragment");
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length !== value["bytes"] || sha256(bytes) !== value["sha256"]) throw new Error("record digest mismatch");
    value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  }
  if ((section === "attempts" ? value["run_id"] : value["id"]) !== id) throw new Error("record identity mismatch");
  return value;
}
