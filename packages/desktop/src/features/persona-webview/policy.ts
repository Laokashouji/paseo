export const PERSONA_WEBVIEW_PARTITION = "persist:persona";
export const PERSONA_WEBVIEW_PARTITION_PREFIX = "persist:persona-";
export const PERSONA_DISK_PARTITION_DIR_NAME = "persona";
export const PERSONA_DISK_PARTITION_DIR_PREFIX = "persona-";
export const DEFAULT_PERSONA_HUB_ID = "hub-default";
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

export interface PersonaHubPartitionEntry {
  partition: string;
  hubUrl: string;
}

export interface NormalizedPersonaHubUrl {
  url: string;
  origin: string;
  basePath: string;
  displayHost: string;
}

const PERSONA_ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const PERSONA_HEALTH_ENDPOINT_SUFFIX = "/api/v1/health";
const PERSONA_HUB_PARTITION_SUFFIX_LOWER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PERSONA_HUB_PARTITION_SUFFIX_ANY_CASE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const MAX_PERSONA_HUB_URLS = 32;

/**
 * Validates and folds a Persona persistent partition name to canonical lowercase.
 * Rejects non-string values, uppercase `persist:` prefixes, and unsafe suffixes.
 */
export function normalizePersonaWebviewPartition(partition: unknown): string | null {
  if (typeof partition !== "string") {
    return null;
  }
  if (partition === PERSONA_WEBVIEW_PARTITION) {
    return PERSONA_WEBVIEW_PARTITION;
  }
  if (!partition.startsWith(PERSONA_WEBVIEW_PARTITION_PREFIX)) {
    return null;
  }
  const suffix = partition.slice(PERSONA_WEBVIEW_PARTITION_PREFIX.length);
  if (!PERSONA_HUB_PARTITION_SUFFIX_ANY_CASE_PATTERN.test(suffix)) {
    return null;
  }
  return `${PERSONA_WEBVIEW_PARTITION_PREFIX}${suffix.toLowerCase()}`;
}

/**
 * Validates that a Chromium partition name belongs strictly to Persona AND is already canonical
 * lowercase so case-insensitive filesystems (macOS/Windows) and Electron's case-sensitive Session
 * cache can never diverge or collide on the same on-disk partition directory:
 * - Legacy/default Hub partition: `persist:persona`
 * - Additional per-Hub isolated partition: `persist:persona-<lowercase-id>`
 */
export function isPersonaWebviewPartition(partition: unknown): partition is string {
  if (typeof partition !== "string") {
    return false;
  }
  if (partition === PERSONA_WEBVIEW_PARTITION) {
    return true;
  }
  if (!partition.startsWith(PERSONA_WEBVIEW_PARTITION_PREFIX)) {
    return false;
  }
  const suffix = partition.slice(PERSONA_WEBVIEW_PARTITION_PREFIX.length);
  return PERSONA_HUB_PARTITION_SUFFIX_LOWER_PATTERN.test(suffix);
}

/**
 * Validates an on-disk directory name under Electron's `<userData>/Partitions/` directory.
 * Accepts exact `persona` and safe `persona-<ascii>` names (including historical mixed-case
 * directories left on case-sensitive filesystems) while rejecting unrelated partitions such as
 * `paseo-browser`, path traversal segments, or empty suffixes.
 */
export function isPersonaDiskPartitionDirName(dirName: unknown): dirName is string {
  if (typeof dirName !== "string") {
    return false;
  }
  if (dirName === PERSONA_DISK_PARTITION_DIR_NAME) {
    return true;
  }
  if (!dirName.startsWith(PERSONA_DISK_PARTITION_DIR_PREFIX)) {
    return false;
  }
  const suffix = dirName.slice(PERSONA_DISK_PARTITION_DIR_PREFIX.length);
  return PERSONA_HUB_PARTITION_SUFFIX_ANY_CASE_PATTERN.test(suffix);
}

/**
 * Validates a partition target eligible for full Persona session clearing (canonical lowercase
 * partitions plus any safe historical mixed-case `persist:persona-*` directory discovered on disk).
 */
export function isPersonaClearablePartition(partition: unknown): partition is string {
  return normalizePersonaWebviewPartition(partition) !== null;
}

/**
 * Maps a Persona Hub ID to its canonical lowercase persistent Electron session partition:
 * - `hub-default` (case-insensitively, migrated from 0.17.534) stays on `persist:persona`.
 * - Any other valid Hub ID is lowercased to an isolated `persist:persona-<id>` partition.
 */
export function resolvePersonaHubPartition(hubId: string | undefined | null): string | null {
  if (typeof hubId !== "string") {
    return null;
  }
  const normalized = hubId.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === DEFAULT_PERSONA_HUB_ID) {
    return PERSONA_WEBVIEW_PARTITION;
  }
  if (!PERSONA_HUB_PARTITION_SUFFIX_LOWER_PATTERN.test(normalized)) {
    return null;
  }
  return `${PERSONA_WEBVIEW_PARTITION_PREFIX}${normalized}`;
}

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

/**
 * Normalizes a host window's per-partition Persona Hub allowlist.
 * Returns `[]` for null/undefined/empty arrays, deduplicates identical lowercase
 * `(partition, hubUrl)` pairs, and returns `null` (fail-closed) if any entry has an invalid or
 * non-lowercase partition, invalid Hub URL, exceeds the cap, or collides after lowercase folding.
 */
export function normalizePersonaHubEntries(values: unknown): PersonaHubPartitionEntry[] | null {
  if (values === null || values === undefined) {
    return [];
  }
  if (!Array.isArray(values) || values.length > MAX_PERSONA_HUB_URLS) {
    return null;
  }
  const entries: PersonaHubPartitionEntry[] = [];
  const urlByCanonicalPartition = new Map<string, string>();
  for (const item of values) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const record = item as { partition?: unknown; hubUrl?: unknown };
    const canonicalPartition = normalizePersonaWebviewPartition(record.partition);
    if (!canonicalPartition || canonicalPartition !== record.partition) {
      return null;
    }
    if (typeof record.hubUrl !== "string") {
      return null;
    }
    const normalized = normalizePersonaHubUrl(record.hubUrl);
    if (!normalized) {
      return null;
    }
    const existingUrl = urlByCanonicalPartition.get(canonicalPartition);
    if (existingUrl !== undefined) {
      if (existingUrl !== normalized.url) {
        return null;
      }
      continue;
    }
    urlByCanonicalPartition.set(canonicalPartition, normalized.url);
    entries.push({ partition: canonicalPartition, hubUrl: normalized.url });
  }
  return entries;
}

function collectLegacySingleHubEntries(
  rawUrls: readonly unknown[],
): Array<{ partition: string; hub: NormalizedPersonaHubUrl }> {
  const uniqueUrls: NormalizedPersonaHubUrl[] = [];
  const seen = new Set<string>();
  for (const rawUrl of rawUrls) {
    if (typeof rawUrl !== "string") {
      return [];
    }
    const normalized = normalizePersonaHubUrl(rawUrl);
    if (!normalized) {
      return [];
    }
    if (!seen.has(normalized.url)) {
      seen.add(normalized.url);
      uniqueUrls.push(normalized);
    }
  }
  return uniqueUrls.length === 1
    ? [{ partition: PERSONA_WEBVIEW_PARTITION, hub: uniqueUrls[0] }]
    : [];
}

function collectNormalizedHubEntries(
  configuredHubs:
    | string
    | readonly string[]
    | readonly PersonaHubPartitionEntry[]
    | null
    | undefined,
): Array<{ partition: string; hub: NormalizedPersonaHubUrl }> {
  if (typeof configuredHubs === "string") {
    const normalized = normalizePersonaHubUrl(configuredHubs);
    return normalized ? [{ partition: PERSONA_WEBVIEW_PARTITION, hub: normalized }] : [];
  }
  if (!Array.isArray(configuredHubs) || configuredHubs.length === 0) {
    return [];
  }
  if (typeof configuredHubs[0] === "string") {
    // Legacy unpartitioned string list: only a single unique URL can safely bind to persist:persona.
    return collectLegacySingleHubEntries(configuredHubs);
  }

  const normalizedEntries: Array<{ partition: string; hub: NormalizedPersonaHubUrl }> = [];
  const urlByCanonicalPartition = new Map<string, string>();
  for (const item of configuredHubs) {
    if (!item || typeof item !== "object" || !("partition" in item) || !("hubUrl" in item)) {
      return [];
    }
    const canonicalPartition = normalizePersonaWebviewPartition(item.partition);
    if (!canonicalPartition || canonicalPartition !== item.partition) {
      return [];
    }
    const normalized = normalizePersonaHubUrl(item.hubUrl);
    if (!normalized) {
      return [];
    }
    const existingUrl = urlByCanonicalPartition.get(canonicalPartition);
    if (existingUrl !== undefined) {
      if (existingUrl !== normalized.url) {
        return [];
      }
      continue;
    }
    urlByCanonicalPartition.set(canonicalPartition, normalized.url);
    normalizedEntries.push({ partition: canonicalPartition, hub: normalized });
  }
  return normalizedEntries;
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
 * Matches a `<webview>` attachment request strictly by its isolated Persona partition
 * (`persist:persona` or `persist:persona-<id>`) against the host window's partition-bound Hub
 * allowlist. Returns the single Hub URL bound to that partition when `src` matches its origin
 * and reverse-proxy basePath, or `null` (fail-closed) when unauthorized.
 */
export function matchPersonaWebviewAttachHubUrl(
  params: PersonaWebviewAttachParams,
  configuredHubs?: string | readonly string[] | readonly PersonaHubPartitionEntry[] | null,
): string | null {
  if (!isPersonaWebviewPartition(params.partition)) {
    return null;
  }
  const entries = collectNormalizedHubEntries(configuredHubs);
  if (entries.length === 0) {
    return null;
  }
  const entry = entries.find((item) => item.partition === params.partition);
  if (!entry) {
    return null;
  }
  const candidate = parseUrl(params.src);
  if (!candidate || !PERSONA_ALLOWED_PROTOCOLS.has(candidate.protocol)) {
    return null;
  }
  if (candidate.username || candidate.password) {
    return null;
  }
  if (candidate.origin !== entry.hub.origin) {
    return null;
  }
  if (!matchesHubBasePath(candidate.pathname, entry.hub.basePath)) {
    return null;
  }
  return entry.hub.url;
}

/**
 * Validates `<webview>` attachment for an isolated Persona partition (`persist:persona` or
 * `persist:persona-<id>`). Requires a pre-registered valid HTTP(S) Hub bound to that exact
 * partition and a matching same-origin HTTP(S) `src`. Refuses attachment fail-closed otherwise.
 */
export function isPersonaWebviewAttach(
  params: PersonaWebviewAttachParams,
  configuredHubs?: string | readonly string[] | readonly PersonaHubPartitionEntry[] | null,
): boolean {
  return matchPersonaWebviewAttachHubUrl(params, configuredHubs) !== null;
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
