import { createPlayAudio, type AudioEngine } from "@/audio";
import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { getPluginClientApi } from "./client-state/api";
import type { PluginClientOpenPanelOptions } from "@getpaseo/plugin/client";
import { subscribePluginRpc } from "@getpaseo/plugin/client/host";
import {
  createPluginAgentActionContext,
  createPluginCapabilities,
  createPluginWorkspaceActionContext,
} from "./actions";
import { createPluginClientStateSource } from "./client-state/source";
import type { PluginClientRuntime } from "./evaluate";
import { createPluginNavigation } from "./navigation";
import { pluginButtonStore } from "./buttons";
import type { InstalledPlugin } from "./types";

export function createPluginClientRuntime(
  installation: InstalledPlugin,
  audio: Pick<AudioEngine, "play">,
): PluginClientRuntime {
  const state = createPluginClientStateSource(installation.serverId);
  const capabilities = createPluginCapabilities(
    installation,
    createPluginNavigation({ serverId: installation.serverId, workspaceId: null }),
  );
  return {
    ...capabilities,
    i18n: installation.i18n,
    playAudio: createPlayAudio(audio, installation.lifetime.signal),
    hosts: getPluginClientApi(installation).hosts,
    addComposerPill(contribution) {
      return pluginButtonStore.addComposerPill(installation, contribution);
    },
    addHeaderButton(contribution) {
      return pluginButtonStore.addHeaderButton(installation, contribution);
    },
    openPanel(panelId, options) {
      openClientPanel({ installation, state, panelId, options });
    },
    closeAgentTab(options) {
      closePluginAgentTab({
        serverId: installation.serverId,
        agentId: options.agentId,
        workspaceId: options.workspaceId ?? null,
      });
    },
    subscribe: (contract, input, onEvent, options) =>
      subscribePluginRpc(contract, installation.subscribe, input, onEvent, options),
  };
}

function isAgentOwnedTabTarget(
  target: { kind: string; agentId?: string; context?: string },
  agentId: string,
): boolean {
  if (target.kind === "agent") return target.agentId === agentId;
  return target.kind === "plugin" && target.context === "agent" && target.agentId === agentId;
}

function collectCandidateWorkspaceKeys(input: { serverId: string; rawWorkspaceId?: string }): {
  candidateKeys: Set<string>;
  requestedKeys: Set<string>;
} {
  const { serverId, rawWorkspaceId } = input;
  const keyPrefix = `${serverId}:`;
  const candidateKeys = new Set<string>();
  const requestedKeys = new Set<string>();

  if (rawWorkspaceId) {
    const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
      workspaces: useSessionStore.getState().sessions[serverId]?.workspaces,
      workspaceId: rawWorkspaceId,
    });
    if (resolvedWorkspaceId) {
      const resolvedKey = `${keyPrefix}${resolvedWorkspaceId}`;
      candidateKeys.add(resolvedKey);
      requestedKeys.add(resolvedKey);
    }
    const rawKey = `${keyPrefix}${rawWorkspaceId}`;
    candidateKeys.add(rawKey);
    requestedKeys.add(rawKey);
  }

  const layoutStore = useWorkspaceLayoutStore.getState();
  for (const key of Object.keys(layoutStore.layoutByWorkspace)) {
    if (key.startsWith(keyPrefix)) candidateKeys.add(key);
  }
  for (const key of Object.keys(layoutStore.sheetsByWorkspace)) {
    if (key.startsWith(keyPrefix)) candidateKeys.add(key);
  }
  return { candidateKeys, requestedKeys };
}

function collectMatchingAgentTabIds(workspaceKey: string, agentId: string): Set<string> {
  const current = useWorkspaceLayoutStore.getState();
  const layout = current.layoutByWorkspace[workspaceKey];
  const sheets = current.sheetsByWorkspace[workspaceKey] ?? [];
  const matchingTabIds = new Set<string>();

  if (layout) {
    for (const tab of collectAllTabs(layout.root)) {
      if (isAgentOwnedTabTarget(tab.target, agentId)) {
        matchingTabIds.add(tab.tabId);
      }
    }
  }
  for (const sheet of sheets) {
    if (isAgentOwnedTabTarget(sheet.tab.target, agentId)) {
      matchingTabIds.add(sheet.tab.tabId);
    }
  }
  return matchingTabIds;
}

export function closePluginAgentTab(input: {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
}): void {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) return;

  const { candidateKeys, requestedKeys } = collectCandidateWorkspaceKeys({
    serverId,
    rawWorkspaceId: input.workspaceId?.trim(),
  });

  for (const workspaceKey of candidateKeys) {
    const current = useWorkspaceLayoutStore.getState();
    const matchingTabIds = collectMatchingAgentTabIds(workspaceKey, agentId);
    const isPinned = Boolean(current.pinnedAgentIdsByWorkspace[workspaceKey]?.has(agentId));
    if (matchingTabIds.size === 0 && !isPinned && !requestedKeys.has(workspaceKey)) {
      continue;
    }

    current.unpinAgent(workspaceKey, agentId);
    current.hideAgent(workspaceKey, agentId);
    for (const tabId of matchingTabIds) {
      useWorkspaceLayoutStore.getState().closeTab(workspaceKey, tabId);
    }
  }
}

function openClientPanel(input: {
  installation: InstalledPlugin;
  state: ReturnType<typeof createPluginClientStateSource>;
  panelId: string;
  options: PluginClientOpenPanelOptions;
}): void {
  const { installation, state, panelId, options } = input;
  const workspaceId = options.workspaceId.trim();
  const agentId = options.agentId?.trim();
  const navigation = createPluginNavigation({ serverId: installation.serverId, workspaceId });
  const action = agentId
    ? createPluginAgentActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
        agentId,
      })
    : createPluginWorkspaceActionContext({
        plugin: installation,
        navigation,
        state,
        workspaceId,
      });
  if (!action) throw new Error("Plugin panel context is unavailable");
  action.openPanel(panelId, { location: options.location });
}
