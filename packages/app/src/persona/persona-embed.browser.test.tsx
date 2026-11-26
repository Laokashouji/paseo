import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDefaultMainChatSettings } from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  registerPersonaWebviewGuestIpcBridge,
  type PersonaGuestFrameLike,
  type PersonaGuestIpcMainEventLike,
  type PersonaGuestIpcWebContentsLike,
} from "../../../desktop/src/features/persona-webview/index";
import { PersonaHeroRow } from "./hero-row";
import { PersonaSurface as ElectronPersonaSurface } from "./persona-surface.electron";
import { PersonaSurface } from "./persona-surface.web";
import {
  destroyResidentPersonaWebview,
  disableResidentPersonaWebview,
  ensureResidentPersonaWebview,
  getResidentPersonaWebview,
  parkResidentPersonaWebview,
  PERSONA_RESIDENT_HOST_ID,
  presentResidentPersonaWebview,
} from "./resident-persona-webview.electron";
import {
  DEFAULT_PERSONA_EMBED_SETTINGS,
  DEFAULT_PERSONA_HUB_ID,
  normalizePersonaEmbedSettings,
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
      partition: "persist:persona",
      setHubUrls,
      setHubUrl,
      checkHealth,
      clearSession,
      openDevTools,
      ...overrides,
    },
  };

  return {
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
    const divider = hostEl.querySelector('[data-testid="persona-split-divider"]') as HTMLElement;
    await dragSplitDivider(divider, hostEl.getBoundingClientRect(), 0.5, 0.65, () => {
      expect(hostEl.querySelector('[data-testid="persona-split-drag-shield"]')).not.toBeNull();
      expect(webviewA.parentElement?.style.pointerEvents).toBe("none");
      expect(webviewB.parentElement?.style.pointerEvents).toBe("none");
    });
    expect(hostEl.querySelector('[data-testid="persona-split-drag-shield"]')).toBeNull();
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

    // Per-Hub clear session targets ONLY Hub B's URL
    await act(async () => {
      (
        hostEl.querySelector(
          '[data-testid="persona-settings-clear-hub-session"]',
        ) as HTMLElement | null
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(desktopMock.clearSession).toHaveBeenCalledWith(hubBUrl);

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
});
