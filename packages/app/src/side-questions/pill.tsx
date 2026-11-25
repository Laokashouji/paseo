import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { composerPillStyles } from "@/composer/pill-styles";
import { ComposerTrackMark } from "@/composer/tracks";
import type { Theme } from "@/styles/theme";
import { buildSideQuestionThreadKey, useSideQuestionStore } from "./store";

const ThemedSparkles = withUnistyles(Sparkles);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * Compact capsule shown above the composer when an ephemeral `/btw` thread is minimized,
 * letting the user reopen the answer card with one tap.
 */
export const SideQuestionPill = memo(function SideQuestionPill({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const threadKey = buildSideQuestionThreadKey(serverId, agentId);
  const thread = useSideQuestionStore((state) => state.threads[threadKey]);
  const [isHovered, setIsHovered] = useState(false);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => {
    useSideQuestionStore.getState().open(serverId, agentId);
  }, [agentId, serverId]);

  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );
  const labelStyle = useMemo(
    () => [composerPillStyles.label, isHovered && composerPillStyles.labelActive],
    [isHovered],
  );

  if (!thread || thread.displayMode !== "minimized" || thread.turns.length === 0) {
    return null;
  }

  const isPending = thread.turns.some((turn) => turn.status === "pending");
  const hasError = !isPending && thread.turns[thread.turns.length - 1]?.status === "error";
  const label = isPending
    ? t("sideQuestion.pillPending")
    : t("sideQuestion.pillCount", { count: thread.turns.length });

  return (
    <PressHighlight
      testID="side-question-pill"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
      highlightStyle={composerPillStyles.bodyActive}
    >
      {isPending || hasError ? (
        <ComposerTrackMark bucket={isPending ? "running" : "failed"} />
      ) : (
        <ThemedSparkles
          size={13}
          uniProps={isHovered ? foregroundColorMapping : mutedColorMapping}
        />
      )}
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
});
