import { router } from "expo-router";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Columns2,
  Ellipsis,
  ExternalLink,
  GitCommitHorizontal,
  Home,
  PanelLeft,
  RotateCw,
  Settings,
  X,
} from "lucide-react-native";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, type DesktopPersonaOpenSessionEvent } from "@/desktop/host";
import { getOverlayRoot, WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { createAppOpenPersonaSessionDeps, openPersonaSession } from "./open-persona-session";
import {
  disableResidentPersonaWebview,
  ensureResidentPersonaWebview,
  findResidentPersonaEntryByWebContentsId,
  getResidentPersonaWebview,
  listResidentPersonaHubIds,
  lookupPersonaGuestSessionMetadata,
  parkResidentPersonaWebview,
  presentResidentPersonaWebview,
  readResidentPersonaWebviewContentsId,
  reconcileResidentPersonaWebviews,
  sendPersonaGuestAllowOnce,
  sendPersonaGuestConfig,
  sendPersonaGuestRouteSync,
  setResidentPersonaWebviewsInteractive,
  syncPersonaHubEntriesWithMain,
  type PersonaElectronWebviewElement,
  type PersonaGuestConfigMessage,
} from "./resident-persona-webview.electron";
import {
  clampPersonaSplitRatio,
  closePersonaSplitPane,
  collectValidPersonaHubPartitionEntries,
  DEFAULT_PERSONA_SPLIT_RATIO,
  formatPersonaHubDisplayHost,
  getActivePersonaHub,
  getPersonaHubById,
  getSecondaryPersonaHub,
  normalizePersonaHubUrl,
  parsePersonaEmbedSessionRoute,
  resolvePersonaHubPartition,
  selectActivePersonaHub,
  selectSecondaryPersonaHub,
  swapPersonaSplitPanes,
  togglePersonaSplitMode,
  validatePersonaGuestOpenSessionPayload,
  validatePersonaGuestReadyPayload,
  type PersonaHubPartitionEntry,
  type PersonaHubProfile,
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
const ThemedColumns = withUnistyles(Columns2);
const ThemedSwap = withUnistyles(ArrowLeftRight);
const ThemedClose = withUnistyles(X);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedSettings = withUnistyles(Settings);
const ThemedOpenInPaseo = withUnistyles(ArrowUpRight);
const ThemedDiff = withUnistyles(GitCommitHorizontal);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCheck = withUnistyles(Check);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const iconMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const iconActiveMapping = (theme: Theme) => ({ color: theme.colors.accent });
const iconDisabledMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const activeCheckIcon = <ThemedCheck size={13} uniProps={iconActiveMapping} />;
const mutedSettingsIcon = <ThemedSettings size={13} uniProps={iconMutedMapping} />;
const mutedHomeIcon = <ThemedHome size={13} uniProps={iconMutedMapping} />;
const mutedBackIcon = <ThemedArrowLeft size={13} uniProps={iconMutedMapping} />;
const mutedForwardIcon = <ThemedArrowRight size={13} uniProps={iconMutedMapping} />;
const mutedExternalIcon = <ThemedExternalLink size={13} uniProps={iconMutedMapping} />;
const activeOpenInPaseoIcon = <ThemedOpenInPaseo size={13} uniProps={iconActiveMapping} />;
const mutedDiffIcon = <ThemedDiff size={13} uniProps={iconMutedMapping} />;

const DIVIDER_HIT_HALF = 5;
const DIVIDER_HIT_WIDTH = DIVIDER_HIT_HALF * 2 + 1;
const DIVIDER_OVERLAY_Z_INDEX = WEB_SURFACE_PLANE.browser + 1;
const DRAG_SHIELD_OVERLAY_Z_INDEX = DIVIDER_OVERLAY_Z_INDEX + 1;
const NARROW_PANE_TOOLBAR_WIDTH = 360;
const MEDIUM_PANE_TOOLBAR_WIDTH = 520;
const ADDRESS_CHIP_MIN_PANE_WIDTH = 480;

const DIVIDER_HAIRLINE_WRAP_STYLE: CSSProperties = {
  pointerEvents: "none",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const DRAG_SHIELD_PORTAL_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  cursor: "col-resize",
  pointerEvents: "auto",
  zIndex: DRAG_SHIELD_OVERLAY_Z_INDEX,
};

export const MIN_PERSONA_SPLIT_SURFACE_WIDTH = 900;
const ERR_ABORTED = -3;
const KEYBOARD_SPLIT_STEP = 0.05;

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

interface LoadErrorState {
  code: number;
  description: string;
  url: string;
}

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

function buildGuestConfigForHub(input: {
  hubUrl: string;
  hidePersonaSidebar: boolean;
  interceptSessionClicks: boolean;
  labels: PersonaGuestConfigMessage["labels"];
}): PersonaGuestConfigMessage | null {
  const normalized = normalizePersonaHubUrl(input.hubUrl);
  if (!normalized.ok) {
    return null;
  }
  return {
    hubOrigin: normalized.origin,
    hubBasePath: normalized.basePath,
    hidePersonaSidebar: input.hidePersonaSidebar,
    interceptSessionClicks: input.interceptSessionClicks,
    labels: input.labels,
  };
}

function readPositiveWebContentsIdFromPayload(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = (raw as Record<string, unknown>).guestWebContentsId;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

interface PersonaPaneOverlayProps {
  slot: "primary" | "secondary";
  validHubUrl: string | null;
  mountRejected: boolean;
  loadError: LoadErrorState | null;
  onReload: () => void;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}

const PersonaPaneOverlay = memo(function PersonaPaneOverlay({
  slot,
  validHubUrl,
  mountRejected,
  loadError,
  onReload,
  onOpenExternal,
  onOpenSettings,
}: PersonaPaneOverlayProps): ReactElement | null {
  const { t } = useTranslation();
  const suffix = slot === "primary" ? "" : "-secondary";

  if (!validHubUrl) {
    return (
      <View style={styles.overlayCard} testID={`persona-invalid-url-state${suffix}`}>
        <Text style={styles.overlayTitle}>{t("personaEmbed.error.loadFailedTitle")}</Text>
        <Text style={styles.overlayDescription}>{t("personaEmbed.error.invalidUrl")}</Text>
        <View style={styles.overlayActions}>
          <Button onPress={onOpenSettings}>{t("personaEmbed.toolbar.settings")}</Button>
        </View>
      </View>
    );
  }
  if (mountRejected) {
    return (
      <View style={styles.overlayCard} testID={`persona-mount-rejected-state${suffix}`}>
        <Text style={styles.overlayTitle}>{t("personaEmbed.error.loadFailedTitle")}</Text>
        <Text style={styles.overlayDescription}>{t("personaEmbed.error.mountRejected")}</Text>
        <View style={styles.overlayActions}>
          <Button onPress={onReload}>{t("personaEmbed.error.retry")}</Button>
          <Button variant="ghost" onPress={onOpenSettings}>
            {t("personaEmbed.toolbar.settings")}
          </Button>
        </View>
      </View>
    );
  }
  if (!loadError) {
    return null;
  }
  return (
    <View style={styles.overlayCard} testID={`persona-load-error-state${suffix}`}>
      <Text style={styles.overlayTitle}>{t("personaEmbed.error.loadFailedTitle")}</Text>
      <Text style={styles.overlayDescription}>
        {t("personaEmbed.error.loadFailedDetail", {
          url: loadError.url || validHubUrl,
        })}
      </Text>
      <Text style={styles.overlayMeta}>
        {loadError.description} ({loadError.code})
      </Text>
      <View style={styles.overlayActions}>
        <Button onPress={onReload}>{t("personaEmbed.error.retry")}</Button>
        <Button variant="outline" onPress={onOpenExternal}>
          {t("personaEmbed.toolbar.openExternal")}
        </Button>
        <Button variant="ghost" onPress={onOpenSettings}>
          {t("personaEmbed.toolbar.settings")}
        </Button>
      </View>
    </View>
  );
});

interface PersonaPaneHubSwitcherProps {
  slot: "primary" | "secondary";
  hub: PersonaHubProfile | null;
  allHubs: readonly PersonaHubProfile[];
  otherPaneHubId: string | null;
  narrow?: boolean;
  onSelectHub: (hubId: string) => void;
  onOpenSettings: () => void;
}

const PersonaPaneHubSwitcherItem = memo(function PersonaPaneHubSwitcherItem({
  slot,
  candidate,
  isCurrent,
  isInOtherPane,
  onSelectHub,
}: {
  slot: "primary" | "secondary";
  candidate: PersonaHubProfile;
  isCurrent: boolean;
  isInOtherPane: boolean;
  onSelectHub: (hubId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const hostLabel = useMemo(
    () => formatPersonaHubDisplayHost(candidate.hubUrl),
    [candidate.hubUrl],
  );
  const handleSelect = useCallback(() => {
    onSelectHub(candidate.id);
  }, [candidate.id, onSelectHub]);
  const detailSuffix = isInOtherPane ? ` · ${t("personaEmbed.toolbar.inOtherPane")}` : "";
  return (
    <DropdownMenuItem
      leading={isCurrent ? activeCheckIcon : undefined}
      onSelect={handleSelect}
      testID={`persona-pane-${slot}-hub-option-${candidate.id}`}
    >
      {hostLabel ? `${candidate.name} (${hostLabel})${detailSuffix}` : candidate.name}
    </DropdownMenuItem>
  );
});

const PersonaPaneHubSwitcher = memo(function PersonaPaneHubSwitcher({
  slot,
  hub,
  allHubs,
  otherPaneHubId,
  narrow = false,
  onSelectHub,
  onOpenSettings,
}: PersonaPaneHubSwitcherProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const label = hub?.name ?? t("personaEmbed.sidebar.subtitleUnconfigured");

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={t("personaEmbed.toolbar.switchHub")}
        style={[styles.hubSwitcherTrigger, narrow && styles.hubSwitcherTriggerNarrow]}
        testID={`persona-pane-${slot}-hub-switcher`}
      >
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.hubSwitcherText}>
          {label}
        </Text>
        <ThemedChevronDown size={13} uniProps={iconMutedMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {allHubs.map((candidate) => (
          <PersonaPaneHubSwitcherItem
            key={candidate.id}
            slot={slot}
            candidate={candidate}
            isCurrent={candidate.id === hub?.id}
            isInOtherPane={candidate.id === otherPaneHubId}
            onSelectHub={onSelectHub}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={mutedSettingsIcon}
          onSelect={onOpenSettings}
          testID={`persona-pane-${slot}-manage-hubs`}
        >
          {t("personaEmbed.toolbar.manageHubs")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

interface PersonaPaneOverflowMenuProps {
  slot: "primary" | "secondary";
  isPrimary: boolean;
  includeNavAndSecondary: boolean;
  includeSessionActions: boolean;
  hasValidUrl: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoHome: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onToolbarOpenAgent: () => void;
  onToolbarOpenDiff: () => void;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}

const PersonaPaneOverflowMenu = memo(function PersonaPaneOverflowMenu({
  slot,
  isPrimary,
  includeNavAndSecondary,
  includeSessionActions,
  hasValidUrl,
  canGoBack,
  canGoForward,
  onGoHome,
  onGoBack,
  onGoForward,
  onToolbarOpenAgent,
  onToolbarOpenDiff,
  onOpenExternal,
  onOpenSettings,
}: PersonaPaneOverflowMenuProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ToolbarButton
        kind="menu"
        label={t("personaEmbed.toolbar.moreActions")}
        testID={`persona-pane-${slot}-more-actions`}
      >
        <ThemedEllipsis size={14} uniProps={iconMutedMapping} />
      </ToolbarButton>
      <DropdownMenuContent align="end">
        {includeSessionActions ? (
          <>
            <DropdownMenuItem
              leading={activeOpenInPaseoIcon}
              onSelect={onToolbarOpenAgent}
              testID={`persona-pane-${slot}-more-open-in-paseo`}
            >
              {t("personaEmbed.toolbar.openInPaseo")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={mutedDiffIcon}
              onSelect={onToolbarOpenDiff}
              testID={`persona-pane-${slot}-more-open-diff`}
            >
              {t("personaEmbed.toolbar.openDiff")}
            </DropdownMenuItem>
            {includeNavAndSecondary ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {includeNavAndSecondary ? (
          <>
            <DropdownMenuItem
              leading={mutedHomeIcon}
              disabled={!hasValidUrl}
              onSelect={onGoHome}
              testID={`persona-pane-${slot}-more-home`}
            >
              {t("personaEmbed.toolbar.home")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={mutedBackIcon}
              disabled={!canGoBack}
              onSelect={onGoBack}
              testID={`persona-pane-${slot}-more-back`}
            >
              {t("personaEmbed.toolbar.back")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={mutedForwardIcon}
              disabled={!canGoForward}
              onSelect={onGoForward}
              testID={`persona-pane-${slot}-more-forward`}
            >
              {t("personaEmbed.toolbar.forward")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              leading={mutedExternalIcon}
              disabled={!hasValidUrl}
              onSelect={onOpenExternal}
              testID={`persona-pane-${slot}-more-open-external`}
            >
              {t("personaEmbed.toolbar.openExternal")}
            </DropdownMenuItem>
            {isPrimary ? (
              <DropdownMenuItem
                leading={mutedSettingsIcon}
                onSelect={onOpenSettings}
                testID={`persona-pane-${slot}-more-settings`}
              >
                {t("personaEmbed.toolbar.settings")}
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

interface PersonaPaneToolbarProps {
  slot: "primary" | "secondary";
  hub: PersonaHubProfile | null;
  allHubs: readonly PersonaHubProfile[];
  otherPaneHubId: string | null;
  displayHost: string | null;
  paneWidth: number;
  hasValidUrl: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isSplitActive: boolean;
  canEnableSplit: boolean;
  splitBlockedNarrow: boolean;
  hidePersonaSidebarPreference: boolean;
  hasCurrentSessionRoute: boolean;
  onSelectHub: (hubId: string) => void;
  onGoHome: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onTogglePersonaSidebar: () => void;
  onToolbarOpenAgent: () => void;
  onToolbarOpenDiff: () => void;
  onToggleSplit: () => void;
  onSwapPanes: () => void;
  onCloseThisPane: () => void;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}

const PersonaPaneSessionActions = memo(function PersonaPaneSessionActions({
  isPrimary,
  visible,
  onOpenAgent,
  onOpenDiff,
}: {
  isPrimary: boolean;
  visible: boolean;
  onOpenAgent: () => void;
  onOpenDiff: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onPress={onOpenAgent}
        accessibilityLabel={t("personaEmbed.guest.openInPaseoTooltip")}
        testID={
          isPrimary ? "persona-toolbar-open-in-paseo" : "persona-pane-secondary-open-in-paseo"
        }
      >
        <ThemedOpenInPaseo size={13} uniProps={iconActiveMapping} />
        <Text style={styles.pillButtonText}>{t("personaEmbed.toolbar.openInPaseo")}</Text>
      </Button>
      <Button
        size="sm"
        variant="outline"
        onPress={onOpenDiff}
        accessibilityLabel={t("personaEmbed.guest.openDiffTooltip")}
        testID={isPrimary ? "persona-toolbar-open-diff" : "persona-pane-secondary-open-diff"}
      >
        <ThemedDiff size={13} uniProps={iconMutedMapping} />
        <Text style={styles.pillButtonText}>{t("personaEmbed.toolbar.openDiff")}</Text>
      </Button>
    </>
  );
});

const PersonaPaneSplitControls = memo(function PersonaPaneSplitControls({
  slot,
  hubCount,
  isSplitActive,
  canEnableSplit,
  splitBlockedNarrow,
  onToggleSplit,
  onSwapPanes,
  onCloseThisPane,
}: {
  slot: "primary" | "secondary";
  hubCount: number;
  isSplitActive: boolean;
  canEnableSplit: boolean;
  splitBlockedNarrow: boolean;
  onToggleSplit: () => void;
  onSwapPanes: () => void;
  onCloseThisPane: () => void;
}): ReactElement {
  const { t } = useTranslation();
  if (isSplitActive) {
    return (
      <>
        <ToolbarButton
          onPress={onSwapPanes}
          label={t("personaEmbed.toolbar.swapPanes")}
          testID={`persona-pane-${slot}-swap`}
        >
          <ThemedSwap size={14} uniProps={iconMutedMapping} />
        </ToolbarButton>
        <ToolbarButton
          onPress={onCloseThisPane}
          label={t("personaEmbed.toolbar.closeSplitPane")}
          testID={`persona-pane-${slot}-close-split`}
        >
          <ThemedClose size={14} uniProps={iconMutedMapping} />
        </ToolbarButton>
      </>
    );
  }

  let splitToggleLabel: string;
  if (hubCount < 2) {
    splitToggleLabel = t("personaEmbed.toolbar.splitNeedsTwoHubs");
  } else if (splitBlockedNarrow) {
    splitToggleLabel = t("personaEmbed.toolbar.splitUnavailableNarrow");
  } else {
    splitToggleLabel = t("personaEmbed.toolbar.enableSplit");
  }

  const splitToggleIconMapping = canEnableSplit ? iconMutedMapping : iconDisabledMapping;

  return (
    <ToolbarButton
      onPress={onToggleSplit}
      disabled={!canEnableSplit}
      selected={false}
      label={splitToggleLabel}
      testID="persona-toolbar-toggle-split"
    >
      <ThemedColumns size={14} uniProps={splitToggleIconMapping} />
    </ToolbarButton>
  );
});

const PersonaPaneNavButtons = memo(function PersonaPaneNavButtons({
  testIdPrefix,
  hasValidUrl,
  canGoBack,
  canGoForward,
  isLoading,
  isSplitActive,
  hidePersonaSidebarPreference,
  onGoHome,
  onGoBack,
  onGoForward,
  onReload,
  onTogglePersonaSidebar,
}: {
  testIdPrefix: string;
  hasValidUrl: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isSplitActive: boolean;
  hidePersonaSidebarPreference: boolean;
  onGoHome: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
  onTogglePersonaSidebar: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const urlActionIconMapping = hasValidUrl ? iconMutedMapping : iconDisabledMapping;
  return (
    <>
      <ToolbarButton
        onPress={onGoHome}
        disabled={!hasValidUrl}
        label={t("personaEmbed.toolbar.home")}
        testID={`${testIdPrefix}-home`}
      >
        <ThemedHome size={14} uniProps={urlActionIconMapping} />
      </ToolbarButton>
      <ToolbarButton
        onPress={onGoBack}
        disabled={!canGoBack}
        label={t("personaEmbed.toolbar.back")}
        testID={`${testIdPrefix}-back`}
      >
        <ThemedArrowLeft size={14} uniProps={canGoBack ? iconMutedMapping : iconDisabledMapping} />
      </ToolbarButton>
      <ToolbarButton
        onPress={onGoForward}
        disabled={!canGoForward}
        label={t("personaEmbed.toolbar.forward")}
        testID={`${testIdPrefix}-forward`}
      >
        <ThemedArrowRight
          size={14}
          uniProps={canGoForward ? iconMutedMapping : iconDisabledMapping}
        />
      </ToolbarButton>
      <ToolbarButton
        onPress={onReload}
        disabled={!hasValidUrl}
        label={t("personaEmbed.toolbar.reload")}
        testID={`${testIdPrefix}-reload`}
      >
        {isLoading ? (
          <ThemedSpinner size="small" />
        ) : (
          <ThemedRotateCw size={14} uniProps={urlActionIconMapping} />
        )}
      </ToolbarButton>
      {!isSplitActive ? (
        <ToolbarButton
          onPress={onTogglePersonaSidebar}
          selected={hidePersonaSidebarPreference}
          label={t("personaEmbed.toolbar.toggleSidebar")}
          testID="persona-toolbar-toggle-sidebar"
        >
          <ThemedPanelLeft
            size={14}
            uniProps={hidePersonaSidebarPreference ? iconActiveMapping : iconMutedMapping}
          />
        </ToolbarButton>
      ) : null}
    </>
  );
});

const PersonaPaneTrailingButtons = memo(function PersonaPaneTrailingButtons({
  isPrimary,
  testIdPrefix,
  hasValidUrl,
  onOpenExternal,
  onOpenSettings,
}: {
  isPrimary: boolean;
  testIdPrefix: string;
  hasValidUrl: boolean;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const urlActionIconMapping = hasValidUrl ? iconMutedMapping : iconDisabledMapping;
  return (
    <>
      <ToolbarButton
        onPress={onOpenExternal}
        disabled={!hasValidUrl}
        label={t("personaEmbed.toolbar.openExternal")}
        testID={`${testIdPrefix}-open-external`}
      >
        <ThemedExternalLink size={14} uniProps={urlActionIconMapping} />
      </ToolbarButton>
      {isPrimary ? (
        <ToolbarButton
          onPress={onOpenSettings}
          label={t("personaEmbed.toolbar.settings")}
          testID="persona-toolbar-settings"
        >
          <ThemedSettings size={14} uniProps={iconMutedMapping} />
        </ToolbarButton>
      ) : null}
    </>
  );
});

function computePersonaPaneToolbarLayout({
  paneWidth,
  hasCurrentSessionRoute,
  allHubsCount,
  isSplitActive,
}: {
  paneWidth: number;
  hasCurrentSessionRoute: boolean;
  allHubsCount: number;
  isSplitActive: boolean;
}) {
  const isTightPane = paneWidth > 0 && paneWidth < NARROW_PANE_TOOLBAR_WIDTH;
  const collapseSessionActions =
    isTightPane || (paneWidth > 0 && paneWidth < MEDIUM_PANE_TOOLBAR_WIDTH);
  const minAddressWidth = hasCurrentSessionRoute
    ? MEDIUM_PANE_TOOLBAR_WIDTH
    : ADDRESS_CHIP_MIN_PANE_WIDTH;
  const showAddressChip = !isTightPane && (paneWidth === 0 || paneWidth >= minAddressWidth);
  const showOverflowMenu = isTightPane || (collapseSessionActions && hasCurrentSessionRoute);
  const showHubSwitcher = allHubsCount > 1 || isSplitActive;
  return {
    isTightPane,
    collapseSessionActions,
    showAddressChip,
    showOverflowMenu,
    showHubSwitcher,
  };
}

const PersonaPaneToolbar = memo(function PersonaPaneToolbar({
  slot,
  hub,
  allHubs,
  otherPaneHubId,
  displayHost,
  paneWidth,
  hasValidUrl,
  canGoBack,
  canGoForward,
  isLoading,
  isSplitActive,
  canEnableSplit,
  splitBlockedNarrow,
  hidePersonaSidebarPreference,
  hasCurrentSessionRoute,
  onSelectHub,
  onGoHome,
  onGoBack,
  onGoForward,
  onReload,
  onTogglePersonaSidebar,
  onToolbarOpenAgent,
  onToolbarOpenDiff,
  onToggleSplit,
  onSwapPanes,
  onCloseThisPane,
  onOpenExternal,
  onOpenSettings,
}: PersonaPaneToolbarProps): ReactElement {
  const { t } = useTranslation();
  const isPrimary = slot === "primary";
  const testIdPrefix = isPrimary ? "persona-toolbar" : "persona-pane-secondary";
  const urlActionIconMapping = hasValidUrl ? iconMutedMapping : iconDisabledMapping;
  const {
    isTightPane,
    collapseSessionActions,
    showAddressChip,
    showOverflowMenu,
    showHubSwitcher,
  } = computePersonaPaneToolbarLayout({
    paneWidth,
    hasCurrentSessionRoute,
    allHubsCount: allHubs.length,
    isSplitActive,
  });

  return (
    <View
      style={[
        styles.toolbar,
        isSplitActive && styles.toolbarCompact,
        isTightPane && styles.toolbarTight,
      ]}
      testID={`persona-pane-${slot}-toolbar`}
    >
      <View style={styles.toolbarLeftGroup}>
        {showHubSwitcher ? (
          <PersonaPaneHubSwitcher
            slot={slot}
            hub={hub}
            allHubs={allHubs}
            otherPaneHubId={otherPaneHubId}
            narrow={isTightPane}
            onSelectHub={onSelectHub}
            onOpenSettings={onOpenSettings}
          />
        ) : null}
        {!isTightPane ? (
          <PersonaPaneNavButtons
            testIdPrefix={testIdPrefix}
            hasValidUrl={hasValidUrl}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            isLoading={isLoading}
            isSplitActive={isSplitActive}
            hidePersonaSidebarPreference={hidePersonaSidebarPreference}
            onGoHome={onGoHome}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
            onReload={onReload}
            onTogglePersonaSidebar={onTogglePersonaSidebar}
          />
        ) : null}
      </View>

      {showAddressChip ? (
        <View style={[styles.addressChip, isSplitActive && styles.addressChipCompact]}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.addressText}>
            {displayHost ?? t("personaEmbed.sidebar.subtitleUnconfigured")}
          </Text>
        </View>
      ) : null}

      <View style={[styles.toolbarGroup, isTightPane && styles.toolbarGroupTight]}>
        {isTightPane ? (
          <ToolbarButton
            onPress={onReload}
            disabled={!hasValidUrl}
            label={t("personaEmbed.toolbar.reload")}
            testID={`${testIdPrefix}-reload`}
          >
            {isLoading ? (
              <ThemedSpinner size="small" />
            ) : (
              <ThemedRotateCw size={14} uniProps={urlActionIconMapping} />
            )}
          </ToolbarButton>
        ) : null}

        <PersonaPaneSessionActions
          isPrimary={isPrimary}
          visible={hasCurrentSessionRoute && !collapseSessionActions}
          onOpenAgent={onToolbarOpenAgent}
          onOpenDiff={onToolbarOpenDiff}
        />

        <PersonaPaneSplitControls
          slot={slot}
          hubCount={allHubs.length}
          isSplitActive={isSplitActive}
          canEnableSplit={canEnableSplit}
          splitBlockedNarrow={splitBlockedNarrow}
          onToggleSplit={onToggleSplit}
          onSwapPanes={onSwapPanes}
          onCloseThisPane={onCloseThisPane}
        />

        {!isTightPane ? (
          <PersonaPaneTrailingButtons
            isPrimary={isPrimary}
            testIdPrefix={testIdPrefix}
            hasValidUrl={hasValidUrl}
            onOpenExternal={onOpenExternal}
            onOpenSettings={onOpenSettings}
          />
        ) : null}

        {showOverflowMenu ? (
          <PersonaPaneOverflowMenu
            slot={slot}
            isPrimary={isPrimary}
            includeNavAndSecondary={isTightPane}
            includeSessionActions={hasCurrentSessionRoute && collapseSessionActions}
            hasValidUrl={hasValidUrl}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onGoHome={onGoHome}
            onGoBack={onGoBack}
            onGoForward={onGoForward}
            onToolbarOpenAgent={onToolbarOpenAgent}
            onToolbarOpenDiff={onToolbarOpenDiff}
            onOpenExternal={onOpenExternal}
            onOpenSettings={onOpenSettings}
          />
        ) : null}
      </View>
    </View>
  );
});

interface PersonaPaneProps {
  slot: "primary" | "secondary";
  hub: PersonaHubProfile | null;
  allHubs: readonly PersonaHubProfile[];
  otherPaneHubId: string | null;
  estimatedPaneWidth: number;
  isSplitActive: boolean;
  canEnableSplit: boolean;
  splitBlockedNarrow: boolean;
  effectiveHidePersonaSidebar: boolean;
  hidePersonaSidebarPreference: boolean;
  interceptSessionClicks: boolean;
  guestLabels: PersonaGuestConfigMessage["labels"];
  allowedHubEntries: readonly PersonaHubPartitionEntry[];
  layoutRevision: number;
  paneStyle?: StyleProp<ViewStyle>;
  onSelectHub: (hubId: string) => void;
  onToggleSplit: () => void;
  onSwapPanes: () => void;
  onCloseSplit: (closingSlot: "primary" | "secondary") => void;
  onTogglePersonaSidebar: () => void;
  onOpenSession: (hubId: string, payload: DesktopPersonaOpenSessionEvent) => void;
  onOpenSettings: () => void;
}

const PersonaPane = memo(function PersonaPane({
  slot,
  hub,
  allHubs,
  otherPaneHubId,
  estimatedPaneWidth,
  isSplitActive,
  canEnableSplit,
  splitBlockedNarrow,
  effectiveHidePersonaSidebar,
  hidePersonaSidebarPreference,
  interceptSessionClicks,
  guestLabels,
  allowedHubEntries,
  layoutRevision,
  paneStyle,
  onSelectHub,
  onToggleSplit,
  onSwapPanes,
  onCloseSplit,
  onTogglePersonaSidebar,
  onOpenSession,
  onOpenSettings,
}: PersonaPaneProps): ReactElement {
  const isPrimary = slot === "primary";

  const hubId = hub?.id ?? "";
  const normalizedHub = useMemo(() => normalizePersonaHubUrl(hub?.hubUrl ?? ""), [hub?.hubUrl]);
  const validHubUrl = normalizedHub.ok ? normalizedHub.url : null;
  const authorizedHubOrigin = normalizedHub.ok ? normalizedHub.origin : null;
  const canMountWebview = Boolean(hubId) && validHubUrl !== null;

  const paneRef = useRef<View | null>(null);
  const anchorRef = useRef<View | null>(null);
  const [measuredPaneWidth, setMeasuredPaneWidth] = useState<number>(0);
  const effectivePaneWidth = measuredPaneWidth > 0 ? measuredPaneWidth : estimatedPaneWidth;
  const [webviewNode, setWebviewNode] = useState<PersonaElectronWebviewElement | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>(validHubUrl ?? "");
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<LoadErrorState | null>(null);
  const [mountRejected, setMountRejected] = useState(false);

  const guestConfig = useMemo<PersonaGuestConfigMessage | null>(() => {
    if (!validHubUrl) {
      return null;
    }
    return buildGuestConfigForHub({
      hubUrl: validHubUrl,
      hidePersonaSidebar: effectiveHidePersonaSidebar,
      interceptSessionClicks,
      labels: guestLabels,
    });
  }, [effectiveHidePersonaSidebar, guestLabels, interceptSessionClicks, validHubUrl]);

  const guestConfigRef = useRef(guestConfig);
  guestConfigRef.current = guestConfig;

  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;

  const allowedHubEntriesRef = useRef(allowedHubEntries);
  allowedHubEntriesRef.current = allowedHubEntries;

  const activeTargetKeyRef = useRef<string>("");
  activeTargetKeyRef.current = hubId && validHubUrl ? `${hubId}\0${validHubUrl}` : "";

  const applyMeasuredPaneWidth = useCallback((nextWidth: number) => {
    if (Number.isFinite(nextWidth) && nextWidth > 0) {
      setMeasuredPaneWidth((current) => (Math.abs(current - nextWidth) >= 1 ? nextWidth : current));
    }
  }, []);

  const handlePaneLayout = useCallback(
    (event: LayoutChangeEvent) => {
      applyMeasuredPaneWidth(event.nativeEvent.layout.width);
    },
    [applyMeasuredPaneWidth],
  );

  useLayoutEffect(() => {
    const element = paneRef.current as unknown as HTMLElement | null;
    if (!element) {
      return;
    }
    const measure = () => {
      if (typeof element.getBoundingClientRect === "function") {
        applyMeasuredPaneWidth(element.getBoundingClientRect().width);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entryWidth = entries[0]?.contentRect?.width;
      if (typeof entryWidth === "number" && entryWidth > 0) {
        applyMeasuredPaneWidth(entryWidth);
      } else {
        measure();
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [applyMeasuredPaneWidth, isSplitActive, layoutRevision]);

  const currentSessionRoute = useMemo(() => {
    if (!validHubUrl || !currentUrl) {
      return null;
    }
    return parsePersonaEmbedSessionRoute(currentUrl, validHubUrl);
  }, [currentUrl, validHubUrl]);

  const syncAnchorGeometry = useCallback(() => {
    if (!hubId) {
      return;
    }
    if (!canMountWebview || loadError || mountRejected) {
      parkResidentPersonaWebview(hubId);
      return;
    }
    const element = anchorRef.current as unknown as HTMLElement | null;
    if (!element || typeof element.getBoundingClientRect !== "function") {
      parkResidentPersonaWebview(hubId);
      return;
    }
    const rect = element.getBoundingClientRect();
    presentResidentPersonaWebview(hubId, rect);
  }, [canMountWebview, hubId, loadError, mountRejected]);

  // Acquire or reuse this Hub's resident <webview> from the keep-alive pool.
  useEffect(() => {
    let cancelled = false;
    if (!hubId || !validHubUrl) {
      if (hubId) {
        parkResidentPersonaWebview(hubId);
      }
      setWebviewNode(null);
      setLoadError(null);
      setMountRejected(false);
      setCurrentUrl("");
      setCanGoBack(false);
      setCanGoForward(false);
      setIsLoading(false);
      return;
    }

    setLoadError(null);
    setMountRejected(false);
    void (async () => {
      const webview = await ensureResidentPersonaWebview({
        hubId,
        hubUrl: validHubUrl,
        allowedHubEntries: allowedHubEntriesRef.current,
      });
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
        sendPersonaGuestConfig(hubId, guestConfigRef.current);
        sendPersonaGuestRouteSync(hubId, liveUrl);
      }
    })();

    return () => {
      cancelled = true;
      parkResidentPersonaWebview(hubId);
    };
  }, [authorizedHubOrigin, hubId, validHubUrl]);

  // Push guest config immediately when split compaction / sidebar toggle / language changes.
  useEffect(() => {
    if (!webviewNode || !guestConfig || !hubId || !canMountWebview) {
      return;
    }
    sendPersonaGuestConfig(hubId, guestConfig);
  }, [canMountWebview, guestConfig, hubId, webviewNode]);

  // Keep resident surface geometry locked to this pane's anchor across resize & split drags.
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
    };
  }, [isSplitActive, layoutRevision, syncAnchorGeometry, webviewNode]);

  // Bind Electron <webview> lifecycle listeners for this Hub.
  useEffect(() => {
    if (!webviewNode || !hubId || !validHubUrl || !authorizedHubOrigin || !canMountWebview) {
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
          sendPersonaGuestConfig(hubId, guestConfigRef.current);
        }
        sendPersonaGuestRouteSync(hubId, liveUrl);
      }
    };

    const onNavigate = (event: Event) => {
      const navEvent = event as WebviewNavigateEvent;
      if (navEvent.isMainFrame === false) {
        return;
      }
      const nextUrl = navEvent.url || readWebviewUrlSafely(webviewNode, "");
      if (nextUrl && isSameOriginUrl(nextUrl, authorizedHubOrigin)) {
        setCurrentUrl(nextUrl);
        setLoadError(null);
        sendPersonaGuestRouteSync(hubId, nextUrl);
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

    webviewNode.addEventListener("did-start-loading", onStartLoading);
    webviewNode.addEventListener("did-stop-loading", onStopLoading);
    webviewNode.addEventListener("dom-ready", onDomReady);
    webviewNode.addEventListener("did-navigate", onNavigate);
    webviewNode.addEventListener("did-navigate-in-page", onNavigate);
    webviewNode.addEventListener("did-fail-load", onFailLoad);

    return () => {
      webviewNode.removeEventListener("did-start-loading", onStartLoading);
      webviewNode.removeEventListener("did-stop-loading", onStopLoading);
      webviewNode.removeEventListener("dom-ready", onDomReady);
      webviewNode.removeEventListener("did-navigate", onNavigate);
      webviewNode.removeEventListener("did-navigate-in-page", onNavigate);
      webviewNode.removeEventListener("did-fail-load", onFailLoad);
    };
  }, [authorizedHubOrigin, canMountWebview, hubId, validHubUrl, webviewNode]);

  const handleGoHome = useCallback(() => {
    if (!canMountWebview || !validHubUrl || !hubId) return;
    setLoadError(null);
    const webview = getResidentPersonaWebview(hubId);
    if (webview?.loadURL) {
      void webview.loadURL(validHubUrl).catch(() => undefined);
    }
  }, [canMountWebview, hubId, validHubUrl]);

  const handleGoBack = useCallback(() => {
    if (!hubId) return;
    getResidentPersonaWebview(hubId)?.goBack?.();
  }, [hubId]);

  const handleGoForward = useCallback(() => {
    if (!hubId) return;
    getResidentPersonaWebview(hubId)?.goForward?.();
  }, [hubId]);

  const handleReload = useCallback(() => {
    if (!canMountWebview || !validHubUrl || !hubId) return;
    setLoadError(null);
    setMountRejected(false);
    const webview = getResidentPersonaWebview(hubId);
    if (!webview) {
      const targetKey = `${hubId}\0${validHubUrl}`;
      void (async () => {
        const next = await ensureResidentPersonaWebview({
          hubId,
          hubUrl: validHubUrl,
          allowedHubEntries: allowedHubEntriesRef.current,
        });
        if (activeTargetKeyRef.current !== targetKey) {
          return;
        }
        if (!next) {
          setMountRejected(true);
          return;
        }
        setWebviewNode(next);
      })();
      return;
    }
    webview.reload?.();
  }, [canMountWebview, hubId, validHubUrl]);

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

  const handleToolbarOpenSession = useCallback(
    (panel?: "diff") => {
      if (!currentSessionRoute || !hubId) return;
      onOpenSession(hubId, {
        machineId: currentSessionRoute.machineId,
        sessionId: currentSessionRoute.sessionId,
        panel,
        source: "header-button",
        rawHref: currentUrl,
      });
    },
    [currentSessionRoute, currentUrl, hubId, onOpenSession],
  );

  const handleToolbarOpenAgent = useCallback(() => {
    handleToolbarOpenSession(undefined);
  }, [handleToolbarOpenSession]);

  const handleToolbarOpenDiff = useCallback(() => {
    handleToolbarOpenSession("diff");
  }, [handleToolbarOpenSession]);

  const handleCloseThisPane = useCallback(() => {
    onCloseSplit(slot);
  }, [onCloseSplit, slot]);

  const webviewAnchorStyle = useMemo(() => {
    if (!isSplitActive) {
      return [styles.webviewAnchor, null];
    }
    return [
      styles.webviewAnchor,
      isPrimary ? styles.webviewAnchorSplitPrimary : styles.webviewAnchorSplitSecondary,
    ];
  }, [isPrimary, isSplitActive]);

  return (
    <View
      ref={paneRef}
      onLayout={handlePaneLayout}
      style={[styles.paneContainer, paneStyle]}
      testID={`persona-pane-${slot}`}
    >
      <PersonaPaneToolbar
        slot={slot}
        hub={hub}
        allHubs={allHubs}
        otherPaneHubId={otherPaneHubId}
        displayHost={normalizedHub.ok ? normalizedHub.displayHost : null}
        paneWidth={effectivePaneWidth}
        hasValidUrl={validHubUrl !== null}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isLoading}
        isSplitActive={isSplitActive}
        canEnableSplit={canEnableSplit}
        splitBlockedNarrow={splitBlockedNarrow}
        hidePersonaSidebarPreference={hidePersonaSidebarPreference}
        hasCurrentSessionRoute={currentSessionRoute !== null}
        onSelectHub={onSelectHub}
        onGoHome={handleGoHome}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onTogglePersonaSidebar={onTogglePersonaSidebar}
        onToolbarOpenAgent={handleToolbarOpenAgent}
        onToolbarOpenDiff={handleToolbarOpenDiff}
        onToggleSplit={onToggleSplit}
        onSwapPanes={onSwapPanes}
        onCloseThisPane={handleCloseThisPane}
        onOpenExternal={handleOpenExternal}
        onOpenSettings={onOpenSettings}
      />

      <View
        ref={anchorRef}
        style={webviewAnchorStyle}
        testID={isPrimary ? "persona-webview-anchor" : "persona-pane-secondary-webview-anchor"}
      >
        <PersonaPaneOverlay
          slot={slot}
          validHubUrl={validHubUrl}
          mountRejected={mountRejected}
          loadError={loadError}
          onReload={handleReload}
          onOpenExternal={handleOpenExternal}
          onOpenSettings={onOpenSettings}
        />
      </View>
    </View>
  );
});

interface DividerPortalBounds {
  left: number;
  top: number;
  height: number;
}

interface PersonaSplitDividerProps {
  ratio: number;
  isDragging: boolean;
  layoutRevision: number;
  containerRef: React.RefObject<View | null>;
  onDragStart: () => void;
  onDragRatioChange: (nextRatio: number) => void;
  onDragEnd: (finalRatio: number) => void;
  onCommitRatio: (nextRatio: number) => void;
}

const PersonaSplitDivider = memo(function PersonaSplitDivider({
  ratio,
  isDragging,
  layoutRevision,
  containerRef,
  onDragStart,
  onDragRatioChange,
  onDragEnd,
  onCommitRatio,
}: PersonaSplitDividerProps): ReactElement {
  const { t } = useTranslation();
  const railRef = useRef<View | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [portalBounds, setPortalBounds] = useState<DividerPortalBounds | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const latestRatioRef = useRef(ratio);
  latestRatioRef.current = ratio;

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const railEl = railRef.current as unknown as HTMLElement | null;
    const containerEl = containerRef.current as unknown as HTMLElement | null;
    if (!railEl || typeof railEl.getBoundingClientRect !== "function") {
      setPortalBounds(null);
      return;
    }

    const syncBounds = () => {
      const rect = railEl.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) {
        setPortalBounds(null);
        return;
      }
      const next: DividerPortalBounds = {
        left: Math.round(rect.left) - DIVIDER_HIT_HALF,
        top: Math.round(rect.top),
        height: Math.round(rect.height),
      };
      setPortalBounds((current) =>
        current &&
        current.left === next.left &&
        current.top === next.top &&
        current.height === next.height
          ? current
          : next,
      );
    };

    syncBounds();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncBounds);
      resizeObserver.observe(railEl);
      if (containerEl) {
        resizeObserver.observe(containerEl);
      }
    }

    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
    };
  }, [containerRef, layoutRevision, ratio]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const containerEl = containerRef.current as unknown as HTMLElement | null;
      if (!containerEl || typeof containerEl.getBoundingClientRect !== "function") {
        return;
      }
      const rect = containerEl.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      cleanupRef.current?.();

      const targetEl = event.currentTarget;
      const pointerId = event.pointerId;
      try {
        targetEl.setPointerCapture?.(pointerId);
      } catch {
        // Synthetic pointer events in browser tests may not have an active hardware pointerId.
      }

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      let currentRatio = latestRatioRef.current;
      onDragStart();

      const handleMove = (moveEvent: PointerEvent) => {
        if (pointerId !== 0 && moveEvent.pointerId !== 0 && moveEvent.pointerId !== pointerId) {
          return;
        }
        moveEvent.preventDefault();
        const nextRatio = clampPersonaSplitRatio((moveEvent.clientX - rect.left) / rect.width);
        currentRatio = nextRatio;
        onDragRatioChange(nextRatio);
      };

      const finishDrag = () => {
        cleanupRef.current = null;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        window.removeEventListener("pointercancel", handleUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        try {
          if (targetEl.hasPointerCapture?.(pointerId)) {
            targetEl.releasePointerCapture(pointerId);
          }
        } catch {
          // Ignore if capture was already released.
        }
        onDragEnd(currentRatio);
      };

      const handleUp = (upEvent: PointerEvent) => {
        if (pointerId !== 0 && upEvent.pointerId !== 0 && upEvent.pointerId !== pointerId) {
          return;
        }
        finishDrag();
      };

      cleanupRef.current = finishDrag;
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
      window.addEventListener("pointercancel", handleUp);
    },
    [containerRef, onDragEnd, onDragRatioChange, onDragStart],
  );

  const handleDoubleClick = useCallback(() => {
    onCommitRatio(DEFAULT_PERSONA_SPLIT_RATIO);
  }, [onCommitRatio]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onCommitRatio(clampPersonaSplitRatio(latestRatioRef.current - KEYBOARD_SPLIT_STEP));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onCommitRatio(clampPersonaSplitRatio(latestRatioRef.current + KEYBOARD_SPLIT_STEP));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onCommitRatio(DEFAULT_PERSONA_SPLIT_RATIO);
      }
    },
    [onCommitRatio],
  );

  const highlighted = isHovered || isDragging;

  const portalStyle = useMemo<CSSProperties | null>(() => {
    if (!portalBounds) {
      return null;
    }
    return {
      position: "fixed",
      left: portalBounds.left,
      top: portalBounds.top,
      width: DIVIDER_HIT_WIDTH,
      height: portalBounds.height,
      cursor: "col-resize",
      touchAction: "none",
      pointerEvents: "auto",
      zIndex: DIVIDER_OVERLAY_Z_INDEX,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    };
  }, [portalBounds]);

  // Portal the interactive divider into `#overlay-root` (WEB_SURFACE_PLANE.overlay > browser)
  // so it always sits above the resident `<webview>` host plane regardless of RNW View stacking contexts.
  const overlayPortal =
    portalStyle && typeof document !== "undefined"
      ? createPortal(
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t("personaEmbed.toolbar.resizeSplitHandle")}
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(ratio * 100)}
            data-testid="persona-split-divider"
            onPointerDown={handlePointerDown}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleKeyDown}
            style={portalStyle}
          >
            <div style={DIVIDER_HAIRLINE_WRAP_STYLE}>
              <View style={[styles.dividerLine, highlighted && styles.dividerLineHighlighted]} />
            </div>
          </div>,
          getOverlayRoot(),
        )
      : null;

  return (
    <View ref={railRef} style={styles.dividerRail} testID="persona-split-divider-rail">
      {overlayPortal}
    </View>
  );
});

function computeEffectiveSplitLayout(input: {
  isCompact: boolean;
  surfaceWidth: number;
  hubsCount: number;
  splitEnabled: boolean;
  hasSecondaryHub: boolean;
}) {
  const splitBlockedNarrow =
    input.isCompact ||
    (input.surfaceWidth > 0 && input.surfaceWidth < MIN_PERSONA_SPLIT_SURFACE_WIDTH);
  const canEnableSplit = input.hubsCount >= 2 && !splitBlockedNarrow;
  const effectiveSplitActive =
    input.splitEnabled && input.hubsCount >= 2 && input.hasSecondaryHub && !splitBlockedNarrow;
  return { splitBlockedNarrow, canEnableSplit, effectiveSplitActive };
}

export function PersonaSurface() {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const { settings: personaSettings, isLoaded: settingsLoaded } = usePersonaEmbedSettingsState();
  const updatePersonaSettings = useUpdatePersonaEmbedSettings();

  const splitContainerRef = useRef<View | null>(null);
  const [surfaceWidth, setSurfaceWidth] = useState<number>(0);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const [previewSplitRatio, setPreviewSplitRatio] = useState<number | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);

  const personaSettingsRef = useRef(personaSettings);
  personaSettingsRef.current = personaSettings;

  const activeHub = useMemo(() => getActivePersonaHub(personaSettings), [personaSettings]);
  const secondaryHub = useMemo(() => getSecondaryPersonaHub(personaSettings), [personaSettings]);
  const allowedHubEntries = useMemo(() => {
    const desktopPersona = getDesktopHost()?.persona;
    const entries = collectValidPersonaHubPartitionEntries(personaSettings, {
      basePartition: desktopPersona?.partition,
      partitionPrefix: desktopPersona?.partitionPrefix,
    });
    if (!activeHub) {
      return entries;
    }
    const activePartition = resolvePersonaHubPartition(activeHub.id, {
      basePartition: desktopPersona?.partition,
      partitionPrefix: desktopPersona?.partitionPrefix,
    });
    const activeIndex = activePartition
      ? entries.findIndex((entry) => entry.partition === activePartition)
      : -1;
    if (activeIndex <= 0) {
      return entries;
    }
    return [
      entries[activeIndex],
      ...entries.slice(0, activeIndex),
      ...entries.slice(activeIndex + 1),
    ];
  }, [activeHub, personaSettings]);

  const { splitBlockedNarrow, canEnableSplit, effectiveSplitActive } = computeEffectiveSplitLayout({
    isCompact,
    surfaceWidth,
    hubsCount: personaSettings.hubs.length,
    splitEnabled: personaSettings.splitEnabled,
    hasSecondaryHub: secondaryHub !== null,
  });
  const effectiveRatio = previewSplitRatio ?? personaSettings.splitRatio;
  let primaryEstimatedPaneWidth = 0;
  if (surfaceWidth > 0) {
    primaryEstimatedPaneWidth = effectiveSplitActive
      ? Math.max(0, Math.floor((surfaceWidth - 1) * effectiveRatio))
      : surfaceWidth;
  }
  const secondaryEstimatedPaneWidth =
    surfaceWidth > 0 && effectiveSplitActive
      ? Math.max(0, Math.floor((surfaceWidth - 1) * (1 - effectiveRatio)))
      : 0;
  // Auto-compact Persona's internal left sidebar in split mode so both panes remain usable.
  const effectiveHidePersonaSidebar = effectiveSplitActive || personaSettings.hidePersonaSidebar;

  const effectiveHideSidebarRef = useRef(effectiveHidePersonaSidebar);
  effectiveHideSidebarRef.current = effectiveHidePersonaSidebar;

  const guestLabels = useMemo<PersonaGuestConfigMessage["labels"]>(
    () => ({
      openInPaseo: t("personaEmbed.guest.openInPaseo"),
      openDiffInPaseo: t("personaEmbed.guest.openDiffInPaseo"),
      openInPaseoTooltip: t("personaEmbed.guest.openInPaseoTooltip"),
      openDiffTooltip: t("personaEmbed.guest.openDiffTooltip"),
    }),
    [t],
  );
  const guestLabelsRef = useRef(guestLabels);
  guestLabelsRef.current = guestLabels;

  // Measure available width safely (never treat 0px hidden retained-panel geometry as narrow).
  const applyMeasuredWidth = useCallback((nextWidth: number) => {
    if (Number.isFinite(nextWidth) && nextWidth > 0) {
      setSurfaceWidth((current) => (Math.abs(current - nextWidth) >= 1 ? nextWidth : current));
    }
  }, []);

  const handleContainerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      applyMeasuredWidth(event.nativeEvent.layout.width);
    },
    [applyMeasuredWidth],
  );

  useLayoutEffect(() => {
    const element = splitContainerRef.current as unknown as HTMLElement | null;
    if (!element) {
      return;
    }
    const measure = () => {
      if (typeof element.getBoundingClientRect === "function") {
        applyMeasuredWidth(element.getBoundingClientRect().width);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entryWidth = entries[0]?.contentRect?.width;
      if (typeof entryWidth === "number" && entryWidth > 0) {
        applyMeasuredWidth(entryWidth);
      } else {
        measure();
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [applyMeasuredWidth, settingsLoaded, personaSettings.enabled]);

  // Prune deleted or URL-changed pool entries synchronously in layout phase (before child Pane
  // useEffect mounts) so returning from Settings after changing a Hub URL never races the new mount.
  useLayoutEffect(() => {
    if (!settingsLoaded || !personaSettings.enabled) {
      return;
    }
    reconcileResidentPersonaWebviews(personaSettings.hubs);
  }, [personaSettings.enabled, personaSettings.hubs, settingsLoaded]);

  // Synchronize per-partition Hub allowlist with the Electron main process.
  useEffect(() => {
    if (!settingsLoaded) {
      parkResidentPersonaWebview();
      return;
    }
    if (!personaSettings.enabled) {
      void disableResidentPersonaWebview();
      return;
    }
    void syncPersonaHubEntriesWithMain(allowedHubEntries, { enabled: true });
  }, [allowedHubEntries, personaSettings.enabled, settingsLoaded]);

  // Park any pooled webviews that are not currently visible in either active pane.
  useEffect(() => {
    if (!settingsLoaded || !personaSettings.enabled) {
      return;
    }
    const visibleIds = new Set<string>();
    if (activeHub?.id) {
      visibleIds.add(activeHub.id);
    }
    if (effectiveSplitActive && secondaryHub?.id) {
      visibleIds.add(secondaryHub.id);
    }
    for (const pooledHubId of listResidentPersonaHubIds()) {
      if (!visibleIds.has(pooledHubId)) {
        parkResidentPersonaWebview(pooledHubId);
      }
    }
  }, [
    activeHub?.id,
    effectiveSplitActive,
    personaSettings.enabled,
    secondaryHub?.id,
    settingsLoaded,
  ]);

  // Always restore interactivity and park all webviews when leaving /persona.
  useEffect(() => {
    return () => {
      setResidentPersonaWebviewsInteractive(true);
      parkResidentPersonaWebview();
    };
  }, []);

  const handleOpenSessionForHub = useCallback(
    (hubId: string, payload: DesktopPersonaOpenSessionEvent) => {
      const settings = personaSettingsRef.current;
      if (!settings.enabled || !payload?.machineId || !payload?.sessionId) {
        return;
      }
      const hub = getPersonaHubById(settings, hubId);
      if (!hub) {
        return;
      }
      const normalized = normalizePersonaHubUrl(hub.hubUrl);
      if (!normalized.ok) {
        return;
      }
      const deps = createAppOpenPersonaSessionDeps({
        toast,
        isCompact,
        hubId: hub.id,
        machineServerMapOverride: hub.machineServerMap,
        allowPersonaFallbackNavigation: (rawHref) => {
          sendPersonaGuestAllowOnce(hub.id, rawHref);
        },
        lookupSessionMetadataHint: ({ machineId, sessionId }) =>
          lookupPersonaGuestSessionMetadata({
            hubId: hub.id,
            machineId,
            sessionId,
            authorizedHubUrl: normalized.url,
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
    [isCompact, toast],
  );

  // Centralized main-process verified guest IPC router: routes strictly by `guestWebContentsId`
  // to the originating Hub's authorized URL and `machineServerMap`.
  useEffect(() => {
    if (!settingsLoaded || !personaSettings.enabled) {
      return;
    }
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const resolveVerifiedHubEntry = (rawPayload: unknown) => {
      const guestWebContentsId = readPositiveWebContentsIdFromPayload(rawPayload);
      if (!guestWebContentsId) {
        return null;
      }
      const entry = findResidentPersonaEntryByWebContentsId(guestWebContentsId);
      if (!entry) {
        return null;
      }
      const hub = getPersonaHubById(personaSettingsRef.current, entry.hubId);
      if (!hub) {
        return null;
      }
      const normalized = normalizePersonaHubUrl(hub.hubUrl);
      if (!normalized.ok) {
        return null;
      }
      const currentGuestUrl = readWebviewUrlSafely(entry.webview, "");
      return {
        hub,
        entry,
        normalizedUrl: normalized.url,
        verificationContext: {
          authorizedHubUrl: normalized.url,
          ...(currentGuestUrl ? { currentGuestUrl } : {}),
          expectedGuestWebContentsId: readResidentPersonaWebviewContentsId(entry.webview),
        },
      };
    };

    void (async () => {
      try {
        const [disposeOpenSession, disposeGuestReady] = await Promise.all([
          listenToDesktopEvent<unknown>("persona-open-session", (rawPayload) => {
            if (disposed) {
              return;
            }
            const resolved = resolveVerifiedHubEntry(rawPayload);
            if (!resolved) {
              return;
            }
            const validated = validatePersonaGuestOpenSessionPayload(
              rawPayload,
              resolved.verificationContext,
            );
            if (validated) {
              handleOpenSessionForHub(resolved.hub.id, validated);
            }
          }),
          listenToDesktopEvent<unknown>("persona-guest-ready", (rawPayload) => {
            if (disposed) {
              return;
            }
            const resolved = resolveVerifiedHubEntry(rawPayload);
            if (!resolved) {
              return;
            }
            const validated = validatePersonaGuestReadyPayload(
              rawPayload,
              resolved.verificationContext,
            );
            if (!validated) {
              return;
            }
            const config = buildGuestConfigForHub({
              hubUrl: resolved.normalizedUrl,
              hidePersonaSidebar: effectiveHideSidebarRef.current,
              interceptSessionClicks: personaSettingsRef.current.interceptSessionClicks,
              labels: guestLabelsRef.current,
            });
            if (config) {
              sendPersonaGuestConfig(resolved.hub.id, config);
            }
            sendPersonaGuestRouteSync(resolved.hub.id, validated.frameUrl);
          }),
        ]);
        if (disposed) {
          disposeOpenSession();
          disposeGuestReady();
          return;
        }
        unlisteners.push(disposeOpenSession, disposeGuestReady);
      } catch {
        // Ignore when desktop event listener is unavailable in non-Electron tests.
      }
    })();

    return () => {
      disposed = true;
      for (const dispose of unlisteners) {
        dispose();
      }
    };
  }, [handleOpenSessionForHub, personaSettings.enabled, settingsLoaded]);

  const handleSelectPrimaryHub = useCallback(
    (hubId: string) => {
      void updatePersonaSettings((current) => selectActivePersonaHub(current, hubId));
    },
    [updatePersonaSettings],
  );

  const handleSelectSecondaryHub = useCallback(
    (hubId: string) => {
      void updatePersonaSettings((current) => selectSecondaryPersonaHub(current, hubId));
    },
    [updatePersonaSettings],
  );

  const handleToggleSplit = useCallback(() => {
    void updatePersonaSettings((current) => togglePersonaSplitMode(current));
  }, [updatePersonaSettings]);

  const handleSwapPanes = useCallback(() => {
    void updatePersonaSettings((current) => swapPersonaSplitPanes(current));
  }, [updatePersonaSettings]);

  const handleCloseSplit = useCallback(
    (closingSlot: "primary" | "secondary") => {
      void updatePersonaSettings((current) => closePersonaSplitPane(current, closingSlot));
    },
    [updatePersonaSettings],
  );

  const handleTogglePersonaSidebar = useCallback(() => {
    void updatePersonaSettings((current) => ({
      hidePersonaSidebar: !current.hidePersonaSidebar,
    }));
  }, [updatePersonaSettings]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("persona"));
  }, []);

  const handleDragStart = useCallback(() => {
    setIsDraggingDivider(true);
    setResidentPersonaWebviewsInteractive(false);
  }, []);

  const handleDragRatioChange = useCallback((nextRatio: number) => {
    setPreviewSplitRatio(nextRatio);
    setLayoutRevision((rev) => rev + 1);
  }, []);

  const handleDragEnd = useCallback(
    (finalRatio: number) => {
      const clamped = clampPersonaSplitRatio(finalRatio);
      setIsDraggingDivider(false);
      setPreviewSplitRatio(null);
      setResidentPersonaWebviewsInteractive(true);
      setLayoutRevision((rev) => rev + 1);
      void updatePersonaSettings({ splitRatio: clamped });
    },
    [updatePersonaSettings],
  );

  const handleCommitRatio = useCallback(
    (nextRatio: number) => {
      const clamped = clampPersonaSplitRatio(nextRatio);
      setLayoutRevision((rev) => rev + 1);
      void updatePersonaSettings({ splitRatio: clamped });
    },
    [updatePersonaSettings],
  );

  const primaryPaneFlexStyle = useMemo<ViewStyle>(
    () =>
      effectiveSplitActive
        ? { flexGrow: effectiveRatio, flexShrink: 1, flexBasis: 0 }
        : { flex: 1 },
    [effectiveRatio, effectiveSplitActive],
  );

  const secondaryPaneFlexStyle = useMemo<ViewStyle>(
    () => ({ flexGrow: 1 - effectiveRatio, flexShrink: 1, flexBasis: 0 }),
    [effectiveRatio],
  );

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

  return (
    <View
      ref={splitContainerRef}
      onLayout={handleContainerLayout}
      style={styles.container}
      testID="persona-surface-electron"
    >
      <View style={styles.panesRow} testID="persona-panes-row">
        <PersonaPane
          slot="primary"
          hub={activeHub}
          allHubs={personaSettings.hubs}
          otherPaneHubId={effectiveSplitActive ? (secondaryHub?.id ?? null) : null}
          estimatedPaneWidth={primaryEstimatedPaneWidth}
          isSplitActive={effectiveSplitActive}
          canEnableSplit={canEnableSplit}
          splitBlockedNarrow={splitBlockedNarrow}
          effectiveHidePersonaSidebar={effectiveHidePersonaSidebar}
          hidePersonaSidebarPreference={personaSettings.hidePersonaSidebar}
          interceptSessionClicks={personaSettings.interceptSessionClicks}
          guestLabels={guestLabels}
          allowedHubEntries={allowedHubEntries}
          layoutRevision={layoutRevision}
          paneStyle={primaryPaneFlexStyle}
          onSelectHub={handleSelectPrimaryHub}
          onToggleSplit={handleToggleSplit}
          onSwapPanes={handleSwapPanes}
          onCloseSplit={handleCloseSplit}
          onTogglePersonaSidebar={handleTogglePersonaSidebar}
          onOpenSession={handleOpenSessionForHub}
          onOpenSettings={handleOpenSettings}
        />

        {effectiveSplitActive && secondaryHub ? (
          <>
            <PersonaSplitDivider
              ratio={effectiveRatio}
              isDragging={isDraggingDivider}
              layoutRevision={layoutRevision}
              containerRef={splitContainerRef}
              onDragStart={handleDragStart}
              onDragRatioChange={handleDragRatioChange}
              onDragEnd={handleDragEnd}
              onCommitRatio={handleCommitRatio}
            />
            <PersonaPane
              slot="secondary"
              hub={secondaryHub}
              allHubs={personaSettings.hubs}
              otherPaneHubId={activeHub?.id ?? null}
              estimatedPaneWidth={secondaryEstimatedPaneWidth}
              isSplitActive={effectiveSplitActive}
              canEnableSplit={canEnableSplit}
              splitBlockedNarrow={splitBlockedNarrow}
              effectiveHidePersonaSidebar={effectiveHidePersonaSidebar}
              hidePersonaSidebarPreference={personaSettings.hidePersonaSidebar}
              interceptSessionClicks={personaSettings.interceptSessionClicks}
              guestLabels={guestLabels}
              allowedHubEntries={allowedHubEntries}
              layoutRevision={layoutRevision}
              paneStyle={secondaryPaneFlexStyle}
              onSelectHub={handleSelectSecondaryHub}
              onToggleSplit={handleToggleSplit}
              onSwapPanes={handleSwapPanes}
              onCloseSplit={handleCloseSplit}
              onTogglePersonaSidebar={handleTogglePersonaSidebar}
              onOpenSession={handleOpenSessionForHub}
              onOpenSettings={handleOpenSettings}
            />
          </>
        ) : null}
      </View>

      {isDraggingDivider && typeof document !== "undefined"
        ? createPortal(
            <div style={DRAG_SHIELD_PORTAL_STYLE} data-testid="persona-split-drag-shield" />,
            getOverlayRoot(),
          )
        : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    position: "relative",
    backgroundColor: theme.colors.surface0,
  },
  panesRow: {
    flex: 1,
    flexDirection: "row",
    minWidth: 0,
    minHeight: 0,
  },
  paneContainer: {
    minWidth: 0,
    minHeight: 0,
    flexDirection: "column",
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
    minWidth: 0,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  toolbarCompact: {
    height: 36,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
  toolbarTight: {
    paddingHorizontal: 6,
  },
  toolbarLeftGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  toolbarGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  toolbarGroupTight: {
    gap: 2,
  },
  hubSwitcherTrigger: {
    height: 26,
    minWidth: 0,
    maxWidth: 160,
    flexShrink: 1,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  hubSwitcherTriggerNarrow: {
    height: 24,
    maxWidth: 96,
    paddingHorizontal: 6,
  },
  hubSwitcherText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
    minWidth: 0,
  },
  addressChip: {
    flex: 1,
    minWidth: 0,
    maxWidth: 360,
    height: 26,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  addressChipCompact: {
    maxWidth: 220,
    height: 24,
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
    minWidth: 0,
    minHeight: 0,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  webviewAnchorSplitPrimary: {
    marginRight: DIVIDER_HIT_HALF,
  },
  webviewAnchorSplitSecondary: {
    marginLeft: DIVIDER_HIT_HALF,
  },
  dividerRail: {
    width: 1,
    alignSelf: "stretch",
    position: "relative",
    backgroundColor: theme.colors.border,
    flexShrink: 0,
  },
  dividerLine: {
    width: 1,
    height: "100%",
    backgroundColor: theme.colors.border,
  },
  dividerLineHighlighted: {
    width: 3,
    backgroundColor: theme.colors.accent,
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
