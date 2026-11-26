import { describe, expect, it, vi } from "vitest";
import { normalizeAppSettings } from "@/hooks/use-settings/storage";
import {
  addPersonaHubProfile,
  clampPersonaSplitRatio,
  closePersonaSplitPane,
  collectValidPersonaHubPartitionEntries,
  collectValidPersonaHubUrls,
  createPersonaHubId,
  DEFAULT_PERSONA_EMBED_SETTINGS,
  DEFAULT_PERSONA_HUB_ID,
  DEFAULT_PERSONA_HUB_NAME,
  DEFAULT_PERSONA_HUB_URL,
  DEFAULT_PERSONA_SPLIT_RATIO,
  formatPersonaHubDisplayHost,
  getActivePersonaHub,
  getSecondaryPersonaHub,
  isMixedContentIframeBlocked,
  MAX_PERSONA_HUB_ID_LENGTH,
  MAX_PERSONA_HUBS,
  MAX_PERSONA_SPLIT_RATIO,
  MIN_PERSONA_SPLIT_RATIO,
  normalizePersonaEmbedSettings,
  normalizePersonaHubUrl,
  openPersonaHubInRightSplit,
  parsePersonaEmbedSessionRoute,
  PERSONA_WEBVIEW_PARTITION,
  PERSONA_WEBVIEW_PARTITION_PREFIX,
  removePersonaHubProfile,
  reorderPersonaHubProfiles,
  resolvePersonaHubPartition,
  sanitizeMachineServerMap,
  selectActivePersonaHub,
  selectSecondaryPersonaHub,
  swapPersonaSplitPanes,
  testPersonaHubHealth,
  togglePersonaSplitMode,
  updatePersonaHubProfile,
  validatePersonaGuestOpenSessionPayload,
  validatePersonaGuestReadyPayload,
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
      hubs: [
        {
          id: DEFAULT_PERSONA_HUB_ID,
          name: DEFAULT_PERSONA_HUB_NAME,
          hubUrl: DEFAULT_PERSONA_HUB_URL,
          machineServerMap: {},
        },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
      splitEnabled: false,
      secondaryHubId: null,
      splitRatio: DEFAULT_PERSONA_SPLIT_RATIO,
      sidebarExpanded: false,
      hubUrl: DEFAULT_PERSONA_HUB_URL,
      machineServerMap: {},
      hidePersonaSidebar: false,
      hideBuiltInMainChatWhenEnabled: true,
      interceptSessionClicks: true,
    });
  });

  it("migrates 0.17.534 single-Hub settings with zero loss and strictly strips credentials or unsafe protocols", () => {
    const migrated = normalizeAppSettings({
      persona: {
        enabled: true,
        hubUrl: "https://corp-hub.example.com/persona///",
        machineServerMap: {
          "n37-217-003": "srv_devbox",
          "mac-ml9": "srv_mac",
        },
        hidePersonaSidebar: true,
        hideBuiltInMainChatWhenEnabled: false,
        interceptSessionClicks: true,
        // Unknown credential-like fields must never survive migration
        token: "secret-should-not-persist",
        password: "secret-password",
      },
    });

    expect(migrated.persona).toEqual({
      enabled: true,
      hubs: [
        {
          id: DEFAULT_PERSONA_HUB_ID,
          name: "corp-hub.example.com/persona",
          hubUrl: "https://corp-hub.example.com/persona",
          machineServerMap: {
            "n37-217-003": "srv_devbox",
            "mac-ml9": "srv_mac",
          },
        },
      ],
      activeHubId: DEFAULT_PERSONA_HUB_ID,
      splitEnabled: false,
      secondaryHubId: null,
      splitRatio: DEFAULT_PERSONA_SPLIT_RATIO,
      sidebarExpanded: false,
      hubUrl: "https://corp-hub.example.com/persona",
      machineServerMap: {
        "n37-217-003": "srv_devbox",
        "mac-ml9": "srv_mac",
      },
      hidePersonaSidebar: true,
      hideBuiltInMainChatWhenEnabled: false,
      interceptSessionClicks: true,
    });
    expect("token" in migrated.persona).toBe(false);
    expect("password" in migrated.persona).toBe(false);

    // Multi-Hub payload drops entries with credentials or non-HTTP(S) schemes, strips extra keys,
    // deduplicates IDs, clamps splitRatio, and enforces active/secondary invariants.
    const normalizedMulti = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "hub-work",
          name: " Work Hub \n ",
          hubUrl: "http://10.37.217.3:18660/",
          machineServerMap: { dev: "srv_work" },
          apiKey: "must-strip",
          cookie: "must-strip",
        },
        {
          id: "hub-bad-creds",
          name: "Creds",
          hubUrl: "http://admin:secret@10.37.217.4:18660",
          machineServerMap: {},
        },
        {
          id: "hub-bad-proto",
          name: "Proto",
          hubUrl: "file:///etc/passwd",
          machineServerMap: {},
        },
        {
          id: "hub-work", // duplicate id gets uniquified
          name: "Home Hub",
          hubUrl: "http://127.0.0.1:18661/",
          machineServerMap: { dev: "srv_home" },
        },
      ],
      activeHubId: "hub-work",
      splitEnabled: true,
      secondaryHubId: "hub-work", // cannot equal activeHubId -> auto-resolved to second hub
      splitRatio: 0.92, // clamped to MAX_PERSONA_SPLIT_RATIO
      sidebarExpanded: true,
    });

    expect(normalizedMulti.hubs).toEqual([
      {
        id: "hub-work",
        name: "Work Hub",
        hubUrl: "http://10.37.217.3:18660",
        machineServerMap: { dev: "srv_work" },
      },
      {
        id: "hub-work-2",
        name: "Home Hub",
        hubUrl: "http://127.0.0.1:18661",
        machineServerMap: { dev: "srv_home" },
      },
    ]);
    expect("apiKey" in normalizedMulti.hubs[0]).toBe(false);
    expect("cookie" in normalizedMulti.hubs[0]).toBe(false);
    expect(normalizedMulti.activeHubId).toBe("hub-work");
    expect(normalizedMulti.secondaryHubId).toBe("hub-work-2");
    expect(normalizedMulti.splitEnabled).toBe(true);
    expect(normalizedMulti.splitRatio).toBe(MAX_PERSONA_SPLIT_RATIO);
    expect(normalizedMulti.sidebarExpanded).toBe(true);
    expect(normalizedMulti.hubUrl).toBe("http://10.37.217.3:18660");
    expect(normalizedMulti.machineServerMap).toEqual({ dev: "srv_work" });

    // Single hub cannot stay in split mode
    const singleHubSplit = normalizePersonaEmbedSettings({
      hubs: [{ id: "only", name: "Only", hubUrl: "http://127.0.0.1:18660", machineServerMap: {} }],
      activeHubId: "only",
      splitEnabled: true,
      secondaryHubId: "only",
      splitRatio: 0.05,
    });
    expect(singleHubSplit.splitEnabled).toBe(false);
    expect(singleHubSplit.secondaryHubId).toBeNull();
    expect(singleHubSplit.splitRatio).toBe(MIN_PERSONA_SPLIT_RATIO);
    expect(clampPersonaSplitRatio(Number.NaN)).toBe(DEFAULT_PERSONA_SPLIT_RATIO);
  });

  it("supports multi-Hub CRUD, reordering, split toggle/swap/close, and validation boundaries", () => {
    let state = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "hub-a",
          name: "Hub A",
          hubUrl: "http://10.37.217.3:18660",
          machineServerMap: { m1: "srv_a" },
        },
      ],
      activeHubId: "hub-a",
    });

    // Rejects unsafe URLs on add
    expect(addPersonaHubProfile(state, { name: "Bad", hubUrl: "ftp://bad.host" })).toEqual({
      ok: false,
      error: "invalid_protocol",
    });
    expect(
      addPersonaHubProfile(state, { name: "Creds", hubUrl: "https://u:p@hub.example.com" }),
    ).toEqual({
      ok: false,
      error: "credentials_not_allowed",
    });

    // Adds second and third hubs
    const addB = addPersonaHubProfile(state, {
      id: "hub-b",
      name: "Hub B",
      hubUrl: "http://127.0.0.1:18661/",
      machineServerMap: { m1: "srv_b" },
    });
    expect(addB.ok).toBe(true);
    if (!addB.ok) return;
    state = addB.settings;

    const addC = addPersonaHubProfile(state, {
      id: "hub-c",
      name: "Hub C",
      hubUrl: "https://hub-c.example.com/persona/",
    });
    expect(addC.ok).toBe(true);
    if (!addC.ok) return;
    state = addC.settings;

    expect(collectValidPersonaHubUrls(state)).toEqual([
      "http://10.37.217.3:18660",
      "http://127.0.0.1:18661",
      "https://hub-c.example.com/persona",
    ]);

    // Partition resolution preserves persist:persona for hub-default and isolates additional Hubs
    const migratedWithExtra = addPersonaHubProfile(
      normalizePersonaEmbedSettings({
        enabled: true,
        hubUrl: "http://127.0.0.1:18660",
      }),
      { name: "Default", hubUrl: "http://127.0.0.1:18661" },
    );
    expect(migratedWithExtra.ok).toBe(true);
    if (migratedWithExtra.ok) {
      expect(migratedWithExtra.hub.id).not.toBe(DEFAULT_PERSONA_HUB_ID);
      expect(collectValidPersonaHubPartitionEntries(migratedWithExtra.settings)).toEqual([
        { partition: PERSONA_WEBVIEW_PARTITION, hubUrl: "http://127.0.0.1:18660" },
        {
          partition: `${PERSONA_WEBVIEW_PARTITION_PREFIX}${migratedWithExtra.hub.id}`,
          hubUrl: "http://127.0.0.1:18661",
        },
      ]);
      // Even after deleting hub-default, creating a Hub named "Default" never reuses hub-default
      const afterDeleteDefault = removePersonaHubProfile(
        migratedWithExtra.settings,
        DEFAULT_PERSONA_HUB_ID,
      );
      const readded = addPersonaHubProfile(afterDeleteDefault, {
        name: "Default",
        hubUrl: "http://127.0.0.1:18662",
      });
      expect(readded.ok).toBe(true);
      if (readded.ok) {
        expect(readded.hub.id).not.toBe(DEFAULT_PERSONA_HUB_ID);
        expect(resolvePersonaHubPartition(readded.hub.id)).toBe(
          `${PERSONA_WEBVIEW_PARTITION_PREFIX}${readded.hub.id}`,
        );
      }
    }

    // Enable split, open Hub C in right split, swap panes, select secondary as active swaps cleanly
    state = openPersonaHubInRightSplit(state, "hub-c");
    expect(state.splitEnabled).toBe(true);
    expect(getActivePersonaHub(state)?.id).toBe("hub-a");
    expect(getSecondaryPersonaHub(state)?.id).toBe("hub-c");

    state = swapPersonaSplitPanes(state);
    expect(state.activeHubId).toBe("hub-c");
    expect(state.secondaryHubId).toBe("hub-a");

    // Selecting current secondary hub as primary swaps panes without collapsing split
    state = selectActivePersonaHub(state, "hub-a");
    expect(state.activeHubId).toBe("hub-a");
    expect(state.secondaryHubId).toBe("hub-c");
    expect(state.splitEnabled).toBe(true);

    // Selecting current primary hub in right pane swaps panes cleanly
    state = selectSecondaryPersonaHub(state, "hub-a");
    expect(state.activeHubId).toBe("hub-c");
    expect(state.secondaryHubId).toBe("hub-a");

    // Closing primary pane promotes secondary to active and exits split
    state = closePersonaSplitPane(state, "primary");
    expect(state.splitEnabled).toBe(false);
    expect(state.activeHubId).toBe("hub-a");

    // Reordering preserves activeHubId & updates order
    state = reorderPersonaHubProfiles(state, 2, 0);
    expect(state.hubs.map((h) => h.id)).toEqual(["hub-c", "hub-a", "hub-b"]);
    expect(state.activeHubId).toBe("hub-a");

    // Updating a Hub's map keeps other Hubs isolated
    const updatedB = updatePersonaHubProfile(state, "hub-b", {
      name: "Home Mini",
      machineServerMap: { m1: "srv_home_updated" },
    });
    expect(updatedB.ok).toBe(true);
    if (!updatedB.ok) return;
    state = updatedB.settings;
    expect(state.hubs.find((h) => h.id === "hub-a")?.machineServerMap).toEqual({ m1: "srv_a" });
    expect(state.hubs.find((h) => h.id === "hub-b")?.machineServerMap).toEqual({
      m1: "srv_home_updated",
    });

    // Removing Hubs downgrades split cleanly when < 2 remain
    state = togglePersonaSplitMode(state, true);
    expect(state.splitEnabled).toBe(true);
    state = removePersonaHubProfile(state, "hub-c");
    expect(state.splitEnabled).toBe(true);
    state = removePersonaHubProfile(state, "hub-b");
    expect(state.hubs.map((h) => h.id)).toEqual(["hub-a"]);
    expect(state.splitEnabled).toBe(false);
    expect(state.secondaryHubId).toBeNull();

    // Cap enforcement at MAX_PERSONA_HUBS
    const fullState = normalizePersonaEmbedSettings({
      hubs: Array.from({ length: MAX_PERSONA_HUBS }, (_, idx) => ({
        id: `hub-${idx}`,
        name: `Hub ${idx}`,
        hubUrl: `http://127.0.0.1:${20000 + idx}`,
        machineServerMap: {},
      })),
    });
    expect(
      addPersonaHubProfile(fullState, { name: "Overflow", hubUrl: "http://127.0.0.1:29999" }),
    ).toEqual({ ok: false, error: "max_hubs_reached" });
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
    const electronCheckHealth = vi.fn(async (_hubUrl?: string) => ({
      ok: true as const,
      hubName: "main-probed-hub",
      version: "2.0.0",
      latencyMs: 12,
    }));
    const electronResult = await testPersonaHubHealth("http://127.0.0.1:18660/", {
      electronCheckHealth,
    });
    expect(electronCheckHealth).toHaveBeenCalledTimes(1);
    expect(electronCheckHealth).toHaveBeenCalledWith("http://127.0.0.1:18660");
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

  it("validates main-process verified guest open-session, ready, and session-metadata payloads fail-closed without fake isMainFrame flags", () => {
    const hubUrl = "http://127.0.0.1:18660";
    const guestId = 42;
    const validFrameUrl = "http://127.0.0.1:18660/s/n37-217-003/paseo-ag_1";

    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "n37-217-003",
          sessionId: "paseo-ag_1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/paseo-fork",
          panel: "diff",
          source: "link-click",
          rawHref: validFrameUrl,
          guestWebContentsId: guestId,
          frameUrl: validFrameUrl,
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/",
          expectedGuestWebContentsId: guestId,
        },
      ),
    ).toEqual({
      machineId: "n37-217-003",
      sessionId: "paseo-ag_1",
      workspaceIdHint: "wks_0123456789abcdef",
      cwdHint: "/repo/paseo-fork",
      panel: "diff",
      source: "link-click",
      rawHref: validFrameUrl,
    });

    // Fail-closed: rejects missing guestWebContentsId, mismatched guestWebContentsId, missing/off-origin frameUrl
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: "m1", sessionId: "s1", source: "link-click", frameUrl: validFrameUrl },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "link-click",
          guestWebContentsId: 99,
          frameUrl: validFrameUrl,
        },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        { machineId: "m1", sessionId: "s1", source: "link-click", guestWebContentsId: guestId },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "link-click",
          guestWebContentsId: guestId,
          frameUrl: "about:blank",
        },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "link-click",
          guestWebContentsId: guestId,
          frameUrl: "https://evil.example.com/s/m1/s1",
        },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "link-click",
          guestWebContentsId: guestId,
          frameUrl: validFrameUrl,
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "https://evil.example.com/",
          expectedGuestWebContentsId: guestId,
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
          guestWebContentsId: guestId,
          frameUrl: validFrameUrl,
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/",
          expectedGuestWebContentsId: guestId,
        },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: 123,
          sessionId: "s1",
          source: "link-click",
          guestWebContentsId: guestId,
          frameUrl: validFrameUrl,
        },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "evil-source",
          guestWebContentsId: guestId,
          frameUrl: validFrameUrl,
        },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();
    expect(
      validatePersonaGuestOpenSessionPayload(
        {
          machineId: "m1",
          sessionId: "s1",
          source: "link-click",
          workspaceIdHint: { bad: true },
          guestWebContentsId: guestId,
          frameUrl: validFrameUrl,
        },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toBeNull();

    // Validates session metadata responses fail-closed
    expect(
      validatePersonaSessionMetadataResult(
        {
          requestId: "req-1",
          machineId: "m1",
          sessionId: "s1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/app",
          guestWebContentsId: guestId,
          frameUrl: "http://127.0.0.1:18660/s/m1/s1",
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/s/m1/s1",
          expectedGuestWebContentsId: guestId,
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
          requestId: "req-1",
          machineId: "m1",
          sessionId: "s1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/app",
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/s/m1/s1",
          expectedGuestWebContentsId: guestId,
          expectedRequestId: "req-1",
          expectedMachineId: "m1",
          expectedSessionId: "s1",
        },
      ),
    ).toBeNull();
    expect(
      validatePersonaSessionMetadataResult(
        {
          requestId: "req-other",
          machineId: "m1",
          sessionId: "s1",
          workspaceIdHint: "wks_0123456789abcdef",
          cwdHint: "/repo/app",
          guestWebContentsId: guestId,
          frameUrl: "http://127.0.0.1:18660/s/m1/s1",
        },
        {
          authorizedHubUrl: hubUrl,
          currentGuestUrl: "http://127.0.0.1:18660/s/m1/s1",
          expectedGuestWebContentsId: guestId,
          expectedRequestId: "req-1",
          expectedMachineId: "m1",
          expectedSessionId: "s1",
        },
      ),
    ).toBeNull();

    // Validates ready payload fail-closed
    expect(
      validatePersonaGuestReadyPayload(
        { guestWebContentsId: guestId, frameUrl: "http://127.0.0.1:18660/" },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
      ),
    ).toEqual({ guestWebContentsId: guestId, frameUrl: "http://127.0.0.1:18660/" });
    expect(
      validatePersonaGuestReadyPayload(
        { guestWebContentsId: 99, frameUrl: "http://127.0.0.1:18660/" },
        { authorizedHubUrl: hubUrl, expectedGuestWebContentsId: guestId },
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

  it("allocates non-reusable random lowercase Hub IDs so deleting and re-adding a same-name Hub never reuses its partition", () => {
    let state = normalizePersonaEmbedSettings({
      enabled: true,
      hubUrl: "http://127.0.0.1:18660",
    });

    const addWork1 = addPersonaHubProfile(state, {
      name: "Work",
      hubUrl: "http://127.0.0.1:18661",
    });
    expect(addWork1.ok).toBe(true);
    if (!addWork1.ok) return;
    const workId1 = addWork1.hub.id;
    expect(workId1).toMatch(/^hub-work-[0-9a-f]{8}$/);
    expect(workId1).toBe(workId1.toLowerCase());
    expect(workId1).not.toBe("hub-work");
    const partition1 = resolvePersonaHubPartition(workId1);
    expect(partition1).toBe(`persist:persona-${workId1}`);

    // Delete Work, then re-create a Hub with the exact same name "Work"
    state = removePersonaHubProfile(addWork1.settings, workId1);
    const addWork2 = addPersonaHubProfile(state, {
      name: "Work",
      hubUrl: "http://127.0.0.1:18661",
    });
    expect(addWork2.ok).toBe(true);
    if (!addWork2.ok) return;
    const workId2 = addWork2.hub.id;
    expect(workId2).toMatch(/^hub-work-[0-9a-f]{8}$/);
    expect(workId2).not.toBe(workId1);
    expect(workId2).not.toBe("hub-work");
    expect(resolvePersonaHubPartition(workId2)).toBe(`persist:persona-${workId2}`);
    expect(resolvePersonaHubPartition(workId2)).not.toBe(partition1);

    // Direct createPersonaHubId also honors case-insensitive existing IDs and max length
    const generated = createPersonaHubId(new Set(["HUB-WORK"]), "A".repeat(80));
    expect(generated.length).toBeLessThanOrEqual(MAX_PERSONA_HUB_ID_LENGTH);
    expect(generated).toBe(generated.toLowerCase());

    // Explicit hub-default / HUB-DEFAULT request cannot hijack the migrated persist:persona partition
    const afterDeleteDefault = removePersonaHubProfile(addWork2.settings, DEFAULT_PERSONA_HUB_ID);
    const hijackAttempt = addPersonaHubProfile(afterDeleteDefault, {
      id: "HUB-DEFAULT",
      name: "Default",
      hubUrl: "http://127.0.0.1:18662",
    });
    expect(hijackAttempt.ok).toBe(true);
    if (hijackAttempt.ok) {
      expect(hijackAttempt.hub.id).not.toBe(DEFAULT_PERSONA_HUB_ID);
      expect(resolvePersonaHubPartition(hijackAttempt.hub.id)).not.toBe(PERSONA_WEBVIEW_PARTITION);
    }
  });

  it("prioritizes exact lowercase Hub IDs over earlier mixed-case collisions while preserving activeHubId/secondaryHubId references", () => {
    expect(resolvePersonaHubPartition("hub-Case")).toBe("persist:persona-hub-case");
    expect(resolvePersonaHubPartition("HUB-DEFAULT")).toBe(PERSONA_WEBVIEW_PARTITION);

    // [hub-Case, hub-case]: exact lowercase hub-case retains its canonical ID & partition
    const normalized = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "hub-Case",
          name: "Upper Hub",
          hubUrl: "http://127.0.0.1:18660",
          machineServerMap: { box: "srv_upper" },
        },
        {
          id: "hub-case",
          name: "Lower Hub",
          hubUrl: "http://127.0.0.1:18661",
          machineServerMap: { box: "srv_lower" },
        },
      ],
      activeHubId: "hub-case",
      splitEnabled: true,
      secondaryHubId: "hub-Case",
    });

    expect(normalized.hubs.map((h) => ({ id: h.id, name: h.name }))).toEqual([
      { id: "hub-case-2", name: "Upper Hub" },
      { id: "hub-case", name: "Lower Hub" },
    ]);
    // Exact raw ID references survive disambiguation without flipping primary and secondary panes
    expect(normalized.activeHubId).toBe("hub-case");
    expect(normalized.secondaryHubId).toBe("hub-case-2");
    expect(normalized.splitEnabled).toBe(true);
    expect(normalized.hubUrl).toBe("http://127.0.0.1:18661");
    expect(normalized.machineServerMap).toEqual({ box: "srv_lower" });
    expect(collectValidPersonaHubPartitionEntries(normalized)).toEqual([
      { partition: "persist:persona-hub-case-2", hubUrl: "http://127.0.0.1:18660" },
      { partition: "persist:persona-hub-case", hubUrl: "http://127.0.0.1:18661" },
    ]);
    expect(normalizePersonaEmbedSettings(normalized)).toEqual(normalized);

    // Existing hub-case and hub-case-2 both keep their exact lowercase IDs when hub-Case collides
    const withExistingSuffix = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        { id: "hub-Case", name: "Upper", hubUrl: "http://127.0.0.1:18660", machineServerMap: {} },
        { id: "hub-case", name: "Lower", hubUrl: "http://127.0.0.1:18661", machineServerMap: {} },
        {
          id: "hub-case-2",
          name: "Existing Two",
          hubUrl: "http://127.0.0.1:18662",
          machineServerMap: {},
        },
      ],
      activeHubId: "hub-case-2",
      splitEnabled: true,
      secondaryHubId: "hub-Case",
    });
    expect(withExistingSuffix.hubs.map((h) => h.id)).toEqual([
      "hub-case-3",
      "hub-case",
      "hub-case-2",
    ]);
    expect(withExistingSuffix.activeHubId).toBe("hub-case-2");
    expect(withExistingSuffix.secondaryHubId).toBe("hub-case-3");

    // When neither colliding entry is exact lowercase, the first entry claims the canonical ID
    const mixedOnly = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "hub-Case",
          name: "Mixed One",
          hubUrl: "http://127.0.0.1:18660",
          machineServerMap: {},
        },
        {
          id: "HUB-CASE",
          name: "Mixed Two",
          hubUrl: "http://127.0.0.1:18661",
          machineServerMap: {},
        },
      ],
      activeHubId: "HUB-CASE",
      splitEnabled: true,
      secondaryHubId: "hub-Case",
    });
    expect(mixedOnly.hubs.map((h) => h.id)).toEqual(["hub-case", "hub-case-2"]);
    expect(mixedOnly.activeHubId).toBe("hub-case-2");
    expect(mixedOnly.secondaryHubId).toBe("hub-case");

    // [Hub-Default, hub-default]: exact lowercase hub-default keeps DEFAULT_PERSONA_HUB_ID & persist:persona
    const defaultCollisionPrimaryLower = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "Hub-Default",
          name: "Mixed Default",
          hubUrl: "http://127.0.0.1:18660",
          machineServerMap: { box: "srv_mixed" },
        },
        {
          id: "  hub-default  ",
          name: "Exact Default",
          hubUrl: "http://127.0.0.1:18661",
          machineServerMap: { box: "srv_default" },
        },
      ],
      activeHubId: "hub-default",
      secondaryHubId: "Hub-Default",
      splitEnabled: true,
    });
    expect(defaultCollisionPrimaryLower.hubs.map((h) => ({ id: h.id, name: h.name }))).toEqual([
      { id: "hub-default-2", name: "Mixed Default" },
      { id: DEFAULT_PERSONA_HUB_ID, name: "Exact Default" },
    ]);
    expect(defaultCollisionPrimaryLower.activeHubId).toBe(DEFAULT_PERSONA_HUB_ID);
    expect(defaultCollisionPrimaryLower.secondaryHubId).toBe("hub-default-2");
    expect(defaultCollisionPrimaryLower.hubUrl).toBe("http://127.0.0.1:18661");
    expect(defaultCollisionPrimaryLower.machineServerMap).toEqual({ box: "srv_default" });
    expect(collectValidPersonaHubPartitionEntries(defaultCollisionPrimaryLower)).toEqual([
      { partition: "persist:persona-hub-default-2", hubUrl: "http://127.0.0.1:18660" },
      { partition: PERSONA_WEBVIEW_PARTITION, hubUrl: "http://127.0.0.1:18661" },
    ]);

    // Even when mixed-case Hub-Default is selected as activeHubId, hub-default still owns persist:persona
    const defaultCollisionPrimaryMixed = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "Hub-Default",
          name: "Mixed Default",
          hubUrl: "http://127.0.0.1:18660",
          machineServerMap: { box: "srv_mixed" },
        },
        {
          id: "hub-default",
          name: "Exact Default",
          hubUrl: "http://127.0.0.1:18661",
          machineServerMap: { box: "srv_default" },
        },
      ],
      activeHubId: "Hub-Default",
      secondaryHubId: "HUB-DEFAULT",
      splitEnabled: true,
    });
    expect(defaultCollisionPrimaryMixed.hubs.map((h) => h.id)).toEqual([
      "hub-default-2",
      DEFAULT_PERSONA_HUB_ID,
    ]);
    expect(defaultCollisionPrimaryMixed.activeHubId).toBe("hub-default-2");
    expect(defaultCollisionPrimaryMixed.secondaryHubId).toBe(DEFAULT_PERSONA_HUB_ID);
    expect(defaultCollisionPrimaryMixed.hubUrl).toBe("http://127.0.0.1:18660");
    expect(defaultCollisionPrimaryMixed.machineServerMap).toEqual({ box: "srv_mixed" });

    // Hub-Default + hub-default and max-length 64-char collisions preserve exact lowercase owners & <= 64 chars
    const maxLenLower = "a".repeat(MAX_PERSONA_HUB_ID_LENGTH);
    const maxLenUpper = "A".repeat(MAX_PERSONA_HUB_ID_LENGTH);
    const edgeCase = normalizePersonaEmbedSettings({
      enabled: true,
      hubs: [
        {
          id: "Hub-Default",
          name: "Default Upper",
          hubUrl: "http://127.0.0.1:18660",
          machineServerMap: {},
        },
        {
          id: "hub-default",
          name: "Default Lower",
          hubUrl: "http://127.0.0.1:18661",
          machineServerMap: {},
        },
        {
          id: maxLenUpper,
          name: "Long Upper",
          hubUrl: "http://127.0.0.1:18662",
          machineServerMap: {},
        },
        {
          id: maxLenLower,
          name: "Long Lower",
          hubUrl: "http://127.0.0.1:18663",
          machineServerMap: {},
        },
      ],
      activeHubId: maxLenLower,
      secondaryHubId: "Hub-Default",
      splitEnabled: true,
    });
    expect(edgeCase.hubs[0]?.id).toBe("hub-default-2");
    expect(edgeCase.hubs[1]?.id).toBe(DEFAULT_PERSONA_HUB_ID);
    expect(resolvePersonaHubPartition(edgeCase.hubs[1]?.id)).toBe(PERSONA_WEBVIEW_PARTITION);
    expect(edgeCase.hubs[2]?.id.length).toBeLessThanOrEqual(MAX_PERSONA_HUB_ID_LENGTH);
    expect(edgeCase.hubs[2]?.id).not.toBe(maxLenLower);
    expect(edgeCase.hubs[3]?.id).toBe(maxLenLower);
    expect(edgeCase.activeHubId).toBe(maxLenLower);
    expect(edgeCase.secondaryHubId).toBe("hub-default-2");
    const entries = collectValidPersonaHubPartitionEntries(edgeCase);
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map((entry) => entry.partition)).size).toBe(4);
    for (const entry of entries) {
      expect(entry.partition).toBe(entry.partition.toLowerCase());
    }
  });
});
