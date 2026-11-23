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

  const [ensureState, setEnsureState] = useState<EnsureState>({ kind: "idle" });
  const [retryCount, setRetryCount] = useState(0);
  const [activePane, setActivePane] = useState<"main" | "drawer">("main");

  const resolvedRef: MainChatAgentRef | null =
    summary.existing ?? (ensureState.kind === "resolved" ? ensureState.ref : null);

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
    void loadOverview(resolvedRef.serverId, resolvedRef.agentId, client);
  }, [client, loadOverview, resolvedRef]);

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

  let body: ReactElement;
  if (resolvedRef) {
    body = (
      <MainChatAgentHost
        key={`${resolvedRef.serverId}:${resolvedRef.agentId}`}
        sourceId={`main-chat:${resolvedRef.serverId}:${resolvedRef.agentId}`}
        serverId={resolvedRef.serverId}
        workspaceId={resolvedRef.workspaceId}
        agentId={resolvedRef.agentId}
        isFocused={activePane === "main"}
        onFocusPane={handleFocusMainPane}
      />
    );
  } else if (ensureState.kind === "error") {
    body = (
      <View style={styles.centerState} testID="main-chat-ensure-error">
        <ThemedCircleAlert size={28} uniProps={dangerIconMapping} />
        <Text style={styles.stateTitle}>{t("mainChat.shell.ensureErrorTitle")}</Text>
        <Text style={styles.stateDescription}>{ensureState.message}</Text>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={ThemedRefreshCw}
          onPress={handleRetry}
          testID="main-chat-ensure-retry"
        >
          {t("mainChat.shell.retryEnsure")}
        </Button>
      </View>
    );
  } else if (
    ensureState.kind === "ensuring" ||
    (targetServerId && (connectionStatus === "connecting" || summary.supportsMainChat))
  ) {
    body = (
      <View style={styles.centerState} testID="main-chat-ensuring">
        <ThemedLoadingSpinner size="large" uniProps={mutedIconMapping} />
        <Text style={styles.stateTitle}>{t("mainChat.shell.loadingTitle")}</Text>
        <Text style={styles.stateDescription}>{t("mainChat.shell.loadingSubtitle")}</Text>
      </View>
    );
  } else {
    body = (
      <View style={styles.centerState} testID="main-chat-no-host">
        <ThemedSparkles size={28} uniProps={mutedIconMapping} />
        <Text style={styles.stateTitle}>{t("mainChat.shell.noHostTitle")}</Text>
        <Text style={styles.stateDescription}>{t("mainChat.shell.noHostDescription")}</Text>
        <Button
          variant="outline"
          size="sm"
          leftIcon={ThemedSettings}
          onPress={handleOpenSettings}
          testID="main-chat-open-host-settings"
        >
          {t("mainChat.shell.openHostSettings")}
        </Button>
      </View>
    );
  }

  return (
    <MainChatShell
      variant="main"
      title={displayTitle}
      serverId={resolvedRef?.serverId ?? targetServerId}
      mainAgentId={resolvedRef?.agentId ?? null}
      originRoute={buildMainChatRoute()}
      isRunning={summary.isMainRunning}
      needsYouCount={summary.needsYouCount}
      runningCount={summary.runningCount}
      activePane={activePane}
      onActivePaneChange={setActivePane}
    >
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
