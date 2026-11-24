import { createElement, memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { Check, ChevronRight, ExternalLink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { z } from "zod";
import type {
  CardAction,
  CardButtonItemSchema,
  CardFieldItemSchema,
  CardFieldOption,
  CardLinkItemSchema,
  CardRowItemSchema,
  CardSegmentedItemSchema,
  CardTone,
} from "@getpaseo/protocol/interactive-cards";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import {
  EditingTextInput,
  type EditingTextInputHandle,
  type EditingTextInputProps,
} from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import { baseColors, type Theme } from "@/styles/theme";
import { SparklineChart } from "./charts";
import { CardBadgePill } from "./display-items";
import { ThemedCardIcon, toneTintForTheme } from "./icons";

const ThemedChevron = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);
const ThemedExternal = withUnistyles(ExternalLink);
const ThemedCardTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

const SyncedCardTextInput = memo(function SyncedCardTextInput({
  value,
  onChangeText,
  ...rest
}: Omit<EditingTextInputProps, "initialValue" | "onChangeText"> & {
  value: string;
  onChangeText: (text: string) => void;
}) {
  const inputRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    if (inputRef.current && inputRef.current.getText() !== value) {
      inputRef.current.replaceText(value);
    }
  }, [value]);

  return (
    <ThemedCardTextInput
      ref={inputRef}
      initialValue={value}
      onChangeText={onChangeText}
      {...rest}
    />
  );
});

const blueCheckMapping = () => ({ color: baseColors.blue[500] });
const extraMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentMapping = (theme: Theme) => ({ color: theme.colors.accent });
const primaryFgMapping = (theme: Theme) => ({ color: theme.colors.primaryForeground });

const TONE_TINT_MAPPINGS: Record<CardTone | "none", (theme: Theme) => { bg: string }> = {
  none: (theme) => ({ bg: toneTintForTheme(theme, undefined) }),
  default: (theme) => ({ bg: toneTintForTheme(theme, "default") }),
  muted: (theme) => ({ bg: toneTintForTheme(theme, "muted") }),
  accent: (theme) => ({ bg: toneTintForTheme(theme, "accent") }),
  success: (theme) => ({ bg: toneTintForTheme(theme, "success") }),
  warning: (theme) => ({ bg: toneTintForTheme(theme, "warning") }),
  danger: (theme) => ({ bg: toneTintForTheme(theme, "danger") }),
};

const webDateInputNormalMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
  backgroundColor: theme.colors.surface1,
  borderColor: theme.colors.border,
});

const webDateInputErrorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
  backgroundColor: theme.colors.surface1,
  borderColor: theme.colors.statusDanger,
});

const IconBadge = memo(function IconBadge({
  name,
  tone,
  bg,
}: {
  name: string;
  tone?: CardTone;
  bg: string;
}) {
  const wrapStyle = useMemo(() => [styles.rowIconWrap, { backgroundColor: bg }], [bg]);
  return (
    <View style={wrapStyle}>
      <ThemedCardIcon name={name} tone={tone} size={15} />
    </View>
  );
});
const ThemedIconBadge = withUnistyles(IconBadge);

type CardRowItem = z.infer<typeof CardRowItemSchema>;
type CardButtonItem = z.infer<typeof CardButtonItemSchema>;
type CardLinkItem = z.infer<typeof CardLinkItemSchema>;
type CardSegmentedItem = z.infer<typeof CardSegmentedItemSchema>;
type CardFieldItem = z.infer<typeof CardFieldItemSchema>;

export const CardRowView = memo(function CardRowView({
  item,
  disabled,
  chosenActionId,
  busyActionId,
  onAction,
}: {
  item: CardRowItem;
  disabled: boolean;
  chosenActionId?: string;
  busyActionId?: string;
  onAction: (action: CardAction) => void;
}) {
  const isChosen = Boolean(chosenActionId && item.action?.id === chosenActionId);
  const isBusy = Boolean(busyActionId && item.action?.id === busyActionId);
  const canPress = Boolean(item.action) && !disabled && !isBusy;

  const handlePress = useCallback(() => {
    if (item.action) onAction(item.action);
  }, [item.action, onAction]);

  const titleStyle = useMemo(
    () => [styles.rowTitle, isChosen && styles.rowTitleChosen],
    [isChosen],
  );
  const containerStyle = useMemo(
    () => [
      styles.rowContainer,
      isChosen && styles.rowChosen,
      !canPress && !isChosen && styles.rowDisabled,
    ],
    [canPress, isChosen],
  );
  const staticStyle = useMemo(
    () => [styles.rowContainer, isChosen && styles.rowChosen],
    [isChosen],
  );
  const a11yState = useMemo(
    () => ({ selected: isChosen, disabled: !canPress }),
    [canPress, isChosen],
  );

  const content = (
    <View style={styles.rowInner}>
      {item.icon ? (
        <ThemedIconBadge
          name={item.icon}
          tone={item.iconTone}
          uniProps={TONE_TINT_MAPPINGS[item.iconTone ?? "none"]}
        />
      ) : null}
      <View style={styles.rowTextCol}>
        <Text style={titleStyle} numberOfLines={2}>
          {item.title}
        </Text>
        {item.subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {item.subtitle}
          </Text>
        ) : null}
      </View>
      {item.sparkline && item.sparkline.length >= 2 ? (
        <SparklineChart values={item.sparkline} width={52} height={18} />
      ) : null}
      {item.value ? <Text style={styles.rowValue}>{item.value}</Text> : null}
      <CardBadgePill badge={item.badge} />
      {isChosen ? <ThemedCheck size={16} strokeWidth={2.4} uniProps={blueCheckMapping} /> : null}
      {!isChosen && item.action ? <ThemedChevron size={15} uniProps={extraMutedMapping} /> : null}
    </View>
  );

  if (!item.action) {
    return <View style={staticStyle}>{content}</View>;
  }

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={!canPress}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      accessibilityState={a11yState}
      testID={`interactive-card-row-${item.action.id}`}
      style={containerStyle}
      highlightStyle={styles.rowPressed}
    >
      {content}
    </PressHighlight>
  );
});

const CardActionButton = memo(function CardActionButton({
  btn,
  disabled,
  chosenActionId,
  busyActionId,
  onAction,
}: {
  btn: CardButtonItem;
  disabled: boolean;
  chosenActionId?: string;
  busyActionId?: string;
  onAction: (action: CardAction) => void;
}) {
  const isChosen = Boolean(chosenActionId && btn.action.id === chosenActionId);
  const isBusy = Boolean(busyActionId && btn.action.id === busyActionId);

  let buttonVariant: "default" | "secondary" | "destructive" | "ghost" = "secondary";
  if (btn.variant === "primary") buttonVariant = "default";
  else if (btn.variant === "danger") buttonVariant = "destructive";
  else if (btn.variant === "ghost") buttonVariant = "ghost";

  const handlePress = useCallback(() => {
    onAction(btn.action);
  }, [btn.action, onAction]);

  const leftIcon = useMemo(() => {
    if (isChosen) {
      return (
        <ThemedCheck
          size={14}
          uniProps={buttonVariant === "default" ? primaryFgMapping : accentMapping}
        />
      );
    }
    if (btn.icon) {
      return <ThemedCardIcon name={btn.icon} size={14} />;
    }
    return undefined;
  }, [btn.icon, buttonVariant, isChosen]);

  return (
    <Button
      variant={buttonVariant}
      size="md"
      loading={isBusy}
      disabled={disabled || Boolean(busyActionId)}
      testID={`interactive-card-button-${btn.action.id}`}
      onPress={handlePress}
      leftIcon={leftIcon}
    >
      {btn.label}
    </Button>
  );
});

export const CardButtonGroupView = memo(function CardButtonGroupView({
  buttons,
  disabled,
  chosenActionId,
  busyActionId,
  onAction,
}: {
  buttons: CardButtonItem[];
  disabled: boolean;
  chosenActionId?: string;
  busyActionId?: string;
  onAction: (action: CardAction) => void;
}) {
  return (
    <View style={styles.buttonGroup}>
      {buttons.map((btn) => (
        <CardActionButton
          key={btn.key ?? btn.action.id}
          btn={btn}
          disabled={disabled}
          chosenActionId={chosenActionId}
          busyActionId={busyActionId}
          onAction={onAction}
        />
      ))}
    </View>
  );
});

export const CardLinkView = memo(function CardLinkView({
  item,
  onOpenUrl,
}: {
  item: CardLinkItem;
  onOpenUrl: (url: string) => void;
}) {
  const handlePress = useCallback(() => {
    onOpenUrl(item.url);
  }, [item.url, onOpenUrl]);
  return (
    <PressHighlight
      onPress={handlePress}
      accessibilityRole="link"
      style={styles.rowContainer}
      highlightStyle={styles.rowPressed}
    >
      <View style={styles.rowInner}>
        <View style={styles.rowTextCol}>
          <Text style={styles.linkTitle}>{item.label}</Text>
          {item.subtitle ? <Text style={styles.rowSubtitle}>{item.subtitle}</Text> : null}
        </View>
        <ThemedExternal size={14} uniProps={mutedMapping} />
      </View>
    </PressHighlight>
  );
});

export const CardSegmentedView = memo(function CardSegmentedView({
  item,
  value,
  locked,
  onChange,
  onAction,
}: {
  item: CardSegmentedItem;
  value: string;
  locked: boolean;
  onChange: (value: string) => void;
  onAction?: (action: CardAction, nextValue: string) => void;
}) {
  const options = useMemo(
    () =>
      item.options.map((opt) => ({
        value: opt.value,
        label: opt.label ?? opt.value,
        disabled: locked,
      })),
    [item.options, locked],
  );

  const handleValueChange = useCallback(
    (next: string) => {
      onChange(next);
      if (item.action && onAction) {
        onAction(item.action, next);
      }
    },
    [item.action, onAction, onChange],
  );

  return (
    <View style={styles.fieldBlock}>
      {item.label ? <Text style={styles.fieldLabel}>{item.label}</Text> : null}
      <SegmentedControl
        options={options}
        value={value}
        size="sm"
        onValueChange={handleValueChange}
      />
    </View>
  );
});

function parseMultiChoiceValue(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return raw ? [raw] : [];
  }
  return [];
}

function WebDateTimeInput({
  kind,
  value,
  disabled,
  onChange,
  color,
  backgroundColor,
  borderColor,
}: {
  kind: "date" | "time" | "datetime";
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  color: string;
  backgroundColor: string;
  borderColor: string;
}) {
  const inputType = kind === "datetime" ? "datetime-local" : kind;
  return createElement("input", {
    type: inputType,
    value,
    disabled,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    style: {
      height: 36,
      padding: "0 10px",
      borderRadius: 8,
      border: `1px solid ${borderColor}`,
      backgroundColor,
      color,
      fontSize: 13,
      outline: "none",
      maxWidth: 260,
      opacity: disabled ? 0.6 : 1,
    },
  });
}

const ThemedWebDateTimeInput = withUnistyles(WebDateTimeInput);

const ChoiceOptionPill = memo(function ChoiceOptionPill({
  fieldName,
  option,
  active,
  locked,
  role,
  testIdPrefix,
  onSelect,
}: {
  fieldName: string;
  option: CardFieldOption;
  active: boolean;
  locked: boolean;
  role: "radio" | "checkbox";
  testIdPrefix: string;
  onSelect: (val: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(option.value);
  }, [onSelect, option.value]);
  const a11yState = useMemo(() => ({ checked: active, disabled: locked }), [active, locked]);
  const pillStyle = useMemo(
    () => [styles.choicePill, active && styles.choicePillActive, locked && styles.controlLocked],
    [active, locked],
  );
  const textStyle = useMemo(
    () => [styles.choicePillText, active && styles.choicePillTextActive],
    [active],
  );
  return (
    <PressHighlight
      disabled={locked}
      accessibilityRole={role}
      accessibilityState={a11yState}
      testID={`${testIdPrefix}-${fieldName}-${option.value}`}
      onPress={handlePress}
      style={pillStyle}
      highlightStyle={styles.rowPressed}
    >
      {active ? <ThemedCheck size={12} strokeWidth={2.4} uniProps={accentMapping} /> : null}
      <Text style={textStyle}>{option.label ?? option.value}</Text>
    </PressHighlight>
  );
});

const ChoiceFieldBody = memo(function ChoiceFieldBody({
  item,
  value,
  locked,
  error,
  onChange,
}: {
  item: CardFieldItem;
  value: string;
  locked: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const options = item.options;
  const selectOptions: SelectFieldOption<string>[] = useMemo(
    () =>
      (options ?? []).map((opt) => ({
        id: opt.value,
        value: opt.value,
        label: opt.label ?? opt.value,
        description: opt.description,
        testID: `interactive-card-select-opt-${item.name}-${opt.value}`,
      })),
    [item.name, options],
  );
  const selectedDisplay = useMemo(() => {
    const matched = (options ?? []).find((opt) => opt.value === value);
    return matched
      ? { label: matched.label ?? matched.value, description: matched.description }
      : null;
  }, [options, value]);
  const handleSelectChange = useCallback((nextVal: string) => onChange(nextVal), [onChange]);

  if ((options?.length ?? 0) <= 4) {
    return (
      <View style={styles.fieldBlock} testID={`interactive-card-field-${item.name}`}>
        <Text style={styles.fieldLabel}>
          {item.label}
          {item.required ? <Text style={styles.requiredStar}> *</Text> : null}
        </Text>
        <View style={styles.pillRow}>
          {(options ?? []).map((opt) => (
            <ChoiceOptionPill
              key={opt.value}
              fieldName={item.name}
              option={opt}
              active={value === opt.value}
              locked={locked}
              role="radio"
              testIdPrefix="interactive-card-choice"
              onSelect={onChange}
            />
          ))}
        </View>
        {item.detail ? <Text style={styles.fieldDetail}>{item.detail}</Text> : null}
        {error ? <Text style={styles.fieldError}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.fieldBlock} testID={`interactive-card-field-${item.name}`}>
      <SelectField
        label={item.required ? `${item.label} *` : item.label}
        value={value || null}
        selectedDisplay={selectedDisplay}
        options={selectOptions}
        onChange={handleSelectChange}
        placeholder={item.placeholder ?? t("interactiveCards.selectPlaceholder")}
        emptyText={t("interactiveCards.noOptions")}
        disabled={locked}
        hint={item.detail}
        error={error ?? null}
        size="md"
        triggerTestID={`interactive-card-select-${item.name}`}
      />
    </View>
  );
});

const MultiChoiceFieldBody = memo(function MultiChoiceFieldBody({
  item,
  value,
  locked,
  error,
  onChange,
}: {
  item: CardFieldItem;
  value: string;
  locked: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const selectedMulti = useMemo(() => parseMultiChoiceValue(value), [value]);
  const selectedMultiSet = useMemo(() => new Set(selectedMulti), [selectedMulti]);
  const handleMultiToggle = useCallback(
    (optVal: string) => {
      const next = selectedMultiSet.has(optVal)
        ? selectedMulti.filter((v) => v !== optVal)
        : [...selectedMulti, optVal];
      onChange(JSON.stringify(next));
    },
    [onChange, selectedMulti, selectedMultiSet],
  );
  return (
    <View style={styles.fieldBlock} testID={`interactive-card-field-${item.name}`}>
      <Text style={styles.fieldLabel}>
        {item.label}
        {item.required ? <Text style={styles.requiredStar}> *</Text> : null}
      </Text>
      <View style={styles.pillRow}>
        {(item.options ?? []).map((opt) => (
          <ChoiceOptionPill
            key={opt.value}
            fieldName={item.name}
            option={opt}
            active={selectedMultiSet.has(opt.value)}
            locked={locked}
            role="checkbox"
            testIdPrefix="interactive-card-multi"
            onSelect={handleMultiToggle}
          />
        ))}
      </View>
      {item.detail ? <Text style={styles.fieldDetail}>{item.detail}</Text> : null}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
});

const DateTimeFieldBody = memo(function DateTimeFieldBody({
  item,
  value,
  locked,
  error,
  onChange,
}: {
  item: CardFieldItem;
  value: string;
  locked: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const dateNativeInputStyle = useMemo(
    () => [styles.textInput, styles.textInputNarrow, error && styles.textInputError],
    [error],
  );
  let fallbackPlaceholder = "YYYY-MM-DDTHH:MM";
  if (item.kind === "date") fallbackPlaceholder = "YYYY-MM-DD";
  else if (item.kind === "time") fallbackPlaceholder = "HH:MM";
  const kind = item.kind as "date" | "time" | "datetime";
  return (
    <View style={styles.fieldBlock} testID={`interactive-card-field-${item.name}`}>
      <Text style={styles.fieldLabel}>
        {item.label}
        {item.required ? <Text style={styles.requiredStar}> *</Text> : null}
      </Text>
      {isWeb ? (
        <ThemedWebDateTimeInput
          kind={kind}
          value={value}
          disabled={locked}
          onChange={onChange}
          uniProps={error ? webDateInputErrorMapping : webDateInputNormalMapping}
        />
      ) : (
        <SyncedCardTextInput
          value={value}
          editable={!locked}
          onChangeText={onChange}
          placeholder={item.placeholder ?? fallbackPlaceholder}
          style={dateNativeInputStyle}
        />
      )}
      {item.detail ? <Text style={styles.fieldDetail}>{item.detail}</Text> : null}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
});

export const CardFieldView = memo(function CardFieldView({
  item,
  value,
  locked,
  error,
  onChange,
}: {
  item: CardFieldItem;
  value: string;
  locked: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const handleToggleChange = useCallback(
    (next: boolean) => onChange(next ? "true" : "false"),
    [onChange],
  );
  const isMultiline = item.kind === "multiline";
  const isNumber = item.kind === "number";
  const textInputStyle = useMemo(
    () => [
      styles.textInput,
      isMultiline && styles.textInputMultiline,
      isNumber && styles.textInputNarrow,
      locked && styles.controlLocked,
      error && styles.textInputError,
    ],
    [error, isMultiline, isNumber, locked],
  );

  if (item.kind === "toggle") {
    return (
      <View style={styles.toggleRow} testID={`interactive-card-field-${item.name}`}>
        <View style={styles.toggleTextCol}>
          <Text style={styles.toggleLabel}>{item.label}</Text>
          {item.detail ? <Text style={styles.fieldDetail}>{item.detail}</Text> : null}
          {error ? <Text style={styles.fieldError}>{error}</Text> : null}
        </View>
        <Switch
          value={value === "true"}
          disabled={locked}
          accessibilityLabel={item.label}
          testID={`interactive-card-toggle-${item.name}`}
          onValueChange={handleToggleChange}
        />
      </View>
    );
  }

  if (item.kind === "choice") {
    return (
      <ChoiceFieldBody
        item={item}
        value={value}
        locked={locked}
        error={error}
        onChange={onChange}
      />
    );
  }
  if (item.kind === "multichoice") {
    return (
      <MultiChoiceFieldBody
        item={item}
        value={value}
        locked={locked}
        error={error}
        onChange={onChange}
      />
    );
  }
  if (item.kind === "date" || item.kind === "time" || item.kind === "datetime") {
    return (
      <DateTimeFieldBody
        item={item}
        value={value}
        locked={locked}
        error={error}
        onChange={onChange}
      />
    );
  }

  return (
    <View style={styles.fieldBlock} testID={`interactive-card-field-${item.name}`}>
      <Text style={styles.fieldLabel}>
        {item.label}
        {item.required ? <Text style={styles.requiredStar}> *</Text> : null}
      </Text>
      <SyncedCardTextInput
        value={value}
        editable={!locked}
        multiline={isMultiline}
        numberOfLines={isMultiline ? 3 : 1}
        keyboardType={isNumber ? "decimal-pad" : "default"}
        maxLength={item.maxLength}
        placeholder={item.placeholder}
        testID={`interactive-card-input-${item.name}`}
        onChangeText={onChange}
        style={textInputStyle}
      />
      {item.detail ? <Text style={styles.fieldDetail}>{item.detail}</Text> : null}
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  rowContainer: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  rowChosen: {
    backgroundColor: theme.colors.surface2,
  },
  rowDisabled: {
    opacity: 0.72,
  },
  rowPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  rowInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowIconWrap: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowTitleChosen: {
    fontWeight: theme.fontWeight.semibold,
  },
  rowSubtitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  rowValue: {
    fontFamily: theme.fontFamily.mono,
    fontSize: 12.5,
    color: theme.colors.foregroundMuted,
  },
  linkTitle: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accent,
  },
  buttonGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  toggleTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  toggleLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  fieldBlock: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
    gap: theme.spacing[1.5],
  },
  fieldLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12.5,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  requiredStar: {
    color: theme.colors.statusDanger,
  },
  fieldDetail: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  fieldError: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12,
    color: theme.colors.statusDanger,
  },
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  choicePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  choicePillActive: {
    borderColor: theme.colors.accent,
    backgroundColor: `${theme.colors.accent}18`,
  },
  choicePillText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: 12.5,
    color: theme.colors.foregroundMuted,
  },
  choicePillTextActive: {
    color: theme.colors.accent,
    fontWeight: theme.fontWeight.medium,
  },
  textInput: {
    minHeight: 36,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontFamily: theme.fontFamily.ui,
    fontSize: 13.5,
    color: theme.colors.foreground,
  },
  textInputNarrow: {
    maxWidth: 240,
  },
  textInputMultiline: {
    minHeight: 82,
    textAlignVertical: "top",
  },
  textInputError: {
    borderColor: theme.colors.statusDanger,
  },
  controlLocked: {
    opacity: 0.6,
  },
}));
