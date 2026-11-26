import { QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { queryClient as appQueryClient } from "@/data/query-client";
import { loadAppSettingsFromStorage, saveAppSettings } from "@/hooks/use-settings";
import { APP_SETTINGS_QUERY_KEY, type AppSettings } from "@/hooks/use-settings/storage";
import {
  DEFAULT_PERSONA_EMBED_SETTINGS,
  normalizePersonaEmbedSettings,
  type PersonaEmbedSettings,
} from "./settings";

const APP_SETTINGS_KEY_HEAD = APP_SETTINGS_QUERY_KEY[0];

/**
 * Reads Persona embed settings reactively from the active QueryClient cache.
 * Falls back safely to `appQueryClient` without triggering AsyncStorage reads when a
 * component is rendered in an isolated unit test without a `<QueryClientProvider>`.
 */
export function usePersonaEmbedSettings(): PersonaEmbedSettings {
  const contextClient = useContext(QueryClientContext);
  const queryClient = contextClient ?? appQueryClient;

  useEffect(() => {
    if (!contextClient) {
      return;
    }
    if (contextClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY) !== undefined) {
      return;
    }
    void contextClient
      .ensureQueryData({
        queryKey: APP_SETTINGS_QUERY_KEY,
        queryFn: () => loadAppSettingsFromStorage(),
        staleTime: Infinity,
      })
      .catch(() => undefined);
  }, [contextClient]);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[0] === APP_SETTINGS_KEY_HEAD) {
          onStoreChange();
        }
      }),
    [queryClient],
  );

  const getSnapshot = useCallback(
    () => queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona,
    [queryClient],
  );

  const rawPersona = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(
    () => (rawPersona ? normalizePersonaEmbedSettings(rawPersona) : DEFAULT_PERSONA_EMBED_SETTINGS),
    [rawPersona],
  );
}

/**
 * Returns true when built-in Main Chat sidebar entries & primary shortcut should yield to Persona.
 */
export function useIsBuiltInMainChatHiddenByPersona(): boolean {
  const persona = usePersonaEmbedSettings();
  return persona.enabled && persona.hideBuiltInMainChatWhenEnabled;
}

export function useUpdatePersonaEmbedSettings(): (
  patch: Partial<PersonaEmbedSettings>,
) => Promise<void> {
  const contextClient = useContext(QueryClientContext);
  const queryClient = contextClient ?? appQueryClient;

  return useCallback(
    async (patch: Partial<PersonaEmbedSettings>) => {
      await saveAppSettings({
        queryClient,
        updates: (current) => ({
          persona: normalizePersonaEmbedSettings({
            ...current.persona,
            ...patch,
          }),
        }),
      });
    },
    [queryClient],
  );
}

export function readPersonaEmbedSettingsSnapshot(): PersonaEmbedSettings {
  const cached = appQueryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
  return cached?.persona
    ? normalizePersonaEmbedSettings(cached.persona)
    : DEFAULT_PERSONA_EMBED_SETTINGS;
}
