import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import {
  createDefaultMainChatSettings,
  FEISHU_BRIDGE_PLUGIN_ID,
  FEISHU_BRIDGE_WEBHOOK_PATH,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
} from "@getpaseo/protocol/main-chat";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, PersistedAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import {
  createFeishuBridgeSeam,
  type FeishuBridgePluginRpcCompletedEvent,
} from "./feishu-bridge-seam.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage, type MainChatSessionMessage } from "./session.js";
import type { SessionOutboundMessage } from "../messages.js";
import { PluginService, type PluginRpcCompletedEvent } from "../plugins/index.js";
import { DaemonConfigStore } from "../daemon-config-store.js";

function computeLarkSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: string;
}): string {
  return createHash("sha256")
    .update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.rawBody}`, "utf8")
    .digest("hex");
}

function encryptLarkPayload(plaintextJson: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(plaintextJson, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

interface MockFeishuApiServer {
  baseUrl: string;
  tokenCalls: number;
  issuedTokens: string[];
  sentCards: Array<{
    messageId: string;
    receiveIdType: string;
    receiveId: string;
    card: Record<string, unknown>;
    uuid?: string;
  }>;
  patchedCards: Array<{
    messageId: string;
    card: Record<string, unknown>;
  }>;
  setTokenTtlSeconds(sec: number): void;
  setSendError(error: { code: number; msg: string } | null): void;
  invalidateCurrentTokens(): void;
  close(): Promise<void>;
}

async function startMockFeishuApiServer(options: {
  appId: string;
  appSecret: string;
  tokenTtlSec?: number;
}): Promise<MockFeishuApiServer> {
  let tokenCalls = 0;
  let tokenSeq = 0;
  let msgSeq = 0;
  let tokenTtlSec = options.tokenTtlSec ?? 7200;
  let sendError: { code: number; msg: string } | null = null;
  const activeTokens = new Set<string>();
  const issuedTokens: string[] = [];
  const sentCards: MockFeishuApiServer["sentCards"] = [];
  const patchedCards: MockFeishuApiServer["patchedCards"] = [];

  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("Content-Type", "application/json");

      if (
        req.method === "POST" &&
        url.pathname === "/open-apis/auth/v3/tenant_access_token/internal"
      ) {
        tokenCalls += 1;
        const body = await readJson(req);
        if (body.app_id !== options.appId || body.app_secret !== options.appSecret) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: 10014, msg: "invalid app_secret" }));
          return;
        }
        tokenSeq += 1;
        const token = `t-mocke2e_${tokenSeq}_${randomBytes(8).toString("hex")}`;
        activeTokens.add(token);
        issuedTokens.push(token);
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            code: 0,
            msg: "ok",
            tenant_access_token: token,
            expire: tokenTtlSec,
          }),
        );
        return;
      }

      const authHeader = String(req.headers.authorization ?? "");
      const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!activeTokens.has(bearer)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 99991663, msg: "tenant_access_token expired" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/open-apis/im/v1/messages") {
        if (sendError) {
          res.statusCode = 400;
          res.end(JSON.stringify(sendError));
          return;
        }
        const body = await readJson(req);
        msgSeq += 1;
        const messageId = `om_e2e_${msgSeq}`;
        sentCards.push({
          messageId,
          receiveIdType: url.searchParams.get("receive_id_type") ?? "",
          receiveId: String(body.receive_id ?? ""),
          card: JSON.parse(String(body.content ?? "{}")) as Record<string, unknown>,
          uuid: typeof body.uuid === "string" ? body.uuid : undefined,
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ code: 0, msg: "success", data: { message_id: messageId } }));
        return;
      }

      if (req.method === "PATCH" && url.pathname.startsWith("/open-apis/im/v1/messages/")) {
        const messageId = decodeURIComponent(
          url.pathname.slice("/open-apis/im/v1/messages/".length),
        );
        const body = await readJson(req);
        patchedCards.push({
          messageId,
          card: JSON.parse(String(body.content ?? "{}")) as Record<string, unknown>,
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ code: 0, msg: "success", data: {} }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ code: 404, msg: "not found" }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock Feishu server failed to bind TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get tokenCalls() {
      return tokenCalls;
    },
    issuedTokens,
    sentCards,
    patchedCards,
    setTokenTtlSeconds(sec: number) {
      tokenTtlSec = sec;
    },
    setSendError(err) {
      sendError = err;
    },
    invalidateCurrentTokens() {
      activeTokens.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function collectColumnButtons(
  columns: Array<{ elements?: Array<Record<string, unknown>> }>,
  out: Array<Record<string, unknown>>,
): void {
  for (const col of columns) {
    for (const item of col.elements ?? []) {
      if (item.tag === "button") out.push(item);
    }
  }
}

function findCardButtons(card: Record<string, unknown>): Array<Record<string, unknown>> {
  const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
  const buttons: Array<Record<string, unknown>> = [];
  for (const el of body?.elements ?? []) {
    if (el.tag === "column_set" && Array.isArray(el.columns)) {
      collectColumnButtons(
        el.columns as Array<{ elements?: Array<Record<string, unknown>> }>,
        buttons,
      );
    }
  }
  return buttons;
}

describe("Wave 6 (P2-1) Feishu Bot Bridge full-stack local Mock HTTP E2E", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0).toReversed()) {
      await fn();
    }
  });

  it("verifies daemon + built-in plugin RPCs, token cache/refresh, encrypted webhook challenge/security rejections, troubleshooting & full secret redaction", async () => {
    const dynamicSecret = `appsec_${randomBytes(12).toString("hex")}`;
    const dynamicVToken = `verif_${randomBytes(10).toString("hex")}`;
    const dynamicEncryptKey = `enckey_${randomBytes(12).toString("hex")}`;

    const mockFeishu = await startMockFeishuApiServer({
      appId: "cli_wave6_e2e",
      appSecret: dynamicSecret,
      tokenTtlSec: 3600,
    });
    cleanups.push(() => mockFeishu.close());

    const daemon = await createTestPaseoDaemon({
      daemonVersion: "0.17.0-beta.1",
      pluginsEnabled: false,
      builtinPlugins: new BuiltinPluginLoader(undefined, [FEISHU_BRIDGE_PLUGIN_ID]),
    });
    cleanups.push(() => daemon.close());

    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.17.0-beta.1",
    });
    cleanups.push(() => client.close());
    await client.connect();

    // 1. Default-off state: zero polling, zero outbound HTTP requests, plugin available
    const initialRes = await client.getMainChatFeishuBridgeState();
    expect(initialRes.error).toBeNull();
    expect(initialRes.state.pluginAvailable).toBe(true);
    expect(initialRes.state.pluginId).toBe(FEISHU_BRIDGE_PLUGIN_ID);
    expect(initialRes.state.active).toBe(false);
    expect(initialRes.state.config.enabled).toBe(false);
    expect(initialRes.state.webhookUrl).toBe(
      `http://127.0.0.1:${daemon.port}${FEISHU_BRIDGE_WEBHOOK_PATH}`,
    );
    expect(mockFeishu.tokenCalls).toBe(0);

    // Webhook returns 503 while disabled and unconfigured
    const disabledWebhookRes = await fetch(initialRes.state.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "blocked" }),
    });
    expect(disabledWebhookRes.status).toBe(503);

    // 2. Configure bridge via WS RPC (secrets stored masked, never returned in plaintext)
    const updateRes = await client.updateMainChatFeishuBridgeConfig({
      enabled: true,
      domainPreset: "custom",
      apiBaseUrl: mockFeishu.baseUrl,
      appId: "cli_wave6_e2e",
      appSecret: dynamicSecret,
      verificationToken: dynamicVToken,
      encryptKey: dynamicEncryptKey,
      receiveIdType: "chat_id",
      receiveId: "oc_wave6_chat",
      allowedOpenIds: ["ou_owner_wave6"],
      forwardTiers: ["critical", "actionable"],
      respectLowDistraction: true,
      requireSignature: true,
      replayWindowSeconds: 300,
    });
    expect(updateRes.error).toBeNull();
    expect(updateRes.state?.active).toBe(true);
    expect(updateRes.state?.config.hasAppSecret).toBe(true);
    expect(updateRes.state?.config.appSecretMask).toBe(`••••${dynamicSecret.slice(-4)}`);
    expect(updateRes.state?.config.hasVerificationToken).toBe(true);
    expect(updateRes.state?.config.hasEncryptKey).toBe(true);

    // 3. Connectivity test: first call fetches token, second call & test card reuse cached token
    const conn1 = await client.testMainChatFeishuBridgeConnection({ forceRefreshToken: false });
    expect(conn1.error).toBeNull();
    expect(conn1.result.ok).toBe(true);
    expect(conn1.result.cachedTokenReused).toBe(false);
    expect(conn1.result.tokenExpiresInSec).toBeGreaterThan(0);
    expect(mockFeishu.tokenCalls).toBe(1);

    const conn2 = await client.testMainChatFeishuBridgeConnection({ forceRefreshToken: false });
    expect(conn2.result.ok).toBe(true);
    expect(conn2.result.cachedTokenReused).toBe(true);
    expect(mockFeishu.tokenCalls).toBe(1);

    const card1 = await client.sendMainChatFeishuBridgeTestCard({ title: "Wave 6 E2E 测试卡" });
    expect(card1.error).toBeNull();
    expect(card1.result.ok).toBe(true);
    expect(card1.result.messageId).toBe("om_e2e_1");
    expect(mockFeishu.tokenCalls).toBe(1);
    expect(mockFeishu.sentCards).toHaveLength(1);

    // Invalidate token on mock server -> next send auto-refreshes expired token and succeeds
    mockFeishu.invalidateCurrentTokens();
    const card2 = await client.sendMainChatFeishuBridgeTestCard({ title: "自动刷新测试" });
    expect(card2.result.ok).toBe(true);
    expect(card2.result.messageId).toBe("om_e2e_2");
    expect(mockFeishu.tokenCalls).toBe(2);

    // 4. Real HTTP Webhook endpoint: encrypted url_verification + bad sig + replay + wrong token + unauthorized open_id
    const webhookUrl = initialRes.state.webhookUrl!;
    const nowSec = () => String(Math.floor(Date.now() / 1000));

    const plainChallenge = JSON.stringify({
      type: "url_verification",
      token: dynamicVToken,
      challenge: "challenge_wave6_e2e_ok",
    });
    const encBody = JSON.stringify({
      encrypt: encryptLarkPayload(plainChallenge, dynamicEncryptKey),
    });
    const validTs = nowSec();
    const validNonce = "e2e_nonce_1";
    const validSig = computeLarkSignature({
      timestamp: validTs,
      nonce: validNonce,
      encryptKey: dynamicEncryptKey,
      rawBody: encBody,
    });

    const challengeHttp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": validTs,
        "X-Lark-Request-Nonce": validNonce,
        "X-Lark-Signature": validSig,
      },
      body: encBody,
    });
    expect(challengeHttp.status).toBe(200);
    expect(await challengeHttp.json()).toEqual({ challenge: "challenge_wave6_e2e_ok" });

    // Bad signature -> 401
    const badSigHttp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": validTs,
        "X-Lark-Request-Nonce": validNonce,
        "X-Lark-Signature": "f".repeat(64),
      },
      body: encBody,
    });
    expect(badSigHttp.status).toBe(401);

    // Replay timestamp (10 min old) -> 401
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const oldSig = computeLarkSignature({
      timestamp: oldTs,
      nonce: "old_nonce",
      encryptKey: dynamicEncryptKey,
      rawBody: encBody,
    });
    const replayHttp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": oldTs,
        "X-Lark-Request-Nonce": "old_nonce",
        "X-Lark-Signature": oldSig,
      },
      body: encBody,
    });
    expect(replayHttp.status).toBe(401);

    // Wrong verification token -> 401
    const wrongTokBody = JSON.stringify({
      type: "url_verification",
      token: "wrong_token_value",
      challenge: "should_reject",
    });
    const wtTs = nowSec();
    const wtSig = computeLarkSignature({
      timestamp: wtTs,
      nonce: "n_wt",
      encryptKey: dynamicEncryptKey,
      rawBody: wrongTokBody,
    });
    const wrongTokHttp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": wtTs,
        "X-Lark-Request-Nonce": "n_wt",
        "X-Lark-Signature": wtSig,
      },
      body: wrongTokBody,
    });
    expect(wrongTokHttp.status).toBe(401);

    // Non-whitelisted sender -> 403
    const intruderBody = JSON.stringify({
      schema: "2.0",
      header: { event_id: "evt_intruder_1", token: dynamicVToken },
      event: {
        operator: { open_id: "ou_not_in_whitelist" },
        context: { open_message_id: "om_e2e_1" },
        action: {
          value: {
            a: "perm",
            decision: "allow",
            agent_id: "agent_x",
            request_id: "perm_x",
            action_id: "act_intruder_1",
          },
        },
      },
    });
    const intrTs = nowSec();
    const intrSig = computeLarkSignature({
      timestamp: intrTs,
      nonce: "n_intr",
      encryptKey: dynamicEncryptKey,
      rawBody: intruderBody,
    });
    const intrHttp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": intrTs,
        "X-Lark-Request-Nonce": "n_intr",
        "X-Lark-Signature": intrSig,
      },
      body: intruderBody,
    });
    expect(intrHttp.status).toBe(403);

    // Empty allowedOpenIds fail-closed guard -> 403 whitelist_empty
    await client.updateMainChatFeishuBridgeConfig({ allowedOpenIds: [] });
    const emptyWlBody = JSON.stringify({
      schema: "2.0",
      header: { event_id: "evt_empty_wl", token: dynamicVToken },
      event: {
        operator: { open_id: "ou_owner_wave6" },
        context: { open_message_id: "om_e2e_1" },
        action: {
          value: {
            a: "perm",
            decision: "allow",
            agent_id: "agent_x",
            request_id: "perm_x",
            action_id: "act_empty_wl",
          },
        },
      },
    });
    const ewTs = nowSec();
    const ewSig = computeLarkSignature({
      timestamp: ewTs,
      nonce: "n_ew",
      encryptKey: dynamicEncryptKey,
      rawBody: emptyWlBody,
    });
    const emptyWlHttp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": ewTs,
        "X-Lark-Request-Nonce": "n_ew",
        "X-Lark-Signature": ewSig,
      },
      body: emptyWlBody,
    });
    expect(emptyWlHttp.status).toBe(403);
    expect((await emptyWlHttp.json()).code).toBe("whitelist_empty");
    await client.updateMainChatFeishuBridgeConfig({ allowedOpenIds: ["ou_owner_wave6"] });

    // 5. Failure troubleshooting paths (bot not in chat + wrong secret)
    mockFeishu.setSendError({ code: 230002, msg: "bot is not in chat" });
    const sendFail = await client.sendMainChatFeishuBridgeTestCard();
    expect(sendFail.result.ok).toBe(false);
    expect(sendFail.result.errorCode).toBe("feishu_230002");
    expect(sendFail.result.troubleshootingHint).toContain("未加入目标群聊");
    mockFeishu.setSendError(null);

    const wrongSecret = `wrong_${randomBytes(10).toString("hex")}`;
    await client.updateMainChatFeishuBridgeConfig({ appSecret: wrongSecret });
    const connFail = await client.testMainChatFeishuBridgeConnection({ forceRefreshToken: true });
    expect(connFail.result.ok).toBe(false);
    expect(connFail.result.errorCode).toBe("feishu_10014");
    expect(connFail.result.troubleshootingHint).toContain("App ID");

    // 6. Full secret redaction audit across RPCs, audit ledger, and plugin logs
    const finalState = await client.getMainChatFeishuBridgeState({ auditLimit: 50 });
    const auditRes = await client.listMainChatFeishuBridgeAudit({ limit: 50 });
    const pluginLogs = await client.getPluginLogs(FEISHU_BRIDGE_PLUGIN_ID);
    const daemonLogPath = path.join(daemon.paseoHome, "daemon.log");
    const daemonLogText = await readFile(daemonLogPath, "utf8").catch(() => "");

    const combinedText = [
      JSON.stringify(updateRes),
      JSON.stringify(conn1),
      JSON.stringify(connFail),
      JSON.stringify(card1),
      JSON.stringify(sendFail),
      JSON.stringify(finalState),
      JSON.stringify(auditRes),
      JSON.stringify(pluginLogs),
      daemonLogText,
    ].join("\n");

    for (const secret of [
      dynamicSecret,
      wrongSecret,
      dynamicVToken,
      dynamicEncryptKey,
      ...mockFeishu.issuedTokens,
    ]) {
      expect(combinedText).not.toContain(secret);
    }
  }, 60_000);

  it("pushes permission & decision cards, handles signed callbacks with card PATCH & idempotency, enforces Conservative Mode A, and filters low-distraction receipts", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-wave6-service-"));
    const paseoHome = path.join(tmpRoot, "paseo-home");
    const repoDir = path.join(tmpRoot, "repo");
    await mkdir(paseoHome, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    cleanups.push(() => rm(tmpRoot, { recursive: true, force: true }));

    const dynamicSecret = `svcsec_${randomBytes(12).toString("hex")}`;
    const dynamicVToken = `svcvtok_${randomBytes(10).toString("hex")}`;
    const dynamicEncryptKey = `svcenc_${randomBytes(12).toString("hex")}`;

    const mockFeishu = await startMockFeishuApiServer({
      appId: "cli_wave6_svc",
      appSecret: dynamicSecret,
    });
    cleanups.push(() => mockFeishu.close());

    // Start real built-in `feishu-bot-bridge` plugin via PluginService
    const silentLogger = pino({ level: "silent" });
    const configStore = new DaemonConfigStore(paseoHome, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      pluginsEnabled: false,
      plugins: {},
    });
    const pluginService = new PluginService(silentLogger, configStore, "0.17.0-beta.1", {
      builtinPlugins: new BuiltinPluginLoader(undefined, [FEISHU_BRIDGE_PLUGIN_ID]),
      settingsDirectory: path.join(paseoHome, "plugin-settings"),
    });
    // Minimal session host handshake so InternalPluginChild completes daemonClient.connect()
    pluginService.bindPaseoSessionHost({
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data) as { type?: string };
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "wave6-test-host",
                  hostname: "wave6-test-host",
                  version: "0.17.0-beta.1",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    });
    await pluginService.start();
    cleanups.push(() => pluginService.stopAllPlugins());

    // Build MainChatService with managed child agent + unmanaged manual session
    const subscribers = new Set<(event: AgentManagerEvent) => void>();
    const agents = new Map<string, ManagedAgent>();
    const storedRecords = new Map<string, PersistedAgentRecord>();
    const timelines = new Map<string, AgentTimelineItem[]>();
    const workspaces = new Map<string, PersistedWorkspaceRecord>();
    const sentPrompts: Array<{ agentId: string; prompt: unknown }> = [];
    const permissionResponses: Array<{
      agentId: string;
      requestId: string;
      response: AgentPermissionResponse;
    }> = [];

    const now = new Date();
    const makeAgent = (id: string, title: string, labels: Record<string, string>): ManagedAgent => {
      const pendingPermissions = new Map<string, AgentPermissionRequest>();
      return {
        id,
        provider: "claude" as ManagedAgent["provider"],
        cwd: repoDir,
        workspaceId: "ws_repo",
        lifecycle: "idle",
        config: { provider: "claude", cwd: repoDir, title },
        labels,
        pendingPermissions,
        runtimeInfo: { provider: "claude", sessionId: `sess_${id}`, model: "claude-sonnet-4-6" },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        requiresAttention: false,
        attentionReason: null,
        internal: false,
        background: false,
        usage: null,
      } as unknown as ManagedAgent;
    };

    const mainAgent = makeAgent("agent_main", "总控管家", {
      [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
    });
    const managedChild = makeAgent("agent_managed_child", "API 修复子任务", {
      [PARENT_AGENT_ID_LABEL]: "agent_main",
      [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_1",
      [MAIN_CHAT_TASK_ID_LABEL]: "pt_1",
      [MAIN_CHAT_TASK_MODE_LABEL]: "write",
    });
    const manualUserAgent = makeAgent("agent_manual_user", "用户手动会话", {});

    for (const agent of [mainAgent, managedChild, manualUserAgent]) {
      agents.set(agent.id, agent);
      storedRecords.set(agent.id, {
        agentId: agent.id,
        provider: "claude",
        cwd: repoDir,
        workspaceId: "ws_repo",
        title: agent.config.title,
        labels: agent.labels,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
      } as unknown as PersistedAgentRecord);
      timelines.set(agent.id, []);
    }

    const agentManager = {
      subscribe: (cb: (event: AgentManagerEvent) => void) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      getAgent: (id: string) => agents.get(id) ?? null,
      listAgents: () => [...agents.values()],
      getTimeline: (id: string) => timelines.get(id) ?? [],
      hasInFlightRun: () => false,
      tryRunOutOfBand: () => false,
      reloadAgentSession: async () => undefined,
      reloadStalePluginSession: async () => undefined,
      replaceAgentRun: async () => undefined,
      steerOrReplaceActiveTurn: async () => ({ status: "not_running" as const }),
      streamAgent: async function* (agentId: string, prompt: unknown) {
        sentPrompts.push({ agentId, prompt });
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      },
      sendPrompt: vi.fn(async (agentId: string, prompt: unknown) => {
        sentPrompts.push({ agentId, prompt });
      }),
      respondToPermission: vi.fn(
        async (agentId: string, requestId: string, response: AgentPermissionResponse) => {
          permissionResponses.push({ agentId, requestId, response });
          const target = agents.get(agentId);
          target?.pendingPermissions.delete(requestId);
          for (const sub of subscribers) {
            sub({
              type: "agent_stream",
              agentId,
              event: {
                type: "permission_resolved",
                requestId,
                resolution: response,
              },
            } as unknown as AgentManagerEvent);
          }
        },
      ),
    } as unknown as AgentManager;

    const agentStorage = {
      get: async (id: string) => storedRecords.get(id) ?? null,
      list: async () => [...storedRecords.values()],
      save: async (rec: PersistedAgentRecord) => {
        storedRecords.set(rec.agentId, rec);
      },
    } as unknown as AgentStorage;

    const workspaceRegistry = {
      get: async (id: string) => workspaces.get(id) ?? null,
      listActive: async () => [...workspaces.values()],
    } as unknown as WorkspaceRegistry;

    const service = createMainChatService({
      paseoHome,
      serverId: "srv_local",
      hostLabel: "DevBox-Test",
      agentManager,
      agentStorage,
      providerSnapshotManager: { listProviders: () => [] } as unknown as ProviderSnapshotManager,
      workspaceRegistry,
      createDirectoryWorkspace: async (cwd: string, title?: string | null) => {
        const rec = {
          workspaceId: "ws_main",
          cwd,
          title: title ?? "main-chat",
        } as unknown as PersistedWorkspaceRecord;
        workspaces.set(rec.workspaceId, rec);
        return rec;
      },
      feishuPluginInvoker: pluginService,
      resolveFeishuWebhookUrl: () => `http://127.0.0.1:6768${FEISHU_BRIDGE_WEBHOOK_PATH}`,
      logger: silentLogger,
    });

    await service.start();
    cleanups.push(async () => service.stop());

    // Enable main chat in Conservative Mode A & enable Feishu bridge
    await service.updateSettings({ enabled: true, style: "conservative" });
    await service.updateFeishuBridgeConfig({
      enabled: true,
      domainPreset: "custom",
      apiBaseUrl: mockFeishu.baseUrl,
      appId: "cli_wave6_svc",
      appSecret: dynamicSecret,
      verificationToken: dynamicVToken,
      encryptKey: dynamicEncryptKey,
      receiveIdType: "chat_id",
      receiveId: "oc_wave6_svc_chat",
      allowedOpenIds: ["ou_owner_main"],
      forwardTiers: ["critical", "actionable"],
      respectLowDistraction: true,
      requireSignature: true,
    });

    // Helper to sign a webhook callback
    const signAndSendWebhook = async (payloadObj: Record<string, unknown>) => {
      const rawBody = JSON.stringify(payloadObj);
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(6).toString("hex");
      const signature = computeLarkSignature({
        timestamp: ts,
        nonce,
        encryptKey: dynamicEncryptKey,
        rawBody,
      });
      return service.handleFeishuWebhook({
        rawBody,
        headers: { timestamp: ts, nonce, signature },
      });
    };

    // === Flow A: Permission approval card push -> signed Feishu click -> approve + card PATCH + dedupe ===
    const permReq: AgentPermissionRequest = {
      id: "perm_wave6_001",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run database migration check",
      description: "Verify pending schema migrations",
      input: { command: "npm run db:check" },
    };
    managedChild.pendingPermissions.set(permReq.id, permReq);
    for (const sub of subscribers) {
      sub({
        type: "agent_stream",
        agentId: managedChild.id,
        event: { type: "permission_requested", request: permReq },
      } as unknown as AgentManagerEvent);
    }

    await expect.poll(() => mockFeishu.sentCards.length).toBe(1);
    const permCardRecord = mockFeishu.sentCards[0]!;
    expect(permCardRecord.card.schema).toBe("2.0");
    const permButtons = findCardButtons(permCardRecord.card);
    expect(permButtons).toHaveLength(2);

    const allowBtnBehavior = (
      permButtons[0]!.behaviors as Array<{ value: Record<string, string> }>
    )[0]!;
    expect(allowBtnBehavior.value.a).toBe("perm");
    expect(allowBtnBehavior.value.decision).toBe("allow");

    // Click Approve button from whitelisted operator
    const permCallbackPayload = {
      schema: "2.0",
      header: { event_id: "evt_perm_allow_1", token: dynamicVToken },
      event: {
        operator: { open_id: "ou_owner_main" },
        context: { open_message_id: permCardRecord.messageId },
        action: { value: allowBtnBehavior.value },
      },
    };
    const permCallbackRes = await signAndSendWebhook(permCallbackPayload);
    expect(permCallbackRes.httpStatus).toBe(200);
    expect(permissionResponses).toHaveLength(1);
    expect(permissionResponses[0]).toEqual({
      agentId: managedChild.id,
      requestId: permReq.id,
      response: { behavior: "allow" },
    });
    expect(mockFeishu.patchedCards.some((p) => p.messageId === permCardRecord.messageId)).toBe(
      true,
    );

    // Duplicate click with same action_id -> idempotent dedupe (permissionResponses stays 1!)
    const dupPermRes = await signAndSendWebhook(permCallbackPayload);
    expect(dupPermRes.httpStatus).toBe(200);
    expect(permissionResponses).toHaveLength(1);

    // === Flow B: Decision card push -> signed click -> answerDecision + card PATCH ===
    await service.askUserDecision("agent_main", {
      title: "缓存失效策略选择",
      question: "请选择发布前的缓存清理策略？",
      agentId: managedChild.id,
      options: [
        { id: "opt_a", label: "渐进双写切换", leadsTo: "零停机但需额外 10 分钟观测" },
        { id: "opt_b", label: "维护窗口全量刷新", leadsTo: "实现最简单，短时延迟升高" },
      ],
      recommendedOptionId: "opt_a",
      reason: "涉及核心读链路",
    });

    await expect.poll(() => mockFeishu.sentCards.length).toBe(2);
    const decisionCardRecord = mockFeishu.sentCards[1]!;
    const decisionButtons = findCardButtons(decisionCardRecord.card);
    expect(decisionButtons).toHaveLength(2);
    const opt2Behavior = (
      decisionButtons[1]!.behaviors as Array<{ value: Record<string, string> }>
    )[0]!;
    expect(opt2Behavior.value.a).toBe("decide");
    expect(opt2Behavior.value.option_id).toBe("opt_b");

    const decisionCallbackRes = await signAndSendWebhook({
      schema: "2.0",
      header: { event_id: "evt_dec_opt_b", token: dynamicVToken },
      event: {
        operator: { open_id: "ou_owner_main" },
        context: { open_message_id: decisionCardRecord.messageId },
        action: { value: opt2Behavior.value },
      },
    });
    expect(decisionCallbackRes.httpStatus).toBe(200);
    expect(
      sentPrompts.some(
        (entry) =>
          entry.agentId === managedChild.id && String(entry.prompt).includes("维护窗口全量刷新"),
      ),
    ).toBe(true);
    expect(mockFeishu.patchedCards.some((p) => p.messageId === decisionCardRecord.messageId)).toBe(
      true,
    );

    // === Flow C: Conservative Mode A strictly blocks commands/decisions targeting user's manual session ===
    const manualDecision = await service.askUserDecision("agent_main", {
      title: "手动会话测试决策",
      question: "是否执行手动会话命令？",
      agentId: manualUserAgent.id,
      options: [
        { id: "run", label: "立即执行", leadsTo: "会向手动会话发指令" },
        { id: "skip", label: "暂不执行", leadsTo: "保持原状" },
      ],
    });
    const promptCountBeforeManual = sentPrompts.length;
    const manualBlockedRes = await signAndSendWebhook({
      schema: "2.0",
      header: { event_id: "evt_manual_blocked", token: dynamicVToken },
      event: {
        operator: { open_id: "ou_owner_main" },
        context: { open_message_id: "om_manual_fake" },
        action: {
          value: {
            a: "decide",
            decision_id: manualDecision.id,
            option_id: "run",
            answer: "立即执行",
            action_id: `decide:${manualDecision.id}:run`,
          },
        },
      },
    });
    expect(manualBlockedRes.httpStatus).toBe(403);
    expect(manualBlockedRes.body.code).toBe("conservative_mode_blocked");
    // ZERO prompts sent to user's manual session!
    expect(sentPrompts.length).toBe(promptCountBeforeManual);
    expect(sentPrompts.some((entry) => entry.agentId === manualUserAgent.id)).toBe(false);

    // === Flow D: Session RPC dispatcher returns redacted state & audit ===
    const outboundMessages: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      service,
      {
        type: "main_chat.feishu_bridge_list_audit.request",
        requestId: "req_audit_1",
        limit: 30,
      } as MainChatSessionMessage,
      (msg) => outboundMessages.push(msg),
    );
    expect(outboundMessages).toHaveLength(1);
    const auditReply = outboundMessages[0]!;
    expect(auditReply.type).toBe("main_chat.feishu_bridge_list_audit.response");
    const serializedReply = JSON.stringify(auditReply);
    expect(serializedReply).not.toContain(dynamicSecret);
    expect(serializedReply).not.toContain(dynamicVToken);
    expect(serializedReply).not.toContain(dynamicEncryptKey);
  }, 60_000);

  it("syncs active flag when feishu.update_config is invoked directly via PluginService RPC and unsubscribes on service.stop()", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-wave6-direct-rpc-"));
    const paseoHome = path.join(tmpRoot, "paseo-home");
    const repoDir = path.join(tmpRoot, "repo");
    await mkdir(paseoHome, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    cleanups.push(() => rm(tmpRoot, { recursive: true, force: true }));

    const dynamicSecret = `dirsec_${randomBytes(12).toString("hex")}`;
    const mockFeishu = await startMockFeishuApiServer({
      appId: "cli_wave6_direct",
      appSecret: dynamicSecret,
    });
    cleanups.push(() => mockFeishu.close());

    const silentLogger = pino({ level: "silent" });
    const configStore = new DaemonConfigStore(paseoHome, {
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
      pluginsEnabled: false,
      plugins: {},
    });
    const pluginService = new PluginService(silentLogger, configStore, "0.17.0-beta.1", {
      builtinPlugins: new BuiltinPluginLoader(undefined, [FEISHU_BRIDGE_PLUGIN_ID]),
      settingsDirectory: path.join(paseoHome, "plugin-settings"),
    });
    pluginService.bindPaseoSessionHost({
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data) as { type?: string };
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "wave6-direct-rpc-host",
                  hostname: "wave6-direct-rpc-host",
                  version: "0.17.0-beta.1",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    });
    await pluginService.start();
    cleanups.push(() => pluginService.stopAllPlugins());

    // 1. Verify PluginService.onPluginRpcCompleted broadcasts { pluginId, method, result },
    //    isolates listener exceptions, and does not fire when an RPC rejects.
    const observedEvents: PluginRpcCompletedEvent[] = [];
    const unsubscribeThrowing = pluginService.onPluginRpcCompleted(() => {
      throw new Error("observer failure must not break RPC caller");
    });
    const unsubscribeObserver = pluginService.onPluginRpcCompleted((event) => {
      observedEvents.push(event);
    });
    const initialPluginState = (await pluginService.invokePluginRpc(
      FEISHU_BRIDGE_PLUGIN_ID,
      "feishu.get_state",
      { auditLimit: 1 },
    )) as { active: boolean };
    expect(initialPluginState.active).toBe(false);
    expect(observedEvents).toHaveLength(1);
    expect(observedEvents[0]).toMatchObject({
      pluginId: FEISHU_BRIDGE_PLUGIN_ID,
      method: "feishu.get_state",
      result: { active: false },
    });
    await expect(
      pluginService.invokePluginRpc("nonexistent-plugin-id", "unknown.method", {}),
    ).rejects.toThrow();
    expect(observedEvents).toHaveLength(1);
    unsubscribeThrowing();
    unsubscribeObserver();

    // Track listener registration/unregistration and dispatch_event invocations on pluginService
    let registeredListeners = 0;
    let unsubscribeCalls = 0;
    let dispatchEventCalls = 0;
    const origOnRpcCompleted = pluginService.onPluginRpcCompleted.bind(pluginService);
    const origInvokeRpc = pluginService.invokePluginRpc.bind(pluginService);
    vi.spyOn(pluginService, "onPluginRpcCompleted").mockImplementation((listener) => {
      registeredListeners += 1;
      const unsub = origOnRpcCompleted(listener);
      let unsubscribed = false;
      return () => {
        if (!unsubscribed) {
          unsubscribed = true;
          registeredListeners -= 1;
          unsubscribeCalls += 1;
        }
        unsub();
      };
    });
    vi.spyOn(pluginService, "invokePluginRpc").mockImplementation((pluginId, method, input) => {
      if (pluginId === FEISHU_BRIDGE_PLUGIN_ID && method === "feishu.dispatch_event") {
        dispatchEventCalls += 1;
      }
      return origInvokeRpc(pluginId, method, input);
    });

    // Build MainChatService with one managed child agent
    const subscribers = new Set<(event: AgentManagerEvent) => void>();
    const agents = new Map<string, ManagedAgent>();
    const storedRecords = new Map<string, PersistedAgentRecord>();
    const workspaces = new Map<string, PersistedWorkspaceRecord>();
    const now = new Date();
    const makeAgent = (id: string, title: string, labels: Record<string, string>): ManagedAgent =>
      ({
        id,
        provider: "claude" as ManagedAgent["provider"],
        cwd: repoDir,
        workspaceId: "ws_repo",
        lifecycle: "idle",
        config: { provider: "claude", cwd: repoDir, title },
        labels,
        pendingPermissions: new Map<string, AgentPermissionRequest>(),
        runtimeInfo: { provider: "claude", sessionId: `sess_${id}`, model: "claude-sonnet-4-6" },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        requiresAttention: false,
        attentionReason: null,
        internal: false,
        background: false,
        usage: null,
      }) as unknown as ManagedAgent;

    const mainAgent = makeAgent("agent_main", "总控管家", {
      [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
    });
    const managedChild = makeAgent("agent_managed_direct", "直连 RPC 同步验证子任务", {
      [PARENT_AGENT_ID_LABEL]: "agent_main",
      [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_direct",
      [MAIN_CHAT_TASK_ID_LABEL]: "pt_direct",
      [MAIN_CHAT_TASK_MODE_LABEL]: "write",
    });
    for (const agent of [mainAgent, managedChild]) {
      agents.set(agent.id, agent);
      storedRecords.set(agent.id, {
        agentId: agent.id,
        provider: "claude",
        cwd: repoDir,
        workspaceId: "ws_repo",
        title: agent.config.title,
        labels: agent.labels,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
      } as unknown as PersistedAgentRecord);
    }

    const agentManager = {
      subscribe: (cb: (event: AgentManagerEvent) => void) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      getAgent: (id: string) => agents.get(id) ?? null,
      listAgents: () => [...agents.values()],
      getTimeline: () => [],
      hasInFlightRun: () => false,
      tryRunOutOfBand: () => false,
      reloadAgentSession: async () => undefined,
      reloadStalePluginSession: async () => undefined,
      replaceAgentRun: async () => undefined,
      steerOrReplaceActiveTurn: async () => ({ status: "not_running" as const }),
      streamAgent: async function* () {
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      },
      sendPrompt: vi.fn(async () => undefined),
      respondToPermission: vi.fn(async () => undefined),
    } as unknown as AgentManager;

    const service = createMainChatService({
      paseoHome,
      serverId: "srv_direct",
      hostLabel: "DevBox-Direct-RPC",
      agentManager,
      agentStorage: {
        get: async (id: string) => storedRecords.get(id) ?? null,
        list: async () => [...storedRecords.values()],
        save: async (rec: PersistedAgentRecord) => {
          storedRecords.set(rec.agentId, rec);
        },
      } as unknown as AgentStorage,
      providerSnapshotManager: { listProviders: () => [] } as unknown as ProviderSnapshotManager,
      workspaceRegistry: {
        get: async (id: string) => workspaces.get(id) ?? null,
        listActive: async () => [...workspaces.values()],
      } as unknown as WorkspaceRegistry,
      createDirectoryWorkspace: async (cwd: string, title?: string | null) => {
        const rec = {
          workspaceId: "ws_direct",
          cwd,
          title: title ?? "main-chat",
        } as unknown as PersistedWorkspaceRecord;
        workspaces.set(rec.workspaceId, rec);
        return rec;
      },
      feishuPluginInvoker: pluginService,
      resolveFeishuWebhookUrl: () => `http://127.0.0.1:6768${FEISHU_BRIDGE_WEBHOOK_PATH}`,
      logger: silentLogger,
    });

    await service.start();
    let serviceStopped = false;
    cleanups.push(async () => {
      if (!serviceStopped) service.stop();
    });
    await service.updateSettings({ enabled: true, style: "conservative" });
    expect(registeredListeners).toBe(1);

    const emitPermissionRequest = (requestId: string) => {
      const permReq: AgentPermissionRequest = {
        id: requestId,
        provider: "claude",
        name: "Bash",
        kind: "tool",
        title: `Run check ${requestId}`,
        description: "Verify direct plugin RPC active sync",
        input: { command: "echo ok" },
      };
      managedChild.pendingPermissions.set(permReq.id, permReq);
      for (const sub of subscribers) {
        sub({
          type: "agent_stream",
          agentId: managedChild.id,
          event: { type: "permission_requested", request: permReq },
        } as unknown as AgentManagerEvent);
      }
    };

    // 2. Initially inactive: permission event early-returns with ZERO feishu.dispatch_event calls
    emitPermissionRequest("perm_before_enable");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(dispatchEventCalls).toBe(0);
    expect(mockFeishu.sentCards).toHaveLength(0);

    // 3. Direct plugin RPC enables bridge WITHOUT credentials yet -> active stays false
    const partialState = (await pluginService.invokePluginRpc(
      FEISHU_BRIDGE_PLUGIN_ID,
      "feishu.update_config",
      { patch: { enabled: true } },
    )) as { active: boolean };
    expect(partialState.active).toBe(false);
    emitPermissionRequest("perm_partial_config");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(dispatchEventCalls).toBe(0);
    expect(mockFeishu.sentCards).toHaveLength(0);

    // 4. Direct plugin RPC configures credentials & target (like bridge-settings-screen.tsx)
    //    WITHOUT calling service.updateFeishuBridgeConfig() -> active syncs to true immediately!
    const enabledState = (await pluginService.invokePluginRpc(
      FEISHU_BRIDGE_PLUGIN_ID,
      "feishu.update_config",
      {
        patch: {
          enabled: true,
          domainPreset: "custom",
          apiBaseUrl: mockFeishu.baseUrl,
          appId: "cli_wave6_direct",
          appSecret: dynamicSecret,
          receiveIdType: "chat_id",
          receiveId: "oc_wave6_direct_chat",
          allowedOpenIds: ["ou_direct_owner"],
          forwardTiers: ["critical", "actionable"],
          respectLowDistraction: true,
        },
      },
    )) as { active: boolean };
    expect(enabledState.active).toBe(true);

    emitPermissionRequest("perm_after_direct_enable");
    await expect.poll(() => mockFeishu.sentCards.length).toBe(1);
    expect(dispatchEventCalls).toBeGreaterThanOrEqual(1);

    // 5. Direct plugin RPC disables bridge -> active syncs to false immediately,
    //    so subsequent events early-return with ZERO new feishu.dispatch_event calls.
    const disabledState = (await pluginService.invokePluginRpc(
      FEISHU_BRIDGE_PLUGIN_ID,
      "feishu.update_config",
      { patch: { enabled: false } },
    )) as { active: boolean };
    expect(disabledState.active).toBe(false);

    const dispatchCallsBeforeDisable = dispatchEventCalls;
    emitPermissionRequest("perm_after_direct_disable");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(dispatchEventCalls).toBe(dispatchCallsBeforeDisable);
    expect(mockFeishu.sentCards).toHaveLength(1);

    // 6. Calling service.stop() unsubscribes from PluginService.onPluginRpcCompleted cleanly
    service.stop();
    serviceStopped = true;
    expect(registeredListeners).toBe(0);
    expect(unsubscribeCalls).toBe(1);

    // Idempotent second stop() and subsequent direct RPCs stay error-free
    service.stop();
    expect(unsubscribeCalls).toBe(1);
    const postStopState = (await pluginService.invokePluginRpc(
      FEISHU_BRIDGE_PLUGIN_ID,
      "feishu.update_config",
      { patch: { enabled: true } },
    )) as { active: boolean };
    expect(postStopState.active).toBe(true);
  }, 60_000);

  it("ignores non-matching plugin RPC events and stops syncing active after seam.stop()", () => {
    const listeners = new Set<(event: FeishuBridgePluginRpcCompletedEvent) => void>();
    const emitCompleted = (event: FeishuBridgePluginRpcCompletedEvent) => {
      for (const listener of listeners) listener(event);
    };

    const seam = createFeishuBridgeSeam({
      pluginInvoker: {
        invokePluginRpc: vi.fn(async () => ({})),
        onPluginRpcCompleted: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      getSettings: () => createDefaultMainChatSettings(),
      isManagedAgent: () => false,
      hasPendingPermission: async () => false,
      respondToPermission: async () => undefined,
      getDecision: async () => null,
      answerDecision: async () => {
        throw new Error("unused");
      },
      logger: pino({ level: "silent" }),
    });

    expect(seam.isActive()).toBe(false);
    expect(listeners.size).toBe(1);

    // Other plugins and other methods must NOT affect cached active state
    emitCompleted({
      pluginId: "other-plugin",
      method: "feishu.update_config",
      result: { active: true },
    });
    emitCompleted({
      pluginId: FEISHU_BRIDGE_PLUGIN_ID,
      method: "feishu.get_state",
      result: { active: true },
    });
    emitCompleted({
      pluginId: FEISHU_BRIDGE_PLUGIN_ID,
      method: "feishu.update_config",
      result: null,
    });
    expect(seam.isActive()).toBe(false);

    // Matching feishu.update_config updates active both ways
    emitCompleted({
      pluginId: FEISHU_BRIDGE_PLUGIN_ID,
      method: "feishu.update_config",
      result: { active: true },
    });
    expect(seam.isActive()).toBe(true);

    emitCompleted({
      pluginId: FEISHU_BRIDGE_PLUGIN_ID,
      method: "feishu.update_config",
      result: { active: false },
    });
    expect(seam.isActive()).toBe(false);

    // After seam.stop(), listener is detached and subsequent broadcasts no longer mutate active
    seam.stop();
    expect(listeners.size).toBe(0);
    emitCompleted({
      pluginId: FEISHU_BRIDGE_PLUGIN_ID,
      method: "feishu.update_config",
      result: { active: true },
    });
    expect(seam.isActive()).toBe(false);
  });
});
