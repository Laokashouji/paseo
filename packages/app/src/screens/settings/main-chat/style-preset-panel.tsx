import {
  MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS,
  createMainChatCustomPresetId,
  isMainChatStyleFactoryDefault,
  isMainChatStyleModified,
  resolveMainChatCustomPresets,
  type MainChatCapabilities,
  type MainChatCustomStylePreset,
  type MainChatIntervals,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatStyle,
} from "@getpaseo/protocol/main-chat";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import {
  MAIN_CHAT_CAPABILITY_FIELDS,
  MAIN_CHAT_INTERVAL_FIELDS,
  buildMainChatStylePresetItems,
  findActiveMainChatStylePresetItem,
  formatMainChatPresetCompactSummary,
  formatSwitchedMainChatPresetToast,
  type MainChatCapabilityFieldKey,
  type MainChatIntervalFieldKey,
  type MainChatStylePresetListItem,
} from "@/main-chat/style-presets";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedShield = withUnistyles(Shield);
const ThemedZap = withUnistyles(Zap);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedPlus = withUnistyles(Plus);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedSave = withUnistyles(Save);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedSliders = withUnistyles(SlidersHorizontal);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

const accentIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveIconMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const plusIcon = <ThemedPlus size={14} uniProps={mutedIconMapping} />;
const editMenuIcon = <ThemedPencil size={14} uniProps={mutedIconMapping} />;
const copyMenuIcon = <ThemedCopy size={14} uniProps={mutedIconMapping} />;
const saveMenuIcon = <ThemedSave size={14} uniProps={mutedIconMapping} />;
const resetMenuIcon = <ThemedRotateCcw size={14} uniProps={mutedIconMapping} />;
const deleteMenuIcon = <ThemedTrash2 size={14} uniProps={destructiveIconMapping} />;
const slidersIcon = <ThemedSliders size={13} uniProps={mutedIconMapping} />;

const TEMPLATE_CURRENT_ID = "__current__";

type IntervalDraftMap = Record<MainChatIntervalFieldKey, string>;

function toIntervalDraftMap(intervals: MainChatIntervals): IntervalDraftMap {
  return {
    patrolIntervalSec: String(intervals.patrolIntervalSec),
    triageSettleSec: String(intervals.triageSettleSec),
    stalledThresholdMin: String(intervals.stalledThresholdMin),
    noProgressThresholdMin: String(intervals.noProgressThresholdMin),
    needsYouEscalateMin: String(intervals.needsYouEscalateMin),
    wakeupCooldownMin: String(intervals.wakeupCooldownMin),
  };
}

function renderPresetLeadingIcon(preset: Pick<MainChatStylePresetListItem, "kind" | "baseStyle">) {
  if (preset.kind === "custom") {
    return (
      <ThemedSparkles
        size={14}
        uniProps={preset.baseStyle === "proactive" ? warningIconMapping : accentIconMapping}
      />
    );
  }
  return preset.baseStyle === "proactive" ? (
    <ThemedZap size={14} uniProps={warningIconMapping} />
  ) : (
    <ThemedShield size={14} uniProps={accentIconMapping} />
  );
}

interface EditorState {
  mode: "create" | "edit";
  editingPresetId: string | null;
  initialTemplateId: string;
  sessionKey: number;
}

const EditorIntervalCell = memo(function EditorIntervalCell({
  field,
  value,
  resetScope,
  onChange,
}: {
  field: (typeof MAIN_CHAT_INTERVAL_FIELDS)[number];
  value: string;
  resetScope: string;
  onChange: (key: MainChatIntervalFieldKey, text: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleChangeText = useCallback(
    (text: string) => {
      onChange(field.key, text.replace(/[^0-9]/g, ""));
    },
    [field.key, onChange],
  );
  return (
    <View style={styles.editorIntervalCell}>
      <Text style={styles.editorParamLabel} numberOfLines={1}>
        {t(field.labelKey)}
      </Text>
      <View style={styles.editorIntervalInputRow}>
        <FormTextInput
          size="sm"
          style={styles.editorNumberInput}
          initialValue={value}
          resetKey={`${resetScope}:${field.key}`}
          onChangeText={handleChangeText}
          keyboardType="number-pad"
          maxLength={4}
          testID={`style-preset-editor-interval-${field.key}`}
        />
        <Text style={styles.editorUnitText}>{t(field.unitKey)}</Text>
      </View>
    </View>
  );
});

const EditorCapabilityRow = memo(function EditorCapabilityRow({
  field,
  value,
  disabled,
  onToggle,
}: {
  field: (typeof MAIN_CHAT_CAPABILITY_FIELDS)[number];
  value: boolean;
  disabled: boolean;
  onToggle: (key: MainChatCapabilityFieldKey, nextValue: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleValueChange = useCallback(
    (nextValue: boolean) => {
      onToggle(field.key, nextValue);
    },
    [field.key, onToggle],
  );
  return (
    <View style={styles.editorCapRow}>
      <Text style={styles.editorCapLabel} numberOfLines={1}>
        {t(field.labelKey)}
      </Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={handleValueChange}
        testID={`style-preset-editor-cap-${field.key}`}
      />
    </View>
  );
});

const EditorAdvancedParametersBox = memo(function EditorAdvancedParametersBox({
  open,
  previewSummary,
  intervalDrafts,
  capabilities,
  formResetScope,
  saving,
  onToggleOpen,
  onIntervalChange,
  onCapabilityToggle,
}: {
  open: boolean;
  previewSummary: string;
  intervalDrafts: IntervalDraftMap;
  capabilities: MainChatCapabilities;
  formResetScope: string;
  saving: boolean;
  onToggleOpen: () => void;
  onIntervalChange: (key: MainChatIntervalFieldKey, text: string) => void;
  onCapabilityToggle: (key: MainChatCapabilityFieldKey, nextValue: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.advancedBox}>
      <PressHighlight
        onPress={onToggleOpen}
        style={styles.advancedHeader}
        highlightStyle={styles.advancedHeaderPressed}
        accessibilityRole="button"
        testID="style-preset-editor-advanced-toggle"
      >
        <View style={styles.advancedHeaderLeft}>
          {slidersIcon}
          <View style={styles.advancedHeaderText}>
            <Text style={styles.advancedTitle}>
              {t(
                open
                  ? "mainChat.settings.style.editor.advancedToggleCollapse"
                  : "mainChat.settings.style.editor.advancedToggleExpand",
              )}
            </Text>
            <Text style={styles.advancedSummary} numberOfLines={1}>
              {previewSummary}
            </Text>
          </View>
        </View>
        {open ? (
          <ThemedChevronUp size={15} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronDown size={15} uniProps={mutedIconMapping} />
        )}
      </PressHighlight>

      {open ? (
        <View style={styles.advancedBody} testID="style-preset-editor-advanced-body">
          <Text style={styles.advancedGroupLabel}>
            {t("mainChat.settings.style.editor.intervalsHeading")}
          </Text>
          <View style={styles.editorIntervalGrid}>
            {MAIN_CHAT_INTERVAL_FIELDS.map((field) => (
              <EditorIntervalCell
                key={field.key}
                field={field}
                value={intervalDrafts[field.key]}
                resetScope={formResetScope}
                onChange={onIntervalChange}
              />
            ))}
          </View>

          <Text style={styles.advancedGroupLabel}>
            {t("mainChat.settings.style.editor.capabilitiesHeading")}
          </Text>
          <View style={styles.editorCapList}>
            {MAIN_CHAT_CAPABILITY_FIELDS.map((field) => (
              <EditorCapabilityRow
                key={field.key}
                field={field}
                value={capabilities[field.key]}
                disabled={saving}
                onToggle={onCapabilityToggle}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
});

const StylePresetEditorModal = memo(function StylePresetEditorModal({
  visible,
  editorState,
  settings,
  allPresets,
  saving,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  editorState: EditorState;
  settings: MainChatSettings;
  allPresets: readonly MainChatStylePresetListItem[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (preset: MainChatCustomStylePreset, mode: "create" | "edit") => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const [templateId, setTemplateId] = useState(editorState.initialTemplateId);
  const [templateApplySeq, setTemplateApplySeq] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [baseStyle, setBaseStyle] = useState<MainChatStyle>(settings.style);
  const [customGuidance, setCustomGuidance] = useState("");
  const [intervalDrafts, setIntervalDrafts] = useState<IntervalDraftMap>(() =>
    toIntervalDraftMap(settings.intervals),
  );
  const [capabilities, setCapabilities] = useState<MainChatCapabilities>(() => ({
    ...settings.capabilities,
  }));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const resolveTemplateSource = useCallback(
    (sourceId: string) => {
      if (sourceId === TEMPLATE_CURRENT_ID) {
        const activePreset = allPresets.find(
          (entry) => entry.id === (settings.activePresetId ?? settings.style),
        );
        return {
          baseStyle: settings.style,
          description: activePreset?.kind === "custom" ? (activePreset.description ?? "") : "",
          customGuidance: activePreset?.kind === "custom" ? (activePreset.customGuidance ?? "") : "",
          intervals: { ...settings.intervals },
          capabilities: { ...settings.capabilities },
        };
      }
      const matched = allPresets.find((entry) => entry.id === sourceId);
      if (matched) {
        return {
          baseStyle: matched.baseStyle,
          description: matched.kind === "custom" ? matched.description : "",
          customGuidance: matched.customGuidance ?? "",
          intervals: { ...matched.intervals },
          capabilities: { ...matched.capabilities },
        };
      }
      return {
        baseStyle: settings.style,
        description: "",
        customGuidance: "",
        intervals: { ...settings.intervals },
        capabilities: { ...settings.capabilities },
      };
    },
    [allPresets, settings],
  );

  useEffect(() => {
    if (!visible) return;
    setAdvancedOpen(false);
    if (editorState.mode === "edit" && editorState.editingPresetId) {
      const target = resolveMainChatCustomPresets(settings).find(
        (entry) => entry.id === editorState.editingPresetId,
      );
      if (target) {
        setTemplateId(target.id);
        setName(target.name);
        setDescription(target.description ?? "");
        setBaseStyle(target.baseStyle);
        setCustomGuidance(target.customGuidance ?? "");
        setIntervalDrafts(toIntervalDraftMap(target.intervals));
        setCapabilities({ ...target.capabilities });
        setTemplateApplySeq((seq) => seq + 1);
        return;
      }
    }
    const source = resolveTemplateSource(editorState.initialTemplateId);
    setTemplateId(editorState.initialTemplateId);
    setName("");
    setDescription(source.description);
    setBaseStyle(source.baseStyle);
    setCustomGuidance(source.customGuidance);
    setIntervalDrafts(toIntervalDraftMap(source.intervals));
    setCapabilities(source.capabilities);
    setTemplateApplySeq((seq) => seq + 1);
  }, [
    editorState.editingPresetId,
    editorState.initialTemplateId,
    editorState.mode,
    editorState.sessionKey,
    resolveTemplateSource,
    settings,
    visible,
  ]);

  const templateOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const currentOpt: SelectFieldOption<string> = {
      id: TEMPLATE_CURRENT_ID,
      value: TEMPLATE_CURRENT_ID,
      label: t("mainChat.settings.style.editor.templateCurrentOption"),
      description: t("mainChat.settings.style.editor.templateCurrentDesc"),
    };
    const presetOpts: SelectFieldOption<string>[] = allPresets.map((preset) => ({
      id: preset.id,
      value: preset.id,
      label: preset.name,
      description: `${
        preset.kind === "custom"
          ? t("mainChat.settings.style.customBadge")
          : t("mainChat.settings.style.builtinBadge")
      } · ${preset.description}`,
    }));
    return [currentOpt, ...presetOpts];
  }, [allPresets, t]);

  const selectedTemplateDisplay = useMemo(() => {
    const matched = templateOptions.find((option) => option.value === templateId);
    return matched ? { label: matched.label } : null;
  }, [templateId, templateOptions]);

  const baseStyleOptions = useMemo<SegmentedControlOption<MainChatStyle>[]>(
    () => [
      {
        value: "conservative",
        label: t("mainChat.settings.style.editor.baseConservative"),
        disabled: saving,
      },
      {
        value: "proactive",
        label: t("mainChat.settings.style.editor.baseProactive"),
        disabled: saving,
      },
    ],
    [saving, t],
  );

  const handleSelectTemplate = useCallback(
    (nextTemplateId: string) => {
      setTemplateId(nextTemplateId);
      const source = resolveTemplateSource(nextTemplateId);
      setBaseStyle(source.baseStyle);
      setDescription(source.description);
      setCustomGuidance(source.customGuidance);
      setIntervalDrafts(toIntervalDraftMap(source.intervals));
      setCapabilities(source.capabilities);
      setTemplateApplySeq((seq) => seq + 1);
    },
    [resolveTemplateSource],
  );

  const handleIntervalChange = useCallback((key: MainChatIntervalFieldKey, text: string) => {
    setIntervalDrafts((prev) => ({ ...prev, [key]: text }));
  }, []);

  const handleCapabilityToggle = useCallback(
    (key: MainChatCapabilityFieldKey, nextValue: boolean) => {
      setCapabilities((prev) => ({ ...prev, [key]: nextValue }));
    },
    [],
  );

  const handleToggleAdvanced = useCallback(() => {
    setAdvancedOpen((prev) => !prev);
  }, []);

  const previewSummary = useMemo(() => {
    const numericIntervals: MainChatIntervals = {
      patrolIntervalSec:
        Number.parseInt(intervalDrafts.patrolIntervalSec, 10) ||
        settings.intervals.patrolIntervalSec,
      triageSettleSec:
        Number.parseInt(intervalDrafts.triageSettleSec, 10) || settings.intervals.triageSettleSec,
      stalledThresholdMin:
        Number.parseInt(intervalDrafts.stalledThresholdMin, 10) ||
        settings.intervals.stalledThresholdMin,
      noProgressThresholdMin:
        Number.parseInt(intervalDrafts.noProgressThresholdMin, 10) ||
        settings.intervals.noProgressThresholdMin,
      needsYouEscalateMin:
        Number.parseInt(intervalDrafts.needsYouEscalateMin, 10) ||
        settings.intervals.needsYouEscalateMin,
      wakeupCooldownMin:
        Number.parseInt(intervalDrafts.wakeupCooldownMin, 10) ||
        settings.intervals.wakeupCooldownMin,
    };
    return formatMainChatPresetCompactSummary(numericIntervals, capabilities, t);
  }, [capabilities, intervalDrafts, settings.intervals, t]);

  const handleConfirm = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error(t("mainChat.settings.style.editor.nameRequired"));
      return;
    }

    const parsedIntervals: Record<string, number> = {};
    for (const field of MAIN_CHAT_INTERVAL_FIELDS) {
      const parsed = Number.parseInt(intervalDrafts[field.key], 10);
      if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
        setAdvancedOpen(true);
        toast.error(
          t("mainChat.settings.intervals.invalidRange", {
            label: t(field.labelKey),
            min: field.min,
            max: field.max,
          }),
        );
        return;
      }
      parsedIntervals[field.key] = parsed;
    }

    const existingIds = resolveMainChatCustomPresets(settings).map((entry) => entry.id);
    const id =
      editorState.mode === "edit" && editorState.editingPresetId
        ? editorState.editingPresetId
        : createMainChatCustomPresetId(trimmedName, existingIds);

    const trimmedDesc = description.trim();
    const trimmedGuidance = customGuidance.trim();
    const preset: MainChatCustomStylePreset = {
      id,
      name: trimmedName,
      ...(trimmedDesc ? { description: trimmedDesc } : {}),
      baseStyle,
      ...(trimmedGuidance ? { customGuidance: trimmedGuidance } : {}),
      intervals: parsedIntervals as unknown as MainChatIntervals,
      capabilities: { ...capabilities },
      updatedAt: new Date().toISOString(),
    };
    onSubmit(preset, editorState.mode);
  }, [
    baseStyle,
    capabilities,
    customGuidance,
    description,
    editorState.editingPresetId,
    editorState.mode,
    intervalDrafts,
    name,
    onSubmit,
    settings,
    t,
    toast,
  ]);

  const formResetScope = `${editorState.sessionKey}:${templateApplySeq}`;
  const isCreate = editorState.mode === "create";

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <PressHighlight
          style={styles.modalDismiss}
          highlightStyle={styles.modalDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.cancel")}
        >
          <View />
        </PressHighlight>
        <View style={styles.modalCard} testID="style-preset-editor-modal">
          <Text style={styles.modalTitle}>
            {t(
              isCreate
                ? "mainChat.settings.style.editor.createTitle"
                : "mainChat.settings.style.editor.editTitle",
            )}
          </Text>

          <ScrollView
            style={styles.modalScroll}
            contentContainerStyle={styles.modalScrollContent}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {isCreate ? (
              <SelectField
                size="sm"
                label={t("mainChat.settings.style.editor.templateLabel")}
                value={templateId}
                selectedDisplay={selectedTemplateDisplay}
                options={templateOptions}
                onChange={handleSelectTemplate}
                placeholder={t("mainChat.settings.style.editor.templatePlaceholder")}
                emptyText={t("mainChat.settings.style.emptyOptions")}
                disabled={saving}
                triggerTestID="style-preset-editor-template-trigger"
              />
            ) : null}

            <Field label={t("mainChat.settings.style.editor.nameLabel")}>
              <FormTextInput
                size="sm"
                initialValue={name}
                resetKey={`name:${editorState.sessionKey}`}
                onChangeText={setName}
                placeholder={t("mainChat.settings.style.editor.namePlaceholder")}
                maxLength={32}
                autoFocus
                returnKeyType="next"
                testID="style-preset-editor-name"
              />
            </Field>

            <Field label={t("mainChat.settings.style.editor.descriptionLabel")}>
              <FormTextInput
                size="sm"
                initialValue={description}
                resetKey={`desc:${formResetScope}`}
                onChangeText={setDescription}
                placeholder={t("mainChat.settings.style.editor.descriptionPlaceholder")}
                maxLength={160}
                testID="style-preset-editor-description"
              />
            </Field>

            <Field label={t("mainChat.settings.style.editor.baseStyleLabel")}>
              <SegmentedControl
                options={baseStyleOptions}
                value={baseStyle}
                onValueChange={setBaseStyle}
                testID="style-preset-editor-base-style"
              />
            </Field>

            <Field label={t("mainChat.settings.style.editor.guidanceLabel")}>
              <FormTextInput
                size="sm"
                style={styles.guidanceInput}
                initialValue={customGuidance}
                resetKey={`guidance:${formResetScope}`}
                onChangeText={setCustomGuidance}
                placeholder={t("mainChat.settings.style.editor.guidancePlaceholder")}
                maxLength={1200}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
                testID="style-preset-editor-guidance"
              />
            </Field>

            <EditorAdvancedParametersBox
              open={advancedOpen}
              previewSummary={previewSummary}
              intervalDrafts={intervalDrafts}
              capabilities={capabilities}
              formResetScope={formResetScope}
              saving={saving}
              onToggleOpen={handleToggleAdvanced}
              onIntervalChange={handleIntervalChange}
              onCapabilityToggle={handleCapabilityToggle}
            />
          </ScrollView>

          <View style={styles.modalActions}>
            <Button variant="ghost" size="sm" onPress={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleConfirm}
              disabled={saving || name.trim().length === 0}
              testID="style-preset-editor-submit"
            >
              {t(
                isCreate
                  ? "mainChat.settings.style.editor.createSubmit"
                  : "mainChat.settings.style.editor.editSubmit",
              )}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const DeleteStylePresetModal = memo(function DeleteStylePresetModal({
  target,
  saving,
  onClose,
  onConfirm,
}: {
  target: MainChatStylePresetListItem | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <PressHighlight
          style={styles.modalDismiss}
          highlightStyle={styles.modalDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.cancel")}
        >
          <View />
        </PressHighlight>
        <View style={styles.deleteCard} testID="style-preset-delete-modal">
          <Text style={styles.modalTitle}>
            {t("mainChat.settings.style.deleteConfirm.title", { name: target?.name ?? "" })}
          </Text>
          <Text style={styles.deleteDescription}>
            {t("mainChat.settings.style.deleteConfirm.description")}
          </Text>
          <View style={styles.modalActions}>
            <Button variant="ghost" size="sm" onPress={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onPress={onConfirm}
              disabled={saving}
              testID="style-preset-delete-confirm"
            >
              {t("mainChat.settings.style.deleteConfirm.confirmButton")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

export interface MainChatStylePresetPanelProps {
  settings: MainChatSettings;
  disabled: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => Promise<void>;
}

export const MainChatStylePresetPanel = memo(function MainChatStylePresetPanel({
  settings,
  disabled,
  onApplyPatch,
}: MainChatStylePresetPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const allPresets = useMemo(() => buildMainChatStylePresetItems(settings, t), [settings, t]);
  const activePreset = useMemo(() => findActiveMainChatStylePresetItem(settings, t), [settings, t]);
  const customPresets = useMemo(() => resolveMainChatCustomPresets(settings), [settings]);
  const isModified = useMemo(() => isMainChatStyleModified(settings), [settings]);
  const isFactoryDefault = useMemo(() => isMainChatStyleFactoryDefault(settings), [settings]);
  const isAtLimit = customPresets.length >= MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS;

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorState, setEditorState] = useState<EditorState>({
    mode: "create",
    editingPresetId: null,
    initialTemplateId: TEMPLATE_CURRENT_ID,
    sessionKey: 0,
  });
  const [deleteTarget, setDeleteTarget] = useState<MainChatStylePresetListItem | null>(null);

  const selectOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      allPresets.map((preset) => ({
        id: preset.id,
        value: preset.id,
        label: preset.name,
        description: `${
          preset.kind === "custom"
            ? t("mainChat.settings.style.customBadge")
            : t("mainChat.settings.style.builtinBadge")
        } · ${preset.description}`,
        testID: `settings-main-chat-preset-option-${preset.id}`,
      })),
    [allPresets, t],
  );

  const selectedDisplay = useMemo(
    () => ({
      label: activePreset.name,
    }),
    [activePreset.name],
  );

  const triggerLeading = useMemo(() => renderPresetLeadingIcon(activePreset), [activePreset]);

  const compactSummary = useMemo(
    () => formatMainChatPresetCompactSummary(settings.intervals, settings.capabilities, t),
    [settings.capabilities, settings.intervals, t],
  );

  const handleSelectPreset = useCallback(
    (presetId: string) => {
      if (disabled) return;
      const target = allPresets.find((entry) => entry.id === presetId);
      const toastText = formatSwitchedMainChatPresetToast(presetId, target?.name ?? presetId, t);
      void onApplyPatch({ applyPresetId: presetId }, toastText);
    },
    [allPresets, disabled, onApplyPatch, t],
  );

  const openCreateModal = useCallback(
    (initialTemplateId: string) => {
      if (isAtLimit) {
        toast.error(
          t("mainChat.settings.style.limitReached", { max: MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS }),
        );
        return;
      }
      setEditorState((prev) => ({
        mode: "create",
        editingPresetId: null,
        initialTemplateId,
        sessionKey: prev.sessionKey + 1,
      }));
      setEditorOpen(true);
    },
    [isAtLimit, t, toast],
  );

  const handleNewPreset = useCallback(() => {
    openCreateModal(isModified ? TEMPLATE_CURRENT_ID : activePreset.id);
  }, [activePreset.id, isModified, openCreateModal]);

  const handleSaveCurrentAsNew = useCallback(() => {
    openCreateModal(TEMPLATE_CURRENT_ID);
  }, [openCreateModal]);

  const handleDuplicateActive = useCallback(() => {
    openCreateModal(activePreset.id);
  }, [activePreset.id, openCreateModal]);

  const handleEditActive = useCallback(() => {
    if (activePreset.kind !== "custom") return;
    setEditorState((prev) => ({
      mode: "edit",
      editingPresetId: activePreset.id,
      initialTemplateId: activePreset.id,
      sessionKey: prev.sessionKey + 1,
    }));
    setEditorOpen(true);
  }, [activePreset.id, activePreset.kind]);

  const handleCloseEditor = useCallback(() => {
    setEditorOpen(false);
  }, []);

  const handleSubmitEditor = useCallback(
    (preset: MainChatCustomStylePreset, mode: "create" | "edit") => {
      const shouldApply = mode === "create" || preset.id === activePreset.id;
      const patch: MainChatSettingsPatch = shouldApply
        ? { upsertCustomPreset: preset, applyPresetId: preset.id }
        : { upsertCustomPreset: preset };
      const message =
        mode === "create"
          ? t("mainChat.settings.stylePresetCreatedToast", { name: preset.name })
          : t("mainChat.settings.stylePresetUpdatedToast", { name: preset.name });
      void onApplyPatch(patch, message).then(() => {
        setEditorOpen(false);
        return undefined;
      });
    },
    [activePreset.id, onApplyPatch, t],
  );

  const handleOverwriteActiveCustom = useCallback(() => {
    if (activePreset.kind !== "custom" || disabled) return;
    const raw = customPresets.find((entry) => entry.id === activePreset.id);
    if (!raw) return;
    const updated: MainChatCustomStylePreset = {
      ...raw,
      baseStyle: settings.style,
      intervals: { ...settings.intervals },
      capabilities: { ...settings.capabilities },
      updatedAt: new Date().toISOString(),
    };
    void onApplyPatch(
      { upsertCustomPreset: updated, applyPresetId: updated.id },
      t("mainChat.settings.stylePresetUpdatedToast", { name: updated.name }),
    );
  }, [
    activePreset.id,
    activePreset.kind,
    customPresets,
    disabled,
    onApplyPatch,
    settings.capabilities,
    settings.intervals,
    settings.style,
    t,
  ]);

  const handleRestoreActivePreset = useCallback(() => {
    if (disabled) return;
    void onApplyPatch(
      { applyPresetId: activePreset.id },
      t("mainChat.settings.stylePresetRestoredToast", { name: activePreset.name }),
    );
  }, [activePreset.id, activePreset.name, disabled, onApplyPatch, t]);

  const handleResetToFactoryDefault = useCallback(() => {
    if (disabled) return;
    void onApplyPatch(
      { resetStyleToDefault: true },
      t("mainChat.settings.styleResetToDefaultToast"),
    );
  }, [disabled, onApplyPatch, t]);

  const handleRequestDeleteActive = useCallback(() => {
    if (activePreset.kind !== "custom") return;
    setDeleteTarget(activePreset);
  }, [activePreset]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget || disabled) return;
    const target = deleteTarget;
    void onApplyPatch(
      { deleteCustomPresetId: target.id },
      t("mainChat.settings.stylePresetDeletedToast", { name: target.name }),
    ).then(() => {
      setDeleteTarget(null);
      return undefined;
    });
  }, [deleteTarget, disabled, onApplyPatch, t]);

  const isCustomActive = activePreset.kind === "custom";
  const baseTagLabel = t(
    settings.style === "proactive"
      ? "mainChat.settings.style.baseProactiveTag"
      : "mainChat.settings.style.baseConservativeTag",
  );

  return (
    <View style={settingsStyles.card} testID="settings-main-chat-style-card">
      <View style={[settingsStyles.row, styles.pickerBlock]}>
        <View style={styles.pickerRow}>
          <View style={styles.pickerFieldWrap}>
            <SelectField
              field={false}
              size="sm"
              label={t("mainChat.settings.style.selectLabel")}
              title={t("mainChat.settings.style.title")}
              value={activePreset.id}
              selectedDisplay={selectedDisplay}
              options={selectOptions}
              onChange={handleSelectPreset}
              placeholder={t("mainChat.settings.style.selectPlaceholder")}
              searchPlaceholder={t("mainChat.settings.style.searchPlaceholder")}
              emptyText={t("mainChat.settings.style.emptyOptions")}
              searchable={allPresets.length > 5}
              disabled={disabled}
              triggerLeading={triggerLeading}
              triggerTestID="settings-main-chat-style-select"
            />
          </View>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={plusIcon}
            onPress={handleNewPreset}
            disabled={disabled}
            testID="settings-main-chat-style-new"
          >
            {t("mainChat.settings.style.newButton")}
          </Button>

          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              disabled={disabled}
              style={styles.moreButton}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.settings.style.moreActionsLabel")}
              testID="settings-main-chat-style-more"
            >
              <ThemedEllipsis size={15} uniProps={mutedIconMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              width={220}
              sheetTitle={t("mainChat.settings.style.moreActionsLabel")}
            >
              {isCustomActive ? (
                <DropdownMenuItem
                  leading={editMenuIcon}
                  onSelect={handleEditActive}
                  testID="settings-main-chat-style-edit"
                >
                  {t("mainChat.settings.style.editAction")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                leading={copyMenuIcon}
                onSelect={handleDuplicateActive}
                testID="settings-main-chat-style-duplicate"
              >
                {t("mainChat.settings.style.duplicateAction")}
              </DropdownMenuItem>
              {isModified ? (
                <DropdownMenuItem
                  leading={saveMenuIcon}
                  onSelect={
                    isCustomActive ? handleOverwriteActiveCustom : handleSaveCurrentAsNew
                  }
                  testID="settings-main-chat-style-save-modified"
                >
                  {t(
                    isCustomActive
                      ? "mainChat.settings.style.overwritePresetAction"
                      : "mainChat.settings.style.saveAsNewAction",
                  )}
                </DropdownMenuItem>
              ) : null}
              {isModified ? (
                <DropdownMenuItem
                  leading={resetMenuIcon}
                  onSelect={handleRestoreActivePreset}
                  testID="settings-main-chat-style-restore"
                >
                  {t("mainChat.settings.style.restorePresetAction")}
                </DropdownMenuItem>
              ) : null}
              {!isFactoryDefault ? (
                <DropdownMenuItem
                  leading={resetMenuIcon}
                  onSelect={handleResetToFactoryDefault}
                  testID="settings-main-chat-style-reset-default"
                >
                  {t("mainChat.settings.style.resetDefaultAction")}
                </DropdownMenuItem>
              ) : null}
              {isCustomActive ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    leading={deleteMenuIcon}
                    destructive
                    onSelect={handleRequestDeleteActive}
                    testID="settings-main-chat-style-delete"
                  >
                    {t("mainChat.settings.style.deleteAction")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>

        <View style={styles.summaryBlock}>
          <View style={styles.badgeLine}>
            <StatusBadge
              size="xs"
              variant={settings.style === "proactive" ? "warning" : "success"}
              label={baseTagLabel}
            />
            {isCustomActive ? (
              <StatusBadge
                size="xs"
                variant="muted"
                label={t("mainChat.settings.style.customBadge")}
              />
            ) : null}
            {isModified ? (
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("mainChat.settings.style.modifiedBadge")}
              />
            ) : null}
          </View>

          <Text style={styles.descriptionText}>{activePreset.description}</Text>
          <Text style={styles.metaText}>{compactSummary}</Text>

          {activePreset.kind === "custom" && activePreset.customGuidance ? (
            <View style={styles.guidancePreviewBox} testID="settings-main-chat-style-guidance">
              <Text style={styles.guidancePreviewText} numberOfLines={2}>
                {t("mainChat.settings.style.customGuidancePreview", {
                  guidance: activePreset.customGuidance,
                })}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {isModified ? (
        <View
          style={[settingsStyles.row, settingsStyles.rowBorder, styles.modifiedBar]}
          testID="settings-main-chat-style-modified-bar"
        >
          <Text style={styles.modifiedLabel} numberOfLines={1}>
            {t("mainChat.settings.style.modifiedBanner", { name: activePreset.name })}
          </Text>
          <View style={styles.modifiedActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleRestoreActivePreset}
              disabled={disabled}
              testID="settings-main-chat-style-restore-inline"
            >
              {t("mainChat.settings.style.restorePresetAction")}
            </Button>
            {isCustomActive ? (
              <Button
                variant="secondary"
                size="sm"
                onPress={handleOverwriteActiveCustom}
                disabled={disabled}
                testID="settings-main-chat-style-overwrite-inline"
              >
                {t("mainChat.settings.style.overwritePresetAction")}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onPress={handleSaveCurrentAsNew}
              disabled={disabled}
              testID="settings-main-chat-style-save-as-new-inline"
            >
              {t("mainChat.settings.style.saveAsNewAction")}
            </Button>
          </View>
        </View>
      ) : null}

      <StylePresetEditorModal
        visible={editorOpen}
        editorState={editorState}
        settings={settings}
        allPresets={allPresets}
        saving={disabled}
        onClose={handleCloseEditor}
        onSubmit={handleSubmitEditor}
      />

      <DeleteStylePresetModal
        target={deleteTarget}
        saving={disabled}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  pickerBlock: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  pickerFieldWrap: {
    flex: 1,
    minWidth: 0,
  },
  moreButton: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryBlock: {
    gap: theme.spacing[1.5],
  },
  badgeLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  descriptionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 19,
  },
  metaText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.82,
  },
  guidancePreviewBox: {
    marginTop: 2,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  guidancePreviewText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  modifiedBar: {
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  modifiedLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  modifiedActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.52)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalDismiss: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  modalCard: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "86%",
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  deleteCard: {
    width: "100%",
    maxWidth: 400,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  deleteDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  modalScroll: {
    flexGrow: 0,
  },
  modalScrollContent: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  guidanceInput: {
    minHeight: 74,
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  advancedBox: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  advancedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  advancedHeaderPressed: {
    backgroundColor: theme.colors.surface2,
  },
  advancedHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  advancedHeaderText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  advancedTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  advancedSummary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  advancedBody: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  advancedGroupLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  editorIntervalGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  editorIntervalCell: {
    width: "47%",
    minWidth: 165,
    gap: theme.spacing[1],
  },
  editorParamLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  editorIntervalInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  editorNumberInput: {
    flex: 1,
    minWidth: 64,
    textAlign: "right",
  },
  editorUnitText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    minWidth: 26,
  },
  editorCapList: {
    gap: theme.spacing[2],
  },
  editorCapRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  editorCapLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
