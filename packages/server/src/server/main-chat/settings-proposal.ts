import {
  MAIN_CHAT_ABOUT_ME_MAX_CHARS,
  MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN,
  MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS,
  MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS,
  MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES,
  MAIN_CHAT_MAX_LIMIT_FALLBACKS,
  MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN,
  MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS,
  MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS,
  MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES,
  MAIN_CHAT_OWNER_ALIAS_MAX_CHARS,
  MAIN_CHAT_OWNER_ALIASES_MAX_COUNT,
  MAIN_CHAT_PROPOSABLE_SETTINGS_KEYS,
  MainChatLimitFallbackEntrySchema,
  MainChatSettingsPatchSchema,
  formatMainChatModelSpec,
  isMainChatAutoCompactEnabled,
  isMainChatBackgroundFolded,
  isMainChatTasksQuiet,
  normalizeMainChatLimitFallbacks,
  resolveMainChatCacheKeepaliveConfig,
  resolveMainChatCompactionConfig,
  resolveMainChatLimitFallbacks,
  resolveMainChatNightMode,
  resolveMainChatProfile,
  type MainChatLimitFallbackEntry,
  type MainChatProposableSettingKey,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatSettingsProposalChange,
  type MainChatSettingsProposalRecord,
} from "@getpaseo/protocol/main-chat";

const ALLOWLIST_SET: ReadonlySet<string> = new Set<string>(MAIN_CHAT_PROPOSABLE_SETTINGS_KEYS);

export interface ProposeSettingsPatchInput {
  mainAgentId: string;
  title?: string;
  reason: string;
  changes: Record<string, unknown>;
}

export interface BuiltSettingsProposalResult {
  proposal: MainChatSettingsProposalRecord | null;
  noOpSummary: string | null;
}

function isProposableKey(key: string): key is MainChatProposableSettingKey {
  return ALLOWLIST_SET.has(key);
}

function makeProposalId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatBool(value: boolean): string {
  return value ? "开启" : "关闭";
}

function formatWindowCap(tokens: number | null): string {
  if (tokens === null) return "不封顶（跟随模型窗口）";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number(m.toFixed(1))}M tokens`;
  }
  return `${Math.round(tokens / 1000)}k tokens`;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatStyle(style: "conservative" | "proactive"): string {
  return style === "proactive" ? "激进模式" : "保守模式";
}

function formatNightBehavior(behavior: "throttle" | "hibernate"): string {
  return behavior === "hibernate" ? "完全休眠" : "低频巡检";
}

function formatFallbacks(entries: readonly MainChatLimitFallbackEntry[]): string {
  if (entries.length === 0) return "未配置（关闭）";
  return entries.map((entry) => formatMainChatModelSpec(entry.provider, entry.model)).join(" → ");
}

function formatShortText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "（空）";
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed;
}

function formatAliases(aliases: readonly string[]): string {
  return aliases.length > 0 ? aliases.join("、") : "（无）";
}

function expectBoolean(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`配置项 "${key}" 需要布尔值 (true/false)`);
  }
  return value;
}

function expectIntRange(key: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`配置项 "${key}" 必须是 ${min}–${max} 之间的整数`);
  }
  return value;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function areFallbacksEqual(
  left: readonly MainChatLimitFallbackEntry[],
  right: readonly MainChatLimitFallbackEntry[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i]!.provider !== right[i]!.provider) return false;
    if ((left[i]!.model ?? null) !== (right[i]!.model ?? null)) return false;
  }
  return true;
}

interface ValidatedKeyEntry {
  change: MainChatSettingsProposalChange | null;
  assign: (patch: MainChatSettingsPatch) => void;
}

const NOOP_ENTRY: ValidatedKeyEntry = { change: null, assign: () => undefined };

type SettingKeyHandler = (rawValue: unknown, current: MainChatSettings) => ValidatedKeyEntry;

function buildIntRangeHandler(spec: {
  key: MainChatProposableSettingKey;
  label: string;
  min: number;
  max: number;
  unit: string;
  readCurrent: (current: MainChatSettings) => number;
  assign: (patch: MainChatSettingsPatch, next: number) => void;
}): SettingKeyHandler {
  return (rawValue, current) => {
    const next = expectIntRange(spec.key, rawValue, spec.min, spec.max);
    const before = spec.readCurrent(current);
    if (next === before) return NOOP_ENTRY;
    return {
      change: {
        key: spec.key,
        label: spec.label,
        beforeDisplay: `${before} ${spec.unit}`,
        afterDisplay: `${next} ${spec.unit}`,
      },
      assign: (patch) => spec.assign(patch, next),
    };
  };
}

function buildBoolHandler(spec: {
  key: MainChatProposableSettingKey;
  label: string;
  readCurrent: (current: MainChatSettings) => boolean;
  assign: (patch: MainChatSettingsPatch, next: boolean) => void;
}): SettingKeyHandler {
  return (rawValue, current) => {
    const next = expectBoolean(spec.key, rawValue);
    const before = spec.readCurrent(current);
    if (next === before) return NOOP_ENTRY;
    return {
      change: {
        key: spec.key,
        label: spec.label,
        beforeDisplay: formatBool(before),
        afterDisplay: formatBool(next),
      },
      assign: (patch) => spec.assign(patch, next),
    };
  };
}

function validateLimitFallbacksSetting(
  rawValue: unknown,
  current: MainChatSettings,
): ValidatedKeyEntry {
  if (!Array.isArray(rawValue)) {
    throw new Error('配置项 "limitFallbacks" 必须是备用模型列表数组');
  }
  if (rawValue.length > MAIN_CHAT_MAX_LIMIT_FALLBACKS) {
    throw new Error(`备用模型最多配置 ${MAIN_CHAT_MAX_LIMIT_FALLBACKS} 项`);
  }
  const parsedEntries: MainChatLimitFallbackEntry[] = rawValue.map((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      const slashIdx = trimmed.indexOf("/");
      const candidate =
        slashIdx > 0
          ? { provider: trimmed.slice(0, slashIdx), model: trimmed.slice(slashIdx + 1) }
          : { provider: trimmed, model: null };
      return MainChatLimitFallbackEntrySchema.parse(candidate);
    }
    return MainChatLimitFallbackEntrySchema.parse(entry);
  });
  const limitFallbacks = resolveMainChatLimitFallbacks(current);
  const next = normalizeMainChatLimitFallbacks(parsedEntries);
  if (areFallbacksEqual(limitFallbacks, next)) return NOOP_ENTRY;
  return {
    change: {
      key: "limitFallbacks",
      label: "限额备用模型顺序",
      beforeDisplay: formatFallbacks(limitFallbacks),
      afterDisplay: formatFallbacks(next),
    },
    assign: (patch) => {
      patch.limitFallbacks = next;
    },
  };
}

function validateOwnerAliasesSetting(
  rawValue: unknown,
  current: MainChatSettings,
): ValidatedKeyEntry {
  if (!Array.isArray(rawValue) || rawValue.length > MAIN_CHAT_OWNER_ALIASES_MAX_COUNT) {
    throw new Error(
      `配置项 "profile.ownerAliases" 必须是最多 ${MAIN_CHAT_OWNER_ALIASES_MAX_COUNT} 项的字符串数组`,
    );
  }
  const next: string[] = [];
  for (const item of rawValue) {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > MAIN_CHAT_OWNER_ALIAS_MAX_CHARS
    ) {
      throw new Error(`称呼别名必须为 1–${MAIN_CHAT_OWNER_ALIAS_MAX_CHARS} 字的非空字符串`);
    }
    const trimmed = item.trim();
    if (!next.includes(trimmed)) next.push(trimmed);
  }
  const profile = resolveMainChatProfile(current);
  if (areStringArraysEqual(profile.ownerAliases, next)) return NOOP_ENTRY;
  return {
    change: {
      key: "profile.ownerAliases",
      label: "称呼别名",
      beforeDisplay: formatAliases(profile.ownerAliases),
      afterDisplay: formatAliases(next),
    },
    assign: (patch) => {
      patch.profile = { ...patch.profile, ownerAliases: next };
    },
  };
}

const SETTING_KEY_HANDLERS: Record<MainChatProposableSettingKey, SettingKeyHandler> = {
  title: (rawValue, current) => {
    if (
      typeof rawValue !== "string" ||
      rawValue.trim().length === 0 ||
      rawValue.trim().length > 40
    ) {
      throw new Error('配置项 "title" 必须是 1–40 字的非空字符串');
    }
    const next = rawValue.trim();
    if (next === current.title) return NOOP_ENTRY;
    return {
      change: {
        key: "title",
        label: "主对话名称",
        beforeDisplay: current.title,
        afterDisplay: next,
      },
      assign: (patch) => {
        patch.title = next;
      },
    };
  },
  style: (rawValue, current) => {
    if (rawValue !== "conservative" && rawValue !== "proactive") {
      throw new Error('配置项 "style" 仅支持 "conservative" 或 "proactive"');
    }
    if (rawValue === current.style) return NOOP_ENTRY;
    return {
      change: {
        key: "style",
        label: "工作风格",
        beforeDisplay: formatStyle(current.style),
        afterDisplay: formatStyle(rawValue),
      },
      assign: (patch) => {
        patch.applyPreset = rawValue;
      },
    };
  },
  autoCompactEnabled: buildBoolHandler({
    key: "autoCompactEnabled",
    label: "空闲自动压缩上下文",
    readCurrent: (current) => isMainChatAutoCompactEnabled(current),
    assign: (patch, next) => {
      patch.autoCompactEnabled = next;
    },
  }),
  mainBackgroundFolded: buildBoolHandler({
    key: "mainBackgroundFolded",
    label: "后台轮次默认折叠",
    readCurrent: (current) => isMainChatBackgroundFolded(current),
    assign: (patch, next) => {
      patch.mainBackgroundFolded = next;
    },
  }),
  mainTasksQuiet: buildBoolHandler({
    key: "mainTasksQuiet",
    label: "主对话任务默认静默",
    readCurrent: (current) => isMainChatTasksQuiet(current),
    assign: (patch, next) => {
      patch.mainTasksQuiet = next;
    },
  }),
  "compaction.windowCapTokens": (rawValue, current) => {
    const compaction = resolveMainChatCompactionConfig(current);
    const next =
      rawValue === null || rawValue === 0
        ? null
        : expectIntRange(
            "compaction.windowCapTokens",
            rawValue,
            MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS,
            MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS,
          );
    if (next === compaction.windowCapTokens) return NOOP_ENTRY;
    return {
      change: {
        key: "compaction.windowCapTokens",
        label: "压缩窗口封顶",
        beforeDisplay: formatWindowCap(compaction.windowCapTokens),
        afterDisplay: formatWindowCap(next),
      },
      assign: (patch) => {
        patch.compaction = { ...patch.compaction, windowCapTokens: next };
      },
    };
  },
  "compaction.idlePrecompactMinIdleMin": buildIntRangeHandler({
    key: "compaction.idlePrecompactMinIdleMin",
    label: "空闲预压缩等待分钟数",
    min: MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES,
    max: MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES,
    unit: "分钟",
    readCurrent: (current) => resolveMainChatCompactionConfig(current).idlePrecompactMinIdleMin,
    assign: (patch, next) => {
      patch.compaction = { ...patch.compaction, idlePrecompactMinIdleMin: next };
    },
  }),
  "cacheKeepalive.enabled": buildBoolHandler({
    key: "cacheKeepalive.enabled",
    label: "Prompt Cache 定时保活",
    readCurrent: (current) => resolveMainChatCacheKeepaliveConfig(current).enabled,
    assign: (patch, next) => {
      patch.cacheKeepalive = { ...patch.cacheKeepalive, enabled: next };
    },
  }),
  "cacheKeepalive.intervalMinutes": buildIntRangeHandler({
    key: "cacheKeepalive.intervalMinutes",
    label: "缓存保活间隔",
    min: MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN,
    max: MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN,
    unit: "分钟",
    readCurrent: (current) => resolveMainChatCacheKeepaliveConfig(current).intervalMinutes,
    assign: (patch, next) => {
      patch.cacheKeepalive = { ...patch.cacheKeepalive, intervalMinutes: next };
    },
  }),
  "cacheKeepalive.maxRequests": buildIntRangeHandler({
    key: "cacheKeepalive.maxRequests",
    label: "缓存保活最大次数",
    min: MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS,
    max: MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS,
    unit: "次",
    readCurrent: (current) => resolveMainChatCacheKeepaliveConfig(current).maxRequests,
    assign: (patch, next) => {
      patch.cacheKeepalive = { ...patch.cacheKeepalive, maxRequests: next };
    },
  }),
  "nightMode.enabled": buildBoolHandler({
    key: "nightMode.enabled",
    label: "夜间节能模式",
    readCurrent: (current) => resolveMainChatNightMode(current).enabled,
    assign: (patch, next) => {
      patch.nightMode = { ...patch.nightMode, enabled: next };
    },
  }),
  "nightMode.startHour": (rawValue, current) => {
    const nightMode = resolveMainChatNightMode(current);
    const next = expectIntRange("nightMode.startHour", rawValue, 0, 23);
    if (next === nightMode.startHour) return NOOP_ENTRY;
    return {
      change: {
        key: "nightMode.startHour",
        label: "夜间开始时间",
        beforeDisplay: formatHour(nightMode.startHour),
        afterDisplay: formatHour(next),
      },
      assign: (patch) => {
        patch.nightMode = { ...patch.nightMode, startHour: next };
      },
    };
  },
  "nightMode.endHour": (rawValue, current) => {
    const nightMode = resolveMainChatNightMode(current);
    const next = expectIntRange("nightMode.endHour", rawValue, 0, 23);
    if (next === nightMode.endHour) return NOOP_ENTRY;
    return {
      change: {
        key: "nightMode.endHour",
        label: "夜间结束时间",
        beforeDisplay: formatHour(nightMode.endHour),
        afterDisplay: formatHour(next),
      },
      assign: (patch) => {
        patch.nightMode = { ...patch.nightMode, endHour: next };
      },
    };
  },
  "nightMode.behavior": (rawValue, current) => {
    if (rawValue !== "throttle" && rawValue !== "hibernate") {
      throw new Error('配置项 "nightMode.behavior" 仅支持 "throttle" 或 "hibernate"');
    }
    const nightMode = resolveMainChatNightMode(current);
    if (rawValue === nightMode.behavior) return NOOP_ENTRY;
    return {
      change: {
        key: "nightMode.behavior",
        label: "夜间策略",
        beforeDisplay: formatNightBehavior(nightMode.behavior),
        afterDisplay: formatNightBehavior(rawValue),
      },
      assign: (patch) => {
        patch.nightMode = { ...patch.nightMode, behavior: rawValue };
      },
    };
  },
  "nightMode.patrolIntervalSec": buildIntRangeHandler({
    key: "nightMode.patrolIntervalSec",
    label: "夜间巡检间隔",
    min: 60,
    max: 3600,
    unit: "秒",
    readCurrent: (current) => resolveMainChatNightMode(current).patrolIntervalSec,
    assign: (patch, next) => {
      patch.nightMode = { ...patch.nightMode, patrolIntervalSec: next };
    },
  }),
  "nightMode.autoHibernateAfterIdleMin": buildIntRangeHandler({
    key: "nightMode.autoHibernateAfterIdleMin",
    label: "夜间自动休眠闲置阈值",
    min: 0,
    max: 480,
    unit: "分钟",
    readCurrent: (current) => resolveMainChatNightMode(current).autoHibernateAfterIdleMin,
    assign: (patch, next) => {
      patch.nightMode = { ...patch.nightMode, autoHibernateAfterIdleMin: next };
    },
  }),
  "intervals.patrolIntervalSec": buildIntRangeHandler({
    key: "intervals.patrolIntervalSec",
    label: "后台巡检周期",
    min: 15,
    max: 3600,
    unit: "秒",
    readCurrent: (current) => current.intervals.patrolIntervalSec,
    assign: (patch, next) => {
      patch.intervals = { ...patch.intervals, patrolIntervalSec: next };
    },
  }),
  "intervals.triageSettleSec": buildIntRangeHandler({
    key: "intervals.triageSettleSec",
    label: "分诊稳定等待",
    min: 5,
    max: 300,
    unit: "秒",
    readCurrent: (current) => current.intervals.triageSettleSec,
    assign: (patch, next) => {
      patch.intervals = { ...patch.intervals, triageSettleSec: next };
    },
  }),
  "intervals.stalledThresholdMin": buildIntRangeHandler({
    key: "intervals.stalledThresholdMin",
    label: "停滞判定阈值",
    min: 2,
    max: 240,
    unit: "分钟",
    readCurrent: (current) => current.intervals.stalledThresholdMin,
    assign: (patch, next) => {
      patch.intervals = { ...patch.intervals, stalledThresholdMin: next };
    },
  }),
  "intervals.noProgressThresholdMin": buildIntRangeHandler({
    key: "intervals.noProgressThresholdMin",
    label: "无进展提醒阈值",
    min: 2,
    max: 120,
    unit: "分钟",
    readCurrent: (current) => current.intervals.noProgressThresholdMin,
    assign: (patch, next) => {
      patch.intervals = { ...patch.intervals, noProgressThresholdMin: next };
    },
  }),
  "intervals.needsYouEscalateMin": buildIntRangeHandler({
    key: "intervals.needsYouEscalateMin",
    label: "待拍板升级延迟",
    min: 1,
    max: 120,
    unit: "分钟",
    readCurrent: (current) => current.intervals.needsYouEscalateMin,
    assign: (patch, next) => {
      patch.intervals = { ...patch.intervals, needsYouEscalateMin: next };
    },
  }),
  "intervals.wakeupCooldownMin": buildIntRangeHandler({
    key: "intervals.wakeupCooldownMin",
    label: "主动唤醒冷却",
    min: 1,
    max: 120,
    unit: "分钟",
    readCurrent: (current) => current.intervals.wakeupCooldownMin,
    assign: (patch, next) => {
      patch.intervals = { ...patch.intervals, wakeupCooldownMin: next };
    },
  }),
  limitFallbacks: validateLimitFallbacksSetting,
  "profile.aboutMe": (rawValue, current) => {
    if (typeof rawValue !== "string" || rawValue.length > MAIN_CHAT_ABOUT_ME_MAX_CHARS) {
      throw new Error(
        `配置项 "profile.aboutMe" 必须是字符串且不超过 ${MAIN_CHAT_ABOUT_ME_MAX_CHARS} 字`,
      );
    }
    const profile = resolveMainChatProfile(current);
    const next = rawValue.trim();
    if (next === profile.aboutMe.trim()) return NOOP_ENTRY;
    return {
      change: {
        key: "profile.aboutMe",
        label: "关于我（个人档案）",
        beforeDisplay: formatShortText(profile.aboutMe),
        afterDisplay: formatShortText(next),
      },
      assign: (patch) => {
        patch.profile = { ...patch.profile, aboutMe: next };
      },
    };
  },
  "profile.ownerAliases": validateOwnerAliasesSetting,
};

function validateAndDiffSettingKey(
  key: MainChatProposableSettingKey,
  rawValue: unknown,
  current: MainChatSettings,
): ValidatedKeyEntry {
  return SETTING_KEY_HANDLERS[key](rawValue, current);
}

/**
 * Validates a proposed settings change map strictly against `MAIN_CHAT_PROPOSABLE_SETTINGS_KEYS`,
 * computes human-readable `before → after` diffs, and constructs a pending proposal record.
 * NEVER mutates or persists settings — persistence only occurs after explicit user approval.
 */
export function buildSettingsProposal(
  input: ProposeSettingsPatchInput,
  currentSettings: MainChatSettings,
  nowIso: string,
): BuiltSettingsProposalResult {
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("发起配置变更提案时必须填写清晰理由 (reason)");
  }
  const entries = Object.entries(input.changes);
  if (entries.length === 0) {
    throw new Error("配置变更内容不能为空");
  }

  const patch: MainChatSettingsPatch = {};
  const changes: MainChatSettingsProposalChange[] = [];

  for (const [rawKey, rawValue] of entries) {
    if (!isProposableKey(rawKey)) {
      throw new Error(
        `配置项 "${rawKey}" 不在允许自助提案的白名单内（禁止修改开关/鉴权/系统级配置）`,
      );
    }
    const validated = validateAndDiffSettingKey(rawKey, rawValue, currentSettings);
    if (validated.change) {
      changes.push(validated.change);
      validated.assign(patch);
    }
  }

  if (changes.length === 0) {
    return {
      proposal: null,
      noOpSummary: "所有提议的配置项均与当前值一致，无需变更。",
    };
  }

  const parsedPatch = MainChatSettingsPatchSchema.parse(patch);
  const title =
    input.title?.trim() ||
    (changes.length === 1 ? `调整「${changes[0]!.label}」` : `调整 ${changes.length} 项主对话配置`);

  return {
    proposal: {
      id: makeProposalId(),
      mainAgentId: input.mainAgentId,
      title,
      reason,
      patch: parsedPatch,
      changes,
      status: "pending",
      createdAt: nowIso,
      resolvedAt: null,
      resolvedNote: null,
      appliedError: null,
    },
    noOpSummary: null,
  };
}
