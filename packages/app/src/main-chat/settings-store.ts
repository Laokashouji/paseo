import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatCacheKeepaliveStatus,
  MainChatNightModeStatus,
  MainChatNotificationSummary,
  MainChatPatrolResult,
  MainChatSettings,
  MainChatSettingsPatch,
  MainChatSwitchModelProfileResponsePayload,
  MainChatTokenUsageSummary,
} from "@getpaseo/protocol/main-chat";
import { create } from "zustand";

interface MainChatSettingsStoreState {
  settingsByServerId: Record<string, MainChatSettings | undefined>;
  nightModeStatusByServerId: Record<string, MainChatNightModeStatus | undefined>;
  cacheKeepaliveStatusByServerId: Record<string, MainChatCacheKeepaliveStatus | undefined>;
  notificationSummaryByServerId: Record<string, MainChatNotificationSummary | undefined>;
  usageByServerId: Record<string, MainChatTokenUsageSummary | undefined>;
  usageLoadingByServerId: Record<string, boolean | undefined>;
  loadingByServerId: Record<string, boolean | undefined>;
  errorByServerId: Record<string, string | null | undefined>;
  lastPatrolByServerId: Record<string, MainChatPatrolResult | undefined>;
  loadSettings: (serverId: string, client: DaemonClient) => Promise<MainChatSettings | null>;
  updateSettings: (
    serverId: string,
    patch: MainChatSettingsPatch,
    client: DaemonClient,
  ) => Promise<MainChatSettings>;
  switchModelProfile: (
    serverId: string,
    input: { profileId?: string; rollback?: boolean },
    client: DaemonClient,
  ) => Promise<MainChatSwitchModelProfileResponsePayload>;
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
    cacheKeepaliveStatus?: MainChatCacheKeepaliveStatus,
  ) => void;
  hydrateTelemetry: (
    serverId: string,
    input: {
      nightModeStatus?: MainChatNightModeStatus;
      cacheKeepaliveStatus?: MainChatCacheKeepaliveStatus;
      tokenUsage?: MainChatTokenUsageSummary;
      notificationSummary?: MainChatNotificationSummary;
    },
  ) => void;
}

export const useMainChatSettingsStore = create<MainChatSettingsStoreState>((set) => ({
  settingsByServerId: {},
  nightModeStatusByServerId: {},
  cacheKeepaliveStatusByServerId: {},
  notificationSummaryByServerId: {},
  usageByServerId: {},
  usageLoadingByServerId: {},
  loadingByServerId: {},
  errorByServerId: {},
  lastPatrolByServerId: {},

  hydrateSettings(serverId, settings, nightModeStatus, cacheKeepaliveStatus) {
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
      errorByServerId: {
        ...state.errorByServerId,
        [serverId]: null,
      },
      ...(nightModeStatus
        ? {
            nightModeStatusByServerId: {
              ...state.nightModeStatusByServerId,
              [serverId]: nightModeStatus,
            },
          }
        : {}),
      ...(cacheKeepaliveStatus
        ? {
            cacheKeepaliveStatusByServerId: {
              ...state.cacheKeepaliveStatusByServerId,
              [serverId]: cacheKeepaliveStatus,
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
      ...(input.cacheKeepaliveStatus
        ? {
            cacheKeepaliveStatusByServerId: {
              ...state.cacheKeepaliveStatusByServerId,
              [serverId]: input.cacheKeepaliveStatus,
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
      ...(input.notificationSummary
        ? {
            notificationSummaryByServerId: {
              ...state.notificationSummaryByServerId,
              [serverId]: input.notificationSummary,
            },
          }
        : {}),
    }));
  },

  async loadSettings(serverId, client) {
    set((state) => ({
      loadingByServerId: { ...state.loadingByServerId, [serverId]: true },
      errorByServerId: { ...state.errorByServerId, [serverId]: null },
    }));
    try {
      const response = await client.getMainChatSettings();
      if (response.error || !response.settings) {
        const message = response.error ?? "Failed to load main chat settings";
        set((state) => ({
          errorByServerId: { ...state.errorByServerId, [serverId]: message },
        }));
        return null;
      }
      const settings = response.settings;
      const nightModeStatus = response.nightModeStatus;
      const cacheKeepaliveStatus = response.cacheKeepaliveStatus;
      set((state) => ({
        settingsByServerId: {
          ...state.settingsByServerId,
          [serverId]: settings,
        },
        errorByServerId: {
          ...state.errorByServerId,
          [serverId]: null,
        },
        ...(nightModeStatus
          ? {
              nightModeStatusByServerId: {
                ...state.nightModeStatusByServerId,
                [serverId]: nightModeStatus,
              },
            }
          : {}),
        ...(cacheKeepaliveStatus
          ? {
              cacheKeepaliveStatusByServerId: {
                ...state.cacheKeepaliveStatusByServerId,
                [serverId]: cacheKeepaliveStatus,
              },
            }
          : {}),
      }));
      return settings;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set((state) => ({
        errorByServerId: { ...state.errorByServerId, [serverId]: message },
      }));
      throw error;
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
    const cacheKeepaliveStatus = response.cacheKeepaliveStatus;
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
      errorByServerId: {
        ...state.errorByServerId,
        [serverId]: null,
      },
      ...(nightModeStatus
        ? {
            nightModeStatusByServerId: {
              ...state.nightModeStatusByServerId,
              [serverId]: nightModeStatus,
            },
          }
        : {}),
      ...(cacheKeepaliveStatus
        ? {
            cacheKeepaliveStatusByServerId: {
              ...state.cacheKeepaliveStatusByServerId,
              [serverId]: cacheKeepaliveStatus,
            },
          }
        : {}),
    }));
    return settings;
  },

  async switchModelProfile(serverId, input, client) {
    const response = await client.switchMainChatModelProfile(input);
    if (response.error || !response.settings) {
      throw new Error(response.error ?? "Failed to switch model profile");
    }
    const settings = response.settings;
    set((state) => ({
      settingsByServerId: {
        ...state.settingsByServerId,
        [serverId]: settings,
      },
    }));
    return response;
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
