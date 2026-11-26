import {
  buildPersonaHealthCheckUrl,
  isAllowedPersonaHealthCheckTarget,
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  matchPersonaWebviewAttachHubUrl,
  normalizePersonaHubUrl,
  normalizePersonaHubUrlList,
  parsePersonaSessionPath,
  PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL,
  PERSONA_GUEST_READY_IPC_CHANNEL,
  PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL,
  PERSONA_WEBVIEW_PARTITION,
  resolveAuthorizedPinnedPersonaHubUrl,
  type ParsedPersonaSessionPath,
  type PersonaWebviewAttachParams,
} from "./policy.js";

export {
  buildPersonaHealthCheckUrl,
  isAllowedPersonaHealthCheckTarget,
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  isPersonaWebviewAttach,
  isValidPersonaHubUrl,
  matchPersonaWebviewAttachHubUrl,
  MAX_PERSONA_HUB_URLS,
  normalizePersonaHubUrl,
  normalizePersonaHubUrlList,
  parsePersonaSessionPath,
  PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL,
  PERSONA_GUEST_READY_EVENT,
  PERSONA_GUEST_READY_EVENT_NAME,
  PERSONA_GUEST_READY_IPC_CHANNEL,
  PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL,
  PERSONA_OPEN_SESSION_EVENT,
  PERSONA_OPEN_SESSION_EVENT_NAME,
  PERSONA_SESSION_METADATA_RESULT_EVENT,
  PERSONA_SESSION_METADATA_RESULT_EVENT_NAME,
  PERSONA_WEBVIEW_PARTITION,
  resolveAuthorizedPinnedPersonaHubUrl,
  type NormalizedPersonaHubUrl,
  type ParsedPersonaSessionPath,
  type PersonaWebviewAttachParams,
} from "./policy.js";

export const PERSONA_HUB_URL_ARG_PREFIX = "--paseo-persona-hub-url=";

const PERSONA_HEALTH_CHECK_MAX_REDIRECTS = 2;
const PERSONA_HEALTH_CHECK_DEFAULT_TIMEOUT_MS = 5_000;
const PERSONA_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface PersonaHealthCheckSuccess {
  ok: true;
  hubName: string;
  version: string;
  latencyMs: number;
}

export interface PersonaHealthCheckFailure {
  ok: false;
  error: string;
  code?:
    | "not_configured"
    | "invalid_url"
    | "unauthorized_caller"
    | "redirect_blocked"
    | "http_error"
    | "invalid_payload"
    | "timeout"
    | "network_error";
}

export type PersonaHealthCheckResult = PersonaHealthCheckSuccess | PersonaHealthCheckFailure;

export interface PersonaIpcFrameLike {
  readonly detached?: boolean;
  readonly parent?: object | null;
  readonly top?: object | null;
  readonly processId?: number;
  readonly routingId?: number;
}

export interface PersonaIpcSenderLike {
  readonly id: number;
  readonly mainFrame?: PersonaIpcFrameLike | null;
  isDestroyed(): boolean;
  getType?: () => string;
}

export interface PersonaIpcEventLike {
  readonly sender: PersonaIpcSenderLike | null | undefined;
  readonly senderFrame?: PersonaIpcFrameLike | null;
  readonly processId?: number;
  readonly frameId?: number;
}

function isMatchingMainFrameIdentity(
  event: {
    readonly senderFrame?: PersonaIpcFrameLike | null;
    readonly processId?: number;
    readonly frameId?: number;
  },
  mainFrame: PersonaIpcFrameLike | null | undefined,
): boolean {
  const senderFrame = event.senderFrame;
  if (!mainFrame || !senderFrame || senderFrame !== mainFrame) {
    return false;
  }
  if (senderFrame.detached === true) {
    return false;
  }
  if (senderFrame.parent !== undefined && senderFrame.parent !== null) {
    return false;
  }
  if (senderFrame.top !== undefined && senderFrame.top !== senderFrame) {
    return false;
  }
  const processMismatch =
    typeof event.processId === "number" &&
    typeof senderFrame.processId === "number" &&
    event.processId !== senderFrame.processId;
  const frameMismatch =
    typeof event.frameId === "number" &&
    typeof senderFrame.routingId === "number" &&
    event.frameId !== senderFrame.routingId;
  return !processMismatch && !frameMismatch;
}

/**
 * Verifies that a privileged Persona IPC request comes from the main frame of a
 * registered Paseo host window (never a guest webview, subframe, or destroyed sender).
 */
export function isTrustedPersonaHostIpcEvent(
  event: PersonaIpcEventLike | null | undefined,
  registeredHostWebContentsIds: ReadonlySet<number>,
): boolean {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed()) {
    return false;
  }
  if (!registeredHostWebContentsIds.has(sender.id)) {
    return false;
  }
  if (typeof sender.getType === "function" && sender.getType() !== "window") {
    return false;
  }
  if (!event) {
    return false;
  }
  return isMatchingMainFrameIdentity(event, sender.mainFrame);
}

function readTrimmedString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return fallback;
}

function resolveHealthRedirectTarget(
  response: Response,
  currentUrl: string,
  normalizedHubUrl: string,
  redirectCount: number,
): string | null {
  const location = response.headers.get("location");
  if (!location || redirectCount >= PERSONA_HEALTH_CHECK_MAX_REDIRECTS) {
    return null;
  }
  try {
    const nextUrl = new URL(location, currentUrl).toString();
    return isAllowedPersonaHealthCheckTarget(nextUrl, normalizedHubUrl) ? nextUrl : null;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function cancelResponseBodySafely(response: Response): void {
  try {
    const cancelPromise = response.body?.cancel?.();
    if (cancelPromise && typeof cancelPromise.catch === "function") {
      void cancelPromise.catch(() => undefined);
    }
  } catch {
    // Ignore body cancellation errors when cleaning up timed-out or redirected responses.
  }
}

async function readHealthJsonWithAbort(response: Response, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) {
    cancelResponseBodySafely(response);
    throw createAbortError();
  }
  if (!signal) {
    return await response.json();
  }

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancelResponseBodySafely(response);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  const jsonPromise = response.json();
  // Suppress unhandled rejection if abort wins the race before jsonPromise settles.
  void jsonPromise.catch(() => undefined);

  try {
    return await Promise.race([jsonPromise, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function parseHealthJsonResponse(
  response: Response,
  fallbackHost: string,
  startedAt: number,
  signal?: AbortSignal,
): Promise<PersonaHealthCheckResult> {
  if (!response.ok) {
    cancelResponseBodySafely(response);
    return {
      ok: false,
      code: "http_error",
      error: `HTTP ${response.status}`,
    };
  }
  let data: unknown;
  try {
    data = await readHealthJsonWithAbort(response, signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      return { ok: false, code: "timeout", error: "Request timed out" };
    }
    return {
      ok: false,
      code: "invalid_payload",
      error: "Unexpected health payload",
    };
  }
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (record?.ok !== true) {
    return {
      ok: false,
      code: "invalid_payload",
      error: "Unexpected health payload",
    };
  }
  return {
    ok: true,
    hubName: readTrimmedString(record.hub_name, fallbackHost),
    version: readTrimmedString(record.version, "unknown"),
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

/**
 * Probes the fixed `/api/v1/health` path of a pre-registered Persona Hub from the main process.
 * Sends no credentials/cookies and manually validates any redirect to stay on the registered Hub
 * origin and fixed health path.
 */
export async function probePersonaHubHealth(
  configuredHubUrl: string | undefined | null,
  options: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PersonaHealthCheckResult> {
  const normalized = normalizePersonaHubUrl(configuredHubUrl);
  const initialUrl = buildPersonaHealthCheckUrl(configuredHubUrl);
  if (!normalized || !initialUrl) {
    return {
      ok: false,
      code: "not_configured",
      error: "Persona Hub URL is not registered",
    };
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, code: "network_error", error: "fetch unavailable" };
  }

  const timeoutMs = options.timeoutMs ?? PERSONA_HEALTH_CHECK_DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();

  try {
    let currentUrl = initialUrl;
    for (
      let redirectCount = 0;
      redirectCount <= PERSONA_HEALTH_CHECK_MAX_REDIRECTS;
      redirectCount += 1
    ) {
      const response = await fetchFn(currentUrl, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: controller?.signal,
      });

      if (!PERSONA_REDIRECT_STATUSES.has(response.status)) {
        return await parseHealthJsonResponse(
          response,
          normalized.displayHost,
          startedAt,
          controller?.signal,
        );
      }

      const nextUrl = resolveHealthRedirectTarget(
        response,
        currentUrl,
        normalized.url,
        redirectCount,
      );
      cancelResponseBodySafely(response);
      if (!nextUrl) {
        return {
          ok: false,
          code: "redirect_blocked",
          error: "Health check redirect blocked",
        };
      }
      currentUrl = nextUrl;
    }

    return {
      ok: false,
      code: "redirect_blocked",
      error: "Health check redirect blocked",
    };
  } catch (error) {
    if (controller?.signal.aborted || isAbortError(error)) {
      return { ok: false, code: "timeout", error: "Request timed out" };
    }
    return {
      ok: false,
      code: "network_error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const PERSONA_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "shadercache",
] as const;

export interface PersonaWebviewSession {
  clearStorageData(options: {
    origin?: string;
    storages: Array<(typeof PERSONA_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

export interface PersonaWebviewGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
  getURL?: () => string;
}

export interface RegisteredPersonaHostHubState {
  readonly enabled: boolean;
  readonly hubUrls: readonly string[];
}

export type PersonaHealthCheckTargetResolution =
  | { ok: true; hubUrl: string }
  | { ok: false; code: "not_configured" | "invalid_url"; error: string };

export type PersonaClearSessionTargetResolution =
  | { ok: true; targetHubUrl: string | null }
  | { ok: false; error: string };

export interface PersonaHostHubRegistry {
  setHostHubUrls(hostWebContentsId: number, rawHubUrls: unknown, rawOptions?: unknown): boolean;
  setHostHubUrl(hostWebContentsId: number, rawHubUrl: unknown, rawOptions?: unknown): boolean;
  getHostHubState(hostWebContentsId: number): RegisteredPersonaHostHubState | null;
  resolveHealthCheckTarget(
    hostWebContentsId: number,
    rawTargetHubUrl?: unknown,
  ): PersonaHealthCheckTargetResolution;
  resolveClearSessionTarget(
    hostWebContentsId: number,
    rawTargetHubUrl?: unknown,
  ): PersonaClearSessionTargetResolution;
  authorizeWebviewAttach(
    hostWebContentsId: number,
    params: PersonaWebviewAttachParams,
  ): string | null;
  bindAttachedGuest(
    hostWebContentsId: number,
    guestWebContentsId: number,
    initialUrl?: string,
  ): string | null;
  getGuestAuthorizedHubUrl(guestWebContentsId: number): string;
  getGuestPinnedHubUrl(guestWebContentsId: number): string | null;
  removeGuest(guestWebContentsId: number): void;
  removeHost(hostWebContentsId: number): void;
}

function readEnabledOption(rawOptions: unknown): boolean {
  if (
    rawOptions &&
    typeof rawOptions === "object" &&
    typeof (rawOptions as { enabled?: unknown }).enabled === "boolean"
  ) {
    return (rawOptions as { enabled: boolean }).enabled;
  }
  return true;
}

function dequeuePendingPinnedHubUrl(
  pendingQueue: string[] | undefined,
  initialUrl?: string,
): string | null {
  if (!pendingQueue || pendingQueue.length === 0) {
    return null;
  }
  const normalizedInitial = normalizePersonaHubUrl(initialUrl);
  if (normalizedInitial) {
    let bestIndex = -1;
    let bestBasePathLength = -1;
    for (let index = 0; index < pendingQueue.length; index += 1) {
      const candidate = normalizePersonaHubUrl(pendingQueue[index]);
      if (!candidate || candidate.origin !== normalizedInitial.origin) {
        continue;
      }
      const pathMatches =
        !candidate.basePath ||
        normalizedInitial.basePath === candidate.basePath ||
        normalizedInitial.basePath.startsWith(`${candidate.basePath}/`);
      const score = pathMatches ? candidate.basePath.length + 1 : 0;
      if (score > bestBasePathLength) {
        bestBasePathLength = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      const [matched] = pendingQueue.splice(bestIndex, 1);
      return matched ?? null;
    }
  }
  return pendingQueue.shift() ?? null;
}

/**
 * Maintains per-host-window multi-Hub URL allowlists and pins every attached Persona guest
 * `<webview>` strictly to its own single Hub origin so one guest can never navigate or send
 * IPC on behalf of another registered Hub.
 */
export function createPersonaHostHubRegistry(): PersonaHostHubRegistry {
  const hostStateByWebContentsId = new Map<number, { enabled: boolean; hubUrls: string[] }>();
  const pendingAttachQueueByHostId = new Map<number, string[]>();
  const guestBindingByWebContentsId = new Map<
    number,
    { hostWebContentsId: number; hubUrl: string }
  >();

  return {
    setHostHubUrls(hostWebContentsId, rawHubUrls, rawOptions) {
      const normalizedUrls = normalizePersonaHubUrlList(rawHubUrls);
      if (normalizedUrls === null) {
        return false;
      }
      if (normalizedUrls.length === 0) {
        hostStateByWebContentsId.delete(hostWebContentsId);
        return true;
      }
      hostStateByWebContentsId.set(hostWebContentsId, {
        enabled: readEnabledOption(rawOptions),
        hubUrls: normalizedUrls,
      });
      return true;
    },

    setHostHubUrl(hostWebContentsId, rawHubUrl, rawOptions) {
      if (rawHubUrl === null || rawHubUrl === undefined || rawHubUrl === "") {
        hostStateByWebContentsId.delete(hostWebContentsId);
        return true;
      }
      if (typeof rawHubUrl !== "string") {
        return false;
      }
      const normalized = normalizePersonaHubUrl(rawHubUrl);
      if (!normalized) {
        return false;
      }
      hostStateByWebContentsId.set(hostWebContentsId, {
        enabled: readEnabledOption(rawOptions),
        hubUrls: [normalized.url],
      });
      return true;
    },

    getHostHubState(hostWebContentsId) {
      return hostStateByWebContentsId.get(hostWebContentsId) ?? null;
    },

    resolveHealthCheckTarget(hostWebContentsId, rawTargetHubUrl) {
      const hostState = hostStateByWebContentsId.get(hostWebContentsId);
      if (!hostState || hostState.hubUrls.length === 0) {
        return {
          ok: false,
          code: "not_configured",
          error: "Persona Hub URL is not registered",
        };
      }
      if (rawTargetHubUrl === undefined || rawTargetHubUrl === null || rawTargetHubUrl === "") {
        return { ok: true, hubUrl: hostState.hubUrls[0] };
      }
      if (typeof rawTargetHubUrl !== "string") {
        return { ok: false, code: "invalid_url", error: "Invalid Persona Hub URL" };
      }
      const normalized = normalizePersonaHubUrl(rawTargetHubUrl);
      if (!normalized) {
        return { ok: false, code: "invalid_url", error: "Invalid Persona Hub URL" };
      }
      if (!hostState.hubUrls.includes(normalized.url)) {
        return {
          ok: false,
          code: "not_configured",
          error: "Persona Hub URL is not registered",
        };
      }
      return { ok: true, hubUrl: normalized.url };
    },

    resolveClearSessionTarget(hostWebContentsId, rawTargetHubUrl) {
      if (rawTargetHubUrl === undefined || rawTargetHubUrl === null || rawTargetHubUrl === "") {
        return { ok: true, targetHubUrl: null };
      }
      if (typeof rawTargetHubUrl !== "string") {
        return { ok: false, error: "Invalid Persona Hub URL" };
      }
      const normalized = normalizePersonaHubUrl(rawTargetHubUrl);
      if (!normalized) {
        return { ok: false, error: "Invalid Persona Hub URL" };
      }
      const hostState = hostStateByWebContentsId.get(hostWebContentsId);
      if (!hostState || !hostState.hubUrls.includes(normalized.url)) {
        return { ok: false, error: "Persona Hub URL is not registered" };
      }
      return { ok: true, targetHubUrl: normalized.url };
    },

    authorizeWebviewAttach(hostWebContentsId, params) {
      const hostState = hostStateByWebContentsId.get(hostWebContentsId);
      if (!hostState?.enabled) {
        return null;
      }
      const matchedHubUrl = matchPersonaWebviewAttachHubUrl(params, hostState.hubUrls);
      if (!matchedHubUrl) {
        return null;
      }
      const queue = pendingAttachQueueByHostId.get(hostWebContentsId) ?? [];
      queue.push(matchedHubUrl);
      pendingAttachQueueByHostId.set(hostWebContentsId, queue);
      return matchedHubUrl;
    },

    bindAttachedGuest(hostWebContentsId, guestWebContentsId, initialUrl) {
      const queue = pendingAttachQueueByHostId.get(hostWebContentsId);
      const pinnedHubUrl = dequeuePendingPinnedHubUrl(queue, initialUrl);
      if (queue && queue.length === 0) {
        pendingAttachQueueByHostId.delete(hostWebContentsId);
      }
      if (!pinnedHubUrl) {
        return null;
      }
      guestBindingByWebContentsId.set(guestWebContentsId, {
        hostWebContentsId,
        hubUrl: pinnedHubUrl,
      });
      return pinnedHubUrl;
    },

    getGuestAuthorizedHubUrl(guestWebContentsId) {
      const binding = guestBindingByWebContentsId.get(guestWebContentsId);
      if (!binding) {
        return "";
      }
      const hostState = hostStateByWebContentsId.get(binding.hostWebContentsId);
      if (!hostState?.enabled) {
        return "";
      }
      return resolveAuthorizedPinnedPersonaHubUrl(binding.hubUrl, hostState.hubUrls) ?? "";
    },

    getGuestPinnedHubUrl(guestWebContentsId) {
      return guestBindingByWebContentsId.get(guestWebContentsId)?.hubUrl ?? null;
    },

    removeGuest(guestWebContentsId) {
      guestBindingByWebContentsId.delete(guestWebContentsId);
    },

    removeHost(hostWebContentsId) {
      hostStateByWebContentsId.delete(hostWebContentsId);
      pendingAttachQueueByHostId.delete(hostWebContentsId);
      for (const [guestId, binding] of guestBindingByWebContentsId.entries()) {
        if (binding.hostWebContentsId === hostWebContentsId) {
          guestBindingByWebContentsId.delete(guestId);
        }
      }
    },
  };
}

export interface PersonaWebviewContentsLike extends PersonaWebviewGuest {
  readonly session: object;
  getType(): string;
}

export interface PersonaWebviewSessionsLike {
  fromPartition(partition: string): PersonaWebviewSession;
}

export interface PersonaWindowOpenSessionPayload extends ParsedPersonaSessionPath {
  source: "window-open";
  rawHref: string;
}

export interface PersonaNavigationEvent {
  url: string;
  isMainFrame?: boolean;
  preventDefault(): void;
}

export interface PersonaGuardableWebContents {
  getURL(): string;
  on(event: "will-navigate", listener: (event: PersonaNavigationEvent, url?: string) => void): void;
  on(
    event: "will-frame-navigate",
    listener: (event: PersonaNavigationEvent, url?: string) => void,
  ): void;
  on(event: "will-redirect", listener: (event: PersonaNavigationEvent, url?: string) => void): void;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "deny" } | { action: "allow" },
  ): void;
}

export interface PersonaNavigationGuardDeps {
  getConfiguredHubUrl(): string;
  onOpenSession(payload: PersonaWindowOpenSessionPayload): void;
  openExternalUrl(url: string): Promise<void> | void;
  logWarn?: (message: string, details?: unknown) => void;
}

export function getPersonaWebviewSession(
  sessions: PersonaWebviewSessionsLike,
): PersonaWebviewSession {
  return sessions.fromPartition(PERSONA_WEBVIEW_PARTITION);
}

export function listPersonaWebviewGuests(input: {
  personaSession: object;
  webContents: PersonaWebviewContentsLike[];
}): PersonaWebviewGuest[] {
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      contents.session === input.personaSession,
  );
}

function matchesGuestTargetOrigin(
  guest: PersonaWebviewGuest,
  targetOrigin: string,
  getGuestHubUrl?: (guest: PersonaWebviewGuest) => string | null,
): boolean {
  const pinnedUrl = getGuestHubUrl?.(guest);
  const normalizedPinned = normalizePersonaHubUrl(pinnedUrl);
  if (normalizedPinned) {
    return normalizedPinned.origin === targetOrigin;
  }
  try {
    const liveUrl = guest.getURL?.();
    const normalizedLive = normalizePersonaHubUrl(liveUrl);
    return normalizedLive !== null && normalizedLive.origin === targetOrigin;
  } catch {
    return false;
  }
}

export async function clearPersonaWebviewSession(input: {
  personaSession: PersonaWebviewSession;
  listGuests(): PersonaWebviewGuest[];
  logReloadError(guestId: number, error: unknown): void;
  targetHubUrl?: string | null;
  getGuestHubUrl?: (guest: PersonaWebviewGuest) => string | null;
}): Promise<void> {
  const hasTargetHubUrl =
    input.targetHubUrl !== undefined && input.targetHubUrl !== null && input.targetHubUrl !== "";

  if (hasTargetHubUrl) {
    const normalizedTarget = normalizePersonaHubUrl(input.targetHubUrl);
    if (!normalizedTarget) {
      throw new Error("Invalid Persona Hub URL");
    }
    // Clear storage strictly for the requested Hub origin so other Hubs stay signed in.
    await input.personaSession.clearStorageData({
      origin: normalizedTarget.origin,
      storages: [...PERSONA_STORAGE_TYPES],
    });
    for (const guest of input.listGuests()) {
      if (
        guest.isDestroyed() ||
        !matchesGuestTargetOrigin(guest, normalizedTarget.origin, input.getGuestHubUrl)
      ) {
        continue;
      }
      try {
        guest.reload();
      } catch (error) {
        input.logReloadError(guest.id, error);
      }
    }
    return;
  }

  await Promise.all([
    input.personaSession.clearStorageData({ storages: [...PERSONA_STORAGE_TYPES] }),
    input.personaSession.clearCache(),
    input.personaSession.clearAuthCache(),
  ]);

  for (const guest of input.listGuests()) {
    if (guest.isDestroyed()) {
      continue;
    }
    try {
      guest.reload();
    } catch (error) {
      input.logReloadError(guest.id, error);
    }
  }
}

function readAuthorizedHubUrl(deps: PersonaNavigationGuardDeps): string | null {
  const normalized = normalizePersonaHubUrl(deps.getConfiguredHubUrl());
  return normalized ? normalized.url : null;
}

function openExternalSafely(url: string, deps: PersonaNavigationGuardDeps): void {
  try {
    const result = deps.openExternalUrl(url);
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch((error) => {
        deps.logWarn?.("[persona-webview] failed to open external url", { error });
      });
    }
  } catch (error) {
    deps.logWarn?.("[persona-webview] failed to open external url", { error });
  }
}

export function registerPersonaWebviewNavigationGuards(
  contents: PersonaGuardableWebContents,
  deps: PersonaNavigationGuardDeps,
): void {
  const guardTopLevelNavigation = (event: PersonaNavigationEvent, fallbackUrl?: string): void => {
    const targetUrl = event.url || fallbackUrl;
    if (!isAllowedPersonaWebviewUrl(targetUrl)) {
      event.preventDefault();
      return;
    }
    const authorizedHubUrl = readAuthorizedHubUrl(deps);
    if (!authorizedHubUrl) {
      // Unregistered or revoked Hub: block navigation silently without escalating externally.
      event.preventDefault();
      return;
    }
    if (
      targetUrl &&
      targetUrl !== "about:blank" &&
      !isAllowedPersonaTargetOrigin(targetUrl, authorizedHubUrl)
    ) {
      event.preventDefault();
      openExternalSafely(targetUrl, deps);
    }
  };

  const guardFrameNavigation = (event: PersonaNavigationEvent, fallbackUrl?: string): void => {
    const targetUrl = event.url || fallbackUrl;
    if (!isAllowedPersonaWebviewUrl(targetUrl)) {
      event.preventDefault();
      return;
    }
    if (event.isMainFrame === false) {
      // Subframes use independent protocol validation and never trigger system browser opens.
      return;
    }
    guardTopLevelNavigation(event, targetUrl);
  };

  contents.on("will-navigate", (event, url) => {
    guardTopLevelNavigation(event, url);
  });

  contents.on("will-redirect", (event, url) => {
    guardFrameNavigation(event, url);
  });

  contents.on("will-frame-navigate", (event, url) => {
    guardFrameNavigation(event, url);
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedPersonaWebviewUrl(url)) {
      return { action: "deny" };
    }
    const authorizedHubUrl = readAuthorizedHubUrl(deps);
    if (!authorizedHubUrl) {
      return { action: "deny" };
    }
    const currentMainUrl = contents.getURL().trim();
    if (
      !currentMainUrl ||
      currentMainUrl === "about:blank" ||
      !isAllowedPersonaTargetOrigin(currentMainUrl, authorizedHubUrl)
    ) {
      return { action: "deny" };
    }
    const parsedSession = parsePersonaSessionPath(url, authorizedHubUrl);
    if (parsedSession) {
      deps.onOpenSession({
        ...parsedSession,
        source: "window-open",
        rawHref: url,
      });
      return { action: "deny" };
    }
    if (url !== "about:blank") {
      openExternalSafely(url, deps);
    }
    return { action: "deny" };
  });
}

export interface PersonaGuestFrameLike extends PersonaIpcFrameLike {
  readonly url: string;
  readonly origin?: string;
}

export interface PersonaGuestIpcMainEventLike {
  readonly sender: object | null | undefined;
  readonly senderFrame?: PersonaGuestFrameLike | null;
  readonly processId?: number;
  readonly frameId?: number;
}

export interface PersonaGuestIpcWebContentsLike {
  readonly id: number;
  readonly mainFrame?: PersonaGuestFrameLike | null;
  isDestroyed(): boolean;
  getType?: () => string;
  getURL(): string;
  on(
    event: "ipc-message",
    listener: (event: PersonaGuestIpcMainEventLike, channel: string, ...args: unknown[]) => void,
  ): void;
}

export interface PersonaGuestMainFrameContext {
  guestWebContentsId: number;
  frameUrl: string;
}

export interface PersonaGuestIpcBridgeDeps {
  getConfiguredHubUrl(): string;
  onGuestOpenSession(payload: Record<string, unknown>, context: PersonaGuestMainFrameContext): void;
  onGuestSessionMetadataResult(
    payload: Record<string, unknown>,
    context: PersonaGuestMainFrameContext,
  ): void;
  onGuestReady(context: PersonaGuestMainFrameContext): void;
}

function isSameOriginHttpUrlStrict(urlString: unknown, expectedOrigin: string): boolean {
  if (typeof urlString !== "string") {
    return false;
  }
  const trimmed = urlString.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.origin === expectedOrigin
    );
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAuthorizedGuestMainFrameOrigin(
  senderFrame: PersonaGuestFrameLike,
  contents: PersonaGuestIpcWebContentsLike,
  configuredHubUrl: string | undefined | null,
): boolean {
  const normalizedHub = normalizePersonaHubUrl(configuredHubUrl);
  if (!normalizedHub) {
    return false;
  }
  if (!isSameOriginHttpUrlStrict(senderFrame.url, normalizedHub.origin)) {
    return false;
  }
  if (senderFrame.origin !== undefined && senderFrame.origin !== normalizedHub.origin) {
    return false;
  }
  return isSameOriginHttpUrlStrict(contents.getURL(), normalizedHub.origin);
}

/**
 * Verifies in the Electron main process that a guest `ipc-message` originates strictly from the
 * guest WebContents' real `mainFrame` on the currently registered Persona Hub origin.
 * Fail-closed when frame identity, mainFrame, or registered Hub origin is missing or mismatched.
 */
export function isTrustedPersonaGuestMainFrameIpcEvent(
  event: PersonaGuestIpcMainEventLike | null | undefined,
  contents: PersonaGuestIpcWebContentsLike | null | undefined,
  configuredHubUrl: string | undefined | null,
): boolean {
  if (!event || !contents || contents.isDestroyed()) {
    return false;
  }
  if (typeof contents.getType === "function" && contents.getType() !== "webview") {
    return false;
  }
  if (event.sender !== contents) {
    return false;
  }
  if (!isMatchingMainFrameIdentity(event, contents.mainFrame) || !event.senderFrame) {
    return false;
  }
  return isAuthorizedGuestMainFrameOrigin(event.senderFrame, contents, configuredHubUrl);
}

/**
 * Bridges trusted guest main-frame IPC messages (`open-session`, `session-metadata-result`,
 * `ready`) through the Electron main process using real `senderFrame === contents.mainFrame`
 * verification and registered Hub origin checks.
 */
export function registerPersonaWebviewGuestIpcBridge(
  contents: PersonaGuestIpcWebContentsLike,
  deps: PersonaGuestIpcBridgeDeps,
): void {
  contents.on("ipc-message", (event, channel, ...args) => {
    if (
      channel !== PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL &&
      channel !== PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL &&
      channel !== PERSONA_GUEST_READY_IPC_CHANNEL
    ) {
      return;
    }

    if (!isTrustedPersonaGuestMainFrameIpcEvent(event, contents, deps.getConfiguredHubUrl())) {
      return;
    }

    const frameUrl = event.senderFrame?.url;
    if (typeof frameUrl !== "string") {
      return;
    }
    const context: PersonaGuestMainFrameContext = {
      guestWebContentsId: contents.id,
      frameUrl,
    };

    if (channel === PERSONA_GUEST_READY_IPC_CHANNEL) {
      deps.onGuestReady(context);
      return;
    }

    const payload = args[0];
    if (!isPlainRecord(payload)) {
      return;
    }

    if (channel === PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL) {
      deps.onGuestOpenSession(payload, context);
      return;
    }

    if (channel === PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL) {
      deps.onGuestSessionMetadataResult(payload, context);
    }
  });
}
