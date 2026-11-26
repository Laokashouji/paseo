import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  clearPersonaWebviewSession,
  getPersonaWebviewSession,
  isTrustedPersonaGuestMainFrameIpcEvent,
  isTrustedPersonaHostIpcEvent,
  listPersonaWebviewGuests,
  PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL,
  PERSONA_GUEST_READY_IPC_CHANNEL,
  PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL,
  PERSONA_HUB_URL_ARG_PREFIX,
  PERSONA_WEBVIEW_PARTITION,
  probePersonaHubHealth,
  registerPersonaWebviewGuestIpcBridge,
  registerPersonaWebviewNavigationGuards,
  type PersonaGuardableWebContents,
  type PersonaGuestFrameLike,
  type PersonaGuestIpcMainEventLike,
  type PersonaGuestIpcWebContentsLike,
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

async function startHealthTestHttpServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const finishSlowBody = (
    timer: ReturnType<typeof setTimeout>,
    res: { destroyed: boolean; writableEnded: boolean; end: (chunk: string) => void },
  ): void => {
    pendingTimers.delete(timer);
    if (!res.destroyed && !res.writableEnded) {
      res.end('true,"hub_name":"late-hub","version":"0.0.1"}');
    }
  };

  const server: Server = createServer((req, res) => {
    if (req.url === "/slow/api/v1/health") {
      // Immediately flush 200 headers and partial body, then stall longer than timeoutMs.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      res.write('{"ok":');
      const timer = setTimeout(() => finishSlowBody(timer, res), 2_000);
      pendingTimers.add(timer);
      req.once("close", () => {
        clearTimeout(timer);
        pendingTimers.delete(timer);
      });
      return;
    }

    if (req.url === "/fast/api/v1/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hub_name: "real-http-hub", version: "3.1.4" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
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

  it("aborts slow JSON response bodies on schedule over real local HTTP and returns timeout", async () => {
    const httpServer = await startHealthTestHttpServer();

    try {
      const startedAt = Date.now();
      const slowResult = await probePersonaHubHealth(`${httpServer.baseUrl}/slow`, {
        timeoutMs: 80,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(slowResult).toEqual({
        ok: false,
        code: "timeout",
        error: "Request timed out",
      });
      expect(elapsedMs).toBeLessThan(1_000);

      const fastResult = await probePersonaHubHealth(`${httpServer.baseUrl}/fast`, {
        timeoutMs: 1_000,
      });
      expect(fastResult.ok).toBe(true);
      if (fastResult.ok) {
        expect(fastResult.hubName).toBe("real-http-hub");
        expect(fastResult.version).toBe("3.1.4");
      }
    } finally {
      await httpServer.close();
    }
  });

  it("enforces real Electron main-process senderFrame === contents.mainFrame and origin verification for guest IPC", () => {
    let ipcListener:
      | ((event: PersonaGuestIpcMainEventLike, channel: string, ...args: unknown[]) => void)
      | null = null;
    let configuredHubUrl = "http://127.0.0.1:18660";
    let currentContentsUrl = "http://127.0.0.1:18660/s/n37-217-003/sess_1";
    let destroyed = false;
    let contentsType = "webview";

    const mainFrame: PersonaGuestFrameLike = {
      url: "http://127.0.0.1:18660/s/n37-217-003/sess_1",
      origin: "http://127.0.0.1:18660",
      detached: false,
      parent: null,
      processId: 7,
      routingId: 1,
    };
    Object.assign(mainFrame, { top: mainFrame });

    const sameOriginSubFrame: PersonaGuestFrameLike = {
      url: "http://127.0.0.1:18660/embedded-frame",
      origin: "http://127.0.0.1:18660",
      detached: false,
      parent: mainFrame,
      top: mainFrame,
      processId: 7,
      routingId: 2,
    };

    const contents: PersonaGuestIpcWebContentsLike = {
      id: 42,
      mainFrame,
      isDestroyed: () => destroyed,
      getType: () => contentsType,
      getURL: () => currentContentsUrl,
      on: (event, listener) => {
        if (event === "ipc-message") {
          ipcListener = listener;
        }
      },
    };

    const onGuestOpenSession = vi.fn();
    const onGuestSessionMetadataResult = vi.fn();
    const onGuestReady = vi.fn();

    registerPersonaWebviewGuestIpcBridge(contents, {
      getConfiguredHubUrl: () => configuredHubUrl,
      onGuestOpenSession,
      onGuestSessionMetadataResult,
      onGuestReady,
    });
    expect(ipcListener).not.toBeNull();

    const mainEvent: PersonaGuestIpcMainEventLike = {
      sender: contents,
      senderFrame: mainFrame,
      processId: 7,
      frameId: 1,
    };

    // Accepts genuine mainFrame open-session, metadata-result, and ready events
    ipcListener?.(mainEvent, PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL, {
      machineId: "n37-217-003",
      sessionId: "sess_1",
      source: "link-click",
    });
    expect(onGuestOpenSession).toHaveBeenCalledWith(
      { machineId: "n37-217-003", sessionId: "sess_1", source: "link-click" },
      { guestWebContentsId: 42, frameUrl: mainFrame.url },
    );

    ipcListener?.(mainEvent, PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL, {
      requestId: "req-1",
      machineId: "n37-217-003",
      sessionId: "sess_1",
      workspaceIdHint: "wks_0123456789abcdef",
      cwdHint: "/repo/app",
    });
    expect(onGuestSessionMetadataResult).toHaveBeenCalledWith(
      {
        requestId: "req-1",
        machineId: "n37-217-003",
        sessionId: "sess_1",
        workspaceIdHint: "wks_0123456789abcdef",
        cwdHint: "/repo/app",
      },
      { guestWebContentsId: 42, frameUrl: mainFrame.url },
    );

    ipcListener?.(mainEvent, PERSONA_GUEST_READY_IPC_CHANNEL, { url: mainFrame.url });
    expect(onGuestReady).toHaveBeenCalledWith({
      guestWebContentsId: 42,
      frameUrl: mainFrame.url,
    });

    onGuestOpenSession.mockClear();
    onGuestSessionMetadataResult.mockClear();
    onGuestReady.mockClear();

    // Rejects same-origin subframe for both open-session and metadata reply
    const subFrameEvent: PersonaGuestIpcMainEventLike = {
      sender: contents,
      senderFrame: sameOriginSubFrame,
      processId: 7,
      frameId: 2,
    };
    ipcListener?.(subFrameEvent, PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL, {
      machineId: "n37-217-003",
      sessionId: "sess_1",
      source: "link-click",
    });
    ipcListener?.(subFrameEvent, PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL, {
      requestId: "req-1",
      machineId: "n37-217-003",
      sessionId: "sess_1",
    });
    ipcListener?.(subFrameEvent, PERSONA_GUEST_READY_IPC_CHANNEL, {});
    expect(onGuestOpenSession).not.toHaveBeenCalled();
    expect(onGuestSessionMetadataResult).not.toHaveBeenCalled();
    expect(onGuestReady).not.toHaveBeenCalled();

    // Fail-closed when senderFrame is missing, detached, mismatched frameId/processId, or wrong sender
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: contents, senderFrame: null, processId: 7, frameId: 1 },
        contents,
        configuredHubUrl,
      ),
    ).toBe(false);
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: {}, senderFrame: mainFrame, processId: 7, frameId: 1 },
        contents,
        configuredHubUrl,
      ),
    ).toBe(false);
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: contents, senderFrame: mainFrame, processId: 7, frameId: 99 },
        contents,
        configuredHubUrl,
      ),
    ).toBe(false);
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: contents, senderFrame: mainFrame, processId: 8, frameId: 1 },
        contents,
        configuredHubUrl,
      ),
    ).toBe(false);

    const detachedMainFrame: PersonaGuestFrameLike = { ...mainFrame, detached: true };
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: contents, senderFrame: detachedMainFrame, processId: 7, frameId: 1 },
        { ...contents, mainFrame: detachedMainFrame },
        configuredHubUrl,
      ),
    ).toBe(false);

    // Rejects off-origin, about:blank, opaque origin, unregistered Hub, non-webview, or destroyed contents
    const offOriginFrame: PersonaGuestFrameLike = {
      url: "https://evil.example.com/s/m1/s1",
      origin: "https://evil.example.com",
      parent: null,
    };
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: contents, senderFrame: offOriginFrame },
        { ...contents, mainFrame: offOriginFrame, getURL: () => offOriginFrame.url },
        configuredHubUrl,
      ),
    ).toBe(false);

    const blankFrame: PersonaGuestFrameLike = {
      url: "about:blank",
      origin: "null",
      parent: null,
    };
    expect(
      isTrustedPersonaGuestMainFrameIpcEvent(
        { sender: contents, senderFrame: blankFrame },
        { ...contents, mainFrame: blankFrame, getURL: () => "about:blank" },
        configuredHubUrl,
      ),
    ).toBe(false);

    configuredHubUrl = "";
    expect(isTrustedPersonaGuestMainFrameIpcEvent(mainEvent, contents, configuredHubUrl)).toBe(
      false,
    );

    configuredHubUrl = "http://127.0.0.1:18660";
    contentsType = "window";
    expect(isTrustedPersonaGuestMainFrameIpcEvent(mainEvent, contents, configuredHubUrl)).toBe(
      false,
    );

    contentsType = "webview";
    currentContentsUrl = "https://evil.example.com/";
    expect(isTrustedPersonaGuestMainFrameIpcEvent(mainEvent, contents, configuredHubUrl)).toBe(
      false,
    );

    currentContentsUrl = mainFrame.url;
    destroyed = true;
    expect(isTrustedPersonaGuestMainFrameIpcEvent(mainEvent, contents, configuredHubUrl)).toBe(
      false,
    );

    // Ignores unknown IPC channels even from a trusted main frame
    destroyed = false;
    ipcListener?.(mainEvent, "paseo:persona:unknown", { machineId: "m1" });
    expect(onGuestOpenSession).not.toHaveBeenCalled();
    expect(onGuestSessionMetadataResult).not.toHaveBeenCalled();
    expect(onGuestReady).not.toHaveBeenCalled();
  });

  it("enforces Electron 44 main-frame identity metadata on privileged host IPC events", () => {
    const registeredHosts = new Set<number>([10]);
    const hostMainFrame: {
      detached: boolean;
      parent: object | null;
      top?: object | null;
      processId: number;
      routingId: number;
    } = {
      detached: false,
      parent: null,
      processId: 3,
      routingId: 1,
    };
    hostMainFrame.top = hostMainFrame;

    const hostSubFrame = {
      detached: false,
      parent: hostMainFrame,
      top: hostMainFrame,
      processId: 3,
      routingId: 2,
    };

    const hostSender = {
      id: 10,
      mainFrame: hostMainFrame,
      isDestroyed: () => false,
      getType: () => "window",
    };

    expect(
      isTrustedPersonaHostIpcEvent(
        { sender: hostSender, senderFrame: hostMainFrame, processId: 3, frameId: 1 },
        registeredHosts,
      ),
    ).toBe(true);

    // Rejects same-origin subframe, detached frame, and mismatched processId/frameId
    expect(
      isTrustedPersonaHostIpcEvent(
        { sender: hostSender, senderFrame: hostSubFrame, processId: 3, frameId: 2 },
        registeredHosts,
      ),
    ).toBe(false);
    expect(
      isTrustedPersonaHostIpcEvent(
        { sender: hostSender, senderFrame: hostMainFrame, processId: 3, frameId: 99 },
        registeredHosts,
      ),
    ).toBe(false);
    expect(
      isTrustedPersonaHostIpcEvent(
        { sender: hostSender, senderFrame: hostMainFrame, processId: 99, frameId: 1 },
        registeredHosts,
      ),
    ).toBe(false);

    const detachedHostFrame = { ...hostMainFrame, detached: true };
    detachedHostFrame.top = detachedHostFrame;
    expect(
      isTrustedPersonaHostIpcEvent(
        {
          sender: { ...hostSender, mainFrame: detachedHostFrame },
          senderFrame: detachedHostFrame,
          processId: 3,
          frameId: 1,
        },
        registeredHosts,
      ),
    ).toBe(false);
  });
});

interface Electron44MockFrame extends PersonaGuestFrameLike {
  readonly osProcessId: number;
  readonly frameTreeNodeId: number;
  readonly frameToken: string;
  frames: Electron44MockFrame[];
  framesInSubtree: Electron44MockFrame[];
  top: Electron44MockFrame | null;
}

function compilePersonaGuestPreloadArtifact(): { compiledJs: string } {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const desktopRoot = join(currentDir, "..", "..", "..");
  const tsconfigPath = join(desktopRoot, "tsconfig.json");
  const guestPreloadPath = join(currentDir, "guest-preload.ts");

  const configFile = ts.readConfigFile(tsconfigPath, (filePath) => readFileSync(filePath, "utf8"));
  expect(configFile.error).toBeUndefined();
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, desktopRoot);
  const source = readFileSync(guestPreloadPath, "utf8");
  const result = ts.transpileModule(source, {
    fileName: guestPreloadPath,
    compilerOptions: {
      ...parsedConfig.options,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
    },
    reportDiagnostics: true,
  });

  expect(result.diagnostics ?? []).toEqual([]);
  return { compiledJs: result.outputText };
}

function inspectCompiledPreloadArtifact(compiledJs: string): {
  runtimeRequires: string[];
  usesContextBridge: boolean;
  usesSendToHost: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "guest-preload.js",
    compiledJs,
    ts.ScriptTarget.Latest,
    true,
  );
  const runtimeRequires: string[] = [];
  let usesContextBridge = false;
  let usesSendToHost = false;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          runtimeRequires.push(arg.text);
        }
      }
    }
    if (ts.isIdentifier(node)) {
      if (node.text === "contextBridge") {
        usesContextBridge = true;
      } else if (node.text === "sendToHost") {
        usesSendToHost = true;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { runtimeRequires, usesContextBridge, usesSendToHost };
}

function createSandboxedGuestDom(options: {
  href: string;
  isSubFrame?: boolean;
  fetchImpl?: typeof fetch;
}) {
  class FakeNode {
    public parentElement: FakeElement | null = null;
  }
  class FakeElement extends FakeNode {
    public closest(_selector: string): FakeElement | null {
      return null;
    }
  }
  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLButtonElement extends FakeHTMLElement {}
  class FakeHTMLAnchorElement extends FakeHTMLElement {
    public constructor(private readonly hrefValue: string) {
      super();
    }
    public override closest(selector: string): FakeElement | null {
      return selector === "a[href]" ? this : null;
    }
    public getAttribute(name: string): string | null {
      return name === "href" ? this.hrefValue : null;
    }
  }

  const docClickListeners: Array<(event: unknown) => void> = [];
  const winListeners = new Map<string, Array<(event: unknown) => void>>();
  const parsedUrl = new URL(options.href);

  const win: Record<string, unknown> = {
    location: {
      href: parsedUrl.href,
      origin: parsedUrl.origin,
      protocol: parsedUrl.protocol,
      host: parsedUrl.host,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      assign: vi.fn(),
    },
    Element: FakeElement,
    Node: FakeNode,
    HTMLElement: FakeHTMLElement,
    HTMLAnchorElement: FakeHTMLAnchorElement,
    HTMLButtonElement: FakeHTMLButtonElement,
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null },
    fetch: options.fetchImpl,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    requestAnimationFrame: (callback: () => void) => {
      callback();
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = winListeners.get(type) ?? [];
      list.push(listener);
      winListeners.set(type, list);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = winListeners.get(type);
      if (!list) return;
      const index = list.indexOf(listener);
      if (index >= 0) {
        list.splice(index, 1);
      }
    },
  };
  win.self = win;
  win.top = options.isSubFrame ? {} : win;

  const doc = {
    readyState: "complete",
    baseURI: parsedUrl.href,
    head: null,
    documentElement: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeHTMLElement(),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "click") {
        docClickListeners.push(listener);
      }
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "click") {
        const index = docClickListeners.indexOf(listener);
        if (index >= 0) {
          docClickListeners.splice(index, 1);
        }
      }
    },
  };

  return {
    win,
    doc,
    dispatchAnchorClick(href: string) {
      const anchor = new FakeHTMLAnchorElement(href);
      let defaultPrevented = false;
      let stoppedImmediate = false;
      const event = {
        target: anchor,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        get defaultPrevented() {
          return defaultPrevented;
        },
        preventDefault: () => {
          defaultPrevented = true;
        },
        stopImmediatePropagation: () => {
          stoppedImmediate = true;
        },
      };
      for (const listener of docClickListeners) {
        listener(event);
      }
      return { defaultPrevented, stoppedImmediate };
    },
  };
}

function executeCompiledGuestPreloadInSandbox(
  compiledJs: string,
  options: {
    argv: string[];
    dom: ReturnType<typeof createSandboxedGuestDom>;
    ipcRenderer: {
      on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void;
      removeListener: (
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) => void;
      send: (channel: string, ...args: unknown[]) => void;
    };
  },
): void {
  const exportsObj: Record<string, unknown> = {};
  const moduleObj = { exports: exportsObj };
  const sandboxRequire = (specifier: string) => {
    if (specifier !== "electron") {
      throw new Error(`Sandbox blocked non-allowlisted require("${specifier}")`);
    }
    return { ipcRenderer: options.ipcRenderer };
  };
  const runner = new Function(
    "require",
    "exports",
    "module",
    "process",
    "window",
    "document",
    compiledJs,
  );
  runner(
    sandboxRequire,
    exportsObj,
    moduleObj,
    { argv: options.argv },
    options.dom.win,
    options.dom.doc,
  );
}

function createElectron44GuestWebContentsFixture(options: {
  mainUrl: string;
  subFrameUrl: string;
}) {
  let ipcListener:
    | ((event: PersonaGuestIpcMainEventLike, channel: string, ...args: unknown[]) => void)
    | null = null;
  let destroyed = false;

  const mainFrame: Electron44MockFrame = {
    url: options.mainUrl,
    origin: new URL(options.mainUrl).origin,
    detached: false,
    parent: null,
    top: null,
    processId: 6,
    routingId: 4,
    osProcessId: 41001,
    frameTreeNodeId: 3,
    frameToken: "electron-main-frame-token",
    frames: [],
    framesInSubtree: [],
  };
  mainFrame.top = mainFrame;

  const subFrame: Electron44MockFrame = {
    url: options.subFrameUrl,
    origin: new URL(options.subFrameUrl).origin,
    detached: false,
    parent: mainFrame,
    top: mainFrame,
    processId: 6,
    routingId: 5,
    osProcessId: 41001,
    frameTreeNodeId: 4,
    frameToken: "electron-sub-frame-token",
    frames: [],
    framesInSubtree: [],
  };
  subFrame.framesInSubtree = [subFrame];
  mainFrame.frames = [subFrame];
  mainFrame.framesInSubtree = [mainFrame, subFrame];

  const contents: PersonaGuestIpcWebContentsLike = {
    id: 2,
    mainFrame,
    isDestroyed: () => destroyed,
    getType: () => "webview",
    getURL: () => mainFrame.url,
    on: (event, listener) => {
      if (event === "ipc-message") {
        ipcListener = listener;
      }
    },
  };

  return {
    contents,
    mainFrame,
    subFrame,
    setDestroyed: (next: boolean) => {
      destroyed = next;
    },
    emitFromFrame: (frame: PersonaGuestFrameLike | null, channel: string, ...args: unknown[]) => {
      const event: PersonaGuestIpcMainEventLike & { type: "frame"; ports: unknown[] } = {
        sender: contents,
        senderFrame: frame,
        processId: frame?.processId,
        frameId: frame?.routingId,
        type: "frame",
        ports: [],
      };
      ipcListener?.(event, channel, ...args);
    },
  };
}

describe("compiled guest-preload artifact and Electron 44 main-frame/sub-frame auth contract", () => {
  it("emits a sandbox-safe CJS guest-preload artifact that uses ipcRenderer.send and bridges end-to-end with main-process frame auth", async () => {
    const { compiledJs } = compilePersonaGuestPreloadArtifact();
    const inspection = inspectCompiledPreloadArtifact(compiledJs);

    expect(inspection.runtimeRequires).toEqual(["electron"]);
    expect(inspection.usesContextBridge).toBe(false);
    expect(inspection.usesSendToHost).toBe(false);

    const hubUrl = "http://127.0.0.1:18660";
    const mainUrl = `${hubUrl}/s/n37-217-003/sess_1`;
    const subFrameUrl = `${hubUrl}/embedded-iframe`;
    const guest = createElectron44GuestWebContentsFixture({ mainUrl, subFrameUrl });

    const onGuestOpenSession = vi.fn();
    const onGuestSessionMetadataResult = vi.fn();
    const onGuestReady = vi.fn();
    registerPersonaWebviewGuestIpcBridge(guest.contents, {
      getConfiguredHubUrl: () => hubUrl,
      onGuestOpenSession,
      onGuestSessionMetadataResult,
      onGuestReady,
    });

    const hostToGuestListeners = new Map<
      string,
      Array<(event: unknown, payload: unknown) => void>
    >();
    const mainIpcRenderer = {
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        const list = hostToGuestListeners.get(channel) ?? [];
        list.push(listener);
        hostToGuestListeners.set(channel, list);
      }),
      removeListener: vi.fn(),
      send: vi.fn((channel: string, ...args: unknown[]) => {
        guest.emitFromFrame(guest.mainFrame, channel, ...args);
      }),
    };

    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      expect(parsed.origin).toBe(hubUrl);
      expect(parsed.pathname).toBe("/api/v1/sessions");
      const sessionId = parsed.searchParams.get("session_id");
      return new Response(
        JSON.stringify({
          sessions: [
            {
              machine_id: "n37-217-003",
              session_id: sessionId,
              workspace_id: "wks_0123456789abcdef",
              cwd: "/data00/repo/paseo-fork",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const mainDom = createSandboxedGuestDom({
      href: mainUrl,
      isSubFrame: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    executeCompiledGuestPreloadInSandbox(compiledJs, {
      argv: ["electron", `${PERSONA_HUB_URL_ARG_PREFIX}${hubUrl}`],
      dom: mainDom,
      ipcRenderer: mainIpcRenderer,
    });

    // Compiled preload immediately emits ready via ipcRenderer.send and passes main-process mainFrame auth
    expect(onGuestReady).toHaveBeenCalledTimes(1);
    expect(onGuestReady).toHaveBeenCalledWith({
      guestWebContentsId: 2,
      frameUrl: mainUrl,
    });

    // Clicking a session anchor is intercepted by compiled preload and bridged via main-process auth
    const clickOutcome = mainDom.dispatchAnchorClick("/s/n37-217-003/sess_2");
    expect(clickOutcome).toEqual({ defaultPrevented: true, stoppedImmediate: true });
    await vi.waitFor(() => {
      expect(onGuestOpenSession).toHaveBeenCalledTimes(1);
    });
    expect(onGuestOpenSession).toHaveBeenCalledWith(
      {
        machineId: "n37-217-003",
        sessionId: "sess_2",
        workspaceIdHint: "wks_0123456789abcdef",
        cwdHint: "/data00/repo/paseo-fork",
        source: "link-click",
        rawHref: `${hubUrl}/s/n37-217-003/sess_2`,
      },
      { guestWebContentsId: 2, frameUrl: mainUrl },
    );

    // Host metadata lookup request routes through compiled preload -> main-process bridge
    for (const listener of hostToGuestListeners.get("paseo:persona:lookup-session-metadata") ??
      []) {
      listener({}, { requestId: "req-42", machineId: "n37-217-003", sessionId: "sess_2" });
    }
    await vi.waitFor(() => {
      expect(onGuestSessionMetadataResult).toHaveBeenCalledTimes(1);
    });
    expect(onGuestSessionMetadataResult).toHaveBeenCalledWith(
      {
        requestId: "req-42",
        machineId: "n37-217-003",
        sessionId: "sess_2",
        workspaceIdHint: "wks_0123456789abcdef",
        cwdHint: "/data00/repo/paseo-fork",
      },
      { guestWebContentsId: 2, frameUrl: mainUrl },
    );

    // Main-process bridge rejects same-origin Electron 44 subframe and structurally cloned mainFrame
    onGuestOpenSession.mockClear();
    onGuestSessionMetadataResult.mockClear();
    onGuestReady.mockClear();

    guest.emitFromFrame(guest.subFrame, PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL, {
      machineId: "n37-217-003",
      sessionId: "sess_sub",
      source: "link-click",
    });
    guest.emitFromFrame(guest.subFrame, PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL, {
      requestId: "req-sub",
      machineId: "n37-217-003",
      sessionId: "sess_sub",
    });
    guest.emitFromFrame(guest.subFrame, PERSONA_GUEST_READY_IPC_CHANNEL, { url: subFrameUrl });

    const clonedMainFrame: PersonaGuestFrameLike = {
      url: guest.mainFrame.url,
      origin: guest.mainFrame.origin,
      detached: false,
      parent: null,
      processId: guest.mainFrame.processId,
      routingId: guest.mainFrame.routingId,
    };
    Object.assign(clonedMainFrame, { top: clonedMainFrame });
    guest.emitFromFrame(clonedMainFrame, PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL, {
      machineId: "n37-217-003",
      sessionId: "sess_cloned",
      source: "link-click",
    });

    expect(onGuestOpenSession).not.toHaveBeenCalled();
    expect(onGuestSessionMetadataResult).not.toHaveBeenCalled();
    expect(onGuestReady).not.toHaveBeenCalled();
  });

  it("keeps compiled guest-preload inert in same-origin subframes, off-origin documents, and invalid Hub args", () => {
    const { compiledJs } = compilePersonaGuestPreloadArtifact();
    const hubUrl = "http://127.0.0.1:18660";

    const scenarios: Array<{ label: string; argv: string[]; href: string; isSubFrame: boolean }> = [
      {
        label: "same-origin subframe",
        argv: ["electron", `${PERSONA_HUB_URL_ARG_PREFIX}${hubUrl}`],
        href: `${hubUrl}/s/n37-217-003/sess_1`,
        isSubFrame: true,
      },
      {
        label: "off-origin top-level page",
        argv: ["electron", `${PERSONA_HUB_URL_ARG_PREFIX}${hubUrl}`],
        href: "https://evil.example.com/s/n37-217-003/sess_1",
        isSubFrame: false,
      },
      {
        label: "about:blank top-level page",
        argv: ["electron", `${PERSONA_HUB_URL_ARG_PREFIX}${hubUrl}`],
        href: "about:blank",
        isSubFrame: false,
      },
      {
        label: "missing hub argv",
        argv: ["electron"],
        href: `${hubUrl}/s/n37-217-003/sess_1`,
        isSubFrame: false,
      },
      {
        label: "invalid about:blank hub argv",
        argv: ["electron", `${PERSONA_HUB_URL_ARG_PREFIX}about:blank`],
        href: `${hubUrl}/s/n37-217-003/sess_1`,
        isSubFrame: false,
      },
      {
        label: "credentialed hub argv",
        argv: ["electron", `${PERSONA_HUB_URL_ARG_PREFIX}http://user:pass@127.0.0.1:18660`],
        href: `${hubUrl}/s/n37-217-003/sess_1`,
        isSubFrame: false,
      },
    ];

    for (const scenario of scenarios) {
      const ipcRenderer = {
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
      };
      const dom = createSandboxedGuestDom({
        href: scenario.href,
        isSubFrame: scenario.isSubFrame,
      });

      executeCompiledGuestPreloadInSandbox(compiledJs, {
        argv: scenario.argv,
        dom,
        ipcRenderer,
      });

      expect(ipcRenderer.on, scenario.label).not.toHaveBeenCalled();
      expect(ipcRenderer.send, scenario.label).not.toHaveBeenCalled();
    }
  });
});
