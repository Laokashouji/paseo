import equal from "fast-deep-equal";
import {
  Folder,
  GitBranch,
  ListTodo,
  MessageSquare,
  Server,
  Sparkles,
  X,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useAutocompleteCommands } from "@/agent-commands";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { EditingTextInput } from "@/components/ui/text-input";
import { useComposerEditingSession } from "@/composer/editing-session";
import type { AttachmentMenuItem } from "@/composer/input/input";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { extractSkillMentionSources } from "./autocomplete-tasks";
import {
  appendMentionTokenToText,
  buildMainChatMentionItems,
  collectMainChatMentionSources,
  type MainChatMentionItem,
  type MainChatMentionKind,
} from "./mention-sources";
import { MainChatQueuePanel } from "./queue-panel";
import { useMainChatQueueStore } from "./queue-store";
import { useStewardAllowedServerIds } from "./use-steward-roster";

const ThemedServerIcon = withUnistyles(Server);
const ThemedFolderIcon = withUnistyles(Folder);
const ThemedRepoIcon = withUnistyles(GitBranch);
const ThemedSessionIcon = withUnistyles(MessageSquare);
const ThemedSkillIcon = withUnistyles(Sparkles);
const ThemedQueueIcon = withUnistyles(ListTodo);
const ThemedXIcon = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const placeholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});
const ThemedTextInput = withUnistyles(EditingTextInput, placeholderColorMapping);

const hostMenuIcon = <ThemedServerIcon size={14} uniProps={mutedIconMapping} />;
const workspaceMenuIcon = <ThemedFolderIcon size={14} uniProps={mutedIconMapping} />;
const repoMenuIcon = <ThemedRepoIcon size={14} uniProps={mutedIconMapping} />;
const sessionMenuIcon = <ThemedSessionIcon size={14} uniProps={mutedIconMapping} />;
const skillMenuIcon = <ThemedSkillIcon size={14} uniProps={mutedIconMapping} />;
const queueMenuIcon = <ThemedQueueIcon size={14} uniProps={primaryIconMapping} />;

const EMPTY_MENU_ITEMS: readonly AttachmentMenuItem[] = [];

const EMPTY_PICKER_SOURCES = {
  hosts: [],
  workspaces: [],
  repos: [],
  sessions: [],
};

function categoryTitleKey(kind: MainChatMentionKind): string {
  switch (kind) {
    case "host":
      return "mainChat.composer.mentions.tagHost";
    case "workspace":
      return "mainChat.composer.mentions.tagWorkspace";
    case "repo":
      return "mainChat.composer.mentions.tagRepo";
    case "session":
      return "mainChat.composer.mentions.tagSession";
    case "skill":
      return "mainChat.composer.mentions.tagSkill";
  }
}

interface InlineMentionPickerProps {
  kind: MainChatMentionKind;
  items: readonly MainChatMentionItem[];
  onSelect: (item: MainChatMentionItem) => void;
  onClose: () => void;
}

interface MentionPickerItemChipProps {
  item: MainChatMentionItem;
  onSelect: (item: MainChatMentionItem) => void;
}

const MentionPickerItemChip = memo(function MentionPickerItemChip({
  item,
  onSelect,
}: MentionPickerItemChipProps): ReactElement {
  const handlePress = useCallback(() => onSelect(item), [item, onSelect]);
  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.pickerItem}
      highlightStyle={styles.controlPressed}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      testID={`main-chat-mention-pick-${item.id}`}
    >
      <Text style={styles.pickerItemTitle} numberOfLines={1}>
        {item.title}
      </Text>
      {item.subtitle ? (
        <Text style={styles.pickerItemSubtitle} numberOfLines={1}>
          {item.subtitle}
        </Text>
      ) : null}
    </PressHighlight>
  );
});

const InlineMentionPicker = memo(function InlineMentionPicker({
  kind,
  items,
  onSelect,
  onClose,
}: InlineMentionPickerProps): ReactElement {
  const { t } = useTranslation();
  const categoryLabel = t(categoryTitleKey(kind));

  return (
    <View style={styles.pickerCard} testID={`main-chat-mention-picker-${kind}`}>
      <View style={styles.pickerHeader}>
        <Text style={styles.pickerTitle}>
          {categoryLabel} · {t("mainChat.composer.attachMenu.pickerHint")}
        </Text>
        <PressHighlight
          onPress={onClose}
          style={styles.closeButton}
          highlightStyle={styles.controlPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.composer.attachMenu.closePicker")}
          testID="main-chat-mention-picker-close"
        >
          <ThemedXIcon size={13} uniProps={mutedIconMapping} />
        </PressHighlight>
      </View>
      {items.length === 0 ? (
        <Text style={styles.pickerEmpty}>
          {t("mainChat.composer.mentions.emptyCategory", { category: categoryLabel })}
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.pickerList}
        >
          {items.map((item) => (
            <MentionPickerItemChip key={item.id} item={item} onSelect={onSelect} />
          ))}
        </ScrollView>
      )}
    </View>
  );
});

interface QuickQueueBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

const QuickQueueBar = memo(function QuickQueueBar({
  value,
  onChange,
  onSubmit,
  onClose,
}: QuickQueueBarProps): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.quickQueueRow} testID="main-chat-quick-queue-bar">
      <ThemedTextInput
        initialValue={value}
        onChangeText={onChange}
        placeholder={t("mainChat.composer.queue.addPromptPlaceholder")}
        style={styles.quickQueueInput}
        returnKeyType="done"
        onSubmitEditing={onSubmit}
        testID="main-chat-quick-queue-input"
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={value.trim().length === 0}
        onPress={onSubmit}
        testID="main-chat-quick-queue-submit"
      >
        {t("mainChat.composer.queue.addSubmitAction")}
      </Button>
      <PressHighlight
        onPress={onClose}
        style={styles.closeButton}
        highlightStyle={styles.controlPressed}
        accessibilityRole="button"
        accessibilityLabel={t("common.actions.cancel")}
        testID="main-chat-quick-queue-close"
      >
        <ThemedXIcon size={13} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

export interface MainChatComposerToolbarInput {
  serverId: string;
  agentId: string;
  enabled?: boolean;
  /** Optional hook override for unit tests to observe mention injection. */
  onDraftTextInjected?: (nextText: string) => void;
  /** Optional custom sender passed down to QueuePanel. */
  onSendMessage?: (text: string) => Promise<void>;
}

export interface MainChatComposerToolbarResult {
  /** Context reference and queue items folded cleanly into the Composer's own `+` toolbar menu. */
  extraAttachmentMenuItems: readonly AttachmentMenuItem[];
  /** Active transient overlay (queued messages, inline mention picker, or quick-queue input); null at rest. */
  overlay: ReactElement | null;
}

/**
 * Consolidates Main Chat's `+` context-reference (host/workspace/repo/session/skill) and queue
 * actions directly into the Composer's bottom-left `+` toolbar menu, eliminating the extra
 * floating suggestion/toolbar bar above the status capsule dock.
 */
export function useMainChatComposerToolbar({
  serverId,
  agentId,
  enabled = true,
  onDraftTextInjected,
  onSendMessage,
}: MainChatComposerToolbarInput): MainChatComposerToolbarResult {
  const { t } = useTranslation();
  const toast = useToast();
  const editingSession = useComposerEditingSession("chat");
  const hosts = useHosts();
  const enqueue = useMainChatQueueStore((state) => state.enqueue);
  const queueCount = useMainChatQueueStore((state) => state.queuesByAgentId[agentId]?.length ?? 0);

  const [activePickerKind, setActivePickerKind] = useState<MainChatMentionKind | null>(null);
  const [quickQueueOpen, setQuickQueueOpen] = useState(false);
  const [quickQueueDraft, setQuickQueueDraft] = useState("");

  const draftKey = useMemo(() => buildDraftStoreKey({ serverId, agentId }), [agentId, serverId]);

  const hostLabelsByServerId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const host of hosts) {
      if (host.label.trim().length > 0) {
        map[host.serverId] = host.label.trim();
      }
    }
    return map;
  }, [hosts]);

  const allowedServerIds = useStewardAllowedServerIds(serverId);

  const pickerSources = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        enabled && activePickerKind
          ? collectMainChatMentionSources({
              sessions: state.sessions,
              excludeAgentId: agentId,
              allowedServerIds,
            })
          : EMPTY_PICKER_SOURCES,
      [activePickerKind, agentId, allowedServerIds, enabled],
    ),
    equal,
  );

  const commandsQuery = useAutocompleteCommands({
    serverId,
    agentId,
    enabled: enabled && activePickerKind === "skill" && Boolean(serverId) && Boolean(agentId),
  });

  const pickerItems = useMemo(() => {
    if (!enabled || !activePickerKind) return [];
    const labeledHosts = pickerSources.hosts.map((host) => ({
      ...host,
      label: hostLabelsByServerId[host.serverId] ?? host.label,
    }));
    const labeledWorkspaces = pickerSources.workspaces.map((ws) => ({
      ...ws,
      hostLabel: hostLabelsByServerId[ws.serverId] ?? ws.hostLabel,
    }));
    const labeledRepos = pickerSources.repos.map((repo) => ({
      ...repo,
      hostLabel: hostLabelsByServerId[repo.serverId] ?? repo.hostLabel,
    }));
    const labeledSessions = pickerSources.sessions.map((session) => ({
      ...session,
      hostLabel: hostLabelsByServerId[session.serverId] ?? session.hostLabel,
    }));
    return buildMainChatMentionItems({
      query: `${activePickerKind}:`,
      hosts: labeledHosts,
      workspaces: labeledWorkspaces,
      repos: labeledRepos,
      sessions: labeledSessions,
      skills: extractSkillMentionSources(commandsQuery.commands),
      limitPerCategory: 12,
      maxTotal: 12,
    });
  }, [activePickerKind, commandsQuery.commands, enabled, hostLabelsByServerId, pickerSources]);

  const applyTextToComposer = useCallback(
    (nextText: string) => {
      useDraftStore.getState().replaceDraftText({ draftKey, text: nextText });
      editingSession.focus();
      onDraftTextInjected?.(nextText);
    },
    [draftKey, editingSession, onDraftTextInjected],
  );

  const handleSelectMentionItem = useCallback(
    (item: MainChatMentionItem) => {
      const currentText = useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
      const nextText = appendMentionTokenToText(currentText, item.injectionToken);
      applyTextToComposer(nextText);
      setActivePickerKind(null);
      toast.show(t("mainChat.composer.mentions.injectedToast", { label: item.title }), {
        variant: "info",
      });
    },
    [applyTextToComposer, draftKey, t, toast],
  );

  const handleOpenHostPicker = useCallback(() => {
    setQuickQueueOpen(false);
    setActivePickerKind("host");
  }, []);
  const handleOpenWorkspacePicker = useCallback(() => {
    setQuickQueueOpen(false);
    setActivePickerKind("workspace");
  }, []);
  const handleOpenRepoPicker = useCallback(() => {
    setQuickQueueOpen(false);
    setActivePickerKind("repo");
  }, []);
  const handleOpenSessionPicker = useCallback(() => {
    setQuickQueueOpen(false);
    setActivePickerKind("session");
  }, []);
  const handleOpenSkillPicker = useCallback(() => {
    setQuickQueueOpen(false);
    setActivePickerKind("skill");
  }, []);

  const handleQueueAction = useCallback(() => {
    setActivePickerKind(null);
    const currentDraft = (useDraftStore.getState().getDraftInput(draftKey)?.text ?? "").trim();
    if (currentDraft.length > 0) {
      enqueue(agentId, currentDraft);
      useDraftStore.getState().replaceDraftText({ draftKey, text: "" });
      toast.show(t("mainChat.composer.queue.enqueuedToast"), { variant: "success" });
      return;
    }
    setQuickQueueOpen(true);
  }, [agentId, draftKey, enqueue, t, toast]);

  const handleSubmitQuickQueue = useCallback(() => {
    const trimmed = quickQueueDraft.trim();
    if (!trimmed) return;
    enqueue(agentId, trimmed);
    setQuickQueueDraft("");
    setQuickQueueOpen(false);
    toast.show(t("mainChat.composer.queue.enqueuedToast"), { variant: "success" });
  }, [agentId, enqueue, quickQueueDraft, t, toast]);

  const handleClosePicker = useCallback(() => setActivePickerKind(null), []);
  const handleCloseQuickQueue = useCallback(() => {
    setQuickQueueOpen(false);
    setQuickQueueDraft("");
  }, []);

  const extraAttachmentMenuItems = useMemo<readonly AttachmentMenuItem[]>(() => {
    if (!enabled) return EMPTY_MENU_ITEMS;
    return [
      {
        id: "main-chat-ref-host",
        label: t("mainChat.composer.attachMenu.refHost"),
        icon: hostMenuIcon,
        onSelect: handleOpenHostPicker,
        testID: "main-chat-attach-ref-host",
        dividerBefore: true,
        sectionLabel: t("mainChat.composer.attachMenu.sectionReferences"),
      },
      {
        id: "main-chat-ref-workspace",
        label: t("mainChat.composer.attachMenu.refWorkspace"),
        icon: workspaceMenuIcon,
        onSelect: handleOpenWorkspacePicker,
        testID: "main-chat-attach-ref-workspace",
      },
      {
        id: "main-chat-ref-repo",
        label: t("mainChat.composer.attachMenu.refRepo"),
        icon: repoMenuIcon,
        onSelect: handleOpenRepoPicker,
        testID: "main-chat-attach-ref-repo",
      },
      {
        id: "main-chat-ref-session",
        label: t("mainChat.composer.attachMenu.refSession"),
        icon: sessionMenuIcon,
        onSelect: handleOpenSessionPicker,
        testID: "main-chat-attach-ref-session",
      },
      {
        id: "main-chat-ref-skill",
        label: t("mainChat.composer.attachMenu.refSkill"),
        icon: skillMenuIcon,
        onSelect: handleOpenSkillPicker,
        testID: "main-chat-attach-ref-skill",
      },
      {
        id: "main-chat-queue-message",
        label: t("mainChat.composer.attachMenu.queueNewMessage"),
        icon: queueMenuIcon,
        onSelect: handleQueueAction,
        testID: "main-chat-attach-queue-message",
        dividerBefore: true,
        sectionLabel: t("mainChat.composer.attachMenu.sectionQueue"),
      },
    ];
  }, [
    enabled,
    handleOpenHostPicker,
    handleOpenRepoPicker,
    handleOpenSessionPicker,
    handleOpenSkillPicker,
    handleOpenWorkspacePicker,
    handleQueueAction,
    t,
  ]);

  const hasActiveOverlay =
    enabled && (queueCount > 0 || activePickerKind !== null || quickQueueOpen);

  const overlay = useMemo<ReactElement | null>(() => {
    if (!hasActiveOverlay) return null;
    return (
      <View
        style={styles.container}
        dataSet={CHAT_COLUMN_RAIL_DATASET}
        testID="main-chat-composer-enhancements"
      >
        <View style={styles.inner} testID="main-chat-composer-enhancements-inner">
          <MainChatQueuePanel serverId={serverId} agentId={agentId} onSendMessage={onSendMessage} />

          {activePickerKind ? (
            <View style={styles.rail}>
              <InlineMentionPicker
                kind={activePickerKind}
                items={pickerItems}
                onSelect={handleSelectMentionItem}
                onClose={handleClosePicker}
              />
            </View>
          ) : null}

          {quickQueueOpen ? (
            <View style={styles.rail}>
              <QuickQueueBar
                value={quickQueueDraft}
                onChange={setQuickQueueDraft}
                onSubmit={handleSubmitQuickQueue}
                onClose={handleCloseQuickQueue}
              />
            </View>
          ) : null}
        </View>
      </View>
    );
  }, [
    activePickerKind,
    agentId,
    handleClosePicker,
    handleCloseQuickQueue,
    handleSelectMentionItem,
    handleSubmitQuickQueue,
    hasActiveOverlay,
    onSendMessage,
    pickerItems,
    quickQueueDraft,
    quickQueueOpen,
    serverId,
  ]);

  return { extraAttachmentMenuItems, overlay };
}

export interface MainChatComposerEnhancementsProps {
  serverId: string;
  agentId: string;
  onDraftTextInjected?: (nextText: string) => void;
  onSendMessage?: (text: string) => Promise<void>;
}

/**
 * Renders only transient composer overlays (queued messages) when active. Returns `null` at rest
 * because next-step pills were removed and the `+` context/queue menu now lives inside Composer's
 * bottom-left toolbar.
 */
export const MainChatComposerEnhancements = memo(function MainChatComposerEnhancements({
  serverId,
  agentId,
  onDraftTextInjected,
  onSendMessage,
}: MainChatComposerEnhancementsProps): ReactElement | null {
  const { overlay } = useMainChatComposerToolbar({
    serverId,
    agentId,
    enabled: true,
    onDraftTextInjected,
    onSendMessage,
  });
  return overlay;
});

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[0.5],
  },
  inner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[1.5],
  },
  rail: {
    width: "100%",
  },
  controlPressed: {
    backgroundColor: theme.colors.surface2,
  },
  pickerCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  pickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  pickerTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  pickerEmpty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  pickerList: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  pickerItem: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    maxWidth: 220,
    gap: 2,
  },
  pickerItemTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  pickerItemSubtitle: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  closeButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  quickQueueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  quickQueueInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
}));
