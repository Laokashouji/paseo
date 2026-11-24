import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import { ArrowUp, Check, CornerDownLeft, ListTodo, Pencil, Trash2, X } from "lucide-react-native";
import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { EditingTextInput } from "@/components/ui/text-input";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { resolveComposerAttachmentSubmitFormat } from "@/composer/attachments/submit";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { encodeImages } from "@/utils/encode-images";
import {
  EMPTY_MAIN_CHAT_QUEUE,
  useMainChatQueueStore,
  type MainChatQueuedMessage,
} from "./queue-store";

const ThemedListIcon = withUnistyles(ListTodo);
const ThemedPencilIcon = withUnistyles(Pencil);
const ThemedPinIcon = withUnistyles(ArrowUp);
const ThemedSendIcon = withUnistyles(CornerDownLeft);
const ThemedXIcon = withUnistyles(X);
const ThemedCheckIcon = withUnistyles(Check);
const ThemedTrashIcon = withUnistyles(Trash2);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const placeholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

const ThemedTextInput = withUnistyles(EditingTextInput, placeholderColorMapping);

export function isAgentBusyForQueue(input: {
  status: Agent["status"] | null;
  turnPhase: Agent["turn"]["phase"] | null;
  backgroundWork: Agent["backgroundWork"];
}): boolean {
  if (!input.status) return false;
  return (
    input.turnPhase === "open" ||
    isAgentRunning({ status: input.status, backgroundWork: input.backgroundWork })
  );
}

export function isAgentIdleForQueue(input: {
  status: Agent["status"] | null;
  turnPhase: Agent["turn"]["phase"] | null;
  backgroundWork: Agent["backgroundWork"];
}): boolean {
  if (!input.status) return false;
  return input.status === "idle" && input.turnPhase === "idle" && !isAgentBusyForQueue(input);
}

export async function dispatchMainChatPromptText(input: {
  serverId: string;
  agentId: string;
  text: string;
  client: DaemonClient;
  sendBehavior: "interrupt" | "steer";
  supportsForgeAttachments: boolean;
}): Promise<void> {
  const activeTurnBehavior = input.sendBehavior === "steer" ? "steer" : "interrupt";
  const activeTurnId =
    activeTurnBehavior === "steer"
      ? (selectAgentTurnPresentation(
          useSessionStore.getState().sessions[input.serverId],
          input.agentId,
        ).turnId ?? undefined)
      : undefined;

  await dispatchComposerAgentMessage({
    client: input.client,
    agentId: input.agentId,
    text: input.text,
    attachments: [],
    attachmentSubmitFormat: resolveComposerAttachmentSubmitFormat({
      supportsForgeAttachments: input.supportsForgeAttachments,
    }),
    encodeImages,
    submission: createMessageSubmissionWriter(input.serverId),
    activeTurnBehavior,
    activeTurnId,
  });
}

interface QueueItemRowProps {
  item: MainChatQueuedMessage;
  index: number;
  isEditing: boolean;
  editingDraft: string;
  isSending: boolean;
  canSend: boolean;
  onStartEdit: (item: MainChatQueuedMessage) => void;
  onChangeDraft: (value: string) => void;
  onSaveEdit: (itemId: string) => void;
  onCancelEdit: () => void;
  onMoveToFront: (itemId: string) => void;
  onSendNow: (item: MainChatQueuedMessage) => void;
  onRemove: (itemId: string) => void;
}

const QueueItemRow = memo(function QueueItemRow({
  item,
  index,
  isEditing,
  editingDraft,
  isSending,
  canSend,
  onStartEdit,
  onChangeDraft,
  onSaveEdit,
  onCancelEdit,
  onMoveToFront,
  onSendNow,
  onRemove,
}: QueueItemRowProps): ReactElement {
  const { t } = useTranslation();
  const isPinnedHead = index === 0 && item.priority === "high";

  const handleStartEdit = useCallback(() => onStartEdit(item), [item, onStartEdit]);
  const handleSaveEdit = useCallback(() => onSaveEdit(item.id), [item.id, onSaveEdit]);
  const handleMoveToFront = useCallback(() => onMoveToFront(item.id), [item.id, onMoveToFront]);
  const handleSendNow = useCallback(() => onSendNow(item), [item, onSendNow]);
  const handleRemove = useCallback(() => onRemove(item.id), [item.id, onRemove]);

  if (isEditing) {
    return (
      <View style={styles.editRow} testID={`main-chat-queue-edit-row-${item.id}`}>
        <ThemedTextInput
          initialValue={editingDraft}
          onChangeText={onChangeDraft}
          placeholder={t("mainChat.composer.queue.editPlaceholder")}
          style={styles.editInput}
          returnKeyType="done"
          onSubmitEditing={handleSaveEdit}
          testID={`main-chat-queue-edit-input-${item.id}`}
        />
        <PressHighlight
          onPress={handleSaveEdit}
          disabled={editingDraft.trim().length === 0}
          style={styles.iconAction}
          highlightStyle={styles.iconActionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.composer.queue.saveAction")}
          testID={`main-chat-queue-save-${item.id}`}
        >
          <ThemedCheckIcon size={13} uniProps={primaryIconMapping} />
        </PressHighlight>
        <PressHighlight
          onPress={onCancelEdit}
          style={styles.iconAction}
          highlightStyle={styles.iconActionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.cancel")}
          testID={`main-chat-queue-cancel-edit-${item.id}`}
        >
          <ThemedXIcon size={13} uniProps={mutedIconMapping} />
        </PressHighlight>
      </View>
    );
  }

  return (
    <View style={styles.row} testID={`main-chat-queue-item-${item.id}`}>
      <Text style={styles.indexLabel}>#{index + 1}</Text>
      {item.priority === "high" ? (
        <StatusBadge
          size="xs"
          variant="warning"
          label={t("mainChat.composer.queue.highPriorityBadge")}
        />
      ) : null}
      <Text style={styles.previewText} numberOfLines={2} testID={`main-chat-queue-text-${item.id}`}>
        {item.text}
      </Text>
      <View style={styles.rowActions}>
        <PressHighlight
          onPress={handleStartEdit}
          disabled={isSending}
          style={styles.iconAction}
          highlightStyle={styles.iconActionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.composer.queue.editAction")}
          testID={`main-chat-queue-edit-${item.id}`}
        >
          <ThemedPencilIcon size={12} uniProps={mutedIconMapping} />
        </PressHighlight>
        {!isPinnedHead ? (
          <PressHighlight
            onPress={handleMoveToFront}
            disabled={isSending}
            style={styles.iconAction}
            highlightStyle={styles.iconActionPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.composer.queue.pinAction")}
            testID={`main-chat-queue-pin-${item.id}`}
          >
            <ThemedPinIcon size={12} uniProps={mutedIconMapping} />
          </PressHighlight>
        ) : null}
        <PressHighlight
          onPress={handleSendNow}
          disabled={isSending || !canSend}
          style={styles.iconAction}
          highlightStyle={styles.iconActionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.composer.queue.sendNowAction")}
          testID={`main-chat-queue-send-${item.id}`}
        >
          {isSending ? (
            <ThemedSpinner size="small" uniProps={primaryIconMapping} />
          ) : (
            <ThemedSendIcon size={12} uniProps={primaryIconMapping} />
          )}
        </PressHighlight>
        <PressHighlight
          onPress={handleRemove}
          disabled={isSending}
          style={styles.iconAction}
          highlightStyle={styles.iconActionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.composer.queue.removeAction")}
          testID={`main-chat-queue-remove-${item.id}`}
        >
          <ThemedXIcon size={12} uniProps={dangerIconMapping} />
        </PressHighlight>
      </View>
    </View>
  );
});

export interface MainChatQueuePanelProps {
  serverId: string;
  agentId: string;
  /** Optional custom dispatcher (used by tests or wrappers overriding default daemon dispatch). */
  onSendMessage?: (text: string) => Promise<void>;
}

/**
 * Compact visual send-queue panel rendered above the Main Chat composer when queued messages exist.
 * Supports inline editing, pinning to front (high priority), immediate send, removal, and
 * automatic serialized FIFO consumption whenever the target conversation transitions from busy to idle.
 */
export const MainChatQueuePanel = memo(function MainChatQueuePanel({
  serverId,
  agentId,
  onSendMessage,
}: MainChatQueuePanelProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const sendBehavior = useSettings((settings) => settings.sendBehavior);
  const runtimeClient = useHostRuntimeClient(serverId);
  const sessionClient = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const client = runtimeClient ?? sessionClient;

  const rawQueue = useMainChatQueueStore((state) => state.queuesByAgentId[agentId]);
  const items = rawQueue ?? EMPTY_MAIN_CHAT_QUEUE;
  const editItem = useMainChatQueueStore((state) => state.editItem);
  const moveToFront = useMainChatQueueStore((state) => state.moveToFront);
  const removeItem = useMainChatQueueStore((state) => state.removeItem);
  const clearQueue = useMainChatQueueStore((state) => state.clearQueue);

  const agentStatus = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId)?.status ??
      state.sessions[serverId]?.agentDetails.get(agentId)?.status ??
      null,
  );
  const agentTurnPhase = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId)?.turn.phase ??
      state.sessions[serverId]?.agentDetails.get(agentId)?.turn.phase ??
      null,
  );
  const agentBackgroundWork = useSessionStore(
    (state) =>
      state.sessions[serverId]?.agents.get(agentId)?.backgroundWork ??
      state.sessions[serverId]?.agentDetails.get(agentId)?.backgroundWork,
  );
  const supportsForgeSearch = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.forgeSearch === true,
  );

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [sendingItemId, setSendingItemId] = useState<string | null>(null);

  const isBusy = isAgentBusyForQueue({
    status: agentStatus,
    turnPhase: agentTurnPhase,
    backgroundWork: agentBackgroundWork,
  });
  const isIdle = isAgentIdleForQueue({
    status: agentStatus,
    turnPhase: agentTurnPhase,
    backgroundWork: agentBackgroundWork,
  });

  const wasBusyRef = useRef(isBusy);
  const dispatchInFlightRef = useRef(false);

  const dispatchText = useCallback(
    async (text: string) => {
      if (onSendMessage) {
        await onSendMessage(text);
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      await dispatchMainChatPromptText({
        serverId,
        agentId,
        text,
        client,
        sendBehavior: sendBehavior === "steer" ? "steer" : "interrupt",
        supportsForgeAttachments: supportsForgeSearch,
      });
    },
    [agentId, client, onSendMessage, sendBehavior, serverId, supportsForgeSearch, t],
  );

  // Consume the front of the queue automatically when the agent transitions from busy -> idle.
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = isBusy;
    if (!wasBusy || !isIdle || items.length === 0) return;
    if (dispatchInFlightRef.current) return;
    if (!onSendMessage && !client) return;

    const nextItem = useMainChatQueueStore.getState().shiftNext(agentId);
    if (!nextItem) return;

    dispatchInFlightRef.current = true;
    setSendingItemId(nextItem.id);
    void dispatchText(nextItem.text)
      .then(() => {
        toast.show(t("mainChat.composer.queue.sentToast"), { variant: "success" });
        return undefined;
      })
      .catch((error) => {
        useMainChatQueueStore.getState().enqueue(agentId, nextItem.text, {
          id: nextItem.id,
          priority: nextItem.priority,
          prepend: true,
        });
        toast.error(
          error instanceof Error ? error.message : t("mainChat.composer.queue.sendFailedToast"),
        );
      })
      .finally(() => {
        dispatchInFlightRef.current = false;
        setSendingItemId(null);
      });
  }, [agentId, client, dispatchText, isBusy, isIdle, items.length, onSendMessage, t, toast]);

  const handleStartEdit = useCallback((item: MainChatQueuedMessage) => {
    setEditingItemId(item.id);
    setEditingDraft(item.text);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingItemId(null);
    setEditingDraft("");
  }, []);

  const handleSaveEdit = useCallback(
    (itemId: string) => {
      if (editItem(agentId, itemId, editingDraft)) {
        setEditingItemId(null);
        setEditingDraft("");
      }
    },
    [agentId, editItem, editingDraft],
  );

  const handleMoveToFront = useCallback(
    (itemId: string) => {
      moveToFront(agentId, itemId);
    },
    [agentId, moveToFront],
  );

  const handleRemove = useCallback(
    (itemId: string) => {
      if (editingItemId === itemId) {
        setEditingItemId(null);
        setEditingDraft("");
      }
      removeItem(agentId, itemId);
    },
    [agentId, editingItemId, removeItem],
  );

  const handleClearAll = useCallback(() => {
    setEditingItemId(null);
    setEditingDraft("");
    clearQueue(agentId);
  }, [agentId, clearQueue]);

  const handleSendNow = useCallback(
    (item: MainChatQueuedMessage) => {
      if (dispatchInFlightRef.current || sendingItemId !== null) return;
      if (!onSendMessage && !client) return;

      const removed = removeItem(agentId, item.id);
      if (!removed) return;

      dispatchInFlightRef.current = true;
      setSendingItemId(item.id);
      if (editingItemId === item.id) {
        setEditingItemId(null);
        setEditingDraft("");
      }

      void dispatchText(item.text)
        .then(() => {
          toast.show(t("mainChat.composer.queue.sentToast"), { variant: "success" });
          return undefined;
        })
        .catch((error) => {
          useMainChatQueueStore.getState().enqueue(agentId, item.text, {
            id: item.id,
            priority: item.priority,
            prepend: true,
          });
          toast.error(
            error instanceof Error ? error.message : t("mainChat.composer.queue.sendFailedToast"),
          );
        })
        .finally(() => {
          dispatchInFlightRef.current = false;
          setSendingItemId(null);
        });
    },
    [
      agentId,
      client,
      dispatchText,
      editingItemId,
      onSendMessage,
      removeItem,
      sendingItemId,
      t,
      toast,
    ],
  );

  if (items.length === 0) {
    return null;
  }

  const canSend = Boolean(onSendMessage || client);

  return (
    <View style={styles.rail}>
      <View style={styles.card} testID="main-chat-queue-panel">
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <ThemedListIcon size={13} uniProps={primaryIconMapping} />
            <Text style={styles.title} testID="main-chat-queue-count">
              {t("mainChat.composer.queue.title", { count: items.length })}
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {isBusy
                ? t("mainChat.composer.queue.waitingIdleHint")
                : t("mainChat.composer.queue.readyHint")}
            </Text>
          </View>
          {items.length > 1 ? (
            <PressHighlight
              onPress={handleClearAll}
              disabled={sendingItemId !== null}
              style={styles.clearButton}
              highlightStyle={styles.iconActionPressed}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.composer.queue.clearAllAction")}
              testID="main-chat-queue-clear-all"
            >
              <ThemedTrashIcon size={12} uniProps={mutedIconMapping} />
              <Text style={styles.clearLabel}>{t("mainChat.composer.queue.clearAllAction")}</Text>
            </PressHighlight>
          ) : null}
        </View>

        <View style={styles.list}>
          {items.map((item, index) => (
            <QueueItemRow
              key={item.id}
              item={item}
              index={index}
              isEditing={editingItemId === item.id}
              editingDraft={editingDraft}
              isSending={sendingItemId === item.id}
              canSend={canSend}
              onStartEdit={handleStartEdit}
              onChangeDraft={setEditingDraft}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onMoveToFront={handleMoveToFront}
              onSendNow={handleSendNow}
              onRemove={handleRemove}
            />
          ))}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: "100%",
    paddingBottom: theme.spacing[1.5],
  },
  card: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  headerLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  hint: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  clearButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  clearLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  indexLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  previewText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[0.5],
    flexShrink: 0,
  },
  iconAction: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  iconActionPressed: {
    backgroundColor: theme.colors.surface3,
  },
  editRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  editInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
  },
}));
