import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { MessageSquareQuote, Quote, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { QuoteCommentInput } from "./comment-input";
import { formatQuoteClock, stripMarkdownForQuotePreview } from "./format";
import { selectDraftQuotes, selectEditingQuoteId, useChatQuoteStore } from "./store";
import { MAX_COMMENT_CHARS, type DraftQuote } from "./types";

const ThemedQuoteIcon = withUnistyles(Quote);
const ThemedCommentIcon = withUnistyles(MessageSquareQuote);
const ThemedCloseIcon = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const TRAY_MAX_HEIGHT = 196;

function resolveQuoteAuthor(
  quote: DraftQuote,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const explicit = quote.from?.trim();
  if (explicit) return explicit;
  if (quote.role === "assistant") return t("chatQuotes.roles.assistant");
  if (quote.role === "user") return t("chatQuotes.roles.user");
  return "";
}

function resolveSourceLabel(
  quote: DraftQuote,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const author = resolveQuoteAuthor(quote, t);
  const clock = formatQuoteClock(quote.ts);
  const head = author ? t("chatQuotes.quotingFrom", { name: author }) : t("chatQuotes.quoting");
  return clock ? `${head} · ${clock}` : head;
}

interface QuoteCardRowProps {
  quote: DraftQuote;
  onRemove: (id: string) => void;
}

const QuoteCardRow = memo(function QuoteCardRow({ quote, onRemove }: QuoteCardRowProps) {
  const { t } = useTranslation();
  const sourceLabel = useMemo(() => resolveSourceLabel(quote, t), [quote, t]);
  const summary = useMemo(() => stripMarkdownForQuotePreview(quote.text), [quote.text]);
  const handleRemove = useCallback(() => onRemove(quote.id), [onRemove, quote.id]);

  return (
    <View style={styles.card} testID="composer-quote-item">
      <View style={styles.quoteAccentBar} />
      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <ThemedQuoteIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.headerText} numberOfLines={1}>
            {sourceLabel}
          </Text>
        </View>
        {summary ? (
          <Text style={styles.excerptText} numberOfLines={2}>
            {summary}
          </Text>
        ) : null}
      </View>
      <PressHighlight
        onPress={handleRemove}
        accessibilityRole="button"
        accessibilityLabel={t("chatQuotes.removeQuote")}
        hitSlop={6}
        style={styles.removeButton}
        testID={`composer-quote-remove-${quote.id}`}
      >
        <ThemedCloseIcon size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

interface CommentCardRowProps {
  draftKey: string;
  quote: DraftQuote;
  commentNumber: number;
  editing: boolean;
  onRemove: (id: string) => void;
  onRequestComposerFocus?: () => void;
}

const CommentCardRow = memo(function CommentCardRow({
  draftKey,
  quote,
  commentNumber,
  editing,
  onRemove,
  onRequestComposerFocus,
}: CommentCardRowProps) {
  const { t } = useTranslation();
  const updateCommentBody = useChatQuoteStore((state) => state.updateCommentBody);
  const setEditingQuoteId = useChatQuoteStore((state) => state.setEditingQuoteId);
  const finishCommentEdit = useChatQuoteStore((state) => state.finishCommentEdit);

  const commentBody = quote.comment?.body ?? "";
  const excerpt = useMemo(() => stripMarkdownForQuotePreview(quote.text), [quote.text]);
  const clock = useMemo(() => formatQuoteClock(quote.ts), [quote.ts]);
  const authorLabel = useMemo(() => {
    if (quote.from?.trim()) return quote.from.trim();
    if (quote.role === "assistant") return t("chatQuotes.roles.assistant");
    if (quote.role === "user") return t("chatQuotes.roles.user");
    return "";
  }, [quote.from, quote.role, t]);
  const metaSuffix = useMemo(
    () => [authorLabel, clock].filter(Boolean).join(" · "),
    [authorLabel, clock],
  );

  const handleChangeText = useCallback(
    (nextBody: string) => {
      updateCommentBody({ draftKey, id: quote.id, body: nextBody });
    },
    [draftKey, quote.id, updateCommentBody],
  );

  const handleCommit = useCallback(() => {
    finishCommentEdit({ draftKey, id: quote.id, cancel: false });
    onRequestComposerFocus?.();
  }, [draftKey, finishCommentEdit, onRequestComposerFocus, quote.id]);

  const handleCancel = useCallback(() => {
    finishCommentEdit({ draftKey, id: quote.id, cancel: true });
    onRequestComposerFocus?.();
  }, [draftKey, finishCommentEdit, onRequestComposerFocus, quote.id]);

  const handleBeginEdit = useCallback(() => {
    setEditingQuoteId({ draftKey, id: quote.id });
  }, [draftKey, quote.id, setEditingQuoteId]);

  const handleRemove = useCallback(() => onRemove(quote.id), [onRemove, quote.id]);

  return (
    <View style={styles.card} testID="composer-comment-item">
      <View style={styles.commentAccentBar} />
      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <View style={styles.commentBadge}>
            <Text style={styles.commentBadgeText}>{commentNumber}</Text>
          </View>
          <ThemedCommentIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.headerText} numberOfLines={1}>
            {t("chatQuotes.commentNumber", { n: commentNumber })}
            {metaSuffix ? ` · ${metaSuffix}` : ""}
          </Text>
        </View>
        {excerpt ? (
          <View style={styles.commentExcerptBox}>
            <Text style={styles.commentExcerptText} numberOfLines={2}>
              {excerpt}
            </Text>
          </View>
        ) : null}
        {editing ? (
          <View style={styles.commentEditorWrap}>
            <QuoteCommentInput
              value={commentBody}
              placeholder={t("chatQuotes.commentPlaceholder")}
              accessibilityLabel={t("chatQuotes.commentInputLabel", { n: commentNumber })}
              testID={`composer-comment-input-${commentNumber}`}
              onChangeText={handleChangeText}
              onCommit={handleCommit}
              onCancel={handleCancel}
            />
            <View style={styles.commentEditorFooter}>
              <Text style={styles.commentHintText} numberOfLines={1}>
                {t("chatQuotes.commentHint")}
              </Text>
              {commentBody.length > MAX_COMMENT_CHARS * 0.8 ? (
                <Text style={styles.commentCounterText}>
                  {t("chatQuotes.commentCounter", {
                    count: commentBody.length,
                    max: MAX_COMMENT_CHARS,
                  })}
                </Text>
              ) : null}
            </View>
          </View>
        ) : (
          <PressHighlight
            onPress={handleBeginEdit}
            accessibilityRole="button"
            accessibilityLabel={t("chatQuotes.editComment", { n: commentNumber })}
            style={styles.commentBodyPreviewButton}
            testID={`composer-comment-preview-${commentNumber}`}
          >
            <Text
              style={
                commentBody.trim().length > 0
                  ? styles.commentBodyPreviewText
                  : styles.commentBodyPlaceholderText
              }
              numberOfLines={3}
            >
              {commentBody.trim().length > 0 ? commentBody : t("chatQuotes.commentPlaceholder")}
            </Text>
          </PressHighlight>
        )}
      </View>
      <PressHighlight
        onPress={handleRemove}
        accessibilityRole="button"
        accessibilityLabel={t("chatQuotes.removeComment")}
        hitSlop={6}
        style={styles.removeButton}
        testID={`composer-quote-remove-${quote.id}`}
      >
        <ThemedCloseIcon size={ICON_SIZE.xs} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

export interface ChatQuoteTrayProps {
  draftKey: string;
  onRequestComposerFocus?: () => void;
}

/**
 * Bounded, vertically scrollable stack of queued message quotes and selection comments
 * rendered directly above the composer input.
 */
export const ChatQuoteTray = memo(function ChatQuoteTray({
  draftKey,
  onRequestComposerFocus,
}: ChatQuoteTrayProps) {
  const { t } = useTranslation();
  const quotes = useChatQuoteStore((state) => selectDraftQuotes(state, draftKey));
  const editingQuoteId = useChatQuoteStore((state) => selectEditingQuoteId(state, draftKey));
  const removeQuote = useChatQuoteStore((state) => state.removeQuote);

  const handleRemove = useCallback(
    (id: string) => {
      removeQuote({ draftKey, id });
    },
    [draftKey, removeQuote],
  );

  if (quotes.length === 0) {
    return null;
  }

  let commentCounter = 0;

  return (
    <View
      style={styles.trayContainer}
      testID="composer-quote-tray"
      accessibilityLabel={t("chatQuotes.trayLabel")}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        testID="composer-quote-tray-scroll"
      >
        {quotes.map((quote) => {
          if (quote.comment) {
            commentCounter += 1;
            return (
              <CommentCardRow
                key={quote.id}
                draftKey={draftKey}
                quote={quote}
                commentNumber={commentCounter}
                editing={editingQuoteId === quote.id}
                onRemove={handleRemove}
                onRequestComposerFocus={onRequestComposerFocus}
              />
            );
          }
          return <QuoteCardRow key={quote.id} quote={quote} onRemove={handleRemove} />;
        })}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  trayContainer: {
    width: "100%",
    marginBottom: theme.spacing[2],
    maxHeight: TRAY_MAX_HEIGHT,
    minWidth: 0,
  },
  scrollView: {
    maxHeight: TRAY_MAX_HEIGHT,
    ...(isWeb
      ? ({
          overscrollBehavior: "contain",
        } as Record<string, string>)
      : {}),
  },
  scrollContent: {
    gap: theme.spacing[1.5],
    paddingVertical: 1,
  },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1.5],
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
  cardBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  cardHeader: {
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
  excerptText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    color: theme.colors.foreground,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
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
  commentEditorWrap: {
    gap: 4,
    minWidth: 0,
  },
  commentEditorFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  commentHintText: {
    flex: 1,
    minWidth: 0,
    fontFamily: theme.fontFamily.ui,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  commentCounterText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  commentBodyPreviewButton: {
    borderRadius: theme.borderRadius.sm,
    paddingVertical: 2,
    paddingHorizontal: 2,
    minWidth: 0,
  },
  commentBodyPreviewText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    color: theme.colors.foreground,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
  commentBodyPlaceholderText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  removeButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
}));
