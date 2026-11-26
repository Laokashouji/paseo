import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import type { PersonaGuestConfigMessage } from "./resident-persona-webview";
import {
  DEFAULT_PERSONA_HUB_ID,
  validatePersonaSessionMetadataResult,
  type PersonaSessionMetadataHints,
} from "./settings";

export type { PersonaGuestConfigMessage } from "./resident-persona-webview";

export const PERSONA_RESIDENT_HOST_ID = "paseo-persona-resident-webview";
export const PERSONA_SURFACE_ATTR = "data-paseo-persona-surface";
export const PERSONA_WEBVIEW_ATTR = "data-paseo-persona-webview";
export const PERSONA_HUB_ID_ATTR = "data-paseo-persona-hub-id";
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

export interface ResidentPersonaEntry {
  hubId: string;
  hubUrl: string;
  webview: PersonaElectronWebviewElement;
  surface: HTMLElement;
}

export interface PersonaSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const residentPoolByHubId = new Map<string, ResidentPersonaEntry>();
const generationByHubId = new Map<string, number>();
let globalLifecycleGeneration = 0;
let webviewsInteractive = true;
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

function applyParkedSurfaceStyle(entry: ResidentPersonaEntry): void {
  const { surface, webview } = entry;
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
  webview.style.pointerEvents = "none";
}

function applyPresentedSurfaceStyle(entry: ResidentPersonaEntry, rect: PersonaSurfaceRect): void {
  const { surface, webview } = entry;
  const pointerEvents = webviewsInteractive ? "auto" : "none";
  surface.removeAttribute("aria-hidden");
  surface.style.position = "fixed";
  surface.style.left = `${Math.round(rect.left)}px`;
  surface.style.top = `${Math.round(rect.top)}px`;
  surface.style.width = `${Math.max(1, Math.round(rect.width))}px`;
  surface.style.height = `${Math.max(1, Math.round(rect.height))}px`;
  surface.style.overflow = "hidden";
  surface.style.opacity = "1";
  surface.style.pointerEvents = pointerEvents;
  surface.style.display = "block";
  surface.style.visibility = "visible";
  webview.style.pointerEvents = pointerEvents;
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

function invokeSetHubUrls(
  hubUrls: readonly string[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return enqueueHubSync(async () => {
    const personaBridge = getDesktopHost()?.persona;
    if (!personaBridge) {
      return false;
    }
    const normalizedList = Array.isArray(hubUrls)
      ? Array.from(new Set(hubUrls.map((url) => url.trim()).filter((url) => url.length > 0)))
      : [];
    try {
      if (typeof personaBridge.setHubUrls === "function") {
        const accepted = await personaBridge.setHubUrls(
          normalizedList.length > 0 ? normalizedList : null,
          options,
        );
        return accepted === true;
      }
      if (typeof personaBridge.setHubUrl === "function") {
        const accepted = await personaBridge.setHubUrl(normalizedList[0] ?? null, options);
        return accepted === true;
      }
      return false;
    } catch {
      return false;
    }
  });
}

export async function syncPersonaHubUrlsWithMain(
  hubUrls: readonly string[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return invokeSetHubUrls(hubUrls, options);
}

export async function syncPersonaHubUrlWithMain(
  hubUrl: string | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return invokeSetHubUrls(hubUrl ? [hubUrl] : null, options);
}

function removeEntryDomOnly(entry: ResidentPersonaEntry): void {
  entry.webview.remove();
  entry.surface.remove();
}

function resolveTargetEntry(hubId?: string): ResidentPersonaEntry | null {
  if (hubId) {
    const entry = residentPoolByHubId.get(hubId);
    return entry?.webview.isConnected && entry.surface.isConnected ? entry : null;
  }
  for (const entry of residentPoolByHubId.values()) {
    if (entry.webview.isConnected && entry.surface.isConnected) {
      return entry;
    }
  }
  return null;
}

export interface EnsureResidentPersonaWebviewInput {
  hubId: string;
  hubUrl: string;
  allowedHubUrls?: readonly string[];
}

export async function ensureResidentPersonaWebview(
  input: string | EnsureResidentPersonaWebviewInput,
): Promise<PersonaElectronWebviewElement | null> {
  const ownerDocument = readDocument();
  const normalizedInput: EnsureResidentPersonaWebviewInput =
    typeof input === "string" ? { hubId: DEFAULT_PERSONA_HUB_ID, hubUrl: input } : input;
  const hubId = normalizedInput.hubId.trim();
  const normalizedHubUrl = normalizedInput.hubUrl.trim();
  if (!ownerDocument || !hubId || !normalizedHubUrl) {
    return null;
  }

  const nextHubGeneration = (generationByHubId.get(hubId) ?? 0) + 1;
  generationByHubId.set(hubId, nextHubGeneration);
  const myGlobalGeneration = globalLifecycleGeneration;

  const pooledUrlsExcludingSelf = Array.from(residentPoolByHubId.values())
    .filter((entry) => entry.hubId !== hubId)
    .map((entry) => entry.hubUrl);
  const allowlist = Array.from(
    new Set(
      normalizedInput.allowedHubUrls !== undefined
        ? [...normalizedInput.allowedHubUrls, normalizedHubUrl]
        : [...pooledUrlsExcludingSelf, normalizedHubUrl],
    ),
  ).filter((url) => url.trim().length > 0);

  const registered = await invokeSetHubUrls(allowlist, { enabled: true });

  // Cancel creation if a destroy/disable/re-ensure superseded us while awaiting IPC,
  // or if the main process rejected Hub registration.
  if (
    !registered ||
    myGlobalGeneration !== globalLifecycleGeneration ||
    generationByHubId.get(hubId) !== nextHubGeneration
  ) {
    return null;
  }

  const existing = residentPoolByHubId.get(hubId);
  if (
    existing &&
    existing.webview.isConnected &&
    existing.surface.isConnected &&
    existing.hubUrl === normalizedHubUrl
  ) {
    return existing.webview;
  }

  if (existing) {
    removeEntryDomOnly(existing);
    residentPoolByHubId.delete(hubId);
  }

  const host = ensureHostContainer(ownerDocument);
  const surface = ownerDocument.createElement("div");
  surface.setAttribute(PERSONA_SURFACE_ATTR, "true");
  surface.setAttribute(PERSONA_HUB_ID_ATTR, hubId);

  const webview = ownerDocument.createElement("webview") as PersonaElectronWebviewElement;
  webview.setAttribute(PERSONA_WEBVIEW_ATTR, "true");
  webview.setAttribute(PERSONA_HUB_ID_ATTR, hubId);
  webview.setAttribute("partition", getPersonaPartition());
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.setAttribute("autosize", "on");
  applyWebviewFillStyle(webview);
  webview.src = normalizedHubUrl;

  const entry: ResidentPersonaEntry = {
    hubId,
    hubUrl: normalizedHubUrl,
    webview,
    surface,
  };
  applyParkedSurfaceStyle(entry);

  surface.appendChild(webview);
  host.appendChild(surface);

  residentPoolByHubId.set(hubId, entry);
  return webview;
}

export function getResidentPersonaWebview(hubId?: string): PersonaElectronWebviewElement | null {
  return resolveTargetEntry(hubId)?.webview ?? null;
}

export function listResidentPersonaHubIds(): string[] {
  const activeIds: string[] = [];
  for (const [hubId, entry] of residentPoolByHubId.entries()) {
    if (entry.webview.isConnected && entry.surface.isConnected) {
      activeIds.push(hubId);
    }
  }
  return activeIds;
}

export function presentResidentPersonaWebview(
  hubIdOrRect: string | PersonaSurfaceRect,
  maybeRect?: PersonaSurfaceRect,
): void {
  const hubId = typeof hubIdOrRect === "string" ? hubIdOrRect : undefined;
  const rect = typeof hubIdOrRect === "string" ? maybeRect : hubIdOrRect;
  const entry = resolveTargetEntry(hubId);
  if (!entry || !rect) {
    return;
  }
  if (rect.width <= 0 || rect.height <= 0) {
    applyParkedSurfaceStyle(entry);
    return;
  }
  applyPresentedSurfaceStyle(entry, rect);
}

export function parkResidentPersonaWebview(hubId?: string): void {
  if (hubId) {
    const entry = resolveTargetEntry(hubId);
    if (entry) {
      applyParkedSurfaceStyle(entry);
    }
    return;
  }
  for (const entry of residentPoolByHubId.values()) {
    if (entry.surface.isConnected) {
      applyParkedSurfaceStyle(entry);
    }
  }
}

/**
 * Toggles pointer-events on all presented Persona webviews.
 * Called with `false` while dragging the split divider so Chromium `<webview>` surfaces
 * cannot steal pointermove / pointerup events during resizing.
 */
export function setResidentPersonaWebviewsInteractive(interactive: boolean): void {
  webviewsInteractive = interactive;
  for (const entry of residentPoolByHubId.values()) {
    if (!entry.surface.isConnected) {
      continue;
    }
    const isParked = entry.surface.getAttribute("aria-hidden") === "true";
    const pointerEvents = !isParked && interactive ? "auto" : "none";
    entry.surface.style.pointerEvents = pointerEvents;
    entry.webview.style.pointerEvents = pointerEvents;
  }
}

export function reloadResidentPersonaWebview(hubId?: string): void {
  const webview = getResidentPersonaWebview(hubId);
  if (!webview) {
    return;
  }
  try {
    webview.reload?.();
  } catch {
    // Ignore if webview has not finished attaching yet.
  }
}

export function destroyResidentPersonaWebview(hubId?: string): void {
  if (hubId) {
    generationByHubId.set(hubId, (generationByHubId.get(hubId) ?? 0) + 1);
    const entry = residentPoolByHubId.get(hubId);
    if (entry) {
      removeEntryDomOnly(entry);
      residentPoolByHubId.delete(hubId);
    }
    return;
  }

  globalLifecycleGeneration += 1;
  generationByHubId.clear();
  for (const entry of residentPoolByHubId.values()) {
    removeEntryDomOnly(entry);
  }
  residentPoolByHubId.clear();
  webviewsInteractive = true;
}

/**
 * Tears down pool entries whose Hub was removed or whose URL changed, while leaving all
 * unchanged Hubs alive (parked at 1x1 when off-screen) for 0ms flicker-free switching.
 */
export function reconcileResidentPersonaWebviews(
  hubs: ReadonlyArray<{ id: string; hubUrl: string }>,
): void {
  const urlByHubId = new Map<string, string>();
  for (const hub of hubs) {
    const trimmedUrl = hub.hubUrl.trim();
    if (hub.id && trimmedUrl) {
      urlByHubId.set(hub.id, trimmedUrl);
    }
  }
  for (const [hubId, entry] of Array.from(residentPoolByHubId.entries())) {
    const expectedUrl = urlByHubId.get(hubId);
    if (!expectedUrl || expectedUrl !== entry.hubUrl) {
      destroyResidentPersonaWebview(hubId);
    }
  }
}

export async function disableResidentPersonaWebview(): Promise<void> {
  destroyResidentPersonaWebview();
  await invokeSetHubUrls(null, { enabled: false });
}

export function sendPersonaGuestConfig(
  hubIdOrConfig: string | PersonaGuestConfigMessage,
  maybeConfig?: PersonaGuestConfigMessage,
): void {
  const hubId = typeof hubIdOrConfig === "string" ? hubIdOrConfig : undefined;
  const config = typeof hubIdOrConfig === "string" ? maybeConfig : hubIdOrConfig;
  if (!config) {
    return;
  }
  const webview = getResidentPersonaWebview(hubId);
  if (!webview || typeof webview.send !== "function") {
    return;
  }
  try {
    webview.send("paseo:persona:config", config);
  } catch {
    // Guest WebContents may not be ready yet; ready/dom-ready re-sends config.
  }
}

export function sendPersonaGuestRouteSync(hubIdOrUrl: string, maybeUrl?: string): void {
  const hubId = maybeUrl !== undefined ? hubIdOrUrl : undefined;
  const url = maybeUrl !== undefined ? maybeUrl : hubIdOrUrl;
  const webview = getResidentPersonaWebview(hubId);
  if (!webview || typeof webview.send !== "function") {
    return;
  }
  try {
    webview.send("paseo:persona:route-sync", { url });
  } catch {
    // Ignore when guest is still loading.
  }
}

export function sendPersonaGuestAllowOnce(hubIdOrUrl: string, maybeUrl?: string): void {
  const hubId = maybeUrl !== undefined ? hubIdOrUrl : undefined;
  const url = maybeUrl !== undefined ? maybeUrl : hubIdOrUrl;
  const webview = getResidentPersonaWebview(hubId);
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

export function findResidentPersonaEntryByWebContentsId(
  webContentsId: number,
): ResidentPersonaEntry | null {
  if (!Number.isInteger(webContentsId) || webContentsId <= 0) {
    return null;
  }
  for (const entry of residentPoolByHubId.values()) {
    if (!entry.webview.isConnected) {
      continue;
    }
    if (readResidentPersonaWebviewContentsId(entry.webview) === webContentsId) {
      return entry;
    }
  }
  return null;
}

/**
 * Requests same-origin session metadata (`workspace_id`, `cwd`) from the authorized Persona guest
 * belonging to `hubId`. Receives replies exclusively via the main-process
 * `persona-session-metadata-result` channel after `senderFrame === contents.mainFrame` +
 * registered Hub origin verification.
 */
export function lookupPersonaGuestSessionMetadata(input: {
  hubId?: string;
  machineId: string;
  sessionId: string;
  authorizedHubUrl: string;
  timeoutMs?: number;
}): Promise<PersonaSessionMetadataHints | null> {
  const webview = getResidentPersonaWebview(input.hubId);
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
