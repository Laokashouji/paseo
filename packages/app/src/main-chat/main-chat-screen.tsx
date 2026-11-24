import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isMainChatEnabled } from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import { CircleAlert, Power, RefreshCw, Settings, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useHostRuntimeConnectionStatus, useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { MainChatAgentHost } from "./agent-host";
import { useMainChatConversationsStore } from "./conversations-store";
import { HostSyncBanner } from "./host-sync-banner";
import { MainChatShell } from "./main-chat-shell";
import { useMainChatOverviewStore } from "./overview-store";
import { selectMainChatSidebarSummary, type MainChatAgentRef } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";
import { useMainChatStewardRoster } from "./use-steward-roster";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedPower = withUnistyles(Power);
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

export interface MainChatScreenProps {
  serverId?: string | null;
}

/**
 * Primary top-level `/main` screen.
 * Unmounts its conversation host while blurred so returning to `/main` re-establishes a clean
 * bottom-anchored scroll position while preserving drafts in `useDraftStore`.
 */
export function MainChatScreen({ serverId }: MainChatScreenProps = {}): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.inactiveContainer} />;
  }

  return <MainChatScreenContent routeServerId={serverId ?? null} />;
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
  isDisabled,
  enabling,
  resolvedRef,
  ensureState,
  isEnsuring,
  activePane,
  onFocusMainPane,
  onRetry,
  onEnableMainChat,
  onOpenSettings,
  onOpenMainChatSettings,
}: {
  isDisabled: boolean;
  enabling: boolean;
  resolvedRef: MainChatAgentRef | null;
  ensureState: EnsureState;
  isEnsuring: boolean;
  activePane: "main" | "drawer";
  onFocusMainPane: () => void;
  onRetry: () => void;
  onEnableMainChat: () => void;
  onOpenSettings: () => void;
  onOpenMainChatSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (isDisabled) {
    return (
      <View style={styles.centerState} testID="main-chat-disabled-state">
        <ThemedPower size={28} uniProps={mutedIconMapping} />
        <Text style={styles.stateTitle}>{t("mainChat.shell.disabledTitle")}</Text>
        <Text style={styles.stateDescription}>{t("mainChat.shell.disabledDescription")}</Text>
        <View style={styles.stateActions}>
          <Button
            variant="default"
            size="sm"
            leftIcon={ThemedPower}
            loading={enabling}
            disabled={enabling}
            onPress={onEnableMainChat}
            testID="main-chat-re-enable-button"
          >
            {t("mainChat.shell.enableNowButton")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedSettings}
            onPress={onOpenMainChatSettings}
            testID="main-chat-disabled-open-settings"
          >
            {t("mainChat.actions.openSettings")}
          </Button>
        </View>
      </View>
    );
  }

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

function useMainChatEnsureState(params: {
  targetServerId: string | null;
  client: DaemonClient | null;
  existing: MainChatAgentRef | null;
  supportsMainChat: boolean;
  isDisabled: boolean;
  retryCount: number;
}): EnsureState {
  const { targetServerId, client, existing, supportsMainChat, isDisabled, retryCount } = params;
  const { t } = useTranslation();
  const [ensureState, setEnsureState] = useState<EnsureState>({ kind: "idle" });

  useEffect(() => {
    if (existing) {
      setEnsureState((current) =>
        current.kind === "resolved" &&
        current.ref.serverId === existing.serverId &&
        current.ref.agentId === existing.agentId &&
        current.ref.workspaceId === existing.workspaceId
          ? current
          : { kind: "resolved", ref: existing },
      );
      return;
    }

    if (!targetServerId || !client || !supportsMainChat || isDisabled) {
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
  }, [client, existing, isDisabled, retryCount, supportsMainChat, t, targetServerId]);

  return ensureState;
}

function useMainChatScreenDataSync(params: {
  effectiveServerId: string | null;
  resolvedRef: MainChatAgentRef | null;
  client: DaemonClient | null;
  isDisabled: boolean;
}): void {
  const { effectiveServerId, resolvedRef, client, isDisabled } = params;
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const hydrateFromOverview = useMainChatConversationsStore((state) => state.hydrateFromOverview);
  const refreshConversations = useMainChatConversationsStore((state) => state.refreshConversations);
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);

  useEffect(() => {
    if (!resolvedRef || !client || isDisabled) return;
    void loadOverview(resolvedRef.serverId, resolvedRef.agentId, client).then((overview) => {
      if (overview) {
        hydrateFromOverview(resolvedRef.serverId, overview);
      }
      return overview;
    });
  }, [client, hydrateFromOverview, isDisabled, loadOverview, resolvedRef]);

  useEffect(() => {
    if (!effectiveServerId || !client || isDisabled) return;
    if (typeof client.listMainChatConversations === "function") {
      void refreshConversations(effectiveServerId, client).catch(() => undefined);
    }
    if (typeof client.getMainChatFleetHosts === "function") {
      void refreshFleetHosts(effectiveServerId, client).catch(() => undefined);
    }
  }, [client, effectiveServerId, isDisabled, refreshConversations, refreshFleetHosts]);
}

function useMainChatTargetSession(routeServerId: string | null) {
  const hosts = useHosts();
  const lastWorkspace = useLastWorkspaceSelection();
  const fallbackPreferredServerId = lastWorkspace?.serverId ?? hosts[0]?.serverId ?? null;
  const { activeServerId, activeAllowedServerIds, roster, hasMultipleStewards, selectSteward } =
    useMainChatStewardRoster({
      routeServerId,
      fallbackPreferredServerId,
    });
  const preferredServerId = activeServerId ?? fallbackPreferredServerId;
  const strictServerId = Boolean(routeServerId || roster.length > 0);

  useEffect(() => {
    if (routeServerId) {
      selectSteward(routeServerId);
    }
  }, [routeServerId, selectSteward]);

  const summary = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        selectMainChatSidebarSummary(state, preferredServerId, null, {
          allowedServerIds: activeAllowedServerIds,
          strictServerId,
        }),
      [activeAllowedServerIds, preferredServerId, strictServerId],
    ),
    equal,
  );

  const targetServerId = summary.targetServerId;
  useDirectoryDemand(targetServerId);

  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );
  const connectionStatus = useHostRuntimeConnectionStatus(targetServerId ?? "");
  const settings = useMainChatSettingsStore((state) =>
    targetServerId ? state.settingsByServerId[targetServerId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const activeAgentOverride = useMainChatOverviewStore((state) =>
    targetServerId ? (state.activeAgentOverrideByServerId[targetServerId] ?? null) : null,
  );
  const clearActiveAgentOverride = useMainChatOverviewStore(
    (state) => state.clearActiveAgentOverride,
  );

  useEffect(() => {
    if (!targetServerId || !client || !summary.supportsMainChat || settings) return;
    void loadSettings(targetServerId, client).catch(() => undefined);
  }, [client, loadSettings, settings, summary.supportsMainChat, targetServerId]);

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

  return {
    summary,
    targetServerId,
    client,
    connectionStatus,
    configuredTitle: settings?.title,
    isDisabled: settings !== undefined && !isMainChatEnabled(settings),
    effectiveOverrideRef,
    updateSettings,
    hasMultipleStewards,
  };
}

function resolveMainChatScreenNavServerId(
  hasMultipleStewards: boolean,
  routeServerId: string | null,
  effectiveServerId: string | null,
): string | undefined {
  return hasMultipleStewards || Boolean(routeServerId)
    ? (effectiveServerId ?? undefined)
    : undefined;
}

function resolveMainChatEnsuringState(input: {
  isDisabled: boolean;
  ensureKind: string;
  targetServerId: string | null;
  connectionStatus: string;
  supportsMainChat: boolean;
}): boolean {
  if (input.isDisabled) return false;
  if (input.ensureKind === "ensuring") return true;
  return Boolean(
    input.targetServerId && (input.connectionStatus === "connecting" || input.supportsMainChat),
  );
}

function MainChatScreenContent({ routeServerId }: { routeServerId: string | null }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    summary,
    targetServerId,
    client,
    connectionStatus,
    configuredTitle,
    isDisabled,
    effectiveOverrideRef,
    updateSettings,
    hasMultipleStewards,
  } = useMainChatTargetSession(routeServerId);

  const [retryCount, setRetryCount] = useState(0);
  const [enabling, setEnabling] = useState(false);
  const [activePane, setActivePane] = useState<"main" | "drawer">("main");

  const ensureState = useMainChatEnsureState({
    targetServerId,
    client,
    existing: summary.existing,
    supportsMainChat: summary.supportsMainChat,
    isDisabled,
    retryCount,
  });

  const resolvedRef: MainChatAgentRef | null =
    effectiveOverrideRef ??
    summary.existing ??
    (ensureState.kind === "resolved" ? ensureState.ref : null);

  const effectiveServerId = resolvedRef?.serverId ?? targetServerId;
  useMainChatScreenDataSync({
    effectiveServerId,
    resolvedRef,
    client,
    isDisabled,
  });

  const handleRetry = useCallback(() => {
    setRetryCount((count) => count + 1);
  }, []);

  const handleEnableMainChat = useCallback(() => {
    if (!targetServerId || !client || enabling) return;
    setEnabling(true);
    void updateSettings(targetServerId, { enabled: true }, client)
      .then(() => {
        setRetryCount((count) => count + 1);
        toast.show(t("mainChat.settings.enabledToast"), { variant: "success" });
        return true;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
      })
      .finally(() => {
        setEnabling(false);
      });
  }, [client, enabling, t, targetServerId, toast, updateSettings]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleOpenMainChatSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("main-chat"));
  }, []);

  const handleFocusMainPane = useCallback(() => {
    setActivePane("main");
  }, []);

  const displayTitle = configuredTitle?.trim() || summary.displayTitle;
  const isEnsuring = resolveMainChatEnsuringState({
    isDisabled,
    ensureKind: ensureState.kind,
    targetServerId,
    connectionStatus,
    supportsMainChat: summary.supportsMainChat,
  });

  const body = (
    <MainChatScreenBody
      isDisabled={isDisabled}
      enabling={enabling}
      resolvedRef={resolvedRef}
      ensureState={ensureState}
      isEnsuring={isEnsuring}
      activePane={activePane}
      onFocusMainPane={handleFocusMainPane}
      onRetry={handleRetry}
      onEnableMainChat={handleEnableMainChat}
      onOpenSettings={handleOpenSettings}
      onOpenMainChatSettings={handleOpenMainChatSettings}
    />
  );

  const navServerId = resolveMainChatScreenNavServerId(
    hasMultipleStewards,
    routeServerId,
    effectiveServerId,
  );

  return (
    <MainChatShell
      variant="main"
      title={displayTitle}
      serverId={effectiveServerId}
      routeServerId={navServerId}
      mainAgentId={resolvedRef?.agentId ?? null}
      originRoute={buildMainChatRoute(navServerId)}
      isRunning={!isDisabled && summary.isMainRunning}
      needsYouCount={isDisabled ? 0 : summary.needsYouCount}
      runningCount={isDisabled ? 0 : summary.runningCount}
      activePane={activePane}
      onActivePaneChange={setActivePane}
    >
      {!isDisabled ? (
        <HostSyncBanner serverId={effectiveServerId} mainAgentId={resolvedRef?.agentId ?? null} />
      ) : null}
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
  stateActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
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
