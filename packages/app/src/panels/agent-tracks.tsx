import type { AgentAddress } from "@getpaseo/protocol/addresses";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  isMainChatAgent,
} from "@getpaseo/protocol/main-chat";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { BackgroundWorkTrack, createHostBackgroundWorkModel } from "@/background-work";
import { BranchesTrack, useBranchesForAgent } from "@/branches";
import { SideQuestionPill } from "@/side-questions";
import type { ToastApi } from "@/components/toast-host";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useForkAgent } from "@/hooks/use-fork-agent";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { PluginComposerPills } from "@/plugins";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  useArchiveFinishedSubagents,
  useArchiveSubagent,
  useDetachSubagent,
  useSubagentSheetTab,
  useSubagentsForParent,
} from "@/subagents";
import { ParentAgentPill } from "@/subagents/parent";
import { SubagentsTrack } from "@/subagents/track";
import { useOpenMainChatTaskTarget } from "@/main-chat/open-task-target";
import { useMainChatShellContext } from "@/main-chat/shell-context";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";

/**
 * The pane's ambient context — workspace changes, subagents, and tasks — as a row of pills above
 * the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  agentId,
  parentAgentId,
  toast,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  parentAgentId: string | null;
  toast?: ToastApi;
}): ReactElement {
  const subagentRows = useSubagentsForParent({ serverId, parentAgentId: agentId });
  const branchRows = useBranchesForAgent({ serverId, agentId });
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const forkAgent = useForkAgent({ serverId, toast });
  const tasks = useSessionStore((state): TodoEntry[] | undefined =>
    state.sessions[serverId]?.agentTasks.get(agentId),
  );
  const archiveFinishedSubagents = useArchiveFinishedSubagents({
    serverId,
    parentAgentId: agentId,
    rows: subagentRows,
  });
  const { tabId } = usePaneContext();
  const backgroundWorkCount = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.backgroundWork?.count ?? 0;
  });
  // Main Chat and its direction/side conversations unify dispatched subagents inside the
  // five-state `MainChatActionBar`, so hiding the generic `SubagentsTrack` avoids stacking two
  // competing task strips above the composer while child agents in TaskPanelDrawer keep theirs.
  const isMainChatConversationAgent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (!agent) return false;
    return (
      isMainChatAgent(agent) || typeof agent.labels[MAIN_CHAT_CONVERSATION_ID_LABEL] === "string"
    );
  });
  const backgroundModel = useMemo(
    () => createHostBackgroundWorkModel(serverId, agentId),
    [serverId, agentId],
  );
  const isCompact = useIsCompactFormFactor();
  const mainChatShell = useMainChatShellContext();
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent();
  const detachSubagent = useDetachSubagent();
  const openSubagentTarget = useCallback(
    (target: WorkspaceTabTarget) => {
      openPreferredWorkspaceTarget({
        workspaceKey,
        target,
        source: "subagents",
        preferences: openInSidePane,
        parentTabId: tabId,
      });
    },
    [openInSidePane, tabId, workspaceKey],
  );
  const handleOpenSubagent = useCallback(
    ({ serverId: targetServerId, agentId: subagentId }: AgentAddress) => {
      if (mainChatShell.inMainChatShell) {
        openMainChatTaskTarget({ serverId: targetServerId, agentId: subagentId });
        return;
      }
      const session = useSessionStore.getState().sessions[targetServerId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      // A subagent in another workspace lives in that workspace's tabs.
      if (
        targetServerId !== serverId ||
        (agent?.workspaceId && agent.workspaceId !== workspaceId)
      ) {
        navigateToAgent({ serverId: targetServerId, agentId: subagentId });
        return;
      }
      openSubagentTarget({ kind: "agent", agentId: subagentId });
    },
    [
      mainChatShell.inMainChatShell,
      openMainChatTaskTarget,
      openSubagentTarget,
      serverId,
      workspaceId,
    ],
  );
  const handleOpenProviderSubagent = useCallback(
    (ownerAgentId: string, subagentId: string) => {
      const target: WorkspaceTabTarget = {
        kind: "provider_subagent",
        parentAgentId: ownerAgentId,
        subagentId,
      };
      if (mainChatShell.inMainChatShell && workspaceId) {
        navigateToWorkspace({ serverId, workspaceId, target });
        return;
      }
      openSubagentTarget(target);
    },
    [mainChatShell.inMainChatShell, openSubagentTarget, serverId, workspaceId],
  );
  const sheetTabFor = useSubagentSheetTab(
    mainChatShell.inMainChatShell ? null : workspaceKey,
    tabId,
  );
  const handleOpenBranch = useCallback(
    ({ serverId: targetServerId, agentId: branchAgentId }: AgentAddress) => {
      const session = useSessionStore.getState().sessions[targetServerId];
      const agent = session?.agents.get(branchAgentId) ?? session?.agentDetails.get(branchAgentId);
      if (
        targetServerId !== serverId ||
        (agent?.workspaceId && agent.workspaceId !== workspaceId)
      ) {
        navigateToAgent({ serverId: targetServerId, agentId: branchAgentId });
        return;
      }
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "agent", agentId: branchAgentId },
      });
    },
    [serverId, workspaceId],
  );
  const handleCreateBranch = useCallback(() => {
    if (isCreatingBranch) return;
    const session = useSessionStore.getState().sessions[serverId];
    const currentAgent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (!currentAgent) return;
    setIsCreatingBranch(true);
    void forkAgent({
      agentId,
      agent: currentAgent,
      workspaceId,
      target: "tab",
    }).finally(() => {
      setIsCreatingBranch(false);
    });
  }, [agentId, forkAgent, isCreatingBranch, serverId, workspaceId]);
  const handleOpenChanges = useCallback(() => {
    if (!workspaceKey) {
      return;
    }
    openComposerChanges({
      isCompact,
      workspaceKey,
      preferences: openInSidePane,
    });
  }, [isCompact, openInSidePane, workspaceKey]);

  return (
    <ComposerTrackBar>
      <BackgroundWorkTrack model={backgroundModel} count={backgroundWorkCount} />
      {parentAgentId ? <ParentAgentPill serverId={serverId} parentAgentId={parentAgentId} /> : null}
      <AgentTaskList tasks={tasks} />
      <SideQuestionPill serverId={serverId} agentId={agentId} />
      <BranchesTrack
        serverId={serverId}
        workspaceId={workspaceId}
        rows={branchRows}
        onOpenBranch={handleOpenBranch}
        onCreateBranch={handleCreateBranch}
        isCreatingBranch={isCreatingBranch}
        onArchiveBranch={archiveSubagent}
      />
      {!isMainChatConversationAgent ? (
        <SubagentsTrack
          serverId={serverId}
          rows={subagentRows}
          onOpenSubagent={handleOpenSubagent}
          onOpenProviderSubagent={handleOpenProviderSubagent}
          sheetTabFor={sheetTabFor}
          onArchiveSubagent={archiveSubagent}
          onArchiveFinished={archiveFinishedSubagents.archiveFinished}
          archiveFinishedStatus={archiveFinishedSubagents.status}
          onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
        />
      ) : null}
      <PluginComposerPills
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        compact={isCompact}
      />
      {!mainChatShell.inMainChatShell ? (
        <WorkspaceDiffStatPill
          serverId={serverId}
          workspaceId={workspaceId}
          onPress={handleOpenChanges}
        />
      ) : null}
    </ComposerTrackBar>
  );
});
