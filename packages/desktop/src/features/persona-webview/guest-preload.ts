import { ipcRenderer } from "electron";

// Sandboxed Electron <webview> guest preload: MUST NOT load any runtime module
// other than "electron", and MUST NOT expose ipcRenderer via contextBridge.

const PERSONA_HUB_URL_ARG_PREFIX = "--paseo-persona-hub-url=";
const CONFIG_CHANNEL = "paseo:persona:config";
const ROUTE_SYNC_CHANNEL = "paseo:persona:route-sync";
const ALLOW_ONCE_CHANNEL = "paseo:persona:allow-once";
const OPEN_SESSION_CHANNEL = "paseo:persona:open-session";
const LOOKUP_SESSION_METADATA_CHANNEL = "paseo:persona:lookup-session-metadata";
const SESSION_METADATA_RESULT_CHANNEL = "paseo:persona:session-metadata-result";
const READY_CHANNEL = "paseo:persona:ready";

const HIDE_SIDEBAR_STYLE_ID = "paseo-persona-hide-sidebar";
const ACTION_STYLE_ID = "paseo-persona-open-actions-style";
const ACTION_CONTAINER_ATTR = "data-paseo-injected";
const ACTION_CONTAINER_VALUE = "open-actions";

const METADATA_CACHE_TTL_MS = 30_000;
const METADATA_NEGATIVE_CACHE_TTL_MS = 3_000;
const METADATA_FETCH_TIMEOUT_MS = 1_200;

interface GuestLabels {
  openInPaseo: string;
  openDiffInPaseo: string;
  openInPaseoTooltip: string;
  openDiffTooltip: string;
}

interface GuestConfig {
  hubBasePath: string;
  hidePersonaSidebar: boolean;
  interceptSessionClicks: boolean;
  labels: GuestLabels;
}

interface ParsedSessionTarget {
  machineId: string;
  sessionId: string;
}

export interface PersonaSessionMetadataHints {
  workspaceIdHint: string | null;
  cwdHint: string | null;
}

interface MetadataCacheEntry {
  hints: PersonaSessionMetadataHints | null;
  expiresAt: number;
}

export interface PersonaGuestIpcLike {
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener?(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  sendToHost(channel: string, ...args: unknown[]): void;
}

export type PersonaGuestWindow = Window & typeof globalThis;

export interface PersonaGuestMountOptions {
  ipc: PersonaGuestIpcLike;
  authorizedHubUrl: string | null;
  win?: PersonaGuestWindow;
  doc?: Document;
  fetchFn?: typeof fetch;
  metadataTimeoutMs?: number;
  /** Defaults to `win.self === win.top`; overridable in iframe-hosted browser test runners. */
  isMainFrame?: () => boolean;
}

export interface PersonaGuestController {
  isActive(): boolean;
  syncNow(): void;
  dispose(): void;
}

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" || trimmed === "/" ? "" : trimmed;
}

function parseAuthorizedHub(
  rawUrl: string | null | undefined,
): { origin: string; basePath: string } | null {
  if (typeof rawUrl !== "string") {
    return null;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  return {
    origin: parsed.origin,
    basePath: normalizeBasePath(parsed.pathname),
  };
}

function readAuthorizedHubUrlFromArgv(argv: readonly string[] | undefined): string | null {
  if (!Array.isArray(argv)) {
    return null;
  }
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const arg = argv[index];
    if (typeof arg === "string" && arg.startsWith(PERSONA_HUB_URL_ARG_PREFIX)) {
      return arg.slice(PERSONA_HUB_URL_ARG_PREFIX.length);
    }
  }
  return null;
}

function safeDecodeSegment(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw).trim();
    if (!decoded || decoded.includes("/") || decoded.includes("\\")) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function isNonEmptySafeToken(value: unknown, maxLength = 256): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength;
}

function readStoredPersonaAuthToken(win: Window): string {
  try {
    const storage = win.localStorage;
    if (!storage) {
      return "";
    }
    const primary = storage.getItem("persona.token");
    if (typeof primary === "string" && primary.trim().length > 0) {
      return primary.trim();
    }
    const legacy = storage.getItem("jarvis.token");
    return typeof legacy === "string" ? legacy.trim() : "";
  } catch {
    return "";
  }
}

function extractSessionMetadataFromPayload(
  payload: unknown,
  machineId: string,
  sessionId: string,
): PersonaSessionMetadataHints | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const sessions = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    return null;
  }
  const match = sessions.find((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const record = entry as Record<string, unknown>;
    if (record.session_id !== sessionId) {
      return false;
    }
    if (
      typeof record.machine_id === "string" &&
      record.machine_id.trim().length > 0 &&
      record.machine_id !== machineId
    ) {
      return false;
    }
    return true;
  }) as Record<string, unknown> | undefined;

  if (!match) {
    return null;
  }
  const rawWorkspaceId = match.workspace_id;
  const rawCwd = match.cwd;
  const workspaceIdHint =
    typeof rawWorkspaceId === "string" && rawWorkspaceId.trim().length > 0
      ? rawWorkspaceId.trim()
      : null;
  const cwdHint = typeof rawCwd === "string" && rawCwd.trim().length > 0 ? rawCwd.trim() : null;
  return { workspaceIdHint, cwdHint };
}

function syncButtonContent(button: HTMLButtonElement, label: string, tooltip: string): void {
  if (button.textContent !== label) {
    button.textContent = label;
  }
  if (button.title !== tooltip) {
    button.title = tooltip;
  }
  if (button.getAttribute("aria-label") !== tooltip) {
    button.setAttribute("aria-label", tooltip);
  }
}

export function mountPersonaGuestPreload(
  options: PersonaGuestMountOptions,
): PersonaGuestController {
  const authorizedHub = parseAuthorizedHub(options.authorizedHubUrl);
  const win =
    options.win ?? (typeof window !== "undefined" ? (window as PersonaGuestWindow) : undefined);
  const doc = options.doc ?? (typeof document !== "undefined" ? document : undefined);

  const isAuthorizedMainDocument = (): boolean => {
    if (!authorizedHub || !win || !doc) {
      return false;
    }
    try {
      const mainFrame = options.isMainFrame ? options.isMainFrame() : win.self === win.top;
      if (!mainFrame) {
        return false;
      }
      const location = win.location;
      if (!location || (location.protocol !== "http:" && location.protocol !== "https:")) {
        return false;
      }
      return location.origin === authorizedHub.origin;
    } catch {
      return false;
    }
  };

  if (!isAuthorizedMainDocument() || !authorizedHub || !win || !doc) {
    return {
      isActive: () => false,
      syncNow: () => undefined,
      dispose: () => undefined,
    };
  }

  const fetchImpl =
    options.fetchFn ?? (typeof win.fetch === "function" ? win.fetch.bind(win) : globalThis.fetch);
  const metadataTimeoutMs = options.metadataTimeoutMs ?? METADATA_FETCH_TIMEOUT_MS;

  let config: GuestConfig = {
    hubBasePath: authorizedHub.basePath,
    hidePersonaSidebar: false,
    interceptSessionClicks: true,
    labels: {
      openInPaseo: "Open in Paseo",
      openDiffInPaseo: "Diff",
      openInPaseoTooltip: "Open this agent session in Paseo",
      openDiffTooltip: "Open working diff in Paseo",
    },
  };

  let disposed = false;
  let latestRouteUrl = win.location.href;
  let allowOnceHref: string | null = null;
  let syncRafId: number | null = null;
  let observer: MutationObserver | null = null;

  const metadataCache = new Map<string, MetadataCacheEntry>();
  const metadataInFlight = new Map<string, Promise<PersonaSessionMetadataHints | null>>();

  const readDocumentBasePath = (): string => {
    const baseEl = doc.querySelector("base[href]");
    const rawHref = baseEl?.getAttribute("href");
    if (rawHref) {
      try {
        const parsedBase = new URL(rawHref, win.location.href);
        if (parsedBase.origin === authorizedHub.origin) {
          return normalizeBasePath(parsedBase.pathname);
        }
      } catch {
        // Fall through to configured base path.
      }
    }
    return normalizeBasePath(config.hubBasePath || authorizedHub.basePath);
  };

  const resolveBaseUrl = (): string => {
    if (doc.baseURI) {
      return doc.baseURI;
    }
    return win.location.href || authorizedHub.origin;
  };

  const parseSessionUrl = (rawUrl: string): ParsedSessionTarget | null => {
    if (!rawUrl) {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl, resolveBaseUrl());
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.origin !== authorizedHub.origin) {
      return null;
    }

    const basePath = readDocumentBasePath();
    let relativePath = parsed.pathname;
    if (basePath) {
      if (relativePath === basePath) {
        relativePath = "/";
      } else if (relativePath.startsWith(`${basePath}/`)) {
        relativePath = relativePath.slice(basePath.length);
      } else {
        return null;
      }
    }

    let rawMid: string | undefined;
    let rawSid: string | undefined;

    const sessionMatch = /^\/s\/([^/?#]+)\/([^/?#]+)(?:\/|$)/.exec(relativePath);
    if (sessionMatch) {
      rawMid = sessionMatch[1];
      rawSid = sessionMatch[2];
    } else {
      const tabMatch = /^\/t\/([^/?#]+)\/[^/?#]+\/[^/?#]+\/([^/?#]+)(?:\/|$)/.exec(relativePath);
      if (tabMatch) {
        rawMid = tabMatch[1];
        rawSid = tabMatch[2];
      }
    }

    if (!rawMid || !rawSid) {
      return null;
    }

    const machineId = safeDecodeSegment(rawMid);
    const sessionId = safeDecodeSegment(rawSid);
    if (!machineId || !sessionId) {
      return null;
    }
    return { machineId, sessionId };
  };

  const fetchTrustedSessionMetadata = async (
    machineId: string,
    sessionId: string,
  ): Promise<PersonaSessionMetadataHints | null> => {
    if (disposed || !isAuthorizedMainDocument() || typeof fetchImpl !== "function") {
      return null;
    }
    const cacheKey = `${machineId}\0${sessionId}`;
    const now = Date.now();
    const cached = metadataCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.hints;
    }

    const existingPromise = metadataInFlight.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const requestPromise = (async (): Promise<PersonaSessionMetadataHints | null> => {
      const basePath = readDocumentBasePath();
      const endpoint = new URL(
        `${basePath}/api/v1/sessions?machine_id=${encodeURIComponent(machineId)}&session_id=${encodeURIComponent(sessionId)}`,
        `${authorizedHub.origin}/`,
      );
      if (endpoint.origin !== authorizedHub.origin) {
        return null;
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      const token = readStoredPersonaAuthToken(win);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller ? win.setTimeout(() => controller.abort(), metadataTimeoutMs) : null;
      try {
        const response = await fetchImpl(endpoint.toString(), {
          method: "GET",
          credentials: "same-origin",
          headers,
          signal: controller?.signal,
        });
        if (!response.ok) {
          metadataCache.set(cacheKey, {
            hints: null,
            expiresAt: Date.now() + METADATA_NEGATIVE_CACHE_TTL_MS,
          });
          return null;
        }
        const payload: unknown = await response.json();
        const hints = extractSessionMetadataFromPayload(payload, machineId, sessionId);
        metadataCache.set(cacheKey, {
          hints,
          expiresAt: Date.now() + (hints ? METADATA_CACHE_TTL_MS : METADATA_NEGATIVE_CACHE_TTL_MS),
        });
        return hints;
      } catch {
        metadataCache.set(cacheKey, {
          hints: null,
          expiresAt: Date.now() + METADATA_NEGATIVE_CACHE_TTL_MS,
        });
        return null;
      } finally {
        if (timer !== null) {
          win.clearTimeout(timer);
        }
        metadataInFlight.delete(cacheKey);
      }
    })();

    metadataInFlight.set(cacheKey, requestPromise);
    return requestPromise;
  };

  const emitOpenSession = (input: {
    machineId: string;
    sessionId: string;
    panel?: "diff";
    source: "link-click" | "header-button" | "changes-panel-button";
    rawHref: string;
  }): void => {
    if (disposed || !isAuthorizedMainDocument()) {
      return;
    }
    void (async () => {
      const hints = await fetchTrustedSessionMetadata(input.machineId, input.sessionId);
      if (disposed || !isAuthorizedMainDocument()) {
        return;
      }
      options.ipc.sendToHost(OPEN_SESSION_CHANNEL, {
        machineId: input.machineId,
        sessionId: input.sessionId,
        ...(input.panel ? { panel: input.panel } : {}),
        ...(hints?.workspaceIdHint ? { workspaceIdHint: hints.workspaceIdHint } : {}),
        ...(hints?.cwdHint ? { cwdHint: hints.cwdHint } : {}),
        source: input.source,
        rawHref: input.rawHref,
      });
    })();
  };

  const syncHideSidebarStyle = (): void => {
    if (!doc.head) {
      return;
    }
    const existing = doc.getElementById(HIDE_SIDEBAR_STYLE_ID);
    if (!config.hidePersonaSidebar) {
      existing?.remove();
      return;
    }
    const cssText =
      "@media (min-width: 1024px) { [data-app-shell] > [data-sidebar-column] { display: none !important; } }";
    if (existing) {
      if (existing.textContent !== cssText) {
        existing.textContent = cssText;
      }
      return;
    }
    const style = doc.createElement("style");
    style.id = HIDE_SIDEBAR_STYLE_ID;
    style.textContent = cssText;
    doc.head.appendChild(style);
  };

  const ensureActionStyles = (): void => {
    if (!doc.head || doc.getElementById(ACTION_STYLE_ID)) {
      return;
    }
    const style = doc.createElement("style");
    style.id = ACTION_STYLE_ID;
    style.textContent = [
      `[${ACTION_CONTAINER_ATTR}="${ACTION_CONTAINER_VALUE}"] {`,
      "  display: inline-flex;",
      "  align-items: center;",
      "  gap: 6px;",
      "  margin-right: 6px;",
      "  flex-shrink: 0;",
      "}",
      `[${ACTION_CONTAINER_ATTR}="${ACTION_CONTAINER_VALUE}"] button {`,
      "  display: inline-flex;",
      "  align-items: center;",
      "  height: 28px;",
      "  padding: 0 10px;",
      "  border-radius: 9999px;",
      "  border: 1px solid var(--line, rgba(128, 128, 128, 0.28));",
      "  background: transparent;",
      "  color: var(--ink, currentColor);",
      "  font-size: 12px;",
      "  font-weight: 500;",
      "  line-height: 1;",
      "  cursor: pointer;",
      "  white-space: nowrap;",
      "  transition: background-color 120ms ease;",
      "}",
      `[${ACTION_CONTAINER_ATTR}="${ACTION_CONTAINER_VALUE}"] button:hover {`,
      "  background: var(--hover, rgba(128, 128, 128, 0.14));",
      "}",
    ].join("\n");
    doc.head.appendChild(style);
  };

  const removeInjectedHeaderActions = (): void => {
    const nodes = doc.querySelectorAll(`[${ACTION_CONTAINER_ATTR}="${ACTION_CONTAINER_VALUE}"]`);
    for (let index = 0; index < nodes.length; index += 1) {
      nodes[index]?.remove();
    }
  };

  const createActionButton = (
    role: "open" | "diff",
    label: string,
    tooltip: string,
    onClick: () => void,
  ): HTMLButtonElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.paseoAction = role;
    button.textContent = label;
    button.title = tooltip;
    button.setAttribute("aria-label", tooltip);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  };

  const syncInjectedHeaderActions = (): void => {
    if (!isAuthorizedMainDocument()) {
      removeInjectedHeaderActions();
      return;
    }
    const currentUrl = latestRouteUrl || win.location.href;
    const target = parseSessionUrl(currentUrl);
    if (!target) {
      removeInjectedHeaderActions();
      return;
    }

    const slot = doc.querySelector("main header > div:last-child");
    if (!slot || !(slot instanceof win.HTMLElement)) {
      return;
    }

    ensureActionStyles();

    const existing = slot.querySelector(
      `[${ACTION_CONTAINER_ATTR}="${ACTION_CONTAINER_VALUE}"]`,
    ) as HTMLElement | null;

    if (
      existing &&
      existing.dataset.machineId === target.machineId &&
      existing.dataset.sessionId === target.sessionId
    ) {
      const openBtn = existing.querySelector('button[data-paseo-action="open"]');
      const diffBtn = existing.querySelector('button[data-paseo-action="diff"]');
      if (openBtn instanceof win.HTMLButtonElement) {
        syncButtonContent(openBtn, config.labels.openInPaseo, config.labels.openInPaseoTooltip);
      }
      if (diffBtn instanceof win.HTMLButtonElement) {
        syncButtonContent(diffBtn, config.labels.openDiffInPaseo, config.labels.openDiffTooltip);
      }
      return;
    }

    // Warm same-origin metadata cache once when entering a new session view.
    void fetchTrustedSessionMetadata(target.machineId, target.sessionId);

    removeInjectedHeaderActions();

    const container = doc.createElement("span");
    container.setAttribute(ACTION_CONTAINER_ATTR, ACTION_CONTAINER_VALUE);
    container.dataset.machineId = target.machineId;
    container.dataset.sessionId = target.sessionId;

    const openButton = createActionButton(
      "open",
      config.labels.openInPaseo,
      config.labels.openInPaseoTooltip,
      () => {
        emitOpenSession({
          machineId: target.machineId,
          sessionId: target.sessionId,
          source: "header-button",
          rawHref: currentUrl,
        });
      },
    );

    const diffButton = createActionButton(
      "diff",
      config.labels.openDiffInPaseo,
      config.labels.openDiffTooltip,
      () => {
        const hasChangesPanel = Boolean(
          doc.querySelector("[data-changes-panel], [data-git-review]"),
        );
        emitOpenSession({
          machineId: target.machineId,
          sessionId: target.sessionId,
          panel: "diff",
          source: hasChangesPanel ? "changes-panel-button" : "header-button",
          rawHref: currentUrl,
        });
      },
    );

    container.appendChild(openButton);
    container.appendChild(diffButton);
    slot.insertBefore(container, slot.firstChild);
  };

  const syncDom = (): void => {
    if (disposed || !isAuthorizedMainDocument()) {
      return;
    }
    syncHideSidebarStyle();
    syncInjectedHeaderActions();
  };

  const scheduleDomSync = (): void => {
    if (disposed || syncRafId !== null) {
      return;
    }
    syncRafId = win.requestAnimationFrame(() => {
      syncRafId = null;
      syncDom();
    });
  };

  const resolveEventTargetElement = (target: EventTarget | null): Element | null => {
    if (target instanceof win.Element) {
      return target;
    }
    if (target instanceof win.Node) {
      return target.parentElement;
    }
    return null;
  };

  const handleDocumentClick = (event: MouseEvent): void => {
    if (disposed || !config.interceptSessionClicks || !isAuthorizedMainDocument()) {
      return;
    }
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const targetElement = resolveEventTargetElement(event.target);
    if (!targetElement) {
      return;
    }

    const anchor = targetElement.closest("a[href]");
    if (!(anchor instanceof win.HTMLAnchorElement)) {
      return;
    }

    const rawHrefAttr = anchor.getAttribute("href");
    if (!rawHrefAttr) {
      return;
    }

    let resolvedUrl: URL;
    try {
      resolvedUrl = new URL(rawHrefAttr, doc.baseURI || win.location.href);
    } catch {
      return;
    }

    if (allowOnceHref && resolvedUrl.href === allowOnceHref) {
      allowOnceHref = null;
      return;
    }

    const parsed = parseSessionUrl(resolvedUrl.href);
    if (!parsed) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    emitOpenSession({
      machineId: parsed.machineId,
      sessionId: parsed.sessionId,
      source: "link-click",
      rawHref: resolvedUrl.href,
    });
  };

  const startObserver = (): void => {
    if (observer || !doc.documentElement || typeof MutationObserver === "undefined") {
      return;
    }
    observer = new MutationObserver(() => {
      scheduleDomSync();
    });
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  const initializeDomHooks = (): void => {
    if (disposed || !isAuthorizedMainDocument()) {
      return;
    }
    latestRouteUrl = win.location.href;
    startObserver();
    scheduleDomSync();
    options.ipc.sendToHost(READY_CHANNEL, { url: latestRouteUrl });
  };

  const pickNonEmptyLabel = (candidate: unknown, fallback: string): string =>
    typeof candidate === "string" && candidate.length > 0 ? candidate : fallback;

  const mergeGuestLabels = (
    current: GuestLabels,
    incoming: Partial<GuestLabels> | undefined,
  ): GuestLabels => {
    if (!incoming || typeof incoming !== "object") {
      return current;
    }
    return {
      openInPaseo: pickNonEmptyLabel(incoming.openInPaseo, current.openInPaseo),
      openDiffInPaseo: pickNonEmptyLabel(incoming.openDiffInPaseo, current.openDiffInPaseo),
      openInPaseoTooltip: pickNonEmptyLabel(
        incoming.openInPaseoTooltip,
        current.openInPaseoTooltip,
      ),
      openDiffTooltip: pickNonEmptyLabel(incoming.openDiffTooltip, current.openDiffTooltip),
    };
  };

  const handleConfigMessage = (_event: unknown, rawPayload: unknown): void => {
    if (disposed || !isAuthorizedMainDocument() || !rawPayload || typeof rawPayload !== "object") {
      return;
    }
    const payload = rawPayload as Partial<{
      hubOrigin: string;
      hubBasePath: string;
      hidePersonaSidebar: boolean;
      interceptSessionClicks: boolean;
      labels: Partial<GuestLabels>;
    }>;
    // Host config cannot widen or alter the main-process-pinned authorized origin.
    if (
      typeof payload.hubOrigin === "string" &&
      payload.hubOrigin.trim().length > 0 &&
      payload.hubOrigin.trim() !== authorizedHub.origin
    ) {
      return;
    }
    config = {
      hubBasePath:
        typeof payload.hubBasePath === "string"
          ? normalizeBasePath(payload.hubBasePath)
          : config.hubBasePath,
      hidePersonaSidebar:
        typeof payload.hidePersonaSidebar === "boolean"
          ? payload.hidePersonaSidebar
          : config.hidePersonaSidebar,
      interceptSessionClicks:
        typeof payload.interceptSessionClicks === "boolean"
          ? payload.interceptSessionClicks
          : config.interceptSessionClicks,
      labels: mergeGuestLabels(config.labels, payload.labels),
    };
    scheduleDomSync();
  };

  const handleRouteSyncMessage = (_event: unknown, rawPayload: unknown): void => {
    if (disposed || !isAuthorizedMainDocument()) {
      return;
    }
    const payload =
      rawPayload && typeof rawPayload === "object" ? (rawPayload as { url?: unknown }) : null;
    if (payload && typeof payload.url === "string" && payload.url.length > 0) {
      try {
        const parsed = new URL(payload.url);
        if (parsed.origin === authorizedHub.origin) {
          latestRouteUrl = parsed.href;
        }
      } catch {
        // Ignore malformed route-sync payloads.
      }
    } else {
      latestRouteUrl = win.location.href;
    }
    scheduleDomSync();
  };

  const handleAllowOnceMessage = (_event: unknown, rawPayload: unknown): void => {
    if (disposed || !isAuthorizedMainDocument() || !rawPayload || typeof rawPayload !== "object") {
      return;
    }
    const payload = rawPayload as { url?: unknown };
    if (typeof payload.url !== "string") {
      return;
    }
    const parsed = parseSessionUrl(payload.url);
    if (!parsed) {
      return;
    }
    try {
      const targetUrl = new URL(payload.url, doc.baseURI || win.location.href);
      allowOnceHref = targetUrl.href;
      // Prefer clicking the matching in-page anchor so Persona SPA navigates without a full reload.
      const matchingAnchor = Array.from(doc.querySelectorAll("a[href]")).find((el) => {
        if (!(el instanceof win.HTMLAnchorElement)) return false;
        try {
          return new URL(el.getAttribute("href") ?? "", doc.baseURI).href === targetUrl.href;
        } catch {
          return false;
        }
      });
      if (matchingAnchor instanceof win.HTMLAnchorElement) {
        matchingAnchor.click();
        return;
      }
      allowOnceHref = null;
      win.location.assign(targetUrl.href);
    } catch {
      allowOnceHref = null;
    }
  };

  const handleLookupSessionMetadata = (_event: unknown, rawPayload: unknown): void => {
    if (disposed || !isAuthorizedMainDocument() || !rawPayload || typeof rawPayload !== "object") {
      return;
    }
    const payload = rawPayload as {
      requestId?: unknown;
      machineId?: unknown;
      sessionId?: unknown;
    };
    if (
      !isNonEmptySafeToken(payload.requestId, 128) ||
      !isNonEmptySafeToken(payload.machineId) ||
      !isNonEmptySafeToken(payload.sessionId)
    ) {
      return;
    }
    const requestId = payload.requestId.trim();
    const machineId = payload.machineId.trim();
    const sessionId = payload.sessionId.trim();
    void (async () => {
      const hints = await fetchTrustedSessionMetadata(machineId, sessionId);
      if (disposed || !isAuthorizedMainDocument()) {
        return;
      }
      options.ipc.sendToHost(SESSION_METADATA_RESULT_CHANNEL, {
        requestId,
        machineId,
        sessionId,
        workspaceIdHint: hints?.workspaceIdHint ?? null,
        cwdHint: hints?.cwdHint ?? null,
      });
    })();
  };

  const handleHistoryChange = (): void => {
    if (disposed || !isAuthorizedMainDocument()) {
      return;
    }
    latestRouteUrl = win.location.href;
    scheduleDomSync();
  };

  options.ipc.on(CONFIG_CHANNEL, handleConfigMessage);
  options.ipc.on(ROUTE_SYNC_CHANNEL, handleRouteSyncMessage);
  options.ipc.on(ALLOW_ONCE_CHANNEL, handleAllowOnceMessage);
  options.ipc.on(LOOKUP_SESSION_METADATA_CHANNEL, handleLookupSessionMetadata);

  doc.addEventListener("click", handleDocumentClick, true);
  win.addEventListener("popstate", handleHistoryChange);
  win.addEventListener("hashchange", handleHistoryChange);

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", initializeDomHooks, { once: true });
  } else {
    initializeDomHooks();
  }

  return {
    isActive: () => !disposed && isAuthorizedMainDocument(),
    syncNow: syncDom,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (syncRafId !== null) {
        win.cancelAnimationFrame(syncRafId);
        syncRafId = null;
      }
      observer?.disconnect();
      observer = null;
      doc.removeEventListener("click", handleDocumentClick, true);
      doc.removeEventListener("DOMContentLoaded", initializeDomHooks);
      win.removeEventListener("popstate", handleHistoryChange);
      win.removeEventListener("hashchange", handleHistoryChange);
      options.ipc.removeListener?.(CONFIG_CHANNEL, handleConfigMessage);
      options.ipc.removeListener?.(ROUTE_SYNC_CHANNEL, handleRouteSyncMessage);
      options.ipc.removeListener?.(ALLOW_ONCE_CHANNEL, handleAllowOnceMessage);
      options.ipc.removeListener?.(LOOKUP_SESSION_METADATA_CHANNEL, handleLookupSessionMetadata);
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const authorizedHubUrl = readAuthorizedHubUrlFromArgv(
    typeof process !== "undefined" ? process.argv : undefined,
  );
  if (authorizedHubUrl && typeof ipcRenderer?.on === "function") {
    mountPersonaGuestPreload({
      ipc: ipcRenderer,
      authorizedHubUrl,
    });
  }
}
