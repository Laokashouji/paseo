import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Radar, Summary } from "lucide-react-native";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { ExpandableBadge } from "@/components/message";
import { useOverviewSummaryLabel } from "@/tool-calls/detail-level/overview/label";
import type { TurnSummaryItem } from "@/types/stream";

/**
 * The row a collapsed turn leaves under its user message, styled like a tool-call group.
 * Pressing it opens the turn's rows beneath it. For Main Chat system-injected background turns,
 * renders a muted single-line summary that expands the prompt, tool calls, and reply on demand.
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

  const isBackground = item.variant === "background";
  let label: string;
  if (isBackground) {
    const prefix = item.backgroundMeta?.running
      ? t("mainChat.backgroundTurn.running")
      : t("mainChat.backgroundTurn.completed");
    const withTitle = item.backgroundMeta?.label
      ? `${prefix} · ${item.backgroundMeta.label}`
      : prefix;
    label = toolsLabel ? `${withTitle} · ${toolsLabel}` : withTitle;
  } else {
    label = toolsLabel || t("turnSummary.details");
  }

  return (
    <ExpandableBadge
      testID={isBackground ? `background-turn-summary-${item.hostId}` : "turn-summary"}
      label={label}
      icon={isBackground ? Radar : Summary}
      isExpanded={item.expanded}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});
