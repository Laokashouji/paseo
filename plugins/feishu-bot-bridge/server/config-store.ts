import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FEISHU_DEFAULT_REPLAY_WINDOW_SEC,
  FEISHU_MAX_AUDIT_RECORDS,
  FEISHU_MAX_REPLAY_WINDOW_SEC,
  FEISHU_MIN_REPLAY_WINDOW_SEC,
  type FeishuAuditRecord,
  type FeishuConfigPatch,
  type FeishuForwardTier,
  type FeishuStats,
  resolveApiBaseUrl,
} from "../shared/contracts.js";
import {
  collectConfiguredSecrets,
  redactSecretsFromText,
  type StoredFeishuBridgeConfig,
} from "./redaction.js";

const CONFIG_VERSION = 1;
const STATE_FILENAME = "feishu-bridge-state.json";

interface PersistedBridgeState {
  version: number;
  config: StoredFeishuBridgeConfig;
  stats: FeishuStats;
  audit: FeishuAuditRecord[];
}

export function createDefaultStoredConfig(): StoredFeishuBridgeConfig {
  return {
    enabled: false,
    domainPreset: "feishu",
    customApiBaseUrl: "",
    appId: "",
    appSecret: null,
    verificationToken: null,
    encryptKey: null,
    receiveIdType: "chat_id",
    receiveId: "",
    allowedOpenIds: [],
    forwardTiers: ["critical", "actionable"],
    respectLowDistraction: true,
    replayWindowSeconds: FEISHU_DEFAULT_REPLAY_WINDOW_SEC,
    requireSignature: true,
    updatedAt: null,
  };
}

export function createDefaultStats(): FeishuStats {
  return {
    outboundSent: 0,
    outboundFailed: 0,
    inboundProcessed: 0,
    inboundRejected: 0,
    inboundDeduplicated: 0,
    lastOutboundAt: null,
    lastInboundAt: null,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1" || lower === "[::1]";
}

export function validateCustomApiBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("自定义飞书 API 地址格式无效，请填写完整的 http(s):// 地址");
  }
  if (parsed.protocol === "https:") {
    return trimmed;
  }
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
    return trimmed;
  }
  throw new Error(
    "安全限制：自定义飞书 API 地址仅允许使用 https://（本地测试环境允许 http://127.0.0.1 或 http://localhost）",
  );
}

function normalizeOpenIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeForwardTiers(tiers: readonly FeishuForwardTier[]): FeishuForwardTier[] {
  const allowed: FeishuForwardTier[] = ["critical", "actionable", "digest"];
  const picked = new Set<FeishuForwardTier>();
  for (const tier of tiers) {
    if (allowed.includes(tier)) picked.add(tier);
  }
  // Critical approvals/alerts are always kept enabled if the user tries to empty everything
  if (picked.size === 0) {
    picked.add("critical");
  }
  return allowed.filter((tier) => picked.has(tier));
}

function applySecretPatch(
  current: string | null,
  incoming: string | undefined,
  clear: boolean | undefined,
): string | null {
  if (clear === true) return null;
  if (incoming === undefined) return current;
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  return trimmed;
}

export function isBridgeConfiguredForOutbound(config: StoredFeishuBridgeConfig): boolean {
  const baseUrl = resolveApiBaseUrl(config.domainPreset, config.customApiBaseUrl);
  return Boolean(
    config.enabled &&
    baseUrl.length > 0 &&
    config.appId.trim().length > 0 &&
    config.appSecret &&
    config.receiveId.trim().length > 0,
  );
}

export class FeishuBridgeConfigStore {
  private loaded = false;
  private config: StoredFeishuBridgeConfig = createDefaultStoredConfig();
  private stats: FeishuStats = createDefaultStats();
  private audit: FeishuAuditRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDirectory?: string) {}

  private stateFilePath(): string | null {
    return this.dataDirectory ? path.join(this.dataDirectory, STATE_FILENAME) : null;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async load(): Promise<void> {
    await this.enqueue(async () => {
      if (this.loaded) return;
      await this.loadUnlocked();
    });
  }

  private hydrateConfig(stored: Partial<StoredFeishuBridgeConfig>): StoredFeishuBridgeConfig {
    const defaults = createDefaultStoredConfig();
    const trimOrNull = (val: unknown): string | null =>
      typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
    const replayWindow =
      typeof stored.replayWindowSeconds === "number" && Number.isFinite(stored.replayWindowSeconds)
        ? Math.max(
            FEISHU_MIN_REPLAY_WINDOW_SEC,
            Math.min(FEISHU_MAX_REPLAY_WINDOW_SEC, Math.round(stored.replayWindowSeconds)),
          )
        : FEISHU_DEFAULT_REPLAY_WINDOW_SEC;
    const domainPreset: StoredFeishuBridgeConfig["domainPreset"] =
      stored.domainPreset === "lark" || stored.domainPreset === "custom"
        ? stored.domainPreset
        : "feishu";
    const receiveIdType: StoredFeishuBridgeConfig["receiveIdType"] =
      stored.receiveIdType === "open_id" || stored.receiveIdType === "user_id"
        ? stored.receiveIdType
        : "chat_id";
    const allowedOpenIds = Array.isArray(stored.allowedOpenIds)
      ? normalizeOpenIds(
          stored.allowedOpenIds.filter((item): item is string => typeof item === "string"),
        )
      : [];
    const forwardTiers = Array.isArray(stored.forwardTiers)
      ? normalizeForwardTiers(
          stored.forwardTiers.filter(
            (item): item is FeishuForwardTier =>
              item === "critical" || item === "actionable" || item === "digest",
          ),
        )
      : defaults.forwardTiers;

    return {
      enabled: Boolean(stored.enabled),
      domainPreset,
      customApiBaseUrl: typeof stored.customApiBaseUrl === "string" ? stored.customApiBaseUrl : "",
      appId: typeof stored.appId === "string" ? stored.appId : "",
      appSecret: trimOrNull(stored.appSecret),
      verificationToken: trimOrNull(stored.verificationToken),
      encryptKey: trimOrNull(stored.encryptKey),
      receiveIdType,
      receiveId: typeof stored.receiveId === "string" ? stored.receiveId : "",
      allowedOpenIds,
      forwardTiers,
      respectLowDistraction:
        typeof stored.respectLowDistraction === "boolean" ? stored.respectLowDistraction : true,
      replayWindowSeconds: replayWindow,
      requireSignature:
        typeof stored.requireSignature === "boolean" ? stored.requireSignature : true,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
    };
  }

  private hydrateStats(raw: Partial<FeishuStats>): FeishuStats {
    return {
      outboundSent: Number(raw.outboundSent) || 0,
      outboundFailed: Number(raw.outboundFailed) || 0,
      inboundProcessed: Number(raw.inboundProcessed) || 0,
      inboundRejected: Number(raw.inboundRejected) || 0,
      inboundDeduplicated: Number(raw.inboundDeduplicated) || 0,
      lastOutboundAt: typeof raw.lastOutboundAt === "string" ? raw.lastOutboundAt : null,
      lastInboundAt: typeof raw.lastInboundAt === "string" ? raw.lastInboundAt : null,
    };
  }

  private async loadUnlocked(): Promise<void> {
    this.loaded = true;
    const filePath = this.stateFilePath();
    if (!filePath) return;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedBridgeState>;
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.config && typeof parsed.config === "object") {
        this.config = this.hydrateConfig(parsed.config);
      }
      if (parsed.stats && typeof parsed.stats === "object") {
        this.stats = this.hydrateStats(parsed.stats);
      }
      if (Array.isArray(parsed.audit)) {
        this.audit = parsed.audit.slice(0, FEISHU_MAX_AUDIT_RECORDS);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async persistUnlocked(): Promise<void> {
    const filePath = this.stateFilePath();
    if (!filePath || !this.dataDirectory) return;
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const payload: PersistedBridgeState = {
      version: CONFIG_VERSION,
      config: this.config,
      stats: this.stats,
      audit: this.audit.slice(0, FEISHU_MAX_AUDIT_RECORDS),
    };
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(payload, null, 2);
    try {
      await writeFile(tempPath, serialized, { mode: 0o600 });
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  getConfigSnapshot(): StoredFeishuBridgeConfig {
    return {
      ...this.config,
      allowedOpenIds: [...this.config.allowedOpenIds],
      forwardTiers: [...this.config.forwardTiers],
    };
  }

  getStatsSnapshot(): FeishuStats {
    return { ...this.stats };
  }

  listAudit(limit = 30, direction?: FeishuAuditRecord["direction"]): FeishuAuditRecord[] {
    const filtered = direction
      ? this.audit.filter((entry) => entry.direction === direction)
      : this.audit;
    return filtered.slice(0, Math.max(1, Math.min(FEISHU_MAX_AUDIT_RECORDS, limit)));
  }

  async updateConfig(
    patch: FeishuConfigPatch,
    nowIso = new Date().toISOString(),
  ): Promise<StoredFeishuBridgeConfig> {
    return this.enqueue(async () => {
      if (!this.loaded) await this.loadUnlocked();
      const nextPreset = patch.domainPreset ?? this.config.domainPreset;
      let nextCustomUrl = this.config.customApiBaseUrl;
      if (patch.apiBaseUrl !== undefined && nextPreset === "custom") {
        nextCustomUrl = validateCustomApiBaseUrl(patch.apiBaseUrl);
      } else if (nextPreset === "custom" && patch.domainPreset === "custom" && nextCustomUrl) {
        nextCustomUrl = validateCustomApiBaseUrl(nextCustomUrl);
      }

      const nextConfig: StoredFeishuBridgeConfig = {
        enabled: patch.enabled ?? this.config.enabled,
        domainPreset: nextPreset,
        customApiBaseUrl: nextCustomUrl,
        appId: patch.appId !== undefined ? patch.appId.trim() : this.config.appId,
        appSecret: applySecretPatch(this.config.appSecret, patch.appSecret, patch.clearAppSecret),
        verificationToken: applySecretPatch(
          this.config.verificationToken,
          patch.verificationToken,
          patch.clearVerificationToken,
        ),
        encryptKey: applySecretPatch(
          this.config.encryptKey,
          patch.encryptKey,
          patch.clearEncryptKey,
        ),
        receiveIdType: patch.receiveIdType ?? this.config.receiveIdType,
        receiveId: patch.receiveId !== undefined ? patch.receiveId.trim() : this.config.receiveId,
        allowedOpenIds:
          patch.allowedOpenIds !== undefined
            ? normalizeOpenIds(patch.allowedOpenIds)
            : [...this.config.allowedOpenIds],
        forwardTiers:
          patch.forwardTiers !== undefined
            ? normalizeForwardTiers(patch.forwardTiers)
            : [...this.config.forwardTiers],
        respectLowDistraction: patch.respectLowDistraction ?? this.config.respectLowDistraction,
        replayWindowSeconds:
          patch.replayWindowSeconds !== undefined
            ? Math.max(
                FEISHU_MIN_REPLAY_WINDOW_SEC,
                Math.min(FEISHU_MAX_REPLAY_WINDOW_SEC, Math.round(patch.replayWindowSeconds)),
              )
            : this.config.replayWindowSeconds,
        requireSignature: patch.requireSignature ?? this.config.requireSignature,
        updatedAt: nowIso,
      };

      this.config = nextConfig;
      await this.persistUnlocked();
      return this.getConfigSnapshot();
    });
  }

  async appendAudit(
    entry: Omit<FeishuAuditRecord, "id" | "createdAt"> & { createdAt?: string },
    extraSecrets: readonly (string | null | undefined)[] = [],
  ): Promise<FeishuAuditRecord> {
    return this.enqueue(async () => {
      if (!this.loaded) await this.loadUnlocked();
      const secrets = [...collectConfiguredSecrets(this.config), ...extraSecrets];
      const createdAt = entry.createdAt ?? new Date().toISOString();
      const sanitized: FeishuAuditRecord = {
        id: `faud_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
        direction: entry.direction,
        kind: entry.kind,
        status: entry.status,
        title: redactSecretsFromText(entry.title, secrets).slice(0, 160),
        summary: redactSecretsFromText(entry.summary, secrets).slice(0, 400),
        errorCode: entry.errorCode,
        latencyMs: entry.latencyMs,
        messageId: entry.messageId,
        actorOpenId: entry.actorOpenId,
        eventOrActionId: entry.eventOrActionId,
        tier: entry.tier,
        createdAt,
      };

      this.audit = [sanitized, ...this.audit].slice(0, FEISHU_MAX_AUDIT_RECORDS);

      if (sanitized.direction === "outbound") {
        if (sanitized.status === "succeeded") {
          this.stats.outboundSent += 1;
          this.stats.lastOutboundAt = createdAt;
        } else if (sanitized.status === "failed") {
          this.stats.outboundFailed += 1;
        }
      } else if (sanitized.direction === "inbound") {
        if (sanitized.status === "succeeded") {
          this.stats.inboundProcessed += 1;
          this.stats.lastInboundAt = createdAt;
        } else if (sanitized.status === "rejected") {
          this.stats.inboundRejected += 1;
        } else if (sanitized.status === "deduplicated") {
          this.stats.inboundDeduplicated += 1;
        }
      }

      await this.persistUnlocked();
      return sanitized;
    });
  }
}
