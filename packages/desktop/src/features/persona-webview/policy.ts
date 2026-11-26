export const PERSONA_WEBVIEW_PARTITION = "persist:persona";
export const PERSONA_OPEN_SESSION_EVENT_NAME = "persona-open-session";
export const PERSONA_OPEN_SESSION_EVENT = `paseo:event:${PERSONA_OPEN_SESSION_EVENT_NAME}`;

export interface ParsedPersonaSessionPath {
  machineId: string;
  sessionId: string;
  view?: "chat" | "term";
}

export interface PersonaWebviewAttachParams {
  src?: string;
  partition?: string;
}

const PERSONA_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

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
  const hub = parseUrl(configuredHubUrl);
  if (!hub || !PERSONA_ALLOWED_PROTOCOLS.has(hub.protocol)) {
    return false;
  }
  return candidate.origin === hub.origin;
}

/**
 * Validates `<webview>` attachment for the isolated `persist:persona` partition.
 * When `configuredHubUrl` is known, enforces origin allowlisting in addition to protocol checks.
 */
export function isPersonaWebviewAttach(
  params: PersonaWebviewAttachParams,
  configuredHubUrl?: string | null,
): boolean {
  if (params.partition !== PERSONA_WEBVIEW_PARTITION) {
    return false;
  }
  if (!isAllowedPersonaWebviewUrl(params.src)) {
    return false;
  }
  if (configuredHubUrl && configuredHubUrl.trim().length > 0) {
    return isAllowedPersonaTargetOrigin(params.src, configuredHubUrl);
  }
  return true;
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
