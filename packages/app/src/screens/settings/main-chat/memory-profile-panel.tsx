import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ABOUT_ME_MAX_CHARS,
  MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS,
  MAIN_CHAT_OWNER_ALIAS_MAX_CHARS,
  MAIN_CHAT_OWNER_ALIASES_MAX_COUNT,
  resolveMainChatProfile,
  type MainChatConversationRecord,
  type MainChatMemoryFileMeta,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { Brain, FileText, Pin, Plus, RefreshCw, Trash2, X } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import {
  EMPTY_CONVERSATIONS,
  useMainChatConversationsStore,
} from "@/main-chat/conversations-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedProfileIcon = withUnistyles(Brain);
const ThemedDirectionIcon = withUnistyles(Pin);
const ThemedFileText = withUnistyles(FileText);
const ThemedFilePlus = withUnistyles(Plus);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const REFRESH_FILES_ICON = <ThemedRefreshCw size={13} uniProps={mutedIconMapping} />;
const NEW_FILE_ICON = <ThemedFilePlus size={13} uniProps={mutedIconMapping} />;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function removeStringItem(items: readonly string[], target: string): string[] {
  return items.filter((entry) => entry !== target);
}

const AliasChip = memo(function AliasChip({
  alias,
  disabled,
  onRemove,
}: {
  alias: string;
  disabled: boolean;
  onRemove: (alias: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onRemove(alias);
  }, [alias, onRemove]);

  return (
    <View style={styles.aliasChip}>
      <Text style={styles.aliasChipText} numberOfLines={1}>
        {alias}
      </Text>
      <PressHighlight
        onPress={handlePress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.memoryProfile.removeAliasLabel", { alias })}
        style={styles.aliasRemoveButton}
        highlightStyle={styles.subtleHighlight}
        hitSlop={4}
        testID={`memory-profile-remove-alias-${alias}`}
      >
        <ThemedX size={12} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

const DirectionPill = memo(function DirectionPill({
  leader,
  selected,
  onSelect,
}: {
  leader: MainChatConversationRecord;
  selected: boolean;
  onSelect: (conversationId: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => {
    onSelect(leader.id);
  }, [leader.id, onSelect]);
  const pillStyle = useMemo(
    () => (selected ? [styles.directionPill, styles.directionPillActive] : styles.directionPill),
    [selected],
  );
  const textStyle = useMemo(
    () =>
      selected
        ? [styles.directionPillText, styles.directionPillTextActive]
        : styles.directionPillText,
    [selected],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      style={pillStyle}
      highlightStyle={styles.subtleHighlight}
      testID={`memory-profile-direction-pill-${leader.id}`}
    >
      <Text style={textStyle} numberOfLines={1}>
        {leader.title}
      </Text>
    </PressHighlight>
  );
});

const MemoryFileRow = memo(function MemoryFileRow({
  file,
  index,
  selected,
  confirmingDelete,
  deleting,
  disabled,
  loadingContent,
  onOpen,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  file: MainChatMemoryFileMeta;
  index: number;
  selected: boolean;
  confirmingDelete: boolean;
  deleting: boolean;
  disabled: boolean;
  loadingContent: boolean;
  onOpen: (path: string) => void;
  onRequestDelete: (path: string) => void;
  onConfirmDelete: (path: string) => void;
  onCancelDelete: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    onOpen(file.path);
  }, [file.path, onOpen]);
  const handleRequestDelete = useCallback(() => {
    onRequestDelete(file.path);
  }, [file.path, onRequestDelete]);
  const handleConfirmDelete = useCallback(() => {
    onConfirmDelete(file.path);
  }, [file.path, onConfirmDelete]);

  const rowStyle = useMemo(
    () => [
      styles.fileRow,
      index > 0 ? styles.fileRowBorder : null,
      selected ? styles.fileRowActive : null,
    ],
    [index, selected],
  );

  return (
    <View style={rowStyle} testID={`memory-file-row-${file.path}`}>
      <PressHighlight
        style={styles.fileRowMain}
        highlightStyle={styles.subtleHighlight}
        onPress={handleOpen}
        disabled={loadingContent}
        accessibilityRole="button"
        testID={`memory-file-open-${file.path}`}
      >
        <Text style={styles.fileRowPath} numberOfLines={1} ellipsizeMode="middle">
          {file.path}
        </Text>
        <Text style={styles.fileRowMeta} numberOfLines={1}>
          {formatByteSize(file.bytes)}
        </Text>
      </PressHighlight>
      <View style={styles.fileRowActions}>
        {confirmingDelete ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              onPress={handleConfirmDelete}
              disabled={deleting}
              testID={`memory-file-confirm-delete-${file.path}`}
            >
              {t("mainChat.memoryProfile.confirmDeleteButton")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onPress={onCancelDelete}
              testID={`memory-file-cancel-delete-${file.path}`}
            >
              {t("mainChat.memoryProfile.cancelButton")}
            </Button>
          </>
        ) : (
          <PressHighlight
            onPress={handleRequestDelete}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.memoryProfile.deleteButton")}
            style={styles.iconActionButton}
            highlightStyle={styles.subtleHighlight}
            testID={`memory-file-delete-${file.path}`}
          >
            <ThemedTrash2 size={14} uniProps={dangerIconMapping} />
          </PressHighlight>
        )}
      </View>
    </View>
  );
});

const AboutMeSection = memo(function AboutMeSection({
  serverId,
  settings,
  disabled,
  onApplyPatch,
}: {
  serverId: string;
  settings: MainChatSettings;
  disabled: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => Promise<void> | void;
}): ReactElement {
  const { t } = useTranslation();
  const resolvedProfile = useMemo(() => resolveMainChatProfile(settings), [settings]);
  const [aboutMeDraft, setAboutMeDraft] = useState(resolvedProfile.aboutMe);
  const [aliasesDraft, setAliasesDraft] = useState<string[]>(resolvedProfile.ownerAliases);
  const [aliasInput, setAliasInput] = useState("");
  const [aliasResetTick, setAliasResetTick] = useState(0);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setAboutMeDraft(resolvedProfile.aboutMe);
    setAliasesDraft(resolvedProfile.ownerAliases);
  }, [resolvedProfile]);

  const profileDirty = useMemo(
    () =>
      aboutMeDraft !== resolvedProfile.aboutMe ||
      !areStringArraysEqual(aliasesDraft, resolvedProfile.ownerAliases),
    [aboutMeDraft, aliasesDraft, resolvedProfile],
  );

  const handleAddAlias = useCallback(() => {
    const trimmed = aliasInput.trim().slice(0, MAIN_CHAT_OWNER_ALIAS_MAX_CHARS);
    if (!trimmed) return;
    if (aliasesDraft.length >= MAIN_CHAT_OWNER_ALIASES_MAX_COUNT) return;
    const duplicate = aliasesDraft.some((entry) => entry.toLowerCase() === trimmed.toLowerCase());
    setAliasInput("");
    setAliasResetTick((tick) => tick + 1);
    if (!duplicate) {
      setAliasesDraft((prev) => [...prev, trimmed]);
    }
  }, [aliasInput, aliasesDraft]);

  const handleRemoveAlias = useCallback((target: string) => {
    setAliasesDraft((prev) => removeStringItem(prev, target));
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (disabled || savingProfile || !profileDirty) return;
    setSavingProfile(true);
    try {
      await onApplyPatch(
        {
          profile: {
            aboutMe: aboutMeDraft.slice(0, MAIN_CHAT_ABOUT_ME_MAX_CHARS),
            ownerAliases: aliasesDraft,
          },
        },
        t("mainChat.memoryProfile.profileSavedToast"),
      );
    } finally {
      setSavingProfile(false);
    }
  }, [aboutMeDraft, aliasesDraft, disabled, onApplyPatch, profileDirty, savingProfile, t]);

  const canAddAlias =
    !disabled &&
    aliasInput.trim().length > 0 &&
    aliasesDraft.length < MAIN_CHAT_OWNER_ALIASES_MAX_COUNT;

  return (
    <View style={[settingsStyles.row, styles.sectionBlock]} testID="memory-profile-about-section">
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleGroup}>
          <ThemedProfileIcon size={15} uniProps={mutedIconMapping} />
          <Text style={settingsStyles.rowTitle}>{t("mainChat.memoryProfile.aboutMeTitle")}</Text>
        </View>
        <StatusBadge
          variant="muted"
          label={t("mainChat.memoryProfile.charCount", {
            count: aboutMeDraft.length,
            max: MAIN_CHAT_ABOUT_ME_MAX_CHARS,
          })}
        />
      </View>
      <Text style={settingsStyles.rowHint}>{t("mainChat.memoryProfile.aboutMeHint")}</Text>

      <View style={styles.subFieldGroup}>
        <Text style={styles.subFieldLabel}>{t("mainChat.memoryProfile.aliasesLabel")}</Text>
        <Text style={settingsStyles.rowHint}>{t("mainChat.memoryProfile.aliasesHint")}</Text>
        {aliasesDraft.length > 0 ? (
          <View style={styles.chipList} testID="memory-profile-aliases-list">
            {aliasesDraft.map((alias) => (
              <AliasChip
                key={alias}
                alias={alias}
                disabled={disabled}
                onRemove={handleRemoveAlias}
              />
            ))}
          </View>
        ) : null}
        <View style={styles.aliasInputRow}>
          <FormTextInput
            size="sm"
            style={styles.singleLineInput}
            initialValue=""
            resetKey={`${serverId}:alias:${aliasResetTick}`}
            onChangeText={setAliasInput}
            onSubmitEditing={handleAddAlias}
            placeholder={t("mainChat.memoryProfile.aliasPlaceholder")}
            maxLength={MAIN_CHAT_OWNER_ALIAS_MAX_CHARS}
            editable={!disabled}
            testID="memory-profile-alias-input"
          />
          <Button
            variant="secondary"
            size="sm"
            onPress={handleAddAlias}
            disabled={!canAddAlias}
            testID="memory-profile-alias-add"
          >
            {t("mainChat.memoryProfile.addAliasButton")}
          </Button>
        </View>
      </View>

      <FormTextInput
        size="sm"
        style={styles.multilineInput}
        initialValue={resolvedProfile.aboutMe}
        resetKey={`${serverId}:about:${resolvedProfile.updatedAt ?? ""}:${resolvedProfile.aboutMe.length}`}
        onChangeText={setAboutMeDraft}
        placeholder={t("mainChat.memoryProfile.aboutMePlaceholder")}
        multiline
        textAlignVertical="top"
        maxLength={MAIN_CHAT_ABOUT_ME_MAX_CHARS}
        editable={!disabled}
        testID="memory-profile-about-me-input"
      />

      <View style={styles.footerRow}>
        <Button
          variant="default"
          size="sm"
          onPress={handleSaveProfile}
          disabled={disabled || savingProfile || !profileDirty}
          testID="memory-profile-save-button"
        >
          {t("mainChat.memoryProfile.saveProfileButton")}
        </Button>
      </View>
    </View>
  );
});

const DirectionNotesEditor = memo(function DirectionNotesEditor({
  serverId,
  leaders,
  activeLeader,
  disabled,
  hasClient,
  savingNotes,
  notesDirty,
  onSelectDirection,
  onChangeNotes,
  onSaveNotes,
}: {
  serverId: string;
  leaders: readonly MainChatConversationRecord[];
  activeLeader: MainChatConversationRecord | null;
  disabled: boolean;
  hasClient: boolean;
  savingNotes: boolean;
  notesDirty: boolean;
  onSelectDirection: (conversationId: string) => void;
  onChangeNotes: (value: string) => void;
  onSaveNotes: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const initialNotes = activeLeader?.notes ?? "";
  const resetKey = `${serverId}:dir:${activeLeader?.id ?? ""}:${activeLeader?.updatedAt ?? ""}:${initialNotes}`;

  return (
    <>
      <View style={styles.directionPills} testID="memory-profile-direction-pills">
        {leaders.map((leader) => (
          <DirectionPill
            key={leader.id}
            leader={leader}
            selected={leader.id === activeLeader?.id}
            onSelect={onSelectDirection}
          />
        ))}
      </View>

      {activeLeader?.directionSummary ? (
        <Text style={styles.directionSummaryText} numberOfLines={2}>
          {activeLeader.directionSummary}
        </Text>
      ) : null}

      <FormTextInput
        size="sm"
        style={styles.multilineInput}
        initialValue={initialNotes}
        resetKey={resetKey}
        onChangeText={onChangeNotes}
        placeholder={t("mainChat.memoryProfile.directionNotesPlaceholder")}
        multiline
        textAlignVertical="top"
        maxLength={MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS}
        editable={!disabled && hasClient}
        testID="memory-profile-direction-notes-input"
      />

      <View style={styles.footerRow}>
        <Button
          variant="default"
          size="sm"
          onPress={onSaveNotes}
          disabled={disabled || !hasClient || savingNotes || !notesDirty}
          testID="memory-profile-direction-notes-save"
        >
          {t("mainChat.memoryProfile.saveNotesButton")}
        </Button>
      </View>
    </>
  );
});

const DirectionNotesSection = memo(function DirectionNotesSection({
  serverId,
  client,
  disabled,
}: {
  serverId: string;
  client: DaemonClient | null;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const conversations = useMainChatConversationsStore(
    (state) => state.conversationsByServerId[serverId] ?? EMPTY_CONVERSATIONS,
  );
  const refreshConversations = useMainChatConversationsStore((state) => state.refreshConversations);
  const updateConversation = useMainChatConversationsStore((state) => state.updateConversation);

  useEffect(() => {
    if (!client || typeof client.listMainChatConversations !== "function") return;
    void refreshConversations(serverId, client).catch(() => undefined);
  }, [client, refreshConversations, serverId]);

  const leaders = useMemo(
    () => conversations.filter((item) => item.kind === "leader" && item.archivedAt === null),
    [conversations],
  );

  const [selectedDirectionId, setSelectedDirectionId] = useState<string | null>(
    () => leaders[0]?.id ?? null,
  );

  useEffect(() => {
    if (leaders.length === 0) {
      setSelectedDirectionId(null);
      return;
    }
    if (!selectedDirectionId || !leaders.some((item) => item.id === selectedDirectionId)) {
      setSelectedDirectionId(leaders[0]!.id);
    }
  }, [leaders, selectedDirectionId]);

  const activeLeader = useMemo(
    () => leaders.find((item) => item.id === selectedDirectionId) ?? leaders[0] ?? null,
    [leaders, selectedDirectionId],
  );

  const [notesDraft, setNotesDraft] = useState(activeLeader?.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);

  useEffect(() => {
    setNotesDraft(activeLeader?.notes ?? "");
  }, [activeLeader?.id, activeLeader?.notes]);

  const notesDirty = (activeLeader?.notes ?? "") !== notesDraft;

  const handleSaveNotes = useCallback(async () => {
    if (!client || !activeLeader || disabled || savingNotes || !notesDirty) return;
    setSavingNotes(true);
    try {
      await updateConversation(
        serverId,
        {
          conversationId: activeLeader.id,
          notes: notesDraft.trim().length > 0 ? notesDraft : null,
        },
        client,
      );
      toast.show(t("mainChat.memoryProfile.notesSavedToast"), { variant: "success" });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("mainChat.memoryProfile.notesSaveFailed"),
      );
    } finally {
      setSavingNotes(false);
    }
  }, [
    activeLeader,
    client,
    disabled,
    notesDirty,
    notesDraft,
    savingNotes,
    serverId,
    t,
    toast,
    updateConversation,
  ]);

  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.sectionBlock]}
      testID="memory-profile-direction-notes-section"
    >
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleGroup}>
          <ThemedDirectionIcon size={15} uniProps={mutedIconMapping} />
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.memoryProfile.directionNotesTitle")}
          </Text>
        </View>
        {activeLeader ? (
          <StatusBadge
            variant="muted"
            label={t("mainChat.memoryProfile.charCount", {
              count: notesDraft.length,
              max: MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS,
            })}
          />
        ) : null}
      </View>
      <Text style={settingsStyles.rowHint}>{t("mainChat.memoryProfile.directionNotesHint")}</Text>

      {leaders.length === 0 ? (
        <View style={styles.emptyNotice} testID="memory-profile-direction-empty">
          <Text style={styles.emptyNoticeText}>
            {t("mainChat.memoryProfile.directionNotesEmpty")}
          </Text>
        </View>
      ) : (
        <DirectionNotesEditor
          serverId={serverId}
          leaders={leaders}
          activeLeader={activeLeader}
          disabled={disabled}
          hasClient={Boolean(client)}
          savingNotes={savingNotes}
          notesDirty={notesDirty}
          onSelectDirection={setSelectedDirectionId}
          onChangeNotes={setNotesDraft}
          onSaveNotes={handleSaveNotes}
        />
      )}
    </View>
  );
});

const MemoryFilesSection = memo(function MemoryFilesSection({
  serverId,
  client,
  disabled,
}: {
  serverId: string;
  client: DaemonClient | null;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const [memoryFiles, setMemoryFiles] = useState<MainChatMemoryFileMeta[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"idle" | "create" | "edit">("idle");
  const [editorPath, setEditorPath] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [editorResetKey, setEditorResetKey] = useState("idle");
  const [loadingFileContent, setLoadingFileContent] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    if (!client || typeof client.listMainChatMemoryFiles !== "function") return;
    setLoadingFiles(true);
    setFilesError(null);
    try {
      const response = await client.listMainChatMemoryFiles();
      if (response.error) {
        setFilesError(response.error);
        return;
      }
      setMemoryFiles(response.files);
    } catch (error) {
      setFilesError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingFiles(false);
    }
  }, [client]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles, serverId]);

  const handleStartCreateFile = useCallback(() => {
    const defaultPath = memoryFiles.some((f) => f.path === "MEMORY.md") ? "" : "MEMORY.md";
    setFilesError(null);
    setConfirmDeletePath(null);
    setEditorMode("create");
    setEditorPath(defaultPath);
    setEditorContent("");
    setEditorResetKey(`create:${Date.now()}:${defaultPath}`);
  }, [memoryFiles]);

  const handleOpenFile = useCallback(
    async (relativePath: string) => {
      if (!client) return;
      setFilesError(null);
      setConfirmDeletePath(null);
      setLoadingFileContent(true);
      try {
        const response = await client.readMainChatMemoryFile(relativePath);
        if (response.error || !response.file) {
          setFilesError(response.error ?? t("mainChat.memoryProfile.fileLoadFailed"));
          return;
        }
        setEditorMode("edit");
        setEditorPath(response.file.path);
        setEditorContent(response.file.content);
        setEditorResetKey(`edit:${response.file.path}:${response.file.updatedAt}`);
      } catch (error) {
        setFilesError(
          error instanceof Error ? error.message : t("mainChat.memoryProfile.fileLoadFailed"),
        );
      } finally {
        setLoadingFileContent(false);
      }
    },
    [client, t],
  );

  const handleCancelEditor = useCallback(() => {
    setEditorMode("idle");
    setEditorPath("");
    setEditorContent("");
    setFilesError(null);
  }, []);

  const handleCancelDelete = useCallback(() => {
    setConfirmDeletePath(null);
  }, []);

  const handleSaveMemoryFile = useCallback(async () => {
    if (!client || savingFile) return;
    const trimmedPath = editorPath.trim();
    if (!trimmedPath) return;
    setSavingFile(true);
    setFilesError(null);
    try {
      const response = await client.writeMainChatMemoryFile(trimmedPath, editorContent);
      if (response.error || !response.file) {
        const msg = response.error ?? t("mainChat.memoryProfile.fileSaveFailed");
        setFilesError(msg);
        toast.error(msg);
        return;
      }
      toast.show(t("mainChat.memoryProfile.fileSavedToast", { path: response.file.path }), {
        variant: "success",
      });
      setEditorMode("edit");
      setEditorPath(response.file.path);
      setEditorResetKey(`saved:${response.file.path}:${response.file.updatedAt}`);
      await loadFiles();
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : t("mainChat.memoryProfile.fileSaveFailed");
      setFilesError(msg);
      toast.error(msg);
    } finally {
      setSavingFile(false);
    }
  }, [client, editorContent, editorPath, loadFiles, savingFile, t, toast]);

  const handleDeleteMemoryFile = useCallback(
    async (relativePath: string) => {
      if (!client || deletingPath) return;
      setDeletingPath(relativePath);
      setFilesError(null);
      try {
        const response = await client.deleteMainChatMemoryFile(relativePath);
        if (response.error) {
          setFilesError(response.error);
          toast.error(response.error);
          return;
        }
        toast.show(t("mainChat.memoryProfile.fileDeletedToast", { path: relativePath }), {
          variant: "success",
        });
        if (editorPath === relativePath) {
          setEditorMode("idle");
          setEditorPath("");
          setEditorContent("");
        }
        setConfirmDeletePath(null);
        await loadFiles();
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : t("mainChat.memoryProfile.fileDeleteFailed");
        setFilesError(msg);
        toast.error(msg);
      } finally {
        setDeletingPath(null);
      }
    },
    [client, deletingPath, editorPath, loadFiles, t, toast],
  );

  const pathInputStyle = useMemo(
    () =>
      editorMode === "edit"
        ? [styles.singleLineInput, styles.singleLineInputReadonly]
        : styles.singleLineInput,
    [editorMode],
  );

  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.sectionBlock]}
      testID="memory-profile-files-section"
    >
      <View style={styles.sectionHeader}>
        <View style={styles.sectionTitleGroup}>
          <ThemedFileText size={15} uniProps={mutedIconMapping} />
          <Text style={settingsStyles.rowTitle}>{t("mainChat.memoryProfile.filesTitle")}</Text>
        </View>
        <View style={styles.headerActions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={REFRESH_FILES_ICON}
            onPress={loadFiles}
            disabled={!client || loadingFiles}
            testID="memory-files-refresh-button"
          >
            {t("mainChat.memoryProfile.refreshFiles")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={NEW_FILE_ICON}
            onPress={handleStartCreateFile}
            disabled={disabled || !client}
            testID="memory-files-new-button"
          >
            {t("mainChat.memoryProfile.newFileButton")}
          </Button>
        </View>
      </View>
      <Text style={settingsStyles.rowHint}>{t("mainChat.memoryProfile.filesHint")}</Text>

      {filesError ? (
        <View style={styles.errorBanner} testID="memory-files-error">
          <Text style={styles.errorText}>{filesError}</Text>
        </View>
      ) : null}

      {memoryFiles.length === 0 ? (
        <View style={styles.emptyNotice} testID="memory-files-empty">
          <Text style={styles.emptyNoticeText}>{t("mainChat.memoryProfile.emptyFiles")}</Text>
        </View>
      ) : (
        <View style={styles.fileList} testID="memory-files-list">
          {memoryFiles.map((file, index) => (
            <MemoryFileRow
              key={file.path}
              file={file}
              index={index}
              selected={editorMode === "edit" && editorPath === file.path}
              confirmingDelete={confirmDeletePath === file.path}
              deleting={deletingPath === file.path}
              disabled={disabled || !client}
              loadingContent={loadingFileContent}
              onOpen={handleOpenFile}
              onRequestDelete={setConfirmDeletePath}
              onConfirmDelete={handleDeleteMemoryFile}
              onCancelDelete={handleCancelDelete}
            />
          ))}
        </View>
      )}

      {editorMode !== "idle" ? (
        <View style={styles.editorCard} testID="memory-file-editor">
          <View style={styles.subFieldGroup}>
            <Text style={styles.subFieldLabel}>{t("mainChat.memoryProfile.filePathLabel")}</Text>
            <FormTextInput
              size="sm"
              style={pathInputStyle}
              initialValue={editorPath}
              resetKey={`path:${editorResetKey}`}
              onChangeText={setEditorPath}
              placeholder={t("mainChat.memoryProfile.filePathPlaceholder")}
              editable={editorMode === "create" && !savingFile}
              autoCapitalize="none"
              autoCorrect={false}
              testID="memory-file-path-input"
            />
          </View>
          <View style={styles.subFieldGroup}>
            <Text style={styles.subFieldLabel}>{t("mainChat.memoryProfile.fileContentLabel")}</Text>
            <FormTextInput
              size="sm"
              style={styles.multilineInput}
              initialValue={editorContent}
              resetKey={`content:${editorResetKey}`}
              onChangeText={setEditorContent}
              placeholder={t("mainChat.memoryProfile.fileContentPlaceholder")}
              multiline
              textAlignVertical="top"
              editable={!disabled && !savingFile}
              testID="memory-file-content-input"
            />
          </View>
          <View style={styles.editorFooter}>
            <Button
              variant="secondary"
              size="sm"
              onPress={handleCancelEditor}
              disabled={savingFile}
              testID="memory-file-cancel-button"
            >
              {t("mainChat.memoryProfile.cancelButton")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={handleSaveMemoryFile}
              disabled={disabled || !client || savingFile || editorPath.trim().length === 0}
              testID="memory-file-save-button"
            >
              {t("mainChat.memoryProfile.saveFileButton")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
});

export interface MainChatMemoryProfilePanelProps {
  serverId: string;
  client: DaemonClient | null;
  settings: MainChatSettings;
  disabled: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => Promise<void> | void;
}

export const MainChatMemoryProfilePanel = memo(function MainChatMemoryProfilePanel({
  serverId,
  client,
  settings,
  disabled,
  onApplyPatch,
}: MainChatMemoryProfilePanelProps): ReactElement {
  return (
    <View style={settingsStyles.card} testID="main-chat-memory-profile-panel">
      <AboutMeSection
        serverId={serverId}
        settings={settings}
        disabled={disabled}
        onApplyPatch={onApplyPatch}
      />
      <DirectionNotesSection serverId={serverId} client={client} disabled={disabled} />
      <MemoryFilesSection serverId={serverId} client={client} disabled={disabled} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  sectionBlock: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 6,
    paddingVertical: 10,
    minWidth: 0,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  sectionTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    flexShrink: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  subFieldGroup: {
    gap: theme.spacing[1],
    minWidth: 0,
  },
  subFieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  chipList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  aliasChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  aliasChipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  aliasRemoveButton: {
    borderRadius: theme.borderRadius.full,
    padding: 2,
  },
  subtleHighlight: {
    backgroundColor: theme.colors.surface2,
  },
  aliasInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    marginTop: 2,
  },
  singleLineInput: {
    flex: 1,
    minWidth: 0,
  },
  singleLineInputReadonly: {
    opacity: 0.72,
  },
  multilineInput: {
    width: "100%",
    minWidth: 0,
    minHeight: 68,
    lineHeight: 18,
  },
  footerRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyNotice: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  emptyNoticeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  directionPills: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  directionPill: {
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 5,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  directionPillActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  directionPillText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  directionPillTextActive: {
    color: theme.colors.foreground,
  },
  directionSummaryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 17,
  },
  errorBanner: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.surface1,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  fileList: {
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    minWidth: 0,
  },
  fileRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  fileRowActive: {
    backgroundColor: theme.colors.surface2,
  },
  fileRowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  fileRowPath: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  fileRowMeta: {
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  fileRowActions: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  iconActionButton: {
    padding: 6,
    borderRadius: theme.borderRadius.sm,
  },
  editorCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    minWidth: 0,
  },
  editorFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
