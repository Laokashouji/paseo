import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatNightModeStatus,
  MainChatPatrolResult,
  MainChatSettings,
  MainChatSettingsPatch,
  MainChatTokenUsageSummary,
} from "@getpaseo/protocol/main-chat";
import { create } from "zustand";

interface MainChatSettingsStoreState {
  settingsByServerId: Record<string, MainChatSettings | undefined>;
  nightModeStatusByServerId: Record<string, MainChatNightModeStatus | undefined>;
  usageByServerId: Record<string, MainChatTokenUsageSummary | undefined>;
  usageLoadingByServerId: Record<string, boolean | undefined>;
  loadingByServerId: Record<string, boolean | undefined>;
  lastPatrolByServerId: Record<string, MainChatPatrolResult | undefined>;
  loadSettings: (serverId: string, client: DaemonClient) => Promise<MainChatSettings | null>;
  updateSettings: (
    serverId: string,
    patch: MainChatSettingsPatch,
    client: DaemonClient,
  ) => Promise<MainChatSettings>;
  loadUsage: (serverId: string, client: DaemonClient) => Promise<MainChatTokenUsageSummary | null>;
  resetUsage: (serverId: string, client: DaemonClient) => Promise<MainChatTokenUsageSummary>;
  triggerPatrol: (
    serverId: string,
    client: DaemonClient,
    options?: { mainAgentId?: string; forceWakeup?: boolean },
  ) => Promise<MainChatPatrolResult>;
  hydrateSettings: (
    serverId: string,
    settings: MainChatSettings,
    nightModeStatus?: MainChatNightModeStatus,
  ) => void;
  hydrateTelemetry: (
    serverId: string,
    input: {
      nightModeStatus?: MainChatNightModeStatus;
      tokenUsage?: MainChatTokenUsageSummary;
    },
  ) => void;
}

export const useMainChatSettingsStore = create<MainChatSettingsStoreState>((set) => ({
  settingsByServerId: {},
  nightModeStatusByServerId: {},
  usageByServerId: {},
  usageLoadingByServerId: {},
  loadingByServerId: {},
  lastPatrolByServerId: {},

  hydrateSettings(serverId, settings, nightModeStatus) {
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
      ...(nightModeStatus
        ? {
            nightModeStatusByServerId: {
              ...state.nightModeStatusByServerId,
              [serverId]: nightModeStatus,
            },
          }
        : {}),
    }));
  },

  hydrateTelemetry(serverId, input) {
    set((state) => ({
      ...(input.nightModeStatus
        ? {
            nightModeStatusByServerId: {
              ...state.nightModeStatusByServerId,
              [serverId]: input.nightModeStatus,
            },
          }
        : {}),
      ...(input.tokenUsage
        ? {
            usageByServerId: {
              ...state.usageByServerId,
              [serverId]: input.tokenUsage,
            },
          }
        : {}),
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
      const nightModeStatus = response.nightModeStatus;
      set((state) => ({
        settingsByServerId: {
          ...state.settingsByServerId,
          [serverId]: settings,
        },
        ...(nightModeStatus
          ? {
              nightModeStatusByServerId: {
                ...state.nightModeStatusByServerId,
                [serverId]: nightModeStatus,
              },
            }
          : {}),
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
    const nightModeStatus = response.nightModeStatus;
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
      ...(nightModeStatus
        ? {
            nightModeStatusByServerId: {
              ...state.nightModeStatusByServerId,
              [serverId]: nightModeStatus,
            },
          }
        : {}),
    }));
    return settings;
  },

  async loadUsage(serverId, client) {
    if (typeof client.getMainChatUsage !== "function") {
      return null;
    }
    set((state) => ({
      usageLoadingByServerId: { ...state.usageLoadingByServerId, [serverId]: true },
    }));
    try {
      const response = await client.getMainChatUsage();
      if (response.error || !response.usage) {
        return null;
      }
      const usage = response.usage;
      const nightModeStatus = response.nightModeStatus ?? undefined;
      set((state) => ({
        usageByServerId: {
          ...state.usageByServerId,
          [serverId]: usage,
        },
        ...(nightModeStatus
          ? {
              nightModeStatusByServerId: {
                ...state.nightModeStatusByServerId,
                [serverId]: nightModeStatus,
              },
            }
          : {}),
      }));
      return usage;
    } finally {
      set((state) => ({
        usageLoadingByServerId: { ...state.usageLoadingByServerId, [serverId]: false },
      }));
    }
  },

  async resetUsage(serverId, client) {
    const response = await client.resetMainChatUsage();
    if (response.error || !response.usage) {
      throw new Error(response.error ?? "Failed to reset main chat token usage");
    }
    const usage = response.usage;
    set((state) => ({
      usageByServerId: {
        ...state.usageByServerId,
        [serverId]: usage,
      },
    }));
    return usage;
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
