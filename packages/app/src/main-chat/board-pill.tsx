import type { AgentAddress } from "@getpaseo/protocol/addresses";
import {
  isMainChatAgent,
  type MainChatAutoStartRule,
  type MainChatPermissionRule,
  type MainChatRuleKind,
} from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { AtSign, ShieldCheck, Trash2 } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StatusRing } from "@/components/status-ring";
import { MenuSeparator, useMenuContext } from "@/components/ui/menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "@/composer/tracks";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatRouteStore } from "./route-store";
import { selectMainChatDockTasks, type MainChatDockTaskItem } from "./selectors";

const ThemedAtIcon = withUnistyles(AtSign);
const ThemedShieldIcon = withUnistyles(ShieldCheck);
const ThemedTrashIcon = withUnistyles(Trash2);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatBoardPillProps {
  serverId: string;
  agentId: string;
  onOpenSubagent: (address: AgentAddress) => void;
}

function directoryBasename(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function BoardStatusMark({ bucket }: { bucket: SidebarStateBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.ringWrap}>
        <StatusRing />
      </View>
    );
  }
  switch (bucket) {
    case "needs_input":
      return <View style={styles.dotNeedsInput} />;
    case "failed":
      return <View style={styles.dotFailed} />;
    case "attention":
      return <View style={styles.dotAttention} />;
    case "done":
      return <View style={styles.dotDone} />;
  }
}

const BoardTaskRow = memo(function BoardTaskRow({
  serverId,
  mainAgentId,
  task,
  onOpenSubagent,
}: {
  serverId: string;
  mainAgentId: string;
  task: MainChatDockTaskItem;
  onOpenSubagent: (address: AgentAddress) => void;
}) {
  const { t } = useTranslation();
  const { selectItem } = useMenuContext("MainChatBoardTaskRow");
  const setRouteTarget = useMainChatRouteStore((state) => state.setTarget);

  const handleOpen = useCallback(() => {
    onOpenSubagent({ serverId: task.serverId, agentId: task.agentId });
  }, [onOpenSubagent, task.agentId, task.serverId]);

  const handleTalkDirectly = useCallback(() => {
    selectItem(() => {
      setRouteTarget(serverId, mainAgentId, {
        targetServerId: task.serverId,
        targetAgentId: task.agentId,
        targetTitle: task.title,
      });
    }, true);
  }, [mainAgentId, selectItem, serverId, setRouteTarget, task.agentId, task.serverId, task.title]);

  return (
    <ComposerTrackRow
      onPress={handleOpen}
      accessibilityLabel={task.title}
      testID={`main-chat-board-task-${task.agentId}`}
    >
      <BoardStatusMark bucket={task.bucket} />
      <Text style={styles.rowTitle} numberOfLines={1}>
        {task.title}
      </Text>
      {task.mode ? (
        <StatusBadge
          size="xs"
          variant={task.mode === "readonly" ? "success" : "warning"}
          label={task.mode === "readonly" ? t("mainChat.mode.readonly") : t("mainChat.mode.write")}
        />
      ) : null}
      <PressHighlight
        onPress={handleTalkDirectly}
        style={styles.talkButton}
        highlightStyle={styles.talkButtonPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.board.talkDirectly")}
        testID={`main-chat-board-talk-${task.agentId}`}
      >
        <ThemedAtIcon size={12} uniProps={mutedIconMapping} />
        <Text style={styles.talkLabel}>{t("mainChat.board.talkDirectly")}</Text>
      </PressHighlight>
    </ComposerTrackRow>
  );
});

const RuleRow = memo(function RuleRow({
  id,
  kind,
  label,
  removing,
  onRemove,
}: {
  id: string;
  kind: MainChatRuleKind;
  label: string;
  removing: boolean;
  onRemove: (kind: MainChatRuleKind, ruleId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRemove = useCallback(() => {
    onRemove(kind, id);
  }, [id, kind, onRemove]);

  return (
    <View style={styles.ruleRow} testID={`main-chat-rule-${kind}-${id}`}>
      <ThemedShieldIcon size={12} uniProps={mutedIconMapping} />
      <Text style={styles.ruleLabel} numberOfLines={1}>
        {label}
      </Text>
      <PressHighlight
        onPress={handleRemove}
        disabled={removing}
        style={styles.removeRuleButton}
        highlightStyle={styles.talkButtonPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.board.removeRule")}
      >
        <ThemedTrashIcon size={12} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

function formatAutoStartRuleLabel(rule: MainChatAutoStartRule, modeLabel: string): string {
  return `${directoryBasename(rule.cwd)} · ${modeLabel}`;
}

function formatPermissionRuleLabel(rule: MainChatPermissionRule): string {
  const base = rule.commandPrefix ? `${rule.toolName} (${rule.commandPrefix})` : rule.toolName;
  return rule.cwd ? `${base} · ${directoryBasename(rule.cwd)}` : base;
}

function MainChatBoardContent({
  serverId,
  agentId,
  tasks,
  onOpenSubagent,
}: {
  serverId: string;
  agentId: string;
  tasks: readonly MainChatDockTaskItem[];
  onOpenSubagent: (address: AgentAddress) => void;
}) {
  const { t } = useTranslation();
  const { open } = useMenuContext("MainChatBoardContent");
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const overview = useMainChatOverviewStore(
    (state) => state.overviewsByKey[overviewStoreKey(serverId, agentId)] ?? null,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const removeRule = useMainChatOverviewStore((state) => state.removeRule);
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !client) return;
    void loadOverview(serverId, agentId, client);
  }, [agentId, client, loadOverview, open, serverId]);

  const handleRemoveRule = useCallback(
    (kind: MainChatRuleKind, ruleId: string) => {
      if (!client || removingRuleId) return;
      setRemovingRuleId(ruleId);
      void removeRule(serverId, agentId, kind, ruleId, client).finally(() => {
        setRemovingRuleId(null);
      });
    },
    [agentId, client, removeRule, removingRuleId, serverId],
  );

  const grouped = useMemo(() => {
    const needsYou: MainChatDockTaskItem[] = [];
    const running: MainChatDockTaskItem[] = [];
    const done: MainChatDockTaskItem[] = [];
    for (const task of tasks) {
      if (task.bucket === "needs_input" || task.bucket === "failed") needsYou.push(task);
      else if (task.bucket === "running") running.push(task);
      else done.push(task);
    }
    return { needsYou, running, done };
  }, [tasks]);

  const metrics = overview?.metrics;
  const autoStartRules = overview?.autoStartRules ?? [];
  const permissionRules = overview?.permissionRules ?? [];

  return (
    <View style={styles.panelBody}>
      <View style={styles.metricsStrip}>
        <Text style={styles.sectionHeader}>{t("mainChat.board.briefHeading")}</Text>
        <Text style={styles.metricsLine}>
          {t("mainChat.board.liveCounts", {
            needsYou: grouped.needsYou.length,
            running: grouped.running.length,
            done: grouped.done.length,
          })}
        </Text>
        {metrics ? (
          <Text style={styles.metricsSub}>
            {t("mainChat.board.supervisorMetrics", {
              held: metrics.supervisorHeld,
              autoContinued: metrics.autoContinued,
              rework: metrics.reworkCount,
              interrupts: metrics.interrupts,
            })}
          </Text>
        ) : null}
      </View>

      <MenuSeparator />

      {tasks.length === 0 ? (
        <Text style={styles.emptyText}>{t("mainChat.board.emptyTasks")}</Text>
      ) : (
        <View style={styles.taskGroups}>
          {grouped.needsYou.length > 0 ? (
            <View style={styles.groupSection}>
              <Text style={styles.groupTitle}>{t("mainChat.board.groupNeedsYou")}</Text>
              {grouped.needsYou.map((task) => (
                <BoardTaskRow
                  key={`${task.serverId}:${task.agentId}`}
                  serverId={serverId}
                  mainAgentId={agentId}
                  task={task}
                  onOpenSubagent={onOpenSubagent}
                />
              ))}
            </View>
          ) : null}

          {grouped.running.length > 0 ? (
            <View style={styles.groupSection}>
              <Text style={styles.groupTitle}>{t("mainChat.board.groupRunning")}</Text>
              {grouped.running.map((task) => (
                <BoardTaskRow
                  key={`${task.serverId}:${task.agentId}`}
                  serverId={serverId}
                  mainAgentId={agentId}
                  task={task}
                  onOpenSubagent={onOpenSubagent}
                />
              ))}
            </View>
          ) : null}

          {grouped.done.length > 0 ? (
            <View style={styles.groupSection}>
              <Text style={styles.groupTitle}>{t("mainChat.board.groupDone")}</Text>
              {grouped.done.map((task) => (
                <BoardTaskRow
                  key={`${task.serverId}:${task.agentId}`}
                  serverId={serverId}
                  mainAgentId={agentId}
                  task={task}
                  onOpenSubagent={onOpenSubagent}
                />
              ))}
            </View>
          ) : null}
        </View>
      )}

      <MenuSeparator />

      <View style={styles.rulesSection}>
        <Text style={styles.sectionHeader}>{t("mainChat.board.rulesHeading")}</Text>
        {autoStartRules.length === 0 && permissionRules.length === 0 ? (
          <Text style={styles.emptyText}>{t("mainChat.board.emptyRules")}</Text>
        ) : (
          <View style={styles.rulesList}>
            {autoStartRules.map((rule) => (
              <RuleRow
                key={rule.id}
                id={rule.id}
                kind="auto_start"
                label={formatAutoStartRuleLabel(
                  rule,
                  rule.mode === "readonly" ? t("mainChat.mode.readonly") : t("mainChat.mode.write"),
                )}
                removing={removingRuleId === rule.id}
                onRemove={handleRemoveRule}
              />
            ))}
            {permissionRules.map((rule) => (
              <RuleRow
                key={rule.id}
                id={rule.id}
                kind="permission"
                label={formatPermissionRuleLabel(rule)}
                removing={removingRuleId === rule.id}
                onRemove={handleRemoveRule}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * Native `ComposerTrackPill` for the Main Chat session exposing the grouped Task Board,
 * supervisor brief metrics, quick `@ 直发` direct-routing buttons, and saved trust rule management.
 */
export const MainChatBoardPill = memo(function MainChatBoardPill({
  serverId,
  agentId,
  onOpenSubagent,
}: MainChatBoardPillProps): ReactElement | null {
  const { t } = useTranslation();
  const isMainChat = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const current = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return isMainChatAgent(current);
  });

  const tasks = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => selectMainChatDockTasks(state, serverId, agentId), [agentId, serverId]),
    equal,
  );

  const segments = useMemo<ComposerTrackPillSegment[]>(() => {
    const needsCount = tasks.filter(
      (task) => task.bucket === "needs_input" || task.bucket === "failed",
    ).length;
    const runningCount = tasks.filter((task) => task.bucket === "running").length;
    const items: ComposerTrackPillSegment[] = [
      { bucket: null, text: t("mainChat.board.pillTitle") },
    ];
    if (needsCount > 0) {
      items.push({
        bucket: "needs_input",
        text: t("mainChat.sidebarBadgeNeedsYou", { count: needsCount }),
      });
    } else if (runningCount > 0) {
      items.push({
        bucket: "running",
        text: t("mainChat.sidebarBadgeRunning", { count: runningCount }),
      });
    }
    return items;
  }, [t, tasks]);

  if (!isMainChat) return null;

  return (
    <ComposerTrackPill
      testID="main-chat-board-pill"
      segments={segments}
      panelTitle={t("mainChat.board.panelTitle")}
      accessibilityLabel={t("mainChat.board.panelTitle")}
    >
      <MainChatBoardContent
        serverId={serverId}
        agentId={agentId}
        tasks={tasks}
        onOpenSubagent={onOpenSubagent}
      />
    </ComposerTrackPill>
  );
});

const styles = StyleSheet.create((theme) => {
  const dot = (bucket: Exclude<SidebarStateBucket, "running">) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: false }) ?? undefined,
  });

  return {
    panelBody: {
      gap: theme.spacing[1.5],
      paddingVertical: theme.spacing[1],
    },
    metricsStrip: {
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
      gap: theme.spacing[0.5],
    },
    sectionHeader: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foregroundMuted,
    },
    metricsLine: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    metricsSub: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    taskGroups: {
      gap: theme.spacing[1.5],
    },
    groupSection: {
      gap: theme.spacing[0.5],
    },
    groupTitle: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foregroundMuted,
      paddingHorizontal: theme.spacing[3],
      paddingTop: theme.spacing[0.5],
    },
    rowTitle: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    talkButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      paddingHorizontal: theme.spacing[1.5],
      paddingVertical: theme.spacing[0.5],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    talkButtonPressed: {
      backgroundColor: theme.colors.surface2,
    },
    talkLabel: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    rulesSection: {
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
      gap: theme.spacing[1],
    },
    rulesList: {
      gap: theme.spacing[1],
    },
    ruleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
    },
    ruleLabel: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    removeRuleButton: {
      padding: theme.spacing[1],
      borderRadius: theme.borderRadius.md,
    },
    emptyText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
    },
    ringWrap: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    dotNeedsInput: dot("needs_input"),
    dotFailed: dot("failed"),
    dotAttention: dot("attention"),
    dotDone: dot("done"),
  };
});
