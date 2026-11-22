import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface JsonlTreeRecord {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  cwd?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

function selectActiveJsonlBranch(
  records: JsonlTreeRecord[],
  legacy: boolean,
  activeBranchEntryId?: string | null,
): JsonlTreeRecord[] {
  if (legacy) {
    return records;
  }
  const byId = new Map<string, JsonlTreeRecord>();
  for (const entry of records) {
    if (typeof entry.id !== "string" || entry.parentId === undefined || byId.has(entry.id)) {
      throw new Error("Invalid session transcript tree entry");
    }
    byId.set(entry.id, entry);
  }
  const branch: JsonlTreeRecord[] = [];
  const seen = new Set<string>();
  let current: JsonlTreeRecord | undefined =
    activeBranchEntryId && byId.has(activeBranchEntryId)
      ? byId.get(activeBranchEntryId)
      : records.at(-1);
  while (current) {
    const id = current.id as string;
    if (seen.has(id)) {
      throw new Error("Cycle in session transcript ancestry");
    }
    seen.add(id);
    branch.push(current);
    if (current.parentId === null) {
      break;
    }
    if (typeof current.parentId !== "string") {
      throw new Error("Missing session transcript ancestor");
    }
    current = byId.get(current.parentId);
    if (!current) {
      throw new Error("Missing session transcript ancestor");
    }
  }
  branch.reverse();
  return branch;
}

/**
 * Forks a Pi/OMP JSONL session tree file into a standalone session file containing only the
 * active ancestry branch (optionally truncated strictly before `stopBeforeEntryId`).
 */
export async function forkJsonlTreeSessionFile(input: {
  sourceFile: string;
  stopBeforeEntryId?: string;
  activeBranchEntryId?: string | null;
  targetCwd?: string;
}): Promise<{ sessionId: string; sessionFile: string }> {
  const contents = await readFile(input.sourceFile, "utf8");
  const parsed: JsonlTreeRecord[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const item = JSON.parse(trimmed) as unknown;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Invalid session transcript line");
    }
    parsed.push(item as JsonlTreeRecord);
  }

  const header = parsed.shift();
  if (!header || header.type !== "session") {
    throw new Error("Session transcript is missing its session header");
  }

  const legacy = header.version === 1;
  let branch = selectActiveJsonlBranch(parsed, legacy, input.activeBranchEntryId);

  if (input.stopBeforeEntryId) {
    const stopIndex = branch.findIndex((entry) => entry.id === input.stopBeforeEntryId);
    if (stopIndex < 0) {
      throw new Error(`Session entry ${input.stopBeforeEntryId} was not found in active branch`);
    }
    branch = branch.slice(0, stopIndex);
  }

  const hasMessage = branch.some(
    (entry) => entry.type === "message" || entry.type === "custom_message",
  );
  if (!hasMessage) {
    throw new Error("Session has no committed messages to fork");
  }

  const sessionId = randomUUID();
  const nowIso = new Date().toISOString();
  const nextHeader: JsonlTreeRecord = {
    ...header,
    id: sessionId,
    timestamp: nowIso,
    ...(input.targetCwd?.trim() ? { cwd: input.targetCwd.trim() } : {}),
  };

  const dir = path.dirname(input.sourceFile);
  await mkdir(dir, { recursive: true });
  const timestampSlug = nowIso.replace(/[:.]/g, "-");
  const sessionFile = path.join(dir, `${timestampSlug}_${sessionId}.jsonl`);
  const serialized = `${[nextHeader, ...branch].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await writeFile(sessionFile, serialized, { encoding: "utf8", mode: 0o600 });
  return { sessionId, sessionFile };
}
