import equal from "fast-deep-equal";
import {
  Folder,
  GitBranch,
  ListTodo,
  MessageSquare,
  Plus,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { EditingTextInput } from "@/components/ui/text-input";
import { useComposerEditingSession } from "@/composer/editing-session";
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
import { MainChatNextStepsBar } from "./next-steps-bar";
import { MainChatQueuePanel } from "./queue-panel";
import { useStewardAllowedServerIds } from "./use-steward-roster";
import { useMainChatQueueStore } from "./queue-store";

const ThemedPlusIcon = withUnistyles(Plus);
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

export interface MainChatComposerEnhancementsProps {
  serverId: string;
  agentId: string;
  /** Optional hook override for unit tests to observe/intercept risky prefill or mention injection. */
  onDraftTextInjected?: (nextText: string) => void;
  /** Optional custom sender passed down to QueuePanel and NextStepsBar. */
  onSendMessage?: (text: string) => Promise<void>;
}

/**
 * Unified M5 composer enhancements mounted inside Main Chat's `ComposerEditingScope`:
 * - Visual send-queue bar (`MainChatQueuePanel`)
 * - Compact `+` context reference & queue menu (consolidating host/workspace/repo/session/skill/queue)
 * - Next-step suggestion chips (`MainChatNextStepsBar`, safe direct-send vs risky prefill-only)
 */
export const MainChatComposerEnhancements = memo(function MainChatComposerEnhancements({
  serverId,
  agentId,
  onDraftTextInjected,
  onSendMessage,
}: MainChatComposerEnhancementsProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const editingSession = useComposerEditingSession("chat");
  const hosts = useHosts();
  const enqueue = useMainChatQueueStore((state) => state.enqueue);

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
        activePickerKind
          ? collectMainChatMentionSources({
              sessions: state.sessions,
              excludeAgentId: agentId,
              allowedServerIds,
            })
          : EMPTY_PICKER_SOURCES,
      [activePickerKind, agentId, allowedServerIds],
    ),
    equal,
  );

  const commandsQuery = useAutocompleteCommands({
    serverId,
    agentId,
    enabled: activePickerKind === "skill" && Boolean(serverId) && Boolean(agentId),
  });

  const pickerItems = useMemo(() => {
    if (!activePickerKind) return [];
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
  }, [activePickerKind, commandsQuery.commands, hostLabelsByServerId, pickerSources]);

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

  const handlePrefillRiskySuggestion = useCallback(
    (prompt: string) => {
      applyTextToComposer(prompt);
    },
    [applyTextToComposer],
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

  return (
    <View style={styles.container} testID="main-chat-composer-enhancements">
      <MainChatQueuePanel serverId={serverId} agentId={agentId} onSendMessage={onSendMessage} />

      {activePickerKind ? (
        <View style={styles.rail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
          <InlineMentionPicker
            kind={activePickerKind}
            items={pickerItems}
            onSelect={handleSelectMentionItem}
            onClose={handleClosePicker}
          />
        </View>
      ) : null}

      {quickQueueOpen ? (
        <View style={styles.rail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
          <QuickQueueBar
            value={quickQueueDraft}
            onChange={setQuickQueueDraft}
            onSubmit={handleSubmitQuickQueue}
            onClose={handleCloseQuickQueue}
          />
        </View>
      ) : null}

      <View style={styles.rail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
        <View style={styles.toolbarRow}>
          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              hitSlop={6}
              style={styles.plusButton}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.composer.attachMenu.triggerLabel")}
              testID="main-chat-composer-attach-trigger"
            >
              <ThemedPlusIcon size={15} uniProps={mutedIconMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="top"
              width={236}
              sheetTitle={t("mainChat.composer.attachMenu.triggerLabel")}
            >
              <DropdownMenuLabel>
                {t("mainChat.composer.attachMenu.sectionReferences")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                leading={hostMenuIcon}
                onSelect={handleOpenHostPicker}
                testID="main-chat-attach-ref-host"
              >
                {t("mainChat.composer.attachMenu.refHost")}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={workspaceMenuIcon}
                onSelect={handleOpenWorkspacePicker}
                testID="main-chat-attach-ref-workspace"
              >
                {t("mainChat.composer.attachMenu.refWorkspace")}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={repoMenuIcon}
                onSelect={handleOpenRepoPicker}
                testID="main-chat-attach-ref-repo"
              >
                {t("mainChat.composer.attachMenu.refRepo")}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={sessionMenuIcon}
                onSelect={handleOpenSessionPicker}
                testID="main-chat-attach-ref-session"
              >
                {t("mainChat.composer.attachMenu.refSession")}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={skillMenuIcon}
                onSelect={handleOpenSkillPicker}
                testID="main-chat-attach-ref-skill"
              >
                {t("mainChat.composer.attachMenu.refSkill")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                {t("mainChat.composer.attachMenu.sectionQueue")}
              </DropdownMenuLabel>
              <DropdownMenuItem
                leading={queueMenuIcon}
                onSelect={handleQueueAction}
                testID="main-chat-attach-queue-message"
              >
                {t("mainChat.composer.attachMenu.queueNewMessage")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <MainChatNextStepsBar
            serverId={serverId}
            agentId={agentId}
            onSendSafePrompt={onSendMessage}
            onPrefillRiskyPrompt={handlePrefillRiskySuggestion}
          />
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  rail: {
    width: "100%",
    paddingBottom: theme.spacing[1],
  },
  toolbarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  plusButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
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
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  quickQueueInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
  },
}));
