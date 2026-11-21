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
import { useWorkbenchOverview } from "./hooks.js";
import {
  getRuntimeStatusLabel,
  getTodoStatusLabel,
  getWorkflowStatusVisual,
  WORKFLOW_STATUS_LIST,
} from "./status-meta.js";

export interface WorkbenchCardBodyProps {
  agentId: string;
  workspaceId: string | null;
  card: SessionWorkbenchCard;
  theme: PluginTheme;
  variant: "corner" | "panel";
  onOpenAgent?: (agentId: string) => void;
}

export function WorkbenchCardBody({
  agentId,
  workspaceId,
  card,
  theme,
  variant,
  onOpenAgent,
}: WorkbenchCardBodyProps) {
  const toast = useToast();
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

  const [newTodoText, setNewTodoText] = useState("");
  const [expandedTodoId, setExpandedTodoId] = useState<string | null>(null);
  const [showDoneTodos, setShowDoneTodos] = useState(false);
  const [statusPickerOpen, setStatusPickerOpen] = useState(false);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState("");
  const [statusNoteDraft, setStatusNoteDraft] = useState("");
  const [busyTodoId, setBusyTodoId] = useState<string | null>(null);
  const [refreshingSummary, setRefreshingSummary] = useState(false);

  const isRunning = (agentSnapshot?.status ?? card.runtimeStatus) === "running";
  const statusVisual = getWorkflowStatusVisual(card.workflowStatus);
  const statusColor = statusVisual.color(theme);

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
    <View style={{ gap: 10 }}>
      {/* Condition met highlight banner */}
      {card.conditionMetNotice ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.statusWarning,
          }}
        >
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="Sparkles" size={13} color={theme.colors.statusWarning} />
            <Text style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}>
              {card.conditionMetNotice}
            </Text>
          </View>
          <Pressable onPress={() => void handleClearNotice()} hitSlop={6}>
            <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      ) : null}

      {/* Status row + quick picker */}
      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Pressable
            onPress={() => {
              setStatusNoteDraft(card.statusNote);
              setStatusPickerOpen((open) => !open);
            }}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 999,
              backgroundColor: theme.colors.surface2,
              borderWidth: 1,
              borderColor: theme.colors.border,
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
            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}>
              {statusVisual.label}
            </Text>
            <Icon
              name={statusPickerOpen ? "ChevronRight" : "ChevronDown"}
              size={12}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
              {getRuntimeStatusLabel(agentSnapshot?.status ?? card.runtimeStatus)}
            </Text>
            <Pressable
              onPress={() => void handleRefreshSummary()}
              disabled={refreshingSummary || card.summaryState === "running"}
              style={{
                padding: 4,
                borderRadius: 6,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Icon
                name="RefreshCw"
                size={12}
                color={
                  refreshingSummary || card.summaryState === "running"
                    ? theme.colors.accent
                    : theme.colors.foregroundMuted
                }
              />
            </Pressable>
          </View>
        </View>

        {card.statusNote && !statusPickerOpen ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text
              numberOfLines={2}
              style={{ flex: 1, fontSize: 11, color: theme.colors.foregroundMuted }}
            >
              备注：{card.statusNote}
            </Text>
            {card.workflowStatus === "waiting_external" ? (
              <Pressable
                onPress={() => void handleResolveSignal()}
                style={{
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                  borderRadius: 5,
                  backgroundColor: theme.colors.surface2,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text style={{ fontSize: 10, color: theme.colors.statusSuccess, fontWeight: "600" }}>
                  已确认
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {statusPickerOpen ? (
          <View
            style={{
              padding: 8,
              borderRadius: 8,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {WORKFLOW_STATUS_LIST.map((item) => {
                const selected = item.value === card.workflowStatus;
                return (
                  <Pressable
                    key={item.value}
                    onPress={() => void handleSelectStatus(item.value)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 5,
                      paddingHorizontal: 8,
                      paddingVertical: 4,
                      borderRadius: 6,
                      backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
                      borderWidth: 1,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        backgroundColor: selected
                          ? theme.colors.accentForeground
                          : item.color(theme),
                      }}
                    />
                    <Text
                      style={{
                        fontSize: 11,
                        fontWeight: "600",
                        color: selected ? theme.colors.accentForeground : theme.colors.foreground,
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
                placeholder="填写等待原因或状态备注（如：等前端接口确认）"
                placeholderTextColor={theme.colors.foregroundMuted}
                onSubmitEditing={() => void handleSaveStatusNote()}
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: theme.colors.foreground,
                  backgroundColor: theme.colors.surface0,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                }}
              />
              <Pressable
                onPress={() => void handleSaveStatusNote()}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 6,
                  backgroundColor: theme.colors.accent,
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.accentForeground }}>
                  保存
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      {/* Topic & Current work */}
      <View
        style={{
          padding: 9,
          borderRadius: 8,
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          gap: 6,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
            主题工作
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Pressable
              onPress={() => void handleToggleTopicLock()}
              hitSlop={4}
              accessibilityLabel={card.topicLocked ? "解锁主题允许 AI 更新" : "锁定主题禁止 AI 覆盖"}
            >
              <Icon
                name={card.topicLocked ? "Pin" : "PinOff"}
                size={11}
                color={card.topicLocked ? theme.colors.accent : theme.colors.foregroundMuted}
              />
            </Pressable>
            <Pressable
              onPress={() => {
                setTopicDraft(card.topic || card.agentTitle || "");
                setEditingTopic((value) => !value);
              }}
              hitSlop={4}
            >
              <Icon name="Pencil" size={11} color={theme.colors.foregroundMuted} />
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
                fontSize: 12,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface0,
                borderWidth: 1,
                borderColor: theme.colors.accent,
                borderRadius: 6,
                paddingHorizontal: 7,
                paddingVertical: 4,
              }}
            />
            <Pressable
              onPress={() => void handleSaveTopic()}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: theme.colors.accent,
              }}
            >
              <Text style={{ fontSize: 11, color: theme.colors.accentForeground, fontWeight: "600" }}>
                确定
              </Text>
            </Pressable>
          </View>
        ) : (
          <Text
            numberOfLines={2}
            style={{ fontSize: 13, fontWeight: "600", color: theme.colors.foreground }}
          >
            {card.topic || card.agentTitle || "待自动总结主题…"}
          </Text>
        )}

        <View
          style={{
            height: 1,
            backgroundColor: theme.colors.border,
            opacity: 0.6,
          }}
        />

        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
              当前在做
            </Text>
            {card.summaryState === "running" || refreshingSummary ? (
              <Text style={{ fontSize: 10, color: theme.colors.accent }}>AI 总结中…</Text>
            ) : null}
          </View>
          <Text
            numberOfLines={variant === "corner" ? 2 : 4}
            style={{ fontSize: 12, color: theme.colors.foreground, lineHeight: 17 }}
          >
            {card.currentWork || "完成首轮对话后自动总结当前进展"}
          </Text>
          {card.summaryError ? (
            <Text numberOfLines={2} style={{ fontSize: 11, color: theme.colors.statusDanger }}>
              摘要失败：{card.summaryError}
            </Text>
          ) : null}
        </View>

        {card.forkedFromAgentId ? (
          <Pressable
            onPress={() => onOpenAgent?.(card.forkedFromAgentId!)}
            style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}
          >
            <Icon name="Split" size={11} color={theme.colors.accent} />
            <Text style={{ fontSize: 11, color: theme.colors.accent }}>
              查看来源对话
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Panel-only structured WaitCondition & AdvancePolicy editor */}
      {variant === "panel" ? (
        <WaitConditionEditor
          agentId={agentId}
          workspaceId={workspaceId}
          card={card}
          theme={theme}
          onOpenAgent={onOpenAgent}
        />
      ) : card.waitCondition?.kind === "agent_settled" ? (
        <Pressable
          onPress={() => onOpenAgent?.(card.waitCondition!.kind === "agent_settled" ? card.waitCondition!.targetAgentId : "")}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderRadius: 6,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Icon name="GitMerge" size={12} color={theme.colors.accent} />
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 11, color: theme.colors.foreground }}>
            等待对话：{card.waitCondition.targetLabel || card.waitCondition.targetAgentId.slice(0, 10)}
          </Text>
        </Pressable>
      ) : null}

      {/* Todos section */}
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.foregroundMuted }}>
            待办（{activeTodos.length}）
          </Text>
          {completedTodos.length > 0 ? (
            <Pressable onPress={() => setShowDoneTodos((value) => !value)}>
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                {showDoneTodos ? "隐藏已完成" : `已完成 ${completedTodos.length}`}
              </Text>
            </Pressable>
          ) : null}
        </View>

        <ScrollView
          style={variant === "corner" ? { maxHeight: 176 } : undefined}
          contentContainerStyle={{ gap: 6 }}
          nestedScrollEnabled
        >
          {activeTodos.length === 0 ? (
            <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted, paddingVertical: 4 }}>
              暂无待办，随时在下方记下接下来要做的事
            </Text>
          ) : (
            activeTodos.map((todo) => {
              const isExpanded = expandedTodoId === todo.id || variant === "panel";
              const isBusy = busyTodoId === todo.id;
              return (
                <View
                  key={todo.id}
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface1,
                    borderWidth: 1,
                    borderColor:
                      todo.status === "queued" || todo.status === "running"
                        ? theme.colors.accent
                        : theme.colors.border,
                    gap: 6,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
                    <Pressable
                      onPress={() => void handleToggleDone(todo)}
                      hitSlop={4}
                      style={{ marginTop: 2 }}
                    >
                      <Icon
                        name={todo.status === "running" ? "RotateCw" : "Circle"}
                        size={14}
                        color={
                          todo.status === "running" || todo.status === "queued"
                            ? theme.colors.accent
                            : theme.colors.foregroundMuted
                        }
                      />
                    </Pressable>

                    <Pressable
                      onPress={() =>
                        setExpandedTodoId((current) => (current === todo.id ? null : todo.id))
                      }
                      style={{ flex: 1, gap: 2 }}
                    >
                      <Text
                        numberOfLines={isExpanded ? 4 : 2}
                        style={{ fontSize: 12, color: theme.colors.foreground, lineHeight: 17 }}
                      >
                        {todo.title}
                      </Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={{ fontSize: 10, color: theme.colors.foregroundMuted }}>
                          {todo.author === "user" ? "我" : "AI"}
                        </Text>
                        {todo.status !== "open" ? (
                          <Text
                            style={{
                              fontSize: 10,
                              fontWeight: "600",
                              color:
                                todo.status === "forked"
                                  ? theme.colors.statusSuccess
                                  : theme.colors.accent,
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
                          paddingHorizontal: 6,
                          paddingVertical: 3,
                          borderRadius: 5,
                          backgroundColor: theme.colors.surface2,
                        }}
                      >
                        <Text style={{ fontSize: 10, color: theme.colors.accent, fontWeight: "600" }}>
                          打开分支
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>

                  {isExpanded ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, paddingLeft: 20 }}>
                      <ActionChip
                        theme={theme}
                        icon="Play"
                        label={isRunning ? "排入下轮" : "继续执行"}
                        accent
                        disabled={isBusy}
                        onPress={() => void handleRunTodo(todo, isRunning ? "queue_next" : "send_now")}
                      />
                      <ActionChip
                        theme={theme}
                        icon="SquarePen"
                        label="填入"
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
                    gap: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 5,
                    borderRadius: 6,
                    backgroundColor: theme.colors.surface1,
                    opacity: 0.72,
                  }}
                >
                  <Pressable onPress={() => void handleToggleDone(todo)} hitSlop={4}>
                    <Icon name="CheckCircle2" size={13} color={theme.colors.statusSuccess} />
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
          <View style={{ gap: 4, paddingTop: 2 }}>
            <Text style={{ fontSize: 10, fontWeight: "700", color: theme.colors.foregroundMuted }}>
              AI 建议待办
            </Text>
            {card.suggestedTodos.map((sug) => (
              <View
                key={sug.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 5,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: theme.colors.border,
                  backgroundColor: theme.colors.surface0,
                }}
              >
                <Text numberOfLines={1} style={{ flex: 1, fontSize: 11, color: theme.colors.foregroundMuted }}>
                  {sug.title}
                </Text>
                <Pressable onPress={() => void handleResolveSuggested(sug.id, "accept")} hitSlop={4}>
                  <Icon name="Plus" size={13} color={theme.colors.accent} />
                </Pressable>
                <Pressable onPress={() => void handleResolveSuggested(sug.id, "dismiss")} hitSlop={4}>
                  <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {/* Quick add todo input */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
          <TextInput
            value={newTodoText}
            onChangeText={setNewTodoText}
            placeholder="记一条待办，回车添加…"
            placeholderTextColor={theme.colors.foregroundMuted}
            returnKeyType="done"
            onSubmitEditing={() => void handleAddTodo()}
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
            onPress={() => void handleAddTodo()}
            disabled={!newTodoText.trim()}
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: newTodoText.trim() ? theme.colors.accent : theme.colors.surface2,
            }}
          >
            <Icon
              name="Plus"
              size={14}
              color={newTodoText.trim() ? theme.colors.accentForeground : theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ActionChip({
  theme,
  icon,
  label,
  accent,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  accent?: boolean;
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
        paddingHorizontal: 7,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: accent ? theme.colors.accent : theme.colors.surface2,
        borderWidth: 1,
        borderColor: accent ? theme.colors.accent : theme.colors.border,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Icon
        name={icon}
        size={11}
        color={accent ? theme.colors.accentForeground : theme.colors.foregroundMuted}
      />
      <Text
        style={{
          fontSize: 11,
          fontWeight: "500",
          color: accent ? theme.colors.accentForeground : theme.colors.foreground,
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
      targetLabel: target.topic || target.agentTitle || target.agentId.slice(0, 10),
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
  }, [agentId, autoPrompt, expectMode, otherCards, policyMode, selectedTargetId, toast, updateMeta, workspaceId]);

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

  return (
    <View
      style={{
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.foregroundMuted }}>
          等待条件与自动推进
        </Text>
        {card.waitCondition ? (
          <Pressable onPress={() => void handleClearDependency()}>
            <Text style={{ fontSize: 11, color: theme.colors.statusDanger }}>清除条件</Text>
          </Pressable>
        ) : null}
      </View>

      {card.waitCondition?.kind === "agent_settled" ? (
        <Pressable
          onPress={() => onOpenAgent?.(card.waitCondition!.kind === "agent_settled" ? card.waitCondition!.targetAgentId : "")}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        >
          <Icon name="GitMerge" size={12} color={theme.colors.accent} />
          <Text style={{ fontSize: 12, color: theme.colors.accent }}>
            当前等待：{card.waitCondition.targetLabel || card.waitCondition.targetAgentId}
          </Text>
        </Pressable>
      ) : null}

      <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
        选择要等待的关联对话（对方达成条件后自动通知或推进）：
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {otherCards.slice(0, 12).map((item) => {
          const selected = selectedTargetId === item.agentId;
          const label = item.topic || item.agentTitle || item.agentId.slice(0, 10);
          return (
            <Pressable
              key={item.agentId}
              onPress={() => setSelectedTargetId(item.agentId)}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 6,
                backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
                borderWidth: 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                maxWidth: 180,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  fontSize: 11,
                  color: selected ? theme.colors.accentForeground : theme.colors.foreground,
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
            { value: "idle", label: "对方完成本轮即触发" },
            { value: "done", label: "对方标记完成后触发" },
          ] as const
        ).map((item) => (
          <ActionChip
            key={item.value}
            theme={theme}
            icon="History"
            label={item.label}
            accent={expectMode === item.value}
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
            accent={policyMode === item.value}
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
            borderRadius: 6,
            paddingHorizontal: 8,
            paddingVertical: 6,
          }}
        />
      ) : null}

      <Pressable
        onPress={() => void handleBindDependency()}
        style={{
          alignSelf: "flex-start",
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: theme.colors.accent,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.accentForeground }}>
          应用等待规则
        </Text>
      </Pressable>
    </View>
  );
}
