import { z } from "zod";
import {
  getDesktopHost,
  type DesktopPersonaHealthCheckResult,
  type DesktopPersonaOpenSessionEvent,
} from "@/desktop/host";

export interface PersonaEmbedSettings {
  /** 是否启用单窗口 Persona 内嵌入口 */
  enabled: boolean;
  /** Persona Hub 基地址（如 http://10.37.217.3:18660 或 http://127.0.0.1:18660） */
  hubUrl: string;
  /** Persona machine_id -> Paseo serverId 显式映射表 */
  machineServerMap: Record<string, string>;
  /** 是否在 Electron webview 内隐藏 Persona 冗余左侧栏 */
  hidePersonaSidebar: boolean;
  /** 启用 Persona 时是否互斥隐藏自研主对话左侧栏入口 */
  hideBuiltInMainChatWhenEnabled: boolean;
  /** 点击 Persona 内 /s/<mid>/<sid> 会话链接时是否直接拦截并跳转到 Paseo */
  interceptSessionClicks: boolean;
}

export const DEFAULT_PERSONA_HUB_URL = "http://10.37.217.3:18660";

export const DEFAULT_PERSONA_EMBED_SETTINGS: PersonaEmbedSettings = {
  enabled: false,
  hubUrl: DEFAULT_PERSONA_HUB_URL,
  machineServerMap: {},
  hidePersonaSidebar: false,
  hideBuiltInMainChatWhenEnabled: true,
  interceptSessionClicks: true,
};

export type PersonaHubUrlValidationResult =
  | {
      ok: true;
      url: string;
      origin: string;
      basePath: string;
      displayHost: string;
    }
  | {
      ok: false;
      error: "empty" | "invalid_protocol" | "credentials_not_allowed" | "invalid_url";
    };

export function normalizePersonaHubUrl(raw: string): PersonaHubUrlValidationResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "empty" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "invalid_protocol" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "credentials_not_allowed" };
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  const basePath = normalizedPath === "" || normalizedPath === "/" ? "" : normalizedPath;
  const url = `${parsed.origin}${basePath}`;
  const displayHost = basePath ? `${parsed.host}${basePath}` : parsed.host;

  return {
    ok: true,
    url,
    origin: parsed.origin,
    basePath,
    displayHost,
  };
}

export function formatPersonaHubDisplayHost(hubUrl: string): string | null {
  const result = normalizePersonaHubUrl(hubUrl);
  return result.ok ? result.displayHost : null;
}

export function sanitizeMachineServerMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    const normalizedValue = typeof value === "string" ? value.trim() : "";
    if (normalizedKey.length > 0 && normalizedValue.length > 0) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

export const PersonaEmbedSettingsSchema = z
  .object({
    enabled: z.boolean().catch(DEFAULT_PERSONA_EMBED_SETTINGS.enabled),
    hubUrl: z
      .string()
      .transform((value) => {
        const trimmed = value.trim();
        if (!trimmed) return "";
        const normalized = normalizePersonaHubUrl(trimmed);
        return normalized.ok ? normalized.url : DEFAULT_PERSONA_EMBED_SETTINGS.hubUrl;
      })
      .catch(DEFAULT_PERSONA_EMBED_SETTINGS.hubUrl),
    machineServerMap: z
      .unknown()
      .transform(sanitizeMachineServerMap)
      .catch(DEFAULT_PERSONA_EMBED_SETTINGS.machineServerMap),
    hidePersonaSidebar: z.boolean().catch(DEFAULT_PERSONA_EMBED_SETTINGS.hidePersonaSidebar),
    hideBuiltInMainChatWhenEnabled: z
      .boolean()
      .catch(DEFAULT_PERSONA_EMBED_SETTINGS.hideBuiltInMainChatWhenEnabled),
    interceptSessionClicks: z
      .boolean()
      .catch(DEFAULT_PERSONA_EMBED_SETTINGS.interceptSessionClicks),
  })
  .catch(DEFAULT_PERSONA_EMBED_SETTINGS);

export function normalizePersonaEmbedSettings(value: unknown): PersonaEmbedSettings {
  return PersonaEmbedSettingsSchema.parse(value);
}

export type PersonaHealthCheckFailureCode =
  | "invalid_url"
  | "not_configured"
  | "unauthorized_caller"
  | "redirect_blocked"
  | "cors_unreadable"
  | "http_error"
  | "invalid_payload"
  | "timeout"
  | "network_error";

export interface PersonaHealthCheckSuccess {
  ok: true;
  hubName: string;
  version: string;
  latencyMs: number;
}

export interface PersonaHealthCheckFailure {
  ok: false;
  error: string;
  code?: PersonaHealthCheckFailureCode;
}

export type PersonaHealthCheckResult = PersonaHealthCheckSuccess | PersonaHealthCheckFailure;

function readTrimmedString(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return fallback;
}

function parsePersonaHealthPayload(
  data: unknown,
  fallbackHost: string,
  startedAt: number,
): PersonaHealthCheckResult {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  if (record?.ok !== true) {
    return { ok: false, code: "invalid_payload", error: "Unexpected health payload" };
  }
  return {
    ok: true,
    hubName: readTrimmedString(record.hub_name, fallbackHost),
    version: readTrimmedString(record.version, "unknown"),
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

function normalizeDesktopHealthResult(
  raw: DesktopPersonaHealthCheckResult | null | undefined,
): PersonaHealthCheckResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, code: "network_error", error: "Health check returned empty result" };
  }
  if (raw.ok === true) {
    return {
      ok: true,
      hubName: readTrimmedString(raw.hubName, "Persona Hub"),
      version: readTrimmedString(raw.version, "unknown"),
      latencyMs:
        typeof raw.latencyMs === "number" && Number.isFinite(raw.latencyMs)
          ? Math.max(0, raw.latencyMs)
          : 0,
    };
  }
  return {
    ok: false,
    code: raw.code ?? "network_error",
    error: readTrimmedString(raw.error, "Health check failed"),
  };
}

function readCurrentPageOrigin(override?: string | null): string | null {
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim();
  }
  if (
    typeof window !== "undefined" &&
    window.location?.origin &&
    window.location.origin !== "null"
  ) {
    return window.location.origin;
  }
  return null;
}

async function runDesktopHealthProbe(
  desktopCheckHealth: () => Promise<DesktopPersonaHealthCheckResult>,
): Promise<PersonaHealthCheckResult> {
  try {
    const result = await desktopCheckHealth();
    return normalizeDesktopHealthResult(result);
  } catch (error) {
    return {
      ok: false,
      code: "network_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function detectBrowserCorsUnreadable(input: {
  error: unknown;
  fetchFn: typeof fetch;
  healthUrl: string;
  targetOrigin: string;
  pageOriginOverride?: string | null;
  signal?: AbortSignal;
}): Promise<boolean> {
  const pageOrigin = readCurrentPageOrigin(input.pageOriginOverride);
  if (
    !(input.error instanceof TypeError) ||
    pageOrigin === null ||
    pageOrigin === input.targetOrigin
  ) {
    return false;
  }
  try {
    const opaqueResponse = await input.fetchFn(input.healthUrl, {
      method: "GET",
      credentials: "omit",
      mode: "no-cors",
      signal: input.signal,
    });
    return opaqueResponse.type === "opaque" || opaqueResponse.ok;
  } catch {
    return false;
  }
}

async function runWebHealthProbe(input: {
  fetchFn: typeof fetch;
  healthUrl: string;
  targetOrigin: string;
  displayHost: string;
  timeoutMs: number;
  pageOriginOverride?: string | null;
}): Promise<PersonaHealthCheckResult> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), input.timeoutMs) : null;
  const startedAt = Date.now();

  try {
    const response = await input.fetchFn(input.healthUrl, {
      method: "GET",
      // Health check must never attach cookies or tokens.
      credentials: "omit",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: controller?.signal,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      return {
        ok: false,
        code: "redirect_blocked",
        error: "Health check redirect blocked",
      };
    }
    if (!response.ok) {
      return { ok: false, code: "http_error", error: `HTTP ${response.status}` };
    }
    const data: unknown = await response.json();
    return parsePersonaHealthPayload(data, input.displayHost, startedAt);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, code: "timeout", error: "Request timed out" };
    }
    const corsUnreadable = await detectBrowserCorsUnreadable({
      error,
      fetchFn: input.fetchFn,
      healthUrl: input.healthUrl,
      targetOrigin: input.targetOrigin,
      pageOriginOverride: input.pageOriginOverride,
      signal: controller?.signal,
    });
    if (corsUnreadable) {
      return {
        ok: false,
        code: "cors_unreadable",
        error: "Browser cross-origin policy blocked reading health response",
      };
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

export async function testPersonaHubHealth(
  rawHubUrl: string,
  options: {
    fetchFn?: typeof fetch;
    electronCheckHealth?: () => Promise<DesktopPersonaHealthCheckResult>;
    timeoutMs?: number;
    pageOriginOverride?: string | null;
  } = {},
): Promise<PersonaHealthCheckResult> {
  const normalized = normalizePersonaHubUrl(rawHubUrl);
  if (!normalized.ok) {
    return { ok: false, code: "invalid_url", error: normalized.error };
  }

  // In Electron Desktop, delegate to the main-process credential-less probe on the registered Hub.
  const desktopCheckHealth =
    options.electronCheckHealth ??
    (options.fetchFn ? undefined : getDesktopHost()?.persona?.checkHealth);
  if (typeof desktopCheckHealth === "function") {
    return runDesktopHealthProbe(desktopCheckHealth);
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, code: "network_error", error: "fetch unavailable" };
  }

  return runWebHealthProbe({
    fetchFn,
    healthUrl: `${normalized.url}/api/v1/health`,
    targetOrigin: normalized.origin,
    displayHost: normalized.displayHost,
    timeoutMs: options.timeoutMs ?? 5_000,
    pageOriginOverride: options.pageOriginOverride,
  });
}

export interface ParsedPersonaEmbedSessionRoute {
  machineId: string;
  sessionId: string;
  view?: "chat" | "term";
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

export function parsePersonaEmbedSessionRoute(
  urlString: string,
  configuredHubUrl: string,
): ParsedPersonaEmbedSessionRoute | null {
  const hub = normalizePersonaHubUrl(configuredHubUrl);
  if (!hub.ok || !urlString) {
    return null;
  }

  let candidate: URL;
  try {
    candidate = new URL(urlString);
  } catch {
    return null;
  }

  if (candidate.origin !== hub.origin) {
    return null;
  }

  let relativePath = candidate.pathname;
  if (hub.basePath) {
    if (relativePath === hub.basePath) {
      relativePath = "/";
    } else if (relativePath.startsWith(`${hub.basePath}/`)) {
      relativePath = relativePath.slice(hub.basePath.length);
    } else {
      return null;
    }
  }

  let rawMid: string | undefined;
  let rawSid: string | undefined;
  const sessionMatch = /^\/s\/([^/]+)\/([^/]+)(?:\/|$)/.exec(relativePath);
  if (sessionMatch) {
    rawMid = sessionMatch[1];
    rawSid = sessionMatch[2];
  } else {
    const tabMatch = /^\/t\/([^/]+)\/[^/]+\/[^/]+\/([^/]+)(?:\/|$)/.exec(relativePath);
    if (tabMatch) {
      rawMid = tabMatch[1];
      rawSid = tabMatch[2];
    }
  }

  if (!rawMid || !rawSid) {
    return null;
  }

  const machineId = safeDecodeSegment(rawMid);
  const sessionId = safeDecodeSegment(rawSid);
  if (!machineId || !sessionId) {
    return null;
  }

  const rawView = candidate.searchParams.get("view");
  const view = rawView === "chat" || rawView === "term" ? rawView : undefined;
  return view ? { machineId, sessionId, view } : { machineId, sessionId };
}

export function isMixedContentIframeBlocked(
  pageProtocol: string | undefined,
  hubUrl: string,
): boolean {
  if (pageProtocol !== "https:") {
    return false;
  }
  const normalized = normalizePersonaHubUrl(hubUrl);
  return normalized.ok && normalized.url.startsWith("http://");
}

const VALID_OPEN_SESSION_SOURCES = new Set<DesktopPersonaOpenSessionEvent["source"]>([
  "window-open",
  "link-click",
  "header-button",
  "changes-panel-button",
]);

function containsDisallowedLineOrNullChar(value: string): boolean {
  return value.includes("\r") || value.includes("\n") || value.includes("\0");
}

function isSafeIdentifierString(value: unknown, maxLength = 256): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return false;
  }
  return (
    !trimmed.includes("/") && !trimmed.includes("\\") && !containsDisallowedLineOrNullChar(trimmed)
  );
}

function isSafeCwdHintString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 4096 && !containsDisallowedLineOrNullChar(value);
}

function isSameOriginHttpUrl(urlString: string, authorizedOrigin: string): boolean {
  try {
    const parsed = new URL(urlString);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      parsed.origin === authorizedOrigin
    );
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateGuestFrameContext(options: {
  authorizedHubUrl: string;
  currentGuestUrl?: string | null;
  frameUrl?: unknown;
  guestWebContentsId?: unknown;
  expectedGuestWebContentsId?: number | null;
}): { origin: string; frameUrl: string; guestWebContentsId: number } | null {
  const hub = normalizePersonaHubUrl(options.authorizedHubUrl);
  if (!hub.ok) {
    return null;
  }

  // Require real main-process verified guest WebContents identity (fail closed when missing).
  if (!isPositiveInteger(options.guestWebContentsId)) {
    return null;
  }
  if (
    options.expectedGuestWebContentsId !== undefined &&
    options.expectedGuestWebContentsId !== null &&
    (!isPositiveInteger(options.expectedGuestWebContentsId) ||
      options.guestWebContentsId !== options.expectedGuestWebContentsId)
  ) {
    return null;
  }

  // Require real main-process verified same-origin frame URL (fail closed when missing or off-origin).
  if (typeof options.frameUrl !== "string" || !isSameOriginHttpUrl(options.frameUrl, hub.origin)) {
    return null;
  }

  if (options.currentGuestUrl !== undefined) {
    if (
      typeof options.currentGuestUrl !== "string" ||
      !isSameOriginHttpUrl(options.currentGuestUrl, hub.origin)
    ) {
      return null;
    }
  }

  return {
    origin: hub.origin,
    frameUrl: options.frameUrl,
    guestWebContentsId: options.guestWebContentsId,
  };
}

function parseOptionalWorkspaceIdHint(
  value: unknown,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value };
  }
  if (isSafeIdentifierString(value, 128)) {
    return { ok: true, value: value.trim() };
  }
  return { ok: false };
}

function parseOptionalCwdHint(
  value: unknown,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value };
  }
  if (isSafeCwdHintString(value)) {
    return { ok: true, value: value.trim() };
  }
  return { ok: false };
}

function parseOptionalRawHref(
  value: unknown,
  origin: string,
): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value === "string" && isSameOriginHttpUrl(value, origin)) {
    return { ok: true, value };
  }
  return { ok: false };
}

function parseOptionalSessionView(
  value: unknown,
): { ok: true; value: "chat" | "term" | undefined } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === "chat" || value === "term") {
    return { ok: true, value };
  }
  return { ok: false };
}

function parseOptionalSessionPanel(
  value: unknown,
): { ok: true; value: "diff" | undefined } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (value === "diff") {
    return { ok: true, value: "diff" };
  }
  return { ok: false };
}

/**
 * Strictly validates an open-session event forwarded by the Electron main process after real
 * `senderFrame === webContents.mainFrame` + authorized Hub origin verification.
 * Fails closed when guest WebContents identity, frameUrl, origin, or field types are missing/invalid.
 */
export function validatePersonaGuestOpenSessionPayload(
  raw: unknown,
  options: {
    authorizedHubUrl: string;
    currentGuestUrl?: string | null;
    expectedGuestWebContentsId?: number | null;
  },
): DesktopPersonaOpenSessionEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const frameContext = validateGuestFrameContext({
    authorizedHubUrl: options.authorizedHubUrl,
    currentGuestUrl: options.currentGuestUrl,
    frameUrl: record.frameUrl,
    guestWebContentsId: record.guestWebContentsId,
    expectedGuestWebContentsId: options.expectedGuestWebContentsId,
  });
  if (!frameContext) {
    return null;
  }
  if (!isSafeIdentifierString(record.machineId) || !isSafeIdentifierString(record.sessionId)) {
    return null;
  }
  if (
    typeof record.source !== "string" ||
    !VALID_OPEN_SESSION_SOURCES.has(record.source as DesktopPersonaOpenSessionEvent["source"])
  ) {
    return null;
  }

  const view = parseOptionalSessionView(record.view);
  const panel = parseOptionalSessionPanel(record.panel);
  const rawHref = parseOptionalRawHref(record.rawHref, frameContext.origin);
  const workspaceIdHint = parseOptionalWorkspaceIdHint(record.workspaceIdHint);
  const cwdHint = parseOptionalCwdHint(record.cwdHint);
  if (!view.ok || !panel.ok || !rawHref.ok || !workspaceIdHint.ok || !cwdHint.ok) {
    return null;
  }

  return {
    machineId: record.machineId.trim(),
    sessionId: record.sessionId.trim(),
    source: record.source as DesktopPersonaOpenSessionEvent["source"],
    ...(view.value ? { view: view.value } : {}),
    ...(panel.value ? { panel: panel.value } : {}),
    ...(rawHref.value ? { rawHref: rawHref.value } : {}),
    ...(workspaceIdHint.value !== undefined ? { workspaceIdHint: workspaceIdHint.value } : {}),
    ...(cwdHint.value !== undefined ? { cwdHint: cwdHint.value } : {}),
  };
}

export interface PersonaSessionMetadataHints {
  workspaceIdHint: string | null;
  cwdHint: string | null;
}

export function validatePersonaSessionMetadataResult(
  raw: unknown,
  options: {
    authorizedHubUrl: string;
    currentGuestUrl?: string | null;
    expectedGuestWebContentsId?: number | null;
    expectedRequestId: string;
    expectedMachineId: string;
    expectedSessionId: string;
  },
): PersonaSessionMetadataHints | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const frameContext = validateGuestFrameContext({
    authorizedHubUrl: options.authorizedHubUrl,
    currentGuestUrl: options.currentGuestUrl,
    frameUrl: record.frameUrl,
    guestWebContentsId: record.guestWebContentsId,
    expectedGuestWebContentsId: options.expectedGuestWebContentsId,
  });
  if (!frameContext) {
    return null;
  }
  if (
    record.requestId !== options.expectedRequestId ||
    record.machineId !== options.expectedMachineId ||
    record.sessionId !== options.expectedSessionId
  ) {
    return null;
  }
  const workspaceIdHint = parseOptionalWorkspaceIdHint(record.workspaceIdHint);
  const cwdHint = parseOptionalCwdHint(record.cwdHint);
  return {
    workspaceIdHint: workspaceIdHint.ok ? (workspaceIdHint.value ?? null) : null,
    cwdHint: cwdHint.ok ? (cwdHint.value ?? null) : null,
  };
}

export interface ValidatedPersonaGuestReadyPayload {
  guestWebContentsId: number;
  frameUrl: string;
}

export function validatePersonaGuestReadyPayload(
  raw: unknown,
  options: {
    authorizedHubUrl: string;
    currentGuestUrl?: string | null;
    expectedGuestWebContentsId?: number | null;
  },
): ValidatedPersonaGuestReadyPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const frameContext = validateGuestFrameContext({
    authorizedHubUrl: options.authorizedHubUrl,
    currentGuestUrl: options.currentGuestUrl,
    frameUrl: record.frameUrl,
    guestWebContentsId: record.guestWebContentsId,
    expectedGuestWebContentsId: options.expectedGuestWebContentsId,
  });
  if (!frameContext) {
    return null;
  }
  return {
    guestWebContentsId: frameContext.guestWebContentsId,
    frameUrl: frameContext.frameUrl,
  };
}
