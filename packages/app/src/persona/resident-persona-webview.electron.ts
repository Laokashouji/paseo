import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost, type DesktopPersonaHubPartitionEntry } from "@/desktop/host";
import { WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import type { PersonaGuestConfigMessage } from "./resident-persona-webview";
import {
  DEFAULT_PERSONA_HUB_ID,
  PERSONA_WEBVIEW_PARTITION,
  resolvePersonaHubPartition,
  validatePersonaSessionMetadataResult,
  type PersonaSessionMetadataHints,
} from "./settings";

export type { PersonaGuestConfigMessage } from "./resident-persona-webview";

export const PERSONA_RESIDENT_HOST_ID = "paseo-persona-resident-webview";
export const PERSONA_SURFACE_ATTR = "data-paseo-persona-surface";
export const PERSONA_WEBVIEW_ATTR = "data-paseo-persona-webview";
export const PERSONA_HUB_ID_ATTR = "data-paseo-persona-hub-id";
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
  partition: string;
  webview: PersonaElectronWebviewElement;
  surface: HTMLElement;
}

export interface PersonaSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface InFlightPersonaEnsure {
  token: number;
  hubUrl: string;
  partition: string;
}

const residentPoolByHubId = new Map<string, ResidentPersonaEntry>();
const inFlightEnsureByHubId = new Map<string, InFlightPersonaEnsure>();
let nextEnsureToken = 0;
let globalLifecycleGeneration = 0;
let webviewsInteractive = true;
let hubSyncQueue: Promise<unknown> = Promise.resolve();
let nextMetadataRequestSeq = 0;

function readDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function getPersonaBridgeBasePartition(): string {
  const fromBridge = getDesktopHost()?.persona?.partition;
  return typeof fromBridge === "string" && fromBridge.startsWith("persist:")
    ? fromBridge
    : PERSONA_WEBVIEW_PARTITION;
}

function supportsPerHubPartitions(): boolean {
  const personaBridge = getDesktopHost()?.persona;
  return Boolean(
    personaBridge?.supportsPerHubPartitions === true &&
    typeof personaBridge.setHubEntries === "function",
  );
}

/**
 * Resolves the effective `<webview partition>` for `hubId`:
 * - On desktops supporting per-Hub partitions: `persist:persona` for `hub-default` and
 *   `persist:persona-<hubId>` for additional Hubs.
 * - On legacy 0.17.534 desktop shells: falls back to the single `persist:persona` partition.
 */
export function resolveResidentPersonaPartition(hubId: string): string | null {
  const personaBridge = getDesktopHost()?.persona;
  const basePartition = getPersonaBridgeBasePartition();
  if (!supportsPerHubPartitions()) {
    return basePartition;
  }
  return resolvePersonaHubPartition(hubId, {
    basePartition,
    partitionPrefix: personaBridge?.partitionPrefix,
  });
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
  // Clamp bounds inward to integer pixels so sub-pixel rounding can never bleed into split dividers.
  const left = Math.ceil(rect.left);
  const top = Math.ceil(rect.top);
  const right = Math.floor(rect.left + rect.width);
  const bottom = Math.floor(rect.top + rect.height);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  surface.removeAttribute("aria-hidden");
  surface.style.position = "fixed";
  surface.style.left = `${left}px`;
  surface.style.top = `${top}px`;
  surface.style.width = `${width}px`;
  surface.style.height = `${height}px`;
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

function deduplicatePartitionEntries(
  entries: readonly DesktopPersonaHubPartitionEntry[] | null,
): DesktopPersonaHubPartitionEntry[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  const byPartition = new Map<string, DesktopPersonaHubPartitionEntry>();
  for (const item of entries) {
    const partition = item.partition.trim();
    const hubUrl = item.hubUrl.trim();
    if (partition.length > 0 && hubUrl.length > 0) {
      byPartition.set(partition, { partition, hubUrl });
    }
  }
  return Array.from(byPartition.values());
}

function invokeSetHubEntries(
  entries: readonly DesktopPersonaHubPartitionEntry[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return enqueueHubSync(async () => {
    const personaBridge = getDesktopHost()?.persona;
    if (!personaBridge) {
      return false;
    }
    const normalizedEntries = deduplicatePartitionEntries(entries);
    try {
      if (
        personaBridge.supportsPerHubPartitions === true &&
        typeof personaBridge.setHubEntries === "function"
      ) {
        const accepted = await personaBridge.setHubEntries(
          normalizedEntries.length > 0 ? normalizedEntries : null,
          options,
        );
        return accepted === true;
      }
      const urls = Array.from(new Set(normalizedEntries.map((entry) => entry.hubUrl)));
      if (typeof personaBridge.setHubUrls === "function") {
        const accepted = await personaBridge.setHubUrls(urls.length > 0 ? urls : null, options);
        return accepted === true;
      }
      if (typeof personaBridge.setHubUrl === "function") {
        const accepted = await personaBridge.setHubUrl(urls[0] ?? null, options);
        return accepted === true;
      }
      return false;
    } catch {
      return false;
    }
  });
}

function invokeSetHubUrls(
  hubUrls: readonly string[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  const basePartition = getPersonaBridgeBasePartition();
  const entries = Array.isArray(hubUrls)
    ? hubUrls
        .map((url) => url.trim())
        .filter((url) => url.length > 0)
        .map((hubUrl) => ({ partition: basePartition, hubUrl }))
    : null;
  return invokeSetHubEntries(entries, options);
}

export async function syncPersonaHubEntriesWithMain(
  entries: readonly DesktopPersonaHubPartitionEntry[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return invokeSetHubEntries(entries, options);
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
  allowedHubEntries?: readonly DesktopPersonaHubPartitionEntry[];
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
  const targetPartition = resolveResidentPersonaPartition(hubId);
  if (!targetPartition) {
    return null;
  }

  const token = ++nextEnsureToken;
  const myGlobalGeneration = globalLifecycleGeneration;
  inFlightEnsureByHubId.set(hubId, {
    token,
    hubUrl: normalizedHubUrl,
    partition: targetPartition,
  });

  const pooledEntriesExcludingSelf: DesktopPersonaHubPartitionEntry[] = Array.from(
    residentPoolByHubId.values(),
  )
    .filter((entry) => entry.hubId !== hubId)
    .map((entry) => ({ partition: entry.partition, hubUrl: entry.hubUrl }));

  let allowlistEntries: DesktopPersonaHubPartitionEntry[];
  if (!supportsPerHubPartitions()) {
    // Legacy 0.17.534 shells only track a single active Hub URL on `persist:persona`.
    allowlistEntries = [{ partition: targetPartition, hubUrl: normalizedHubUrl }];
  } else if (normalizedInput.allowedHubEntries !== undefined) {
    allowlistEntries = [
      { partition: targetPartition, hubUrl: normalizedHubUrl },
      ...normalizedInput.allowedHubEntries.filter((entry) => entry.partition !== targetPartition),
    ];
  } else {
    allowlistEntries = [
      { partition: targetPartition, hubUrl: normalizedHubUrl },
      ...pooledEntriesExcludingSelf,
    ];
  }

  try {
    const registered = await invokeSetHubEntries(allowlistEntries, { enabled: true });

    // Cancel creation if a destroy/disable/re-ensure superseded us while awaiting IPC,
    // or if the main process rejected Hub registration.
    const activeEnsure = inFlightEnsureByHubId.get(hubId);
    if (
      !registered ||
      myGlobalGeneration !== globalLifecycleGeneration ||
      !activeEnsure ||
      activeEnsure.token !== token
    ) {
      return null;
    }

    const existing = residentPoolByHubId.get(hubId);
    if (
      existing &&
      existing.webview.isConnected &&
      existing.surface.isConnected &&
      existing.hubUrl === normalizedHubUrl &&
      existing.partition === targetPartition
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
    webview.setAttribute("partition", targetPartition);
    webview.setAttribute("allowpopups", "true");
    webview.setAttribute("spellcheck", "false");
    webview.setAttribute("autosize", "on");
    applyWebviewFillStyle(webview);
    webview.src = normalizedHubUrl;

    const entry: ResidentPersonaEntry = {
      hubId,
      hubUrl: normalizedHubUrl,
      partition: targetPartition,
      webview,
      surface,
    };
    applyParkedSurfaceStyle(entry);

    surface.appendChild(webview);
    host.appendChild(surface);

    residentPoolByHubId.set(hubId, entry);
    return webview;
  } finally {
    if (inFlightEnsureByHubId.get(hubId)?.token === token) {
      inFlightEnsureByHubId.delete(hubId);
    }
  }
}

export function getResidentPersonaPoolDiagnostics(): {
  pooledHubIds: string[];
  inFlightHubIds: string[];
} {
  return {
    pooledHubIds: Array.from(residentPoolByHubId.keys()),
    inFlightHubIds: Array.from(inFlightEnsureByHubId.keys()),
  };
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
    // Deleting the in-flight entry cancels any pending ensure (token mismatch) without leaking map keys.
    inFlightEnsureByHubId.delete(hubId);
    const entry = residentPoolByHubId.get(hubId);
    if (entry) {
      removeEntryDomOnly(entry);
      residentPoolByHubId.delete(hubId);
    }
    return;
  }

  globalLifecycleGeneration += 1;
  inFlightEnsureByHubId.clear();
  for (const entry of residentPoolByHubId.values()) {
    removeEntryDomOnly(entry);
  }
  residentPoolByHubId.clear();
  webviewsInteractive = true;
}

/**
 * Tears down pool entries whose Hub was removed or whose URL/partition changed, while leaving all
 * unchanged Hubs alive (parked at 1x1 when off-screen) for 0ms flicker-free switching.
 * When a Hub's URL changed and a child pane has already started an in-flight mount for the new
 * `(hubUrl, partition)`, removes only the stale DOM entry without canceling the new mount.
 */
export function reconcileResidentPersonaWebviews(
  hubs: ReadonlyArray<{ id: string; hubUrl: string }>,
): void {
  const expectedByHubId = new Map<string, { hubUrl: string; partition: string }>();
  for (const hub of hubs) {
    const trimmedUrl = hub.hubUrl.trim();
    const partition = hub.id ? resolveResidentPersonaPartition(hub.id) : null;
    if (hub.id && trimmedUrl && partition) {
      expectedByHubId.set(hub.id, { hubUrl: trimmedUrl, partition });
    }
  }

  for (const [hubId, entry] of Array.from(residentPoolByHubId.entries())) {
    const expected = expectedByHubId.get(hubId);
    if (!expected) {
      destroyResidentPersonaWebview(hubId);
      continue;
    }
    if (expected.hubUrl !== entry.hubUrl || expected.partition !== entry.partition) {
      removeEntryDomOnly(entry);
      residentPoolByHubId.delete(hubId);
      const inFlight = inFlightEnsureByHubId.get(hubId);
      if (
        inFlight &&
        (inFlight.hubUrl !== expected.hubUrl || inFlight.partition !== expected.partition)
      ) {
        inFlightEnsureByHubId.delete(hubId);
      }
    }
  }

  for (const [hubId, inFlight] of Array.from(inFlightEnsureByHubId.entries())) {
    const expected = expectedByHubId.get(hubId);
    if (
      !expected ||
      expected.hubUrl !== inFlight.hubUrl ||
      expected.partition !== inFlight.partition
    ) {
      inFlightEnsureByHubId.delete(hubId);
    }
  }
}

export async function disableResidentPersonaWebview(): Promise<void> {
  destroyResidentPersonaWebview();
  await invokeSetHubEntries(null, { enabled: false });
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
