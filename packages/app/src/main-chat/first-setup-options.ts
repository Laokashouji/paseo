import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  AgentSelectOption,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";

export interface MainChatFirstSetupSelection {
  provider: AgentProvider;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
}

function normalizeOptionalString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveProviderSnapshotEntryByProvider(
  entries: readonly ProviderSnapshotEntry[] | null | undefined,
  provider: string | null | undefined,
): ProviderSnapshotEntry | null {
  const normalized = normalizeOptionalString(provider);
  if (!entries || !normalized) {
    return null;
  }
  return entries.find((entry) => entry.provider === normalized) ?? null;
}

export function resolveModelDefinitionFromEntry(
  entry: ProviderSnapshotEntry | null | undefined,
  modelId: string | null | undefined,
): AgentModelDefinition | null {
  const models = entry?.models;
  if (!models || models.length === 0) {
    return null;
  }
  const normalized = normalizeOptionalString(modelId);
  if (normalized) {
    return (
      models.find((model) => model.id === normalized) ??
      models.find((model) => model.aliases?.includes(normalized)) ??
      null
    );
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

export function getModelThinkingOptions(
  model: AgentModelDefinition | null | undefined,
): readonly AgentSelectOption[] {
  return model?.thinkingOptions && model.thinkingOptions.length > 0 ? model.thinkingOptions : [];
}

export function getProviderAvailableModes(
  entry: ProviderSnapshotEntry | null | undefined,
): readonly AgentMode[] {
  return entry?.modes && entry.modes.length > 0 ? entry.modes : [];
}

export function resolveDefaultThinkingOptionId(
  model: AgentModelDefinition | null | undefined,
): string {
  const options = getModelThinkingOptions(model);
  if (options.length === 0) {
    return "";
  }
  const preferred = normalizeOptionalString(model?.defaultThinkingOptionId);
  if (preferred && options.some((option) => option.id === preferred)) {
    return preferred;
  }
  const flaggedDefault = options.find((option) => option.isDefault);
  return flaggedDefault?.id ?? options[0]?.id ?? "";
}

export function resolveDefaultModeId(entry: ProviderSnapshotEntry | null | undefined): string {
  const modes = getProviderAvailableModes(entry);
  if (modes.length === 0) {
    return "";
  }
  const preferred = normalizeOptionalString(entry?.defaultModeId);
  if (preferred && modes.some((mode) => mode.id === preferred)) {
    return preferred;
  }
  return modes[0]?.id ?? "";
}

export function reconcileThinkingOptionId(
  currentThinkingOptionId: string,
  model: AgentModelDefinition | null | undefined,
): string {
  const options = getModelThinkingOptions(model);
  if (options.length === 0) {
    return "";
  }
  const normalized = normalizeOptionalString(currentThinkingOptionId);
  if (normalized && options.some((option) => option.id === normalized)) {
    return normalized;
  }
  return resolveDefaultThinkingOptionId(model);
}

export function reconcileModeId(
  currentModeId: string,
  entry: ProviderSnapshotEntry | null | undefined,
): string {
  const modes = getProviderAvailableModes(entry);
  if (modes.length === 0) {
    return "";
  }
  const normalized = normalizeOptionalString(currentModeId);
  if (normalized && modes.some((mode) => mode.id === normalized)) {
    return normalized;
  }
  return resolveDefaultModeId(entry);
}

export function buildMainChatFirstSetupSubmission(input: {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  entry: ProviderSnapshotEntry | null | undefined;
}): MainChatFirstSetupSelection | null {
  const provider = normalizeOptionalString(input.provider);
  if (!provider) {
    return null;
  }
  const model = normalizeOptionalString(input.model);
  const modelDef = resolveModelDefinitionFromEntry(input.entry, model);
  const effectiveThinking = reconcileThinkingOptionId(
    normalizeOptionalString(input.thinkingOptionId),
    modelDef,
  );
  const effectiveMode = reconcileModeId(normalizeOptionalString(input.modeId), input.entry);

  return {
    provider: provider as AgentProvider,
    ...(model ? { model } : {}),
    ...(effectiveThinking ? { thinkingOptionId: effectiveThinking } : {}),
    ...(effectiveMode ? { modeId: effectiveMode } : {}),
  };
}
