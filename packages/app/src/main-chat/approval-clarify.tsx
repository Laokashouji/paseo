import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatApprovalClarification,
  MainChatPermissionRuleCandidate,
  MainChatRuleSuggestion,
} from "@getpaseo/protocol/main-chat";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  History,
  Info,
  ShieldCheck,
  Sparkles,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";

const ThemedHelpIcon = withUnistyles(Info);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedClockIcon = withUnistyles(History);
const ThemedSendIcon = withUnistyles(ArrowUpRight);
const ThemedSparklesIcon = withUnistyles(Sparkles);
const ThemedShieldIcon = withUnistyles(ShieldCheck);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const placeholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});
const ThemedTextInput = withUnistyles(EditingTextInput, placeholderColorMapping);
const clockLeadingIcon = <ThemedClockIcon size={10} uniProps={warningIconMapping} />;
const sendButtonIcon = <ThemedSendIcon size={12} uniProps={primaryIconMapping} />;
const shieldButtonIcon = <ThemedShieldIcon size={12} uniProps={successIconMapping} />;

export function formatPausedDeadlineLabel(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return isoTimestamp;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/**
 * Merges persisted `overview.pendingClarifications` with locally returned clarifications for a
 * specific child permission request, deduplicating by `id` in chronological order.
 */
export function selectClarificationsForPermission(input: {
  persisted: readonly MainChatApprovalClarification[] | undefined;
  local: readonly MainChatApprovalClarification[];
  agentId: string;
  permissionRequestId: string;
}): MainChatApprovalClarification[] {
  const byId = new Map<string, MainChatApprovalClarification>();
  for (const item of input.persisted ?? []) {
    if (item.agentId === input.agentId && item.permissionRequestId === input.permissionRequestId) {
      byId.set(item.id, item);
    }
  }
  for (const item of input.local) {
    if (item.agentId === input.agentId && item.permissionRequestId === input.permissionRequestId) {
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

/**
 * Finds the best matching undismissed rule suggestion for a permission card. Prioritizes an exact
 * tool + commandPrefix match, then falls back to an undismissed permission suggestion for the host.
 */
export function findMatchingRuleSuggestion(input: {
  suggestions: readonly MainChatRuleSuggestion[] | undefined;
  resolvedIds?: ReadonlySet<string>;
  serverId: string;
  permissionToolName?: string | null;
  ruleCandidate?: MainChatPermissionRuleCandidate | null;
}): MainChatRuleSuggestion | null {
  const active = (input.suggestions ?? []).filter(
    (item) =>
      item.dismissedAt === null &&
      item.scope === "permission" &&
      !input.resolvedIds?.has(item.id) &&
      (!item.serverId || item.serverId === input.serverId),
  );
  if (active.length === 0) return null;

  const targetTool = (input.ruleCandidate?.toolName ?? input.permissionToolName ?? "")
    .trim()
    .toLowerCase();
  const targetPrefix = input.ruleCandidate?.commandPrefix?.trim().toLowerCase() ?? null;

  if (targetTool) {
    const exactMatch = active.find((item) => {
      const itemTool = item.toolName?.trim().toLowerCase() ?? "";
      if (itemTool !== targetTool) return false;
      if (!item.commandPrefix) return true;
      return item.commandPrefix.trim().toLowerCase() === targetPrefix;
    });
    if (exactMatch) return exactMatch;
  }

  return active[0] ?? null;
}

interface ClarificationEntryCardProps {
  clarification: MainChatApprovalClarification;
}

const ClarificationEntryCard = memo(function ClarificationEntryCard({
  clarification,
}: ClarificationEntryCardProps): ReactElement {
  const { t } = useTranslation();
  const pausedTime = formatPausedDeadlineLabel(clarification.pausedDeadlineAt);

  return (
    <View style={styles.entryCard} testID={`approval-clarify-entry-${clarification.id}`}>
      <View style={styles.pausedRow} testID={`approval-clarify-paused-${clarification.id}`}>
        <StatusBadge
          size="xs"
          variant="warning"
          leading={clockLeadingIcon}
          label={t("mainChat.clarify.pausedBadge")}
        />
        <Text style={styles.pausedDeadlineText}>
          {t("mainChat.clarify.pausedUntil", { time: pausedTime })}
        </Text>
      </View>

      <Text style={styles.questionText}>
        <Text style={styles.entryLabel}>{t("mainChat.clarify.questionPrefix")}: </Text>
        {clarification.question}
      </Text>

      {clarification.answer ? (
        <Text style={styles.answerText} testID={`approval-clarify-answer-${clarification.id}`}>
          <Text style={styles.entryLabel}>{t("mainChat.clarify.answerPrefix")}: </Text>
          {clarification.answer}
        </Text>
      ) : (
        <Text style={styles.pendingAnswerText}>{t("mainChat.clarify.answerPending")}</Text>
      )}
    </View>
  );
});

async function refreshOverviewQuietly(
  loadOverview: (serverId: string, mainAgentId: string, client: DaemonClient) => Promise<unknown>,
  serverId: string,
  mainAgentId: string | null | undefined,
  client: DaemonClient,
): Promise<void> {
  if (!mainAgentId || typeof client.getMainChatOverview !== "function") return;
  try {
    await loadOverview(serverId, mainAgentId, client);
  } catch {
    // Overview refresh failures are non-fatal after the primary mutation succeeded.
  }
}

export interface ApprovalClarifySectionProps {
  serverId: string;
  mainAgentId: string;
  agentId: string;
  permissionRequestId: string;
  client: DaemonClient | null;
  /** Optional externally provided clarifications (primarily for isolated tests). */
  persistedClarifications?: readonly MainChatApprovalClarification[];
  onClarificationRecorded?: (clarification: MainChatApprovalClarification) => void;
}

/**
 * Collapsible "Have a question" approval clarification flow rendered at the bottom of child
 * permission cards. Submitting a question pauses escalation countdown (`pausedDeadlineAt`) and
 * displays the returned clarification answer inline before the user approves or denies.
 */
export const ApprovalClarifySection = memo(function ApprovalClarifySection({
  serverId,
  mainAgentId,
  agentId,
  permissionRequestId,
  client,
  persistedClarifications: explicitPersisted,
  onClarificationRecorded,
}: ApprovalClarifySectionProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const overviewKey = overviewStoreKey(serverId, mainAgentId);
  const storePersisted = useMainChatOverviewStore(
    (state) => state.overviewsByKey[overviewKey]?.pendingClarifications,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);

  const inputRef = useRef<EditingTextInputHandle>(null);
  const [localClarifications, setLocalClarifications] = useState<MainChatApprovalClarification[]>(
    [],
  );
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [questionDraft, setQuestionDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const clarifications = useMemo(
    () =>
      selectClarificationsForPermission({
        persisted: explicitPersisted ?? storePersisted,
        local: localClarifications,
        agentId,
        permissionRequestId,
      }),
    [agentId, explicitPersisted, localClarifications, permissionRequestId, storePersisted],
  );

  const isExpanded = userExpanded ?? clarifications.length > 0;
  const canSubmit = Boolean(client && questionDraft.trim().length > 0 && !submitting);

  const handleToggle = useCallback(() => {
    setUserExpanded((current) => !(current ?? clarifications.length > 0));
  }, [clarifications.length]);

  const runSubmit = useCallback(async () => {
    const trimmed = questionDraft.trim();
    if (!client || !trimmed || submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await client.clarifyMainChatPermission({
        agentId,
        serverId,
        permissionRequestId,
        question: trimmed,
      });
      if (response.error || !response.clarification) {
        throw new Error(response.error ?? t("mainChat.clarify.submitFailed"));
      }
      const created = response.clarification;
      setLocalClarifications((prev) => [...prev, created]);
      inputRef.current?.reset();
      setQuestionDraft("");
      setUserExpanded(true);
      onClarificationRecorded?.(created);
      await refreshOverviewQuietly(loadOverview, serverId, mainAgentId, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("mainChat.clarify.submitFailed");
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }, [
    agentId,
    client,
    loadOverview,
    mainAgentId,
    onClarificationRecorded,
    permissionRequestId,
    questionDraft,
    serverId,
    submitting,
    t,
    toast,
  ]);

  const handleSubmit = useCallback(() => {
    void runSubmit();
  }, [runSubmit]);

  if (!client && clarifications.length === 0) {
    return null;
  }

  return (
    <View style={styles.clarifyContainer} testID={`approval-clarify-${permissionRequestId}`}>
      <PressHighlight
        onPress={handleToggle}
        style={styles.toggleRow}
        highlightStyle={styles.toggleRowPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.clarify.toggleButton")}
        testID={`approval-clarify-toggle-${permissionRequestId}`}
      >
        <View style={styles.toggleLeft}>
          <ThemedHelpIcon size={13} uniProps={primaryIconMapping} />
          <Text style={styles.toggleLabel}>{t("mainChat.clarify.toggleButton")}</Text>
          {clarifications.length > 0 ? (
            <StatusBadge size="xs" variant="warning" label={t("mainChat.clarify.pausedBadge")} />
          ) : null}
        </View>
        {isExpanded ? (
          <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
        )}
      </PressHighlight>

      {isExpanded ? (
        <View style={styles.expandedBody} testID={`approval-clarify-body-${permissionRequestId}`}>
          {clarifications.map((item) => (
            <ClarificationEntryCard key={item.id} clarification={item} />
          ))}

          {client ? (
            <View style={styles.inputRow}>
              <ThemedTextInput
                ref={inputRef}
                initialValue={questionDraft}
                onChangeText={setQuestionDraft}
                placeholder={t("mainChat.clarify.inputPlaceholder")}
                style={styles.questionInput}
                editable={!submitting}
                returnKeyType="send"
                onSubmitEditing={handleSubmit}
                testID={`approval-clarify-input-${permissionRequestId}`}
              />
              <Button
                variant="secondary"
                size="sm"
                leftIcon={sendButtonIcon}
                loading={submitting}
                disabled={!canSubmit}
                onPress={handleSubmit}
                testID={`approval-clarify-submit-${permissionRequestId}`}
              >
                {t("mainChat.clarify.submitButton")}
              </Button>
            </View>
          ) : null}

          {errorMessage ? (
            <Text style={styles.errorText} testID={`approval-clarify-error-${permissionRequestId}`}>
              {errorMessage}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

export interface RuleSuggestionBannerProps {
  serverId: string;
  mainAgentId?: string | null;
  suggestion: MainChatRuleSuggestion;
  client: DaemonClient | null;
  onResolved?: (outcome: "granted" | "dismissed", suggestionId: string) => void;
}

/**
 * Compact progressive rule suggestion row surfaced below permission cards or in overview panels
 * when the user has repeatedly approved similar safe operations.
 */
export const RuleSuggestionBanner = memo(function RuleSuggestionBanner({
  serverId,
  mainAgentId,
  suggestion,
  client,
  onResolved,
}: RuleSuggestionBannerProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const [busyAction, setBusyAction] = useState<"adopt" | "dismiss" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runAdopt = useCallback(async () => {
    if (!client || busyAction !== null) return;
    setBusyAction("adopt");
    setErrorMessage(null);
    try {
      const response = await client.grantMainChatStandingAuthorization({
        scope: suggestion.scope,
        serverId: suggestion.serverId,
        cwd: suggestion.cwd,
        allowSubdirectories: true,
        toolName: suggestion.toolName,
        commandPrefix: suggestion.commandPrefix,
        mode: suggestion.mode,
        label: suggestion.label,
        reason: suggestion.reason,
        suggestionId: suggestion.id,
      });
      if (response.error || !response.authorization) {
        throw new Error(response.error ?? t("mainChat.clarify.actionFailed"));
      }
      toast.show(t("mainChat.clarify.adoptedToast"), { variant: "success" });
      onResolved?.("granted", suggestion.id);
      await refreshOverviewQuietly(loadOverview, serverId, mainAgentId, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("mainChat.clarify.actionFailed");
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, client, loadOverview, mainAgentId, onResolved, serverId, suggestion, t, toast]);

  const handleAdopt = useCallback(() => {
    void runAdopt();
  }, [runAdopt]);

  const runDismiss = useCallback(async () => {
    if (!client || busyAction !== null) return;
    setBusyAction("dismiss");
    setErrorMessage(null);
    try {
      const response = await client.dismissMainChatRuleSuggestion(suggestion.id);
      if (response.error || !response.dismissed) {
        throw new Error(response.error ?? t("mainChat.clarify.actionFailed"));
      }
      toast.show(t("mainChat.clarify.dismissedToast"), { variant: "info" });
      onResolved?.("dismissed", suggestion.id);
      await refreshOverviewQuietly(loadOverview, serverId, mainAgentId, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("mainChat.clarify.actionFailed");
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setBusyAction(null);
    }
  }, [
    busyAction,
    client,
    loadOverview,
    mainAgentId,
    onResolved,
    serverId,
    suggestion.id,
    t,
    toast,
  ]);

  const handleDismiss = useCallback(() => {
    void runDismiss();
  }, [runDismiss]);

  return (
    <View style={styles.suggestionCard} testID={`rule-suggestion-banner-${suggestion.id}`}>
      <View style={styles.suggestionHeader}>
        <ThemedSparklesIcon size={13} uniProps={successIconMapping} />
        <View style={styles.suggestionTextWrap}>
          <Text style={styles.suggestionTitle}>
            {t("mainChat.clarify.ruleSuggestionTitle", { count: suggestion.observedCount })}
          </Text>
          <Text style={styles.suggestionSubtitle} numberOfLines={2}>
            {suggestion.label}
            {suggestion.reason ? ` · ${suggestion.reason}` : ""}
          </Text>
        </View>
      </View>

      <View style={styles.suggestionActions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={shieldButtonIcon}
          loading={busyAction === "adopt"}
          disabled={!client || busyAction !== null}
          onPress={handleAdopt}
          testID={`rule-suggestion-adopt-${suggestion.id}`}
        >
          {t("mainChat.clarify.adoptRuleButton")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={busyAction === "dismiss"}
          disabled={!client || busyAction !== null}
          onPress={handleDismiss}
          testID={`rule-suggestion-dismiss-${suggestion.id}`}
        >
          {t("mainChat.clarify.dismissRuleButton")}
        </Button>
      </View>

      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  clarifyContainer: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  toggleRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  toggleLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  toggleLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  expandedBody: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  entryCard: {
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  pausedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  pausedDeadlineText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
  },
  entryLabel: {
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  questionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  answerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 19,
  },
  pendingAnswerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  questionInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  suggestionCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  suggestionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
  },
  suggestionTextWrap: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  suggestionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  suggestionSubtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  suggestionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
}));
