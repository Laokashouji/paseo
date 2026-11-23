import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { Archive } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { toolbarSlot } from "@/components/ui/control-geometry";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerTrackMark } from "@/composer/tracks";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useInstalledPlugin } from "@/plugins/registry";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, ICON_STROKE_WIDTH, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { SESSION_ARCHIVE_PLUGIN_ID, type SessionArchiveState } from "./constants";

const ThemedArchive = withUnistyles(Archive);
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

function isValidArchiveState(value: unknown): value is SessionArchiveState {
  return (
    value === "idle" || value === "queued" || value === "running" || value === "pending_archive"
  );
}

function getTooltipKey(
  archiveState: SessionArchiveState,
  isInProgress: boolean,
  isQueued: boolean,
) {
  if (archiveState === "pending_archive") return "sessionArchive.tooltipPendingArchive" as const;
  if (isInProgress) return "sessionArchive.tooltipRunning" as const;
  if (isQueued) return "sessionArchive.tooltipQueued" as const;
  return "sessionArchive.tooltipIdle" as const;
}

/** Light-red icon-only composer toolbar button that dispatches the archive command directly. */
export const ArchiveConversationButton = memo(function ArchiveConversationButton({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId?: string | null;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings } = useAppSettings();
  const archivePlugin = useInstalledPlugin(serverId, SESSION_ARCHIVE_PLUGIN_ID);

  const isAgentArchived = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return Boolean(agent?.archivedAt);
  });
  const agentWorkspaceId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.workspaceId ?? null;
  });

  const [archiveState, setArchiveState] = useState<SessionArchiveState>("idle");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    setArchiveState("idle");
    if (!archivePlugin || !agentId) return;

    let active = true;
    const handle = archivePlugin.subscribe(
      "session.archive.state.watch",
      { agentId },
      {
        event(payload) {
          if (!active || !payload || typeof payload !== "object") return;
          const candidate = (payload as { state?: unknown }).state;
          if (isValidArchiveState(candidate)) {
            setArchiveState(candidate);
          }
        },
        closed() {},
      },
    );
    void handle.ready.catch(() => {});

    return () => {
      active = false;
      handle();
    };
  }, [agentId, archivePlugin]);

  const isInProgress =
    submitting || archiveState === "running" || archiveState === "pending_archive";
  const isQueued = archiveState === "queued";
  const resolvedWorkspaceId = workspaceId ?? agentWorkspaceId ?? null;

  const handleCancelQueued = useCallback(async () => {
    if (!archivePlugin || submittingRef.current) return;
    const confirmedCancel = await confirmDialog({
      title: t("sessionArchive.cancelQueueTitle"),
      message: t("sessionArchive.cancelQueueMessage"),
      confirmLabel: t("sessionArchive.cancelQueueConfirm"),
      cancelLabel: t("common.actions.cancel"),
    });
    if (!confirmedCancel || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await archivePlugin.invoke("session.archive.trigger", {
        agentId,
        workspaceId: resolvedWorkspaceId,
        cancelQueue: true,
      });
      setArchiveState("idle");
      toast.show(t("sessionArchive.toasts.canceled"), { variant: "info" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessionArchive.toasts.failed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [agentId, archivePlugin, resolvedWorkspaceId, t, toast]);

  const dispatchArchiveCommand = useCallback(
    async (command: string) => {
      if (archivePlugin) {
        const result = (await archivePlugin.invoke("session.archive.trigger", {
          agentId,
          workspaceId: resolvedWorkspaceId,
          command,
          autoArchiveAfterCleanup: settings.autoArchiveAfterCleanup,
        })) as { state?: SessionArchiveState; status?: "sent" | "queued" | "canceled" };
        if (isValidArchiveState(result?.state)) {
          setArchiveState(result.state);
        }
        toast.show(
          result?.status === "queued"
            ? t("sessionArchive.toasts.queued")
            : t("sessionArchive.toasts.sent"),
          { variant: "success" },
        );
        return;
      }

      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) {
        toast.error(t("common.errors.daemonClientUnavailable"));
        return;
      }
      await client.sendMessage(agentId, command);
      toast.show(t("sessionArchive.toasts.sent"), { variant: "success" });
    },
    [
      agentId,
      archivePlugin,
      resolvedWorkspaceId,
      serverId,
      settings.autoArchiveAfterCleanup,
      t,
      toast,
    ],
  );

  const handlePress = useCallback(async () => {
    if (submittingRef.current || isInProgress) return;
    if (isQueued && archivePlugin) {
      await handleCancelQueued();
      return;
    }

    const command = settings.archiveCommand.trim();
    if (!command) {
      toast.error(t("sessionArchive.toasts.emptyCommand"));
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      await dispatchArchiveCommand(command);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("sessionArchive.toasts.failed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    archivePlugin,
    dispatchArchiveCommand,
    handleCancelQueued,
    isInProgress,
    isQueued,
    settings.archiveCommand,
    t,
    toast,
  ]);

  const tooltipLabel = t(getTooltipKey(archiveState, isInProgress, isQueued));

  const buttonStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      hovered || isQueued ? styles.buttonHover : null,
      pressed ? styles.buttonPressed : null,
      isInProgress ? styles.buttonDisabled : null,
    ],
    [isInProgress, isQueued],
  );

  const renderContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      let badge: ReactElement | null = null;
      if (isInProgress) {
        badge = (
          <View style={styles.statusCorner}>
            <ComposerTrackMark bucket="running" />
          </View>
        );
      } else if (isQueued) {
        badge = <View style={styles.queuedDot} />;
      }
      return (
        <View style={styles.iconContainer}>
          <ThemedArchive
            size={ICON_SIZE.md}
            strokeWidth={ICON_STROKE_WIDTH}
            uniProps={hovered || isQueued ? destructiveColorMapping : dangerColorMapping}
          />
          {badge}
        </View>
      );
    },
    [isInProgress, isQueued],
  );

  const handleTriggerPress = useCallback(() => {
    void handlePress();
  }, [handlePress]);

  if (isAgentArchived) {
    return null;
  }

  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger
        onPress={handleTriggerPress}
        disabled={isInProgress}
        style={buttonStyle}
        accessibilityRole="button"
        accessibilityLabel={tooltipLabel}
        testID="archive-conversation-button"
      >
        {renderContent}
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

const styles = StyleSheet.create((theme) => ({
  button: {
    ...toolbarSlot(),
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDangerTint,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  buttonHover: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  iconContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  statusCorner: {
    position: "absolute",
    top: -3,
    right: -4,
  },
  queuedDot: {
    position: "absolute",
    top: -2,
    right: -3,
    width: 5,
    height: 5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
