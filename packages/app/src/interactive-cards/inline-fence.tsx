import { memo, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import {
  computeInlineCardKey,
  extractFallbackFromRawCardJson,
  extractFencedCardBlocks,
  INTERACTIVE_CARD_MAX_INLINE_PER_MESSAGE,
  validateInteractiveCardView,
} from "@getpaseo/protocol/interactive-cards";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { InteractiveCardShell } from "./card-shell";
import { useInteractiveCardHost } from "./context";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface InteractiveInlineCardFenceProps {
  code: string;
  blockIndex?: number;
  complete?: boolean;
  renderMarkdown?: (content: string) => ReactNode;
}

function resolveBlockIndex(
  messageText: string | undefined,
  rawCode: string,
  explicitIndex?: number,
): {
  index: number;
  complete: boolean;
} {
  if (explicitIndex !== undefined) {
    return { index: explicitIndex, complete: true };
  }
  if (!messageText) {
    return { index: 0, complete: true };
  }
  const normalizedTarget = rawCode.replace(/\r\n/g, "\n").trim();
  const blocks = extractFencedCardBlocks(messageText);
  const matched = blocks.find((b) => b.raw === normalizedTarget);
  if (matched) {
    return { index: matched.blockIndex, complete: matched.complete };
  }
  return { index: 0, complete: true };
}

/**
 * Renders an inline ```paseo-view fenced block inside an assistant reply.
 * Falls back gracefully to plain-text `fallback` while streaming, over limit, or invalid,
 * and never flashes raw JSON to users.
 */
export const InteractiveInlineCardFence = memo(function InteractiveInlineCardFence({
  code,
  blockIndex: explicitIndex,
  complete: explicitComplete,
  renderMarkdown,
}: InteractiveInlineCardFenceProps) {
  const { t } = useTranslation();
  const host = useInteractiveCardHost();

  const resolved = useMemo(() => {
    const { index, complete: detectedComplete } = resolveBlockIndex(
      host?.messageText,
      code,
      explicitIndex,
    );
    const complete = explicitComplete ?? detectedComplete;
    const cardKey = host?.messageText
      ? computeInlineCardKey(host.messageText, index)
      : computeInlineCardKey(code, index);
    return { index, complete, cardKey };
  }, [code, explicitComplete, explicitIndex, host?.messageText]);

  const parsed = useMemo(() => {
    if (!resolved.complete || resolved.index >= INTERACTIVE_CARD_MAX_INLINE_PER_MESSAGE) {
      return { ok: false as const, fallback: extractFallbackFromRawCardJson(code) };
    }
    try {
      const json = JSON.parse(code.trim()) as unknown;
      const result = validateInteractiveCardView(json);
      if (result.ok) {
        return { ok: true as const, view: result.view };
      }
      return { ok: false as const, fallback: extractFallbackFromRawCardJson(code) };
    } catch {
      return { ok: false as const, fallback: extractFallbackFromRawCardJson(code) };
    }
  }, [code, resolved.complete, resolved.index]);

  if (!parsed.ok) {
    if (!resolved.complete && !parsed.fallback) {
      return (
        <View style={styles.fallbackCard} testID="interactive-card-streaming-placeholder">
          <View style={styles.streamingRow}>
            <ThemedLoadingSpinner size="small" uniProps={mutedSpinnerMapping} />
            <Text style={styles.fallbackText}>{t("interactiveCards.generating")}</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.fallbackCard} testID="interactive-card-fallback">
        <Text selectable style={styles.fallbackText}>
          {parsed.fallback ?? t("interactiveCards.unavailableFallback")}
        </Text>
      </View>
    );
  }

  return (
    <InteractiveCardShell
      cardKey={resolved.cardKey}
      view={parsed.view}
      version={1}
      live={false}
      renderMarkdown={renderMarkdown}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  fallbackCard: {
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  streamingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  fallbackText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
}));
