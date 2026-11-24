import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { router } from "expo-router";
import { Eraser, MessageSquarePlus, Minimize2 } from "lucide-react-native";
import { memo, useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { buildMainChatRoute } from "@/utils/host-routes";
import { useMainChatOverviewStore } from "./overview-store";

const ThemedMinimizeIcon = withUnistyles(Minimize2);
const ThemedEraserIcon = withUnistyles(Eraser);
const ThemedNewSessionIcon = withUnistyles(MessageSquarePlus);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const compactMenuIcon = <ThemedMinimizeIcon size={14} uniProps={mutedIconMapping} />;
const clearMenuIcon = <ThemedEraserIcon size={14} uniProps={mutedIconMapping} />;
const newSessionMenuIcon = <ThemedNewSessionIcon size={14} uniProps={mutedIconMapping} />;

export type MainChatLifecycleConfirmKind = "clear" | "new_session";

export interface UseMainChatLifecycleActionsInput {
  serverId: string | null;
  client: DaemonClient | null;
  mainAgentId: string | null | undefined;
  /** Navigate to `/main` after clear/new-session switches the main agent (used by sidebar hero). */
  navigateToMainOnSwitch?: boolean;
  onBeforeNavigate?: () => void;
}

export interface MainChatLifecycleActionsState {
  busyAction: "compact" | "clear" | "new_session" | null;
  confirmKind: MainChatLifecycleConfirmKind | null;
  canRunLifecycle: boolean;
  triggerCompact: () => void;
  requestClear: () => void;
  requestNewSession: () => void;
  cancelConfirm: () => void;
  confirmPendingAction: () => void;
}

/**
 * Shared M2 lifecycle controller used by both `MainChatShell`'s header menu and
 * `MainChatHeroRow`'s sidebar menu so compact, `/clear`, and new-session handoff share one
 * implementation, confirmation copy, active-agent switch, overview refresh, and toast feedback.
 */
export function useMainChatLifecycleActions(
  input: UseMainChatLifecycleActionsInput,
): MainChatLifecycleActionsState {
  const { serverId, client, mainAgentId, navigateToMainOnSwitch = false, onBeforeNavigate } = input;
  const { t } = useTranslation();
  const toast = useToast();

  const compactMainChat = useMainChatOverviewStore((state) => state.compactMainChat);
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const setActiveAgentOverride = useMainChatOverviewStore((state) => state.setActiveAgentOverride);

  const [busyAction, setBusyAction] = useState<"compact" | "clear" | "new_session" | null>(null);
  const [confirmKind, setConfirmKind] = useState<MainChatLifecycleConfirmKind | null>(null);

  const canRunLifecycle = Boolean(serverId && client && mainAgentId && busyAction === null);

  const resolveMainAgentId = useCallback(async (): Promise<string | undefined> => {
    return mainAgentId ?? undefined;
  }, [mainAgentId]);

  const triggerCompact = useCallback(() => {
    if (!serverId || !client || busyAction !== null) return;
    setBusyAction("compact");
    void (async () => {
      try {
        const resolvedId = await resolveMainAgentId();
        if (!resolvedId) {
          throw new Error(t("mainChat.openFailed"));
        }
        const compaction = await compactMainChat(serverId, resolvedId, client, {
          reason: "manual",
        });
        toast.show(compaction?.summary?.trim() || t("mainChat.compaction.successToast"), {
          variant: "success",
        });
        await loadOverview(serverId, resolvedId, client);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.compaction.failedToast"));
      } finally {
        setBusyAction(null);
      }
    })();
  }, [busyAction, client, compactMainChat, loadOverview, resolveMainAgentId, serverId, t, toast]);

  const requestClear = useCallback(() => {
    if (!serverId || !client || busyAction !== null) return;
    setConfirmKind("clear");
  }, [busyAction, client, serverId]);

  const requestNewSession = useCallback(() => {
    if (!serverId || !client || busyAction !== null) return;
    setConfirmKind("new_session");
  }, [busyAction, client, serverId]);

  const cancelConfirm = useCallback(() => {
    if (busyAction !== null) return;
    setConfirmKind(null);
  }, [busyAction]);

  const switchToSession = useCallback(
    async (
      targetServerId: string,
      activeClient: DaemonClient,
      nextAgentId: string,
      nextWorkspaceId: string | null | undefined,
      previousAgentId: string | null,
      successMessage: string,
    ) => {
      setActiveAgentOverride(targetServerId, {
        serverId: targetServerId,
        agentId: nextAgentId,
        workspaceId: nextWorkspaceId ?? "",
        previousAgentId,
      });
      setConfirmKind(null);
      await loadOverview(targetServerId, nextAgentId, activeClient).catch(() => null);
      toast.show(successMessage, { variant: "success" });
      if (navigateToMainOnSwitch) {
        onBeforeNavigate?.();
        router.push(buildMainChatRoute());
      }
    },
    [loadOverview, navigateToMainOnSwitch, onBeforeNavigate, setActiveAgentOverride, toast],
  );

  const confirmPendingAction = useCallback(() => {
    if (!serverId || !client || !confirmKind || busyAction !== null) return;
    const kind = confirmKind;
    setBusyAction(kind);
    void (async () => {
      try {
        const resolvedId = await resolveMainAgentId();
        if (kind === "clear") {
          const response = await client.clearMainChat(
            resolvedId ? { mainAgentId: resolvedId } : undefined,
          );
          if (response.error || !response.agentId) {
            throw new Error(response.error ?? t("mainChat.lifecycle.clearFailedToast"));
          }
          const migratedCount =
            response.migratedChildAgents + response.migratedPlans + response.migratedDecisions;
          const successMessage =
            migratedCount > 0
              ? t("mainChat.lifecycle.clearSuccessMigratedToast", {
                  tasks: response.migratedChildAgents,
                  plans: response.migratedPlans,
                })
              : t("mainChat.lifecycle.clearSuccessToast");
          await switchToSession(
            serverId,
            client,
            response.agentId,
            response.workspaceId,
            response.previousAgentId ?? resolvedId ?? null,
            successMessage,
          );
          return;
        }

        const response = await client.startNewMainChatSession({
          ...(resolvedId ? { mainAgentId: resolvedId } : {}),
          carryHandoffSummary: true,
        });
        if (response.error || !response.agentId) {
          throw new Error(response.error ?? t("mainChat.lifecycle.newSessionFailedToast"));
        }
        await switchToSession(
          serverId,
          client,
          response.agentId,
          response.workspaceId,
          response.previousAgentId ?? resolvedId ?? null,
          t("mainChat.lifecycle.newSessionSuccessToast"),
        );
      } catch (error) {
        const fallback =
          kind === "clear"
            ? t("mainChat.lifecycle.clearFailedToast")
            : t("mainChat.lifecycle.newSessionFailedToast");
        toast.error(error instanceof Error ? error.message : fallback);
      } finally {
        setBusyAction(null);
      }
    })();
  }, [busyAction, client, confirmKind, resolveMainAgentId, serverId, switchToSession, t, toast]);

  return {
    busyAction,
    confirmKind,
    canRunLifecycle,
    triggerCompact,
    requestClear,
    requestNewSession,
    cancelConfirm,
    confirmPendingAction,
  };
}

export const MainChatLifecycleMenuItems = memo(function MainChatLifecycleMenuItems({
  testIdPrefix,
  disabled,
  onCompact,
  onClear,
  onNewSession,
}: {
  testIdPrefix: string;
  disabled: boolean;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        leading={compactMenuIcon}
        onSelect={onCompact}
        disabled={disabled}
        testID={`${testIdPrefix}-compact`}
      >
        {t("mainChat.lifecycle.compactAction")}
      </DropdownMenuItem>
      <DropdownMenuItem
        leading={clearMenuIcon}
        onSelect={onClear}
        disabled={disabled}
        testID={`${testIdPrefix}-clear`}
      >
        {t("mainChat.lifecycle.clearAction")}
      </DropdownMenuItem>
      <DropdownMenuItem
        leading={newSessionMenuIcon}
        onSelect={onNewSession}
        disabled={disabled}
        testID={`${testIdPrefix}-new-session`}
      >
        {t("mainChat.lifecycle.newSessionAction")}
      </DropdownMenuItem>
    </>
  );
});

export const MainChatLifecycleConfirmModal = memo(function MainChatLifecycleConfirmModal({
  confirmKind,
  busy,
  onCancel,
  onConfirm,
}: {
  confirmKind: MainChatLifecycleConfirmKind | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement | null {
  const { t } = useTranslation();

  if (!confirmKind) {
    return null;
  }

  const isClear = confirmKind === "clear";
  const title = isClear
    ? t("mainChat.lifecycle.clearConfirmTitle")
    : t("mainChat.lifecycle.newSessionConfirmTitle");
  const description = isClear
    ? t("mainChat.lifecycle.clearConfirmDescription")
    : t("mainChat.lifecycle.newSessionConfirmDescription");
  const confirmLabel = isClear
    ? t("mainChat.lifecycle.clearConfirmButton")
    : t("mainChat.lifecycle.newSessionConfirmButton");

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.modalBackdrop} testID={`main-chat-lifecycle-modal-${confirmKind}`}>
        <PressHighlight
          style={styles.modalDismiss}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.cancel")}
        />
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text style={styles.modalDescription}>{description}</Text>
          <View style={styles.modalActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={onCancel}
              testID="main-chat-lifecycle-cancel"
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              loading={busy}
              disabled={busy}
              onPress={onConfirm}
              testID="main-chat-lifecycle-confirm"
            >
              {confirmLabel}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create((theme) => ({
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalDismiss: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  modalCard: {
    width: "100%",
    maxWidth: 400,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  modalDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
