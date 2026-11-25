import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES,
  type MainChatPromptTemplate,
  type MainChatPromptTemplateInput,
} from "@getpaseo/protocol/main-chat";
import { create } from "zustand";

export const DEFAULT_PROMPT_LIBRARY_TEMPLATES: readonly MainChatPromptTemplate[] =
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES;

interface MainChatPromptLibraryStoreState {
  templatesByServerId: Record<string, readonly MainChatPromptTemplate[] | undefined>;
  loadingByServerId: Record<string, boolean | undefined>;
  loadedByServerId: Record<string, boolean | undefined>;
  hydratePromptLibrary: (serverId: string, templates: readonly MainChatPromptTemplate[]) => void;
  loadPromptLibrary: (
    serverId: string,
    client: DaemonClient,
  ) => Promise<readonly MainChatPromptTemplate[]>;
  savePromptTemplate: (
    serverId: string,
    template: MainChatPromptTemplateInput,
    client: DaemonClient,
  ) => Promise<MainChatPromptTemplate>;
  deletePromptTemplate: (
    serverId: string,
    input: { id?: string; slug?: string },
    client: DaemonClient,
  ) => Promise<boolean>;
}

export const useMainChatPromptLibraryStore = create<MainChatPromptLibraryStoreState>((set) => ({
  templatesByServerId: {},
  loadingByServerId: {},
  loadedByServerId: {},

  hydratePromptLibrary(serverId, templates) {
    set((state) => ({
      templatesByServerId: {
        ...state.templatesByServerId,
        [serverId]: [...templates],
      },
      loadedByServerId: {
        ...state.loadedByServerId,
        [serverId]: true,
      },
    }));
  },

  async loadPromptLibrary(serverId, client) {
    if (typeof client.listMainChatPromptLibrary !== "function") {
      return DEFAULT_PROMPT_LIBRARY_TEMPLATES;
    }
    set((state) => ({
      loadingByServerId: { ...state.loadingByServerId, [serverId]: true },
    }));
    try {
      const response = await client.listMainChatPromptLibrary();
      if (response.error) {
        return DEFAULT_PROMPT_LIBRARY_TEMPLATES;
      }
      const next = response.templates;
      set((state) => ({
        templatesByServerId: {
          ...state.templatesByServerId,
          [serverId]: next,
        },
        loadedByServerId: {
          ...state.loadedByServerId,
          [serverId]: true,
        },
      }));
      return next;
    } finally {
      set((state) => ({
        loadingByServerId: { ...state.loadingByServerId, [serverId]: false },
      }));
    }
  },

  async savePromptTemplate(serverId, template, client) {
    const response = await client.saveMainChatPromptTemplate(template);
    if (response.error || !response.template) {
      throw new Error(response.error ?? "Failed to save prompt template");
    }
    set((state) => ({
      templatesByServerId: {
        ...state.templatesByServerId,
        [serverId]: response.templates,
      },
      loadedByServerId: {
        ...state.loadedByServerId,
        [serverId]: true,
      },
    }));
    return response.template;
  },

  async deletePromptTemplate(serverId, input, client) {
    const response = await client.deleteMainChatPromptTemplate(input);
    if (response.error) {
      throw new Error(response.error);
    }
    set((state) => ({
      templatesByServerId: {
        ...state.templatesByServerId,
        [serverId]: response.templates,
      },
      loadedByServerId: {
        ...state.loadedByServerId,
        [serverId]: true,
      },
    }));
    return response.deleted;
  },
}));
