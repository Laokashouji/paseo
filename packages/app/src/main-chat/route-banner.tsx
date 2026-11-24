import { ArrowUpRight, AtSign, X } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { resolveComposerAttachmentSubmitFormat } from "@/composer/attachments/submit";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import type { MessagePayload } from "@/composer/types";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { encodeImages } from "@/utils/encode-images";
import { useOpenMainChatTaskTarget } from "./open-task-target";
import {
  routeStoreKey,
  useMainChatRouteStore,
  type MainChatDirectRouteTarget,
} from "./route-store";

const ThemedAtIcon = withUnistyles(AtSign);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);
const ThemedXIcon = withUnistyles(X);

const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Manages the active direct-route target for the Main Chat composer. When a target child task is
 * selected (via `@任务` autocomplete or the task board), returns an `onSubmitMessage` handler that
 * sends directly to that child agent without going through the Main Chat LLM.
 */
export function useMainChatDirectRoute(input: { serverId: string; agentId: string }): {
  target: MainChatDirectRouteTarget | null;
  clearTarget: () => void;
  onSubmitMessage: ((payload: MessagePayload) => Promise<void>) | undefined;
} {
  const { serverId, agentId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const sendBehavior = useSettings((settings) => settings.sendBehavior);
  const key = routeStoreKey(serverId, agentId);
  const target = useMainChatRouteStore((state) => state.targetsByKey[key] ?? null);
  const clearStoreTarget = useMainChatRouteStore((state) => state.clearTarget);

  const targetExists = useSessionStore((state) => {
    if (!target) return false;
    const session = state.sessions[target.targetServerId];
    const candidate =
      session?.agents.get(target.targetAgentId) ?? session?.agentDetails.get(target.targetAgentId);
    return Boolean(candidate && !candidate.archivedAt);
  });

  const targetClient = useHostRuntimeClient(target?.targetServerId ?? serverId);
  const supportsForgeSearch = useSessionStore((state) => {
    const sid = target?.targetServerId ?? serverId;
    return state.sessions[sid]?.serverInfo?.features?.forgeSearch === true;
  });

  useEffect(() => {
    if (target && !targetExists) {
      clearStoreTarget(serverId, agentId);
    }
  }, [agentId, clearStoreTarget, serverId, target, targetExists]);

  const clearTarget = useCallback(() => {
    clearStoreTarget(serverId, agentId);
  }, [agentId, clearStoreTarget, serverId]);

  const onSubmitMessage = useMemo(() => {
    if (!target) return undefined;
    return async (payload: MessagePayload) => {
      if (!targetClient) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const activeTurnBehavior = sendBehavior === "steer" ? "steer" : "interrupt";
      await dispatchComposerAgentMessage({
        client: targetClient,
        agentId: target.targetAgentId,
        text: payload.text,
        attachments: payload.attachments,
        attachmentSubmitFormat: resolveComposerAttachmentSubmitFormat({
          supportsForgeAttachments: supportsForgeSearch,
        }),
        encodeImages,
        submission: createMessageSubmissionWriter(target.targetServerId),
        activeTurnBehavior,
        activeTurnId:
          activeTurnBehavior === "steer"
            ? (selectAgentTurnPresentation(
                useSessionStore.getState().sessions[target.targetServerId],
                target.targetAgentId,
              ).turnId ?? undefined)
            : undefined,
      });
      clearStoreTarget(serverId, agentId);
      toast.show(t("mainChat.directRoute.sentToast", { title: target.targetTitle }), {
        variant: "success",
      });
    };
  }, [
    agentId,
    clearStoreTarget,
    sendBehavior,
    serverId,
    supportsForgeSearch,
    t,
    target,
    targetClient,
    toast,
  ]);

  return { target, clearTarget, onSubmitMessage };
}

export const MainChatRouteBanner = memo(function MainChatRouteBanner({
  target,
  onClear,
}: {
  target: MainChatDirectRouteTarget | null;
  onClear: () => void;
}) {
  const { t } = useTranslation();

  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const handleOpenTarget = useCallback(() => {
    if (!target) return;
    openMainChatTaskTarget({
      serverId: target.targetServerId,
      agentId: target.targetAgentId,
      title: target.targetTitle,
    });
  }, [openMainChatTaskTarget, target]);

  if (!target) return null;

  return (
    <View style={styles.rail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={styles.inner} testID="main-chat-route-banner-inner">
        <View style={styles.banner} testID={`main-chat-route-banner-${target.targetAgentId}`}>
          <ThemedAtIcon size={13} uniProps={primaryIconMapping} />
          <Text style={styles.label} numberOfLines={1}>
            {t("mainChat.directRoute.bannerLabel", { title: target.targetTitle })}
          </Text>
          <PressHighlight
            onPress={handleOpenTarget}
            style={styles.actionButton}
            highlightStyle={styles.actionButtonPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.openChildAgent")}
          >
            <Text style={styles.actionText}>{t("mainChat.openChildAgent")}</Text>
            <ThemedArrowIcon size={12} uniProps={mutedIconMapping} />
          </PressHighlight>
          <PressHighlight
            onPress={onClear}
            style={styles.actionButton}
            highlightStyle={styles.actionButtonPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.directRoute.clear")}
            testID="main-chat-route-banner-clear"
          >
            <Text style={styles.actionText}>{t("mainChat.directRoute.clear")}</Text>
            <ThemedXIcon size={12} uniProps={mutedIconMapping} />
          </PressHighlight>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1.5],
  },
  inner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  label: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  actionButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
  actionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
