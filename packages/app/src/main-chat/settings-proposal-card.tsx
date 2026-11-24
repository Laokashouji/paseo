import {
  parseSettingsProposePatchToolPayload,
  type MainChatSettingsProposalChange,
  type MainChatSettingsProposalRecord,
} from "@getpaseo/protocol/main-chat";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  SlidersHorizontal,
  XCircle,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { settingsProposalStoreKey, useMainChatOverviewStore } from "./overview-store";

const ThemedSlidersIcon = withUnistyles(SlidersHorizontal);
const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedRejectIcon = withUnistyles(XCircle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

export interface MainChatSettingsProposalCardProps {
  serverId: string;
  agentId: string;
  output?: unknown;
  /** Optional directly supplied proposal record (useful in tests or ActionBar). */
  proposal?: MainChatSettingsProposalRecord;
  /** Whether a pending proposal starts expanded (default true so user can immediately review diffs). */
  defaultExpanded?: boolean;
  onResolved?: (proposal: MainChatSettingsProposalRecord) => void;
}

const DiffChangeRow = memo(function DiffChangeRow({
  change,
  index,
}: {
  change: MainChatSettingsProposalChange;
  index: number;
}): ReactElement {
  return (
    <View
      style={[styles.diffRow, index > 0 && styles.diffRowBorder]}
      testID={`settings-proposal-change-${change.key}`}
    >
      <View style={styles.diffLabelCol}>
        <Text style={styles.diffLabel} numberOfLines={2}>
          {change.label}
        </Text>
        <Text style={styles.diffKey} numberOfLines={1}>
          {change.key}
        </Text>
      </View>
      <View style={styles.diffValuesRow}>
        <View style={styles.beforePill}>
          <Text style={styles.beforeText} numberOfLines={2}>
            {change.beforeDisplay}
          </Text>
        </View>
        <Text style={styles.diffArrow}>→</Text>
        <View style={styles.afterPill}>
          <Text style={styles.afterText} numberOfLines={2}>
            {change.afterDisplay}
          </Text>
        </View>
      </View>
    </View>
  );
});

const ProposalStatusIcon = memo(function ProposalStatusIcon({
  status,
  size,
}: {
  status: MainChatSettingsProposalRecord["status"];
  size: number;
}): ReactElement {
  if (status === "pending") {
    return <ThemedSlidersIcon size={size} uniProps={warningIconMapping} />;
  }
  if (status === "approved") {
    return <ThemedCheckIcon size={size} uniProps={successIconMapping} />;
  }
  return <ThemedRejectIcon size={size} uniProps={mutedIconMapping} />;
});

function resolveProposalBadgeMeta(
  status: MainChatSettingsProposalRecord["status"],
  t: (key: string) => string,
): { variant: "warning" | "success" | "muted"; label: string } {
  if (status === "pending") {
    return { variant: "warning", label: t("mainChat.settingsProposalCard.badgePending") };
  }
  if (status === "approved") {
    return { variant: "success", label: t("mainChat.settingsProposalCard.badgeApproved") };
  }
  return { variant: "muted", label: t("mainChat.settingsProposalCard.badgeRejected") };
}

const CompactProposalCard = memo(function CompactProposalCard({
  effective,
  onExpand,
}: {
  effective: MainChatSettingsProposalRecord;
  onExpand: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isApproved = effective.status === "approved";
  const resolvedSummary = isApproved
    ? t("mainChat.settingsProposalCard.approvedSummary", { count: effective.changes.length })
    : t("mainChat.settingsProposalCard.rejectedSummary", { count: effective.changes.length });
  const badge = resolveProposalBadgeMeta(effective.status, t);

  return (
    <View style={styles.compactCard} testID={`main-chat-settings-proposal-card-${effective.id}`}>
      <PressHighlight
        onPress={onExpand}
        style={styles.compactToggle}
        highlightStyle={styles.subtleHighlight}
        accessibilityRole="button"
        accessibilityState={COLLAPSED_STATE}
        accessibilityLabel={`${effective.title} · ${resolvedSummary}`}
        testID={`main-chat-settings-proposal-toggle-${effective.id}`}
      >
        <ProposalStatusIcon status={effective.status} size={15} />
        <StatusBadge variant={badge.variant} size="xs" label={badge.label} />
        <Text style={styles.compactTitle} numberOfLines={1} ellipsizeMode="tail">
          {effective.title}
        </Text>
        <Text style={styles.compactMeta} numberOfLines={1} ellipsizeMode="tail">
          {resolvedSummary}
        </Text>
        <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

const ProposalActionsRow = memo(function ProposalActionsRow({
  proposalId,
  submitting,
  disabled,
  onApprove,
  onReject,
}: {
  proposalId: string;
  submitting: "approve" | "reject" | null;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.actionsRow}>
      <Button
        variant="default"
        size="sm"
        onPress={onApprove}
        disabled={disabled}
        loading={submitting === "approve"}
        testID={`main-chat-settings-proposal-approve-${proposalId}`}
      >
        {submitting === "approve"
          ? t("mainChat.settingsProposalCard.approvingButton")
          : t("mainChat.settingsProposalCard.approveButton")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onPress={onReject}
        disabled={disabled}
        loading={submitting === "reject"}
        testID={`main-chat-settings-proposal-reject-${proposalId}`}
      >
        {submitting === "reject"
          ? t("mainChat.settingsProposalCard.rejectingButton")
          : t("mainChat.settingsProposalCard.rejectButton")}
      </Button>
    </View>
  );
});

/**
 * Native Main Chat inline approval card for `settings_propose_patch`.
 * Never persists silently: presents a clear before → after diff table in the full-width
 * chat rail and applies changes only when the user explicitly clicks Approve.
 */
export const MainChatSettingsProposalCard = memo(function MainChatSettingsProposalCard({
  serverId,
  agentId,
  output,
  proposal: directProposal,
  defaultExpanded = true,
  onResolved,
}: MainChatSettingsProposalCardProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();

  const parsed = useMemo(
    () => (directProposal ? null : parseSettingsProposePatchToolPayload(output)),
    [directProposal, output],
  );
  const proposalId = directProposal?.id ?? parsed?.id ?? null;

  const storedProposal = useMainChatOverviewStore((state) =>
    proposalId
      ? (state.settingsProposalsByKey[settingsProposalStoreKey(serverId, proposalId)] ?? null)
      : null,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const resolveSettingsProposal = useMainChatOverviewStore(
    (state) => state.resolveSettingsProposal,
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  const effective = storedProposal ?? directProposal ?? parsed;
  const isPending = effective?.status === "pending";

  const [expanded, setExpanded] = useState(() => (isPending ? defaultExpanded : false));
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !proposalId || storedProposal || directProposal) return;
    void loadOverview(serverId, agentId, client);
  }, [agentId, client, directProposal, loadOverview, proposalId, serverId, storedProposal]);

  const handleToggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleResolve = useCallback(
    (decision: "approve" | "reject") => {
      if (!effective || !client || submitting) return;
      setSubmitting(decision);
      setSubmitError(null);
      void resolveSettingsProposal(
        serverId,
        agentId,
        { proposalId: effective.id, decision },
        client,
      )
        .then((resolved) => {
          toast.show(
            decision === "approve"
              ? t("mainChat.settingsProposalCard.approvedToast")
              : t("mainChat.settingsProposalCard.rejectedToast"),
            { variant: decision === "approve" ? "success" : "info" },
          );
          setExpanded(false);
          onResolved?.(resolved);
          return resolved;
        })
        .catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : t("mainChat.settingsProposalCard.resolveFailed");
          setSubmitError(message);
          toast.error(message);
        })
        .finally(() => {
          setSubmitting(null);
        });
    },
    [
      agentId,
      client,
      effective,
      onResolved,
      resolveSettingsProposal,
      serverId,
      submitting,
      t,
      toast,
    ],
  );

  const handleApprove = useCallback(() => {
    handleResolve("approve");
  }, [handleResolve]);

  const handleReject = useCallback(() => {
    handleResolve("reject");
  }, [handleResolve]);

  if (!effective) return null;

  if (!isPending && !expanded) {
    return <CompactProposalCard effective={effective} onExpand={handleToggleExpand} />;
  }

  const badge = resolveProposalBadgeMeta(effective.status, t);
  const resolvedNote = effective.status === "rejected" ? effective.resolvedNote : null;

  return (
    <View style={styles.card} testID={`main-chat-settings-proposal-card-${effective.id}`}>
      <View style={styles.headerRow}>
        <View style={styles.headerLeading}>
          <ProposalStatusIcon status={effective.status} size={16} />
          <View style={styles.headerTextCol}>
            <View style={styles.headerTitleLine}>
              <Text style={styles.title} numberOfLines={2}>
                {effective.title}
              </Text>
              <StatusBadge variant={badge.variant} size="xs" label={badge.label} />
            </View>
            <Text style={styles.subtitle} numberOfLines={1}>
              {t("mainChat.settingsProposalCard.headerSubtitle")}
            </Text>
          </View>
        </View>
        {!isPending ? (
          <PressHighlight
            onPress={handleToggleExpand}
            style={styles.collapseButton}
            highlightStyle={styles.subtleHighlight}
            accessibilityRole="button"
            accessibilityState={EXPANDED_STATE}
            accessibilityLabel={t("mainChat.settingsProposalCard.collapseDetails")}
            testID={`main-chat-settings-proposal-toggle-${effective.id}`}
          >
            <ThemedChevronDown size={15} uniProps={mutedIconMapping} />
          </PressHighlight>
        ) : null}
      </View>

      <Text style={styles.reason}>{effective.reason}</Text>

      <View style={styles.diffBox}>
        {effective.changes.map((change, index) => (
          <DiffChangeRow key={change.key} change={change} index={index} />
        ))}
      </View>

      {isPending ? (
        <ProposalActionsRow
          proposalId={effective.id}
          submitting={submitting}
          disabled={submitting !== null || !client}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      ) : null}

      {resolvedNote ? <Text style={styles.resolvedNote}>{resolvedNote}</Text> : null}

      {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    width: "100%",
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  compactCard: {
    width: "100%",
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  compactToggle: {
    width: "100%",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    paddingVertical: 2,
  },
  compactTitle: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  compactMeta: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  headerLeading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  headerTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  headerTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  subtitle: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  collapseButton: {
    padding: 4,
    borderRadius: theme.borderRadius.md,
  },
  subtleHighlight: {
    backgroundColor: theme.colors.surface2,
  },
  reason: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  diffBox: {
    width: "100%",
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  diffRow: {
    width: "100%",
    minWidth: 0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  diffRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  diffLabelCol: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  diffLabel: {
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  diffKey: {
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.foregroundMuted,
  },
  diffValuesRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  beforePill: {
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  beforeText: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  diffArrow: {
    fontSize: 13,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  afterPill: {
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.statusSuccessTint,
    borderWidth: 1,
    borderColor: theme.colors.statusSuccess,
  },
  afterText: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  resolvedNote: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.statusDanger,
  },
}));
