/**
 * Writeup attachment bundle (M20b).
 *
 * The draft names payload and evidence files by path; this module turns those paths into one
 * ZIP so the reviewer gets the bytes too. The layout mirrors what the writeup cites:
 * `writeup.md`, `MANIFEST.md` and `artifacts/<indexed path>`, so a citation in the text is a
 * file that exists in the archive at the same relative location.
 *
 * Only indexed artifacts are read, through the same containment checks as the flag scanner:
 * regular non-symlink files under `<workspace>/artifacts`, no escapes, capped per file and per
 * bundle. Anything skipped is listed in `MANIFEST.md` with the reason, so a partial bundle is
 * visible rather than silent.
 */

import type { ProjectArtifact, ProjectWriteupSnapshot } from "@cairn/graph";

import { openArtifactRoot, readArtifactFile } from "./project-flag";
import { buildZip, type ZipEntryInput } from "./zip";

/** Bundle bounds: enough for a real project, small enough to serve in one response. */
export const MAX_ARCHIVE_FILES = 500;
export const MAX_ARCHIVE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;

export interface WriteupArchiveOptions {
  /** Host path of the project workspace. */
  workspace: string;
  /** Artifact index rows for the project, in the order stored. */
  artifacts: readonly ProjectArtifact[];
  snapshot: ProjectWriteupSnapshot;
  /** The Markdown that `writeup.md` carries: stored narrative or draft. */
  markdown: string;
  /** Which text `writeup.md` holds. */
  source: "draft" | "model";
  /** Timestamp written into the ZIP headers and the manifest. */
  generatedAt: Date;
}

export interface WriteupArchiveResult {
  bytes: Uint8Array;
  /** Artifact paths actually bundled. */
  bundled: string[];
  /** Indexed artifacts left out, with the reason shown in the manifest. */
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}

export function buildWriteupArchive(options: WriteupArchiveOptions): WriteupArchiveResult {
  const realRoot = openArtifactRoot(options.workspace);
  const bundled: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const entries: ZipEntryInput[] = [
    {
      name: "writeup.md",
      data: Buffer.from(options.markdown, "utf8"),
      modifiedAt: options.generatedAt,
    },
  ];
  let totalBytes = 0;
  let truncated = false;

  for (const artifact of options.artifacts) {
    if (realRoot === null) {
      skipped.push({ path: artifact.path, reason: "附件目录不可读" });
      continue;
    }
    if (bundled.length >= MAX_ARCHIVE_FILES || totalBytes >= MAX_ARCHIVE_TOTAL_BYTES) {
      truncated = true;
      skipped.push({ path: artifact.path, reason: "超出附件包上限" });
      continue;
    }
    if (artifact.size > MAX_ARCHIVE_FILE_BYTES) {
      skipped.push({ path: artifact.path, reason: `单文件超过 ${MAX_ARCHIVE_FILE_BYTES} 字节` });
      continue;
    }
    const data = readArtifactFile(realRoot, artifact.path, MAX_ARCHIVE_FILE_BYTES);
    if (data === null) {
      skipped.push({ path: artifact.path, reason: "文件缺失或不是普通文件" });
      continue;
    }
    totalBytes += data.length;
    bundled.push(artifact.path);
    entries.push({
      name: `artifacts/${artifact.path.replace(/\\/g, "/")}`,
      data,
      modifiedAt: options.generatedAt,
    });
  }

  const manifest = renderManifest(options, bundled, skipped, truncated);
  entries.splice(1, 0, {
    name: "MANIFEST.md",
    data: Buffer.from(manifest, "utf8"),
    modifiedAt: options.generatedAt,
  });

  return { bytes: buildZip(entries), bundled, skipped, truncated };
}

function renderManifest(
  options: WriteupArchiveOptions,
  bundled: readonly string[],
  skipped: readonly { path: string; reason: string }[],
  truncated: boolean,
): string {
  const { snapshot } = options;
  const lines: string[] = [];
  const push = (...values: string[]): void => {
    lines.push(...values);
  };

  push(`# 附件包清单：${snapshot.project.title || snapshot.project.id}`, "");
  push(`- 项目：\`${snapshot.project.id}\``);
  push(`- 打包时间：${options.generatedAt.toISOString()}`);
  push(`- writeup.md 来源：${options.source === "model" ? "模型撰写版" : "控制面草稿"}`);
  push(`- 附件文件：${bundled.length} 个已打包${truncated ? "（受上限约束，未全部打包）" : ""}`);
  if (snapshot.flag !== null) {
    push(`- Flag：\`${snapshot.flag.value}\`（来自 \`${snapshot.flag.source}\`）`);
  } else {
    push("- Flag：未捕获");
  }
  push(
    `- 载荷：识别到 ${snapshot.payloads_total} 个，正文内联 ${snapshot.payloads.length} 个` +
      `（${snapshot.payloads.filter((payload) => payload.text !== null).length} 个逐字引用）`,
  );

  push("", "## 目录结构", "", "- `writeup.md`：本项目的中文 Writeup 正文。");
  push("- `MANIFEST.md`：本清单。");
  push("- `artifacts/<任务目录>/<文件>`：worker 写下的证据与载荷，路径与 Writeup 中引用一致。");

  push("", "## 文件与校验");
  if (bundled.length === 0) {
    push("（没有可打包的附件）");
  } else {
    push("");
    push("| 路径 | 字节 | sha256 | 来源任务 |");
    push("| --- | --- | --- | --- |");
    for (const artifact of options.artifacts) {
      if (!bundled.includes(artifact.path)) continue;
      push(
        `| \`artifacts/${artifact.path.replace(/\\/g, "/")}\` | ${artifact.size} | ` +
          `\`${artifact.sha256}\` | \`${artifact.task_id}\` |`,
      );
    }
  }

  push("", "## 未打包文件");
  if (skipped.length === 0) {
    push("（全部附件都已打包）");
  } else {
    push("");
    push("| 路径 | 原因 |");
    push("| --- | --- |");
    for (const entry of skipped) {
      push(`| \`${entry.path.replace(/\\/g, "/")}\` | ${entry.reason} |`);
    }
  }

  push("", "_附件内容按原样打包，未改名、未压缩掉扩展名；校验列可用 `sha256sum -c` 风格逐条核对。_");
  return `${lines.join("\n")}\n`;
}
