import { memo, useCallback, useEffect, useLayoutEffect, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RetainedPanelActivity } from "@/components/retained-panel";
import {
  ComposerEditingScope,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  createPaneFocusContextValue,
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
} from "@/panels/pane-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { useOpenMainChatTaskTarget } from "./open-task-target";

export interface MainChatAgentHostProps {
  /** Unique owner id passed to `viewedTimelineSync.replaceVisibleAgentIds`. */
  sourceId: string;
  serverId: string;
  workspaceId: string;
  agentId: string;
  isFocused: boolean;
  onFocusPane?: () => void;
  /** Optional custom handler when a child agent link is triggered inside this pane. */
  onOpenAgentTarget?: (input: { serverId: string; agentId: string }) => void;
}

const noop = () => {};

function useViewedMainChatAgent(input: {
  sourceId: string;
  serverId: string;
  agentId: string;
  isActive: boolean;
}) {
  const { sourceId, serverId, agentId, isActive } = input;
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);

  useDirectoryDemand(serverId || null);

  useEffect(() => {
    if (!serverId || !agentId || !isActive) return;
    void getHostRuntimeStore()
      .prepareAgentTimeline(serverId, agentId)
      .catch(() => undefined);
  }, [agentId, isActive, serverId]);

  useLayoutEffect(() => {
    if (!viewedTimelineSync) return;
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, isActive && agentId ? [agentId] : []);
  }, [agentId, isActive, sourceId, viewedTimelineSync]);

  useEffect(() => {
    if (!viewedTimelineSync) return;
    return () => {
      viewedTimelineSync.replaceVisibleAgentIds(sourceId, []);
    };
  }, [sourceId, viewedTimelineSync]);

  useEffect(() => {
    if (!serverId || !agentId || !isActive) return;
    setFocusedAgentId(serverId, agentId);
    return () => {
      const currentFocused = useSessionStore.getState().sessions[serverId]?.focusedAgentId;
      if (currentFocused === agentId) {
        setFocusedAgentId(serverId, null);
      }
    };
  }, [agentId, isActive, serverId, setFocusedAgentId]);
}

/**
 * Lightweight host for `AgentConversationPanel` inside `/main` and the right `TaskPanelDrawer`.
 * Provides timeline catch-up, isolated composer editing scope, and pane context without wrapping
 * the conversation in `WorkspaceScreen` tabs, terminal, explorer, or git chrome.
 */
const MainChatAgentHostContent = memo(function MainChatAgentHostContent() {
  return (
    <View style={styles.panelHost}>
      <AgentConversationPanel />
    </View>
  );
});

export const MainChatAgentHost = memo(function MainChatAgentHost({
  sourceId,
  serverId,
  workspaceId,
  agentId,
  isFocused,
  onFocusPane,
  onOpenAgentTarget,
}: MainChatAgentHostProps): ReactElement {
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  useViewedMainChatAgent({
    sourceId,
    serverId,
    agentId,
    isActive: true,
  });

  const handleOpenTarget = useCallback(
    (target: WorkspaceTabTarget) => {
      if (target.kind === "agent") {
        if (onOpenAgentTarget) {
          onOpenAgentTarget({ serverId, agentId: target.agentId });
          return;
        }
        openMainChatTaskTarget({ serverId, agentId: target.agentId });
        return;
      }
      if (!workspaceId) return;
      navigateToWorkspace({ serverId, workspaceId, target });
    },
    [onOpenAgentTarget, openMainChatTaskTarget, serverId, workspaceId],
  );

  const handleOpenFileInWorkspace = useCallback(
    (request: WorkspaceFileOpenRequest) => {
      if (!workspaceId) return;
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "file", path: request.location.path },
      });
    },
    [serverId, workspaceId],
  );

  const tabId = `main-chat-pane:${sourceId}`;
  const editingWorkspaceKey = `main-chat-editing:${sourceId}`;
  const editingTabIds = useMemo(() => [tabId], [tabId]);
  const targetKey = `agent:${serverId}:${agentId}`;
  const showComposerEnhancements = !sourceId.startsWith("main-chat-drawer:");

  const paneContextValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId,
      host: "main",
      tabId,
      target: { kind: "agent", agentId },
      showMainChatComposerEnhancements: showComposerEnhancements,
      openTab: handleOpenTarget,
      openPreferredTarget: handleOpenTarget,
      closeCurrentTab: noop,
      retargetCurrentTab: noop,
      setCurrentTabState: noop,
      openFileInWorkspace: handleOpenFileInWorkspace,
      openImportSheet: noop,
    }),
    [
      agentId,
      handleOpenFileInWorkspace,
      handleOpenTarget,
      serverId,
      showComposerEnhancements,
      tabId,
      workspaceId,
    ],
  );

  const paneFocusValue = useMemo(
    () =>
      createPaneFocusContextValue({
        isWorkspaceFocused: true,
        isPaneFocused: isFocused,
        onFocusPane,
      }),
    [isFocused, onFocusPane],
  );

  const handleResponderCapture = useCallback(() => {
    onFocusPane?.();
    return false;
  }, [onFocusPane]);

  return (
    <View
      style={styles.root}
      onStartShouldSetResponderCapture={onFocusPane ? handleResponderCapture : undefined}
    >
      <RetainedPanelActivity active>
        <WorkspaceComposerEditingSessionsProvider
          workspaceKey={editingWorkspaceKey}
          tabIds={editingTabIds}
        >
          <ComposerEditingScope tabId={tabId} targetKey={targetKey}>
            <PaneProvider value={paneContextValue}>
              <PaneFocusProvider value={paneFocusValue}>
                <MainChatAgentHostContent />
              </PaneFocusProvider>
            </PaneProvider>
          </ComposerEditingScope>
        </WorkspaceComposerEditingSessionsProvider>
      </RetainedPanelActivity>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  panelHost: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
});
