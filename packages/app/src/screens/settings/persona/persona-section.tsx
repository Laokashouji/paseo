import { isMainChatEnabled } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { AlertTriangle, CheckCircle2, Plus, Trash2, XCircle } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { destroyResidentPersonaWebview } from "@/persona/resident-persona-webview";
import {
  normalizePersonaHubUrl,
  testPersonaHubHealth,
  type PersonaHealthCheckResult,
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

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ActiveMainChatHost {
  serverId: string;
  label: string;
}

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

export function PersonaSettingsSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const persona = usePersonaEmbedSettings();
  const updatePersona = useUpdatePersonaEmbedSettings();
  const isElectron = isElectronRuntime();

  const [hubUrlDraft, setHubUrlDraft] = useState(persona.hubUrl);
  const [hubUrlResetKey, setHubUrlResetKey] = useState(0);
  const [hubUrlError, setHubUrlError] = useState<string | null>(null);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [healthResult, setHealthResult] = useState<PersonaHealthCheckResult | null>(null);

  const [newMachineId, setNewMachineId] = useState("");
  const [newMachineResetKey, setNewMachineResetKey] = useState(0);
  const [newTargetServerId, setNewTargetServerId] = useState<string | null>(null);
  const [disablingHostId, setDisablingHostId] = useState<string | null>(null);
  const [isClearingSession, setIsClearingSession] = useState(false);
  const clearInFlightRef = useRef(false);

  useEffect(() => {
    setHubUrlDraft(persona.hubUrl);
    setHubUrlResetKey((key) => key + 1);
  }, [persona.hubUrl]);

  // Stable deep-equal selectors: detect connected hosts whose built-in Main Chat is still active.
  const mainChatEnabledServerIds = useStoreWithEqualityFn(
    useMainChatSettingsStore,
    useCallback(
      (state) =>
        hosts
          .filter((host) => isMainChatEnabled(state.settingsByServerId[host.serverId]))
          .map((host) => host.serverId),
      [hosts],
    ),
    equal,
  );

  const onlineServerIds = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        hosts
          .filter((host) => Boolean(state.sessions[host.serverId]?.client))
          .map((host) => host.serverId),
      [hosts],
    ),
    equal,
  );

  const activeMainChatHosts = useMemo<ActiveMainChatHost[]>(() => {
    if (!persona.enabled || mainChatEnabledServerIds.length === 0) {
      return [];
    }
    const onlineSet = new Set(onlineServerIds);
    const hostLabelById = new Map(hosts.map((host) => [host.serverId, host.label]));
    return mainChatEnabledServerIds
      .filter((serverId) => onlineSet.has(serverId))
      .map((serverId) => ({
        serverId,
        label: hostLabelById.get(serverId) ?? serverId,
      }));
  }, [hosts, mainChatEnabledServerIds, onlineServerIds, persona.enabled]);

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

  const mappingEntries = useMemo(
    () =>
      Object.entries(persona.machineServerMap).sort(([left], [right]) => left.localeCompare(right)),
    [persona.machineServerMap],
  );

  const handleToggleEnabled = useCallback(
    (nextEnabled: boolean) => {
      void (async () => {
        await updatePersona({ enabled: nextEnabled });
        if (!nextEnabled) {
          destroyResidentPersonaWebview();
          void getDesktopHost()
            ?.persona?.setHubUrl?.(null)
            .catch(() => undefined);
        } else {
          const normalized = normalizePersonaHubUrl(persona.hubUrl);
          if (normalized.ok) {
            void getDesktopHost()
              ?.persona?.setHubUrl?.(normalized.url)
              .catch(() => undefined);
          }
        }
      })();
    },
    [persona.hubUrl, updatePersona],
  );

  const handleToggleHideMainChat = useCallback(
    (nextValue: boolean) => {
      void updatePersona({ hideBuiltInMainChatWhenEnabled: nextValue });
    },
    [updatePersona],
  );

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

  const commitHubUrl = useCallback(
    async (showToast: boolean): Promise<string | null> => {
      const normalized = normalizePersonaHubUrl(hubUrlDraft);
      if (!normalized.ok) {
        setHubUrlError(t("personaEmbed.error.invalidUrl"));
        return null;
      }
      setHubUrlError(null);
      setHubUrlDraft(normalized.url);
      if (normalized.url !== persona.hubUrl) {
        await updatePersona({ hubUrl: normalized.url });
        void getDesktopHost()
          ?.persona?.setHubUrl?.(normalized.url)
          .catch(() => undefined);
        if (showToast) {
          toast.show(t("personaEmbed.settings.urlSavedToast"), { variant: "success" });
        }
      }
      return normalized.url;
    },
    [hubUrlDraft, persona.hubUrl, t, toast, updatePersona],
  );

  const handleHubUrlChange = useCallback(
    (value: string) => {
      setHubUrlDraft(value);
      if (hubUrlError) {
        setHubUrlError(null);
      }
      if (healthResult) {
        setHealthResult(null);
      }
    },
    [healthResult, hubUrlError],
  );

  const handleHubUrlBlur = useCallback(() => {
    void commitHubUrl(false);
  }, [commitHubUrl]);

  const handleSaveHubUrlPress = useCallback(() => {
    void commitHubUrl(true);
  }, [commitHubUrl]);

  const handleTestConnection = useCallback(() => {
    void (async () => {
      const normalized = normalizePersonaHubUrl(hubUrlDraft);
      if (!normalized.ok) {
        setHubUrlError(t("personaEmbed.error.invalidUrl"));
        setHealthResult(null);
        return;
      }
      setHubUrlError(null);
      setHubUrlDraft(normalized.url);
      if (normalized.url !== persona.hubUrl) {
        await updatePersona({ hubUrl: normalized.url });
        void getDesktopHost()
          ?.persona?.setHubUrl?.(normalized.url)
          .catch(() => undefined);
      }

      setIsTestingConnection(true);
      try {
        const result = await testPersonaHubHealth(normalized.url);
        setHealthResult(result);
      } finally {
        setIsTestingConnection(false);
      }
    })();
  }, [hubUrlDraft, persona.hubUrl, t, updatePersona]);

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
    const machineKey = newMachineId.trim();
    const serverId = newTargetServerId?.trim() ?? "";
    if (!machineKey || !serverId) {
      return;
    }
    void (async () => {
      await updatePersona({
        machineServerMap: {
          ...persona.machineServerMap,
          [machineKey]: serverId,
        },
      });
      setNewMachineId("");
      setNewMachineResetKey((key) => key + 1);
      setNewTargetServerId(null);
    })();
  }, [newMachineId, newTargetServerId, persona.machineServerMap, updatePersona]);

  const handleRemoveMapping = useCallback(
    (machineKey: string) => {
      const next = { ...persona.machineServerMap };
      delete next[machineKey];
      void updatePersona({ machineServerMap: next });
    },
    [persona.machineServerMap, updatePersona],
  );

  const handleClearSession = useCallback(() => {
    if (clearInFlightRef.current) {
      return;
    }
    clearInFlightRef.current = true;
    setIsClearingSession(true);
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
        setIsClearingSession(false);
      }
    })();
  }, [t, toast]);

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

        {activeMainChatHosts.map((host) => (
          <ActiveMainChatHostBanner
            key={host.serverId}
            host={host}
            disabling={disablingHostId === host.serverId}
            onDisable={handleDisableMainChatOnHost}
          />
        ))}
      </SettingsSection>

      {/* Section 2: Persona Hub URL & health check */}
      <SettingsSection title={t("personaEmbed.settings.hubUrlLabel")}>
        <View style={settingsStyles.card}>
          <View style={styles.hubUrlBlock}>
            <View style={styles.hubUrlRow}>
              <View style={styles.hubUrlInputWrap}>
                <FormTextInput
                  initialValue={hubUrlDraft}
                  resetKey={hubUrlResetKey}
                  onChangeText={handleHubUrlChange}
                  onBlur={handleHubUrlBlur}
                  placeholder={t("personaEmbed.settings.hubUrlPlaceholder")}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel={t("personaEmbed.settings.hubUrlLabel")}
                  testID="persona-settings-hub-url-input"
                />
              </View>
              <Button
                variant="outline"
                onPress={handleSaveHubUrlPress}
                testID="persona-settings-save-url"
              >
                {t("personaEmbed.settings.saveUrl")}
              </Button>
              <Button
                variant="outline"
                loading={isTestingConnection}
                disabled={isTestingConnection}
                onPress={handleTestConnection}
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

            {healthResult ? (
              <View style={styles.healthRow} testID="persona-settings-health-result">
                {healthResult.ok ? (
                  <>
                    <ThemedCheckCircle size={15} uniProps={successIconMapping} />
                    <Text style={styles.healthOkText}>
                      {t("personaEmbed.settings.connectionOk", {
                        hubName: healthResult.hubName,
                        version: healthResult.version,
                      })}{" "}
                      · {healthResult.latencyMs}ms
                    </Text>
                  </>
                ) : (
                  <>
                    <ThemedXCircle size={15} uniProps={dangerIconMapping} />
                    <Text style={settingsStyles.rowError}>
                      {t("personaEmbed.settings.connectionFailed", {
                        error: healthResult.error,
                      })}
                    </Text>
                  </>
                )}
              </View>
            ) : null}
          </View>
        </View>
      </SettingsSection>

      {/* Section 3: Embedded experience options */}
      <SettingsSection title={t("personaEmbed.settings.embedOptionsTitle")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("personaEmbed.settings.hideSidebarLabel")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("personaEmbed.settings.hideSidebarHint")}
                {!isElectron ? ` (${t("personaEmbed.settings.desktopOnlyHint")})` : ""}
              </Text>
            </View>
            <Switch
              value={persona.hidePersonaSidebar}
              disabled={!isElectron}
              onValueChange={handleToggleHidePersonaSidebar}
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
                {!isElectron ? ` (${t("personaEmbed.settings.desktopOnlyHint")})` : ""}
              </Text>
            </View>
            <Switch
              value={persona.interceptSessionClicks}
              disabled={!isElectron}
              onValueChange={handleToggleInterceptClicks}
              accessibilityLabel={t("personaEmbed.settings.interceptClicksLabel")}
              testID="persona-settings-intercept-clicks-switch"
            />
          </View>
        </View>
      </SettingsSection>

      {/* Section 4: Machine-to-host mapping table */}
      <SettingsSection title={t("personaEmbed.settings.mappingTitle")}>
        <View style={settingsStyles.card}>
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
                onRemove={handleRemoveMapping}
              />
            ))
          )}

          <View style={[styles.addMappingRow, settingsStyles.rowBorder]}>
            <View style={styles.addMappingMachineInput}>
              <FormTextInput
                initialValue={newMachineId}
                resetKey={newMachineResetKey}
                onChangeText={setNewMachineId}
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
                onChange={setNewTargetServerId}
                placeholder={t("personaEmbed.settings.mappingHostPlaceholder")}
                emptyText={t("common.empty.noResults")}
                field={false}
                triggerTestID="persona-settings-mapping-host-select"
              />
            </View>
            <Button
              variant="outline"
              disabled={!newMachineId.trim() || !newTargetServerId}
              onPress={handleAddMapping}
              testID="persona-settings-mapping-add"
            >
              <ThemedPlus size={14} uniProps={mutedIconMapping} />
              <Text style={styles.addButtonText}>{t("personaEmbed.settings.mappingAdd")}</Text>
            </Button>
          </View>
        </View>
      </SettingsSection>

      {/* Section 5: Session data management (Electron-only) */}
      {isElectron ? (
        <SettingsSection title={t("personaEmbed.settings.sessionDataTitle")}>
          <View style={settingsStyles.card}>
            <View style={settingsStyles.row}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("personaEmbed.settings.sessionDataTitle")}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {t("personaEmbed.settings.sessionDataHint")}
                </Text>
              </View>
              <Button
                variant="outline"
                loading={isClearingSession}
                disabled={isClearingSession}
                onPress={handleClearSession}
                testID="persona-settings-clear-session"
              >
                {isClearingSession
                  ? t("personaEmbed.settings.clearingSession")
                  : t("personaEmbed.settings.clearSession")}
              </Button>
            </View>
          </View>
        </SettingsSection>
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
