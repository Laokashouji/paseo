export const PERSONA_WEBVIEW_PARTITION = "persist:persona";
export const PERSONA_OPEN_SESSION_EVENT_NAME = "persona-open-session";
export const PERSONA_OPEN_SESSION_EVENT = `paseo:event:${PERSONA_OPEN_SESSION_EVENT_NAME}`;
export const PERSONA_SESSION_METADATA_RESULT_EVENT_NAME = "persona-session-metadata-result";
export const PERSONA_SESSION_METADATA_RESULT_EVENT = `paseo:event:${PERSONA_SESSION_METADATA_RESULT_EVENT_NAME}`;
export const PERSONA_GUEST_READY_EVENT_NAME = "persona-guest-ready";
export const PERSONA_GUEST_READY_EVENT = `paseo:event:${PERSONA_GUEST_READY_EVENT_NAME}`;

export const PERSONA_GUEST_OPEN_SESSION_IPC_CHANNEL = "paseo:persona:open-session";
export const PERSONA_GUEST_SESSION_METADATA_RESULT_IPC_CHANNEL =
  "paseo:persona:session-metadata-result";
export const PERSONA_GUEST_READY_IPC_CHANNEL = "paseo:persona:ready";

export interface ParsedPersonaSessionPath {
  machineId: string;
  sessionId: string;
  view?: "chat" | "term";
}

export interface PersonaWebviewAttachParams {
  src?: string;
  partition?: string;
}

export interface NormalizedPersonaHubUrl {
  url: string;
  origin: string;
  basePath: string;
  displayHost: string;
}

const PERSONA_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const PERSONA_HEALTH_ENDPOINT_SUFFIX = "/api/v1/health";

function parseUrl(value: string | undefined | null): URL | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function normalizeBasePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" || trimmed === "/" ? "" : trimmed;
}

/**
 * Normalizes a configured Persona Hub base URL.
 * Rejects empty values, non-HTTP(S) schemes (including about:blank), and embedded credentials.
 */
export function normalizePersonaHubUrl(
  value: string | undefined | null,
): NormalizedPersonaHubUrl | null {
  const parsed = parseUrl(value);
  if (!parsed || !PERSONA_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  const basePath = normalizeBasePath(parsed.pathname);
  const url = `${parsed.origin}${basePath}`;
  const displayHost = basePath ? `${parsed.host}${basePath}` : parsed.host;
  return {
    url,
    origin: parsed.origin,
    basePath,
    displayHost,
  };
}

export function isValidPersonaHubUrl(value: string | undefined | null): boolean {
  return normalizePersonaHubUrl(value) !== null;
}

export function buildPersonaHealthCheckUrl(
  configuredHubUrl: string | undefined | null,
): string | null {
  const hub = normalizePersonaHubUrl(configuredHubUrl);
  if (!hub) {
    return null;
  }
  return `${hub.url}${PERSONA_HEALTH_ENDPOINT_SUFFIX}`;
}

/**
 * Validates that a health-check request or redirect target stays on the configured Hub's origin
 * and fixed `/api/v1/health` path, without credentials.
 */
export function isAllowedPersonaHealthCheckTarget(
  targetUrl: string | undefined | null,
  configuredHubUrl: string | undefined | null,
): boolean {
  const hub = normalizePersonaHubUrl(configuredHubUrl);
  const candidate = parseUrl(targetUrl);
  if (!hub || !candidate || !PERSONA_ALLOWED_PROTOCOLS.has(candidate.protocol)) {
    return false;
  }
  if (candidate.username || candidate.password) {
    return false;
  }
  if (candidate.origin !== hub.origin) {
    return false;
  }
  const expectedPath = `${hub.basePath}${PERSONA_HEALTH_ENDPOINT_SUFFIX}`;
  const candidatePath = candidate.pathname.replace(/\/+$/, "");
  return candidatePath === expectedPath;
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

/**
 * Only http:, https:, and exact about:blank are allowed inside the Persona webview.
 * Rejects file:, javascript:, data:, paseo:, empty strings, and malformed URLs.
 */
export function isAllowedPersonaWebviewUrl(value: string | undefined): boolean {
  const parsed = parseUrl(value);
  if (!parsed) {
    return false;
  }
  if (parsed.href === "about:blank") {
    return true;
  }
  return PERSONA_ALLOWED_PROTOCOLS.has(parsed.protocol);
}

/**
 * Checks whether `urlString` is allowed as a navigation target for the configured Persona Hub.
 * Permits `about:blank` and URLs whose origin matches `configuredHubUrl` (http/https only).
 */
export function isAllowedPersonaTargetOrigin(
  urlString: string | undefined,
  configuredHubUrl: string | undefined | null,
): boolean {
  const candidate = parseUrl(urlString);
  if (!candidate) {
    return false;
  }
  if (candidate.href === "about:blank") {
    return true;
  }
  if (!PERSONA_ALLOWED_PROTOCOLS.has(candidate.protocol)) {
    return false;
  }
  const hub = normalizePersonaHubUrl(configuredHubUrl);
  if (!hub) {
    return false;
  }
  return candidate.origin === hub.origin;
}

/**
 * Validates `<webview>` attachment for the isolated `persist:persona` partition.
 * Requires a pre-registered valid HTTP(S) Hub URL and a same-origin HTTP(S) initial `src`.
 * Refuses attachment before a trusted host has registered an enabled Hub.
 */
export function isPersonaWebviewAttach(
  params: PersonaWebviewAttachParams,
  configuredHubUrl?: string | null,
): boolean {
  if (params.partition !== PERSONA_WEBVIEW_PARTITION) {
    return false;
  }
  const hub = normalizePersonaHubUrl(configuredHubUrl);
  if (!hub) {
    return false;
  }
  const candidate = parseUrl(params.src);
  if (!candidate || !PERSONA_ALLOWED_PROTOCOLS.has(candidate.protocol)) {
    return false;
  }
  if (candidate.username || candidate.password) {
    return false;
  }
  return candidate.origin === hub.origin;
}

/**
 * Parses a same-origin Persona agent session URL:
 * - `/s/:mid/:sid` (optionally prefixed with the Hub's reverse-proxy base path)
 * - `/t/:mid/:space/:slot/:sid` (Herdr tab route when `:sid` is present)
 */
export function parsePersonaSessionPath(
  urlString: string,
  configuredHubUrl: string,
): ParsedPersonaSessionPath | null {
  const candidate = parseUrl(urlString);
  const hub = parseUrl(configuredHubUrl);
  if (
    !candidate ||
    !hub ||
    !PERSONA_ALLOWED_PROTOCOLS.has(candidate.protocol) ||
    !PERSONA_ALLOWED_PROTOCOLS.has(hub.protocol) ||
    candidate.origin !== hub.origin
  ) {
    return null;
  }

  const basePath = normalizeBasePath(hub.pathname);
  let relativePath = candidate.pathname;
  if (basePath) {
    if (relativePath === basePath) {
      relativePath = "/";
    } else if (relativePath.startsWith(`${basePath}/`)) {
      relativePath = relativePath.slice(basePath.length);
    } else {
      return null;
    }
  }

  let rawMachineId: string | undefined;
  let rawSessionId: string | undefined;

  const sessionMatch = /^\/s\/([^/]+)\/([^/]+)(?:\/|$)/.exec(relativePath);
  if (sessionMatch) {
    rawMachineId = sessionMatch[1];
    rawSessionId = sessionMatch[2];
  } else {
    const tabMatch = /^\/t\/([^/]+)\/[^/]+\/[^/]+\/([^/]+)(?:\/|$)/.exec(relativePath);
    if (tabMatch) {
      rawMachineId = tabMatch[1];
      rawSessionId = tabMatch[2];
    }
  }

  if (!rawMachineId || !rawSessionId) {
    return null;
  }

  const machineId = safeDecodeSegment(rawMachineId);
  const sessionId = safeDecodeSegment(rawSessionId);
  if (!machineId || !sessionId) {
    return null;
  }

  const rawView = candidate.searchParams.get("view");
  const view = rawView === "chat" || rawView === "term" ? rawView : undefined;

  return view ? { machineId, sessionId, view } : { machineId, sessionId };
}
