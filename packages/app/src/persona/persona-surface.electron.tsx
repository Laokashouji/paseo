import { router } from "expo-router";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  GitCommitHorizontal,
  Home,
  PanelLeft,
  RotateCw,
  Settings,
} from "lucide-react-native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, type DesktopPersonaOpenSessionEvent } from "@/desktop/host";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { createAppOpenPersonaSessionDeps, openPersonaSession } from "./open-persona-session";
import {
  disableResidentPersonaWebview,
  ensureResidentPersonaWebview,
  getResidentPersonaWebview,
  lookupPersonaGuestSessionMetadata,
  parkResidentPersonaWebview,
  presentResidentPersonaWebview,
  sendPersonaGuestAllowOnce,
  sendPersonaGuestConfig,
  sendPersonaGuestRouteSync,
  type PersonaElectronWebviewElement,
  type PersonaGuestConfigMessage,
} from "./resident-persona-webview.electron";
import {
  normalizePersonaHubUrl,
  parsePersonaEmbedSessionRoute,
  validatePersonaGuestOpenSessionPayload,
} from "./settings";
import {
  usePersonaEmbedSettingsState,
  useUpdatePersonaEmbedSettings,
} from "./use-persona-settings";

const ThemedHome = withUnistyles(Home);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedPanelLeft = withUnistyles(PanelLeft);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedSettings = withUnistyles(Settings);
const ThemedOpenInPaseo = withUnistyles(ArrowUpRight);
const ThemedDiff = withUnistyles(GitCommitHorizontal);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconActiveMapping = (theme: Theme) => ({ color: theme.colors.accent });
const iconDisabledMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

interface WebviewFailLoadEvent extends Event {
  errorCode?: number;
  errorDescription?: string;
  validatedURL?: string;
  isMainFrame?: boolean;
}

interface WebviewNavigateEvent extends Event {
  url?: string;
  isMainFrame?: boolean;
}

interface WebviewIpcMessageEvent extends Event {
  channel?: string;
  args?: unknown[];
  isMainFrame?: boolean;
}

interface LoadErrorState {
  code: number;
  description: string;
  url: string;
}

const ERR_ABORTED = -3;

function readWebviewUrlSafely(
  webview: PersonaElectronWebviewElement | null | undefined,
  fallback: string,
): string {
  if (!webview) {
    return fallback;
  }
  try {
    const live = webview.getURL?.();
    if (typeof live === "string" && live.trim().length > 0) {
      return live;
    }
  } catch {
    // Electron throws before dom-ready/attach finishes; fall back to src or known Hub URL.
  }
  if (typeof webview.src === "string" && webview.src.trim().length > 0) {
    return webview.src;
  }
  return fallback;
}

function isSameOriginUrl(candidateUrl: string, expectedOrigin: string): boolean {
  try {
    const parsed = new URL(candidateUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === expectedOrigin
    );
  } catch {
    return false;
  }
}

function PersonaSurfaceOverlay(input: {
  validHubUrl: string | null;
  mountRejected: boolean;
  loadError: LoadErrorState | null;
  onReload: () => void;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!input.validHubUrl) {
    return (
      <View style={styles.overlayCard} testID="persona-invalid-url-state">
        <Text style={styles.overlayTitle}>{t("personaEmbed.error.loadFailedTitle")}</Text>
        <Text style={styles.overlayDescription}>{t("personaEmbed.error.invalidUrl")}</Text>
        <View style={styles.overlayActions}>
          <Button onPress={input.onOpenSettings}>{t("personaEmbed.toolbar.settings")}</Button>
        </View>
      </View>
    );
  }
  if (input.mountRejected) {
    return (
      <View style={styles.overlayCard} testID="persona-mount-rejected-state">
        <Text style={styles.overlayTitle}>{t("personaEmbed.error.loadFailedTitle")}</Text>
        <Text style={styles.overlayDescription}>{t("personaEmbed.error.mountRejected")}</Text>
        <View style={styles.overlayActions}>
          <Button onPress={input.onReload}>{t("personaEmbed.error.retry")}</Button>
          <Button variant="ghost" onPress={input.onOpenSettings}>
            {t("personaEmbed.toolbar.settings")}
          </Button>
        </View>
      </View>
    );
  }
  if (!input.loadError) {
    return null;
  }
  return (
    <View style={styles.overlayCard} testID="persona-load-error-state">
      <Text style={styles.overlayTitle}>{t("personaEmbed.error.loadFailedTitle")}</Text>
      <Text style={styles.overlayDescription}>
        {t("personaEmbed.error.loadFailedDetail", {
          url: input.loadError.url || input.validHubUrl,
        })}
      </Text>
      <Text style={styles.overlayMeta}>
        {input.loadError.description} ({input.loadError.code})
      </Text>
      <View style={styles.overlayActions}>
        <Button onPress={input.onReload}>{t("personaEmbed.error.retry")}</Button>
        <Button variant="outline" onPress={input.onOpenExternal}>
          {t("personaEmbed.toolbar.openExternal")}
        </Button>
        <Button variant="ghost" onPress={input.onOpenSettings}>
          {t("personaEmbed.toolbar.settings")}
        </Button>
      </View>
    </View>
  );
}

export function PersonaSurface() {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const { settings: personaSettings, isLoaded: settingsLoaded } = usePersonaEmbedSettingsState();
  const updatePersonaSettings = useUpdatePersonaEmbedSettings();

  const normalizedHub = useMemo(
    () => normalizePersonaHubUrl(personaSettings.hubUrl),
    [personaSettings.hubUrl],
  );
  const validHubUrl = normalizedHub.ok ? normalizedHub.url : null;
  const authorizedHubOrigin = normalizedHub.ok ? normalizedHub.origin : null;
  const canMountWebview = settingsLoaded && personaSettings.enabled && validHubUrl !== null;

  const anchorRef = useRef<View | null>(null);
  const [webviewNode, setWebviewNode] = useState<PersonaElectronWebviewElement | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>(validHubUrl ?? "");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<LoadErrorState | null>(null);
  const [mountRejected, setMountRejected] = useState(false);

  const guestConfig = useMemo<PersonaGuestConfigMessage | null>(() => {
    if (!normalizedHub.ok) {
      return null;
    }
    return {
      hubOrigin: normalizedHub.origin,
      hubBasePath: normalizedHub.basePath,
      hidePersonaSidebar: personaSettings.hidePersonaSidebar,
      interceptSessionClicks: personaSettings.interceptSessionClicks,
      labels: {
        openInPaseo: t("personaEmbed.guest.openInPaseo"),
        openDiffInPaseo: t("personaEmbed.guest.openDiffInPaseo"),
        openInPaseoTooltip: t("personaEmbed.guest.openInPaseoTooltip"),
        openDiffTooltip: t("personaEmbed.guest.openDiffTooltip"),
      },
    };
  }, [
    normalizedHub,
    personaSettings.hidePersonaSidebar,
    personaSettings.interceptSessionClicks,
    t,
  ]);

  const guestConfigRef = useRef(guestConfig);
  guestConfigRef.current = guestConfig;

  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;

  const currentSessionRoute = useMemo(() => {
    if (!validHubUrl || !currentUrl) {
      return null;
    }
    return parsePersonaEmbedSessionRoute(currentUrl, validHubUrl);
  }, [currentUrl, validHubUrl]);

  const handleOpenSessionRequest = useCallback(
    (payload: DesktopPersonaOpenSessionEvent) => {
      if (!canMountWebview || !validHubUrl) {
        return;
      }
      if (!payload?.machineId || !payload?.sessionId) {
        return;
      }
      const deps = createAppOpenPersonaSessionDeps({
        toast,
        isCompact,
        allowPersonaFallbackNavigation: (rawHref) => {
          sendPersonaGuestAllowOnce(rawHref);
        },
        lookupSessionMetadataHint: ({ machineId, sessionId }) =>
          lookupPersonaGuestSessionMetadata({
            machineId,
            sessionId,
            authorizedHubUrl: validHubUrl,
          }),
      });
      void openPersonaSession(
        {
          machineId: payload.machineId,
          sessionId: payload.sessionId,
          workspaceIdHint: payload.workspaceIdHint ?? null,
          cwdHint: payload.cwdHint ?? null,
          panel: payload.panel === "diff" ? "diff" : null,
          source: payload.source,
          rawHref: payload.rawHref ?? null,
        },
        deps,
      );
    },
    [canMountWebview, isCompact, toast, validHubUrl],
  );

  // Sync resident webview geometry with the anchor container.
  const syncAnchorGeometry = useCallback(() => {
    if (!canMountWebview || loadError || mountRejected) {
      parkResidentPersonaWebview();
      return;
    }
    const element = anchorRef.current as unknown as HTMLElement | null;
    if (!element || typeof element.getBoundingClientRect !== "function") {
      parkResidentPersonaWebview();
      return;
    }
    const rect = element.getBoundingClientRect();
    presentResidentPersonaWebview(rect);
  }, [canMountWebview, loadError, mountRejected]);

  // Create or reuse the resident <webview> only once settings are hydrated and Persona is enabled.
  useEffect(() => {
    let cancelled = false;
    if (!settingsLoaded) {
      parkResidentPersonaWebview();
      return;
    }
    if (!personaSettings.enabled) {
      setWebviewNode(null);
      setLoadError(null);
      setMountRejected(false);
      void disableResidentPersonaWebview();
      return;
    }
    if (!validHubUrl) {
      parkResidentPersonaWebview();
      setWebviewNode(null);
      setMountRejected(false);
      return;
    }

    setLoadError(null);
    setMountRejected(false);
    void (async () => {
      const webview = await ensureResidentPersonaWebview(validHubUrl);
      if (cancelled) {
        return;
      }
      if (!webview) {
        setWebviewNode(null);
        setMountRejected(true);
        return;
      }
      setWebviewNode(webview);
      const liveUrl = readWebviewUrlSafely(webview, validHubUrl);
      if (authorizedHubOrigin && isSameOriginUrl(liveUrl, authorizedHubOrigin)) {
        setCurrentUrl(liveUrl);
      } else {
        setCurrentUrl(validHubUrl);
      }
      if (guestConfigRef.current) {
        sendPersonaGuestConfig(guestConfigRef.current);
        sendPersonaGuestRouteSync(liveUrl);
      }
    })();

    return () => {
      cancelled = true;
      parkResidentPersonaWebview();
    };
  }, [authorizedHubOrigin, personaSettings.enabled, settingsLoaded, validHubUrl]);

  // Push updated config whenever hidePersonaSidebar / interceptSessionClicks / language change.
  useEffect(() => {
    if (!webviewNode || !guestConfig || !canMountWebview) {
      return;
    }
    sendPersonaGuestConfig(guestConfig);
  }, [canMountWebview, guestConfig, webviewNode]);

  // Observe anchor bounds & viewport resize.
  useLayoutEffect(() => {
    syncAnchorGeometry();
    const element = anchorRef.current as unknown as HTMLElement | null;
    if (!element || typeof window === "undefined") {
      return;
    }

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => {
        syncAnchorGeometry();
      });
      resizeObserver.observe(element);
    }

    window.addEventListener("resize", syncAnchorGeometry);
    window.addEventListener("scroll", syncAnchorGeometry, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncAnchorGeometry);
      window.removeEventListener("scroll", syncAnchorGeometry, true);
      parkResidentPersonaWebview();
    };
  }, [syncAnchorGeometry, webviewNode]);

  // Bind Electron <webview> lifecycle and guest IPC listeners.
  useEffect(() => {
    if (!webviewNode || !validHubUrl || !authorizedHubOrigin || !canMountWebview) {
      return;
    }

    const refreshNavButtons = () => {
      try {
        setCanGoBack(Boolean(webviewNode.canGoBack?.()));
        setCanGoForward(Boolean(webviewNode.canGoForward?.()));
      } catch {
        // Ignore before guest attachment finishes.
      }
    };

    const onStartLoading = () => {
      setIsLoading(true);
    };

    const onStopLoading = () => {
      setIsLoading(false);
      refreshNavButtons();
    };

    const onDomReady = () => {
      setLoadError(null);
      refreshNavButtons();
      const liveUrl = readWebviewUrlSafely(webviewNode, currentUrlRef.current || validHubUrl);
      if (isSameOriginUrl(liveUrl, authorizedHubOrigin)) {
        setCurrentUrl(liveUrl);
        if (guestConfigRef.current) {
          sendPersonaGuestConfig(guestConfigRef.current);
        }
        sendPersonaGuestRouteSync(liveUrl);
      }
    };

    const onNavigate = (event: Event) => {
      const navEvent = event as WebviewNavigateEvent;
      // Ignore subframe navigations so embedded iframes never hijack toolbar state or route sync.
      if (navEvent.isMainFrame === false) {
        return;
      }
      const nextUrl = navEvent.url || readWebviewUrlSafely(webviewNode, "");
      if (nextUrl && isSameOriginUrl(nextUrl, authorizedHubOrigin)) {
        setCurrentUrl(nextUrl);
        setLoadError(null);
        sendPersonaGuestRouteSync(nextUrl);
      }
      refreshNavButtons();
    };

    const onFailLoad = (event: Event) => {
      const failEvent = event as WebviewFailLoadEvent;
      if (failEvent.isMainFrame === false || failEvent.errorCode === ERR_ABORTED) {
        return;
      }
      setIsLoading(false);
      setLoadError({
        code: failEvent.errorCode ?? -1,
        description: failEvent.errorDescription || "Load failed",
        url: failEvent.validatedURL || validHubUrl,
      });
    };

    const onIpcMessage = (event: Event) => {
      const ipcEvent = event as WebviewIpcMessageEvent;
      if (ipcEvent.isMainFrame === false) {
        return;
      }
      const currentGuestUrl = readWebviewUrlSafely(webviewNode, "");
      if (!isSameOriginUrl(currentGuestUrl, authorizedHubOrigin)) {
        return;
      }

      if (ipcEvent.channel === "paseo:persona:ready") {
        if (guestConfigRef.current) {
          sendPersonaGuestConfig(guestConfigRef.current);
        }
        sendPersonaGuestRouteSync(currentGuestUrl);
        return;
      }
      if (ipcEvent.channel === "paseo:persona:open-session") {
        const validated = validatePersonaGuestOpenSessionPayload(ipcEvent.args?.[0], {
          authorizedHubUrl: validHubUrl,
          currentGuestUrl,
          isMainFrame: ipcEvent.isMainFrame,
        });
        if (validated) {
          handleOpenSessionRequest(validated);
        }
      }
    };

    webviewNode.addEventListener("did-start-loading", onStartLoading);
    webviewNode.addEventListener("did-stop-loading", onStopLoading);
    webviewNode.addEventListener("dom-ready", onDomReady);
    webviewNode.addEventListener("did-navigate", onNavigate);
    webviewNode.addEventListener("did-navigate-in-page", onNavigate);
    webviewNode.addEventListener("did-fail-load", onFailLoad);
    webviewNode.addEventListener("ipc-message", onIpcMessage);

    return () => {
      webviewNode.removeEventListener("did-start-loading", onStartLoading);
      webviewNode.removeEventListener("did-stop-loading", onStopLoading);
      webviewNode.removeEventListener("dom-ready", onDomReady);
      webviewNode.removeEventListener("did-navigate", onNavigate);
      webviewNode.removeEventListener("did-navigate-in-page", onNavigate);
      webviewNode.removeEventListener("did-fail-load", onFailLoad);
      webviewNode.removeEventListener("ipc-message", onIpcMessage);
    };
  }, [authorizedHubOrigin, canMountWebview, handleOpenSessionRequest, validHubUrl, webviewNode]);

  // Listen for main-process window-open interceptions (e.g. TaskPanel "Open in new window").
  useEffect(() => {
    if (!canMountWebview || !validHubUrl) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const dispose = await listenToDesktopEvent<unknown>(
          "persona-open-session",
          (rawPayload) => {
            if (disposed) {
              return;
            }
            const validated = validatePersonaGuestOpenSessionPayload(rawPayload, {
              authorizedHubUrl: validHubUrl,
            });
            if (validated) {
              handleOpenSessionRequest(validated);
            }
          },
        );
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      } catch {
        // Ignore when desktop event listener is unavailable in non-Electron tests.
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canMountWebview, handleOpenSessionRequest, validHubUrl]);

  const handleGoHome = useCallback(() => {
    if (!canMountWebview || !validHubUrl) return;
    setLoadError(null);
    const webview = getResidentPersonaWebview();
    if (webview?.loadURL) {
      void webview.loadURL(validHubUrl).catch(() => undefined);
    }
  }, [canMountWebview, validHubUrl]);

  const handleGoBack = useCallback(() => {
    getResidentPersonaWebview()?.goBack?.();
  }, []);

  const handleGoForward = useCallback(() => {
    getResidentPersonaWebview()?.goForward?.();
  }, []);

  const handleReload = useCallback(() => {
    if (!canMountWebview || !validHubUrl) return;
    setLoadError(null);
    setMountRejected(false);
    const webview = getResidentPersonaWebview();
    if (!webview) {
      void (async () => {
        const next = await ensureResidentPersonaWebview(validHubUrl);
        if (!next) {
          setMountRejected(true);
          return;
        }
        setWebviewNode(next);
      })();
      return;
    }
    webview.reload?.();
  }, [canMountWebview, validHubUrl]);

  const handleTogglePersonaSidebar = useCallback(() => {
    void updatePersonaSettings({
      hidePersonaSidebar: !personaSettings.hidePersonaSidebar,
    });
  }, [personaSettings.hidePersonaSidebar, updatePersonaSettings]);

  const handleOpenExternal = useCallback(() => {
    const target = currentUrl || validHubUrl;
    if (!target) return;
    const openUrl = getDesktopHost()?.opener?.openUrl;
    if (openUrl) {
      void openUrl(target).catch(() => undefined);
    } else if (typeof window !== "undefined") {
      window.open(target, "_blank", "noopener,noreferrer");
    }
  }, [currentUrl, validHubUrl]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("persona"));
  }, []);

  const handleToolbarOpenSession = useCallback(
    (panel?: "diff") => {
      if (!currentSessionRoute) return;
      handleOpenSessionRequest({
        machineId: currentSessionRoute.machineId,
        sessionId: currentSessionRoute.sessionId,
        panel,
        source: "header-button",
        rawHref: currentUrl,
      });
    },
    [currentSessionRoute, currentUrl, handleOpenSessionRequest],
  );

  const handleToolbarOpenAgent = useCallback(() => {
    handleToolbarOpenSession(undefined);
  }, [handleToolbarOpenSession]);

  const handleToolbarOpenDiff = useCallback(() => {
    handleToolbarOpenSession("diff");
  }, [handleToolbarOpenSession]);

  if (!settingsLoaded) {
    return (
      <View style={styles.disabledContainer} testID="persona-surface-electron-loading">
        <ThemedSpinner size="small" uniProps={iconMutedMapping} />
      </View>
    );
  }

  if (!personaSettings.enabled) {
    return (
      <View style={styles.disabledContainer} testID="persona-surface-electron-disabled">
        <View style={styles.overlayCard}>
          <Text style={styles.overlayTitle}>{t("personaEmbed.error.disabledTitle")}</Text>
          <Text style={styles.overlayDescription}>
            {t("personaEmbed.error.disabledDescription")}
          </Text>
          <View style={styles.overlayActions}>
            <Button onPress={handleOpenSettings} testID="persona-disabled-open-settings">
              {t("personaEmbed.error.enableInSettings")}
            </Button>
          </View>
        </View>
      </View>
    );
  }

  const overlayContent = (
    <PersonaSurfaceOverlay
      validHubUrl={validHubUrl}
      mountRejected={mountRejected}
      loadError={loadError}
      onReload={handleReload}
      onOpenExternal={handleOpenExternal}
      onOpenSettings={handleOpenSettings}
    />
  );

  return (
    <View style={styles.container} testID="persona-surface-electron">
      <View style={styles.toolbar}>
        <View style={styles.toolbarGroup}>
          <ToolbarButton
            onPress={handleGoHome}
            disabled={!validHubUrl}
            label={t("personaEmbed.toolbar.home")}
            testID="persona-toolbar-home"
          >
            <ThemedHome size={15} uniProps={validHubUrl ? iconMutedMapping : iconDisabledMapping} />
          </ToolbarButton>
          <ToolbarButton
            onPress={handleGoBack}
            disabled={!canGoBack}
            label={t("personaEmbed.toolbar.back")}
            testID="persona-toolbar-back"
          >
            <ThemedArrowLeft
              size={15}
              uniProps={canGoBack ? iconMutedMapping : iconDisabledMapping}
            />
          </ToolbarButton>
          <ToolbarButton
            onPress={handleGoForward}
            disabled={!canGoForward}
            label={t("personaEmbed.toolbar.forward")}
            testID="persona-toolbar-forward"
          >
            <ThemedArrowRight
              size={15}
              uniProps={canGoForward ? iconMutedMapping : iconDisabledMapping}
            />
          </ToolbarButton>
          <ToolbarButton
            onPress={handleReload}
            disabled={!validHubUrl}
            label={t("personaEmbed.toolbar.reload")}
            testID="persona-toolbar-reload"
          >
            {isLoading ? (
              <ThemedSpinner size="small" />
            ) : (
              <ThemedRotateCw
                size={15}
                uniProps={validHubUrl ? iconMutedMapping : iconDisabledMapping}
              />
            )}
          </ToolbarButton>
          <ToolbarButton
            onPress={handleTogglePersonaSidebar}
            selected={personaSettings.hidePersonaSidebar}
            label={t("personaEmbed.toolbar.toggleSidebar")}
            testID="persona-toolbar-toggle-sidebar"
          >
            <ThemedPanelLeft
              size={15}
              uniProps={personaSettings.hidePersonaSidebar ? iconActiveMapping : iconMutedMapping}
            />
          </ToolbarButton>
        </View>

        <View style={styles.addressChip}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.addressText}>
            {normalizedHub.ok
              ? normalizedHub.displayHost
              : t("personaEmbed.sidebar.subtitleUnconfigured")}
          </Text>
        </View>

        <View style={styles.toolbarGroup}>
          {currentSessionRoute ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onPress={handleToolbarOpenAgent}
                accessibilityLabel={t("personaEmbed.guest.openInPaseoTooltip")}
                testID="persona-toolbar-open-in-paseo"
              >
                <ThemedOpenInPaseo size={13} uniProps={iconActiveMapping} />
                <Text style={styles.pillButtonText}>{t("personaEmbed.toolbar.openInPaseo")}</Text>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onPress={handleToolbarOpenDiff}
                accessibilityLabel={t("personaEmbed.guest.openDiffTooltip")}
                testID="persona-toolbar-open-diff"
              >
                <ThemedDiff size={13} uniProps={iconMutedMapping} />
                <Text style={styles.pillButtonText}>{t("personaEmbed.toolbar.openDiff")}</Text>
              </Button>
            </>
          ) : null}
          <ToolbarButton
            onPress={handleOpenExternal}
            disabled={!validHubUrl}
            label={t("personaEmbed.toolbar.openExternal")}
            testID="persona-toolbar-open-external"
          >
            <ThemedExternalLink
              size={15}
              uniProps={validHubUrl ? iconMutedMapping : iconDisabledMapping}
            />
          </ToolbarButton>
          <ToolbarButton
            onPress={handleOpenSettings}
            label={t("personaEmbed.toolbar.settings")}
            testID="persona-toolbar-settings"
          >
            <ThemedSettings size={15} uniProps={iconMutedMapping} />
          </ToolbarButton>
        </View>
      </View>

      <View ref={anchorRef} style={styles.webviewAnchor} testID="persona-webview-anchor">
        {overlayContent}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  disabledContainer: {
    flex: 1,
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  toolbarGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  addressChip: {
    flex: 1,
    maxWidth: 360,
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  addressText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
  },
  pillButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.code,
    fontWeight: theme.fontWeight.medium,
  },
  webviewAnchor: {
    flex: 1,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  overlayCard: {
    maxWidth: 460,
    width: "100%",
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[3],
  },
  overlayTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  overlayDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  overlayMeta: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.code,
  },
  overlayActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
