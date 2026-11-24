import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  Quote,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { COMPOSER_PILL_CLEARANCE, COMPOSER_PILL_MIN_HEIGHT } from "@/composer/pill-styles";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import {
  buildSideQuestionThreadKey,
  useSideQuestionStore,
  type SideQuestionTurnEntry,
} from "./store";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const ThemedCopy = withUnistyles(Copy);
const ThemedCheck = withUnistyles(Check);
const ThemedQuote = withUnistyles(Quote);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedTextInput = withUnistyles(TextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SideQuestionCardProps {
  serverId: string;
  agentId: string;
  onQuoteToComposer?: (turn: SideQuestionTurnEntry) => void;
  onForkToBranch?: (turn: SideQuestionTurnEntry) => void;
}

export const SideQuestionCard = memo(function SideQuestionCard({
  serverId,
  agentId,
  onQuoteToComposer,
  onForkToBranch,
}: SideQuestionCardProps): ReactElement | null {
  const { t } = useTranslation();
  const threadKey = buildSideQuestionThreadKey(serverId, agentId);
  const thread = useSideQuestionStore((state) => state.threads[threadKey]);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const [followUp, setFollowUp] = useState("");
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);

  const isOpen = thread?.displayMode === "open";
  const turnCount = thread?.turns.length ?? 0;
  const lastTurnStatus = thread?.turns[turnCount - 1]?.status ?? null;
  const hasPending = thread?.turns.some((turn) => turn.status === "pending") ?? false;

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      if (turnCount > 0) {
        scrollRef.current?.scrollToEnd({ animated: true });
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [isOpen, lastTurnStatus, turnCount]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 30);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const handleMinimize = useCallback(() => {
    useSideQuestionStore.getState().minimize(serverId, agentId);
  }, [agentId, serverId]);

  const handleClose = useCallback(() => {
    useSideQuestionStore.getState().close(serverId, agentId);
  }, [agentId, serverId]);

  const handleClear = useCallback(() => {
    useSideQuestionStore.getState().clear(serverId, agentId);
    setTimeout(() => inputRef.current?.focus(), 20);
  }, [agentId, serverId]);

  const handleSendFollowUp = useCallback(() => {
    const trimmed = followUp.trim();
    if (!trimmed || hasPending) return;
    setFollowUp("");
    void useSideQuestionStore.getState().askQuestion({
      serverId,
      agentId,
      question: trimmed,
      client,
      disconnectedMessage: t("workspace.terminal.hostDisconnected"),
    });
  }, [agentId, client, followUp, hasPending, serverId, t]);

  const handleRetry = useCallback(
    (turnId: string) => {
      void useSideQuestionStore.getState().retryTurn({
        serverId,
        agentId,
        turnId,
        client,
        disconnectedMessage: t("workspace.terminal.hostDisconnected"),
      });
    },
    [agentId, client, serverId, t],
  );

  if (!thread || !isOpen) {
    return null;
  }

  return (
    <View
      style={styles.overlay}
      dataSet={CHAT_COLUMN_RAIL_DATASET}
      pointerEvents="box-none"
      testID="side-question-card"
    >
      <View style={styles.card}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.badge}>
              <ThemedSparkles size={12} uniProps={foregroundColorMapping} />
              <Text style={styles.badgeText}>BTW</Text>
            </View>
            <Text style={styles.subtitle} numberOfLines={1}>
              {t("sideQuestion.ephemeralHint")}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {turnCount > 0 && !hasPending ? (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  accessibilityRole="button"
                  accessibilityLabel={t("sideQuestion.clearHistory")}
                  onPress={handleClear}
                  style={styles.iconButton}
                  testID="side-question-clear"
                >
                  <ThemedTrash2 size={14} uniProps={mutedColorMapping} />
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={6}>
                  <Text style={styles.tooltipText}>{t("sideQuestion.clearHistory")}</Text>
                </TooltipContent>
              </Tooltip>
            ) : null}
            {turnCount > 0 ? (
              <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                <TooltipTrigger
                  accessibilityRole="button"
                  accessibilityLabel={t("sideQuestion.minimize")}
                  onPress={handleMinimize}
                  style={styles.iconButton}
                  testID="side-question-minimize"
                >
                  <ThemedChevronDown size={15} uniProps={mutedColorMapping} />
                </TooltipTrigger>
                <TooltipContent side="top" align="center" offset={6}>
                  <Text style={styles.tooltipText}>{t("sideQuestion.minimize")}</Text>
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
              <TooltipTrigger
                accessibilityRole="button"
                accessibilityLabel={t("sideQuestion.close")}
                onPress={handleClose}
                style={styles.iconButton}
                testID="side-question-close"
              >
                <ThemedX size={15} uniProps={mutedColorMapping} />
              </TooltipTrigger>
              <TooltipContent side="top" align="center" offset={6}>
                <Text style={styles.tooltipText}>{t("sideQuestion.close")}</Text>
              </TooltipContent>
            </Tooltip>
          </View>
        </View>

        {turnCount === 0 ? (
          <View style={styles.emptyState} testID="side-question-empty">
            <Text style={styles.emptyHintText}>{t("sideQuestion.emptyHint")}</Text>
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            style={styles.bodyScroll}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {thread.turns.map((turn) => (
              <SideQuestionTurnView
                key={turn.id}
                turn={turn}
                onRetry={handleRetry}
                onQuoteToComposer={onQuoteToComposer}
                onForkToBranch={onForkToBranch}
              />
            ))}
          </ScrollView>
        )}

        <View style={styles.footer}>
          <ThemedTextInput
            ref={inputRef}
            value={followUp}
            onChangeText={setFollowUp}
            onSubmitEditing={handleSendFollowUp}
            placeholder={
              turnCount === 0
                ? t("sideQuestion.askPlaceholder")
                : t("sideQuestion.followUpPlaceholder")
            }
            returnKeyType="send"
            editable={!hasPending}
            style={styles.followUpInput}
            testID="side-question-followup-input"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("sideQuestion.sendFollowUp")}
            disabled={hasPending || followUp.trim().length === 0}
            onPress={handleSendFollowUp}
            style={[
              styles.sendButton,
              hasPending || followUp.trim().length === 0 ? styles.sendButtonDisabled : null,
            ]}
            testID="side-question-followup-send"
          >
            <ThemedArrowUp size={14} uniProps={foregroundColorMapping} />
          </Pressable>
        </View>
      </View>
    </View>
  );
});

const SideQuestionTurnView = memo(function SideQuestionTurnView({
  turn,
  onRetry,
  onQuoteToComposer,
  onForkToBranch,
}: {
  turn: SideQuestionTurnEntry;
  onRetry: (turnId: string) => void;
  onQuoteToComposer?: (turn: SideQuestionTurnEntry) => void;
  onForkToBranch?: (turn: SideQuestionTurnEntry) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!turn.response) return;
    void writeMarkdownToRichClipboard(turn.response, getDefaultMarkdownClipboardEnvironment()).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
    );
  }, [turn.response]);

  const handleQuote = useCallback(() => {
    if (!turn.response || !onQuoteToComposer) return;
    onQuoteToComposer(turn);
  }, [onQuoteToComposer, turn]);

  const handleRetryPress = useCallback(() => {
    onRetry(turn.id);
  }, [onRetry, turn.id]);

  const handleForkPress = useCallback(() => {
    onForkToBranch?.(turn);
  }, [onForkToBranch, turn]);

  return (
    <View style={styles.turnContainer} testID={`side-question-turn-${turn.id}`}>
      <View style={styles.questionRow}>
        <Text style={styles.questionPrefix}>/btw</Text>
        <Text style={styles.questionText} selectable>
          {turn.question}
        </Text>
      </View>

      {turn.status === "pending" ? (
        <View style={styles.pendingRow}>
          <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
          <Text style={styles.pendingText}>{t("sideQuestion.thinking")}</Text>
        </View>
      ) : null}

      {turn.status === "error" ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText} selectable>
            {turn.error ?? t("sideQuestion.failed")}
          </Text>
          <View style={styles.turnActions}>
            <Pressable
              accessibilityRole="button"
              onPress={handleRetryPress}
              style={styles.actionChip}
              testID={`side-question-retry-${turn.id}`}
            >
              <ThemedRotateCw size={12} uniProps={mutedColorMapping} />
              <Text style={styles.actionChipText}>{t("common.actions.retry")}</Text>
            </Pressable>
            {onForkToBranch ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleForkPress}
                style={styles.actionChip}
                testID={`side-question-fork-${turn.id}`}
              >
                <ThemedGitBranch size={12} uniProps={mutedColorMapping} />
                <Text style={styles.actionChipText}>{t("sideQuestion.askInBranch")}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {turn.status === "done" && turn.response ? (
        <View style={styles.answerBox}>
          <MarkdownRenderer text={turn.response} compact selectable />
          <View style={styles.turnActions}>
            <Pressable
              accessibilityRole="button"
              onPress={handleCopy}
              style={styles.actionChip}
              testID={`side-question-copy-${turn.id}`}
            >
              {copied ? (
                <ThemedCheck size={12} uniProps={foregroundColorMapping} />
              ) : (
                <ThemedCopy size={12} uniProps={mutedColorMapping} />
              )}
              <Text style={styles.actionChipText}>
                {copied ? t("message.actions.copied") : t("sideQuestion.copyAnswer")}
              </Text>
            </Pressable>
            {onQuoteToComposer ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleQuote}
                style={styles.actionChip}
                testID={`side-question-quote-${turn.id}`}
              >
                <ThemedQuote size={12} uniProps={mutedColorMapping} />
                <Text style={styles.actionChipText}>{t("sideQuestion.quoteResult")}</Text>
              </Pressable>
            ) : null}
            {onForkToBranch ? (
              <Pressable
                accessibilityRole="button"
                onPress={handleForkPress}
                style={styles.actionChip}
                testID={`side-question-fork-${turn.id}`}
              >
                <ThemedGitBranch size={12} uniProps={mutedColorMapping} />
                <Text style={styles.actionChipText}>{t("sideQuestion.continueInBranch")}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: {
      xs: COMPOSER_PILL_MIN_HEIGHT + COMPOSER_PILL_CLEARANCE.compact + 8,
      md: COMPOSER_PILL_MIN_HEIGHT + COMPOSER_PILL_CLEARANCE.wide + 10,
    },
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    zIndex: 20,
  },
  card: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    flexShrink: 0,
  },
  badgeText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  iconButton: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  emptyState: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyHintText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  bodyScroll: {
    maxHeight: 280,
  },
  bodyContent: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[3],
  },
  turnContainer: {
    gap: theme.spacing[2],
  },
  questionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
  },
  questionPrefix: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  questionText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  pendingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorBox: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  answerBox: {
    gap: theme.spacing[2],
  },
  turnActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  actionChipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  followUpInput: {
    flex: 1,
    minHeight: 30,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  sendButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  sendButtonDisabled: {
    opacity: theme.opacity[50],
  },
}));
