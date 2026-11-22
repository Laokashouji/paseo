import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatPatrolResult,
  MainChatSettings,
  MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { create } from "zustand";

interface MainChatSettingsStoreState {
  settingsByServerId: Record<string, MainChatSettings | undefined>;
  loadingByServerId: Record<string, boolean | undefined>;
  lastPatrolByServerId: Record<string, MainChatPatrolResult | undefined>;
  loadSettings: (serverId: string, client: DaemonClient) => Promise<MainChatSettings | null>;
  updateSettings: (
    serverId: string,
    patch: MainChatSettingsPatch,
    client: DaemonClient,
  ) => Promise<MainChatSettings>;
  triggerPatrol: (
    serverId: string,
    client: DaemonClient,
    options?: { mainAgentId?: string; forceWakeup?: boolean },
  ) => Promise<MainChatPatrolResult>;
  hydrateSettings: (serverId: string, settings: MainChatSettings) => void;
}

export const useMainChatSettingsStore = create<MainChatSettingsStoreState>((set) => ({
  settingsByServerId: {},
  loadingByServerId: {},
  lastPatrolByServerId: {},

  hydrateSettings(serverId, settings) {
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
    }));
  },

  async loadSettings(serverId, client) {
    set((state) => ({
      loadingByServerId: { ...state.loadingByServerId, [serverId]: true },
    }));
    try {
      const response = await client.getMainChatSettings();
      if (response.error || !response.settings) {
        return null;
      }
      const settings = response.settings;
      set((state) => ({
        settingsByServerId: {
          ...state.settingsByServerId,
          [serverId]: settings,
        },
      }));
      return settings;
    } finally {
      set((state) => ({
        loadingByServerId: { ...state.loadingByServerId, [serverId]: false },
      }));
    }
  },

  async updateSettings(serverId, patch, client) {
    const response = await client.updateMainChatSettings(patch);
    if (response.error || !response.settings) {
      throw new Error(response.error ?? "Failed to update main chat settings");
    }
    const settings = response.settings;
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
    }));
    return settings;
  },

  async triggerPatrol(serverId, client, options) {
    const response = await client.triggerMainChatPatrol(options);
    if (response.error || !response.result) {
      throw new Error(response.error ?? "Failed to trigger patrol");
    }
    const result = response.result;
    set((state) => ({
      lastPatrolByServerId: {
        ...state.lastPatrolByServerId,
        [serverId]: result,
      },
    }));
    return result;
  },
}));
