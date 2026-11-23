import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { ConnectedHosts } from "./index.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
});

interface PeerServerOptions {
  serverId: string;
  hostname?: string;
  features?: Record<string, boolean>;
}

async function startFakePeer(options: PeerServerOptions) {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const features = options.features ?? {
    connectedHosts: true,
    hostMultiplexing: true,
  };

  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type: string };
      if (frame.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (frame.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: options.serverId,
                hostname: options.hostname ?? options.serverId,
                version: "0.17.0",
                features,
              },
            },
          }),
        );
      }
    });
  });

  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind loopback peer");
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  cleanup.push(close);

  return {
    connection: `127.0.0.1:${address.port}`,
    disconnectClients: () => {
      for (const socket of wss.clients) socket.terminate();
    },
    close,
  };
}

async function createRegistry(self = { serverId: "srv_local", label: "DevBox" }) {
  const home = await mkdtemp(join(tmpdir(), "connected-hosts-unit-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const hosts = new ConnectedHosts(home, self);
  cleanup.push(() => hosts.close());
  return hosts;
}

const actor = { sourceId: "user", manageSources: true };

describe("ConnectedHosts internal client pool accessors", () => {
  test("getSelfHost returns a defensive copy of self identity", async () => {
    const hosts = await createRegistry({ serverId: "srv_main", label: "Main Host" });

    const first = hosts.getSelfHost();
    expect(first).toEqual({ serverId: "srv_main", label: "Main Host" });

    first.label = "Mutated";
    expect(hosts.getSelfHost()).toEqual({ serverId: "srv_main", label: "Main Host" });
  });

  test("listAcceptedHosts and getAcceptedClient expose only connected, enabled, accepted hosts", async () => {
    const mac = await startFakePeer({ serverId: "srv_mac", hostname: "MacBook-Pro" });
    const imac = await startFakePeer({ serverId: "srv_imac", hostname: "Home-iMac" });
    const legacy = await startFakePeer({
      serverId: "srv_legacy",
      hostname: "Legacy-Box",
      features: { connectedHosts: true, hostMultiplexing: false },
    });
    const selfLoop = await startFakePeer({ serverId: "srv_local", hostname: "Self-Loop" });

    const hosts = await createRegistry({ serverId: "srv_local", label: "DevBox" });
    const macRow = await hosts.add({ connection: mac.connection, label: "MacBook" }, actor);
    await hosts.add({ connection: imac.connection }, actor);
    await hosts.add({ connection: legacy.connection, label: "OldHost" }, actor);
    await hosts.add({ connection: selfLoop.connection, label: "SelfCopy" }, actor);

    const listAcceptedIds = () =>
      hosts
        .listAcceptedHosts()
        .map((item) => item.serverId)
        .sort();
    await expect.poll(listAcceptedIds).toEqual(["srv_imac", "srv_mac"]);

    const accepted = hosts.listAcceptedHosts();
    const macHandle = accepted.find((item) => item.serverId === "srv_mac");
    const imacHandle = accepted.find((item) => item.serverId === "srv_imac");

    expect(macHandle).toMatchObject({
      registrationId: macRow.registrationId,
      serverId: "srv_mac",
      label: "MacBook",
    });
    expect(macHandle?.lastOnlineAt).not.toBeNull();
    expect(macHandle?.client.isConnected).toBe(true);

    // Falls back to the remote daemon hostname when no explicit label is configured.
    expect(imacHandle?.label).toBe("Home-iMac");

    expect(hosts.getAcceptedClient("srv_mac")).toBe(macHandle?.client);
    expect(hosts.getAcceptedClient("srv_imac")).toBe(imacHandle?.client);
    expect(hosts.getAcceptedClient("srv_legacy")).toBeNull();
    expect(hosts.getAcceptedClient("srv_local")).toBeNull();
    expect(hosts.getAcceptedClient("srv_missing")).toBeNull();

    // Known hosts include offline/error entries without exposing raw connection strings.
    const getSelfLoopStatus = () =>
      hosts.listKnownHosts().find((item) => item.serverId === "srv_local")?.status;
    await expect.poll(getSelfLoopStatus).toBe("error");
    const known = hosts.listKnownHosts();
    expect(known).toHaveLength(4);
    for (const entry of known) {
      expect("connection" in entry).toBe(false);
    }

    // Disabling a host immediately removes it from accepted handles.
    await hosts.update(macRow.registrationId, { enabled: false }, actor);
    expect(hosts.getAcceptedClient("srv_mac")).toBeNull();
    expect(hosts.listAcceptedHosts().map((item) => item.serverId)).toEqual(["srv_imac"]);
    expect(
      hosts.listKnownHosts().find((item) => item.registrationId === macRow.registrationId)?.status,
    ).toBe("disabled");

    // Re-enabling brings it back online and accepted.
    await hosts.update(macRow.registrationId, { enabled: true }, actor);
    await expect.poll(() => hosts.getAcceptedClient("srv_mac")).not.toBeNull();

    // Dropping the remote server removes it from accepted clients until reconnected.
    await imac.close();
    await expect.poll(() => hosts.getAcceptedClient("srv_imac")).toBeNull();
    expect(hosts.listAcceptedHosts().map((item) => item.serverId)).toEqual(["srv_mac"]);

    // Closing the registry clears all accepted client access.
    await hosts.close();
    expect(hosts.listAcceptedHosts()).toEqual([]);
    expect(hosts.getAcceptedClient("srv_mac")).toBeNull();
  });

  test("subscribeHostChanges broadcasts lifecycle transitions, isolates listener errors, and unsubscribes cleanly", async () => {
    const peer = await startFakePeer({ serverId: "srv_peer", hostname: "Peer" });
    const hosts = await createRegistry();

    let goodNotifications = 0;
    let unsubscribedNotifications = 0;

    const unsubscribeBroken = hosts.subscribeHostChanges(() => {
      throw new Error("boom in subscriber");
    });
    const unsubscribeGood = hosts.subscribeHostChanges(() => {
      goodNotifications += 1;
    });
    const unsubscribeOnce = hosts.subscribeHostChanges(() => {
      unsubscribedNotifications += 1;
      unsubscribeOnce();
    });

    const added = await hosts.add({ connection: peer.connection, label: "Peer" }, actor);
    await expect.poll(() => hosts.getAcceptedClient("srv_peer")).not.toBeNull();

    expect(goodNotifications).toBeGreaterThanOrEqual(2);
    expect(unsubscribedNotifications).toBe(1);

    const countBeforeUnsub = goodNotifications;
    unsubscribeGood();
    unsubscribeBroken();

    await hosts.remove(added.registrationId, actor);
    expect(goodNotifications).toBe(countBeforeUnsub);
    expect(hosts.listKnownHosts()).toEqual([]);
  });
});
