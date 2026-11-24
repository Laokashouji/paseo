import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  InteractiveCardActionRecordSchema,
  InteractiveCardViewSchema,
  InteractiveLiveCardRecordSchema,
  type InteractiveCardActionRecord,
  type InteractiveLiveCardRecord,
} from "@getpaseo/protocol/interactive-cards";

const RegisteredInlineBlockSchema = z.object({
  key: z.string().min(1),
  view: InteractiveCardViewSchema,
  registeredAt: z.string(),
});
export type RegisteredInlineBlock = z.infer<typeof RegisteredInlineBlockSchema>;

const ValidationErrorEntrySchema = z.object({
  messageHash: z.string().min(1),
  errors: z.array(z.string()),
  createdAt: z.string(),
  reported: z.boolean(),
});
export type ValidationErrorEntry = z.infer<typeof ValidationErrorEntrySchema>;

const PersistedAgentCardsFileSchema = z.object({
  schemaVersion: z.literal(1),
  agentId: z.string().min(1),
  views: z.record(z.string(), InteractiveLiveCardRecordSchema),
  inlineBlocks: z.record(z.string(), RegisteredInlineBlockSchema),
  actions: z.record(z.string(), InteractiveCardActionRecordSchema),
  validationErrors: z.array(ValidationErrorEntrySchema),
});

export interface AgentCardsState {
  schemaVersion: 1;
  agentId: string;
  views: Record<string, InteractiveLiveCardRecord>;
  inlineBlocks: Record<string, RegisteredInlineBlock>;
  actions: Record<string, InteractiveCardActionRecord>;
  validationErrors: ValidationErrorEntry[];
}

function createEmptyAgentCardsState(agentId: string): AgentCardsState {
  return {
    schemaVersion: 1,
    agentId,
    views: {},
    inlineBlocks: {},
    actions: {},
    validationErrors: [],
  };
}

function sanitizeAgentFilename(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "agent";
}

export class InteractiveCardsStore {
  private readonly dirPath: string;
  private readonly cache = new Map<string, AgentCardsState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private dirEnsured = false;

  constructor(paseoHome: string) {
    this.dirPath = path.join(paseoHome, "interactive-cards");
  }

  private filePathFor(agentId: string): string {
    return path.join(this.dirPath, `${sanitizeAgentFilename(agentId)}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.dirPath, { recursive: true });
    this.dirEnsured = true;
  }

  async withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(agentId, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(agentId) === settled) {
        this.locks.delete(agentId);
      }
    }
  }

  async load(agentId: string): Promise<AgentCardsState> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const filePath = this.filePathFor(agentId);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = PersistedAgentCardsFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        const state: AgentCardsState = parsed.data;
        this.cache.set(agentId, state);
        return state;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== "ENOENT") {
        // Corrupt or unreadable state starts clean instead of crashing the agent session.
      }
    }

    const empty = createEmptyAgentCardsState(agentId);
    this.cache.set(agentId, empty);
    return empty;
  }

  async save(state: AgentCardsState): Promise<void> {
    this.cache.set(state.agentId, state);
    await this.ensureDir();
    const filePath = this.filePathFor(state.agentId);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      this.cache.delete(agentId);
      await rm(this.filePathFor(agentId), { force: true });
    });
  }

  /** Helper for tests to force reload from disk. */
  clearMemoryCache(): void {
    this.cache.clear();
  }
}
