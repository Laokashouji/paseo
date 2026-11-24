import {
  MAIN_CHAT_MAX_LIMIT_FALLBACKS,
  formatMainChatModelSpec,
  resolveMainChatLimitFallbacks,
  type MainChatLimitFallbackEntry,
  type MainChatLimitFallbackEvent,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { Plus, ShieldAlert } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedPlus = withUnistyles(Plus);
const ThemedShield = withUnistyles(ShieldAlert);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ADD_ICON = <ThemedPlus size={13} uniProps={mutedIconMapping} />;

function fallbackEntryKey(entry: MainChatLimitFallbackEntry): string {
  return `${entry.provider.toLowerCase()}::${(entry.model ?? "").toLowerCase()}`;
}

const FallbackOrderRow = memo(function FallbackOrderRow({
  entry,
  index,
  total,
  disabled,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  entry: MainChatLimitFallbackEntry;
  index: number;
  total: number;
  disabled: boolean;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onRemove: (index: number) => void;
}): ReactElement {
  const { t } = useTranslation();
  const spec = formatMainChatModelSpec(entry.provider, entry.model);

  const handleUp = useCallback(() => onMoveUp(index), [index, onMoveUp]);
  const handleDown = useCallback(() => onMoveDown(index), [index, onMoveDown]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);

  return (
    <View
      style={[styles.entryRow, index > 0 && styles.entryRowBorder]}
      testID={`limit-fallback-row-${index}`}
    >
      <View style={styles.entryMain}>
        <StatusBadge
          variant="muted"
          size="xs"
          label={t("mainChat.limitFallbacks.priorityBadge", { index: index + 1 })}
        />
        <View style={styles.entryTextCol}>
          <Text style={styles.entrySpec} numberOfLines={1} ellipsizeMode="tail">
            {entry.label?.trim() || spec}
          </Text>
          {entry.label?.trim() ? (
            <Text style={styles.entrySubSpec} numberOfLines={1}>
              {spec}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.entryControls}>
        <PressHighlight
          onPress={handleUp}
          disabled={disabled || index === 0}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.limitFallbacks.moveUpLabel", { model: spec })}
          style={[styles.iconButton, index === 0 && styles.iconButtonDisabled]}
          highlightStyle={styles.subtleHighlight}
          testID={`limit-fallback-up-${index}`}
        >
          <Text style={styles.controlGlyph}>↑</Text>
        </PressHighlight>
        <PressHighlight
          onPress={handleDown}
          disabled={disabled || index >= total - 1}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.limitFallbacks.moveDownLabel", { model: spec })}
          style={[styles.iconButton, index >= total - 1 && styles.iconButtonDisabled]}
          highlightStyle={styles.subtleHighlight}
          testID={`limit-fallback-down-${index}`}
        >
          <Text style={styles.controlGlyph}>↓</Text>
        </PressHighlight>
        <PressHighlight
          onPress={handleRemove}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.limitFallbacks.removeLabel", { model: spec })}
          style={[styles.removeChipButton]}
          highlightStyle={styles.subtleHighlight}
          testID={`limit-fallback-remove-${index}`}
        >
          <Text style={styles.removeChipText}>
            {t("mainChat.limitFallbacks.removeShortButton")}
          </Text>
        </PressHighlight>
      </View>
    </View>
  );
});

export interface MainChatLimitFallbacksPanelProps {
  serverId: string;
  settings: MainChatSettings;
  recentEvents?: readonly MainChatLimitFallbackEvent[];
  disabled: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => Promise<void> | void;
}

/**
 * Main Chat Settings panel for P0-5: configures ordered `limitFallbacks` backup models for
 * automatic anti-loop switching on Main Chat and managed subtasks when usage/rate limits hit.
 */
export const MainChatLimitFallbacksPanel = memo(function MainChatLimitFallbacksPanel({
  serverId,
  settings,
  recentEvents,
  disabled,
  onApplyPatch,
}: MainChatLimitFallbacksPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const fallbacks = useMemo(() => resolveMainChatLimitFallbacks(settings), [settings]);
  const { entries: providerEntries } = useProvidersSnapshot(serverId, {
    enabled: Boolean(serverId),
  });
  const enabledProviders = useMemo(
    () => (providerEntries ?? []).filter((entry) => entry.enabled),
    [providerEntries],
  );

  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [customSpecDraft, setCustomSpecDraft] = useState<string>("");
  const [customResetNonce, setCustomResetNonce] = useState(0);

  const activeProviderEntry = useMemo(
    () =>
      enabledProviders.find((entry) => entry.provider === selectedProviderId) ??
      enabledProviders[0] ??
      null,
    [enabledProviders, selectedProviderId],
  );

  const activeModelDef = useMemo(() => {
    const models = activeProviderEntry?.models ?? [];
    return (
      models.find((m) => m.id === selectedModelId) ??
      models.find((m) => m.isDefault) ??
      models[0] ??
      null
    );
  }, [activeProviderEntry, selectedModelId]);

  const providerOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      enabledProviders.map((entry) => ({
        id: entry.provider,
        value: entry.provider,
        label: entry.label || entry.provider,
      })),
    [enabledProviders],
  );

  const modelOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      (activeProviderEntry?.models ?? []).map((model) => ({
        id: model.id,
        value: model.id,
        label: model.label || model.id,
        description: model.id !== model.label ? model.id : undefined,
      })),
    [activeProviderEntry],
  );

  const selectedProviderDisplay = useMemo(
    () =>
      activeProviderEntry
        ? { label: activeProviderEntry.label || activeProviderEntry.provider }
        : null,
    [activeProviderEntry],
  );
  const selectedModelDisplay = useMemo(
    () => (activeModelDef ? { label: activeModelDef.label || activeModelDef.id } : null),
    [activeModelDef],
  );

  const handleProviderChange = useCallback(
    (provider: string) => {
      setSelectedProviderId(provider);
      const next = enabledProviders.find((entry) => entry.provider === provider);
      const nextModel = next?.models?.find((m) => m.isDefault)?.id ?? next?.models?.[0]?.id ?? "";
      setSelectedModelId(nextModel);
    },
    [enabledProviders],
  );

  const persistFallbacks = useCallback(
    (next: MainChatLimitFallbackEntry[]) => {
      void onApplyPatch({ limitFallbacks: next }, t("mainChat.limitFallbacks.savedToast"));
    },
    [onApplyPatch, t],
  );

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index <= 0 || index >= fallbacks.length) return;
      const next = [...fallbacks];
      const item = next[index]!;
      next[index] = next[index - 1]!;
      next[index - 1] = item;
      persistFallbacks(next);
    },
    [fallbacks, persistFallbacks],
  );

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index < 0 || index >= fallbacks.length - 1) return;
      const next = [...fallbacks];
      const item = next[index]!;
      next[index] = next[index + 1]!;
      next[index + 1] = item;
      persistFallbacks(next);
    },
    [fallbacks, persistFallbacks],
  );

  const handleRemove = useCallback(
    (index: number) => {
      const next = fallbacks.filter((_, i) => i !== index);
      persistFallbacks(next);
    },
    [fallbacks, persistFallbacks],
  );

  const handleAddFallback = useCallback(() => {
    if (fallbacks.length >= MAIN_CHAT_MAX_LIMIT_FALLBACKS) {
      toast.error(
        t("mainChat.limitFallbacks.maxReachedHint", { max: MAIN_CHAT_MAX_LIMIT_FALLBACKS }),
      );
      return;
    }

    let candidate: MainChatLimitFallbackEntry | null = null;
    const trimmedCustom = customSpecDraft.trim();
    if (trimmedCustom) {
      const slashIdx = trimmedCustom.indexOf("/");
      const provider = slashIdx > 0 ? trimmedCustom.slice(0, slashIdx).trim() : trimmedCustom;
      const model = slashIdx > 0 ? trimmedCustom.slice(slashIdx + 1).trim() || null : null;
      if (provider) {
        candidate = { provider, model };
      }
    } else if (activeProviderEntry) {
      candidate = {
        provider: activeProviderEntry.provider,
        model: activeModelDef?.id ?? null,
        ...(activeModelDef?.label ? { label: activeModelDef.label } : {}),
      };
    }

    if (!candidate) {
      toast.error(t("mainChat.limitFallbacks.invalidSpecToast"));
      return;
    }

    const candidateKey = fallbackEntryKey(candidate);
    if (fallbacks.some((existing) => fallbackEntryKey(existing) === candidateKey)) {
      toast.show(t("mainChat.limitFallbacks.duplicateToast"), { variant: "info" });
      return;
    }

    setCustomSpecDraft("");
    setCustomResetNonce((n) => n + 1);
    persistFallbacks([...fallbacks, candidate]);
  }, [activeModelDef, activeProviderEntry, customSpecDraft, fallbacks, persistFallbacks, t, toast]);

  const atLimit = fallbacks.length >= MAIN_CHAT_MAX_LIMIT_FALLBACKS;

  return (
    <View style={settingsStyles.card} testID="main-chat-limit-fallbacks-panel">
      {/* Ordered fallback list */}
      {fallbacks.length === 0 ? (
        <View style={[settingsStyles.row, styles.emptyBox]} testID="limit-fallbacks-empty">
          <Text style={styles.emptyText}>{t("mainChat.limitFallbacks.emptyState")}</Text>
        </View>
      ) : (
        <View style={styles.listWrap} testID="limit-fallbacks-list">
          {fallbacks.map((entry, index) => (
            <FallbackOrderRow
              key={fallbackEntryKey(entry)}
              entry={entry}
              index={index}
              total={fallbacks.length}
              disabled={disabled}
              onMoveUp={handleMoveUp}
              onMoveDown={handleMoveDown}
              onRemove={handleRemove}
            />
          ))}
        </View>
      )}

      {/* Add fallback controls */}
      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.addSection]}>
        <View style={styles.addHeader}>
          <ThemedShield size={14} uniProps={mutedIconMapping} />
          <Text style={settingsStyles.rowTitle}>{t("mainChat.limitFallbacks.addTitle")}</Text>
          <Text style={styles.limitHint}>
            {t("mainChat.limitFallbacks.maxReachedHint", { max: MAIN_CHAT_MAX_LIMIT_FALLBACKS })}
          </Text>
        </View>

        {providerOptions.length > 0 ? (
          <View style={styles.selectRow}>
            <View style={styles.selectCol}>
              <SelectField
                size="sm"
                label={t("mainChat.limitFallbacks.providerLabel")}
                options={providerOptions}
                value={activeProviderEntry?.provider ?? null}
                selectedDisplay={selectedProviderDisplay}
                placeholder={t("mainChat.settings.backgroundModel.providerPlaceholder")}
                emptyText={t("mainChat.settings.backgroundModel.noProviders")}
                onChange={handleProviderChange}
                disabled={disabled || atLimit}
              />
            </View>
            {modelOptions.length > 0 ? (
              <View style={styles.selectCol}>
                <SelectField
                  size="sm"
                  label={t("mainChat.limitFallbacks.modelLabel")}
                  options={modelOptions}
                  value={activeModelDef?.id ?? null}
                  selectedDisplay={selectedModelDisplay}
                  placeholder={t("mainChat.settings.backgroundModel.modelPlaceholder")}
                  emptyText={t("mainChat.settings.backgroundModel.noModels")}
                  onChange={setSelectedModelId}
                  disabled={disabled || atLimit}
                />
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.customAddRow}>
          <FormTextInput
            size="sm"
            style={styles.customSpecInput}
            initialValue=""
            resetKey={`${serverId}:lfb:${customResetNonce}`}
            onChangeText={setCustomSpecDraft}
            placeholder={t("mainChat.limitFallbacks.customSpecPlaceholder")}
            returnKeyType="done"
            onSubmitEditing={handleAddFallback}
            editable={!disabled && !atLimit}
            testID="limit-fallbacks-custom-input"
          />
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ADD_ICON}
            onPress={handleAddFallback}
            disabled={disabled || atLimit}
            testID="limit-fallbacks-add-button"
          >
            {t("mainChat.limitFallbacks.addButton")}
          </Button>
        </View>
      </View>

      {recentEvents && recentEvents.length > 0 ? (
        <View
          style={[settingsStyles.row, settingsStyles.rowBorder, styles.recentSection]}
          testID="limit-fallbacks-recent"
        >
          <Text style={styles.recentTitle}>{t("mainChat.limitFallbacks.recentTitle")}</Text>
          {recentEvents.slice(0, 4).map((evt) => (
            <View key={evt.id} style={styles.recentRow}>
              <StatusBadge
                variant="muted"
                size="xs"
                label={
                  evt.agentRole === "main"
                    ? t("mainChat.limitFallbacks.roleMain")
                    : t("mainChat.limitFallbacks.roleManagedTask")
                }
              />
              <Text style={styles.recentText} numberOfLines={1} ellipsizeMode="tail">
                {formatMainChatModelSpec(evt.fromProvider, evt.fromModel)} →{" "}
                {formatMainChatModelSpec(evt.toProvider, evt.toModel)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  emptyBox: {
    paddingVertical: theme.spacing[3.5],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  listWrap: {
    width: "100%",
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  entryRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  entryMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  entryTextCol: {
    flex: 1,
    minWidth: 0,
  },
  entrySpec: {
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  entrySubSpec: {
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.foregroundMuted,
  },
  entryControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonDisabled: {
    opacity: 0.4,
  },
  controlGlyph: {
    fontSize: 13,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  removeChipButton: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  removeChipText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.destructive,
  },
  subtleHighlight: {
    backgroundColor: theme.colors.surface2,
  },
  addSection: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  addHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  limitHint: {
    marginLeft: "auto",
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  selectRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  selectCol: {
    flex: 1,
    minWidth: 160,
  },
  customAddRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  customSpecInput: {
    flex: 1,
    minWidth: 180,
  },
  recentSection: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.surface0,
  },
  recentTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  recentText: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foreground,
  },
}));
