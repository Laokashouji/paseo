import type { FeishuReceiveIdType } from "../shared/contracts.js";
import type { FeishuCard2 } from "./cards.js";
import { redactSecretsFromText } from "./redaction.js";
import {
  FeishuTenantTokenManager,
  FeishuTokenError,
  type FeishuTokenCredentials,
} from "./token-manager.js";

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_INVALID_CODES = new Set([99991663, 99991668, 99991661]);

export class FeishuOpenApiError extends Error {
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
    this.name = "FeishuOpenApiError";
  }
}

export interface SendInteractiveCardInput {
  credentials: FeishuTokenCredentials;
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
  card: FeishuCard2;
  uuid?: string;
}

export interface SendInteractiveCardResult {
  messageId: string;
  latencyMs: number;
  statusCode: number;
}

export interface UpdateInteractiveCardInput {
  credentials: FeishuTokenCredentials;
  messageId: string;
  card: FeishuCard2;
}

export interface UpdateInteractiveCardResult {
  latencyMs: number;
  statusCode: number;
}

function classifyApiError(
  code: number | null,
  httpStatus: number | null,
): {
  errorCode: string;
  hint: string;
} {
  if (code === 99991672 || code === 99991679) {
    return {
      errorCode: `feishu_${code}`,
      hint: "应用缺少发消息权限（如 im:message、im:message:send_as_bot），请在飞书开放平台权限管理中开通并重新发布版本。",
    };
  }
  if (code === 230002 || code === 230013) {
    return {
      errorCode: `feishu_${code}`,
      hint: "机器人未加入目标群聊或无权给目标用户发消息，请将机器人拉入对应群聊并核对 receive_id / receive_id_type。",
    };
  }
  if (code === 230001 || code === 99992402) {
    return {
      errorCode: `feishu_${code}`,
      hint: "目标 receive_id 格式与所选类型（chat_id / open_id / user_id）不匹配，请核对后重试。",
    };
  }
  if (code && TOKEN_INVALID_CODES.has(code)) {
    return {
      errorCode: `feishu_${code}`,
      hint: "tenant_access_token 已失效，请点击「测试连接」验证 App ID / App Secret。",
    };
  }
  let fallbackCode = "openapi_failed";
  if (code) {
    fallbackCode = `feishu_${code}`;
  } else if (httpStatus) {
    fallbackCode = `http_${httpStatus}`;
  }
  return {
    errorCode: fallbackCode,
    hint: "请检查网络连通性、目标群/用户 ID、机器人权限以及飞书开放平台应用发布状态。",
  };
}

export class FeishuOpenApiClient {
  constructor(
    private readonly tokenManager: FeishuTenantTokenManager,
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

  async sendInteractiveCard(input: SendInteractiveCardInput): Promise<SendInteractiveCardResult> {
    const startedAt = this.now();
    return this.executeWithTokenRetry<SendInteractiveCardResult>(
      input.credentials,
      startedAt,
      async (token) => {
        const endpoint = `${input.credentials.apiBaseUrl.replace(/\/+$/, "")}/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(input.receiveIdType)}`;
        const bodyPayload: Record<string, string> = {
          receive_id: input.receiveId,
          msg_type: "interactive",
          content: JSON.stringify(input.card),
        };
        if (input.uuid) {
          bodyPayload.uuid = input.uuid;
        }

        const { response, parsed } = await this.requestJson(endpoint, "POST", token, bodyPayload, [
          input.credentials.appSecret,
          token,
        ]);

        const code = typeof parsed?.code === "number" ? parsed.code : null;
        const data = parsed?.data as Record<string, unknown> | undefined;
        const messageId = typeof data?.message_id === "string" ? data.message_id : "";

        if (response.status === 401 || (code !== null && TOKEN_INVALID_CODES.has(code))) {
          return { retryWithFreshToken: true as const };
        }

        if (!response.ok || (code !== null && code !== 0) || !messageId) {
          const latencyMs = Math.max(0, this.now() - startedAt);
          const { errorCode, hint } = classifyApiError(code, response.status);
          const msg =
            typeof parsed?.msg === "string" && parsed.msg.trim()
              ? redactSecretsFromText(parsed.msg.trim(), [input.credentials.appSecret, token])
              : `HTTP ${response.status}`;
          throw new FeishuOpenApiError(`发送飞书交互卡片失败：${msg}`, {
            statusCode: response.status,
            errorCode,
            troubleshootingHint: hint,
            latencyMs,
          });
        }

        return {
          retryWithFreshToken: false as const,
          value: {
            messageId,
            latencyMs: Math.max(0, this.now() - startedAt),
            statusCode: response.status,
          },
        };
      },
    );
  }

  async updateInteractiveCard(
    input: UpdateInteractiveCardInput,
  ): Promise<UpdateInteractiveCardResult> {
    const startedAt = this.now();
    return this.executeWithTokenRetry<UpdateInteractiveCardResult>(
      input.credentials,
      startedAt,
      async (token) => {
        const endpoint = `${input.credentials.apiBaseUrl.replace(/\/+$/, "")}/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}`;
        const { response, parsed } = await this.requestJson(
          endpoint,
          "PATCH",
          token,
          { content: JSON.stringify(input.card) },
          [input.credentials.appSecret, token],
        );

        const code = typeof parsed?.code === "number" ? parsed.code : null;
        if (response.status === 401 || (code !== null && TOKEN_INVALID_CODES.has(code))) {
          return { retryWithFreshToken: true as const };
        }

        if (!response.ok || (code !== null && code !== 0)) {
          const latencyMs = Math.max(0, this.now() - startedAt);
          const { errorCode, hint } = classifyApiError(code, response.status);
          const msg =
            typeof parsed?.msg === "string" && parsed.msg.trim()
              ? redactSecretsFromText(parsed.msg.trim(), [input.credentials.appSecret, token])
              : `HTTP ${response.status}`;
          throw new FeishuOpenApiError(`更新飞书卡片状态失败：${msg}`, {
            statusCode: response.status,
            errorCode,
            troubleshootingHint: hint,
            latencyMs,
          });
        }

        return {
          retryWithFreshToken: false as const,
          value: {
            latencyMs: Math.max(0, this.now() - startedAt),
            statusCode: response.status,
          },
        };
      },
    );
  }

  private async executeWithTokenRetry<T>(
    credentials: FeishuTokenCredentials,
    startedAt: number,
    run: (
      token: string,
    ) => Promise<{ retryWithFreshToken: true } | { retryWithFreshToken: false; value: T }>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let grant;
      try {
        grant = await this.tokenManager.getToken(credentials, {
          forceRefresh: attempt > 0,
        });
      } catch (error) {
        if (error instanceof FeishuTokenError) {
          throw new FeishuOpenApiError(error.message, error.options);
        }
        throw error;
      }

      const outcome = await run(grant.token);
      if (!outcome.retryWithFreshToken) {
        return outcome.value;
      }
      this.tokenManager.invalidate();
    }

    throw new FeishuOpenApiError("飞书访问凭证刷新重试后仍返回未授权", {
      statusCode: 401,
      errorCode: "token_refresh_exhausted",
      troubleshootingHint: "请核对 App ID / App Secret 并在飞书开放平台确认应用状态正常。",
      latencyMs: Math.max(0, this.now() - startedAt),
    });
  }

  private async requestJson(
    endpoint: string,
    method: "POST" | "PATCH",
    token: string,
    body: Record<string, unknown>,
    secrets: readonly string[],
  ): Promise<{ response: Response; parsed: Record<string, unknown> | null }> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.getFetch()(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = (await response.json()) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      return { response, parsed };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new FeishuOpenApiError(
        `飞书 OpenAPI 网络请求失败：${redactSecretsFromText(rawMessage, secrets)}`,
        {
          statusCode: null,
          errorCode: "network_error",
          troubleshootingHint: "请检查目标 API 地址是否可达、代理是否放行或本地 Mock 服务状态。",
          latencyMs: Math.max(0, this.now() - startedAt),
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
