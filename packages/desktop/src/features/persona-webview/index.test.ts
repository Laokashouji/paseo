import { describe, expect, it, vi } from "vitest";
import {
  clearPersonaWebviewSession,
  getPersonaWebviewSession,
  isTrustedPersonaHostIpcEvent,
  listPersonaWebviewGuests,
  PERSONA_WEBVIEW_PARTITION,
  probePersonaHubHealth,
  registerPersonaWebviewNavigationGuards,
  type PersonaGuardableWebContents,
  type PersonaNavigationEvent,
  type PersonaWindowOpenSessionPayload,
} from "./index.js";

function createMockWebContents(currentUrl = "http://127.0.0.1:18660/") {
  let activeUrl = currentUrl;
  const listeners: Record<string, Array<(event: PersonaNavigationEvent, url?: string) => void>> = {
    "will-navigate": [],
    "will-frame-navigate": [],
    "will-redirect": [],
  };
  let windowOpenHandler:
    | ((details: { url: string }) => { action: "deny" } | { action: "allow" })
    | null = null;

  const contents: PersonaGuardableWebContents = {
    getURL: () => activeUrl,
    on: (event, listener) => {
      listeners[event].push(listener);
    },
    setWindowOpenHandler: (handler) => {
      windowOpenHandler = handler;
    },
  };

  return {
    contents,
    setCurrentUrl(nextUrl: string) {
      activeUrl = nextUrl;
    },
    emitNavigation(
      eventName: "will-navigate" | "will-frame-navigate" | "will-redirect",
      url: string,
      isMainFrame?: boolean,
    ) {
      const preventDefault = vi.fn();
      const event: PersonaNavigationEvent = {
        url,
        ...(isMainFrame !== undefined ? { isMainFrame } : {}),
        preventDefault,
      };
      for (const listener of listeners[eventName]) {
        listener(event, url);
      }
      return { prevented: preventDefault.mock.calls.length > 0 };
    },
    triggerWindowOpen(url: string) {
      if (!windowOpenHandler) {
        throw new Error("windowOpenHandler not registered");
      }
      return windowOpenHandler({ url });
    },
  };
}

describe("persona-webview runtime helpers", () => {
  it("resolves persist:persona partition and clears all 7 storage types + caches before reloading guests", async () => {
    const clearStorageData = vi.fn(async () => undefined);
    const clearCache = vi.fn(async () => undefined);
    const clearAuthCache = vi.fn(async () => undefined);
    const personaSession = { clearStorageData, clearCache, clearAuthCache };
    const fromPartition = vi.fn(() => personaSession);

    expect(getPersonaWebviewSession({ fromPartition })).toBe(personaSession);
    expect(fromPartition).toHaveBeenCalledWith(PERSONA_WEBVIEW_PARTITION);

    const activeGuest = {
      id: 1,
      session: personaSession,
      isDestroyed: () => false,
      getType: () => "webview",
      reload: vi.fn(),
    };
    const destroyedGuest = {
      id: 2,
      session: personaSession,
      isDestroyed: () => true,
      getType: () => "webview",
      reload: vi.fn(),
    };
    const otherSessionGuest = {
      id: 3,
      session: {},
      isDestroyed: () => false,
      getType: () => "webview",
      reload: vi.fn(),
    };

    const guests = listPersonaWebviewGuests({
      personaSession,
      webContents: [activeGuest, destroyedGuest, otherSessionGuest],
    });
    expect(guests).toEqual([activeGuest]);

    const logReloadError = vi.fn();
    await clearPersonaWebviewSession({
      personaSession,
      listGuests: () => guests,
      logReloadError,
    });

    expect(clearStorageData).toHaveBeenCalledWith({
      storages: [
        "cookies",
        "filesystem",
        "indexdb",
        "localstorage",
        "serviceworkers",
        "cachestorage",
        "shadercache",
      ],
    });
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(clearAuthCache).toHaveBeenCalledTimes(1);
    expect(activeGuest.reload).toHaveBeenCalledTimes(1);
    expect(destroyedGuest.reload).not.toHaveBeenCalled();
    expect(otherSessionGuest.reload).not.toHaveBeenCalled();
    expect(logReloadError).not.toHaveBeenCalled();
  });

  it("blocks disallowed protocols and off-origin main-frame navigations/redirects while isolating subframes", () => {
    const mock = createMockWebContents("http://127.0.0.1:18660/");
    const openExternalUrl = vi.fn();
    const onOpenSession = vi.fn();

    registerPersonaWebviewNavigationGuards(mock.contents, {
      getConfiguredHubUrl: () => "http://127.0.0.1:18660",
      onOpenSession,
      openExternalUrl,
    });

    expect(
      mock.emitNavigation("will-navigate", "http://127.0.0.1:18660/persona/123").prevented,
    ).toBe(false);
    expect(mock.emitNavigation("will-navigate", "file:///etc/passwd").prevented).toBe(true);
    expect(mock.emitNavigation("will-navigate", "javascript:alert(1)").prevented).toBe(true);
    expect(mock.emitNavigation("will-redirect", "data:text/html,hi", true).prevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();

    // Off-origin HTTP(S) main-frame navigation & redirect are blocked and handed to external browser
    expect(
      mock.emitNavigation("will-navigate", "https://github.com/getpaseo/paseo").prevented,
    ).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/getpaseo/paseo");

    expect(
      mock.emitNavigation("will-redirect", "https://example.org/redirected", true).prevented,
    ).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.org/redirected");
    expect(openExternalUrl).toHaveBeenCalledTimes(2);

    // Subframe unsafe protocol is rejected; legitimate cross-origin subframe redirect & navigation
    // must NOT open system browser or be treated as top-level navigation.
    expect(mock.emitNavigation("will-frame-navigate", "file:///tmp/x", false).prevented).toBe(true);
    expect(mock.emitNavigation("will-redirect", "javascript:alert(1)", false).prevented).toBe(true);
    expect(
      mock.emitNavigation("will-frame-navigate", "https://docs.example.com/embed", false).prevented,
    ).toBe(false);
    expect(
      mock.emitNavigation("will-redirect", "https://cdn.example.com/widget", false).prevented,
    ).toBe(false);
    expect(openExternalUrl).toHaveBeenCalledTimes(2);
  });

  it("blocks all navigations and window-open silently when Hub authorization is missing or revoked", () => {
    let authorizedHub = "";
    const mock = createMockWebContents("http://127.0.0.1:18660/");
    const openExternalUrl = vi.fn();
    const onOpenSession = vi.fn();

    registerPersonaWebviewNavigationGuards(mock.contents, {
      getConfiguredHubUrl: () => authorizedHub,
      onOpenSession,
      openExternalUrl,
    });

    // Must never fall back to contents.getURL() when Hub is unregistered/revoked
    expect(
      mock.emitNavigation("will-navigate", "http://127.0.0.1:18660/s/m1/paseo-ag1").prevented,
    ).toBe(true);
    expect(mock.triggerWindowOpen("http://127.0.0.1:18660/s/m1/paseo-ag1")).toEqual({
      action: "deny",
    });
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();

    // Even when Hub is registered, window-open from a mismatched main-document origin is denied
    authorizedHub = "http://127.0.0.1:18660";
    mock.setCurrentUrl("https://untrusted.example.com/");
    expect(mock.triggerWindowOpen("http://127.0.0.1:18660/s/m1/paseo-ag1")).toEqual({
      action: "deny",
    });
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("forwards same-origin /s/ window-open requests to Paseo and opens external links in system browser", () => {
    const mock = createMockWebContents("http://127.0.0.1:18660/");
    const openExternalUrl = vi.fn();
    const openedSessions: PersonaWindowOpenSessionPayload[] = [];

    registerPersonaWebviewNavigationGuards(mock.contents, {
      getConfiguredHubUrl: () => "http://127.0.0.1:18660",
      onOpenSession: (payload) => openedSessions.push(payload),
      openExternalUrl,
    });

    expect(
      mock.triggerWindowOpen("http://127.0.0.1:18660/s/n37-217-003/paseo-ag_42?view=chat"),
    ).toEqual({ action: "deny" });
    expect(openedSessions).toEqual([
      {
        machineId: "n37-217-003",
        sessionId: "paseo-ag_42",
        view: "chat",
        source: "window-open",
        rawHref: "http://127.0.0.1:18660/s/n37-217-003/paseo-ag_42?view=chat",
      },
    ]);
    expect(openExternalUrl).not.toHaveBeenCalled();

    // External URL opens externally and is denied as a popup
    expect(mock.triggerWindowOpen("https://feishu.cn/docx/abc123")).toEqual({ action: "deny" });
    expect(openExternalUrl).toHaveBeenCalledWith("https://feishu.cn/docx/abc123");

    // Unsafe protocol is denied silently without calling openExternalUrl
    expect(mock.triggerWindowOpen("javascript:alert(1)")).toEqual({ action: "deny" });
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it("validates privileged Persona IPC callers strictly against registered Paseo windows and main frames", () => {
    const registeredHosts = new Set<number>([10]);
    const mainFrame = { routingId: 1 };
    const subFrame = { routingId: 2 };

    // Valid registered main-frame host window
    expect(
      isTrustedPersonaHostIpcEvent(
        {
          sender: {
            id: 10,
            mainFrame,
            isDestroyed: () => false,
            getType: () => "window",
          },
          senderFrame: mainFrame,
        },
        registeredHosts,
      ),
    ).toBe(true);

    // Rejects subframe of registered host window
    expect(
      isTrustedPersonaHostIpcEvent(
        {
          sender: {
            id: 10,
            mainFrame,
            isDestroyed: () => false,
            getType: () => "window",
          },
          senderFrame: subFrame,
        },
        registeredHosts,
      ),
    ).toBe(false);

    // Rejects unregistered window id
    expect(
      isTrustedPersonaHostIpcEvent(
        {
          sender: {
            id: 99,
            mainFrame,
            isDestroyed: () => false,
            getType: () => "window",
          },
          senderFrame: mainFrame,
        },
        registeredHosts,
      ),
    ).toBe(false);

    // Rejects webview guest sender even if id somehow matched
    expect(
      isTrustedPersonaHostIpcEvent(
        {
          sender: {
            id: 10,
            mainFrame,
            isDestroyed: () => false,
            getType: () => "webview",
          },
          senderFrame: mainFrame,
        },
        registeredHosts,
      ),
    ).toBe(false);

    // Rejects destroyed sender
    expect(
      isTrustedPersonaHostIpcEvent(
        {
          sender: {
            id: 10,
            mainFrame,
            isDestroyed: () => true,
            getType: () => "window",
          },
          senderFrame: mainFrame,
        },
        registeredHosts,
      ),
    ).toBe(false);
  });

  it("probes registered Hub health path without credentials and strictly validates redirects", async () => {
    // Rejects unregistered Hub URL
    const notConfigured = await probePersonaHubHealth(null);
    expect(notConfigured).toEqual({
      ok: false,
      code: "not_configured",
      error: "Persona Hub URL is not registered",
    });

    // Follows valid same-origin redirect to fixed health path and sends credentials: omit
    let calls = 0;
    const redirectOkFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      if (calls === 1) {
        expect(String(url)).toBe("http://127.0.0.1:18660/api/v1/health");
        return new Response(null, {
          status: 307,
          headers: { location: "/api/v1/health/" },
        });
      }
      expect(String(url)).toBe("http://127.0.0.1:18660/api/v1/health/");
      return new Response(JSON.stringify({ ok: true, hub_name: "local-hub", version: "1.2.3" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const okResult = await probePersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: redirectOkFetch as unknown as typeof fetch,
    });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.hubName).toBe("local-hub");
      expect(okResult.version).toBe("1.2.3");
    }

    // Blocks cross-origin redirect
    const offOriginRedirectFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/api/v1/health" },
      });
    });
    const blockedOffOrigin = await probePersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: offOriginRedirectFetch as unknown as typeof fetch,
    });
    expect(blockedOffOrigin).toEqual({
      ok: false,
      code: "redirect_blocked",
      error: "Health check redirect blocked",
    });

    // Blocks same-origin redirect away from fixed health path
    const offPathRedirectFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "/api/v1/sessions" },
      });
    });
    const blockedOffPath = await probePersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: offPathRedirectFetch as unknown as typeof fetch,
    });
    expect(blockedOffPath).toEqual({
      ok: false,
      code: "redirect_blocked",
      error: "Health check redirect blocked",
    });
  });
});
