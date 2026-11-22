import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORK_MODE_LABEL,
  FORK_ROOT_AGENT_ID_LABEL,
  FORKED_FROM_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createFakeSession(input: {
  id: string;
  config: AgentSessionConfig;
  capabilities: AgentCapabilityFlags;
  history?: AgentStreamEvent[];
  onFork?: AgentSession["forkSession"];
  onSideQuestion?: AgentSession["askSideQuestion"];
}): AgentSession {
  const subscribers = new Set<(event: AgentStreamEvent) => void>();
  return {
    provider: input.config.provider,
    id: input.id,
    capabilities: input.capabilities,
    async run() {
      return { sessionId: input.id, finalText: "", timeline: [] };
    },
    async startTurn() {
      return { turnId: "turn-1" };
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    async *streamHistory() {
      for (const event of input.history ?? []) {
        yield event;
      }
    },
    async getRuntimeInfo() {
      return {
        provider: input.config.provider,
        sessionId: input.id,
        model: input.config.model ?? null,
        modeId: input.config.modeId ?? null,
        thinkingOptionId: input.config.thinkingOptionId ?? null,
      };
    },
    async getAvailableModes() {
      return [{ id: "default", label: "Default", description: "Default" }];
    },
    async getCurrentMode() {
      return input.config.modeId ?? "default";
    },
    async setMode() {},
    getPendingPermissions() {
      return [];
    },
    async respondToPermission() {},
    describePersistence(): AgentPersistenceHandle {
      return {
        provider: input.config.provider,
        sessionId: input.id,
        nativeHandle: input.id,
        metadata: { cwd: input.config.cwd },
      };
    },
    async interrupt() {},
    async close() {},
    forkSession: input.onFork,
    askSideQuestion: input.onSideQuestion,
  };
}

describe("AgentManager native forkAgent and askSideQuestion", () => {
  it("natively forks a session, sets lineage labels, hydrates provider history, and forwards /btw without polluting timeline", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-native-fork-btw-"));
    tempDirs.push(dir);
    const storage = new AgentStorage(path.join(dir, "agents.json"), createTestLogger());

    const forkSessionSpy = vi.fn<NonNullable<AgentSession["forkSession"]>>(async (forkInput) => ({
      provider: "claude",
      sessionId: "claude-forked-session",
      nativeHandle: "claude-forked-session",
      metadata: { cwd: forkInput.targetCwd ?? dir },
    }));
    const askSideQuestionSpy = vi.fn<NonNullable<AgentSession["askSideQuestion"]>>(
      async (sideInput) => ({
        response: `Cached answer for: ${sideInput.question}`,
        synthetic: false,
        model: "claude-opus-4-6",
      }),
    );

    const caps: AgentCapabilityFlags = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
      supportsNativeFork: true,
      supportsSideQuestion: true,
    };

    const resumedHistory: AgentStreamEvent[] = [
      {
        type: "timeline",
        provider: "claude",
        item: { type: "user_message", messageId: "u-1", text: "Read main.ts" },
      },
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "call-1",
          name: "Read",
          status: "completed",
          detail: { type: "read", filePath: "main.ts", content: "full lossless file content" },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", messageId: "a-1", text: "Done reading." },
      },
    ];

    const client: AgentClient = {
      provider: "claude",
      capabilities: caps,
      async createSession(config) {
        return createFakeSession({
          id: "claude-root-session",
          config,
          capabilities: caps,
          onFork: forkSessionSpy,
          onSideQuestion: askSideQuestionSpy,
        });
      },
      async resumeSession(handle, overrides) {
        return createFakeSession({
          id: handle.sessionId,
          config: {
            provider: "claude",
            cwd: overrides?.cwd ?? dir,
            model: overrides?.model,
            modeId: overrides?.modeId,
            title: overrides?.title,
          },
          capabilities: caps,
          history: resumedHistory,
          onFork: forkSessionSpy,
          onSideQuestion: askSideQuestionSpy,
        });
      },
      async fetchCatalog() {
        return { models: [], modes: [] };
      },
      async isAvailable() {
        return true;
      },
    };

    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { claude: client },
      registry: storage,
    });

    const source = await manager.createAgent(
      {
        provider: "claude",
        cwd: dir,
        model: "claude-opus-4-6",
        modeId: "default",
        title: "Root Task",
      },
      undefined,
      { workspaceId: "ws-1" },
    );

    const forked = await manager.forkAgent({
      sourceAgentId: source.id,
      workspaceId: "ws-1",
      title: "方案 B",
    });

    expect(forkSessionSpy).toHaveBeenCalledWith({
      targetCwd: dir,
      title: "方案 B",
    });
    expect(forked.id).not.toBe(source.id);
    expect(forked.workspaceId).toBe("ws-1");
    expect(forked.labels).toMatchObject({
      [FORKED_FROM_AGENT_ID_LABEL]: source.id,
      [FORK_ROOT_AGENT_ID_LABEL]: source.id,
      [FORK_MODE_LABEL]: "native",
    });

    const forkedTimeline = manager.fetchTimeline(forked.id, { direction: "tail", limit: 0 });
    expect(forkedTimeline.rows.map((row) => row.item.type)).toEqual([
      "user_message",
      "tool_call",
      "assistant_message",
    ]);

    const timelineBeforeBtw = forkedTimeline.rows.length;
    const sideAnswer = await manager.askSideQuestion(forked.id, {
      question: "What was inside main.ts?",
      history: [{ question: "Earlier?", response: "Yes." }],
    });
    expect(askSideQuestionSpy).toHaveBeenCalledWith({
      question: "What was inside main.ts?",
      history: [{ question: "Earlier?", response: "Yes." }],
    });
    expect(sideAnswer).toEqual({
      response: "Cached answer for: What was inside main.ts?",
      synthetic: false,
      model: "claude-opus-4-6",
    });
    const timelineAfterBtw = manager.fetchTimeline(forked.id, { direction: "tail", limit: 0 });
    expect(timelineAfterBtw.rows.length).toBe(timelineBeforeBtw);
  });

  it("rejects askSideQuestion cleanly when provider does not support native /btw", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paseo-btw-unsupported-"));
    tempDirs.push(dir);
    const caps: AgentCapabilityFlags = {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    };
    const client: AgentClient = {
      provider: "codex",
      capabilities: caps,
      async createSession(config) {
        return createFakeSession({ id: "codex-1", config, capabilities: caps });
      },
      async resumeSession(handle, overrides) {
        return createFakeSession({
          id: handle.sessionId,
          config: { provider: "codex", cwd: overrides?.cwd ?? dir },
          capabilities: caps,
        });
      },
      async fetchCatalog() {
        return { models: [], modes: [] };
      },
      async isAvailable() {
        return true;
      },
    };
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: { codex: client },
    });
    const agent = await manager.createAgent({ provider: "codex", cwd: dir }, undefined, {
      workspaceId: "ws-1",
    });
    await expect(
      manager.askSideQuestion(agent.id, { question: "Quick check" }),
    ).rejects.toThrow("Provider 'codex' does not support native /btw side questions");
  });
});
