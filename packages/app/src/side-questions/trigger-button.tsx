import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { Sparkles } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { toolbarSlot } from "@/components/ui/control-geometry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerTrackMark } from "@/composer/tracks";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, ICON_STROKE_WIDTH, type Theme } from "@/styles/theme";
import { buildSideQuestionThreadKey, useSideQuestionStore } from "./store";

const ThemedSparkles = withUnistyles(Sparkles);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Icon-only composer toolbar button that toggles the ephemeral `/btw` side-question card. */
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
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);
  const turnCount = thread?.turns.length ?? 0;
  const isPending = thread?.turns.some((turn) => turn.status === "pending") ?? false;
  const hasError = !isPending && turnCount > 0 && thread?.turns[turnCount - 1]?.status === "error";

  const buttonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      isOpen || hovered ? styles.buttonActive : null,
      pressed ? styles.buttonPressed : null,
    ],
    [isOpen],
  );

  const renderContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      const active = isOpen || Boolean(hovered);
      return (
        <View style={styles.iconContainer}>
          <ThemedSparkles
            size={ICON_SIZE.md}
            strokeWidth={ICON_STROKE_WIDTH}
            uniProps={active ? foregroundColorMapping : mutedColorMapping}
          />
          {isPending || hasError ? (
            <View style={styles.statusCorner}>
              <ComposerTrackMark bucket={isPending ? "running" : "failed"} />
            </View>
          ) : null}
          {!isPending && !hasError && turnCount > 0 && !isOpen ? (
            <View style={styles.savedDot} />
          ) : null}
        </View>
      );
    },
    [hasError, isOpen, isPending, turnCount],
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
        accessibilityState={accessibilityState}
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
    ...toolbarSlot(),
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  buttonActive: {
    backgroundColor: theme.colors.surface3,
  },
  buttonPressed: {
    opacity: 0.7,
  },
  iconContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  statusCorner: {
    position: "absolute",
    top: -3,
    right: -4,
  },
  savedDot: {
    position: "absolute",
    top: -2,
    right: -3,
    width: 5,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
