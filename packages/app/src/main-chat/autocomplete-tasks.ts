import equal from "fast-deep-equal";
import type { TFunction } from "i18next";
import { useCallback } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { useSessionStore } from "@/stores/session-store";
import type { FileMentionRange } from "@/utils/file-mention-autocomplete";
import { removeTaskMentionToken, useMainChatRouteStore } from "./route-store";
import { selectMainChatDockTasks, type MainChatDockTaskItem } from "./selectors";

export type MainChatTaskAutocompleteOption = AutocompleteOption & {
  type: "main_chat_task";
  targetServerId: string;
  targetAgentId: string;
  targetTitle: string;
  mention: FileMentionRange;
};

const EMPTY_TASKS: MainChatDockTaskItem[] = [];

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
  return useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        enabled && serverId && agentId
          ? selectMainChatDockTasks(state, serverId, agentId)
          : EMPTY_TASKS,
      [agentId, enabled, serverId],
    ),
    equal,
  );
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

/** Resolves effective cwd & loading/error flags when Main Chat `@task` items share the `@` menu. */
export function resolveMainChatFileMenuFlags(input: {
  autocompleteCwd: string;
  mainChatTasksCount: number;
  isPending: boolean;
  isLoading: boolean;
  error: unknown;
}): { effectiveCwd: string; isPending: boolean; isLoading: boolean; error: unknown } {
  const hasTasks = input.mainChatTasksCount > 0;
  return {
    effectiveCwd: input.autocompleteCwd || (hasTasks ? "." : ""),
    isPending: input.isPending && !hasTasks,
    isLoading: input.isLoading && !hasTasks,
    error: hasTasks ? null : input.error,
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
