import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import { ArrowLeft, Compass, History } from "lucide-react-native";
import { useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatConversationRoute,
  buildMainChatHistoryRoute,
  buildMainChatRoute,
} from "@/utils/host-routes";
import { MainChatAgentHost } from "./agent-host";
import { MainChatShell } from "./main-chat-shell";

const ThemedCompass = withUnistyles(Compass);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedHistory = withUnistyles(History);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatConversationScreenProps {
  conversationId: string;
}

interface ResolvedConversation {
  serverId: string;
  agentId: string;
  workspaceId: string;
  title: string;
  isRunning: boolean;
}

function resolveConversationById(
  state: ReturnType<typeof useSessionStore.getState>,
  conversationId: string,
): ResolvedConversation | null {
  const trimmed = conversationId.trim();
  if (!trimmed) return null;

  // Support both `serverId:agentId` composite ids and plain `agentId`.
  const separator = trimmed.indexOf(":");
  if (separator > 0 && separator < trimmed.length - 1) {
    const serverId = trimmed.slice(0, separator);
    const agentId = trimmed.slice(separator + 1);
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (agent) {
      return {
        serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? "",
        title: agent.title?.trim() || agent.id,
        isRunning:
          agent.turn.phase === "open" ||
          isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork }),
      };
    }
  }

  for (const [serverId, session] of Object.entries(state.sessions)) {
    const agent = session.agents.get(trimmed) ?? session.agentDetails.get(trimmed);
    if (agent) {
      return {
        serverId,
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? "",
        title: agent.title?.trim() || agent.id,
        isRunning:
          agent.turn.phase === "open" ||
          isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork }),
      };
    }
  }
  return null;
}

/**
 * Assistant direction / side conversation route (`/main/c/[conversationId]`).
 * Reuses `MainChatShell` with a `← 主对话` header back action and wide-screen `TaskPanelDrawer`.
 */
export function MainChatConversationScreen({
  conversationId,
}: MainChatConversationScreenProps): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.inactiveContainer} />;
  }

  return <MainChatConversationScreenContent conversationId={conversationId} />;
}

function MainChatConversationScreenContent({
  conversationId,
}: MainChatConversationScreenProps): ReactElement {
  const { t } = useTranslation();
  const [activePane, setActivePane] = useState<"main" | "drawer">("main");

  const resolved = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => resolveConversationById(state, conversationId), [conversationId]),
    equal,
  );

  const handleBackToMain = useCallback(() => {
    router.push(buildMainChatRoute());
  }, []);

  const handleOpenHistory = useCallback(() => {
    router.push(buildMainChatHistoryRoute());
  }, []);

  const handleFocusMainPane = useCallback(() => {
    setActivePane("main");
  }, []);

  const originRoute = conversationId.trim()
    ? buildMainChatConversationRoute(conversationId)
    : buildMainChatRoute();
  const title = resolved?.title || t("mainChat.shell.roleConversation");

  return (
    <MainChatShell
      variant="conversation"
      title={title}
      serverId={resolved?.serverId ?? null}
      mainAgentId={resolved?.agentId ?? null}
      originRoute={originRoute}
      isRunning={resolved?.isRunning ?? false}
      activePane={activePane}
      onActivePaneChange={setActivePane}
    >
      {resolved ? (
        <MainChatAgentHost
          key={`${resolved.serverId}:${resolved.agentId}`}
          sourceId={`main-chat-conversation:${resolved.serverId}:${resolved.agentId}`}
          serverId={resolved.serverId}
          workspaceId={resolved.workspaceId}
          agentId={resolved.agentId}
          isFocused={activePane === "main"}
          onFocusPane={handleFocusMainPane}
        />
      ) : (
        <View style={styles.centerState} testID="main-chat-conversation-not-found">
          <ThemedCompass size={28} uniProps={mutedIconMapping} />
          <Text style={styles.stateTitle}>{t("mainChat.shell.conversationNotFoundTitle")}</Text>
          <Text style={styles.stateDescription}>
            {t("mainChat.shell.conversationNotFoundDescription")}
          </Text>
          <View style={styles.actionsRow}>
            <Button
              variant="default"
              size="sm"
              leftIcon={ThemedArrowLeft}
              onPress={handleBackToMain}
              testID="main-chat-conversation-return-main"
            >
              {t("mainChat.shell.returnToMainButton")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              leftIcon={ThemedHistory}
              onPress={handleOpenHistory}
              testID="main-chat-conversation-open-history"
            >
              {t("mainChat.hero.viewHistory")}
            </Button>
          </View>
        </View>
      )}
    </MainChatShell>
  );
}

const styles = StyleSheet.create((theme) => ({
  inactiveContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  stateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  stateDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 420,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
