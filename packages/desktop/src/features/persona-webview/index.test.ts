import { describe, expect, it, vi } from "vitest";
import {
  clearPersonaWebviewSession,
  getPersonaWebviewSession,
  listPersonaWebviewGuests,
  PERSONA_WEBVIEW_PARTITION,
  registerPersonaWebviewNavigationGuards,
  type PersonaGuardableWebContents,
  type PersonaNavigationEvent,
  type PersonaWindowOpenSessionPayload,
} from "./index.js";

function createMockWebContents(currentUrl = "http://10.37.217.3:18660/") {
  const listeners: Record<string, Array<(event: PersonaNavigationEvent, url?: string) => void>> = {
    "will-navigate": [],
    "will-frame-navigate": [],
    "will-redirect": [],
  };
  let windowOpenHandler:
    | ((details: { url: string }) => { action: "deny" } | { action: "allow" })
    | null = null;

  const contents: PersonaGuardableWebContents = {
    getURL: () => currentUrl,
    on: (event, listener) => {
      listeners[event].push(listener);
    },
    setWindowOpenHandler: (handler) => {
      windowOpenHandler = handler;
    },
  };

  return {
    contents,
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

  it("blocks disallowed protocols and off-origin top-level navigations while keeping same-origin allowed", () => {
    const mock = createMockWebContents("http://10.37.217.3:18660/");
    const openExternalUrl = vi.fn();
    const onOpenSession = vi.fn();

    registerPersonaWebviewNavigationGuards(mock.contents, {
      getConfiguredHubUrl: () => "http://10.37.217.3:18660",
      onOpenSession,
      openExternalUrl,
    });

    expect(
      mock.emitNavigation("will-navigate", "http://10.37.217.3:18660/persona/123").prevented,
    ).toBe(false);
    expect(mock.emitNavigation("will-navigate", "file:///etc/passwd").prevented).toBe(true);
    expect(mock.emitNavigation("will-navigate", "javascript:alert(1)").prevented).toBe(true);
    expect(mock.emitNavigation("will-redirect", "data:text/html,hi").prevented).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();

    // Off-origin HTTP(S) top-level navigation is blocked in webview and handed to external browser
    expect(
      mock.emitNavigation("will-navigate", "https://github.com/getpaseo/paseo").prevented,
    ).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/getpaseo/paseo");

    // Subframe unsafe protocol is rejected; legitimate HTTPS subframe is not blocked
    expect(mock.emitNavigation("will-frame-navigate", "file:///tmp/x", false).prevented).toBe(true);
    expect(
      mock.emitNavigation("will-frame-navigate", "https://docs.example.com/embed", false).prevented,
    ).toBe(false);
  });

  it("forwards same-origin /s/ window-open requests to Paseo and opens external links in system browser", () => {
    const mock = createMockWebContents("http://10.37.217.3:18660/");
    const openExternalUrl = vi.fn();
    const openedSessions: PersonaWindowOpenSessionPayload[] = [];

    registerPersonaWebviewNavigationGuards(mock.contents, {
      getConfiguredHubUrl: () => "http://10.37.217.3:18660",
      onOpenSession: (payload) => openedSessions.push(payload),
      openExternalUrl,
    });

    expect(
      mock.triggerWindowOpen("http://10.37.217.3:18660/s/n37-217-003/paseo-ag_42?view=chat"),
    ).toEqual({ action: "deny" });
    expect(openedSessions).toEqual([
      {
        machineId: "n37-217-003",
        sessionId: "paseo-ag_42",
        view: "chat",
        source: "window-open",
        rawHref: "http://10.37.217.3:18660/s/n37-217-003/paseo-ag_42?view=chat",
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
});
