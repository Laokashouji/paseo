import type {
  MainChatProjectLesson,
  MainChatRuleDiagnostic,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  CornerDownRight,
  GitPullRequest,
  Lock,
  Play,
  RefreshCw,
  Repeat,
} from "lucide-react-native";
import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  countProjectLessonsForTask,
  deriveDeliveryGateBadge,
  deriveTaskDagSummary,
  type DeliveryGateBadgeDescriptor,
  type TaskDagSummary,
} from "./task-dag-ui";
import {
  canRetryManagedFailedTask,
  deriveZeroTokenDiagnosticBadge,
  type ZeroTokenDiagnosticBadgeDescriptor,
} from "./zero-token-diagnostic-ui";

const ThemedAlert = withUnistyles(AlertTriangle);
const ThemedBook = withUnistyles(BookOpen);
const ThemedCheck = withUnistyles(CheckCircle2);
const ThemedBranch = withUnistyles(CornerDownRight);
const ThemedPr = withUnistyles(GitPullRequest);
const ThemedLock = withUnistyles(Lock);
const ThemedPlay = withUnistyles(Play);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedRepeat = withUnistyles(Repeat);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const LOCK_LEADING_ICON = <ThemedLock size={11} uniProps={warningIconMapping} />;
const PLAY_LEADING_ICON = <ThemedPlay size={11} uniProps={successIconMapping} />;
const PR_DANGER_LEADING_ICON = <ThemedPr size={11} uniProps={dangerIconMapping} />;
const PR_SUCCESS_LEADING_ICON = <ThemedPr size={11} uniProps={successIconMapping} />;
const PR_WARNING_LEADING_ICON = <ThemedPr size={11} uniProps={warningIconMapping} />;
const LOOP_DANGER_LEADING_ICON = <ThemedRepeat size={11} uniProps={dangerIconMapping} />;
const RULE_WARNING_LEADING_ICON = <ThemedAlert size={11} uniProps={warningIconMapping} />;
const RETRY_LEADING_ICON = <ThemedRefreshCw size={12} uniProps={mutedIconMapping} />;

function resolvePrLeadingIcon(gate: DeliveryGateBadgeDescriptor): ReactElement {
  if (gate.isBlocked) return PR_DANGER_LEADING_ICON;
  if (gate.isMerged) return PR_SUCCESS_LEADING_ICON;
  return PR_WARNING_LEADING_ICON;
}

function resolveChildStatusBadge(
  child: MainChatTaskRecord,
  childDag: TaskDagSummary,
): { variant: StatusBadgeVariant; labelKey: string } | null {
  if (child.status === "completed") {
    return { variant: "success", labelKey: "mainChat.taskStatus.done" };
  }
  if (childDag.dependencyState === "blocked") {
    return { variant: "warning", labelKey: "mainChat.taskDag.blockedBadge" };
  }
  if (childDag.dependencyState === "ready") {
    return { variant: "success", labelKey: "mainChat.taskDag.readyBadge" };
  }
  return null;
}

export interface TaskDrawerGovernanceStripProps {
  task: MainChatTaskRecord;
  allTasks: readonly MainChatTaskRecord[] | undefined;
  projectLessons: readonly MainChatProjectLesson[] | undefined;
  ruleDiagnostic?: MainChatRuleDiagnostic | null;
  isFailed?: boolean;
  isMutatingTask: boolean;
  onStartReadyTask: (taskId: string) => void;
  onRetryWithFallback?: (taskId: string) => void;
  onSelectRelatedTask: (task: MainChatTaskRecord) => void;
}

const ChildSliceRow = memo(function ChildSliceRow({
  child,
  allTasks,
  isMutatingTask,
  onStartReadyTask,
  onSelectRelatedTask,
}: {
  child: MainChatTaskRecord;
  allTasks: readonly MainChatTaskRecord[] | undefined;
  isMutatingTask: boolean;
  onStartReadyTask: (taskId: string) => void;
  onSelectRelatedTask: (task: MainChatTaskRecord) => void;
}) {
  const { t } = useTranslation();
  const childDag = useMemo(() => deriveTaskDagSummary(child, allTasks), [allTasks, child]);
  const childGate = useMemo(
    () => deriveDeliveryGateBadge(child.deliveryGate),
    [child.deliveryGate],
  );
  const statusBadge = resolveChildStatusBadge(child, childDag);
  const canOpen = Boolean(child.activeAgentId || child.agentIds.length > 0);

  const handleOpen = useCallback(() => {
    if (canOpen) onSelectRelatedTask(child);
  }, [canOpen, child, onSelectRelatedTask]);
  const handleStart = useCallback(() => {
    onStartReadyTask(child.id);
  }, [child.id, onStartReadyTask]);

  return (
    <View style={styles.childSliceRow} testID={`main-chat-task-drawer-child-${child.id}`}>
      <PressHighlight
        onPress={handleOpen}
        disabled={!canOpen}
        style={styles.childSlicePress}
        highlightStyle={styles.rowPressed}
        accessibilityRole="button"
        accessibilityLabel={child.title}
      >
        <ThemedBranch size={12} uniProps={mutedIconMapping} />
        <View style={styles.childSliceTextCol}>
          <View style={styles.childSliceTitleRow}>
            <Text style={styles.childSliceTitle} numberOfLines={1}>
              {child.title}
            </Text>
            {statusBadge ? (
              <StatusBadge
                size="xs"
                variant={statusBadge.variant}
                label={t(statusBadge.labelKey)}
              />
            ) : null}
            {childGate ? (
              <StatusBadge
                size="xs"
                variant={childGate.variant}
                label={`${childGate.prRef} ${t(childGate.statusKey)}`}
              />
            ) : null}
          </View>
          {childDag.dependencyState === "blocked" && childDag.blockedByTitles.length > 0 ? (
            <Text style={styles.childSliceMeta} numberOfLines={1}>
              {t("mainChat.taskDag.blockedMeta", {
                deps: childDag.blockedByTitles.join("、"),
              })}
            </Text>
          ) : null}
        </View>
      </PressHighlight>

      {childDag.canStartReady ? (
        <Button
          variant="secondary"
          size="sm"
          leftIcon={ThemedPlay}
          disabled={isMutatingTask}
          onPress={handleStart}
          testID={`main-chat-task-drawer-child-start-${child.id}`}
        >
          {t("mainChat.taskDag.startReadyAction")}
        </Button>
      ) : null}
    </View>
  );
});

const GovernanceHeaderBadges = memo(function GovernanceHeaderBadges({
  dag,
  gateBadge,
  diagnosticBadge,
  matchedLessonCount,
  onOpenParent,
  onOpenLessons,
}: {
  dag: TaskDagSummary;
  gateBadge: DeliveryGateBadgeDescriptor | null;
  diagnosticBadge: ZeroTokenDiagnosticBadgeDescriptor | null;
  matchedLessonCount: number;
  onOpenParent: () => void;
  onOpenLessons: () => void;
}) {
  const { t } = useTranslation();
  const canOpenParent = Boolean(dag.parentTask?.activeAgentId || dag.parentTask?.agentIds.length);
  const childrenLabel = dag.allChildrenDone
    ? t("mainChat.taskDag.parentCloseoutReady")
    : t("mainChat.taskDag.childrenProgress", {
        done: dag.childrenCompleted,
        total: dag.childrenTotal,
      });
  const lessonsLabel =
    matchedLessonCount > 0
      ? t("mainChat.projectLessons.entryButtonWithCount", { count: matchedLessonCount })
      : t("mainChat.projectLessons.entryButton");

  return (
    <View style={styles.badgeHeaderRow}>
      <View style={styles.badgeWrap}>
        {dag.partOf ? (
          <PressHighlight
            onPress={onOpenParent}
            disabled={!canOpenParent}
            style={styles.parentChip}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            testID="main-chat-task-drawer-parent-link"
          >
            <ThemedBranch size={11} uniProps={mutedIconMapping} />
            <Text style={styles.parentChipText} numberOfLines={1}>
              {t("mainChat.taskDag.partOfLabel", { title: dag.parentTitle ?? dag.partOf })}
            </Text>
          </PressHighlight>
        ) : null}

        {dag.childrenTotal > 0 ? (
          <StatusBadge
            size="xs"
            variant={dag.allChildrenDone ? "success" : "muted"}
            label={childrenLabel}
          />
        ) : null}

        {dag.dependencyState === "blocked" ? (
          <StatusBadge
            size="xs"
            variant="warning"
            leading={LOCK_LEADING_ICON}
            label={t("mainChat.taskDag.blockedBadge")}
          />
        ) : null}

        {dag.dependencyState === "ready" ? (
          <StatusBadge
            size="xs"
            variant="success"
            leading={PLAY_LEADING_ICON}
            label={t("mainChat.taskDag.readyBadge")}
          />
        ) : null}

        {gateBadge ? (
          <View testID="main-chat-task-drawer-delivery-gate-badge">
            <StatusBadge
              size="xs"
              variant={gateBadge.variant}
              leading={resolvePrLeadingIcon(gateBadge)}
              label={`${gateBadge.prRef} · ${t(gateBadge.statusKey)}`}
            />
          </View>
        ) : null}

        {gateBadge?.followUpActive && !gateBadge.isMerged ? (
          <StatusBadge size="xs" variant="muted" label={t("mainChat.deliveryGate.followUpBadge")} />
        ) : null}

        {diagnosticBadge ? (
          <View testID={`main-chat-task-drawer-rule-badge-${diagnosticBadge.kind}`}>
            <StatusBadge
              size="xs"
              variant={diagnosticBadge.variant}
              leading={
                diagnosticBadge.kind === "tool_loop"
                  ? LOOP_DANGER_LEADING_ICON
                  : RULE_WARNING_LEADING_ICON
              }
              label={t(diagnosticBadge.labelKey)}
            />
          </View>
        ) : null}
      </View>

      <PressHighlight
        onPress={onOpenLessons}
        style={styles.lessonsEntryBtn}
        highlightStyle={styles.rowPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.projectLessons.sectionTitle")}
        testID="main-chat-task-drawer-lessons-entry"
      >
        <ThemedBook size={12} uniProps={mutedIconMapping} />
        <Text style={styles.lessonsEntryText} numberOfLines={1}>
          {lessonsLabel}
        </Text>
      </PressHighlight>
    </View>
  );
});

const GovernanceDeliveryGateDetail = memo(function GovernanceDeliveryGateDetail({
  gateBadge,
}: {
  gateBadge: DeliveryGateBadgeDescriptor;
}) {
  const { t } = useTranslation();
  const detailStyle = useMemo(
    () => [styles.gateDetailBox, gateBadge.isBlocked && styles.gateDetailBoxBlocked],
    [gateBadge.isBlocked],
  );

  return (
    <View style={detailStyle} testID="main-chat-task-drawer-delivery-gate-detail">
      {gateBadge.blockers.length > 0 ? (
        <View style={styles.gateBlockersList}>
          {gateBadge.blockers.map((blocker) => (
            <View key={blocker} style={styles.gateBlockerLine}>
              <ThemedAlert size={12} uniProps={dangerIconMapping} />
              <Text style={styles.gateBlockerText}>{blocker}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {gateBadge.followUpActive && !gateBadge.isMerged ? (
        <Text style={styles.gateFollowUpText}>{t("mainChat.deliveryGate.followUpNote")}</Text>
      ) : null}
    </View>
  );
});

const GovernanceDiagnosticDetail = memo(function GovernanceDiagnosticDetail({
  diagnosticBadge,
}: {
  diagnosticBadge: ZeroTokenDiagnosticBadgeDescriptor;
}): ReactElement {
  const { t } = useTranslation();
  const isDanger = diagnosticBadge.variant === "error";
  const boxStyle = useMemo(
    () => [
      styles.diagnosticBox,
      isDanger ? styles.diagnosticBoxDanger : styles.diagnosticBoxWarning,
    ],
    [isDanger],
  );
  const metaParts: string[] = [];
  if (diagnosticBadge.patternKey) metaParts.push(t(diagnosticBadge.patternKey));
  if (diagnosticBadge.toolName) {
    metaParts.push(t("mainChat.zeroTokenRules.toolMeta", { tool: diagnosticBadge.toolName }));
  }
  if (diagnosticBadge.repeatCount && diagnosticBadge.repeatCount > 1) {
    metaParts.push(
      t("mainChat.zeroTokenRules.repeatCountMeta", { count: diagnosticBadge.repeatCount }),
    );
  }

  return (
    <View style={boxStyle} testID="main-chat-task-drawer-rule-diagnostic-detail">
      <View style={styles.diagnosticHeaderLine}>
        {isDanger ? LOOP_DANGER_LEADING_ICON : RULE_WARNING_LEADING_ICON}
        <Text
          style={isDanger ? styles.diagnosticTitleDanger : styles.diagnosticTitleWarning}
          numberOfLines={2}
        >
          {diagnosticBadge.summary}
        </Text>
      </View>
      {metaParts.length > 0 ? (
        <Text style={styles.diagnosticMetaText} numberOfLines={1}>
          {metaParts.join(" · ")}
        </Text>
      ) : null}
      {diagnosticBadge.errorExcerpt ? (
        <Text style={styles.diagnosticExcerpt} numberOfLines={2}>
          {`${t("mainChat.zeroTokenRules.errorExcerptLabel")}：${diagnosticBadge.errorExcerpt}`}
        </Text>
      ) : null}
      {diagnosticBadge.missingItems.length > 0 ? (
        <Text style={styles.diagnosticMetaText} numberOfLines={2}>
          {`${t("mainChat.zeroTokenRules.missingItemsLabel")}：${diagnosticBadge.missingItems.join("、")}`}
        </Text>
      ) : null}
    </View>
  );
});

export const TaskDrawerGovernanceStrip = memo(function TaskDrawerGovernanceStrip({
  task,
  allTasks,
  projectLessons,
  ruleDiagnostic,
  isFailed = false,
  isMutatingTask,
  onStartReadyTask,
  onRetryWithFallback,
  onSelectRelatedTask,
}: TaskDrawerGovernanceStripProps): ReactElement {
  const { t } = useTranslation();
  const dag = useMemo(() => deriveTaskDagSummary(task, allTasks), [allTasks, task]);
  const gateBadge = useMemo(() => deriveDeliveryGateBadge(task.deliveryGate), [task.deliveryGate]);
  const diagnosticBadge = useMemo(
    () => deriveZeroTokenDiagnosticBadge(ruleDiagnostic ?? task.lastRuleDiagnostic),
    [ruleDiagnostic, task.lastRuleDiagnostic],
  );
  const canRetry = useMemo(
    () => Boolean(onRetryWithFallback) && canRetryManagedFailedTask(task, isFailed),
    [isFailed, onRetryWithFallback, task],
  );
  const matchedLessonCount = useMemo(
    () => countProjectLessonsForTask(projectLessons, task),
    [projectLessons, task],
  );

  const handleOpenLessons = useCallback(() => {
    router.push(buildSettingsSectionRoute("main-chat"));
  }, []);

  const handleStartSelf = useCallback(() => {
    onStartReadyTask(task.id);
  }, [onStartReadyTask, task.id]);

  const handleRetrySelf = useCallback(() => {
    onRetryWithFallback?.(task.id);
  }, [onRetryWithFallback, task.id]);

  const handleOpenParent = useCallback(() => {
    if (dag.parentTask && (dag.parentTask.activeAgentId || dag.parentTask.agentIds.length > 0)) {
      onSelectRelatedTask(dag.parentTask);
    }
  }, [dag.parentTask, onSelectRelatedTask]);

  const showGateDetail = Boolean(
    gateBadge && (gateBadge.blockers.length > 0 || gateBadge.followUpActive),
  );

  return (
    <View style={styles.strip} testID="main-chat-task-drawer-governance">
      <GovernanceHeaderBadges
        dag={dag}
        gateBadge={gateBadge}
        diagnosticBadge={diagnosticBadge}
        matchedLessonCount={matchedLessonCount}
        onOpenParent={handleOpenParent}
        onOpenLessons={handleOpenLessons}
      />

      {canRetry ? (
        <View style={styles.retryBanner} testID="main-chat-task-drawer-retry-banner">
          <View style={styles.retryBannerTextCol}>
            <Text style={styles.retryBannerTitle} numberOfLines={2}>
              {t("mainChat.modelProfiles.retryFallback.bannerTitle")}
            </Text>
          </View>
          <Button
            variant="default"
            size="sm"
            leftIcon={RETRY_LEADING_ICON}
            loading={isMutatingTask}
            disabled={isMutatingTask}
            onPress={handleRetrySelf}
            testID="main-chat-task-drawer-retry-fallback"
          >
            {t("mainChat.modelProfiles.retryFallback.button")}
          </Button>
        </View>
      ) : null}

      {diagnosticBadge ? <GovernanceDiagnosticDetail diagnosticBadge={diagnosticBadge} /> : null}

      {dag.canStartReady ? (
        <View style={styles.readyBanner} testID="main-chat-task-drawer-ready-banner">
          <Text style={styles.readyBannerText}>{t("mainChat.taskDag.readyMeta")}</Text>
          <Button
            variant="default"
            size="sm"
            leftIcon={ThemedPlay}
            loading={isMutatingTask}
            disabled={isMutatingTask}
            onPress={handleStartSelf}
            testID="main-chat-task-drawer-start-ready"
          >
            {t("mainChat.taskDag.startReadyFullAction")}
          </Button>
        </View>
      ) : null}

      {dag.dependencyState === "blocked" && dag.blockedByTitles.length > 0 ? (
        <View style={styles.blockedNoteRow} testID="main-chat-task-drawer-blocked-note">
          <ThemedLock size={12} uniProps={warningIconMapping} />
          <Text style={styles.blockedNoteText}>
            {t("mainChat.taskDag.blockedMeta", { deps: dag.blockedByTitles.join("、") })}
          </Text>
        </View>
      ) : null}

      {dag.allChildrenDone ? (
        <View style={styles.closeoutBanner} testID="main-chat-task-drawer-parent-closeout">
          <ThemedCheck size={13} uniProps={successIconMapping} />
          <Text style={styles.closeoutBannerText}>
            {t("mainChat.taskDag.parentCloseoutBanner", { total: dag.childrenTotal })}
          </Text>
        </View>
      ) : null}

      {showGateDetail && gateBadge ? <GovernanceDeliveryGateDetail gateBadge={gateBadge} /> : null}

      {dag.children.length > 0 ? (
        <View style={styles.childrenBox} testID="main-chat-task-drawer-children-list">
          <Text style={styles.childrenHeading}>
            {t("mainChat.taskDag.childSlicesHeading", {
              done: dag.childrenCompleted,
              total: dag.childrenTotal,
            })}
          </Text>
          {dag.children.map((child) => (
            <ChildSliceRow
              key={child.id}
              child={child}
              allTasks={allTasks}
              isMutatingTask={isMutatingTask}
              onStartReadyTask={onStartReadyTask}
              onSelectRelatedTask={onSelectRelatedTask}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  strip: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  badgeHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  badgeWrap: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    flex: 1,
    minWidth: 0,
  },
  parentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    maxWidth: "100%",
  },
  parentChipText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  lessonsEntryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    flexShrink: 0,
  },
  lessonsEntryText: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  readyBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusSuccessTint,
  },
  readyBannerText: {
    fontSize: 12,
    color: theme.colors.statusSuccess,
    flex: 1,
    minWidth: 140,
  },
  blockedNoteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusWarningTint,
  },
  blockedNoteText: {
    fontSize: 12,
    color: theme.colors.statusWarning,
    flex: 1,
    minWidth: 0,
  },
  closeoutBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusSuccessTint,
  },
  closeoutBannerText: {
    fontSize: 12,
    color: theme.colors.statusSuccess,
    flex: 1,
    minWidth: 0,
  },
  gateDetailBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1],
  },
  gateDetailBoxBlocked: {
    borderColor: theme.colors.statusDanger,
    backgroundColor: theme.colors.statusDangerTint,
  },
  gateBlockersList: {
    gap: theme.spacing[1],
  },
  gateBlockerLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
  },
  gateBlockerText: {
    fontSize: 12,
    color: theme.colors.statusDanger,
    flex: 1,
    minWidth: 0,
  },
  gateFollowUpText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  retryBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
    backgroundColor: theme.colors.statusDangerTint,
  },
  retryBannerTextCol: {
    flex: 1,
    minWidth: 150,
  },
  retryBannerTitle: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDanger,
  },
  diagnosticBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    gap: theme.spacing[1],
  },
  diagnosticBoxDanger: {
    borderColor: theme.colors.statusDanger,
    backgroundColor: theme.colors.statusDangerTint,
  },
  diagnosticBoxWarning: {
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  diagnosticHeaderLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1.5],
  },
  diagnosticTitleDanger: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDanger,
  },
  diagnosticTitleWarning: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusWarning,
  },
  diagnosticMetaText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  diagnosticExcerpt: {
    fontSize: 11,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  childrenBox: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  childrenHeading: {
    fontSize: 12,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  childSliceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  childSlicePress: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.md,
  },
  childSliceTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  childSliceTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  childSliceTitle: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  childSliceMeta: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
}));
