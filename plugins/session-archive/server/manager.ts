import {
  defineAgentTool,
  type AgentToolDefinition,
  type PluginHandlerContext,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ArchiveCompletedEvent, ArchiveState } from "../shared/contracts.js";

export type PaseoApi = PluginHandlerContext["paseo"];

export const ARCHIVE_FINISH_TOOL_PROMPT =
  "仅当收到归档清理指令且确认本对话工程残留已安全处理、无未提交或未合并风险时，调用 session_finish_archive 完成归档。";

interface SessionArchiveEntry {
  state: ArchiveState;
  workspaceId: string | null;
  queuedCommand: string | null;
  autoArchiveAfterCleanup: boolean;
  summary: string | null;
}

export class SessionArchiveManager {
  private readonly entries = new Map<string, SessionArchiveEntry>();
  private readonly stateListeners = new Map<string, Set<(state: ArchiveState) => void>>();
  private readonly completedListeners = new Set<(event: ArchiveCompletedEvent) => void>();

  getState(agentId: string): ArchiveState {
    return this.entries.get(agentId)?.state ?? "idle";
  }

  subscribeState(agentId: string, listener: (state: ArchiveState) => void): () => void {
    let set = this.stateListeners.get(agentId);
    if (!set) {
      set = new Set();
      this.stateListeners.set(agentId, set);
    }
    set.add(listener);
    return () => {
      const current = this.stateListeners.get(agentId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.stateListeners.delete(agentId);
    };
  }

  subscribeCompleted(listener: (event: ArchiveCompletedEvent) => void): () => void {
    this.completedListeners.add(listener);
    return () => {
      this.completedListeners.delete(listener);
    };
  }

  dispose(): void {
    this.entries.clear();
    this.stateListeners.clear();
    this.completedListeners.clear();
  }

  private setEntry(agentId: string, entry: SessionArchiveEntry | null): void {
    const previousState = this.getState(agentId);
    if (entry === null) {
      this.entries.delete(agentId);
    } else {
      this.entries.set(agentId, entry);
    }
    const nextState = this.getState(agentId);
    if (previousState !== nextState) {
      const listeners = this.stateListeners.get(agentId);
      if (listeners) {
        for (const listener of listeners) {
          listener(nextState);
        }
      }
    }
  }

  private emitCompleted(event: ArchiveCompletedEvent): void {
    for (const listener of this.completedListeners) {
      listener(event);
    }
  }

  createFinishArchiveTool(): AgentToolDefinition {
    return defineAgentTool({
      name: "session_finish_archive",
      title: "确认对话归档清理完成",
      description:
        "仅在收到归档清理指令，且确认本对话残留的 git worktree、临时分支、临时文件与临时终端已安全处理、无未提交或未合并风险时调用。调用后本轮正常输出简短汇报，本轮结束时系统将自动归档并关闭该对话。",
      input: z.object({
        summary: z.string().trim().max(240).optional().describe("可选：本次清理结果的简短摘要"),
      }),
      execute: async (input, context) => {
        const agentId = context.agent.id;
        const existing = this.entries.get(agentId);
        const autoArchive = existing?.autoArchiveAfterCleanup ?? true;
        const summary = input.summary?.trim() || null;

        if (!autoArchive) {
          this.setEntry(agentId, null);
          return {
            text: "已记录清理摘要（当前未开启自动归档，请直接向用户简短汇报）。",
            structuredContent: { willAutoArchive: false, summary },
          };
        }

        this.setEntry(agentId, {
          state: "pending_archive",
          workspaceId: existing?.workspaceId ?? context.agent.workspaceId ?? null,
          queuedCommand: null,
          autoArchiveAfterCleanup: true,
          summary,
        });
        return {
          text: "已标记本轮结束后自动归档并关闭当前对话，请输出简短清理汇报。",
          structuredContent: { willAutoArchive: true, summary },
        };
      },
    });
  }

  async trigger(
    input: {
      agentId: string;
      workspaceId?: string | null;
      command?: string;
      autoArchiveAfterCleanup?: boolean;
      cancelQueue?: boolean;
    },
    paseo: PaseoApi,
  ): Promise<{ state: ArchiveState; status: "sent" | "queued" | "canceled" }> {
    const existing = this.entries.get(input.agentId);

    if (input.cancelQueue) {
      if (existing?.state === "queued") {
        this.setEntry(input.agentId, null);
      }
      return { state: this.getState(input.agentId), status: "canceled" };
    }

    if (existing?.state === "running" || existing?.state === "pending_archive") {
      return { state: existing.state, status: "sent" };
    }

    const command = input.command?.trim() ?? "";
    if (!command) {
      throw new Error("归档命令为空，请先在「设置 → 对话」中配置归档命令");
    }

    const handle = paseo.agents.ref(input.agentId);
    const refreshed = await handle.refresh().catch(() => null);
    if (refreshed?.agent.archivedAt) {
      throw new Error("当前对话已归档");
    }

    const workspaceId = input.workspaceId ?? refreshed?.agent.workspaceId ?? null;
    const autoArchiveAfterCleanup = input.autoArchiveAfterCleanup ?? true;

    if (refreshed?.agent.status === "running") {
      this.setEntry(input.agentId, {
        state: "queued",
        workspaceId,
        queuedCommand: command,
        autoArchiveAfterCleanup,
        summary: null,
      });
      return { state: "queued", status: "queued" };
    }

    await handle.send(command);
    this.setEntry(input.agentId, {
      state: "running",
      workspaceId,
      queuedCommand: null,
      autoArchiveAfterCleanup,
      summary: null,
    });
    return { state: "running", status: "sent" };
  }

  async onTurnAfter(
    input: {
      agentId: string;
      workspaceId: string | null;
      outcomeKind: "completed" | "failed" | "canceled";
    },
    paseo: PaseoApi,
  ): Promise<{ archived: boolean }> {
    const entry = this.entries.get(input.agentId);
    if (!entry) return { archived: false };

    if (entry.state === "pending_archive") {
      return this.completePendingArchive(input, entry, paseo);
    }

    if (entry.state === "running") {
      this.setEntry(input.agentId, null);
      return { archived: false };
    }

    if (entry.state === "queued" && input.outcomeKind === "completed") {
      await this.dispatchQueuedArchive(input.agentId, entry, paseo);
    }

    return { archived: false };
  }

  onArchiveAfter(agentId: string): void {
    this.setEntry(agentId, null);
  }

  private async completePendingArchive(
    input: {
      agentId: string;
      workspaceId: string | null;
      outcomeKind: "completed" | "failed" | "canceled";
    },
    entry: SessionArchiveEntry,
    paseo: PaseoApi,
  ): Promise<{ archived: boolean }> {
    if (input.outcomeKind !== "completed" || !entry.autoArchiveAfterCleanup) {
      this.setEntry(input.agentId, null);
      return { archived: false };
    }

    try {
      const result = await paseo.agents.ref(input.agentId).archive();
      const archivedAt = result?.archivedAt || new Date().toISOString();
      this.setEntry(input.agentId, null);
      this.emitCompleted({
        agentId: input.agentId,
        workspaceId: entry.workspaceId ?? input.workspaceId ?? null,
        archivedAt,
        summary: entry.summary,
      });
      return { archived: true };
    } catch {
      this.setEntry(input.agentId, null);
      return { archived: false };
    }
  }

  private async dispatchQueuedArchive(
    agentId: string,
    entry: SessionArchiveEntry,
    paseo: PaseoApi,
  ): Promise<void> {
    const command = entry.queuedCommand?.trim();
    if (!command) {
      this.setEntry(agentId, null);
      return;
    }

    const handle = paseo.agents.ref(agentId);
    const latest = await handle.refresh().catch(() => null);
    if (
      latest &&
      (latest.agent.status !== "idle" ||
        latest.agent.pendingPermissions.length > 0 ||
        latest.agent.lastError)
    ) {
      return;
    }

    await handle.send(command);
    this.setEntry(agentId, {
      ...entry,
      state: "running",
      queuedCommand: null,
    });
  }
}
