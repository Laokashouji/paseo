import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import type { PersonaGuestConfigMessage } from "./resident-persona-webview";
import { validatePersonaSessionMetadataResult, type PersonaSessionMetadataHints } from "./settings";

export type { PersonaGuestConfigMessage } from "./resident-persona-webview";

export const PERSONA_RESIDENT_HOST_ID = "paseo-persona-resident-webview";
const PERSONA_SURFACE_ATTR = "data-paseo-persona-surface";
const PERSONA_WEBVIEW_ATTR = "data-paseo-persona-webview";
const DEFAULT_PARTITION = "persist:persona";
const METADATA_LOOKUP_TIMEOUT_MS = 1_500;

export interface PersonaElectronWebviewElement extends HTMLElement {
  src: string;
  getWebContentsId?: () => number;
  getURL?: () => string;
  canGoBack?: () => boolean;
  canGoForward?: () => boolean;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  stop?: () => void;
  loadURL?: (url: string) => Promise<void>;
  send?: (channel: string, ...args: unknown[]) => void;
  isLoading?: () => boolean;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

interface ResidentPersonaState {
  webview: PersonaElectronWebviewElement;
  surface: HTMLElement;
  hubUrl: string;
}

let residentState: ResidentPersonaState | null = null;
let lifecycleGeneration = 0;
let hubSyncQueue: Promise<unknown> = Promise.resolve();
let nextMetadataRequestSeq = 0;

function readDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function getPersonaPartition(): string {
  const fromBridge = getDesktopHost()?.persona?.partition;
  return typeof fromBridge === "string" && fromBridge.startsWith("persist:")
    ? fromBridge
    : DEFAULT_PARTITION;
}

function applyHostContainerStyle(host: HTMLElement): void {
  host.removeAttribute("aria-hidden");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.overflow = "visible";
  host.style.opacity = "1";
  host.style.pointerEvents = "none";
  host.style.display = "block";
  host.style.visibility = "visible";
  host.style.zIndex = String(WEB_SURFACE_PLANE.browser);
}

function applyParkedSurfaceStyle(surface: HTMLElement): void {
  surface.setAttribute("aria-hidden", "true");
  surface.style.position = "fixed";
  surface.style.left = "0";
  surface.style.top = "0";
  surface.style.width = "1px";
  surface.style.height = "1px";
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = "none";
  surface.style.display = "block";
  surface.style.visibility = "visible";
}

function applyPresentedSurfaceStyle(
  surface: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  surface.removeAttribute("aria-hidden");
  surface.style.position = "fixed";
  surface.style.left = `${Math.round(rect.left)}px`;
  surface.style.top = `${Math.round(rect.top)}px`;
  surface.style.width = `${Math.max(1, Math.round(rect.width))}px`;
  surface.style.height = `${Math.max(1, Math.round(rect.height))}px`;
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = "auto";
  surface.style.display = "block";
  surface.style.visibility = "visible";
}

function applyWebviewFillStyle(webview: HTMLElement): void {
  webview.style.display = "flex";
  webview.style.width = "100%";
  webview.style.height = "100%";
  webview.style.border = "0";
  webview.style.margin = "0";
  webview.style.padding = "0";
}

function ensureHostContainer(ownerDocument: Document): HTMLElement {
  const existing = ownerDocument.getElementById(PERSONA_RESIDENT_HOST_ID);
  if (existing) {
    applyHostContainerStyle(existing);
    return existing;
  }
  const host = ownerDocument.createElement("div");
  host.id = PERSONA_RESIDENT_HOST_ID;
  applyHostContainerStyle(host);
  ownerDocument.body.appendChild(host);
  return host;
}

function enqueueHubSync<T>(operation: () => Promise<T>): Promise<T> {
  const next = hubSyncQueue.then(operation, operation);
  hubSyncQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function invokeSetHubUrl(hubUrl: string | null, options?: { enabled?: boolean }): Promise<boolean> {
  return enqueueHubSync(async () => {
    const setter = getDesktopHost()?.persona?.setHubUrl;
    if (typeof setter !== "function") {
      return false;
    }
    try {
      const accepted = await setter(hubUrl, options);
      return accepted === true;
    } catch {
      return false;
    }
  });
}

export async function syncPersonaHubUrlWithMain(
  hubUrl: string | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return invokeSetHubUrl(hubUrl, options);
}

function removeResidentDomOnly(): void {
  if (residentState) {
    residentState.webview.remove();
    residentState.surface.remove();
    residentState = null;
  }
}

export async function ensureResidentPersonaWebview(
  hubUrl: string,
): Promise<PersonaElectronWebviewElement | null> {
  const ownerDocument = readDocument();
  const normalizedHubUrl = hubUrl.trim();
  if (!ownerDocument || !normalizedHubUrl) {
    return null;
  }

  const generation = ++lifecycleGeneration;
  const registered = await invokeSetHubUrl(normalizedHubUrl, { enabled: true });

  // Cancel creation if another destroy/disable/ensure call superseded us while awaiting IPC,
  // or if the main process rejected Hub registration.
  if (!registered || generation !== lifecycleGeneration) {
    return null;
  }

  if (
    residentState &&
    residentState.webview.isConnected &&
    residentState.surface.isConnected &&
    residentState.hubUrl === normalizedHubUrl
  ) {
    return residentState.webview;
  }

  removeResidentDomOnly();

  const host = ensureHostContainer(ownerDocument);
  const surface = ownerDocument.createElement("div");
  surface.setAttribute(PERSONA_SURFACE_ATTR, "true");
  applyParkedSurfaceStyle(surface);

  const webview = ownerDocument.createElement("webview") as PersonaElectronWebviewElement;
  webview.setAttribute(PERSONA_WEBVIEW_ATTR, "true");
  webview.setAttribute("partition", getPersonaPartition());
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.setAttribute("autosize", "on");
  applyWebviewFillStyle(webview);
  webview.src = normalizedHubUrl;

  surface.appendChild(webview);
  host.appendChild(surface);

  residentState = {
    webview,
    surface,
    hubUrl: normalizedHubUrl,
  };
  return webview;
}

export function getResidentPersonaWebview(): PersonaElectronWebviewElement | null {
  if (!residentState || !residentState.webview.isConnected) {
    return null;
  }
  return residentState.webview;
}

export function presentResidentPersonaWebview(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): void {
  if (!residentState || !residentState.surface.isConnected) {
    return;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    applyParkedSurfaceStyle(residentState.surface);
    return;
  }
  applyPresentedSurfaceStyle(residentState.surface, rect);
}

export function parkResidentPersonaWebview(): void {
  if (!residentState || !residentState.surface.isConnected) {
    return;
  }
  applyParkedSurfaceStyle(residentState.surface);
}

export function reloadResidentPersonaWebview(): void {
  const webview = getResidentPersonaWebview();
  if (!webview) {
    return;
  }
  try {
    webview.reload?.();
  } catch {
    // Ignore if webview has not finished attaching yet.
  }
}

export function destroyResidentPersonaWebview(): void {
  lifecycleGeneration += 1;
  removeResidentDomOnly();
}

export async function disableResidentPersonaWebview(): Promise<void> {
  destroyResidentPersonaWebview();
  await invokeSetHubUrl(null, { enabled: false });
}

export function sendPersonaGuestConfig(config: PersonaGuestConfigMessage): void {
  const webview = getResidentPersonaWebview();
  if (!webview || typeof webview.send !== "function") {
    return;
  }
  try {
    webview.send("paseo:persona:config", config);
  } catch {
    // Guest WebContents may not be ready yet; ready/dom-ready re-sends config.
  }
}

export function sendPersonaGuestRouteSync(url: string): void {
  const webview = getResidentPersonaWebview();
  if (!webview || typeof webview.send !== "function") {
    return;
  }
  try {
    webview.send("paseo:persona:route-sync", { url });
  } catch {
    // Ignore when guest is still loading.
  }
}

export function sendPersonaGuestAllowOnce(url: string): void {
  const webview = getResidentPersonaWebview();
  if (!webview || typeof webview.send !== "function") {
    return;
  }
  try {
    webview.send("paseo:persona:allow-once", { url });
  } catch {
    // Ignore when guest is unavailable.
  }
}

export function readResidentPersonaWebviewContentsId(
  webview: PersonaElectronWebviewElement | null | undefined = getResidentPersonaWebview(),
): number | null {
  if (!webview || typeof webview.getWebContentsId !== "function") {
    return null;
  }
  try {
    const id = webview.getWebContentsId();
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Requests same-origin session metadata (`workspace_id`, `cwd`) from the authorized Persona guest.
 * Receives replies exclusively via the main-process `persona-session-metadata-result` channel
 * after `senderFrame === contents.mainFrame` + registered Hub origin verification.
 */
export function lookupPersonaGuestSessionMetadata(input: {
  machineId: string;
  sessionId: string;
  authorizedHubUrl: string;
  timeoutMs?: number;
}): Promise<PersonaSessionMetadataHints | null> {
  const webview = getResidentPersonaWebview();
  if (!webview || typeof webview.send !== "function") {
    return Promise.resolve(null);
  }
  const requestId = `persona-meta-${++nextMetadataRequestSeq}`;
  const timeoutMs = input.timeoutMs ?? METADATA_LOOKUP_TIMEOUT_MS;

  let resolvePending: ((value: PersonaSessionMetadataHints | null) => void) | null = null;
  const pending = new Promise<PersonaSessionMetadataHints | null>((resolve) => {
    resolvePending = resolve;
  });

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unlisten: (() => void) | null = null;

  const finish = (value: PersonaSessionMetadataHints | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    unlisten?.();
    unlisten = null;
    resolvePending?.(value);
  };

  const onDesktopMetadataResult = (rawPayload: unknown): void => {
    let currentGuestUrl: string | undefined;
    try {
      const liveUrl = webview.getURL?.() || webview.src || "";
      if (liveUrl.trim().length > 0) {
        currentGuestUrl = liveUrl;
      }
    } catch {
      if (webview.src.trim().length > 0) {
        currentGuestUrl = webview.src;
      }
    }
    const validated = validatePersonaSessionMetadataResult(rawPayload, {
      authorizedHubUrl: input.authorizedHubUrl,
      ...(currentGuestUrl ? { currentGuestUrl } : {}),
      expectedGuestWebContentsId: readResidentPersonaWebviewContentsId(webview),
      expectedRequestId: requestId,
      expectedMachineId: input.machineId,
      expectedSessionId: input.sessionId,
    });
    if (!validated) {
      return;
    }
    finish(validated);
  };

  timer = setTimeout(() => finish(null), timeoutMs);

  void (async () => {
    try {
      const dispose = await listenToDesktopEvent<unknown>(
        "persona-session-metadata-result",
        onDesktopMetadataResult,
      );
      if (settled) {
        dispose();
        return;
      }
      unlisten = dispose;
      webview.send?.("paseo:persona:lookup-session-metadata", {
        requestId,
        machineId: input.machineId,
        sessionId: input.sessionId,
      });
    } catch {
      finish(null);
    }
  })();

  return pending;
}
