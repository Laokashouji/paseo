import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDefaultMainChatSettings } from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import PersonaRoute from "@/app/persona";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { DesktopHostBridge } from "@/desktop/host";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { PersonaSettingsSection } from "@/screens/settings/persona/persona-section";
import {
  useSessionStore,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  mountPersonaGuestPreload,
  type PersonaGuestIpcLike,
} from "../../../desktop/src/features/persona-webview/guest-preload";
import {
  createPersonaHostHubRegistry,
  registerPersonaWebviewGuestIpcBridge,
  type PersonaGuestFrameLike,
  type PersonaGuestIpcMainEventLike,
  type PersonaGuestIpcWebContentsLike,
} from "../../../desktop/src/features/persona-webview/index";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import { PersonaHeroRow } from "./hero-row";
import { PersonaSurface as ElectronPersonaSurface } from "./persona-surface.electron";
import { PersonaSurface } from "./persona-surface.web";
import {
  destroyResidentPersonaWebview,
  disableResidentPersonaWebview,
  ensureResidentPersonaWebview,
  getResidentPersonaPoolDiagnostics,
  getResidentPersonaWebview,
  parkResidentPersonaWebview,
  PERSONA_RESIDENT_HOST_ID,
  presentResidentPersonaWebview,
  reconcileResidentPersonaWebviews,
} from "./resident-persona-webview.electron";
import {
  DEFAULT_PERSONA_EMBED_SETTINGS,
  DEFAULT_PERSONA_HUB_ID,
  normalizePersonaEmbedSettings,
  PERSONA_WEBVIEW_PARTITION,
  PERSONA_WEBVIEW_PARTITION_PREFIX,
  type PersonaEmbedSettings,
} from "./settings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { mockRouter, mockNavigateToWorkspace, mockHosts } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  mockNavigateToWorkspace: vi.fn(
    ({ serverId, workspaceId }: { serverId: string; workspaceId: string }) =>
      `/h/${serverId}/workspace/${workspaceId}`,
  ),
  mockHosts: [
    { serverId: "srv_devbox", label: "DevBox" },
    { serverId: "srv_mac", label: "MacBook" },
  ],
}));

vi.mock("electron", () => {
  const ipcRenderer = {
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
  return {
    default: { ipcRenderer },
    ipcRenderer,
  };
});

vi.mock("expo-router", () => ({
  router: mockRouter,
  usePathname: () => "/persona",
}));

vi.mock("@/components/host-route-bootstrap-boundary", () => ({
  HostRouteBootstrapBoundary: ({ children }: { children: ReactElement }) => children,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: (input: { serverId: string; workspaceId: string }) =>
    mockNavigateToWorkspace(input),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeSnapshot: () => ({ connectionStatus: "online", client: null }),
  getHostRuntimeStore: () => ({
    getHosts: () => mockHosts,
    getSnapshot: () => ({ connectionStatus: "online", client: null }),
    acquireDirectoryDemand: () => () => undefined,
    runProbeCycleNow: async () => undefined,
  }),
}));

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: (actionId: string) => (actionId === "open-main-chat" ? [["mod", "0"]] : null),
}));

const toastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: vi.fn(() => () => undefined),
  error: vi.fn(() => () => undefined),
  copied: vi.fn(() => () => undefined),
};

function getLoopbackHubUrl(): string {
  return `${window.location.origin}/__persona-test-hub`;
}

function makeQueryClient(personaPatch: Partial<PersonaEmbedSettings> = {}): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const persona = personaPatch.hubs
    ? normalizePersonaEmbedSettings({
        ...DEFAULT_PERSONA_EMBED_SETTINGS,
        ...personaPatch,
      })
    : normalizePersonaEmbedSettings({
        enabled: personaPatch.enabled ?? DEFAULT_PERSONA_EMBED_SETTINGS.enabled,
        hubUrl: personaPatch.hubUrl ?? getLoopbackHubUrl(),
        machineServerMap: personaPatch.machineServerMap ?? {},
        hidePersonaSidebar:
          personaPatch.hidePersonaSidebar ?? DEFAULT_PERSONA_EMBED_SETTINGS.hidePersonaSidebar,
        hideBuiltInMainChatWhenEnabled:
          personaPatch.hideBuiltInMainChatWhenEnabled ??
          DEFAULT_PERSONA_EMBED_SETTINGS.hideBuiltInMainChatWhenEnabled,
        interceptSessionClicks:
          personaPatch.interceptSessionClicks ??
          DEFAULT_PERSONA_EMBED_SETTINGS.interceptSessionClicks,
      });
  qc.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_CLIENT_SETTINGS,
    persona,
  });
  return qc;
}

function installDesktopPersonaMock(
  overrides: Partial<NonNullable<DesktopHostBridge["persona"]>> = {},
) {
  const setHubUrl = overrides.setHubUrl ?? vi.fn(async () => true);
  const setHubUrls =
    overrides.setHubUrls ??
    vi.fn(async (urls: string[] | null, options?: { enabled?: boolean }) =>
      setHubUrl(urls?.[0] ?? null, options),
    );
  const setHubEntries =
    overrides.setHubEntries ??
    vi.fn(
      async (
        entries: Array<{ partition: string; hubUrl: string }> | null,
        options?: { enabled?: boolean },
      ) => setHubUrls(entries ? entries.map((entry) => entry.hubUrl) : null, options),
    );
  const checkHealth =
    overrides.checkHealth ??
    vi.fn(async () => ({
      ok: true as const,
      hubName: "loopback-hub",
      version: "0.9.9",
      latencyMs: 4,
    }));
  const clearSession = overrides.clearSession ?? vi.fn(async () => undefined);
  const openDevTools = overrides.openDevTools ?? vi.fn(async () => true);
  const dialogAsk = vi.fn(async () => true);
  const eventListeners = new Map<string, Set<(payload: unknown) => void>>();

  window.paseoDesktop = {
    platform: "darwin",
    dialog: {
      ask: dialogAsk,
    },
    events: {
      on: async (eventName, handler) => {
        const set = eventListeners.get(eventName) ?? new Set();
        set.add(handler);
        eventListeners.set(eventName, set);
        return () => {
          set.delete(handler);
        };
      },
    },
    persona: {
      partition: PERSONA_WEBVIEW_PARTITION,
      partitionPrefix: PERSONA_WEBVIEW_PARTITION_PREFIX,
      supportsPerHubPartitions: true,
      setHubEntries,
      setHubUrls,
      setHubUrl,
      checkHealth,
      clearSession,
      openDevTools,
      ...overrides,
    },
  };

  return {
    setHubEntries,
    setHubUrls,
    setHubUrl,
    checkHealth,
    clearSession,
    openDevTools,
    dialogAsk,
    emitDesktopEvent(eventName: string, payload: unknown) {
      for (const handler of eventListeners.get(eventName) ?? []) {
        handler(payload);
      }
    },
  };
}

describe("Persona C2 embed Chromium browser regressions", () => {
  let hostEl: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;
  let originalDesktop: DesktopHostBridge | undefined;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalDesktop = window.paseoDesktop;
    delete window.paseoDesktop;
    window.localStorage.removeItem("persona.token");
    window.localStorage.removeItem("jarvis.token");

    hostEl = document.createElement("div");
    hostEl.style.width = "1024px";
    hostEl.style.minHeight = "720px";
    document.body.appendChild(hostEl);
    root = createRoot(hostEl);
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalDesktop === undefined) {
      delete window.paseoDesktop;
    } else {
      window.paseoDesktop = originalDesktop;
    }
    window.localStorage.removeItem("persona.token");
    window.localStorage.removeItem("jarvis.token");
    destroyResidentPersonaWebview();
    document.getElementById(PERSONA_RESIDENT_HOST_ID)?.remove();
    await act(async () => {
      root.unmount();
    });
    hostEl.remove();
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      errorByServerId: {},
      lastPatrolByServerId: {},
    });
    vi.clearAllMocks();
  });

  async function renderInBrowser(qc: QueryClient, element: ReactElement): Promise<void> {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={qc}>
            <ToastApiProvider api={toastApi}>
              <KeyboardActionDispatcherProvider>{element}</KeyboardActionDispatcherProvider>
            </ToastApiProvider>
          </QueryClientProvider>
        </I18nextProvider>,
      );
    });
  }

  it("renders settings & sidebar hero in zh-CN/en, probes health via Electron main process, and reports Web CORS unreadable state", async () => {
    const hubUrl = getLoopbackHubUrl();
    const updateMainChatSettings = vi.fn(async () => ({
      settings: { ...createDefaultMainChatSettings("conservative"), enabled: false },
    }));
    const fakeClient = { updateMainChatSettings } as unknown as DaemonClient;

    useSessionStore.setState({
      sessions: {
        srv_devbox: {
          serverId: "srv_devbox",
          client: fakeClient,
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.533" },
          agents: new Map(),
          agentDetails: new Map(),
          workspaces: new Map(),
        } as unknown as SessionState,
      },
      agentLastActivity: new Map(),
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: {
        srv_devbox: { ...createDefaultMainChatSettings("conservative"), enabled: true },
      },
    });

    const desktopMock = installDesktopPersonaMock({
      checkHealth: vi.fn(async () => ({
        ok: true as const,
        hubName: "loopback-hub",
        version: "0.9.1",
        latencyMs: 5,
      })),
    });

    // Guard against any accidental real browser fetch during Electron main-process health probe
    const fetchSpy = vi.fn(async () => {
      throw new Error("Electron health check must not call renderer fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const qc = makeQueryClient({ enabled: true, hubUrl });
    await renderInBrowser(
      qc,
      <>
        <PersonaHeroRow />
        <PersonaSettingsSection />
      </>,
    );

    expect(hostEl.textContent).toContain("Persona");
    expect(hostEl.textContent).toContain("启用单窗口 Persona 内嵌");
    expect(hostEl.textContent).toContain("检测到宿主「DevBox」的自研主对话仍在后台开启。");

    // Electron health check delegates to main process checkHealth without calling fetch
    const testConnBtn = hostEl.querySelector(
      '[data-testid="persona-settings-test-connection"]',
    ) as HTMLElement | null;
    expect(testConnBtn).not.toBeNull();
    await act(async () => {
      testConnBtn?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(desktopMock.setHubUrl).toHaveBeenCalledWith(hubUrl, { enabled: true });
    expect(desktopMock.checkHealth).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hostEl.textContent).toContain("连通正常 · loopback-hub（v0.9.1）");

    // Click one-click disable built-in Main Chat on host -> banner disappears
    const disableBtn = hostEl.querySelector(
      '[data-testid="persona-disable-main-chat-srv_devbox"]',
    ) as HTMLElement | null;
    expect(disableBtn).not.toBeNull();
    await act(async () => {
      disableBtn?.click();
      await Promise.resolve();
    });
    expect(updateMainChatSettings).toHaveBeenCalledWith({ enabled: false });
    expect(
      hostEl.querySelector('[data-testid="persona-main-chat-active-banner-srv_devbox"]'),
    ).toBeNull();

    // Switch language to English -> verify live i18n update
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(hostEl.textContent).toContain("Enable embedded Persona");
    expect(hostEl.textContent).toContain("Machine to host mapping");
    expect(hostEl.textContent).toContain("Reachable · loopback-hub (v0.9.1)");

    // Web mode (no window.paseoDesktop): cross-origin CORS block renders explicit CORS unreadable notice
    delete window.paseoDesktop;
    const crossOriginLoopback = "http://127.0.0.1:18669";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.mode === "no-cors") {
        return { type: "opaque", ok: false } as unknown as Response;
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const webQc = makeQueryClient({ enabled: true, hubUrl: crossOriginLoopback });
    await renderInBrowser(webQc, <PersonaSettingsSection />);
    const webTestBtn = hostEl.querySelector(
      '[data-testid="persona-settings-test-connection"]',
    ) as HTMLElement | null;
    await act(async () => {
      webTestBtn?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      hostEl.querySelector('[data-testid="persona-settings-health-cors-unreadable"]'),
    ).not.toBeNull();
  });

  it("renders machine_id -> serverId mappings and allows removing entries interactively", async () => {
    const qc = makeQueryClient({
      enabled: true,
      machineServerMap: {
        "n37-217-003": "srv_devbox",
        "mac-alias": "srv_mac",
      },
    });
    await renderInBrowser(qc, <PersonaSettingsSection />);

    expect(hostEl.querySelector('[data-testid="persona-mapping-row-n37-217-003"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-mapping-row-mac-alias"]')).not.toBeNull();
    expect(hostEl.textContent).toContain("DevBox (srv_devbox)");

    const removeBtn = hostEl.querySelector(
      '[data-testid="persona-mapping-remove-mac-alias"]',
    ) as HTMLElement | null;
    expect(removeBtn).not.toBeNull();
    await act(async () => {
      removeBtn?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(hostEl.querySelector('[data-testid="persona-mapping-row-mac-alias"]')).toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-mapping-row-n37-217-003"]')).not.toBeNull();
  });

  it("renders Web fallback cleanly using loopback URLs only, blocking HTTPS->HTTP mixed content and mounting loopback iframe on HTTP", async () => {
    const loopbackHubUrl = getLoopbackHubUrl();
    const qc = makeQueryClient({ enabled: true, hubUrl: loopbackHubUrl });
    await renderInBrowser(qc, <PersonaSurface pageProtocolOverride="https:" />);

    expect(hostEl.textContent).toContain("在浏览器中以外部标签页使用 Persona");
    expect(hostEl.querySelector("iframe")).toBeNull();

    const toggle = hostEl.querySelector(
      '[data-testid="persona-web-iframe-toggle"]',
    ) as HTMLElement | null;
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle?.click();
    });

    // HTTPS page embedding HTTP loopback Hub must show mixed-content block notice without mounting iframe
    expect(
      hostEl.querySelector('[data-testid="persona-web-mixed-content-warning"]'),
    ).not.toBeNull();
    expect(hostEl.querySelector("iframe")).toBeNull();

    // Re-render on HTTP page -> toggling iframe preview mounts sandboxed iframe pointed only at local loopback
    await renderInBrowser(qc, <PersonaSurface pageProtocolOverride="http:" />);
    const iframe = hostEl.querySelector("iframe") as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe(loopbackHubUrl);
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("refuses webview creation when main process rejects Hub registration and cancels in-flight mounts on disable", async () => {
    const hubUrl = getLoopbackHubUrl();

    // 1. Main process rejects Hub registration -> ensureResidentPersonaWebview returns null and creates no DOM
    installDesktopPersonaMock({ setHubUrl: vi.fn(async () => false) });
    const rejected = await ensureResidentPersonaWebview(hubUrl);
    expect(rejected).toBeNull();
    expect(getResidentPersonaWebview()).toBeNull();
    expect(document.querySelector("webview")).toBeNull();

    const qcEnabled = makeQueryClient({ enabled: true, hubUrl });
    await renderInBrowser(qcEnabled, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="persona-mount-rejected-state"]')).not.toBeNull();
    expect(getResidentPersonaWebview()).toBeNull();

    // 2. Disabled state blocks /persona route & ElectronPersonaSurface from mounting
    const desktopAllow = installDesktopPersonaMock();
    const qcDisabled = makeQueryClient({ enabled: false, hubUrl });
    await renderInBrowser(qcDisabled, <PersonaRoute />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="persona-route-disabled"]')).not.toBeNull();
    expect(getResidentPersonaWebview()).toBeNull();
    expect(desktopAllow.setHubUrl).not.toHaveBeenCalledWith(hubUrl, { enabled: true });

    // Unloaded settings gate waits without mounting until AppSettings hydration finishes
    let resolveHydration!: (settings: AppSettings) => void;
    const qcPending = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // Pre-register an in-flight fetch on APP_SETTINGS_QUERY_KEY so ensureQueryData awaits it
    const pendingHydrationPromise = qcPending.fetchQuery({
      queryKey: APP_SETTINGS_QUERY_KEY,
      queryFn: () =>
        new Promise<AppSettings>((resolve) => {
          resolveHydration = resolve;
        }),
    });
    await renderInBrowser(qcPending, <PersonaRoute />);
    expect(hostEl.querySelector('[data-testid="persona-route-loading"]')).not.toBeNull();
    expect(getResidentPersonaWebview()).toBeNull();

    // Resolving hydration with enabled: false transitions directly to disabled without mounting
    await act(async () => {
      resolveHydration({
        ...DEFAULT_CLIENT_SETTINGS,
        persona: {
          ...DEFAULT_PERSONA_EMBED_SETTINGS,
          enabled: false,
          hubUrl,
        },
      });
      await pendingHydrationPromise;
    });
    expect(hostEl.querySelector('[data-testid="persona-route-disabled"]')).not.toBeNull();
    expect(getResidentPersonaWebview()).toBeNull();

    // 3. In-flight ensureResidentPersonaWebview is cancelled if disableResidentPersonaWebview runs before IPC resolves
    let resolvePendingSetHub!: (accepted: boolean) => void;
    const pendingSetHub = new Promise<boolean>((resolve) => {
      resolvePendingSetHub = resolve;
    });
    let callIdx = 0;
    const raceSetHubUrl = vi.fn(async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return pendingSetHub;
      }
      return true;
    });
    installDesktopPersonaMock({ setHubUrl: raceSetHubUrl });

    const createPromise = ensureResidentPersonaWebview(hubUrl);
    const disablePromise = disableResidentPersonaWebview();
    resolvePendingSetHub(true);
    const [createdAfterDisable] = await Promise.all([createPromise, disablePromise]);

    expect(createdAfterDisable).toBeNull();
    expect(getResidentPersonaWebview()).toBeNull();
    expect(document.querySelector("webview")).toBeNull();
  });

  it("keeps Electron resident webview alive across present -> 1x1 park -> present, ignores subframe navigations and untrusted IPC, and shows real fail-load errors", async () => {
    const hubUrl = getLoopbackHubUrl();
    installDesktopPersonaMock();

    const webview = await ensureResidentPersonaWebview(hubUrl);
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("partition")).toBe("persist:persona");

    const hostContainer = document.getElementById(PERSONA_RESIDENT_HOST_ID);
    expect(hostContainer?.style.zIndex).toBe("0");

    presentResidentPersonaWebview({ left: 260, top: 40, width: 980, height: 680 });
    const surface = webview?.parentElement;
    expect(surface?.style.left).toBe("260px");
    expect(surface?.style.width).toBe("980px");
    expect(surface?.style.pointerEvents).toBe("auto");
    expect(surface?.getAttribute("aria-hidden")).toBeNull();

    parkResidentPersonaWebview();
    expect(webview?.isConnected).toBe(true);
    expect(surface?.style.width).toBe("1px");
    expect(surface?.style.height).toBe("1px");
    expect(surface?.style.pointerEvents).toBe("none");
    expect(surface?.getAttribute("aria-hidden")).toBe("true");

    const reused = await ensureResidentPersonaWebview(hubUrl);
    expect(reused).toBe(webview);

    const qc = makeQueryClient({ enabled: true, hubUrl });
    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const liveWebview = getResidentPersonaWebview();
    expect(liveWebview).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-in-paseo"]')).toBeNull();

    // Subframe in-page navigation MUST be ignored and must NOT pollute toolbar session actions
    await act(async () => {
      const subNavEvent = new Event("did-navigate-in-page") as Event & {
        url?: string;
        isMainFrame?: boolean;
      };
      subNavEvent.url = `${hubUrl}/s/n37-217-003/paseo-ag_subframe`;
      subNavEvent.isMainFrame = false;
      liveWebview?.dispatchEvent(subNavEvent);
    });
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-in-paseo"]')).toBeNull();

    // Main-frame navigation to /s/:mid/:sid reveals toolbar Open in Paseo + Diff buttons
    await act(async () => {
      const navEvent = new Event("did-navigate-in-page") as Event & {
        url?: string;
        isMainFrame?: boolean;
      };
      navEvent.url = `${hubUrl}/s/n37-217-003/paseo-ag_123`;
      navEvent.isMainFrame = true;
      liveWebview?.dispatchEvent(navEvent);
    });
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-in-paseo"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-diff"]')).not.toBeNull();

    // Direct `<webview>` `ipc-message` (Electron 44 only supplies `frameId: [processId, frameId]`,
    // never `isMainFrame`) MUST NOT be trusted by the renderer, and forged/off-origin desktop events
    // missing real main-process frame context MUST be rejected.
    await act(async () => {
      const directWebviewIpc = new Event("ipc-message") as Event & {
        channel?: string;
        args?: unknown[];
        frameId?: [number, number];
      };
      directWebviewIpc.channel = "paseo:persona:open-session";
      directWebviewIpc.frameId = [10, 1];
      directWebviewIpc.args = [
        {
          machineId: "n37-217-003",
          sessionId: "paseo-ag_123",
          source: "link-click",
          rawHref: `${hubUrl}/s/n37-217-003/paseo-ag_123`,
        },
      ];
      liveWebview?.dispatchEvent(directWebviewIpc);
    });
    expect(mockNavigateToWorkspace).not.toHaveBeenCalled();

    // ERR_ABORTED (-3) must NOT trigger error overlay
    await act(async () => {
      const abortEvent = new Event("did-fail-load") as Event & {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
      };
      abortEvent.errorCode = -3;
      abortEvent.errorDescription = "ERR_ABORTED";
      abortEvent.isMainFrame = true;
      liveWebview?.dispatchEvent(abortEvent);
    });
    expect(hostEl.querySelector('[data-testid="persona-load-error-state"]')).toBeNull();

    // Real connection failure shows recovery overlay
    await act(async () => {
      const failEvent = new Event("did-fail-load") as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      };
      failEvent.errorCode = -102;
      failEvent.errorDescription = "ERR_CONNECTION_REFUSED";
      failEvent.validatedURL = hubUrl;
      failEvent.isMainFrame = true;
      liveWebview?.dispatchEvent(failEvent);
    });
    expect(hostEl.querySelector('[data-testid="persona-load-error-state"]')).not.toBeNull();
    expect(hostEl.textContent).toContain("ERR_CONNECTION_REFUSED");
  });

  it("guest-preload enforces origin gate, eliminates idle MutationObserver churn, and feeds same-origin workspace_id/cwd into real click, toolbar, and window-open L4 fallback", async () => {
    const hubUrl = getLoopbackHubUrl();

    // 1. Origin & main-frame gates: mismatched origin or subframe MUST remain completely inactive
    const inactiveIpcSend = vi.fn();
    const inactiveOriginController = mountPersonaGuestPreload({
      ipc: {
        on: vi.fn(),
        removeListener: vi.fn(),
        send: inactiveIpcSend,
      },
      authorizedHubUrl: "https://other-origin.example.com",
      isMainFrame: () => true,
    });
    expect(inactiveOriginController.isActive()).toBe(false);
    expect(inactiveIpcSend).not.toHaveBeenCalled();
    inactiveOriginController.dispose();

    const inactiveSubframeController = mountPersonaGuestPreload({
      ipc: {
        on: vi.fn(),
        removeListener: vi.fn(),
        send: inactiveIpcSend,
      },
      authorizedHubUrl: hubUrl,
      isMainFrame: () => false,
    });
    expect(inactiveSubframeController.isActive()).toBe(false);
    expect(inactiveIpcSend).not.toHaveBeenCalled();
    inactiveSubframeController.dispose();

    // 2. Mount authorized guest-preload against real Chromium DOM with a header slot and session link
    const guestStage = document.createElement("div");
    guestStage.innerHTML = `
      <main>
        <header>
          <div id="guest-header-slot"></div>
        </header>
        <a id="persona-session-link" href="/__persona-test-hub/s/n37-217-003/unmanaged-cli-session">Open Session</a>
      </main>
    `;
    document.body.appendChild(guestStage);

    // Seed an auth token to verify same-origin metadata fetch uses it without leaking it into IPC
    window.localStorage.setItem("persona.token", "ephemeral-test-token");

    const ws: WorkspaceDescriptor = {
      id: "wks_0123456789abcdef",
      projectId: "proj_1",
      projectDisplayName: "paseo-fork",
      projectRootPath: "/data00/repo/paseo-fork",
      workspaceDirectory: "/data00/repo/paseo-fork",
      projectKind: "git",
      workspaceKind: "checkout",
      name: "main",
      status: "done",
      statusEnteredAt: null,
      archivingAt: null,
      diffStat: null,
      scripts: [],
      createdAt: null,
      lastUserMessageAt: null,
    };
    useSessionStore.setState({
      sessions: {
        srv_devbox: {
          serverId: "srv_devbox",
          client: null,
          clientGeneration: 1,
          viewedTimelineSync: null,
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.533" },
          hasHydratedAgents: true,
          hasHydratedWorkspaces: true,
          hasWorkspaceDirectorySnapshot: true,
          agents: new Map(),
          agentDetails: new Map(),
          workspaces: new Map([[ws.id, ws]]),
          projects: new Map(),
        } as unknown as SessionState,
      },
      agentLastActivity: new Map(),
    });

    const desktopMock = installDesktopPersonaMock();
    const qc = makeQueryClient({ enabled: true, hubUrl });
    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const liveWebview = getResidentPersonaWebview();
    expect(liveWebview).not.toBeNull();

    // Wire a real bidirectional IPC bridge through the actual main-process
    // `registerPersonaWebviewGuestIpcBridge` (`senderFrame === contents.mainFrame` + origin check).
    const guestWebContentsId = 42;
    const guestSessionUrl = `${hubUrl}/s/n37-217-003/unmanaged-cli-session`;
    const mainFrame: PersonaGuestFrameLike = {
      url: guestSessionUrl,
      origin: window.location.origin,
      detached: false,
      parent: null,
      processId: 10,
      routingId: 1,
    };
    Object.assign(mainFrame, { top: mainFrame });
    const subFrame: PersonaGuestFrameLike = {
      url: `${hubUrl}/embedded-subframe`,
      origin: window.location.origin,
      detached: false,
      parent: mainFrame,
      top: mainFrame,
      processId: 10,
      routingId: 2,
    };

    let mainGuestIpcListener:
      | ((event: PersonaGuestIpcMainEventLike, channel: string, ...args: unknown[]) => void)
      | null = null;
    const guestWebContents: PersonaGuestIpcWebContentsLike = {
      id: guestWebContentsId,
      mainFrame,
      isDestroyed: () => false,
      getType: () => "webview",
      getURL: () => guestSessionUrl,
      on(event, listener) {
        if (event === "ipc-message") {
          mainGuestIpcListener = listener;
        }
      },
    };
    registerPersonaWebviewGuestIpcBridge(guestWebContents, {
      getConfiguredHubUrl: () => hubUrl,
      onGuestOpenSession: (payload, context) => {
        desktopMock.emitDesktopEvent("persona-open-session", {
          ...payload,
          guestWebContentsId: context.guestWebContentsId,
          frameUrl: context.frameUrl,
        });
      },
      onGuestSessionMetadataResult: (payload, context) => {
        desktopMock.emitDesktopEvent("persona-session-metadata-result", {
          ...payload,
          guestWebContentsId: context.guestWebContentsId,
          frameUrl: context.frameUrl,
        });
      },
      onGuestReady: (context) => {
        desktopMock.emitDesktopEvent("persona-guest-ready", {
          guestWebContentsId: context.guestWebContentsId,
          frameUrl: context.frameUrl,
        });
      },
    });

    const guestListeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
    const dispatchedToMain: Array<{ channel: string; payload: unknown }> = [];
    const guestIpc: PersonaGuestIpcLike = {
      on(channel, listener) {
        const set = guestListeners.get(channel) ?? new Set();
        set.add(listener);
        guestListeners.set(channel, set);
      },
      removeListener(channel, listener) {
        guestListeners.get(channel)?.delete(listener);
      },
      send(channel, payload) {
        dispatchedToMain.push({ channel, payload });
        mainGuestIpcListener?.(
          {
            sender: guestWebContents,
            senderFrame: mainFrame,
            processId: 10,
            frameId: 1,
          },
          channel,
          payload,
        );
      },
    };
    if (liveWebview) {
      liveWebview.getWebContentsId = () => guestWebContentsId;
      liveWebview.getURL = () => guestSessionUrl;
      liveWebview.send = (channel: string, payload?: unknown) => {
        for (const listener of guestListeners.get(channel) ?? []) {
          listener({}, payload);
        }
      };
    }

    const metadataFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/__persona-test-hub/api/v1/sessions?");
      expect(url).toContain("machine_id=n37-217-003");
      expect(url).toContain("session_id=unmanaged-cli-session");
      expect(init?.credentials).toBe("same-origin");
      return new Response(
        JSON.stringify({
          sessions: [
            {
              machine_id: "n37-217-003",
              session_id: "unmanaged-cli-session",
              workspace_id: ws.id,
              cwd: ws.workspaceDirectory,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const controller = mountPersonaGuestPreload({
      ipc: guestIpc,
      authorizedHubUrl: hubUrl,
      fetchFn: metadataFetch as unknown as typeof fetch,
      isMainFrame: () => true,
    });
    expect(controller.isActive()).toBe(true);

    try {
      // Sync guest to the active session route so header buttons inject once
      for (const listener of guestListeners.get("paseo:persona:route-sync") ?? []) {
        listener({}, { url: `${hubUrl}/s/n37-217-003/unmanaged-cli-session` });
      }
      controller.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 40));

      const slot = guestStage.querySelector("#guest-header-slot") as HTMLElement;
      expect(slot.querySelector('[data-paseo-injected="open-actions"]')).not.toBeNull();

      // P2-1 regression: observe header slot on an idle session page across multiple rAF ticks -> 0 mutations!
      let idleMutations = 0;
      const idleObserver = new MutationObserver((records) => {
        idleMutations += records.length;
      });
      idleObserver.observe(slot, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Trigger redundant syncs with identical config to verify strict diff-before-write
      controller.syncNow();
      controller.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(idleMutations).toBe(0);

      // Updating a label performs a single clean write and then returns to 0 idle churn
      for (const listener of guestListeners.get("paseo:persona:config") ?? []) {
        listener(
          {},
          {
            labels: {
              openInPaseo: "在 Paseo 打开",
              openDiffInPaseo: "Diff",
              openInPaseoTooltip: "打开会话",
              openDiffTooltip: "打开 Diff",
            },
          },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const afterLabelUpdate = idleMutations;
      expect(afterLabelUpdate).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(idleMutations).toBe(afterLabelUpdate);
      idleObserver.disconnect();

      // P2-5 regression: subframe IPC on both open-session and metadata-result MUST be blocked by
      // main-process `senderFrame === contents.mainFrame` verification, and direct Electron 44
      // `<webview>` `ipc-message` events (with `frameId: [10, 2]`, no `isMainFrame`) MUST be ignored.
      mockNavigateToWorkspace.mockClear();
      await act(async () => {
        mainGuestIpcListener?.(
          {
            sender: guestWebContents,
            senderFrame: subFrame,
            processId: 10,
            frameId: 2,
          },
          "paseo:persona:open-session",
          {
            machineId: "n37-217-003",
            sessionId: "unmanaged-cli-session",
            workspaceIdHint: ws.id,
            cwdHint: ws.workspaceDirectory,
            source: "link-click",
            rawHref: guestSessionUrl,
          },
        );
        const directSubframeEvent = new Event("ipc-message") as Event & {
          channel?: string;
          args?: unknown[];
          frameId?: [number, number];
        };
        directSubframeEvent.channel = "paseo:persona:open-session";
        directSubframeEvent.frameId = [10, 2];
        directSubframeEvent.args = [
          {
            machineId: "n37-217-003",
            sessionId: "unmanaged-cli-session",
            workspaceIdHint: ws.id,
            source: "link-click",
            rawHref: guestSessionUrl,
          },
        ];
        liveWebview?.dispatchEvent(directSubframeEvent);
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      expect(mockNavigateToWorkspace).not.toHaveBeenCalled();

      // P1-5 flow 1: real DOM click on <a href="/s/..."> carries workspace_id/cwd through main-process
      // verified forwarding into L4 workspace fallback
      const sessionLink = guestStage.querySelector("#persona-session-link") as HTMLAnchorElement;
      await act(async () => {
        sessionLink.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const clickMessage = dispatchedToMain.find(
        (entry) => entry.channel === "paseo:persona:open-session",
      );
      expect(clickMessage?.payload).toMatchObject({
        machineId: "n37-217-003",
        sessionId: "unmanaged-cli-session",
        workspaceIdHint: ws.id,
        cwdHint: ws.workspaceDirectory,
        source: "link-click",
      });
      // Auth token must NEVER appear in IPC payload
      expect(JSON.stringify(clickMessage?.payload)).not.toContain("ephemeral-test-token");
      expect(mockNavigateToWorkspace).toHaveBeenCalledWith({
        serverId: "srv_devbox",
        workspaceId: ws.id,
        target: undefined,
      });

      // P1-5 flow 2: toolbar Open in Paseo button resolves L4 via main-process verified guest metadata lookup,
      // while rejecting forged subframe metadata replies and direct `<webview>` `ipc-message` replies.
      mockNavigateToWorkspace.mockClear();
      const originalWebviewSend = liveWebview?.send;
      if (liveWebview && originalWebviewSend) {
        liveWebview.send = (channel: string, payload?: unknown) => {
          if (
            channel === "paseo:persona:lookup-session-metadata" &&
            payload &&
            typeof payload === "object"
          ) {
            const req = payload as { requestId?: string; machineId?: string; sessionId?: string };
            // Attempt 1: subframe sends forged metadata through main-process guest IPC -> dropped
            mainGuestIpcListener?.(
              {
                sender: guestWebContents,
                senderFrame: subFrame,
                processId: 10,
                frameId: 2,
              },
              "paseo:persona:session-metadata-result",
              {
                requestId: req.requestId,
                machineId: req.machineId,
                sessionId: req.sessionId,
                workspaceIdHint: "wks_0000000000000000",
                cwdHint: "/evil/subframe",
              },
            );
            // Attempt 2: direct `<webview>` Electron 44 `ipc-message` (no `isMainFrame`) -> ignored
            const forgedDirectReply = new Event("ipc-message") as Event & {
              channel?: string;
              args?: unknown[];
              frameId?: [number, number];
            };
            forgedDirectReply.channel = "paseo:persona:session-metadata-result";
            forgedDirectReply.frameId = [10, 2];
            forgedDirectReply.args = [
              {
                requestId: req.requestId,
                machineId: req.machineId,
                sessionId: req.sessionId,
                workspaceIdHint: "wks_0000000000000000",
                cwdHint: "/evil/direct-webview",
              },
            ];
            liveWebview.dispatchEvent(forgedDirectReply);
          }
          originalWebviewSend(channel, payload);
        };
      }
      await act(async () => {
        const navEvent = new Event("did-navigate-in-page") as Event & {
          url?: string;
          isMainFrame?: boolean;
        };
        navEvent.url = guestSessionUrl;
        navEvent.isMainFrame = true;
        liveWebview?.dispatchEvent(navEvent);
      });
      const toolbarOpenBtn = hostEl.querySelector(
        '[data-testid="persona-toolbar-open-in-paseo"]',
      ) as HTMLElement | null;
      expect(toolbarOpenBtn).not.toBeNull();
      await act(async () => {
        toolbarOpenBtn?.click();
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(mockNavigateToWorkspace).toHaveBeenCalledWith({
        serverId: "srv_devbox",
        workspaceId: ws.id,
        target: undefined,
      });
      if (liveWebview && originalWebviewSend) {
        liveWebview.send = originalWebviewSend;
      }

      // P1-5 flow 3: main-process window-open event enriches metadata via main-process verified guest lookup
      mockNavigateToWorkspace.mockClear();
      await act(async () => {
        desktopMock.emitDesktopEvent("persona-open-session", {
          machineId: "n37-217-003",
          sessionId: "unmanaged-cli-session",
          source: "window-open",
          rawHref: guestSessionUrl,
          guestWebContentsId,
          frameUrl: guestSessionUrl,
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
      expect(mockNavigateToWorkspace).toHaveBeenCalledWith({
        serverId: "srv_devbox",
        workspaceId: ws.id,
        target: undefined,
      });
    } finally {
      controller.dispose();
      guestStage.remove();
    }
  });

  it("renders single-Hub hero cleanly and supports multi-Hub sidebar expand/collapse, instant switch, and one-click right split", async () => {
    const hubAUrl = `${window.location.origin}/__persona-hub-a`;
    const hubBUrl = `${window.location.origin}/__persona-hub-b`;
    const hubCUrl = `${window.location.origin}/__persona-hub-c`;

    // 1. Single Hub stays a clean single row without expand toggle or sub-list
    const singleQc = makeQueryClient({ enabled: true, hubUrl: hubAUrl });
    await renderInBrowser(singleQc, <PersonaHeroRow />);
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hero"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-expand-toggle"]')).toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-list"]')).toBeNull();

    // 2. Multi-Hub starts collapsed with expand toggle and active Hub summary
    const multiQc = makeQueryClient({
      enabled: true,
      hubs: [
        { id: "hub-a", name: "Work Hub", hubUrl: hubAUrl, machineServerMap: {} },
        { id: "hub-b", name: "Home Hub", hubUrl: hubBUrl, machineServerMap: {} },
        { id: "hub-c", name: "Lab Hub", hubUrl: hubCUrl, machineServerMap: {} },
      ],
      activeHubId: "hub-a",
      splitEnabled: false,
      secondaryHubId: null,
      sidebarExpanded: false,
    });
    await renderInBrowser(multiQc, <PersonaHeroRow />);
    expect(hostEl.querySelector('[data-testid="sidebar-persona-expand-toggle"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-list"]')).toBeNull();
    expect(hostEl.textContent).toContain("Work Hub");

    // Expand Hub list -> vertical sub-rows show all Hubs with short names & hosts
    const expandBtn = hostEl.querySelector(
      '[data-testid="sidebar-persona-expand-toggle"]',
    ) as HTMLElement | null;
    await act(async () => {
      expandBtn?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-list"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-row-hub-a"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-row-hub-b"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-row-hub-c"]')).not.toBeNull();

    // Click Hub B sub-row -> switches activeHubId immediately
    const selectB = hostEl.querySelector(
      '[data-testid="sidebar-persona-hub-select-hub-b"]',
    ) as HTMLElement | null;
    await act(async () => {
      selectB?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(multiQc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.activeHubId).toBe(
      "hub-b",
    );

    // One-click add Hub C to right split pane
    const splitC = hostEl.querySelector(
      '[data-testid="sidebar-persona-hub-split-hub-c"]',
    ) as HTMLElement | null;
    expect(splitC).not.toBeNull();
    await act(async () => {
      splitC?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const afterSplit = multiQc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona;
    expect(afterSplit?.splitEnabled).toBe(true);
    expect(afterSplit?.activeHubId).toBe("hub-b");
    expect(afterSplit?.secondaryHubId).toBe("hub-c");
    expect(hostEl.querySelector('[data-testid="sidebar-persona-split-badge"]')).not.toBeNull();

    // Collapse back -> hides sub-rows while displaying split summary & split badge
    await act(async () => {
      (
        hostEl.querySelector('[data-testid="sidebar-persona-expand-toggle"]') as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hub-list"]')).toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-split-badge"]')).not.toBeNull();
    expect(hostEl.textContent).toContain("Home Hub · Lab Hub");
  });

  async function clickTestId(rootNode: ParentNode, testId: string, delayMs = 30): Promise<void> {
    await act(async () => {
      (rootNode.querySelector(`[data-testid="${testId}"]`) as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    });
  }

  async function dragSplitDivider(
    divider: HTMLElement,
    surfaceRect: DOMRect,
    fromRatio: number,
    toRatio: number,
    onMidDrag: () => void,
  ): Promise<void> {
    await act(async () => {
      divider.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: surfaceRect.left + surfaceRect.width * fromRatio,
          pointerId: 1,
        }),
      );
    });
    onMidDrag();
    await act(async () => {
      const targetX = surfaceRect.left + surfaceRect.width * toRatio;
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: targetX,
          pointerId: 1,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: targetX,
          pointerId: 1,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  async function resizeHostViewport(widthPx: number): Promise<void> {
    await act(async () => {
      hostEl.style.width = `${widthPx}px`;
      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  }

  function attachPersonaConfigSpy(
    hubId: string,
    webContentsId: number,
    sentConfigsByHub: Map<string, Array<Record<string, unknown>>>,
  ) {
    const wv = getResidentPersonaWebview(hubId)!;
    wv.getWebContentsId = () => webContentsId;
    wv.getURL = () => wv.src;
    wv.send = vi.fn((channel: string, payload?: unknown) => {
      if (channel !== "paseo:persona:config" || !payload || typeof payload !== "object") {
        return;
      }
      const list = sentConfigsByHub.get(hubId) ?? [];
      list.push(payload as Record<string, unknown>);
      sentConfigsByHub.set(hubId, list);
    });
    return wv;
  }

  async function setActiveHubInCache(qc: QueryClient, hubId: string): Promise<void> {
    const updateActive = (prev: AppSettings | undefined): AppSettings | undefined =>
      prev
        ? {
            ...prev,
            persona: normalizePersonaEmbedSettings({ ...prev.persona, activeHubId: hubId }),
          }
        : prev;
    await act(async () => {
      qc.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, updateActive);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }

  function readPersistedPersona(qc: QueryClient) {
    return qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)!.persona;
  }

  it("keeps multi-Hub resident webviews alive across switches and supports split drag, compaction, narrow fallback, and swap/close", async () => {
    const hubAUrl = `${window.location.origin}/__persona-split-a`;
    const hubBUrl = `${window.location.origin}/__persona-split-b`;
    hostEl.style.width = "1120px";
    hostEl.style.height = "720px";
    hostEl.style.display = "flex";

    installDesktopPersonaMock();
    const sentConfigsByHub = new Map<string, Array<Record<string, unknown>>>();

    const qc = makeQueryClient({
      enabled: true,
      hidePersonaSidebar: false,
      hubs: [
        { id: "hub-a", name: "Hub A", hubUrl: hubAUrl, machineServerMap: {} },
        { id: "hub-b", name: "Hub B", hubUrl: hubBUrl, machineServerMap: {} },
      ],
      activeHubId: "hub-a",
      splitEnabled: false,
      secondaryHubId: null,
      splitRatio: 0.5,
    });

    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const webviewA = attachPersonaConfigSpy("hub-a", 701, sentConfigsByHub);
    expect(webviewA.parentElement?.getAttribute("aria-hidden")).toBeNull();

    // Switch to Hub B via primary pane Hub switcher -> Hub A parks at 1x1 without unmounting
    await clickTestId(hostEl, "persona-pane-primary-hub-switcher", 20);
    await clickTestId(document, "persona-pane-primary-hub-option-hub-b", 40);

    const webviewB = attachPersonaConfigSpy("hub-b", 702, sentConfigsByHub);
    expect(webviewA.isConnected).toBe(true);
    expect(webviewA.parentElement?.style.width).toBe("1px");
    expect(webviewA.parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(webviewB.parentElement?.getAttribute("aria-hidden")).toBeNull();

    // Switch back to Hub A -> reuses exact same DOM node (0ms keep-alive)
    await setActiveHubInCache(qc, "hub-a");
    expect(getResidentPersonaWebview("hub-a")).toBe(webviewA);
    expect(webviewA.parentElement?.getAttribute("aria-hidden")).toBeNull();
    expect(webviewB.parentElement?.style.width).toBe("1px");

    // Toggle split view -> mounts both panes side-by-side and auto-compacts Persona sidebar
    await clickTestId(hostEl, "persona-toolbar-toggle-split", 50);
    expect(hostEl.querySelector('[data-testid="persona-pane-primary"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-pane-secondary"]')).not.toBeNull();
    expect(sentConfigsByHub.get("hub-a")?.at(-1)?.hidePersonaSidebar).toBe(true);
    expect(sentConfigsByHub.get("hub-b")?.at(-1)?.hidePersonaSidebar).toBe(true);

    // Draggable split divider disables webview pointer-events during drag & persists clamped ratio
    const divider = document.querySelector('[data-testid="persona-split-divider"]') as HTMLElement;
    expect(divider).not.toBeNull();
    await dragSplitDivider(divider, hostEl.getBoundingClientRect(), 0.5, 0.65, () => {
      expect(document.querySelector('[data-testid="persona-split-drag-shield"]')).not.toBeNull();
      expect(webviewA.parentElement?.style.pointerEvents).toBe("none");
      expect(webviewB.parentElement?.style.pointerEvents).toBe("none");
    });
    expect(document.querySelector('[data-testid="persona-split-drag-shield"]')).toBeNull();
    expect(webviewA.parentElement?.style.pointerEvents).toBe("auto");
    expect(webviewB.parentElement?.style.pointerEvents).toBe("auto");
    expect(readPersistedPersona(qc).splitRatio).toBeGreaterThan(0.6);

    // Narrow viewport auto-falls back to single pane without clobbering persisted splitEnabled
    await resizeHostViewport(740);
    expect(hostEl.querySelector('[data-testid="persona-pane-secondary"]')).toBeNull();
    expect(webviewB.parentElement?.style.width).toBe("1px");
    expect(readPersistedPersona(qc).splitEnabled).toBe(true);

    // Widening restores split, swap panes, and close primary pane promotes secondary & restores sidebar
    await resizeHostViewport(1120);
    expect(hostEl.querySelector('[data-testid="persona-pane-secondary"]')).not.toBeNull();

    await clickTestId(hostEl, "persona-pane-secondary-swap");
    expect(readPersistedPersona(qc).activeHubId).toBe("hub-b");

    await clickTestId(hostEl, "persona-pane-primary-close-split");
    expect(hostEl.querySelector('[data-testid="persona-pane-secondary"]')).toBeNull();
    expect(readPersistedPersona(qc).splitEnabled).toBe(false);
    expect(readPersistedPersona(qc).activeHubId).toBe("hub-a");
    expect(sentConfigsByHub.get("hub-a")?.at(-1)?.hidePersonaSidebar).toBe(false);
  });

  it("routes multi-Hub guest IPC session lookups strictly by guestWebContentsId and rejects cross-Hub spoofs", async () => {
    const hubAUrl = `${window.location.origin}/__persona-route-a`;
    const hubBUrl = `${window.location.origin}/__persona-route-b`;
    hostEl.style.width = "1120px";
    hostEl.style.height = "720px";
    hostEl.style.display = "flex";

    const desktopMock = installDesktopPersonaMock();
    const wsA = {
      id: "wks_aaaaaaaaaaaaaaaa",
      projectKey: "proj-a",
      workspaceDirectory: "/repo/work",
      name: "Work Repo",
      cwd: "/repo/work",
      status: "ready",
      agentIds: [],
      isArchived: false,
      createdAt: new Date("2026-11-26T00:00:00.000Z"),
    } as unknown as WorkspaceDescriptor;
    const wsB = {
      id: "wks_bbbbbbbbbbbbbbbb",
      projectKey: "proj-b",
      workspaceDirectory: "/repo/home",
      name: "Home Repo",
      cwd: "/repo/home",
      status: "ready",
      agentIds: [],
      isArchived: false,
      createdAt: new Date("2026-11-26T00:00:00.000Z"),
    } as unknown as WorkspaceDescriptor;
    useSessionStore.setState({
      sessions: {
        srv_devbox: {
          serverId: "srv_devbox",
          client: null,
          clientGeneration: 1,
          viewedTimelineSync: null,
          serverInfo: { serverId: "srv_devbox", hostname: "host-a", version: "0.17.535" },
          hasHydratedAgents: true,
          hasHydratedWorkspaces: true,
          hasWorkspaceDirectorySnapshot: true,
          agents: new Map(),
          agentDetails: new Map(),
          workspaces: new Map([[wsA.id, wsA]]),
          projects: new Map(),
        } as unknown as SessionState,
        srv_mac: {
          serverId: "srv_mac",
          client: null,
          clientGeneration: 1,
          viewedTimelineSync: null,
          serverInfo: { serverId: "srv_mac", hostname: "host-b", version: "0.17.535" },
          hasHydratedAgents: true,
          hasHydratedWorkspaces: true,
          hasWorkspaceDirectorySnapshot: true,
          agents: new Map(),
          agentDetails: new Map(),
          workspaces: new Map([[wsB.id, wsB]]),
          projects: new Map(),
        } as unknown as SessionState,
      },
      agentLastActivity: new Map(),
    });

    const qc = makeQueryClient({
      enabled: true,
      hubs: [
        {
          id: "hub-a",
          name: "Hub A",
          hubUrl: hubAUrl,
          machineServerMap: { "shared-box": "srv_devbox" },
        },
        {
          id: "hub-b",
          name: "Hub B",
          hubUrl: hubBUrl,
          machineServerMap: { "shared-box": "srv_mac" },
        },
      ],
      activeHubId: "hub-a",
      splitEnabled: true,
      secondaryHubId: "hub-b",
    });

    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const webviewA = getResidentPersonaWebview("hub-a")!;
    const webviewB = getResidentPersonaWebview("hub-b")!;
    webviewA.getWebContentsId = () => 701;
    webviewA.getURL = () => webviewA.src;
    webviewB.getWebContentsId = () => 702;
    webviewB.getURL = () => webviewB.src;

    mockNavigateToWorkspace.mockClear();
    await act(async () => {
      desktopMock.emitDesktopEvent("persona-open-session", {
        machineId: "shared-box",
        sessionId: "sess-only-in-hub-a",
        workspaceIdHint: wsA.id,
        source: "link-click",
        rawHref: `${hubAUrl}/s/shared-box/sess-only-in-hub-a`,
        guestWebContentsId: 701,
        frameUrl: `${hubAUrl}/s/shared-box/sess-only-in-hub-a`,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(mockNavigateToWorkspace).toHaveBeenCalledWith({
      serverId: "srv_devbox",
      workspaceId: wsA.id,
      target: undefined,
    });

    mockNavigateToWorkspace.mockClear();
    await act(async () => {
      desktopMock.emitDesktopEvent("persona-open-session", {
        machineId: "shared-box",
        sessionId: "sess-only-in-hub-b",
        workspaceIdHint: wsB.id,
        source: "link-click",
        rawHref: `${hubBUrl}/s/shared-box/sess-only-in-hub-b`,
        guestWebContentsId: 702,
        frameUrl: `${hubBUrl}/s/shared-box/sess-only-in-hub-b`,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(mockNavigateToWorkspace).toHaveBeenCalledWith({
      serverId: "srv_mac",
      workspaceId: wsB.id,
      target: undefined,
    });

    // Cross-Hub spoof (Hub A guestWebContentsId 701 claiming Hub B frameUrl) fails closed
    mockNavigateToWorkspace.mockClear();
    await act(async () => {
      desktopMock.emitDesktopEvent("persona-open-session", {
        machineId: "shared-box",
        sessionId: "sess-spoof",
        workspaceIdHint: wsB.id,
        source: "link-click",
        rawHref: `${hubBUrl}/s/shared-box/sess-spoof`,
        guestWebContentsId: 701,
        frameUrl: `${hubBUrl}/s/shared-box/sess-spoof`,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(mockNavigateToWorkspace).not.toHaveBeenCalled();
  });

  it("manages multiple Hubs in Settings (add, reorder, per-Hub health check & clear session, isolated mappings) and switches Hubs in Web fallback", async () => {
    const hubAUrl = `${window.location.origin}/__persona-settings-a`;
    const hubBUrl = `${window.location.origin}/__persona-settings-b`;

    const desktopMock = installDesktopPersonaMock({
      checkHealth: vi.fn(async (targetUrl?: string) => ({
        ok: true as const,
        hubName: targetUrl === hubBUrl ? "hub-b-live" : "hub-a-live",
        version: "1.2.3",
        latencyMs: 6,
      })),
    });

    const qc = makeQueryClient({
      enabled: true,
      hubs: [
        {
          id: DEFAULT_PERSONA_HUB_ID,
          name: "Work Hub",
          hubUrl: hubAUrl,
          machineServerMap: { "box-a": "srv_devbox" },
        },
        {
          id: "hub-b",
          name: "Home Hub",
          hubUrl: hubBUrl,
          machineServerMap: { "box-b": "srv_mac" },
        },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
    });

    await renderInBrowser(qc, <PersonaSettingsSection />);
    expect(hostEl.querySelector('[data-testid="persona-mapping-row-box-a"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-mapping-row-box-b"]')).toBeNull();

    // Select Hub B in list -> shows ONLY Hub B's mapping and runs isolated health check & session clear
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-hub-select-hub-b"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="persona-mapping-row-box-b"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-mapping-row-box-a"]')).toBeNull();

    // Health check probes ONLY Hub B's URL
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-test-connection"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(desktopMock.checkHealth).toHaveBeenCalledWith(hubBUrl);
    expect(hostEl.textContent).toContain("hub-b-live");

    // Per-Hub clear session targets ONLY Hub B's isolated partition & URL
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-clear-hub-session"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(desktopMock.clearSession).toHaveBeenCalledWith({
      partition: "persist:persona-hub-b",
      hubUrl: hubBUrl,
    });

    // Move Hub B up -> reorders list to [hub-b, hub-default]
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-hub-move-up-hub-b"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.hubs.map((h) => h.id),
    ).toEqual(["hub-b", DEFAULT_PERSONA_HUB_ID]);

    // Add Hub form: rejects credentialed URL, then adds valid Hub C and deletes it cleanly
    const setInputValue = (testId: string, value: string) => {
      const input = hostEl.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => {
      (
        hostEl.querySelector('[data-testid="persona-settings-add-hub"]') as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      setInputValue("persona-settings-new-hub-name", "Creds Hub");
      setInputValue("persona-settings-new-hub-url", "http://user:pass@127.0.0.1:18669");
    });
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-new-hub-submit"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="persona-settings-new-hub-error"]')).not.toBeNull();
    expect(qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.hubs).toHaveLength(2);

    const hubCUrl = `${window.location.origin}/__persona-settings-c`;
    await act(async () => {
      setInputValue("persona-settings-new-hub-name", "Lab Hub");
      setInputValue("persona-settings-new-hub-url", hubCUrl);
    });
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-new-hub-submit"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const hubsAfterAdd = qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.hubs ?? [];
    expect(hubsAfterAdd).toHaveLength(3);
    const addedHubC = hubsAfterAdd.find((h) => h.hubUrl === hubCUrl);
    expect(addedHubC?.name).toBe("Lab Hub");

    // Delete Hub C via confirm dialog -> returns to 2 Hubs cleanly
    await act(async () => {
      (
        hostEl.querySelector(
          `[data-testid="persona-settings-hub-delete-${addedHubC?.id}"]`,
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.hubs).toHaveLength(2);

    // Web fallback switcher switches active Hub cleanly
    delete window.paseoDesktop;
    await renderInBrowser(qc, <PersonaSurface pageProtocolOverride="http:" />);
    expect(hostEl.querySelector('[data-testid="persona-web-hub-switcher"]')).not.toBeNull();
    await act(async () => {
      (
        hostEl.querySelector('[data-testid="persona-web-hub-option-hub-b"]') as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.activeHubId).toBe("hub-b");
    expect(hostEl.textContent).toContain(hubBUrl);
  });

  it("P1-3: visits Hub A, edits Hub A URL, and returns to Persona without mountRejected race (both via Settings and via unpruned cache update)", async () => {
    const urlV1 = `${window.location.origin}/__persona-url-v1`;
    const urlV2 = `${window.location.origin}/__persona-url-v2`;
    const urlV3 = `${window.location.origin}/__persona-url-v3`;
    hostEl.style.width = "1024px";
    hostEl.style.height = "720px";
    hostEl.style.display = "flex";

    installDesktopPersonaMock();

    const qc = makeQueryClient({
      enabled: true,
      hubs: [
        {
          id: DEFAULT_PERSONA_HUB_ID,
          name: "Primary Hub",
          hubUrl: urlV1,
          machineServerMap: {},
        },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
    });

    // Step 1: Visit /persona -> Hub A mounts at urlV1
    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const webviewV1 = getResidentPersonaWebview(DEFAULT_PERSONA_HUB_ID);
    expect(webviewV1).not.toBeNull();
    expect(webviewV1?.src).toBe(urlV1);
    expect(webviewV1?.getAttribute("partition")).toBe(PERSONA_WEBVIEW_PARTITION);
    expect(hostEl.querySelector('[data-testid="persona-mount-rejected-state"]')).toBeNull();

    // Step 2: Navigate to Settings -> edit Hub A URL to urlV2 and save
    await renderInBrowser(qc, <PersonaSettingsSection />);
    const urlInput = hostEl.querySelector(
      '[data-testid="persona-settings-hub-url-input"]',
    ) as HTMLInputElement | null;
    expect(urlInput).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(urlInput, urlV2);
      urlInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (
        hostEl.querySelector('[data-testid="persona-settings-save-url"]') as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.hubs[0]?.hubUrl).toBe(
      urlV2,
    );

    // Step 3: Return to /persona -> mounts cleanly at urlV2 without mountRejected
    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const webviewV2 = getResidentPersonaWebview(DEFAULT_PERSONA_HUB_ID);
    expect(webviewV2).not.toBeNull();
    expect(webviewV2?.src).toBe(urlV2);
    expect(hostEl.querySelector('[data-testid="persona-mount-rejected-state"]')).toBeNull();

    // Step 4: Hard race check — leave Persona (so urlV2 stays parked in residentPoolByHubId),
    // mutate Hub A's URL directly to urlV3 WITHOUT calling destroyResidentPersonaWebview,
    // and verify an in-flight ensureResidentPersonaWebview for urlV3 is NOT canceled by
    // reconcileResidentPersonaWebviews when returning to Persona!
    await renderInBrowser(qc, <div data-testid="away-route" />);
    expect(getResidentPersonaWebview(DEFAULT_PERSONA_HUB_ID)?.src).toBe(urlV2);

    const deferredSync: { resolve: ((ok: boolean) => void) | null } = { resolve: null };
    installDesktopPersonaMock({
      setHubEntries: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            deferredSync.resolve = resolve;
          }),
      ),
    });

    // Directly exercise module-level race: start in-flight ensure for urlV3 while urlV2 is still in pool,
    // then immediately invoke reconcileResidentPersonaWebviews([{ id, hubUrl: urlV3 }]) mid-flight!
    const inFlightMount = ensureResidentPersonaWebview({
      hubId: DEFAULT_PERSONA_HUB_ID,
      hubUrl: urlV3,
      allowedHubEntries: [{ partition: PERSONA_WEBVIEW_PARTITION, hubUrl: urlV3 }],
    });
    reconcileResidentPersonaWebviews([{ id: DEFAULT_PERSONA_HUB_ID, hubUrl: urlV3 }]);
    // Stale urlV2 DOM was pruned immediately, while the in-flight urlV3 mount stays alive
    expect(getResidentPersonaWebview(DEFAULT_PERSONA_HUB_ID)).toBeNull();
    expect(getResidentPersonaPoolDiagnostics().inFlightHubIds).toEqual([DEFAULT_PERSONA_HUB_ID]);
    // Yield a macrotask so hubSyncQueue invokes setHubEntries and binds deferredSync.resolve
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deferredSync.resolve).not.toBeNull();
    deferredSync.resolve?.(true);
    const webviewV3 = await inFlightMount;
    expect(webviewV3).not.toBeNull();
    expect(webviewV3?.src).toBe(urlV3);
    expect(getResidentPersonaPoolDiagnostics().inFlightHubIds).toEqual([]);

    // Now re-mount ElectronPersonaSurface with urlV3 in QueryClient cache (even if old entry was parked)
    installDesktopPersonaMock();
    qc.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      persona: normalizePersonaEmbedSettings({
        enabled: true,
        hubs: [
          {
            id: DEFAULT_PERSONA_HUB_ID,
            name: "Primary Hub",
            hubUrl: `${window.location.origin}/__persona-url-v4`,
            machineServerMap: {},
          },
        ],
        activeHubId: DEFAULT_PERSONA_HUB_ID,
      }),
    });
    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(getResidentPersonaWebview(DEFAULT_PERSONA_HUB_ID)?.src).toBe(
      `${window.location.origin}/__persona-url-v4`,
    );
    expect(hostEl.querySelector('[data-testid="persona-mount-rejected-state"]')).toBeNull();
  });

  it("P1-4 & P2-1: keeps divider body hit-testing 100% above webviews at 940px/25%, completes real coordinate drag, and keeps narrow (~234px) toolbar buttons strictly inside pane bounds", async () => {
    await page.viewport(1280, 800);
    const hubAUrl = `${window.location.origin}/__persona-split-940-a`;
    const hubBUrl = `${window.location.origin}/__persona-split-940-b`;
    hostEl.style.width = "940px";
    hostEl.style.height = "720px";
    hostEl.style.display = "flex";

    installDesktopPersonaMock();

    const qc = makeQueryClient({
      enabled: true,
      hubs: [
        {
          id: DEFAULT_PERSONA_HUB_ID,
          name: "Enterprise Production DevBox Hub Long Name",
          hubUrl: hubAUrl,
          machineServerMap: {},
        },
        {
          id: "hub-b",
          name: "Home Workstation Secondary Hub",
          hubUrl: hubBUrl,
          machineServerMap: {},
        },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
      splitEnabled: true,
      secondaryHubId: "hub-b",
      splitRatio: 0.25,
    });

    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    const webviewA = getResidentPersonaWebview(DEFAULT_PERSONA_HUB_ID)!;
    const webviewB = getResidentPersonaWebview("hub-b")!;
    expect(webviewA).not.toBeNull();
    expect(webviewB).not.toBeNull();
    // Per-Hub persistent partitions: hub-default -> persist:persona, hub-b -> persist:persona-hub-b
    expect(webviewA.getAttribute("partition")).toBe(PERSONA_WEBVIEW_PARTITION);
    expect(webviewB.getAttribute("partition")).toBe("persist:persona-hub-b");

    // Simulate active session route on left pane so session-action buttons are also exercised under ~234px width
    await act(async () => {
      const navEvent = new Event("did-navigate") as Event & { url?: string; isMainFrame?: boolean };
      navEvent.url = `${hubAUrl}/s/n37-217-003/paseo-ag_narrow`;
      navEvent.isMainFrame = true;
      webviewA.dispatchEvent(navEvent);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const primaryPane = hostEl.querySelector('[data-testid="persona-pane-primary"]') as HTMLElement;
    const primaryToolbar = hostEl.querySelector(
      '[data-testid="persona-pane-primary-toolbar"]',
    ) as HTMLElement;
    const paneRect = primaryPane.getBoundingClientRect();
    const toolbarRect = primaryToolbar.getBoundingClientRect();
    expect(paneRect.width).toBeGreaterThanOrEqual(230);
    expect(paneRect.width).toBeLessThanOrEqual(240);

    // P2-1: EVERY visible button inside the narrow (~234px) toolbar MUST satisfy right <= paneRect.right
    const toolbarButtons = Array.from(
      primaryToolbar.querySelectorAll<HTMLElement>('[role="button"], button'),
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    expect(toolbarButtons.length).toBeGreaterThanOrEqual(4);
    for (const btn of toolbarButtons) {
      const btnRect = btn.getBoundingClientRect();
      expect(
        btnRect.left,
        `button ${btn.getAttribute("data-testid") ?? btn.getAttribute("aria-label")} left overflow`,
      ).toBeGreaterThanOrEqual(paneRect.left - 0.5);
      expect(
        btnRect.right,
        `button ${btn.getAttribute("data-testid") ?? btn.getAttribute("aria-label")} right overflow`,
      ).toBeLessThanOrEqual(paneRect.right + 0.01);
    }

    // Overflow menu exposes collapsed actions cleanly without clipping
    const moreBtn = primaryToolbar.querySelector(
      '[data-testid="persona-pane-primary-more-actions"]',
    ) as HTMLElement | null;
    expect(moreBtn).not.toBeNull();
    await act(async () => {
      moreBtn?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(
      document.querySelector('[data-testid="persona-pane-primary-more-open-in-paseo"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-testid="persona-pane-primary-more-home"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="persona-pane-primary-more-settings"]'),
    ).not.toBeNull();
    // Close overflow menu before divider hit-testing
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // P1-4: Verify divider sits in #overlay-root strictly above WEB_SURFACE_PLANE.browser and
    // neither webview surface overlaps the divider hit zone
    const overlayRoot = document.getElementById("overlay-root")!;
    const residentHost = document.getElementById(PERSONA_RESIDENT_HOST_ID)!;
    expect(overlayRoot).not.toBeNull();
    expect(residentHost).not.toBeNull();
    expect(Number(window.getComputedStyle(overlayRoot).zIndex)).toBeGreaterThan(
      WEB_SURFACE_PLANE.browser,
    );
    expect(Number(window.getComputedStyle(residentHost).zIndex)).toBe(WEB_SURFACE_PLANE.browser);

    const divider = document.querySelector('[data-testid="persona-split-divider"]') as HTMLElement;
    expect(divider).not.toBeNull();
    expect(overlayRoot.contains(divider)).toBe(true);

    const dividerRect = divider.getBoundingClientRect();
    const leftSurfaceRect = webviewA.parentElement!.getBoundingClientRect();
    const rightSurfaceRect = webviewB.parentElement!.getBoundingClientRect();
    expect(leftSurfaceRect.right).toBeLessThanOrEqual(dividerRect.left);
    expect(rightSurfaceRect.left).toBeGreaterThanOrEqual(dividerRect.right);

    // Pixel-by-pixel elementFromPoint sweep across the ENTIRE body zone of the divider
    const bodyTop = Math.ceil(toolbarRect.bottom) + 2;
    const bodyBottom = Math.floor(dividerRect.bottom) - 2;
    const sampleYs = [
      bodyTop,
      Math.round(bodyTop + (bodyBottom - bodyTop) * 0.25),
      Math.round(bodyTop + (bodyBottom - bodyTop) * 0.5),
      Math.round(bodyTop + (bodyBottom - bodyTop) * 0.75),
      bodyBottom,
    ];
    const minX = Math.ceil(dividerRect.left);
    const maxX = Math.floor(dividerRect.right) - 1;
    expect(maxX - minX + 1).toBeGreaterThanOrEqual(9);
    for (const y of sampleYs) {
      for (let x = minX; x <= maxX; x += 1) {
        const hit = document.elementFromPoint(x, y);
        expect(hit, `elementFromPoint(${x}, ${y}) must hit split divider, not webview`).toBe(
          divider,
        );
      }
    }
    const centerX = Math.floor((dividerRect.left + dividerRect.right) / 2);
    for (let y = bodyTop; y <= bodyBottom; y += 12) {
      const hit = document.elementFromPoint(centerX, y);
      expect(hit, `vertical sweep elementFromPoint(${centerX}, ${y}) must hit split divider`).toBe(
        divider,
      );
    }

    // Real coordinate drag starting directly from the body-zone elementFromPoint hit target!
    const containerRect = hostEl.getBoundingClientRect();
    const dragStartY = Math.round((bodyTop + bodyBottom) / 2);
    const dragStartTarget = document.elementFromPoint(centerX, dragStartY) as HTMLElement;
    expect(dragStartTarget).toBe(divider);

    const dragTargetX = Math.round(containerRect.left + containerRect.width * 0.62);
    await act(async () => {
      dragStartTarget.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: centerX,
          clientY: dragStartY,
          pointerId: 1,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(document.querySelector('[data-testid="persona-split-drag-shield"]')).not.toBeNull();
    expect(webviewA.parentElement?.style.pointerEvents).toBe("none");
    expect(webviewB.parentElement?.style.pointerEvents).toBe("none");

    await act(async () => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          clientX: dragTargetX,
          clientY: dragStartY,
          pointerId: 1,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX: dragTargetX,
          clientY: dragStartY,
          pointerId: 1,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(document.querySelector('[data-testid="persona-split-drag-shield"]')).toBeNull();
    expect(webviewA.parentElement?.style.pointerEvents).toBe("auto");
    expect(webviewB.parentElement?.style.pointerEvents).toBe("auto");
    const updatedRatio =
      qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.splitRatio ?? 0;
    expect(updatedRatio).toBeGreaterThan(0.55);
    expect(updatedRatio).toBeLessThan(0.7);

    // After drag stabilizes, the new divider body center STILL hits divider (not webview)
    const afterRect = divider.getBoundingClientRect();
    const afterCenterX = Math.floor((afterRect.left + afterRect.right) / 2);
    expect(document.elementFromPoint(afterCenterX, dragStartY)).toBe(divider);
  });

  it("P2-2 & legacy desktop shell compat: cleans pool diagnostics on Hub deletion and gracefully degrades when desktop lacks per-Hub partition support", async () => {
    const hubAUrl = `${window.location.origin}/__persona-diag-a`;
    const hubBUrl = `${window.location.origin}/__persona-diag-b`;

    installDesktopPersonaMock();
    await ensureResidentPersonaWebview({ hubId: DEFAULT_PERSONA_HUB_ID, hubUrl: hubAUrl });
    await ensureResidentPersonaWebview({ hubId: "hub-ephemeral", hubUrl: hubBUrl });
    expect(getResidentPersonaPoolDiagnostics()).toEqual({
      pooledHubIds: [DEFAULT_PERSONA_HUB_ID, "hub-ephemeral"],
      inFlightHubIds: [],
    });

    // Deleting a Hub via destroyResidentPersonaWebview leaves zero leaked keys
    destroyResidentPersonaWebview("hub-ephemeral");
    expect(getResidentPersonaPoolDiagnostics()).toEqual({
      pooledHubIds: [DEFAULT_PERSONA_HUB_ID],
      inFlightHubIds: [],
    });

    // Reconcile removing remaining Hub also leaves zero leaked keys
    reconcileResidentPersonaWebviews([]);
    expect(getResidentPersonaPoolDiagnostics()).toEqual({
      pooledHubIds: [],
      inFlightHubIds: [],
    });

    // Legacy 0.17.534 desktop shell (no supportsPerHubPartitions / no setHubEntries):
    // falls back to single persist:persona partition, calls setHubUrl, and hides scoped clear-hub button
    const legacySetHubUrl = vi.fn(async () => true);
    const legacyClearSession = vi.fn(async () => undefined);
    window.paseoDesktop = {
      platform: "darwin",
      dialog: { ask: vi.fn(async () => true) },
      persona: {
        partition: PERSONA_WEBVIEW_PARTITION,
        setHubUrl: legacySetHubUrl,
        clearSession: legacyClearSession,
      },
    };

    const legacyWebview = await ensureResidentPersonaWebview({
      hubId: "hub-b",
      hubUrl: hubBUrl,
    });
    expect(legacyWebview).not.toBeNull();
    expect(legacyWebview?.getAttribute("partition")).toBe(PERSONA_WEBVIEW_PARTITION);
    expect(legacySetHubUrl).toHaveBeenCalledWith(hubBUrl, { enabled: true });

    const legacyQc = makeQueryClient({
      enabled: true,
      hubs: [
        { id: DEFAULT_PERSONA_HUB_ID, name: "Work Hub", hubUrl: hubAUrl, machineServerMap: {} },
        { id: "hub-b", name: "Home Hub", hubUrl: hubBUrl, machineServerMap: {} },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
    });
    await renderInBrowser(legacyQc, <PersonaSettingsSection />);
    expect(hostEl.querySelector('[data-testid="persona-settings-clear-hub-session"]')).toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-settings-clear-session"]')).not.toBeNull();
  });

  it("clears deleted non-default Hub partition, sweeps residual disk partitions on Clear All, never reuses deleted Work ID, and blocks case-colliding partitions in registry", async () => {
    const defaultUrl = `${window.location.origin}/__persona-default-iso`;
    const workUrl = `${window.location.origin}/__persona-work-iso`;
    const hostId = 88;
    const simulatedDiskPartitions = new Set<string>([
      PERSONA_WEBVIEW_PARTITION,
      "persist:persona-hub-work", // legacy residual on-disk partition
      "persist:paseo-browser", // unrelated browser partition — must never be cleared
    ]);
    const clearedPartitionsHistory: string[] = [];

    const registry = createPersonaHostHubRegistry({
      listPersistedPartitions: () => Array.from(simulatedDiskPartitions),
    });

    const clearSessionSpy = vi.fn(
      async (target?: string | { partition?: string; hubUrl?: string }) => {
        const resolved = registry.resolveClearSessionTarget(hostId, target);
        if (!resolved.ok) {
          throw new Error(resolved.error);
        }
        const partitions = resolved.mode === "single" ? [resolved.partition] : resolved.partitions;
        for (const partition of partitions) {
          clearedPartitionsHistory.push(partition);
        }
      },
    );

    installDesktopPersonaMock({
      setHubEntries: vi.fn(async (entries, options) =>
        registry.setHostHubEntries(hostId, entries, options),
      ),
      clearSession: clearSessionSpy,
    });

    const qc = makeQueryClient({
      enabled: true,
      hubs: [
        {
          id: DEFAULT_PERSONA_HUB_ID,
          name: "Default Hub",
          hubUrl: defaultUrl,
          machineServerMap: {},
        },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
    });

    await renderInBrowser(qc, <PersonaSettingsSection />);

    const setInputValue = (testId: string, value: string) => {
      const input = hostEl.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    };

    // Step 1: Create "Work" Hub -> gets non-reusable random lowercase ID (not static "hub-work")
    await act(async () => {
      (hostEl.querySelector('[data-testid="persona-settings-add-hub"]') as HTMLElement)?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      setInputValue("persona-settings-new-hub-name", "Work");
      setInputValue("persona-settings-new-hub-url", workUrl);
    });
    await act(async () => {
      (
        hostEl.querySelector('[data-testid="persona-settings-new-hub-submit"]') as HTMLElement
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const workHub1 = qc
      .getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)
      ?.persona.hubs.find((hub) => hub.name === "Work");
    expect(workHub1).toBeDefined();
    expect(workHub1!.id).toMatch(/^hub-work-[0-9a-f]{8}$/);
    expect(workHub1!.id).not.toBe("hub-work");
    const workPartition1 = `${PERSONA_WEBVIEW_PARTITION_PREFIX}${workHub1!.id}`;
    simulatedDiskPartitions.add(workPartition1);

    // Step 2: Delete non-default "Work" Hub -> synchronously clears its isolated partition & revokes allowlist
    await act(async () => {
      (
        hostEl.querySelector(
          `[data-testid="persona-settings-hub-delete-${workHub1!.id}"]`,
        ) as HTMLElement
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(qc.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.persona.hubs).toHaveLength(1);
    expect(clearSessionSpy).toHaveBeenCalledWith({
      partition: workPartition1,
      hubUrl: workUrl,
    });
    expect(clearedPartitionsHistory).toContain(workPartition1);
    // Deleted partition is revoked from main registry immediately after deletion
    expect(
      registry.authorizeWebviewAttach(hostId, { partition: workPartition1, src: `${workUrl}/` }),
    ).toBeNull();

    // Step 3: Click Clear All -> sweeps default + deleted Work + legacy persist:persona-hub-work, never paseo-browser
    clearedPartitionsHistory.length = 0;
    await act(async () => {
      (
        hostEl.querySelector('[data-testid="persona-settings-clear-session"]') as HTMLElement
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(clearedPartitionsHistory).toEqual(
      expect.arrayContaining([
        PERSONA_WEBVIEW_PARTITION,
        "persist:persona-hub-work",
        workPartition1,
      ]),
    );
    expect(clearedPartitionsHistory).not.toContain("persist:paseo-browser");

    // Step 4: Re-create another Hub named "Work" -> gets a brand new lowercase ID & partition
    await act(async () => {
      (hostEl.querySelector('[data-testid="persona-settings-add-hub"]') as HTMLElement)?.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await act(async () => {
      setInputValue("persona-settings-new-hub-name", "Work");
      setInputValue("persona-settings-new-hub-url", workUrl);
    });
    await act(async () => {
      (
        hostEl.querySelector('[data-testid="persona-settings-new-hub-submit"]') as HTMLElement
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const workHub2 = qc
      .getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)
      ?.persona.hubs.find((hub) => hub.name === "Work");
    expect(workHub2).toBeDefined();
    expect(workHub2!.id).toMatch(/^hub-work-[0-9a-f]{8}$/);
    expect(workHub2!.id).not.toBe(workHub1!.id);
    expect(workHub2!.id).not.toBe("hub-work");

    // Step 5: Deleting hub-default does NOT call single-partition clearSession on persist:persona
    clearSessionSpy.mockClear();
    await act(async () => {
      (
        hostEl.querySelector(
          `[data-testid="persona-settings-hub-delete-${DEFAULT_PERSONA_HUB_ID}"]`,
        ) as HTMLElement
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(clearSessionSpy).not.toHaveBeenCalled();

    // Step 6: Case-colliding config prioritizes exact lowercase IDs and main registry blocks raw uppercase collisions
    const normalizedCaseConfig = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        { id: "hub-Case", name: "Upper", hubUrl: defaultUrl, machineServerMap: {} },
        { id: "hub-case", name: "Lower", hubUrl: workUrl, machineServerMap: {} },
      ],
      activeHubId: "hub-case",
      splitEnabled: true,
      secondaryHubId: "hub-Case",
    });
    expect(normalizedCaseConfig.hubs.map((hub) => hub.id)).toEqual(["hub-case-2", "hub-case"]);
    expect(normalizedCaseConfig.activeHubId).toBe("hub-case");
    expect(normalizedCaseConfig.secondaryHubId).toBe("hub-case-2");

    const normalizedDefaultCaseConfig = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        { id: "Hub-Default", name: "Mixed Default", hubUrl: workUrl, machineServerMap: {} },
        { id: DEFAULT_PERSONA_HUB_ID, name: "Default", hubUrl: defaultUrl, machineServerMap: {} },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
      splitEnabled: true,
      secondaryHubId: "Hub-Default",
    });
    expect(normalizedDefaultCaseConfig.hubs.map((hub) => hub.id)).toEqual([
      "hub-default-2",
      DEFAULT_PERSONA_HUB_ID,
    ]);
    expect(normalizedDefaultCaseConfig.activeHubId).toBe(DEFAULT_PERSONA_HUB_ID);
    expect(normalizedDefaultCaseConfig.secondaryHubId).toBe("hub-default-2");
    expect(
      registry.setHostHubEntries(
        hostId,
        [
          { partition: "persist:persona-hub-Case", hubUrl: defaultUrl },
          { partition: "persist:persona-hub-case", hubUrl: workUrl },
        ],
        { enabled: true },
      ),
    ).toBe(false);
  });
});
