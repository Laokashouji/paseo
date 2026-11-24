import type { MainChatBackgroundTurnKind } from "@getpaseo/protocol/main-chat";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  CornerDownLeft,
  Radar,
  Sparkles,
  Summary,
} from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { Theme } from "@/styles/theme";
import type { TurnSummaryItem } from "@/types/stream";

const ThemedRadar = withUnistyles(Radar);
const ThemedClock = withUnistyles(Clock);
const ThemedCornerDownLeft = withUnistyles(CornerDownLeft);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const EXPANDED_ACCESSIBILITY_STATE = { expanded: true } as const;
const COLLAPSED_ACCESSIBILITY_STATE = { expanded: false } as const;

function resolveBackgroundKindLabelKey(
  kind: MainChatBackgroundTurnKind | undefined,
  running: boolean,
): string {
  if (running) return "mainChat.backgroundTurn.running";
  switch (kind) {
    case "patrol":
      return "mainChat.backgroundTurn.kindPatrol";
    case "supervision":
      return "mainChat.backgroundTurn.kindSupervision";
    case "relay":
      return "mainChat.backgroundTurn.kindRelay";
    case "briefing":
      return "mainChat.backgroundTurn.kindBriefing";
    case "compaction":
      return "mainChat.backgroundTurn.kindCompaction";
    case "routine":
      return "mainChat.backgroundTurn.kindRoutine";
    case "cache_keepalive":
      return "mainChat.backgroundTurn.kindCacheKeepalive";
    default:
      return "mainChat.backgroundTurn.completed";
  }
}

function renderBackgroundIcon(kind: MainChatBackgroundTurnKind | undefined) {
  if (kind === "relay") {
    return <ThemedCornerDownLeft size={14} uniProps={mutedIconMapping} />;
  }
  if (kind === "routine") {
    return <ThemedClock size={14} uniProps={mutedIconMapping} />;
  }
  if (kind === "briefing" || kind === "compaction" || kind === "cache_keepalive") {
    return <ThemedSparkles size={14} uniProps={mutedIconMapping} />;
  }
  return <ThemedRadar size={14} uniProps={mutedIconMapping} />;
}

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it. For Main Chat system-injected background turns,
 * renders a compact full-width rail-aligned summary bar that expands and collapses the trigger
 * and intermediate work in place.
 */
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
    const kindBadge = t(resolveBackgroundKindLabelKey(kind, running));
    const detailParts = [item.backgroundMeta?.label, toolsLabel].filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0,
    );
    const summaryText = detailParts.join(" · ");
    const toggleLabel = item.expanded
      ? t("mainChat.backgroundTurn.collapse")
      : t("mainChat.backgroundTurn.expand");

    return (
      <PressHighlight
        testID={`background-turn-summary-${item.hostId}`}
        accessibilityRole="button"
        accessibilityState={
          item.expanded ? EXPANDED_ACCESSIBILITY_STATE : COLLAPSED_ACCESSIBILITY_STATE
        }
        aria-expanded={item.expanded}
        accessibilityLabel={summaryText ? `${kindBadge} · ${summaryText}` : kindBadge}
        onPress={toggle}
        style={barStyle}
        highlightStyle={styles.backgroundBarHighlight}
      >
        <View style={styles.backgroundLeft}>
          <View style={styles.backgroundIconWrap}>{renderBackgroundIcon(kind)}</View>
          <View style={styles.backgroundKindPill}>
            <Text style={styles.backgroundKindText} numberOfLines={1}>
              {kindBadge}
            </Text>
          </View>
          {summaryText ? (
            <Text style={styles.backgroundSummaryText} numberOfLines={1} ellipsizeMode="tail">
              {summaryText}
            </Text>
          ) : null}
        </View>
        <View style={styles.backgroundRight}>
          <Text style={styles.backgroundToggleText} numberOfLines={1}>
            {toggleLabel}
          </Text>
          {item.expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
          )}
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
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  backgroundBarHighlight: {
    backgroundColor: theme.colors.surface2,
  },
  backgroundBarExpanded: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  backgroundLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  backgroundIconWrap: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  backgroundKindPill: {
    flexShrink: 0,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  backgroundKindText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  backgroundSummaryText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  backgroundRight: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  backgroundToggleText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
}));
