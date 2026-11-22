import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import {
  forkTodoRpc,
  resolveExternalSignalRpc,
  runTodoRpc,
  updateCardMetaRpc,
} from "../shared/rpc.js";
import type { SessionWorkbenchCard, WorkflowStatus } from "../shared/schema.js";
import { useWorkbenchOverview } from "./hooks.js";
import {
  getRuntimeStatusLabel,
  getWorkflowStatusVisual,
  WORKFLOW_STATUS_LIST,
} from "./status-meta.js";

type OverviewTab = "all" | "attention" | "waiting_external" | "waiting_dependency" | "active" | "closed";

export function WorkbenchOverviewScreen({ theme, navigation }: PluginScreenProps) {
  const toast = useToast();
  const [tab, setTab] = useState<OverviewTab>("all");
  const [query, setQuery] = useState("");
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const { snapshot } = useWorkbenchOverview(false);

  const updateMeta = useRpc(updateCardMetaRpc);
  const runTodo = useRpc(runTodoRpc);
  const forkTodo = useRpc(forkTodoRpc);
  const resolveExternalSignal = useRpc(resolveExternalSignalRpc);

  const tabs = useMemo(
    () =>
      [
        { id: "all" as const, label: `全部 (${snapshot.counts.total})` },
        {
          id: "attention" as const,
          label: `待推进 (${snapshot.counts.readyToAdvance + snapshot.counts.waitingMe})`,
        },
        { id: "waiting_external" as const, label: `等外部 (${snapshot.counts.waitingExternal})` },
        {
          id: "waiting_dependency" as const,
          label: `等关联 (${snapshot.counts.waitingDependency})`,
        },
        { id: "active" as const, label: `推进中 (${snapshot.counts.active})` },
        {
          id: "closed" as const,
          label: `暂挂/完成 (${snapshot.counts.snoozed + snapshot.counts.done})`,
        },
      ] as const,
    [snapshot.counts],
  );

  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snapshot.cards.filter((card) => {
      if (card.archived) return false;
      if (tab === "attention" && !card.conditionMetNotice && card.workflowStatus !== "waiting_me") {
        return false;
      }
      if (tab === "waiting_external" && card.workflowStatus !== "waiting_external") return false;
      if (tab === "waiting_dependency" && card.workflowStatus !== "waiting_dependency") return false;
      if (tab === "active" && card.workflowStatus !== "active") return false;
      if (tab === "closed" && card.workflowStatus !== "snoozed" && card.workflowStatus !== "done") {
        return false;
      }
      if (!q) return true;
      const haystack = [
        card.topic,
        card.agentTitle ?? "",
        card.currentWork,
        card.statusNote,
        ...card.todos.map((item) => item.title),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query, snapshot.cards, tab]);

  const handleOpenAgent = useCallback(
    (agentId: string) => {
      navigation?.openAgent({ agentId });
    },
    [navigation],
  );

  const handleStatusChange = useCallback(
    async (card: SessionWorkbenchCard, nextStatus: WorkflowStatus) => {
      try {
        await updateMeta({
          agentId: card.agentId,
          workspaceId: card.workspaceId,
          workflowStatus: nextStatus,
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "切换状态失败");
      }
    },
    [toast, updateMeta],
  );

  const handleQuickResolveSignal = useCallback(
    async (agentId: string) => {
      try {
        await resolveExternalSignal({ agentId });
        toast.show("已标记外部确认达成", { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "更新失败");
      }
    },
    [resolveExternalSignal, toast],
  );

  const handleQuickRunTodo = useCallback(
    async (card: SessionWorkbenchCard, todoId: string) => {
      try {
        const result = await runTodo({
          agentId: card.agentId,
          todoId,
          mode: card.runtimeStatus === "running" ? "queue_next" : "send_now",
        });
        toast.show(result.dispatched === "sent" ? "已继续执行待办" : "已排入下一轮执行", {
          variant: "success",
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "执行失败");
      }
    },
    [runTodo, toast],
  );

  const handleQuickForkTodo = useCallback(
    async (agentId: string, todoId: string) => {
      try {
        const result = await forkTodo({ agentId, todoId, forkMode: "same_workspace" });
        toast.show("已 Fork 新对话运行", { variant: "success" });
        handleOpenAgent(result.newAgentId);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Fork 失败");
      }
    },
    [forkTodo, handleOpenAgent, toast],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 10,
          gap: 10,
          borderBottomWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        {/* Filter tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {tabs.map((item) => {
            const active = tab === item.id;
            return (
              <Pressable
                key={item.id}
                onPress={() => setTab(item.id)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 999,
                  backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : theme.colors.border,
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "600",
                    color: active ? theme.colors.accentForeground : theme.colors.foreground,
                  }}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Search box */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="搜索主题工作、当前进展、等待原因或待办…"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={{ flex: 1, fontSize: 13, color: theme.colors.foreground }}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={6}>
              <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        {filteredCards.length === 0 ? (
          <View
            style={{
              padding: 32,
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              borderRadius: 12,
              backgroundColor: theme.colors.surface1,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Icon name="ListTodo" size={24} color={theme.colors.foregroundMuted} />
            <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>
              当前筛选下没有对话工作卡
            </Text>
          </View>
        ) : (
          filteredCards.map((card) => {
            const visual = getWorkflowStatusVisual(card.workflowStatus);
            const openTodos = card.todos.filter(
              (item) => item.status === "open" || item.status === "queued" || item.status === "running",
            );
            const isExpanded = expandedAgentId === card.agentId;

            return (
              <View
                key={card.agentId}
                style={{
                  borderRadius: 12,
                  backgroundColor: theme.colors.surface1,
                  borderWidth: 1,
                  borderColor: card.conditionMetNotice
                    ? theme.colors.statusWarning
                    : theme.colors.border,
                  padding: 13,
                  gap: 8,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap", flex: 1 }}>
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 5,
                        paddingHorizontal: 8,
                        paddingVertical: 3,
                        borderRadius: 999,
                        backgroundColor: theme.colors.surface2,
                      }}
                    >
                      <View
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          backgroundColor: visual.color(theme),
                        }}
                      />
                      <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foreground }}>
                        {visual.label}
                      </Text>
                    </View>
                    <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                      {getRuntimeStatusLabel(card.runtimeStatus)}
                    </Text>
                    {openTodos.length > 0 ? (
                      <Text style={{ fontSize: 11, color: theme.colors.accent, fontWeight: "600" }}>
                        {openTodos.length} 条待办
                      </Text>
                    ) : null}
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {card.workflowStatus === "waiting_external" ? (
                      <Pressable
                        onPress={() => void handleQuickResolveSignal(card.agentId)}
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor: theme.colors.surface2,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                        }}
                      >
                        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.statusSuccess }}>
                          标记已确认
                        </Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={() => handleOpenAgent(card.agentId)}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        paddingHorizontal: 9,
                        paddingVertical: 5,
                        borderRadius: 6,
                        backgroundColor: theme.colors.accent,
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.accentForeground }}>
                        打开对话
                      </Text>
                      <Icon name="ArrowUpRight" size={12} color={theme.colors.accentForeground} />
                    </Pressable>
                  </View>
                </View>

                <Pressable
                  onPress={() =>
                    setExpandedAgentId((current) => (current === card.agentId ? null : card.agentId))
                  }
                  style={{ gap: 4 }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "700", color: theme.colors.foreground }}>
                    {card.topic || card.agentTitle || "未命名对话"}
                  </Text>
                  {card.currentWork ? (
                    <Text numberOfLines={isExpanded ? 4 : 2} style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
                      当前在做：{card.currentWork}
                    </Text>
                  ) : null}
                  {card.conditionMetNotice ? (
                    <Text style={{ fontSize: 12, color: theme.colors.statusWarning, fontWeight: "600" }}>
                      条件已达成：{card.conditionMetNotice}
                    </Text>
                  ) : card.statusNote ? (
                    <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
                      说明：{card.statusNote}
                    </Text>
                  ) : null}
                </Pressable>

                {isExpanded ? (
                  <View
                    style={{
                      marginTop: 4,
                      paddingTop: 8,
                      borderTopWidth: 1,
                      borderColor: theme.colors.border,
                      gap: 8,
                    }}
                  >
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                      {WORKFLOW_STATUS_LIST.map((item) => (
                        <Pressable
                          key={item.value}
                          onPress={() => void handleStatusChange(card, item.value)}
                          style={{
                            paddingHorizontal: 7,
                            paddingVertical: 3,
                            borderRadius: 6,
                            backgroundColor:
                              card.workflowStatus === item.value
                                ? theme.colors.accent
                                : theme.colors.surface2,
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 11,
                              color:
                                card.workflowStatus === item.value
                                  ? theme.colors.accentForeground
                                  : theme.colors.foreground,
                            }}
                          >
                            {item.shortLabel}
                          </Text>
                        </Pressable>
                      ))}
                    </View>

                    {openTodos.length > 0 ? (
                      <View style={{ gap: 5 }}>
                        <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.foregroundMuted }}>
                          待办事项
                        </Text>
                        {openTodos.map((todo) => (
                          <View
                            key={todo.id}
                            style={{
                              flexDirection: "row",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 8,
                              paddingHorizontal: 8,
                              paddingVertical: 6,
                              borderRadius: 7,
                              backgroundColor: theme.colors.surface0,
                              borderWidth: 1,
                              borderColor: theme.colors.border,
                            }}
                          >
                            <Text numberOfLines={2} style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}>
                              {todo.title}
                            </Text>
                            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                              <Pressable
                                onPress={() => void handleQuickRunTodo(card, todo.id)}
                                style={{
                                  paddingHorizontal: 7,
                                  paddingVertical: 3,
                                  borderRadius: 5,
                                  backgroundColor: theme.colors.accent,
                                }}
                              >
                                <Text style={{ fontSize: 11, color: theme.colors.accentForeground, fontWeight: "600" }}>
                                  继续
                                </Text>
                              </Pressable>
                              <Pressable
                                onPress={() => void handleQuickForkTodo(card.agentId, todo.id)}
                                style={{
                                  paddingHorizontal: 7,
                                  paddingVertical: 3,
                                  borderRadius: 5,
                                  backgroundColor: theme.colors.surface2,
                                }}
                              >
                                <Text style={{ fontSize: 11, color: theme.colors.foreground }}>Fork</Text>
                              </Pressable>
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
