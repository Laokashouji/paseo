import {
  MAIN_CHAT_STYLE_PRESETS,
  resolveActiveMainChatStylePresetId,
  resolveMainChatCustomPresets,
  type MainChatCapabilities,
  type MainChatIntervals,
  type MainChatSettings,
  type MainChatStyle,
} from "@getpaseo/protocol/main-chat";
import type { TFunction } from "i18next";

export type MainChatIntervalFieldKey = keyof MainChatIntervals;
export type MainChatCapabilityFieldKey = keyof MainChatCapabilities;

export interface MainChatIntervalFieldSpec {
  key: MainChatIntervalFieldKey;
  labelKey: string;
  hintKey: string;
  unitKey: string;
  min: number;
  max: number;
}

export const MAIN_CHAT_INTERVAL_FIELDS: readonly MainChatIntervalFieldSpec[] = [
  {
    key: "patrolIntervalSec",
    labelKey: "mainChat.settings.intervals.patrolIntervalSec",
    hintKey: "mainChat.settings.intervals.patrolIntervalSecHint",
    unitKey: "mainChat.settings.units.seconds",
    min: 15,
    max: 3600,
  },
  {
    key: "triageSettleSec",
    labelKey: "mainChat.settings.intervals.triageSettleSec",
    hintKey: "mainChat.settings.intervals.triageSettleSecHint",
    unitKey: "mainChat.settings.units.seconds",
    min: 5,
    max: 300,
  },
  {
    key: "stalledThresholdMin",
    labelKey: "mainChat.settings.intervals.stalledThresholdMin",
    hintKey: "mainChat.settings.intervals.stalledThresholdMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 2,
    max: 240,
  },
  {
    key: "noProgressThresholdMin",
    labelKey: "mainChat.settings.intervals.noProgressThresholdMin",
    hintKey: "mainChat.settings.intervals.noProgressThresholdMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 2,
    max: 120,
  },
  {
    key: "needsYouEscalateMin",
    labelKey: "mainChat.settings.intervals.needsYouEscalateMin",
    hintKey: "mainChat.settings.intervals.needsYouEscalateMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 1,
    max: 120,
  },
  {
    key: "wakeupCooldownMin",
    labelKey: "mainChat.settings.intervals.wakeupCooldownMin",
    hintKey: "mainChat.settings.intervals.wakeupCooldownMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 1,
    max: 240,
  },
];

export interface MainChatCapabilityFieldSpec {
  key: MainChatCapabilityFieldKey;
  labelKey: string;
  hintKey: string;
}

export const MAIN_CHAT_CAPABILITY_FIELDS: readonly MainChatCapabilityFieldSpec[] = [
  {
    key: "semanticTriageEnabled",
    labelKey: "mainChat.settings.capabilities.semanticTriage",
    hintKey: "mainChat.settings.capabilities.semanticTriageHint",
  },
  {
    key: "proactiveWakeupEnabled",
    labelKey: "mainChat.settings.capabilities.proactiveWakeup",
    hintKey: "mainChat.settings.capabilities.proactiveWakeupHint",
  },
  {
    key: "initialBriefingEnabled",
    labelKey: "mainChat.settings.capabilities.initialBriefing",
    hintKey: "mainChat.settings.capabilities.initialBriefingHint",
  },
  {
    key: "autoContinueManualErrors",
    labelKey: "mainChat.settings.capabilities.autoContinueManualErrors",
    hintKey: "mainChat.settings.capabilities.autoContinueManualErrorsHint",
  },
  {
    key: "autoDelegateManualQuestions",
    labelKey: "mainChat.settings.capabilities.autoDelegateManualQuestions",
    hintKey: "mainChat.settings.capabilities.autoDelegateManualQuestionsHint",
  },
  {
    key: "autoNudgeManualStalled",
    labelKey: "mainChat.settings.capabilities.autoNudgeManualStalled",
    hintKey: "mainChat.settings.capabilities.autoNudgeManualStalledHint",
  },
];

export interface MainChatStylePresetListItem {
  id: string;
  kind: "builtin" | "custom";
  name: string;
  shortName: string;
  description: string;
  baseStyle: MainChatStyle;
  customGuidance?: string;
  intervals: MainChatIntervals;
  capabilities: MainChatCapabilities;
}

export function countEnabledMainChatCapabilities(capabilities: MainChatCapabilities): number {
  let count = 0;
  for (const field of MAIN_CHAT_CAPABILITY_FIELDS) {
    if (capabilities[field.key]) count += 1;
  }
  return count;
}

export function formatMainChatPresetCompactSummary(
  intervals: MainChatIntervals,
  capabilities: MainChatCapabilities,
  t: TFunction,
): string {
  return t("mainChat.settings.style.compactMetaSummary", {
    patrol: intervals.patrolIntervalSec,
    stalled: intervals.stalledThresholdMin,
    noProgress: intervals.noProgressThresholdMin,
    cooldown: intervals.wakeupCooldownMin,
    enabledCaps: countEnabledMainChatCapabilities(capabilities),
    totalCaps: MAIN_CHAT_CAPABILITY_FIELDS.length,
  });
}

export function buildMainChatStylePresetItems(
  settings: Pick<MainChatSettings, "style" | "activePresetId" | "customPresets"> | null | undefined,
  t: TFunction,
): MainChatStylePresetListItem[] {
  const builtinItems: MainChatStylePresetListItem[] = [
    {
      id: "conservative",
      kind: "builtin",
      name: t("mainChat.settings.style.conservativeShortName"),
      shortName: t("mainChat.style.conservativeShort"),
      description: t("mainChat.settings.style.conservativeDescription"),
      baseStyle: "conservative",
      intervals: { ...MAIN_CHAT_STYLE_PRESETS.conservative.intervals },
      capabilities: { ...MAIN_CHAT_STYLE_PRESETS.conservative.capabilities },
    },
    {
      id: "proactive",
      kind: "builtin",
      name: t("mainChat.settings.style.proactiveShortName"),
      shortName: t("mainChat.style.proactiveShort"),
      description: t("mainChat.settings.style.proactiveDescription"),
      baseStyle: "proactive",
      intervals: { ...MAIN_CHAT_STYLE_PRESETS.proactive.intervals },
      capabilities: { ...MAIN_CHAT_STYLE_PRESETS.proactive.capabilities },
    },
  ];

  const customItems: MainChatStylePresetListItem[] = resolveMainChatCustomPresets(settings).map(
    (preset) => ({
      id: preset.id,
      kind: "custom",
      name: preset.name,
      shortName: preset.name,
      description:
        preset.description?.trim() ||
        t(
          preset.baseStyle === "proactive"
            ? "mainChat.settings.style.baseProactiveTag"
            : "mainChat.settings.style.baseConservativeTag",
        ),
      baseStyle: preset.baseStyle,
      customGuidance: preset.customGuidance,
      intervals: { ...preset.intervals },
      capabilities: { ...preset.capabilities },
    }),
  );

  return [...builtinItems, ...customItems];
}

export function findActiveMainChatStylePresetItem(
  settings: Pick<MainChatSettings, "style" | "activePresetId" | "customPresets"> | null | undefined,
  t: TFunction,
): MainChatStylePresetListItem {
  const items = buildMainChatStylePresetItems(settings, t);
  const activeId = resolveActiveMainChatStylePresetId(settings);
  return items.find((item) => item.id === activeId) ?? items[0]!;
}

export function formatSwitchedMainChatPresetToast(
  presetId: string,
  presetName: string,
  t: TFunction,
): string {
  if (presetId === "proactive") {
    return t("mainChat.settings.switchedProactiveToast");
  }
  if (presetId === "conservative") {
    return t("mainChat.settings.switchedConservativeToast");
  }
  return t("mainChat.settings.switchedPresetToast", { name: presetName });
}
