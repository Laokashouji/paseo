import {
  buildPersonaHealthCheckUrl,
  isAllowedPersonaHealthCheckTarget,
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  normalizePersonaHubUrl,
  parsePersonaSessionPath,
  PERSONA_WEBVIEW_PARTITION,
  type ParsedPersonaSessionPath,
} from "./policy.js";

export {
  buildPersonaHealthCheckUrl,
  isAllowedPersonaHealthCheckTarget,
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  isPersonaWebviewAttach,
  isValidPersonaHubUrl,
  normalizePersonaHubUrl,
  parsePersonaSessionPath,
  PERSONA_OPEN_SESSION_EVENT,
  PERSONA_OPEN_SESSION_EVENT_NAME,
  PERSONA_WEBVIEW_PARTITION,
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

export interface PersonaIpcSenderLike {
  readonly id: number;
  readonly mainFrame?: object | null;
  isDestroyed(): boolean;
  getType?: () => string;
}

export interface PersonaIpcEventLike {
  readonly sender: PersonaIpcSenderLike | null | undefined;
  readonly senderFrame?: object | null;
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
  if (!event?.senderFrame || !sender.mainFrame) {
    return false;
  }
  return event.senderFrame === sender.mainFrame;
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

async function parseHealthJsonResponse(
  response: Response,
  fallbackHost: string,
  startedAt: number,
): Promise<PersonaHealthCheckResult> {
  if (!response.ok) {
    return {
      ok: false,
      code: "http_error",
      error: `HTTP ${response.status}`,
    };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
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
        return parseHealthJsonResponse(response, normalized.displayHost, startedAt);
      }

      const nextUrl = resolveHealthRedirectTarget(
        response,
        currentUrl,
        normalized.url,
        redirectCount,
      );
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
    if (error instanceof Error && error.name === "AbortError") {
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
    storages: Array<(typeof PERSONA_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

export interface PersonaWebviewGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
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

export async function clearPersonaWebviewSession(input: {
  personaSession: PersonaWebviewSession;
  listGuests(): PersonaWebviewGuest[];
  logReloadError(guestId: number, error: unknown): void;
}): Promise<void> {
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
