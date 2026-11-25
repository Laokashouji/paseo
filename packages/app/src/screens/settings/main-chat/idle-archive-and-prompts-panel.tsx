import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_MAX_IDLE_ARCHIVE_THRESHOLD_MIN,
  MAIN_CHAT_MIN_IDLE_ARCHIVE_THRESHOLD_MIN,
  expandMainChatPromptTemplate,
  promptTemplateHasArgPlaceholder,
  resolveMainChatIdleArchivePolicy,
  type MainChatIdleArchiveAuditRecord,
  type MainChatIdleArchiveOutcome,
  type MainChatIdleArchiveSweepResult,
  type MainChatPromptTemplate,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import {
  Archive,
  BookOpen,
  Copy,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import {
  DEFAULT_PROMPT_LIBRARY_TEMPLATES,
  useMainChatPromptLibraryStore,
} from "@/main-chat/prompt-library-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedArchive = withUnistyles(Archive);
const ThemedBookOpen = withUnistyles(BookOpen);
const ThemedCopy = withUnistyles(Copy);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlay = withUnistyles(Play);
const ThemedPlus = withUnistyles(Plus);
const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const PLAY_ICON = <ThemedPlay size={12} uniProps={mutedIconMapping} />;
const ARCHIVE_ICON = <ThemedArchive size={12} uniProps={mutedIconMapping} />;
const PLUS_ICON = <ThemedPlus size={12} uniProps={mutedIconMapping} />;
const PENCIL_ICON = <ThemedPencil size={12} uniProps={mutedIconMapping} />;
const COPY_ICON = <ThemedCopy size={12} uniProps={mutedIconMapping} />;
const TRASH_ICON = <ThemedTrash2 size={12} uniProps={mutedIconMapping} />;

const EMPTY_AUDIT_RECORDS: readonly MainChatIdleArchiveAuditRecord[] = [];

function outcomeBadgeVariant(outcome: MainChatIdleArchiveOutcome): StatusBadgeVariant {
  switch (outcome) {
    case "archived":
      return "success";
    case "eligible":
      return "warning";
    case "refused":
      return "muted";
    case "failed":
      return "error";
  }
}

interface PromptEditorDraft {
  id?: string;
  slug: string;
  title: string;
  description: string;
  argumentHint: string;
  content: string;
  resetCounter: number;
}

export interface MainChatIdleArchiveAndPromptsPanelProps {
  serverId: string;
  client: DaemonClient | null;
  settings: MainChatSettings;
  initialSweepResult?: MainChatIdleArchiveSweepResult | null;
  initialAuditLog?: readonly MainChatIdleArchiveAuditRecord[];
  initialTemplates?: readonly MainChatPromptTemplate[];
  disabled?: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => void;
}

const IdleArchiveAuditRow = memo(function IdleArchiveAuditRow({
  record,
  isFirst,
}: {
  record: MainChatIdleArchiveAuditRecord;
  isFirst: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={[styles.auditRow, !isFirst && styles.rowDivider]}
      testID={`idle-archive-audit-row-${record.id}`}
    >
      <View style={styles.auditBadgeLine}>
        <StatusBadge
          size="xs"
          variant={outcomeBadgeVariant(record.outcome)}
          label={t(`mainChat.idleArchive.outcomes.${record.outcome}`)}
        />
        <Text style={styles.auditTitle} numberOfLines={1}>
          {record.title}
        </Text>
        <Text style={styles.auditMeta} numberOfLines={1}>
          {`· ${t("mainChat.idleArchive.idleDurationMeta", {
            minutes: Math.round(record.idleMinutes),
          })}`}
        </Text>
      </View>
      <Text style={styles.auditReason} numberOfLines={2}>
        {record.reason}
      </Text>
    </View>
  );
});

const PromptTemplateRow = memo(function PromptTemplateRow({
  template,
  isFirst,
  busy,
  onEdit,
  onCopyToNew,
  onDelete,
}: {
  template: MainChatPromptTemplate;
  isFirst: boolean;
  busy: boolean;
  onEdit: (template: MainChatPromptTemplate) => void;
  onCopyToNew: (template: MainChatPromptTemplate) => void;
  onDelete: (template: MainChatPromptTemplate) => void;
}): ReactElement {
  const { t } = useTranslation();
  const hasArg = promptTemplateHasArgPlaceholder(template.content);
  const handleEdit = useCallback(() => onEdit(template), [onEdit, template]);
  const handleCopy = useCallback(() => onCopyToNew(template), [onCopyToNew, template]);
  const handleDelete = useCallback(() => onDelete(template), [onDelete, template]);

  return (
    <View
      style={[styles.promptRow, !isFirst && styles.rowDivider]}
      testID={`prompt-template-row-${template.slug}`}
    >
      <View style={styles.promptBody}>
        <View style={styles.promptHeaderLine}>
          <Text style={styles.promptSlug} numberOfLines={1}>
            {`/${template.slug}`}
          </Text>
          <StatusBadge
            size="xs"
            variant={template.builtin ? "muted" : "success"}
            label={t(
              template.builtin
                ? "mainChat.promptLibrary.builtinBadge"
                : "mainChat.promptLibrary.customBadge",
            )}
          />
          {hasArg ? (
            <StatusBadge
              size="xs"
              variant="muted"
              label={t("mainChat.promptLibrary.argPlaceholderBadge")}
            />
          ) : null}
        </View>
        <Text style={styles.promptTitle} numberOfLines={1}>
          {template.title}
        </Text>
        {template.description ? (
          <Text style={styles.promptDescription} numberOfLines={2}>
            {template.description}
          </Text>
        ) : null}
      </View>

      <View style={styles.promptRowActions}>
        {template.builtin ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={COPY_ICON}
            disabled={busy}
            onPress={handleCopy}
            testID={`prompt-template-copy-${template.slug}`}
          >
            {t("mainChat.promptLibrary.copyToNewAction")}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              leftIcon={PENCIL_ICON}
              disabled={busy}
              onPress={handleEdit}
              testID={`prompt-template-edit-${template.slug}`}
            >
              {t("mainChat.promptLibrary.editAction")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              leftIcon={TRASH_ICON}
              disabled={busy}
              onPress={handleDelete}
              testID={`prompt-template-delete-${template.slug}`}
            >
              {t("mainChat.promptLibrary.deleteAction")}
            </Button>
          </>
        )}
      </View>
    </View>
  );
});

const PromptEditorForm = memo(function PromptEditorForm({
  draft,
  saving,
  onChangeDraft,
  onSave,
  onCancel,
}: {
  draft: PromptEditorDraft;
  saving: boolean;
  onChangeDraft: (patch: Partial<PromptEditorDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const previewText = useMemo(
    () => expandMainChatPromptTemplate(draft.content, "Wave 5"),
    [draft.content],
  );
  const handleSlug = useCallback((slug: string) => onChangeDraft({ slug }), [onChangeDraft]);
  const handleTitle = useCallback((title: string) => onChangeDraft({ title }), [onChangeDraft]);
  const handleDesc = useCallback(
    (description: string) => onChangeDraft({ description }),
    [onChangeDraft],
  );
  const handleArgHint = useCallback(
    (argumentHint: string) => onChangeDraft({ argumentHint }),
    [onChangeDraft],
  );
  const handleContent = useCallback(
    (content: string) => onChangeDraft({ content }),
    [onChangeDraft],
  );

  return (
    <View style={styles.editorBox} testID="prompt-template-editor">
      <View style={styles.editorFieldRow}>
        <View style={styles.editorField}>
          <Text style={styles.fieldLabel}>{t("mainChat.promptLibrary.slugLabel")}</Text>
          <FormTextInput
            size="sm"
            initialValue={draft.slug}
            resetKey={`slug:${draft.resetCounter}`}
            onChangeText={handleSlug}
            placeholder={t("mainChat.promptLibrary.slugPlaceholder")}
            maxLength={40}
            testID="prompt-editor-slug"
          />
        </View>
        <View style={styles.editorField}>
          <Text style={styles.fieldLabel}>{t("mainChat.promptLibrary.titleLabel")}</Text>
          <FormTextInput
            size="sm"
            initialValue={draft.title}
            resetKey={`title:${draft.resetCounter}`}
            onChangeText={handleTitle}
            placeholder={t("mainChat.promptLibrary.titlePlaceholder")}
            maxLength={60}
            testID="prompt-editor-title"
          />
        </View>
      </View>

      <View style={styles.editorFieldRow}>
        <View style={styles.editorField}>
          <Text style={styles.fieldLabel}>{t("mainChat.promptLibrary.descriptionLabel")}</Text>
          <FormTextInput
            size="sm"
            initialValue={draft.description}
            resetKey={`desc:${draft.resetCounter}`}
            onChangeText={handleDesc}
            placeholder={t("mainChat.promptLibrary.descriptionPlaceholder")}
            maxLength={160}
            testID="prompt-editor-description"
          />
        </View>
        <View style={styles.editorField}>
          <Text style={styles.fieldLabel}>{t("mainChat.promptLibrary.argHintLabel")}</Text>
          <FormTextInput
            size="sm"
            initialValue={draft.argumentHint}
            resetKey={`hint:${draft.resetCounter}`}
            onChangeText={handleArgHint}
            placeholder={t("mainChat.promptLibrary.argHintPlaceholder")}
            maxLength={80}
            testID="prompt-editor-arghint"
          />
        </View>
      </View>

      <View style={styles.editorFieldFull}>
        <Text style={styles.fieldLabel}>{t("mainChat.promptLibrary.contentLabel")}</Text>
        <FormTextInput
          size="sm"
          multiline
          style={styles.contentInput}
          initialValue={draft.content}
          resetKey={`content:${draft.resetCounter}`}
          onChangeText={handleContent}
          placeholder={t("mainChat.promptLibrary.contentPlaceholder")}
          maxLength={4000}
          testID="prompt-editor-content"
        />
      </View>

      {draft.content.trim().length > 0 ? (
        <View style={styles.previewBox} testID="prompt-editor-preview">
          <View style={styles.previewHeader}>
            <ThemedSparkles size={12} uniProps={mutedIconMapping} />
            <Text style={styles.previewLabel}>{t("mainChat.promptLibrary.previewLabel")}</Text>
          </View>
          <Text style={styles.previewBody} numberOfLines={3}>
            {previewText}
          </Text>
        </View>
      ) : null}

      <View style={styles.editorActions}>
        <Button
          variant="outline"
          size="sm"
          disabled={saving}
          onPress={onCancel}
          testID="prompt-editor-cancel"
        >
          {t("mainChat.promptLibrary.cancelButton")}
        </Button>
        <Button
          variant="default"
          size="sm"
          loading={saving}
          disabled={saving}
          onPress={onSave}
          testID="prompt-editor-save"
        >
          {t("mainChat.promptLibrary.saveButton")}
        </Button>
      </View>
    </View>
  );
});

export const MainChatIdleArchiveAndPromptsPanel = memo(function MainChatIdleArchiveAndPromptsPanel({
  serverId,
  client,
  settings,
  initialSweepResult = null,
  initialAuditLog,
  initialTemplates,
  disabled = false,
  onApplyPatch,
}: MainChatIdleArchiveAndPromptsPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const idlePolicy = useMemo(() => resolveMainChatIdleArchivePolicy(settings), [settings]);

  const storedTemplates = useMainChatPromptLibraryStore(
    (state) => state.templatesByServerId[serverId],
  );
  const loadPromptLibrary = useMainChatPromptLibraryStore((state) => state.loadPromptLibrary);
  const savePromptTemplate = useMainChatPromptLibraryStore((state) => state.savePromptTemplate);
  const deletePromptTemplate = useMainChatPromptLibraryStore((state) => state.deletePromptTemplate);
  const hydratePromptLibrary = useMainChatPromptLibraryStore((state) => state.hydratePromptLibrary);

  const templates = storedTemplates ?? initialTemplates ?? DEFAULT_PROMPT_LIBRARY_TEMPLATES;

  const [thresholdDraft, setThresholdDraft] = useState(String(idlePolicy.idleThresholdMinutes));
  const [sweeping, setSweeping] = useState(false);
  const [sweepRecords, setSweepRecords] = useState<readonly MainChatIdleArchiveAuditRecord[]>(
    () => {
      if (initialSweepResult) {
        return [
          ...initialSweepResult.archived,
          ...initialSweepResult.eligible,
          ...initialSweepResult.refused,
        ];
      }
      return initialAuditLog ?? EMPTY_AUDIT_RECORDS;
    },
  );

  const [editorDraft, setEditorDraft] = useState<PromptEditorDraft | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    setThresholdDraft(String(idlePolicy.idleThresholdMinutes));
  }, [idlePolicy.idleThresholdMinutes, serverId]);

  useEffect(() => {
    if (initialTemplates) {
      hydratePromptLibrary(serverId, initialTemplates);
      return;
    }
    if (!client || typeof client.listMainChatPromptLibrary !== "function") return;
    void loadPromptLibrary(serverId, client).catch(() => undefined);
  }, [client, hydratePromptLibrary, initialTemplates, loadPromptLibrary, serverId]);

  const handleToggleIdleArchive = useCallback(
    (nextValue: boolean) => {
      onApplyPatch({ idleArchivePolicy: { enabled: nextValue } });
    },
    [onApplyPatch],
  );

  const handleThresholdChange = useCallback((text: string) => {
    setThresholdDraft(text.replace(/[^0-9]/g, ""));
  }, []);

  const handleSaveIdleThreshold = useCallback(() => {
    const minutes = Number.parseInt(thresholdDraft, 10);
    if (
      !Number.isFinite(minutes) ||
      minutes < MAIN_CHAT_MIN_IDLE_ARCHIVE_THRESHOLD_MIN ||
      minutes > MAIN_CHAT_MAX_IDLE_ARCHIVE_THRESHOLD_MIN
    ) {
      toast.error(t("mainChat.idleArchive.invalidThresholdError"));
      return;
    }
    onApplyPatch(
      { idleArchivePolicy: { idleThresholdMinutes: minutes } },
      t("mainChat.idleArchive.policySavedToast"),
    );
  }, [onApplyPatch, t, thresholdDraft, toast]);

  const runSweep = useCallback(
    async (dryRun: boolean) => {
      if (!client || typeof client.sweepMainChatIdleSubagents !== "function" || sweeping) {
        return;
      }
      setSweeping(true);
      try {
        const response = await client.sweepMainChatIdleSubagents({ dryRun });
        if (response.error || !response.result) {
          throw new Error(response.error ?? t("mainChat.idleArchive.sweepFailed"));
        }
        const result = response.result;
        const combined = [...result.archived, ...result.eligible, ...result.refused];
        setSweepRecords(combined.length > 0 ? combined : result.auditLog);
        toast.show(
          dryRun
            ? t("mainChat.idleArchive.dryRunDoneToast", {
                eligible: result.eligibleCount,
                refused: result.refusedCount,
              })
            : t("mainChat.idleArchive.sweepDoneToast", {
                archived: result.archivedCount,
                refused: result.refusedCount,
              }),
          { variant: "success" },
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.idleArchive.sweepFailed"));
      } finally {
        setSweeping(false);
      }
    },
    [client, sweeping, t, toast],
  );

  const handleDryRunSweep = useCallback(() => {
    void runSweep(true);
  }, [runSweep]);

  const handleLiveSweep = useCallback(() => {
    void runSweep(false);
  }, [runSweep]);

  const handleOpenNewPrompt = useCallback(() => {
    setEditorDraft((prev) => ({
      slug: "",
      title: "",
      description: "",
      argumentHint: "",
      content: "",
      resetCounter: (prev?.resetCounter ?? 0) + 1,
    }));
  }, []);

  const handleEditPrompt = useCallback((template: MainChatPromptTemplate) => {
    setEditorDraft((prev) => ({
      id: template.id,
      slug: template.slug,
      title: template.title,
      description: template.description,
      argumentHint: template.argumentHint ?? "",
      content: template.content,
      resetCounter: (prev?.resetCounter ?? 0) + 1,
    }));
  }, []);

  const handleCopyPromptToNew = useCallback((template: MainChatPromptTemplate) => {
    setEditorDraft((prev) => ({
      slug: `${template.slug}-custom`,
      title: `${template.title} (Custom)`,
      description: template.description,
      argumentHint: template.argumentHint ?? "",
      content: template.content,
      resetCounter: (prev?.resetCounter ?? 0) + 1,
    }));
  }, []);

  const handleChangeDraft = useCallback((patch: Partial<PromptEditorDraft>) => {
    setEditorDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const handleCancelEditor = useCallback(() => {
    setEditorDraft(null);
  }, []);

  const handleSavePrompt = useCallback(async () => {
    if (!editorDraft || !client || savingTemplate) return;
    const slug = editorDraft.slug.trim();
    const title = editorDraft.title.trim();
    const content = editorDraft.content.trim();
    if (!slug || !title || !content) {
      toast.error(t("mainChat.promptLibrary.validationRequired"));
      return;
    }
    setSavingTemplate(true);
    try {
      const saved = await savePromptTemplate(
        serverId,
        {
          id: editorDraft.id,
          slug,
          title,
          description: editorDraft.description.trim(),
          argumentHint: editorDraft.argumentHint.trim() || null,
          content,
          category: "custom",
        },
        client,
      );
      setEditorDraft(null);
      toast.show(t("mainChat.promptLibrary.savedToast", { slug: saved.slug }), {
        variant: "success",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("mainChat.promptLibrary.saveFailed"));
    } finally {
      setSavingTemplate(false);
    }
  }, [client, editorDraft, savePromptTemplate, savingTemplate, serverId, t, toast]);

  const handleSavePromptPress = useCallback(() => {
    void handleSavePrompt();
  }, [handleSavePrompt]);

  const handleDeletePrompt = useCallback(
    (template: MainChatPromptTemplate) => {
      if (!client || savingTemplate) return;
      setSavingTemplate(true);
      void deletePromptTemplate(serverId, { id: template.id, slug: template.slug }, client)
        .then(() => {
          toast.show(t("mainChat.promptLibrary.deletedToast", { slug: template.slug }), {
            variant: "success",
          });
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.promptLibrary.deleteFailed"),
          );
        })
        .finally(() => {
          setSavingTemplate(false);
        });
    },
    [client, deletePromptTemplate, savingTemplate, serverId, t, toast],
  );

  return (
    <View style={settingsStyles.card} testID="main-chat-idle-archive-prompts-panel">
      <View style={[settingsStyles.row, styles.blockColumn]}>
        <View style={styles.subHeadingRow}>
          <ThemedArchive size={14} uniProps={mutedIconMapping} />
          <Text style={styles.subHeadingTitle}>{t("mainChat.idleArchive.heading")}</Text>
        </View>

        <View style={styles.switchRow}>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle}>{t("mainChat.idleArchive.enableLabel")}</Text>
            <Text style={settingsStyles.rowHint}>{t("mainChat.idleArchive.enableHint")}</Text>
          </View>
          <Switch
            value={idlePolicy.enabled}
            onValueChange={handleToggleIdleArchive}
            disabled={disabled}
            accessibilityLabel={t("mainChat.idleArchive.enableLabel")}
            testID="idle-archive-toggle-enabled"
          />
        </View>

        <View style={styles.thresholdInlineRow}>
          <View style={styles.inputWithUnit}>
            <Text style={styles.fieldLabel}>{t("mainChat.idleArchive.thresholdLabel")}</Text>
            <FormTextInput
              size="sm"
              style={styles.numberInput}
              initialValue={String(idlePolicy.idleThresholdMinutes)}
              resetKey={`${serverId}:idle:${idlePolicy.idleThresholdMinutes}`}
              onChangeText={handleThresholdChange}
              keyboardType="number-pad"
              maxLength={5}
              testID="idle-archive-threshold-input"
            />
            <Text style={styles.unitLabel}>{t("mainChat.idleArchive.thresholdUnit")}</Text>
          </View>
          <View style={styles.sweepActionsRow}>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              onPress={handleSaveIdleThreshold}
              testID="idle-archive-save-policy"
            >
              {t("mainChat.idleArchive.savePolicy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              leftIcon={PLAY_ICON}
              loading={sweeping}
              disabled={sweeping || !client}
              onPress={handleDryRunSweep}
              testID="idle-archive-dry-run"
            >
              {t("mainChat.idleArchive.dryRunAction")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              leftIcon={ARCHIVE_ICON}
              loading={sweeping}
              disabled={sweeping || !client}
              onPress={handleLiveSweep}
              testID="idle-archive-sweep-now"
            >
              {t("mainChat.idleArchive.sweepNowAction")}
            </Button>
          </View>
        </View>

        <View style={styles.redLineBox} testID="idle-archive-redline-callout">
          <View style={styles.redLineHeader}>
            <ThemedShieldCheck size={13} uniProps={successIconMapping} />
            <Text style={styles.redLineTitle}>{t("mainChat.idleArchive.redLineTitle")}</Text>
          </View>
          <Text style={styles.redLineBody}>{t("mainChat.idleArchive.redLineSummary")}</Text>
        </View>

        <Text style={styles.listCaption}>
          {t("mainChat.idleArchive.resultsHeading", { count: sweepRecords.length })}
        </Text>
        {sweepRecords.length === 0 ? (
          <Text style={styles.emptyText} testID="idle-archive-audit-empty">
            {t("mainChat.idleArchive.resultsEmpty")}
          </Text>
        ) : (
          <View style={styles.listBox} testID="idle-archive-audit-list">
            {sweepRecords.slice(0, 8).map((record, index) => (
              <IdleArchiveAuditRow key={record.id} record={record} isFirst={index === 0} />
            ))}
          </View>
        )}
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.blockColumn]}>
        <View style={styles.headerActionBar}>
          <View style={styles.promptHeaderCol}>
            <View style={styles.subHeadingRow}>
              <ThemedBookOpen size={14} uniProps={mutedIconMapping} />
              <Text style={styles.subHeadingTitle}>{t("mainChat.promptLibrary.heading")}</Text>
            </View>
            <Text style={settingsStyles.rowHint}>{t("mainChat.promptLibrary.subtitle")}</Text>
          </View>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={PLUS_ICON}
            disabled={disabled || savingTemplate}
            onPress={handleOpenNewPrompt}
            testID="prompt-library-new"
          >
            {t("mainChat.promptLibrary.newButton")}
          </Button>
        </View>

        {editorDraft ? (
          <PromptEditorForm
            draft={editorDraft}
            saving={savingTemplate}
            onChangeDraft={handleChangeDraft}
            onSave={handleSavePromptPress}
            onCancel={handleCancelEditor}
          />
        ) : null}

        {templates.length === 0 ? (
          <Text style={styles.emptyText} testID="prompt-library-empty">
            {t("mainChat.promptLibrary.emptyList")}
          </Text>
        ) : (
          <View style={styles.listBox} testID="prompt-library-list">
            {templates.map((template, index) => (
              <PromptTemplateRow
                key={template.id}
                template={template}
                isFirst={index === 0}
                busy={disabled || savingTemplate}
                onEdit={handleEditPrompt}
                onCopyToNew={handleCopyPromptToNew}
                onDelete={handleDeletePrompt}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  blockColumn: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  subHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 1,
    minWidth: 0,
  },
  subHeadingTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  thresholdInlineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  inputWithUnit: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  numberInput: {
    width: 76,
    textAlign: "right",
  },
  unitLabel: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  sweepActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  redLineBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusSuccess,
    backgroundColor: theme.colors.statusSuccessTint,
    gap: 4,
  },
  redLineHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  redLineTitle: {
    fontSize: 12,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusSuccess,
    flex: 1,
    minWidth: 0,
  },
  redLineBody: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  listCaption: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  listBox: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  auditRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: 4,
  },
  auditBadgeLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  auditTitle: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  auditMeta: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  auditReason: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  headerActionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  promptHeaderCol: {
    flex: 1,
    minWidth: 180,
    gap: 2,
  },
  promptRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  promptBody: {
    flex: 1,
    minWidth: 180,
    gap: 3,
  },
  promptHeaderLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  promptSlug: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  promptTitle: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  promptDescription: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  promptRowActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  editorBox: {
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  editorFieldRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  editorField: {
    flexGrow: 1,
    flexBasis: 160,
    minWidth: 140,
    gap: 4,
  },
  editorFieldFull: {
    gap: 4,
  },
  contentInput: {
    minHeight: 84,
    textAlignVertical: "top",
  },
  previewBox: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: 4,
  },
  previewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  previewLabel: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  previewBody: {
    fontSize: 12,
    color: theme.colors.foreground,
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  emptyText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
