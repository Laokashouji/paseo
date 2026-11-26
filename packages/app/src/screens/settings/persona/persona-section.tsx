import { isMainChatEnabled } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Columns2,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { findMainChatAgentOnHost } from "@/main-chat/selectors";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { useOnlineMainChatSettingsSync } from "@/main-chat/use-steward-roster";
import {
  destroyResidentPersonaWebview,
  disableResidentPersonaWebview,
  syncPersonaHubEntriesWithMain,
} from "@/persona/resident-persona-webview";
import {
  addPersonaHubProfile,
  collectValidPersonaHubPartitionEntries,
  formatPersonaHubDisplayHost,
  getActivePersonaHub,
  getPersonaHubById,
  getSecondaryPersonaHub,
  MAX_PERSONA_HUBS,
  normalizePersonaHubUrl,
  openPersonaHubInRightSplit,
  removePersonaHubProfile,
  reorderPersonaHubProfiles,
  resolvePersonaHubPartition,
  selectActivePersonaHub,
  testPersonaHubHealth,
  updatePersonaHubProfile,
  type PersonaEmbedSettings,
  type PersonaHealthCheckResult,
  type PersonaHubProfile,
  type PersonaHubProfileMutationError,
} from "@/persona/settings";
import {
  usePersonaEmbedSettings,
  useUpdatePersonaEmbedSettings,
} from "@/persona/use-persona-settings";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedCheckCircle = withUnistyles(CheckCircle2);
const ThemedXCircle = withUnistyles(XCircle);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash = withUnistyles(Trash2);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedColumns = withUnistyles(Columns2);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const disabledIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

interface ActiveMainChatHost {
  serverId: string;
  label: string;
}

interface MainChatHostSyncStatus {
  serverId: string;
  label: string;
  state: "active" | "loading" | "error";
  error?: string;
}

type HostMainChatStateEntry =
  | { serverId: string; state: "active" }
  | { serverId: string; state: "loading" }
  | { serverId: string; state: "error"; error: string };

interface ActiveMainChatHostBannerProps {
  host: ActiveMainChatHost;
  disabling: boolean;
  onDisable: (host: ActiveMainChatHost) => void;
}

const ActiveMainChatHostBanner = memo(function ActiveMainChatHostBanner({
  host,
  disabling,
  onDisable,
}: ActiveMainChatHostBannerProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onDisable(host);
  }, [host, onDisable]);

  return (
    <View style={styles.warningBanner} testID={`persona-main-chat-active-banner-${host.serverId}`}>
      <View style={styles.warningBannerLeft}>
        <ThemedAlertTriangle size={16} uniProps={warningIconMapping} />
        <Text style={styles.warningBannerText}>
          {t("personaEmbed.settings.mainChatStillActiveBanner", { host: host.label })}
        </Text>
      </View>
      <Button
        size="sm"
        variant="outline"
        loading={disabling}
        disabled={disabling}
        onPress={handlePress}
        testID={`persona-disable-main-chat-${host.serverId}`}
      >
        {t("personaEmbed.settings.disableMainChatAction")}
      </Button>
    </View>
  );
});

interface MainChatHostLoadingRowProps {
  host: ActiveMainChatHost;
}

const MainChatHostLoadingRow = memo(function MainChatHostLoadingRow({
  host,
}: MainChatHostLoadingRowProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.statusBanner} testID={`persona-main-chat-loading-${host.serverId}`}>
      <View style={styles.warningBannerLeft}>
        <ThemedLoadingSpinner size="small" uniProps={mutedIconMapping} />
        <Text style={settingsStyles.rowHint}>
          {t("personaEmbed.settings.mainChatStatusLoading", { host: host.label })}
        </Text>
      </View>
    </View>
  );
});

interface MainChatHostErrorRowProps {
  host: ActiveMainChatHost;
  error: string;
  retrying: boolean;
  onRetry: (host: ActiveMainChatHost) => void;
}

const MainChatHostErrorRow = memo(function MainChatHostErrorRow({
  host,
  error,
  retrying,
  onRetry,
}: MainChatHostErrorRowProps) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => {
    onRetry(host);
  }, [host, onRetry]);

  return (
    <View style={styles.errorBanner} testID={`persona-main-chat-error-${host.serverId}`}>
      <View style={styles.warningBannerLeft}>
        <ThemedXCircle size={15} uniProps={dangerIconMapping} />
        <Text style={styles.warningBannerText}>
          {t("personaEmbed.settings.mainChatStatusError", { host: host.label, error })}
        </Text>
      </View>
      <Button
        size="sm"
        variant="outline"
        loading={retrying}
        disabled={retrying}
        onPress={handleRetry}
        testID={`persona-retry-main-chat-${host.serverId}`}
      >
        {t("personaEmbed.settings.retryCheck")}
      </Button>
    </View>
  );
});

const PersonaHealthStatusRow = memo(function PersonaHealthStatusRow({
  result,
}: {
  result: PersonaHealthCheckResult;
}) {
  const { t } = useTranslation();
  if (result.ok) {
    return (
      <View style={styles.healthRow} testID="persona-settings-health-result">
        <ThemedCheckCircle size={15} uniProps={successIconMapping} />
        <Text style={styles.healthOkText}>
          {t("personaEmbed.settings.connectionOk", {
            hubName: result.hubName,
            version: result.version,
          })}{" "}
          · {result.latencyMs}ms
        </Text>
      </View>
    );
  }
  if (result.code === "cors_unreadable") {
    return (
      <View style={styles.healthRow} testID="persona-settings-health-result">
        <ThemedAlertTriangle size={15} uniProps={warningIconMapping} />
        <Text style={styles.healthWarningText} testID="persona-settings-health-cors-unreadable">
          {t("personaEmbed.settings.connectionCorsUnreadable")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.healthRow} testID="persona-settings-health-result">
      <ThemedXCircle size={15} uniProps={dangerIconMapping} />
      <Text style={settingsStyles.rowError}>
        {t("personaEmbed.settings.connectionFailed", { error: result.error })}
      </Text>
    </View>
  );
});

interface PersonaHubListRowProps {
  hub: PersonaHubProfile;
  index: number;
  totalCount: number;
  isSelectedForEdit: boolean;
  isActivePrimary: boolean;
  isSecondarySplit: boolean;
  onSelect: (hubId: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDelete: (hub: PersonaHubProfile) => void;
}

const PersonaHubListRow = memo(function PersonaHubListRow({
  hub,
  index,
  totalCount,
  isSelectedForEdit,
  isActivePrimary,
  isSecondarySplit,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDelete,
}: PersonaHubListRowProps) {
  const { t } = useTranslation();
  const displayHost = useMemo(() => formatPersonaHubDisplayHost(hub.hubUrl), [hub.hubUrl]);
  const canMoveUp = index > 0;
  const canMoveDown = index < totalCount - 1;
  const canDelete = totalCount > 1;

  const handleSelect = useCallback(() => onSelect(hub.id), [hub.id, onSelect]);
  const handleMoveUp = useCallback(() => onMoveUp(index), [index, onMoveUp]);
  const handleMoveDown = useCallback(() => onMoveDown(index), [index, onMoveDown]);
  const handleDelete = useCallback(() => onDelete(hub), [hub, onDelete]);

  return (
    <View
      style={[
        styles.hubListRow,
        index > 0 && settingsStyles.rowBorder,
        isSelectedForEdit && styles.hubListRowSelected,
      ]}
      testID={`persona-settings-hub-item-${hub.id}`}
    >
      <PressHighlight
        onPress={handleSelect}
        style={styles.hubListMain}
        highlightStyle={styles.hubListPressed}
        accessibilityRole="button"
        accessibilityLabel={hub.name}
        testID={`persona-settings-hub-select-${hub.id}`}
      >
        <View style={styles.hubListInfo}>
          <View style={styles.hubListTitleLine}>
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.hubListName}>
              {hub.name}
            </Text>
            {isActivePrimary ? (
              <View style={styles.badgePrimary}>
                <Text style={styles.badgePrimaryText}>
                  {t("personaEmbed.settings.activeBadge")}
                </Text>
              </View>
            ) : null}
            {isSecondarySplit ? (
              <View style={styles.badgeSecondary}>
                <Text style={styles.badgeSecondaryText}>
                  {t("personaEmbed.settings.splitBadge")}
                </Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} ellipsizeMode="middle" style={settingsStyles.rowHint}>
            {displayHost ?? t("personaEmbed.sidebar.subtitleUnconfigured")}
          </Text>
        </View>
      </PressHighlight>

      <View style={styles.hubListActions}>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canMoveUp}
          onPress={handleMoveUp}
          accessibilityLabel={t("personaEmbed.settings.moveHubUp", { name: hub.name })}
          testID={`persona-settings-hub-move-up-${hub.id}`}
        >
          <ThemedChevronUp
            size={14}
            uniProps={canMoveUp ? mutedIconMapping : disabledIconMapping}
          />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canMoveDown}
          onPress={handleMoveDown}
          accessibilityLabel={t("personaEmbed.settings.moveHubDown", { name: hub.name })}
          testID={`persona-settings-hub-move-down-${hub.id}`}
        >
          <ThemedChevronDown
            size={14}
            uniProps={canMoveDown ? mutedIconMapping : disabledIconMapping}
          />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canDelete}
          onPress={handleDelete}
          accessibilityLabel={t("personaEmbed.settings.deleteHub", { name: hub.name })}
          testID={`persona-settings-hub-delete-${hub.id}`}
        >
          <ThemedTrash size={14} uniProps={canDelete ? mutedIconMapping : disabledIconMapping} />
        </Button>
      </View>
    </View>
  );
});

interface MachineMappingRowProps {
  machineId: string;
  serverId: string;
  hostLabel?: string;
  onRemove: (machineId: string) => void;
}

const MachineMappingRow = memo(function MachineMappingRow({
  machineId,
  serverId,
  hostLabel,
  onRemove,
}: MachineMappingRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onRemove(machineId);
  }, [machineId, onRemove]);

  return (
    <View
      style={[styles.mappingRow, settingsStyles.rowBorder]}
      testID={`persona-mapping-row-${machineId}`}
    >
      <View style={styles.mappingInfo}>
        <Text style={styles.mappingMachine}>{machineId}</Text>
        <Text style={settingsStyles.rowHint}>
          {hostLabel ? `${hostLabel} (${serverId})` : serverId}
        </Text>
      </View>
      <Button
        size="sm"
        variant="ghost"
        onPress={handlePress}
        testID={`persona-mapping-remove-${machineId}`}
      >
        <ThemedTrash size={14} uniProps={mutedIconMapping} />
        <Text style={styles.removeButtonText}>{t("personaEmbed.settings.mappingRemove")}</Text>
      </Button>
    </View>
  );
});

function formatHubMutationError(
  error: PersonaHubProfileMutationError,
  t: (key: string) => string,
): string {
  if (error === "credentials_not_allowed") {
    return t("personaEmbed.settings.urlCredentialsBlocked");
  }
  if (error === "max_hubs_reached") {
    return t("personaEmbed.settings.maxHubsReached");
  }
  return t("personaEmbed.error.invalidUrl");
}

function resolveClearAllButtonLabel(input: {
  clearingTarget: "hub" | "all" | null;
  hasMultipleHubs: boolean;
  t: (key: string) => string;
}): string {
  if (input.clearingTarget === "all") {
    return input.t("personaEmbed.settings.clearingSession");
  }
  if (input.hasMultipleHubs) {
    return input.t("personaEmbed.settings.clearAllSession");
  }
  return input.t("personaEmbed.settings.clearSession");
}

interface PersonaAddHubPanelProps {
  isAddingHub: boolean;
  canAddMore: boolean;
  newHubName: string;
  newHubUrl: string;
  resetKey: number;
  error: string | null;
  onOpenAdd: () => void;
  onChangeName: (value: string) => void;
  onChangeUrl: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const PersonaAddHubPanel = memo(function PersonaAddHubPanel({
  isAddingHub,
  canAddMore,
  newHubName,
  newHubUrl,
  resetKey,
  error,
  onOpenAdd,
  onChangeName,
  onChangeUrl,
  onSubmit,
  onCancel,
}: PersonaAddHubPanelProps) {
  const { t } = useTranslation();
  if (!isAddingHub) {
    return (
      <View style={[styles.addHubFooter, settingsStyles.rowBorder]}>
        <Button
          variant="outline"
          disabled={!canAddMore}
          onPress={onOpenAdd}
          testID="persona-settings-add-hub"
        >
          <ThemedPlus size={14} uniProps={mutedIconMapping} />
          <Text style={styles.addButtonText}>{t("personaEmbed.settings.addHub")}</Text>
        </Button>
      </View>
    );
  }
  return (
    <View
      style={[styles.addHubForm, settingsStyles.rowBorder]}
      testID="persona-settings-add-hub-form"
    >
      <Text style={settingsStyles.rowTitle}>{t("personaEmbed.settings.addHubTitle")}</Text>
      <View style={styles.hubUrlRow}>
        <View style={styles.addHubNameInput}>
          <FormTextInput
            initialValue={newHubName}
            resetKey={resetKey}
            onChangeText={onChangeName}
            placeholder={t("personaEmbed.settings.hubNamePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("personaEmbed.settings.hubNameLabel")}
            testID="persona-settings-new-hub-name"
          />
        </View>
        <View style={styles.hubUrlInputWrap}>
          <FormTextInput
            initialValue={newHubUrl}
            resetKey={resetKey}
            onChangeText={onChangeUrl}
            placeholder={t("personaEmbed.settings.hubUrlPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("personaEmbed.settings.hubUrlLabel")}
            testID="persona-settings-new-hub-url"
          />
        </View>
      </View>
      {error ? (
        <Text style={settingsStyles.rowError} testID="persona-settings-new-hub-error">
          {error}
        </Text>
      ) : null}
      <View style={styles.hubUrlRow}>
        <Button size="sm" onPress={onSubmit} testID="persona-settings-new-hub-submit">
          {t("personaEmbed.settings.confirmAddHub")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={onCancel}
          testID="persona-settings-new-hub-cancel"
        >
          {t("personaEmbed.settings.cancelAddHub")}
        </Button>
      </View>
    </View>
  );
});

interface PersonaSelectedHubEditorProps {
  hub: PersonaHubProfile;
  hasMultipleHubs: boolean;
  isEditingPrimary: boolean;
  isEditingSecondaryInSplit: boolean;
  displayHost: string | null;
  hubNameDraft: string;
  hubNameResetKey: number;
  hubUrlDraft: string;
  hubUrlResetKey: number;
  hubUrlError: string | null;
  isTestingConnection: boolean;
  healthResult: PersonaHealthCheckResult | null;
  onSetActive: () => void;
  onOpenInSplit: () => void;
  onChangeName: (value: string) => void;
  onBlurName: () => void;
  onSaveName: () => void;
  onChangeUrl: (value: string) => void;
  onBlurUrl: () => void;
  onSaveUrl: () => void;
  onTestConnection: () => void;
}

const PersonaSelectedHubEditor = memo(function PersonaSelectedHubEditor({
  hub,
  hasMultipleHubs,
  isEditingPrimary,
  isEditingSecondaryInSplit,
  displayHost,
  hubNameDraft,
  hubNameResetKey,
  hubUrlDraft,
  hubUrlResetKey,
  hubUrlError,
  isTestingConnection,
  healthResult,
  onSetActive,
  onOpenInSplit,
  onChangeName,
  onBlurName,
  onSaveName,
  onChangeUrl,
  onBlurUrl,
  onSaveUrl,
  onTestConnection,
}: PersonaSelectedHubEditorProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={
        hasMultipleHubs
          ? t("personaEmbed.settings.editingHubTitle", { name: hub.name })
          : t("personaEmbed.settings.hubUrlLabel")
      }
    >
      <View style={settingsStyles.card} testID="persona-settings-hub-editor">
        {hasMultipleHubs ? (
          <View style={styles.hubQuickActionsRow}>
            <Button
              size="sm"
              variant={isEditingPrimary ? "default" : "outline"}
              disabled={isEditingPrimary}
              onPress={onSetActive}
              testID="persona-settings-hub-set-active"
            >
              {t("personaEmbed.settings.setActiveHub")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isEditingPrimary || isEditingSecondaryInSplit || !displayHost}
              onPress={onOpenInSplit}
              testID="persona-settings-hub-open-split"
            >
              <ThemedColumns size={13} uniProps={mutedIconMapping} />
              <Text style={styles.addButtonText}>{t("personaEmbed.settings.openInSplit")}</Text>
            </Button>
          </View>
        ) : null}

        <View style={[styles.hubUrlBlock, hasMultipleHubs && settingsStyles.rowBorder]}>
          <Text style={styles.fieldLabel}>{t("personaEmbed.settings.hubNameLabel")}</Text>
          <View style={styles.hubUrlRow}>
            <View style={styles.hubUrlInputWrap}>
              <FormTextInput
                initialValue={hubNameDraft}
                resetKey={hubNameResetKey}
                onChangeText={onChangeName}
                onBlur={onBlurName}
                placeholder={t("personaEmbed.settings.hubNamePlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("personaEmbed.settings.hubNameLabel")}
                testID="persona-settings-hub-name-input"
              />
            </View>
            <Button variant="outline" onPress={onSaveName} testID="persona-settings-save-hub-name">
              {t("personaEmbed.settings.saveHubName")}
            </Button>
          </View>
        </View>

        <View style={[styles.hubUrlBlock, settingsStyles.rowBorder]}>
          <Text style={styles.fieldLabel}>{t("personaEmbed.settings.hubUrlLabel")}</Text>
          <View style={styles.hubUrlRow}>
            <View style={styles.hubUrlInputWrap}>
              <FormTextInput
                initialValue={hubUrlDraft}
                resetKey={hubUrlResetKey}
                onChangeText={onChangeUrl}
                onBlur={onBlurUrl}
                placeholder={t("personaEmbed.settings.hubUrlPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("personaEmbed.settings.hubUrlLabel")}
                testID="persona-settings-hub-url-input"
              />
            </View>
            <Button variant="outline" onPress={onSaveUrl} testID="persona-settings-save-url">
              {t("personaEmbed.settings.saveUrl")}
            </Button>
            <Button
              variant="outline"
              loading={isTestingConnection}
              disabled={isTestingConnection}
              onPress={onTestConnection}
              testID="persona-settings-test-connection"
            >
              {isTestingConnection
                ? t("personaEmbed.settings.testingConnection")
                : t("personaEmbed.settings.testConnection")}
            </Button>
          </View>

          <Text style={settingsStyles.rowHint}>{t("personaEmbed.settings.hubUrlHint")}</Text>

          {hubUrlError ? (
            <Text style={settingsStyles.rowError} testID="persona-settings-hub-url-error">
              {hubUrlError}
            </Text>
          ) : null}

          {healthResult ? <PersonaHealthStatusRow result={healthResult} /> : null}
        </View>
      </View>
    </SettingsSection>
  );
});

function collectHostPartitionEntries(settings: PersonaEmbedSettings) {
  const desktopPersona = getDesktopHost()?.persona;
  return collectValidPersonaHubPartitionEntries(settings, {
    basePartition: desktopPersona?.partition,
    partitionPrefix: desktopPersona?.partitionPrefix,
  });
}

interface PersonaSessionDataSectionProps {
  editingHub: PersonaHubProfile | null;
  editingHubDisplayHost: string | null;
  hasMultipleHubs: boolean;
  supportsScopedClear: boolean;
  clearingTarget: "hub" | "all" | null;
  onClearHubSession: () => void;
  onClearAllSession: () => void;
}

const PersonaSessionDataSection = memo(function PersonaSessionDataSection({
  editingHub,
  editingHubDisplayHost,
  hasMultipleHubs,
  supportsScopedClear,
  clearingTarget,
  onClearHubSession,
  onClearAllSession,
}: PersonaSessionDataSectionProps) {
  const { t } = useTranslation();
  const hasHubClearRow = Boolean(supportsScopedClear && editingHub && editingHubDisplayHost);
  const clearAllLabel = resolveClearAllButtonLabel({ clearingTarget, hasMultipleHubs, t });
  return (
    <SettingsSection title={t("personaEmbed.settings.sessionDataTitle")}>
      <View style={settingsStyles.card}>
        {hasHubClearRow && editingHub && editingHubDisplayHost ? (
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("personaEmbed.settings.clearHubSessionTitle", { name: editingHub.name })}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("personaEmbed.settings.clearHubSessionHint", {
                  host: editingHubDisplayHost,
                })}
              </Text>
            </View>
            <Button
              variant="outline"
              loading={clearingTarget === "hub"}
              disabled={clearingTarget !== null}
              onPress={onClearHubSession}
              testID="persona-settings-clear-hub-session"
            >
              {clearingTarget === "hub"
                ? t("personaEmbed.settings.clearingSession")
                : t("personaEmbed.settings.clearHubSession")}
            </Button>
          </View>
        ) : null}

        <View style={[settingsStyles.row, hasHubClearRow && settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("personaEmbed.settings.sessionDataTitle")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("personaEmbed.settings.sessionDataHint")}</Text>
          </View>
          <Button
            variant="outline"
            loading={clearingTarget === "all"}
            disabled={clearingTarget !== null}
            onPress={onClearAllSession}
            testID="persona-settings-clear-session"
          >
            {clearAllLabel}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
});

const PersonaMainChatHostStatusList = memo(function PersonaMainChatHostStatusList({
  statuses,
  disablingHostId,
  retryingHostId,
  onDisable,
  onRetry,
}: {
  statuses: ReadonlyArray<{
    serverId: string;
    label: string;
    state: "active" | "loading" | "error";
    error?: string;
  }>;
  disablingHostId: string | null;
  retryingHostId: string | null;
  onDisable: (host: ActiveMainChatHost) => void;
  onRetry: (host: ActiveMainChatHost) => void;
}) {
  return (
    <>
      {statuses.map((host) => {
        if (host.state === "active") {
          return (
            <ActiveMainChatHostBanner
              key={host.serverId}
              host={host}
              disabling={disablingHostId === host.serverId}
              onDisable={onDisable}
            />
          );
        }
        if (host.state === "loading") {
          return <MainChatHostLoadingRow key={host.serverId} host={host} />;
        }
        return (
          <MainChatHostErrorRow
            key={host.serverId}
            host={host}
            error={host.error ?? ""}
            retrying={retryingHostId === host.serverId}
            onRetry={onRetry}
          />
        );
      })}
    </>
  );
});

const PersonaEmbedOptionsSection = memo(function PersonaEmbedOptionsSection({
  isElectron,
  hidePersonaSidebar,
  interceptSessionClicks,
  onToggleHidePersonaSidebar,
  onToggleInterceptClicks,
}: {
  isElectron: boolean;
  hidePersonaSidebar: boolean;
  interceptSessionClicks: boolean;
  onToggleHidePersonaSidebar: (value: boolean) => void;
  onToggleInterceptClicks: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  const desktopOnlySuffix = isElectron ? "" : ` (${t("personaEmbed.settings.desktopOnlyHint")})`;
  return (
    <SettingsSection title={t("personaEmbed.settings.embedOptionsTitle")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("personaEmbed.settings.hideSidebarLabel")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("personaEmbed.settings.hideSidebarHint")}
              {desktopOnlySuffix}
            </Text>
          </View>
          <Switch
            value={hidePersonaSidebar}
            disabled={!isElectron}
            onValueChange={onToggleHidePersonaSidebar}
            accessibilityLabel={t("personaEmbed.settings.hideSidebarLabel")}
            testID="persona-settings-hide-sidebar-switch"
          />
        </View>

        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("personaEmbed.settings.interceptClicksLabel")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("personaEmbed.settings.interceptClicksHint")}
              {desktopOnlySuffix}
            </Text>
          </View>
          <Switch
            value={interceptSessionClicks}
            disabled={!isElectron}
            onValueChange={onToggleInterceptClicks}
            accessibilityLabel={t("personaEmbed.settings.interceptClicksLabel")}
            testID="persona-settings-intercept-clicks-switch"
          />
        </View>
      </View>
    </SettingsSection>
  );
});

const PersonaMappingSection = memo(function PersonaMappingSection({
  editingHub,
  hasMultipleHubs,
  mappingEntries,
  hostLabelById,
  newMachineId,
  newMachineResetKey,
  newTargetServerId,
  selectedHostDisplay,
  hostOptions,
  onChangeMachineId,
  onChangeTargetServerId,
  onAddMapping,
  onRemoveMapping,
}: {
  editingHub: PersonaHubProfile;
  hasMultipleHubs: boolean;
  mappingEntries: readonly [string, string][];
  hostLabelById: ReadonlyMap<string, string>;
  newMachineId: string;
  newMachineResetKey: number;
  newTargetServerId: string | null;
  selectedHostDisplay: { label: string; description?: string } | null;
  hostOptions: SelectFieldOption<string>[];
  onChangeMachineId: (value: string) => void;
  onChangeTargetServerId: (value: string) => void;
  onAddMapping: () => void;
  onRemoveMapping: (machineId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={
        hasMultipleHubs
          ? t("personaEmbed.settings.mappingHubTitle", { name: editingHub.name })
          : t("personaEmbed.settings.mappingTitle")
      }
    >
      <View style={settingsStyles.card} testID="persona-settings-mapping-section">
        <View style={styles.mappingHeader}>
          <Text style={settingsStyles.rowHint}>{t("personaEmbed.settings.mappingHint")}</Text>
        </View>

        {mappingEntries.length === 0 ? (
          <View style={[styles.mappingRow, settingsStyles.rowBorder]}>
            <Text style={settingsStyles.rowHint} testID="persona-settings-mapping-empty">
              {t("personaEmbed.settings.mappingEmpty")}
            </Text>
          </View>
        ) : (
          mappingEntries.map(([machineId, serverId]) => (
            <MachineMappingRow
              key={machineId}
              machineId={machineId}
              serverId={serverId}
              hostLabel={hostLabelById.get(serverId)}
              onRemove={onRemoveMapping}
            />
          ))
        )}

        <View style={[styles.addMappingRow, settingsStyles.rowBorder]}>
          <View style={styles.addMappingMachineInput}>
            <FormTextInput
              initialValue={newMachineId}
              resetKey={newMachineResetKey}
              onChangeText={onChangeMachineId}
              placeholder={t("personaEmbed.settings.mappingMachinePlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel={t("personaEmbed.settings.mappingMachinePlaceholder")}
              testID="persona-settings-mapping-machine-input"
            />
          </View>
          <View style={styles.addMappingHostSelect}>
            <SelectField
              label={t("personaEmbed.settings.mappingHostPlaceholder")}
              value={newTargetServerId}
              selectedDisplay={selectedHostDisplay}
              options={hostOptions}
              onChange={onChangeTargetServerId}
              placeholder={t("personaEmbed.settings.mappingHostPlaceholder")}
              emptyText={t("common.empty.noResults")}
              field={false}
              triggerTestID="persona-settings-mapping-host-select"
            />
          </View>
          <Button
            variant="outline"
            disabled={!newMachineId.trim() || !newTargetServerId}
            onPress={onAddMapping}
            testID="persona-settings-mapping-add"
          >
            <ThemedPlus size={14} uniProps={mutedIconMapping} />
            <Text style={styles.addButtonText}>{t("personaEmbed.settings.mappingAdd")}</Text>
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
});

const PersonaHubsListSection = memo(function PersonaHubsListSection({
  hubs,
  editingHubId,
  activeHubId,
  secondaryHubId,
  splitEnabled,
  isAddingHub,
  newHubName,
  newHubUrl,
  newHubFormResetKey,
  newHubError,
  onSelectHub,
  onMoveUp,
  onMoveDown,
  onDelete,
  onOpenAdd,
  onChangeNewName,
  onChangeNewUrl,
  onSubmitAdd,
  onCancelAdd,
}: {
  hubs: readonly PersonaHubProfile[];
  editingHubId: string;
  activeHubId: string | undefined;
  secondaryHubId: string | undefined;
  splitEnabled: boolean;
  isAddingHub: boolean;
  newHubName: string;
  newHubUrl: string;
  newHubFormResetKey: number;
  newHubError: string | null;
  onSelectHub: (hubId: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDelete: (hub: PersonaHubProfile) => void;
  onOpenAdd: () => void;
  onChangeNewName: (value: string) => void;
  onChangeNewUrl: (value: string) => void;
  onSubmitAdd: () => void;
  onCancelAdd: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t("personaEmbed.settings.hubsTitle")}>
      <View style={settingsStyles.card} testID="persona-settings-hub-list">
        <View style={styles.mappingHeader}>
          <Text style={settingsStyles.rowHint}>{t("personaEmbed.settings.hubsHint")}</Text>
        </View>

        {hubs.map((hub, index) => (
          <PersonaHubListRow
            key={hub.id}
            hub={hub}
            index={index}
            totalCount={hubs.length}
            isSelectedForEdit={hub.id === editingHubId}
            isActivePrimary={hub.id === activeHubId}
            isSecondarySplit={splitEnabled && hub.id === secondaryHubId}
            onSelect={onSelectHub}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onDelete={onDelete}
          />
        ))}

        <PersonaAddHubPanel
          isAddingHub={isAddingHub}
          canAddMore={hubs.length < MAX_PERSONA_HUBS}
          newHubName={newHubName}
          newHubUrl={newHubUrl}
          resetKey={newHubFormResetKey}
          error={newHubError}
          onOpenAdd={onOpenAdd}
          onChangeName={onChangeNewName}
          onChangeUrl={onChangeNewUrl}
          onSubmit={onSubmitAdd}
          onCancel={onCancelAdd}
        />
      </View>
    </SettingsSection>
  );
});

function derivePersonaSettingsHubContext(
  persona: ReturnType<typeof usePersonaEmbedSettings>,
  selectedHubId: string,
) {
  const activeHub = getActivePersonaHub(persona);
  const secondaryHub = getSecondaryPersonaHub(persona);
  const editingHub = getPersonaHubById(persona, selectedHubId) ?? activeHub;
  const editingHubId = editingHub?.id ?? "";
  return {
    activeHubId: activeHub?.id,
    secondaryHubId: secondaryHub?.id,
    editingHub,
    editingHubId,
    editingHubName: editingHub?.name ?? "",
    editingHubUrl: editingHub?.hubUrl ?? "",
    editingHubMachineMap: editingHub?.machineServerMap ?? {},
    isEditingPrimary: Boolean(editingHubId) && editingHubId === activeHub?.id,
    isEditingSecondaryInSplit:
      Boolean(editingHubId) && persona.splitEnabled && editingHubId === secondaryHub?.id,
    hasMultipleHubs: persona.hubs.length > 1,
  };
}

function getEditingHubHealthState(
  editingHubId: string,
  testingHubId: string | null,
  healthResultByHubId: Record<string, PersonaHealthCheckResult | undefined>,
) {
  return {
    currentHealthResult: editingHubId ? (healthResultByHubId[editingHubId] ?? null) : null,
    isTestingCurrentHub: Boolean(editingHubId) && testingHubId === editingHubId,
  };
}

export function PersonaSettingsSection() {
  useOnlineMainChatSettingsSync();

  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const persona = usePersonaEmbedSettings();
  const updatePersona = useUpdatePersonaEmbedSettings();
  const isElectron = isElectronRuntime();

  const [selectedHubId, setSelectedHubId] = useState<string>(() => persona.activeHubId);
  const hubContext = useMemo(
    () => derivePersonaSettingsHubContext(persona, selectedHubId),
    [persona, selectedHubId],
  );
  const {
    activeHubId,
    secondaryHubId,
    editingHub,
    editingHubId,
    editingHubName,
    editingHubUrl,
    editingHubMachineMap,
    isEditingPrimary,
    isEditingSecondaryInSplit,
    hasMultipleHubs,
  } = hubContext;

  const [hubNameDraft, setHubNameDraft] = useState(editingHubName);
  const [hubNameResetKey, setHubNameResetKey] = useState(0);
  const [hubUrlDraft, setHubUrlDraft] = useState(editingHubUrl);
  const [hubUrlResetKey, setHubUrlResetKey] = useState(0);
  const [hubUrlError, setHubUrlError] = useState<string | null>(null);

  const [testingHubId, setTestingHubId] = useState<string | null>(null);
  const [healthResultByHubId, setHealthResultByHubId] = useState<
    Record<string, PersonaHealthCheckResult | undefined>
  >({});

  const [isAddingHub, setIsAddingHub] = useState(false);
  const [newHubName, setNewHubName] = useState("");
  const [newHubUrl, setNewHubUrl] = useState("");
  const [newHubFormResetKey, setNewHubFormResetKey] = useState(0);
  const [newHubError, setNewHubError] = useState<string | null>(null);

  const [newMachineId, setNewMachineId] = useState("");
  const [newMachineResetKey, setNewMachineResetKey] = useState(0);
  const [newTargetServerId, setNewTargetServerId] = useState<string | null>(null);
  const [disablingHostId, setDisablingHostId] = useState<string | null>(null);
  const [retryingHostId, setRetryingHostId] = useState<string | null>(null);
  const [clearingTarget, setClearingTarget] = useState<"hub" | "all" | null>(null);
  const clearInFlightRef = useRef(false);

  // Keep selectedHubId aligned when hubs are added/deleted externally.
  useEffect(() => {
    if (editingHubId && editingHubId !== selectedHubId) {
      setSelectedHubId(editingHubId);
    }
  }, [editingHubId, selectedHubId]);

  useEffect(() => {
    setHubNameDraft(editingHubName);
    setHubNameResetKey((key) => key + 1);
  }, [editingHubId, editingHubName]);

  useEffect(() => {
    setHubUrlDraft(editingHubUrl);
    setHubUrlResetKey((key) => key + 1);
    setHubUrlError(null);
  }, [editingHubId, editingHubUrl]);

  useEffect(() => {
    setNewMachineId("");
    setNewMachineResetKey((key) => key + 1);
    setNewTargetServerId(null);
  }, [editingHubId]);

  // Stable deep-equal selectors: track online hosts that support built-in Main Chat and distinguish
  // loading / error / confirmed-active / confirmed-disabled states.
  const onlineHostCapabilities = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        hosts.flatMap((host) => {
          const session = state.sessions[host.serverId];
          if (!session?.client) {
            return [];
          }
          const hasExistingMainChat = findMainChatAgentOnHost(session, host.serverId) !== null;
          const features = session.serverInfo?.features;
          const canQuerySettings = typeof session.client.getMainChatSettings === "function";
          const supportsMainChat =
            hasExistingMainChat ||
            features?.mainChat === true ||
            (features === undefined && canQuerySettings);
          return [{ serverId: host.serverId, supportsMainChat, canQuerySettings }];
        }),
      [hosts],
    ),
    equal,
  );

  const hostMainChatStates = useStoreWithEqualityFn(
    useMainChatSettingsStore,
    useCallback(
      (state): HostMainChatStateEntry[] =>
        onlineHostCapabilities.flatMap<HostMainChatStateEntry>((entry) => {
          const settings = state.settingsByServerId[entry.serverId];
          if (settings !== undefined) {
            return isMainChatEnabled(settings)
              ? [{ serverId: entry.serverId, state: "active" }]
              : [];
          }
          if (!entry.supportsMainChat) {
            return [];
          }
          const error = state.errorByServerId[entry.serverId];
          if (error) {
            return [{ serverId: entry.serverId, state: "error", error }];
          }
          if (entry.canQuerySettings || state.loadingByServerId[entry.serverId]) {
            return [{ serverId: entry.serverId, state: "loading" }];
          }
          return [];
        }),
      [onlineHostCapabilities],
    ),
    equal,
  );

  const mainChatHostStatuses = useMemo<MainChatHostSyncStatus[]>(() => {
    if (!persona.enabled || hostMainChatStates.length === 0) {
      return [];
    }
    const hostLabelById = new Map(hosts.map((host) => [host.serverId, host.label]));
    return hostMainChatStates.map((entry) => ({
      serverId: entry.serverId,
      label: hostLabelById.get(entry.serverId) ?? entry.serverId,
      state: entry.state,
      ...(entry.state === "error" ? { error: entry.error } : {}),
    }));
  }, [hostMainChatStates, hosts, persona.enabled]);

  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        description: host.serverId,
      })),
    [hosts],
  );

  const hostLabelById = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );

  const selectedHostDisplay = useMemo(() => {
    if (!newTargetServerId) {
      return null;
    }
    const found = hostOptions.find((opt) => opt.value === newTargetServerId);
    return found ? { label: found.label, description: found.description } : null;
  }, [hostOptions, newTargetServerId]);

  const mappingEntries = useMemo(() => {
    return Object.entries(editingHubMachineMap).sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }, [editingHubMachineMap]);

  const { currentHealthResult, isTestingCurrentHub } = getEditingHubHealthState(
    editingHubId,
    testingHubId,
    healthResultByHubId,
  );
  const editingHubDisplayHost = useMemo(
    () => formatPersonaHubDisplayHost(editingHubUrl),
    [editingHubUrl],
  );

  const handleToggleEnabled = useCallback(
    (nextEnabled: boolean) => {
      void (async () => {
        await updatePersona({ enabled: nextEnabled });
        if (!nextEnabled) {
          await disableResidentPersonaWebview();
        } else {
          await syncPersonaHubEntriesWithMain(collectHostPartitionEntries(persona), {
            enabled: true,
          });
        }
      })();
    },
    [persona, updatePersona],
  );

  const handleToggleHideMainChat = useCallback(
    (nextValue: boolean) => {
      void updatePersona({ hideBuiltInMainChatWhenEnabled: nextValue });
    },
    [updatePersona],
  );

  const handleRetryMainChatHost = useCallback((host: ActiveMainChatHost) => {
    void (async () => {
      const client = useSessionStore.getState().sessions[host.serverId]?.client ?? null;
      if (!client || typeof client.getMainChatSettings !== "function") {
        return;
      }
      setRetryingHostId(host.serverId);
      try {
        await useMainChatSettingsStore.getState().loadSettings(host.serverId, client);
      } catch {
        // Store records errorByServerId; keep error row visible for further retry.
      } finally {
        setRetryingHostId((current) => (current === host.serverId ? null : current));
      }
    })();
  }, []);

  const handleDisableMainChatOnHost = useCallback(
    (host: ActiveMainChatHost) => {
      void (async () => {
        const client = useSessionStore.getState().sessions[host.serverId]?.client ?? null;
        if (!client) {
          return;
        }
        setDisablingHostId(host.serverId);
        try {
          await useMainChatSettingsStore
            .getState()
            .updateSettings(host.serverId, { enabled: false }, client);
          toast.show(t("personaEmbed.settings.mainChatDisabledToast", { host: host.label }), {
            variant: "success",
          });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setDisablingHostId((current) => (current === host.serverId ? null : current));
        }
      })();
    },
    [t, toast],
  );

  const handleOpenAddHub = useCallback(() => {
    setIsAddingHub(true);
    setNewHubName("");
    setNewHubUrl("");
    setNewHubError(null);
    setNewHubFormResetKey((key) => key + 1);
  }, []);

  const handleCancelAddHub = useCallback(() => {
    setIsAddingHub(false);
    setNewHubError(null);
  }, []);

  const handleNewHubNameChange = useCallback((value: string) => {
    setNewHubName(value);
    setNewHubError(null);
  }, []);

  const handleNewHubUrlChange = useCallback((value: string) => {
    setNewHubUrl(value);
    setNewHubError(null);
  }, []);

  const handleSubmitAddHub = useCallback(() => {
    const result = addPersonaHubProfile(persona, {
      name: newHubName,
      hubUrl: newHubUrl,
    });
    if (!result.ok) {
      setNewHubError(formatHubMutationError(result.error, t));
      return;
    }
    setNewHubError(null);
    setIsAddingHub(false);
    setSelectedHubId(result.hub.id);
    void (async () => {
      await updatePersona((current) => {
        const applied = addPersonaHubProfile(current, {
          id: result.hub.id,
          name: result.hub.name,
          hubUrl: result.hub.hubUrl,
        });
        return applied.ok ? applied.settings : current;
      });
      await syncPersonaHubEntriesWithMain(collectHostPartitionEntries(result.settings), {
        enabled: persona.enabled,
      });
      toast.show(t("personaEmbed.settings.hubAddedToast", { name: result.hub.name }), {
        variant: "success",
      });
    })();
  }, [newHubName, newHubUrl, persona, t, toast, updatePersona]);

  const handleMoveHubUp = useCallback(
    (index: number) => {
      if (index <= 0) return;
      void updatePersona((current) => reorderPersonaHubProfiles(current, index, index - 1));
    },
    [updatePersona],
  );

  const handleMoveHubDown = useCallback(
    (index: number) => {
      void updatePersona((current) => reorderPersonaHubProfiles(current, index, index + 1));
    },
    [updatePersona],
  );

  const handleDeleteHub = useCallback(
    (hub: PersonaHubProfile) => {
      if (persona.hubs.length <= 1) {
        return;
      }
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("personaEmbed.settings.deleteHubConfirmTitle", { name: hub.name }),
          message: t("personaEmbed.settings.deleteHubConfirmMessage"),
          confirmLabel: t("personaEmbed.settings.mappingRemove"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        const nextSettings = removePersonaHubProfile(persona, hub.id);
        await updatePersona((current) => removePersonaHubProfile(current, hub.id));
        destroyResidentPersonaWebview(hub.id);
        await syncPersonaHubEntriesWithMain(collectHostPartitionEntries(nextSettings), {
          enabled: nextSettings.enabled,
        });
        setHealthResultByHubId((current) => {
          const next = { ...current };
          delete next[hub.id];
          return next;
        });
        toast.show(t("personaEmbed.settings.hubRemovedToast", { name: hub.name }), {
          variant: "success",
        });
      })();
    },
    [persona, t, toast, updatePersona],
  );

  const handleSetEditingHubActive = useCallback(() => {
    if (!editingHubId) return;
    void updatePersona((current) => selectActivePersonaHub(current, editingHubId));
  }, [editingHubId, updatePersona]);

  const handleOpenEditingHubInSplit = useCallback(() => {
    if (!editingHubId) return;
    void updatePersona((current) => openPersonaHubInRightSplit(current, editingHubId));
  }, [editingHubId, updatePersona]);

  const commitHubName = useCallback(
    async (showToast: boolean) => {
      if (!editingHubId) return;
      const trimmed = hubNameDraft.trim();
      if (!trimmed || trimmed === editingHubName) {
        return;
      }
      await updatePersona((current) => {
        const applied = updatePersonaHubProfile(current, editingHubId, { name: trimmed });
        return applied.ok ? applied.settings : current;
      });
      if (showToast) {
        toast.show(t("personaEmbed.settings.hubNameSavedToast"), { variant: "success" });
      }
    },
    [editingHubId, editingHubName, hubNameDraft, t, toast, updatePersona],
  );

  const handleHubNameBlur = useCallback(() => {
    void commitHubName(false);
  }, [commitHubName]);

  const handleSaveHubNamePress = useCallback(() => {
    void commitHubName(true);
  }, [commitHubName]);

  const commitHubUrl = useCallback(
    async (showToast: boolean): Promise<string | null> => {
      if (!editingHubId) return null;
      const normalized = normalizePersonaHubUrl(hubUrlDraft);
      if (!normalized.ok) {
        setHubUrlError(formatHubMutationError(normalized.error, t));
        return null;
      }
      setHubUrlError(null);
      setHubUrlDraft(normalized.url);
      if (normalized.url !== editingHubUrl) {
        const previewNext = updatePersonaHubProfile(persona, editingHubId, {
          hubUrl: normalized.url,
        });
        await updatePersona((current) => {
          const applied = updatePersonaHubProfile(current, editingHubId, {
            hubUrl: normalized.url,
          });
          return applied.ok ? applied.settings : current;
        });
        destroyResidentPersonaWebview(editingHubId);
        const nextEntries = previewNext.ok
          ? collectHostPartitionEntries(previewNext.settings)
          : collectHostPartitionEntries(persona);
        await syncPersonaHubEntriesWithMain(nextEntries, { enabled: persona.enabled });
        if (showToast) {
          toast.show(t("personaEmbed.settings.urlSavedToast"), { variant: "success" });
        }
      }
      return normalized.url;
    },
    [editingHubId, editingHubUrl, hubUrlDraft, persona, t, toast, updatePersona],
  );

  const handleHubUrlChange = useCallback(
    (value: string) => {
      setHubUrlDraft(value);
      if (hubUrlError) {
        setHubUrlError(null);
      }
      if (editingHubId && healthResultByHubId[editingHubId]) {
        setHealthResultByHubId((current) => ({ ...current, [editingHubId]: undefined }));
      }
    },
    [editingHubId, healthResultByHubId, hubUrlError],
  );

  const handleHubUrlBlur = useCallback(() => {
    void commitHubUrl(false);
  }, [commitHubUrl]);

  const handleSaveHubUrlPress = useCallback(() => {
    void commitHubUrl(true);
  }, [commitHubUrl]);

  const handleTestConnection = useCallback(() => {
    if (!editingHubId) return;
    const targetHubId = editingHubId;
    void (async () => {
      const normalized = normalizePersonaHubUrl(hubUrlDraft);
      if (!normalized.ok) {
        setHubUrlError(formatHubMutationError(normalized.error, t));
        setHealthResultByHubId((current) => ({ ...current, [targetHubId]: undefined }));
        return;
      }
      setHubUrlError(null);
      setHubUrlDraft(normalized.url);

      let nextEntries = collectHostPartitionEntries(persona);
      if (normalized.url !== editingHubUrl) {
        const previewNext = updatePersonaHubProfile(persona, targetHubId, {
          hubUrl: normalized.url,
        });
        await updatePersona((current) => {
          const applied = updatePersonaHubProfile(current, targetHubId, {
            hubUrl: normalized.url,
          });
          return applied.ok ? applied.settings : current;
        });
        destroyResidentPersonaWebview(targetHubId);
        if (previewNext.ok) {
          nextEntries = collectHostPartitionEntries(previewNext.settings);
        }
      }
      const desktopPersona = getDesktopHost()?.persona;
      const targetPartition = resolvePersonaHubPartition(targetHubId, {
        basePartition: desktopPersona?.partition,
        partitionPrefix: desktopPersona?.partitionPrefix,
      });
      if (targetPartition) {
        // Place the probed Hub first so legacy single-Hub desktop shells also probe this exact Hub.
        nextEntries = [
          { partition: targetPartition, hubUrl: normalized.url },
          ...nextEntries.filter((entry) => entry.partition !== targetPartition),
        ];
      }
      // Register the per-partition multi-Hub allowlist with Electron main before probing this Hub's fixed path.
      await syncPersonaHubEntriesWithMain(nextEntries, { enabled: persona.enabled });

      setTestingHubId(targetHubId);
      try {
        const result = await testPersonaHubHealth(normalized.url);
        setHealthResultByHubId((current) => ({ ...current, [targetHubId]: result }));
      } finally {
        setTestingHubId((current) => (current === targetHubId ? null : current));
      }
    })();
  }, [editingHubId, editingHubUrl, hubUrlDraft, persona, t, updatePersona]);

  const handleToggleHidePersonaSidebar = useCallback(
    (nextValue: boolean) => {
      void updatePersona({ hidePersonaSidebar: nextValue });
    },
    [updatePersona],
  );

  const handleToggleInterceptClicks = useCallback(
    (nextValue: boolean) => {
      void updatePersona({ interceptSessionClicks: nextValue });
    },
    [updatePersona],
  );

  const handleAddMapping = useCallback(() => {
    if (!editingHubId) return;
    const machineKey = newMachineId.trim();
    const serverId = newTargetServerId?.trim() ?? "";
    if (!machineKey || !serverId) {
      return;
    }
    void (async () => {
      await updatePersona((current) => {
        const target = getPersonaHubById(current, editingHubId);
        if (!target) {
          return current;
        }
        const applied = updatePersonaHubProfile(current, editingHubId, {
          machineServerMap: {
            ...target.machineServerMap,
            [machineKey]: serverId,
          },
        });
        return applied.ok ? applied.settings : current;
      });
      setNewMachineId("");
      setNewMachineResetKey((key) => key + 1);
      setNewTargetServerId(null);
    })();
  }, [editingHubId, newMachineId, newTargetServerId, updatePersona]);

  const handleRemoveMapping = useCallback(
    (machineKey: string) => {
      if (!editingHubId) return;
      void updatePersona((current) => {
        const target = getPersonaHubById(current, editingHubId);
        if (!target) {
          return current;
        }
        const nextMap = { ...target.machineServerMap };
        delete nextMap[machineKey];
        const applied = updatePersonaHubProfile(current, editingHubId, {
          machineServerMap: nextMap,
        });
        return applied.ok ? applied.settings : current;
      });
    },
    [editingHubId, updatePersona],
  );

  const supportsPerHubPartitions = Boolean(getDesktopHost()?.persona?.supportsPerHubPartitions);

  const handleClearHubSession = useCallback(() => {
    if (!editingHub || clearInFlightRef.current) {
      return;
    }
    const normalized = normalizePersonaHubUrl(editingHub.hubUrl);
    if (!normalized.ok) {
      return;
    }
    clearInFlightRef.current = true;
    setClearingTarget("hub");
    void (async () => {
      try {
        const confirmed = await confirmDialog({
          title: t("personaEmbed.settings.clearHubConfirmTitle", { name: editingHub.name }),
          message: t("personaEmbed.settings.clearHubConfirmMessage", {
            host: normalized.displayHost,
          }),
          confirmLabel: t("personaEmbed.settings.clearHubSession"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        await syncPersonaHubEntriesWithMain(collectHostPartitionEntries(persona), {
          enabled: persona.enabled,
        });
        const desktopPersona = getDesktopHost()?.persona;
        const clearSession = desktopPersona?.clearSession;
        if (!clearSession) {
          throw new Error("Electron persona bridge is unavailable");
        }
        const partition = resolvePersonaHubPartition(editingHub.id, {
          basePartition: desktopPersona?.partition,
          partitionPrefix: desktopPersona?.partitionPrefix,
        });
        await clearSession(
          desktopPersona?.supportsPerHubPartitions === true && partition
            ? { partition, hubUrl: normalized.url }
            : normalized.url,
        );
        toast.show(t("personaEmbed.settings.clearHubSuccess", { name: editingHub.name }), {
          variant: "success",
        });
      } catch {
        toast.error(t("personaEmbed.settings.clearError"));
      } finally {
        clearInFlightRef.current = false;
        setClearingTarget(null);
      }
    })();
  }, [editingHub, persona, t, toast]);

  const handleClearAllSession = useCallback(() => {
    if (clearInFlightRef.current) {
      return;
    }
    clearInFlightRef.current = true;
    setClearingTarget("all");
    void (async () => {
      try {
        const confirmed = await confirmDialog({
          title: t("personaEmbed.settings.clearConfirmTitle"),
          message: t("personaEmbed.settings.clearConfirmMessage"),
          confirmLabel: t("personaEmbed.settings.clearSession"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        await syncPersonaHubEntriesWithMain(collectHostPartitionEntries(persona), {
          enabled: persona.enabled,
        });
        const clearSession = getDesktopHost()?.persona?.clearSession;
        if (!clearSession) {
          throw new Error("Electron persona bridge is unavailable");
        }
        await clearSession();
        toast.show(t("personaEmbed.settings.clearSuccess"), { variant: "success" });
      } catch {
        toast.error(t("personaEmbed.settings.clearError"));
      } finally {
        clearInFlightRef.current = false;
        setClearingTarget(null);
      }
    })();
  }, [persona, t, toast]);

  return (
    <View testID="persona-settings-section">
      {/* Section 1: Basic switches & mutual-exclusion guidance */}
      <SettingsSection title={t("personaEmbed.settings.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("personaEmbed.settings.enabledLabel")}</Text>
              <Text style={settingsStyles.rowHint}>{t("personaEmbed.settings.enabledHint")}</Text>
            </View>
            <Switch
              value={persona.enabled}
              onValueChange={handleToggleEnabled}
              accessibilityLabel={t("personaEmbed.settings.enabledLabel")}
              testID="persona-settings-enabled-switch"
            />
          </View>

          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("personaEmbed.settings.hideMainChatLabel")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("personaEmbed.settings.hideMainChatHint")}
              </Text>
            </View>
            <Switch
              value={persona.hideBuiltInMainChatWhenEnabled}
              onValueChange={handleToggleHideMainChat}
              accessibilityLabel={t("personaEmbed.settings.hideMainChatLabel")}
              testID="persona-settings-hide-main-chat-switch"
            />
          </View>
        </View>

        <PersonaMainChatHostStatusList
          statuses={mainChatHostStatuses}
          disablingHostId={disablingHostId}
          retryingHostId={retryingHostId}
          onDisable={handleDisableMainChatOnHost}
          onRetry={handleRetryMainChatHost}
        />
      </SettingsSection>

      {/* Section 2: Multi-Hub profiles list & ordering */}
      <PersonaHubsListSection
        hubs={persona.hubs}
        editingHubId={editingHubId}
        activeHubId={activeHubId}
        secondaryHubId={secondaryHubId}
        splitEnabled={persona.splitEnabled}
        isAddingHub={isAddingHub}
        newHubName={newHubName}
        newHubUrl={newHubUrl}
        newHubFormResetKey={newHubFormResetKey}
        newHubError={newHubError}
        onSelectHub={setSelectedHubId}
        onMoveUp={handleMoveHubUp}
        onMoveDown={handleMoveHubDown}
        onDelete={handleDeleteHub}
        onOpenAdd={handleOpenAddHub}
        onChangeNewName={handleNewHubNameChange}
        onChangeNewUrl={handleNewHubUrlChange}
        onSubmitAdd={handleSubmitAddHub}
        onCancelAdd={handleCancelAddHub}
      />

      {/* Section 3: Selected Hub configuration & health check */}
      {editingHub ? (
        <PersonaSelectedHubEditor
          hub={editingHub}
          hasMultipleHubs={hasMultipleHubs}
          isEditingPrimary={isEditingPrimary}
          isEditingSecondaryInSplit={isEditingSecondaryInSplit}
          displayHost={editingHubDisplayHost}
          hubNameDraft={hubNameDraft}
          hubNameResetKey={hubNameResetKey}
          hubUrlDraft={hubUrlDraft}
          hubUrlResetKey={hubUrlResetKey}
          hubUrlError={hubUrlError}
          isTestingConnection={isTestingCurrentHub}
          healthResult={currentHealthResult}
          onSetActive={handleSetEditingHubActive}
          onOpenInSplit={handleOpenEditingHubInSplit}
          onChangeName={setHubNameDraft}
          onBlurName={handleHubNameBlur}
          onSaveName={handleSaveHubNamePress}
          onChangeUrl={handleHubUrlChange}
          onBlurUrl={handleHubUrlBlur}
          onSaveUrl={handleSaveHubUrlPress}
          onTestConnection={handleTestConnection}
        />
      ) : null}

      {/* Section 4: Embedded experience options */}
      <PersonaEmbedOptionsSection
        isElectron={isElectron}
        hidePersonaSidebar={persona.hidePersonaSidebar}
        interceptSessionClicks={persona.interceptSessionClicks}
        onToggleHidePersonaSidebar={handleToggleHidePersonaSidebar}
        onToggleInterceptClicks={handleToggleInterceptClicks}
      />

      {/* Section 5: Per-Hub machine-to-host mapping table */}
      {editingHub ? (
        <PersonaMappingSection
          editingHub={editingHub}
          hasMultipleHubs={hasMultipleHubs}
          mappingEntries={mappingEntries}
          hostLabelById={hostLabelById}
          newMachineId={newMachineId}
          newMachineResetKey={newMachineResetKey}
          newTargetServerId={newTargetServerId}
          selectedHostDisplay={selectedHostDisplay}
          hostOptions={hostOptions}
          onChangeMachineId={setNewMachineId}
          onChangeTargetServerId={setNewTargetServerId}
          onAddMapping={handleAddMapping}
          onRemoveMapping={handleRemoveMapping}
        />
      ) : null}

      {/* Section 6: Session data management (Electron-only, isolated per Hub + clear all) */}
      {isElectron ? (
        <PersonaSessionDataSection
          editingHub={editingHub}
          editingHubDisplayHost={editingHubDisplayHost}
          hasMultipleHubs={hasMultipleHubs}
          supportsScopedClear={supportsPerHubPartitions}
          clearingTarget={clearingTarget}
          onClearHubSession={handleClearHubSession}
          onClearAllSession={handleClearAllSession}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  warningBanner: {
    marginTop: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  statusBanner: {
    marginTop: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  errorBanner: {
    marginTop: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.statusDanger,
    backgroundColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  warningBannerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 200,
  },
  warningBannerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  hubListRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[2],
  },
  hubListRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  hubListMain: {
    flex: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[3],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[2],
  },
  hubListPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  hubListInfo: {
    gap: 2,
  },
  hubListTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hubListName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  badgePrimary: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.statusSuccessTint,
    borderWidth: 1,
    borderColor: theme.colors.accent,
  },
  badgePrimaryText: {
    color: theme.colors.accent,
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
  },
  badgeSecondary: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  badgeSecondaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
  },
  hubListActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
  },
  addHubForm: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  addHubNameInput: {
    flex: 1,
    minWidth: 160,
  },
  addHubFooter: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
  },
  hubQuickActionsRow: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  fieldLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  hubUrlBlock: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  hubUrlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  hubUrlInputWrap: {
    flex: 1,
    minWidth: 220,
  },
  healthRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  healthOkText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
  },
  healthWarningText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  mappingHeader: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  mappingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  mappingInfo: {
    flex: 1,
    minWidth: 0,
  },
  mappingMachine: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    fontFamily: theme.fontFamily.mono,
  },
  removeButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  addMappingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    flexWrap: "wrap",
  },
  addMappingMachineInput: {
    flex: 1,
    minWidth: 180,
  },
  addMappingHostSelect: {
    flex: 1,
    minWidth: 180,
  },
  addButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
