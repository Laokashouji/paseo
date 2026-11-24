import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { normalizeHostPort, parseHostPort } from "@getpaseo/protocol/daemon-endpoints";
import type { HostSummary } from "@getpaseo/protocol/hosts";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  isMainChatEnabled,
  normalizeMainChatFleetScope,
  resolveMainChatFleetScope,
  type MainChatFleetHostStatus,
  type MainChatFleetScope,
  type MainChatSettings,
  type MainChatStyle,
} from "@getpaseo/protocol/main-chat";
import type { HostProfile } from "@/types/host-connection";
import { buildSyncConnectionString } from "./host-sync-banner";
import {
  buildStewardRoster,
  detectStewardHostConflicts,
  type CachedMainChatStewardMeta,
  type MainChatStewardRosterCandidateHost,
  type StewardAccentTone,
  type StewardHostConflict,
} from "./steward-store";

const DEFAULT_TITLES_LOWER = new Set([
  MAIN_CHAT_DEFAULT_TITLE.trim().toLowerCase(),
  "对话管理",
  "main chat",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);

export const MAIN_CHAT_GROUP_SYNC_SOURCE_PREFIX = "main-chat-sync:";

export interface HostGroupSessionSnapshot {
  serverId: string;
  hostname: string | null;
  online: boolean;
  supportsMainChat: boolean;
  hasExistingMainChat: boolean;
  agentCount: number;
  needsAttentionCount: number;
}

export interface MainChatGroupHostItem {
  serverId: string;
  label: string;
  isOwner: boolean;
  status: MainChatFleetHostStatus["status"];
  agentCount: number;
  needsAttentionCount: number;
  error: string | null;
  linkedOnDaemon: boolean;
  syncConnection: string | null;
}

export interface MainChatHostGroup {
  ownerServerId: string;
  ownerHostLabel: string;
  customTitle: string | null;
  ownerOnline: boolean;
  isActive: boolean;
  isDefault: boolean;
  accentTone: StewardAccentTone;
  style: MainChatStyle;
  fleetScope: MainChatFleetScope;
  members: MainChatGroupHostItem[];
  totalCount: number;
  onlineCount: number;
  totalNeedsAttention: number;
}

export interface MainChatUnmanagedHostItem {
  serverId: string;
  label: string;
  status: MainChatFleetHostStatus["status"];
  online: boolean;
  supportsMainChat: boolean;
  agentCount: number;
  needsAttentionCount: number;
  syncConnection: string | null;
}

export interface MainChatHostGroupsPartition {
  groups: MainChatHostGroup[];
  unmanaged: MainChatUnmanagedHostItem[];
  legacyConflicts: StewardHostConflict[];
}

export interface BuildMainChatHostGroupsInput {
  clientHosts: readonly HostProfile[];
  sessionsByServerId: Readonly<Record<string, HostGroupSessionSnapshot | undefined>>;
  settingsByServerId: Readonly<Record<string, MainChatSettings | undefined>>;
  fleetHostsByServerId: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>>;
  availableRemoteHostsByServerId?: Readonly<
    Record<string, readonly MainChatFleetHostStatus[] | undefined>
  >;
  cachedStewardsByServerId: Readonly<Record<string, CachedMainChatStewardMeta | undefined>>;
  activeStewardServerId: string | null;
  defaultStewardServerId: string | null;
}

/**
 * Returns a non-null custom title only when the user renamed the main chat away from default
 * generic labels ("对话管理" / "Main Chat") and away from the host's own display name.
 */
export function resolveMainChatCustomTitle(
  title: string | null | undefined,
  hostLabel: string,
): string | null {
  const trimmed = title?.trim() ?? "";
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (DEFAULT_TITLES_LOWER.has(lowered)) return null;
  if (lowered === hostLabel.trim().toLowerCase()) return null;
  return trimmed;
}

/**
 * Computes the next `fleetScope` after adding `targetHostServerId` to a group.
 * Always writes an explicit `allowlist` so membership is deterministic and never spills over.
 */
export function computeJoinGroupFleetScope(input: {
  ownerServerId: string;
  currentScope: MainChatFleetScope | null | undefined;
  currentRemoteMemberIds: readonly string[];
  targetHostServerId: string;
}): MainChatFleetScope {
  const normalizedTarget = input.targetHostServerId.trim();
  const baseIds =
    input.currentScope?.mode === "all_connected"
      ? input.currentRemoteMemberIds
      : (input.currentScope?.hostServerIds ?? input.currentRemoteMemberIds);
  return normalizeMainChatFleetScope(
    {
      mode: "allowlist",
      hostServerIds: [...baseIds, normalizedTarget],
    },
    input.ownerServerId,
  );
}

/**
 * Computes the next `fleetScope` after removing `targetHostServerId` from a group.
 * Drops back to `local_only` once no remote members remain.
 */
export function computeLeaveGroupFleetScope(input: {
  ownerServerId: string;
  currentScope: MainChatFleetScope | null | undefined;
  currentRemoteMemberIds: readonly string[];
  targetHostServerId: string;
}): MainChatFleetScope {
  const normalizedTarget = input.targetHostServerId.trim();
  const baseIds =
    input.currentScope?.mode === "all_connected"
      ? input.currentRemoteMemberIds
      : (input.currentScope?.hostServerIds ?? input.currentRemoteMemberIds);
  const remaining = baseIds
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id !== input.ownerServerId && id !== normalizedTarget);
  const uniqueRemaining = Array.from(new Set(remaining));
  if (uniqueRemaining.length === 0) {
    return { mode: "local_only", hostServerIds: [] };
  }
  return normalizeMainChatFleetScope(
    {
      mode: "allowlist",
      hostServerIds: uniqueRemaining,
    },
    input.ownerServerId,
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.startsWith("127.");
}

function buildExpectedTargetDescriptions(host: HostProfile): string[] {
  if (!Array.isArray(host.connections)) return [];
  const descriptions: string[] = [];
  for (const conn of host.connections) {
    if (conn.type === "relay") {
      const endpoint = conn.relayEndpoint.trim();
      if (!endpoint || !host.serverId) continue;
      try {
        descriptions.push(
          `relay://${normalizeHostPort(endpoint)}/${encodeURIComponent(host.serverId)}`,
        );
      } catch {
        descriptions.push(`relay://${endpoint}/${encodeURIComponent(host.serverId)}`);
      }
    } else if (conn.type === "directTcp") {
      const endpoint = conn.endpoint.trim();
      if (!endpoint) continue;
      try {
        const parts = parseHostPort(endpoint);
        if (isLoopbackHost(parts.host)) continue;
        const normalized = normalizeHostPort(
          `${parts.isIpv6 ? `[${parts.host}]` : parts.host}:${parts.port}`,
        );
        descriptions.push(`tcp://${normalized}`);
      } catch {
        continue;
      }
    }
  }
  return descriptions;
}

function extractRelayTargetServerId(targetDescription: string | undefined): string | null {
  const trimmed = targetDescription?.trim();
  if (!trimmed || !trimmed.startsWith("relay://")) return null;
  const rest = trimmed.slice("relay://".length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 0) return null;
  const raw = rest.slice(slashIndex + 1).trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim() || raw;
  } catch {
    return raw;
  }
}

function isAlreadyRegisteredOnDaemon(
  hostProfile: HostProfile | undefined,
  serverId: string,
  existingHosts: readonly HostSummary[],
): boolean {
  const sourceKey = `${MAIN_CHAT_GROUP_SYNC_SOURCE_PREFIX}${serverId}`;
  const targetSet = new Set(hostProfile ? buildExpectedTargetDescriptions(hostProfile) : []);
  for (const row of existingHosts) {
    if (row.serverId === serverId) return true;
    if (row.metadata?.mainChatSyncServerId?.trim() === serverId) return true;
    if (row.source?.key === sourceKey) return true;
    if (extractRelayTargetServerId(row.targetDescription) === serverId) return true;
    if (targetSet.size > 0 && row.targetDescription && targetSet.has(row.targetDescription)) {
      return true;
    }
  }
  return false;
}

function isSourceConflictError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "code" in error && error.code === "source_conflict") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /source_conflict|source key already exists/i.test(message);
}

/**
 * Ensures `targetServerId` is registered inside `ownerClient`'s ConnectedHosts without creating
 * duplicate registrations.
 */
export async function ensureHostRegisteredOnOwnerDaemon(input: {
  ownerClient: DaemonClient;
  targetServerId: string;
  targetLabel: string;
  targetProfile: HostProfile | undefined;
  syncConnection: string;
}): Promise<{ status: "added" | "already_linked"; error?: string }> {
  if (typeof input.ownerClient.listHosts === "function") {
    try {
      const directory = await input.ownerClient.listHosts();
      if (
        Array.isArray(directory?.hosts) &&
        isAlreadyRegisteredOnDaemon(input.targetProfile, input.targetServerId, directory.hosts)
      ) {
        return { status: "already_linked" };
      }
    } catch {
      // Fall through to deterministic sourceKey deduplication on addHost.
    }
  }

  if (typeof input.ownerClient.addHost !== "function") {
    return { status: "already_linked" };
  }

  try {
    const result = await input.ownerClient.addHost({
      connection: input.syncConnection,
      label: input.targetLabel,
      sourceKey: `${MAIN_CHAT_GROUP_SYNC_SOURCE_PREFIX}${input.targetServerId}`,
      metadata: { mainChatSyncServerId: input.targetServerId },
    });
    const rawError = result?.error;
    const errorMessage = extractAddHostErrorMessage(rawError);
    if (errorMessage) {
      if (isSourceConflictError(rawError) || isSourceConflictError(errorMessage)) {
        return { status: "already_linked" };
      }
      return { status: "already_linked", error: errorMessage };
    }
    return { status: "added" };
  } catch (error) {
    if (isSourceConflictError(error)) {
      return { status: "already_linked" };
    }
    return {
      status: "already_linked",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function extractAddHostErrorMessage(rawError: unknown): string | null {
  if (typeof rawError === "string") return rawError;
  if (rawError && typeof rawError === "object" && "message" in rawError) {
    return String(rawError.message);
  }
  return null;
}

function addFleetListLabels(
  lists: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>> | undefined,
  labels: Map<string, string>,
): void {
  if (!lists) return;
  for (const list of Object.values(lists)) {
    if (!list) continue;
    for (const host of list) {
      const label = host.label.trim();
      if (label && !labels.has(host.serverId)) {
        labels.set(host.serverId, label);
      }
    }
  }
}

function collectHostLabelMap(input: BuildMainChatHostGroupsInput): Map<string, string> {
  const labels = new Map<string, string>();
  for (const host of input.clientHosts) {
    const trimmed = host.label.trim();
    if (trimmed) labels.set(host.serverId, trimmed);
  }
  for (const [serverId, session] of Object.entries(input.sessionsByServerId)) {
    const hostname = session?.hostname?.trim();
    if (hostname && !labels.has(serverId)) {
      labels.set(serverId, hostname);
    }
  }
  addFleetListLabels(input.fleetHostsByServerId, labels);
  addFleetListLabels(input.availableRemoteHostsByServerId, labels);
  for (const [serverId, cached] of Object.entries(input.cachedStewardsByServerId)) {
    const hostname = cached?.hostname.trim();
    if (hostname && !labels.has(serverId)) {
      labels.set(serverId, hostname);
    }
  }
  return labels;
}

function addFleetListHostIds(
  lists: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>> | undefined,
  add: (id: string | null | undefined) => void,
): void {
  if (!lists) return;
  for (const list of Object.values(lists)) {
    if (!list) continue;
    for (const host of list) add(host.serverId);
  }
}

function collectAllKnownHostIds(input: BuildMainChatHostGroupsInput): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (id: string | null | undefined) => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  for (const host of input.clientHosts) add(host.serverId);
  for (const serverId of Object.keys(input.sessionsByServerId)) add(serverId);
  addFleetListHostIds(input.fleetHostsByServerId, add);
  addFleetListHostIds(input.availableRemoteHostsByServerId, add);
  return ordered;
}

function resolveMemberStatus(
  fleetEntry: MainChatFleetHostStatus | undefined,
  availableEntry: MainChatFleetHostStatus | undefined,
  session: HostGroupSessionSnapshot | undefined,
): MainChatFleetHostStatus["status"] {
  if (fleetEntry) return fleetEntry.status;
  if (session?.online) return "online";
  return availableEntry?.status ?? "offline";
}

function buildGroupMemberRow(input: {
  serverId: string;
  isOwner: boolean;
  label: string;
  fleetEntry: MainChatFleetHostStatus | undefined;
  availableEntry: MainChatFleetHostStatus | undefined;
  session: HostGroupSessionSnapshot | undefined;
  profile: HostProfile | undefined;
}): MainChatGroupHostItem {
  const { serverId, isOwner, label, fleetEntry, availableEntry, session, profile } = input;
  return {
    serverId,
    label,
    isOwner,
    status: resolveMemberStatus(fleetEntry, availableEntry, session),
    agentCount: fleetEntry?.agentCount ?? session?.agentCount ?? availableEntry?.agentCount ?? 0,
    needsAttentionCount:
      fleetEntry?.needsAttentionCount ??
      session?.needsAttentionCount ??
      availableEntry?.needsAttentionCount ??
      0,
    error: fleetEntry?.error ?? availableEntry?.error ?? null,
    linkedOnDaemon: isOwner || Boolean(fleetEntry || availableEntry),
    syncConnection: profile ? buildSyncConnectionString(profile) : null,
  };
}

function indexFleetHostsById(
  hosts: readonly MainChatFleetHostStatus[] | undefined,
): Map<string, MainChatFleetHostStatus> {
  const map = new Map<string, MainChatFleetHostStatus>();
  if (!hosts) return map;
  for (const entry of hosts) {
    map.set(entry.serverId, entry);
  }
  return map;
}

function findAvailableRemoteSummary(
  availableByOwner:
    | Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>>
    | undefined,
  serverId: string,
): MainChatFleetHostStatus | undefined {
  if (!availableByOwner) return undefined;
  for (const list of Object.values(availableByOwner)) {
    const hit = list?.find((entry) => entry.serverId === serverId);
    if (hit) return hit;
  }
  return undefined;
}

function buildSingleHostGroup(input: {
  rosterItem: ReturnType<typeof buildStewardRoster>[number];
  buildInput: BuildMainChatHostGroupsInput;
  hostLabels: ReadonlyMap<string, string>;
  profileById: ReadonlyMap<string, HostProfile>;
  assignedHostIds: Set<string>;
}): MainChatHostGroup {
  const { rosterItem, buildInput, hostLabels, profileById, assignedHostIds } = input;
  const ownerId = rosterItem.serverId;
  const ownerSettings = buildInput.settingsByServerId[ownerId];
  const fleetScope = resolveMainChatFleetScope(
    ownerSettings ?? { fleetScope: rosterItem.fleetScope },
    ownerId,
  );
  const fleetById = indexFleetHostsById(buildInput.fleetHostsByServerId[ownerId]);
  const availableById = indexFleetHostsById(buildInput.availableRemoteHostsByServerId?.[ownerId]);
  const ownerHostLabel = hostLabels.get(ownerId) ?? rosterItem.hostLabel ?? ownerId;

  const members: MainChatGroupHostItem[] = [
    buildGroupMemberRow({
      serverId: ownerId,
      isOwner: true,
      label: ownerHostLabel,
      fleetEntry: fleetById.get(ownerId),
      availableEntry: undefined,
      session: buildInput.sessionsByServerId[ownerId],
      profile: profileById.get(ownerId),
    }),
  ];

  for (const remoteId of rosterItem.managedHostIds) {
    if (remoteId === ownerId || assignedHostIds.has(remoteId)) continue;
    assignedHostIds.add(remoteId);
    members.push(
      buildGroupMemberRow({
        serverId: remoteId,
        isOwner: false,
        label: hostLabels.get(remoteId) ?? remoteId,
        fleetEntry: fleetById.get(remoteId),
        availableEntry: availableById.get(remoteId),
        session: buildInput.sessionsByServerId[remoteId],
        profile: profileById.get(remoteId),
      }),
    );
  }

  return {
    ownerServerId: ownerId,
    ownerHostLabel,
    customTitle: resolveMainChatCustomTitle(
      ownerSettings?.title ?? rosterItem.title,
      ownerHostLabel,
    ),
    ownerOnline: rosterItem.online,
    isActive: buildInput.activeStewardServerId === ownerId,
    isDefault: rosterItem.isDefault,
    accentTone: rosterItem.accentTone,
    style: ownerSettings?.style ?? "conservative",
    fleetScope,
    members,
    totalCount: members.length,
    onlineCount: members.filter((member) => member.status === "online").length,
    totalNeedsAttention: members.reduce((sum, member) => sum + member.needsAttentionCount, 0),
  };
}

function buildUnmanagedHostItem(params: {
  serverId: string;
  session: HostGroupSessionSnapshot | undefined;
  profile: HostProfile | undefined;
  remoteSummary: MainChatFleetHostStatus | undefined;
  label: string;
}): MainChatUnmanagedHostItem {
  const { serverId, session, profile, remoteSummary, label } = params;
  const online = Boolean(session?.online);
  return {
    serverId,
    label,
    status: online ? "online" : (remoteSummary?.status ?? "offline"),
    online,
    supportsMainChat: Boolean(session?.supportsMainChat || session?.hasExistingMainChat),
    agentCount: session?.agentCount ?? remoteSummary?.agentCount ?? 0,
    needsAttentionCount: session?.needsAttentionCount ?? remoteSummary?.needsAttentionCount ?? 0,
    syncConnection: profile ? buildSyncConnectionString(profile) : null,
  };
}

function collectUnmanagedHosts(input: {
  allHostIds: readonly string[];
  assignedHostIds: ReadonlySet<string>;
  buildInput: BuildMainChatHostGroupsInput;
  hostLabels: ReadonlyMap<string, string>;
  profileById: ReadonlyMap<string, HostProfile>;
}): MainChatUnmanagedHostItem[] {
  const { allHostIds, assignedHostIds, buildInput, hostLabels, profileById } = input;
  const unmanaged: MainChatUnmanagedHostItem[] = [];

  for (const serverId of allHostIds) {
    if (assignedHostIds.has(serverId)) continue;
    if (isMainChatEnabled(buildInput.settingsByServerId[serverId])) continue;

    unmanaged.push(
      buildUnmanagedHostItem({
        serverId,
        session: buildInput.sessionsByServerId[serverId],
        profile: profileById.get(serverId),
        remoteSummary: findAvailableRemoteSummary(
          buildInput.availableRemoteHostsByServerId,
          serverId,
        ),
        label: hostLabels.get(serverId) ?? serverId,
      }),
    );
  }

  unmanaged.sort((left, right) => {
    const leftOnline = left.online ? 0 : 1;
    const rightOnline = right.online ? 0 : 1;
    if (leftOnline !== rightOnline) return leftOnline - rightOnline;
    return left.label.localeCompare(right.label);
  });

  return unmanaged;
}

/**
 * Partitions all known hosts into:
 * - `groups`: one card per enabled Main Chat host, identified primarily by its host name
 * - `unmanaged`: all remaining hosts that are not owners or members of any group
 * - `legacyConflicts`: any cross-daemon overlap (e.g. from an un-upgraded daemon)
 */
export function buildMainChatHostGroupsPartition(
  input: BuildMainChatHostGroupsInput,
): MainChatHostGroupsPartition {
  const hostLabels = collectHostLabelMap(input);
  const profileById = new Map<string, HostProfile>(
    input.clientHosts.map((host) => [host.serverId, host]),
  );
  const allHostIds = collectAllKnownHostIds(input);

  const rosterCandidates: MainChatStewardRosterCandidateHost[] = allHostIds.map((serverId) => {
    const session = input.sessionsByServerId[serverId];
    return {
      serverId,
      label: hostLabels.get(serverId) ?? serverId,
      hostname: session?.hostname ?? null,
      online: Boolean(session?.online),
      supportsMainChat: Boolean(session?.supportsMainChat || session?.hasExistingMainChat),
      hasExistingMainChat: Boolean(session?.hasExistingMainChat),
    };
  });

  const roster = buildStewardRoster({
    hosts: rosterCandidates,
    settingsByServerId: input.settingsByServerId,
    fleetHostsByServerId: input.fleetHostsByServerId,
    cachedStewardsByServerId: input.cachedStewardsByServerId,
    defaultStewardServerId: input.defaultStewardServerId,
    hostLabelsByServerId: Object.fromEntries(hostLabels.entries()),
  });

  const capableServerIds = new Set(
    rosterCandidates
      .filter((c) => c.supportsMainChat || c.hasExistingMainChat)
      .map((c) => c.serverId),
  );
  const sessionHostnames: Record<string, string | undefined> = {};
  for (const [id, session] of Object.entries(input.sessionsByServerId)) {
    sessionHostnames[id] = session?.hostname ?? undefined;
  }

  const legacyConflicts = detectStewardHostConflicts({
    hosts: input.clientHosts,
    capableServerIds,
    settingsByServerId: input.settingsByServerId,
    fleetHostsByServerId: input.fleetHostsByServerId,
    sessionHostnamesByServerId: sessionHostnames,
  });

  const assignedHostIds = new Set<string>(roster.map((item) => item.serverId));
  const groups = roster.map((rosterItem) =>
    buildSingleHostGroup({
      rosterItem,
      buildInput: input,
      hostLabels,
      profileById,
      assignedHostIds,
    }),
  );
  const unmanaged = collectUnmanagedHosts({
    allHostIds,
    assignedHostIds,
    buildInput: input,
    hostLabels,
    profileById,
  });

  return {
    groups,
    unmanaged,
    legacyConflicts,
  };
}
