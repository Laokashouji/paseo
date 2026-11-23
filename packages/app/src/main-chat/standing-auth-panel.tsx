import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatRuleSuggestion,
  MainChatStandingAuthorization,
} from "@getpaseo/protocol/main-chat";
import type { TFunction } from "i18next";
import { RefreshCw, ShieldCheck, Sparkles, Trash2, X } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { useMainChatOverviewStore } from "./overview-store";

const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedTrash = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const trashButtonIcon = <ThemedTrash size={12} uniProps={dangerIconMapping} />;
const adoptShieldButtonIcon = <ThemedShieldCheck size={12} uniProps={successIconMapping} />;
const refreshButtonIcon = <ThemedRefresh size={12} uniProps={mutedIconMapping} />;

function formatTimestampShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildScopeSummaryParts(input: {
  serverId: string | null;
  cwd: string | null;
  allowSubdirectories?: boolean;
  toolName: string | null;
  commandPrefix: string | null;
  mode: "readonly" | "write" | null;
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  t: TFunction;
}): string[] {
  const parts: string[] = [];
  const hostName = input.serverId
    ? (input.hostLabelsByServerId?.[input.serverId] ?? input.serverId)
    : input.t("mainChat.standingAuth.hostAll");
  parts.push(input.t("mainChat.standingAuth.hostLabel", { host: hostName }));

  if (input.cwd) {
    const subdirText =
      input.allowSubdirectories === false
        ? input.t("mainChat.standingAuth.subdirExact")
        : input.t("mainChat.standingAuth.subdirIncluded");
    parts.push(`${input.t("mainChat.standingAuth.cwdLabel", { cwd: input.cwd })} (${subdirText})`);
  }
  if (input.toolName) {
    parts.push(input.t("mainChat.standingAuth.toolLabel", { tool: input.toolName }));
  }
  if (input.commandPrefix) {
    parts.push(
      input.t("mainChat.standingAuth.commandPrefixLabel", { prefix: input.commandPrefix }),
    );
  }
  if (input.mode) {
    const modeText =
      input.mode === "readonly"
        ? input.t("mainChat.mode.readonly")
        : input.t("mainChat.mode.write");
    parts.push(input.t("mainChat.standingAuth.modeLabel", { mode: modeText }));
  }
  return parts;
}

interface AuthorizationRowProps {
  authorization: MainChatStandingAuthorization;
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  busy: boolean;
  onRevoke: (authorizationId: string) => void;
}

const StandingAuthorizationRow = memo(function StandingAuthorizationRow({
  authorization,
  hostLabelsByServerId,
  busy,
  onRevoke,
}: AuthorizationRowProps): ReactElement {
  const { t } = useTranslation();
  const handleRevoke = useCallback(() => onRevoke(authorization.id), [authorization.id, onRevoke]);

  const scopeParts = useMemo(
    () =>
      buildScopeSummaryParts({
        serverId: authorization.serverId,
        cwd: authorization.cwd,
        allowSubdirectories: authorization.allowSubdirectories,
        toolName: authorization.toolName,
        commandPrefix: authorization.commandPrefix,
        mode: authorization.mode,
        hostLabelsByServerId,
        t,
      }),
    [authorization, hostLabelsByServerId, t],
  );

  const lastMatchedText = authorization.lastMatchedAt
    ? t("mainChat.standingAuth.lastMatched", {
        time: formatTimestampShort(authorization.lastMatchedAt),
      })
    : t("mainChat.standingAuth.neverMatched");

  const expiryText = authorization.expiresAt
    ? t("mainChat.standingAuth.expiresAt", {
        time: formatTimestampShort(authorization.expiresAt),
      })
    : t("mainChat.standingAuth.noExpiry");

  return (
    <View style={styles.itemCard} testID={`standing-auth-item-${authorization.id}`}>
      <View style={styles.itemHeader}>
        <View style={styles.itemTitleRow}>
          <Text style={styles.itemTitle} numberOfLines={2}>
            {authorization.label}
          </Text>
          <StatusBadge
            size="xs"
            variant={authorization.scope === "permission" ? "success" : "muted"}
            label={
              authorization.scope === "permission"
                ? t("mainChat.standingAuth.scopePermissionBadge")
                : t("mainChat.standingAuth.scopeAutoStartBadge")
            }
          />
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={trashButtonIcon}
          loading={busy}
          disabled={busy}
          onPress={handleRevoke}
          testID={`standing-auth-revoke-${authorization.id}`}
        >
          {t("mainChat.standingAuth.revokeButton")}
        </Button>
      </View>

      <View style={styles.metaWrap}>
        {scopeParts.map((part) => (
          <View key={part} style={styles.metaPill}>
            <Text style={styles.metaPillText}>{part}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.statsLine} testID={`standing-auth-stats-${authorization.id}`}>
        {t("mainChat.standingAuth.matchCount", { count: authorization.matchCount })} ·{" "}
        {lastMatchedText} · {expiryText}
      </Text>

      {authorization.reason ? (
        <Text style={styles.reasonText} numberOfLines={2}>
          {authorization.reason}
        </Text>
      ) : null}
    </View>
  );
});

interface SuggestionRowProps {
  suggestion: MainChatRuleSuggestion;
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  busyAction: "adopt" | "dismiss" | null;
  onAdopt: (suggestion: MainChatRuleSuggestion) => void;
  onDismiss: (suggestionId: string) => void;
}

const StandingSuggestionRow = memo(function StandingSuggestionRow({
  suggestion,
  hostLabelsByServerId,
  busyAction,
  onAdopt,
  onDismiss,
}: SuggestionRowProps): ReactElement {
  const { t } = useTranslation();
  const handleAdopt = useCallback(() => onAdopt(suggestion), [onAdopt, suggestion]);
  const handleDismiss = useCallback(() => onDismiss(suggestion.id), [onDismiss, suggestion.id]);

  const scopeParts = useMemo(
    () =>
      buildScopeSummaryParts({
        serverId: suggestion.serverId,
        cwd: suggestion.cwd,
        allowSubdirectories: true,
        toolName: suggestion.toolName,
        commandPrefix: suggestion.commandPrefix,
        mode: suggestion.mode,
        hostLabelsByServerId,
        t,
      }),
    [hostLabelsByServerId, suggestion, t],
  );

  return (
    <View style={styles.itemCard} testID={`standing-auth-suggestion-${suggestion.id}`}>
      <View style={styles.itemHeader}>
        <View style={styles.itemTitleRow}>
          <ThemedSparkles size={13} uniProps={successIconMapping} />
          <Text style={styles.itemTitle} numberOfLines={2}>
            {suggestion.label}
          </Text>
          <StatusBadge
            size="xs"
            variant={suggestion.scope === "permission" ? "success" : "muted"}
            label={
              suggestion.scope === "permission"
                ? t("mainChat.standingAuth.scopePermissionBadge")
                : t("mainChat.standingAuth.scopeAutoStartBadge")
            }
          />
        </View>
      </View>

      <Text style={styles.reasonText}>
        {t("mainChat.standingAuth.observedCount", { count: suggestion.observedCount })}
        {suggestion.reason ? ` · ${suggestion.reason}` : ""}
      </Text>

      <View style={styles.metaWrap}>
        {scopeParts.map((part) => (
          <View key={part} style={styles.metaPill}>
            <Text style={styles.metaPillText}>{part}</Text>
          </View>
        ))}
      </View>

      <View style={styles.suggestionActions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={adoptShieldButtonIcon}
          loading={busyAction === "adopt"}
          disabled={busyAction !== null}
          onPress={handleAdopt}
          testID={`standing-auth-adopt-${suggestion.id}`}
        >
          {t("mainChat.standingAuth.adoptButton")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={busyAction === "dismiss"}
          disabled={busyAction !== null}
          onPress={handleDismiss}
          testID={`standing-auth-dismiss-${suggestion.id}`}
        >
          {t("mainChat.standingAuth.dismissButton")}
        </Button>
      </View>
    </View>
  );
});

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function removeAuthorizationById(
  items: MainChatStandingAuthorization[],
  authorizationId: string,
): MainChatStandingAuthorization[] {
  return items.filter((item) => item.id !== authorizationId);
}

export interface StandingAuthPanelProps {
  serverId: string | null;
  mainAgentId?: string | null;
  client: DaemonClient | null;
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  variant?: "settings" | "modal";
  onMutated?: () => void;
}

type PanelLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string };

/**
 * Standing authorizations & progressive rule suggestions panel. Lists active `permission` and
 * `auto_start` rules with full scope/hit metadata, supports one-click immediate revocation, and
 * lets the user adopt or dismiss pending rule suggestions.
 */
export const StandingAuthPanel = memo(function StandingAuthPanel({
  serverId,
  mainAgentId,
  client,
  hostLabelsByServerId,
  variant = "settings",
  onMutated,
}: StandingAuthPanelProps): ReactElement {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const toast = useToast();
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);

  const [loadState, setLoadState] = useState<PanelLoadState>({ status: "idle" });
  const [authorizations, setAuthorizations] = useState<MainChatStandingAuthorization[]>([]);
  const [suggestions, setSuggestions] = useState<MainChatRuleSuggestion[]>([]);
  const [busyAuthIds, setBusyAuthIds] = useState<Record<string, boolean>>({});
  const [busySuggestionAction, setBusySuggestionAction] = useState<
    Record<string, "adopt" | "dismiss">
  >({});

  const supportsListing = Boolean(
    client && typeof client.listMainChatStandingAuthorizations === "function",
  );

  const fetchList = useCallback(async () => {
    if (!client || typeof client.listMainChatStandingAuthorizations !== "function") {
      setAuthorizations([]);
      setSuggestions([]);
      setLoadState({ status: "ready" });
      return;
    }
    setLoadState({ status: "loading" });
    try {
      const response = await client.listMainChatStandingAuthorizations({ includeRevoked: false });
      if (response.error) {
        throw new Error(response.error);
      }
      setAuthorizations(response.authorizations.filter((item) => item.revokedAt === null));
      setSuggestions(response.suggestions.filter((item) => item.dismissedAt === null));
      setLoadState({ status: "ready" });
    } catch (error) {
      setLoadState({
        status: "error",
        message:
          error instanceof Error ? error.message : tRef.current("mainChat.standingAuth.loadFailed"),
      });
    }
  }, [client]);

  useEffect(() => {
    if (!supportsListing) {
      return;
    }
    void fetchList();
  }, [fetchList, serverId, supportsListing]);

  const syncAfterMutation = useCallback(async () => {
    await fetchList();
    if (serverId && mainAgentId && client && typeof client.getMainChatOverview === "function") {
      void loadOverview(serverId, mainAgentId, client).catch(() => undefined);
    }
    onMutated?.();
  }, [client, fetchList, loadOverview, mainAgentId, onMutated, serverId]);

  const runRevoke = useCallback(
    async (authorizationId: string) => {
      if (!client || busyAuthIds[authorizationId]) return;
      setBusyAuthIds((prev) => ({ ...prev, [authorizationId]: true }));
      try {
        const response = await client.revokeMainChatStandingAuthorization(authorizationId);
        if (response.error || !response.revoked) {
          throw new Error(response.error ?? t("mainChat.standingAuth.revokeFailed"));
        }
        setAuthorizations((prev) => removeAuthorizationById(prev, authorizationId));
        toast.show(t("mainChat.standingAuth.revokedToast"), { variant: "success" });
        await syncAfterMutation();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("mainChat.standingAuth.revokeFailed"),
        );
      } finally {
        setBusyAuthIds((prev) => omitRecordKey(prev, authorizationId));
      }
    },
    [busyAuthIds, client, syncAfterMutation, t, toast],
  );

  const handleRevoke = useCallback(
    (authorizationId: string) => {
      void runRevoke(authorizationId);
    },
    [runRevoke],
  );

  const runAdoptSuggestion = useCallback(
    async (suggestion: MainChatRuleSuggestion) => {
      if (!client || busySuggestionAction[suggestion.id]) return;
      setBusySuggestionAction((prev) => ({ ...prev, [suggestion.id]: "adopt" }));
      try {
        const response = await client.grantMainChatStandingAuthorization({
          scope: suggestion.scope,
          serverId: suggestion.serverId,
          cwd: suggestion.cwd,
          allowSubdirectories: true,
          toolName: suggestion.toolName,
          commandPrefix: suggestion.commandPrefix,
          mode: suggestion.mode,
          label: suggestion.label,
          reason: suggestion.reason,
          suggestionId: suggestion.id,
        });
        if (response.error || !response.authorization) {
          throw new Error(response.error ?? t("mainChat.clarify.actionFailed"));
        }
        toast.show(t("mainChat.clarify.adoptedToast"), { variant: "success" });
        await syncAfterMutation();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.clarify.actionFailed"));
      } finally {
        setBusySuggestionAction((prev) => omitRecordKey(prev, suggestion.id));
      }
    },
    [busySuggestionAction, client, syncAfterMutation, t, toast],
  );

  const handleAdoptSuggestion = useCallback(
    (suggestion: MainChatRuleSuggestion) => {
      void runAdoptSuggestion(suggestion);
    },
    [runAdoptSuggestion],
  );

  const runDismissSuggestion = useCallback(
    async (suggestionId: string) => {
      if (!client || busySuggestionAction[suggestionId]) return;
      setBusySuggestionAction((prev) => ({ ...prev, [suggestionId]: "dismiss" }));
      try {
        const response = await client.dismissMainChatRuleSuggestion(suggestionId);
        if (response.error || !response.dismissed) {
          throw new Error(response.error ?? t("mainChat.clarify.actionFailed"));
        }
        toast.show(t("mainChat.clarify.dismissedToast"), { variant: "info" });
        await syncAfterMutation();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.clarify.actionFailed"));
      } finally {
        setBusySuggestionAction((prev) => omitRecordKey(prev, suggestionId));
      }
    },
    [busySuggestionAction, client, syncAfterMutation, t, toast],
  );

  const handleDismissSuggestion = useCallback(
    (suggestionId: string) => {
      void runDismissSuggestion(suggestionId);
    },
    [runDismissSuggestion],
  );

  const permissionAuthorizations = useMemo(
    () => authorizations.filter((item) => item.scope === "permission"),
    [authorizations],
  );
  const autoStartAuthorizations = useMemo(
    () => authorizations.filter((item) => item.scope === "auto_start"),
    [authorizations],
  );

  const handleRefresh = useCallback(() => {
    void fetchList();
  }, [fetchList]);

  return (
    <View
      style={[styles.panel, variant === "modal" && styles.panelModal]}
      testID="main-chat-standing-auth-panel"
    >
      <View style={styles.toolbar}>
        <Text style={styles.sectionHeading}>
          {t("mainChat.standingAuth.activeHeading", { count: authorizations.length })}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={refreshButtonIcon}
          disabled={loadState.status === "loading" || !supportsListing}
          onPress={handleRefresh}
          testID="standing-auth-refresh"
        >
          {t("mainChat.standingAuth.refreshAction")}
        </Button>
      </View>

      {loadState.status === "loading" && authorizations.length === 0 && suggestions.length === 0 ? (
        <View style={styles.stateBox} testID="standing-auth-loading">
          <ThemedSpinner size="small" uniProps={mutedIconMapping} />
          <Text style={styles.stateText}>{t("mainChat.standingAuth.loading")}</Text>
        </View>
      ) : null}

      {loadState.status === "error" ? (
        <View style={styles.errorBox} testID="standing-auth-error">
          <Text style={styles.errorText}>{loadState.message}</Text>
          <Button variant="secondary" size="sm" onPress={handleRefresh}>
            {t("mainChat.standingAuth.retryAction")}
          </Button>
        </View>
      ) : null}

      {loadState.status !== "loading" && authorizations.length === 0 ? (
        <Text style={styles.emptyText} testID="standing-auth-empty-active">
          {t("mainChat.standingAuth.emptyActive")}
        </Text>
      ) : null}

      {permissionAuthorizations.length > 0 ? (
        <View style={styles.groupBlock} testID="standing-auth-group-permission">
          <Text style={styles.groupHeading}>
            {t("mainChat.standingAuth.permissionGroupTitle", {
              count: permissionAuthorizations.length,
            })}
          </Text>
          {permissionAuthorizations.map((auth) => (
            <StandingAuthorizationRow
              key={auth.id}
              authorization={auth}
              hostLabelsByServerId={hostLabelsByServerId}
              busy={Boolean(busyAuthIds[auth.id])}
              onRevoke={handleRevoke}
            />
          ))}
        </View>
      ) : null}

      {autoStartAuthorizations.length > 0 ? (
        <View style={styles.groupBlock} testID="standing-auth-group-auto-start">
          <Text style={styles.groupHeading}>
            {t("mainChat.standingAuth.autoStartGroupTitle", {
              count: autoStartAuthorizations.length,
            })}
          </Text>
          {autoStartAuthorizations.map((auth) => (
            <StandingAuthorizationRow
              key={auth.id}
              authorization={auth}
              hostLabelsByServerId={hostLabelsByServerId}
              busy={Boolean(busyAuthIds[auth.id])}
              onRevoke={handleRevoke}
            />
          ))}
        </View>
      ) : null}

      <View style={styles.divider} />

      <View style={styles.groupBlock} testID="standing-auth-suggestions-section">
        <Text style={styles.sectionHeading}>
          {t("mainChat.standingAuth.suggestionsHeading", { count: suggestions.length })}
        </Text>
        {suggestions.length === 0 ? (
          <Text style={styles.emptyText} testID="standing-auth-empty-suggestions">
            {t("mainChat.standingAuth.emptySuggestions")}
          </Text>
        ) : (
          suggestions.map((suggestion) => (
            <StandingSuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              hostLabelsByServerId={hostLabelsByServerId}
              busyAction={busySuggestionAction[suggestion.id] ?? null}
              onAdopt={handleAdoptSuggestion}
              onDismiss={handleDismissSuggestion}
            />
          ))
        )}
      </View>
    </View>
  );
});

export interface StandingAuthModalProps {
  visible: boolean;
  serverId: string | null;
  mainAgentId?: string | null;
  client: DaemonClient | null;
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  onClose: () => void;
}

export const StandingAuthModal = memo(function StandingAuthModal({
  visible,
  serverId,
  mainAgentId,
  client,
  hostLabelsByServerId,
  onClose,
}: StandingAuthModalProps): ReactElement | null {
  const { t } = useTranslation();

  if (!visible) {
    return null;
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop} testID="main-chat-standing-auth-modal">
        <PressHighlight
          style={styles.modalDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.standingAuth.closeAction")}
        />
        <View style={styles.modalCard}>
          <View style={styles.modalHeader}>
            <View style={styles.modalTitleRow}>
              <ThemedShieldCheck size={16} uniProps={primaryIconMapping} />
              <Text style={styles.modalTitle}>{t("mainChat.standingAuth.modalTitle")}</Text>
            </View>
            <PressHighlight
              onPress={onClose}
              style={styles.closeIconButton}
              highlightStyle={styles.closeIconPressed}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.standingAuth.closeAction")}
              testID="main-chat-standing-auth-modal-close"
            >
              <ThemedX size={16} uniProps={mutedIconMapping} />
            </PressHighlight>
          </View>
          <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>
            <StandingAuthPanel
              serverId={serverId}
              mainAgentId={mainAgentId}
              client={client}
              hostLabelsByServerId={hostLabelsByServerId}
              variant="modal"
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create((theme) => ({
  panel: {
    padding: theme.spacing[3.5],
    gap: theme.spacing[3],
  },
  panelModal: {
    padding: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sectionHeading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  groupBlock: {
    gap: theme.spacing[2],
  },
  groupHeading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  itemCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  itemTitleRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  itemTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  metaWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  metaPill: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  metaPillText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  statsLine: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  reasonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  suggestionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[0.5],
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  stateBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  stateText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusDangerTint,
  },
  errorText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
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
    maxWidth: 560,
    maxHeight: "82%",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  modalTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  closeIconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  closeIconPressed: {
    backgroundColor: theme.colors.surface2,
  },
  modalScroll: {
    flexShrink: 1,
  },
  modalScrollContent: {
    padding: theme.spacing[4],
  },
}));
