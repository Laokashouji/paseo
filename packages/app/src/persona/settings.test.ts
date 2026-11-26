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
    const failResult = await testPersonaHubHealth("http://10.37.217.3:18660", {
      fetchFn: failFetch as unknown as typeof fetch,
    });
    expect(failResult).toEqual({ ok: false, error: "HTTP 503" });

    const invalidResult = await testPersonaHubHealth("file:///etc/passwd");
    expect(invalidResult).toEqual({ ok: false, error: "invalid_protocol" });
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
