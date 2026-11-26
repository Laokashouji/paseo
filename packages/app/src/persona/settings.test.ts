import { describe, expect, it, vi } from "vitest";
import { normalizeAppSettings } from "@/hooks/use-settings/storage";
import {
  DEFAULT_PERSONA_EMBED_SETTINGS,
  DEFAULT_PERSONA_HUB_URL,
  formatPersonaHubDisplayHost,
  isMixedContentIframeBlocked,
  normalizePersonaEmbedSettings,
  normalizePersonaHubUrl,
  parsePersonaEmbedSessionRoute,
  sanitizeMachineServerMap,
  testPersonaHubHealth,
  validatePersonaGuestOpenSessionPayload,
  validatePersonaSessionMetadataResult,
} from "./settings";

describe("persona embed settings", () => {
  it("normalizes valid http/https Hub URLs and rejects unsafe schemes or credentials", () => {
    expect(normalizePersonaHubUrl("http://10.37.217.3:18660/")).toEqual({
      ok: true,
      url: "http://10.37.217.3:18660",
      origin: "http://10.37.217.3:18660",
      basePath: "",
      displayHost: "10.37.217.3:18660",
    });

    expect(normalizePersonaHubUrl("  https://hub.example.com/persona///  ")).toEqual({
      ok: true,
      url: "https://hub.example.com/persona",
      origin: "https://hub.example.com",
      basePath: "/persona",
      displayHost: "hub.example.com/persona",
    });

    expect(normalizePersonaHubUrl("")).toEqual({ ok: false, error: "empty" });
    expect(normalizePersonaHubUrl("   ")).toEqual({ ok: false, error: "empty" });
    expect(normalizePersonaHubUrl("file:///etc/passwd")).toEqual({
      ok: false,
      error: "invalid_protocol",
    });
    expect(normalizePersonaHubUrl("javascript:alert(1)")).toEqual({
      ok: false,
      error: "invalid_protocol",
    });
    expect(normalizePersonaHubUrl("http://user:pass@10.37.217.3:18660")).toEqual({
      ok: false,
      error: "credentials_not_allowed",
    });
    expect(normalizePersonaHubUrl("not a url")).toEqual({
      ok: false,
      error: "invalid_url",
    });
  });

  it("formats display host cleanly or returns null for invalid URLs", () => {
    expect(formatPersonaHubDisplayHost("http://10.37.217.3:18660/")).toBe("10.37.217.3:18660");
    expect(formatPersonaHubDisplayHost("http://127.0.0.1:18660")).toBe("127.0.0.1:18660");
    expect(formatPersonaHubDisplayHost("")).toBeNull();
    expect(formatPersonaHubDisplayHost("ftp://bad.host")).toBeNull();
  });

  it("sanitizes machineServerMap entries and upgrades legacy AppSettings safely", () => {
    expect(
      sanitizeMachineServerMap({
        " n37-217-003 ": " srv_P3Mj3qnxh-HU ",
        "": "srv_empty_key",
        "bad-val": "   ",
        "non-string": 123,
      }),
    ).toEqual({
      "n37-217-003": "srv_P3Mj3qnxh-HU",
    });

    // Legacy AppSettings payload without `persona` block upgrades cleanly with defaults
    const upgraded = normalizeAppSettings({ theme: "dark" });
    expect(upgraded.persona).toEqual(DEFAULT_PERSONA_EMBED_SETTINGS);

    // Invalid field types fall back to defaults without throwing
    const recovered = normalizePersonaEmbedSettings({
      enabled: true,
      hubUrl: "javascript:bad",
      machineServerMap: "not-an-object",
      hidePersonaSidebar: "invalid",
    });
    expect(recovered).toEqual({
      enabled: true,
      hubUrl: DEFAULT_PERSONA_HUB_URL,
      machineServerMap: {},
      hidePersonaSidebar: false,
      hideBuiltInMainChatWhenEnabled: true,
      interceptSessionClicks: true,
    });
  });

  it("tests Persona Hub health without sending credentials or tokens", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("http://10.37.217.3:18660/api/v1/health");
      expect(init?.credentials).toBe("omit");
      expect(init?.method).toBe("GET");
      return new Response(
        JSON.stringify({
          ok: true,
          hub_name: "n37-217-003",
          version: "0.9.1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const okResult = await testPersonaHubHealth("http://10.37.217.3:18660/", {
      fetchFn: fetchMock as unknown as typeof fetch,
    });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.hubName).toBe("n37-217-003");
      expect(okResult.version).toBe("0.9.1");
      expect(okResult.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const failFetch = vi.fn(async () => new Response("nope", { status: 503 }));
    const failResult = await testPersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: failFetch as unknown as typeof fetch,
    });
    expect(failResult).toEqual({ ok: false, code: "http_error", error: "HTTP 503" });

    const invalidResult = await testPersonaHubHealth("file:///etc/passwd");
    expect(invalidResult).toEqual({
      ok: false,
      code: "invalid_url",
      error: "invalid_protocol",
    });
  });

  it("delegates Electron health check to main process and distinguishes Web CORS unreadable vs network failure", async () => {
    // Electron path uses main-process checkHealth without calling fetch
    const electronCheckHealth = vi.fn(async () => ({
      ok: true as const,
      hubName: "main-probed-hub",
      version: "2.0.0",
      latencyMs: 12,
    }));
    const electronResult = await testPersonaHubHealth("http://127.0.0.1:18660", {
      electronCheckHealth,
    });
    expect(electronCheckHealth).toHaveBeenCalledTimes(1);
    expect(electronResult).toEqual({
      ok: true,
      hubName: "main-probed-hub",
      version: "2.0.0",
      latencyMs: 12,
    });

    // Web cross-origin CORS failure -> no-cors probe receives opaque response -> cors_unreadable
    const corsFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.mode === "no-cors") {
        return { type: "opaque", ok: false } as unknown as Response;
      }
      throw new TypeError("Failed to fetch");
    });
    const corsResult = await testPersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: corsFetch as unknown as typeof fetch,
      pageOriginOverride: "http://localhost:8081",
    });
    expect(corsResult.ok).toBe(false);
    if (!corsResult.ok) {
      expect(corsResult.code).toBe("cors_unreadable");
    }

    // Web cross-origin genuine network failure -> no-cors also throws -> network_error
    const offlineFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const offlineResult = await testPersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: offlineFetch as unknown as typeof fetch,
      pageOriginOverride: "http://localhost:8081",
    });
    expect(offlineResult.ok).toBe(false);
    if (!offlineResult.ok) {
      expect(offlineResult.code).toBe("network_error");
    }

    // Redirect on health check is explicitly blocked
    const redirectFetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }),
    );
    const redirectResult = await testPersonaHubHealth("http://127.0.0.1:18660", {
      fetchFn: redirectFetch as unknown as typeof fetch,
    });
    expect(redirectResult).toEqual({
      ok: false,
      code: "redirect_blocked",
      error: "Health check redirect blocked",
    });
  });

  it("validates guest open-session and session-metadata payloads strictly against field types, main frame, and origin", () => {
    const hubUrl = "http://127.0.0.1:18660";
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "n37-217-003",
          sessionId: "paseo-ag_1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/paseo-fork",
          panel: "diff",
          source: "link-click",
          rawHref: "http://127.0.0.1:18660/s/n37-217-003/paseo-ag_1",
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/",
          isMainFrame: true,
        },
      ),
    ).toEqual({
      machineId: "n37-217-003",
      sessionId: "paseo-ag_1",
      workspaceIdHint: "wks_0123456789abcdef",
      cwdHint: "/repo/paseo-fork",
      panel: "diff",
      source: "link-click",
      rawHref: "http://127.0.0.1:18660/s/n37-217-003/paseo-ag_1",
    });

    // Rejects subframe, off-origin guest URL, off-origin rawHref, and bad field types
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: "m1", sessionId: "s1", source: "link-click" },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/",
          isMainFrame: false,
        },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: "m1", sessionId: "s1", source: "link-click" },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "https://evil.example.com/",
          isMainFrame: true,
        },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "link-click",
          rawHref: "https://evil.example.com/s/m1/s1",
        },
        { authorizedHubUrl: hubUrl, currentGuestUrl: "http://127.0.0.1:18660/", isMainFrame: true },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: 123, sessionId: "s1", source: "link-click" },
        { authorizedHubUrl: hubUrl, currentGuestUrl: "http://127.0.0.1:18660/", isMainFrame: true },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: "m1", sessionId: "s1", source: "evil-source" },
        { authorizedHubUrl: hubUrl, currentGuestUrl: "http://127.0.0.1:18660/", isMainFrame: true },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: "m1", sessionId: "s1", source: "link-click", workspaceIdHint: { bad: true } },
        { authorizedHubUrl: hubUrl, currentGuestUrl: "http://127.0.0.1:18660/", isMainFrame: true },
      ),
    ).toBeNull();

    // Validates session metadata responses
    expect(
      validatePersonaSessionMetadataResult(
        {
          requestId: "req-1",
          machineId: "m1",
          sessionId: "s1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/app",
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/s/m1/s1",
          isMainFrame: true,
          expectedRequestId: "req-1",
          expectedMachineId: "m1",
          expectedSessionId: "s1",
        },
      ),
    ).toEqual({
      workspaceIdHint: "wks_0123456789abcdef",
      cwdHint: "/repo/app",
    });
    expect(
      validatePersonaSessionMetadataResult(
        {
          requestId: "req-other",
          machineId: "m1",
          sessionId: "s1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/app",
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/s/m1/s1",
          isMainFrame: true,
          expectedRequestId: "req-1",
          expectedMachineId: "m1",
          expectedSessionId: "s1",
        },
      ),
    ).toBeNull();
  });

  it("parses embedded session routes and detects HTTPS->HTTP mixed content", () => {
    expect(
      parsePersonaEmbedSessionRoute(
        "http://10.37.217.3:18660/s/n37-217-003/paseo-ag_1?view=chat",
        "http://10.37.217.3:18660",
      ),
    ).toEqual({
      machineId: "n37-217-003",
      sessionId: "paseo-ag_1",
      view: "chat",
    });

    expect(
      parsePersonaEmbedSessionRoute(
        "http://10.37.217.3:18660/persona/main-1",
        "http://10.37.217.3:18660",
      ),
    ).toBeNull();

    expect(isMixedContentIframeBlocked("https:", "http://10.37.217.3:18660")).toBe(true);
    expect(isMixedContentIframeBlocked("https:", "https://hub.example.com")).toBe(false);
    expect(isMixedContentIframeBlocked("http:", "http://10.37.217.3:18660")).toBe(false);
  });
});
