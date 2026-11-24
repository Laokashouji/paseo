import crypto from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  MAIN_CHAT_MEMORY_CONTEXT_TOTAL_BUDGET_BYTES,
  MAIN_CHAT_MEMORY_DIR_NAME,
  MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
  MAIN_CHAT_MEMORY_FILES_BUDGET_BYTES,
  MAIN_CHAT_MEMORY_FILE_MAX_BYTES,
  MAIN_CHAT_MEMORY_PATH_MAX_CHARS,
  MAIN_CHAT_MEMORY_PROFILE_BUDGET_BYTES,
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  normalizeMainChatProfile,
  type MainChatMemoryFileContent,
  type MainChatMemoryFileMeta,
  type MainChatProfile,
} from "@getpaseo/protocol/main-chat";

const MAX_MEMORY_PATH_DEPTH = 5;
const MAX_MEMORY_FILES_LISTED = 200;
const WINDOWS_DRIVE_PREFIX_RE = /^[a-zA-Z]:/;
const ALLOWED_MEMORY_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function compareLexicographically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export type MainChatMemoryErrorCode =
  | "invalid_path"
  | "path_traversal"
  | "not_found"
  | "too_large"
  | "io_error";

export class MainChatMemoryError extends Error {
  readonly code: MainChatMemoryErrorCode;

  constructor(code: MainChatMemoryErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MainChatMemoryError";
    this.code = code;
  }
}

export function resolveMainChatMemoryRoot(paseoHome: string): string {
  return path.resolve(paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME, MAIN_CHAT_MEMORY_DIR_NAME);
}

/**
 * Validates and normalizes a relative memory file path strictly within the memory root.
 * Rejects absolute paths, drive letters, backslashes, `..` / `.` segments, dotfiles,
 * control characters, excessive nesting, and disallowed extensions.
 */
export function normalizeAndValidateMemoryRelativePath(rawPath: string): string {
  if (typeof rawPath !== "string") {
    throw new MainChatMemoryError("invalid_path", "记忆文件路径必须是字符串。");
  }
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new MainChatMemoryError("invalid_path", "记忆文件路径不能为空。");
  }
  if (trimmed.length > MAIN_CHAT_MEMORY_PATH_MAX_CHARS) {
    throw new MainChatMemoryError(
      "invalid_path",
      `记忆文件路径超过上限（最多 ${MAIN_CHAT_MEMORY_PATH_MAX_CHARS} 字符）。`,
    );
  }
  if (hasControlChar(trimmed)) {
    throw new MainChatMemoryError("path_traversal", "记忆文件路径包含非法控制字符。");
  }
  if (trimmed.includes("\\") || trimmed.startsWith("/") || WINDOWS_DRIVE_PREFIX_RE.test(trimmed)) {
    throw new MainChatMemoryError("path_traversal", "仅允许使用相对路径，禁止绝对路径或反斜杠。");
  }

  const segments = trimmed.split("/");
  if (segments.length > MAX_MEMORY_PATH_DEPTH) {
    throw new MainChatMemoryError(
      "invalid_path",
      `记忆文件目录层级不能超过 ${MAX_MEMORY_PATH_DEPTH} 层。`,
    );
  }

  for (const segment of segments) {
    if (!segment) {
      throw new MainChatMemoryError("invalid_path", "记忆文件路径不能包含空目录段或末尾斜杠。");
    }
    if (segment === "." || segment === ".." || segment.includes("..")) {
      throw new MainChatMemoryError(
        "path_traversal",
        "记忆文件路径禁止包含路径穿越段（.. 或 .）。",
      );
    }
    if (segment.startsWith(".")) {
      throw new MainChatMemoryError("path_traversal", "记忆文件路径禁止访问隐藏文件或隐藏目录。");
    }
    if (segment.includes(":")) {
      throw new MainChatMemoryError("path_traversal", "记忆文件路径包含非法字符。");
    }
  }

  const fileName = segments[segments.length - 1]!;
  const ext = path.extname(fileName).toLowerCase();
  if (!ext || !ALLOWED_MEMORY_EXTENSIONS.has(ext)) {
    throw new MainChatMemoryError(
      "invalid_path",
      "记忆文件仅支持 .md、.txt、.json、.yaml、.yml 扩展名。",
    );
  }

  return segments.join("/");
}

export function resolveSafeMemoryPath(
  memoryRoot: string,
  rawRelativePath: string,
): { relativePath: string; absolutePath: string; rootPath: string } {
  const rootPath = path.resolve(memoryRoot);
  const relativePath = normalizeAndValidateMemoryRelativePath(rawRelativePath);
  const absolutePath = path.resolve(rootPath, relativePath);
  const rootWithSep = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (!absolutePath.startsWith(rootWithSep) || absolutePath === rootPath) {
    throw new MainChatMemoryError("path_traversal", "目标路径超出记忆目录边界。");
  }
  return { relativePath, absolutePath, rootPath };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function assertNoSymlinkEscape(rootPath: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  let current = rootPath;
  let canonicalRoot: string | null = null;
  try {
    canonicalRoot = await realpath(rootPath);
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
  }

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new MainChatMemoryError("path_traversal", "记忆目录禁止访问或写入符号链接。");
      }
      if (canonicalRoot) {
        const canonicalCurrent = await realpath(current);
        const canonicalPrefix = canonicalRoot.endsWith(path.sep)
          ? canonicalRoot
          : `${canonicalRoot}${path.sep}`;
        if (!canonicalCurrent.startsWith(canonicalPrefix)) {
          throw new MainChatMemoryError("path_traversal", "解析后的真实路径超出记忆目录边界。");
        }
      }
    } catch (error) {
      if (error instanceof MainChatMemoryError) {
        throw error;
      }
      if (isEnoent(error)) {
        break;
      }
      throw error;
    }
  }
}

function memoryFilePriority(relativePath: string): number {
  const lower = relativePath.toLowerCase();
  if (lower === "memory.md") return 0;
  if (lower === "always.md") return 1;
  if (!lower.includes("/")) return 2;
  return 3;
}

export function compareMemoryPaths(left: string, right: string): number {
  const leftPriority = memoryFilePriority(left);
  const rightPriority = memoryFilePriority(right);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return compareLexicographically(left, right);
}

async function pruneEmptyParentDirs(rootPath: string, startDir: string): Promise<void> {
  const resolvedRoot = path.resolve(rootPath);
  let current = path.resolve(startDir);
  while (current !== resolvedRoot && current.startsWith(`${resolvedRoot}${path.sep}`)) {
    try {
      const entries = await readdir(current);
      if (entries.length > 0) break;
      await rmdir(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

export interface MainChatMemoryStore {
  readonly memoryRoot: string;
  listFiles(): Promise<MainChatMemoryFileMeta[]>;
  readFile(relativePath: string): Promise<MainChatMemoryFileContent>;
  writeFile(relativePath: string, content: string): Promise<MainChatMemoryFileMeta>;
  deleteFile(relativePath: string): Promise<{ deleted: boolean }>;
  readAllFilesForContext(): Promise<MainChatMemoryFileContent[]>;
}

export function createMainChatMemoryStore(options: { paseoHome: string }): MainChatMemoryStore {
  const memoryRoot = resolveMainChatMemoryRoot(options.paseoHome);

  async function walkDirectory(
    dirPath: string,
    relativePrefix: string,
    depth: number,
    out: MainChatMemoryFileMeta[],
  ): Promise<void> {
    if (depth > MAX_MEMORY_PATH_DEPTH || out.length >= MAX_MEMORY_FILES_LISTED) return;
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }

    entries.sort((a, b) => compareLexicographically(a.name, b.name));

    for (const entry of entries) {
      if (out.length >= MAX_MEMORY_FILES_LISTED) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink()) continue;

      const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const absPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        await walkDirectory(absPath, relPath, depth + 1, out);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_MEMORY_EXTENSIONS.has(ext)) continue;

      try {
        const info = await stat(absPath);
        if (!info.isFile()) continue;
        out.push({
          path: relPath,
          bytes: info.size,
          updatedAt: info.mtime.toISOString(),
        });
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
    }
  }

  return {
    memoryRoot,

    async listFiles(): Promise<MainChatMemoryFileMeta[]> {
      const files: MainChatMemoryFileMeta[] = [];
      await walkDirectory(memoryRoot, "", 1, files);
      files.sort((a, b) => compareMemoryPaths(a.path, b.path));
      return files;
    },

    async readFile(rawRelativePath: string): Promise<MainChatMemoryFileContent> {
      const { relativePath, absolutePath, rootPath } = resolveSafeMemoryPath(
        memoryRoot,
        rawRelativePath,
      );
      await assertNoSymlinkEscape(rootPath, relativePath);
      try {
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink()) {
          throw new MainChatMemoryError("path_traversal", "记忆目录禁止读取符号链接。");
        }
        if (!info.isFile()) {
          throw new MainChatMemoryError("not_found", `记忆文件不存在：${relativePath}`);
        }
        if (info.size > MAIN_CHAT_MEMORY_FILE_MAX_BYTES) {
          throw new MainChatMemoryError(
            "too_large",
            `记忆文件过大（${info.size} 字节，上限 ${MAIN_CHAT_MEMORY_FILE_MAX_BYTES} 字节）。`,
          );
        }
        const content = await readFile(absolutePath, "utf8");
        return {
          path: relativePath,
          content,
          bytes: Buffer.byteLength(content, "utf8"),
          updatedAt: info.mtime.toISOString(),
        };
      } catch (error) {
        if (error instanceof MainChatMemoryError) throw error;
        if (isEnoent(error)) {
          throw new MainChatMemoryError("not_found", `记忆文件不存在：${relativePath}`);
        }
        throw error;
      }
    },

    async writeFile(rawRelativePath: string, content: string): Promise<MainChatMemoryFileMeta> {
      const { relativePath, absolutePath, rootPath } = resolveSafeMemoryPath(
        memoryRoot,
        rawRelativePath,
      );
      if (typeof content !== "string") {
        throw new MainChatMemoryError("invalid_path", "记忆文件内容必须是字符串。");
      }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAIN_CHAT_MEMORY_FILE_MAX_BYTES) {
        throw new MainChatMemoryError(
          "too_large",
          `记忆文件内容超过上限（${bytes} / ${MAIN_CHAT_MEMORY_FILE_MAX_BYTES} 字节）。`,
        );
      }

      await mkdir(rootPath, { recursive: true });
      await assertNoSymlinkEscape(rootPath, relativePath);

      const parentDir = path.dirname(absolutePath);
      await mkdir(parentDir, { recursive: true });
      await assertNoSymlinkEscape(rootPath, relativePath);

      const tempPath = path.join(parentDir, `.tmp-${crypto.randomUUID()}`);
      try {
        await writeFile(tempPath, content, "utf8");
        await rename(tempPath, absolutePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }

      const info = await stat(absolutePath);
      return {
        path: relativePath,
        bytes: Buffer.byteLength(content, "utf8"),
        updatedAt: info.mtime.toISOString(),
      };
    },

    async deleteFile(rawRelativePath: string): Promise<{ deleted: boolean }> {
      const { relativePath, absolutePath, rootPath } = resolveSafeMemoryPath(
        memoryRoot,
        rawRelativePath,
      );
      await assertNoSymlinkEscape(rootPath, relativePath);
      try {
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink()) {
          throw new MainChatMemoryError("path_traversal", "记忆目录禁止删除符号链接。");
        }
        if (!info.isFile()) {
          return { deleted: false };
        }
        await unlink(absolutePath);
        await pruneEmptyParentDirs(rootPath, path.dirname(absolutePath));
        return { deleted: true };
      } catch (error) {
        if (error instanceof MainChatMemoryError) throw error;
        if (isEnoent(error)) {
          return { deleted: false };
        }
        throw error;
      }
    },

    async readAllFilesForContext(): Promise<MainChatMemoryFileContent[]> {
      const metas = await this.listFiles();
      const contents: MainChatMemoryFileContent[] = [];
      for (const meta of metas) {
        try {
          contents.push(await this.readFile(meta.path));
        } catch {
          // Skip files that disappeared or exceed limits concurrently.
        }
      }
      return contents;
    },
  };
}

/**
 * Deterministically truncates a UTF-8 string so its byte length never exceeds `maxBytes`,
 * without splitting multi-byte UTF-8 characters or UTF-16 surrogate pairs.
 */
export function truncateUtf8ToBytes(
  text: string,
  maxBytes: number,
  suffix = "\n…(已按字节预算截断)",
): { text: string; truncated: boolean; bytes: number } {
  if (maxBytes <= 0) {
    return { text: "", truncated: text.length > 0, bytes: 0 };
  }
  const fullBytes = Buffer.byteLength(text, "utf8");
  if (fullBytes <= maxBytes) {
    return { text, truncated: false, bytes: fullBytes };
  }
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const effectiveSuffix = suffixBytes < maxBytes ? suffix : "";
  const allowedContentBytes = Math.max(0, maxBytes - Buffer.byteLength(effectiveSuffix, "utf8"));

  let usedBytes = 0;
  let result = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (usedBytes + charBytes > allowedContentBytes) {
      break;
    }
    result += char;
    usedBytes += charBytes;
  }

  const finalText = `${result.trimEnd()}${effectiveSuffix}`;
  return {
    text: finalText,
    truncated: true,
    bytes: Buffer.byteLength(finalText, "utf8"),
  };
}

export interface MainChatMemoryContextBudget {
  totalMaxBytes?: number;
  profileMaxBytes?: number;
  directionNotesMaxBytes?: number;
  memoryFilesMaxBytes?: number;
}

export interface AssembleMainChatMemoryContextInput {
  profile?: Partial<MainChatProfile> | null;
  directionTitle?: string | null;
  directionNotes?: string | null;
  memoryFiles?: ReadonlyArray<{ path: string; content: string }>;
  budget?: MainChatMemoryContextBudget;
}

export interface AssembledMainChatMemoryContext {
  text: string;
  totalBytes: number;
  truncated: boolean;
  includedSections: {
    profile: boolean;
    directionNotes: boolean;
    memoryFiles: string[];
  };
  omittedMemoryFiles: string[];
}

function fitProfileSection(
  profile: MainChatProfile,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
  const hasProfile = profile.aboutMe.trim().length > 0 || profile.ownerAliases.length > 0;
  if (!hasProfile || maxBytes <= 0) return null;
  const lines: string[] = ["## 用户个人档案（About Me）"];
  if (profile.ownerAliases.length > 0) {
    lines.push(`- 称呼 / 别名：${profile.ownerAliases.join("、")}`);
  }
  if (profile.aboutMe.trim().length > 0) {
    lines.push(profile.aboutMe.trim());
  }
  const fitted = truncateUtf8ToBytes(lines.join("\n"), maxBytes);
  return fitted.text.trim().length > 0 ? { text: fitted.text, truncated: fitted.truncated } : null;
}

function fitDirectionNotesSection(
  directionTitle: string | null | undefined,
  directionNotes: string | null | undefined,
  maxBytes: number,
): { text: string; truncated: boolean } | null {
  const trimmed = directionNotes?.trim() ?? "";
  if (!trimmed || maxBytes <= 0) return null;
  const titleSuffix = directionTitle?.trim() ? `（${directionTitle.trim()}）` : "";
  const fitted = truncateUtf8ToBytes(`## 方向笔记${titleSuffix}\n${trimmed}`, maxBytes);
  return fitted.text.trim().length > 0 ? { text: fitted.text, truncated: fitted.truncated } : null;
}

function fitMemoryFilesSection(
  sortedMemoryFiles: ReadonlyArray<{ path: string; content: string }>,
  sectionBudget: number,
): {
  text: string | null;
  truncated: boolean;
  includedFiles: string[];
  omittedFiles: string[];
} {
  if (sortedMemoryFiles.length === 0 || sectionBudget <= 0) {
    return { text: null, truncated: false, includedFiles: [], omittedFiles: [] };
  }
  const header = "## 常驻记忆文件（~/.paseo/main-chat/memory/）";
  const headerBytes = Buffer.byteLength(header, "utf8");
  if (sectionBudget <= headerBytes + 16) {
    return {
      text: null,
      truncated: true,
      includedFiles: [],
      omittedFiles: sortedMemoryFiles.map((file) => file.path),
    };
  }

  let memoryBudgetLeft = sectionBudget - headerBytes;
  const blocks: string[] = [header];
  const includedFiles: string[] = [];
  const omittedFiles: string[] = [];
  let truncated = false;

  for (const file of sortedMemoryFiles) {
    const blockHeader = `\n### ${file.path}\n`;
    const blockHeaderBytes = Buffer.byteLength(blockHeader, "utf8");
    if (memoryBudgetLeft <= blockHeaderBytes + 16) {
      omittedFiles.push(file.path);
      truncated = true;
      continue;
    }
    const fittedBody = truncateUtf8ToBytes(
      file.content.trim(),
      memoryBudgetLeft - blockHeaderBytes,
    );
    if (fittedBody.truncated) truncated = true;
    const block = `${blockHeader}${fittedBody.text}`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (!fittedBody.text.trim() || blockBytes > memoryBudgetLeft) {
      omittedFiles.push(file.path);
      truncated = true;
      continue;
    }
    blocks.push(block);
    memoryBudgetLeft -= blockBytes;
    includedFiles.push(file.path);
  }

  if (omittedFiles.length > 0) {
    const omitNote = `\n（另有 ${omittedFiles.length} 个记忆文件未展开，可按需调用 memory_read 读取：${omittedFiles.slice(0, 6).join("、")}）`;
    if (Buffer.byteLength(omitNote, "utf8") <= memoryBudgetLeft) {
      blocks.push(omitNote);
    }
  }

  if (includedFiles.length === 0) {
    return { text: null, truncated, includedFiles, omittedFiles };
  }
  const fitted = truncateUtf8ToBytes(blocks.join(""), sectionBudget);
  return {
    text: fitted.text,
    truncated: truncated || fitted.truncated,
    includedFiles,
    omittedFiles,
  };
}

/**
 * Deterministically assembles personal profile, direction notes, and persistent memory files
 * under strict UTF-8 byte budgets for injection into Main Chat / leader / child prompts.
 */
export function assembleMainChatMemoryContext(
  input: AssembleMainChatMemoryContextInput,
): AssembledMainChatMemoryContext {
  const totalMaxBytes = Math.max(
    0,
    input.budget?.totalMaxBytes ?? MAIN_CHAT_MEMORY_CONTEXT_TOTAL_BUDGET_BYTES,
  );
  const clamp = (value: number) => Math.max(0, Math.min(totalMaxBytes, value));
  const profileMaxBytes = clamp(
    input.budget?.profileMaxBytes ?? MAIN_CHAT_MEMORY_PROFILE_BUDGET_BYTES,
  );
  const directionNotesMaxBytes = clamp(
    input.budget?.directionNotesMaxBytes ?? MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
  );
  const memoryFilesMaxBytes = clamp(
    input.budget?.memoryFilesMaxBytes ?? MAIN_CHAT_MEMORY_FILES_BUDGET_BYTES,
  );

  const normalizedProfile = normalizeMainChatProfile(input.profile);
  const sortedMemoryFiles = [...(input.memoryFiles ?? [])]
    .filter((entry) => entry.content.trim().length > 0)
    .sort((a, b) => compareMemoryPaths(a.path, b.path));

  const sections: string[] = [];
  let remainingTotalBytes = totalMaxBytes;
  let truncated = false;

  const availableBudget = (sectionCap: number): number => {
    const separatorReserve = sections.length > 0 ? 2 : 0;
    return Math.min(sectionCap, Math.max(0, remainingTotalBytes - separatorReserve));
  };

  const pushSection = (content: string): boolean => {
    const separatorBytes = sections.length > 0 ? 2 : 0;
    const neededBytes = Buffer.byteLength(content, "utf8") + separatorBytes;
    if (neededBytes > remainingTotalBytes) return false;
    sections.push(content);
    remainingTotalBytes -= neededBytes;
    return true;
  };

  const profileFitted = fitProfileSection(normalizedProfile, availableBudget(profileMaxBytes));
  let includedProfile = false;
  if (profileFitted) {
    if (profileFitted.truncated) truncated = true;
    includedProfile = pushSection(profileFitted.text);
  }

  const directionFitted = fitDirectionNotesSection(
    input.directionTitle,
    input.directionNotes,
    availableBudget(directionNotesMaxBytes),
  );
  let includedDirectionNotes = false;
  if (directionFitted) {
    if (directionFitted.truncated) truncated = true;
    includedDirectionNotes = pushSection(directionFitted.text);
  }

  const memoryFitted = fitMemoryFilesSection(
    sortedMemoryFiles,
    availableBudget(memoryFilesMaxBytes),
  );
  if (memoryFitted.truncated) truncated = true;
  const pushedMemory = memoryFitted.text ? pushSection(memoryFitted.text) : false;

  const text = sections.join("\n\n");
  return {
    text,
    totalBytes: Buffer.byteLength(text, "utf8"),
    truncated,
    includedSections: {
      profile: includedProfile,
      directionNotes: includedDirectionNotes,
      memoryFiles: pushedMemory ? memoryFitted.includedFiles : [],
    },
    omittedMemoryFiles: memoryFitted.omittedFiles,
  };
}
