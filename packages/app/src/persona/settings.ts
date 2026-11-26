import { z } from "zod";
import {
  getDesktopHost,
  type DesktopPersonaHealthCheckResult,
  type DesktopPersonaOpenSessionEvent,
} from "@/desktop/host";

export interface PersonaHubProfile {
  /** 稳定的 Hub 档案标识 */
  id: string;
  /** 侧栏与分屏顶栏显示的简短名称 */
  name: string;
  /** Persona Hub 基地址（如 http://10.37.217.3:18660 或 http://127.0.0.1:18660） */
  hubUrl: string;
  /** 该 Hub 独立的 Persona machine_id -> Paseo serverId 显式映射表 */
  machineServerMap: Record<string, string>;
}

export interface PersonaEmbedSettings {
  /** 是否启用单窗口 Persona 内嵌入口 */
  enabled: boolean;
  /** 多 Persona Hub 档案列表 */
  hubs: PersonaHubProfile[];
  /** 当前主栏（或单栏）激活的 Hub ID */
  activeHubId: string;
  /** 是否启用同窗口左右双栏分屏 */
  splitEnabled: boolean;
  /** 右侧分屏栏显示的 Hub ID（与 activeHubId 互斥） */
  secondaryHubId: string | null;
  /** 左右分屏比例（左栏宽度占比，范围 0.25..0.75，默认 0.5） */
  splitRatio: number;
  /** 侧栏多 Hub 子列表是否处于展开态 */
  sidebarExpanded: boolean;
  /** 当前激活 Hub 的基地址（由 activeHub 同步派生） */
  hubUrl: string;
  /** 当前激活 Hub 的 machine_id -> serverId 显式映射表（由 activeHub 同步派生） */
  machineServerMap: Record<string, string>;
  /** 是否在 Electron webview 内隐藏 Persona 冗余左侧栏 */
  hidePersonaSidebar: boolean;
  /** 启用 Persona 时是否互斥隐藏自研主对话左侧栏入口 */
  hideBuiltInMainChatWhenEnabled: boolean;
  /** 点击 Persona 内 /s/<mid>/<sid> 会话链接时是否直接拦截并跳转到 Paseo */
  interceptSessionClicks: boolean;
}

export const DEFAULT_PERSONA_HUB_ID = "hub-default";
export const PERSONA_WEBVIEW_PARTITION = "persist:persona";
export const PERSONA_WEBVIEW_PARTITION_PREFIX = "persist:persona-";
export const DEFAULT_PERSONA_HUB_URL = "http://10.37.217.3:18660";
export const DEFAULT_PERSONA_HUB_NAME = "10.37.217.3";
export const MIN_PERSONA_SPLIT_RATIO = 0.25;
export const MAX_PERSONA_SPLIT_RATIO = 0.75;
export const DEFAULT_PERSONA_SPLIT_RATIO = 0.5;
export const MAX_PERSONA_HUBS = 32;
export const MAX_PERSONA_HUB_NAME_LENGTH = 64;
export const MAX_PERSONA_HUB_ID_LENGTH = 64;
const PERSONA_HUB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface PersonaHubPartitionEntry {
  partition: string;
  hubUrl: string;
}

/**
 * Maps a Persona Hub ID to its isolated persistent Electron partition:
 * - `hub-default` (migrated from 0.17.534) stays on `persist:persona` to preserve login state.
 * - Additional Hubs get `persist:persona-<id>` with a strictly validated ASCII slug.
 */
export function resolvePersonaHubPartition(
  hubId: string | undefined | null,
  options?: { basePartition?: string; partitionPrefix?: string },
): string | null {
  if (typeof hubId !== "string") {
    return null;
  }
  const trimmed = hubId.trim();
  if (!trimmed || !PERSONA_HUB_ID_PATTERN.test(trimmed)) {
    return null;
  }
  const basePartition =
    typeof options?.basePartition === "string" && options.basePartition.startsWith("persist:")
      ? options.basePartition
      : PERSONA_WEBVIEW_PARTITION;
  if (trimmed === DEFAULT_PERSONA_HUB_ID) {
    return basePartition;
  }
  const prefix =
    typeof options?.partitionPrefix === "string" && options.partitionPrefix.startsWith("persist:")
      ? options.partitionPrefix
      : PERSONA_WEBVIEW_PARTITION_PREFIX;
  return `${prefix}${trimmed}`;
}

export const DEFAULT_PERSONA_HUB_PROFILE: PersonaHubProfile = {
  id: DEFAULT_PERSONA_HUB_ID,
  name: DEFAULT_PERSONA_HUB_NAME,
  hubUrl: DEFAULT_PERSONA_HUB_URL,
  machineServerMap: {},
};

export const DEFAULT_PERSONA_EMBED_SETTINGS: PersonaEmbedSettings = {
  enabled: false,
  hubs: [DEFAULT_PERSONA_HUB_PROFILE],
  activeHubId: DEFAULT_PERSONA_HUB_ID,
  splitEnabled: false,
  secondaryHubId: null,
  splitRatio: DEFAULT_PERSONA_SPLIT_RATIO,
  sidebarExpanded: false,
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

export function clampPersonaSplitRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PERSONA_SPLIT_RATIO;
  }
  const clamped = Math.min(MAX_PERSONA_SPLIT_RATIO, Math.max(MIN_PERSONA_SPLIT_RATIO, value));
  return Math.round(clamped * 10_000) / 10_000;
}

function stripControlChars(value: string): string {
  let out = "";
  let prevSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isControl = code < 32 || code === 127;
    if (isControl) {
      if (!prevSpace) {
        out += " ";
        prevSpace = true;
      }
    } else {
      out += value[index];
      prevSpace = false;
    }
  }
  return out.trim();
}

export function deriveDefaultPersonaHubName(hubUrl: string): string {
  const normalized = normalizePersonaHubUrl(hubUrl);
  if (!normalized.ok) {
    return "Persona Hub";
  }
  const parsed = new URL(normalized.url);
  const candidate = normalized.basePath
    ? `${parsed.hostname}${normalized.basePath}`
    : parsed.hostname;
  return candidate.slice(0, MAX_PERSONA_HUB_NAME_LENGTH) || "Persona Hub";
}

function sanitizePersonaHubName(rawName: unknown, hubUrl: string): string {
  if (typeof rawName === "string") {
    const cleaned = stripControlChars(rawName).slice(0, MAX_PERSONA_HUB_NAME_LENGTH);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  return deriveDefaultPersonaHubName(hubUrl);
}

function sanitizePersonaHubId(rawId: unknown): string | null {
  if (typeof rawId !== "string") {
    return null;
  }
  const trimmed = rawId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PERSONA_HUB_ID_LENGTH ||
    !PERSONA_HUB_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

export function createPersonaHubId(existingIds: ReadonlySet<string>, nameHint?: string): string {
  const slug = stripControlChars(nameHint ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const base = slug ? `hub-${slug}` : "hub";
  // Reserve DEFAULT_PERSONA_HUB_ID so newly created Hubs never inherit the migrated persist:persona partition.
  const isTaken = (candidate: string): boolean =>
    candidate === DEFAULT_PERSONA_HUB_ID || existingIds.has(candidate);
  if (!isTaken(base)) {
    return base;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!isTaken(candidate)) {
      return candidate;
    }
  }
  return `hub-${Date.now()}`;
}

function allocateUniqueHubId(rawId: unknown, usedIds: Set<string>, index: number): string {
  const sanitized = sanitizePersonaHubId(rawId);
  if (sanitized && !usedIds.has(sanitized)) {
    usedIds.add(sanitized);
    return sanitized;
  }
  const base = sanitized ?? `hub-${index + 1}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const uniqueId = `${base}-${suffix}`;
  usedIds.add(uniqueId);
  return uniqueId;
}

function sanitizeHubProfileList(rawHubs: unknown[]): PersonaHubProfile[] {
  const hubs: PersonaHubProfile[] = [];
  const usedIds = new Set<string>();

  for (let index = 0; index < rawHubs.length && hubs.length < MAX_PERSONA_HUBS; index += 1) {
    const item = rawHubs[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const rawUrl = typeof record.hubUrl === "string" ? record.hubUrl.trim() : "";
    let normalizedUrl = "";
    if (rawUrl.length > 0) {
      const validated = normalizePersonaHubUrl(rawUrl);
      if (!validated.ok) {
        // Strictly reject unsafe protocols or embedded credentials; never persist invalid URLs.
        continue;
      }
      normalizedUrl = validated.url;
    }
    const id = allocateUniqueHubId(record.id, usedIds, hubs.length);
    const name = sanitizePersonaHubName(record.name, normalizedUrl);
    const machineServerMap = sanitizeMachineServerMap(record.machineServerMap);
    hubs.push({
      id,
      name,
      hubUrl: normalizedUrl,
      machineServerMap,
    });
  }

  return hubs;
}

function migrateLegacySingleHub(record: Record<string, unknown>): PersonaHubProfile[] {
  let normalizedUrl = DEFAULT_PERSONA_HUB_URL;
  if (typeof record.hubUrl === "string") {
    const trimmed = record.hubUrl.trim();
    if (!trimmed) {
      normalizedUrl = "";
    } else {
      const validated = normalizePersonaHubUrl(trimmed);
      normalizedUrl = validated.ok ? validated.url : DEFAULT_PERSONA_HUB_URL;
    }
  }
  const machineServerMap = sanitizeMachineServerMap(record.machineServerMap);
  return [
    {
      id: DEFAULT_PERSONA_HUB_ID,
      name: deriveDefaultPersonaHubName(normalizedUrl),
      hubUrl: normalizedUrl,
      machineServerMap,
    },
  ];
}

function readBooleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveNormalizedSplitState(input: {
  hubs: readonly PersonaHubProfile[];
  activeHubId: string;
  requestedSecondaryId: unknown;
  splitRequested: boolean;
}): { splitEnabled: boolean; secondaryHubId: string | null } {
  if (input.hubs.length < 2 || !input.activeHubId) {
    return { splitEnabled: false, secondaryHubId: null };
  }
  const sanitizedSecondary = sanitizePersonaHubId(input.requestedSecondaryId);
  const matchedSecondary =
    sanitizedSecondary && sanitizedSecondary !== input.activeHubId
      ? input.hubs.find((hub) => hub.id === sanitizedSecondary)
      : undefined;
  let secondaryHubId: string | null = matchedSecondary?.id ?? null;
  if (!secondaryHubId && input.splitRequested) {
    secondaryHubId = input.hubs.find((hub) => hub.id !== input.activeHubId)?.id ?? null;
  }
  const splitEnabled =
    input.splitRequested && secondaryHubId !== null && secondaryHubId !== input.activeHubId;
  return { splitEnabled, secondaryHubId };
}

function normalizePersonaEmbedSettingsRecord(value: unknown): PersonaEmbedSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_PERSONA_EMBED_SETTINGS;
  }
  const record = value as Record<string, unknown>;
  const hubs = Array.isArray(record.hubs)
    ? sanitizeHubProfileList(record.hubs)
    : migrateLegacySingleHub(record);

  const requestedActiveId = sanitizePersonaHubId(record.activeHubId);
  const activeHub =
    (requestedActiveId ? hubs.find((hub) => hub.id === requestedActiveId) : undefined) ??
    hubs[0] ??
    null;
  const activeHubId = activeHub?.id ?? "";
  const { splitEnabled, secondaryHubId } = resolveNormalizedSplitState({
    hubs,
    activeHubId,
    requestedSecondaryId: record.secondaryHubId,
    splitRequested: record.splitEnabled === true,
  });

  return {
    enabled: readBooleanOrDefault(record.enabled, DEFAULT_PERSONA_EMBED_SETTINGS.enabled),
    hubs,
    activeHubId,
    splitEnabled,
    secondaryHubId,
    splitRatio: clampPersonaSplitRatio(record.splitRatio),
    sidebarExpanded: readBooleanOrDefault(
      record.sidebarExpanded,
      DEFAULT_PERSONA_EMBED_SETTINGS.sidebarExpanded,
    ),
    hubUrl: activeHub?.hubUrl ?? "",
    machineServerMap: activeHub?.machineServerMap ?? {},
    hidePersonaSidebar: readBooleanOrDefault(
      record.hidePersonaSidebar,
      DEFAULT_PERSONA_EMBED_SETTINGS.hidePersonaSidebar,
    ),
    hideBuiltInMainChatWhenEnabled: readBooleanOrDefault(
      record.hideBuiltInMainChatWhenEnabled,
      DEFAULT_PERSONA_EMBED_SETTINGS.hideBuiltInMainChatWhenEnabled,
    ),
    interceptSessionClicks: readBooleanOrDefault(
      record.interceptSessionClicks,
      DEFAULT_PERSONA_EMBED_SETTINGS.interceptSessionClicks,
    ),
  };
}

export const PersonaEmbedSettingsSchema = z
  .unknown()
  .transform((value) => normalizePersonaEmbedSettingsRecord(value))
  .catch(DEFAULT_PERSONA_EMBED_SETTINGS);

export function normalizePersonaEmbedSettings(value: unknown): PersonaEmbedSettings {
  return normalizePersonaEmbedSettingsRecord(value);
}

export function getPersonaHubById(
  settings: PersonaEmbedSettings,
  hubId: string | null | undefined,
): PersonaHubProfile | null {
  if (!hubId) {
    return null;
  }
  return settings.hubs.find((hub) => hub.id === hubId) ?? null;
}

export function getActivePersonaHub(settings: PersonaEmbedSettings): PersonaHubProfile | null {
  return getPersonaHubById(settings, settings.activeHubId) ?? settings.hubs[0] ?? null;
}

export function getSecondaryPersonaHub(settings: PersonaEmbedSettings): PersonaHubProfile | null {
  const active = getActivePersonaHub(settings);
  if (!active || settings.hubs.length < 2) {
    return null;
  }
  const explicit =
    settings.secondaryHubId && settings.secondaryHubId !== active.id
      ? getPersonaHubById(settings, settings.secondaryHubId)
      : null;
  if (explicit) {
    return explicit;
  }
  return settings.hubs.find((hub) => hub.id !== active.id) ?? null;
}

export function collectValidPersonaHubUrls(settings: PersonaEmbedSettings): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const hub of settings.hubs) {
    const normalized = normalizePersonaHubUrl(hub.hubUrl);
    if (normalized.ok && !seen.has(normalized.url)) {
      seen.add(normalized.url);
      urls.push(normalized.url);
    }
  }
  return urls;
}

export function collectValidPersonaHubPartitionEntries(
  settings: PersonaEmbedSettings,
  options?: { basePartition?: string; partitionPrefix?: string },
): PersonaHubPartitionEntry[] {
  const entries: PersonaHubPartitionEntry[] = [];
  const seenPartitions = new Set<string>();
  for (const hub of settings.hubs) {
    const normalized = normalizePersonaHubUrl(hub.hubUrl);
    const partition = resolvePersonaHubPartition(hub.id, options);
    if (normalized.ok && partition && !seenPartitions.has(partition)) {
      seenPartitions.add(partition);
      entries.push({ partition, hubUrl: normalized.url });
    }
  }
  return entries;
}

export function selectActivePersonaHub(
  settings: PersonaEmbedSettings,
  targetHubId: string,
): PersonaEmbedSettings {
  const target = getPersonaHubById(settings, targetHubId);
  if (!target) {
    return settings;
  }
  if (target.id === settings.activeHubId) {
    return settings;
  }
  // When selecting the Hub currently pinned in the right split pane, swap panes to preserve split.
  const nextSecondaryHubId =
    settings.splitEnabled && settings.secondaryHubId === target.id
      ? settings.activeHubId
      : settings.secondaryHubId;
  return normalizePersonaEmbedSettings({
    ...settings,
    activeHubId: target.id,
    secondaryHubId: nextSecondaryHubId,
  });
}

export function selectSecondaryPersonaHub(
  settings: PersonaEmbedSettings,
  targetHubId: string,
): PersonaEmbedSettings {
  const target = getPersonaHubById(settings, targetHubId);
  if (!target || settings.hubs.length < 2) {
    return settings;
  }
  if (target.id === settings.activeHubId) {
    const fallbackPrimary =
      (settings.secondaryHubId && settings.secondaryHubId !== target.id
        ? settings.secondaryHubId
        : settings.hubs.find((hub) => hub.id !== target.id)?.id) ?? null;
    if (!fallbackPrimary) {
      return settings;
    }
    return normalizePersonaEmbedSettings({
      ...settings,
      activeHubId: fallbackPrimary,
      secondaryHubId: target.id,
      splitEnabled: true,
    });
  }
  return normalizePersonaEmbedSettings({
    ...settings,
    secondaryHubId: target.id,
    splitEnabled: true,
  });
}

export function openPersonaHubInRightSplit(
  settings: PersonaEmbedSettings,
  targetHubId: string,
): PersonaEmbedSettings {
  if (settings.hubs.length < 2) {
    return settings;
  }
  const target = getPersonaHubById(settings, targetHubId);
  if (!target) {
    return settings;
  }
  if (target.id === settings.activeHubId) {
    return togglePersonaSplitMode(settings, true);
  }
  return normalizePersonaEmbedSettings({
    ...settings,
    splitEnabled: true,
    secondaryHubId: target.id,
  });
}

export function togglePersonaSplitMode(
  settings: PersonaEmbedSettings,
  explicitEnabled?: boolean,
): PersonaEmbedSettings {
  const nextEnabled = explicitEnabled ?? !settings.splitEnabled;
  if (!nextEnabled || settings.hubs.length < 2) {
    return normalizePersonaEmbedSettings({
      ...settings,
      splitEnabled: false,
    });
  }
  const secondary = getSecondaryPersonaHub(settings);
  if (!secondary) {
    return normalizePersonaEmbedSettings({
      ...settings,
      splitEnabled: false,
    });
  }
  return normalizePersonaEmbedSettings({
    ...settings,
    splitEnabled: true,
    secondaryHubId: secondary.id,
  });
}

export function swapPersonaSplitPanes(settings: PersonaEmbedSettings): PersonaEmbedSettings {
  const primary = getActivePersonaHub(settings);
  const secondary = getSecondaryPersonaHub(settings);
  if (!settings.splitEnabled || !primary || !secondary || primary.id === secondary.id) {
    return settings;
  }
  return normalizePersonaEmbedSettings({
    ...settings,
    activeHubId: secondary.id,
    secondaryHubId: primary.id,
    splitEnabled: true,
  });
}

export function closePersonaSplitPane(
  settings: PersonaEmbedSettings,
  closingSlot: "primary" | "secondary",
): PersonaEmbedSettings {
  if (!settings.splitEnabled) {
    return settings;
  }
  const secondary = getSecondaryPersonaHub(settings);
  if (closingSlot === "primary" && secondary) {
    return normalizePersonaEmbedSettings({
      ...settings,
      activeHubId: secondary.id,
      secondaryHubId: settings.activeHubId,
      splitEnabled: false,
    });
  }
  return normalizePersonaEmbedSettings({
    ...settings,
    splitEnabled: false,
  });
}

export type PersonaHubProfileMutationError =
  | "empty"
  | "invalid_protocol"
  | "credentials_not_allowed"
  | "invalid_url"
  | "max_hubs_reached"
  | "not_found";

export type PersonaHubProfileMutationResult =
  | { ok: true; settings: PersonaEmbedSettings; hub: PersonaHubProfile }
  | { ok: false; error: PersonaHubProfileMutationError };

export function addPersonaHubProfile(
  settings: PersonaEmbedSettings,
  input: {
    id?: string;
    name?: string;
    hubUrl: string;
    machineServerMap?: Record<string, string>;
  },
): PersonaHubProfileMutationResult {
  if (settings.hubs.length >= MAX_PERSONA_HUBS) {
    return { ok: false, error: "max_hubs_reached" };
  }
  const validatedUrl = normalizePersonaHubUrl(input.hubUrl);
  if (!validatedUrl.ok) {
    return { ok: false, error: validatedUrl.error };
  }
  const existingIds = new Set(settings.hubs.map((hub) => hub.id));
  const sanitizedRequestedId = sanitizePersonaHubId(input.id);
  const id =
    sanitizedRequestedId && !existingIds.has(sanitizedRequestedId)
      ? sanitizedRequestedId
      : createPersonaHubId(existingIds, input.name || validatedUrl.displayHost);
  const hub: PersonaHubProfile = {
    id,
    name: sanitizePersonaHubName(input.name, validatedUrl.url),
    hubUrl: validatedUrl.url,
    machineServerMap: sanitizeMachineServerMap(input.machineServerMap),
  };
  const nextSettings = normalizePersonaEmbedSettings({
    ...settings,
    hubs: [...settings.hubs, hub],
    activeHubId: settings.activeHubId || hub.id,
  });
  return { ok: true, settings: nextSettings, hub };
}

export function updatePersonaHubProfile(
  settings: PersonaEmbedSettings,
  hubId: string,
  patch: {
    name?: string;
    hubUrl?: string;
    machineServerMap?: Record<string, string>;
  },
): PersonaHubProfileMutationResult {
  const existing = getPersonaHubById(settings, hubId);
  if (!existing) {
    return { ok: false, error: "not_found" };
  }
  let nextUrl = existing.hubUrl;
  if (patch.hubUrl !== undefined) {
    const validatedUrl = normalizePersonaHubUrl(patch.hubUrl);
    if (!validatedUrl.ok) {
      return { ok: false, error: validatedUrl.error };
    }
    nextUrl = validatedUrl.url;
  }
  const nextHub: PersonaHubProfile = {
    id: existing.id,
    name: patch.name !== undefined ? sanitizePersonaHubName(patch.name, nextUrl) : existing.name,
    hubUrl: nextUrl,
    machineServerMap:
      patch.machineServerMap !== undefined
        ? sanitizeMachineServerMap(patch.machineServerMap)
        : existing.machineServerMap,
  };
  const nextHubs = settings.hubs.map((hub) => (hub.id === hubId ? nextHub : hub));
  const nextSettings = normalizePersonaEmbedSettings({
    ...settings,
    hubs: nextHubs,
  });
  return { ok: true, settings: nextSettings, hub: nextHub };
}

export function removePersonaHubProfile(
  settings: PersonaEmbedSettings,
  hubId: string,
): PersonaEmbedSettings {
  const nextHubs = settings.hubs.filter((hub) => hub.id !== hubId);
  if (nextHubs.length === settings.hubs.length) {
    return settings;
  }
  let nextActiveHubId = settings.activeHubId;
  let nextSecondaryHubId = settings.secondaryHubId;
  if (nextActiveHubId === hubId) {
    nextActiveHubId =
      (nextSecondaryHubId && nextSecondaryHubId !== hubId ? nextSecondaryHubId : nextHubs[0]?.id) ??
      "";
  }
  if (nextSecondaryHubId === hubId || nextSecondaryHubId === nextActiveHubId) {
    nextSecondaryHubId = nextHubs.find((hub) => hub.id !== nextActiveHubId)?.id ?? null;
  }
  const nextSplitEnabled =
    settings.splitEnabled && nextHubs.length >= 2 && nextSecondaryHubId !== null;
  return normalizePersonaEmbedSettings({
    ...settings,
    hubs: nextHubs,
    activeHubId: nextActiveHubId,
    secondaryHubId: nextSplitEnabled ? nextSecondaryHubId : null,
    splitEnabled: nextSplitEnabled,
  });
}

export function reorderPersonaHubProfiles(
  settings: PersonaEmbedSettings,
  fromIndex: number,
  toIndex: number,
): PersonaEmbedSettings {
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= settings.hubs.length ||
    toIndex >= settings.hubs.length ||
    fromIndex === toIndex
  ) {
    return settings;
  }
  const nextHubs = [...settings.hubs];
  const [moved] = nextHubs.splice(fromIndex, 1);
  if (!moved) {
    return settings;
  }
  nextHubs.splice(toIndex, 0, moved);
  return normalizePersonaEmbedSettings({
    ...settings,
    hubs: nextHubs,
  });
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
  desktopCheckHealth: (hubUrl?: string) => Promise<DesktopPersonaHealthCheckResult>,
  targetHubUrl: string,
): Promise<PersonaHealthCheckResult> {
  try {
    const result = await desktopCheckHealth(targetHubUrl);
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
    electronCheckHealth?: (hubUrl?: string) => Promise<DesktopPersonaHealthCheckResult>;
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
    return runDesktopHealthProbe(desktopCheckHealth, normalized.url);
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

function isWithinHubOriginAndBasePath(
  urlString: string,
  authorizedOrigin: string,
  authorizedBasePath: string,
): boolean {
  try {
    const parsed = new URL(urlString);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== authorizedOrigin
    ) {
      return false;
    }
    if (!authorizedBasePath) {
      return true;
    }
    return (
      parsed.pathname === authorizedBasePath || parsed.pathname.startsWith(`${authorizedBasePath}/`)
    );
  } catch {
    return false;
  }
}

function isSameOriginHttpUrl(urlString: string, authorizedOrigin: string): boolean {
  return isWithinHubOriginAndBasePath(urlString, authorizedOrigin, "");
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
}): { origin: string; basePath: string; frameUrl: string; guestWebContentsId: number } | null {
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

  // Require real main-process verified same-origin (+ basePath) frame URL (fail closed).
  if (
    typeof options.frameUrl !== "string" ||
    !isWithinHubOriginAndBasePath(options.frameUrl, hub.origin, hub.basePath)
  ) {
    return null;
  }

  if (options.currentGuestUrl !== undefined) {
    if (
      typeof options.currentGuestUrl !== "string" ||
      !isWithinHubOriginAndBasePath(options.currentGuestUrl, hub.origin, hub.basePath)
    ) {
      return null;
    }
  }

  return {
    origin: hub.origin,
    basePath: hub.basePath,
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
