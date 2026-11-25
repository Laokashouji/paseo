import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { AutocompleteOption, AutocompleteStatus } from "@/components/ui/autocomplete";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import {
  useAutocompleteCommands,
  type AgentSlashCommand,
  type DraftCommandConfig,
  type DraftCommandTarget,
} from "@/agent-commands";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { pluginDisplayName, usePluginList } from "@/plugins/plugin-list";
import { resolveProviderLabel } from "@/utils/provider-definitions";
import { CLIENT_SLASH_COMMANDS, type ClientSlashCommand } from "@/client-slash-commands";
import type { PluginClientSlashCommand } from "@/plugins/client-slash-commands";
import { mergeSlashCommandSources } from "@/plugins/client-slash-commands/model";
import {
  applySlashCommandReplacement,
  filterAndRankCommandAutocompleteEntries,
  filterInlineSkillCommandEntries,
  findActiveSlashCommand,
  type SlashCommandRange,
} from "@/utils/agent-command-autocomplete";
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";
import {
  applyMainChatContextMentionSelection,
  applyMainChatTaskMentionSelection,
  buildMainChatContextMentionOptions,
  buildMainChatTaskMentionOptions,
  extractSkillMentionSources,
  resolveMainChatFileMenuFlags,
  useMainChatAutocompleteMentions,
  useMainChatAutocompleteTasks,
  type MainChatAutocompleteMentionsState,
  type MainChatContextMentionAutocompleteOption,
  type MainChatTaskAutocompleteOption,
} from "@/main-chat/autocomplete-tasks";
import type { MainChatPromptTemplate } from "@getpaseo/protocol/main-chat";
import type { MainChatDockTaskItem } from "@/main-chat/selectors";
import {
  DEFAULT_PROMPT_LIBRARY_TEMPLATES,
  useMainChatPromptLibraryStore,
} from "@/main-chat/prompt-library-store";
import {
  applyPromptTemplateAutocompleteReplacement,
  buildPromptSlashCommandEntries,
  type PromptSlashCommandEntry,
} from "@/main-chat/prompt-slash-commands";

interface UseAgentAutocompleteInput {
  userInput: string;
  cursorIndex: number;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draft?: DraftCommandTarget;
  onAutocompleteApplied?: () => void;
  onClientSlashCommand?: (command: ClientSlashCommand) => void;
  canExecuteClientSlashCommand?: boolean;
  pluginClientSlashCommands?: readonly PluginClientSlashCommand[];
}

interface AgentAutocompleteKeyPressEvent {
  key: string;
  preventDefault: () => void;
  input: AgentAutocompleteInputSnapshot;
}

interface AgentAutocompleteInputSnapshot {
  text: string;
  selection: { start: number; end: number };
}

type AgentAutocompleteOption =
  | (AutocompleteOption & { type: "client_command"; command: ClientSlashCommand })
  | (AutocompleteOption & {
      type: "plugin_command";
      command: PluginClientSlashCommand;
    })
  | (AutocompleteOption & { type: "prompt_template"; template: MainChatPromptTemplate })
  | (AutocompleteOption & { type: "provider_command" })
  | MainChatTaskAutocompleteOption
  | MainChatContextMentionAutocompleteOption
  | (AutocompleteOption & {
      type: "workspace_entry";
      entryPath: string;
      mention: FileMentionRange;
    });

interface AgentAutocompleteResult {
  isVisible: boolean;
  options: AutocompleteOption[];
  selectedIndex: number;
  /** Shown in place of options; set exactly when `options` is empty. */
  status: AutocompleteStatus | null;
  onSelectOption: (option: AutocompleteOption, input?: AgentAutocompleteInputSnapshot) => void;
  onKeyPress: (event: AgentAutocompleteKeyPressEvent) => boolean;
}

interface AgentAutocompleteSnapshot {
  text: string;
  slashCommand: SlashCommandRange | null;
  fileMention: FileMentionRange | null;
}

function resolveAgentAutocompleteSnapshot(input: {
  input?: AgentAutocompleteInputSnapshot;
  userInput: string;
  cursorIndex: number;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
}): AgentAutocompleteSnapshot {
  if (!input.input) {
    return {
      text: input.userInput,
      slashCommand: input.activeSlashCommand,
      fileMention: input.activeFileMention,
    };
  }

  const text = input.input.text;
  const cursorIndex = input.input.selection.start;
  return {
    text,
    slashCommand: findActiveSlashCommand({ text, cursorIndex }),
    fileMention: findActiveFileMention({ text, cursorIndex }),
  };
}

interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

type AvailableCommand =
  | { source: "client"; command: ClientSlashCommand }
  | { source: "plugin"; command: PluginClientSlashCommand }
  | { source: "prompt"; command: PromptSlashCommandEntry }
  | { source: "provider"; command: AgentSlashCommand };

function resolveDraftQueryConfig(draft?: DraftCommandTarget): DraftCommandConfig | undefined {
  if (draft?.status !== "ready") {
    return undefined;
  }

  const draftConfig = draft.config;
  const cwd = draftConfig.cwd.trim();
  const modeId = draftConfig.modeId?.trim() ?? "";
  const model = draftConfig.model?.trim() ?? "";
  const thinkingOptionId = draftConfig.thinkingOptionId?.trim() ?? "";
  const providerOptions = draftConfig.providerOptions;
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(providerOptions && Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
}

function mapDirectorySuggestionsToEntries(payload: {
  entries?: Array<{ path: string; kind: string }>;
  directories?: string[];
}): DirectorySuggestionEntry[] {
  if (Array.isArray(payload.entries) && payload.entries.length > 0) {
    return payload.entries.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        (entry.kind !== "file" && entry.kind !== "directory")
      ) {
        return [];
      }
      return [{ path: entry.path, kind: entry.kind }];
    });
  }

  return (payload.directories ?? []).map((path) => ({
    path,
    kind: "directory" as const,
  }));
}

const CLIENT_COMMAND_ICONS = {
  "archive-agent": "archive",
  "replace-agent-with-draft": "new-draft",
  "branch-agent": "branch",
  "side-question": "side-question",
} as const satisfies Record<ClientSlashCommand["kind"], AutocompleteOption["icon"]>;

interface CommandOptionContext {
  query: string;
  pluginNames: ReadonlyMap<string, string>;
  t: TFunction;
}

function mapCommandToOption(
  entry: AvailableCommand,
  context: CommandOptionContext,
): AgentAutocompleteOption {
  const command = entry.command;
  const base = {
    id: command.name,
    label: `/${command.name}`,
    // The label carries a leading slash the query does not.
    labelMatches: findHighlightRanges(context.query, command.name).map((range) => ({
      start: range.start + 1,
      length: range.length,
    })),
    argumentHint: command.argumentHint || undefined,
  };
  if (entry.source === "client") {
    return {
      ...base,
      type: "client_command",
      command: entry.command,
      icon: CLIENT_COMMAND_ICONS[entry.command.kind],
      description: context.t(entry.command.descriptionKey),
      tag: "Paseo",
    };
  }
  if (entry.source === "plugin") {
    return {
      ...base,
      type: "plugin_command",
      command: entry.command,
      icon: "plugin",
      description: entry.command.description,
      tag: context.pluginNames.get(entry.command.pluginId) ?? entry.command.pluginId,
    };
  }
  if (entry.source === "prompt") {
    return {
      ...base,
      type: "prompt_template",
      template: entry.command.template,
      icon: "skill",
      description: entry.command.description,
      tag: context.t("mainChat.promptLibrary.autocompleteTag"),
    };
  }
  const isSkill = entry.command.kind === "skill";
  return {
    ...base,
    type: "provider_command",
    icon: isSkill ? "skill" : "command",
    description: entry.command.description,
    tag: isSkill ? context.t("agentAutocomplete.skillTag") : undefined,
  };
}

type AutocompleteMode = "command" | "file" | null;

interface BuildAutocompleteOptionsInput {
  mode: AutocompleteMode;
  commands: AgentSlashCommand[];
  pluginCommands: readonly PluginClientSlashCommand[];
  pluginNames: ReadonlyMap<string, string>;
  promptTemplates: readonly MainChatPromptTemplate[];
  isDraftContext: boolean;
  commandFilterQuery: string;
  activeSlashCommand: SlashCommandRange | null;
  activeFileMention: FileMentionRange | null;
  fileSuggestions: DirectorySuggestionEntry[];
  mainChatTasks: readonly MainChatDockTaskItem[];
  mainChatMentions: MainChatAutocompleteMentionsState;
  t: TFunction;
}

function buildAutocompleteOptions(input: BuildAutocompleteOptionsInput): AgentAutocompleteOption[] {
  if (input.mode === "command") {
    const providerCommands = input.commands.map((command) => ({
      source: "provider" as const,
      command,
    }));
    const rootCommands: AvailableCommand[] = mergeSlashCommandSources({
      builtIn: CLIENT_SLASH_COMMANDS,
      plugins: input.pluginCommands,
      provider: input.commands,
      onPluginCollision(command, winner) {
        console.warn(
          `[Plugins] Client slash command /${command.name} from ${command.pluginId} ignored; ${winner} command wins`,
        );
      },
    })
      .filter((entry) => !input.isDraftContext || entry.source !== "built-in")
      .map((entry): AvailableCommand => {
        if (entry.source === "built-in") return { source: "client", command: entry.command };
        return entry;
      });
    const claimedCommandNames = new Set(
      rootCommands.map((entry) => entry.command.name.toLowerCase()),
    );
    const promptCommands: AvailableCommand[] = buildPromptSlashCommandEntries(input.promptTemplates)
      .filter((entry) => !claimedCommandNames.has(entry.name.toLowerCase()))
      .map((command) => ({
        source: "prompt" as const,
        command,
      }));
    const availableCommands: AvailableCommand[] =
      input.activeSlashCommand?.position === "inline"
        ? [...filterInlineSkillCommandEntries(providerCommands), ...promptCommands]
        : [...rootCommands, ...promptCommands];
    const matches = filterAndRankCommandAutocompleteEntries(
      availableCommands,
      input.commandFilterQuery,
    );
    const context = {
      query: input.commandFilterQuery,
      pluginNames: input.pluginNames,
      t: input.t,
    };
    return orderAutocompleteOptions(matches).map((entry) => mapCommandToOption(entry, context));
  }

  const activeFileMention = input.activeFileMention;
  if (input.mode === "file" && activeFileMention) {
    const taskOptions = buildMainChatTaskMentionOptions({
      tasks: input.mainChatTasks,
      mention: activeFileMention,
      t: input.t,
    });
    const contextMentionOptions = buildMainChatContextMentionOptions({
      isMainChatContext: input.mainChatMentions.isMainChatContext,
      sources: input.mainChatMentions.sources,
      skills: extractSkillMentionSources(input.commands),
      mention: activeFileMention,
      t: input.t,
    });
    const orderedEntries = orderAutocompleteOptions(input.fileSuggestions);
    const fileOptions = orderedEntries.map((entry) => ({
      type: "workspace_entry" as const,
      id: `${entry.kind}:${entry.path}`,
      label: entry.path,
      icon: entry.kind,
      entryPath: entry.path,
      mention: activeFileMention,
    }));
    return [...taskOptions, ...contextMentionOptions, ...fileOptions];
  }

  return [];
}

function resolveAutocompleteMode(args: {
  showFileAutocomplete: boolean;
  showCommandAutocomplete: boolean;
}): AutocompleteMode {
  if (args.showFileAutocomplete) {
    return "file";
  }
  if (args.showCommandAutocomplete) {
    return "command";
  }
  return null;
}

function resolveAutocompleteIsVisible(args: {
  mode: AutocompleteMode;
  canLoadCommands: boolean;
  serverId: string;
  autocompleteCwd: string;
}): boolean {
  if (args.mode === "command") {
    return args.canLoadCommands;
  }
  if (args.mode === "file") {
    return Boolean(args.serverId) && args.autocompleteCwd.length > 0;
  }
  return false;
}

function resolveCanLoadCommands(args: {
  serverId: string;
  agentId: string;
  isDraftContext: boolean;
}): boolean {
  if (!args.serverId) {
    return false;
  }
  return Boolean(args.agentId) || args.isDraftContext;
}

type CommandsState = "ready" | "loading" | "error";

function resolveCommandsState(input: {
  canListCommands: boolean;
  isLoading: boolean;
  isError: boolean;
}): CommandsState {
  if (!input.canListCommands) return "ready";
  if (input.isError) return "error";
  if (input.isLoading) return "loading";
  return "ready";
}

interface AutocompleteMenu {
  options: AgentAutocompleteOption[];
  status: AutocompleteStatus | null;
}

/**
 * One state for the open menu, so options and a loading or error row cannot both claim it:
 * while a status row shows there are no options for Enter or Tab to pick.
 */
function resolveCommandMenu(input: {
  commandsState: CommandsState;
  options: () => AgentAutocompleteOption[];
  providerLabel: string | null;
  error: Error | null;
  onRetry: () => void;
  emptyText: string;
  t: TFunction;
}): AutocompleteMenu {
  const { t } = input;
  if (input.commandsState === "loading") {
    const message = input.providerLabel
      ? t("agentAutocomplete.loadingProviderCommands", { provider: input.providerLabel })
      : t("agentAutocomplete.loadingCommands");
    return { options: [], status: { kind: "loading", message } };
  }
  if (input.commandsState === "error") {
    const title = input.providerLabel
      ? t("agentAutocomplete.providerCommandsFailed", { provider: input.providerLabel })
      : t("agentAutocomplete.commandsFailed");
    return {
      options: [],
      status: { kind: "error", title, reason: input.error?.message, onRetry: input.onRetry },
    };
  }
  return withEmptyStatus(input.options(), input.emptyText);
}

function resolveFileMenu(input: {
  options: () => AgentAutocompleteOption[];
  isPending: boolean;
  isLoading: boolean;
  error: unknown;
  t: TFunction;
}): AutocompleteMenu {
  const options = input.options();
  if (input.isPending || (input.isLoading && options.length === 0)) {
    return {
      options: [],
      status: { kind: "loading", message: input.t("agentAutocomplete.searchingWorkspace") },
    };
  }
  if (input.error instanceof Error) {
    return {
      options: [],
      status: {
        kind: "error",
        title: input.t("agentAutocomplete.filesFailed"),
        reason: input.error.message,
      },
    };
  }
  return withEmptyStatus(options, input.t("agentAutocomplete.noFiles"));
}

function withEmptyStatus(options: AgentAutocompleteOption[], emptyText: string): AutocompleteMenu {
  return options.length > 0
    ? { options, status: null }
    : { options, status: { kind: "empty", message: emptyText } };
}

/** How long a command menu waits for commands before it opens on a loading row. */
const COMMANDS_LOADING_REVEAL_MS = 300;

/**
 * Whether the open command menu has waited long enough to show a loading row. Commands that
 * arrive sooner paint the list as the first frame; once the wait is over, loading (a retry)
 * shows at once so the open menu never closes on itself.
 */
function useLoadingRevealed(isMenuOpen: boolean): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!isMenuOpen) {
      setRevealed(false);
      return undefined;
    }
    const timer = setTimeout(() => setRevealed(true), COMMANDS_LOADING_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [isMenuOpen]);
  return revealed;
}

/** The names command rows and status rows show: the provider's label and each plugin's name. */
function useCommandSourceNames(input: {
  serverId: string;
  agentId: string;
  draftConfig: DraftCommandConfig | undefined;
  cwd: string;
  isCommandMenuOpen: boolean;
  commandsState: CommandsState;
  pluginCommandCount: number;
}): { providerLabel: string | null; pluginNames: ReadonlyMap<string, string> } {
  const agentProvider = useSessionStore(
    (state) => state.sessions[input.serverId]?.agents?.get(input.agentId)?.provider,
  );
  const provider = input.draftConfig?.provider ?? agentProvider;
  // Only a loading or error row names the provider; only plugin rows need plugin names.
  const { entries: providerEntries } = useProvidersSnapshot(input.serverId, {
    cwd: input.cwd,
    enabled: input.isCommandMenuOpen && input.commandsState !== "ready",
  });
  const pluginList = usePluginList(input.serverId, {
    enabled: input.isCommandMenuOpen && input.pluginCommandCount > 0,
  });
  const pluginNames = useMemo(
    () => new Map((pluginList.data ?? []).map((plugin) => [plugin.id, pluginDisplayName(plugin)])),
    [pluginList.data],
  );
  return {
    providerLabel: provider ? resolveProviderLabel(provider, providerEntries) : null,
    pluginNames,
  };
}

// A draft's agentId is a draft key the daemon does not know, so a draft lists
// commands by its config only, and not at all until that config is complete.
function resolveDraftCommandContext(draft: DraftCommandTarget | undefined) {
  const queryDraftConfig = resolveDraftQueryConfig(draft);
  const isDraftContext = draft !== undefined;
  return {
    isDraftContext,
    queryDraftConfig,
    canListCommands: !isDraftContext || queryDraftConfig !== undefined,
  };
}

function resolveCommandsEmptyText(args: {
  draft: DraftCommandTarget | undefined;
  t: TFunction;
}): string {
  if (args.draft?.status === "needs-project") {
    return args.t("agentAutocomplete.chooseProjectForCommands");
  }
  if (args.draft?.status === "needs-provider") {
    return args.t("agentAutocomplete.chooseModelForCommands");
  }
  return args.t("agentAutocomplete.noCommands");
}

function applyFileMentionAutocompleteSelection(input: {
  selected: Exclude<
    AgentAutocompleteOption,
    | { type: "client_command" }
    | { type: "plugin_command" }
    | { type: "provider_command" }
    | { type: "prompt_template" }
  >;
  text: string;
  mention: FileMentionRange;
  serverId: string;
  agentId: string;
  setUserInput: (next: string) => void;
  onAutocompleteApplied?: () => void;
}): void {
  const { selected } = input;
  if (selected.type === "main_chat_task") {
    applyMainChatTaskMentionSelection({
      serverId: input.serverId,
      agentId: input.agentId,
      option: selected,
      text: input.text,
      mention: input.mention,
      setUserInput: input.setUserInput,
      onAutocompleteApplied: input.onAutocompleteApplied,
    });
    return;
  }
  if (selected.type === "main_chat_mention") {
    applyMainChatContextMentionSelection({
      option: selected,
      text: input.text,
      mention: input.mention,
      setUserInput: input.setUserInput,
      onAutocompleteApplied: input.onAutocompleteApplied,
    });
    return;
  }
  const nextInput = applyFileMentionReplacement({
    text: input.text,
    mention: input.mention,
    relativePath: selected.entryPath,
  });
  input.setUserInput(nextInput);
  input.onAutocompleteApplied?.();
}

function applyAgentAutocompleteOptionSelection(input: {
  selected: AgentAutocompleteOption;
  current: ReturnType<typeof resolveAgentAutocompleteSnapshot>;
  hasSnapshot: boolean;
  serverId: string;
  agentId: string;
  canExecuteClientSlashCommand?: boolean;
  onClientSlashCommand?: (command: ClientSlashCommand) => void;
  setUserInput: (next: string) => void;
  onAutocompleteApplied?: () => void;
}): void {
  const { selected, current } = input;
  if (selected.type === "prompt_template") {
    if (input.hasSnapshot && !current.slashCommand) return;
    const nextInput = applyPromptTemplateAutocompleteReplacement({
      text: current.text,
      command: current.slashCommand,
      template: selected.template,
    });
    input.setUserInput(nextInput);
    input.onAutocompleteApplied?.();
    return;
  }
  if (
    selected.type === "client_command" ||
    selected.type === "plugin_command" ||
    selected.type === "provider_command"
  ) {
    if (input.hasSnapshot && !current.slashCommand) return;
    if (
      selected.type === "client_command" &&
      selected.command.execution === "immediate" &&
      input.canExecuteClientSlashCommand &&
      input.onClientSlashCommand
    ) {
      input.onClientSlashCommand(selected.command);
      return;
    }
    const nextInput = current.slashCommand
      ? applySlashCommandReplacement({
          text: current.text,
          command: current.slashCommand,
          commandName: selected.id,
        })
      : `/${selected.id} `;
    input.setUserInput(nextInput);
    input.onAutocompleteApplied?.();
    return;
  }

  if (!current.fileMention) return;
  applyFileMentionAutocompleteSelection({
    selected,
    text: current.text,
    mention: current.fileMention,
    serverId: input.serverId,
    agentId: input.agentId,
    setUserInput: input.setUserInput,
    onAutocompleteApplied: input.onAutocompleteApplied,
  });
}

function countAvailableMainChatMentions(
  mainChatMentions: ReturnType<typeof useMainChatAutocompleteMentions>,
): number {
  if (!mainChatMentions.isMainChatContext) return 0;
  return (
    mainChatMentions.sources.hosts.length +
    mainChatMentions.sources.workspaces.length +
    mainChatMentions.sources.repos.length +
    mainChatMentions.sources.sessions.length
  );
}

function shouldLoadAutocompleteCommands(input: {
  mode: "command" | "file" | null;
  isMainChatContext: boolean;
  canLoadCommands: boolean;
  canListCommands: boolean;
}): boolean {
  const needsCommands =
    input.mode === "command" || (input.mode === "file" && input.isMainChatContext);
  return needsCommands && input.canLoadCommands && input.canListCommands;
}

function shouldLoadFileSuggestions(input: {
  mode: "command" | "file" | null;
  serverId: string;
  autocompleteCwd: string;
  hasClient: boolean;
  isConnected: boolean;
}): boolean {
  return (
    input.mode === "file" &&
    Boolean(input.serverId) &&
    input.autocompleteCwd.length > 0 &&
    input.hasClient &&
    input.isConnected
  );
}

function resolveMenuVisibility(input: {
  canShowAutocomplete: boolean;
  isCommandMenuOpen: boolean;
  commandsState: ReturnType<typeof resolveCommandsState>;
  isLoadingRevealed: boolean;
}): boolean {
  return (
    input.canShowAutocomplete &&
    !(input.isCommandMenuOpen && input.commandsState === "loading" && !input.isLoadingRevealed)
  );
}

export function useAgentAutocomplete(input: UseAgentAutocompleteInput): AgentAutocompleteResult {
  const { t } = useTranslation();
  const {
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draft,
    onAutocompleteApplied,
    onClientSlashCommand,
    canExecuteClientSlashCommand,
    pluginClientSlashCommands = [],
  } = input;

  const activeSlashCommand = useMemo(
    () =>
      findActiveSlashCommand({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showCommandAutocomplete = activeSlashCommand !== null;
  const commandFilterQuery = activeSlashCommand?.query ?? "";

  const activeFileMention = useMemo(
    () =>
      findActiveFileMention({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showFileAutocomplete = activeFileMention !== null;
  const fileFilterQuery = activeFileMention?.query ?? "";
  const [debouncedFileFilterQuery, setDebouncedFileFilterQuery] = useState(fileFilterQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFileFilterQuery(fileFilterQuery), 180);
    return () => clearTimeout(timer);
  }, [fileFilterQuery]);

  const { isDraftContext, queryDraftConfig, canListCommands } = useMemo(
    () => resolveDraftCommandContext(draft),
    [draft],
  );
  const canLoadCommands = resolveCanLoadCommands({ serverId, agentId, isDraftContext });

  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? "",
  );
  const autocompleteCwd = useMemo(() => {
    if (isDraftContext) {
      return queryDraftConfig?.cwd ?? "";
    }
    return agentCwd.trim();
  }, [agentCwd, isDraftContext, queryDraftConfig]);

  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const storedPromptTemplates = useMainChatPromptLibraryStore(
    (state) => state.templatesByServerId[serverId],
  );
  const isPromptLibraryLoaded = useMainChatPromptLibraryStore(
    (state) => state.loadedByServerId[serverId],
  );
  const loadPromptLibrary = useMainChatPromptLibraryStore((state) => state.loadPromptLibrary);
  const promptTemplates = storedPromptTemplates ?? DEFAULT_PROMPT_LIBRARY_TEMPLATES;

  const mode = resolveAutocompleteMode({ showFileAutocomplete, showCommandAutocomplete });
  const mainChatTasks = useMainChatAutocompleteTasks({
    serverId,
    agentId,
    mode,
    isDraftContext,
  });
  const mainChatMentions = useMainChatAutocompleteMentions({
    serverId,
    agentId,
    mode,
    isDraftContext,
  });
  const mainChatMentionsAvailableCount = countAvailableMainChatMentions(mainChatMentions);
  const canShowAutocomplete = resolveAutocompleteIsVisible({
    mode,
    canLoadCommands,
    serverId,
    autocompleteCwd: resolveMainChatFileMenuFlags({
      autocompleteCwd,
      mainChatTasksCount: mainChatTasks.length,
      mainChatMentionsCount: mainChatMentionsAvailableCount,
      isPending: false,
      isLoading: false,
      error: null,
    }).effectiveCwd,
  });

  const commandsQuery = useAutocompleteCommands({
    serverId,
    agentId,
    enabled: shouldLoadAutocompleteCommands({
      mode,
      isMainChatContext: mainChatMentions.isMainChatContext,
      canLoadCommands,
      canListCommands,
    }),
    draftConfig: queryDraftConfig,
  });
  const commandsState = resolveCommandsState({
    canListCommands,
    isLoading: commandsQuery.isLoading,
    isError: commandsQuery.isError,
  });
  const isCommandMenuOpen = mode === "command" && canShowAutocomplete;
  useEffect(() => {
    if (!isCommandMenuOpen || !serverId || !client || !isConnected || isPromptLibraryLoaded) {
      return;
    }
    void loadPromptLibrary(serverId, client);
  }, [client, isCommandMenuOpen, isConnected, isPromptLibraryLoaded, loadPromptLibrary, serverId]);
  const isLoadingRevealed = useLoadingRevealed(isCommandMenuOpen);
  const isVisible = resolveMenuVisibility({
    canShowAutocomplete,
    isCommandMenuOpen,
    commandsState,
    isLoadingRevealed,
  });
  const { providerLabel, pluginNames } = useCommandSourceNames({
    serverId,
    agentId,
    draftConfig: queryDraftConfig,
    cwd: autocompleteCwd,
    isCommandMenuOpen,
    commandsState,
    pluginCommandCount: pluginClientSlashCommands.length,
  });

  const fileSuggestionsQuery = useQuery({
    queryKey: [
      "directorySuggestions",
      serverId,
      autocompleteCwd,
      debouncedFileFilterQuery,
      true,
      true,
    ],
    queryFn: async (): Promise<DirectorySuggestionEntry[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const response = await client.getDirectorySuggestions({
        cwd: autocompleteCwd,
        query: debouncedFileFilterQuery,
        limit: 50,
        includeFiles: true,
        includeDirectories: true,
      });
      if (response.error) {
        throw new Error(response.error);
      }
      return mapDirectorySuggestionsToEntries(response);
    },
    enabled: shouldLoadFileSuggestions({
      mode,
      serverId,
      autocompleteCwd,
      hasClient: Boolean(client),
      isConnected,
    }),
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const commandsEmptyText = resolveCommandsEmptyText({ draft, t });
  const retryCommandsQuery = commandsQuery.retry;
  const retryCommands = useCallback(() => {
    retryCommandsQuery();
    // Pressing Retry takes focus on web; hand it back so the user keeps typing the command.
    onAutocompleteApplied?.();
  }, [onAutocompleteApplied, retryCommandsQuery]);
  const { options, status } = useMemo<AutocompleteMenu>(() => {
    if (!isVisible) return { options: [], status: null };
    const buildOptions = () =>
      buildAutocompleteOptions({
        activeFileMention,
        commandFilterQuery,
        commands: commandsQuery.commands,
        pluginCommands: pluginClientSlashCommands,
        pluginNames,
        promptTemplates,
        activeSlashCommand,
        fileSuggestions: fileSuggestionsQuery.data ?? [],
        mainChatTasks,
        mainChatMentions,
        isDraftContext,
        mode,
        t,
      });
    if (mode === "file") {
      const fileMenuFlags = resolveMainChatFileMenuFlags({
        autocompleteCwd,
        mainChatTasksCount: mainChatTasks.length,
        mainChatMentionsCount: mainChatMentionsAvailableCount,
        isPending: fileSuggestionsQuery.isPending,
        isLoading: fileSuggestionsQuery.isLoading,
        error: fileSuggestionsQuery.error,
      });
      return resolveFileMenu({
        options: buildOptions,
        isPending: fileMenuFlags.isPending,
        isLoading: fileMenuFlags.isLoading,
        error: fileMenuFlags.error,
        t,
      });
    }
    return resolveCommandMenu({
      commandsState,
      options: buildOptions,
      providerLabel,
      error: commandsQuery.error,
      onRetry: retryCommands,
      emptyText: commandsEmptyText,
      t,
    });
  }, [
    activeFileMention,
    activeSlashCommand,
    autocompleteCwd,
    commandFilterQuery,
    commandsEmptyText,
    commandsQuery.commands,
    commandsQuery.error,
    commandsState,
    fileSuggestionsQuery.data,
    fileSuggestionsQuery.error,
    fileSuggestionsQuery.isLoading,
    fileSuggestionsQuery.isPending,
    isDraftContext,
    isVisible,
    mainChatMentions,
    mainChatMentionsAvailableCount,
    mainChatTasks,
    mode,
    pluginClientSlashCommands,
    pluginNames,
    promptTemplates,
    providerLabel,
    retryCommands,
    t,
  ]);

  const onSelectOption = useCallback(
    (option: AutocompleteOption, snapshot?: AgentAutocompleteInputSnapshot) => {
      const selected = option as AgentAutocompleteOption;
      const current = resolveAgentAutocompleteSnapshot({
        input: snapshot,
        userInput,
        cursorIndex,
        activeSlashCommand,
        activeFileMention,
      });
      applyAgentAutocompleteOptionSelection({
        selected,
        current,
        hasSnapshot: Boolean(snapshot),
        serverId,
        agentId,
        canExecuteClientSlashCommand,
        onClientSlashCommand,
        setUserInput,
        onAutocompleteApplied,
      });
    },
    [
      agentId,
      canExecuteClientSlashCommand,
      onAutocompleteApplied,
      onClientSlashCommand,
      serverId,
      setUserInput,
      userInput,
      cursorIndex,
      activeFileMention,
      activeSlashCommand,
    ],
  );

  const selectOptionFromKeyPress = useCallback(
    (option: AutocompleteOption, event?: AgentAutocompleteKeyPressEvent) =>
      onSelectOption(option, event?.input),
    [onSelectOption],
  );

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible,
    options,
    query: mode === "command" ? commandFilterQuery : fileFilterQuery,
    onSelectOption: selectOptionFromKeyPress,
    onEscape:
      mode === "command" && activeSlashCommand?.position === "start"
        ? () => setUserInput("")
        : undefined,
  });

  return {
    isVisible,
    options,
    selectedIndex,
    status,
    onSelectOption,
    onKeyPress,
  };
}
