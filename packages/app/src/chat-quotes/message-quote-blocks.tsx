import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { MessageSquareQuote, Quote } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { stripMarkdownForQuotePreview } from "./format";
import type { ParsedMessageQuote } from "./types";

const ThemedQuoteIcon = withUnistyles(Quote);
const ThemedCommentIcon = withUnistyles(MessageSquareQuote);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EXPAND_CHAR_THRESHOLD = 160;
const EXPAND_LINE_THRESHOLD = 3;

function isQuoteLong(text: string): boolean {
  if (text.length > EXPAND_CHAR_THRESHOLD) return true;
  return text.split("\n").length > EXPAND_LINE_THRESHOLD;
}

function resolveAuthorLabel(
  quote: ParsedMessageQuote,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (quote.from?.trim()) return quote.from.trim();
  if (quote.role === "assistant") return t("chatQuotes.roles.assistant");
  if (quote.role === "user") return t("chatQuotes.roles.user");
  return "";
}

const SentQuoteBlock = memo(function SentQuoteBlock({ quote }: { quote: ParsedMessageQuote }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => stripMarkdownForQuotePreview(quote.text), [quote.text]);
  const canExpand = useMemo(() => isQuoteLong(quote.text), [quote.text]);
  const headerLabel = useMemo(() => {
    const author = resolveAuthorLabel(quote, t);
    const base = author
      ? t("chatQuotes.quotingFrom", { name: author })
      : t("chatQuotes.quotedMessage");
    return quote.timeLabel ? `${base} · ${quote.timeLabel}` : base;
  }, [quote, t]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <View style={styles.block} testID="sent-quote-block">
      <View style={styles.quoteAccentBar} />
      <View style={styles.blockContent}>
        <View style={styles.blockHeader}>
          <ThemedQuoteIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.headerText} numberOfLines={1}>
            {headerLabel}
          </Text>
        </View>
        {expanded ? (
          <ScrollView style={styles.expandedScroll} nestedScrollEnabled>
            <Text selectable style={styles.expandedText}>
              {quote.text}
            </Text>
          </ScrollView>
        ) : (
          <Text selectable style={styles.summaryText} numberOfLines={3}>
            {summary}
          </Text>
        )}
        {canExpand ? (
          <PressHighlight
            onPress={handleToggle}
            accessibilityRole="button"
            style={styles.toggleButton}
            testID="sent-quote-toggle"
          >
            <Text style={styles.toggleText}>
              {expanded ? t("chatQuotes.collapse") : t("chatQuotes.expand")}
            </Text>
          </PressHighlight>
        ) : null}
      </View>
    </View>
  );
});

const SentCommentBlock = memo(function SentCommentBlock({
  quote,
  fallbackNumber,
}: {
  quote: ParsedMessageQuote;
  fallbackNumber: number;
}) {
  const { t } = useTranslation();
  const commentNumber = quote.commentNumber ?? fallbackNumber;
  const metaSuffix = useMemo(() => {
    const author = resolveAuthorLabel(quote, t);
    return [author, quote.timeLabel].filter(Boolean).join(" · ");
  }, [quote, t]);

  return (
    <View style={styles.block} testID="sent-comment-block">
      <View style={styles.commentAccentBar} />
      <View style={styles.blockContent}>
        <View style={styles.blockHeader}>
          <View style={styles.commentBadge}>
            <Text style={styles.commentBadgeText}>{commentNumber}</Text>
          </View>
          <ThemedCommentIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.headerText} numberOfLines={1}>
            {t("chatQuotes.commentNumber", { n: commentNumber })}
            {metaSuffix ? ` · ${metaSuffix}` : ""}
          </Text>
        </View>
        {quote.text ? (
          <View style={styles.commentExcerptBox}>
            <Text selectable style={styles.commentExcerptText} numberOfLines={3}>
              {quote.text}
            </Text>
          </View>
        ) : null}
        {quote.commentBody ? (
          <Text selectable style={styles.commentBodyText}>
            {quote.commentBody}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

export interface MessageQuoteStackProps {
  quotes: readonly ParsedMessageQuote[];
  hasBodyBelow: boolean;
}

export const MessageQuoteStack = memo(function MessageQuoteStack({
  quotes,
  hasBodyBelow,
}: MessageQuoteStackProps) {
  const keyedQuotes = useMemo(() => {
    const seen = new Map<string, number>();
    let commentCounter = 0;
    return quotes.map((quote) => {
      const commentNumber = quote.kind === "comment" ? ++commentCounter : 0;
      const baseKey = `${quote.kind}:${commentNumber}:${quote.role ?? ""}:${quote.timeLabel ?? ""}:${quote.text.slice(0, 32)}:${(quote.commentBody ?? "").slice(0, 32)}`;
      const occurrence = (seen.get(baseKey) ?? 0) + 1;
      seen.set(baseKey, occurrence);
      return {
        key: occurrence === 1 ? baseKey : `${baseKey}#${occurrence}`,
        quote,
        commentNumber,
      };
    });
  }, [quotes]);

  if (keyedQuotes.length === 0) {
    return null;
  }

  return (
    <View
      style={[styles.stack, hasBodyBelow && styles.stackWithBodyBelow]}
      testID="sent-quote-stack"
    >
      {keyedQuotes.map(({ key, quote, commentNumber }) =>
        quote.kind === "comment" ? (
          <SentCommentBlock key={key} quote={quote} fallbackNumber={commentNumber} />
        ) : (
          <SentQuoteBlock key={key} quote={quote} />
        ),
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[1.5],
    minWidth: 0,
    width: "100%",
  },
  stackWithBodyBelow: {
    marginBottom: theme.spacing[2],
  },
  block: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    minWidth: 0,
  },
  quoteAccentBar: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
    backgroundColor: theme.colors.foregroundExtraMuted,
    flexShrink: 0,
  },
  commentAccentBar: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
    backgroundColor: theme.colors.accent,
    flexShrink: 0,
  },
  blockContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  blockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  summaryText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  expandedScroll: {
    maxHeight: 240,
    width: "100%",
  },
  expandedText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    color: theme.colors.foreground,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  toggleButton: {
    alignSelf: "flex-start",
    paddingVertical: 1,
  },
  toggleText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accent,
  },
  commentBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  commentBadgeText: {
    color: "#ffffff",
    fontFamily: theme.fontFamily.ui,
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 12,
  },
  commentExcerptBox: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    minWidth: 0,
  },
  commentExcerptText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  commentBodyText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
}));
