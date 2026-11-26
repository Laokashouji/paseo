import { z } from "zod";

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

export interface PersonaHealthCheckSuccess {
  ok: true;
  hubName: string;
  version: string;
  latencyMs: number;
}

export interface PersonaHealthCheckFailure {
  ok: false;
  error: string;
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
    return { ok: false, error: "Unexpected health payload" };
  }
  return {
    ok: true,
    hubName: readTrimmedString(record.hub_name, fallbackHost),
    version: readTrimmedString(record.version, "unknown"),
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

export async function testPersonaHubHealth(
  rawHubUrl: string,
  options: {
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<PersonaHealthCheckResult> {
  const normalized = normalizePersonaHubUrl(rawHubUrl);
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, error: "fetch unavailable" };
  }

  const timeoutMs = options.timeoutMs ?? 5_000;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const startedAt = Date.now();

  try {
    const response = await fetchFn(`${normalized.url}/api/v1/health`, {
      method: "GET",
      // Health check must never attach cookies or tokens.
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal: controller?.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data: unknown = await response.json();
    return parsePersonaHealthPayload(data, normalized.displayHost, startedAt);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "Request timed out" };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
