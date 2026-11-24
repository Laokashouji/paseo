import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_BUILTIN_MODEL_PROFILE_IDS,
  MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES,
  MAIN_CHAT_MODEL_PURPOSES,
  isBuiltinMainChatModelProfileId,
  resolveBuiltinMainChatModelProfiles,
  resolveMainChatModelConfig,
  resolveMainChatModelSlot,
  type MainChatBuiltinModelProfileId,
  type MainChatModelProfile,
  type MainChatModelPurpose,
  type MainChatModelSlotBinding,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { Cpu, History, Plus, RotateCcw, Trash2 } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedCpu = withUnistyles(Cpu);
const ThemedHistory = withUnistyles(History);
const ThemedPlus = withUnistyles(Plus);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const ROLLBACK_ICON = <ThemedRotateCcw size={13} uniProps={mutedIconMapping} />;
const PLUS_ICON = <ThemedPlus size={13} uniProps={mutedIconMapping} />;
const TRASH_ICON = <ThemedTrash2 size={13} uniProps={dangerIconMapping} />;

function formatSlotSpec(binding: MainChatModelSlotBinding | null): string {
  if (!binding) return "—";
  const base = binding.model ? `${binding.provider}/${binding.model}` : binding.provider;
  return binding.thinkingOptionId ? `${base} · ${binding.thinkingOptionId}` : base;
}

function resolveProfileDisplayName(
  profileId: string | null | undefined,
  customProfiles: readonly MainChatModelProfile[],
  t: (key: string) => string,
): string {
  if (!profileId) return "—";
  if (isBuiltinMainChatModelProfileId(profileId)) {
    return t(`mainChat.modelProfiles.profiles.${profileId}.name`);
  }
  const matched = customProfiles.find((entry) => entry.id === profileId);
  return matched?.name ?? profileId;
}

function slotBadgeVariant(source: string): StatusBadgeVariant {
  if (source === "explicit") return "success";
  return "muted";
}

export interface MainChatModelProfilesPanelProps {
  serverId: string;
  client: DaemonClient | null;
  settings: MainChatSettings;
  disabled?: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => void;
}

interface SlotRowProps {
  purpose: MainChatModelPurpose;
  settings: MainChatSettings;
  isFirst: boolean;
  editing: boolean;
  disabled: boolean;
  onStartEdit: (purpose: MainChatModelPurpose) => void;
  onCancelEdit: () => void;
  onSaveSlot: (purpose: MainChatModelPurpose, binding: MainChatModelSlotBinding | null) => void;
}

const ModelSlotRow = memo(function ModelSlotRow({
  purpose,
  settings,
  isFirst,
  editing,
  disabled,
  onStartEdit,
  onCancelEdit,
  onSaveSlot,
}: SlotRowProps): ReactElement {
  const { t } = useTranslation();
  const resolved = useMemo(
    () => resolveMainChatModelSlot({ purpose, settings }),
    [purpose, settings],
  );
  const [providerDraft, setProviderDraft] = useState(resolved.binding?.provider ?? "");
  const [modelDraft, setModelDraft] = useState(resolved.binding?.model ?? "");
  const [thinkingDraft, setThinkingDraft] = useState(resolved.binding?.thinkingOptionId ?? "");

  const handleOpenEdit = useCallback(() => {
    setProviderDraft(resolved.binding?.provider ?? "");
    setModelDraft(resolved.binding?.model ?? "");
    setThinkingDraft(resolved.binding?.thinkingOptionId ?? "");
    onStartEdit(purpose);
  }, [onStartEdit, purpose, resolved.binding]);

  const handleSave = useCallback(() => {
    const trimmedProvider = providerDraft.trim();
    if (!trimmedProvider) {
      onSaveSlot(purpose, null);
      return;
    }
    const trimmedModel = modelDraft.trim();
    const trimmedThinking = thinkingDraft.trim();
    onSaveSlot(purpose, {
      provider: trimmedProvider,
      ...(trimmedModel ? { model: trimmedModel } : {}),
      ...(trimmedThinking ? { thinkingOptionId: trimmedThinking } : {}),
    });
  }, [modelDraft, onSaveSlot, providerDraft, purpose, thinkingDraft]);

  const handleReset = useCallback(() => {
    onSaveSlot(purpose, null);
  }, [onSaveSlot, purpose]);

  const sourceLabel = useMemo(() => {
    if (resolved.source === "explicit") {
      return t("mainChat.modelProfiles.slotSourceExplicit");
    }
    if (
      resolved.source === "inherited" &&
      resolved.inheritedFrom &&
      resolved.inheritedFrom !== "live_main"
    ) {
      return t("mainChat.modelProfiles.slotSourceInherited", {
        parent: t(`mainChat.modelProfiles.slotShortNames.${resolved.inheritedFrom}`),
      });
    }
    return t("mainChat.modelProfiles.slotSourceUnset");
  }, [resolved.inheritedFrom, resolved.source, t]);

  return (
    <View
      style={[styles.slotRow, !isFirst && styles.rowDivider]}
      testID={`model-profiles-slot-${purpose}`}
    >
      <View style={styles.slotHeaderRow}>
        <View style={styles.slotTextCol}>
          <View style={styles.slotTitleLine}>
            <Text style={styles.slotTitle} numberOfLines={1}>
              {t(`mainChat.modelProfiles.slotNames.${purpose}`)}
            </Text>
            <StatusBadge
              size="xs"
              variant={slotBadgeVariant(resolved.source)}
              label={sourceLabel}
            />
          </View>
          <Text
            style={styles.slotSpecText}
            numberOfLines={1}
            testID={`model-profiles-slot-spec-${purpose}`}
          >
            {formatSlotSpec(resolved.binding)}
          </Text>
        </View>

        {!editing ? (
          <View style={styles.slotActions}>
            {resolved.source === "explicit" && purpose !== "main" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onPress={handleReset}
                testID={`model-profiles-slot-reset-${purpose}`}
              >
                {t("mainChat.modelProfiles.slotResetButton")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onPress={handleOpenEdit}
              testID={`model-profiles-slot-edit-${purpose}`}
            >
              {t("mainChat.modelProfiles.slotEditButton")}
            </Button>
          </View>
        ) : null}
      </View>

      {editing ? (
        <View style={styles.slotEditorBox} testID={`model-profiles-slot-editor-${purpose}`}>
          <FormTextInput
            size="sm"
            initialValue={providerDraft}
            resetKey={`${purpose}:provider:${resolved.binding?.provider ?? ""}`}
            onChangeText={setProviderDraft}
            placeholder={t("mainChat.modelProfiles.providerPlaceholder")}
            testID={`model-profiles-slot-provider-${purpose}`}
          />
          <FormTextInput
            size="sm"
            initialValue={modelDraft}
            resetKey={`${purpose}:model:${resolved.binding?.model ?? ""}`}
            onChangeText={setModelDraft}
            placeholder={t("mainChat.modelProfiles.modelPlaceholder")}
            testID={`model-profiles-slot-model-${purpose}`}
          />
          <FormTextInput
            size="sm"
            initialValue={thinkingDraft}
            resetKey={`${purpose}:thinking:${resolved.binding?.thinkingOptionId ?? ""}`}
            onChangeText={setThinkingDraft}
            placeholder={t("mainChat.modelProfiles.thinkingPlaceholder")}
            testID={`model-profiles-slot-thinking-${purpose}`}
          />
          <View style={styles.slotEditorFooter}>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onPress={onCancelEdit}
              testID={`model-profiles-slot-cancel-${purpose}`}
            >
              {t("mainChat.modelProfiles.slotCancelButton")}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={disabled}
              onPress={handleSave}
              testID={`model-profiles-slot-save-${purpose}`}
            >
              {t("mainChat.modelProfiles.slotSaveButton")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
});

const CustomProfileRow = memo(function CustomProfileRow({
  profile,
  isActive,
  isFirst,
  disabled,
  onApply,
  onDelete,
}: {
  profile: MainChatModelProfile;
  isActive: boolean;
  isFirst: boolean;
  disabled: boolean;
  onApply: (profileId: string, name: string) => void;
  onDelete: (profileId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleApply = useCallback(
    () => onApply(profile.id, profile.name),
    [onApply, profile.id, profile.name],
  );
  const handleDelete = useCallback(() => onDelete(profile.id), [onDelete, profile.id]);

  return (
    <View
      style={[styles.customProfileRow, !isFirst && styles.rowDivider]}
      testID={`model-profiles-custom-item-${profile.id}`}
    >
      <View style={styles.slotTextCol}>
        <View style={styles.slotTitleLine}>
          <Text style={styles.slotTitle} numberOfLines={1}>
            {profile.name}
          </Text>
          {isActive ? (
            <StatusBadge
              size="xs"
              variant="success"
              label={t("mainChat.modelProfiles.activeProfileLabel")}
            />
          ) : null}
        </View>
        <Text style={styles.slotSpecText} numberOfLines={1}>
          {formatSlotSpec(profile.slots.main ?? null)}
        </Text>
      </View>
      <View style={styles.slotActions}>
        <Button
          variant={isActive ? "secondary" : "default"}
          size="sm"
          disabled={disabled || isActive}
          onPress={handleApply}
          testID={`model-profiles-apply-custom-${profile.id}`}
        >
          {t("mainChat.modelProfiles.customProfileApplyButton")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          leftIcon={TRASH_ICON}
          disabled={disabled}
          onPress={handleDelete}
          testID={`model-profiles-delete-custom-${profile.id}`}
        >
          {t("mainChat.modelProfiles.customProfileDeleteButton")}
        </Button>
      </View>
    </View>
  );
});

export const MainChatModelProfilesPanel = memo(function MainChatModelProfilesPanel({
  serverId,
  client,
  settings,
  disabled = false,
  onApplyPatch,
}: MainChatModelProfilesPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const switchModelProfile = useMainChatSettingsStore((state) => state.switchModelProfile);
  const [switching, setSwitching] = useState(false);
  const [editingPurpose, setEditingPurpose] = useState<MainChatModelPurpose | null>(null);
  const [customNameDraft, setCustomNameDraft] = useState("");
  const [customResetSeq, setCustomResetSeq] = useState(0);

  const modelConfig = useMemo(() => resolveMainChatModelConfig(settings), [settings]);
  const builtinProfiles = useMemo(
    () => resolveBuiltinMainChatModelProfiles(modelConfig.slots?.main ?? null),
    [modelConfig.slots?.main],
  );
  const customProfiles = useMemo(
    () => modelConfig.customProfiles ?? [],
    [modelConfig.customProfiles],
  );
  const activeProfileId = modelConfig.activeProfileId ?? "balanced";
  const activeIsBuiltin = isBuiltinMainChatModelProfileId(activeProfileId);
  const isBusy = disabled || switching;

  const builtinOptions = useMemo<SegmentedControlOption<MainChatBuiltinModelProfileId>[]>(
    () =>
      MAIN_CHAT_BUILTIN_MODEL_PROFILE_IDS.map((id) => ({
        value: id,
        label: t(`mainChat.modelProfiles.profiles.${id}.shortName`),
        disabled: isBusy,
      })),
    [isBusy, t],
  );

  const activeProfileDescription = useMemo(() => {
    if (activeIsBuiltin) {
      return t(`mainChat.modelProfiles.profiles.${activeProfileId}.description`);
    }
    const matched = customProfiles.find((entry) => entry.id === activeProfileId);
    return matched?.description ?? t("mainChat.modelProfiles.customProfileBadge");
  }, [activeIsBuiltin, activeProfileId, customProfiles, t]);

  const handleSwitchProfile = useCallback(
    (profileId: string, displayName?: string) => {
      if (isBusy) return;
      if (!client || typeof client.switchMainChatModelProfile !== "function") {
        const builtin = builtinProfiles.find((p) => p.id === profileId);
        const custom = customProfiles.find((p) => p.id === profileId);
        const target = builtin ?? custom;
        if (!target) return;
        onApplyPatch(
          {
            modelConfig: {
              activeProfileId: target.id,
              slots: target.slots,
            },
          },
          t("mainChat.modelProfiles.switchedToast", {
            name: displayName ?? resolveProfileDisplayName(target.id, customProfiles, t),
          }),
        );
        return;
      }

      setSwitching(true);
      void switchModelProfile(serverId, { profileId }, client)
        .then(() => {
          toast.show(
            t("mainChat.modelProfiles.switchedToast", {
              name: displayName ?? resolveProfileDisplayName(profileId, customProfiles, t),
            }),
            { variant: "success" },
          );
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.modelProfiles.switchFailed"),
          );
        })
        .finally(() => {
          setSwitching(false);
        });
    },
    [
      builtinProfiles,
      client,
      customProfiles,
      isBusy,
      onApplyPatch,
      serverId,
      switchModelProfile,
      t,
      toast,
    ],
  );

  const handleSelectBuiltin = useCallback(
    (profileId: MainChatBuiltinModelProfileId) => {
      if (profileId === activeProfileId) return;
      handleSwitchProfile(profileId);
    },
    [activeProfileId, handleSwitchProfile],
  );

  const handleRollback = useCallback(() => {
    if (isBusy || !modelConfig.rollbackSnapshot || !client) return;
    setSwitching(true);
    void switchModelProfile(serverId, { rollback: true }, client)
      .then(() => {
        toast.show(t("mainChat.modelProfiles.rolledBackToast"), { variant: "success" });
        return null;
      })
      .catch((error) => {
        toast.error(
          error instanceof Error ? error.message : t("mainChat.modelProfiles.switchFailed"),
        );
      })
      .finally(() => {
        setSwitching(false);
      });
  }, [client, isBusy, modelConfig.rollbackSnapshot, serverId, switchModelProfile, t, toast]);

  const handleSaveSlot = useCallback(
    (purpose: MainChatModelPurpose, binding: MainChatModelSlotBinding | null) => {
      const slotLabel = t(`mainChat.modelProfiles.slotShortNames.${purpose}`);
      onApplyPatch(
        {
          modelConfig: {
            slots: {
              [purpose]: binding,
            },
          },
        },
        binding
          ? t("mainChat.modelProfiles.slotSavedToast", { slot: slotLabel })
          : t("mainChat.modelProfiles.slotResetToast", { slot: slotLabel }),
      );
      setEditingPurpose(null);
    },
    [onApplyPatch, t],
  );

  const handleCancelEdit = useCallback(() => {
    setEditingPurpose(null);
  }, []);

  const handleSaveCustomProfile = useCallback(() => {
    const trimmedName = customNameDraft.trim();
    if (!trimmedName || isBusy) return;
    if (customProfiles.length >= MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES) {
      toast.error(t("mainChat.modelProfiles.saveFailed"));
      return;
    }
    const nextId = `custom_${Date.now().toString(36)}`;
    const nextProfile: MainChatModelProfile = {
      id: nextId,
      name: trimmedName,
      slots: { ...modelConfig.slots },
      builtin: false,
      updatedAt: new Date().toISOString(),
    };
    onApplyPatch(
      {
        modelConfig: {
          customProfiles: [...customProfiles, nextProfile],
        },
      },
      t("mainChat.modelProfiles.customProfileSavedToast", { name: trimmedName }),
    );
    setCustomNameDraft("");
    setCustomResetSeq((prev) => prev + 1);
  }, [customNameDraft, customProfiles, isBusy, modelConfig.slots, onApplyPatch, t, toast]);

  const handleDeleteCustomProfile = useCallback(
    (profileId: string) => {
      const remaining = customProfiles.filter((entry) => entry.id !== profileId);
      onApplyPatch(
        {
          modelConfig: {
            customProfiles: remaining,
            ...(activeProfileId === profileId ? { activeProfileId: "balanced" } : {}),
          },
        },
        t("mainChat.modelProfiles.customProfileDeletedToast"),
      );
    },
    [activeProfileId, customProfiles, onApplyPatch, t],
  );

  const recentHistory = (modelConfig.switchHistory ?? []).slice(0, 4);

  return (
    <View style={settingsStyles.card} testID="settings-main-chat-model-profiles-panel">
      <View style={[settingsStyles.row, styles.stackedRow]}>
        <View style={styles.headerLine}>
          <View style={styles.titleIconRow}>
            <ThemedCpu size={14} uniProps={mutedIconMapping} />
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.modelProfiles.activeProfileLabel")}
            </Text>
          </View>
          {!activeIsBuiltin ? (
            <StatusBadge
              size="xs"
              variant="success"
              label={resolveProfileDisplayName(activeProfileId, customProfiles, t)}
            />
          ) : null}
        </View>

        <SegmentedControl
          options={builtinOptions}
          value={activeIsBuiltin ? activeProfileId : "balanced"}
          onValueChange={handleSelectBuiltin}
          testID="model-profiles-builtin-segment"
        />

        <Text style={settingsStyles.rowHint}>{activeProfileDescription}</Text>

        {modelConfig.rollbackSnapshot ? (
          <View style={styles.rollbackRow} testID="model-profiles-rollback-bar">
            <Text style={styles.rollbackHint} numberOfLines={1}>
              {t("mainChat.modelProfiles.rollbackHint", {
                profile: resolveProfileDisplayName(
                  modelConfig.rollbackSnapshot.profileId,
                  customProfiles,
                  t,
                ),
              })}
            </Text>
            <Button
              variant="outline"
              size="sm"
              leftIcon={ROLLBACK_ICON}
              loading={switching}
              disabled={isBusy || !client}
              onPress={handleRollback}
              testID="model-profiles-rollback-btn"
            >
              {t("mainChat.modelProfiles.rollbackButton")}
            </Button>
          </View>
        ) : null}
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}>
        <View style={styles.subHeaderCol}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.modelProfiles.slotsHeading")}</Text>
          <Text style={settingsStyles.rowHint}>{t("mainChat.modelProfiles.slotsHint")}</Text>
        </View>
        <View style={styles.slotsList}>
          {MAIN_CHAT_MODEL_PURPOSES.map((purpose, index) => (
            <ModelSlotRow
              key={purpose}
              purpose={purpose}
              settings={settings}
              isFirst={index === 0}
              editing={editingPurpose === purpose}
              disabled={isBusy}
              onStartEdit={setEditingPurpose}
              onCancelEdit={handleCancelEdit}
              onSaveSlot={handleSaveSlot}
            />
          ))}
        </View>
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}>
        <Text style={settingsStyles.rowTitle}>
          {t("mainChat.modelProfiles.customProfilesHeading")}
        </Text>

        {customProfiles.length > 0 ? (
          <View style={styles.slotsList}>
            {customProfiles.map((profile, index) => (
              <CustomProfileRow
                key={profile.id}
                profile={profile}
                isActive={activeProfileId === profile.id}
                isFirst={index === 0}
                disabled={isBusy}
                onApply={handleSwitchProfile}
                onDelete={handleDeleteCustomProfile}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.customFormRow}>
          <View style={styles.customInputWrap}>
            <FormTextInput
              size="sm"
              initialValue=""
              resetKey={`${serverId}:custom:${customResetSeq}`}
              onChangeText={setCustomNameDraft}
              placeholder={t("mainChat.modelProfiles.customProfileNamePlaceholder")}
              maxLength={40}
              testID="model-profiles-custom-name-input"
            />
          </View>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={PLUS_ICON}
            disabled={isBusy || customNameDraft.trim().length === 0}
            onPress={handleSaveCustomProfile}
            testID="model-profiles-custom-save-btn"
          >
            {t("mainChat.modelProfiles.saveCustomProfileButton")}
          </Button>
        </View>
      </View>

      {recentHistory.length > 0 ? (
        <View
          style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}
          testID="model-profiles-history"
        >
          <View style={styles.titleIconRow}>
            <ThemedHistory size={13} uniProps={mutedIconMapping} />
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.modelProfiles.historyHeading")}
            </Text>
          </View>
          <View style={styles.historyList}>
            {recentHistory.map((entry) => (
              <View key={entry.id} style={styles.historyRow}>
                <StatusBadge
                  size="xs"
                  variant={entry.action === "rollback" ? "warning" : "muted"}
                  label={t(
                    entry.action === "rollback"
                      ? "mainChat.modelProfiles.historyActionRollback"
                      : "mainChat.modelProfiles.historyActionSwitch",
                  )}
                />
                <Text style={styles.historyText} numberOfLines={1}>
                  {`${resolveProfileDisplayName(entry.fromProfileId, customProfiles, t)} → ${resolveProfileDisplayName(entry.toProfileId, customProfiles, t)}`}
                </Text>
                <Text style={styles.historyMeta} numberOfLines={1}>
                  {t("mainChat.modelProfiles.historySlotsChanged", {
                    count: entry.changedSlots.length,
                  })}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  headerLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  titleIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  rollbackRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rollbackHint: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  subHeaderCol: {
    gap: theme.spacing[0.5],
  },
  slotsList: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  slotRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  customProfileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  slotHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  slotTextCol: {
    flex: 1,
    minWidth: 160,
    gap: theme.spacing[0.5],
  },
  slotTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  slotTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  slotSpecText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  slotActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  slotEditorBox: {
    gap: theme.spacing[1.5],
    paddingTop: theme.spacing[1],
  },
  slotEditorFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1.5],
  },
  customFormRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  customInputWrap: {
    flex: 1,
    minWidth: 180,
  },
  historyList: {
    gap: theme.spacing[1.5],
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  historyText: {
    flex: 1,
    minWidth: 120,
    fontSize: 12,
    color: theme.colors.foreground,
  },
  historyMeta: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
