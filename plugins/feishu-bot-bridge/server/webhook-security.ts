import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import type { FeishuWebhookActionIntent } from "../shared/contracts.js";
import type { StoredFeishuBridgeConfig } from "./redaction.js";

const DEFAULT_DEDUPE_TTL_MS = 10 * 60_000;
const MAX_DEDUPE_ENTRIES = 1000;

export interface FeishuWebhookHeaders {
  timestamp?: string | null;
  nonce?: string | null;
  signature?: string | null;
}

export type FeishuWebhookVerificationOutcome =
  | {
      kind: "challenge";
      challenge: string;
    }
  | {
      kind: "action";
      intent: FeishuWebhookActionIntent;
      dedupeKey: string;
    }
  | {
      kind: "deduplicated";
      dedupeKey: string;
      actorOpenId: string | null;
    }
  | {
      kind: "rejected";
      httpStatus: number;
      errorCode: string;
      reason: string;
      actorOpenId: string | null;
      eventOrActionId: string | null;
    };

function timingSafeEqualsUtf8(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Computes Feishu's official X-Lark-Signature:
 * hex(sha256(timestamp + nonce + encryptKey + rawBody))
 */
export function computeFeishuSignature(input: {
  timestamp: string;
  nonce: string;
  encryptKey: string;
  rawBody: string;
}): string {
  return createHash("sha256")
    .update(`${input.timestamp}${input.nonce}${input.encryptKey}${input.rawBody}`, "utf8")
    .digest("hex");
}

/**
 * Decrypts Feishu AES-256-CBC encrypted webhook body:
 * key = sha256(encryptKey) (32 bytes), first 16 bytes of base64 buffer = IV.
 */
export function decryptFeishuBody(encryptedBase64: string, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey, "utf8").digest();
  const raw = Buffer.from(encryptedBase64, "base64");
  if (raw.length <= 16) {
    throw new Error("Encrypted payload is too short");
  }
  const iv = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Bounded TTL deduplication store for Feishu event_id / action_id idempotency.
 */
export class FeishuIdempotencyGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_DEDUPE_TTL_MS,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
    while (this.seen.size > MAX_DEDUPE_ENTRIES) {
      const oldest = this.seen.keys().next().value;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
  }

  /** Returns true if key was newly claimed; false if already seen (duplicate). */
  claim(key: string): boolean {
    const now = this.nowMs();
    this.prune(now);
    const existingExpiry = this.seen.get(key);
    if (existingExpiry !== undefined && existingExpiry > now) {
      return false;
    }
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractToken(payload: Record<string, unknown>): string | null {
  const header = asRecord(payload.header);
  return readString(header?.token) ?? readString(payload.token);
}

function extractActorOpenId(payload: Record<string, unknown>): string | null {
  const event = asRecord(payload.event);
  const eventOp = asRecord(event?.operator);
  const topOp = asRecord(payload.operator);
  return readString(eventOp?.open_id) ?? readString(topOp?.open_id) ?? readString(payload.open_id);
}

function extractMessageId(payload: Record<string, unknown>): string | null {
  const event = asRecord(payload.event);
  const eventContext = asRecord(event?.context);
  const topContext = asRecord(payload.context);
  return (
    readString(eventContext?.open_message_id) ??
    readString(topContext?.open_message_id) ??
    readString(payload.open_message_id)
  );
}

function extractActionValue(payload: Record<string, unknown>): Record<string, unknown> | null {
  const event = asRecord(payload.event);
  const eventAction = asRecord(event?.action);
  const topAction = asRecord(payload.action);
  return asRecord(eventAction?.value) ?? asRecord(topAction?.value);
}

function extractEventOrActionId(
  payload: Record<string, unknown>,
  actionValue: Record<string, unknown> | null,
): string | null {
  const header = asRecord(payload.header);
  return (
    readString(actionValue?.action_id) ??
    readString(header?.event_id) ??
    readString(payload.event_id) ??
    readString(payload.uuid)
  );
}

function verifySignatureAndReplay(input: {
  rawBody: string;
  headers: FeishuWebhookHeaders;
  config: StoredFeishuBridgeConfig;
  nowMs: number;
}): { ok: true } | { ok: false; errorCode: string; reason: string } {
  const signature = readString(input.headers.signature);
  const timestamp = readString(input.headers.timestamp);
  const nonce = readString(input.headers.nonce);
  const hasEncryptKey = Boolean(input.config.encryptKey);

  // Enforce signature whenever X-Lark-Signature header is supplied OR when encryptKey is configured
  // and requireSignature is enabled.
  const shouldVerifySignature =
    Boolean(signature) || (hasEncryptKey && input.config.requireSignature);
  if (!shouldVerifySignature) {
    return { ok: true };
  }

  if (!input.config.encryptKey) {
    return {
      ok: false,
      errorCode: "missing_encrypt_key",
      reason: "收到带签名校验的回调请求，但插件尚未配置 Encrypt Key",
    };
  }
  if (!timestamp || !nonce || !signature) {
    return {
      ok: false,
      errorCode: "missing_signature_headers",
      reason:
        "缺少必需的 X-Lark-Request-Timestamp / X-Lark-Request-Nonce / X-Lark-Signature 请求头",
    };
  }

  const parsedTs = Number(timestamp);
  if (!Number.isFinite(parsedTs)) {
    return {
      ok: false,
      errorCode: "invalid_timestamp",
      reason: "回调时间戳格式无效",
    };
  }
  // Support both Unix seconds (Feishu standard) and milliseconds if accidentally passed in ms.
  const tsSeconds = parsedTs > 1_000_000_000_000 ? Math.floor(parsedTs / 1000) : parsedTs;
  const nowSeconds = Math.floor(input.nowMs / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > input.config.replayWindowSeconds) {
    return {
      ok: false,
      errorCode: "replay_window_exceeded",
      reason: `回调时间戳超出防重放窗口（允许 ±${input.config.replayWindowSeconds} 秒），已拒绝`,
    };
  }

  const expected = computeFeishuSignature({
    timestamp,
    nonce,
    encryptKey: input.config.encryptKey,
    rawBody: input.rawBody,
  });
  if (!timingSafeEqualsUtf8(expected.toLowerCase(), signature.toLowerCase())) {
    return {
      ok: false,
      errorCode: "invalid_signature",
      reason: "X-Lark-Signature SHA-256 签名校验失败",
    };
  }
  return { ok: true };
}

function makeRejectedOutcome(
  httpStatus: number,
  errorCode: string,
  reason: string,
  actorOpenId: string | null = null,
  eventOrActionId: string | null = null,
): Extract<FeishuWebhookVerificationOutcome, { kind: "rejected" }> {
  return {
    kind: "rejected",
    httpStatus,
    errorCode,
    reason,
    actorOpenId,
    eventOrActionId,
  };
}

function parseAndDecryptPayload(
  rawBody: string,
  encryptKey: string | null,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; outcome: Extract<FeishuWebhookVerificationOutcome, { kind: "rejected" }> } {
  let outer: Record<string, unknown> | null = null;
  try {
    outer = asRecord(JSON.parse(rawBody));
  } catch {
    return {
      ok: false,
      outcome: makeRejectedOutcome(400, "invalid_json", "回调请求体不是有效的 JSON"),
    };
  }
  if (!outer) {
    return {
      ok: false,
      outcome: makeRejectedOutcome(400, "invalid_json_object", "回调请求体必须是 JSON 对象"),
    };
  }

  const encrypted = readString(outer.encrypt);
  if (!encrypted) {
    return { ok: true, payload: outer };
  }
  if (!encryptKey) {
    return {
      ok: false,
      outcome: makeRejectedOutcome(
        401,
        "missing_encrypt_key",
        "收到加密回调体，但未配置 Encrypt Key",
      ),
    };
  }
  try {
    const plaintextJson = decryptFeishuBody(encrypted, encryptKey);
    const decrypted = asRecord(JSON.parse(plaintextJson));
    if (!decrypted) {
      throw new Error("Decrypted payload is not a JSON object");
    }
    return { ok: true, payload: decrypted };
  } catch {
    return {
      ok: false,
      outcome: makeRejectedOutcome(
        401,
        "decrypt_failed",
        "AES-256-CBC 解密失败，请检查 Encrypt Key 是否与飞书开放平台一致",
      ),
    };
  }
}

function verifyVerificationToken(
  payload: Record<string, unknown>,
  config: StoredFeishuBridgeConfig,
): Extract<FeishuWebhookVerificationOutcome, { kind: "rejected" }> | null {
  if (config.verificationToken) {
    const providedToken = extractToken(payload);
    if (!providedToken || !timingSafeEqualsUtf8(providedToken, config.verificationToken)) {
      return makeRejectedOutcome(
        401,
        "invalid_verification_token",
        "Verification Token 校验失败",
        extractActorOpenId(payload),
        extractEventOrActionId(payload, extractActionValue(payload)),
      );
    }
    return null;
  }
  if (!config.encryptKey) {
    return makeRejectedOutcome(
      401,
      "missing_callback_auth",
      "至少需配置 Verification Token 或 Encrypt Key 才能接收飞书回调",
    );
  }
  return null;
}

function parseManagedHint(raw: unknown): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

function parseActionIntent(params: {
  actionValue: Record<string, unknown>;
  messageId: string | null;
  actorOpenId: string;
  dedupeKey: string;
}): FeishuWebhookActionIntent | null {
  const { actionValue, messageId, actorOpenId, dedupeKey } = params;
  const actionType = readString(actionValue.a);
  if (actionType === "perm") {
    const agentId = readString(actionValue.agent_id);
    const permissionRequestId = readString(actionValue.request_id);
    const decision = readString(actionValue.decision);
    if (!agentId || !permissionRequestId || (decision !== "allow" && decision !== "deny")) {
      return null;
    }
    return {
      kind: "permission_respond",
      agentId,
      serverId: readString(actionValue.server_id),
      permissionRequestId,
      behavior: decision,
      messageId,
      actorOpenId,
      actionId: dedupeKey,
      managedHint: parseManagedHint(actionValue.managed),
      titleHint: readString(actionValue.title),
    };
  }
  if (actionType === "decide") {
    const decisionId = readString(actionValue.decision_id);
    const optionId = readString(actionValue.option_id);
    const answer = readString(actionValue.answer);
    if (!decisionId || !optionId || !answer) {
      return null;
    }
    return {
      kind: "decision_answer",
      decisionId,
      optionId,
      answer,
      messageId,
      actorOpenId,
      actionId: dedupeKey,
      titleHint: readString(actionValue.title),
    };
  }
  return null;
}

function checkInteractivePreconditions(params: {
  config: StoredFeishuBridgeConfig;
  actorOpenId: string | null;
  actionValue: Record<string, unknown> | null;
  eventOrActionId: string | null;
}): Extract<FeishuWebhookVerificationOutcome, { kind: "rejected" }> | null {
  const { config, actorOpenId, actionValue, eventOrActionId } = params;
  if (!config.enabled) {
    return makeRejectedOutcome(
      503,
      "bridge_disabled",
      "飞书机器人桥接已关闭，拒绝执行回调动作",
      actorOpenId,
      eventOrActionId,
    );
  }
  if (config.allowedOpenIds.length === 0) {
    return makeRejectedOutcome(
      403,
      "whitelist_empty",
      "未配置允许操作人 Open ID 白名单（allowedOpenIds），默认拒绝所有交互回调",
      actorOpenId,
      eventOrActionId,
    );
  }
  if (!actorOpenId || !config.allowedOpenIds.includes(actorOpenId)) {
    return makeRejectedOutcome(
      403,
      "sender_not_allowed",
      `操作人 ${actorOpenId ?? "(unknown)"} 不在允许操作人 Open ID 白名单中`,
      actorOpenId,
      eventOrActionId,
    );
  }
  if (!actionValue) {
    return makeRejectedOutcome(
      400,
      "unsupported_callback",
      "仅支持处理 Paseo 审批与拍板卡片回调，不接受自由文本或业务指令回调",
      actorOpenId,
      eventOrActionId,
    );
  }
  return null;
}

function buildFallbackDedupeKey(
  actionValue: Record<string, unknown>,
  messageId: string | null,
): string {
  const actionType = readString(actionValue.a) ?? "unknown";
  const target =
    readString(actionValue.request_id) ?? readString(actionValue.decision_id) ?? "none";
  const choice = readString(actionValue.decision) ?? readString(actionValue.option_id) ?? "none";
  return `${actionType}:${messageId ?? "none"}:${target}:${choice}`;
}

export function verifyAndParseFeishuWebhook(input: {
  rawBody: string;
  headers: FeishuWebhookHeaders;
  config: StoredFeishuBridgeConfig;
  idempotency: FeishuIdempotencyGuard;
  nowMs?: number;
}): FeishuWebhookVerificationOutcome {
  const nowMs = input.nowMs ?? Date.now();

  if (!input.config.enabled && !input.config.verificationToken && !input.config.encryptKey) {
    return makeRejectedOutcome(503, "bridge_disabled", "飞书机器人桥接未启用且未配置回调验签凭证");
  }

  // 1. Signature + anti-replay timestamp check (always against exact rawBody bytes)
  const sigCheck = verifySignatureAndReplay({
    rawBody: input.rawBody,
    headers: input.headers,
    config: input.config,
    nowMs,
  });
  if (!sigCheck.ok) {
    return makeRejectedOutcome(401, sigCheck.errorCode, sigCheck.reason);
  }

  // 2. Parse outer JSON and optionally decrypt AES-256-CBC `encrypt` envelope
  const parsed = parseAndDecryptPayload(input.rawBody, input.config.encryptKey);
  if (!parsed.ok) {
    return parsed.outcome;
  }
  const { payload } = parsed;

  // 3. Verification Token check (when configured)
  const tokenError = verifyVerificationToken(payload, input.config);
  if (tokenError) {
    return tokenError;
  }

  // 4. url_verification challenge echo
  if (payload.type === "url_verification") {
    const challenge = readString(payload.challenge);
    if (!challenge) {
      return makeRejectedOutcome(
        400,
        "missing_challenge",
        "url_verification 请求缺少 challenge 字段",
      );
    }
    return { kind: "challenge", challenge };
  }

  // 5 & 6. Bridge enabled + strict fail-closed allowedOpenIds sender whitelist + action payload check
  const actorOpenId = extractActorOpenId(payload);
  const actionValue = extractActionValue(payload);
  const eventOrActionId = extractEventOrActionId(payload, actionValue);
  const preconditionError = checkInteractivePreconditions({
    config: input.config,
    actorOpenId,
    actionValue,
    eventOrActionId,
  });
  if (preconditionError || !actorOpenId || !actionValue) {
    return (
      preconditionError ??
      makeRejectedOutcome(400, "unsupported_callback", "无效交互回调", actorOpenId, eventOrActionId)
    );
  }

  // 7. Parse structured action intent (strictly permission approval or decision choice only!)
  const messageId = extractMessageId(payload);
  const dedupeKey = eventOrActionId ?? buildFallbackDedupeKey(actionValue, messageId);

  const intent = parseActionIntent({
    actionValue,
    messageId,
    actorOpenId,
    dedupeKey,
  });

  if (!intent) {
    return {
      kind: "rejected",
      httpStatus: 400,
      errorCode: "invalid_action_payload",
      reason: "回调动作参数不完整或不属于受支持的审批/拍板动作",
      actorOpenId,
      eventOrActionId: dedupeKey,
    };
  }

  // 8. Idempotent deduplication by event_id / action_id
  if (!input.idempotency.claim(dedupeKey)) {
    return {
      kind: "deduplicated",
      dedupeKey,
      actorOpenId,
    };
  }

  return {
    kind: "action",
    intent,
    dedupeKey,
  };
}
