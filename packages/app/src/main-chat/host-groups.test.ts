import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  createDefaultMainChatSettings,
  mergeMainChatSettings,
} from "@getpaseo/protocol/main-chat";
import { describe, expect, it, vi } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import {
  buildMainChatHostGroupsPartition,
  computeJoinGroupFleetScope,
  computeLeaveGroupFleetScope,
  ensureHostRegisteredOnOwnerDaemon,
  resolveMainChatCustomTitle,
} from "./host-groups";

function makeProfile(
  serverId: string,
  label: string,
  connections: HostProfile["connections"] = [],
): HostProfile {
  return {
    serverId,
    label,
    connections,
  } as unknown as HostProfile;
}

describe("Main Chat host-groups pure partition & transition model", () => {
  it("distinguishes generic default titles from real custom titles and keeps host name primary", () => {
    expect(resolveMainChatCustomTitle(MAIN_CHAT_DEFAULT_TITLE, "n37-217-003")).toBeNull();
    expect(resolveMainChatCustomTitle("对话管理", "DevBox")).toBeNull();
    expect(resolveMainChatCustomTitle("Main Chat", "iMac")).toBeNull();
    expect(resolveMainChatCustomTitle("DevBox", "DevBox")).toBeNull();
    expect(resolveMainChatCustomTitle("研发总控", "n37-217-003")).toBe("研发总控");
  });

  it("partitions hosts cleanly: cold start puts all hosts in unmanaged, and enabled stewards form disjoint groups", () => {
    const clientHosts = [
      makeProfile("srv_devbox", "n37-217-003"),
      makeProfile("srv_macmini", "Mac mini"),
      makeProfile("srv_macbook", "MacBook"),
      makeProfile("srv_imac", "iMac"),
    ];
    const sessionsByServerId = {
      srv_devbox: {
        serverId: "srv_devbox",
        hostname: "n37-217-003",
        online: true,
        supportsMainChat: true,
        hasExistingMainChat: false,
        agentCount: 12,
        needsAttentionCount: 2,
      },
      srv_macmini: {
        serverId: "srv_macmini",
        hostname: "mac-mini",
        online: true,
        supportsMainChat: true,
        hasExistingMainChat: false,
        agentCount: 0,
        needsAttentionCount: 0,
      },
      srv_macbook: {
        serverId: "srv_macbook",
        hostname: "macbook",
        online: true,
        supportsMainChat: true,
        hasExistingMainChat: false,
        agentCount: 3,
        needsAttentionCount: 1,
      },
      srv_imac: {
        serverId: "srv_imac",
        hostname: "imac",
        online: true,
        supportsMainChat: true,
        hasExistingMainChat: false,
        agentCount: 1,
        needsAttentionCount: 0,
      },
    };

    // Cold start: all default settings (enabled: false) -> 0 groups, 4 unmanaged, 0 conflicts
    const cold = buildMainChatHostGroupsPartition({
      clientHosts,
      sessionsByServerId,
      settingsByServerId: {
        srv_devbox: createDefaultMainChatSettings(),
        srv_macmini: createDefaultMainChatSettings(),
        srv_macbook: createDefaultMainChatSettings(),
        srv_imac: createDefaultMainChatSettings(),
      },
      fleetHostsByServerId: {},
      cachedStewardsByServerId: {},
      activeStewardServerId: null,
      defaultStewardServerId: null,
    });
    expect(cold.groups).toEqual([]);
    expect(cold.unmanaged.map((h) => h.serverId).sort()).toEqual([
      "srv_devbox",
      "srv_imac",
      "srv_macbook",
      "srv_macmini",
    ]);
    expect(cold.legacyConflicts).toEqual([]);

    // Two enabled main chats with identical default title "对话管理" remain uniquely identified by host name
    const devEnabled = mergeMainChatSettings(createDefaultMainChatSettings(), {
      enabled: true,
      title: "对话管理",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_macmini"] },
    });
    const imacEnabled = mergeMainChatSettings(createDefaultMainChatSettings(), {
      enabled: true,
      title: "对话管理",
      fleetScope: { mode: "local_only", hostServerIds: [] },
    });
    const partitioned = buildMainChatHostGroupsPartition({
      clientHosts,
      sessionsByServerId,
      settingsByServerId: {
        srv_devbox: devEnabled,
        srv_macmini: createDefaultMainChatSettings(),
        srv_macbook: createDefaultMainChatSettings(),
        srv_imac: imacEnabled,
      },
      fleetHostsByServerId: {},
      cachedStewardsByServerId: {},
      activeStewardServerId: "srv_devbox",
      defaultStewardServerId: "srv_devbox",
    });

    expect(partitioned.legacyConflicts).toEqual([]);
    expect(partitioned.groups).toHaveLength(2);
    expect(partitioned.groups[0]).toMatchObject({
      ownerServerId: "srv_devbox",
      ownerHostLabel: "n37-217-003",
      customTitle: null,
      isActive: true,
      totalCount: 2,
      onlineCount: 2,
    });
    expect(partitioned.groups[0]?.members.map((m) => m.serverId)).toEqual([
      "srv_devbox",
      "srv_macmini",
    ]);
    expect(partitioned.groups[1]).toMatchObject({
      ownerServerId: "srv_imac",
      ownerHostLabel: "iMac",
      customTitle: null,
      isActive: false,
      totalCount: 1,
    });
    expect(partitioned.unmanaged.map((h) => h.serverId)).toEqual(["srv_macbook"]);
  });

  it("computes deterministic join and leave fleetScope transitions", () => {
    const joinedFirst = computeJoinGroupFleetScope({
      ownerServerId: "srv_devbox",
      currentScope: { mode: "local_only", hostServerIds: [] },
      currentRemoteMemberIds: [],
      targetHostServerId: "srv_macbook",
    });
    expect(joinedFirst).toEqual({ mode: "allowlist", hostServerIds: ["srv_macbook"] });

    const joinedSecond = computeJoinGroupFleetScope({
      ownerServerId: "srv_devbox",
      currentScope: joinedFirst,
      currentRemoteMemberIds: ["srv_macbook"],
      targetHostServerId: "srv_macmini",
    });
    expect(joinedSecond).toEqual({
      mode: "allowlist",
      hostServerIds: ["srv_macbook", "srv_macmini"],
    });

    const leftOne = computeLeaveGroupFleetScope({
      ownerServerId: "srv_devbox",
      currentScope: joinedSecond,
      currentRemoteMemberIds: ["srv_macbook", "srv_macmini"],
      targetHostServerId: "srv_macbook",
    });
    expect(leftOne).toEqual({ mode: "allowlist", hostServerIds: ["srv_macmini"] });

    const leftLast = computeLeaveGroupFleetScope({
      ownerServerId: "srv_devbox",
      currentScope: leftOne,
      currentRemoteMemberIds: ["srv_macmini"],
      targetHostServerId: "srv_macmini",
    });
    expect(leftLast).toEqual({ mode: "local_only", hostServerIds: [] });
  });

  it("deduplicates host registration before calling addHost on the owner daemon", async () => {
    const addHost = vi.fn(async () => ({ host: { registrationId: "hst_1" } }));
    const listHosts = vi.fn(async () => ({
      hosts: [
        {
          registrationId: "hst_existing",
          serverId: "srv_macbook",
          label: "MacBook",
          status: "online",
        },
      ],
    }));

    const existingResult = await ensureHostRegisteredOnOwnerDaemon({
      ownerClient: { listHosts, addHost } as unknown as DaemonClient,
      targetServerId: "srv_macbook",
      targetLabel: "MacBook",
      targetProfile: makeProfile("srv_macbook", "MacBook"),
      syncConnection: "tcp://10.0.0.2:6767",
    });
    expect(existingResult).toEqual({ status: "already_linked" });
    expect(addHost).not.toHaveBeenCalled();

    listHosts.mockResolvedValueOnce({ hosts: [] });
    const freshResult = await ensureHostRegisteredOnOwnerDaemon({
      ownerClient: { listHosts, addHost } as unknown as DaemonClient,
      targetServerId: "srv_imac",
      targetLabel: "iMac",
      targetProfile: makeProfile("srv_imac", "iMac"),
      syncConnection: "tcp://10.0.0.3:6767",
    });
    expect(freshResult).toEqual({ status: "added" });
    expect(addHost).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: "tcp://10.0.0.3:6767",
        label: "iMac",
        sourceKey: "main-chat-sync:srv_imac",
      }),
    );
  });
});
