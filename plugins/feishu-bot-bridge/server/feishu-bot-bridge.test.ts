import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FeishuBridgeEngine } from "./bridge-engine.js";
import { maskSecret, redactSecretsFromText } from "./redaction.js";
import { computeFeishuSignature, decryptFeishuBody } from "./webhook-security.js";

function encryptFeishuPayloadForTest(plaintextJson: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([iv, cipher.update(plaintextJson, "utf8"), cipher.final()]);
  return encrypted.toString("base64");
}

interface MockFeishuServerHandle {
  baseUrl: string;
  tokenCalls: number;
  sentMessages: Array<{
    receiveIdType: string;
    receiveId: string;
    msgType: string;
    card: Record<string, unknown>;
    authHeader: string;
  }>;
  patchedMessages: Array<{
    messageId: string;
    card: Record<string, unknown>;
    authHeader: string;
  }>;
  setTokenTtlSeconds(ttl: number): void;
  setExpectedSecret(secret: string): void;
  setSendError(error: { code: number; msg: string } | null): void;
  close(): Promise<void>;
}

async function startMockFeishuServer(options: {
  expectedAppId: string;
  expectedAppSecret: string;
  tokenTtlSec?: number;
}): Promise<MockFeishuServerHandle> {
  let tokenCalls = 0;
  let tokenCounter = 0;
  let msgCounter = 0;
  let tokenTtlSec = options.tokenTtlSec ?? 7200;
  let expectedSecret = options.expectedAppSecret;
  let sendError: { code: number; msg: string } | null = null;
  const activeTokens = new Set<string>();
  const sentMessages: MockFeishuServerHandle["sentMessages"] = [];
  const patchedMessages: MockFeishuServerHandle["patchedMessages"] = [];

  const readJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch (error) {
          reject(error);
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
        const body = await readJsonBody(req);
        if (body.app_id !== options.expectedAppId || body.app_secret !== expectedSecret) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: 10014, msg: "invalid app_secret" }));
          return;
        }
        tokenCounter += 1;
        const issued = `t-mocktoken_${tokenCounter}_${randomBytes(6).toString("hex")}`;
        activeTokens.add(issued);
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            code: 0,
            msg: "ok",
            tenant_access_token: issued,
            expire: tokenTtlSec,
          }),
        );
        return;
      }

      const authHeader = String(req.headers.authorization ?? "");
      const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
      if (!activeTokens.has(bearer)) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: 99991663, msg: "invalid tenant_access_token" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/open-apis/im/v1/messages") {
        if (sendError) {
          res.statusCode = 400;
          res.end(JSON.stringify(sendError));
          return;
        }
        const body = await readJsonBody(req);
        msgCounter += 1;
        const messageId = `om_mock_${msgCounter}`;
        sentMessages.push({
          receiveIdType: url.searchParams.get("receive_id_type") ?? "",
          receiveId: String(body.receive_id ?? ""),
          msgType: String(body.msg_type ?? ""),
          card: JSON.parse(String(body.content ?? "{}")) as Record<string, unknown>,
          authHeader,
        });
        res.statusCode = 200;
        res.end(JSON.stringify({ code: 0, msg: "success", data: { message_id: messageId } }));
        return;
      }

      if (req.method === "PATCH" && url.pathname.startsWith("/open-apis/im/v1/messages/")) {
        const messageId = decodeURIComponent(
          url.pathname.slice("/open-apis/im/v1/messages/".length),
        );
        const body = await readJsonBody(req);
        patchedMessages.push({
          messageId,
          card: JSON.parse(String(body.content ?? "{}")) as Record<string, unknown>,
          authHeader,
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
    throw new Error("Mock server did not bind to TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get tokenCalls() {
      return tokenCalls;
    },
    sentMessages,
    patchedMessages,
    setTokenTtlSeconds(ttl: number) {
      tokenTtlSec = ttl;
    },
    setExpectedSecret(secret: string) {
      expectedSecret = secret;
    },
    setSendError(err) {
      sendError = err;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("feishu-bot-bridge plugin engine", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  });

  it("masks secrets strictly, keeps zero traffic when disabled, and refreshes expired tenant tokens", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-feishu-plugin-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));

    const dynamicSecret = `sec_${randomBytes(12).toString("hex")}`;
    const dynamicVToken = `vtok_${randomBytes(10).toString("hex")}`;
    const dynamicEncKey = `ekey_${randomBytes(10).toString("hex")}`;

    expect(maskSecret("ab")).toBe("••••");
    expect(maskSecret("12345678")).toBe("••••78");
    expect(maskSecret(dynamicSecret)).toBe(`••••${dynamicSecret.slice(-4)}`);
    expect(
      redactSecretsFromText(`err ${dynamicSecret} Bearer t-secret1234567890`, [dynamicSecret]),
    ).toBe("err [REDACTED] Bearer [REDACTED]");

    let clockMs = 1_760_000_000_000;
    const mockServer = await startMockFeishuServer({
      expectedAppId: "cli_mock_app",
      expectedAppSecret: dynamicSecret,
      tokenTtlSec: 10,
    });
    cleanups.push(() => mockServer.close());

    const engine = new FeishuBridgeEngine({
      dataDirectory: dir,
      nowMs: () => clockMs,
    });

    // Disabled by default -> zero token calls and dispatch is filtered
    const initial = await engine.getState();
    expect(initial.active).toBe(false);
    const noopDispatch = await engine.dispatchEvent({
      kind: "permission_requested",
      agentId: "agent_1",
      requestId: "req_1",
      title: "Build task",
      toolName: "Bash",
      managed: true,
      isRedLine: false,
    });
    expect(noopDispatch.dispatched).toBe(false);
    expect(mockServer.tokenCalls).toBe(0);

    // Configure with dynamic secrets and custom local mock URL
    const updated = await engine.updateConfig({
      enabled: true,
      domainPreset: "custom",
      apiBaseUrl: mockServer.baseUrl,
      appId: "cli_mock_app",
      appSecret: dynamicSecret,
      verificationToken: dynamicVToken,
      encryptKey: dynamicEncKey,
      receiveIdType: "chat_id",
      receiveId: "oc_mock_group",
      allowedOpenIds: ["ou_owner_alpha"],
      forwardTiers: ["critical", "actionable"],
      respectLowDistraction: true,
    });

    expect(updated.active).toBe(true);
    expect(updated.config.hasAppSecret).toBe(true);
    expect(updated.config.appSecretMask).toBe(`••••${dynamicSecret.slice(-4)}`);
    const serializedState = JSON.stringify(updated);
    expect(serializedState).not.toContain(dynamicSecret);
    expect(serializedState).not.toContain(dynamicVToken);
    expect(serializedState).not.toContain(dynamicEncKey);

    // First connection test fetches fresh token
    const test1 = await engine.testConnection();
    expect(test1.ok).toBe(true);
    expect(test1.cachedTokenReused).toBe(false);
    expect(mockServer.tokenCalls).toBe(1);

    // Second connection test reuses cached token (tokenCalls stays 1)
    const test2 = await engine.testConnection();
    expect(test2.ok).toBe(true);
    expect(test2.cachedTokenReused).toBe(true);
    expect(mockServer.tokenCalls).toBe(1);

    // Send test card also reuses cached token
    const sent = await engine.sendTestCard({ title: "Mock 连通测试" });
    expect(sent.ok).toBe(true);
    expect(sent.messageId).toBe("om_mock_1");
    expect(mockServer.tokenCalls).toBe(1);
    expect(mockServer.sentMessages).toHaveLength(1);

    // Advance clock past refresh margin (ttl 10s -> refresh margin 2s -> after 9s should refresh)
    clockMs += 9_000;
    const test3 = await engine.testConnection();
    expect(test3.ok).toBe(true);
    expect(test3.cachedTokenReused).toBe(false);
    expect(mockServer.tokenCalls).toBe(2);

    // Low-distraction suppressed non-critical notification is filtered out
    const suppressed = await engine.dispatchEvent({
      kind: "notification_recorded",
      receiptId: "nrec_low",
      category: "patrol_summary",
      tier: "digest",
      status: "suppressed_quiet",
      title: "例行巡检汇总",
      summary: "3 个受管任务运行正常",
      passthrough: false,
    });
    expect(suppressed.dispatched).toBe(false);
    expect(suppressed.filtered).toBe(true);
    expect(mockServer.sentMessages).toHaveLength(1);

    // Critical passthrough alert penetrates low-distraction
    const critical = await engine.dispatchEvent({
      kind: "notification_recorded",
      receiptId: "nrec_crit",
      category: "task_failed",
      tier: "critical",
      status: "queued",
      title: "部署流水线失败",
      summary: "构建步骤退出码 1",
      passthrough: true,
    });
    expect(critical.dispatched).toBe(true);
    expect(mockServer.sentMessages).toHaveLength(2);

    // Audit records never leak plaintext secrets or bearer tokens
    const audit = await engine.listAudit({ limit: 50 });
    const serializedAudit = JSON.stringify(audit);
    expect(serializedAudit).not.toContain(dynamicSecret);
    expect(serializedAudit).not.toContain(dynamicVToken);
    expect(serializedAudit).not.toContain(dynamicEncKey);
    expect(serializedAudit).not.toContain("t-mocktoken_");

    // Persistence survives reload (and clearing secret works without echoing plaintext)
    const rawDisk = await readFile(path.join(dir, "feishu-bridge-state.json"), "utf8");
    expect(rawDisk).toContain('"version": 1');
    const cleared = await engine.updateConfig({ clearAppSecret: true });
    expect(cleared.config.hasAppSecret).toBe(false);
    expect(cleared.config.appSecretMask).toBeNull();
    expect(cleared.active).toBe(false);

    engine.dispose();
  });

  it("enforces AES-256-CBC decryption, SHA-256 signature + replay window, whitelist, and action_id idempotency", async () => {
    let clockMs = 1_760_000_000_000;
    const nowSec = () => String(Math.floor(clockMs / 1000));
    const vToken = `vtok_${randomBytes(10).toString("hex")}`;
    const encKey = `ekey_${randomBytes(12).toString("hex")}`;
    const appSecret = `asec_${randomBytes(12).toString("hex")}`;

    const engine = new FeishuBridgeEngine({ nowMs: () => clockMs });
    await engine.updateConfig({
      enabled: true,
      domainPreset: "custom",
      apiBaseUrl: "http://127.0.0.1:19999",
      appId: "cli_sec_test",
      appSecret,
      verificationToken: vToken,
      encryptKey: encKey,
      receiveIdType: "chat_id",
      receiveId: "oc_sec",
      allowedOpenIds: ["ou_allowed_01"],
      requireSignature: true,
      replayWindowSeconds: 300,
    });

    // 1. Encrypted url_verification challenge succeeds with valid signature
    const challengePlain = JSON.stringify({
      type: "url_verification",
      token: vToken,
      challenge: "chal_wave6_ok",
    });
    const encryptedEnvelope = JSON.stringify({
      encrypt: encryptFeishuPayloadForTest(challengePlain, encKey),
    });
    expect(
      decryptFeishuBody((JSON.parse(encryptedEnvelope) as { encrypt: string }).encrypt, encKey),
    ).toBe(challengePlain);

    const ts = nowSec();
    const nonce = "nonce_001";
    const sig = computeFeishuSignature({
      timestamp: ts,
      nonce,
      encryptKey: encKey,
      rawBody: encryptedEnvelope,
    });
    const challengeRes = await engine.handleWebhook({
      rawBody: encryptedEnvelope,
      headers: { timestamp: ts, nonce, signature: sig },
    });
    expect(challengeRes.httpStatus).toBe(200);
    expect(challengeRes.body).toEqual({ challenge: "chal_wave6_ok" });

    // 2. Wrong signature rejected (401)
    const badSigRes = await engine.handleWebhook({
      rawBody: encryptedEnvelope,
      headers: { timestamp: ts, nonce, signature: "0".repeat(64) },
    });
    expect(badSigRes.httpStatus).toBe(401);
    expect(badSigRes.errorCode).toBe("invalid_signature");

    // 3. Expired replay timestamp rejected (401)
    const expiredTs = String(Math.floor(clockMs / 1000) - 600);
    const expiredSig = computeFeishuSignature({
      timestamp: expiredTs,
      nonce: "nonce_old",
      encryptKey: encKey,
      rawBody: encryptedEnvelope,
    });
    const replayRes = await engine.handleWebhook({
      rawBody: encryptedEnvelope,
      headers: { timestamp: expiredTs, nonce: "nonce_old", signature: expiredSig },
    });
    expect(replayRes.httpStatus).toBe(401);
    expect(replayRes.errorCode).toBe("replay_window_exceeded");

    // 4. Unauthorized sender open_id rejected (403)
    const makeSignedCardCallback = (openId: string, actionId: string) => {
      const body = JSON.stringify({
        schema: "2.0",
        header: { event_id: `evt_${actionId}`, token: vToken, event_type: "card.action.trigger" },
        event: {
          operator: { open_id: openId },
          context: { open_message_id: "om_perm_1" },
          action: {
            value: {
              a: "perm",
              decision: "allow",
              agent_id: "agent_managed_1",
              request_id: "perm_req_1",
              action_id: actionId,
            },
          },
        },
      });
      const currentTs = nowSec();
      const cbNonce = `n_${actionId}`;
      const cbSig = computeFeishuSignature({
        timestamp: currentTs,
        nonce: cbNonce,
        encryptKey: encKey,
        rawBody: body,
      });
      return { rawBody: body, headers: { timestamp: currentTs, nonce: cbNonce, signature: cbSig } };
    };

    const unauthRes = await engine.handleWebhook(
      makeSignedCardCallback("ou_intruder", "act_unauth"),
    );
    expect(unauthRes.httpStatus).toBe(403);
    expect(unauthRes.errorCode).toBe("sender_not_allowed");
    expect(unauthRes.actionIntent).toBeNull();

    // 5. Authorized sender succeeds first time, duplicate action_id is idempotently deduplicated
    const first = await engine.handleWebhook(makeSignedCardCallback("ou_allowed_01", "act_same_1"));
    expect(first.httpStatus).toBe(200);
    expect(first.actionIntent).toMatchObject({
      kind: "permission_respond",
      agentId: "agent_managed_1",
      permissionRequestId: "perm_req_1",
      behavior: "allow",
      actorOpenId: "ou_allowed_01",
    });

    const duplicate = await engine.handleWebhook(
      makeSignedCardCallback("ou_allowed_01", "act_same_1"),
    );
    expect(duplicate.httpStatus).toBe(200);
    expect(duplicate.actionIntent).toBeNull();
    expect(duplicate.errorCode).toBe("deduplicated");
  });
});
