import { resolve, dirname } from "path"
import { mkdir } from "fs/promises"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { loadSkillsFromDir } from "@mariozechner/pi-coding-agent"
import type { Skill } from "@mariozechner/pi-coding-agent"
import { BUILTIN_SKILL_FILES } from "../builtin-assets.generated"

/** 记录已删除的内置 skill 目录，重启后不再释放；与 prompts 的 .deleted-builtins.json 对称。 */
const DELETED_BUILTINS_FILE = ".deleted-builtins.json"
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_NAME = 64
const SAFE_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function builtinSkillFiles(): Record<string, string> {
    return BUILTIN_SKILL_FILES as unknown as Record<string, string>
}

function builtinDirectories(): Set<string> {
    return new Set(
        Object.keys(builtinSkillFiles())
            .map((relativePath) => relativePath.split("/")[0]!)
            .filter((name) => name !== ""),
    )
}

function filesForBuiltin(name: string): Array<[string, string]> {
    const prefix = `${name}/`
    return Object.entries(builtinSkillFiles()).filter(([relativePath]) =>
        relativePath.startsWith(prefix),
    )
}

export function isBuiltinSkillDirectory(name: string): boolean {
    return builtinDirectories().has(name)
}

/** Agent Skills 规范名：小写字母/数字/连字符，不以连字符开头结尾，不连续。 */
export function isValidSkillName(name: string): boolean {
    return name.length <= MAX_SKILL_NAME && SKILL_NAME.test(name)
}

function assertSkillDirectory(name: string): void {
    if (!SAFE_DIRECTORY.test(name)) throw new Error("invalid skill directory name")
}

function deletedBuiltinsPath(dir: string): string {
    return resolve(dir, "skills", DELETED_BUILTINS_FILE)
}

function loadDeletedBuiltins(dir: string): Set<string> {
    const path = deletedBuiltinsPath(dir)
    if (!existsSync(path)) return new Set()
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"))
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((item): item is string => typeof item === "string"))
    } catch {
        return new Set()
    }
}

async function saveDeletedBuiltins(dir: string, deleted: Set<string>): Promise<void> {
    await mkdir(resolve(dir, "skills"), { recursive: true })
    await Bun.write(deletedBuiltinsPath(dir), JSON.stringify([...deleted].sort(), null, 2))
}

/** 将内置 skills 释放到用户 config 目录；已删除的内置技能不再恢复。 */
export async function initBuiltinSkills(dir: string) {
    const destBase = resolve(dir, "skills")
    await mkdir(destBase, { recursive: true })
    const deleted = loadDeletedBuiltins(dir)

    for (const [relativePath, sourcePath] of Object.entries(builtinSkillFiles())) {
        if (deleted.has(relativePath.split("/")[0]!)) continue
        const destPath = resolve(destBase, relativePath)
        await mkdir(dirname(destPath), { recursive: true })
        await Bun.write(destPath, Bun.file(sourcePath))
    }
}

// ── 目录发现 ──

export function listSkills(dir: string): Skill[] {
    const userDir = resolve(dir, "skills")
    return existsSync(userDir) ? loadSkillsFromDir({ dir: userDir, source: "user" }).skills : []
}

export function getSkill(dir: string, name: string): Skill | undefined {
    return listSkills(dir).find((s) => s.name === name)
}

// ── CRUD ──

export interface CreateSkillInput {
    name: string
    description: string
    content: string
}

/** 写入 skills/<name>/SKILL.md；名称同时作为 frontmatter name 与目录名。 */
export async function createSkill(
    dir: string,
    input: CreateSkillInput,
): Promise<{ name: string; directory: string }> {
    const { name, description, content } = input
    if (!isValidSkillName(name)) {
        throw new Error(
            "skill name must be lowercase letters, digits and single hyphens (max 64)",
        )
    }
    const skillsDir = resolve(dir, "skills")
    await mkdir(skillsDir, { recursive: true })
    const destDir = resolve(skillsDir, name)
    if (existsSync(destDir)) throw new Error(`skill "${name}" already exists`)
    await mkdir(destDir)
    const body = content.endsWith("\n") ? content : `${content}\n`
    const markdown = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`
    await Bun.write(resolve(destDir, "SKILL.md"), markdown)
    return { name, directory: name }
}

export async function removeSkill(dir: string, name: string) {
    assertSkillDirectory(name)
    if (isBuiltinSkillDirectory(name)) {
        const deleted = loadDeletedBuiltins(dir)
        deleted.add(name)
        await saveDeletedBuiltins(dir, deleted)
    }
    const dest = resolve(dir, "skills", name)
    const { rm } = await import("fs/promises")
    await rm(dest, { recursive: true, force: true })
}

export function listDeletedBuiltinSkills(dir: string): string[] {
    return [...loadDeletedBuiltins(dir)]
        .filter((name) => isBuiltinSkillDirectory(name))
        .sort()
}

/** 清除删除记录并重新释放该内置技能的全部文件。 */
export async function restoreBuiltinSkill(dir: string, name: string): Promise<void> {
    assertSkillDirectory(name)
    const files = filesForBuiltin(name)
    if (files.length === 0) throw new Error(`"${name}" is not a builtin skill`)

    const deleted = loadDeletedBuiltins(dir)
    if (deleted.delete(name)) await saveDeletedBuiltins(dir, deleted)

    const destBase = resolve(dir, "skills")
    for (const [relativePath, sourcePath] of files) {
        const destPath = resolve(destBase, relativePath)
        await mkdir(dirname(destPath), { recursive: true })
        await Bun.write(destPath, Bun.file(sourcePath))
    }
}

// ── Install helpers ──

/** 递归复制目录，排除指定条目 */
async function copyDir(src: string, dest: string, exclude: string[]) {
    const { readdirSync, statSync } = await import("fs")
    for (const entry of readdirSync(src)) {
        if (exclude.includes(entry)) continue
        const srcPath = resolve(src, entry)
        const destPath = resolve(dest, entry)
        if (statSync(srcPath).isDirectory()) {
            await mkdir(destPath, { recursive: true })
            await copyDir(srcPath, destPath, exclude)
        } else {
            await Bun.write(destPath, Bun.file(srcPath))
        }
    }
}

/** 在目录树中找到包含 SKILL.md 的根目录（检查根 + 一层子目录） */
function findSkillRoot(baseDir: string): string | null {
    const { readdirSync, statSync, existsSync } = require("fs")
    if (existsSync(resolve(baseDir, "SKILL.md"))) return baseDir
    for (const entry of readdirSync(baseDir)) {
        const sub = resolve(baseDir, entry)
        if (statSync(sub).isDirectory() && existsSync(resolve(sub, "SKILL.md"))) {
            return sub
        }
    }
    return null
}

/** 从 zip 安装 skill */
export async function addSkillFromZip(dir: string, zipData: ArrayBuffer): Promise<{ name: string }> {
    const { mkdtemp, rm } = await import("fs/promises")
    const { tmpdir } = await import("os")
    const tmpDir = await mkdtemp(resolve(tmpdir(), "skill-"))
    try {
        const zipPath = resolve(tmpDir, "skill.zip")
        await Bun.write(zipPath, zipData)

        const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", tmpDir], { stdout: "ignore", stderr: "pipe" })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`unzip failed: ${stderr}`)
        }

        const skillRoot = findSkillRoot(tmpDir)
        if (!skillRoot) throw new Error("zip 中未找到 SKILL.md")

        const skillName = skillRoot === tmpDir ? "unnamed-skill" : skillRoot.split("/").pop()!
        const destDir = resolve(dir, "skills", skillName)
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await copyDir(skillRoot, destDir, ["skill.zip", "__MACOSX"])

        return { name: skillName }
    } finally {
        const { rm: rmTmp } = await import("fs/promises")
        await rmTmp(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}

/** 从 Git 仓库安装 skill */
export async function addSkillFromGit(dir: string, url: string): Promise<{ name: string }> {
    const repoName = url
        .replace(/\.git$/, "")
        .split("/")
        .pop()
    if (!repoName) throw new Error("无法从 URL 提取仓库名")

    const { mkdtemp, rm } = await import("fs/promises")
    const { tmpdir } = await import("os")
    const tmpDir = await mkdtemp(resolve(tmpdir(), "skill-git-"))

    try {
        const cloneDir = resolve(tmpDir, repoName)
        const proc = Bun.spawn(["git", "clone", "--depth", "1", url, cloneDir], {
            stdout: "ignore",
            stderr: "pipe",
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            const stderr = await new Response(proc.stderr).text()
            throw new Error(`git clone failed: ${stderr}`)
        }

        const skillRoot = findSkillRoot(cloneDir)
        if (!skillRoot) throw new Error("仓库中未找到 SKILL.md")

        const skillName = skillRoot === cloneDir ? repoName : skillRoot.split("/").pop()!
        const destDir = resolve(dir, "skills", skillName)
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await copyDir(skillRoot, destDir, [".git"])

        return { name: skillName }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
}
