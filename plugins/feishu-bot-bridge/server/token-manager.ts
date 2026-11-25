import { createHash } from "node:crypto";
import { redactSecretsFromText } from "./redaction.js";

export interface FeishuTokenCredentials {
  apiBaseUrl: string;
  appId: string;
  appSecret: string;
}

export interface FeishuTenantTokenGrant {
  token: string;
  expiresAtMs: number;
  expiresInSec: number;
  reused: boolean;
  latencyMs: number;
  statusCode: number;
}

export class FeishuTokenError extends Error {
  constructor(
    message: string,
    public readonly options: {
      statusCode: number | null;
      errorCode: string;
      troubleshootingHint: string;
      latencyMs: number;
    },
  ) {
    super(message);
    this.name = "FeishuTokenError";
  }
}

interface CachedTokenEntry {
  cacheKey: string;
  token: string;
  expiresAtMs: number;
  refreshAfterMs: number;
  statusCode: number;
}

const DEFAULT_REFRESH_MARGIN_MS = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;

function computeCacheKey(creds: FeishuTokenCredentials): string {
  const secretDigest = createHash("sha256").update(creds.appSecret, "utf8").digest("hex");
  return `${creds.apiBaseUrl}|${creds.appId}|${secretDigest}`;
}

function resolveRefreshMarginMs(expireSec: number): number {
  const ttlMs = Math.max(1_000, expireSec * 1_000);
  // For standard 2-hour Feishu tokens, refresh 120s early; for short mock test TTLs,
  // refresh at 20% remaining TTL so tests can observe both cache hits and expiry refresh.
  return Math.min(DEFAULT_REFRESH_MARGIN_MS, Math.floor(ttlMs * 0.2));
}

function classifyTokenFailure(
  code: number | null,
  httpStatus: number | null,
): {
  errorCode: string;
  hint: string;
} {
  if (code === 10003 || code === 10014 || code === 20001 || httpStatus === 401) {
    return {
      errorCode: code ? `feishu_${code}` : "invalid_credentials",
      hint: "请检查飞书开放平台应用凭证：确认 App ID 与 App Secret 填写正确且未轮换失效，同时核对飞书国内版 / Lark 国际版域名是否匹配。",
    };
  }
  if (code === 10002 || code === 10013) {
    return {
      errorCode: `feishu_${code}`,
      hint: "应用可能尚未启用机器人能力或已被停用，请在飞书开放平台检查应用发布状态。",
    };
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return {
      errorCode: `http_${httpStatus}`,
      hint: "飞书 OpenAPI 服务端返回临时错误，请稍后重试或检查自定义 API 地址是否可用。",
    };
  }
  let fallbackCode = "token_fetch_failed";
  if (code) {
    fallbackCode = `feishu_${code}`;
  } else if (httpStatus) {
    fallbackCode = `http_${httpStatus}`;
  }
  return {
    errorCode: fallbackCode,
    hint: "请检查网络连通性、代理配置及自定义 apiBaseUrl 是否正确，确认可访问 /open-apis/auth/v3/tenant_access_token/internal。",
  };
}

export class FeishuTenantTokenManager {
  private cached: CachedTokenEntry | null = null;
  private inFlight: { cacheKey: string; promise: Promise<FeishuTenantTokenGrant> } | null = null;

  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      nowMs?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.nowMs ? this.options.nowMs() : Date.now();
  }

  private getFetch(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }

  invalidate(): void {
    this.cached = null;
  }

  async getToken(
    creds: FeishuTokenCredentials,
    options?: { forceRefresh?: boolean },
  ): Promise<FeishuTenantTokenGrant> {
    const cacheKey = computeCacheKey(creds);
    const nowMs = this.now();

    if (
      !options?.forceRefresh &&
      this.cached &&
      this.cached.cacheKey === cacheKey &&
      nowMs < this.cached.refreshAfterMs
    ) {
      const remainingSec = Math.max(1, Math.floor((this.cached.expiresAtMs - nowMs) / 1000));
      return {
        token: this.cached.token,
        expiresAtMs: this.cached.expiresAtMs,
        expiresInSec: remainingSec,
        reused: true,
        latencyMs: 0,
        statusCode: this.cached.statusCode,
      };
    }

    if (!options?.forceRefresh && this.inFlight && this.inFlight.cacheKey === cacheKey) {
      return this.inFlight.promise;
    }

    const promise = this.fetchFreshToken(creds, cacheKey);
    this.inFlight = { cacheKey, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshToken(
    creds: FeishuTokenCredentials,
    cacheKey: string,
  ): Promise<FeishuTenantTokenGrant> {
    const startedAt = this.now();
    const endpoint = `${creds.apiBaseUrl.replace(/\/+$/, "")}/open-apis/auth/v3/tenant_access_token/internal`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.getFetch()(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          app_id: creds.appId,
          app_secret: creds.appSecret,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - startedAt);
      const rawMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = redactSecretsFromText(rawMessage, [creds.appSecret]);
      throw new FeishuTokenError(`无法连接飞书鉴权接口：${safeMessage}`, {
        statusCode: null,
        errorCode: "network_error",
        troubleshootingHint:
          "请确认本机网络/代理可访问目标飞书域名（open.feishu.cn / open.larksuite.com）或本地 Mock 地址已启动。",
        latencyMs,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Math.max(0, this.now() - startedAt);
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const code = typeof parsed?.code === "number" ? parsed.code : null;
    const token =
      typeof parsed?.tenant_access_token === "string" ? parsed.tenant_access_token.trim() : "";
    const expireSecRaw = typeof parsed?.expire === "number" ? parsed.expire : 0;

    if (!response.ok || (code !== null && code !== 0) || !token) {
      const { errorCode, hint } = classifyTokenFailure(code, response.status);
      const serverMsg =
        typeof parsed?.msg === "string" && parsed.msg.trim()
          ? redactSecretsFromText(parsed.msg.trim(), [creds.appSecret, token])
          : `HTTP ${response.status}`;
      throw new FeishuTokenError(`获取 tenant_access_token 失败：${serverMsg}`, {
        statusCode: response.status,
        errorCode,
        troubleshootingHint: hint,
        latencyMs,
      });
    }

    const expireSec = expireSecRaw > 0 ? Math.floor(expireSecRaw) : 7200;
    const issuedAt = this.now();
    const expiresAtMs = issuedAt + expireSec * 1000;
    const refreshAfterMs = expiresAtMs - resolveRefreshMarginMs(expireSec);

    this.cached = {
      cacheKey,
      token,
      expiresAtMs,
      refreshAfterMs,
      statusCode: response.status,
    };

    return {
      token,
      expiresAtMs,
      expiresInSec: expireSec,
      reused: false,
      latencyMs,
      statusCode: response.status,
    };
  }
}
