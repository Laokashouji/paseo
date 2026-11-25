import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  getMainChatTaskMetaFromLabels,
  isMainChatAgent,
} from "@getpaseo/protocol/main-chat";
import { persist } from "zustand/middleware";
import { z } from "zod";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { create } from "zustand";
import type { useSessionStore } from "@/stores/session-store";
import {
  groupNeedsYouRequests,
  type ActionBarBucketKey,
  type ActionBarLiveAgentSnapshot,
  type ActionBarPendingPermissionInput,
  type ActionBarNeedsYouItem,
  type MainChatActionBarModel,
} from "./action-bar-model";

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

export interface ActionBarSessionSnapshot {
  isMainChat: boolean;
  liveAgents: ActionBarLiveAgentSnapshot[];
  pendingPermissions: ActionBarPendingPermissionInput[];
}

type HostSessionEntry = SessionStoreState["sessions"][string];
type SessionAgentEntry = ReturnType<HostSessionEntry["agents"]["get"]> & object;

function extractTaskRecordId(labels: Record<string, string | undefined>): string | null {
  const rawRecordId = labels[MAIN_CHAT_TASK_RECORD_ID_LABEL];
  return typeof rawRecordId === "string" && rawRecordId.trim().length > 0
    ? rawRecordId.trim()
    : null;
}

function buildLiveAgentSnapshot(
  hostId: string,
  agent: SessionAgentEntry,
  serverId: string,
  mainAgentId: string,
): ActionBarLiveAgentSnapshot {
  const parent = getParentAddressFromLabels(agent.labels, hostId);
  const managedByMainChat = parent?.serverId === serverId && parent.agentId === mainAgentId;
  const meta = getMainChatTaskMetaFromLabels(agent.labels);
  const running = isAgentRunning({
    status: agent.status,
    backgroundWork: agent.backgroundWork,
  });
  const effectiveStatus = running && agent.status !== "error" ? "running" : agent.status;
  const trimmedTitle = agent.title?.trim();

  return {
    serverId: hostId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: trimmedTitle || meta?.goal || agent.id,
    cwd: agent.cwd || null,
    status: effectiveStatus,
    turnPhase: agent.turn.phase === "open" ? "open" : "idle",
    hasBackgroundWork: (agent.backgroundWork?.count ?? 0) > 0,
    requiresAttention: Boolean(agent.requiresAttention),
    attentionReason: agent.attentionReason ?? null,
    archived: Boolean(agent.archivedAt),
    background: Boolean(agent.background),
    isMainChat: isMainChatAgent(agent),
    managedByMainChat,
    parent,
    conversationId: agent.labels[MAIN_CHAT_CONVERSATION_ID_LABEL],
    mode: meta?.mode ?? null,
    taskRecordId: extractTaskRecordId(agent.labels),
    planId: meta?.planId ?? null,
    updatedAtMs: agent.updatedAt.getTime(),
    lastActivityAtMs: (agent.lastActivityAt ?? agent.updatedAt).getTime(),
  };
}

function collectHostPendingPermissions(
  hostId: string,
  hostSession: HostSessionEntry,
  mainAgentId: string,
  target: ActionBarPendingPermissionInput[],
): void {
  for (const perm of hostSession.pendingPermissions.values()) {
    const sourceAgent =
      hostSession.agents.get(perm.agentId) ?? hostSession.agentDetails.get(perm.agentId);
    const isHiddenNonMain =
      Boolean(sourceAgent && (sourceAgent.archivedAt || sourceAgent.background)) &&
      perm.agentId !== mainAgentId;
    if (isHiddenNonMain) continue;
    if (sourceAgent && isMainChatAgent(sourceAgent) && perm.agentId !== mainAgentId) {
      continue;
    }
    target.push({
      serverId: hostId,
      permission: perm,
      sourceAgentTitle: sourceAgent?.title?.trim() || perm.agentId,
      sourceAgentCwd: sourceAgent?.cwd ?? null,
    });
  }
}

export function selectActionBarSessionSnapshot(
  state: Pick<SessionStoreState, "sessions">,
  serverId: string,
  mainAgentId: string,
  allowedServerIds?: ReadonlySet<string> | null,
  scope: "main" | "conversation" = "main",
): ActionBarSessionSnapshot {
  const mainSession = state.sessions[serverId];
  const currentAgent =
    mainSession?.agents.get(mainAgentId) ?? mainSession?.agentDetails.get(mainAgentId);
  const isMainChat = isMainChatAgent(currentAgent);
  if (scope === "main" && !isMainChat) {
    return { isMainChat: false, liveAgents: [], pendingPermissions: [] };
  }

  const liveAgents: ActionBarLiveAgentSnapshot[] = [];
  const pendingPermissions: ActionBarPendingPermissionInput[] = [];

  for (const [hostId, hostSession] of Object.entries(state.sessions)) {
    if (allowedServerIds && allowedServerIds.size > 0 && !allowedServerIds.has(hostId)) {
      continue;
    }
    for (const agent of hostSession.agents.values()) {
      liveAgents.push(buildLiveAgentSnapshot(hostId, agent, serverId, mainAgentId));
    }
    collectHostPendingPermissions(hostId, hostSession, mainAgentId, pendingPermissions);
  }

  return { isMainChat, liveAgents, pendingPermissions };
}

export const EMPTY_DISMISSED_NEEDS_MAP: Readonly<Record<string, boolean>> = {};

export function needsYouDismissSignature(item: ActionBarNeedsYouItem): string {
  if (item.kind === "task")
    return JSON.stringify([
      item.serverId,
      item.id,
      item.reason,
      item.summary,
      item.suggestedAction,
      item.requestUpdatedAt,
      item.ruleDiagnostic?.detectedAt,
    ]);
  return JSON.stringify([item.serverId, item.id, item.updatedAtMs]);
}

interface MainChatActionBarDrawerStoreState {
  openBucketByKey: Record<string, ActionBarBucketKey | null>;
  expandedByKey: Record<string, boolean>;
  compactDockCollapsedByKey: Record<string, boolean>;
  focusedNeedsIdByKey: Record<string, string | null>;
  dismissedNeedsSignaturesByKey: Record<string, Readonly<Record<string, boolean>>>;
  toggleBucket: (key: string, bucket: ActionBarBucketKey) => void;
  openBucketWithFocus: (
    key: string,
    bucket: ActionBarBucketKey,
    focusNeedsId?: string | null,
  ) => void;
  consumeFocusedNeedsId: (key: string) => void;
  setCompactDockCollapsed: (key: string, collapsed: boolean) => void;
  dismissNeedsItem: (key: string, signature: string) => void;
  closeDrawer: (key: string) => void;
  toggleExpanded: (key: string) => void;
  reset: () => void;
}

export const useMainChatActionBarDrawerStore = create<MainChatActionBarDrawerStoreState>()(
  persist(
    (set) => ({
      openBucketByKey: {},
      expandedByKey: {},
      compactDockCollapsedByKey: {},
      focusedNeedsIdByKey: {},
      dismissedNeedsSignaturesByKey: {},
      toggleBucket(key, bucket) {
        set((state) => {
          const current = state.openBucketByKey[key] ?? null;
          const next = current === bucket ? null : bucket;
          return {
            openBucketByKey: { ...state.openBucketByKey, [key]: next },
            focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: null },
            ...(next === null ? { expandedByKey: { ...state.expandedByKey, [key]: false } } : {}),
          };
        });
      },
      openBucketWithFocus(key, bucket, focusNeedsId = null) {
        set((state) => ({
          openBucketByKey: { ...state.openBucketByKey, [key]: bucket },
          focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: focusNeedsId },
        }));
      },
      consumeFocusedNeedsId(key) {
        set((state) => {
          if (!state.focusedNeedsIdByKey?.[key]) return state;
          return {
            focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: null },
          };
        });
      },
      setCompactDockCollapsed(key, collapsed) {
        set((state) => ({
          compactDockCollapsedByKey: { ...state.compactDockCollapsedByKey, [key]: collapsed },
        }));
      },
      dismissNeedsItem(key, signature) {
        set((state) => {
          const prevMap = state.dismissedNeedsSignaturesByKey[key] ?? EMPTY_DISMISSED_NEEDS_MAP;
          if (prevMap[signature]) return state;
          return {
            dismissedNeedsSignaturesByKey: {
              ...state.dismissedNeedsSignaturesByKey,
              [key]: { ...prevMap, [signature]: true },
            },
          };
        });
      },
      closeDrawer(key) {
        set((state) => {
          if (
            (state.openBucketByKey[key] ?? null) === null &&
            !state.expandedByKey[key] &&
            !state.focusedNeedsIdByKey?.[key]
          ) {
            return state;
          }
          return {
            openBucketByKey: { ...state.openBucketByKey, [key]: null },
            expandedByKey: { ...state.expandedByKey, [key]: false },
            focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: null },
          };
        });
      },
      toggleExpanded(key) {
        set((state) => ({
          expandedByKey: { ...state.expandedByKey, [key]: !state.expandedByKey[key] },
        }));
      },
      reset() {
        set({
          openBucketByKey: {},
          expandedByKey: {},
          compactDockCollapsedByKey: {},
          focusedNeedsIdByKey: {},
          dismissedNeedsSignaturesByKey: {},
        });
      },
    }),
    {
      name: "main-chat-request-dismissals",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        z.object({
          dismissedNeedsSignaturesByKey: z.record(z.string(), z.record(z.string(), z.boolean())),
        }),
      ),
      partialize: (state) => ({
        dismissedNeedsSignaturesByKey: state.dismissedNeedsSignaturesByKey,
      }),
    },
  ),
);

export function filterDismissedRequests(
  raw: MainChatActionBarModel,
  dismissedSignatures: Readonly<Record<string, boolean>>,
): MainChatActionBarModel {
  if (!Object.keys(dismissedSignatures).length) return raw;
  const requests = raw.needsYou.flatMap(({ relatedRequests, ...item }) => [
    item,
    ...(relatedRequests ?? []),
  ]);
  const visible = requests.filter((item) => !dismissedSignatures[needsYouDismissSignature(item)]);
  if (visible.length === requests.length) return raw;
  const visibleNeedsYou = groupNeedsYouRequests(visible);
  const delta = raw.needsYou.length - visibleNeedsYou.length;
  return {
    ...raw,
    needsYou: visibleNeedsYou,
    counts: {
      ...raw.counts,
      needsYou: visibleNeedsYou.length,
      total: Math.max(0, raw.counts.total - delta),
    },
  };
}
