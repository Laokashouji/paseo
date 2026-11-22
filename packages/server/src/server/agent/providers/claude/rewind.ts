import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  forkSession as claudeForkSession,
  type Query,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options: {
      upToMessageId?: string;
      transcriptPath: string;
      targetProjectFolder?: string;
      sourceCwd?: string;
      targetCwd?: string;
      title?: string;
    },
  ): Promise<{ sessionId: string }>;
}

// On its own, the SDK looks for the session under the daemon's CLAUDE_CONFIG_DIR, while a
// provider can point Claude Code at another one. Forking through a store rooted at the
// transcript's folder reads the session where Claude Code wrote it and writes the fork beside it
// (or into the target project folder when forking across working directories).
export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: (sessionId, options) =>
    claudeForkSession(sessionId, {
      ...(options.upToMessageId ? { upToMessageId: options.upToMessageId } : {}),
      ...(options.title ? { title: options.title } : {}),
      sessionStore: projectFolderSessionStore(path.dirname(options.transcriptPath), {
        targetProjectFolder: options.targetProjectFolder,
        sourceCwd: options.sourceCwd,
        targetCwd: options.targetCwd,
      }),
    }),
};

function projectFolderSessionStore(
  sourceProjectFolder: string,
  options?: {
    targetProjectFolder?: string;
    sourceCwd?: string;
    targetCwd?: string;
  },
): SessionStore {
  const destProjectFolder = options?.targetProjectFolder ?? sourceProjectFolder;
  const sourceCwd = options?.sourceCwd;
  const targetCwd = options?.targetCwd;
  const shouldRelocateCwd = Boolean(sourceCwd && targetCwd && sourceCwd !== targetCwd);
  const sourceTranscriptPath = (sessionId: string) =>
    path.join(sourceProjectFolder, `${sessionId}.jsonl`);
  const destTranscriptPath = (sessionId: string) =>
    path.join(destProjectFolder, `${sessionId}.jsonl`);
  return {
    async load({ sessionId }) {
      let text: string;
      try {
        text = await readFile(sourceTranscriptPath(sessionId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return parseTranscriptEntries(text);
    },
    async append({ sessionId }, entries) {
      await mkdir(destProjectFolder, { recursive: true });
      const prepared = shouldRelocateCwd
        ? entries.map((entry) =>
            (entry as { cwd?: unknown }).cwd === sourceCwd ? { ...entry, cwd: targetCwd } : entry,
          )
        : entries;
      const lines = prepared.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      await appendFile(destTranscriptPath(sessionId), lines, "utf8");
    },
  };
}

function parseTranscriptEntries(text: string): SessionStoreEntry[] {
  const entries: SessionStoreEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip a line that is not JSON, as the SDK's own transcript reader does.
      continue;
    }
    if (isSessionStoreEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

function isSessionStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * The entry a message steered into a running turn follows. Claude Code gives such a message no
 * entry of its own: it records a queued_command attachment, under the uuid Paseo minted for the
 * message, hung off the entry it was read after. Forking at that entry drops the message and
 * everything after it. Null when the transcript holds no such attachment.
 */
export async function findSteeredMessageParent(
  transcriptPath: string,
  messageId: string,
): Promise<string | null> {
  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.includes(messageId) || !line.includes('"queued_command"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = entry as {
        type?: unknown;
        parentUuid?: unknown;
        attachment?: { type?: unknown; source_uuid?: unknown };
      };
      if (
        record.type === "attachment" &&
        record.attachment?.type === "queued_command" &&
        record.attachment.source_uuid === messageId &&
        typeof record.parentUuid === "string"
      ) {
        return record.parentUuid;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

export async function forkClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  transcriptPath: string | null;
  upToMessageId?: string;
  targetProjectFolder?: string;
  sourceCwd?: string;
  targetCwd?: string;
  title?: string;
}): Promise<{ sessionId: string }> {
  if (!input.sessionId || !input.transcriptPath) {
    throw new Error("Claude session is not ready to fork");
  }
  return input.sdk.forkSession(input.sessionId, {
    ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
    transcriptPath: input.transcriptPath,
    ...(input.targetProjectFolder ? { targetProjectFolder: input.targetProjectFolder } : {}),
    ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
    ...(input.targetCwd ? { targetCwd: input.targetCwd } : {}),
    ...(input.title ? { title: input.title } : {}),
  });
}

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  if (!input.sessionId || !input.transcriptPath) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
    transcriptPath: input.transcriptPath,
  });
  await input.setSessionId(fork.sessionId);
}

export async function revertClaudeFiles(input: {
  query: Query;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<void> {
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const result = await input.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  }
}

export async function revertClaudeConversationAndFiles(input: {
  sdk: ClaudeRewindSdk;
  query: Query;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
