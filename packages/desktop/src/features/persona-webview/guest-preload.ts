import { ipcRenderer } from "electron";

// Sandboxed Electron <webview> guest preload: MUST NOT load any runtime module
// other than "electron", and MUST NOT expose ipcRenderer via contextBridge.

const CONFIG_CHANNEL = "paseo:persona:config";
const ROUTE_SYNC_CHANNEL = "paseo:persona:route-sync";
const ALLOW_ONCE_CHANNEL = "paseo:persona:allow-once";
const OPEN_SESSION_CHANNEL = "paseo:persona:open-session";
const READY_CHANNEL = "paseo:persona:ready";

const HIDE_SIDEBAR_STYLE_ID = "paseo-persona-hide-sidebar";
const ACTION_STYLE_ID = "paseo-persona-open-actions-style";
const ACTION_CONTAINER_ATTR = "data-paseo-injected";
const ACTION_CONTAINER_VALUE = "open-actions";

interface GuestLabels {
  openInPaseo: string;
  openDiffInPaseo: string;
  openInPaseoTooltip: string;
  openDiffTooltip: string;
}

interface GuestConfig {
  hubOrigin: string;
  hubBasePath: string;
  hidePersonaSidebar: boolean;
  interceptSessionClicks: boolean;
  labels: GuestLabels;
}

interface ParsedSessionTarget {
  machineId: string;
  sessionId: string;
}

let config: GuestConfig = {
  hubOrigin: "",
  hubBasePath: "",
  hidePersonaSidebar: false,
  interceptSessionClicks: true,
  labels: {
    openInPaseo: "Open in Paseo",
    openDiffInPaseo: "Diff",
    openInPaseoTooltip: "Open this agent session in Paseo",
    openDiffTooltip: "Open working diff in Paseo",
  },
};

let latestRouteUrl = "";
let allowOnceHref: string | null = null;
let syncRafId: number | null = null;
let observerStarted = false;

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" || trimmed === "/" ? "" : trimmed;
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

function readEffectiveOrigin(): string {
  if (config.hubOrigin) {
    return config.hubOrigin;
  }
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
}

function readDocumentBasePath(): string {
  if (typeof document !== "undefined") {
    const baseEl = document.querySelector("base[href]");
    const rawHref = baseEl?.getAttribute("href");
    if (rawHref) {
      try {
        const parsedBase = new URL(rawHref, window.location.href);
        return normalizeBasePath(parsedBase.pathname);
      } catch {
        // Fall through to configured base path.
      }
    }
  }
  return normalizeBasePath(config.hubBasePath);
}

function resolveBaseUrl(effectiveOrigin: string): string {
  if (typeof document !== "undefined" && document.baseURI) {
    return document.baseURI;
  }
  if (typeof window !== "undefined") {
    return window.location.href;
  }
  return effectiveOrigin;
}

function parseSessionUrl(rawUrl: string): ParsedSessionTarget | null {
  const effectiveOrigin = readEffectiveOrigin();
  if (!effectiveOrigin || !rawUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl, resolveBaseUrl(effectiveOrigin));
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.origin !== effectiveOrigin) {
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
}

function syncHideSidebarStyle(): void {
  if (typeof document === "undefined" || !document.head) {
    return;
  }
  const existing = document.getElementById(HIDE_SIDEBAR_STYLE_ID);
  if (!config.hidePersonaSidebar) {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }
  const style = document.createElement("style");
  style.id = HIDE_SIDEBAR_STYLE_ID;
  style.textContent =
    "@media (min-width: 1024px) { [data-app-shell] > [data-sidebar-column] { display: none !important; } }";
  document.head.appendChild(style);
}

function ensureActionStyles(): void {
  if (typeof document === "undefined" || !document.head) {
    return;
  }
  if (document.getElementById(ACTION_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
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
  document.head.appendChild(style);
}

function removeInjectedHeaderActions(): void {
  if (typeof document === "undefined") {
    return;
  }
  const nodes = document.querySelectorAll(`[${ACTION_CONTAINER_ATTR}="${ACTION_CONTAINER_VALUE}"]`);
  for (let index = 0; index < nodes.length; index += 1) {
    nodes[index]?.remove();
  }
}

function createActionButton(
  role: "open" | "diff",
  label: string,
  tooltip: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
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
}

function syncInjectedHeaderActions(): void {
  if (typeof document === "undefined") {
    return;
  }
  const currentUrl = latestRouteUrl || (typeof window !== "undefined" ? window.location.href : "");
  const target = parseSessionUrl(currentUrl);
  if (!target) {
    removeInjectedHeaderActions();
    return;
  }

  const slot = document.querySelector("main header > div:last-child");
  if (!(slot instanceof HTMLElement)) {
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
    if (openBtn instanceof HTMLButtonElement) {
      openBtn.textContent = config.labels.openInPaseo;
      openBtn.title = config.labels.openInPaseoTooltip;
      openBtn.setAttribute("aria-label", config.labels.openInPaseoTooltip);
    }
    if (diffBtn instanceof HTMLButtonElement) {
      diffBtn.textContent = config.labels.openDiffInPaseo;
      diffBtn.title = config.labels.openDiffTooltip;
      diffBtn.setAttribute("aria-label", config.labels.openDiffTooltip);
    }
    return;
  }

  removeInjectedHeaderActions();

  const container = document.createElement("span");
  container.setAttribute(ACTION_CONTAINER_ATTR, ACTION_CONTAINER_VALUE);
  container.dataset.machineId = target.machineId;
  container.dataset.sessionId = target.sessionId;

  const openButton = createActionButton(
    "open",
    config.labels.openInPaseo,
    config.labels.openInPaseoTooltip,
    () => {
      ipcRenderer.sendToHost(OPEN_SESSION_CHANNEL, {
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
        document.querySelector("[data-changes-panel], [data-git-review]"),
      );
      ipcRenderer.sendToHost(OPEN_SESSION_CHANNEL, {
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
}

function scheduleDomSync(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (syncRafId !== null) {
    return;
  }
  syncRafId = window.requestAnimationFrame(() => {
    syncRafId = null;
    syncHideSidebarStyle();
    syncInjectedHeaderActions();
  });
}

function resolveEventTargetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

function handleDocumentClick(event: MouseEvent): void {
  if (!config.interceptSessionClicks) {
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
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }

  const rawHrefAttr = anchor.getAttribute("href");
  if (!rawHrefAttr) {
    return;
  }

  let resolvedUrl: URL;
  try {
    resolvedUrl = new URL(rawHrefAttr, document.baseURI || window.location.href);
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

  ipcRenderer.sendToHost(OPEN_SESSION_CHANNEL, {
    machineId: parsed.machineId,
    sessionId: parsed.sessionId,
    source: "link-click",
    rawHref: resolvedUrl.href,
  });
}

function startObserver(): void {
  if (observerStarted || typeof document === "undefined" || !document.documentElement) {
    return;
  }
  observerStarted = true;
  const observer = new MutationObserver(() => {
    scheduleDomSync();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function initializeDomHooks(): void {
  latestRouteUrl = typeof window !== "undefined" ? window.location.href : "";
  startObserver();
  scheduleDomSync();
  ipcRenderer.sendToHost(READY_CHANNEL, { url: latestRouteUrl });
}

ipcRenderer.on(CONFIG_CHANNEL, (_event, payload: Partial<GuestConfig> | null | undefined) => {
  if (!payload || typeof payload !== "object") {
    return;
  }
  config = {
    hubOrigin: typeof payload.hubOrigin === "string" ? payload.hubOrigin : config.hubOrigin,
    hubBasePath: typeof payload.hubBasePath === "string" ? payload.hubBasePath : config.hubBasePath,
    hidePersonaSidebar:
      typeof payload.hidePersonaSidebar === "boolean"
        ? payload.hidePersonaSidebar
        : config.hidePersonaSidebar,
    interceptSessionClicks:
      typeof payload.interceptSessionClicks === "boolean"
        ? payload.interceptSessionClicks
        : config.interceptSessionClicks,
    labels:
      payload.labels && typeof payload.labels === "object"
        ? {
            openInPaseo: payload.labels.openInPaseo || config.labels.openInPaseo,
            openDiffInPaseo: payload.labels.openDiffInPaseo || config.labels.openDiffInPaseo,
            openInPaseoTooltip:
              payload.labels.openInPaseoTooltip || config.labels.openInPaseoTooltip,
            openDiffTooltip: payload.labels.openDiffTooltip || config.labels.openDiffTooltip,
          }
        : config.labels,
  };
  scheduleDomSync();
});

ipcRenderer.on(ROUTE_SYNC_CHANNEL, (_event, payload: { url?: string } | null | undefined) => {
  if (payload && typeof payload.url === "string" && payload.url.length > 0) {
    latestRouteUrl = payload.url;
  } else if (typeof window !== "undefined") {
    latestRouteUrl = window.location.href;
  }
  scheduleDomSync();
});

ipcRenderer.on(ALLOW_ONCE_CHANNEL, (_event, payload: { url?: string } | null | undefined) => {
  if (!payload || typeof payload.url !== "string") {
    return;
  }
  const parsed = parseSessionUrl(payload.url);
  if (!parsed || typeof window === "undefined") {
    return;
  }
  try {
    const targetUrl = new URL(payload.url, document.baseURI || window.location.href);
    allowOnceHref = targetUrl.href;
    // Prefer clicking the matching in-page anchor so Persona SPA navigates without a full reload.
    const matchingAnchor = Array.from(document.querySelectorAll("a[href]")).find((el) => {
      if (!(el instanceof HTMLAnchorElement)) return false;
      try {
        return new URL(el.getAttribute("href") ?? "", document.baseURI).href === targetUrl.href;
      } catch {
        return false;
      }
    });
    if (matchingAnchor instanceof HTMLAnchorElement) {
      matchingAnchor.click();
      return;
    }
    allowOnceHref = null;
    window.location.assign(targetUrl.href);
  } catch {
    allowOnceHref = null;
  }
});

if (typeof document !== "undefined") {
  document.addEventListener("click", handleDocumentClick, true);
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    latestRouteUrl = window.location.href;
    scheduleDomSync();
  });
  window.addEventListener("hashchange", () => {
    latestRouteUrl = window.location.href;
    scheduleDomSync();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDomHooks, { once: true });
  } else {
    initializeDomHooks();
  }
}
