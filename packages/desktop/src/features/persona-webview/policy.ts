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
export const MAX_PERSONA_HUB_URLS = 32;

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

/**
 * Normalizes a host window's Persona Hub URL allowlist.
 * Returns `[]` for null/undefined/empty arrays, deduplicates normalized URLs,
 * and returns `null` (fail-closed) if any entry is non-string, invalid, or exceeds the cap.
 */
export function normalizePersonaHubUrlList(values: unknown): string[] | null {
  if (values === null || values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || values.length > MAX_PERSONA_HUB_URLS) {
    return null;
  }
  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    if (typeof item !== "string") {
      return null;
    }
    const normalized = normalizePersonaHubUrl(item);
    if (!normalized) {
      return null;
    }
    if (!seen.has(normalized.url)) {
      seen.add(normalized.url);
      uniqueUrls.push(normalized.url);
    }
  }
  return uniqueUrls;
}

function collectNormalizedHubs(
  configuredHubUrls: string | readonly string[] | null | undefined,
): NormalizedPersonaHubUrl[] {
  if (typeof configuredHubUrls === "string") {
    const normalized = normalizePersonaHubUrl(configuredHubUrls);
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(configuredHubUrls)) {
    return [];
  }
  const normalizedHubs: NormalizedPersonaHubUrl[] = [];
  const seen = new Set<string>();
  for (const rawUrl of configuredHubUrls) {
    const normalized = normalizePersonaHubUrl(rawUrl);
    if (normalized && !seen.has(normalized.url)) {
      seen.add(normalized.url);
      normalizedHubs.push(normalized);
    }
  }
  return normalizedHubs;
}

function matchesHubBasePath(candidatePathname: string, basePath: string): boolean {
  if (!basePath) {
    return true;
  }
  return candidatePathname === basePath || candidatePathname.startsWith(`${basePath}/`);
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
 * Matches a `<webview>` attachment request against a single Hub URL or multi-Hub allowlist.
 * Returns the specific registered Hub URL that authorizes this guest (longest basePath match on
 * the same HTTP(S) origin), or `null` when unauthorized.
 */
export function matchPersonaWebviewAttachHubUrl(
  params: PersonaWebviewAttachParams,
  configuredHubUrls?: string | readonly string[] | null,
): string | null {
  if (params.partition !== PERSONA_WEBVIEW_PARTITION) {
    return null;
  }
  const hubs = collectNormalizedHubs(configuredHubUrls);
  if (hubs.length === 0) {
    return null;
  }
  const candidate = parseUrl(params.src);
  if (!candidate || !PERSONA_ALLOWED_PROTOCOLS.has(candidate.protocol)) {
    return null;
  }
  if (candidate.username || candidate.password) {
    return null;
  }

  const sameOriginHubs = hubs.filter((hub) => hub.origin === candidate.origin);
  if (sameOriginHubs.length === 0) {
    return null;
  }

  // Prefer the longest matching reverse-proxy basePath when multiple Hubs share an origin.
  const basePathMatches = sameOriginHubs
    .filter((hub) => matchesHubBasePath(candidate.pathname, hub.basePath))
    .sort((left, right) => right.basePath.length - left.basePath.length);
  if (basePathMatches.length > 0) {
    return basePathMatches[0].url;
  }

  // If a single Hub on this origin has a custom basePath and the initial src targets a root
  // path on that same origin (e.g. login redirect), allow only when no other Hub conflicts.
  return sameOriginHubs.length === 1 ? sameOriginHubs[0].url : null;
}

/**
 * Validates `<webview>` attachment for the isolated `persist:persona` partition.
 * Requires a pre-registered valid HTTP(S) Hub URL (or allowlist) and a same-origin HTTP(S) `src`.
 * Refuses attachment before a trusted host has registered an enabled Hub.
 */
export function isPersonaWebviewAttach(
  params: PersonaWebviewAttachParams,
  configuredHubUrls?: string | readonly string[] | null,
): boolean {
  return matchPersonaWebviewAttachHubUrl(params, configuredHubUrls) !== null;
}

/**
 * Verifies that a guest's pinned Hub URL is still authorized by the host window's current Hub
 * allowlist, returning ONLY that guest's single pinned Hub URL (never another Hub's URL).
 */
export function resolveAuthorizedPinnedPersonaHubUrl(
  pinnedHubUrl: string | undefined | null,
  registeredHubUrls: string | readonly string[] | null | undefined,
): string | null {
  const pinned = normalizePersonaHubUrl(pinnedHubUrl);
  if (!pinned) {
    return null;
  }
  const registered = collectNormalizedHubs(registeredHubUrls);
  const exactMatch = registered.find((hub) => hub.url === pinned.url);
  if (exactMatch) {
    return exactMatch.url;
  }
  const sameOriginMatch = registered.find(
    (hub) => hub.origin === pinned.origin && hub.basePath === pinned.basePath,
  );
  return sameOriginMatch ? sameOriginMatch.url : null;
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
