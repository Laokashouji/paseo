import type {
  FeishuDomainPreset,
  FeishuForwardTier,
  FeishuReceiveIdType,
  FeishuRedactedConfig,
} from "../shared/contracts.js";
import { resolveApiBaseUrl } from "../shared/contracts.js";

export interface StoredFeishuBridgeConfig {
  enabled: boolean;
  domainPreset: FeishuDomainPreset;
  customApiBaseUrl: string;
  appId: string;
  appSecret: string | null;
  verificationToken: string | null;
  encryptKey: string | null;
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
  allowedOpenIds: string[];
  forwardTiers: FeishuForwardTier[];
  respectLowDistraction: boolean;
  replayWindowSeconds: number;
  requireSignature: boolean;
  updatedAt: string | null;
}

const MASK_PREFIX = "••••";
const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const FEISHU_TENANT_TOKEN_PATTERN = /\bt-[A-Za-z0-9._-]{8,}\b/g;

/**
 * Masks any sensitive secret value so only its configured status and at most
 * the last 2-4 characters are shown. Never exposes plaintext secrets.
 */
export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  const trimmed = secret.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return MASK_PREFIX;
  if (trimmed.length <= 8) return `${MASK_PREFIX}${trimmed.slice(-2)}`;
  return `${MASK_PREFIX}${trimmed.slice(-4)}`;
}

/**
 * Scrubs any known secret or token substring from arbitrary text before writing
 * to logs, audit records, or RPC responses.
 */
export function redactSecretsFromText(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    if (output.includes(trimmed)) {
      output = output.split(trimmed).join("[REDACTED]");
    }
  }
  output = output.replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
  output = output.replace(FEISHU_TENANT_TOKEN_PATTERN, "t-[REDACTED]");
  return output;
}

export function collectConfiguredSecrets(config: StoredFeishuBridgeConfig): string[] {
  const values: string[] = [];
  if (config.appSecret) values.push(config.appSecret);
  if (config.verificationToken) values.push(config.verificationToken);
  if (config.encryptKey) values.push(config.encryptKey);
  return values;
}

export function toRedactedConfig(config: StoredFeishuBridgeConfig): FeishuRedactedConfig {
  return {
    enabled: config.enabled,
    domainPreset: config.domainPreset,
    apiBaseUrl: resolveApiBaseUrl(config.domainPreset, config.customApiBaseUrl),
    appId: config.appId,
    hasAppSecret: Boolean(config.appSecret),
    appSecretMask: maskSecret(config.appSecret),
    hasVerificationToken: Boolean(config.verificationToken),
    verificationTokenMask: maskSecret(config.verificationToken),
    hasEncryptKey: Boolean(config.encryptKey),
    encryptKeyMask: maskSecret(config.encryptKey),
    receiveIdType: config.receiveIdType,
    receiveId: config.receiveId,
    allowedOpenIds: [...config.allowedOpenIds],
    forwardTiers: [...config.forwardTiers],
    respectLowDistraction: config.respectLowDistraction,
    replayWindowSeconds: config.replayWindowSeconds,
    requireSignature: config.requireSignature,
    updatedAt: config.updatedAt,
  };
}
