import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import { CircleAlert, RefreshCw, Settings, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useHostRuntimeConnectionStatus, useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildMainChatRoute, buildSettingsRoute } from "@/utils/host-routes";
import { MainChatAgentHost } from "./agent-host";
import { useMainChatConversationsStore } from "./conversations-store";
import { HostSyncBanner } from "./host-sync-banner";
import { MainChatShell } from "./main-chat-shell";
import { useMainChatOverviewStore } from "./overview-store";
import { selectMainChatSidebarSummary, type MainChatAgentRef } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedSettings = withUnistyles(Settings);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

type EnsureState =
  | { kind: "idle" }
  | { kind: "ensuring"; serverId: string }
  | { kind: "resolved"; ref: MainChatAgentRef }
  | { kind: "error"; serverId: string; message: string };

/**
 * Primary top-level `/main` screen.
 * Unmounts its conversation host while blurred so returning to `/main` re-establishes a clean
 * bottom-anchored scroll position while preserving drafts in `useDraftStore`.
 */
export function MainChatScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.inactiveContainer} />;
  }

  return <MainChatScreenContent />;
}

function resolveEffectiveOverrideRef(
  activeAgentOverride: {
    serverId: string;
    agentId: string;
    workspaceId: string;
    previousAgentId: string | null;
  } | null,
  existing: MainChatAgentRef | null,
): MainChatAgentRef | null {
  if (!activeAgentOverride) return null;
  if (existing && existing.agentId !== activeAgentOverride.previousAgentId) {
    return null;
  }
  return {
    serverId: activeAgentOverride.serverId,
    agentId: activeAgentOverride.agentId,
    workspaceId: activeAgentOverride.workspaceId || existing?.workspaceId || "",
  };
}

function MainChatScreenBody({
  resolvedRef,
  ensureState,
  isEnsuring,
  activePane,
  onFocusMainPane,
  onRetry,
  onOpenSettings,
}: {
  resolvedRef: MainChatAgentRef | null;
  ensureState: EnsureState;
  isEnsuring: boolean;
  activePane: "main" | "drawer";
  onFocusMainPane: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (resolvedRef) {
    return (
      <MainChatAgentHost
        key={`${resolvedRef.serverId}:${resolvedRef.agentId}`}
        sourceId={`main-chat:${resolvedRef.serverId}:${resolvedRef.agentId}`}
        serverId={resolvedRef.serverId}
        workspaceId={resolvedRef.workspaceId}
        agentId={resolvedRef.agentId}
        isFocused={activePane === "main"}
        onFocusPane={onFocusMainPane}
      />
    );
  }
  if (ensureState.kind === "error") {
    return (
      <View style={styles.centerState} testID="main-chat-ensure-error">
        <ThemedCircleAlert size={28} uniProps={dangerIconMapping} />
        <Text style={styles.stateTitle}>{t("mainChat.shell.ensureErrorTitle")}</Text>
        <Text style={styles.stateDescription}>{ensureState.message}</Text>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={ThemedRefreshCw}
          onPress={onRetry}
          testID="main-chat-ensure-retry"
        >
          {t("mainChat.shell.retryEnsure")}
        </Button>
      </View>
    );
  }
  if (isEnsuring) {
    return (
      <View style={styles.centerState} testID="main-chat-ensuring">
        <ThemedLoadingSpinner size="large" uniProps={mutedIconMapping} />
        <Text style={styles.stateTitle}>{t("mainChat.shell.loadingTitle")}</Text>
        <Text style={styles.stateDescription}>{t("mainChat.shell.loadingSubtitle")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.centerState} testID="main-chat-no-host">
      <ThemedSparkles size={28} uniProps={mutedIconMapping} />
      <Text style={styles.stateTitle}>{t("mainChat.shell.noHostTitle")}</Text>
      <Text style={styles.stateDescription}>{t("mainChat.shell.noHostDescription")}</Text>
      <Button
        variant="outline"
        size="sm"
        leftIcon={ThemedSettings}
        onPress={onOpenSettings}
        testID="main-chat-open-host-settings"
      >
        {t("mainChat.shell.openHostSettings")}
      </Button>
    </View>
  );
}

function MainChatScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = lastWorkspace?.serverId ?? hosts[0]?.serverId ?? null;

  const summary = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId),
      [preferredServerId],
    ),
    equal,
  );

  const targetServerId = summary.targetServerId;
  useDirectoryDemand(targetServerId);

  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );
  const connectionStatus = useHostRuntimeConnectionStatus(targetServerId ?? "");
  const configuredTitle = useMainChatSettingsStore((state) =>
    targetServerId ? state.settingsByServerId[targetServerId]?.title : undefined,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const activeAgentOverride = useMainChatOverviewStore((state) =>
    targetServerId ? (state.activeAgentOverrideByServerId[targetServerId] ?? null) : null,
  );
  const clearActiveAgentOverride = useMainChatOverviewStore(
    (state) => state.clearActiveAgentOverride,
  );
  const hydrateFromOverview = useMainChatConversationsStore((state) => state.hydrateFromOverview);
  const refreshConversations = useMainChatConversationsStore((state) => state.refreshConversations);
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);

  const [ensureState, setEnsureState] = useState<EnsureState>({ kind: "idle" });
  const [retryCount, setRetryCount] = useState(0);
  const [activePane, setActivePane] = useState<"main" | "drawer">("main");

  const effectiveOverrideRef = resolveEffectiveOverrideRef(activeAgentOverride, summary.existing);

  useEffect(() => {
    if (
      activeAgentOverride &&
      summary.existing &&
      summary.existing.agentId === activeAgentOverride.agentId
    ) {
      clearActiveAgentOverride(activeAgentOverride.serverId);
    }
  }, [activeAgentOverride, clearActiveAgentOverride, summary.existing]);

  const resolvedRef: MainChatAgentRef | null =
    effectiveOverrideRef ??
    summary.existing ??
    (ensureState.kind === "resolved" ? ensureState.ref : null);

  useEffect(() => {
    const existingRef = summary.existing;
    if (existingRef) {
      setEnsureState((current) =>
        current.kind === "resolved" &&
        current.ref.serverId === existingRef.serverId &&
        current.ref.agentId === existingRef.agentId &&
        current.ref.workspaceId === existingRef.workspaceId
          ? current
          : { kind: "resolved", ref: existingRef },
      );
      return;
    }

    if (!targetServerId || !client || !summary.supportsMainChat) {
      return;
    }

    let cancelled = false;
    setEnsureState({ kind: "ensuring", serverId: targetServerId });

    void client
      .ensureMainChat()
      .then((result) => {
        if (cancelled) return null;
        if (result.error || !result.agentId || !result.workspaceId) {
          setEnsureState({
            kind: "error",
            serverId: targetServerId,
            message: result.error ?? t("mainChat.openFailed"),
          });
          return null;
        }
        setEnsureState({
          kind: "resolved",
          ref: {
            serverId: targetServerId,
            workspaceId: result.workspaceId,
            agentId: result.agentId,
          },
        });
        return result.agentId;
      })
      .catch((error) => {
        if (cancelled) return;
        setEnsureState({
          kind: "error",
          serverId: targetServerId,
          message: error instanceof Error ? error.message : t("mainChat.openFailed"),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [client, retryCount, summary.existing, summary.supportsMainChat, t, targetServerId]);

  useEffect(() => {
    if (!resolvedRef || !client) return;
    void loadOverview(resolvedRef.serverId, resolvedRef.agentId, client).then((overview) => {
      if (overview) {
        hydrateFromOverview(resolvedRef.serverId, overview);
      }
      return overview;
    });
  }, [client, hydrateFromOverview, loadOverview, resolvedRef]);

  const effectiveServerId = resolvedRef?.serverId ?? targetServerId;

  useEffect(() => {
    if (!effectiveServerId || !client) return;
    if (typeof client.listMainChatConversations === "function") {
      void refreshConversations(effectiveServerId, client).catch(() => undefined);
    }
    if (typeof client.getMainChatFleetHosts === "function") {
      void refreshFleetHosts(effectiveServerId, client).catch(() => undefined);
    }
  }, [client, effectiveServerId, refreshConversations, refreshFleetHosts]);

  const handleRetry = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleFocusMainPane = useCallback(() => {
    setActivePane("main");
  }, []);

  const displayTitle = configuredTitle?.trim() || summary.displayTitle;
  const isEnsuring =
    ensureState.kind === "ensuring" ||
    Boolean(targetServerId && (connectionStatus === "connecting" || summary.supportsMainChat));

  const body = (
    <MainChatScreenBody
      resolvedRef={resolvedRef}
      ensureState={ensureState}
      isEnsuring={isEnsuring}
      activePane={activePane}
      onFocusMainPane={handleFocusMainPane}
      onRetry={handleRetry}
      onOpenSettings={handleOpenSettings}
    />
  );

  return (
    <MainChatShell
      variant="main"
      title={displayTitle}
      serverId={effectiveServerId}
      mainAgentId={resolvedRef?.agentId ?? null}
      originRoute={buildMainChatRoute()}
      isRunning={summary.isMainRunning}
      needsYouCount={summary.needsYouCount}
      runningCount={summary.runningCount}
      activePane={activePane}
      onActivePaneChange={setActivePane}
    >
      <HostSyncBanner serverId={effectiveServerId} mainAgentId={resolvedRef?.agentId ?? null} />
      {body}
    </MainChatShell>
  );
}

const styles = StyleSheet.create((theme) => ({
  inactiveContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  stateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  stateDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 420,
  },
}));
