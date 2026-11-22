import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { Sparkles } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerTrackMark } from "@/composer/tracks";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildSideQuestionThreadKey, useSideQuestionStore } from "./store";

const ThemedSparkles = withUnistyles(Sparkles);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Compact composer-toolbar trigger button that opens or toggles the ephemeral `/btw`
 * side-question panel directly from the bottom of the conversation.
 */
export const SideQuestionTriggerButton = memo(function SideQuestionTriggerButton({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const supportsHostFeature = useHostFeature(serverId, "agentSideQuestion");
  const supportsAgentSideQuestion = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.capabilities?.supportsSideQuestion === true;
  });

  const threadKey = buildSideQuestionThreadKey(serverId, agentId);
  const thread = useSideQuestionStore((state) => state.threads[threadKey]);

  const handlePress = useCallback(() => {
    useSideQuestionStore.getState().toggle(serverId, agentId);
  }, [agentId, serverId]);

  const isOpen = thread?.displayMode === "open";
  const turnCount = thread?.turns.length ?? 0;
  const isPending = thread?.turns.some((turn) => turn.status === "pending") ?? false;
  const hasError = !isPending && turnCount > 0 && thread?.turns[turnCount - 1]?.status === "error";

  const buttonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      isOpen ? styles.buttonOpen : null,
      hovered && !isOpen ? styles.buttonHover : null,
      pressed ? styles.buttonPressed : null,
    ],
    [isOpen],
  );

  const renderContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      const active = isOpen || Boolean(hovered);
      return (
        <View style={styles.content}>
          {isPending ? (
            <ComposerTrackMark bucket="running" />
          ) : hasError ? (
            <ComposerTrackMark bucket="failed" />
          ) : (
            <ThemedSparkles
              size={13}
              uniProps={active ? foregroundColorMapping : mutedColorMapping}
            />
          )}
          <Text style={[styles.label, active ? styles.labelActive : null]} numberOfLines={1}>
            {t("sideQuestion.triggerLabel")}
          </Text>
          {turnCount > 0 && !isOpen ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{turnCount}</Text>
            </View>
          ) : null}
        </View>
      );
    },
    [hasError, isOpen, isPending, t, turnCount],
  );

  if (!supportsHostFeature || !supportsAgentSideQuestion) {
    return null;
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handlePress}
        style={buttonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("sideQuestion.triggerTooltip")}
        accessibilityState={{ expanded: isOpen }}
        testID="side-question-trigger-button"
      >
        {renderContent}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("sideQuestion.triggerTooltip")}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

const styles = StyleSheet.create((theme) => ({
  button: {
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  buttonHover: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
  buttonOpen: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  labelActive: {
    color: theme.colors.foreground,
  },
  countBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  countText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
