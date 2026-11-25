import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { QueryClientContext } from "@tanstack/react-query";
import { ArrowUp, ArrowUpRight } from "lucide-react-native";
import { memo, useCallback, useContext, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useToast } from "@/contexts/toast-context";
import { queryClient as appQueryClient } from "@/data/query-client";
import { APP_SETTINGS_QUERY_KEY, type AppSettings } from "@/hooks/use-settings/storage";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { ActionBarDecisionNeedsYouItem, ActionBarTaskNeedsYouItem } from "./action-bar-model";
import {
  buildDecisionAskCardModel,
  buildTaskAskCardModel,
  type NeedsYouAskOption,
} from "./needs-you-ask-model";
import { useMainChatOverviewStore } from "./overview-store";
import { dispatchMainChatPromptText } from "./queue-panel";

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const activeSubmitIconMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const inactiveSubmitIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const placeholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});
const ThemedInput = withUnistyles(EditingTextInput, placeholderColorMapping);

interface AskRadioRowProps {
  itemId: string;
  option: NeedsYouAskOption;
  selected: boolean;
  disabled: boolean;
  onSelect: (optionId: string) => void;
}

const AskRadioRow = memo(function AskRadioRow({
  itemId,
  option,
  selected,
  disabled,
  onSelect,
}: AskRadioRowProps): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onSelect(option.id);
  }, [onSelect, option.id]);

  const radioOuterStyle = useMemo(
    () => (selected ? [styles.radioOuter, styles.radioOuterSelected] : styles.radioOuter),
    [selected],
  );
  const labelStyle = useMemo(
    () => (selected ? [styles.optionLabel, styles.optionLabelSelected] : styles.optionLabel),
    [selected],
  );
  const rowStyle = useMemo(
    () => (selected ? [styles.optionRow, styles.optionRowSelected] : styles.optionRow),
    [selected],
  );
  const accessibilityState = useMemo(() => ({ selected, disabled }), [disabled, selected]);

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      style={rowStyle}
      highlightStyle={styles.optionRowHover}
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      accessibilityLabel={option.label}
      testID={`main-chat-needs-ask-option-${itemId}-${option.id}`}
    >
      <View style={radioOuterStyle}>{selected ? <View style={styles.radioInnerDot} /> : null}</View>
      <View style={styles.optionTextCol}>
        <View style={styles.optionLabelRow}>
          <Text style={labelStyle}>{option.label}</Text>
          {option.recommended ? (
            <View style={styles.recommendedBadge}>
              <Text style={styles.recommendedBadgeText}>
                {t("mainChat.decisionCard.recommended")}
              </Text>
            </View>
          ) : null}
        </View>
        {option.description ? (
          <Text style={styles.optionDescription}>{option.description}</Text>
        ) : null}
      </View>
    </PressHighlight>
  );
});

async function dispatchAskCardAnswer(params: {
  item: ActionBarDecisionNeedsYouItem | ActionBarTaskNeedsYouItem;
  mainServerId: string;
  mainAgentId: string;
  mainClient: DaemonClient | null;
  targetClient: DaemonClient | null;
  answerText: string;
  decisionOptionId?: string;
  sendBehavior: "interrupt" | "steer";
  supportsForgeSearch: boolean;
  disconnectedMessage: string;
  answerDecision: ReturnType<typeof useMainChatOverviewStore.getState>["answerDecision"];
  loadOverview: ReturnType<typeof useMainChatOverviewStore.getState>["loadOverview"];
}): Promise<void> {
  const { item, mainServerId, mainAgentId, mainClient, targetClient, answerText } = params;
  if (item.kind === "decision") {
    if (!mainClient) {
      throw new Error(params.disconnectedMessage);
    }
    await params.answerDecision(
      mainServerId,
      mainAgentId,
      {
        decisionId: item.decision.id,
        ...(params.decisionOptionId ? { optionId: params.decisionOptionId } : {}),
        answer: answerText,
      },
      mainClient,
    );
    return;
  }

  if (!item.agentId || !targetClient) {
    throw new Error(params.disconnectedMessage);
  }
  await dispatchMainChatPromptText({
    serverId: item.serverId,
    agentId: item.agentId,
    text: answerText,
    client: targetClient,
    sendBehavior: params.sendBehavior,
    supportsForgeAttachments: params.supportsForgeSearch,
  });
  if (mainClient && typeof mainClient.getMainChatOverview === "function") {
    void params.loadOverview(mainServerId, mainAgentId, mainClient).catch(() => undefined);
  }
}

function resolveSubmissionIntent(
  trimmedCustom: string,
  selectedOption: NeedsYouAskOption | null,
):
  | { kind: "dismiss" }
  | { kind: "retry_fallback" }
  | { kind: "send"; answerText: string; decisionOptionId?: string }
  | null {
  if (trimmedCustom.length > 0) {
    return { kind: "send", answerText: trimmedCustom };
  }
  if (!selectedOption) return null;
  if (selectedOption.action === "dismiss") return { kind: "dismiss" };
  if (selectedOption.action === "retry_fallback") return { kind: "retry_fallback" };
  const answerText = (selectedOption.sendText ?? selectedOption.label).trim();
  if (!answerText) return null;
  return {
    kind: "send",
    answerText,
    decisionOptionId: selectedOption.decisionOptionId,
  };
}

export interface NeedsYouAskCardProps {
  item: ActionBarDecisionNeedsYouItem | ActionBarTaskNeedsYouItem;
  mainServerId: string;
  mainAgentId: string;
  isRetrying?: boolean;
  onOpen: () => void;
  onDismiss: (itemId: string) => void;
  onSubmitted?: (itemId: string) => void;
  onRetryWithFallback?: () => void;
}

/**
 * Persona-aligned structured interactive card inside the "Needs you" tray:
 * top category label + clear question + selectable radio options + inline custom input
 * ("或者自己写…") + direct submit button + bottom-right "打开" link.
 */
export const NeedsYouAskCard = memo(function NeedsYouAskCard({
  item,
  mainServerId,
  mainAgentId,
  isRetrying = false,
  onOpen,
  onDismiss,
  onSubmitted,
  onRetryWithFallback,
}: NeedsYouAskCardProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const contextQueryClient = useContext(QueryClientContext);
  const sendBehavior =
    (contextQueryClient ?? appQueryClient).getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)
      ?.sendBehavior === "steer"
      ? "steer"
      : "interrupt";

  const mainClient = useSessionStore((state) => state.sessions[mainServerId]?.client ?? null);
  const targetClient = useSessionStore((state) => state.sessions[item.serverId]?.client ?? null);
  const supportsForgeSearch = useSessionStore(
    (state) => state.sessions[item.serverId]?.serverInfo?.features?.forgeSearch === true,
  );

  const answerDecision = useMainChatOverviewStore((state) => state.answerDecision);
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);

  const model = useMemo(
    () =>
      item.kind === "decision"
        ? buildDecisionAskCardModel(item, t)
        : buildTaskAskCardModel(item, t),
    [item, t],
  );

  const inputRef = useRef<EditingTextInputHandle>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedOption = useMemo(
    () => model.options.find((opt) => opt.id === selectedOptionId) ?? null,
    [model.options, selectedOptionId],
  );

  const trimmedCustom = customText.trim();
  const busy = isSubmitting || isRetrying;
  const canSubmit = !busy && (trimmedCustom.length > 0 || selectedOption !== null);

  const handleSelectOption = useCallback((optionId: string) => {
    setSelectedOptionId(optionId);
    setCustomText("");
    inputRef.current?.reset();
    setSubmitError(null);
  }, []);

  const handleChangeCustomText = useCallback((nextValue: string) => {
    setCustomText(nextValue);
    if (nextValue.trim().length > 0) {
      setSelectedOptionId(null);
    }
    setSubmitError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    const intent = resolveSubmissionIntent(trimmedCustom, selectedOption);
    if (!intent) return;

    // Choosing "先不管" silently collapses & dismisses without sending ANY business command.
    if (intent.kind === "dismiss") {
      setSelectedOptionId(null);
      setCustomText("");
      inputRef.current?.reset();
      onDismiss(item.id);
      return;
    }

    if (intent.kind === "retry_fallback") {
      onRetryWithFallback?.();
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await dispatchAskCardAnswer({
        item,
        mainServerId,
        mainAgentId,
        mainClient,
        targetClient,
        answerText: intent.answerText,
        decisionOptionId: intent.decisionOptionId,
        sendBehavior: sendBehavior === "steer" ? "steer" : "interrupt",
        supportsForgeSearch,
        disconnectedMessage: t("workspace.terminal.hostDisconnected"),
        answerDecision,
        loadOverview,
      });

      setSelectedOptionId(null);
      setCustomText("");
      inputRef.current?.reset();
      toast.show(t("mainChat.actionBar.askCard.replySentToast", { title: item.title }), {
        variant: "success",
      });
      onSubmitted?.(item.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    answerDecision,
    canSubmit,
    item,
    loadOverview,
    mainAgentId,
    mainClient,
    mainServerId,
    onDismiss,
    onRetryWithFallback,
    onSubmitted,
    selectedOption,
    sendBehavior,
    supportsForgeSearch,
    t,
    targetClient,
    toast,
    trimmedCustom,
  ]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const isDanger = model.tone === "danger";
  const kickerTextStyle = useMemo(
    () => (isDanger ? [styles.kickerText, styles.kickerTextDanger] : styles.kickerText),
    [isDanger],
  );
  const submitButtonStyle = useMemo(
    () => (canSubmit ? [styles.submitButton, styles.submitButtonActive] : styles.submitButton),
    [canSubmit],
  );

  return (
    <View style={styles.card} testID={`main-chat-needs-ask-card-${item.id}`}>
      <View style={styles.body}>
        <View style={styles.kickerRow}>
          <View style={isDanger ? styles.kickerDotOuterDanger : styles.kickerDotOuterWarning}>
            <View style={isDanger ? styles.kickerDotInnerDanger : styles.kickerDotInnerWarning} />
          </View>
          <Text
            style={kickerTextStyle}
            numberOfLines={1}
            testID={`main-chat-needs-ask-category-${item.id}`}
          >
            {model.categoryLabel}
          </Text>
        </View>

        <Text style={styles.questionText} testID={`main-chat-needs-ask-question-${item.id}`}>
          {model.question}
        </Text>

        {model.detail ? (
          <View style={styles.detailBox} testID={`main-chat-needs-ask-detail-${item.id}`}>
            <Text style={styles.detailText} numberOfLines={3}>
              {model.detail}
            </Text>
          </View>
        ) : null}

        <View style={styles.optionsList} accessibilityRole="radiogroup">
          {model.options.map((option) => (
            <AskRadioRow
              key={option.id}
              itemId={item.id}
              option={option}
              selected={selectedOptionId === option.id}
              disabled={busy}
              onSelect={handleSelectOption}
            />
          ))}
        </View>
      </View>

      <View style={styles.footer}>
        {model.allowCustomInput ? (
          <ThemedInput
            ref={inputRef}
            initialValue=""
            onChangeText={handleChangeCustomText}
            placeholder={t("mainChat.actionBar.askCard.customInputPlaceholder")}
            editable={!busy}
            returnKeyType="send"
            onSubmitEditing={handleSubmitPress}
            style={styles.customInput}
            accessibilityLabel={t("mainChat.actionBar.askCard.customInputPlaceholder")}
            testID={`main-chat-needs-ask-input-${item.id}`}
          />
        ) : (
          <View style={styles.footerSpacer} />
        )}

        <View style={styles.footerActions}>
          <PressHighlight
            onPress={handleSubmitPress}
            disabled={!canSubmit}
            style={submitButtonStyle}
            highlightStyle={styles.submitButtonPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.actionBar.askCard.submitAction")}
            testID={`main-chat-needs-ask-submit-${item.id}`}
          >
            {busy ? (
              <ThemedSpinner
                size="small"
                uniProps={canSubmit ? activeSubmitIconMapping : mutedIconMapping}
              />
            ) : (
              <ThemedArrowUp
                size={15}
                strokeWidth={2.2}
                uniProps={canSubmit ? activeSubmitIconMapping : inactiveSubmitIconMapping}
              />
            )}
          </PressHighlight>

          {model.canOpenTarget ? (
            <PressHighlight
              onPress={onOpen}
              style={styles.openButton}
              highlightStyle={styles.optionRowHover}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.actionBar.askCard.openAction")}
              testID={`main-chat-needs-ask-open-${item.id}`}
            >
              <Text style={styles.openButtonText}>
                {t("mainChat.actionBar.askCard.openAction")}
              </Text>
              <ThemedArrowUpRight size={12} uniProps={mutedIconMapping} />
            </PressHighlight>
          ) : null}
        </View>
      </View>

      {submitError ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} testID={`main-chat-needs-ask-error-${item.id}`}>
            {submitError}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  body: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: 10,
    gap: theme.spacing[2],
  },
  kickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  kickerDotOuterWarning: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: `${theme.colors.statusWarning}26`,
    alignItems: "center",
    justifyContent: "center",
  },
  kickerDotInnerWarning: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  kickerDotOuterDanger: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: `${theme.colors.statusDanger}26`,
    alignItems: "center",
    justifyContent: "center",
  },
  kickerDotInnerDanger: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
  },
  kickerText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusWarning,
  },
  kickerTextDanger: {
    color: theme.colors.statusDanger,
  },
  questionText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  detailBox: {
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: 10,
    paddingVertical: theme.spacing[1.5],
  },
  detailText: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  optionsList: {
    gap: 2,
    marginTop: 2,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: theme.borderRadius.md,
  },
  optionRowSelected: {
    backgroundColor: theme.colors.surface1,
  },
  optionRowHover: {
    backgroundColor: theme.colors.surface2,
  },
  radioOuter: {
    width: 16,
    height: 16,
    marginTop: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1.5,
    borderColor: theme.colors.borderAccent,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  radioOuterSelected: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  radioInnerDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
  },
  optionTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  optionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  optionLabel: {
    fontSize: 13.5,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
  optionLabelSelected: {
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  recommendedBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: `${theme.colors.statusDotRunning}1c`,
  },
  recommendedBadgeText: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDotRunning,
  },
  optionDescription: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foregroundExtraMuted,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  footerSpacer: {
    flex: 1,
  },
  customInput: {
    flex: 1,
    minWidth: 0,
    height: 30,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    color: theme.colors.foreground,
    backgroundColor: "transparent",
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  submitButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  submitButtonActive: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  submitButtonPressed: {
    opacity: 0.85,
  },
  openButton: {
    height: 28,
    paddingHorizontal: 8,
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  openButtonText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  errorRow: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: `${theme.colors.statusDanger}10`,
  },
  errorText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.statusDanger,
  },
}));
