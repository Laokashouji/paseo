import { isMainChatConversationAgent } from "@getpaseo/protocol/main-chat";
import { MAIN_CHAT_ROLE_LABEL, MAIN_CHAT_ROLE_VALUE } from "@getpaseo/protocol/main-chat";
import { describe, expect, it } from "vitest";
import {
  resolveNavigateToAgent,
  type AgentNavTarget,
  type NavigateToAgentDeps,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToWorkspaceInput {}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  mainChatNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const mainChatNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  return {
    hostNavigations,
    mainChatNavigations,
    tabNavigations,
    deps: {
      readAgentNavTarget: () => target,
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToMainChat: (route) => {
        mainChatNavigations.push({ route });
      },
      navigateToWorkspace: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("carries a request for a tab to the workspace navigation", () => {
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: WORKSPACE_ID });

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID, asTab: true }, deps);

    expect(tabNavigations[0]).toMatchObject({ asTab: true });
  });

  it("opens the workspace tab carried by the agent's workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      deps,
    );

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: true,
      },
    ]);
  });

  it("uses the input workspaceId only when the store has no record", () => {
    const readTargets: { serverId: string; agentId: string }[] = [];
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: null });
    deps.readAgentNavTarget = (input) => {
      readTargets.push(input);
      return { agentWorkspaceId: null };
    };

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
      deps,
    );

    expect(readTargets).toEqual([{ serverId: SERVER_ID, agentId: AGENT_ID }]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: undefined,
      },
    ]);
  });

  it("prefers the current agent workspace over a stale input workspace", () => {
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: "current" });
    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: "stale" }, deps);
    expect(tabNavigations[0]?.workspaceId).toBe("current");
  });

  it("falls back to the host agent route when the agent has no workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });

  it("redirects main-chat agents to /main instead of opening a regular workspace", () => {
    const { deps, hostNavigations, mainChatNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: "ws-main",
      isMainChatAgent: true,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "agent-main" }, deps);

    expect(route).toBe("/main?serverId=server-1");
    expect(mainChatNavigations).toEqual([{ route: "/main?serverId=server-1" }]);
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([]);
  });

  it("keeps regular plan tasks in their workspace with normal conversation actions", () => {
    const labels = {
      "paseo.main-chat.conversation-id": "direction-1",
      "paseo.main-chat.task-id": "task-1",
    };
    const { deps, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
      labels,
    });
    expect(isMainChatConversationAgent({ labels })).toBe(false);
    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID }, deps);
    expect(tabNavigations[0]?.target).toEqual({ kind: "agent", agentId: AGENT_ID });
  });

  it.each(["side", "leader"])(
    "opens a managed %s conversation from cached or fetched labels",
    (kind) => {
      const labels = {
        "paseo.main-chat.conversation-kind": kind,
        "paseo.main-chat.conversation-id": "direction-1",
      };
      expect(isMainChatConversationAgent({ labels })).toBe(true);
      for (const cached of [true, false]) {
        const { deps, mainChatNavigations } = createFakeNavigators({
          agentWorkspaceId: WORKSPACE_ID,
          isMainChatWorkspace: true,
          labels: cached ? labels : undefined,
        });
        const route = resolveNavigateToAgent(
          { serverId: SERVER_ID, agentId: AGENT_ID, labels: cached ? undefined : labels },
          deps,
        );
        expect(route).toContain("/main/c/direction-1");
        expect(mainChatNavigations).toEqual([{ route }]);
      }
    },
  );

  it("redirects agents in the dedicated main-chat workspace or with main role labels to /main", () => {
    const byWorkspace = createFakeNavigators({
      agentWorkspaceId: "ws-main",
      isMainChatWorkspace: true,
    });
    expect(
      resolveNavigateToAgent(
        { serverId: SERVER_ID, agentId: "agent-in-main-ws" },
        byWorkspace.deps,
      ),
    ).toBe("/main?serverId=server-1");
    expect(byWorkspace.tabNavigations).toEqual([]);

    const byLabels = createFakeNavigators({ agentWorkspaceId: null });
    expect(
      resolveNavigateToAgent(
        {
          serverId: SERVER_ID,
          agentId: "agent-main-cold",
          labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
        },
        byLabels.deps,
      ),
    ).toBe("/main?serverId=server-1");
    expect(byLabels.mainChatNavigations).toEqual([{ route: "/main?serverId=server-1" }]);
    expect(byLabels.tabNavigations).toEqual([]);
  });
});
