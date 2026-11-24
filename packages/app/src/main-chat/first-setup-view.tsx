import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { Settings, Sparkles } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getAgentModeIcon, ThinkingIcon } from "@/agent-controls/icons";
import { formatAgentModeLabel, formatThinkingOptionLabel } from "@/agent-controls/labels";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { ModelProviderGlyph } from "@/components/model-browser";
import { Button } from "@/components/ui/button";
import { DensityIcon } from "@/components/ui/density-icon";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import {
  buildMainChatFirstSetupSubmission,
  getModelThinkingOptions,
  getProviderAvailableModes,
  reconcileModeId,
  reconcileThinkingOptionId,
  resolveDefaultModeId,
  resolveDefaultThinkingOptionId,
  resolveModelDefinitionFromEntry,
  resolveProviderSnapshotEntryByProvider,
  type MainChatFirstSetupSelection,
} from "./first-setup-options";

export type { MainChatFirstSetupSelection };

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedSettings = withUnistyles(Settings);

const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });

const SetupModelTrigger = memo(function SetupModelTrigger({
  selectedProvider,
  selectedModelLabel,
  serverId,
  placeholder,
  hovered,
  active,
  disabled,
  loading,
}: {
  selectedProvider: string;
  selectedModelLabel: string;
  serverId: string;
  placeholder: string;
  hovered: boolean;
  active: boolean;
  disabled: boolean;
  loading: boolean;
}): ReactElement {
  const display = useMemo(
    () => (selectedProvider ? { label: selectedModelLabel } : null),
    [selectedModelLabel, selectedProvider],
  );
  const leading = useMemo(
    () =>
      selectedProvider ? (
        <ModelProviderGlyph
          provider={selectedProvider}
          serverId={serverId}
          size={ICON_SIZE.sm}
          tone="muted"
        />
      ) : null,
    [selectedProvider, serverId],
  );

  return (
    <SelectFieldTrigger
      display={display}
      placeholder={placeholder}
      hovered={hovered}
      active={active}
      disabled={disabled}
      loading={loading}
      leading={leading}
    />
  );
});

export interface MainChatFirstSetupViewProps {
  serverId: string;
  title: string;
  starting: boolean;
  errorMessage: string | null;
  onStart: (selection: MainChatFirstSetupSelection) => void;
  onOpenProviderSettings: () => void;
}

export function MainChatFirstSetupView({
  serverId,
  title,
  starting,
  errorMessage,
  onStart,
  onOpenProviderSettings,
}: MainChatFirstSetupViewProps): ReactElement {
  const { t } = useTranslation();
  const snapshot = useProvidersSnapshot(serverId);
  const providerDefinitions = useMemo(
    () => buildProviderDefinitions(snapshot.entries),
    [snapshot.entries],
  );
  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinkingOptionId, setSelectedThinkingOptionId] = useState<string>("");
  const [selectedModeId, setSelectedModeId] = useState<string>("");

  useEffect(() => {
    setSelectedProvider("");
    setSelectedModel("");
    setSelectedThinkingOptionId("");
    setSelectedModeId("");
  }, [serverId]);

  const providers = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(snapshot.entries, {
        selectedProvider: selectedProvider || null,
      }),
    [selectedProvider, snapshot.entries],
  );

  const selectedProviderEntry = useMemo(
    () => resolveProviderSnapshotEntryByProvider(snapshot.entries, selectedProvider),
    [selectedProvider, snapshot.entries],
  );
  const selectedModelDef = useMemo(
    () => resolveModelDefinitionFromEntry(selectedProviderEntry, selectedModel),
    [selectedModel, selectedProviderEntry],
  );
  const rawThinkingOptions = useMemo(
    () => getModelThinkingOptions(selectedModelDef),
    [selectedModelDef],
  );
  const rawModes = useMemo(
    () => getProviderAvailableModes(selectedProviderEntry),
    [selectedProviderEntry],
  );

  const effectiveThinkingOptionId = useMemo(
    () =>
      selectedProvider ? reconcileThinkingOptionId(selectedThinkingOptionId, selectedModelDef) : "",
    [selectedModelDef, selectedProvider, selectedThinkingOptionId],
  );
  const effectiveModeId = useMemo(
    () => (selectedProvider ? reconcileModeId(selectedModeId, selectedProviderEntry) : ""),
    [selectedModeId, selectedProvider, selectedProviderEntry],
  );

  useEffect(() => {
    if (!selectedProvider) return;
    if (effectiveThinkingOptionId !== selectedThinkingOptionId) {
      setSelectedThinkingOptionId(effectiveThinkingOptionId);
    }
  }, [effectiveThinkingOptionId, selectedProvider, selectedThinkingOptionId]);

  useEffect(() => {
    if (!selectedProvider) return;
    if (effectiveModeId !== selectedModeId) {
      setSelectedModeId(effectiveModeId);
    }
  }, [effectiveModeId, selectedModeId, selectedProvider]);

  const thinkingFieldOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      rawThinkingOptions.map((option) => ({
        id: option.id,
        value: option.id,
        label: formatThinkingOptionLabel(option),
        description: option.description,
        testID: `main-chat-first-setup-thinking-option-${option.id}`,
      })),
    [rawThinkingOptions],
  );

  const modeFieldOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      rawModes.map((mode) => ({
        id: mode.id,
        value: mode.id,
        label: formatAgentModeLabel(mode),
        description: mode.description,
        testID: `main-chat-first-setup-mode-option-${mode.id}`,
      })),
    [rawModes],
  );

  const selectedThinkingDisplay = useMemo(() => {
    const matched = thinkingFieldOptions.find(
      (option) => option.value === effectiveThinkingOptionId,
    );
    return matched ? { label: matched.label, description: matched.description } : null;
  }, [effectiveThinkingOptionId, thinkingFieldOptions]);

  const selectedModeDisplay = useMemo(() => {
    const matched = modeFieldOptions.find((option) => option.value === effectiveModeId);
    return matched ? { label: matched.label, description: matched.description } : null;
  }, [effectiveModeId, modeFieldOptions]);

  const thinkingTriggerIcon = useMemo(
    () => <DensityIcon icon={ThinkingIcon} size="sm" color="foregroundMuted" />,
    [],
  );

  const modeIconComponent = useMemo(
    () =>
      selectedProvider && effectiveModeId
        ? getAgentModeIcon(selectedProvider, effectiveModeId, providerDefinitions)
        : null,
    [effectiveModeId, providerDefinitions, selectedProvider],
  );

  const modeTriggerIcon = useMemo(
    () =>
      modeIconComponent ? (
        <DensityIcon icon={modeIconComponent} size="sm" color="foregroundMuted" />
      ) : null,
    [modeIconComponent],
  );

  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      const nextEntry = resolveProviderSnapshotEntryByProvider(snapshot.entries, provider);
      const nextModelDef = resolveModelDefinitionFromEntry(nextEntry, modelId);
      const nextThinkingId = resolveDefaultThinkingOptionId(nextModelDef);
      const providerChanged = provider !== selectedProvider;
      const nextModeId =
        !providerChanged &&
        selectedModeId &&
        nextEntry?.modes?.some((mode) => mode.id === selectedModeId)
          ? selectedModeId
          : resolveDefaultModeId(nextEntry);

      setSelectedProvider(provider);
      setSelectedModel(modelId);
      setSelectedThinkingOptionId(nextThinkingId);
      setSelectedModeId(nextModeId);
    },
    [selectedModeId, selectedProvider, snapshot.entries],
  );

  const handleSelectThinking = useCallback((value: string) => {
    setSelectedThinkingOptionId(value);
  }, []);

  const handleSelectMode = useCallback((value: string) => {
    setSelectedModeId(value);
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
    const submission = buildMainChatFirstSetupSubmission({
      provider: selectedProvider,
      model: selectedModel,
      thinkingOptionId: effectiveThinkingOptionId,
      modeId: effectiveModeId,
      entry: selectedProviderEntry,
    });
    if (!submission) return;
    onStart(submission);
  }, [
    effectiveModeId,
    effectiveThinkingOptionId,
    onStart,
    selectedModel,
    selectedProvider,
    selectedProviderEntry,
    starting,
  ]);

  const isSnapshotLoading = Boolean(snapshot.isLoading || snapshot.isFetching);
  const hasNoProviders = !isSnapshotLoading && providers.length === 0;
  const showThinkingField = Boolean(selectedProvider && thinkingFieldOptions.length > 0);
  const showModeField = Boolean(selectedProvider && modeFieldOptions.length > 0);

  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled: triggerDisabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }) => (
      <SetupModelTrigger
        selectedProvider={selectedProvider}
        selectedModelLabel={selectedModelLabel}
        serverId={serverId}
        placeholder={t("mainChat.firstSetup.modelPlaceholder")}
        hovered={hovered}
        active={pressed || isOpen}
        disabled={triggerDisabled}
        loading={isSnapshotLoading}
      />
    ),
    [isSnapshotLoading, selectedProvider, serverId, t],
  );

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
            triggerFill
            renderTrigger={renderModelTrigger}
          />
        </View>

        {showThinkingField ? (
          <View style={styles.setupField} testID="main-chat-first-setup-thinking-field">
            <Text style={styles.setupFieldLabel}>{t("mainChat.firstSetup.thinkingLabel")}</Text>
            <SelectField
              field={false}
              label={t("mainChat.firstSetup.thinkingLabel")}
              value={effectiveThinkingOptionId || null}
              selectedDisplay={selectedThinkingDisplay}
              options={thinkingFieldOptions}
              onChange={handleSelectThinking}
              placeholder={t("mainChat.firstSetup.thinkingPlaceholder")}
              emptyText={t("mainChat.firstSetup.noThinkingOptions")}
              disabled={starting}
              triggerLeading={thinkingTriggerIcon}
              triggerTestID="main-chat-first-setup-thinking"
            />
          </View>
        ) : null}

        {showModeField ? (
          <View style={styles.setupField} testID="main-chat-first-setup-mode-field">
            <Text style={styles.setupFieldLabel}>{t("mainChat.firstSetup.modeLabel")}</Text>
            <SelectField
              field={false}
              label={t("mainChat.firstSetup.modeLabel")}
              value={effectiveModeId || null}
              selectedDisplay={selectedModeDisplay}
              options={modeFieldOptions}
              onChange={handleSelectMode}
              placeholder={t("mainChat.firstSetup.modePlaceholder")}
              emptyText={t("mainChat.firstSetup.noModes")}
              disabled={starting}
              triggerLeading={modeTriggerIcon}
              triggerTestID="main-chat-first-setup-mode"
            />
            {selectedModeDisplay?.description ? (
              <Text style={styles.setupFieldHint} testID="main-chat-first-setup-mode-hint">
                {selectedModeDisplay.description}
              </Text>
            ) : null}
          </View>
        ) : null}

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

const styles = StyleSheet.create((theme) => ({
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
  setupFieldHint: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    lineHeight: 16,
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
}));
