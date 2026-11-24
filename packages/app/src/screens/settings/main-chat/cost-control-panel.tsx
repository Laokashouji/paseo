import {
  MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN,
  MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS,
  MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS,
  MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES,
  MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN,
  MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS,
  MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS,
  MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES,
  isMainChatAutoCompactEnabled,
  resolveMainChatCacheKeepaliveConfig,
  resolveMainChatCompactionConfig,
  type MainChatCacheKeepaliveStatus,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { Cpu, Sparkles } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedCpuIcon = withUnistyles(Cpu);
const ThemedSparklesIcon = withUnistyles(Sparkles);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

interface CapPreset {
  id: string;
  tokens: number | null;
  labelKey?: string;
  literalLabel?: string;
}

const COMPACTION_CAP_PRESETS: readonly CapPreset[] = [
  { id: "200k", tokens: 200_000, literalLabel: "200k" },
  { id: "400k", tokens: 400_000, literalLabel: "400k" },
  { id: "600k", tokens: 600_000, literalLabel: "600k" },
  { id: "uncapped", tokens: null, labelKey: "mainChat.costControl.windowCapUncapped" },
];

const CapPresetChip = memo(function CapPresetChip({
  preset,
  selected,
  disabled,
  onSelect,
}: {
  preset: CapPreset;
  selected: boolean;
  disabled: boolean;
  onSelect: (tokens: number | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onSelect(preset.tokens);
  }, [onSelect, preset.tokens]);

  const chipStyle = useMemo(
    () => (selected ? [styles.presetChip, styles.presetChipActive] : styles.presetChip),
    [selected],
  );
  const textStyle = useMemo(
    () => (selected ? [styles.presetChipText, styles.presetChipTextActive] : styles.presetChipText),
    [selected],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      style={chipStyle}
      highlightStyle={styles.subtleHighlight}
      testID={`cost-control-cap-preset-${preset.id}`}
    >
      <Text style={textStyle} numberOfLines={1}>
        {preset.labelKey ? t(preset.labelKey) : preset.literalLabel}
      </Text>
    </PressHighlight>
  );
});

/**
 * Parses a custom compaction window cap input string:
 * - Empty input → `null` (uncapped, follow model context window).
 * - Thousand-unit input such as `"320"` or `"320k"` → `320_000` tokens.
 * - Full raw token count such as `"320000"` or `"320,000"` → `320_000` tokens.
 * - Out-of-range or non-numeric input → `"invalid"`.
 */
export function parseCustomCompactionCapTokens(raw: string): number | null | "invalid" {
  const trimmed = raw.trim().replaceAll(",", "");
  if (!trimmed) return null;

  const explicitKMatch = /^(\d+)\s*[kK]$/.exec(trimmed);
  if (explicitKMatch) {
    const tokens = Number.parseInt(explicitKMatch[1]!, 10) * 1000;
    if (
      tokens >= MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS &&
      tokens <= MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS
    ) {
      return tokens;
    }
    return "invalid";
  }

  if (!/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";

  // Ranges are disjoint: [100, 10_000] k-tokens vs [100_000, 10_000_000] raw tokens.
  if (
    parsed >= MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS &&
    parsed <= MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS
  ) {
    return parsed;
  }
  const scaled = parsed * 1000;
  if (
    scaled >= MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS &&
    scaled <= MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS
  ) {
    return scaled;
  }
  return "invalid";
}

export interface MainChatCostControlPanelProps {
  serverId: string;
  settings: MainChatSettings;
  cacheKeepaliveStatus?: MainChatCacheKeepaliveStatus | null;
  disabled: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => Promise<void> | void;
}

/**
 * Main Chat Settings panel for P0-3:
 * - Auto-compact toggle, configurable compaction window cap (default 400k or uncapped),
 *   and continuous idle pre-compaction wait minutes.
 * - Prompt Cache periodic keepalive policy (toggle, interval 1–55m, max pings 1–144) + live status.
 */
export const MainChatCostControlPanel = memo(function MainChatCostControlPanel({
  serverId,
  settings,
  cacheKeepaliveStatus,
  disabled,
  onApplyPatch,
}: MainChatCostControlPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const autoCompactEnabled = isMainChatAutoCompactEnabled(settings);
  const compactionConfig = useMemo(() => resolveMainChatCompactionConfig(settings), [settings]);
  const keepaliveConfig = useMemo(() => resolveMainChatCacheKeepaliveConfig(settings), [settings]);

  const capInK =
    compactionConfig.windowCapTokens !== null
      ? String(Math.round(compactionConfig.windowCapTokens / 1000))
      : "";
  const [capKDraft, setCapKDraft] = useState(capInK);
  const [idleMinDraft, setIdleMinDraft] = useState(
    String(compactionConfig.idlePrecompactMinIdleMin),
  );
  const [keepaliveIntervalDraft, setKeepaliveIntervalDraft] = useState(
    String(keepaliveConfig.intervalMinutes),
  );
  const [keepaliveMaxDraft, setKeepaliveMaxDraft] = useState(String(keepaliveConfig.maxRequests));

  useEffect(() => {
    setCapKDraft(capInK);
  }, [capInK]);

  useEffect(() => {
    setIdleMinDraft(String(compactionConfig.idlePrecompactMinIdleMin));
  }, [compactionConfig.idlePrecompactMinIdleMin]);

  useEffect(() => {
    setKeepaliveIntervalDraft(String(keepaliveConfig.intervalMinutes));
    setKeepaliveMaxDraft(String(keepaliveConfig.maxRequests));
  }, [keepaliveConfig.intervalMinutes, keepaliveConfig.maxRequests]);

  const handleToggleAutoCompact = useCallback(
    (next: boolean) => {
      void onApplyPatch(
        { autoCompactEnabled: next },
        next
          ? t("mainChat.compaction.autoEnabledToast")
          : t("mainChat.compaction.autoDisabledToast"),
      );
    },
    [onApplyPatch, t],
  );

  const handleSelectCapPreset = useCallback(
    (tokens: number | null) => {
      void onApplyPatch(
        { compaction: { windowCapTokens: tokens } },
        t("mainChat.costControl.windowCapSavedToast"),
      );
    },
    [onApplyPatch, t],
  );

  const handleSaveCustomCap = useCallback(() => {
    const parsedTokens = parseCustomCompactionCapTokens(capKDraft);
    if (parsedTokens === "invalid") {
      toast.error(t("mainChat.costControl.windowCapInvalidRange"));
      return;
    }
    void onApplyPatch(
      { compaction: { windowCapTokens: parsedTokens } },
      t("mainChat.costControl.windowCapSavedToast"),
    );
  }, [capKDraft, onApplyPatch, t, toast]);

  const handleSaveIdleMinutes = useCallback(() => {
    const parsed = Number.parseInt(idleMinDraft.trim(), 10);
    if (
      !Number.isFinite(parsed) ||
      parsed < MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES ||
      parsed > MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES
    ) {
      toast.error(t("mainChat.costControl.idleMinutesInvalidRange"));
      return;
    }
    void onApplyPatch(
      { compaction: { idlePrecompactMinIdleMin: parsed } },
      t("mainChat.costControl.idleMinutesSavedToast"),
    );
  }, [idleMinDraft, onApplyPatch, t, toast]);

  const handleToggleKeepalive = useCallback(
    (next: boolean) => {
      void onApplyPatch(
        { cacheKeepalive: { enabled: next } },
        t("mainChat.costControl.keepaliveSavedToast"),
      );
    },
    [onApplyPatch, t],
  );

  const handleSaveKeepalivePolicy = useCallback(() => {
    const intervalMinutes = Number.parseInt(keepaliveIntervalDraft.trim(), 10);
    const maxRequests = Number.parseInt(keepaliveMaxDraft.trim(), 10);
    if (
      !Number.isFinite(intervalMinutes) ||
      intervalMinutes < MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN ||
      intervalMinutes > MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN ||
      !Number.isFinite(maxRequests) ||
      maxRequests < MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS ||
      maxRequests > MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS
    ) {
      toast.error(t("mainChat.costControl.keepaliveInvalidRange"));
      return;
    }
    void onApplyPatch(
      { cacheKeepalive: { intervalMinutes, maxRequests } },
      t("mainChat.costControl.keepaliveSavedToast"),
    );
  }, [keepaliveIntervalDraft, keepaliveMaxDraft, onApplyPatch, t, toast]);

  let yieldBadgeText: string | null = null;
  if (cacheKeepaliveStatus?.lastYieldReason === "night_hibernating") {
    yieldBadgeText = t("mainChat.costControl.keepaliveYieldNight");
  } else if (cacheKeepaliveStatus?.lastYieldReason === "user_active") {
    yieldBadgeText = t("mainChat.costControl.keepaliveYieldActive");
  }

  return (
    <View style={settingsStyles.card} testID="main-chat-cost-control-panel">
      {/* Row 1: Auto-compact toggle */}
      <View style={[settingsStyles.row, styles.switchRow]}>
        <View style={styles.rowText}>
          <View style={styles.titleLine}>
            <ThemedCpuIcon size={15} uniProps={mutedIconMapping} />
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.costControl.autoCompactLabel")}
            </Text>
          </View>
          <Text style={settingsStyles.rowHint}>{t("mainChat.costControl.autoCompactHint")}</Text>
        </View>
        <Switch
          value={autoCompactEnabled}
          onValueChange={handleToggleAutoCompact}
          disabled={disabled}
          accessibilityLabel={t("mainChat.costControl.autoCompactLabel")}
          testID="cost-control-auto-compact-switch"
        />
      </View>

      {/* Row 2: Compaction Window Cap */}
      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.blockRow]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.costControl.windowCapTitle")}</Text>
          <Text style={settingsStyles.rowHint}>{t("mainChat.costControl.windowCapHint")}</Text>
        </View>
        <View style={styles.presetsWrap}>
          {COMPACTION_CAP_PRESETS.map((preset) => (
            <CapPresetChip
              key={preset.id}
              preset={preset}
              selected={compactionConfig.windowCapTokens === preset.tokens}
              disabled={disabled}
              onSelect={handleSelectCapPreset}
            />
          ))}
        </View>
        <View style={styles.inlineInputRow}>
          <FormTextInput
            size="sm"
            style={styles.numberInput}
            initialValue={capInK}
            resetKey={`${serverId}:cap:${capInK}`}
            onChangeText={setCapKDraft}
            placeholder={t("mainChat.costControl.windowCapCustomPlaceholder")}
            keyboardType="number-pad"
            maxLength={10}
            returnKeyType="done"
            onSubmitEditing={handleSaveCustomCap}
            testID="cost-control-cap-input"
          />
          <Text style={styles.unitLabel} testID="cost-control-cap-unit">
            {t("mainChat.costControl.windowCapUnit")}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleSaveCustomCap}
            disabled={disabled}
            testID="cost-control-cap-apply"
          >
            {t("mainChat.costControl.windowCapApplyButton")}
          </Button>
        </View>
      </View>

      {/* Row 3: Idle pre-compact continuous idle minutes */}
      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.inlineSplitRow]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.costControl.idleMinutesTitle")}</Text>
          <Text style={settingsStyles.rowHint}>{t("mainChat.costControl.idleMinutesHint")}</Text>
        </View>
        <View style={styles.inlineInputRow}>
          <FormTextInput
            size="sm"
            style={styles.smallNumberInput}
            initialValue={String(compactionConfig.idlePrecompactMinIdleMin)}
            resetKey={`${serverId}:idle:${compactionConfig.idlePrecompactMinIdleMin}`}
            onChangeText={setIdleMinDraft}
            placeholder={t("mainChat.costControl.idleMinutesPlaceholder")}
            keyboardType="number-pad"
            maxLength={3}
            returnKeyType="done"
            onSubmitEditing={handleSaveIdleMinutes}
            testID="cost-control-idle-minutes-input"
          />
          <Text style={styles.unitLabel}>{t("mainChat.costControl.idleMinutesUnit")}</Text>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleSaveIdleMinutes}
            disabled={disabled}
            testID="cost-control-idle-minutes-save"
          >
            {t("mainChat.costControl.idleMinutesSaveButton")}
          </Button>
        </View>
      </View>

      {/* Row 4: Prompt Cache Keepalive */}
      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.blockRow]}>
        <View style={styles.switchRow}>
          <View style={styles.rowText}>
            <View style={styles.titleLine}>
              <ThemedSparklesIcon size={15} uniProps={mutedIconMapping} />
              <Text style={settingsStyles.rowTitle}>
                {t("mainChat.costControl.keepaliveTitle")}
              </Text>
            </View>
            <Text style={settingsStyles.rowHint}>{t("mainChat.costControl.keepaliveHint")}</Text>
          </View>
          <Switch
            value={keepaliveConfig.enabled}
            onValueChange={handleToggleKeepalive}
            disabled={disabled}
            accessibilityLabel={t("mainChat.costControl.keepaliveTitle")}
            testID="cost-control-keepalive-switch"
          />
        </View>

        {keepaliveConfig.enabled ? (
          <View style={styles.keepaliveGrid}>
            <View style={styles.fieldCol}>
              <Text style={styles.fieldLabel}>
                {t("mainChat.costControl.keepaliveIntervalLabel")}
              </Text>
              <FormTextInput
                size="sm"
                style={styles.fieldInput}
                initialValue={String(keepaliveConfig.intervalMinutes)}
                resetKey={`${serverId}:ka-int:${keepaliveConfig.intervalMinutes}`}
                onChangeText={setKeepaliveIntervalDraft}
                keyboardType="number-pad"
                maxLength={2}
                testID="cost-control-keepalive-interval-input"
              />
            </View>
            <View style={styles.fieldCol}>
              <Text style={styles.fieldLabel}>
                {t("mainChat.costControl.keepaliveMaxRequestsLabel")}
              </Text>
              <FormTextInput
                size="sm"
                style={styles.fieldInput}
                initialValue={String(keepaliveConfig.maxRequests)}
                resetKey={`${serverId}:ka-max:${keepaliveConfig.maxRequests}`}
                onChangeText={setKeepaliveMaxDraft}
                keyboardType="number-pad"
                maxLength={3}
                testID="cost-control-keepalive-max-input"
              />
            </View>
            <View style={styles.saveCol}>
              <Button
                variant="secondary"
                size="sm"
                onPress={handleSaveKeepalivePolicy}
                disabled={disabled}
                testID="cost-control-keepalive-save"
              >
                {t("mainChat.costControl.keepaliveSaveButton")}
              </Button>
            </View>
          </View>
        ) : null}

        {cacheKeepaliveStatus ? (
          <View style={styles.statusRow} testID="cost-control-keepalive-status">
            <Text style={styles.statusText}>
              {t("mainChat.costControl.keepaliveStatusLine", {
                targets: cacheKeepaliveStatus.activeTargets,
                pings: cacheKeepaliveStatus.pingsSentTotal,
                interval: cacheKeepaliveStatus.intervalMinutes,
                max: cacheKeepaliveStatus.maxRequests,
              })}
            </Text>
            {yieldBadgeText ? (
              <StatusBadge variant="muted" size="xs" label={yieldBadgeText} />
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    width: "100%",
  },
  blockRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  inlineSplitRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  presetsWrap: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  presetChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  presetChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  presetChipText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  presetChipTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  subtleHighlight: {
    backgroundColor: theme.colors.surface2,
  },
  inlineInputRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  numberInput: {
    width: 112,
  },
  smallNumberInput: {
    width: 84,
  },
  unitLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  keepaliveGrid: {
    flexDirection: "row",
    alignItems: "flex-end",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  fieldCol: {
    minWidth: 140,
    flex: 1,
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  fieldInput: {
    width: "100%",
  },
  saveCol: {
    justifyContent: "flex-end",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingTop: 2,
  },
  statusText: {
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
}));
