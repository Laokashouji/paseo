// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDefaultMainChatSettings } from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { personaEmbedLocales } from "@/i18n/resources/persona-embed-locales";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatHeroRow, useShouldShowMainChatHero } from "@/main-chat/hero-row";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { PersonaSettingsSection } from "@/screens/settings/persona/persona-section";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import { PersonaHeroRow } from "./hero-row";
import {
  DEFAULT_PERSONA_EMBED_SETTINGS,
  normalizePersonaEmbedSettings,
  type PersonaEmbedSettings,
} from "./settings";
import { usePersonaEmbedSettings } from "./use-persona-settings";

const mockHosts = [
  { serverId: "srv_1", label: "DevBox" },
  { serverId: "srv_2", label: "MacBook" },
];

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  usePathname: () => "/h/srv_1/workspace/wks_1",
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh-CN" },
  }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: (actionId: string) => (actionId === "open-main-chat" ? [["mod", "0"]] : null),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "wks_1" }),
  useLastWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "wks_1" }),
}));

const noopToastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: () => () => undefined,
  error: () => () => undefined,
  copied: () => () => undefined,
};

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-24T00:00:00.000Z"),
    updatedAt: new Date("2026-11-24T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-24T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo/paseo-fork",
    model: null,
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeFakeClient(): DaemonClient {
  return {
    getMainChatSettings: vi.fn(async () => ({
      settings: { ...createDefaultMainChatSettings("conservative"), enabled: true },
    })),
    updateMainChatSettings: vi.fn(async (_patch: Record<string, unknown>) => ({
      settings: { ...createDefaultMainChatSettings("conservative"), enabled: false },
    })),
  } as unknown as DaemonClient;
}

function seedSessionStore(client: DaemonClient): void {
  const session: SessionState = {
    serverId: "srv_1",
    client,
    clientGeneration: 1,
    viewedTimelineSync: null,
    serverInfo: {
      serverId: "srv_1",
      hostname: "n37-217-003",
      version: "0.17.532",
      features: {
        mainChat: true,
      },
    },
    hasHydratedAgents: true,
    hasHydratedWorkspaces: true,
    hasWorkspaceDirectorySnapshot: true,
    isPlayingAudio: false,
    focusedAgentId: null,
    focusedTerminalId: null,
    agentStreamTail: new Map(),
    agentStreamHead: new Map(),
    agentTasks: new Map(),
    messageSubmissions: new Map(),
    agentTimelineCursor: new Map(),
    agentTimelineUnsettledTurn: new Map(),
    agentTimelineHasOlder: new Map(),
    agentTimelineHasNewer: new Map(),
    agentTimelineOlderFetchInFlight: new Map(),
    historySyncGeneration: 0,
    agentHistorySyncGeneration: new Map(),
    agentAuthoritativeHistoryApplied: new Map(),
    agents: new Map(),
    agentDetails: new Map(),
    pendingPermissions: new Map(),
    workspaces: new Map(),
    projects: new Map(),
  } as unknown as SessionState;

  useSessionStore.setState({
    sessions: { srv_1: session },
    agentLastActivity: new Map(),
  });
}

function pushUnrelatedAgents(count: number): void {
  for (let i = 0; i < count; i += 1) {
    useSessionStore.setState((state) => {
      const s1 = state.sessions.srv_1;
      if (!s1) return state;
      const nextAgents = new Map(s1.agents);
      nextAgents.set(`unrelated_${i}`, makeAgent({ id: `unrelated_${i}`, serverId: "srv_1" }));
      return {
        ...state,
        sessions: {
          ...state.sessions,
          srv_1: { ...s1, agents: nextAgents },
        },
      };
    });
  }
}

function makeQueryClient(personaPatch: Partial<PersonaEmbedSettings>): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const settings: AppSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    persona: normalizePersonaEmbedSettings({
      ...DEFAULT_PERSONA_EMBED_SETTINGS,
      ...personaPatch,
    }),
  };
  qc.setQueryData(APP_SETTINGS_QUERY_KEY, settings);
  return qc;
}

function hasSnapshotLoopError(calls: unknown[][]): boolean {
  return calls.some((args) =>
    args.some(
      (arg) =>
        typeof arg === "string" &&
        (arg.includes("Maximum update depth") ||
          arg.includes("getSnapshot should be cached") ||
          arg.includes("Minified React error #185")),
    ),
  );
}

describe("Persona embed React selector stability and mutual exclusion", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useMainChatSettingsStore.setState({
      settingsByServerId: {
        srv_1: { ...createDefaultMainChatSettings("conservative"), enabled: true },
      },
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    seedSessionStore(makeFakeClient());
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keeps PersonaHeroRow render count flat across unrelated session.agents updates", () => {
    const qc = makeQueryClient({ enabled: true, hubUrl: "http://10.37.217.3:18660" });
    let renderCount = 0;
    function TrackedPersonaHero() {
      renderCount += 1;
      return <PersonaHeroRow />;
    }

    const view = render(
      <QueryClientProvider client={qc}>
        <ToastApiProvider api={noopToastApi}>
          <TrackedPersonaHero />
        </ToastApiProvider>
      </QueryClientProvider>,
    );

    expect(view.container.textContent).toContain("personaEmbed.sidebar.title");
    expect(view.container.textContent).toContain("10.37.217.3:18660");
    const rendersAfterMount = renderCount;
    expect(rendersAfterMount).toBeLessThan(6);

    act(() => {
      pushUnrelatedAgents(6);
    });

    expect(renderCount).toBe(rendersAfterMount);
    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });

  it("renders PersonaSettingsSection without React #185 loops across store updates", () => {
    const qc = makeQueryClient({ enabled: true });
    let renderCount = 0;
    function TrackedSettings() {
      renderCount += 1;
      return <PersonaSettingsSection />;
    }

    const view = render(
      <QueryClientProvider client={qc}>
        <ToastApiProvider api={noopToastApi}>
          <KeyboardActionDispatcherProvider>
            <TrackedSettings />
          </KeyboardActionDispatcherProvider>
        </ToastApiProvider>
      </QueryClientProvider>,
    );

    expect(view.container.textContent).toContain("personaEmbed.settings.enabledLabel");
    expect(view.container.textContent).toContain("personaEmbed.settings.mainChatStillActiveBanner");
    const rendersAfterMount = renderCount;
    expect(rendersAfterMount).toBeLessThan(8);

    act(() => {
      pushUnrelatedAgents(5);
    });

    expect(renderCount).toBe(rendersAfterMount);
    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });

  it("mutually hides MainChatHeroRow when Persona is enabled with hideBuiltInMainChatWhenEnabled=true, and restores when turned off", async () => {
    const qc = makeQueryClient({ enabled: true, hideBuiltInMainChatWhenEnabled: true });
    let shouldShow = true;
    let hiddenFlag = false;
    function Probe() {
      shouldShow = useShouldShowMainChatHero();
      hiddenFlag = usePersonaEmbedSettings().hideBuiltInMainChatWhenEnabled;
      return <MainChatHeroRow />;
    }

    const view = render(
      <QueryClientProvider client={qc}>
        <ToastApiProvider api={noopToastApi}>
          <KeyboardActionDispatcherProvider>
            <Probe />
          </KeyboardActionDispatcherProvider>
        </ToastApiProvider>
      </QueryClientProvider>,
    );

    expect(shouldShow).toBe(false);
    expect(view.queryByTestId("sidebar-main-chat-hero")).toBeNull();

    // Switching off mutual exclusion (dual-entry mode) restores MainChatHeroRow cleanly
    act(() => {
      qc.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, {
        ...DEFAULT_CLIENT_SETTINGS,
        persona: {
          ...DEFAULT_PERSONA_EMBED_SETTINGS,
          enabled: true,
          hideBuiltInMainChatWhenEnabled: false,
        },
      });
    });

    await waitFor(() => {
      expect({ shouldShow, hiddenFlag }).toEqual({ shouldShow: true, hiddenFlag: false });
      expect(view.queryByTestId("sidebar-main-chat-hero")).not.toBeNull();
    });
    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });

  it("syncs online multi-host main-chat settings while built-in Main Chat entry is hidden, distinguishes loading/error/active states, and never auto-disables", async () => {
    let resolveHost1!: (value: {
      settings: ReturnType<typeof createDefaultMainChatSettings>;
    }) => void;
    const host1Promise = new Promise<{
      settings: ReturnType<typeof createDefaultMainChatSettings>;
    }>((resolve) => {
      resolveHost1 = resolve;
    });

    const host1Update = vi.fn(async () => ({
      settings: { ...createDefaultMainChatSettings("conservative"), enabled: false },
    }));
    const host1Client = {
      getMainChatSettings: vi.fn(() => host1Promise),
      updateMainChatSettings: host1Update,
    } as unknown as DaemonClient;

    const host2Get = vi
      .fn()
      .mockRejectedValueOnce(new Error("RPC timeout"))
      .mockResolvedValueOnce({
        settings: { ...createDefaultMainChatSettings("conservative"), enabled: true },
      });
    const host2Update = vi.fn(async () => ({
      settings: { ...createDefaultMainChatSettings("conservative"), enabled: false },
    }));
    const host2Client = {
      getMainChatSettings: host2Get,
      updateMainChatSettings: host2Update,
    } as unknown as DaemonClient;

    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      errorByServerId: {},
      lastPatrolByServerId: {},
    });
    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          client: host1Client,
          clientGeneration: 1,
          viewedTimelineSync: null,
          serverInfo: {
            serverId: "srv_1",
            hostname: "n37-217-003",
            version: "0.17.533",
            features: { mainChat: true },
          },
          hasHydratedAgents: true,
          hasHydratedWorkspaces: true,
          hasWorkspaceDirectorySnapshot: true,
          agents: new Map(),
          agentDetails: new Map(),
          workspaces: new Map(),
          projects: new Map(),
        } as unknown as SessionState,
        srv_2: {
          serverId: "srv_2",
          client: host2Client,
          clientGeneration: 1,
          viewedTimelineSync: null,
          serverInfo: {
            serverId: "srv_2",
            hostname: "ML9YK34K66",
            version: "0.17.533",
            features: { mainChat: true },
          },
          hasHydratedAgents: true,
          hasHydratedWorkspaces: true,
          hasWorkspaceDirectorySnapshot: true,
          agents: new Map(),
          agentDetails: new Map(),
          workspaces: new Map(),
          projects: new Map(),
        } as unknown as SessionState,
      },
      agentLastActivity: new Map(),
    });

    const qc = makeQueryClient({ enabled: true, hideBuiltInMainChatWhenEnabled: true });
    const view = render(
      <QueryClientProvider client={qc}>
        <ToastApiProvider api={noopToastApi}>
          <KeyboardActionDispatcherProvider>
            <MainChatHeroRow />
            <PersonaSettingsSection />
          </KeyboardActionDispatcherProvider>
        </ToastApiProvider>
      </QueryClientProvider>,
    );

    // Built-in MainChatHeroRow is hidden, yet both online hosts start syncing immediately
    expect(view.queryByTestId("sidebar-main-chat-hero")).toBeNull();
    expect(view.queryByTestId("persona-main-chat-loading-srv_1")).not.toBeNull();

    // Host 2 fails first -> error banner with retry button renders
    await waitFor(() => {
      expect(view.queryByTestId("persona-main-chat-error-srv_2")).not.toBeNull();
    });

    // Resolve Host 1 as enabled -> active warning banner renders; NEVER auto-disables
    act(() => {
      resolveHost1({
        settings: { ...createDefaultMainChatSettings("conservative"), enabled: true },
      });
    });
    await waitFor(() => {
      expect(view.queryByTestId("persona-main-chat-active-banner-srv_1")).not.toBeNull();
    });
    expect(host1Update).not.toHaveBeenCalled();
    expect(host2Update).not.toHaveBeenCalled();

    // Retry Host 2 -> transitions from error to confirmed-active banner
    const retryBtn = view.getByTestId("persona-retry-main-chat-srv_2");
    act(() => {
      retryBtn.click();
    });
    await waitFor(() => {
      expect(view.queryByTestId("persona-main-chat-active-banner-srv_2")).not.toBeNull();
    });
    expect(host2Update).not.toHaveBeenCalled();
    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });

  it("keeps identical key sets and interpolation placeholders across all 9 supported locales", () => {
    const flattenKeys = (obj: Record<string, unknown>, prefix = ""): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(obj)) {
        const nextKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "string") {
          out[nextKey] = value;
        } else if (value && typeof value === "object") {
          Object.assign(out, flattenKeys(value as Record<string, unknown>, nextKey));
        }
      }
      return out;
    };

    const extractPlaceholders = (text: string): string[] =>
      Array.from(text.matchAll(/\{\{([^}]+)\}\}/g), (match) => match[1]).sort();

    const enFlat = flattenKeys(personaEmbedLocales.en as unknown as Record<string, unknown>);
    const enKeys = Object.keys(enFlat).sort();
    const nonEnglishLocales = ["zh-CN", "ar", "es", "fr", "ja", "ko", "pt-BR", "ru"] as const;

    for (const locale of nonEnglishLocales) {
      const localeFlat = flattenKeys(
        personaEmbedLocales[locale] as unknown as Record<string, unknown>,
      );
      expect(Object.keys(localeFlat).sort()).toEqual(enKeys);
      for (const key of enKeys) {
        expect(extractPlaceholders(localeFlat[key])).toEqual(extractPlaceholders(enFlat[key]));
      }
      expect(personaEmbedLocales[locale].settings.enabledLabel).not.toBe(
        personaEmbedLocales.en.settings.enabledLabel,
      );
      expect(personaEmbedLocales[locale].webFallback.title).not.toBe(
        personaEmbedLocales.en.webFallback.title,
      );
      const identicalCount = enKeys.filter((key) => localeFlat[key] === enFlat[key]).length;
      expect(identicalCount).toBeLessThan(Math.ceil(enKeys.length * 0.1));
    }
  });

  it("keeps multi-Hub expanded PersonaHeroRow render count flat across unrelated session.agents updates", () => {
    const queryClient = makeQueryClient({
      enabled: true,
      hubs: [
        { id: "hub-a", name: "Work Hub", hubUrl: "http://10.37.217.3:18660", machineServerMap: {} },
        { id: "hub-b", name: "Home Hub", hubUrl: "http://127.0.0.1:18661", machineServerMap: {} },
      ],
      activeHubId: "hub-a",
      splitEnabled: true,
      secondaryHubId: "hub-b",
      sidebarExpanded: true,
    });

    let renders = 0;
    function TrackedHero() {
      renders += 1;
      return <PersonaHeroRow />;
    }

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ToastApiProvider api={noopToastApi}>
          <KeyboardActionDispatcherProvider>
            <TrackedHero />
          </KeyboardActionDispatcherProvider>
        </ToastApiProvider>
      </QueryClientProvider>,
    );

    expect(view.queryByTestId("sidebar-persona-hub-list")).not.toBeNull();
    expect(view.queryByTestId("sidebar-persona-split-badge")).not.toBeNull();
    const initialRenders = renders;

    act(() => {
      pushUnrelatedAgents(6);
    });

    expect(renders).toBe(initialRenders);
    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });
});
