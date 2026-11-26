import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDefaultMainChatSettings } from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { PersonaSettingsSection } from "@/screens/settings/persona/persona-section";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { PersonaHeroRow } from "./hero-row";
import { PersonaSurface as ElectronPersonaSurface } from "./persona-surface.electron";
import { PersonaSurface } from "./persona-surface.web";
import {
  destroyResidentPersonaWebview,
  ensureResidentPersonaWebview,
  getResidentPersonaWebview,
  parkResidentPersonaWebview,
  PERSONA_RESIDENT_HOST_ID,
  presentResidentPersonaWebview,
} from "./resident-persona-webview.electron";
import { DEFAULT_PERSONA_EMBED_SETTINGS, type PersonaEmbedSettings } from "./settings";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockHosts = [
  { serverId: "srv_devbox", label: "DevBox" },
  { serverId: "srv_mac", label: "MacBook" },
];

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  usePathname: () => "/persona",
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeSnapshot: () => ({ connectionStatus: "online", client: null }),
  getHostRuntimeStore: () => ({
    getHosts: () => mockHosts,
    getSnapshot: () => ({ connectionStatus: "online", client: null }),
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

function makeQueryClient(personaPatch: Partial<PersonaEmbedSettings> = {}): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_CLIENT_SETTINGS,
    persona: {
      ...DEFAULT_PERSONA_EMBED_SETTINGS,
      ...personaPatch,
    },
  });
  return qc;
}

describe("Persona C2 embed Chromium browser regressions", () => {
  let hostEl: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    hostEl = document.createElement("div");
    hostEl.style.width = "1024px";
    hostEl.style.minHeight = "720px";
    document.body.appendChild(hostEl);
    root = createRoot(hostEl);
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
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

  it("renders settings & sidebar hero in zh-CN and en, tests Hub health check without tokens, and disables host Main Chat", async () => {
    const updateMainChatSettings = vi.fn(async () => ({
      settings: { ...createDefaultMainChatSettings("conservative"), enabled: false },
    }));
    const fakeClient = { updateMainChatSettings } as unknown as DaemonClient;

    useSessionStore.setState({
      sessions: {
        srv_devbox: {
          serverId: "srv_devbox",
          client: fakeClient,
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.532" },
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

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://10.37.217.3:18660/api/v1/health");
      expect(init?.credentials).toBe("omit");
      return new Response(JSON.stringify({ ok: true, hub_name: "n37-217-003", version: "0.9.1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const qc = makeQueryClient({ enabled: true, hubUrl: "http://10.37.217.3:18660" });
    await renderInBrowser(
      qc,
      <>
        <PersonaHeroRow />
        <PersonaSettingsSection />
      </>,
    );

    // Chinese (zh-CN) copy verification
    expect(hostEl.textContent).toContain("Persona");
    expect(hostEl.textContent).toContain("10.37.217.3:18660");
    expect(hostEl.textContent).toContain("启用单窗口 Persona 内嵌");
    expect(hostEl.textContent).toContain("检测到宿主「DevBox」的自研主对话仍在后台开启。");

    // Trigger connectivity test -> verify health result renders cleanly
    const testConnBtn = hostEl.querySelector(
      '[data-testid="persona-settings-test-connection"]',
    ) as HTMLElement | null;
    expect(testConnBtn).not.toBeNull();
    await act(async () => {
      testConnBtn?.click();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hostEl.textContent).toContain("连通正常 · n37-217-003（v0.9.1）");

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
    expect(hostEl.textContent).toContain("Reachable · n37-217-003 (v0.9.1)");

    // Invalid Hub URL shows clear error without saving
    const urlInput = hostEl.querySelector(
      '[data-testid="persona-settings-hub-url-input"]',
    ) as HTMLInputElement | null;
    const saveUrlBtn = hostEl.querySelector(
      '[data-testid="persona-settings-save-url"]',
    ) as HTMLElement | null;
    expect(urlInput).not.toBeNull();
    expect(saveUrlBtn).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(urlInput, "javascript:alert(1)");
      urlInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      saveUrlBtn?.click();
      await Promise.resolve();
    });
    expect(hostEl.querySelector('[data-testid="persona-settings-hub-url-error"]')).not.toBeNull();

    // Toggling enabled switch hides PersonaHeroRow and toggling back restores it
    const enabledSwitch = hostEl.querySelector(
      '[data-testid="persona-settings-enabled-switch"]',
    ) as HTMLElement | null;
    expect(enabledSwitch).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hero"]')).not.toBeNull();
    await act(async () => {
      enabledSwitch?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hero"]')).toBeNull();
    await act(async () => {
      enabledSwitch?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(hostEl.querySelector('[data-testid="sidebar-persona-hero"]')).not.toBeNull();
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

  it("renders Web fallback cleanly, blocks HTTPS->HTTP mixed-content iframe, and allows same-protocol iframe preview", async () => {
    const qc = makeQueryClient({ enabled: true, hubUrl: "http://10.37.217.3:18660" });
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

    // HTTPS page embedding HTTP Hub must show mixed-content block notice without mounting iframe
    expect(
      hostEl.querySelector('[data-testid="persona-web-mixed-content-warning"]'),
    ).not.toBeNull();
    expect(hostEl.querySelector("iframe")).toBeNull();

    // Re-render on HTTP page -> toggling iframe preview mounts sandboxed iframe
    await renderInBrowser(qc, <PersonaSurface pageProtocolOverride="http:" />);
    const iframe = hostEl.querySelector("iframe") as HTMLIFrameElement | null;
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe("http://10.37.217.3:18660");
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("keeps Electron resident webview alive across present -> 1x1 park -> present transitions below overlay-root", async () => {
    const webview = await ensureResidentPersonaWebview("http://10.37.217.3:18660");
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

    // Parking switches to 1x1 geometry without removing the <webview> element
    parkResidentPersonaWebview();
    expect(webview?.isConnected).toBe(true);
    expect(surface?.style.width).toBe("1px");
    expect(surface?.style.height).toBe("1px");
    expect(surface?.style.pointerEvents).toBe("none");
    expect(surface?.getAttribute("aria-hidden")).toBe("true");

    // Re-ensuring with the same hubUrl reuses the exact same webview instance (0ms resume)
    const reused = await ensureResidentPersonaWebview("http://10.37.217.3:18660");
    expect(reused).toBe(webview);
  });

  it("renders Electron PersonaSurface toolbar session actions on /s/ route and error overlay on did-fail-load", async () => {
    const qc = makeQueryClient({ enabled: true, hubUrl: "http://10.37.217.3:18660" });
    await renderInBrowser(qc, <ElectronPersonaSurface />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const webview = getResidentPersonaWebview();
    expect(webview).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-in-paseo"]')).toBeNull();

    // Navigating inside Persona SPA to /s/:mid/:sid reveals toolbar Open in Paseo + Diff buttons
    await act(async () => {
      const navEvent = new Event("did-navigate-in-page") as Event & { url?: string };
      navEvent.url = "http://10.37.217.3:18660/s/n37-217-003/paseo-ag_123";
      webview?.dispatchEvent(navEvent);
    });
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-in-paseo"]')).not.toBeNull();
    expect(hostEl.querySelector('[data-testid="persona-toolbar-open-diff"]')).not.toBeNull();

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
      webview?.dispatchEvent(abortEvent);
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
      failEvent.validatedURL = "http://10.37.217.3:18660";
      failEvent.isMainFrame = true;
      webview?.dispatchEvent(failEvent);
    });
    expect(hostEl.querySelector('[data-testid="persona-load-error-state"]')).not.toBeNull();
    expect(hostEl.textContent).toContain("ERR_CONNECTION_REFUSED");
  });
});
