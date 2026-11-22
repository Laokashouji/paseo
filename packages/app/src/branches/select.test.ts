import { describe, expect, it } from "vitest";
import { forkLineageLabels } from "@getpaseo/protocol/agent-labels";
import { selectBranchesForAgent } from "./select";
import { buildBranchPillPresentation } from "./track-presentation";
import type { Agent, useSessionStore } from "@/stores/session-store";

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

function createAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  const now = new Date("2026-11-22T00:00:00.000Z");
  return {
    serverId: "server-1",
    id,
    provider: "claude",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
      supportsNativeFork: true,
    },
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: undefined,
    title: `Title ${id}`,
    cwd: "/repo",
    workspaceId: "ws-1",
    model: "claude-sonnet",
    thinkingOptionId: null,
    options: {},
    parentAgentId: null,
    labels: {},
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

function makeState(agents: Agent[]): SessionStoreSnapshot {
  return {
    sessions: {
      "server-1": {
        agents: new Map(agents.map((agent) => [agent.id, agent])),
        agentDetails: new Map(),
      },
    },
  } as unknown as SessionStoreSnapshot;
}

describe("selectBranchesForAgent", () => {
  it("returns empty when a conversation has no branches", () => {
    const state = makeState([createAgent("root")]);
    expect(selectBranchesForAgent(state, { serverId: "server-1", agentId: "root" }, new Set())).toEqual(
      [],
    );
  });

  it("orders root, branches, and nested forks in DFS tree order with depths", () => {
    const root = createAgent("root", { createdAt: new Date("2026-11-22T00:00:00Z") });
    const branchA = createAgent("branch-a", {
      createdAt: new Date("2026-11-22T00:01:00Z"),
      labels: forkLineageLabels({ sourceAgentId: "root", rootAgentId: "root", mode: "native" }),
    });
    const branchB = createAgent("branch-b", {
      createdAt: new Date("2026-11-22T00:02:00Z"),
      labels: forkLineageLabels({ sourceAgentId: "root", rootAgentId: "root", mode: "native" }),
    });
    const branchA1 = createAgent("branch-a-1", {
      createdAt: new Date("2026-11-22T00:03:00Z"),
      labels: forkLineageLabels({ sourceAgentId: "branch-a", rootAgentId: "root", mode: "native" }),
    });
    const unrelated = createAgent("other", { createdAt: new Date("2026-11-22T00:04:00Z") });

    const rows = selectBranchesForAgent(
      makeState([root, branchB, branchA1, branchA, unrelated]),
      { serverId: "server-1", agentId: "branch-a-1" },
      new Set(),
    );

    expect(
      rows.map((row) => ({
        id: row.id,
        depth: row.depth,
        isRoot: row.isRoot,
        isCurrent: row.isCurrent,
      })),
    ).toEqual([
      { id: "root", depth: 0, isRoot: true, isCurrent: false },
      { id: "branch-a", depth: 1, isRoot: false, isCurrent: false },
      { id: "branch-a-1", depth: 2, isRoot: false, isCurrent: true },
      { id: "branch-b", depth: 1, isRoot: false, isCurrent: false },
    ]);
  });

  it("excludes archived branches and re-parents orphaned descendants under root", () => {
    const root = createAgent("root", { createdAt: new Date("2026-11-22T00:00:00Z") });
    const archivedMiddle = createAgent("mid", {
      createdAt: new Date("2026-11-22T00:01:00Z"),
      archivedAt: new Date("2026-11-22T00:02:00Z"),
      labels: forkLineageLabels({ sourceAgentId: "root", rootAgentId: "root", mode: "native" }),
    });
    const leaf = createAgent("leaf", {
      createdAt: new Date("2026-11-22T00:03:00Z"),
      labels: forkLineageLabels({ sourceAgentId: "mid", rootAgentId: "root", mode: "native" }),
    });

    const rows = selectBranchesForAgent(
      makeState([root, archivedMiddle, leaf]),
      { serverId: "server-1", agentId: "root" },
      new Set(),
    );

    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ["root", 0],
      ["leaf", 1],
    ]);
  });

  it("includes running/failed sibling status segments on the branch pill", () => {
    const root = createAgent("root");
    const runningSibling = createAgent("branch-run", {
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn-1",
        startedAt: new Date("2026-11-22T00:00:00Z"),
        cancellationRequestId: null,
      },
      labels: forkLineageLabels({ sourceAgentId: "root", rootAgentId: "root", mode: "native" }),
    });
    const rows = selectBranchesForAgent(
      makeState([root, runningSibling]),
      { serverId: "server-1", agentId: "root" },
      new Set(),
    );
    const t = ((key: string, opts?: Record<string, unknown>) =>
      `${key}${opts?.count !== undefined ? `:${opts.count}` : ""}`) as unknown as Parameters<
      typeof buildBranchPillPresentation
    >[0];
    const pill = buildBranchPillPresentation(t, rows);
    expect(pill.segments).toEqual([
      { bucket: null, text: "branches.pillLabelMany:2" },
      { bucket: "running", text: "subagents.pillLabelWorking:1" },
    ]);
  });
});
