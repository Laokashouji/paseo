import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { isMainChatEnabled } from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import { CircleAlert, Power, RefreshCw, Settings, Sparkles } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostRuntimeConnectionStatus, useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatRoute,
  buildSettingsHostSectionRoute,
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
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
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

function MainChatFirstSetupView({
  serverId,
  title,
  starting,
  errorMessage,
  onStart,
  onOpenProviderSettings,
}: {
  serverId: string;
  title: string;
  starting: boolean;
  errorMessage: string | null;
  onStart: (selection: { provider: AgentProvider; model?: string }) => void;
  onOpenProviderSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const snapshot = useProvidersSnapshot(serverId);
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");

  useEffect(() => {
    setSelectedProvider("");
    setSelectedModel("");
  }, [serverId]);

  const providers = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(snapshot.entries, {
        selectedProvider: selectedProvider || null,
      }),
    [selectedProvider, snapshot.entries],
  );

  const handleSelectModel = useCallback((provider: AgentProvider, modelId: string) => {
    setSelectedProvider(provider);
    setSelectedModel(modelId);
  }, []);

  const handleOpenSelector = useCallback(() => {
    snapshot.refetchIfStale?.(selectedProvider || undefined);
  }, [selectedProvider, snapshot]);

  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void snapshot.refresh?.([provider]);
    },
    [snapshot],
  );

  const handleStartPress = useCallback(() => {
    if (!selectedProvider || starting) return;
    onStart({
      provider: selectedProvider as AgentProvider,
      ...(selectedModel ? { model: selectedModel } : {}),
    });
  }, [onStart, selectedModel, selectedProvider, starting]);

  const isSnapshotLoading = Boolean(snapshot.isLoading || snapshot.isFetching);
  const hasNoProviders = !isSnapshotLoading && providers.length === 0;

  return (
    <View style={styles.centerState} testID="main-chat-first-setup">
      <View style={styles.setupCard}>
        <View style={styles.setupHeader}>
          <View style={styles.setupIconBadge}>
            <ThemedSparkles size={20} uniProps={primaryIconMapping} />
          </View>
          <View style={styles.setupHeaderText}>
            <Text style={styles.setupTitle}>{t("mainChat.firstSetup.title")}</Text>
            <Text style={styles.setupDescription}>
              {t("mainChat.firstSetup.description", { title })}
            </Text>
          </View>
        </View>

        <View style={styles.setupField}>
          <Text style={styles.setupFieldLabel}>{t("mainChat.firstSetup.modelLabel")}</Text>
          <CombinedModelSelector
            providers={providers}
            selectedProvider={selectedProvider}
            selectedModel={selectedModel}
            onSelect={handleSelectModel}
            isLoading={isSnapshotLoading}
            onOpen={handleOpenSelector}
            onRetryProvider={handleRetryProvider}
            isRetryingProvider={Boolean(snapshot.isRefreshing)}
            disabled={starting || hasNoProviders}
            serverId={serverId}
            desktopPlacement="bottom-start"
            desktopMinWidth={360}
          />
        </View>

        {hasNoProviders ? (
          <Text style={styles.setupEmptyHint} testID="main-chat-first-setup-no-providers">
            {t("mainChat.firstSetup.noProvidersHint")}
          </Text>
        ) : null}

        {errorMessage ? (
          <Text style={styles.setupErrorText} testID="main-chat-first-setup-error">
            {errorMessage}
          </Text>
        ) : null}

        <View style={styles.setupActions}>
          {hasNoProviders ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={ThemedSettings}
              onPress={onOpenProviderSettings}
              testID="main-chat-first-setup-open-providers"
            >
              {t("mainChat.firstSetup.openProviderSettings")}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              leftIcon={ThemedSparkles}
              loading={starting}
              disabled={!selectedProvider || starting}
              onPress={handleStartPress}
              testID="main-chat-first-setup-start"
            >
              {starting
                ? t("mainChat.firstSetup.startingButton")
                : t("mainChat.firstSetup.startButton")}
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}

function MainChatScreenBody({
  isDisabled,
  enabling,
  targetServerId,
  displayTitle,
  supportsMainChat,
  needsFirstSetup,
  resolvedRef,
  ensureState,
  isEnsuring,
  activePane,
  onFocusMainPane,
  onStartWithModel,
  onRetry,
  onEnableMainChat,
  onOpenSettings,
  onOpenProviderSettings,
  onOpenMainChatSettings,
}: {
  isDisabled: boolean;
  enabling: boolean;
  targetServerId: string | null;
  displayTitle: string;
  supportsMainChat: boolean;
  needsFirstSetup: boolean;
  resolvedRef: MainChatAgentRef | null;
  ensureState: EnsureState;
  isEnsuring: boolean;
  activePane: "main" | "drawer";
  onFocusMainPane: () => void;
  onStartWithModel: (selection: { provider: AgentProvider; model?: string }) => void;
  onRetry: () => void;
  onEnableMainChat: () => void;
  onOpenSettings: () => void;
  onOpenProviderSettings: () => void;
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
  if (needsFirstSetup && targetServerId && supportsMainChat) {
    return (
      <MainChatFirstSetupView
        serverId={targetServerId}
        title={displayTitle}
        starting={ensureState.kind === "ensuring"}
        errorMessage={ensureState.kind === "error" ? ensureState.message : null}
        onStart={onStartWithModel}
        onOpenProviderSettings={onOpenProviderSettings}
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

function useMainChatEnsureController(params: {
  targetServerId: string | null;
  client: DaemonClient | null;
  existing: MainChatAgentRef | null;
  supportsMainChat: boolean;
  isDisabled: boolean;
}): {
  ensureState: EnsureState;
  startWithSelection: (selection: { provider: AgentProvider; model?: string }) => void;
  resetError: () => void;
} {
  const { targetServerId, client, existing, supportsMainChat, isDisabled } = params;
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

    setEnsureState((current) => {
      if (current.kind === "resolved" && current.ref.serverId === targetServerId) {
        return current;
      }
      if (current.kind === "ensuring" && current.serverId === targetServerId) {
        return current;
      }
      return { kind: "idle" };
    });
  }, [existing, targetServerId]);

  const startWithSelection = useCallback(
    (selection: { provider: AgentProvider; model?: string }) => {
      if (!targetServerId || !client || !supportsMainChat || isDisabled) {
        return;
      }
      const requestedServerId = targetServerId;
      setEnsureState({ kind: "ensuring", serverId: requestedServerId });

      void client
        .ensureMainChat({
          provider: selection.provider,
          ...(selection.model ? { model: selection.model } : {}),
        })
        .then((result) => {
          if (result.error || !result.agentId || !result.workspaceId) {
            setEnsureState({
              kind: "error",
              serverId: requestedServerId,
              message: result.error ?? t("mainChat.openFailed"),
            });
            return null;
          }
          setEnsureState({
            kind: "resolved",
            ref: {
              serverId: requestedServerId,
              workspaceId: result.workspaceId,
              agentId: result.agentId,
            },
          });
          return result.agentId;
        })
        .catch((error) => {
          setEnsureState({
            kind: "error",
            serverId: requestedServerId,
            message: error instanceof Error ? error.message : t("mainChat.openFailed"),
          });
        });
    },
    [client, isDisabled, supportsMainChat, t, targetServerId],
  );

  const resetError = useCallback(() => {
    setEnsureState({ kind: "idle" });
  }, []);

  return { ensureState, startWithSelection, resetError };
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
  const hasDirectorySnapshot = useSessionStore((state) => {
    if (!targetServerId) return false;
    const session = state.sessions[targetServerId];
    return Boolean(session?.hasHydratedAgents);
  });
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
    hasDirectorySnapshot,
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

function resolveMainChatNeedsFirstSetup(input: {
  isDisabled: boolean;
  resolvedRef: MainChatAgentRef | null;
  targetServerId: string | null;
  hasClient: boolean;
  supportsMainChat: boolean;
  connectionStatus: string;
  hasDirectorySnapshot: boolean;
}): boolean {
  if (input.isDisabled || input.resolvedRef) return false;
  if (!input.targetServerId || !input.hasClient || !input.supportsMainChat) return false;
  return input.connectionStatus !== "connecting" && input.hasDirectorySnapshot;
}

function resolveMainChatEnsuringState(input: {
  isDisabled: boolean;
  ensureKind: string;
  targetServerId: string | null;
  connectionStatus: string;
  supportsMainChat: boolean;
  hasDirectorySnapshot: boolean;
}): boolean {
  if (input.isDisabled) return false;
  if (input.ensureKind === "ensuring") return true;
  return Boolean(
    input.targetServerId &&
    (input.connectionStatus === "connecting" ||
      (input.supportsMainChat && !input.hasDirectorySnapshot)),
  );
}

function MainChatScreenContent({ routeServerId }: { routeServerId: string | null }): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    summary,
    targetServerId,
    client,
    hasDirectorySnapshot,
    connectionStatus,
    configuredTitle,
    isDisabled,
    effectiveOverrideRef,
    updateSettings,
    hasMultipleStewards,
  } = useMainChatTargetSession(routeServerId);

  const [enabling, setEnabling] = useState(false);
  const [activePane, setActivePane] = useState<"main" | "drawer">("main");

  const { ensureState, startWithSelection, resetError } = useMainChatEnsureController({
    targetServerId,
    client,
    existing: summary.existing,
    supportsMainChat: summary.supportsMainChat,
    isDisabled,
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

  const handleEnableMainChat = useCallback(() => {
    if (!targetServerId || !client || enabling) return;
    setEnabling(true);
    void updateSettings(targetServerId, { enabled: true }, client)
      .then(() => {
        resetError();
        toast.show(t("mainChat.settings.enabledToast"), { variant: "success" });
        return true;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
      })
      .finally(() => {
        setEnabling(false);
      });
  }, [client, enabling, resetError, t, targetServerId, toast, updateSettings]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleOpenProviderSettings = useCallback(() => {
    if (!targetServerId) {
      router.push(buildSettingsRoute());
      return;
    }
    router.push(buildSettingsHostSectionRoute(targetServerId, "providers"));
  }, [targetServerId]);

  const handleOpenMainChatSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("main-chat"));
  }, []);

  const handleFocusMainPane = useCallback(() => {
    setActivePane("main");
  }, []);

  const displayTitle = configuredTitle?.trim() || summary.displayTitle;
  const needsFirstSetup = resolveMainChatNeedsFirstSetup({
    isDisabled,
    resolvedRef,
    targetServerId,
    hasClient: client !== null,
    supportsMainChat: summary.supportsMainChat,
    connectionStatus,
    hasDirectorySnapshot,
  });
  const isEnsuring = resolveMainChatEnsuringState({
    isDisabled,
    ensureKind: ensureState.kind,
    targetServerId,
    connectionStatus,
    supportsMainChat: summary.supportsMainChat,
    hasDirectorySnapshot,
  });

  const body = (
    <MainChatScreenBody
      isDisabled={isDisabled}
      enabling={enabling}
      targetServerId={targetServerId}
      displayTitle={displayTitle}
      supportsMainChat={summary.supportsMainChat}
      needsFirstSetup={needsFirstSetup}
      resolvedRef={resolvedRef}
      ensureState={ensureState}
      isEnsuring={isEnsuring}
      activePane={activePane}
      onFocusMainPane={handleFocusMainPane}
      onStartWithModel={startWithSelection}
      onRetry={resetError}
      onEnableMainChat={handleEnableMainChat}
      onOpenSettings={handleOpenSettings}
      onOpenProviderSettings={handleOpenProviderSettings}
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
      {!isDisabled && resolvedRef ? (
        <HostSyncBanner serverId={effectiveServerId} mainAgentId={resolvedRef.agentId} />
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
  setupCard: {
    width: "100%",
    maxWidth: 460,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  setupHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  setupIconBadge: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  setupHeaderText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  setupTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  setupDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  setupField: {
    gap: theme.spacing[1.5],
  },
  setupFieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  setupEmptyHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  setupErrorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  setupActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
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
