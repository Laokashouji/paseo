import { getDesktopHost } from "@/desktop/host";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import type { PersonaGuestConfigMessage } from "./resident-persona-webview";

export type { PersonaGuestConfigMessage } from "./resident-persona-webview";

export const PERSONA_RESIDENT_HOST_ID = "paseo-persona-resident-webview";
const PERSONA_SURFACE_ATTR = "data-paseo-persona-surface";
const PERSONA_WEBVIEW_ATTR = "data-paseo-persona-webview";
const DEFAULT_PARTITION = "persist:persona";

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

export async function syncPersonaHubUrlWithMain(hubUrl: string | null): Promise<void> {
  const setter = getDesktopHost()?.persona?.setHubUrl;
  if (typeof setter !== "function") {
    return;
  }
  try {
    await setter(hubUrl);
  } catch {
    // Ignore IPC errors in degraded environments.
  }
}

export async function ensureResidentPersonaWebview(
  hubUrl: string,
): Promise<PersonaElectronWebviewElement | null> {
  const ownerDocument = readDocument();
  if (!ownerDocument || !hubUrl.trim()) {
    return null;
  }

  await syncPersonaHubUrlWithMain(hubUrl);

  if (
    residentState &&
    residentState.webview.isConnected &&
    residentState.surface.isConnected &&
    residentState.hubUrl === hubUrl
  ) {
    return residentState.webview;
  }

  destroyResidentPersonaWebview();

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
  webview.src = hubUrl;

  surface.appendChild(webview);
  host.appendChild(surface);

  residentState = {
    webview,
    surface,
    hubUrl,
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
  if (residentState) {
    residentState.webview.remove();
    residentState.surface.remove();
    residentState = null;
  }
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
