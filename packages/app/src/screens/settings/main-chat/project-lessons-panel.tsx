import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS,
  MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS,
  MAIN_CHAT_LESSON_TEXT_MAX_CHARS,
  type MainChatLessonKind,
  type MainChatLessonOrigin,
  type MainChatProjectLesson,
  type MainChatProjectLessonGroup,
} from "@getpaseo/protocol/main-chat";
import { BookOpen, FolderGit2, Plus, RefreshCw, Trash2 } from "lucide-react-native";
import { memo, useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedBookOpen = withUnistyles(BookOpen);
const ThemedFolderGit2 = withUnistyles(FolderGit2);
const ThemedPlus = withUnistyles(Plus);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedTrash2 = withUnistyles(Trash2);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const REFRESH_ICON = <ThemedRefreshCw size={13} uniProps={mutedIconMapping} />;
const ADD_ICON = <ThemedPlus size={13} uniProps={mutedIconMapping} />;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

const LESSON_KINDS: readonly MainChatLessonKind[] = [
  "repeated_mistake",
  "missing_context",
  "wasted_step",
  "improvement",
];

function kindBadgeVariant(kind: MainChatLessonKind): StatusBadgeVariant {
  switch (kind) {
    case "repeated_mistake":
      return "warning";
    case "improvement":
      return "success";
    case "missing_context":
    case "wasted_step":
      return "muted";
  }
}

function originTranslationKey(origin: MainChatLessonOrigin): string {
  return `mainChat.projectLessons.origins.${origin}`;
}

function kindTranslationKey(kind: MainChatLessonKind): string {
  return `mainChat.projectLessons.kinds.${kind}`;
}

export interface MainChatProjectLessonsPanelProps {
  serverId: string;
  client: DaemonClient | null;
  disabled?: boolean;
}

const KindPill = memo(function KindPill({
  kind,
  selected,
  onSelect,
}: {
  kind: MainChatLessonKind;
  selected: boolean;
  onSelect: (kind: MainChatLessonKind) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(kind), [kind, onSelect]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={[styles.kindPill, selected && styles.kindPillSelected]}
      highlightStyle={styles.rowPressed}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      testID={`project-lessons-kind-${kind}`}
    >
      <Text style={[styles.kindPillText, selected && styles.kindPillTextSelected]}>
        {t(kindTranslationKey(kind))}
      </Text>
    </PressHighlight>
  );
});

const LessonRow = memo(function LessonRow({
  lesson,
  showTopDivider,
  confirmingDelete,
  deleting,
  disabled,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  lesson: MainChatProjectLesson;
  showTopDivider: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
  disabled: boolean;
  onRequestDelete: (lessonId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (lessonId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRequest = useCallback(() => onRequestDelete(lesson.id), [lesson.id, onRequestDelete]);
  const handleConfirm = useCallback(() => onConfirmDelete(lesson.id), [lesson.id, onConfirmDelete]);

  return (
    <View
      style={[styles.lessonRow, showTopDivider && styles.lessonRowDivider]}
      testID={`project-lessons-item-${lesson.id}`}
    >
      <View style={styles.lessonBody}>
        <View style={styles.lessonMetaRow}>
          <StatusBadge
            size="xs"
            variant={kindBadgeVariant(lesson.kind)}
            label={t(kindTranslationKey(lesson.kind))}
          />
          <StatusBadge size="xs" variant="muted" label={t(originTranslationKey(lesson.origin))} />
          {lesson.seenCount > 1 ? (
            <StatusBadge
              size="xs"
              variant="muted"
              label={t("mainChat.projectLessons.hitsBadge", { count: lesson.seenCount })}
            />
          ) : null}
        </View>
        <Text style={styles.lessonText}>{lesson.text}</Text>
      </View>

      <View style={styles.lessonActions}>
        {confirmingDelete ? (
          <View style={styles.confirmRow}>
            <Button
              variant="destructive"
              size="sm"
              loading={deleting}
              disabled={disabled || deleting}
              onPress={handleConfirm}
              testID={`project-lessons-delete-confirm-${lesson.id}`}
            >
              {t("mainChat.projectLessons.deleteConfirmButton")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={deleting}
              onPress={onCancelDelete}
              testID={`project-lessons-delete-cancel-${lesson.id}`}
            >
              {t("mainChat.projectLessons.cancelDeleteButton")}
            </Button>
          </View>
        ) : (
          <PressHighlight
            onPress={handleRequest}
            disabled={disabled || deleting}
            style={styles.deleteIconBtn}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.projectLessons.deleteButton")}
            testID={`project-lessons-delete-${lesson.id}`}
          >
            <ThemedTrash2 size={14} uniProps={dangerIconMapping} />
          </PressHighlight>
        )}
      </View>
    </View>
  );
});

const ProjectLessonGroupCard = memo(function ProjectLessonGroupCard({
  group,
  groupIndex,
  confirmDeleteId,
  deletingId,
  disabled,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  group: MainChatProjectLessonGroup;
  groupIndex: number;
  confirmDeleteId: string | null;
  deletingId: string | null;
  disabled: boolean;
  onRequestDelete: (lessonId: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (lessonId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.groupCard} testID={`project-lessons-group-${groupIndex}`}>
      <View style={styles.groupHeader}>
        <View style={styles.groupTitleCol}>
          <View style={styles.groupTitleRow}>
            <ThemedFolderGit2 size={14} uniProps={mutedIconMapping} />
            <Text style={styles.groupLabel} numberOfLines={1}>
              {group.projectLabel}
            </Text>
            <StatusBadge
              size="xs"
              variant="muted"
              label={t("mainChat.projectLessons.groupCount", { count: group.lessons.length })}
            />
          </View>
          <Text style={styles.groupKey} numberOfLines={1}>
            {group.projectKey}
          </Text>
        </View>
      </View>

      <View style={styles.groupList}>
        {group.lessons.map((lesson, idx) => (
          <LessonRow
            key={lesson.id}
            lesson={lesson}
            showTopDivider={idx > 0}
            confirmingDelete={confirmDeleteId === lesson.id}
            deleting={deletingId === lesson.id}
            disabled={disabled}
            onRequestDelete={onRequestDelete}
            onCancelDelete={onCancelDelete}
            onConfirmDelete={onConfirmDelete}
          />
        ))}
      </View>
    </View>
  );
});

const AddLessonForm = memo(function AddLessonForm({
  projectKey,
  projectLabel,
  kind,
  text,
  formResetKey,
  submitting,
  disabled,
  onChangeProjectKey,
  onChangeProjectLabel,
  onSelectKind,
  onChangeText,
  onCancel,
  onSubmit,
}: {
  projectKey: string;
  projectLabel: string;
  kind: MainChatLessonKind;
  text: string;
  formResetKey: string;
  submitting: boolean;
  disabled: boolean;
  onChangeProjectKey: (value: string) => void;
  onChangeProjectLabel: (value: string) => void;
  onSelectKind: (kind: MainChatLessonKind) => void;
  onChangeText: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const canSubmit = projectKey.trim().length > 0 && text.trim().length > 0 && !submitting;

  return (
    <View style={styles.addFormCard} testID="project-lessons-add-form">
      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>{t("mainChat.projectLessons.projectKeyLabel")}</Text>
        <FormTextInput
          size="sm"
          style={styles.singleLineInput}
          initialValue={projectKey}
          resetKey={`${formResetKey}:key`}
          onChangeText={onChangeProjectKey}
          placeholder={t("mainChat.projectLessons.projectKeyPlaceholder")}
          maxLength={MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS}
          editable={!disabled && !submitting}
          testID="project-lessons-input-project"
        />
      </View>

      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>{t("mainChat.projectLessons.projectLabelLabel")}</Text>
        <FormTextInput
          size="sm"
          style={styles.singleLineInput}
          initialValue={projectLabel}
          resetKey={`${formResetKey}:label`}
          onChangeText={onChangeProjectLabel}
          placeholder={t("mainChat.projectLessons.projectLabelPlaceholder")}
          maxLength={MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS}
          editable={!disabled && !submitting}
          testID="project-lessons-input-label"
        />
      </View>

      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>{t("mainChat.projectLessons.kindLabel")}</Text>
        <View style={styles.kindPillsRow}>
          {LESSON_KINDS.map((entry) => (
            <KindPill key={entry} kind={entry} selected={entry === kind} onSelect={onSelectKind} />
          ))}
        </View>
      </View>

      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>{t("mainChat.projectLessons.textLabel")}</Text>
        <FormTextInput
          size="sm"
          style={styles.multilineInput}
          initialValue={text}
          resetKey={`${formResetKey}:text`}
          onChangeText={onChangeText}
          placeholder={t("mainChat.projectLessons.textPlaceholder")}
          multiline
          textAlignVertical="top"
          maxLength={MAIN_CHAT_LESSON_TEXT_MAX_CHARS}
          editable={!disabled && !submitting}
          testID="project-lessons-input-text"
        />
      </View>

      <View style={styles.formFooter}>
        <Button variant="ghost" size="sm" onPress={onCancel} disabled={submitting}>
          {t("mainChat.projectLessons.cancelButton")}
        </Button>
        <Button
          variant="default"
          size="sm"
          loading={submitting}
          disabled={disabled || !canSubmit}
          onPress={onSubmit}
          testID="project-lessons-submit"
        >
          {t("mainChat.projectLessons.submitButton")}
        </Button>
      </View>
    </View>
  );
});

export const MainChatProjectLessonsPanel = memo(function MainChatProjectLessonsPanel({
  serverId,
  client,
  disabled = false,
}: MainChatProjectLessonsPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const [groups, setGroups] = useState<MainChatProjectLessonGroup[]>([]);
  const [totalLessons, setTotalLessons] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [projectKey, setProjectKey] = useState("");
  const [projectLabel, setProjectLabel] = useState("");
  const [kind, setKind] = useState<MainChatLessonKind>("repeated_mistake");
  const [text, setText] = useState("");
  const [formResetKey, setFormResetKey] = useState("init");
  const [submitting, setSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadLessons = useCallback(async () => {
    if (!client || typeof client.listMainChatLessons !== "function") return;
    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await client.listMainChatLessons();
      if (response.error) {
        setErrorMessage(response.error);
        return;
      }
      setGroups(response.groups);
      setTotalLessons(response.lessons.length);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t("mainChat.projectLessons.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [client, t]);

  useEffect(() => {
    void loadLessons();
  }, [loadLessons, serverId]);

  const handleToggleAdd = useCallback(() => {
    setAddOpen((prev) => {
      if (!prev) {
        const defaultKey = groups[0]?.projectKey ?? "";
        const defaultLabel = groups[0]?.projectLabel ?? "";
        setProjectKey(defaultKey);
        setProjectLabel(defaultLabel);
        setKind("repeated_mistake");
        setText("");
        setFormResetKey(`open:${Date.now()}`);
      }
      return !prev;
    });
    setErrorMessage(null);
  }, [groups]);

  const handleCancelAdd = useCallback(() => {
    setAddOpen(false);
    setText("");
  }, []);

  const handleSubmitLesson = useCallback(async () => {
    if (!client || typeof client.addMainChatLesson !== "function" || submitting) return;
    const trimmedKey = projectKey.trim();
    const trimmedText = text.trim();
    if (!trimmedKey || !trimmedText) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await client.addMainChatLesson({
        projectKey: trimmedKey,
        projectLabel: projectLabel.trim() || undefined,
        kind,
        text: trimmedText,
      });
      if (response.error) {
        setErrorMessage(response.error);
        toast.error(response.error);
        return;
      }
      toast.show(
        response.deduplicated
          ? t("mainChat.projectLessons.deduplicatedToast")
          : t("mainChat.projectLessons.addedToast"),
        { variant: "success" },
      );
      setAddOpen(false);
      setText("");
      setFormResetKey(`saved:${Date.now()}`);
      await loadLessons();
    } catch (error) {
      const msg = error instanceof Error ? error.message : t("mainChat.projectLessons.addFailed");
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }, [client, kind, loadLessons, projectKey, projectLabel, submitting, t, text, toast]);

  const handleCancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const handleConfirmDelete = useCallback(
    async (lessonId: string) => {
      if (!client || typeof client.deleteMainChatLesson !== "function" || deletingId) return;
      setDeletingId(lessonId);
      setErrorMessage(null);
      try {
        const response = await client.deleteMainChatLesson(lessonId);
        if (response.error) {
          setErrorMessage(response.error);
          toast.error(response.error);
          return;
        }
        toast.show(t("mainChat.projectLessons.deletedToast"), { variant: "success" });
        setConfirmDeleteId(null);
        await loadLessons();
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : t("mainChat.projectLessons.deleteFailed");
        setErrorMessage(msg);
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    },
    [client, deletingId, loadLessons, t, toast],
  );

  return (
    <View style={settingsStyles.card} testID="main-chat-project-lessons-panel">
      <View style={[settingsStyles.row, styles.headerRow]}>
        <View style={styles.headerTitleGroup}>
          <ThemedBookOpen size={15} uniProps={mutedIconMapping} />
          <View style={styles.headerTextCol}>
            <Text style={settingsStyles.rowTitle}>{t("mainChat.projectLessons.sectionTitle")}</Text>
            <Text style={settingsStyles.rowHint} testID="project-lessons-summary-counts">
              {t("mainChat.projectLessons.summaryCounts", {
                projects: groups.length,
                lessons: totalLessons,
              })}
            </Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={REFRESH_ICON}
            onPress={loadLessons}
            disabled={!client || loading}
            testID="project-lessons-refresh-button"
          >
            {t("mainChat.projectLessons.refreshButton")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ADD_ICON}
            onPress={handleToggleAdd}
            disabled={disabled || !client}
            testID="project-lessons-add-toggle"
          >
            {t("mainChat.projectLessons.addButton")}
          </Button>
        </View>
      </View>

      {errorMessage ? (
        <View style={styles.errorBanner} testID="project-lessons-error">
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}

      {addOpen ? (
        <View style={styles.bodyPadding}>
          <AddLessonForm
            projectKey={projectKey}
            projectLabel={projectLabel}
            kind={kind}
            text={text}
            formResetKey={formResetKey}
            submitting={submitting}
            disabled={disabled}
            onChangeProjectKey={setProjectKey}
            onChangeProjectLabel={setProjectLabel}
            onSelectKind={setKind}
            onChangeText={setText}
            onCancel={handleCancelAdd}
            onSubmit={handleSubmitLesson}
          />
        </View>
      ) : null}

      {groups.length === 0 ? (
        <View style={[settingsStyles.rowBorder, styles.emptyWrap]} testID="project-lessons-empty">
          <Text style={settingsStyles.rowHint}>{t("mainChat.projectLessons.emptyState")}</Text>
        </View>
      ) : (
        <View style={[settingsStyles.rowBorder, styles.groupsWrap]}>
          {groups.map((group, index) => (
            <ProjectLessonGroupCard
              key={group.projectKey}
              group={group}
              groupIndex={index}
              confirmDeleteId={confirmDeleteId}
              deletingId={deletingId}
              disabled={disabled}
              onRequestDelete={setConfirmDeleteId}
              onCancelDelete={handleCancelDelete}
              onConfirmDelete={handleConfirmDelete}
            />
          ))}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  headerTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 160,
  },
  headerTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  bodyPadding: {
    paddingHorizontal: theme.spacing[3.5],
    paddingBottom: theme.spacing[3],
  },
  emptyWrap: {
    padding: theme.spacing[3.5],
  },
  errorBanner: {
    marginHorizontal: theme.spacing[3.5],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusDangerTint,
  },
  errorText: {
    fontSize: 12,
    color: theme.colors.statusDanger,
  },
  addFormCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  formField: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  singleLineInput: {
    width: "100%",
    minWidth: 0,
  },
  multilineInput: {
    width: "100%",
    minWidth: 0,
    minHeight: 72,
  },
  kindPillsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  kindPill: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  kindPillSelected: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  kindPillText: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  kindPillTextSelected: {
    color: theme.colors.surface0,
  },
  formFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  groupsWrap: {
    padding: theme.spacing[3.5],
    gap: theme.spacing[3],
  },
  groupCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  groupTitleCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  groupTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  groupLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  groupKey: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  groupList: {
    paddingHorizontal: theme.spacing[3],
  },
  lessonRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
  },
  lessonRowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  lessonBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1.5],
  },
  lessonMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  lessonText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  lessonActions: {
    flexShrink: 0,
    alignItems: "flex-end",
  },
  confirmRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  deleteIconBtn: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
}));
