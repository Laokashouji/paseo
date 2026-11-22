import { describe, expect, it } from "vitest";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  isTaskAskUserToolName,
  isTaskCompleteToolName,
  isTaskPlanToolName,
  isTaskReworkToolName,
} from "@getpaseo/protocol/main-chat";
import { PARENT_AGENT_ID_LABEL, PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { TFunction } from "i18next";
import { isGroupableToolCall } from "@/tool-calls/detail-level/grouping";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import type {
  Agent,
  ProjectDescriptor,
  WorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import type { StreamItem } from "@/types/stream";
import { buildMainChatTaskMentionOptions } from "./autocomplete-tasks";
import { removeTaskMentionToken, routeStoreKey, useMainChatRouteStore } from "./route-store";
import {
  isMainChatDedicatedWorkspace,
  selectMainChatDockTasks,
  selectMainChatPendingPermissions,
  selectMainChatSidebarSummary,
} from "./selectors";

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-22T10:00:00.000Z"),
    updatedAt: new Date("2026-11-22T10:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-22T10:00:00.000Z"),
    capabilities: {} as Agent["capabilities"],
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: partial.id,
    cwd: "/tmp/repo",
    workspaceId: "ws_1",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

describe("main-chat selectors & stream rules", () => {
  it("recognizes bare and MCP-prefixed main-chat inline card tool names", () => {
    expect(isTaskPlanToolName("task_plan")).toBe(true);
    expect(isTaskPlanToolName("mcp__paseo__task_plan")).toBe(true);
    expect(isTaskCompleteToolName("mcp__paseo__task_complete")).toBe(true);
    expect(isTaskReworkToolName("mcp__paseo__task_rework")).toBe(true);
    expect(isTaskAskUserToolName("task_ask_user")).toBe(true);
    expect(isTaskPlanToolName("create_agent")).toBe(false);
  });

  it("hides only the dedicated main-chat workspace from the regular project list", () => {
    const mainAgent = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const normalAgent = makeAgent({
      id: "agent_dev",
      serverId: "srv_1",
      workspaceId: "ws_repo",
    });
    const agents = new Map([
      [mainAgent.id, mainAgent],
      [normalAgent.id, normalAgent],
    ]);

    const mainWs = {
      id: "ws_main",
      workspaceDirectory: "/home/u/.paseo/main-chat",
      projectRootPath: "/home/u/.paseo/main-chat",
    } as WorkspaceDescriptor;
    const repoWs = {
      id: "ws_repo",
      workspaceDirectory: "/home/u/repo",
      projectRootPath: "/home/u/repo",
    } as WorkspaceDescriptor;

    expect(isMainChatDedicatedWorkspace(mainWs, agents)).toBe(true);
    expect(isMainChatDedicatedWorkspace(mainWs, undefined)).toBe(true);
    expect(isMainChatDedicatedWorkspace(repoWs, agents)).toBe(false);

    // Also verify sidebar workspace structure selector filters out the dedicated main-chat workspace
    const projects = new Map<string, ProjectDescriptor>([
      [
        "proj_main",
        {
          projectId: "proj_main",
          projectKey: "dir:/home/u/.paseo/main-chat",
          projectKind: "directory",
          projectDisplayName: "main-chat",
          projectCustomName: null,
          projectRootPath: "/home/u/.paseo/main-chat",
        } as unknown as ProjectDescriptor,
      ],
      [
        "proj_repo",
        {
          projectId: "proj_repo",
          projectKey: "git:/home/u/repo",
          projectKind: "git",
          projectDisplayName: "repo",
          projectCustomName: null,
          projectRootPath: "/home/u/repo",
        } as unknown as ProjectDescriptor,
      ],
    ]);
    const workspaces = new Map<string, WorkspaceDescriptor>([
      ["ws_main", { ...mainWs, projectId: "proj_main", name: "对话管理" } as WorkspaceDescriptor],
      ["ws_repo", { ...repoWs, projectId: "proj_repo", name: "repo" } as WorkspaceDescriptor],
    ]);
    const structured = selectWorkspaceStructureProjects(
      {
        sessions: {
          srv_1: { workspaces, projects, agents },
        },
      },
      ["srv_1"],
    );
    expect(structured).toHaveLength(1);
    expect(structured[0]?.projectName).toBe("repo");
  });

  it("aggregates full-fleet sidebar counts, child permissions, and managed + manual dock pills", () => {
    const mainAgent = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      title: MAIN_CHAT_DEFAULT_TITLE,
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const childWorking = makeAgent({
      id: "child_run",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      title: "排查日志",
      status: "running",
      turn: { phase: "open", turnId: "t1", startedAt: new Date(), cancellationRequestId: null },
      labels: {
        [PARENT_AGENT_ID_LABEL]: "agent_main",
        [PARENT_SERVER_ID_LABEL]: "srv_1",
        [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_1",
        [MAIN_CHAT_TASK_MODE_LABEL]: "readonly",
      },
    });
    const childNeedsYou = makeAgent({
      id: "child_perm",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      title: "修复侧栏",
      status: "idle",
      attentionReason: "permission",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "agent_main",
        [PARENT_SERVER_ID_LABEL]: "srv_1",
        [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_1",
        [MAIN_CHAT_TASK_MODE_LABEL]: "write",
      },
    });
    const childDone = makeAgent({
      id: "child_done",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      title: "补充文档",
      status: "idle",
      labels: {
        [PARENT_AGENT_ID_LABEL]: "agent_main",
        [PARENT_SERVER_ID_LABEL]: "srv_1",
      },
    });
    const manualRunning = makeAgent({
      id: "manual_run",
      serverId: "srv_1",
      workspaceId: "ws_other",
      title: "手动构建",
      status: "running",
      turn: { phase: "open", turnId: "t2", startedAt: new Date(), cancellationRequestId: null },
    });
    const manualQuiet = makeAgent({
      id: "manual_done",
      serverId: "srv_1",
      workspaceId: "ws_other",
      title: "历史空闲",
      status: "idle",
    });

    const pendingPermissions = new Map([
      [
        "child_perm:req_1",
        {
          key: "child_perm:req_1",
          agentId: "child_perm",
          request: {
            id: "req_1",
            kind: "tool",
            name: "Bash",
          } as unknown as Agent["pendingPermissions"][number],
        },
      ],
    ]);

    const state = {
      sessions: {
        srv_1: {
          client: {} as SessionStoreState["sessions"][string]["client"],
          serverInfo: { hostname: "devbox", features: { mainChat: true } },
          agents: new Map([
            [mainAgent.id, mainAgent],
            [childWorking.id, childWorking],
            [childNeedsYou.id, childNeedsYou],
            [childDone.id, childDone],
            [manualRunning.id, manualRunning],
            [manualQuiet.id, manualQuiet],
          ]),
          agentDetails: new Map(),
          pendingPermissions,
        },
      },
    } as unknown as SessionStoreState;

    const summary = selectMainChatSidebarSummary(state, "srv_1");
    expect(summary.existing?.agentId).toBe("agent_main");
    expect(summary.displayTitle).toBe("对话管理");
    expect(summary.hostLabel).toBe("devbox");
    expect(summary.needsYouCount).toBe(1);
    expect(summary.runningCount).toBe(2);
    expect(summary.totalActiveCount).toBe(5);

    const renamedSummary = selectMainChatSidebarSummary(state, "srv_1", "我的管家");
    expect(renamedSummary.displayTitle).toBe("我的管家");

    const mainPerms = selectMainChatPendingPermissions(state, "srv_1", "agent_main");
    expect(mainPerms).toHaveLength(1);
    expect(mainPerms[0]?.isChild).toBe(true);
    expect(mainPerms[0]?.sourceAgentTitle).toBe("修复侧栏");

    const regularPerms = selectMainChatPendingPermissions(state, "srv_1", "child_run");
    expect(regularPerms).toHaveLength(0);

    const dockTasks = selectMainChatDockTasks(state, "srv_1", "agent_main");
    expect(dockTasks.map((t) => t.agentId)).toEqual([
      "child_perm",
      "child_run",
      "child_done",
      "manual_run",
    ]);
    expect(dockTasks[0]?.managedByMainChat).toBe(true);
    expect(dockTasks[3]?.managedByMainChat).toBe(false);
    expect(dockTasks[0]?.bucket).toBe("needs_input");
    expect(dockTasks[1]?.bucket).toBe("running");
    expect(dockTasks[2]?.bucket).toBe("done");
    expect(dockTasks[3]?.bucket).toBe("running");
  });

  it("keeps task_plan and task_complete ungrouped and visible across turn collapse", () => {
    const planItem: StreamItem = {
      kind: "tool_call",
      id: "call_plan",
      timestamp: new Date("2026-11-22T10:00:01.000Z"),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call_plan",
          name: "mcp__paseo__task_plan",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: {}, output: {} },
        },
      },
    };
    const receiptItem: StreamItem = {
      kind: "tool_call",
      id: "call_complete",
      timestamp: new Date("2026-11-22T10:00:02.000Z"),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call_complete",
          name: "task_complete",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: {}, output: {} },
        },
      },
    };

    expect(isGroupableToolCall(planItem)).toBe(false);
    expect(isGroupableToolCall(receiptItem)).toBe(false);

    const collapsed = collapseTurns({
      tail: [
        {
          kind: "user_message",
          id: "u1",
          timestamp: new Date("2026-11-22T10:00:00.000Z"),
          text: "帮我修两个问题",
        },
        planItem,
        {
          kind: "assistant_message",
          id: "a1",
          timestamp: new Date("2026-11-22T10:00:03.000Z"),
          text: "已生成计划卡。",
        },
      ],
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
    });
    expect(collapsed.tail.some((item) => item.id === "call_plan")).toBe(true);
  });

  it("builds filtered @task autocomplete options and manages direct-route store cleanly", () => {
    const t = ((key: string) => key) as unknown as TFunction;
    const options = buildMainChatTaskMentionOptions({
      tasks: [
        {
          serverId: "srv_1",
          agentId: "child_1",
          workspaceId: "ws_1",
          title: "修复侧栏样式",
          mode: "write",
          managedByMainChat: true,
          bucket: "running",
          pendingPermissionCount: 0,
          updatedAtMs: 100,
        },
        {
          serverId: "srv_1",
          agentId: "child_2",
          workspaceId: "ws_1",
          title: "排查日志报错",
          mode: "readonly",
          managedByMainChat: true,
          bucket: "needs_input",
          pendingPermissionCount: 1,
          updatedAtMs: 200,
        },
      ],
      mention: { start: 0, end: 3, query: "侧栏" },
      t,
    });
    expect(options).toHaveLength(1);
    expect(options[0]?.targetAgentId).toBe("child_1");
    expect(options[0]?.label).toBe("@修复侧栏样式");

    expect(removeTaskMentionToken("@侧栏 帮我看看宽度", { start: 0, end: 3, query: "侧栏" })).toBe(
      "帮我看看宽度",
    );
    expect(removeTaskMentionToken("先看 @侧栏 再改一下", { start: 3, end: 6, query: "侧栏" })).toBe(
      "先看 再改一下",
    );

    useMainChatRouteStore.getState().setTarget("srv_1", "agent_main", {
      targetServerId: "srv_1",
      targetAgentId: "child_1",
      targetTitle: "修复侧栏样式",
    });
    expect(
      useMainChatRouteStore.getState().targetsByKey[routeStoreKey("srv_1", "agent_main")]
        ?.targetAgentId,
    ).toBe("child_1");
    useMainChatRouteStore.getState().clearTarget("srv_1", "agent_main");
    expect(
      useMainChatRouteStore.getState().targetsByKey[routeStoreKey("srv_1", "agent_main")],
    ).toBeUndefined();
  });
});
