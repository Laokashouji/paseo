import type { MainChatBackgroundTurnKind } from "@getpaseo/protocol/main-chat";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Summary } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { Theme } from "@/styles/theme";
import type { TurnSummaryItem } from "@/types/stream";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EXPANDED_ACCESSIBILITY_STATE = { expanded: true } as const;
const COLLAPSED_ACCESSIBILITY_STATE = { expanded: false } as const;

function resolveBackgroundTagKey(kind: MainChatBackgroundTurnKind | undefined): string {
  switch (kind) {
    case "compaction":
      return "mainChat.backgroundTurn.compactionTag";
    case "cache_keepalive":
      return "mainChat.backgroundTurn.cacheKeepaliveTag";
    case "relay":
      return "mainChat.backgroundTurn.kindRelay";
    case "routine":
      return "mainChat.backgroundTurn.kindRoutine";
    case "briefing":
      return "mainChat.backgroundTurn.kindBriefing";
    case "supervision":
    case "patrol":
      return "mainChat.backgroundTurn.supervisionTag";
    default:
      return "mainChat.backgroundTurn.completed";
  }
}

/** Opens the folded work behind a turn while its final report stays visible. */
export const TurnSummaryLine = memo(function TurnSummaryLine({
  item,
  onExpandedChange,
}: {
  item: TurnSummaryItem;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const toolsLabel = useOverviewSummaryLabel(item.tools);
  const hold = useDisclosureHold();
  const toggle = useCallback(
    () => hold(() => onExpandedChange(item.hostId, !item.expanded)),
    [hold, onExpandedChange, item.expanded, item.hostId],
  );
  const barStyle = useMemo(
    () =>
      item.expanded ? [styles.backgroundBar, styles.backgroundBarExpanded] : styles.backgroundBar,
    [item.expanded],
  );

  const isBackground = item.variant === "background";
  if (isBackground) {
    const running = item.backgroundMeta?.running === true;
    const kind = item.backgroundMeta?.kind;
    const actorTag =
      kind === "relay" && item.backgroundMeta?.label
        ? "@" + item.backgroundMeta.label.replace(/^@/, "")
        : t(resolveBackgroundTagKey(kind));
    const statusText = t(
      running
        ? "mainChat.backgroundTurn.handlingInBackground"
        : "mainChat.backgroundTurn.handledInBackground",
    );
    const fullLabel = `${actorTag} · ${statusText}`;

    return (
      <PressHighlight
        testID={`background-turn-summary-${item.hostId}`}
        accessibilityRole="button"
        accessibilityState={
          item.expanded ? EXPANDED_ACCESSIBILITY_STATE : COLLAPSED_ACCESSIBILITY_STATE
        }
        aria-expanded={item.expanded}
        accessibilityLabel={fullLabel}
        onPress={toggle}
        style={barStyle}
        highlightStyle={styles.backgroundBarHighlight}
      >
        <View style={styles.backgroundLeft}>
          <Text style={styles.backgroundLineText} numberOfLines={1} ellipsizeMode="tail">
            <Text style={styles.backgroundTagText}>{actorTag}</Text>
            {" · "}
            <Text style={styles.backgroundStatusText}>{statusText}</Text>
          </Text>
          <View style={styles.backgroundChevron}>
            {item.expanded ? (
              <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
            )}
          </View>
        </View>
      </PressHighlight>
    );
  }

  const label = toolsLabel || t("turnSummary.details");
  return (
    <ExpandableBadge
      testID="turn-summary"
      label={label}
      icon={Summary}
      isExpanded={item.expanded}
      isLoading={false}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  backgroundBar: {
    width: "100%",
    minWidth: 0,
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: "transparent",
  },
  backgroundBarHighlight: {
    backgroundColor: theme.colors.surface1,
  },
  backgroundBarExpanded: {
    paddingHorizontal: 10,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  backgroundLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  backgroundLineText: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  backgroundTagText: {
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  backgroundStatusText: {
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundExtraMuted,
  },
  backgroundChevron: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
}));
