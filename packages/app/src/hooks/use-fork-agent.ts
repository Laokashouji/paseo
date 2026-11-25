import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import type {
  AgentForkContextOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { ToastApi } from "@/components/toast-host";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft or trigger a native lossless fork. Kept structural so both
 * `AgentScreenAgent` (the agent-stream view's live context) and the session
 * store's `Agent` record satisfy it without a projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "capabilities"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "options"
  | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource;
  workspaceId?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
  /** True when forking an in-flight streaming turn whose final output is not persisted yet. */
  isInFlight?: boolean;
  /** Optional explicit title for the forked conversation (e.g. from `/branch <name>`). */
  title?: string;
  /** Optional text prefilled into the newly opened branch tab's composer draft. */
  initialDraftText?: string;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
  missingAttachmentMessage: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: input.payload.attachment,
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
    },
  };
}

function buildForkDraftSetup(agent: ForkAgentSource): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    providerOptions: { ...agent.options },
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

async function openNativeForkTab(
  client: DaemonClient,
  serverId: string,
  workspaceId: string,
  request: ForkAgentRequest,
  canFallback: boolean,
): Promise<boolean> {
  const { agentId, boundary, title, initialDraftText } = request;
  try {
    const { agent: forkedSnapshot } = await client.forkAgent(agentId, {
      workspaceId,
      boundaryCursor: boundary?.boundaryCursor,
      boundaryMessageId: boundary?.boundaryMessageId,
      ...(title?.trim() ? { title: title.trim() } : {}),
    });
    const normalized = normalizeAgentSnapshot(forkedSnapshot, serverId);
    const hydrated = applyLegacyDaemonWorkspaceOwnership({
      serverId,
      agent: normalized,
    });
    getHostRuntimeStore().acceptAgentSnapshot(serverId, hydrated);
    if (initialDraftText?.trim()) {
      useDraftStore.getState().replaceDraftText({
        draftKey: buildDraftStoreKey({ serverId, agentId: forkedSnapshot.id }),
        text: initialDraftText,
      });
    }
    navigateToWorkspace({
      serverId,
      workspaceId,
      target: { kind: "agent", agentId: forkedSnapshot.id },
    });
    return true;
  } catch (nativeError) {
    if (!canFallback) {
      throw nativeError;
    }
    console.warn("[useForkAgent] Native fork failed; falling back to summary draft:", nativeError);
    return false;
  }
}

function openForkWorkspaceDraft(
  request: ForkAgentRequest,
  draftId: string,
  draftSetup: WorkspaceDraftTabSetup | undefined,
  serverId: string,
  canNativeFork: boolean,
  router: ReturnType<typeof useRouter>,
): void {
  const { agentId, agent, boundary, title } = request;
  const sourceDirectory =
    agent.projectPlacement?.checkout?.cwd?.trim() || agent.cwd.trim() || undefined;
  if (draftSetup) {
    useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
      draftId,
      setup: draftSetup,
      sourceDirectory,
      ...(canNativeFork && agent.provider
        ? {
            nativeForkSource: {
              sourceAgentId: agentId,
              provider: agent.provider,
              boundaryCursor: boundary?.boundaryCursor,
              boundaryMessageId: boundary?.boundaryMessageId,
              ...(title?.trim() ? { title: title.trim() } : {}),
            },
          }
        : {}),
    });
  }
  router.push(
    buildNewWorkspaceRoute({
      serverId,
      sourceDirectory,
      displayName: agent.projectPlacement?.projectName,
      projectId: agent.projectPlacement?.projectKey,
      draftId,
    }),
  );
}

/**
 * Shared fork driver behind both turn-footer fork affordances: the completed
 * turn's footer (which supplies a boundary pinned to that turn) and the
 * in-flight turn's footer next to the progress loader (which omits the boundary
 * so the fork captures the still-streaming response).
 */
export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext") && !readOnly;
  const supportsAgentNativeFork = useHostFeature(serverId, "agentNativeFork") && !readOnly;

  return useStableEvent(async (request) => {
    const { agentId, agent, workspaceId, target, boundary, isInFlight, initialDraftText } = request;
    try {
      const trimmedInitialDraft = initialDraftText?.trim() ? initialDraftText : null;
      const canNativeFork =
        supportsAgentNativeFork && agent.capabilities?.supportsNativeFork === true && !isInFlight;

      if (!supportsAgentForkContext && !canNativeFork) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const draftSetup = buildForkDraftSetup(agent);
      const prepareForkDraft = async () => {
        if (!supportsAgentForkContext) {
          throw new Error(t("message.actions.forkUnavailable"));
        }
        const draftId = generateDraftId();
        const payload = await client.buildAgentForkContext(agentId, boundary);
        const attachment = buildChatHistoryAttachment({
          draftId,
          serverId,
          agentId,
          payload,
          missingAttachmentMessage: t("message.actions.forkFailed"),
        });
        useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
          scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
          attachments: [attachment],
        });
        return draftId;
      };

      if (target === "tab") {
        if (!workspaceId) {
          throw new Error(t("message.actions.forkMissingWorkspace"));
        }
        if (
          canNativeFork &&
          (await openNativeForkTab(
            client,
            serverId,
            workspaceId,
            request,
            supportsAgentForkContext,
          ))
        ) {
          return;
        }
        const draftId = await prepareForkDraft();
        if (trimmedInitialDraft) {
          useDraftStore.getState().replaceDraftText({
            draftKey: buildDraftStoreKey({ serverId, agentId: "", draftId }),
            text: trimmedInitialDraft,
          });
        }
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: buildForkDraftTabTarget(draftSetup, draftId),
        });
        return;
      }

      if (target === "draft_tab") {
        if (!workspaceId) {
          throw new Error(t("message.actions.forkMissingWorkspace"));
        }
        const draftId = await prepareForkDraft();
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: buildForkDraftTabTarget(draftSetup, draftId),
        });
        return;
      }

      const draftId = await prepareForkDraft();
      openForkWorkspaceDraft(request, draftId, draftSetup, serverId, canNativeFork, router);
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    }
  });
}
