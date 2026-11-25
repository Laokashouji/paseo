import { isMainChatConversationAgent } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AgentSlashCommand } from "@/agent-commands";
import type { AutocompleteOption, AutocompleteOptionIcon } from "@/components/ui/autocomplete";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { FileMentionRange } from "@/utils/file-mention-autocomplete";
import {
  buildMainChatMentionItems,
  collectMainChatMentionSources,
  replaceMentionRangeWithToken,
  type MainChatMentionItem,
  type MainChatMentionKind,
  type MainChatMentionSkillSource,
  type MainChatMentionSourceCollection,
} from "./mention-sources";
import { removeTaskMentionToken, useMainChatRouteStore } from "./route-store";
import { selectMainChatDockTasks, type MainChatDockTaskItem } from "./selectors";
import { useStewardAllowedServerIds } from "./use-steward-roster";

export type MainChatTaskAutocompleteOption = AutocompleteOption & {
  type: "main_chat_task";
  targetServerId: string;
  targetAgentId: string;
  targetTitle: string;
  mention: FileMentionRange;
};

export type MainChatContextMentionAutocompleteOption = AutocompleteOption & {
  type: "main_chat_mention";
  mentionItem: MainChatMentionItem;
  mention: FileMentionRange;
};

type SessionMentionSources = Omit<MainChatMentionSourceCollection, "skills">;

export interface MainChatAutocompleteMentionsState {
  isMainChatContext: boolean;
  sources: SessionMentionSources;
}

const EMPTY_TASKS: MainChatDockTaskItem[] = [];
const EMPTY_SESSION_MENTION_SOURCES: SessionMentionSources = {
  hosts: [],
  workspaces: [],
  repos: [],
  sessions: [],
};
const EMPTY_MENTIONS_STATE: MainChatAutocompleteMentionsState = {
  isMainChatContext: false,
  sources: EMPTY_SESSION_MENTION_SOURCES,
};

/**
 * Selects active child tasks when the current composer belongs to Main Chat and `@` mention
 * autocomplete is open; returns a stable empty array otherwise.
 */
export function useMainChatAutocompleteTasks(input: {
  serverId: string;
  agentId: string;
  mode: "command" | "file" | null;
  isDraftContext: boolean;
}): readonly MainChatDockTaskItem[] {
  const { serverId, agentId, mode, isDraftContext } = input;
  const enabled = mode === "file" && !isDraftContext;
  const allowedServerIds = useStewardAllowedServerIds(serverId);
  return useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        enabled && serverId && agentId
          ? selectMainChatDockTasks(state, serverId, agentId, allowedServerIds)
          : EMPTY_TASKS,
      [agentId, allowedServerIds, enabled, serverId],
    ),
    equal,
  );
}

/**
 * Selects multi-source `@` mention candidates (hosts, workspaces, repos, sessions) when the
 * active composer belongs to Main Chat or a direction/side conversation.
 */
export function useMainChatAutocompleteMentions(input: {
  serverId: string;
  agentId: string;
  mode: "command" | "file" | null;
  isDraftContext: boolean;
}): MainChatAutocompleteMentionsState {
  const { serverId, agentId, mode, isDraftContext } = input;
  const enabled = mode === "file" && !isDraftContext && Boolean(serverId) && Boolean(agentId);
  const hosts = useHosts();
  const allowedServerIds = useStewardAllowedServerIds(serverId);
  const hostLabelsByServerId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const host of hosts) {
      if (host.label.trim().length > 0) {
        map[host.serverId] = host.label.trim();
      }
    }
    return map;
  }, [hosts]);

  const raw = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state): MainChatAutocompleteMentionsState => {
        if (!enabled) return EMPTY_MENTIONS_STATE;
        const session = state.sessions[serverId];
        const currentAgent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
        if (!isMainChatConversationAgent(currentAgent)) {
          return EMPTY_MENTIONS_STATE;
        }
        return {
          isMainChatContext: true,
          sources: collectMainChatMentionSources({
            sessions: state.sessions,
            excludeAgentId: agentId,
            allowedServerIds,
          }),
        };
      },
      [agentId, allowedServerIds, enabled, serverId],
    ),
    equal,
  );

  return useMemo(() => {
    if (!raw.isMainChatContext) return EMPTY_MENTIONS_STATE;
    const withLabels = {
      hosts: raw.sources.hosts.map((host) => ({
        ...host,
        label: hostLabelsByServerId[host.serverId] ?? host.label,
      })),
      workspaces: raw.sources.workspaces.map((ws) => ({
        ...ws,
        hostLabel: hostLabelsByServerId[ws.serverId] ?? ws.hostLabel,
      })),
      repos: raw.sources.repos.map((repo) => ({
        ...repo,
        hostLabel: hostLabelsByServerId[repo.serverId] ?? repo.hostLabel,
      })),
      sessions: raw.sources.sessions.map((item) => ({
        ...item,
        hostLabel: hostLabelsByServerId[item.serverId] ?? item.hostLabel,
      })),
    };
    return {
      isMainChatContext: true,
      sources: withLabels,
    };
  }, [hostLabelsByServerId, raw]);
}

function statusLabelForTask(task: MainChatDockTaskItem, t: TFunction): string {
  switch (task.bucket) {
    case "needs_input":
      return t("mainChat.taskStatus.needsYou");
    case "failed":
      return t("mainChat.taskStatus.failed");
    case "running":
      return t("mainChat.taskStatus.working");
    case "attention":
    case "done":
      return t("mainChat.taskStatus.done");
  }
}

const MENTION_ICON_BY_KIND: Record<MainChatMentionKind, AutocompleteOptionIcon> = {
  host: "plugin",
  workspace: "directory",
  repo: "directory",
  session: "new-draft",
  skill: "skill",
};

function tagForMentionKind(kind: MainChatMentionKind, t: TFunction): string {
  switch (kind) {
    case "host":
      return t("mainChat.composer.mentions.tagHost");
    case "workspace":
      return t("mainChat.composer.mentions.tagWorkspace");
    case "repo":
      return t("mainChat.composer.mentions.tagRepo");
    case "session":
      return t("mainChat.composer.mentions.tagSession");
    case "skill":
      return t("mainChat.composer.mentions.tagSkill");
  }
}

export function extractSkillMentionSources(
  commands: readonly AgentSlashCommand[],
): MainChatMentionSkillSource[] {
  const skills: MainChatMentionSkillSource[] = [];
  for (const command of commands) {
    if (command.kind && command.kind !== "skill") continue;
    skills.push({
      name: command.name,
      description: command.description || null,
      argumentHint: command.argumentHint || null,
    });
  }
  return skills;
}

/**
 * Builds `@` autocomplete rows for active child tasks of the Main Chat session so the user can
 * type `@任务名` to route their next message straight to that child agent.
 */
export function buildMainChatTaskMentionOptions(input: {
  tasks: readonly MainChatDockTaskItem[];
  mention: FileMentionRange;
  t: TFunction;
}): MainChatTaskAutocompleteOption[] {
  if (input.tasks.length === 0) return [];
  const query = input.mention.query.trim().toLowerCase();
  const matched = query
    ? input.tasks.filter((task) => task.title.toLowerCase().includes(query))
    : input.tasks;

  return matched.map((task) => {
    const label = `@${task.title}`;
    const ranges = query
      ? findHighlightRanges(query, task.title).map((range) => ({
          start: range.start + 1,
          length: range.length,
        }))
      : undefined;
    return {
      type: "main_chat_task" as const,
      id: `main-chat-task:${task.serverId}:${task.agentId}`,
      label,
      labelMatches: ranges,
      icon: "skill" as const,
      description: `${statusLabelForTask(task, input.t)} · ${input.t("mainChat.directRoute.hint")}`,
      tag: input.t("mainChat.directRoute.tag"),
      targetServerId: task.serverId,
      targetAgentId: task.agentId,
      targetTitle: task.title,
      mention: input.mention,
    };
  });
}

/**
 * Builds multi-source `@` autocomplete rows (`@host`, `@workspace`, `@repo`, `@session`, `@skill`)
 * for Main Chat and direction conversations.
 */
export function buildMainChatContextMentionOptions(input: {
  isMainChatContext: boolean;
  sources: SessionMentionSources;
  skills: readonly MainChatMentionSkillSource[];
  mention: FileMentionRange;
  t: TFunction;
}): MainChatContextMentionAutocompleteOption[] {
  if (!input.isMainChatContext) return [];
  const items = buildMainChatMentionItems({
    query: input.mention.query,
    hosts: input.sources.hosts,
    workspaces: input.sources.workspaces,
    repos: input.sources.repos,
    sessions: input.sources.sessions,
    skills: input.skills,
  });

  const normalizedQuery = input.mention.query.trim();
  const cleanQuery = normalizedQuery.includes(":")
    ? normalizedQuery.slice(normalizedQuery.indexOf(":") + 1).trim()
    : normalizedQuery;

  return items.map((item) => {
    const prefixLength = item.label.length - item.title.length;
    const ranges = cleanQuery
      ? findHighlightRanges(cleanQuery, item.title).map((range) => ({
          start: range.start + prefixLength,
          length: range.length,
        }))
      : undefined;
    return {
      type: "main_chat_mention" as const,
      id: `main-chat-mention:${item.id}`,
      label: item.label,
      labelMatches: ranges,
      icon: MENTION_ICON_BY_KIND[item.kind],
      description: item.subtitle || undefined,
      tag: tagForMentionKind(item.kind, input.t),
      mentionItem: item,
      mention: input.mention,
    };
  });
}

/** Resolves effective cwd & loading/error flags when Main Chat `@` items share the `@` menu. */
export function resolveMainChatFileMenuFlags(input: {
  autocompleteCwd: string;
  mainChatTasksCount: number;
  mainChatMentionsCount?: number;
  isPending: boolean;
  isLoading: boolean;
  error: unknown;
}): { effectiveCwd: string; isPending: boolean; isLoading: boolean; error: unknown } {
  const hasMainChatItems = input.mainChatTasksCount + (input.mainChatMentionsCount ?? 0) > 0;
  return {
    effectiveCwd: input.autocompleteCwd || (hasMainChatItems ? "." : ""),
    isPending: input.isPending && !hasMainChatItems,
    isLoading: input.isLoading && !hasMainChatItems,
    error: hasMainChatItems ? null : input.error,
  };
}

/** Applies a selected `@任务` autocomplete option by setting the direct-route target and stripping `@query`. */
export function applyMainChatTaskMentionSelection(input: {
  serverId: string;
  agentId: string;
  option: MainChatTaskAutocompleteOption;
  text: string;
  mention: FileMentionRange;
  setUserInput: (nextValue: string) => void;
  onAutocompleteApplied?: () => void;
}): void {
  useMainChatRouteStore.getState().setTarget(input.serverId, input.agentId, {
    targetServerId: input.option.targetServerId,
    targetAgentId: input.option.targetAgentId,
    targetTitle: input.option.targetTitle,
  });
  input.setUserInput(removeTaskMentionToken(input.text, input.mention));
  input.onAutocompleteApplied?.();
}

/** Injects a selected `@主机/@工作区/@仓库/@会话/@Skill` structured token into the composer text. */
export function applyMainChatContextMentionSelection(input: {
  option: MainChatContextMentionAutocompleteOption;
  text: string;
  mention: FileMentionRange;
  setUserInput: (nextValue: string) => void;
  onAutocompleteApplied?: () => void;
}): void {
  const nextInput = replaceMentionRangeWithToken({
    text: input.text,
    mention: input.mention,
    token: input.option.mentionItem.injectionToken,
  });
  input.setUserInput(nextInput);
  input.onAutocompleteApplied?.();
}
