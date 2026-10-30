import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

/** Served verbatim from `staticDir`; the extension decides the media type. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Already-compressed formats (png, woff2, …) are skipped by absence from this set. */
const COMPRESSIBLE = new Set([".html", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".webmanifest"]);

const MAX_CACHED_FILES = 64;
/** Brotli at quality 5 costs a few milliseconds for the 1.6 MB layout bundle. */
const BROTLI_QUALITY = 5;

/** Assets keep their URL, so every response revalidates instead of going stale. */
const CACHE_CONTROL = "no-cache";
const VARY = "Accept-Encoding";

type CachedStaticFile = {
  fingerprint: string;
  etag: string;
  lastModified: string;
  contentType: string;
  identity: Uint8Array;
  gzip?: Uint8Array;
  brotli?: Uint8Array;
};

const cache = new Map<string, CachedStaticFile>();

function remember(path: string, entry: CachedStaticFile): CachedStaticFile {
  cache.set(path, entry);
  if (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return entry;
}

function loadStaticFile(path: string, stat: { size: number; mtimeMs: number; mtime: Date }): CachedStaticFile {
  const fingerprint = `${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}`;
  const cached = cache.get(path);
  if (cached?.fingerprint === fingerprint) return cached;

  const extension = extname(path);
  const bytes = new Uint8Array(readFileSync(path));
  const entry: CachedStaticFile = {
    fingerprint,
    etag: `"${fingerprint}"`,
    lastModified: stat.mtime.toUTCString(),
    contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
    identity: bytes,
  };
  if (COMPRESSIBLE.has(extension)) {
    entry.gzip = new Uint8Array(gzipSync(bytes, { level: 6 }));
    entry.brotli = new Uint8Array(
      brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      }),
    );
  }
  return remember(path, entry);
}

function pickEncoding(header: string | null, extension: string): "br" | "gzip" | null {
  if (!header || !COMPRESSIBLE.has(extension)) return null;
  const encodings = header.toLowerCase();
  if (/\bbr\b/.test(encodings)) return "br";
  if (/\bgzip\b/.test(encodings)) return "gzip";
  return null;
}

function notModified(entry: CachedStaticFile): Response {
  return new Response(null, {
    status: 304,
    headers: {
      etag: entry.etag,
      "cache-control": CACHE_CONTROL,
      vary: VARY,
      "last-modified": entry.lastModified,
    },
  });
}

/**
 * Serves `staticDir` with revalidation and compression. Assets keep their URL,
 * so every response is `no-cache` plus an mtime/size ETag: a reload costs a 304
 * instead of re-transferring the vendored graph libraries.
 */
export async function serveStaticFile(
  staticDir: string,
  pathname: string,
  request: Request,
): Promise<Response | null> {
  const root = resolve(staticDir);
  let relative: string;
  if (pathname === "/") {
    relative = "index.html";
  } else if (pathname.startsWith("/static/")) {
    relative = pathname.slice("/static/".length);
  } else {
    return null;
  }
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    return null;
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const entry = loadStaticFile(target, stat);
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((value) => value.trim() === entry.etag)) {
    return notModified(entry);
  }

  const wanted = pickEncoding(request.headers.get("accept-encoding"), extname(target));
  const encoded = wanted === "br" ? entry.brotli : wanted === "gzip" ? entry.gzip : undefined;

  const headers = new Headers({
    "content-type": entry.contentType,
    "cache-control": CACHE_CONTROL,
    etag: entry.etag,
    "last-modified": entry.lastModified,
    vary: VARY,
  });
  if (encoded && wanted) headers.set("content-encoding", wanted);

  return new Response(encoded ?? entry.identity, { headers });
}
