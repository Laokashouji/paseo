import {
  MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY,
  MAIN_CHAT_MODEL_PURPOSES,
  formatMainChatModelSpec,
  isBuiltinMainChatModelProfileId,
  normalizeMainChatModelSlots,
  resolveBuiltinMainChatModelProfiles,
  resolveMainChatLimitFallbacks,
  resolveMainChatModelConfig,
  resolveMainChatModelSlot,
  type MainChatLimitFallbackEntry,
  type MainChatModelConfig,
  type MainChatModelProfile,
  type MainChatModelProfileSwitchEvent,
  type MainChatModelPurpose,
  type MainChatModelSlotBinding,
  type MainChatModelSlots,
  type MainChatSettings,
  type ResolvedMainChatModelSlot,
} from "@getpaseo/protocol/main-chat";

const PROVIDER_SLUG_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export interface AvailableProviderInfo {
  provider: string;
  enabled: boolean;
}

export class ModelProfileValidationError extends Error {
  constructor(
    message: string,
    public readonly slot?: MainChatModelPurpose,
  ) {
    super(message);
    this.name = "ModelProfileValidationError";
  }
}

export interface AtomicModelProfileSwitchInput {
  currentSettings: MainChatSettings;
  profileId?: string;
  rollback?: boolean;
  actor: "user" | "proposal" | "tool";
  liveMainBinding?: Pick<
    MainChatModelSlotBinding,
    "provider" | "model" | "thinkingOptionId"
  > | null;
  availableProviders?: readonly AvailableProviderInfo[];
  nowIso: string;
}

export interface AtomicModelProfileSwitchResult {
  nextSettings: MainChatSettings;
  activeProfileId: string | null;
  changedSlots: MainChatModelPurpose[];
  event: MainChatModelProfileSwitchEvent | null;
}

export interface DispatchSlotModelResolution {
  resolved: ResolvedMainChatModelSlot;
  providerSpec: string | null;
  provider: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

export interface FailedTaskFallbackPickInput {
  currentProvider: string | null;
  currentModel: string | null;
  attemptedSpecs?: ReadonlySet<string>;
  settings: MainChatSettings;
  explicitOverride?: {
    provider?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  } | null;
  availableProviders?: readonly AvailableProviderInfo[];
}

export interface FailedTaskFallbackPickResult {
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
  source: "explicit" | "limit_fallback";
}

function makeSwitchEventId(): string {
  return `mps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeSpecKey(provider: string, model: string | null | undefined): string {
  return `${provider.trim().toLowerCase()}::${(model?.trim() ?? "").toLowerCase()}`;
}

function areBindingsEqual(
  left: MainChatModelSlotBinding | null | undefined,
  right: MainChatModelSlotBinding | null | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.provider.trim() === right.provider.trim() &&
    (left.model?.trim() || null) === (right.model?.trim() || null) &&
    (left.thinkingOptionId?.trim() || null) === (right.thinkingOptionId?.trim() || null)
  );
}

function diffSlots(before: MainChatModelSlots, after: MainChatModelSlots): MainChatModelPurpose[] {
  const changed: MainChatModelPurpose[] = [];
  for (const purpose of MAIN_CHAT_MODEL_PURPOSES) {
    if (!areBindingsEqual(before[purpose], after[purpose])) {
      changed.push(purpose);
    }
  }
  return changed;
}

function isProviderEnabledInList(
  provider: string,
  availableProviders?: readonly AvailableProviderInfo[],
): { ok: boolean; reason?: string } {
  if (!availableProviders || availableProviders.length === 0) {
    return { ok: true };
  }
  const matched = availableProviders.find(
    (entry) => entry.provider.trim().toLowerCase() === provider.trim().toLowerCase(),
  );
  if (!matched) {
    return { ok: false, reason: `未找到可用的模型 Provider「${provider}」` };
  }
  if (!matched.enabled) {
    return { ok: false, reason: `模型 Provider「${provider}」当前未启用` };
  }
  return { ok: true };
}

/**
 * Validates all non-empty slot bindings atomically before writing any configuration change.
 * Throws `ModelProfileValidationError` if any slot is invalid so partial updates never persist.
 */
export function validateModelSlotsAtomic(
  slots: MainChatModelSlots,
  availableProviders?: readonly AvailableProviderInfo[],
): MainChatModelSlots {
  const normalized = normalizeMainChatModelSlots(slots);
  for (const purpose of MAIN_CHAT_MODEL_PURPOSES) {
    const binding = normalized[purpose];
    if (!binding) continue;
    const provider = binding.provider.trim();
    if (!PROVIDER_SLUG_RE.test(provider)) {
      throw new ModelProfileValidationError(
        `槽位「${purpose}」的 Provider 名称非法：${provider}`,
        purpose,
      );
    }
    if (binding.model && /[\r\n\t]/.test(binding.model)) {
      throw new ModelProfileValidationError(
        `槽位「${purpose}」的模型名称包含非法控制字符`,
        purpose,
      );
    }
    const providerCheck = isProviderEnabledInList(provider, availableProviders);
    if (!providerCheck.ok) {
      throw new ModelProfileValidationError(
        `槽位「${purpose}」校验失败：${providerCheck.reason ?? "Provider 不可用"}`,
        purpose,
      );
    }
  }
  return normalized;
}

export function listAvailableModelProfiles(
  settings: MainChatSettings,
  liveMainBinding?: Pick<
    MainChatModelSlotBinding,
    "provider" | "model" | "thinkingOptionId"
  > | null,
): MainChatModelProfile[] {
  const config = resolveMainChatModelConfig(settings);
  const baseBinding = config.slots?.main ?? liveMainBinding ?? null;
  const builtins = resolveBuiltinMainChatModelProfiles(baseBinding);
  const custom = config.customProfiles ?? [];
  return [...builtins, ...custom];
}

/**
 * Atomically switches to a built-in or custom model profile, or rolls back to the previous
 * snapshot. Validates every target slot before producing the new settings object; any validation
 * failure throws without mutating `currentSettings`.
 */
export function computeAtomicModelProfileSwitch(
  input: AtomicModelProfileSwitchInput,
): AtomicModelProfileSwitchResult {
  const currentConfig = resolveMainChatModelConfig(input.currentSettings);
  const currentSlots = normalizeMainChatModelSlots(currentConfig.slots);
  const currentProfileId = currentConfig.activeProfileId ?? null;

  let targetProfileId: string | null = null;
  let targetSlots: MainChatModelSlots;
  let action: "switch" | "rollback";

  if (input.rollback) {
    if (!currentConfig.rollbackSnapshot) {
      throw new ModelProfileValidationError("当前没有可回滚的上一版模型档位快照");
    }
    action = "rollback";
    targetProfileId = currentConfig.rollbackSnapshot.profileId ?? null;
    targetSlots = validateModelSlotsAtomic(
      currentConfig.rollbackSnapshot.slots,
      input.availableProviders,
    );
  } else {
    const requestedId = input.profileId?.trim();
    if (!requestedId) {
      throw new ModelProfileValidationError("切换模型档位必须指定 profileId 或 rollback=true");
    }
    const allProfiles = listAvailableModelProfiles(input.currentSettings, input.liveMainBinding);
    const matched = allProfiles.find((entry) => entry.id === requestedId);
    if (!matched) {
      throw new ModelProfileValidationError(`找不到指定的模型档位：${requestedId}`);
    }
    action = "switch";
    targetProfileId = matched.id;
    targetSlots = validateModelSlotsAtomic(matched.slots, input.availableProviders);
  }

  const changedSlots = diffSlots(currentSlots, targetSlots);
  const profileChanged = currentProfileId !== targetProfileId;
  if (changedSlots.length === 0 && !profileChanged) {
    return {
      nextSettings: input.currentSettings,
      activeProfileId: targetProfileId,
      changedSlots: [],
      event: null,
    };
  }

  const event: MainChatModelProfileSwitchEvent = {
    id: makeSwitchEventId(),
    action,
    fromProfileId: currentProfileId,
    toProfileId: targetProfileId,
    changedSlots,
    actor: input.actor,
    createdAt: input.nowIso,
  };

  const nextModelConfig: MainChatModelConfig = {
    activeProfileId: targetProfileId,
    slots: targetSlots,
    customProfiles: currentConfig.customProfiles ?? [],
    rollbackSnapshot: {
      profileId: currentProfileId,
      slots: currentSlots,
      savedAt: input.nowIso,
    },
    switchHistory: [event, ...(currentConfig.switchHistory ?? [])].slice(
      0,
      MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY,
    ),
  };

  const nextSettings: MainChatSettings = {
    ...input.currentSettings,
    modelConfig: nextModelConfig,
  };

  return {
    nextSettings,
    activeProfileId: targetProfileId,
    changedSlots,
    event,
  };
}

export function resolveSlotModelForDispatch(input: {
  purpose: MainChatModelPurpose;
  settings: MainChatSettings;
  liveMainBinding?: Pick<
    MainChatModelSlotBinding,
    "provider" | "model" | "thinkingOptionId"
  > | null;
}): DispatchSlotModelResolution {
  const resolved = resolveMainChatModelSlot({
    purpose: input.purpose,
    settings: input.settings,
    liveMainBinding: input.liveMainBinding,
  });
  if (!resolved.binding) {
    return {
      resolved,
      providerSpec: null,
      provider: null,
      model: null,
      thinkingOptionId: null,
    };
  }
  const provider = resolved.binding.provider.trim();
  const model = resolved.binding.model?.trim() || null;
  const thinkingOptionId = resolved.binding.thinkingOptionId?.trim() || null;
  return {
    resolved,
    providerSpec: formatMainChatModelSpec(provider, model),
    provider,
    model,
    thinkingOptionId,
  };
}

function resolveExplicitFallbackOverride(
  explicitOverride: FailedTaskFallbackPickInput["explicitOverride"],
  availableProviders: FailedTaskFallbackPickInput["availableProviders"],
): FailedTaskFallbackPickResult | null {
  const provider = explicitOverride?.provider?.trim();
  if (!provider) return null;
  if (!PROVIDER_SLUG_RE.test(provider)) {
    throw new ModelProfileValidationError(`指定的目标 Provider 非法：${provider}`);
  }
  const providerCheck = isProviderEnabledInList(provider, availableProviders);
  if (!providerCheck.ok) {
    throw new ModelProfileValidationError(providerCheck.reason ?? `Provider「${provider}」不可用`);
  }
  return {
    provider,
    model: explicitOverride?.model?.trim() || null,
    thinkingOptionId: explicitOverride?.thinkingOptionId?.trim() || null,
    source: "explicit",
  };
}

/**
 * Selects the target model for one-click failed-task retry with fallback:
 * - Honors explicit user selection when provided (after validating provider availability).
 * - Otherwise walks `settings.limitFallbacks` in priority order, skipping the currently failed
 *   model spec, previously attempted specs, and disabled providers.
 */
export function pickNextFallbackForFailedTask(
  input: FailedTaskFallbackPickInput,
): FailedTaskFallbackPickResult | null {
  const explicit = resolveExplicitFallbackOverride(
    input.explicitOverride,
    input.availableProviders,
  );
  if (explicit) return explicit;

  const fallbacks: readonly MainChatLimitFallbackEntry[] = resolveMainChatLimitFallbacks(
    input.settings,
  );
  if (fallbacks.length === 0) return null;

  const tried = new Set<string>(input.attemptedSpecs ?? []);
  if (input.currentProvider?.trim()) {
    tried.add(normalizeSpecKey(input.currentProvider, input.currentModel));
  }

  for (const entry of fallbacks) {
    const key = normalizeSpecKey(entry.provider, entry.model ?? null);
    if (tried.has(key)) continue;
    const providerCheck = isProviderEnabledInList(entry.provider, input.availableProviders);
    if (!providerCheck.ok) continue;
    return {
      provider: entry.provider.trim(),
      model: entry.model?.trim() || null,
      thinkingOptionId: null,
      source: "limit_fallback",
    };
  }
  return null;
}

export function formatModelProfileLabel(
  profileId: string | null | undefined,
  settings?: MainChatSettings | null,
): string {
  const trimmed = profileId?.trim();
  if (!trimmed) return "自定义槽位";
  if (isBuiltinMainChatModelProfileId(trimmed)) {
    if (trimmed === "performance") return "性能优先 (performance)";
    if (trimmed === "economy") return "经济省额 (economy)";
    return "均衡推荐 (balanced)";
  }
  const custom = resolveMainChatModelConfig(settings).customProfiles?.find(
    (entry) => entry.id === trimmed,
  );
  return custom ? `${custom.name} (${custom.id})` : trimmed;
}
