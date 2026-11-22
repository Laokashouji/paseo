import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useComposers, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import {
  addTodoRpc,
  forkTodoRpc,
  refreshSummaryRpc,
  removeTodoRpc,
  resolveExternalSignalRpc,
  resolveSuggestedTodoRpc,
  runTodoRpc,
  triggerArchiveRpc,
  updateCardMetaRpc,
  updateTodoRpc,
} from "../shared/rpc.js";
import type {
  AdvancePolicy,
  ForkMode,
  SessionWorkbenchCard,
  TodoItem,
  WaitCondition,
  WorkflowStatus,
} from "../shared/schema.js";
import { useWorkbenchOverview, useWorkbenchSettingsValues } from "./hooks.js";
import {
  getRuntimeStatusLabel,
  getTodoStatusLabel,
  getWorkflowStatusVisual,
  withAlpha,
  WORKFLOW_STATUS_LIST,
} from "./status-meta.js";

export interface WorkbenchCardBodyProps {
  agentId: string;
  workspaceId: string | null;
  card: SessionWorkbenchCard;
  theme: PluginTheme;
  variant: "corner" | "panel";
  onOpenAgent?: (agentId: string) => void;
  onOpenOverview?: () => void;
  onPinToPanel?: () => void;
  onCollapse?: () => void;
  onOpenSettings?: () => void;
}

export function WorkbenchCardBody({
  agentId,
  workspaceId,
  card,
  theme,
  variant,
  onOpenAgent,
  onOpenOverview,
  onPinToPanel,
  onCollapse,
  onOpenSettings,
}: WorkbenchCardBodyProps) {
  const toast = useToast();
  const settings = useWorkbenchSettingsValues();
  const agentSnapshot = useAgent(agentId);
  const [composer] = useComposers({ agentId });

  const updateMeta = useRpc(updateCardMetaRpc);
  const addTodo = useRpc(addTodoRpc);
  const updateTodo = useRpc(updateTodoRpc);
  const removeTodo = useRpc(removeTodoRpc);
  const resolveSuggested = useRpc(resolveSuggestedTodoRpc);
  const runTodo = useRpc(runTodoRpc);
  const forkTodo = useRpc(forkTodoRpc);
  const refreshSummary = useRpc(refreshSummaryRpc);
  const resolveExternalSignal = useRpc(resolveExternalSignalRpc);
  const triggerArchive = useRpc(triggerArchiveRpc);

  const [newTodoText, setNewTodoText] = useState("");
  const [expandedTodoId, setExpandedTodoId] = useState<string | null>(null);
  const [showDoneTodos, setShowDoneTodos] = useState(false);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [statusNoteDraft, setStatusNoteDraft] = useState("");
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);
  const [refreshingSummary, setRefreshingSummary] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const effectiveRuntime = agentSnapshot?.status ?? card.runtimeStatus;
  const isRunning = effectiveRuntime === "running";
  const statusVisual = getWorkflowStatusVisual(card.workflowStatus);
  const statusColor = statusVisual.color(theme);
  const isSummarizing = card.summaryState === "running" || refreshingSummary;
  const isArchiveInProgress =
    archiving || card.archiveState === "running" || card.archiveState === "pending_archive";
  const isArchiveQueued = card.archiveState === "queued";
  const archiveCommandPreview = useMemo(() => {
    const firstLine = settings.archiveCommand
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return firstLine ?? "";
  }, [settings.archiveCommand]);

  const activeTodos = useMemo(
    () => card.todos.filter((item) => item.status !== "done" && item.status !== "dismissed"),
    [card.todos],
  );
  const completedTodos = useMemo(
    () => card.todos.filter((item) => item.status === "done"),
    [card.todos],
  );

  const handleAddTodo = useCallback(async () => {
    const title = newTodoText.trim();
    if (!title) return;
    setNewTodoText("");
    try {
      await addTodo({
        agentId,
        workspaceId,
        title,
        author: "user",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加待办失败");
    }
  }, [addTodo, agentId, newTodoText, toast, workspaceId]);

  const handleSelectStatus = useCallback(
    async (status: WorkflowStatus) => {
      try {
        await updateMeta({
          agentId,
          workspaceId,
          workflowStatus: status,
          statusNote: statusNoteDraft.trim() || card.statusNote,
          ...(status !== "waiting_dependency" && status !== "waiting_external"
            ? { waitCondition: null }
            : {}),
        });
        setStatusPickerOpen(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新状态失败");
      }
    },
    [agentId, card.statusNote, statusNoteDraft, toast, updateMeta, workspaceId],
  );

  const handleSaveStatusNote = useCallback(async () => {
    try {
      await updateMeta({
        agentId,
        workspaceId,
        statusNote: statusNoteDraft.trim(),
      });
      setStatusPickerOpen(false);
      toast.show("已更新状态备注", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存备注失败");
    }
  }, [agentId, statusNoteDraft, toast, updateMeta, workspaceId]);

  const handleSaveTopic = useCallback(async () => {
    const trimmed = topicDraft.trim();
    setEditingTopic(false);
    if (!trimmed) return;
    try {
      await updateMeta({
        agentId,
        workspaceId,
        topic: trimmed,
        topicLocked: true,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新主题失败");
    }
  }, [agentId, toast, topicDraft, updateMeta, workspaceId]);

  const handleToggleTopicLock = useCallback(async () => {
    try {
      await updateMeta({
        agentId,
        workspaceId,
        topicLocked: !card.topicLocked,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "切换锁定失败");
    }
  }, [agentId, card.topicLocked, toast, updateMeta, workspaceId]);

  const handleRefreshSummary = useCallback(async () => {
    if (refreshingSummary || card.summaryState === "running") return;
    setRefreshingSummary(true);
    try {
      await refreshSummary({ agentId, workspaceId });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新摘要失败");
    } finally {
      setRefreshingSummary(false);
    }
  }, [agentId, card.summaryState, refreshSummary, refreshingSummary, toast, workspaceId]);

  const handleTriggerArchive = useCallback(
    async (cancelQueue = false) => {
      if (archiving) return;
      setArchiving(true);
      try {
        const result = await triggerArchive({
          agentId,
          workspaceId,
          ...(cancelQueue ? { cancelQueue: true } : {}),
        });
        setArchiveConfirmOpen(false);
        if (result.status === "canceled") {
          toast.show("已取消归档排队", { variant: "info" });
        } else if (result.status === "queued") {
          toast.show("已排队：本轮结束后将自动发送归档命令", { variant: "info" });
        } else {
          toast.show("已发送归档命令，等待 AI 清理完成", { variant: "success" });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "触发归档失败");
      } finally {
        setArchiving(false);
      }
    },
    [agentId, archiving, toast, triggerArchive, workspaceId],
  );

  const handleRunTodo = useCallback(
    async (todo: TodoItem, mode: "send_now" | "queue_next") => {
      setBusyTodoId(todo.id);
      try {
        const result = await runTodo({ agentId, todoId: todo.id, mode });
        toast.show(
          result.dispatched === "sent"
            ? `已发送待办：${todo.title}`
            : `已排入下一轮执行：${todo.title}`,
          { variant: "success" },
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "执行待办失败");
      } finally {
        setBusyTodoId(null);
      }
    },
    [agentId, runTodo, toast],
  );

  const handleFillComposer = useCallback(
    async (todo: TodoItem) => {
      if (!composer) {
        toast.error("当前无法访问该对话输入框");
        return;
      }
      composer.setPrompt(todo.prompt?.trim() || todo.title);
      await composer.focus().catch(() => {});
    },
    [composer, toast],
  );

  const handleForkTodo = useCallback(
    async (todo: TodoItem, forkMode: ForkMode) => {
      setBusyTodoId(todo.id);
      try {
        const result = await forkTodo({
          agentId,
          todoId: todo.id,
          forkMode,
        });
        toast.show(
          forkMode === "new_worktree" ? "已 Fork 到新 Worktree 对话" : "已 Fork 到同工作区新对话",
          { variant: "success" },
        );
        onOpenAgent?.(result.newAgentId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Fork 待办失败");
      } finally {
        setBusyTodoId(null);
      }
    },
    [agentId, forkTodo, onOpenAgent, toast],
  );

  const handleToggleDone = useCallback(
    async (todo: TodoItem) => {
      try {
        await updateTodo({
          agentId,
          todoId: todo.id,
          status: todo.status === "done" ? "open" : "done",
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新待办失败");
      }
    },
    [agentId, toast, updateTodo],
  );

  const handleRemoveTodo = useCallback(
    async (todoId: string) => {
      try {
        await removeTodo({ agentId, todoId });
        if (expandedTodoId === todoId) setExpandedTodoId(null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "删除待办失败");
      }
    },
    [agentId, expandedTodoId, removeTodo, toast],
  );

  const handleResolveSuggested = useCallback(
    async (suggestedId: string, action: "accept" | "dismiss") => {
      try {
        await resolveSuggested({ agentId, suggestedId, action });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "操作失败");
      }
    },
    [agentId, resolveSuggested, toast],
  );

  const handleClearNotice = useCallback(async () => {
    await updateMeta({ agentId, workspaceId, clearConditionNotice: true }).catch(() => {});
  }, [agentId, updateMeta, workspaceId]);

  const handleResolveSignal = useCallback(async () => {
    try {
      await resolveExternalSignal({ agentId });
      toast.show("已标记外部确认达成", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    }
  }, [agentId, resolveExternalSignal, toast]);

  return (
    <View style={{ gap: 12 }}>
      {/* Unified top bar: status pill + runtime indicator + compact toolbar */}
      <View style={{ gap: 8 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
            <Pressable
              onPress={() => {
                setStatusNoteDraft(card.statusNote);
                setArchiveConfirmOpen(false);
                setStatusPickerOpen((open) => !open);
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 5,
                borderRadius: 999,
                backgroundColor: statusVisual.tintBg(theme),
                borderWidth: 1,
                borderColor: statusVisual.tintBorder(theme),
              }}
            >
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  backgroundColor: statusColor,
                }}
              />
              <Text style={{ fontSize: 12, fontWeight: "700", color: statusColor }}>
                {statusVisual.label}
              </Text>
              <Icon
                name={statusPickerOpen ? "ChevronRight" : "ChevronDown"}
                size={12}
                color={statusColor}
              />
            </Pressable>

            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 999,
                backgroundColor: isRunning
                  ? withAlpha(theme.colors.statusSuccess, 0.14)
                  : theme.colors.surface1,
              }}
            >
              {isRunning ? (
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    backgroundColor: theme.colors.statusSuccess,
                  }}
                />
              ) : null}
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: isRunning ? "600" : "500",
                  color: isRunning ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
                }}
              >
                {getRuntimeStatusLabel(effectiveRuntime)}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {!card.archived ? (
              <ToolbarIconButton
                theme={theme}
                icon="Archive"
                accessibilityLabel={
                  isArchiveQueued
                    ? "管理已排队的归档命令"
                    : isArchiveInProgress
                      ? "正在执行归档清理"
                      : "发送归档命令清理工程痕迹"
                }
                active={archiveConfirmOpen || isArchiveQueued || isArchiveInProgress}
                disabled={isArchiveInProgress}
                onPress={() => {
                  setStatusPickerOpen(false);
                  setArchiveConfirmOpen((open) => !open);
                }}
              />
            ) : null}
            <ToolbarIconButton
              theme={theme}
              icon="RefreshCw"
              accessibilityLabel="立即刷新 AI 摘要"
              active={isSummarizing}
              disabled={isSummarizing}
              onPress={() => void handleRefreshSummary()}
            />
            {onOpenOverview ? (
              <ToolbarIconButton
                theme={theme}
                icon="PanelsTopLeft"
                accessibilityLabel="打开全局状态总览"
                onPress={onOpenOverview}
              />
            ) : null}
            {onPinToPanel ? (
              <ToolbarIconButton
                theme={theme}
                icon="PanelRight"
                accessibilityLabel="固定到侧栏完整视图"
                onPress={onPinToPanel}
              />
            ) : null}
            {onCollapse ? (
              <ToolbarIconButton
                theme={theme}
                icon="Minimize"
                accessibilityLabel="收起工作台卡片"
                onPress={onCollapse}
              />
            ) : null}
          </View>
        </View>

        {!card.archived && (isArchiveInProgress || isArchiveQueued) ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: 9,
              backgroundColor: withAlpha(theme.colors.statusWarning, 0.12),
              borderWidth: 1,
              borderColor: withAlpha(theme.colors.statusWarning, 0.35),
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
              <Icon name="Archive" size={13} color={theme.colors.statusWarning} />
              <Text
                numberOfLines={2}
                style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}
              >
                {card.archiveState === "pending_archive"
                  ? "清理完成，本轮结束后将自动归档并关闭标签页…"
                  : isArchiveQueued
                    ? "已排队：本轮结束后自动发送归档命令"
                    : "AI 正在执行归档清理，完成后自动归档关闭…"}
              </Text>
            </View>
            {isArchiveQueued ? (
              <Pressable
                onPress={() => void handleTriggerArchive(true)}
                disabled={archiving}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 6,
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foreground }}>
                  取消排队
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {!card.archived && archiveConfirmOpen && !isArchiveInProgress ? (
          <View
            style={{
              padding: 10,
              borderRadius: 10,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: withAlpha(theme.colors.statusWarning, 0.45),
              gap: 8,
            }}
          >
            <View style={{ gap: 3 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.foreground }}>
                {isArchiveQueued
                  ? "归档命令已排队"
                  : isRunning
                    ? "本轮结束后自动发送归档命令？"
                    : "在当前对话发送归档命令？"}
              </Text>
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                {settings.autoArchiveAfterCleanup
                  ? "将交由 AI 清理本对话残留的 worktree 与临时文件，确认无风险后自动归档并关闭标签页。"
                  : "将交由 AI 清理本对话残留的 worktree 与临时文件并汇报结果（当前未开启自动归档）。"}
              </Text>
              {archiveCommandPreview ? (
                <Text
                  numberOfLines={1}
                  style={{
                    fontSize: 11,
                    color: theme.colors.foregroundMuted,
                    backgroundColor: theme.colors.surface0,
                    paddingHorizontal: 7,
                    paddingVertical: 4,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    marginTop: 2,
                  }}
                >
                  {archiveCommandPreview}
                </Text>
              ) : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {isArchiveQueued ? (
                <Pressable
                  onPress={() => void handleTriggerArchive(true)}
                  disabled={archiving}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 7,
                    backgroundColor: theme.colors.statusWarning,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: "#000000" }}>
                    取消排队
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => void handleTriggerArchive(false)}
                  disabled={archiving}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 7,
                    backgroundColor: theme.colors.accent,
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: "600",
                      color: theme.colors.accentForeground,
                    }}
                  >
                    {isRunning ? "本轮后发送归档" : "确认归档"}
                  </Text>
                </Pressable>
              )}
              {onOpenSettings ? (
                <Pressable
                  onPress={() => {
                    setArchiveConfirmOpen(false);
                    onOpenSettings();
                  }}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 6,
                    borderRadius: 7,
                    backgroundColor: theme.colors.surface0,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
                    编辑命令
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => setArchiveConfirmOpen(false)}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                  borderRadius: 7,
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>取消</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {statusPickerOpen ? (
          <View
            style={{
              padding: 10,
              borderRadius: 10,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {WORKFLOW_STATUS_LIST.map((item) => {
                const selected = item.value === card.workflowStatus;
                const itemColor = item.color(theme);
                return (
                  <Pressable
                    key={item.value}
                    onPress={() => void handleSelectStatus(item.value)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 9,
                      paddingVertical: 5,
                      borderRadius: 999,
                      backgroundColor: selected ? item.tintBg(theme) : theme.colors.surface2,
                      borderWidth: 1,
                      borderColor: selected ? itemColor : theme.colors.border,
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        backgroundColor: itemColor,
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: selected ? "700" : "500",
                        color: selected ? itemColor : theme.colors.foreground,
                      }}
                    >
                      {item.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <TextInput
                value={statusNoteDraft}
                onChangeText={setStatusNoteDraft}
                placeholder="填写等待原因或状态备注…"
                placeholderTextColor={theme.colors.foregroundMuted}
                onSubmitEditing={() => void handleSaveStatusNote()}
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: 7,
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                }}
              />
              <Pressable
                onPress={() => void handleSaveStatusNote()}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 7,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text
                  style={{ fontSize: 12, fontWeight: "600", color: theme.colors.accentForeground }}
                >
                  保存
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      {/* Condition met highlight banner */}
      {card.conditionMetNotice ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            paddingHorizontal: 11,
            paddingVertical: 8,
            borderRadius: 10,
            backgroundColor: withAlpha(theme.colors.statusWarning, 0.14),
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.statusWarning, 0.45),
          }}
        >
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Icon name="Sparkles" size={14} color={theme.colors.statusWarning} />
            <Text
              style={{ flex: 1, fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}
            >
              {card.conditionMetNotice}
            </Text>
          </View>
          <Pressable onPress={() => void handleClearNotice()} hitSlop={6}>
            <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ) : null}

      {/* Hero Focus Card: Topic (primary headline) + Current Work (highlighted focus strip) */}
      <View
        style={{
          padding: 12,
          borderRadius: 11,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderLeftWidth: 3,
          borderLeftColor: statusColor,
          gap: 10,
        }}
      >
        {/* Primary headline: Topic */}
        <View style={{ gap: 4 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "600",
                color: theme.colors.foregroundMuted,
              }}
            >
              主题工作
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable
                onPress={() => void handleToggleTopicLock()}
                hitSlop={6}
                accessibilityLabel={
                  card.topicLocked ? "解锁主题允许 AI 更新" : "锁定主题禁止 AI 覆盖"
                }
              >
                <Icon
                  name={card.topicLocked ? "Pin" : "PinOff"}
                  size={12}
                  color={card.topicLocked ? statusColor : theme.colors.foregroundMuted}
                />
              </Pressable>
              <Pressable
                onPress={() => {
                  setTopicDraft(card.topic || card.agentTitle || "");
                  setEditingTopic((value) => !value);
                }}
                hitSlop={6}
              >
                <Icon name="Pencil" size={12} color={theme.colors.foregroundMuted} />
              </Pressable>
            </View>
          </View>

          {editingTopic ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <TextInput
                value={topicDraft}
                onChangeText={setTopicDraft}
                autoFocus
                onSubmitEditing={() => void handleSaveTopic()}
                placeholder="输入本次对话的主题工作"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  flex: 1,
                  fontSize: 14,
                  fontWeight: "600",
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: statusColor,
                  borderRadius: 7,
                  paddingHorizontal: 9,
                  paddingVertical: 6,
                }}
              />
              <Pressable
                onPress={() => void handleSaveTopic()}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  borderRadius: 7,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text
                  style={{ fontSize: 12, color: theme.colors.accentForeground, fontWeight: "600" }}
                >
                  确定
                </Text>
              </Pressable>
            </View>
          ) : (
            <Text
              numberOfLines={2}
              style={{
                fontSize: 15,
                fontWeight: "700",
                lineHeight: 21,
                color:
                  card.topic || card.agentTitle
                    ? theme.colors.foreground
                    : theme.colors.foregroundMuted,
              }}
            >
              {card.topic || card.agentTitle || "待自动总结主题…"}
            </Text>
          )}
        </View>

        {/* Secondary focal block: Current Work inset card */}
        <View
          style={{
            paddingHorizontal: 10,
            paddingVertical: 9,
            borderRadius: 8,
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.border, 0.8),
            gap: 5,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Icon name="Zap" size={12} color={statusColor} />
              <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor }}>当前在做</Text>
            </View>
            {isSummarizing ? (
              <Text style={{ fontSize: 10, fontWeight: "600", color: theme.colors.statusWarning }}>
                轻量模型总结中…
              </Text>
            ) : card.summaryModel ? (
              <Text
                numberOfLines={1}
                style={{ fontSize: 10, color: theme.colors.foregroundMuted, maxWidth: 150 }}
              >
                {card.summaryModel}
              </Text>
            ) : null}
          </View>

          <Text
            numberOfLines={variant === "corner" ? 3 : 5}
            style={{
              fontSize: 13,
              lineHeight: 19,
              fontWeight: card.currentWork ? "500" : "400",
              color: card.currentWork ? theme.colors.foreground : theme.colors.foregroundMuted,
            }}
          >
            {card.currentWork || "完成首轮对话后自动由轻量模型总结当前进展"}
          </Text>
        </View>

        {/* Readable summary error callout with inline retry */}
        {card.summaryError ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              paddingHorizontal: 9,
              paddingVertical: 6,
              borderRadius: 7,
              backgroundColor: withAlpha(theme.colors.statusDanger, 0.12),
              borderWidth: 1,
              borderColor: withAlpha(theme.colors.statusDanger, 0.35),
            }}
          >
            <Text
              numberOfLines={2}
              style={{ flex: 1, fontSize: 11, lineHeight: 16, color: theme.colors.statusDanger }}
            >
              摘要失败：{card.summaryError}
            </Text>
            <Pressable
              onPress={() => void handleRefreshSummary()}
              disabled={isSummarizing}
              style={{
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 5,
                backgroundColor: withAlpha(theme.colors.statusDanger, 0.18),
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.statusDanger }}>
                重试
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Status note / waiting dependency / fork lineage */}
        {card.statusNote && !statusPickerOpen ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              paddingHorizontal: 9,
              paddingVertical: 6,
              borderRadius: 7,
              backgroundColor: statusVisual.tintBg(theme),
              borderWidth: 1,
              borderColor: statusVisual.tintBorder(theme),
            }}
          >
            <Text
              numberOfLines={2}
              style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}
            >
              {card.statusNote}
            </Text>
            {card.workflowStatus === "waiting_external" ? (
              <Pressable
                onPress={() => void handleResolveSignal()}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                  backgroundColor: withAlpha(theme.colors.statusSuccess, 0.18),
                  borderWidth: 1,
                  borderColor: withAlpha(theme.colors.statusSuccess, 0.45),
                }}
              >
                <Text
                  style={{ fontSize: 11, color: theme.colors.statusSuccess, fontWeight: "700" }}
                >
                  已确认
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {variant === "corner" && card.waitCondition?.kind === "agent_settled" ? (
          <Pressable
            onPress={() =>
              onOpenAgent?.(
                card.waitCondition!.kind === "agent_settled"
                  ? card.waitCondition!.targetAgentId
                  : "",
              )
            }
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 9,
              paddingVertical: 6,
              borderRadius: 7,
              backgroundColor: theme.colors.surface0,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Icon name="GitMerge" size={12} color={theme.colors.statusWarning} />
            <Text
              numberOfLines={1}
              style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}
            >
              等待关联对话：{card.waitCondition.targetLabel || "查看目标对话"}
            </Text>
            <Icon name="ArrowUpRight" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}

        {card.forkedFromAgentId ? (
          <Pressable
            onPress={() => onOpenAgent?.(card.forkedFromAgentId!)}
            style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
          >
            <Icon name="Split" size={12} color={theme.colors.foregroundMuted} />
            <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>查看来源对话</Text>
            <Icon name="ArrowUpRight" size={11} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      {/* Todos workspace */}
      <View style={{ gap: 8 }}>
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.foreground }}>
              待办
            </Text>
            <View
              style={{
                paddingHorizontal: 7,
                paddingVertical: 1,
                borderRadius: 999,
                backgroundColor:
                  activeTodos.length > 0 ? statusVisual.tintBg(theme) : theme.colors.surface2,
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  color: activeTodos.length > 0 ? statusColor : theme.colors.foregroundMuted,
                }}
              >
                {activeTodos.length}
              </Text>
            </View>
          </View>
          {completedTodos.length > 0 ? (
            <Pressable onPress={() => setShowDoneTodos((value) => !value)}>
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                {showDoneTodos ? "隐藏已完成" : `已完成 ${completedTodos.length}`}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          style={variant === "corner" ? { maxHeight: 256 } : undefined}
          contentContainerStyle={{ gap: 7 }}
          nestedScrollEnabled
        >
          {activeTodos.length === 0 ? (
            <View
              style={{
                paddingHorizontal: 11,
                paddingVertical: 10,
                borderRadius: 9,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: theme.colors.border,
                backgroundColor: withAlpha(theme.colors.surface1, 0.5),
              }}
            >
              <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
                暂无待办——想到下一步要做的事，直接在下方回车记下
              </Text>
            </View>
          ) : (
            activeTodos.map((todo) => {
              const isExpanded = expandedTodoId === todo.id || variant === "panel";
              const isBusy = busyTodoId === todo.id;
              const isQueuedOrRunning = todo.status === "queued" || todo.status === "running";
              return (
                <View
                  key={todo.id}
                  style={{
                    padding: 10,
                    borderRadius: 9,
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor: isQueuedOrRunning
                      ? statusVisual.tintBorder(theme)
                      : theme.colors.border,
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
                    <Pressable
                      onPress={() => void handleToggleDone(todo)}
                      hitSlop={6}
                      style={{ marginTop: 2 }}
                    >
                      <Icon
                        name={todo.status === "running" ? "RotateCw" : "Circle"}
                        size={15}
                        color={isQueuedOrRunning ? statusColor : theme.colors.foregroundMuted}
                      />
                    </Pressable>

                    <Pressable
                      onPress={() =>
                        setExpandedTodoId((current) => (current === todo.id ? null : todo.id))
                      }
                      style={{ flex: 1, gap: 4 }}
                    >
                      <Text
                        numberOfLines={isExpanded ? 4 : 2}
                        style={{
                          fontSize: 13,
                          fontWeight: "500",
                          color: theme.colors.foreground,
                          lineHeight: 18,
                        }}
                      >
                        {todo.title}
                      </Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <View
                          style={{
                            paddingHorizontal: 5,
                            paddingVertical: 1,
                            borderRadius: 4,
                            backgroundColor: theme.colors.surface2,
                          }}
                        >
                          <Text style={{ fontSize: 10, color: theme.colors.foregroundMuted }}>
                            {todo.author === "user" ? "我" : "AI"}
                          </Text>
                        </View>
                        {todo.status !== "open" ? (
                          <Text
                            style={{
                              fontSize: 10,
                              fontWeight: "700",
                              color:
                                todo.status === "forked" ? theme.colors.statusSuccess : statusColor,
                            }}
                          >
                            {getTodoStatusLabel(todo.status)}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>

                    {todo.forkedAgentId ? (
                      <Pressable
                        onPress={() => onOpenAgent?.(todo.forkedAgentId!)}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 3,
                          paddingHorizontal: 7,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor: withAlpha(theme.colors.statusSuccess, 0.14),
                          borderWidth: 1,
                          borderColor: withAlpha(theme.colors.statusSuccess, 0.35),
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 11,
                            color: theme.colors.statusSuccess,
                            fontWeight: "600",
                          }}
                        >
                          分支
                        </Text>
                        <Icon name="ArrowUpRight" size={11} color={theme.colors.statusSuccess} />
                      </Pressable>
                    ) : (
                      <Pressable
                        onPress={() =>
                          void handleRunTodo(todo, isRunning ? "queue_next" : "send_now")
                        }
                        disabled={isBusy}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor: statusVisual.tintBg(theme),
                          borderWidth: 1,
                          borderColor: statusVisual.tintBorder(theme),
                          opacity: isBusy ? 0.5 : 1,
                        }}
                      >
                        <Icon name="Play" size={10} color={statusColor} />
                        <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor }}>
                          {isRunning ? "排队" : "继续"}
                        </Text>
                      </Pressable>
                    )}
                  </View>

                  {isExpanded ? (
                    <View
                      style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 23 }}
                    >
                      <ActionChip
                        theme={theme}
                        icon="SquarePen"
                        label="填入输入框"
                        disabled={isBusy}
                        onPress={() => void handleFillComposer(todo)}
                      />
                      <ActionChip
                        theme={theme}
                        icon="Split"
                        label="Fork 对话"
                        disabled={isBusy}
                        onPress={() => void handleForkTodo(todo, "same_workspace")}
                      />
                      <ActionChip
                        theme={theme}
                        icon="GitBranch"
                        label="Fork 新分支"
                        disabled={isBusy}
                        onPress={() => void handleForkTodo(todo, "new_worktree")}
                      />
                      <ActionChip
                        theme={theme}
                        icon="Trash2"
                        label="删除"
                        disabled={isBusy}
                        onPress={() => void handleRemoveTodo(todo.id)}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })
          )}

          {showDoneTodos
            ? completedTodos.map((todo) => (
                <View
                  key={todo.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface1,
                    opacity: 0.72,
                  }}
                >
                  <Pressable onPress={() => void handleToggleDone(todo)} hitSlop={4}>
                    <Icon name="CheckCircle2" size={14} color={theme.colors.statusSuccess} />
                  </Pressable>
                  <Text
                    numberOfLines={1}
                    style={{
                      flex: 1,
                      fontSize: 12,
                      color: theme.colors.foregroundMuted,
                      textDecorationLine: "line-through",
                    }}
                  >
                    {todo.title}
                  </Text>
                  <Pressable onPress={() => void handleRemoveTodo(todo.id)} hitSlop={4}>
                    <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
                  </Pressable>
                </View>
              ))
            : null}
        </ScrollView>

        {/* Suggested todos from summarizer */}
        {card.suggestedTodos.length > 0 ? (
          <View style={{ gap: 5, paddingTop: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name="Sparkles" size={11} color={theme.colors.foregroundMuted} />
              <Text
                style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foregroundMuted }}
              >
                AI 建议待办
              </Text>
            </View>
            {card.suggestedTodos.map((sug) => (
              <View
                key={sug.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <Text
                  numberOfLines={2}
                  style={{ flex: 1, fontSize: 12, color: theme.colors.foregroundMuted }}
                >
                  {sug.title}
                </Text>
                <Pressable
                  onPress={() => void handleResolveSuggested(sug.id, "accept")}
                  hitSlop={6}
                  style={{
                    paddingHorizontal: 7,
                    paddingVertical: 3,
                    borderRadius: 5,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foreground }}>
                    + 收纳
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void handleResolveSuggested(sug.id, "dismiss")}
                  hitSlop={6}
                >
                  <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {/* Quick add todo input */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 2 }}>
          <TextInput
            value={newTodoText}
            onChangeText={setNewTodoText}
            placeholder="记一条待办，回车添加…"
            placeholderTextColor={theme.colors.foregroundMuted}
            returnKeyType="done"
            onSubmitEditing={() => void handleAddTodo()}
            style={{
              flex: 1,
              fontSize: 13,
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
              borderRadius: 9,
              paddingHorizontal: 11,
              paddingVertical: 8,
            }}
          />
          <Pressable
            onPress={() => void handleAddTodo()}
            disabled={!newTodoText.trim()}
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: newTodoText.trim() ? theme.colors.accent : theme.colors.surface2,
              borderWidth: 1,
              borderColor: newTodoText.trim() ? theme.colors.accent : theme.colors.border,
            }}
          >
            <Icon
              name="Plus"
              size={15}
              color={
                newTodoText.trim() ? theme.colors.accentForeground : theme.colors.foregroundMuted
              }
            />
          </Pressable>
        </View>
      </View>

      {/* Panel-only structured WaitCondition & AdvancePolicy editor (below todos, collapsed by default) */}
      {variant === "panel" ? (
        <WaitConditionEditor
          agentId={agentId}
          workspaceId={workspaceId}
          card={card}
          theme={theme}
          onOpenAgent={onOpenAgent}
        />
      ) : null}
    </View>
  );
}

function ToolbarIconButton({
  theme,
  icon,
  accessibilityLabel,
  active,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  accessibilityLabel: string;
  active?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      accessibilityLabel={accessibilityLabel}
      style={{
        width: 26,
        height: 26,
        borderRadius: 7,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: active
          ? withAlpha(theme.colors.statusWarning, 0.16)
          : theme.colors.surface1,
        borderWidth: 1,
        borderColor: active ? withAlpha(theme.colors.statusWarning, 0.4) : theme.colors.border,
        opacity: disabled && !active ? 0.5 : 1,
      }}
    >
      <Icon
        name={icon}
        size={13}
        color={active ? theme.colors.statusWarning : theme.colors.foregroundMuted}
      />
    </Pressable>
  );
}

function ActionChip({
  theme,
  icon,
  label,
  selected,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 7,
        backgroundColor: selected
          ? withAlpha(theme.colors.statusSuccess, 0.16)
          : theme.colors.surface2,
        borderWidth: 1,
        borderColor: selected ? withAlpha(theme.colors.statusSuccess, 0.5) : theme.colors.border,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon
        name={icon}
        size={11}
        color={selected ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
      />
      <Text
        style={{
          fontSize: 11,
          fontWeight: selected ? "700" : "500",
          color: selected ? theme.colors.statusSuccess : theme.colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function WaitConditionEditor({
  agentId,
  workspaceId,
  card,
  theme,
  onOpenAgent,
}: {
  agentId: string;
  workspaceId: string | null;
  card: SessionWorkbenchCard;
  theme: PluginTheme;
  onOpenAgent?: (agentId: string) => void;
}) {
  const toast = useToast();
  const updateMeta = useRpc(updateCardMetaRpc);
  const { snapshot } = useWorkbenchOverview(false);
  const hasActiveWait =
    card.waitCondition !== null ||
    card.workflowStatus === "waiting_dependency" ||
    card.workflowStatus === "waiting_external";
  const [open, setOpen] = useState(hasActiveWait);
  const [selectedTargetId, setSelectedTargetId] = useState(
    card.waitCondition?.kind === "agent_settled" ? card.waitCondition.targetAgentId : "",
  );
  const [expectMode, setExpectMode] = useState<"idle" | "done">(
    card.waitCondition?.kind === "agent_settled" ? card.waitCondition.expect : "idle",
  );
  const [policyMode, setPolicyMode] = useState<AdvancePolicy["mode"]>(card.advancePolicy.mode);
  const [autoPrompt, setAutoPrompt] = useState(card.advancePolicy.prompt ?? "");

  const otherCards = useMemo(
    () => snapshot.cards.filter((item) => !item.archived && item.agentId !== agentId),
    [agentId, snapshot.cards],
  );

  const handleBindDependency = useCallback(async () => {
    const target = otherCards.find((item) => item.agentId === selectedTargetId);
    if (!target) {
      toast.error("请先选择一个关联对话");
      return;
    }
    const condition: WaitCondition = {
      kind: "agent_settled",
      targetAgentId: target.agentId,
      targetLabel: target.topic || target.agentTitle || "未命名对话",
      expect: expectMode,
    };
    const policy: AdvancePolicy = {
      mode: policyMode,
      ...(policyMode === "auto_send_prompt" && autoPrompt.trim()
        ? { prompt: autoPrompt.trim() }
        : {}),
    };
    try {
      await updateMeta({
        agentId,
        workspaceId,
        workflowStatus: "waiting_dependency",
        statusNote: `等待「${condition.targetLabel}」${expectMode === "idle" ? "完成本轮" : "标记完成"}`,
        waitCondition: condition,
        advancePolicy: policy,
      });
      toast.show("已绑定等待依赖与自动推进策略", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存等待条件失败");
    }
  }, [
    agentId,
    autoPrompt,
    expectMode,
    otherCards,
    policyMode,
    selectedTargetId,
    toast,
    updateMeta,
    workspaceId,
  ]);

  const handleClearDependency = useCallback(async () => {
    try {
      await updateMeta({
        agentId,
        workspaceId,
        waitCondition: null,
        workflowStatus: "active",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清除失败");
    }
  }, [agentId, toast, updateMeta, workspaceId]);

  const summaryBadge =
    card.waitCondition?.kind === "agent_settled"
      ? `等待「${card.waitCondition.targetLabel || "关联对话"}」`
      : card.waitCondition?.kind === "external_signal"
        ? "等待外部确认"
        : "未配置";

  return (
    <View
      style={{
        padding: 11,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 9,
      }}
    >
      <Pressable
        onPress={() => setOpen((value) => !value)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 }}>
          <Icon name="GitMerge" size={13} color={theme.colors.foregroundMuted} />
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.foreground }}>
            等待条件与自动推进
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: 11, color: theme.colors.foregroundMuted, maxWidth: 140 }}
          >
            {summaryBadge}
          </Text>
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            size={13}
            color={theme.colors.foregroundMuted}
          />
        </View>
      </Pressable>

      {open ? (
        <View style={{ gap: 9 }}>
          {card.waitCondition ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              {card.waitCondition.kind === "agent_settled" ? (
                <Pressable
                  onPress={() =>
                    onOpenAgent?.(
                      card.waitCondition!.kind === "agent_settled"
                        ? card.waitCondition!.targetAgentId
                        : "",
                    )
                  }
                  style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 5 }}
                >
                  <Icon name="GitMerge" size={12} color={theme.colors.statusWarning} />
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}
                  >
                    当前等待：{card.waitCondition.targetLabel || "查看目标对话"}
                  </Text>
                </Pressable>
              ) : (
                <Text style={{ flex: 1, fontSize: 12, color: theme.colors.foregroundMuted }}>
                  {summaryBadge}
                </Text>
              )}
              <Pressable onPress={() => void handleClearDependency()}>
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.statusDanger }}>
                  清除条件
                </Text>
              </Pressable>
            </View>
          ) : null}

          <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
            选择要等待的关联对话（对方达成条件后自动通知或推进）：
          </Text>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            {otherCards.slice(0, 12).map((item) => {
              const selected = selectedTargetId === item.agentId;
              const label = item.topic || item.agentTitle || "未命名对话";
              return (
                <Pressable
                  key={item.agentId}
                  onPress={() => setSelectedTargetId(item.agentId)}
                  style={{
                    paddingHorizontal: 9,
                    paddingVertical: 5,
                    borderRadius: 7,
                    backgroundColor: selected
                      ? withAlpha(theme.colors.statusSuccess, 0.16)
                      : theme.colors.surface2,
                    borderWidth: 1,
                    borderColor: selected
                      ? withAlpha(theme.colors.statusSuccess, 0.5)
                      : theme.colors.border,
                    maxWidth: 190,
                  }}
                >
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 12,
                      fontWeight: selected ? "600" : "400",
                      color: selected ? theme.colors.statusSuccess : theme.colors.foreground,
                    }}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
            {otherCards.length === 0 ? (
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                暂无其他活跃对话
              </Text>
            ) : null}
          </ScrollView>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {(
              [
                { value: "idle", label: "对方完成本轮即触发" },
                { value: "done", label: "对方标记完成后触发" },
              ] as const
            ).map((item) => (
              <ActionChip
                key={item.value}
                theme={theme}
                icon="History"
                label={item.label}
                selected={expectMode === item.value}
                onPress={() => setExpectMode(item.value)}
              />
            ))}
          </View>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {(
              [
                { value: "notify_only", label: "仅高亮提醒" },
                { value: "auto_run_next_todo", label: "自动续跑下一待办" },
                { value: "auto_send_prompt", label: "自动发继续指令" },
                { value: "delegate_to_master", label: "交由主对话(预留)" },
              ] as const
            ).map((item) => (
              <ActionChip
                key={item.value}
                theme={theme}
                icon="Zap"
                label={item.label}
                selected={policyMode === item.value}
                onPress={() => setPolicyMode(item.value)}
              />
            ))}
          </View>

          {policyMode === "auto_send_prompt" ? (
            <TextInput
              value={autoPrompt}
              onChangeText={setAutoPrompt}
              placeholder="条件达成后自动发送给当前对话的指令…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                fontSize: 12,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface0,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 7,
                paddingHorizontal: 9,
                paddingVertical: 6,
              }}
            />
          ) : null}

          <Pressable
            onPress={() => void handleBindDependency()}
            style={{
              alignSelf: "flex-start",
              paddingHorizontal: 11,
              paddingVertical: 6,
              borderRadius: 7,
              backgroundColor: theme.colors.accent,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.accentForeground }}>
              应用等待规则
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
