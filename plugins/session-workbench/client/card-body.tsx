import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useAgent, useComposers, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import {
  addBlockerRpc,
  addTodoRpc,
  forkTodoRpc,
  refreshSummaryRpc,
  removeBlockerRpc,
  removeTodoRpc,
  resolveBlockerRpc,
  resolveExternalSignalRpc,
  resolveSuggestedTodoRpc,
  runTodoRpc,
  triggerArchiveRpc,
  updateCardMetaRpc,
} from "../shared/rpc.js";
import type {
  AdvancePolicy,
  BlockerItem,
  SessionWorkbenchCard,
  TodoItem,
  WaitCondition,
  WorkflowStatus,
} from "../shared/schema.js";
import { useWorkbenchOverview, useWorkbenchSettingsValues } from "./hooks.js";
import {
  getBlockerKindMeta,
  getRuntimeStatusLabel,
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
  const removeTodo = useRpc(removeTodoRpc);
  const resolveSuggested = useRpc(resolveSuggestedTodoRpc);
  const runTodo = useRpc(runTodoRpc);
  const forkTodo = useRpc(forkTodoRpc);
  const refreshSummary = useRpc(refreshSummaryRpc);
  const resolveExternalSignal = useRpc(resolveExternalSignalRpc);
  const triggerArchive = useRpc(triggerArchiveRpc);
  const addBlocker = useRpc(addBlockerRpc);
  const resolveBlocker = useRpc(resolveBlockerRpc);
  const removeBlocker = useRpc(removeBlockerRpc);

  const [inputMode, setInputMode] = useState<"todo" | "blocker">("todo");
  const [draftText, setDraftText] = useState("");
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);
  const [busyBlockerId, setBusyBlockerId] = useState<string | null>(null);
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

  const openBlockers = useMemo(
    () => card.blockers.filter((item) => item.status === "open"),
    [card.blockers],
  );

  // Active todos strictly ordered: human-authored on top, AI-authored below.
  const activeTodos = useMemo(
    () => card.todos.filter((item) => item.status !== "done" && item.status !== "dismissed"),
    [card.todos],
  );
  const humanTodos = useMemo(
    () => activeTodos.filter((item) => item.author === "user"),
    [activeTodos],
  );
  const aiTodos = useMemo(
    () => activeTodos.filter((item) => item.author !== "user"),
    [activeTodos],
  );

  const hasLegacyWait =
    openBlockers.length === 0 &&
    (Boolean(card.statusNote) || card.waitCondition !== null) &&
    (card.workflowStatus === "waiting_external" ||
      card.workflowStatus === "waiting_dependency" ||
      card.workflowStatus === "waiting_me");

  const handleSubmitDraft = useCallback(async () => {
    const title = draftText.trim();
    if (!title) return;
    setDraftText("");
    try {
      if (inputMode === "blocker") {
        await addBlocker({
          agentId,
          workspaceId,
          title,
          kind: "external",
          author: "user",
        });
      } else {
        await addTodo({
          agentId,
          workspaceId,
          title,
          author: "user",
        });
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : inputMode === "blocker"
            ? "添加阻塞失败"
            : "添加待办失败",
      );
    }
  }, [addBlocker, addTodo, agentId, draftText, inputMode, toast, workspaceId]);

  const handleSelectStatus = useCallback(
    async (status: WorkflowStatus) => {
      try {
        await updateMeta({
          agentId,
          workspaceId,
          workflowStatus: status,
          ...(status !== "waiting_dependency" && status !== "waiting_external"
            ? { waitCondition: null }
            : {}),
        });
        setStatusPickerOpen(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新状态失败");
      }
    },
    [agentId, toast, updateMeta, workspaceId],
  );

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
    async (todo: TodoItem) => {
      setBusyTodoId(todo.id);
      try {
        const result = await runTodo({
          agentId,
          todoId: todo.id,
          mode: isRunning ? "queue_next" : "send_now",
        });
        toast.show(
          result.dispatched === "sent"
            ? `已进入执行：${todo.title}`
            : `已排入下一轮执行：${todo.title}`,
          { variant: "success" },
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "执行待办失败");
      } finally {
        setBusyTodoId(null);
      }
    },
    [agentId, isRunning, runTodo, toast],
  );

  const handleFillComposer = useCallback(
    async (todo: TodoItem) => {
      if (!composer) {
        toast.error("当前无法访问该对话输入框");
        return;
      }
      composer.setPrompt(todo.prompt?.trim() || todo.title);
      await composer.focus().catch(() => {});
      toast.show("已填入输入框", { variant: "success" });
    },
    [composer, toast],
  );

  const handleForkTodo = useCallback(
    async (todo: TodoItem) => {
      setBusyTodoId(todo.id);
      try {
        const result = await forkTodo({
          agentId,
          todoId: todo.id,
          forkMode: "same_workspace",
        });
        toast.show("已 Fork 新对话执行", { variant: "success" });
        onOpenAgent?.(result.newAgentId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Fork 待办失败");
      } finally {
        setBusyTodoId(null);
      }
    },
    [agentId, forkTodo, onOpenAgent, toast],
  );

  const handleRemoveTodo = useCallback(
    async (todoId: string) => {
      try {
        await removeTodo({ agentId, todoId });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "关闭待办失败");
      }
    },
    [agentId, removeTodo, toast],
  );

  const handleResolveBlocker = useCallback(
    async (blockerId: string) => {
      setBusyBlockerId(blockerId);
      try {
        await resolveBlocker({ agentId, blockerId });
        toast.show("阻塞已解除", { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "解除阻塞失败");
      } finally {
        setBusyBlockerId(null);
      }
    },
    [agentId, resolveBlocker, toast],
  );

  const handleRemoveBlocker = useCallback(
    async (blockerId: string) => {
      try {
        await removeBlocker({ agentId, blockerId });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "关闭阻塞失败");
      }
    },
    [agentId, removeBlocker, toast],
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

  const handleResolveLegacySignal = useCallback(async () => {
    try {
      await resolveExternalSignal({ agentId });
      toast.show("阻塞已解除", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    }
  }, [agentId, resolveExternalSignal, toast]);

  const renderTodoRow = (todo: TodoItem) => {
    const isBusy = busyTodoId === todo.id;
    const isTodoRunning = todo.status === "running";
    const isTodoQueued = todo.status === "queued";
    const isTodoForked = todo.status === "forked";

    const rowBg = isTodoRunning
      ? withAlpha(theme.colors.statusSuccess, 0.14)
      : isTodoQueued
        ? withAlpha(theme.colors.statusWarning, 0.12)
        : theme.colors.surface1;

    const rowBorder = isTodoRunning
      ? withAlpha(theme.colors.statusSuccess, 0.45)
      : isTodoQueued
        ? withAlpha(theme.colors.statusWarning, 0.4)
        : theme.colors.border;

    return (
      <View
        key={todo.id}
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 9,
          borderRadius: 10,
          backgroundColor: rowBg,
          borderWidth: 1,
          borderColor: rowBorder,
          ...(isTodoRunning
            ? { borderLeftWidth: 3, borderLeftColor: theme.colors.statusSuccess }
            : isTodoQueued
              ? { borderLeftWidth: 3, borderLeftColor: theme.colors.statusWarning }
              : {}),
        }}
      >
        {/* Left small × to close/dismiss todo */}
        <Pressable
          onPress={() => void handleRemoveTodo(todo.id)}
          hitSlop={6}
          accessibilityLabel="关闭待办"
          style={{
            marginTop: 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(theme.colors.foregroundMuted, 0.12),
          }}
        >
          <Icon name="X" size={11} color={theme.colors.foregroundMuted} />
        </Pressable>

        {/* Todo text: wraps freely; click directly fills the composer input */}
        <Pressable
          onPress={() => void handleFillComposer(todo)}
          style={{ flex: 1, flexShrink: 1, minWidth: 0, gap: 4 }}
        >
          <Text
            style={{
              fontSize: 13,
              fontWeight: isTodoRunning ? "600" : "500",
              color: theme.colors.foreground,
              lineHeight: 19,
            }}
          >
            {todo.title}
          </Text>
          {isTodoRunning || isTodoQueued || isTodoForked ? (
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              {isTodoRunning ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 6,
                    paddingVertical: 1,
                    borderRadius: 999,
                    backgroundColor: withAlpha(theme.colors.statusSuccess, 0.18),
                  }}
                >
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      backgroundColor: theme.colors.statusSuccess,
                    }}
                  />
                  <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.statusSuccess }}>
                    执行中 · 完成后自动归档
                  </Text>
                </View>
              ) : null}
              {isTodoQueued ? (
                <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.statusWarning }}>
                  ● 已排入下一轮
                </Text>
              ) : null}
              {isTodoForked ? (
                <Text style={{ fontSize: 10, fontWeight: "600", color: theme.colors.statusSuccess }}>
                  已 Fork 新对话
                </Text>
              ) : null}
            </View>
          ) : null}
        </Pressable>

        {/* Right actions: ONLY Continue/Queue + Fork New Conversation */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0, marginTop: 1 }}>
          {todo.forkedAgentId ? (
            <Pressable
              onPress={() => onOpenAgent?.(todo.forkedAgentId!)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 3,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 7,
                backgroundColor: withAlpha(theme.colors.statusSuccess, 0.14),
                borderWidth: 1,
                borderColor: withAlpha(theme.colors.statusSuccess, 0.35),
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.statusSuccess }}>
                打开对话
              </Text>
              <Icon name="ArrowUpRight" size={11} color={theme.colors.statusSuccess} />
            </Pressable>
          ) : (
            <>
              {!isTodoRunning ? (
                <Pressable
                  onPress={() => void handleRunTodo(todo)}
                  disabled={isBusy}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 7,
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
              ) : null}
              <Pressable
                onPress={() => void handleForkTodo(todo)}
                disabled={isBusy}
                accessibilityLabel="Fork 新对话运行"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 3,
                  paddingHorizontal: 7,
                  paddingVertical: 4,
                  borderRadius: 7,
                  backgroundColor: theme.colors.surface2,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  opacity: isBusy ? 0.5 : 1,
                }}
              >
                <Icon name="Split" size={11} color={theme.colors.foregroundMuted} />
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foreground }}>
                  Fork
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    );
  };

  const renderBlockerRow = (blocker: BlockerItem) => {
    const kindMeta = getBlockerKindMeta(blocker.kind);
    const kindColor = kindMeta.color(theme);
    const isBusy = busyBlockerId === blocker.id;
    return (
      <View
        key={blocker.id}
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 8,
          paddingHorizontal: 10,
          paddingVertical: 9,
          borderRadius: 10,
          backgroundColor: withAlpha(kindColor, 0.1),
          borderWidth: 1,
          borderColor: withAlpha(kindColor, 0.32),
        }}
      >
        <Pressable
          onPress={() => void handleRemoveBlocker(blocker.id)}
          hitSlop={6}
          accessibilityLabel="移除阻塞项"
          style={{
            marginTop: 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(kindColor, 0.16),
          }}
        >
          <Icon name="X" size={11} color={kindColor} />
        </Pressable>

        <View style={{ flex: 1, flexShrink: 1, minWidth: 0, gap: 4 }}>
          <Text
            style={{
              fontSize: 13,
              fontWeight: "500",
              color: theme.colors.foreground,
              lineHeight: 19,
            }}
          >
            {blocker.title}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <View
              style={{
                paddingHorizontal: 6,
                paddingVertical: 1,
                borderRadius: 999,
                backgroundColor: withAlpha(kindColor, 0.16),
              }}
            >
              <Text style={{ fontSize: 10, fontWeight: "700", color: kindColor }}>
                {kindMeta.label}
              </Text>
            </View>
            <Text style={{ fontSize: 10, color: theme.colors.foregroundMuted }}>
              {blocker.author === "user" ? "我记的" : "AI 识别"}
            </Text>
            {blocker.targetAgentId ? (
              <Pressable
                onPress={() => onOpenAgent?.(blocker.targetAgentId!)}
                style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
              >
                <Text style={{ fontSize: 10, fontWeight: "600", color: kindColor }}>
                  查看关联对话
                </Text>
                <Icon name="ArrowUpRight" size={10} color={kindColor} />
              </Pressable>
            ) : null}
          </View>
        </View>

        <Pressable
          onPress={() => void handleResolveBlocker(blocker.id)}
          disabled={isBusy}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 3,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 7,
            backgroundColor: withAlpha(theme.colors.statusSuccess, 0.16),
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.statusSuccess, 0.42),
            opacity: isBusy ? 0.5 : 1,
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <Icon name="CheckCircle2" size={11} color={theme.colors.statusSuccess} />
          <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.statusSuccess }}>
            已解除
          </Text>
        </Pressable>
      </View>
    );
  };

  return (
    <View style={{ padding: variant === "corner" ? 15 : 0, gap: 12 }}>
      {/* Row 1: Primary Topic Headline + Status Pill */}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <View style={{ flex: 1, flexShrink: 1, minWidth: 0 }}>
            {editingTopic ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <TextInput
                  value={topicDraft}
                  onChangeText={setTopicDraft}
                  autoFocus
                  onSubmitEditing={() => void handleSaveTopic()}
                  placeholder="输入对话主题工作"
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={{
                    flex: 1,
                    fontSize: 15,
                    fontWeight: "700",
                    color: theme.colors.foreground,
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor: statusColor,
                    borderRadius: 8,
                    paddingHorizontal: 9,
                    paddingVertical: 5,
                  }}
                />
                <Pressable
                  onPress={() => void handleSaveTopic()}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 7,
                    backgroundColor: theme.colors.accent,
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.accentForeground }}>
                    确定
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                <Pressable
                  onPress={() => {
                    setTopicDraft(card.topic || card.agentTitle || "");
                    setEditingTopic(true);
                  }}
                  style={{ flex: 1, flexShrink: 1, minWidth: 0 }}
                >
                  <Text
                    style={{
                      fontSize: 17,
                      fontWeight: "700",
                      lineHeight: 23,
                      color:
                        card.topic || card.agentTitle
                          ? theme.colors.foreground
                          : theme.colors.foregroundMuted,
                    }}
                  >
                    {card.topic || card.agentTitle || "待自动总结主题…"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void handleToggleTopicLock()}
                  hitSlop={6}
                  accessibilityLabel={card.topicLocked ? "解锁主题允许 AI 更新" : "锁定主题禁止 AI 覆盖"}
                  style={{ marginTop: 4 }}
                >
                  <Icon
                    name={card.topicLocked ? "Pin" : "PinOff"}
                    size={12}
                    color={card.topicLocked ? statusColor : theme.colors.foregroundMuted}
                  />
                </Pressable>
              </View>
            )}
          </View>

          <Pressable
            onPress={() => {
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
              flexShrink: 0,
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
        </View>

        {statusPickerOpen ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 6,
              padding: 9,
              borderRadius: 10,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
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
        ) : null}

        {/* Archive status banner */}
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
              <Text style={{ flex: 1, fontSize: 12, color: theme.colors.foreground, lineHeight: 17 }}>
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

        {/* Archive inline confirmation box */}
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
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted, lineHeight: 16 }}>
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
                  <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.accentForeground }}>
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
                  <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>编辑命令</Text>
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
      </View>

      {/* Centerpiece Hero Block: Current Progress */}
      <View
        style={{
          paddingHorizontal: 13,
          paddingVertical: 12,
          borderRadius: 12,
          backgroundColor: withAlpha(statusColor, 0.13),
          borderWidth: 1,
          borderColor: withAlpha(statusColor, 0.38),
          borderLeftWidth: 4,
          borderLeftColor: statusColor,
          gap: 7,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="Zap" size={13} color={statusColor} />
            <Text style={{ fontSize: 11, fontWeight: "800", color: statusColor }}>
              {isSummarizing ? "轻量模型总结中…" : isRunning ? "正在推进" : "当前进展"}
            </Text>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {card.summaryModel ? (
              <View
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 5,
                  backgroundColor: withAlpha(theme.colors.surface0, 0.72),
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 10, color: theme.colors.foregroundMuted, maxWidth: 140 }}
                >
                  {card.summaryModel}
                </Text>
              </View>
            ) : null}
            <Pressable
              onPress={() => void handleRefreshSummary()}
              disabled={isSummarizing}
              hitSlop={6}
              accessibilityLabel="立即刷新摘要"
              style={{
                padding: 4,
                borderRadius: 6,
                backgroundColor: withAlpha(theme.colors.surface0, 0.72),
              }}
            >
              <Icon
                name="RefreshCw"
                size={12}
                color={isSummarizing ? theme.colors.statusWarning : theme.colors.foregroundMuted}
              />
            </Pressable>
          </View>
        </View>

        <Text
          style={{
            fontSize: 14,
            lineHeight: 21,
            fontWeight: card.currentWork ? "600" : "400",
            color: card.currentWork ? theme.colors.foreground : theme.colors.foregroundMuted,
          }}
        >
          {card.currentWork || "完成首轮对话后自动由轻量模型总结当前进展"}
        </Text>

        {card.summaryError ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              paddingHorizontal: 9,
              paddingVertical: 6,
              borderRadius: 8,
              backgroundColor: withAlpha(theme.colors.statusDanger, 0.14),
              borderWidth: 1,
              borderColor: withAlpha(theme.colors.statusDanger, 0.36),
            }}
          >
            <Text style={{ flex: 1, fontSize: 11, lineHeight: 16, color: theme.colors.statusDanger }}>
              摘要失败：{card.summaryError}
            </Text>
            <Pressable
              onPress={() => void handleRefreshSummary()}
              disabled={isSummarizing}
              style={{
                paddingHorizontal: 7,
                paddingVertical: 3,
                borderRadius: 5,
                backgroundColor: withAlpha(theme.colors.statusDanger, 0.2),
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.statusDanger }}>
                重试
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* Condition met notification */}
      {card.conditionMetNotice ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 9,
            backgroundColor: withAlpha(theme.colors.statusSuccess, 0.14),
            borderWidth: 1,
            borderColor: withAlpha(theme.colors.statusSuccess, 0.36),
          }}
        >
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="Sparkles" size={13} color={theme.colors.statusSuccess} />
            <Text style={{ flex: 1, fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}>
              {card.conditionMetNotice}
            </Text>
          </View>
          <Pressable onPress={() => void handleClearNotice()} hitSlop={6}>
            <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ) : null}

      {/* Scrollable workspace: Blockers + Todos + AI Suggestions */}
      <ScrollView
        style={variant === "corner" ? { maxHeight: 300 } : undefined}
        contentContainerStyle={{ gap: 10 }}
        nestedScrollEnabled
      >
        {/* Structured Blockers Section */}
        {openBlockers.length > 0 || hasLegacyWait ? (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Icon name="History" size={12} color={theme.colors.statusWarning} />
                <Text style={{ fontSize: 11, fontWeight: "800", color: theme.colors.statusWarning }}>
                  阻塞中 · {openBlockers.length || 1}
                </Text>
              </View>
              <Text style={{ fontSize: 10, color: theme.colors.foregroundMuted }}>
                解除后自动恢复推进
              </Text>
            </View>

            {openBlockers.map((blocker) => renderBlockerRow(blocker))}

            {hasLegacyWait ? (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 9,
                  borderRadius: 10,
                  backgroundColor: withAlpha(theme.colors.statusWarning, 0.1),
                  borderWidth: 1,
                  borderColor: withAlpha(theme.colors.statusWarning, 0.32),
                }}
              >
                <View style={{ flex: 1, flexShrink: 1, minWidth: 0, gap: 4 }}>
                  <Text style={{ fontSize: 13, fontWeight: "500", color: theme.colors.foreground, lineHeight: 19 }}>
                    {card.statusNote ||
                      (card.waitCondition?.kind === "agent_settled"
                        ? `等待关联对话「${card.waitCondition.targetLabel || "目标对话"}」`
                        : "等待外部确认")}
                  </Text>
                  {card.waitCondition?.kind === "agent_settled" ? (
                    <Pressable
                      onPress={() =>
                        onOpenAgent?.(
                          card.waitCondition!.kind === "agent_settled"
                            ? card.waitCondition!.targetAgentId
                            : "",
                        )
                      }
                      style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.statusWarning }}>
                        打开关联对话
                      </Text>
                      <Icon name="ArrowUpRight" size={11} color={theme.colors.statusWarning} />
                    </Pressable>
                  ) : null}
                </View>
                <Pressable
                  onPress={() => void handleResolveLegacySignal()}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 3,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 7,
                    backgroundColor: withAlpha(theme.colors.statusSuccess, 0.16),
                    borderWidth: 1,
                    borderColor: withAlpha(theme.colors.statusSuccess, 0.42),
                  }}
                >
                  <Icon name="CheckCircle2" size={11} color={theme.colors.statusSuccess} />
                  <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.statusSuccess }}>
                    已解除
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Todos Section: Human on top, AI below */}
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.foregroundMuted }}>
              待办 · {activeTodos.length}
            </Text>
            {activeTodos.length > 0 ? (
              <Text style={{ fontSize: 10, color: theme.colors.foregroundMuted }}>
                点文字填入输入框
              </Text>
            ) : null}
          </View>

          {activeTodos.length === 0 ? (
            <View
              style={{
                paddingHorizontal: 11,
                paddingVertical: 9,
                borderRadius: 9,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: theme.colors.border,
              }}
            >
              <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, lineHeight: 18 }}>
                暂无待办——随时在下方记下下一步工作，或切换「阻塞」记下等待项
              </Text>
            </View>
          ) : (
            <View style={{ gap: 6 }}>
              {humanTodos.length > 0 && aiTodos.length > 0 ? (
                <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
                  我记的
                </Text>
              ) : null}
              {humanTodos.map((todo) => renderTodoRow(todo))}

              {aiTodos.length > 0 ? (
                <View style={{ gap: 6, marginTop: humanTodos.length > 0 ? 4 : 0 }}>
                  <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
                    AI 记录
                  </Text>
                  {aiTodos.map((todo) => renderTodoRow(todo))}
                </View>
              ) : null}
            </View>
          )}
        </View>

        {/* AI Suggested Todos (full multi-line wrap) */}
        {card.suggestedTodos.length > 0 ? (
          <View style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name="Sparkles" size={11} color={theme.colors.foregroundMuted} />
              <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
                AI 建议待办
              </Text>
            </View>
            {card.suggestedTodos.map((sug) => (
              <View
                key={sug.id}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 8,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 9,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface1,
                }}
              >
                <Text
                  style={{
                    flex: 1,
                    flexShrink: 1,
                    minWidth: 0,
                    fontSize: 12,
                    lineHeight: 18,
                    color: theme.colors.foregroundMuted,
                  }}
                >
                  {sug.title}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0 }}>
                  <Pressable
                    onPress={() => void handleResolveSuggested(sug.id, "accept")}
                    hitSlop={4}
                    style={{
                      paddingHorizontal: 7,
                      paddingVertical: 3,
                      borderRadius: 6,
                      backgroundColor: statusVisual.tintBg(theme),
                      borderWidth: 1,
                      borderColor: statusVisual.tintBorder(theme),
                    }}
                  >
                    <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor }}>
                      + 收纳
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void handleResolveSuggested(sug.id, "dismiss")}
                    hitSlop={4}
                    style={{ padding: 3 }}
                  >
                    <Icon name="X" size={12} color={theme.colors.foregroundMuted} />
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Bottom Quick-Add Bar with Todo / Blocker Toggle */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 6,
          paddingVertical: 5,
          borderRadius: 11,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor:
            inputMode === "blocker"
              ? withAlpha(theme.colors.statusWarning, 0.48)
              : theme.colors.border,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            borderRadius: 7,
            backgroundColor: theme.colors.surface2,
            padding: 2,
          }}
        >
          <Pressable
            onPress={() => setInputMode("todo")}
            style={{
              paddingHorizontal: 7,
              paddingVertical: 4,
              borderRadius: 5,
              backgroundColor: inputMode === "todo" ? theme.colors.surface0 : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color: inputMode === "todo" ? theme.colors.foreground : theme.colors.foregroundMuted,
              }}
            >
              待办
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setInputMode("blocker")}
            style={{
              paddingHorizontal: 7,
              paddingVertical: 4,
              borderRadius: 5,
              backgroundColor:
                inputMode === "blocker"
                  ? withAlpha(theme.colors.statusWarning, 0.2)
                  : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: 11,
                fontWeight: "700",
                color:
                  inputMode === "blocker"
                    ? theme.colors.statusWarning
                    : theme.colors.foregroundMuted,
              }}
            >
              阻塞
            </Text>
          </Pressable>
        </View>

        <TextInput
          value={draftText}
          onChangeText={setDraftText}
          placeholder={
            inputMode === "blocker"
              ? "记一条阻塞项，回车添加（如：等后端确认）…"
              : "记一条待办，回车添加…"
          }
          placeholderTextColor={theme.colors.foregroundMuted}
          returnKeyType="done"
          onSubmitEditing={() => void handleSubmitDraft()}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            color: theme.colors.foreground,
            paddingHorizontal: 4,
            paddingVertical: 4,
          }}
        />

        <Pressable
          onPress={() => void handleSubmitDraft()}
          disabled={!draftText.trim()}
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: draftText.trim()
              ? inputMode === "blocker"
                ? theme.colors.statusWarning
                : theme.colors.accent
              : theme.colors.surface2,
          }}
        >
          <Icon
            name="Plus"
            size={14}
            color={draftText.trim() ? theme.colors.accentForeground : theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>

      {/* Clean Minimal Footer (with Archive button integrated cleanly) */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 4,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                backgroundColor: isRunning ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
              }}
            />
            <Text
              style={{
                fontSize: 11,
                fontWeight: isRunning ? "600" : "400",
                color: isRunning ? theme.colors.statusSuccess : theme.colors.foregroundMuted,
              }}
            >
              {getRuntimeStatusLabel(effectiveRuntime)}
            </Text>
          </View>
          {card.forkedFromAgentId ? (
            <Pressable
              onPress={() => onOpenAgent?.(card.forkedFromAgentId!)}
              style={{ flexDirection: "row", alignItems: "center", gap: 3 }}
            >
              <Icon name="Split" size={11} color={theme.colors.foregroundMuted} />
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>来源对话</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {!card.archived ? (
            <Pressable
              onPress={() => {
                setStatusPickerOpen(false);
                setArchiveConfirmOpen((open) => !open);
              }}
              disabled={isArchiveInProgress}
              hitSlop={6}
              accessibilityLabel="发送归档命令清理工程痕迹"
              style={{ flexDirection: "row", alignItems: "center", gap: 3, opacity: isArchiveInProgress ? 0.5 : 1 }}
            >
              <Icon
                name="Archive"
                size={11}
                color={
                  archiveConfirmOpen || isArchiveQueued || isArchiveInProgress
                    ? theme.colors.statusWarning
                    : theme.colors.foregroundMuted
                }
              />
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "600",
                  color:
                    archiveConfirmOpen || isArchiveQueued || isArchiveInProgress
                      ? theme.colors.statusWarning
                      : theme.colors.foregroundMuted,
                }}
              >
                {isArchiveQueued ? "归档已排队" : "归档"}
              </Text>
            </Pressable>
          ) : null}
          {onOpenOverview ? (
            <Pressable onPress={onOpenOverview} hitSlop={6}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foregroundMuted }}>
                总览
              </Text>
            </Pressable>
          ) : null}
          {onPinToPanel ? (
            <Pressable onPress={onPinToPanel} hitSlop={6}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foregroundMuted }}>
                侧栏
              </Text>
            </Pressable>
          ) : null}
          {onCollapse ? (
            <Pressable onPress={onCollapse} hitSlop={6}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foregroundMuted }}>
                收起
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* Panel-only cross-conversation dependency binder */}
      {variant === "panel" ? (
        <WaitDependencyEditor
          agentId={agentId}
          workspaceId={workspaceId}
          card={card}
          theme={theme}
        />
      ) : null}
    </View>
  );
}

function WaitDependencyEditor({
  agentId,
  workspaceId,
  card,
  theme,
}: {
  agentId: string;
  workspaceId: string | null;
  card: SessionWorkbenchCard;
  theme: PluginTheme;
}) {
  const toast = useToast();
  const updateMeta = useRpc(updateCardMetaRpc);
  const addBlocker = useRpc(addBlockerRpc);
  const { snapshot } = useWorkbenchOverview(false);
  const [open, setOpen] = useState(false);
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
    const targetLabel = target.topic || target.agentTitle || "关联对话";
    const title = `等待「${targetLabel}」${expectMode === "idle" ? "完成本轮" : "标记完成"}`;
    const condition: WaitCondition = {
      kind: "agent_settled",
      targetAgentId: target.agentId,
      targetLabel,
      expect: expectMode,
      reason: title,
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
        waitCondition: condition,
        advancePolicy: policy,
      });
      await addBlocker({
        agentId,
        workspaceId,
        title,
        kind: "dependency",
        author: "user",
        targetAgentId: target.agentId,
        targetLabel,
        expect: expectMode,
      });
      setOpen(false);
      toast.show("已添加跨对话阻塞依赖", { variant: "success" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存等待依赖失败");
    }
  }, [
    addBlocker,
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
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="GitMerge" size={13} color={theme.colors.foregroundMuted} />
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.foreground }}>
            绑定跨对话阻塞与自动推进
          </Text>
        </View>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
      </Pressable>

      {open ? (
        <View style={{ gap: 9 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
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
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>暂无其他活跃对话</Text>
            ) : null}
          </ScrollView>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {(
              [
                { value: "idle", label: "对方完成本轮即解除" },
                { value: "done", label: "对方标记完成后解除" },
              ] as const
            ).map((item) => (
              <Pressable
                key={item.value}
                onPress={() => setExpectMode(item.value)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 7,
                  backgroundColor:
                    expectMode === item.value
                      ? withAlpha(theme.colors.statusSuccess, 0.16)
                      : theme.colors.surface2,
                  borderWidth: 1,
                  borderColor:
                    expectMode === item.value
                      ? withAlpha(theme.colors.statusSuccess, 0.5)
                      : theme.colors.border,
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: expectMode === item.value ? "700" : "500",
                    color:
                      expectMode === item.value
                        ? theme.colors.statusSuccess
                        : theme.colors.foreground,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
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
              <Pressable
                key={item.value}
                onPress={() => setPolicyMode(item.value)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 7,
                  backgroundColor:
                    policyMode === item.value
                      ? withAlpha(theme.colors.statusSuccess, 0.16)
                      : theme.colors.surface2,
                  borderWidth: 1,
                  borderColor:
                    policyMode === item.value
                      ? withAlpha(theme.colors.statusSuccess, 0.5)
                      : theme.colors.border,
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: policyMode === item.value ? "700" : "500",
                    color:
                      policyMode === item.value
                        ? theme.colors.statusSuccess
                        : theme.colors.foreground,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {policyMode === "auto_send_prompt" ? (
            <TextInput
              value={autoPrompt}
              onChangeText={setAutoPrompt}
              placeholder="解除后自动发送给当前对话的指令…"
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
              添加跨对话阻塞
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
